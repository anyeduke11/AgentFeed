// MCP 工具层共享守卫与可单测的 handler（v0.1.5 E2 起）。
// WHY 单独成文件：mcp.ts 模块顶层 main() 会连接 StdioServerTransport，
// 测试直接 import mcp.ts 即产生 stdio 副作用；handler 逻辑与守卫函数抽到本文件
// 即可被 server/test 无副作用验证。既有 7 工具经 mcp.ts import 复用，行为零变化。
import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { getDb } from './db.js'
import { aggregateDomainContext, estimateTokens } from './context.js'
import { getActiveProfile, projectProfile, type ProfileClaim } from './profile/model.js'

/** MCP 总闸：关闭后所有工具调用拒绝响应（config 表 mcp.enabled，缺省/异常视为开启） */
export async function isMcpEnabled(): Promise<boolean> {
  try {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value FROM config WHERE key = 'mcp.enabled'")).get() as any
    return row ? String(row.value) !== 'false' : true
  } catch { return true }
}

export function disabledResponse() {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'MCP 服务已停用（总闸关闭），可在看板发车区重新开启' }) }] }
}

/** 工具调用落库（发车统计；args 摘要截断 200 字符，供盘点 agent 实际查询内容） */
export async function logToolCall(tool: string, args?: unknown) {
  try {
    const db = await getDb()
    let argsSummary: string | null = null
    if (args !== undefined) {
      const full = JSON.stringify(args)
      argsSummary = full.length > 200 ? full.slice(0, 200) : full
    }
    await (await db.prepare('INSERT INTO mcp_call_logs (tool, client, args) VALUES (?, ?, ?)')).run([tool, 'unknown', argsSummary])
  } catch { /* 日志失败不影响工具调用 */ }
}

/**
 * getContext（E2，第 8 工具）handler：领域开工上下文注入。
 * 模式与其余 7 工具一致：总闸检查 → 埋点落库 → 聚合领域上下文。
 * 领域命中返回 summaryText（聚合内核已含预算截断提示）；不存在返回可读 JSON 引导 list_domains。
 */
export async function getContextHandler(args: { domain: string }) {
  if (!(await isMcpEnabled())) return disabledResponse()
  await logToolCall('getContext', args)
  const ctx = await aggregateDomainContext(args.domain)
  if (!ctx) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'domain not found',
          message: `领域「${args.domain}」不存在，请先调用 list_domains 查看可用领域`,
          available_hint: 'list_domains',
        }),
      }],
    }
  }
  return { content: [{ type: 'text' as const, text: ctx.summaryText }] }
}

/** token 预算缺省 1000（PRD J3）；config 键 getUserContext.tokenBudget 可覆盖 */
export const DEFAULT_USER_CONTEXT_TOKEN_BUDGET = 1000
const CONFIG_KEY_USER_CONTEXT_BUDGET = 'getUserContext.tokenBudget'

async function readUserContextTokenBudget(db: SqliteDatabase): Promise<number> {
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([CONFIG_KEY_USER_CONTEXT_BUDGET]) as any
  if (!row) return DEFAULT_USER_CONTEXT_TOKEN_BUDGET
  const n = Number(row.value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_USER_CONTEXT_TOKEN_BUDGET
}

/** 断言行：claim + confidence + evidence 数（evidence 数是维护页回溯的最小信号） */
function userContextClaimLine(c: ProfileClaim): string {
  return `- ${c.claim}（置信 ${c.confidence}，证据 ${c.evidence.length} 条）`
}

/**
 * get_user_context（J3，第 9 工具）handler：机读画像第一出口。
 * 模式与 getContext 一致：总闸检查 → 埋点落库 → 结构化投影。
 * 红线：生效断言只经 projectProfile 投影（vetoed 永不出口），此处不得自拼 claims。
 * token 预算整行取舍（同 context.ts 口径，不撕半行）；域名不存在只提示该域部分，不拖垮全局画像。
 */
export async function getUserContextHandler(args: { domain?: string }) {
  if (!(await isMcpEnabled())) return disabledResponse()
  await logToolCall('get_user_context', args)
  const db = await getDb()
  const global = await getActiveProfile(db, 'global', null)

  let domainLines: string[] = []
  if (args.domain !== undefined && args.domain !== '') {
    const d = await (await db.prepare('SELECT id, name FROM domains WHERE name = ?')).get([String(args.domain)]) as any
    if (!d) {
      domainLines = [`领域「${args.domain}」不存在，可用 list_domains 查看领域`]
    } else {
      const dp = await getActiveProfile(db, 'domain', Number(d.id))
      domainLines = dp
        ? [`领域「${d.name}」断言：`, ...projectProfile(dp.content).claims.map(userContextClaimLine)]
        : [`领域「${d.name}」画像尚未生成`]
    }
  }

  if (!global && domainLines.length === 0) {
    return { content: [{ type: 'text' as const, text: '画像尚未生成，可在看板 Settings→用户画像 手动触发蒸馏或补充自述' }] }
  }

  const lines: string[] = []
  if (global) {
    const projected = projectProfile(global.content)
    lines.push(projected.role_pattern ? `用户角色画像：${projected.role_pattern}` : '用户角色画像：（未生成一句话画像）')
    if (projected.claims.length > 0) {
      lines.push('生效断言：')
      for (const c of projected.claims) lines.push(userContextClaimLine(c))
    }
  }
  lines.push(...domainLines)

  const budget = await readUserContextTokenBudget(db)
  const out: string[] = []
  let used = 0
  let truncated = false
  for (const line of lines) {
    const cost = estimateTokens(line)
    if (used + cost <= budget) {
      out.push(line)
      used += cost
    } else {
      truncated = true
      break
    }
  }
  if (truncated) out.push('(已按 token 预算截断)')
  return { content: [{ type: 'text' as const, text: out.join('\n') }] }
}
