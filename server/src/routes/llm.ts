import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from '../db.js'
import { llmQueue, embedQueue, enqueueEmbed, queueCapacity, recommendedConcurrency, refreshDistillNodes, updateDistillNode, checkNode } from '../llm/index.js'
import { nodesCacheSync, getHealth, pruneNodeOverrides } from '../llm/distillNodes.js'
import { getProviders, getDefaultModel, getDefaultProvider, mergeProvidersWithPresets } from '../llm/llmClient.js'
import { resetModelsInstance } from '../llm/index.js'
import { probeOllamaModels, getOllamaEnabledModels, getOllamaModelTypes, getEmbeddingConfig, callEmbedding, searchEmbeddings, countEmbeddings, guessModelType } from '../llm/embeddings.js'
import { readFileHead, getTriageBreakerState, resetTriageBreaker } from '../llm/llmWorker.js'

export const llmRouter = Router()

/** 队列四泳道明细：待处理 / 精炼中 / 失败 / 已跳过（文件维度） */
async function getQueueDetail() {
  const db = await getDb()
  const fetchByState = async (state: string) => {
    const stmt = await db.prepare(`
      SELECT f.id as fileId, f.title, f.name, f.source_agent as agent, f.file_mtime, f.ext, f.updated_at
      FROM files f WHERE f.llm_state = ? AND f.status = 'active'
      ORDER BY f.updated_at DESC LIMIT 100
    `)
    return await stmt.all(state) as any[]
  }
  const pending = await fetchByState('pending')
  const runningDb = await fetchByState('running')
  const failed = await fetchByState('failed')
  const skipped = await fetchByState('skipped')
  // 合并内存中运行任务实际调度到的节点（多模型节点池分流结果）
  const runningMetaMap = new Map(llmQueue.runningJobs.map(j => [j.fileId, j]))
  const running = runningDb.map(r => ({ ...r, ...(runningMetaMap.get(r.fileId) || {}) }))
  return {
    pending,
    running,
    failed,
    skipped,
    paused: llmQueue.isPaused,
    concurrency: llmQueue.concurrency,
    capacity: llmQueue.capacity,
    recommendedConcurrency: recommendedConcurrency(),
    providerConcurrency: llmQueue.providerConcurrencies,
    counts: { pending: pending.length, running: runningDb.length, failed: failed.length, skipped: skipped.length }
  }
}

llmRouter.get('/queue', async (req, res) => {
  res.json(await getQueueDetail())
})

llmRouter.post('/queue/pause', async (req, res) => {
  llmQueue.pause()
  res.json({ success: true, paused: true })
})

llmRouter.post('/queue/resume', async (req, res) => {
  llmQueue.resume()
  res.json({ success: true, paused: false })
})

llmRouter.post('/queue/concurrency', async (req, res) => {
  const { value, provider } = req.body as { value: number; provider?: string }
  if (provider) {
    // 按服务商设置并发限额（未配置的服务商跟随全局值）
    const n = Math.max(1, Math.min(queueCapacity(), parseInt(String(value)) || recommendedConcurrency()))
    llmQueue.setProviderConcurrency(provider, n)
    return res.json({ success: true, provider, concurrency: n })
  }
  const n = Math.max(1, Math.min(queueCapacity(), parseInt(String(value)) || recommendedConcurrency()))
  llmQueue.setConcurrency(n)
  res.json({ success: true, concurrency: n })
})

/** 蒸馏节点池视图：节点全集 + 健康状态（配置≠启用，enabled 由用户控制） */
llmRouter.get('/nodes', async (req, res) => {
  await refreshDistillNodes()
  const nodes = nodesCacheSync().map(n => ({
    ...n,
    health: getHealth(n.provider, n.model) || null,
    running: llmQueue.runningOf(n.provider),
  }))
  res.json({ nodes })
})

/** 更新节点配置：启用开关 / 并发份额（weight），即时生效 */
llmRouter.post('/nodes/update', async (req, res) => {
  const { provider, model, enabled, weight } = req.body as { provider: string; model: string; enabled?: boolean; weight?: number }
  if (!provider || !model) return res.json({ success: false, message: 'provider/model 必填' })
  const nodes = await updateDistillNode(provider, model, { enabled, weight })
  res.json({ success: true, nodes })
})

/** 手动存活检测：对启用节点（或指定节点）发起轻量 ping */
llmRouter.post('/nodes/check', async (req, res) => {
  const { provider, model } = req.body as { provider?: string; model?: string }
  const providers = await getProviders()
  const targets = nodesCacheSync().filter(n =>
    n.enabled && (!provider || (n.provider === provider && n.model === model)),
  )
  const results = [] as any[]
  for (const n of targets) {
    const p = providers.find(x => x.name === n.provider)
    if (!p) continue
    const h = await checkNode(p, n.model)
    results.push({ provider: n.provider, model: n.model, ...h })
  }
  llmQueue.kick()
  res.json({ success: true, results })
})

/** 失败/跳过任务重新入队 */
async function requeueFiles(db: any, fileIds: number[]) {
  const provider = await getDefaultProvider()
  const model = await getDefaultModel()
  let queued = 0
  for (const id of fileIds) {
    await db.exec(`UPDATE files SET llm_state = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ${id}`)
    llmQueue.enqueue({ fileId: id, provider, model, prompt: '' })
    queued++
  }
  return queued
}

llmRouter.post('/queue/retry', async (req, res) => {
  const db = await getDb()
  const { fileId } = req.body as { fileId: number }
  if (!fileId) return res.json({ success: false, message: 'fileId 必填' })
  const queued = await requeueFiles(db, [parseInt(String(fileId))])
  res.json({ success: true, queued })
})

llmRouter.post('/queue/retry-all', async (req, res) => {
  const db = await getDb()
  const rows = await (await db.prepare("SELECT id FROM files WHERE llm_state IN ('failed', 'skipped') AND status = 'active'")).all() as any[]
  const queued = await requeueFiles(db, rows.map(r => r.id))
  res.json({ success: true, queued })
})

llmRouter.post('/manual-tag', async (req, res) => {
  const db = await getDb()
  const { fileId, provider, model } = req.body as { fileId: number; provider?: string; model?: string }
  if (!fileId) {
    return res.json({ success: false, message: 'fileId 必填' })
  }
  const providerName = provider || await getDefaultProvider()
  const modelName = model || await getDefaultModel()
  await db.exec(`UPDATE files SET llm_state = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ${fileId}`)
  llmQueue.enqueue({ fileId, provider: providerName, model: modelName, prompt: '' })
  res.json({ success: true, queued: 1 })
})

llmRouter.get('/providers', async (req, res) => {
  const providers = mergeProvidersWithPresets(await getProviders())
  const defaultProvider = await getDefaultProvider()
  const defaultModel = await getDefaultModel()
  res.json({ providers, defaultProvider, defaultModel })
})

llmRouter.post('/providers', async (req, res) => {
  const db = await getDb()
  const { providers, defaultProvider, defaultModel } = req.body as {
    providers: Array<{ name: string; baseUrl: string; apiKey: string; models?: string[] }>
    defaultProvider?: string
    defaultModel?: string
  }
  if (!Array.isArray(providers)) {
    return res.json({ success: false, message: 'providers 必须是数组' })
  }
  const escapedProviders = JSON.stringify(providers).replace(/'/g, "''")
  await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('ai.providers', '${escapedProviders}', 'json', 'LLM providers 列表') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  if (defaultProvider !== undefined) {
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('ai.defaultProvider', '${String(defaultProvider).replace(/'/g, "''")}', 'string', '默认 LLM 服务商') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  }
  if (defaultModel !== undefined) {
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('ai.defaultModel', '${String(defaultModel).replace(/'/g, "''")}', 'string', '默认模型') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  }
  // 模型注册按新配置重建，立即生效；节点池随模型列表同步刷新
  resetModelsInstance()
  await refreshDistillNodes()
  res.json({ success: true })
})

/** 蒸馏池模型管理：整表替换某服务商的模型列表（增删改统一入口），联动节点池与默认模型 */
llmRouter.post('/providers/models', async (req, res) => {
  try {
  const { provider, models } = req.body as { provider?: string; models?: string[] }
  if (!provider || !Array.isArray(models) || !models.length || models.some(m => !String(m).trim())) {
    return res.json({ success: false, message: 'provider 与非空 models 数组必填' })
  }
  const db = await getDb()
  const providers = await getProviders()
  const p = providers.find(x => x.name === provider)
  if (!p) return res.json({ success: false, message: `服务商 ${provider} 不存在` })
  const cleaned = [...new Set(models.map(m => String(m).trim()))]
  p.models = cleaned
  const escaped = JSON.stringify(providers).replace(/'/g, "''")
  await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('ai.providers', '${escaped}', 'json', 'LLM providers 列表') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  // 默认模型被删除时回退到列表第一个，避免调度落空
  const dp = await getDefaultProvider()
  const dm = await getDefaultModel()
  if (dp === provider && dm && !cleaned.includes(dm)) {
    const m0 = cleaned[0].replace(/'/g, "''")
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('ai.defaultModel', '${m0}', 'string', '默认模型') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  }
  await pruneNodeOverrides(provider, cleaned)
  resetModelsInstance()
  await refreshDistillNodes()
  res.json({ success: true, models: cleaned })
  } catch (e: any) {
    res.json({ success: false, message: String(e?.message || e) })
  }
})

/** LLM 调用日志：关键词（provider/model/status/error/file_id）+ 状态过滤 + 分页 */
llmRouter.get('/logs', async (req, res) => {
  try {
    const db = await getDb()
    const { page = '1', limit = '50', kw = '', status = '' } = req.query as Record<string, string>
    let where = 'WHERE 1=1'
    const params: any[] = []
    if (kw) {
      where += ' AND (provider LIKE ? OR model LIKE ? OR status LIKE ? OR IFNULL(error, \'\') LIKE ? OR CAST(file_id AS TEXT) = ?)'
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, kw)
    }
    if (status) {
      where += ' AND status = ?'
      params.push(status)
    }
    const totalRow = await (await db.prepare(`SELECT COUNT(*) as cnt FROM llm_call_logs ${where}`)).get(params) as any
    const offset = (parseInt(page) - 1) * parseInt(limit)
    // LEFT JOIN files 带出文件名（title/alias/name 兜底），便于排错定位具体文件
    const rows = await (await db.prepare(`SELECT l.*, COALESCE(NULLIF(f.title, ''), NULLIF(f.alias, ''), f.name) AS file_name FROM llm_call_logs l LEFT JOIN files f ON l.file_id = f.id ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ${parseInt(limit)} OFFSET ${offset}`)).all(params) as any[]
    res.json({ items: rows, total: totalRow.cnt, page: parseInt(page), limit: parseInt(limit) })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** MCP 调用日志：tool/client 关键词搜索 */
llmRouter.get('/logs/mcp', async (req, res) => {
  try {
    const db = await getDb()
    const { limit = '200', kw = '' } = req.query as Record<string, string>
    let where = 'WHERE 1=1'
    const params: any[] = []
    if (kw) {
      where += ' AND (tool LIKE ? OR client LIKE ?)'
      params.push(`%${kw}%`, `%${kw}%`)
    }
    const totalRow = await (await db.prepare(`SELECT COUNT(*) as cnt FROM mcp_call_logs ${where}`)).get(params) as any
    const rows = await (await db.prepare(`SELECT * FROM mcp_call_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ${parseInt(limit)}`)).all(params) as any[]
    res.json({ items: rows, total: totalRow.cnt })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 服务运行日志：读项目根 .service.log 尾部（最多 1MB），支持关键词过滤 */
llmRouter.get('/logs/service', async (req, res) => {
  try {
    const { lines = '500', kw = '' } = req.query as Record<string, string>
    // service.sh 从 server/ 目录启动进程，项目根为其上级
    const logPath = path.resolve(process.cwd(), '..', '.service.log')
    let raw = ''
    try {
      const stat = await fs.stat(logPath)
      const size = Math.min(stat.size, 1024 * 1024)
      const fh = await fs.open(logPath, 'r')
      try {
        const buf = Buffer.alloc(size)
        await fh.read(buf, 0, size, Math.max(0, stat.size - size))
        raw = buf.toString('utf8')
      } finally {
        await fh.close()
      }
    } catch { /* 日志文件不存在时返回空列表 */ }
    let arr = raw.split('\n').filter(Boolean)
    // total = 读取窗口（≤1MB 尾部）内的总行数（过滤前）：徽标展示数量与列表「再往前没有更多」语义一致
    const total = arr.length
    arr = arr.slice(-parseInt(lines))
    if (kw) {
      const k = kw.toLowerCase()
      arr = arr.filter(l => l.toLowerCase().includes(k))
    }
    res.json({ items: arr, total, file: logPath })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 质量分补齐硬上限（PRD M3：≤200 篇 × ~200 token ≈ 4 万 token 一次性封顶） */
const QUALITY_BACKFILL_CAP = 200

/** 质量分补齐候选：已蒸馏但缺 quality_score；池内优先，其次策展候选序（rule_score/size） */
async function qualityBackfillCandidates(db: any, limit: number) {
  return await (await db.prepare(`
    SELECT f.id FROM files f
    JOIN wiki_entries_meta w ON w.file_id = f.id AND w.quality_score IS NULL
    LEFT JOIN recommendations r ON r.file_id = f.id
    WHERE f.status = 'active' AND f.llm_state = 'done'
    ORDER BY (r.id IS NOT NULL) DESC, COALESCE(f.rule_score, 0) DESC, COALESCE(f.size, 0) DESC
    LIMIT ${limit}`)).all() as any[]
}

async function seedBackfillConfig(db: any, total: number, done: number, failed: number) {
  const rows = [
    ['qualityBackfill.total', total],
    ['qualityBackfill.done', done],
    ['qualityBackfill.failed', failed]
  ]
  for (const [k, v] of rows) {
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('${k}', '${v}', 'number', '质量分补齐进度')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  }
}

async function readBackfillConfig(db: any) {
  const rows = await (await db.prepare("SELECT key, value FROM config WHERE key LIKE 'qualityBackfill.%'")).all() as any[]
  const m: Record<string, number> = {}
  for (const r of rows) m[r.key] = Number(r.value) || 0
  return { total: m['qualityBackfill.total'] || 0, done: m['qualityBackfill.done'] || 0, failed: m['qualityBackfill.failed'] || 0 }
}

/** 手动触发质量分补齐一批（≤200 篇，priority=0 与蒸馏同级不插队） */
llmRouter.post('/quality-backfill', async (req, res) => {
  try {
    const db = await getDb()
    const { total, done, failed } = await readBackfillConfig(db)
    if (total > done + failed) return res.json({ success: false, message: '上一批补齐仍在进行中，请稍候' })
    const providers = await getProviders()
    const model = await getDefaultModel()
    if (!providers.length || !model) return res.json({ success: false, message: '未配置 LLM，请先在设置里配置模型' })
    const providerName = await getDefaultProvider()
    const candidates = await qualityBackfillCandidates(db, QUALITY_BACKFILL_CAP)
    let enqueued = 0
    for (const c of candidates) {
      if (llmQueue.hasFile(c.id)) continue
      llmQueue.enqueue({ fileId: c.id, provider: providerName, model, prompt: '', options: { type: 'backfill' } })
      enqueued++
    }
    if (!enqueued) return res.json({ success: true, total: 0, message: '没有待补齐的已蒸馏文件' })
    await seedBackfillConfig(db, enqueued, 0, 0)
    res.json({ success: true, total: enqueued })
  } catch (e: any) {
    console.error('quality backfill trigger failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 质量分补齐进度（含剩余候选总量；重启中断时 done/failed 计数不再增长，以 remainingCandidates 为准） */
llmRouter.get('/quality-backfill', async (req, res) => {
  try {
    const db = await getDb()
    const { total, done, failed } = await readBackfillConfig(db)
    const remaining = await (await db.prepare(`
      SELECT COUNT(*) AS n FROM files f
      JOIN wiki_entries_meta w ON w.file_id = f.id AND w.quality_score IS NULL
      WHERE f.status = 'active' AND f.llm_state = 'done'`)).get() as any
    res.json({
      total, done, failed,
      pending: Math.max(0, total - done - failed),
      finished: total > 0 && done + failed >= total,
      remainingCandidates: remaining.n,
      queuePaused: llmQueue.isPaused
    })
  } catch (e: any) {
    console.error('quality backfill progress failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** json config 写入（value 更新，description 仅首次插入生效） */
async function setConfigJson(db: any, key: string, value: any, description: string) {
  const escapedKey = String(key).replace(/'/g, "''")
  const escapedValue = JSON.stringify(value).replace(/'/g, "''")
  const escapedDesc = String(description).replace(/'/g, "''")
  await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('${escapedKey}', '${escapedValue}', 'json', '${escapedDesc}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
}

/** 拉取云服务商在线模型列表（OpenAI 兼容 GET {baseUrl}/models，Bearer 鉴权）；body 可带表单中的 baseUrl/apiKey 覆盖已保存配置 */
llmRouter.post('/providers/:name/models', async (req, res) => {
  try {
    const name = String(req.params.name || '')
    const providers = await getProviders()
    const p = providers.find((x: any) => x.name === name)
    if (!p) return res.json({ online: false, models: [], message: `未知服务商 ${name}` })
    const baseUrl = String(req.body?.baseUrl || p.baseUrl || '').replace(/\/+$/, '')
    const apiKey = String(req.body?.apiKey || p.apiKey || '')
    if (!baseUrl) return res.json({ online: false, models: [], message: 'baseUrl 未配置' })
    const r = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return res.json({ online: false, models: [], message: `HTTP ${r.status}，请检查 baseUrl 与 API Key` })
    const data = await r.json() as any
    const models = (Array.isArray(data?.data) ? data.data : []).map((m: any) => String(m.id || m.name || '')).filter(Boolean).sort()
    res.json({ online: true, models })
  } catch (e: any) {
    res.json({ online: false, models: [], message: e?.name === 'TimeoutError' ? '请求超时（8s）' : String(e?.message || e) })
  }
})

/** 实时探测 Ollama 已装模型，合并启用状态与用途类型 */
llmRouter.get('/ollama/models', async (req, res) => {
  const [installed, enabled, types] = await Promise.all([probeOllamaModels(), getOllamaEnabledModels(), getOllamaModelTypes()])
  if (!installed) return res.json({ online: false, models: [] })
  const models = installed.map(id => ({ id, type: types[id] || guessModelType(id), enabled: enabled.includes(id) }))
  res.json({ online: true, models })
})

/** Ollama 模型启用/用途/向量化设置：写 3 个 config key，enabledModels 同步回 ai.providers 的 ollama.models */
llmRouter.post('/ollama/config', async (req, res) => {
  try {
    const db = await getDb()
    const { enabledModels, modelTypes, embedding } = req.body as {
      enabledModels?: string[]
      modelTypes?: Record<string, string>
      embedding?: { enabled?: boolean; model?: string }
    }
    if (!Array.isArray(enabledModels)) return res.json({ success: false, message: 'enabledModels 必须是数组' })
    const models = enabledModels.map(String)
    await setConfigJson(db, 'ai.ollama.enabledModels', models, 'Ollama 启用的模型列表')
    if (modelTypes && typeof modelTypes === 'object') {
      await setConfigJson(db, 'ai.ollama.modelTypes', modelTypes, 'Ollama 模型用途映射（chat/embedding）')
    }
    if (embedding && typeof embedding === 'object') {
      const prev = await getEmbeddingConfig()
      await setConfigJson(db, 'ai.embedding', {
        ...prev,
        enabled: !!embedding.enabled,
        model: String(embedding.model || ''),
      }, '蒸馏向量化配置')
    }
    // 启用的模型写回 ollama.models，注册进 modelsInstance（多模型同时可被调用）
    const providers = await getProviders()
    const idx = providers.findIndex((p: any) => p.name === 'ollama')
    if (idx >= 0) {
      providers[idx] = { ...providers[idx], models }
      await setConfigJson(db, 'ai.providers', providers, 'LLM providers 列表')
    }
    // 模型注册按新配置重建，立即生效
    resetModelsInstance()
    res.json({ success: true })
  } catch (e: any) {
    console.error('ollama config save failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 向量补齐硬上限（与质量分补齐同口径：≤200 篇一次性封顶） */
const EMBEDDINGS_BACKFILL_CAP = 200

/** 手动触发向量补齐一批：已入库（有标题或摘要）但缺向量的文件，入 embed 任务 */
llmRouter.post('/embeddings/backfill', async (req, res) => {
  try {
    const db = await getDb()
    const cfg = await getEmbeddingConfig()
    if (!cfg.enabled || !cfg.model) return res.json({ success: false, message: '请先开启向量化并选择向量模型' })
    const candidates = await (await db.prepare(`
      SELECT f.id FROM files f
      LEFT JOIN file_embeddings e ON e.file_id = f.id
      WHERE f.status = 'active' AND e.file_id IS NULL
        AND (COALESCE(f.title, '') != '' OR COALESCE(f.summary, '') != '')
      ORDER BY f.updated_at DESC LIMIT ${EMBEDDINGS_BACKFILL_CAP}`)).all() as any[]
    let enqueued = 0
    for (const c of candidates) {
      // enqueueEmbed 内部按文件去重（正在蒸馏/已排队向量化的跳过），投独立 embed 队列不占蒸馏并发
      if (enqueueEmbed(c.id)) enqueued++
    }
    if (!enqueued) return res.json({ success: true, total: 0, message: '没有待向量化的文件' })
    res.json({ success: true, total: enqueued })
  } catch (e: any) {
    console.error('embeddings backfill trigger failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 向量库状态：已向量化数 + 活跃文件中仍缺向量的数量 */
llmRouter.get('/embeddings/status', async (req, res) => {
  try {
    const db = await getDb()
    const embedded = await countEmbeddings()
    const row = await (await db.prepare(`
      SELECT COUNT(*) AS n FROM files f
      LEFT JOIN file_embeddings e ON e.file_id = f.id
      WHERE f.status = 'active' AND e.file_id IS NULL
        AND (COALESCE(f.title, '') != '' OR COALESCE(f.summary, '') != '')`)).get() as any
    const cfg = await getEmbeddingConfig()
    res.json({ embedded, remaining: Number(row?.n || 0), enabled: cfg.enabled, model: cfg.model, queuePending: embedQueue.pending, queueActive: embedQueue.active })
  } catch (e: any) {
    console.error('embeddings status failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 语义检索验证：query 向量化 → 全量余弦 → Top N */
llmRouter.post('/embeddings/search', async (req, res) => {
  try {
    const { query, topK } = req.body as { query?: string; topK?: number }
    const q = String(query || '').trim()
    if (!q) return res.json({ success: false, message: 'query 必填' })
    const cfg = await getEmbeddingConfig()
    if (!cfg.enabled || !cfg.model) return res.json({ success: false, message: '请先开启向量化并选择向量模型' })
    const vector = await callEmbedding(q, cfg)
    const hits = await searchEmbeddings(vector, Math.max(1, Math.min(20, parseInt(String(topK)) || 5)))
    res.json({ success: true, hits })
  } catch (e: any) {
    console.error('embeddings search failed', e)
    res.json({ success: false, message: String(e?.message || e) })
  }
})

/** triage 预算兜底：body 未带 budgetTokens 且 config 未配置时的一次性防爆仓上限 */
const TRIAGE_BUDGET_FALLBACK = 5_000_000

/** triage 预算上限：body.budgetTokens 优先，其次 config 键 llm.triageBudgetTokens，最后兜底常量 */
async function resolveTriageBudget(db: any, budgetTokens: unknown): Promise<number> {
  if (Number(budgetTokens) > 0) return Math.floor(Number(budgetTokens))
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'llm.triageBudgetTokens'")).get() as any
  if (row && Number(row.value) > 0) return Math.floor(Number(row.value))
  return TRIAGE_BUDGET_FALLBACK
}

/**
 * 按需精选入队（pull 模式）：从积压中按 rule_score 挑未蒸馏文件投蒸馏队列。
 * - 预算防爆仓：逐篇按文件头部字节/2 估 token，累计超限即停（当前这篇不入队）
 * - 幂等：llm_state='done'（已有成功蒸馏产物）的文件不进候选；已在队列/运行中的按文件去重跳过
 * - 熔断联动：连续失败熔断时拒绝新批次（resetTripped: true 可复位后继续）
 */
llmRouter.post('/triage-distill', async (req, res) => {
  try {
    const db = await getDb()
    const { domains, limit, budgetTokens, resetTripped } = req.body || {}
    const breaker = getTriageBreakerState()
    if (breaker.tripped && !resetTripped) {
      return res.json({
        success: false, tripped: true, enqueued: 0, skipped: 0, budgetUsedTokens: 0,
        message: `蒸馏熔断中（triage 批次已连续失败 ${breaker.consecutiveFailures} 次），已暂停消费；确认恢复后带 resetTripped: true 重试`
      })
    }
    if (resetTripped) resetTriageBreaker()
    const maxTokens = await resolveTriageBudget(db, budgetTokens)
    // limit 语义 = 入队总数上限：未传默认 500；显式传值必须是正整数，否则 400 拒绝
    // （旧逻辑 parseInt('0')=0 为 falsy 静默回退 500，曾把无意义的 limit:0 放大成真实入队）
    let lim = 500
    if (limit !== undefined) {
      const n = Number(limit)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        return res.status(400).json({ success: false, error: 'limit 必须为正整数' })
      }
      lim = n
    }
    // 候选：active + 有内容（size>0，库内无 content 列以体积为证）+ 未成功蒸馏（llm_state != 'done'）
    let where = "f.status = 'active' AND f.llm_state != 'done' AND COALESCE(f.size, 0) > 0"
    const params: any[] = []
    if (Array.isArray(domains) && domains.length) {
      where += ` AND d.name IN (${domains.map(() => '?').join(', ')})`
      params.push(...domains.map(String))
    }
    const candidates = await (await db.prepare(`
      SELECT f.id, f.path FROM files f
      LEFT JOIN domains d ON f.domain_id = d.id
      WHERE ${where}
      ORDER BY COALESCE(f.rule_score, 0) DESC, f.id ASC
      LIMIT ${lim}`)).all(params) as any[]
    const provider = await getDefaultProvider()
    const model = await getDefaultModel()
    let budgetUsed = 0
    let enqueued = 0
    for (const c of candidates) {
      // 队列去重：同一文件已在内存队列/运行中时不重复投递（与 quality-backfill 同口径）
      if (llmQueue.hasFile(c.id)) continue
      // 与蒸馏同一截断口径（512KB 头部）估 token，避免「按整文件估」把大文件全部挡在预算外
      const head = await readFileHead(c.path)
      const tokens = Math.ceil(head.length / 2)
      // 预算耗尽即停：当前这篇不入队，剩余候选一并计入 skipped
      if (budgetUsed + tokens > maxTokens) break
      budgetUsed += tokens
      llmQueue.enqueue({ fileId: c.id, provider, model, prompt: '', options: { origin: 'triage' } })
      enqueued++
    }
    res.json({ success: true, enqueued, skipped: candidates.length - enqueued, budgetUsedTokens: budgetUsed })
  } catch (e: any) {
    console.error('triage-distill trigger failed', e)
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})
