import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 「一级标签就是领域」语义（PATCH primary 分支）：
// 设为一级 = 与同名领域自动对齐；同名领域不存在时【自动创建】领域并绑定——
// 旧逻辑此处返回 400（要求先手工建领域），与新语义「一级即领域」冲突。
// 本套件钉住路由层不变量：同名锚定 / 缺则建域 / domainId 显式优先 / 非法 level 仍 400。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-tagalign-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { tagsRouter } = await import('../src/routes/tags.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function patchHandler(): any {
  const layer = (tagsRouter as any).stack.find((l: any) => l.route?.methods?.patch && l.route?.path === '/:id')
  assert.ok(layer, 'tags 路由必须存在 PATCH /:id')
  return layer.route.stack[layer.route.stack.length - 1].handle
}

async function callPatch(handler: any, id: number, body: any): Promise<{ code: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      status(code: number) { this._code = code; return this },
      json(b: any) { resolve({ code: this._code ?? 200, body: b }) }
    }
    Promise.resolve(handler({ params: { id: String(id) }, body }, res)).catch(reject)
  })
}

async function makeTag(db: any, name: string, level = 'normal') {
  await db.exec(`INSERT INTO tags (name, level) VALUES ('${name}', '${level}')`)
  const row = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(name) as any
  return row.id
}

test('设为一级：同名领域存在 → 锚定绑定，不新建', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('云原生', '#123456')`)
  const id = await makeTag(db, '云原生-锚定测')
  await db.exec(`UPDATE tags SET name = '云原生' WHERE id = ${id}`)

  const { code, body } = await callPatch(patchHandler(), id, { level: 'primary', force: true })
  assert.equal(code, 200)
  assert.equal(body.success, true)
  const t = await (await db.prepare('SELECT level, domain_id FROM tags WHERE id = ?')).get(id) as any
  assert.equal(t.level, 'primary')
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('云原生') as any
  assert.equal(t.domain_id, dom.id, '必须绑定到既有同名领域')
  const domCount = (await (await db.prepare('SELECT COUNT(*) AS n FROM domains WHERE name = ?')).get('云原生') as any).n
  assert.equal(domCount, 1, '同名领域已存在时不得重复创建')
})

test('设为一级：无同名领域 → 自动创建领域并绑定（一级即领域）', async () => {
  const db = await getDb()
  const id = await makeTag(db, '自动建域测')
  const before = (await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any).n

  const { code, body } = await callPatch(patchHandler(), id, { level: 'primary', force: true })
  assert.equal(code, 200)
  assert.equal(body.success, true)

  const t = await (await db.prepare('SELECT level, domain_id FROM tags WHERE id = ?')).get(id) as any
  assert.equal(t.level, 'primary')
  const dom = await (await db.prepare('SELECT id, name FROM domains WHERE id = ?')).get(t.domain_id) as any
  assert.ok(dom, '必须已创建领域并绑定 domain_id')
  assert.equal(dom.name, '自动建域测', '领域名必须与标签名对齐')
  const after_ = (await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any).n
  assert.equal(after_, before + 1)
})

test('显式 domainId：名实一致放行、名实分裂 400（领域 ≡ 同名一级标签）；非法 level 仍 400', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name, color) VALUES ('目标域', '#ABCDEF')`)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('目标域') as any
  await db.exec(`INSERT INTO domains (name, color) VALUES ('同名域', '#000000')`)
  const sameDom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('同名域') as any
  const id = await makeTag(db, '目标域')

  const ok = await callPatch(patchHandler(), id, { level: 'primary', domainId: dom.id, force: true })
  assert.equal(ok.body.success, true)
  const t = await (await db.prepare('SELECT domain_id FROM tags WHERE id = ?')).get(id) as any
  assert.equal(t.domain_id, dom.id, '名实一致的显式绑定必须成功')

  // 名实一致门禁（修复点）：旧行为允许把标签挂到任意名领域，制造「一级标签名 ≠ 领域名」分裂
  const mis = await makeTag(db, '分裂挂靠测')
  const badBind = await callPatch(patchHandler(), mis, { level: 'primary', domainId: sameDom.id, force: true })
  assert.equal(badBind.code, 400, '标签名与域名不一致的显式挂靠必须 400')
  assert.equal(badBind.body.success, false)

  const bad = await callPatch(patchHandler(), id, { level: 'vault' })
  assert.equal(bad.code, 400)
  assert.equal(bad.body.success, false)
})

// —— 异常处理面（自动建域逻辑的失败路径）——

test('异常：显式 domainId 指向不存在的领域 → 400，不写悬挂引用', async () => {
  const db = await getDb()
  const id = await makeTag(db, '悬空域引用测')
  const { code, body } = await callPatch(patchHandler(), id, { level: 'primary', domainId: 999999, force: true })
  assert.equal(code, 400, '必须拦截不存在的 domainId')
  assert.equal(body.success, false)
  const t = await (await db.prepare('SELECT level, domain_id FROM tags WHERE id = ?')).get(id) as any
  assert.equal(t.level, 'normal', '失败路径不得改变 level')
  assert.equal(t.domain_id, null, '不得留下悬挂 domain_id（与删除领域悬挂引用同类问题）')
})

test('异常：显式 domainId 为垃圾值（abc / 0）→ 400，与 parentTagId 校验对齐', async () => {
  const db = await getDb()
  const id = await makeTag(db, '垃圾域id测')
  const a = await callPatch(patchHandler(), id, { level: 'primary', domainId: 'abc', force: true })
  assert.equal(a.code, 400, '垃圾 domainId 不得静默回退同名建域（client 错必须 fail loud，与 parentTagId 行为一致）')
  assert.equal(a.body.success, false)
  const b = await callPatch(patchHandler(), id, { level: 'primary', domainId: 0, force: true })
  assert.equal(b.code, 400, '0 不是合法 id')
  const t = await (await db.prepare('SELECT level FROM tags WHERE id = ?')).get(id) as any
  assert.equal(t.level, 'normal')
})

test('异常：改名 + 设一级同请求 → 领域必须按【新名】对齐', async () => {
  const db = await getDb()
  const id = await makeTag(db, '改名对齐旧名测')
  const { code, body } = await callPatch(patchHandler(), id, { name: '改名对齐新名测', level: 'primary', force: true })
  assert.equal(code, 200)
  assert.equal(body.success, true)
  const t = await (await db.prepare('SELECT name, domain_id FROM tags WHERE id = ?')).get(id) as any
  assert.equal(t.name, '改名对齐新名测')
  const dom = await (await db.prepare('SELECT name FROM domains WHERE id = ?')).get(t.domain_id) as any
  assert.equal(dom.name, '改名对齐新名测', '领域名必须与改名后的标签名对齐（按旧名建域即违约）')
  const oldDom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get('改名对齐旧名测') as any
  assert.ok(!oldDom, '不得残留按旧名创建的领域')
})

test('异常：标签名含单引号/注入形态 → 转义建域成功，domains 表完好', async () => {
  const db = await getDb()
  const weird = `it's a "test'); DROP TABLE domains;--`
  await db.exec(`INSERT INTO tags (name, level) VALUES ('${weird.replace(/'/g, "''")}', 'normal')`)
  const row = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(weird) as any
  assert.ok(row, '注入形态标签名应原样入库')
  const { code, body } = await callPatch(patchHandler(), row.id, { level: 'primary', force: true })
  assert.equal(code, 200)
  assert.equal(body.success, true)
  const dom = await (await db.prepare('SELECT id FROM domains WHERE name = ?')).get(weird) as any
  assert.ok(dom, '必须按字面名建域（转义正确）')
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM domains')).get() as any
  assert.ok(Number(cnt.n) > 0, 'domains 表必须仍在（未被注入破坏）')
  const t = await (await db.prepare('SELECT domain_id FROM tags WHERE id = ?')).get(row.id) as any
  assert.equal(t.domain_id, dom.id, '标签必须绑定到按字面名创建的领域')
})

test('迁移 v2/v3：merged/retired 残留的 primary 头衔必须清掉（v1 只扫 active 的缺口）', async () => {
  const db = await getDb()
  const { migrateTagLevels } = await import('../src/db.js')
  // 模拟 v1 时代存量：非 active 标签顶着 primary 且无领域（真实库曾有 436 个，全被 v1 的 status='active' 过滤漏掉）
  await db.exec(`UPDATE config SET value = '1' WHERE key = 'tagSystem.levelVersion'`)
  await db.exec(`INSERT INTO tags (name, level, status, domain_id) VALUES ('merged残留一级测', 'primary', 'merged', NULL)`)
  await db.exec(`INSERT INTO tags (name, level, status, domain_id) VALUES ('retired残留一级测', 'primary', 'retired', NULL)`)

  await migrateTagLevels(db)

  const merged = await (await db.prepare("SELECT level FROM tags WHERE name = 'merged残留一级测'")).get() as any
  assert.equal(merged.level, 'normal', 'merged 残留 primary 必须降级 normal')
  const retired = await (await db.prepare("SELECT level FROM tags WHERE name = 'retired残留一级测'")).get() as any
  assert.equal(retired.level, 'normal', 'retired 残留 primary 必须降级 normal')
  const ver = await (await db.prepare("SELECT value FROM config WHERE key = 'tagSystem.levelVersion'")).get() as any
  assert.equal(ver.value, '4', '迁移版本必须推进到 4（v2 清头衔 + v3 补领域同名标签 + v4 重复领域去重，防重跑门槛升级）')
  // 幂等：重跑不得再动任何数据
  await migrateTagLevels(db)
  const again = await (await db.prepare("SELECT COUNT(*) AS n FROM tags WHERE level = 'primary' AND domain_id IS NULL AND status != 'active'")).get() as any
  assert.equal(Number(again.n), 0, '重跑后非 active 孤儿 primary 必须保持为 0')
})
