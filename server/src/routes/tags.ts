import { Router } from 'express'
import { getDb, normalizeKey, DOMAIN_MEMBER_PAIRS_SQL } from '../db.js'
import {
  mergeTagsInto, runNormalizeScan, startSemanticScan, startLevelScan,
  scanState, relatedTags, tagStats, exportTags, importTags, acceptSemanticProposal, attachOrphanSecondary
} from '../llm/tagGovernance.js'

export const tagsRouter = Router()

/** 手动升级一级（领域）的挂载量级门槛：低于此值默认拒绝，确需升级传 force:true 人工担责；
 * AI 二级选拔线另有 ≥50 的参与门槛（startLevelScan），两线独立 */
const MIN_PRIMARY_MOUNTS = 10

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
  // 挂载计数口径（修复「一级标签挂载 ≠ 分拣区领域成员数」失真）：
  // - 一级锚定标签（领域化身）→ 领域成员统一口径（归类 ∪ 标签体系挂载）。
  //   「领域 ≡ 同名一级标签」不变式的成员半边：标签挂载（蒸馏自由打标）与领域归属（蒸馏精确匹配 + 手动）
  //   是两条独立写入链路，展示层各数各的必然失真（曾现 72 vs 13,989 的 194 倍倒挂）；
  //   与分拣区同口径后两视图天然一致。计数先物化到 TEMP 表再 JOIN——LEFT JOIN 派生表会被
  //   planner 逐行下推重执行（真实库 7.5w files × 24.8w file_tags 实测致本接口 312s，禁改回）。
  // - 其余标签 → 只数 active 文件的挂载（删除文件不清理 file_tags，raw 计数曾混入 7k+ 死挂载）
  await db.exec(`CREATE TEMP TABLE IF NOT EXISTS _domain_member_counts (domain_id INTEGER PRIMARY KEY, count INTEGER)`)
  await db.exec('DELETE FROM _domain_member_counts')
  await db.exec(`INSERT INTO _domain_member_counts (domain_id, count)
    SELECT domain_id, count FROM (${DOMAIN_MEMBER_PAIRS_SQL})`)
  const items = await (await db.prepare(`
    SELECT t.*, pt.name AS parent_name, d.color AS domain_color,
      CASE WHEN t.level = 'primary' AND t.domain_id IS NOT NULL
        THEN COALESCE(dmc.count, 0)
        ELSE (SELECT COUNT(*) FROM file_tags x WHERE x.tag_id = t.id
               AND EXISTS (SELECT 1 FROM files f2 WHERE f2.id = x.file_id AND f2.status = 'active'))
      END AS file_count
    FROM tags t
    LEFT JOIN tags pt ON pt.id = t.parent_tag_id
    LEFT JOIN domains d ON d.id = t.domain_id
    LEFT JOIN _domain_member_counts dmc ON dmc.domain_id = t.domain_id${whereSql}
    ORDER BY ${orderSql} LIMIT ${lim} OFFSET ${off}
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
  let warnings: string[] = []
  let analysis: Record<string, unknown> | null = null
  if (name !== undefined) {
    const trimmed = String(name).trim()
    if (!trimmed) return res.status(400).json({ success: false, message: 'name 不能为空' })
    sets.push(`name = '${trimmed.replace(/'/g, "''")}'`)
  }
  if (color !== undefined) sets.push(`color = '${String(color).replace(/'/g, "''")}'`)
  if (level !== undefined) {
    if (!['primary', 'secondary', 'normal'].includes(level)) return res.status(400).json({ success: false, message: 'level 仅支持 primary/secondary/normal' })
    if (level === 'primary') {
      // 门禁：升级一级 = 创建/绑定领域，必须量级够硬——挂载次数达 MIN_PRIMARY_MOUNTS 才放行，
      // 低量级确需升级传 force:true 人工担责（修复「0 挂载也能升一级」的零门槛漏洞）
      const cntRow = await (await db.prepare('SELECT COUNT(*) AS n FROM file_tags WHERE tag_id = ?')).get([id]) as any
      const mounts = Number(cntRow?.n || 0)
      if (!req.body?.force && mounts < MIN_PRIMARY_MOUNTS) {
        return res.status(400).json({ success: false, message: `升级一级需挂载 ≥ ${MIN_PRIMARY_MOUNTS} 次（当前 ${mounts}）：低量级标签不足以支撑领域；确认无误请传 force: true 强制升级` })
      }
      // 一级 = 就是领域，且名实必须一致（领域 ≡ 同名一级标签）：显式 domainId 优先（校验存在 + 校验同名），
      // 否则按本次请求生效名（改名同请求时取新名）归一锚定——全角/大小写/空白变体视为同一领域，不再造重复领域
      const cur = await (await db.prepare('SELECT name FROM tags WHERE id = ?')).get([id]) as any
      const effectiveName = name !== undefined ? String(name).trim() : cur?.name
      if (!effectiveName) return res.status(400).json({ success: false, message: '无法确定领域：标签缺少有效名称' })
      const effKey = normalizeKey(effectiveName)
      const allDomains = await (await db.prepare('SELECT id, name FROM domains')).all() as any[]
      let domainId: number | null = null
      if (req.body?.domainId != null) {
        const did = parseInt(req.body.domainId)
        const dom = did ? allDomains.find(d => Number(d.id) === did) : null
        if (!dom) return res.status(400).json({ success: false, message: 'domainId 必须指向已存在的领域' })
        if (normalizeKey(String(dom.name)) !== effKey) {
          return res.status(400).json({ success: false, message: `一级标签名必须与领域名一致：「${effectiveName}」≠ 领域「${dom.name}」（领域 ≡ 同名一级标签）` })
        }
        domainId = dom.id
      } else {
        const dom = allDomains.find(d => normalizeKey(String(d.name)) === effKey)
        if (dom) {
          domainId = dom.id
          warnings.push(`领域「${dom.name}」已存在，本次为挂靠绑定而非新建${String(dom.name) !== effectiveName ? '（名称按归一比对匹配：全角/大小写/空白差异，标签名将自动对齐领域名）' : ''}`)
        } else {
          await db.exec(`INSERT INTO domains (name) VALUES ('${effectiveName.replace(/'/g, "''")}')`)
          domainId = (await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get(effectiveName) as any)?.id ?? null
        }
      }
      if (!domainId) return res.status(400).json({ success: false, message: '无法确定领域：显式 domainId 或按名称创建领域失败' })
      // 挂靠既有领域时标签名对齐领域规范名（守护「同名」不变式，否则启动对账 ensureDomainTag 按精确名补建会撞 UNIQUE）
      const boundDomain = allDomains.find(d => Number(d.id) === Number(domainId)) as any
      if (boundDomain && effectiveName !== String(boundDomain.name)) sets.push(`name = '${String(boundDomain.name).replace(/'/g, "''")}'`)
      sets.push(`level = 'primary'`, `domain_id = ${Number(domainId)}`, 'parent_tag_id = NULL')
      // 现有一级格局分析：本次升级排在第几梯队、与头部领域量级对比（修复「升级无对比分析」）
      const primaries = await (await db.prepare(`
        SELECT t.id, t.name, COUNT(ft.file_id) AS mounts FROM tags t
        LEFT JOIN file_tags ft ON ft.tag_id = t.id
        WHERE t.status = 'active' AND t.level = 'primary' AND t.id != ?
        GROUP BY t.id ORDER BY mounts DESC`)).all([id]) as any[]
      const rank = primaries.filter(r => Number(r.mounts) >= mounts).length + 1
      const total = primaries.length + 1
      if (total > 1 && rank > total / 2) warnings.push(`当前挂载 ${mounts} 次在现有 ${total} 个领域中排第 ${rank}，量级偏后，建议确认是否真为核心领域`)
      analysis = {
        mounts,
        rank,
        totalPrimaries: total,
        topPrimaries: primaries.slice(0, 5).map(r => ({ name: r.name, mounts: Number(r.mounts) })),
      }
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
    res.json({
      success: true,
      ...(warnings.length ? { warnings } : {}),
      ...(analysis ? { analysis } : {}),
    })
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
  if (p.kind === 'semantic') {
    // 单条人工接受：保持历史行为（不限制成员 level）
    const r = await acceptSemanticProposal(db, p, false)
    if (!r.ok) return res.json({ success: false, message: r.message })
    return res.json({ success: true, merged: r.merged, moved: r.moved })
  }
  // level：按名字批量降为次要，保留 parent_tag_id——挂靠在落提案/手动微调时已就位，接受只升格不清挂
  // （曾置 NULL 会把「落提案即挂靠」的成果抹掉，标签全落「未挂靠」组）；已被合并/停用的自动跳过。
  // 领域锚点保护：与领域同名（归一比对）的标签是「领域 ≡ 一级标签」的锚，降级会让领域失锚且同名阻塞重建——跳过并计数
  const members: string[] = JSON.parse(p.members || '[]')
  const domainKeys = new Set(((await (await db.prepare('SELECT name FROM domains')).all()) as any[]).map(r => normalizeKey(r.name)))
  let downgraded = 0
  let skippedPrimary = 0
  for (const name of members) {
    if (domainKeys.has(normalizeKey(name))) { skippedPrimary++; continue }
    const esc = String(name).replace(/'/g, "''")
    await db.exec(`UPDATE tags SET level = 'secondary' WHERE name = '${esc}' AND status = 'active' AND level != 'primary'`)
    downgraded++
  }
  await db.exec(`UPDATE tag_proposals SET status = 'accepted' WHERE id = ${p.id}`)
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('accept_level', '${p.members.replace(/'/g, "''")}')`)
  res.json({ success: true, downgraded, ...(skippedPrimary ? { skippedPrimary } : {}) })
}))

tagsRouter.post('/proposals/:id/reject', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  const p = await (await db.prepare("SELECT id FROM tag_proposals WHERE id = ? AND status = 'pending'")).get(id) as any
  if (!p) return res.status(404).json({ success: false, message: '建议不存在或已处理' })
  await db.exec(`UPDATE tag_proposals SET status = 'rejected' WHERE id = ${id}`)
  res.json({ success: true })
}))

/** 手动微调 level 提案成员的一级挂靠：改 tags.parent_tag_id 并同步提案 attach_map（未挂靠成员可借此补挂）。
 * 守卫：仅 pending level 提案 + 成员必须在 members 内 + 目标父必须是 active 一级 + 领域锚点不可被改挂 */
tagsRouter.post('/proposals/:id/reparent', wrap(async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  const p = await (await db.prepare("SELECT * FROM tag_proposals WHERE id = ? AND status = 'pending' AND kind = 'level'")).get(id) as any
  if (!p) return res.status(404).json({ success: false, message: '建议不存在或已处理' })
  const member = String(req.body?.member || '').trim()
  const parentId = parseInt(req.body?.parentTagId)
  if (!member || !parentId) return res.status(400).json({ success: false, message: 'member 与 parentTagId 必填' })
  const parent = await (await db.prepare("SELECT id, name FROM tags WHERE id = ? AND status = 'active' AND level = 'primary'")).get(parentId) as any
  if (!parent) return res.status(400).json({ success: false, message: 'parentTagId 必须指向有效的 active 一级标签' })
  const members: string[] = JSON.parse(p.members || '[]')
  if (!members.includes(member)) return res.status(400).json({ success: false, message: `「${member}」不在该提案成员中` })
  const domainKeys = new Set(((await (await db.prepare('SELECT name FROM domains')).all()) as any[]).map(r => normalizeKey(r.name)))
  if (domainKeys.has(normalizeKey(member))) return res.status(400).json({ success: false, message: '领域锚点标签不可挂靠' })
  const tag = await (await db.prepare("SELECT id FROM tags WHERE name = ? AND status = 'active' AND level != 'primary'")).get(member) as any
  if (!tag) return res.status(400).json({ success: false, message: `成员「${member}」不存在或不可用` })
  await db.exec(`UPDATE tags SET parent_tag_id = ${Number(parent.id)} WHERE id = ${Number(tag.id)}`)
  // 同步 attach_map（成员 → 一级名）：前端显示与接受后状态一致
  let am: Record<string, string> = {}
  try { am = JSON.parse(p.attach_map || '{}') || {} } catch { am = {} }
  am[member] = String(parent.name)
  await db.exec(`UPDATE tag_proposals SET attach_map = '${JSON.stringify(am).replace(/'/g, "''")}' WHERE id = ${id}`)
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('reparent_level', '{"proposal":${id},"member":"${member.replace(/'/g, "''")}","parent":"${String(parent.name).replace(/'/g, "''")}"}')`)
  res.json({ success: true, attach_map: JSON.stringify(am), parent: String(parent.name) })
}))

/** 批量接受语义归组建议（长尾大规模收敛）：比单条更严的守卫——仅合并 normal 成员（一级/二级归属人工处理），
 * 规范名失效的整条跳过并保持 pending 留待人工。无上限逐条执行，前端 confirm 后调用 */
// 尺寸守卫（accept/reject-oversized 两端点共用）：>12 成员的组几乎都是「同前缀全家桶」式过度合并
// （真实库 1310 条中 ~105 条 ≥13，如 GitHub 50 成员把 Actions/CLI/Copilot 等不同工具吞并）——
// ≤12 的同前缀变体族是安全主体；超大组保持 pending 留待人工拆分或批量驳回，不计入 skipped（skipped 专指规范名失效）
const MAX_BATCH_MEMBERS = 12
tagsRouter.post('/proposals/accept-batch', wrap(async (req, res) => {
  const db = await getDb()
  if ((req.body?.kind || 'semantic') !== 'semantic') return res.status(400).json({ success: false, message: '批量接受仅支持 kind=semantic' })
  const pending = await (await db.prepare("SELECT * FROM tag_proposals WHERE status = 'pending' AND kind = 'semantic' ORDER BY id")).all() as any[]
  let accepted = 0
  let skipped = 0
  let oversized = 0
  let moved = 0
  for (const p of pending) {
    let members: string[] = []
    try { members = JSON.parse(p.members || '[]') } catch { members = [] }
    if (Array.isArray(members) && members.length > MAX_BATCH_MEMBERS) { oversized++; continue }
    const r = await acceptSemanticProposal(db, p, true)
    if (r.ok) { accepted++; moved += r.moved } else { skipped++ }
  }
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('accept_semantic_batch', '{"accepted":${accepted},"skipped":${skipped},"oversized":${oversized},"moved":${moved}}')`)
  res.json({ success: true, accepted, skipped, oversized, moved })
}))

/** 批量驳回超大组语义建议（>12 成员）：accept-batch 永远跳过它们（守卫同口径），按钮消化不了的
 * 死库存需要一条显式出口。仅驳回 kind=semantic + 成员超阈值的 pending；规范名失效的小组不在此列
 * （留给逐条人工判断）。审计落 tag_ops 供回溯。 */
tagsRouter.post('/proposals/reject-oversized', wrap(async (req, res) => {
  const db = await getDb()
  if ((req.body?.kind || 'semantic') !== 'semantic') return res.status(400).json({ success: false, message: '批量驳回仅支持 kind=semantic' })
  const pending = await (await db.prepare("SELECT id, members FROM tag_proposals WHERE status = 'pending' AND kind = 'semantic' ORDER BY id")).all() as any[]
  let rejected = 0
  for (const p of pending) {
    let members: string[] = []
    try { members = JSON.parse(p.members || '[]') } catch { members = [] }
    if (Array.isArray(members) && members.length > MAX_BATCH_MEMBERS) {
      await db.exec(`UPDATE tag_proposals SET status = 'rejected' WHERE id = ${Number(p.id)}`)
      rejected++
    }
  }
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('reject_semantic_oversized', '{"rejected":${rejected},"threshold":${MAX_BATCH_MEMBERS}}')`)
  res.json({ success: true, rejected })
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

/** 孤儿二级标签 AI 批量挂靠（同步，~1 批/10-20s）：未挂靠二级 → LLM 语义映射 → 挂到一级领域 */
tagsRouter.post('/secondary/attach', wrap(async (_req, res) => {
  const r = await attachOrphanSecondary(await getDb())
  res.json({ success: true, ...r })
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
