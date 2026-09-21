import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { ftsSearchWiki } from './ftsIndex.js'
import { vectorSearchWiki } from './chunkEmbed.js'
import { getEmbeddingConfig, callEmbedding, type EmbeddingConfig } from '../llm/embeddings.js'
import { getProviders } from '../llm/llmClient.js'
import { legacySearchKnowledge, normalizeTimeBound, type SearchKnowledgeParams } from '../knowledge.js'

// Phase 2 检索基建 · 任务 2.3 + 2.4：search_knowledge 混合召回（三路 RRF 融合）。
//
// 三路设计（不是两路——files LIKE 路保留为保证基线对比公平与向后兼容的第三路）：
//   路 1 files LIKE   = legacySearchKnowledge（旧单路 SQL，rank 基准 = 旧契约的 file_mtime 降序）
//   路 2 wiki FTS     = ftsSearchWiki（trigram bm25 降序 / 短 CJK 回退 LIKE 的 id 列表）
//   路 3 wiki 向量    = vectorSearchWiki（entry_chunks parent-child，余弦相似度降序）
//
// RRF（Reciprocal Rank Fusion）：score = Σ 1/(k + rank_i)，k=60 取自 Cormack et al. 2009
// 提出并被 Elasticsearch 等引擎沿用的惯例常数（rank_constant=60），对头部排名敏感度适中。
// 各路内部先过滤（legacy SQL WHERE / wiki 路关联 file 过滤）再排序再截断：每路取 limit*3 候选融合。
//
// 静态先验（只调序不淘汰）：final = rrf × (1 + prior)，
//   prior = (quality_score × 3 + rule_score) / 40。
// 列名与值域已核实（db.ts / ruleScore.ts / llmWorker.parseQualityScore）：
//   files.rule_score REAL（0~10，五维精算 1 位小数）——注意 quality_score 不在 files 表，
//   而是 wiki_entries_meta.quality_score REAL（0~10，LLM 蒸馏评分钳位 1 位小数），经 LEFT JOIN 取。
// raw = q×3 + r ∈ [0, 40]（与 recommend.ts 既有排序公式 q*3+r 同构），除以 40 归一化到 [0,1]。
//
// 外部 rerank 仅可选开关：config 键 search.rerankEndpoint（未配置 = 纯 RRF，默认行为）。
// 配置了才把候选列表 POST 给外部服务重排；任何失败（超时 3s / 非 200 / 响应格式错）降级回 RRF 序，绝不抛错。
//
// 降级链（任何一级失败不得整体失败）：
//   query 嵌入失败 / 嵌入未配置 / search.vectorEnabled=false → 跳过向量路；
//   wiki FTS 路空（索引空 / query 短 / FTS5 不可用 getFtsTokenizer()=null）→ 自然少一路；
//   三路全空 → 返回空；FTS 完全不可用 + 向量缺席 → 仅 files LIKE 路 = 等价旧行为。
//
// 统一输出结构：wiki 命中词条经关联键 wiki_entries_meta.file_id（UNIQUE，1:1 挂接 files.id）
// 映射回与 files 路相同的 7 字段行；确无关联 file 的词条用词条自身字段填充
// （id = 词条 id、path = entry_path、source_agent/file_mtime/domain_name = null）并附加 entry_path
// 供 mcp.ts 的 wiki_entry_path 映射取真实路径（关联 file 的行不带该附加字段，契约行结构不变）。
//
// 过滤口径：domain/tags/agent 过滤与 since/until 时间窗三路语义一致——files 路直接过滤；
// wiki 路通过关联 file 的对应列过滤，时间窗同样按关联 file 的 file_mtime（词条无独立时间轴，
// distilled_at 是蒸馏时间不是内容时间，故统一以源文件 mtime 为准）。
// 无关联 file 的词条没有任何过滤列：带 domain/tags/agent/since/until 任一过滤参数时
// 这些词条因 JOIN 条件不成立而被排除（fail-closed：无法证明符合过滤条件就不返回）。
//
// 开关：config 键 search.hybridEnabled，缺省 true；false 时完全走旧 files LIKE 路（等价旧行为逃生舱）。

const RRF_K = 60
/** 先验归一化分母：quality_score(0~10)×3 + rule_score(0~10) 的满分 */
const PRIOR_DENOM = 40
const RERANK_TIMEOUT_MS = 3000
/** SQLite IN 子句分块上限（远低于历史版本 999 变量上限，兼容旧运行时） */
const IN_CHUNK = 500

export interface HybridSearchOptions {
  /** 测试注入点：伪造 query 嵌入向量；注入时视为嵌入能力由调用方自证，跳过 provider 可用性检查（同 indexWikiChunks 模式） */
  embedFn?: (text: string, cfg: EmbeddingConfig) => Promise<number[]>
}

async function readConfigValue(db: SqliteDatabase, key: string): Promise<string | null> {
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([key]) as any
  return row ? String(row.value) : null
}

async function readConfigFlag(db: SqliteDatabase, key: string, dflt: boolean): Promise<boolean> {
  const v = await readConfigValue(db, key)
  if (v === null) return dflt
  return v !== 'false'
}

/** 向量路可用性解析：总开关 / 未配置 / provider 缺失任一命中返回 null（跳过该路不抛错）；opts.embedFn 注入时自证能力 */
async function resolveQueryVector(db: SqliteDatabase, query: string, opts: HybridSearchOptions): Promise<number[] | null> {
  if (!(await readConfigFlag(db, 'search.vectorEnabled', true))) return null
  const cfg = await getEmbeddingConfig()
  if (!opts.embedFn) {
    if (!cfg.enabled || !cfg.model) return null
    const providers = await getProviders()
    const provider = providers.find(p => p.name === cfg.provider) || providers.find(p => p.name === 'ollama')
    if (!provider?.baseUrl) return null
  }
  try {
    return await (opts.embedFn ?? callEmbedding)(query, cfg)
  } catch {
    // query 嵌入失败：跳过向量路（降级链核心要求——任何一级失败不得整体失败）
    return null
  }
}

/** wiki 命中词条 → 关联 file 行装配：带 domain/tags/agent 与 since/until 过滤（按关联 file 的列），分块 IN 防变量上限 */
async function loadWikiRows(
  db: SqliteDatabase,
  entryIds: number[],
  params: SearchKnowledgeParams,
  sinceBound: string | null,
  untilBound: string | null
): Promise<Map<number, any>> {
  const out = new Map<number, any>()
  for (let i = 0; i < entryIds.length; i += IN_CHUNK) {
    const chunk = entryIds.slice(i, i + IN_CHUNK)
    let sql = `
      SELECT w.id AS entry_id, w.title AS entry_title, w.summary AS entry_summary, w.entry_path,
             f.id AS id, f.title AS title, f.summary AS summary, f.path AS path,
             f.source_agent AS source_agent, f.file_mtime AS file_mtime, d.name AS domain_name
      FROM wiki_entries_meta w
      LEFT JOIN files f ON f.id = w.file_id
      LEFT JOIN domains d ON f.domain_id = d.id
      WHERE w.id IN (${chunk.map(() => '?').join(',')})
        AND (f.id IS NULL OR f.status = 'active')`
    const sqlParams: any[] = [...chunk]
    // 带过滤参数时无关联 file 的词条天然不满足条件（fail-closed），见文件头注释
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
    if (sinceBound) {
      sql += ` AND f.file_mtime >= ?`
      sqlParams.push(sinceBound)
    }
    if (untilBound) {
      sql += ` AND f.file_mtime <= ?`
      sqlParams.push(untilBound)
    }
    const rows = await (await db.prepare(sql)).all(sqlParams) as any[]
    for (const r of rows) out.set(Number(r.entry_id), r)
  }
  return out
}

/** wiki 命中行 → 输出行：有关联 file 输出 7 字段契约行；无关联词条用自身字段填充并附 entry_path（见文件头映射决策） */
function wikiRowToOutput(r: any): { row: any; fileId: number | null } {
  if (r.id != null) {
    return {
      row: {
        id: r.id, title: r.title, summary: r.summary, path: r.path,
        source_agent: r.source_agent, file_mtime: r.file_mtime, domain_name: r.domain_name
      },
      fileId: Number(r.id)
    }
  }
  return {
    row: {
      id: Number(r.entry_id), title: r.entry_title, summary: r.entry_summary, path: r.entry_path,
      source_agent: null, file_mtime: null, domain_name: null, entry_path: r.entry_path
    },
    fileId: null
  }
}

interface Candidate {
  /** 合并键：`f:<file_id>` / `w:<无关联词条 id>`，rerank 请求-响应以此对齐 */
  key: string
  row: any
  rrf: number
  fileId: number | null
  entryId: number | null
}

/** 静态先验批查：有关联 file 的候选查 (w.quality_score, f.rule_score)，无关联词条查词条自身 quality_score（无 rule_score 记 0） */
async function loadPriors(db: SqliteDatabase, candidates: Candidate[]): Promise<Map<string, number>> {
  const prior = new Map<string, number>()
  const fileIds = [...new Set(candidates.filter(c => c.fileId != null).map(c => c.fileId as number))]
  const entryOnlyIds = [...new Set(candidates.filter(c => c.fileId == null).map(c => c.entryId as number))]
  for (let i = 0; i < fileIds.length; i += IN_CHUNK) {
    const chunk = fileIds.slice(i, i + IN_CHUNK)
    const rows = await (await db.prepare(`
      SELECT f.id AS id, COALESCE(w.quality_score, 0) AS q, COALESCE(f.rule_score, 0) AS r
      FROM files f LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      WHERE f.id IN (${chunk.map(() => '?').join(',')})
    `)).all(chunk) as any[]
    for (const r of rows) prior.set(`f:${Number(r.id)}`, (Number(r.q) * 3 + Number(r.r)) / PRIOR_DENOM)
  }
  for (let i = 0; i < entryOnlyIds.length; i += IN_CHUNK) {
    const chunk = entryOnlyIds.slice(i, i + IN_CHUNK)
    const rows = await (await db.prepare(
      `SELECT id, COALESCE(quality_score, 0) AS q FROM wiki_entries_meta WHERE id IN (${chunk.map(() => '?').join(',')})`
    )).all(chunk) as any[]
    for (const r of rows) prior.set(`w:${Number(r.id)}`, Number(r.q) / PRIOR_DENOM)
  }
  return prior
}

/**
 * 外部 rerank（可选）：POST 候选给 search.rerankEndpoint，宽容解析 { results: [...] } / 顶层数组，
 * 元素支持 { id, score } 或 { index, score }（index 对应请求 candidates 数组下标）。
 * 任何失败（超时/非 200/格式错）返回 null 由调用方降级回 RRF 序——绝不抛错。
 */
async function callExternalRerank(query: string, candidates: Candidate[], endpoint: string): Promise<Map<string, number> | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        candidates: candidates.map(c => ({ id: c.key, text: `${c.row.title || ''}\n${c.row.summary || ''}`.slice(0, 500) }))
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const data = await res.json() as any
    const arr = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : null
    if (!arr) return null
    const scores = new Map<string, number>()
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      const sc = Number(item?.score)
      if (!Number.isFinite(sc)) continue
      const id = item?.id != null ? String(item.id) : (typeof item?.index === 'number' && candidates[item.index] ? candidates[item.index].key : null)
      if (id != null) scores.set(id, sc)
    }
    return scores
  } catch {
    return null
  }
}

/**
 * 三路 RRF 混合检索主入口：参数与 searchKnowledgeCore 一致（内部读 config 开关），
 * 返回行结构与旧单路完全兼容（7 字段；无关联词条行额外带 entry_path）。
 */
export async function hybridSearchWiki(
  db: SqliteDatabase,
  params: SearchKnowledgeParams,
  opts: HybridSearchOptions = {}
): Promise<any[]> {
  // 逃生舱：开关关闭完全等价旧行为（任务要求 false 时与旧逻辑一致）
  if (!(await readConfigFlag(db, 'search.hybridEnabled', true))) {
    return legacySearchKnowledge(db, params)
  }
  const limit = Math.max(1, params.limit ?? 20)
  const cand = limit * 3
  const query = String(params.query || '').trim()
  const sinceBound = normalizeTimeBound(params.since)
  const untilBound = normalizeTimeBound(params.until)

  // 路 1：files LIKE（旧契约 SQL，候选按 file_mtime 降序 = 本路 rank 序；无 query 时等价旧行为的全库检索）
  const fileHits = await legacySearchKnowledge(db, { ...params, limit: cand })

  // 路 2：wiki FTS；路 3：wiki 向量。空 query 两路无意义跳过；任何一路异常跳过（降级链）
  let ftsIds: number[] = []
  if (query) {
    try {
      ftsIds = (await ftsSearchWiki(db, query, cand)).map(Number)
    } catch { ftsIds = [] }
  }
  interface VecHit { entry_id: number }
  let vecHits: VecHit[] = []
  if (query) {
    try {
      const qv = await resolveQueryVector(db, query, opts)
      if (qv) vecHits = await vectorSearchWiki(db, qv, cand)
    } catch { vecHits = [] }
  }

  // RRF 合并：同一条目（file 同键 / 无关联词条同词条键）多路命中分数累加
  const merged = new Map<string, Candidate>()
  const addHit = (key: string, row: any, fileId: number | null, entryId: number | null, rank: number) => {
    const inc = 1 / (RRF_K + rank)
    const cur = merged.get(key)
    if (cur) cur.rrf += inc
    else merged.set(key, { key, row, rrf: inc, fileId, entryId })
  }
  fileHits.forEach((row, i) => addHit(`f:${Number(row.id)}`, row, Number(row.id), null, i + 1))

  // wiki 命中先装配行 + 过滤，再按各路 rank 序并表（FTS 与向量路 rank 各自独立从 1 计）
  const ftsRows = ftsIds.length > 0 ? await loadWikiRows(db, ftsIds, params, sinceBound, untilBound) : new Map<number, any>()
  ftsIds.forEach((entryId, i) => {
    const wikiRow = ftsRows.get(entryId)
    if (!wikiRow) return
    const { row, fileId } = wikiRowToOutput(wikiRow)
    if (fileId != null) addHit(`f:${fileId}`, row, fileId, null, i + 1)
    else addHit(`w:${entryId}`, row, null, entryId, i + 1)
  })
  const vecRows = vecHits.length > 0 ? await loadWikiRows(db, vecHits.map(h => Number(h.entry_id)), params, sinceBound, untilBound) : new Map<number, any>()
  vecHits.forEach((h, i) => {
    const entryId = Number(h.entry_id)
    const wikiRow = vecRows.get(entryId)
    if (!wikiRow) return
    const { row, fileId } = wikiRowToOutput(wikiRow)
    if (fileId != null) addHit(`f:${fileId}`, row, fileId, null, i + 1)
    else addHit(`w:${entryId}`, row, null, entryId, i + 1)
  })

  if (merged.size === 0) return []

  // 静态先验只调序不淘汰：final = 融合分 × (1 + prior)。
  // 外部 rerank 配置成功时以 rerank 分替换 RRF 分作为基础分（响应缺席的候选记 0 沉底，prior 语义不变）；失败降级回 RRF 序。
  const candidates = [...merged.values()]
  const priorMap = await loadPriors(db, candidates)
  let base = (c: Candidate) => c.rrf
  const endpoint = await readConfigValue(db, 'search.rerankEndpoint')
  if (endpoint) {
    const scores = await callExternalRerank(query, candidates, endpoint)
    if (scores) base = (c: Candidate) => scores.get(c.key) ?? 0
  }
  return candidates
    .map(c => ({ c, final: base(c) * (1 + (priorMap.get(c.key) ?? 0)) }))
    // 次级键 = file_mtime 降序（延续旧契约「最新优先」的产品价值观），再以行 id 保证并列时全序确定
    .sort((a, b) =>
      b.final - a.final ||
      String(b.c.row.file_mtime || '').localeCompare(String(a.c.row.file_mtime || '')) ||
      Number(b.c.row.id) - Number(a.c.row.id)
    )
    .slice(0, limit)
    .map(x => x.c.row)
}
