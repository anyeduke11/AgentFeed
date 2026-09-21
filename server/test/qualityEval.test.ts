import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { checkGate, GATE_DEFAULTS } from '../src/gate.js'
import { cleanTitle, cleanSummary } from '../src/formatter.js'
import { evalGateSamples, evalDistillSamples, loadGoldenData, GateGoldenSample, DistillGoldenSample } from '../src/qualityEvalCore.js'

// v0.1.5 G3 质量评测（golden set）测试。WHY：贡献者改 prompt / 换模型后需要可复现的
// 「质量没变差」证据链；golden set 的价值 = 与现状校准一致 + 评测函数真的会失败。
// 本文件钉住：① 夹具形状与规模（缺字段/空样本必须被拒，防夹具悄悄烂掉）；
// ② golden 与真实 gate 规则 / formatter 出口全一致（校准基线，行为漂移立即红）；
// ③ 一致率/覆盖率计算正确；④ 负向可失败——反着答暴跌、截断丢词覆盖率 <1
// （评测若永远绿，等于没有评测）。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, 'fixtures/quality-golden.json')

/** 与 scripts/qualityEval.ts 同口径的判定适配：fp 固定 sample.md，聚焦内容门禁默认配置 */
const realGateCheck = (source: string): 'pass' | 'reject' =>
  checkGate('sample.md', Buffer.byteLength(source, 'utf8'), source, GATE_DEFAULTS).pass ? 'pass' : 'reject'

const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))

test('golden set 加载与形状校验：两类样本规模、必填字段、_meta 口径齐全', () => {
  const { gate, distill, issues, meta } = loadGoldenData(golden)
  assert.deepEqual(issues, [], '夹具形状必须零问题')
  assert.ok(meta && typeof meta === 'object', '_meta 必须存在')
  assert.ok(typeof (meta as any).gate?.method === 'string' && typeof (meta as any).distill?.method === 'string', '_meta 必须写明两类口径')
  assert.ok(gate.length >= 10, `gate 样本应 ≥10 条，实际 ${gate.length}`)
  assert.ok(distill.length >= 10, `distill 样本应 ≥10 条，实际 ${distill.length}`)
  // 两类期望值都必须存在：只有单一标签的 golden 无法证明判别力
  assert.ok(gate.some(s => s.expected === 'pass') && gate.some(s => s.expected === 'reject'), 'gate 样本须同时含 pass 与 reject 期望')
  for (const s of gate) {
    assert.ok(s.source.trim() !== '' && s.note.trim() !== '', 'gate 样本 source/note 必填')
  }
  for (const s of distill) {
    assert.ok(s.source.trim() !== '', 'distill 样本 source 必填')
    assert.ok(s.mustInclude.length >= 1 && s.mustInclude.every(k => k.trim() !== ''), 'mustInclude 必须是非空字符串数组')
  }
})

test('形状校验负向：缺字段/非法 expected/空 mustInclude 必须被拒（不静默）', () => {
  const bad1 = loadGoldenData({ samples: [{ type: 'gate', source: 'x' }] })
  assert.ok(bad1.issues.length > 0, '缺 expected/note 必须记 issue')
  const bad2 = loadGoldenData({ samples: [{ type: 'gate', source: 'x', expected: 'maybe', note: 'n' }] })
  assert.ok(bad2.issues.length > 0, '非法 expected 必须记 issue')
  const bad3 = loadGoldenData({ samples: [{ type: 'distill', source: 'x', mustInclude: [] }] })
  assert.ok(bad3.issues.length > 0, '空 mustInclude 必须记 issue')
  const bad4 = loadGoldenData({ samples: 'not-array' })
  assert.ok(bad4.issues.length > 0 && bad4.gate.length === 0, 'samples 非数组必须记 issue')
  const bad5 = loadGoldenData({ samples: [] })
  assert.ok(bad5.issues.length > 0, '缺 _meta 必须记 issue')
})

test('golden gate 样本与真实 gate.ts 判定全一致（先跑再标的校准基线）', () => {
  // WHY：golden 的 expected 全部按当前规则实跑校准。gate 规则有意变更时这里会红，
  // 贡献者必须同步更新 golden 的 expected 并在评审中说明行为漂移——这正是 G3 的目的。
  const { gate } = loadGoldenData(golden)
  const result = evalGateSamples(gate, realGateCheck)
  assert.equal(result.total, gate.length)
  const drifted = result.rows.filter(r => !r.agree)
  assert.deepEqual(drifted.map(r => r.index), [], `与现状不一致的样本：${drifted.map(r => `#${r.index} ${r.expected}→${r.actual}`).join('、')}`)
  assert.equal(result.agreementRate, 1)
})

test('golden distill 样本经真实 formatter 清洗后关键词 100% 保留（出口不丢信息基线）', () => {
  const { distill } = loadGoldenData(golden)
  const result = evalDistillSamples(distill, cleanTitle, cleanSummary)
  const lost = result.rows.filter(r => r.missing.length > 0)
  assert.deepEqual(lost.map(r => r.index), [], `丢失关键词的样本：${lost.map(r => `#${r.index} ${r.missing.join('、')}`).join('、')}`)
  assert.equal(result.coverageRate, 1)
})

test('evalGateSamples 一致率计算：注入 fake gateCheckFn 部分答对 → 3/4', () => {
  const samples: GateGoldenSample[] = [
    { type: 'gate', source: 'a', expected: 'pass', note: '' },
    { type: 'gate', source: 'b', expected: 'pass', note: '' },
    { type: 'gate', source: 'c', expected: 'reject', note: '' },
    { type: 'gate', source: 'd', expected: 'reject', note: '' }
  ]
  // d 答错，其余答对
  const fn = (src: string) => (src === 'd' ? 'pass' : src === 'c' ? 'reject' : 'pass')
  const result = evalGateSamples(samples, fn)
  assert.equal(result.agreed, 3)
  assert.equal(result.total, 4)
  assert.equal(result.agreementRate, 0.75)
})

test('负向：gateCheckFn 全部反着答 → 一致率暴跌到 0（证明评测能失败）', () => {
  const samples: GateGoldenSample[] = [
    { type: 'gate', source: 'a', expected: 'pass', note: '' },
    { type: 'gate', source: 'b', expected: 'pass', note: '' },
    { type: 'gate', source: 'c', expected: 'reject', note: '' },
    { type: 'gate', source: 'd', expected: 'reject', note: '' }
  ]
  const inverted = (src: string) => (src === 'a' || src === 'b' ? 'reject' : 'pass')
  const result = evalGateSamples(samples, inverted)
  assert.equal(result.agreed, 0)
  assert.equal(result.agreementRate, 0, '全反答必须零一致——若仍为高一致率，说明评测形同虚设')
})

test('evalDistillSamples：真实 formatter 下正常关键词保留（title/summary 出口可定位）', () => {
  const samples: DistillGoldenSample[] = [
    { type: 'distill', source: '# MCP 接入指南\n本文记录接入 Model Context Protocol 的完整流程与踩坑。', mustInclude: ['MCP', 'Context'], note: '' }
  ]
  const result = evalDistillSamples(samples, cleanTitle, cleanSummary)
  assert.equal(result.rows[0].kept, 2)
  assert.deepEqual(result.rows[0].missing, [])
  assert.equal(result.coverageRate, 1)
})

test('负向：超长 title 的关键词落在 160 截断点之后 → cleanTitle 丢词，覆盖率 <1（证明评测能失败）', () => {
  // WHY：清洗管线若过度截断会丢核心信息；此用例钉住「评测真的会红」。
  // 词放在第 170 字符处，超过 cleanTitle 的 160+… 截断刻度，且正文不含该词。
  const samples: DistillGoldenSample[] = [
    { type: 'distill', source: '甲'.repeat(170) + '独有关键词Q7X\n正文里没有任何关键词，只有一段无关的描述文字。', mustInclude: ['独有关键词Q7X'], note: '' }
  ]
  const result = evalDistillSamples(samples, cleanTitle, cleanSummary)
  assert.equal(result.rows[0].kept, 0)
  assert.deepEqual(result.rows[0].missing, ['独有关键词Q7X'])
  assert.ok(result.coverageRate < 1, '覆盖率必须 <1，否则截断丢词维度不可观测')
  assert.equal(result.coverageRate, 0)
})
