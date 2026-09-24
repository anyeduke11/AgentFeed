<template>
  <div>
    <div class="domgrid" v-if="domains.tree.length">
      <div v-for="d in domains.tree" :key="d.id" class="domcard">
        <div class="domband" :style="{ background: d.color || 'var(--steel)' }"></div>
        <div class="dom-in dom-link" :title="`查看「${d.name}」的词条`" @click="goEntry(d.name)">
          <div class="dom-top">
            <span class="domname">{{ d.name }}</span>
            <button v-if="hasDetail(d)" class="btn ghost icon-btn" @click.stop="domains.toggleOpen(d.id)" :aria-label="isOpen(d.id) ? '收起详情' : '展开详情'" :title="isOpen(d.id) ? '收起' : '展开次要标签 / 子领域'">
              <Icon :name="isOpen(d.id) ? 'chevronDown' : 'chevronRight'" :size="15" />
            </button>
          </div>
          <div class="domcount">{{ fmtN(total(d)) }}</div>
          <div class="dom-sub">有效文件{{ d.children?.length ? '（含子领域）' : '' }}</div>

          <!-- 展开区：次要标签 TOP3（挂靠本领域的一级标签的二级标签，按挂载数）+ 子领域 -->
          <div v-if="isOpen(d.id) && hasDetail(d)" class="dom-children" @click.stop>
            <template v-if="topTags(d.name).length">
              <div class="cap dom-sec-cap">次要标签 · 按挂载 TOP{{ topTags(d.name).length }}</div>
              <div v-for="t in topTags(d.name)" :key="t.id" class="domchild" :title="`次要标签「${t.name}」· 挂载 ${fmtN(t.file_count ?? 0)} 篇 · 详见下方标签墙`">
                <span class="dot" :style="{ background: d.color || 'var(--steel)' }"></span>
                <span class="dc-name">{{ t.name }}</span>
                <span class="dc-count">{{ fmtN(t.file_count ?? 0) }}</span>
              </div>
            </template>
            <template v-if="d.children?.length">
              <div v-if="topTags(d.name).length" class="cap dom-sec-cap">子领域</div>
              <div v-for="c in d.children" :key="c.id" class="domchild dom-link" :title="`查看「${c.name}」的词条`" @click="goEntry(c.name)">
                <span class="dot" :style="{ background: c.color || 'var(--steel)' }"></span>
                <span class="dc-name">{{ c.name }}</span>
                <span class="dc-count">{{ fmtN(c.count) }}</span>
                <button class="btn ghost icon-btn" @click.stop="editDomain(c)" title="编辑名称" :aria-label="`编辑 ${c.name}`"><Icon name="edit" :size="13" /></button>
                <button class="btn ghost icon-btn" @click.stop="editDomain(c)" title="更换配色" :aria-label="`更换 ${c.name} 配色`"><Icon name="droplet" :size="13" /></button>
                <button class="btn ghost icon-btn" @click.stop="delDomain(c)" title="删除" :aria-label="`删除 ${c.name}`"><Icon name="trash" :size="13" /></button>
              </div>
            </template>
          </div>
        </div>
        <div class="dom-acts">
          <button class="btn ghost icon-btn" @click="editDomain(d)" title="编辑名称" aria-label="编辑领域"><Icon name="edit" :size="13" /></button>
          <button class="btn ghost icon-btn" @click="editDomain(d)" title="更换配色" aria-label="更换配色"><Icon name="droplet" :size="13" /></button>
          <button class="btn ghost icon-btn" :disabled="isFirst(d.id)" @click="domains.move(d.id, -1)" title="上移" aria-label="上移"><Icon name="up" :size="13" /></button>
          <button class="btn ghost icon-btn" :disabled="isLast(d.id)" @click="domains.move(d.id, 1)" title="下移" aria-label="下移"><Icon name="down" :size="13" /></button>
          <button class="btn ghost icon-btn" @click="delDomain(d)" title="删除" aria-label="删除领域"><Icon name="trash" :size="13" /></button>
        </div>
      </div>
    </div>
    <div v-else class="empty">
      <span class="e-ic"><Icon name="grid" :size="30" /></span>
      <div class="e-t">尚无领域</div>
      <div class="e-s">创建一级领域后，可在收件坪将文件批量归类到领域。</div>
      <button class="btn sm primary" @click="ui.openModal('domain')"><Icon name="plus" :size="13" /> 新增领域</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// 领域树面板：领域卡网格 + 次要标签 TOP3 / 子领域展开 + 跳成品仓（Domains.vue 拆分，独立内聚域）
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { useDomainsStore } from '../../stores/useDomainsStore'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'

const domains = useDomainsStore()
const ui = useUiStore()
const router = useRouter()

// ---- 次要标签 TOP3：挂靠到一级标签（与领域同名锚点）的 secondary 标签，按挂载数取前 3 ----
const secTags = ref<any[]>([])

async function fetchSecTags() {
  try {
    const r = await api.tags.list({ status: 'active', level: 'secondary', sort: 'count', limit: '5000' })
    secTags.value = r.items || []
  } catch { /* 标签加载失败保持空，卡片仅显示子领域 */ }
}

/** 领域名 → 挂靠的前 3 个次要标签（parent_name 与一级标签同名锚点对齐；file_count 倒序） */
function topTags(domainName: string) {
  return secTags.value
    .filter((t: any) => t.parent_name === domainName)
    .sort((a: any, b: any) => (b.file_count ?? 0) - (a.file_count ?? 0))
    .slice(0, 3)
}

/** 卡片是否可展开：有次要标签或子领域才显示 chevron */
function hasDetail(d: any) {
  return !!d.children?.length || topTags(d.name).length > 0
}

/** 千分位：领域计数与标签挂载数展示口径（18,442） */
function fmtN(n?: number) {
  return (n ?? 0).toLocaleString('en-US')
}

onMounted(() => {
  domains.fetchDomains()
  fetchSecTags()
})

/** 领域卡点击 → 成品仓按该领域过滤（Entry 侧从 route.query.domain 接住自动套用） */
function goEntry(name: string) {
  router.push({ path: '/entry', query: { domain: name } })
}

const isOpen = (id: number) => domains.domOpen[id] !== false
const total = (d: any) => d.total ?? d.count ?? 0

function isFirst(id: number) {
  return domains.tree[0]?.id === id
}
function isLast(id: number) {
  return domains.tree[domains.tree.length - 1]?.id === id
}

function editDomain(d: any) {
  ui.openModal('domain', { mode: 'edit', id: d.id })
}
function delDomain(d: any) {
  ui.openModal('domdel', { id: d.id })
}

defineExpose({
  refresh: () => Promise.all([domains.fetchDomains(), fetchSecTags()])
})
</script>
