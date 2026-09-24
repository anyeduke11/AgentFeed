<template>
  <!-- 日志管理 -->
  <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">日志管理</h2><span class="sect-en">Logs</span><div class="sright" style="display:flex;gap:8px;align-items:center">
          <input class="inp" style="max-width:240px" v-model="logKw" placeholder="搜索：模型 / 状态 / 错误 / 工具…" aria-label="搜索日志" @keyup.enter="loadLogs(true)" />
          <select v-if="logView === 'llm'" class="inp" style="max-width:110px" v-model="logStatus" aria-label="状态过滤" @change="loadLogs(true)">
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="timeout">超时</option>
            <option value="rate_limited">限流</option>
          </select>
          <button class="btn xs" @click="loadLogs(true)"><Icon name="search" :size="12" /> 搜索</button>
      </div></div>
        <div class="tabs" style="padding:10px 14px 0">
          <button class="tab" :class="{ on: logView === 'llm' }" @click="switchLogView('llm')">LLM 调用（{{ llmLogsTotal }}）</button>
          <button class="tab" :class="{ on: logView === 'mcp' }" @click="switchLogView('mcp')">MCP 调用（{{ mcpLogsTotal }}）</button>
          <button class="tab" :class="{ on: logView === 'scan' }" @click="switchLogView('scan')">扫描日志（{{ settings.scanJobsTotal }}）</button>
          <button class="tab" :class="{ on: logView === 'service' }" @click="switchLogView('service')">服务日志（{{ svcTotal }}）</button>
          <button class="tab" :class="{ on: logView === 'export' }" @click="switchLogView('export')">会话产物（{{ exportLogsTotal }}）</button>
        </div>
        <!-- LLM 调用日志（细化排错：文件名 / tokens 细分 / 点击展开完整错误与耗时明细） -->
        <template v-if="logView === 'llm'">
          <!-- G1 用量与成本：按天 / 按模型（成本依赖 config ai.pricing 单价表，未配单价显示 —，合计仅含已配价模型） -->
          <div v-if="llmStats" style="padding:12px 14px 0;display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div>
              <div class="cap" style="margin-bottom:6px">按天用量（近 30 天）</div>
              <table class="rtable">
                <thead><tr>
                  <th>日期</th><th>调用</th><th>tokens</th>
                  <th :title="llmStats.unknownPricing ? '部分模型未配单价，合计仅含已配价模型' : undefined">成本</th>
                </tr></thead>
                <tbody>
                  <tr v-for="d in llmStats.byDay || []" :key="d.day">
                    <td class="mono">{{ d.day }}</td>
                    <td>{{ d.calls }}</td>
                    <td class="mono">{{ d.tokens ?? '—' }}</td>
                    <td class="mono">{{ fmtCost(d.cost) }}</td>
                  </tr>
                  <tr v-if="!(llmStats.byDay || []).length"><td colspan="4" class="cap">暂无调用</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <div class="cap" style="margin-bottom:6px">按模型用量</div>
              <table class="rtable">
                <thead><tr>
                  <th>模型</th><th>调用</th><th>tokens</th>
                  <th :title="llmStats.unknownPricing ? '部分模型未配单价，合计仅含已配价模型' : undefined">成本</th>
                </tr></thead>
                <tbody>
                  <tr v-for="m in llmStats.byModel || []" :key="m.provider + '/' + m.model">
                    <td>{{ providerLabel(m.provider) }} · {{ m.model }}</td>
                    <td>{{ m.calls }}</td>
                    <td class="mono">{{ m.tokens ?? '—' }}</td>
                    <td class="mono">{{ fmtCost(m.cost) }}</td>
                  </tr>
                  <tr v-if="!(llmStats.byModel || []).length"><td colspan="4" class="cap">暂无调用</td></tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="3" class="cap">{{ llmStats.unknownPricing ? '合计成本（部分模型未配单价，仅含已配价模型）' : '合计成本' }}</td>
                    <td class="mono">{{ fmtCost(llmStats.totalCost) }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <template v-if="llmLogs.length">
            <template v-for="l in llmLogs" :key="l.id">
              <div class="delrow" style="cursor:pointer" @click="expandedLog = expandedLog === l.id ? 0 : l.id">
                <span class="dn" style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center">
                  <span class="mono" style="font-size:11.5px">{{ l.created_at }}</span>
                  <span class="stb">{{ providerLabel(l.provider) }} · {{ l.model }}</span>
                  <span :class="'stb ' + (l.status === 'success' ? '' : 'bad')" :style="l.status === 'success' ? '' : 'color:var(--fail)'">{{ statusLabel(l.status) }}</span>
                  <span style="font-size:12px;color:var(--ink);font-weight:600;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="l.file_name || ''">{{ l.file_name || `#${l.file_id ?? '-'}` }}</span>
                  <span class="cap mono">#{{ l.file_id ?? '-' }} · {{ fmtLogDur(l.duration_ms) }}</span>
                  <span v-if="l.error" class="cap mono" style="color:var(--fail);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ errHeadline(l.error) }}</span>
                </span>
                <Icon :name="expandedLog === l.id ? 'chevronDown' : 'chevronDown'" :size="13" style="transform:rotate(-90deg);flex-shrink:0" :style="expandedLog === l.id ? 'transform:rotate(0deg)' : ''" />
              </div>
              <!-- 展开明细：完整错误 + token 细分 + 耗时 -->
              <div v-if="expandedLog === l.id" class="delrow" style="display:block;background:var(--bg-2);border-bottom:1px solid var(--border)">
                <div style="display:flex;flex-wrap:wrap;gap:8px 18px;padding:2px 0 8px;font-size:12px">
                  <span class="cap mono">文件 #{{ l.file_id ?? '-' }}{{ l.file_name ? ' · ' + l.file_name : '' }}</span>
                  <span class="cap mono">提示 {{ l.prompt_tokens ?? '-' }} tok</span>
                  <span class="cap mono">补全 {{ l.completion_tokens ?? '-' }} tok</span>
                  <span class="cap mono">合计 {{ l.total_tokens ?? '-' }} tok</span>
                  <span class="cap mono">耗时 {{ l.duration_ms != null ? fmtLogDur(l.duration_ms) + ` (${l.duration_ms}ms)` : '-' }}</span>
                  <span class="cap mono">调用 ID #{{ l.id }}</span>
                </div>
                <div v-if="l.error" style="padding:8px 10px;margin-bottom:8px;border:1px solid var(--danger-border);background:var(--danger-soft);border-radius:var(--r)">
                  <div class="cap" style="color:var(--fail);font-weight:600;margin-bottom:6px">错误详情</div>
                  <!-- 结构化信封（新行）：错误码 / HTTP 状态 / 说明 / 服务端消息 / 原始响应 分行展示 -->
                  <template v-if="parseLlmError(l.error)">
                    <div style="display:grid;grid-template-columns:92px 1fr;gap:5px 10px;font-size:12px;align-items:baseline">
                      <span class="cap">错误码</span><code class="mono" style="color:var(--fail-ink)">{{ parseLlmError(l.error).code }}</code>
                      <template v-if="parseLlmError(l.error).status">
                        <span class="cap">HTTP 状态</span><code class="mono" style="color:var(--fail-ink)">{{ parseLlmError(l.error).status }}</code>
                      </template>
                      <span class="cap">说明</span><span style="color:var(--fail-ink)">{{ parseLlmError(l.error).hint || '—' }}</span>
                      <template v-if="parseLlmError(l.error).message">
                        <span class="cap">服务端消息</span><span class="mono" style="color:var(--fail-ink);word-break:break-all">{{ parseLlmError(l.error).message }}</span>
                      </template>
                    </div>
                    <details v-if="parseLlmError(l.error).raw" style="margin-top:6px">
                      <summary class="cap" style="cursor:pointer;user-select:none">原始响应</summary>
                      <pre class="mono" style="margin:4px 0 0;white-space:pre-wrap;word-break:break-all;font-size:11.5px;color:var(--fail-ink);max-height:200px;overflow:auto">{{ parseLlmError(l.error).raw }}</pre>
                    </details>
                  </template>
                  <!-- 旧格式纯文本（含网络错误原文等）回退原展示 -->
                  <pre v-else class="mono" style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:11.5px;color:var(--fail-ink);max-height:200px;overflow:auto">{{ l.error }}</pre>
                </div>
                <div v-else class="cap" style="padding-bottom:8px">本次调用成功，无错误信息。</div>
              </div>
            </template>
            <div v-if="llmLogs.length < llmLogsTotal" class="cap" style="display:block;padding:8px 14px;text-align:center">
              <button class="btn xs" @click="loadMoreLogs">加载更多（已显示 {{ llmLogs.length }} / {{ llmLogsTotal }}）</button>
            </div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无 LLM 调用日志</div>
              <div class="e-s">蒸馏与标注的每次模型调用（token 用量 / 耗时 / 状态）都会记录在这里。</div>
            </div></div>
          </template>
        </template>
        <!-- MCP 调用日志 -->
        <template v-else-if="logView === 'mcp'">
          <template v-if="mcpLogs.length">
            <div v-for="m in mcpLogs" :key="m.id" class="delrow">
              <span class="dn" style="display:flex;gap:10px;align-items:center">
                <span class="mono" style="font-size:11.5px">{{ m.created_at }}</span>
                <span class="stb mono">{{ m.tool }}</span>
                <span class="cap">客户端 {{ m.client }}</span>
              </span>
            </div>
            <div class="cap" style="display:block;padding:8px 14px">仅显示最近 {{ mcpLogs.length }} 条{{ mcpLogs.length < mcpLogsTotal ? '（共 ' + mcpLogsTotal + ' 条）' : '' }}。</div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无 MCP 调用日志</div>
              <div class="e-s">外部客户端通过 MCP 调用工具时会在这里留痕。</div>
            </div></div>
          </template>
        </template>
        <!-- 扫描台账日志（从扫描根 tab 迁入：来源 / 时间 / 增删改 / 门禁 / 耗时或错误） -->
        <template v-else-if="logView === 'scan'">
          <template v-if="settings.scanJobs.length">
            <div v-for="j in settings.scanJobs" :key="j.id" class="jobrow" :title="j.error || String(j.roots || '')">
              <span class="stb jobsrc">{{ SOURCE_LABELS[j.source] || j.source }}</span>
              <span class="rc mono">{{ fmtJobTime(j.started_at) }}</span>
              <span class="rc mono">扫 {{ j.scanned }} · 新 {{ j.added }} · 更 {{ j.updated }} · 删 {{ j.deleted }} · 门 {{ j.gated }}</span>
              <span class="rc" :class="j.error ? 'job-err' : 'mono'">{{ j.error ? '失败 · ' + j.error : fmtLogDur(j.duration_ms) }}</span>
            </div>
            <div class="cap" style="display:block;padding:8px 14px">仅显示最近 {{ settings.scanJobs.length }} 条{{ settings.scanJobs.length < settings.scanJobsTotal ? '（共 ' + settings.scanJobsTotal + ' 条）' : '' }}。</div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无扫描日志</div>
              <div class="e-s">每次扫描（手动 / 周期 / 启动 / 重扫）的台账：扫描数 / 新增 / 更新 / 删除 / 门禁拦截与耗时。</div>
            </div></div>
          </template>
        </template>
        <!-- 服务运行日志 -->
        <template v-else-if="logView === 'service'">
          <template v-if="svcLogs.length">
            <div style="padding:10px 14px 14px">
              <div v-for="(l, i) in svcLogs" :key="i" class="mono" :style="isErrLine(l) ? 'font-size:11.5px;line-height:1.7;color:var(--fail);word-break:break-all' : 'font-size:11.5px;line-height:1.7;color:var(--text-2);word-break:break-all'">{{ l }}</div>
            </div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无服务日志</div>
              <div class="e-s">服务启动、扫描、队列与回填等运行日志（.service.log 尾部）会显示在这里。</div>
            </div></div>
          </template>
        </template>
        <!-- 会话产物日志（批次 B 复利留痕）：导出/蒸馏入库的文件台账 -->
        <template v-else-if="logView === 'export'">
          <template v-if="exportLogs.length">
            <div v-for="l in exportLogs" :key="l.id" class="jobrow" :title="l.path">
              <span class="rc mono">{{ fmtJobTime(l.createdAt) }}</span>
              <span class="stb jobsrc" :style="l.kind === 'distill' ? '' : 'opacity:.65'">{{ l.kind === 'distill' ? '入库' : '导出' }}</span>
              <span class="rc" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ l.title }}</span>
              <span class="rc mono">{{ l.chars }} 字</span>
              <span v-if="l.match" class="rc mono" :title="l.match === 'already' ? '该文件此前已入库（幂等跳过）' : '检索立即可命中'">{{ l.match === 'already' ? '已入库·跳过' : '已入库' }}</span>
              <a v-if="l.entryId" class="rc" :href="'/reader/' + l.entryId" style="color:var(--ink)">阅读 →</a>
            </div>
            <div class="cap" style="display:block;padding:8px 14px">仅显示最近 {{ exportLogs.length }} 条{{ exportLogs.length < exportLogsTotal ? '（共 ' + exportLogsTotal + ' 条）' : '' }}。</div>
          </template>
          <template v-else>
            <div style="padding:4px 0 0"><div class="empty" style="padding:22px">
              <span class="e-ic"><Icon name="search" :size="26" /></span>
              <div class="e-t">暂无会话产物</div>
              <div class="e-s">对话页会话「出」→ 导出文件 / 蒸馏入库后，产物台账会显示在这里；入库词条可一键回阅读器。</div>
            </div></div>
          </template>
        </template>
      </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { api } from '../../api'
import { providerLabel } from './shared'

const props = defineProps<{ refreshSeq?: number }>()

const settings = useSettingsStore()

const logView = ref<'llm' | 'mcp' | 'scan' | 'service' | 'export'>('llm')
const logKw = ref('')
const logStatus = ref('')
const llmLogs = ref<any[]>([])
const llmLogsTotal = ref(0)
const llmLogPage = ref(1)
const mcpLogs = ref<any[]>([])
const mcpLogsTotal = ref(0)
const svcLogs = ref<string[]>([])
// 会话产物台账（chat_export_logs：导出/蒸馏入库留痕）
const exportLogs = ref<Array<{ id: number; kind: string; title: string; path: string; match: string | null; entryId: number | null; chars: number; createdAt: string }>>([])
const exportLogsTotal = ref(0)
/** G1 LLM 用量/成本统计（api.stats.llm：byDay/byModel 含 cost，顶层 totalCost/unknownPricing） */
const llmStats = ref<any>(null)

/** 成本格式化：未配单价 null → '—'；金额去尾零（0.2469 / 10） */
function fmtCost(c: number | null | undefined) {
  return c == null ? '—' : '¥' + String(+Number(c).toFixed(4))
}
/** 服务日志总数（读取窗口内行数，与列表接口 total 同源）——徽标不能直接用 svcLogs.length（≤500 截断） */
const svcTotal = ref(0)

const STATUS_LABELS: Record<string, string> = { success: '成功', failed: '失败', timeout: '超时', rate_limited: '限流' }
function statusLabel(s: string) {
  return STATUS_LABELS[s] || s || '-'
}
/** 解析落库错误：新格式为 friendlyLlmError 结构化信封（kind=provider/internal），旧格式为纯文本 */
function parseLlmError(e: string): any | null {
  const t = String(e || '').trim()
  if (!t.startsWith('{')) return null
  try { const o = JSON.parse(t); return o && (o.kind === 'provider' || o.kind === 'internal') ? o : null } catch { return null }
}
/** 列表行内单行摘要：结构化错误取「错误码 服务端消息」，纯文本截断 */
function errHeadline(e: string): string {
  const p = parseLlmError(e)
  if (!p) return e
  return `【${p.code}${p.status ? ' ' + p.status : ''}】${p.message || p.hint || ''}`
}
// 行展开（排错明细）与耗时格式化
const expandedLog = ref(0)
function fmtLogDur(ms?: number | null) {
  if (ms == null) return '-'
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}

// 扫描台账：来源标签与时间格式化
const SOURCE_LABELS: Record<string, string> = { manual: '手动', rescan: '重扫', boot: '启动', interval: '周期' }
function fmtJobTime(t?: string | null) {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

function isErrLine(l: string) {
  const s = l.toLowerCase()
  return s.includes('error') || s.includes('failed') || s.includes('fail')
}

/** 按当前二级视图加载日志；fresh=true 时重置到第一页；scan 台账在 switchLogView 里刷新 */
async function loadLogs(fresh = false) {
  const kw = logKw.value.trim()
  try {
    if (logView.value === 'scan') {
      return
    } else if (logView.value === 'llm') {
      if (fresh) llmLogPage.value = 1
      const out = await api.llm.logs({ page: String(llmLogPage.value), limit: '50', kw, status: logStatus.value })
      llmLogs.value = fresh ? (out.items || []) : [...llmLogs.value, ...(out.items || [])]
      llmLogsTotal.value = out.total || 0
    } else if (logView.value === 'mcp') {
      const out = await api.llm.mcpLogs(kw)
      mcpLogs.value = out.items || []
      mcpLogsTotal.value = out.total || 0
    } else if (logView.value === 'export') {
      const out = await api.chat.exportLogs()
      exportLogs.value = out.logs || []
      exportLogsTotal.value = out.total || 0
    } else {
      const out = await api.llm.serviceLogs(kw)
      svcLogs.value = out.items || []
      svcTotal.value = out.total || 0
    }
  } catch {
    /* 拉取失败保持现状，避免闪空 */
  }
}

/** 进入日志管理即并行刷新五类徽标（不等懒加载出 0），当前视图列表照常拉取 */
function refreshLogBadges() {
  settings.fetchScanJobs()
  api.llm.mcpLogs().then(out => { mcpLogsTotal.value = out.total || 0 }).catch(() => {})
  api.llm.serviceLogs().then(out => { svcTotal.value = out.total || 0 }).catch(() => {})
  api.chat.exportLogs().then(out => { exportLogsTotal.value = out.total || 0 }).catch(() => {})
  api.stats.llm().then(s => { llmStats.value = s }).catch(() => {})
}

function switchLogView(v: 'llm' | 'mcp' | 'scan' | 'service' | 'export') {
  logView.value = v
  if (v === 'scan') settings.fetchScanJobs()
  else loadLogs(true)
}

async function loadMoreLogs() {
  llmLogPage.value++
  await loadLogs()
}

/** 进入日志 tab / 父层刷新时：先刷徽标，再按当前视图拉列表（对应原 watch(settingsTab) logs 分支） */
function load() {
  refreshLogBadges()
  logView.value === 'scan' ? settings.fetchScanJobs() : loadLogs(true)
}

// 进入 tab 首次挂载拉取数据（KeepAlive 缓存后切回不重复拉取，与拆分前一致）
onMounted(load)
// 父层「刷新」按钮：重新拉取本 tab 数据
watch(() => props.refreshSeq, load)
</script>
