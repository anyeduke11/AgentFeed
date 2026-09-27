import { getDb } from './db.js'
import path from 'path'
import { callEmbedding, cosine } from './llm/embeddings.js'
import type { WikiHook } from './llm/llmWorker.js'

/** 读单条 hook（P2-1）：解析 wiki_entries_meta.hook 列 JSON。无行/未产出/坏 JSON 返 null——读侧 fail-safe，不阻塞展示 */
export async function getHook(fileId: number): Promise<WikiHook | null> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT hook FROM wiki_entries_meta WHERE file_id = ?')).get(fileId) as any
  if (!row?.hook) return null
  try {
    const h = JSON.parse(row.hook)
    return h && typeof h === 'object'
      ? { text: String(h.text || ''), verdict: String(h.verdict || ''), action: String(h.action || 'keep') as WikiHook['action'] }
      : null
  } catch { return null }
}

/** attention.features 灰度开关读取（坏 JSON 回退全关——fail-closed 到旧行为）。
 * cooling 缺省即关（`=== true`）：INSERT OR IGNORE 对既有库不回填新键 */
export async function attentionFeatures(): Promise<{ lifecycle: boolean; decay: boolean; cooling: boolean }> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.features'")).get() as any
  try {
    const f = JSON.parse(String(row?.value || '{}'))
    return { lifecycle: f.lifecycle === true, decay: f.decay === true, cooling: f.cooling === true }
  } catch { return { lifecycle: false, decay: false, cooling: false } }
}

/** touch 回写：Web 打开 / MCP 深读共用。幂等递增 touch_count，置 last_touched_at=now（UTC ISO） */
export async function touchFiles(ids: number[]): Promise<void> {
  if (!ids.length) return
  const { lifecycle } = await attentionFeatures()
  if (!lifecycle) return
  const db = await getDb()
  await db.exec(`UPDATE files SET last_touched_at = '${new Date().toISOString()}', touch_count = touch_count + 1 WHERE id IN (${ids.join(',')})`)
}

/** 存量回填（幂等，只填 NULL 行）：有 read_history 取最早 opened_at，无则 created_at（入库时间）兜底。
 * WHY 不用 file_mtime：agent 持续改写文件，mtime 新鲜 ≠ 用户注意力触及——mtime 兜底会把「agent 活跃」
 * 误判为「用户看过」（P0 dry_run 实测：74k 存量 would_cold 仅 267，回填语义缺陷）。created_at 表达
 * 「入库以来从未被你打开过」，与使用侧衰减本意一致（2026-09-26 用户裁决）。返回回填行数 */
export async function backfillLastTouched(): Promise<number> {
  const db = await getDb()
  // @homeofthings/sqlite3 的 exec 返回 void 不带 changes——先 COUNT 待回填行数再执行
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM files WHERE last_touched_at IS NULL')).get() as any
  await db.exec(`
    UPDATE files SET last_touched_at = COALESCE(
      (SELECT MIN(opened_at) FROM read_history WHERE read_history.file_id = files.id),
      created_at)
    WHERE last_touched_at IS NULL`)
  return Number(cnt?.n ?? 0)
}

/** 下沉计划（纯查询不落库，即 dry_run）：warm=90d 未触及且 touch≤1；cold=180d 未触及（不看 touch_count）；
 * pinned 豁免；decay 开关关闭返回空计划。语义注意：`lifecycle IS NOT 'cold'` 在 SQLite 是 NULL 安全不等
 * （NULL IS NOT 'cold' 为真）——未分层（NULL）行参与选拔、已 cold 行不重复选拔；
 * 未回填行（last_touched_at IS NULL）天然排除，回填完成前 dry_run 空转安全 */
export async function planDecay(): Promise<{ warmIds: number[]; coldIds: number[] }> {
  const { decay } = await attentionFeatures()
  if (!decay) return { warmIds: [], coldIds: [] }
  const db = await getDb()
  const days = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.decayDays'")).get() as any
  let demote = 90
  let archive = 180
  try {
    const d = JSON.parse(String(days?.value || '{}'))
    if (Number.isFinite(d.demoteDays)) demote = d.demoteDays
    if (Number.isFinite(d.archiveDays)) archive = d.archiveDays
  } catch { /* 坏 JSON 用默认阈值 */ }
  const warmIds = ((await (await db.prepare(`
    SELECT id FROM files WHERE status = 'active' AND pinned = 0 AND lifecycle IS NOT 'cold'
      AND last_touched_at IS NOT NULL AND last_touched_at < datetime('now', '-${demote} days')
      AND touch_count <= 1`)).all()) as any[]).map(r => r.id)
  const coldIds = ((await (await db.prepare(`
    SELECT id FROM files WHERE status = 'active' AND pinned = 0 AND lifecycle IS NOT 'cold'
      AND last_touched_at IS NOT NULL AND last_touched_at < datetime('now', '-${archive} days')`)).all()) as any[]).map(r => r.id)
  return { warmIds: warmIds.filter(id => !coldIds.includes(id)), coldIds }
}

/** 执行下沉（cold 先落避免 warm 覆盖——warm 集已在 planDecay 内剔除 cold）。返回实际更新数 */
export async function applyDecay(plan: { warmIds: number[]; coldIds: number[] }): Promise<{ warm: number; cold: number }> {
  if (!plan.warmIds.length && !plan.coldIds.length) return { warm: 0, cold: 0 }
  const db = await getDb()
  if (plan.coldIds.length) await db.exec(`UPDATE files SET lifecycle = 'cold' WHERE id IN (${plan.coldIds.join(',')})`)
  if (plan.warmIds.length) await db.exec(`UPDATE files SET lifecycle = 'warm' WHERE id IN (${plan.warmIds.join(',')})`)
  return { warm: plan.warmIds.length, cold: plan.coldIds.length }
}

/* ---- P1 冷却池：新采集条目静置 coolingHours 才进蒸馏/推荐（豁免清单除外） ---- */

export interface CoolingExempt { sourceAgent?: string | null; filePath?: string; filenameWhitelist?: string[]; pathWhitelist?: string[] }

/** 豁免判定：webclip 来源 / 文件名白名单精确命中 / 路径白名单前缀命中（与 gate 同语义） */
function isExempt(filePath: string | undefined, sourceAgent: string | null | undefined, whitelist: string[], pathWl: string[]): boolean {
  if (sourceAgent === 'webclip') return true
  if (!filePath) return false
  const base = path.basename(filePath).toLowerCase()
  if (whitelist.some(w => base === w.toLowerCase())) return true
  const p = filePath.replace(/\/+$/, '')
  return pathWl.some(e => {
    const q = e.trim().replace(/\/+$/, '')
    return q !== '' && (p === q || p.startsWith(q + '/'))
  })
}

/** 入冷却池（幂等：同文件只入一次；豁免来源/关闭开关直接跳过）。release_at = entered_at + coolingHours */
export async function enterCooling(fileId: number, exempt?: CoolingExempt): Promise<void> {
  const f = await attentionFeatures()
  if (!f.cooling) return
  const db = await getDb()
  const dup = await (await db.prepare('SELECT 1 FROM cooling_pool WHERE file_id = ?')).get(fileId)
  if (dup) return
  const h = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.coolingHours'")).get() as any
  const hours = Number(h?.value) > 0 ? Number(h.value) : 48
  const wl = await (await db.prepare("SELECT value FROM config WHERE key = 'gate.filenameWhitelist'")).get() as any
  const pw = await (await db.prepare("SELECT value FROM config WHERE key = 'gate.pathWhitelist'")).get() as any
  let whitelist: string[] = []
  let pathWl: string[] = []
  try { whitelist = JSON.parse(String(wl?.value || '[]')) } catch { /* 默认空 */ }
  try { pathWl = JSON.parse(String(pw?.value || '[]')) } catch { /* 默认空 */ }
  if (isExempt(exempt?.filePath, exempt?.sourceAgent ?? null, whitelist, pathWl)) return
  await db.exec(`INSERT INTO cooling_pool (file_id, entered_at, release_at, status)
    VALUES (${Number(fileId)}, '${new Date().toISOString()}', datetime('now', '+${hours} hours'), 'cooling')`)
}

/** 是否冷却中（cooling 状态且未到 release_at）。feature 关闭恒 false */
export async function isCooling(fileId: number): Promise<boolean> {
  const f = await attentionFeatures()
  if (!f.cooling) return false
  const db = await getDb()
  const row = await (await db.prepare("SELECT 1 FROM cooling_pool WHERE file_id = ? AND status = 'cooling' AND release_at > datetime('now')")).get(fileId)
  return !!row
}

/** 到期出池：release_at 已过且仍 cooling 的行置 released。返回出池文件数 */
export async function releaseExpired(): Promise<{ released: number }> {
  const db = await getDb()
  // @homeofthings/sqlite3 的 exec 不带 changes——先 COUNT 同条件行数再更新（同 backfillLastTouched）
  const cnt = await (await db.prepare("SELECT COUNT(*) AS n FROM cooling_pool WHERE status = 'cooling' AND release_at <= datetime('now')")).get() as any
  await db.exec(`UPDATE cooling_pool SET status = 'released' WHERE status = 'cooling' AND release_at <= datetime('now')`)
  return { released: Number(cnt?.n ?? 0) }
}

/* ---- P1 蒸馏前廉价去重：判冷不判死（可检索、不蒸馏） ---- */

export interface DupVerdict { duplicate: boolean; reason: string; degraded: boolean }

/** 蒸馏前去重：embedding 可用 → 与近 30 天已蒸馏条目标题向量比相似度（≥0.92 判重）；
 *  不可用 → 降级为标题精确匹配（degraded 标注）。近邻限 50 条（按 distilled_at 取最新）防大产出自爆；
 *  标题精确匹配走零成本快速路径（命中即停；两侧剥 .md/.html 扩展名归一——feeder 传 COALESCE(title,name)
 *  时 name 含扩展名而 wiki 标题不含，不归一则快速路径永不可达），未命中才逐条 embed。
 *  fail-closed：查重失败不判重，放行走原流程 */
export async function findDuplicates(fileId: number, title: string, embed: (t: string) => Promise<number[]> = callEmbedding): Promise<DupVerdict> {
  const db = await getDb()
  const rows = await (await db.prepare(`
    SELECT m.file_id, m.title FROM wiki_entries_meta m
    JOIN files f ON f.id = m.file_id
    WHERE m.distilled_at >= datetime('now', '-30 days') AND f.id != ? AND COALESCE(m.title, '') != ''
    ORDER BY m.distilled_at DESC LIMIT 50`)).all(fileId) as any[]
  if (!rows.length) return { duplicate: false, reason: 'no_neighbors', degraded: false }
  // 快速路径：标题精确匹配（大小写不敏感 + 两侧剥 .md/.htm/.html 扩展名），零 embedding 成本
  const normTitle = title.trim().replace(/\.(md|html?)$/i, '').toLowerCase()
  const exact = normTitle ? rows.find(r => String(r.title).trim().replace(/\.(md|html?)$/i, '').toLowerCase() === normTitle) : undefined
  if (exact) return { duplicate: true, reason: `duplicate_of:${exact.file_id}`, degraded: true }
  try {
    const target = await embed(title)
    for (const r of rows) {
      const v = await embed(r.title)
      if (cosine(target, v) >= 0.92) return { duplicate: true, reason: `duplicate_of:${r.file_id}`, degraded: false }
    }
    return { duplicate: false, reason: 'ok', degraded: false }
  } catch {
    // embedding 不可用：精确匹配已在快速路径做过 → 不判重放行
    return { duplicate: false, reason: 'ok_degraded', degraded: true }
  }
}

/** 判重处置：lifecycle=cold（可检索不蒸馏），llm_state=skipped（feeder 只拾 pending，不会死循环；
 *  skipped 在 files 建表 CHECK 枚举内）；updated_at 同步置 now——suppressionToday 的 deduped
 *  按「当日被判重」计数，依赖此时间戳 */
export async function markDuplicate(fileId: number, dupOf?: string): Promise<void> {
  const db = await getDb()
  await db.exec(`UPDATE files SET lifecycle = 'cold', llm_state = 'skipped', updated_at = CURRENT_TIMESTAMP WHERE id = ${Number(fileId)}`)
  console.log(`[attention] duplicate detected: file=${fileId} ${dupOf || ''}`)
}

/* ---- P1-5 suppression 日指标：日报「安全忽略」段数据源（全部只读计数） ---- */

/** 抑制日指标：collected=当日入库（files.created_at 本地日）；deduped=当日去重落冷
 *  （lifecycle=cold + llm_state=skipped，按 updated_at 日）；cooling_alive/cooling_died=池内
 *  状态机快照（death_reason 当前无写入方，P2 起有值）；delivered 预留 0（recommendations 无
 *  交付时间字段）；digested=当日已消化行（digest_text 非空，P2 起不含 /rate 打分行）；simulated_quota_overflow=max(0, collected-30)
 *  ——智谱观测仪表：若配额 30 生效今日超额多少，只记不拦；hidden_total=collected−digested（下限 0，
 *  P3 观测口径：入库了但没消费的） */
export async function suppressionToday(): Promise<Record<string, number>> {
  const db = await getDb()
  const cnt = async (sql: string): Promise<number> => {
    const r = await (await db.prepare(sql)).get() as any
    return Number(r?.n ?? 0)
  }
  const collected = await cnt("SELECT COUNT(*) AS n FROM files WHERE date(created_at) = date('now', 'localtime')")
  const deduped = await cnt("SELECT COUNT(*) AS n FROM files WHERE lifecycle = 'cold' AND llm_state = 'skipped' AND date(updated_at) = date('now', 'localtime')")
  const cooling_alive = await cnt("SELECT COUNT(*) AS n FROM cooling_pool WHERE status = 'cooling' AND release_at > datetime('now')")
  const cooling_died = await cnt("SELECT COUNT(*) AS n FROM cooling_pool WHERE death_reason IS NOT NULL OR status = 'expired'")
  // P2 口径修正：reading_feedback 同表承载 digest 行与旧 /rate 打分行——只计 digest_text 非空
  // （「已消化」唯一信号），否则日常打分会让日报「已消化」虚高双计
  const digested = await cnt("SELECT COUNT(*) AS n FROM reading_feedback WHERE date(created_at) = date('now', 'localtime') AND digest_text IS NOT NULL")
  const delivered = 0 // recommendations 无当日 delivered 字段——按计划口径计 0，字段落地后补真实计数
  return {
    collected,
    deduped,
    cooling_alive,
    cooling_died,
    delivered,
    digested,
    simulated_quota_overflow: Math.max(0, collected - 30),
    hidden_total: Math.max(0, collected - digested),
  }
}

/* ---- P3 每日配额双上限（千问形态：80% soft 部分呈现 / 100% hard 即停 + hidden_total 内联） ---- */

export interface BudgetConfig { enabled: boolean; dailyLimit: number; softPct: number }
export interface Budgeted<T> { items: T[]; softCapped: boolean; hardCapped: boolean; hiddenTotal: number }

const BUDGET_DEFAULT: BudgetConfig = { enabled: false, dailyLimit: 5, softPct: 80 }

/** P3 配额读侧（缺省兜底：坏 JSON / 缺键 / 非法数值 → 默认关闭。INSERT OR IGNORE 对既有库不回填新键，读侧不得依赖 seed） */
export async function getBudget(): Promise<BudgetConfig> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.budget'")).get() as any
  try {
    const b = JSON.parse(String(row?.value || '{}'))
    return {
      enabled: b.enabled === true,
      dailyLimit: Number.isFinite(b.dailyLimit) && b.dailyLimit >= 1 ? Math.floor(b.dailyLimit) : BUDGET_DEFAULT.dailyLimit,
      softPct: Number.isFinite(b.softPct) && b.softPct > 0 && b.softPct <= 100 ? b.softPct : BUDGET_DEFAULT.softPct,
    }
  } catch { return { ...BUDGET_DEFAULT } }
}

/** 千问双上限：softLimit=ceil(dailyLimit×softPct/100)，超过则截到 softLimit 标 softCapped（部分呈现）；
 *  截到 softLimit 后仍达到 dailyLimit（softPct=100 或小 limit 圆整到上限时）→ hardCapped 同真——
 *  hard wins 标注但切片维持 softLimit 不二次收紧；hiddenTotal = 原长 − 切片长。
 *  注意 hard 判定用切片后长度（测试 r1 钉死：6 条 limit5 soft80 → 截 4，4<5 不标 hard）；
 *  disabled 原样透传零标注（默认关闭 = 行为与改造前完全一致） */
export async function applyBudget<T extends { file_id: number }>(items: T[]): Promise<Budgeted<T>> {
  const b = await getBudget()
  if (!b.enabled) return { items, softCapped: false, hardCapped: false, hiddenTotal: 0 }
  const softLimit = Math.ceil(b.dailyLimit * b.softPct / 100)
  const sliced = items.length > softLimit ? items.slice(0, softLimit) : items
  return {
    items: sliced,
    softCapped: sliced.length < items.length,
    hardCapped: sliced.length >= b.dailyLimit,
    hiddenTotal: items.length - sliced.length,
  }
}
