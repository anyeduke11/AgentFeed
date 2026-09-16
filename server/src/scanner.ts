import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getDb } from './db.js'
import { getExtractor, extractMd, extractHtml } from './extractor.js'
import { loadGateConfig, isExcludedPath, checkGate, purgeExcludedFiles, archiveSkippedRecords, pathWhitelisted } from './gate.js'
import { computeRuleScore, RULE_SCORE_VERSION } from './ruleScore.js'
import { extractAliasFromFile } from './extractor.js'

export interface ScanOptions {
  roots: string[]
  full?: boolean
}

export interface ScanResult {
  scanned: number
  added: number
  updated: number
  deleted: number
  gated: number
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

/** 超过该大小的文件不做整读内容分析（门禁放行、只取头部元数据），交给下游切片解析 */
const SIZE_ANALYZE_LIMIT = 512 * 1024

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

/** 级联清理文件记录（外键表先行） */
async function deleteFileCascade(db: any, id: number) {
  await db.exec(`DELETE FROM file_tags WHERE file_id = ${id}`)
  await db.exec(`DELETE FROM file_versions WHERE file_id = ${id} OR related_file_id = ${id}`)
  await db.exec(`DELETE FROM llm_feedback WHERE file_id = ${id}`)
  await db.exec(`DELETE FROM llm_call_logs WHERE file_id = ${id}`)
  await db.exec(`DELETE FROM wiki_entries_meta WHERE file_id = ${id}`)
  await db.exec(`DELETE FROM files WHERE id = ${id}`)
}

async function getGateRecord(db: any, fp: string): Promise<any> {
  const stmt = await db.prepare('SELECT id, status FROM gate_records WHERE path = ?')
  return stmt.get(fp)
}

async function upsertGateRecord(db: any, fp: string, ext: string, size: number, md5: string, reason: string) {
  const base = path.basename(fp)
  const title = base.slice(0, -ext.length) || base
  const esc = (s: string) => String(s).replace(/'/g, "''")
  await db.exec(
    `INSERT INTO gate_records (path, name, ext, title, size, md5, gate_reason) VALUES ('${esc(fp)}', '${esc(base)}', '${esc(ext)}', '${esc(title)}', ${size}, '${esc(md5)}', '${esc(reason)}')
     ON CONFLICT(path) DO UPDATE SET name = excluded.name, ext = excluded.ext, title = excluded.title, size = excluded.size, md5 = excluded.md5, gate_reason = excluded.gate_reason, status = 'skipped', updated_at = CURRENT_TIMESTAMP`
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
 * full=true 时对 deleted 状态文件执行恢复入库；md5 未变且非全量时跳过。
 */
async function ingestFile(db: any, fp: string, stat: any, roots: string[], cfg: any, full: boolean): Promise<IngestOutcome> {
  const ext = path.extname(fp).toLowerCase()
  const existingStmt = await db.prepare('SELECT id, md5, status, size, file_mtime FROM files WHERE path = ?')
  const existing = await existingStmt.get(fp) as any

  if (existing && existing.status === 'deleted') {
    if (full) {
      await db.exec(`UPDATE files SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
      return { restored: true }
    }
    return {}
  }
  // mtime+size 缓存快路径：两者均未变时免读文件（不算 md5、不重评门禁/提取），周期增量扫描的核心缓存
  if (existing && !full && existing.size === stat.size && existing.file_mtime === stat.mtime.toISOString()) return {}
  const currentMd5 = await md5File(fp)
  if (existing && existing.md5 === currentMd5 && !full) return {}

  // 手动恢复豁免：gate_records 中 restored 的文件跳过门禁
  const gateRec = await getGateRecord(db, fp)
  const exempted = gateRec?.status === 'restored'
  let gateBuf: Buffer | undefined
  if (!exempted && stat.size <= SIZE_ANALYZE_LIMIT) {
    gateBuf = await fs.readFile(fp)
    const verdict = checkGate(fp, stat.size, gateBuf.toString('utf-8'), cfg)
    if (!verdict.pass) {
      await upsertGateRecord(db, fp, ext, stat.size, currentMd5, verdict.reason || '未通过门禁')
      if (existing) await deleteFileCascade(db, existing.id)
      return { gated: true }
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
  const meta = await (ext === '.md' ? extractMd(fp, roots) : extractHtml(fp, roots))
  const name = path.basename(fp)
  const mtime = stat.mtime.toISOString()
  const ctime = (stat as any).birthtime?.toISOString?.() || mtime
  const titleVal = meta.title === null ? 'NULL' : `'${String(meta.title).replace(/'/g, "''")}'`
  const agentVal = meta.agent === null ? 'NULL' : `'${String(meta.agent).replace(/'/g, "''")}'`
  const aliasVal = `'${String(meta.alias).replace(/'/g, "''")}'`
  const sql = `INSERT INTO files (path, name, ext, title, alias, source_agent, file_mtime, content_time, size, md5, domain_id, summary, status, llm_state, rule_score, updated_at) VALUES ('${fp.replace(/'/g, "''")}', '${name.replace(/'/g, "''")}', '${ext.replace(/'/g, "''")}', ${titleVal}, ${aliasVal}, ${agentVal}, '${mtime.replace(/'/g, "''")}', '${ctime.replace(/'/g, "''")}', ${stat.size}, '${currentMd5.replace(/'/g, "''")}', NULL, NULL, 'active', 'pending', ${ruleScoreSql}, CURRENT_TIMESTAMP) ON CONFLICT(path) DO UPDATE SET name = excluded.name, ext = excluded.ext, title = excluded.title, alias = excluded.alias, source_agent = excluded.source_agent, file_mtime = excluded.file_mtime, content_time = excluded.content_time, size = excluded.size, md5 = excluded.md5, rule_score = COALESCE(${ruleScoreSql}, rule_score), updated_at = CURRENT_TIMESTAMP`
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
  return ingestFile(db, fp, stat, roots, cfg, false)
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const db = await getDb()
  const cfg = await loadGateConfig()
  const extSet = new Set(['.html', '.md'])
  const stats: ScanResult = { scanned: 0, added: 0, updated: 0, deleted: 0, gated: 0 }

  const rootStmt = await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')
  const roots = options.roots.length > 0 ? options.roots : (await rootStmt.all()).map((r: any) => r.path)

  // Gate 1 存量清洗：匹配排除规则的已入库记录直接删除（不进回收区）
  const purged = await purgeExcludedFiles(cfg)
  if (purged > 0) stats.deleted += purged

  // 自身数据目录污染清理：历史误入库的 wiki 词条等记录级联删除
  const selfLike = (SELF_DATA_DIR + path.sep).replace(/'/g, "''")
  const selfRows = await (await db.prepare(`SELECT id FROM files WHERE path LIKE '${selfLike}%'`)).all() as any[]
  for (const r of selfRows) await deleteFileCascade(db, r.id)
  if (selfRows.length > 0) stats.deleted += selfRows.length

  // 定期归档：非当月的 skipped 过滤记录写入 CSV 存档并移出列表
  try { await archiveSkippedRecords(true) } catch { /* 归档失败不阻塞扫描 */ }

  const seenPaths = new Set<string>()

  for (const root of roots) {
    const files: string[] = []
    await walk(root, extSet, cfg.excludeDirsEnabled ? cfg.excludeDirs : [], cfg.pathWhitelistEnabled ? cfg.pathWhitelist : [], files)
    for (const fp of files) {
      seenPaths.add(fp)
      stats.scanned++
      const stat = await fs.stat(fp)
      const out = await ingestFile(db, fp, stat, roots, cfg, !!options.full)
      if (out.gated) stats.gated++
      else if (out.restored || out.updated) stats.updated++
      else if (out.added) stats.added++
    }
  }

  // 软删范围必须限定在本次扫描涉及的根之内——单根扫描/重扫不能动其他根的文件
  const rootEsc = roots.map(r => `'${r.replace(/'/g, "''")}%'`)
  const rootScope = rootEsc.length > 0 ? `(${rootEsc.join(' OR ')})` : `('' )`

  if (options.full && seenPaths.size > 0) {
    const escaped = Array.from(seenPaths).map(p => `'${p.replace(/'/g, "''")}'`).join(',')
    const sql = `UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE status = 'active' AND path NOT IN (${escaped}) AND path LIKE ${rootScope}`
    await db.exec(sql)
    const changesRow = await (await db.prepare('SELECT changes() AS c')).get() as any
    stats.deleted += changesRow.c
  } else if (!options.full) {
    const activeStmt = await db.prepare("SELECT id, path FROM files WHERE status = 'active'")
    const activeFiles = await activeStmt.all() as any[]
    const inScope = (p: string) => roots.some(r => p === r || p.startsWith(r + '/'))
    const toDelete = activeFiles.filter(f => !seenPaths.has(f.path) && inScope(f.path))
    if (toDelete.length > 0) {
      for (const f of toDelete) {
        await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ${f.id}`)
      }
      stats.deleted += toDelete.length
    }
  }

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
