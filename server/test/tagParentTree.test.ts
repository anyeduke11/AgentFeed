import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 标签二级父挂靠（树形）：secondary 必须挂在 primary 下（parent_tag_id）。
// 为什么要有这列：二级是「一级的子标签」，树形关联让一个一级聚合多个二级——
// 强度规则 = 手动 PATCH 强制传 parentTagId（路由层 400），AI 提案软挂（落未挂靠组）。
// 本套件钉住 db 层不变量：列存在 + 父级合并/停用时子标签回落未挂靠。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-tagtree-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { mergeTagsInto } = await import('../src/llm/tagGovernance.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

async function makeTag(db: any, name: string, level: string, parentTagId: number | null = null) {
  await db.exec(`INSERT INTO tags (name, level, parent_tag_id) VALUES ('${name}', '${level}', ${parentTagId ?? 'NULL'})`)
  const row = await (await db.prepare('SELECT id FROM tags WHERE name = ?')).get(name) as any
  return row.id
}

test('tags 迁移后带 parent_tag_id 列', async () => {
  const db = await getDb()
  const cols = await (await db.prepare('PRAGMA table_info(tags)')).all() as any[]
  assert.ok(cols.some(c => c.name === 'parent_tag_id'), '迁移后 tags 必须有 parent_tag_id 列')
})

test('父级被合并时次级子标签回落未挂靠（树不能指向已消失的父）', async () => {
  const db = await getDb()
  const parentId = await makeTag(db, '父级-工程', 'primary')
  const childId = await makeTag(db, '子级-版本管理', 'secondary', parentId)
  const otherId = await makeTag(db, '无关-云开发', 'secondary', null)

  await mergeTagsInto(db, otherId, [parentId], 'test_merge_parent')

  const child = await (await db.prepare('SELECT parent_tag_id, status FROM tags WHERE id = ?')).get(childId) as any
  assert.equal(child.parent_tag_id, null, '子标签的 parent_tag_id 必须被清空')
  assert.equal(child.status, 'active', '子标签本身不受父级合并影响')
  const merged = await (await db.prepare('SELECT status, merged_into FROM tags WHERE id = ?')).get(parentId) as any
  assert.equal(merged.status, 'merged')
})

test('父级停用路径同样清理子标签挂靠（retire 语义的 db 层前置）', async () => {
  const db = await getDb()
  const parentId = await makeTag(db, '父级-安全', 'primary')
  const childId = await makeTag(db, '子级-安全开发', 'secondary', parentId)
  // 与路由 retire 端点相同的两条语句（db 层不变量钉住）
  await db.exec(`UPDATE tags SET status = 'retired' WHERE id = ${parentId} AND status = 'active'`)
  await db.exec(`UPDATE tags SET parent_tag_id = NULL WHERE parent_tag_id = ${parentId}`)
  const child = await (await db.prepare('SELECT parent_tag_id FROM tags WHERE id = ?')).get(childId) as any
  assert.equal(child.parent_tag_id, null)
})

test('列表接口返回 parent_name（树形展示的数据契约）', async () => {
  const db = await getDb()
  const pid = await makeTag(db, '父级-列表', 'primary')
  await makeTag(db, '子级-列表', 'secondary', pid)
  const rows = await (await db.prepare(`
    SELECT t.*, pt.name AS parent_name FROM tags t
    LEFT JOIN tags pt ON pt.id = t.parent_tag_id
    WHERE t.name = '子级-列表'
  `)).all() as any[]
  assert.equal(rows[0].parent_name, '父级-列表')
})
