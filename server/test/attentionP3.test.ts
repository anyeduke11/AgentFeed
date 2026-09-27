import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// 隔离：AGENTFEED_DATA_DIR 临时目录 + 动态 import（db.js 顶层读 env，
// 静态 import 会被提升到 env 设置前，测试将直连生产库，勿回退）
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-attn-p3-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP
const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 句柄随进程释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

const mkFile = async (p: string) => {
  const db = await getDb()
  const r = await (await db.prepare('INSERT INTO files (path, name, ext, status, llm_state) VALUES (?, ?, \'.md\', \'active\', \'pending\')')).run([p, p.split('/').pop()]) as any
  return Number(r.lastID)
}

describe('P3 配额双上限', () => {
  test('attention.budget 默认 seed（enabled=false）+ getBudget 缺省兜底', async () => {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.budget'")).get() as any
    const b = JSON.parse(row.value)
    assert.equal(b.enabled, false)
    assert.ok(b.dailyLimit >= 1 && b.softPct > 0 && b.softPct < 100)
    const { getBudget } = await import('../src/attention.js')
    const g = await getBudget()
    assert.equal(g.enabled, false)
    // 缺省兜底形态钉死（读侧不得依赖 seed 是否已跑：INSERT OR IGNORE 对既有库不回填新键）
    assert.equal(g.dailyLimit, 5)
    assert.equal(g.softPct, 80)
    // 坏 JSON 兜底
    await db.exec("UPDATE config SET value = 'not-json' WHERE key = 'attention.budget'")
    const g2 = await getBudget()
    assert.equal(g2.enabled, false)
    await db.exec("UPDATE config SET value = '" + JSON.stringify(b) + "' WHERE key = 'attention.budget'")
  })

  test('applyBudget：disabled 原样；soft 切片标注；hard 达上限标注 + hiddenTotal', async () => {
    const { applyBudget } = await import('../src/attention.js')
    const db = await getDb()
    const items = [1, 2, 3, 4, 5, 6].map(i => ({ file_id: i }))
    // disabled：原样返回零标注（默认关闭 = 行为与改造前完全一致）
    const r0 = await applyBudget(items as any)
    assert.equal(r0.items.length, 6)
    assert.equal(r0.softCapped, false)
    assert.equal(r0.hardCapped, false)
    assert.equal(r0.hiddenTotal, 0)
    // enabled dailyLimit=5 softPct=80：softLimit=ceil(4)=4 → 前4条保留 + softCapped，hidden=2
    // hard 判定用切片后长度：4 < 5 → hardCapped=false（r1 用例钉死）
    await db.exec('UPDATE config SET value = \'{"enabled":true,"dailyLimit":5,"softPct":80}\' WHERE key = \'attention.budget\'')
    const r1 = await applyBudget(items as any)
    assert.equal(r1.items.length, 4)
    assert.equal(r1.softCapped, true)
    assert.equal(r1.hardCapped, false)
    assert.equal(r1.hiddenTotal, 2)
    // hard 边界：limit=4 softPct=80 → softLimit=ceil(3.2)=4；传入 4 条 → 未超 soft、达到 hard=4 → hardCapped=true
    await db.exec('UPDATE config SET value = \'{"enabled":true,"dailyLimit":4,"softPct":80}\' WHERE key = \'attention.budget\'')
    const r2 = await applyBudget(items.slice(0, 4) as any)
    assert.equal(r2.items.length, 4)
    assert.equal(r2.hardCapped, true)
    assert.equal(r2.hiddenTotal, 0)
    // 双触发边界（计划裁定：hard wins 标注，切片维持 softLimit 不二次收紧）：
    // 6 条 limit=4 soft=80 → soft 截 4 条，切片后 4 >= 4 → softCapped 与 hardCapped 同真，hidden=2
    const r3 = await applyBudget(items as any)
    assert.equal(r3.items.length, 4)
    assert.equal(r3.softCapped, true)
    assert.equal(r3.hardCapped, true)
    assert.equal(r3.hiddenTotal, 2)
    // 还原 disabled（seed 形态），不污染同文件后续用例
    await db.exec('UPDATE config SET value = \'{"enabled":false,"dailyLimit":5,"softPct":80}\' WHERE key = \'attention.budget\'')
  })

  test('suppressionToday 含 hidden_total 键 = 当日入库 − 当日已消化（下限 0）', async () => {
    const { suppressionToday } = await import('../src/attention.js')
    const db = await getDb()
    const s = await suppressionToday()
    assert.ok(typeof s.hidden_total === 'number')
    // 语义钉死：新入库 1 条未消化 → +1；消化 1 条 → 抵消；纯消化行不再减（下限 0）
    // 显式 localtime 时间戳：files/reading_feedback 的 CURRENT_TIMESTAMP 是 UTC，
    // 在沪区 00:00-08:00 跑测试时 UTC 日期落后本地一天，不指定会把「当日」计成「昨日」
    await db.exec("INSERT INTO files (path, name, ext, status, llm_state, created_at) VALUES ('/p3/ht.md', 'ht.md', '.md', 'active', 'pending', datetime('now', 'localtime'))")
    const f = Number((await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any).id)
    const s2 = await suppressionToday()
    assert.equal(s2.hidden_total, s.hidden_total + 1)
    await db.exec(`INSERT INTO reading_feedback (file_id, digest_kind, digest_text, created_at) VALUES (${f}, 'conclusion', '一句消化结论', datetime('now', 'localtime'))`)
    const s3 = await suppressionToday()
    assert.equal(s3.hidden_total, s2.hidden_total - 1)
    await db.exec(`INSERT INTO reading_feedback (file_id, digest_kind, digest_text, created_at) VALUES (${f + 1000}, 'conclusion', '无对应入库文件的消化行', datetime('now', 'localtime'))`)
    const s4 = await suppressionToday()
    assert.equal(s4.hidden_total, s3.hidden_total, 'digested > collected 时下限钳 0')
  })
})

describe('P3 marginal 已读参照系', () => {
  test('findDuplicates 近邻并入已读条目（read_history 全量 ∪ 近30天蒸馏，各 50 去重）', async () => {
    const db = await getDb()
    const { findDuplicates } = await import('../src/attention.js')
    const read = await mkFile('/p3/read.md')
    const cand = await mkFile('/p3/cand.md')
    // 已读 + 已蒸馏 60 天前（超出 30 天窗）——只有 marginal 已读分支能命中，钉死新参照系
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, distilled_at) VALUES (${read}, '/p3/read', '完全相同的已读标题', datetime('now', '-60 days'))`)
    await db.exec(`INSERT INTO read_history (file_id, path, source) VALUES (${read}, '/p3/read.md', 'reader')`)
    const v = await findDuplicates(cand, '完全相同的已读标题', async () => { throw new Error('no embedding') })
    assert.equal(v.duplicate, true)
    assert.equal(v.degraded, true, '标题快速路径命中（embedding 抛错也不走到慢路径）')
    // 对照组：60 天前已蒸馏但未读 → 不参与近邻（「我看过」才进参照系，不是所有旧蒸馏都算）
    const old = await mkFile('/p3/old.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, distilled_at) VALUES (${old}, '/p3/old', '六十天前的旧标题', datetime('now', '-60 days'))`)
    const vOld = await findDuplicates(await mkFile('/p3/c3.md'), '六十天前的旧标题', async () => { throw new Error('no embedding') })
    assert.equal(vOld.duplicate, false)
    // 回归 P1：近 30 天已蒸馏未读仍参与近邻（防同批内容重复入库的原口径不变）
    const distilled = await mkFile('/p3/distilled.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, distilled_at) VALUES (${distilled}, '/p3/distilled', '近30天蒸馏标题', datetime('now'))`)
    const v2 = await findDuplicates(await mkFile('/p3/c2.md'), '近30天蒸馏标题', async () => { throw new Error('no embedding') })
    assert.equal(v2.duplicate, true)
  })
})
