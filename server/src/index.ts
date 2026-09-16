import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDb } from './db.js'
import { filesRouter } from './routes/files.js'
import { domainsRouter } from './routes/domains.js'
import { tagsRouter } from './routes/tags.js'
import { scanRouter, scanState, recordScan } from './routes/scan.js'
import { configRouter } from './routes/config.js'
import { statsRouter } from './routes/stats.js'
import { llmRouter } from './routes/llm.js'
import { startLlmFeeder } from './llm/index.js'
import { wikiRouter, backfillWikiTitles } from './routes/wiki.js'
import { gateRouter } from './routes/gate.js'
import { recommendRouter } from './routes/recommend.js'
import { readingRouter } from './routes/reading.js'
import { startWatcher } from './watcher.js'
import { archiveSkippedRecords } from './gate.js'
import { scan, backfillRuleScores, backfillAliases } from './scanner.js'
import { resolveAgentDirs } from './agents.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = 5188

// 全局兜底：蒸馏高并发下瞬态 SQLITE_BUSY 等未捕获 rejection 只记日志，不杀死服务（避免连带中断所有运行中任务）
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, '../public')))

app.use('/api/files', filesRouter)
app.use('/api/domains', domainsRouter)
app.use('/api/tags', tagsRouter)
app.use('/api/scan', scanRouter)
app.use('/api/config', configRouter)
app.use('/api/stats', statsRouter)
app.use('/api/llm', llmRouter)
app.use('/api/wiki', wikiRouter)
app.use('/api/gate', gateRouter)
app.use('/api/recommend', recommendRouter)
app.use('/api/reading', readingRouter)

app.get('/api/health', (req, res) => res.json({ ok: true }))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'))
})

async function startWatcherForRoots() {
  try {
    const db = await getDb()
    const rows = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')).all() as any[]
    if (rows.length === 0) return
    const roots = rows.map((r: any) => r.path)
    await startWatcher(roots, (stats) => {
      scanState.lastScan = { at: new Date().toISOString(), ...stats }
    })
    scanState.watcherRunning = true
    console.log(`watcher watching ${roots.length} root(s)`)
  } catch (e) {
    console.error('watcher start failed', e)
  }
}

app.listen(PORT, async () => {
  console.log(`knowledge dashboard listening on http://127.0.0.1:${PORT}`)
  await getDb()
  await startWatcherForRoots()
  // 启动 LLM 队列调度器：自动恢复/补充 pending 蒸馏任务
  startLlmFeeder().catch((e) => console.error('llm feeder start failed', e))
  // 启动时归档非当月的过滤记录
  archiveSkippedRecords(true).catch(() => { /* 归档失败不阻塞启动 */ })
  // M3：后台回填存量 rule_score（版本不符全量重算，否则补 NULL；分批 200 不阻塞启动）
  backfillRuleScores()
    .then((n) => { if (n > 0) console.log(`rule_score backfilled: ${n} files`) })
    .catch((e) => console.error('rule_score backfill failed', e))
  // 别名回填：有 title 的行 SQL 直copy，无 title 的行读头 8KB 提取（分批 200 不阻塞启动）
  backfillAliases()
    .then((n) => { if (n > 0) console.log(`alias backfilled: ${n} files`) })
    .catch((e) => console.error('alias backfill failed', e))
  // 词条标题回填：已蒸馏但标题为空的行，从 entry.md 首行提取（不阻塞启动）
  backfillWikiTitles()
    .then((n) => { if (n > 0) console.log(`wiki title backfilled: ${n} entries`) })
    .catch((e) => console.error('wiki title backfill failed', e))

  // Agent 根自动扫描：watcher 只覆盖运行期变化，启动兜底 + 周期增量补齐停机期间的文件变更。
  // 范围 = KNOWN_AGENTS 已解析存在且已挂载启用的扫描根（Qoder、LingxiClaw 等自动纳入）
  const AGENT_RESCAN_MS = 30 * 60 * 1000
  let agentScanBusy = false
  const agentRescan = async (reason: string) => {
    if (agentScanBusy) return
    agentScanBusy = true
    const t0 = Date.now()
    try {
      const db = await getDb()
      const dirs = resolveAgentDirs().filter(a => a.exists)
      const rootRows = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')).all() as any[]
      const enabled = new Set(rootRows.map((r: any) => r.path))
      const roots = dirs.map(a => a.path).filter(p => enabled.has(p))
      if (roots.length === 0) return
      const result = await scan({ roots, full: false })
      recordScan(result)
      console.log(`agent rescan(${reason}): ${roots.length} root(s) · ${Date.now() - t0}ms · +${result.added} ~${result.updated} -${result.deleted} 门禁${result.gated}`)
    } finally {
      agentScanBusy = false
    }
  }
  setTimeout(() => { agentRescan('boot').catch(e => console.error('agent rescan failed', e)) }, 15 * 1000)
  setInterval(() => { agentRescan('interval').catch(e => console.error('agent rescan failed', e)) }, AGENT_RESCAN_MS)
})
