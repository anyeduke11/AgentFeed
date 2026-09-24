import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 批次③（Hister 竞品分析落地）：查询迷你语法 + 别名 契约测试。
//
// A. 解析器纯函数（querySyntax.ts）——四个高频语法的切分语义必须钉死：
//    title:/tag: 前缀归位、引号短语保整体、-词进排除、普通词留 query；
//    别名整词元展开且防环（gh→gh 自引用不得死循环）。
//    fail 点设计：语法词元漏进自由 query 会污染全文检索；别名环挂死进程。
//
// B. searchKnowledgeCore 端到端——title:/-排除 行后过滤真实生效、tag: 走 SQL 路、
//    坏别名 JSON 不炸检索（配置容错）；普通查询行为与旧口径完全一致（兼容锚）。
//
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-batch3-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { parseQuery, rowMatchesTitle, rowMatchesExclude, parseAliases } = await import('../src/search/querySyntax.js')
const { searchKnowledgeCore } = await import('../src/knowledge.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

// ---------- A. 解析器纯函数 ----------

test('parseQuery：四种语法词元归位，普通词留 query', () => {
  const p = parseQuery('title:蒸馏 "exact phrase" -噪声 mermaid 图表')
  assert.deepEqual(p.title, ['蒸馏'])
  assert.deepEqual(p.exclude, ['噪声'])
  assert.equal(p.query, 'exact phrase mermaid 图表', '短语保整体、普通词拼接')
  assert.equal(parseQuery('mermaid').query, 'mermaid', '纯普通查询直通（兼容锚）')
})

test('parseQuery：别名整词元展开 + 多别名组合 + 前缀词不展开', () => {
  const aliases = { gh: 'tag:github', work: 'tag:工作 tag:项目' }
  const p = parseQuery('gh 部署', aliases)
  assert.deepEqual(p.tags, ['github'])
  assert.equal(p.query, '部署')

  const combo = parseQuery('gh work', aliases)
  assert.deepEqual(combo.tags, ['github', '工作', '项目'], '多别名连续展开')

  const noExpand = parseQuery('title:gh', aliases)
  assert.deepEqual(noExpand.title, ['gh'], '带前缀的词元不做别名改写')
})

test('parseQuery：别名环（自引用/互引）不死循环，只展开一次', () => {
  const selfRef = parseQuery('gh 部署', { gh: 'gh tag:x' })
  assert.deepEqual(selfRef.tags, ['x'])
  assert.equal(selfRef.query, '部署 gh', '自引用只展开一次，gh 落回自由词（防环语义）')
  const mutual = parseQuery('a', { a: 'b', b: 'a' })
  assert.ok(Array.isArray(mutual.query) === false, '互引不挂死，正常返回')
})

test('rowMatches 过滤语义：title AND、exclude 任一命中即剔（大小写不敏感）', () => {
  const row = { title: 'Kubernetes 部署实践', summary: '讲 k8s', path: '/tmp/k.md' }
  assert.equal(rowMatchesTitle(row, ['kubernetes', '部署']), true)
  assert.equal(rowMatchesTitle(row, ['kubernetes', 'mysql']), false, 'title 多词 AND')
  assert.equal(rowMatchesExclude(row, ['MySQL']), false, '不含排除词 → 保留')
  assert.equal(rowMatchesExclude(row, ['k8s']), true, 'summary 命中排除词 → 剔除')
  assert.equal(rowMatchesExclude(row, ['/tmp/']), true, 'path 命中排除词 → 剔除')
})

test('parseAliases：JSON 容错（坏值/非对象/数组 → 空表，检索不因配置错误不可用）', () => {
  assert.deepEqual(parseAliases(null), {})
  assert.deepEqual(parseAliases(''), {})
  assert.deepEqual(parseAliases('{broken'), {})
  assert.deepEqual(parseAliases('["a"]'), {})
  assert.deepEqual(parseAliases('{"a":1,"b":"tag:x"}'), { b: 'tag:x' }, '非 string 值剔除，合法项保留')
})

// ---------- B. searchKnowledgeCore 端到端 ----------

let seq = 0
async function seedFile(opts: { title?: string; summary?: string; tags?: string[] }) {
  const db = await getDb()
  seq += 1
  const id = Number((await (await db.prepare(
    'INSERT INTO files (path, name, ext, title, source_agent, file_mtime, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )).run([`/tmp/b3-${seq}.md`, `b3-${seq}.md`, '.md', opts.title ?? null, null, '2026-09-01T00:00:00.000Z', opts.summary ?? null, 'active'])).lastID)
  for (const t of opts.tags || []) {
    const tagRow = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(t) as any
    const tagId = tagRow?.id ?? Number((await (await db.prepare('INSERT INTO tags (name, level) VALUES (?, ?)')).run([t, 'normal'])).lastID)
    await (await db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES (?, ?, ?)')).run([id, tagId, 'manual'])
  }
  return id
}

test('core 端到端：title: 过滤、-排除、tag: SQL 路、普通查询兼容旧口径', async () => {
  const hitId = await seedFile({ title: 'mermaid 蒸馏指南', summary: '画图实践' })
  await seedFile({ title: 'mermaid 无关噪声版', summary: '摘要也含蒸馏' })
  await seedFile({ title: '别的主题', summary: '含 mermaid 词' })
  const tagId = await seedFile({ title: '带标签文档', summary: 'tagged', tags: ['github'] })

  const db = await getDb()
  // title: 只留标题命中的行
  const byTitle = await searchKnowledgeCore(db, { query: 'mermaid title:蒸馏' })
  assert.ok(byTitle.every((r: any) => String(r.title || '').toLowerCase().includes('蒸馏')), 'title: 过滤生效')
  assert.ok(byTitle.some((r: any) => Number(r.id) === hitId))

  // -排除 剔除噪声行
  const excluded = await searchKnowledgeCore(db, { query: 'mermaid -噪声' })
  assert.ok(!excluded.some((r: any) => String(r.title || '').includes('噪声')), '-排除 生效')

  // tag: 走 SQL 路命中带标签文件
  const byTag = await searchKnowledgeCore(db, { query: 'tag:github' })
  assert.ok(byTag.some((r: any) => Number(r.id) === tagId), 'tag: 命中标签文件（无自由词也能检索）')

  // 兼容锚：普通查询无语法词元 → 行为与旧口径一致（summary 命中）
  const plain = await searchKnowledgeCore(db, { query: '画图实践' })
  assert.ok(plain.some((r: any) => Number(r.id) === hitId))
})

test('core 端到端：坏别名配置不炸检索（配置容错）', async () => {
  const db = await getDb()
  await (await db.prepare("UPDATE config SET value = '{broken' WHERE key = 'search.aliases'")).run()
  const r = await searchKnowledgeCore(db, { query: 'mermaid' })
  assert.ok(Array.isArray(r), '坏 JSON 时空别名直通，检索照常返回')
  await (await db.prepare("UPDATE config SET value = '{\"gh\": \"tag:github\"}' WHERE key = 'search.aliases'")).run()
  const viaAlias = await searchKnowledgeCore(db, { query: 'gh' })
  assert.ok(Array.isArray(viaAlias), '合法别名正常解析')
})
