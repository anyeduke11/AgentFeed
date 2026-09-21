import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { rmSync } from 'node:fs'
import os from 'os'
import path from 'path'
import type { ReadHistoryRow } from '../src/readAffinityCore.js'

// I2 用户理解信号体系契约测试：readAffinity 纯函数 + related/feedback 端点 + chat recap。
// WHY 各断言存在：
// ① 聚类 30/31 分钟边界——切分阈值是「学习会话」的定义，差 1 分钟就错分会话，top 域统计随之失真；
// ② 主域 ≥2 次口径——单次偶发打开不是主题投入，≥2 次才算主域，钉住防退化成「任意出现即主域」；
// ③ related 只出同域且排除自身——跨域混入会让「相关阅读」变成随机推荐，失去域内导航意义；
// ④ feedback 拒绝 0/6 星——rating 列是 1~5 CHECK 口径，端点必须先于 DB 报 400（不能靠约束兜底）；
// ⑤ recap 失败不落半成品——复盘消息前缀 [复盘] 是回放端的渲染标记，半截内容会污染会话回放。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 chat.test.ts）；直调路由 handler，不起 HTTP 服务。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-signals-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb } = await import('../src/db.js')
const { readingRouter } = await import('../src/routes/reading.js')
const { chatRouter, setRecapLlmFn } = await import('../src/routes/chat.js')
const { clusterReads, labelClusters, READ_GAP_MS, UNCLASSIFIED } = await import('../src/readAffinityCore.js')

// 清理挂 process exit 而非 after()：node:test 根级 after() 不等顶层 await（seeding）完成即触发，
// rm 与 seeding 的 getDb() mkdir 曾互相拆台随机 ENOENT/ENOTEMPTY（I3 批次定位修复）；
// exit 时全部测试已结束、进程单线程同步清理，零竞态；句柄随进程退出自然释放。
process.on('exit', () => {
  try { rmSync(DATA_TMP, { recursive: true, force: true }) } catch { /* best-effort，OS /tmp 兜底 */ }
})

// ---- 直调路由 handler（同 chat.test.ts 模式） ----
function handlerOf(router: any, method: string, url: string) {
  const layer = router.stack.find((l: any) =>
    l.route && l.route.methods?.[method.toLowerCase()] &&
    (l.route.path === url || (l.route.path.includes(':') && new RegExp('^' + l.route.path.replace(/:[^/]+/g, '[^/]+') + '$').test(url)))
  )
  assert.ok(layer, `路由 ${method} ${url} 必须存在`)
  return (layer.route as any).stack[0].handle
}

function reqOf(body: any, params: any = {}) {
  return { method: 'get', body, params, query: {} }
}

function mockRes(sink: any) {
  const res: any = {
    status(code: number) { sink.status = code; return res },
    json(payload: any) { sink.json = payload; return res },
  }
  return res
}

// ---- 种子工具 ----
let fileSeq = 0
async function seedDomain(name: string): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare('INSERT INTO domains (name) VALUES (?)')).run([name])
  return Number(r.lastID)
}

async function seedFile(domainId: number | null, title: string): Promise<number> {
  const db = await getDb()
  fileSeq += 1
  const r = await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, summary, domain_id, rule_score, file_mtime, status)
     VALUES (?, ?, 'md', ?, '', ?, 5, '2026-09-10 10:00:00', 'active')`
  )).run([`/sig/f${fileSeq}.md`, `f${fileSeq}`, title, domainId])
  return Number(r.lastID)
}

async function seedRead(fileId: number, opens: number) {
  const db = await getDb()
  for (let i = 0; i < opens; i++) {
    await (await db.prepare('INSERT INTO read_history (file_id, path, source) VALUES (?, ?, ?)')).run([fileId, `/sig/${fileId}.md`, 'reader'])
  }
}

// ---- 纯函数：readAffinityCore ----

function rh(id: number, fileId: number | null, openedAt: string | null): ReadHistoryRow {
  return { id, file_id: fileId, path: `/sig/${id}.md`, source: 'reader', opened_at: openedAt }
}

test('clusterReads：间隔 ≤30 分钟同簇（含恰好 30 分钟边界）、31 分钟切新簇、非法时间戳跳过计数', () => {
  assert.equal(READ_GAP_MS, 30 * 60 * 1000, '阈值口径 = 30 分钟')
  const rows = [
    rh(1, 1, '2026-09-20 10:00:00'),
    rh(2, 1, '2026-09-20 10:30:00'), // 恰好 30 分钟 → 仍同簇（> 阈值才切）
    rh(3, 2, '2026-09-20 11:01:00'), // 距上条 31 分钟 → 新簇
    rh(4, 2, '2026-09-20 11:20:00'), // 19 分钟 → 归第二簇
    rh(5, 3, null),                  // 非法时间戳 → 剔除计数
  ]
  const { clusters, skipped } = clusterReads(rows)
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters[0].map(e => e.id), [1, 2])
  assert.deepEqual(clusters[1].map(e => e.id), [3, 4])
  assert.equal(skipped, 1)
})

test('labelClusters：出现 ≥2 次的域为主域；跨 ≥2 域标跨域并列首现域序列；无域/无 file_id 归未分类', () => {
  const map = new Map<number, string | null>([
    [1, '域甲'], [2, '域甲'], [3, '域乙'], [4, '域乙'], [5, null],
  ])
  // 簇一（同簇构造）：域甲×2 + 域乙×1 + 无域文件×1 → 主域仅域甲；跨 3 域（域甲/域乙/未分类）
  const { clusters } = clusterReads([
    rh(1, 1, '2026-09-20 10:00:00'),
    rh(2, 3, '2026-09-20 10:05:00'),
    rh(3, 2, '2026-09-20 10:10:00'),
    rh(4, 5, '2026-09-20 10:15:00'),
  ])
  const [c1] = labelClusters(clusters, map)
  assert.deepEqual(c1.primaryDomains, ['域甲'], '域甲出现 2 次为主域，域乙/未分类仅 1 次不入选')
  assert.deepEqual(c1.domainSeq, ['域甲', '域乙', UNCLASSIFIED], '域序列按首现顺序去重')
  assert.equal(c1.crossDomain, true)
  assert.equal(c1.opens, 4)
  assert.equal(c1.fileCount, 4, 'file_id 去重计数')

  // 簇二（单域）：域甲×3（含同文件重复打开）→ 非跨域、主域域甲
  const { clusters: c2raw } = clusterReads([
    rh(11, 1, '2026-09-20 14:00:00'),
    rh(12, 1, '2026-09-20 14:05:00'),
    rh(13, 2, '2026-09-20 14:10:00'),
  ])
  const [c2] = labelClusters(c2raw, map)
  assert.deepEqual(c2.primaryDomains, ['域甲'])
  assert.equal(c2.crossDomain, false)
  assert.equal(c2.fileCount, 2, '同文件重复打开去重')

  // 双主域并列（两域各 ≥2 次）按次数降序
  const { clusters: c3raw } = clusterReads([
    rh(21, 3, '2026-09-20 16:00:00'),
    rh(22, 3, '2026-09-20 16:05:00'),
    rh(23, 1, '2026-09-20 16:10:00'),
    rh(24, 1, '2026-09-20 16:15:00'),
    rh(25, 1, '2026-09-20 16:20:00'),
  ])
  const [c3] = labelClusters(c3raw, map)
  assert.deepEqual(c3.primaryDomains, ['域甲', '域乙'], '两域均 ≥2 次：域甲 3 次在前')
  // file_id 为 null 的打开记录归未分类，不炸聚类
  const { clusters: c4raw } = clusterReads([rh(31, null, '2026-09-20 18:00:00')])
  const [c4] = labelClusters(c4raw, map)
  assert.deepEqual(c4.domainSeq, [UNCLASSIFIED])
})

// ---- GET /api/reading/related/:fileId ----

const dA = await seedDomain('信号-域甲')
const dB = await seedDomain('信号-域乙')
const fA1 = await seedFile(dA, '域甲文件一')
const fA2 = await seedFile(dA, '域甲文件二')
const fA3 = await seedFile(dA, '域甲文件三')
const fB4 = await seedFile(dB, '域乙文件四')
const fB5 = await seedFile(dB, '域乙文件五')
await seedRead(fA1, 3)
await seedRead(fA2, 2)
await seedRead(fA3, 1)
await seedRead(fB4, 5) // 他域高热文件：绝不允许混入域甲的相关阅读

test('related：同域按打开次数 top5、排除自身、他域文件不出现', async () => {
  const sink: any = {}
  await handlerOf(readingRouter, 'get', `/related/${fA1}`)(reqOf(undefined, { fileId: String(fA1) }), mockRes(sink))
  assert.equal(sink.json.success, true)
  assert.deepEqual(
    sink.json.items.map((it: any) => [it.id, it.opens]),
    [[fA2, 2], [fA3, 1]],
    '按打开次数降序，且不含自身 fA1'
  )
  assert.ok(!sink.json.items.some((it: any) => it.id === fB4 || it.id === fB5), '他域文件不得出现（哪怕打开 5 次）')
  assert.ok(sink.json.items.every((it: any) => typeof it.title === 'string' && typeof it.path === 'string'), '条目含 title/path 供前端展示')
})

test('related：无域文件与不存在的文件返回空数组（不报错）', async () => {
  const fNoDomain = await seedFile(null, '无域文件')
  const sink: any = {}
  await handlerOf(readingRouter, 'get', `/related/${fNoDomain}`)(reqOf(undefined, { fileId: String(fNoDomain) }), mockRes(sink))
  assert.equal(sink.json.success, true)
  assert.deepEqual(sink.json.items, [], '无域文件无相关阅读（域内导航无从谈起）')

  const sink2: any = {}
  await handlerOf(readingRouter, 'get', '/related/999999')(reqOf(undefined, { fileId: '999999' }), mockRes(sink2))
  assert.equal(sink2.json.success, true)
  assert.deepEqual(sink2.json.items, [], '不存在的文件返回空数组')
})

// ---- POST /api/reading/feedback ----

test('feedback：合法 rating 落 read_history（file_id/source/rating/feedback 四列可查）；重复提交允许', async () => {
  const sink: any = {}
  await handlerOf(readingRouter, 'post', '/feedback')(
    reqOf({ fileId: fA1, path: '/sig/fb1.md', rating: 4, feedback: '讲得清楚' }), mockRes(sink)
  )
  assert.equal(sink.json.success, true)

  const db = await getDb()
  const rows = await (await db.prepare(
    "SELECT * FROM read_history WHERE path = '/sig/fb1.md'"
  )).all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].file_id, fA1)
  assert.equal(rows[0].source, 'reader', '埋点 source=reader（与阅读器打开同渠道）')
  assert.equal(rows[0].rating, 4)
  assert.equal(rows[0].feedback, '讲得清楚')

  // 历史记录语义：同一文件允许再次提交，两条独立信号
  await handlerOf(readingRouter, 'post', '/feedback')(
    reqOf({ fileId: fA1, path: '/sig/fb1.md', rating: 2 }), mockRes({})
  )
  const rows2 = await (await db.prepare("SELECT rating, feedback FROM read_history WHERE path = '/sig/fb1.md' ORDER BY id")).all() as any[]
  assert.equal(rows2.length, 2)
  assert.equal(rows2[1].rating, 2)
  assert.equal(rows2[1].feedback, null, '缺省 feedback 落 NULL 而非空串')
})

test('feedback：rating=0/6 与缺 path 均 400 拒绝，且不写任何行', async () => {
  const db = await getDb()
  const before = (await (await db.prepare('SELECT COUNT(*) AS n FROM read_history')).get() as any).n
  for (const bad of [
    { fileId: fA1, path: '/sig/bad.md', rating: 0 },
    { fileId: fA1, path: '/sig/bad.md', rating: 6 },
    { fileId: fA1, path: '', rating: 4 },
  ]) {
    const sink: any = {}
    await handlerOf(readingRouter, 'post', '/feedback')(reqOf(bad), mockRes(sink))
    assert.equal(sink.status, 400, `非法入参 ${JSON.stringify(bad)} 必须 400`)
    assert.equal(sink.json.success, false)
  }
  const after = (await (await db.prepare('SELECT COUNT(*) AS n FROM read_history')).get() as any).n
  assert.equal(after, before, '被拒请求不得写入任何行（先于 DB CHECK 拦截）')
})

// ---- POST /api/chat/recap ----

const RECAP_SUMMARY = '## 要点\n- 用户在排查检索问题\n\n## 建议待办\n- 重放基线对比命中率'

test('recap：fake llmFn → 复盘消息带 [复盘] 前缀落库、llm_call_logs 恰一行（file_id null）、prompt 含会话记录', async () => {
  const db = await getDb()

  // 空会话：success:false 不烧 LLM
  const empty: any = {}
  await handlerOf(chatRouter, 'post', '/recap')(reqOf({ sessionId: 'sig-sess-404' }), mockRes(empty))
  assert.equal(empty.json.success, false, '会话不存在或无消息时不调 LLM')

  // 缺 sessionId：400
  const noId: any = {}
  await handlerOf(chatRouter, 'post', '/recap')(reqOf({}), mockRes(noId))
  assert.equal(noId.status, 400)

  // 种会话（chat_messages 表由 recap handler 的 ensureChatTable 兜底建，上面第一次调用已建好）
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run(['sig-sess-1', 'user', '检索基线怎么重放？'])
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run(['sig-sess-1', 'assistant', '用 searchBaseline 脚本对 query 逐条重放。'])

  let capturedPrompt = ''
  setRecapLlmFn(async (_p: string, _m: string, prompt: string) => {
    capturedPrompt = prompt
    return { text: JSON.stringify({ answer: RECAP_SUMMARY }), usage: { input: 30, output: 50 } }
  })

  const logsBefore = (await (await db.prepare('SELECT COUNT(*) AS n FROM llm_call_logs')).get() as any).n
  const sink: any = {}
  await handlerOf(chatRouter, 'post', '/recap')(reqOf({ sessionId: 'sig-sess-1' }), mockRes(sink))
  assert.equal(sink.json.success, true)
  assert.equal(sink.json.summary, RECAP_SUMMARY)

  // prompt 必须喂进真实会话记录（复盘不是凭空生成）
  assert.ok(capturedPrompt.includes('检索基线怎么重放') && capturedPrompt.includes('重放'), '会话记录进入复盘 prompt')

  // 复盘消息落库：assistant + [复盘] 前缀 + 摘要全文
  const msgs = await (await db.prepare(
    "SELECT role, content FROM chat_messages WHERE session_id = 'sig-sess-1' ORDER BY id"
  )).all() as any[]
  assert.equal(msgs.length, 3, '原 2 条 + 复盘 1 条')
  assert.equal(msgs[2].role, 'assistant')
  assert.ok(msgs[2].content.startsWith('[复盘] '), '复盘标记 = content 前缀')
  assert.equal(msgs[2].content, `[复盘] ${RECAP_SUMMARY}`)

  // LLM 调用日志：恰好一行 success，file_id null（进 G1 成本视图口径）
  const logsAfter = (await (await db.prepare('SELECT COUNT(*) AS n FROM llm_call_logs')).get() as any).n
  assert.equal(logsAfter - logsBefore, 1)
  const log = await (await db.prepare('SELECT * FROM llm_call_logs ORDER BY id DESC LIMIT 1')).get() as any
  assert.equal(log.status, 'success')
  assert.equal(log.file_id, null)
})

test('recap：fake llmFn 抛错 → success:false、chat_messages 无新增（不落半成品）', async () => {
  const db = await getDb()
  const before = (await (await db.prepare(
    "SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = 'sig-sess-1'"
  )).get() as any).n
  setRecapLlmFn(async () => { throw new Error('recap_llm_down') })
  try {
    const sink: any = {}
    await handlerOf(chatRouter, 'post', '/recap')(reqOf({ sessionId: 'sig-sess-1' }), mockRes(sink))
    assert.equal(sink.json.success, false, 'LLM 失败不阻塞前端，但必须如实 success:false')
    assert.ok(!sink.status || sink.status === 200, 'LLM 失败走业务语义而非 5xx（前端按 message 提示）')

    const after = (await (await db.prepare(
      "SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = 'sig-sess-1'"
    )).get() as any).n
    assert.equal(after, before, '失败路径不得落任何消息（半截复盘污染回放）')

    const log = await (await db.prepare('SELECT * FROM llm_call_logs ORDER BY id DESC LIMIT 1')).get() as any
    assert.equal(log.status, 'failed', 'failed 调用日志照落（成本可见，fail loud）')
  } finally {
    setRecapLlmFn(async () => ({ text: 'ok' }))
  }
})
