import path from 'path'
import fs from 'fs/promises'
import { DATA_DIR, getDb } from './db.js'

/** 周报落盘目录：<DATA_DIR>/reports/weekly/（同日报豁免口径：平台自产推式出口，不在扫描根校验范围） */
export function weeklyReportsDir(): string {
  return path.join(DATA_DIR, 'reports', 'weekly')
}

/** ISO 周键（YYYY-Wnn）：周一为一周起点，ISO 年 = 含该周首个周四的年份 */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400e3 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** UTC 'YYYY-MM-DD HH:MM:SS'（wiki_entries_meta.distilled_at 为 CURRENT_TIMESTAMP 同形态，可直接比较） */
const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')

export interface WeeklyCluster { domain: string; count: number; paragraph: string }

export interface WeeklyDigestResult {
  generated: boolean
  week: string
  path?: string
  clusters: WeeklyCluster[]
  skipped: number
}

/**
 * 周度一页纸（P2-5/2-6）：本周（sunday 本地零点前 6 天 ~ sunday 本地零点，即周一 00:00 ~
 * 周日 00:00 本地）蒸馏条目按领域分簇。窗口端点锚定本地零点而非运行时刻（review Minor 2）——
 * 旧实现 start = 运行时刻 - 6 天，周日首个 tick（00:05）会把窗口起点钉在周一 00:05，
 * 每周周一 00:00-00:05 的蒸馏条目永久落缝。
 * 分簇口径：hook.action ∈ {keep, act_now} 为主信号入簇；schedule 及无 hook 存量条目
 * 同样入簇（周报不静默丢条目——计划参考实现即此口径）；action='ignore' 计入 skipped，
 * 与 suppressionToday 安全忽略段对账。每簇段落：本地统计句兜底；ai.autoTag 开启时
 * 尝试 LLM 增强段（单簇失败降级回兜底句，不阻塞整报）。落盘 md + clusters JSON。
 * 幂等前置（review Important）：同周 md 已存在直接返回缓存结果，不重跑聚类/LLM——否则周日
 * 每 5 分钟的 ensure() tick 都会整批重调 LLM 后丢弃。缓存读同伴 .json 的 clusters/skipped；
 * json 缺失/损坏时返空簇（md 本身仍是完整一页纸，仅结构化数据缺失），path 指向既有 md。
 */
export async function buildWeeklyDigest(sunday: Date): Promise<WeeklyDigestResult> {
  const week = isoWeekKey(sunday)
  const dir = weeklyReportsDir()
  const mdPath = path.join(dir, `${week}.md`)
  if (await fs.stat(mdPath).catch(() => null)) {
    let clusters: WeeklyCluster[] = []
    let skipped = 0
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, `${week}.json`), 'utf8'))
      if (Array.isArray(j?.clusters)) clusters = j.clusters
      skipped = Number(j?.skipped) || 0
    } catch { /* 同伴 json 缺失/损坏 → 空簇缓存语义 */ }
    return { generated: false, week, path: mdPath, clusters, skipped }
  }
  const db = await getDb()
  // 窗口端点 = sunday 本地零点（exclusive），start = 端点前 6 天（同为本地零点）
  const end = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate())
  const start = new Date(end.getTime() - 6 * 86400e3)
  const rows = await (await db.prepare(`
    SELECT COALESCE(d.name, '未分类') AS domain, m.title, m.hook
    FROM wiki_entries_meta m JOIN files f ON f.id = m.file_id
    LEFT JOIN domains d ON d.id = f.domain_id
    WHERE m.distilled_at >= datetime(?) AND m.distilled_at < datetime(?)
      AND f.status = 'active'`)).all([utcStr(start), utcStr(end)]) as any[]
  const byDomain = new Map<string, { title: string; hook: any }[]>()
  let skipped = 0
  for (const r of rows) {
    let hook: any = null
    try { hook = r.hook ? JSON.parse(r.hook) : null } catch { hook = null }
    if (hook && hook.action === 'ignore') { skipped++; continue }
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, [])
    byDomain.get(r.domain)!.push({ title: r.title, hook })
  }
  const autoTag = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.autoTag'")).get() as any
  const llmOn = String(autoTag?.value || '') === 'true'
  const clusters: WeeklyCluster[] = []
  for (const [domain, items] of byDomain) {
    const base = `${domain} 本周新增 ${items.length} 条值得关注` + (items[0]?.hook?.text ? `，如「${items[0].hook.text}」` : '')
    let paragraph = base
    if (llmOn) {
      try { paragraph = (await llmClusterParagraph(domain, items)) || base } catch { /* LLM 失败降级基础统计段 */ }
    }
    clusters.push({ domain, count: items.length, paragraph })
  }
  const jsonPath = path.join(dir, `${week}.json`)
  await fs.mkdir(dir, { recursive: true })
  const lines: string[] = [`# AgentFeed 周度一页纸 ${week}`, '']
  if (!clusters.length) lines.push('本周暂无新增蒸馏产物。', '')
  for (const c of clusters) {
    lines.push(`## ${c.domain}（${c.count} 条）`, '', c.paragraph, '')
  }
  lines.push(`安全忽略（hook.action=ignore）：${skipped} 条`, '')
  await fs.writeFile(mdPath, lines.join('\n'), 'utf8')
  await fs.writeFile(jsonPath, JSON.stringify({ week, clusters, skipped }, null, 2), 'utf8')
  return { generated: true, week, path: mdPath, clusters, skipped }
}

/** 单簇 LLM 增强段：callLlm 强制 JSON 输出（response_format=json_object），故按 {"paragraph":"..."} 形态提取 */
async function llmClusterParagraph(domain: string, items: { title: string; hook: any }[]): Promise<string> {
  const { callLlm } = await import('./llm/index.js')
  const { getDefaultProvider, getDefaultModel } = await import('./llm/llmClient.js')
  const provider = await getDefaultProvider()
  const model = await getDefaultModel()
  const list = items.slice(0, 20).map(i => `- ${i.title}${i.hook?.text ? `：${i.hook.text}` : ''}`).join('\n')
  const prompt = `以下是知识库「${domain}」领域本周新增的 ${items.length} 条蒸馏条目：\n${list}\n\n请用不超过 100 字的中文写一段该领域本周动向小结（只输出 JSON：{"paragraph":"..."}）。`
  const r = await callLlm(provider, model, prompt)
  const m = String(r.text || '').match(/"paragraph"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const p = m ? JSON.parse(`"${m[1]}"`) : ''
  return String(p || '').trim().slice(0, 300)
}
