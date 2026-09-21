import { Router } from 'express'
import { getDb, ensureDomainTag, normalizeKey } from '../db.js'

export const domainsRouter = Router()

/** 彩虹色：按序号在色环 0°~330° 均匀取色（与前端总览进度条同一算法） */
function rainbow(i: number, n: number, child = false) {
  const hue = Math.round((i / Math.max(1, n)) * 330)
  return `hsl(${hue}, ${child ? 58 : 68}%, ${child ? 64 : 50}%)`
}

domainsRouter.get('/', async (req, res) => {
  const db = await getDb()
  const stmt = await db.prepare('SELECT * FROM domains ORDER BY sort, name')
  const rows = (await stmt.all()) as any[]
  // 每个领域的活跃文件数（含子领域聚合为父级 total）
  const countRows = await (await db.prepare(`
    SELECT domain_id, COUNT(*) as count FROM files
    WHERE status = 'active' AND domain_id IS NOT NULL
    GROUP BY domain_id
  `)).all() as any[]
  const countMap = new Map<number, number>(countRows.map(r => [r.domain_id, r.count]))
  const tree: any[] = []
  const map = new Map<number, any>()
  for (const r of rows) {
    map.set(r.id, { ...r, count: countMap.get(r.id) ?? 0, children: [] })
  }
  for (const r of rows) {
    const node = map.get(r.id)!
    if (r.parent_id) {
      const parent = map.get(r.parent_id)
      parent?.children.push(node)
    } else {
      tree.push(node)
    }
  }
  // 为未设置颜色的领域按树序分配彩虹色并持久化，保证总览进度条与分拣区色带同色
  const totalRows = rows.length
  let idx = 0
  const assignColor = async (node: any, child: boolean) => {
    if (!node.color) {
      node.color = rainbow(idx, totalRows, child)
      await db.exec(`UPDATE domains SET color = '${node.color}' WHERE id = ${node.id}`)
    }
    idx++
    for (const c of node.children || []) await assignColor(c, true)
  }
  for (const t of tree) await assignColor(t, false)
  // 后序遍历：父级 total = 自身 count + 所有子孙 count
  const subtreeTotal = (node: any): number => {
    node.total = node.count + (node.children || []).reduce((s: number, c: any) => s + subtreeTotal(c), 0)
    return node.total
  }
  tree.forEach(subtreeTotal)
  res.json(tree)
})

domainsRouter.post('/', async (req, res) => {
  const db = await getDb()
  const { name, parent_id, color, description } = req.body as Record<string, any>
  if (!name) return res.status(400).json({ success: false, message: 'name 必填' })
  // 归一查重：UNIQUE(name, parent_id) 对 NULL 父级失效（SQLite NULL 互不相等，重复领域曾由此漏网），
  // 应用层按归一 key 拦截（全角/大小写/空白变体同判），DB 层另有部分唯一索引 ux_domains_name_root 兜底
  const parentId = parent_id === null || parent_id === undefined ? null : Number(parent_id)
  const all = await (await db.prepare('SELECT id, name, parent_id FROM domains')).all() as any[]
  const dup = all.find(r => normalizeKey(r.name) === normalizeKey(String(name)) && (r.parent_id ?? null) === parentId)
  if (dup) return res.status(409).json({ success: false, message: `领域「${dup.name}」已存在`, existingId: dup.id })
  const escapedName = String(name).replace(/'/g, "''")
  // 未指定颜色时按当前领域数自动取彩虹序号色
  const cntRow = await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any
  const escapedColor = String(color || rainbow(cntRow.n, Math.max(cntRow.n + 1, 12))).replace(/'/g, "''")
  const escapedDesc = description === null ? 'NULL' : `'${String(description).replace(/'/g, "''")}'`
  const parentVal = parent_id === null || parent_id === undefined ? 'NULL' : parent_id
  try {
    await db.exec(`INSERT INTO domains (name, parent_id, color, description) VALUES ('${escapedName}', ${parentVal}, '${escapedColor}', ${escapedDesc})`)
  } catch {
    return res.status(409).json({ success: false, message: '领域创建冲突：同名领域已存在（可能并发创建）' })
  }
  const idRow = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
  // 强一致：领域 ≡ 一级主要标签——建领域即建同名一级标签
  await ensureDomainTag(db, Number(idRow.id), String(name))
  res.json({ success: true, id: idRow.id })
})

domainsRouter.patch('/:id', async (req, res) => {
  const db = await getDb()
  const { name, parent_id, color, description, sort } = req.body as Record<string, any>
  const domId = parseInt(req.params.id)
  if (name !== undefined) {
    // 归一查重：改名不得与其他领域重名（否则部分唯一索引拒写裸抛 500），同请求改 parent 时按新父级判定
    const effParent = parent_id !== undefined ? (parent_id === null ? null : Number(parent_id))
      : ((await (await db.prepare('SELECT parent_id FROM domains WHERE id = ?')).get([domId]) as any)?.parent_id ?? null)
    const all = await (await db.prepare('SELECT id, name, parent_id FROM domains')).all() as any[]
    const dup = all.find(r => r.id !== domId
      && normalizeKey(r.name) === normalizeKey(String(name))
      && (r.parent_id ?? null) === (effParent ?? null))
    if (dup) return res.status(409).json({ success: false, message: `改名冲突：领域「${dup.name}」已存在` })
  }
  const sets: string[] = []
  if (name !== undefined) sets.push(`name = '${String(name).replace(/'/g, "''")}'`)
  if (parent_id !== undefined) sets.push(`parent_id = ${parent_id === null || parent_id === undefined ? 'NULL' : parent_id}`)
  if (color !== undefined) sets.push(`color = '${String(color).replace(/'/g, "''")}'`)
  if (description !== undefined) sets.push(`description = ${description === null ? 'NULL' : `'${String(description).replace(/'/g, "''")}'`}`)
  if (sort !== undefined) sets.push(`sort = ${parseInt(String(sort)) || 0}`)
  if (sets.length === 0) return res.json({ success: true })
  await db.exec(`UPDATE domains SET ${sets.join(', ')} WHERE id = ${domId}`)
  // 强一致：领域 ≡ 一级主要标签——改名领域时同名一级标签跟随改名
  let warning: string | undefined
  if (name !== undefined && domId) {
    const esc = String(name).replace(/'/g, "''")
    // 死行（retired/merged）占用新名时让位：历史名保留 id 后缀可溯（如改回旧名场景）
    await db.exec(`UPDATE tags SET name = name || '·' || id WHERE name = '${esc}' AND status != 'active'`)
    try {
      await db.exec(`UPDATE tags SET name = '${esc}' WHERE domain_id = ${domId} AND level = 'primary' AND status = 'active'`)
    } catch { /* 新名与活跃标签撞 UNIQUE → 领域改名成功、标签同步跳过（响应 warning 提示，启动对账兜底） */
      warning = '领域已改名，但同名一级标签同步失败（名称被其他活跃标签占用），服务重启对账时将自动修复'
    }
  }
  res.json({ success: true, ...(warning ? { warning } : {}) })
})

domainsRouter.delete('/:id', async (req, res) => {
  const db = await getDb()
  const id = parseInt(req.params.id)
  if (!id) return res.status(400).json({ success: false, message: '无效的领域 id' })
  // 递归收集自身 + 全部子孙（弹窗承诺：子领域一并移除，否则孤儿 parent_id 悬挂、列表组树静默丢节点）
  const rows = await (await db.prepare('SELECT id, parent_id FROM domains')).all() as any[]
  const childMap = new Map<number, number[]>()
  for (const r of rows) {
    if (r.parent_id) {
      const list = childMap.get(r.parent_id) || []
      list.push(r.id)
      childMap.set(r.parent_id, list)
    }
  }
  const ids = [id]
  for (let i = 0; i < ids.length; i++) {
    for (const c of childMap.get(ids[i]) || []) ids.push(c)
  }
  const inClause = ids.join(',')
  // 名下文件回归未分类（弹窗承诺）
  await db.exec(`UPDATE files SET domain_id = NULL WHERE domain_id IN (${inClause})`)
  // 一级 = 领域：领域没了，同名对齐的一级标签失去存在依据 → 降级 normal（与「一级必须绑定领域」约束一致）
  await db.exec(`UPDATE tags SET level = 'normal' WHERE domain_id IN (${inClause}) AND level = 'primary'`)
  await db.exec(`UPDATE tags SET domain_id = NULL WHERE domain_id IN (${inClause})`)
  const nameRows = await (await db.prepare(`SELECT name FROM domains WHERE id IN (${inClause})`)).all() as any[]
  await db.exec(`DELETE FROM domains WHERE id IN (${inClause})`)
  // 墓碑：被删名记入 config，防止下次启动 seedDefaults 重新播种（复活 bug 根因）
  let tomb: string[] = []
  try {
    const tombRow = await (await db.prepare(`SELECT value FROM config WHERE key = 'domains.tombstones'`)).get() as any
    if (tombRow?.value) tomb = JSON.parse(tombRow.value)
  } catch { /* 值损坏 → 重建墓碑名单 */ }
  const merged = Array.from(new Set([...tomb, ...nameRows.map(r => String(r.name))]))
  const escapedTombs = JSON.stringify(merged).replace(/'/g, "''")
  await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('domains.tombstones', '${escapedTombs}', 'json', '已删除领域名（防种子复活）') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  res.json({ success: true, removed: ids.length })
})
