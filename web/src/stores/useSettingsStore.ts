import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<Record<string, any>>({})
  const loading = ref(false)
  const roots = ref<any[]>([])
  const scanStatus = ref<any>({ watcherRunning: false, lastScan: null })
  const scanJobs = ref<any[]>([])
  const scanJobsTotal = ref(0)

  async function fetchConfig() {
    loading.value = true
    try {
      config.value = await api.config.get()
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(data: Record<string, { value: any }>) {
    await api.config.set(data)
    await fetchConfig()
  }

  async function fetchRoots() {
    roots.value = await api.scan.roots()
  }

  async function fetchScanStatus() {
    scanStatus.value = await api.scan.status()
  }

  async function fetchScanJobs() {
    const r = await api.scan.jobs()
    scanJobs.value = r.items || []
    scanJobsTotal.value = r.total || scanJobs.value.length
  }

  async function addRoot(path: string) {
    const r = await api.scan.addRoot(path)
    await fetchRoots()
    return r
  }

  async function removeRoot(id: number) {
    await api.scan.removeRoot(id)
    await fetchRoots()
  }

  async function toggleRoot(id: number, enabled: boolean) {
    await api.scan.updateRoot(id, enabled)
    await fetchRoots()
  }

  async function rescanRoot(id: number) {
    return api.scan.rescanRoot(id)
  }

  return { config, loading, roots, scanStatus, scanJobs, scanJobsTotal, fetchConfig, updateConfig, fetchRoots, fetchScanStatus, fetchScanJobs, addRoot, removeRoot, toggleRoot, rescanRoot }
})
