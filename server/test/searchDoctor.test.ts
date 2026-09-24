import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 批次④：检索健康自检端点 GET /api/search/doctor 契约。
// WHY：检索链路横跨 FTS 覆盖 / 向量配置 / 别名合法性 / 混合开关四个可坏点，
// 此前坏了只能翻日志猜——doctor 一次体检全量呈现，坏配置（如别名 JSON 损坏）
// 必须被显眼标红而不是静默降级到用户无感。
// fail 点设计：别名坏 JSON 必须 ok:false（不能因为"容错降级"就报绿，那等于掩盖故障）；
// 向量未启用必须 ok:true（可选能力缺失不是故障，报红会误导用户去"修"）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-batch4-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { searchRouter, invalidateDoctorCache } = await import('../src/routes/search.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

async function doctorCall() {
  let json: any
  // L1 延迟治理引入 5 分钟 TTL 缓存：测试必须每次穿透缓存取新算结果（用例间改 config 后断言）
  invalidateDoctorCache()
  const layer = (searchRouter as any).stack.find((l: any) => l.route?.methods?.get && l.route.path === '/doctor')
  await layer.route.stack[0].handle({}, { status() { return this }, json(p: any) { json = p } })
  return json
}

test('doctor：checks 八项齐全（含 M4 资产一致性）；空库 files 报提示、向量未启用为合法态', async () => {
  const db = await getDb()
  // 向量化已默认开启（本地 Ollama），「未启用是合法态」需显式禁用模拟
  await (await db.prepare(
    `INSERT OR REPLACE INTO config (key, value, type) VALUES ('ai.embedding', ?, 'json')`
  )).run([JSON.stringify({ enabled: false, provider: 'ollama', model: '' })])
  const r = await doctorCall()
  assert.equal(r.success, true)
  const keys = r.checks.map((c: any) => c.key)
  for (const k of ['files', 'hybrid', 'fts', 'vector', 'aliases', 'gate', 'freshness', 'consistency']) {
    assert.ok(keys.includes(k), `checks 必须含 ${k}`)
  }
  // M4 一致性契约：空库（无 done 文件）consistency 必须绿——done 必有词条是「可可靠消费」的前提
  const consistency = r.checks.find((c: any) => c.key === 'consistency')
  assert.equal(consistency.ok, true, '空库无 done-no-meta，一致性应为绿')
  const files = r.checks.find((c: any) => c.key === 'files')
  assert.equal(files.ok, false, '空库 files 应为 false（引导去扫描）')
  assert.match(files.detail, /挂载|扫描/)
  const vector = r.checks.find((c: any) => c.key === 'vector')
  assert.equal(vector.ok, true, '向量未启用是合法态（可选能力缺失不是故障）')
  assert.match(vector.detail, /未启用/)
})

test('doctor：别名坏 JSON 必须标红（容错降级不能掩盖故障）；修好后转绿', async () => {
  const db = await getDb()
  await (await db.prepare("UPDATE config SET value = '{broken' WHERE key = 'search.aliases'")).run()
  const bad = await doctorCall()
  const aliasesBad = bad.checks.find((c: any) => c.key === 'aliases')
  assert.equal(aliasesBad.ok, false, '坏 JSON 必须 ok:false（用户可感知）')
  assert.match(aliasesBad.detail, /损坏/)

  await (await db.prepare(`UPDATE config SET value = '{"gh": "tag:github"}' WHERE key = 'search.aliases'`)).run()
  const good = await doctorCall()
  const aliasesGood = good.checks.find((c: any) => c.key === 'aliases')
  assert.equal(aliasesGood.ok, true)
  assert.match(aliasesGood.detail, /1 条/)
})

test('doctor：混合开关关闭时 hybrid 项 ok:false 并交代回退行为', async () => {
  const db = await getDb()
  await (await db.prepare("UPDATE config SET value = 'false' WHERE key = 'search.hybridEnabled'")).run()
  const r = await doctorCall()
  const hybrid = r.checks.find((c: any) => c.key === 'hybrid')
  assert.equal(hybrid.ok, false)
  assert.match(hybrid.detail, /回退|旧单路/)
  await (await db.prepare("UPDATE config SET value = 'true' WHERE key = 'search.hybridEnabled'")).run()
})

test('doctor：FTS 孤儿行必须标红（清理前 fts ok:false，清理后转绿）——残留不得静默虚高覆盖率', async () => {
  const db = await getDb()
  // 造一条孤儿：直接往 FTS 插主表不存在的 entry_id
  await (await db.prepare(`INSERT INTO wiki_fts (entry_id, title, summary, content) VALUES (999999999, 'ghost', '', '')`)).run()
  const bad = await doctorCall()
  const ftsBad = bad.checks.find((c: any) => c.key === 'fts')
  assert.equal(ftsBad.ok, false, '孤儿行必须让 fts 检查失败（否则覆盖率虚高不可感知）')
  assert.match(ftsBad.detail, /孤儿/)

  // 清理端点删除孤儿 → doctor 转绿
  const { wikiRouter } = await import('../src/routes/wiki.js')
  let pruned: any
  const layer = (wikiRouter as any).stack.find((l: any) => l.route?.methods?.post && l.route.path === '/fts/prune')
  await layer.route.stack[0].handle({}, { status() { return this }, json(p: any) { pruned = p } })
  assert.equal(pruned.success, true)
  assert.ok(pruned.pruned >= 1, '清理端点必须删掉孤儿行')

  const good = await doctorCall()
  assert.equal(good.checks.find((c: any) => c.key === 'fts').ok, true)
})

test('doctor freshness：陈旧词条（file_mtime > distilled_at 的 done 行）标红并带分桶；刷新后转绿', async () => {
  const db = await getDb()
  // 造一条陈旧：done 文件 + 词条 distilled_at 早于 file_mtime
  const fid = Number((await (await db.prepare(
    "INSERT INTO files (path, name, ext, file_mtime, llm_state, status) VALUES ('/tmp/fresh.md', 'fresh.md', '.md', '2026-09-22T12:00:00.000Z', 'done', 'active')"
  )).run()).lastID)
  await (await db.prepare(
    "INSERT INTO wiki_entries_meta (file_id, entry_path, distilled_at, title) VALUES (?, '/tmp/fresh-entry.md', '2026-09-15T12:00:00.000Z', '旧词条')"
  )).run([fid])

  const stale = await doctorCall()
  const f = stale.checks.find((c: any) => c.key === 'freshness')
  assert.ok(f, 'checks 必须含 freshness')
  assert.equal(f.ok, false, '陈旧词条必须标红（检索召回旧知识不可静默）')
  assert.match(f.detail, /词条落后于文件内容/)
  assert.match(f.detail, /7-30天 1/, '分桶计数正确（7 天差落入 7-30天 桶）')
  assert.match(f.detail, /待蒸馏/, 'detail 附带 pending 数指引排查方向')

  // 模拟重蒸馏完成（distilled_at 拉到 mtime 之后）→ 转绿
  await (await db.prepare("UPDATE wiki_entries_meta SET distilled_at = '2026-09-22T13:00:00.000Z' WHERE file_id = ?")).run([fid])
  const fresh = await doctorCall()
  const f2 = fresh.checks.find((c: any) => c.key === 'freshness')
  assert.equal(f2.ok, true, '刷新后转绿')
  assert.match(f2.detail, /词条全部新鲜/)
})
