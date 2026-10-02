import { describe, test, expect } from 'vitest'
import { parseChat, tokenizeInline } from './chatFormat'

// WHY：对话可读性 = 视觉层级映射语义层级。钉死三件事：
// ① 语义信号正确分块（【标题】/一、章节/•条目/Step/分隔线）——错分 = 层级失真回退平铺
// ② 行内强调 token 化（**粗**/`码`/【括号】）——漏解析 = 星号反引号裸露
// ③ 降级安全：未闭合标记/HTML 文本按字面渲染（解析器只做减法，格式漂移不丢内容、无注入面）

describe('parseChat 块级解析', () => {
  test('真实回答样例：标题/章节/条目/正文各归其位', () => {
    const md = [
      '【「人工智能」领域速览】',
      '',
      '一、领域规模与总体定位',
      '该领域共有 12036 篇可注入词条。',
      '',
      '二、Top 10 词条构成的知识版图',
      '• 评估模型：三层评估架构',
      '② 动手实践 / RAG + Agent 系统',
      '',
      'Step 1 → 先动手搭系统',
      '--------------------------------',
    ].join('\n')
    const blocks = parseChat(md)
    expect(blocks.map(b => b.kind)).toEqual([
      'title', 'blank', 'section', 'text', 'blank', 'section', 'item', 'item', 'blank', 'section', 'hr',
    ])
    expect((blocks[0] as any).inlines[0].text).toBe('【「人工智能」领域速览】')
    expect((blocks[2] as any).marker).toBe('一、')
    expect((blocks[6] as any).marker).toBe('•')
    expect((blocks[7] as any).marker).toBe('②')
  })

  test('整行 **…**（短）= 标题；markdown ## = 章节（marker 置空）', () => {
    const blocks = parseChat('**第 1 题（威胁分类）**\n## 防御体系\n正文')
    expect(blocks[0].kind).toBe('title')
    expect((blocks[0] as any).inlines[0].text).toBe('第 1 题（威胁分类）')
    expect(blocks[1].kind).toBe('section')
    expect((blocks[1] as any).marker).toBe('')
    expect(blocks[2].kind).toBe('text')
  })

  test('阿拉伯数字按条目不按章节（LLM 列表高频形态）；长破折号列表项归一为 ·', () => {
    const blocks = parseChat('1. 第一项\n2. 第二项\n- 短横条目')
    expect(blocks.every(b => b.kind === 'item')).toBe(true)
    expect((blocks[2] as any).marker).toBe('·')
  })

  test('降级：普通多行文本全部 text/blank，内容逐字保留', () => {
    const plain = '第一行普通文本\n\n第二行 <script>alert(1)</script> 结束'
    const blocks = parseChat(plain)
    expect(blocks.map(b => b.kind)).toEqual(['text', 'blank', 'text'])
    const all = blocks.flatMap((b: any) => (b.inlines || []).map((x: any) => x.text)).join('')
    // HTML 必须按字面保留为纯文本（插值渲染天然转义）
    expect(all).toContain('<script>alert(1)</script>')
  })
})

describe('tokenizeInline 行内解析', () => {
  test('粗体/代码/括号 token 化与混排顺序', () => {
    const t = tokenizeInline('前文 **重点** 中段 `SELECT 1` 尾部【注意】完')
    expect(t.map(x => x.t)).toEqual(['plain', 'bold', 'plain', 'code', 'plain', 'bracket', 'plain'])
    expect(t[1].text).toBe('重点')
    expect(t[3].text).toBe('SELECT 1')
    expect(t[5].text).toBe('【注意】')
  })

  test('未闭合标记按字面渲染（流式半截 ** 不吞字符）', () => {
    const t = tokenizeInline('半截 **未闭合 和单 `反引号')
    const joined = t.map(x => x.text).join('')
    expect(joined).toBe('半截 **未闭合 和单 `反引号')
    expect(t.every(x => x.t === 'plain')).toBe(true)
  })

  test('空串与纯标记边界不崩', () => {
    expect(tokenizeInline('')).toEqual([{ t: 'plain', text: '' }])
    // 空消息解析为零高度空块（渲染不占行）
    expect(parseChat('')).toEqual([{ kind: 'blank' }])
  })
})
