<template>
  <div v-if="ui.modal" class="modal-wrap">
    <div class="modal-mask" @click="ui.closeModal()"></div>
    <div class="modal">
      <div class="modal-head">{{ title }}</div>
      <div class="modal-body">
        <!-- 新增/编辑领域 -->
        <template v-if="ui.modal.type === 'domain'">
          <div class="form-grid">
            <span class="fl">名称</span>
            <input class="inp" v-model="dmName" placeholder="例如 云原生安全" />
            <span class="fl">上级领域</span>
            <select class="inp" v-model="dmParent" :disabled="isEdit">
              <option value="">无（一级领域）</option>
              <option v-for="d in domains.tree" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <span class="fl">配色</span>
            <div class="swatches">
              <button v-for="c in SWATCHES" :key="c" class="swatch" :class="{ on: dmColor === c }" :style="{ background: c }" @click="dmColor = c" :aria-label="`选择颜色 ${c}`"></button>
            </div>
          </div>
          <div class="notice">{{ isEdit ? '名称与配色的修改会立即同步到收件坪的领域标识。' : '新建领域文件计数为 0，可随时在分拣区调整配色与排序。' }}</div>
        </template>

        <!-- 重新蒸馏确认 -->
        <template v-else-if="ui.modal.type === 'redistill'">
          <p style="font-size:13.5px;line-height:1.9">
            将重新调用 <b class="mono">{{ llm.providers.defaultModel || '默认模型' }}</b> 蒸馏「{{ targetFile?.title || targetFile?.name || '' }}」。<br />
            完成后更新的词条会替换入库。
          </p>
          <div class="notice">蒸馏消耗的 tokens 计入统计。</div>
        </template>

        <!-- 删除领域确认 -->
        <template v-else-if="ui.modal.type === 'domdel'">
          <p style="font-size:13.5px;line-height:1.9">
            确认删除领域「<b>{{ delDomain?.name }}</b>」？
            <template v-if="delDomain?.children?.length">该领域含 {{ delDomain.children.length }} 个子领域，将一并移除。</template>
            名下文件的归属将变为「未分类」。
          </p>
        </template>

        <!-- 清理已删除文件 -->
        <template v-else-if="ui.modal.type === 'purge'">
          <p style="font-size:13.5px;line-height:1.9">
            将彻底清理 <b class="mono">{{ delCount }}</b> 个已删除文件及其索引记录（源文件磁盘内容不会被删除）。此操作不可撤销。
          </p>
        </template>

        <!-- 批量归类 -->
        <template v-else-if="ui.modal.type === 'assign'">
          <p style="font-size:13.5px;line-height:1.9">将已选的 <b class="mono">{{ assignCount }}</b> 个文件归类到以下领域：</p>
          <div class="form-grid" style="margin-top:8px">
            <span class="fl">目标领域</span>
            <select class="inp" v-model="assignDomainId">
              <option value="">未分类</option>
              <option v-for="d in flattenDomains()" :key="d.id" :value="d.id">{{ d.parent_id ? '— ' : '' }}{{ d.name }}</option>
            </select>
          </div>
          <div class="notice">归类会立即更新收件坪与分拣区的领域计数。</div>
        </template>

        <!-- 阅读打分（两维极简） -->
        <template v-else-if="ui.modal.type === 'rate'">
          <p style="font-size:13.5px;line-height:1.9;margin-bottom:10px">读完「<b>{{ rateTitle }}</b>」了吗？10 秒打个分：</p>
          <div class="form-grid" style="margin-bottom:10px">
            <span class="fl">整体价值</span>
            <span class="stars" style="display:flex;gap:4px">
              <button v-for="s in 5" :key="s" class="star" :class="{ on: rateStars >= s }" @click="rateStars = s" :aria-label="`${s} 星`">★</button>
              <span class="cap" style="margin-left:6px">{{ rateStars || '—' }} / 5</span>
            </span>
            <span class="fl">可执行性</span>
            <span style="display:flex;gap:8px;flex-wrap:wrap">
              <button v-for="o in EXEC_OPTIONS" :key="o.v" class="chip" :class="{ on: rateIntent === o.v }" @click="rateIntent = o.v">{{ o.t }}</button>
            </span>
          </div>
          <div class="notice">「立即试 / 稍后试」会进入总览的执行队列，到点调起重读；「纯了解」仅归档。</div>
        </template>

        <!-- 挂载外部 Wiki（demo 预览） -->
        <template v-else-if="ui.modal.type === 'wikiImport'">
          <p style="font-size:13.5px;line-height:1.9">输入外部 llm-wiki 目录绝对路径，解析词条元数据（标题 / 来源 / 置信度 / 标签）并与库内文件比对。</p>
          <div class="form-grid" style="margin-top:8px">
            <span class="fl">wiki 目录</span>
            <input class="inp" v-model="wiDir" placeholder="/Volumes/新加卷/你的知识库/wiki" style="flex:1" @keyup.enter="runPreview" />
            <button class="btn sm" :disabled="wiLoading || !wiDir.trim()" @click="runPreview">
              <Icon name="search" :size="13" /> {{ wiLoading ? '解析中…' : '解析预览' }}
            </button>
          </div>
          <div v-if="wiError" class="notice" style="color:#C2402A">{{ wiError }}</div>
          <template v-if="wiReport">
            <div class="qsum" style="margin-top:12px">
              <div class="qsum-i"><span class="qsum-v">{{ wiReport.stats.total }}</span><span class="qsum-k">词条总数</span></div>
              <div class="qsum-i"><span class="qsum-v" style="color:#1E8E5A">{{ wiReport.stats.matched }}</span><span class="qsum-k">可挂接</span></div>
              <div class="qsum-i"><span class="qsum-v" style="color:#B4651A">{{ wiReport.stats.standalone }}</span><span class="qsum-k">独立词条</span></div>
              <div class="qsum-i"><span class="qsum-v">{{ wiReport.stats.already }}</span><span class="qsum-k">已存在</span></div>
            </div>
            <div style="max-height:300px;overflow:auto;margin-top:10px;border:1px solid var(--line)">
              <table class="rtable">
                <tr v-for="e in wiReport.entries" :key="e.file">
                  <td style="max-width:180px"><b style="font-size:12.5px">{{ e.title || '(无标题)' }}</b><br /><span class="cap mono" style="font-size:10.5px">{{ e.sourceBase || e.topic }}</span></td>
                  <td class="cap" style="white-space:nowrap">{{ e.confidence || '—' }}</td>
                  <td>
                    <span v-if="e.match === 'matched'" class="cap" style="color:#1E8E5A">可挂接 → {{ e.matchedTitle }}</span>
                    <span v-else-if="e.match === 'already'" class="cap">已存在</span>
                    <span v-else class="cap" style="color:#B4651A">独立词条（源不在库内）</span>
                  </td>
                </tr>
              </table>
            </div>
            <div class="notice">挂载执行：独立词条路径挂载（不移动文件）；可挂接词条关联源文件并移出蒸馏队列。</div>
          </template>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="ui.closeModal()">取消</button>
        <button v-if="ui.modal.type === 'domain'" class="btn primary" @click="submitDomain">{{ isEdit ? '保存修改' : '创建领域' }}</button>
        <button v-else-if="ui.modal.type === 'redistill'" class="btn primary" @click="confirmRedistill"><Icon name="beaker" :size="14" /> 确认重蒸馏</button>
        <button v-else-if="ui.modal.type === 'domdel'" class="btn danger" @click="confirmDomDel"><Icon name="trash" :size="14" /> 确认删除</button>
        <button v-else-if="ui.modal.type === 'purge'" class="btn danger" @click="confirmPurge"><Icon name="trash" :size="14" /> 确认清理</button>
        <button v-else-if="ui.modal.type === 'assign'" class="btn primary" @click="confirmAssign"><Icon name="grid" :size="14" /> 确认归类</button>
        <button v-else-if="ui.modal.type === 'rate'" class="btn primary" :disabled="!rateStars" @click="confirmRate">提交打分</button>
        <button v-else-if="ui.modal.type === 'wikiImport'" class="btn primary" :disabled="wiImporting || !wiReport" @click="confirmWikiImport">
          <Icon name="check" :size="14" /> {{ wiImporting ? '挂载中…' : '执行挂载' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { useUiStore } from '../stores/useUiStore'
import { useDomainsStore } from '../stores/useDomainsStore'
import { useFilesStore } from '../stores/useFilesStore'
import { useLlmStore } from '../stores/useLlmStore'
import { api } from '../api'

const ui = useUiStore()
const domains = useDomainsStore()
const files = useFilesStore()
const llm = useLlmStore()

const SWATCHES = ['#C2402A', '#B4651A', '#C25E00', '#6B7A3E', '#1E8E5A', '#0E6E8C', '#2456A6', '#7A5AA8']

const dmName = ref('')
const dmParent = ref<number | ''>('')
const dmColor = ref('#2456A6')

const isEdit = computed(() => ui.modal?.type === 'domain' && ui.modal?.opts?.mode === 'edit')

const editingDomain = computed(() => {
  if (!isEdit.value) return null
  const hit = domains.findNode(Number(ui.modal?.opts?.id))
  return hit?.node || null
})

watch(() => ui.modal, (m) => {
  if (!m) return
  if (m.type === 'domain') {
    const d = editingDomain.value
    dmName.value = d?.name || ''
    dmColor.value = d?.color || '#2456A6'
    dmParent.value = d?.parent_id || ''
  }
  if (m.type === 'purge') {
    // 统计当前已删除数量在 confirm 时请求
  }
})

const title = computed(() => {
  const t = ui.modal?.type
  if (t === 'domain') return isEdit.value ? '编辑领域' : '新增领域'
  if (t === 'redistill') return '重新蒸馏确认'
  if (t === 'domdel') return '删除领域'
  if (t === 'purge') return '清理已删除文件'
  if (t === 'assign') return '批量归类'
  if (t === 'rate') return '阅读打分'
  return ''
})

const targetFile = computed(() => {
  const id = Number(ui.modal?.opts?.fileId)
  return files.items.find((f: any) => f.id === id) || null
})

const delDomain = computed(() => {
  if (ui.modal?.type !== 'domdel') return null
  const hit = domains.findNode(Number(ui.modal?.opts?.id))
  return hit?.node || null
})

const delCount = ref(0)
watch(() => ui.modal?.type, async (t) => {
  if (t === 'purge') {
    try {
      const data = await files.fetchFiles()
      void data
    } catch { /* ignore */ }
    const deleted = await fetch('/api/files?status=deleted&limit=1').then(r => r.json()).catch(() => null)
    delCount.value = deleted?.total ?? 0
  }
})

function flattenDomains() {
  const out: any[] = []
  for (const d of domains.tree) {
    out.push(d)
    for (const c of d.children || []) out.push(c)
  }
  return out
}

async function submitDomain() {
  const name = dmName.value.trim()
  if (!name) {
    ui.toast('请填写领域名称')
    return
  }
  if (isEdit.value) {
    const d = editingDomain.value
    if (d) {
      await domains.updateDomain(d.id, { name, color: dmColor.value })
      ui.toast(`已更新领域「${name}」`)
    }
  } else {
    await domains.createDomain({ name, color: dmColor.value, parent_id: dmParent.value === '' ? null : dmParent.value })
    ui.toast(`已新增领域「${name}」`)
  }
  ui.closeModal()
}

async function confirmRedistill() {
  const f = targetFile.value
  if (f) {
    await files.redistill([f.id])
    ui.toast('已加入精炼队列 · 待处理 +1')
  }
  ui.closeModal()
}

async function confirmDomDel() {
  const d = delDomain.value
  if (d) {
    await domains.removeDomain(d.id)
    ui.toast(`已删除领域「${d.name}」`)
  }
  ui.closeModal()
}

async function confirmPurge() {
  const r = await files.purgeDeleted()
  ui.toast(`已清理 ${(r as any)?.purged ?? 0} 项 · 回收区清空`)
  ui.closeModal()
}

const assignCount = computed(() => files.selectedIds().length)
const assignDomainId = ref<number | ''>('')

// ---- 挂载外部 Wiki（demo 预览） ----
const wiDir = ref('')
const wiLoading = ref(false)
const wiError = ref('')
const wiReport = ref<any>(null)

async function runPreview() {
  if (!wiDir.value.trim() || wiLoading.value) return
  wiLoading.value = true
  wiError.value = ''
  wiReport.value = null
  try {
    const out = await api.wiki.importPreview(wiDir.value.trim())
    if (!out.ok) wiError.value = out.message || '解析失败'
    else wiReport.value = out
  } catch (e: any) {
    wiError.value = String(e?.message || e)
  } finally {
    wiLoading.value = false
  }
}

const wiImporting = ref(false)

async function confirmWikiImport() {
  if (!wiDir.value.trim() || wiImporting.value) return
  wiImporting.value = true
  try {
    const out = await api.wiki.importExec(wiDir.value.trim())
    if (out?.success) {
      ui.toast(`已挂载 ${out.imported} 个词条${out.linked ? `（关联源文件 ${out.linked}）` : ''}${out.skipped ? `，跳过已存在 ${out.skipped}` : ''}`)
      ui.closeModal()
    } else {
      wiError.value = out?.message || '挂载失败'
    }
  } catch (e: any) {
    wiError.value = String(e?.message || e)
  } finally {
    wiImporting.value = false
  }
}

async function confirmAssign() {
  const ids = files.selectedIds()
  if (!ids.length) {
    ui.toast('没有已选文件')
    ui.closeModal()
    return
  }
  await files.assignDomain(ids, assignDomainId.value === '' ? null : Number(assignDomainId.value))
  ui.toast(`已将 ${ids.length} 个文件归类到「${assignDomainId.value === '' ? '未分类' : domains.findNode(Number(assignDomainId.value))?.node?.name}」`)
  ui.closeModal()
}

// ---- 阅读打分（两维极简） ----
const EXEC_OPTIONS = [
  { v: 'now', t: '立即试' },
  { v: 'later', t: '稍后试' },
  { v: 'info', t: '纯了解' }
] as const
const rateTitle = computed(() => String(ui.modal?.opts?.title || ''))
const rateFileId = computed(() => Number(ui.modal?.opts?.fileId) || 0)
const rateStars = ref(0)
const rateIntent = ref<'now' | 'later' | 'info'>('info')

watch(() => ui.modal, (m) => {
  if (m?.type === 'rate') {
    rateStars.value = 0
    rateIntent.value = 'info'
  }
})

async function confirmRate() {
  if (!rateFileId.value || !rateStars.value) return
  const r = await api.reading.rate(rateFileId.value, rateStars.value, rateIntent.value)
  if (r?.warning) ui.toast(r.warning)
  else if (r?.queued) ui.toast(`已打 ${rateStars.value} 星 · 已加入执行队列（${rateIntent.value === 'now' ? '今天' : '明天'}到期）`)
  else ui.toast(`已打 ${rateStars.value} 星 · 已归档`)
  ui.closeModal()
}
</script>
