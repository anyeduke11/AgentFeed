# 网页剪藏 M2 实现计划（含完整代码）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 `- [ ]` 勾选跟踪。
> 范围依据：`docs/superpowers/plans/2026-09-24-web-clip-m2.md`（14 任务 → 本计划归并为 6 个实施任务 / 4 个派发批次）
> 基线：main @ f7d8ceb，400/400 全绿。落点文件行号以 M1 合并后现状为准（已核对）。

**全局约束（每批派发必带）**：TS ESM / 单引号 / 无分号 / 两空格 / 命名导出 / 相对导入带 `.js`；SQLite 只走幂等迁移（CREATE IF NOT EXISTS + ensureColumns + INSERT OR IGNORE）；响应 `{ success, ... }`；磁盘写入过 `withinScanRoots`；不许 `git add -A`；不许动用户在途文件（chat.ts / chat.test.ts / api.ts chat 组 / SettingsLogs.vue）。

---

### Task 1（P0）：sanitize 模块 + 并发互斥 + IPv6 加固

**Files:**
- Create: `server/src/webclip/sanitize.ts`
- Modify: `server/src/webclip/ssrf.ts:12-27`、`server/src/routes/webclip.ts:74-161`
- Test: `server/test/webclip.test.ts`（追加）

- [ ] **Step 1: RED — 追加测试**

```ts
import { yamlSafe, commentSafe } from '../src/webclip/sanitize.js'

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
```

- [ ] **Step 2: 跑 RED** — `cd server && npx tsx --test test/webclip.test.ts` → sanitize/IPv6 用例 FAIL（模块不存在/漏判）

- [ ] **Step 3: 实现 `server/src/webclip/sanitize.ts`**

```ts
/** YAML 双引号标量转义：剥换行（防注入新键）、转义反斜杠与双引号 */
export function yamlSafe(v: string): string {
  return '"' + String(v).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** HTML 注释安全：剥换行、破坏 "-->" 序列（连字符长串断开） */
export function commentSafe(v: string): string {
  return String(v).replace(/[\r\n]+/g, ' ').replace(/-+(?=>|$)/g, m => m.slice(0, -1) + ' ').replace(/-->/g, '- ->')
}
```

实现者注意：commentSafe 的目标行为 = 输出中不得再出现 `-->`，且不引入换行。上面实现若对 `a\nb --> c` 产出 `a b - - > c` 与用例不符，以用例为准修正实现（先 `-` 长串处理再 `-->` 兜底，顺序可调），但两个用例必须原样通过。

- [ ] **Step 4: ssrf.ts IPv6 分支替换（L13-17）**

```ts
  if (ip.includes(':')) {
    const low = ip.toLowerCase()
    if (low === '::1' || low === '::') return true
    // ::ffff: 点分形式 → 还原 IPv4 判定
    const dotted = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (dotted) return isPrivateIp(dotted[1])
    // ::ffff:十六进制映射（可含 0: 前缀）→ 取前 16 位还原 IPv4 前两段判定
    const hex = low.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const v1 = parseInt(hex[1], 16)
      return isPrivateIp(`${v1 >> 8}.${v1 & 255}.0.0`)
    }
    const h0 = parseInt(low.split(':')[0], 16)
    if (Number.isFinite(h0)) {
      if (h0 >= 0xfe80 && h0 <= 0xfebf) return true // 链路本地 fe80::/10
      if (h0 >= 0xfc00 && h0 <= 0xfdff) return true // ULA fc00::/7
      if (h0 >= 0xff00) return true                 // 组播 ff00::/8
    }
    return false
  }
```

- [ ] **Step 5: webclip.ts 并发互斥（T1）**

5a. L20 STATUS_BY_CODE 追加 `busy: 429`。
5b. L21 附近加模块级锁：`let clipBusy = false`。
5c. POST /convert：url/storageRoot 校验之后、`const esc` 之前插入：

```ts
  if (clipBusy) return res.status(429).json({ success: false, code: 'busy', message: '已有剪藏任务执行中，请稍后再试' })
  clipBusy = true
```

5d. 现有 `try { ... } catch { ... }`（L91-160）改写为 `try { ... } catch { ... } finally { clipBusy = false }`（try/catch 内部逐字不动）。
5e. L141 frontmatter 与 L145 锚点注释改用 sanitize（新 import `import { yamlSafe, commentSafe } from '../webclip/sanitize.js'`）：

```ts
    const fm = ['---', 'agent: webclip', `source_url: ${yamlSafe(String(url))}`, `clipped_at: ${clippedAt}`, ...(snapshot ? [`snapshot: ./${base}.html`] : []), '---', ''].join('\n')
```
```ts
      const anchored = snapHtml.replace('<head>', `<head>\n<!-- AgentFeed webclip: ${base} | source: ${commentSafe(String(url))} | clipped_at: ${clippedAt} -->`)
```

- [ ] **Step 6: GREEN + 回归** — 聚焦测试 PASS；`npx tsc --noEmit` 零错；`npm test -w server` 全绿。

- [ ] **Step 7: Commit** — `git add server/src/webclip/sanitize.ts server/src/webclip/ssrf.ts server/src/routes/webclip.ts server/test/webclip.test.ts && git commit -m "fix: webclip P0——并发互斥 busy/frontmatter 注入清洗/IPv6 私网加固"`

---

### Task 2（P1a）：convertCore 抽取 + retry API + 前端重试

**Files:**
- Modify: `server/src/routes/webclip.ts`、`web/src/components/WebclipPanel.vue`、`web/src/api.ts`（仅 webclip 组）
- Test: `server/test/webclip.test.ts`（追加，deps 注入不触网）

- [ ] **Step 1: RED — convertCore/retry 注入测试**

```ts
test('webclip/core: convertCore 走注入 fetcher，dup/force 语义正确', async () => {
  const db = await getDb()
  const root = path.join(DATA_TMP, 'clip-root'); await fsp.mkdir(root, { recursive: true })
  await db.exec(`INSERT OR IGNORE INTO scan_roots (path, agent) VALUES ('${root.replace(/'/g, "''")}', 'webclip')`)
  await db.exec(`INSERT OR IGNORE INTO config (key, value, type) VALUES ('webclip.storageRoot', '${root.replace(/'/g, "''")}', 'string')`)
  const fake = async () => ({ html: '<html><head><title>核心页</title></head><body><article><h1>核心页</h1><p>正文</p></article></body></html>', finalUrl: 'https://core.example/' })
  const r1 = await convertCore('https://core.example/a', { snapshot: true }, { renderPage: fake, runScan: async () => {} })
  assert.equal(r1.success, true); assert.ok(r1.mdFileId); assert.ok(r1.htmlFileId)
  await assert.rejects(() => convertCore('https://core.example/a', {}), (e: any) => e instanceof WebclipError && e.code === 'dup')
  const r2 = await convertCore('https://core.example/a', { force: true }, { renderPage: fake, runScan: async () => {} })
  assert.equal(r2.success, true)
  // 磁盘两对文档（force 新时间戳基名），不覆盖
  const filesOnDisk = fs.readdirSync(root).filter(f => f.endsWith('.md'))
  assert.equal(filesOnDisk.length, 2)
})

test('webclip/retry: retryRecord 把 failed 记录更新为 success（原行复用）', async () => {
  const db = await getDb()
  const fake = async () => ({ html: '<html><head><title>重试页</title></head><body><article><p>正文</p></article></body></html>', finalUrl: 'https://core.example/' })
  const id = await createFailedRecord('https://core.example/retry', 'fetch', '模拟失败')
  const r = await retryRecord(id, { renderPage: fake, runScan: async () => {} })
  assert.equal(r.success, true)
  const row = await (await db.prepare('SELECT status, md_file_id, error FROM webclip_records WHERE id = ?')).get(id) as any
  assert.equal(row.status, 'success'); assert.ok(row.md_file_id); assert.equal(row.error, null)
})
```

（`convertCore/retryRecord/createFailedRecord/WebclipError` 从 `../src/routes/webclip.js` 导入；`DATA_TMP` 为测试文件既有隔离目录。）

- [ ] **Step 2: 跑 RED** → FAIL（导出不存在）

- [ ] **Step 3: webclip.ts 重构**

3a. convert handler 主体抽为导出函数（records 写入留路由层）：

```ts
export interface ConvertDeps {
  renderPage?: (url: string, timeoutMs?: number) => Promise<{ html: string; finalUrl: string }>
  runScan?: (roots: string[]) => Promise<unknown>
}
export interface ConvertResult { success: true; base: string; mdFileId: number | null; htmlFileId: number | null; durationMs: number; images: number }

export async function convertCore(url: string, opts: { snapshot?: boolean; force?: boolean } = {}, deps: ConvertDeps = {}): Promise<ConvertResult> {
  const t0 = Date.now()
  const snapshot = opts.snapshot !== false
  const render = deps.renderPage ?? renderPage
  const runScan = deps.runScan ?? ((roots: string[]) => scan({ roots, full: false, source: 'webclip' }))
  const db = await getDb()
  const storageRoot = await getStorageRoot()
  if (!storageRoot) throw new WebclipError('config', '未配置剪藏目录，请先在设置页配置')
  // ……原 handler try 块主体逐字搬入（dup 校验→assertPublicUrl→render→限额→convert→门禁→图片→frontmatter/快照→runScan→回填），
  // fail(...) 全部改为 throw（已有 WebclipError 直接保留）；成功 return { success: true, base, mdFileId… }
}
```

注意搬移时的三个差异点：① dup 抛 `new WebclipError('dup', '该 URL 已剪藏成功过；如需重新抓取请勾选「强制重剪」')`；② scan 调用换 `await runScan([storageRoot])`；③ render 换 `await render(String(url), 30000)`。deadline/esc/assertPublicUrl 等保持。

3b. POST /convert 变薄壳：

```ts
webclipRouter.post('/convert', async (req, res) => {
  const { url, snapshot = true, force = false } = req.body as { url?: string; snapshot?: boolean; force?: boolean }
  if (!url) return res.status(400).json({ success: false, message: 'url 必填' })
  if (clipBusy) return res.status(429).json({ success: false, code: 'busy', message: '已有剪藏任务执行中，请稍后再试' })
  clipBusy = true
  try {
    const r = await convertCore(String(url), { snapshot, force })
    await insertSuccessRecord(String(url), r, snapshot)   // 原 success INSERT 搬此，esc/title 逻辑随迁
    res.json(r)
  } catch (e: any) {
    await failRecord(String(url), snapshot, e)
    const code = e instanceof WebclipError ? e.code : 'fetch'
    res.status(STATUS_BY_CODE[code] ?? 500).json({ success: false, code, message: e?.message || String(e) })
  } finally {
    clipBusy = false
  }
})
```

`failRecord(url, snapshot, e)` = 原 fail()（T5 会给它加 code 列）；`insertSuccessRecord` = 原 success INSERT。

3c. retry：

```ts
export async function retryRecord(recordId: number, deps: ConvertDeps = {}): Promise<ConvertResult> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT * FROM webclip_records WHERE id = ?')).get(recordId) as any
  if (!row) throw new WebclipError('config', '记录不存在')
  if (row.status === 'success') throw new WebclipError('dup', '该记录已是成功状态，无需重试')
  const r = await convertCore(String(row.url), { snapshot: !!row.snapshot, force: true }, deps)
  await db.exec(`UPDATE webclip_records SET title='${(r.base && "") || ""}' WHERE id = ${recordId}`) // 占位——实际按下方字段更新
  return r
}
```

实现者注意：UPDATE 用完整字段集（title 从 md 首部 frontmatter 不可得，改为「title 保留原值或空」→ 以 convertCore 返回补充：给 ConvertResult 增加 `title: string`（从核心里 title 变量带出），UPDATE `title/slug_ts/md_path/html_path/md_file_id/html_file_id/status='success'/snapshot/duration_ms/error=NULL`。SQL 值一律走 esc() 转义。

路由端点：

```ts
webclipRouter.post('/records/:id/retry', async (req, res) => {
  const id = parseInt(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id 非法' })
  if (clipBusy) return res.status(429).json({ success: false, code: 'busy', message: '已有剪藏任务执行中，请稍后再试' })
  clipBusy = true
  try {
    const r = await retryRecord(id)
    res.json(r)
  } catch (e: any) {
    const code = e instanceof WebclipError ? e.code : 'fetch'
    if (code !== 'dup' && code !== 'config') await markRetryFailed(id, e) // 重试再失败：原行置 failed
    res.status(STATUS_BY_CODE[code] ?? 500).json({ success: false, code, message: e?.message || String(e) })
  } finally {
    clipBusy = false
  }
})
```

`markRetryFailed(id, e)`：`UPDATE webclip_records SET status='failed', error='${esc(msg)}', duration_ms=NULL WHERE id=${id}`，整体 try/catch 仅 console.error（fail-loud 不崩溃）。

3d. 测试辅助 `createFailedRecord(url, code, msg)`：INSERT failed 行并返回 last_insert_rowid()。

- [ ] **Step 4: 前端重试按钮**

4a. `web/src/api.ts` webclip 组追加：`retry: (id: number) => post(`${base}/webclip/records/${id}/retry`)`（保留既有四方法，只加不减；**不得触碰 chat 组**）。
4b. `WebclipPanel.vue` 历史表失败行（文件列 `<span v-else class="c-dim">—</span>` 处）替换为：

```html
              <button v-else-if="r.status === 'failed'" class="btn xs" :disabled="submitting" @click="retryOne(r)">重试</button>
```

script 追加：

```ts
async function retryOne(r: any) {
  if (submitting.value) return
  submitting.value = true
  lastResult.value = null
  try {
    const res = await api.webclip.retry(r.id)
    lastResult.value = res.success
      ? { ok: true, msg: `重试成功（${res.durationMs ? (res.durationMs / 1000).toFixed(1) : '?'}s），已进入蒸馏队列` }
      : { ok: false, msg: res.message || '重试失败' }
  } catch (e: any) {
    lastResult.value = { ok: false, msg: `重试请求失败：${e?.message || e}` }
  } finally {
    submitting.value = false
    await loadRecords(page.value)
  }
}
```

- [ ] **Step 5: GREEN + 回归 + 构建** — 聚焦 PASS；tsc 零错；`npm test -w server` 全绿；`npm run build -w web` 零错。

- [ ] **Step 6: Commit** — `git add server/src/routes/webclip.ts server/test/webclip.test.ts web/src/api.ts web/src/components/WebclipPanel.vue && git commit -m "feat: webclip convertCore 抽取 + retry API（原行更新）+ 前端重试按钮"`

---

### Task 3（P1b）：code 列失败分类 + 限额 config 可配

**Files:**
- Modify: `server/src/db.ts`（webclip_records 建表块后）、`server/src/webclip/convert.ts:5`、`server/src/webclip/fetcher.ts:13-15,49`、`server/src/routes/webclip.ts`、`web/src/components/WebclipPanel.vue`、`web/src/components/settings/SettingsWebclip.vue`、`web/src/api.ts`
- Test: `server/test/webclip.test.ts`（追加）

- [ ] **Step 1: RED**

```ts
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
```

（`getLimits` 从 `../src/routes/webclip.js` 导入。）

- [ ] **Step 2: 实现**

2a. db.ts：webclip_records CREATE 块后加 `await ensureColumns(db, 'webclip_records', [{ name: 'code', ddl: 'code TEXT' }])`（对齐 chat.ts 惯例）；config seed 数组追加：

```ts
  { key: 'webclip.limits', value: '{"pageMaxMB":20,"imgMaxMB":5,"imgMaxCount":30,"navTimeoutMs":30000,"deadlineMs":45000}', type: 'json', description: '网页剪藏限额（页面MB/单图MB/单页图数/导航ms/总时限ms）' },
```

2b. webclip.ts：

```ts
const DEFAULT_LIMITS = { pageMaxMB: 20, imgMaxMB: 5, imgMaxCount: 30, navTimeoutMs: 30000, deadlineMs: 45000 }
export type WebclipLimits = typeof DEFAULT_LIMITS
export async function getLimits(): Promise<WebclipLimits> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'webclip.limits'")).get() as any
  if (!row?.value) return { ...DEFAULT_LIMITS }
  try { return { ...DEFAULT_LIMITS, ...JSON.parse(String(row.value)) } } catch { return { ...DEFAULT_LIMITS } }
}
```

convertCore 开头 `const limits = await getLimits()`；PAGE_MAX_BYTES/IMG_MAX_BYTES/DEADLINE_MS 常量删除，改用 `limits.pageMaxMB * 1024 * 1024` / `limits.imgMaxMB * 1024 * 1024` / `limits.deadlineMs`；render 调用传 `limits.navTimeoutMs`；htmlToMarkdown 传 `limits.imgMaxCount`。错误文案里的「20MB/5MB/45s」改为模板插值实际限额值。

2c. convert.ts：`export function htmlToMarkdown(html: string, baseUrl: string, imgLimit = IMG_LIMIT)`，`images.length >= imgLimit` 替换 `IMG_LIMIT`（常量保留作默认值）。

2d. webclip.ts 新端点：

```ts
webclipRouter.put('/limits', async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    const next: Record<string, number> = { ...DEFAULT_LIMITS }
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof WebclipLimits)[]) {
      const v = Number(body[k])
      if (Number.isFinite(v) && v > 0) next[k] = v
      else if (body[k] !== undefined) return res.status(400).json({ success: false, message: `${k} 必须为正数` })
    }
    const esc = JSON.stringify(next).replace(/'/g, "''")
    const db = await getDb()
    await db.exec(`UPDATE config SET value = '${esc}', updated_at = CURRENT_TIMESTAMP WHERE key = 'webclip.limits'`)
    res.json({ success: true, limits: next })
  } catch (e: any) {
    console.error('webclip /limits failed', e)
    res.status(500).json({ success: false, message: e?.message || String(e) })
  }
})
```

GET /config 响应追加 `limits: await getLimits()`。failRecord 的 INSERT 加 code 列值（`'${esc(code)}'`）；成功 INSERT 不写 code（默认 NULL）。

2e. api.ts webclip 组追加：`putLimits: (limits: Record<string, number>) => put(`${base}/webclip/limits`, limits)`。
2f. SettingsWebclip.vue：状态行下方加限额编辑行（5 个 `input.inp` number，v-model 绑 `limits` 对象字段，保存按钮调 `api.webclip.putLimits`，成功回读）；webclipCfg 增加 limits 透传（loadWebclipCfg 里 `limits.value = { ...webclipCfg.value.limits }`）。
2g. WebclipPanel.vue 失败行状态格追加分类徽标：`<span class="tagchip" v-if="r.code && r.code !== 'busy'">{{ codeLabel(r.code) }}</span>`，script 加 `const codeLabel = (c: string) => ({ ssrf: 'SSRF拦截', dup: '重复', fetch: '网络', notready: '未就绪', toolarge: '超大', config: '配置', busy: '忙' }[c] || c)`。

- [ ] **Step 3: GREEN + 回归 + 构建**（同前口径）

- [ ] **Step 4: Commit** — `git add server/src/db.ts server/src/webclip/convert.ts server/src/routes/webclip.ts server/test/webclip.test.ts web/src/api.ts web/src/components/WebclipPanel.vue web/src/components/settings/SettingsWebclip.vue && git commit -m "feat: webclip 失败分类 code 列 + 限额 webclip.limits 可配（API+设置 UI）"`

---

### Task 4（P2/P3 收拢）：测试补齐 + 埋点 webclip + polish + 杂项修复

**Files:**
- Modify: `server/src/routes/webclip.ts`（validateStorageRoot 抽取 + isReady/fail 保护）、`server/src/webclip/fetcher.ts`、`server/test/webclip.test.ts`、`web/src/stores/useFilesStore.ts`、`web/src/components/WebclipPanel.vue`、`CLAUDE.md`（仅红线 5 一行）、`docs/web-clip-prd.md`（§6.1 + 变更日志）

- [ ] **Step 1: RED — config 校验纯函数 + 时区修复测试**

```ts
import { validateStorageRoot } from '../src/routes/webclip.js'

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

test('webclip/naming: buildDocBase 时区无关（本地分量构造）', () => {
  const d = new Date(2026, 8, 24, 15, 30, 12)
  assert.equal(buildDocBase('Hello', d), '20260924-153012-hello')
})
```

（替换原时区依赖用例 `webclip/naming: buildDocBase 固定时间戳格式`；validateStorageRoot 校验 PUT /config 改为消费它。）

- [ ] **Step 2: 实现**

2a. webclip.ts：PUT /config 的行循环校验体抽出为 `export async function validateStorageRoot(db: any, rootPath: string): Promise<string | null>`（返回错误消息或 null），PUT handler 消费：`const err = await validateStorageRoot(db, rootPath); if (err) return res.status(400).json({ success: false, message: err })`。
2b. fetcher.ts isReady 兼测浏览器：

```ts
export async function isReady(): Promise<boolean> {
  try {
    const mod: any = await import('playwright')
    return typeof mod.chromium.executablePath === 'function' && !!mod.chromium.executablePath()
  } catch { return false }
}
```

2c. failRecord/markRetryFailed 内 db.exec 包 try/catch：`catch (err) { console.error('webclip record write failed', err) }`（错误响应不受阻）。
2d. useFilesStore.ts：`async function openFile(id: number, source?: string) { return api.files.open(id, source) }`。
2e. WebclipPanel.vue：md/html 按钮与标题点击传 `'webclip'`——标题格改为 `<td class="c-main"><button v-if="r.md_file_id" class="btn xs" @click="files.openFile(r.md_file_id, 'webclip')">{{ r.title || '—' }}</button><template v-else>{{ r.title || '—' }}</template></td>`；md/html 按钮 openFile 第三处同参；polish 四项：`loadRecords` catch 加 `total.value = 0`；`lib-foot` 包 `v-if="records.length"`；成功消息 `${r.images ?? 0}`；末列 th「操作」→「错误」。
2f. CLAUDE.md 红线 5：`` `preview / pool / exec / daily / reader / webclip` ``（并保留原句其余部分）；docs/web-clip-prd.md §6.1 `clipped_at` 行加注「（UTC ISO8601）」，变更日志追加 M2 行（实现完成后由总控补，实现者跳过此条）。

- [ ] **Step 3: GREEN + 回归 + 构建**

- [ ] **Step 4: Commit** — `git add server/src/routes/webclip.ts server/src/webclip/fetcher.ts server/test/webclip.test.ts web/src/stores/useFilesStore.ts web/src/components/WebclipPanel.vue CLAUDE.md && git commit -m "feat: webclip M2 收拢——config 校验函数化/isReady 增强/埋点 source=webclip/polish 四项"`

---

### Task 5：端到端回归（curl 层，服务重启）

**Files:** 无新文件；证据写 `.superpowers/sdd/2026-09-24-web-clip-m2/task5-report.md`

- [ ] 1. `./service.sh restart` → /api/health OK
- [ ] 2. GET /api/webclip/config → 含 `limits` 五字段
- [ ] 3. 图文页剪藏（如 `https://www.iana.org/` 换任一含图公开页，或维基百科条目页）→ success，`ls assets/<base>/` 非空，md 内相对路径 `assets/<base>/img-0.*`，html `src="assets/..."`
- [ ] 4. 并发：两个 convert 同时发 → 一个 success/一个 429 busy
- [ ] 5. retry 闭环：制造一条 failed（剪 `http://127.0.0.1:5188/x` 得 ssrf failed）→ POST /records/:id/retry → 因同 URL 无 success 记录会真实重抓（预期 ssrf 再失败，行更新为 failed 且 error 更新）——若想验证 success 路径改剪可达 URL 先令其失败（如停 Playwright 不现实，可用 toolarge 构造或直接验证 records 行更新逻辑由单测覆盖，e2e 只验 429/图文/常规）
- [ ] 6. GET /records → failed 行含 `code` 字段
- [ ] 7. `npm test -w server` 全绿；`npm run build -w web` 零错
- [ ] 8. Commit（如有修复）：`fix: webclip M2 e2e 修复` 或无提交则跳过

---

## 派发批次映射

| 批次 | 任务 | 提交数 |
|---|---|---|
| A | Task 1 | 1 |
| B | Task 2 + Task 3 | 2 |
| C | Task 4 | 1 |
| D | Task 5（e2e 验证者） | 0-1 |
| 终审 | 全分支 review + 修复波 | 1 |

## Self-Review 记录

- **范围覆盖**：范围文档 T1→Task1、T2→Task1、T3→Task1、T4→Task2、T5→Task3、T6→Task3、T7→Task2(注入测试)+Task4、T8→Task5、T9-T14→Task4。backlog 三项未入。
- **签名一致性**：convertCore/ConvertDeps/ConvertResult/retryRecord/getLimits/validateStorageRoot/yamlSafe/commentSafe 跨任务引用一致；ConvertResult 需带 `title`（Task 2 Step 3c UPDATE 依赖）——已在 Step 3c 显式标注。
- **已知取舍**：commentSafe 实现允许实现者以用例为准修正；busy 不落记录行（请求未开始，避免历史噪声）；retry 失败更新原行不新增。
