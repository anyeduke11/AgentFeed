<template>
  <!-- 检索（批次④）：混合开关 / rerank 端点 / 查询别名表 / 健康自检 -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">检索</h2><span class="sect-en">Search</span><div class="sright"><span class="cap">三路混合 · MCP 与看板同内核</span></div></div>

    <div class="setrow">
      <span class="sr-k">混合检索</span>
      <span class="sr-v"><span class="cap">全文 FTS5 + 摘要 + 语义向量 三路 RRF 融合 · 关闭后回退旧单路标题匹配（逃生舱）</span></span>
      <span class="sr-a"><button class="switch" role="switch" :aria-checked="hybrid ? 'true' : 'false'" :disabled="busy" title="混合检索总闸" @click="toggleHybrid"></button></span>
    </div>

    <div class="setrow">
      <span class="sr-k">外部 Rerank 端点</span>
      <span class="sr-v" style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="inp" v-model="rerank" style="max-width:420px" placeholder="http://127.0.0.1:9997/v1/rerank（留空关闭）" @keyup.enter="saveRerank" />
        <button class="btn sm" :disabled="busy" @click="saveRerank">保存</button>
      </span>
      <span class="sr-a"></span>
    </div>

    <div class="setrow" style="align-items:flex-start">
      <span class="sr-k">查询别名</span>
      <span class="sr-v">
        <div v-for="(row, i) in aliasRows" :key="i" style="display:flex;gap:8px;margin-bottom:6px;max-width:560px">
          <input class="inp" v-model="row.k" style="max-width:160px" placeholder="别名（如 gh）" :aria-label="`第 ${i + 1} 条别名`" />
          <input class="inp" v-model="row.v" placeholder="展开（如 tag:github 或 title:readme -draft）" :aria-label="`第 ${i + 1} 条展开`" />
          <button class="btn ghost icon-btn" :aria-label="`删除别名 ${row.k || i + 1}`" title="删除" @click="aliasRows.splice(i, 1)"><Icon name="x" :size="13" /></button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn xs" @click="aliasRows.push({ k: '', v: '' })"><Icon name="plus" :size="12" /> 加一条</button>
          <button class="btn sm primary" :disabled="busy || !aliasDirty" @click="saveAliases">保存别名</button>
          <span v-if="aliasError" class="cap mark-fail">{{ aliasError }}</span>
          <span v-else class="cap">展开串支持 title: / tag: / “短语” / -排除 迷你语法</span>
        </div>
      </span>
      <span class="sr-a"></span>
    </div>

    <div class="setrow">
      <span class="sr-k">会话导出目录</span>
      <span class="sr-v" style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="inp" v-model="exportDir" style="max-width:420px" placeholder="留空 = 首个扫描根下 conversations/" @keyup.enter="saveExportDir" />
        <button class="btn sm" :disabled="busy" @click="saveExportDir">保存</button>
      </span>
      <span class="sr-a"></span>
    </div>

    <!-- 健康自检（doctor） -->
    <div class="sec-list" style="border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0 2px">
        <b style="font-size:13px">健康自检</b>
        <button class="btn xs" :disabled="doctorLoading" @click="runDoctor"><Icon name="refresh" :size="12" /> 立即体检</button>
      </div>
      <div v-if="doctorError" class="sec-line"><Icon name="alert" :size="15" style="color:var(--fail)" /><span>{{ doctorError }}</span></div>
      <template v-else>
        <div v-for="c in doctor" :key="c.key" class="sec-line">
          <Icon :name="c.ok ? 'check' : 'alert'" :size="15" :style="c.ok ? 'color:var(--ok)' : 'color:var(--fail)'" />
          <span>{{ c.detail }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// 检索设置 tab：三键可视化管理（search.hybridEnabled / rerankEndpoint / aliases）+ doctor 体检。
// 开关走乐观更新失败回滚（同发车区 MCP 总闸模式）；别名走行编辑器，保存前查空键/重键。
import { computed, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { api } from '../../api'
import { useUiStore } from '../../stores/useUiStore'

const props = defineProps<{ refreshSeq?: number }>()
const ui = useUiStore()

const busy = ref(false)
const hybrid = ref(true)
const rerank = ref('')
// 会话导出目录（chat.exportDir）：会话导出/蒸馏入库的落盘位置（须在已启用扫描根内，导出时后端 fail-closed 校验）
const exportDir = ref('')

// ---- 别名表：行编辑模型（{k,v}[]），进入时从 config JSON 反解，保存时正解回 JSON ----
const aliasRows = ref<{ k: string; v: string }[]>([])
const aliasSnapshot = ref('')
const aliasDirty = computed(() => JSON.stringify(aliasRows.value.map(r => [r.k, r.v])) !== aliasSnapshot.value)
const aliasError = ref('')

async function loadAll() {
  try {
    const cfg = await api.config.get()
    hybrid.value = String(cfg?.['search.hybridEnabled']?.value ?? 'true') !== 'false'
    rerank.value = String(cfg?.['search.rerankEndpoint']?.value ?? '')
    exportDir.value = String(cfg?.['chat.exportDir']?.value ?? '')
    aliasRows.value = parseAliasRows(cfg?.['search.aliases']?.value)
    aliasSnapshot.value = JSON.stringify(aliasRows.value.map(r => [r.k, r.v]))
    aliasError.value = ''
  } catch { /* 配置读取失败保持默认态 */ }
  runDoctor()
}

/** config JSON → 行数组（坏 JSON 静默为空表，doctor 会提示损坏） */
function parseAliasRows(raw: unknown): { k: string; v: string }[] {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (o && typeof o === 'object' && !Array.isArray(o)) return Object.entries(o).map(([k, v]) => ({ k, v: String(v) }))
  } catch { /* 交由 doctor 报损坏 */ }
  return []
}

async function toggleHybrid() {
  if (busy.value) return
  busy.value = true
  const next = !hybrid.value
  hybrid.value = next
  try {
    await api.config.set({ 'search.hybridEnabled': { value: next } })
    ui.toast(next ? '混合检索已开启' : '混合检索已关闭 · 回退旧单路检索')
  } catch {
    hybrid.value = !next
    ui.toast('保存失败，请重试')
  } finally {
    busy.value = false
  }
}

async function saveRerank() {
  if (busy.value) return
  busy.value = true
  try {
    await api.config.set({ 'search.rerankEndpoint': { value: rerank.value.trim() } })
    ui.toast(rerank.value.trim() ? 'Rerank 端点已保存 · 3s 超时自动降级 RRF' : 'Rerank 已关闭')
  } catch {
    ui.toast('保存失败，请重试')
  } finally {
    busy.value = false
  }
}

async function saveExportDir() {
  if (busy.value) return
  busy.value = true
  try {
    await api.config.set({ 'chat.exportDir': { value: exportDir.value.trim() } })
    ui.toast(exportDir.value.trim() ? '导出目录已保存（须在已启用扫描根内，导出时校验）' : '已恢复默认：首个扫描根下 conversations/')
  } catch {
    ui.toast('保存失败，请重试')
  } finally {
    busy.value = false
  }
}

async function saveAliases() {
  const obj: Record<string, string> = {}
  for (const r of aliasRows.value) {
    const k = r.k.trim()
    if (!k) { aliasError.value = '存在空别名键'; return }
    if (obj[k]) { aliasError.value = `别名「${k}」重复`; return }
    obj[k] = r.v.trim()
  }
  aliasError.value = ''
  if (busy.value) return
  busy.value = true
  try {
    await api.config.set({ 'search.aliases': { value: JSON.stringify(obj, null, 2) } })
    aliasRows.value = Object.entries(obj).map(([k, v]) => ({ k, v }))
    aliasSnapshot.value = JSON.stringify(aliasRows.value.map(r => [r.k, r.v]))
    ui.toast(`别名表已保存 · ${Object.keys(obj).length} 条`)
    runDoctor()
  } catch {
    ui.toast('保存失败，请重试')
  } finally {
    busy.value = false
  }
}

// ---- 健康自检 ----
const doctor = ref<{ key: string; ok: boolean; detail: string }[]>([])
const doctorLoading = ref(false)
const doctorError = ref('')

async function runDoctor() {
  doctorLoading.value = true
  doctorError.value = ''
  try {
    const r = await api.search.doctor()
    doctor.value = r.checks || []
  } catch {
    doctorError.value = '体检请求失败 · 确认服务运行中后重试'
  } finally {
    doctorLoading.value = false
  }
}

onMounted(loadAll)
watch(() => props.refreshSeq, loadAll)
</script>
