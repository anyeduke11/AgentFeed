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
// 只读红线：除会话留存三表（chat_messages / chat_sessions 元数据 / chat_delete_logs 删除留痕）
// 与 llm_call_logs（file_id=null，G1 成本视图自动计入）外
// 不写任何表、不改任何配置；检索/画像聚合均为只读查询。
// 批次 B 磁盘写入：导出/蒸馏的 md 只落已启用扫描根内（resolveExportDir fail-closed），库内知识行仅经
// wiki importMarkdownFile 挂载入口写入（wiki_entries_meta + FTS，同 /import 内核）。
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SqliteDatabase } from '@homeofthings/sqlite3'
import { getDb, ensureColumns } from '../db.js'
import { searchKnowledgeCore } from '../knowledge.js'
import { aggregateDomainContext, type DomainContext } from '../context.js'
import { cleanTitle, cleanSummary } from '../formatter.js'
import { getDefaultProvider, getDefaultModel, saveCallLog } from '../llm/llmClient.js'
import { callLlm } from '../llm/index.js'
import { withinScanRoots } from './files.js'
import { importMarkdownFile } from './wiki.js'

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

// 批次 B 会话蒸馏 llmFn 注入点（同上模式）：把会话沉淀为知识词条 markdown，测试注入 fake 不测网络
let distillLlmFn: ChatLlmFn = callLlm
export function setDistillLlmFn(fn: ChatLlmFn) {
  distillLlmFn = fn
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

/** 会话三表惰性建（同 J1 占位模式；chat_sessions/chat_delete_logs DDL 与 PRD docs/chat-session-management-prd.md 一致）+ ensureColumns 幂等补列（红线 3，零破坏性迁移） */
async function ensureChatTable(db: SqliteDatabase) {
  await db.exec('CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, refs TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)')
  // refs：JSON 数组 [{id,title}] 与 SSE meta.refs 同构。NULL 只属于存量旧消息 = 待回填标记（回放时重建并写回）；'[]' = 确认无引用
  // ddl 为完整「列名 类型」串（对齐 db.ts 内 ensureColumns 调用惯例，曾误传裸 'TEXT' 建出同名垃圾列）
  await ensureColumns(db, 'chat_messages', [{ name: 'refs', ddl: 'refs TEXT' }])
  // 会话元数据基座（批次 A）：无行 = 老会话，读路径 LEFT JOIN 时按缺省兜底，PATCH/删除时按需补建
  await db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    domain TEXT,
    tags TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
  // 删除留痕：消息与元数据硬删，但删了什么（preview/msg_count/时间）永久可查
  await db.exec(`CREATE TABLE IF NOT EXISTS chat_delete_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT, preview TEXT, msg_count INTEGER,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
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
    // 会话元数据落基座（批次 A）：首问成 title、本次 domain 落标记；INSERT OR IGNORE——
    // 已有会话行不动（保留用户改过的 title/domain/tags），未带 domain 的续问不得抹掉已有标记
    await (await db.prepare('INSERT OR IGNORE INTO chat_sessions (session_id, title, domain) VALUES (?, ?, ?)'))
      .run([sessionId, message.slice(0, 60), domain ?? null])

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

function parseTagsJson(raw: any): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.filter((x: any) => typeof x === 'string') : []
  } catch { return [] }
}

/**
 * 最近 20 个会话：session_id 聚合 + chat_sessions 元数据 LEFT JOIN（老会话无行按缺省兜底，title 回退首问预览）。
 * 过滤：archived=1 归档视图（默认活跃）；q= 搜索（LIKE 命中 title/tags/domain/用户提问/消息正文）。
 */
chatRouter.get('/sessions', async (req, res) => {
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const params: any[] = [req.query.archived === '1' ? 1 : 0]
    let searchWhere = ''
    if (String(req.query.q ?? '').trim()) {
      const like = `%${String(req.query.q).trim()}%`
      searchWhere = `AND (
        s.title LIKE ? OR s.tags LIKE ? OR s.domain LIKE ?
        OR EXISTS (SELECT 1 FROM chat_messages uq WHERE uq.session_id = m.session_id AND uq.role = 'user' AND uq.content LIKE ?)
        OR EXISTS (SELECT 1 FROM chat_messages ac WHERE ac.session_id = m.session_id AND ac.content LIKE ?)
      )`
      params.push(like, like, like, like, like)
    }
    const rows = await (await db.prepare(`
      SELECT m.session_id AS session_id,
             s.title AS meta_title, s.domain AS meta_domain, s.tags AS meta_tags, s.archived AS meta_archived,
             (SELECT content FROM chat_messages u WHERE u.session_id = m.session_id AND u.role = 'user' ORDER BY u.id LIMIT 1) AS preview,
             COUNT(*) AS msg_count,
             MAX(m.created_at) AS last_at
      FROM chat_messages m
      LEFT JOIN chat_sessions s ON s.session_id = m.session_id
      WHERE COALESCE(s.archived, 0) = ?${searchWhere}
      GROUP BY m.session_id
      ORDER BY last_at DESC, MAX(m.id) DESC
      LIMIT 20
    `)).all(params) as any[]
    res.json({
      success: true,
      sessions: rows.map(r => ({
        sessionId: String(r.session_id),
        title: r.meta_title ? String(r.meta_title) : (r.preview ? cleanSummary(String(r.preview)).slice(0, 60) : ''),
        domain: r.meta_domain == null ? null : String(r.meta_domain),
        tags: parseTagsJson(r.meta_tags),
        archived: Number(r.meta_archived ?? 0) === 1,
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

/** 会话标记：PATCH title/domain/tags/archived 任意子集；元数据行缺失先按首问补建（老会话首次标记） */
chatRouter.patch('/sessions/:id', async (req, res) => {
  const sessionId = String(req.params.id || '').trim()
  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId 必填' })
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const exists = await (await db.prepare('SELECT 1 AS x FROM chat_sessions WHERE session_id = ?')).get([sessionId]) as any
    if (!exists) {
      const first = await (await db.prepare(
        "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1"
      )).get([sessionId]) as any
      await (await db.prepare('INSERT OR IGNORE INTO chat_sessions (session_id, title) VALUES (?, ?)'))
        .run([sessionId, first ? String(first.content ?? '').slice(0, 60) : sessionId])
    }
    const updates: string[] = []
    const params: any[] = []
    if (req.body?.title !== undefined) {
      const title = String(req.body.title).trim()
      if (!title || title.length > 80) return res.status(400).json({ success: false, message: 'title 须为 1~80 字符' })
      updates.push('title = ?'); params.push(title)
    }
    if (req.body?.domain !== undefined) {
      const d = String(req.body.domain).trim()
      if (d.length > 30) return res.status(400).json({ success: false, message: 'domain 超长（≤30）' })
      updates.push('domain = ?'); params.push(d || null)
    }
    if (req.body?.tags !== undefined) {
      if (!Array.isArray(req.body.tags)) return res.status(400).json({ success: false, message: 'tags 须为字符串数组' })
      const raw: string[] = req.body.tags.map((t: any) => String(t).trim()).filter(Boolean)
      const tags: string[] = [...new Set(raw)]
      if (tags.length > 20 || tags.some(t => t.length > 30)) return res.status(400).json({ success: false, message: 'tags 最多 20 项且每项 ≤30 字符' })
      updates.push('tags = ?'); params.push(JSON.stringify(tags))
    }
    if (req.body?.archived !== undefined) {
      updates.push('archived = ?'); params.push(req.body.archived ? 1 : 0)
    }
    if (!updates.length) return res.status(400).json({ success: false, message: '无可更新字段' })
    params.push(sessionId)
    await (await db.prepare(`UPDATE chat_sessions SET ${updates.join(', ')} WHERE session_id = ?`)).run(params)
    const row = await (await db.prepare('SELECT title, domain, tags, archived FROM chat_sessions WHERE session_id = ?')).get([sessionId]) as any
    res.json({
      success: true,
      session: {
        sessionId,
        title: row?.title ?? null,
        domain: row?.domain ?? null,
        tags: parseTagsJson(row?.tags),
        archived: Number(row?.archived ?? 0) === 1,
      },
    })
  } catch (e: any) {
    console.error('chat session patch failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 删除会话：消息 + 元数据硬删，删前落 chat_delete_logs 留痕；llm_call_logs 保留（成本审计，不挂 session） */
chatRouter.delete('/sessions/:id', async (req, res) => {
  const sessionId = String(req.params.id || '').trim()
  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId 必填' })
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const meta = await (await db.prepare(`
      SELECT (SELECT content FROM chat_messages u WHERE u.session_id = m.session_id AND u.role = 'user' ORDER BY u.id LIMIT 1) AS preview,
             COUNT(*) AS msg_count
      FROM chat_messages m WHERE m.session_id = ?
    `)).get([sessionId]) as any
    const msgCount = Number(meta?.msg_count ?? 0)
    if (msgCount > 0) {
      await (await db.prepare('INSERT INTO chat_delete_logs (session_id, preview, msg_count) VALUES (?, ?, ?)'))
        .run([sessionId, String(meta.preview ?? '').slice(0, 200), msgCount])
      await (await db.prepare('DELETE FROM chat_messages WHERE session_id = ?')).run([sessionId])
    }
    await (await db.prepare('DELETE FROM chat_sessions WHERE session_id = ?')).run([sessionId])
    res.json({ success: true, deletedMessages: msgCount })
  } catch (e: any) {
    console.error('chat session delete failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** 删除留痕查询：近 50 条（本期无 UI，端点先行供审计/后续视图） */
chatRouter.get('/deletions', async (_req, res) => {
  try {
    const db = await getDb()
    await ensureChatTable(db)
    const rows = await (await db.prepare(
      'SELECT session_id, preview, msg_count, deleted_at FROM chat_delete_logs ORDER BY id DESC LIMIT 50'
    )).all() as any[]
    res.json({
      success: true,
      deletions: rows.map(r => ({
        sessionId: String(r.session_id ?? ''),
        preview: String(r.preview ?? ''),
        msgCount: Number(r.msg_count ?? 0),
        deletedAt: r.deleted_at,
      })),
    })
  } catch (e: any) {
    console.error('chat deletions failed', e)
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

/* ---------------- 批次 B：会话 → 知识复利（导出 / 蒸馏入库） ---------------- */

/** 解析导出目录（红线 1：写盘目标必须落在已启用扫描根内，fail-closed）。优先级：入参 dir > config chat.exportDir > 首个启用扫描根下 conversations/。越界抛错 */
async function resolveExportDir(db: SqliteDatabase, dirOverride?: string): Promise<string> {
  let dir = String(dirOverride ?? '').trim()
  if (!dir) {
    const row = await (await db.prepare(`SELECT value FROM config WHERE key = 'chat.exportDir'`)).get() as any
    dir = String(row?.value ?? '').trim()
  }
  if (!dir) {
    const root = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1 ORDER BY id LIMIT 1')).get() as any
    if (!root?.path) throw new Error('无已启用扫描根：请先注册扫描根，或在设置中指定会话导出目录')
    dir = path.join(String(root.path), 'conversations')
  }
  const abs = path.resolve(dir)
  if (!(await withinScanRoots(db, abs))) throw new Error(`导出目录不在已启用扫描根内：${abs}`)
  return abs
}

/** 文件名安全 slug：路径分隔符/Windows 保留字符/空白折叠为连字符，截 40 字符 */
function slugifyFileBase(title: string): string {
  const base = String(title || '').replace(/[\\/:*?"<>|\s#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return base || '会话'
}

function stampNow(): string {
  return new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
}

/** 从 markdown 提取词条标题（首个 `# ` 行；对齐 wiki import 的解析口径），缺省回退会话 slug */
function markdownTitle(md: string, fallback: string): string {
  const m = String(md ?? '').split(/\r?\n/).find(l => l.startsWith('# '))
  // /^#\s+/ 结尾避用 *：`*/` 序列会被 esbuild 词法层误判为块注释关闭（724 行实测）
  const t = (m || '').replace(/^#\s+/, '').trim()
  return slugifyFileBase(t || fallback)
}

/** 加载会话导出素材：元数据（可缺省，老会话）+ 时间正序消息 */
async function loadSessionForExport(db: SqliteDatabase, sessionId: string) {
  await ensureChatTable(db)
  const meta = await (await db.prepare('SELECT title, domain, tags FROM chat_sessions WHERE session_id = ?')).get([sessionId]) as any
  const rows = await (await db.prepare('SELECT role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY id')).all([sessionId]) as any[]
  return { meta, rows }
}

/**
 * 纯导出 markdown：元数据行遵循 wiki import 的行内解析约定（来源行 / 标签行 #tag / 末行 最后更新），
 * 首段正文即词条摘要（import 解析口径），对话体时间正序原样保留。
 * （注释内禁写「星-星-斜杠」序列：块注释会被提前关闭——本行曾致 esbuild 语法错误）
 */
function buildTranscriptMarkdown(sessionId: string, meta: any, rows: any[]): string {
  const firstUser = rows.find(r => r.role === 'user')
  const title = meta?.title ? String(meta.title) : (firstUser ? String(firstUser.content ?? '').slice(0, 60) : '未命名会话')
  const tags = parseTagsJson(meta?.tags)
  const domain = meta?.domain == null ? '' : String(meta.domain)
  const tagNames = tags.length ? tags : (domain ? [domain] : [])
  // 单引号拼接：模板串内嵌裸反引号会提前终止（esbuild 语法错误的教训）
  const tagLine = tagNames.length ? '**标签**: ' + tagNames.map(t => '`#' + t + '`').join(' ') : '**标签**: （无）'
  const lines = [
    `# ${title}`,
    '',
    `**来源**: chat/${sessionId}`,
    '**置信度**: 会话导出',
    tagLine,
  ]
  if (domain) lines.push(`**领域**: ${domain}`)
  lines.push(
    '',
    `本篇由 AgentFeed 会话导出生成，沉淀 ${rows.length} 条消息的问答内容，时间正序完整保留。`,
    '',
    '## 对话记录',
    '',
    ...rows.map(r => `### ${r.role === 'user' ? '用户' : '助手'}\n\n${String(r.content ?? '')}\n`),
    `最后更新：${new Date().toISOString().slice(0, 10)}`,
  )
  return lines.join('\n')
}

/** AI 蒸馏：会话 → 结构化知识词条 markdown（遵循 import 解析约定）；失败抛错由调用方回退纯导出 */
async function distillSessionMarkdown(db: SqliteDatabase, sessionId: string, rows: any[]): Promise<string> {
  const transcript = rows.map(r => `${r.role === 'user' ? '用户' : '助手'}：${String(r.content ?? '')}`).join('\n\n')
  const prompt = [
    '任务：把以下「用户 × 知识库助手」会话沉淀为一篇可入库的知识词条 markdown。',
    '输出格式（严格遵守，不写代码围栏）：',
    '- 首行 `# 标题`：一句话概括会话沉淀的知识点（不带「会话」字样）',
    '- 随后元数据行：`**来源**: chat/' + sessionId + '`、`**置信度**: 会话蒸馏`、`**标签**: `#标签一` `#标签二``（2~5 个）',
    '- 然后第一段正文 = 2~3 句摘要（系统将取它作词条摘要），再分节整理会话中的知识点、结论与建议待办',
    '- 末行：`最后更新：' + new Date().toISOString().slice(0, 10) + '`',
    '',
    '【会话记录】',
    transcript,
    '',
    ENVELOPE_RULE,
  ].join('\n')
  const provider = await getDefaultProvider()
  const model = await getDefaultModel()
  const t0 = Date.now()
  const r = await distillLlmFn(provider, model, prompt)
  const md = extractAnswer(r.text).trim()
  if (!md.startsWith('# ')) throw new Error('蒸馏产物缺词条标题')
  await saveCallLog({
    file_id: null, provider, model,
    prompt_tokens: r.usage?.input ?? null,
    completion_tokens: r.usage?.output ?? null,
    total_tokens: r.usage?.input != null && r.usage?.output != null ? Number(r.usage.input) + Number(r.usage.output) : null,
    duration_ms: Date.now() - t0,
    status: 'success',
  })
  return md
}

/** GET /sessions/:id/export/preview——组装导出 markdown + 解析目标目录，不写盘。refined=1 走 AI 蒸馏（失败回退纯导出） */
chatRouter.get('/sessions/:id/export/preview', async (req, res) => {
  try {
    const db = await getDb()
    const sessionId = String(req.params.id || '').trim()
    const { meta, rows } = await loadSessionForExport(db, sessionId)
    if (!rows.length) return res.status(404).json({ success: false, message: '会话不存在或无消息' })
    const refined = req.query.refined === '1'
    let markdown = buildTranscriptMarkdown(sessionId, meta, rows)
    let refinedApplied = false
    if (refined) {
      try {
        markdown = await distillSessionMarkdown(db, sessionId, rows)
        refinedApplied = true
      } catch (e: any) {
        console.error('chat distill preview failed, fallback to transcript', e)
      }
    }
    const dir = await resolveExportDir(db, String(req.query.dir ?? ''))
    const fileName = `${markdownTitle(markdown, sessionId)}-${stampNow()}.md`
    res.json({ success: true, markdown, dir, fileName, refined: refinedApplied })
  } catch (e: any) {
    res.status(400).json({ success: false, message: String(e?.message || e) })
  }
})

/** 写导出文件（export 与 distill 共用）：目录 fail-closed 校验 + mkdir + 落盘；返回绝对路径 */
async function writeSessionExport(db: SqliteDatabase, sessionId: string, markdown: string, dirOverride?: string): Promise<string> {
  if (!String(markdown ?? '').trim()) throw new Error('markdown 必填')
  const dir = await resolveExportDir(db, dirOverride)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${markdownTitle(markdown, sessionId)}-${stampNow()}.md`)
  await fs.writeFile(filePath, markdown, 'utf8')
  return filePath
}

/** POST /sessions/:id/export——纯导出：markdown（可经前端编辑）落盘到导出目录，不入库 */
chatRouter.post('/sessions/:id/export', async (req, res) => {
  try {
    const db = await getDb()
    const filePath = await writeSessionExport(db, String(req.params.id || '').trim(), String(req.body?.markdown ?? ''), req.body?.dir)
    res.json({ success: true, path: filePath })
  } catch (e: any) {
    res.status(400).json({ success: false, message: String(e?.message || e) })
  }
})

/**
 * POST /sessions/:id/distill——蒸馏入库：落盘（同 export）→ 复用 wiki import 单文件挂载内核
 * （解析行内元数据 → 与库内文件比对 → wiki_entries_meta + FTS 同步）。already = 同路径已入库幂等跳过。
 */
chatRouter.post('/sessions/:id/distill', async (req, res) => {
  try {
    const db = await getDb()
    const markdown = String(req.body?.markdown ?? '')
    const filePath = await writeSessionExport(db, String(req.params.id || '').trim(), markdown, req.body?.dir)
    const mount = await importMarkdownFile(db, filePath)
    res.json({ success: mount.ok, path: filePath, match: mount.match, entryId: mount.entryId })
  } catch (e: any) {
    res.status(400).json({ success: false, message: String(e?.message || e) })
  }
})
