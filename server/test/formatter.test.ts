import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitle, cleanSummary } from '../src/formatter.js'

// v0.1.5 A3 检索返回体可读性 formatter 契约测试（纯函数，无需临时库隔离）。
// WHY：库内存在 title 长达 11 万字符的 JSON 脏数据，出口不清洗会污染
// Web 搜索 / MCP search_knowledge / 日报选篇的展示与 token 预算；
// 同时清洗绝不能误伤正常标题（零变化底线）。本文件钉住：
// ① 超长 JSON 脏串被压缩到 ≤161 且剥掉 JSON 语法；
// ② 正常语料原样返回（改坏正常标题 = 事故）；
// ③ 空白折叠与 160/161 截断刻度（恰好 160 不加省略号）；
// ④ JSON 前缀可读字段提取（title/name/summary 优先 + 嵌套一层）；
// ⑤ 非法 JSON 回退原文走纯截断（不抛错、不吞字）。

test('11 万字符 JSON 脏 title：清洗后 ≤161 且不含 JSON 语法', () => {
  const dirty = JSON.stringify({ a: 'x'.repeat(110000) })
  assert.ok(dirty.length > 100000, '前置：脏 title 确实超过 10 万字符探测上限')
  const out = cleanTitle(dirty)
  assert.ok(out.length <= 161, `长度 ${out.length} 必须压到 161 内`)
  assert.ok(!out.includes('{"'), '不得残留 JSON 对象语法')
  assert.ok(!out.includes('"'), '不得残留 JSON 引号')
  assert.ok(out.startsWith('x'), '应取到脏串内唯一可读字符串值')
})

test('超长 JSON 内带 title 字段：优先取可读字段而非第一个超长值', () => {
  const dirty = JSON.stringify({ title: '超长 JSON 内的可读标题', pad: 'x'.repeat(110000) })
  assert.equal(cleanTitle(dirty), '超长 JSON 内的可读标题')
})

test('正常 title 零变化（清洗不得误伤正常语料）', () => {
  assert.equal(cleanTitle('混合检索实践'), '混合检索实践')
  assert.equal(cleanTitle(''), '')
  assert.equal(cleanTitle('AgentFeed v0.1.5'), 'AgentFeed v0.1.5')
})

test('多空白折叠为单空格并 trim', () => {
  assert.equal(cleanTitle('混合  \n\t 检索\n\n\n实践  '), '混合 检索 实践')
})

test('恰好 160 字符不加省略号；161 字符截断加省略号（结果 ≤161）', () => {
  assert.equal(cleanTitle('a'.repeat(160)), 'a'.repeat(160))
  const out = cleanTitle('b'.repeat(161))
  assert.equal(out, 'b'.repeat(160) + '…')
  assert.equal(out.length, 161)
})

test('JSON 前缀取可读字段：title/name/summary 优先，嵌套一层可命中', () => {
  assert.equal(cleanTitle('{"title":"可读标题","x":1}'), '可读标题')
  assert.equal(cleanTitle('{"x":1,"name":"命名字段"}'), '命名字段')
  assert.equal(cleanTitle('{"data":{"summary":"内层摘要字段"},"x":1}'), '内层摘要字段')
})

test('非法 JSON 前缀：回退原文走纯截断（不抛错）', () => {
  assert.equal(cleanTitle('{broken json'), '{broken json')
  const out = cleanTitle('{broken ' + 'x'.repeat(200))
  assert.equal(out.length, 161)
})

test('cleanSummary：折叠空白 + 80 字符展示口径', () => {
  assert.equal(cleanSummary('摘要  \n 文本'), '摘要 文本')
  assert.equal(cleanSummary('s'.repeat(80)), 's'.repeat(80))
  assert.equal(cleanSummary('t'.repeat(100)), 't'.repeat(80) + '…')
})

test('幂等：二次清洗不产生漂移（MCP 双保险的前提）', () => {
  const dirty = JSON.stringify({ title: '可读标题', pad: 'x'.repeat(110000) })
  assert.equal(cleanTitle(cleanTitle(dirty)), cleanTitle(dirty))
  assert.equal(cleanTitle(cleanTitle('y'.repeat(300))), cleanTitle('y'.repeat(300)))
  assert.equal(cleanSummary(cleanSummary('u'.repeat(200))), cleanSummary('u'.repeat(200)))
})
