// J2 画像维护页后端（v0.1.5 PRD 3.3.10 J2）：断言列表 / 否决 / 补充 / 版本回滚 / 证据回溯 / 手动蒸馏。
// 端点全部复用 J1 已交付的 model 函数（vetoClaim/addUserClaim/revertProfileVersion/getActiveProfile）——
// 路由层只做参数校验与响应包裹，业务护栏单一事实源在 model.ts，不在路由重复实现。
// 安全红线：evidence 端点表名白名单 + 参数化查询——指针原文永不拼 SQL；内容截断 200 字符，不回盘上信息。
import { Router } from 'express'
import { getDb } from '../db.js'
import {
  vetoClaim, addUserClaim, revertProfileVersion, getActiveProfile,
  parseProfileContent, CLAIM_BUDGET_GLOBAL, CLAIM_BUDGET_DOMAIN
} from '../profile/model.js'
import { triggerProfileDistill, isProfileDistillEnabled, CONFIG_ENABLED } from '../profile/distill.js'
import { syncAuthorizedProjects } from '../profile/syncBlock.js'

export const profileRouter = Router()

function parseScope(raw: unknown): 'global' | 'domain' | null {
  return raw === 'domain' ? 'domain' : raw === 'global' ? 'global' : null
}

function parseDomainId(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null // 非法 → null（与 undefined「缺省」区分）
}

/** 当前生效画像 + 预算口径（scope=domain 必须带合法 domainId） */
profileRouter.get('/', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (!scope) { res.status(400).json({ success: false, error: 'scope 必须为 global 或 domain' }); return }
  if (scope === 'domain') {
    const d = parseDomainId(req.query.domainId)
    if (d === null || d === undefined) { res.status(400).json({ success: false, error: 'domain scope 需要合法 domainId' }); return }
    const p = await getActiveProfile(await getDb(), 'domain', d as number | null)
    res.json({ success: true, profile: p, budget: CLAIM_BUDGET_DOMAIN })
    return
  }
  const p = await getActiveProfile(await getDb(), 'global', null)
  res.json({ success: true, profile: p, budget: CLAIM_BUDGET_GLOBAL })
})

/** 版本链（同 scope+domain 全版本，新→旧）：断言计数供 diff 选择，active 标记当前版 */
profileRouter.get('/versions', async (req, res) => {
  const scope = parseScope(req.query.scope)
  if (!scope) { res.status(400).json({ success: false, error: 'scope 必须为 global 或 domain' }); return }
  const db = await getDb()
  const domainId = scope === 'domain' ? parseDomainId(req.query.domainId) : null
  if (scope === 'domain' && domainId === null) { res.status(400).json({ success: false, error: 'domain scope 需要合法 domainId' }); return }
  const rows = await (await db.prepare(
    `SELECT id, generated_at, active, content FROM user_profile
     WHERE scope = ? AND (domain_id IS ? OR domain_id = ?) ORDER BY id DESC LIMIT 50`
  )).all([scope, domainId ?? null, domainId ?? null]) as any[]
  res.json({
    success: true,
    versions: rows.map(r => {
      const parsed = parseProfileContent(String(r.content))
      return {
        id: Number(r.id),
        generatedAt: r.generated_at,
        active: Number(r.active) === 1,
        claimCount: parsed ? parsed.claims.length : null,
        parseOk: parsed !== null
      }
    })
  })
})

/** 版本内容（diff 用）：返回指定版本解析后的 content */
profileRouter.get('/versions/:id', async (req, res) => {
  const db = await getDb()
  const row = await (await db.prepare('SELECT id, scope, domain_id, content, generated_at, active FROM user_profile WHERE id = ?')).get(Number(req.params.id)) as any
  if (!row) { res.status(404).json({ success: false, error: 'version not found' }); return }
  const parsed = parseProfileContent(String(row.content))
  res.json({
    success: true,
    version: {
      id: Number(row.id), scope: row.scope, domainId: row.domain_id == null ? null : Number(row.domain_id),
      generatedAt: row.generated_at, active: Number(row.active) === 1, content: parsed
    }
  })
})

/** 否决断言：vetoed 即刻从两出口消失 + 作下轮蒸馏负例（轻操作无确认，误否决走版本回滚兜底） */
profileRouter.post('/veto', async (req, res) => {
  const versionId = Number(req.body?.versionId)
  const claim = String(req.body?.claim ?? '')
  if (!Number.isInteger(versionId) || versionId <= 0 || !claim.trim()) {
    res.status(400).json({ success: false, error: 'versionId 与 claim 必填' }); return
  }
  const ok = await vetoClaim(versionId, claim)
  res.json({ success: ok, error: ok ? undefined : '版本不存在、已非生效版或断言未命中' })
})

/** 用户补充断言（user_added：蒸馏必须保留；无活跃版时自建首版） */
profileRouter.post('/claim', async (req, res) => {
  const scope = parseScope(req.body?.scope)
  const claim = String(req.body?.claim ?? '').trim()
  if (!scope) { res.status(400).json({ success: false, error: 'scope 必须为 global 或 domain' }); return }
  if (!claim || claim.length > 200) { res.status(400).json({ success: false, error: 'claim 必填且 ≤200 字符' }); return }
  const domainId = scope === 'domain' ? parseDomainId(req.body?.domainId) : null
  if (scope === 'domain' && domainId === null) { res.status(400).json({ success: false, error: 'domain scope 需要合法 domainId' }); return }
  const id = await addUserClaim(scope, (domainId as number | null) ?? null, claim)
  res.json({ success: id !== null, error: id === null ? '写入失败（content 损坏时 fail loud 拒写）' : undefined, versionId: id ?? undefined })
})

/** 整版回滚：旧版全置 0 目标置 1；托管区块（J3）下次同步按回滚版渲染 */
profileRouter.post('/revert', async (req, res) => {
  const versionId = Number(req.body?.versionId)
  if (!Number.isInteger(versionId) || versionId <= 0) { res.status(400).json({ success: false, error: 'versionId 必填' }); return }
  const ok = await revertProfileVersion(versionId)
  res.json({ success: ok, error: ok ? undefined : '版本不存在' })
})

/** 证据表白名单：evidence 回溯只允许这三张信号表（防任意表探测） */
const EVIDENCE_TABLES = {
  read_history: 'SELECT id, source, opened_at, rating, feedback FROM read_history WHERE id = ?',
  chat_messages: 'SELECT id, session_id, role, created_at FROM chat_messages WHERE id = ?',
  mcp_call_logs: 'SELECT id, tool, client, created_at FROM mcp_call_logs WHERE id = ?'
} as const

/** 证据原文回溯：白名单表 + 参数化；内容类字段截断 200 字符；行不存在 found:false 不报错 */
profileRouter.get('/evidence', async (req, res) => {
  const ptr = String(req.query.ptr ?? '')
  const m = ptr.match(/^([a-z_]+):(\d+)$/)
  if (!m) { res.status(400).json({ success: false, error: 'ptr 格式须为 表名:行号' }); return }
  const table = m[1] as keyof typeof EVIDENCE_TABLES
  const rowId = Number(m[2])
  if (!(table in EVIDENCE_TABLES)) { res.status(400).json({ success: false, error: `表 ${table} 不在证据白名单` }); return }
  const db = await getDb()
  const row = await (await db.prepare(EVIDENCE_TABLES[table])).get(rowId) as any
  if (!row) { res.json({ success: true, found: false, table, rowId }); return }
  const snippet = (v: unknown) => typeof v === 'string' ? (v.length > 200 ? v.slice(0, 200) + '…' : v) : v
  const out: Record<string, unknown> = { table, rowId }
  for (const [k, v] of Object.entries(row)) out[k] = k === 'args' || k === 'feedback' || k === 'role' ? snippet(v) : v
  res.json({ success: true, found: true, row: out })
})

/** 手动蒸馏入口（PRD J1：信号累积或手动触发；开关关闭/已在跑 → false）。手动 = 插队（priority 100），
 *  排在重蒸馏积压之前——用户显式点击的动作不应数分钟无响应 */
profileRouter.post('/distill', async (req, res) => {
  const manual = req.body?.manual !== false
  const queued = await triggerProfileDistill(manual)
  const enabled = await isProfileDistillEnabled(await getDb())
  res.json({ success: true, queued, enabled })
})

/** 手动触发托管区块同步（J3）：只写 userProfile.syncTargets 授权清单内文件，返回逐文件结果 */
profileRouter.post('/sync', async (_req, res) => {
  const results = await syncAuthorizedProjects()
  res.json({ success: true, results })
})

/** 蒸馏开关状态（写入走既有 PATCH /api/config，此处只读供页面展示） */
profileRouter.get('/status', async (_req, res) => {
  const db = await getDb()
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([CONFIG_ENABLED]) as any
  const last = await (await db.prepare(`SELECT generated_at FROM user_profile WHERE scope = 'global' ORDER BY id DESC LIMIT 1`)).get() as any
  res.json({ success: true, enabled: row ? String(row.value) !== 'false' : true, lastDistilledAt: last?.generated_at ?? null })
})
