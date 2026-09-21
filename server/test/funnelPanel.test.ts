import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// E1 诊断面板 API（stats.ts /funnel）+ funnelCore 口径契约测试。
// WHY：面板与 mcpFunnel 脚本共用 funnelCore——本套件钉「同一份数据两种出口数字一致」；
// 归因分类是确定性启发式（v2.5 裁决灰区表），改分类规则必跑本套件。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-funnel-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { statsRouter } = await import('../src/routes/stats.js')
const { clusterSessions, computeFunnel, extractQuery, overlapRatio, queryTerms, parseTs } = await import('../src/funnelCore.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function handlerOf(url: string) {
  const layer = (statsRouter as any).stack.find((l: any) => l.route?.path === url)
  assert.ok(layer, `路由 ${url} 必须存在`)
  return (layer.route as any).stack[0].handle
}

async function callFunnel() {
  let json: any, status = 200
  await handlerOf('/funnel')({ query: {} }, {
    status(c: number) { status = c; return this },
    json(p: any) { json = p },
  })
  return { status, json }
}

test('funnelCore 纯函数：聚类切分/时间戳解析/query 提取/词面重合（确定性口径）', () => {
  assert.equal(parseTs('2026-09-20 10:00:00'), Date.parse('2026-09-20T10:00:00Z'))
  assert.equal(parseTs('bad'), null)
  assert.equal(parseTs(null), null)
  assert.deepEqual(extractQuery('{"query":"混合检索","limit":5}'), '混合检索')
  assert.deepEqual(extractQuery('{"query":"被截断的长查询词'), '被截断的长查询词') // 正则兜底
  assert.equal(extractQuery('{"domain":"x"}'), null)
  assert.equal(extractQuery(null), null)
  assert.deepEqual(queryTerms('RAG 检索'), ['检索', 'rag']) // 先 CJK（单字整取）后 ASCII ≥3 整词
  assert.deepEqual(queryTerms('混合检索'), ['混合', '合检', '检索'])
  assert.equal(overlapRatio(['混合'], '混合检索实践'), 1)
  assert.equal(overlapRatio(['无关键词'], '混合检索'), 0)
  assert.equal(overlapRatio([], '任意'), null, '空 terms 不可判定')
  // 聚类：31 分钟切分
  const rows = [
    { id: 1, tool: 'search_knowledge', args: null, created_at: '2026-09-20 10:00:00' },
    { id: 2, tool: 'read_entry', args: '{}', created_at: '2026-09-20 10:20:00' },
    { id: 3, tool: 'search_knowledge', args: null, created_at: '2026-09-20 11:00:00' }, // +40min 新会话
    { id: 4, tool: 'search_knowledge', args: null, created_at: 'bad' }, // 剔除计数
  ]
  const { sessions, skipped } = clusterSessions(rows as any)
  assert.equal(sessions.length, 2)
  assert.equal(skipped, 1)
  const m = computeFunnel(sessions, skipped, rows.length)
  assert.equal(m.sessionsWithSearch, 2)
  assert.equal(m.level1Done, 1, '第一会话 search→read 达成')
  assert.equal(m.level1Rate, 0.5)
})

test('GET /api/stats/funnel：{ success } 约定 + 空库全 0 + 归因四分类计数', async () => {
  const db = await getDb()
  // 种 3 类样本：followed / args_null / weak_match（无关词零重合）
  const d = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('fn-域')`)).run()).lastID)
  await (await db.prepare(`INSERT INTO files (id, path, name, ext, title, domain_id, status) VALUES (1, '/fn/a.md', 'a', 'md', '混合检索实践', ?, 'active')`)).run([d])
  const ins = async (tool: string, args: string | null, at: string) =>
    (await (await db.prepare(`INSERT INTO mcp_call_logs (tool, args, created_at) VALUES (?, ?, ?)`)).run([tool, args, at])).lastID
  await ins('search_knowledge', '{"query":"混合检索"}', '2026-09-20 10:00:00')
  await ins('read_entry', '{"id":1}', '2026-09-20 10:05:00')            // followed
  await ins('search_knowledge', null, '2026-09-20 12:00:00')            // args_null
  await ins('search_knowledge', '{"query":"zzzqqq"}', '2026-09-20 14:00:00') // weak_match（LIKE 无命中→空 doc→overlap 0）

  const { status, json } = await callFunnel()
  assert.equal(status, 200)
  assert.equal(json.success, true)
  assert.equal(json.metrics.totalCalls, 4)
  assert.equal(json.metrics.sessionsWithSearch, 3)
  assert.equal(json.attribution.counts.followed, 1)
  assert.equal(json.attribution.counts.args_null, 1)
  assert.equal(json.attribution.counts.weak_match, 1)
  assert.equal(json.attribution.counts.needs_review, 0)
  assert.ok(Array.isArray(json.trend))
})
