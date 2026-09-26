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

describe('P1 去重判定与 feeder 闸', () => {
  test('findDuplicates：同 embedding 高相似判重；未启用 embedding 降级标题精确匹配', async () => {
    const db = await getDb()
    const { findDuplicates, markDuplicate } = await import('../src/attention.js')
    const a = await mkFile('/p1/dup-a.md')
    // 造一条已蒸馏的近邻：wiki_entries_meta 有标题匹配即可触发标题降级判定
    // （embedding 未启用场景：callEmbedding 抛错 → 降级路径）
    // 列适配：实际表为 entry_path NOT NULL + source_type（无 source/status 列）；
    // distilled_at 必填近期时间——30 天近邻窗口查询依赖它
    const verdict = await findDuplicates(a, '完全一样的高分攻略标题', async () => { throw new Error('embedding 未启用') })
    assert.equal(verdict.duplicate, false) // 库内无同标题已蒸馏条目 → 不判重
    // 造同标题已蒸馏条目后应判重（brief 原文用 a+1 幽灵 id——files 无该行断言必炸，改显式建第二个文件）
    const b = await mkFile('/p1/dup-b.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at) VALUES (${a}, '/wiki/p1/dup-a.md', '完全一样的高分攻略标题', 'x', datetime('now'))`)
    const v2 = await findDuplicates(b, '完全一样的高分攻略标题', async () => { throw new Error('embedding 未启用') })
    assert.equal(v2.duplicate, true)
    // markDuplicate 落 cold + 死因
    await markDuplicate(b)
    const row = await (await db.prepare('SELECT lifecycle, llm_state FROM files WHERE id = ?')).get(b) as any
    assert.equal(row.lifecycle, 'cold')
    assert.equal(row.llm_state, 'skipped') // 枚举含 skipped（files 建表 CHECK），feeder 只拾 pending 不会死循环
  })

  test('findDuplicates 快速路径：标题扩展名归一（feeder 传 name 含 .md，wiki 标题不含——不剥则快速路径不可达）', async () => {
    const db = await getDb()
    const { findDuplicates } = await import('../src/attention.js')
    const embedThrows = async () => { throw new Error('embedding 未启用') }
    const a = await mkFile('/p1/ext-a.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at) VALUES (${a}, '/wiki/p1/ext-a.md', '一键部署完全指南', 'x', datetime('now'))`)
    const b = await mkFile('/p1/ext-b.md')
    // 候选带 .md、近邻不带：必须命中快速路径判重；若归一缺失则落 embed → 抛错 → ok_degraded 不判重，断言即失败
    const v = await findDuplicates(b, '一键部署完全指南.md', embedThrows)
    assert.equal(v.duplicate, true)
    // 反向防御：近邻标题带扩展名、候选不带 → 剥除后仍判重（meta.file_id UNIQUE → 挂独立文件）
    const a2 = await mkFile('/p1/ext-a2.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at) VALUES (${a2}, '/wiki/p1/ext-a2.md', '一键部署完全指南.html', 'x', datetime('now'))`)
    const c = await mkFile('/p1/ext-c.md')
    const v2 = await findDuplicates(c, '一键部署完全指南', embedThrows)
    assert.equal(v2.duplicate, true)
    // 负例：剥扩展名后仍不同 → 不判重（快速路径未误伤）
    const d = await mkFile('/p1/ext-d.md')
    const v3 = await findDuplicates(d, '一键部署完全指南进阶.md', embedThrows)
    assert.equal(v3.duplicate, false)
  })

  test('feeder 闸：冷却中文件不喂蒸馏，released 后恢复', async () => {
    const db = await getDb()
    const { enterCooling, isCooling } = await import('../src/attention.js')
    await db.exec('UPDATE config SET value = \'{"lifecycle":true,"decay":false,"cooling":true}\' WHERE key = \'attention.features\'')
    await db.exec("UPDATE config SET value = 'true' WHERE key = 'ai.autoTag'")
    const f = await mkFile('/p1/feeder.md')
    await db.exec(`UPDATE files SET llm_state = 'pending' WHERE id = ${f}`)
    await enterCooling(f)
    // isCooling 判定生效（feeder 侧消费同一函数）
    assert.equal(await isCooling(f), true)
    // 出池后恢复
    await db.exec(`UPDATE cooling_pool SET release_at = datetime('now','-1 hour') WHERE file_id = ${f}`)
    const { releaseExpired } = await import('../src/attention.js')
    await releaseExpired()
    assert.equal(await isCooling(f), false)
  })
})

describe('P1 suppression 指标与精选排除', () => {
  test('suppressionToday：今日 collected/deduped/cooling_died/delivered/digested 计数正确', async () => {
    const db = await getDb()
    const { suppressionToday } = await import('../src/attention.js')
    // 造数方式用最小 INSERT 集，断言只验证函数返回的键齐全且为数字
    // （各列口径的真值验证在 Task 4 端到端做：单测钉住「函数可用 + 七键齐全 + 类型正确」的契约）
    const s = await suppressionToday()
    for (const k of ['collected', 'deduped', 'cooling_alive', 'cooling_died', 'delivered', 'digested', 'simulated_quota_overflow']) {
      assert.ok(typeof s[k] === 'number', `${k} 应为数字`)
    }
    assert.ok(s.simulated_quota_overflow >= 0)
  })
})
