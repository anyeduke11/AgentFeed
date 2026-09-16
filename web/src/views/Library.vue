<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">02</span>
      <h1 class="vtitle">收件坪</h1>
      <span class="vsub">资料库 · 文件清单与批量处理</span>
      <div class="vright">
        <button class="btn sm" :disabled="files.loading" @click="refresh"><Icon name="refresh" :size="13" :class="{ spin: files.loading }" /> 刷新</button>
      </div>
    </div>

    <!-- 筛选器 -->
    <div class="filterbox">
      <div class="frow1">
        <div class="search-wrap">
          <Icon name="search" :size="16" />
          <input class="inp" v-model="files.filters.kw" type="text" placeholder="搜索标题 / 标签 / 来源 agent" @input="onFilter" aria-label="搜索文件" />
        </div>
        <span class="cap mono">命中 {{ files.total }} 行</span>
      </div>
      <div class="frow-line"><span class="flabel">类型</span><div class="chips"><button v-for="o in EXT_F" :key="o.v" class="chip" :class="{ on: files.filters.ext === o.v }" @click="setFilter('ext', o.v)">{{ o.t }}</button></div></div>
      <div class="frow-line"><span class="flabel">状态</span><div class="chips"><button v-for="s in STATUS_F" :key="s" class="chip" :class="{ on: files.filters.status === s }" @click="setFilter('status', s)">{{ s }}</button></div></div>
      <div class="frow-line"><span class="flabel">领域</span><div class="chips"><button class="chip" :class="{ on: files.filters.domain === '全部' }" @click="setFilter('domain', '全部')">全部</button><button v-for="dm in domains.tree" :key="dm.id" class="chip" :class="{ on: files.filters.domain === dm.name }" @click="setFilter('domain', dm.name)">{{ dm.name }}</button></div></div>
      <div class="frow-line"><span class="flabel">来源</span><div class="chips"><button class="chip" :class="{ on: files.filters.agent === '全部' }" @click="setFilter('agent', '全部')">全部</button><button v-for="a in agentList" :key="a" class="chip" :class="{ on: files.filters.agent === a }" @click="setFilter('agent', a)">{{ a }}</button></div></div>
    </div>

    <!-- 批量操作栏 -->
    <div class="batchbar">
      <span class="bb-info"><template v-if="selCount">已选 <b class="mono">{{ selCount }}</b> 项</template><template v-else>勾选文件后可批量处理</template></span>
      <div class="bb-acts">
        <button class="btn sm" :disabled="!selCount" @click="batchRedistill"><Icon name="beaker" :size="14" /> 批量重新蒸馏</button>
        <button class="btn sm" :disabled="!selCount" @click="ui.openModal('assign')"><Icon name="grid" :size="14" /> 批量归类</button>
        <button v-if="files.filters.status === '已删除'" class="btn sm" :disabled="!selCount" @click="batchRestore"><Icon name="rotate" :size="14" /> 批量恢复</button>
        <button v-else class="btn sm danger" :disabled="!selCount" @click="batchDelete"><Icon name="trash" :size="14" /> 批量软删</button>
      </div>
      <span class="bb-hint mono">全库 {{ files.total }} 个文件</span>
    </div>

    <!-- 列表 -->
    <div v-if="!files.items.length" class="sect" style="padding:0">
      <div class="empty">
        <span class="e-ic"><Icon name="inbox" :size="30" /></span>
        <div class="e-t">{{ files.filters.status === '已删除' ? '已删除列表为空' : '没有匹配的文件' }}</div>
        <div class="e-s">{{ files.filters.status === '已删除' ? '当前没有被软删的文件。已恢复的文件会回到收件坪。' : '试试调整关键词或清除筛选条件，再查看收件坪。' }}</div>
        <button class="btn sm" @click="clearFilters">清除筛选</button>
      </div>
    </div>
    <div v-else class="sect" style="overflow:hidden">
      <table class="rtable lib-table">
        <thead>
          <tr>
            <th style="width:34px"><input type="checkbox" :checked="allChecked" @change="toggleAll" aria-label="全选当前列表" /></th>
            <th>标题</th><th class="c-domain">领域</th><th class="c-tag">标签</th><th class="c-agent">来源</th>
            <th class="c-time">修改时间</th><th class="c-ext">类型</th><th class="c-size">大小</th>
            <th class="c-state">蒸馏状态</th><th class="c-ver">版本</th><th class="c-ops" style="text-align:right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in files.items" :key="f.id" class="lib-row" :class="{ isdel: f.status === 'deleted' }" @click="ui.openDrawer(f.id)">
            <td class="c-check" @click.stop><input type="checkbox" :checked="!!files.selection[f.id]" @change="files.selection[f.id] = !files.selection[f.id]" :aria-label="`选择 ${f.title || f.name}`" /></td>
            <td class="c-title c-main">{{ f.title || f.name }}</td>
            <td class="c-domain" data-l="领域"><span class="cv"><span class="dot" :style="{ background: domColor(f) }"></span> {{ f.domain_name || '未分类' }}</span></td>
            <td class="c-tag" data-l="标签"><span class="cv"><span v-for="t in f.tags.slice(0, 3)" :key="t.id" class="tagchip">{{ t.name }}</span></span></td>
            <td class="c-agent" data-l="来源"><span class="cv"><span class="mono">{{ f.source_agent || '—' }}</span></span></td>
            <td class="c-time" data-l="修改时间"><span class="cv"><span class="c-dim">{{ fmtTime(f.file_mtime) }}</span></span></td>
            <td class="c-ext" data-l="类型"><span class="cv"><span class="c-dim">{{ f.ext }}</span></span></td>
            <td class="c-size" data-l="大小"><span class="cv"><span class="c-dim">{{ fmtSize(f.size) }}</span></span></td>
            <td class="c-state" data-l="蒸馏状态"><span class="cv">
              <span v-if="f.status === 'deleted'" class="stb stb-del">已删除</span>
              <span v-else class="stb"><span class="dot" :class="stateDot(f.llm_state)"></span>{{ stateText(f.llm_state) }}</span>
            </span></td>
            <td class="c-ver" data-l="版本"><span class="cv"><span class="c-dim">{{ f.md5 ? f.md5.slice(0, 6) : '—' }}{{ f.status === 'deleted' ? ' · 已删除' : '' }}</span></span></td>
            <td class="c-ops" data-l="" @click.stop>
              <template v-if="f.status === 'deleted'">
                <button class="btn xs" @click="restoreOne(f.id)"><Icon name="rotate" :size="12" /> 恢复</button>
              </template>
              <template v-else>
                <button class="btn xs" @click="files.openFile(f.id)"><Icon name="external" :size="12" /> 打开</button>
                <button class="btn xs" @click="redistillOne(f)"><Icon name="beaker" :size="12" /> 重蒸馏</button>
                <button class="btn xs danger" @click="softDelOne(f.id)"><Icon name="trash" :size="12" /> 软删</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div class="lib-foot">
      <span class="mono">第 {{ files.page }} 页 · 每页 {{ files.limit }} 行 · 共 {{ files.total }} 个文件</span>
      <span style="flex:1"></span>
      <button class="btn xs" :disabled="files.page <= 1" @click="pageTo(files.page - 1)">上一页</button>
      <button class="btn xs" :disabled="files.page >= pageCount" @click="pageTo(files.page + 1)">下一页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { useFilesStore } from '../stores/useFilesStore'
import { useDomainsStore } from '../stores/useDomainsStore'
import { useUiStore } from '../stores/useUiStore'
import { api } from '../api'

const files = useFilesStore()
const domains = useDomainsStore()
const ui = useUiStore()

const EXT_F = [{ v: '全部', t: '全部' }, { v: '.html', t: 'HTML' }, { v: '.md', t: 'Markdown' }]
const STATUS_F = ['全部', '已蒸馏', '编目中', '待处理', '失败', '已跳过', '已删除']
const agentList = ref<string[]>([])

const selCount = computed(() => files.selectedIds().length)
const pageCount = computed(() => Math.max(1, Math.ceil(files.total / files.limit)))
const allChecked = computed(() => files.items.length > 0 && files.items.every((f: any) => !!files.selection[f.id]))

const STATE_MAP: Record<string, { t: string; dot: string }> = {
  done: { t: '已蒸馏', dot: 'dot-done' },
  running: { t: '编目中', dot: 'dot-run' },
  pending: { t: '待处理', dot: 'dot-pend' },
  failed: { t: '失败', dot: 'dot-fail' },
  skipped: { t: '已跳过', dot: 'dot-skip' }
}
const stateText = (s: string) => STATE_MAP[s]?.t || s
const stateDot = (s: string) => STATE_MAP[s]?.dot || 'dot-pend'

const domColor = (f: any) => {
  const hit = domains.findNode(f.domain_id)
  return hit?.node?.color || 'var(--skip)'
}

function fmtTime(t?: string) {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}
function fmtSize(n?: number) {
  if (!n) return '—'
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
}

async function refresh() {
  await Promise.all([files.fetchFiles(), domains.fetchDomains()])
}

function onFilter() {
  files.page = 1
  files.fetchFiles()
}

let kwTimer: ReturnType<typeof setTimeout> | null = null
watch(() => files.filters.kw, () => {
  if (kwTimer) clearTimeout(kwTimer)
  kwTimer = setTimeout(onFilter, 350)
})

function setFilter(k: 'ext' | 'status' | 'domain' | 'agent', v: string) {
  ;(files.filters as any)[k] = v
  onFilter()
}

function clearFilters() {
  files.clearFilters()
  files.fetchFiles()
}

function pageTo(p: number) {
  files.page = p
  files.fetchFiles()
}

function toggleAll(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  for (const f of files.items) files.selection[f.id] = checked
}

async function batchRedistill() {
  const ids = files.selectedIds()
  if (!ids.length) return
  await files.redistill(ids)
  ui.toast(`已将 ${ids.length} 个文件加入精炼队列`)
}

async function batchRestore() {
  const ids = files.selectedIds()
  if (!ids.length) return
  await files.restore(ids)
  ui.toast(`已恢复 ${ids.length} 个文件`)
}

async function batchDelete() {
  const ids = files.selectedIds()
  if (!ids.length) return
  await files.softDelete(ids)
  ui.toast(`已软删 ${ids.length} 个文件 · 可在调度室恢复`)
}

async function softDelOne(id: number) {
  await files.softDelete([id])
  ui.toast('已软删 1 个文件 · 可在调度室恢复')
}

async function restoreOne(id: number) {
  await files.restore([id])
  ui.toast('已恢复 1 个文件')
}

function redistillOne(f: any) {
  ui.openModal('redistill', { fileId: f.id })
}

onMounted(async () => {
  await refresh()
  try {
    const dash = await api.stats.dashboard()
    agentList.value = (dash.agents || []).map((a: any) => a.name).filter(Boolean)
  } catch { /* 忽略 agent 列表获取失败 */ }
})
</script>
