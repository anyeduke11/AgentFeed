import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkGate, isExcludedPath, pathWhitelisted, matchBlacklist, validateGateConfig, GATE_DEFAULTS, GateConfig } from '../src/gate.js'

/** 以默认配置为基底覆盖部分字段 */
const cfg = (over: Partial<GateConfig>): GateConfig => ({ ...GATE_DEFAULTS, ...over })

/** 足够长的正文（>300 有效字符，无 md 语法符号），用于隔离大小门禁 */
const LONG = '这是一段足够长的正文内容用于通过最小正文字符门禁评估。'.repeat(12)

test('总开关关闭：大小与内容门禁全部放行', () => {
  // WHY: 总开关是用户的一键止损手段，关闭后任何阈值都不应再拦截
  const out = checkGate('/x/tiny.md', 10, '短', cfg({ enabled: false }))
  assert.deepEqual(out, { pass: true })
})

test('minSize 开启：小文件被拦截并给出可读原因', () => {
  const out = checkGate('/x/tiny.md', 100, LONG, cfg({}))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /文件过小/)
})

test('minSize 关闭：同样的小文件放行', () => {
  // WHY: 单规则开关的意义就是让用户能手动关闭误杀的阈值
  const out = checkGate('/x/tiny.md', 100, LONG, cfg({ minSizeEnabled: false }))
  assert.equal(out.pass, true)
})

test('规则彼此独立：关闭 minSize 不影响 minChars 仍拦截短内容', () => {
  // WHY: 开关不能是全有全无，关掉一个门禁其他门禁必须仍然生效
  const out = checkGate('/x/tiny.md', 100, '短', cfg({ minSizeEnabled: false }))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /正文过短/)
})

test('minChars 开启：短正文被拦截', () => {
  const out = checkGate('/x/normal.md', 1024, '短', cfg({}))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /正文过短/)
})

test('minChars 关闭：短正文放行', () => {
  const out = checkGate('/x/normal.md', 1024, '短', cfg({ minCharsEnabled: false }))
  assert.equal(out.pass, true)
})

const mostlyCode = [
  '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4',
  'const e = 5', 'const f = 6', '```',
  LONG.slice(0, 160), LONG.slice(160, 320)
].join('\n')

test('codeRatio 开启：围栏行占比超限被拦截', () => {
  // 10 行中 8 行在围栏内（0.8 > 0.6），但围栏外正文 ≥300 字符——只应由代码占比规则拦截
  const out = checkGate('/x/code.md', 4096, mostlyCode, cfg({}))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /代码占比过高/)
})

test('codeRatio 关闭：同样内容放行', () => {
  const out = checkGate('/x/code.md', 4096, mostlyCode, cfg({ codeRatioEnabled: false }))
  assert.equal(out.pass, true)
})

test('文件名白名单开启：AGENTS.md 无论多小都直通', () => {
  // WHY: 白名单直通保证用户点名的有价值文件（agent 配置）永不误杀
  const out = checkGate('/x/AGENTS.md', 10, '短', cfg({}))
  assert.equal(out.pass, true)
})

test('文件名白名单关闭：AGENTS.md 按普通规则评估', () => {
  const out = checkGate('/x/AGENTS.md', 10, '短', cfg({ filenameWhitelistEnabled: false }))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /文件过小/)
})

test('关键词白名单开启：文件名含「测试」直通（大小写不敏感）', () => {
  assert.equal(checkGate('/x/测试记录.md', 10, '短', cfg({})).pass, true)
  assert.equal(checkGate('/x/PRD-登录.md', 10, '短', cfg({})).pass, true)
})

test('关键词白名单关闭：含关键词的小文件按普通规则拦截', () => {
  // WHY: 关闭关键词直通后，文件名不能再豁免门禁
  const out = checkGate('/x/测试记录.md', 10, '短', cfg({ keywordsEnabled: false }))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /文件过小/)
})

test('excludeDirs 开启：黑名单目录内路径被排除', () => {
  assert.equal(isExcludedPath('/repo/node_modules/a.md', cfg({})), true)
})

test('excludeDirs 关闭：黑名单目录内路径不再排除', () => {
  // WHY: 用户关闭目录排除意味着希望扫描这些目录（如收集依赖文档）
  assert.equal(isExcludedPath('/repo/node_modules/a.md', cfg({ excludeDirsEnabled: false })), false)
})

test('扫描根相对判定：agent 目录整体挂载为扫描根时不被自身黑名单误杀', () => {
  // WHY: .trae / .openclaw-autoclaw 在黑名单里，但用户显式挂载为扫描根时根内内容必须可入库
  const c = cfg({ excludeDirs: [...GATE_DEFAULTS.excludeDirs, '.trae'] })
  assert.equal(isExcludedPath('/Users/demo/.trae/notes/a.md', c, ['/Users/demo/.trae']), false)
  // 根内嵌套的黑名单目录仍要排除
  assert.equal(isExcludedPath('/Users/demo/.trae/proj/node_modules/a.md', c, ['/Users/demo/.trae']), true)
})

test('内置文件黑名单不受 excludeDirs 开关控制', () => {
  // WHY: CHANGELOG/LICENSE/.log 是无价值文件的兜底规则，与可配置的目录列表语义不同
  const c = cfg({ excludeDirsEnabled: false })
  assert.equal(isExcludedPath('/repo/CHANGELOG.md', c), true)
  assert.equal(isExcludedPath('/repo/debug.log', c), true)
})

// ---- 路径白名单（v1.5）：指定路径无视大小与内容门禁强制入库 ----

test('pathWhitelisted：前缀匹配语义（等于条目 / 位于条目之下）', () => {
  const list = ['/repo/keep']
  assert.equal(pathWhitelisted('/repo/keep', list), true)
  assert.equal(pathWhitelisted('/repo/keep/a.md', list), true)
  assert.equal(pathWhitelisted('/repo/keep2/a.md', list), false) // 不能是纯字符串前缀
  assert.equal(pathWhitelisted('/repo/other/a.md', list), false)
})

test('路径白名单：小文件 + 短内容双超标仍放行', () => {
  // WHY: 该白名单的目的就是「不管文件大小，指定路径必入库」
  const c = cfg({ pathWhitelist: ['/repo/keep'] })
  assert.deepEqual(checkGate('/repo/keep/tiny.md', 10, '短', c), { pass: true })
})

test('路径白名单关闭：同样文件按普通规则拦截', () => {
  const c = cfg({ pathWhitelist: ['/repo/keep'], pathWhitelistEnabled: false })
  const out = checkGate('/repo/keep/tiny.md', 10, '短', c)
  assert.equal(out.pass, false)
  assert.match(out.reason!, /文件过小/)
})

test('路径白名单优先于排除目录（Gate 1）', () => {
  // WHY: 用户显式指定的路径意图最强，node_modules 中的白名单子树应可入库
  const c = cfg({ pathWhitelist: ['/repo/node_modules/keep-pkg/docs'] })
  assert.equal(isExcludedPath('/repo/node_modules/keep-pkg/docs/a.md', c), false)
  assert.equal(isExcludedPath('/repo/node_modules/other/a.md', c), true)
})

test('路径白名单优先于内置文件黑名单', () => {
  const c = cfg({ pathWhitelist: ['/repo/legal'] })
  assert.equal(isExcludedPath('/repo/legal/LICENSE.md', c), false)
  assert.equal(isExcludedPath('/repo/other/LICENSE.md', c), true)
})

test('目录剪枝放行：白名单条目位于排除目录之下时该目录不可剪', () => {
  // WHY: walk 按目录名剪枝，若不检查「白名单在被剪目录内」，白名单永远不会被走到
  const c = cfg({ pathWhitelist: ['/repo/node_modules/keep-pkg'] })
  assert.equal(isExcludedPath('/repo/node_modules', c), false) // 目录本身
  assert.equal(isExcludedPath('/repo/node_modules/other/a.md', c), true) // 白名单只豁免自己那棵子树，兄弟目录仍排除
  assert.equal(isExcludedPath('/repo/dist', c), true)
})

test('路径白名单尾斜杠归一化', () => {
  const c = cfg({ pathWhitelist: ['/repo/keep/'] })
  assert.equal(pathWhitelisted('/repo/keep/a.md', c.pathWhitelist), true)
})

// ---- 文件黑名单（v1.6）：通配 / 扩展名 / 正则 / 纯文本四种条目语法 ----

test('黑名单通配条目：*.tmp.md 拦截，正常 md 放行（大小写不敏感）', () => {
  // WHY: 临时导出文件（如 Notion 导出的 *.tmp.md）是典型垃圾内容，通配是最直观的表达
  const list = ['*.tmp.md']
  assert.equal(matchBlacklist('/repo/a.TMP.MD', list), '*.tmp.md')
  assert.equal(matchBlacklist('/repo/notes.md', list), null)
})

test('黑名单通配条目：含 / 的模式可匹配完整路径', () => {
  assert.equal(matchBlacklist('/repo/private/notes.md', ['/repo/private/*']), '/repo/private/*')
  assert.equal(matchBlacklist('/repo/public/notes.md', ['/repo/private/*']), null)
})

test('黑名单扩展名条目：.log 拦截 debug.log，不误伤 blog.md', () => {
  // WHY: 选后缀语义而非子串，是因为 .log 作为子串会误伤 x.logs.md 这类正常文件名
  const list = ['.log']
  assert.equal(matchBlacklist('/repo/debug.log', list), '.log')
  assert.equal(matchBlacklist('/repo/Debug.LOG', list), '.log')
  assert.equal(matchBlacklist('/repo/blog.md', list), null)
  assert.equal(matchBlacklist('/repo/x.logs.md', list), null)
})

test('黑名单正则条目：/^draft-/ 拦截草稿前缀', () => {
  const list = ['/^draft-/']
  assert.equal(matchBlacklist('/repo/draft-需求.md', list), '/^draft-/')
  assert.equal(matchBlacklist('/repo/final-需求.md', list), null)
  // 正则也能匹配路径片段（如目录维度拦截）
  assert.equal(matchBlacklist('/repo/scratch/notes.md', ['/scratch/']), '/scratch/')
})

test('黑名单纯文本条目：文件名包含即拦截', () => {
  const list = ['副本']
  assert.equal(matchBlacklist('/repo/报告-副本.md', list), '副本')
  assert.equal(matchBlacklist('/repo/报告.md', list), null)
})

test('黑名单开关关闭：命中条目也放行', () => {
  // WHY: 与其他规则一致，单规则开关必须能让用户一键停用误杀模式
  const out = checkGate('/repo/a.tmp.md', 1024, LONG, cfg({ blacklist: ['*.tmp.md'], blacklistEnabled: false }))
  assert.equal(out.pass, true)
})

test('黑名单开启：命中即拦截且原因带条目', () => {
  const out = checkGate('/repo/a.tmp.md', 1024, LONG, cfg({ blacklist: ['*.tmp.md'] }))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /命中黑名单（\*\.tmp\.md）/)
})

test('黑名单优先于关键词白名单', () => {
  // WHY: 白名单是便捷放行，黑名单是显式拦截；两者同时命中时必须拦截，
  // 否则用户加黑名单后发现文件仍从关键词直通溜进来，规则形同虚设
  const out = checkGate('/repo/测试-临时稿.md', 1024, LONG, cfg({ blacklist: ['临时'], keywords: ['测试'] }))
  assert.equal(out.pass, false)
  assert.match(out.reason!, /命中黑名单/)
})

test('路径白名单仍高于黑名单', () => {
  // WHY: 路径白名单的既有契约是「最高优先级强制入库」，黑名单不得破坏该契约
  const c = cfg({ pathWhitelist: ['/repo/keep'], blacklist: ['*.md'] })
  assert.deepEqual(checkGate('/repo/keep/a.md', 10, '短', c), { pass: true })
  assert.equal(checkGate('/repo/other/a.md', 1024, LONG, c).pass, false)
})

test('非法正则条目跳过不崩溃，后续条目继续评估', () => {
  // WHY: 正则由用户手输，语法错误不应拖垮整个扫描流程
  const list = ['/([/', '.log']
  assert.equal(matchBlacklist('/repo/a.md', list), null)
  assert.equal(matchBlacklist('/repo/b.log', list), '.log')
})

const fieldOf = (out: ReturnType<typeof validateGateConfig>, field: string) =>
  out.fields.find(f => f.field === field)!

test('默认配置全字段合法：无 issue 无 warning 且全部生效', () => {
  const out = validateGateConfig(cfg({ excludeDirs: ['node_modules', 'dist'], pathWhitelist: ['/Users/demo/notes'] }))
  for (const f of out.fields) {
    assert.deepEqual(f.issues, [], `${f.field} 不应有 issue`)
    assert.deepEqual(f.warnings, [], `${f.field} 不应有 warning`)
    assert.equal(f.enabled, true)
  }
  assert.equal(out.masterEnabled, true)
})

test('黑名单非法正则 → issue，且该条目运行时确实永不命中（校验口径与实现联动）', () => {
  // WHY: 有效性识别的价值是抓「静默失败」——若 validator 报无效但运行时却能命中，就是误报
  const c = cfg({ blacklist: ['/([/', '.log'] })
  const f = fieldOf(validateGateConfig(c), 'blacklist')
  assert.equal(f.issues.length, 1)
  assert.match(f.issues[0].reason, /正则语法错误/)
  assert.equal(matchBlacklist('/repo/anything.md', ['/([/']), null)
})

test('黑名单未闭合正则（/ 开头非 / 结尾）→ issue：静默降级为纯文本永不命中', () => {
  // WHY: 用户写 /^draft- 想按正则拦草稿，实际被当纯文本匹配文件名——最典型的静默失败
  const c = cfg({ blacklist: ['/^draft-'] })
  const f = fieldOf(validateGateConfig(c), 'blacklist')
  assert.equal(f.issues.length, 1)
  assert.match(f.issues[0].reason, /未以 \/ 结尾/)
  assert.equal(matchBlacklist('/repo/draft-abc.md', ['/^draft-']), null)
})

test('黑名单 ^ 开头未包 /…/ → warning 存疑（合法纯文本但大概率不符意图）', () => {
  const f = fieldOf(validateGateConfig(cfg({ blacklist: ['^draft-'] })), 'blacklist')
  assert.equal(f.issues.length, 0)
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0].reason, /疑似正则/)
})

test('路径白名单相对路径 → issue；根路径 / → issue', () => {
  // WHY: pathWhitelisted 只做绝对前缀匹配，相对路径与裸 / 都会被静默忽略
  const f = fieldOf(validateGateConfig(cfg({ pathWhitelist: ['notes', '/'] })), 'pathWhitelist')
  assert.equal(f.issues.length, 2)
  assert.match(f.issues[0].reason, /绝对路径/)
  assert.match(f.issues[1].reason, /根路径/)
})

test('excludeDirs 含路径分隔符 → issue（默认值 server/public 即为真实案例）', () => {
  // WHY: 排除按单级目录名比对，'server/public' 永远不等于任何单级 part——默认配置里就藏着死条目
  const f = fieldOf(validateGateConfig(cfg({})), 'excludeDirs')
  assert.ok(f.issues.some(i => i.entry === 'server/public'))
  assert.equal(isExcludedPath('/repo/server/public/a.md', cfg({})), false)
})

test('数值规则：codeRatio 越界 → issue；minSize=0 → warning 存疑', () => {
  const out = validateGateConfig(cfg({ codeRatio: 1.5, minSize: 0 }))
  assert.match(fieldOf(out, 'codeRatio').issues[0].reason, /0~1/)
  assert.match(fieldOf(out, 'minSize').warnings[0].reason, /形同关闭/)
})

test('开关关闭：enabled=false（前端据此显示「已关闭」）', () => {
  const out = validateGateConfig(cfg({ enabled: false, blacklistEnabled: false }))
  assert.equal(out.masterEnabled, false)
  for (const f of out.fields) assert.equal(f.enabled, false)
})
