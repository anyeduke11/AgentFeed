// I3 RSI 成长闭环（v0.1.5 最后一批）：今日学习建议（信号聚合 + 模型判断推送时机 + 代码硬顶打扰控制）
// + 理解度检查（opt-in 出题）+ 答题结果调整间隔重复档位。
//
// 红线（产品裁决）：推送时机可由模型判断，但打扰控制是代码硬顶——每日 ≤1 次、可全局关，
// 模型判断不可突破硬顶：任何路径下硬顶检查先于模型调用执行（测试钉死 fake llm 调用次数为 0）。
// 理解度检查 opt-in 默认关（config 键 rsi.enabled 缺省 false），未开启绝不调模型。
//
// 写入面收敛：仅 config（rsi.* 键）、llm_call_logs（调用留痕）、exec_queue.interval_stage（答题调整）。

import fs from 'fs/promises'
import { getDb } from './db.js'
import { callLlm } from './llm/index.js'
import { getDefaultProvider, getDefaultModel, saveCallLog } from './llm/llmClient.js'
import { clusterReads, labelClusters, UNCLASSIFIED } from './readAffinityCore.js'

type RsiLlmFn = (providerName: string, modelId: string, prompt: string, apiKey?: string) => Promise<{ text: string, usage?: { input?: number, output?: number } }>

// llmFn 注入点（对齐 chat.ts setChatLlmFn 模式）：测试注入 fake 验证管线，不测网络
let rsiLlmFn: RsiLlmFn = callLlm
export function setRsiLlmFn(fn: RsiLlmFn) {
  rsiLlmFn = fn
}

let quizLlmFn: RsiLlmFn = callLlm
export function setQuizLlmFn(fn: RsiLlmFn) {
  quizLlmFn = fn
}

/** 学习建议条目：fileId 供前端跳 /reader/<id>，reason 为确定性信号说明（非模型生成） */
export interface LearningSuggestion {
  fileId: number
  title: string
  reason: string
}

export interface LearningSuggestionsResult {
  items: LearningSuggestion[]
  generated: boolean
  hardBlocked?: 'daily-cap' | 'disabled'
}

/** 本地日期串 YYYY-MM-DD（硬顶记账口径：写入与比对同一函数产出，永不漂移） */
export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function getConfig(key: string): Promise<string | null> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([key]) as any
  return row?.value ?? null
}

async function setConfig(key: string, value: string, type: 'string' | 'boolean', description: string): Promise<void> {
  const db = await getDb()
  const escValue = value.replace(/'/g, "''")
  const escDesc = description.replace(/'/g, "''")
  await db.exec(`INSERT INTO config (key, value, type, description) VALUES ('${key}', '${escValue}', '${type}', '${escDesc}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
}

/** 建议 ≤3 条（超出按确定性排序截断：到期复习 > 高频域未读完 > 目标缺口） */
const SUGGESTION_CAP = 3

/** 剥 ```json 围栏后 JSON.parse（callLlm 强制 json_object，围栏是模型偶发格式漂移） */
function parseJsonLoose(text: string): any {
  const t = String(text ?? '').trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  try {
    return JSON.parse(m ? m[1] : t)
  } catch {
    return undefined
  }
}

/**
 * 今日学习建议。管线：硬顶检查（不调模型）→ 信号聚合（纯 SQL + readAffinity 聚类）
 * → 候选 ≥1 时模型判断推送时机 → 产出 ≤3 条并记账（peek 模式不记账，供测试与「预览不消耗」场景）。
 * 模型失败/输出不可解析 → 保守生成（可用性优先：不因模型挂了就不工作）。
 */
export async function buildLearningSuggestions(opts?: { peek?: boolean }): Promise<LearningSuggestionsResult> {
  const blocked: LearningSuggestionsResult = { items: [], generated: false }
  // a) 硬顶先行（代码强制，先于任何模型调用）：
  //    全局关（缺省 true）+ 当日已生成（rsi.lastSuggestionDay = 今天）——命中任一直接拦截
  if ((await getConfig('rsi.suggestionsEnabled')) === 'false') return { ...blocked, hardBlocked: 'disabled' }
  if ((await getConfig('rsi.lastSuggestionDay')) === todayStr()) return { ...blocked, hardBlocked: 'daily-cap' }

  const db = await getDb()
  const picked = new Set<number>()
  const items: LearningSuggestion[] = []
  let dueCount = 0
  let hotCount = 0

  // b) 信号 ①：exec_queue 当日到期 pending（due_at ≤ now）——到期复习优先级最高
  const dueRows = await (await db.prepare(`
    SELECT e.file_id, COALESCE(NULLIF(f.title, ''), f.name) AS title, MIN(e.due_at) AS due_at
    FROM exec_queue e JOIN files f ON f.id = e.file_id
    WHERE e.status = 'pending' AND e.due_at <= datetime('now') AND f.status = 'active'
    GROUP BY e.file_id ORDER BY due_at ASC`)).all() as any[]
  dueCount = dueRows.length
  for (const r of dueRows) {
    if (picked.has(Number(r.file_id))) continue
    picked.add(Number(r.file_id))
    items.push({ fileId: Number(r.file_id), title: String(r.title ?? ''), reason: `间隔复习已到期（${String(r.due_at).slice(0, 10)} 到期）· 重读固化记忆` })
  }

  // b) 信号 ②：readAffinity 主题簇高频域内、近 7 天打开 ≥2 次且未读完（recommendations.progress 无或 <100）
  if (items.length < SUGGESTION_CAP) {
    // 聚类输入：近 30 天 read_history 时间升序 + file→domain 映射（readAffinityCore 同口径）
    const rhRows = await (await db.prepare(`
      SELECT id, file_id, path, source, opened_at FROM read_history
      WHERE opened_at IS NOT NULL AND opened_at >= datetime('now', '-30 days')
      ORDER BY opened_at ASC`)).all() as any[]
    const fdRows = await (await db.prepare(`
      SELECT f.id, d.name FROM files f LEFT JOIN domains d ON d.id = f.domain_id`)).all() as any[]
    const fileDomainMap = new Map<number, string | null>(fdRows.map(r => [Number(r.id), r.name == null ? null : String(r.name)]))
    const { clusters } = clusterReads(rhRows)
    // 高频域 = 任一簇的主域（簇内出现 ≥2 次）；未分类桶不构成「高频领域」
    const hotDomains = new Set<string>()
    for (const c of labelClusters(clusters, fileDomainMap)) {
      for (const d of c.primaryDomains) if (d !== UNCLASSIFIED) hotDomains.add(d)
    }
    if (hotDomains.size > 0) {
      const inList = [...hotDomains].map(() => '?').join(',')
      const openRows = await (await db.prepare(`
        SELECT f.id, COALESCE(NULLIF(f.title, ''), f.name) AS title, d.name AS domain_name, COUNT(*) AS opens,
               COALESCE(r.progress, 0) AS progress
        FROM read_history rh
        JOIN files f ON f.id = rh.file_id
        LEFT JOIN domains d ON d.id = f.domain_id
        LEFT JOIN recommendations r ON r.file_id = f.id
        WHERE rh.opened_at >= datetime('now', '-7 days') AND f.status = 'active'
          AND d.name IN (${inList})
          AND (r.status IS NULL OR r.status != 'archived')
        GROUP BY f.id
        HAVING COUNT(*) >= 2 AND COALESCE(r.progress, 0) < 100
        ORDER BY opens DESC, f.id ASC`)).all([...hotDomains]) as any[]
      hotCount = openRows.length
      for (const r of openRows) {
        if (items.length >= SUGGESTION_CAP) break
        if (picked.has(Number(r.id))) continue
        picked.add(Number(r.id))
        items.push({ fileId: Number(r.id), title: String(r.title ?? ''), reason: `高频域「${String(r.domain_name)}」在读 · 近 7 天打开 ${Number(r.opens)} 次未读完（进度 ${Number(r.progress)}%）` })
      }
    }
  }

  // b) 信号 ③：周目标缺口（reading.weeklyGoal vs 本周打分去重篇数——与 /reading/stats 目标环同口径），
  //     不足时补高 rule_score 待读（推荐池 unread）
  if (items.length < SUGGESTION_CAP) {
    const goal = Math.max(1, parseInt((await getConfig('reading.weeklyGoal')) || '') || 5)
    const rated = await (await db.prepare(
      "SELECT COUNT(DISTINCT file_id) AS n FROM reading_feedback WHERE created_at >= datetime('now', '-7 days')"
    )).get() as any
    const gap = goal - Number(rated?.n || 0)
    if (gap > 0) {
      const poolRows = await (await db.prepare(`
        SELECT f.id, COALESCE(NULLIF(f.title, ''), f.name) AS title, COALESCE(f.rule_score, 0) AS rule_score
        FROM files f JOIN recommendations r ON r.file_id = f.id
        WHERE r.status = 'unread' AND f.status = 'active'
        ORDER BY COALESCE(f.rule_score, 0) DESC, f.id ASC
        LIMIT ${SUGGESTION_CAP}`)).all() as any[]
      for (const r of poolRows) {
        if (items.length >= SUGGESTION_CAP) break
        if (picked.has(Number(r.id))) continue
        picked.add(Number(r.id))
        items.push({ fileId: Number(r.id), title: String(r.title ?? ''), reason: `周目标还差 ${gap} 篇 · 高分待读（规则分 ${Number(r.rule_score)}）` })
      }
    }
  }

  // 候选为空：无事可建议，不调模型也不记账
  if (items.length === 0) return blocked

  // c) 推送时机模型判断：候选清单 + 信号摘要 → {"push":bool,"reason"}；
  //    失败/不可解析 → 保守推送（可用性优先）
  const provider = await getDefaultProvider()
  const model = await getDefaultModel()
  const prompt = [
    '任务：判断现在是否适合向用户推送「今日学习建议」（间隔复习 / 在读未完 / 周目标缺口）。',
    '打扰控制原则：仅在学习信号明确（复习到期、连续在读、目标落后）时才值得打断用户；信号弱或意义不大时倾向不推送。',
    '',
    '【候选清单】',
    ...items.map((it, i) => `- [${i + 1}] (id:${it.fileId}) ${it.title}：${it.reason}`),
    '',
    `【信号摘要】到期复习 ${dueCount} 项 · 高频域在读 ${hotCount} 项 · 建议上限 ${SUGGESTION_CAP} 条。`,
    '',
    '输出 JSON：{"push": true 或 false, "reason": "一句话理由"}，不要代码围栏，不要多余解释。',
  ].join('\n')
  const t0 = Date.now()
  let judged: boolean | null = null
  try {
    const r = await rsiLlmFn(provider, model, prompt)
    await saveCallLog({
      file_id: null, provider, model,
      prompt_tokens: r.usage?.input ?? null,
      completion_tokens: r.usage?.output ?? null,
      total_tokens: r.usage?.input != null && r.usage?.output != null ? Number(r.usage.input) + Number(r.usage.output) : null,
      duration_ms: Date.now() - t0,
      status: 'success',
    })
    const obj = parseJsonLoose(r.text)
    if (obj && typeof obj === 'object' && typeof obj.push === 'boolean') judged = obj.push
  } catch (e: any) {
    await saveCallLog({
      file_id: null, provider, model,
      duration_ms: Date.now() - t0,
      status: 'failed',
      error: String(e?.message || e),
    })
  }
  // 模型明确说不推 → 不生成（返回 generated:false，不记账——未生成不消耗当日额度）
  if (judged === false) return blocked

  // d) 产出（≤3 条已在聚合时截断）→ 硬顶记账（peek 只看不记账）→ 返回
  if (!opts?.peek) await setConfig('rsi.lastSuggestionDay', todayStr(), 'string', '学习建议最近生成日（每日 ≤1 次硬顶记账）')
  return { items, generated: true }
}

/** 理解度检查开关：config rsi.enabled 缺省 false（opt-in） */
export async function isQuizEnabled(): Promise<boolean> {
  return (await getConfig('rsi.enabled')) === 'true'
}

/** 从 entry.md 提取「## 关键要点」小节的要点行（编号/圆点前缀剥离） */
export function extractKeyPoints(entryMd: string): string[] {
  const m = entryMd.match(/^##\s+关键要点\s*$/m)
  if (!m) return []
  const after = entryMd.slice(m.index! + m[0].length)
  const next = after.match(/^##\s+/m)
  const section = next ? after.slice(0, next.index!) : after
  return section.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l.replace(/^\d+[.、)]\s*/, '').replace(/^[-*]\s*/, ''))
    .filter(l => l.length > 0)
}

/**
 * 理解度检查出题：rsi.enabled false 直接 null（未开启绝不调模型）；
 * 素材 = wiki_entries_meta.summary + entry.md「## 关键要点」→ callLlm 生成 3 道问答；
 * 无素材 / 模型失败 / 解析失败 → null（解析失败 fail loud 落 llm_call_logs failed）。
 */
export async function generateQuiz(fileId: number): Promise<{ questions: Array<{ q: string, a: string }> } | null> {
  if (!(await isQuizEnabled())) return null
  const db = await getDb()
  const meta = await (await db.prepare(`
    SELECT m.summary, m.entry_path, COALESCE(NULLIF(m.title, ''), NULLIF(f.title, ''), f.name) AS title
    FROM wiki_entries_meta m JOIN files f ON f.id = m.file_id
    WHERE m.file_id = ?`)).get([fileId]) as any
  if (!meta) return null
  const entryMd = await fs.readFile(String(meta.entry_path), 'utf8').catch(() => '')
  const points = extractKeyPoints(entryMd)
  const summary = String(meta.summary ?? '')
  if (points.length === 0 && summary.trim() === '') return null

  const provider = await getDefaultProvider()
  const model = await getDefaultModel()
  const prompt = [
    `任务：基于词条《${String(meta.title ?? '')}》的要点出一套恰好 3 道自测题（问答式），检验用户对该词条的理解。`,
    '',
    summary.trim() ? `【摘要】${summary}` : '',
    points.length ? ['【关键要点】', ...points.map(p => `- ${p}`)].join('\n') : '',
    '',
    '要求：题目覆盖不同要点；答案简短准确（一句话内可直接对照自评）。',
    '输出 JSON 数组（恰好 3 项）：[{"q":"问题","a":"参考答案"}]，不要代码围栏，不要多余解释。',
  ].filter(Boolean).join('\n')

  const t0 = Date.now()
  let raw: string
  try {
    const r = await quizLlmFn(provider, model, prompt)
    raw = r.text
    await saveCallLog({
      file_id: fileId, provider, model,
      prompt_tokens: r.usage?.input ?? null,
      completion_tokens: r.usage?.output ?? null,
      total_tokens: r.usage?.input != null && r.usage?.output != null ? Number(r.usage.input) + Number(r.usage.output) : null,
      duration_ms: Date.now() - t0,
      status: 'success',
    })
  } catch (e: any) {
    await saveCallLog({
      file_id: fileId, provider, model,
      duration_ms: Date.now() - t0,
      status: 'failed',
      error: String(e?.message || e),
    })
    return null
  }

  const parsed = parseJsonLoose(raw)
  const questions = Array.isArray(parsed)
    ? parsed.filter((x: any) => x && typeof x === 'object' && typeof x.q === 'string' && typeof x.a === 'string' && x.q.trim() !== '')
      .map((x: any) => ({ q: x.q, a: x.a }))
      .slice(0, 3)
    : []
  if (questions.length === 0) {
    // 解析失败 fail loud：落 failed 日志（G1 成本视图可见），返回 null
    await saveCallLog({
      file_id: fileId, provider, model,
      duration_ms: Date.now() - t0,
      status: 'failed',
      error: 'llm_output_not_json: quiz',
    })
    return null
  }
  return { questions }
}

/**
 * 答题结果调整间隔档位（确定性纯 SQL，无模型）：
 * correct=true → interval_stage +1（更长间隔）；false → 降 1（最小 0）。
 * 只调整既有行、绝不造行：execQueueId 指定则调该行（校验属该文件），否则调该文件最新行；无任何行返回 false。
 */
export async function applyQuizResult(execQueueId: number | null, fileId: number, correct: boolean): Promise<boolean> {
  const db = await getDb()
  let row: any
  if (execQueueId != null) {
    row = await (await db.prepare('SELECT id, interval_stage FROM exec_queue WHERE id = ? AND file_id = ?')).get([execQueueId, fileId]) as any
  } else {
    row = await (await db.prepare('SELECT id, interval_stage FROM exec_queue WHERE file_id = ? ORDER BY id DESC LIMIT 1')).get([fileId]) as any
  }
  if (!row) return false
  const stage = Number(row.interval_stage) || 0
  const next = correct ? stage + 1 : Math.max(0, stage - 1)
  await db.exec(`UPDATE exec_queue SET interval_stage = ${next} WHERE id = ${Number(row.id)}`)
  return true
}

/** RSI 状态（设置页展示）：quizEnabled / suggestionsEnabled / lastSuggestionDay */
export async function getRsiStatus(): Promise<{ quizEnabled: boolean, suggestionsEnabled: boolean, lastSuggestionDay: string | null }> {
  return {
    quizEnabled: (await getConfig('rsi.enabled')) === 'true',
    suggestionsEnabled: (await getConfig('rsi.suggestionsEnabled')) !== 'false',
    lastSuggestionDay: await getConfig('rsi.lastSuggestionDay'),
  }
}

/** 设置页开关：quiz → rsi.enabled（opt-in），suggestions → rsi.suggestionsEnabled（缺省 true） */
export async function setRsiToggle(key: 'quiz' | 'suggestions', value: boolean): Promise<boolean> {
  if (key === 'quiz') {
    await setConfig('rsi.enabled', value ? 'true' : 'false', 'boolean', '理解度检查开关（opt-in 默认关：阅读器「考考我」出题）')
    return true
  }
  if (key === 'suggestions') {
    await setConfig('rsi.suggestionsEnabled', value ? 'true' : 'false', 'boolean', '学习建议推送开关（每日 ≤1 次硬顶之外的全局关）')
    return true
  }
  return false
}
