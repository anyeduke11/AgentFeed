import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// P0 修复契约：文件内容更新必须触发重蒸馏（llm_state 重置 pending）。
// WHY：upsert 的 DO UPDATE 换 md5 却保留旧 llm_state，feeder 只喂 pending——
// 内容更新的 done 文件永不重蒸馏，词条/FTS/向量静默陈旧（库说"最新"，检索到旧知识）。
// 钉死的四条边界：
//   1) 内容真变（md5 变）→ done/failed 重置 pending（重蒸馏被调度）
//   2) mtime-only 变更（touch，内容同）→ 保持 done（md5 快路径本就不该走到这里，但万一走到也不误重置）
//   3) running 不重置 → 进行中的蒸馏不被扫描打断（结果自然覆盖）
//   4) 墓碑复活（md5 相同）→ 保持 done → 知识资产随行迁移、免重蒸馏（既有语义零回归）
// fail 点设计：若有人把 CASE 条件删掉或改宽，2/4 会烧 tokens（重复计算），1 会静默陈旧（知识过期）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-p0-db-'))
const ROOTS_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-p0-roots-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { scan } = await import('../src/scanner.js')
const { stopWatcher } = await import('../src/watcher.js')

/** 有效字符 >300、体积 >512B，稳过默认门禁（同 scanRepro.test.ts） */
const LONG = '这是一段足够长的正文内容用于通过最小正文字符门禁评估。'.repeat(14)

after(async () => {
  stopWatcher()
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
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

async function fileRow(fp: string): Promise<any> {
  const db = await getDb()
  return (await db.prepare('SELECT id, md5, status, llm_state FROM files WHERE path = ?')).get(fp)
}

/** 直接置 llm_state（模拟蒸馏已完成/进行中/失败——本测试只钉扫描层的重置语义，不真跑 LLM） */
async function setState(fp: string, state: string) {
  const db = await getDb()
  await db.exec(`UPDATE files SET llm_state = '${state}' WHERE path = '${fp.replace(/'/g, "''")}'`)
}

/** 撬动 mtime 绕开 mtime+size 缓存快路径，强制走完整 ingest 流程 */
async function touch(fp: string, offsetMs = 3000) {
  const t = new Date(Date.now() + offsetMs)
  await fs.utimes(fp, t, t)
}

test('内容真变更：done 与 failed 都重置 pending（重蒸馏被调度）；版本链同步记录', async () => {
  const root = await makeRoot({ 'a.md': LONG, 'b.md': LONG })
  await mountRoot(root)
  const fa = path.join(root, 'a.md')
  const fb = path.join(root, 'b.md')
  await scan({ roots: [root], full: true, source: 'test' })

  const ida = Number((await fileRow(fa)).id)
  await setState(fa, 'done')
  await setState(fb, 'failed')

  // 内容变更 + mtime 撬动 → 扫描
  await fs.writeFile(fa, LONG + '\n第二版：内容变了。')
  await fs.writeFile(fb, LONG + '\n第二版：内容变了。')
  await touch(fa); await touch(fb)
  await scan({ roots: [root], full: true, source: 'test' })

  const ra = await fileRow(fa)
  const rb = await fileRow(fb)
  assert.equal(ra.llm_state, 'pending', 'done + 内容变 → pending（重蒸馏被 feeder 接手）')
  assert.equal(rb.llm_state, 'pending', 'failed + 内容变 → pending（内容更新也是一次自然的重试机会）')

  // 批次①版本链配套：同一次变更也落了 supersedes 记录（上游变更可追溯）
  const db = await getDb()
  const v = await (await db.prepare('SELECT COUNT(*) as n FROM file_versions WHERE file_id = ?')).get(ida) as any
  assert.ok(Number(v.n) >= 1, '内容变更同时记录版本链')
})

test('mtime-only 变更（内容同）：保持 done，不烧 tokens；running 不被扫描打断', async () => {
  const root = await makeRoot({ 'c.md': LONG, 'd.md': LONG })
  await mountRoot(root)
  const fc = path.join(root, 'c.md')
  const fd = path.join(root, 'd.md')
  await scan({ roots: [root], full: true, source: 'test' })
  await setState(fc, 'done')
  await setState(fd, 'running')

  // 只撬 mtime 不改内容：full 扫描走到 upsert（md5 相同）
  await touch(fc, 5000)
  await touch(fd, 6000)
  await scan({ roots: [root], full: true, source: 'test' })

  assert.equal((await fileRow(fc)).llm_state, 'done', 'md5 未变 → 不重置（免重蒸馏）')
  assert.equal((await fileRow(fd)).llm_state, 'running', 'running 态不被扫描重置（蒸馏结果自然覆盖）')
})

test('墓碑复活（md5 相同）：保持 done → 知识资产随行迁移，零回归', async () => {
  const root = await makeRoot({ 'e.md': LONG })
  await mountRoot(root)
  const fe = path.join(root, 'e.md')
  await scan({ roots: [root], full: true, source: 'test' })
  await setState(fe, 'done')

  // 软删为墓碑 → 原样复活（内容一字不改，仅 mtime 变）
  const db = await getDb()
  await db.exec(`UPDATE files SET status = 'deleted' WHERE path = '${fe.replace(/'/g, "''")}'`)
  await touch(fe, 8000)
  await scan({ roots: [root], full: true, source: 'test' })

  const r = await fileRow(fe)
  assert.equal(r.status, 'active', '控制：墓碑已复活')
  assert.equal(r.llm_state, 'done', 'md5 未变 → 复活不触发重蒸馏（既有免重蒸馏语义保持）')
})
