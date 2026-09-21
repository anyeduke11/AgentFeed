import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Phase 2 · 任务 2.1 FTS 关键词路的 Wave 1 命名接口测试（syncWikiFts / rebuildWikiFts / ftsSearchWiki）。
// WHY：与 searchIndex.test.ts 互补——那边钉原语（searchFts/rebuildFts），这边钉生产入口契约：
// bm25 排序的 id 列表、写入/更新/删除路径的单条同步语义、trigram 对 unicode61 救不回的 CJK 部分词的救回能力。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 knowledge.test.ts 模式），绝不误伤生产库。
// 用例顺序有依赖（同一临时库）：空索引断言必须先于任何 seed 执行。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-wiki-fts-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { syncWikiFts, rebuildWikiFts, ftsSearchWiki, getFtsTokenizer } = await import('../src/search/ftsIndex.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let seq = 0
/** 种一个 wiki 词条：entry.md 落临时目录 + wiki_entries_meta，走生产同款入口 syncWikiFts 建索引 */
async function seedWikiEntry(opts: { title: string; summary?: string; md: string }): Promise<number> {
  const db = await getDb()
  seq += 1
  const entryPath = path.join(DATA_TMP, 'wiki', 'entries', `test-${seq}.md`)
  await fs.mkdir(path.dirname(entryPath), { recursive: true })
  await fs.writeFile(entryPath, opts.md, 'utf8')
  const r = await (await db.prepare(
    'INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary) VALUES (NULL, ?, ?, ?)'
  )).run([entryPath, opts.title, opts.summary ?? null])
  const id = Number(r.lastID)
  // 生产中由蒸馏/导入写入点调用的就是 syncWikiFts：seed 走同一入口，测试才对挂点真实有效
  await syncWikiFts(db, id)
  return id
}

test('空索引与乱码 query 不抛错（WHY：检索路是只读旁路，任何输入都不能成为崩溃源）', async () => {
  const db = await getDb()
  // getDb 已触发 ensureFtsTable：本环境 trigram tokenizer 可用（能力探测结论，见汇报）
  assert.equal(getFtsTokenizer(), 'trigram')
  assert.deepEqual(await ftsSearchWiki(db, '任意关键词'), [], '空索引必须返回空数组')
  assert.deepEqual(await ftsSearchWiki(db, '   '), [], '空白 query 必须返回空数组')
  const garbage = await ftsSearchWiki(db, '"quot^ OR (1=1) -- NEAR(( AND')
  assert.ok(Array.isArray(garbage), 'FTS5 语法字符必须被双引号短语转义后安全执行')
})

test('中文 query 命中「MCP 部署」：2 字走 LIKE 回退、3 字部分词由 trigram 救回（WHY：CJK 子串检索是 Phase 2 验收核心）', async () => {
  await seedWikiEntry({ title: 'MCP 部署', md: '# MCP 部署\n\n正文占位\n' })
  await seedWikiEntry({ title: 'MCP 部署指南', md: '# MCP 部署指南\n\n正文占位\n' })
  const db = await getDb()
  // 2 字 CJK 低于 trigram 最小单元（3 字符）：必须经 LIKE 回退兜底命中
  const short = await ftsSearchWiki(db, '部署')
  assert.ok(short.length >= 2, '2 字 query 必须经 LIKE 回退命中两个词条')
  // 3 字部分词「部署指」是「部署指南」的真子串：unicode61 把 CJK 连续串当整 token 救不回，trigram 子串语义必须命中
  const partial = await ftsSearchWiki(db, '部署指')
  assert.ok(partial.length >= 1, '3 字部分词必须由 trigram MATCH 救回')
  const titles = await (await db.prepare('SELECT id, title FROM wiki_entries_meta')).all() as any[]
  const guideId = Number(titles.find(r => r.title === 'MCP 部署指南')?.id)
  assert.ok(partial.includes(guideId), '部分词命中必须包含「MCP 部署指南」词条 id')
})

test('ftsSearchWiki 返回 id 列表且 bm25 相关度降序（WHY：融合检索第二波直接消费 id 列表，排序契约必须钉死）', async () => {
  await seedWikiEntry({ title: '向量检索实践', md: '# 向量检索实践\n\n正文简短\n' })
  await seedWikiEntry({ title: '无关主题', md: '# 无关主题\n\n这一段顺带讲向量检索的方法论，篇幅拉长以稀释命中密度\n' })
  const db = await getDb()
  const hits = await ftsSearchWiki(db, '向量检索', 10)
  assert.ok(hits.length >= 2, '标题与正文的命中都必须返回')
  assert.ok(hits.every(id => Number.isInteger(id)), '返回必须是纯词条 id 列表')
  assert.equal(new Set(hits).size, hits.length, '同一词条不得重复出现')
  const rows = await (await db.prepare('SELECT id, title FROM wiki_entries_meta')).all() as any[]
  const titleMatchId = Number(rows.find(r => r.title === '向量检索实践')?.id)
  assert.equal(hits[0], titleMatchId, '标题命中（字段短、密度高）必须排在正文命中之前')
})

test('更新后重索引：syncWikiFts 增量同步新词命中、旧词消失（WHY：蒸馏/导入更新路径依赖单条同步语义）', async () => {
  const id = await seedWikiEntry({ title: '旧标题词条', md: '# 旧标题词条\n\n唯一旧关键词甲乙丙\n' })
  const db = await getDb()
  assert.ok((await ftsSearchWiki(db, '唯一旧关键词')).includes(id), 'seed 后旧内容必须可检索')

  // 模拟蒸馏更新：改写 entry.md + 更新 meta 标题，只调 syncWikiFts（无全量 rebuild）
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE id = ?')).get([id]) as any
  const newMd = '# 新标题词条\n\n全新内容关键词丁戊己\n'
  await fs.writeFile(String(row.entry_path), newMd, 'utf8')
  await (await db.prepare('UPDATE wiki_entries_meta SET title = ? WHERE id = ?')).run(['新标题词条', id])
  await syncWikiFts(db, id)

  assert.ok((await ftsSearchWiki(db, '全新内容关键词')).includes(id), '更新后的新内容必须立即命中（索引字段含 entry.md 全文）')
  assert.ok(!(await ftsSearchWiki(db, '唯一旧关键词')).includes(id), '已消失的旧内容不得再命中（先删后插防陈旧索引）')
})

test('删除后不命中：syncWikiFts 对已删词条清索引（WHY：词条删除路径靠它防孤儿索引行泄漏）', async () => {
  const id = await seedWikiEntry({ title: '待删除词条', md: '# 待删除词条\n\n删除验证关键词\n' })
  const db = await getDb()
  assert.ok((await ftsSearchWiki(db, '删除验证关键词')).includes(id))
  await (await db.prepare('DELETE FROM wiki_entries_meta WHERE id = ?')).run([id])
  await syncWikiFts(db, id)
  assert.ok(!(await ftsSearchWiki(db, '删除验证关键词')).includes(id), '主表删除后同步调用必须清掉索引行')
})

test('rebuildWikiFts 幂等：重复重建结果一致且无重复（WHY：boot 兜底与手动 rebuild 共用此入口，不允许膨胀索引）', async () => {
  const db = await getDb()
  const before = await ftsSearchWiki(db, '部署指南', 50)
  const n1 = await rebuildWikiFts(db)
  const after1 = await ftsSearchWiki(db, '部署指南', 50)
  const n2 = await rebuildWikiFts(db)
  const after2 = await ftsSearchWiki(db, '部署指南', 50)
  assert.equal(n1, n2, '两次 rebuild 回填的词条数必须一致（主表未变）')
  assert.deepEqual(after1, after2, '两次 rebuild 后命中集合必须一致')
  assert.deepEqual(after1, before, 'rebuild 不得改变可检索结果')
  const ftsRows = await (await db.prepare('SELECT COUNT(*) AS n FROM wiki_fts')).get() as any
  const metaRows = await (await db.prepare('SELECT COUNT(*) AS n FROM wiki_entries_meta')).get() as any
  assert.equal(Number(ftsRows?.n), Number(metaRows?.n), 'FTS 行数必须与主表一一对应，无重复无遗漏')
})
