<template>
  <div>
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
  </div>
</template>

<script setup lang="ts">
// 蒸馏池面板：节点分组 / 启停与份额 / 模型增删改名 / 存活检测（SettingsAi 拆分）
import { computed, onMounted, ref } from 'vue'
import Icon from '../../Icon.vue'
import { useUiStore } from '../../../stores/useUiStore'
import { api } from '../../../api'
import { providerLabel } from '../shared'

const ui = useUiStore()

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

onMounted(loadNodes)
</script>
