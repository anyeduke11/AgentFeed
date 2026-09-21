import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// G1 LLM 成本视图与日预算闸契约测试。
// WHY：金额换算与预算闸是成本失控的唯一防线——单价表读错、口径漂移（失败调用计入预算）、
// 闸静默（无 warn 无 pause）都会让「日预算」承诺失效。必须钉住：
// ① computeCost 纯换算精确到 4 位小数（1M prompt @ 2 元/M = 2 元，tokens ÷ 1e6 × 单价）；
// ② computeDayCost 未配单价行忽略不计但置 unknownPricing（token-only 降级口径，前端合计只含已配价模型）；
// ③ loadPricingTable 坏 JSON 返回 {} 不抛错（展示与闸都不得因配置损坏 500）；
// ④ enforceDailyBudget 只按当日 status='success' 聚合：未配置预算/未超限不触发，超限必须 pause 且可见；
// ⑤ stats /llm 出口带 cost/totalCost/todayCost（前端成本列数据源）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 context.test.ts 模式）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-pricing-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { computeCost, computeDayCost, loadPricingTable } = await import('../src/llm/pricing.js')
const { enforceDailyBudget } = await import('../src/llm/budgetGate.js')
const { statsRouter } = await import('../src/routes/stats.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

async function setConfig(key: string, value: string, type: string) {
  const db = await getDb()
  await db.exec(`INSERT INTO config (key, value, type) VALUES ('${key}', '${value.replace(/'/g, "''")}', '${type}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
}

/** 种一条调用日志；不传 createdAt 落 CURRENT_TIMESTAMP（与 date('now') 同为 UTC，保证落在「当日」） */
async function seedLog(provider: string, model: string, prompt: number, completion: number, status = 'success', createdAt?: string) {
  const db = await getDb()
  await (await db.prepare(`
    INSERT INTO llm_call_logs (file_id, provider, model, prompt_tokens, completion_tokens, total_tokens, duration_ms, status, created_at)
    VALUES (NULL, ?, ?, ?, ?, ?, 100, ?, ${createdAt ? `'${createdAt}'` : 'CURRENT_TIMESTAMP'})
  `)).run([provider, model, prompt, completion, prompt + completion, status])
}

test('computeCost：百万 token 单价换算精确 4 位小数；缺 token 计 0', () => {
  assert.equal(computeCost(1_000_000, 1_000_000, { input: 2, output: 8 }), 10)
  assert.equal(computeCost(123_456, 0, { input: 2, output: 8 }), 0.2469, '123456 tok @ 2 元/M = 0.246912 → 保留 4 位截断')
  assert.equal(computeCost(null, undefined, { input: 2, output: 8 }), 0)
})

test('computeDayCost：未配单价行不计入合计；存在未配价行即 unknownPricing=true', () => {
  const table = { 'p/m': { input: 2, output: 8 } }
  const mixed = computeDayCost([
    { provider: 'p', model: 'm', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    { provider: 'x', model: 'y', prompt_tokens: 9_000_000, completion_tokens: 9_000_000 },
  ], table)
  assert.equal(mixed.totalCost, 10, '未配价模型 900 万 token 不得污染合计')
  assert.equal(mixed.unknownPricing, true, '部分未配价 → 降级标记（前端 tooltip 依据）')
  const all = computeDayCost([{ provider: 'x', model: 'y', prompt_tokens: 100, completion_tokens: 100 }], table)
  assert.equal(all.totalCost, 0)
  assert.equal(all.unknownPricing, true, '全未配 → token-only 降级口径')
  const full = computeDayCost([{ provider: 'p', model: 'm', prompt_tokens: 500_000, completion_tokens: 0 }], table)
  assert.deepEqual(full, { totalCost: 1, unknownPricing: false })
})

test('loadPricingTable：未配置 / 合法 / 坏 JSON 三态（坏 JSON 返回 {} 不抛错）', async () => {
  const db = await getDb()
  await db.exec(`DELETE FROM config WHERE key = 'ai.pricing'`)
  assert.deepEqual(await loadPricingTable(), {}, '未配置 → 空表')
  await setConfig('ai.pricing', '{"ollama/qwen3":{"input":0,"output":0},"p/m":{"input":2,"output":8}}', 'json')
  assert.deepEqual(await loadPricingTable(), {
    'ollama/qwen3': { input: 0, output: 0 },
    'p/m': { input: 2, output: 8 },
  })
  await setConfig('ai.pricing', '{"broken', 'json')
  assert.deepEqual(await loadPricingTable(), {}, '坏 JSON 降级空表，配置损坏不得拖垮展示与闸')
})

/** mock 队列：记录 pause/resume 调用次数（enforceDailyBudget 只依赖 { pause, isPaused } 结构） */
function mockQueue() {
  return {
    pauseCount: 0, resumeCount: 0, paused: false,
    pause() { this.pauseCount++; this.paused = true },
    resume() { this.resumeCount++; this.paused = false },
    get isPaused() { return this.paused },
  }
}

test('enforceDailyBudget：未配置预算/未超限不触发；仅当日成功调用计入；超限 → tripped 且 pause 被调', async () => {
  const db = await getDb()
  await setConfig('ai.pricing', '{"p/m":{"input":2,"output":8}}', 'json')
  const clear = async () => { await db.exec('DELETE FROM llm_call_logs') }

  // ① 预算未配置（种子默认空串）→ 无论成本多高都无闸
  await clear()
  await seedLog('p', 'm', 10_000_000, 0)
  await setConfig('llm.dailyBudgetCost', '', 'number')
  let q = mockQueue()
  let r = await enforceDailyBudget(q)
  assert.equal(r.tripped, false)
  assert.equal(r.budget, null, '空串预算 = 无闸')
  assert.equal(q.pauseCount, 0)

  // ② 已配预算 5 元、当日成功成本 2 元 → 不触发
  await clear()
  await seedLog('p', 'm', 1_000_000, 0)
  await setConfig('llm.dailyBudgetCost', '5', 'number')
  q = mockQueue()
  r = await enforceDailyBudget(q)
  assert.equal(r.tripped, false)
  assert.equal(r.todayCost, 2)
  assert.equal(q.pauseCount, 0)

  // ③ 失败调用 tokens 不计入预算口径（status='success' 才计）
  await seedLog('p', 'm', 10_000_000, 0, 'failed')
  q = mockQueue()
  r = await enforceDailyBudget(q)
  assert.equal(r.todayCost, 2, '失败调用 1000 万 token 不得推高当日预算成本')
  assert.equal(r.tripped, false)

  // ④ 追加成功调用至 6 元 > 5 元 → tripped=true 且 pause 被调用
  await seedLog('p', 'm', 2_000_000, 0)
  q = mockQueue()
  r = await enforceDailyBudget(q)
  assert.equal(r.todayCost, 6)
  assert.equal(r.tripped, true)
  assert.equal(q.pauseCount, 1, '超限必须真的暂停队列（不可静默）')
  assert.ok(q.isPaused)
})

test('GET /stats/llm：byDay/byModel 行带 cost（未配价 null），顶层 totalCost/unknownPricing/todayCost', async () => {
  const db = await getDb()
  await db.exec('DELETE FROM llm_call_logs')
  await setConfig('ai.pricing', '{"p/m":{"input":2,"output":8}}', 'json')
  await seedLog('p', 'm', 1_000_000, 1_000_000)
  await seedLog('x', 'y', 5_000_000, 5_000_000)
  await seedLog('p', 'm', 500_000, 0, 'success', '2026-01-01 10:00:00')

  const layer = (statsRouter as any).stack.find((l: any) => l.route?.path === '/llm' && l.route.methods?.get)
  assert.ok(layer, 'GET /llm 路由必须存在')
  let json: any
  await layer.route.stack[0].handle({ method: 'GET', query: {} }, { json: (p: any) => { json = p } })

  assert.equal(json.totalCost, 11, '全部历史已配价成本 10（今日）+ 1（历史）')
  assert.equal(json.unknownPricing, true, 'x/y 未配价 → 降级标记')
  assert.equal(json.todayCost, 10, '当日已配价成本（x/y 忽略）')
  const today = ((await (await db.prepare(`SELECT date('now') as d`)).get()) as any).d
  const todayRow = json.byDay.find((r: any) => r.day === today)
  assert.ok(todayRow, 'byDay 含今日行')
  assert.equal(todayRow.cost, 10)
  const pm = json.byModel.find((r: any) => r.provider === 'p' && r.model === 'm')
  assert.equal(pm.cost, 11)
  const xy = json.byModel.find((r: any) => r.provider === 'x')
  assert.equal(xy.cost, null, '未配单价 → cost=null（前端显示 —）')
})
