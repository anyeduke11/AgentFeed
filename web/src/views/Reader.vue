<template>
  <div class="reader-wrap" :class="{ dark }">
    <div class="reader-bar">
      <button class="btn ghost sm" @click="goBack">← 返回</button>
      <button v-if="toc.length >= 3" class="btn ghost sm" @click="showToc = !showToc">{{ showToc ? '隐藏目录' : '目录' }}</button>
      <span class="reader-title">{{ title || '站内阅读' }}</span>
      <span v-if="truncated" class="cap" style="color:#B4651A">内容超过 2MB，站内仅展示前 2MB · <a href="javascript:void(0)" style="color:inherit;text-decoration:underline" @click="openExternal">外部打开看全文</a></span>
      <span class="reader-right">
        <span v-if="pct > 0" class="cap mono">已读 {{ pct }}%</span>
        <button class="btn ghost sm" :disabled="fontPx <= 13" @click="changeFont(-1)">A−</button>
        <span class="cap mono">{{ fontPx }}px</span>
        <button class="btn ghost sm" :disabled="fontPx >= 21" @click="changeFont(1)">A+</button>
        <button class="btn ghost sm" @click="toggleDark">{{ dark ? '日间' : '夜间' }}</button>
        <button v-if="inPool" class="btn sm" @click="openRate">打分</button>
        <button class="btn ghost sm" @click="openExternal">外部打开</button>
      </span>
    </div>

    <div v-if="loading" class="reader-empty"><span class="cap">正在载入内容…</span></div>
    <div v-else-if="err" class="reader-empty">
      <span class="cap" style="color:#A33">{{ err }}</span>
      <span style="display:flex;gap:8px;margin-top:10px">
        <button class="btn sm primary" @click="openExternal">外部打开</button>
        <button class="btn sm" @click="goBack">返回</button>
      </span>
    </div>
    <div v-else class="reader-main">
      <!-- 目录侧栏（R4-M3）：h1~h3 锚点跳转，仅长文（≥3 个标题）显示开关 -->
      <aside v-if="showToc && toc.length" class="reader-toc">
        <div v-for="t in toc" :key="t.id" class="toc-item" :style="{ paddingLeft: (t.level - 1) * 12 + 'px' }" @click="jumpHeading(t.id)">{{ t.text }}</div>
      </aside>
      <!-- 双保险沙箱：不含 allow-scripts（内容零脚本执行）；allow-same-origin 让父页可读滚动位置以实现进度记录 -->
      <iframe ref="frameEl" class="reader-frame" :srcdoc="doc" sandbox="allow-same-origin" title="站内阅读" @load="onFrameLoad"></iframe>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { useUiStore } from '../stores/useUiStore'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

const fileId = parseInt(String(route.params.id))
const loading = ref(true)
const doc = ref('')
const title = ref('')
const truncated = ref(false)
const err = ref('')
const pct = ref(0)
const frameEl = ref<HTMLIFrameElement | null>(null)
const toc = ref<{ level: number; text: string; id: string }[]>([])
const showToc = ref(false)
// 阅读偏好（R4-M3）：字号 13~21px、夜间模式，localStorage 持久化
const fontPx = ref(parseInt(localStorage.getItem('reader:font') || '') || 16)
const dark = ref(localStorage.getItem('reader:theme') === 'dark')
// 进度记忆仅池内文件生效（与 R1 手动挡同源同列），非池内文件可读不记
const inPool = ref(false)
let lastProgress = 0
let lastSentPct = -1
let lastSentAt = 0
let scoredHintShown = false

onMounted(load)
onUnmounted(() => {
  report(true)
})

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r = await api.files.content(fileId)
    if (r?.success && r.html) {
      doc.value = r.html
      title.value = r.title || ''
      truncated.value = !!r.truncated
      inPool.value = !!r.inPool
      lastProgress = r.lastProgress || 0
      toc.value = r.toc || []
    } else {
      err.value = r?.message || '内容加载失败'
    }
  } catch {
    err.value = '内容加载失败，请确认后端服务已启动'
  }
  loading.value = false
}

/** iframe 载入完成：回位到上次进度（误差 ≤ 1 屏验收口径），挂滚动监听并应用阅读偏好 */
function onFrameLoad() {
  const d = frameEl.value?.contentDocument
  if (!d) return
  if (lastProgress > 0) {
    const max = d.documentElement.scrollHeight - d.documentElement.clientHeight
    if (max > 0) d.documentElement.scrollTop = Math.floor((lastProgress / 100) * max)
  }
  d.addEventListener('scroll', onScroll, { passive: true })
  applyPrefs()
  syncPct()
}

/** 应用阅读偏好：字号 + 主题变量覆盖（壳内颜色全部走 --r-* 变量，这里注入覆盖即可） */
function applyPrefs() {
  const d = frameEl.value?.contentDocument
  if (!d) return
  let style = d.getElementById('reader-prefs') as HTMLStyleElement | null
  if (!style) {
    style = d.createElement('style')
    style.id = 'reader-prefs'
    d.head.appendChild(style)
  }
  style.textContent = dark.value
    ? `:root{--r-bg:#1C1B19;--r-fg:#D8D4CA;--r-muted:#9A958A;--r-line:#3A3833;--r-code:#2A2823;--r-accent:#8FB4E8} body{font-size:${fontPx.value}px}`
    : `body{font-size:${fontPx.value}px}`
}

function changeFont(step: number) {
  fontPx.value = Math.min(21, Math.max(13, fontPx.value + step))
  localStorage.setItem('reader:font', String(fontPx.value))
  applyPrefs()
}

function toggleDark() {
  dark.value = !dark.value
  localStorage.setItem('reader:theme', dark.value ? 'dark' : 'light')
  applyPrefs()
}

/** 目录跳转：iframe 内锚点平滑滚动（滚动事件会触发既有进度上报链路，无需额外处理） */
function jumpHeading(id: string) {
  const el = frameEl.value?.contentDocument?.getElementById(id)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onScroll() {
  syncPct()
  report(false)
}

function syncPct() {
  const d = frameEl.value?.contentDocument
  if (!d) return
  const max = d.documentElement.scrollHeight - d.documentElement.clientHeight
  pct.value = max <= 0 ? 0 : Math.min(100, Math.round((d.documentElement.scrollTop / max) * 100))
}

/** 进度上报：3s 节流（复用 POST /reading/progress 与 R1 同列）；100% 一次性 toast 引导打分 */
function report(force: boolean) {
  if (!inPool.value) return
  const now = Date.now()
  if (!force && now - lastSentAt < 3000) return
  if (pct.value === lastSentPct) return
  lastSentAt = now
  lastSentPct = pct.value
  api.reading.progress(fileId, pct.value).then((r: any) => {
    if (r?.success && pct.value >= 100 && !scoredHintShown) {
      scoredHintShown = true
      ui.toast('读完了？点右上「打分」完成阅读闭环')
    }
  }).catch(() => { /* 上报失败静默，不打断阅读 */ })
}

/** 打分联动：复用 AppModal rate 弹层（两维 10 秒），带当前进度预填 */
function openRate() {
  ui.openModal('rate', { fileId, title: title.value, progress: pct.value })
}

/** 外部打开降级（Typora / Chrome），埋点 source=reader 与站内阅读并列区分 */
async function openExternal() {
  const r: any = await api.files.open(fileId, 'reader')
  ui.toast(r?.success ? '已在外部应用打开' : (r?.message || '打开失败'))
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/supply')
}
</script>

<style scoped>
.reader-wrap { margin: -18px -22px 0; height: calc(100vh - 74px); display: flex; flex-direction: column; background: var(--card); }
.reader-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex: none; }
.reader-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reader-right { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.reader-main { flex: 1; display: flex; overflow: hidden; }
.reader-toc { width: 220px; flex: none; overflow: auto; border-right: 1px solid var(--border); padding: 12px 8px; }
.toc-item { font-size: 12.5px; line-height: 1.5; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-item:hover { background: var(--hover, rgba(0,0,0,0.05)); color: var(--fg); }
.reader-frame { flex: 1; width: 100%; border: 0; background: #FAF9F6; }
.reader-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
</style>
