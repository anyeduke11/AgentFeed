<template>
  <div>
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
    <!-- I3 RSI 成长闭环：理解度检查（opt-in 默认关）+ 学习建议推送开关 + 上次建议日期 -->
    <div class="setrow">
      <span class="sr-k">理解度检查</span>
      <span class="sr-v"><span class="cap">阅读器「考考我」按词条要点出 3 道自测题，答对拉长复习间隔（{{ rsiStatus.quizEnabled ? '已开启' : '已关闭' }}）· 默认关闭，需手动开启</span></span>
      <span class="sr-a"><button class="switch" role="switch" :aria-checked="rsiStatus.quizEnabled ? 'true' : 'false'" aria-label="理解度检查开关" @click="toggleRsi('quiz')"></button></span>
    </div>
    <div class="setrow">
      <span class="sr-k">学习建议推送</span>
      <span class="sr-v"><span class="cap">总览页「今日学习建议」，到期复习 &gt; 高频在读 &gt; 目标缺口（{{ rsiStatus.suggestionsEnabled ? '已开启' : '已关闭' }}）<template v-if="rsiStatus.lastSuggestionDay"> · 上次推送 {{ rsiStatus.lastSuggestionDay }}</template> · 无论开关状态，每日至多推送一次</span></span>
      <span class="sr-a"><button class="switch" role="switch" :aria-checked="rsiStatus.suggestionsEnabled ? 'true' : 'false'" aria-label="学习建议推送开关" @click="toggleRsi('suggestions')"></button></span>
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
  </div>
</template>

<script setup lang="ts">
// 服务商与队列面板：默认服务商/模型、云端服务商凭据、自动标注、RSI 开关、队列并发（SettingsAi 拆分）
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../../Icon.vue'
import { useSettingsStore } from '../../../stores/useSettingsStore'
import { useLlmStore } from '../../../stores/useLlmStore'
import { useUiStore } from '../../../stores/useUiStore'
import { api } from '../../../api'
import { providerLabel } from '../shared'

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

/* ---------- I3 RSI 成长闭环（理解度检查 + 学习建议推送） ---------- */
const rsiStatus = ref({ quizEnabled: false, suggestionsEnabled: true, lastSuggestionDay: null as string | null })

async function loadRsiStatus() {
  try {
    const s = await api.rsi.status()
    if (s?.success) rsiStatus.value = s
  } catch { /* 拉取失败保持现状 */ }
}

async function toggleRsi(key: 'quiz' | 'suggestions') {
  const next = !(rsiStatus.value as any)[key === 'quiz' ? 'quizEnabled' : 'suggestionsEnabled']
  const r: any = await api.rsi.toggle(key, next)
  if (!r?.success) { ui.toast(r?.message || '开关设置失败'); return }
  await loadRsiStatus()
  ui.toast(key === 'quiz'
    ? (next ? '理解度检查已开启 · 阅读器可「考考我」' : '理解度检查已关闭')
    : (next ? '学习建议推送已开启（每日至多一次）' : '学习建议推送已关闭'))
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

async function load() {
  await Promise.all([settings.fetchConfig(), llm.fetchQueue(), llm.fetchProviders(), loadRsiStatus()])
  autotag.value = settings.config['ai.autoTag']?.value ?? true
}

onMounted(load)
watch(() => props.refreshSeq, load)

defineExpose({ refresh: load })
</script>
