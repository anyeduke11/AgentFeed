// v0.1.5 A3：检索返回体可读性 formatter。
// WHY：语料中存在 title 长达 11 万字符的 JSON 脏数据（LLM 蒸馏原始输出直接落库），
// 直接透传会污染 Web 搜索、MCP search_knowledge 返回与日报选篇的展示与 token 预算。
// 本文件是纯函数出口层清洗：只改返回体，绝不回写库内任何表（wiki_entries_meta/files 保持原样）。
// 幂等设计：cleanTitle(cleanTitle(x)) === cleanTitle(x)，MCP 层双保险二次调用不产生漂移。

/** 超长输入先截断到 10 万字符再尝试 JSON 解析，避免对超大脏串的解析开销 */
const JSON_PROBE_LIMIT = 100000
/** title 硬上限：160 字符 + 省略号 = 161 */
const TITLE_LIMIT = 160
/** summary 展示口径：80 字符 + 省略号 */
const SUMMARY_LIMIT = 80
/** JSON 对象中的优先可读字段 */
const READABLE_KEYS = ['title', 'name', 'summary']

/**
 * JSON 脏串解析：先截断探测；截断天然破坏 JSON 结构（字符串体被切断），
 * 故截断失败且原文可完整解析时（现实脏 title 量级 11 万上下）再给一次全文机会；
 * 两次都失败返回 null = 回退原文走纯截断链。
 */
function parseJsonish(text: string): any | null {
  const probe = text.length > JSON_PROBE_LIMIT ? text.slice(0, JSON_PROBE_LIMIT) : text
  try {
    return JSON.parse(probe)
  } catch {
    if (probe === text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
}

/** 从解析结果取第一个可读字符串：READABLE_KEYS 优先，其次任意非空字符串值；递归一层（嵌套对象/数组下探一级） */
function extractReadable(value: any, depth: number): string | null {
  if (value == null || depth > 1) return null
  if (typeof value === 'string') return value.trim() !== '' ? value : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractReadable(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, any>
    for (const key of READABLE_KEYS) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v
    }
    for (const v of Object.values(obj)) {
      const hit = extractReadable(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** title 出口清洗：JSON 脏串提取可读字段 → 折叠空白 → 硬截断 160 + …（结果 ≤161 字符） */
export function cleanTitle(raw: string): string {
  let text = raw
  const first = text.charAt(0)
  if (first === '{' || first === '[') {
    const parsed = parseJsonish(text)
    if (parsed != null) {
      const readable = extractReadable(parsed, 0)
      if (readable) text = readable
    }
  }
  return truncate(collapseWhitespace(text), TITLE_LIMIT)
}

/** summary 出口清洗：折叠空白 → 截断 80 + …（现有摘要展示口径） */
export function cleanSummary(raw: string): string {
  return truncate(collapseWhitespace(raw), SUMMARY_LIMIT)
}
