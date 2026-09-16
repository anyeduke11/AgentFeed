import fs from 'fs/promises'

/**
 * M3 rule_score 精算（PRD 7.1 维度定义）：
 * D1 文件类型 0~2 + D2 内容规模 0~3 + D3 标题层级 0~3 + D4 表格行数 0~3 + D5 代码占比 0~3
 * raw 满分 14，归一化 0~10（1 位小数）。纯规则零 LLM，扫描/入库时算好缓存于 files.rule_score。
 */

/** 内容采样上限：与门禁 SIZE_ANALYZE_LIMIT 同值（512KB），只读头部防 OOM */
export const RULE_SAMPLE_LIMIT = 512 * 1024

/** 刻度版本：v1 = M1 的 SQL 估分（1~5），v2 = 五维精算（0~10）。升版触发存量全量重算 */
export const RULE_SCORE_VERSION = 2

const RAW_MAX = 14

export interface RuleScoreDetail {
  d1: number
  d2: number
  d3: number
  d4: number
  d5: number
  raw: number
  score: number
}

/** D1 文件类型：.html 自带排版与链接结构得 2，其余（.md）得 1 */
function scoreType(ext: string): number {
  return ext === '.html' ? 2 : 1
}

/** D2 内容规模：>50KB=3；>10KB=2；>2KB=1；否则 0（沿用 M1 阈值 51200/10240/2048） */
function scoreSize(size: number): number {
  if (size > 51200) return 3
  if (size > 10240) return 2
  if (size > 2048) return 1
  return 0
}

/** D3 标题层级：md 按 `^#{1,6} ` 行，html 按 h1~h6 标签计数；层级数 = 出现的不同标题级别数 */
function scoreHeadings(ext: string, text: string, lines: string[]): number {
  const levels = new Set<number>()
  let total = 0
  if (ext === '.html') {
    const re = /<h([1-6])(?=[\s>])/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      levels.add(Number(m[1]))
      total++
    }
  } else {
    for (const line of lines) {
      const m = /^#{1,6}\s/.exec(line)
      if (m) {
        levels.add(m[0].trim().length)
        total++
      }
    }
  }
  if (total === 0) return 0
  if (levels.size < 2 || total < 3) return 1
  if (total >= 6) return 3
  return 2
}

/** D4 表格：md 以 `|---|` 分隔行定位表格累计数据行，html 按 <table> 内 <tr> 计数 */
function scoreTables(ext: string, text: string, lines: string[]): number {
  let tables = 0
  let rows = 0
  if (ext === '.html') {
    const tableRe = /<table[\s>][\s\S]*?<\/table>/gi
    let t: RegExpExecArray | null
    while ((t = tableRe.exec(text))) {
      tables++
      rows += (t[0].match(/<tr[\s>]/gi) || []).length
    }
  } else {
    // 分隔行：只含空格/竖线/冒号/连字符，且至少各含一个 | 与 -
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('|') || !line.includes('-') || !/^[\s|:-]+$/.test(line)) continue
      tables++
      // 累计分隔行之后的数据行（表头不计），遇空行或无竖线行结束
      for (let j = i + 1; j < lines.length; j++) {
        const cur = lines[j]
        if (cur.trim() === '' || !cur.includes('|')) break
        rows++
      }
    }
  }
  if (tables === 0) return 0
  if (rows >= 20) return 3
  if (tables >= 2 || rows >= 5) return 2
  return 1
}

/** D5 代码围栏占比：md 数 ``` 围栏内行，html 数 <pre> 内行；占比 = 代码行 / 非空总行 */
function scoreCode(ext: string, text: string, lines: string[]): number {
  let codeLines = 0
  if (ext === '.html') {
    const preRe = /<pre[\s>][\s\S]*?<\/pre>/gi
    let m: RegExpExecArray | null
    while ((m = preRe.exec(text))) {
      const inner = m[0].slice(m[0].indexOf('>') + 1, m[0].length - '</pre>'.length)
      codeLines += inner.split('\n').filter(l => l.trim() !== '').length
    }
  } else {
    let inFence = false
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence && line.trim() !== '') codeLines++
    }
  }
  if (codeLines === 0) return 0
  const nonEmpty = lines.filter(l => l.trim() !== '').length
  // 护栏 1：非空行 <5 的样本（压缩单行 html、代码片段文件）不计占比
  if (nonEmpty < 5) return 0
  const ratio = codeLines / nonEmpty
  const band = ratio <= 0.1 ? 1 : ratio <= 0.3 ? 2 : 3
  // 护栏 2：代码占比 >80% 且无标题（纯代码堆砌、无讲解文字）→ 封顶 2 分
  if (ratio > 0.8 && scoreHeadings(ext, text, lines) === 0) return Math.min(band, 2)
  return band
}

/** 五维精算主入口：text 应为头部采样内容（≤512KB） */
export function scoreRuleDimensions(ext: string, size: number, text: string): RuleScoreDetail {
  const lines = text.split('\n')
  const d1 = scoreType(ext)
  const d2 = scoreSize(size)
  const d3 = scoreHeadings(ext, text, lines)
  const d4 = scoreTables(ext, text, lines)
  const d5 = scoreCode(ext, text, lines)
  const raw = d1 + d2 + d3 + d4 + d5
  const score = Math.round((raw / RAW_MAX) * 100) / 10
  return { d1, d2, d3, d4, d5, raw, score }
}

/**
 * 读取文件头部采样并精算。sample 传入时直接复用（ingest 时与门禁共用一次读取），否则自行读头部 min(size, 512KB)。
 * 读取失败抛错，由调用方决定跳过留 NULL（不阻塞扫描）。
 */
export async function computeRuleScore(fp: string, ext: string, size: number, sample?: Buffer): Promise<number> {
  let buf = sample
  if (!buf) {
    const fh = await fs.open(fp, 'r')
    try {
      const len = Math.min(size, RULE_SAMPLE_LIMIT)
      buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, 0)
      if (bytesRead < len) buf = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
  return scoreRuleDimensions(ext, size, buf.toString('utf-8')).score
}
