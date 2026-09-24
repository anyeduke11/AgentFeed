/**
 * R4 站内阅读器管线：md/html → 统一渲染 + 白名单清洗 + 阅读器壳包裹
 * 安全底线：双保险（服务端清洗 + iframe sandbox 无 allow-scripts），脚本零执行
 */
import MarkdownIt from 'markdown-it'
import * as cheerio from 'cheerio'

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

/** 目录项：level 1~3，id 为注入的锚点（rh-N，由本管线生成，安全可控） */
export interface TocItem { level: number; text: string; id: string }

/** 危险标签整体移除；meta 仅限 http-equiv=refresh（防跳转），style 保留（只作用于 iframe 内部） */
const STRIP_TAGS = 'script, iframe, frame, frameset, object, embed, link, base, form, meta[http-equiv="refresh"]'
/** 危险 URL 协议前缀（不区分大小写） */
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|data:text\/html)/i

/** 清洗 html：移除危险标签 / on* 事件属性 / 危险协议链接，返回清洗后的 html 字符串 */
export function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html)
  $(STRIP_TAGS).remove()
  $('*').each((_, el) => {
    const attrs = Object.keys({ ...(el as any).attribs })
    for (const a of attrs) {
      const lower = a.toLowerCase()
      if (lower.startsWith('on')) {
        $(el).removeAttr(a)
        continue
      }
      if (['href', 'src', 'xlink:href'].includes(lower)) {
        const v = String($(el).attr(a) || '')
        if (DANGEROUS_SCHEME.test(v)) $(el).removeAttr(a)
      }
    }
  })
  return $.html()
}

/** md → html（html:false 内联 html 按文本转义，天然挡注入） */
export function renderMarkdown(mdText: string): string {
  return md.render(mdText)
}

/** 把相对路径图片改写为资源代理地址（srcdoc 内相对路径无法解析，必须绝对化） */
function rewriteAssetPaths(html: string, fileId: number): string {
  const $ = cheerio.load(html)
  $('img').each((_, el) => {
    const src = String($(el).attr('src') || '').trim()
    if (!src || /^https?:\/\//i.test(src) || /^data:/i.test(src) || src.startsWith('/api/')) return
    let rel = src.replace(/^\.?\//, '')
    try { rel = decodeURIComponent(rel) } catch { /* 非转义 % 字面量，保持原样 */ }
    $(el).attr('src', `/api/files/${fileId}/asset?rel=${encodeURIComponent(rel)}`)
    $(el).attr('loading', 'lazy')
  })
  return $.html()
}

/** 目录提取：h1~h3 注入安全锚点 id（清洗之后执行，id 由本管线生成） */
function extractToc(html: string): { html: string; toc: TocItem[] } {
  const $ = cheerio.load(html)
  const toc: TocItem[] = []
  $('h1, h2, h3').each((i, el) => {
    const text = $(el).text().trim().slice(0, 80)
    if (!text) return
    const id = `rh-${i}`
    $(el).attr('id', id)
    toc.push({ level: Number(($(el).get(0) as any).tagName.slice(1)), text, id })
  })
  return { html: $.html(), toc }
}

/** 阅读器壳：charset + base target=_blank + 保底排版（颜色走 CSS 变量，父页可注入主题覆盖；字号 em 化便于父页缩放） */
export function wrapReaderHtml(bodyHtml: string, title: string): string {
  const safeTitle = title.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<base target="_blank" />
<style>
  :root { --r-bg:#FAF9F6; --r-fg:#2A2A28; --r-muted:#6A675F; --r-line:#E2DFD6; --r-code:#F0EEE8; --r-accent:#2456A6; }
  body { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; font: 16px/1.8 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--r-fg); background: var(--r-bg); }
  h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }
  p { margin: 0.8em 0; }
  img { max-width: 100%; height: auto; border-radius: 4px; }
  pre { background: var(--r-code); border: 1px solid var(--r-line); border-radius: 6px; padding: 12px 14px; overflow: auto; font-size: 0.8125em; line-height: 1.6; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; background: var(--r-code); padding: 1px 5px; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 0.875em; }
  th, td { border: 1px solid var(--r-line); padding: 6px 10px; text-align: left; }
  th { background: var(--r-code); }
  blockquote { margin: 1em 0; padding: 4px 16px; border-left: 3px solid var(--r-line); color: var(--r-muted); }
  a { color: var(--r-accent); }
  hr { border: none; border-top: 1px solid var(--r-line); margin: 2em 0; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`
}

/** 完整管线入口：扩展名分发 → 渲染 → 清洗 → 目录锚点 → 图片改写 → 包壳 */
export function buildReaderDoc(raw: string, ext: string, fileId: number, title: string): { html: string; toc: TocItem[] } {
  const extLower = ext.toLowerCase()
  const rendered = extLower === '.md' ? renderMarkdown(raw) : raw
  const clean = sanitizeHtml(rendered)
  const { html: anchored, toc } = extractToc(clean)
  const withAssets = rewriteAssetPaths(anchored, fileId)
  return { html: wrapReaderHtml(withAssets, title), toc }
}
