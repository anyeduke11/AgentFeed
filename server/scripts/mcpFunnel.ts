/**
 * MCP 消费链路漏斗分析 + 断链归因（E1，v0.1.5）
 *
 * 只读打开 mcp_call_logs（绝不写库、不做迁移），按时间升序做会话聚类：
 * 同一会话内相邻两次调用间隔 ≤ 30 分钟，超过则切分新会话。输出指标：
 *   - totalSessions        总会话数
 *   - sessionsWithSearch   含 search_knowledge 的会话数（一级链路分母）
 *   - level1Rate           一级链路完成率 = search 后同会话 30 分钟内跟随 read_entry 的会话占比
 *   - level2Rate           二级链路完成率 = read_entry 后同会话 30 分钟内跟随 get_source 的占比
 *                          （分母 = 含 read_entry 的会话数）
 *
 * 断链归因（--attrib，缺省开启；--no-attrib 关闭）：对每条 search 调用输出
 *   query（args 提取）→ 重放 Top-3（轻量双路 wiki_fts MATCH + files LIKE，不 import src 模块，
 *   避免只读脚本经 getDb 触发真实库迁移副作用；向量路不参与，重放漂移口径见 PRD E1）
 *   → 30 分钟窗口内有无 read_entry → 分类：
 *   followed     跟随深读（链路健康，不归因）
 *   args_null    args 缺失（存量埋点缺口，不可归因，单列计数不混入四分类）
 *   weak_match   Top-3 与 query 词面重合度低（疑似检索质量 → A1/A2 是解药）
 *   needs_review 词面重合尚可但未深读（summary 够用 or 工具描述未引导，人工复核）
 * 词面重合 = query 的 CJK 二元组在 Top-3 title+summary 命中比例 ≥0.2（确定性初筛启发式）
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
// 纯计算核心与诊断面板 API 共享（src/funnelCore.ts）——脚本与面板数字漂移即 bug
import {
  SESSION_GAP_MS, WEAK_MATCH_THRESHOLD, TOOL_SEARCH, TOOL_READ, TOOL_SOURCE,
  clusterSessions, computeFunnel, followedWithin, extractQuery, queryTerms, overlapRatio,
  type FunnelCallRow, type FunnelEvent, type Attribution
} from '../src/funnelCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface AttributionRow {
  logId: number
  ts: string
  query: string | null
  top3: { id: number, title: string }[]
  overlap: number | null
  classification: Attribution
}

interface Metrics {
  totalSessions: number
  sessionsWithSearch: number
  level1Rate: number
  level2Rate: number
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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 轻量重放 Top-3：wiki_fts MATCH + files LIKE 双路（只读、离线；口径=关键词路近似） */
async function replayTop3(db: SqliteDatabase, query: string): Promise<{ id: number, title: string }[]> {
  const like = `%${query.replace(/[%_]/g, ' ').slice(0, 60)}%`
  try {
    const fts = await db.all<{ id: number, title: string }>(
      `SELECT f.id AS id, COALESCE(NULLIF(w.title, ''), f.title, f.name) AS title
       FROM wiki_fts ft JOIN wiki_entries_meta w ON w.id = ft.entry_id JOIN files f ON f.id = w.file_id
       WHERE wiki_fts MATCH ? LIMIT 3`, [`"${query.replace(/"/g, ' ')}"`])
    if (fts.length > 0) return fts.map(r => ({ id: Number(r.id), title: String(r.title || '') }))
  } catch { /* FTS 语法异常或表缺失 → 落 LIKE */ }
  const likeRows = await db.all<{ id: number, title: string }>(
    `SELECT id, COALESCE(NULLIF(title, ''), name) AS title FROM files
     WHERE status = 'active' AND (title LIKE ? OR name LIKE ?) LIMIT 3`, [like, like])
  return likeRows.map(r => ({ id: Number(r.id), title: String(r.title || '') }))
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
  const attribEnabled = !process.argv.includes('--no-attrib')
  const rows = (await db.all<FunnelCallRow>('SELECT id, tool, args, created_at FROM mcp_call_logs ORDER BY created_at ASC, id ASC')) as FunnelCallRow[]

  // 会话聚类 + 漏斗指标：与诊断面板 API 共用 funnelCore（数字漂移即 bug）
  const { sessions, skipped: skippedRows } = clusterSessions(rows)
  const funnel = computeFunnel(sessions, skippedRows, rows.length)

  const kept = sessions.flat()
  const metrics: Metrics = {
    ...funnel,
    firstCallAt: kept.length > 0 ? kept[0].raw : null,
    lastCallAt: kept.length > 0 ? kept[kept.length - 1].raw : null,
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
  console.log(`一级链路（search → 30min 内 read_entry）: ${funnel.level1Done}/${funnel.sessionsWithSearch} = ${pct(metrics.level1Rate)}`)
  console.log(`二级链路（read_entry → 30min 内 get_source）: ${funnel.level2Done}/${funnel.sessionsWithRead} = ${pct(metrics.level2Rate)}`)

  // ---- 断链归因（E1）：逐条 search 调用 → query/Top-3/跟随 → 四分类计数（口径同 funnelCore.attributeSearches，此处保留全量明细行） ----
  const attribCounts: Record<Attribution, number> = { followed: 0, args_null: 0, weak_match: 0, needs_review: 0 }
  const attribRows: AttributionRow[] = []
  if (attribEnabled) {
    for (const s of sessions) {
      if (!s.some(e => e.tool === TOOL_SEARCH)) continue
      for (const e of s) {
        if (e.tool !== TOOL_SEARCH) continue
        const followed = followedWithin(s, e, TOOL_READ)
        const query = extractQuery(e.args)
        if (followed) {
          attribCounts.followed++
          attribRows.push({ logId: e.id, ts: e.raw, query, top3: [], overlap: null, classification: 'followed' })
          continue
        }
        if (query === null) {
          attribCounts.args_null++
          attribRows.push({ logId: e.id, ts: e.raw, query: null, top3: [], overlap: null, classification: 'args_null' })
          continue
        }
        const top3 = await replayTop3(db, query)
        const doc = top3.map(r => r.title).join(' ')
        const ov = overlapRatio(queryTerms(query), doc)
        const cls: Attribution = ov !== null && ov < WEAK_MATCH_THRESHOLD ? 'weak_match' : 'needs_review'
        attribCounts[cls]++
        attribRows.push({ logId: e.id, ts: e.raw, query, top3, overlap: ov, classification: cls })
      }
    }
    console.log(`\n断链归因（level1 未跟随的 search 调用分类；重放=关键词路近似，漂移口径见 PRD E1）`)
    console.log(`  followed（跟随深读）: ${attribCounts.followed}`)
    console.log(`  args_null（存量埋点缺口，不可归因）: ${attribCounts.args_null}`)
    console.log(`  weak_match（疑似检索质量问题 → A1/A2 解药）: ${attribCounts.weak_match}`)
    console.log(`  needs_review（summary 够用 or 工具描述未引导，人工复核）: ${attribCounts.needs_review}`)
    const sample = attribRows.filter(r => r.classification !== 'followed').slice(0, 10)
    if (sample.length > 0) {
      console.log(`  明细（前 10 条）：`)
      for (const r of sample) {
        console.log(`    #${r.logId} [${r.classification}] query=${r.query ?? '∅'} overlap=${r.overlap ?? '-'} top3=${r.top3.map(t => t.title.slice(0, 24)).join(' | ') || '-'}`)
      }
    }
    ;(metrics as any).attribution = { counts: attribCounts, threshold: WEAK_MATCH_THRESHOLD, rows: attribRows }
  }
  await db.close()

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
