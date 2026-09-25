import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { isPrivateIp, checkUrlSyntax, assertPublicUrl } from '../src/webclip/ssrf.js'
import { slugify, buildDocBase, reserveBase } from '../src/webclip/naming.js'
import { htmlToMarkdown, rewriteSnapshot } from '../src/webclip/convert.js'
import { yamlSafe, commentSafe } from '../src/webclip/sanitize.js'
import { htmlToMarkdown as mdWith, type ImgFilterConfig } from '../src/webclip/convert.js'

// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 domainDedupGate.test.ts 模式），绝不误伤生产 server/data/app.db。
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-webclip-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')
// 注意：getImageFilter 走动态 import——routes/webclip.js 静态引用 db.ts，后者在模块顶层读 AGENTFEED_DATA_DIR，
// ESM 静态 import 会被提升到 env 赋值之前执行，导致测试连上生产 server/data/app.db（已被污染过一次，勿回退）。
const { convertCore, retryRecord, getLimits, validateStorageRoot, WebclipError, getImageFilter } = await import('../src/routes/webclip.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

const FIXTURE = `<!doctype html><html><head><title>测试页</title></head><body>
<nav>导航噪声</nav><article><h1>标题一</h1><p>段落 <strong>重点</strong> 与 <a href="/rel">链接</a>。</p>
<img src="/img/a.png" alt="图A"><img src="data:image/png;base64,xxx" alt="内嵌图">
<pre><code>const x = 1</code></pre><blockquote>引用文本</blockquote></article>
<footer>页脚噪声</footer></body></html>`

// ---- 图片质量过滤（微信文章宣传图剔除，默认开启）----
const WX = (body: string) => `<html><head><title>微信文章</title></head><body><article>${body}</article></body></html>`

// 测试辅助：落一条 failed 记录并返回行 id（retry「原行复用」验证的基座）
async function createFailedRecord(url: string, code: string, msg: string): Promise<number> {
  const db = await getDb()
  const esc = (s: string) => s.replace(/'/g, "''")
  await db.exec(`INSERT INTO webclip_records (url, status, snapshot, error) VALUES ('${esc(url)}', 'failed', 0, '${esc(`[${code}] ${msg}`)}')`)
  const row = await (await db.prepare('SELECT last_insert_rowid() AS id')).get() as any
  return Number(row.id)
}

// runScan 假体：模拟扫描器把剪藏根下落盘的 md/html 登记进 files 表——convertCore「await 扫描后回填 file_id」契约的测试替身
async function fakeScanIntoFiles(root: string) {
  const db = await getDb()
  for (const name of fs.readdirSync(root)) {
    if (!/\.(md|html)$/.test(name)) continue
    const p = path.join(root, name).replace(/'/g, "''")
    await db.exec(`INSERT OR IGNORE INTO files (path, name, ext, source_agent) VALUES ('${p}', '${name.replace(/'/g, "''")}', '${name.split('.').pop()}', 'webclip')`)
  }
}

// 本文件用例共享同一临时库且存在前后依赖（seed 断言 ↔ convertCore upsert、dup 行 ↔ force 重跑），
// node:test 顶层用例默认并发会打乱顺序——describe 内用例按注册序串行执行（同 reader.test.ts 模式）。
describe('webclip 套件（用例间共享临时库，串行执行）', () => {
  test('webclip: webclip_records 表存在且含关联列', async () => {
    const db = await getDb()
    const rows = await (await db.prepare("PRAGMA table_info('webclip_records')")).all() as any[]
    const cols = new Set(rows.map(r => r.name))
    for (const c of ['id', 'url', 'title', 'slug_ts', 'md_path', 'html_path', 'md_file_id', 'html_file_id', 'status', 'snapshot', 'error', 'duration_ms', 'created_at']) {
      assert.ok(cols.has(c), `缺列 ${c}`)
    }
  })

  test('webclip: config 默认键 webclip.storageRoot 已 seed', async () => {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value, type FROM config WHERE key = 'webclip.storageRoot'")).get() as any
    assert.ok(row, 'config 键缺失')
    assert.equal(row.type, 'string')
    assert.equal(row.value, '')
  })

  test('webclip/ssrf: 私网/保留段 IP 全拒（fail-closed）', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '999.1.1.1', '::1', 'fe80::1', 'fd00::1', 'garbage']) {
      assert.ok(isPrivateIp(ip), `${ip} 应判私网`)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '93.184.216.34']) {
      assert.ok(!isPrivateIp(ip), `${ip} 应判公网`)
    }
  })

  test('webclip/ssrf: 语法层拒绝非 http/带凭据/本地域名', () => {
    for (const bad of ['ftp://a.com', 'file:///etc/passwd', 'http://u:p@a.com/', 'http://localhost/x', 'http://a.local/x', 'not a url']) {
      assert.throws(() => checkUrlSyntax(bad), /ssrf|仅支持|不允许|URL/i, `${bad} 应被拒`)
    }
    const u = checkUrlSyntax('https://example.com/a?b=1')
    assert.equal(u.hostname, 'example.com')
  })

  test('webclip/ssrf: assertPublicUrl 拒绝解析失败域名（fail-closed）', async () => {
    await assert.rejects(() => assertPublicUrl('https://this-domain-definitely-not-exist-xyz.invalid/'), /解析失败|ssrf/)
  })

  test('webclip/naming: slugify 保留中英与连字符', () => {
    assert.equal(slugify('Hello World / 测试: 2026!'), 'hello-world-测试-2026')
    assert.equal(slugify('   '), 'untitled')
    assert.equal(slugify('a'.repeat(100)).length, 40)
  })

  test('webclip/naming: buildDocBase 时区无关（本地分量构造）', () => {
    const d = new Date(2026, 8, 24, 15, 30, 12)
    assert.equal(buildDocBase('Hello', d), '20260924-153012-hello')
  })

  test('webclip/config: validateStorageRoot 三态（幂等/嵌套/占用）', async () => {
    const db = await getDb()
    const a = path.join(DATA_TMP, 'root-a'); await fsp.mkdir(a, { recursive: true })
    assert.equal(await validateStorageRoot(db, a), null)                       // 空白场景放行
    await db.exec(`INSERT INTO scan_roots (path, agent) VALUES ('${a.replace(/'/g, "''")}', 'webclip')`)
    assert.equal(await validateStorageRoot(db, a), null)                       // 自身 webclip 根幂等放行
    const nested = path.join(a, 'sub')
    assert.match(String(await validateStorageRoot(db, nested)), /嵌套/)         // 子路径拒绝
    assert.match(String(await validateStorageRoot(db, DATA_TMP)), /嵌套/)       // 父路径拒绝
    const occupied = path.join(DATA_TMP, 'occupied')
    await db.exec(`INSERT INTO scan_roots (path, agent) VALUES ('${occupied.replace(/'/g, "''")}', NULL)`)
    assert.match(String(await validateStorageRoot(db, occupied)), /已是其他扫描根/)
  })

  test('webclip/naming: reserveBase 磁盘冲突加序号', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webclip-'))
    fs.writeFileSync(path.join(dir, '20260924-153012-a.md'), 'x')
    assert.equal(reserveBase(dir, '20260924-153012-a'), '20260924-153012-a-2')
    fs.writeFileSync(path.join(dir, '20260924-153012-a-2.md'), 'x')
    assert.equal(reserveBase(dir, '20260924-153012-a'), '20260924-153012-a-3')
  })

  test('webclip/convert: 正文提取为 md，噪声剔除，图片收占位符', () => {
    const { title, markdown, images } = htmlToMarkdown(FIXTURE, 'https://example.com/post/')
    assert.equal(title, '测试页')
    assert.ok(markdown.includes('# 标题一'))
    assert.ok(markdown.includes('**重点**'))
    assert.ok(markdown.includes('[链接](https://example.com/rel)'))
    assert.ok(markdown.includes('![图A](__WEBCLIP_IMG_0__)'))
    assert.ok(markdown.includes('```'))
    assert.ok(markdown.includes('> 引用文本'))
    assert.ok(!markdown.includes('导航噪声'))
    assert.ok(!markdown.includes('页脚噪声'))
    // data: 协议不是 http(s) 资源，不收集
    assert.equal(images.length, 1)
    assert.equal(images[0].absUrl, 'https://example.com/img/a.png')
  })

  test('webclip/convert: 空正文兜底不抛错', () => {
    const { markdown } = htmlToMarkdown('<html><body><div></div></body></html>', 'https://a.com/')
    assert.ok(markdown.includes('未能从页面提取正文'))
  })

  test('webclip/convert: rewriteSnapshot 已下载图改相对路径，未下载图移除保 alt', () => {
    const out = rewriteSnapshot(FIXTURE, 'https://example.com/post/', new Map([['https://example.com/img/a.png', 'assets/b/img-0.png']]))
    assert.ok(out.includes('src="assets/b/img-0.png"'))
    assert.ok(!out.includes('data:image'))
    assert.ok(out.includes('[内嵌图]'))
  })

  test('webclip/imgfilter: URL/alt 关键词命中即丢弃（二维码、关注引导）', () => {
    const f: ImgFilterConfig = { enabled: true, minPx: 80, maxRatio: 4, minBytes: 1024, urlKeywords: ['qrcode', '二维码'], altKeywords: ['点击关注', '公众号'] }
    const { images, markdown } = mdWith(WX(`
    <p>正文一段。</p>
    <img src="https://m.example.com/qrcode/abc.png" alt="我的二维码" />
    <img src="https://m.example.com/normal.png" alt="点击关注我们" />
    <img src="https://m.example.com/content-1.png" alt="架构图" />
  `), 'https://mp.example.com/x', 30, f)
    assert.equal(images.length, 1)
    assert.equal(images[0].absUrl, 'https://m.example.com/content-1.png')
    assert.ok(!markdown.includes('qrcode'))
    assert.ok(!markdown.includes('点击关注'))
  })

  test('webclip/imgfilter: 尺寸属性判定——小图标按 minPx 丢、横幅按宽高比丢、无属性不猜', () => {
    const f: ImgFilterConfig = { enabled: true, minPx: 80, maxRatio: 4, minBytes: 1024, urlKeywords: [], altKeywords: [] }
    const { images } = mdWith(WX(`
    <img src="https://a.com/i/icon.png" width="32" height="32" alt="图标" />
    <img src="https://a.com/i/banner.png" data-w="640" style="height:100px" alt="横幅" />
    <img src="https://a.com/i/noattr.png" alt="无属性图" />
    <img src="https://a.com/i/body.png" data-w="1080" alt="微信正文图" />
  `), 'https://a.com/x', 30, f)
    // 32×32 图标丢（任一维 < minPx）；640×100 横幅丢（宽高比 6.4 > 4）；无属性保留（不猜）；1080 宽正文图保留
    assert.deepEqual(images.map(i => i.absUrl), ['https://a.com/i/noattr.png', 'https://a.com/i/body.png'])
  })

  test('webclip/imgfilter: 关闭开关全部放行（含明显二维码）', () => {
    const f: ImgFilterConfig = { enabled: false, minPx: 80, maxRatio: 4, minBytes: 1024, urlKeywords: ['qrcode'], altKeywords: [] }
    const { images } = mdWith(WX(`<img src="https://a.com/qrcode.png" width="30" height="30" alt="码" />`), 'https://a.com/x', 30, f)
    assert.equal(images.length, 1)
  })

  test('webclip/imgfilter: 默认（不传 filter）行为不变——全部收集', () => {
    const { images } = mdWith(WX(`<img src="https://a.com/qrcode.png" width="30" height="30" alt="码" />`), 'https://a.com/x')
    assert.equal(images.length, 1)
  })

  test('webclip/imgfilter: config 默认键已 seed 且 getImageFilter 合并默认', async () => {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value, type FROM config WHERE key = 'webclip.imageFilter'")).get() as any
    assert.ok(row, 'webclip.imageFilter 未 seed')
    assert.equal(row.type, 'json')
    const parsed = JSON.parse(row.value)
    assert.equal(parsed.enabled, true)
    assert.equal(parsed.minPx, 80)
    const f = await getImageFilter()
    assert.equal(f.enabled, true)
    assert.ok(f.urlKeywords.includes('qrcode'))
  })

  test('webclip/sanitize: yamlSafe 双引号包裹并转义换行/引号/反斜杠', () => {
    assert.equal(yamlSafe('https://a.com/x'), '"https://a.com/x"')
    assert.equal(yamlSafe('a\r\ninjected: true'), '"a injected: true"')
    assert.equal(yamlSafe('say "hi"'), '"say \\"hi\\""')
    assert.equal(yamlSafe('b\\c'), '"b\\\\c"')
  })

  test('webclip/sanitize: commentSafe 破坏换行与 --> 序列', () => {
    assert.equal(commentSafe('a\nb --> c'), 'a b - - > c')
    assert.equal(commentSafe('x-->y'), 'x- - >y')
  })

  test('webclip/ssrf: IPv6 十六进制映射与 fe80::/10 全段（M2 加固）', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:0a00:1', 'fe80::1', 'febf::1', 'ff02::1', 'fd00::1', '::ffff:127.0.0.1']) {
      assert.ok(isPrivateIp(ip), `${ip} 应判私网`)
    }
    for (const ip of ['::ffff:8.8.8.8', '2001:db8::1', 'fec0::1']) {
      assert.ok(!isPrivateIp(ip), `${ip} 应判公网`)
    }
  })

  test('webclip/core: convertCore 走注入 fetcher，dup/force 语义正确', async () => {
    const db = await getDb()
    const root = path.join(DATA_TMP, 'clip-root'); await fsp.mkdir(root, { recursive: true })
    await db.exec(`INSERT OR IGNORE INTO scan_roots (path, agent) VALUES ('${root.replace(/'/g, "''")}', 'webclip')`)
    // storageRoot 键已被 seedDefaults 预置为空串，INSERT OR IGNORE 会跳过——用 upsert 真正写入
    await db.exec(`INSERT INTO config (key, value, type) VALUES ('webclip.storageRoot', '${root.replace(/'/g, "''")}', 'string')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    const fake = async () => ({ html: '<html><head><title>核心页</title></head><body><article><h1>核心页</h1><p>正文</p></article></body></html>', finalUrl: 'https://core.example/' })
    const deps = { renderPage: fake, runScan: async () => { await fakeScanIntoFiles(root) }, assertPublicUrl: async () => {} } // fetcher/scan/SSRF 全注入，「不触网」
    const r1 = await convertCore('https://core.example/a', { snapshot: true }, deps)
    assert.equal(r1.success, true); assert.ok(r1.mdFileId); assert.ok(r1.htmlFileId); assert.ok(r1.title)
    // dup 语义：成功记录在路由层写入（convertCore 不写库），此处手动落一条成功行再验证拒绝
    await db.exec(`INSERT INTO webclip_records (url, title, slug_ts, md_path, status, snapshot) VALUES ('https://core.example/a', '核心页', 'x', 'x', 'success', 1)`)
    await assert.rejects(() => convertCore('https://core.example/a', {}), (e: any) => e instanceof WebclipError && e.code === 'dup')
    const r2 = await convertCore('https://core.example/a', { force: true }, deps)
    assert.equal(r2.success, true)
    // 磁盘两对文档（force 新时间戳基名），不覆盖
    const filesOnDisk = fs.readdirSync(root).filter((f: string) => f.endsWith('.md'))
    assert.equal(filesOnDisk.length, 2)
  })

  test('webclip/retry: retryRecord 把 failed 记录更新为 success（原行复用）', async () => {
    const db = await getDb()
    const fake = async () => ({ html: '<html><head><title>重试页</title></head><body><article><p>正文</p></article></body></html>', finalUrl: 'https://core.example/' })
    const rootRow = await (await db.prepare("SELECT value FROM config WHERE key = 'webclip.storageRoot'")).get() as any
    const root = String(rootRow.value)
    const id = await createFailedRecord('https://core.example/retry', 'fetch', '模拟失败')
    const r = await retryRecord(id, { renderPage: fake, runScan: async () => { await fakeScanIntoFiles(root) }, assertPublicUrl: async () => {} })
    assert.equal(r.success, true)
    const row = await (await db.prepare('SELECT status, md_file_id, error FROM webclip_records WHERE id = ?')).get(id) as any
    assert.equal(row.status, 'success'); assert.ok(row.md_file_id); assert.equal(row.error, null)
  })

  test('webclip/limits: 默认限额 seed + getLimits 合并', async () => {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value, type FROM config WHERE key = 'webclip.limits'")).get() as any
    assert.ok(row, 'webclip.limits 未 seed')
    assert.equal(row.type, 'json')
    const parsed = JSON.parse(row.value)
    assert.equal(parsed.imgMaxCount, 30)
    const limits = await getLimits()
    assert.equal(limits.deadlineMs, 45000)
  })

  test('webclip/convert: htmlToMarkdown 尊重图片上限参数', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<img src="https://a.com/${i}.png" alt="i${i}">`).join('')
    const { images } = htmlToMarkdown(`<html><body><article>${many}</article></body></html>`, 'https://a.com/', 5)
    assert.equal(images.length, 5)
  })
})
