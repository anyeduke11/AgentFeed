<template>
  <aside class="drawer" :class="{ on: ui.drawerFileId !== null }" aria-hidden="false" aria-label="文件详情抽屉">
    <div class="drawer-head">
      <span class="plate" style="min-width:26px;height:26px;font-size:12px">件</span>
      <span class="drawer-title">文件详情与版本链</span>
      <div class="sright" style="margin-left:auto">
        <button class="btn ghost icon-btn" @click="ui.closeDrawer()" aria-label="关闭详情" title="关闭">
          <Icon name="x" :size="18" />
        </button>
      </div>
    </div>
    <div class="drawer-body" v-if="file">
      <div class="d-sec">
        <div class="d-sec-t"><span class="sq"></span>文件</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">{{ file.title || file.name }}</div>
        <div class="kvgrid">
          <span class="k">领域</span>
          <span><span class="dot" :style="{ background: file.domain_color || domColor(file.domain_name) }"></span> {{ file.domain_name || '未分类' }}</span>
          <span class="k">来源 agent</span>
          <span class="mono">{{ file.source_agent || '-' }}</span>
          <span class="k">类型 / 大小</span>
          <span class="mono">{{ file.ext }} · {{ sizeLabel(file.size) }}</span>
          <span class="k">修改时间</span>
          <span class="mono">{{ timeLabel(file.file_mtime) }}</span>
          <span class="k">蒸馏状态</span>
          <span>
            <span class="stb" :class="{ 'stb-del': file.status === 'deleted' }">
              <span class="dot" :style="{ background: file.status === 'deleted' ? 'var(--fail)' : stColor(file.llm_state) }"></span>
              {{ file.status === 'deleted' ? '已删除' : stLabel(file.llm_state) }}
            </span>
            <span class="mono dim3" style="font-size:11px;margin-left:6px">llm_state: {{ file.llm_state }}</span>
          </span>
          <span class="k">标签</span>
          <span style="display:flex;gap:5px;flex-wrap:wrap">
            <span v-for="t in file.tags" :key="t.name" class="tagchip">{{ t.name }}</span>
            <span v-if="!file.tags?.length" class="dim3">无</span>
          </span>
        </div>
      </div>
      <div class="d-sec">
        <div class="d-sec-t"><span class="sq"></span>路径</div>
        <div class="pathbox">
          <span class="mono">{{ file.path }}</span>
          <button class="btn xs" @click="copy(file.path)"><Icon name="copy" :size="12" /> 复制</button>
        </div>
        <div class="d-acts" style="margin-top:10px">
          <button v-if="canReadInline" class="btn sm primary" @click="readInline"><Icon name="eye" :size="14" /> 站内阅读</button>
          <button class="btn sm" @click="openDoc"><Icon name="external" :size="14" /> 打开</button>
          <button class="btn sm" @click="reveal"><Icon name="folder" :size="14" /> 定位</button>
          <template v-if="file.status === 'deleted'">
            <button class="btn sm" @click="restore"><Icon name="rotate" :size="14" /> 恢复文件</button>
            <button class="btn sm danger" @click="purgeOne"><Icon name="trash" :size="14" /> 彻底清理</button>
          </template>
          <template v-else>
            <button class="btn sm" @click="ui.openModal('redistill', { fileId: file.id })"><Icon name="beaker" :size="14" /> 重新蒸馏</button>
            <button class="btn sm danger" @click="softDel"><Icon name="trash" :size="14" /> 软删</button>
          </template>
        </div>
      </div>
      <div class="d-sec">
        <div class="d-sec-t"><span class="sq"></span>版本链（md5 迭代 · supersedes）</div>
        <div class="vchain">
          <template v-for="(v, i) in versions" :key="v.id">
            <div class="vnode" :class="{ cur: i === 0 }">
              <div class="vh">
                <span class="vtag">{{ file.ext }}</span>
                <span v-if="i === 0" class="stb" style="font-size:10.5px;padding:0 6px"><span class="dot" :style="{ background: file.status === 'deleted' ? 'var(--fail)' : 'var(--ok)' }"></span>{{ file.status === 'deleted' ? '已软删' : '当前版本' }}</span>
                <span v-else class="cap">已归档 · 已被当前版本取代</span>
                <span class="cap mono" style="margin-left:auto">{{ timeLabel(v.related_mtime) }}</span>
              </div>
              <div class="vm">md5 {{ md5Short(v) }}</div>
            </div>
            <div v-if="i < versions.length - 1" class="vconn"></div>
          </template>
          <div v-if="!versions.length" class="cap" style="padding:4px 0">暂无历史版本记录</div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useUiStore } from '../stores/useUiStore'
import { useFilesStore } from '../stores/useFilesStore'
import { useDomainsStore } from '../stores/useDomainsStore'
import { fmtSize } from '../utils/format'
import { useCopyToClipboard, llmStateText, llmStateColor } from '../composables/ui'

const ui = useUiStore()
const files = useFilesStore()
const domains = useDomainsStore()

const versions = ref<any[]>([])

const file = computed(() => {
  if (ui.drawerFileId === null) return null
  return files.items.find((f: any) => f.id === ui.drawerFileId) || null
})

// R4-M2 入口：md/html 支持站内阅读，先关抽屉再进阅读器（抽屉是全局挂载，路由切换不会自动关）
const router = useRouter()
const canReadInline = computed(() => /^\.md$|^\.html?$/i.test(String(file.value?.ext || '')))
function readInline() {
  const id = file.value?.id
  ui.closeDrawer()
  if (id) router.push(`/reader/${id}`)
}

watch(() => ui.drawerFileId, async (id) => {
  versions.value = []
  if (id !== null) {
    try { versions.value = await files.versions(id) } catch { /* 忽略 */ }
  }
})

function domColor(name?: string) {
  if (!name) return 'var(--text-2)'
  for (const d of domains.tree) {
    if (d.name === name) return d.color
    for (const c of d.children || []) if (c.name === name) return c.color
  }
  return 'var(--text-2)'
}

function stLabel(s: string) {
  return llmStateText(s)
}
function stColor(s: string) {
  return llmStateColor(s)
}
function sizeLabel(n?: number) {
  return fmtSize(n) === '—' ? '-' : fmtSize(n).replace(/ /g, '')
}
function timeLabel(t?: string) {
  if (!t) return '-'
  return String(t).replace('T', ' ').slice(0, 16)
}
function md5Short(v: any) {
  return (v.md5 || '').slice(0, 10) || '-'
}

const { copy } = useCopyToClipboard()

async function openDoc() {
  const r = await files.openFile(file.value.id)
  ui.toast(r?.success === false ? (r.message || '打开失败') : '已在默认应用中打开')
}
async function reveal() {
  const r = await files.revealFile(file.value.id)
  ui.toast(r?.success === false ? (r.message || '定位失败') : '已在文件管理器中定位')
}
async function softDel() {
  await files.softDelete([file.value.id])
  ui.toast(`已软删「${file.value.title || file.value.name}」· 可在状态筛选中恢复`)
  ui.closeDrawer()
}
async function restore() {
  await files.restore([file.value.id])
  ui.toast(`已恢复「${file.value.title || file.value.name}」`)
  ui.closeDrawer()
}
async function purgeOne() {
  await files.purgeOne(file.value.id)
  ui.toast(`已彻底清理「${file.value.title || file.value.name}」`)
  ui.closeDrawer()
}
</script>
