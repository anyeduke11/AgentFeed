import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// 隔离：AGENTFEED_DATA_DIR 临时目录 + 动态 import（db.js 顶层读 env，
// 静态 import 会被提升到 env 设置前，测试将直连生产库，勿回退）
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-attn-p2-'))
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

describe('P2 三层摘要：hook 并入蒸馏', () => {
  test('wiki_entries_meta 有 hook 列', async () => {
    const db = await getDb()
    const cols = new Set(((await (await db.prepare("PRAGMA table_info('wiki_entries_meta')")).all()) as any[]).map(r => r.name))
    assert.ok(cols.has('hook'), '缺 hook 列')
  })

  test('safeParseWikiJson 解析 hook/importance 并守卫（超长截断/枚举外回退）', async () => {
    const { safeParseWikiJson } = await import('../src/llm/llmWorker.js')
    const w = safeParseWikiJson(JSON.stringify({
      title: '测试', summary: '摘要',
      importance: 'useful',
      hook: { text: '这是一条超过三十个字的核心结论内容需要被截断处理掉多余的部分', verdict: '值得深入的判断但是超过了二十个字的限制也要截断', action: 'act_now' }
    }))
    assert.equal(w.importance, 'useful')
    assert.ok(w.hook, 'hook 不应被丢弃')
    assert.ok(w.hook!.text.length <= 30, 'hook.text 须截断到 30 字内')
    assert.ok(w.hook!.verdict.length <= 20, 'verdict 须截断到 20 字内')
    assert.equal(w.hook!.action, 'act_now')
    // 归一裁定（守卫语义，替代计划占位断言）：
    // importance 枚举外/缺失 → 'useful'（保守回退，错档损失小于丢字段）；
    // action 枚举外（模型自创 must_read 等）→ 'keep'（中性默认：保留结论但不催行动、不忽略，
    //   丢弃整个 hook 会连带丢失正文结论，损失更大）；
    // hook 缺失 → undefined（不产空壳对象）。
    const bad = safeParseWikiJson(JSON.stringify({ title: 't', summary: 's', importance: 'must_read', hook: { text: 'x', action: 'must_read' } }))
    assert.equal(bad.importance, 'useful')
    assert.ok(bad.hook)
    assert.equal(bad.hook!.action, 'keep')
    const none = safeParseWikiJson(JSON.stringify({ title: 't', summary: 's' }))
    assert.equal(none.hook, undefined)
  })

  test('写入端：蒸馏完成 hook 落 wiki_entries_meta.hook 列，getHook 读回', async () => {
    const db = await getDb()
    const f = await mkFile('/p2/hook.md')
    // 白盒：模拟 llmWorker 入库 SQL 路径的存储形态（JSON 字符串落列）；llmWorker 主体不进单测（LLM 调用依赖）
    const hookJson = JSON.stringify({ text: '结论', verdict: '值得', action: 'keep' }).replace(/'/g, "''")
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at, hook) VALUES (${f}, '/p2/hook', '标题', '摘要', datetime('now'), '${hookJson}')`)
    const { getHook } = await import('../src/attention.js')
    const h = await getHook(f)
    assert.equal(h?.text, '结论')
    assert.equal(h?.action, 'keep')
    // 契约：无 hook 行 / 坏 JSON 行返 null（读侧 fail-safe，不阻塞展示）
    const g = await mkFile('/p2/nohook.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at) VALUES (${g}, '/p2/nohook', '标题', '摘要', datetime('now'))`)
    assert.equal(await getHook(g), null)
    const b = await mkFile('/p2/badhook.md')
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at, hook) VALUES (${b}, '/p2/badhook', '标题', '摘要', datetime('now'), '{bad json')`)
    assert.equal(await getHook(b), null)
  })
})

describe('P2 轻量消化', () => {
  test('reading_feedback 有 digest_text / digest_kind 列', async () => {
    const db = await getDb()
    const cols = new Set(((await (await db.prepare("PRAGMA table_info('reading_feedback')")).all()) as any[]).map(r => r.name))
    assert.ok(cols.has('digest_text'), '缺 digest_text 列')
    assert.ok(cols.has('digest_kind'), '缺 digest_kind 列')
  })

  test('digest 列语义：digest_text 非空=已消化；drop 行只留 kind 标记但不缺席；不污染打分路径列', async () => {
    const db = await getDb()
    // 列语义裁定：reading_feedback 既有列（id/file_id/stars/exec_intent/created_at）无 feedback 列，
    // 且 exec_intent 带 CHECK('now'|'later'|'info') 不容挪用——kind 标记落新增 digest_kind 列
    // （计划实现者注明确授权此选项）；digest_text 非空即「已消化」信号，drop 行 digest_text 置空。
    const f = await mkFile('/p2/digest.md')
    await (await db.prepare("INSERT INTO reading_feedback (file_id, digest_kind, digest_text) VALUES (?, 'conclusion', ?)")).run([f, '这是一条超过十个字的消化结论内容验证'])
    const row = await (await db.prepare('SELECT digest_text, digest_kind, stars, exec_intent FROM reading_feedback WHERE file_id = ?')).get(f) as any
    assert.ok(String(row.digest_text).length >= 10)
    assert.equal(row.digest_kind, 'conclusion')
    // drop 本身是信号：行必须存在，但 digest_text/stars/exec_intent 全空（不冒充已写消化、不污染打分语义）
    const d = await mkFile('/p2/drop.md')
    await (await db.prepare("INSERT INTO reading_feedback (file_id, digest_kind) VALUES (?, 'drop')")).run([d])
    const drow = await (await db.prepare('SELECT digest_text, digest_kind, stars, exec_intent FROM reading_feedback WHERE file_id = ?')).get(d) as any
    assert.equal(drow.digest_text, null)
    assert.equal(drow.digest_kind, 'drop')
    assert.equal(drow.stars, null)
    assert.equal(drow.exec_intent, null)
  })

  test('suppressionToday.digested 口径：只计 digest_text 非空行，/rate 打分行不双计', async () => {
    const db = await getDb()
    const { suppressionToday } = await import('../src/attention.js')
    // WHY：P2 起 reading_feedback 同表承载 digest 行与旧 /rate 打分行——若按全行计数，
    // 日常打分会让日报「已消化」虚高双计（P2 Task 4 评审裁定的口径缺陷）。
    // digest_text IS NOT NULL 是唯一「已消化」信号；用增量断言避免测试间造数干扰。
    const before = (await suppressionToday()).digested
    const a = await mkFile('/p2/sup-digest.md')
    const b = await mkFile('/p2/sup-rate.md')
    await (await db.prepare("INSERT INTO reading_feedback (file_id, digest_kind, digest_text) VALUES (?, 'conclusion', '这是一条超过十个字的今日消化结论内容')")).run([a])
    await db.exec(`INSERT INTO reading_feedback (file_id, stars, exec_intent) VALUES (${b}, 4, 'info')`)
    const after = (await suppressionToday()).digested
    assert.equal(after - before, 1)
  })
})

describe('P2 周度一页纸', () => {
  test('buildWeeklyDigest：领域分簇（keep/act_now 及无 hook 存量入簇）+ ignore 计 skipped + 落盘幂等', async () => {
    const db = await getDb()
    const { buildWeeklyDigest } = await import('../src/weeklyDigest.js')
    const dom = await (await db.prepare("INSERT INTO domains (name) VALUES ('周报域A')")).run() as any
    const domId = Number(dom.lastID)
    const ids: number[] = []
    for (const p of ['/p2/wk-keep.md', '/p2/wk-act.md', '/p2/wk-ign.md', '/p2/wk-nohook.md']) {
      const id = await mkFile(p)
      ids.push(id)
      await db.exec(`UPDATE files SET domain_id = ${domId} WHERE id = ${id}`)
    }
    const H = (t: string, a: string) => JSON.stringify({ text: t, verdict: '判定', action: a }).replace(/'/g, "''")
    // 窗口：sunday=2026-09-20（UTC）前 6 天 → distilled_at 落 09-16~09-18 视为本周
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at, hook) VALUES (${ids[0]}, '/p2/wk-keep', '保留篇', 's', '2026-09-16 08:00:00', '${H('结论甲', 'keep')}')`)
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at, hook) VALUES (${ids[1]}, '/p2/wk-act', '行动篇', 's', '2026-09-17 08:00:00', '${H('结论乙', 'act_now')}')`)
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at, hook) VALUES (${ids[2]}, '/p2/wk-ign', '忽略篇', 's', '2026-09-17 09:00:00', '${H('结论丙', 'ignore')}')`)
    await db.exec(`INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary, distilled_at) VALUES (${ids[3]}, '/p2/wk-nohook', '存量篇', 's', '2026-09-18 08:00:00')`)
    const sunday = new Date('2026-09-20T00:00:00Z')
    const d = await buildWeeklyDigest(sunday)
    assert.ok('clusters' in d && 'skipped' in d)
    assert.equal(d.skipped, 1, 'action=ignore 计安全忽略')
    const c = d.clusters.find((x: any) => x.domain === '周报域A')
    assert.ok(c, 'keep/act_now 条目应按领域聚簇')
    assert.equal(c.count, 3, 'keep + act_now + 无 hook 存量条目入簇')
    assert.ok(String(c.paragraph).includes('周报域A'))
    // 落盘 + 幂等：同周文件已存在不重写（mtime 不变）
    const { DATA_DIR } = await import('../src/db.js')
    const mdPath = path.join(DATA_DIR, 'reports', 'weekly', '2026-W38.md')
    assert.ok(await fsp.stat(mdPath).catch(() => null), '周报 md 应落盘 reports/weekly/')
    const j = JSON.parse(await fsp.readFile(mdPath.replace(/\.md$/, '.json'), 'utf8'))
    assert.equal(j.clusters.length, d.clusters.length)
    assert.equal(j.skipped, 1)
    const mtime1 = (await fsp.stat(mdPath)).mtimeMs
    await buildWeeklyDigest(sunday)
    assert.equal((await fsp.stat(mdPath)).mtimeMs, mtime1, '幂等：周文件已存在不重写')
  })

  test('buildWeeklyDigest：空周返回空簇零忽略', async () => {
    const { buildWeeklyDigest } = await import('../src/weeklyDigest.js')
    const d = await buildWeeklyDigest(new Date('2026-01-04T00:00:00Z')) // 亦为周日，窗口内无蒸馏条目
    assert.equal(d.clusters.length, 0)
    assert.equal(d.skipped, 0)
  })
})
