import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPeriodicRoots, resolveAgentDirs } from '../src/agents.js'

// 启动/周期增量扫描的根选择口径（2026-09-20 审查 P1-⑪）。
// 缺陷原状：index.ts agentRescan 取「resolveAgentDirs().filter(exists) ∩ enabled 根」，
// 手工挂载的根从此没有任何自动增量通道——watcher 只覆盖运行期变化，停机期间的增改无人补齐。

test('手工挂载的根必须留在周期扫描范围内', () => {
  const dirs = [
    { name: 'Qoder', path: '/home/x/.qoder', exists: true },
    { name: 'Trae', path: '/home/x/.trae', exists: false }
  ]
  const enabled = ['/home/x/.qoder', '/home/x/Documents/notes', '/Volumes/backup/md']
  assert.deepEqual(selectPeriodicRoots(enabled, dirs), ['/home/x/.qoder', '/home/x/Documents/notes', '/Volumes/backup/md'])
})

test('本机不存在的 agent 目录跳过（避免每轮对空路径扫描）', () => {
  const dirs = [
    { name: 'Qoder', path: '/home/x/.qoder', exists: true },
    { name: 'Trae', path: '/home/x/.trae', exists: false },
    { name: 'Coze', path: '/home/x/.coze', exists: false }
  ]
  const enabled = ['/home/x/.qoder', '/home/x/.trae', '/home/x/.coze']
  assert.deepEqual(selectPeriodicRoots(enabled, dirs), ['/home/x/.qoder'])
})

test('剔除只看 agent 目录名单，同名但非 agent 的路径不受影响', () => {
  const dirs = [{ name: 'Trae', path: '/home/x/.trae', exists: false }]
  // 手工根恰好挂在另一个 agent 候选路径之外：仍应保留
  assert.deepEqual(selectPeriodicRoots(['/home/x/.trae-old', '/home/x/.trae'], dirs), ['/home/x/.trae-old'])
})

test('特征化：resolveAgentDirs 返回结构完整，路径为绝对路径', () => {
  const dirs = resolveAgentDirs()
  assert.ok(dirs.length > 0)
  for (const d of dirs) {
    assert.ok(d.name && d.path.startsWith('/') && typeof d.exists === 'boolean')
  }
})
