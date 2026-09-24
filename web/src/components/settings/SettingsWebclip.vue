<template>
  <!-- 网页剪藏：存储目录（自动注册为扫描根，agent=webclip） -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">网页剪藏</h2><span class="sect-en">Web Clip</span></div>
    <div class="frow1" style="gap:10px">
      <input class="inp" style="flex:1" v-model="webclipRoot" type="text" placeholder="/Users/you/Documents/AgentFeed-WebClips（绝对路径）" aria-label="剪藏目录" />
      <button class="btn sm" :disabled="webclipSaving" @click="saveWebclipRoot">{{ webclipSaving ? '保存中…' : '保存' }}</button>
    </div>
    <div class="cap" style="margin-top:8px">
      {{ webclipCfg.storageRoot ? `当前：${webclipCfg.storageRoot}` : '未配置' }}
      · {{ webclipCfg.rootRegistered ? '已注册为扫描根' : '未注册' }}
      · Playwright {{ webclipCfg.playwrightReady ? '就绪' : '未安装' }}
    </div>
    <div v-if="webclipMsg" class="cap" :style="{ color: webclipMsg.ok ? 'var(--ok)' : 'var(--fail)' }">{{ webclipMsg.msg }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '../../api'

const props = defineProps<{ refreshSeq?: number }>()

const webclipRoot = ref('')
const webclipSaving = ref(false)
const webclipMsg = ref<{ ok: boolean; msg: string } | null>(null)
const webclipCfg = ref<any>({ storageRoot: null, rootRegistered: false, playwrightReady: false })

async function loadWebclipCfg() {
  try {
    webclipCfg.value = await api.webclip.getConfig()
    webclipRoot.value = webclipCfg.value.storageRoot || ''
  } catch { /* 网络错误静默，占位提示 */ }
}

async function saveWebclipRoot() {
  const v = webclipRoot.value.trim()
  if (!v) { webclipMsg.value = { ok: false, msg: '请输入绝对路径' }; return }
  webclipSaving.value = true
  webclipMsg.value = null
  try {
    const r = await api.webclip.putConfig(v)
    if (r.success) { webclipMsg.value = { ok: true, msg: '已保存并注册为扫描根（agent=webclip）' }; await loadWebclipCfg() }
    else webclipMsg.value = { ok: false, msg: r.message || '保存失败' }
  } catch (e: any) {
    webclipMsg.value = { ok: false, msg: `保存失败：${e?.message || e}` }
  } finally {
    webclipSaving.value = false
  }
}

// 父层「刷新」按钮递增 refreshSeq：重拉本 tab 配置（与各设置子面板同一机制）
watch(() => props.refreshSeq, loadWebclipCfg)

onMounted(loadWebclipCfg)
</script>
