/**
 * 蒸馏节点池：多模型并行蒸馏的核心调度模块。
 *
 * 概念：
 * - 节点 = (provider, model) 组合，从服务商配置的模型列表自动派生（用户改模型列表后节点自动同步）
 * - 配置 ≠ 启用：节点默认不启用，用户在设置页手动打开才参与批量蒸馏；enabled/weight 持久化在 config（ai.distillNodes）
 * - weight = 该节点的并发份额（差异化任务分配）：调度按 running/weight 最小者优先，任务量自然按 weight 比例摊分
 * - 存活检测：启用节点周期性轻量 ping（max_tokens=1，不写调用日志）+ 真实调用失败被动标记（冷却 60s），不健康的节点调度时自动跳过
 */
import { getDb } from '../db.js'
import { getProviders, type LlmProvider } from './llmClient.js'

export interface DistillNode {
  provider: string
  model: string
  enabled: boolean
  weight: number
}

export interface NodeHealth {
  healthy: boolean
  checkedAt: number
  error?: string
  /** 冷却截止：失败后 60s 内不参与调度、不重复探测 */
  cooldownUntil?: number
}

const CONFIG_KEY = 'ai.distillNodes'
const COOLDOWN_MS = 60_000

/** 健康状态：进程内缓存（重启后视为未检测，首次探测后恢复） */
const health = new Map<string, NodeHealth>()
/** 节点运行计数：dispatcher acquire/release 维护 */
const nodeRunning = new Map<string, number>()
/** 节点配置同步缓存：dispatcher.pick 必须同步取用 */
let nodesCache: DistillNode[] = []

export function nodeKey(provider: string, model: string): string {
  return `${provider}|${model}`
}

/** 各节点并发份额的推荐值（与服务商限流宽松度一致，用户可改） */
export type RecWeightFn = (provider: string) => number

async function loadOverrides(): Promise<Record<string, { enabled?: boolean; weight?: number }>> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get(CONFIG_KEY) as any
  return row?.value ? JSON.parse(row.value) : {}
}

async function saveOverrides(o: Record<string, { enabled?: boolean; weight?: number }>) {
  const db = await getDb()
  const escaped = JSON.stringify(o).replace(/'/g, "''")
  await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('${CONFIG_KEY}', '${escaped}', 'json', '蒸馏节点启用与份额覆盖') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
}

/** 模型管理：删除/改名模型后，清理该服务商下已不存在的节点覆盖（enabled/weight 残留） */
export async function pruneNodeOverrides(provider: string, validModels: string[]) {
  const overrides = await loadOverrides()
  const prefix = provider + '|'
  const stale = Object.keys(overrides).filter(k => k.startsWith(prefix) && !validModels.includes(k.slice(prefix.length)))
  if (!stale.length) return
  for (const k of stale) delete overrides[k]
  await saveOverrides(overrides)
}

/** 从服务商模型列表派生节点全集 + 应用用户覆盖配置（enabled/weight） */
export async function refreshNodesCache(recWeight: RecWeightFn): Promise<DistillNode[]> {
  const providers = await getProviders()
  const overrides = await loadOverrides()
  const nodes: DistillNode[] = []
  for (const p of providers) {
    for (const m of p.models || []) {
      const ov = overrides[nodeKey(p.name, m)] || {}
      nodes.push({ provider: p.name, model: m, enabled: !!ov.enabled, weight: ov.weight ?? recWeight(p.name) })
    }
  }
  nodesCache = nodes
  return nodes
}

export function nodesCacheSync(): DistillNode[] {
  return nodesCache
}

export function getHealth(provider: string, model: string): NodeHealth | undefined {
  return health.get(nodeKey(provider, model))
}

/** 节点当前是否可参与调度：启用 + 非冷却 + 健康未知时视为可用（允许先试，失败被动标记） */
export function isSchedulable(n: DistillNode): boolean {
  if (!n.enabled) return false
  const h = health.get(nodeKey(n.provider, n.model))
  if (h?.cooldownUntil && Date.now() < h.cooldownUntil) return false
  return h ? h.healthy : true
}

/** 主动存活检测：轻量 ping（max_tokens=1）。HTTP 200 即存活；429/5xx/超时标记不健康并进入冷却 */
export async function checkNode(provider: LlmProvider, model: string): Promise<NodeHealth> {
  const key = nodeKey(provider.name, model)
  let h: NodeHealth
  try {
    const r = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(10_000),
    })
    h = r.ok
      ? { healthy: true, checkedAt: Date.now() }
      : { healthy: false, checkedAt: Date.now(), error: `HTTP ${r.status}`, cooldownUntil: Date.now() + COOLDOWN_MS }
  } catch (e: any) {
    h = { healthy: false, checkedAt: Date.now(), error: String(e?.message || e).slice(0, 150), cooldownUntil: Date.now() + COOLDOWN_MS }
  }
  health.set(key, h)
  return h
}

/** 被动健康标记：真实蒸馏调用成功/失败时更新（失败进入冷却，让其他节点接管） */
export function reportNodeResult(provider: string, model: string, ok: boolean, err?: string) {
  const key = nodeKey(provider, model)
  if (ok) {
    health.set(key, { healthy: true, checkedAt: Date.now() })
  } else {
    health.set(key, { healthy: false, checkedAt: Date.now(), error: String(err || '').slice(0, 150), cooldownUntil: Date.now() + COOLDOWN_MS })
  }
}

/** 更新节点配置（enabled/weight），即时生效并持久化 */
export async function updateNode(provider: string, model: string, patch: { enabled?: boolean; weight?: number }, recWeight: RecWeightFn): Promise<DistillNode[]> {
  const overrides = await loadOverrides()
  const key = nodeKey(provider, model)
  const cur = overrides[key] || {}
  overrides[key] = {
    enabled: patch.enabled ?? cur.enabled,
    weight: patch.weight !== undefined ? Math.max(1, Math.min(16, patch.weight)) : cur.weight,
  }
  await saveOverrides(overrides)
  return refreshNodesCache(recWeight)
}

/**
 * 队列出队调度器：为蒸馏任务挑选节点（就地写入 job.provider/model）。
 * - 候选 = 启用 + 可调度（非冷却/健康）+ 节点未超 weight + 服务商未超队列聚合限额
 * - 优先 job 原定节点（默认模型优先）；否则 running/weight 最小者（负载按份额摊薄）
 * - 无可用节点返回 false，任务留在队列（存活恢复或用户启用节点后自动继续）
 */
export function createNodeDispatcher(opts: {
  providerRunning: (provider: string) => number
  providerLimitOf: (provider: string) => number
  kick: () => void
}) {
  return {
    pick(job: { provider: string; model: string }): boolean {
      // 池内没有任何启用节点：保持 job 原定（默认模型），走服务商限额路径（配置≠启用，全关时行为与单模型一致）
      if (!nodesCache.some(n => n.enabled)) {
        return opts.providerRunning(job.provider) < opts.providerLimitOf(job.provider)
      }
      const candidates = nodesCache.filter(n =>
        isSchedulable(n)
        && (nodeRunning.get(nodeKey(n.provider, n.model)) || 0) < n.weight
        && opts.providerRunning(n.provider) < opts.providerLimitOf(n.provider),
      )
      if (!candidates.length) return false
      // least-loaded 为主（running/weight 最小者优先，任务按份额摊薄）；默认节点仅作平局裁决，避免垄断调度
      const load = (n: DistillNode) => (nodeRunning.get(nodeKey(n.provider, n.model)) || 0) / n.weight
      const minLoad = Math.min(...candidates.map(load))
      const chosen =
        candidates.find(n => n.provider === job.provider && n.model === job.model && load(n) <= minLoad) ??
        candidates.find(n => load(n) === minLoad)!
      nodeRunning.set(nodeKey(chosen.provider, chosen.model), (nodeRunning.get(nodeKey(chosen.provider, chosen.model)) || 0) + 1)
      job.provider = chosen.provider
      job.model = chosen.model
      return true
    },
    release(job: { provider: string; model: string }) {
      const k = nodeKey(job.provider, job.model)
      nodeRunning.set(k, Math.max(0, (nodeRunning.get(k) || 0) - 1))
      // 节点空闲位释放后立即尝试补位，缩短任务间隔
      opts.kick()
    },
  }
}

/**
 * 健康检查循环：每 60s 对启用节点做存活探测。
 * - 5 分钟内确认过健康且无失败的跳过（有真实流量时被动标记已足够，主动 ping 只是兜底）
 * - 冷却中的节点等冷却结束再探测（失败节点 60s 后自动恢复尝试）
 */
export function startNodeHealthLoop(recWeight: RecWeightFn, kick: () => void) {
  const tick = async () => {
    try {
      const nodes = await refreshNodesCache(recWeight)
      const enabled = nodes.filter(n => n.enabled)
      const providers = await getProviders()
      let changed = false
      for (const n of enabled) {
        const h = health.get(nodeKey(n.provider, n.model))
        if (h?.healthy && Date.now() - h.checkedAt < 300_000) continue
        if (h?.cooldownUntil && Date.now() < h.cooldownUntil) continue
        const p = providers.find(x => x.name === n.provider)
        if (!p) continue
        const before = h?.healthy
        await checkNode(p, n.model)
        if (before !== health.get(nodeKey(n.provider, n.model))?.healthy) changed = true
      }
      if (changed) kick()
    } catch (e: any) {
      console.error('node health loop error:', String(e?.message || e))
    }
  }
  tick()
  return setInterval(tick, 60_000)
}

/** 失败轮换链：首选节点 + 其他可调度节点（按负载升序），最多 3 跳 */
export function failoverChain(preferredProvider: string, preferredModel: string, max = 3): DistillNode[] {
  const candidates = nodesCache
    .filter(n => n.enabled && isSchedulable(n))
    .sort((a, b) =>
      (nodeRunning.get(nodeKey(a.provider, a.model)) || 0) / a.weight - (nodeRunning.get(nodeKey(b.provider, b.model)) || 0) / b.weight,
    )
  const chain: DistillNode[] = []
  const pref = candidates.find(n => n.provider === preferredProvider && n.model === preferredModel)
  if (pref) chain.push(pref)
  for (const n of candidates) {
    if (chain.length >= max) break
    if (!chain.some(c => c.provider === n.provider && c.model === n.model)) chain.push(n)
  }
  return chain
}
