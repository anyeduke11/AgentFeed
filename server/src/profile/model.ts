// J1 用户画像·断言模型（v0.1.5 PRD 3.3.10 J1 · 第 7 批表结构解耦交付）
// WHY 独立模块：user_profile 的 content JSON 是人读维护页（J2）与机读双出口（J3）的唯一事实载体——
// schema 校验、断言预算淘汰、出口投影三件事必须钉死在同一处，任何出口不得自行解析绕过护栏。
// 设计原则：全部纯函数（无 DB 依赖）——校验拒收 fail loud、淘汰永不伤用户补充、投影永不漏 vetoed。
import type { SqliteDatabase } from '@homeofthings/sqlite3'

/** 断言状态三态（PRD 术语表「画像断言」）：
 *  active     = AI 蒸馏生成且生效
 *  user_added = 用户在维护页补充，蒸馏必须原样保留（用户是角色管理最终主人）
 *  vetoed     = 用户已否决，即刻从两出口消失，并作为下轮蒸馏负例 */
export type ClaimStatus = 'active' | 'user_added' | 'vetoed'

export interface ProfileClaim {
  /** 一句话断言，如「用户在 RAG 领域偏实操，重混合检索轻理论综述」 */
  claim: string
  status: ClaimStatus
  /** 证据指针数组，格式 '表名:行号'（如 'read_history:123'）——维护页可点开回溯 */
  evidence: string[]
  /** 0~1，蒸馏按信号量赋值 */
  confidence: number
}

export interface ProfileContent {
  schema_version: '1'
  /** 全局角色画像一句话（scope=global 专用；domain 行留空字符串） */
  role_pattern: string
  claims: ProfileClaim[]
}

/** 断言预算（PRD J1：结构化维护避免上下文膨胀）：全局 ≤20 / 每域 ≤10 */
export const CLAIM_BUDGET_GLOBAL = 20
export const CLAIM_BUDGET_DOMAIN = 10
/** 置信度门槛：域信号量（reads+agentCalls+chatMentions）低于此值不产 proficiency 断言 */
export const MIN_DOMAIN_SIGNALS = 5
/** evidence 指针合法格式：小写字母下划线表名 + 冒号 + 行号 */
const EVIDENCE_PTR = /^[a-z_]+:\d+$/

/** 校验并解析画像 content JSON——任何字段不合法整包拒收（返回 null，调用方保留旧版不半写） */
export function parseProfileContent(raw: string): ProfileContent | null {
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  if (obj.schema_version !== '1') return null
  if (typeof obj.role_pattern !== 'string') return null
  if (!Array.isArray(obj.claims)) return null
  const claims: ProfileClaim[] = []
  for (const c of obj.claims) {
    if (!c || typeof c !== 'object') return null
    if (typeof c.claim !== 'string' || c.claim.trim() === '') return null
    if (c.status !== 'active' && c.status !== 'user_added' && c.status !== 'vetoed') return null
    if (!Array.isArray(c.evidence)) return null
    if (!c.evidence.every((e: any) => typeof e === 'string' && EVIDENCE_PTR.test(e))) return null
    const conf = Number(c.confidence)
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null
    claims.push({
      claim: c.claim,
      status: c.status,
      evidence: c.evidence.map(String),
      confidence: Math.min(1, Math.max(0, conf))
    })
  }
  return { schema_version: '1', role_pattern: obj.role_pattern, claims }
}

/** 序列化（与 parse 往返一致；DB 写入统一走此口，杜绝手工拼 JSON） */
export function serializeProfileContent(content: ProfileContent): string {
  return JSON.stringify(content)
}

/**
 * 断言预算淘汰：超预算时剔除 active 断言中 evidence 最少者优先（证据最薄的先让位），
 * user_added 永不淘汰（用户裁决），vetoed 不占预算（既已否决、留存仅供负例对照，不挤占生效名额）。
 */
export function enforceClaimBudget(
  content: ProfileContent,
  scope: 'global' | 'domain'
): { content: ProfileContent, evicted: string[] } {
  const budget = scope === 'global' ? CLAIM_BUDGET_GLOBAL : CLAIM_BUDGET_DOMAIN
  const active = content.claims.filter(c => c.status === 'active')
  if (active.length <= budget) return { content, evicted: [] }
  // 稳定排序：evidence 少者优先，同数量按原顺序（可预期）
  const ranked = [...active].sort((a, b) => a.evidence.length - b.evidence.length)
  const evict = new Set(ranked.slice(0, active.length - budget).map(c => c.claim))
  const claims = content.claims.filter(c => !evict.has(c.claim))
  return { content: { ...content, claims }, evicted: [...evict] }
}

/** 出口投影（机读 get_user_context 与托管区块共用）：vetoed 永不出口；返回生效断言（active+user_added） */
export function projectProfile(content: ProfileContent): { role_pattern: string, claims: ProfileClaim[] } {
  return {
    role_pattern: content.role_pattern,
    claims: content.claims.filter(c => c.status !== 'vetoed')
  }
}

/**
 * 用户操作（J2 维护页三动作，DB 层薄封装）：
 *  veto   —— 置 vetoed（即刻从两出口消失；下轮蒸馏负例）
 *  add    —— 追加 user_added 断言（evidence 可空——用户自述不需要 AI 证据链）
 *  revert —— active 指针切回指定历史版本（旧版全部置 0、目标置 1）
 */
export async function vetoClaim(versionId: number, claimText: string): Promise<boolean> {
  const { getDb } = await import('../db.js')
  const db = await getDb()
  const row = await (await db.prepare('SELECT content FROM user_profile WHERE id = ? AND active = 1')).get([versionId]) as any
  if (!row) return false
  const parsed = parseProfileContent(String(row.content))
  if (!parsed) return false
  const target = parsed.claims.find(c => c.claim === claimText && c.status !== 'vetoed')
  if (!target) return false
  target.status = 'vetoed'
  await db.exec(`UPDATE user_profile SET content = '${serializeProfileContent(parsed).replace(/'/g, "''")}' WHERE id = ${Number(versionId)}`)
  return true
}

export async function addUserClaim(scope: 'global' | 'domain', domainId: number | null, claimText: string): Promise<number | null> {
  const { getDb } = await import('../db.js')
  const db = await getDb()
  const row = await (await db.prepare(
    'SELECT id, content FROM user_profile WHERE active = 1 AND scope = ? AND (domain_id IS ? OR domain_id = ?)'
  )).get([scope, domainId, domainId]) as any
  const claim: ProfileClaim = { claim: claimText, status: 'user_added', evidence: [], confidence: 1 }
  if (row) {
    const parsed = parseProfileContent(String(row.content))
    if (!parsed) return null
    parsed.claims.push(claim)
    await db.exec(`UPDATE user_profile SET content = '${serializeProfileContent(parsed).replace(/'/g, "''")}' WHERE id = ${Number(row.id)}`)
    return Number(row.id)
  }
  // 无活跃版本（蒸馏未跑过）：直接落一版仅含用户断言的画像，用户不必等 AI 先开口
  const content: ProfileContent = { schema_version: '1', role_pattern: '', claims: [claim] }
  const g = await db.prepare('INSERT INTO user_profile (scope, domain_id, content, evidence, confidence, generated_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
  const r = await g.run([scope, domainId, serializeProfileContent(content), '[]', 1, new Date().toISOString()])
  return Number(r.lastID)
}

export async function revertProfileVersion(versionId: number): Promise<boolean> {
  const { getDb } = await import('../db.js')
  const db = await getDb()
  const row = await (await db.prepare('SELECT scope, domain_id FROM user_profile WHERE id = ?')).get([versionId]) as any
  if (!row) return false
  await db.exec(`UPDATE user_profile SET active = 0 WHERE scope = '${row.scope}' AND (domain_id IS ${row.domain_id == null ? 'NULL' : Number(row.domain_id)}) AND active = 1`)
  await db.exec(`UPDATE user_profile SET active = 1 WHERE id = ${Number(versionId)}`)
  return true
}

/** 读取当前生效画像（J3 双出口与 J2 维护页共用入口） */
export async function getActiveProfile(db: SqliteDatabase, scope: 'global' | 'domain', domainId: number | null): Promise<{ id: number, content: ProfileContent } | null> {
  const row = await (await db.prepare(
    'SELECT id, content FROM user_profile WHERE active = 1 AND scope = ? AND (domain_id IS ? OR domain_id = ?) ORDER BY id DESC LIMIT 1'
  )).get([scope, domainId, domainId]) as any
  if (!row) return null
  const parsed = parseProfileContent(String(row.content))
  return parsed ? { id: Number(row.id), content: parsed } : null
}
