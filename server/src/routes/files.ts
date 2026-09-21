import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from '../db.js'
import { openFile, revealFile } from '../opener.js'
import { buildReaderDoc } from '../reader.js'
import { scan, ScanOptions } from '../scanner.js'
import { llmQueue } from '../llm/index.js'
import { getProviders, getDefaultModel } from '../llm/llmClient.js'
import { ensureTag } from '../llm/tagGovernance.js'
import { deleteFtsEntry } from '../search/ftsIndex.js'

export const filesRouter = Router()

/** 彻底删除单个文件的全部索引数据（含 wiki 词条目录） */
async function purgeFile(db: any, fileId: number) {
  await db.exec(`DELETE FROM file_tags WHERE file_id = ${fileId}`)
  await db.exec(`DELETE FROM file_versions WHERE file_id = ${fileId} OR related_file_id = ${fileId}`)
  await db.exec(`DELETE FROM llm_feedback WHERE file_id = ${fileId}`)
  // Wave 1 挂点：词条删除前先取 meta id，删除后同步清理 FTS 索引与分块向量（防孤儿索引行）
  const metaIds = ((await (await db.prepare('SELECT id FROM wiki_entries_meta WHERE file_id = ?')).all([fileId])) as any[]).map(r => Number(r.id))
  await db.exec(`DELETE FROM wiki_entries_meta WHERE file_id = ${fileId}`)
  for (const mid of metaIds) {
    await deleteFtsEntry(db, mid)
    await db.exec(`DELETE FROM entry_chunks WHERE entry_id = ${mid}`)
  }
  await db.exec(`DELETE FROM files WHERE id = ${fileId}`)
  const wikiDir = path.join(process.cwd(), 'data', 'wiki', 'entries', String(fileId))
  await fs.rm(wikiDir, { recursive: true, force: true })
}

filesRouter.get('/', async (req, res) => {
  try {
    const db = await getDb()
    const { kw, domain, tags, agent, type, state, status = 'active', sort = 'created_at', page = '1', limit = '50' } = req.query as Record<string, string>
    const offset = (parseInt(page) - 1) * parseInt(limit)
    let where = 'WHERE f.status = ?'
    const params: any[] = [status]
    if (state) {
      where += ' AND f.llm_state = ?'
      params.push(state)
    }
    if (kw) {
      where += ' AND (f.title LIKE ? OR f.path LIKE ? OR f.name LIKE ?)'
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`)
    }
    if (domain) {
      const domainStmt = await db.prepare('SELECT id FROM domains WHERE name = ?')
      const domainRow = await domainStmt.get(domain) as any
      if (domainRow) {
        where += ' AND f.domain_id = ?'
        params.push(domainRow.id)
      }
    }
    if (agent) {
      where += ' AND f.source_agent = ?'
      params.push(agent)
    }
    if (type) {
      where += ' AND f.ext = ?'
      params.push(type.startsWith('.') ? type : `.${type}`)
    }
    if (tags) {
      const tagList = (tags as string).split(',').map(t => t.trim()).filter(Boolean)
      // ensureTag 解析：被合并的旧标签名自动跟随指向，筛选不失效
      const tagIds: number[] = []
      for (const t of tagList) {
        const id = await ensureTag(db, t)
        if (id) tagIds.push(id)
      }
      if (tagIds.length > 0) {
        where += ` AND f.id IN (SELECT file_id FROM file_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`
        params.push(...tagIds)
      }
    }
    const orderBy = sort === 'name' ? 'f.name' : sort === 'mtime' ? 'f.file_mtime' : 'f.created_at'
    const totalStmt = await db.prepare(`SELECT COUNT(*) as cnt FROM files f ${where}`)
    const totalRow = await totalStmt.get(params) as any
    const total = totalRow.cnt as number
    const limitNum = parseInt(limit)
    const offsetNum = (parseInt(page) - 1) * limitNum
    const sql = `SELECT f.*, d.name as domain_name FROM files f LEFT JOIN domains d ON f.domain_id = d.id ${where} ORDER BY ${orderBy} DESC LIMIT ${limitNum} OFFSET ${offsetNum}`
    const rowsStmt = await db.prepare(sql)
    const rows = await rowsStmt.all(params) as any[]
    const tagMap = new Map<number, any[]>()
    const tagRowsStmt = await db.prepare('SELECT ft.file_id, t.id as tag_id, t.name, t.color, ft.source FROM file_tags ft JOIN tags t ON ft.tag_id = t.id')
    const tagRows = await tagRowsStmt.all() as any[]
    for (const t of tagRows) {
      if (!tagMap.has(t.file_id)) tagMap.set(t.file_id, [])
      tagMap.get(t.file_id)!.push({ id: t.tag_id, name: t.name, color: t.color, source: t.source })
    }
    const result = rows.map(r => ({ ...r, tags: tagMap.get(r.id) || [] }))
    res.json({ items: result, total, page: parseInt(page), limit: limitNum })
  } catch (e: any) {
    console.error('files list failed', e)
    res.status(500).json({ success: false, message: String(e), stack: e.stack })
  }
})

filesRouter.post('/batch', async (req, res) => {
  const db = await getDb()
  const { ids, action, domain_id } = req.body as { ids: number[]; action: 'delete' | 'restore' | 'domain'; domain_id?: number }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: 'ids 不能为空' })
  }
  const idList = ids.map(i => parseInt(String(i))).filter(i => !isNaN(i))
  const inClause = idList.join(',')
  if (action === 'delete') {
    await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id IN (${inClause})`)
  } else if (action === 'restore') {
    await db.exec(`UPDATE files SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id IN (${inClause})`)
  } else if (action === 'domain') {
    if (domain_id === undefined) return res.json({ success: false, message: 'domain_id 必填' })
    const val = domain_id === null ? 'NULL' : parseInt(String(domain_id))
    await db.exec(`UPDATE files SET domain_id = ${val}, updated_at = CURRENT_TIMESTAMP WHERE id IN (${inClause})`)
  } else {
    return res.json({ success: false, message: 'action 不支持' })
  }
  res.json({ success: true, affected: idList.length })
})

filesRouter.post('/purge-deleted', async (req, res) => {
  const db = await getDb()
  const rows = await (await db.prepare("SELECT id FROM files WHERE status = 'deleted'")).all() as any[]
  for (const r of rows) {
    await purgeFile(db, r.id)
  }
  res.json({ success: true, purged: rows.length })
})

filesRouter.delete('/:id', async (req, res) => {
  const db = await getDb()
  const fileId = parseInt(req.params.id)
  const row = await (await db.prepare('SELECT id FROM files WHERE id = ?')).get(fileId) as any
  if (!row) return res.status(404).json({ success: false, message: '文件不存在' })
  await purgeFile(db, fileId)
  res.json({ success: true })
})

filesRouter.post('/:id/open', async (req, res) => {
  const fileId = parseInt(req.params.id)
  const result = await openFile(fileId)
  // 阅读埋点：统一走后端 open 接口，打开即记录（打开只算浏览，打分才升级已读）
  if (result.success) {
    try {
      const db = await getDb()
      const f = await (await db.prepare('SELECT path FROM files WHERE id = ?')).get(fileId) as any
      const source = String(req.body?.source || 'other').replace(/'/g, "''").slice(0, 20)
      if (f) await db.exec(`INSERT INTO read_history (file_id, path, source) VALUES (${fileId}, '${String(f.path).replace(/'/g, "''")}', '${source}')`)
      // R1 回溯：池内文件返回上次阅读进度，供前端 toast「上次读到 X%」（读毕 100% 不再提示）
      const rec = await (await db.prepare('SELECT progress FROM recommendations WHERE file_id = ?')).get(fileId) as any
      if (rec && rec.progress > 0 && rec.progress < 100) (result as any).lastProgress = rec.progress
    } catch { /* 埋点失败不影响打开 */ }
  }
  res.json(result)
})

// ---- R4 站内阅读器 ----
/** 站内渲染内容上限：2MB 截断（超大文件引导外部打开） */
const READER_MAX_BYTES = 2 * 1024 * 1024
/** 资源代理单文件上限 */
const ASSET_MAX_BYTES = 5 * 1024 * 1024
/** 资源代理后缀白名单（svg 作为 <img> 加载不执行脚本，另加 CSP sandbox 双保险） */
const ASSET_EXTS: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.svgz': 'image/svg+xml',
}

/** 校验目标路径在某个已启用扫描根内（与 opener.ts 根边界同模式） */
export async function withinScanRoots(db: any, target: string): Promise<boolean> {
  const roots = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')).all() as any[]
  // 严格边界：等根本身，或以其 + 路径分隔符为前缀（裸 startsWith 会误放行 /foo/bar2 这类兄弟目录）
  return roots.some(r => target === r.path || target.startsWith(r.path + path.sep))
}

/** 站内阅读内容：md/html 清洗渲染后返回完整 html 文档（前端 iframe srcdoc 注入） */
filesRouter.get('/:id/content', async (req, res) => {
  try {
    const db = await getDb()
    const fileId = parseInt(req.params.id)
    const f = await (await db.prepare("SELECT path, name, title, ext FROM files WHERE id = ? AND status = 'active'")).get(fileId) as any
    if (!f) return res.json({ success: false, message: '文件不存在或已删除' })
    const ext = String(f.ext || path.extname(f.path)).toLowerCase()
    if (!['.md', '.html', '.htm'].includes(ext)) {
      return res.json({ success: false, unsupported: true, message: '站内仅支持 md / html 阅读，已为你准备外部打开' })
    }
    if (!(await withinScanRoots(db, f.path))) return res.json({ success: false, message: '文件不在已注册扫描根目录下' })
    const stat = await fs.stat(f.path).catch(() => null)
    if (!stat || !stat.isFile()) return res.json({ success: false, message: '文件已不在磁盘上' })
    const fh = await fs.open(f.path, 'r')
    try {
      const len = Math.min(stat.size, READER_MAX_BYTES)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, 0)
      const truncated = stat.size > READER_MAX_BYTES
      const { html, toc } = buildReaderDoc(buf.toString('utf8'), ext, fileId, f.title || f.name)
      // R4-M2：进阅读器即记一次打开（source=reader，与外部打开并列），并带出池内进度供前端回位
      const rec = await (await db.prepare('SELECT progress FROM recommendations WHERE file_id = ?')).get(fileId) as any
      await db.exec(`INSERT INTO read_history (file_id, path, source) VALUES (${fileId}, '${String(f.path).replace(/'/g, "''")}', 'reader')`)
      res.json({ success: true, html, toc, title: f.title || f.name, truncated, inPool: !!rec, lastProgress: rec && rec.progress > 0 && rec.progress < 100 ? rec.progress : 0, path: f.path })
    } finally {
      await fh.close()
    }
  } catch (e: any) {
    console.error('reader content failed', e)
    res.json({ success: false, message: '内容读取失败：' + String(e?.message || e) })
  }
})

/** 站内阅读资源代理：相对路径图片经此读取（后缀白名单 + 5MB + 根边界 + CSP sandbox） */
filesRouter.get('/:id/asset', async (req, res) => {
  try {
    const db = await getDb()
    const fileId = parseInt(req.params.id)
    const rel = String(req.query.rel || '')
    if (!rel || rel.includes('\0')) return res.status(404).end()
    const f = await (await db.prepare("SELECT path FROM files WHERE id = ? AND status = 'active'")).get(fileId) as any
    if (!f) return res.status(404).end()
    const target = path.resolve(path.dirname(f.path), rel)
    if (target === path.resolve(f.path) || !(await withinScanRoots(db, target))) return res.status(404).end()
    const ext = path.extname(target).toLowerCase()
    const mime = ASSET_EXTS[ext]
    if (!mime) return res.status(404).end()
    const stat = await fs.stat(target).catch(() => null)
    if (!stat || !stat.isFile() || stat.size > ASSET_MAX_BYTES) return res.status(404).end()
    // CSP sandbox：文档进唯一 origin，svg 内脚本即使直接访问也不执行
    res.set('Content-Security-Policy', 'sandbox')
    res.set('Content-Type', mime)
    res.set('Cache-Control', 'private, max-age=86400')
    res.send(await fs.readFile(target))
  } catch {
    res.status(404).end()
  }
})

filesRouter.post('/:id/reveal', async (req, res) => {
  const result = await revealFile(parseInt(req.params.id))
  res.json(result)
})

filesRouter.patch('/:id', async (req, res) => {
  const db = await getDb()
  const { title, domain_id, tags, status } = req.body as Record<string, any>
  const setParts: string[] = ['updated_at = CURRENT_TIMESTAMP']
  if (title !== undefined) setParts.push(`title = '${String(title).replace(/'/g, "''")}'`)
  if (domain_id !== undefined) setParts.push(`domain_id = ${domain_id === null ? 'NULL' : domain_id}`)
  if (status !== undefined) setParts.push(`status = '${String(status).replace(/'/g, "''")}'`)
  await db.exec(`UPDATE files SET ${setParts.join(', ')} WHERE id = ${parseInt(req.params.id)}`)
  if (Array.isArray(tags)) {
    await db.exec(`DELETE FROM file_tags WHERE file_id = ${parseInt(req.params.id)}`)
    const insertSql = 'INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES '
    const values: string[] = []
    for (const tagName of tags) {
      // ensureTag：不存在则创建，已合并的旧名字跟随指向
      const tagId = await ensureTag(db, String(tagName))
      if (tagId) values.push(`(${parseInt(req.params.id)}, ${tagId}, 'manual')`)
    }
    if (values.length > 0) {
      await db.exec(insertSql + values.join(', '))
    }
  }
  res.json({ success: true })
})

filesRouter.post('/batch-llm-tag', async (req, res) => {
  const db = await getDb()
  const { fileIds } = req.body as { fileIds: number[] }
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.json({ success: false, message: 'fileIds 不能为空' })
  }
  const providers = await getProviders()
  const provider = providers[0]?.name || ''
  const model = await getDefaultModel()
  for (const id of fileIds) {
    await db.exec(`UPDATE files SET llm_state = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ${id} AND llm_state != 'running'`)
    llmQueue.enqueue({ fileId: id, provider, model, prompt: '' })
  }
  res.json({ success: true, queued: fileIds.length })
})

filesRouter.get('/:id/versions', async (req, res) => {
  const db = await getDb()
  const fileId = parseInt(req.params.id)
  const stmt = await db.prepare(`
    SELECT fv.*, f2.name as related_name, f2.path as related_path, f2.file_mtime as related_mtime
    FROM file_versions fv
    JOIN files f2 ON fv.related_file_id = f2.id
    WHERE fv.file_id = ?
  `)
  const rows = await stmt.all(fileId) as any[]
  res.json(rows)
})
