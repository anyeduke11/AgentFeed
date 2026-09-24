import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { isPrivateIp, checkUrlSyntax, assertPublicUrl } from '../src/webclip/ssrf.js'
import { slugify, buildDocBase, reserveBase } from '../src/webclip/naming.js'
import { htmlToMarkdown, rewriteSnapshot } from '../src/webclip/convert.js'
import { yamlSafe, commentSafe } from '../src/webclip/sanitize.js'

// 隔离方式：AGENTFEED_DATA_DIR 指向临时目录（同 domainDedupGate.test.ts 模式），绝不误伤生产 server/data/app.db。
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-webclip-db-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

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

test('webclip/naming: buildDocBase 固定时间戳格式', () => {
  const base = buildDocBase('Hello', new Date('2026-09-24T15:30:12+08:00'))
  assert.equal(base, '20260924-153012-hello')
})

test('webclip/naming: reserveBase 磁盘冲突加序号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webclip-'))
  fs.writeFileSync(path.join(dir, '20260924-153012-a.md'), 'x')
  assert.equal(reserveBase(dir, '20260924-153012-a'), '20260924-153012-a-2')
  fs.writeFileSync(path.join(dir, '20260924-153012-a-2.md'), 'x')
  assert.equal(reserveBase(dir, '20260924-153012-a'), '20260924-153012-a-3')
})

const FIXTURE = `<!doctype html><html><head><title>测试页</title></head><body>
<nav>导航噪声</nav><article><h1>标题一</h1><p>段落 <strong>重点</strong> 与 <a href="/rel">链接</a>。</p>
<img src="/img/a.png" alt="图A"><img src="data:image/png;base64,xxx" alt="内嵌图">
<pre><code>const x = 1</code></pre><blockquote>引用文本</blockquote></article>
<footer>页脚噪声</footer></body></html>`

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
