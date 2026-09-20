import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// search_knowledge 核心抽取兼容性钉死（Phase 2 检索改造的对照组地基）：
// MCP handler 的内联 SQL 已平移到 knowledge.ts 的 searchKnowledgeCore，
// 之后 MCP 工具、基线脚本、测试共用这一份实现——行为绝不允许漂移。
// 这里逐条钉死原契约：LIKE 命中 title/summary/path 三字段、domain/tags/agent 过滤、
// file_mtime 降序、默认 limit 20；任何改变输出契约的"检索优化"必须先在这里显眼地失败。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 mcpLogArgs.test.ts 模式），绝不误伤生产库。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-knowledge-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { searchKnowledgeCore } = await import('../src/knowledge.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let seq = 0
async function seedFile(opts: {
  title?: string
  summary?: string
  sourceAgent?: string
  mtime: string
  domainId?: number
}) {
  const db = await getDb()
  seq += 1
  const result = await (await db.prepare(
    'INSERT INTO files (path, name, ext, title, source_agent, file_mtime, domain_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )).run([`/tmp/seed-${seq}.md`, `seed-${seq}.md`, '.md', opts.title ?? null, opts.sourceAgent ?? null, opts.mtime, opts.domainId ?? null, opts.summary ?? null])
  return Number(result.lastID)
}

async function seedDomain(name: string): Promise<number> {
  const db = await getDb()
  const result = await (await db.prepare('INSERT INTO domains (name) VALUES (?)')).run([name])
  return Number(result.lastID)
}

async function seedTag(name: string): Promise<number> {
  const db = await getDb()
  const result = await (await db.prepare('INSERT INTO tags (name) VALUES (?)')).run([name])
  return Number(result.lastID)
}

async function linkTag(fileId: number, tagId: number) {
  const db = await getDb()
  await (await db.prepare('INSERT INTO file_tags (file_id, tag_id, source) VALUES (?, ?, ?)')).run([fileId, tagId, 'manual'])
}

test('query 分别命中 title / summary / path 三个字段（LIKE 三字段契约）', async () => {
  const titleId = await seedFile({ title: 'mermaid 图表蒸馏实践', mtime: '2026-09-01T00:00:00.000Z' })
  const summaryId = await seedFile({ title: '无关标题', summary: '这篇讲 quarkus 原生镜像编译', mtime: '2026-09-02T00:00:00.000Z' })
  const pathId = await seedFile({ title: '无关标题', mtime: '2026-09-03T00:00:00.000Z' })
  // 把第三个文件的 path 定向改为含关键词（seed 路径自增，不依赖插入顺序）
  const db = await getDb()
  await (await db.prepare('UPDATE files SET path = ? WHERE id = ?')).run([`/vault/notes/vitest-patterns.md`, pathId])

  const byTitle = await searchKnowledgeCore(db, { query: 'mermaid' })
  assert.ok(byTitle.some(r => Number(r.id) === titleId), 'query 必须命中 title')
  const bySummary = await searchKnowledgeCore(db, { query: 'quarkus' })
  assert.ok(bySummary.some(r => Number(r.id) === summaryId), 'query 必须命中 summary')
  const byPath = await searchKnowledgeCore(db, { query: 'vitest-patterns' })
  assert.ok(byPath.some(r => Number(r.id) === pathId), 'query 必须命中 path')
})

test('domain 过滤生效且返回 d.name as domain_name 别名（字段别名契约）', async () => {
  const infraId = await seedDomain('Infra')
  const writerId = await seedDomain('Writing')
  const inInfra = await seedFile({ title: '域名过滤命中', mtime: '2026-09-04T00:00:00.000Z', domainId: infraId })
  const inWriter = await seedFile({ title: '域名过滤另一域', mtime: '2026-09-05T00:00:00.000Z', domainId: writerId })

  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '域名过滤', domain: 'Infra' })
  const ids = rows.map(r => Number(r.id))
  assert.ok(ids.includes(inInfra), 'domain 过滤必须保留目标域文件')
  assert.ok(!ids.includes(inWriter), 'domain 过滤必须排除其他域文件')
  const hit = rows.find(r => Number(r.id) === inInfra)
  assert.equal(hit?.domain_name, 'Infra', '返回行必须保留 domain_name 别名（MCP 层映射 domain 字段的依据）')
})

test('tags 过滤生效（任一命中语义：t.name IN，非 AND 全命中）', async () => {
  const ragId = await seedTag('rag')
  const embedId = await seedTag('embedding')
  const withRag = await seedFile({ title: '标签过滤甲', mtime: '2026-09-06T00:00:00.000Z' })
  const withEmbed = await seedFile({ title: '标签过滤乙', mtime: '2026-09-07T00:00:00.000Z' })
  const untagged = await seedFile({ title: '标签过滤丙', mtime: '2026-09-08T00:00:00.000Z' })
  await linkTag(withRag, ragId)
  await linkTag(withEmbed, embedId)

  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '标签过滤', tags: ['rag', 'embedding'] })
  const ids = rows.map(r => Number(r.id))
  assert.ok(ids.includes(withRag) && ids.includes(withEmbed), '任一标签命中的文件都要返回（IN 语义）')
  assert.ok(!ids.includes(untagged), '无标签文件必须被排除')
})

test('agent 过滤生效（f.source_agent = ? 精确匹配）', async () => {
  const mine = await seedFile({ title: '归属过滤命中', sourceAgent: 'claw-bot', mtime: '2026-09-09T00:00:00.000Z' })
  await seedFile({ title: '归属过滤排除', sourceAgent: 'other-bot', mtime: '2026-09-10T00:00:00.000Z' })

  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '归属过滤', agent: 'claw-bot' })
  const ids = rows.map(r => Number(r.id))
  assert.deepEqual(ids, [mine], '只返回匹配 agent 的那一条')
  assert.equal(rows[0].source_agent, 'claw-bot')
})

test('默认排序 = file_mtime 降序（与插入顺序无关）', async () => {
  const older = await seedFile({ title: '排序契约样例', mtime: '2026-01-01T00:00:00.000Z' })
  const newest = await seedFile({ title: '排序契约样例', mtime: '2026-06-15T00:00:00.000Z' })
  const middle = await seedFile({ title: '排序契约样例', mtime: '2026-03-02T00:00:00.000Z' })

  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '排序契约' })
  assert.deepEqual(rows.map(r => Number(r.id)), [newest, middle, older], '必须按 file_mtime 从新到旧返回')
})

test('默认 limit = 20；显式 limit 原样透传（截断语义契约）', async () => {
  // 插 25 条全命中：默认只回最新 20 条（最旧 5 条被截掉）
  const inserted: number[] = []
  for (let i = 0; i < 25; i++) {
    const id = await seedFile({ title: '限额契约批量', mtime: `2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z` })
    inserted.push(id)
  }
  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '限额契约' })
  assert.equal(rows.length, 20, '不传 limit 时必须默认截断到 20')
  const returned = rows.map(r => Number(r.id))
  assert.ok(inserted.slice(5).every(id => returned.includes(id)), '截断必须从最旧开始丢（mtime 降序 + LIMIT 20）')
  assert.ok(!returned.includes(inserted[0]) && !returned.includes(inserted[4]), '最旧 5 条不得出现在默认结果里')

  const limited = await searchKnowledgeCore(db, { query: '限额契约', limit: 5 })
  assert.equal(limited.length, 5, '显式 limit 必须原样生效')
  assert.equal(Number(limited[0].id), inserted[24], 'limit 截断同样基于 mtime 降序，最新一条排第一')
})

test('since/until 时间窗命中：闭区间夹住中间一条（file_mtime 过滤契约）', async () => {
  const older = await seedFile({ title: '窗口命中甲', mtime: '2026-09-01T00:00:00.000Z' })
  const middle = await seedFile({ title: '窗口命中乙', mtime: '2026-09-13T12:00:00.000Z' })
  const newer = await seedFile({ title: '窗口命中丙', mtime: '2026-09-20T00:00:00.000Z' })

  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '窗口命中', since: '2026-09-13T00:00:00.000Z', until: '2026-09-14T00:00:00.000Z' })
  const ids = rows.map(r => Number(r.id))
  assert.deepEqual(ids, [middle], '闭区间窗口必须只夹住中间那条（mtime 降序唯一命中）')
  assert.ok(!ids.includes(older) && !ids.includes(newer), '窗口外的最旧/最新记录必须被排除')
})

test('时间窗边界：mtime 恰等于 since / until 的记录都命中（闭区间语义）', async () => {
  const atSince = await seedFile({ title: '边界命中甲', mtime: '2026-09-13T00:00:00.000Z' })
  const atUntil = await seedFile({ title: '边界命中乙', mtime: '2026-09-14T00:00:00.000Z' })

  const db = await getDb()
  const rows = await searchKnowledgeCore(db, { query: '边界命中', since: '2026-09-13T00:00:00.000Z', until: '2026-09-14T00:00:00.000Z' })
  assert.deepEqual(
    rows.map(r => Number(r.id)).sort((a, b) => b - a),
    [atUntil, atSince],
    '等于 since / until 边界的记录都必须命中（>= 与 <= 而非 > 与 <）'
  )
})

test('非法日期字符串被忽略：不报错且结果与不传参数一致（健壮性契约）', async () => {
  await seedFile({ title: '非法日期兜底甲', mtime: '2026-09-13T00:00:00.000Z' })
  await seedFile({ title: '非法日期兜底乙', mtime: '2026-09-14T00:00:00.000Z' })

  const db = await getDb()
  const baseline = await searchKnowledgeCore(db, { query: '非法日期兜底' })
  const withInvalid = await searchKnowledgeCore(db, { query: '非法日期兜底', since: 'not-a-date', until: 'also-not-a-date' })
  assert.deepEqual(
    withInvalid.map(r => Number(r.id)),
    baseline.map(r => Number(r.id)),
    '非法日期必须被忽略：不报错、不过滤，结果与不传 since/until 完全一致'
  )
})
