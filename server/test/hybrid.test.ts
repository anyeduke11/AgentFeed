import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// Phase 2 Wave 2 · hybridSearchWiki 三路融合检索的行为钉死测试。
// WHY：hybrid 是 MCP search_knowledge 的生产入口，融合排序 / 逃生舱等价 / 降级链 /
// rerank 开关 / 静态先验 / 过滤透传是本层核心契约——任何一路悄悄改变行为都必须在这里显眼地失败。
// 与 knowledge.test.ts 互补：那边钉 legacy 单路契约不漂移，这边钉混合层在它之上的行为。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 knowledge.test.ts 模式），绝不误伤生产库。
// 嵌入全 mock（opts.embedFn 注入，同 wikiChunks.test.ts 模式）；rerank 走全局 fetch 桩，零真实网络。
// 用例共用同一临时库：各用例 query 关键词互不相同，避免跨用例 FTS/LIKE 命中串扰；
// 孤儿词条（无关联 file）的身份断言一律用 entry_path（file 与 entry 是两张自增表，裸 id 可能数值撞车）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-hybrid-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { hybridSearchWiki } = await import('../src/search/hybrid.js')
const { legacySearchKnowledge } = await import('../src/knowledge.js')
const { syncWikiFts } = await import('../src/search/ftsIndex.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let seq = 0

async function seedFile(opts: { title?: string; mtime: string; domainId?: number }) {
  const db = await getDb()
  seq += 1
  const result = await (await db.prepare(
    'INSERT INTO files (path, name, ext, title, file_mtime, domain_id) VALUES (?, ?, ?, ?, ?, ?)'
  )).run([`/tmp/hybrid-seed-${seq}.md`, `hybrid-seed-${seq}.md`, '.md', opts.title ?? null, opts.mtime, opts.domainId ?? null])
  return Number(result.lastID)
}

async function seedDomain(name: string): Promise<number> {
  const db = await getDb()
  const result = await (await db.prepare('INSERT INTO domains (name) VALUES (?)')).run([name])
  return Number(result.lastID)
}

/** 种一个 wiki 词条：entry.md 落临时目录 + wiki_entries_meta（fileId 传 null = 孤儿词条），走生产同款 syncWikiFts 建 FTS 索引 */
async function seedEntry(opts: { fileId: number | null; title: string; md: string }): Promise<{ id: number; entryPath: string }> {
  const db = await getDb()
  seq += 1
  const entryPath = path.join(DATA_TMP, 'wiki', 'entries', `hybrid-${seq}.md`)
  await fs.mkdir(path.dirname(entryPath), { recursive: true })
  await fs.writeFile(entryPath, opts.md, 'utf8')
  const r = await (await db.prepare(
    'INSERT INTO wiki_entries_meta (file_id, entry_path, title) VALUES (?, ?, ?)'
  )).run([opts.fileId, entryPath, opts.title])
  const id = Number(r.lastID)
  await syncWikiFts(db, id)
  return { id, entryPath }
}

async function setConfig(key: string, value: string) {
  const db = await getDb()
  await (await db.prepare(
    `INSERT INTO config (key, value, type) VALUES (?, ?, 'string')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  )).run([key, value])
}

async function delConfig(key: string) {
  const db = await getDb()
  await (await db.prepare('DELETE FROM config WHERE key = ?')).run([key])
}

/** 替换全局 fetch 为桩（callExternalRerank 直接消费全局 fetch），由调用方 restore 防泄漏到后续用例 */
function stubFetch(impl: (url: string, init: any) => Promise<any>): {
  calls: Array<{ url: string; init: any }>
  restore: () => void
} {
  const calls: Array<{ url: string; init: any }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return impl(String(url), init)
  }) as any
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('RRF 融合：FTS+LIKE 双路命中者排最前（WHY：多路命中分数累加是混合检索存在的理由，单路序无法替代）', async () => {
  // f1 双路命中：LIKE 路 title 命中且 mtime 最新（该路 rank1）+ 词条挂接后 FTS 路命中；
  // f2 仅 LIKE 路、orphan 仅 FTS 路。f1 最少拿 1/(60+10) + 1/(60+30)，恒大于任一单路候选的最高分 1/61。
  const f1 = await seedFile({ title: '融合命中词甲', mtime: '2026-09-20T00:00:00.000Z' })
  const f2 = await seedFile({ title: '融合命中词乙', mtime: '2026-09-10T00:00:00.000Z' })
  await seedEntry({ fileId: f1, title: '融合命中词词条甲', md: '# 融合命中词词条甲\n\n融合命中词正文\n' })
  const orphan = await seedEntry({ fileId: null, title: '融合命中词词条乙', md: '# 融合命中词词条乙\n\n融合命中词正文\n' })
  const db = await getDb()

  const rows = await hybridSearchWiki(db, { query: '融合命中词', limit: 10 })
  assert.equal(Number(rows[0].id), f1, '双路命中的 f1 必须凭 RRF 分数累加排最前')
  assert.ok(rows.some(r => Number(r.id) === f2), '仅 LIKE 路命中的 f2 必须保留（融合只调序不淘汰单路候选）')
  assert.ok(rows.some(r => r.entry_path === orphan.entryPath), '仅 FTS 路命中的孤儿词条必须保留')
})

test('逃生舱等价性：hybridEnabled=false 时与 legacySearchKnowledge 逐字段 deep equal（WHY：旧行为等价是回滚安全的契约）', async () => {
  const g1 = await seedFile({ title: '逃生舱对照词', mtime: '2026-09-12T00:00:00.000Z' })
  await seedEntry({ fileId: g1, title: '逃生舱对照词条', md: '# 逃生舱对照词条\n\n逃生舱对照词正文\n' })
  const orphan = await seedEntry({ fileId: null, title: '逃生舱孤儿词条', md: '# 逃生舱孤儿词条\n\n逃生舱对照词正文\n' })
  const db = await getDb()
  const params = { query: '逃生舱对照词' }

  await setConfig('search.hybridEnabled', 'false')
  try {
    const legacyRows = await legacySearchKnowledge(db, params)
    assert.ok(legacyRows.every(r => Number(r.id) !== orphan.id), '对照组：legacy 本身不含孤儿词条（证明等价断言非恒真）')
    const hybridRows = await hybridSearchWiki(db, params)
    assert.deepEqual(hybridRows, legacyRows, '开关关闭时必须与旧单路完全一致（字段、顺序、内容零漂移）')
  } finally {
    await delConfig('search.hybridEnabled')
  }

  const hybridOn = await hybridSearchWiki(db, params)
  assert.deepEqual(
    hybridOn.map(r => Number(r.id)),
    [g1, orphan.id],
    '删掉开关后混合路恢复：g1 双路命中在前、孤儿词条回归（证明开关真实生效而非恒真通过）'
  )
})

test('嵌入不可用降级：embedFn 返回 null 不抛错，FTS+LIKE 两路结果完整（WHY：向量路缺席不能拖垮检索主链路）', async () => {
  const f3 = await seedFile({ title: '降级可用词文件', mtime: '2026-09-18T00:00:00.000Z' })
  await seedEntry({ fileId: f3, title: '降级可用词条', md: '# 降级可用词条\n\n降级可用词正文\n' })
  const orphan = await seedEntry({ fileId: null, title: '降级可用孤儿', md: '# 降级可用孤儿\n\n降级可用词正文\n' })
  const db = await getDb()

  // 注入返回 null 的 embedFn 模拟嵌入能力缺席；调用计数证明降级发生在「查询向量拿不到」之后
  const embedCalls: string[] = []
  const embedFn = async (text: string) => { embedCalls.push(text); return null as unknown as number[] }
  const rows = await hybridSearchWiki(db, { query: '降级可用词' }, { embedFn })

  assert.ok(Array.isArray(rows), '嵌入缺席必须正常返回数组而非抛错')
  assert.equal(embedCalls.length, 1, '注入的 embedFn 应被向量路调用恰好一次')
  assert.ok(rows.some(r => Number(r.id) === f3), 'LIKE+FTS 双路命中的 f3 必须保留')
  assert.ok(rows.some(r => r.entry_path === orphan.entryPath), '仅 FTS 路命中的孤儿词条必须保留（向量路缺席不殃及其余两路）')
})

test('rerank 三态：未配置=纯 RRF / 请求失败=降级不抛错 / 成功=按 rerank 分排序且缺席者沉底（WHY：rerank 可信但不能丢结果）', async () => {
  // 本组数据仅 files（无词条）：FTS/向量两路天然缺席，RRF 基线序 = LIKE 路的 mtime 降序，完全确定
  const r1 = await seedFile({ title: '重排排序词壹', mtime: '2026-09-21T00:00:00.000Z' })
  const r2 = await seedFile({ title: '重排排序词贰', mtime: '2026-09-15T00:00:00.000Z' })
  const r3 = await seedFile({ title: '重排排序词叁', mtime: '2026-09-01T00:00:00.000Z' })
  const db = await getDb()
  const params = { query: '重排排序词' }

  // ① endpoint 未配置：纯 RRF（默认行为，零外部依赖）
  await delConfig('search.rerankEndpoint')
  const pure = await hybridSearchWiki(db, params)
  assert.deepEqual(pure.map(r => Number(r.id)), [r1, r2, r3], '未配置 endpoint 时必须保持 RRF 基线序')

  await setConfig('search.rerankEndpoint', 'http://rerank.invalid/hybrid-test')
  try {
    // ②a 请求异常（连接失败语义）：降级回 RRF 序，绝不抛错
    const fail = stubFetch(async () => { throw new Error('mock_network_down') })
    try {
      const rows = await hybridSearchWiki(db, params)
      assert.deepEqual(rows.map(r => Number(r.id)), [r1, r2, r3], 'rerank 请求失败必须降级回 RRF 序且不抛错')
      assert.equal(fail.calls.length, 1, '配置了 endpoint 就必须真实发起请求（证明降级发生在失败之后而非旁路）')
    } finally { fail.restore() }

    // ②b 非 200 响应同样降级
    const bad = stubFetch(async () => ({ ok: false, status: 500 }))
    try {
      const rows = await hybridSearchWiki(db, params)
      assert.deepEqual(rows.map(r => Number(r.id)), [r1, r2, r3], '非 200 响应必须降级回 RRF 序')
    } finally { bad.restore() }

    // ③ 正常响应：rerank 分接管排序；响应缺席的 r2 记 0 沉底（最旧的 r3 凭高分登顶但不丢 r2）
    const ok = stubFetch(async () => ({
      ok: true,
      json: async () => ({ results: [ { id: `f:${r3}`, score: 10 }, { id: `f:${r1}`, score: 1 } ] })
    }))
    try {
      const rows = await hybridSearchWiki(db, params)
      assert.deepEqual(rows.map(r => Number(r.id)), [r3, r1, r2], 'rerank 分必须接管排序，响应缺席的候选记 0 沉底而非丢失')
      const body = JSON.parse(ok.calls[0].init.body)
      assert.equal(body.query, '重排排序词', 'rerank 请求必须携带原 query')
      assert.deepEqual(
        new Set(body.candidates.map((c: any) => c.id)),
        new Set([`f:${r1}`, `f:${r2}`, `f:${r3}`]),
        'rerank 请求必须携带全部候选（以合并键 f:<id> 与响应对齐）'
      )
    } finally { ok.restore() }
  } finally {
    await delConfig('search.rerankEndpoint')
  }
})

test('静态先验：RRF 位次持平时 quality_score 更高者在前（WHY：「同等相关时质量优先」是先验的业务表达）', async () => {
  // 精心构造严格平局：甲仅 LIKE 路 rank1 = 1/61；乙的关联词条仅 FTS 路 rank1 = 1/61。
  // 甲 mtime 更新——若先验失效，mtime 次级键会让甲排前，用例必须失败（有牙齿）。
  const pa = await seedFile({ title: '先验同分词甲', mtime: '2026-09-20T00:00:00.000Z' })
  const pb = await seedFile({ title: '先验无关标题', mtime: '2026-09-06T00:00:00.000Z' })
  const pbe = await seedEntry({ fileId: pb, title: '先验同分词乙', md: '# 先验同分词乙\n\n先验同分词正文\n' })
  const db = await getDb()
  await (await db.prepare('UPDATE wiki_entries_meta SET quality_score = ? WHERE id = ?')).run([8, pbe.id])

  const rows = await hybridSearchWiki(db, { query: '先验同分词' })
  assert.deepEqual(
    rows.map(r => Number(r.id)),
    [pb, pa],
    '乙（关联词条 quality_score=8，先验 24/40）必须凭先验压过甲（无词条先验为 0）'
  )
})

test('过滤透传：domain / since / until 与 legacy 同库对照一致，孤儿词条 fail-closed 排除（WHY：MCP 调用方零感知契约）', async () => {
  const domainId = await seedDomain('透传域')
  const fd = await seedFile({ title: '透传样例正文', mtime: '2026-09-10T00:00:00.000Z', domainId })
  await seedEntry({ fileId: fd, title: '透传样例词条', md: '# 透传样例词条\n\n透传样例正文\n' })
  const fu = await seedFile({ title: '透传样例正文', mtime: '2026-09-01T00:00:00.000Z' })
  const orphan = await seedEntry({ fileId: null, title: '透传样例孤儿', md: '# 透传样例孤儿\n\n透传样例正文\n' })
  const db = await getDb()
  const params = { query: '透传样例' }

  // 无过滤基线：三路候选齐全（证明后续断言有牙齿——候选确实存在，是被过滤掉的）
  const unfiltered = await hybridSearchWiki(db, params)
  assert.ok(unfiltered.some(r => r.entry_path === orphan.entryPath), '无过滤时仅 FTS 路的孤儿词条必须在场')

  const hDomain = await hybridSearchWiki(db, { ...params, domain: '透传域' })
  assert.deepEqual(hDomain.map(r => Number(r.id)), [fd], 'domain 过滤必须只保留归属域的 fd，孤儿词条（无归属域）被排除')
  assert.deepEqual(hDomain, await legacySearchKnowledge(db, { ...params, domain: '透传域' }), 'domain 过滤下 hybrid 输出与 legacy 完全一致')

  const hSince = await hybridSearchWiki(db, { ...params, since: '2026-09-05T00:00:00.000Z' })
  assert.deepEqual(hSince.map(r => Number(r.id)), [fd], 'since 过滤必须排除窗口外的 fu 与无法证明在窗内的孤儿词条')
  assert.deepEqual(hSince, await legacySearchKnowledge(db, { ...params, since: '2026-09-05T00:00:00.000Z' }), 'since 过滤下 hybrid 输出与 legacy 完全一致')

  const hUntil = await hybridSearchWiki(db, { ...params, until: '2026-09-05T00:00:00.000Z' })
  assert.deepEqual(hUntil.map(r => Number(r.id)), [fu], 'until 过滤必须只保留窗口内的 fu')
  assert.deepEqual(hUntil, await legacySearchKnowledge(db, { ...params, until: '2026-09-05T00:00:00.000Z' }), 'until 过滤下 hybrid 输出与 legacy 完全一致')
})

test('任意乱码 query 不抛错（WHY：检索是只读旁路，FTS 特殊字符与空串都不能成为崩溃源）', async () => {
  const db = await getDb()
  const garbage = [
    '"quot^ OR (1=1) -- NEAR(( AND',
    '',
    '   ',
    '%_\\',
    '🚀💥'
  ]
  for (const q of garbage) {
    const rows = await hybridSearchWiki(db, { query: q })
    assert.ok(Array.isArray(rows), `乱码 query「${q}」必须返回数组而非抛错`)
  }
})
