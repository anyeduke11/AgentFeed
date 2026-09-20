import type { SqliteDatabase } from '@homeofthings/sqlite3'
import fs from 'fs/promises'
import { getEmbeddingConfig, callEmbedding, cosine, type EmbeddingConfig } from '../llm/embeddings.js'
import { getProviders } from '../llm/llmClient.js'

// Phase 2 检索基建 · 任务 2.2：entry.md 按 heading 分块 + 分块向量路（parent-child 检索）。
// 语义：命中 child 块 → 返回 parent 词条（wiki_entries_meta.id），解决长词条整体向量稀释局部语义的问题。
// 嵌入能力复用现有封装：getEmbeddingConfig（config 键 ai.embedding）+ callEmbedding（OpenAI 兼容 /embeddings）；
// 向量存法与 file_embeddings 对齐 = JSON 文本（embedding TEXT）。
// 降级承诺：provider 未配置或单条调用失败一律优雅跳过（不抛错、不阻塞启动）——本地优先不绑厂商，向量路必须可缺席。

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
 * 纯空白内容不产生块；chunk_index 从 0 起按文档顺序递增。
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

/** 向量路总开关：config 键 search.vectorEnabled，缺省 true（db.ts seedDefaults 有同键种子） */
async function isVectorEnabled(db: SqliteDatabase): Promise<boolean> {
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'search.vectorEnabled'")).get() as any
  return row ? String(row.value) !== 'false' : true
}

export interface ChunkIndexStatus {
  /** 待处理条目数（调用开始时还没有任何块的词条数） */
  total: number
  /** 成功写入块（或无可索引块）的条目数 */
  indexed: number
  /** 单条失败跳过的条目数（不中断整体） */
  failed: number
  vectorEnabled: boolean
  reason: 'ok' | 'vector_disabled' | 'embedding_not_configured' | 'no_embedding_provider'
}

/**
 * 幂等回填入口：只为「尚无任何块」的词条分块嵌入，已有块的条目直接跳过（二次调用零嵌入调用）。
 * opts.embedFn 为测试注入点（伪造向量），注入时视为嵌入能力由调用方自证，跳过 provider 可用性检查。
 * 三层降级：总开关关闭 / 嵌入模型未配置 / provider 不可达 → 直接返回可查状态，不抛错；
 * 单条目嵌入或写库失败 → 计数跳过继续（部分失败不能拖垮整体回填）。
 */
export async function ensureChunksIndexed(
  db: SqliteDatabase,
  opts: { embedFn?: (text: string, cfg: EmbeddingConfig) => Promise<number[]> } = {}
): Promise<ChunkIndexStatus> {
  const pending = await (await db.prepare(`
    SELECT m.id, m.entry_path FROM wiki_entries_meta m
    WHERE NOT EXISTS (SELECT 1 FROM entry_chunks c WHERE c.entry_id = m.id)
  `)).all() as any[]
  const vectorEnabled = await isVectorEnabled(db)
  if (!vectorEnabled) {
    return { total: pending.length, indexed: 0, failed: 0, vectorEnabled: false, reason: 'vector_disabled' }
  }
  const cfg = await getEmbeddingConfig()
  const embedFn = opts.embedFn ?? null
  if (!embedFn) {
    if (!cfg.enabled || !cfg.model) {
      return { total: pending.length, indexed: 0, failed: 0, vectorEnabled: true, reason: 'embedding_not_configured' }
    }
    const providers = await getProviders()
    const provider = providers.find(p => p.name === cfg.provider) || providers.find(p => p.name === 'ollama')
    if (!provider?.baseUrl) {
      return { total: pending.length, indexed: 0, failed: 0, vectorEnabled: true, reason: 'no_embedding_provider' }
    }
  }
  const doEmbed = embedFn ?? callEmbedding
  let indexed = 0
  let failed = 0
  for (const entry of pending) {
    try {
      const md = await fs.readFile(String(entry.entry_path || ''), 'utf8')
      const chunks = chunkEntryMd(md)
      if (chunks.length === 0) {
        // 空文件/纯空白：无可索引块，视为处理完成（下次仍会重读跳过，量级可忽略）
        indexed++
        continue
      }
      // 嵌入文本带标题路径前缀：让块向量携带层级上下文（「清洗规则」在什么标题下语义不同）
      const vectors: number[][] = []
      for (const c of chunks) {
        const text = (c.heading_path ? c.heading_path + '\n' : '') + c.content
        vectors.push(await doEmbed(text, cfg))
      }
      // 先全部嵌入成功再事务写库：部分块失败时整条目不入库，保持「条目级全有或全无」的幂等语义
      await db.transactionalize(async () => {
        for (let i = 0; i < chunks.length; i++) {
          await (await db.prepare(`
            INSERT INTO entry_chunks (entry_id, chunk_index, heading_path, content, model, dim, embedding, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `)).run([
            Number(entry.id), chunks[i].chunk_index, chunks[i].heading_path, chunks[i].content,
            String(cfg.model || ''), vectors[i].length, JSON.stringify(vectors[i])
          ])
        }
      })
      indexed++
    } catch {
      failed++
    }
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
 * 分块向量检索：全量拉取向量做 JS 余弦（本地数千词条规模足够，与 searchEmbeddings 同模式），
 * 命中 child 块映射回 parent 词条，同词条取最高分块，按分数降序截 limit。
 */
export async function searchVector(db: SqliteDatabase, queryVector: number[], limit = 5): Promise<VectorHit[]> {
  const rows = await (await db.prepare(`
    SELECT c.entry_id, c.chunk_index, c.heading_path, c.content, c.embedding,
           m.title, m.summary, m.entry_path
    FROM entry_chunks c JOIN wiki_entries_meta m ON m.id = c.entry_id
    WHERE c.embedding IS NOT NULL
  `)).all() as any[]
  const best = new Map<number, VectorHit>()
  for (const r of rows) {
    try {
      const score = cosine(queryVector, JSON.parse(String(r.embedding)))
      if (score <= 0) continue
      const entryId = Number(r.entry_id)
      const prev = best.get(entryId)
      if (!prev || score > prev.score) {
        best.set(entryId, {
          entry_id: entryId,
          title: String(r.title || ''),
          summary: String(r.summary || ''),
          entry_path: String(r.entry_path || ''),
          score,
          chunk_index: Number(r.chunk_index),
          heading_path: String(r.heading_path || ''),
          snippet: String(r.content || '').slice(0, 160)
        })
      }
    } catch { /* 单条向量损坏跳过 */ }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
