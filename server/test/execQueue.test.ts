import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { rmSync } from 'node:fs'
import os from 'os'
import path from 'path'

// 执行队列契约测试（2026-09-22 用户反馈修复）：
// ① 点「完成」必须立刻出队——完成后按间隔重排的下一轮（due_at 在未来）是复习预约，
//    不是待执行任务；若 /exec 不过滤到期时间，新轮瞬间顶回列表，用户视角=完成无效。
// ② 今日完成按文档去重——同文档当天多轮「立即试→完成」是重复操作不是新完成，
//    COUNT(*) 会把操作次数当完成篇数，周目标与今日成就感全部虚高。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录；直调路由 handler，不起 HTTP 服务（同 readingSignals）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-execq-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb } = await import('../src/db.js')
const { readingRouter } = await import('../src/routes/reading.js')

process.on('exit', () => {
  try { rmSync(DATA_TMP, { recursive: true, force: true }) } catch { /* best-effort，OS /tmp 兜底 */ }
})

function handlerOf(router: any, method: string, url: string) {
  const layer = router.stack.find((l: any) =>
    l.route && l.route.methods?.[method.toLowerCase()] &&
    (l.route.path === url || (l.route.path.includes(':') && new RegExp('^' + l.route.path.replace(/:[^/]+/g, '[^/]+') + '$').test(url)))
  )
  assert.ok(layer, `路由 ${method} ${url} 必须存在`)
  return (layer.route as any).stack[0].handle
}

function mockRes(sink: any) {
  const res: any = {
    status(code: number) { sink.status = code; return res },
    json(payload: any) { sink.json = payload; return res },
  }
  return res
}

let fileSeq = 0
async function seedFile(title: string): Promise<number> {
  const db = await getDb()
  fileSeq += 1
  const r = await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, summary, rule_score, file_mtime, status)
     VALUES (?, ?, 'md', ?, '', 5, '2026-09-10 10:00:00', 'active')`
  )).run([`/execq/f${fileSeq}.md`, `f${fileSeq}`, title])
  return Number(r.lastID)
}

async function seedPending(fileId: number, dueOffset: string): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare(
    `INSERT INTO exec_queue (file_id, due_at, interval_stage) VALUES (?, datetime('now', '${dueOffset}'), 0)`
  )).run([fileId])
  return Number(r.lastID)
}

async function callExecList(): Promise<any> {
  const handler = handlerOf(readingRouter, 'get', '/exec')
  const sink: any = {}
  await handler({ method: 'get', query: {} }, mockRes(sink), async () => {})
  return sink.json
}

async function callDone(id: number): Promise<any> {
  const handler = handlerOf(readingRouter, 'post', '/exec/:id/done')
  const sink: any = {}
  await handler({ method: 'post', body: {}, params: { id: String(id) } }, mockRes(sink), async () => {})
  return sink.json
}

test('完成后立即出队：重排的未来轮不占执行队列，待执行数随之递减', async () => {
  const fileId = await seedFile('到期任务甲')
  await seedPending(fileId, '+0 hours') // 已到期 → 必须出现在队列

  const before = await callExecList()
  assert.equal(before.items.length, 1, '控制：到期任务在队列')
  assert.equal(before.counts.pending, 1)

  const done = await callDone(before.items[0].id)
  assert.equal(done.success, true)
  assert.equal(done.rescheduled, true, '控制：完成会重排下一轮（间隔复习语义保留）')

  const after = await callExecList()
  assert.ok(
    !after.items.some((i: any) => i.file_id === fileId),
    '完成后的重排轮（due_at 在未来）不得出现在队列——用户口径「点完成=出队」'
  )
  assert.equal(after.counts.pending, 0)
})

test('今日完成按文档去重：同文档当天两轮完成计 1，异文档各计 1', async () => {
  // 同进程共享临时库 → doneToday 基线含前序用例的完成，用相对增量断言去重语义
  const base = (await callExecList()).counts.doneToday
  const fa = await seedFile('同日两轮文档')
  const fb = await seedFile('单轮文档')
  const a1 = await seedPending(fa, '+0 hours')
  await callDone(a1) // 文档 A 第一轮完成
  assert.equal((await callExecList()).counts.doneToday, base + 1, '新文档第一轮：+1')

  // 模拟发车区「立即试」：同文档再来一轮到期任务并完成 → 操作 2 次但完成文档仍 1 篇
  const a2 = await seedPending(fa, '+0 hours')
  await callDone(a2)
  assert.equal(
    (await callExecList()).counts.doneToday, base + 1,
    '同文档第二轮完成不得再 +1——COUNT(*) 的操作次数不是完成篇数'
  )

  const b1 = await seedPending(fb, '+0 hours')
  await callDone(b1) // 文档 B 完成 → 新文档 +1
  assert.equal((await callExecList()).counts.doneToday, base + 2, '异文档完成正常 +1')
})
