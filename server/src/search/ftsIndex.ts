import type { SqliteDatabase } from '@homeofthings/sqlite3'
import fs from 'fs/promises'

// Phase 2 检索基建 · 任务 2.1：wiki 词条 FTS5 关键词路。
// 索引对象 = wiki_entries_meta 每行的 标题 + 摘要 + entry.md 正文（LLM 词条的「关键要点」在正文
// 「## 关键要点」小节内，随正文一并入索引；外部挂载词条文件缺失时退化为标题+摘要）。
//
// 同步机制选型（最简单可靠者）：
// - 不用 external content 表：索引正文来自磁盘 entry.md 文件而非 DB 列，外部内容表覆盖不了；
// - 不用 contentless 表：不支持按 entry_id DELETE（旧 SQLite 无 contentless_delete）且无法 snippet()；
// - 不用触发器：正文变化发生在磁盘，wiki_entries_meta 上的触发器感知不到文件更新；
// - 最终选「普通 FTS5 虚表 + 应用层同步」：表自持内容，支持按 entry_id 删除与 snippet 片段；
//   本波提供全量路径（rebuildFts / ensureFtsPopulated），下一波集成在蒸馏写入点调 upsertFtsEntry 增量同步。

const FTS_TABLE = 'wiki_fts'

/** 全量回填上限保护：主表超过该规模时拒绝启动期回填，防误伤大库（测试可经 opts.cap 覆盖） */
export const FTS_BACKFILL_CAP = 20000

let ftsTokenizer: 'trigram' | 'unicode61' | null = null

/** 当前库实际生效的 FTS tokenizer（ensureFtsTable 后有意义；null = FTS5 完全不可用，检索层降级空结果） */
export function getFtsTokenizer(): 'trigram' | 'unicode61' | null {
  return ftsTokenizer
}

/** 幂等创建 FTS5 虚表；tokenizer 探测：优先 trigram（CJK 原生子串匹配唯一路径），编译缺失降级 unicode61 */
export async function ensureFtsTable(db: SqliteDatabase): Promise<void> {
  const row = await (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")).get([FTS_TABLE]) as any
  if (row?.sql) {
    // 表已存在：tokenizer 随建表那一刻固定，这里只解析记录供检索层分支使用
    const m = /tokenize\s*=\s*'([^']+)'/.exec(String(row.sql))
    ftsTokenizer = m?.[1] === 'trigram' ? 'trigram' : 'unicode61'
    return
  }
  try {
    await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(entry_id UNINDEXED, title, summary, content, tokenize = 'trigram')`)
    ftsTokenizer = 'trigram'
  } catch {
    // 降级 unicode61：CJK 退化为整串 token 无法 MATCH，检索层自动回退 LIKE 兜底（不阻塞启动）
    try {
      await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(entry_id UNINDEXED, title, summary, content, tokenize = 'unicode61')`)
      ftsTokenizer = 'unicode61'
    } catch (e) {
      // FTS5 完全不可用：fail loud 留日志，检索函数按空结果降级
      ftsTokenizer = null
      console.warn('[ftsIndex] FTS5 完全不可用，关键词路降级为空结果:', String((e as any)?.message || e))
    }
  }
}

/** 是否含 CJK 字符（假名/汉字/谚文）：unicode61 无 CJK 分词能力，检索层需回退 LIKE */
function hasCjk(q: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(q)
}

/** FTS5 MATCH 查询词整体包双引号做短语匹配，内部双引号翻倍转义（防 query 中的 FTS5 语法字符注入） */
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`
}

/** LIKE 通配符转义（% _ \），配合 ESCAPE '\\' 保证用户输入按字面匹配 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, ch => '\\' + ch)}%`
}

export interface FtsHit {
  entry_id: number
  title: string
  summary: string
  /** 命中片段摘要（MATCH 路径为 snippet() 产物，LIKE 路径为 instr 定位手工截取） */
  snippet: string
  /** 相关度：MATCH 路径 = -bm25（越大越相关），LIKE 路径恒 0（仅按命中字段优先级排序） */
  score: number
}

/**
 * FTS 关键词检索：返回命中的 wiki 词条（条目 id + 命中片段摘要），JOIN 主表过滤已删除的孤儿索引行。
 * 分支规则：trigram 下 query >= 3 字符走 MATCH（子串语义，CJK/英文通吃）；更短的 query 与
 * unicode61 下的 CJK query 回退 LIKE。空 query / FTS5 不可用返回空数组，不抛错。
 */
export async function searchFts(db: SqliteDatabase, query: string, limit = 10): Promise<FtsHit[]> {
  if (!ftsTokenizer) await ensureFtsTable(db)
  const q = String(query || '').trim()
  if (!q || !ftsTokenizer) return []
  const useMatch = ftsTokenizer === 'trigram' ? [...q].length >= 3 : !hasCjk(q)

  if (useMatch) {
    const rows = await (await db.prepare(`
      SELECT ${FTS_TABLE}.entry_id AS entry_id, ${FTS_TABLE}.title AS title, ${FTS_TABLE}.summary AS summary,
             snippet(${FTS_TABLE}, 2, '', '', '…', 24) AS snippet,
             -bm25(${FTS_TABLE}) AS score
      FROM ${FTS_TABLE} JOIN wiki_entries_meta ON wiki_entries_meta.id = ${FTS_TABLE}.entry_id
      WHERE ${FTS_TABLE} MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `)).all([ftsPhrase(q), limit]) as any[]
    return rows.map(r => ({
      entry_id: Number(r.entry_id),
      title: String(r.title || ''),
      summary: String(r.summary || ''),
      snippet: String(r.snippet || ''),
      score: Number(r.score || 0)
    }))
  }

  // LIKE 回退路径：title > summary > content 命中优先级排序（短 CJK query 的兜底子串语义）
  const like = likePattern(q)
  const rows = await (await db.prepare(`
    SELECT ${FTS_TABLE}.entry_id AS entry_id, ${FTS_TABLE}.title AS title, ${FTS_TABLE}.summary AS summary,
           CASE
             WHEN instr(${FTS_TABLE}.content, ?) > 0 THEN substr(${FTS_TABLE}.content, max(1, instr(${FTS_TABLE}.content, ?) - 40), 120)
             ELSE substr(COALESCE(${FTS_TABLE}.summary, ''), 1, 120)
           END AS snippet,
           0 AS score
    FROM ${FTS_TABLE} JOIN wiki_entries_meta ON wiki_entries_meta.id = ${FTS_TABLE}.entry_id
    WHERE ${FTS_TABLE}.title LIKE ? ESCAPE '\\' OR ${FTS_TABLE}.summary LIKE ? ESCAPE '\\' OR ${FTS_TABLE}.content LIKE ? ESCAPE '\\'
    ORDER BY CASE WHEN ${FTS_TABLE}.title LIKE ? ESCAPE '\\' THEN 0 WHEN ${FTS_TABLE}.summary LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
             ${FTS_TABLE}.entry_id
    LIMIT ?
  `)).all([q, q, like, like, like, like, like, limit]) as any[]
  return rows.map(r => ({
    entry_id: Number(r.entry_id),
    title: String(r.title || ''),
    summary: String(r.summary || ''),
    snippet: String(r.snippet || ''),
    score: Number(r.score || 0)
  }))
}

/** 单词条增量同步：先删后插保证幂等（同 entry_id 重复调用不产生重复索引行） */
export async function upsertFtsEntry(db: SqliteDatabase, entryId: number, title: string, summary: string, content: string): Promise<void> {
  await (await db.prepare(`DELETE FROM ${FTS_TABLE} WHERE entry_id = ?`)).run([entryId])
  await (await db.prepare(`INSERT INTO ${FTS_TABLE} (entry_id, title, summary, content) VALUES (?, ?, ?, ?)`))
    .run([entryId, String(title || ''), String(summary || ''), String(content || '')])
}

export async function deleteFtsEntry(db: SqliteDatabase, entryId: number): Promise<void> {
  await (await db.prepare(`DELETE FROM ${FTS_TABLE} WHERE entry_id = ?`)).run([entryId])
}

/** 全量重建：清空 FTS 后从主表 + entry.md 逐条回填；文件缺失退化为标题+摘要；重复调用结果一致（幂等） */
export async function rebuildFts(db: SqliteDatabase): Promise<number> {
  if (!ftsTokenizer) await ensureFtsTable(db)
  if (!ftsTokenizer) return 0
  await db.exec(`DELETE FROM ${FTS_TABLE}`)
  const rows = await (await db.prepare('SELECT id, title, summary, entry_path FROM wiki_entries_meta')).all() as any[]
  let n = 0
  for (const r of rows) {
    let content = ''
    try {
      content = await fs.readFile(String(r.entry_path || ''), 'utf8')
    } catch { /* entry.md 缺失（外部词条未落盘/已清理）：标题+摘要仍可索引 */ }
    await upsertFtsEntry(db, Number(r.id), String(r.title || ''), String(r.summary || ''), content)
    n++
  }
  return n
}

/**
 * 启动期幂等回填：仅当「FTS 空而主表非空」时全量回填一次（配 rebuildFts 即可重复安全执行）。
 * 主表规模超上限（防误伤大库：启动期全量读盘+建索引不可控）或 FTS 已有数据时跳过，返回原因可查。
 */
export async function ensureFtsPopulated(db: SqliteDatabase, opts: { cap?: number } = {}): Promise<{ rebuilt: boolean; entries: number; reason: string }> {
  if (!ftsTokenizer) await ensureFtsTable(db)
  if (!ftsTokenizer) return { rebuilt: false, entries: 0, reason: 'fts_unavailable' }
  const ftsCount = Number((await (await db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`)).get() as any)?.n || 0)
  if (ftsCount > 0) return { rebuilt: false, entries: ftsCount, reason: 'fts_not_empty' }
  const metaCount = Number((await (await db.prepare('SELECT COUNT(*) AS n FROM wiki_entries_meta')).get() as any)?.n || 0)
  if (metaCount === 0) return { rebuilt: false, entries: 0, reason: 'source_empty' }
  const cap = opts.cap ?? FTS_BACKFILL_CAP
  if (metaCount > cap) {
    console.warn(`[ftsIndex] 主表 ${metaCount} 行超过回填上限 ${cap}，跳过启动期 FTS 回填（可手动 rebuildFts）`)
    return { rebuilt: false, entries: 0, reason: 'over_cap' }
  }
  const n = await rebuildFts(db)
  return { rebuilt: true, entries: n, reason: 'rebuilt' }
}
