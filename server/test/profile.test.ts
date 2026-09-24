import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// J1 用户画像·断言模型 + 聚合统计包（profile/model.ts + profile/aggregate.ts）契约测试。
// WHY：user_profile.content 是 J2 维护页与 J3 双出口（get_user_context / AGENTS.md 托管区块）的
// 唯一事实载体——校验拒收、预算淘汰、出口投影、用户三操作（veto/add/revert）任何一处失守，
// 就是「否决了还在外发」「用户补充被 AI 淘汰」「画像漂移无人工纠错」三类事故。
// 聚合层钉住：纯本地统计的口径（域归并/标签三态加权/窗口），以及隐私边界——
// bundle 里只有统计数字与标签权重，绝不携带任何原始信号内容（G2 披露口径依赖此事实）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 chunkBackfill.test.ts 模式）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-profile-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const {
  parseProfileContent, serializeProfileContent, enforceClaimBudget, projectProfile,
  vetoClaim, addUserClaim, revertProfileVersion, getActiveProfile,
  CLAIM_BUDGET_GLOBAL, CLAIM_BUDGET_DOMAIN, MIN_DOMAIN_SIGNALS
} = await import('../src/profile/model.js')
const { buildProfileSignalBundle, DEFAULT_WINDOW_DAYS } = await import('../src/profile/aggregate.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function claim(i: number, status: 'active' | 'user_added' | 'vetoed' = 'active', evidence: string[] = ['read_history:1']): any {
  return { claim: `断言${i}`, status, evidence, confidence: 0.8 }
}

test('parseProfileContent：合法包往返一致；schema/状态/证据指针/置信度任一非法整包拒收', () => {
  const ok: any = { schema_version: '1', role_pattern: '全栈+AI 工程', claims: [claim(1), claim(2, 'user_added', []), claim(3, 'vetoed', ['chat_messages:45'])] }
  const parsed = parseProfileContent(serializeProfileContent(ok))
  assert.deepEqual(parsed, ok)
  assert.equal(parseProfileContent('not json'), null)
  assert.equal(parseProfileContent(JSON.stringify({ schema_version: '2', role_pattern: '', claims: [] })), null, 'schema_version 升级即拒收')
  assert.equal(parseProfileContent(JSON.stringify({ schema_version: '1', role_pattern: 1, claims: [] })), null)
  assert.equal(parseProfileContent(JSON.stringify({ schema_version: '1', role_pattern: '', claims: [{ ...claim(1), status: 'draft' }] })), null, '非法状态拒收')
  assert.equal(parseProfileContent(JSON.stringify({ schema_version: '1', role_pattern: '', claims: [{ ...claim(1), evidence: ['read_history:abc'] }] })), null, '证据指针格式拒收')
  assert.equal(parseProfileContent(JSON.stringify({ schema_version: '1', role_pattern: '', claims: [{ ...claim(1), confidence: 1.5 }] })), null, '置信度越界拒收')
})

test('enforceClaimBudget：超预算淘汰 evidence 少者优先；user_added 永不淘汰；vetoed 不占预算', () => {
  const claims: any[] = [
    claim(1, 'user_added', []),
    claim(2, 'active', ['read_history:1', 'read_history:2']),   // evidence 2 条，最厚
    claim(3, 'active', ['read_history:3']),                      // evidence 1 条，最薄
    claim(4, 'vetoed', ['read_history:4'])
  ]
  // domain 预算 10：active 仅 2 条不超
  const under = enforceClaimBudget({ schema_version: '1', role_pattern: '', claims }, 'domain')
  assert.equal(under.evicted.length, 0)
  // 构造超预算：active 断言塞到 domain 预算 +1（vetoed 不占、user_added 不算 active）
  const many: any[] = [claim(1, 'user_added', []), claim(4, 'vetoed', ['read_history:4'])]
  for (let i = 0; i < CLAIM_BUDGET_DOMAIN + 1; i++) many.push(claim(100 + i, 'active', [`read_history:${100 + i}`]))
  // 第 0 条 active 造最薄（0 证据）：必然被淘汰
  many[2].evidence = []
  const over = enforceClaimBudget({ schema_version: '1', role_pattern: '', claims: many }, 'domain')
  assert.equal(over.content.claims.filter(c => c.status === 'active').length, CLAIM_BUDGET_DOMAIN)
  assert.ok(over.evicted.includes('断言100'), '最薄证据的 active 优先淘汰')
  assert.ok(over.content.claims.some(c => c.claim === '断言1' && c.status === 'user_added'), 'user_added 永不淘汰')
  assert.ok(over.content.claims.some(c => c.status === 'vetoed'), 'vetoed 保留作负例对照')
  // global 预算独立验证（20 上限存在即可，不再全量构造）
  assert.equal(CLAIM_BUDGET_GLOBAL, 20)
})

test('projectProfile：vetoed 永不出口；active 与 user_added 并存', () => {
  const content = { schema_version: '1' as const, role_pattern: '重实操', claims: [claim(1), claim(2, 'user_added', []), claim(3, 'vetoed')] }
  const p = projectProfile(content)
  assert.deepEqual(p.claims.map(c => c.claim), ['断言1', '断言2'])
  assert.equal(p.role_pattern, '重实操')
})

test('用户三操作：veto 即刻生效 / add 无活跃版可自建 / revert 指针切换', async () => {
  const db = await getDb()
  // 无活跃版本时 addUserClaim 自建首版（用户不必等 AI 先开口）
  const v1 = await addUserClaim('global', null, '用户自述：偏好渐进式引导')
  assert.ok(v1)
  let active = await getActiveProfile(db, 'global', null)
  assert.ok(active)
  assert.deepEqual(projectProfile(active.content).claims.map(c => c.claim), ['用户自述：偏好渐进式引导'])
  assert.equal(active.content.claims[0].status, 'user_added')

  // 蒸馏产出新版（active 2 互斥）
  const distilled = serializeProfileContent({ schema_version: '1', role_pattern: '新版画像', claims: [claim(1), claim(2, 'user_added', [])] })
  await (await db.prepare('UPDATE user_profile SET active = 0 WHERE scope = ?')).run(['global'])
  const r = await (await db.prepare('INSERT INTO user_profile (scope, domain_id, content, evidence, confidence, generated_at, active) VALUES (?, NULL, ?, ?, ?, ?, 1)')).run(['global', distilled, '["read_history:9"]', 0.7, new Date().toISOString()])
  const v2 = Number(r.lastID)
  active = await getActiveProfile(db, 'global', null)
  assert.equal(active!.id, v2)

  // veto：断言2（user_added）也可被否决（用户改变主意）——vetoed 即刻从出口消失
  assert.equal(await vetoClaim(v2, '断言1'), true)
  active = await getActiveProfile(db, 'global', null)
  assert.deepEqual(projectProfile(active!.content).claims.map(c => c.claim), ['断言2'])
  assert.equal(await vetoClaim(v2, '不存在的断言'), false)
  // 坏 JSON 版本拒操作（fail loud 返回 false，不炸）
  await db.exec(`UPDATE user_profile SET content = '{bad' WHERE id = ${v2}`)
  assert.equal(await vetoClaim(v2, '断言2'), false)

  // revert：回滚到 v1（仅含用户自述）
  assert.equal(await revertProfileVersion(v1), true)
  active = await getActiveProfile(db, 'global', null)
  assert.equal(active!.id, v1)
  const cnt = await (await db.prepare('SELECT COUNT(*) AS n FROM user_profile WHERE active = 1 AND scope = ?')).get(['global']) as any
  assert.equal(Number(cnt.n), 1, '同 scope 同 domain 只允许一个 active（版本互斥）')
})

test('聚合统计包：域归并/标签三态加权/评分均值/置信度门槛；bundle 不携带任何原始内容', async () => {
  const db = await getDb()
  const dRag = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('pf-RAG')`)).run()).lastID)
  const dFe = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('pf-前端')`)).run()).lastID)
  // 种文件 + 标签（primary 加权 1.0 / normal 0.3）+ 读取（RAG 5 次 + 评分，前端 1 次——低信号域）
  const mk = async (dom: number, name: string) => Number((await (await db.prepare(
    `INSERT INTO files (path, name, ext, title, domain_id) VALUES (?, ?, 'md', ?, ?)`
  )).run([`/pf/${name}.md`, name, name, dom])).lastID)
  const tPri = Number((await (await db.prepare(`INSERT INTO tags (name, level, status, domain_id) VALUES ('pf-hybrid-search', 'primary', 'active', ?)`)).run([dRag])).lastID)
  const tNorm = Number((await (await db.prepare(`INSERT INTO tags (name, level, status) VALUES ('pf-随手记', 'normal', 'active')`)).run()).lastID)
  const f1 = await mk(dRag, 'rag1'), f2 = await mk(dRag, 'rag2'), f3 = await mk(dFe, 'fe1')
  for (const [fid, tag] of [[f1, tPri], [f1, tNorm]] as const) {
    await (await db.prepare(`INSERT INTO file_tags (file_id, tag_id, source) VALUES (?, ?, 'rule')`)).run([fid, tag])
  }
  const open = async (fid: number, rating: number | null) => {
    await (await db.prepare(`INSERT INTO read_history (file_id, path, source, rating) VALUES (?, ?, 'reader', ?)`)).run([fid, `/pf/${fid}.md`, rating])
  }
  for (let i = 0; i < 4; i++) await open(f1, i < 2 ? 5 : 4)   // RAG 5 次含 f2 一次
  await open(f2, null)
  await open(f3, null)                                        // 前端 1 次：低信号

  const bundle = await buildProfileSignalBundle(db)
  const rag = bundle.domains.find(d => d.domainName === 'pf-RAG')
  const fe = bundle.domains.find(d => d.domainName === 'pf-前端')
  assert.ok(rag && fe)
  assert.equal(rag.reads, 5)
  assert.equal(rag.avgRating, 4.5)                            // (5+5+4+4+null→按 SQL AVG 4.5)
  assert.equal(rag.signalsCount, 5)
  assert.equal(rag.meetsThreshold, true)
  assert.equal(fe.signalsCount, 1)
  assert.equal(fe.meetsThreshold, false, '低信号域不得满足置信度门槛（防早期瞎猜）')
  // 标签三态加权：标签按「挂靠文件被读次数 × 三态权重」计——f1（挂 primary+normal）被读 4 次
  assert.deepEqual(rag.topTags[0], { name: 'pf-hybrid-search', weight: 4 })
  assert.ok(rag.topTags.find(t => t.name === 'pf-随手记' && t.weight === 1.2))
  assert.equal(bundle.windowDays, DEFAULT_WINDOW_DAYS)
  // 隐私边界：bundle 序列化后不得出现任何文件路径/标题原文（只有统计与标签名）
  const raw = JSON.stringify(bundle)
  assert.ok(!raw.includes('/pf/'), 'bundle 不得携带文件路径')
  assert.ok(!raw.includes('rag1.md'), 'bundle 不得携带文件名')
})

test('聚合统计包：agent 消费与 exec_queue 完成率计入；窗口外信号不计', async () => {
  const db = await getDb()
  const d = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('pf-agent域')`)).run()).lastID)
  const f = Number((await (await db.prepare(
    `INSERT INTO files (path, name, ext, domain_id) VALUES ('/pf/ag.md', 'ag', 'md', ?)`
  )).run([d])).lastID)
  // 词条挂文件（agent 消费经 wiki_entries_meta.file_id 归域）
  const w = Number((await (await db.prepare(
    `INSERT INTO wiki_entries_meta (file_id, entry_path, title) VALUES (?, '/pf/wiki-ag.md', 'AG词条')`
  )).run([f])).lastID)
  // search_knowledge 的 args 只有 query 文本——无词条指针，不猜域归属（v1 保守）
  await (await db.prepare(`INSERT INTO mcp_call_logs (tool, created_at) VALUES ('search_knowledge', datetime('now'))`)).run()
  // 窗口内 read_entry：args.id 精确归域，计 1 次
  await (await db.prepare(`INSERT INTO mcp_call_logs (tool, args, created_at) VALUES ('read_entry', ?, datetime('now'))`)).run([JSON.stringify({ id: w })])
  await (await db.prepare(`INSERT INTO mcp_call_logs (tool, args, created_at) VALUES ('read_entry', ?, datetime('now', '-90 days'))`)).run([JSON.stringify({ id: w })])  // 窗口外
  await (await db.prepare(`INSERT INTO exec_queue (file_id, due_at, status) VALUES (?, datetime('now'), 'done')`)).run([f])
  await (await db.prepare(`INSERT INTO exec_queue (file_id, due_at, status) VALUES (?, datetime('now'), 'pending')`)).run([f])

  const bundle = await buildProfileSignalBundle(db, { windowDays: 30 })
  const ag = bundle.domains.find(x => x.domainName === 'pf-agent域')
  assert.ok(ag)
  assert.equal(ag.agentCalls, 1, '窗口外的 mcp 调用不计；search_knowledge 不猜域')
  assert.equal(ag.quizPassRate, 0.5)
  // 权重分档常量在案（改档位需同步 PRD J1 表述）
  assert.equal(MIN_DOMAIN_SIGNALS, 5)
})
