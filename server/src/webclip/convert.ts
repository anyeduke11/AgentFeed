import * as cheerio from 'cheerio'

export interface ImgRef { placeholder: string; absUrl: string; alt: string }

const IMG_LIMIT = 30

/**
 * 渲染后 HTML → Markdown。正文容器优先级 article > main > body；
 * 图片不下载，先落 __WEBCLIP_IMG_N__ 占位符由调用方替换（成功换相对路径，失败换 alt 降级文案）。
 */
export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string; images: ImgRef[] } {
  const $ = cheerio.load(html)
  const title = ($('title').text() || $('h1').first().text() || '').trim()
  let root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) root = $('body')
  root.find('script,style,nav,footer,aside,noscript,iframe,form,button,svg').remove()

  const images: ImgRef[] = []
  const lines: string[] = []

  // 图片处理：仅收集 http(s) 资源（data:/blob: 不本地化），落占位符由调用方替换；inline 与块级 walk 共用
  const renderImg = (n: any): string => {
    const src = $(n).attr('src') || ''
    const alt = ($(n).attr('alt') || '').trim()
    if (!src || images.length >= IMG_LIMIT) return ''
    try {
      const abs = new URL(src, baseUrl).href
      if (!/^https?:/i.test(abs)) return '' // data:/blob: 等不本地化
      const ph = `__WEBCLIP_IMG_${images.length}__`
      images.push({ placeholder: ph, absUrl: abs, alt })
      return `![${alt}](${ph})`
    } catch { return '' }
  }

  const inline = (el: any): string => {
    let out = ''
    $(el).contents().each((_, n: any) => {
      if (n.type === 'text') { out += $(n).text(); return }
      if (n.type !== 'tag') return
      const tag = String(n.tagName || '').toLowerCase()
      if (tag === 'strong' || tag === 'b') out += `**${inline(n).trim()}**`
      else if (tag === 'em' || tag === 'i') out += `*${inline(n).trim()}*`
      else if (tag === 'code') out += `\`${$(n).text()}\``
      else if (tag === 'br') out += '  \n'
      else if (tag === 'a') {
        const href = $(n).attr('href') || ''
        let abs = ''
        try { abs = href ? new URL(href, baseUrl).href : '' } catch { abs = '' }
        const t = inline(n).trim()
        out += abs && t ? `[${t}](${abs})` : t
      } else if (tag === 'img') {
        out += renderImg(n)
      } else out += inline(n)
    })
    return out
  }

  const walk = (el: any) => {
    $(el).children().each((_, n: any) => {
      if (n.type !== 'tag') return
      const tag = String(n.tagName || '').toLowerCase()
      if (/^h[1-6]$/.test(tag)) lines.push(`${'#'.repeat(Number(tag[1]))} ${inline(n).trim()}`, '')
      else if (tag === 'p') { const t = inline(n).trim(); if (t) lines.push(t, '') }
      else if (tag === 'img') { const ph = renderImg(n); if (ph) lines.push(ph, '') } // 顶层裸图（不在 p 内）
      else if (tag === 'li') lines.push(`- ${inline(n).trim()}`)
      else if (tag === 'ul' || tag === 'ol') { walk(n); lines.push('') }
      else if (tag === 'pre') lines.push('```', $(n).text().replace(/\n$/, ''), '```', '')
      else if (tag === 'blockquote') lines.push(...$(n).text().trim().split('\n').map((l: string) => `> ${l}`), '')
      else if (tag === 'hr') lines.push('---', '')
      else if (tag === 'table') { const t = $(n).text().replace(/\s+/g, ' ').trim(); if (t) lines.push(t, '') } // M1 表格纯文本化
      else walk(n)
    })
  }
  walk(root.get(0))

  let markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!markdown) markdown = `# ${title || '无正文'}\n\n（未能从页面提取正文）`
  return { title, markdown: markdown + '\n', images }
}

/** html 快照改写：下载成功的图换相对路径（阅读器 asset 代理可离线加载），失败的移除 src、alt 文本顶替 */
export function rewriteSnapshot(html: string, baseUrl: string, map: Map<string, string>): string {
  const $ = cheerio.load(html)
  $('img').each((_, el) => {
    const src = $(el).attr('src') || ''
    let abs = ''
    try { abs = src ? new URL(src, baseUrl).href : '' } catch { abs = '' }
    const rel = abs ? map.get(abs) : undefined
    if (rel) { $(el).attr('src', rel); return }
    const alt = ($(el).attr('alt') || '').trim()
    if (alt) $(el).replaceWith(`[${alt}]`)
    else $(el).remove()
  })
  return $.html()
}
