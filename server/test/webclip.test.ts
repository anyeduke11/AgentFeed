import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 domainDedupGate.test.ts 模式），绝不误伤生产 server/data/app.db。
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-webclip-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

test('webclip: webclip_records 表存在且含关联列', async () => {
  const db = await getDb()
  const rows = await (await db.prepare("PRAGMA table_info('webclip_records')")).all() as any[]
  const cols = new Set(rows.map(r => r.name))
  for (const c of ['id', 'url', 'title', 'slug_ts', 'md_path', 'html_path', 'md_file_id', 'html_file_id', 'status', 'snapshot', 'error', 'duration_ms', 'created_at']) {
    assert.ok(cols.has(c), `缺列 ${c}`)
  }
})

test('webclip: config 默认键 webclip.storageRoot 已 seed', async () => {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value, type FROM config WHERE key = 'webclip.storageRoot'")).get() as any
  assert.ok(row, 'config 键缺失')
  assert.equal(row.type, 'string')
  assert.equal(row.value, '')
})
