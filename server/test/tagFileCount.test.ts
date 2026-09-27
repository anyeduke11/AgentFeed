import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 「挂载 N 篇」展示口径（GET /api/tags 的 file_count）：
// 1. 一级锚定标签 = 领域 active 成员数——「领域 ≡ 同名一级标签」不变式的成员半边。
//    WHY：标签挂载（蒸馏自由打标）与领域归属（蒸馏精确匹配 + 手动）是两条独立写入链路，
//    展示层若各数各的，同名条目数字必然失真（真实库曾现 应用开发 72 vs 13,989 的 194 倍倒挂）。
//    标签墙与分拣区必须同源可比，否则用户无法用任一视图校验另一个。
// 2. 其余标签只数 active 文件挂载——删除文件不清理 file_tags（scanner/gate 多数删除路径
//    只置 status），raw 计数曾混入 7k+ 死挂载；「挂载」用户语义 = 有效内容挂载。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-tagcount-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { tagsRouter } = await import('../src/routes/tags.js')
const { domainsRouter } = await import('../src/routes/domains.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function routeHandler(router: any, method: string, routePath: string): any {
  const layer = router.stack.find((l: any) => l.route?.methods?.[method] && l.route?.path === routePath)
  assert.ok(layer, `路由必须存在 ${method.toUpperCase()} ${routePath}`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}

async function callGet(handler: any, query: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = { json(b: any) { resolve(b) }, setHeader() { /* tags export 不在此套件覆盖 */ } }
    Promise.resolve(handler({ query }, res)).catch(reject)
  })
}

let seq = 0
async function addFile(db: any, opts: { status?: string; domainId?: number | null } = {}): Promise<number> {
  const p = `/tmp/tagcount-fixture-${++seq}.md`
  const domainClause = opts.domainId != null ? String(opts.domainId) : 'NULL'
  const statusClause = opts.status ?? 'active'
  await db.exec(`INSERT INTO files (path, name, ext, source_agent, status, domain_id)
    VALUES ('${p}', 'f${seq}.md', 'md', 'test', '${statusClause}', ${domainClause})`)
  const row = await (await db.prepare('SELECT id FROM files WHERE path = ?')).get(p) as any
  return row.id
}

async function addMount(db: any, fileId: number, tagId: number, source = 'llm') {
  await db.exec(`INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES (${fileId}, ${tagId}, '${source}')`)
}

test('一级锚定标签 file_count = 领域 active 成员数，与分拣区 /api/domains 同数（成员半边不变式）', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('口径领域甲', '#123456')`)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('口径领域甲') as any
  await db.exec(`INSERT INTO tags (name, level, domain_id) VALUES ('口径领域甲', 'primary', ${dom.id})`)
  const tag = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('口径领域甲') as any

  // 领域成员：2 active + 1 deleted；同名一级标签挂载：仅 1 篇（还是领域外的文件）——两条链路刻意错开
  await addFile(db, { domainId: dom.id })
  await addFile(db, { domainId: dom.id })
  await addFile(db, { domainId: dom.id, status: 'deleted' })
  const outside = await addFile(db, {})
  await addMount(db, outside, tag.id)

  const list = await callGet(routeHandler(tagsRouter, 'get', '/'), { level: 'primary', status: 'active', limit: '500' })
  assert.equal(list.success === undefined || list.success, true)
  const t = list.items.find((i: any) => i.name === '口径领域甲')
  assert.ok(t, '一级标签必须出现在列表')
  assert.equal(t.file_count, 2, '一级标签挂载必须显示领域 active 成员数（2），而非 file_tags 原始挂载（1）')

  // 与分拣区同源互证：GET /api/domains 的同名领域 count 必须与标签墙一致（不变式的可观察面）
  const tree = await callGet(routeHandler(domainsRouter, 'get', '/'))
  const node = tree.find((n: any) => n.name === '口径领域甲')
  assert.ok(node, '领域必须出现在分拣区')
  assert.equal(node.count, t.file_count, '分拣区领域成员数必须 ≡ 标签墙一级标签挂载数')
})

test('普通/次要标签 file_count 只数 active 文件挂载，deleted 残留不计（有效挂载口径）', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO tags (name, level) VALUES ('口径普通标签乙', 'normal')`)
  const tag = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('口径普通标签乙') as any
  const alive = await addFile(db, {})
  const dead = await addFile(db, { status: 'deleted' })
  await addMount(db, alive, tag.id)
  await addMount(db, dead, tag.id)

  const list = await callGet(routeHandler(tagsRouter, 'get', '/'), { status: 'active', limit: '5000' })
  const t = list.items.find((i: any) => i.name === '口径普通标签乙')
  assert.ok(t, '普通标签必须出现在列表')
  assert.equal(t.file_count, 1, '挂载必须只数 active 文件（1），不含 deleted 残留（旧口径会显示 2）')
})
