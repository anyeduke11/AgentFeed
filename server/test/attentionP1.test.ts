import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// 隔离：AGENTFEED_DATA_DIR 临时目录。动态 import db.js——其模块顶层读 env，
// 静态 import 会被提升到 env 设置前，测试将直连生产库（2026-09-25 事故，勿回退）
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-attn-p1-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP
const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 句柄随进程释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

const mkFile = async (path: string, sourceAgent: string | null = null) => {
  const db = await getDb()
  const r = await (await db.prepare('INSERT INTO files (path, name, ext, status, llm_state, source_agent) VALUES (?, ?, \'.md\', \'active\', \'pending\', ?)')).run([path, path.split('/').pop(), sourceAgent]) as any
  return Number(r.lastID)
}

describe('P1 冷却池核心', () => {
  test('cooling_pool 表存在且含全部列', async () => {
    const db = await getDb()
    const cols = new Set(((await (await db.prepare("PRAGMA table_info('cooling_pool')")).all()) as any[]).map(r => r.name))
    for (const c of ['id', 'file_id', 'entered_at', 'release_at', 'status', 'death_reason']) {
      assert.ok(cols.has(c), `缺列 ${c}`)
    }
  })

  test('attention.coolingHours / attention.features.cooling 已 seed', async () => {
    const db = await getDb()
    const h = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.coolingHours'")).get() as any
    assert.equal(h?.value, '48')
    const f = JSON.parse((await (await db.prepare("SELECT value FROM config WHERE key = 'attention.features'")).get() as any).value)
    assert.equal(f.cooling, false) // 默认关：先观测一周期
  })

  test('enterCooling 入池；isCooling 判定；豁免来源不入池', async () => {
    const db = await getDb()
    const { enterCooling, isCooling } = await import('../src/attention.js')
    // 开启 cooling 便于测试
    await db.exec('UPDATE config SET value = \'{"lifecycle":true,"decay":false,"cooling":true}\' WHERE key = \'attention.features\'')
    const a = await mkFile('/p1/a.md')
    await enterCooling(a)
    assert.equal(await isCooling(a), true)
    const row = await (await db.prepare('SELECT status, release_at FROM cooling_pool WHERE file_id = ?')).get(a) as any
    assert.equal(row.status, 'cooling')
    assert.ok(row.release_at) // entered_at + 48h
    // 重复入池幂等：不再插第二行
    await enterCooling(a)
    const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM cooling_pool WHERE file_id = ?')).get(a) as any
    assert.equal(cnt.n, 1)
    // 豁免：source_agent=webclip 直接放行不入池
    const w = await mkFile('/p1/w.md', 'webclip')
    await enterCooling(w, { sourceAgent: 'webclip' })
    assert.equal(await isCooling(w), false)
    // cooling 关闭 → 不入池
    await db.exec('UPDATE config SET value = \'{"lifecycle":true,"decay":false,"cooling":false}\' WHERE key = \'attention.features\'')
    const b = await mkFile('/p1/b.md')
    await enterCooling(b)
    assert.equal(await isCooling(b), false)
  })

  test('releaseExpired：到期出池（status=released），未到期不动', async () => {
    const db = await getDb()
    const { enterCooling, releaseExpired, isCooling } = await import('../src/attention.js')
    await db.exec('UPDATE config SET value = \'{"lifecycle":true,"decay":false,"cooling":true}\' WHERE key = \'attention.features\'')
    const due = await mkFile('/p1/due.md')
    const notDue = await mkFile('/p1/notdue.md')
    await enterCooling(due)
    // 手动把 due 的 release_at 拨到过去（模拟 48h 已过）
    await db.exec(`UPDATE cooling_pool SET release_at = datetime('now', '-1 hour') WHERE file_id = ${due}`)
    await enterCooling(notDue)
    const r = await releaseExpired()
    assert.equal(r.released, 1)
    assert.equal(await isCooling(due), false)
    assert.equal(await isCooling(notDue), true)
  })
})
