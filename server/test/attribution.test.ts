import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferAgent, type RootBinding } from '../src/extractor.js'

// WHY: agent 归因直接决定看板按 agent 分组的准确性。信任序是 D4 回填的契约——
// 文件头自我声明必须赢过目录猜测（作者自己写的声明最权威），绑定赢过目录名兜底。

const bindings: RootBinding[] = [
  { path: '/roots/trae', agent: 'trae' },
  { path: '/roots/notes', agent: null }
]

test('frontmatter 显式声明最高优先：即使文件位于绑定 agent 不同的根下', () => {
  // WHY: D4 回填规则「文件头赢」——已有声明不得被扫描根绑定覆盖
  assert.equal(inferAgent('/roots/trae/x.md', bindings, 'cursor'), 'cursor')
  assert.equal(inferAgent('/roots/notes/x.md', bindings, 'claude'), 'claude')
})

test('无声明时按扫描根绑定归因', () => {
  assert.equal(inferAgent('/roots/trae/session/a.md', bindings), 'trae')
})

test('绑定含尾部斜杠时同样命中（挂载数据兼容）', () => {
  const b: RootBinding[] = [{ path: '/roots/trae/', agent: 'trae' }]
  assert.equal(inferAgent('/roots/trae/a.md', b), 'trae')
})

test('手工根无绑定：根后首段目录名兜底，且不误吞根前缀', () => {
  // WHY: /roots/notes/notes/a.md 的兜底应是内层目录名 notes，而不是把根路径段当 agent
  assert.equal(inferAgent('/roots/notes/proj/a.md', bindings), 'proj')
  // 文件直接位于根下（无子目录）→ 无兜底来源
  assert.equal(inferAgent('/roots/notes/a.md', bindings), null)
})

test('完全不在任何根下：返回 null（不得凭空编造归因）', () => {
  assert.equal(inferAgent('/elsewhere/a.md', bindings), null)
  assert.equal(inferAgent('/elsewhere/a.md', [], 'declared'), 'declared')
})

test('兄弟目录前缀不误命中（/roots/trae2 不是 /roots/trae）', () => {
  const b: RootBinding[] = [{ path: '/roots/trae', agent: 'trae' }]
  assert.notEqual(inferAgent('/roots/trae2/a.md', b), 'trae')
})
