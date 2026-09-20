import type { SqliteDatabase } from '@homeofthings/sqlite3'

// search_knowledge 共享核心：从 mcp.ts handler 的内联 SQL 逐字平移而来，
// 供 MCP 工具、Phase 2 基线脚本、测试三方复用。
// 行为契约不得漂移：字段与别名（d.name as domain_name）、status='active'、
// LIKE 三字段、tags 任一命中语义、ORDER BY file_mtime DESC、默认 limit 20 全部与原实现一致。

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
function normalizeTimeBound(value?: string): string | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) return null
  return new Date(ts).toISOString()
}

export async function searchKnowledgeCore(db: SqliteDatabase, params: SearchKnowledgeParams): Promise<any[]> {
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
