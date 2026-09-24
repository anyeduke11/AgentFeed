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

    <div class="chips" style="margin-bottom:14px">
      <button class="chip" :class="{ on: tab === 'files' }" @click="tab = 'files'">文件清单</button>
      <button class="chip" :class="{ on: tab === 'clip' }" @click="tab = 'clip'">网页剪藏</button>
    </div>

    <template v-if="tab === 'files'">
    <!-- 筛选器 -->
    <div class="filterbox">
      <div class="frow1">
        <div class="search-wrap">
          <Icon name="search" :size="16" />
          <input class="inp" v-model="files.filters.kw" type="text" :placeholder="smart ? '混合检索 · 支持 title:标题 tag:标签 “精确短语” -排除词' : '搜索标题 / 标签 / 来源 agent'" @input="onFilter" aria-label="搜索文件" />
        </div>
        <button class="chip" :class="{ on: smart }" @click="toggleSmart" title="三路混合检索（全文 FTS5 + 词条摘要 + 语义向量）· 与 MCP search_knowledge 同内核，命中正文内容">智能检索</button>
        <span class="cap mono">{{ smartHint }}</span>
      </div>
      <div class="frow-line"><span class="flabel">类型</span><div class="chips"><button v-for="o in EXT_F" :key="o.v" class="chip" :class="{ on: files.filters.ext === o.v }" @click="setFilter('ext', o.v)">{{ o.t }}</button></div></div>
      <div class="frow-line"><span class="flabel">状态</span><div class="chips"><button v-for="s in STATUS_F" :key="s" class="chip" :class="{ on: files.filters.status === s }" @click="setFilter('status', s)">{{ s }}</button></div></div>
      <div class="frow-line"><span class="flabel">领域</span><div class="chips"><button class="chip" :class="{ on: files.filters.domain === '全部' }" @click="setFilter('domain', '全部')">全部</button><button v-for="dm in domains.tree" :key="dm.id" class="chip" :class="{ on: files.filters.domain === dm.name }" @click="setFilter('domain', dm.name)">{{ dm.name }}</button></div></div>
      <div class="frow-line"><span class="flabel">来源</span><div class="chips"><button class="chip" :class="{ on: files.filters.agent === '全部' }" @click="setFilter('agent', '全部')">全部</button><button v-for="a in agentList" :key="a" class="chip" :class="{ on: files.filters.agent === a }" @click="setFilter('agent', a)">{{ a }}</button></div></div>
    </div>

    <!-- 智能检索结果区：三路混合命中（文件行开抽屉 · 纯词条行跳成品仓） -->
    <div v-if="smartActive" class="sect smart-results">
      <div class="sect-head">
        <span class="sq"></span><h2 class="stitle">混合检索结果</h2><span class="sect-en">Hybrid Results</span>
        <div class="sright"><span class="cap mono">全文 FTS5 · 摘要 · 语义向量 三路 RRF · {{ smartItems.length }} 条</span></div>
      </div>
      <div v-if="smartLoading" class="cap sect-empty">检索中…</div>
      <div v-else-if="!smartItems.length" class="cap sect-empty">没有命中内容 · 换个关键词，或关闭智能检索回到列表筛选。</div>
      <div v-else class="smart-list">
        <div v-for="(it, i) in smartItems" :key="i" class="smart-item dom-link" :title="it.path" @click="openSmartItem(it)">
          <span class="mono dim3 smart-rank">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="smart-main">
            <b class="row-title">{{ it.title || it.path }}</b>
            <span class="cap smart-summary">{{ it.summary }}</span>
          </span>
          <span class="smart-meta">
            <span v-if="it.entry_path" class="tagchip">纯词条</span>
            <span v-if="it.domain_name" class="cap"><span class="dot" style="background:var(--steel)"></span> {{ it.domain_name }}</span>
            <span v-if="it.source_agent" class="cap mono">{{ it.source_agent }}</span>
            <span v-if="it.file_mtime" class="cap mono dim3">{{ fmtTime(it.file_mtime) }}</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 批量操作栏（智能检索模式下隐藏——混合结果不可勾选批量） -->
    <div v-else class="batchbar">
      <span class="bb-info"><template v-if="selCount">已选 <b class="mono">{{ selCount }}</b> 项</template><template v-else>勾选文件后可批量处理</template></span>
      <div class="bb-acts">
        <button class="btn sm" :disabled="!selCount" @click="batchRedistill"><Icon name="beaker" :size="14" /> 批量重新蒸馏</button>
        <button class="btn sm" :disabled="!selCount" @click="ui.openModal('assign')"><Icon name="grid" :size="14" /> 批量归类</button>
        <button v-if="files.filters.status === '已删除'" class="btn sm" :disabled="!selCount" @click="batchRestore"><Icon name="rotate" :size="14" /> 批量恢复</button>
        <button v-else class="btn sm danger" :disabled="!selCount" @click="batchDelete"><Icon name="trash" :size="14" /> 批量软删</button>
      </div>
      <span class="bb-hint mono">全库 {{ files.total }} 个文件</span>
    </div>

    <!-- 列表（智能检索模式下整体隐藏） -->
    <template v-if="!smartActive">
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
              <span v-else class="stb"><span class="dot" :class="llmStateDot(f.llm_state)"></span>{{ llmStateText(f.llm_state) }}</span>
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
    </template>
    </template>
    <WebclipPanel v-else />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import WebclipPanel from '../components/WebclipPanel.vue'
import { useFilesStore } from '../stores/useFilesStore'
import { useDomainsStore } from '../stores/useDomainsStore'
import { useUiStore } from '../stores/useUiStore'
import { api } from '../api'
import { fmtTime, fmtSize } from '../utils/format'
import { useDebouncedWatch, llmStateText, llmStateDot } from '../composables/ui'

const files = useFilesStore()
const domains = useDomainsStore()
const ui = useUiStore()
const router = useRouter()

const tab = ref<'files' | 'clip'>('files')

const EXT_F = [{ v: '全部', t: '全部' }, { v: '.html', t: 'HTML' }, { v: '.md', t: 'Markdown' }]
const STATUS_F = ['全部', '已蒸馏', '编目中', '待处理', '失败', '已跳过', '已删除']
const agentList = ref<string[]>([])

const selCount = computed(() => files.selectedIds().length)
const pageCount = computed(() => Math.max(1, Math.ceil(files.total / files.limit)))
const allChecked = computed(() => files.items.length > 0 && files.items.every((f: any) => !!files.selection[f.id]))

const domColor = (f: any) => {
  const hit = domains.findNode(f.domain_id)
  return hit?.node?.color || 'var(--skip)'
}

async function refresh() {
  await Promise.all([files.fetchFiles(), domains.fetchDomains()])
}

function onFilter() {
  files.page = 1
  if (smartActive.value) return runSmart()   // 智能模式：kw/领域/来源变化都触发混合检索，不打 LIKE 列表
  files.fetchFiles()
}

// ---- 智能检索（三路混合，与 MCP search_knowledge 同内核）----
const smart = ref(false)
const smartItems = ref<any[]>([])
const smartLoading = ref(false)
const smartActive = computed(() => smart.value && !!files.filters.kw.trim())

const smartHint = computed(() => {
  if (!smart.value) return `命中 ${files.total} 行`
  return smartActive.value ? `混合 ${smartItems.value.length} 条` : '输入关键词开始混合检索'
})

function toggleSmart() {
  smart.value = !smart.value
  if (smartActive.value) runSmart()
  else if (!smart.value) files.fetchFiles()   // 关闭开关回到列表口径
}

async function runSmart() {
  if (!smartActive.value) return
  smartLoading.value = true
  try {
    const params: Record<string, string> = { query: files.filters.kw.trim() }
    if (files.filters.domain && files.filters.domain !== '全部') params.domain = files.filters.domain
    if (files.filters.agent && files.filters.agent !== '全部') params.agent = files.filters.agent
    const r = await api.search.knowledge(params)
    smartItems.value = r.items || []
  } catch {
    ui.toast('混合检索失败')
    smartItems.value = []
  } finally {
    smartLoading.value = false
  }
}

/** 结果行点击：关联文件 → 点击归因（Web 漏斗 level1）+ 详情抽屉；纯词条 → 成品仓按标题找 */
function openSmartItem(it: any) {
  if (!it.entry_path) {
    api.search.click(Number(it.id), files.filters.kw.trim()).catch(() => { /* 归因旁路失败不打扰 */ })
    ui.openDrawer(Number(it.id))
  } else {
    router.push({ path: '/entry', query: { kw: it.title || '' } })
  }
}

useDebouncedWatch(() => files.filters.kw, onFilter, 350)

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
