/**
 * v0.1.5 G3：AI 产物质量评测（golden set）CLI。
 *
 * WHY：贡献者改 prompt / 换模型后需要一条「质量没变差」的可复现证据链。
 * 规则化评测，不调用任何 LLM、不做 LLM-as-judge（避免二次成本与循环依赖），
 * 也不依赖库（区别于 searchBaseline.ts 的只读开库：golden set 评测是纯本地规则）。
 *
 * 评测口径（与 test/qualityEval.test.ts 共用 src/qualityEvalCore.ts，CLI 只是薄壳）：
 *   - gate 类：checkGate(fp='sample.md', size=utf8 字节长度, raw=source, cfg=GATE_DEFAULTS)
 *     的 pass 布尔映射为 'pass'|'reject'。fp 固定绕开路径/黑名单/文件名/关键词白名单通道，
 *     聚焦内容门禁（minSize/minChars/codeRatio）默认配置。expected 与现状校准一致，
 *     一致率 = 一致数 / 总数。
 *   - distill 类：确定性代理——关键词保留 ⇔ 出现在 cleanTitle(title 行) 或 cleanSummary(正文)
 *     （formatter.ts 真实出口刻度 160/80 截断）。覆盖率 = 保留词 / 总词。
 *
 * 用法：
 *   npx tsx server/scripts/qualityEval.ts [--fixtures <path>] [--json <path>] [--fail-below <rate>]
 *   --fixtures   golden 夹具路径，缺省 server/test/fixtures/quality-golden.json（可指向篡改副本做负向重放）
 *   --json       结果 JSON 落盘路径（stdout 仍输出 markdown）
 *   --fail-below gate 一致率退出阈值，0 < rate ≤ 1，缺省 1.0（golden 与现状全一致才绿）
 *
 * 退出码：gate 一致率 ≥ 阈值 → 0；低于阈值 → 1。
 * distill 覆盖率只报告不参与退出判定（初始基线未必满分，见夹具 _meta）。
 * 夹具缺失 / JSON 非法 / 形状校验不过 / 任一类样本为空：可读错误 + exit 1（不静默）。
 * stdout = 纯 markdown（可重定向落盘）；进度走 stderr，范式对齐 searchBaseline.ts。
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { checkGate, GATE_DEFAULTS } from '../src/gate.js'
import { cleanTitle, cleanSummary } from '../src/formatter.js'
import { evalGateSamples, evalDistillSamples, loadGoldenData, GateExpect } from '../src/qualityEvalCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_FIXTURES = path.join(__dirname, '../test/fixtures/quality-golden.json')

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 与 gate.ts 只读对接的判定适配：fp 固定 sample.md，聚焦内容门禁（口径见文件头注释） */
function realGateCheck(source: string): GateExpect {
  const verdict = checkGate('sample.md', Buffer.byteLength(source, 'utf8'), source, GATE_DEFAULTS)
  return verdict.pass ? 'pass' : 'reject'
}

/** 压缩空白并转义竖线，保证 markdown 单元格单行安全（对齐 searchBaseline） */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

function fmtRate(rate: number): string {
  return (rate * 100).toFixed(1) + '%'
}

async function main() {
  const fixturesPath = path.resolve(argValue('--fixtures') ?? DEFAULT_FIXTURES)
  const jsonPath = argValue('--json') ? path.resolve(argValue('--json')!) : undefined
  const failBelowRaw = argValue('--fail-below') ?? '1.0'
  const failBelow = Number(failBelowRaw)
  if (!Number.isFinite(failBelow) || failBelow <= 0 || failBelow > 1) {
    console.error(`--fail-below 需为 (0, 1] 内的数值，收到：${failBelowRaw}`)
    process.exit(1)
  }

  let raw: string
  try {
    raw = await fs.readFile(fixturesPath, 'utf8')
  } catch (err: any) {
    console.error(`无法读取 golden 夹具 ${fixturesPath}：${err?.message ?? err}`)
    process.exit(1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: any) {
    console.error(`golden 夹具不是合法 JSON（${fixturesPath}）：${err?.message ?? err}`)
    process.exit(1)
  }
  const { gate, distill, issues, meta } = loadGoldenData(parsed)
  if (issues.length > 0) {
    console.error(`golden 夹具形状校验未通过（${fixturesPath}）：`)
    issues.forEach(i => console.error(`  - ${i}`))
    process.exit(1)
  }
  if (gate.length === 0 || distill.length === 0) {
    console.error(`golden 夹具样本不完整（${fixturesPath}）：gate ${gate.length} 条、distill ${distill.length} 条，两类均须非空`)
    process.exit(1)
  }
  console.error(`已加载 golden 夹具：gate ${gate.length} 条 / distill ${distill.length} 条（${fixturesPath}）`)

  const gateResult = evalGateSamples(gate, realGateCheck)
  const distillResult = evalDistillSamples(distill, cleanTitle, cleanSummary)
  const passed = gateResult.agreementRate >= failBelow
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const reproCmd = `npx tsx server/scripts/qualityEval.ts --fixtures ${fixturesPath} --fail-below ${failBelow}`

  const out: string[] = []
  out.push(`## AI 产物质量评测（G3 golden set，生成于 ${generatedAt}）`)
  out.push('')
  out.push(`夹具：\`${fixturesPath}\`（gate ${gate.length} 条 / distill ${distill.length} 条）；判定阈值：gate 一致率 ≥ ${failBelow}（--fail-below 可调）；复现命令：\`${reproCmd}\`。distill 覆盖率只报告，不参与退出判定。`)
  out.push('')
  out.push(`### 表 1：gate 判定一致性（一致 ${gateResult.agreed}/${gateResult.total}，一致率 ${fmtRate(gateResult.agreementRate)}）`)
  out.push('')
  out.push('| # | expected | actual | 一致 | note |')
  out.push('| --- | --- | --- | --- | --- |')
  gateResult.rows.forEach(r => {
    out.push(`| ${r.index} | ${r.expected} | ${r.actual} | ${r.agree ? '✓' : '✗'} | ${cell(r.note)} |`)
  })
  out.push('')
  out.push(`### 表 2：distill 关键词保留（保留 ${distillResult.keptKeywords}/${distillResult.totalKeywords} 词，覆盖率 ${fmtRate(distillResult.coverageRate)}）`)
  out.push('')
  out.push('| # | 关键词数 | 保留数 | note |')
  out.push('| --- | --- | --- | --- |')
  distillResult.rows.forEach(r => {
    const missingNote = r.missing.length > 0 ? `；丢失：${r.missing.join('、')}` : ''
    out.push(`| ${r.index} | ${r.total} | ${r.kept} | ${cell(r.note + missingNote)} |`)
  })
  out.push('')
  out.push(`**结论**：gate 一致率 ${fmtRate(gateResult.agreementRate)} ${passed ? '≥' : '<'} 阈值 ${failBelow} → ${passed ? 'PASS（exit 0）' : 'FAIL（exit 1）'}；distill 覆盖率 ${fmtRate(distillResult.coverageRate)}（仅报告）。`)
  if (!passed) {
    const drifted = gateResult.rows.filter(r => !r.agree).map(r => `#${r.index}(${r.expected}→${r.actual})`)
    out.push('')
    out.push(`> 不一致样本：${drifted.join('、')}。判定行为漂移需人工评审：确认是新缺陷则修规则/实现，确认是有意变更则同步更新 golden 的 expected（先跑再标）。`)
  }
  console.log(out.join('\n'))

  if (jsonPath) {
    const report = {
      generatedAt,
      fixturesPath,
      failBelow,
      passed,
      gate: { ...gateResult, agreementRate: Number(gateResult.agreementRate.toFixed(4)) },
      distill: { ...distillResult, coverageRate: Number(distillResult.coverageRate.toFixed(4)) },
      meta
    }
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.error(`结果 JSON 已落盘：${jsonPath}`)
  }
  process.exit(passed ? 0 : 1)
}

main().catch(err => {
  console.error('qualityEval 执行失败:', err?.message ?? err)
  process.exit(1)
})
