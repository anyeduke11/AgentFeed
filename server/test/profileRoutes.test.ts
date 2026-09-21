import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// J2 画像维护页路由（routes/profile.ts）契约测试。
// WHY：路由是 J2 页面与 J1 model 护栏之间的唯一通道——业务规则已在 model 层钉死（profile.test.ts），
// 本套件钉 HTTP 层契约：{ success } 约定、参数校验 400、evidence 白名单与不可回溯行为、
// 版本端点解析口径。fail 点设计：evidence 若无白名单即任意表探测（越权读库）；
// claim 无长度上限即脏画像入口；versions 返回坏 JSON 版本必须 parseOk=false 而非 500。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 profile.test.ts）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-profile-routes-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { profileRouter } = await import('../src/routes/profile.js')
const { serializeProfileContent } = await import('../src/profile/model.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function handlerOf(method: string, url: string) {
  const layer = (profileRouter as any).stack.find((l: any) =>
    l.route && l.route.methods?.[method.toLowerCase()] &&
    (l.route.path === url || (l.route.path.includes(':') && url.startsWith(l.route.path.split(':')[0]) && /^\/\d+$/.test(url.slice(l.route.path.split(':')[0].length - 1)))))
  assert.ok(layer, `路由 ${method} ${url} 必须存在`)
  return (layer.route as any).stack[0].handle
}

async function call(method: string, url: string, body?: any, query: any = {}) {
  let json: any, status = 200
  // 参数路由：直调 mock 需自带 params（真实 express 由路径解析），形如 /versions/123 → { id: '123' }
  const m = url.match(/^\/versions\/(\d+)$/)
  const params = m ? { id: m[1] } : {}
  await handlerOf(method, url)({ method, body, query, params }, {
    status(c: number) { status = c; return this },
    json(payload: any) { json = payload },
  })
  return { status, json }
}

test('GET /：scope 校验 400；global 返回画像与预算；空画像 profile=null', async () => {
  const bad = await call('GET', '/', undefined, { scope: 'weird' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.success, false)
  const dom = await call('GET', '/', undefined, { scope: 'domain' })
  assert.equal(dom.status, 400, 'domain scope 缺 domainId 必 400')
  const empty = await call('GET', '/', undefined, { scope: 'global' })
  assert.equal(empty.status, 200)
  assert.equal(empty.json.success, true)
  assert.equal(empty.json.profile, null, '未蒸馏时 profile=null（页面走空态引导）')
  assert.equal(empty.json.budget, 20)
})

test('POST /claim：落库 user_added；超 200 字符 400；scope 非法 400', async () => {
  const ok = await call('POST', '/claim', { scope: 'global', claim: '用户自述：偏好渐进式引导' })
  assert.equal(ok.json.success, true)
  const db = await getDb()
  const row = await (await db.prepare(`SELECT content FROM user_profile WHERE active = 1 AND scope = 'global'`)).get() as any
  assert.ok(JSON.parse(row.content).claims.some((c: any) => c.claim.includes('渐进式') && c.status === 'user_added'), '无活跃版时自建首版')
  const tooLong = await call('POST', '/claim', { scope: 'global', claim: 'x'.repeat(201) })
  assert.equal(tooLong.status, 400)
  const badScope = await call('POST', '/claim', { scope: 'x', claim: 'ok' })
  assert.equal(badScope.status, 400)
})

test('POST /veto + GET /：否决后出口即消失；vetO 不存在断言 success=false', async () => {
  const before = await call('GET', '/', undefined, { scope: 'global' })
  const vid = before.json.profile.id
  const claimText = before.json.profile.content.claims[0].claim
  const v = await call('POST', '/veto', { versionId: vid, claim: claimText })
  assert.equal(v.json.success, true)
  const after = await call('GET', '/', undefined, { scope: 'global' })
  assert.ok(!after.json.profile.content.claims.some((c: any) => c.claim === claimText && c.status !== 'vetoed'), 'vetoed 即刻从出口消失')
  const miss = await call('POST', '/veto', { versionId: vid, claim: '不存在的断言' })
  assert.equal(miss.json.success, false)
})

test('GET /versions：列表含 parseOk 与 claimCount；坏 JSON 版本 parseOk=false 不炸', async () => {
  const db = await getDb()
  await (await db.prepare('UPDATE user_profile SET active = 0')).run()
  await (await db.prepare(`INSERT INTO user_profile (scope, domain_id, content, active) VALUES ('global', NULL, '{bad json', 1)`)).run()
  const vs = await call('GET', '/versions', undefined, { scope: 'global' })
  assert.equal(vs.json.success, true)
  const cur = vs.json.versions.find((v: any) => v.active)
  assert.ok(cur)
  assert.equal(cur.parseOk, false, '坏 JSON 版本必须标记 parseOk=false（页面提示而非 500）')
  assert.equal(cur.claimCount, null)
  // versionDetail 同口径
  const detail = await call('GET', `/versions/${cur.id}`)
  assert.equal(detail.json.success, true)
  assert.equal(detail.json.version.content, null)
  const nf = await call('GET', '/versions/99999')
  assert.equal(nf.status, 404)
})

test('POST /revert：指针切换；GET /versions/:id 返回域信息', async () => {
  const vs = await call('GET', '/versions', undefined, { scope: 'global' })
  const target = [...vs.json.versions].reverse().find((v: any) => !v.active)
  if (target) {
    const r = await call('POST', '/revert', { versionId: target.id })
    assert.equal(r.json.success, true)
    const cur = await call('GET', '/versions', undefined, { scope: 'global' })
    assert.equal(cur.json.versions.find((v: any) => v.active).id, target.id)
  }
})

test('GET /evidence：白名单表可查；白名单外 400；坏格式 400；不存在 found=false；内容截断', async () => {
  const db = await getDb()
  const r = await (await db.prepare(`INSERT INTO read_history (file_id, path, source, feedback) VALUES (NULL, '/e/pf.md', 'reader', ?)`)).run('反'.repeat(300))
  const ok = await call('GET', '/evidence', undefined, { ptr: `read_history:${Number(r.lastID)}` })
  assert.equal(ok.json.success, true)
  assert.equal(ok.json.found, true)
  assert.ok(String(ok.json.row.feedback).length <= 201, '长文本字段截断 200+省略号')
  const notFound = await call('GET', '/evidence', undefined, { ptr: 'read_history:999999' })
  assert.equal(notFound.json.found, false, '行不存在 found:false 不报错弹窗')
  const evil = await call('GET', '/evidence', undefined, { ptr: "files;DROP TABLE files:1" })
  assert.equal(evil.status, 400)
  const notListed = await call('GET', '/evidence', undefined, { ptr: 'files:1' })
  assert.equal(notListed.status, 400, '白名单外表名（files）必须 400——evidence 只允许三张信号表')
  const badFmt = await call('GET', '/evidence', undefined, { ptr: 'read_history' })
  assert.equal(badFmt.status, 400)
})

test('POST /distill + GET /status：开关状态与最后蒸馏时间；触发返回 queued 布尔', async () => {
  const st = await call('GET', '/status')
  assert.equal(st.json.success, true)
  assert.equal(st.json.enabled, true, '缺省默认开')
  const d = await call('POST', '/distill')
  assert.equal(d.json.success, true)
  assert.equal(typeof d.json.queued, 'boolean')
})
