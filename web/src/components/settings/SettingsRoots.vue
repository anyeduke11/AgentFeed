<template>
  <!-- 扫描根 -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">扫描根（{{ settings.roots.length }} 个）</h2><span class="sect-en">Scan Roots</span><div class="sright"><span class="cap mono">{{ settings.scanStatus.watcherRunning ? 'watcher 运行中' : 'watcher 未运行' }}</span></div></div>
    <div v-for="r in settings.roots" :key="r.id" class="rootrow">
      <span><span class="rp">{{ r.path }}</span> <span class="rc">{{ r.enabled ? (r.files != null ? r.files + ' 个文件' : '') : '停用' }}</span> <span v-if="r.agent" class="stb" :title="`绑定 Agent：${r.agent}`">{{ r.agent }}</span></span>
      <span class="rootstop">{{ r.enabled ? '启用' : '停用' }}</span>
      <span style="display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap">
        <button class="switch" role="switch" :aria-checked="r.enabled ? 'true' : 'false'" :aria-label="`启用或停用扫描根 ${r.path}`" @click="toggleRoot(r)"></button>
        <button class="btn xs" @click="rescan(r)"><Icon name="refresh" :size="12" /> 全量重扫</button>
        <button class="btn xs danger" @click="removeRoot(r)"><Icon name="trash" :size="12" /> 移除</button>
      </span>
    </div>
    <div class="addroot">
      <template v-if="addingRoot">
        <input class="inp" v-model="newRoot" placeholder="/absolute/path/to/dir" aria-label="新扫描根路径" @keyup.enter="confirmAddRoot" />
        <button class="btn sm primary" @click="confirmAddRoot">确认添加</button>
        <button class="btn sm" @click="addingRoot = false">取消</button>
      </template>
      <template v-else>
        <button class="btn sm" @click="addingRoot = true"><Icon name="plus" :size="14" /> 新增扫描根</button>
        <span class="supply-note">新增后会执行一次全量扫描；watcher 会持续监听启用的扫描根。</span>
      </template>
    </div>
    <!-- Agent 目录一键挂载 -->
    <div class="cap" style="display:block;margin:14px 14px 8px">Agent 目录（国内外常见智能体的本机数据目录 · 点击挂载，再次点击启停）</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 4px">
      <button v-for="a in agentRoots" :key="a.name" class="chip"
        :class="{ on: !!a.rootId && a.enabled }"
        :style="!a.exists ? 'opacity:.4' : ''"
        :disabled="!a.exists && !a.rootId"
        :title="a.path + (a.exists ? '' : '（本机未检测到）')"
        @click="toggleAgentRoot(a)">
        <span class="dot" :class="a.rootId ? (a.enabled ? 'dot-run' : 'dot-pause') : 'dot-pend'"></span>
        {{ a.name }}<span v-if="a.rootId" class="stb" style="margin-left:4px">{{ a.enabled ? '启用中' : '已停用' }}</span>
      </button>
    </div>
    <!-- 扫描台账已迁至「日志管理 → 扫描日志」 -->
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'

const props = defineProps<{ refreshSeq?: number }>()

const settings = useSettingsStore()
const ui = useUiStore()

const addingRoot = ref(false)
const newRoot = ref('')
const agentRoots = ref<any[]>([])

async function loadAgents() {
  try {
    agentRoots.value = await api.scan.agents()
  } catch {
    agentRoots.value = []
  }
}

/** 拉取本 tab 数据：扫描根 / 扫描状态 / Agent 目录（对应原页面 refresh 中 roots 相关部分） */
async function load() {
  await Promise.all([
    settings.fetchRoots(),
    settings.fetchScanStatus(),
    loadAgents()
  ])
}

async function confirmAddRoot() {
  const p = newRoot.value.trim()
  if (!p) {
    ui.toast('请输入扫描根的绝对路径')
    return
  }
  try {
    await settings.addRoot(p)
    newRoot.value = ''
    addingRoot.value = false
    ui.toast('已新增扫描根并执行全量扫描')
    await settings.fetchScanStatus()
  } catch (e: any) {
    ui.toast('新增失败：' + (e?.message || e))
  }
}

async function toggleRoot(r: any) {
  await settings.toggleRoot(r.id, !r.enabled)
  ui.toast(r.enabled ? `已停用扫描根 ${r.path}` : `已启用扫描根 ${r.path}`)
  await loadAgents()
}

/** Agent 目录芯片：未挂载则添加扫描根，已挂载则切换启停 */
async function toggleAgentRoot(a: any) {
  try {
    if (a.rootId) {
      await settings.toggleRoot(a.rootId, !a.enabled)
      ui.toast(`${a.name} 扫描根已${a.enabled ? '停用' : '启用'}`)
    } else {
      await settings.addRoot(a.path)
      ui.toast(`已挂载 ${a.name}（${a.path}），后台全量扫描中`)
      await settings.fetchScanStatus()
      await settings.fetchScanJobs()
    }
  } catch (e: any) {
    ui.toast('操作失败：' + (e?.message || e))
  }
  await loadAgents()
}

async function rescan(r: any) {
  await settings.rescanRoot(r.id)
  ui.toast(`已对 ${r.path} 执行全量重扫`)
  await settings.fetchScanStatus()
  await settings.fetchScanJobs()
}

async function removeRoot(r: any) {
  await settings.removeRoot(r.id)
  ui.toast(`已移除扫描根 ${r.path}`)
}

// 进入 tab 首次挂载拉取数据（KeepAlive 缓存后切回不重复拉取，与拆分前一致）
onMounted(load)
// 父层「刷新」按钮：重新拉取本 tab 数据
watch(() => props.refreshSeq, load)
</script>
