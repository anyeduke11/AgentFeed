<template>
  <div>
    <div class="setrow">
      <span class="sr-k">连接状态</span>
      <span class="sr-v">
        <span v-if="ollamaProbing" class="cap">探测中…</span>
        <span v-else-if="ollamaOnline" class="qchip"><span class="dot dot-run"></span>在线 · {{ ollamaModels.length }} 个已装模型</span>
        <span v-else class="qchip paused"><span class="dot dot-pause"></span>离线 · 检查 Ollama 服务（默认 127.0.0.1:11434）</span>
      </span>
      <span class="sr-a"><button class="btn xs" :disabled="ollamaProbing" @click="probeOllama"><Icon name="refresh" :size="12" /> 重新检测</button></span>
    </div>
    <div class="setrow">
      <span class="sr-k">服务地址</span>
      <span class="sr-v"><span class="cap">Ollama 本地服务地址（默认 127.0.0.1:11434）· 本地服务无需密钥</span></span>
      <span class="sr-a" style="display:flex;gap:8px;align-items:center">
        <input class="inp" style="max-width:260px" v-model="ollamaDraft.baseUrl" aria-label="ollama baseUrl" />
        <button class="btn xs" @click="saveOllamaBaseUrl">保存</button>
      </span>
    </div>
    <template v-if="ollamaOnline">
      <div class="cap" style="display:block;margin:10px 14px 2px">已装模型：勾选启用（可多选同时调用）；点击类型徽标切换 对话 / 向量。</div>
      <div class="setrow" v-for="m in ollamaModels" :key="m.id">
        <span class="sr-k mono" style="font-size:12.5px">{{ m.id }}</span>
        <span class="sr-v"><span class="cap">{{ m.enabled ? '已启用' : '未启用' }}</span></span>
        <span class="sr-a" style="display:flex;gap:10px;align-items:center">
          <button class="btn xs" :title="'切换为' + (m.type === 'embedding' ? '对话' : '向量') + '模型'" @click="toggleModelType(m)">{{ m.type === 'embedding' ? '向量' : '对话' }}</button>
          <button class="switch" role="checkbox" :aria-checked="m.enabled ? 'true' : 'false'" :aria-label="'启用模型 ' + m.id" @click="toggleModelEnabled(m)"></button>
        </span>
      </div>
      <div class="setrow">
        <span class="sr-k">蒸馏向量化</span>
        <span class="sr-v"><span class="cap">蒸馏完成后自动用向量模型生成语义向量（支持语义检索）</span></span>
        <span class="sr-a" style="display:flex;gap:10px;align-items:center">
          <select class="inp" style="max-width:200px" v-model="embeddingModel" :style="embeddingEnabled ? '' : 'opacity:.35'" :disabled="!embeddingEnabled" aria-label="向量模型">
            <option value="">选择向量模型</option>
            <option v-for="m in embeddingCandidates" :key="m" :value="m">{{ m }}</option>
          </select>
          <button class="switch" role="switch" :aria-checked="embeddingEnabled ? 'true' : 'false'" aria-label="蒸馏向量化开关" @click="embeddingEnabled = !embeddingEnabled"></button>
        </span>
      </div>
      <div class="addroot">
        <button class="btn sm primary" @click="saveOllamaConfig"><Icon name="check" :size="14" /> 保存 Ollama 配置</button>
        <span class="supply-note">启用的模型会注册到本地服务商，可与云端模型并行使用；向量模型用于蒸馏后的语义向量化。</span>
      </div>
    </template>
    <div class="setrow">
      <span class="sr-k">向量库</span>
      <span class="sr-v"><span class="cap">词条向量覆盖 {{ embedStatus.covered }}/{{ embedStatus.entries }} · 分块 {{ embedStatus.chunks }} 块<template v-if="(embedStatus.pending || 0) > 0"> · 待嵌 {{ embedStatus.pending }} 词条（下方补嵌）</template></span></span>
      <span class="sr-a"></span>
    </div>
    <div class="setrow">
      <span class="sr-k">分块向量</span>
      <span class="sr-v"><span class="cap">词条分块向量（parent-child 检索）：已嵌 {{ chunkStatus.chunks }} 块 · 待嵌 {{ chunkStatus.pending }} 词条<template v-if="chunkStatus.running"> · 后台补嵌中…</template><template v-else-if="chunkStatus.lastRun"> · 上批 {{ chunkStatus.lastRun.reason === 'ok' ? `成功 ${chunkStatus.lastRun.indexed} 词条` : `中止（${chunkStatus.lastRun.reason}）` }}<template v-if="chunkStatus.lastRun.failed"> · 失败 {{ chunkStatus.lastRun.failed }}</template>{{ chunkStatus.lastRun.stopped && chunkStatus.lastRun.reason === 'ok' ? '（已停止）' : '' }}</template></span></span>
      <span class="sr-a">
        <button v-if="!chunkStatus.running" class="btn xs" :disabled="!embedReady || !chunkStatus.pending" :title="embedReady ? '每批 50 词条，后台执行，可随时停止；本地向量嵌入较慢（~2.8 块/秒）' : '先开启蒸馏向量化并选择向量模型'" @click="startChunkBackfill"><Icon name="rotate" :size="12" /> 补嵌一批（50 词条）</button>
        <button v-else class="btn xs" title="当前词条完成后停止" @click="stopChunkBackfill">停止</button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">语义检索</span>
      <span class="sr-v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="inp" style="max-width:300px" v-model="searchQuery" placeholder="输入查询验证语义检索" aria-label="语义检索查询" @keyup.enter="doEmbedSearch" />
        <button class="btn xs" :disabled="!embedReady || !searchQuery.trim()" @click="doEmbedSearch"><Icon name="search" :size="12" /> 检索</button>
      </span>
      <span class="sr-a"></span>
    </div>
    <template v-if="searchHits.length">
      <div v-for="h in searchHits" :key="h.entry_id" class="delrow">
        <span class="dn">
          <span>{{ h.title }}</span>
          <span class="stb">相似度 {{ h.score.toFixed(3) }}</span>
          <span class="stb" :title="`命中分块：${h.heading_path || '词条全文'}`">{{ h.heading_path || '词条全文' }}</span>
        </span>
      </div>
    </template>
    <div v-else-if="searched" class="cap" style="display:block;padding:0 14px 8px">无检索结果（向量库为空或未向量化）。</div>
  </div>
</template>

<script setup lang="ts">
// Ollama 模型面板：连接探测 / 模型启停与类型 / 蒸馏向量化 / 分块补嵌 / 语义检索自测（SettingsAi 拆分）
// 依赖 ProvidersPanel 保存的 ollama baseUrl 草稿——通过 providers-drafts 事件向父级（壳）请求，壳转调 ProvidersPanel
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '../../Icon.vue'
import { useLlmStore } from '../../../stores/useLlmStore'
import { useUiStore } from '../../../stores/useUiStore'
import { api } from '../../../api'

const emit = defineEmits<{ saved: [] }>()

const llm = useLlmStore()
const ui = useUiStore()

const ollamaProbing = ref(false)
const ollamaOnline = ref(false)
const ollamaModels = ref<Array<{ id: string; type: 'chat' | 'embedding'; enabled: boolean }>>([])
const embeddingEnabled = ref(false)
const embeddingModel = ref('')
const embedStatus = ref({ entries: 0, covered: 0, chunks: 0, pending: 0, enabled: false, model: '' })
const searchQuery = ref('')
const searchHits = ref<Array<{ entry_id: number; title: string; score: number; chunk_index: number; heading_path: string; snippet: string }>>([])
const searched = ref(false)

const embeddingCandidates = computed(() =>
  ollamaModels.value.filter(m => m.type === 'embedding' && m.enabled).map(m => m.id)
)
const embedReady = computed(() => embedStatus.value.enabled && !!embedStatus.value.model)

async function probeOllama() {
  ollamaProbing.value = true
  try {
    const data = await api.llm.ollamaModels()
    ollamaOnline.value = !!data.online
    ollamaModels.value = data.models || []
  } catch {
    ollamaOnline.value = false
    ollamaModels.value = []
  } finally {
    ollamaProbing.value = false
  }
}

async function loadEmbedStatus() {
  try {
    const data = await api.llm.embeddingsStatus()
    embedStatus.value = data
    // 回填向量化开关与模型选择（仅当模型仍在候选列表中时保留）
    embeddingEnabled.value = !!data.enabled
    embeddingModel.value = data.model || ''
  } catch {
    /* 保持默认 */
  }
}

/** ollama 的 baseUrl 草稿：从服务商配置整体读改存（原实现共享 ProvidersPanel 的 draftPayload） */
const ollamaDraft = ref<{ name: string; baseUrl: string }>({ name: 'ollama', baseUrl: '' })

async function loadOllamaDraft() {
  try {
    const r = await api.config.get()
    const providers = r?.['ai.providers']?.value ? JSON.parse(r['ai.providers'].value) : []
    const hit = Array.isArray(providers) ? providers.find((p: any) => p.name === 'ollama') : null
    ollamaDraft.value = { name: 'ollama', baseUrl: hit?.baseUrl || '' }
  } catch { /* 保持默认 */ }
}

async function saveOllamaBaseUrl() {
  if (!ollamaDraft.value.baseUrl) { ui.toast('baseUrl 不能为空'); return }
  const r = await api.config.get()
  const providers = r?.['ai.providers']?.value ? JSON.parse(r['ai.providers'].value) : []
  const idx = Array.isArray(providers) ? providers.findIndex((p: any) => p.name === 'ollama') : -1
  if (idx >= 0) providers[idx].baseUrl = ollamaDraft.value.baseUrl
  else providers.push({ name: 'ollama', baseUrl: ollamaDraft.value.baseUrl, apiKey: '' })
  await api.llm.saveProviders({ providers })
  await llm.fetchProviders()
  probeOllama()
}

function syncEmbeddingModelValidity() {
  // 候选变化后，当前选中模型若失效则清空，避免保存非法配置
  if (embeddingModel.value && !embeddingCandidates.value.includes(embeddingModel.value)) {
    embeddingModel.value = ''
  }
}

function toggleModelEnabled(m: { id: string; type: 'chat' | 'embedding'; enabled: boolean }) {
  m.enabled = !m.enabled
  if (!m.enabled || m.type !== 'embedding') syncEmbeddingModelValidity()
}

function toggleModelType(m: { id: string; type: 'chat' | 'embedding'; enabled: boolean }) {
  m.type = m.type === 'embedding' ? 'chat' : 'embedding'
  syncEmbeddingModelValidity()
}

async function saveOllamaConfig() {
  const enabledModels = ollamaModels.value.filter(m => m.enabled).map(m => m.id)
  if (embeddingEnabled.value && !embeddingModel.value) {
    ui.toast('请先选择一个向量模型')
    return
  }
  const modelTypes: Record<string, string> = {}
  for (const m of ollamaModels.value) modelTypes[m.id] = m.type
  const res = await api.llm.saveOllamaConfig({
    enabledModels,
    modelTypes,
    embedding: { enabled: embeddingEnabled.value, provider: 'ollama', model: embeddingModel.value },
  })
  if (res?.success === false) { ui.toast(res.message || '保存失败'); return }
  await Promise.all([llm.fetchProviders(), loadEmbedStatus()])
  emit('saved')
  ui.toast('Ollama 配置已保存')
}

/* ---------- 向量队列轮询已随方案 B 移除（embedQueue 下线，无实时队列信号） ---------- */

/* ---------- 分块向量手动补嵌（entry_chunks，批次后台执行 + 轮询进度） ---------- */
const chunkStatus = ref<{ chunks: number; pending: number; running: boolean; lastRun: null | { at: string; batch: number; indexed: number; failed: number; stopped: boolean; reason: string } }>({ chunks: 0, pending: 0, running: false, lastRun: null })
let chunkPollTimer: ReturnType<typeof setInterval> | null = null

function syncChunkPoll() {
  if (chunkStatus.value.running && !chunkPollTimer) chunkPollTimer = setInterval(loadChunkStatus, 5000)
  if (!chunkStatus.value.running && chunkPollTimer) { clearInterval(chunkPollTimer); chunkPollTimer = null }
}

async function loadChunkStatus() {
  try {
    const data = await api.wiki.chunkBackfillStatus()
    if (data?.success !== false) chunkStatus.value = data
  } catch { /* 状态读取失败保旧值 */ }
  syncChunkPoll()
}

async function startChunkBackfill() {
  const res = await api.wiki.chunkBackfillStart(50)
  if (res?.success === false) { ui.toast(res.message || '无法启动补嵌'); return }
  ui.toast(res.started === false ? (res.message || '无待嵌词条') : `补嵌批次已启动（${res.batch} 词条，后台执行${res.deadSkipped ? `，跳过死链 ${res.deadSkipped}` : ''}）`)
  loadChunkStatus()
}

async function stopChunkBackfill() {
  await api.wiki.chunkBackfillStop()
  ui.toast('已请求停止，当前词条完成后生效')
  setTimeout(loadChunkStatus, 1500)
}

async function doEmbedSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  searched.value = true
  searchHits.value = []
  try {
    const res = await api.llm.embeddingsSearch(q)
    searchHits.value = res?.hits || []
  } catch {
    searchHits.value = []
  }
}

onMounted(() => {
  probeOllama()
  loadEmbedStatus()
  loadOllamaDraft()
})
// 离开页面停止进度轮询（组件卸载时定时器必须显式清理）
onUnmounted(() => {
  if (chunkPollTimer) { clearInterval(chunkPollTimer); chunkPollTimer = null }
})
</script>
