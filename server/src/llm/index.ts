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

export async function callLlm(providerName: string, modelId: string, prompt: string, apiKey?: string, images?: LlmImage[]): Promise<{ text: string; usage?: { input?: number; output?: number }; stopReason?: string }> {
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
      // 约 1500 tokens，2048 已足够且给 8K 窗口输入侧多让 2K tokens（旧 4096 是压缩预算
      // 超窗的共因之一）；仍显著高于网关默认 250，防掐断语义保留。
      maxTokens: 2048,
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
  // 配套修复①（2026-09-22 残留 12%）：混合推理模型（flash-lite 级）偶发全程走思考通道——
  // reasoning_content 增量被 pi-ai 收进独立 thinking 块不进 text 块（openai-completions.js 适配器行为），
  // 网关把 reasoning tokens 计入 usage.output，于是「output 计数正常但 text 为空」，上层误报
  // llm_output_not_json。text 为空时回捞 thinking 文本——思考链内常含完整 JSON，走同一条提取路径。
  const extractText = (r: typeof response): string => {
    let t = r.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    if (!t.trim()) t = r.content.map(b => (b.type === 'thinking' ? b.thinking : '')).join('')
    return t
  }
  let text = extractText(response)
  // 配套修复②：空响应非确定性（重放同文件可成功）——原样重试 1 次；再空则报 empty_llm_response，
  // 与 not_json 区分开（归因报告 §7 残留画像两类混杂即此因）
  if (!text.trim()) {
    response = await attempt()
    text = extractText(response)
  }
  if (!text.trim()) {
    throw new Error('empty_llm_response')
  }
  return {
    text,
    usage: {
      input: (response.usage as any)?.input ?? undefined,
      output: (response.usage as any)?.output ?? undefined,
    },
    // 配套修复③：落库网关 finish_reason 原文（length/stop/...），供后续失败分桶区分截断/拒答形态
    stopReason: String((response as any).rawStopReason || response.stopReason || ''),
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
 * 方案 B（2026-09-24 向量冗余收敛·彻底）：file 级向量链路（embedQueue / enqueueEmbed /
 * sweepEmbedBacklog / processEmbed）整体移除——file_embeddings 已 DROP，检索主路唯一为
 * 词条分块向量（蒸馏自动 indexWikiChunks + wiki 面板手动补嵌 + P2 内存索引）。
 * 历史契约见 embedState.test.ts（已随链路废止移除）。
 */

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
        SELECT f.id FROM files f
        ${CONSUMPTION_ORDER_SQL}
        WHERE f.llm_state = 'pending' AND f.status = 'active'
        ORDER BY (rh.last_read IS NOT NULL) DESC, rh.last_read DESC, f.updated_at ASC
        LIMIT ${FEED_BATCH}
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

/** M3 消费反哺生产：被 read_history 记录过的文件（任何出口：阅读/检索命中）蒸馏时最优先，
 *  按最近消费时间降序；从未消费的按 updated_at 兜底。语义是「消费过的先补」而非「零消费不补」——
 *  生产预算有限时，已被证明有人要的知识先获得向量能力。sweeper 与手动补向量（llm.ts）保持同序。 */
export const CONSUMPTION_ORDER_SQL = `
  LEFT JOIN (SELECT file_id, MAX(opened_at) AS last_read FROM read_history WHERE file_id IS NOT NULL GROUP BY file_id) rh ON rh.file_id = f.id`

export const CONSUMPTION_PRIORITY_ORDER = `(rh.last_read IS NOT NULL) DESC, rh.last_read DESC, f.updated_at DESC`

export { llmQueue }
