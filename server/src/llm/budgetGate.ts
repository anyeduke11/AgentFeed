import { getDb } from '../db.js'
import { loadPricingTable, computeDayCost } from './pricing.js'

/**
 * G1 日预算闸：当日（date(created_at)=date('now')、status='success'）累计 LLM 成本超 config:llm.dailyBudgetCost
 * 则暂停蒸馏队列。成本依赖 ai.pricing 单价表——未配单价时成本恒为 0，闸自然不触发（token-only 降级口径）。
 */
export const BUDGET_CONFIG_KEY = 'llm.dailyBudgetCost'

/** 预算闸最近一次触发暂停的日期（YYYY-MM-DD，UTC，与 SQL date('now') 对齐）。次日复位判断依据：非本闸暂停（用户手动）不越权恢复 */
let lastTrippedDay: string | null = null

async function dailyState(): Promise<{ day: string, budget: number | null, todayCost: number }> {
  const db = await getDb()
  const dayRow = await (await db.prepare(`SELECT date('now') as d`)).get() as any
  const day = String(dayRow?.d || '')
  const budgetRow = await (await db.prepare(`SELECT value FROM config WHERE key = '${BUDGET_CONFIG_KEY}'`)).get() as any
  const raw = budgetRow ? Number(budgetRow.value) : NaN
  // 空/0/非法值 = 无闸（种子默认值为空串）
  const budget = Number.isFinite(raw) && raw > 0 ? raw : null
  const pricing = await loadPricingTable()
  const rows = await (await db.prepare(`
    SELECT provider, model, prompt_tokens, completion_tokens FROM llm_call_logs
    WHERE date(created_at) = date('now') AND status = 'success'
  `)).all() as any[]
  return { day, budget, todayCost: computeDayCost(rows, pricing).totalCost }
}

/**
 * 检查并执行日预算闸（入队后 fire-and-forget + 周期 job 双触发）：
 * - 超限 → pause + console.warn（当日已暂停过则幂等跳过不刷屏），返回 tripped=true
 * - 未超限不自动 resume；跨天首次检查时，若此前是预算闸暂停且当日未超限 → resume（次日复位）
 * - resume 为可选：入队巡检与测试 mock 可不传（仅 pause 侧生效）
 */
export async function enforceDailyBudget(llmQueue: { pause(): void, isPaused: boolean, resume?(): void }): Promise<{ tripped: boolean, todayCost: number, budget: number | null }> {
  const { day, budget, todayCost } = await dailyState()
  // 次日复位：昨天因预算暂停、今天成本归零未超限（或预算已撤）→ 恢复队列
  if (lastTrippedDay && lastTrippedDay !== day && llmQueue.isPaused && (budget == null || todayCost <= budget) && llmQueue.resume) {
    lastTrippedDay = null
    llmQueue.resume()
    console.log(`[budget] 日预算复位：今日成本 ¥${todayCost} 未超限（预算 ${budget == null ? '未配置' : `¥${budget}`}），蒸馏队列已恢复`)
  }
  if (budget == null) return { tripped: false, todayCost, budget: null }
  if (todayCost > budget) {
    if (!(lastTrippedDay === day && llmQueue.isPaused)) {
      lastTrippedDay = day
      llmQueue.pause()
      console.warn(`[budget] LLM 当日成本 ¥${todayCost} 已超日预算 ¥${budget}，蒸馏队列暂停（次日自动恢复；调大 config llm.dailyBudgetCost 或手动恢复队列可解除）`)
    }
    return { tripped: true, todayCost, budget }
  }
  return { tripped: false, todayCost, budget }
}
