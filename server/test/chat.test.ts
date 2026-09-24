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
// 批次 B 红线口径（见文件尾红线用例）：蒸馏入库合法新增 wiki_entries_meta（imported），files 仍须分毫不动

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

test('回放引用持久化：assistant 落库带 refs JSON，回放返回与 meta.refs 一致（历史会话引用 chips 可还原）', async () => {
  const out = await sseCall({ message: '混合检索怎么工作' })
  const meta = out.events.find(e => e.type === 'meta')
  const done = out.events[out.events.length - 1]
  const row = await (await db0.prepare(
    "SELECT refs FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1"
  )).get([done.sessionId]) as any
  assert.ok(row.refs && row.refs.startsWith('['), 'assistant 落库必须带 refs JSON（否则回放引用丢失）')

  const detailRes: any = {}
  await handlerOf('get', '/sessions/:id')(reqOf(undefined, { id: done.sessionId }), mockJsonRes(detailRes))
  const a = detailRes.json.messages.find((m: any) => m.role === 'assistant')
  assert.deepEqual(a.refs, meta.refs, '回放 refs 必须与实时 meta.refs 同构')
})

test('存量回填：refs NULL 的旧 assistant 消息按提问重跑检索、按 [n] 重建引用并写回缓存', async () => {
  const db = await getDb()
  const sid = 'legacy-refs-1'
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run([sid, 'user', '混合检索怎么工作'])
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run([sid, 'assistant', '依据 [1] 的说明，三路 RRF 融合召回……'])

  const detailRes: any = {}
  await handlerOf('get', '/sessions/:id')(reqOf(undefined, { id: sid }), mockJsonRes(detailRes))
  const a = detailRes.json.messages.find((m: any) => m.role === 'assistant')
  assert.ok(Array.isArray(a.refs) && a.refs.length === 1 && a.refs[0].id === fHit, '旧消息引用按回答 [n] 重建为检索命中词条')
  assert.equal(a.refs[0].title, '混合检索怎么工作原理详解')

  const row = await (await db0.prepare(
    "SELECT refs FROM chat_messages WHERE session_id = ? AND role = 'assistant'"
  )).get([sid]) as any
  assert.ok(row.refs != null, '重建结果必须写回该行（下次回放不再重跑检索）')
})

test('存量回填边界：超界 [n] 忽略、无标记落 []、[复盘] 前缀不触发回填', async () => {
  const db = await getDb()
  const sid = 'legacy-refs-2'
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run([sid, 'user', '混合检索怎么工作'])
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run([sid, 'assistant', '见 [99]（超界编号）与普通叙述'])
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run([sid, 'assistant', '[复盘] 要点……'])

  const detailRes: any = {}
  await handlerOf('get', '/sessions/:id')(reqOf(undefined, { id: sid }), mockJsonRes(detailRes))
  const msgs = detailRes.json.messages.filter((m: any) => m.role === 'assistant')
  assert.deepEqual(msgs[0].refs, [], '超界编号不得伪造引用')
  assert.deepEqual(msgs[1].refs, [], '复盘摘要无引用语义，保持空数组')

  const recap = await (await db0.prepare(
    "SELECT refs FROM chat_messages WHERE session_id = ? AND content LIKE '[复盘]%'"
  )).get([sid]) as any
  assert.equal(recap.refs, null, '复盘行保持 NULL（语义即无引用，不写缓存）')
})

// ---- 批次 A：会话管理（元数据基座 / 归档 / 标记 / 搜索 / 删除留痕） ----

test('会话元数据：POST 自动落 chat_sessions（title=首问截断、domain 标记）；续问不覆盖', async () => {
  const out = await sseCall({ message: '元数据首问自动标题甲乙丙', domain: 'chat-域甲' })
  const done = out.events[out.events.length - 1]
  const row = await (await db0.prepare('SELECT title, domain FROM chat_sessions WHERE session_id = ?')).get([done.sessionId]) as any
  assert.ok(row, '问答必须自动落元数据行')
  assert.equal(row.title, '元数据首问自动标题甲乙丙')
  assert.equal(row.domain, 'chat-域甲')
  // 续问不带 domain：不得抹掉已有标记，也不得改 title
  await sseCall({ message: '续问不覆盖元数据', sessionId: done.sessionId })
  const row2 = await (await db0.prepare('SELECT title, domain FROM chat_sessions WHERE session_id = ?')).get([done.sessionId]) as any
  assert.equal(row2.title, row.title)
  assert.equal(row2.domain, 'chat-域甲')
})

test('PATCH /sessions/:id：title/domain/tags 更新生效；越界与空更新 400；老会话补建元数据行', async () => {
  // 用已有真实会话（正常问答落库的）验证老会话首次标记自动补建
  const list = await (await db0.prepare('SELECT session_id FROM chat_messages GROUP BY session_id LIMIT 1')).get() as any
  const sid = String(list.session_id)
  const patch = handlerOf('patch', '/sessions/:id')
  const sink: any = {}
  await patch(reqOf({ title: '改名后的标题', domain: 'chat-域乙', tags: ['标签甲', '标签甲', '标签乙'] }, { id: sid }), mockJsonRes(sink))
  assert.equal(sink.json.success, true, 'PATCH 必须成功（含老会话补建）')
  assert.deepEqual(sink.json.session.tags, ['标签甲', '标签乙'], 'tags 去重')
  const row = await (await db0.prepare('SELECT title, domain, tags FROM chat_sessions WHERE session_id = ?')).get([sid]) as any
  assert.equal(row.title, '改名后的标题')
  assert.equal(row.domain, 'chat-域乙')

  const bad1: any = {}; await patch(reqOf({ title: '' }, { id: sid }), mockJsonRes(bad1))
  assert.equal(bad1.status, 400, '空 title 必须 400')
  const bad2: any = {}; await patch(reqOf({ tags: Array.from({ length: 21 }, (_, i) => '标签' + i) }, { id: sid }), mockJsonRes(bad2))
  assert.equal(bad2.status, 400, '超 20 项 tags 必须 400')
  const bad3: any = {}; await patch(reqOf({}, { id: sid }), mockJsonRes(bad3))
  assert.equal(bad3.status, 400, '无可更新字段必须 400')
})

test('归档：archived=1 后默认列表不含、归档视图可见', async () => {
  const list = await (await db0.prepare('SELECT session_id FROM chat_messages GROUP BY session_id LIMIT 1')).get() as any
  const sid = String(list.session_id)
  await handlerOf('patch', '/sessions/:id')(reqOf({ archived: true }, { id: sid }), mockJsonRes({}))
  const active: any = {}; await handlerOf('get', '/sessions')(reqOf(undefined), mockJsonRes(active))
  assert.ok(!active.json.sessions.some((s: any) => s.sessionId === sid), '归档会话不得出现在默认列表')
  const archived: any = {}; await handlerOf('get', '/sessions')(reqOf(undefined, {}, { archived: '1' }), mockJsonRes(archived))
  const hit = archived.json.sessions.find((s: any) => s.sessionId === sid)
  assert.ok(hit && hit.archived === true, '归档视图必须含归档会话')
  // 还原为活跃，避免影响后续用例
  await handlerOf('patch', '/sessions/:id')(reqOf({ archived: false }, { id: sid }), mockJsonRes({}))
})

test('搜索 q：分别命中 title / 消息正文 / tags（唯一 token 不误伤）', async () => {
  const db = await getDb()
  const sid = 'search-target'
  await (await db.prepare('INSERT OR IGNORE INTO chat_sessions (session_id, title, tags) VALUES (?, ?, ?)')).run([sid, '搜索唯一标题QZX', JSON.stringify(['磁悬浮标签QZX'])])
  await (await db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)')).run([sid, 'user', '正文唯一词HNZC'])
  const get = (q: string) => new Promise<any>(async resolve => {
    const sink: any = {}
    await handlerOf('get', '/sessions')(reqOf(undefined, {}, { q }), mockJsonRes(sink))
    resolve(sink.json.sessions)
  })
  assert.ok((await get('搜索唯一标题QZX')).some((s: any) => s.sessionId === sid), 'q 命中 title')
  assert.ok((await get('正文唯一词HNZC')).some((s: any) => s.sessionId === sid), 'q 命中消息正文')
  assert.ok((await get('磁悬浮标签QZX')).some((s: any) => s.sessionId === sid), 'q 命中 tags')
})

test('删除会话：消息与元数据清除、删除日志落留痕、/deletions 可查、列表消失', async () => {
  const db = await getDb()
  const sid = 'delete-target'
  await (await db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', '待删首问KMLO')")).run([sid])
  await (await db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', '待删回答')")).run([sid])
  await (await db.prepare('INSERT OR IGNORE INTO chat_sessions (session_id, title) VALUES (?, ?)')).run([sid, '待删会话'])

  const delRes: any = {}
  await handlerOf('delete', '/sessions/:id')(reqOf(undefined, { id: sid }), mockJsonRes(delRes))
  assert.equal(delRes.json.success, true)
  assert.equal(delRes.json.deletedMessages, 2, '须报告删除的消息数')

  const msgLeft = await (await db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?')).get([sid]) as any
  const metaLeft = await (await db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE session_id = ?')).get([sid]) as any
  assert.equal(Number(msgLeft.n) + Number(metaLeft.n), 0, '消息与元数据必须清干净')

  const log = await (await db.prepare('SELECT preview, msg_count FROM chat_delete_logs WHERE session_id = ? ORDER BY id DESC LIMIT 1')).get([sid]) as any
  assert.ok(log && log.msg_count === 2 && String(log.preview).includes('KMLO'), '删除日志必须留 preview + msg_count')

  const dels: any = {}
  await handlerOf('get', '/deletions')(reqOf(undefined), mockJsonRes(dels))
  assert.equal(dels.json.success, true)
  assert.ok(dels.json.deletions.some((d: any) => d.sessionId === sid && d.msgCount === 2), '/deletions 必须可查到该留痕')

  const active: any = {}; await handlerOf('get', '/sessions')(reqOf(undefined), mockJsonRes(active))
  assert.ok(!active.json.sessions.some((s: any) => s.sessionId === sid), '已删会话不得出现在列表')
})

// ---- 批次 B：会话导出 / 蒸馏入库（复利） ----

// 导出目录 fail-closed 依赖已启用扫描根：种一个测试扫描根（DATA_TMP/scan，库内文件路径同域不越界）
const SCAN_ROOT = path.join(DATA_TMP, 'scan')
await (await db0.prepare('INSERT OR IGNORE INTO scan_roots (path, agent, enabled) VALUES (?, ?, 1)')).run([SCAN_ROOT, 'test'])

// 批次 B 前 wiki 基线（注册期求值 = 蒸馏未发生）：红线用例钉「wiki 新增必须全部来自蒸馏入库（imported）」
const WIKI_ROWS_BEFORE_B = await countOf('SELECT COUNT(*) AS n FROM wiki_entries_meta')
const WIKI_IMPORTED_BEFORE_B = await countOf(`SELECT COUNT(*) AS n FROM wiki_entries_meta WHERE source_type = 'imported'`)
const nonImportCharsRow = await (await db0.prepare(`SELECT COALESCE(SUM(length(COALESCE(title,'')) + length(COALESCE(summary,''))), 0) AS c FROM wiki_entries_meta WHERE source_type != 'imported'`)).get() as any
const WIKI_NON_IMPORT_CHARS_BEFORE_B = Number(nonImportCharsRow.c)

test('导出预览：markdown 组装（标题/来源/对话体）+ 默认目录解析到扫描根 conversations/，不写盘', async () => {
  const out = await sseCall({ message: '导出预览用会话QWERT' })
  const done = out.events[out.events.length - 1]
  const layer = (chatRouter as any).stack.find((l: any) => l.route?.methods?.get && l.route.path === '/sessions/:id/export/preview')
  assert.ok(layer, 'preview 路由必须存在')
  const sink: any = {}
  await layer.route.stack[0].handle(reqOf(undefined, { id: done.sessionId }, {}), mockJsonRes(sink))
  assert.equal(sink.json.success, true, sink.json.message)
  assert.ok(sink.json.markdown.includes('# 导出预览用会话QWERT'), '标题 = 首问')
  assert.ok(sink.json.markdown.includes(`**来源**: chat/${done.sessionId}`), '来源行遵循 import 解析约定')
  assert.ok(sink.json.markdown.includes(ANSWER_TEXT), '对话体含 assistant 消息')
  assert.ok(sink.json.dir.startsWith(SCAN_ROOT + path.sep) && sink.json.dir.endsWith('conversations'), `默认目录 = 扫描根下 conversations（实际 ${sink.json.dir}）`)
})

test('纯导出落盘：写文件成功且内容一致；越界目录 fail-closed 拒绝', async () => {
  const db = await getDb()
  const md = '# 导出落盘测试POIUY\n\n正文内容'
  const layer = (chatRouter as any).stack.find((l: any) => l.route?.methods?.post && l.route.path === '/sessions/:id/export')
  const sink: any = {}
  await layer.route.stack[0].handle(reqOf({ markdown: md }, { id: 'any-session' }), mockJsonRes(sink))
  assert.equal(sink.json.success, true, sink.json.message)
  const onDisk = await fs.readFile(sink.json.path, 'utf8')
  assert.equal(onDisk, md, '落盘内容与提交 markdown 一致')
  assert.ok(sink.json.path.startsWith(SCAN_ROOT + path.sep), '落盘路径必须在扫描根内')

  const bad: any = {}
  await layer.route.stack[0].handle(reqOf({ markdown: md, dir: DATA_TMP }, { id: 'any-session' }), mockJsonRes(bad))
  assert.equal(bad.status, 400, '越界目录必须 400（红线 1 fail-closed）')
  assert.ok(String(bad.json.message).includes('扫描根'))
})

test('蒸馏入库：落盘 + wiki_entries_meta 挂载 + FTS 同步；重复入库幂等 already；越界拒绝', async () => {
  const db = await getDb()
  const md = [
    '# 蒸馏入库词条ZXCVB',
    '',
    '**来源**: chat/distill-test',
    '**置信度**: 会话蒸馏',
    '**标签**: `#蒸馏标签MNBV`',
    '',
    '这是一篇由会话蒸馏生成的知识词条，用于验证挂载内核。',
    '',
    '## 要点',
    '- 知识点甲',
    '最后更新：2026-09-24',
  ].join('\n')
  const layer = (chatRouter as any).stack.find((l: any) => l.route?.methods?.post && l.route.path === '/sessions/:id/distill')
  const sink: any = {}
  await layer.route.stack[0].handle(reqOf({ markdown: md }, { id: 'distill-session' }), mockJsonRes(sink))
  assert.equal(sink.json.success, true, sink.json.message)
  assert.equal(sink.json.match, 'standalone')
  assert.ok(sink.json.entryId > 0, '须返回 wiki_entries_meta.id')
  const row = await (await db.prepare('SELECT title, summary, source_type FROM wiki_entries_meta WHERE id = ?')).get([sink.json.entryId]) as any
  assert.equal(row.title, '蒸馏入库词条ZXCVB')
  assert.equal(row.source_type, 'imported')
  assert.ok(String(row.summary).includes('用于验证挂载内核'), '摘要 = 元数据后首段正文（import 解析口径）')
  // FTS 同步：词条标题可被 FTS 命中
  const { ftsSearchWiki } = await import('../src/search/ftsIndex.js')
  const ftsHits = await ftsSearchWiki(db, '蒸馏入库词条ZXCVB', 10)
  assert.ok(ftsHits.includes(sink.json.entryId), '蒸馏词条必须同步进 FTS（检索立即可命中）')

  // 幂等：同路径重复入库 → already 不重复建行
  const again: any = {}
  await layer.route.stack[0].handle(reqOf({ markdown: md }, { id: 'distill-session' }), mockJsonRes(again))
  assert.equal(again.json.success, true)
  assert.equal(again.json.match, 'already', '同路径重复入库必须幂等跳过')
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM wiki_entries_meta WHERE title = ?')).get(['蒸馏入库词条ZXCVB']) as any
  assert.equal(Number(cnt.n), 1, '不得产生重复词条行')

  const bad: any = {}
  await layer.route.stack[0].handle(reqOf({ markdown: md, dir: DATA_TMP }, { id: 'distill-session' }), mockJsonRes(bad))
  assert.equal(bad.status, 400, '蒸馏落盘越界同样 fail-closed')
})

test('AI 蒸馏预览：distillLlmFn 注入 fake 生成结构化词条；失败回退纯导出（fail-soft）', async () => {
  const { setDistillLlmFn } = await import('../src/routes/chat.js')
  const out = await sseCall({ message: '蒸馏预览用会话LKJHGs' })
  const done = out.events[out.events.length - 1]
  const layer = (chatRouter as any).stack.find((l: any) => l.route?.methods?.get && l.route.path === '/sessions/:id/export/preview')
  let captured = ''
  setDistillLlmFn(async (_p: string, _m: string, prompt: string) => {
    captured = prompt
    return { text: JSON.stringify({ answer: '# 蒸馏出的知识点FGHJK\n\n**来源**: x\n\n蒸馏正文摘要。\n\n最后更新：2026-09-24' }), usage: { input: 5, output: 5 } }
  })
  try {
    const sink: any = {}
    await layer.route.stack[0].handle(reqOf(undefined, { id: done.sessionId }, { refined: '1' }), mockJsonRes(sink))
    assert.equal(sink.json.success, true, sink.json.message)
    assert.equal(sink.json.refined, true, '蒸馏成功须标记 refined=true')
    assert.ok(sink.json.markdown.startsWith('# 蒸馏出的知识点FGHJK'), '预览 = AI 蒸馏产物')
    assert.ok(captured.includes('蒸馏预览用会话LKJHGs'), '会话记录须进入蒸馏 prompt')
    assert.ok(captured.includes('**标签**'), 'prompt 约定 import 解析口径的元数据格式')
  } finally {
    // 还原为会抛错的默认链路外 fake（不触网）：后续用例不用 refined
    setDistillLlmFn(async () => { throw new Error('distill disabled in tests') })
  }
  // 失败回退：refined=1 但 LLM 挂 → 回退纯导出，refined=false
  const sink2: any = {}
  await layer.route.stack[0].handle(reqOf(undefined, { id: done.sessionId }, { refined: '1' }), mockJsonRes(sink2))
  assert.equal(sink2.json.success, true, 'LLM 失败必须回退纯导出（fail-soft）')
  assert.equal(sink2.json.refined, false)
  assert.ok(sink2.json.markdown.includes('# 蒸馏预览用会话LKJHGs'), '回退产物 = 对话体')
})

test('对话只读红线：files 分毫不动；wiki_entries_meta 仅蒸馏入库设计内新增（imported），既有行内容分毫不动', async () => {
  const db = await getDb()
  assert.equal((await readonlyFingerprint()).split(';')[0], FINGERPRINT_BEFORE.split(';')[0], 'files 表任何 chat 路径都不得写（行数 + 内容指纹）')
  const wikiNow = await countOf('SELECT COUNT(*) AS n FROM wiki_entries_meta')
  const importedNow = await countOf(`SELECT COUNT(*) AS n FROM wiki_entries_meta WHERE source_type = 'imported'`)
  assert.equal(
    wikiNow - WIKI_ROWS_BEFORE_B, importedNow - WIKI_IMPORTED_BEFORE_B,
    'wiki 新增行必须全部来自蒸馏入库（source_type=imported，唯一合法写入口）'
  )
  const r = await (await db.prepare(`SELECT COALESCE(SUM(length(COALESCE(title,'')) + length(COALESCE(summary,''))), 0) AS c FROM wiki_entries_meta WHERE source_type != 'imported'`)).get() as any
  assert.equal(Number(r.c), WIKI_NON_IMPORT_CHARS_BEFORE_B, '非导入行（种子/蒸馏词条）内容分毫不动')
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
