import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 删除领域：必须递归移除整棵子树，且不留任何悬挂引用。
// 为什么：旧实现只 DELETE 单行——弹窗承诺「子领域一并移除 / 文件回归未分类」全部落空，
// 孤儿子领域 parent_id 悬挂后列表组树（parent?.children.push）静默丢节点，成为不可管理的幽灵领域；
// files.domain_id 悬挂导致收件坪/分拣区计数错乱，tags.domain_id 悬挂破坏一级标签强制挂靠。
// 本套件钉住路由层不变量：整树删除 + files/tags 引用清零 + 无效 id 400。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-domdel-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { domainsRouter } = await import('../src/routes/domains.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function deleteHandler(): any {
  const layer = (domainsRouter as any).stack.find((l: any) => l.route?.methods?.delete && l.route?.path === '/:id')
  assert.ok(layer, 'domains 路由必须存在 DELETE /:id')
  return layer.route.stack[layer.route.stack.length - 1].handle
}

async function callDelete(handler: any, id: string): Promise<{ code: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      status(code: number) { this._code = code; return this },
      json(body: any) { resolve({ code: this._code ?? 200, body }) }
    }
    Promise.resolve(handler({ params: { id } }, res)).catch(reject)
  })
}

async function makeDomain(db: any, name: string, parentId: number | null): Promise<number> {
  await db.exec(`INSERT INTO domains (name, parent_id) VALUES ('${name}', ${parentId ?? 'NULL'})`)
  const row = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get(name) as any
  return row.id
}

async function makeFile(db: any, name: string, domainId: number | null) {
  await db.exec(`INSERT INTO files (path, name, ext, status, domain_id) VALUES ('/tmp/${name}', '${name}', '.md', 'active', ${domainId ?? 'NULL'})`)
}

test('删除父级领域：子树一并移除 + files/tags 悬挂引用全部清零', async () => {
  const db = await getDb()
  const grand = await makeDomain(db, '根领域-删除测', null)
  const child = await makeDomain(db, '子领域-删除测', grand)
  const gchild = await makeDomain(db, '孙领域-删除测', child)
  const other = await makeDomain(db, '无关领域-删除测', null)

  await makeFile(db, 'f-根.md', grand)
  await makeFile(db, 'f-孙.md', gchild)
  await makeFile(db, 'f-无关.md', other)
  await db.exec(`INSERT INTO tags (name, level, domain_id) VALUES ('挂靠标签-删除测', 'primary', ${grand})`)
  await db.exec(`INSERT INTO tags (name, level) VALUES ('无关标签-删除测', 'normal')`)

  const { code, body } = await callDelete(deleteHandler(), grand)
  assert.equal(code, 200)
  assert.equal(body.success, true)
  assert.equal(body.removed, 3, '父+子+孙 共 3 行必须一并移除')

  const left = await (await db.prepare('SELECT id FROM domains')).all() as any[]
  const leftIds = new Set(left.map(r => r.id))
  assert.equal(leftIds.has(grand), false, '父领域必须被删除')
  assert.equal(leftIds.has(child), false, '子领域必须一并删除')
  assert.equal(leftIds.has(gchild), false, '孙领域必须一并删除')
  assert.equal(leftIds.has(other), true, '无关领域必须保留')
  const orphanFile = await (await db.prepare("SELECT domain_id FROM files WHERE name = 'f-根.md'")).get() as any
  assert.equal(orphanFile.domain_id, null, '名下文件必须回归未分类')
  const otherFile = await (await db.prepare("SELECT domain_id FROM files WHERE name = 'f-无关.md'")).get() as any
  assert.equal(otherFile.domain_id, other, '无关领域的文件不受影响')
  const orphanTag = await (await db.prepare("SELECT level, domain_id FROM tags WHERE name = '挂靠标签-删除测'")).get() as any
  assert.equal(orphanTag.level, 'normal', '一级=领域：领域没了，对齐的一级标签必须降级 normal（非法态不留墙上）')
  assert.equal(orphanTag.domain_id, null, '挂靠引用必须清零')
  const otherTag = await (await db.prepare("SELECT domain_id FROM tags WHERE name = '无关标签-删除测'")).get() as any
  assert.equal(otherTag.domain_id, null, '未挂靠标签本来就是 NULL，不受影响')
})

test('无效 id 返回 400 且不误删（fail loud）', async () => {
  const db = await getDb()
  const before = (await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any).n
  const { code, body } = await callDelete(deleteHandler(), 'abc')
  assert.equal(code, 400)
  assert.equal(body.success, false)
  const after_ = (await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any).n
  assert.equal(after_, before, '400 路径不得改动任何数据')
})

test('删除后记墓碑：seedDefaults 重跑不得复活已删领域（复活 bug 根因钉子）', async () => {
  const db = await getDb()
  const { seedDefaults } = await import('../src/db.js')
  // 用真实种子名验证：删除「网络安全」（一个种子领域）→ 重跑 seedDefaults → 不得复活；其余种子照常播种
  const row = await (await db.prepare("SELECT id FROM domains WHERE name = '网络安全'")).get() as any
  const target = row ? row.id : await makeDomain(db, '网络安全', null)

  const { code, body } = await callDelete(deleteHandler(), String(target))
  assert.equal(code, 200)
  assert.equal(body.success, true)

  const tombRow = await (await db.prepare("SELECT value FROM config WHERE key = 'domains.tombstones'")).get() as any
  assert.ok(tombRow, '删除必须写入墓碑 config')
  const tombs = JSON.parse(tombRow.value)
  assert.ok(tombs.includes('网络安全'), '墓碑必须包含被删名「网络安全」')

  await seedDefaults(db)
  const revived = await (await db.prepare("SELECT id FROM domains WHERE name = '网络安全'")).get() as any
  assert.ok(!revived, 'seedDefaults 重跑不得复活墓碑内的已删领域（这就是「删除后复活」的根因）')
  const ai = await (await db.prepare("SELECT id FROM domains WHERE name = '人工智能'")).get() as any
  assert.ok(ai, '墓碑外的种子领域必须照常播种（幂等不被破坏）')
})
