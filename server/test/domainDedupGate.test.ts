import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 重复领域 + 升级门禁修复的回归钉（第一性原理：领域 ≡ 一级标签强一致，重复域 = 不变式破缺）：
// 根因 1（重复领域）：domains.UNIQUE(name, parent_id) 对 parent_id=NULL 失效（SQLite NULL 互不相等），
//   「缺省域」×2、「预算域」×3 由此产生且可再生——三层防线：v4 去重迁移 + 部分唯一索引 + 启动对账；
// 根因 2（升级质量差）：PATCH primary 零门槛（0 挂载也升一级、显式挂靠允许名实分裂、无现有领域格局分析）——
//   门禁 = MIN_PRIMARY_MOUNTS + force 人工担责 + analysis 透明化；accept_level 跳过领域锚点。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-domdedup-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb, migrateTagLevels, reconcileDomainTagSync } = await import('../src/db.js')
const { domainsRouter } = await import('../src/routes/domains.js')
const { tagsRouter } = await import('../src/routes/tags.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function routerHandler(router: any, method: string, p: string): any {
  const layer = router.stack.find((l: any) => l.route?.methods?.[method] && l.route?.path === p)
  assert.ok(layer, `路由必须存在 ${method.toUpperCase()} ${p}`)
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

async function makeFile(db: any, name: string, domainId: number | null = null): Promise<number> {
  await db.exec(`INSERT INTO files (path, name, ext, domain_id) VALUES ('/tmp/${name}.md', '${name}', 'md', ${domainId === null ? 'NULL' : domainId})`)
  // 显式 finalize：未 finalize 的语句句柄会与后续迁移内 DDL 冲突（SQLITE_LOCKED）
  const stmt = await db.prepare('SELECT id FROM files WHERE name = ?')
  const row = await stmt.get(name) as any
  await stmt.finalize()
  return Number(row.id)
}

test('v4 迁移：重复领域去重，files/tags 引用先重指向 keeper（挂载文件最多者），不留悬挂', async () => {
  const db = await getDb()
  // 模拟真实库「预算域」×3：UNIQUE(name, parent_id) 对 NULL 父级失效放进来的重复
  // （部分唯一索引此时已存在，先卸掉才能复现索引诞生前的存量脏数据；迁移内 IF NOT EXISTS 会重建）
  await db.exec(`DROP INDEX IF EXISTS ux_domains_name_root`)
  await db.exec(`INSERT INTO domains (name) VALUES ('预算域')`)
  await db.exec(`INSERT INTO domains (name) VALUES ('预算域')`)
  await db.exec(`INSERT INTO domains (name) VALUES ('预算域')`)
  // 迁移前不留未 finalize 的语句句柄（与迁移内 DDL 冲突会触发 SQLITE_LOCKED）
  const domsStmt = await db.prepare("SELECT id FROM domains WHERE name = '预算域' ORDER BY id")
  const doms = await domsStmt.all() as any[]
  await domsStmt.finalize()
  const [d1, d2, d3] = doms.map(r => Number(r.id))
  // 挂载分布：d2 最多（2 文件）→ keeper 必须是 d2；d3 挂 1 个、d1 挂 0 个
  await makeFile(db, '预算文件甲', d2)
  await makeFile(db, '预算文件乙', d2)
  await makeFile(db, '预算文件丙', d3)
  // 同名一级标签历史上绑在 d1（先到先得），v4 必须一并重指向 keeper
  await db.exec(`INSERT INTO tags (name, level, status, domain_id) VALUES ('预算域', 'primary', 'active', ${d1})`)

  // 版本回拨到 3 → 重放 v4 段（v1~v3 幂等）
  await db.exec(`UPDATE config SET value = '3' WHERE key = 'tagSystem.levelVersion'`)
  await migrateTagLevels(db)

  const kept = await (await db.prepare("SELECT id FROM domains WHERE name = '预算域'")).all() as any[]
  assert.equal(kept.length, 1, '重复领域必须去重为 1')
  assert.equal(Number(kept[0].id), d2, '必须保留挂载文件最多的 keeper')
  const orphan = await (await db.prepare('SELECT COUNT(*) AS n FROM files WHERE domain_id IS NOT NULL AND domain_id NOT IN (SELECT id FROM domains)')).get() as any
  assert.equal(Number(orphan.n), 0, 'files 不得残留悬挂 domain_id（先重指向再删除）')
  const t = await (await db.prepare("SELECT domain_id FROM tags WHERE name = '预算域'")).get() as any
  assert.equal(Number(t.domain_id), d2, '同名一级标签必须重指向 keeper')
  const ver = await (await db.prepare("SELECT value FROM config WHERE key = 'tagSystem.levelVersion'")).get() as any
  assert.equal(ver.value, '4', '迁移版本必须推进到 4')
})

test('部分唯一索引：根级同名域直接插入被 DB 拒绝（应用层查重之外的底线）', async () => {
  const db = await getDb()
  await db.exec(`INSERT INTO domains (name) VALUES ('索引守卫域')`)
  await assert.rejects(
    () => db.exec(`INSERT INTO domains (name) VALUES ('索引守卫域')`),
    /UNIQUE/i,
    '根级（parent_id=NULL）同名插入必须被 ux_domains_name_root 拒绝'
  )
  // 树形子级不受部分索引限制：不同父级下同名子域仍合法（既有层级语义保持）
  const parent = await (await db.prepare("SELECT id FROM domains WHERE name = '索引守卫域'")).get() as any
  await db.exec(`INSERT INTO domains (name, parent_id) VALUES ('子域', ${Number(parent.id)})`)
  const other = await (await db.prepare("SELECT id FROM domains WHERE name = '网络安全'")).get() as any
  assert.ok(other, '前置：种子领域存在')
  await db.exec(`INSERT INTO domains (name, parent_id) VALUES ('子域', ${Number(other.id)})`)
  const subCnt = (await (await db.prepare("SELECT COUNT(*) AS n FROM domains WHERE name = '子域' AND parent_id IS NOT NULL")).get() as any).n
  assert.equal(Number(subCnt.n ?? subCnt), 2, '不同父级下同名子域不受部分唯一索引影响')
})

test('reconcileDomainTagSync：幽灵一级降级、领域缺标签补建（运行期漂移自愈）', async () => {
  const db = await getDb()
  // 幽灵一级：primary 但 domain_id 为 NULL（或指向已删领域）——降级 normal
  await db.exec(`INSERT INTO tags (name, level, status) VALUES ('幽灵一级测', 'primary', 'active')`)
  const ghost = await (await db.prepare("SELECT id FROM tags WHERE name = '幽灵一级测'")).get() as any
  // 领域缺标签：绕过 POST 直接 INSERT 域（模拟历史不同步的存量）
  await db.exec(`INSERT INTO domains (name, color) VALUES ('对账补建域', '#123456')`)
  const dom = await (await db.prepare("SELECT id FROM domains WHERE name = '对账补建域'")).get() as any

  await reconcileDomainTagSync(db)

  const g = await (await db.prepare('SELECT level, status FROM tags WHERE id = ?')).get(ghost.id) as any
  assert.equal(g.level, 'normal', '挂靠失效的幽灵一级必须降级 normal')
  const t = await (await db.prepare('SELECT level, status, domain_id FROM tags WHERE name = ?')).get('对账补建域') as any
  assert.ok(t, '缺标签领域必须被补建同名一级标签')
  assert.equal(t.level, 'primary')
  assert.equal(Number(t.domain_id), Number(dom.id))
})

test('domains POST：归一变体查重 409 + existingId（空白/大小写变体不再造重复领域）', async () => {
  const post = routerHandler(domainsRouter, 'post', '/')
  const first = await call(post, {}, { name: '归一查重域', color: '#123456' })
  assert.equal(first.body.success, true)

  const v1 = await call(post, {}, { name: '归一 查重域' })
  assert.equal(v1.code, 409, '空白变体必须 409')
  assert.equal(v1.body.success, false)
  assert.equal(Number(v1.body.existingId), Number(first.body.id), '必须回带 existingId')

  const second = await call(post, {}, { name: 'api 网关', color: '#123456' })
  assert.equal(second.body.success, true)
  const v2 = await call(post, {}, { name: 'API网关' })
  assert.equal(v2.code, 409, '大小写变体必须 409（归一后同名）')

  const fresh = await call(post, {}, { name: '全新领域名', color: '#123456' })
  assert.equal(fresh.body.success, true, '真新名必须放行')
})

test('tags PATCH 升级门禁：0 挂载 400 且指明 force；force 放行回带 warnings/analysis；达标免 force', async () => {
  const db = await getDb()
  const patch = routerHandler(tagsRouter, 'patch', '/:id')
  await db.exec(`INSERT INTO tags (name, level) VALUES ('门禁测标签', 'normal')`)
  const id = Number((await (await db.prepare("SELECT id FROM tags WHERE name = '门禁测标签'")).get() as any).id)

  // 门禁本体：0 挂载无 force → 400（修复「0 挂载也能升一级」的零门槛漏洞）
  const denied = await call(patch, { id: String(id) }, { level: 'primary' })
  assert.equal(denied.code, 400)
  assert.match(denied.body.message, /force/, '拒绝信息必须指明 force 豁免通道')
  const unchanged = await (await db.prepare('SELECT level FROM tags WHERE id = ?')).get(id) as any
  assert.equal(unchanged.level, 'normal', '被拒后 level 不得变化')

  // force 放行：回带 analysis（现有领域格局对比）与 warnings
  const ok = await call(patch, { id: String(id) }, { level: 'primary', force: true })
  assert.equal(ok.body.success, true)
  assert.ok(ok.body.analysis, '必须回带现有领域格局分析')
  assert.equal(ok.body.analysis.mounts, 0)
  assert.ok(Array.isArray(ok.body.warnings) && ok.body.warnings.length > 0, '0 挂载 force 升级应有量级 warning')

  // 达标放行：10 次挂载（= MIN_PRIMARY_MOUNTS），无 force 也 200
  await db.exec(`INSERT INTO tags (name, level) VALUES ('达标测标签', 'normal')`)
  const id2 = Number((await (await db.prepare("SELECT id FROM tags WHERE name = '达标测标签'")).get() as any).id)
  for (let i = 0; i < 10; i++) {
    const fid = await makeFile(db, `达标文件${i}`)
    await db.exec(`INSERT INTO file_tags (file_id, tag_id, source) VALUES (${fid}, ${id2}, 'manual')`)
  }
  const ok2 = await call(patch, { id: String(id2) }, { level: 'primary' })
  assert.equal(ok2.code, 200, '挂载达门槛（≥10）无需 force')
  assert.equal(ok2.body.success, true)
  assert.equal(ok2.body.analysis.mounts, 10)
})

test('tags PATCH 归一挂靠：空白变体标签锚定既有领域并自动对齐名称（不再新建重复域）', async () => {
  const db = await getDb()
  const patch = routerHandler(tagsRouter, 'patch', '/:id')
  await db.exec(`INSERT INTO domains (name, color) VALUES ('变体锚定域', '#123456')`)
  const dom = await (await db.prepare("SELECT id FROM domains WHERE name = '变体锚定域'")).get() as any
  await db.exec(`INSERT INTO tags (name, level) VALUES ('变体锚定域 ', 'normal')`) // 尾随空白变体
  const id = Number((await (await db.prepare("SELECT id FROM tags WHERE name = '变体锚定域 '")).get() as any).id)

  const r = await call(patch, { id: String(id) }, { level: 'primary', force: true })
  assert.equal(r.body.success, true)
  const t = await (await db.prepare('SELECT name, domain_id FROM tags WHERE id = ?')).get(id) as any
  assert.equal(Number(t.domain_id), Number(dom.id), '归一变体必须锚定既有领域而非新建')
  assert.equal(t.name, '变体锚定域', '标签名必须自动对齐领域规范名（守护同名不变式，否则启动对账撞 UNIQUE）')
  assert.ok((r.body.warnings || []).some((w: string) => w.includes('挂靠')), '应回带挂靠绑定 warning')
  const cnt = (await (await db.prepare("SELECT COUNT(*) AS n FROM domains WHERE name LIKE '变体锚定域%'")).get() as any).n
  assert.equal(Number(cnt.n ?? cnt), 1, '不得新建重复领域')
})

test('accept_level：与领域同名的成员被跳过（领域锚点保护），其余正常降级', async () => {
  const db = await getDb()
  const accept = routerHandler(tagsRouter, 'post', '/proposals/:id/accept')
  await db.exec(`INSERT INTO domains (name, color) VALUES ('锚点保护域', '#123456')`)
  await db.exec(`INSERT INTO tags (name, level, status) VALUES ('锚点保护域', 'primary', 'active')`)
  await db.exec(`INSERT INTO tags (name, level, status) VALUES ('待降级普通甲', 'normal', 'active')`)
  await db.exec(`INSERT INTO tags (name, level, status) VALUES ('待降级普通乙', 'normal', 'active')`)
  await db.exec(`INSERT INTO tag_proposals (kind, canonical, members) VALUES ('level', '', '["锚点保护域","待降级普通甲","待降级普通乙"]')`)
  const pid = Number((await (await db.prepare("SELECT id FROM tag_proposals WHERE kind = 'level' ORDER BY id DESC LIMIT 1")).get() as any).id)

  const r = await call(accept, { id: String(pid) }, {})
  assert.equal(r.body.success, true)
  assert.equal(r.body.skippedPrimary, 1, '领域同名成员必须跳过并计数')
  const anchor = await (await db.prepare("SELECT level, status FROM tags WHERE name = '锚点保护域'")).get() as any
  assert.equal(anchor.level, 'primary', '领域锚点标签不得被降级（降级会让领域失锚且同名阻塞重建）')
  const a = await (await db.prepare("SELECT level, parent_tag_id FROM tags WHERE name = '待降级普通甲'")).get() as any
  assert.equal(a.level, 'secondary', '非锚点成员正常降级为次要')
  const b = await (await db.prepare("SELECT level FROM tags WHERE name = '待降级普通乙'")).get() as any
  assert.equal(b.level, 'secondary')
})
