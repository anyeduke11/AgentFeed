/**
 * 检索基线重放：对一组 query 逐条调用 search_knowledge 共享核心（searchKnowledgeCore，limit 3），
 * 生成 Top-3 markdown 对比表，作为 Phase 2 检索改造（LIKE → 更强检索）的验收对照组。
 *
 * 只读打开库（OPEN_READONLY，绝不写库、不做迁移、不开 WAL）。
 *
 * query 来源三级降级（取第一个非空来源，高优先级在前）：
 *   1. CLI 文件参数：npx tsx server/scripts/searchBaseline.ts <queries.txt>（每行一条，空行忽略，去重）
 *   2. 真实库 mcp_call_logs 中 tool='search_knowledge' 的 args（JSON 摘要，超 200 字符被截断，
 *      JSON.parse 失败的行跳过并计数），提取 args.query 非空字符串，按首次出现顺序去重
 *   3. 前两级都拿不到任何 query → 使用脚本内置 20 条代表性兜底 query（见 FALLBACK_QUERIES 注释）
 *
 * 用法：
 *   npx tsx server/scripts/searchBaseline.ts [queries.txt] [--db <sqlite 路径>]
 *   --db 缺省 = $AGENTFEED_DATA_DIR/app.db，未设环境变量时为 server/data/app.db（与 src/db.ts 口径一致）
 *   markdown 表输出到 stdout（可重定向落盘）；进度/来源信息走 stderr，不污染重定向结果
 *
 * 空库约定：库为空或表无数据（含表不存在）时正常生成表格（结果列写「（无结果）」），exit 0 不抛错；
 * 其余错误（如库文件不存在）fail loud，exit 1。
 *
 * 验证方式（临时库，不触碰真实库）：
 *   1) 空表：建临时库并建空表 files/domains/tags/file_tags/mcp_call_logs，
 *      跑 npx tsx server/scripts/searchBaseline.ts --db /tmp/xxx.db → exit 0，20 条兜底 query 全「（无结果）」
 *   2) 真实库：npx tsx server/scripts/searchBaseline.ts --db server/data/app.db > /tmp/baseline.md，
 *      核对表格行数与 query 来源说明一致
 */

import { SqliteDatabase, OPEN_READONLY } from '@homeofthings/sqlite3'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { searchKnowledgeCore } from '../src/knowledge.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TOP_N = 3
const SUMMARY_CLIP = 80
// title 截断阈值：语料存在 title 长达 11 万字符的脏数据（正常标题远短于此），
// 不截断会让单行表格膨胀到 20 万+ 字符，无法人工标注。截断仅为可读性，不影响检索行为本身。
const TITLE_CLIP = 60

// 兜底查询集（20 条）设计意图：三级来源的最后防线，保证任何环境（空库/无日志）都能产出可用基线表。
// 覆盖维度（各维度取高频、常见词，便于跨语料复用）：
//   - 英文 title 命中：知识库标题里高频出现的技术名词
//   - 中文 title/summary 命中：中文摘要常见的描述性词
//   - path 片段命中：目录/文件名常见片段（LIKE 会扫 path 字段）
//   - 常见领域词（中文）：领域分类词汇，观察领域词在 title/summary/path 三字段的分布
//   - 故意 miss：低概率出现在语料中的造词，钉住「查不到时的空结果行为」
const FALLBACK_QUERIES = [
  // 英文 title 命中
  'MCP', 'LLM', 'Agent', 'SQLite', 'scanner',
  // 中文 title/summary 命中
  '架构', '指南', '实践', '总结', '蒸馏',
  // path 片段命中
  'server', 'web', 'README', 'docs', 'config',
  // 常见领域词（中文）
  '前端', '后端', '数据库',
  // 故意 miss
  'zzxq自造词mISS', 'quantum-blockchain-xyz'
]

interface ReplayResult {
  // query 实际来源：'file'（CLI 文件）/ 'logs'（mcp_call_logs）/ 'fallback'（内置兜底）
  source: 'file' | 'logs' | 'fallback'
  queries: string[]
  // 来源为 logs 时的辅助统计：JSON 解析失败跳过的行数（0 表示无跳过或不适用）
  skippedLogRows: number
  rows: QueryRow[]
}

interface QueryRow {
  query: string
  results: Array<{ id: number; title: string; summary: string }>
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 位置参数：第一个既不是 --flag 也不是某个 --flag 取值的参数（即 queries 文件路径） */
function positionalArg(): string | undefined {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') { i++; continue }
    if (!argv[i].startsWith('--')) return argv[i]
  }
  return undefined
}

/** 库为空（表不存在）视为合法空数据；其余错误原样上抛，fail loud */
function isNoSuchTable(err: unknown): boolean {
  return String((err as any)?.message ?? err).includes('no such table')
}

/** 来源 1：读取 CLI 指定的 queries 文件，每行一条，去空行，按首次出现顺序去重 */
async function queriesFromFile(file: string): Promise<string[]> {
  const text = await fs.readFile(file, 'utf8')
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
  return [...new Set(lines)]
}

// mcp_call_logs 中 search_knowledge 的落库行（args 为 JSON 摘要，可能因 200 字符截断而无法解析）
interface LogRow { args: string | null }

/** 来源 2：从真实库 mcp_call_logs 提取 search_knowledge 的 query，跳过解析失败行，按首次出现顺序去重 */
async function queriesFromLogs(db: SqliteDatabase): Promise<{ queries: string[]; skipped: number }> {
  let rows: LogRow[]
  try {
    rows = (await db.all<LogRow>(
      "SELECT args FROM mcp_call_logs WHERE tool = 'search_knowledge' ORDER BY id ASC"
    )) as LogRow[]
  } catch (err) {
    if (isNoSuchTable(err)) return { queries: [], skipped: 0 }
    throw err
  }
  const queries: string[] = []
  let skipped = 0
  for (const row of rows) {
    if (!row.args) continue
    let parsed: any
    try {
      parsed = JSON.parse(row.args)
    } catch {
      skipped++ // 截断/非法 JSON：跳过并计数，不静默吞掉
      continue
    }
    const q = typeof parsed?.query === 'string' ? parsed.query.trim() : ''
    if (q.length > 0 && !queries.includes(q)) queries.push(q)
  }
  return { queries, skipped }
}

/** 压缩空白并转义竖线，保证 markdown 单元格单行安全 */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/** 单个 Top-N 单元格：#id 标题（超 60 字符截断）· 摘要前 80 字符；无该位结果时写「（无结果）」 */
function topCell(row: QueryRow, n: number): string {
  const r = row.results[n]
  if (!r) return '（无结果）'
  const title = r.title.length > TITLE_CLIP ? r.title.slice(0, TITLE_CLIP) + '…' : r.title
  return `#${r.id} ${cell(title)} · ${cell((r.summary ?? '').slice(0, SUMMARY_CLIP))}`
}

/** 重放全部 query：逐条调用 searchKnowledgeCore（limit 3）；单条失败且因表不存在 → 空结果 */
async function replay(db: SqliteDatabase, queries: string[]): Promise<QueryRow[]> {
  const rows: QueryRow[] = []
  for (const query of queries) {
    let results: any[]
    try {
      results = await searchKnowledgeCore(db, { query, limit: TOP_N })
    } catch (err) {
      if (!isNoSuchTable(err)) throw err
      results = []
    }
    rows.push({
      query,
      results: results.map(r => ({ id: r.id, title: r.title ?? '', summary: r.summary ?? '' }))
    })
  }
  return rows
}

const SOURCE_LABEL: Record<ReplayResult['source'], string> = {
  file: '第 1 级：CLI queries 文件',
  logs: '第 2 级：真实库 mcp_call_logs 中 search_knowledge 的 args.query（截断 JSON 解析失败的行已跳过）',
  fallback: '第 3 级：脚本内置兜底 query 集（前两级均无可用 query）'
}

async function main() {
  const dbPath = argValue('--db')
    ? path.resolve(argValue('--db')!)
    : path.join(
        process.env.AGENTFEED_DATA_DIR ? path.resolve(process.env.AGENTFEED_DATA_DIR) : path.resolve(__dirname, '../data'),
        'app.db'
      )
  const queriesFile = positionalArg()

  // 只读模式打开：保证对真实库零写入（不开 WAL、不跑迁移）；库文件不存在会在此抛错（fail loud）
  const db = await SqliteDatabase.open(dbPath, OPEN_READONLY)

  // 三级降级取 query 来源
  let source: ReplayResult['source'] = 'fallback'
  let queries: string[] = []
  let skippedLogRows = 0
  if (queriesFile) {
    queries = await queriesFromFile(queriesFile)
    if (queries.length > 0) source = 'file'
    console.error(`来源 1（文件 ${queriesFile}）: ${queries.length} 条`)
  }
  if (queries.length === 0) {
    const fromLogs = await queriesFromLogs(db)
    skippedLogRows = fromLogs.skipped
    if (fromLogs.queries.length > 0) {
      source = 'logs'
      queries = fromLogs.queries
    }
    console.error(`来源 2（mcp_call_logs）: ${fromLogs.queries.length} 条（JSON 解析失败跳过 ${fromLogs.skipped} 行）`)
  }
  if (queries.length === 0) {
    source = 'fallback'
    queries = FALLBACK_QUERIES
    console.error(`来源 3（内置兜底）: ${FALLBACK_QUERIES.length} 条`)
  }

  const rows = await replay(db, queries)
  // 注意：不调用 db.close()——searchKnowledgeCore 内部 prepare 的 statement 未暴露 finalize，
  // close 会报 SQLITE_BUSY: unable to close due to unfinalized statements。
  // 本脚本是一次性只读 CLI，进程退出时由 OS 回收连接；OPEN_READONLY 模式下无任何写残留风险。

  const generatedAt = new Date().toISOString().slice(0, 10)
  const reproCmd = queriesFile
    ? `npx tsx server/scripts/searchBaseline.ts ${queriesFile} --db ${dbPath}`
    : `npx tsx server/scripts/searchBaseline.ts --db ${dbPath}`

  // stdout = 纯 markdown 文档，可直接重定向落盘
  const out: string[] = []
  out.push(`## 正文：search_knowledge Top-3 重放（生成于 ${generatedAt}，复现命令：\`${reproCmd}\`）`)
  out.push('')
  const skippedNote = source === 'logs' && skippedLogRows > 0 ? `；解析失败跳过 ${skippedLogRows} 行` : ''
  out.push(`query 来源：${SOURCE_LABEL[source]}，去重后共 ${queries.length} 条${skippedNote}。库：\`${dbPath}\`（只读）。`)
  out.push('')
  out.push('| # | query | Top-1 | Top-2 | Top-3 | 标注 |')
  out.push('| --- | --- | --- | --- | --- | --- |')
  rows.forEach((row, i) => {
    out.push(`| ${i + 1} | ${cell(row.query)} | ${topCell(row, 0)} | ${topCell(row, 1)} | ${topCell(row, 2)} |  |`)
  })
  out.push('')
  out.push('> 标注说明：hit=精准命中 / partial=部分相关 / miss=不相关。本表为 Phase 2 检索改造（LIKE → 更强检索）的验收对照组。')
  console.log(out.join('\n'))
}

main().catch(err => {
  console.error('searchBaseline 执行失败:', err?.message ?? err)
  process.exit(1)
})
