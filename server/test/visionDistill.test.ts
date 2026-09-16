import { test, describe } from 'node:test'
import assert from 'node:assert'
import path from 'path'
import { supportsVision } from '../src/llm/index.js'
import { extractLocalImageRefs } from '../src/llm/llmWorker.js'

describe('视觉蒸馏：supportsVision', () => {
  test('OCR/视觉关键词命中（讯飞 xopdeepseekocr 场景）', () => {
    assert.equal(supportsVision('xopdeepseekocr'), true)
    assert.equal(supportsVision('qwen-vl-max'), true)
    assert.equal(supportsVision('glm-4v Vision'), true)
  })

  test('文本模型不命中——防止 image_url 被服务端 400 拒绝', () => {
    assert.equal(supportsVision('sensenova-6.8-flash-lite'), false)
    assert.equal(supportsVision('deepseek-chat'), false)
    // "resolve" 含 vl 但按分隔符边界匹配不误伤
    assert.equal(supportsVision('resolve-tool'), false)
  })
})

describe('视觉蒸馏：extractLocalImageRefs', () => {
  const baseDir = '/tmp/doc'

  test('HTML img 相对路径 → 相对 baseDir 解析', () => {
    const refs = extractLocalImageRefs('<p>前</p><img src="assets/a.png" alt="x"><p>后</p>', baseDir)
    assert.deepEqual(refs, [path.resolve(baseDir, 'assets/a.png')])
  })

  test('Markdown 图语法 + URL 编码解码', () => {
    const refs = extractLocalImageRefs('![截图](my%20images/b.jpg)', baseDir)
    assert.deepEqual(refs, [path.resolve(baseDir, 'my images/b.jpg')])
  })

  test('远程 http/https、data URL、协议相对路径全部跳过', () => {
    const html = '<img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,xxx"><img src="//cdn.example.com/b.png"><img src="local.gif">'
    const refs = extractLocalImageRefs(html, baseDir)
    assert.deepEqual(refs, [path.resolve(baseDir, 'local.gif')])
  })

  test('非图片扩展名与超出 limit 的引用被丢弃', () => {
    const refs = extractLocalImageRefs('<img src="a.svg"><img src="b.png"><img src="c.png"><img src="d.png"><img src="e.png">', baseDir, 3)
    assert.equal(refs.length, 3)
    assert.ok(!refs.some(r => r.endsWith('a.svg')))
  })
})
