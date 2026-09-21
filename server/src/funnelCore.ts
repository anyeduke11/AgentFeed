// E1 消费链路漏斗核心（mcpFunnel.ts 的纯计算部分抽出，供诊断面板 API 复用）。
// WHY 抽模块：mcpFunnel.ts 是 CLI 入口（argValue/main/进程退出），API 不能 import 它；
// 反过来脚本与 API 共享同一套聚类/漏斗/归因口径——面板数字与脚本输出必须一字不差，否则
// 「面板说 33% 脚本说 40%」的口径漂移比没有面板更糟。
// 归因分类为确定性启发式（v2.5 裁决：灰区表 E1 归因分类规则确定性，不交模型）。

/** 会话切分阈值：相邻调用间隔超过 30 分钟视为新会话 */
export const SESSION_GAP_MS = 30 * 60 * 1000
/** 归因词面重合阈值：低于此值判 weak_match（疑似检索质量问题） */
export const WEAK_MATCH_THRESHOLD = 0.2

export const TOOL_SEARCH = 'search_knowledge'
export const TOOL_READ = 'read_entry'
export const TOOL_SOURCE = 'get_source'

export interface FunnelCallRow {
  id: number
  tool: string
  args: string | null
  created_at: string | null
}

export interface FunnelEvent {
  tool: string
  t: number
  raw: string
  id: number
  args: string | null
}

export type Attribution = 'followed' | 'args_null' | 'weak_match' | 'needs_review'

/** 解析 SQLite CURRENT_TIMESTAMP（UTC "YYYY-MM-DD HH:MM:SS"）为毫秒；无法解析返回 null */
export function parseTs(raw: string | null): number | null {
  if (!raw) return null
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : normalized + 'Z')
  return Number.isNaN(ms) ? null : ms
}

/** 会话聚类：相邻保留记录间隔 > 30 分钟则切分；非法时间戳剔除并计数 */
export function clusterSessions(rows: FunnelCallRow[]): { sessions: FunnelEvent[][], skipped: number } {
  const sessions: FunnelEvent[][] = []
  let skipped = 0
  for (const row of rows) {
    const t = parseTs(row.created_at)
    if (t === null) { skipped++; continue }
    const event: FunnelEvent = { tool: row.tool, t, raw: row.created_at!, id: row.id, args: row.args }
    const last = sessions[sessions.length - 1]
    if (!last || event.t - last[last.length - 1].t > SESSION_GAP_MS) sessions.push([event])
    else last.push(event)
  }
  return { sessions, skipped }
}

/** 同会话内：fromTool 事件后 30 分钟内跟随 toTool */
export function funnelDone(events: FunnelEvent[], fromTool: string, toTool: string): boolean {
  for (let i = 0; i < events.length; i++) {
    if (events[i].tool !== fromTool) continue
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].t - events[i].t > SESSION_GAP_MS) break
      if (events[j].tool === toTool) return true
    }
  }
  return false
}

/** 单事件版（归因逐条用，与 funnelDone 同口径） */
export function followedWithin(events: FunnelEvent[], e: FunnelEvent, toTool: string): boolean {
  for (const other of events) {
    if (other.t <= e.t) continue
    if (other.t - e.t > SESSION_GAP_MS) break
    if (other.tool === toTool) return true
  }
  return false
}

/** 从 args 摘要（可能被 200 字符截断的 JSON）提取 query：JSON.parse 失败走正则兜底 */
export function extractQuery(args: string | null): string | null {
  if (!args) return null
  try {
    const o = JSON.parse(args)
    if (typeof o?.query === 'string' && o.query.trim()) return o.query.trim()
  } catch { /* 截断 JSON */ }
  const m = args.match(/"query"\s*:\s*"([^"]{1,200})/)
  return m ? m[1] : null
}

/** 词面特征：CJK 二元组 + ASCII 整词 */
export function queryTerms(q: string): string[] {
  const terms: string[] = []
  for (const seg of (q.match(/[\u4e00-\u9fff]+/g) || [])) {
    if (seg.length === 1) { terms.push(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) terms.push(seg.slice(i, i + 2))
  }
  for (const w of (q.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])) terms.push(w.toLowerCase())
  return terms
}

/** 词面重合度：terms 命中比例；terms 空 → null（不可判定） */
export function overlapRatio(terms: string[], doc: string): number | null {
  if (terms.length === 0) return null
  const lower = doc.toLowerCase()
  return terms.filter(t => lower.includes(t)).length / terms.length
}

export interface FunnelMetrics {
  totalSessions: number
  sessionsWithSearch: number
  sessionsWithRead: number
  level1Done: number
  level2Done: number
  level1Rate: number
  level2Rate: number
  totalCalls: number
  skippedRows: number
}

/** 漏斗指标（面板与脚本共用口径） */
export function computeFunnel(sessions: FunnelEvent[][], skipped: number, totalCalls: number): FunnelMetrics {
  const withSearch = sessions.filter(s => s.some(e => e.tool === TOOL_SEARCH))
  const withRead = sessions.filter(s => s.some(e => e.tool === TOOL_READ))
  const level1Done = withSearch.filter(s => funnelDone(s, TOOL_SEARCH, TOOL_READ)).length
  const level2Done = withRead.filter(s => funnelDone(s, TOOL_READ, TOOL_SOURCE)).length
  const rate = (n: number, d: number) => d === 0 ? 0 : Math.round((n / d) * 10000) / 10000
  return {
    totalSessions: sessions.length,
    sessionsWithSearch: withSearch.length,
    sessionsWithRead: withRead.length,
    level1Done, level2Done,
    level1Rate: rate(level1Done, withSearch.length),
    level2Rate: rate(level2Done, withRead.length),
    totalCalls, skippedRows: skipped
  }
}

/** 归因分类（不含重放——重放依赖 DB 查询，由调用方注入 replayFn 保持本模块纯计算） */
export type ReplayFn = (query: string) => Promise<{ id: number, title: string }[]>

export async function attributeSearches(
  sessions: FunnelEvent[][],
  replayFn: ReplayFn
): Promise<{ counts: Record<Attribution, number>, samples: { logId: number, ts: string, query: string | null, overlap: number | null, top3Titles: string[] }[] }> {
  const counts: Record<Attribution, number> = { followed: 0, args_null: 0, weak_match: 0, needs_review: 0 }
  const samples: { logId: number, ts: string, query: string | null, overlap: number | null, top3Titles: string[] }[] = []
  for (const s of sessions) {
    if (!s.some(e => e.tool === TOOL_SEARCH)) continue
    for (const e of s) {
      if (e.tool !== TOOL_SEARCH) continue
      if (followedWithin(s, e, TOOL_READ)) { counts.followed++; continue }
      const query = extractQuery(e.args)
      if (query === null) { counts.args_null++; samples.push({ logId: e.id, ts: e.raw, query: null, overlap: null, top3Titles: [] }); continue }
      const top3 = await replayFn(query)
      const ov = overlapRatio(queryTerms(query), top3.map(r => r.title).join(' '))
      const cls: Attribution = ov !== null && ov < WEAK_MATCH_THRESHOLD ? 'weak_match' : 'needs_review'
      counts[cls]++
      if (samples.length < 10) samples.push({ logId: e.id, ts: e.raw, query, overlap: ov, top3Titles: top3.map(t => t.title.slice(0, 24)) })
    }
  }
  return { counts, samples: samples.slice(0, 10) }
}
