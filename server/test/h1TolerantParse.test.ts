import { test } from 'node:test'
import assert from 'node:assert/strict'

// H1 修法①②（2026-09-22 归因报告 §6）契约测试：
// WHY：96.8% 失败为 parse 类、1.53 亿 token 浪费的根因是截断容错缺失——
// 形态 A（无闭合 } 残缺 JSON）与形态 C（围栏/空白）必须被宽容提取救回，
// 形态 B（短拒答）必须报 content_too_long_for_model 而非 not_json（防 74% 死循环重试），
// 输出预算指令必须在长输入时出现。safeParseWikiJson 是私有函数——经 distill 产物
// 无法直测，故导出点检查 + 行为经既有 e2e 覆盖；核心宽容逻辑用等价重实现钉口径。
// 隔离：纯函数测试，无 DB。

// 与 llmWorker.safeParseWikiJson 相同的宽容提取算法（口径镜像——实现处修改须同步此处）
function tolerantParse(text: string): { title: string, summary: string } {
  const parseObj = (body: string): Record<string, any> | null => {
    try { return JSON.parse(body) } catch { return null }
  }
  let obj: Record<string, any> | null = null
  const closed = text.match(/\{[\s\S]*\}/)
  if (closed) obj = parseObj(closed[0])
  if (!obj) {
    const open = text.indexOf('{')
    if (open >= 0) {
      const tail = text.slice(open)
      obj = parseObj(tail + '"}')
      if (!obj) {
        const out: Record<string, any> = {}
        for (const m of tail.matchAll(/"(title|summary|domain)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
          out[m[1]] = m[2]
        }
        if (out.title || out.summary) obj = out
      }
    }
  }
  return { title: String(obj?.title || '').trim(), summary: String(obj?.summary || '').trim() }
}

test('形态 A：截断残缺 JSON（title/summary 已完整、points 处断）宽容提取救回', () => {
  const truncated = '\n\n{"title":"NeoData 金融数据 MCP","summary":"基于结构化参数的金融数据查询服务，提供 81 个数据工具。","points":["81 个数据工具覆盖全品类","统一代码体系","支持 output_fields 字段裁' // 无闭合
  const r = tolerantParse(truncated)
  assert.equal(r.title, 'NeoData 金融数据 MCP', 'title 必须救回（截断前已完整）')
  assert.ok(r.summary.length > 10, 'summary 必须救回')
})

test('形态 A 变体：截断发生在 summary 字符串中途', () => {
  const truncated = '{"title":"标题完整","summary":"摘要写到一半被截'
  const r = tolerantParse(truncated)
  assert.equal(r.title, '标题完整', 'title 救回')
  // summary 截断无法完整恢复——不要求非空，title 达标即不整单作废（processDistill 判定 title||summary）
})

test('形态 C：围栏与前导空白（既有正则已处理，回归钉死）', () => {
  const fenced = '\n\n```json\n{"title":"围栏样本","summary":"摘要"}\n```'
  assert.equal(tolerantParse(fenced).title, '围栏样本')
  const plain = '{"title":"裸样本","summary":"摘要"}'
  assert.equal(tolerantParse(plain).title, '裸样本')
})

test('形态 B：无 JSON 的短拒答文本 → 全空结果（供上游报 content_too_long）', () => {
  const refusal = '抱歉，提供的内容过长，我无法处理。'
  const r = tolerantParse(refusal)
  assert.equal(r.title, '')
  assert.equal(r.summary, '', '无 JSON 短文本必须全空——上游据此区分拒答（短）与截断失败（长）')
})

test('完全无花括号 → 全空（不抛错）', () => {
  const r = tolerantParse('纯文本回答没有任何花括号')
  assert.equal(r.title, '')
})

test('修法②口径：5KB+ 输入的输出预算指令存在性（源码级钉死）', async () => {
  const fs = await import('fs/promises')
  const src = await fs.readFile(new URL('../src/llm/llmWorker.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('size > 5000'), '输出预算阈值 5000 必须在 buildPrompt 中')
  assert.ok(src.includes('summary 不超过 200 字'), '预算指令文案钉死（改动需同步归因报告）')
  assert.ok(src.includes('content_too_long_for_model'), '形态 B 准确报错码必须在 processDistill 中')
  // 短拒答判定阈值 200：completion tokens 或文本长度
  assert.ok(src.includes('< 200'), '短响应阈值 200 存在')
})

test('修法③补丁：拒答不计入 triage 熔断连败（源码级钉死）', async () => {
  const fs = await import('fs/promises')
  const src = await fs.readFile(new URL('../src/llm/llmWorker.ts', import.meta.url), 'utf8')
  // WHY：治愈验证实测——候选头部超长文件扎堆拒答（content_too_long_for_model）被计入连败，
  // 5 次即熔断把同批 35+ 个可救样本腰斩。拒答是内容性失败（零 token、换样本有救），
  // 不是「坏 provider 系统性故障」，熔断计数必须排除它。
  assert.ok(
    src.includes("job.options?.origin === 'triage' && error !== 'content_too_long_for_model'"),
    'triage 熔断计数必须排除 content_too_long_for_model'
  )
})

test('修法④口径：callLlm 显式 maxTokens（源码级钉死）', async () => {
  const fs = await import('fs/promises')
  const src = await fs.readFile(new URL('../src/llm/index.ts', import.meta.url), 'utf8')
  // WHY：pi-ai 不传 maxTokens 时请求体不带 max_tokens，SenseNova 网关按自家默认（实测 ~250）
  // 硬掐输出——形态 A 截断的物理根源。重放复现：250 tokens 处掐断在 points 数组中段。
  assert.ok(src.includes('maxTokens: 4096'), 'callLlm 必须显式传 maxTokens 防网关默认掐断')
})
