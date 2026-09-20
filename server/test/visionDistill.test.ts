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

describe('视觉蒸馏：图片路径扫描根边界（防内容诱导任意文件读取）', () => {
  // 文档内容不可信：内嵌图片路径若可指向扫描根外（如 ~/.ssh），会被 base64 后外发 LLM API
  const baseDir = '/roots/docs'
  const roots = ['/roots/docs', '/roots/wiki']

  test('根内相对路径正常解析', () => {
    const refs = extractLocalImageRefs('<img src="assets/a.png">', baseDir, 3, roots)
    assert.deepEqual(refs, [path.resolve(baseDir, 'assets/a.png')])
  })

  test('根内绝对路径放行', () => {
    const refs = extractLocalImageRefs('![图](/roots/wiki/pic.jpg)', baseDir, 3, roots)
    assert.deepEqual(refs, ['/roots/wiki/pic.jpg'])
  })

  test('根外绝对路径丢弃（敏感文件不可达）', () => {
    const refs = extractLocalImageRefs('<img src="/Users/duke/.ssh/id_rsa.png">', baseDir, 3, roots)
    assert.deepEqual(refs, [])
  })

  test('../ 相对路径逃逸到根外丢弃', () => {
    const refs = extractLocalImageRefs('![逃逸](../../escape.png)', baseDir, 3, roots)
    assert.deepEqual(refs, [])
  })

  test('兄弟目录前缀不误放行（/roots/docs vs /roots/docs2）', () => {
    const refs = extractLocalImageRefs('<img src="/roots/docs2/evil.png">', baseDir, 3, ['/roots/docs'])
    assert.deepEqual(refs, [])
  })

  test('allowedRoots 未传保持原行为（向后兼容）', () => {
    const refs = extractLocalImageRefs('<img src="/Users/duke/.ssh/id_rsa.png">', baseDir)
    assert.deepEqual(refs, ['/Users/duke/.ssh/id_rsa.png'])
  })
})
