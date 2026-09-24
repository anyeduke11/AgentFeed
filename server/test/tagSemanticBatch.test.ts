import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 批量接受语义归组（POST /tags/proposals/accept-batch）是长尾大规模收敛的无人值守动作，
// 必须钉死两条安全不变量：
// 1. 只合并 normal 成员——「领域 ≡ 同名一级标签」锚点与二级树归属是人工决策，批量不得误伤
// 2. 规范名已失效的建议整条跳过且保持 pending——静默吞掉会让用户误以为已收敛

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-tagbatch-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { tagsRouter } = await import('../src/routes/tags.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function batchHandler(): any {
  const layer = (tagsRouter as any).stack.find((l: any) => l.route?.methods?.post && l.route?.path === '/proposals/accept-batch')
  assert.ok(layer, 'tags 路由必须存在 POST /proposals/accept-batch')
  return layer.route.stack[layer.route.stack.length - 1].handle
}

async function callBatch(handler: any, body: any): Promise<{ code: number; body: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      status(code: number) { this._code = code; return this },
      json(b: any) { resolve({ code: this._code ?? 200, body: b }) }
    }
    Promise.resolve(handler({ body }, res)).catch(reject)
  })
}

async function makeTag(db: any, name: string, level = 'normal') {
  await db.exec(`INSERT INTO tags (name, level) VALUES ('${name}', '${level}')`)
  const row = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(name) as any
  return row.id
}

async function mount(db: any, tagId: number, n: number) {
  for (let i = 0; i < n; i++) {
    await db.exec(`INSERT INTO files (path, name, ext) VALUES ('/tmp/${tagId}-${i}.md', 'f${i}', 'md')`)
    const f = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
    await db.exec(`INSERT INTO file_tags (file_id, tag_id, source) VALUES (${f.id}, ${tagId}, 'rule')`)
  }
}

test('批量接受：normal 成员合并 + 一级成员受保护 + 规范名失效跳过保持 pending', async () => {
  const db = await getDb()
  const canonicalId = await makeTag(db, 'RAG')
  const normalMember = await makeTag(db, 'RAG 检索增强')
  const primaryMember = await makeTag(db, '云原生', 'primary')
  await mount(db, normalMember, 2)
  await mount(db, primaryMember, 3)
  await db.exec(`INSERT INTO tag_proposals (kind, canonical, members) VALUES ('semantic', 'RAG', '["RAG 检索增强","云原生"]')`)
  await db.exec(`INSERT INTO tag_proposals (kind, canonical, members) VALUES ('semantic', '不存在的规范名', '["RAG 检索增强"]')`)

  const { code, body } = await callBatch(batchHandler(), { kind: 'semantic' })
  assert.equal(code, 200)
  assert.equal(body.success, true)
  assert.equal(body.accepted, 1, '规范名失效的必须跳过，只接受 1 条')
  assert.equal(body.skipped, 1, '规范名失效的必须计入 skipped')

  const merged = await (await db.prepare('SELECT status, merged_into FROM tags WHERE id = ?')).get(normalMember) as any
  assert.equal(merged.status, 'merged')
  assert.equal(Number(merged.merged_into), canonicalId, 'normal 成员必须合并到规范名')
  const mounts = (await (await db.prepare('SELECT COUNT(*) AS n FROM file_tags WHERE tag_id = ?')).get(canonicalId) as any).n
  assert.equal(Number(mounts), 2, 'normal 成员的挂载必须转移给规范名')

  const prim = await (await db.prepare('SELECT status, level FROM tags WHERE id = ?')).get(primaryMember) as any
  assert.equal(prim.status, 'active', '一级成员禁止被批量合并（领域锚点保护）')
  assert.equal(prim.level, 'primary')

  const pending = (await (await db.prepare("SELECT COUNT(*) AS n FROM tag_proposals WHERE status = 'pending'")).get() as any).n
  assert.equal(Number(pending), 1, '规范名失效的建议必须保持 pending 留待人工')
  const op = await (await db.prepare("SELECT detail FROM tag_ops WHERE op = 'accept_semantic_batch' ORDER BY id DESC LIMIT 1")).get() as any
  assert.ok(op, '批量接受必须落 tag_ops 审计')
})

test('批量接受：kind 非 semantic 返回 400', async () => {
  const { code, body } = await callBatch(batchHandler(), { kind: 'level' })
  assert.equal(code, 400)
  assert.equal(body.success, false)
})
