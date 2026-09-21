// E2 getContext 聚合内核（v0.1.5 PRD 3.3.5 E2 · 第 4 批前置解耦）：
// 领域上下文实时聚合，零 DDL、零缓存表——蒸馏更新自然反映，性能不足再加缓存（届时另立迁移）。
// 消费方：MCP 第 8 工具 getContext（E2）与人侧对话领域陪练官角色注入（I1）——同一内核双出口，
// 保证 agent 侧注入与人侧角色背景「读到的是同一份领域画像」，不漂移。
// 先验口径与 recommend.ts / llmWorker 一致：quality_score(0~10)×3 + rule_score(0~10)，
// quality_score 非空优先（未评分手工蒸馏词条不压过已评分词条）。
import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { getDb } from './db.js'

/** token 预算缺省 1500（PRD E2：≤1500 且可配置）；config 键 getContext.tokenBudget 可覆盖 */
export const DEFAULT_TOKEN_BUDGET = 1500
export const CONFIG_KEY_TOKEN_BUDGET = 'getContext.tokenBudget'
/** top 产物清单缺省条数（PRD E2：score/mtime 排序取前 N，N 默认 10） */
export const DEFAULT_TOP_N = 10
/** 单词条要点行内 summary 截断长度（与 A3 摘要 80 字符展示口径同量级，注入场景放宽到 120） */
const ENTRY_SUMMARY_SLICE = 120

export interface ContextTopEntry {
  entryId: number
  fileId: number | null
  title: string
  summary: string
  priorScore: number
  fileMtime: string | null
}

export interface DomainContext {
  domainId: number
  domainName: string
  /** 该领域可注入词条总数（口径与 top 查询一致：active + 有标题），供「共 N 篇」表述 */
  entryCount: number
  /** 完整 top N 结构化清单（不受预算截断影响，调用方按需再剪） */
  topEntries: ContextTopEntry[]
  /** 预算内的注入文本（标题 + summary 要点行），超预算时截断并置 truncated */
  summaryText: string
  tokenEstimate: number
  tokenBudget: number
  truncated: boolean
}

/**
 * token 估算：CJK 字符（含中文标点/全角）按 1 token 计，其余按 ~4 字符/token 折算。
 * 确定性纯函数（供测试与调用方复用）；不追求精确，只求同一口径下可比较、可预算。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/** 折叠空白为单行（脏 title 的连续空白/换行不应进入注入文本） */
function collapseWhitespace(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

async function resolveDomain(
  db: SqliteDatabase,
  domain: string | number
): Promise<{ id: number, name: string } | null> {
  const isId = typeof domain === 'number' || /^\d+$/.test(String(domain))
  const row = isId
    ? await (await db.prepare('SELECT id, name FROM domains WHERE id = ?')).get([Number(domain)])
    : await (await db.prepare('SELECT id, name FROM domains WHERE name = ?')).get([String(domain)])
  return row ? { id: Number(row.id), name: String(row.name) } : null
}

async function readTokenBudget(db: SqliteDatabase): Promise<number> {
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([CONFIG_KEY_TOKEN_BUDGET]) as any
  if (!row) return DEFAULT_TOKEN_BUDGET
  const n = Number(row.value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOKEN_BUDGET
}

/**
 * 领域上下文聚合：按先验分取该领域 top 词条，组装预算内注入文本。
 * 领域不存在返回 null（调用方决定「空领域」表述——冷启动语义属 E2/I1 出口层，不在内核假设）。
 */
export async function aggregateDomainContext(
  domain: string | number,
  opts?: { topN?: number, tokenBudget?: number }
): Promise<DomainContext | null> {
  const db = await getDb()
  const resolved = await resolveDomain(db, domain)
  if (!resolved) return null

  const topN = opts?.topN && opts.topN > 0 ? Math.floor(opts.topN) : DEFAULT_TOP_N
  const budget = opts?.tokenBudget && opts.tokenBudget > 0
    ? Math.floor(opts.tokenBudget)
    : await readTokenBudget(db)

  // 口径：active 文件 + 非空标题（无标题词条无法进入要点行，不虚增 entryCount）
  const whereClause = `f.domain_id = ? AND f.status = 'active' AND w.title IS NOT NULL AND w.title != ''`
  const countRow = await (await db.prepare(
    `SELECT COUNT(*) AS n FROM wiki_entries_meta w JOIN files f ON f.id = w.file_id WHERE ${whereClause}`
  )).get([resolved.id]) as any

  const rows = await (await db.prepare(
    `SELECT w.id AS entry_id, w.file_id, w.title, COALESCE(w.summary, '') AS summary,
            (COALESCE(w.quality_score, 0) * 3 + COALESCE(f.rule_score, 0)) AS prior_score,
            f.file_mtime
     FROM wiki_entries_meta w
     JOIN files f ON f.id = w.file_id
     WHERE ${whereClause}
     ORDER BY (w.quality_score IS NOT NULL) DESC, prior_score DESC, w.distilled_at DESC
     LIMIT ?`
  )).all([resolved.id, topN]) as any[]

  const topEntries: ContextTopEntry[] = rows.map(r => ({
    entryId: Number(r.entry_id),
    fileId: r.file_id == null ? null : Number(r.file_id),
    title: collapseWhitespace(r.title),
    summary: collapseWhitespace(r.summary),
    priorScore: Number(r.prior_score),
    fileMtime: r.file_mtime == null ? null : String(r.file_mtime)
  }))

  // 预算内组装注入文本：头部行 + 逐词条要点行；整行放不下即停（不撕半行，保持可读），
  // 一行都放不下时对首行硬截断（预算再小也要给出「这个领域有什么」的最小信号）
  const header = `领域「${resolved.name}」共 ${Number(countRow?.n || 0)} 篇可注入词条，top ${topEntries.length} 要点：`
  const lines: string[] = []
  let used = estimateTokens(header)
  let truncated = false
  for (const e of topEntries) {
    const line = `- ${e.title}${e.summary ? '：' + e.summary.slice(0, ENTRY_SUMMARY_SLICE) : ''}`
    const cost = estimateTokens(line)
    if (used + cost <= budget) {
      lines.push(line)
      used += cost
    } else {
      truncated = true
      if (lines.length === 0) {
        // 首行即超预算：按 token≈字符比例硬截断（CJK 主导语料下 1 token ≈ 1 字符，保守可读）
        const room = Math.max(budget - used, 0)
        const sliced = line.slice(0, room)
        lines.push(room > 0 ? sliced : '')
        used += estimateTokens(sliced)
      }
      break
    }
  }
  if (truncated && topEntries.length > 0) lines.push('（超出 token 预算已截断，可用 getContext.tokenBudget 调整）')

  return {
    domainId: resolved.id,
    domainName: resolved.name,
    entryCount: Number(countRow?.n || 0),
    topEntries,
    summaryText: [header, ...lines].filter(l => l !== '').join('\n'),
    tokenEstimate: used,
    tokenBudget: budget,
    truncated
  }
}
