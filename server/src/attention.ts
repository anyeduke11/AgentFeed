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
