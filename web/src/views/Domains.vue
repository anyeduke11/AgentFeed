<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">03</span>
      <h1 class="vtitle">分拣区</h1>
      <span class="vsub">领域树与标签治理</span>
      <span v-if="domains.tree.length" class="cap mono">{{ domains.tree.length }} 个领域 · {{ totalFiles }} 文件</span>
      <div class="vright">
        <button class="btn sm primary" @click="ui.openModal('domain')"><Icon name="plus" :size="13" /> 新增领域</button>
        <button class="btn sm" @click="refreshSeq++; refresh()"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>
    </div>

    <!-- 显式子组件变体（vercel-composition-patterns · patterns-explicit-variants）：
         领域树 / 标签治理 两个独立内聚域，各自管理自己的状态与拉取 -->
    <DomainTreePanel ref="treePanel" />
    <TagGovPanel ref="govPanel" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '../components/Icon.vue'
import DomainTreePanel from '../components/domains/DomainTreePanel.vue'
import TagGovPanel from '../components/domains/TagGovPanel.vue'
import { useDomainsStore } from '../stores/useDomainsStore'
import { useUiStore } from '../stores/useUiStore'

const domains = useDomainsStore()
const ui = useUiStore()

/** 页头汇总：一级领域数 + 全部领域有效文件合计（total 已含子领域，避免重复计数只取顶层 total） */
const totalFiles = computed(() => domains.tree.reduce((s: number, d: any) => s + (d.total ?? d.count ?? 0), 0).toLocaleString('en-US'))

const treePanel = ref<InstanceType<typeof DomainTreePanel> | null>(null)
const govPanel = ref<InstanceType<typeof TagGovPanel> | null>(null)
// 领域变更（新增/编辑弹层关闭）后两面板都要重取；refreshSeq 供未来子组件 watch 通知
const refreshSeq = ref(0)

async function refresh() {
  await Promise.all([
    treePanel.value?.refresh(),
    govPanel.value?.refresh(),
    domains.fetchDomains()
  ])
}
</script>
