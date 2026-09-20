/**
 * MCP 消费链路漏斗分析：search_knowledge → read_entry → get_source
 *
 * 只读打开 mcp_call_logs（绝不写库、不做迁移），按时间升序做会话聚类：
 * 同一会话内相邻两次调用间隔 ≤ 30 分钟，超过则切分新会话。输出指标：
 *   - totalSessions        总会话数
 *   - sessionsWithSearch   含 search_knowledge 的会话数（一级链路分母）
 *   - level1Rate           一级链路完成率 = search 后同会话 30 分钟内跟随 read_entry 的会话占比
 *   - level2Rate           二级链路完成率 = read_entry 后同会话 30 分钟内跟随 get_source 的占比
 *                          （分母 = 含 read_entry 的会话数）
 *
 * 用法：
 *   npx tsx server/scripts/mcpFunnel.ts [--json /tmp/mcpFunnel.json] [--db <sqlite 路径>]
 *   --db 缺省 = $AGENTFEED_DATA_DIR/app.db，未设环境变量时为 server/data/app.db（与 src/db.ts 口径一致）
 *
 * 验证方式（临时库，不触碰真实库；macOS 自带 sqlite3 CLI）：
 *   1) 空表全 0：建临时库并按真实 DDL 建空表 mcp_call_logs(id, tool, client, created_at, args)，
 *      跑 npx tsx server/scripts/mcpFunnel.ts --db /tmp/funnel-empty.db → exit 0，四项指标全 0
 *   2) 聚类/达成边界：插入构造记录——间隔 29 分钟（同会话、达成）、31 分钟（切分会话、不达成）、
 *      read→get_source 25 分钟（二级达成），核对 totalSessions / 分子分母与期望一致
 */

import { SqliteDatabase, OPEN_READONLY } from '@homeofthings/sqlite3'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 会话切分阈值：相邻调用间隔超过 30 分钟视为新会话
const SESSION_GAP_MS = 30 * 60 * 1000

// 漏斗链路上的三个工具名（与 src/mcp.ts 的 logToolCall 落库值一致）
const TOOL_SEARCH = 'search_knowledge'
const TOOL_READ = 'read_entry'
const TOOL_SOURCE = 'get_source'

interface CallRow {
  id: number
  tool: string
  created_at: string | null
}

interface Event {
  tool: string
  t: number
  raw: string
}

interface Metrics {
  totalSessions: number
  sessionsWithSearch: number
  level1Rate: number
  level2Rate: number
  // 上下文字段（附录文档用）：分母细化 + 数据集范围
  sessionsWithRead: number
  level1Done: number
  level2Done: number
  totalCalls: number
  firstCallAt: string | null
  lastCallAt: string | null
  skippedRows: number
  dbPath: string
  generatedAt: string
}

/** 解析 SQLite CURRENT_TIMESTAMP（UTC "YYYY-MM-DD HH:MM:SS"）为毫秒；无法解析返回 null */
function parseTs(raw: string | null): number | null {
  if (!raw) return null
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : normalized + 'Z')
  return Number.isNaN(ms) ? null : ms
}

/** 单会话内判定：存在 fromTool 事件，其后 30 分钟内（同会话）跟随 toTool 事件 */
function funnelDone(events: Event[], fromTool: string, toTool: string): boolean {
  for (let i = 0; i < events.length; i++) {
    if (events[i].tool !== fromTool) continue
    for (let j = i + 1; j < events.length; j++) {
      const gap = events[j].t - events[i].t
      if (gap > SESSION_GAP_MS) break
      if (events[j].tool === toTool) return true
    }
  }
  return false
}

/** 占比保留 4 位小数；分母为 0 时返回 0（空表合法全 0 输出） */
function rate(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 10000) / 10000
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const dbPath = argValue('--db')
    ? path.resolve(argValue('--db')!)
    : path.join(
        process.env.AGENTFEED_DATA_DIR ? path.resolve(process.env.AGENTFEED_DATA_DIR) : path.resolve(__dirname, '../data'),
        'app.db'
      )
  const jsonOut = argValue('--json')

  // 只读模式打开：保证对真实库零写入（不开 WAL、不跑迁移）
  const db = await SqliteDatabase.open(dbPath, OPEN_READONLY)
  const rows = (await db.all<CallRow>('SELECT id, tool, created_at FROM mcp_call_logs ORDER BY created_at ASC, id ASC')) as CallRow[]
  await db.close()

  // 会话聚类：相邻保留记录间隔 > 30 分钟则切分；无法解析的时间戳行剔除并计数（不静默吞掉）
  const sessions: Event[][] = []
  let skippedRows = 0
  for (const row of rows) {
    const t = parseTs(row.created_at)
    if (t === null) {
      skippedRows++
      continue
    }
    const event: Event = { tool: row.tool, t, raw: row.created_at! }
    const last = sessions[sessions.length - 1]
    if (!last || event.t - last[last.length - 1].t > SESSION_GAP_MS) {
      sessions.push([event])
    } else {
      last.push(event)
    }
  }

  const withSearch = sessions.filter(s => s.some(e => e.tool === TOOL_SEARCH))
  const withRead = sessions.filter(s => s.some(e => e.tool === TOOL_READ))
  const level1Done = withSearch.filter(s => funnelDone(s, TOOL_SEARCH, TOOL_READ)).length
  const level2Done = withRead.filter(s => funnelDone(s, TOOL_READ, TOOL_SOURCE)).length

  const kept = sessions.flat()
  const metrics: Metrics = {
    totalSessions: sessions.length,
    sessionsWithSearch: withSearch.length,
    level1Rate: rate(level1Done, withSearch.length),
    level2Rate: rate(level2Done, withRead.length),
    sessionsWithRead: withRead.length,
    level1Done,
    level2Done,
    totalCalls: rows.length,
    firstCallAt: kept.length > 0 ? kept[0].raw : null,
    lastCallAt: kept.length > 0 ? kept[kept.length - 1].raw : null,
    skippedRows,
    dbPath,
    generatedAt: new Date().toISOString()
  }

  // stdout 人可读统计
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  console.log(`MCP 消费链路漏斗（${TOOL_SEARCH} → ${TOOL_READ} → ${TOOL_SOURCE}）`)
  console.log(`库: ${dbPath}（只读）`)
  console.log(`记录: ${metrics.totalCalls} 条${skippedRows > 0 ? `（剔除非法时间戳 ${skippedRows} 条）` : ''}`)
  console.log(`时间范围: ${metrics.firstCallAt ?? '-'} ~ ${metrics.lastCallAt ?? '-'}`)
  console.log(`会话总数: ${metrics.totalSessions}（相邻调用间隔 ≤ 30 分钟归同一会话）`)
  console.log(`含 ${TOOL_SEARCH} 会话: ${metrics.sessionsWithSearch}`)
  console.log(`一级链路（search → 30min 内 read_entry）: ${level1Done}/${withSearch.length} = ${pct(metrics.level1Rate)}`)
  console.log(`二级链路（read_entry → 30min 内 get_source）: ${level2Done}/${withRead.length} = ${pct(metrics.level2Rate)}`)

  if (jsonOut) {
    await fs.writeFile(jsonOut, JSON.stringify(metrics, null, 2) + '\n', 'utf8')
    console.log(`指标 JSON 已写入: ${jsonOut}`)
  }

  // 空表约定：exit 0 且输出各指标为 0 的合法 JSON，不抛错
  if (metrics.totalCalls === 0) {
    console.log(JSON.stringify(metrics, null, 2))
  }
}

main().catch(err => {
  console.error('mcpFunnel 执行失败:', err?.message ?? err)
  process.exit(1)
})
