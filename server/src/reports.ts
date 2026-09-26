import path from 'path'
import fs from 'fs/promises'
import { SqliteDatabase } from '@homeofthings/sqlite3'
import { DATA_DIR, getDb } from './db.js'
import { selectDailyPicks, localDateStr } from './routes/recommend.js'
import { suppressionToday } from './attention.js'
import { buildWeeklyDigest } from './weeklyDigest.js'
import { cleanTitle, cleanSummary } from './formatter.js'

// 日报日期严格 YYYY-MM-DD：既是文件名白名单，也是定时任务跨天判断的「日」口径
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 日报落盘目录：<DATA_DIR>/reports/daily/（生产即 server/data/reports/daily/）。
 * 豁免说明：server/data 本就不在用户配置的已启用扫描根内（扫描根是用户内容目录），
 * 日报是平台自产推式出口而非采集对象，无需也不应过 withinScanRoots 校验。
 */
export function dailyReportsDir(): string {
  return path.join(DATA_DIR, 'reports', 'daily')
}

export interface DailyReportResult {
  generated: boolean
  date: string
  path?: string
}

/** 当日新增蒸馏产物统计：wiki_entries_meta.distilled_at 由 CURRENT_TIMESTAMP 写入（UTC 日期即前 10 位），无产出日自然得 0 */
async function distillStats(db: SqliteDatabase, date: string): Promise<{ count: number; avgQuality: number | null }> {
  const row = await (await db.prepare(
    'SELECT COUNT(*) AS n, AVG(quality_score) AS avg_quality FROM wiki_entries_meta WHERE substr(distilled_at, 1, 10) = ?'
  )).get([date]) as any
  return {
    count: Number(row?.n || 0),
    avgQuality: row?.avg_quality != null ? Number(row.avg_quality) : null
  }
}

/** HTML 文本转义（日报为静态模板，内容含用户文件标题/路径，必须防注入） */
function escapeHtml(v: any): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 「安全忽略」段正文（P1-5 抑制指标可解释性）：六项计数全 0 整段跳过（cooling 默认关时即此态）；
 *  模拟配额溢出仅在 >0 时追加（智谱观测仪表，只记不拦） */
function suppressionText(sup: Record<string, number> | undefined): string | null {
  if (!sup) return null
  const hasAny = [sup.collected, sup.deduped, sup.cooling_alive, sup.cooling_died, sup.delivered, sup.digested]
    .some(v => Number(v) > 0)
  if (!hasAny) return null
  let t = `今日入库 ${sup.collected} · 去重拦下 ${sup.deduped} · 冷却中 ${sup.cooling_alive} · 冷却期死亡 ${sup.cooling_died}`
  if (Number(sup.simulated_quota_overflow) > 0) t += ` · 模拟配额溢出 ${sup.simulated_quota_overflow}（若配额 30 生效今日超额，仅观测）`
  return t
}

function renderMarkdown(date: string, stats: { count: number; avgQuality: number | null }, picks: any[], sup?: Record<string, number>): string {
  const lines: string[] = []
  lines.push(`# AgentFeed 日报 ${date}`)
  lines.push('')
  const avg = stats.avgQuality != null ? `（平均质量分 ${stats.avgQuality.toFixed(1)}）` : ''
  lines.push(`- 当日新增蒸馏产物：${stats.count} 篇${avg}`)
  lines.push('')
  const supText = suppressionText(sup)
  if (supText) {
    lines.push('## 安全忽略')
    lines.push(`- ${supText}`)
    lines.push('')
  }
  lines.push('## 值得看 3 篇')
  if (!picks.length) lines.push('- 今日暂无推荐')
  for (const p of picks) {
    const bits = [
      p.domain_name || '未分类',
      p.outOfPool ? '池外推荐' : '',
      p.quality_score != null ? `AI 评分 ${Number(p.quality_score).toFixed(1)}` : ''
    ].filter(Boolean)
    lines.push(`- ${p.title}${bits.length ? `（${bits.join(' · ')}）` : ''}`)
    lines.push(`  - 路径：${p.path}`)
    if (p.reason) lines.push(`  - ${p.reason}`)
  }
  return lines.join('\n') + '\n'
}

function renderHtml(date: string, stats: { count: number; avgQuality: number | null }, picks: any[], sup?: Record<string, number>): string {
  const avg = stats.avgQuality != null ? `（平均质量分 ${escapeHtml(stats.avgQuality.toFixed(1))}）` : ''
  const supText = suppressionText(sup)
  const supHtml = supText ? `<h2>安全忽略</h2>\n<p>${escapeHtml(supText)}</p>\n` : ''
  const itemsHtml = picks.length
    ? picks.map(p => `
    <li>
      <div class="title">${escapeHtml(p.title)}${p.outOfPool ? ' <span class="tag">池外推荐</span>' : ''}</div>
      <div class="meta">${escapeHtml(p.domain_name || '未分类')}${p.quality_score != null ? ` · AI 评分 ${escapeHtml(Number(p.quality_score).toFixed(1))}` : ''}</div>
      ${p.reason ? `<div class="reason">${escapeHtml(p.reason)}</div>` : ''}
      <div class="path">${escapeHtml(p.path)}</div>
    </li>`).join('\n')
    : '    <li class="empty">今日暂无推荐</li>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AgentFeed 日报 ${escapeHtml(date)}</title>
<style>
  body { font-family: -apple-system, 'PingFang SC', sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #303133; line-height: 1.6 }
  h1 { font-size: 22px } h2 { font-size: 17px } .meta { color: #909399; font-size: 13px }
  .path { color: #b0b3b8; font-size: 12px; word-break: break-all } .reason { font-size: 13px; color: #606266 }
  .tag { background: #f0f9eb; color: #67c23a; font-size: 12px; padding: 1px 6px; border-radius: 3px }
  ol { padding-left: 20px } li { margin-bottom: 14px }
</style>
</head>
<body>
<h1>AgentFeed 日报 · ${escapeHtml(date)}</h1>
<p>当日新增蒸馏产物：<strong>${stats.count}</strong> 篇${avg}</p>
${supHtml}
<h2>值得看 3 篇</h2>
<ol>
${itemsHtml}
</ol>
</body>
</html>
`
}

/**
 * 生成每日日报（md + html 双格式落盘），幂等：两份产物均已存在则跳过不覆盖，同一天重复触发只写一次盘。
 * 「值得看 3 篇」复用 selectDailyPicks 的轮转选取，与 /api/recommend/daily 同一天结果一致；
 * 无蒸馏产出 / 空推荐池的日子也生成合法日报（日报时间序列不允许断档）。
 */
export async function generateDailyReport(db: SqliteDatabase, date: string): Promise<DailyReportResult> {
  if (!DATE_RE.test(date)) throw new Error(`日报日期需为 YYYY-MM-DD：${date}`)
  const dir = dailyReportsDir()
  const mdPath = path.join(dir, `${date}.md`)
  const htmlPath = path.join(dir, `${date}.html`)
  if (await fs.stat(mdPath).catch(() => null)) {
    if (await fs.stat(htmlPath).catch(() => null)) return { generated: false, date, path: htmlPath }
  }
  const stats = await distillStats(db, date)
  // P1-5：抑制指标（今日入库/去重/冷却池状态），进「安全忽略」段——全 0 时渲染层自动跳过
  const sup = await suppressionToday()
  // A3 出口层清洗：脏 title / 超长 reason 只在渲染层改写（md/html 双格式共用此映射），库内不回写
  const picks = (await selectDailyPicks(db, date)).map(p => ({
    ...p,
    title: typeof p.title === 'string' ? cleanTitle(p.title) : p.title,
    reason: typeof p.reason === 'string' ? cleanSummary(p.reason) : p.reason,
  }))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(mdPath, renderMarkdown(date, stats, picks, sup), 'utf8')
  await fs.writeFile(htmlPath, renderHtml(date, stats, picks, sup), 'utf8')
  return { generated: true, date, path: htmlPath }
}

/**
 * 日报定时任务（对齐 index.ts 既有周期 job 写法）：boot 延迟补当天（已存在则幂等跳过），
 * 此后每 5 分钟检查——跨天 / 当日文件缺失时由 generateDailyReport 的文件存在性幂等兜底生成。
 */
export function startDailyReportJob() {
  const ensure = async () => {
    try {
      const db = await getDb()
      const r = await generateDailyReport(db, localDateStr(new Date()))
      if (r.generated) console.log(`daily report generated: ${r.date} -> ${r.path}`)
      // P2-5/2-6：周日顺带触发周度一页纸（幂等由周文件存在性保证；非周日零开销）
      if (new Date().getDay() === 0) {
        const w = await buildWeeklyDigest(new Date())
        if (w.generated) console.log(`weekly digest generated: ${w.week} -> ${w.path}`)
      }
    } catch (e) {
      console.error('daily report job failed', e)
    }
  }
  setTimeout(() => { ensure() }, 10 * 1000)
  setInterval(() => { ensure() }, 5 * 60 * 1000)
}
