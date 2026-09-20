import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Triage 蒸馏（pull 模式按需入队）+ 连续失败熔断。
// 三条业务红线（每个用例的 WHY）：
//   1) 预算防爆仓——无上限的按需入队会把数万积压一次性投给 LLM，token 账单与限流惩罚瞬间烧穿；
//   2) 积压不重复蒸馏——已有成功产物的文件再入队 = 双倍账单且覆盖既有 wiki 词条；
//   3) 坏 provider 不烧穿队列——系统性故障时单 job 重试/failover 都救不了，连续失败必须熔断止血。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录 + llmQueue 全程 pause（绝不真实调用 LLM、不误伤生产库）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-triage-db-'))
const FILES_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-triage-files-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { llmRouter } = await import('../src/routes/llm.js')
const { llmQueue } = await import('../src/llm/index.js')
const { processJob, getTriageBreakerState, resetTriageBreaker } = await import('../src/llm/llmWorker.js')

llmQueue.pause()

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
  await fs.rm(FILES_TMP, { recursive: true, force: true })
})

/** 从 router.stack 抽 POST /triage-distill handler 直调（与 tagDomainAlign.test.ts 同模式） */
function triageHandler(): any {
  const layer = (llmRouter as any).stack.find((l: any) => l.route?.methods?.post && l.route?.path === '/triage-distill')
  assert.ok(layer, 'llm 路由必须存在 POST /triage-distill')
  return layer.route.stack[layer.route.stack.length - 1].handle
}

async function callTriage(body: any = {}): Promise<{ code: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      status(code: number) { this._code = code; return this },
      json(b: any) { resolve({ code: this._code ?? 200, body: b }) }
    }
    Promise.resolve(triageHandler()({ body }, res)).catch(reject)
  })
}

/** 建磁盘文件 + files 行；distilled 时补 wiki_entries_meta 行（模拟真实成功蒸馏产物） */
async function makeFile(rel: string, content: string, opts: { ruleScore?: number; llmState?: string; domain?: string; distilled?: boolean } = {}): Promise<number> {
  const fp = path.join(FILES_TMP, rel)
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await fs.writeFile(fp, content)
  const db = await getDb()
  await (await db.prepare(`INSERT INTO files (path, name, ext, size, status, llm_state, rule_score) VALUES (?, ?, '.md', ?, 'active', ?, ?)`))
    .run([fp, path.basename(rel), Buffer.byteLength(content), opts.llmState || 'pending', opts.ruleScore ?? 0])
  const row = await (await db.prepare('SELECT id FROM files WHERE path = ?')).get([fp]) as any
  const id = Number(row.id)
  if (opts.distilled) {
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, distilled_at) VALUES (${id}, '/tmp/entry-${id}.md', CURRENT_TIMESTAMP)`)
  }
  if (opts.domain) {
    await db.exec(`INSERT OR IGNORE INTO domains (name) VALUES ('${opts.domain.replace(/'/g, "''")}')`)
    const d = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get([opts.domain]) as any
    await db.exec(`UPDATE files SET domain_id = ${d.id} WHERE id = ${id}`)
  }
  return id
}

async function callLogCount(fileId: number): Promise<number> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT COUNT(*) AS n FROM llm_call_logs WHERE file_id = ?')).get([fileId]) as any
  return Number(row.n)
}

test('预算截断：累计预估超限即停，当前这篇不入队', async () => {
  // WHY: 预算防爆仓——预算 120000，三篇各 100KB（=102400 字节，头部字节/2 = 51200 token）只放行前两篇：
  // 第三篇累计 153600 > 120000 必须被拦在队列外，budgetUsedTokens 停在预算线内。
  resetTriageBreaker()
  const big = 'x'.repeat(100 * 1024)
  const id1 = await makeFile('budget/a.md', big, { ruleScore: 30, domain: '预算域' })
  const id2 = await makeFile('budget/b.md', big, { ruleScore: 20, domain: '预算域' })
  const id3 = await makeFile('budget/c.md', big, { ruleScore: 10, domain: '预算域' })
  const { code, body } = await callTriage({ domains: ['预算域'], budgetTokens: 120000 })
  assert.equal(code, 200)
  assert.equal(body.success, true)
  assert.equal(body.enqueued, 2)
  assert.equal(body.skipped, 1)
  assert.equal(body.budgetUsedTokens, 102400)
  assert.ok(body.budgetUsedTokens <= 120000, '预算使用必须 ≤ 上限')
  assert.ok(llmQueue.hasFile(id1) && llmQueue.hasFile(id2), '高分两篇应按 rule_score 序入队')
  assert.ok(!llmQueue.hasFile(id3), '第三篇必须被预算拦住（当篇不入队）')
})

test('预算缺省：body 未带 budgetTokens 时读 config 键 llm.triageBudgetTokens', async () => {
  // WHY: 预算上限必须可运营调整（不同用户 token 单价差异大）；config 未配置时才落 5M 兜底，
  // 若 config 键未生效（静默落兜底），本用例第二篇会意外入队而变红。
  resetTriageBreaker()
  const db = await getDb()
  await db.exec(`INSERT INTO config (key, value, type) VALUES ('llm.triageBudgetTokens', '60000', 'number')`)
  const idA = await makeFile('cfg/a.md', 'w'.repeat(100 * 1024), { ruleScore: 9, domain: '缺省域' })
  const idB = await makeFile('cfg/b.md', 'w'.repeat(100 * 1024), { ruleScore: 8, domain: '缺省域' })
  const { body } = await callTriage({ domains: ['缺省域'] })
  assert.equal(body.success, true)
  assert.equal(body.enqueued, 1, 'config 预算 60000 只放得下一篇（51200）')
  assert.equal(body.budgetUsedTokens, 51200)
  assert.ok(llmQueue.hasFile(idA) && !llmQueue.hasFile(idB))
})

test('幂等：已有成功蒸馏产物的文件被跳过，不重复入队', async () => {
  // WHY: 积压不重复蒸馏——积压里混着已蒸馏完的旧文件（llm_state='done' 且有 wiki 词条），
  // 重复入队 = 双倍 token 账单且会覆盖既有词条；「成功过」以库内真实字段判定。
  resetTriageBreaker()
  const idDone = await makeFile('idem/done.md', 'y'.repeat(2048), { ruleScore: 99, domain: '幂等域', llmState: 'done', distilled: true })
  const idPending = await makeFile('idem/todo.md', 'y'.repeat(2048), { ruleScore: 1, domain: '幂等域' })
  const { body } = await callTriage({ domains: ['幂等域'] })
  assert.equal(body.success, true)
  assert.equal(body.enqueued, 1)
  assert.ok(!llmQueue.hasFile(idDone), '已成功蒸馏的文件不得重复入队')
  assert.ok(llmQueue.hasFile(idPending))
})

test('熔断：triage job 连续失败 5 次置位，后续入队被拒；resetTripped 后恢复', async () => {
  // WHY: 坏 provider 不烧穿队列——5 连败说明是系统性故障（provider 死了/欠费），
  // 继续消费只会空转烧日志与重试预算；熔断只停 triage 批次，普通 push 蒸馏不受牵连。
  resetTriageBreaker()
  const id = await makeFile('brk/fail.md', 'z'.repeat(1024), { domain: '熔断域' })
  const triageJob = (n: number) => ({ id: n, fileId: id, provider: 'ghost', model: 'ghost', prompt: '', options: { origin: 'triage' } })
  // 未配置任何 provider → 真实走 processDistill 失败路径（no_llm_provider，落调用日志），无需 mock 网络
  for (let i = 1; i <= 5; i++) {
    await processJob(triageJob(i))
    if (i < 5) assert.equal(getTriageBreakerState().tripped, false, `第 ${i} 次失败不应熔断`)
  }
  assert.equal(getTriageBreakerState().tripped, true, '第 5 次连续失败必须置位熔断')
  assert.equal(getTriageBreakerState().consecutiveFailures, 5)
  assert.equal(await callLogCount(id), 5, '5 次失败都真实执行并落调用日志')

  // 熔断置位后：第 6 个 triage job 被暂停消费（静默跳过，不产生新调用）
  await processJob(triageJob(6))
  assert.equal(await callLogCount(id), 5, '熔断后 triage job 不得再触发 LLM 调用')

  // 端点拒绝新入队（不带 resetTripped）
  const rejected = await callTriage({ domains: ['熔断域'] })
  assert.equal(rejected.body.success, false)
  assert.equal(rejected.body.tripped, true)
  assert.equal(rejected.body.enqueued, 0)
  assert.equal(rejected.body.budgetUsedTokens, 0)
  assert.ok(!llmQueue.hasFile(id), '熔断期间不得新增入队')

  // resetTripped: true → 复位并正常入队
  const revived = await callTriage({ domains: ['熔断域'], resetTripped: true })
  assert.equal(revived.body.success, true)
  assert.equal(revived.body.enqueued, 1)
  assert.equal(getTriageBreakerState().tripped, false)
  assert.equal(getTriageBreakerState().consecutiveFailures, 0)
  assert.ok(llmQueue.hasFile(id), '复位后恢复入队能力')

  // 普通 push 蒸馏 job（无 origin 标记）不受熔断影响：仍真实执行，且失败不进熔断计数
  await processJob({ id: 99, fileId: id, provider: 'ghost', model: 'ghost', prompt: '' })
  assert.equal(getTriageBreakerState().consecutiveFailures, 0, '普通蒸馏失败不得污染熔断计数')
})

test('limit 校验：显式传非正整数必须 400 拒绝且零入队；未传仍走默认 500', async () => {
  // WHY: limit 语义是「入队总数上限」，入队必须有明确意图——旧逻辑 parseInt('0')=0 为 falsy
  // 走 || 500，冒烟时 limit:0 被静默放大成 500 篇真实蒸馏（意外 token 消耗）。
  // 0/负数/非数字都是无意义请求，必须显式拒绝而不是猜一个默认值去执行。
  resetTriageBreaker()
  const id = await makeFile('lim/a.md', 'l'.repeat(2048), { domain: 'limit域' })
  for (const bad of [0, -3, 'abc']) {
    const { code, body } = await callTriage({ domains: ['limit域'], limit: bad })
    assert.equal(code, 400, `limit=${JSON.stringify(bad)} 应返回 400`)
    assert.equal(body.success, false)
    assert.equal(body.error, 'limit 必须为正整数')
  }
  assert.equal(llmQueue.hasFile(id), false, '校验失败的批次必须零入队')
  // 回归保护：拒绝非法值不得影响缺省语义（未传 limit 仍按默认 500 正常入队）
  const ok = await callTriage({ domains: ['limit域'] })
  assert.equal(ok.body.success, true)
  assert.ok(llmQueue.hasFile(id), '未传 limit 时应正常入队（默认 500）')
})
