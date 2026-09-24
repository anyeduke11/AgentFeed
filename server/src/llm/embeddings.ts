import { getDb } from '../db.js'
import { getProviders, type LlmProvider } from './llmClient.js'

export type ModelType = 'chat' | 'embedding'

/** 按模型名猜测用途：含 embed/bge/nomic/gte/minilm 视为向量模型，其余为对话模型 */
export function guessModelType(name: string): ModelType {
  return /embed|bge|nomic|gte|minilm/i.test(name) ? 'embedding' : 'chat'
}

/** 余弦相似度（零向量返回 0） */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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
  // 默认本地 Ollama 向量模型开启（2026-09-24 起）：蒸馏成功即自动向量化（llmWorker 成功路径 enqueueEmbed），
  // Ollama 服务与模型由 service.sh 随后端拉起；config 缺失/损坏时按开启兜底，闭环不因配置丢失静默断链
  const fallback: EmbeddingConfig = { enabled: true, provider: 'ollama', model: 'qwen3-embedding:4b' }
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

/* ---- L1 延迟治理：向量 BLOB 编解码（Float32 小端二进制） ----
 * WHY：向量原以 JSON TEXT 存储，54k chunks × 2560 维全量检索时逐行 JSON.parse 是搜索 28s 的主因
 * （文本体积 4-5× 于二进制 + 解析器开销）。BLOB 写入后读取是 Buffer 上的 Float32Array 零拷贝视图。
 * 双读兼容：存量 TEXT 行由 boot 迁移（vectorBlobMigrate）后台收敛，迁移完成前两种格式共存。 */
export function vecToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer, 0, vector.length * 4)
}

/** 双读：Buffer（BLOB，零拷贝视图）/ string（存量 JSON，解析）；损坏返回 null 由调用方跳过 */
export function storedVecToF32(raw: any): Float32Array | null {
  if (raw == null) return null
  if (Buffer.isBuffer(raw)) {
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
  }
  try {
    const arr = JSON.parse(String(raw))
    if (!Array.isArray(arr) || !arr.length) return null
    return Float32Array.from(arr)
  } catch { return null }
}

// 方案 B（2026-09-24）：file 级向量 API（upsertFileEmbedding / searchEmbeddings /
// countEmbeddings / embedFileById / setEmbedState / EmbeddingHit）随 file_embeddings
// DROP 整体移除——向量主路唯一为词条分块（search/chunkEmbed + P2 内存索引）。
// 本文件保留：cosine / vecToBlob / storedVecToF32（chunk 路复用）、getEmbeddingConfig、
// callEmbedding（查询向量化）、Ollama 探测族。
