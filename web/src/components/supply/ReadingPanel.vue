<template>
  <div>
    <!-- 二级小 Tab -->
    <div class="tabs sm" style="margin-bottom:14px">
      <button class="tab" :class="{ on: readTab === 'curated' }" @click="readTab = 'curated'">精选推荐</button>
      <button class="tab" :class="{ on: readTab === 'pool' }" @click="readTab = 'pool'">推荐池（{{ pool.length }}）</button>
    </div>

    <!-- 精选推荐（AI 策展卡片） -->
    <div v-if="readTab === 'curated'" class="sect">
      <div class="sect-head">
        <span class="sq"></span><h2 class="stitle">精选推荐</h2><span class="sect-en">Curated Picks</span>
        <div class="sright" style="display:flex;gap:8px;align-items:center">
          <span class="cap mono">{{ curated.lastAt ? '策展于 ' + fmtTime(curated.lastAt) : '尚未策展' }}</span>
          <button class="btn xs" :disabled="curating" @click="runCurate"><Icon name="zap" :size="12" /> {{ curated.lastAt ? '重新策展' : 'AI 策展' }}</button>
        </div>
      </div>
      <div v-if="curated.items.length" class="ccards">
        <div v-for="c in curated.items" :key="c.id" class="ccard">
          <div class="cc-main">
            <b style="font-size:13px">{{ c.title || c.name }}</b>
            <span class="cap">{{ c.reason }}<span v-if="c.reason_source === 'llm'" style="color:var(--wikilink)"> · AI</span></span>
          </div>
          <div class="cc-path">
            <span class="mono" :title="c.path">{{ c.path }}</span>
            <button class="btn xs" title="复制路径" @click="copyPath(c.path)"><Icon name="copy" :size="12" /></button>
          </div>
          <div class="cc-ops">
            <span class="cap"><span class="dot" :style="{ background: statusColor(c.status) }"></span> {{ statusLabel(c.status) }}</span>
            <button class="btn xs" @click="openFile(c.file_id, 'preview')"><Icon name="external" :size="12" /> 打开</button>
          </div>
        </div>
      </div>
      <div v-else class="cap sect-empty">点击「AI 策展」，AI 会从已蒸馏的文章里挑 10 篇最值得细读的，并给每篇一句推荐语。</div>
    </div>

    <!-- 推荐池 + 冷启动推荐（预览收纳） -->
    <template v-else>
      <div class="sect">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">推荐池</h2><span class="sect-en">Reading Pool</span>
          <div class="sright" style="display:flex;gap:6px">
            <button v-for="s in POOL_STATUS" :key="s.v" class="chip" :class="{ on: poolStatus === s.v }" @click="poolStatus = s.v">{{ s.t }}</button>
          </div>
        </div>
        <table class="rtable">
          <thead><tr><th>内容</th><th style="width:74px">状态</th><th style="width:210px">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in pool" :key="r.id">
              <td>
                <b style="font-size:13px">{{ r.title || r.name }}</b>
                <span v-if="(r.progress || 0) > 0 && r.progress < 100" class="cap mark-warn" style="margin-left:8px">· 在读中</span>
                <br /><span class="cap">{{ r.reason }}<template v-if="r.created_at"> · {{ fmtTime(r.created_at) }} 收纳</template></span>
                <!-- 阅读进度（R1）：手动挡 25/50/75/100，仅展示不参与排序 -->
                <div v-if="r.status !== 'archived'" class="bar-mini" style="margin-top:5px">
                  <span class="bar-track" style="width:72px"><span class="bar-fill" :style="{ width: (r.progress || 0) + '%' }"></span></span>
                  <span class="mono" style="font-size:11.5px">{{ r.progress || 0 }}%</span>
                  <span style="display:flex;gap:4px">
                    <button v-for="p in [25, 50, 75, 100]" :key="p" class="btn xs" @click="setProgress(r, p)">{{ p }}%</button>
                  </span>
                </div>
              </td>
              <td><span class="cap"><span class="dot" :style="{ background: statusColor(r.status) }"></span> {{ statusLabel(r.status) }}</span></td>
              <td>
                <span style="display:flex;gap:6px;flex-wrap:wrap">
                  <button v-if="/^\.md$|^\.html?$/i.test(r.ext || '')" class="btn xs" @click="openReader(r.file_id)"><Icon name="eye" :size="12" /> 站内读</button>
                  <button class="btn xs" @click="openFile(r.file_id, 'pool')"><Icon name="external" :size="12" /> 打开</button>
                  <button class="btn xs" @click="rateItem(r)"><Icon name="zap" :size="12" /> 打分</button>
                  <button class="btn xs" @click="removeFromPool(r)"><Icon name="trash" :size="12" /> 移出</button>
                </span>
              </td>
            </tr>
            <tr v-if="!pool.length">
              <td colspan="3" style="text-align:center;padding:18px">
                <span class="cap">{{ poolLoading ? '加载中…' : '推荐池还是空的 · 从下方冷启动推荐里收纳感兴趣的内容' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="notice">打开只算浏览；读完点「打分」选可执行性——「立即试 / 稍后试」进入总览执行队列，「纯了解」归档。打分后状态自动升级为已读。</div>
      </div>

      <!-- 冷启动推荐（预览，不入库） -->
      <div class="sect" style="margin-top:14px">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">冷启动推荐</h2><span class="sect-en">Cold Start Picks</span><div class="sright"><span class="cap">按筛选挑优秀内容 · 收纳后进上方推荐池</span></div></div>
        <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
          <div class="form-grid" style="gap:9px 12px">
            <span class="fl">领域</span>
            <select class="inp" v-model="fDomain" @change="fetchPreview">
              <option value="">全部领域</option>
              <option v-for="d in flattenDomains()" :key="d.id" :value="d.id">{{ d.parent_id ? '— ' : '' }}{{ d.name }}</option>
            </select>
            <span class="fl">类型</span>
            <span style="display:flex;gap:8px;flex-wrap:wrap">
              <button v-for="o in TYPE_OPTIONS" :key="o.v" class="chip" :class="{ on: fType === o.v }" @click="fType = o.v; fetchPreview()">{{ o.t }}</button>
            </span>
            <span class="fl">来源</span>
            <select class="inp" v-model="fAgent" @change="fetchPreview">
              <option value="">全部来源</option>
              <option v-for="a in agentList" :key="a.name" :value="a.name">{{ a.name }}</option>
            </select>
            <span class="fl">标签</span>
            <select class="inp" v-model="fTag" @change="fetchPreview">
              <option value="">全部标签</option>
              <option v-for="t in tags" :key="t.id" :value="t.name">{{ t.parent_name ? `${t.name} · ${t.parent_name}` : t.name }}（{{ t.file_count }}）</option>
            </select>
            <span class="fl">关键词</span>
            <span style="display:flex;gap:8px">
              <input class="inp" v-model="fKw" placeholder="标题 / 文件名 / 路径" @keyup.enter="fetchPreview" />
              <button class="btn" :disabled="previewLoading" @click="fetchPreview"><Icon name="search" :size="13" /> 筛选</button>
            </span>
          </div>
        </div>
        <table class="rtable">
          <thead><tr><th>推荐内容</th><th style="width:190px">别名</th><th style="width:240px">原始路径</th><th style="width:170px">操作</th></tr></thead>
          <tbody>
            <tr v-for="it in preview" :key="it.id">
              <td>
                <b style="font-size:13px">{{ it.title || it.name }}</b>
                <span v-if="it.in_pool" class="cap mark-ok" style="margin-left:8px">· 已在池</span>
                <br /><span class="cap">{{ it.reason }}</span>
              </td>
              <td data-l="别名"><span class="aliascell" :title="it.alias">{{ it.alias }}</span></td>
              <td data-l="原始路径">
                <span class="pathcell">
                  <span class="mono" :title="it.path">{{ it.path }}</span>
                  <button class="btn xs" title="复制路径" @click="copyPath(it.path)"><Icon name="copy" :size="12" /></button>
                </span>
              </td>
              <td>
                <span style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="btn xs" @click="openFile(it.id, 'preview')"><Icon name="external" :size="12" /> 打开</button>
                  <button class="btn xs" :disabled="!!it.in_pool" @click="addToPool(it)"><Icon name="plus" :size="12" /> {{ it.in_pool ? '已收纳' : '收纳' }}</button>
                </span>
              </td>
            </tr>
            <tr v-if="!preview.length">
              <td colspan="4" style="text-align:center;padding:18px">
                <span class="cap">{{ previewLoading ? '加载中…' : '没有符合筛选的内容 · 放宽条件再试试' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="notice">排序：有 AI 质量分的优先，其余按规则分（类型 + 内容规模）兜底；预览只是「看看有什么好货」，点收纳才进上方推荐池。</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// 人工阅读面板：精选推荐 / 推荐池 / 冷启动预览（Supply.vue 拆分，~250 行独立内聚域）
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { useUiStore } from '../../stores/useUiStore'
import { useDomainsStore } from '../../stores/useDomainsStore'
import { api } from '../../api'
import { fmtTime } from '../../utils/format'
import { useCopyToClipboard } from '../../composables/ui'

const ui = useUiStore()
const router = useRouter()
const domains = useDomainsStore()

const { copy: copyWithToast } = useCopyToClipboard()

/** 站内阅读入口（R4-M2）：阅读器自动回位与进度记录，打开埋点由 /content 记 source=reader */
function openReader(id: number) {
  router.push(`/reader/${id}`)
}

const readTab = ref<'curated' | 'pool'>('curated')

// ---- 人工阅读：冷启动预览 + 推荐池 ----
const TYPE_OPTIONS = [
  { v: '', t: '全部' },
  { v: 'html', t: 'HTML' },
  { v: 'md', t: 'Markdown' }
] as const
const POOL_STATUS = [
  { v: '', t: '全部' },
  { v: 'unread', t: '未读' },
  { v: 'read', t: '已读' },
  { v: 'archived', t: '已归档' }
] as const

const loaded = ref(false)
const fDomain = ref<number | ''>('')
const fType = ref<'' | 'html' | 'md'>('')
const fAgent = ref('')
const fTag = ref('')
const fKw = ref('')
const preview = ref<any[]>([])
const previewLoading = ref(false)
const poolStatus = ref<'' | 'unread' | 'read' | 'archived'>('')
const pool = ref<any[]>([])
const poolLoading = ref(false)
const tags = ref<any[]>([])
const agentList = ref<any[]>([])

const STATUS_LABEL: Record<string, string> = { unread: '未读', read: '已读', archived: '已归档' }
const statusLabel = (s: string) => STATUS_LABEL[s] || s
const statusColor = (s: string) => s === 'unread' ? 'var(--run)' : s === 'read' ? 'var(--ok)' : 'var(--text-3)'

// 精选推荐（AI 策展）
const curated = ref<{ items: any[]; lastAt: string | null }>({ items: [], lastAt: null })
const curating = ref(false)

async function fetchCurated() {
  try {
    curated.value = await api.recommend.curated()
  } catch { /* 策展结果加载失败保持空 */ }
}

async function copyPath(t: string) {
  await copyWithToast(t, '已复制路径')
}

async function runCurate() {
  if (curating.value) return
  curating.value = true
  try {
    const r: any = await api.recommend.curate()
    if (r?.success) ui.toast('AI 策展已入队 · 完成后点「刷新」查看精选卡片')
    else ui.toast(r?.message || '策展发起失败')
  } catch {
    ui.toast('策展发起失败')
  } finally {
    curating.value = false
  }
}

function flattenDomains() {
  const out: any[] = []
  for (const d of domains.tree) {
    out.push(d)
    for (const c of d.children || []) out.push(c)
  }
  return out
}

async function init() {
  if (loaded.value) return
  loaded.value = true
  try { if (!domains.tree.length) await domains.fetchDomains() } catch { /* 领域加载失败保持空 */ }
  try { tags.value = (await api.tags.list({ sort: 'name', limit: '5000' })).items || [] } catch { /* 标签加载失败保持空 */ }
  try { agentList.value = ((await api.scan.agents()) as any[]).filter(a => a.exists) } catch { /* 来源加载失败保持空 */ }
  await Promise.all([fetchPreview(), fetchPool(), fetchCurated()])
}

watch(poolStatus, fetchPool)
// 打分弹层关闭后刷新推荐池（打分会把 unread 升级为 read / 入执行队列）
watch(() => ui.modal, m => { if (!m && loaded.value) fetchPool() })

async function fetchPreview() {
  previewLoading.value = true
  try {
    const params: Record<string, string> = { limit: '30' }
    if (fDomain.value !== '') params.domains = String(fDomain.value)
    if (fType.value) params.types = fType.value
    if (fAgent.value) params.agents = fAgent.value
    if (fTag.value) params.tags = fTag.value
    if (fKw.value.trim()) params.kw = fKw.value.trim()
    const r = await api.recommend.preview(params)
    preview.value = r.items || []
  } catch {
    ui.toast('推荐预览加载失败')
  } finally {
    previewLoading.value = false
  }
}

async function fetchPool() {
  poolLoading.value = true
  try {
    const r = await api.recommend.list(poolStatus.value)
    pool.value = r.items || []
  } catch {
    ui.toast('推荐池加载失败')
  } finally {
    poolLoading.value = false
  }
}

async function openFile(id: number, source: 'preview' | 'pool') {
  const r: any = await api.files.open(id, source)
  if (r?.success) ui.toast(r.lastProgress ? `已在本地打开 · 上次读到 ${r.lastProgress}%，继续加油` : '已在本地打开 · 打开记一次浏览')
  else ui.toast(r?.message || '打开失败')
}

// 阅读进度（R1）：行内快捷档，直接改本地行数据避免整表刷新
async function setProgress(row: any, p: number) {
  const r: any = await api.reading.progress(row.file_id, p)
  if (r?.success) {
    row.progress = p
    ui.toast(p === 100 ? '已标记读毕 · 点「打分」完成阅读闭环' : `已记录进度 ${p}%`)
  } else {
    ui.toast(r?.message || '进度记录失败')
  }
}

async function addToPool(item: any) {
  const r: any = await api.recommend.add(item.id)
  if (r?.success) {
    ui.toast(r.already ? '该内容已在推荐池' : '已收纳进推荐池')
    await Promise.all([fetchPreview(), fetchPool()])
  } else {
    ui.toast(r?.message || '收纳失败')
  }
}

function rateItem(row: any) {
  ui.openModal('rate', { fileId: row.file_id ?? row.id, title: row.title || row.name, progress: row.progress || 0 })
}

async function removeFromPool(row: any) {
  const r: any = await api.recommend.remove(row.id)
  if (r?.success !== false) {
    ui.toast('已移出推荐池')
    await Promise.all([fetchPool(), fetchPreview()])
  } else {
    ui.toast(r?.message || '移出失败')
  }
}

defineExpose({
  init,
  refresh: async () => { await Promise.all([fetchPreview(), fetchPool(), fetchCurated()]) }
})
</script>
