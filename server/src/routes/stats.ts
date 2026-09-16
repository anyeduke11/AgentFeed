import { Router } from 'express'
import { getDb } from '../db.js'
import { llmQueue } from '../llm/index.js'
import { resolveAgentDirs } from '../agents.js'

export const statsRouter = Router()

statsRouter.get('/overview', async (req, res) => {
  try {
    const db = await getDb()
    const filesByStatusStmt = await db.prepare("SELECT status, COUNT(*) as count FROM files GROUP BY status")
    const filesByStatus = await filesByStatusStmt.all() as any[]
    const filesByDomainStmt = await db.prepare(`
      SELECT d.name, COUNT(f.id) as count
      FROM domains d
      LEFT JOIN files f ON f.domain_id = d.id AND f.status = 'active'
      GROUP BY d.id
      ORDER BY d.sort, d.name
    `)
    const filesByDomain = await filesByDomainStmt.all() as any[]
    const filesByAgentStmt = await db.prepare(`
      SELECT source_agent as agent, COUNT(*) as count
      FROM files
      WHERE status = 'active' AND source_agent IS NOT NULL
      GROUP BY source_agent
      ORDER BY count DESC
    `)
    const filesByAgent = await filesByAgentStmt.all() as any[]
    const llmStateStmt = await db.prepare("SELECT llm_state, COUNT(*) as count FROM files GROUP BY llm_state")
    const llmState = await llmStateStmt.all() as any[]
    res.json({ filesByStatus, filesByDomain, filesByAgent, llmState })
  } catch (e: any) {
    console.error('stats overview failed', e)
    res.status(500).json({ success: false, message: String(e), stack: e.stack })
  }
})

statsRouter.get('/llm', async (req, res) => {
  const db = await getDb()
  const byDayStmt = await db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as calls, SUM(total_tokens) as tokens, SUM(duration_ms) as duration
    FROM llm_call_logs
    GROUP BY date(created_at)
    ORDER BY day DESC
    LIMIT 30
  `)
  const byDay = await byDayStmt.all() as any[]
  const byModelStmt = await db.prepare(`
    SELECT model, COUNT(*) as calls, SUM(total_tokens) as tokens, AVG(duration_ms) as avg_duration
    FROM llm_call_logs
    GROUP BY model
  `)
  const byModel = await byModelStmt.all() as any[]
  res.json({ byDay, byModel })
})

/** 总览页聚合数据：流量大数、队列、领域/agent 分布、最近文件、动态时间线、7 天趋势 */
statsRouter.get('/dashboard', async (req, res) => {
  try {
    const db = await getDb()
    const one = async (sql: string, params: any[] = []) => ((await (await db.prepare(sql)).get(params)) as any)

    const filesTotal = (await one('SELECT COUNT(*) as c FROM files'))?.c ?? 0
    const filesActive = (await one("SELECT COUNT(*) as c FROM files WHERE status = 'active'"))?.c ?? 0
    const filesDeleted = (await one("SELECT COUNT(*) as c FROM files WHERE status = 'deleted'"))?.c ?? 0
    const weekNew = (await one("SELECT COUNT(*) as c FROM files WHERE created_at >= datetime('now', '-7 days')"))?.c ?? 0
    const entries = (await one('SELECT COUNT(*) as c FROM wiki_entries_meta'))?.c ?? 0
    const domainsCnt = (await one('SELECT COUNT(*) as c FROM domains'))?.c ?? 0
    const tagsCnt = (await one('SELECT COUNT(*) as c FROM tags'))?.c ?? 0
    const agentsCnt = (await one("SELECT COUNT(DISTINCT source_agent) as c FROM files WHERE status = 'active' AND source_agent IS NOT NULL"))?.c ?? 0

    const queueRow = await one(`SELECT
      SUM(CASE WHEN llm_state = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN llm_state = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN llm_state = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN llm_state = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN llm_state = 'skipped' THEN 1 ELSE 0 END) as skipped
      FROM files WHERE status = 'active'`)

    // 领域树（两级）+ 有效文件计数
    const domainRows = await (await db.prepare(`
      SELECT d.id, d.name, d.parent_id, d.color,
        (SELECT COUNT(*) FROM files f WHERE f.domain_id = d.id AND f.status = 'active') as count
      FROM domains d ORDER BY d.sort, d.name
    `)).all() as any[]
    const domains: any[] = []
    const dmap = new Map<number, any>()
    for (const r of domainRows) {
      dmap.set(r.id, { ...r, children: [] })
    }
    for (const r of domainRows) {
      const node = dmap.get(r.id)!
      if (r.parent_id) dmap.get(r.parent_id)?.children.push(node)
      else domains.push(node)
    }
    // 一级领域计数含子领域
    for (const d of domains) {
      d.total = d.count + (d.children || []).reduce((s: number, c: any) => s + c.count, 0)
    }

    // 来源文件：扫描出的一级目录（source_agent 历史语义即扫描根下首级目录名）
    const fileSources = await (await db.prepare(`
      SELECT source_agent as name, COUNT(*) as count FROM files
      WHERE status = 'active' AND source_agent IS NOT NULL
      GROUP BY source_agent ORDER BY count DESC LIMIT 12
    `)).all() as any[]

    // 来源 agent：按本机实际存在的 agent 数据目录前缀聚合（KNOWN_AGENTS 映射，非目录名）
    const agentDirs = resolveAgentDirs().filter(a => a.exists)
    const cols = agentDirs.map((a, i) =>
      `SUM(CASE WHEN path LIKE '${a.path.replace(/'/g, "''")}/%' THEN 1 ELSE 0 END) as a${i}`
    ).join(', ')
    const agentRow = agentDirs.length
      ? await one(`SELECT ${cols} FROM files WHERE status = 'active'`)
      : {}
    const agents = agentDirs
      .map((a, i) => ({ name: a.name, count: Number(agentRow?.[`a${i}`]) || 0 }))
      .filter(x => x.count > 0)
      .sort((x, y) => y.count - x.count)

    const recent = await (await db.prepare(`
      SELECT f.id, f.title, d.name as domain, d.color as domain_color, f.source_agent as agent, f.file_mtime, f.ext
      FROM files f LEFT JOIN domains d ON f.domain_id = d.id
      WHERE f.status = 'active' ORDER BY f.file_mtime DESC LIMIT 5
    `)).all() as any[]

    // 动态时间线：最近词条入库 + 最近 llm 调用合并
    const entryEvents = await (await db.prepare(`
      SELECT wem.distilled_at as t, f.title, f.source_agent as agent, f.id as fileId
      FROM wiki_entries_meta wem JOIN files f ON wem.file_id = f.id
      ORDER BY wem.distilled_at DESC LIMIT 8
    `)).all() as any[]
    const llmEvents = await (await db.prepare(`
      SELECT l.created_at as t, l.status, f.title, l.error
      FROM llm_call_logs l LEFT JOIN files f ON l.file_id = f.id
      ORDER BY l.created_at DESC LIMIT 8
    `)).all() as any[]
    const events = [
      ...entryEvents.map(e => ({ t: e.t, c: '#1E8E5A', text: `词条「${e.title}」入库（来源 ${e.agent || '未知'}）` })),
      ...llmEvents.map(e => ({
        t: e.t,
        c: e.status === 'success' ? '#2456A6' : '#C2402A',
        text: `精炼「${e.title || '未知文件'}」${e.status === 'success' ? '完成' : '失败' + (e.error ? '：' + e.error : '')}`
      }))
    ]
      .filter(e => e.t)
      .sort((a, b) => String(b.t).localeCompare(String(a.t)))
      .slice(0, 10)

    // 15 天 LLM 调用趋势（按模型细分，供前端堆叠柱状图着色）
    const trendRows = await (await db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as calls
      FROM llm_call_logs WHERE created_at >= datetime('now', '-15 days')
      GROUP BY date(created_at) ORDER BY day ASC
    `)).all() as any[]
    const modelRows = await (await db.prepare(`
      SELECT model, date(created_at) as day, COUNT(*) as calls
      FROM llm_call_logs WHERE created_at >= datetime('now', '-15 days')
      GROUP BY model, date(created_at)
    `)).all() as any[]
    const days: string[] = []
    for (let i = 14; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
    const labels = days.map(k => k.slice(5))
    const vals = days.map(k => trendRows.find((r: any) => String(r.day) === k)?.calls || 0)
    const models = [...new Set(modelRows.map((r: any) => r.model || '(default)'))]
      .map((name: string) => ({
        name,
        vals: days.map(k => modelRows.find((r: any) => (r.model || '(default)') === name && String(r.day) === k)?.calls || 0),
      }))
      .sort((a, b) => b.vals.reduce((s: number, v: number) => s + v, 0) - a.vals.reduce((s: number, v: number) => s + v, 0))
    const trend30 = await one(`SELECT COUNT(*) as calls, SUM(total_tokens) as tokens,
      ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) as rate
      FROM llm_call_logs WHERE created_at >= datetime('now', '-30 days')`)

    res.json({
      stats: { files: filesTotal, active: filesActive, deleted: filesDeleted, weekNew, entries, domains: domainsCnt, tags: tagsCnt, agents: agentsCnt },
      queue: { pending: queueRow?.pending || 0, running: queueRow?.running || 0, done: queueRow?.done || 0, failed: queueRow?.failed || 0, skipped: queueRow?.skipped || 0, paused: llmQueue.isPaused },
      domains, fileSources, agents, recent, events,
      trend: { labels, vals, models, sum: vals.reduce((s, v) => s + v, 0) },
      llm30: { calls: trend30?.calls || 0, tokens: trend30?.tokens || 0, rate: trend30?.rate ?? 100 },
      defaultModel: null
    })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e), stack: e.stack })
  }
})

/** 数据看板：① agent 生产情况（下钻 agent 数据目录下首级子目录）② 领域占比气泡 */
statsRouter.get('/board', async (req, res) => {
  try {
    const db = await getDb()
    const one = async (sql: string, params: any[] = []) => ((await (await db.prepare(sql)).get(params)) as any)

    // 各 agent 生产情况：文件数 + 二级目录（agent 数据目录下的首级子目录）分布
    const agentDirs = resolveAgentDirs().filter(a => a.exists)
    const agentProd: any[] = []
    for (const a of agentDirs) {
      const pref = a.path.replace(/'/g, "''")
      const head = await one(`SELECT COUNT(*) as c FROM files WHERE status = 'active' AND path LIKE '${pref}/%'`)
      const count = Number(head?.c) || 0
      if (count <= 0) continue
      const relRows = await (await db.prepare(
        `SELECT substr(path, ${a.path.length + 2}) as rel FROM files WHERE status = 'active' AND path LIKE '${pref}/%'`
      )).all() as any[]
      const dmap = new Map<string, number>()
      for (const r of relRows) {
        const seg = String(r.rel || '').split('/')[0] || '(根)'
        dmap.set(seg, (dmap.get(seg) || 0) + 1)
      }
      const dirs = [...dmap.entries()].map(([name, c]) => ({ name, count: c })).sort((x, y) => y.count - x.count).slice(0, 12)
      agentProd.push({ name: a.name, count, dirs })
    }
    agentProd.sort((x, y) => y.count - x.count)

    // 领域占比气泡：一级领域（含子领域份额），颜色与分拣区同源
    const rows = await (await db.prepare(`
      SELECT d.id, d.name, d.parent_id, d.color,
        (SELECT COUNT(*) FROM files f WHERE f.domain_id = d.id AND f.status = 'active') as count
      FROM domains d ORDER BY d.sort, d.name
    `)).all() as any[]
    const topRows = rows.filter((r: any) => !r.parent_id)
    const total = topRows.reduce((s: number, r: any) => s + r.count, 0)
    const domainBubbles = topRows
      .map((r: any) => ({ name: r.name, color: r.color || '#909399', count: r.count, pct: total ? +(r.count / total * 100).toFixed(1) : 0 }))
      .filter((b: any) => b.count > 0)

    res.json({ agentProd, domainBubbles })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** MCP 发车统计：工具调用次数（stdio 无法区分客户端，统一记 unknown） */
statsRouter.get('/mcp', async (req, res) => {
  try {
    const db = await getDb()
    const weekRow = await (await db.prepare("SELECT COUNT(*) as c FROM mcp_call_logs WHERE created_at >= datetime('now', '-7 days')")).get() as any
    const totalRow = await (await db.prepare('SELECT COUNT(*) as c FROM mcp_call_logs')).get() as any
    const byTool = await (await db.prepare(`
      SELECT tool as n, COUNT(*) as calls, MAX(created_at) as last
      FROM mcp_call_logs GROUP BY tool ORDER BY calls DESC
    `)).all() as any[]
    const byDay = await (await db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as calls FROM mcp_call_logs
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY date(created_at) ORDER BY day ASC
    `)).all() as any[]
    res.json({ week: weekRow.c, total: totalRow.c, byTool, byDay })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})
