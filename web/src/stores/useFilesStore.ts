import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useFilesStore = defineStore('files', () => {
  const items = ref<any[]>([])
  const total = ref(0)
  const page = ref(1)
  const limit = ref(50)
  const filters = ref({ kw: '', domain: '全部', agent: '全部', ext: '全部', status: '全部' })
  const selection = ref<Record<number, boolean>>({})
  const loading = ref(false)

  const selectedIds = () => Object.keys(selection.value).filter(k => selection.value[+k]).map(Number)

  async function fetchFiles() {
    loading.value = true
    try {
      const f = filters.value
      const params: Record<string, string> = {
        page: String(page.value),
        limit: String(limit.value)
      }
      if (f.kw.trim()) params.kw = f.kw.trim()
      if (f.domain !== '全部') params.domain = f.domain
      if (f.agent !== '全部') params.agent = f.agent
      if (f.ext !== '全部') params.type = f.ext
      // 状态映射：全部→active（排除已删除），已删除→deleted，其余转 llm_state 由服务端过滤
      if (f.status === '已删除') params.status = 'deleted'
      else params.status = 'active'
      if (f.status !== '全部' && f.status !== '已删除') {
        const map: Record<string, string> = { '已蒸馏': 'done', '编目中': 'running', '待处理': 'pending', '失败': 'failed', '已跳过': 'skipped' }
        params.state = map[f.status]
      }
      const data = await api.files.list(params)
      items.value = data.items || []
      total.value = data.total
    } finally {
      loading.value = false
    }
  }

  function clearFilters() {
    filters.value = { kw: '', domain: '全部', agent: '全部', ext: '全部', status: '全部' }
    page.value = 1
  }

  async function softDelete(ids: number[]) {
    await api.files.batch(ids, 'delete')
    for (const id of ids) delete selection.value[id]
    await fetchFiles()
  }

  async function restore(ids: number[]) {
    await api.files.batch(ids, 'restore')
    for (const id of ids) delete selection.value[id]
    await fetchFiles()
  }

  async function assignDomain(ids: number[], domainId: number | null) {
    await api.files.batch(ids, 'domain', domainId)
    await fetchFiles()
  }

  async function purgeOne(id: number) {
    await api.files.purgeOne(id)
    delete selection.value[id]
    await fetchFiles()
  }

  async function purgeDeleted() {
    return api.files.purgeDeleted()
  }

  async function redistill(ids: number[]) {
    return api.files.batchLlmTag(ids)
  }

  async function openFile(id: number, source?: string) {
    return api.files.open(id, source)
  }

  async function revealFile(id: number) {
    return api.files.reveal(id)
  }

  async function updateFile(id: number, data: any) {
    await api.files.update(id, data)
    await fetchFiles()
  }

  async function versions(id: number) {
    return api.files.versions(id)
  }

  return { items, total, page, limit, filters, selection, loading, selectedIds, fetchFiles, clearFilters, softDelete, restore, assignDomain, purgeOne, purgeDeleted, redistill, openFile, revealFile, updateFile, versions }
})
