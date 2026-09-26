# 注意力预算 P0（红线清理 + 生命周期基建）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 `- [ ]` 勾选跟踪。
> 规格来源：`docs/attention-budget-v0.1.6-plan.md` §6 P0-1~P0-5（方案定稿，评审已冻结）。
> 基线：main @ 2a7f8e6，全量测试 420/420 全绿。

**Goal:** files 表加生命周期五列 + touch 回写链路（Web/MCP）+ 存量回填 + 90d/180d 下沉日批（dry_run 先行）+ 灰度开关对等回归 + Overview 红线清理（下线「超 7 天未执行」催更条与「待读」计数）。

**Architecture:** 全部走既有模式——ensureColumns 幂等加列（红线 3）、复用 open 路由/mcpTools 已有的 read_history 写入点顺带 UPDATE files、复用 startDailyReportJob 的日批挂载模式、config seed 扩 attention.* 键。无新表、无新路由、无破坏性迁移。

**Tech Stack:** Express + SQLite（@homeofthings/sqlite3）+ Vue3。测试 node:test（tsx --test）。

**侦察锚点（2026-09-26 核实，行号随演进复核）：**
- db.ts：L136-139 webclip_records ensureColumns（新列插入点，其后 L140 seedDefaults）；L577-580 config seed 末尾（attention.* 插入点）；ensureColumns 签名 L497-503；files 显式索引区 L425-432
- files.ts：L140-156 POST /:id/open（L149 写 read_history；try 块内顺带 touch）
- mcpTools.ts：L45-52 logMcpConsumption（INSERT read_history 后顺带 touch）
- Overview.vue：L96-98「超 7 天未执行」催更条（staleCount，注意不是 stalled）；L80「推荐池待读 N/N」计数；数据源 reading.ts /stats
- reports.ts L130-142 startDailyReportJob；index.ts L125-126 挂载点；generateDailyReport 幂等模式
- **侦察更正**：方案里「>14 天停滞催更」实为后端 stalled 字段从未被前端渲染（零命中）——真正在线的是「>7 天未执行」条（staleCount）；未读红点不存在，最接近的是「待读 N/N」计数。P0-3 按实际在线元素清理。

---

### Task 1: db 迁移——files 五列 + attention config 键 + 索引

**Files:**
- Modify: `server/src/db.ts`（L136-139 后、L577-580 后、索引区）
- Test: `server/test/attentionP0.test.ts`（新建，AGENTFEED_DATA_DIR 隔离 + 动态 import db，**严禁静态 import routes**——webclip 测试事故教训，见 CLAUDE.md）

- [ ] **Step 1: RED——新测试文件**

```ts
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// 隔离：AGENTFEED_DATA_DIR 临时目录（domainDedupGate 模式）。动态 import db.js——
// 其模块顶层读 env，静态 import 会被提升到 env 设置前，测试将直连生产库（2026-09-25 事故，勿回退）
const DATA_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentfeed-attn-p0-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP
const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 句柄随进程释放 */ }
  await fsp.rm(DATA_TMP, { recursive: true, force: true })
})

describe('attention P0 迁移', () => {
  test('files 表新增生命周期五列', async () => {
    const db = await getDb()
    const cols = new Set(((await (await db.prepare("PRAGMA table_info('files')")).all()) as any[]).map(r => r.name))
    for (const c of ['lifecycle', 'lifecycle_deadline', 'last_touched_at', 'touch_count', 'pinned']) {
      assert.ok(cols.has(c), `files 缺列 ${c}`)
    }
  })

  test('attention config 键已 seed 且默认值正确', async () => {
    const db = await getDb()
    const feat = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.features'")).get() as any
    assert.ok(feat, 'attention.features 未 seed')
    const parsed = JSON.parse(feat.value)
    assert.equal(parsed.lifecycle, true)   // 生命周期默认开
    assert.equal(parsed.decay, false)      // 下沉默认关（先观测）
    const days = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.decayDays'")).get() as any
    assert.equal(JSON.parse(days.value), JSON.stringify({ demoteDays: 90, archiveDays: 180 }))
  })

  test('last_touched_at 有索引（回填与日批查询用）', async () => {
    const db = await getDb()
    const idx = ((await (await db.prepare("PRAGMA index_list('files')")).all()) as any[]).map(r => r.name)
    assert.ok(idx.includes('idx_files_touched'), '缺 idx_files_touched')
  })
})
```

- [ ] **Step 2: 跑 RED** — `cd server && npx tsx --test test/attentionP0.test.ts` → 3 用例 FAIL（缺列/缺键/缺索引）

- [ ] **Step 3: 实现 db.ts 三处**

3a. L139 `ensureColumns(webclip_records…)` 之后、`await seedDefaults(db)` 之前：

```ts
    // attention P0：生命周期五列（hot|warm|cold 分层 + 使用侧衰减数据面）。默认值保证旧库行为不变：
    // lifecycle NULL=未分层（视同 hot 但不参与下沉首跑），last_touched_at NULL=以 file_mtime 回填
    await ensureColumns(db, 'files', [
      { name: 'lifecycle', ddl: 'lifecycle TEXT' },
      { name: 'lifecycle_deadline', ddl: 'lifecycle_deadline TEXT' },
      { name: 'last_touched_at', ddl: 'last_touched_at TEXT' },
      { name: 'touch_count', ddl: 'touch_count INTEGER DEFAULT 0' },
      { name: 'pinned', ddl: 'pinned INTEGER DEFAULT 0' }
    ])
```

3b. 索引区（L425-432 显式索引块内追加一行，与其他 CREATE INDEX 同块）：

```ts
    CREATE INDEX IF NOT EXISTS idx_files_touched ON files(last_touched_at);
```

3c. config seed（L580 chat.exportDir 之后）：

```ts
    { key: 'attention.features', value: '{"lifecycle":true,"decay":false}', type: 'json', description: '注意力预算灰度开关（v0.1.6 方案定稿 §6 P0-5）：lifecycle=touch 回写与生命周期分层；decay=下沉日批（默认关，dry_run 观测后开）。全关=行为与改造前完全一致' },
    { key: 'attention.decayDays', value: '{"demoteDays":90,"archiveDays":180}', type: 'json', description: '生命周期下沉阈值：90d 未触及且 touch≤1 降推荐可见性（lifecycle=warm）；180d 未触及归 cold（搜索默认折叠）。pinned 永不下沉' },
```

- [ ] **Step 4: GREEN + 回归** — 聚焦 3/3 PASS；`npm test -w server` 全绿（420+3）

- [ ] **Step 5: Commit** — `git add server/src/db.ts server/test/attentionP0.test.ts && git commit -m "feat(attention): P0-1 files 生命周期五列 + attention 灰度/阈值 config 键 + touched 索引"`

---

### Task 2: touch 回写（Web open + MCP read_entry）+ 存量回填

**Files:**
- Create: `server/src/attention.ts`（touch 与回填的唯一实现，router/mcpTools 共用）
- Modify: `server/src/routes/files.ts` L140-156、`server/src/mcpTools.ts` L45-52
- Test: `server/test/attentionP0.test.ts`（追加 describe）

- [ ] **Step 1: RED——追加测试**（文件末尾，新 describe）

```ts
describe('attention P0 touch 与回填', () => {
  test('touchFiles 更新 last_touched_at/touch_count（幂等递增），feature 关闭时不动', async () => {
    const db = await getDb()
    const ins = await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state) VALUES ('/attn/a.md', 'a.md', '.md', 'active', 'done')")).run() as any
    const id = ins.lastID
    const { touchFiles } = await import('../src/attention.js')
    await touchFiles([id])
    let row = await (await db.prepare('SELECT last_touched_at, touch_count FROM files WHERE id = ?')).get(id) as any
    assert.ok(row.last_touched_at)
    assert.equal(row.touch_count, 1)
    await touchFiles([id])
    row = await (await db.prepare('SELECT touch_count FROM files WHERE id = ?')).get(id) as any
    assert.equal(row.touch_count, 2)
    // feature 关闭 → no-op
    await db.exec("UPDATE config SET value = '{\"lifecycle\":false,\"decay\":false}' WHERE key = 'attention.features'")
    await touchFiles([id])
    row = await (await db.prepare('SELECT touch_count FROM files WHERE id = ?')).get(id) as any
    assert.equal(row.touch_count, 2)
    await db.exec("UPDATE config SET value = '{\"lifecycle\":true,\"decay\":false}' WHERE key = 'attention.features'")
  })

  test('backfillLastTouched：有 read_history 用最早 opened_at，无则 file_mtime', async () => {
    const db = await getDb()
    const { backfillLastTouched } = await import('../src/attention.js')
    const mtime = '2026-09-01T00:00:00.000Z'
    const ins1 = await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state, file_mtime) VALUES ('/attn/b.md', 'b.md', '.md', 'active', 'done', ?)")).run([mtime]) as any
    const ins2 = await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state, file_mtime) VALUES ('/attn/c.md', 'c.md', '.md', 'active', 'done', ?)")).run([mtime]) as any
    await (await db.prepare("INSERT INTO read_history (file_id, path, source, opened_at) VALUES (?, '/attn/b.md', 'reader', '2026-09-20 10:00:00')")).run([ins1.lastID])
    const n = await backfillLastTouched()
    assert.ok(n >= 2)
    const b = await (await db.prepare('SELECT last_touched_at FROM files WHERE id = ?')).get(ins1.lastID) as any
    const c = await (await db.prepare('SELECT last_touched_at FROM files WHERE id = ?')).get(ins2.lastID) as any
    assert.ok(String(b.last_touched_at).startsWith('2026-09-20'))
    assert.ok(String(c.last_touched_at).startsWith('2026-09-01'))
  })
})
```

- [ ] **Step 2: 跑 RED** → FAIL（attention.js 不存在）

- [ ] **Step 3: 实现 `server/src/attention.ts`**

```ts
import { getDb } from './db.js'

/** attention.features 灰度开关读取（坏 JSON 回退全关——fail-closed 到旧行为） */
export async function attentionFeatures(): Promise<{ lifecycle: boolean; decay: boolean }> {
  const db = await getDb()
  const row = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.features'")).get() as any
  try {
    const f = JSON.parse(String(row?.value || '{}'))
    return { lifecycle: f.lifecycle === true, decay: f.decay === true }
  } catch { return { lifecycle: false, decay: false } }
}

/** touch 回写：Web 打开 / MCP 深读共用。幂等递增 touch_count，置 last_touched_at=now（UTC ISO） */
export async function touchFiles(ids: number[]): Promise<void> {
  if (!ids.length) return
  const { lifecycle } = await attentionFeatures()
  if (!lifecycle) return
  const db = await getDb()
  await db.exec(`UPDATE files SET last_touched_at = '${new Date().toISOString()}', touch_count = touch_count + 1 WHERE id IN (${ids.join(',')})`)
}

/** 存量回填（幂等，只填 NULL 行）：有 read_history 取最早 opened_at，无则 file_mtime。返回回填行数 */
export async function backfillLastTouched(): Promise<number> {
  const db = await getDb()
  const res = await db.exec(`
    UPDATE files SET last_touched_at = COALESCE(
      (SELECT MIN(opened_at) FROM read_history WHERE read_history.file_id = files.id),
      file_mtime)
    WHERE last_touched_at IS NULL`)
  return typeof res === 'number' ? res : (res as any)?.changes ?? 0
}
```

实现者注意：`db.exec` 的返回值形态以实际 @homeofthings/sqlite3 为准——若不返回 changes，改用「先 SELECT COUNT(*) WHERE last_touched_at IS NULL → exec → 返回该计数」的等价实现，测试断言只要求 ≥2。

- [ ] **Step 4: 接线两处消费点**

4a. files.ts L149 INSERT read_history 之后同 try 块内加：

```ts
        const { touchFiles } = await import('../attention.js')
        await touchFiles([fileId])
```

（用动态 import 或顶部静态 import 均可——attention.ts 顶层只 import db.ts，无 env 时序问题；静态更符合文件风格，推荐顶部 `import { touchFiles } from '../attention.js'`。）

4b. mcpTools.ts logMcpConsumption 的 `)).run(...)` 之后 try 块内加：

```ts
      const { touchFiles } = await import('./attention.js')
      await touchFiles([fileId])
```

（同上，推荐顶部静态 import。）

- [ ] **Step 5: GREEN + 回归** — 聚焦 PASS；`npm test -w server` 全绿；`cd server && npx tsc --noEmit` 零错

- [ ] **Step 6: Commit** — `git add server/src/attention.ts server/src/routes/files.ts server/src/mcpTools.ts server/test/attentionP0.test.ts && git commit -m "feat(attention): P0-2 touch 回写链路（Web open + MCP read_entry）+ 存量 last_touched_at 幂等回填"`

---

### Task 3: 生命周期下沉日批（dry_run 先行）+ index.ts 挂载

**Files:**
- Modify: `server/src/attention.ts`（追加 decay 函数）
- Modify: `server/src/index.ts`（startDailyReportJob 挂载点后）
- Test: `server/test/attentionP0.test.ts`（追加 describe）

- [ ] **Step 1: RED——追加测试**

```ts
describe('attention P0 生命周期下沉', () => {
  test('planDecay：90d 未触及且 touch≤1 → warm；180d → cold；pinned/recent 豁免；dry_run 不落库', async () => {
    const db = await getDb()
    const { planDecay, applyDecay } = await import('../src/attention.js')
    const old90 = new Date(Date.now() - 100 * 86400e3).toISOString()
    const old200 = new Date(Date.now() - 200 * 86400e3).toISOString()
    const recent = new Date().toISOString()
    const mk = async (path: string, touched: string, touchCount: number, pinned = 0) =>
      ((await (await db.prepare("INSERT INTO files (path, name, ext, status, llm_state, last_touched_at, touch_count, pinned) VALUES (?, ?, '.md', 'active', 'done', ?, ?, ?)")).run([path, path.split('/').pop(), touched, touchCount, pinned])) as any).lastID
    const w = await mk('/attn/w.md', old90, 1)      // → warm
    const c = await mk('/attn/c2.md', old200, 3)    // → cold（180d 判定不看 touch_count）
    const p = await mk('/attn/p.md', old200, 0, 1)  // pinned 豁免
    const r = await mk('/attn/r.md', recent, 0)     // 近期触及豁免
    const plan = await planDecay()
    assert.ok(plan.warmIds.includes(w), '90d 未触及应进 warm')
    assert.ok(plan.coldIds.includes(c), '180d 未触及应进 cold')
    assert.ok(!plan.warmIds.includes(p) && !plan.coldIds.includes(p), 'pinned 豁免')
    assert.ok(!plan.warmIds.includes(r) && !plan.coldIds.includes(r), '近期触及豁免')
    // dry_run 不落库
    let row = await (await db.prepare('SELECT lifecycle FROM files WHERE id = ?')).get(w) as any
    assert.equal(row.lifecycle, null)
    // apply 后落库；warm 判定需 touch≤1，c2 touch=3 仍进 cold（180d 规则独立）
    const applied = await applyDecay(plan)
    assert.ok(applied.warm >= 1 && applied.cold >= 1)
    row = await (await db.prepare('SELECT lifecycle FROM files WHERE id = ?')).get(w) as any
    assert.equal(row.lifecycle, 'warm')
    row = await (await db.prepare('SELECT lifecycle FROM files WHERE id = ?')).get(c) as any
    assert.equal(row.lifecycle, 'cold')
    row = await (await db.prepare('SELECT lifecycle FROM files WHERE id = ?')).get(p) as any
    assert.equal(row.lifecycle, null)
  })

  test('decay 开关关闭时 planDecay 返回空计划', async () => {
    const db = await getDb()
    const { planDecay } = await import('../src/attention.js')
    await db.exec("UPDATE config SET value = '{\"lifecycle\":true,\"decay\":false}' WHERE key = 'attention.features'")
    const plan = await planDecay()
    assert.equal(plan.warmIds.length + plan.coldIds.length, 0)
  })
})
```

- [ ] **Step 2: 跑 RED** → FAIL（planDecay 不存在）

- [ ] **Step 3: 实现——attention.ts 追加**

```ts
/** 下沉计划（纯查询不落库）：warm=90d 未触及且 touch≤1；cold=180d 未触及；pinned 豁免；decay 关闭返回空 */
export async function planDecay(): Promise<{ warmIds: number[]; coldIds: number[] }> {
  const { decay } = await attentionFeatures()
  if (!decay) return { warmIds: [], coldIds: [] }
  const db = await getDb()
  const days = await (await db.prepare("SELECT value FROM config WHERE key = 'attention.decayDays'")).get() as any
  let demote = 90; let archive = 180
  try { const d = JSON.parse(String(days?.value || '{}')); if (Number.isFinite(d.demoteDays)) demote = d.demoteDays; if (Number.isFinite(d.archiveDays)) archive = d.archiveDays } catch { /* 默认 */ }
  const warmIds = (((await (await db.prepare(`
    SELECT id FROM files WHERE status = 'active' AND pinned = 0 AND lifecycle IS NOT 'cold'
      AND last_touched_at IS NOT NULL AND last_touched_at < datetime('now', '-${demote} days')
      AND touch_count <= 1`)).all()) as any[]).map(r => r.id))
  const coldIds = (((await (await db.prepare(`
    SELECT id FROM files WHERE status = 'active' AND pinned = 0 AND lifecycle IS NOT 'cold'
      AND last_touched_at IS NOT NULL AND last_touched_at < datetime('now', '-${archive} days')`)).all()) as any[]).map(r => r.id))
  return { warmIds: warmIds.filter(id => !coldIds.includes(id)), coldIds }
}

/** 执行下沉（warm 集需剔除 cold 集避免覆盖）。返回实际更新数 */
export async function applyDecay(plan: { warmIds: number[]; coldIds: number[] }): Promise<{ warm: number; cold: number }> {
  if (!plan.warmIds.length && !plan.coldIds.length) return { warm: 0, cold: 0 }
  const db = await getDb()
  if (plan.coldIds.length) await db.exec(`UPDATE files SET lifecycle = 'cold' WHERE id IN (${plan.coldIds.join(',')})`)
  if (plan.warmIds.length) await db.exec(`UPDATE files SET lifecycle = 'warm' WHERE id IN (${plan.warmIds.join(',')})`)
  return { warm: plan.warmIds.length, cold: plan.coldIds.length }
}
```

实现者注意：SQLite 的 `IS NOT` 是 NULL 安全不等（`NULL IS NOT 'cold'` 为**真**）——lifecycle 为 NULL（未分层）的行**会参与下沉选拔**，这是规格意图（74k 存量 lifecycle 全 NULL，Task 5 dry_run 预期它们可被选出）。「未回填不下沉」的安全性质由 `last_touched_at IS NOT NULL` 保证（touch 时间未知的行永不下沉，fail-closed）。（注：本条曾误写为「IS NOT 对 NULL 不命中」，批次 B 实现者实测证伪后更正——2026-09-26 评审留档）

- [ ] **Step 4: index.ts 挂载**（L126 startDailyReportJob() 之后）

```ts
  // attention P0：生命周期下沉日批——每 6h 检查一次（decay 开关默认关，先靠手动 dry_run 观测；
  // 开启后每日首跑实际下沉）。挂在日报 job 之后复用 boot 延迟错峰
  setInterval(() => {
    import('./attention.js').then(async ({ backfillLastTouched, planDecay, applyDecay }) => {
      try {
        await backfillLastTouched()
        const plan = await planDecay()
        if (plan.warmIds.length + plan.coldIds.length > 0) {
          const r = await applyDecay(plan)
          console.log(`attention decay: ${r.warm} warm / ${r.cold} cold`)
        }
      } catch (e) { console.error('attention decay job failed', e) }
    }).catch(() => {})
  }, 6 * 60 * 60 * 1000)
```

- [ ] **Step 5: GREEN + 回归 + tsc** — 聚焦 PASS；`npm test -w server` 全绿；`npx tsc --noEmit` 零错

- [ ] **Step 6: Commit** — `git add server/src/attention.ts server/src/index.ts server/test/attentionP0.test.ts && git commit -m "feat(attention): P0-4 生命周期下沉日批（90d warm/180d cold，pinned 豁免，dry_run 语义）+ 6h 挂载"`

---

### Task 4: Overview 红线清理

**Files:**
- Modify: `web/src/views/Overview.vue`（L96-98 催更条、L80 待读计数）

- [ ] **Step 1: 下线「超 7 天未执行」催更条**（L96-98 整块删除）

删除：
```html
      <div v-if="(rstats.staleCount ?? 0) > 0" class="notice mark-warn" style="margin:0 14px 12px">
        有 {{ rstats.staleCount }} 篇到期超 7 天未执行，建议回顾或忽略：{{ (rstats.stale || []).map((s: any) => s.title).join('、') }}
      </div>
```

- [ ] **Step 2: 「推荐池待读 N/N」计数改为中性存量表述**（L80）

`推荐池待读 {{ rstats.pool?.unread ?? 0 }}/{{ rstats.pool?.total ?? 0 }}` → `推荐池存量 {{ rstats.pool?.total ?? 0 }}`

（只删 unread 分数显示，保留存量——「待读 N/N」属未读计数类红线；后端字段不动。）

- [ ] **Step 3: 构建验证** — `npm run build -w web` 零错；若 staleCount/stale 在 script 中再无消费则一并清理引用（保留 rstats 其他字段）

- [ ] **Step 4: Commit** — `git add web/src/views/Overview.vue && git commit -m "feat(attention): P0-3 红线清理——下线执行队列催更条与待读计数（反焦虑红线）"`

---

### Task 5: 对等回归 + 收尾

**Files:** 无新文件

- [ ] **Step 1: 灰度全关对等验证**——临时把 attention.features 改为 `{"lifecycle":false,"decay":false}` 跑 `npm test -w server`（touch/decay 用例在关闭态断言 no-op 已内置，此步验证全量无回归后还原 `{"lifecycle":true,"decay":false}`）
- [ ] **Step 2: 手动 dry_run 观测**（生产库只读）——`cd server && npx tsx -e "import('./attention.js').then(async m => { const db = (await import('./db.js')).getDb; await db(); const n = await m.backfillLastTouched(); const p = await m.planDecay(); console.log('backfilled:', n, '| would warm:', p.warmIds.length, '| would cold:', p.coldIds.length) })"`（decay=false 下 planDecay 返回空——需临时置 true 观测再还原；或直接改用临时脚本内联逻辑）。预期：74k 存量绝大多数 would_cold（从未触及），这正是基线结论的可视化
- [ ] **Step 3: 全量回归** — `npm test -w server` 全绿 + `npm run build -w web` 零错 + `cd server && npx tsc --noEmit`
- [ ] **Step 4: Commit（如有脚本产物修正）** — `fix(attention): P0 收尾——对等回归与 dry_run 观测修正`（无改动则跳过）

---

## 派发批次映射

| 批次 | 任务 | 提交 |
|---|---|---|
| A | Task 1 + Task 2 | 2 |
| B | Task 3 + Task 4 | 2 |
| C | Task 5（验证收尾） | 0-1 |

## Self-Review 记录

- **Spec 覆盖**：P0-1→Task1、P0-2→Task2、P0-3→Task4、P0-4→Task3、P0-5→Task1(config 键)+Task5(对等回归) ✓
- **侦察更正已吸收**：停滞催更实为 staleCount（>7 天执行队列）；未读红点不存在，最接近的是待读计数——清理目标按实际在线元素
- **类型一致性**：touchFiles/backfillLastTouched/planDecay/applyDecay/attentionFeatures 签名跨任务一致；warm 剔除 cold 集逻辑在 planDecay 内完成
- **红线核对**：ensureColumns 幂等（红线 3）；无删除性迁移；attention.ts 无 env 时序风险（顶层仅 import db）；测试动态 import db.js（事故教训）
