import { test } from 'node:test'
import assert from 'node:assert/strict'

// planBootRescan 是 boot 重扫的条件闸门（快速重启不再烧 42s~5.6min 全根遍历）。
// 必须钉死的不变量：
// 1. 新鲜（停机 ≤ 阈值）→ 跳过；过期 → 重扫——boot 轮的意义只是补齐 watcher 失明窗口
// 2. 新鲜度按【完成时间】（started_at + duration_ms）算，不是启动时间——长扫描刚结束
//    立刻重启是最常见的开发循环形态，按启动时间会把刚扫完的库误判为过期
// 3. SQLite CURRENT_TIMESTAMP 是 UTC——按本地时区误读会把停机时长偏移整 8 小时（+8），
//    闸门判定直接反转
// 4. fail-open：无台账/时间串解析失败一律重扫——闸门故障宁可多扫，不漏变更
// 5. 边界：停机恰好等于阈值 → 跳过（≤ 语义，与「间隔内新鲜」一致）

const { planBootRescan } = await import('../src/scanner.js')

const NOW = Date.parse('2026-10-04T10:00:00Z')
const MIN = 60_000
const THRESHOLD = 120 * MIN

test('快速重启：停机 10 分钟 ≤ 120 分钟阈值 → 跳过 boot 重扫', () => {
  const r = planBootRescan({ started_at: '2026-10-04 09:49:00', duration_ms: 30_000 }, NOW, THRESHOLD)
  assert.equal(r.rescan, false, '10 分钟停机必须跳过（上次扫描仍新鲜）')
  assert.ok(r.downtimeMs > 10 * MIN && r.downtimeMs <= 11 * MIN)
})

test('长停机：距上次扫描完成超过阈值 → 必须重扫', () => {
  const r = planBootRescan({ started_at: '2026-10-04 07:00:00', duration_ms: 60_000 }, NOW, THRESHOLD)
  assert.equal(r.rescan, true, '跨夜/关机后的 boot 轮必须补扫（watcher 失明窗口的变更靠它）')
})

test('新鲜度按完成时间算：扫描 10 分钟、10 分钟前刚结束 → 算 10 分钟新鲜，不按启动时间算 20 分钟', () => {
  // 启动于 20 分钟前，耗时 10 分钟 → 完成 10 分钟前；若误按 started_at 算则 20 分钟，
  // 虽然本例两者都 < 阈值不反转——用 115/5 分钟组合让两种算法跨越阈值边界
  const r = planBootRescan({ started_at: '2026-10-04 07:55:00', duration_ms: 10 * MIN }, NOW, THRESHOLD)
  assert.equal(r.rescan, false, '完成于 5 分钟前 ≤ 120 分钟：按完成时间必须跳过（按启动时间 125 分钟会误重扫）')
})

test('UTC 解析：同一时间串在任何本地时区下判定一致（+8 误读会反转结果）', () => {
  // 09:49 UTC 若被按 +8 本地时区解析 = 01:49 UTC → 停机 8h+ → 误判重扫；按 UTC = 10 分钟 → 跳过
  const r = planBootRescan({ started_at: '2026-10-04 09:49:00', duration_ms: 0 }, NOW, THRESHOLD)
  assert.equal(r.rescan, false, 'SQLite UTC 时间串必须按 UTC 解析')
})

test('fail-open：无台账 / 空时间串 / 乱码时间串一律要求重扫', () => {
  assert.equal(planBootRescan(undefined, NOW, THRESHOLD).rescan, true, '首次启动无台账必须重扫')
  assert.equal(planBootRescan({ started_at: '' }, NOW, THRESHOLD).rescan, true)
  assert.equal(planBootRescan({ started_at: 'not-a-date' }, NOW, THRESHOLD).rescan, true)
})

test('边界：停机恰好等于阈值 → 跳过（≤ 语义）；超过 1 秒 → 重扫', () => {
  const r = planBootRescan({ started_at: '2026-10-04 08:00:00', duration_ms: 0 }, NOW, THRESHOLD)
  assert.equal(r.rescan, false, '停机 = 阈值仍在「间隔内新鲜」语义内，跳过')
  const r2 = planBootRescan({ started_at: '2026-10-04 07:59:59', duration_ms: 0 }, NOW, THRESHOLD)
  assert.equal(r2.rescan, true)
})
