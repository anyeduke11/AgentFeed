import { Router } from 'express'
import { getDb } from '../db.js'

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
  const escapedName = String(name).replace(/'/g, "''")
  // 未指定颜色时按当前领域数自动取彩虹序号色
  const cntRow = await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any
  const escapedColor = String(color || rainbow(cntRow.n, Math.max(cntRow.n + 1, 12))).replace(/'/g, "''")
  const escapedDesc = description === null ? 'NULL' : `'${String(description).replace(/'/g, "''")}'`
  const parentVal = parent_id === null || parent_id === undefined ? 'NULL' : parent_id
  await db.exec(`INSERT INTO domains (name, parent_id, color, description) VALUES ('${escapedName}', ${parentVal}, '${escapedColor}', ${escapedDesc})`)
  const idRow = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
  res.json({ success: true, id: idRow.id })
})

domainsRouter.patch('/:id', async (req, res) => {
  const db = await getDb()
  const { name, parent_id, color, description, sort } = req.body as Record<string, any>
  const sets: string[] = []
  if (name !== undefined) sets.push(`name = '${String(name).replace(/'/g, "''")}'`)
  if (parent_id !== undefined) sets.push(`parent_id = ${parent_id === null || parent_id === undefined ? 'NULL' : parent_id}`)
  if (color !== undefined) sets.push(`color = '${String(color).replace(/'/g, "''")}'`)
  if (description !== undefined) sets.push(`description = ${description === null ? 'NULL' : `'${String(description).replace(/'/g, "''")}'`}`)
  if (sort !== undefined) sets.push(`sort = ${parseInt(String(sort)) || 0}`)
  if (sets.length === 0) return res.json({ success: true })
  await db.exec(`UPDATE domains SET ${sets.join(', ')} WHERE id = ${parseInt(req.params.id)}`)
  res.json({ success: true })
})

domainsRouter.delete('/:id', async (req, res) => {
  const db = await getDb()
  await db.exec(`DELETE FROM domains WHERE id = ${parseInt(req.params.id)}`)
  res.json({ success: true })
})
