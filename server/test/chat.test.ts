import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// I1 人侧对话桥梁（routes/chat.ts）契约测试。
// WHY：对话是知识库唯一的人侧写入口——必须钉住：
// ① SSE 事件序列 meta→delta*→done（流式契约，前端按帧解析，顺序错即 UI 撕裂）；
// ② 引用 refs 来自真实检索（词条 id 供 /reader/<id> 跳转，伪引用 = 幻觉导航）；
// ③ 零命中必须如实（refs 空/仅放宽结果，不得伪装命中）；
// ④ LLM 失败降级 fallback 保可用 + llm_call_logs 落 failed 行（G1 成本可见）+ 不落 assistant 消息
//    （半截会话污染会话回放）；
// ⑤ 领域陪练官 system prompt 与 MCP getContext 同一内核（aggregateDomainContext），域间互不串台；
// ⑥ 对话只读红线：除 chat_messages/llm_call_logs 外 files/wiki_entries_meta 行数与内容分毫不动。
// llmFn 注入点对齐 profile/distill.ts 模式：skill 与检索管线全部真实跑，只 mock 网络。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 context.test.ts，不种 FTS/向量，检索走 files LIKE 路）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-chat-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const {
  chatRouter, setChatLlmFn, buildChatSystemPrompt, buildSkillPrompt, extractAnswer
} = await import('../src/routes/chat.js')
const { aggregateDomainContext } = await import('../src/context.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

// ---- 直调路由 handler（同 profileRoutes.test.ts 模式，不起 HTTP 服务） ----
function handlerOf(method: string, url: string) {
  const layer = (chatRouter as any).stack.find((l: any) =>
    l.route && l.route.methods?.[method.toLowerCase()] &&
    (l.route.path === url || (l.route.path.includes(':') && url.startsWith(l.route.path.split(':')[0]) && new RegExp('^' + l.route.path.replace(/:[^/]+/g, '[^/]+') + '$').test(url)))
  )
  assert.ok(layer, `路由 ${method} ${url} 必须存在`)
  return (layer.route as any).stack[0].handle
}

/** SSE 直调：捕获 res.write 的 data: 帧为事件序列 */
async function sseCall(body: any) {
  const out = { status: 0, events: [] as any[], ended: false }
  const res: any = {
    writeHead(code: number) { out.status = code; return res },
    write(frame: string) {
      for (const line of String(frame).split('\n')) {
        if (line.startsWith('data: ')) out.events.push(JSON.parse(line.slice(6)))
      }
      return true
    },
    end() { out.ended = true; return res },
    status(code: number) { out.status = code; return res },
    json(payload: any) { out.events.push({ type: '__json__', payload }); return res },
  }
  await handlerOf('post', '/')(reqOf(body), res)
  return out
}

function reqOf(body: any, params: any = {}, query: any = {}) {
  return { method: 'get', body, params, query }
}

let fileSeq = 0
/** 种一个 active 文件 + 蒸馏词条（挂靠给定领域），返回 files.id */
async function seedFile(
  domainId: number, title: string, summary: string,
  opts?: { quality?: number | null, ruleScore?: number | null, status?: string }
): Promise<number> {
  const db = await getDb()
  fileSeq += 1
  const fr = await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, summary, domain_id, rule_score, file_mtime, status)
     VALUES (?, ?, 'md', ?, ?, ?, ?, '2026-09-10 10:00:00', ?)`
  )).run([`/chat/f${fileSeq}.md`, `f${fileSeq}`, title, summary, domainId, opts?.ruleScore ?? 5, opts?.status ?? 'active'])
  const fileId = Number(fr.lastID)
  await (await db.prepare(
    `INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, quality_score, distilled_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-10 12:00:00')`
  )).run([fileId, `/wiki/chat/f${fileSeq}.md`, title, summary, opts?.quality ?? 5])
  return fileId
}

async function seedDomain(name: string): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare('INSERT INTO domains (name) VALUES (?)')).run([name])
  return Number(r.lastID)
}

async function countOf(sql: string, params: any[] = []): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare(sql)).get(params) as any
  return Number(r.n)
}

/** 只读红线指纹：files / wiki_entries_meta 行数 + 内容总字符量（任何写入/篡改都会改变） */
async function readonlyFingerprint(): Promise<string> {
  const db = await getDb()
  const f = await (await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(COALESCE(title,'')) + length(COALESCE(summary,''))), 0) AS c FROM files`
  )).get() as any
  const w = await (await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(COALESCE(title,'')) + length(COALESCE(summary,''))), 0) AS c FROM wiki_entries_meta`
  )).get() as any
  return `files:${f.n}/${f.c};wiki:${w.n}/${w.c}`
}

// ---- 种子数据：两个领域 + 词条 + 挂靠标签 + 阅读记录（skill=connect 素材） ----
const dA = await seedDomain('chat-域甲')
const dB = await seedDomain('chat-域乙')
const fHit = await seedFile(dA, '混合检索怎么工作原理详解', '三路 RRF 融合召回的检索说明')
await seedFile(dA, '域甲陪练词条Alpha', '领域甲的画像要点甲', { quality: 9 })
await seedFile(dA, '域甲陪练词条Beta', '领域甲的画像要点乙', { quality: 8 })
await seedFile(dB, '域乙专属词条Gamma', '领域乙的画像要点丙', { quality: 9 })
const db0 = await getDb()
await (await db0.prepare('INSERT INTO tags (name, level, domain_id) VALUES (?, ?, ?)')).run(['域甲标签一', 'primary', dA])
await (await db0.prepare('INSERT INTO tags (name, level, domain_id) VALUES (?, ?, ?)')).run(['域乙标签二', 'primary', dB])
await (await db0.prepare("INSERT INTO read_history (file_id, path, source) VALUES (?, '/chat/f1.md', 'reader')")).run([fHit])

const FINGERPRINT_BEFORE = await readonlyFingerprint()

// ---- fake LLM：默认返回长文本信封（多 delta）；用例内按需覆写 ----
const ANSWER_TEXT = '这是库内锚定的回答。'.repeat(8) // >40 字符 → 至少 2 个 delta 块
setChatLlmFn(async () => ({ text: JSON.stringify({ answer: ANSWER_TEXT }), usage: { input: 10, output: 20 } }))

test('正常问答：SSE 序列 meta→delta*→done；refs 含种好的词条；双行落库；调用日志 success', async () => {
  const logsBefore = await countOf('SELECT COUNT(*) AS n FROM llm_call_logs')
  const out = await sseCall({ message: '混合检索怎么工作' })
  assert.equal(out.status, 200)
  assert.ok(out.ended, 'SSE 必须 end（不留悬挂连接）')

  const types = out.events.map(e => e.type)
  assert.equal(types[0], 'meta', '首事件必须是 meta（引用清单先行）')
  assert.equal(types[types.length - 1], 'done', '末事件必须是 done')
  const deltas = out.events.filter(e => e.type === 'delta')
  assert.ok(deltas.length >= 2, '长回答应分多块推送（模拟流式），单块即协议退化')
  assert.equal(deltas.map(d => d.text).join(''), ANSWER_TEXT, 'delta 顺序拼接 = 完整回答（解包 JSON 信封后）')

  const meta = out.events[0]
  assert.ok(meta.refs.some((r: any) => r.id === fHit), 'refs 必须含种好的词条（引用可跳阅读器）')

  const done = out.events[out.events.length - 1]
  assert.equal(typeof done.sessionId, 'string')

  const msgs = await (await db0.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id')).all([done.sessionId]) as any[]
  assert.equal(msgs.length, 2, 'user + assistant 双行落库')
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[1].content, ANSWER_TEXT)

  const logsAfter = await countOf('SELECT COUNT(*) AS n FROM llm_call_logs')
  assert.equal(logsAfter - logsBefore, 1, '恰好一行调用日志')
  const log = await (await db0.prepare('SELECT * FROM llm_call_logs ORDER BY id DESC LIMIT 1')).get() as any
  assert.equal(log.status, 'success')
  assert.equal(log.file_id, null, '对话调用 file_id 必须为 null（无 FK 挂靠，进 G1 成本视图）')
  assert.equal(log.total_tokens, 30)
})

test('零命中：refs 空或仅放宽结果；fake 文本原样流式；仍双行落库', async () => {
  const out = await sseCall({ message: '量子纠缠不存在于库中的词ZZZ' })
  assert.equal(out.status, 200)
  const meta = out.events.find(e => e.type === 'meta')
  assert.ok(meta, '零命中仍须发 meta 事件（协议不缺帧）')
  assert.equal(meta.refs.length, 0, '放宽检索也未命中 → refs 空（不得伪造引用）')
  const deltas = out.events.filter(e => e.type === 'delta')
  assert.equal(deltas.map(d => d.text).join(''), ANSWER_TEXT, 'fake 返回文本原样流式')
  assert.equal(out.events[out.events.length - 1].type, 'done')
})

test('LLM 失败：fallback 事件返回检索列表；llm_call_logs failed；不落 assistant 消息', async () => {
  const logsBefore = await countOf('SELECT COUNT(*) AS n FROM llm_call_logs WHERE status != \'success\'')
  const prev = await countOf("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'assistant'")
  setChatLlmFn(async () => { throw new Error('mock_llm_down') })
  try {
    const out = await sseCall({ message: '混合检索怎么工作' })
    const types = out.events.map(e => e.type)
    assert.ok(types.includes('fallback'), 'LLM 失败必须降级 fallback（可用性优先）')
    assert.ok(!types.includes('done'), '失败路径无回答，不发 done')
    const fb = out.events.find(e => e.type === 'fallback')
    assert.ok(fb.results.some((r: any) => r.id === fHit), 'fallback 带检索结果列表（保可用）')

    const logsAfter = await countOf('SELECT COUNT(*) AS n FROM llm_call_logs WHERE status != \'success\'')
    assert.equal(logsAfter - logsBefore, 1, 'failed 调用日志必须落库（fail loud + G1 成本可见）')
    const log = await (await db0.prepare("SELECT * FROM llm_call_logs WHERE status != 'success' ORDER BY id DESC LIMIT 1")).get() as any
    assert.ok(String(log.error).includes('mock_llm_down'))

    const now = await countOf("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'assistant'")
    assert.equal(now, prev, 'LLM 失败不得落 assistant 消息（半截会话污染回放）')
  } finally {
    setChatLlmFn(async () => ({ text: JSON.stringify({ answer: ANSWER_TEXT }), usage: { input: 10, output: 20 } }))
  }
})

test('领域切换：buildChatSystemPrompt 含对应域 summaryText 且互不相同（陪练官不串台）', async () => {
  const ctxA = await aggregateDomainContext('chat-域甲')
  const ctxB = await aggregateDomainContext('chat-域乙')
  assert.ok(ctxA && ctxB)
  const pA = buildChatSystemPrompt('chat-域甲', ctxA, ['域甲标签一'])
  const pB = buildChatSystemPrompt('chat-域乙', ctxB, ['域乙标签二'])
  assert.ok(pA.includes('领域陪练官') && pA.includes('chat-域甲'), 'domain 给定时必须是该域陪练官人格')
  assert.ok(pA.includes(ctxA.summaryText), '须注入该域画像（与 getContext 同一内核）')
  assert.ok(pA.includes('域甲标签一') && pA.includes('域乙标签二') === false)
  assert.ok(pB.includes(ctxB.summaryText))
  assert.notEqual(pA, pB, '两域 system prompt 必须互不相同')
  // 通用人格：domain 缺省时仍锚定库内
  const pG = buildChatSystemPrompt(undefined, null, [])
  assert.ok(pG.includes('对话助手') && pG.includes('如实说明'))

  // 路由层：真实走一遍带 domain 的问答，fake 透传 prompt 验证陪练官 + 挂靠标签进入 LLM 入参
  let captured = ''
  setChatLlmFn(async (_p: string, _m: string, prompt: string) => { captured = prompt; return { text: 'ok' } })
  try {
    await sseCall({ message: '域甲陪练词条Alpha 是什么', domain: 'chat-域甲' })
    assert.ok(captured.includes('chat-域甲') && captured.includes('领域陪练官'), '陪练官人格进入 prompt')
    assert.ok(captured.includes('域甲标签一'), '挂靠标签进入 prompt')
    assert.ok(!captured.includes('chat-域乙'), '不得串台到其他领域')
  } finally {
    setChatLlmFn(async () => ({ text: JSON.stringify({ answer: ANSWER_TEXT }) }))
  }
})

test('skill=overview：透传 prompt 侧验证含 topEntries 标题；其余 3 个 skill 模板直测含领域上下文', async () => {
  // overview：fake 透传 prompt 作为回答 → SSE delta 拼接即 prompt 全文
  setChatLlmFn(async (_p: string, _m: string, prompt: string) => ({ text: prompt }))
  try {
    const out = await sseCall({ message: '速览一下', domain: 'chat-域甲', skill: 'overview' })
    const text = out.events.filter(e => e.type === 'delta').map(d => d.text).join('')
    assert.ok(text.includes('域甲陪练词条Alpha') && text.includes('域甲陪练词条Beta'), 'overview 回答须含 topEntries 标题')
    const meta = out.events[0]
    assert.ok(meta.refs.length > 0, 'overview 的引用 chips 来自 topEntries')

    // explain：附 fileId 时读该词条入 prompt
    const pExplain = buildSkillPrompt('explain', '讲讲', { domainCtx: await aggregateDomainContext('chat-域甲'), entry: { fileId: fHit, title: '混合检索怎么工作原理详解', summary: '三路 RRF 融合召回' } })
    assert.ok(pExplain.includes('混合检索怎么工作原理详解') && pExplain.includes('(id:' + fHit + ')'), 'explain 须带目标词条与 id')
    // connect：基于近 10 条打开记录
    const pConnect = buildSkillPrompt('connect', '串一下', { domainCtx: null, recentReads: [{ fileId: fHit, title: '混合检索怎么工作原理详解', domainName: 'chat-域甲' }] })
    assert.ok(pConnect.includes('最近打开记录') && pConnect.includes('混合检索怎么工作原理详解'))
    // quiz：领域 top 词条出题
    const pQuiz = buildSkillPrompt('quiz', '考我', { domainCtx: await aggregateDomainContext('chat-域甲') })
    assert.ok(pQuiz.includes('域甲陪练词条Alpha') && pQuiz.includes('3 道自测题'))
  } finally {
    setChatLlmFn(async () => ({ text: JSON.stringify({ answer: ANSWER_TEXT }) }))
  }
})

test('会话端点：sessions 列表聚合预览；sessions/:id 回放全量消息', async () => {
  // 复用「正常问答」的落库会话
  const listRes: any = {}
  await handlerOf('get', '/sessions')(reqOf(undefined), mockJsonRes(listRes))
  assert.equal(listRes.json.success, true)
  assert.ok(listRes.json.sessions.length >= 1, '已有会话')
  const s = listRes.json.sessions[0]
  assert.ok(s.sessionId && typeof s.preview === 'string' && s.msgCount >= 2)

  const detailRes: any = {}
  await handlerOf('get', '/sessions/:id')(reqOf(undefined, { id: s.sessionId }), mockJsonRes(detailRes))
  assert.equal(detailRes.json.success, true)
  assert.ok(detailRes.json.messages.length >= 2)
  assert.equal(detailRes.json.messages[0].role, 'user')
})

test('对话只读红线：全程跑完后 files / wiki_entries_meta 行数与内容指纹不变', async () => {
  assert.equal(await readonlyFingerprint(), FINGERPRINT_BEFORE, '对话不得写库内知识表（只允许 chat_messages/llm_call_logs）')
})

test('extractAnswer：信封解包 + 围栏剥离 + 非 JSON 原文兜底（格式漂移不丢回答）', async () => {
  assert.equal(extractAnswer('{"answer":"甲"}'), '甲')
  assert.equal(extractAnswer('```json\n{"answer":"乙"}\n```'), '乙')
  assert.equal(extractAnswer('{"text":"丙"}'), '丙', '未知字段名时取首个非空字符串')
  assert.equal(extractAnswer('普通文本回答'), '普通文本回答', '非 JSON 原文原样返回')
  // 截断信封兜底（I1 抽检实测发现）：max_tokens 截断导致 {"answer":"... 无闭合——前缀不得泄漏到前端
  assert.equal(extractAnswer('{"answer":"被截断的回答'), '被截断的回答', '截断信封剥前缀')
  assert.equal(extractAnswer('{"answer": "尾部恰好闭合"}, '), '尾部恰好闭合', '值已闭合但对象尾随逗号垃圾（剥尾巴）')
})

function mockJsonRes(sink: any) {
  const res: any = {
    status(code: number) { sink.status = code; return res },
    json(payload: any) { sink.json = payload; return res },
  }
  return res
}
