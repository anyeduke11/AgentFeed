import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDb, checkpointWal } from './db.js'
import { migrateVectorsToBlob } from './llm/vectorBlobMigrate.js'
import { ensureLoaded, indexCacheStats } from './search/vectorIndex.js'
import { filesRouter } from './routes/files.js'
import { domainsRouter } from './routes/domains.js'
import { tagsRouter } from './routes/tags.js'
import { scanRouter, scanState, recordScan } from './routes/scan.js'
import { configRouter } from './routes/config.js'
import { statsRouter } from './routes/stats.js'
import { llmRouter } from './routes/llm.js'
import { startLlmFeeder, llmQueue } from './llm/index.js'
import { enforceDailyBudget } from './llm/budgetGate.js'
import { wikiRouter, backfillWikiTitles } from './routes/wiki.js'
import { gateRouter } from './routes/gate.js'
import { recommendRouter } from './routes/recommend.js'
import { readingRouter } from './routes/reading.js'
import { reportsRouter } from './routes/reports.js'
import { profileRouter } from './routes/profile.js'
import { chatRouter } from './routes/chat.js'
import { rsiRouter } from './routes/rsi.js'
import { searchRouter } from './routes/search.js'
import { webclipRouter } from './routes/webclip.js'
import { startDailyReportJob } from './reports.js'
import { startWatcher } from './watcher.js'
import { archiveSkippedRecords } from './gate.js'
import { scan, backfillRuleScores, backfillAliases, backfillAgentAttribution } from './scanner.js'
import { resolveAgentDirs, selectPeriodicRoots } from './agents.js'
import { bindAgentRoots } from './routes/scan.js'
import { ensureFtsPopulated } from './search/ftsIndex.js'

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
app.use('/api/search', searchRouter)
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
app.use('/api/reports', reportsRouter)
app.use('/api/profile', profileRouter)
app.use('/api/chat', chatRouter)
app.use('/api/rsi', rsiRouter)
app.use('/api/webclip', webclipRouter)

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
  // 存量扫描根自动绑定 agent：挂载时未写的（历史根）按 KNOWN_AGENTS 目录映射补齐
  bindAgentRoots()
    .then(n => { if (n > 0) console.log(`agent roots bound: ${n}`) })
    .catch(e => console.error('agent root bind failed', e))
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
  // 存量归因回填：frontmatter 声明（文件头赢）不动，无声明按扫描根绑定重算（分批 200 不阻塞启动）
  backfillAgentAttribution()
    .then((n) => { if (n > 0) console.log(`source_agent backfilled: ${n} files`) })
    .catch((e) => console.error('agent attribution backfill failed', e))
  // 词条标题回填：已蒸馏但标题为空的行，从 entry.md 首行提取（不阻塞启动）
  backfillWikiTitles()
    .then((n) => { if (n > 0) console.log(`wiki title backfilled: ${n} entries`) })
    .catch((e) => console.error('wiki title backfill failed', e))
  // Phase 2 检索基建：启动期幂等回填——仅 FTS（空而主表非空时自动 rebuild 一次）。
  // 分块向量不再启动期全量补嵌（本地 GPU compute-bound：54 万块串行 ~53h，不适合常驻满载）：
  // 改为设置页手动分批补嵌（POST /api/wiki/chunks/backfill/start，content_hash 幂等可断点续跑）；
  // 新蒸馏词条仍由 llmWorker 蒸馏后逐条即时索引，增量路径不欠账
  ensureFtsPopulated(await getDb())
    .then((r) => { if (r.rebuilt) console.log(`wiki fts rebuilt: ${r.entries} entries`) })
    .catch((e) => console.error('wiki fts backfill failed', e))

  // 每日推式出口：boot 补当天日报（已存在幂等跳过），此后每 5 分钟跨天检查自动生成
  startDailyReportJob()

  // G1 日预算闸：boot 即检 + 每 5 分钟巡检（蒸馏入队时另有 30s 节流即时巡检）；跨天自动复位昨日因预算暂停的队列
  const budgetCheck = () => { enforceDailyBudget(llmQueue).catch((e) => console.error('daily budget check failed', e)) }
  setTimeout(budgetCheck, 10 * 1000)
  setInterval(budgetCheck, 5 * 60 * 1000)

  // 启用根自动增量扫描：watcher 只覆盖运行期变化，启动兜底 + 周期增量补齐停机期间的文件变更。
  // 范围 = 全部启用根，仅剔除本机不存在的 agent 目录（手工挂载的普通目录同样纳入）
  // 间隔读 config:scan.rescanMinutes（默认 120 分钟，每轮重读所以改完下一轮生效）：
  // 个人电脑上 22 个根一轮实测 112s，可以慢但要稳——降低常驻磁盘/CPU 占用，把带宽留给蒸馏队列。
  const DEFAULT_RESCAN_MINUTES = 120
  let agentScanBusy = false
  const agentRescan = async (reason: string) => {
    if (agentScanBusy) return
    agentScanBusy = true
    const t0 = Date.now()
    try {
      const db = await getDb()
      const rootRows = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')).all() as any[]
      const roots = selectPeriodicRoots(rootRows.map((r: any) => r.path), resolveAgentDirs())
      if (roots.length === 0) return
      const result = await scan({ roots, full: false, source: reason })
      recordScan(result)
      const guarded = result.sweepSkipped?.length
        ? ` · 护栏跳过清理 ${result.sweepSkipped.reduce((s: number, x: any) => s + x.count, 0)} 个（${result.sweepSkipped.length} 个根）`
        : ''
      console.log(`agent rescan(${reason}): ${roots.length} root(s) · ${Date.now() - t0}ms · +${result.added} ~${result.updated} -${result.deleted} 门禁${result.gated}${guarded}`)
    } finally {
      agentScanBusy = false
    }
  }
  const rescanDelayMs = async () => {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value FROM config WHERE key = 'scan.rescanMinutes'")).get() as any
    const n = row ? Number(row.value) : NaN
    return (Number.isFinite(n) && n >= 5 ? n : DEFAULT_RESCAN_MINUTES) * 60 * 1000
  }
  // 自我续期而非固定 setInterval：间隔改了下轮即生效，单轮失败也不打断排程
  const scheduleRescan = () => {
    rescanDelayMs()
      .catch(() => DEFAULT_RESCAN_MINUTES * 60 * 1000)
      .then((ms) => setTimeout(() => {
        agentRescan('interval').catch(e => console.error('agent rescan failed', e))
        scheduleRescan()
      }, ms))
  }
  setTimeout(() => { agentRescan('boot').catch(e => console.error('agent rescan failed', e)) }, 15 * 1000)
  scheduleRescan()

  // WAL 治理：boot 截断存量 WAL（排在 15s 重扫之前），此后每 10 分钟 best-effort 截断；
  // 其他进程（如 MCP 子进程）持锁时本轮放弃（busy / null），下轮再试
  setTimeout(() => {
    checkpointWal().then(r => {
      if (r) console.log(`wal checkpoint(boot): busy=${r.busy} frames=${r.frames} -> ${r.checkpointed}`)
    }).catch(e => console.error('wal checkpoint failed', e))
  }, 3 * 1000)
  setInterval(() => {
    checkpointWal().then(r => {
      if (r && r.checkpointed > 0) console.log(`wal checkpoint(interval): frames=${r.frames} -> ${r.checkpointed}`)
    }).catch(e => console.error('wal checkpoint failed', e))
  }, 10 * 60 * 1000)

  // L1 延迟治理：存量向量 JSON TEXT → BLOB 后台迁移（幂等；10s 后启动避开 boot 高峰，
  // 分批 500 行不阻塞在线写入；迁移完成前后双读兼容，检索行为无感）
  setTimeout(() => {
    migrateVectorsToBlob().then(({ chunks, files }) => {
      if (chunks || files) console.log(`vector blob migrate: ${chunks} chunks + ${files} file vectors converted`)
    }).catch(e => console.error('vector blob migrate failed', e))
  }, 10 * 1000)

  // P2 内存向量索引预热：把 entry_chunks 向量搬进常驻缓存（~560MB，SSD 读数秒），
  // 首次检索不再付加载代价；写入路径已挂增量失效/重载钩子保持一致
  setTimeout(() => {
    getDb().then(db => ensureLoaded(db)).then(() => {
      const s = indexCacheStats()
      console.log(`vector index warm: ${s.entries} entries / ${s.chunks} chunks resident`)
    }).catch(e => console.error('vector index warm failed', e))
  }, 15 * 1000)
})
