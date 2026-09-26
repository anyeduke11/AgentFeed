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
