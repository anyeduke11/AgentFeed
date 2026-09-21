import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// J3 机读画像双出口契约测试：B 出口 = MCP 第 9 工具 get_user_context（src/mcpTools.ts）；
// C 出口 = AGENTS.md/CLAUDE.md 托管区块同步器（src/profile/syncBlock.ts）。
// WHY 钉死四类事故：
// ① vetoed 断言泄漏到任一出口（用户否决形同虚设）→ 两出口都只经 projectProfile，用断言独特词反向断言；
// ② 未授权写入（授权清单外/无标记文件被强行重建）→ 同步器只写 syncTargets 清单内路径，
//    无标记文件返回 missing-marker 且一个字节不动（用户手删授权应停）；
// ③ 幂等失守（重复 sync 污染手写内容或反复改写区块）→ 区块外切片字节级比对 + 同画像同日两次全文件字节相等；
// ④ agent 拿到空画像不知所以（蒸馏未跑）→ 可读提示引导看板手动触发，不静默空文本。
// 隔离：AGENTFEED_DATA_DIR 临时库（同 profileDistill.test.ts）；同步目标文件用临时目录真实落盘。
// 测试顺序即依赖顺序（node:test 文件内串行）：「无画像提示」必须先于任何 seedProfile。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-profile-sync-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { getUserContextHandler } = await import('../src/mcpTools.js')
const {
  BLOCK_START, BLOCK_END, renderManagedBlock, syncProfileToFile, syncAuthorizedProjects, CONFIG_SYNC_TARGETS
} = await import('../src/profile/syncBlock.js')
const { CONFIG_ENABLED } = await import('../src/profile/distill.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

let profileSeq = 0
/** 种一版 active 画像（generated_at 加序号防 UNIQUE(scope, domain_id, generated_at) 撞毫秒） */
async function seedProfile(scope: 'global' | 'domain', domainId: number | null, content: unknown): Promise<number> {
  const db = await getDb()
  profileSeq += 1
  const r = await (await db.prepare(
    `INSERT INTO user_profile (scope, domain_id, content, evidence, confidence, generated_at, active)
     VALUES (?, ?, ?, '[]', NULL, ?, 1)`
  )).run([scope, domainId, JSON.stringify(content), new Date(Date.now() + profileSeq).toISOString()])
  return Number(r.lastID)
}

// ---------- B 出口：get_user_context ----------

test('B·蒸馏未跑：无任何画像返回可读提示（不得静默空文本）', async () => {
  const res = await getUserContextHandler({})
  const text = res.content[0]?.text ?? ''
  assert.ok(text.includes('画像尚未生成'), '必须告知画像未生成')
  assert.ok(text.includes('Settings'), '提示必须指向看板手动入口')
})

test('B·vetoed 永不出口：active 断言与置信/证据数在，否决断言独特词绝不出现在文本', async () => {
  await seedProfile('global', null, {
    schema_version: '1', role_pattern: '全栈实操工程师',
    claims: [
      { claim: '甲-动手偏好型读者', status: 'active', evidence: ['read_history:1'], confidence: 0.9 },
      { claim: '乙-纯理论学院派毒词', status: 'vetoed', evidence: ['read_history:2'], confidence: 0.8 }
    ]
  })
  const res = await getUserContextHandler({})
  const text = res.content[0]?.text ?? ''
  assert.ok(text.includes('全栈实操工程师'), 'role_pattern 必须出口')
  assert.ok(text.includes('甲-动手偏好型读者'), 'active 断言必须出口')
  assert.ok(text.includes('置信 0.9'), '置信度必须随断言出口')
  assert.ok(text.includes('证据 1 条'), '证据数必须随断言出口')
  assert.ok(!text.includes('毒词'), 'vetoed 断言的独特词绝不能出现（只能经 projectProfile 投影）')
})

test('B·domain 参数：命中域附域断言；域名不存在只提示该域部分，不拖垮全局画像出口', async () => {
  const db = await getDb()
  const dId = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('psync-画像域')`)).run()).lastID)
  await seedProfile('domain', dId, {
    schema_version: '1', role_pattern: '',
    claims: [{ claim: '丙-域内倾向断言', status: 'active', evidence: ['read_history:3'], confidence: 0.7 }]
  })
  const hit = await getUserContextHandler({ domain: 'psync-画像域' })
  const hitText = hit.content[0]?.text ?? ''
  assert.ok(hitText.includes('psync-画像域'), '域段必须带域名')
  assert.ok(hitText.includes('丙-域内倾向断言'), '域断言必须出口')
  assert.ok(hitText.includes('甲-动手偏好型读者'), '全局断言与域断言并存')

  const miss = await getUserContextHandler({ domain: '不存在域xyz' })
  const missText = miss.content[0]?.text ?? ''
  assert.ok(missText.includes('不存在'), '域名不存在必须给该域提示而非整体报错')
  assert.ok(missText.includes('甲-动手偏好型读者'), '该域失败不得拖垮全局画像出口')
})

test('B·token 预算：小预算下整行截断并附提示（放不下的断言整行丢弃，不撕半行）', async () => {
  const db = await getDb()
  const longClaims = Array.from({ length: 6 }, (_, i) => ({
    claim: `长断言${i}-${'很'.repeat(30)}`, status: 'active', evidence: ['read_history:9'], confidence: 0.6
  }))
  await seedProfile('global', null, { schema_version: '1', role_pattern: '预算截断角色', claims: longClaims })
  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)'))
    .run(['getUserContext.tokenBudget', '40', 'number'])
  const res = await getUserContextHandler({})
  const text = res.content[0]?.text ?? ''
  assert.ok(text.includes('已按 token 预算截断'), '超预算必须附截断提示')
  assert.ok(!text.includes('长断言5'), '放不下的断言整行丢弃')
})

// ---------- C 出口：托管区块同步器 ----------

const SYNC_DATE = '2026-09-21'

test('C·renderManagedBlock 纯函数：替换既有区块（区块外前后文原样）；无区块末尾追加（前空一行）', () => {
  const replaced = renderManagedBlock(`前文\n${BLOCK_START}\n旧\n${BLOCK_END}\n后文\n`, '新正文')
  assert.equal(replaced, `前文\n${BLOCK_START}\n新正文\n${BLOCK_END}\n后文\n`)
  const appended = renderManagedBlock('只有手写', '新正文')
  assert.equal(appended, `只有手写\n\n${BLOCK_START}\n新正文\n${BLOCK_END}\n`)
})

test('C·幂等核心：连续 sync 两次，区块外手写字节不变；区块含断言与版本行；同日两次全文件字节相等；E2 指引行共存', async () => {
  const dir = await fs.mkdtemp(path.join(DATA_TMP, 'targets-'))
  const file = path.join(dir, 'AGENTS.md')
  const manual = '# 项目守则\n开工先调 getContext(领域名) 获取领域地图\n'
  await fs.writeFile(file, `${manual}${BLOCK_START}\n旧区块占位\n${BLOCK_END}\n`, 'utf8')

  const versionId = await seedProfile('global', null, {
    schema_version: '1', role_pattern: '全栈实操工程师',
    claims: [
      { claim: '甲-动手偏好型读者', status: 'active', evidence: ['read_history:1'], confidence: 0.9 },
      { claim: '乙-纯理论学院派毒词', status: 'vetoed', evidence: ['read_history:2'], confidence: 0.8 }
    ]
  })

  assert.equal(await syncProfileToFile(versionId, file, { syncedAt: SYNC_DATE }), 'updated')
  const after1 = await fs.readFile(file, 'utf8')
  assert.equal(after1.slice(0, after1.indexOf(BLOCK_START)), manual, '区块外（前段）手写内容字节不变')
  assert.ok(after1.includes('开工先调 getContext'), 'E2 指引行必须原样保留（与托管区块共存）')
  assert.ok(after1.includes('角色画像：全栈实操工程师'), '区块内含 role_pattern')
  assert.ok(after1.includes('- 甲-动手偏好型读者（置信 0.9）'), '区块内含生效断言行')
  assert.ok(!after1.includes('毒词'), 'vetoed 断言绝不写入托管区块')
  assert.ok(after1.includes(`> profile version: ${versionId} synced: ${SYNC_DATE}`), '版本行必须带版本号与同步日期')

  assert.equal(await syncProfileToFile(versionId, file, { syncedAt: SYNC_DATE }), 'updated')
  const after2 = await fs.readFile(file, 'utf8')
  assert.equal(after2, after1, '同画像同日重复 sync：全文件字节级不变（幂等）')
})

test('C·保守跳过：无标记文件返回 missing-marker 且字节不变；文件不存在返回 noop', async () => {
  const dir = await fs.mkdtemp(path.join(DATA_TMP, 'targets-'))
  const plain = path.join(dir, 'CLAUDE.md')
  const raw = '# 纯手写文件\n没有托管区块\n'
  await fs.writeFile(plain, raw, 'utf8')
  const versionId = await seedProfile('global', null, { schema_version: '1', role_pattern: 'r', claims: [] })
  assert.equal(await syncProfileToFile(versionId, plain), 'missing-marker', '无标记 = 用户可能手删授权，应停不应重建')
  assert.equal(await fs.readFile(plain, 'utf8'), raw, '无标记文件一个字节都不能动')
  assert.equal(await syncProfileToFile(versionId, path.join(dir, '不存在.md')), 'noop')
})

test('C·授权清单：未配置 syncTargets 返回 []；配置后逐文件同步；全局开关关闭返回 []', async () => {
  const db = await getDb()
  assert.deepEqual(await syncAuthorizedProjects(), [], 'syncTargets 未配置必须返回空（零授权零写入）')

  const dir = await fs.mkdtemp(path.join(DATA_TMP, 'targets-'))
  const file = path.join(dir, 'AGENTS.md')
  await fs.writeFile(file, `# 手写\n${BLOCK_START}\n旧\n${BLOCK_END}\n`, 'utf8')
  // 现种一版带断言的全局画像（id 最大即当前生效）——同步目标必须是「当前生效画像」
  const versionId = await seedProfile('global', null, {
    schema_version: '1', role_pattern: '清单同步角色',
    claims: [{ claim: '丁-清单同步断言', status: 'active', evidence: ['read_history:4'], confidence: 0.8 }]
  })
  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)'))
    .run([CONFIG_SYNC_TARGETS, JSON.stringify([file]), 'json'])

  const results = await syncAuthorizedProjects()
  assert.equal(results.length, 1)
  assert.equal(results[0]?.result, 'updated')
  const synced = await fs.readFile(file, 'utf8')
  assert.ok(synced.includes('丁-清单同步断言'), '授权文件被同步到当前生效画像')
  assert.ok(synced.includes(`> profile version: ${versionId} synced:`), '版本行必须是当前生效版本号')

  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)'))
    .run([CONFIG_ENABLED, 'false', 'boolean'])
  assert.deepEqual(await syncAuthorizedProjects(), [], '全局开关关闭必须返回空')
  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)'))
    .run([CONFIG_ENABLED, 'true', 'boolean'])
})
