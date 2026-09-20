import { Router } from 'express'
import { getDb } from '../db.js'

export const readingRouter = Router()

const EXEC_QUEUE_CAP = 20

/** 间隔重复间隔表（天）：5 星 1→3→7→14→30；3~4 星 1→3→7 封顶；≤2 星归档不再调起 */
const STAGES_5 = [1, 3, 7, 14, 30]
const STAGES_34 = [1, 3, 7]

/** 打分：1~5 星 + 可执行性（立即试 now / 稍后试 later / 纯了解 info） */
readingRouter.post('/rate', async (req, res) => {
  try {
    const db = await getDb()
    const fileId = parseInt(req.body?.fileId)
    const stars = parseInt(req.body?.stars)
    const execIntent = String(req.body?.execIntent || 'info')
    if (isNaN(fileId)) return res.json({ success: false, message: 'fileId 必填' })
    if (isNaN(stars) || stars < 1 || stars > 5) return res.json({ success: false, message: 'stars 需为 1~5' })
    if (!['now', 'later', 'info'].includes(execIntent)) return res.json({ success: false, message: 'execIntent 不支持' })
    await db.exec(`INSERT INTO reading_feedback (file_id, stars, exec_intent) VALUES (${fileId}, ${stars}, '${execIntent}')`)
    // 打分即升级为「已读」语义（打开只算浏览）
    await db.exec(`UPDATE recommendations SET status = 'read' WHERE file_id = ${fileId} AND status = 'unread'`)
    // 可执行文章进执行队列（立即试=当天，稍后试=1 天后）
    let queued = false
    let warning = ''
    if (execIntent !== 'info') {
      const cntRow = await (await db.prepare("SELECT COUNT(*) AS n FROM exec_queue WHERE status = 'pending'")).get() as any
      if (cntRow.n >= EXEC_QUEUE_CAP) {
        warning = `执行队列已满（${EXEC_QUEUE_CAP} 条），请先执行或清理再添加`
      } else {
        const hours = execIntent === 'now' ? 0 : 24
        const pending = await (await db.prepare("SELECT id FROM exec_queue WHERE file_id = ? AND status = 'pending'")).get(fileId) as any
        if (pending) {
          await db.exec(`UPDATE exec_queue SET due_at = datetime('now', '+${hours} hours') WHERE id = ${pending.id}`)
        } else {
          // 无 pending 行：新建一轮。若上一轮是「逾期忽略已降档」则从降后的档位起步，否则从 0 档开始
          const prev = await (await db.prepare('SELECT interval_stage FROM exec_queue WHERE file_id = ? ORDER BY id DESC LIMIT 1')).get(fileId) as any
          const stage = prev ? Math.max(0, prev.interval_stage) : 0
          await db.exec(`INSERT INTO exec_queue (file_id, due_at, interval_stage) VALUES (${fileId}, datetime('now', '+${hours} hours'), ${stage})`)
        }
        queued = true
      }
    }
    res.json({ success: true, queued, warning })
  } catch (e: any) {
    console.error('reading rate failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 阅读进度（R1）：25/50/75/100 手动挡。仅池内文件生效（预览打开不记进度）；进度仅展示不参与排序 */
readingRouter.post('/progress', async (req, res) => {
  try {
    const db = await getDb()
    const fileId = parseInt(req.body?.fileId)
    const progress = parseInt(req.body?.progress)
    if (isNaN(fileId)) return res.json({ success: false, message: 'fileId 必填' })
    if (isNaN(progress) || progress < 0 || progress > 100) return res.json({ success: false, message: 'progress 需为 0~100' })
    const row = await (await db.prepare('SELECT id FROM recommendations WHERE file_id = ?')).get(fileId) as any
    if (!row) return res.json({ success: false, message: '仅推荐池内文件支持进度记录' })
    await db.exec(`UPDATE recommendations SET progress = ${progress}, last_progress_at = CURRENT_TIMESTAMP WHERE id = ${row.id}`)
    res.json({ success: true, progress })
  } catch (e: any) {
    console.error('reading progress failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 执行队列：到期优先（逾期置顶），附带统计 */
readingRouter.get('/exec', async (req, res) => {
  try {
    const db = await getDb()
    const rows = await (await db.prepare(`
      SELECT e.id, e.file_id, e.due_at, e.interval_stage, e.status,
             COALESCE(NULLIF(f.title, ''), f.name) AS title, f.path, f.ext,
             d.name AS domain_name
      FROM exec_queue e
      JOIN files f ON f.id = e.file_id
      LEFT JOIN domains d ON f.domain_id = d.id
      WHERE e.status = 'pending'
      ORDER BY e.due_at ASC
      LIMIT ${EXEC_QUEUE_CAP}`)).all() as any[]
    const now = Date.now()
    // 逾期判定留 1 小时宽限：「立即试」刚入队即到期属正常可执行，不应立刻标红
    for (const r of rows) r.overdue = new Date(String(r.due_at).includes('T') ? r.due_at : r.due_at.replace(' ', 'T') + 'Z').getTime() < now - 3600_000
    const doneToday = await (await db.prepare("SELECT COUNT(*) AS n FROM exec_queue WHERE status = 'done' AND done_at >= datetime('now', 'start of day')")).get() as any
    res.json({ items: rows, counts: { pending: rows.length, overdue: rows.filter((r: any) => r.overdue).length, doneToday: doneToday.n } })
  } catch (e: any) {
    console.error('reading exec list failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 标记已执行（出队留历史）：按最新星值推进间隔档位，排下一轮复习（≤2 星归档不再调起） */
readingRouter.post('/exec/:id/done', async (req, res) => {
  try {
    const db = await getDb()
    const row = await (await db.prepare("SELECT id, file_id, interval_stage FROM exec_queue WHERE id = ? AND status = 'pending'")).get(parseInt(req.params.id)) as any
    if (!row) return res.json({ success: false, message: '任务不存在或已出队' })
    await db.exec(`UPDATE exec_queue SET status = 'done', done_at = CURRENT_TIMESTAMP WHERE id = ${row.id}`)
    const fb = await (await db.prepare('SELECT stars FROM reading_feedback WHERE file_id = ? ORDER BY id DESC LIMIT 1')).get(row.file_id) as any
    if (fb && fb.stars <= 2) {
      await db.exec(`UPDATE recommendations SET status = 'archived' WHERE file_id = ${row.file_id}`)
      return res.json({ success: true, rescheduled: false })
    }
    const stages = !fb || fb.stars >= 5 ? STAGES_5 : STAGES_34
    const next = Math.min(row.interval_stage + 1, stages.length - 1)
    await db.exec(`INSERT INTO exec_queue (file_id, due_at, interval_stage)
      VALUES (${row.file_id}, datetime('now', '+${stages[next]} days'), ${next})`)
    res.json({ success: true, rescheduled: true, nextDays: stages[next] })
  } catch (e: any) {
    console.error('reading exec done failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 忽略（出队不再调起）：逾期 >7 天的文章降一档并标记，供回顾卡提示 */
readingRouter.post('/exec/:id/dismiss', async (req, res) => {
  try {
    const db = await getDb()
    const row = await (await db.prepare("SELECT id, due_at, interval_stage FROM exec_queue WHERE id = ? AND status = 'pending'")).get(parseInt(req.params.id)) as any
    if (!row) return res.json({ success: false, message: '任务不存在或已出队' })
    await db.exec(`UPDATE exec_queue SET status = 'dismissed', done_at = CURRENT_TIMESTAMP WHERE id = ${row.id}`)
    let demoted = false
    const overdueDays = (Date.now() - new Date(String(row.due_at).includes('T') ? row.due_at : row.due_at.replace(' ', 'T') + 'Z').getTime()) / 86400000
    if (overdueDays > 7 && row.interval_stage > 0) {
      await db.exec(`UPDATE exec_queue SET interval_stage = ${row.interval_stage - 1} WHERE id = ${row.id}`)
      demoted = true
    }
    res.json({ success: true, demoted })
  } catch (e: any) {
    console.error('reading exec dismiss failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 周阅读目标（R3）：写 config 键 reading.weeklyGoal */
readingRouter.post('/goal', async (req, res) => {
  try {
    const goal = parseInt(req.body?.weeklyGoal)
    if (isNaN(goal) || goal < 1 || goal > 100) return res.json({ success: false, message: '目标需为 1~100 的整数' })
    const db = await getDb()
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('reading.weeklyGoal', '${goal}', 'number', '周阅读目标（打分去重篇数）')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    res.json({ success: true, weeklyGoal: goal })
  } catch (e: any) {
    console.error('reading goal failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 阅读统计（总览回顾区块用） */
readingRouter.get('/stats', async (req, res) => {
  try {
    const db = await getDb()
    const opened7 = await (await db.prepare("SELECT COUNT(*) AS n FROM read_history WHERE opened_at >= datetime('now', '-7 days')")).get() as any
    const rated7 = await (await db.prepare("SELECT COUNT(*) AS n FROM reading_feedback WHERE created_at >= datetime('now', '-7 days')")).get() as any
    const avgStars = await (await db.prepare("SELECT AVG(stars) AS v FROM reading_feedback WHERE created_at >= datetime('now', '-7 days')")).get() as any
    const poolRow = await (await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) AS unread FROM recommendations")).get() as any
    // 周卡扩展：打分分布 / 独立篇数 / 完成轮次 / 逾期堆积（>7 天待回顾）
    const distRows = await (await db.prepare("SELECT stars, COUNT(*) AS n FROM reading_feedback WHERE created_at >= datetime('now', '-7 days') GROUP BY stars")).all() as any[]
    const dist: Record<number, number> = {}
    for (const r of distRows) dist[r.stars] = r.n
    const openedFiles = await (await db.prepare("SELECT COUNT(DISTINCT file_id) AS n FROM read_history WHERE opened_at >= datetime('now', '-7 days') AND file_id IS NOT NULL")).get() as any
    const doneWeek = await (await db.prepare("SELECT COUNT(*) AS n FROM exec_queue WHERE status = 'done' AND done_at >= datetime('now', '-7 days')")).get() as any
    const stale = await (await db.prepare(`
      SELECT e.id, COALESCE(NULLIF(f.title, ''), f.name) AS title, e.due_at
      FROM exec_queue e JOIN files f ON f.id = e.file_id
      WHERE e.status = 'pending' AND e.due_at < datetime('now', '-7 days')
      ORDER BY e.due_at ASC LIMIT 3`)).all() as any[]
    const staleCount = await (await db.prepare("SELECT COUNT(*) AS n FROM exec_queue WHERE status = 'pending' AND due_at < datetime('now', '-7 days')")).get() as any
    // 薄弱点（M3）：按领域聚合本周低星（≤2）与逾期堆积，加权取 Top3（低星与逾期同为薄弱信号）
    const lowStarRows = await (await db.prepare(`
      SELECT COALESCE(d.name, '未分类') AS name, COUNT(*) AS n
      FROM reading_feedback rf JOIN files f ON f.id = rf.file_id LEFT JOIN domains d ON f.domain_id = d.id
      WHERE rf.stars <= 2 AND rf.created_at >= datetime('now', '-7 days')
      GROUP BY d.id`)).all() as any[]
    const staleRows = await (await db.prepare(`
      SELECT COALESCE(d.name, '未分类') AS name, COUNT(*) AS n
      FROM exec_queue e JOIN files f ON f.id = e.file_id LEFT JOIN domains d ON f.domain_id = d.id
      WHERE e.status = 'pending' AND e.due_at < datetime('now', '-7 days')
      GROUP BY d.id`)).all() as any[]
    const wmap = new Map<string, { name: string; lowStars: number; stale: number }>()
    for (const r of lowStarRows) wmap.set(r.name, { name: r.name, lowStars: r.n, stale: 0 })
    for (const r of staleRows) {
      const w = wmap.get(r.name) || { name: r.name, lowStars: 0, stale: 0 }
      w.stale = r.n
      wmap.set(r.name, w)
    }
    const weakDomains = [...wmap.values()]
      .map(w => ({ ...w, total: w.lowStars + w.stale }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
    // 在读停滞（R1）：进度 >14 天未更新且未到 100%，周卡提示（不自动改状态）
    const stalled = await (await db.prepare(`
      SELECT r.file_id, COALESCE(NULLIF(f.title, ''), f.name) AS title, r.progress, r.last_progress_at
      FROM recommendations r JOIN files f ON f.id = r.file_id
      WHERE r.status != 'archived' AND r.progress > 0 AND r.progress < 100
        AND r.last_progress_at IS NOT NULL AND r.last_progress_at < datetime('now', '-14 days')
      ORDER BY r.last_progress_at ASC LIMIT 3`)).all() as any[]
    const stalledCount = await (await db.prepare(`
      SELECT COUNT(*) AS n FROM recommendations
      WHERE status != 'archived' AND progress > 0 AND progress < 100
        AND last_progress_at IS NOT NULL AND last_progress_at < datetime('now', '-14 days')`)).get() as any
    // 周目标（R3）：config 键 reading.weeklyGoal（默认 5），完成 = 本周打分去重篇数
    const goalRow = await (await db.prepare("SELECT value FROM config WHERE key = 'reading.weeklyGoal'")).get() as any
    const ratedFiles = await (await db.prepare("SELECT COUNT(DISTINCT file_id) AS n FROM reading_feedback WHERE created_at >= datetime('now', '-7 days')")).get() as any
    res.json({
      opened7: opened7.n,
      openedFiles7: openedFiles.n,
      rated7: rated7.n,
      weeklyGoal: Math.max(1, parseInt(goalRow?.value) || 5),
      ratedFiles7: ratedFiles.n,
      avgStars: avgStars.v ? Number(Number(avgStars.v).toFixed(1)) : null,
      dist,
      doneWeek: doneWeek.n,
      staleCount: staleCount.n,
      stale,
      weakDomains,
      stalledCount: stalledCount.n,
      stalled,
      pool: { total: poolRow.n || 0, unread: poolRow.unread || 0 }
    })
  } catch (e: any) {
    console.error('reading stats failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})
