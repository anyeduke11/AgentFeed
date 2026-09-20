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
  // 排序：按名字时纯字典序；默认按级档（一级→二级→普通）+ 挂载数
  const orderSql = sort === 'name'
    ? 't.name'
    : "CASE t.level WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END, file_count DESC, t.name"
  const items = await (await db.prepare(`
    SELECT t.*, pt.name AS parent_name, d.color AS domain_color, COUNT(ft.file_id) AS file_count FROM tags t
    LEFT JOIN file_tags ft ON ft.tag_id = t.id
    LEFT JOIN tags pt ON pt.id = t.parent_tag_id
    LEFT JOIN domains d ON d.id = t.domain_id${whereSql}
    GROUP BY t.id ORDER BY ${orderSql} LIMIT ${lim} OFFSET ${off}
  `)).all(params) as any[]
  const totalRow = await (await db.prepare(`
    SELECT COUNT(DISTINCT t.id) AS n FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id${whereSql}
  `)).get(params) as any
  res.json({ items, total: Number(totalRow?.n || 0) })
}))

tagsRouter.post('/', wrap(async (req, res) => {
  const db = await getDb()
  const { name, color } = req.body as Record<string, any>
  if (!name) return res.status(400).json({ success: false, message: 'name 必填' })
  try {
    const escapedName = String(name).replace(/'/g, "''")
    const escapedColor = String(color || '#67c23a').replace(/'/g, "''")
    // 手动新建默认普通标签：一级/二级走治理（详见 PATCH level）
    await db.exec(`INSERT INTO tags (name, color, level) VALUES ('${escapedName}', '${escapedColor}', 'normal')`)
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
    if (!['primary', 'secondary', 'normal'].includes(level)) return res.status(400).json({ success: false, message: 'level 仅支持 primary/secondary/normal' })
    if (level === 'primary') {
      // 一级 = 就是领域：显式 domainId（校验存在，垃圾值 fail loud 与 parentTagId 对齐）优先；
      // 否则按本次请求生效名（改名同请求时取新名）同名锚定，缺则自动创建（配色由领域列表接口兜底）
      let domainId: number | null = null
      if (req.body?.domainId != null) {
        const did = parseInt(req.body.domainId)
        const dom = did ? await (await db.prepare('SELECT id FROM domains WHERE id = ?')).get([did]) as any : null
        if (!dom) return res.status(400).json({ success: false, message: 'domainId 必须指向已存在的领域' })
        domainId = dom.id
      } else {
        const cur = await (await db.prepare('SELECT name FROM tags WHERE id = ?')).get([id]) as any
        const effectiveName = name !== undefined ? String(name).trim() : cur?.name
        if (!effectiveName) return res.status(400).json({ success: false, message: '无法确定领域：标签缺少有效名称' })
        const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get(effectiveName) as any
        if (dom) domainId = dom.id
        else {
          await db.exec(`INSERT INTO domains (name) VALUES ('${effectiveName.replace(/'/g, "''")}')`)
          const created = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get(effectiveName) as any
          domainId = created?.id ?? null
        }
      }
      if (!domainId) return res.status(400).json({ success: false, message: '无法确定领域：显式 domainId 或按名称创建领域失败' })
      sets.push(`level = 'primary'`, `domain_id = ${Number(domainId)}`, 'parent_tag_id = NULL')
    } else if (level === 'secondary') {
      // 二级 = 次要领域，树形挂靠在某个一级标签下（手动强制；AI 选拔提案接受后落「未挂靠」，由前端补挂）
      const pid = req.body?.parentTagId != null ? parseInt(req.body.parentTagId) : NaN
      if (!pid || pid === id) return res.status(400).json({ success: false, message: '设为二级需显式传 parentTagId（指向某个一级标签，且不能是自身）' })
      const p = await (await db.prepare("SELECT id, level, status FROM tags WHERE id = ?")).get(pid) as any
      if (!p || p.status !== 'active' || p.level !== 'primary') return res.status(400).json({ success: false, message: 'parentTagId 必须指向有效的 active 一级标签' })
      sets.push(`level = 'secondary'`, `parent_tag_id = ${Number(pid)}`, 'domain_id = NULL')
    } else {
      sets.push(`level = '${level}'`, 'domain_id = NULL', 'parent_tag_id = NULL')
    }
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
  // 父级停用：其次级子标签回落「未挂靠」
  await db.exec(`UPDATE tags SET parent_tag_id = NULL WHERE parent_tag_id = ${id}`)
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
  res.json(await (await db.prepare(sql)).all(params))
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
  // level：按名字批量降为次要（软挂：不指父，落「未挂靠」组，由前端补挂；已被合并/停用的自动跳过）
  let downgraded = 0
  for (const name of members) {
    const esc = String(name).replace(/'/g, "''")
    await db.exec(`UPDATE tags SET level = 'secondary', parent_tag_id = NULL WHERE name = '${esc}' AND status = 'active'`)
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

/** AI 二级领域选拔：minCount 为参与选拔的普通标签挂载次数下限（默认 ≥50），后台异步 */
tagsRouter.post('/scan/level', wrap(async (req, res) => {
  const ok = startLevelScan(parseInt(req.body?.minCount) || 50, parseInt(req.body?.batchSize) || 50)
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
