import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import matter from 'gray-matter'
import { getDb } from './db.js'
import { getExtractor, extractMd, extractHtml, readHead, inferAgent, RootBinding } from './extractor.js'
import { loadGateConfig, isExcludedPath, checkGate, checkGateSample, purgeExcludedFiles, archiveSkippedRecords, pathWhitelisted, normalizeRootPath } from './gate.js'
import { computeRuleScore, RULE_SCORE_VERSION } from './ruleScore.js'
import { extractAliasFromFile } from './extractor.js'

export interface ScanOptions {
  roots: string[]
  full?: boolean
  /** 台账来源：manual（挂载/手动）/ rescan（单根重扫）/ boot / interval（周期增量） */
  source?: string
  /** 越过单轮墓碑配额护栏：仅用于人确认过「这些文件真的删了」之后的清理，自动扫描永不为真 */
  force?: boolean
}

export interface ScanResult {
  scanned: number
  added: number
  updated: number
  deleted: number
  gated: number
  /** 本轮被配额护栏挡下来的软删批次（root + 数量 + 原因），供日志与看板告警 */
  sweepSkipped?: SweepSkip[]
}

export interface SweepSkip { root: string; count: number; reason: 'empty-walk' | 'over-cap' }

/**
 * 单轮扫描每个根允许的墓碑化文件数上限，超过即判定「读取现场异常」而不是「文件真被删了」。
 * 事故依据（2026-09-20）：lingxi-claw 根下若干目录是指向 WPS 安装目录的符号链接，
 * walk() 以 entry.isDirectory() 判断不进符号链接目录，一次增量扫描把 13,673 个仍在磁盘上的
 * 文件整批墓碑化，且此后每轮都看不到它们、再没有自愈通道。
 */
export const SWEEP_TOMBSTONE_CAP = 200

/** 文件归属：匹配的最深（最长）根；不匹配任何本次扫描根则不参与软删 */
function ownerRoot(roots: string[], p: string): string | null {
  let best: string | null = null
  for (const r of roots) {
    if ((p === r || p.startsWith(r + '/')) && (!best || r.length > best.length)) best = r
  }
  return best
}

/**
 * 软删计划（纯函数，便于不依赖磁盘/数据库验证配额语义）：
 * 把「active 但本轮没走到」的行的候选按所属根分组，逐根裁决——
 * 该根本轮走到 0 个文件 → empty-walk（读取通道整体异常，最危险，全部放弃）；
 * 候选数超上限 → over-cap（放弃该根，其他根照常清理，不连坐）。
 */
export function planTombstoneSweep(params: {
  roots: string[]
  walkedCountByRoot: Map<string, number>
  seenPaths: Set<string>
  activeRows: { id: number; path: string }[]
  cap?: number
}): { deleteIds: number[]; skipped: SweepSkip[] } {
  const cap = params.cap ?? SWEEP_TOMBSTONE_CAP
  const candidates = new Map<string, number[]>()
  for (const row of params.activeRows) {
    if (params.seenPaths.has(row.path)) continue
    const owner = ownerRoot(params.roots, row.path)
    if (!owner) continue
    const ids = candidates.get(owner)
    if (ids) ids.push(row.id)
    else candidates.set(owner, [row.id])
  }
  const deleteIds: number[] = []
  const skipped: SweepSkip[] = []
  for (const [root, ids] of candidates) {
    if ((params.walkedCountByRoot.get(root) ?? 0) === 0) {
      skipped.push({ root, count: ids.length, reason: 'empty-walk' })
      continue
    }
    if (ids.length > cap) {
      skipped.push({ root, count: ids.length, reason: 'over-cap' })
      continue
    }
    deleteIds.push(...ids)
  }
  return { deleteIds, skipped }
}

async function md5File(filePath: string): Promise<string> {
  const hash = crypto.createHash('md5')
  const stream = await fs.open(filePath, 'r')
  try {
    const chunkSize = 64 * 1024
    while (true) {
      const buf = Buffer.alloc(chunkSize)
      const { bytesRead } = await stream.read(buf)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await stream.close()
  }
  return hash.digest('hex')
}

/** 超过该大小的文件不做整读内容分析（门禁走抽样、只取头部元数据），交给下游切片解析 */
const SIZE_ANALYZE_LIMIT = 512 * 1024
/** 大文件抽样门禁的头部读取量 */
const GATE_SAMPLE_LIMIT = 64 * 1024

/** 应用自身数据目录（数据库 / wiki 词条 / 门禁存档）不作为扫描对象 */
const SELF_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data')

function underSelfData(p: string): boolean {
  return p === SELF_DATA_DIR || p.startsWith(SELF_DATA_DIR + path.sep)
}

async function walk(dir: string, extensions: Set<string>, excludeDirs: string[], pathWhitelist: string[], results: string[]) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (underSelfData(full)) continue
    if (entry.isDirectory()) {
      // 目录在排除名单中但白名单条目位于其下时仍放行（白名单优先于排除目录）
      if (excludeDirs.includes(entry.name) && !pathWhitelisted(full, pathWhitelist)) continue
      await walk(full, extensions, excludeDirs, pathWhitelist, results)
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      results.push(full)
    }
  }
}

async function getGateRecord(db: any, fp: string): Promise<any> {
  const stmt = await db.prepare('SELECT id, status FROM gate_records WHERE path = ?')
  return stmt.get(fp)
}

async function upsertGateRecord(db: any, fp: string, ext: string, size: number, md5: string, reason: string, ruleId?: string, metric?: number | string) {
  const base = path.basename(fp)
  const title = base.slice(0, -ext.length) || base
  const esc = (s: string) => String(s).replace(/'/g, "''")
  const ruleVal = ruleId ? `'${esc(ruleId)}'` : 'NULL'
  const metricVal = metric === undefined ? 'NULL' : `'${esc(String(metric))}'`
  await db.exec(
    `INSERT INTO gate_records (path, name, ext, title, size, md5, gate_reason, rule_id, gate_metric) VALUES ('${esc(fp)}', '${esc(base)}', '${esc(ext)}', '${esc(title)}', ${size}, '${esc(md5)}', '${esc(reason)}', ${ruleVal}, ${metricVal})
     ON CONFLICT(path) DO UPDATE SET name = excluded.name, ext = excluded.ext, title = excluded.title, size = excluded.size, md5 = excluded.md5, gate_reason = excluded.gate_reason, rule_id = excluded.rule_id, gate_metric = excluded.gate_metric, status = 'skipped', updated_at = CURRENT_TIMESTAMP`
  )
}

async function deleteGateRecord(db: any, fp: string) {
  await db.exec(`DELETE FROM gate_records WHERE path = '${fp.replace(/'/g, "''")}'`)
}

export interface IngestOutcome {
  gated?: boolean
  added?: boolean
  updated?: boolean
  restored?: boolean
}

/**
 * 单文件入库：门禁评估 + 元数据提取 + upsert（全量扫描与 watcher 增量共用）。
 * 墓碑语义：门禁拦截/清理只把 files 行置 deleted（wiki 词条/向量等知识资产保留），
 * 文件恢复后同 id 复活、零重蒸馏。full=true 且无 skipped 门禁记录时直接恢复，
 * 带 skipped 记录的墓碑走门禁重评；增量时文件 mtime+size 未变
 * 且无 skipped 门禁记录则免 md5 复活（外部卷掉线重挂自愈），有变化走正常流程翻回 active。
 */
async function ingestFile(db: any, fp: string, stat: any, roots: string[], cfg: any, full: boolean, rootBindings: RootBinding[]): Promise<IngestOutcome> {
  const ext = path.extname(fp).toLowerCase()
  const existingStmt = await db.prepare('SELECT id, md5, status, size, file_mtime FROM files WHERE path = ?')
  const existing = await existingStmt.get(fp) as any

  if (existing && existing.status === 'deleted') {
    if (full) {
      // skipped 门禁记录在案的墓碑不得短路复活：落入下方门禁重评，
      // 否则复活后 mtime+size 未变会被增量快路径永久豁免（P0-④）
      const rec = await getGateRecord(db, fp)
      if (rec?.status !== 'skipped') {
        await db.exec(`UPDATE files SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
        return { restored: true }
      }
    }
    const unchanged = existing.size === stat.size && existing.file_mtime === stat.mtime.toISOString()
    if (unchanged) {
      // 内容仍被门禁拦截（skipped 记录在案）的墓碑维持原状；其余原样回归的文件免 md5 直接复活
      const rec = await getGateRecord(db, fp)
      if (rec?.status === 'skipped') return {}
      await db.exec(`UPDATE files SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
      return { restored: true }
    }
    // 有变化 → 落到正常门禁 + upsert 流程（合格则经下方 DO UPDATE 翻回 active）
  } else if (existing && !full && existing.size === stat.size && existing.file_mtime === stat.mtime.toISOString()) {
    // mtime+size 缓存快路径：两者均未变时免读文件（不算 md5、不重评门禁/提取），周期增量扫描的核心缓存
    return {}
  }
  const currentMd5 = await md5File(fp)
  // md5 快路径只豁免 active 行：墓碑行内容未变、mtime 已变（marketplace 整目录重克隆/搬移）时必须
  // 走完入库流程翻回 active 并刷新 file_mtime，否则永久卡在 deleted 且每轮重复命中同一分支（P1-⑬）
  if (existing && existing.md5 === currentMd5 && !full && existing.status !== 'deleted') return {}

  // 手动恢复豁免：gate_records 中 restored 的文件跳过门禁
  const gateRec = await getGateRecord(db, fp)
  const exempted = gateRec?.status === 'restored'
  let gateBuf: Buffer | undefined
  // 大文件抽样 flag：>512KB 走抽样门禁时置 1（files 落库，前端口径拆分"编目条目"用）
  let gateSampled = 0
  if (!exempted) {
    if (stat.size <= SIZE_ANALYZE_LIMIT) {
      gateBuf = await fs.readFile(fp)
      const verdict = checkGate(fp, stat.size, gateBuf.toString('utf-8'), cfg)
      if (!verdict.pass) {
        await upsertGateRecord(db, fp, ext, stat.size, currentMd5, verdict.reason || '未通过门禁', verdict.ruleId, verdict.metric)
        // 墓碑而非级联硬删：wiki 词条/向量等知识资产保留，文件修复后同 id 复活（冷存储语义）
        if (existing) await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
        return { gated: true }
      }
    } else {
      // 大文件抽样门禁：>512KB 不整读，只读头 64KB 过黑名单 + 字符下限（补住大文件绕过门禁的口子）
      gateSampled = 1
      let head = ''
      try { head = await readHead(fp, GATE_SAMPLE_LIMIT) } catch { /* 读取失败按放行处理，与旧行为一致 */ }
      const verdict = checkGateSample(fp, stat.size, head, cfg)
      if (!verdict.pass) {
        await upsertGateRecord(db, fp, ext, stat.size, currentMd5, verdict.reason || '未通过门禁', verdict.ruleId, verdict.metric)
        if (existing) await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
        return { gated: true }
      }
    }
  }
  // 曾经被拦截、现在合格 → 清理过滤记录
  if (gateRec && gateRec.status === 'skipped') await deleteGateRecord(db, fp)

  // M3：rule_score 五维精算（复用门禁已读缓冲避免重复 IO；失败留 NULL 不阻塞扫描，待回填兜底）
  let ruleScoreSql = 'NULL'
  try {
    ruleScoreSql = String(await computeRuleScore(fp, ext, stat.size, gateBuf))
  } catch { /* 读取失败跳过 */ }

  const extractor = getExtractor(ext)
  const meta = await (ext === '.md' ? extractMd(fp, rootBindings) : extractHtml(fp, rootBindings))
  const name = path.basename(fp)
  const mtime = stat.mtime.toISOString()
  const ctime = (stat as any).birthtime?.toISOString?.() || mtime
  const titleVal = meta.title === null ? 'NULL' : `'${String(meta.title).replace(/'/g, "''")}'`
  const agentVal = meta.agent === null ? 'NULL' : `'${String(meta.agent).replace(/'/g, "''")}'`
  const aliasVal = `'${String(meta.alias).replace(/'/g, "''")}'`
  if (!existing) {
    // md5 重链接：同样内容曾以其他路径入库（墓碑行）→ 复用原行，知识资产随行迁移，避免重新蒸馏
    const relink = await (await db.prepare(`SELECT id FROM files WHERE md5 = '${currentMd5.replace(/'/g, "''")}' AND status = 'deleted' ORDER BY id LIMIT 1`)).get() as any
    if (relink) {
      await db.exec(`UPDATE files SET path = '${fp.replace(/'/g, "''")}', name = '${name.replace(/'/g, "''")}', ext = '${ext.replace(/'/g, "''")}', title = ${titleVal}, alias = ${aliasVal}, source_agent = ${agentVal}, file_mtime = '${mtime.replace(/'/g, "''")}', content_time = '${ctime.replace(/'/g, "''")}', size = ${stat.size}, md5 = '${currentMd5.replace(/'/g, "''")}', gate_sampled = ${gateSampled}, rule_score = COALESCE(${ruleScoreSql}, rule_score), status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ${relink.id}`)
      return { restored: true }
    }
  }
  const sql = `INSERT INTO files (path, name, ext, title, alias, source_agent, file_mtime, content_time, size, md5, domain_id, summary, status, llm_state, rule_score, gate_sampled, updated_at) VALUES ('${fp.replace(/'/g, "''")}', '${name.replace(/'/g, "''")}', '${ext.replace(/'/g, "''")}', ${titleVal}, ${aliasVal}, ${agentVal}, '${mtime.replace(/'/g, "''")}', '${ctime.replace(/'/g, "''")}', ${stat.size}, '${currentMd5.replace(/'/g, "''")}', NULL, NULL, 'active', 'pending', ${ruleScoreSql}, ${gateSampled}, CURRENT_TIMESTAMP) ON CONFLICT(path) DO UPDATE SET name = excluded.name, ext = excluded.ext, title = excluded.title, alias = excluded.alias, source_agent = excluded.source_agent, file_mtime = excluded.file_mtime, content_time = excluded.content_time, size = excluded.size, md5 = excluded.md5, gate_sampled = excluded.gate_sampled, rule_score = COALESCE(${ruleScoreSql}, rule_score), status = 'active', updated_at = CURRENT_TIMESTAMP`
  await db.exec(sql)
  return { added: !existing, updated: !!existing }
}

/** watcher 单文件事件入口：增量评估一个文件，不做全目录遍历 */
export async function scanFile(fp: string, roots: string[]): Promise<IngestOutcome | null> {
  const ext = path.extname(fp).toLowerCase()
  if (ext !== '.md' && ext !== '.html') return null
  const cfg = await loadGateConfig()
  if (isExcludedPath(fp, cfg, roots)) return null
  if (underSelfData(fp)) return null
  let stat
  try {
    stat = await fs.stat(fp)
  } catch {
    return null
  }
  const db = await getDb()
  const rootBindings = await loadRootBindings(db)
  return ingestFile(db, fp, stat, roots, cfg, false, rootBindings)
}

/** 读取扫描根 + agent 绑定（inferAgent 优先用绑定名，不再猜路径） */
async function loadRootBindings(db: any): Promise<RootBinding[]> {
  const rows = await (await db.prepare('SELECT path, agent FROM scan_roots')).all() as any[]
  return rows.map(r => ({ path: r.path, agent: r.agent ?? null }))
}

/**
 * 扫描入口 + scan_jobs 台账：包装 scanInner，成功/失败各落一行台账
 * （来源/范围/full/计数/耗时/错误），供 GET /api/scan/jobs 观测。
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now()
  const db = await getDb()
  const source = (options.source || 'manual').replace(/'/g, "''")
  const rootsJson = JSON.stringify(options.roots || []).replace(/'/g, "''")
  try {
    const stats = await scanInner(options)
    await db.exec(`INSERT INTO scan_jobs (source, roots, full, scanned, added, updated, deleted, gated, duration_ms) VALUES ('${source}', '${rootsJson}', ${options.full ? 1 : 0}, ${stats.scanned}, ${stats.added}, ${stats.updated}, ${stats.deleted}, ${stats.gated}, ${Date.now() - t0})`)
    return stats
  } catch (e: any) {
    const msg = String(e?.message || e).replace(/'/g, "''").slice(0, 500)
    try {
      await db.exec(`INSERT INTO scan_jobs (source, roots, full, duration_ms, error) VALUES ('${source}', '${rootsJson}', ${options.full ? 1 : 0}, ${Date.now() - t0}, '${msg}')`)
    } catch { /* 台账失败不掩盖原错误 */ }
    throw e
  }
}

async function scanInner(options: ScanOptions): Promise<ScanResult> {
  const db = await getDb()
  const cfg = await loadGateConfig()
  const extSet = new Set(['.html', '.md'])
  const stats: ScanResult = { scanned: 0, added: 0, updated: 0, deleted: 0, gated: 0 }

  // 存量扫描根路径归一化（幂等，仅在存在脏行时写）：尾斜杠根会让所有「path 是否位于该根之下」
  // 的判断永久失配（walk 产出的文件路径无尾斜杠），后果是该根的文件被孤儿清理误判为无主文件、
  // 且其删除/排除规则永不生效。实测生产库 /Users/duke/Documents/ 一个尾斜杠根牵动 24116 个文件。
  const dirtyRoots = await (await db.prepare("SELECT id, path FROM scan_roots WHERE length(path) > 1 AND path LIKE '%/'")).all() as any[]
  for (const r of dirtyRoots) {
    await db.exec(`UPDATE scan_roots SET path = '${normalizeRootPath(r.path).replace(/'/g, "''")}' WHERE id = ${r.id}`)
  }

  const rootStmt = await db.prepare('SELECT path, agent FROM scan_roots WHERE enabled = 1')
  const rootRows = await rootStmt.all() as any[]
  const roots = options.roots.length > 0 ? options.roots : rootRows.map((r: any) => r.path)
  const rootBindings: RootBinding[] = rootRows.map((r: any) => ({ path: r.path, agent: r.agent ?? null }))

  // Gate 1 存量清洗：匹配排除规则的已入库记录直接删除（不进回收区）
  const purged = await purgeExcludedFiles(cfg)
  if (purged > 0) stats.deleted += purged

  // 自身数据目录污染清理：历史误入库的 wiki 词条等记录墓碑化（仅处理 active，避免每轮重复写）
  const selfLike = (SELF_DATA_DIR + path.sep).replace(/'/g, "''")
  const selfRows = await (await db.prepare(`SELECT id FROM files WHERE path LIKE '${selfLike}%' AND status = 'active'`)).all() as any[]
  for (const r of selfRows) await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ${r.id}`)
  if (selfRows.length > 0) stats.deleted += selfRows.length

  // 定期归档：非当月的 skipped 过滤记录写入 CSV 存档并移出列表
  try { await archiveSkippedRecords(true) } catch { /* 归档失败不阻塞扫描 */ }

  const seenPaths = new Set<string>()

  const walkedCountByRoot = new Map<string, number>()

  for (const root of roots) {
    const files: string[] = []
    await walk(root, extSet, cfg.excludeDirsEnabled ? cfg.excludeDirs : [], cfg.pathWhitelistEnabled ? cfg.pathWhitelist : [], files)
    walkedCountByRoot.set(root, files.length)
    for (let i = 0; i < files.length; i += 32) {
      // 分批事务（32 文件/批）：合并 fsync 使 WAL 写放大降一个量级；批间留出 checkpoint 与蒸馏写者的窗口。
      // 事务内含每文件的读取/md5 IO，批次刻意偏小以约束事务时长（busy_timeout 5s 之内）
      const chunk = files.slice(i, i + 32)
      await db.transactionalize(async () => {
        for (const fp of chunk) {
          seenPaths.add(fp)
          stats.scanned++
          const stat = await fs.stat(fp)
          const out = await ingestFile(db, fp, stat, roots, cfg, !!options.full, rootBindings)
          if (out.gated) stats.gated++
          else if (out.restored || out.updated) stats.updated++
          else if (out.added) stats.added++
        }
      })
    }
  }

  // 软删候选统一在 JS 侧按「最深的所属根」归组后再定额放行：
  // 1) 旧实现在 SQL 里拼 seen 集合（path NOT IN (96K 个字面量)）会顶到 SQLite 语句长度上限；
  // 2) 更关键的是配额——一轮自动扫描不得整批清空一个根（见 planTombstoneSweep 的事故依据）。
  const activeRows = await (await db.prepare("SELECT id, path FROM files WHERE status = 'active'")).all() as any[]
  const force = !!options.force
  const sweep = planTombstoneSweep({
    roots,
    walkedCountByRoot,
    seenPaths,
    activeRows,
    cap: force ? Infinity : SWEEP_TOMBSTONE_CAP
  })
  for (const s of sweep.skipped) {
    console.warn(`[scan] 跳过清理：根「${s.root}」本轮有 ${s.count} 个 active 文件未走到（${s.reason === 'empty-walk' ? '该根本轮走到 0 个文件，疑似卷未挂载/权限变化/符号链接子树' : `超过单轮上限 ${SWEEP_TOMBSTONE_CAP}`}），维持现状不墓碑化；确认确已删除请用 force 扫描`)
  }
  if (sweep.skipped.length > 0) stats.sweepSkipped = sweep.skipped
  for (let i = 0; i < sweep.deleteIds.length; i += 100) {
    const chunk = sweep.deleteIds.slice(i, i + 100)
    await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id IN (${chunk.join(',')})`)
  }
  stats.deleted += sweep.deleteIds.length

  // 卸载扫描根的孤儿清理（全量/增量都跑）：没有任何 scan_roots 行覆盖的 active 文件墓碑化。
  // 禁用根仍有行、保持冷存储语义；被删除的根则让文件从此无任何清理通道，会继续出现在看板与 MCP 检索里。
  await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active' AND NOT EXISTS (
      SELECT 1 FROM scan_roots r WHERE files.path = rtrim(r.path, '/') OR files.path LIKE rtrim(r.path, '/') || '/%'
    )`)
  const orphanRow = await (await db.prepare('SELECT changes() AS c')).get() as any
  stats.deleted += orphanRow.c

  return stats
}

const RULE_SCORE_BATCH = 200

/**
 * M3 存量 rule_score 回填（PRD 7.1 计算时机 2）：启动后台分批执行，纯 CPU 零 token。
 * 版本键 ruleScore.version 低于当前刻度版本时全量重算（M1 旧刻度 1~5 与新刻度 0~10 不混存），追平后写版本号；
 * 版本一致时仅兜底补 NULL 行。keyset 分页保证失败行（读取异常留 NULL）不会造成死循环。
 */
export async function backfillRuleScores(): Promise<number> {
  const db = await getDb()
  const vRow = await (await db.prepare("SELECT value FROM config WHERE key = 'ruleScore.version'")).get() as any
  const needRescore = Number(vRow?.value) !== RULE_SCORE_VERSION
  const cond = needRescore ? "status = 'active'" : "rule_score IS NULL AND status = 'active'"
  let lastId = 0
  let filled = 0
  for (;;) {
    const rows = await (await db.prepare(
      `SELECT id, path, ext, size FROM files WHERE ${cond} AND id > ${lastId} ORDER BY id LIMIT ${RULE_SCORE_BATCH}`
    )).all() as any[]
    if (!rows.length) break
    for (const r of rows) {
      try {
        const score = await computeRuleScore(r.path, r.ext, r.size)
        await db.exec(`UPDATE files SET rule_score = ${score} WHERE id = ${r.id}`)
        filled++
      } catch { /* 读取失败（已删除/外部卷未挂载）留 NULL，不阻塞 */ }
    }
    lastId = rows[rows.length - 1].id
    if (rows.length < RULE_SCORE_BATCH) break
  }
  if (needRescore) {
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('ruleScore.version', '${RULE_SCORE_VERSION}', 'number', 'rule_score 刻度版本（v2 = 五维 0~10）')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  }
  return filled
}

const ALIAS_BATCH = 200

/**
 * 存量 alias 回填：两段式——有 title 的行一条 SQL 直接复制（别名 = title 语义，零 IO）；
 * 无 title 的行 keyset 分批读头部 8KB 提取（失败留 NULL，展示层 COALESCE 兜底文件名）。
 */
export async function backfillAliases(): Promise<number> {
  const db = await getDb()
  await db.exec("UPDATE files SET alias = title WHERE alias IS NULL AND title IS NOT NULL AND status = 'active'")
  let filled = 0
  let lastId = 0
  for (;;) {
    const rows = await (await db.prepare(
      `SELECT id, path, ext, name FROM files WHERE alias IS NULL AND status = 'active' AND id > ${lastId} ORDER BY id LIMIT ${ALIAS_BATCH}`
    )).all() as any[]
    if (!rows.length) break
    for (const r of rows) {
      try {
        const alias = await extractAliasFromFile(r.path, r.ext, r.name)
        await db.exec(`UPDATE files SET alias = '${String(alias).replace(/'/g, "''")}' WHERE id = ${r.id}`)
        filled++
      } catch { /* 读取失败（已删除/外部卷未挂载）留 NULL，不阻塞 */ }
    }
    lastId = rows[rows.length - 1].id
    if (rows.length < ALIAS_BATCH) break
  }
  return filled
}

const ATTRIBUTION_BATCH = 200
/** 归因逻辑版本：v2 = frontmatter 声明优先（文件头赢）+ 无声明按扫描根绑定重算 */
const AGENT_ATTRIBUTION_VERSION = 2

/**
 * 存量 source_agent 归因回填：信任序与 ingest 一致（inferAgent）。
 * md 读头 2KB 判 frontmatter 是否自我声明 agent——有则不动（文件头赢，归因错误不许覆盖自我声明）；
 * 无声明（含 html 本就无 frontmatter）才按扫描根绑定重算（绑定 > 根后首段目录名兜底）。
 * 版本键 agentAttribution.version 低于当前版本全量重算，追平后仅兜底 NULL 行；keyset 分批防死循环。
 */
export async function backfillAgentAttribution(): Promise<number> {
  const db = await getDb()
  const bindings = await loadRootBindings(db)
  const vRow = await (await db.prepare("SELECT value FROM config WHERE key = 'agentAttribution.version'")).get() as any
  const needFull = Number(vRow?.value) !== AGENT_ATTRIBUTION_VERSION
  const cond = needFull
    ? "status = 'active' AND ext IN ('.md', '.html', '.htm')"
    : "status = 'active' AND ext IN ('.md', '.html', '.htm') AND source_agent IS NULL"
  let lastId = 0
  let filled = 0
  for (;;) {
    const rows = await (await db.prepare(
      `SELECT id, path, ext, source_agent FROM files WHERE ${cond} AND id > ${lastId} ORDER BY id LIMIT ${ATTRIBUTION_BATCH}`
    )).all() as any[]
    if (!rows.length) break
    for (const r of rows) {
      try {
        // 文件头赢：md 带 agent 声明的行保持不动
        if (r.ext === '.md') {
          const head = await readHead(r.path, 2048)
          if (matter(head).data?.agent) continue
        }
        const agent = inferAgent(r.path, bindings)
        if (agent === r.source_agent) continue
        const val = agent ? `'${String(agent).replace(/'/g, "''")}'` : 'NULL'
        await db.exec(`UPDATE files SET source_agent = ${val} WHERE id = ${r.id}`)
        filled++
      } catch { /* 读取失败（已删除/外部卷未挂载）留原值，不阻塞 */ }
    }
    lastId = rows[rows.length - 1].id
    if (rows.length < ATTRIBUTION_BATCH) break
  }
  if (needFull) {
    await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('agentAttribution.version', '${AGENT_ATTRIBUTION_VERSION}', 'number', 'source_agent 归因逻辑版本（v2 = frontmatter 优先 + 绑定重算）')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
  }
  return filled
}
