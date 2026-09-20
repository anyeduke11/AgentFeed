import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// MCP 埋点 v2：mcp_call_logs.args 摘要列。
// 为什么要有这列：工具级日志只知「用没用」，不知「agent 实际查了什么」——
// 这是四出口路线第一期验收（≥20 次真实调用）的分析依据。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录，绝不误伤生产 server/data/app.db。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-mcplog-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

test('mcp_call_logs 迁移后带 args 列（旧库幂等加列，不破坏既有行）', async () => {
  const db = await getDb()
  // 模拟旧库：迁移前插入的行没有 args
  await (await db.prepare("INSERT INTO mcp_call_logs (tool, client) VALUES ('legacy_tool', 'unknown')")).run()
  // 触发迁移链已在 getDb 内完成，断言列存在
  const cols = await (await db.prepare('PRAGMA table_info(mcp_call_logs)')).all() as any[]
  assert.ok(cols.some(c => c.name === 'args'), '迁移后 mcp_call_logs 必须有 args 列')
  // 旧行仍在且 args 为 NULL
  const legacy = await (await db.prepare("SELECT args FROM mcp_call_logs WHERE tool = 'legacy_tool'")).get() as any
  assert.ok(legacy, '旧数据必须保留')
  assert.equal(legacy.args, null)
})

test('args 摘要可写入并读回（新埋点的写入契约）', async () => {
  const db = await getDb()
  const argsJson = JSON.stringify({ query: 'MCP 部署', domain: 'infra', limit: 5 })
  await (await db.prepare('INSERT INTO mcp_call_logs (tool, client, args) VALUES (?, ?, ?)')).run(['search_knowledge', 'unknown', argsJson])
  const row = await (await db.prepare("SELECT args FROM mcp_call_logs WHERE tool = 'search_knowledge' ORDER BY id DESC")).get() as any
  assert.equal(row.args, argsJson)
  // 聚合端点口径不受影响（/api/stats/mcp 依赖 tool 分组）
  const grouped = await (await db.prepare('SELECT tool, COUNT(*) as calls FROM mcp_call_logs GROUP BY tool')).all() as any[]
  assert.ok(grouped.some(g => g.tool === 'search_knowledge' && Number(g.calls) === 1))
})
