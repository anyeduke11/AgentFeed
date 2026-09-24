// J1 用户画像·聚合统计包（纯本地，零外发）——蒸馏 LLM 调用前的信号预处理层。
// WHY 分层：隐私边界在此处收口——read_history/chat_messages/mcp_call_logs/exec_queue 四路信号
// 在本模块内聚合成「统计数字 + 标签权重」，离开本模块的只有统计包（无原始内容、无逐条记录），
// G2 外发披露口径 = 「聚合统计 + 上版画像」而非原始信号。I1/I3 未上线时对应信号自然为 0/null，
// 聚合不缺路——信号表存在即可跑，冷启动友好。
import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { MIN_DOMAIN_SIGNALS } from './model.js'

/** 标签权重：primary=1.0 / secondary=0.6 / normal=0.3（三态体系天然画像词表） */
const LEVEL_WEIGHT: Record<string, number> = { primary: 1.0, secondary: 0.6, normal: 0.3 }
/** 统计窗口缺省 30 天（画像反映近期倾向，不背永久史） */
export const DEFAULT_WINDOW_DAYS = 30
/** 每域 top 标签数 */
const TOP_TAGS_N = 5

export interface DomainSignal {
  domainId: number
  domainName: string
  /** read_history 打开次数（按文件 → domain 归并；无 domain 文件落 0 号桶不进 domains 列表） */
  reads: number
  /** mcp_call_logs 中该域词条被 search_knowledge/read_entry 触达的次数（proxy：关联 file 的词条） */
  agentCalls: number
  /** file_tags 聚合权重 top（标签三态加权 × 该域文件被读次数） */
  topTags: { name: string, weight: number }[]
  /** read_history.rating 均值（1-5）；无评分 null */
  avgRating: number | null
  /** exec_queue 完成率；队列空 null（I3 未上线阶段常态） */
  quizPassRate: number | null
  /** chat_messages 行数（I1 上线后复盘摘要计入；未上线 0） */
  chatMentions: number
  /** 置信度门槛分子：reads + agentCalls + chatMentions */
  signalsCount: number
  /** signalsCount >= MIN_DOMAIN_SIGNALS 才允许产 proficiency 断言（防早期瞎猜） */
  meetsThreshold: boolean
}

export interface ProfileSignalBundle {
  generatedAt: string
  windowDays: number
  domains: DomainSignal[]
  global: {
    totalReads: number
    totalAgentCalls: number
    avgRating: number | null
    quizPassRate: number | null
    totalChatMentions: number
    /** 全局 top 标签（跨域聚合） */
    topTags: { name: string, weight: number }[]
  }
}

/** 单日期边界（窗口起点，含）；SQLite datetime('now','-N days') 与本地时区一致性由 DB 侧保证 */
export async function buildProfileSignalBundle(
  db: SqliteDatabase,
  opts?: { windowDays?: number }
): Promise<ProfileSignalBundle> {
  const windowDays = opts?.windowDays && opts.windowDays > 0 ? Math.floor(opts.windowDays) : DEFAULT_WINDOW_DAYS

  // 域内读取次数 + 评分均值（read_history 关联 files.domain_id；窗口内）
  const readAgg = await (await db.prepare(`
    SELECT f.domain_id AS domain_id, COUNT(*) AS reads, AVG(rh.rating) AS avg_rating
    FROM read_history rh JOIN files f ON f.id = rh.file_id
    WHERE rh.opened_at >= datetime('now', ?) AND f.domain_id IS NOT NULL
    GROUP BY f.domain_id
  `)).all([`-${windowDays} days`]) as any[]

  // 域内 agent 消费密度：read_entry 按 args.id 精确归域（JSON 解析 → 词条 → 源文件）；
  // search_knowledge 的 args 只有 query 文本无词条指针，不猜域归属（v1 保守只计 read_entry）。
  // GROUP BY file_id 既去重占位符（防 IN 超 SQLite 变量上限）又保留调用次数口径
  const agentAgg = await (await db.prepare(`
    SELECT w.file_id AS file_id, COUNT(*) AS calls
    FROM mcp_call_logs m
    JOIN wiki_entries_meta w ON w.id = CAST(json_extract(m.args, '$.id') AS INTEGER)
    WHERE m.tool = 'read_entry' AND m.created_at >= datetime('now', ?)
    GROUP BY w.file_id
  `)).all([`-${windowDays} days`]) as any[]
  const fileIdToDomain = new Map<number, number>()
  if (agentAgg.length > 0) {
    const fileRows = await (await db.prepare(`
      SELECT id, domain_id FROM files WHERE id IN (${agentAgg.map(() => '?').join(',')}) AND domain_id IS NOT NULL
    `)).all(agentAgg.map(r => Number(r.file_id))) as any[]
    for (const f of fileRows) fileIdToDomain.set(Number(f.id), Number(f.domain_id))
  }
  const agentByDomain = new Map<number, number>()
  for (const r of agentAgg) {
    const d = fileIdToDomain.get(Number(r.file_id))
    if (d != null) agentByDomain.set(d, (agentByDomain.get(d) || 0) + Number(r.calls || 1))
  }

  // 域内标签权重：该域被读文件的 file_tags（三态加权），按出现计权
  const tagAgg = await (await db.prepare(`
    SELECT f.domain_id AS domain_id, t.name AS tag, t.level AS level, COUNT(*) AS n
    FROM read_history rh
    JOIN files f ON f.id = rh.file_id
    JOIN file_tags ft ON ft.file_id = f.id
    JOIN tags t ON t.id = ft.tag_id AND t.status = 'active'
    WHERE rh.opened_at >= datetime('now', ?) AND f.domain_id IS NOT NULL
    GROUP BY f.domain_id, t.id
  `)).all([`-${windowDays} days`]) as any[]
  const tagsByDomain = new Map<number, Map<string, number>>()
  for (const r of tagAgg) {
    const d = Number(r.domain_id)
    if (!tagsByDomain.has(d)) tagsByDomain.set(d, new Map())
    const w = (LEVEL_WEIGHT[String(r.level)] ?? LEVEL_WEIGHT.normal) * Number(r.n)
    tagsByDomain.get(d)!.set(String(r.tag), (tagsByDomain.get(d)!.get(String(r.tag)) || 0) + w)
  }

  // 域内复习完成率（exec_queue：done / (done+pending+dismissed)，窗口内 due）
  const quizAgg = await (await db.prepare(`
    SELECT f.domain_id AS domain_id, q.status AS status, COUNT(*) AS n
    FROM exec_queue q JOIN files f ON f.id = q.file_id
    WHERE q.due_at >= datetime('now', ?) AND f.domain_id IS NOT NULL
    GROUP BY f.domain_id, q.status
  `)).all([`-${windowDays} days`]) as any[]
  const quizByDomain = new Map<number, { done: number, total: number }>()
  for (const r of quizAgg) {
    const d = Number(r.domain_id)
    if (!quizByDomain.has(d)) quizByDomain.set(d, { done: 0, total: 0 })
    const e = quizByDomain.get(d)!
    e.total += Number(r.n)
    if (r.status === 'done') e.done += Number(r.n)
  }

  // 会话信号（I1 上线前 chat_messages 表可能不存在——先建空表占位，聚合不缺路且与 J1 表结构同批落地；
  // refs 列与 routes/chat.ts ensureChatTable DDL 同步，旧库由 chat 路由 ensureColumns 幂等补列）
  await db.exec('CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, refs TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)')
  const chatRows = await (await db.prepare('SELECT COUNT(*) AS n FROM chat_messages')).all() as any[]
  const totalChat = Number(chatRows[0]?.n || 0)

  // 域清单：读取/agent 任一出现的域都进 bundle（未出现域无信号，不产断言）
  const domainIds = new Set<number>([
    ...readAgg.map(r => Number(r.domain_id)),
    ...agentByDomain.keys()
  ])
  const domainNames = domainIds.size > 0
    ? await (await db.prepare(`SELECT id, name FROM domains WHERE id IN (${[...domainIds].map(() => '?').join(',')})`)).all([...domainIds]) as any[]
    : []
  const nameById = new Map(domainNames.map(d => [Number(d.id), String(d.name)]))

  const topN = (m: Map<string, number>): { name: string, weight: number }[] =>
    [...m.entries()].map(([name, weight]) => ({ name, weight: Math.round(weight * 100) / 100 }))
      .sort((a, b) => b.weight - a.weight).slice(0, TOP_TAGS_N)

  const domains: DomainSignal[] = [...domainIds].map(d => {
    const reads = readAgg.find(r => Number(r.domain_id) === d)
    const agentCalls = agentByDomain.get(d) || 0
    const quiz = quizByDomain.get(d)
    const chatMentions = 0 // I1 会话按域归属待上线（chat 无 domain 维度，v1 不猜）
    const signalsCount = Number(reads?.reads || 0) + agentCalls + chatMentions
    return {
      domainId: d,
      domainName: nameById.get(d) || `#${d}`,
      reads: Number(reads?.reads || 0),
      agentCalls,
      topTags: topN(tagsByDomain.get(d) || new Map()),
      avgRating: reads?.avg_rating != null ? Math.round(Number(reads.avg_rating) * 10) / 10 : null,
      quizPassRate: quiz && quiz.total > 0 ? Math.round((quiz.done / quiz.total) * 100) / 100 : null,
      chatMentions,
      signalsCount,
      meetsThreshold: signalsCount >= MIN_DOMAIN_SIGNALS
    }
  }).sort((a, b) => b.signalsCount - a.signalsCount)

  // 全局聚合
  const totalReads = domains.reduce((s, d) => s + d.reads, 0)
  const totalAgentCalls = domains.reduce((s, d) => s + d.agentCalls, 0)
  const rated = domains.filter(d => d.avgRating != null)
  const quizzed = domains.filter(d => d.quizPassRate != null)
  const globalTags = new Map<string, number>()
  for (const m of tagsByDomain.values()) for (const [k, v] of m) globalTags.set(k, (globalTags.get(k) || 0) + v)

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    domains,
    global: {
      totalReads,
      totalAgentCalls,
      avgRating: rated.length > 0 ? Math.round((rated.reduce((s, d) => s + (d.avgRating || 0), 0) / rated.length) * 10) / 10 : null,
      quizPassRate: quizzed.length > 0 ? Math.round((quizzed.reduce((s, d) => s + (d.quizPassRate || 0), 0) / quizzed.length) * 100) / 100 : null,
      totalChatMentions: totalChat,
      topTags: topN(globalTags)
    }
  }
}
