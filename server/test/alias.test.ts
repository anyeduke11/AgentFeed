import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { aliasFromText, extractMd, extractHtml } from '../src/extractor.js'

test('md 无 frontmatter：取正文第一个标题（截图场景 chapter1.zhtw.md 的核心诉求）', () => {
  // WHY: 别名是用户在冷启动列表里识别文件的可读名，取错会把垃圾名展示给用户
  const text = '一些前言文字\n\n# 第一章 类型系统\n\n正文段落。\n## 小节\n'
  assert.equal(aliasFromText('.md', text, 'chapter1.zhtw.md'), '第一章 类型系统')
})

test('md 有 frontmatter：跳过 YAML 块，# 注释行不得误判为标题', () => {
  const text = '---\ntitle: 面试笔记\n# 这是 YAML 注释不是标题\n---\n\n# 真正的标题\n正文'
  assert.equal(aliasFromText('.md', text, 'x.md'), '真正的标题')
})

test('md ATX 闭合与强调符号清洗：`## **标题** ##` → 标题', () => {
  const text = '## **数据结构** ##\n正文'
  assert.equal(aliasFromText('.md', text, 'x.md'), '数据结构')
})

test('md 无任何标题：回退文件名（列不允许空值）', () => {
  assert.equal(aliasFromText('.md', '只有正文，没有标题行', 'README.md'), 'README.md')
})

test('html：<title> 优先，标签与实体清洗', () => {
  const text = '<html><head><title>Fun &amp; <b>Profit</b></title></head><body><h1>另一标题</h1></body></html>'
  assert.equal(aliasFromText('.html', text, 'a.html'), 'Fun & Profit')
})

test('html 无 title：取第一个 h1；都没有：回退文件名', () => {
  assert.equal(aliasFromText('.html', '<body><h1>正文大标题</h1></body>', 'a.html'), '正文大标题')
  assert.equal(aliasFromText('.html', '<div>无标题结构</div>', 'a.html'), 'a.html')
})

test('非 md/html 扩展名：直接回退文件名', () => {
  assert.equal(aliasFromText('.txt', '# 看起来像标题', 'notes.txt'), 'notes.txt')
})

test('extractMd 出口：meta.alias 接线正确（入库零额外 IO 的前提）', async () => {
  // WHY: 入库别名取自 meta.alias；若 extractor 出口漏接，入库将全量落文件名
  const fp = path.join(os.tmpdir(), `alias-md-${Date.now()}.md`)
  await fs.writeFile(fp, '---\n# YAML 注释\n---\n\n# 正文标题\n内容', 'utf-8')
  try {
    const meta = await extractMd(fp, [])
    assert.equal(meta.title, null)
    assert.equal(meta.alias, '正文标题')
  } finally {
    await fs.unlink(fp).catch(() => {})
  }
})

test('extractMd 有 frontmatter title：alias 复用 title 不再重复提取', async () => {
  const fp = path.join(os.tmpdir(), `alias-md2-${Date.now()}.md`)
  await fs.writeFile(fp, '---\ntitle: 正式标题\n---\n\n# 正文中还有个标题\n', 'utf-8')
  try {
    const meta = await extractMd(fp, [])
    assert.equal(meta.alias, '正式标题')
  } finally {
    await fs.unlink(fp).catch(() => {})
  }
})

test('extractHtml 出口：title 为空时 alias 兜底 h1', async () => {
  const fp = path.join(os.tmpdir(), `alias-html-${Date.now()}.html`)
  await fs.writeFile(fp, '<html><body><h1>页面大标题</h1><p>正文</p></body></html>', 'utf-8')
  try {
    const meta = await extractHtml(fp, [])
    assert.equal(meta.title, '页面大标题') // cheerio 的 title 取 <h1> 兜底
    assert.equal(meta.alias, '页面大标题')
  } finally {
    await fs.unlink(fp).catch(() => {})
  }
})
