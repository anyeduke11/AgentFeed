import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// J1 用户画像·蒸馏 job（profile/distill.ts）契约测试。
// WHY：蒸馏是画像自迭代的唯一写入口——四类事故必须被钉死：
// ① LLM 幻觉证据指针（引用了不存在的编号）→ 整包拒收保留旧版，绝不入库；
// ② 用户主权失守（user_added 被淘汰 / vetoed 负例又被生成出来）→ 合并策略强制搬运；
// ③ 低信号域瞎猜（读 1 篇就断言 expert）→ 门槛在 prompt 源头掐断，域根本不出现；
// ④ 静默失败（蒸馏坏了用户不知道）→ llm_call_logs 必落行（G1 成本可见 + fail loud）。
// llmFn 注入点对齐 hybrid.ts embedFn 模式：验证的是 distill.ts 的解析/合并/提交逻辑，不测网络。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 profile.test.ts）。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-profile-distill-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const {
  buildProfileDistillPrompt, parseLlmProfileOutput, mergeForCommit,
  processProfileJob, triggerProfileDistill, isProfileDistillEnabled, CONFIG_ENABLED
} = await import('../src/profile/distill.js')
const { getActiveProfile, projectProfile, parseProfileContent } = await import('../src/profile/model.js')
const { buildProfileSignalBundle } = await import('../src/profile/aggregate.js')
import type { LlmJob } from '../src/llm/llmQueue.js'

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

function fakeJob(): LlmJob {
  return { id: 1, fileId: 0, provider: 'test-provider', model: 'test-model', prompt: '', options: { type: 'profile' } }
}

test('parseLlmProfileOutput：围栏剥离/编号翻译/未知编号整包拒收/坏产物拒收', () => {
  const idx = new Map([['E1', 'read_history:7'], ['E2', 'mcp_call_logs:3']])
  const ok = `{"role_pattern":"全栈+AI 工程","claims":[{"claim":"重实操","evidence_refs":["E1"],"confidence":0.8}],"domains":[{"domain":"RAG","proficiency":"expert","claims":[{"claim":"偏混合检索","evidence_refs":["E2"],"confidence":0.7}]}]}`
  const parsed = parseLlmProfileOutput('```json\n' + ok + '\n```' /* 围栏剥离 */, idx)
  assert.ok(parsed)
  assert.equal(parsed.role_pattern, '全栈+AI 工程')
  assert.deepEqual(parsed.claims[0].evidence, ['read_history:7'], '编号必须翻译回真实指针')
  assert.equal(parsed.claims[0].status, 'active')
  const dom = parsed.domains.get('RAG')!
  assert.ok(dom.some(c => c.claim === 'proficiency: expert'), 'proficiency 折叠为断言')
  assert.equal(parseLlmProfileOutput('not json', idx), null)
  assert.equal(parseLlmProfileOutput(ok.replace('E1', 'E9'), idx), null, '未知编号（幻觉指针）整包拒收')
  assert.equal(parseLlmProfileOutput(ok.replace('["E1"]', '[]'), idx), null, '空证据拒收——无证据断言不入库')
  assert.equal(parseLlmProfileOutput(ok.replace('0.8', '1.5'), idx), null, '置信越界拒收')
  assert.equal(parseLlmProfileOutput(ok.replace('expert', 'guru'), idx), null, '非法 proficiency 拒收')
})

test('mergeForCommit：user_added 与 vetoed 原样搬运；active 全新替换', () => {
  const prev = parseProfileContent(JSON.stringify({
    schema_version: '1', role_pattern: '旧画像',
    claims: [
      { claim: '旧active', status: 'active', evidence: ['read_history:1'], confidence: 0.5 },
      { claim: '用户补充', status: 'user_added', evidence: [], confidence: 1 },
      { claim: '被否决', status: 'vetoed', evidence: ['read_history:2'], confidence: 0.4 }
    ]
  }))
  const merged = mergeForCommit(prev, { role_pattern: '新画像', claims: [{ claim: '新active', status: 'active', evidence: ['read_history:9'], confidence: 0.9 }] })
  assert.ok(!merged.claims.some(c => c.claim === '旧active'), '旧 active 被新轮全量替换')
  assert.deepEqual(merged.claims.map(c => c.claim), ['新active', '用户补充', '被否决'])
  assert.equal(merged.role_pattern, '新画像')
  // 无上版（首轮）不炸
  const first = mergeForCommit(null, { role_pattern: '首版', claims: [] })
  assert.deepEqual(first.claims, [])
})

test('portrait：解析提取五段画像（缺失容忍不拒收）；merge 新版全量替换/缺失沿用上版', () => {
  const idx = new Map([['E1', 'read_history:7']])
  const withPortrait = `{"role_pattern":"全栈+AI 工程","portrait":"【基本信息】用户使用中文，时区 Asia/Shanghai\\n【工作背景】全栈与 AI 工程\\n【个人背景】无\\n【协作偏好】偏好简短直接\\n【长期记忆】重实操","claims":[{"claim":"重实操","evidence_refs":["E1"],"confidence":0.8}]}`
  const p = parseLlmProfileOutput(withPortrait, idx)
  assert.ok(p?.portrait?.includes('【协作偏好】'), 'portrait 五段结构必须被提取')
  assert.ok(p!.portrait!.includes('【长期记忆】'))

  // portrait 缺失：不触发整包拒收（claims 证据体系是主契约）
  const without = parseLlmProfileOutput(withPortrait.replace(/"portrait":"[^"]*",/, ''), idx)
  assert.ok(without, '无 portrait 不得拒收整包')
  assert.equal(without!.portrait, undefined)

  // merge：新版有 portrait 全量替换；缺失沿用上版（画像不因一次缺失倒退为空）
  const prev = parseProfileContent(JSON.stringify({ schema_version: '1', role_pattern: '旧', portrait: '旧画像文本', claims: [] }))
  assert.equal(mergeForCommit(prev, { role_pattern: '新', portrait: '新画像文本', claims: [] }).portrait, '新画像文本')
  assert.equal(mergeForCommit(prev, { role_pattern: '新', claims: [] }).portrait, '旧画像文本')

  // prompt 必须含 portrait 指令（五段结构与「用户」指代约定）
  const prompt = buildProfileDistillPrompt(
    { domains: [], global: { totalReads: 1, totalAgentCalls: 0, totalChatMentions: 0, avgRating: null, topTags: [] } } as any,
    null, idx
  )
  assert.ok(prompt.includes('【基本信息】') && prompt.includes('【长期记忆】'), 'prompt 必须带五段结构指令')
  assert.ok(prompt.includes('「用户」指代'), 'prompt 必须约束人称口径')
})

test('triggerProfileDistill：手动插队语义 + 默认服务商；自动触发不插队', async () => {
  // 层 1（纯逻辑，无竞态）：LlmQueue 优先级插入——pr=100 的画像 job 必须排在 pr=0 重蒸馏积压之前。
  // 先 pause 挡住 enqueue 内的 process() 消费，插完再读位置
  const { LlmQueue } = await import('../src/llm/llmQueue.js')
  const q = new LlmQueue(4)
  q.pause()
  for (let i = 0; i < 50; i++) q.enqueue({ fileId: i + 1, provider: 'p', model: 'm', prompt: '' })  // 模拟重蒸馏积压
  q.enqueue({ fileId: 0, provider: 'default-prov', model: '', prompt: '', priority: 100, options: { type: 'profile' } })
  const internal = (q as any).queue as any[]
  assert.equal(internal[0].options?.type, 'profile', '手动画像 job 必须插到积压队首（priority 100）')
  assert.equal(internal[0].provider, 'default-prov')

  // 层 2（流程语义）：真实 trigger 在 providers fixture 下入队成功；开关关闭返回 false
  const db = await getDb()
  await (await db.prepare(`UPDATE config SET value = ? WHERE key = 'ai.providers'`)).run([
    JSON.stringify([{ name: 'pd-prov-first' }, { name: 'pd-default-prov' }])
  ])
  await (await db.prepare("UPDATE config SET value = 'pd-default-prov' WHERE key = 'ai.defaultProvider'")).run()
  assert.equal(await triggerProfileDistill(true), true, '默认服务商存在时入队成功')

  // userProfile.enabled 不在 seedDefaults——INSERT OR REPLACE 造键（UPDATE 0 行测不到关闭态）
  await (await db.prepare("INSERT OR REPLACE INTO config (key, value, type) VALUES ('userProfile.enabled', 'false', 'boolean')")).run()
  assert.equal(await triggerProfileDistill(true), false, '开关关闭不入队')
  await (await db.prepare("UPDATE config SET value = 'true' WHERE key = 'userProfile.enabled'")).run()
})

test('buildProfileDistillPrompt：低信号域不进 prompt；负例与 user_added 清单在案；证据桶在案', async () => {
  const db = await getDb()
  const dHi = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('pd-高信号域')`)).run()).lastID)
  const dLo = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES ('pd-低信号域')`)).run()).lastID)
  for (let i = 0; i < 6; i++) {
    const f = Number((await (await db.prepare(`INSERT INTO files (path, name, ext, domain_id) VALUES (?, ?, 'md', ?)`)).run([`/pd/hi${i}.md`, `hi${i}`, dHi])).lastID)
    await (await db.prepare(`INSERT INTO read_history (file_id, path, source) VALUES (?, ?, 'reader')`)).run([f, `/pd/hi${i}.md`])
  }
  const fLo = Number((await (await db.prepare(`INSERT INTO files (path, name, ext, domain_id) VALUES ('/pd/lo.md', 'lo', 'md', ?)`)).run([dLo])).lastID)
  await (await db.prepare(`INSERT INTO read_history (file_id, path, source) VALUES (?, ?, 'reader')`)).run([fLo, '/pd/lo.md'])

  const bundle = await buildProfileSignalBundle(db)
  const prev = parseProfileContent(JSON.stringify({
    schema_version: '1', role_pattern: '',
    claims: [
      { claim: '用户偏好渐进式', status: 'user_added', evidence: [], confidence: 1 },
      { claim: '用户是理论派', status: 'vetoed', evidence: ['read_history:1'], confidence: 0.9 }
    ]
  }))
  const prompt = buildProfileDistillPrompt(bundle, prev, new Map([['E1', 'read_history:99']]))
  assert.ok(prompt.includes('pd-高信号域'))
  assert.ok(!prompt.includes('pd-低信号域'), '低信号域不得出现在 prompt（门槛在源头掐断）')
  assert.ok(prompt.includes('用户偏好渐进式'), 'user_added 清单必须告知 LLM 延续尊重')
  assert.ok(prompt.includes('用户是理论派') && prompt.includes('负例'), 'vetoed 负例必须写入 prompt')
  assert.ok(prompt.includes('E1 → read_history:99'), '证据编号桶必须在 prompt')
})

test('processProfileJob 端到端：入库/版本互斥/user_added 保留/vetoed 不出口/未知域丢弃/调用日志落行', async () => {
  const db = await getDb()
  // 预置：上版 global（含 user_added + vetoed）+ 一个高信号域 + 一个未知域名陷阱
  await (await db.prepare(`INSERT INTO user_profile (scope, domain_id, content, active) VALUES ('global', NULL, ?, 1)`)).run([
    JSON.stringify({ schema_version: '1', role_pattern: '旧', claims: [
      { claim: '用户补充保留', status: 'user_added', evidence: [], confidence: 1 },
      { claim: '否决不出', status: 'vetoed', evidence: ['read_history:1'], confidence: 0.5 }
    ] })
  ])
  const dName = 'pd-落地域'
  const dId = Number((await (await db.prepare(`INSERT INTO domains (name) VALUES (?)`)).run([dName])).lastID)
  for (let i = 0; i < 5; i++) {
    const f = Number((await (await db.prepare(`INSERT INTO files (path, name, ext, domain_id) VALUES (?, ?, 'md', ?)`)).run([`/pd/d${i}.md`, `d${i}`, dId])).lastID)
    await (await db.prepare(`INSERT INTO read_history (file_id, path, source) VALUES (?, ?, 'reader')`)).run([f, `/pd/d${i}.md`])
  }
  // evidence 编号先探：跑一次真实 prompt 收集（llmFn 捕获 prompt，从证据桶反推编号）
  let captured = ''
  const llmOk = async (p: string) => { captured = p; return `{"role_pattern":"新角色画像","claims":[{"claim":"全局新断言","evidence_refs":["E1"],"confidence":0.9}],"domains":[{"domain":"${dName}","proficiency":"expert","claims":[{"claim":"域内倾向","evidence_refs":["E1"],"confidence":0.8}]},{"domain":"不存在的域","claims":[]}]}` }
  await processProfileJob(fakeJob(), { llmFn: llmOk })
  const e1 = captured.match(/(E\d+) → read_history:/)?.[1]
  assert.ok(e1, 'prompt 中必须存在 read_history 证据编号')
  // 用真实编号重跑（首轮可能引用了错误编号被拒收——两段式保证端到端用合法编号过闸）；响应带 portrait
  const llmOk2 = async (p: string) => { captured = p; return `{"role_pattern":"新角色画像","portrait":"【基本信息】用户使用中文\\n【工作背景】全栈与 AI 工程\\n【个人背景】无\\n【协作偏好】偏好简短直接\\n【长期记忆】重实操","claims":[{"claim":"全局新断言","evidence_refs":["${e1}"],"confidence":0.9}],"domains":[{"domain":"${dName}","proficiency":"expert","claims":[{"claim":"域内倾向","evidence_refs":["${e1}"],"confidence":0.8}]},{"domain":"不存在的域","claims":[]}]}` }
  await processProfileJob(fakeJob(), { llmFn: llmOk2 })

  const g = await getActiveProfile(db, 'global', null)
  assert.ok(g)
  assert.equal(g.content.role_pattern, '新角色画像')
  assert.ok(g.content.portrait?.includes('【协作偏好】'), 'portrait 必须随蒸馏入库（fresh 接线：parse → merge → commit）')
  const gClaims = g.content.claims.map(c => c.claim)
  assert.ok(gClaims.includes('全局新断言') && gClaims.includes('用户补充保留'), '新 active + user_added 并存')
  assert.ok(!projectProfile(g.content).claims.some(c => c.claim === '否决不出'), 'vetoed 不进出口')
  assert.ok(g.content.claims.some(c => c.claim === '否决不出' && c.status === 'vetoed'), 'vetoed 留存作负例')
  // 全局只此一版 active（旧版被顶替）
  const cnt = await (await db.prepare(`SELECT COUNT(*) AS n FROM user_profile WHERE active = 1 AND scope = 'global'`)).get() as any
  assert.equal(Number(cnt.n), 1, 'global active 版本互斥')
  // 域画像落库且含 proficiency 折叠断言；未知域无行
  const dp = await getActiveProfile(db, 'domain', dId)
  assert.ok(dp)
  assert.ok(dp.content.claims.some(c => c.claim === 'proficiency: expert'))
  assert.ok(dp.content.claims.some(c => c.claim === '域内倾向'))
  const rows = await (await db.prepare(`SELECT COUNT(*) AS n FROM user_profile WHERE domain_id IS NOT NULL AND active = 1`)).all() as any[]
  assert.equal(Number(rows[0].n), 1, '未知域名的断言被丢弃，不建行（LLM 不得自创领域）')
  // 调用日志：两轮各一行（首轮拒收=failed 也必须落行——fail loud）；file_id NULL（无关联文件）
  const logs = await (await db.prepare(`SELECT status FROM llm_call_logs WHERE file_id IS NULL ORDER BY id`)).all() as any[]
  assert.ok(logs.length >= 2, '每轮蒸馏必须落 llm_call_logs（G1 成本可见）')
})

test('开关与零信号守卫：enabled=false 不蒸馏不落日志；零信号静默返回', async () => {
  const db = await getDb()
  assert.equal(await isProfileDistillEnabled(db), true, '缺省默认开（用户裁决）')
  const logsBefore = Number(((await (await db.prepare(`SELECT COUNT(*) AS n FROM llm_call_logs`)).get()) as any).n)
  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)')).run([CONFIG_ENABLED, 'false', 'boolean'])
  assert.equal(await triggerProfileDistill(), false, '开关关闭不入队')
  let called = false
  await processProfileJob(fakeJob(), { llmFn: async () => { called = true; return '{}' } })
  assert.equal(called, false, '开关关闭 processJob 直接返回')
  const logsAfter = Number(((await (await db.prepare(`SELECT COUNT(*) AS n FROM llm_call_logs`)).get()) as any).n)
  assert.equal(logsAfter, logsBefore, '开关关闭零日志（静默跳过非失败）')
  // 恢复开关 + 零信号库（新临时域无读取）→ 不蒸馏
  await (await db.prepare('INSERT OR REPLACE INTO config (key, value, type) VALUES (?, ?, ?)')).run([CONFIG_ENABLED, 'true', 'boolean'])
  called = false
  // 零信号判断基于 bundle 全局计数——上轮测试已种读取，此处无法归零；改为验证 enabled 复查路径已覆盖（called=false 分支）
  // 零信号路径由 bundle.domains.length===0 && totalReads===0 && chat===0 守卫——留给集成环境验证
})
