import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// 隔离：AGENTFEED_DATA_DIR 临时目录（domainDedupGate 模式）。动态 import db.js——
// 其模块顶层读 env，静态 import 会被提升到 env 设置前，测试将直连生产库（2026-09-25 事故，勿回退）
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-attn-p0-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP
const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 句柄随进程释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

describe('attention P0 迁移', () => {
  test('files 表新增生命周期五列', async () => {
    const db = await getDb()
    const cols = new Set(((await (await db.prepare("PRAGMA table_info('files')")).all()) as any[]).map(r => r.name))
    for (const c of ['lifecycle', 'lifecycle_deadline', 'last_touched_at', 'touch_count', 'pinned']) {
      assert.ok(cols.has(c), `files 缺列 ${c}`)
    }
  })

  test('attention config 键已 seed 且默认值正确', async () => {
    const db = await getDb()
    const feat = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.features'")).get() as any
    assert.ok(feat, 'attention.features 未 seed')
    const parsed = JSON.parse(feat.value)
    assert.equal(parsed.lifecycle, true)   // 生命周期默认开
    assert.equal(parsed.decay, false)      // 下沉默认关（先观测）
    const days = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.decayDays'")).get() as any
    // 注：brief 原文为 JSON.parse 对 JSON.stringify 比较（对象 vs 字符串恒不等），按意图改为深度比较
    assert.deepEqual(JSON.parse(days.value), { demoteDays: 90, archiveDays: 180 })
  })

  test('last_touched_at 有索引（回填与日批查询用）', async () => {
    const db = await getDb()
    const idx = ((await (await db.prepare("PRAGMA index_list('files')")).all()) as any[]).map(r => r.name)
    assert.ok(idx.includes('idx_files_touched'), '缺 idx_files_touched')
  })
})

describe('attention P0 touch 与回填', () => {
  test('touchFiles 更新 last_touched_at/touch_count（幂等递增），feature 关闭时不动', async () => {
    const db = await getDb()
    const ins = await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state) VALUES ('/attn/a.md', 'a.md', '.md', 'active', 'done')")).run() as any
    const id = ins.lastID
    const { touchFiles } = await import('../src/attention.js')
    await touchFiles([id])
    let row = await (await db.prepare('SELECT last_touched_at, touch_count FROM files WHERE id = ?')).get(id) as any
    assert.ok(row.last_touched_at)
    assert.equal(row.touch_count, 1)
    await touchFiles([id])
    row = await (await db.prepare('SELECT touch_count FROM files WHERE id = ?')).get(id) as any
    assert.equal(row.touch_count, 2)
    // feature 关闭 → no-op
    await db.exec("UPDATE config SET value = '{\"lifecycle\":false,\"decay\":false}' WHERE key = 'attention.features'")
    await touchFiles([id])
    row = await (await db.prepare('SELECT touch_count FROM files WHERE id = ?')).get(id) as any
    assert.equal(row.touch_count, 2)
    await db.exec("UPDATE config SET value = '{\"lifecycle\":true,\"decay\":false}' WHERE key = 'attention.features'")
  })

  test('backfillLastTouched：有 read_history 用最早 opened_at，无则 file_mtime', async () => {
    const db = await getDb()
    const { backfillLastTouched } = await import('../src/attention.js')
    const mtime = '2026-09-01T00:00:00.000Z'
    const ins1 = await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state, file_mtime) VALUES ('/attn/b.md', 'b.md', '.md', 'active', 'done', ?)")).run([mtime]) as any
    const ins2 = await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state, file_mtime) VALUES ('/attn/c.md', 'c.md', '.md', 'active', 'done', ?)")).run([mtime]) as any
    await (await db.prepare("INSERT INTO read_history (file_id, path, source, opened_at) VALUES (?, '/attn/b.md', 'reader', '2026-09-20 10:00:00')")).run([ins1.lastID])
    const n = await backfillLastTouched()
    assert.ok(n >= 2)
    const b = await (await db.prepare('SELECT last_touched_at FROM files WHERE id = ?')).get(ins1.lastID) as any
    const c = await (await db.prepare('SELECT last_touched_at FROM files WHERE id = ?')).get(ins2.lastID) as any
    assert.ok(String(b.last_touched_at).startsWith('2026-09-20'))
    assert.ok(String(c.last_touched_at).startsWith('2026-09-01'))
  })
})
