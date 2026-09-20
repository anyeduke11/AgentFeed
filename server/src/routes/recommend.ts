import { Router } from 'express'
import { getDb } from '../db.js'
import { llmQueue } from '../llm/index.js'
import { getProviders, getDefaultModel } from '../llm/llmClient.js'
import { ensureTag } from '../llm/tagGovernance.js'

export const recommendRouter = Router()

/** 规则推荐理由：领域 · 类型 · 规模（· AI 评分） */
function ruleReason(r: any): string {
  const parts: string[] = []
  parts.push(r.domain_name || '未分类')
  if (r.ext) parts.push(String(r.ext).replace('.', ''))
  if (r.size) parts.push(Math.max(1, Math.round(r.size / 1024)) + 'KB')
  if (r.quality_score) parts.push('AI 评分 ' + Number(r.quality_score).toFixed(1))
  return parts.filter(Boolean).join(' · ')
}

/** 冷启动预览：四维筛选 + 关键词，分层混合排序（有质量分优先，规则分兜底），不入库 */
recommendRouter.get('/preview', async (req, res) => {
  try {
    const db = await getDb()
    const { domains = '', tags = '', agents = '', types = '', kw = '', limit = '30' } = req.query as Record<string, string>
    const where: string[] = ["f.status = 'active'"]
    const params: any[] = []
    if (kw.trim()) {
      where.push('(f.title LIKE ? OR f.name LIKE ? OR f.path LIKE ?)')
      params.push(`%${kw.trim()}%`, `%${kw.trim()}%`, `%${kw.trim()}%`)
    }
    if (domains.trim()) {
      // 展开含子领域
      const ids = domains.split(',').map(s => parseInt(s)).filter(n => !isNaN(n))
      const all = await (await db.prepare('SELECT id, parent_id FROM domains')).all() as any[]
      const childrenOf = new Map<number, number[]>()
      for (const r of all) {
        if (r.parent_id == null) continue
        if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, [])
        childrenOf.get(r.parent_id)!.push(r.id)
      }
      const expanded = new Set<number>()
      const walk = (id: number) => {
        if (expanded.has(id)) return
        expanded.add(id)
        for (const c of childrenOf.get(id) || []) walk(c)
      }
      ids.forEach(walk)
      if (expanded.size) where.push(`f.domain_id IN (${[...expanded].join(',')})`)
    }
    if (tags.trim()) {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean)
      if (tagList.length) {
        // ensureTag 解析：被合并的旧标签名自动跟随指向
        const tagIds: number[] = []
        for (const t of tagList) {
          const id = await ensureTag(db, t)
          if (id) tagIds.push(id)
        }
        if (tagIds.length) where.push(`f.id IN (SELECT file_id FROM file_tags WHERE tag_id IN (${tagIds.join(',')}))`)
        else where.push('0 = 1')
      }
    }
    if (agents.trim()) {
      const list = agents.split(',').map(s => s.trim()).filter(Boolean)
      where.push(`f.source_agent IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    if (types.trim()) {
      const list = types.split(',').map(s => s.trim()).filter(Boolean).map(t => (t.startsWith('.') ? t : '.' + t))
      where.push(`f.ext IN (${list.map(() => '?').join(',')})`)
      params.push(...list)
    }
    const lim = Math.min(100, Math.max(1, parseInt(limit) || 30))
    // 行为加权（PRD：打开 ×1.2、5 星 ×1.5、已执行 ×1.5）叠加在质量分 + 规则分之上
    const sql = `
      SELECT f.id, f.title, f.name, f.path, f.ext, f.size, f.source_agent, f.updated_at,
             COALESCE(f.alias, f.title, f.name) AS alias,
             COALESCE(f.rule_score, 0) AS rule_score,
             d.name AS domain_name, w.quality_score, (r.id IS NOT NULL) AS in_pool
      FROM files f
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      LEFT JOIN recommendations r ON r.file_id = f.id
      LEFT JOIN (SELECT file_id, COUNT(*) AS n FROM read_history GROUP BY file_id) rh ON rh.file_id = f.id
      LEFT JOIN (SELECT file_id, COUNT(*) AS n FROM reading_feedback WHERE stars >= 5 GROUP BY file_id) f5 ON f5.file_id = f.id
      LEFT JOIN (SELECT file_id, COUNT(*) AS n FROM exec_queue WHERE status = 'done' GROUP BY file_id) eq ON eq.file_id = f.id
      WHERE ${where.join(' AND ')}
      ORDER BY (w.quality_score IS NOT NULL) DESC,
               (COALESCE(w.quality_score, 0) * 3 + COALESCE(f.rule_score, 0)
                + COALESCE(rh.n, 0) * 1.2 + COALESCE(f5.n, 0) * 1.5 + COALESCE(eq.n, 0) * 1.5) DESC,
               COALESCE(f.size, 0) DESC
      LIMIT ${lim}`
    const rows = await (await db.prepare(sql)).all(params) as any[]
    for (const r of rows) r.reason = ruleReason(r)
    res.json({ items: rows })
  } catch (e: any) {
    console.error('recommend preview failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 收纳进推荐池（规则理由即刻生成；LLM 升级为 M2 assess 任务） */
recommendRouter.post('/', async (req, res) => {
  try {
    const db = await getDb()
    const fileId = parseInt(req.body?.fileId)
    if (isNaN(fileId)) return res.json({ success: false, message: 'fileId 必填' })
    const exists = await (await db.prepare('SELECT id FROM recommendations WHERE file_id = ?')).get(fileId) as any
    if (exists) return res.json({ success: true, id: exists.id, already: true })
    const row = await (await db.prepare(`
      SELECT f.id, f.ext, f.size, d.name AS domain_name, w.quality_score, COALESCE(f.rule_score, 0) AS rule_score
      FROM files f
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      WHERE f.id = ? AND f.status = 'active'`)).get(fileId) as any
    if (!row) return res.json({ success: false, message: '文件不存在或已删除' })
    const score = Number(row.quality_score || 0) * 3 + Number(row.rule_score || 0)
    const reason = ruleReason(row)
    await db.exec(`INSERT INTO recommendations (file_id, score, reason, reason_source, entry_source)
      VALUES (${fileId}, ${score}, '${reason.replace(/'/g, "''")}', 'rule', 'manual')`)
    const idRow = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
    // 理由异步升级：入队 assess 任务把规则理由换成内容化推荐语（若该文件正在蒸馏则跳过，避免争用）
    try {
      const providers = await getProviders()
      const model = await getDefaultModel()
      if (providers.length && model && !llmQueue.hasFile(fileId)) {
        llmQueue.enqueue({ fileId, provider: providers[0].name, model, prompt: '', options: { type: 'assess' }, priority: 1 })
      }
    } catch { /* assess 入队失败不影响入池 */ }
    res.json({ success: true, id: idRow.id, reason, score })
  } catch (e: any) {
    console.error('recommend add failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** AI 策展：已蒸馏 Top30 → 一次批量 LLM 调用挑 10 篇（结果落 recommendations，entry_source='curated'） */
recommendRouter.post('/curate', async (req, res) => {
  try {
    if (llmQueue.hasFile(0)) return res.json({ success: false, message: '策展任务进行中，请稍候' })
    const db = await getDb()
    const cnt = await (await db.prepare("SELECT COUNT(*) AS n FROM files WHERE status = 'active' AND llm_state = 'done'")).get() as any
    if (!cnt.n) return res.json({ success: false, message: '还没有已蒸馏的文件，先在精炼线跑完再策展' })
    const providers = await getProviders()
    const model = await getDefaultModel()
    if (!providers.length || !model) return res.json({ success: false, message: '未配置 LLM，请先在设置里配置模型' })
    llmQueue.enqueue({ fileId: 0, provider: providers[0].name, model, prompt: '', options: { type: 'curate' }, priority: 1 })
    res.json({ success: true })
  } catch (e: any) {
    console.error('recommend curate failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 精选推荐：最近一批策展结果（最多 10 条）+ 最近策展时间 */
recommendRouter.get('/curated', async (req, res) => {
  try {
    const db = await getDb()
    const items = await (await db.prepare(`
      SELECT r.id, r.file_id, r.score, r.reason, r.reason_source, r.status, r.created_at,
             f.title, f.name, f.path, f.ext, d.name AS domain_name, w.quality_score
      FROM recommendations r
      JOIN files f ON f.id = r.file_id
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      WHERE r.entry_source = 'curated'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 10`)).all() as any[]
    const last = await (await db.prepare("SELECT MAX(created_at) AS at FROM recommendations WHERE entry_source = 'curated'")).get() as any
    res.json({ items, lastAt: last?.at || null })
  } catch (e: any) {
    console.error('recommend curated failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 本地日历日期 YYYY-MM-DD（/daily 响应与日报生成共用的「日」口径） */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 每日精选选取（/daily 端点与日报生成共用，保证同一天选取一致）：
 *  今日 3 篇 = 池内 unread 按 score 降序 + 无状态窗口轮转（同一天结果确定，次日滑到下一窗）；
 *  不足 3 篇用预览高分（未入池）补位并标「池外推荐」。零 LLM 成本。 */
export async function selectDailyPicks(db: any, date?: string): Promise<any[]> {
  const pool = await (await db.prepare(`
      SELECT r.file_id, r.reason, r.reason_source,
             COALESCE(NULLIF(f.title, ''), f.name) AS title, f.path, f.ext, f.size,
             d.name AS domain_name, w.quality_score
      FROM recommendations r
      JOIN files f ON f.id = r.file_id
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      WHERE r.status = 'unread' AND f.status = 'active'
      ORDER BY r.score DESC, r.id ASC`)).all() as any[]
  const items: any[] = []
  if (pool.length) {
    // 本地日序号做窗口滑移：窗口大小 3，同一天多次请求一致；传入 date 时按该日历日本地零点取日序号（与当天 new Date() 等值）
    const now = date
      ? (() => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d) })()
      : new Date()
    const epochDay = Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000)
    const start = (epochDay % Math.ceil(pool.length / 3)) * 3
    for (const p of pool.slice(start, start + 3)) items.push({ ...p, outOfPool: false })
  }
  if (items.length < 3) {
    // 池外补位：未入池高分预览（有质量分优先，规则分兜底）
    const outside = await (await db.prepare(`
      SELECT f.id AS file_id, COALESCE(NULLIF(f.title, ''), f.name) AS title, f.path, f.ext, f.size,
             d.name AS domain_name, w.quality_score, COALESCE(f.rule_score, 0) AS rule_score
      FROM files f
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      LEFT JOIN recommendations r ON r.file_id = f.id
      WHERE f.status = 'active' AND r.id IS NULL
      ORDER BY (w.quality_score IS NOT NULL) DESC,
               (COALESCE(w.quality_score, 0) * 3 + COALESCE(f.rule_score, 0)) DESC,
               COALESCE(f.size, 0) DESC
      LIMIT ${3 - items.length}`)).all() as any[]
    for (const o of outside) items.push({ ...o, reason: ruleReason(o), reason_source: 'rule', outOfPool: true })
  }
  return items
}

/** 每日精选（R2）：今日 3 篇 */
recommendRouter.get('/daily', async (req, res) => {
  try {
    const db = await getDb()
    const items = await selectDailyPicks(db)
    res.json({ items, date: localDateStr(new Date()) })
  } catch (e: any) {
    console.error('recommend daily failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 推荐池列表 */
recommendRouter.get('/', async (req, res) => {
  try {
    const db = await getDb()
    const { status = '', limit = '200' } = req.query as Record<string, string>
    const where = status && ['unread', 'read', 'archived'].includes(status) ? `WHERE r.status = '${status}'` : ''
    const lim = Math.min(500, Math.max(1, parseInt(limit) || 200))
    const rows = await (await db.prepare(`
      SELECT r.id, r.file_id, r.score, r.reason, r.reason_source, r.entry_source, r.status, r.created_at,
             f.title, f.name, f.path, f.ext, d.name AS domain_name, w.quality_score
      FROM recommendations r
      JOIN files f ON f.id = r.file_id
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ${lim}`)).all() as any[]
    res.json({ items: rows, total: rows.length })
  } catch (e: any) {
    console.error('recommend list failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 更新推荐状态（unread / read / archived） */
recommendRouter.patch('/:id', async (req, res) => {
  const db = await getDb()
  const { status } = req.body as { status?: string }
  if (!status || !['unread', 'read', 'archived'].includes(status)) {
    return res.json({ success: false, message: 'status 需为 unread/read/archived' })
  }
  await db.exec(`UPDATE recommendations SET status = '${status}' WHERE id = ${parseInt(req.params.id)}`)
  res.json({ success: true })
})

/** 移出推荐池 */
recommendRouter.delete('/:id', async (req, res) => {
  const db = await getDb()
  await db.exec(`DELETE FROM recommendations WHERE id = ${parseInt(req.params.id)}`)
  res.json({ success: true })
})
