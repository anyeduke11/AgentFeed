import { getDb } from '../db.js'
import { getProviders, type LlmProvider } from './llmClient.js'

export type ModelType = 'chat' | 'embedding'

/** 按模型名猜测用途：含 embed/bge/nomic/gte/minilm 视为向量模型，其余为对话模型 */
export function guessModelType(name: string): ModelType {
  return /embed|bge|nomic|gte|minilm/i.test(name) ? 'embedding' : 'chat'
}

/** 余弦相似度（零向量返回 0） */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function trimBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '')
}

export function getOllamaProvider(providers?: LlmProvider[]): LlmProvider | null {
  const list = providers || []
  return list.find(p => p.name === 'ollama') || null
}

/** 实时探测 Ollama 已安装模型（GET {baseUrl}/models，OpenAI 兼容）；离线/超时返回 null 由调用方区分 */
export async function probeOllamaModels(timeoutMs = 2500): Promise<string[] | null> {
  const provider = getOllamaProvider(await getProviders())
  if (!provider?.baseUrl) return null
  try {
    const res = await fetch(`${trimBaseUrl(provider.baseUrl)}/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = await res.json() as any
    return (data?.data || []).map((m: any) => String(m.id)).filter(Boolean)
  } catch {
    return null
  }
}

export async function getOllamaEnabledModels(): Promise<string[]> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.ollama.enabledModels'")).get() as any
  try {
    const v = JSON.parse(row?.value || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export async function getOllamaModelTypes(): Promise<Record<string, ModelType>> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.ollama.modelTypes'")).get() as any
  try {
    return JSON.parse(row?.value || '{}') || {}
  } catch {
    return {}
  }
}

export interface EmbeddingConfig {
  enabled: boolean
  provider: string
  model: string
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.embedding'")).get() as any
  const fallback: EmbeddingConfig = { enabled: false, provider: 'ollama', model: '' }
  try {
    return { ...fallback, ...JSON.parse(row?.value || '{}') }
  } catch {
    return fallback
  }
}

/** 直连 OpenAI 兼容 /embeddings 端点（不走 pi-ai；Bearer 认证可选，30s 超时） */
export async function callEmbedding(text: string, cfg?: EmbeddingConfig): Promise<number[]> {
  const config = cfg || await getEmbeddingConfig()
  const providers = await getProviders()
  const provider = providers.find(p => p.name === config.provider) || getOllamaProvider(providers)
  if (!provider?.baseUrl) throw new Error('no_embedding_provider')
  if (!config.model) throw new Error('no_embedding_model')
  const res = await fetch(`${trimBaseUrl(provider.baseUrl)}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input: text }),
    // 120s：本地模型首次冷加载可能远超常规推理耗时（实测 2.5GB 模型约 50s）
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`embedding_http_${res.status}`)
  const data = await res.json() as any
  const vec = data?.data?.[0]?.embedding
  if (!Array.isArray(vec) || !vec.length) throw new Error('embedding_empty_response')
  return vec.map(Number)
}

export async function upsertFileEmbedding(db: any, fileId: number, model: string, vector: number[]): Promise<void> {
  const stmt = await db.prepare(`
    INSERT INTO file_embeddings (file_id, model, dim, vector, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, updated_at = CURRENT_TIMESTAMP
  `)
  // 注意：@homeofthings/sqlite3 的 run 多参数须包数组传（见 wiki.ts 既有用法）
  await stmt.run([fileId, model, vector.length, JSON.stringify(vector)])
}

export interface EmbeddingHit {
  file_id: number
  title: string
  path: string
  score: number
}

/** 全量拉取向量做 JS 余弦检索（本地数千篇规模足够），只统计 active 文件 */
export async function searchEmbeddings(queryVector: number[], topK = 5): Promise<EmbeddingHit[]> {
  const db = await getDb()
  const rows = await (await db.prepare(`
    SELECT e.file_id, e.vector, COALESCE(f.title, f.name) AS title, f.path
    FROM file_embeddings e JOIN files f ON f.id = e.file_id
    WHERE f.status = 'active'
  `)).all() as any[]
  const hits: EmbeddingHit[] = []
  for (const r of rows) {
    try {
      const vec = JSON.parse(r.vector)
      const score = cosine(queryVector, vec)
      if (score > 0) hits.push({ file_id: r.file_id, title: r.title, path: r.path, score })
    } catch { /* 单条向量损坏跳过 */ }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

/** 已向量化文件数 */
export async function countEmbeddings(): Promise<number> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT COUNT(*) AS n FROM file_embeddings')).get() as any
  return Number(row?.n || 0)
}

/** 单篇向量化：取 title+summary 拼接文本 → callEmbedding → upsert（cfg 缺省自动读取配置） */
export async function embedFileById(db: any, fileId: number, cfg?: EmbeddingConfig): Promise<{ model: string; dim: number }> {
  const config = cfg || await getEmbeddingConfig()
  const row = await (await db.prepare("SELECT COALESCE(NULLIF(title, ''), name) AS title, COALESCE(summary, '') AS summary FROM files WHERE id = ?")).get(fileId) as any
  if (!row) throw new Error('file_not_found')
  const text = `${row.title}\n${row.summary}`.replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('no_valid_content')
  const vector = await callEmbedding(text, config)
  await upsertFileEmbedding(db, fileId, config.model, vector)
  return { model: config.model, dim: vector.length }
}
