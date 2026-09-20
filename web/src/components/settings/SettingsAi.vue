<template>
  <!-- AI 设置与队列 -->
  <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">AI 设置与队列</h2><div class="sright"><span class="cap">OpenAI 兼容 · 本地优先</span></div></div>
        <div class="tabs" style="padding:10px 14px 0">
          <button class="tab" :class="{ on: aiTab === 'providers' }" @click="aiTab = 'providers'">服务商与队列</button>
          <button class="tab" :class="{ on: aiTab === 'ollama' }" @click="switchOllamaTab">Ollama 模型</button>
          <button class="tab" :class="{ on: aiTab === 'nodes' }" @click="switchNodesTab">蒸馏池</button>
        </div>
        <template v-if="aiTab === 'providers'">
        <div class="setrow">
          <span class="sr-k">默认服务商</span>
          <span class="sr-v"><span class="cap">蒸馏与打分请求发往该服务商</span></span>
          <span class="sr-a">
            <select class="inp" style="max-width:200px" :value="llm.providers.defaultProvider" aria-label="默认服务商" @change="changeProvider(($event.target as HTMLSelectElement).value)">
              <option v-for="p in llm.providers.providers || []" :key="p.name" :value="p.name">{{ providerLabel(p.name) }}</option>
            </select>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">默认模型</span>
          <span class="sr-v"><span class="mono">{{ llm.providers.defaultModel || '—' }}</span></span>
          <span class="sr-a">
            <select class="inp" style="max-width:220px" :value="llm.providers.defaultModel" aria-label="默认模型" @change="changeModel(($event.target as HTMLSelectElement).value)">
              <option v-for="m in defaultProviderModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </span>
        </div>
        <div class="setrow" v-for="p in cloudProviders" :key="p.name">
          <span class="sr-k">{{ providerLabel(p.name) }}</span>
          <span class="sr-v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="inp" style="max-width:300px" v-model="p.baseUrl" :aria-label="p.name + ' baseUrl'" />
            <input class="inp" style="max-width:170px" v-model="p.apiKey" :type="p.showKey ? 'text' : 'password'" autocomplete="off" :placeholder="p.hasKey ? '已配置 · 输入可修改' : 'API Key'" :aria-label="p.name + ' API Key'" />
            <button class="btn xs" :aria-label="(p.showKey ? '隐藏' : '查看') + ' ' + p.name + ' API Key'" :title="p.showKey ? '隐藏' : '查看'" @click="p.showKey = !p.showKey"><Icon :name="p.showKey ? 'eyeOff' : 'eye'" :size="12" /></button>
          </span>
          <span class="sr-a" style="display:flex;gap:8px;align-items:center">
            <input class="inp" style="max-width:220px" v-model="p.modelsText" :placeholder="p.name === 'xfyun' ? 'ModelID（服务管控页获取），逗号分隔' : '模型，逗号分隔'" :aria-label="p.name + ' 模型列表（逗号分隔）'" />
            <button v-if="p.name !== 'xfyun'" class="btn xs" :disabled="refreshingModels === p.name" :title="refreshingModels === p.name ? '拉取中…' : '拉取该服务商在线模型列表并合并'" :aria-label="'刷新 ' + p.name + ' 模型列表'" @click="refreshModels(p)"><Icon name="refresh" :size="12" /></button>
            <span v-if="p.hasKey || p.apiKey" class="vbadge ok">已配 Key</span>
            <span v-else class="vbadge off">未配置</span>
            <span class="stepper" :title="'该服务商并发限额（按接口限流宽松度调整）'">
              <button :disabled="providerConc(p.name) <= 1" :aria-label="'降低 ' + p.name + ' 并发'" @click="setProviderConc(p.name, providerConc(p.name) - 1)"><Icon name="minus" :size="12" /></button>
              <span class="val">{{ providerConc(p.name) }}</span>
              <button :disabled="providerConc(p.name) >= concMax" :aria-label="'提高 ' + p.name + ' 并发'" @click="setProviderConc(p.name, providerConc(p.name) + 1)"><Icon name="plus" :size="12" /></button>
            </span>
            <button class="btn xs" @click="saveProvider(p)">保存</button>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">自动标注</span>
          <span class="sr-v"><span class="cap">入库后自动补齐标签与领域（{{ autotag ? '已开启' : '已关闭' }}）</span></span>
          <span class="sr-a"><button class="switch" role="switch" :aria-checked="autotag ? 'true' : 'false'" aria-label="自动标注开关" @click="toggleAutotag"></button></span>
        </div>
        <div class="setrow">
          <span class="sr-k">队列并发</span>
          <span class="sr-v"><span class="cap">每服务商同时精炼的文件数（1 至 {{ concMax }}，默认按接口限流推荐 {{ concRec }}；各服务商可单独调整）</span></span>
          <span class="sr-a">
            <span class="stepper">
              <button :disabled="conc <= 1" aria-label="降低并发" @click="setConc(conc - 1)"><Icon name="minus" :size="13" /></button>
              <span class="val">{{ conc }}</span>
              <button :disabled="conc >= concMax" aria-label="提高并发" @click="setConc(conc + 1)"><Icon name="plus" :size="13" /></button>
            </span>
          </span>
        </div>
        <div class="setrow">
          <span class="sr-k">队列状态</span>
          <span class="sr-v">
            <span class="qchip" :class="{ paused: paused }"><span class="dot" :class="paused ? 'dot-pause' : 'dot-run'"></span>{{ paused ? '已暂停' : '运行中' }}</span>
          </span>
          <span class="sr-a"><button class="btn xs" @click="togglePause"><Icon :name="paused ? 'play' : 'pause'" :size="12" /> {{ paused ? '恢复' : '暂停' }}</button></span>
        </div>
        </template>
          <template v-else-if="aiTab === 'ollama'">
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
            <span class="sr-v"><span class="cap">已向量化 {{ embedStatus.embedded }} 篇{{ embedStatus.remaining ? ` · 待补 ${embedStatus.remaining} 篇` : ' · 无待补' }}<template v-if="(embedStatus.queueActive || 0) + (embedStatus.queuePending || 0) > 0"> · 向量队列处理中 {{ (embedStatus.queueActive || 0) + (embedStatus.queuePending || 0) }} 篇</template></span></span>
            <span class="sr-a"><button class="btn xs" :disabled="!embedReady" :title="embedReady ? '' : '先开启蒸馏向量化并选择向量模型'" @click="triggerEmbedBackfill"><Icon name="rotate" :size="12" /> 补向量（≤200 篇）</button></span>
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
            <div v-for="h in searchHits" :key="h.file_id" class="delrow">
              <span class="dn"><span>{{ h.title }}</span> <span class="stb">相似度 {{ h.score.toFixed(3) }}</span></span>
            </div>
          </template>
          <div v-else-if="searched" class="cap" style="display:block;padding:0 14px 8px">无检索结果（向量库为空或未向量化）。</div>
        </template>
          <template v-else-if="aiTab === 'nodes'">
            <!-- 蒸馏节点池：配置≠启用，启用后按 weight 份额分流到存活节点；全关时走默认模型 -->
            <div class="cap" style="display:block;padding:10px 14px 2px">配置好模型不等于启用：启用节点后，蒸馏任务按「并发份额」自动分流到存活节点（running/weight 最小者优先，失败自动轮换其他健康节点，最多 3 跳）；全部停用则回到默认模型单路蒸馏。</div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:10px 14px 6px;flex-wrap:wrap">
              <span class="cap">已启用 {{ enabledNodeCount }}/{{ nodes.length }} 个节点<template v-if="enabledNodeCount"> · 当前并行 {{ nodeRunningSum }} 个任务</template></span>
              <button class="btn xs" :disabled="checkingAll || !enabledNodeCount" @click="checkAllNodes"><Icon name="refresh" :size="12" /> {{ checkingAll ? '检测中…' : '检测存活' }}</button>
            </div>
            <template v-for="g in groupedNodes" :key="g.provider">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:14px 14px 4px;flex-wrap:wrap">
                <span class="cap" style="font-weight:600">{{ g.label }}（{{ g.nodes.length }} 个模型 · {{ g.nodes.filter((x: any) => x.enabled).length }} 启用）</span>
                <span style="display:flex;gap:8px;align-items:center">
                  <template v-if="addingProvider === g.provider">
                    <input class="inp" style="max-width:220px" v-model="addModelName" placeholder="输入模型名，如 gpt-4o-mini" :aria-label="'为 ' + g.label + ' 添加模型'" @keyup.enter="confirmAddModel(g.provider)" />
                    <button class="btn xs primary" :disabled="!addModelName.trim()" @click="confirmAddModel(g.provider)">添加</button>
                    <button class="btn xs" @click="cancelAddModel">取消</button>
                  </template>
                  <button v-else class="btn xs" @click="startAddModel(g.provider)"><Icon name="plus" :size="12" /> 添加模型</button>
                </span>
              </div>
            <div class="setrow" v-for="n in g.nodes" :key="n.provider + '|' + n.model">
              <span class="sr-k mono" style="font-size:12.5px">
                <template v-if="renamingKey === n.provider + '|' + n.model">
                  <input class="inp" style="max-width:200px" v-model="renameValue" :aria-label="'重命名模型 ' + n.model" @keyup.enter="confirmRename(n)" />
                </template>
                <template v-else>{{ providerLabel(n.provider) }} · {{ n.model }}</template>
              </span>
              <span class="sr-v" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span :class="'vbadge ' + nodeBadge(n).cls" :title="nodeBadge(n).title">{{ nodeBadge(n).text }}</span>
                <span v-if="n.enabled" class="cap">运行 {{ n.running || 0 }} · 份额 {{ n.weight }}</span>
              </span>
              <span class="sr-a" style="display:flex;gap:10px;align-items:center">
                <span v-if="n.enabled" class="stepper" title="并发份额：数值越大分到越多蒸馏任务（1-16）">
                  <button :disabled="n.weight <= 1" :aria-label="'降低 ' + n.model + ' 份额'" @click="setNodeWeight(n, n.weight - 1)"><Icon name="minus" :size="12" /></button>
                  <span class="val">{{ n.weight }}</span>
                  <button :disabled="n.weight >= 16" :aria-label="'提高 ' + n.model + ' 份额'" @click="setNodeWeight(n, n.weight + 1)"><Icon name="plus" :size="12" /></button>
                </span>
                <template v-if="renamingKey === n.provider + '|' + n.model">
                  <button class="btn xs primary" :disabled="!renameValue.trim()" @click="confirmRename(n)">保存</button>
                  <button class="btn xs" @click="renamingKey = ''">取消</button>
                </template>
                <template v-else>
                  <button class="btn xs" :disabled="checkingNode === n.provider + n.model" @click="checkNodeOne(n)"><Icon name="refresh" :size="12" /> 检测</button>
                  <button class="btn xs" title="重命名模型" @click="startRename(n)">改名</button>
                  <button class="btn xs" :class="{ danger: confirmDelKey === n.provider + '|' + n.model }" @click="removeNode(n)">{{ confirmDelKey === n.provider + '|' + n.model ? '确认删除' : '删除' }}</button>
                </template>
                <button class="switch" role="switch" :aria-checked="n.enabled ? 'true' : 'false'" :aria-label="'启用节点 ' + n.provider + ' ' + n.model" @click="toggleNode(n)"></button>
              </span>
            </div>
            </template>
          </template>
      </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useLlmStore } from '../../stores/useLlmStore'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'
import { providerLabel } from './shared'

const props = defineProps<{ refreshSeq?: number }>()

const settings = useSettingsStore()
const llm = useLlmStore()
const ui = useUiStore()

const autotag = ref(true)

/** 表单草稿：进入页面/保存后从 store 快照，避免编辑中误触发 */
const providersDraft = ref<any[]>([])
watch(() => llm.providers, (pv) => {
  providersDraft.value = (pv.providers || []).map((p: any) => ({ ...p, hasKey: !!p.apiKey, showKey: false, modelsText: (p.models || []).join(', ') }))
}, { immediate: true })

const defaultProviderModels = computed(() => {
  const dp = llm.providers.providers?.find((p: any) => p.name === llm.providers.defaultProvider)
  return dp?.models || []
})

/** 云端服务商列表（ollama 本地服务不在此展示，其管理在「Ollama 模型」tab） */
const cloudProviders = computed(() => providersDraft.value.filter(p => p.name !== 'ollama'))
/** ollama 的草稿条目：baseUrl 等仍在 draftPayload 内整体保存，避免其它服务商保存时丢失 */
const ollamaDraft = computed(() => providersDraft.value.find(p => p.name === 'ollama'))

function draftPayload() {
  return providersDraft.value.map(d => ({
    name: d.name,
    baseUrl: d.baseUrl,
    apiKey: d.apiKey || '',
    models: String(d.modelsText || '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean),
  }))
}

async function saveProvider(p: any) {
  if (!p.baseUrl) { ui.toast('baseUrl 不能为空'); return }
  await api.llm.saveProviders({
    providers: draftPayload(),
    defaultProvider: llm.providers.defaultProvider,
    defaultModel: llm.providers.defaultModel,
  })
  await llm.fetchProviders()
  ui.toast(`${providerLabel(p.name)} 配置已保存`)
}

/** 拉取该服务商在线模型列表（用表单中的 baseUrl/apiKey），与已填模型合并去重后自动保存 */
const refreshingModels = ref('')
async function refreshModels(p: any) {
  refreshingModels.value = p.name
  try {
    const res = await api.llm.providerModels(p.name, { baseUrl: p.baseUrl, apiKey: p.apiKey })
    if (!res?.online) { ui.toast('拉取失败：' + (res?.message || '服务商无响应')); return }
    const existing = String(p.modelsText || '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean)
    const added = (res.models || []).filter((m: string) => !existing.includes(m))
    p.modelsText = [...existing, ...added].join(', ')
    if (added.length) await api.llm.saveProviders({
      providers: draftPayload(),
      defaultProvider: llm.providers.defaultProvider,
      defaultModel: llm.providers.defaultModel,
    })
    await llm.fetchProviders()
    ui.toast(added.length ? `已拉取 ${res.models.length} 个模型，新增 ${added.length} 个` : `在线模型已全部在列表中（${existing.length} 个）`)
  } catch (e: any) {
    ui.toast('拉取失败：' + (e?.message || e))
  } finally {
    refreshingModels.value = ''
  }
}

async function changeProvider(name: string) {
  if (!name) return
  const target = llm.providers.providers?.find((p: any) => p.name === name)
  // 当前默认模型不属于新服务商时，联动切到该服务商第一个模型，避免错配
  const keepModel = (target?.models || []).includes(llm.providers.defaultModel)
  await api.llm.saveProviders({
    providers: draftPayload(),
    defaultProvider: name,
    defaultModel: keepModel ? llm.providers.defaultModel : (target?.models?.[0] || ''),
  })
  await llm.fetchProviders()
  ui.toast(`默认服务商已切换为 ${providerLabel(name)}`)
}

/* ---------- Ollama 模型 tab ---------- */
const aiTab = ref<'providers' | 'ollama' | 'nodes'>('providers')
const ollamaProbing = ref(false)
const ollamaOnline = ref(false)
const ollamaModels = ref<Array<{ id: string; type: 'chat' | 'embedding'; enabled: boolean }>>([])
const embeddingEnabled = ref(false)
const embeddingModel = ref('')
const embedStatus = ref({ embedded: 0, remaining: 0, enabled: false, model: '', queuePending: 0, queueActive: 0 })
const searchQuery = ref('')
const searchHits = ref<Array<{ file_id: number; title: string; path: string; score: number }>>([])
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

function switchOllamaTab() {
  aiTab.value = 'ollama'
  probeOllama()
  loadEmbedStatus()
}

function switchNodesTab() {
  aiTab.value = 'nodes'
  loadNodes()
}

async function saveOllamaBaseUrl() {
  const p = ollamaDraft.value
  if (!p) return
  if (!p.baseUrl) { ui.toast('baseUrl 不能为空'); return }
  await saveProvider(p)
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
  ui.toast('Ollama 配置已保存')
}

async function triggerEmbedBackfill() {
  const res = await api.llm.embeddingsBackfill()
  if (res?.success === false) { ui.toast(res.message || '无法启动补向量'); return }
  ui.toast(`已入队 ${res.enqueued ?? 0} 篇待向量化`)
  loadEmbedStatus()
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

const conc = computed(() => llm.queue.concurrency ?? 2)
const concMax = computed(() => llm.queue.capacity ?? 4)
const concRec = computed(() => llm.queue.recommendedConcurrency ?? 2)
const paused = computed(() => !!llm.queue.paused)

/** 某服务商的并发限额（未单独设置时显示全局值） */
function providerConc(name: string): number {
  const map = (llm.queue as any).providerConcurrency || {}
  return map[name] ?? conc.value
}

async function setProviderConc(name: string, n: number) {
  if (n < 1 || n > concMax.value) return
  await llm.setConcurrency(n, name)
  ui.toast(`${name} 并发已调整为 ${n}`)
}

/* ---------- 蒸馏节点池 ---------- */
const nodes = ref<any[]>([])
const checkingAll = ref(false)
const checkingNode = ref('')

const enabledNodeCount = computed(() => nodes.value.filter(n => n.enabled).length)
/** 启用节点当前并行任务总数 */
const nodeRunningSum = computed(() => nodes.value.filter(n => n.enabled).reduce((s, n) => s + (n.running || 0), 0))
/** 按服务商分组（组内启用优先、模型名字典序），供蒸馏池 tab 管理 */
const groupedNodes = computed(() =>
  [...new Set(nodes.value.map(n => n.provider))]
    .sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)))
    .map(provider => ({
      provider,
      label: providerLabel(provider),
      nodes: nodes.value
        .filter(n => n.provider === provider)
        .sort((a, b) => (a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : a.model.localeCompare(b.model))),
    })),
)

/* ---------- 蒸馏池模型管理（增 / 删 / 改名，提交整表到 /providers/models） ---------- */
const addingProvider = ref('')
const addModelName = ref('')
const renamingKey = ref('')
const renameValue = ref('')
const confirmDelKey = ref('')
let confirmDelTimer: ReturnType<typeof setTimeout> | null = null

function providerModels(provider: string) {
  return nodes.value.filter(n => n.provider === provider).map(n => n.model)
}

function startAddModel(p: string) {
  addingProvider.value = p
  addModelName.value = ''
}

function cancelAddModel() {
  addingProvider.value = ''
  addModelName.value = ''
}

async function confirmAddModel(p: string) {
  const name = addModelName.value.trim()
  if (!name) return
  if (providerModels(p).includes(name)) { ui.toast('该模型已存在'); return }
  try {
    await api.llm.saveProviderModels(p, [...providerModels(p), name])
    ui.toast(`已添加 ${name}（默认未启用，请打开开关参与分流）`)
    cancelAddModel()
  } catch (e: any) {
    ui.toast('添加失败：' + (e?.message || e))
  }
  await loadNodes()
}

function startRename(n: any) {
  renamingKey.value = n.provider + '|' + n.model
  renameValue.value = n.model
}

async function confirmRename(n: any) {
  const name = renameValue.value.trim()
  if (!name || name === n.model) { renamingKey.value = ''; return }
  if (providerModels(n.provider).includes(name)) { ui.toast('该模型名已存在'); return }
  try {
    await api.llm.saveProviderModels(n.provider, providerModels(n.provider).map(m => (m === n.model ? name : m)))
    ui.toast(`已改名 ${n.model} → ${name}${n.enabled ? '（改名后需重新开启启用）' : ''}`)
    renamingKey.value = ''
  } catch (e: any) {
    ui.toast('改名失败：' + (e?.message || e))
  }
  await loadNodes()
}

async function removeNode(n: any) {
  const key = n.provider + '|' + n.model
  // 二次确认：首击进入确认态（3 秒后自动复原），再击执行删除
  if (confirmDelKey.value !== key) {
    confirmDelKey.value = key
    if (confirmDelTimer) clearTimeout(confirmDelTimer)
    confirmDelTimer = setTimeout(() => { confirmDelKey.value = '' }, 3000)
    return
  }
  confirmDelKey.value = ''
  if (confirmDelTimer) clearTimeout(confirmDelTimer)
  try {
    await api.llm.saveProviderModels(n.provider, providerModels(n.provider).filter(m => m !== n.model))
    ui.toast(`已删除 ${n.model}`)
  } catch (e: any) {
    ui.toast('删除失败：' + (e?.message || e))
  }
  await loadNodes()
}

async function loadNodes() {
  try {
    nodes.value = (await api.llm.llmNodes()).nodes || []
  } catch {
    /* 拉取失败保持现状 */
  }
}

function nodeBadge(n: any) {
  if (!n.enabled) return { cls: 'off', text: '未启用', title: '' }
  if (!n.health) return { cls: 'off', text: '未检测', title: '' }
  if (n.health.healthy) return { cls: 'ok', text: '健康', title: '' }
  const cooling = n.health.cooldownUntil && n.health.cooldownUntil > Date.now()
  return { cls: 'bad', text: cooling ? '冷却中' : '异常', title: n.health.error || '' }
}

async function toggleNode(n: any) {
  await api.llm.llmNodeUpdate(n.provider, n.model, { enabled: !n.enabled })
  ui.toast(`${providerLabel(n.provider)} · ${n.model} 已${n.enabled ? '停用' : '启用，将参与蒸馏分流'}`)
  await loadNodes()
}

async function setNodeWeight(n: any, w: number) {
  if (w < 1 || w > 16) return
  await api.llm.llmNodeUpdate(n.provider, n.model, { weight: w })
  await loadNodes()
}

async function checkNodeOne(n: any) {
  checkingNode.value = n.provider + n.model
  try {
    const res = await api.llm.llmNodeCheck(n.provider, n.model)
    const r = (res.results || [])[0]
    ui.toast(r ? (r.healthy ? `${n.model} 存活` : `${n.model} 不可用${r.error ? '：' + r.error : ''}`) : '无检测结果')
  } catch (e: any) {
    ui.toast('检测失败：' + (e?.message || e))
  } finally {
    checkingNode.value = ''
  }
  await loadNodes()
}

async function checkAllNodes() {
  checkingAll.value = true
  try {
    const res = await api.llm.llmNodeCheck()
    const results = res.results || []
    const ok = results.filter((r: any) => r.healthy).length
    ui.toast(`检测完成：${ok}/${results.length} 个启用节点存活`)
  } catch (e: any) {
    ui.toast('检测失败：' + (e?.message || e))
  } finally {
    checkingAll.value = false
  }
  await loadNodes()
}

async function changeModel(m: string) {
  if (!m) return
  await settings.updateConfig({ 'ai.defaultModel': { value: m } })
  await llm.fetchProviders()
  ui.toast(`默认模型已切换为 ${m}`)
}

async function toggleAutotag() {
  autotag.value = !autotag.value
  await settings.updateConfig({ 'ai.autoTag': { value: autotag.value } })
  ui.toast(autotag.value ? '自动标注已开启' : '自动标注已关闭')
}

async function setConc(n: number) {
  if (n < 1 || n > concMax.value) return
  await llm.setConcurrency(n)
  ui.toast(`队列并发已调整为 ${n}`)
}

async function togglePause() {
  if (paused.value) await llm.resume()
  else await llm.pause()
  ui.queuePaused = !paused.value
  ui.toast(paused.value ? '队列已恢复 · 精炼继续' : '队列已暂停 · 进行中的精炼已挂起')
}

/** 拉取本 tab 数据：全局配置 + 队列 + 服务商 + 节点池，最后读自动标注开关（对应原 refresh() 的 AI 部分） */
async function load() {
  await Promise.all([settings.fetchConfig(), llm.fetchQueue(), llm.fetchProviders(), loadNodes()])
  autotag.value = settings.config['ai.autoTag']?.value ?? true
}

// 进入 tab 首次挂载拉取数据（KeepAlive 缓存后切回不重复拉取，与拆分前一致）
onMounted(load)
// 父层「刷新」按钮：重新拉取本 tab 数据
watch(() => props.refreshSeq, load)
</script>
