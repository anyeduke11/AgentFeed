import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { isPrivateIp, checkUrlSyntax, assertPublicUrl } from '../src/webclip/ssrf.js'

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
