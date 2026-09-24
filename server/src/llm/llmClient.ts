import { getDb } from '../db.js'
import type { SqliteDatabase } from '@homeofthings/sqlite3'

export interface LlmProvider {
  name: string
  baseUrl: string
  apiKey: string
  /** 该服务商可用模型（缺省回退全局 ai.models，兼容存量配置） */
  models?: string[]
}

/** 常见国内模型服务商 + Ollama 本地接入预设（均为 OpenAI 兼容接口） */
export const PROVIDER_PRESETS: LlmProvider[] = [
  { name: 'sensenova', baseUrl: 'https://token.sensenova.cn/v1', apiKey: '', models: ['sensenova-6.8-flash-lite'] },
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-v4-flash'] },
  { name: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['glm-5.2', 'glm-4.7', 'glm-4.7-flash'] },
  { name: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '', models: ['kimi-k3', 'kimi-latest', 'moonshot-v1-8k'] },
  { name: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  // 讯飞 MaaS：OpenAI 兼容（Bearer APIKey）。ModelID 为用户在「服务管控」页部署服务后专属，无法预设，由用户在设置页填写
  { name: 'xfyun', baseUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2', apiKey: '', models: [] },
  // Agnes AI：OpenAI 兼容（https://www.agnes-ai.com/zh-Hans/docs）
  { name: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: '', models: ['agnes-2.5-flash', 'agnes-3.0-flash', 'agnes-2.5-pro', 'agnes-2.5-pro-beta'] },
  { name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', models: ['qwen2.5', 'llama3.1', 'deepseek-r1'] },
]

/** 用户配置与预设合并：预设补缺，用户已配置条目原样保留（models 用户优先，空则回退预设） */
export function mergeProvidersWithPresets(configured: LlmProvider[]): LlmProvider[] {
  const byName = new Map(configured.map(p => [p.name, p]))
  return PROVIDER_PRESETS.map(preset => {
    const c = byName.get(preset.name)
    if (!c) return { ...preset }
    return { ...preset, ...c, models: c.models?.length ? c.models : preset.models }
  })
}

/** 默认服务商：读 ai.defaultProvider，未设置时回退第一个已配置服务商 */
export async function getDefaultProvider(): Promise<string> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.defaultProvider'")).get() as any
  if (row?.value) return row.value
  const providers = await getProviders()
  return providers[0]?.name || ''
}

export interface LlmCallLog {
  file_id?: number | null
  provider: string
  model: string
  prompt_tokens?: number | null
  completion_tokens?: number | null
  total_tokens?: number | null
  duration_ms?: number | null
  status: 'success' | 'failed' | 'timeout' | 'rate_limited'
  error?: string | null
  /** 网关 finish_reason 原文（length/stop/...）：失败分桶区分截断与拒答形态（配套修复③） */
  stop_reason?: string | null
}

export async function getProviders(): Promise<LlmProvider[]> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.providers'")).get() as any
  if (!row) return []
  try {
    return JSON.parse(row.value)
  } catch {
    return []
  }
}

export async function getDefaultModel(): Promise<string> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.defaultModel'")).get() as any
  return row?.value || ''
}

export async function getModels(): Promise<string[]> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.models'")).get() as any
  if (!row) return []
  try {
    return JSON.parse(row.value)
  } catch {
    return []
  }
}

/** SenseNova（OpenAI 兼容）统一错误码 → 中文说明，参考 https://platform.sensenova.cn/docs 错误码章节 */
const PROVIDER_ERROR_HINTS: Array<{ type?: string; status?: number; hint: string }> = [
  { type: 'invalid_request_error', status: 400, hint: '请求参数不合法（缺失、超范围、格式错误等），检查模型 ID 与请求参数' },
  { type: 'failed_precondition_error', hint: '前置条件不满足（编码失败、引擎不可用、安全检查未通过）' },
  { type: 'permission_denied_error', status: 403, hint: '无权限：API Key 无效/欠费，或该请求语言不受支持' },
  { type: 'not_found_error', status: 404, hint: '模型 ID 不存在或已下线，可在 设置 → AI 设置 → 服务商 行刷新模型列表' },
  { type: 'canceled_error', status: 408, hint: '请求被取消' },
  { type: 'quota_exceeded_error', status: 429, hint: '速率/额度超限（积分不足或请求过频），建议稍后在精炼线一键重试' },
  { type: 'rate_limit_error', status: 429, hint: '速率超限（TPM/RPM 每分钟令牌/请求数超限），系统已按 15s/30s 退避自动重试' },
  { type: 'internal_server_error', status: 500, hint: '服务端内部错误，可稍后重试' },
]

/**
 * 内部错误码（非服务商 HTTP 错误，来自 callLlm / 蒸馏工人 / 治理链路）→ 中文说明。
 * 与 PROVIDER_ERROR_HINTS 一同落库，前端按结构渲染，用户不必再猜 llm_output_not_json 是什么。
 */
const INTERNAL_ERROR_HINTS: Array<{ code: string; hint: string }> = [
  { code: 'llm_output_not_json', hint: '模型没有按约定返回 JSON（flash 级模型偶发输出截断或格式漂移），系统已强制 json_object 模式，重试通常可恢复' },
  { code: 'content_too_long_for_model', hint: '内容超过模型上下文窗口：系统已自动压缩重试一次仍超限，建议换更大窗口的默认模型，或在 设置 → AI 设置 调整 ai.modelContextTokens' },
  { code: 'llm_json_parse_failed', hint: '模型输出无法解析为 JSON（多为长输出被截断），可减小批次大小或重试' },
  { code: 'empty_llm_response', hint: '模型返回空响应（流式通道偶发），重试通常可恢复' },
  { code: 'no_llm_provider', hint: '未配置可用的 LLM 服务商，请在 设置 → AI 设置 添加服务商并填入 API Key' },
  { code: 'model_not_found', hint: '模型不存在，可在 设置 → AI 设置 → 服务商 行刷新模型列表后重试' },
]

/**
 * 把服务商 HTTP 错误（形如 `429: {"error":{"type":"quota_exceeded_error","message":"..."}}`，pi-ai formatProviderError 产物）
 * 或内部错误码（llm_output_not_json 等）翻译为结构化 JSON 信封落库：
 * { kind: 'provider'|'internal', code, status?, message?, hint, raw? }
 * 前端解析后分行渲染「错误码 / HTTP 状态 / 说明 / 服务端消息 / 原始响应」；无法结构化的保留纯文本（兼容旧行）。
 */
export function friendlyLlmError(raw: unknown): string {
  let text = String(raw ?? '').trim()
  if (!text) return ''
  let status: number | undefined
  const m = text.match(/^(\d{3}):\s*/)
  if (m) {
    status = parseInt(m[1], 10)
    text = text.slice(m[0].length).trim()
  }
  let type = ''
  let serverMsg = ''
  try {
    const obj = JSON.parse(text)
    const err = obj && typeof obj.error === 'object' && obj.error !== null ? obj.error : obj
    type = String(err?.type || err?.code || '')
    serverMsg = String(err?.message || '')
  } catch { /* body 非 JSON（如连接错误），保留原文 */ }
  const hit = PROVIDER_ERROR_HINTS.find(h => (h.type && type === h.type) || (h.status !== undefined && h.status === status && !type))
  if (hit || type || serverMsg) {
    return JSON.stringify({
      kind: 'provider',
      code: type || `http_${status}`,
      status,
      message: serverMsg || undefined,
      hint: hit?.hint || '服务商返回了未分类错误，见服务端消息或原始响应',
      raw: text.length > 500 ? text.slice(0, 500) + '…' : undefined,
    })
  }
  // 内部错误码：llm_output_not_json / llm_json_parse_failed: …（允许带明细后缀）
  const iHit = INTERNAL_ERROR_HINTS.find(h => text === h.code || text.startsWith(h.code + ':') || text.startsWith(h.code + '：'))
  if (iHit) {
    const detail = text.slice(iHit.code.length).replace(/^[:：]\s*/, '')
    return JSON.stringify({ kind: 'internal', code: iHit.code, message: detail || undefined, hint: iHit.hint })
  }
  // 网络层失败（连接重置 / 超时 / DNS 等）
  if (/timeout|timed?\s?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|aborted?/i.test(text)) {
    return JSON.stringify({ kind: 'internal', code: 'network_error', message: text.slice(0, 300), hint: '网络连接失败或超时：检查本机网络与服务商可达性；系统已自动重试仍失败' })
  }
  return status ? `【${status}】${text}` : text.slice(0, 800)
}

/** 调用日志状态细分：failed 按错误特征归入 限流（429/quota）/超时（abort/网络），与日志页过滤项对应 */
function classifyCallStatus(status: LlmCallLog['status'], errorText: string): LlmCallLog['status'] {
  if (status !== 'failed') return status
  if (/\b429\b|quota_exceeded/i.test(errorText)) return 'rate_limited'
  if (/abort|timeout|etimedout|econnreset|socket hang up|fetch failed|network/i.test(errorText)) return 'timeout'
  return 'failed'
}

export async function saveCallLog(log: LlmCallLog): Promise<void> {
  const db = await getDb()
  const provider = String(log.provider).replace(/'/g, "''")
  const model = String(log.model).replace(/'/g, "''")
  const error = log.error ? `'${friendlyLlmError(log.error).replace(/'/g, "''")}'` : 'NULL'
  const status = classifyCallStatus(log.status, String(log.error || ''))
  const fileId = log.file_id ?? 'NULL'
  const stopReason = log.stop_reason ? `'${String(log.stop_reason).replace(/'/g, "''")}'` : 'NULL'
  const sql = `INSERT INTO llm_call_logs (file_id, provider, model, prompt_tokens, completion_tokens, total_tokens, duration_ms, status, error, stop_reason) VALUES (${fileId}, '${provider}', '${model}', ${log.prompt_tokens ?? 'NULL'}, ${log.completion_tokens ?? 'NULL'}, ${log.total_tokens ?? 'NULL'}, ${log.duration_ms ?? 'NULL'}, '${status}', ${error}, ${stopReason})`
  await db.exec(sql)
}

export async function updateFileLlmState(db: SqliteDatabase, fileId: number, state: string): Promise<void> {
  const escapedState = String(state).replace(/'/g, "''")
  await db.exec(`UPDATE files SET llm_state = '${escapedState}', updated_at = CURRENT_TIMESTAMP WHERE id = ${fileId}`)
}
