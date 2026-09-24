import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { getDb } from '../db.js'
import { withinScanRoots } from './files.js'
import { exportWiki, verifyWikiExport, WIKI_EXPORTS_DIR } from '../exportWiki.js'
import { syncWikiFts } from '../search/ftsIndex.js'
import { pruneOrphanFts } from '../search/ftsIndex.js'
import { indexWikiChunks } from '../search/chunkEmbed.js'
import { invalidateEntry } from '../search/vectorIndex.js'
import { getEmbeddingConfig } from '../llm/embeddings.js'

export const wikiRouter = Router()

const WIKI_DIR = path.join(process.cwd(), 'data', 'wiki', 'entries')

// ---------------- 外部 llm-wiki 挂接：解析 / 预览 / 执行 ----------------

interface ExtEntry {
  file: string          // 绝对路径
  topic: string         // 所在子目录（主题域）
  title: string         // 首个 # 标题
  summary: string       // 首段正文（≤200 字）
  source: string        // **来源** 行（相对 KB 的源文件路径）
  sourceBase: string    // 来源文件名
  confidence: string    // **置信度**
  tags: string[]        // **标签** 中的 #标签
  updated: string       // 尾行 最后更新
  chars: number         // 正文字符数
  match: 'matched' | 'standalone' | 'already'
  matchedFileId?: number
  matchedTitle?: string
}

/** 非词条目录：脚本/原始材料/生成物等（目录级排除，文件不排除） */
const SKIP_DIRS = new Set(['.git', '.kb', 'node_modules', 'raw', 'outputs', 'scripts', 'views', 'news-subscription'])

/** 解析单个外部词条 md 的行内元数据（**来源**: / **置信度**: / **标签**: `#x`） */
function parseExtEntry(fp: string, raw: string): ExtEntry {
  const lines = raw.split(/\r?\n/)
  const title = (lines.find(l => l.startsWith('# ')) || '').replace(/^#\s*/, '').trim()
  const kv = (key: string) => {
    const line = lines.find(l => l.replace(/\*/g, '').trimStart().startsWith(key))
    return line ? line.split(':', 2)[1]?.trim() ?? '' : ''
  }
  const source = kv('来源')
  const confidence = kv('置信度')
  const tagLine = kv('标签') || ''
  const tags = Array.from(tagLine.matchAll(/#([^\s`#]+)/g)).map(m => m[1])
  const upLine = lines.filter(l => l.trim()).pop() || ''
  const updated = (upLine.match(/最后更新[：:]\s*([0-9-]+)/) || [])[1] || ''
  // 摘要：标题后第一段正文（跳过元数据行/分隔线/小节标题/表格/列表条目）
  const body: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (t.startsWith('# ')) continue
    if (!body.length) {
      if (!t || t === '---' || t.startsWith('#') || t.startsWith('**') || t.startsWith('|') || t.startsWith('>') || /^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) continue
    }
    if (t === '---' || t.startsWith('#')) break
    body.push(t)
    if (body.join('').length >= 200) break
  }
  // 降级：严格首段为空（如纯列表型词条）时宽松收集首个非标题/分隔线内容
  if (!body.length) {
    for (const l of lines) {
      const t = l.trim()
      if (!t || t === '---' || t.startsWith('#') || t.startsWith('|') || /^\|[-\s|]+\|$/.test(t)) continue
      body.push(t.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''))
      if (body.join('').length >= 200) break
    }
  }
  let summary = body.join(' ').slice(0, 200)
  if (body.join('').length > 200) summary += '…'
  return {
    file: fp, topic: path.basename(path.dirname(fp)),
    title, summary, source, sourceBase: source ? path.basename(source) : '',
    confidence, tags, updated, chars: raw.length, match: 'standalone'
  }
}

/** 收集 + 解析外部 wiki 目录下全部词条 */
async function collectExtEntries(dir: string): Promise<ExtEntry[]> {
  const files: string[] = []
  const walkMd = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walkMd(full) }
      else if (e.name.toLowerCase().endsWith('.md')) files.push(full)
    }
  }
  await walkMd(dir)
  const entries: ExtEntry[] = []
  for (const fp of files) {
    const raw = await fs.readFile(fp, 'utf8').catch(() => '')
    if (!raw) continue
    entries.push(parseExtEntry(fp, raw))
  }
  return entries
}

/** 与库内文件比对：① 来源文件名 → files.name ② 去扩展名 ③ 路径后缀 / 标题 */
async function matchExtEntries(entries: ExtEntry[]): Promise<void> {
  const db = await getDb()
  const fileRows = await (await db.prepare("SELECT id, name, path, title FROM files WHERE status = 'active'")).all() as any[]
  const byName = new Map(fileRows.map((r: any) => [r.name, r]))
  const existing = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta')).all() as any[]
  const existingSet = new Set((existing as any[]).map(r => String(r.entry_path)))
  for (const e of entries) {
    const stem = e.sourceBase ? e.sourceBase.replace(/\.[^.]+$/, '') : ''
    const hit = (e.sourceBase && byName.get(e.sourceBase))
      || (stem && byName.get(stem + '.md'))
      || fileRows.find((r: any) => (e.sourceBase && r.path.endsWith('/' + e.sourceBase)) || (e.title && (r.title === e.title || r.name === e.title + '.md')))
    const selfImported = existingSet.has(e.file)
    e.match = selfImported ? 'already' : hit ? 'matched' : 'standalone'
    if (hit) { e.matchedFileId = hit.id; e.matchedTitle = hit.title || hit.name }
  }
}

function extStats(entries: ExtEntry[]) {
  return {
    total: entries.length,
    matched: entries.filter(e => e.match === 'matched').length,
    standalone: entries.filter(e => e.match === 'standalone').length,
    already: entries.filter(e => e.match === 'already').length,
    byTopic: Object.entries(entries.reduce((m, e) => { m[e.topic] = (m[e.topic] || 0) + 1; return m }, {} as Record<string, number>))
      .map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count)
  }
}

wikiRouter.post('/import/preview', async (req, res) => {
  try {
    const dir = String(req.body?.dir || '').trim()
    if (!dir) return res.json({ ok: false, message: '缺少目录路径' })
    // 与 open/reveal/asset 同一红线：读磁盘目标必须落在已启用扫描根内
    const db = await getDb()
    if (!(await withinScanRoots(db, path.resolve(dir)))) {
      return res.json({ ok: false, message: '目录不在已启用扫描根内，仅支持从扫描根目录导入' })
    }
    const st = await fs.stat(dir).catch(() => null)
    if (!st || !st.isDirectory()) return res.json({ ok: false, message: `目录不存在或不可读：${dir}` })
    const entries = await collectExtEntries(dir)
    await matchExtEntries(entries)
    res.json({ ok: true, dir, stats: extStats(entries), entries })
  } catch (e: any) {
    res.json({ ok: false, message: String(e?.message || e) })
  }
})

/** 执行挂载：独立词条写 meta（file_id NULL，路径挂载不移动文件）；可挂接词条关联源文件并出队 */
wikiRouter.post('/import', async (req, res) => {
  try {
    const dir = String(req.body?.dir || '').trim()
    if (!dir) return res.status(400).json({ success: false, message: '缺少目录路径' })
    // 与 open/reveal/asset 同一红线：读磁盘目标必须落在已启用扫描根内
    const db = await getDb()
    if (!(await withinScanRoots(db, path.resolve(dir)))) {
      return res.status(400).json({ success: false, message: '目录不在已启用扫描根内，仅支持从扫描根目录导入' })
    }
    const st = await fs.stat(dir).catch(() => null)
    if (!st || !st.isDirectory()) return res.status(400).json({ success: false, message: `目录不存在或不可读：${dir}` })
    const entries = await collectExtEntries(dir)
    await matchExtEntries(entries)
    let imported = 0, linked = 0
    for (const e of entries) {
      if (e.match === 'already') continue
      await mountExtEntry(db, e)
      imported++
      if (e.match === 'matched' && e.matchedFileId) linked++
    }
    res.json({ success: true, imported, linked, skipped: entries.filter(e => e.match === 'already').length, stats: extStats(entries) })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})

/**
 * 单词条挂载内核（/import 与 chat 会话蒸馏入库 importMarkdownFile 共用，防两份逻辑漂移）：
 * 幂等刷新——同路径 imported 行先删后插，删 meta 换 entry_id 时 entry_chunks 同步清（防孤儿块）；
 * 写入后同步 FTS 关键词索引；matched 源文件标记 imported 从蒸馏队列剔除。
 */
async function mountExtEntry(db: Awaited<ReturnType<typeof getDb>>, e: ExtEntry): Promise<void> {
  const old = await (await db.prepare(`SELECT id FROM wiki_entries_meta WHERE entry_path = ? AND file_id IS NULL`)).get([e.file]) as any
  if (old) {
    await (await db.prepare(`DELETE FROM entry_chunks WHERE entry_id = ?`)).run([old.id])
    invalidateEntry(Number(old.id))
  }
  await (await db.prepare(`DELETE FROM wiki_entries_meta WHERE entry_path = ? AND file_id IS NULL`)).run([e.file])
  const distilledAt = /^\d{4}-\d{2}-\d{2}$/.test(e.updated) ? `${e.updated} 00:00:00` : new Date().toISOString()
  await (await db.prepare(
    `INSERT INTO wiki_entries_meta (file_id, entry_path, entities_count, distilled_at, source_type, title, summary, tags, confidence)
     VALUES (?, ?, 0, ?, 'imported', ?, ?, ?, ?)`
  )).run([e.matchedFileId ?? null, e.file, distilledAt, e.title || path.basename(e.file, '.md'), e.summary, JSON.stringify(e.tags), e.confidence || null])
  // 导入写入后同步 FTS 关键词索引（刚插的行按 entry_path 取回 id；分块向量由设置页手动补嵌覆盖）
  const metaRow = await (await db.prepare('SELECT id FROM wiki_entries_meta WHERE entry_path = ?')).get([e.file]) as any
  if (metaRow) await syncWikiFts(db, Number(metaRow.id))
  if (e.match === 'matched' && e.matchedFileId) {
    await (await db.prepare(`UPDATE files SET llm_state = 'imported' WHERE id = ?`)).run(e.matchedFileId)
  }
}

/**
 * 会话蒸馏入库（批次 B）：单 md 文件挂载——解析 → 与库内文件比对 → 复用 mountExtEntry 同一内核。
 * 返回 match（standalone/matched/already）与 wiki_entries_meta.id；已挂载过（already）不重复建行。
 */
export async function importMarkdownFile(
  db: Awaited<ReturnType<typeof getDb>>, fp: string
): Promise<{ ok: boolean, match: string, entryId: number | null }> {
  const raw = await fs.readFile(fp, 'utf8').catch(() => '')
  if (!raw.trim()) return { ok: false, match: 'unreadable', entryId: null }
  const entries = [parseExtEntry(fp, raw)]
  await matchExtEntries(entries)
  const e = entries[0]
  if (e.match === 'already') return { ok: true, match: 'already', entryId: null }
  await mountExtEntry(db, e)
  const row = await (await db.prepare('SELECT id FROM wiki_entries_meta WHERE entry_path = ?')).get([e.file]) as any
  return { ok: true, match: e.match, entryId: row ? Number(row.id) : null }
}

/* ---------------- 分块向量手动补嵌（parent-child 检索路） ----------------
 * 启动期全量补嵌已移除（本地 GPU compute-bound：54 万块串行 ~53h，不适合常驻满载）。
 * 改为前端手动分批触发：每批快照 pending 词条（默认 50，上限 500），后台逐条走
 * indexWikiChunks（chunk content_hash 幂等，可断点续跑）；配置类降级（开关关闭/未配置/
 * provider 缺失）整批中止且不计词条失败——修复配置后重跑同批即可。
 * 新蒸馏词条仍由 llmWorker 蒸馏后逐条即时索引，增量路径不欠账。
 */
export const chunkBackfillState = {
  running: false,
  stopRequested: false,
  lastRun: null as null | { at: string; batch: number; indexed: number; failed: number; stopped: boolean; reason: string }
}

wikiRouter.get('/chunks/backfill/status', async (req, res) => {
  try {
    const db = await getDb()
    const pendRow = await (await db.prepare('SELECT COUNT(*) AS cnt FROM wiki_entries_meta m WHERE NOT EXISTS (SELECT 1 FROM entry_chunks c WHERE c.entry_id = m.id)')).get() as any
    const chunkRow = await (await db.prepare('SELECT COUNT(*) AS cnt FROM entry_chunks')).get() as any
    res.json({ success: true, running: chunkBackfillState.running, pending: pendRow.cnt, chunks: chunkRow.cnt, lastRun: chunkBackfillState.lastRun })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})

wikiRouter.post('/chunks/backfill/start', async (req, res) => {
  try {
    if (chunkBackfillState.running) return res.json({ success: false, message: '补嵌批次进行中，请等待完成或先停止' })
    const db = await getDb()
    const cfg = await getEmbeddingConfig()
    if (!cfg.enabled || !cfg.model) return res.json({ success: false, message: '请先开启蒸馏向量化并选择向量模型' })
    const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 500)
    // 死链过滤：entry.md 已不存在的词条（如外部项目导入后源目录被删）在快照层跳过——
    // 否则死链不消费 pending、常驻候选窗口头部，每批名额被无文件词条空耗（实测死链区深达数千条，
    // 小窗口翻页无法越过）。全池扫描 + fs 过滤：手动触发场景毫秒级，且死链总数可精确上报
    const candidates = await (await db.prepare(
      'SELECT m.id, m.entry_path FROM wiki_entries_meta m WHERE NOT EXISTS (SELECT 1 FROM entry_chunks c WHERE c.entry_id = m.id) ORDER BY m.id'
    )).all() as any[]
    const alivePool = candidates.filter(r => existsSync(String(r.entry_path)))
    const deadSkipped = candidates.length - alivePool.length
    if (!alivePool.length) {
      const message = candidates.length
        ? `全部 ${candidates.length} 个待嵌词条的源文件均已缺失（死链），无活词条可补`
        : '无待嵌词条'
      return res.json({ success: true, started: false, message })
    }
    const batch = alivePool.slice(0, limit)
    chunkBackfillState.running = true
    chunkBackfillState.stopRequested = false
    void (async () => {
      let indexed = 0
      let failed = 0
      let reason = 'ok'
      for (const row of batch) {
        if (chunkBackfillState.stopRequested) break
        try {
          const r = await indexWikiChunks(db, Number(row.id))
          if (r.indexed > 0) indexed++
          else if (r.reason !== 'ok') { reason = r.reason; break }
          else failed++
        } catch { failed++ }
      }
      chunkBackfillState.lastRun = { at: new Date().toISOString(), batch: batch.length, indexed, failed, stopped: chunkBackfillState.stopRequested || reason !== 'ok', reason }
      chunkBackfillState.running = false
    })().catch((e) => { console.error('chunk backfill batch crashed', e); chunkBackfillState.running = false })
    res.json({ success: true, started: true, batch: batch.length, deadSkipped })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})

wikiRouter.post('/chunks/backfill/stop', async (req, res) => {
  chunkBackfillState.stopRequested = true
  res.json({ success: true, running: chunkBackfillState.running })
})

/* ---------------- B1 可复现导出 + 内容指纹（v0.1.5） ----------------
 * server 无 zip 依赖（红线：不加 npm 依赖）→ PRD 授权降级方案：DATA_DIR/exports/wiki-<ts>/ 目录落盘
 * （manifest.json + entries/<id>.md 副本），同 reports.ts 日报的「平台自产推式出口」豁免模式——
 * DATA_DIR 默认不在启用扫描根内（扫描根是用户内容目录），导出是推式出口而非采集对象。
 */

/** GET /api/wiki/export —— 冻结当前 wiki 语料为可校验导出（同语料重复导出幂等复用最近目录） */
wikiRouter.get('/export', async (_req, res) => {
  try {
    const r = await exportWiki()
    res.json({ success: true, dir: r.dir, reused: r.reused, manifest: r.manifest })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})

/** POST /api/wiki/fts/prune —— FTS 孤儿索引清理（entry_id 已不在主表的残留行，纯 DB 操作秒级） */
wikiRouter.post('/fts/prune', async (_req, res) => {
  try {
    const pruned = await pruneOrphanFts(await getDb())
    res.json({ success: true, pruned })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})

// dir 白名单：仅接受 exports/wiki-<ts> 单段相对路径——..、\、绝对路径都过不了这个形（同 reports.ts DATE_RE 闸）
const EXPORT_DIR_RE = /^exports\/wiki-[^/\\]+$/

/** POST /api/wiki/export/verify —— body { dir }：重算该导出目录全部 entries SHA-256 对照 manifest */
wikiRouter.post('/export/verify', async (req, res) => {
  try {
    const rel = String(req.body?.dir || '').trim()
    if (!EXPORT_DIR_RE.test(rel)) return res.status(400).json({ success: false, message: 'dir 仅接受 exports/wiki-<timestamp> 相对路径' })
    // 防穿越双保险：归一化后必须仍落在 DATA_DIR/exports 内（裸 startsWith 会误放行兄弟目录，同 reports.ts）
    const exportsRoot = path.resolve(WIKI_EXPORTS_DIR)
    const target = path.resolve(exportsRoot, rel.slice('exports/'.length))
    if (!target.startsWith(exportsRoot + path.sep)) return res.status(400).json({ success: false, message: 'dir 解析后越出导出目录' })
    const manifestRaw = await fs.readFile(path.join(target, 'manifest.json'), 'utf8').catch(() => null)
    if (manifestRaw === null) return res.status(404).json({ success: false, message: '导出目录不存在或缺少 manifest.json' })
    const r = await verifyWikiExport(target)
    res.json({ success: true, dir: rel, ...r })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e?.message || e) })
  }
})

/** 词条列表（含文件与领域信息；合并外部挂载的独立词条） */
wikiRouter.get('/', async (req, res) => {
  try {
    const db = await getDb()
    const { kw, domain, page = '1', limit = '50' } = req.query as Record<string, string>
    let where = `WHERE f.status = 'active' AND wem.file_id IS NOT NULL`
    const params: any[] = []
    if (kw) {
      where += ' AND (f.title LIKE ? OR f.summary LIKE ? OR wem.title LIKE ?)'
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`)
    }
    if (domain) {
      where += ' AND d.name = ?'
      params.push(domain)
    }
    const totalRow = await (await db.prepare(`SELECT COUNT(*) as cnt FROM wiki_entries_meta wem JOIN files f ON wem.file_id = f.id LEFT JOIN domains d ON f.domain_id = d.id ${where}`)).get(params) as any
    const sql = `
      SELECT wem.id as meta_id, wem.file_id as id, wem.entry_path, wem.entities_count, wem.distilled_at, wem.quality_score as conf,
             'llm' as source_type,
             COALESCE(NULLIF(wem.title, ''), NULLIF(f.title, ''), NULLIF(f.alias, ''), f.name) AS title,
             f.source_agent as agent, f.ext, f.file_mtime, d.name as domain, d.color as domain_color, f.summary
      FROM wiki_entries_meta wem
      JOIN files f ON wem.file_id = f.id
      LEFT JOIN domains d ON f.domain_id = d.id
      ${where}
    `
    const rows = await (await db.prepare(sql)).all(params) as any[]
    // 外部独立词条（file_id NULL：路径挂载，不关联库内文件）
    let impWhere = `WHERE wem.file_id IS NULL`
    const impParams: any[] = []
    if (kw) {
      impWhere += ' AND (wem.title LIKE ? OR wem.summary LIKE ?)'
      impParams.push(`%${kw}%`, `%${kw}%`)
    }
    if (domain) impWhere += ' AND 0' // 独立词条无领域归属，不参与领域过滤
    const impRows = await (await db.prepare(`
      SELECT wem.id as meta_id, wem.entry_path, wem.distilled_at, wem.title, wem.summary, wem.tags, wem.confidence as conf,
             'imported' as source_type
      FROM wiki_entries_meta wem ${impWhere}
    `)).all(impParams) as any[]
    for (const r of impRows) {
      r.id = `m${r.meta_id}`
      r.agent = '外部挂载'; r.ext = '.md'; r.domain = '外部 Wiki'; r.domain_color = '#7A5AA8'
      r.tags = r.tags ? JSON.parse(r.tags) : []
    }
    // 合并排序（蒸馏时间倒序）+ 内存分页
    const merged = [...rows, ...impRows].sort((a, b) => String(b.distilled_at || '').localeCompare(String(a.distilled_at || '')))
    const total = merged.length
    const start = (parseInt(page) - 1) * parseInt(limit)
    const items = merged.slice(start, start + parseInt(limit))
    // 补充编号（No.XXX / 外部 M.XX）与标签
    const tagStmt = await db.prepare('SELECT t.name FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id = ?')
    for (const r of items) {
      if (r.source_type === 'imported') { r.no = 'M' + String(r.meta_id).padStart(3, '0'); continue }
      r.no = String(r.id).padStart(3, '0')
      r.tags = (await tagStmt.all(r.id) as any[]).map(t => t.name)
    }
    res.json({ items, total, page: parseInt(page), limit: parseInt(limit) })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 存量回填：已蒸馏词条标题为空的行，从 entry.md 首行 `# 标题` 提取（启动后台执行，不阻塞） */
export async function backfillWikiTitles(): Promise<number> {
  const db = await getDb()
  const rows = await (await db.prepare(`SELECT id, entry_path FROM wiki_entries_meta WHERE file_id IS NOT NULL AND (title IS NULL OR title = '')`)).all() as any[]
  let n = 0
  for (const r of rows) {
    const raw = await fs.readFile(r.entry_path, 'utf8').catch(() => '')
    const m = raw.match(/^#\s+(.+?)\s*$/m)
    if (!m) continue
    await (await db.prepare('UPDATE wiki_entries_meta SET title = ? WHERE id = ?')).run([m[1].trim(), r.id])
    // Wave 1 挂点：标题回填后同步 FTS 索引（title 在索引字段内，变化需重建该词条索引行）
    await syncWikiFts(db, Number(r.id))
    n++
  }
  return n
}

/** 外部独立词条详情（路径挂载：直接读外部卷文件） */
wikiRouter.get('/imported/:metaId', async (req, res) => {
  try {
    const db = await getDb()
    const metaId = parseInt(req.params.metaId)
    const row = await (await db.prepare(
      'SELECT id as meta_id, entry_path, distilled_at, title, summary, tags, confidence as conf FROM wiki_entries_meta WHERE id = ? AND file_id IS NULL'
    )).get(metaId) as any
    if (!row) return res.status(404).json({ success: false, message: '词条不存在' })
    let content = ''
    let readable = true
    try {
      content = await fs.readFile(row.entry_path, 'utf8')
    } catch {
      readable = false // 外部卷未挂载或文件被移动
    }
    res.json({
      id: `m${row.meta_id}`,
      no: 'M' + String(row.meta_id).padStart(3, '0'),
      title: row.title, summary: row.summary, content,
      tags: row.tags ? JSON.parse(row.tags).map((n: string) => ({ name: n })) : [],
      conf: row.conf, distilled_at: row.distilled_at,
      llm_state: 'imported', source_type: 'imported',
      path: row.entry_path, agent: '外部挂载', ext: '.md',
      domainPath: '外部 Wiki', readable
    })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 词条详情：摘要 + 要点 + 实体 + 关系 + 回链 */
wikiRouter.get('/:fileId', async (req, res) => {
  try {
    const db = await getDb()
    const fileId = parseInt(req.params.fileId)
    const row = await (await db.prepare(`
      SELECT wem.file_id as id, wem.title as wiki_title, wem.entities_count, wem.distilled_at, wem.quality_score as conf,
             f.title, f.name, f.alias, f.summary, f.path, f.source_agent as agent, f.ext, f.llm_state,
             d.name as domain, d2.name as parent_domain
      FROM wiki_entries_meta wem
      JOIN files f ON wem.file_id = f.id
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN domains d2 ON d.parent_id = d2.id
      WHERE wem.file_id = ?
    `)).get(fileId) as any
    if (!row) return res.status(404).json({ success: false, message: '词条不存在' })

    const entryDir = path.join(WIKI_DIR, String(fileId))
    const readJson = async (name: string) => {
      try {
        return JSON.parse(await fs.readFile(path.join(entryDir, name), 'utf8'))
      } catch {
        return []
      }
    }
    let content = ''
    try {
      content = await fs.readFile(path.join(entryDir, 'entry.md'), 'utf8')
    } catch { /* 词条文件缺失时降级 */ }

    const entities = await readJson('entities.json')
    const relations = await readJson('relations.json')
    const points = await readJson('points.json')

    const tagStmt = await db.prepare('SELECT t.name, ft.source FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE ft.file_id = ?')
    const tags = await tagStmt.all(fileId) as any[]

    res.json({
      ...row,
      no: String(fileId).padStart(3, '0'),
      // 展示标题：蒸馏词条标题优先，退回源文件标题/文件名；orig_title 保留入库时的原始标题
      title: row.wiki_title || row.title || row.alias || row.name,
      orig_title: row.title,
      alias: row.alias,
      domainPath: row.parent_domain ? `${row.parent_domain} / ${row.domain}` : row.domain,
      content,
      points,
      entities,
      relations,
      tags
    })
  } catch (e: any) {
    res.status(500).json({ success: false, message: String(e) })
  }
})
