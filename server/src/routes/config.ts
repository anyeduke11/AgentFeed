import { Router } from 'express'
import { getDb } from '../db.js'
import { restartWatcherForRoots } from '../watcher.js'

export const configRouter = Router()

configRouter.get('/', async (req, res) => {
  const db = await getDb()
  const stmt = await db.prepare('SELECT * FROM config ORDER BY key')
  const rows = await stmt.all() as any[]
  const result: Record<string, any> = {}
  for (const r of rows) {
    let value = r.value
    if (r.type === 'json') value = JSON.parse(value)
    else if (r.type === 'number') value = Number(value)
    else if (r.type === 'boolean') value = value === 'true'
    result[r.key] = { value, type: r.type, description: r.description, updated_at: r.updated_at }
  }
  res.json(result)
})

configRouter.patch('/', async (req, res) => {
  const db = await getDb()
  const updates = req.body as Record<string, { value: any }>
  await db.transactionalize(async () => {
    for (const [key, item] of Object.entries(updates)) {
      const rowStmt = await db.prepare('SELECT type FROM config WHERE key = ?')
      const row = await rowStmt.get(key) as any
      if (!row) continue
      let value = item.value
      if (row.type === 'json' && typeof value === 'object') value = JSON.stringify(value)
      else if (row.type === 'boolean') value = value ? 'true' : 'false'
      const escapedValue = String(value).replace(/'/g, "''")
      await db.exec(`UPDATE config SET value = '${escapedValue}', updated_at = CURRENT_TIMESTAMP WHERE key = '${key.replace(/'/g, "''")}'`)
    }
  })
  // gate.* 变更后热重载 watcher，使 ignored 规则立即采用新配置
  if (Object.keys(updates).some(k => k.startsWith('gate.'))) {
    restartWatcherForRoots().catch(() => {})
  }
  res.json({ success: true })
})
