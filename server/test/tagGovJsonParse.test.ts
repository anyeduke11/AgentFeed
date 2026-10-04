import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// parseLlmJson 是语义归组/二级选拔两条 LLM 管线的单点故障面。必须钉死的不变量：
// 1. 模型在字符串值内输出裸引号（给术语加引号，reason 高发）→ 修复后整批可解析，
//    不再连带处死同批已正确生成的组（2026-10-03 真库 12/121 批稳定复现）
// 2. 截断/残缺输出必须保持 null（fail loud）——修复不得把残缺洗成假成功
// 3. 正常输出（含已转义 \"）语义不得被修复路径改变；既有两级定位 fallback 不回退

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-tagparse-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { parseLlmJson } = await import('../src/llm/tagGovernance.js')

test('事故现场形态：reason 值内裸引号不再炸整批，两组俱全且内容保留', () => {
  const raw = '{"groups":[' +
    '{"canonical":"金融监管","members":["银保监会","银保监会监管"],"reason":"银保监会为金融监管机构，"银保监会监管"为同义从属表达，均归入锚点词"金融监管""},' +
    '{"canonical":"错误处理","members":["错误码处理","错误码排查"],"reason":"均为错误处理的细分/同义变体"}]}'
  const data = parseLlmJson(raw)
  assert.ok(data, '值内裸引号必须被修复为可解析')
  assert.equal(data.groups.length, 2, '修复必须救回整批（含已正确生成的第二组）')
  assert.deepEqual(data.groups[1].members, ['错误码处理', '错误码排查'])
  assert.match(data.groups[0].reason, /金融监管/)
})

test('终结符歧义：值末裸引号紧邻真终结符时仍正确收口', () => {
  const raw = '{"groups":[{"canonical":"AI Agent","members":["AI 代理","AI 助手"],"reason":"同义变体，归入锚点词"AI Agent""}]}'
  const data = parseLlmJson(raw)
  assert.ok(data, '连续裸引号+真终结符形态必须可解析')
  assert.equal(data.groups[0].canonical, 'AI Agent')
})

test('正常输出零影响：含已转义 \\" 的值原样解析，不受修复路径污染', () => {
  const raw = '{"groups":[{"canonical":"RAG","members":["RAG 检索"],"reason":"引用 \\"锚点\\" 属正常转义"}]}'
  const data = parseLlmJson(raw)
  assert.ok(data)
  assert.equal(data.groups[0].reason, '引用 "锚点" 属正常转义')
})

test('截断/残缺输出保持 null：修复不得制造假成功', () => {
  // 字符串未闭合 + 花括号失衡（finish=length 形态）
  assert.equal(parseLlmJson('{"groups":[{"canonical":"RAG","members":["RAG 检'), null)
  // 无任何 JSON 起始
  assert.equal(parseLlmJson('模型拒绝输出'), null)
})

test('既有两级定位不回退：代码围栏/前置说明/顶层数组仍可解析', () => {
  const fenced = '```json\n{"groups":[{"canonical":"RAG","members":["RAG 检索增强"],"reason":"同义"}]}\n```'
  assert.equal(parseLlmJson(fenced)?.groups.length, 1)
  const prosed = '好的，以下是结果：{"groups":[{"canonical":"RAG","members":["RAG 检索增强"],"reason":"同义"}]}'
  assert.equal(parseLlmJson(prosed)?.groups.length, 1)
  const toplevel = '[{"canonical":"RAG","members":["RAG 检索增强","RAG增强"],"reason":"同义"}]'
  assert.equal(parseLlmJson(toplevel)?.length, 1)
})
