// I1 人侧对话桥梁（v0.1.5 PRD）：POST /api/chat SSE 流式问答 + 会话回放端点。
//
// 管线：领域陪练官 system prompt（aggregateDomainContext 画像 + 挂靠标签——与 MCP getContext 同一内核，
// 人侧角色背景与 agent 侧注入读到同一份领域画像）→ searchKnowledgeCore 检索 top-5
// → formatter 清洗拼入 user prompt（含词条 id 供引用）→ callLlm 生成。
// callLlm 为非流式接口（llm/index.ts 无流式通道，蒸馏链路共用），SSE 按 DELTA_CHUNK 块模拟流式：
// 完整回答一次性拿到后切块推送，块间不 sleep（本地回环无网络抖动，人为延迟只拖慢首屏）。
//
// SSE 事件协议（本端点为事件流约定，不走 { success } JSON 信封；其余端点仍守 { success } 约定）：
//   {type:'meta',     refs:[{id,title}]}               引用清单（id = files.id，前端跳 /reader/<id>；随 assistant 消息落库，
//                                                      存量旧消息由 GET /sessions/:id 回放时检索回填）
//   {type:'delta',    text}                            回答分块（约 40 字符/块，顺序拼接即完整回答）
//   {type:'done',     sessionId}                       正常结束（sessionId 供续会话）
//   {type:'fallback', results:[{id,title,summary}]}    LLM 失败降级：返回检索列表保可用，不落 assistant 消息
//   {type:'error',    message}                         管线异常（后随 end）
//
// 只读红线：除 chat_messages（对话留存）与 llm_call_logs（file_id=null，G1 成本视图自动计入）外
// 不写任何表、不改任何配置；检索/画像聚合均为只读查询。
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { getDb, ensureColumns } from '../db.js'
import { searchKnowledgeCore } from '../knowledge.js'
import { aggregateDomainContext, type DomainContext } from '../context.js'
import { cleanTitle, cleanSummary } from '../formatter.js'
import { getDefaultProvider, getDefaultModel, saveCallLog } from '../llm/llmClient.js'
import { callLlm } from '../llm/index.js'

export const chatRouter = Router()

type ChatLlmFn = (providerName: string, modelId: string, prompt: string, apiKey?: string) => Promise<{ text: string, usage?: { input?: number, output?: number } }>

// llmFn 注入点（对齐 hybrid.ts embedFn / profile/distill.ts llmFn 模式）：测试注入 fake 验证管线，不测网络
let chatLlmFn: ChatLlmFn = callLlm
export function setChatLlmFn(fn: ChatLlmFn) {
  chatLlmFn = fn
}

// I2 聊天复盘 llmFn 注入点（对齐 setChatLlmFn 模式）：测试注入 fake 验证落库链路，不测网络
let recapLlmFn: ChatLlmFn = callLlm
export function setRecapLlmFn(fn: ChatLlmFn) {
  recapLlmFn = fn
}

const SEARCH_TOP = 5
/** SSE 模拟流式的分块粒度（字符）：约一行中文的量级，肉眼可感知打字机效果 */
const DELTA_CHUNK = 40
/** 零命中放宽检索的返回条数（只给「最接近」信号，不给伪命中） */
const RELAXED_LIMIT = 3
/** 领域挂靠标签注入上限 */
const DOMAIN_TAG_LIMIT = 5

const SKILLS = ['explain', 'connect', 'quiz', 'overview'] as const
export type Skill = typeof SKILLS[number]

// callLlm 内部对服务商强制 response_format=json_object（SenseNova 蒸馏治理遗留），
// 自然语言回答需约定 JSON 信封再解包；非 JSON 原文按兜底原文返回（宽容解析，见 extractAnswer）。
const ENVELOPE_RULE = '输出格式：只输出一个 JSON 对象 {"answer":"给用户看的完整回答（可含换行）"}，不要代码围栏，不要多余解释。'

/** chat_messages 为 J1 批占位表（profile/aggregate.ts 运行时 IF NOT EXISTS 兜底建，DDL 两处同步）；同 DDL 幂等确保 + ensureColumns 幂等补列（红线 3，零破坏性迁移） */
async function ensureChatTable(db: SqliteDatabase) {
  await db.exec('CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, refs TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)')
  // refs：JSON 数组 [{id,title}] 与 SSE meta.refs 同构。NULL 只属于存量旧消息 = 待回填标记（回放时重建并写回）；'[]' = 确认无引用
  // ddl 为完整「列名 类型」串（对齐 db.ts 内 ensureColumns 调用惯例，曾误传裸 'TEXT' 建出同名垃圾列）
  await ensureColumns(db, 'chat_messages', [{ name: 'refs', ddl: 'refs TEXT' }])
}

/**
 * 领域陪练官 system prompt：domain 给定时注入画像（summaryText）+ 挂靠标签；
 * domain 缺省或域不存在时退通用助手人格，但同样锚定库内。导出供测试直测。
 */
export function buildChatSystemPrompt(
  domainName: string | undefined,
  domainCtx: DomainContext | null,
  domainTags: string[]
): string {
  if (domainName && domainCtx) {
    return [
      `你是 AgentFeed 的「${domainCtx.domainName}」领域陪练官，帮用户理解、消化并串联该领域的库内知识。`,
      '',
      '【领域画像】',
      domainCtx.summaryText,
      '',
      `【该领域挂靠标签】${domainTags.length ? domainTags.join('、') : '（暂无）'}`,
      '',
      '要求：回答须锚定库内知识；超出库内范围时如实说明，不要编造库内不存在的内容。用中文回答。',
    ].join('\n')
  }
  return [
    '你是 AgentFeed 知识库的人侧对话助手，帮用户在个人知识库中答疑、梳理与串联。',
    domainName ? `（当前选择领域「${domainName}」暂无可用画像，按通用助手作答）` : '',
    '',
    '要求：回答须锚定用户提供的库内资料；超出库内范围时如实说明，不要编造。用中文回答。',
  ].filter(Boolean).join('\n')
}

/**
 * 零命中放宽检索：从消息提取词元（拉丁/数字 ≥2 字符、CJK 连续段），任一 LIKE 命中即返回，
 * 单次查询防过度检索。仍零命中返回 []（上游如实告知库内无相关内容）。
 */
async function relaxedSearch(db: SqliteDatabase, message: string): Promise<any[]> {
  const tokens = [...new Set(
    (message.match(/[A-Za-z0-9_]{2,}|[\u4e00-\u9fff]+/g) || []).map(t => t.trim()).filter(t => t.length >= 2)
  )].slice(0, 3)
  if (tokens.length === 0) return []
  const like = tokens.map(() => `(f.title LIKE ? OR f.summary LIKE ?)`).join(' OR ')
  const params: any[] = []
  for (const t of tokens) params.push(`%${t}%`, `%${t}%`)
  return (await (await db.prepare(
    `SELECT f.id, f.title, f.summary FROM files f WHERE f.status = 'active' AND ${like} ORDER BY f.file_mtime DESC LIMIT ${RELAXED_LIMIT}`
  )).all(params)) as any[]
}

/** 通用问答 user prompt：检索结果（已过 formatter 出口清洗）+ 零命中如实声明分支 */
export function buildUserPrompt(message: string, rows: any[], zeroHit: boolean): string {
  const lines = rows.map((r, i) =>
    `- [${i + 1}] (id:${r.id}) ${cleanTitle(String(r.title ?? ''))}：${cleanSummary(String(r.summary ?? ''))}`
  )
  if (zeroHit) {
    return [
      '库内没有与该问题直接相关的内容（检索零命中）。最接近的词条如下（仅供参考，不代表直接答案）：',
      ...(lines.length ? lines : ['（放宽检索也未找到任何接近词条）']),
      '',
      `【用户问题】${message}`,
      '',
      '回答开头须如实说明「库内无直接相关内容」，再基于最接近词条给出有限的参考性说明（如有）；不得伪装库内有答案。',
    ].join('\n')
  }
  return [
    '【库内参考资料】（检索 top 结果，编号 [n] 与词条 id 供引用）',
    ...lines,
    '',
    `【用户问题】${message}`,
    '',
    '回答优先依据参考资料，可引用编号 [n]；资料不足以完整回答时如实说明。',
  ].join('\n')
}

export interface SkillContext {
  domainCtx: DomainContext | null
  /** explain 目标词条（fileId 可选；缺省时提示用户指定） */
  entry?: { fileId: number, title: string, summary: string } | null
  /** connect 近 10 条打开记录 */
  recentReads?: Array<{ fileId: number, title: string, domainName: string | null }>
}

/** 4 个内置 skill 的预设提示词模板（均注入当前 domain 上下文）。导出供测试直测。 */
export function buildSkillPrompt(skill: Skill, message: string, ctx: SkillContext): string {
  const domainBlock = ctx.domainCtx
    ? `\n【当前领域画像】\n${ctx.domainCtx.summaryText}\n`
    : '\n（用户未选择领域或该领域暂无画像）\n'
  if (skill === 'explain') {
    const e = ctx.entry
    return [
      '任务：向用户解释一篇库内词条——它讲了什么、为什么重要、与既有知识如何关联。',
      domainBlock,
      e
        ? `【目标词条】(id:${e.fileId}) ${e.title}\n【词条摘要】${e.summary || '（无摘要——基于标题与领域画像解释）'}`
        : '（未指定词条或词条不存在——请如实说明，并建议用户从词条列表或阅读器指定一篇）',
      '',
      `【用户留言】${message}`,
    ].join('\n')
  }
  if (skill === 'connect') {
    const reads = ctx.recentReads || []
    return [
      '任务：串联用户最近的阅读轨迹——指出这些内容的主题关联、递进关系与建议的下一步阅读方向。',
      domainBlock,
      '【最近打开记录】（近 10 条）',
      ...(reads.length
        ? reads.map((r, i) => `- [${i + 1}] (id:${r.fileId}) ${r.title}${r.domainName ? '（' + r.domainName + '）' : ''}`)
        : ['（暂无阅读记录——如实说明并建议先在阅读器打开几篇）']),
      '',
      `【用户留言】${message}`,
    ].join('\n')
  }
  if (skill === 'quiz') {
    const entries = ctx.domainCtx?.topEntries || []
    return [
      '任务：基于当前领域 top 词条要点出 3 道自测题（只出题不出答案，等用户作答后再评讲）。',
      domainBlock,
      '【出题素材】（当前领域 top 词条）',
      ...(entries.length
        ? entries.map((e, i) => `- [${i + 1}] (id:${e.fileId ?? '-'}) ${e.title}${e.summary ? '：' + e.summary.slice(0, 120) : ''}`)
        : ['（无领域词条——如实说明需先选择领域或先蒸馏词条）']),
      '',
      `【用户留言】${message}`,
    ].join('\n')
  }
  // overview：领域速览 = aggregateDomainContext 的 topEntries 列表化
  const entries = ctx.domainCtx?.topEntries || []
  return [
    '任务：给用户一段当前领域的速览——该领域覆盖什么、top 词条构成怎样的知识版图、建议从哪篇读起。',
    domainBlock,
    '【top 词条清单】',
    ...(entries.length
      ? entries.map((e, i) => `- [${i + 1}] (id:${e.fileId ?? '-'}) ${e.title}${e.summary ? '：' + e.summary.slice(0, 120) : ''}`)
      : ['（无词条——如实说明该领域暂无可注入词条）']),
    '',
    `【用户留言】${message}`,
  ].join('\n')
}

/**
 * LLM 回答解包：约定 {"answer":"..."} 信封（callLlm 强制 json_object）；宽容解析——
 * 围栏剥离、任意首个非空字符串字段兜底、非 JSON 原文原样返回（不因格式漂移丢回答）。
 */
export function extractAnswer(text: string): string {
  const t = String(text ?? '').trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const body = m ? m[1] : t
  try {
    const obj = JSON.parse(body)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (typeof obj.answer === 'string' && obj.answer.trim() !== '') return obj.answer
      const vals = Object.values(obj).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      if (vals.length > 0) return vals[0]
    }
  } catch { /* 非完整 JSON → 走截断信封兜底 */ }
  // 截断信封兜底：LLM 超 max_tokens 被截断时输出 {"answer":"... 无闭合 ——parse 必败；
  // 原文返回会把 {"answer":" 前缀泄漏到前端（I1 抽检实测发现）。剥前缀取余文（内部 \" 转义保留，可接受）
  const trunc = body.match(/^\{\s*"answer"\s*:\s*"([\s\S]*)$/)
  if (trunc) return trunc[1].replace(/\s*"?\s*\}[\s,]*$/, '')
  return t
}

function toRef(id: any, title: any): { id: number, title: string } {
  return { id: Number(id), title: cleanTitle(String(title ?? '')) }
}

/** 检索 + 零命中放宽：POST 实时问答与回放回填共用，保证回答中 [n] 编号与引用清单口径一致。
 * zeroHit = 主检索零命中（放宽前判定），供 prompt 如实声明「库内无直接相关内容」 */
async function searchWithRelax(db: SqliteDatabase, query: string): Promise<{ rows: any[], zeroHit: boolean }> {
  const rows = await searchKnowledgeCore(db, { query, limit: SEARCH_TOP })
  const zeroHit = rows.length === 0
  return { rows: zeroHit ? await relaxedSearch(db, query) : rows, zeroHit }
}

/**
 * POST / —— SSE 流式问答。body: { message, domain?, sessionId?, skill?, fileId? }
 * skill: explain（解释这篇，fileId 可选）/ connect（串联近 10 条阅读）/ quiz（领域自测题）/ overview（领域速览）
 */
chatRouter.post('/', async (req, res) => {
  const message = String(req.body?.message ?? '').trim()
  const domain = req.body?.domain != null && String(req.body.domain).trim() !== '' ? String(req.body.domain).trim() : undefined
  const skill = SKILLS.includes(req.body?.skill) ? req.body.skill as Skill : undefined
  const fileId = Number.isFinite(parseInt(req.body?.fileId)) ? parseInt(req.body.fileId) : undefined
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : randomUUID()
  if (!message) return res.status(400).json({ success: false, message: 'message 必填' })

  // SSE 头：no-transform 防中间层缓冲，X-Accel-Buffering 兼容反代
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (obj: any) => { res.write(`data: ${JSON.stringify(obj)}\n\n`) }

  try {
    const db = await getDb()
    await ensureChatTable(db)

    // 1) 领域陪练官上下文：画像 + 挂靠标签（domain 缺省走通用助手人格）
    let domainCtx: DomainContext | null = null
    let domainTags: string[] = []
    if (domain) {
      domainCtx = await aggregateDomainContext(domain)
      if (domainCtx) {
        const tagRows = await (await db.prepare(
          `SELECT name FROM tags WHERE domain_id = ? ORDER BY id LIMIT ${DOMAIN_TAG_LIMIT}`
        )).all([domainCtx.domainId]) as any[]
        domainTags = tagRows.map(r => String(r.name))
      }
    }
    const systemPrompt = buildChatSystemPrompt(domain, domainCtx, domainTags)

    // 2) 检索/取材 + 引用清单 + user prompt（skill 走预设模板，通用问答走检索管线）
    let refs: Array<{ id: number, title: string }> = []
    let userPrompt: string
    let searchRows: any[] = []

    if (skill === 'explain') {
      let entry: SkillContext['entry'] = null
      if (fileId != null) {
        const row = await (await db.prepare(`
          SELECT f.id AS file_id, COALESCE(NULLIF(w.title, ''), f.title, f.name) AS title,
                 COALESCE(w.summary, f.summary, '') AS summary
          FROM files f LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
          WHERE f.id = ? AND f.status = 'active'
        `)).get([fileId]) as any
        if (row) entry = { fileId: Number(row.file_id), title: String(row.title ?? ''), summary: String(row.summary ?? '') }
      }
      refs = entry ? [toRef(entry.fileId, entry.title)] : []
      userPrompt = buildSkillPrompt('explain', message, { domainCtx, entry })
    } else if (skill === 'connect') {
      const reads = await (await db.prepare(`
        SELECT f.id AS file_id, COALESCE(NULLIF(f.title, ''), f.name) AS title, d.name AS domain_name
        FROM read_history rh JOIN files f ON f.id = rh.file_id LEFT JOIN domains d ON d.id = f.domain_id
        WHERE f.status = 'active'
        ORDER BY rh.id DESC LIMIT 10
      `)).all() as any[]
      const recentReads = reads.map(r => ({
        fileId: Number(r.file_id), title: String(r.title ?? ''), domainName: r.domain_name == null ? null : String(r.domain_name)
      }))
      // 引用去重取前 5（同一文件反复打开只留一个 chip）
      const seen = new Set<number>()
      refs = recentReads.filter(r => (seen.has(r.fileId) ? false : seen.add(r.fileId)))
        .slice(0, SEARCH_TOP).map(r => toRef(r.fileId, r.title))
      userPrompt = buildSkillPrompt('connect', message, { domainCtx, recentReads })
    } else if (skill === 'quiz') {
      userPrompt = buildSkillPrompt('quiz', message, { domainCtx })
      refs = (domainCtx?.topEntries || []).filter(e => e.fileId != null).slice(0, SEARCH_TOP)
        .map(e => toRef(e.fileId, e.title))
    } else if (skill === 'overview') {
      // 领域速览没有领域 = 无从速览：不烧 LLM，如实作答（正常流式输出，仍双行落库）
      if (!domainCtx) {
        const hint = '请先在上方选择一个领域，再点「领域速览」——速览基于该领域的库内词条生成。'
        await insertChatMessage(db, sessionId, 'user', message)
        await insertChatMessage(db, sessionId, 'assistant', hint, '[]')
        send({ type: 'meta', refs: [] })
        for (let i = 0; i < hint.length; i += DELTA_CHUNK) send({ type: 'delta', text: hint.slice(i, i + DELTA_CHUNK) })
        send({ type: 'done', sessionId })
        res.end()
        return
      }
      userPrompt = buildSkillPrompt('overview', message, { domainCtx })
      refs = domainCtx.topEntries.filter(e => e.fileId != null).slice(0, SEARCH_TOP)
        .map(e => toRef(e.fileId, e.title))
    } else {
      const sr = await searchWithRelax(db, message)
      searchRows = sr.rows
      refs = searchRows.map(r => toRef(r.id, r.title))
      userPrompt = buildUserPrompt(message, searchRows, sr.zeroHit)
    }

    // 3) user 消息先行落库（用户问了什么永远留痕），引用清单先推（UI 尽早可点）
    await insertChatMessage(db, sessionId, 'user', message)
    send({ type: 'meta', refs })

    // 4) LLM 生成（非流式）→ SSE 模拟流式；失败降级 fallback（可用性优先，不落 assistant 消息）
    const provider = await getDefaultProvider()
    const model = await getDefaultModel()
    const prompt = [systemPrompt, '', userPrompt, '', ENVELOPE_RULE].join('\n')
    const t0 = Date.now()
    let answer: string
    try {
      const r = await chatLlmFn(provider, model, prompt)
      answer = extractAnswer(r.text)
      await saveCallLog({
        file_id: null,
        provider, model,
        prompt_tokens: r.usage?.input ?? null,
        completion_tokens: r.usage?.output ?? null,
        total_tokens: r.usage?.input != null && r.usage?.output != null ? Number(r.usage.input) + Number(r.usage.output) : null,
        duration_ms: Date.now() - t0,
        status: 'success',
      })
    } catch (e: any) {
      await saveCallLog({
        file_id: null, provider, model,
        duration_ms: Date.now() - t0,
        status: 'failed',
        error: String(e?.message || e),
      })
      send({ type: 'fallback', results: searchRows.map(r => ({
        id: Number(r.id), title: cleanTitle(String(r.title ?? '')), summary: cleanSummary(String(r.summary ?? ''))
      })) })
      res.end()
      return
    }

    // 5) 流式推送 + assistant 落库（含引用清单，回放可还原 chips）+ done（落库先于 done：客户端刷新会话列表时数据已就绪）
    for (let i = 0; i < answer.length; i += DELTA_CHUNK) send({ type: 'delta', text: answer.slice(i, i + DELTA_CHUNK) })
    await insertChatMessage(db, sessionId, 'assistant', answer, JSON.stringify(refs))
    send({ type: 'done', sessionId })
    res.end()
  } catch (e: any) {
    console.error('chat failed', e)
    send({ type: 'error', message: String(e?.message || e) })
    res.end()
  }
})

/** refsJson：引用清单 JSON 串（assistant 回答必传，'[]' = 确认无引用）；user 消息与复盘摘要等缺省 NULL */
async function insertChatMessage(db: SqliteDatabase, sessionId: string, role: string, content: string, refsJson: string | null = null) {
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content, refs) VALUES (?, ?, ?, ?)')).run([sessionId, role, content, refsJson])
}

/** 最近 20 个会话：session_id 聚合、首条 user 消息预览、最后活跃时间 */
chatRouter.get('/sessions', async (_req, res) => {
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const rows = await (await db.prepare(`
      SELECT session_id,
             (SELECT content FROM chat_messages u WHERE u.session_id = m.session_id AND u.role = 'user' ORDER BY u.id LIMIT 1) AS preview,
             COUNT(*) AS msg_count,
             MAX(created_at) AS last_at
      FROM chat_messages m
      GROUP BY session_id
      ORDER BY last_at DESC, MAX(m.id) DESC
      LIMIT 20
    `)).all() as any[]
    res.json({
      success: true,
      sessions: rows.map(r => ({
        sessionId: String(r.session_id),
        preview: r.preview ? cleanSummary(String(r.preview)) : '',
        msgCount: Number(r.msg_count),
        lastAt: r.last_at,
      })),
    })
  } catch (e: any) {
    console.error('chat sessions failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/**
 * 会话完整消息（时间正序），供前端回放。含存量引用回填：
 * refs IS NULL 的 assistant 消息（复盘除外）= 未落引用清单的旧消息——取其前最近一条 user 提问
 * 重跑检索（与实时管线同一 searchWithRelax，[n] 编号口径一致），按回答中 [n] 标记映射重建引用，
 * 结果写回该行（只重建一次，不重复烧检索/embeddings 外呼成本）。检索异常 fail-soft 跳过不阻塞回放。
 */
chatRouter.get('/sessions/:id', async (req, res) => {
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const rows = await (await db.prepare(
      'SELECT id, role, content, refs, created_at FROM chat_messages WHERE session_id = ? ORDER BY id'
    )).all([String(req.params.id)]) as any[]

    let lastUser = ''
    for (const r of rows) {
      if (r.role === 'user') { lastUser = String(r.content ?? ''); continue }
      if (r.refs != null || String(r.content ?? '').startsWith('[复盘]') || !lastUser.trim()) continue
      try {
        const { rows: hits } = await searchWithRelax(db, lastUser)
        // 只映射回答实际引用的编号：超界忽略（LLM 幻觉编号）、无 [n] 标记 → []（不再重试）
        const cited = new Set([...String(r.content ?? '').matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])))
        const rebuilt = hits
          .map((h, i) => ({ n: i + 1, ref: toRef(h.id, h.title) }))
          .filter(x => cited.has(x.n))
          .map(x => x.ref)
        const refsJson = JSON.stringify(rebuilt)
        await (await db.prepare('UPDATE chat_messages SET refs = ? WHERE id = ?')).run([refsJson, Number(r.id)])
        r.refs = refsJson
      } catch { /* 检索失败保持 NULL，fail-soft 不阻塞回放 */ }
    }

    res.json({
      success: true,
      messages: rows.map(r => {
        let refs: Array<{ id: number, title: string }> = []
        try { refs = r.refs ? JSON.parse(String(r.refs)) : [] } catch { refs = [] }
        return { id: Number(r.id), role: String(r.role), content: String(r.content ?? ''), createdAt: r.created_at, refs }
      }),
    })
  } catch (e: any) {
    console.error('chat session detail failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/**
 * I2 会话复盘：body { sessionId }——拉该会话全部消息 → LLM 生成「要点 + 建议待办」markdown 摘要，
 * 摘要作为一条 assistant 消息落 chat_messages（content 前缀 `[复盘] ` 即复盘标记）。
 * LLM 失败返回 { success:false } 不阻塞（failed 日志照落 llm_call_logs 供成本视图，但不落半成品消息）。
 */
chatRouter.post('/recap', async (req, res) => {
  const sessionId = req.body?.sessionId ? String(req.body.sessionId).trim() : ''
  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId 必填' })
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const rows = await (await db.prepare(
      'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id'
    )).all([sessionId]) as any[]
    if (!rows.length) return res.json({ success: false, message: '会话不存在或无消息' })

    const transcript = rows.map(r => `${r.role === 'user' ? '用户' : '助手'}：${String(r.content ?? '').replace(/^\[复盘\]\s*/, '（复盘）')}`).join('\n\n')
    const prompt = [
      '任务：对以下「用户 × 知识库助手」会话记录做复盘——提炼用户在关注什么、得到了哪些结论、下一步建议做什么。',
      '',
      '【会话记录】',
      transcript,
      '',
      '输出为 markdown：先「## 要点」列 N 条（每条一行、- 开头），再「## 建议待办」列 M 条（可执行动作）。用中文。',
      ENVELOPE_RULE,
    ].join('\n')

    const provider = await getDefaultProvider()
    const model = await getDefaultModel()
    const t0 = Date.now()
    let summary: string
    try {
      const r = await recapLlmFn(provider, model, prompt)
      summary = extractAnswer(r.text)
      await saveCallLog({
        file_id: null,
        provider, model,
        prompt_tokens: r.usage?.input ?? null,
        completion_tokens: r.usage?.output ?? null,
        total_tokens: r.usage?.input != null && r.usage?.output != null ? Number(r.usage.input) + Number(r.usage.output) : null,
        duration_ms: Date.now() - t0,
        status: 'success',
      })
    } catch (e: any) {
      await saveCallLog({
        file_id: null, provider, model,
        duration_ms: Date.now() - t0,
        status: 'failed',
        error: String(e?.message || e),
      })
      return res.json({ success: false, message: '复盘生成失败：' + String(e?.message || e) })
    }
    await insertChatMessage(db, sessionId, 'assistant', `[复盘] ${summary}`, '[]')
    res.json({ success: true, summary })
  } catch (e: any) {
    console.error('chat recap failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})
