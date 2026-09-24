<template>
  <div class="reader-wrap" :class="{ dark }">
    <div class="reader-bar">
      <button class="btn ghost sm" @click="goBack">← 返回</button>
      <button v-if="toc.length >= 3" class="btn ghost sm" @click="showToc = !showToc">{{ showToc ? '隐藏目录' : '目录' }}</button>
      <span class="reader-title">{{ title || '站内阅读' }}</span>
      <span v-if="truncated" class="cap" style="color:var(--warn)">内容超过 2MB，站内仅展示前 2MB · <a href="javascript:void(0)" style="color:inherit;text-decoration:underline" @click="openExternal">外部打开看全文</a></span>
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
      <!-- 相关阅读侧栏（I2）：同域近 30 天打开过的其他文件 top5，点击跳转同 reader 路由 -->
      <aside v-if="related.length" class="reader-related">
        <div class="rel-title">相关阅读</div>
        <button v-for="r in related" :key="r.id" class="rel-item" :title="r.title" @click="jumpRelated(r.id)">
          <span class="rel-name">{{ r.title || '#' + r.id }}</span>
          <span class="cap mono">{{ r.opens }} 次打开</span>
        </button>
      </aside>
    </div>

    <!-- 理解度检查（I3 RSI）：自问自答交互——显示 q → 看答案显 a → 答对了/答错了 → answer 接口调间隔 -->
    <div v-if="quiz.open" class="reader-quiz">
      <span class="cap" style="font-weight:700;flex:none">考考我 {{ quiz.idx + 1 }}/{{ quiz.items.length }}</span>
      <span style="font-size:13px;line-height:1.5">{{ quiz.items[quiz.idx].q }}</span>
      <template v-if="!quiz.revealed">
        <button class="btn sm primary" style="flex:none" @click="quiz.revealed = true">看答案</button>
      </template>
      <template v-else>
        <span class="cap" style="line-height:1.5">参考答案：{{ quiz.items[quiz.idx].a }}</span>
        <button class="btn sm" style="flex:none" @click="answerQuiz(true)">答对了</button>
        <button class="btn sm" style="flex:none" @click="answerQuiz(false)">答错了</button>
      </template>
      <button class="btn ghost sm" style="margin-left:auto;flex:none" @click="quiz.open = false">收起</button>
    </div>

    <!-- 轻量评分条（I2）：5 星 hover 高亮 + 一句话感受，落 read_history（历史记录语义，可重复提交） -->
    <div v-if="!loading && !err" class="reader-rate">
      <span class="cap">这篇读得如何？</span>
      <span class="rate-stars">
        <button
          v-for="n in 5" :key="n" class="rate-star" :class="{ on: n <= (hoverStar || fbRating) }"
          @mouseenter="hoverStar = n" @mouseleave="hoverStar = 0" @click="fbRating = n"
        >★</button>
      </span>
      <input v-model="fbText" class="rate-input" type="text" placeholder="一句话感受（可选）" maxlength="200" @keydown.enter="submitFeedback" />
      <button v-if="quizEnabled" class="btn sm" @click="startQuiz"><Icon name="zap" :size="13" /> 考考我</button>
      <button class="btn sm primary" :disabled="!fbRating || fbSending" @click="submitFeedback">{{ fbSending ? '提交中…' : '提交反馈' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { api } from '../api'
import { useUiStore } from '../stores/useUiStore'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

const fileId = ref(parseInt(String(route.params.id)))
const loading = ref(true)
const doc = ref('')
const title = ref('')
const filePath = ref('')
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
// 相关阅读（I2）：同域近 30 天打开过的其他文件 top5
const related = ref<Array<{ id: number; title: string; opens: number }>>([])
// 轻量评分条（I2）：5 星 + 一句话，落 read_history
const fbRating = ref(0)
const hoverStar = ref(0)
const fbText = ref('')
const fbSending = ref(false)
// 理解度检查（I3 RSI）：quizEnabled 才露出入口；自问自答交互（q → 看答案 a → 答对/答错调间隔）
const quizEnabled = ref(false)
const quiz = ref<{ open: boolean; items: Array<{ q: string; a: string }>; idx: number; revealed: boolean }>({ open: false, items: [], idx: 0, revealed: false })
let lastProgress = 0
let lastSentPct = -1
let lastSentAt = 0
let scoredHintShown = false

onMounted(() => {
  load()
  loadRelated()
  loadQuizStatus()
})
onUnmounted(() => {
  report(true)
})

// 相关阅读点击 → 同 reader 路由换文件：组件实例被复用（router-view 无 key），须监听参数变化重载
watch(() => route.params.id, (v) => {
  const next = parseInt(String(v))
  if (Number.isFinite(next) && next !== fileId.value) {
    fileId.value = next
    pct.value = 0
    lastProgress = 0
    lastSentPct = -1
    scoredHintShown = false
    toc.value = []
    showToc.value = false
    related.value = []
    fbRating.value = 0
    fbText.value = ''
    quiz.value = { open: false, items: [], idx: 0, revealed: false }
    load()
    loadRelated()
  }
})

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r = await api.files.content(fileId.value)
    if (r?.success && r.html) {
      doc.value = r.html
      title.value = r.title || ''
      filePath.value = r.path || ''
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

async function loadRelated() {
  try {
    const r = await api.reading.related(fileId.value)
    related.value = (r?.items || []).map((it: any) => ({ id: it.id, title: it.title, opens: it.opens }))
  } catch {
    related.value = []
  }
}

function jumpRelated(id: number) {
  router.push(`/reader/${id}`)
}

/** 提交阅读反馈：落 read_history（历史记录语义，允许重复提交），成功后 toast 致谢 */
async function submitFeedback() {
  if (!fbRating.value || fbSending.value) return
  fbSending.value = true
  try {
    const r: any = await api.reading.feedback(fileId.value, filePath.value, fbRating.value, fbText.value.trim() || undefined)
    if (r?.success) {
      ui.toast('感谢反馈！已记录你的阅读感受')
      fbRating.value = 0
      hoverStar.value = 0
      fbText.value = ''
    } else {
      ui.toast(r?.message || '提交失败，请重试')
    }
  } catch {
    ui.toast('提交失败，请稍后重试')
  }
  fbSending.value = false
}

/** 理解度检查（I3 RSI）：开关状态（opt-in 默认关）→ 入口按钮仅 quizEnabled 时显示 */
async function loadQuizStatus() {
  try {
    const s: any = await api.rsi.status()
    quizEnabled.value = !!s?.quizEnabled
  } catch { /* 状态读取失败保持隐藏，不影响阅读 */ }
}

/** 考考我：拉题目（3 道问答），失败按口径提示（未开启 / 无要点 / 模型格式漂移） */
async function startQuiz() {
  const r: any = await api.rsi.quiz(fileId.value)
  if (r?.success && r.questions?.length) {
    quiz.value = { open: true, items: r.questions, idx: 0, revealed: false }
    return
  }
  ui.toast(r?.error === 'quiz disabled' ? '理解度检查未开启（设置 → AI 设置）' : (r?.message || '出题失败，请稍后再试'))
}

/** 自评作答：调整间隔重复档位（答对拉长/答错缩短），答完最后一题自动收起 */
async function answerQuiz(correct: boolean) {
  const r: any = await api.rsi.answer(fileId.value, correct)
  ui.toast(r?.adjusted
    ? (correct ? '答对了 · 复习间隔已拉长' : '答错了 · 复习间隔已缩短')
    : '已记录（该篇暂无复习轮次可调整）')
  if (quiz.value.idx + 1 < quiz.value.items.length) {
    quiz.value.idx += 1
    quiz.value.revealed = false
  } else {
    quiz.value.open = false
  }
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
  api.reading.progress(fileId.value, pct.value).then((r: any) => {
    if (r?.success && pct.value >= 100 && !scoredHintShown) {
      scoredHintShown = true
      ui.toast('读完了？点右上「打分」完成阅读闭环')
    }
  }).catch(() => { /* 上报失败静默，不打断阅读 */ })
}

/** 打分联动：复用 AppModal rate 弹层（两维 10 秒），带当前进度预填 */
function openRate() {
  ui.openModal('rate', { fileId: fileId.value, title: title.value, progress: pct.value })
}

/** 外部打开降级（Typora / Chrome），埋点 source=reader 与站内阅读并列区分 */
async function openExternal() {
  const r: any = await api.files.open(fileId.value, 'reader')
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
.toc-item { font-size: 12.5px; line-height: 1.5; padding: 4px 8px; border-radius: var(--r); cursor: pointer; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-item:hover { background: var(--hover); color: var(--ink); }
.reader-frame { flex: 1; width: 100%; border: 0; background: #FAF9F6; }
.reader-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
/* 相关阅读侧栏（I2） */
.reader-related { width: 216px; flex: none; overflow: auto; border-left: 1px solid var(--border); padding: 12px 8px; display: flex; flex-direction: column; gap: 6px; }
.rel-title { font-size: 12px; font-weight: 700; color: var(--text-2); padding: 0 8px 4px; }
.rel-item { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 7px 9px; border: 1px solid var(--border); background: var(--card); border-radius: var(--r); cursor: pointer; font-size: 12.5px; transition: border-color .15s; }
.rel-item:hover { border-color: var(--ink); }
.rel-name { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 轻量评分条（I2） */
.reader-rate { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px solid var(--border); }
/* 理解度检查（I3 RSI） */
.reader-quiz { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px dashed var(--border); flex-wrap: wrap; }
.rate-stars { display: flex; gap: 2px; }
.rate-star { background: none; border: 0; padding: 0 1px; font-size: 17px; line-height: 1; color: var(--border); cursor: pointer; transition: color .1s; }
.rate-star.on { color: var(--accent); }
.rate-input { flex: 1; max-width: 420px; font-size: 12.5px; padding: 5px 9px; border: 1px solid var(--border); background: var(--card); color: var(--ink); border-radius: var(--r); }
.rate-input:focus { outline: none; border-color: var(--ink); }
</style>
