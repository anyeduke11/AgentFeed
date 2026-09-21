import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// E2 getContext 聚合内核（src/context.ts）契约测试。
// WHY：该内核是 agent 注入（getContext 工具）与人侧领域陪练官（I1 角色）的同一份数据源——
// 排序错、预算失守或口径漂移会同时污染两个出口。必须钉住：
// ① 先验口径与 recommend/llmWorker 一致（quality_score 非空优先 → ×3+rule_score 降序），
//    已评分词条不得被未评分词条压过；② 软删文件不得进入注入（墓碑复活误注入 = 幽灵知识）；
// ③ token 预算截断可预期（整行放不下即停、首行硬截断兜底、提示语必须出现）；
// ④ config 键 getContext.tokenBudget 生效且可被调用方覆盖。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 chunkBackfill.test.ts 模式，不种 FTS/向量）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-context-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { aggregateDomainContext, estimateTokens, CONFIG_KEY_TOKEN_BUDGET } = await import('../src/context.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let fileSeq = 0
/** 种一个文件 + 蒸馏词条；返回 wiki_entries_meta.id。quality 传 null 表示未评分。 */
async function seedEntry(
  domainId: number,
  title: string,
  summary: string,
  quality: number | null,
  ruleScore: number | null,
  opts?: { status?: string, distilledAt?: string }
): Promise<number> {
  const db = await getDb()
  fileSeq += 1
  const fr = await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, domain_id, rule_score, file_mtime, status)
     VALUES (?, ?, 'md', ?, ?, ?, '2026-09-01 10:00:00', ?)`
  )).run([`/ctx/f${fileSeq}.md`, `f${fileSeq}`, title, domainId, ruleScore, opts?.status ?? 'active'])
  const wr = await (await db.prepare(
    `INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, quality_score, distilled_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )).run([Number(fr.lastID), `/wiki/ctx/f${fileSeq}.md`, title, summary, quality, opts?.distilledAt ?? '2026-09-01 12:00:00'])
  return Number(wr.lastID)
}

test('领域不存在返回 null；名称与 id 双路解析一致', async () => {
  const db = await getDb()
  const dr = await (await db.prepare(`INSERT INTO domains (name) VALUES ('ctx-领域A')`)).run()
  const domainId = Number(dr.lastID)
  assert.equal(await aggregateDomainContext('不存在的领域'), null)
  assert.equal(await aggregateDomainContext(99999), null)
  const byName = await aggregateDomainContext('ctx-领域A')
  const byId = await aggregateDomainContext(domainId)
  assert.ok(byName && byId)
  assert.equal(byName.domainId, domainId)
  assert.equal(byName.domainName, 'ctx-领域A')
  assert.equal(byId.domainId, byName.domainId)
})

test('先验口径：quality_score 非空优先，×3+rule_score 降序（已评分不被未评分压过）', async () => {
  const db = await getDb()
  const dr = await (await db.prepare(`INSERT INTO domains (name) VALUES ('ctx-排序域')`)).run()
  const dId = Number(dr.lastID)
  // 未评分但 rule 满分 10 → prior 10；已评分 q=3,r=0 → prior 9。非空优先必须胜过 prior 数值
  const unscored = await seedEntry(dId, '未评分高规则', 's1', null, 10)
  // 已评分 q=3 → prior 9；q=2,r=2 → prior 8；q=2,r=1 → prior 7
  const scoredMid = await seedEntry(dId, '已评分三', 's2', 3, 0)
  const scoredLow = await seedEntry(dId, '已评分二', 's3', 2, 2)
  await seedEntry(dId, '已评分一', 's4', 2, 1)

  const ctx = await aggregateDomainContext('ctx-排序域', { topN: 4 })
  assert.ok(ctx)
  const ids = ctx.topEntries.map(e => e.entryId)
  // 期望：已评分按 prior 降序（scoredMid 9 → scoredLow 8 → s4 7），未评分垫底
  assert.deepEqual(ids, [scoredMid, scoredLow, ctx.topEntries[2].entryId, unscored])
  assert.equal(ctx.entryCount, 4)
  assert.equal(ctx.truncated, false)
})

test('软删（status=deleted）与空标题词条不进入注入', async () => {
  const db = await getDb()
  const dr = await (await db.prepare(`INSERT INTO domains (name) VALUES ('ctx-边界域')`)).run()
  const dId = Number(dr.lastID)
  const alive = await seedEntry(dId, '存活词条', '正文要点', 5, 5)
  await seedEntry(dId, '软删词条', '不应出现', 9, 9, { status: 'deleted' })
  await (await db.prepare(
    `INSERT INTO files (path, name, ext, domain_id, status) VALUES ('/ctx/empty.md', 'empty', 'md', ?, 'active')`
  )).run([dId])
  await (await db.prepare(
    `INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary) VALUES (NULL, '/wiki/ctx/empty.md', '', '空标题')`
  )).run()

  const ctx = await aggregateDomainContext(dId)
  assert.ok(ctx)
  assert.equal(ctx.entryCount, 1)
  assert.deepEqual(ctx.topEntries.map(e => e.entryId), [alive])
  assert.ok(!ctx.summaryText.includes('软删词条'), '软删词条不得出现在注入文本')
})

test('token 预算：整行放不下即停并给截断提示；一行放不下时硬截断首行', async () => {
  const db = await getDb()
  const dr = await (await db.prepare(`INSERT INTO domains (name) VALUES ('ctx-预算域')`)).run()
  const dId = Number(dr.lastID)
  await seedEntry(dId, '第一条长标题词条一二三四五六七八九十', '很长的要点'.repeat(10), 5, 5)
  await seedEntry(dId, '第二条词条', '短要点', 4, 4)

  // 预算充足：两行全进，不截断
  const full = await aggregateDomainContext(dId, { tokenBudget: 2000 })
  assert.equal(full.truncated, false)
  assert.ok(full.summaryText.includes('第二条词条'))

  // 预算紧张：只进第一行，第二行被截掉且有提示
  const tight = await aggregateDomainContext(dId, { tokenBudget: estimateTokens(full.summaryText) - estimateTokens('- 第二条词条：短要点') })
  assert.equal(tight.truncated, true)
  assert.ok(!tight.summaryText.includes('第二条词条'), '超出预算的整行不得进入')
  assert.ok(tight.summaryText.includes('token 预算已截断'), '必须有可感知的截断提示（不可静默）')
  assert.ok(tight.tokenEstimate <= tight.tokenBudget, `估算 ${tight.tokenEstimate} 应在预算 ${tight.tokenBudget} 内`)

  // 极小预算：连首行都放不下 → 硬截断首行兜底，仍给出领域存在的最小信号
  const tiny = await aggregateDomainContext(dId, { tokenBudget: 25 })
  assert.equal(tiny.truncated, true)
  assert.ok(tiny.summaryText.includes('ctx-预算域'), '极小预算下头部行（领域名）必须保留')
})

test('config 键 getContext.tokenBudget 生效，调用方可覆盖', async () => {
  const db = await getDb()
  const dr = await (await db.prepare(`INSERT INTO domains (name) VALUES ('ctx-config域')`)).run()
  await seedEntry(Number(dr.lastID), '词条', '要点', 5, 5)
  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)')).run([CONFIG_KEY_TOKEN_BUDGET, '42', 'number'])
  const byConfig = await aggregateDomainContext('ctx-config域')
  assert.equal(byConfig.tokenBudget, 42)
  const overridden = await aggregateDomainContext('ctx-config域', { tokenBudget: 500 })
  assert.equal(overridden.tokenBudget, 500)
})

test('estimateTokens：CJK 按 1 计，ASCII 按 ~4 字符/token 折算（确定性）', async () => {
  assert.equal(estimateTokens('知识库'), 3)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('知识 abc'), 3) // 2 CJK + 4 ASCII（含空格）→ 2 + 1
  assert.equal(estimateTokens(''), 0)
})
