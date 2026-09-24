import { storedVecToF32 } from '../llm/embeddings.js'

/**
 * P2 内存向量索引：entry_chunks 向量常驻内存（Map<entryId, ChunkVec[]>）。
 * WHY：L1 实测检索 28s 的构成 = 每次查询从 SQLite 搬 538MB BLOB + 逐行解码——
 * 数据不变时重复搬运是纯浪费。常驻后查询仅剩浮点点积（55k×2560 MAC ≈ 300ms），
 * DB 搬运归零。内存预算：~560MB Float32（55k 块 × 2560 维 × 4B + norm 预计算），
 * 本地单用户调度站可接受；后续需要再上 int8 量化（~140MB）。
 *
 * 一致性模型：写入/删除路径调 invalidateEntry(entryId)（load 中则挂起集合，完成后补删）；
 * 检索前 ensureLoaded 一次（boot 已后台预热则即时）。降级：load 失败抛错由调用方回退 DB 扫描。
 */
export interface ChunkVec { chunk_index: number; vec: Float32Array; norm: number }

const byEntry = new Map<number, ChunkVec[]>()
let loadPromise: Promise<void> | null = null
let pendingInvalidates = new Set<number>()

/** 行向量 → ChunkVec（norm 预计算：查询侧只做点积，除法用缓存的 norm——省一半浮点） */
function toChunkVec(chunkIndex: number, raw: any): ChunkVec | null {
  const vec = storedVecToF32(raw)
  if (!vec) return null
  let n = 0
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i]
  return { chunk_index: chunkIndex, vec, norm: Math.sqrt(n) }
}

/** 单词条从 DB 重载进缓存（写入路径增量维护用；几块向量，点查级开销） */
export async function reloadEntry(db: any, entryId: number): Promise<void> {
  const rows = await (await db.prepare(
    'SELECT chunk_index, embedding FROM entry_chunks WHERE entry_id = ? AND embedding IS NOT NULL'
  )).all([entryId]) as any[]
  const out: ChunkVec[] = []
  for (const r of rows) {
    const cv = toChunkVec(Number(r.chunk_index), r.embedding)
    if (cv) out.push(cv)
  }
  if (out.length) byEntry.set(entryId, out)
  else byEntry.delete(entryId)
}

/** 写入/删除路径失效钩子：立即可靠（已加载则删缓存；加载中则挂起集合防旧数据覆盖新写入） */
export function invalidateEntry(entryId: number): void {
  if (loadPromise) pendingInvalidates.add(entryId)
  else byEntry.delete(entryId)
}

/** 全量加载（幂等，并发共享同一 Promise）；首次调用后常驻直至失效钩子维护 */
export function ensureLoaded(db: any): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const rows = await (await db.prepare(
      'SELECT entry_id, chunk_index, embedding FROM entry_chunks WHERE embedding IS NOT NULL'
    )).all() as any[]
    for (const r of rows) {
      const cv = toChunkVec(Number(r.chunk_index), r.embedding)
      if (!cv) continue
      const eid = Number(r.entry_id)
      let arr = byEntry.get(eid)
      if (!arr) { arr = []; byEntry.set(eid, arr) }
      arr.push(cv)
    }
    // load 窗口内的失效补执行（窗口内的写入已落库，直接整集合重删→reloadEntry 由写路径自带）
    if (pendingInvalidates.size) {
      const late = pendingInvalidates
      pendingInvalidates = new Set()
      for (const eid of late) byEntry.delete(eid)
    }
  })().catch(e => {
    loadPromise = null // 失败允许重试（下次检索再拉）
    throw e
  })
  return loadPromise
}

/** 检索入口：预归一化查询后在缓存上做点积；返回每词条最高分块（entryId, chunk_index, score） */
export function searchIndexCache(queryVector: ArrayLike<number>, limit: number): Array<{ entryId: number; chunk_index: number; score: number }> {
  let qn = 0
  for (let i = 0; i < queryVector.length; i++) qn += queryVector[i] * queryVector[i]
  qn = Math.sqrt(qn)
  if (qn === 0) return []
  const best = new Map<number, { chunk_index: number; score: number }>()
  for (const [eid, chunks] of byEntry) {
    for (const c of chunks) {
      if (c.vec.length !== queryVector.length || c.norm === 0) continue
      let dot = 0
      const v = c.vec
      for (let i = 0; i < v.length; i++) dot += queryVector[i] * v[i]
      const score = dot / (qn * c.norm)
      if (score <= 0) continue
      const prev = best.get(eid)
      if (!prev || score > prev.score) best.set(eid, { chunk_index: c.chunk_index, score })
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([entryId, info]) => ({ entryId, chunk_index: info.chunk_index, score: info.score }))
}

/** 观测：缓存规模（doctor/日志用） */
export function indexCacheStats(): { entries: number; chunks: number; loaded: boolean } {
  let chunks = 0
  for (const arr of byEntry.values()) chunks += arr.length
  return { entries: byEntry.size, chunks, loaded: !!loadPromise }
}
