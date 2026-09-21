import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Phase 2 · 分块向量手动补嵌路由（wiki.ts 的 chunks/backfill 三端点）契约测试。
// WHY：boot 启动期全量补嵌已按裁决移除（本地 GPU compute-bound，54 万块串行 ~53h 不适合常驻满载），
// 补嵌改由前端手动分批触发——路由必须钉住：未配置 fail-fast 不置 running（前端只看 running 展示状态，
// 误置位会永久假死）、空批次幂等可反复点击、运行中互斥、配置类降级整批中止且不计词条失败
// （修好配置重跑同批即可，failed 只留给真实单词条错误）、stop 软停止置位。
// 零真实 HTTP：降级场景种一个无 baseUrl 的 provider（resolveEmbedContext 必然在内存里短路），
// 嵌入函数不走注入点（验证的就是路由内无 embedFn 的真实调用链）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 wikiChunks.test.ts 模式）。用例顺序有依赖（同一临时库）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-chunk-backfill-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { wikiRouter, chunkBackfillState } = await import('../src/routes/wiki.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

/** 取路由 handler（同 triageDistill.test.ts 的 stack 提取模式） */
function handlerOf(url: string) {
  const layer = (wikiRouter as any).stack.find((l: any) => l.route?.path === url)
  assert.ok(layer, `路由 ${url} 必须存在`)
  return (layer.route as any).stack[0].handle
}

async function call(method: string, url: string, body?: any) {
  let json: any
  await handlerOf(url)({ method, body, query: {} }, {
    status() { return this },
    json(payload: any) { json = payload },
  })
  return json
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

let seq = 0
/** 种一个 wiki 词条：只落 entry.md + wiki_entries_meta（不建索引，pending 口径 = 无 entry_chunks 行） */
async function seedWikiEntry(title: string): Promise<number> {
  const db = await getDb()
  seq += 1
  const entryPath = path.join(DATA_TMP, 'wiki', 'entries', `bf-${seq}.md`)
  await fs.mkdir(path.dirname(entryPath), { recursive: true })
  await fs.writeFile(entryPath, `# ${title}\n\n正文内容\n`, 'utf8')
  const r = await (await db.prepare(
    'INSERT INTO wiki_entries_meta (file_id, entry_path, title) VALUES (NULL, ?, ?)'
  )).run([entryPath, title])
  return Number(r.lastID)
}

async function setConfig(key: string, value: string) {
  const db = await getDb()
  await (await db.prepare(
    `INSERT INTO config (key, value, type) VALUES (?, ?, 'json') ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )).run([key, value])
}

test('status 默认空库：pending/chunks 计数与运行态全部归零（WHY：前端以该端点为唯一进度来源，空态必须可辨）', async () => {
  const json = await call('GET', '/chunks/backfill/status')
  assert.equal(json.success, true)
  assert.equal(json.running, false)
  assert.equal(json.pending, 0)
  assert.equal(json.chunks, 0)
  assert.equal(json.lastRun, null)
})

test('start 默认未配置拒绝且不置 running（WHY：配置缺失是最常见入口错误，误置 running 会让前端按钮永久卡在停止态）', async () => {
  const json = await call('POST', '/chunks/backfill/start')
  assert.equal(json.success, false)
  assert.equal(json.message, '请先开启蒸馏向量化并选择向量模型')
  assert.equal(chunkBackfillState.running, false, '拒绝路径不得置位 running')
})

test('start 已配置但无待嵌词条：幂等返回 started:false（WHY：存量清零后前端按钮要能反复点而不报错）', async () => {
  // 无 baseUrl 的 provider：若批次非空，后台循环必然在内存里短路出 no_embedding_provider（零 HTTP、确定性行为）
  await setConfig('ai.embedding', JSON.stringify({ enabled: true, provider: 'broken', model: 'test-model' }))
  await setConfig('ai.providers', JSON.stringify([{ name: 'broken' }]))
  const json = await call('POST', '/chunks/backfill/start')
  assert.equal(json.success, true)
  assert.equal(json.started, false)
  assert.equal(json.message, '无待嵌词条')
  assert.equal(chunkBackfillState.running, false)
})

test('status pending 口径 = 无块的词条数（WHY：进度展示的分子分母必须与补嵌快照同源，否则进度对不上）', async () => {
  await seedWikiEntry('补嵌词条甲')
  await seedWikiEntry('补嵌词条乙')
  const json = await call('GET', '/chunks/backfill/status')
  assert.equal(json.success, true)
  assert.equal(json.pending, 2)
  assert.equal(json.chunks, 0)
})

test('start 运行中互斥拒绝（WHY：并发批次会重复嵌入同一词条，互斥是幂等消费的前提）', async () => {
  chunkBackfillState.running = true
  try {
    const json = await call('POST', '/chunks/backfill/start')
    assert.equal(json.success, false)
    assert.equal(json.message, '补嵌批次进行中，请等待完成或先停止')
  } finally {
    chunkBackfillState.running = false
  }
})

test('start 批次快照 + 配置降级整批中止不计词条失败（WHY：降级是配置问题不是数据问题，failed 只留给真实单词条错误，修配置重跑同批即可）', async () => {
  const json = await call('POST', '/chunks/backfill/start', { limit: 50 })
  assert.equal(json.success, true)
  assert.equal(json.started, true)
  assert.equal(json.batch, 2, '批次大小 = 启动时快照的 pending 词条数')
  assert.equal(chunkBackfillState.running, true, '启动后 running 立即置位')

  // 降级路径为内存短路，循环应即刻收尾；轮询等待后台批次落盘
  const deadline = Date.now() + 5000
  while (chunkBackfillState.running && Date.now() < deadline) await sleep(20)
  assert.equal(chunkBackfillState.running, false, '降级整批中止后批次必须收尾')

  const last = chunkBackfillState.lastRun
  assert.ok(last, '收尾后必须落 lastRun')
  assert.equal(last.batch, 2)
  assert.equal(last.indexed, 0)
  assert.equal(last.failed, 0, '配置降级不计词条失败')
  assert.equal(last.stopped, true)
  assert.equal(last.reason, 'no_embedding_provider')

  const db = await getDb()
  const chunkCnt = (await (await db.prepare('SELECT COUNT(*) AS n FROM entry_chunks')).get() as any).n
  assert.equal(chunkCnt, 0, '零嵌入调用：降级批次不得写任何块')
  const after = await call('GET', '/chunks/backfill/status')
  assert.equal(after.pending, 2, '中止批次不消费 pending，同批可修配置后重跑')
})

test('stop 软停止置位（WHY：GPU 常驻满载需可随时让位，软停止保证当前词条完成后干净收尾）', async () => {
  assert.equal(chunkBackfillState.stopRequested, false)
  const json = await call('POST', '/chunks/backfill/stop')
  assert.equal(json.success, true)
  assert.equal(json.running, false)
  assert.equal(chunkBackfillState.stopRequested, true, 'stop 必须置位软停止标记')
  chunkBackfillState.stopRequested = false
})

test('死链词条在快照层被跳过（WHY：死链不消费 pending、常驻候选窗口头部，不过滤则每批名额被空耗，批次永远不会推进）', async () => {
  // 制造死链：删掉乙词条的 entry.md（甲保持存活）
  const db = await getDb()
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE title = ?')).get(['补嵌词条乙']) as any
  await fs.rm(String(row.entry_path))

  const json = await call('POST', '/chunks/backfill/start', { limit: 50 })
  assert.equal(json.success, true)
  assert.equal(json.started, true)
  assert.equal(json.batch, 1, '快照只收存活词条，死链不计入批次')
  assert.equal(json.deadSkipped, 1, '被过滤的死链数必须显式上报')

  const deadline = Date.now() + 5000
  while (chunkBackfillState.running && Date.now() < deadline) await sleep(20)
  assert.equal(chunkBackfillState.lastRun?.batch, 1, '批次只含存活词条')
})

test('候选窗口全死链：拒绝启动并显式说明（WHY：静默返回空会让前端误判「存量清零」，死链真相必须浮出）', async () => {
  // 删掉最后一个存活词条的 entry.md，此时候选窗口内全部为死链
  const db = await getDb()
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE title = ?')).get(['补嵌词条甲']) as any
  await fs.rm(String(row.entry_path))

  const json = await call('POST', '/chunks/backfill/start', { limit: 50 })
  assert.equal(json.success, true)
  assert.equal(json.started, false)
  assert.ok(String(json.message).includes('死链'), '消息必须点明死链原因')
  assert.equal(chunkBackfillState.running, false)
})
