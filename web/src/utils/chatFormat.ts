// 助手回答的结构化排版解析（对话可读性层）：
// WHY：LLM 回答自带语义层级（【总标题】/ 一、章节 / •条目 / Step 步骤 / **强调** / `代码`），
// 纯文本平铺 = 信息有结构而呈现无结构。本解析器把语义信号翻译成视觉权重差。
// 安全：纯文本级解析，产出结构化 token 由 Vue 插值渲染（零 v-html）——LLM 输出含
// HTML/脚本也只会被当作普通文本，天然转义，无注入面。
// 降级：任何不匹配的行/片段按原样渲染（解析器只做减法，格式漂移不丢内容）。

export type CfInline = { t: 'plain' | 'bold' | 'code' | 'bracket', text: string }
export type CfBlock =
  | { kind: 'title', inlines: CfInline[] }
  | { kind: 'section', marker: string, inlines: CfInline[] }
  | { kind: 'item', marker: string, inlines: CfInline[] }
  | { kind: 'hr' }
  | { kind: 'blank' }
  | { kind: 'text', inlines: CfInline[] }

/** 章节：中文数字顿号（一、二、…三十、）/ markdown 标题（## x）/ Step·步骤 N */
const SECTION_RE = /^((?:[一二三四五六七八九十]{1,3})、)\s*/
const MD_HEAD_RE = /^(#{1,4})\s+/
const STEP_RE = /^(Step\s*\d+|步骤\s*\d+)([::、.]|\s)/i
/** 条目：•·-–— 圆点类 / ①-⑩ 圈号 / 数字加点顿号（LLM 列表高频形态；阿拉伯数字按条目不按章节——宁少勿滥） */
const ITEM_RE = /^([•·\-–—]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]|\d{1,2}[.、])\s*/
/** 分隔线：三个以上连字符/破折号独占一行 */
const HR_RE = /^(?:-{3,}|—{2,}|_{3,})$/
/** 整行 【…】（≤40 字）或整行 **…**（≤40 字）→ 总标题 */
const BRACKET_TITLE_RE = /^【[^】]{1,40}】$/
const BOLD_TITLE_RE = /^\*\*([^*]{1,40})\*\*$/

/** 行内解析：**加粗** / `代码` / 【引导词】；未闭合标记按字面渲染（流式半截不闪变样式） */
export function tokenizeInline(s: string): CfInline[] {
  const out: CfInline[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'plain', text: buf }); buf = '' } }
  let i = 0
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const j = s.indexOf('**', i + 2)
      if (j > i + 2) { flush(); out.push({ t: 'bold', text: s.slice(i + 2, j) }); i = j + 2; continue }
    }
    if (s[i] === '`') {
      const j = s.indexOf('`', i + 1)
      if (j > i + 1) { flush(); out.push({ t: 'code', text: s.slice(i + 1, j) }); i = j + 1; continue }
    }
    if (s[i] === '【') {
      const j = s.indexOf('】', i + 1)
      if (j > i && j - i <= 42) { flush(); out.push({ t: 'bracket', text: s.slice(i, j + 1) }); i = j + 1; continue }
    }
    buf += s[i]
    i++
  }
  flush()
  return out.length ? out : [{ t: 'plain', text: '' }]
}

/** 按行解析为块结构（标题/章节/条目/分隔线/空行/正文），渲染层一对一映射样式 */
export function parseChat(content: string): CfBlock[] {
  const lines = String(content ?? '').split(/\r?\n/)
  const blocks: CfBlock[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { blocks.push({ kind: 'blank' }); continue }
    if (HR_RE.test(line.trim())) { blocks.push({ kind: 'hr' }); continue }
    // 总标题：整行【…】或整行**…**（短行才是标题，长行是普通强调）
    const bt = line.match(BOLD_TITLE_RE)
    if (BRACKET_TITLE_RE.test(line.trim())) { blocks.push({ kind: 'title', inlines: tokenizeInline(line.trim()) }); continue }
    if (bt) { blocks.push({ kind: 'title', inlines: [{ t: 'plain', text: bt[1] }] }); continue }
    // 章节
    const sec = line.match(SECTION_RE)
    if (sec) { blocks.push({ kind: 'section', marker: sec[1], inlines: tokenizeInline(line.slice(sec[0].length)) }); continue }
    const md = line.match(MD_HEAD_RE)
    if (md) { blocks.push({ kind: 'section', marker: '', inlines: tokenizeInline(line.slice(md[0].length)) }); continue }
    const st = line.match(STEP_RE)
    if (st) { blocks.push({ kind: 'section', marker: st[1], inlines: tokenizeInline(line.slice(st[0].length)) }); continue }
    // 条目（marker 独立着色：钢蓝符号 + 正文默认）
    const it = line.match(ITEM_RE)
    if (it) {
      const marker = it[1]
      // “- ” 破折号形态吃掉尾随空格保持对齐；圈号/圆点原样
      const rest = line.slice(marker.length).replace(/^\s+/, '')
      blocks.push({ kind: 'item', marker: marker.trim() === '-' || marker.trim() === '—' || marker.trim() === '–' ? '·' : marker, inlines: tokenizeInline(rest) })
      continue
    }
    blocks.push({ kind: 'text', inlines: tokenizeInline(line) })
  }
  return blocks.length ? blocks : [{ kind: 'text', inlines: [{ t: 'plain', text: String(content ?? '') }] }]
}
