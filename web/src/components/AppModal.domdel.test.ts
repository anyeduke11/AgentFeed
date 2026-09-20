import { beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 删除领域弹窗（domdel）的交互边界——钉住 confirmDomDel 对异常路径的态度：
// 成功 → 反馈文案区分「单领域 / 含子领域」并关弹窗；
// 失败 → 错误可见（toast）、弹窗保留（用户可重试），绝不静默关闭假装成功；
// 找不到目标领域 → 直接关弹窗，不打后端。

const apiMock = vi.hoisted(() => ({
  domains: {
    list: vi.fn(async () => []),
    remove: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  files: { list: vi.fn(async () => ({ items: [], total: 0 })) },
  llm: { pause: vi.fn(async () => ({})), resume: vi.fn(async () => ({})) }
}))
vi.mock('../api', () => ({ api: apiMock as any }))

const { default: AppModal } = await import('./AppModal.vue')
const { useUiStore } = await import('../stores/useUiStore')
const { useDomainsStore } = await import('../stores/useDomainsStore')

let ui: any
let domains: any
let toastSpy: any

function openDomdel(id: number) {
  ui.openModal('domdel', { id })
  return mount(AppModal, { global: { plugins: [(vi as any)._pinia!] } })
}

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  ;(vi as any)._pinia = pinia
  vi.clearAllMocks()
  ui = useUiStore()
  domains = useDomainsStore()
  toastSpy = vi.spyOn(ui, 'toast')
})

async function clickConfirm(wrapper: any) {
  const btn = wrapper.findAll('button').find((b: any) => b.text().includes('确认删除'))
  expect(btn, 'domdel 弹窗必须渲染「确认删除」按钮').toBeTruthy()
  await btn!.trigger('click')
  await flushPromises()
}

it('删除成功（单领域）：toast 反馈回归未分类 + 弹窗关闭 + 刷新树', async () => {
  domains.tree = [{ id: 7, name: '云原生', children: [] }]
  apiMock.domains.remove.mockResolvedValue({ success: true, removed: 1 })
  const wrapper = openDomdel(7)

  await clickConfirm(wrapper)

  expect(apiMock.domains.remove).toHaveBeenCalledWith(7)
  expect(toastSpy).toHaveBeenCalledWith('已删除领域「云原生」，名下文件已回归未分类')
  expect(ui.modal).toBeNull()
  expect(apiMock.domains.list).toHaveBeenCalledTimes(1)
})

it('删除成功（含子领域）：toast 必须交代子领域一并删除', async () => {
  domains.tree = [{ id: 7, name: '云原生', children: [{ id: 8, name: 'k8s', children: [] }, { id: 9, name: '服务网格', children: [] }] }]
  apiMock.domains.remove.mockResolvedValue({ success: true, removed: 3 })
  const wrapper = openDomdel(7)

  await clickConfirm(wrapper)

  const msg = toastSpy.mock.calls[0][0] as string
  expect(msg).toContain('含 2 个子领域')
  expect(msg).toContain('回归未分类')
  expect(ui.modal).toBeNull()
})

it('删除失败：错误 toast + 弹窗保留（可重试），不静默关闭', async () => {
  domains.tree = [{ id: 7, name: '云原生', children: [] }]
  apiMock.domains.remove.mockRejectedValue(new Error('服务不可用'))
  const wrapper = openDomdel(7)

  await clickConfirm(wrapper)

  expect(toastSpy).toHaveBeenCalledWith('服务不可用')
  expect(ui.modal).not.toBeNull()
  expect(ui.modal?.type).toBe('domdel')
  expect(apiMock.domains.list).not.toHaveBeenCalled()
})

it('目标领域不存在（findNode 落空）：直接关弹窗，不打删除接口', async () => {
  domains.tree = []
  const wrapper = openDomdel(999)

  await clickConfirm(wrapper)

  expect(apiMock.domains.remove).not.toHaveBeenCalled()
  expect(toastSpy).not.toHaveBeenCalled()
  expect(ui.modal).toBeNull()
})
