import * as cheerio from 'cheerio'

export interface ImgRef { placeholder: string; absUrl: string; alt: string }

const IMG_LIMIT = 30

/** 图片质量过滤配置（微信文章宣传图剔除）：词表/阈值全部可配，无命中信号的图默认保留（不误杀） */
export interface ImgFilterConfig {
  enabled: boolean
  /** 任一维小于该像素数 → 图标类丢弃（仅当 HTML 有显式尺寸属性才判） */
  minPx: number
  /** 宽高比超过该值 → 横幅丢弃（仅当两维都已知才判） */
  maxRatio: number
  /** 下载后小于该字节数 → 像素点级，按失败路径降级 alt（router 侧执行） */
  minBytes: number
  /** URL 含任一关键词（小写包含）→ 丢弃：二维码 / 水印 / logo 等 */
  urlKeywords: string[]
  /** alt/title 含任一关键词 → 丢弃：关注引导 / 引流话术等 */
  altKeywords: string[]
}

/** 从 img 节点解析显式尺寸：width/height 属性 + data-w（微信正文惯例）+ style 内 width/height。返回 null = 无任何尺寸信号（不猜） */
function parseImgSize(el: any): { w?: number; h?: number } | null {
  const num = (s: string | undefined): number | undefined => {
    if (!s) return undefined
    const m = String(s).match(/^(\d+(?:\.\d+)?)/)
    const n = m ? Number(m[1]) : NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  let w = num(el.attribs?.width)
  let h = num(el.attribs?.height)
  const dw = num(el.attribs?.['data-w'])
  if (dw !== undefined && w === undefined) w = dw
  const style = String(el.attribs?.style || '')
  const sw = style.match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i)
  const sh = style.match(/(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/i)
  if (sw && w === undefined) w = Number(sw[1])
  if (sh && h === undefined) h = Number(sh[1])
  return (w !== undefined || h !== undefined) ? { w, h } : null
}

/** 单图过滤裁决：true = 丢弃。只依据正向信号（词表命中 / 显式尺寸越界），无信号一律保留 */
export function shouldDropImage(el: any, absUrl: string, alt: string, f: ImgFilterConfig): boolean {
  if (!f.enabled) return false
  const loUrl = absUrl.toLowerCase()
  if (f.urlKeywords.some(k => k && loUrl.includes(k.toLowerCase()))) return true
  const text = (alt + ' ' + String(el.attribs?.title || '')).toLowerCase()
  if (f.altKeywords.some(k => k && text.includes(k.toLowerCase()))) return true
  const size = parseImgSize(el)
  if (size) {
    if (size.w !== undefined && size.w < f.minPx) return true
    if (size.h !== undefined && size.h < f.minPx) return true
    if (size.w !== undefined && size.h !== undefined && size.w / size.h > f.maxRatio) return true
  }
  return false
}

/**
 * 渲染后 HTML → Markdown。正文容器优先级 article > main > body；
 * 图片不下载，先落 __WEBCLIP_IMG_N__ 占位符由调用方替换（成功换相对路径，失败换 alt 降级文案）。
 */
export function htmlToMarkdown(html: string, baseUrl: string, imgLimit = IMG_LIMIT, imgFilter?: ImgFilterConfig): { title: string; markdown: string; images: ImgRef[] } {
  const $ = cheerio.load(html)
  const title = ($('title').text() || $('h1').first().text() || '').trim()
  let root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) root = $('body')
  root.find('script,style,nav,footer,aside,noscript,iframe,form,button,svg').remove()

  const images: ImgRef[] = []
  const lines: string[] = []

  // 图片处理：仅收集 http(s) 资源（data:/blob: 不本地化），落占位符由调用方替换；inline 与块级 walk 共用
  // imgFilter 命中（二维码/横幅/图标等宣传噪声）→ 整图跳过：不产占位符不下载（html 快照不受影响，md 才是净化版）
  const renderImg = (n: any): string => {
    const src = $(n).attr('src') || ''
    const alt = ($(n).attr('alt') || '').trim()
    if (!src || images.length >= imgLimit) return ''
    try {
      const abs = new URL(src, baseUrl).href
      if (!/^https?:/i.test(abs)) return '' // data:/blob: 等不本地化
      if (imgFilter && shouldDropImage(n, abs, alt, imgFilter)) return ''
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
