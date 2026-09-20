import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 采集层 P0/P1 缺陷复现测试（2026-09-18 代码审查发现，全部断言「正确期望行为」，
// 修复落地前这些用例会以 RED 状态存在；控制断言（前置事实）必须通过）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录，绝不误伤生产 server/data/app.db。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-repro-db-'))
const ROOTS_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-repro-roots-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { scan } = await import('../src/scanner.js')
const { startWatcher, stopWatcher } = await import('../src/watcher.js')
const { checkGate, GATE_DEFAULTS } = await import('../src/gate.js')

/** 有效字符 >300、体积 >512B，稳过默认门禁 */
const LONG = '这是一段足够长的正文内容用于通过最小正文字符门禁评估。'.repeat(14)

after(async () => {
  stopWatcher()
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
  await fs.rm(ROOTS_TMP, { recursive: true, force: true })
})

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(ROOTS_TMP, 'root-'))
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(root, rel)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, content)
  }
  return root
}

async function mountRoot(p: string) {
  const db = await getDb()
  await db.exec(`INSERT INTO scan_roots (path) VALUES ('${p.replace(/'/g, "''")}')`)
}

async function unmountRoot(p: string) {
  // 与 DELETE /api/scan/roots/:id 现行为一致：只删根行，不清理文件
  const db = await getDb()
  await db.exec(`DELETE FROM scan_roots WHERE path = '${p.replace(/'/g, "''")}'`)
}

async function fileRow(fp: string): Promise<any> {
  const db = await getDb()
  return (await db.prepare('SELECT id, path, status, md5, gate_sampled FROM files WHERE path = ?')).get(fp)
}

async function gateRow(fp: string): Promise<any> {
  const db = await getDb()
  return (await db.prepare('SELECT status, gate_reason FROM gate_records WHERE path = ?')).get(fp)
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
}

test('P0-④ 内容门禁拦截的文件不得被 full 扫描无条件复活后永久豁免重评', async () => {
  // WHY: scanner.ts 墓碑恢复分支在 full=true 时不看 gate_records 直接翻回 active；
  // 复活后 mtime+size 未变，增量扫描走快路径跳过，门禁在该文件上被永久打穿。
  // 正确期望：full 扫描对带 skipped 记录的墓碑同样要先重跑门禁，仍不合格就维持墓碑。
  const root = await makeRoot({ 'note.md': LONG })
  await mountRoot(root)
  const fp = path.join(root, 'note.md')

  await scan({ roots: [root], full: true, source: 'test' })
  assert.equal((await fileRow(fp))?.status, 'active') // 控制：初次入库合格

  // 内容衰减：~701B 躲过 minSize，有效字符仅 100 → 必被 minChars 拦截
  await fs.writeFile(fp, '短'.repeat(100) + '\n' + '-'.repeat(600))
  await scan({ roots: [root], full: false, source: 'test' })
  assert.equal((await fileRow(fp)).status, 'deleted') // 控制：增量正确墓碑化
  assert.equal((await gateRow(fp))?.status, 'skipped') // 控制：门禁记录在案

  await scan({ roots: [root], full: true, source: 'test' })
  assert.equal(
    (await fileRow(fp)).status, 'deleted',
    '被门禁拦截的文件被 full 扫描复活（此后增量快路径永不再评门禁）'
  )
})

test('P1-① 卸载扫描根后，其下 active 文件不得成为孤儿永久留存知识库', async () => {
  // WHY: 软删作用域刻意限定「本次扫描涉及的根」，而删除扫描根只删 scan_roots 行；
  // 于是被卸载根下的 active 文件从此没有任何通道能清理，仍会出现在看板与 MCP 检索里。
  const r1 = await makeRoot({ 'a.md': LONG })
  const r2 = await makeRoot({ 'b.md': LONG })
  await mountRoot(r1)
  await mountRoot(r2)
  await scan({ roots: [], full: true, source: 'test' })
  const a = path.join(r1, 'a.md')
  assert.equal((await fileRow(a))?.status, 'active') // 控制：双根均在库

  await unmountRoot(r1)
  await scan({ roots: [], full: true, source: 'test' })
  assert.notEqual(
    (await fileRow(a)).status, 'active',
    '已卸载扫描根的文件仍是 active（孤儿文件，无任何清理路径）'
  )
})

test('P1-①b 尾部斜杠扫描根下的文件不得被孤儿清理误伤（生产回归：24116 文件险被墓碑化）', async () => {
  // WHY: scan_roots.path 允许带尾斜杠（POST /api/roots 原样存），而 walk() 用 path.join 产出的
  // 文件路径永远没有尾斜杠 → 「path = root OR path LIKE root || '/%'」对这类根永久失配，
  // 该根下所有 active 文件都会被孤儿判定误认为是无主文件。实测生产库存在此形态根
  // /Users/duke/Documents/，其下 24116 个 active 文件占全库 48435 个的 49.8%。
  // 正确期望：覆盖判断前先归一化根路径，带尾斜杠的根与其子文件一样保持 active。
  const root = await makeRoot({ 'note.md': LONG, 'sub/deep.md': LONG })
  await mountRoot(root + '/') // 故意带尾斜杠挂载
  await scan({ roots: [], full: true, source: 'test' })
  const fp = path.join(root, 'sub', 'deep.md')
  assert.equal((await fileRow(fp))?.status, 'active') // 控制：walk 确实收编了该文件
  assert.equal(
    (await fileRow(path.join(root, 'note.md'))).status, 'active',
    '带尾斜杠的扫描根下的文件被孤儿清理误墓碑化'
  )
})

test('P1-③ 全量扫描已入库的隐藏目录文件，watcher 必须同样能观测到其变更', async () => {
  // WHY: walk() 不跳隐藏目录、watcher 的 ignored 规则跳（watcher.ts 按「根后相对路径含点段」过滤），
  // 于是 .hidden 下文件能被扫描入库却永远等不到实时增改——双通道可见性不一致。
  // 正确期望（一致性契约，不预设哪边收敛）：入库了的文件 watcher 必须能跟改。
  const root = await makeRoot({ 'visible.md': LONG, '.hidden/secret.md': LONG })
  await mountRoot(root)
  await scan({ roots: [root], full: true, source: 'test' })
  const visible = path.join(root, 'visible.md')
  const hidden = path.join(root, '.hidden', 'secret.md')
  assert.equal((await fileRow(hidden))?.status, 'active') // 控制：walk 确实收编了隐藏目录文件

  await startWatcher([root], () => {})
  try {
    const beforeV = (await fileRow(visible)).md5
    const beforeH = (await fileRow(hidden)).md5
    await fs.writeFile(visible, LONG + '\n追加一段可见变更。')
    await fs.writeFile(hidden, LONG + '\n追加一段隐藏变更。')
    // 控制：watcher 对可见文件在超时窗口内落库（证明 watcher 活着，不是环境问题）
    await waitFor(async () => (await fileRow(visible)).md5 !== beforeV, 15000, 'watcher 更新可见文件')
    await waitFor(async () => (await fileRow(hidden)).md5 !== beforeH, 8000, 'watcher 更新已入库的隐藏目录文件')
  } finally {
    stopWatcher()
  }
})

test('P1-⑤ 全文件代码占比超限的大文件不应仅凭头部 64KB 抽样通过门禁', async () => {
  // WHY: >512KB 走抽样门禁且刻意跳过 codeRatio（gate.ts 注释「抽样占比不可靠」），
  // 后果是「头部像散文、体内全是代码」的文件整体读必拦、抽样读必放——大文件成为
  // 质量门禁的结构性绕过口。期望：整体 codeRatio 超限时至少不得直接入库为 active。
  const prose = (LONG + '\n').repeat(700)
  const code = 'const x = 1\n'.repeat(60000)
  const raw = prose + '```js\n' + code + '\n```\n'
  const root = await makeRoot({ 'bigfile.md': raw })
  const fp = path.join(root, 'bigfile.md')
  const stat = await fs.stat(fp)
  assert.ok(stat.size > 512 * 1024) // 控制：确实落在抽样分支

  const fullVerdict = checkGate(fp, stat.size, raw, GATE_DEFAULTS)
  assert.equal(fullVerdict.pass, false) // 控制：整读判罚就是拦截
  assert.match(fullVerdict.reason!, /代码占比过高/)

  await mountRoot(root)
  await scan({ roots: [root], full: true, source: 'test' })
  const row = await fileRow(fp)
  assert.notEqual(row?.status, 'active', `大文件仅凭头部抽样绕过门禁入库（gate_sampled=${row?.gate_sampled}）`)
})

test('特征化（⑨ 拼接转义安全网）：路径含单引号与 SQL 片段应完整入库且不破坏表结构', async () => {
  // WHY: scanner/gate 全用字符串拼 SQL（仅靠逐处 '' 转义），此用例锁定「当前转义约定成立」；
  // 一旦任何一处漏转义，这里立刻红。它不验证期望行为缺口，属安全网特征化测试。
  const evil = "evil'; DROP TABLE files; --.md"
  const root = await makeRoot({ [evil]: LONG, 'ok.md': LONG })
  await mountRoot(root)
  await scan({ roots: [root], full: true, source: 'test' })
  const fp = path.join(root, evil)
  assert.equal((await fileRow(fp))?.status, 'active')
  assert.equal((await fileRow(path.join(root, 'ok.md')))?.status, 'active') // files 表未遭殃
})
