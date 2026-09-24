import type { SqliteDatabase } from '@homeofthings/sqlite3'
import fs from 'fs/promises'
import { createHash } from 'node:crypto'
import { getEmbeddingConfig, callEmbedding, cosine, vecToBlob, storedVecToF32, type EmbeddingConfig } from '../llm/embeddings.js'
import { ensureLoaded, searchIndexCache, invalidateEntry, reloadEntry } from './vectorIndex.js'
import { getProviders } from '../llm/llmClient.js'

// Phase 2 检索基建 · 任务 2.2：entry.md 按 heading 分块 + 分块向量路（parent-child 检索）。
// 语义：命中 child 块 → 返回 parent 词条（wiki_entries_meta.id），解决长词条整体向量稀释局部语义的问题。
// 嵌入能力复用现有封装：getEmbeddingConfig（config 键 ai.embedding）+ callEmbedding（OpenAI 兼容 /embeddings）；
// 向量按 Float32 BLOB 落库（L1 起，vecToBlob/storedVecToF32 编解码）。
// 降级承诺：provider 未配置或单条调用失败一律优雅跳过（不抛错、不阻塞启动）——本地优先不绑厂商，向量路必须可缺席。
// 幂等模型：entry_chunks UNIQUE(entry_id, chunk_index) + content_hash（sha256 of 嵌入文本）——
// hash 相同的块零嵌入调用，变了才重嵌；入口 indexWikiChunks 支持单词条增量（entryId）与全量（不传）。

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const FENCE_RE = /^\s*(```|~~~)/

export interface EntryChunk {
  chunk_index: number
  /** 标题层级路径，形如 `# 标题 > ## 小节 > ### 子节`；首个 heading 之前的前言块为空串 */
  heading_path: string
  content: string
}

/**
 * 按 heading（# ~ ######）切块：每个 heading 开新块，heading 前的正文为前言块（heading_path 为空）。
 * 围栏代码块（``` / ~~~）内的 # 视为普通文本不切块——md 正文常见代码注释，误切会撕裂语义。
 * 纯空白内容不产生块；chunk_index 从 0 起按文档顺序递增。切块只按 heading 边界，不做长度二次切分
 * （超长 heading 段整段成块：边界行为可预期，向量化上游模型上下文有限时由嵌入端处理）。
 */
export function chunkEntryMd(md: string): EntryChunk[] {
  const chunks: EntryChunk[] = []
  const stack: Array<{ level: number; text: string }> = []
  let buf: string[] = []
  let inFence = false
  const flush = () => {
    const content = buf.join('\n').trim()
    if (content) {
      chunks.push({
        chunk_index: chunks.length,
        heading_path: stack.map(s => '#'.repeat(s.level) + ' ' + s.text).join(' > '),
        content
      })
    }
    buf = []
  }
  for (const line of String(md || '').split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      buf.push(line)
      continue
    }
    if (inFence) {
      buf.push(line)
      continue
    }
    const m = HEADING_RE.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: m[2].trim() })
    } else {
      buf.push(line)
    }
  }
  flush()
  return chunks
}

/** 块内容指纹：覆盖嵌入文本（heading 路径 + 正文）——hash 相同即视为已嵌入，跳过重算 */
function chunkHash(headingPath: string, content: string): string {
  return createHash('sha256').update(headingPath + '\n' + content).digest('hex')
}

/** 向量路总开关：config 键 search.vectorEnabled，缺省 true（db.ts seedDefaults 有同键种子） */
async function isVectorEnabled(db: SqliteDatabase): Promise<boolean> {
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'search.vectorEnabled'")).get() as any
  return row ? String(row.value) !== 'false' : true
}

/** 嵌入函数类型：opts.embedFn 为测试注入点（伪造向量），注入时视为能力由调用方自证，跳过 provider 可用性检查 */
type EmbedFn = (text: string, cfg: EmbeddingConfig) => Promise<number[]>

interface EmbedContext {
  doEmbed: EmbedFn
  cfg: EmbeddingConfig
}

type DegradeReason = 'ok' | 'vector_disabled' | 'embedding_not_configured' | 'no_embedding_provider'

/** 批量嵌入前置检查：总开关关闭 / 嵌入模型未配置 / provider 不可达任一命中返回 ctx=null（调用方直接短路，不抛错） */
async function resolveEmbedContext(db: SqliteDatabase, opts: { embedFn?: EmbedFn }): Promise<{ ctx: EmbedContext | null; reason: DegradeReason }> {
  const cfg = await getEmbeddingConfig()
  const inject = opts.embedFn ?? null
  if (!inject) {
    if (!cfg.enabled || !cfg.model) return { ctx: null, reason: 'embedding_not_configured' }
    const providers = await getProviders()
    const provider = providers.find(p => p.name === cfg.provider) || providers.find(p => p.name === 'ollama')
    if (!provider?.baseUrl) return { ctx: null, reason: 'no_embedding_provider' }
  }
  return { ctx: { doEmbed: inject ?? callEmbedding, cfg }, reason: 'ok' }
}

/**
 * 单词条处理：读 entry.md → 分块 → 逐块 hash 比对（只嵌新块/hash 变化的块）→ 事务写库。
 * 事务保证条目级全有或全无：部分块嵌入失败整条目回滚，不留下半新半旧的块集。
 * 正文为空/纯空白 → 清空该词条既有块（内容消失 = 向量路同步消失）；读文件失败 → 返回 false 由调用方计 failed。
 */
async function processEntryChunks(db: SqliteDatabase, entry: { id: any; entry_path: any }, doEmbed: EmbedFn, cfg: EmbeddingConfig): Promise<boolean> {
  try {
    const md = await fs.readFile(String(entry.entry_path || ''), 'utf8')
    const chunks = chunkEntryMd(md)
    const entryId = Number(entry.id)
    if (chunks.length === 0) {
      await (await db.prepare('DELETE FROM entry_chunks WHERE entry_id = ?')).run([entryId])
      invalidateEntry(entryId) // P2 内存索引：内容消失 = 缓存同步消失
      return true
    }
    const existingRows = await (await db.prepare('SELECT chunk_index, content_hash FROM entry_chunks WHERE entry_id = ?')).all([entryId]) as any[]
    const existing = new Map<number, string>()
    for (const r of existingRows) existing.set(Number(r.chunk_index), String(r.content_hash || ''))
    // 只嵌脏块：新增块 + hash 变化的块；未变化块零嵌入调用（更新场景的成本下限 = 变化块数）
    const dirty: Array<{ chunk: EntryChunk; hash: string; vector: number[] }> = []
    for (const c of chunks) {
      const h = chunkHash(c.heading_path, c.content)
      if (existing.get(c.chunk_index) === h) continue
      // 嵌入文本带标题路径前缀：让块向量携带层级上下文（「清洗规则」在什么标题下语义不同）
      const text = (c.heading_path ? c.heading_path + '\n' : '') + c.content
      dirty.push({ chunk: c, hash: h, vector: await doEmbed(text, cfg) })
    }
    const keep = new Set(chunks.map(c => c.chunk_index))
    const stale = [...existing.keys()].filter(i => !keep.has(i))
    await db.transactionalize(async () => {
      for (const d of dirty) {
        await (await db.prepare(`
          INSERT INTO entry_chunks (entry_id, chunk_index, heading_path, content, model, dim, embedding, content_hash, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(entry_id, chunk_index) DO UPDATE SET
            heading_path = excluded.heading_path, content = excluded.content, model = excluded.model,
            dim = excluded.dim, embedding = excluded.embedding, content_hash = excluded.content_hash,
            updated_at = CURRENT_TIMESTAMP
        `)).run([
          entryId, d.chunk.chunk_index, d.chunk.heading_path, d.chunk.content,
          String(cfg.model || ''), d.vector.length, vecToBlob(d.vector), d.hash
        ])
      }
      for (const i of stale) {
        await (await db.prepare('DELETE FROM entry_chunks WHERE entry_id = ? AND chunk_index = ?')).run([entryId, i])
      }
    })
    // P2 内存索引：事务后增量重载该词条（脏块/删块立即反映到缓存；几块点查级开销）
    if (dirty.length || stale.length) await reloadEntry(db, entryId)
    return true
  } catch {
    return false
  }
}

export interface ChunkIndexStatus {
  /** 本次调用面对的条目数（全量 = 全库词条数；单条 = 1 或 0） */
  total: number
  /** 成功写入块（或无可索引块）的条目数 */
  indexed: number
  /** 单条失败跳过的条目数（不中断整体） */
  failed: number
  vectorEnabled: boolean
  reason: DegradeReason
}

/**
 * 分块向量路索引入口（任务 2.2.3）：entryId 给定 = 单词条增量（蒸馏写入点/更新后调用）；
 * 缺省 = 全库逐条（chunk 级 content_hash 幂等，已索引且未变化的词条零嵌入调用，可安全反复执行）。
 * 三层降级（总开关/未配置/provider 缺失）直接返回可查状态；单条目失败计数跳过继续。
 */
export async function indexWikiChunks(
  db: SqliteDatabase,
  entryId?: number,
  opts: { embedFn?: EmbedFn } = {}
): Promise<ChunkIndexStatus> {
  const rows = entryId != null
    ? await (await db.prepare('SELECT id, entry_path FROM wiki_entries_meta WHERE id = ?')).all([entryId]) as any[]
    : await (await db.prepare('SELECT id, entry_path FROM wiki_entries_meta')).all() as any[]
  if (!(await isVectorEnabled(db))) {
    return { total: rows.length, indexed: 0, failed: 0, vectorEnabled: false, reason: 'vector_disabled' }
  }
  const { ctx, reason } = await resolveEmbedContext(db, opts)
  if (!ctx) return { total: rows.length, indexed: 0, failed: 0, vectorEnabled: true, reason }
  let indexed = 0
  let failed = 0
  for (const entry of rows) {
    if (await processEntryChunks(db, entry, ctx.doEmbed, ctx.cfg)) indexed++
    else failed++
  }
  return { total: rows.length, indexed, failed, vectorEnabled: true, reason: 'ok' }
}

/**
 * 启动回填口径（保持既有语义）：只为「尚无任何块」的词条处理，已有块的条目完全不碰（短路省磁盘 IO）；
 * chunk 级增量/更新重嵌走 indexWikiChunks。embedFn 注入语义同 indexWikiChunks。
 */
export async function ensureChunksIndexed(
  db: SqliteDatabase,
  opts: { embedFn?: EmbedFn } = {}
): Promise<ChunkIndexStatus> {
  const pending = await (await db.prepare(`
    SELECT m.id, m.entry_path FROM wiki_entries_meta m
    WHERE NOT EXISTS (SELECT 1 FROM entry_chunks c WHERE c.entry_id = m.id)
  `)).all() as any[]
  if (!(await isVectorEnabled(db))) {
    return { total: pending.length, indexed: 0, failed: 0, vectorEnabled: false, reason: 'vector_disabled' }
  }
  if (pending.length === 0) {
    return { total: 0, indexed: 0, failed: 0, vectorEnabled: true, reason: 'ok' }
  }
  const { ctx, reason } = await resolveEmbedContext(db, opts)
  if (!ctx) return { total: pending.length, indexed: 0, failed: 0, vectorEnabled: true, reason }
  let indexed = 0
  let failed = 0
  for (const entry of pending) {
    if (await processEntryChunks(db, entry, ctx.doEmbed, ctx.cfg)) indexed++
    else failed++
  }
  return { total: pending.length, indexed, failed, vectorEnabled: true, reason: 'ok' }
}

export interface VectorHit {
  entry_id: number
  title: string
  summary: string
  entry_path: string
  /** 余弦相似度（越大越相关，复用 embeddings.ts 的 cosine 实现） */
  score: number
  /** 命中的 child 块信息（同词条多块命中时保留最高分块） */
  chunk_index: number
  heading_path: string
  snippet: string
}

/**
 * 分块向量检索（L1 延迟治理·两段式）：扫描阶段只取 entry_id/chunk_index/embedding 三列——
 * 旧实现 JOIN wiki_entries_meta 全量携带 title/summary/entry_path/content 文本列，54k chunks
 * 下数十 MB 明文随扫描搬进 JS 却只在命中后使用（命中率 <0.1%）。先算余弦得 Top 词条，
 * 再按 (entry_id, chunk_index) 回查元数据与 snippet。语义与旧实现一致（含损坏向量跳过）。
 */
export async function searchVector(db: SqliteDatabase, queryVector: number[], limit = 5): Promise<VectorHit[]> {
  // P2 内存索引优先：常驻缓存点积（norm 预计算，零 DB 搬运）；加载失败降级 DB 两段式
  let top: Array<{ entryId: number; chunk_index: number; score: number }> = []
  try {
    await ensureLoaded(db)
    top = searchIndexCache(queryVector, limit)
  } catch { /* 降级 DB 扫描 */ }
  if (!top.length) {
    const rows = await (await db.prepare(`
      SELECT c.entry_id, c.chunk_index, c.embedding
      FROM entry_chunks c
      WHERE c.embedding IS NOT NULL
    `)).all() as any[]
    const best = new Map<number, { score: number; chunk_index: number }>()
    for (const r of rows) {
      const vec = storedVecToF32(r.embedding)
      if (!vec) continue
      const score = cosine(queryVector, vec)
      if (score <= 0) continue
      const entryId = Number(r.entry_id)
      const prev = best.get(entryId)
      if (!prev || score > prev.score) {
        best.set(entryId, { score, chunk_index: Number(r.chunk_index) })
      }
    }
    top = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
      .map(([entryId, info]) => ({ entryId, chunk_index: info.chunk_index, score: info.score }))
  }
  if (!top.length) return []
  const hits: VectorHit[] = []
  for (const t of top) {
    const row = await (await db.prepare(`
      SELECT m.title, m.summary, m.entry_path, c.heading_path, c.content
      FROM wiki_entries_meta m JOIN entry_chunks c ON c.entry_id = m.id AND c.chunk_index = ?
      WHERE m.id = ?`)).get([t.chunk_index, t.entryId]) as any
    if (!row) continue
    hits.push({
      entry_id: t.entryId,
      title: String(row.title || ''),
      summary: String(row.summary || ''),
      entry_path: String(row.entry_path || ''),
      score: t.score,
      chunk_index: t.chunk_index,
      heading_path: String(row.heading_path || ''),
      snippet: String(row.content || '').slice(0, 160),
    })
  }
  return hits.sort((a, b) => b.score - a.score)
}

/** 任务 2.2.4 命名口径的向量检索入口（与 searchVector 同一实现）：命中 parent 词条按余弦相似度降序 */
export async function vectorSearchWiki(db: SqliteDatabase, queryEmbedding: number[], limit = 5): Promise<VectorHit[]> {
  return searchVector(db, queryEmbedding, limit)
}
