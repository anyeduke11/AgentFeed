import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Phase 2 检索基建测试（任务 2.1 FTS 关键词路 + 任务 2.2 分块向量路）。
// WHY：Phase 2 验收核心是 CJK 检索（现有 LIKE 基线对中文长尾查询 recall 不足），
// 这里钉死 trigram 中英文命中契约、向量路的分块/幂等/降级契约。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 knowledge.test.ts 模式），绝不误伤生产库。
// 用例顺序有依赖（同一临时库）：空库断言必须先于任何 seed 执行。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-search-index-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { searchFts, rebuildFts, ensureFtsPopulated, getFtsTokenizer, upsertFtsEntry } = await import('../src/search/ftsIndex.js')
const { chunkEntryMd, ensureChunksIndexed, searchVector } = await import('../src/search/chunkEmbed.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let seq = 0
/** 种一个 wiki 词条：entry.md 落临时目录 + wiki_entries_meta（file_id 置 NULL 模拟外部挂载，不依赖 files 表） */
async function seedWikiEntry(opts: { title: string; summary?: string; md: string }): Promise<number> {
  const db = await getDb()
  seq += 1
  const entryPath = path.join(DATA_TMP, 'wiki', 'entries', `test-${seq}.md`)
  await fs.mkdir(path.dirname(entryPath), { recursive: true })
  await fs.writeFile(entryPath, opts.md, 'utf8')
  const r = await (await db.prepare(
    'INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary) VALUES (NULL, ?, ?, ?)'
  )).run([entryPath, opts.title, opts.summary ?? null])
  const id = Number(r.lastID)
  // 本波 FTS 同步 = 应用层：seed 即走增量同步路径 upsertFtsEntry（生产由蒸馏写入点调用，启动期由 rebuild 兜底）
  await upsertFtsEntry(db, id, opts.title, opts.summary ?? '', opts.md)
  return id
}

async function setConfig(key: string, value: string) {
  const db = await getDb()
  await (await db.prepare(
    `INSERT INTO config (key, value, type) VALUES (?, ?, 'json') ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )).run([key, value])
}

test('空库 searchFts 返回空数组不抛错（WHY：启动早期/空知识库下检索路不能成为崩溃源）', async () => {
  const db = await getDb()
  // getDb 已触发 ensureFtsTable：本探测环境 trigram 可用（能力探测结论见汇报）
  assert.equal(getFtsTokenizer(), 'trigram')
  const hits = await searchFts(db, '任意关键词')
  assert.deepEqual(hits, [])
  const emptyQuery = await searchFts(db, '   ')
  assert.deepEqual(emptyQuery, [], '空 query 也必须返回空数组')
})

test('中文 query 命中标题（WHY：CJK 检索是 Phase 2 验收核心，trigram 子串语义必须生效）', async () => {
  await seedWikiEntry({
    title: '机器学习蒸馏实践',
    summary: 'summary placeholder',
    md: '# 机器学习蒸馏实践\n\n正文讲模型蒸馏\n'
  })
  const db = await getDb()
  const hits = await searchFts(db, '蒸馏实践')
  assert.ok(hits.some(h => h.title === '机器学习蒸馏实践'), '4 字中文子串 query 必须经 trigram MATCH 命中标题')
})

test('2 字中文 query 回退 LIKE 仍命中（WHY：trigram 最小单元是 3 字符，短 query 必须有兜底分支）', async () => {
  const db = await getDb()
  const hits = await searchFts(db, '蒸馏')
  assert.ok(hits.some(h => h.title === '机器学习蒸馏实践'), '短于 3 字符的 CJK query 必须经 LIKE 回退命中')
})

test('英文 query 命中摘要（WHY：英文走 MATCH 路径，覆盖非 CJK 主场景）', async () => {
  await seedWikiEntry({
    title: '部署笔记',
    summary: 'quarkus native image build notes',
    md: '# 部署笔记\n\n正文占位\n'
  })
  const db = await getDb()
  const hits = await searchFts(db, 'quarkus')
  assert.ok(hits.some(h => h.title === '部署笔记'), '英文 query 必须命中 summary 字段')
  assert.ok(hits.every(h => typeof h.snippet === 'string'), '命中结果必须携带片段摘要')
})

test('含 FTS5 语法字符的 query 不抛错（WHY：query 来自 agent 自由文本，语法字符必须被转义隔离）', async () => {
  const db = await getDb()
  const hits = await searchFts(db, '"quot^ OR (1=1) --')
  assert.ok(Array.isArray(hits), 'FTS5 特殊字符 query 必须被双引号短语包裹后安全执行')
})

test('rebuildFts 幂等：重复重建无重复行且结果一致（WHY：集成后 DELETE+重插路径不允许膨胀索引）', async () => {
  const db = await getDb()
  const first = await searchFts(db, 'quarkus')
  await rebuildFts(db)
  const second = await searchFts(db, 'quarkus')
  await rebuildFts(db)
  const third = await searchFts(db, 'quarkus')
  assert.deepEqual(third.map(h => h.entry_id), second.map(h => h.entry_id), '两次 rebuild 后命中集合必须一致')
  assert.equal(new Set(third.map(h => h.entry_id)).size, third.length, '同一词条不得出现重复命中行')
  assert.ok(second.length >= first.length, 'rebuild 不得丢已有命中')
})

test('ensureFtsPopulated：FTS 非空跳过；FTS 清空后回填一次；超上限拒绝回填（WHY：启动期回填必须幂等且防误伤大库）', async () => {
  const db = await getDb()
  const skip = await ensureFtsPopulated(db)
  assert.equal(skip.reason, 'fts_not_empty', 'FTS 已有数据时必须跳过，不做无谓全量重建')
  assert.equal(skip.rebuilt, false)

  const db2 = db
  await db2.exec('DELETE FROM wiki_fts')
  const rebuilt = await ensureFtsPopulated(db2)
  assert.equal(rebuilt.reason, 'rebuilt')
  assert.equal(rebuilt.rebuilt, true, 'FTS 空而主表非空时必须回填一次')
  assert.ok(rebuilt.entries > 0, '回填条目数必须等于主表规模')

  await db2.exec('DELETE FROM wiki_fts')
  const capped = await ensureFtsPopulated(db2, { cap: 1 })
  assert.equal(capped.reason, 'over_cap', '主表规模超上限时必须拒绝回填（保护大库启动耗时）')
  assert.equal(capped.rebuilt, false)
  await rebuildFts(db2) // 恢复索引，供后续用例使用
})

test('chunkEntryMd：多 heading 分块数与顺序、heading_path 层级路径正确', () => {
  const chunks = chunkEntryMd([
    '文件顶部前言',
    '',
    '# 总标题',
    '',
    '前言段落',
    '',
    '## 安装',
    '',
    'npm install 步骤',
    '',
    '### 配置',
    '',
    'config.json 说明',
    '',
    '## 使用',
    '',
    '调用示例'
  ].join('\n'))
  // WHY：heading_path 是 child 块回带 parent 上下文的关键，层级拼错会让向量语义张冠李戴
  assert.equal(chunks.length, 5, '顶部前言 + 前言段落 + 三个小节应切出 5 块')
  assert.equal(chunks[0].heading_path, '', '首个 heading 之前的前言块 heading_path 必须为空串')
  assert.equal(chunks[1].heading_path, '# 总标题', '前言段落位于 # 总标题 之下，路径必须携带它')
  assert.equal(chunks[2].heading_path, '# 总标题 > ## 安装')
  assert.equal(chunks[3].heading_path, '# 总标题 > ## 安装 > ### 配置', '### 必须嵌在 ## 之下形成完整路径')
  assert.equal(chunks[4].heading_path, '# 总标题 > ## 使用', '同级 ## 必须弹出 ### 层级，不得残留')
  assert.deepEqual(chunks.map(c => c.chunk_index), [0, 1, 2, 3, 4], 'chunk_index 必须按文档顺序从 0 递增')
})

test('chunkEntryMd：代码围栏内的 # 不切块（WHY：md 正文常见代码注释，误切会撕裂块语义）', () => {
  const chunks = chunkEntryMd([
    '# 标题',
    '',
    '```bash',
    '# 这不是标题是注释',
    'npm i',
    '```',
    '',
    '## 小节',
    '',
    '内容'
  ].join('\n'))
  assert.equal(chunks.length, 2, '围栏内的 # 行不得产生新块')
  assert.ok(chunks[0].content.includes('# 这不是标题是注释'), '围栏内容必须完整保留在所属块内')
  assert.equal(chunks[1].heading_path, '# 标题 > ## 小节')
})

test('降级：嵌入未配置时 ensureChunksIndexed 不抛错且 reason 可查（WHY：本地优先不绑厂商，向量路必须可缺席）', async () => {
  await seedWikiEntry({ title: '降级样例', md: '# 降级样例\n\n内容\n' })
  const db = await getDb()
  // 默认 ai.embedding.enabled=false（seedDefaults 初始态），未注入 embedFn 时应直接短路
  const status = await ensureChunksIndexed(db)
  assert.equal(status.reason, 'embedding_not_configured')
  assert.equal(status.vectorEnabled, true)
  assert.equal(status.indexed, 0)
  assert.equal(status.failed, 0, '降级不是失败，不得计入 failed')

  await setConfig('search.vectorEnabled', 'false')
  const off = await ensureChunksIndexed(db)
  assert.equal(off.reason, 'vector_disabled', '总开关关闭必须优先生效')
  assert.equal(off.vectorEnabled, false)
  await setConfig('search.vectorEnabled', 'true')
})

test('ensureChunksIndexed 幂等：二次调用零嵌入调用（WHY：回填入口会被反复触发，重复嵌入是纯浪费）', async () => {
  const idA = await seedWikiEntry({ title: '分块甲', md: '# 分块甲\n\n甲的正文\n\n## 甲小节\n\n甲小节正文\n' })
  const idB = await seedWikiEntry({ title: '分块乙', md: '# 分块乙\n\n乙的正文\n' })
  const db = await getDb()
  await setConfig('ai.embedding', JSON.stringify({ enabled: true, provider: 'fake', model: 'fake-embed-v1' }))

  const calls: string[] = []
  const fakeEmbed = async (text: string) => {
    calls.push(text)
    // 按内容给不同方向向量，供 searchVector 用例区分语义
    return text.includes('甲小节') ? [0, 1] : [1, 0]
  }
  const first = await ensureChunksIndexed(db, { embedFn: fakeEmbed })
  assert.equal(first.reason, 'ok')
  assert.equal(first.indexed, first.total, '所有无块条目都应成功索引（用例间共享库，用相对断言避免串扰）')
  assert.equal(first.failed, 0)
  assert.ok(first.total >= 2, '至少覆盖本用例种下的两个条目')
  const firstCallCount = calls.length
  assert.ok(firstCallCount >= 3, '两个条目共 3 块，至少产生 3 次嵌入调用')

  const chunkRows = await (await db.prepare(
    'SELECT entry_id, chunk_index, heading_path FROM entry_chunks WHERE entry_id IN (?, ?) ORDER BY entry_id, chunk_index'
  )).all([idA, idB]) as any[]
  assert.equal(chunkRows.length, 3, '条目甲 2 块 + 条目乙 1 块')
  assert.deepEqual(chunkRows.filter(r => Number(r.entry_id) === idA).map(r => Number(r.chunk_index)), [0, 1], '块序号按文档顺序')
  assert.equal(chunkRows.find(r => Number(r.entry_id) === idA && Number(r.chunk_index) === 1)?.heading_path, '# 分块甲 > ## 甲小节')

  const second = await ensureChunksIndexed(db, { embedFn: fakeEmbed })
  assert.equal(second.total, 0, '已有块的条目必须被跳过（pending 为空）')
  assert.equal(second.indexed, 0)
  assert.equal(calls.length, firstCallCount, '二次调用不得产生任何新的嵌入调用（幂等）')
})

test('searchVector：命中 child 块返回 parent 词条且按余弦分排序（WHY：parent-child 语义是本路检索的核心契约）', async () => {
  const db = await getDb()
  await setConfig('ai.embedding', JSON.stringify({ enabled: true, provider: 'fake', model: 'fake-embed-v1' }))
  await seedWikiEntry({ title: '向量目标词条', summary: 'summary 目标', md: '# 向量目标词条\n\n引言\n\n## 网络小节\n\n网络内容\n' })
  // 用三维向量隔离用例间数据：库里既有块是二维（cosine 维度不等返回 0 被过滤），只有本用例块参与排序
  await ensureChunksIndexed(db, { embedFn: async (text) => (text.includes('网络') ? [0, 0, 1] : [0, 1, 0]) })

  const hits = await searchVector(db, [0, 0, 1], 5)
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].title, '向量目标词条', '命中 child 块必须映射回 parent 词条')
  assert.equal(hits[0].heading_path, '# 向量目标词条 > ## 网络小节', '必须保留最高分块的标题路径')
  assert.ok(hits[0].score > 0.99, '同向向量余弦应接近 1')

  const empty = await searchVector(db, [0, 0, 0], 5)
  assert.deepEqual(empty, [], '零向量 query 必须返回空结果（cosine 零向量返回 0 被过滤）')
})

test('单条失败跳过不中断：坏文件条目 failed 计数，其余条目正常索引（WHY：局部损坏不能拖垮整体回填）', async () => {
  const db = await getDb()
  const badId = await seedWikiEntry({ title: '坏文件', md: '# 坏文件\n\n内容\n' })
  await (await db.prepare('UPDATE wiki_entries_meta SET entry_path = ? WHERE id = ?')).run(
    [path.join(DATA_TMP, 'wiki', 'entries', 'not-exist.md'), badId]
  )
  await seedWikiEntry({ title: '好文件', md: '# 好文件\n\n好内容\n' })
  await setConfig('ai.embedding', JSON.stringify({ enabled: true, provider: 'fake', model: 'fake-embed-v1' }))

  const status = await ensureChunksIndexed(db, { embedFn: async () => [1, 0] })
  assert.equal(status.failed, 1, 'entry.md 读取失败的条目必须计入 failed')
  assert.ok(status.indexed >= 1, '其余条目不得被单条失败中断')
  const badRows = await (await db.prepare('SELECT COUNT(*) AS n FROM entry_chunks WHERE entry_id = ?')).get(badId) as any
  assert.equal(Number(badRows?.n || 0), 0, '失败条目不得写入任何块')
})
