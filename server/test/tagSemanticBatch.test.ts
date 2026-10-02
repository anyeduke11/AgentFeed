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

// ---- 二级选拔 prompt：现有二级格局注入（整合优先于新增） ----
// WHY：选拔若看不到已有二级清单，会把「项目管理」这类已是二级的概念反复提为新二级
// （真实库 10 条建议中 6 条与既有二级/一级重叠）。注入格局 + 规则 2 后，可归入现有
// 二级的候选应被排除——整合优先于另立山头。
test('buildLevelPrompt：注入一级+二级清单与整合排除规则，批标签入 payload', async () => {
  const { buildLevelPrompt } = await import('../src/llm/tagGovernance.js')
  const p = buildLevelPrompt(
    '网络安全(4051)、数据安全(1045)',
    '云原生 → 容器编排、服务 mesh\n人工智能 → 评估体系、RAG 落地',
    [{ name: '项目管理', fc: 88 }, { name: 'RAG 工程', fc: 60 }]
  )
  assert.ok(p.includes('网络安全(4051)'), '一级清单必须注入（防重复补位）')
  assert.ok(p.includes('云原生 → 容器编排、服务 mesh'), '二级分组清单必须注入（整合判断依据）')
  assert.ok(p.includes('可归入某个现有二级'), '整合排除规则必须在场（候选近于现有二级不入选）')
  assert.ok(p.includes('"n":"项目管理","c":88'), '批标签按 n/c 契约进 payload')
  assert.ok(p.includes('第一个字符必须是'), '输出纪律条款在场（治 llm_json_parse_failed）')
})

// ---- 孤儿二级 AI 批量挂靠 ----
// WHY：level 提案软挂不指父 + 人工补挂不会发生（真实库积压 154 个）→ 领域卡只显示
// 已挂靠二级 = 用户永远看不见。治理 = LLM 语义映射 + 确定性双闸校验：
// 标签确在本批（防幻觉名）+ 父确是 active primary（防幻觉父）——挂错比不挂危害大。
test('attachOrphanSecondary：合法映射挂靠、幻觉名/幻觉父拒绝、拿不准保持未挂靠、批失败不中断', async () => {
  const { attachOrphanSecondary, buildAttachPrompt } = await import('../src/llm/tagGovernance.js')
  const db = await getDb()
  // 种：一级甲/乙 + 三个未挂靠二级
  const mk = async (name: string, level: string, parent: number | null) => {
    await db.exec(`INSERT INTO tags (name, level, parent_tag_id) VALUES ('${name}', '${level}', ${parent ?? 'NULL'})`)
    return Number(((await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(name) as any).id))
  }
  const p1 = await mk('挂靠一级甲', 'primary', null)
  await mk('挂靠一级乙', 'primary', null)
  const s1 = await mk('挂靠二级甲', 'secondary', null)
  const s2 = await mk('挂靠二级乙', 'secondary', null)
  const s3 = await mk('挂靠二级丙', 'secondary', null)
  // mock LLM：甲→一级甲（合法）；幻觉名（不在批）→拒；乙→幻觉父（不存在的一级）→拒；丙不提（拿不准）
  const llm = async (prompt: string) => {
    assert.ok(prompt.includes('挂靠一级甲') && prompt.includes('挂靠二级甲'), 'prompt 须注入一级清单与孤儿名单')
    assert.ok(prompt.includes('"attach":[{"n":'), '输出契约须在 prompt 内')
    return { attach: [
      { n: '挂靠二级甲', p: '挂靠一级甲' },
      { n: '不存在的标签', p: '挂靠一级乙' },
      { n: '挂靠二级乙', p: '幻觉一级' },
    ] }
  }
  const r = await attachOrphanSecondary(db, llm)
  assert.equal(r.attached, 1, '仅合法映射挂靠')
  assert.ok(r.skipped >= 2, '幻觉名/幻觉父/未提及均计 skipped')
  const q = async (id: number) => ((await (await db.prepare('SELECT parent_tag_id AS p FROM tags WHERE id = ?')).get(id) as any).p)
  assert.equal(await q(s1), p1, '合法映射挂到正确一级')
  assert.equal(await q(s2), null, '幻觉父必须拒绝（保持未挂靠）')
  assert.equal(await q(s3), null, 'LLM 未提及 = 拿不准，保持未挂靠')
  // 空库路径：无孤儿时零调用
  await db.exec(`UPDATE tags SET parent_tag_id = NULL WHERE id = ${s1}`)
  const r2 = await attachOrphanSecondary(db, async () => { throw new Error('不应调用') })
  assert.deepEqual({ a: r2.attached, b: r2.batches > 0 }, { a: 0, b: true }, '批失败整批跳过不中断')
})
