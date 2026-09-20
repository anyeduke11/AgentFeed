import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTombstoneSweep, SWEEP_TOMBSTONE_CAP } from '../src/scanner.js'

// 软删配额护栏（2026-09-20 实机事故）：/Users/duke/Documents/lingxi-claw 下若干目录是
// 指向 WPS 安装目录的符号链接，而 walk() 用 entry.isDirectory() 判断、不进符号链接目录，
// 于是那轮增量扫描把「本次没走到」当成「已从磁盘删除」，一次性墓碑化 13,673 个仍在磁盘上的
// 文件（至今未自愈）。个人电脑上宁可慢：一轮自动扫描不得整批清空一个根。
//
// 纯函数入参：roots / walkedCountByRoot（本轮每个根实际走到的文件数）/ seenPaths / activeRows / cap

const mkRows = (root: string, n: number, idFrom = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: idFrom + i, path: `${root}/f${i}.md` }))

test('小批量消失（未超上限）照常墓碑化，不误伤护栏之外的清理', () => {
  const root = '/r'
  const all = mkRows(root, 10)
  const seen = all.slice(0, 7).map(f => f.path)
  const r = planTombstoneSweep({
    roots: [root],
    walkedCountByRoot: new Map([[root, seen.length]]),
    seenPaths: new Set(seen),
    activeRows: all
  })
  assert.deepEqual(r.deleteIds, all.slice(7).map(f => f.id))
  assert.deepEqual(r.skipped, [])
})

test('本轮该根一个文件都没走到 → 判为读取现场异常，整批放弃并给出 empty-walk 告警', () => {
  const root = '/r'
  const all = mkRows(root, 5)
  const r = planTombstoneSweep({
    roots: [root],
    walkedCountByRoot: new Map([[root, 0]]), // 卷未挂载 / 权限变更 / EMFILE / 符号链接子树
    seenPaths: new Set(),
    activeRows: all
  })
  assert.deepEqual(r.deleteIds, [])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].reason, 'empty-walk')
  assert.equal(r.skipped[0].count, 5)
  assert.equal(r.skipped[0].root, root)
})

test('超出单轮上限 → 只放弃越限的那个根，其他根的正常清理不受牵连', () => {
  const big = '/big'
  const small = '/small'
  const bigRows = mkRows(big, 300)
  const smallRows = mkRows(small, 3, 1000)
  const r = planTombstoneSweep({
    roots: [big, small],
    walkedCountByRoot: new Map([[big, 10], [small, 2]]),
    seenPaths: new Set([...bigRows.slice(0, 10).map(f => f.path), ...smallRows.slice(0, 2).map(f => f.path)]),
    activeRows: [...bigRows, ...smallRows]
  })
  assert.deepEqual(r.deleteIds, [smallRows[2].id], 'small 根那 1 个消失文件应照常清理，不被 big 根连坐')
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].root, big)
  assert.equal(r.skipped[0].reason, 'over-cap')
  assert.equal(r.skipped[0].count, 290)
  assert.ok(290 > SWEEP_TOMBSTONE_CAP)
})

test('cap 放宽（force 场景）时越限批次照删，护栏只是限幅不是禁止', () => {
  const root = '/r'
  const all = mkRows(root, 50)
  const r = planTombstoneSweep({
    roots: [root],
    walkedCountByRoot: new Map([[root, 1]]),
    seenPaths: new Set([all[0].path]),
    activeRows: all,
    cap: Infinity
  })
  assert.equal(r.deleteIds.length, 49)
  assert.deepEqual(r.skipped, [])
})

test('不属于本次扫描根的行不参与软删（单根扫描不得动别的根）', () => {
  const inRoot = mkRows('/r', 4)
  const other = mkRows('/other', 3, 100)
  const r = planTombstoneSweep({
    roots: ['/r'],
    walkedCountByRoot: new Map([['/r', 1]]),
    seenPaths: new Set([inRoot[0].path]),
    activeRows: [...inRoot, ...other]
  })
  assert.deepEqual(r.deleteIds, inRoot.slice(1).map(f => f.id))
})

test('嵌套根：文件归属最深的那个根（配额按根独立计）', () => {
  const outer = '/r'
  const inner = '/r/sub'
  const innerRows = mkRows(inner, 3)
  const r = planTombstoneSweep({
    roots: [outer, inner],
    walkedCountByRoot: new Map([[outer, 0], [inner, 0]]),
    seenPaths: new Set(),
    activeRows: innerRows
  })
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].root, inner, '应归到更深的 inner 根，而不是把 outer 根也判成异常')
})
