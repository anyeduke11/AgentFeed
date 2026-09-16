<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">04</span>
      <h1 class="vtitle">精炼线</h1>
      <span class="vsub">管线 · LLM 队列四泳道</span>
      <div class="vright">
        <button class="btn sm" @click="refresh"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>
    </div>

    <!-- 控制台 -->
    <div class="console">
      <span class="qchip" :class="{ paused: paused }">
        <span class="dot" :class="paused ? 'dot-pause' : 'dot-run'"></span>{{ paused ? '已暂停' : '运行中' }}
      </span>
      <button class="btn" :class="{ signal: paused }" @click="togglePause">
        <Icon :name="paused ? 'play' : 'pause'" :size="15" /> {{ paused ? '恢复队列' : '暂停队列' }}
      </button>
      <span class="cap mono">{{ queueSummary }}</span>
      <div class="sright">
        <button class="btn sm" :class="{ primary: !onlyErr }" @click="onlyErr = false">全部通道</button>
        <button class="btn sm" :class="{ primary: onlyErr }" @click="onlyErr = true">仅看异常</button>
        <button class="btn sm danger" @click="retryAll"><Icon name="rotate" :size="14" /> 全部重试</button>
      </div>
    </div>

    <!-- 队列汇总 -->
    <div class="qsum">
      <div class="qsum-i"><span class="dot dot-pend"></span><span class="qsum-v">{{ q.pending.length }}</span><span class="qsum-k">待处理</span></div>
      <div class="qsum-i"><span class="dot dot-run"></span><span class="qsum-v">{{ q.running.length }}</span><span class="qsum-k">精炼中</span></div>
      <div class="qsum-i"><span class="dot dot-done"></span><span class="qsum-v">{{ doneCount }}</span><span class="qsum-k">已蒸馏</span></div>
      <div class="qsum-i"><span class="dot dot-fail"></span><span class="qsum-v">{{ q.failed.length }}</span><span class="qsum-k">失败</span></div>
      <div class="qsum-i"><span class="dot dot-skip"></span><span class="qsum-v">{{ q.skipped.length }}</span><span class="qsum-k">已跳过</span></div>
    </div>

    <div v-if="onlyErr" class="cap" style="margin:0 0 8px">仅显示失败与超时项 · 共 {{ q.failed.length }} 项</div>

    <!-- 四泳道看板 -->
    <div class="qboard" :class="{ 'only-err': onlyErr, paused: paused }">
      <div class="lane lane-pending">
        <div class="lane-head"><span class="dot dot-pend"></span>待处理<span class="lane-count">{{ q.pending.length }}</span></div>
        <div class="lane-body">
          <div v-for="p in pendShow" :key="p.fileId" class="qcard">
            <div class="qc-name">{{ p.title || p.name }}</div>
            <div class="qc-meta"><span>{{ p.agent || '未知来源' }}</span><span>{{ fmtTime(p.file_mtime) }}</span></div>
          </div>
          <button v-if="q.pending.length > PEND_MAX" class="pend-more" @click="pendExpand = !pendExpand">
            <Icon :name="pendExpand ? 'chevronDown' : 'chevronDown'" :size="14" />
            {{ pendExpand ? '收起列表' : `展开其余 ${q.pending.length - PEND_MAX} 条` }}
          </button>
          <div v-if="!q.pending.length" class="pend-more" style="cursor:default">待处理队列为空</div>
        </div>
      </div>

      <div class="lane lane-running">
        <div class="lane-head"><span class="dot dot-run"></span>精炼中<span class="lane-count">{{ q.running.length }}</span></div>
        <div class="lane-body">
          <div v-for="r in q.running" :key="r.fileId" class="qcard">
            <div class="qc-name">{{ r.title || r.name }}</div>
            <div class="qc-meta"><span>{{ r.agent || '未知来源' }}</span><span>{{ r.model || llm.providers.defaultModel || '默认模型' }}</span></div>
            <div class="qc-prog">
              <div class="progress" style="flex:1;margin-top:0"><div class="pfill" style="width:38%"></div></div>
              <span v-if="paused" class="qc-stag">已暂停</span>
            </div>
            <div class="qc-meta"><span>更新于 {{ fmtTime(r.updated_at) }}</span></div>
          </div>
          <div v-if="!q.running.length" class="pend-more" style="cursor:default">暂无进行中任务</div>
        </div>
      </div>

      <div class="lane lane-fail">
        <div class="lane-head"><span class="dot dot-fail"></span>失败<span class="lane-count" style="margin-left:0">{{ q.failed.length }}</span><button v-if="q.failed.length" class="btn xs" style="margin-left:auto" :disabled="retryingAll" @click="retryAllFailed"><Icon name="rotate" :size="12" /> {{ retryingAll ? '重试中…' : '一键重试' }}</button></div>
        <div class="lane-body">
          <div v-for="f in q.failed" :key="f.fileId" class="qcard fail">
            <div class="qc-name">{{ f.title || f.name }}</div>
            <div class="qc-reason"><Icon name="alert" :size="13" /> {{ errOf(f.fileId) }}</div>
            <div class="qc-meta"><span>{{ f.agent || '未知来源' }}</span></div>
            <div class="qc-actions"><button class="btn xs" @click="retryOne(f.fileId)"><Icon name="rotate" :size="12" /> 重试</button></div>
          </div>
          <div v-if="!q.failed.length" class="pend-more" style="cursor:default">通道畅通，暂无失败任务</div>
        </div>
      </div>

      <div class="lane lane-skip">
        <div class="lane-head"><span class="dot dot-skip"></span>已跳过<span class="lane-count">{{ q.skipped.length }}</span></div>
        <div class="lane-body">
          <div v-for="s in q.skipped" :key="s.fileId" class="qcard">
            <div class="qc-name">{{ s.title || s.name }}</div>
            <div class="qc-meta"><span>{{ s.agent || '未知来源' }}</span></div>
            <div class="qc-actions"><button class="btn xs" @click="retryOne(s.fileId)"><Icon name="refresh" :size="12" /> 重新入队</button></div>
          </div>
          <div v-if="!q.skipped.length" class="pend-more" style="cursor:default">暂无跳过任务</div>
        </div>
      </div>
    </div>

    <div class="pipe-grid" style="grid-template-columns:minmax(0,1fr)">
      <!-- 趋势：与总览「近 15 天 LLM 调用」同款（同一接口 api.stats.dashboard，堆叠柱 + 模型图例）；调用日志已迁移至调度室·日志管理 -->
      <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">近 15 天 LLM 调用</h2><div class="sright"><span class="cap mono">合计 {{ trend.sum }}</span></div></div>
        <div class="trend" v-if="trend.labels.length">
          <div v-for="(v, i) in trend.vals" :key="i" class="tb" :class="{ today: i === trend.vals.length - 1 }">
            <span class="tb-v">{{ v || '' }}</span>
            <span class="tb-bar stack" :style="{ height: trendH(v) + '%' }">
              <i v-for="(m, mi) in trendModels" :key="mi" class="tb-seg" :style="{ height: segPct(m, i) + '%', background: modelColor(mi) }"></i>
            </span>
            <span class="tb-l">{{ trend.labels[i] }}</span>
          </div>
        </div>
        <div v-if="trendModels.length" class="cap" style="display:flex;flex-wrap:wrap;gap:6px 16px;padding:10px 14px 0">
          <span v-for="(m, mi) in trendModels" :key="m.name" style="display:flex;align-items:center;gap:5px" :title="`${m.name}：近 15 天共 ${m.vals.reduce((s: number, v: number) => s + v, 0)} 次调用`">
            <i :style="{ width: '10px', height: '10px', background: modelColor(mi), display: 'inline-block', borderRadius: '2px', border: '1px solid var(--border)' }"></i>
            <span class="mono">{{ m.name }}</span>· {{ m.vals.reduce((s: number, v: number) => s + v, 0) }} 次
          </span>
        </div>
        <div class="cap" style="padding:6px 14px 12px">近 30 天：{{ dash.llm30?.calls ?? 0 }} 次调用 · {{ fmtTokens(dash.llm30?.tokens) }} tokens · 成功率 {{ dash.llm30?.rate ?? '—' }}%</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { useLlmStore } from '../stores/useLlmStore'
import { useUiStore } from '../stores/useUiStore'
import { api } from '../api'

const llm = useLlmStore()
const ui = useUiStore()

const onlyErr = ref(false)
const pendExpand = ref(false)
const PEND_MAX = 6
const dash = ref<any>({})
const errMap = ref<Record<number, string>>({})
let timer: ReturnType<typeof setInterval> | null = null

const q = computed(() => llm.queue)
const paused = computed(() => !!q.value.paused)
const pendShow = computed(() => (pendExpand.value ? q.value.pending : q.value.pending.slice(0, PEND_MAX)))
const doneCount = computed(() => dash.value.queue?.done ?? 0)

/* 控制台摘要：与实际调度一致 —— 启用节点时展示节点池模型与各服务商并发，全关时回退默认模型 */
const activeNodes = ref<any[]>([])
const queueSummary = computed(() => {
  const conc = (q.value as any).providerConcurrency || {}
  const concStr = Object.keys(conc).length
    ? Object.entries(conc).map(([p, c]) => `${p} ${c}`).join(' / ')
    : String(q.value.concurrency ?? '—')
  const enabled = activeNodes.value.filter(n => n.enabled)
  if (!enabled.length) return `并发 ${concStr} · 模型 ${llm.providers.defaultModel || '默认模型'}`
  return `并发 ${concStr} · 节点 ${enabled.map(n => n.model).join(' + ')}`
})

const trend = computed(() => dash.value.trend || { labels: [], vals: [], sum: 0 })

function trendH(v: number) {
  const max = Math.max(1, ...(trend.value.vals || []))
  return Math.max(4, Math.round((v / max) * 100))
}

// 与 Overview.vue 保持一致：模型调色板 + 各日段占比（同一 api.stats.dashboard 数据）
const MODEL_COLORS = ['#2456A6', '#B4651A', '#2E7D4F', '#7B4BA6', '#B3402A', '#1F7A8C', '#8C6D1F', '#5A5A5A']
const trendModels = computed<any[]>(() => trend.value.models || [])
function modelColor(i: number) {
  return MODEL_COLORS[i % MODEL_COLORS.length]
}
function segPct(m: any, i: number) {
  const total = trend.value.vals?.[i] || 0
  return total > 0 ? ((m.vals?.[i] || 0) / total) * 100 : 0
}
function fmtTokens(n?: number) {
  if (!n) return '0'
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
}

function errOf(fileId: number) {
  return errMap.value[fileId] || 'LLM 调用失败（详见 调度室 → 日志管理 → LLM 调用）'
}

function fmtTime(t?: string) {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

async function refresh() {
  await Promise.all([
    llm.fetchQueue(),
    llm.fetchLogs(),
    llm.fetchProviders(),
    api.stats.dashboard().then(d => { dash.value = d }),
    api.llm.llmNodes().then(d => { activeNodes.value = d.nodes || [] }).catch(() => {})
  ])
  // 从 store 最近日志（5 条）提取每个文件的最近一次失败原因，供失败泳道展示
  const map: Record<number, string> = {}
  for (const l of [...llm.logs].reverse()) {
    if (l.file_id && l.error && !map[l.file_id]) map[l.file_id] = l.error
  }
  errMap.value = map
}

async function togglePause() {
  await ui.togglePause()
  await refresh()
}

async function retryOne(fileId: number) {
  await llm.retry(fileId)
  ui.toast('已重新入队')
  await refresh()
}

async function retryAll() {
  const r = await llm.retryAll()
  ui.toast(`已重新入队 ${(r as any)?.queued ?? 0} 个失败任务`)
  await refresh()
}

// 失败泳道头部一键重试（复用全部重试接口，带进行中状态防重复点击）
const retryingAll = ref(false)
async function retryAllFailed() {
  retryingAll.value = true
  try {
    const r = await llm.retryAll()
    ui.toast(`已重新入队 ${(r as any)?.queued ?? 0} 个失败任务`)
    await refresh()
  } finally {
    retryingAll.value = false
  }
}

onMounted(async () => {
  await refresh()
  ui.queuePaused = paused.value
  timer = setInterval(refresh, 8000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>
