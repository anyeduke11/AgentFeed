// J1 用户画像·蒸馏 job（v0.1.5 PRD 3.3.10 J1 第 7 批）：bundle + 上版画像 → LLM → schema 校验 → 写库。
// 队列范式对齐 backfill（fileId=0 哨兵、priority 0 不插队、saveCallLog 兜底、不动 files.llm_state）。
// 三条安全设计：
// 1. evidence 编号制（防幻觉关键）：prompt 只给编号证据桶（真实行号），LLM 输出引用编号，
//    本地翻译回 '表名:行号'——LLM 永远不自己编指针，非法引用整包拒收（fail loud 保留旧版）
// 2. user_added / vetoed 原样搬运：LLM 只产 active 断言；用户补充必须保留、否决项作为负例
//    写进 prompt（「不得产出等价断言」）并随新版留存对照
// 3. 低信号域不进 prompt：meetsThreshold=false 的域根本不给 LLM——置信度门槛在源头掐断，
//    而不是靠 LLM 自觉
import type { SqliteDatabase } from '@homeofthings/sqlite3'
import type { LlmJob } from '../llm/llmQueue.js'
import { getDb } from '../db.js'
import { getProviders, getDefaultModel, saveCallLog } from '../llm/llmClient.js'
import { callLlm } from '../llm/index.js'
import { buildProfileSignalBundle, type ProfileSignalBundle } from './aggregate.js'
import {
  parseProfileContent, serializeProfileContent, enforceClaimBudget, getActiveProfile,
  CLAIM_BUDGET_DOMAIN, type ProfileClaim, type ProfileContent
} from './model.js'
import { syncAuthorizedProjects } from './syncBlock.js'

export const CONFIG_ENABLED = 'userProfile.enabled'

/** LLM 输出（evidence 引用编号，未翻译）的中间结构 */
interface LlmRawClaim { claim: string, evidence_refs: string[], confidence: number }
interface LlmRawOutput {
  role_pattern: string
  claims: LlmRawClaim[]
  domains: { domain: string, proficiency?: string, claims: LlmRawClaim[] }[]
}

/** 进程内 in-flight 去重：画像蒸馏全局单飞（月频任务，重复入队没有意义） */
let distilling = false

export async function isProfileDistillEnabled(db: SqliteDatabase): Promise<boolean> {
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([CONFIG_ENABLED]) as any
  if (!row) return true // 默认开（用户裁决 2026-09-21）
  return String(row.value) !== 'false'
}

/**
 * 证据编号桶：ref（如 E1）→ 真实指针（如 read_history:123）。
 * 每域取窗口内最近的 read_history 与 mcp_call_logs 行号各 ≤4 条——够 LLM 引用，不撑 token。
 */
export async function collectEvidenceIndex(
  db: SqliteDatabase, bundle: ProfileSignalBundle
): Promise<Map<string, string>> {
  const idx = new Map<string, string>()
  let n = 0
  const add = (table: string, id: number) => { n += 1; idx.set(`E${n}`, `${table}:${id}`) }
  const mcpCalls = await (await db.prepare(`
    SELECT m.id AS id FROM mcp_call_logs m
    WHERE m.tool IN ('search_knowledge', 'read_entry') ORDER BY m.id DESC LIMIT 4
  `)).all() as any[]
  for (const d of bundle.domains) {
    const reads = await (await db.prepare(`
      SELECT rh.id AS id FROM read_history rh JOIN files f ON f.id = rh.file_id
      WHERE f.domain_id = ? ORDER BY rh.id DESC LIMIT 4
    `)).all([d.domainId]) as any[]
    for (const r of reads) add('read_history', Number(r.id))
  }
  for (const c of mcpCalls) add('mcp_call_logs', Number(c.id))
  return idx
}

/** 组装蒸馏 prompt：统计包 + 上版画像（active 摘要）+ user_added 保留清单 + vetoed 负例 + 证据桶 */
export function buildProfileDistillPrompt(
  bundle: ProfileSignalBundle,
  prev: ProfileContent | null,
  evidenceIndex: Map<string, string>
): string {
  const evLines = [...evidenceIndex.entries()].map(([ref, ptr]) => `- ${ref} → ${ptr}`).join('\n')
  const vetoed = prev ? prev.claims.filter(c => c.status === 'vetoed').map(c => c.claim) : []
  const kept = prev ? prev.claims.filter(c => c.status === 'user_added').map(c => c.claim) : []
  const prevActive = prev ? prev.claims.filter(c => c.status === 'active').map(c => `「${c.claim}」（置信 ${c.confidence}）`).join('；') : '（无——首轮画像）'
  const domainsBlock = bundle.domains
    .filter(d => d.meetsThreshold) // 低信号域不进 prompt：门槛在源头掐断
    .map(d => `- ${d.domainName}：读取 ${d.reads} 次 / agent 消费 ${d.agentCalls} 次 / 评分均值 ${d.avgRating ?? '无'} / 复习完成率 ${d.quizPassRate ?? '无'} / top 标签 ${d.topTags.map(t => `${t.name}(${t.weight})`).join('、') || '无'}`)
    .join('\n')
  return `你在为知识库工具 AgentFeed 蒸馏用户画像。依据以下纯本地统计（30 天窗口），产出结构化画像断言。

【全局统计】读取 ${bundle.global.totalReads} 次 / agent 消费 ${bundle.global.totalAgentCalls} 次 / 评分均值 ${bundle.global.avgRating ?? '无'} / 全局 top 标签 ${bundle.global.topTags.map(t => `${t.name}(${t.weight})`).join('、') || '无'}

【领域统计】（仅列出信号充足的领域）
${domainsBlock || '（无信号充足领域）'}

【上一版画像 active 断言】${prevActive}
【用户补充断言（你必须延续尊重的既有事实，无需重复输出）】${kept.join('；') || '无'}
【用户已否决断言（负例——不得输出任何与之等价或相近的断言）】${vetoed.join('；') || '无'}

【证据编号桶】（你的断言只能引用这些编号，每个编号对应一条真实记录）
${evLines || '（无）'}

要求：
1. role_pattern：一句话全局角色画像（如「全栈+AI 工程，重实操轻理论」）
2. 全局 claims ≤12 条：用户角色、领域倾向、内容偏好（深度/风格/媒介）
3. 每个领域 claims ≤6 条：proficiency（expert/proficient/learning）+ 具体倾向；只针对上面列出的领域
4. 每条断言必须给 evidence_refs（引用证据编号，至少 1 个；无证据支撑的断言不要输出）
5. confidence ∈ [0,1]，信号越薄越低
6. 断言必须可从统计推出，禁止臆造

只输出 JSON（不要围栏不要解释）：
{"role_pattern":"...","claims":[{"claim":"...","evidence_refs":["E1"],"confidence":0.8}],"domains":[{"domain":"域名","proficiency":"expert","claims":[{"claim":"...","evidence_refs":["E2"],"confidence":0.7}]}]}`
}

/** 剥离可能的 ```json 围栏（LLM 常见行为），返回正文 */
function stripFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return m ? m[1] : t
}

/** 解析 LLM 输出：编号翻译回真实指针；任何非法（坏 JSON/未知编号/空断言/置信越界）整包拒收返回 null */
export function parseLlmProfileOutput(text: string, evidenceIndex: Map<string, string>): { role_pattern: string, claims: ProfileClaim[], domains: Map<string, ProfileClaim[]> } | null {
  let obj: any
  try { obj = JSON.parse(stripFence(text)) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.role_pattern !== 'string') return null
  const translate = (raw: any): ProfileClaim | null => {
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.claim !== 'string' || raw.claim.trim() === '') return null
    if (!Array.isArray(raw.evidence_refs) || raw.evidence_refs.length === 0) return null
    const ptrs: string[] = []
    for (const ref of raw.evidence_refs) {
      const ptr = evidenceIndex.get(String(ref))
      if (!ptr) return null // 未知编号 = 幻觉指针，整包拒收
      ptrs.push(ptr)
    }
    const conf = Number(raw.confidence)
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null
    return { claim: raw.claim.trim(), status: 'active', evidence: ptrs, confidence: conf }
  }
  if (!Array.isArray(obj.claims)) return null
  const claims: ProfileClaim[] = []
  for (const c of obj.claims) { const t = translate(c); if (!t) return null; claims.push(t) }
  const domains = new Map<string, ProfileClaim[]>()
  if (obj.domains !== undefined) {
    if (!Array.isArray(obj.domains)) return null
    for (const d of obj.domains) {
      if (!d || typeof d.domain !== 'string' || !Array.isArray(d.claims)) return null
      if (d.proficiency !== undefined && !['expert', 'proficient', 'learning'].includes(d.proficiency)) return null
      const dc: ProfileClaim[] = []
      for (const c of d.claims) { const t = translate(c); if (!t) return null; dc.push(t) }
      if (d.proficiency) dc.unshift({ claim: `proficiency: ${d.proficiency}`, status: 'active', evidence: dc[0]?.evidence || [], confidence: dc[0]?.confidence || 0.5 })
      domains.set(d.domain, dc)
    }
  }
  return { role_pattern: obj.role_pattern, claims, domains }
}

/** 合并策略：LLM 全新 active + 上版 user_added/vetoed 原样搬运（用户主权与负例留存） */
export function mergeForCommit(prev: ProfileContent | null, fresh: { role_pattern: string, claims: ProfileClaim[] }): ProfileContent {
  const carried = prev ? prev.claims.filter(c => c.status !== 'active') : []
  return {
    schema_version: '1',
    role_pattern: fresh.role_pattern || (prev?.role_pattern ?? ''),
    claims: [...fresh.claims, ...carried]
  }
}

/** 提交新版本：同 scope+domain 旧 active 全部置 0，插入新行 active=1（版本链可 diff 可回滚） */
async function commitProfile(
  db: SqliteDatabase, scope: 'global' | 'domain', domainId: number | null, content: ProfileContent
): Promise<number> {
  const now = new Date().toISOString()
  await db.exec(`UPDATE user_profile SET active = 0 WHERE scope = '${scope}' AND (domain_id IS ${domainId == null ? 'NULL' : Number(domainId)}) AND active = 1`)
  const esc = serializeProfileContent(content).replace(/'/g, "''")
  const r = await (await db.prepare(
    'INSERT INTO user_profile (scope, domain_id, content, evidence, confidence, generated_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
  )).run([scope, domainId, esc, '[]', null, now])
  return Number(r.lastID)
}

/** 域名 → domainId 映射（commit 时反查；未知域名丢弃该域断言——LLM 不得自创领域，同蒸馏领域名单纪律） */
async function resolveDomainIds(db: SqliteDatabase, names: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  for (const n of names) {
    const row = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get([n]) as any
    if (row) m.set(n, Number(row.id))
  }
  return m
}

export interface ProfileDistillOptions {
  /** 测试注入点：伪造 LLM 响应（同 hybrid.ts embedFn 模式）；注入时跳过真实网络调用 */
  llmFn?: (prompt: string) => Promise<string>
}

/** profile job 主流程（llmWorker options.type='profile' 分发目标） */
export async function processProfileJob(job: LlmJob, opts?: ProfileDistillOptions): Promise<void> {
  const db = await getDb()
  const started = Date.now()
  let status: 'success' | 'failed' = 'failed'
  let error: string | undefined
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let usedProvider = job.provider
  let usedModel = job.model
  // 守卫必须在 try 之外：try 内 return 仍会走 finally 的 saveCallLog——开关关闭/零信号是"静默跳过"，不是失败，不落日志
  if (!(await isProfileDistillEnabled(db))) return
  try {
    const providers = await getProviders()
    const provider = providers.find(p => p.name === job.provider) || providers[0]
    if (!provider) throw new Error('no_llm_provider')
    const modelId = job.model || await getDefaultModel()

    const bundle = await buildProfileSignalBundle(db)
    if (bundle.domains.length === 0 && bundle.global.totalReads === 0 && bundle.global.totalChatMentions === 0) {
      return // 零信号：不蒸馏（冷启动不产空画像）——finally 会落一行 failed 日志，可接受：真实到达过执行期
    }
    const evidenceIndex = await collectEvidenceIndex(db, bundle)
    const prevActive = await getActiveProfile(db, 'global', null)
    const prompt = buildProfileDistillPrompt(bundle, prevActive?.content ?? null, evidenceIndex)

    let text: string
    if (opts?.llmFn) {
      text = await opts.llmFn(prompt)
      usedModel = modelId
    } else {
      const r = await callLlm(provider.name, modelId, prompt, provider.apiKey)
      usedModel = modelId
      promptTokens = (r.usage as any)?.input ?? undefined
      completionTokens = (r.usage as any)?.output ?? undefined
      text = r.text
    }

    const parsed = parseLlmProfileOutput(text, evidenceIndex)
    if (!parsed) throw new Error('invalid_llm_output') // 坏产物拒收：整包丢弃保留旧版（PRD J1 异常流）

    // global 提交（断言预算本地强制——LLM 超编不可信）
    const globalMerged = enforceClaimBudget(mergeForCommit(prevActive?.content ?? null, { role_pattern: parsed.role_pattern, claims: parsed.claims }), 'global').content
    await commitProfile(db, 'global', null, globalMerged)

    // 域画像提交：每域 = LLM 域断言 + 该域上版 user_added/vetoed 搬运；未知域名丢弃
    if (parsed.domains.size > 0) {
      const idByName = await resolveDomainIds(db, [...parsed.domains.keys()])
      for (const [name, freshClaims] of parsed.domains) {
        const domainId = idByName.get(name)
        if (domainId == null) continue
        const prevDomain = await getActiveProfile(db, 'domain', domainId)
        const merged = enforceClaimBudget(
          mergeForCommit(prevDomain?.content ?? null, { role_pattern: '', claims: freshClaims }), 'domain'
        ).content
        if (merged.claims.length > 0) await commitProfile(db, 'domain', domainId, merged)
      }
    }
    status = 'success'
    // J3 双出口：画像更新成功即同步授权托管区块（fire-and-forget——同步失败不影响蒸馏成功；授权清单外路径天然不写）
    syncAuthorizedProjects().catch(() => {})
  } catch (e: any) {
    error = String(e?.message || e)
  } finally {
    await saveCallLog({
      file_id: null, // 画像 job 无关联文件——llm_call_logs.file_id 有 FK 约束，NULL 而非哨兵 0；G1 成本视图按 provider/model 聚合不受影响
      provider: usedProvider,
      model: usedModel,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: (promptTokens || 0) + (completionTokens || 0),
      duration_ms: Date.now() - started,
      status,
      error
    })
    if (status !== 'success') console.warn(`[profile] 蒸馏失败: ${error}`)
  }
}

/**
 * 触发画像蒸馏（信号累积或手动入口调用）：开关检查 + in-flight 去重 + 入队（priority 0 不插队）。
 * 返回是否成功入队。
 */
export async function triggerProfileDistill(): Promise<boolean> {
  const db = await getDb()
  if (distilling) return false
  if (!(await isProfileDistillEnabled(db))) return false
  const providers = await getProviders()
  if (providers.length === 0) return false
  const { llmQueue } = await import('../llm/index.js')
  llmQueue.enqueue({
    fileId: 0, provider: providers[0].name, model: '', prompt: '',
    options: { type: 'profile' } // priority 缺省 0：与蒸馏同级不插队（PRD J1：不挤 triage）
  })
  return true
}

export const PROFILE_CLAIM_BUDGET_DOMAIN = CLAIM_BUDGET_DOMAIN
