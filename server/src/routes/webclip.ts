import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from '../db.js'
import { withinScanRoots } from './files.js'
import { scan } from '../scanner.js'
import { restartWatcherForRoots } from '../watcher.js'
import { WebclipError, assertPublicUrl } from '../webclip/ssrf.js'
import { buildDocBase, reserveBase } from '../webclip/naming.js'
import { htmlToMarkdown, rewriteSnapshot, type ImgFilterConfig } from '../webclip/convert.js'
import { renderPage, isReady } from '../webclip/fetcher.js'
import { yamlSafe, commentSafe } from '../webclip/sanitize.js'

export { WebclipError }

export const webclipRouter = Router()

const IMG_TIMEOUT_MS = 15000

// 图片落盘扩展名只允许资产代理白名单可服务的后缀（files.ts ASSET_EXTS，不含 .avif——产出即 404，fail-closed）
const KNOWN_IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.svgz'])
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

const DEFAULT_LIMITS = { pageMaxMB: 20, imgMaxMB: 5, imgMaxCount: 30, navTimeoutMs: 30000, deadlineMs: 45000 }
export type WebclipLimits = typeof DEFAULT_LIMITS

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

/** 剪藏限额（config webclip.limits 覆盖默认值；损坏 JSON 回退默认） */
export async function getLimits(): Promise<WebclipLimits> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'webclip.limits'")).get() as any
  if (!row?.value) return { ...DEFAULT_LIMITS }
  try { return { ...DEFAULT_LIMITS, ...JSON.parse(String(row.value)) } } catch { return { ...DEFAULT_LIMITS } }
}

/** 图片质量过滤默认配置：微信文章宣传图剔除（二维码/横幅/图标/引流文案），词表可在设置页增补 */
const DEFAULT_IMG_FILTER: ImgFilterConfig = {
  enabled: true,
  minPx: 80,
  maxRatio: 4,
  minBytes: 1024,
  urlKeywords: ['qrcode', 'qr_code', '二维码', 'wechat_qr', 'barcode', 'watermark', '水印', 'logo', 'avatar', 'icon', 'badge', 'banner', 'promo', 'share_', 'follow'],
  altKeywords: ['点击关注', '扫码关注', '二维码', '公众号', '赞赏', '打赏', '阅读原文', '关注我们', '长按识别', '加我微信', '企业微信', '推广']
}

/** 图片质量过滤配置（config webclip.imageFilter 覆盖默认；损坏 JSON 回退默认） */
export async function getImageFilter(): Promise<ImgFilterConfig> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'webclip.imageFilter'")).get() as any
  if (!row?.value) return { ...DEFAULT_IMG_FILTER, urlKeywords: [...DEFAULT_IMG_FILTER.urlKeywords], altKeywords: [...DEFAULT_IMG_FILTER.altKeywords] }
  try {
    const stored = JSON.parse(String(row.value))
    return {
      ...DEFAULT_IMG_FILTER,
      ...stored,
      urlKeywords: Array.isArray(stored.urlKeywords) && stored.urlKeywords.length ? stored.urlKeywords : [...DEFAULT_IMG_FILTER.urlKeywords],
      altKeywords: Array.isArray(stored.altKeywords) && stored.altKeywords.length ? stored.altKeywords : [...DEFAULT_IMG_FILTER.altKeywords]
    }
  } catch { return { ...DEFAULT_IMG_FILTER, urlKeywords: [...DEFAULT_IMG_FILTER.urlKeywords], altKeywords: [...DEFAULT_IMG_FILTER.altKeywords] } }
}

webclipRouter.get('/config', async (req, res) => {
  try {
    const storageRoot = await getStorageRoot()
    const db = await getDb()
    const rootRow = storageRoot
      ? await (await db.prepare('SELECT id, enabled FROM scan_roots WHERE path = ?')).get(storageRoot) as any
      : null
    res.json({ success: true, storageRoot, rootRegistered: !!rootRow, rootEnabled: !!rootRow?.enabled, playwrightReady: await isReady(), limits: await getLimits(), imageFilter: await getImageFilter() })
  } catch (e: any) {
    console.error('webclip /config failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
  }
})

/** 剪藏存储根校验（纯校验不落盘）：与既有扫描根嵌套（双向）一律拒绝；相等仅允许 webclip 自己注册的根（幂等重存）。返回错误消息或 null */
export async function validateStorageRoot(db: any, rootPath: string): Promise<string | null> {
  const rows = await (await db.prepare('SELECT path, agent FROM scan_roots')).all() as any[]
  for (const r of rows) {
    const p = String(r.path)
    if (p !== rootPath && (rootPath.startsWith(p + '/') || p.startsWith(rootPath + '/'))) {
      return `与既有扫描根嵌套：${p}`
    }
    if (p === rootPath && r.agent !== 'webclip') {
      return `该目录已是其他扫描根（${p}），请换目录`
    }
  }
  return null
}

webclipRouter.put('/config', async (req, res) => {
  try {
    const raw = String((req.body as any)?.storageRoot || '').trim()
    if (!raw || !path.isAbsolute(raw)) return res.status(400).json({ success: false, message: 'storageRoot 必须是绝对路径' })
    const rootPath = path.resolve(raw)
    const db = await getDb()
    const err = await validateStorageRoot(db, rootPath)
    if (err) return res.status(400).json({ success: false, message: err })
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
  const limits = await getLimits()
  const imgFilter = await getImageFilter()
  const storageRoot = await getStorageRoot()
  if (!storageRoot) throw new WebclipError('config', '未配置剪藏目录，请先在设置页配置')

  const assertDeadline = () => {
    if (Date.now() - t0 > limits.deadlineMs) throw new WebclipError('fetch', `剪藏总耗时超过 ${Math.round(limits.deadlineMs / 1000)}s 限额，已中止`)
  }

  // 重复 URL：已有成功记录且未勾选强制重剪 → 拒绝
  const dup = await (await db.prepare("SELECT id FROM webclip_records WHERE url = ? AND status = 'success' LIMIT 1")).get(String(url)) as any
  if (dup && !opts.force) throw new WebclipError('dup', '该 URL 已剪藏成功过；如需重新抓取请勾选「强制重剪」')

  await assertUrl(String(url))
  const { html } = await render(String(url), limits.navTimeoutMs)
  assertDeadline()
  if (Buffer.byteLength(html) > limits.pageMaxMB * 1024 * 1024) throw new WebclipError('toolarge', `页面超过 ${limits.pageMaxMB}MB 限额`)

  const { title, markdown, images } = htmlToMarkdown(html, String(url), limits.imgMaxCount, imgFilter)
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
      if (buf.byteLength > limits.imgMaxMB * 1024 * 1024) throw new Error(`超过单图 ${limits.imgMaxMB}MB 限额`)
      // 下载后兜底：超小文件（像素点/表情级）按失败路径降级 alt——采集时无 HTML 尺寸信号的噪声图二次保险
      if (imgFilter.enabled && buf.byteLength < imgFilter.minBytes) throw new Error(`图片过小（${buf.byteLength}B < ${imgFilter.minBytes}B）`)
      // 扩展名：URL 后缀仅在白名单内才采用，否则按 Content-Type 映射；仍未知 → 抛错降级 alt 文案（不写 .img 这种代理必 404 的文件）
      const urlExt = (path.extname(new URL(img.absUrl).pathname).replace(/[^.\w]/g, '') || '').toLowerCase().slice(0, 8)
      const ctype = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const ext = KNOWN_IMG_EXT.has(urlExt) ? urlExt : EXT_BY_CONTENT_TYPE[ctype]
      if (!ext) throw new Error('未支持的图片类型')
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

async function failRecord(url: string, snapshot: boolean, code: string, e: any, startedAt = Date.now()) {
  try {
    const db = await getDb()
    await db.exec(`INSERT INTO webclip_records (url, status, code, snapshot, error, duration_ms) VALUES ('${esc(url)}', 'failed', '${esc(code)}', ${snapshot ? 1 : 0}, '${esc(e?.message || String(e))}', ${Date.now() - startedAt})`)
  } catch (err) {
    console.error('webclip record write failed', err)
  }
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
    code = NULL,
    error = NULL
    WHERE id = ${recordId}`)
  return r
}

async function markRetryFailed(recordId: number, code: string, e: any) {
  try {
    const db = await getDb()
    await db.exec(`UPDATE webclip_records SET status = 'failed', code = '${esc(code)}', error = '${esc(e?.message || String(e))}', duration_ms = NULL WHERE id = ${recordId}`)
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
    const code = e instanceof WebclipError ? e.code : 'fetch'
    await failRecord(String(url), snapshot, code, e, t0)
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
    if (code !== 'dup' && code !== 'config') await markRetryFailed(id, code, e) // 重试再失败：原行置 failed（code 同步落库）
    res.status(STATUS_BY_CODE[code] ?? 500).json({ success: false, code, message: e?.message || String(e) })
  } finally {
    clipBusy = false
  }
})

webclipRouter.put('/limits', async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    const next: Record<string, number> = { ...DEFAULT_LIMITS }
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof WebclipLimits)[]) {
      const v = Number(body[k])
      if (Number.isFinite(v) && v > 0) next[k] = v
      else if (body[k] !== undefined) return res.status(400).json({ success: false, message: `${k} 必须为正数` })
    }
    const db = await getDb()
    await db.exec(`UPDATE config SET value = '${JSON.stringify(next).replace(/'/g, "''")}', updated_at = CURRENT_TIMESTAMP WHERE key = 'webclip.limits'`)
    res.json({ success: true, limits: next })
  } catch (e: any) {
    console.error('webclip /limits failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
  }
})

/** 图片质量过滤配置：开关/阈值/两组词表。词表字符串数组（非空校验），阈值正数；未提供的数组回落默认词表 */
webclipRouter.put('/imagefilter', async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, any>
    const next: ImgFilterConfig = { ...DEFAULT_IMG_FILTER, urlKeywords: [...DEFAULT_IMG_FILTER.urlKeywords], altKeywords: [...DEFAULT_IMG_FILTER.altKeywords] }
    if (body.enabled !== undefined) next.enabled = !!body.enabled
    for (const k of ['minPx', 'maxRatio', 'minBytes'] as const) {
      const v = Number(body[k])
      if (Number.isFinite(v) && v > 0) next[k] = v
      else if (body[k] !== undefined) return res.status(400).json({ success: false, message: `${k} 必须为正数` })
    }
    for (const k of ['urlKeywords', 'altKeywords'] as const) {
      if (body[k] === undefined) continue
      if (!Array.isArray(body[k]) || body[k].some((x: any) => typeof x !== 'string')) {
        return res.status(400).json({ success: false, message: `${k} 必须是字符串数组` })
      }
      next[k] = (body[k] as string[]).map(s => s.trim()).filter(Boolean)
    }
    const db = await getDb()
    await db.exec(`UPDATE config SET value = '${JSON.stringify(next).replace(/'/g, "''")}', updated_at = CURRENT_TIMESTAMP WHERE key = 'webclip.imageFilter'`)
    res.json({ success: true, imageFilter: next })
  } catch (e: any) {
    console.error('webclip /imagefilter failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
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
