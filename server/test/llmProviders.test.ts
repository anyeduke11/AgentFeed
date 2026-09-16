import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_PRESETS, mergeProvidersWithPresets, type LlmProvider } from '../src/llm/llmClient.js'

/**
 * 多服务商预设是「覆盖常见国内模型接口 + Ollama 本地接入」承诺的载体：
 * 目录缺失或条目字段不全 = 新服务商在设置页不可见/不可用，直接破坏功能承诺。
 */
describe('PROVIDER_PRESETS 目录完整性', () => {
  it('覆盖七家服务商（六家国内云 + Ollama 本地）', () => {
    const names = PROVIDER_PRESETS.map(p => p.name)
    assert.deepEqual(names, ['sensenova', 'deepseek', 'zhipu', 'moonshot', 'qwen', 'xfyun', 'ollama'])
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
