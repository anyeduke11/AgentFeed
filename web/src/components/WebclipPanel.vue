<template>
  <div class="sect webclip-panel">
    <div class="sect-head">
      <span class="sq"></span><h2 class="stitle">剪藏一个网页</h2><span class="sect-en">Web Clip</span>
      <div class="sright"><span v-if="!cfg.rootRegistered && cfg.storageRoot" class="cap mono">⚠ 剪藏目录未注册为扫描根</span></div>
    </div>

    <div v-if="!cfg.storageRoot" class="empty">
      <span class="e-t">尚未配置剪藏目录</span>
      <div class="e-s">剪藏文件需要一个存储目录（将自动注册为扫描根）。请前往「调度室 → 网页剪藏」设置。</div>
      <router-link class="btn sm" to="/settings"><Icon name="sliders" :size="14" /> 前往设置</router-link>
    </div>

    <template v-else>
      <div class="frow1" style="gap:10px">
        <div class="search-wrap" style="flex:1">
          <Icon name="external" :size="16" />
          <input class="inp" v-model="urlInput" type="text" placeholder="https:// 粘贴网页链接" :disabled="submitting" @keyup.enter="submit" aria-label="网页链接" />
        </div>
        <button class="btn sm" :disabled="submitting || !urlInput.trim()" @click="submit">
          <Icon name="inbox" :size="14" :class="{ spin: submitting }" /> {{ submitting ? '抓取中…' : '剪藏' }}
        </button>
      </div>
      <div class="frow-line" style="margin-top:8px">
        <label class="cap"><input type="checkbox" v-model="optSnapshot" /> 保存 HTML 快照（md+html 双入库）</label>
        <label class="cap" style="margin-left:16px"><input type="checkbox" v-model="optForce" /> 强制重剪</label>
        <span class="cap mono dim3" style="margin-left:auto">{{ cfg.playwrightReady ? '' : '⚠ Playwright 未就绪' }}</span>
      </div>
      <div v-if="lastResult" class="cap" :style="{ color: lastResult.ok ? 'var(--ok)' : 'var(--fail)' }">{{ lastResult.msg }}</div>

      <div class="sect-head" style="margin-top:18px">
        <span class="sq"></span><h2 class="stitle">剪藏历史</h2><span class="sect-en">History</span>
        <div class="sright">
          <div class="chips">
            <button v-for="s in ['全部', 'success', 'failed']" :key="s" class="chip" :class="{ on: statusFilter === s }" @click="setStatus(s)">{{ s === 'success' ? '成功' : s === 'failed' ? '失败' : '全部' }}</button>
          </div>
        </div>
      </div>
      <div v-if="!records.length" class="cap sect-empty">还没有剪藏记录 · 粘贴一个链接试试</div>
      <table v-else class="rtable">
        <thead><tr><th>时间</th><th>标题</th><th>URL</th><th>状态</th><th>耗时</th><th>文件</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>
          <tr v-for="r in records" :key="r.id">
            <td class="c-dim mono">{{ fmtTime(r.created_at) }}</td>
            <td class="c-main">{{ r.title || '—' }}</td>
            <td class="c-dim mono" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="r.url">{{ r.url }}</td>
            <td><span v-if="r.status === 'success'" class="stb"><span class="dot dot-done"></span>成功</span><span v-else class="stb stb-del" :title="r.error">失败</span><span class="tagchip" style="margin-left:4px" v-if="r.code && r.code !== 'busy'">{{ codeLabel(r.code) }}</span></td>
            <td class="c-dim mono">{{ r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '—' }}</td>
            <td>
              <template v-if="r.status === 'success'">
                <button v-if="r.md_file_id" class="btn xs" @click="files.openFile(r.md_file_id)">md</button>
                <button v-if="r.html_file_id" class="btn xs" style="margin-left:4px" @click="files.openFile(r.html_file_id)">html</button>
              </template>
              <button v-else-if="r.status === 'failed'" class="btn xs" :disabled="submitting" @click="retryOne(r)">重试</button>
            </td>
            <td style="text-align:right"><span class="c-dim cap mono">{{ r.error ? r.error.slice(0, 60) : '' }}</span></td>
          </tr>
        </tbody>
      </table>
      <div class="lib-foot">
        <span class="mono">共 {{ total }} 条</span><span style="flex:1"></span>
        <button class="btn xs" :disabled="page <= 1" @click="loadRecords(page - 1)">上一页</button>
        <button class="btn xs" :disabled="page * 20 >= total" @click="loadRecords(page + 1)">下一页</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api'
import { useFilesStore } from '../stores/useFilesStore'
import { fmtTime } from '../utils/format'

const files = useFilesStore()
const cfg = ref<any>({ storageRoot: null, rootRegistered: false, playwrightReady: false })
const urlInput = ref('')
const optSnapshot = ref(true)
const optForce = ref(false)
const submitting = ref(false)
const lastResult = ref<{ ok: boolean; msg: string } | null>(null)
const records = ref<any[]>([])
const statusFilter = ref('全部')
const page = ref(1)
const total = ref(0)

async function loadCfg() {
  try { cfg.value = await api.webclip.getConfig() } catch { /* 设置区会给出指引 */ }
}

async function loadRecords(p = 1) {
  page.value = p
  try {
    const r = await api.webclip.records({ page: String(p), limit: '20', status: statusFilter.value })
    records.value = r.items || []
    total.value = r.total || 0
  } catch { records.value = [] }
}

function setStatus(s: string) { statusFilter.value = s; loadRecords(1) }

async function submit() {
  const url = urlInput.value.trim()
  if (!url || submitting.value) return
  submitting.value = true
  lastResult.value = null
  try {
    const r = await api.webclip.convert({ url, snapshot: optSnapshot.value, force: optForce.value })
    if (r.success) {
      lastResult.value = { ok: true, msg: `剪藏成功（${r.durationMs ? (r.durationMs / 1000).toFixed(1) : '?'}s · 图片 ${r.images} 张），已进入蒸馏队列` }
      urlInput.value = ''
      await loadRecords(1)
    } else {
      lastResult.value = { ok: false, msg: r.message || '剪藏失败' }
      await loadRecords(1) // 失败记录也要落历史
    }
  } catch (e: any) {
    lastResult.value = { ok: false, msg: `请求失败：${e?.message || e}` }
  } finally {
    submitting.value = false
  }
}

const codeLabel = (c: string) => ({ ssrf: 'SSRF拦截', dup: '重复', fetch: '网络', notready: '未就绪', toolarge: '超大', config: '配置', busy: '忙' }[c] || c)

async function retryOne(r: any) {
  if (submitting.value) return
  submitting.value = true
  lastResult.value = null
  try {
    const res = await api.webclip.retry(r.id)
    lastResult.value = res.success
      ? { ok: true, msg: `重试成功（${res.durationMs ? (res.durationMs / 1000).toFixed(1) : '?'}s），已进入蒸馏队列` }
      : { ok: false, msg: res.message || '重试失败' }
  } catch (e: any) {
    lastResult.value = { ok: false, msg: `重试请求失败：${e?.message || e}` }
  } finally {
    submitting.value = false
    await loadRecords(page.value)
  }
}

onMounted(async () => { await loadCfg(); await loadRecords(1) })
</script>
