import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { getExtractor, extractMd, extractHtml } from '../extractor.js'
import { archiveSkippedRecords, listArchives, searchArchives, archiveFilePath, loadGateConfig, validateGateConfig } from '../gate.js'

export const gateRouter = Router()

/** 门禁配置有效性识别：逐字段校验条目语法与生效状态（配置静默失败提示） */
gateRouter.get('/validate', async (req, res) => {
  try {
    const cfg = await loadGateConfig()
    res.json(validateGateConfig(cfg))
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/** 全部存档：skipped 记录按月写入 CSV 并从过滤记录移除 */
gateRouter.post('/archive', async (req, res) => {
  try {
    const out = await archiveSkippedRecords(false)
    res.json({ success: true, ...out })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/** 存档文件列表（按月） */
gateRouter.get('/archives', async (req, res) => {
  try {
    res.json(await listArchives())
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/** 检索已归档记录（关键字 + 可选月份） */
gateRouter.get('/archives/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ results: [] })
    const month = req.query.month ? String(req.query.month) : null
    if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: '非法月份' })
    const results = await searchArchives(q, month, 100)
    res.json({ results })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/** 查看月度存档 CSV */
gateRouter.get('/archives/:name', async (req, res) => {
  const name = req.params.name
  if (!/^\d{4}-\d{2}\.csv$/.test(name)) return res.status(400).json({ success: false, message: '非法文件名' })
  const fp = archiveFilePath(name)
  try {
    await fs.stat(fp)
  } catch {
    return res.status(404).json({ success: false, message: '存档不存在' })
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `inline; filename="${name}"`)
  res.sendFile(fp)
})

/** 过滤记录列表（status: skipped 默认 / restored 已豁免 / all） */
gateRouter.get('/records', async (req, res) => {
  const db = await getDb()
  const status = String(req.query.status || 'skipped')
  const scope = status === 'all' ? '' : `WHERE status = '${status === 'restored' ? 'restored' : 'skipped'}'`
  const limit = Math.min(parseInt(String(req.query.limit || '200')) || 200, 1000)
  const rows = await (await db.prepare(`SELECT * FROM gate_records ${scope} ORDER BY updated_at DESC LIMIT ${limit}`)).all()
  const cntRow = await (await db.prepare(`SELECT COUNT(*) AS c FROM gate_records ${scope}`)).get() as any
  res.json({ total: cntRow.c, items: rows })
})

/** 手动恢复：记录标记 restored + 单文件入库（豁免门禁） */
gateRouter.post('/records/:id/restore', async (req, res) => {
  try {
    const db = await getDb()
    const rec = await (await db.prepare('SELECT * FROM gate_records WHERE id = ?')).get(parseInt(req.params.id)) as any
    if (!rec) return res.status(404).json({ success: false, message: '记录不存在' })
    // 文件必须仍存在
    let stat
    try {
      stat = await fs.stat(rec.path)
    } catch {
      return res.status(409).json({ success: false, message: '文件已不存在于磁盘' })
    }
    const ext = path.extname(rec.path).toLowerCase()
    const buf = await fs.readFile(rec.path)
    const md5 = crypto.createHash('md5').update(buf).digest('hex')
    const extractor = getExtractor(ext)
    const rootsStmt = await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')
    const roots = (await rootsStmt.all()).map((r: any) => r.path)
    const meta = await (ext === '.md' ? extractMd(rec.path, roots) : extractHtml(rec.path, roots))
    const name = path.basename(rec.path)
    const mtime = stat.mtime.toISOString()
    const ctime = (stat as any).birthtime?.toISOString?.() || mtime
    const titleVal = meta.title === null ? 'NULL' : `'${String(meta.title).replace(/'/g, "''")}'`
    const agentVal = meta.agent === null ? 'NULL' : `'${String(meta.agent).replace(/'/g, "''")}'`
    const esc = (s: string) => String(s).replace(/'/g, "''")
    await db.transactionalize(async () => {
      await db.exec(`INSERT INTO files (path, name, ext, title, source_agent, file_mtime, content_time, size, md5, domain_id, summary, status, llm_state, updated_at)
        VALUES ('${esc(rec.path)}', '${esc(name)}', '${esc(ext)}', ${titleVal}, ${agentVal}, '${esc(mtime)}', '${esc(ctime)}', ${stat.size}, '${md5}', NULL, NULL, 'active', 'pending', CURRENT_TIMESTAMP)
        ON CONFLICT(path) DO UPDATE SET md5 = excluded.md5, size = excluded.size, status = 'active', llm_state = 'pending', updated_at = CURRENT_TIMESTAMP`)
      await db.exec(`UPDATE gate_records SET status = 'restored', updated_at = CURRENT_TIMESTAMP WHERE id = ${rec.id}`)
    })
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/** 删除单条过滤记录（确认不再关心） */
gateRouter.delete('/records/:id', async (req, res) => {
  const db = await getDb()
  await db.exec(`DELETE FROM gate_records WHERE id = ${parseInt(req.params.id)}`)
  res.json({ success: true })
})
