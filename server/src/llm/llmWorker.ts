import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getDb } from '../db.js'
import { getProviders, getDefaultModel, saveCallLog, updateFileLlmState, type LlmProvider } from './llmClient.js'
import { getModelsInstance, callLlm, supportsVision, enqueueEmbed, type LlmImage } from './index.js'
import { failoverChain, reportNodeResult } from './distillNodes.js'
import { embedFileById, getEmbeddingConfig, type EmbeddingConfig } from './embeddings.js'
import { ensureTag } from './tagGovernance.js'
import type { LlmJob } from './llmQueue.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const WIKI_DIR = path.join(DATA_DIR, 'wiki', 'entries')
const MAX_FILE_SIZE = 100 * 1024

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

async function buildPrompt(filePath: string, content: string, domainNames: string[]): Promise<string> {
  const stat = await fs.stat(filePath).catch(() => null)
  const size = stat?.size ?? content.length
  const effective = size > MAX_FILE_SIZE ? summarizeContent(content) : content
  const fileName = path.basename(filePath)
  const domainHint = domainNames.length > 0 ? `\n可选领域（从中选一个最匹配的，都没有合适则留空）：${domainNames.join('、')}` : ''
  return `请为以下知识文件生成结构化 wiki 词条。输出 JSON：{"title":"","summary":"2-3 句摘要","points":["3-6 条关键要点，每条一句话"],"entities":[{"n":"名称","t":"类型"}],"relations":[{"a":"主体","v":"关系动词","b":"客体","note":"备注"}],"domain":"","tags":["2-4 个主题标签"]}。\ndomain 必须从给出的可选领域列表中选择；tags 是自由主题词。${domainHint}\n文件：${fileName}\n内容：\n${effective}`
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
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('no_json')
    const obj = JSON.parse(match[0]) as Record<string, any>
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
  } catch {
    return { title: '', summary: '', points: [], entities: [], relations: [], domain: '', tags: [] }
  }
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
  if (type === 'embed') return processEmbed(job)
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
    const prompt = await buildPrompt(filePath, sanitized, domainNames)
      + (images.length ? `\n（附件：该文件内嵌图片 ${images.length} 张，请结合图片内容一并蒸馏）` : '')

    const llmResult = await callLlmWithFallback(provider, modelId, prompt, images)
    usedProvider = llmResult.usedProvider
    usedModel = llmResult.usedModel

    promptTokens = llmResult.promptTokens
    completionTokens = llmResult.completionTokens
    totalTokens = (promptTokens || 0) + (completionTokens || 0)

    const wiki = safeParseWikiJson(llmResult.text)
    // 解析结果全空 = 模型没按 JSON 输出：按失败处理（落失败泳道可重试），避免假 done（无标题/摘要/领域/标签）
    if (!wiki.title && !wiki.summary && wiki.points.length === 0) {
      throw new Error('llm_output_not_json')
    }
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
      error
    })
    await updateFileLlmState(db, job.fileId, status === 'success' ? 'done' : 'failed')
    // triage 批次熔断统计：只统计带 origin='triage' 标记的 job，普通 push 蒸馏的成败不进计数
    if (job.options?.origin === 'triage') recordTriageResult(status === 'success')
    // 蒸馏成功后自动向量化：投独立 embed 队列（失败自动重试、串行不打架），不占蒸馏并发、不阻塞下一个蒸馏任务
    if (status === 'success') {
      enqueueEmbed(job.fileId)
    }
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
async function callLlmWithFallback(provider: LlmProvider, modelId: string, prompt: string, images?: LlmImage[]): Promise<{ text: string; promptTokens?: number; completionTokens?: number; usedProvider: string; usedModel: string }> {
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
      return { text: text.text, promptTokens: usage?.input, completionTokens: usage?.output, usedProvider: step.p!.name, usedModel: step.model }
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

/** embed：向量补齐——对单篇生成/更新向量（不动 files.llm_state；失败记调用日志） */
async function processEmbed(job: LlmJob): Promise<void> {
  const db = await getDb()
  const started = Date.now()
  let status: 'success' | 'failed' = 'failed'
  let error: string | undefined
  let cfg: EmbeddingConfig | undefined
  try {
    cfg = await getEmbeddingConfig()
    if (!cfg.enabled || !cfg.model) throw new Error('embedding_disabled')
    await embedFileById(db, job.fileId, cfg)
    status = 'success'
  } catch (e: any) {
    error = String(e?.message || e)
    // 上抛给 embed 队列执行器走自动重试（调用日志已在 finally 落库）
    throw e
  } finally {
    await saveCallLog({
      file_id: job.fileId,
      provider: cfg?.provider || 'ollama',
      model: cfg?.model || '',
      duration_ms: Date.now() - started,
      status,
      error
    })
  }
}
