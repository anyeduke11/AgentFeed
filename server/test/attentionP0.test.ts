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
