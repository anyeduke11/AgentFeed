import { getDb } from '../db.js'

/** 单价（元/百万 token） */
export interface PricingEntry {
  input: number
  output: number
}

/** tokens × 单价 → 金额（元，保留 4 位小数）；缺 token 计 0 */
export function computeCost(promptTokens: number | null | undefined, completionTokens: number | null | undefined, pricing: PricingEntry): number {
  const cost = ((promptTokens || 0) / 1e6) * pricing.input + ((completionTokens || 0) / 1e6) * pricing.output
  return +cost.toFixed(4)
}

/**
 * 按天聚合金额：已配单价（key=`provider/model`）的行计入 totalCost，未配的忽略（token-only 降级口径）；
 * unknownPricing=true 表示存在未配单价的行（合计仅含已配价模型）。
 */
export function computeDayCost(
  rows: Array<{ provider: string, model: string, prompt_tokens: number | null, completion_tokens: number | null }>,
  pricingTable: Record<string, PricingEntry>
): { totalCost: number, unknownPricing: boolean } {
  let total = 0
  let unknownPricing = false
  for (const r of rows) {
    const entry = pricingTable[`${r.provider}/${r.model}`]
    if (!entry) { unknownPricing = true; continue }
    total += computeCost(r.prompt_tokens, r.completion_tokens, entry)
  }
  return { totalCost: +total.toFixed(4), unknownPricing: rows.length > 0 ? unknownPricing : false }
}

/** 读 config 键 ai.pricing（type=json，形如 {"ollama/qwen3":{"input":0,"output":0}}）；未配置/坏 JSON/结构非法一律返回 {} 不抛错 */
export async function loadPricingTable(): Promise<Record<string, PricingEntry>> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.pricing'")).get() as any
  if (!row?.value) return {}
  try {
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const table: Record<string, PricingEntry> = {}
    for (const [key, val] of Object.entries(parsed)) {
      const e = val as any
      if (Number.isFinite(Number(e?.input)) && Number.isFinite(Number(e?.output))) {
        table[key] = { input: Number(e.input), output: Number(e.output) }
      }
    }
    return table
  } catch {
    return {}
  }
}

/** 当日（date(created_at)=date('now')，全状态）LLM 成本；未配任何单价 → null（区别于 0 元） */
export async function todayCost(): Promise<number | null> {
  const pricing = await loadPricingTable()
  if (!Object.keys(pricing).length) return null
  const db = await getDb()
  const rows = await (await db.prepare(`
    SELECT provider, model, prompt_tokens, completion_tokens
    FROM llm_call_logs WHERE date(created_at) = date('now')
  `)).all() as any[]
  return computeDayCost(rows, pricing).totalCost
}
