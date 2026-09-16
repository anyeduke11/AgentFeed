import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQualityScore } from '../src/llm/llmWorker.js'

test('parseQualityScore：标准输出直接取 quality_score', () => {
  // WHY: 质量分是入池 score 合成与策展排序的输入，解析错刻度会污染所有下游排序
  assert.equal(parseQualityScore('{"quality_score":7}'), 7)
  assert.equal(parseQualityScore('{"quality_score":8.5}'), 8.5)
})

test('parseQualityScore：兼容 score 键与前后噪声文本', () => {
  assert.equal(parseQualityScore('好的，结果：{"score":6}请查收'), 6)
})

test('parseQualityScore：钳位 0~10（防 LLM 越界值污染排序）', () => {
  assert.equal(parseQualityScore('{"quality_score":12}'), 10)
  assert.equal(parseQualityScore('{"quality_score":-3}'), 0)
})

test('parseQualityScore：非法输入返回 null（worker 记 failed 不写脏分）', () => {
  assert.equal(parseQualityScore('我觉得这篇不错'), null)
  assert.equal(parseQualityScore('{"quality_score":"很高"}'), null)
  assert.equal(parseQualityScore('{}'), null)
  assert.equal(parseQualityScore(''), null)
  assert.equal(parseQualityScore('{"quality_score":}'), null)
})
