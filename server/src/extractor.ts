import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import matter from 'gray-matter'
import * as cheerio from 'cheerio'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ExtractedMeta {
  title: string | null
  /** 展示用正式名称：title 优先，否则从正文提取第一个标题，兜底文件名（永不空） */
  alias: string
  date: string | null
  source: string | null
  contentText: string
  agent: string | null
}

function inferAgent(filePath: string, scanRoots: string[], frontmatterAgent?: string): string | null {
  if (frontmatterAgent) return frontmatterAgent
  const relative = scanRoots
    .map(r => {
      const p = r.replace(/\/$/, '')
      if (filePath.startsWith(p)) return filePath.slice(p.length + 1)
      return null
    })
    .filter(Boolean)[0]
  if (relative) {
    const parts = relative.split(path.sep)
    if (parts.length > 0) return parts[0]
  }
  return null
}

/** 元数据提取只读文件头部，避免超大文件整读导致内存峰值（contentText 下游本来就有截断） */
const HEAD_READ_LIMIT = 512 * 1024

async function readHead(filePath: string, limit: number = HEAD_READ_LIMIT): Promise<string> {
  const fh = await fs.open(filePath, 'r')
  try {
    const len = Math.min((await fh.stat()).size, limit)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    return buf.toString('utf-8')
  } finally {
    await fh.close()
  }
}

/** 行内清洗：去残留标签/实体/强调符号，折叠空白，限长（别名展示用） */
function cleanInline(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** 从文件头部文本提取正式名称（别名）：md 取 frontmatter 后第一个标题，html 取 <title>/<h1>；无则回退文件名 */
export function aliasFromText(ext: string, text: string, fallback: string): string {
  if (ext === '.md') {
    let t = text
    // 跳过 frontmatter 块，避免 YAML 注释行（# 开头）被误认为标题
    if (t.startsWith('---')) {
      const end = t.indexOf('\n---', 3)
      if (end !== -1) t = t.slice(t.indexOf('\n', end + 1) + 1)
    }
    const m = /^#{1,6}\s+(.+?)\s*$/m.exec(t)
    if (!m) return fallback
    const alias = cleanInline(m[1].replace(/\s*#+\s*$/, ''))
    return alias || fallback
  }
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]
    ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]
  if (raw === undefined) return fallback
  return cleanInline(raw) || fallback
}

/** 别名提取只读头部 8KB（标题/前导 frontmatter 不会太深），与元数据提取的 512KB 区分 */
const ALIAS_READ_LIMIT = 8 * 1024

/** 读取文件头部并提取别名；IO 失败由调用方兜底（回退文件名），不抛出阻断 */
export async function extractAliasFromFile(filePath: string, ext: string, fallback: string): Promise<string> {
  const text = await readHead(filePath, ALIAS_READ_LIMIT)
  return aliasFromText(ext, text, fallback)
}

export async function extractMd(filePath: string, scanRoots: string[]): Promise<ExtractedMeta> {
  const raw = await readHead(filePath)
  let parsed: { data: any; content: string }
  try {
    parsed = matter(raw)
  } catch {
    // frontmatter 被截断或格式非法时降级为纯文本处理
    parsed = { data: {}, content: raw }
  }
  const title = parsed.data?.title || parsed.data?.Title || null
  const date = parsed.data?.date || parsed.data?.Date || parsed.data?.created || null
  const agent = inferAgent(filePath, scanRoots, parsed.data?.agent)
  const contentText = parsed.content
    .replace(/^#+\s+.+$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_`~>\-|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  const alias = title || aliasFromText('.md', raw, path.basename(filePath))
  return { title, alias, date, source: null, contentText, agent }
}

export async function extractHtml(filePath: string, scanRoots: string[]): Promise<ExtractedMeta> {
  const raw = await readHead(filePath)
  const $ = cheerio.load(raw)
  const title = $('title').text().trim() || $('h1').first().text().trim() || null
  const date =
    $('meta[property="article:modified_time"]').attr('content') ||
    $('meta[name="date"]').attr('content') ||
    $('time').attr('datetime') ||
    null
  const source = $('meta[name="source"]').attr('content') || $('link[rel="canonical"]').attr('href') || null
  const agent = inferAgent(filePath, scanRoots)
  const contentText = $('body')
    .text()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50000)
  const alias = title || aliasFromText('.html', raw, path.basename(filePath))
  return { title, alias, date, source: source || null, contentText, agent }
}

export function getExtractor(ext: string) {
  return ext === '.md' ? extractMd : extractHtml
}
