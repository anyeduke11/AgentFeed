import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import crypto from 'crypto'

// v0.1.5 B1 可复现导出 + 内容指纹契约测试（wiki.ts 的 /export 与 /export/verify 端点）。
// WHY：导出是「第三方可验证我们声称门禁+蒸馏过」的对外承诺——manifest 逐字段确定（幂等复用锚的前提）、
// sha256 必须对应词条原文（指纹管库里是什么）、语料漂移必须换新目录（导出即冻结才有证明力）、
// verify 重算一致率（篡改必须可发现）、dir 白名单（verify 读磁盘，绝不能变成任意目录读取口）。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 reports.test.ts 模式），绝不误伤生产 server/data。
// 用例顺序有依赖（同一临时库）：幂等/漂移/missing 用例消费前序用例的导出状态。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-wiki-export-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb, DATA_DIR } = await import('../src/db.js')
const { wikiRouter } = await import('../src/routes/wiki.js')
const { computeEntrySha256, computeCorpusFingerprint } = await import('../src/exportWiki.js')

// 端到端走真实 express：路由注册顺序（/export 必须先于 /:fileId 命中）只有挂载后才可验证
const app = express()
app.use(express.json())
app.use('/api/wiki', wikiRouter)
const server = http.createServer(app)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

const getJson = async (url: string) => {
  const r = await fetch(`${base}${url}`)
  return { status: r.status, json: await r.json().catch(() => null) as any }
}
const postJson = async (url: string, body: unknown) => {
  const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => null) as any }
}
const shaOf = async (fp: string) => {
  const buf = await fs.readFile(fp)
  return crypto.createHash('sha256').update(buf).digest('hex')
}
const countExportDirs = async () => {
  const names = await fs.readdir(path.join(DATA_DIR, 'exports')).catch(() => [] as string[])
  return names.filter(n => n.startsWith('wiki-')).length
}

let fileSeq = 0
/** 种一个蒸馏词条：files 行 + entry.md 落盘（生产路径形态 DATA_DIR/wiki/entries/<fileId>/entry.md）+ meta 行 */
async function seedDistilledEntry(title: string, md: string): Promise<number> {
  const db = await getDb()
  fileSeq += 1
  const fr = await (await db.prepare(
    "INSERT INTO files (path, name, ext, title, status, llm_state) VALUES (?, ?, '.md', ?, 'active', 'done')"
  )).run([path.join(DATA_TMP, 'roots', `f${fileSeq}.md`), `f${fileSeq}.md`, title])
  const entryPath = path.join(DATA_DIR, 'wiki', 'entries', String(fr.lastID), 'entry.md')
  await fs.mkdir(path.dirname(entryPath), { recursive: true })
  await fs.writeFile(entryPath, md, 'utf8')
  const mr = await (await db.prepare(
    'INSERT INTO wiki_entries_meta (file_id, entry_path, title, summary) VALUES (?, ?, ?, ?)'
  )).run([Number(fr.lastID), entryPath, title, '摘要占位'])
  return Number(mr.lastID)
}

const metaIds: number[] = []
let firstDir = ''
let firstManifest: any = null
let driftDir = ''

test('导出冻结：3 词条 → entryCount=3、entries 按 id 升序、sha256 非空且与原文/副本一致（WHY：第三方按 manifest 校验的前提是它确定且完整）', async () => {
  // 倒序种（C/B/A）：钉死「升序来自 ORDER BY id」而非插入顺序
  metaIds.push(await seedDistilledEntry('词条 C', '# 词条 C\n\n正文 C\n'))
  metaIds.push(await seedDistilledEntry('词条 B', '# 词条 B\n\n正文 B\n'))
  metaIds.push(await seedDistilledEntry('词条 A', '# 词条 A\n\n正文 A\n'))
  const { status, json } = await getJson('/api/wiki/export')
  assert.equal(status, 200)
  assert.equal(json.success, true)
  assert.equal(json.reused, false)
  assert.ok(json.dir.startsWith('exports/wiki-'), 'dir 必须是 exports/wiki- 相对路径')
  firstDir = json.dir
  firstManifest = json.manifest
  assert.equal(json.manifest.version, '0.1.5')
  assert.equal(json.manifest.entryCount, 3)
  assert.equal(json.manifest.missingEntries, 0)
  assert.equal(json.manifest.corpusFingerprint.filesCount, 3, '语料锚点 filesCount=active files 数')
  assert.ok(json.manifest.corpusFingerprint.maxFileId >= metaIds.length)
  const entryIds: number[] = json.manifest.entries.map((e: any) => e.id)
  assert.deepEqual(entryIds, [...entryIds].sort((a, b) => a - b), 'entries 必须按 id 升序（确定性是幂等锚的前提）')
  // 指纹口径双向钉死：manifest sha256 == computeEntrySha256 == 导出副本实际哈希
  for (const e of json.manifest.entries) {
    assert.match(e.sha256, /^[0-9a-f]{64}$/, '每条 sha256 必须是完整 hex 摘要')
    assert.equal(e.sha256, await computeEntrySha256(e.id), 'manifest 指纹必须与单条计算入口一致')
    assert.equal(e.sha256, await shaOf(path.join(DATA_DIR, json.dir, 'entries', `${e.id}.md`)), '导出副本必须与指纹一致')
  }
})

test('幂等锚：同语料立即再导出 → 返回同一 dir 且不新建目录（WHY：同语料反复导出必须收敛到同一冻结产物，下游引用才稳定）', async () => {
  const before = await countExportDirs()
  const { status, json } = await getJson('/api/wiki/export')
  assert.equal(status, 200)
  assert.equal(json.success, true)
  assert.equal(json.reused, true)
  assert.equal(json.dir, firstDir)
  assert.equal(json.manifest.entryCount, firstManifest.entryCount)
  assert.equal(await countExportDirs(), before, '幂等复用不得新建目录')
})

test('语料漂移：改一个 entry.md 再导出 → 新目录且对应 sha256 变化（WHY：指纹必须对内容变化敏感，「导出即冻结」才有证明力）', async () => {
  const db = await getDb()
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE id = ?')).get(metaIds[0]) as any
  await fs.writeFile(String(row.entry_path), '# 词条 C（改写）\n\n正文 C 已改写\n', 'utf8')
  const before = await countExportDirs()
  const { status, json } = await getJson('/api/wiki/export')
  assert.equal(status, 200)
  assert.equal(json.reused, false)
  assert.notEqual(json.dir, firstDir)
  driftDir = json.dir
  assert.equal(await countExportDirs(), before + 1, '语料变化必须新建目录')
  const old = firstManifest.entries.find((e: any) => e.id === metaIds[0])
  const neu = json.manifest.entries.find((e: any) => e.id === metaIds[0])
  assert.notEqual(neu.sha256, old.sha256, '被改词条的 sha256 必须变化')
  const untouched = json.manifest.entries.find((e: any) => e.id === metaIds[1])
  assert.equal(untouched.sha256, firstManifest.entries.find((e: any) => e.id === metaIds[1]).sha256, '未改词条指纹保持稳定')
})

test('verify：未篡改 matched=checked；篡改一个副本 → mismatched 含该 id（WHY：这是「导出后重算一致率」验收的自动化，篡改必须可发现）', async () => {
  const ok = await postJson('/api/wiki/export/verify', { dir: driftDir })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.success, true)
  assert.equal(ok.json.checked, 3)
  assert.equal(ok.json.matched, 3)
  assert.deepEqual(ok.json.mismatched, [])
  // 篡改导出副本（不动源 entry.md，验证的就是冻结产物本身的完整性）
  const victimId = metaIds[2]
  await fs.writeFile(path.join(DATA_DIR, driftDir, 'entries', `${victimId}.md`), '# 被篡改的副本\n', 'utf8')
  const bad = await postJson('/api/wiki/export/verify', { dir: driftDir })
  assert.equal(bad.status, 200)
  assert.equal(bad.json.checked, 3)
  assert.equal(bad.json.matched, 2)
  assert.deepEqual(bad.json.mismatched.map((m: any) => m.id), [victimId])
  assert.equal(bad.json.mismatched[0].expected.length, 64)
})

test('verify dir 白名单：../ 穿越、非 exports 前缀、多段路径全拒绝（WHY：verify 读磁盘，dir 绝不能变成任意目录读取口）', async () => {
  const cases = ['exports/wiki-a/../../app.db', '../exports/wiki-x', '/etc', 'reports/daily', 'exports\\wiki-x', '']
  for (const dir of cases) {
    const r = await postJson('/api/wiki/export/verify', { dir })
    assert.equal(r.status, 400, `dir=${JSON.stringify(dir)} 必须被白名单拒绝`)
  }
  // 形状合法但目录不存在 → 404（缺 manifest 不误报为校验失败）
  const miss = await postJson('/api/wiki/export/verify', { dir: 'exports/wiki-nonexistent' })
  assert.equal(miss.status, 404)
})

test('missing：删一个 entry.md 再导出 → missingEntries=1 且不炸（WHY：词条文件缺失是常态，导出必须降级记录缺失而非中断）', async () => {
  const db = await getDb()
  const row = await (await db.prepare('SELECT entry_path FROM wiki_entries_meta WHERE id = ?')).get(metaIds[1]) as any
  await fs.rm(String(row.entry_path))
  const { status, json } = await getJson('/api/wiki/export')
  assert.equal(status, 200)
  assert.equal(json.success, true)
  assert.equal(json.manifest.entryCount, 3, 'entries 数组仍含全部词条，缺失只计入 missingEntries')
  assert.equal(json.manifest.missingEntries, 1)
  const miss = json.manifest.entries.find((e: any) => e.id === metaIds[1])
  assert.equal(miss.sha256, null, '缺失条目 sha256 置 null 不炸')
  assert.equal(await fs.stat(path.join(DATA_DIR, json.dir, 'entries', `${metaIds[1]}.md`)).then(() => true, () => false), false, '缺失条目不落副本')
})

test('扫描根守卫：导出目录落入启用扫描根 → 拒绝导出（WHY：平台产物不是采集对象，混进采集面即破坏「导出即冻结」的边界）', async () => {
  const db = await getDb()
  await (await db.prepare('INSERT INTO scan_roots (path, enabled) VALUES (?, 1)')).run([DATA_DIR])
  try {
    const { status, json } = await getJson('/api/wiki/export')
    assert.equal(status, 500)
    assert.equal(json.success, false)
  } finally {
    await (await db.prepare('DELETE FROM scan_roots WHERE path = ?')).run([DATA_DIR])
  }
  // 解除后导出恢复可用
  const ok = await getJson('/api/wiki/export')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.success, true)
})

test('computeCorpusFingerprint：口径为 active files（WHY：锚点漂移必须反映语料增删，deleted 文件不算）', async () => {
  const db = await getDb()
  const fp = await computeCorpusFingerprint(db)
  assert.equal(fp.filesCount, 3)
  const maxRow = await (await db.prepare("SELECT MAX(id) AS m FROM files WHERE status = 'active'")).get() as any
  assert.equal(fp.maxFileId, Number(maxRow.m))
})
