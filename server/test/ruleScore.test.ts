import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { scoreRuleDimensions, computeRuleScore, RULE_SAMPLE_LIMIT } from '../src/ruleScore.js'

test('md 平文（无标题/表格/代码）：仅类型分，归一化 0~10 保留 1 位小数', () => {
  // WHY: rule_score 是相对排序兜底分，必须验证归一化公式 raw/14*10 本身而非只看维度
  const d = scoreRuleDimensions('.md', 100, '第一行\n第二行\n第三行')
  assert.equal(d.d1, 1)
  assert.equal(d.d2, 0)
  assert.equal(d.d3, 0)
  assert.equal(d.d4, 0)
  assert.equal(d.d5, 0)
  assert.equal(d.raw, 1)
  assert.equal(d.score, 0.7) // 1/14*10 = 0.714 → 0.7
})

test('md 结构丰富文：标题层级/表格/代码三维度同时命中', () => {
  // 3 个不同级别标题（共 3 个 → 3~5 区间得 2）；1 表 2 数据行得 1；代码占比 1/12 ≤10% 得 1
  const text = [
    '# 标题', '## 二级', '### 三级', '这里是正文内容行',
    '| 列一 | 列二 |', '|---|---|', '| a1 | b1 |', '| a2 | b2 |',
    '```js', 'const x = 1', '```', '尾部还有一行正文'
  ].join('\n')
  const d = scoreRuleDimensions('.md', 20480, text)
  assert.deepEqual([d.d1, d.d2, d.d3, d.d4, d.d5], [1, 2, 2, 1, 1])
  assert.equal(d.score, 5.0) // raw 7/14*10
})

test('md 表格 20+ 数据行得满分（表头不计入数据行）', () => {
  // WHY: D4 的「数据行」口径决定长表（信息密度高的文档）能否被识别
  const rows = Array.from({ length: 20 }, (_, i) => `| k${i} | v${i} |`).join('\n')
  const text = '| 列A | 列B |\n|---|---|\n' + rows
  const d = scoreRuleDimensions('.md', 4096, text)
  assert.equal(d.d4, 3)
})

test('纯代码堆砌无标题：占比 >80% 触发护栏，D5 封顶 2 分', () => {
  // 16 行非空中 13 行在围栏内（0.8125 > 0.8），无任何标题 → 防 code dump 刷满分
  const code = Array.from({ length: 13 }, (_, i) => `const v${i} = ${i}`).join('\n')
  const text = '```js\n' + code + '\n```\n结尾一行说明'
  const d = scoreRuleDimensions('.md', 100, text)
  assert.equal(d.d3, 0)
  assert.equal(d.d5, 2)
})

test('高占比代码但有标题讲解：护栏不误伤，D5 满分 3', () => {
  // WHY: 护栏条件是「>80% 且无标题」，教程类代码文（有标题）必须仍能拿满分
  const code = Array.from({ length: 20 }, (_, i) => `step${i}()`).join('\n')
  const text = '# 实操教程\n```js\n' + code + '\n```'
  const d = scoreRuleDimensions('.md', 100, text)
  assert.equal(d.d5, 3)
})

test('非空行 <5 的样本不计占比：D5 按 0（压缩单行/代码片段护栏）', () => {
  const d = scoreRuleDimensions('.md', 100, '```\nconst x=1\n```')
  assert.equal(d.d5, 0)
})

test('html：h 标签层级、table 内 tr 计数、pre 占比全部生效', () => {
  const text = [
    '<h1>标题</h1>', '<h2>小节</h2>', '<p>一段说明文字</p>',
    '<table>', '<tr><td>a</td></tr>', '<tr><td>b</td></tr>', '</table>',
    '<table>', '<tr><td>1</td></tr>', '<tr><td>2</td></tr>', '<tr><td>3</td></tr>', '</table>',
    '<pre>', 'const x = 1', 'const y = 2', '</pre>'
  ].join('\n')
  const d = scoreRuleDimensions('.html', 3000, text)
  // 2 个 h 级别但总数 2 <3 → 1；2 表 → 2；代码 2/15 ≈13% → 2
  assert.deepEqual([d.d1, d.d2, d.d3, d.d4, d.d5], [2, 1, 1, 2, 2])
  assert.equal(d.score, 5.7) // raw 8/14*10 = 5.714 → 5.7
})

test('md 未闭合围栏：代码行计到文末', () => {
  const text = '说明甲\n说明乙\n说明丙\n```js\nconst a=1\nconst b=2'
  const d = scoreRuleDimensions('.md', 100, text)
  assert.equal(d.d5, 3) // 2/5 = 40% > 30%
})

test('computeRuleScore 只采样头部 512KB：尾部标题不计入（防 OOM 口径）', async () => {
  // WHY: 采样上限是内存护栏，若实现退化成整读，超大文件的分数口径与 OOM 风险都会回归
  const fp = path.join(os.tmpdir(), `rule-score-test-${Date.now()}.md`)
  const content = 'x'.repeat(600 * 1024) + '\n# 尾部标题\n## 另一节\n'
  await fs.writeFile(fp, content, 'utf-8')
  try {
    const score = await computeRuleScore(fp, '.md', content.length)
    const headOnly = scoreRuleDimensions('.md', content.length, content.slice(0, RULE_SAMPLE_LIMIT)).score
    const fullRead = scoreRuleDimensions('.md', content.length, content).score
    assert.equal(score, headOnly)
    assert.notEqual(score, fullRead) // 整读会命中尾部标题（2.9 ≠ 3.6），确保采样真的生效
  } finally {
    await fs.unlink(fp).catch(() => {})
  }
})

test('computeRuleScore 读取失败抛错（由调用方跳过留 NULL）', async () => {
  await assert.rejects(() => computeRuleScore('/nonexistent/nope.md', '.md', 100))
})
