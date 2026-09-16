import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useWikiStore = defineStore('wiki', () => {
  const items = ref<any[]>([])
  const total = ref(0)
  const current = ref<any>(null)
  const loading = ref(false)

  async function fetchEntries(params?: Record<string, string>) {
    loading.value = true
    try {
      const data = await api.wiki.list({ limit: '50', ...params })
      items.value = data.items || []
      total.value = data.total
    } finally {
      loading.value = false
    }
  }

  async function fetchDetail(id: number | string) {
    // 外部独立词条 id 形如 'm12'，走 imported 详情端点（路径挂载读外部卷）
    if (typeof id === 'string' && id.startsWith('m')) {
      current.value = await api.wiki.detailImported(Number(id.slice(1)))
    } else {
      current.value = await api.wiki.detail(Number(id))
    }
  }

  return { items, total, current, loading, fetchEntries, fetchDetail }
})
