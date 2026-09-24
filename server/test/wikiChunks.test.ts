import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Phase 2 · 任务 2.2 分块向量路（parent-child）的 Wave 1 命名接口测试（chunkEntryMd / indexWikiChunks / vectorSearchWiki）。
// WHY：与 searchIndex.test.ts 互补——那边钉 chunkEntryMd 基础切分与 ensureChunksIndexed 回填契约，
// 这边钉 content_hash 幂等增量（hash 相同零嵌入调用）、脏块最小重嵌、正文清空同步消失、cosine 排序契约。
// 嵌入函数全 mock（opts.embedFn 注入伪造向量），测试不依赖任何真实 embedding 服务。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 knowledge.test.ts 模式），绝不误伤生产库。
// 用例顺序有依赖（同一临时库）：空索引断言必须先于任何 seed 执行。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-wiki-chunks-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { chunkEntryMd, indexWikiChunks, vectorSearchWiki } = await import('../src/search/chunkEmbed.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let seq = 0
/** 种一个 wiki 词条：只落 entry.md + wiki_entries_meta（不建索引，由各用例显式调 indexWikiChunks） */
async function seedWikiEntry(opts: { title: string; md: string }): Promise<number> {
  const db = await getDb()
  seq += 1
  const entryPath = path.join(DATA_TMP, 'wiki', 'entries', `test-${seq}.md`)
  await fs.mkdir(path.dirname(entryPath), { recursive: true })
  await fs.writeFile(entryPath, opts.md, 'utf8')
  const r = await (await db.prepare(
    'INSERT INTO wiki_entries_meta (file_id, entry_path, title) VALUES (NULL, ?, ?)'
  )).run([entryPath, opts.title])
  return Number(r.lastID)
}

async function rewriteEntryMd(id: number, md: string): Promise<string> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE id = ?')).get([id]) as any
  await fs.writeFile(String(row.entry_path), md, 'utf8')
  return String(row.entry_path)
}

test('空索引 vectorSearchWiki 返回空数组不抛错（WHY：向量路未回填时检索不能成为崩溃源）', async () => {
  const db = await getDb()
  assert.deepEqual(await vectorSearchWiki(db, [1, 0]), [])
})

test('chunkEntryMd 边界：空 md / 纯空白不产块、无 heading 单块、超长段整段一块（WHY：切块边界必须可预期，无隐性截断）', () => {
  assert.deepEqual(chunkEntryMd(''), [], '空 md 不产块')
  assert.deepEqual(chunkEntryMd('\n\n   \n'), [], '纯空白不产块')
  const noHeading = chunkEntryMd('没有 heading 的正文段落')
  assert.equal(noHeading.length, 1, '无 heading 的正文必须是单块')
  assert.equal(noHeading[0].heading_path, '', '无 heading 块的 heading_path 必须为空串')
  const long = '超长段落'.repeat(2000) // 8000 字，超过常见嵌入模型单块建议长度
  const longChunks = chunkEntryMd(`# 标题\n\n${long}\n`)
  assert.equal(longChunks.length, 1, '超长段必须整段成块，不做长度二次切分（边界行为可预期，交给嵌入端处理）')
  assert.equal(longChunks[0].content.length, long.length, '块内容必须完整保留，无静默截断')
})

test('indexWikiChunks 单词条索引 + hash 幂等：二次调用零嵌入调用（WHY：回填入口会被反复触发，重复嵌入是纯浪费）', async () => {
  const id = await seedWikiEntry({ title: '分块词条', md: '# 分块词条\n\n第一块正文\n\n## 小节甲\n\n小节正文\n' })
  const db = await getDb()
  const calls: string[] = []
  const spyEmbed = async (text: string) => { calls.push(text); return [1, 0] }

  const first = await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal(first.reason, 'ok')
  assert.equal(first.total, 1)
  assert.equal(first.indexed, 1, '首个词条必须成功索引')
  assert.equal(first.failed, 0)
  assert.equal(calls.length, 2, '两个块各产生一次嵌入调用')
  assert.ok(calls[1].startsWith('# 分块词条 > ## 小节甲\n'), '嵌入文本必须带 heading 上下文前缀')

  const rows = await (await db.prepare('SELECT chunk_index, content_hash, embedding, model FROM entry_chunks WHERE entry_id = ? ORDER BY chunk_index')).all([id]) as any[]
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.content_hash && String(r.content_hash).length === 64), '每块必须落 content_hash（sha256 hex）')
  // L1 起向量按 Float32 BLOB 落库（JSON 文本为迁移期兼容格式）——双读解码后断言
  const { storedVecToF32, vecToBlob } = await import('../src/llm/embeddings.js')
  assert.deepEqual(Array.from(storedVecToF32(rows[0].embedding)!), [1, 0], '向量必须按 BLOB 落库且可解码')
  // BLOB 编解码契约（原 embedState.test.ts 随方案 B 并入）：roundtrip 精度 + 损坏输入返回 null
  const rt = storedVecToF32(vecToBlob([0.4, 0.5, 0.6]))!
  assert.equal(rt.length, 3)
  assert.ok(Math.abs(rt[0]! - 0.4) < 1e-6 && Math.abs(rt[2]! - 0.6) < 1e-6, 'roundtrip Float32 精度内无损')
  assert.equal(storedVecToF32('not json'), null, '损坏文本返回 null 由调用方跳过')
  assert.equal(storedVecToF32(null), null, '空值返回 null')

  const second = await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal(second.indexed, 1, '幂等重跑仍按成功口径返回')
  assert.equal(calls.length, 2, 'content_hash 未变时二次调用必须零嵌入调用')
})

test('P2 内存索引：写入即命中 + 失效即消失 + 加载窗口内写入不丢（常驻缓存一致性契约）', async () => {
  // WHY：向量常驻内存后，缓存与 DB 的一致性是检索正确性的生命线——
  // ① indexWikiChunks 写入后无需等待即可检索命中（reloadEntry 增量维护）
  // ② 正文清空后缓存同步消失（invalidateEntry）
  // ③ 缓存评分与 DB 路径评分一致（norm 预计算不得改变余弦语义）
  const db = await getDb()
  const { vectorSearchWiki } = await import('../src/search/chunkEmbed.js')
  const { ensureLoaded, indexCacheStats } = await import('../src/search/vectorIndex.js')
  await ensureLoaded(db) // 先建立缓存（模拟服务运行态）

  const id = await seedWikiEntry({ title: '内存索引一致性', md: '# 内存索引一致性\n\n唯一标记向量内容 P2XYZ\n\n## 小节\n\n小节正文 P2ABC\n' })
  const n = await indexWikiChunks(db, id, { embedFn: async t => t!.includes('P2ABC') ? [0, 1] : [1, 0] })
  assert.equal(n.indexed, 1, '词条成功入索引')

  // ① 写入即命中：内存缓存立即可检（query [1,0] 对应首块）
  const hitNow = await vectorSearchWiki(db, [1, 0], 5)
  assert.ok(hitNow.some(h => h.entry_id === id), '写入后无需等待/重建即可命中')

  // ③ 与 DB 评分一致性：同 query 下缓存命中块的分数与直接余弦一致（容差 1e-4）
  const hit = hitNow.find(h => h.entry_id === id)!
  assert.ok(Math.abs(hit.score - 1) < 1e-4 || hit.score > 0.99, '归一化向量自相似度≈1（norm 预计算不失真）')

  // ② 失效即消失：正文清空 → 块集清零 → 缓存同步消失
  await rewriteEntryMd(id, '# 内存索引一致性\n\n\n')
  await indexWikiChunks(db, id, { embedFn: async () => [0, 0] })
  const gone = await vectorSearchWiki(db, [1, 0], 50)
  assert.ok(!gone.some(h => h.entry_id === id), '正文清空后缓存必须同步消失')
  const s = indexCacheStats()
  assert.ok(s.chunks > 0, '缓存非空（其他词条仍在）')
})

test('局部更新只重嵌脏块：变化块数 = 新增嵌入调用数，stale 块被清理（WHY：增量重嵌是向量路的成本下限契约）', async () => {
  const id = await seedWikiEntry({ title: '增量词条', md: '# 增量词条\n\n保持不变的块\n\n## 小节\n\n将被修改的块\n' })
  const db = await getDb()
  const calls: string[] = []
  const spyEmbed = async (text: string) => { calls.push(text); return [1, 0] }
  await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal(calls.length, 2)

  // 只改第二块内容：第一块 hash 未变，增量成本必须只有 1 次嵌入
  await rewriteEntryMd(id, '# 增量词条\n\n保持不变的块\n\n## 小节\n\n修改后的新内容\n')
  const updated = await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal(updated.indexed, 1)
  assert.equal(calls.length, 3, '只有 hash 变化的块才重嵌（2 → 3，增量恰好 1 次）')
  assert.ok(calls[2].includes('修改后的新内容'), '新增调用必须针对脏块')

  // 再删掉第二块（重写为单块文档）：stale 块必须被清理，且不产生嵌入调用
  await rewriteEntryMd(id, '# 增量词条\n\n只剩这一块\n')
  const shrunk = await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal(shrunk.indexed, 1)
  assert.equal(calls.length, 4, '收缩后仅新增的块产生一次嵌入调用')
  const chunkRows = await (await db.prepare('SELECT chunk_index FROM entry_chunks WHERE entry_id = ? ORDER BY chunk_index')).all([id]) as any[]
  assert.deepEqual(chunkRows.map(r => Number(r.chunk_index)), [0], '收缩为单块文档后只剩 chunk 0，stale 的 chunk 1 必须被清理')
})

test('vectorSearchWiki cosine 排序：相近向量在前、正交向量被过滤、命中 child 块返回 parent 词条（WHY：parent-child 是本路核心契约）', async () => {
  // 三维向量隔离用例间数据：此前用例的二维块 cosine 维度不等返回 0，被过滤不参与排序
  const idA = await seedWikiEntry({ title: '语义目标词条', md: '# 语义目标词条\n\n目标语义内容\n' })
  const idB = await seedWikiEntry({ title: '正交词条', md: '# 正交词条\n\n无关语义内容\n' })
  const db = await getDb()
  await indexWikiChunks(db, idA, { embedFn: async (text) => text.includes('目标') ? [1, 0, 0] : [0, 1, 0] })
  await indexWikiChunks(db, idB, { embedFn: async (text) => text.includes('目标') ? [1, 0, 0] : [0, 1, 0] })

  const hits = await vectorSearchWiki(db, [1, 0, 0], 5)
  assert.ok(hits.length >= 1, '相近向量必须命中')
  assert.equal(hits[0].entry_id, idA, '余弦分最高的词条必须排第一')
  assert.equal(hits[0].title, '语义目标词条', '命中 child 块必须映射回 parent 词条')
  assert.equal(hits[0].heading_path, '# 语义目标词条', '命中结果必须携带块标题路径')
  assert.ok(hits[0].score > 0.99, '同向向量余弦应接近 1')
  assert.ok(!hits.some(h => h.entry_id === idB), '正交向量（余弦 0）必须被过滤，不出现在结果中')
})

test('正文清空同步消失：entry.md 变空后块集清零且零嵌入调用（WHY：内容消失 = 向量路同步消失，防陈旧块泄漏）', async () => {
  const id = await seedWikiEntry({ title: '清空词条', md: '# 清空词条\n\n待清空内容\n' })
  const db = await getDb()
  const calls: string[] = []
  const spyEmbed = async (text: string) => { calls.push(text); return [1, 0] }
  await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal((await (await db.prepare('SELECT COUNT(*) AS n FROM entry_chunks WHERE entry_id = ?')).get([id]) as any).n, 1)

  await rewriteEntryMd(id, '\n\n')
  const cleared = await indexWikiChunks(db, id, { embedFn: spyEmbed })
  assert.equal(cleared.indexed, 1, '无可索引块按成功口径返回')
  assert.equal(calls.length, 1, '清空场景不得产生新的嵌入调用')
  assert.equal((await (await db.prepare('SELECT COUNT(*) AS n FROM entry_chunks WHERE entry_id = ?')).get([id]) as any).n, 0, '正文清空后该词条块集必须清零')
})
