import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_PRESETS, mergeProvidersWithPresets, friendlyLlmError, type LlmProvider } from '../src/llm/llmClient.js'

/**
 * 多服务商预设是「覆盖常见国内模型接口 + Ollama 本地接入」承诺的载体：
 * 目录缺失或条目字段不全 = 新服务商在设置页不可见/不可用，直接破坏功能承诺。
 */
describe('PROVIDER_PRESETS 目录完整性', () => {
  it('覆盖八家服务商（七家云 + Ollama 本地）', () => {
    const names = PROVIDER_PRESETS.map(p => p.name)
    assert.deepEqual(names, ['sensenova', 'deepseek', 'zhipu', 'moonshot', 'qwen', 'xfyun', 'agnes', 'ollama'])
  })

  it('每个预设都有合法 baseUrl、models 非空（否则该服务商无模型可选）', () => {
    for (const p of PROVIDER_PRESETS) {
      assert.match(p.baseUrl, /^https?:\/\//, `${p.name} baseUrl 应为合法 http(s) 端点`)
      // xfyun 例外：MaaS ModelID 为用户部署服务后专属（服务管控页获取），预设为空由用户填写
      if (p.name === 'xfyun') continue
      assert.ok(p.models && p.models.length > 0, `${p.name} 至少要有一个预设模型`)
    }
  })

  it('xfyun 指向讯飞 MaaS 新版 HTTP 端点（2026-01-10 后发布服务统一使用 v2）', () => {
    const xfyun = PROVIDER_PRESETS.find(p => p.name === 'xfyun')!
    assert.equal(xfyun.baseUrl, 'https://maas-api.cn-huabei-1.xf-yun.com/v2')
    assert.deepEqual(xfyun.models, [])
  })

  it('ollama 指向本地 11434 端点', () => {
    const ollama = PROVIDER_PRESETS.find(p => p.name === 'ollama')!
    assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1')
  })

  it('预设不携带真实密钥（避免源码泄漏）', () => {
    for (const p of PROVIDER_PRESETS) assert.equal(p.apiKey, '', `${p.name} 预设不得内置 apiKey`)
  })
})

/**
 * 合并语义决定设置页展示与入库行为：
 * 用户已配置的条目（如存量 sensenova 的 apiKey）必须原样保留，否则升级即丢配置。
 */
describe('mergeProvidersWithPresets 合并语义', () => {
  it('用户配置优先：apiKey/baseUrl 原样保留，预设只补缺口', () => {
    const configured: LlmProvider[] = [
      { name: 'sensenova', baseUrl: 'https://my-proxy.example/v1', apiKey: 'sk-user-key' },
    ]
    const merged = mergeProvidersWithPresets(configured)
    const sensenova = merged.find(p => p.name === 'sensenova')!
    assert.equal(sensenova.baseUrl, 'https://my-proxy.example/v1')
    assert.equal(sensenova.apiKey, 'sk-user-key')
  })

  it('未配置的服务商用预设补全（保证六家始终可见可配）', () => {
    const merged = mergeProvidersWithPresets([{ name: 'sensenova', baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'k' }])
    assert.equal(merged.length, PROVIDER_PRESETS.length)
    const deepseek = merged.find(p => p.name === 'deepseek')!
    assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/v1')
    assert.ok(deepseek.models!.length > 0)
  })

  it('用户 models 为空时回退预设 models，非空时用户优先', () => {
    const merged = mergeProvidersWithPresets([
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', models: [] },
      { name: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['my-custom-glm'] },
    ])
    assert.deepEqual(merged.find(p => p.name === 'deepseek')!.models, PROVIDER_PRESETS.find(p => p.name === 'deepseek')!.models)
    assert.deepEqual(merged.find(p => p.name === 'zhipu')!.models, ['my-custom-glm'])
  })

  it('用户配置里的未知服务商条目被丢弃（目录外不注册，防止脏数据打爆实例）', () => {
    const merged = mergeProvidersWithPresets([
      { name: 'legacy-garbage', baseUrl: 'https://x/v1', apiKey: '' },
    ] as LlmProvider[])
    assert.ok(!merged.some(p => p.name === 'legacy-garbage'))
  })
})

/**
 * friendlyLlmError 是调用日志排错价值的载体：落库即结构化信封（kind/code/status/message/hint），
 * 用户点开「错误详情」就能看懂失败原因，不必猜内部码或翻服务商文档。
 */
describe('friendlyLlmError 结构化落库', () => {
  /** 解析信封（与前端 parseLlmError 同构）：非 JSON 或缺 kind 视为纯文本回退 */
  function envelope(raw: string): any {
    const o = JSON.parse(raw)
    assert.ok(o.kind === 'provider' || o.kind === 'internal', '信封必须带 kind')
    return o
  }

  it('SenseNova HTTP 错误 → provider 信封：错误码/状态/说明/服务端消息齐全（对齐官方错误码表）', () => {
    const out = friendlyLlmError('429: {"error":{"type":"quota_exceeded_error","code":"3","message":"rpm exhausted"}}')
    const e = envelope(out)
    assert.equal(e.kind, 'provider')
    assert.equal(e.code, 'quota_exceeded_error')
    assert.equal(e.status, 429)
    assert.equal(e.message, 'rpm exhausted')
    assert.match(e.hint, /速率|额度/)
    assert.equal(e.raw, undefined, '短响应原文不重复落库')
  })

  it('400 invalid_request_error 等无 status 前缀的 type 错误也能命中提示', () => {
    const e = envelope(friendlyLlmError('{"error":{"type":"failed_precondition_error","message":"engine unavailable"}}'))
    assert.equal(e.code, 'failed_precondition_error')
    assert.match(e.hint, /前置条件/)
  })

  it('内部错误码 → internal 信封 + 中文说明（用户不再面对裸 llm_output_not_json）', () => {
    const e = envelope(friendlyLlmError('llm_output_not_json'))
    assert.equal(e.kind, 'internal')
    assert.equal(e.code, 'llm_output_not_json')
    assert.match(e.hint, /JSON/)
    // 带明细后缀的治理错误（tagGovernance llm_json_parse_failed: <预览>）保留明细
    const e2 = envelope(friendlyLlmError('llm_json_parse_failed: {"secondary":["截'))
    assert.equal(e2.code, 'llm_json_parse_failed')
    assert.match(e2.message, /secondary/)
  })

  it('网络层失败归入 network_error 并给出排查方向', () => {
    const e = envelope(friendlyLlmError('fetch failed: ECONNRESET'))
    assert.equal(e.kind, 'internal')
    assert.equal(e.code, 'network_error')
    assert.match(e.hint, /网络/)
  })

  it('数字前缀但 body 非 JSON → 按状态码命中提示（code=http_429，仍可读）', () => {
    const e = envelope(friendlyLlmError('429: something weird happened'))
    assert.equal(e.kind, 'provider')
    assert.equal(e.code, 'http_429')
    assert.equal(e.status, 429)
    assert.match(e.hint, /速率|额度/)
  })

  it('完全无法识别的错误保留纯文本（旧行为兼容，前端回退原展示）', () => {
    const out = friendlyLlmError('some weird failure without status or json')
    assert.equal(out, 'some weird failure without status or json')
    assert.equal(envelopeSafe(out), false)
  })
})

/** 是否为结构化信封（纯文本回退应返回 false） */
function envelopeSafe(raw: string): boolean {
  try { const o = JSON.parse(raw); return o && (o.kind === 'provider' || o.kind === 'internal') } catch { return false }
}
