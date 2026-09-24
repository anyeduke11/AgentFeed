<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">06</span>
      <h1 class="vtitle">发车区</h1>
      <span class="vsub">{{ vsub }}</span>
      <div class="vright">
        <button class="btn sm" @click="refresh"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>
    </div>

    <!-- 视图级双 Tab -->
    <div class="tabs" style="margin-bottom:14px">
      <button class="tab" :class="{ on: viewTab === 'agent' }" @click="viewTab = 'agent'">Agent 供给</button>
      <button class="tab" :class="{ on: viewTab === 'reading' }" @click="viewTab = 'reading'">人工阅读</button>
    </div>

    <!-- 显式子组件变体（vercel-composition-patterns · patterns-explicit-variants）：
         Agent 供给 / 人工阅读 两个独立内聚域，各自管理自己的状态与拉取；
         KeepAlive 缓存已挂载 tab，切回不重复初始化 -->
    <KeepAlive>
      <AgentSupplyPanel v-if="viewTab === 'agent'" ref="agentPanel" />
      <ReadingPanel v-else ref="readingPanel" />
    </KeepAlive>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AgentSupplyPanel from '../components/supply/AgentSupplyPanel.vue'
import ReadingPanel from '../components/supply/ReadingPanel.vue'

const viewTab = ref<'agent' | 'reading'>('agent')
const agentPanel = ref<InstanceType<typeof AgentSupplyPanel> | null>(null)
const readingPanel = ref<InstanceType<typeof ReadingPanel> | null>(null)

const vsub = computed(() => viewTab.value === 'agent'
  ? 'MCP 供给 · 工具与客户端挂载'
  : '人工阅读 · 冷启动推荐与阅读闭环')

// 切到人工阅读时惰性初始化（原 initReading 语义：首次切入才拉数据，KeepAlive 后切回不重复）
watch(viewTab, t => { if (t === 'reading') readingPanel.value?.init() })

async function refresh() {
  if (viewTab.value === 'agent') {
    await agentPanel.value?.refresh()
  } else {
    await readingPanel.value?.refresh()
  }
}
</script>
