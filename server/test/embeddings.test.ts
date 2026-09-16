import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guessModelType, cosine } from '../src/llm/embeddings.js'

test('guessModelType：常见向量模型命名（embed/bge/nomic/gte/minilm）识别为 embedding', () => {
  // WHY: 向量化必须走向量模型，误用对话模型会让 /embeddings 报错且蒸馏后自动向量化静默失败
  assert.equal(guessModelType('nomic-embed-text'), 'embedding')
  assert.equal(guessModelType('bge-m3'), 'embedding')
  assert.equal(guessModelType('text-embedding-3-small'), 'embedding')
  assert.equal(guessModelType('gte-large-zh'), 'embedding')
  assert.equal(guessModelType('all-MiniLM-L6-v2'), 'embedding')
})

test('guessModelType：对话模型与未知命名回退 chat', () => {
  assert.equal(guessModelType('qwen2.5'), 'chat')
  assert.equal(guessModelType('llama3.1'), 'chat')
  assert.equal(guessModelType('deepseek-r1'), 'chat')
})

test('cosine：同向为 1、正交为 0、反向为 -1', () => {
  // WHY: 相似度排序是语义检索的唯一依据，方向算错会让 Top N 完全失真
  assert.equal(cosine([1, 0], [2, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [-1, 0]), -1)
})

test('cosine：非法输入（空向量/维度不一致/零向量）返回 0 而非 NaN', () => {
  assert.equal(cosine([], [1, 2]), 0)
  assert.equal(cosine([1, 2], [1, 2, 3]), 0)
  assert.equal(cosine([0, 0], [1, 2]), 0)
})
