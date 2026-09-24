// 批次③：查询迷你语法解析器（Hister 查询语言的务实子集）。
// WHY：收件坪/agent 常见诉求是「按标题找」「排除噪声词」「精确短语」，此前只能靠
// 更换筛选器或自然语言碰运气。四个高频语法进检索内核，MCP 与 Web 共用同一解析：
//   title:xxx   → 只命中 title 含 xxx 的行（行后过滤）
//   tag:xxx     → 等价 tags 过滤（合并进 params.tags，复用既有 SQL 路）
//   "a b"       → 精确短语（引号内整体作为 query 词元，交给 FTS 短语/LIKE）
//   -word       → 排除词（title/summary/path 任一含 word 的行剔除）
// 别名（查询时改写，Hister aliases 同款）：config 键 search.aliases（JSON 对象），
// 词元命中别名键时展开为对应语法串再解析，如 {"gh": "tag:github"} → `gh 部署` = `tag:github 部署`。
// 纯函数无 DB 依赖；别名表由调用方（searchKnowledgeCore）读取注入。

export interface ParsedQuery {
  /** 剩余自由词 + 短语合并的检索串（交给三路混合） */
  query: string
  /** title: 过滤词（多个 AND 关系，行后过滤用） */
  title: string[]
  /** tag: 追加的标签（合并进 params.tags） */
  tags: string[]
  /** -排除词（行文本命中即剔除） */
  exclude: string[]
}

/** 词元切分：带引号短语的 shell 风格 split（"a b" 为一个词元；中文无空格整体保留） */
function tokenize(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of input.trim()) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (!inQuote && /\s/.test(ch)) { if (cur) out.push(cur); cur = '' }
    else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** 单词元归一：title:/tag: 前缀去掉引号残片；短语词元保引号语义由调用方还原为带空格原文 */
function normalize(token: string): string {
  return token.replace(/^["']+|["']+$/g, '')
}

/**
 * 解析查询串（先做别名展开）。
 * @param raw 原始 query（可能含语法词元与普通词）
 * @param aliases 别名表（key → 展开串，如 { gh: 'tag:github' }）；空表直通
 */
export function parseQuery(raw: string, aliases: Record<string, string> = {}): ParsedQuery {
  const tokens = tokenize(raw)
  const queryParts: string[] = []
  const title: string[] = []
  const tags: string[] = []
  const exclude: string[] = []
  const expanded = new Set<string>()  // 防环：别名自引用/互引（gh→gh、a→b→a）只展开一次

  for (const token of tokens) {
    // 别名命中：整词元精确匹配（不带前缀语法时才展开，避免 title:gh 被二次改写）
    if (!token.startsWith('-') && !token.includes(':') && aliases[token] && !expanded.has(token)) {
      expanded.add(token)
      for (const e of tokenize(aliases[token])) tokens.push(e)
      continue
    }
    if (token.startsWith('title:')) {
      const v = normalize(token.slice(6))
      if (v) title.push(v)
    } else if (token.startsWith('tag:')) {
      const v = normalize(token.slice(4))
      if (v) tags.push(v)
    } else if (token.startsWith('-') && token.length > 1) {
      exclude.push(normalize(token.slice(1)))
    } else {
      // 短语词元在 tokenize 时丢了引号信息——还原为原文（normalize 已剥引号，空格语义由查询端处理）
      queryParts.push(normalize(token))
    }
  }

  return { query: queryParts.join(' '), title, tags, exclude }
}

/** 排除词行过滤：title/summary/path 任一命中即剔除（大小写不敏感） */
export function rowMatchesExclude(row: any, exclude: string[]): boolean {
  if (!exclude.length) return false
  const hay = `${row.title || ''} ${row.summary || ''} ${row.path || ''}`.toLowerCase()
  return exclude.some(w => hay.includes(w.toLowerCase()))
}

/** title 行过滤：所有 title: 词都须命中（AND）。title 为空的行回退匹配 name/path（展示口径 title||name 同源），否则纯词条行会被全灭 */
export function rowMatchesTitle(row: any, title: string[]): boolean {
  if (!title.length) return true
  const t = String(row.title || row.name || row.path || '').toLowerCase()
  return title.every(w => t.includes(w.toLowerCase()))
}

/** 读取 search.aliases 配置（JSON 容错：坏值返回空表，检索不能因配置错误不可用） */
export function parseAliases(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v
      return out
    }
    return {}
  } catch { return {} }
}
