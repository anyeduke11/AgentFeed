<template>
  <!-- 过滤记录 -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">过滤记录</h2><div class="sright" style="display:flex;gap:8px;align-items:center">
      <span class="cap">误杀文件可手动恢复{{ gateView === 'skipped' && gateTotal > gateRecords.length ? ' · 仅显示最近 ' + gateRecords.length + ' 条' : '' }}</span>
      <button class="btn xs" :disabled="!gateTotal" @click="archiveAll"><Icon name="folder" :size="12" /> 全部存档</button>
    </div></div>
    <div class="tabs" style="padding:10px 14px 0">
      <button class="tab" :class="{ on: gateView === 'skipped' }" @click="gateView = 'skipped'">拦截中（{{ gateTotal }}）</button>
      <button class="tab" :class="{ on: gateView === 'restored' }" @click="gateView = 'restored'">已豁免（{{ exemptTotal }}）</button>
    </div>
    <template v-if="gateView === 'skipped'">
      <template v-if="gateRecords.length">
        <div v-for="r in gateRecords" :key="r.id" class="delrow">
          <span class="dn"><span class="mono">{{ r.path }}</span> <span class="stb">{{ r.gate_reason }}</span></span>
          <button class="btn xs" @click="restoreGate(r)"><Icon name="rotate" :size="12" /> 恢复</button>
          <button class="btn xs danger" @click="removeGateRecord(r)"><Icon name="trash" :size="12" /> 删除记录</button>
        </div>
      </template>
      <template v-else>
        <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
          <span class="e-ic"><Icon name="shield" :size="26" /></span>
          <div class="e-t">暂无过滤记录</div>
          <div class="e-s">被门禁拦截的文件会出现在这里，误杀可手动恢复入库。</div>
        </div></div>
      </template>
    </template>
    <template v-else>
      <template v-if="exemptRecords.length">
        <div v-for="r in exemptRecords" :key="r.id" class="delrow">
          <span class="dn"><span class="mono">{{ r.path }}</span> <span class="stb">当初拦截原因：{{ r.gate_reason || '未知' }}</span></span>
          <button class="btn xs danger" @click="unexemptRecord(r)"><Icon name="x" :size="12" /> 取消豁免</button>
        </div>
        <div class="cap" style="display:block;padding:8px 14px">取消豁免后，下次「全量重扫」将按当前门禁规则重新评估该文件。</div>
      </template>
      <template v-else>
        <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
          <span class="e-ic"><Icon name="shield" :size="26" /></span>
          <div class="e-t">暂无豁免记录</div>
          <div class="e-s">手动恢复过的文件会出现在这里，可取消豁免让其重新接受门禁评估。</div>
        </div></div>
      </template>
    </template>
    <template v-if="archives.length">
      <div class="cap" style="display:block;margin:14px 0 6px;padding:0 14px">历史存档（按月 CSV · 归档后从上方列表移除）</div>
      <div style="display:flex;gap:8px;padding:0 14px;margin-bottom:8px;flex-wrap:wrap">
        <input class="inp" style="max-width:280px" v-model="archiveQuery" placeholder="搜索已归档记录（路径 / 原因）" aria-label="搜索存档" @keyup.enter="doSearchArchives" />
        <select class="inp" style="max-width:130px" v-model="archiveMonth" aria-label="存档月份">
          <option value="">全部月份</option>
          <option v-for="a in archives" :key="a.file" :value="a.month">{{ a.month }}</option>
        </select>
        <button class="btn xs" @click="doSearchArchives"><Icon name="search" :size="12" /> 搜索</button>
      </div>
      <template v-if="archiveResults.length">
        <div v-for="(r, i) in archiveResults" :key="i" class="delrow">
          <span class="dn"><span class="mono">{{ r.path }}</span> <span class="stb">{{ r.gate_reason }} · {{ r.month }}</span></span>
          <button class="btn xs" @click="openCsv(`/api/gate/archives/${r.month}.csv`)"><Icon name="external" :size="12" /> CSV</button>
        </div>
        <div class="cap" style="display:block;padding:6px 14px">最多显示 100 条结果。</div>
      </template>
      <div v-else-if="archiveSearched" class="cap" style="display:block;padding:0 14px 6px">无匹配的归档记录。</div>
      <div v-for="a in archives" :key="a.file" class="delrow">
        <span class="dn"><span class="mono">{{ a.month }}</span> <span class="stb">{{ a.count }} 条 · {{ fmtSize(a.size) }}</span></span>
        <button class="btn xs" @click="openCsv(a.url)"><Icon name="external" :size="12" /> 查看 CSV</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'

const props = defineProps<{ refreshSeq?: number }>()

const settings = useSettingsStore()
const ui = useUiStore()

const gateRecords = ref<any[]>([])
const gateTotal = ref(0)
const exemptRecords = ref<any[]>([])
const exemptTotal = ref(0)
const gateView = ref<'skipped' | 'restored'>('skipped')
const archives = ref<any[]>([])
const archiveQuery = ref('')
const archiveMonth = ref('')
const archiveResults = ref<any[]>([])
const archiveSearched = ref(false)

/** 拉取本 tab 数据：拦截 / 豁免记录与月度存档（对应原 loadGate 中 records 相关部分） */
async function loadRecords() {
  try {
    const out = await api.gate.records('skipped')
    gateTotal.value = out.total || 0
    gateRecords.value = out.items || []
  } catch {
    gateTotal.value = 0
    gateRecords.value = []
  }
  try {
    const out = await api.gate.records('restored')
    exemptTotal.value = out.total || 0
    exemptRecords.value = out.items || []
  } catch {
    exemptTotal.value = 0
    exemptRecords.value = []
  }
  try {
    archives.value = await api.gate.archives()
  } catch {
    archives.value = []
  }
}

function fmtSize(n: number) {
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'
}

function openCsv(url: string) {
  window.open(url, '_blank')
}

async function archiveAll() {
  try {
    const out = await api.gate.archive()
    ui.toast(`已按月存档 ${out.archived} 条记录 → ${out.files.join('、') || '（无变更）'}`)
  } catch (e: any) {
    ui.toast('存档失败：' + (e?.message || e))
  }
  await loadRecords()
  await settings.fetchScanStatus()
}

async function restoreGate(r: any) {
  try {
    const out = await api.gate.restore(r.id)
    if (out?.success === false) {
      ui.toast('恢复失败：' + (out.message || '未知错误'))
      return
    }
    ui.toast(`已恢复「${r.title || r.name}」入库，进入精炼队列`)
  } catch (e: any) {
    ui.toast('恢复失败：' + (e?.message || e))
  }
  await loadRecords()
  await settings.fetchScanStatus()
}

async function removeGateRecord(r: any) {
  await api.gate.removeRecord(r.id)
  ui.toast('已删除过滤记录')
  await loadRecords()
}

async function unexemptRecord(r: any) {
  await api.gate.removeRecord(r.id)
  ui.toast(`已取消「${r.title || r.name}」的豁免，下次全量重扫重新评估`)
  await loadRecords()
}

async function doSearchArchives() {
  const q = archiveQuery.value.trim()
  archiveSearched.value = true
  if (!q) {
    archiveResults.value = []
    archiveSearched.value = false
    return
  }
  try {
    const out = await api.gate.searchArchives(q, archiveMonth.value || undefined)
    archiveResults.value = out.results || []
  } catch {
    archiveResults.value = []
  }
}

// 进入 tab 首次挂载拉取数据（KeepAlive 缓存后切回不重复拉取，与拆分前一致）
onMounted(loadRecords)
// 父层「刷新」按钮：重新拉取本 tab 数据
watch(() => props.refreshSeq, loadRecords)
</script>
