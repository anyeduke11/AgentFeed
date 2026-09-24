<template>
  <!-- 用户画像维护页（J2）：结构化断言列表——AI 断言可否决、用户可补充、版本可回滚、证据可回溯 -->
  <div class="sect">
    <div class="sect-head">
      <span class="sq"></span>
      <h2 class="stitle">用户画像</h2><span class="sect-en">User Profile</span>
      <div class="sright">
        <label class="pf-switch">
          <input type="checkbox" :checked="status.enabled" @change="toggleEnabled($event)" />
          画像蒸馏 {{ status.enabled ? '开' : '关' }}
        </label>
        <button class="btn xs" :disabled="!status.enabled" @click="distillNow">立即蒸馏</button>
      </div>
    </div>
    <div class="pf-meta">
      上次蒸馏：{{ status.lastDistilledAt || '从未' }}
      <span class="pf-hint">画像让注入与推送更贴合你的角色与倾向；断言均带证据可回溯，否决即从所有出口消失</span>
    </div>

    <!-- 全局画像卡 -->
    <div class="pf-card">
      <div class="pf-card-head">
        <h3>全局画像</h3>
        <span class="pf-budget">{{ claimCount(profile) }}/{{ budget }} 断言</span>
      </div>
      <div v-if="profile?.content?.role_pattern" class="pf-role">{{ profile.content.role_pattern }}</div>
      <!-- portrait：五段人读画像（基本信息/工作背景/个人背景/协作偏好/长期记忆），跨 AI 工具可复制使用 -->
      <pre v-if="profile?.content?.portrait" class="pf-portrait">{{ profile.content.portrait }}</pre>
      <div v-if="profile" class="pf-claims">
        <div v-for="c in profile.content.claims" :key="c.claim" class="pf-claim" :class="{ vetoed: c.status === 'vetoed' }">
          <span class="pf-badge" :class="c.status">{{ c.status === 'active' ? 'AI' : c.status === 'user_added' ? '用户' : '已否决' }}</span>
          <span class="pf-text">{{ c.claim }}</span>
          <span class="pf-conf">置信 {{ Number(c.confidence).toFixed(2) }}</span>
          <button v-if="c.evidence.length" class="btn xs ghost" @click="showEvidence(c.evidence)">证据 {{ c.evidence.length }}</button>
          <span v-else class="pf-hint">用户自述</span>
          <button v-if="c.status !== 'vetoed'" class="btn xs danger" @click="veto(profile.id, c.claim)">否决</button>
        </div>
        <div v-if="!profile.content.claims.length" class="pf-hint">暂无断言</div>
      </div>
      <div v-if="!profile" class="pf-empty">
        <div class="empty" style="padding:18px">
          <div class="e-t">尚无画像</div>
          <div class="e-s">信号积累中——可先手动补充断言，或点「立即蒸馏」由 AI 生成首版画像</div>
        </div>
      </div>
      <div class="pf-add">
        <input v-model="newGlobalClaim" class="pf-input" maxlength="200" placeholder="补充一条你对自己的断言（如：偏好渐进式引导、重实操轻理论）" @keyup.enter="addGlobal" />
        <button class="btn xs" :disabled="!newGlobalClaim.trim()" @click="addGlobal">补充</button>
      </div>
    </div>

    <!-- 版本链 -->
    <div class="pf-card">
      <div class="pf-card-head"><h3>版本历史</h3><button class="btn xs ghost" @click="showVersions = !showVersions">{{ showVersions ? '收起' : '展开' }}</button></div>
      <div v-if="showVersions" class="pf-versions">
        <div v-for="v in versions" :key="v.id" class="pf-ver" :class="{ cur: v.active }">
          <span class="mono">#{{ v.id }}</span>
          <span>{{ v.generatedAt || '-' }}</span>
          <span>{{ v.claimCount ?? '解析失败' }} 条</span>
          <span v-if="v.active" class="pf-tag">当前</span>
          <button v-else class="btn xs" @click="revert(v.id)">回滚到此版</button>
        </div>
        <div v-if="!versions.length" class="pf-hint">暂无历史版本</div>
      </div>
    </div>

    <!-- 证据抽屉 -->
    <div v-if="evidencePanel" class="pf-evidence">
      <div class="pf-card-head"><h3>证据回溯</h3><button class="btn xs ghost" @click="evidencePanel = null">×</button></div>
      <div v-if="evidencePanel.loading" class="pf-hint">加载中…</div>
      <template v-else-if="evidencePanel.found === false">
        <div class="pf-hint">该证据行已不存在（可能被清理）</div>
      </template>
      <template v-else>
        <div v-for="(row, i) in evidencePanel.rows" :key="i" class="pf-ev-row">
          <div class="mono pf-ev-ptr">{{ row.ptr }}</div>
          <pre class="pf-ev-json">{{ JSON.stringify(row.data, null, 2) }}</pre>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useUiStore } from '../../stores/useUiStore'

const props = defineProps<{ refreshSeq?: number }>()
const ui = useUiStore()

const status = ref<{ enabled: boolean, lastDistilledAt: string | null }>({ enabled: true, lastDistilledAt: null })
const profile = ref<{ id: number, content: { role_pattern: string, portrait?: string, claims: any[] } } | null>(null)
const budget = ref(20)
const versions = ref<any[]>([])
const showVersions = ref(false)
const newGlobalClaim = ref('')
const evidenceCache = ref(new Map<string, any>())
const evidencePanel = ref<{ loading: boolean, found?: boolean, rows: { ptr: string, data: any }[] } | null>(null)

/** 生效断言计数（vetoed 不占预算口径，与 model.ts enforceClaimBudget 一致） */
const claimCount = (p: typeof profile.value) => p ? p.content.claims.filter((c: any) => c.status !== 'vetoed').length : 0

async function loadAll() {
  try {
    const [st, pr] = await Promise.all([api.profile.status(), api.profile.get('global')])
    status.value = st
    profile.value = pr.profile
    budget.value = pr.budget ?? 20
  } catch { /* 保持旧值 */ }
  try {
    const vs = await api.profile.versions('global')
    versions.value = vs.versions || []
  } catch { versions.value = [] }
}

async function toggleEnabled(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  await fetch('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'userProfile.enabled': { value: on } }) })
  status.value.enabled = on
  ui.toast(on ? '画像蒸馏已开启' : '画像蒸馏已关闭（现有画像只读，不再外发）')
}

async function distillNow() {
  const r = await api.profile.distill()
  ui.toast(r.queued ? '画像蒸馏已插队执行 · 完成后自动刷新' : (r.enabled ? '已有蒸馏在进行中' : '画像蒸馏已关闭'))
  if (r.queued) pollDistillDone()
}

/** 蒸馏完成自动刷新：轮询 status.lastDistilledAt 变化（3s × 60 次 ≈ 3 分钟窗口，手动插队任务足够完成） */
let pollTimer: ReturnType<typeof setInterval> | null = null
function pollDistillDone() {
  if (pollTimer) clearInterval(pollTimer)
  let n = 0
  const before = status.value.lastDistilledAt
  pollTimer = setInterval(async () => {
    n++
    try {
      const st = await api.profile.status()
      if (st.lastDistilledAt && st.lastDistilledAt !== before) {
        clearInterval(pollTimer!)
        pollTimer = null
        await loadAll()
        ui.toast('画像蒸馏完成 · 已刷新展示')
        return
      }
    } catch { /* 下轮再查 */ }
    if (n >= 60) { clearInterval(pollTimer!); pollTimer = null }
  }, 3000)
}

async function veto(versionId: number, claim: string) {
  const r = await api.profile.veto(versionId, claim)
  if (r.success) { ui.toast('已否决：即刻从人读/机读出口消失，并作为下轮蒸馏负例'); await loadAll() }
  else ui.toast(r.error || '否决失败')
}

async function addGlobal() {
  const claim = newGlobalClaim.value.trim()
  if (!claim) return
  const r = await api.profile.addClaim('global', claim)
  if (r.success) { newGlobalClaim.value = ''; ui.toast('已补充（用户断言蒸馏时原样保留）'); await loadAll() }
  else ui.toast(r.error || '补充失败')
}

async function revert(versionId: number) {
  const r = await api.profile.revert(versionId)
  if (r.success) { ui.toast('已回滚：出口按回滚版渲染'); await loadAll() }
  else ui.toast(r.error || '回滚失败')
}

async function showEvidence(ptrs: string[]) {
  evidencePanel.value = { loading: true, rows: [] }
  const rows: { ptr: string, data: any }[] = []
  let anyFound = false
  for (const ptr of ptrs.slice(0, 5)) {
    let d = evidenceCache.value.get(ptr)
    if (!d) {
      try { d = await api.profile.evidence(ptr); evidenceCache.value.set(ptr, d) } catch { d = { found: false } }
    }
    if (d?.found) { anyFound = true; rows.push({ ptr, data: d.row }) }
    else rows.push({ ptr, data: { note: '行不存在或不可回溯' } })
  }
  evidencePanel.value = { loading: false, found: anyFound, rows }
}

onMounted(loadAll)
watch(() => props.refreshSeq, loadAll)
</script>

<script lang="ts">
// 断言行子组件（同文件声明：三态图标 + 否决 + 证据按钮；空证据 user_added 显示「用户自述」）
export default { name: 'SettingsProfile' }
</script>

<style scoped>
.pf-meta { font-size: 12px; color: var(--text-2); padding: 2px 0 10px; }
.pf-hint { font-size: 12px; color: var(--text-2); }
.pf-switch { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; cursor: pointer; }
.pf-card { border: 1px solid var(--border); border-radius: var(--r); padding: 10px 12px; margin-bottom: 12px; }
.pf-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.pf-card-head h3 { margin: 0; font-size: 13px; }
.pf-budget { font-size: 11px; color: var(--text-2); }
.pf-role { font-size: 13px; font-weight: 600; padding: 4px 0 8px; }
/* portrait 五段画像：保留换行的等宽块（内容是纯文本非 Markdown） */
.pf-portrait { font-family: var(--sans); font-size: 12.5px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; background: var(--hover-2); border: 1px solid var(--border); border-radius: var(--r); padding: 10px 12px; margin: 0 0 10px; }
.pf-claims { display: flex; flex-direction: column; gap: 4px; }
.pf-claim { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
.pf-claim.vetoed { opacity: .5; text-decoration: line-through; }
.pf-badge { font-size: 10px; border-radius: 4px; padding: 1px 5px; border: 1px solid currentColor; }
.pf-badge.active { color: var(--steel); }
.pf-badge.user_added { color: var(--ok); }
.pf-badge.vetoed { color: #999; }
.pf-conf { color: var(--text-2); font-size: 11px; }
.pf-add { display: flex; gap: 6px; margin-top: 8px; }
.pf-input { flex: 1; font-size: 12px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--r); }
.pf-versions { display: flex; flex-direction: column; gap: 4px; }
.pf-ver { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 3px 0; }
.pf-ver.cur { font-weight: 600; }
.pf-tag { font-size: 10px; color: var(--steel); border: 1px solid var(--steel); border-radius: var(--r); padding: 0 4px; }
.pf-evidence { border: 1px dashed var(--border); border-radius: var(--r); padding: 10px 12px; margin-top: 4px; }
.pf-ev-row { margin-bottom: 6px; }
.pf-ev-ptr { font-size: 11px; color: var(--text-2); }
.pf-ev-json { font-size: 11px; background: var(--hover-2); border-radius: var(--r); padding: 6px 8px; margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; }
.btn.ghost { background: transparent; }
</style>
