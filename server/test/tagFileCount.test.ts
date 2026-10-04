import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 「挂载 N 篇」展示口径（GET /api/tags 的 file_count）与领域成员统一口径：
// 1. 一级锚定标签 = 领域成员数（归类 ∪ 标签体系挂载，db.ts domainMemberPredicate）——
//    「领域 ≡ 同名一级标签」不变式的成员半边。WHY：标签挂载（蒸馏自由打标）与领域归属
//    （蒸馏精确匹配 + 手动）是两条独立写入链路，展示层若各数各的，同名条目数字必然失真
//    （真实库曾现 应用开发 72 vs 13,989 的 194 倍倒挂）。标签墙与分拣区必须同源可比，
//    否则用户无法用任一视图校验另一个。
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

test('一级锚定标签 file_count = 领域成员数（并集口径），与分拣区 /api/domains 同数（成员半边不变式）', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('口径领域甲', '#123456')`)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('口径领域甲') as any
  await db.exec(`INSERT INTO tags (name, level, domain_id) VALUES ('口径领域甲', 'primary', ${dom.id})`)
  const tag = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('口径领域甲') as any

  // 领域成员两链路刻意错开：2 篇归类 + 1 篇域外文件挂锚点标签（不归类）+ 1 deleted 归类
  // 并集口径 = DISTINCT(2 归类 ∪ 1 挂载) = 3——挂了领域标签的文件就是领域内容，不允许
  // 「领域卡 0 vs 展开区次要标签 288」式自相矛盾（金融科技 2026-10-03 实测形态）
  await addFile(db, { domainId: dom.id })
  await addFile(db, { domainId: dom.id })
  await addFile(db, { domainId: dom.id, status: 'deleted' })
  const outside = await addFile(db, {})
  await addMount(db, outside, tag.id)

  const list = await callGet(routeHandler(tagsRouter, 'get', '/'), { level: 'primary', status: 'active', limit: '500' })
  assert.equal(list.success === undefined || list.success, true)
  const t = list.items.find((i: any) => i.name === '口径领域甲')
  assert.ok(t, '一级标签必须出现在列表')
  assert.equal(t.file_count, 3, '一级标签挂载必须 = 领域成员并集（2 归类 + 1 锚点挂载，deleted 不计）')

  // 与分拣区同源互证：GET /api/domains 的同名领域 count 必须与标签墙一致（不变式的可观察面）
  const tree = await callGet(routeHandler(domainsRouter, 'get', '/'))
  const node = tree.find((n: any) => n.name === '口径领域甲')
  assert.ok(node, '领域必须出现在分拣区')
  assert.equal(node.count, t.file_count, '分拣区领域成员数必须 ≡ 标签墙一级标签挂载数')
})

test('金融科技形态：归类 0 但锚点/次要标签有挂载 → 领域成员数 = 并集去重，不得显示 0', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('口径领域乙', '#234567')`)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('口径领域乙') as any
  await db.exec(`INSERT INTO tags (name, level, domain_id) VALUES ('口径领域乙', 'primary', ${dom.id})`)
  const anchor = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('口径领域乙') as any
  // 挂靠锚点的次要标签（分拣区展开区 TOP3 的数据源）
  await db.exec(`INSERT INTO tags (name, level, parent_tag_id) VALUES ('口径次级丙', 'secondary', ${anchor.id})`)
  const sec = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('口径次级丙') as any

  // 0 篇归类；锚点挂 2 篇、次级挂 3 篇，其中 1 篇同时挂两者（并集去重的关键样本）
  const f1 = await addFile(db, {})
  const f2 = await addFile(db, {})
  const f3 = await addFile(db, {})
  const f4 = await addFile(db, {})
  const fBoth = await addFile(db, {})
  const fDead = await addFile(db, { status: 'deleted' })
  await addMount(db, f1, anchor.id)
  await addMount(db, f2, anchor.id)
  await addMount(db, f3, sec.id)
  await addMount(db, f4, sec.id)
  await addMount(db, fBoth, anchor.id)
  await addMount(db, fBoth, sec.id)
  await addMount(db, fDead, sec.id)

  const tree = await callGet(routeHandler(domainsRouter, 'get', '/'))
  const node = tree.find((n: any) => n.name === '口径领域乙')
  assert.ok(node, '领域必须出现在分拣区')
  assert.equal(node.count, 5, '并集 = f1,f2(锚点) ∪ f3,f4,fBoth(次级) 去重 = 5；挂载链路文件必须计入领域成员，deleted 不计')
})

test('次要标签脱离锚点（未挂靠/锚点失效）不计入领域成员——挂靠关系是并集边界', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('口径领域丁', '#345678')`)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('口径领域丁') as any
  await db.exec(`INSERT INTO tags (name, level, domain_id) VALUES ('口径领域丁', 'primary', ${dom.id})`)
  // 孤儿次级标签（无 parent），挂了文件——不属于任何领域体系
  await db.exec(`INSERT INTO tags (name, level) VALUES ('口径孤儿次级', 'secondary')`)
  const orphan = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('口径孤儿次级') as any
  const f = await addFile(db, {})
  await addMount(db, f, orphan.id)

  const tree = await callGet(routeHandler(domainsRouter, 'get', '/'))
  const node = tree.find((n: any) => n.name === '口径领域丁')
  assert.ok(node)
  assert.equal(node.count, 0, '未挂靠到锚点的次要标签不在领域体系内，其挂载不计入领域成员')
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
