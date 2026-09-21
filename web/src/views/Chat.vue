<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">07</span>
      <h1 class="vtitle">对话</h1>
      <span class="vsub">人侧对话桥梁 · 回答锚定库内知识</span>
      <div class="vright">
        <button class="btn sm" @click="newChat"><Icon name="plus" :size="13" /> 新对话</button>
      </div>
    </div>

    <div class="chat-grid">
      <!-- 左栏：会话列表 -->
      <aside class="sect chat-side">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">会话</h2><div class="sright"><span class="cap mono">{{ sessions.length }}</span></div></div>
        <div class="chat-sessions">
          <button v-for="s in sessions" :key="s.sessionId" class="chat-sitem" :class="{ on: s.sessionId === sessionId }" @click="openSession(s)">
            <span class="chat-sprev">{{ s.preview || '（空会话）' }}</span>
            <span class="cap mono">{{ fmtTime(s.lastAt) }} · {{ s.msgCount }} 条</span>
          </button>
          <div v-if="!sessions.length" class="chat-side-empty">
            <span class="cap">还没有会话记录。<br>提问一次即自动留存，可随时回看。</span>
          </div>
        </div>
      </aside>

      <!-- 主区：消息流 + 输入 -->
      <section class="sect chat-main">
        <div class="chat-toolbar">
          <select v-model="domain" class="chat-domain" title="选择领域（领域陪练官人格）">
            <option value="">全部领域（通用助手）</option>
            <option v-for="d in domainOptions" :key="d.id" :value="d.name">{{ d.name }}</option>
          </select>
          <button v-for="b in SKILL_BTNS" :key="b.key" class="chip" :disabled="sending" @click="useSkill(b.key)">{{ b.label }}</button>
          <!-- 会话操作（I2）：对当前会话生成「要点 + 建议待办」复盘，落会话尾部 -->
          <button class="chip" :disabled="!sessionId || recapping || sending" :title="sessionId ? 'AI 复盘当前会话' : '先选择或发起一个会话'" @click="doRecap">
            {{ recapping ? '复盘中…' : '复盘' }}
          </button>
        </div>

        <div ref="msgsEl" class="chat-msgs">
          <!-- 空态引导 -->
          <div v-if="!msgs.length" class="chat-guide">
            <span class="chat-guide-ic mono">?</span>
            <span class="chat-guide-t">问你的知识库</span>
            <span class="chat-guide-s">回答只锚定库内已蒸馏的知识，超出范围会如实说明。引用词条可一键跳转站内阅读器。</span>
            <span class="chat-guide-s muted">· 上方选择领域，切换「领域陪练官」人格<br>· 快捷技能：解释这篇 / 串联我的阅读 / 考考我 / 领域速览</span>
          </div>

          <template v-for="(m, i) in msgs" :key="i">
            <div v-if="m.role === 'user'" class="chat-row user">
              <div class="chat-bubble user">{{ m.content }}</div>
            </div>
            <div v-else class="chat-row">
              <div class="chat-bubble assistant" :class="{ recap: m.recap }">
                <span v-if="m.recap" class="chat-recap-tag">复盘</span>
                <span class="chat-whitespace-pre">{{ m.content }}</span>
                <span v-if="m.streaming" class="chat-caret"></span>
                <span v-if="m.error" class="chat-err">{{ m.error }}</span>
                <!-- 引用词条 chips：跳站内阅读器 -->
                <div v-if="m.refs && m.refs.length" class="chat-refs">
                  <span class="cap">引用</span>
                  <button v-for="r in m.refs" :key="r.id" class="chip sm" @click="jumpRef(r.id)" :title="'阅读器打开 #' + r.id">
                    <Icon name="file" :size="12" /> {{ r.title || '#' + r.id }}
                  </button>
                </div>
                <!-- LLM 失败降级：检索列表保可用 -->
                <div v-if="m.fallback && m.fallback.length" class="chat-fallback">
                  <span class="cap">生成暂时不可用，以下为库内检索结果</span>
                  <button v-for="r in m.fallback" :key="r.id" class="chat-fb-item" @click="jumpRef(r.id)">
                    <b>{{ r.title || '#' + r.id }}</b>
                    <span class="cap">{{ r.summary }}</span>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div class="chat-inputbar">
          <input
            v-model="input"
            class="chat-input"
            type="text"
            placeholder="问点什么…（Enter 发送 / Shift+Enter 换行）"
            :disabled="sending"
            @keydown.enter.exact.prevent="send()"
          />
          <button class="btn primary" :disabled="sending || !input.trim()" @click="send()">
            {{ sending ? '回答中…' : '发送' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { useUiStore } from '../stores/useUiStore'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()

interface RefItem { id: number, title: string }
interface FallbackItem { id: number, title: string, summary: string }
interface Msg { role: 'user' | 'assistant', content: string, refs?: RefItem[], fallback?: FallbackItem[], error?: string, streaming?: boolean, recap?: boolean }

const SKILL_BTNS = [
  { key: 'explain', label: '解释这篇', dflt: '请解释这篇' },
  { key: 'connect', label: '串联我的阅读', dflt: '帮我串联最近的阅读' },
  { key: 'quiz', label: '考考我', dflt: '出 3 道题考考我' },
  { key: 'overview', label: '领域速览', dflt: '给我一段领域速览' }
] as const
type SkillKey = typeof SKILL_BTNS[number]['key']

const sessions = ref<Array<{ sessionId: string, preview: string, msgCount: number, lastAt: string }>>([])
const sessionId = ref('')
const msgs = ref<Msg[]>([])
const input = ref('')
const sending = ref(false)
const recapping = ref(false)
const domain = ref('')
const domainOptions = ref<Array<{ id: number, name: string }>>([])
const msgsEl = ref<HTMLElement | null>(null)

const skillFileId = computed(() => {
  const q = parseInt(String(route.query.fileId || ''))
  return Number.isFinite(q) ? q : undefined
})

function fmtTime(t?: string) {
  if (!t) return ''
  return String(t).slice(5, 16).replace('T', ' ')
}

function scrollBottom() {
  nextTick(() => { if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight })
}

async function loadSessions() {
  try {
    const r = await api.chat.sessions()
    sessions.value = r.sessions || []
  } catch { sessions.value = [] }
}

async function loadDomains() {
  try {
    const tree = await api.domains.list()
    const flat: Array<{ id: number, name: string }> = []
    const walk = (nodes: any[]) => {
      for (const n of nodes || []) {
        flat.push({ id: n.id, name: n.name })
        if (n.children?.length) walk(n.children)
      }
    }
    walk(tree)
    domainOptions.value = flat
  } catch { domainOptions.value = [] }
}

function newChat() {
  sessionId.value = ''
  msgs.value = []
  input.value = ''
}

/** 回放消息映射：assistant 且 content 带 `[复盘] ` 前缀 → 剥前缀 + recap 标记（不同样式显示） */
function mapMessages(messages: Array<{ role: string, content: string }>): Msg[] {
  return (messages || []).map(m => {
    const recap = m.role !== 'user' && m.content.startsWith('[复盘]')
    return { role: m.role === 'user' ? 'user' : 'assistant', content: recap ? m.content.replace(/^\[复盘\]\s*/, '') : m.content, recap }
  })
}

async function openSession(s: { sessionId: string }) {
  if (sending.value) return
  sessionId.value = s.sessionId
  try {
    const r = await api.chat.sessionDetail(s.sessionId)
    msgs.value = mapMessages(r.messages || [])
    scrollBottom()
  } catch {
    ui.toast('会话加载失败')
  }
}

/** 刷新当前会话消息（复盘落库后回放用） */
async function refreshSession() {
  try {
    const r = await api.chat.sessionDetail(sessionId.value)
    msgs.value = mapMessages(r.messages || [])
    scrollBottom()
  } catch { /* 保留现有消息，回放失败不额外打扰 */ }
}

/** 会话复盘（I2）：后端拉全量消息 → LLM 生成「要点 + 建议待办」落会话尾部 → 刷新回放 */
async function doRecap() {
  if (!sessionId.value || recapping.value) return
  recapping.value = true
  try {
    const r: any = await api.chat.recap(sessionId.value)
    if (r?.success) {
      ui.toast('复盘已生成')
      await refreshSession()
    } else {
      ui.toast(r?.message || '复盘生成失败，请稍后重试')
    }
  } catch {
    ui.toast('复盘生成失败，请稍后重试')
  }
  recapping.value = false
}

function jumpRef(id: number) {
  router.push(`/reader/${id}`)
}

/** skill 快捷键：无输入时用预设问题；explain 附当前路由 query.fileId（可选） */
function useSkill(key: SkillKey) {
  if (sending.value) return
  const b = SKILL_BTNS.find(x => x.key === key)!
  if (!input.value.trim()) input.value = b.dflt
  send(key)
}

/** 发送 + SSE 流式读取（fetch POST + res.body.getReader() 解析 `data: ` 帧） */
async function send(skill?: SkillKey) {
  const message = input.value.trim()
  if (!message || sending.value) return
  sending.value = true
  input.value = ''
  msgs.value.push({ role: 'user', content: message })
  const a: Msg = { role: 'assistant', content: '', refs: [], streaming: true }
  msgs.value.push(a)
  scrollBottom()
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        domain: domain.value || undefined,
        sessionId: sessionId.value || undefined,
        skill,
        fileId: skill === 'explain' ? skillFileId.value : undefined
      })
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const line = frame.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        handleEvent(JSON.parse(line.slice(6)), a)
      }
    }
  } catch (e: any) {
    if (!a.content && !a.fallback) a.error = '请求失败：' + String(e?.message || e)
  } finally {
    a.streaming = false
    sending.value = false
    scrollBottom()
    loadSessions()
  }
}

function handleEvent(ev: any, a: Msg) {
  if (ev.type === 'meta') {
    a.refs = ev.refs || []
  } else if (ev.type === 'delta') {
    a.content += ev.text
    scrollBottom()
  } else if (ev.type === 'done') {
    if (ev.sessionId) sessionId.value = ev.sessionId
  } else if (ev.type === 'fallback') {
    a.fallback = ev.results || []
    a.refs = []
  } else if (ev.type === 'error') {
    a.error = String(ev.message || '生成失败')
  }
}

onMounted(() => {
  loadSessions()
  loadDomains()
})
</script>

<style scoped>
.chat-grid { display: grid; grid-template-columns: 240px 1fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .chat-grid { grid-template-columns: 1fr; } }

/* 左栏会话列表 */
.chat-side { display: flex; flex-direction: column; max-height: calc(100vh - 150px); }
.chat-sessions { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.chat-sitem { display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 8px 10px; border: 1px solid var(--border); background: var(--card); border-radius: var(--r); cursor: pointer; transition: border-color .15s, background .15s; }
.chat-sitem:hover { border-color: var(--ink); }
.chat-sitem.on { border-color: var(--ink); background: var(--bg-2); }
.chat-sprev { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-side-empty { padding: 18px 10px; text-align: center; }

/* 主区 */
.chat-main { display: flex; flex-direction: column; height: calc(100vh - 150px); min-height: 420px; }
.chat-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.chat-domain { font-size: 12.5px; padding: 4px 8px; border: 1px solid var(--border); background: var(--card); color: var(--ink); border-radius: var(--r); max-width: 180px; }

.chat-msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.chat-row { display: flex; }
.chat-row.user { justify-content: flex-end; }
.chat-bubble { max-width: 78%; padding: 9px 12px; font-size: 13px; line-height: 1.65; border-radius: var(--r); }
.chat-bubble.user { background: var(--ink); color: var(--on-ink); white-space: pre-wrap; }
.chat-bubble.assistant { background: var(--bg-2); border: 1px solid var(--border); }
.chat-bubble.assistant.recap { border-style: dashed; border-color: #B48A3C; background: rgba(232, 163, 61, 0.06); }
.chat-recap-tag { display: inline-block; font-size: 11px; font-weight: 700; color: #B48A3C; border: 1px solid #B48A3C; border-radius: var(--r); padding: 0 5px; margin-bottom: 4px; }
.chat-whitespace-pre { white-space: pre-wrap; }
.chat-caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; vertical-align: -2px; background: var(--ink); animation: chat-blink 1s steps(2) infinite; }
@keyframes chat-blink { 50% { opacity: 0; } }
.chat-err { display: block; margin-top: 6px; color: var(--fail); font-size: 12.5px; }

/* 引用 chips */
.chat-refs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
/* LLM 失败降级列表 */
.chat-fallback { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.chat-fb-item { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 7px 9px; border: 1px solid var(--border); background: var(--card); border-radius: var(--r); cursor: pointer; font-size: 12.5px; }
.chat-fb-item:hover { border-color: var(--ink); }

/* 空态引导 */
.chat-guide { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; max-width: 460px; padding: 24px 12px; }
.chat-guide-ic { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: var(--ink); color: var(--on-ink); border-radius: var(--r); font-size: 18px; font-weight: 700; }
.chat-guide-t { font-size: 15px; font-weight: 700; }
.chat-guide-s { font-size: 12.5px; color: var(--text-2); line-height: 1.8; }

/* 输入条 */
.chat-inputbar { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.chat-input { flex: 1; font-size: 13px; padding: 8px 10px; border: 1px solid var(--border); background: var(--card); color: var(--ink); border-radius: var(--r); }
.chat-input:focus { outline: none; border-color: var(--ink); }
</style>
