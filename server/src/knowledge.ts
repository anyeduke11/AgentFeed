import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { hybridSearchWiki } from './search/hybrid.js'
import { cleanTitle, cleanSummary } from './formatter.js'

// search_knowledge 共享核心：从 mcp.ts handler 的内联 SQL 逐字平移而来，
// 供 MCP 工具、Phase 2 基线脚本、测试三方复用。
//
// Phase 2 Wave 2：searchKnowledgeCore 升级为三路 RRF 混合检索，本文件退化为委托入口，
// 对外签名与返回行结构不变（7 字段：id/title/summary/path/source_agent/file_mtime/domain_name）。
// 旧单路 files LIKE 逻辑原样保留为导出的 legacySearchKnowledge——它是 hybrid 关闭
//（config 键 search.hybridEnabled=false）时的等价逃生舱，也是混合排序的基线对照。
// 注意：knowledge.ts 与 search/hybrid.ts 存在双向 import（hybrid 复用 legacy 作 files 路 + 逃生舱），
// 双方顶层均无副作用执行、互调只发生在函数体内，ESM 循环加载安全。

export interface SearchKnowledgeParams {
  query?: string
  domain?: string
  tags?: string[]
  agent?: string
  limit?: number
  since?: string
  until?: string
}

// since/until 归一化：file_mtime 存的是 TEXT ISO 8601 UTC 字符串
// （scanner.ts ingestFile 写入 stat.mtime.toISOString()，格式 'YYYY-MM-DDTHH:mm:ss.sssZ'；
// db.ts 建表虽声明 DATETIME，但 SQLite 类型亲和性下字符串按 TEXT 原样存储，测试 fixture 同为 ISO 字符串）。
// 故把入参解析为时间戳后用 toISOString() 归一化成同格式，字符串字典序比较即时间序比较；
// 非法日期（解析为 NaN）返回 null = 忽略该参数（不报错、不过滤），保持工具健壮。
// 导出供 hybrid.ts 的 wiki 路时间窗过滤复用，保证三路口径完全一致。
export function normalizeTimeBound(value?: string): string | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) return null
  return new Date(ts).toISOString()
}

/**
 * 旧单路 files LIKE 检索（Phase 2 混合检索落地前的原实现，逐字保留勿漂移）：
 * 行为契约 = status='active'、LIKE 三字段（title/summary/path）、domain/tags/agent 过滤、
 * since/until 闭区间、ORDER BY file_mtime DESC、默认 limit 20。
 * hybrid.ts 将本函数用作第三路（files LIKE 路）候选来源与开关关闭时的整体逃生舱。
 */
export async function legacySearchKnowledge(db: SqliteDatabase, params: SearchKnowledgeParams): Promise<any[]> {
  const limit = params.limit ?? 20
  let sql = `SELECT f.id, f.title, f.summary, f.path, f.source_agent, f.file_mtime, d.name as domain_name
             FROM files f
             LEFT JOIN domains d ON f.domain_id = d.id
             WHERE f.status = 'active'`
  const sqlParams: any[] = []
  if (params.query) {
    sql += ` AND (f.title LIKE ? OR f.summary LIKE ? OR f.path LIKE ?)`
    sqlParams.push(`%${params.query}%`, `%${params.query}%`, `%${params.query}%`)
  }
  if (params.domain) {
    sql += ` AND d.name = ?`
    sqlParams.push(params.domain)
  }
  if (params.agent) {
    sql += ` AND f.source_agent = ?`
    sqlParams.push(params.agent)
  }
  if (params.tags && params.tags.length > 0) {
    sql += ` AND f.id IN (
      SELECT ft.file_id FROM file_tags ft
      JOIN tags t ON ft.tag_id = t.id
      WHERE t.name IN (${params.tags.map(() => '?').join(',')})
    )`
    sqlParams.push(...params.tags)
  }
  // 时间窗闭区间过滤：>= since 且 <= until；参数化拼接避免注入，非法日期已归一化为 null 不落 SQL
  const sinceBound = normalizeTimeBound(params.since)
  if (sinceBound) {
    sql += ` AND f.file_mtime >= ?`
    sqlParams.push(sinceBound)
  }
  const untilBound = normalizeTimeBound(params.until)
  if (untilBound) {
    sql += ` AND f.file_mtime <= ?`
    sqlParams.push(untilBound)
  }
  sql += ` ORDER BY f.file_mtime DESC LIMIT ${limit}`
  const stmt = await db.prepare(sql)
  const rows = await stmt.all(sqlParams) as any[]
  return rows
}

export async function searchKnowledgeCore(db: SqliteDatabase, params: SearchKnowledgeParams): Promise<any[]> {
  const rows = await hybridSearchWiki(db, params)
  // A3 出口层清洗：脏 title（如 11 万字符 JSON）只在返回行改写，库内数据绝不回写；
  // Web 搜索 / MCP search_knowledge / 基线脚本共用本核心，一处清洗三方继承。
  return rows.map(r => ({
    ...r,
    title: typeof r.title === 'string' ? cleanTitle(r.title) : r.title,
    summary: typeof r.summary === 'string' ? cleanSummary(r.summary) : r.summary,
  }))
}
