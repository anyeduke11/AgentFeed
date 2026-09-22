import os from 'os'
import { getDb } from '../db.js'
import { createModels, createProvider, envApiKeyAuth, type Context, type Model, type ImageContent } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { getProviders, getDefaultModel, getModels, getDefaultProvider, type LlmProvider } from './llmClient.js'
import { LlmQueue } from './llmQueue.js'
import { processJob } from './llmWorker.js'
import { enforceDailyBudget } from './budgetGate.js'

export interface WikiDraft {
  title: string
  summary: string
  entities: string[]
  relations: Array<{ from: string; to: string; rel?: string }>
}

let modelsInstance: ReturnType<typeof createModels> | null = null

/** 保存服务商配置后调用，使新配置立即生效（下次调用 getModelsInstance 重建） */
export function resetModelsInstance() {
  modelsInstance = null
}

function ensureModelDef(provider: LlmProvider, modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: provider.name,
    baseUrl: provider.baseUrl,
    reasoning: false,
    // 视觉模型需声明 image input，否则 pi-ai transformMessages 会把图块降级为占位文本
    input: supportsVision(modelId) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  }
}

export async function getModelsInstance(): Promise<ReturnType<typeof createModels>> {
  if (modelsInstance) return modelsInstance
  const providersList = await getProviders()
  const globalModels = await getModels()
  const instance = createModels()
  for (const provider of providersList) {
    // per-provider 模型：provider.models 优先，缺省回退全局 ai.models（兼容存量配置）
    const modelIds = provider.models?.length ? provider.models : globalModels
    if (!modelIds.length) continue
    const defs = modelIds.map(id => ensureModelDef(provider, id))
    const p = createProvider({
      id: provider.name,
      name: provider.name,
      baseUrl: provider.baseUrl,
      auth: { apiKey: envApiKeyAuth(`${provider.name} API Key`, [`${provider.name.toUpperCase()}_API_KEY`]) },
      models: defs,
      api: openAICompletionsApi(),
    })
    instance.setProvider(p)
  }
  modelsInstance = instance
  return instance
}

/** 随消息发送的图片（base64，不带 data: 前缀——pi-ai 序列化时拼接） */
export interface LlmImage { data: string; mimeType: string }

/** 模型名含视觉关键词才随消息发图（文本模型收到 image_url 会被服务端 400 拒绝） */
export function supportsVision(modelId: string): boolean {
  return /ocr|vision|image|(^|[-_.])vl($|[-_.\d])/i.test(modelId)
}

export async function callLlm(providerName: string, modelId: string, prompt: string, apiKey?: string, images?: LlmImage[]): Promise<{ text: string; usage?: { input?: number; output?: number } }> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.providers'")).get() as any
  const providers: LlmProvider[] = row?.value ? JSON.parse(row.value) : []
  const provider = providers.find(p => p.name === providerName) || providers[0]
  if (!provider) throw new Error('no_llm_provider')
  const instance = await getModelsInstance()
  const model = instance.getModel(provider.name, modelId) || instance.getModel(provider.name, ensureModelDef(provider, modelId).id)
  if (!model) throw new Error('model_not_found')
  // 有图时 content 用数组（pi-ai 将 ImageContent 序列化为 image_url data URL），纯文本保持 string
  const userContent: string | Array<{ type: 'text'; text: string } | ImageContent> = images?.length
    ? [{ type: 'text', text: prompt }, ...images.map(i => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))]
    : prompt
  const context: Context = {
    systemPrompt: 'You are a helpful assistant that outputs only JSON when asked.',
    messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
  }
  const attempt = () => instance.completeSimple(model, context, {
    apiKey: apiKey || provider.apiKey,
    reasoning: 'low',
    // SenseNova 结构化输出（response_format=json_object）：强制模型输出合法 JSON，治理 llm_output_not_json 失败
    // 文档要求 prompt 中含 json 关键字——systemPrompt「outputs only JSON」已满足
    samplingParams: {
      response_format: { type: 'json_object' },
      // H1 修法④（2026-09-22 治愈验证复现）：pi-ai 不传 maxTokens 时请求体不带 max_tokens，
      // SenseNova 网关按自家默认上限（实测 ~250 tokens）硬掐输出——形态 A「无闭合 } 截断」的
      // 物理根源即此。蒸馏产物（title+summary+points+entities+relations）按输出预算上限
      // 约 1500 tokens，给 4096 余量防掐断。
      maxTokens: 4096,
    },
    // 网络层快速重试（0.5-2s 退避）：覆盖 408/409/5xx 瞬时错误，尊重 retry-after 响应头
    maxRetries: 4,
  })
  // pi-ai 遇到流式 429 时不抛异常，静默返回 stopReason=error 的空响应——若不处理，空文本会被上层误报为 llm_output_not_json
  let response = await attempt()
  // 应用层慢速重试：SenseNova RPM/TPM 积分池为分钟级窗口，pi-ai 内置短退避（最长 2s）跨不过去，按 15s/30s 退避重试
  for (let i = 0; i < 2 && response.stopReason === 'error' && /429|rate.?limit|tpm|rpm/i.test(String((response as any).errorMessage)); i++) {
    await new Promise(r => setTimeout(r, 15000 * (i + 1)))
    response = await attempt()
  }
  if (response.stopReason === 'error') {
    // 抛出真实错误（如 429 限流原文），由 friendlyLlmError 翻译后落库，便于排错
    throw new Error(String((response as any).errorMessage || 'empty_llm_response'))
  }
  const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('')
  return {
    text,
    usage: {
      input: (response.usage as any)?.input ?? undefined,
      output: (response.usage as any)?.output ?? undefined,
    },
  }
}

// G1 日预算闸：入队即 fire-and-forget 巡检（30s 节流——feeder 批量入队会连续触发，当日聚合无需逐次重算），不阻塞入队
let lastBudgetCheckAt = 0
const llmQueue = new LlmQueue(recommendedConcurrency(), {
  onProgress: (_job, state) => {
    console.log(`llm job ${_job.id} ${state}`)
    if (state === 'queued' && Date.now() - lastBudgetCheckAt >= 30 * 1000) {
      lastBudgetCheckAt = Date.now()
      void enforceDailyBudget(llmQueue).catch(() => { /* 预算巡检失败不影响入队 */ })
    }
  },
}, queueCapacity())

/**
 * 队列并发按机器性能动态计算：
 * - 上限 = CPU 核数收敛到 [4, 8]：蒸馏是 IO 等待型任务，CPU 占用低，机器性能决定用户可调上限，用户可手动拉高自担限流风险
 * - 推荐 = 固定 2：实测 SenseNova RPM 积分池限流是主导约束（并发 5 时 2 分钟 34 次调用 91% 失败，429 rpm exhausted），接口限制而非机器性能决定推荐值
 */
export function queueCapacity(): number {
  const cores = os.cpus().length
  return Math.min(8, Math.max(4, cores))
}

export function recommendedConcurrency(): number {
  return 2
}

/**
 * 各服务商推荐并发：按接口限流宽松度区分。
 * - agnes：实测 24 并发瞬时零失败，限流宽松，可高吞吐
 * - sensenova 等：RPM 积分池限流脆弱，保守 2
 */
export function recommendedProviderConcurrency(provider: string): number {
  return provider === 'agnes' ? Math.min(6, queueCapacity()) : recommendedConcurrency()
}

// 按推荐值初始化各预设服务商的并发限额（用户可在设置页按服务商调整）
for (const p of ['sensenova', 'agnes', 'xfyun']) {
  llmQueue.setProviderConcurrency(p, recommendedProviderConcurrency(p))
}

// ---- 多模型并行蒸馏节点池：出队调度 + 存活检测 ----
import { refreshNodesCache, createNodeDispatcher, startNodeHealthLoop, updateNode as updateNodeCfg, nodesCacheSync, checkNode, type DistillNode } from './distillNodes.js'

// 蒸馏任务出队时由节点池分配 provider/model（启用+健康+份额未满的节点，默认模型优先，负载按 weight 摊薄）
llmQueue.setDispatcher(createNodeDispatcher({
  providerRunning: p => llmQueue.runningOf(p),
  providerLimitOf: p => llmQueue.providerLimit(p),
  kick: () => llmQueue.kick(),
}))

/** 手动/配置变更后刷新节点缓存并唤醒调度（增量生效，无需重启） */
export async function refreshDistillNodes(): Promise<DistillNode[]> {
  const nodes = await refreshNodesCache(recommendedProviderConcurrency)
  llmQueue.kick()
  return nodes
}

/** 更新节点配置（启用开关/并发份额），即时生效 */
export async function updateDistillNode(provider: string, model: string, patch: { enabled?: boolean; weight?: number }): Promise<DistillNode[]> {
  return updateNodeCfg(provider, model, patch, recommendedProviderConcurrency)
}

/** 启动节点健康循环：每 60s 探测启用节点，恢复健康即唤醒队列补位 */
export function startNodeHealthMonitor() {
  startNodeHealthLoop(recommendedProviderConcurrency, () => llmQueue.kick())
}

export { nodesCacheSync, checkNode }

llmQueue.setExecutor(async (job) => {
  await processJob(job)
})

/**
 * embed 独立队列：向量化（本地 Ollama）与蒸馏（远程 LLM）并行互不占位。
 * 并发 1 串行打本地模型，避免多篇同时向量化自相争抢；蒸馏后的自动向量化与「补向量」都走这里。
 */
export const embedQueue = new LlmQueue(1)
embedQueue.setExecutor(async (job) => {
  // 瞬时失败自动重试（Ollama 冷启动 / 连接抖动）：最多 3 次，间隔 5s / 15s
  for (let attempt = 1; ; attempt++) {
    try {
      await processJob(job)
      return
    } catch (e: any) {
      if (attempt >= 3) {
        console.error(`embed job file ${job.fileId} failed after ${attempt} attempts:`, String(e?.message || e))
        throw e
      }
      await new Promise(r => setTimeout(r, attempt === 1 ? 5000 : 15000))
    }
  }
})

/** 投递一个向量补齐任务（按文件去重；正在蒸馏或已排队向量化的文件跳过） */
export function enqueueEmbed(fileId: number): boolean {
  if (llmQueue.hasFile(fileId) || embedQueue.hasFile(fileId)) return false
  embedQueue.enqueue({ fileId, provider: 'ollama', model: '', prompt: '', options: { type: 'embed' } })
  return true
}

/** 内存队列水位：低于此值时从 DB 补充 pending 任务 */
const FEED_WATERMARK = 8
/** 每次从 DB 补充的任务数 */
const FEED_BATCH = 16

/**
 * DB 驱动的队列调度器：周期性把 llm_state='pending' 的文件喂入内存队列。
 * - 重启自动恢复（DB 是持久真相，内存队列只是工作集）
 * - 尊重 ai.autoTag 开关（关闭时不自动入队，手动端点仍可用）
 * - 尊重队列暂停；水位控制避免数万任务驻留内存
 */
export async function startLlmFeeder() {
  const db = await getDb()
  // 节点池初始化：从服务商配置派生节点 + 启动存活检测循环（启用节点恢复健康后自动唤醒队列）
  await refreshDistillNodes()
  startNodeHealthMonitor()
  // 重启恢复：上次进程中断遗留的 running 复位为 pending（内存队列重启后必为空，DB 是持久真相），
  // 否则这些文件会永远停留在「编目中」，与实际运行状态不一致
  await db.exec(`UPDATE files SET llm_state = 'pending', updated_at = CURRENT_TIMESTAMP WHERE llm_state = 'running'`)
  const tick = async () => {
    try {
      if (llmQueue.isPaused || llmQueue.pending >= FEED_WATERMARK) return
      const cfgRow = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.autoTag'")).get() as any
      if (cfgRow && cfgRow.value !== 'true') return
      const provider = await getDefaultProvider()
      const model = await getDefaultModel()
      const rows = await (await db.prepare(`
        SELECT id FROM files
        WHERE llm_state = 'pending' AND status = 'active'
        ORDER BY updated_at ASC LIMIT ${FEED_BATCH}
      `)).all() as any[]
      let fed = 0
      for (const r of rows) {
        if (llmQueue.hasFile(r.id)) continue
        llmQueue.enqueue({ fileId: r.id, provider, model, prompt: '' })
        fed++
      }
      if (fed > 0) console.log(`llm feeder: +${fed} jobs (queue=${llmQueue.pending})`)
    } catch (e: any) {
      console.error('llm feeder error:', String(e?.message || e))
    }
  }
  await tick()
  setInterval(tick, 3000)
}

export { llmQueue }
