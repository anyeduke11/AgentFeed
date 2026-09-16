import { Router } from 'express'
import { getDb } from '../db.js'
import { scan, ScanOptions } from '../scanner.js'
import { restartWatcherForRoots } from '../watcher.js'
import { resolveAgentDirs } from '../agents.js'

export const scanRouter = Router()

/** 全局扫描运行态（watcher 状态 + 最近一次扫描结果） */
export const scanState = {
  watcherRunning: false,
  lastScan: null as null | { at: string; scanned: number; added: number; updated: number; deleted: number },
  lastScanAt: null as string | null
}

export function recordScan(result: { scanned: number; added: number; updated: number; deleted: number }) {
  scanState.lastScan = { at: new Date().toISOString(), ...result }
}

scanRouter.get('/status', async (req, res) => {
  const db = await getDb()
  const rootsRow = await (await db.prepare('SELECT COUNT(*) as cnt FROM scan_roots WHERE enabled = 1')).get() as any
  const filesRow = await (await db.prepare("SELECT COUNT(*) as cnt FROM files WHERE status = 'active'")).get() as any
  const gatedRow = await (await db.prepare("SELECT COUNT(*) as cnt FROM gate_records WHERE status = 'skipped'")).get() as any
  res.json({
    watcherRunning: scanState.watcherRunning,
    enabledRoots: rootsRow.cnt,
    files: filesRow.cnt,
    gated: gatedRow.cnt,
    lastScan: scanState.lastScan
  })
})

/** 已注册扫描根列表（含每个根的 active 文件数） */
scanRouter.get('/roots', async (req, res) => {
  const db = await getDb()
  const rows = await (await db.prepare(`
    SELECT r.*, (
      SELECT COUNT(*) FROM files f WHERE f.status = 'active' AND (f.path LIKE r.path || '%' OR r.path = '/')
    ) as files
    FROM scan_roots r ORDER BY r.created_at DESC
  `)).all()
  res.json(rows)
})

/** 国内外常见 agent 智能体默认目录探测与挂载状态 */
scanRouter.get('/agents', async (req, res) => {
  try {
    const db = await getDb()
    const roots = await (await db.prepare('SELECT id, path, enabled FROM scan_roots')).all() as any[]
    const items = resolveAgentDirs().map(a => {
      const hit = roots.find(r => r.path === a.path)
      return { ...a, rootId: hit?.id ?? null, enabled: hit ? !!hit.enabled : false }
    })
    res.json(items)
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

scanRouter.post('/roots', async (req, res) => {
  const db = await getDb()
  const { path } = req.body as Record<string, any>
  if (!path) return res.status(400).json({ success: false, message: 'path 必填' })
  try {
    const escapedPath = String(path).replace(/'/g, "''")
    await db.exec(`INSERT INTO scan_roots (path) VALUES ('${escapedPath}')`)
    const idRow = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
    // 新根后台全量扫描 + watcher 热重载（失败不阻塞响应）
    scan({ roots: [String(path)], full: true }).then(recordScan).catch(() => {})
    restartWatcherForRoots().then(n => { scanState.watcherRunning = n > 0 }).catch(() => {})
    res.json({ success: true, id: idRow.id })
  } catch (e: any) {
    res.status(409).json({ success: false, message: '路径已存在' })
  }
})

scanRouter.patch('/roots/:id', async (req, res) => {
  const db = await getDb()
  const { enabled } = req.body as Record<string, any>
  if (enabled === undefined) return res.status(400).json({ success: false, message: 'enabled 必填' })
  await db.exec(`UPDATE scan_roots SET enabled = ${enabled ? 1 : 0} WHERE id = ${parseInt(req.params.id)}`)
  restartWatcherForRoots().then(n => { scanState.watcherRunning = n > 0 }).catch(() => {})
  res.json({ success: true })
})

scanRouter.delete('/roots/:id', async (req, res) => {
  const db = await getDb()
  await db.exec(`DELETE FROM scan_roots WHERE id = ${parseInt(req.params.id)}`)
  restartWatcherForRoots().then(n => { scanState.watcherRunning = n > 0 }).catch(() => {})
  res.json({ success: true })
})

scanRouter.post('/roots/:id/rescan', async (req, res) => {
  try {
    const db = await getDb()
    const row = await (await db.prepare('SELECT path FROM scan_roots WHERE id = ?')).get(parseInt(req.params.id)) as any
    if (!row) return res.status(404).json({ success: false, message: '扫描根不存在' })
    const result = await scan({ roots: [row.path], full: true })
    recordScan(result)
    res.json({ success: true, ...result })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

scanRouter.post('/run', async (req, res) => {
  try {
    const { roots, full } = req.body as ScanOptions & { roots?: string[] }
    const result = await scan({ roots: roots || [], full: !!full })
    recordScan(result)
    res.json({ success: true, ...result })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})
