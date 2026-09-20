import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, sanitizeHtml, buildReaderDoc } from '../src/reader.js'

/**
 * 阅读器管线是「站内渲染脚本零执行」承诺的载体（preview-reader-prd.md 双保险的服务端一环）：
 * 任何清洗漏网 = 恶意 html 在用户同源上下文执行的直接安全漏洞，这里必须钉死。
 */
describe('阅读器清洗管线安全', () => {
  it('script 标签整体移除（含 md 内联与嵌套 svg 内 script）', () => {
    assert.ok(!sanitizeHtml('<p>a</p><script>alert(1)</script>').includes('script'))
    assert.ok(!sanitizeHtml('<svg><script>alert(1)</script></svg>').includes('script'))
  })

  it('iframe / object / embed / meta refresh / form / base 移除', () => {
    const out = sanitizeHtml('<iframe src="x"></iframe><object></object><embed><meta http-equiv="refresh" content="1"><form></form><base href="//evil"><p>ok</p>')
    for (const t of ['iframe', 'object', 'embed', 'meta', 'form', 'base']) assert.ok(!out.includes(`<${t}`), `应移除 ${t}`)
    assert.ok(out.includes('ok'))
  })

  it('on* 事件属性全部移除（onerror / onclick / 大小写混写）', () => {
    const out = sanitizeHtml('<img src="a.png" oNeRrOr="alert(1)"><div onclick="x()">t</div>')
    assert.ok(!/on\w+\s*=/i.test(out))
  })

  it('javascript: / vbscript: / data:text/html 链接移除', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a><a href="JAVASCRIPT:x">y</a><a href="data:text/html,<b>z</b>">w</a>')
    assert.ok(!/href=/i.test(out))
  })

  it('md 渲染：html:false 内联脚本按文本转义、结构正常输出', () => {
    const html = renderMarkdown('# 标题\n\n<script>alert(1)</script>\n\n正文 **加粗**')
    assert.ok(html.includes('<h1>标题</h1>'))
    assert.ok(html.includes('<strong>加粗</strong>'))
    assert.ok(!html.includes('<script>'))
  })

  it('buildReaderDoc 端到端：无脚本残留、相对图片改写为代理地址、含沙箱壳、目录锚点注入', () => {
    const { html: doc, toc } = buildReaderDoc('# t\n\n![pic](./img/a.png)\n\n<script>x</script>\n\n## 小节', '.md', 7, '标题')
    assert.ok(!doc.includes('<script'))
    assert.ok(doc.includes('/api/files/7/asset?rel='))
    assert.ok(doc.includes('base target="_blank"'))
    assert.ok(doc.includes('<!doctype html'))
    assert.equal(toc.length, 2)
    assert.equal(toc[0].text, 't')
    assert.ok(doc.includes(`id="${toc[0].id}"`))
  })
})
