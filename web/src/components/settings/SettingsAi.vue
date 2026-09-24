<template>
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">AI 设置与队列</h2><span class="sect-en">AI & Queue</span><div class="sright"><span class="cap">OpenAI 兼容 · 本地优先</span></div></div>
    <div class="tabs" style="padding:10px 14px 0">
      <button v-for="t in TABS" :key="t.v" class="tab" :class="{ on: aiTab === t.v }" @click="switchTab(t.v)">{{ t.label }}</button>
    </div>
    <!-- 显式子组件变体（vercel-composition-patterns · patterns-explicit-variants）：
         服务商与队列 / Ollama 模型 / 蒸馏池 三个独立内聚域；
         切入各 tab 时惰性拉取（switchTab 内 onEnter 回调），KeepAlive 不适用（v-if 已天然卸载） -->
    <ProvidersPanel v-if="aiTab === 'providers'" ref="providersPanel" />
    <OllamaPanel v-else-if="aiTab === 'ollama'" @saved="providersPanel?.refresh()" />
    <NodesPanel v-else />
  </div>
</template>

<script setup lang="ts">
// AI 设置与队列：三 tab 壳组件（原 675 行拆分）。
// 壳只管 tab 状态与切入时的数据触发；各面板自管状态与拉取。
import { ref } from 'vue'
import ProvidersPanel from './ai/ProvidersPanel.vue'
import OllamaPanel from './ai/OllamaPanel.vue'
import NodesPanel from './ai/NodesPanel.vue'

const TABS = [
  { v: 'providers', label: '服务商与队列' },
  { v: 'ollama', label: 'Ollama 模型' },
  { v: 'nodes', label: '蒸馏池' }
] as const

const aiTab = ref<'providers' | 'ollama' | 'nodes'>('providers')
const providersPanel = ref<InstanceType<typeof ProvidersPanel> | null>(null)

function switchTab(v: typeof aiTab.value) {
  aiTab.value = v
}
</script>
