import { beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 领域卡「次要标签 TOP3」的展示契约（分拣区领域卡细化的验收线）：
// 1) 只挂靠本领域（parent_name 与领域同名锚点）的 secondary 标签才进卡，别家的不算；
// 2) 组内按挂载数倒序只取前 3——领域卡是导览不是全量清单，长列表会淹没领域本身；
// 3) chevron 只在「有标签或有子领域」时出现——空开关是误导；
// 4) 开合必须真实可逆（收起清空展开区，再展开恢复）；
// 5) 标签接口挂掉只做静默降级（无标签行），绝不能波及子领域与整卡渲染——标签是增强信息不是依赖。

const apiMock = vi.hoisted(() => ({
  domains: { list: vi.fn(async (): Promise<any[]> => []) },
  tags: { list: vi.fn(async (): Promise<{ items: any[]; total: number }> => ({ items: [], total: 0 })) }
}))
vi.mock('../../api', () => ({ api: apiMock as any }))

const pushSpy = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushSpy }) }))

const { default: DomainTreePanel } = await import('./DomainTreePanel.vue')

/** 挂靠到「云原生」的次要标签样例（file_count 乱序，含跨领域/未挂靠干扰项） */
const SEC_TAGS: any[] = [
  { id: 1, name: '服务网格', level: 'secondary', parent_name: '云原生', file_count: 320 },
  { id: 2, name: '容器编排', level: 'secondary', parent_name: '云原生', file_count: 1200 },
  { id: 3, name: '可观测性', level: 'secondary', parent_name: '云原生', file_count: 860 },
  { id: 4, name: '镜像安全', level: 'secondary', parent_name: '云原生', file_count: 90 },
  { id: 5, name: '声明式API', level: 'secondary', parent_name: '云原生', file_count: 15 },
  { id: 6, name: '对齐与评测', level: 'secondary', parent_name: '人工智能', file_count: 500 },
  { id: 7, name: '孤儿标签', level: 'secondary', parent_name: null, file_count: 999 }
]

function mountPanel(tree: any[]) {
  // 组件 onMounted 会 fetchDomains 用接口数据重建树——树必须走 api mock 提供，手工赋值会被覆盖
  apiMock.domains.list.mockResolvedValue(tree)
  return mount(DomainTreePanel, { global: { plugins: [(vi as any)._pinia!] } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  ;(vi as any)._pinia = (vi as any)._pinia || createPinia()
  setActivePinia((vi as any)._pinia)
  vi.clearAllMocks()
  apiMock.domains.list.mockResolvedValue([])
  apiMock.tags.list.mockResolvedValue({ items: SEC_TAGS, total: SEC_TAGS.length })
})

it('TOP3 选拔：只显示挂载前 3 的挂靠标签，倒序排列并千分位展示', async () => {
  const tree = [{ id: 7, name: '云原生', children: [] }]
  const wrapper = mountPanel(tree)
  await flushPromises()

  const names = wrapper.findAll('.domchild .dc-name').map(n => n.text())
  expect(names).toEqual(['容器编排', '可观测性', '服务网格']) // 1200 > 860 > 320，第 4/5 名被截断
  expect(wrapper.text()).toContain('1,200') // 千分位口径
  expect(wrapper.text()).toContain('次要标签 · 按挂载 TOP3')
})

it('分组锚点：只收 parent_name 与领域同名的标签，跨领域与未挂靠的不串卡', async () => {
  const tree = [{ id: 7, name: '云原生', children: [] }]
  const wrapper = mountPanel(tree)
  await flushPromises()

  const text = wrapper.find('.domcard').text()
  expect(text).not.toContain('对齐与评测') // 挂靠在「人工智能」名下
  expect(text).not.toContain('孤儿标签') // 未挂靠（parent_name 为空）
})

it('chevron 门控：无标签且无子领域 → 不渲染开关与展开区', async () => {
  apiMock.tags.list.mockResolvedValue({ items: [], total: 0 })
  const tree = [{ id: 7, name: '云原生', children: [] }]
  const wrapper = mountPanel(tree)
  await flushPromises()

  expect(wrapper.find('.dom-top .icon-btn').exists()).toBe(false)
  expect(wrapper.find('.dom-children').exists()).toBe(false)
})

it('开合可逆：收起清空展开区，再展开完整恢复', async () => {
  const tree = [{ id: 7, name: '云原生', children: [] }]
  const wrapper = mountPanel(tree)
  await flushPromises()

  const toggle = wrapper.find('.dom-top .icon-btn')
  expect(wrapper.findAll('.domchild').length).toBe(3)

  await toggle.trigger('click')
  expect(wrapper.find('.dom-children').exists()).toBe(false)

  await wrapper.find('.dom-top .icon-btn').trigger('click')
  expect(wrapper.findAll('.domchild').length).toBe(3)
})

it('标签接口失败：静默降级为无标签卡，子领域与操作不受影响', async () => {
  apiMock.tags.list.mockRejectedValue(new Error('tags 服务不可用'))
  const tree = [{ id: 7, name: '云原生', children: [{ id: 8, name: 'k8s', children: [] }] }]
  const wrapper = mountPanel(tree)
  await flushPromises()

  // 不抛错、无标签行，但子领域与卡片操作按钮完整
  expect(wrapper.findAll('.domchild .dc-name').map(n => n.text())).toEqual(['k8s'])
  expect(wrapper.findAll('.dom-acts .icon-btn').length).toBeGreaterThan(0)
  expect(wrapper.text()).not.toContain('次要标签')
})
