import path from 'path'
import fs from 'fs/promises'
import { createReadStream } from 'fs'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { getDb } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 与 db.ts 同源的数据目录覆盖（归档目录跟随数据目录走，测试不污染仓库 server/data）
const DATA_DIR = process.env.AGENTFEED_DATA_DIR
  ? path.resolve(process.env.AGENTFEED_DATA_DIR)
  : path.join(__dirname, '../data')
export const GATE_ARCHIVE_DIR = path.join(DATA_DIR, 'gate-archives')

const CSV_COLUMNS = ['path', 'name', 'ext', 'title', 'size', 'md5', 'gate_reason', 'created_at', 'updated_at']

function csvEscape(v: any): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * 将 skipped 过滤记录按月写入 CSV 存档后从表中删除。
 * onlyPastMonths=true 时只归档非当月记录（供扫描/启动时定期归档调用）。
 */
export async function archiveSkippedRecords(onlyPastMonths = false): Promise<{ archived: number; files: string[] }> {
  const db = await getDb()
  await fs.mkdir(GATE_ARCHIVE_DIR, { recursive: true })
  const nowMonth = String((await (await db.prepare("SELECT strftime('%Y-%m','now') AS m")).get() as any).m)
  const where = onlyPastMonths ? `WHERE status = 'skipped' AND substr(updated_at, 1, 7) < '${nowMonth}'` : "WHERE status = 'skipped'"
  const rows = await (await db.prepare(`SELECT * FROM gate_records ${where}`)).all() as any[]
  if (rows.length === 0) return { archived: 0, files: [] }

  const byMonth = new Map<string, any[]>()
  for (const r of rows) {
    const m = String(r.updated_at).slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(r)
  }

  const files: string[] = []
  for (const [month, recs] of byMonth) {
    const fp = path.join(GATE_ARCHIVE_DIR, `${month}.csv`)
    let exists = false
    try { exists = (await fs.stat(fp)).isFile() } catch { /* 不存在则写入表头 */ }
    let text = ''
    if (!exists) text += '\uFEFF' + CSV_COLUMNS.join(',') + '\n'
    for (const r of recs) text += CSV_COLUMNS.map(c => csvEscape(r[c])).join(',') + '\n'
    await fs.appendFile(fp, text)
    files.push(`${month}.csv`)
  }

  const ids = rows.map(r => r.id).join(',')
  await db.exec(`DELETE FROM gate_records WHERE id IN (${ids})`)
  return { archived: rows.length, files }
}

/** 列出已存在的按月存档文件 */
export async function listArchives(): Promise<any[]> {
  await fs.mkdir(GATE_ARCHIVE_DIR, { recursive: true })
  const names = (await fs.readdir(GATE_ARCHIVE_DIR)).filter(f => /^\d{4}-\d{2}\.csv$/.test(f)).sort().reverse()
  const items: any[] = []
  for (const f of names) {
    const fp = path.join(GATE_ARCHIVE_DIR, f)
    const st = await fs.stat(fp)
    const content = await fs.readFile(fp, 'utf-8')
    const lines = content.replace(/^\uFEFF/, '').split('\n').filter(l => l.trim().length > 0)
    items.push({ file: f, month: f.replace(/\.csv$/, ''), count: Math.max(0, lines.length - 1), size: st.size, url: `/api/gate/archives/${f}` })
  }
  return items
}

export function archiveFilePath(name: string): string {
  return path.join(GATE_ARCHIVE_DIR, name)
}

/** 解析单行 CSV（支持双引号转义字段） */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') { out.push(cur); cur = '' }
      else cur += ch
    }
  }
  out.push(cur)
  return out
}

/** 检索存档 CSV：按关键字过滤 path/title/gate_reason 等字段，可指定月份 */
export async function searchArchives(q: string, month?: string | null, limit = 100): Promise<any[]> {
  await fs.mkdir(GATE_ARCHIVE_DIR, { recursive: true })
  const names = (await fs.readdir(GATE_ARCHIVE_DIR))
    .filter(f => /^\d{4}-\d{2}\.csv$/.test(f) && (!month || f === `${month}.csv`))
    .sort()
    .reverse()
  const needle = q.toLowerCase()
  const results: any[] = []
  for (const f of names) {
    if (results.length >= limit) break
    const content = await fs.readFile(path.join(GATE_ARCHIVE_DIR, f), 'utf-8')
    const lines = content.replace(/^\uFEFF/, '').split('\n')
    for (const line of lines.slice(1)) {
      if (!line.trim() || !line.toLowerCase().includes(needle)) continue
      const cells = parseCsvLine(line)
      const row: any = {}
      CSV_COLUMNS.forEach((c, i) => { row[c] = cells[i] ?? '' })
      if (CSV_COLUMNS.some(c => String(row[c]).toLowerCase().includes(needle))) {
        results.push({ month: f.replace(/\.csv$/, ''), ...row })
        if (results.length >= limit) break
      }
    }
  }
  return results
}

export interface GateConfig {
  enabled: boolean
  minSize: number
  minChars: number
  codeRatio: number
  minSizeEnabled: boolean
  minCharsEnabled: boolean
  codeRatioEnabled: boolean
  excludeDirs: string[]
  filenameWhitelist: string[]
  keywords: string[]
  pathWhitelist: string[]
  pathWhitelistEnabled: boolean
  blacklist: string[]
  blacklistEnabled: boolean
  excludeDirsEnabled: boolean
  filenameWhitelistEnabled: boolean
  keywordsEnabled: boolean
}

export const GATE_DEFAULTS: GateConfig = {
  enabled: true,
  minSize: 512,
  minChars: 300,
  codeRatio: 0.6,
  minSizeEnabled: true,
  minCharsEnabled: true,
  codeRatioEnabled: true,
  excludeDirsEnabled: true,
  filenameWhitelistEnabled: true,
  keywordsEnabled: true,
  pathWhitelistEnabled: true,
  blacklistEnabled: true,
  blacklist: [],
  pathWhitelist: [],
  excludeDirs: [
    'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '__pycache__',
    '.venv', 'venv', 'target', 'vendor', '.next', '.cache', '.trae', '.openclaw-autoclaw',
    '.idea', '.vscode', '.output', '.nuxt', 'server/public'
  ],
  filenameWhitelist: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'SKILL.md', 'SKILLS.md'],
  keywords: ['prd', '需求', '测试', 'test record', '复盘', '设计', '方案', '总结', '笔记']
}

export async function loadGateConfig(): Promise<GateConfig> {
  const db = await getDb()
  const stmt = await db.prepare("SELECT key, value, type FROM config WHERE key LIKE 'gate.%'")
  const rows = await stmt.all() as any[]
  const cfg: GateConfig = {
    ...GATE_DEFAULTS,
    excludeDirs: [...GATE_DEFAULTS.excludeDirs],
    filenameWhitelist: [...GATE_DEFAULTS.filenameWhitelist],
    keywords: [...GATE_DEFAULTS.keywords],
    pathWhitelist: [...GATE_DEFAULTS.pathWhitelist],
    blacklist: [...GATE_DEFAULTS.blacklist]
  }
  for (const r of rows) {
    const k = String(r.key).replace('gate.', '')
    if (!(k in cfg)) continue
    let v: any = r.value
    if (r.type === 'json') {
      try { v = JSON.parse(v) } catch { continue }
    } else if (r.type === 'boolean') v = v === 'true'
    else if (r.type === 'number') v = Number(v)
    ;(cfg as any)[k] = v
  }
  return cfg
}

/** 扫描根路径归一化：去掉尾部斜杠（根 '/' 原样保留）。
 *  walk() 用 path.join 产出的文件路径永不含尾斜杠，而未归一化的根会让
 *  「path = root OR path LIKE root/'%'」这类覆盖判断永久失配（该根文件被误判无主）。 */
export function normalizeRootPath(p: string): string {
  const s = String(p)
  return s.length > 1 ? s.replace(/\/+$/, '') : s
}

/** 路径白名单前缀匹配：fp 等于条目或位于条目之下（或条目位于 fp 之下——用于目录剪枝放行） */
export function pathWhitelisted(fp: string, list: string[]): boolean {
  return list.some(e => {
    const p = e.trim().replace(/\/+$/, '')
    return p !== '' && (fp === p || fp.startsWith(p + '/') || fp.startsWith(p + path.sep) || p.startsWith(fp + '/'))
  })
}

export function isPathWhitelisted(fp: string, cfg: GateConfig): boolean {
  return cfg.pathWhitelistEnabled && pathWhitelisted(fp, cfg.pathWhitelist)
}

/**
 * 文件黑名单匹配：返回命中的条目（未命中返回 null）。四种条目语法：
 * - `/正则/`   → 对文件名与完整路径做正则匹配（大小写不敏感）
 * - 含 * 或 ?  → 通配符匹配文件名与完整路径（* 任意串、? 单字符，大小写不敏感）
 * - . 开头     → 按扩展名后缀匹配文件名（如 .log 精确匹配结尾，不会误伤 x.logs.md）
 * - 其他文本   → 文件名包含即拦截（如 副本、draft）
 * 非法正则条目跳过不报错（保存侧已校验，此处兜底）。
 */
export function matchBlacklist(fp: string, list: string[]): string | null {
  const base = path.basename(fp)
  const loBase = base.toLowerCase()
  const loFp = fp.toLowerCase()
  for (const raw of list) {
    const e = raw.trim()
    if (!e) continue
    if (e.length > 2 && e.startsWith('/') && e.endsWith('/')) {
      try {
        const re = new RegExp(e.slice(1, -1), 'i')
        if (re.test(base) || re.test(fp)) return e
      } catch { /* 非法正则跳过 */ }
      continue
    }
    if (e.includes('*') || e.includes('?')) {
      const src = '^' + e.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      if (new RegExp(src, 'i').test(loBase) || new RegExp(src, 'i').test(loFp)) return e
      continue
    }
    if (e.startsWith('.')) {
      if (loBase.endsWith(e.toLowerCase())) return e
      continue
    }
    if (loBase.includes(e.toLowerCase())) return e
  }
  return null
}

/** Gate 1：路径门禁（目录/文件黑名单，命中即彻底忽略，不入库不记录）
 *  roots：已注册扫描根。若路径位于某扫描根之下，只对根之后的部分做排除判断——
 *  用于支持「agent 隐藏目录本身在黑名单」的场景（如扫描根 ~/.trae、~/.openclaw-autoclaw）。
 *  路径白名单优先级最高：命中即不排除（含内置文件黑名单）。 */
export function isExcludedPath(fp: string, cfg: GateConfig, roots: string[] = []): boolean {
  if (isPathWhitelisted(fp, cfg)) return false
  const root = roots.find(r => fp === r || fp.startsWith(r + '/') || fp.startsWith(r + path.sep))
  const rel = root ? fp.slice(root.length) : fp
  if (cfg.excludeDirsEnabled) {
    const parts = rel.split(path.sep)
    if (parts.some(p => cfg.excludeDirs.includes(p))) return true
  }
  const base = path.basename(fp)
  if (/^(CHANGELOG\.md|LICENSE\.md|LICENSE|NOTICE)$/i.test(base)) return true
  if (/\.log$/i.test(base)) return true
  return false
}

/** 门禁裁决：ruleId/metric 记录命中的规则与实际指标值（gate_records 落库，质量口径可观测） */
export interface GateVerdict {
  pass: boolean
  reason?: string
  ruleId?: 'blacklist' | 'minSize' | 'minChars' | 'codeRatio'
  metric?: number | string
}

/** Gate 2 + 3：大小与内容门禁（拦截则记入 gate_records，可恢复） */
export function checkGate(fp: string, size: number, raw: string, cfg: GateConfig): GateVerdict {
  if (!cfg.enabled) return { pass: true }
  // 路径白名单：最高优先级，无视大小与内容门禁强制入库（蒸馏走常规 pending 队列）
  if (isPathWhitelisted(fp, cfg)) return { pass: true }
  // 文件黑名单：优先级高于文件名/关键词白名单（显式拦截压过便捷放行），命中记入 gate_records 可恢复
  if (cfg.blacklistEnabled) {
    const hit = matchBlacklist(fp, cfg.blacklist)
    if (hit) return { pass: false, reason: `命中黑名单（${hit}）`, ruleId: 'blacklist', metric: hit }
  }
  const base = path.basename(fp)
  // 白名单直通
  if (cfg.filenameWhitelistEnabled && cfg.filenameWhitelist.some(w => base.toLowerCase() === w.toLowerCase())) return { pass: true }
  if (cfg.keywordsEnabled && cfg.keywords.some(k => base.toLowerCase().includes(k.toLowerCase()))) return { pass: true }
  // Gate 2 大小下限
  if (cfg.minSizeEnabled && size < cfg.minSize) return { pass: false, reason: `文件过小（${size}B < ${cfg.minSize}B）`, ruleId: 'minSize', metric: size }
  // Gate 3 内容门禁：去 frontmatter、去代码围栏、去 md 语法符号后的有效字符数
  const noFence = raw.replace(/```[\s\S]*?```/g, '')
  const text = countEffectiveChars(raw)
  if (cfg.minCharsEnabled && text < cfg.minChars) return { pass: false, reason: `正文过短（${text} 字符 < ${cfg.minChars}）`, ruleId: 'minChars', metric: text }
  // Gate 3 代码占比（围栏行 / 总行）
  const totalLines = raw.split('\n').length
  const keptLines = noFence.split('\n').length
  const codeLines = totalLines - keptLines
  if (cfg.codeRatioEnabled && totalLines > 0 && codeLines / totalLines > cfg.codeRatio) {
    return { pass: false, reason: `代码占比过高（${Math.round((codeLines / totalLines) * 100)}% > ${Math.round(cfg.codeRatio * 100)}%）`, ruleId: 'codeRatio', metric: codeLines / totalLines }
  }
  return { pass: true }
}

/** 有效正文字符数：去 frontmatter、去代码围栏、去 md 语法符号（checkGate / checkGateSample 共用） */
function countEffectiveChars(raw: string): number {
  return raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^#+\s+.+$/gm, '')
    .replace(/[#*_`~>\-|]/g, '')
    .replace(/\s+/g, '')
    .length
}

/**
 * 大文件抽样门禁：超过 SIZE_ANALYZE_LIMIT 的文件只读头部（64KB）评估，
 * 跑黑名单 + 正文字符下限（codeRatio 抽样不可靠，跳过）。优先级与 checkGate 一致：
 * 路径白名单 > 黑名单 > 文件名/关键词白名单 > 大小下限（真实 size）> 字符下限（抽样）。
 */
export function checkGateSample(fp: string, size: number, head: string, cfg: GateConfig): GateVerdict {
  if (!cfg.enabled) return { pass: true }
  if (isPathWhitelisted(fp, cfg)) return { pass: true }
  if (cfg.blacklistEnabled) {
    const hit = matchBlacklist(fp, cfg.blacklist)
    if (hit) return { pass: false, reason: `命中黑名单（${hit}）`, ruleId: 'blacklist', metric: hit }
  }
  const base = path.basename(fp)
  if (cfg.filenameWhitelistEnabled && cfg.filenameWhitelist.some(w => base.toLowerCase() === w.toLowerCase())) return { pass: true }
  if (cfg.keywordsEnabled && cfg.keywords.some(k => base.toLowerCase().includes(k.toLowerCase()))) return { pass: true }
  if (cfg.minSizeEnabled && size < cfg.minSize) return { pass: false, reason: `文件过小（${size}B < ${cfg.minSize}B）`, ruleId: 'minSize', metric: size }
  if (cfg.minCharsEnabled) {
    const text = countEffectiveChars(head)
    if (text < cfg.minChars) return { pass: false, reason: `正文过短（${text} 字符 < ${cfg.minChars}，抽样头部）`, ruleId: 'minChars', metric: text }
  }
  return { pass: true }
}

/**
 * 大文件代码占比流式统计（P1-⑤ 修复）：逐行围栏状态机，O(1) 内存得到全文件精确占比，
 * 与 checkGate 的围栏剥离口径对齐——按 ``` 子串逐次翻转进出围栏态，行处理完所有 ``` 后
 * 仍处于围栏内则该行计入代码行（等价于 checkGate 正则删掉 ```…``` 跨度内的换行）。
 * 解决「头部像散文、体内全是代码」的 >512KB 文件凭 64KB 抽样绕过 codeRatio 的结构缺口
 * （抽样占比不可靠，但占比本就只需行级状态机，无需把文件读进内存）。
 * 读取失败返回 null，调用方按放行处理（与头部门禁分支口径一致）。
 */
export async function streamCodeRatioStats(fp: string): Promise<{ ratio: number; codeLines: number; totalLines: number } | null> {
  let totalLines = 0
  let codeLines = 0
  let inFence = false
  try {
    const rl = readline.createInterface({ input: createReadStream(fp), crlfDelay: Infinity })
    for await (const line of rl) {
      const marks = (line.match(/```/g) || []).length
      if (marks % 2 === 1) inFence = !inFence
      totalLines++
      if (inFence) codeLines++
    }
    await rl.close()
  } catch {
    return null
  }
  return { ratio: totalLines > 0 ? codeLines / totalLines : 0, codeLines, totalLines }
}

/** Gate 1 存量清洗：对已入库但命中排除规则的记录墓碑化（知识资产保留，规则调整后可复活）。
 *  排除判断与 isExcludedPath 一致（扫描根相对），避免误伤挂载为扫描根的 agent 目录内容。 */
export async function purgeExcludedFiles(cfg: GateConfig): Promise<number> {
  const db = await getDb()
  const rootRows = await (await db.prepare('SELECT path FROM scan_roots')).all() as any[]
  const roots = rootRows.map((r: any) => normalizeRootPath(r.path))
  const rows = await (await db.prepare("SELECT id, path FROM files WHERE status = 'active'")).all() as any[]
  const tombIds: number[] = []
  for (const r of rows) {
    if (isExcludedPath(r.path, cfg, roots)) tombIds.push(r.id)
  }
  let purged = 0
  for (let i = 0; i < tombIds.length; i += 100) {
    const chunk = tombIds.slice(i, i + 100)
    await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id IN (${chunk.join(',')})`)
    purged += chunk.length
  }
  return purged
}

export interface GateEntryIssue { entry: string; reason: string; fix?: string }
export interface GateFieldValidity {
  field: string
  label: string
  /** 总开关 && 该规则开关（关闭时不参与拦截） */
  enabled: boolean
  /** 条目/取值总数（数值规则为 1） */
  total: number
  /** 无效条目：按当前匹配语义永远不会生效 */
  issues: GateEntryIssue[]
  /** 存疑条目：语法合法但大概率不符书写意图 */
  warnings: GateEntryIssue[]
}

/**
 * 门禁配置有效性识别：逐字段按真实匹配语义校验，抓「静默失败」——
 * 非法正则、未闭合正则被当纯文本、路径白名单相对路径、排除目录含路径分隔符等。
 * 校验口径必须与 matchBlacklist / isExcludedPath / checkGate 的实际实现保持一致。
 */
export function validateGateConfig(cfg: GateConfig): { masterEnabled: boolean; fields: GateFieldValidity[] } {
  const fields: GateFieldValidity[] = []

  const field = (name: string, label: string, ruleEnabled: boolean, entries: string[], check: (e: string, ctx: { issue: (r: string, fix?: string) => void; warn: (r: string, fix?: string) => void }) => void): GateFieldValidity => {
    const issues: GateEntryIssue[] = []
    const warnings: GateEntryIssue[] = []
    for (const raw of entries) {
      const e = String(raw).trim()
      if (!e) { issues.push({ entry: String(raw), reason: '空条目', fix: '删除空条目' }); continue }
      check(e, { issue: (r, fix) => issues.push({ entry: e, reason: r, fix }), warn: (r, fix) => warnings.push({ entry: e, reason: r, fix }) })
    }
    return { field: name, label, enabled: cfg.enabled && ruleEnabled, total: entries.length, issues, warnings }
  }

  // 排除目录：isExcludedPath 按 rel.split(path.sep) 后与条目精确比对，条目含分隔符永不命中
  fields.push(field('excludeDirs', '排除目录', cfg.excludeDirsEnabled, cfg.excludeDirs, (e, { issue }) => {
    if (e.includes('/') || e.includes('\\')) issue('包含路径分隔符，目录按单级名称匹配，永远不会命中', `改为单级目录名「${e.split(/[\\/]/).pop()}」，匹配任意层级下的同名目录`)
  }))

  // 文件名白名单：basename 精确相等比对
  fields.push(field('filenameWhitelist', '文件名白名单', cfg.filenameWhitelistEnabled, cfg.filenameWhitelist, (e, { issue }) => {
    if (e.includes('/')) issue('精确匹配文件名，不含路径，永远不会命中', `去掉路径部分，只保留「${e.split('/').pop()}」`)
    else if (e.includes('*') || e.includes('?')) issue('不支持通配符（精确匹配文件名）；包含匹配请用关键词白名单', '去掉通配符改为精确文件名，或把关键词移入「关键词白名单」')
  }))

  // 关键词白名单：basename 包含即放行，任意非空文本都有效
  fields.push(field('keywords', '关键词白名单', cfg.keywordsEnabled, cfg.keywords, () => {}))

  // 文件黑名单：四种条目语法，重点抓正则书写错误导致的静默降级
  fields.push(field('blacklist', '文件黑名单', cfg.blacklistEnabled, cfg.blacklist, (e, { issue, warn }) => {
    if (e.startsWith('/')) {
      if (!(e.length > 2 && e.endsWith('/'))) {
        issue('以 / 开头但未以 / 结尾，按纯文本匹配文件名（几乎不会命中）；正则需写成 /…/ 形式', `写成「${e}/」启用正则，或去掉开头的 / 改为纯文本匹配`)
        return
      }
      try { new RegExp(e.slice(1, -1), 'i') } catch (err: any) { issue('正则语法错误：' + String(err?.message || err), '修正正则语法（可在浏览器控制台 new RegExp 试写）') }
      return
    }
    if (e.startsWith('^') || e.endsWith('$')) warn('疑似正则语法，将按纯文本匹配文件名；正则需写成 /…/ 形式', '如需正则语义写成 /…/ 形式；纯文本匹配请去掉 ^ 和 $')
  }))

  // 路径白名单：绝对路径前缀匹配（条目尾部斜杠会被归一化）
  fields.push(field('pathWhitelist', '路径白名单', cfg.pathWhitelistEnabled, cfg.pathWhitelist, (e, { issue }) => {
    if (!e.startsWith('/')) issue('请填写绝对路径（以 / 开头），相对路径永远不会命中', `改为绝对路径，如「${process.cwd()}/${e}」`)
    else if (e.replace(/\/+$/, '') === '') issue('根路径 / 条目会被忽略；如需放行全部请直接关闭门禁')
  }))

  // 数值规则：NaN/越界为无效，0 值形同关闭为存疑
  const numeric = (name: string, label: string, ruleEnabled: boolean, v: number, check: (e: string, ctx: { issue: (r: string, fix?: string) => void; warn: (r: string, fix?: string) => void }) => void): GateFieldValidity => {
    const issues: GateEntryIssue[] = []
    const warnings: GateEntryIssue[] = []
    const e = String(v)
    if (!Number.isFinite(v)) issues.push({ entry: e, reason: '不是有效数值', fix: '填入有效数字' })
    else check(e, { issue: (r, fix) => issues.push({ entry: e, reason: r, fix }), warn: (r, fix) => warnings.push({ entry: e, reason: r, fix }) })
    return { field: name, label, enabled: cfg.enabled && ruleEnabled, total: 1, issues, warnings }
  }
  const zeroWarn = (v: number) => (e: string, { warn }: { warn: (r: string, fix?: string) => void }) => {
    if (v <= 0) warn('0 表示不拦截任何文件，形同关闭', '改为大于 0 的数值，或关闭该规则开关')
  }
  fields.push(numeric('minSize', '最小文件大小', cfg.minSizeEnabled, cfg.minSize, zeroWarn(cfg.minSize)))
  fields.push(numeric('minChars', '最小正文字符', cfg.minCharsEnabled, cfg.minChars, zeroWarn(cfg.minChars)))
  fields.push(numeric('codeRatio', '代码占比上限', cfg.codeRatioEnabled, cfg.codeRatio, (e, { issue, warn }) => {
    if (cfg.codeRatio < 0 || cfg.codeRatio > 1) issue('需在 0~1 之间', '填入 0~1 之间的小数，如 0.6')
    else if (cfg.codeRatio <= 0) warn('0 表示不拦截任何文件，形同关闭', '改为大于 0 的数值，或关闭该规则开关')
  }))

  return { masterEnabled: cfg.enabled, fields }
}
