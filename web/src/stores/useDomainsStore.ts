import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useDomainsStore = defineStore('domains', () => {
  const tree = ref<any[]>([])
  const loading = ref(false)
  const domOpen = ref<Record<number, boolean>>({})

  const zhColl = new Intl.Collator('zh')
  /** 展示序：同级按名称拼音（ICU zh）升序，递归作用于子级——与标签墙「主要（一级）」排序口径一致 */
  function sortTree(list: any[]): any[] {
    return [...list]
      .sort((a, b) => zhColl.compare(String(a.name), String(b.name)))
      .map(n => (n.children?.length ? { ...n, children: sortTree(n.children) } : n))
  }

  async function fetchDomains() {
    loading.value = true
    try {
      tree.value = sortTree(await api.domains.list())
    } finally {
      loading.value = false
    }
  }

  async function createDomain(data: any) {
    const r = await api.domains.create(data)
    if (r?.success === false) return r
    await fetchDomains()
    return r
  }

  async function updateDomain(id: number, data: any) {
    const r = await api.domains.update(id, data)
    if (r?.success === false) return r
    await fetchDomains()
    return r
  }

  async function removeDomain(id: number) {
    const r = await api.domains.remove(id)
    await fetchDomains()
    return r
  }

  function findNode(id: number): { node: any; siblings: any[] } | null {
    const walk = (list: any[]): { node: any; siblings: any[] } | null => {
      for (const n of list) {
        if (n.id === id) return { node: n, siblings: list }
        const hit = n.children?.length ? walk(n.children) : null
        if (hit) return hit
      }
      return null
    }
    return walk(tree.value)
  }

  function toggleOpen(id: number) {
    domOpen.value[id] = domOpen.value[id] === false
  }

  /** 上移/下移：交换后按新顺序重写同级 sort */
  async function move(id: number, dir: -1 | 1) {
    const hit = findNode(id)
    if (!hit) return
    const idx = hit.siblings.findIndex(n => n.id === id)
    const j = idx + dir
    if (j < 0 || j >= hit.siblings.length) return
    const arr = [...hit.siblings]
    ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
    await Promise.all(arr.map((n, i) => api.domains.update(n.id, { sort: i })))
    await fetchDomains()
  }

  return { tree, loading, domOpen, fetchDomains, createDomain, updateDomain, removeDomain, findNode, toggleOpen, move }
})
