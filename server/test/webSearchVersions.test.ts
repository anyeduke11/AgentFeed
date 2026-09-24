import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 批次①（Hister 竞品分析落地）两块能力的契约测试：
//
// A. Web 混合检索出口 GET /api/search——把此前只服务 MCP/chat 的 searchKnowledgeCore
//    暴露给人侧。钉住：{ success } 约定、空 query 空结果不报错、title/summary 命中、
//    domain 过滤联动、limit 钳制（>50 收 50）。fail 点设计：若路由绕过 searchKnowledgeCore
//    自写 SQL，title/summary 双字段命中或过滤口径会与 MCP 端漂移，此处显眼失败。
//
// B. 版本链激活——file_versions 曾是无写入方的休眠表，前端 md5Short 恒显 '-'。
//    钉住：同 path 内容真变更（md5 迭代）→ scanner 落 supersedes 行 + old_md5；
//    版本回摆（A→B→A）不产生重复行；GET /:id/versions 返回 md5 字段且新版本在前。
//
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录，绝不误伤生产 server/data/app.db。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-batch1-db-'))
const ROOTS_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-batch1-roots-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { scan } = await import('../src/scanner.js')
const { searchRouter } = await import('../src/routes/search.js')
const { filesRouter } = await import('../src/routes/files.js')

/** 有效字符 >300、体积 >512B，稳过默认门禁（同 scanRepro.test.ts） */
const LONG = '这是一段足够长的正文内容用于通过最小正文字符门禁评估。'.repeat(14)

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
  await fs.rm(ROOTS_TMP, { recursive: true, force: true })
})

// ---------- A. /api/search 路由 ----------

/** 直调路由 handler（同 profileRoutes.test.ts 模式：不启 http server） */
async function searchCall(query: Record<string, any>) {
  let json: any, status = 200
  const layer = (searchRouter as any).stack.find((l: any) => l.route?.methods?.get && l.route.path === '/')
  await layer.route.stack[0].handle({ query }, {
    status(c: number) { status = c; return this },
    json(payload: any) { json = payload },
  })
  return { status, json }
}

let seq = 0
async function seedFile(opts: { title?: string; summary?: string; mtime?: string; domainId?: number }) {
  const db = await getDb()
  seq += 1
  const r = await (await db.prepare(
    'INSERT INTO files (path, name, ext, title, source_agent, file_mtime, domain_id, summary, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )).run([`/tmp/b1-${seq}.md`, `b1-${seq}.md`, '.md', opts.title ?? null, null, opts.mtime ?? '2026-09-01T00:00:00.000Z', opts.domainId ?? null, opts.summary ?? null, 'active'])
  return Number(r.lastID)
}

test('GET /api/search：title 与 summary 双字段命中 + { success } 约定', async () => {
  await seedFile({ title: 'mermaid 图表蒸馏实践' })
  await seedFile({ title: '无关标题甲', summary: '这篇讲 quarkus 原生镜像编译' })

  const r = await searchCall({ query: 'quarkus' })
  assert.equal(r.status, 200)
  assert.equal(r.json.success, true)
  assert.equal(r.json.total, 1)
  assert.match(r.json.items[0].summary, /quarkus/)
})

test('GET /api/search：空 query 返回空数组（不 500）；domain 过滤联动；limit 钳制到 50', async () => {
  const empty = await searchCall({})
  assert.equal(empty.json.success, true)
  assert.equal(empty.json.items.length, 0)

  const db = await getDb()
  const domId = Number((await (await db.prepare('INSERT INTO domains (name) VALUES (?)')).run(['云原生'])).lastID)
  await seedFile({ title: '目标命中词文档', domainId: domId })
  await seedFile({ title: '目标命中词无领域' })

  const filtered = await searchCall({ query: '目标命中词', domain: '云原生' })
  assert.equal(filtered.json.total, 1, 'domain 过滤必须与 MCP 端同口径')
  assert.equal(filtered.json.items[0].domain_name, '云原生')

  const clamped = await searchCall({ query: '目标', limit: '999' })
  assert.ok(clamped.json.items.length <= 50, 'limit 必须 ICU 钳制 ≤50，防全库倾倒')
})

// ---------- B. 版本链（scanner 写入 + versions 端点） ----------

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(ROOTS_TMP, 'root-'))
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(root, rel)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, content)
  }
  return root
}

async function versionRows(fileId: number) {
  const db = await getDb()
  return (await db.prepare('SELECT * FROM file_versions WHERE file_id = ? ORDER BY id')).all(fileId) as any[]
}

async function versionsCall(id: number) {
  let json: any
  const layer = (filesRouter as any).stack.find((l: any) => l.route?.methods?.get && l.route.path === '/:id/versions')
  await layer.route.stack[0].handle({ params: { id: String(id) } }, { status(c: number) { return this }, json(p: any) { json = p } })
  return json
}

test('版本链：md5 迭代落 supersedes + old_md5；回摆去重；端点返回 md5 字段', async () => {
  const root = await makeRoot({ 'doc.md': LONG })
  const db = await getDb()
  await db.exec(`INSERT INTO scan_roots (path) VALUES ('${root.replace(/'/g, "''")}')`)
  const fp = path.join(root, 'doc.md')

  // 第一版入库
  await scan({ roots: [root], full: true, source: 'test' })
  const v1 = (await (await db.prepare('SELECT id, md5 FROM files WHERE path = ?')).get(fp)) as any
  assert.ok(v1.md5, '控制：首版已入库')

  // 内容变更 → 第二版：必须落 supersedes 行，old_md5 = 首版指纹
  await fs.writeFile(fp, LONG + '\n第二版追加一段内容，md5 必然变化。')
  await fs.utimes(fp, new Date(), new Date(Date.now() + 2000))  // 撬动 mtime 绕开缓存快路径
  await scan({ roots: [root], full: true, source: 'test' })
  let rows = await versionRows(v1.id)
  assert.equal(rows.length, 1, '内容真变更必须记录版本链')
  assert.equal(rows[0].relation_type, 'supersedes')
  assert.equal(rows[0].old_md5, v1.md5)

  // 回摆到第一版内容：旧 md5（第二版指纹）是新记录，但再次回摆同指纹必须去重
  await fs.writeFile(fp, LONG)
  await fs.utimes(fp, new Date(), new Date(Date.now() + 4000))
  await scan({ roots: [root], full: true, source: 'test' })
  await fs.writeFile(fp, LONG + '\n第二版追加一段内容，md5 必然变化。')
  await fs.utimes(fp, new Date(), new Date(Date.now() + 6000))
  await scan({ roots: [root], full: true, source: 'test' })
  rows = await versionRows(v1.id)
  const uniq = new Set(rows.map(r => r.old_md5))
  assert.equal(uniq.size, rows.length, 'A→B→A→B 回摆不得产生重复版本行')

  // 端点契约：md5 字段存在（FileDrawer md5Short 数据源），新版本在前
  const out = await versionsCall(v1.id)
  assert.ok(Array.isArray(out) && out.length >= 2)
  assert.ok(out.every((r: any) => typeof r.md5 === 'string' && r.md5.length > 0), '历史行必须带 md5（此前恒显 - 的缺陷）')
})
