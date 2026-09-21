import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { rmSync } from 'node:fs'
import os from 'os'
import path from 'path'

// I3 RSI 成长闭环（rsi.ts）契约测试。
// WHY 各断言存在：
// ① 硬顶红线——「模型判断不可突破硬顶」：daily-cap / disabled 命中时先断言注入 fake 的调用次数为 0
//    （打扰控制是代码强制，不依赖模型自觉；这条若退化，产品承诺即破）；
// ② push=false 不生成且不记账——当日额度只被「实际生成」消耗，模型说不推就不烧也不占坑；
// ③ push=true 产出 ≤3 条且排序确定性（到期复习 > 高频域在读 > 目标缺口）——排序是产品裁决，不能漂移；
// ④ LLM 失败保守生成——学习建议是可用性功能，模型挂了不等于功能挂了（failed 日志照落，成本可见）；
// ⑤ peek 不记账——预览不消耗当日额度（路由 ?peek=1 的语义锚点）；
// ⑥ quiz opt-in：rsi.enabled 缺省 false 且未开启绝不调模型；坏 JSON → null + llm_call_logs failed（fail loud）；
// ⑦ applyQuizResult 只调既有行：+1 / -1 / floor 0 / 无行 false（绝不造行——造行会打乱间隔重复轮次语义）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 chat.test.ts）；llmFn 注入 fake，不测网络。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-rsi-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb } = await import('../src/db.js')
const {
  buildLearningSuggestions, setRsiLlmFn, isQuizEnabled, generateQuiz, setQuizLlmFn, applyQuizResult, todayStr
} = await import('../src/rsi.js')

// 清理挂 process exit 而非 after()：node:test 根级 after() 不等顶层 await（seeding）完成即触发，
// rm 会与 seeding 的 getDb() mkdir 竞态（readingSignals.test.ts 曾随机 ENOENT/ENOTEMPTY，I3 批次定位）；
// exit 时全部测试已结束、单线程同步清理，零竞态。
process.on('exit', () => {
  try { rmSync(DATA_TMP, { recursive: true, force: true }) } catch { /* best-effort，OS /tmp 兜底 */ }
})

// ---- fake LLM：计数 + 按用例覆写返回/抛错 ----
let rsiCalls = 0
let rsiFake: () => Promise<{ text: string }> = async () => ({ text: JSON.stringify({ push: true, reason: '信号明确' }) })
setRsiLlmFn(async () => { rsiCalls++; return rsiFake() })

let quizCalls = 0
let quizFake: () => Promise<{ text: string }> = async () => ({
  text: JSON.stringify([{ q: '问题一？', a: '答案一' }, { q: '问题二？', a: '答案二' }, { q: '问题三？', a: '答案三' }]),
})
setQuizLlmFn(async () => { quizCalls++; return quizFake() })

// ---- 种子工具 ----
let fileSeq = 0
async function seedDomain(name: string): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare('INSERT INTO domains (name) VALUES (?)')).run([name])
  return Number(r.lastID)
}

async function seedFile(domainId: number | null, title: string, opts?: { ruleScore?: number }): Promise<number> {
  const db = await getDb()
  fileSeq += 1
  const r = await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, summary, domain_id, rule_score, file_mtime, status)
     VALUES (?, ?, 'md', ?, '', ?, ?, '2026-09-10 10:00:00', 'active')`
  )).run([`/rsi/f${fileSeq}.md`, `f${fileSeq}`, title, domainId, opts?.ruleScore ?? 5])
  return Number(r.lastID)
}

async function seedRec(fileId: number, status: string, progress: number | null) {
  const db = await getDb()
  await (await db.prepare('INSERT INTO recommendations (file_id, status, progress) VALUES (?, ?, ?)')).run([fileId, status, progress])
}

async function seedReads(fileId: number, opens: number) {
  const db = await getDb()
  for (let i = 0; i < opens; i++) {
    await (await db.prepare('INSERT INTO read_history (file_id, path, source) VALUES (?, ?, ?)')).run([fileId, `/rsi/${fileId}.md`, 'reader'])
  }
}

async function seedExec(fileId: number, dueMod: string, stage: number): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare(
    `INSERT INTO exec_queue (file_id, due_at, interval_stage) VALUES (?, datetime('now', '${dueMod}'), ?)`
  )).run([fileId, stage])
  return Number(r.lastID)
}

async function setCfg(key: string, value: string | null) {
  const db = await getDb()
  if (value === null) {
    await (await db.prepare('DELETE FROM config WHERE key = ?')).run([key])
  } else {
    await (await db.prepare(
      `INSERT INTO config (key, value, type) VALUES (?, ?, 'string')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    )).run([key, value])
  }
}

async function getCfg(key: string): Promise<string | null> {
  const db = await getDb()
  const r = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([key]) as any
  return r?.value ?? null
}

// ---- 种子数据：热域 + 三类信号候选（到期复习 1 / 高频在读 2 / 目标缺口池 1）----
const dA = await seedDomain('rsi-热域')
const fDue = await seedFile(dA, 'rsi-到期复习篇')
await seedExec(fDue, '-1 day', 1)
const fHot = await seedFile(dA, 'rsi-高频在读篇')
await seedRec(fHot, 'unread', 40)
await seedReads(fHot, 3)
const fHot2 = await seedFile(dA, 'rsi-高频在读篇二')
await seedReads(fHot2, 2)
const fGap = await seedFile(dA, 'rsi-高分待读篇', { ruleScore: 9 })
await seedRec(fGap, 'unread', 0)

// ---- quiz 素材：词条 summary + entry.md「## 关键要点」节 ----
const fQuiz = await seedFile(dA, 'rsi-出题篇')
const entryDir = path.join(DATA_TMP, 'wiki', 'entries', String(fQuiz))
await fs.mkdir(entryDir, { recursive: true })
await fs.writeFile(path.join(entryDir, 'entry.md'), [
  '# rsi-出题篇', '', '混合检索的摘要正文。', '',
  '## 关键要点', '', '1. 要点一：RRF 融合召回', '2. 要点二：trigram 分词', '3. 要点三：向量语义召回', '',
  '## 实体', '', '- 检索引擎', '',
].join('\n'))
const wdb = await getDb()
await (await wdb.prepare(
  'INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
)).run([fQuiz, path.join(entryDir, 'entry.md'), 'rsi-出题篇', '混合检索三路融合的摘要'])

// ============ 硬顶（先于模型，钉死红线） ============

test('硬顶 daily-cap：当日已生成 → 拦截且模型一次都不被调用', async () => {
  await setCfg('rsi.lastSuggestionDay', todayStr())
  rsiCalls = 0
  const r = await buildLearningSuggestions()
  assert.equal(rsiCalls, 0, '模型判断不可突破硬顶：daily-cap 命中时 fake llm 调用次数必须为 0')
  assert.equal(r.generated, false)
  assert.equal(r.hardBlocked, 'daily-cap')
  assert.equal(r.items.length, 0)
  await setCfg('rsi.lastSuggestionDay', null)
})

test('硬顶 disabled：全局关 → 拦截且模型一次都不被调用', async () => {
  await setCfg('rsi.suggestionsEnabled', 'false')
  rsiCalls = 0
  const r = await buildLearningSuggestions()
  assert.equal(rsiCalls, 0, '全局关闭时同样不得触碰模型')
  assert.equal(r.generated, false)
  assert.equal(r.hardBlocked, 'disabled')
  assert.equal(r.items.length, 0)
  await setCfg('rsi.suggestionsEnabled', null)
})

// ============ 推送时机模型判断 ============

test('模型 push=false → 不生成、不记账（未生成不消耗当日额度）', async () => {
  await setCfg('rsi.lastSuggestionDay', null)
  rsiFake = async () => ({ text: JSON.stringify({ push: false, reason: '信号弱' }) })
  rsiCalls = 0
  const r = await buildLearningSuggestions()
  assert.equal(rsiCalls, 1, '候选 ≥1 时恰好一次轻量判断调用')
  assert.equal(r.generated, false)
  assert.equal(r.items.length, 0)
  assert.equal(await getCfg('rsi.lastSuggestionDay'), null, 'push=false 不写当日记账')
})

test('模型 push=true → ≤3 条确定性排序（到期复习 > 高频在读）+ 记账；再调一次即 daily-cap', async () => {
  await setCfg('rsi.lastSuggestionDay', null)
  rsiFake = async () => ({ text: JSON.stringify({ push: true, reason: '信号明确' }) })
  rsiCalls = 0
  const r = await buildLearningSuggestions()
  assert.equal(r.generated, true)
  assert.equal(r.items.length, 3, '候选 4 类截断为 ≤3 条')
  assert.equal(r.items[0].fileId, fDue, '到期复习排第一（确定性排序）')
  assert.ok(r.items[0].reason.includes('到期'), '到期复习 reason 须可辨识')
  assert.equal(r.items[1].fileId, fHot, '高频在读排第二（按打开次数降序）')
  assert.ok(r.items[1].reason.includes('高频域'), '高频在读 reason 须可辨识')
  assert.equal(r.items[2].fileId, fHot2)
  assert.equal(await getCfg('rsi.lastSuggestionDay'), todayStr(), '生成即硬顶记账（写当天）')

  rsiCalls = 0
  const r2 = await buildLearningSuggestions()
  assert.equal(r2.hardBlocked, 'daily-cap', '同日第二次调用被硬顶拦截')
  assert.equal(rsiCalls, 0, '硬顶拦截不烧模型')
  await setCfg('rsi.lastSuggestionDay', null)
})

test('LLM 失败 → 保守生成（可用性优先），failed 日志落库', async () => {
  await setCfg('rsi.lastSuggestionDay', null)
  const db = await getDb()
  const before = Number(((await (await db.prepare("SELECT COUNT(*) AS n FROM llm_call_logs WHERE status != 'success'")).get()) as any).n)
  rsiFake = async () => { throw new Error('mock_rsi_llm_down') }
  const r = await buildLearningSuggestions()
  assert.equal(r.generated, true, '模型挂了不能让功能挂了（保守推送）')
  assert.ok(r.items.length >= 1)
  assert.equal(await getCfg('rsi.lastSuggestionDay'), todayStr(), '保守生成同样记账')
  const after = Number(((await (await db.prepare("SELECT COUNT(*) AS n FROM llm_call_logs WHERE status != 'success'")).get()) as any).n)
  assert.ok(after > before, 'failed 调用日志必须落库（fail loud + G1 成本可见）')
  await setCfg('rsi.lastSuggestionDay', null)
})

test('peek 模式：照常生成但不记账（预览不消耗当日额度）', async () => {
  await setCfg('rsi.lastSuggestionDay', null)
  rsiFake = async () => ({ text: JSON.stringify({ push: true, reason: 'ok' }) })
  const r = await buildLearningSuggestions({ peek: true })
  assert.equal(r.generated, true)
  assert.ok(r.items.length >= 1)
  assert.equal(await getCfg('rsi.lastSuggestionDay'), null, 'peek 只看不落帽')
  // 非 peek 紧随其后仍可正式生成（未被 peek 消耗）
  const r2 = await buildLearningSuggestions()
  assert.equal(r2.generated, true)
  await setCfg('rsi.lastSuggestionDay', null)
})

// ============ 理解度检查（quiz） ============

test('quiz opt-in：rsi.enabled 缺省 false → isQuizEnabled false、generateQuiz null 且不调模型', async () => {
  assert.equal(await isQuizEnabled(), false, '缺省必须关（opt-in 产品裁决）')
  quizCalls = 0
  const q = await generateQuiz(fQuiz)
  assert.equal(q, null)
  assert.equal(quizCalls, 0, '未开启绝不调模型')
})

test('quiz 开启：从词条要点生成 3 道问答', async () => {
  await setCfg('rsi.enabled', 'true')
  assert.equal(await isQuizEnabled(), true)
  quizCalls = 0
  const q = await generateQuiz(fQuiz)
  assert.ok(q, '开启且有素材应出题')
  assert.equal(q!.questions.length, 3)
  for (const item of q!.questions) {
    assert.equal(typeof item.q, 'string')
    assert.equal(typeof item.a, 'string')
  }
  assert.equal(quizCalls, 1)
})

test('quiz 坏 JSON → null 且 llm_call_logs 落 failed（fail loud）', async () => {
  const db = await getDb()
  const before = Number(((await (await db.prepare("SELECT COUNT(*) AS n FROM llm_call_logs WHERE status != 'success'")).get()) as any).n)
  quizFake = async () => ({ text: '这不是 JSON 数组' })
  const q = await generateQuiz(fQuiz)
  assert.equal(q, null, '解析失败不得返回半成品题目')
  const row = await (await db.prepare("SELECT * FROM llm_call_logs WHERE status != 'success' ORDER BY id DESC LIMIT 1")).get() as any
  assert.ok(String(row?.error || '').includes('llm_output_not_json'), '失败原因落库可排错')
  const after = Number(((await (await db.prepare("SELECT COUNT(*) AS n FROM llm_call_logs WHERE status != 'success'")).get()) as any).n)
  assert.ok(after > before)
  await setCfg('rsi.enabled', null)
})

// ============ 答题调整间隔（applyQuizResult） ============

test('applyQuizResult：correct +1 / wrong -1 / floor 0 / 无行 false（只调既有行）', async () => {
  const fExec = await seedFile(dA, 'rsi-间隔调整篇')
  const db = await getDb()
  const execId = await seedExec(fExec, '+1 day', 2)
  const stageOf = async () => Number(((await (await db.prepare('SELECT interval_stage AS v FROM exec_queue WHERE id = ?')).get([execId])) as any).v)

  assert.equal(await applyQuizResult(null, fExec, true), true)
  assert.equal(await stageOf(), 3, '答对 → interval_stage 2→3（更长间隔）')

  await (await db.prepare('UPDATE exec_queue SET interval_stage = 2 WHERE id = ?')).run([execId])
  assert.equal(await applyQuizResult(null, fExec, false), true)
  assert.equal(await stageOf(), 1, '答错 → 2→1（更短间隔）')

  await (await db.prepare('UPDATE exec_queue SET interval_stage = 0 WHERE id = ?')).run([execId])
  assert.equal(await applyQuizResult(execId, fExec, false), true)
  assert.equal(await stageOf(), 0, '最小 0 不下穿（floor）')

  const fNoRow = await seedFile(dA, 'rsi-无复习行篇')
  const rowsBefore = Number(((await (await db.prepare('SELECT COUNT(*) AS n FROM exec_queue')).get()) as any).n)
  assert.equal(await applyQuizResult(null, fNoRow, true), false, '无任何行返回 false')
  const rowsAfter = Number(((await (await db.prepare('SELECT COUNT(*) AS n FROM exec_queue')).get()) as any).n)
  assert.equal(rowsAfter, rowsBefore, '绝不造行（造行会打乱间隔重复轮次语义）')
})
