import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { SqliteDatabase } from '@homeofthings/sqlite3'
import { DATA_DIR, getDb } from './db.js'
import { withinScanRoots } from './routes/files.js'

/* ---------------- B1 可复现导出 + 内容指纹（v0.1.5） ----------------
 * 目标：第三方可验证「我们声称门禁+蒸馏过」——导出即冻结、指纹可校验。
 * server 无 zip 依赖且不新增依赖（红线）→ PRD 授权降级方案：DATA_DIR/exports/wiki-<ts>/
 * 落盘目录（manifest.json + entries/<id>.md 副本），同 reports.ts 日报的「平台自产推式出口」豁免模式。
 */

export interface CorpusFingerprint {
  filesCount: number
  maxFileId: number
}

export interface WikiExportManifest {
  version: string
  generatedAt: string
  entryCount: number
  missingEntries: number
  corpusFingerprint: CorpusFingerprint
  entries: Array<{ id: number, title: string, sha256: string | null }>
}

export interface WikiExportVerifyResult {
  checked: number
  matched: number
  mismatched: Array<{ id: number, expected: string | null, actual: string | null }>
}

export const WIKI_EXPORTS_DIR = path.join(DATA_DIR, 'exports')

/** 语料轻量锚点（PRD 口径）：active files 数 + 最大 id——语料不动则稳定，动了必然漂移 */
export async function computeCorpusFingerprint(db: SqliteDatabase): Promise<CorpusFingerprint> {
  const row = await (await db.prepare("SELECT COUNT(*) AS c, MAX(id) AS m FROM files WHERE status = 'active'")).get() as any
  return { filesCount: Number(row?.c ?? 0), maxFileId: Number(row?.m ?? 0) }
}

/** 词条正文白名单：只读 DATA_DIR/wiki/entries 内的 entry.md（蒸馏产物落点）。
 * 红线：外部挂载词条（file_id NULL）的 entry_path 指向用户目录、可能正是扫描根——越界一律不读，按缺失计。 */
function insideWikiEntriesDir(entryPath: string): boolean {
  const p = path.resolve(entryPath)
  const root = path.join(DATA_DIR, 'wiki', 'entries')
  return p === root || p.startsWith(root + path.sep)
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 单词条内容指纹：读该词条 entry.md 原文（经 wiki_entries_meta.entry_path）算 SHA-256；
 * 文件缺失或路径越界返回 null（manifest 该条 sha256 置 null 并计入 missing，不炸） */
export async function computeEntrySha256(entryId: number): Promise<string | null> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE id = ?')).get(entryId) as any
  if (!row) return null
  if (!insideWikiEntriesDir(String(row.entry_path))) return null
  const buf = await fs.readFile(String(row.entry_path)).catch(() => null)
  return buf ? sha256Hex(buf) : null
}

/** 除 generatedAt 外逐字段一致（幂等锚：entries 按 id 升序 + 固定键序，JSON 串比较即等价深度比较） */
function manifestsEqual(a: WikiExportManifest, b: WikiExportManifest): boolean {
  const { generatedAt: _a, ...restA } = a
  const { generatedAt: _b, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

/** 最近一次导出目录（时间戳目录名字典序 = 时间序），无导出返回 null */
async function latestExportDir(): Promise<string | null> {
  const names = await fs.readdir(WIKI_EXPORTS_DIR).catch(() => [] as string[])
  const sorted = names.filter(n => n.startsWith('wiki-')).sort()
  return sorted.length ? path.join(WIKI_EXPORTS_DIR, sorted[sorted.length - 1]) : null
}

function relToDataDir(absDir: string): string {
  return path.relative(DATA_DIR, absDir)
}

/**
 * 冻结当前 wiki 语料：manifest.json + entries/<id>.md 副本落 DATA_DIR/exports/wiki-<ts>/。
 * 幂等锚：同语料（manifest 除 generatedAt 外逐字段一致）重复导出复用最近一次目录，不新建。
 * 导出目录边界：DATA_DIR 是平台自产数据目录，默认不在任何启用扫描根内（扫描根是用户内容目录），
 * 导出物是推式出口而非采集对象（同 reports.ts 日报豁免）；但若用户把扫描根配进 server/data，
 * 宁可拒绝导出也不让平台产物混进采集面。
 */
export async function exportWiki(): Promise<{ dir: string, reused: boolean, manifest: WikiExportManifest }> {
  const db = await getDb()
  if (await withinScanRoots(db, path.resolve(WIKI_EXPORTS_DIR))) {
    throw new Error('导出目录落在已启用扫描根内，拒绝导出（请勿将 server/data 配置为扫描根）')
  }
  const fingerprint = await computeCorpusFingerprint(db)
  // B1 口径：只导蒸馏词条（file_id 非空，正文在 DATA_DIR/wiki/entries/<fileId>/entry.md）；
  // title 取库内原始值（不过 A3 formatter——指纹管库里是什么，展示格式化是读侧的事）
  const rows = await (await db.prepare(
    'SELECT id, title, entry_path FROM wiki_entries_meta WHERE file_id IS NOT NULL ORDER BY id ASC'
  )).all() as any[]
  const entries: WikiExportManifest['entries'] = []
  const contents: Array<{ id: number, buf: Buffer }> = []
  for (const r of rows) {
    const id = Number(r.id)
    let sha: string | null = null
    if (insideWikiEntriesDir(String(r.entry_path))) {
      const buf = await fs.readFile(String(r.entry_path)).catch(() => null)
      if (buf) { sha = sha256Hex(buf); contents.push({ id, buf }) }
    }
    entries.push({ id, title: String(r.title ?? ''), sha256: sha })
  }
  const manifest: WikiExportManifest = {
    version: '0.1.5',
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    missingEntries: entries.filter(e => e.sha256 === null).length,
    corpusFingerprint: fingerprint,
    entries
  }
  const latest = await latestExportDir()
  if (latest) {
    const prevRaw = await fs.readFile(path.join(latest, 'manifest.json'), 'utf8').catch(() => null)
    if (prevRaw && manifestsEqual(JSON.parse(prevRaw) as WikiExportManifest, manifest)) {
      return { dir: relToDataDir(latest), reused: true, manifest: JSON.parse(prevRaw) }
    }
  }
  const exportsDir = path.resolve(WIKI_EXPORTS_DIR)
  let dirName = `wiki-${new Date().toISOString().replace(/[:.]/g, '-')}`
  // 同毫秒碰撞守卫：目录已存在则追加序号——否则同 ms 两次异语料导出会静默覆盖前一份冻结产物
  for (let n = 2; await fs.stat(path.join(exportsDir, dirName)).then(() => true, () => false); n++) {
    dirName = `wiki-${new Date().toISOString().replace(/[:.]/g, '-')}-${n}`
  }
  const target = path.join(exportsDir, dirName)
  await fs.mkdir(path.join(target, 'entries'), { recursive: true })
  for (const c of contents) await fs.writeFile(path.join(target, 'entries', `${c.id}.md`), c.buf)
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { dir: relToDataDir(target), reused: false, manifest }
}

/** 导出后校验：重算该导出目录全部 entries 副本的 SHA-256 对照 manifest
 * （B1 验收「导出后任取 20 词条重算一致率」的自动化；expected null 的缺失条目以「副本仍不存在」为一致） */
export async function verifyWikiExport(absDir: string): Promise<WikiExportVerifyResult> {
  const manifest = JSON.parse(await fs.readFile(path.join(absDir, 'manifest.json'), 'utf8')) as WikiExportManifest
  const result: WikiExportVerifyResult = { checked: 0, matched: 0, mismatched: [] }
  for (const e of manifest.entries ?? []) {
    result.checked++
    const buf = await fs.readFile(path.join(absDir, 'entries', `${e.id}.md`)).catch(() => null)
    const actual = buf ? sha256Hex(buf) : null
    if (actual === e.sha256) result.matched++
    else result.mismatched.push({ id: e.id, expected: e.sha256, actual })
  }
  return result
}
