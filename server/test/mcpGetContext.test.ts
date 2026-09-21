import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// E2 MCP 第 8 工具 getContext 的 handler 契约测试（src/mcpTools.ts）。
// WHY：getContext 是 agent 开工注入的第一出口——注入文本缺领域画像、领域误拼时静默空文本、
// 或埋点漏落，都会让 agent 拿到错误地图且发车统计失真。必须钉住：
// ① 领域命中返回 summaryText（领域名 + top 词条要点行，聚合口径由 context.test.ts 内核侧钉死）；
// ② 领域不存在返回可读 JSON（error + list_domains 引导），不得静默；
// ③ 每次调用落 mcp_call_logs 一行 tool='getContext'（发车统计口径）。
// 隔离方式：handler 放 mcpTools.ts 正是为了本测试——mcp.ts 顶层 main() 会连 StdioServerTransport，
// 直接 import mcp.ts 无法干净运行；AGENTFEED_DATA_DIR 指向临时库（同 context.test.ts 模式）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-mcp-getcontext-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { getContextHandler } = await import('../src/mcpTools.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let fileSeq = 0
/** 种一个文件 + 蒸馏词条（同 context.test.ts seedEntry 口径）。 */
async function seedEntry(
  domainId: number,
  title: string,
  summary: string,
  quality: number | null,
  ruleScore: number | null
): Promise<void> {
  const db = await getDb()
  fileSeq += 1
  const fr = await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, domain_id, rule_score, file_mtime, status)
     VALUES (?, ?, 'md', ?, ?, ?, '2026-09-01 10:00:00', 'active')`
  )).run([`/mcp/f${fileSeq}.md`, `f${fileSeq}`, title, domainId, ruleScore])
  await (await db.prepare(
    `INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, quality_score, distilled_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-01 12:00:00')`
  )).run([Number(fr.lastID), `/wiki/mcp/f${fileSeq}.md`, title, summary, quality])
}

test('领域命中：返回 summaryText（含领域名与要点行），形状对齐 content/text', async () => {
  const db = await getDb()
  const dr = await (await db.prepare(`INSERT INTO domains (name) VALUES ('mcp-注入域')`)).run()
  await seedEntry(Number(dr.lastID), '要点词条甲', '甲的蒸馏要点', 8, 5)
  await seedEntry(Number(dr.lastID), '要点词条乙', '乙的蒸馏要点', 6, 4)

  const res = await getContextHandler({ domain: 'mcp-注入域' })
  assert.equal(res.content.length, 1)
  const text = res.content[0]?.text ?? ''
  assert.ok(text.includes('mcp-注入域'), '注入文本必须含领域名（领域画像的地基）')
  assert.ok(text.includes('要点词条甲'), 'top 词条标题行必须出现')
  assert.ok(text.includes('甲的蒸馏要点'), '词条要点行必须出现')
})

test('领域不存在：可读 JSON 提示，引导 list_domains（不得静默空文本）', async () => {
  const res = await getContextHandler({ domain: '不存在的领域xyz' })
  const parsed = JSON.parse(res.content[0]?.text ?? '{}')
  assert.equal(parsed.error, 'domain not found')
  assert.ok(parsed.message.includes('不存在的领域xyz'))
  assert.ok(parsed.message.includes('list_domains'), '提示语必须指向可用工具出口')
  assert.equal(parsed.available_hint, 'list_domains')
})

test('埋点：调用落 mcp_call_logs 一行 tool=getContext（含 args 摘要）', async () => {
  const db = await getDb()
  const before = await (await db.prepare(`SELECT COUNT(*) AS n FROM mcp_call_logs WHERE tool = 'getContext'`)).get() as any
  await getContextHandler({ domain: 'mcp-注入域' })
  const row = await (await db.prepare(
    `SELECT args FROM mcp_call_logs WHERE tool = 'getContext' ORDER BY id DESC LIMIT 1`
  )).get() as any
  const after = await (await db.prepare(`SELECT COUNT(*) AS n FROM mcp_call_logs WHERE tool = 'getContext'`)).get() as any
  assert.equal(Number(after.n), Number(before.n) + 1, '每次调用必须恰好落一行埋点')
  assert.ok(String(row?.args ?? '').includes('mcp-注入域'), 'args 摘要应记录查询的领域名（盘点 agent 实际查询内容）')
})
