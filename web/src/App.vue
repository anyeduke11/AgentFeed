<template>
  <div>
    <header class="topbar" :class="{ paused: ui.queuePaused }">
      <button class="btn ghost icon-btn menu-btn" @click="ui.toggleMenu()" aria-label="导航菜单" title="导航菜单">
        <Icon name="menu" :size="18" />
      </button>
      <router-link to="/overview" class="brand">
        <span class="brand-plate">调度站</span>
        <span class="brand-sub">AgentFeed 知识看板</span>
      </router-link>
      <nav class="nav" aria-label="主导航">
        <router-link v-for="n in NAVS" :key="n.path" :to="n.path" class="nav-item" :class="{ on: isActive(n.path) }">
          <span class="nav-num">{{ n.num }}</span>{{ n.label }}
        </router-link>
      </nav>
      <div class="topbar-right">
        <span class="qchip" :class="{ paused: ui.queuePaused }">
          <span class="dot" :class="ui.queuePaused ? 'dot-pause' : 'dot-run'"></span>{{ ui.queuePaused ? '已暂停' : '运行中' }}
        </span>
        <button class="btn ghost icon-btn" :title="ui.queuePaused ? '恢复队列' : '暂停队列'" :aria-label="ui.queuePaused ? '恢复队列' : '暂停队列'" @click="ui.togglePause()">
          <Icon :name="ui.queuePaused ? 'play' : 'pause'" :size="18" />
        </button>
        <button class="btn ghost icon-btn" title="切换紧凑视图" aria-label="切换紧凑视图" @click="ui.toggleDensity()">
          <Icon name="density" :size="18" />
        </button>
        <span class="date-chip mono">{{ todayLabel }}</span>
      </div>
    </header>

    <div class="menu-drawer" :class="{ on: ui.menuOpen }" aria-label="导航抽屉">
      <div class="menu-head">
        <span class="brand-plate">调度站</span>
        <button class="btn ghost icon-btn" style="margin-left:auto" @click="ui.toggleMenu(false)" title="关闭" aria-label="关闭导航抽屉">
          <Icon name="x" :size="18" />
        </button>
      </div>
      <div class="mnav">
        <router-link v-for="n in NAVS" :key="n.path" :to="n.path" class="mnav-item" :class="{ on: isActive(n.path) }" @click="ui.toggleMenu(false)">
          <span class="nav-num">{{ n.num }}</span>{{ n.label }}
          <span class="muted" style="font-size:11px;margin-left:auto">{{ n.sub }}</span>
        </router-link>
      </div>
      <div class="menu-foot mono">本地知识看板 · 数据仅存本机</div>
    </div>

    <main class="content">
      <router-view />
    </main>

    <div class="scrim" :class="{ on: ui.menuOpen || ui.drawerFileId !== null }" @click="onScrimClose"></div>

    <FileDrawer />
    <AppModal />

    <div class="toast" :class="{ on: ui.toastOn }">
      <Icon name="check" :size="15" />
      <span>{{ ui.toastMsg }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import Icon from './components/Icon.vue'
import FileDrawer from './components/FileDrawer.vue'
import AppModal from './components/AppModal.vue'
import { useUiStore } from './stores/useUiStore'
import { useLlmStore } from './stores/useLlmStore'

const ui = useUiStore()
const llm = useLlmStore()
const route = useRoute()

const NAVS = [
  { path: '/overview', num: '01', label: '总览', sub: '调度总览' },
  { path: '/library', num: '02', label: '收件坪', sub: '资料库' },
  { path: '/domains', num: '03', label: '分拣区', sub: '领域' },
  { path: '/pipeline', num: '04', label: '精炼线', sub: '管线' },
  { path: '/entry', num: '05', label: '成品仓', sub: '词条' },
  { path: '/supply', num: '06', label: '发车区', sub: '供给' },
  { path: '/chat', num: '07', label: '对话', sub: '人侧对话' },
  { path: '/settings', num: '08', label: '调度室', sub: '设置' }
]

const todayLabel = computed(() => {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week}`
})

function isActive(path: string) {
  return route.path === path
}

function onScrimClose() {
  ui.toggleMenu(false)
  ui.closeDrawer()
}

onMounted(async () => {
  try {
    const q = await llm.fetchQueue()
    ui.queuePaused = !!q?.paused
  } catch { /* 后端未就绪时静默 */ }
})
</script>
