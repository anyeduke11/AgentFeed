import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// 方案 A + 配套修复契约测试（2026-09-22 残留 12% 分析）：
// WHY：候选头部 51-102KB 教案/PRD 全量进 prompt（≈2.5-5 万 tokens）超多数网关上下文，
// flash 与 pro 均 1-token 拒答（归因报告 §7 形态 B）。旧 summarizeContent 头部截断放走
// 51-102KB 档且丢失中后部结论。压缩的安全承诺 = 骨架全保留 + 首末段采样 + 输出恒有上限。
// flash 偶发空响应根因 = thinking 通道吞掉全部输出（text 块空、usage 正常），
// 必须回捞 thinking 而非误报 not_json。隔离：纯函数测试，无 DB。

import { estimateTokens, compressForDistill } from '../src/llm/llmWorker.js'

/** 造 N 节结构化长文：每节 = 标题 + 首段(论点) + 冗长中段(应被省略) + 末段(结论) */
function makeDoc(sections: number, paraChars: number): string {
  const parts: string[] = []
  for (let i = 1; i <= sections; i++) {
    parts.push(
      `## 第${i}节 标题${i}\n\n` +
      `论点${i}：${'甲'.repeat(paraChars)}\n\n` +
      `冗余中段${i}：${'乙'.repeat(paraChars)}\n\n` +
      `结论${i}：${'丙'.repeat(100)}`
    )
  }
  return parts.join('\n\n')
}

describe('estimateTokens：中英混合保守估算', () => {
  test('2.2 chars/token 口径（宁早压缩不爆上下文）', () => {
    assert.equal(estimateTokens('a'.repeat(2200)), 1000)
    assert.ok(estimateTokens('中'.repeat(2200)) > 900, '中文按保守口径不低估')
  })
})

describe('compressForDistill：结构化长文', () => {
  const doc = makeDoc(60, 500) // ≈66K chars ≈3 万 tokens——51-102KB 拒答档同规模
  const out = compressForDistill(doc)

  test('标题骨架全保留（domain/tags 归类依赖结构）', () => {
    for (let i = 1; i <= 60; i++) {
      assert.ok(out.includes(`## 第${i}节 标题${i}`), `第${i}节标题必须在压缩产物中`)
    }
  })

  test('中后部节内容保留——旧头部截断会整段丢失（拒答档救赎的核心价值）', () => {
    const head4000 = doc.slice(0, 4000)
    assert.ok(!head4000.includes('第59节'), '前提自检：第 59 节确实在头部 4000 字之外')
    assert.ok(out.includes('## 第59节 标题59'), '后部标题保留')
    assert.ok(out.includes('论点59'), '后部节首段采样保留')
  })

  test('输出恒有上限（12K chars 安全承诺，任何输入不例外）', () => {
    assert.ok(out.length <= 12 * 1024 + 100, `压缩产物 ${out.length} 必须贴近 12K 上限`)
    // 极端骨架：500 个标题自身就逼近预算，仍不得超限
    const manyHeads = Array.from({ length: 500 }, (_, i) => `## 标题${i}\n\n${'丁'.repeat(2000)}`).join('\n\n')
    assert.ok(compressForDistill(manyHeads).length <= 12 * 1024 + 100, '极端标题数下硬截断兜底')
  })

  test('压缩标记显式告知模型（采样产物非全文）', () => {
    assert.ok(out.includes('原文超长'), '必须携带采样说明')
  })

  test('frontmatter 保留（agent 归因信任序的最高优先来源）', () => {
    const withFm = `---\ntitle: 测试文档\nagent: claude\n---\n\n` + makeDoc(40, 500)
    const r = compressForDistill(withFm)
    assert.ok(r.includes('agent: claude'), 'frontmatter 键值必须保留')
  })
})

describe('compressForDistill：无标题退化（均匀滑窗）', () => {
  test('尾部结论不丢（头部截断的反面）', () => {
    const plain = '开篇导语。' + '戊'.repeat(60 * 1024) + '尾部独有结论标记XYZEND'
    const out = compressForDistill(plain)
    assert.ok(out.includes('XYZEND'), '尾部标记必须在采样产物中')
    assert.ok(out.includes('开篇导语'), '首部同样保留')
    assert.ok(out.length <= 12 * 1024 + 100)
  })
})

describe('compressForDistill：HTML 标题切节', () => {
  test('<h2> 边界识别 + 标签剥除', () => {
    const html = Array.from({ length: 30 }, (_, i) =>
      `<h2>章${i}</h2>\n\n<p>首段${i}</p>\n\n<p>${'己'.repeat(800)}</p>\n\n<p>末段结论${i}</p>`
    ).join('\n\n')
    const out = compressForDistill(html)
    assert.ok(out.includes('<h2>章29</h2>'), 'HTML 标题骨架保留')
    assert.ok(!out.includes('<p>'), '正文采样剥除 HTML 标签')
  })
})

describe('配套修复源码级钉死（镜像 h1TolerantParse 风格）', () => {
  test('buildPrompt 用 token 预算判定替换字节阈值（方案 A 核心）', async () => {
    const fs = await import('fs/promises')
    const src = await fs.readFile(new URL('../src/llm/llmWorker.ts', import.meta.url), 'utf8')
    // WHY：旧 >100KB 字节阈值放走 51-102KB 拒答档；token 预算 60% 触发是压缩的准入口径
    assert.ok(src.includes('estimateTokens(content) > inputBudgetTokens * 0.6'), 'token 预算判定必须存在')
    assert.ok(src.includes('compressForDistill(content, maxChars)'), '超预算必须走结构化压缩且产物按预算动态 sizing')
    assert.ok(!src.includes('MAX_FILE_SIZE'), '旧字节阈值常量必须移除')
    // WHY：DEFAULT_CONTEXT_WINDOW 必须与 ensureModelDef 的 8192 对齐——旧 32768 让压缩触发线
    // 高估 4 倍，8K~34K chars 文件裸送超窗被 1-token 拒答（存量 4018 篇 failed 主因）
    assert.ok(src.includes('const DEFAULT_CONTEXT_WINDOW = 8192'), '默认窗口必须与 pi-ai 模型声明对齐为 8192')
  })

  test('compressMaxChars：产物随预算动态 sizing，8K 窗口下不再恒 12K chars 超窗', async () => {
    const { compressMaxChars } = await import('../src/llm/llmWorker.js')
    // WHY：恒 12K chars ≈ 5.5K tokens 的压缩产物在 8K 窗口 − 2048 输出下装不下——产物本身即超窗源
    const budget8k = 8192 - 2048 - 600 - 1024
    assert.ok(compressMaxChars(budget8k) < 12 * 1024, '8K 预算下产物必须小于 12K 上限')
    assert.ok(compressMaxChars(budget8k) <= Math.floor(budget8k * 2.2), '产物 chars 不得超出预算 token 的反向换算')
    assert.ok(compressMaxChars(100) >= 2000, '极端小预算有下限保护，不把采样切碎')
    assert.equal(compressMaxChars(100000), 12 * 1024, '大窗口模型仍受 12K 上限约束')
  })

  test('callLlm thinking 回捞 + 空响应重试（配套修复①②）', async () => {
    const fs = await import('fs/promises')
    const src = await fs.readFile(new URL('../src/llm/index.ts', import.meta.url), 'utf8')
    // WHY：pi-ai 把 reasoning_content 收进 thinking 块不进 text 块，text 为空≠not_json；
    // 回捞 thinking + 一次重试后仍空才报 empty_llm_response（与 not_json 区分归因）
    assert.ok(src.includes("b.type === 'thinking'"), 'thinking 块回捞必须存在')
    assert.ok(src.includes("throw new Error('empty_llm_response')"), '重试后仍空必须报 empty_llm_response')
  })

  test('调用日志落 stop_reason（配套修复③，失败分桶依据）', async () => {
    const fs = await import('fs/promises')
    const src = await fs.readFile(new URL('../src/llm/llmClient.ts', import.meta.url), 'utf8')
    const dbSrc = await fs.readFile(new URL('../src/db.ts', import.meta.url), 'utf8')
    assert.ok(src.includes('stop_reason'), 'saveCallLog 必须写 stop_reason')
    assert.ok(dbSrc.includes("{ name: 'stop_reason', ddl: 'stop_reason TEXT' }"), 'llm_call_logs 幂等加列必须存在')
  })
})
