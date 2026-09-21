import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 强一致不变式：领域 ≡ 一级主要标签（双向一一对应）。
// 标签 → 领域方向由 tags PATCH primary 保证（同名锚定/缺则建域，见 tagDomainAlign.test.ts）；
// 本套件钉住反方向：建领域必产生同名一级标签、改领域名必同步改名——
// 历史缺口：POST/PATCH 领域从不碰 tags，「前端开发」领域改名「应用开发」后一级标签留在旧名 retired。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-domtag-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb, migrateTagLevels } = await import('../src/db.js')
const { domainsRouter } = await import('../src/routes/domains.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function routeHandler(method: 'post' | 'patch', p: string): any {
  const layer = (domainsRouter as any).stack.find((l: any) => l.route?.methods?.[method] && l.route?.path === p)
  assert.ok(layer, `domains 路由必须存在 ${method.toUpperCase()} ${p}`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}

function call(handler: any, params: any, body: any): Promise<{ code: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      status(code: number) { this._code = code; return this },
      json(b: any) { resolve({ code: this._code ?? 200, body: b }) }
    }
    Promise.resolve(handler({ params, body }, res)).catch(reject)
  })
}

test('POST 领域 → 同名 active 一级标签自动出现并绑定', async () => {
  const db = await getDb()
  const { body } = await call(routeHandler('post', '/'), {}, { name: '同步建标测', color: '#123456' })
  assert.equal(body.success, true)
  const t = await (await db.prepare('SELECT level, status, domain_id FROM tags WHERE name = ?')).get('同步建标测') as any
  assert.ok(t, '同名一级标签必须已被创建')
  assert.equal(t.level, 'primary')
  assert.equal(t.status, 'active')
  assert.equal(t.domain_id, body.id, '必须绑定到刚创建的领域')
})

test('POST 领域时同名普通标签已存在 → 升格为一级并绑定，不重建', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO tags (name, level, status) VALUES ('升格标测', 'normal', 'active')`)
  const before = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('升格标测') as any
  const { body } = await call(routeHandler('post', '/'), {}, { name: '升格标测', color: '#123456' })
  assert.equal(body.success, true)
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM tags WHERE name = ?')).get('升格标测') as any
  assert.equal(Number(cnt.n), 1, 'UNIQUE 名下不得重复建标签')
  const t = await (await db.prepare('SELECT level, status, domain_id FROM tags WHERE id = ?')).get(before.id) as any
  assert.equal(t.level, 'primary', '既有同名标签必须升格为一级（即该领域本身）')
  assert.equal(t.status, 'active')
  assert.equal(t.domain_id, body.id)
})

test('PATCH 领域改名 → 同名 active 一级标签跟随改名（改名失配即强一致破缺）', async () => {
  const db = await getDb()
  const { body } = await call(routeHandler('post', '/'), {}, { name: '改名跟随旧', color: '#123456' })
  const domId = body.id
  const tag = await (await db.prepare('SELECT id FROM tags WHERE name = ? AND domain_id = ?')).get(['改名跟随旧', domId]) as any
  assert.ok(tag, '前置：领域创建时一级标签已同步')

  const { body: pb } = await call(routeHandler('patch', '/:id'), { id: String(domId) }, { name: '改名跟随新' })
  assert.equal(pb.success, true)
  const t = await (await db.prepare('SELECT name, level, status FROM tags WHERE id = ?')).get(tag.id) as any
  assert.equal(t.name, '改名跟随新', '一级标签名必须跟随领域新名（否则墙上少一个一级）')
  assert.equal(t.level, 'primary')
  assert.equal(t.status, 'active')
})

test('PATCH 领域改回死名（retired 占用）→ 死行让位，一级标签成功改名', async () => {
  const db = await getDb()
  // 模拟真实库场景：retired 旧标签占用「前端开发」名，领域现在叫「应用开发」想改回去
  await db.exec(`INSERT INTO tags (name, level, status) VALUES ('占用死名测', 'primary', 'retired')`)
  const dead = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get('占用死名测') as any
  const { body } = await call(routeHandler('post', '/'), {}, { name: '占用现名测', color: '#123456' })
  const domId = body.id
  const tag = await (await db.prepare('SELECT id FROM tags WHERE name = ? AND domain_id = ?')).get(['占用现名测', domId]) as any

  const { body: pb } = await call(routeHandler('patch', '/:id'), { id: String(domId) }, { name: '占用死名测' })
  assert.equal(pb.success, true, '死名占用不得阻断领域改名')
  const renamed = await (await db.prepare('SELECT name, level, status FROM tags WHERE id = ?')).get(tag.id) as any
  assert.equal(renamed.name, '占用死名测', '一级标签必须拿到新名')
  const yielded = await (await db.prepare('SELECT name FROM tags WHERE id = ?')).get(dead.id) as any
  assert.ok(yielded.name.includes('·'), '被让位的死行必须改名留痕（·id 后缀可溯）')
})

test('迁移 v3：存量领域缺同名一级标签 → 补建；版本推进 3；重跑幂等', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('迁移补标测', '#123456')`)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('迁移补标测') as any
  // 模拟 v2 时代存量：版本停在 2，领域无同名一级标签
  await db.exec(`UPDATE config SET value = '2' WHERE key = 'tagSystem.levelVersion'`)

  await migrateTagLevels(db)

  const t = await (await db.prepare('SELECT level, status, domain_id FROM tags WHERE name = ?')).get('迁移补标测') as any
  assert.ok(t, '迁移必须为缺口领域补建同名一级标签')
  assert.equal(t.level, 'primary')
  assert.equal(t.status, 'active')
  assert.equal(t.domain_id, dom.id, '补建标签必须绑定到缺口领域')
  const ver = await (await db.prepare("SELECT value FROM config WHERE key = 'tagSystem.levelVersion'")).get() as any
  assert.equal(ver.value, '4', '迁移版本必须推进到 4（防重跑门槛升级）')
  // 幂等：重跑不得产生重复标签
  await migrateTagLevels(db)
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM tags WHERE name = ?')).get('迁移补标测') as any
  assert.equal(Number(cnt.n), 1)
})
