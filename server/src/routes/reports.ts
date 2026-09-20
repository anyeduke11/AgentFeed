import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { getDb } from '../db.js'
import { generateDailyReport, dailyReportsDir } from '../reports.js'
import { localDateStr } from './recommend.js'

export const reportsRouter = Router()

// date 参数严格 YYYY-MM-DD：既是文件名白名单，也是防目录穿越的第一道闸（..、%2f、反斜杠都过不了这个形）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** GET /api/reports/daily/:date —— 返回当日日报 HTML；命中即落 read_history 埋点（source='daily'，file_id=NULL） */
reportsRouter.get('/daily/:date', async (req, res) => {
  const date = String(req.params.date || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ success: false, message: 'date 需为 YYYY-MM-DD' })
  // 防目录穿越：正则已挡住分隔符，这里仍按 withinScanRoots 的严格边界模式做归一化 + 前缀校验（双保险，裸 startsWith 会误放行兄弟目录）
  const dir = path.resolve(dailyReportsDir())
  const target = path.resolve(dir, `${date}.html`)
  if (target !== dir && !target.startsWith(dir + path.sep)) return res.status(404).end()
  const content = await fs.readFile(target, 'utf8').catch(() => null)
  if (content === null) return res.status(404).end()
  // 埋点：read_history.source 集合固定含 'daily'；file_id 置 NULL（日报非库内文件），path 落日报绝对路径供渠道区分
  const db = await getDb()
  await (await db.prepare("INSERT INTO read_history (file_id, path, source) VALUES (NULL, ?, 'daily')")).run([target])
  res.type('html').send(content)
})

/** POST /api/reports/daily/generate —— 手动/外部触发生成，body 可选 { date }（缺省今天）；幂等由文件存在性保证 */
reportsRouter.post('/daily/generate', async (req, res) => {
  try {
    const date = req.body?.date ? String(req.body.date) : localDateStr(new Date())
    if (!DATE_RE.test(date)) return res.status(400).json({ success: false, message: 'date 需为 YYYY-MM-DD' })
    const db = await getDb()
    const r = await generateDailyReport(db, date)
    res.json({ success: true, generated: r.generated, date, path: r.path })
  } catch (e: any) {
    console.error('report generate failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})
