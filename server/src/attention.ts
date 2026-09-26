import { getDb } from './db.js'

/** attention.features 灰度开关读取（坏 JSON 回退全关——fail-closed 到旧行为） */
export async function attentionFeatures(): Promise<{ lifecycle: boolean; decay: boolean }> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.features'")).get() as any
  try {
    const f = JSON.parse(String(row?.value || '{}'))
    return { lifecycle: f.lifecycle === true, decay: f.decay === true }
  } catch { return { lifecycle: false, decay: false } }
}

/** touch 回写：Web 打开 / MCP 深读共用。幂等递增 touch_count，置 last_touched_at=now（UTC ISO） */
export async function touchFiles(ids: number[]): Promise<void> {
  if (!ids.length) return
  const { lifecycle } = await attentionFeatures()
  if (!lifecycle) return
  const db = await getDb()
  await db.exec(`UPDATE files SET last_touched_at = '${new Date().toISOString()}', touch_count = touch_count + 1 WHERE id IN (${ids.join(',')})`)
}

/** 存量回填（幂等，只填 NULL 行）：有 read_history 取最早 opened_at，无则 file_mtime。返回回填行数 */
export async function backfillLastTouched(): Promise<number> {
  const db = await getDb()
  // @homeofthings/sqlite3 的 exec 返回 void 不带 changes——先 COUNT 待回填行数再执行
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM files WHERE last_touched_at IS NULL')).get() as any
  await db.exec(`
    UPDATE files SET last_touched_at = COALESCE(
      (SELECT MIN(opened_at) FROM read_history WHERE read_history.file_id = files.id),
      file_mtime)
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
