<template>
  <!-- 过滤门禁 -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">过滤门禁</h2><span class="sect-en">Gate Rules</span><div class="sright"><span class="cap">入库前过滤 · 拦截可恢复</span></div></div>
    <p class="cap" style="margin:8px 0 2px">提示：被扫描的内容可能经蒸馏 / 嵌入等环节送往你配置的 LLM 服务商（详见 README「数据与隐私边界」）；不希望外发的目录请在下方「排除目录」中配置。</p>
    <div class="setrow">
      <span class="sr-k">门禁开关</span>
      <span class="sr-v"><span class="cap">关闭后大小与内容门禁不再拦截（各规则可单独开关）</span><span v-if="masterBadge" :class="'vbadge ' + masterBadge.cls" :title="masterBadge.title">{{ masterBadge.text }}</span></span>
      <span class="sr-a"><button class="switch" role="switch" :aria-checked="gate.enabled ? 'true' : 'false'" aria-label="过滤门禁开关" @click="toggleGate"></button></span>
    </div>
    <div class="setrow">
      <span class="sr-k">最小文件大小</span>
      <span class="sr-v"><span class="cap">低于该字节数的文件不纳入（占位符、单行说明）</span><span v-if="vmap.minSize" :class="'vbadge ' + vmap.minSize.cls" :title="vmap.minSize.title" :style="vmap.minSize.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('minSize')">{{ vmap.minSize.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:120px" :style="gate.minSizeEnabled ? '' : 'opacity:.35'" :disabled="!gate.minSizeEnabled" v-model.number="gate.minSize" type="number" min="0" aria-label="最小文件大小" />
        <button class="switch" role="switch" :aria-checked="gate.minSizeEnabled ? 'true' : 'false'" aria-label="最小文件大小门禁开关" @click="toggleRule('minSizeEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">最小正文字符</span>
      <span class="sr-v"><span class="cap">去 frontmatter / 代码围栏 / md 符号后的有效字符数</span><span v-if="vmap.minChars" :class="'vbadge ' + vmap.minChars.cls" :title="vmap.minChars.title" :style="vmap.minChars.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('minChars')">{{ vmap.minChars.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:120px" :style="gate.minCharsEnabled ? '' : 'opacity:.35'" :disabled="!gate.minCharsEnabled" v-model.number="gate.minChars" type="number" min="0" aria-label="最小正文字符" />
        <button class="switch" role="switch" :aria-checked="gate.minCharsEnabled ? 'true' : 'false'" aria-label="最小正文字符门禁开关" @click="toggleRule('minCharsEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">代码占比上限</span>
      <span class="sr-v"><span class="cap">代码围栏行占比超过该值视为代码清单（0-1）</span><span v-if="vmap.codeRatio" :class="'vbadge ' + vmap.codeRatio.cls" :title="vmap.codeRatio.title" :style="vmap.codeRatio.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('codeRatio')">{{ vmap.codeRatio.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:120px" :style="gate.codeRatioEnabled ? '' : 'opacity:.35'" :disabled="!gate.codeRatioEnabled" v-model.number="gate.codeRatio" type="number" min="0" max="1" step="0.1" aria-label="代码占比上限" />
        <button class="switch" role="switch" :aria-checked="gate.codeRatioEnabled ? 'true' : 'false'" aria-label="代码占比门禁开关" @click="toggleRule('codeRatioEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">排除目录</span>
      <span class="sr-v"><span class="cap">逗号分隔；命中即彻底忽略，不入库不记录</span><span v-if="vmap.excludeDirs" :class="'vbadge ' + vmap.excludeDirs.cls" :title="vmap.excludeDirs.title" :style="vmap.excludeDirs.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('excludeDirs')">{{ vmap.excludeDirs.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:340px" :style="gate.excludeDirsEnabled ? '' : 'opacity:.35'" :disabled="!gate.excludeDirsEnabled" v-model="gate.excludeDirsText" aria-label="排除目录" />
        <button class="switch" role="switch" :aria-checked="gate.excludeDirsEnabled ? 'true' : 'false'" aria-label="排除目录门禁开关" @click="toggleRule('excludeDirsEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">文件名白名单</span>
      <span class="sr-v"><span class="cap">精确文件名命中即放行（AGENTS.md、CLAUDE.md 等）</span><span v-if="vmap.filenameWhitelist" :class="'vbadge ' + vmap.filenameWhitelist.cls" :title="vmap.filenameWhitelist.title" :style="vmap.filenameWhitelist.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('filenameWhitelist')">{{ vmap.filenameWhitelist.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:340px" :style="gate.filenameWhitelistEnabled ? '' : 'opacity:.35'" :disabled="!gate.filenameWhitelistEnabled" v-model="gate.whitelistText" aria-label="文件名白名单" />
        <button class="switch" role="switch" :aria-checked="gate.filenameWhitelistEnabled ? 'true' : 'false'" aria-label="文件名白名单开关" @click="toggleRule('filenameWhitelistEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">关键词白名单</span>
      <span class="sr-v"><span class="cap">文件名包含任一关键词即放行（PRD、测试记录等）</span><span v-if="vmap.keywords" :class="'vbadge ' + vmap.keywords.cls" :title="vmap.keywords.title" :style="vmap.keywords.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('keywords')">{{ vmap.keywords.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:340px" :style="gate.keywordsEnabled ? '' : 'opacity:.35'" :disabled="!gate.keywordsEnabled" v-model="gate.keywordsText" aria-label="关键词白名单" />
        <button class="switch" role="switch" :aria-checked="gate.keywordsEnabled ? 'true' : 'false'" aria-label="关键词白名单开关" @click="toggleRule('keywordsEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">文件黑名单</span>
      <span class="sr-v"><span class="cap">逗号分隔；*.tmp.md 通配、.log 扩展名、/正则/、纯文本（文件名包含）命中即拦截（优先级高于白名单放行，低于路径白名单）</span><span v-if="vmap.blacklist" :class="'vbadge ' + vmap.blacklist.cls" :title="vmap.blacklist.title" :style="vmap.blacklist.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('blacklist')">{{ vmap.blacklist.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:340px" :style="gate.blacklistEnabled ? '' : 'opacity:.35'" :disabled="!gate.blacklistEnabled" v-model="gate.blacklistText" aria-label="文件黑名单" />
        <button class="switch" role="switch" :aria-checked="gate.blacklistEnabled ? 'true' : 'false'" aria-label="文件黑名单开关" @click="toggleRule('blacklistEnabled')"></button>
      </span>
    </div>
    <div class="setrow">
      <span class="sr-k">路径白名单</span>
      <span class="sr-v"><span class="cap">绝对路径前缀匹配；命中无视大小与内容门禁强制入库蒸馏（优先级高于排除目录）</span><span v-if="vmap.pathWhitelist" :class="'vbadge ' + vmap.pathWhitelist.cls" :title="vmap.pathWhitelist.title" :style="vmap.pathWhitelist.clickable ? 'cursor:pointer' : ''" @click="toggleFieldDetail('pathWhitelist')">{{ vmap.pathWhitelist.text }}</span></span>
      <span class="sr-a" style="display:flex;gap:10px;align-items:center;flex-wrap:nowrap">
        <input class="inp" style="max-width:340px" :style="gate.pathWhitelistEnabled ? '' : 'opacity:.35'" :disabled="!gate.pathWhitelistEnabled" v-model="gate.pathWhitelistText" aria-label="路径白名单" />
        <button class="switch" role="switch" :aria-checked="gate.pathWhitelistEnabled ? 'true' : 'false'" aria-label="路径白名单开关" @click="toggleRule('pathWhitelistEnabled')"></button>
      </span>
    </div>
    <div v-if="openField && vdetail[openField]" class="vdetail">
      <div class="vd-head"><b>{{ vdetail[openField].label }}</b>：{{ vdetail[openField].items.length }} 条问题，无效条目不会生效<button class="btn xs" @click="openField = ''">收起</button></div>
      <div v-for="(it, ix) in vdetail[openField].items" :key="ix" class="vd-item">
        <code class="vd-entry">{{ it.entry || '（空条目）' }}</code>
        <span class="vd-reason">{{ it.reason }}</span>
        <span v-if="it.fix" class="vd-fix">建议：{{ it.fix }}</span>
      </div>
    </div>
    <div class="addroot">
      <button class="btn sm primary" @click="saveGate()"><Icon name="check" :size="14" /> 保存门禁配置</button>
      <span class="supply-note">保存后对新扫描生效；对已入库文件执行「全量重扫」可按新规则清洗。</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'

const props = defineProps<{ refreshSeq?: number }>()

const settings = useSettingsStore()
const ui = useUiStore()

const gate = ref({
  enabled: true,
  minSize: 512,
  minChars: 300,
  codeRatio: 0.6,
  minSizeEnabled: true,
  minCharsEnabled: true,
  codeRatioEnabled: true,
  excludeDirsEnabled: true,
  filenameWhitelistEnabled: true,
  keywordsEnabled: true,
  excludeDirsText: '',
  whitelistText: '',
  keywordsText: '',
  blacklistText: '',
  blacklistEnabled: true,
  pathWhitelistText: '',
  pathWhitelistEnabled: true
})

/** 门禁配置有效性（后端按真实匹配语义逐字段校验，抓静默失败） */
const gateValidity = ref<{ masterEnabled: boolean; fields: any[] } | null>(null)
const openField = ref('')

async function loadGateValidity() {
  try {
    gateValidity.value = await api.gate.validate()
  } catch {
    gateValidity.value = null
  }
}

/** 拉取本 tab 数据：全局配置快照到门禁草稿 + 有效性校验（对应原 loadGate 中门禁草稿部分） */
async function loadGate() {
  await settings.fetchConfig()
  const c = settings.config
  gate.value.enabled = c['gate.enabled']?.value ?? true
  gate.value.minSize = c['gate.minSize']?.value ?? 512
  gate.value.minChars = c['gate.minChars']?.value ?? 300
  gate.value.codeRatio = c['gate.codeRatio']?.value ?? 0.6
  gate.value.minSizeEnabled = c['gate.minSizeEnabled']?.value ?? true
  gate.value.minCharsEnabled = c['gate.minCharsEnabled']?.value ?? true
  gate.value.codeRatioEnabled = c['gate.codeRatioEnabled']?.value ?? true
  gate.value.excludeDirsEnabled = c['gate.excludeDirsEnabled']?.value ?? true
  gate.value.filenameWhitelistEnabled = c['gate.filenameWhitelistEnabled']?.value ?? true
  gate.value.keywordsEnabled = c['gate.keywordsEnabled']?.value ?? true
  gate.value.excludeDirsText = (c['gate.excludeDirs']?.value || []).join(', ')
  gate.value.whitelistText = (c['gate.filenameWhitelist']?.value || []).join(', ')
  gate.value.keywordsText = (c['gate.keywords']?.value || []).join(', ')
  gate.value.blacklistText = (c['gate.blacklist']?.value || []).join(', ')
  gate.value.blacklistEnabled = c['gate.blacklistEnabled']?.value ?? true
  gate.value.pathWhitelistText = (c['gate.pathWhitelist']?.value || []).join(', ')
  gate.value.pathWhitelistEnabled = c['gate.pathWhitelistEnabled']?.value ?? true
  await loadGateValidity()
}

/** field → 行内徽标 {cls, text, title}；无效 > 关闭 > 存疑 > 未配置 > 生效 */
const vmap = computed<Record<string, { cls: string; text: string; title: string; clickable: boolean }>>(() => {
  const m: Record<string, { cls: string; text: string; title: string; clickable: boolean }> = {}
  for (const f of gateValidity.value?.fields || []) {
    const detail = [...(f.issues || []), ...(f.warnings || [])].map((i: any) => `${i.entry}：${i.reason}`).join('\n')
    const clickable = !!((f.issues || []).length || (f.warnings || []).length)
    if (!f.enabled) m[f.field] = { cls: 'off', text: '已关闭', title: detail, clickable }
    else if ((f.issues || []).length) m[f.field] = { cls: 'bad', text: `${f.issues.length} 条无效`, title: detail, clickable }
    else if ((f.warnings || []).length) m[f.field] = { cls: 'bad', text: '存疑', title: detail, clickable }
    else if (!f.total) m[f.field] = { cls: 'off', text: '未配置', title: '', clickable: false }
    else m[f.field] = { cls: 'ok', text: f.total > 1 ? `生效 · ${f.total} 条` : '生效', title: '', clickable: false }
  }
  return m
})

/** 点击徽标展开的问题明细（条目 + 原因 + 修改建议，后端按真实匹配语义给出） */
const vdetail = computed<Record<string, { label: string; items: any[] }>>(() => {
  const m: Record<string, { label: string; items: any[] }> = {}
  for (const f of gateValidity.value?.fields || []) {
    const items = [...(f.issues || []), ...(f.warnings || [])]
    if (items.length) m[f.field] = { label: f.label, items }
  }
  return m
})

function toggleFieldDetail(k: string) {
  if (!vdetail.value[k]) return
  openField.value = openField.value === k ? '' : k
}

const masterBadge = computed(() => {
  if (!gateValidity.value) return null
  return gateValidity.value.masterEnabled
    ? { cls: 'ok', text: '已开启', title: '' }
    : { cls: 'off', text: '已关闭 · 以下规则均不拦截', title: '' }
})

async function toggleGate() {
  gate.value.enabled = !gate.value.enabled
  await saveGate(true)
}

/** 单规则开关：切换后立即静默保存 */
async function toggleRule(f: 'minSizeEnabled' | 'minCharsEnabled' | 'codeRatioEnabled' | 'excludeDirsEnabled' | 'filenameWhitelistEnabled' | 'keywordsEnabled' | 'blacklistEnabled' | 'pathWhitelistEnabled') {
  gate.value[f] = !gate.value[f]
  await saveGate(true)
}

async function saveGate(silent = false) {
  await settings.updateConfig({
    'gate.enabled': { value: gate.value.enabled },
    'gate.minSize': { value: Number(gate.value.minSize) || 0 },
    'gate.minChars': { value: Number(gate.value.minChars) || 0 },
    'gate.codeRatio': { value: Number(gate.value.codeRatio) || 0 },
    'gate.minSizeEnabled': { value: gate.value.minSizeEnabled },
    'gate.minCharsEnabled': { value: gate.value.minCharsEnabled },
    'gate.codeRatioEnabled': { value: gate.value.codeRatioEnabled },
    'gate.excludeDirsEnabled': { value: gate.value.excludeDirsEnabled },
    'gate.filenameWhitelistEnabled': { value: gate.value.filenameWhitelistEnabled },
    'gate.keywordsEnabled': { value: gate.value.keywordsEnabled },
    'gate.excludeDirs': { value: gate.value.excludeDirsText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.filenameWhitelist': { value: gate.value.whitelistText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.keywords': { value: gate.value.keywordsText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.blacklist': { value: gate.value.blacklistText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.blacklistEnabled': { value: gate.value.blacklistEnabled },
    'gate.pathWhitelist': { value: gate.value.pathWhitelistText.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean) },
    'gate.pathWhitelistEnabled': { value: gate.value.pathWhitelistEnabled }
  })
  await loadGateValidity()
  if (!silent) {
    const bad = (gateValidity.value?.fields || []).filter((f: any) => f.enabled && (f.issues || []).length > 0)
    const n = bad.reduce((s: number, f: any) => s + f.issues.length, 0)
    ui.toast(n > 0 ? `门禁配置已保存；注意：${n} 条无效配置不会生效（已标出，点击徽标查看修复建议）` : '门禁配置已保存，新扫描生效')
  }
}

// 进入 tab 首次挂载拉取数据（KeepAlive 缓存后切回不重复拉取，与拆分前一致）
onMounted(loadGate)
// 父层「刷新」按钮：重新拉取本 tab 数据
watch(() => props.refreshSeq, loadGate)
</script>
