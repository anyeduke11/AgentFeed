import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from '../db.js'
import { withinScanRoots } from './files.js'
import { scan } from '../scanner.js'
import { restartWatcherForRoots } from '../watcher.js'
import { WebclipError, assertPublicUrl } from '../webclip/ssrf.js'
import { buildDocBase, reserveBase } from '../webclip/naming.js'
import { htmlToMarkdown, rewriteSnapshot } from '../webclip/convert.js'
import { renderPage, isReady } from '../webclip/fetcher.js'
import { yamlSafe, commentSafe } from '../webclip/sanitize.js'

export { WebclipError }

export const webclipRouter = Router()

const PAGE_MAX_BYTES = 20 * 1024 * 1024
const IMG_MAX_BYTES = 5 * 1024 * 1024
const IMG_TIMEOUT_MS = 15000
const DEADLINE_MS = 45 * 1000

const STATUS_BY_CODE: Record<string, number> = { ssrf: 400, config: 400, dup: 409, fetch: 502, notready: 503, toolarge: 413, busy: 429 }

// 模块级并发互斥：同一时刻仅允许一个剪藏任务（Playwright 单实例 + 落盘串行）
let clipBusy = false

const esc = (s: string) => s.replace(/'/g, "''")

async function getStorageRoot(): Promise<string | null> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'webclip.storageRoot'")).get() as any
  const v = row?.value ? String(row.value).trim() : ''
  return v || null
}

webclipRouter.get('/config', async (req, res) => {
  try {
    const storageRoot = await getStorageRoot()
    const db = await getDb()
    const rootRow = storageRoot
      ? await (await db.prepare('SELECT id, enabled FROM scan_roots WHERE path = ?')).get(storageRoot) as any
      : null
    res.json({ success: true, storageRoot, rootRegistered: !!rootRow, rootEnabled: !!rootRow?.enabled, playwrightReady: await isReady() })
  } catch (e: any) {
    console.error('webclip /config failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
  }
})

webclipRouter.put('/config', async (req, res) => {
  try {
    const raw = String((req.body as any)?.storageRoot || '').trim()
    if (!raw || !path.isAbsolute(raw)) return res.status(400).json({ success: false, message: 'storageRoot 必须是绝对路径' })
    const rootPath = path.resolve(raw)
    const db = await getDb()
    // 与既有扫描根：嵌套（双向）一律拒绝；相等仅允许 webclip 自己注册的根（幂等重存）
    const rows = await (await db.prepare('SELECT path, agent FROM scan_roots')).all() as any[]
    for (const r of rows) {
      const p = String(r.path)
      if (p !== rootPath && (rootPath.startsWith(p + '/') || p.startsWith(rootPath + '/'))) {
        return res.status(400).json({ success: false, message: `与既有扫描根嵌套：${p}` })
      }
      if (p === rootPath && r.agent !== 'webclip') {
        return res.status(400).json({ success: false, message: `该目录已是其他扫描根（${p}），请换目录` })
      }
    }
    await fs.mkdir(rootPath, { recursive: true })
    const existing = await (await db.prepare('SELECT id FROM scan_roots WHERE path = ?')).get(rootPath) as any
    if (!existing) {
      await db.exec(`INSERT INTO scan_roots (path, agent) VALUES ('${rootPath.replace(/'/g, "''")}', 'webclip')`)
      restartWatcherForRoots().catch(() => {})
    }
    await db.exec(`UPDATE config SET value = '${rootPath.replace(/'/g, "''")}', updated_at = CURRENT_TIMESTAMP WHERE key = 'webclip.storageRoot'`)
    res.json({ success: true, storageRoot: rootPath })
  } catch (e: any) {
    console.error('webclip /config failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
  }
})

export interface ConvertDeps {
  renderPage?: (url: string, timeoutMs?: number) => Promise<{ html: string; finalUrl: string }>
  runScan?: (roots: string[]) => Promise<unknown>
  assertPublicUrl?: (url: string) => Promise<unknown>
}

export interface ConvertResult {
  success: true
  base: string
  title: string
  mdPath: string
  htmlPath: string | null
  snapshot: boolean
  mdFileId: number | null
  htmlFileId: number | null
  durationMs: number
  images: number
}

/** 剪藏核心：URL → 抓取 → 限额/门禁 → md/html 落盘 → 扫描回填 file_id。deps 可注入（测试不触网）；记录写入留在路由层 */
export async function convertCore(url: string, opts: { snapshot?: boolean; force?: boolean } = {}, deps: ConvertDeps = {}): Promise<ConvertResult> {
  const t0 = Date.now()
  const snapshot = opts.snapshot !== false
  const render = deps.renderPage ?? renderPage
  const runScan = deps.runScan ?? ((roots: string[]) => scan({ roots, full: false, source: 'webclip' }))
  const assertUrl = deps.assertPublicUrl ?? assertPublicUrl
  const db = await getDb()
  const storageRoot = await getStorageRoot()
  if (!storageRoot) throw new WebclipError('config', '未配置剪藏目录，请先在设置页配置')

  const assertDeadline = () => {
    if (Date.now() - t0 > DEADLINE_MS) throw new WebclipError('fetch', '剪藏总耗时超过 45s 限额，已中止')
  }

  // 重复 URL：已有成功记录且未勾选强制重剪 → 拒绝
  const dup = await (await db.prepare("SELECT id FROM webclip_records WHERE url = ? AND status = 'success' LIMIT 1")).get(String(url)) as any
  if (dup && !opts.force) throw new WebclipError('dup', '该 URL 已剪藏成功过；如需重新抓取请勾选「强制重剪」')

  await assertUrl(String(url))
  const { html } = await render(String(url), 30000)
  assertDeadline()
  if (Buffer.byteLength(html) > PAGE_MAX_BYTES) throw new WebclipError('toolarge', '页面超过 20MB 限额')

  const { title, markdown, images } = htmlToMarkdown(html, String(url))
  const base = reserveBase(storageRoot, buildDocBase(title))
  const mdPath = path.join(storageRoot, `${base}.md`)
  const htmlPath = path.join(storageRoot, `${base}.html`)
  // 落盘边界（红线 1 写侧对偶）：目标必须在已启用扫描根内（先于任何磁盘写入）
  if (!(await withinScanRoots(db, mdPath)) || (snapshot && !(await withinScanRoots(db, htmlPath)))) {
    throw new WebclipError('config', '落盘目标不在已启用扫描根内，已中止')
  }
  const assetsDir = path.join(storageRoot, 'assets', base)
  await fs.mkdir(assetsDir, { recursive: true })

  // 图片本地化：成功 → md 占位符换相对路径；失败 → 降级 alt 文案（防盗链/超限不中断剪藏）
  const relMap = new Map<string, string>()
  let md = markdown
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    assertDeadline()
    try {
      await assertUrl(img.absUrl)
      const r = await fetch(img.absUrl, {
        headers: { 'User-Agent': 'AgentFeed-WebClip/1.0', Referer: new URL(img.absUrl).origin },
        signal: AbortSignal.timeout(IMG_TIMEOUT_MS)
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.byteLength > IMG_MAX_BYTES) throw new Error('超过单图 5MB 限额')
      const ext = (path.extname(new URL(img.absUrl).pathname).replace(/[^.\w]/g, '') || '.img').slice(0, 8)
      const name = `img-${i}${ext}`
      await fs.writeFile(path.join(assetsDir, name), buf)
      const rel = `assets/${base}/${name}`
      relMap.set(img.absUrl, rel)
      md = md.split(img.placeholder).join(rel)
    } catch {
      md = md.split(`![${img.alt}](${img.placeholder})`).join(img.alt ? `"${img.alt}"（图片未保存）` : '（图片未保存）')
    }
  }
  md = md.replace(/__WEBCLIP_IMG_\d+__/g, '') // 兜底清残留占位符

  assertDeadline()
  const clippedAt = new Date().toISOString()
  const fm = ['---', 'agent: webclip', `source_url: ${yamlSafe(String(url))}`, `clipped_at: ${clippedAt}`, ...(snapshot ? [`snapshot: ./${base}.html`] : []), '---', ''].join('\n')
  await fs.writeFile(mdPath, fm + md, 'utf8')
  if (snapshot) {
    const snapHtml = rewriteSnapshot(html, String(url), relMap)
    const anchored = snapHtml.replace('<head>', `<head>\n<!-- AgentFeed webclip: ${base} | source: ${commentSafe(String(url))} | clipped_at: ${clippedAt} -->`)
    await fs.writeFile(htmlPath, anchored, 'utf8')
  }

  assertDeadline()
  // 触发剪藏根增量扫描（await 后回填 file_id）→ 门禁/打分/蒸馏/向量化由既有管线接手
  await runScan([storageRoot])
  const mdRow = await (await db.prepare('SELECT id FROM files WHERE path = ?')).get(mdPath) as any
  const htmlRow = snapshot ? await (await db.prepare('SELECT id FROM files WHERE path = ?')).get(htmlPath) as any : null
  return { success: true, base, title, mdPath, htmlPath: snapshot ? htmlPath : null, snapshot, mdFileId: mdRow?.id ?? null, htmlFileId: htmlRow?.id ?? null, durationMs: Date.now() - t0, images: relMap.size }
}

async function insertSuccessRecord(url: string, r: ConvertResult) {
  const db = await getDb()
  await db.exec(`INSERT INTO webclip_records (url, title, slug_ts, md_path, html_path, md_file_id, html_file_id, status, snapshot, duration_ms)
    VALUES ('${esc(url)}', '${esc(r.title || '')}', '${esc(r.base)}', '${esc(r.mdPath)}', ${r.htmlPath ? `'${esc(r.htmlPath)}'` : 'NULL'}, ${r.mdFileId ?? 'NULL'}, ${r.htmlFileId ?? 'NULL'}, 'success', ${r.snapshot ? 1 : 0}, ${r.durationMs})`)
}

async function failRecord(url: string, snapshot: boolean, e: any, startedAt = Date.now()) {
  const db = await getDb()
  await db.exec(`INSERT INTO webclip_records (url, status, snapshot, error, duration_ms) VALUES ('${esc(url)}', 'failed', ${snapshot ? 1 : 0}, '${esc(e?.message || String(e))}', ${Date.now() - startedAt})`)
}

/** 重试失败记录：force 重跑核心，成功后原行原地更新为 success（不新增行）；记录不存在/已成功直接抛错不改行 */
export async function retryRecord(recordId: number, deps: ConvertDeps = {}): Promise<ConvertResult> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT * FROM webclip_records WHERE id = ?')).get(recordId) as any
  if (!row) throw new WebclipError('config', '记录不存在')
  if (row.status === 'success') throw new WebclipError('dup', '该记录已是成功状态，无需重试')
  const r = await convertCore(String(row.url), { snapshot: !!row.snapshot, force: true }, deps)
  await db.exec(`UPDATE webclip_records SET
    title = '${esc(r.title || '')}',
    slug_ts = '${esc(r.base)}',
    md_path = '${esc(r.mdPath)}',
    html_path = ${r.htmlPath ? `'${esc(r.htmlPath)}'` : 'NULL'},
    md_file_id = ${r.mdFileId ?? 'NULL'},
    html_file_id = ${r.htmlFileId ?? 'NULL'},
    status = 'success',
    snapshot = ${r.snapshot ? 1 : 0},
    duration_ms = ${r.durationMs},
    error = NULL
    WHERE id = ${recordId}`)
  return r
}

async function markRetryFailed(recordId: number, e: any) {
  try {
    const db = await getDb()
    await db.exec(`UPDATE webclip_records SET status = 'failed', error = '${esc(e?.message || String(e))}', duration_ms = NULL WHERE id = ${recordId}`)
  } catch (err) {
    console.error('webclip markRetryFailed failed', err)
  }
}

webclipRouter.post('/convert', async (req, res) => {
  const { url, snapshot = true, force = false } = req.body as { url?: string; snapshot?: boolean; force?: boolean }
  if (!url) return res.status(400).json({ success: false, message: 'url 必填' })
  if (clipBusy) return res.status(429).json({ success: false, code: 'busy', message: '已有剪藏任务执行中，请稍后再试' })
  clipBusy = true
  const t0 = Date.now()
  try {
    const r = await convertCore(String(url), { snapshot, force })
    await insertSuccessRecord(String(url), r)
    res.json(r)
  } catch (e: any) {
    await failRecord(String(url), snapshot, e, t0)
    const code = e instanceof WebclipError ? e.code : 'fetch'
    res.status(STATUS_BY_CODE[code] ?? 500).json({ success: false, code, message: e?.message || String(e) })
  } finally {
    clipBusy = false
  }
})

webclipRouter.post('/records/:id/retry', async (req, res) => {
  const id = parseInt(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id 非法' })
  if (clipBusy) return res.status(429).json({ success: false, code: 'busy', message: '已有剪藏任务执行中，请稍后再试' })
  clipBusy = true
  try {
    const r = await retryRecord(id)
    res.json(r)
  } catch (e: any) {
    const code = e instanceof WebclipError ? e.code : 'fetch'
    if (code !== 'dup' && code !== 'config') await markRetryFailed(id, e) // 重试再失败：原行置 failed
    res.status(STATUS_BY_CODE[code] ?? 500).json({ success: false, code, message: e?.message || String(e) })
  } finally {
    clipBusy = false
  }
})

webclipRouter.get('/records', async (req, res) => {
  try {
    const db = await getDb()
    const status = String(req.query.status || '全部')
    const page = Math.max(1, parseInt(String(req.query.page || '1')) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20')) || 20))
    const where = status !== '全部' ? `WHERE status = '${status.replace(/'/g, "''")}'` : ''
    const total = ((await (await db.prepare(`SELECT COUNT(*) AS c FROM webclip_records ${where}`)).get()) as any).c
    const rows = await (await db.prepare(`SELECT * FROM webclip_records ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`)).all() as any[]
    // 懒回填：扫描时序未命中的 file_id 在读取时补齐（幂等）
    for (const r of rows) {
      if (r.status === 'success' && r.md_path && !r.md_file_id) {
        const row = await (await db.prepare('SELECT id FROM files WHERE path = ?')).get(r.md_path) as any
        if (row) { await db.exec(`UPDATE webclip_records SET md_file_id = ${row.id} WHERE id = ${r.id}`); r.md_file_id = row.id }
      }
      if (r.status === 'success' && r.html_path && !r.html_file_id) {
        const row = await (await db.prepare('SELECT id FROM files WHERE path = ?')).get(r.html_path) as any
        if (row) { await db.exec(`UPDATE webclip_records SET html_file_id = ${row.id} WHERE id = ${r.id}`); r.html_file_id = row.id }
      }
    }
    res.json({ success: true, total, items: rows, page, limit })
  } catch (e: any) {
    console.error('webclip /records failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
  }
})
