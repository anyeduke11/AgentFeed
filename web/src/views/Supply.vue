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

    <!-- ============ Tab 1：Agent 供给（MCP） ============ -->
    <div v-if="viewTab === 'agent'" class="sup-grid">
      <div class="ov-col">
        <!-- MCP 服务状态 -->
        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">MCP 服务状态</h2><div class="sright"><span class="cap">{{ mcpEnabled ? 'stdio 随客户端启动' : '已停用 · 工具调用将拒绝' }}</span><button class="switch" role="switch" :aria-checked="mcpEnabled ? 'true' : 'false'" aria-label="MCP 服务总闸" :disabled="mcpBusy" @click="toggleMcp"></button></div></div>
          <div class="kvgrid" style="padding:12px 14px">
            <span class="k">服务名</span><span class="mono">agentfeed-knowledge</span>
            <span class="k">版本</span><span class="mono">0.1.0</span>
            <span class="k">传输</span><span>stdio（不暴露 HTTP 端口）</span>
            <span class="k">数据目录</span><span class="mono">./server/data</span>
            <span class="k">监听</span><span>仅本机 127.0.0.1</span>
            <span class="k">累计发车</span><span class="mono">{{ mcp.total }} 次（本周 {{ mcp.week }} 次）</span>
          </div>
        </div>

        <!-- 工具发车统计 -->
        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">工具发车统计</h2><div class="sright"><span class="cap mono">本周 {{ mcp.week }} 次</span></div></div>
          <table class="rtable">
            <thead><tr><th>工具</th><th>调用次数</th><th>最近调用</th><th>占比</th></tr></thead>
            <tbody>
              <tr v-for="t in mcp.byTool" :key="t.n">
                <td class="c-main"><b class="mono">{{ t.n }}</b></td>
                <td class="c-dim" data-l="调用次数"><span class="cv">{{ t.calls }} 次</span></td>
                <td class="c-dim" data-l="最近调用"><span class="cv">{{ fmtTime(t.last) }}</span></td>
                <td data-l="占比"><span class="cv">
                  <span class="bar-mini">
                    <span class="bar-track"><span class="bar-fill" :style="{ width: toolPct(t.calls) + '%' }"></span></span>
                    <span class="mono" style="font-size:11.5px">{{ toolPct(t.calls) }}%</span>
                  </span>
                </span></td>
              </tr>
              <tr v-if="!(mcp.byTool || []).length">
                <td colspan="4" style="text-align:center;padding:18px">
                  <span class="cap">暂无调用记录 · 在 AI 客户端挂载本服务并调用工具后，这里会显示发车统计。</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="ov-col">
        <!-- 工具清单 -->
        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">工具清单（{{ TOOLS.length }} 个）</h2><div class="sright"><span class="cap">供 AI 客户端挂载调用</span></div></div>
          <div class="tools">
            <div v-for="t in TOOLS" :key="t.n" class="tool">
              <span class="tn">{{ t.n }}</span>
              <span class="td">{{ t.d }}</span>
            </div>
          </div>
        </div>

        <!-- 挂载配置 -->
        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">客户端挂载配置</h2><div class="sright"><span class="cap">三端配置一致</span></div></div>
          <div style="padding:12px 14px 14px">
            <div class="tabs">
              <button v-for="c in CLIENTS" :key="c" class="tab" :class="{ on: tab === c }" @click="tab = c">{{ c }}</button>
            </div>
            <pre class="codeblock">{{ configText }}</pre>
            <div class="codebar">
              <span class="supply-note">{{ HINTS[tab] }}</span>
              <span style="margin-left:auto"><button class="btn sm" @click="copyConfig"><Icon name="copy" :size="14" /> 复制配置</button></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ Tab 2：人工阅读（精选推荐 / 推荐池 二级切换） ============ -->
    <div v-else>
      <!-- 二级小 Tab -->
      <div class="tabs sm" style="margin-bottom:14px">
        <button class="tab" :class="{ on: readTab === 'curated' }" @click="readTab = 'curated'">精选推荐</button>
        <button class="tab" :class="{ on: readTab === 'pool' }" @click="readTab = 'pool'">推荐池（{{ pool.length }}）</button>
      </div>

      <!-- 精选推荐（AI 策展卡片） -->
      <div v-if="readTab === 'curated'" class="sect">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">精选推荐</h2>
          <div class="sright" style="display:flex;gap:8px;align-items:center">
            <span class="cap mono">{{ curated.lastAt ? '策展于 ' + fmtTime(curated.lastAt) : '尚未策展' }}</span>
            <button class="btn xs" :disabled="curating" @click="runCurate"><Icon name="zap" :size="12" /> {{ curated.lastAt ? '重新策展' : 'AI 策展' }}</button>
          </div>
        </div>
        <div v-if="curated.items.length" class="ccards">
          <div v-for="c in curated.items" :key="c.id" class="ccard">
            <div class="cc-main">
              <b style="font-size:13px">{{ c.title || c.name }}</b>
              <span class="cap">{{ c.reason }}<span v-if="c.reason_source === 'llm'" style="color:#7A5AA8"> · AI</span></span>
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
        <div v-else class="cap" style="padding:14px">点击「AI 策展」，AI 会从已蒸馏的文章里挑 10 篇最值得细读的，并给每篇一句推荐语。</div>
      </div>

      <!-- 推荐池 + 冷启动推荐（预览收纳） -->
      <template v-else>
        <div class="sect">
          <div class="sect-head">
            <span class="sq"></span><h2 class="stitle">推荐池</h2>
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
                  <span v-if="(r.progress || 0) > 0 && r.progress < 100" class="cap" style="margin-left:8px;color:#B4651A">· 在读中</span>
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
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">冷启动推荐</h2><div class="sright"><span class="cap">按筛选挑优秀内容 · 收纳后进上方推荐池</span></div></div>
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
                  <span v-if="it.in_pool" class="cap" style="margin-left:8px;color:#1E8E5A">· 已在池</span>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { useUiStore } from '../stores/useUiStore'
import { useDomainsStore } from '../stores/useDomainsStore'
import { api } from '../api'

const ui = useUiStore()
const router = useRouter()

/** 站内阅读入口（R4-M2）：阅读器自动回位与进度记录，打开埋点由 /content 记 source=reader */
function openReader(id: number) {
  router.push(`/reader/${id}`)
}
const domains = useDomainsStore()
const viewTab = ref<'agent' | 'reading'>('agent')
const readTab = ref<'curated' | 'pool'>('curated')
const mcp = ref<any>({ week: 0, total: 0, byTool: [] })
const mcpEnabled = ref(true)
const mcpBusy = ref(false)
const tab = ref('Trae')

const vsub = computed(() => viewTab.value === 'agent'
  ? 'MCP 供给 · 工具与客户端挂载'
  : '人工阅读 · 冷启动推荐与阅读闭环')

const CLIENTS = ['Trae', 'Claude Desktop', 'Cursor']
const HINTS: Record<string, string> = {
  Trae: '粘贴到 Trae 的 MCP 配置（mcp.json）后重启客户端',
  'Claude Desktop': '粘贴到 claude_desktop_config.json 后重启应用',
  Cursor: '粘贴到 Cursor 的 MCP 配置文件后重启编辑器'
}

const TOOLS = [
  { n: 'search_knowledge', d: '按关键词 / 领域 / 标签检索资料库，返回文件与词条摘要' },
  { n: 'read_entry', d: '读取某个文件对应的 wiki 词条（摘要 / 要点 / 实体 / 关系）' },
  { n: 'get_source', d: '获取源文件路径与元信息，用于回链定位本地原文' },
  { n: 'list_domains', d: '列出知识领域树及各领域文件计数' },
  { n: 'list_agents', d: '列出资料来源 agent 及文件数分布' },
  { n: 'list_tags', d: '列出全部标签及使用情况' },
  { n: 'stats', d: '返回知识库总体统计（文件 / 词条 / 队列 / 调用）' }
]

const configText = computed(() => JSON.stringify({
  mcpServers: {
    'agentfeed-knowledge': {
      command: 'npm',
      args: ['run', 'mcp'],
      cwd: '<AgentFeed 仓库路径>/server'
    }
  }
}, null, 2))

// 占比分母 = 全部工具调用总数（曾误用最大值：榜首恒 100%，各行占比和超 100%）
const totalToolCalls = computed(() => (mcp.value.byTool || []).reduce((s: number, t: any) => s + (t.calls || 0), 0))
const toolPct = (calls: number) => totalToolCalls.value ? Math.round((calls / totalToolCalls.value) * 100) : 0

// MCP 总闸：失败回滚乐观更新
async function toggleMcp() {
  if (mcpBusy.value) return
  mcpBusy.value = true
  const next = !mcpEnabled.value
  mcpEnabled.value = next
  try {
    await api.config.set({ 'mcp.enabled': { value: next } })
  } catch {
    mcpEnabled.value = !next
  } finally {
    mcpBusy.value = false
  }
}

function fmtTime(t?: string) {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

async function refresh() {
  if (viewTab.value === 'agent') {
    mcp.value = await api.stats.mcp()
    api.config.get().then((cfg: any) => {
      const entry = cfg?.['mcp.enabled']
      if (entry) mcpEnabled.value = entry.value !== false
    }).catch(() => {})
  } else {
    await Promise.all([fetchPreview(), fetchPool(), fetchCurated()])
  }
}

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(configText.value)
    ui.toast('配置已复制，粘贴到对应客户端即可')
  } catch {
    ui.toast('复制失败，请手动选择复制')
  }
}

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

const readingLoaded = ref(false)
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
  try {
    await navigator.clipboard.writeText(t)
    ui.toast('已复制路径')
  } catch {
    ui.toast('复制失败，请手动选择复制')
  }
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

async function initReading() {
  if (readingLoaded.value) return
  readingLoaded.value = true
  try { if (!domains.tree.length) await domains.fetchDomains() } catch { /* 领域加载失败保持空 */ }
  try { tags.value = (await api.tags.list({ sort: 'name', limit: '5000' })).items || [] } catch { /* 标签加载失败保持空 */ }
  try { agentList.value = ((await api.scan.agents()) as any[]).filter(a => a.exists) } catch { /* 来源加载失败保持空 */ }
  await Promise.all([fetchPreview(), fetchPool(), fetchCurated()])
}

watch(viewTab, t => { if (t === 'reading') initReading() })
watch(poolStatus, fetchPool)
// 打分弹层关闭后刷新推荐池（打分会把 unread 升级为 read / 入执行队列）
watch(() => ui.modal, m => { if (!m && viewTab.value === 'reading' && readingLoaded.value) fetchPool() })

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

onMounted(refresh)
</script>
