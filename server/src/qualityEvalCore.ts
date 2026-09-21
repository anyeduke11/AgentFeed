// v0.1.5 G3：AI 产物质量评测（golden set）纯函数核心。
// WHY：贡献者改 prompt / 换模型后需要一条「质量没变差」的可复现证据链。
// 明确不做 LLM-as-judge（二次成本 + 循环依赖），全部规则化、确定性、可离线重放。
// 本文件只做计算与夹具形状校验，不碰磁盘、不碰 db；CLI 壳在 scripts/qualityEval.ts，
// 测试在 test/qualityEval.test.ts，三方共用同一套口径。

/** gate 类样本的期望判定（与 GateVerdict.pass 的布尔语义对齐） */
export type GateExpect = 'pass' | 'reject'

/** gate 类 golden 样本：source 为文件正文片段，expected 以当前 gate.ts 规则实跑结果校准 */
export interface GateGoldenSample {
  type: 'gate'
  source: string
  expected: GateExpect
  note: string
}

/** distill 类 golden 样本：mustInclude 为「蒸馏出口应可定位」的关键信息词 */
export interface DistillGoldenSample {
  type: 'distill'
  source: string
  mustInclude: string[]
  note: string
}

export type QualityGoldenSample = GateGoldenSample | DistillGoldenSample

export interface GateEvalRow {
  index: number
  expected: GateExpect
  actual: GateExpect
  agree: boolean
  note: string
}

export interface GateEvalResult {
  rows: GateEvalRow[]
  total: number
  agreed: number
  agreementRate: number
}

export interface DistillEvalRow {
  index: number
  total: number
  kept: number
  missing: string[]
  note: string
}

export interface DistillEvalResult {
  rows: DistillEvalRow[]
  totalKeywords: number
  keptKeywords: number
  coverageRate: number
}

/**
 * gate 类评测：逐样本调用注入的判定函数（脚本侧适配为
 * checkGate('sample.md', byteLength(source), source, GATE_DEFAULTS) 的 pass 布尔映射），
 * 一致率 = 判定一致数 / 总数。空样本集约定返回 0（脚本层已在更早处拒绝空夹具）。
 */
export function evalGateSamples(
  samples: GateGoldenSample[],
  gateCheckFn: (source: string) => GateExpect
): GateEvalResult {
  const rows: GateEvalRow[] = samples.map((s, i) => {
    const actual = gateCheckFn(s.source)
    return { index: i + 1, expected: s.expected, actual, agree: actual === s.expected, note: s.note ?? '' }
  })
  const total = rows.length
  const agreed = rows.filter(r => r.agree).length
  return { rows, total, agreed, agreementRate: total === 0 ? 0 : agreed / total }
}

/**
 * 从 source 确定性推导出口字段候选：首个非空行 = title 行，其余 = 正文（summary 候选）。
 * 与真实蒸馏产物「title + 摘要段」的形态对齐，不依赖库里按 title 匹配（不可靠）。
 */
function splitTitleBody(source: string): { title: string; body: string } {
  const lines = source.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  const title = i < lines.length ? lines[i] : ''
  return { title, body: lines.slice(i + 1).join('\n') }
}

/**
 * distill 类评测（确定性代理）：不真实调用 LLM，测「清洗管线不丢关键信息」——
 * 关键词保留 ⇔ 出现在 cleanTitle(title 行) 或 cleanSummary(正文) 中
 * （出口刻度：title 截断 160+…、summary 截断 80+…，均为 formatter.ts 真实行为）。
 * 覆盖率 = 保留词数 / 总词数。负向可失败：关键词落在截断点之后即丢失。
 */
export function evalDistillSamples(
  samples: DistillGoldenSample[],
  cleanTitle: (raw: string) => string,
  cleanSummary: (raw: string) => string
): DistillEvalResult {
  const rows: DistillEvalRow[] = samples.map((s, i) => {
    const { title, body } = splitTitleBody(s.source)
    const outTitle = cleanTitle(title)
    const outSummary = cleanSummary(body)
    const missing = s.mustInclude.filter(kw => !outTitle.includes(kw) && !outSummary.includes(kw))
    return {
      index: i + 1,
      total: s.mustInclude.length,
      kept: s.mustInclude.length - missing.length,
      missing,
      note: s.note ?? ''
    }
  })
  const totalKeywords = rows.reduce((a, r) => a + r.total, 0)
  const keptKeywords = rows.reduce((a, r) => a + r.kept, 0)
  return { rows, totalKeywords, keptKeywords, coverageRate: totalKeywords === 0 ? 0 : keptKeywords / totalKeywords }
}

export interface GoldenLoadResult {
  gate: GateGoldenSample[]
  distill: DistillGoldenSample[]
  /** 口径说明（_meta），供报告输出 */
  meta: Record<string, unknown> | null
  /** 非空 = 夹具非法，调用方必须 fail loud */
  issues: string[]
}

/**
 * golden 夹具形状校验：_meta 必须为对象；每条样本必填字段齐全且类型正确；
 * gate.expected 只允许 pass/reject；mustInclude 为非空字符串数组。
 * 任何一条不合法即记入 issues（不静默跳过、不静默修复）。
 */
export function loadGoldenData(data: unknown): GoldenLoadResult {
  const gate: GateGoldenSample[] = []
  const distill: DistillGoldenSample[] = []
  const issues: string[] = []
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { gate, distill, meta: null, issues: ['夹具根节点必须是 JSON 对象'] }
  }
  const root = data as Record<string, unknown>
  if (root._meta == null || typeof root._meta !== 'object' || Array.isArray(root._meta)) {
    issues.push('缺少 _meta 对象（口径与负向验证方法说明，头部必填）')
  }
  if (!Array.isArray(root.samples)) {
    return { gate, distill, meta: (typeof root._meta === 'object' && root._meta != null && !Array.isArray(root._meta)) ? root._meta as Record<string, unknown> : null, issues: [...issues, 'samples 必须是数组'] }
  }
  root.samples.forEach((raw: unknown, i: number) => {
    const where = `samples[${i}]`
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`${where}: 必须是对象`)
      return
    }
    const s = raw as Record<string, unknown>
    if (typeof s.source !== 'string' || s.source.trim() === '') {
      issues.push(`${where}: source 必须是非空字符串`)
      return
    }
    if (s.type === 'gate') {
      if (s.expected !== 'pass' && s.expected !== 'reject') {
        issues.push(`${where} (gate): expected 只允许 "pass" | "reject"`)
        return
      }
      if (typeof s.note !== 'string' || s.note.trim() === '') {
        issues.push(`${where} (gate): note 必须是非空字符串（记录为何如此判定）`)
        return
      }
      gate.push({ type: 'gate', source: s.source, expected: s.expected, note: s.note })
    } else if (s.type === 'distill') {
      if (!Array.isArray(s.mustInclude) || s.mustInclude.length === 0 || !s.mustInclude.every((k: unknown) => typeof k === 'string' && (k as string).trim() !== '')) {
        issues.push(`${where} (distill): mustInclude 必须是非空字符串数组且至少一个关键词`)
        return
      }
      distill.push({ type: 'distill', source: s.source, mustInclude: s.mustInclude as string[], note: typeof s.note === 'string' ? s.note : '' })
    } else {
      issues.push(`${where}: type 只允许 "gate" | "distill"`)
    }
  })
  return { gate, distill, meta: (typeof root._meta === 'object' && root._meta != null && !Array.isArray(root._meta)) ? root._meta as Record<string, unknown> : null, issues }
}
