import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useLlmStore = defineStore('llm', () => {
  const queue = ref<any>({ pending: [], running: [], failed: [], skipped: [], paused: false, concurrency: 2, counts: { pending: 0, running: 0, failed: 0, skipped: 0 } })
  const logs = ref<any[]>([])
  const providers = ref<any>({ providers: [], defaultProvider: '', defaultModel: '' })
  const loading = ref(false)

  async function fetchQueue() {
    queue.value = await api.llm.queue()
    return queue.value
  }

  async function fetchLogs() {
    loading.value = true
    try {
      const data = await api.llm.logs({ page: '1', limit: '5' })
      logs.value = data.items || []
    } finally {
      loading.value = false
    }
  }

  async function fetchProviders() {
    providers.value = await api.llm.providers()
  }

  async function pause() { await api.llm.pause(); await fetchQueue() }
  async function resume() { await api.llm.resume(); await fetchQueue() }
  async function setConcurrency(n: number, provider?: string) { await api.llm.setConcurrency(n, provider); await fetchQueue() }
  async function retry(fileId: number) { await api.llm.retry(fileId); await fetchQueue() }
  async function retryAll() { return api.llm.retryAll() }

  return { queue, logs, providers, loading, fetchQueue, fetchLogs, fetchProviders, pause, resume, setConcurrency, retry, retryAll }
})
