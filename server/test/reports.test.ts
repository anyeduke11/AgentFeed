import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

// 隔离：日报生成要写真实表（read_history / wiki_entries_meta）且落盘，必须整体指向临时目录，
// 绝不误伤生产 server/data（真实库与真实扫描根在本文件中一次都不许触碰）。
const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-reports-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { generateDailyReport } = await import('../src/reports.js')
const { reportsRouter } = await import('../src/routes/reports.js')

// 独立 express app 挂载路由：..%2f 这类穿越是先经 express 路由层解码再进 handler 的，
// 只有端到端走真实 express 才能验证「解码后拒绝」这一行为。
const app = express()
app.use(express.json())
app.use('/api/reports', reportsRouter)
const server = http.createServer(app)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

test('幂等生成：同日两次 generate，文件只写一次（推式出口同一天多次触发不得产生重复副本，下游按日期消费才可连续度量）', async () => {
  const db = await getDb()
  // 种一条当日蒸馏产出：顺带钉死 ①统计口径（wiki_entries_meta.distilled_at 当日命中）
  await (await db.prepare(
    "INSERT INTO wiki_entries_meta (file_id, entry_path, entities_count, distilled_at, title, quality_score) VALUES (NULL, '/tmp/x/entry.md', 3, '2026-08-15 08:30:00', '蒸馏 A', 4.0)"
  )).run()
  const r1 = await fetch(`${base}/api/reports/daily/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-08-15' })
  })
  const j1 = await r1.json() as any
  assert.equal(r1.status, 200)
  assert.equal(j1.success, true)
  assert.equal(j1.generated, true)
  const mdPath = path.join(DATA_TMP, 'reports', 'daily', '2026-08-15.md')
  const htmlPath = path.join(DATA_TMP, 'reports', 'daily', '2026-08-15.html')
  const md1 = await fs.readFile(mdPath, 'utf8')
  assert.ok(md1.includes('1 篇'), '当日蒸馏统计应为 1 篇')
  assert.ok(md1.includes('4.0'), '平均质量分应进日报')
  const stat1 = await fs.stat(htmlPath)
  // 第二次：两份产物均已存在必须跳过不覆盖（幂等由文件存在性保证）
  const r2 = await fetch(`${base}/api/reports/daily/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-08-15' })
  })
  const j2 = await r2.json() as any
  assert.equal(j2.generated, false)
  assert.equal(j2.date, '2026-08-15')
  const stat2 = await fs.stat(htmlPath)
  assert.equal(stat2.mtimeMs, stat1.mtimeMs, '第二次 generate 不得重写文件')
  // body 非法 date → 400（严格 YYYY-MM-DD）
  const r3 = await fetch(`${base}/api/reports/daily/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '../../etc' })
  })
  assert.equal(r3.status, 400)
})

test('无蒸馏产出的日子也生成合法日报（日报时间序列不允许断档，空日含 0 统计才能保持推式出口连续可度量）', async () => {
  const r = await generateDailyReport(await getDb(), '2026-08-16')
  assert.equal(r.generated, true)
  const md = await fs.readFile(path.join(DATA_TMP, 'reports', 'daily', '2026-08-16.md'), 'utf8')
  assert.ok(md.includes('0 篇'), '无产出日统计必须显式为 0')
  assert.ok(md.includes('## 值得看 3 篇'))
  assert.ok(md.includes('今日暂无推荐'))
  const html = await fs.readFile(path.join(DATA_TMP, 'reports', 'daily', '2026-08-16.html'), 'utf8')
  assert.ok(html.startsWith('<!doctype html'))
  assert.ok(html.includes('2026-08-16'))
})

test('路径穿越全拒绝（日报目录在扫描根之外是平台自产物，date 参数绝不能把它变成任意文件读取口）', async () => {
  // ..%2f 编码穿越：express 解码成 ../ 后必须被严格格式校验拦下（400）
  const r1 = await fetch(`${base}/api/reports/daily/..%2f..%2fapp.db`)
  assert.equal(r1.status, 400)
  // 反斜杠穿越（%5C）同样过不了 [0-9-] 白名单
  const r2 = await fetch(`${base}/api/reports/daily/..%5C..%5Capp.db`)
  assert.equal(r2.status, 400)
  // 含字面 / 的多段 date 不匹配任何路由（404），不得带出文件内容
  const r3 = await fetch(`${base}/api/reports/daily/2026-08-15/extra`)
  assert.equal(r3.status, 404)
  // 非法格式 date（缺前导零）→ 400
  const r4 = await fetch(`${base}/api/reports/daily/2026-8-15`)
  assert.equal(r4.status, 400)
  // 被拒请求不得落 read_history 埋点：只有真实命中的日报阅读才计入 daily 渠道（埋点区分渠道的前提是不掺假）
  const db = await getDb()
  const rows = await (await db.prepare("SELECT COUNT(*) AS n FROM read_history WHERE source = 'daily'")).get() as any
  assert.equal(Number(rows.n), 0)
})

test('GET 命中后 read_history 落一行 source=daily 且 file_id 为 NULL（日报阅读按独立出口计量，不得伪装成库内文件打开）', async () => {
  await generateDailyReport(await getDb(), '2026-08-15') // 幂等：已存在则跳过，保证自足
  const r = await fetch(`${base}/api/reports/daily/2026-08-15`)
  assert.equal(r.status, 200)
  assert.ok((r.headers.get('content-type') || '').includes('text/html'))
  const body = await r.text()
  assert.ok(body.includes('2026-08-15'))
  assert.ok(body.includes('值得看 3 篇'))
  const db = await getDb()
  const row = await (await db.prepare("SELECT file_id, path, source FROM read_history WHERE source = 'daily' ORDER BY id DESC")).get() as any
  assert.ok(row, '命中必须落一行埋点')
  assert.equal(row.file_id, null, '日报非库内文件，file_id 必须为 NULL')
  assert.ok(path.isAbsolute(row.path), 'path 必须是日报绝对路径')
  assert.ok(row.path.endsWith('2026-08-15.html'))
  // 库内文件口径的阅读统计（file_id IS NOT NULL）不被日报阅读污染
  const fileOpens = await (await db.prepare('SELECT COUNT(*) AS n FROM read_history WHERE file_id IS NOT NULL')).get() as any
  assert.equal(Number(fileOpens.n), 0)
  // 合法格式但未生成的日期 → 404（缺文件不报错、不落埋点）
  const miss = await fetch(`${base}/api/reports/daily/2026-08-20`)
  assert.equal(miss.status, 404)
})
