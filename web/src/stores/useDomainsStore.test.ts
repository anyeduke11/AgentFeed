import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// removeDomain 的交互契约（删除领域闭环的前端半边）：
// 1) 成功 = 透传后端结果（removed 数量供 toast 文案用）+ 立即刷新领域树（UI 与库一致）
// 2) 失败 = 错误向上抛给 confirmDomDel（由它 toast 报错并保留弹窗），且【不】刷新树——
//    删除没发生时刷新只会掩盖失败（fail loud，不静默假装成功）

const apiMock = vi.hoisted(() => ({
  domains: {
    list: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  }
}))
vi.mock('../api', () => ({ api: apiMock as any }))

const { useDomainsStore } = await import('./useDomainsStore')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

it('删除成功：透传后端结果 + 立即刷新领域树', async () => {
  const store = useDomainsStore()
  apiMock.domains.remove.mockResolvedValue({ success: true, removed: 3 })
  apiMock.domains.list.mockResolvedValue([{ id: 1, name: '新树', children: [] }])

  const stale = [{ id: 7, name: '旧树节点', children: [] }]
  store.tree = stale
  const r = await store.removeDomain(7)

  expect(r).toEqual({ success: true, removed: 3 })
  expect(apiMock.domains.remove).toHaveBeenCalledWith(7)
  expect(apiMock.domains.list).toHaveBeenCalledTimes(1)
  expect(store.tree).toEqual([{ id: 1, name: '新树', children: [] }])
  expect(store.tree).not.toBe(stale)
})

it('删除失败：错误向上抛出且不刷新树', async () => {
  const store = useDomainsStore()
  const before = [{ id: 7, name: '删除前状态', children: [] }]
  store.tree = before
  apiMock.domains.remove.mockRejectedValue(new Error('删除失败，请重试'))

  await expect(store.removeDomain(7)).rejects.toThrow('删除失败，请重试')
  expect(apiMock.domains.list).not.toHaveBeenCalled()
  expect(store.tree).toEqual(before)
})
