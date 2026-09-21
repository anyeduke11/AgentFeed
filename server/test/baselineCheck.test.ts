import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'url'

// v0.1.5 D1 评估闭环 baseline:check 契约测试。
// WHY：语料漂移后基线重放数字失效无法机械检测——文档头部指纹锚点 + check 三态 exit code
// （0 一致 / 1 漂移 / 2 缺锚）是可被 CI 与人机械消费的契约；任何一态失真都意味着
// 「这份基线还信不信」的判断失真，所以纯函数（锚点解析对坏输入必须返回 null 而非抛错/误判）
// 与 CLI 三态都要钉死。
// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 wikiExport.test.ts 模式），CLI 子进程
// 一律 --db/--doc 显式传临时路径，绝不触碰真实库 server/data/app.db 与真实基线
// docs/search-baseline-2026-10.md。用例顺序有依赖（同一临时库逐步种数据驱动指纹变化）。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.resolve(__dirname, '..')
const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-baseline-check-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
const { extractFingerprintFromDoc, compareFingerprints } = await import('../src/baselineCheckCore.js')

const DB_PATH = path.join(DATA_TMP, 'app.db')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

/** 种一条 active files 行（指纹口径 = active 行数 + 最大 id，与 computeCorpusFingerprint 一致） */
async function seedActiveFile(): Promise<number> {
  const db = await getDb()
  const r = await (await db.prepare(
    "INSERT INTO files (path, name, ext, title, status, llm_state) VALUES (?, ?, '.md', ?, 'active', 'done')"
  )).run([path.join(DATA_TMP, 'roots', `f${Date.now()}-${Math.random()}.md`), 'f.md', '占位标题'])
  return Number(r.lastID)
}

/** execFile 包 Promise 跑 CLI 子进程；exit code 非零时 err.code 即 exit code（number），
 * 进程本身起不来（如 npx 缺失）时 err.code 为字符串 → reject fail loud。 */
function runCli(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('npx', ['tsx', 'scripts/baselineCheck.ts', ...args], { cwd: SERVER_DIR }, (err, stdout, stderr) => {
      if (err && typeof (err as any).code !== 'number') return reject(err)
      resolve({ code: (err ? (err as any).code : 0) as number, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const anchorLine = (fp: { filesCount: number, maxFileId: number }) =>
  `> corpusFingerprint: ${JSON.stringify(fp)} generatedAt: 2026-09-21T00:00:00.000Z`

/* ---------------- 纯函数：extractFingerprintFromDoc ---------------- */

test('extract：正常锚点行（后带 generatedAt 尾巴）解析出指纹', () => {
  const md = `# 检索基线记录（2026-10 裁决对照）\n\n${anchorLine({ filesCount: 3, maxFileId: 9 })}\n\n## 正文：重放\n`
  assert.deepEqual(extractFingerprintFromDoc(md), { filesCount: 3, maxFileId: 9 })
})

test('extract：文档无锚点行（旧版基线）返回 null', () => {
  const md = '# 检索基线记录\n\n## 正文：search_knowledge Top-3 重放\n\n| # | query | Top-1 |\n'
  assert.equal(extractFingerprintFromDoc(md), null)
})

test('extract：坏 JSON 返回 null 而非抛错', () => {
  assert.equal(extractFingerprintFromDoc('> corpusFingerprint: {"filesCount":} generatedAt: 2026-09-21T00:00:00.000Z\n'), null)
})

test('extract：锚点行嵌在多行元信息块中间可提取', () => {
  const md = [
    '# 基线',
    '> 生成于 2026-10-01，query 来源：第 1 级（CLI queries 文件）',
    anchorLine({ filesCount: 21, maxFileId: 126602 }),
    '> 标注说明：hit=精准命中 / partial=部分相关 / miss=不相关',
    ''
  ].join('\n')
  assert.deepEqual(extractFingerprintFromDoc(md), { filesCount: 21, maxFileId: 126602 })
})

test('extract：JSON 合法但形状不对（字符串值 / 缺键 / 非整数）返回 null', () => {
  assert.equal(extractFingerprintFromDoc('> corpusFingerprint: {"filesCount":"3","maxFileId":9} generatedAt: x\n'), null)
  assert.equal(extractFingerprintFromDoc('> corpusFingerprint: {"filesCount":3} generatedAt: x\n'), null)
  assert.equal(extractFingerprintFromDoc('> corpusFingerprint: {"filesCount":3.5,"maxFileId":9} generatedAt: x\n'), null)
})

/* ---------------- 纯函数：compareFingerprints ---------------- */

test('compare：两字段全同 → true；任一字段不同 → false', () => {
  assert.equal(compareFingerprints({ filesCount: 3, maxFileId: 9 }, { filesCount: 3, maxFileId: 9 }), true)
  assert.equal(compareFingerprints({ filesCount: 3, maxFileId: 9 }, { filesCount: 4, maxFileId: 9 }), false)
  assert.equal(compareFingerprints({ filesCount: 3, maxFileId: 9 }, { filesCount: 3, maxFileId: 10 }), false)
})

/* ---------------- CLI 端到端：临时库 + 临时基线 md，三态 exit code ---------------- */

test('CLI 三态：空库一致 0 → 种子后一致 0 → 漂移 1（含前后值）→ 缺锚 2 / 文档不存在 2', async () => {
  // 阶段 1：空库（files 表 0 行）不抛错，指纹 {0,0} 对 {0,0} → 一致 exit 0
  await getDb()
  const docEmpty = path.join(DATA_TMP, 'baseline-empty.md')
  await fs.writeFile(docEmpty, `# 基线\n${anchorLine({ filesCount: 0, maxFileId: 0 })}\n`, 'utf8')
  const r0 = await runCli(['--db', DB_PATH, '--doc', docEmpty])
  assert.equal(r0.code, 0, `空库应一致 exit 0，实际 ${r0.code}\nstdout: ${r0.stdout}\nstderr: ${r0.stderr}`)
  assert.match(r0.stdout, /语料一致，基线有效/)

  // 阶段 2：种 2 条 active → 当前指纹 {2, maxId}，文档锚点一致 → exit 0
  await seedActiveFile()
  const maxId = await seedActiveFile()
  const docTwo = path.join(DATA_TMP, 'baseline-two.md')
  await fs.writeFile(docTwo, `# 基线\n${anchorLine({ filesCount: 2, maxFileId: maxId })}\n`, 'utf8')
  const r2 = await runCli(['--db', DB_PATH, '--doc', docTwo])
  assert.equal(r2.code, 0, `一致应 exit 0，实际 ${r2.code}\nstdout: ${r2.stdout}\nstderr: ${r2.stderr}`)
  assert.match(r2.stdout, /语料一致，基线有效/)

  // 阶段 3：再种 1 条（语料 {3, 新 max}）而文档仍写 {2, 旧 max} → 漂移 exit 1，stdout 带前后值与指引
  await seedActiveFile()
  const r3 = await runCli(['--db', DB_PATH, '--doc', docTwo])
  assert.equal(r3.code, 1, `漂移应 exit 1，实际 ${r3.code}\nstdout: ${r3.stdout}\nstderr: ${r3.stderr}`)
  assert.match(r3.stdout, /基线已漂移，请重跑 searchBaseline 重放并更新基线/)
  assert.match(r3.stdout, /基线指纹：\{"filesCount":2,"maxFileId":\d+\}/)
  assert.match(r3.stdout, /当前指纹：\{"filesCount":3,"maxFileId":\d+\}/)

  // 阶段 4a：文档存在但无锚点行（旧版基线）→ exit 2
  const docNoAnchor = path.join(DATA_TMP, 'baseline-old.md')
  await fs.writeFile(docNoAnchor, '# 检索基线记录（2026-10 裁决对照）\n\n## 正文：重放\n', 'utf8')
  const r4 = await runCli(['--db', DB_PATH, '--doc', docNoAnchor])
  assert.equal(r4.code, 2, `缺锚应 exit 2，实际 ${r4.code}\nstdout: ${r4.stdout}\nstderr: ${r4.stderr}`)
  assert.match(r4.stdout, /基线文档缺失指纹锚点（旧版基线），请重跑 searchBaseline 生成/)

  // 阶段 4b：文档不存在 → exit 2
  const r5 = await runCli(['--db', DB_PATH, '--doc', path.join(DATA_TMP, 'no-such-doc.md')])
  assert.equal(r5.code, 2, `文档不存在应 exit 2，实际 ${r5.code}\nstdout: ${r5.stdout}\nstderr: ${r5.stderr}`)
  assert.match(r5.stdout, /基线文档缺失指纹锚点（旧版基线），请重跑 searchBaseline 生成/)
})
