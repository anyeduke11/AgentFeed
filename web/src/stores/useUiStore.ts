import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export interface ModalState {
  type: 'domain' | 'redistill' | 'domdel' | 'purge' | 'assign' | 'wikiImport' | 'rate'
  opts?: Record<string, any>
}

export const useUiStore = defineStore('ui', () => {
  const toastMsg = ref('')
  const toastOn = ref(false)
  const toastTimer = ref<ReturnType<typeof setTimeout> | null>(null)

  const modal = ref<ModalState | null>(null)
  const drawerFileId = ref<number | null>(null)
  const density = ref<'normal' | 'compact'>('normal')
  const queuePaused = ref(false)
  const menuOpen = ref(false)

  function toast(msg: string) {
    toastMsg.value = msg
    toastOn.value = true
    if (toastTimer.value) clearTimeout(toastTimer.value)
    toastTimer.value = setTimeout(() => { toastOn.value = false }, 2400)
  }

  function openModal(type: ModalState['type'], opts?: Record<string, any>) {
    modal.value = { type, opts: opts || {} }
  }
  function closeModal() {
    modal.value = null
  }

  function openDrawer(fileId: number) {
    drawerFileId.value = fileId
  }
  function closeDrawer() {
    drawerFileId.value = null
  }

  function toggleDensity() {
    density.value = density.value === 'normal' ? 'compact' : 'normal'
    document.body.classList.toggle('compact', density.value === 'compact')
    toast(density.value === 'compact' ? '已切换为紧凑视图' : '已切换为标准视图')
  }

  async function togglePause() {
    const r = queuePaused.value ? await api.llm.resume() : await api.llm.pause()
    queuePaused.value = !!r?.paused
    toast(queuePaused.value ? '队列已暂停 · 进行中的精炼已挂起' : '队列已恢复 · 精炼继续')
  }

  function toggleMenu(force?: boolean) {
    menuOpen.value = typeof force === 'boolean' ? force : !menuOpen.value
  }

  return { toastMsg, toastOn, modal, drawerFileId, density, queuePaused, menuOpen, toast, openModal, closeModal, openDrawer, closeDrawer, toggleDensity, togglePause, toggleMenu }
})
