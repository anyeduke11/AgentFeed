import { Router } from 'express'
import { getDb } from '../db.js'
import {
  mergeTagsInto, runNormalizeScan, startSemanticScan, startLevelScan,
  scanState, relatedTags, tagStats, exportTags, importTags
} from '../llm/tagGovernance.js'

export const tagsRouter = Router()

// 所有 handler 包 try/catch：SQLITE_BUSY 等瞬态错误返回 JSON 而非杀死进程（Express 4 不接 async rejection）
const wrap = (fn: (req: any, res: any) => Promise<void>) => (req: any, res: any) => {
  fn(req, res).catch((e: any) => res.json({ success: false, message: String(e?.message || e) }))
}

/** 列表：level/status/kw 过滤 + 排序 + 分页。默认只出 active 标签，按挂载数降序 */
tagsRouter.get('/', wrap(async (req, res) => {
  const db = await getDb()
  const { kw, level, status = 'active', sort = 'count', limit = '200', offset = '0' } = req.query as Record<string, string>
  const where: string[] = []
  const params: any[] = []
  if (status !== 'all') { where.push('t.status = ?'); params.push(status) }
  if (level) { where.push('t.level = ?'); params.push(level) }
  if (kw) { where.push('t.name LIKE ?'); params.push(`%${kw}%`) }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const lim = Math.max(1, Math.min(5000, parseInt(limit) || 200))
  const off = Math.max(0, parseInt(offset) || 0)
  const orderSql = sort === 'name' ? 't.name' : 'file_count DESC, t.name'
  const items = await (await db.prepare(`
    SELECT t.*, COUNT(ft.file_id) AS file_count FROM tags t
    LEFT JOIN file_tags ft ON ft.tag_id = t.id${whereSql}
    GROUP BY t.id ORDER BY ${orderSql} LIMIT ${lim} OFFSET ${off}
  `)).all(...params) as any[]
  const totalRow = await (await db.prepare(`
    SELECT COUNT(DISTINCT t.id) AS n FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id${whereSql}
  `)).get(...params) as any
  res.json({ items, total: Number(totalRow?.n || 0) })
}))

tagsRouter.post('/', wrap(async (req, res) => {
  const db = await getDb()
  const { name, color } = req.body as Record<string, any>
  if (!name) return res.status(400).json({ success: false, message: 'name 必填' })
  try {
    const escapedName = String(name).replace(/'/g, "''")
    const escapedColor = String(color || '#67c23a').replace(/'/g, "''")
    await db.exec(`INSERT INTO tags (name, color) VALUES ('${escapedName}', '${escapedColor}')`)
    const idRow = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
    await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('create', '{"id":${idRow.id},"name":"${escapedName}"}')`)
    res.json({ success: true, id: idRow.id })
  } catch (e: any) {
    res.status(409).json({ success: false, message: '标签已存在' })
  }
}))

/** 编辑：改名 / 换色 / 分级 / 状态 */
tagsRouter.patch('/:id', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  const { name, color, level, status } = req.body as Record<string, any>
  const row = await (await db.prepare('SELECT id, status FROM tags WHERE id = ?')).get(id) as any
  if (!row) return res.status(404).json({ success: false, message: '标签不存在' })
  const sets: string[] = []
  if (name !== undefined) {
    const trimmed = String(name).trim()
    if (!trimmed) return res.status(400).json({ success: false, message: 'name 不能为空' })
    sets.push(`name = '${trimmed.replace(/'/g, "''")}'`)
  }
  if (color !== undefined) sets.push(`color = '${String(color).replace(/'/g, "''")}'`)
  if (level !== undefined) {
    if (!['primary', 'secondary'].includes(level)) return res.status(400).json({ success: false, message: 'level 仅支持 primary/secondary' })
    sets.push(`level = '${level}'`)
  }
  if (status !== undefined) {
    if (!['active', 'retired'].includes(status)) return res.status(400).json({ success: false, message: 'status 仅支持 active/retired' })
    sets.push(`status = '${status}'`)
    if (status === 'active') sets.push('merged_into = NULL')
  }
  if (!sets.length) return res.status(400).json({ success: false, message: '无可更新字段' })
  try {
    await db.exec(`UPDATE tags SET ${sets.join(', ')} WHERE id = ${id}`)
    await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('update', '${JSON.stringify(req.body).replace(/'/g, "''")}')`)
    res.json({ success: true })
  } catch (e: any) {
    res.status(409).json({ success: false, message: '改名冲突：同名标签已存在' })
  }
}))

/** 手动合并：把 :id 合并进 body.into 指向的标签 */
tagsRouter.post('/:id/merge', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  const into = parseInt(req.body?.into)
  if (!into || into === id) return res.status(400).json({ success: false, message: 'into 必填且不能等于自身' })
  const src = await (await db.prepare("SELECT id FROM tags WHERE id = ? AND status = 'active'")).get(id) as any
  const dst = await (await db.prepare("SELECT id FROM tags WHERE id = ? AND status = 'active'")).get(into) as any
  if (!src || !dst) return res.status(404).json({ success: false, message: '标签不存在或不可合并' })
  const moved = await mergeTagsInto(db, into, [id], 'manual_merge')
  res.json({ success: true, moved })
}))

/** 停用（淘汰）：不再用于标记，仅保留历史 */
tagsRouter.post('/:id/retire', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  await db.exec(`UPDATE tags SET status = 'retired' WHERE id = ${id} AND status = 'active'`)
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('retire', '{"id":${id}}')`)
  res.json({ success: true })
}))

/** 从停用恢复为可用 */
tagsRouter.post('/:id/restore', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  await db.exec(`UPDATE tags SET status = 'active', merged_into = NULL WHERE id = ${id} AND status = 'retired'`)
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('restore', '{"id":${id}}')`)
  res.json({ success: true })
}))

/** 共现关联：与该标签最常一起出现的标签 */
tagsRouter.get('/related', wrap(async (req, res) => {
  const id = parseInt(String(req.query.id))
  if (!id) return res.status(400).json({ success: false, message: 'id 必填' })
  res.json(await relatedTags(id, parseInt(String(req.query.limit)) || 12))
}))

/** 建议列表：kind=semantic|level，status 默认 pending */
tagsRouter.get('/proposals', wrap(async (req, res) => {
  const db = await getDb()
  const { status = 'pending', kind } = req.query as Record<string, string>
  let sql = 'SELECT * FROM tag_proposals WHERE status = ?'
  const params: any[] = [status]
  if (kind) { sql += ' AND kind = ?'; params.push(kind) }
  sql += ' ORDER BY created_at DESC LIMIT 500'
  res.json(await (await db.prepare(sql)).all(...params))
}))

/** 接受建议：semantic=执行合并；level=批量降为次要 */
tagsRouter.post('/proposals/:id/accept', wrap(async (req, res) => {
  const db = await getDb()
  const p = await (await db.prepare("SELECT * FROM tag_proposals WHERE id = ? AND status = 'pending'")).get(parseInt(req.params.id)) as any
  if (!p) return res.status(404).json({ success: false, message: '建议不存在或已处理' })
  const members: string[] = JSON.parse(p.members || '[]')
  if (p.kind === 'semantic') {
    const canonical = await (await db.prepare("SELECT id FROM tags WHERE name = ? AND status = 'active'")).get(p.canonical) as any
    if (!canonical) return res.json({ success: false, message: `规范名「${p.canonical}」不存在或不可用，请手动处理` })
    let moved = 0
    const memberIds: number[] = []
    for (const name of members) {
      if (name === p.canonical) continue
      const row = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(name) as any
      if (row) memberIds.push(row.id)
    }
    moved = await mergeTagsInto(db, canonical.id, memberIds, 'accept_semantic')
    await db.exec(`UPDATE tag_proposals SET status = 'accepted' WHERE id = ${p.id}`)
    return res.json({ success: true, merged: memberIds.length, moved })
  }
  // level：按名字批量降级（已被合并/停用的自动跳过）
  let downgraded = 0
  for (const name of members) {
    const esc = String(name).replace(/'/g, "''")
    await db.exec(`UPDATE tags SET level = 'secondary' WHERE name = '${esc}' AND status = 'active'`)
    downgraded++
  }
  await db.exec(`UPDATE tag_proposals SET status = 'accepted' WHERE id = ${p.id}`)
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('accept_level', '${p.members.replace(/'/g, "''")}')`)
  res.json({ success: true, downgraded })
}))

tagsRouter.post('/proposals/:id/reject', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  const p = await (await db.prepare("SELECT id FROM tag_proposals WHERE id = ? AND status = 'pending'")).get(id) as any
  if (!p) return res.status(404).json({ success: false, message: '建议不存在或已处理' })
  await db.exec(`UPDATE tag_proposals SET status = 'rejected' WHERE id = ${id}`)
  res.json({ success: true })
}))

// ---- 收敛扫描 ----

/** 规则归一：同步执行（确定性归并，秒级） */
tagsRouter.post('/scan/normalize', wrap(async (_req, res) => {
  const result = await runNormalizeScan()
  res.json({ success: true, ...result })
}))

/** AI 语义归组：后台异步，立即返回（同一时间仅允许一个 AI 扫描任务） */
tagsRouter.post('/scan/semantic', wrap(async (req, res) => {
  const ok = startSemanticScan(parseInt(req.body?.batchSize) || 400)
  if (!ok) return res.json({ success: false, message: `已有扫描任务（${scanState.running}）进行中` })
  res.json({ success: true })
}))

/** AI 次要标签判定：maxCount 为参与判定的挂载次数上限（默认 ≤2），后台异步 */
tagsRouter.post('/scan/level', wrap(async (req, res) => {
  const ok = startLevelScan(parseInt(req.body?.maxCount) || 2, parseInt(req.body?.batchSize) || 400)
  if (!ok) return res.json({ success: false, message: `已有扫描任务（${scanState.running}）进行中` })
  res.json({ success: true })
}))

tagsRouter.get('/scan/status', wrap(async (_req, res) => {
  res.json(scanState)
}))

// ---- 分析 / 导入导出 / 审计 ----

tagsRouter.get('/stats', wrap(async (_req, res) => {
  res.json(await tagStats())
}))

tagsRouter.get('/export', wrap(async (req, res) => {
  const rows = await exportTags()
  if ((req.query.format || 'json') === 'csv') {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const csv = ['id,name,color,level,status,merged_into,file_count',
      ...rows.map((r: any) => [r.id, r.name, r.color, r.level, r.status, r.merged_into ?? '', r.file_count].map(esc).join(',')),
    ].join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="tags-export.csv"')
    return res.send('\ufeff' + csv)
  }
  res.setHeader('Content-Disposition', 'attachment; filename="tags-export.json"')
  res.json(rows)
}))

tagsRouter.post('/import', wrap(async (req, res) => {
  const items = req.body?.tags
  if (!Array.isArray(items)) return res.status(400).json({ success: false, message: 'body.tags 必须为数组' })
  res.json({ success: true, ...(await importTags(items)) })
}))

tagsRouter.get('/ops', wrap(async (req, res) => {
  const db = await getDb()
  const lim = Math.max(1, Math.min(500, parseInt(String(req.query.limit)) || 100))
  res.json(await (await db.prepare(`SELECT * FROM tag_ops ORDER BY id DESC LIMIT ${lim}`)).all())
}))
