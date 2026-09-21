<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">08</span>
      <h1 class="vtitle">调度室</h1>
      <span class="vsub">扫描根 · AI 队列 · 回收区 · 安全</span>
      <div class="vright">
        <button class="btn sm" @click="refresh"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>
    </div>

    <div class="set-col">
      <!-- 功能区一行 Tab -->
      <div class="tabs">
        <button class="tab" :class="{ on: settingsTab === 'roots' }" @click="settingsTab = 'roots'">扫描根</button>
        <button class="tab" :class="{ on: settingsTab === 'ai' }" @click="settingsTab = 'ai'">AI 设置与队列</button>
        <button class="tab" :class="{ on: settingsTab === 'gate' }" @click="settingsTab = 'gate'">过滤门禁</button>
        <button class="tab" :class="{ on: settingsTab === 'records' }" @click="settingsTab = 'records'">过滤记录</button>
        <button class="tab" :class="{ on: settingsTab === 'deleted' }" @click="settingsTab = 'deleted'">已删除文件</button>
        <button class="tab" :class="{ on: settingsTab === 'security' }" @click="settingsTab = 'security'">局域网与安全</button>
        <button class="tab" :class="{ on: settingsTab === 'profile' }" @click="settingsTab = 'profile'">用户画像</button>
        <button class="tab" :class="{ on: settingsTab === 'logs' }" @click="settingsTab = 'logs'">日志管理</button>
      </div>

      <!-- 按 tab 拆分的子组件：异步加载对应 chunk，KeepAlive 缓存已挂载 tab（切回不重复拉数据） -->
      <KeepAlive>
        <component :is="tabMap[settingsTab]" :refresh-seq="refreshSeq" />
      </KeepAlive>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import Icon from '../components/Icon.vue'

// 七个 tab 各自的子组件（chunk 按需加载，首次切入才拉取）
const SettingsRoots = defineAsyncComponent(() => import('../components/settings/SettingsRoots.vue'))
const SettingsAi = defineAsyncComponent(() => import('../components/settings/SettingsAi.vue'))
const SettingsGate = defineAsyncComponent(() => import('../components/settings/SettingsGate.vue'))
const SettingsGateRecords = defineAsyncComponent(() => import('../components/settings/SettingsGateRecords.vue'))
const SettingsTrash = defineAsyncComponent(() => import('../components/settings/SettingsTrash.vue'))
const SettingsLan = defineAsyncComponent(() => import('../components/settings/SettingsLan.vue'))
const SettingsLogs = defineAsyncComponent(() => import('../components/settings/SettingsLogs.vue'))
const SettingsProfile = defineAsyncComponent(() => import('../components/settings/SettingsProfile.vue'))

const settingsTab = ref<'roots' | 'ai' | 'gate' | 'records' | 'deleted' | 'security' | 'profile' | 'logs'>('roots')

// tab id → 异步子组件映射
const tabMap = {
  roots: SettingsRoots,
  ai: SettingsAi,
  gate: SettingsGate,
  records: SettingsGateRecords,
  deleted: SettingsTrash,
  security: SettingsLan,
  profile: SettingsProfile,
  logs: SettingsLogs,
}

// 刷新序号：递增后各子组件 watch 到变化即重新拉取本 tab 数据（替代原全量 refresh()）
const refreshSeq = ref(0)
function refresh() {
  refreshSeq.value++
}
</script>
