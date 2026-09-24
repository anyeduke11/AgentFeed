import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { getProviders, getDefaultModel, saveCallLog, updateFileLlmState, type LlmProvider } from './llmClient.js'
import { getModelsInstance, callLlm, supportsVision, type LlmImage } from './index.js'
import { failoverChain, reportNodeResult } from './distillNodes.js'
import { ensureTag } from './tagGovernance.js'
import { processProfileJob } from '../profile/distill.js'
import { syncWikiFts } from '../search/ftsIndex.js'
import { indexWikiChunks } from '../search/chunkEmbed.js'
import type { LlmJob } from './llmQueue.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const WIKI_DIR = path.join(DATA_DIR, 'wiki', 'entries')

async function md5(filePath: string): Promise<string> {
  const hash = crypto.createHash('md5')
  const stream = await fs.open(filePath, 'r')
  const chunkSize = 64 * 1024
  while (true) {
    const buf = Buffer.alloc(chunkSize)
    const { bytesRead } = await stream.read(buf)
    if (bytesRead === 0) break
    hash.update(buf.slice(0, bytesRead))
  }
  await stream.close()
  return hash.digest('hex')
}

/** 读取文件头部 ≤512KB 原始字节：蒸馏内容读取与 triage 预算预估共用（读失败返回空 Buffer，不阻塞调用方） */
export async function readFileHead(filePath: string): Promise<Buffer> {
  const CAP = 512 * 1024
  try {
    const fh = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(CAP)
      const { bytesRead } = await fh.read(buf, 0, CAP, 0)
      return buf.slice(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch (e) {
    return Buffer.alloc(0)
  }
}

async function readFileSafe(filePath: string): Promise<string> {
  // 只读头部 512KB：超大文件整读有 OOM 风险，蒸馏只需要头部内容
  const head = await readFileHead(filePath)
  return head.toString('utf8') + (head.length >= 512 * 1024 ? '\n...(已截断)' : '')
}

function summarizeContent(content: string, maxChars = 4000): string {
  const cleaned = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxChars) return cleaned
  return cleaned.slice(0, maxChars) + '...'
}

/* ---------- 方案 A：结构感知压缩（2026-09-22 残留 12% 分析：51-102KB 超长文件 prompt 超限救赎） ---------- */

/** 中英混合保守估算：中文 ≈1.5-2 字/token、英文 ≈4-5 字符/token，取 2.2 chars/token 偏保守（宁早压缩不爆上下文） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.2)
}

/** 压缩产物字符上限（32K+ 大窗口模型的兜底上限；8K 窗口实际由 compressMaxChars 按预算收紧） */
const COMPRESS_TARGET_CHARS = 12 * 1024

/** 保守默认上下文窗口（tokens）：与 index.ts ensureModelDef 的 contextWindow: 8192 对齐（单一事实源）。
 *  旧值 32768 是失配根源——sensenova/agnes flash 级网关实测 8K，压缩触发线被高估 4 倍，
 *  8K~34K chars 文件裸送超窗被 1-token 拒答（存量 4018 篇 failed 主因）；config ai.modelContextTokens 可覆盖 */
const DEFAULT_CONTEXT_WINDOW = 8192

/** 蒸馏输入 token 预算 = 上下文窗口 − 输出 maxTokens(2048，蒸馏产物 ≈1500 + 余量) − 指令+领域名单(≈600) − 安全余量(1024) */
export async function distillInputBudgetTokens(): Promise<number> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'ai.modelContextTokens'")).get() as any
  const ctx = row && Number(row.value) > 0 ? Number(row.value) : DEFAULT_CONTEXT_WINDOW
  return ctx - 2048 - 600 - 1024
}

/** 压缩产物字符预算 = 输入 token 预算 × 2.2（estimateTokens 的反向换算），上限 COMPRESS_TARGET_CHARS。
 *  旧恒 12K chars ≈ 5.5K tokens 的产物在 8K 窗口 − 2048 输出下装不下——产物本身即超窗源之一，
 *  必须随窗口动态 sizing。下限 2000 防极端小预算把采样切碎。 */
export function compressMaxChars(inputBudgetTokens: number): number {
  return Math.min(COMPRESS_TARGET_CHARS, Math.max(2000, Math.floor(inputBudgetTokens * 2.2)))
}

interface Section { heading: string; body: string }

/** 按标题行切节：md `#`~`######` 与 html `<h1>`~`<h6>`（含属性、跨行内文），首标题前的引导段落自成节 */
function splitSections(body: string): Section[] {
  const re = /^(#{1,6}[ \t]+.+|<h[1-6](?:\s[^>]*)?>[\s\S]*?<\/h[1-6]>)\s*$/gim
  const marks: Array<{ start: number; end: number; heading: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) marks.push({ start: m.index, end: m.index + m[0].length, heading: m[0].trim() })
  if (marks.length === 0) return [{ heading: '', body }]
  const sections: Section[] = []
  if (marks[0].start > 0) sections.push({ heading: '', body: body.slice(0, marks[0].start) })
  for (let i = 0; i < marks.length; i++) {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : body.length
    sections.push({ heading: marks[i].heading, body: body.slice(marks[i].end, bodyEnd) })
  }
  return sections
}

/** 分节采样：首段承论点、末段承总结（教案/PRD 结构保真），HTML 标签剥除省字符 */
function sampleSectionBody(body: string, budget: number): string {
  if (budget <= 0) return ''
  const paras = body.split(/\n{2,}/)
    .map(p => p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (paras.length === 0) return ''
  if (budget < 300) return paras[0].slice(0, budget)
  // 首段取段首（论点）、末段取段尾（总结在段尾，末节的段尾即全文终点）；单段同取头尾不整段偏食
  // （活体验证 file 3427 末节 966 字单段曾因只取段首丢掉全文思考题结论）
  const first = paras[0].slice(0, Math.floor(budget * 0.65))
  const last = paras[paras.length - 1].slice(-(budget - first.length))
  return first === last ? first : first + '\n' + last
}

/**
 * 结构感知压缩：51-102KB 教案/PRD 全量进 prompt（≈2.5-5 万 tokens）超多数网关上下文，
 * flash 与 pro 均 1-token 拒答（归因报告 §7 形态 B）。旧 summarizeContent 头部截断丢中后部结论；
 * 此法保全部标题骨架 + 每节首末段采样，无标题退化均匀滑窗（覆盖首/中/尾），输出恒 ≤ maxChars。
 */
export function compressForDistill(content: string, maxChars = COMPRESS_TARGET_CHARS): string {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  const frontmatter = fm ? fm[0].slice(0, 1000) : ''
  const body = fm ? content.slice(fm[0].length) : content

  let parts: string[]
  const sections = splitSections(body)
  if (sections.length === 1 && !sections[0].heading) {
    // 无标题退化：全篇均匀滑窗采样（不做头部截断，中后部结论不丢）
    const text = sections[0].body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const winCount = Math.max(1, Math.floor((maxChars - frontmatter.length - 400) / 350))
    const step = Math.max(1, Math.floor(text.length / winCount))
    parts = []
    for (let i = 0; i < winCount; i++) {
      // 末窗锚定文尾：滑窗若按步进走到头会停在倒数第二窗，结论段（文末）恰好落在窗外
      const start = i === winCount - 1 ? Math.max(0, text.length - 300) : i * step
      if (start >= text.length) break
      parts.push(`[片段${i + 1}] ${text.slice(start, start + 300)}`)
    }
  } else {
    // 骨架全保留，剩余预算按节数均摊（单节上限 450 字，防标题稀疏的长节独占）
    const headsChars = sections.reduce((s, x) => s + x.heading.length + 1, 0)
    const perSection = Math.min(450, Math.max(0, Math.floor((maxChars - frontmatter.length - headsChars) / sections.length)))
    parts = sections.map(s => {
      const sampled = sampleSectionBody(s.body, perSection)
      if (s.heading) return sampled ? `${s.heading}\n${sampled}` : s.heading
      return sampled
    }).filter(Boolean)
  }
  const compressed = (frontmatter ? frontmatter + '\n\n' : '') + parts.join('\n\n')
  const note = '（原文超长，以下为结构化采样压缩：保留全部标题骨架，每节取首末段要点）\n\n'
  // 末道防线：极端标题数量下骨架本身可能超预算，硬截断保上限
  return note + (compressed.length > maxChars ? compressed.slice(0, maxChars) : compressed)
}

/* ---------- 视觉蒸馏：提取文档内嵌本地图片随消息发送（OCR/视觉模型专用） ---------- */

/** 图片扩展名 → MIME（范围外扩展名一律跳过） */
const IMG_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}
/** 单次蒸馏最多附图数（防 token 爆炸，与 512KB 文本截断同一防护思路） */
const MAX_IMAGES = 3
/** 单张图片原始字节上限 2MB（base64 后约 2.7MB） */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** 严格边界：target 必须等于某根或位于根目录之下（裸 startsWith 会误放行兄弟目录，如 /roots/foo vs /roots/foobar） */
function withinRoots(target: string, roots: string[]): boolean {
  return roots.some(r => target === r || target.startsWith(r + path.sep))
}

/**
 * 提取文档内嵌本地图片引用：HTML <img src> + Markdown ![]()；远程/data URL 跳过，上限 limit 张。
 * allowedRoots 提供时仅放行落在任一根内的路径（fail-closed：文档内容不可信，
 * 绝对路径或 ../ 逃逸到扫描根外的引用一律丢弃，防止任意文件读取随 base64 外发）。
 */
export function extractLocalImageRefs(content: string, baseDir: string, limit = MAX_IMAGES, allowedRoots?: string[]): string[] {
  const refs: string[] = []
  const re = /<img[^>]*\ssrc=["']([^"']+)["']|!\[[^\]]*\]\(([^)\s]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null && refs.length < limit) {
    const raw = (m[1] || m[2] || '').trim()
    if (!raw || /^(https?:|data:|\/\/)/i.test(raw)) continue
    let decoded = raw
    try { decoded = decodeURIComponent(raw.split('#')[0]) } catch { /* 保留原串 */ }
    const abs = path.isAbsolute(decoded) ? decoded : path.resolve(baseDir, decoded)
    if (allowedRoots && !withinRoots(abs, allowedRoots)) continue
    if (!IMG_MIME[path.extname(abs).toLowerCase()]) continue
    refs.push(abs)
  }
  return refs
}

/** 读取文档内嵌图片转 base64：缺失/超限/格式不符的图片跳过，不阻塞蒸馏 */
export async function loadImagesForPrompt(content: string, baseDir: string, allowedRoots?: string[]): Promise<LlmImage[]> {
  const images: LlmImage[] = []
  for (const abs of extractLocalImageRefs(content, baseDir, MAX_IMAGES, allowedRoots)) {
    const mime = IMG_MIME[path.extname(abs).toLowerCase()]
    try {
      const st = await fs.stat(abs)
      if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) continue
      const buf = await fs.readFile(abs)
      images.push({ data: buf.toString('base64'), mimeType: mime })
    } catch { /* 单图失败不影响整体 */ }
    if (images.length >= MAX_IMAGES) break
  }
  return images
}

async function buildPrompt(filePath: string, content: string, domainNames: string[], inputBudgetTokens: number, forceCompress = false): Promise<string> {
  const stat = await fs.stat(filePath).catch(() => null)
  const size = stat?.size ?? content.length
  // 方案 A（2026-09-22 残留 12%）：旧字节阈值(>100KB 才压)放走了 51-102KB 档——全量进 prompt
  // ≈2.5-5 万 tokens 超多数网关上下文被 1-token 拒答。改为 token 预算判定：预估超预算 60%
  // 即结构化压缩，产物按 compressMaxChars 随窗口动态 sizing（8K 窗口下 ≈3.4K tokens 安全区）。
  // forceCompress：content_too_long 自愈重试用——同一内容已实测超窗，无判定必要直接压。
  const maxChars = compressMaxChars(inputBudgetTokens)
  const effective = forceCompress || estimateTokens(content) > inputBudgetTokens * 0.6 ? compressForDistill(content, maxChars) : content
  const fileName = path.basename(filePath)
  const domainHint = domainNames.length > 0 ? `\n可选领域（从中选一个最匹配的，都没有合适则留空）：${domainNames.join('、')}` : ''
  // 输出预算（H1 修法②，2026-09-22）：长输入是截断失败的主形态（归因报告 §6-A）——大文档要求大 JSON
  // 会中途被截断成无闭合残缺 JSON。5KB+ 输入收紧指令：summary 上限 200 字、points 最多 6 条，
  // 从源头把输出体积压进安全区（实测失败样本 82% 为 5-50KB .md）。
  const budget = size > 5000
    ? '\n注意：内容较长，请严格控制输出体积——summary 不超过 200 字，points 最多 6 条且每条一句话，entities 最多 8 个，relations 最多 5 条。宁可精炼，禁止截断式长输出。'
    : ''
  return `请为以下知识文件生成结构化 wiki 词条。输出 JSON：{"title":"","summary":"2-3 句摘要","points":["3-6 条关键要点，每条一句话"],"entities":[{"n":"名称","t":"类型"}],"relations":[{"a":"主体","v":"关系动词","b":"客体","note":"备注"}],"domain":"","tags":["2-4 个主题标签"]}。${budget}\ndomain 必须从给出的可选领域列表中选择；tags 是自由主题词。${domainHint}\n文件：${fileName}\n内容：\n${effective}`
}

function sanitizeSensitive(text: string): string {
  const patterns = [
    /(?:sk|api_key|apikey|token|secret|password)\s*[:=]\s*[^\s"\',]+/gi,
    /(?:https?:\/\/[^@\n]+@)[^\s]+/gi,
    /(?:Bearer\s+)[^\s]+/gi,
    /(?:password|pwd|passwd)\s*[:=]\s*[^\s"\',]+/gi
  ]
  let out = text
  for (const re of patterns) {
    out = out.replace(re, '[REDACTED]')
  }
  return out
}

function safeParseWikiJson(text: string): {
  title: string
  summary: string
  points: string[]
  entities: Array<{ n: string; t: string }>
  relations: Array<{ a: string; v: string; b: string; note?: string }>
  domain: string
  tags: string[]
} {
  // H1 修法①（2026-09-22 归因 §6-A）：长输出截断产生无闭合 } 的残缺 JSON，原正则 \{[\s\S]*\} 要求
  // 成对匹配必败 → 74% file 重试死循环。宽容提取三段式：
  // ① 有闭合 }：原行为（最后一个 } 之前）——完整 JSON
  // ② 无闭合：先试补尾修复（截断发生在末字符串值内时 `"}` 可闭合）
  // ③ 仍败：逐字段正则提取 `"key":"value"` 对（title/summary 常在截断前已完整输出）
  // 部分字段达标（title 或 summary 非空）即算可用——宁缺 points，不整单作废。
  const parseObj = (body: string): Record<string, any> | null => {
    try { return JSON.parse(body) as Record<string, any> } catch { return null }
  }
  let obj: Record<string, any> | null = null
  const closed = text.match(/\{[\s\S]*\}/)
  if (closed) obj = parseObj(closed[0])
  if (!obj) {
    const open = text.indexOf('{')
    if (open >= 0) {
      const tail = text.slice(open)
      obj = parseObj(tail + '"}')
      if (!obj) {
        // ③ 截断在数组/嵌套中段：补尾救不回，逐字段扫描顶层字符串键值对
        const out: Record<string, any> = {}
        for (const m of tail.matchAll(/"(title|summary|domain)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          out[m[1]] = m[2]
        }
        if (out.title || out.summary) obj = out
      }
    }
  }
  if (!obj) return { title: '', summary: '', points: [], entities: [], relations: [], domain: '', tags: [] }
  const title = String(obj.title || '').trim()
  const summary = String(obj.summary || '').trim()
  const points = Array.isArray(obj.points) ? obj.points.filter((p: any) => typeof p === 'string' && p.trim()).map(String) : []
  const entities = Array.isArray(obj.entities)
    ? obj.entities.filter((e: any) => e && typeof e === 'object' && typeof e.n === 'string').map((e: any) => ({ n: e.n, t: typeof e.t === 'string' ? e.t : '' }))
    : []
  const relations = Array.isArray(obj.relations)
    ? obj.relations.filter((r: any) => r && typeof r === 'object' && typeof r.a === 'string' && typeof r.b === 'string')
        .map((r: any) => ({ a: r.a, v: typeof r.v === 'string' ? r.v : '相关', b: r.b, note: typeof r.note === 'string' ? r.note : undefined }))
    : []
  const domain = typeof obj.domain === 'string' ? obj.domain.trim() : ''
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t: any) => typeof t === 'string' && t.trim()).map((t: any) => String(t).trim()).slice(0, 4) : []
  return { title, summary, points, entities, relations, domain, tags }
}

/* ---------- triage 熔断：按需精选批次的连续失败保护（内存态，重启自动清零） ---------- */

/** 连续失败达到该次数即熔断：坏 provider 系统性故障时继续消费只会空转烧 token，把损失钉在阈值内 */
const TRIAGE_FAIL_LIMIT = 5
let triageConsecutiveFails = 0
let triageTripped = false

/** 一次 triage job 落定后更新计数：成功清零，连续失败达阈值置位（只统计 origin='triage' 的批次） */
function recordTriageResult(success: boolean) {
  if (success) {
    triageConsecutiveFails = 0
    return
  }
  triageConsecutiveFails++
  if (triageConsecutiveFails >= TRIAGE_FAIL_LIMIT) triageTripped = true
}

/** 熔断状态查询（入队端点据此拒绝新批次） */
export function getTriageBreakerState(): { tripped: boolean; consecutiveFailures: number } {
  return { tripped: triageTripped, consecutiveFailures: triageConsecutiveFails }
}

/** 手动复位熔断（端点 resetTripped: true 时调用） */
export function resetTriageBreaker() {
  triageTripped = false
  triageConsecutiveFails = 0
}

export async function processJob(job: LlmJob): Promise<void> {
  // 熔断期间暂停消费 triage 批次（job 被静默丢弃，普通蒸馏/assess/curate/backfill/embed 不受影响）
  if (job.options?.origin === 'triage' && getTriageBreakerState().tripped) return
  const type = job.options?.type || 'distill'
  if (type === 'assess') return processAssess(job)
  if (type === 'curate') return processCurate(job)
  if (type === 'backfill') return processBackfill(job)
  if (type === 'profile') return processProfileJob(job)
  return processDistill(job)
}

/** distill：原蒸馏流程（生成 wiki 词条 + 自动标注） */
async function processDistill(job: LlmJob): Promise<void> {
  const db = await getDb()
  await updateFileLlmState(db, job.fileId, 'running')

  const started = Date.now()
  let status: 'success' | 'failed' | 'timeout' | 'rate_limited' = 'failed'
  let error: string | undefined
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let totalTokens: number | undefined
  // 实际使用的节点（轮换后可能与 job 首选不同），落库用
  let usedProvider = job.provider
  let usedModel = job.model
  // 网关 finish_reason 原文（配套修复③）：失败分桶区分截断/拒答形态
  let stopReason: string | undefined

  try {
    const providers = await getProviders()
    const provider = providers.find(p => p.name === job.provider) || providers[0]
    if (!provider) {
      throw new Error('no_llm_provider')
    }

    const fileStmt = await db.prepare('SELECT path FROM files WHERE id = ?')
    const fileRow = await fileStmt.get(job.fileId) as any
    const filePath = fileRow?.path || job.prompt
    const content = await readFileSafe(filePath)
    const sanitized = sanitizeSensitive(content)
    // 领域名单：自动归类时 LLM 只能从已有领域中选择，避免其自创领域污染分拣体系
    const domainRows = await (await db.prepare('SELECT name FROM domains')).all() as any[]
    const domainNames = domainRows.map(r => r.name)
    const modelId = job.model || await getDefaultModel()
    // 视觉模型（OCR 等）：提取文档内嵌本地图片随消息发送；文本模型保持纯文本（发图会被服务端拒绝）
    // 附图边界：只允许源文件所在扫描根内的图片（文档内容不可信，越界引用一律丢弃）
    const rootRows = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')).all() as any[]
    const scanRoots = rootRows.map(r => String(r.path)).filter(Boolean)
    const images = supportsVision(modelId) ? await loadImagesForPrompt(content, path.dirname(filePath), scanRoots) : []
    const inputBudget = await distillInputBudgetTokens()
    const prompt = await buildPrompt(filePath, sanitized, domainNames, inputBudget)
      + (images.length ? `\n（附件：该文件内嵌图片 ${images.length} 张，请结合图片内容一并蒸馏）` : '')

    // 调用 + 解析自愈循环（P2 精炼失败根治）：content_too_long_for_model 是确定性失败
    // （实测 prompt 8944 tokens / completion 1 / stop_reason=length——模型把预算耗在输入上，
    // 输出 1 token 即被掐断），同 prompt 重试物理上必然复现，存量 4018 篇 failed 即此死积压。
    // 自愈 = 换输入：强制结构化压缩重建 prompt 重试一次；压缩后仍败则落终态（换模型/调窗口是用户侧动作）。
    let llmResult: Awaited<ReturnType<typeof callLlmWithFallback>> | undefined
    let wiki: ReturnType<typeof safeParseWikiJson> | undefined
    for (let pass = 0; pass < 2 && !wiki; pass++) {
      const r = pass === 0
        ? await callLlmWithFallback(provider, modelId, prompt, images)
        : await callLlmWithFallback(provider, modelId, await buildPrompt(filePath, sanitized, domainNames, inputBudget, true)
          + (images.length ? `\n（附件：该文件内嵌图片 ${images.length} 张，请结合图片内容一并蒸馏）` : ''), images)
      const w = safeParseWikiJson(r.text)
      if (w.title || w.summary || w.points.length > 0) {
        llmResult = r
        wiki = w
        break
      }
      // H1 修法①（2026-09-22 归因 §6-B）：flash 级模型对超长 prompt 常回 1-token 短拒答——
      // 内容性失败报 content_too_long（非 not_json）；仅它值得换输入自愈，not_json 属非确定性失败走既有重试机制
      const short = (r.completionTokens ?? r.text.length) < 200
      if (pass > 0 || !short) throw new Error(short ? 'content_too_long_for_model' : 'llm_output_not_json')
    }
    if (!llmResult || !wiki) throw new Error('llm_output_not_json')
    usedProvider = llmResult.usedProvider
    usedModel = llmResult.usedModel
    stopReason = llmResult.stopReason

    promptTokens = llmResult.promptTokens
    completionTokens = llmResult.completionTokens
    totalTokens = (promptTokens || 0) + (completionTokens || 0)

    const entryDir = path.join(WIKI_DIR, String(job.fileId))
    await fs.mkdir(entryDir, { recursive: true })

    // 词条标题：LLM 生成优先，退回源文件的别名/标题/文件名（写入 wiki_entries_meta.title，不覆盖 files.title 以保留原始标题）
    const fr = await (await db.prepare('SELECT title, name, alias FROM files WHERE id = ?')).get(job.fileId) as any
    const entryTitle = String(wiki.title || fr?.alias || fr?.title || fr?.name || '').replace(/'/g, "''")
    const title = entryTitle
    const pointsMd = wiki.points.length > 0 ? '\n\n## 关键要点\n\n' + wiki.points.map((p, i) => `${i + 1}. ${p}`).join('\n') : ''
    const entryMd = `# ${title}\n\n${wiki.summary || sanitized.slice(0, 2000)}${pointsMd}\n`
    await fs.writeFile(path.join(entryDir, 'entry.md'), entryMd)
    await fs.writeFile(path.join(entryDir, 'points.json'), JSON.stringify(wiki.points, null, 2))

    if (wiki.entities.length > 0) {
      await fs.writeFile(path.join(entryDir, 'entities.json'), JSON.stringify(wiki.entities, null, 2))
    }
    if (wiki.relations.length > 0) {
      await fs.writeFile(path.join(entryDir, 'relations.json'), JSON.stringify(wiki.relations, null, 2))
    }

    // 同步摘要回 files 表
    if (wiki.summary) {
      await db.exec(`UPDATE files SET summary = '${String(wiki.summary).replace(/'/g, "''")}' WHERE id = ${job.fileId}`)
    }

    const metaStmt = await db.prepare('SELECT id FROM wiki_entries_meta WHERE file_id = ?')
    const metaRow = await metaStmt.get(job.fileId) as any
    if (!metaRow) {
      await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, entities_count, distilled_at, title) VALUES (${job.fileId}, '${String(path.join(entryDir, 'entry.md')).replace(/'/g, "''")}', ${wiki.entities.length}, CURRENT_TIMESTAMP, '${entryTitle}')`)
    } else {
      await db.exec(`UPDATE wiki_entries_meta SET title = '${entryTitle}', entities_count = ${wiki.entities.length}, distilled_at = CURRENT_TIMESTAMP WHERE file_id = ${job.fileId}`)
    }

    // Wave 1 挂点：蒸馏写入/更新词条后同步检索索引（FTS 关键词 + 分块向量）。
    // best-effort：索引失败只记日志不阻断蒸馏主流程（INSERT 场景按 file_id 取回刚写的 meta id）
    try {
      const metaIdRow = metaRow ?? ((await (await db.prepare('SELECT id FROM wiki_entries_meta WHERE file_id = ?')).get(job.fileId)) as any)
      if (metaIdRow) {
        await syncWikiFts(db, Number(metaIdRow.id))
        await indexWikiChunks(db, Number(metaIdRow.id))
      }
    } catch (e) {
      console.error('wiki search index sync failed', e)
    }

    // 自动标注：领域（仅匹配已有领域）+ 标签（find-or-create），source='llm'
    if (wiki.domain) {
      const matched = domainNames.find(n => n === wiki.domain)
      if (matched) {
        const dRow = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get(matched) as any
        if (dRow) await db.exec(`UPDATE files SET domain_id = ${dRow.id} WHERE id = ${job.fileId}`)
      }
    }
    for (const tag of wiki.tags) {
      // ensureTag：已合并的旧标签自动跟随指向，避免再产生重复变体
      const tagId = await ensureTag(db, tag)
      if (tagId) {
        await db.exec(`INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES (${job.fileId}, ${tagId}, 'llm')`)
      }
    }

    status = 'success'
  } catch (e: any) {
    status = 'failed'
    error = String(e?.message || e)
  } finally {
    const durationMs = Date.now() - started
    await saveCallLog({
      file_id: job.fileId,
      provider: usedProvider,
      model: usedModel,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      duration_ms: durationMs,
      status,
      error,
      stop_reason: stopReason ?? null
    })
    await updateFileLlmState(db, job.fileId, status === 'success' ? 'done' : 'failed')
    // triage 批次熔断统计：只统计带 origin='triage' 标记的 job，普通 push 蒸馏的成败不进计数。
    // H1 补丁（2026-09-22 治愈验证）：content_too_long_for_model 是内容性拒答（completion≈1、零 token 成本、
    // 换样本才有救），不属于「坏 provider 系统性故障」——计入连败会让候选头部的超长文件扎堆拒答时
    // 误触熔断，把同批可救样本一并腰斩（实测 50 篇批次仅跑 13 篇即被拦）。拒答对连败计数保持中性。
    if (job.options?.origin === 'triage' && error !== 'content_too_long_for_model') {
      recordTriageResult(status === 'success')
    }
    // 方案 A（向量冗余收敛第一步，2026-09-24）：file 级向量停写——蒸馏成功已在上方 indexWikiChunks
    // 自动生成 chunk 向量（检索主路），file 级 title+summary 向量 93.4% 与之语义重叠且不服务任何
    // 真实检索路径（唯一消费方是设置页验证小工具，已切 chunk 主路）。存量 36.5k 行冻结只读，
    // 彻底收敛（DROP + 口径迁移）待 P2 内存索引定型后执行。
    // if (status === 'success') { enqueueEmbed(job.fileId) }
  }
}

/** 可轮换错误：限流/服务端/网络类——换节点重试有意义；参数类错误（400/404 模型不存在）换家也没用 */
function isFailoverableError(msg: string): boolean {
  return /429|rate.?limit|tpm|rpm|5\d\d|timeout|timed?\s?out|fetch failed|network|econn|socket|abort|empty_llm_response/i.test(msg)
}

/**
 * 跨节点轮换调用：首选节点失败且属可轮换错误时，换池内下一个健康节点重试（最多 3 跳）。
 * - 每次尝试结果被动上报节点健康（失败进入 60s 冷却，让其他节点接管）
 * - 池未启用任何节点时退化为仅首选（行为与单模型一致）
 * - 返回实际使用的 provider/model（落库与展示用，可能与 job 首选不同）
 */
async function callLlmWithFallback(provider: LlmProvider, modelId: string, prompt: string, images?: LlmImage[]): Promise<{ text: string; promptTokens?: number; completionTokens?: number; stopReason?: string; usedProvider: string; usedModel: string }> {
  const providers = await getProviders()
  const chain = failoverChain(provider.name, modelId)
    .map(n => ({ p: providers.find(x => x.name === n.provider), model: n.model }))
    .filter(s => !!s.p)
  if (!chain.length) chain.push({ p: provider, model: modelId })
  const attempts: string[] = []
  let lastErr: any
  for (const step of chain) {
    try {
      const text = await callLlm(step.p!.name, step.model, prompt, step.p!.apiKey, images)
      reportNodeResult(step.p!.name, step.model, true)
      const usage = (text as any).usage as { input?: number; output?: number } | undefined
      return { text: text.text, promptTokens: usage?.input, completionTokens: usage?.output, stopReason: text.stopReason, usedProvider: step.p!.name, usedModel: step.model }
    } catch (e: any) {
      const msg = String(e?.message || e)
      lastErr = e
      reportNodeResult(step.p!.name, step.model, false, msg)
      attempts.push(`${step.p!.name}/${step.model}: ${msg.slice(0, 80)}`)
      if (!isFailoverableError(msg)) break
    }
  }
  const tail = attempts.length > 1 ? `（已轮换：${attempts.join(' → ')}）` : ''
  throw new Error(`${String(lastErr?.message || lastErr)}${tail}`)
}

/** assess：单篇理由升级——入池时的规则理由替换为内容化推荐语（不动 files.llm_state） */
async function processAssess(job: LlmJob): Promise<void> {
  const db = await getDb()
  const started = Date.now()
  let status: 'success' | 'failed' = 'failed'
  let error: string | undefined
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let usedProvider = job.provider
  let usedModel = job.model

  try {
    const providers = await getProviders()
    const provider = providers.find(p => p.name === job.provider) || providers[0]
    if (!provider) throw new Error('no_llm_provider')

    const fileRow = await (await db.prepare('SELECT path, title, name FROM files WHERE id = ?')).get(job.fileId) as any
    if (!fileRow) throw new Error('file_not_found')
    const rec = await (await db.prepare('SELECT id FROM recommendations WHERE file_id = ?')).get(job.fileId) as any
    if (!rec) {
      // 已移出推荐池，无需升级
      status = 'success'
      return
    }

    const content = summarizeContent(sanitizeSensitive(await readFileSafe(fileRow.path)), 1500)
    const prompt = `为知识库文章写一句中文推荐语（40 字内），说明为什么值得人读、能收获什么。只输出 JSON：{"reason":"推荐语"}。\n标题：${fileRow.title || fileRow.name}\n内容开头：\n${content}`
    const modelId = job.model || await getDefaultModel()
    const r = await callLlmWithFallback(provider, modelId, prompt)
    usedProvider = r.usedProvider
    usedModel = r.usedModel
    promptTokens = r.promptTokens
    completionTokens = r.completionTokens

    const match = String(r.text).match(/\{[\s\S]*\}/)
    const reason = match ? String(JSON.parse(match[0]).reason || '').trim() : ''
    if (reason) {
      await db.exec(`UPDATE recommendations SET reason = '${reason.replace(/'/g, "''")}', reason_source = 'llm' WHERE file_id = ${job.fileId}`)
    }
    status = 'success'
  } catch (e: any) {
    error = String(e?.message || e)
  } finally {
    await saveCallLog({
      file_id: job.fileId,
      provider: usedProvider,
      model: usedModel,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: (promptTokens || 0) + (completionTokens || 0),
      duration_ms: Date.now() - started,
      status,
      error
    })
  }
}

/** curate：批量策展——已蒸馏 Top30 一次调用挑 10 篇，写入推荐池（entry_source='curated'） */
async function processCurate(job: LlmJob): Promise<void> {
  const db = await getDb()
  const started = Date.now()
  let status: 'success' | 'failed' = 'failed'
  let error: string | undefined
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let usedProvider = job.provider
  let usedModel = job.model

  try {
    const providers = await getProviders()
    const provider = providers.find(p => p.name === job.provider) || providers[0]
    if (!provider) throw new Error('no_llm_provider')

    const rows = await (await db.prepare(`
      SELECT f.id, COALESCE(NULLIF(f.title, ''), f.name) AS title, d.name AS domain_name,
             w.quality_score, COALESCE(f.rule_score, 0) AS rule_score, COALESCE(w.summary, '') AS summary
      FROM files f
      LEFT JOIN domains d ON f.domain_id = d.id
      LEFT JOIN wiki_entries_meta w ON w.file_id = f.id
      WHERE f.status = 'active' AND f.llm_state = 'done'
      ORDER BY (w.quality_score IS NOT NULL) DESC, COALESCE(w.quality_score, 0) DESC,
               COALESCE(f.rule_score, 0) DESC, COALESCE(f.size, 0) DESC
      LIMIT 30`)).all() as any[]
    if (!rows.length) throw new Error('no_distilled_files')

    const list = rows.map(r =>
      `${r.id}. ${r.title}（${r.domain_name || '未分类'}${r.quality_score ? `，AI 质量分 ${r.quality_score}` : ''}）：${String(r.summary).slice(0, 60)}`
    ).join('\n')
    const prompt = `以下 ${rows.length} 篇知识库文章（编号即 id）。挑出恰好 10 篇最值得安全行业工程师细读践行的，每篇给一句中文推荐语（30 字内，说清选它的理由）。只输出 JSON：{"picks":[{"id":数字,"reason":"推荐语"}]}，id 必须来自列表。\n${list}`
    const modelId = job.model || await getDefaultModel()
    const r = await callLlmWithFallback(provider, modelId, prompt)
    usedProvider = r.usedProvider
    usedModel = r.usedModel
    promptTokens = r.promptTokens
    completionTokens = r.completionTokens

    const match = String(r.text).match(/\{[\s\S]*\}/)
    const picks: any[] = match ? (JSON.parse(match[0]).picks || []) : []
    const byId = new Map(rows.map(r => [r.id, r]))
    let applied = 0
    for (const p of picks.slice(0, 10)) {
      const cand = byId.get(parseInt(p?.id))
      const reason = String(p?.reason || '').trim()
      if (!cand || !reason) continue
      const score = Number(cand.quality_score || 0) * 3 + Number(cand.rule_score || 0)
      const escReason = reason.replace(/'/g, "''")
      const existing = await (await db.prepare('SELECT id, reason_source FROM recommendations WHERE file_id = ?')).get(cand.id) as any
      if (!existing) {
        await db.exec(`INSERT INTO recommendations (file_id, score, reason, reason_source, entry_source)
          VALUES (${cand.id}, ${score}, '${escReason}', 'llm', 'curated')`)
        applied++
      } else if (existing.reason_source !== 'manual') {
        await db.exec(`UPDATE recommendations SET score = ${score}, reason = '${escReason}', reason_source = 'llm', created_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
        applied++
      }
    }
    console.log(`llm curate: applied ${applied}/10 picks`)
    status = 'success'
  } catch (e: any) {
    error = String(e?.message || e)
  } finally {
    await saveCallLog({
      file_id: null,
      provider: usedProvider,
      model: usedModel,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: (promptTokens || 0) + (completionTokens || 0),
      duration_ms: Date.now() - started,
      status,
      error
    })
  }
}

/** 解析 LLM 质量分输出：接受 quality_score/score 键，钳位 0~10 保留 1 位小数；无法解析返回 null */
export function parseQualityScore(text: string): number | null {
  try {
    const match = String(text).match(/\{[\s\S]*\}/)
    if (!match) return null
    const obj = JSON.parse(match[0]) as Record<string, any>
    const v = Number(obj.quality_score ?? obj.score)
    if (!Number.isFinite(v)) return null
    return Math.round(Math.max(0, Math.min(10, v)) * 10) / 10
  } catch {
    return null
  }
}

/** 回填进度计数：单条 SQL 原子自增（键由触发端点预置，缺行时不生效——进度端点按 0 兜底） */
async function bumpBackfillCounter(db: any, key: string) {
  await db.exec(`UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = CURRENT_TIMESTAMP WHERE key = '${key}'`)
}

/** backfill：质量分补齐——给已蒸馏但缺 quality_score 的单篇补分（priority=0 与蒸馏同级不插队；不动 files.llm_state） */
async function processBackfill(job: LlmJob): Promise<void> {
  const db = await getDb()
  const started = Date.now()
  let status: 'success' | 'failed' = 'failed'
  let error: string | undefined
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let usedProvider = job.provider
  let usedModel = job.model

  try {
    const providers = await getProviders()
    const provider = providers.find(p => p.name === job.provider) || providers[0]
    if (!provider) throw new Error('no_llm_provider')

    const fileRow = await (await db.prepare('SELECT path, title, name FROM files WHERE id = ?')).get(job.fileId) as any
    if (!fileRow) throw new Error('file_not_found')
    const meta = await (await db.prepare('SELECT id FROM wiki_entries_meta WHERE file_id = ?')).get(job.fileId) as any
    if (!meta) throw new Error('no_meta_row')

    const content = summarizeContent(sanitizeSensitive(await readFileSafe(fileRow.path)), 1500)
    // 无有效内容：记 failed 跳过，不重试堵队列（PRD 异常流）
    if (!content.trim()) throw new Error('no_valid_content')

    const prompt = `为以下知识库文章的质量打分（0~10，整数或一位小数）：内容完整、结构清晰、可实操性高则高分；空洞、拼凑、无信息量则低分。只输出 JSON：{"quality_score":数字}。\n标题：${fileRow.title || fileRow.name}\n内容开头：\n${content}`
    const modelId = job.model || await getDefaultModel()
    const r = await callLlmWithFallback(provider, modelId, prompt)
    usedProvider = r.usedProvider
    usedModel = r.usedModel
    promptTokens = r.promptTokens
    completionTokens = r.completionTokens

    const score = parseQualityScore(r.text)
    if (score === null) throw new Error('invalid_llm_output')
    await db.exec(`UPDATE wiki_entries_meta SET quality_score = ${score} WHERE file_id = ${job.fileId}`)
    status = 'success'
  } catch (e: any) {
    error = String(e?.message || e)
  } finally {
    await saveCallLog({
      file_id: job.fileId,
      provider: usedProvider,
      model: usedModel,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: (promptTokens || 0) + (completionTokens || 0),
      duration_ms: Date.now() - started,
      status,
      error
    })
    await bumpBackfillCounter(db, status === 'success' ? 'qualityBackfill.done' : 'qualityBackfill.failed').catch(() => {})
  }
}

// processEmbed（file 级向量补齐）随方案 B 移除：file_embeddings 已 DROP，向量主路 = 词条分块
// （蒸馏成功 indexWikiChunks + wiki 面板补嵌），见 llm/index.ts 方案 B 注释。
