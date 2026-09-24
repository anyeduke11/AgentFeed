import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import http from 'node:http'

// P2 精炼失败根治契约测试（content_too_long_for_model 自愈 + 窗口预算对齐）。
// WHY：content_too_long 是确定性失败——实测 prompt 8944 tokens / completion 1 / stop_reason=length，
// 模型把预算耗在输入上，输出 1 token 即被掐断。同 prompt 重试物理上必然复现，
// 存量 4018 篇 failed 即此死积压。钉死三条契约：
// ① 短拒答必须换输入自愈（强制结构化压缩重试一次），而不是落 failed 等人工重试再败；
// ② not_json 等非确定性失败不得触发自愈（浪费一次调用）；
// ③ 压缩后仍拒答必须落 content_too_long 终态（中文 hint 落库），绝不无限重试烧 token。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-distill-heal-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { processJob } = await import('../src/llm/llmWorker.js')
const { resetModelsInstance } = await import('../src/llm/index.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

/** 假 OpenAI 兼容流式网关：按调用次序回放脚本化响应，记录每次请求体 */
function fakeGateway(script: Array<{ content: string; completionTokens?: number }>) {
  const bodies: string[] = []
  let call = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      bodies.push(raw)
      const step = script[Math.min(call, script.length - 1)]
      call++
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' }, index: 0 }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.content }, index: 0 }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: Math.ceil(raw.length / 2.2), completion_tokens: step.completionTokens ?? Math.ceil(step.content.length / 2.2) } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return { server, bodies, calls: () => call }
}

async function setupProvider(name: string, port: number) {
  const db = await getDb()
  await (await db.prepare(`INSERT OR REPLACE INTO config (key, value, type) VALUES ('ai.providers', ?, 'json')`)).run([
    JSON.stringify([{ name, baseUrl: `http://127.0.0.1:${port}`, models: ['fake-model'], apiKey: 'test-key' }])
  ])
  resetModelsInstance()
}

async function insertFileWithBody(body: string): Promise<number> {
  const db = await getDb()
  const filePath = path.join(DATA_TMP, `heal-${Math.random().toString(36).slice(2)}.md`)
  await fs.writeFile(filePath, body)
  return Number((await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, status) VALUES (?, ?, 'md', ?, 'active')`
  )).run([filePath, path.basename(filePath), '自愈测试文件'])).lastID)
}

async function llmState(fileId: number): Promise<string | null> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT llm_state FROM files WHERE id = ?')).get(fileId) as any
  return row?.llm_state ?? null
}

/** 最近一条蒸馏终态日志（蒸馏成功后 enqueueEmbed 会同步写 embed 日志，需按状态区分）。
 *  注意 @homeofthings/sqlite3 多参数必须数组包裹（.get([a, b])），逗号传参会静默丢参 */
async function distillLog(fileId: number, status: string): Promise<any> {
  const db = await getDb()
  return await (await db.prepare('SELECT * FROM llm_call_logs WHERE file_id = ? AND status = ? ORDER BY id DESC LIMIT 1')).get([fileId, status]) as any
}

const WIKI_OK = JSON.stringify({
  title: '自愈成功的词条', summary: '第一次短拒答触发压缩自愈，第二次返回完整词条。', points: ['要点一'],
  entities: [], relations: [], domain: '', tags: ['测试'],
})

test('自愈成功：短拒答 → 强制压缩重建 prompt 重试 → 蒸馏成功（换输入而非换运气）', async () => {
  // 4K chars 正文：低于 8K 预算 60% 触发线（≈6K chars）→ 首调走原文；短拒答后 forceCompress 重建
  const body = '# 长文\n\n' + '这是一段中等长度的正文，首调不应触发压缩判定。'.repeat(180)
  const gw = fakeGateway([
    { content: '嗯', completionTokens: 1 },   // 模拟 1-token 短拒答（stop_reason=length 形态）
    { content: WIKI_OK },                      // 压缩后成功
  ])
  const server = gw.server
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  await setupProvider('heal-ok', port)
  const fileId = await insertFileWithBody(body)

  await processJob({ id: 0, fileId, provider: 'heal-ok', model: 'fake-model', prompt: '', options: {} } as any)

  try {
    assert.equal(gw.calls(), 2, '短拒答后必须恰好自愈重试一次（共 2 次调用）')
    assert.ok(!gw.bodies[0].includes('结构化采样压缩'), '首调预算内不压缩（原文直出）')
    assert.ok(gw.bodies[1].includes('结构化采样压缩'), '重试必须走强制压缩路径（forceCompress 标记可见）')
    assert.equal(await llmState(fileId), 'done', '自愈成功必须落 done')
    assert.ok(await distillLog(fileId, 'success'), '蒸馏成功必须落调用日志')
  } finally {
    server.close()
  }
})

test('not_json 不自愈：非确定性失败直接落终态，不浪费第二次调用', async () => {
  // 300+ 字符非 JSON：short 判定（<200）为 false → not_json → 不自愈
  const noise = '模型输出格式漂移，这一段不是 JSON。'.repeat(30)
  const gw = fakeGateway([{ content: noise }])
  const server = gw.server
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  await setupProvider('heal-notjson', port)
  const fileId = await insertFileWithBody('短文，不触发压缩。')

  // processDistill 吞异常落库为终态（队列靠 events 回调感知失败，从不靠异常传播），断言落库结果而非 rejection
  await processJob({ id: 0, fileId, provider: 'heal-notjson', model: 'fake-model', prompt: '', options: {} } as any)
  try {
    assert.equal(gw.calls(), 1, 'not_json 不得触发压缩自愈（只有 1 次调用）')
    assert.equal(await llmState(fileId), 'failed')
    const log = await distillLog(fileId, 'failed')
    assert.ok(String(log.error).includes('llm_output_not_json'))
  } finally {
    server.close()
  }
})

test('压缩后仍拒答 → content_too_long 终态 + 中文 hint 落库（绝不无限自愈烧 token）', async () => {
  const gw = fakeGateway([
    { content: '嗯', completionTokens: 1 },
    { content: '嗯', completionTokens: 1 },
  ])
  const server = gw.server
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  await setupProvider('heal-stuck', port)
  const fileId = await insertFileWithBody('# 长文\n\n' + '内容依然超窗。'.repeat(2000))

  // 同 t2：失败落库为终态，断言 calls 与落库错误而非 rejection
  await processJob({ id: 0, fileId, provider: 'heal-stuck', model: 'fake-model', prompt: '', options: {} } as any)
  try {
    assert.equal(gw.calls(), 2, '自愈至多一次（共 2 次调用后落终态）')
    assert.equal(await llmState(fileId), 'failed')
    const log = await distillLog(fileId, 'failed')
    assert.ok(String(log.error).includes('content_too_long_for_model'), '错误码必须落库')
    assert.ok(String(log.error).includes('上下文窗口'), '中文 hint 必须随 friendlyLlmError 落库（前端失败泳道可读）')
  } finally {
    server.close()
  }
})
