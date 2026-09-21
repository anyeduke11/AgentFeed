/**
 * I2 关联度脚本：read_history（近 30 天）按 30 分钟间隔聚类为阅读会话（簇），按域打主题标签，
 * 输出 markdown（簇表 + 汇总）到 stdout——回答「用户在什么主题上连续投入、是否发生跨域学习」。
 *
 * 范式对齐 searchBaseline.ts：只读打开库（OPEN_READONLY，绝不写库、不开 WAL）；--db 缺省 =
 * $AGENTFEED_DATA_DIR/app.db，未设环境变量时为 server/data/app.db（与 src/db.ts 口径一致）；
 * 空库（表不存在或无数据）正常输出空汇总，exit 0 不抛错；其余错误（如库文件不存在）fail loud，exit 1。
 *
 * 聚类/标注逻辑在 src/readAffinityCore.ts（与测试共享同一口径）。
 *
 * 用法：
 *   npx tsx server/scripts/readAffinity.ts [--db <sqlite 路径>]
 *   markdown 输出到 stdout（可重定向落盘）；进度信息走 stderr，不污染重定向结果
 */

import { SqliteDatabase, OPEN_READONLY } from '@homeofthings/sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { clusterReads, labelClusters, domainOf, UNCLASSIFIED, type ReadHistoryRow } from '../src/readAffinityCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TOP_DOMAINS = 5

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 库为空（表不存在）视为合法空数据；其余错误原样上抛，fail loud */
function isNoSuchTable(err: unknown): boolean {
  return String((err as any)?.message ?? err).includes('no such table')
}

/** 压缩空白并转义竖线，保证 markdown 单元格单行安全 */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

async function main() {
  const dbPath = argValue('--db')
    ? path.resolve(argValue('--db')!)
    : path.join(
        process.env.AGENTFEED_DATA_DIR ? path.resolve(process.env.AGENTFEED_DATA_DIR) : path.resolve(__dirname, '../data'),
        'app.db'
      )

  // 只读模式打开：保证对真实库零写入（不开 WAL、不跑迁移）；库文件不存在会在此抛错（fail loud）
  const db = await SqliteDatabase.open(dbPath, OPEN_READONLY)

  let rows: ReadHistoryRow[] = []
  try {
    rows = (await db.all<ReadHistoryRow>(
      "SELECT id, file_id, path, source, opened_at FROM read_history WHERE opened_at >= datetime('now', '-30 days') ORDER BY opened_at ASC, id ASC"
    )) as ReadHistoryRow[]
  } catch (err) {
    if (!isNoSuchTable(err)) throw err
  }
  console.error(`read_history（近 30 天）: ${rows.length} 条`)

  const fileDomainMap = new Map<number, string | null>()
  try {
    const frows = (await db.all<{ id: number, domain: string | null }>(
      'SELECT f.id AS id, d.name AS domain FROM files f LEFT JOIN domains d ON d.id = f.domain_id'
    )) as Array<{ id: number, domain: string | null }>
    for (const r of frows) fileDomainMap.set(Number(r.id), r.domain == null ? null : String(r.domain))
  } catch (err) {
    if (!isNoSuchTable(err)) throw err
  }

  const { clusters, skipped } = clusterReads(rows)
  const labeled = labelClusters(clusters, fileDomainMap)

  // 最常出现域 Top5：按全部事件域计数（含未分类）
  const totals = new Map<string, number>()
  for (const ev of clusters.flat()) {
    const name = domainOf(ev, fileDomainMap)
    totals.set(name, (totals.get(name) || 0) + 1)
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_DOMAINS)

  // stdout = 纯 markdown 文档，可直接重定向落盘
  const out: string[] = []
  out.push(`## 阅读关联度（近 30 天，生成于 ${new Date().toISOString().slice(0, 10)}）`)
  out.push('')
  out.push(`库：\`${dbPath}\`（只读）。阅读记录 ${rows.length} 条（时间戳非法跳过 ${skipped} 条），聚类为 ${labeled.length} 簇（相邻打开间隔 ≤30 分钟同簇；簇内出现 ≥2 次的域为主域，跨 ≥2 域的簇即学习路径候选）。`)
  out.push('')
  if (labeled.length) {
    out.push('| # | 时间范围 | 文件数 | 主域 | 域序列 |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const c of labeled) {
      const primary = c.primaryDomains.length ? c.primaryDomains.join('、') : '（无 ≥2 次域）'
      const seq = c.domainSeq.length >= 2 ? c.domainSeq.join(' → ') : (c.domainSeq[0] || UNCLASSIFIED)
      out.push(`| ${c.id} | ${cell(c.startsAt)} ~ ${cell(c.endsAt)} | ${c.fileCount} | ${cell(primary)} | ${cell(seq)} |`)
    }
    out.push('')
  }
  const cross = labeled.filter(c => c.crossDomain).length
  out.push('### 汇总')
  out.push('')
  out.push(`- 总簇数：${labeled.length}`)
  out.push(`- 跨域簇数：${cross}${labeled.length ? `（${Math.round((cross / labeled.length) * 100)}%）` : ''}`)
  out.push(`- 最常出现域 Top${TOP_DOMAINS}：${top.length ? top.map(([d, n]) => `${d}×${n}`).join('、') : '（无数据）'}`)
  console.log(out.join('\n'))
}

main().catch(err => {
  console.error('readAffinity 执行失败:', err?.message ?? err)
  process.exit(1)
})
