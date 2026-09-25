<template>
  <!-- 网页剪藏：存储目录（自动注册为扫描根，agent=webclip） -->
  <div class="sect">
    <div class="sect-head"><span class="sq"></span><h2 class="stitle">网页剪藏</h2><span class="sect-en">Web Clip</span></div>
    <div class="frow1" style="gap:10px">
      <input class="inp" style="flex:1" v-model="webclipRoot" type="text" placeholder="/Users/you/Documents/AgentFeed-WebClips（绝对路径）" aria-label="剪藏目录" />
      <button class="btn sm" :disabled="webclipSaving" @click="saveWebclipRoot">{{ webclipSaving ? '保存中…' : '保存' }}</button>
    </div>
    <div class="cap" style="margin-top:8px">
      {{ webclipCfg.storageRoot ? `当前：${webclipCfg.storageRoot}` : '未配置' }}
      · {{ webclipCfg.rootRegistered ? '已注册为扫描根' : '未注册' }}
      · Playwright {{ webclipCfg.playwrightReady ? '就绪' : '未安装' }}
    </div>
    <!-- 限额（webclip.limits）：页面/单图 MB、单页图数、导航与总时限 ms -->
    <div class="frow1" style="gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
      <label class="cap">页面 <input class="inp" style="width:76px" v-model.number="limits.pageMaxMB" type="number" min="1" aria-label="页面大小上限 MB" /> MB</label>
      <label class="cap">单图 <input class="inp" style="width:76px" v-model.number="limits.imgMaxMB" type="number" min="1" aria-label="单图大小上限 MB" /> MB</label>
      <label class="cap">单页图数 <input class="inp" style="width:76px" v-model.number="limits.imgMaxCount" type="number" min="1" aria-label="单页图片数量上限" /></label>
      <label class="cap">导航 <input class="inp" style="width:92px" v-model.number="limits.navTimeoutMs" type="number" min="1" aria-label="导航超时毫秒" /> ms</label>
      <label class="cap">总时限 <input class="inp" style="width:92px" v-model.number="limits.deadlineMs" type="number" min="1" aria-label="总时限毫秒" /> ms</label>
      <button class="btn sm" :disabled="limitsSaving" @click="saveLimits">{{ limitsSaving ? '保存中…' : '保存限额' }}</button>
    </div>
    <!-- 图片质量过滤（webclip.imageFilter，默认开启）：剔除二维码/横幅/图标等宣传图 -->
    <div class="trow" style="margin-top:10px;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="cap" style="flex:none">图片质量过滤</span>
      <button class="switch" role="switch" :aria-checked="imgFilter.enabled ? 'true' : 'false'" aria-label="图片质量过滤开关" @click="imgFilter.enabled = !imgFilter.enabled"></button>
      <label class="cap">最小边 <input class="inp" style="width:64px" :disabled="!imgFilter.enabled" v-model.number="imgFilter.minPx" type="number" min="1" aria-label="最小边像素" /> px</label>
      <label class="cap">最大宽高比 <input class="inp" style="width:64px" :disabled="!imgFilter.enabled" v-model.number="imgFilter.maxRatio" type="number" min="1" step="0.5" aria-label="最大宽高比" /></label>
      <label class="cap">最小字节 <input class="inp" style="width:76px" :disabled="!imgFilter.enabled" v-model.number="imgFilter.minBytes" type="number" min="1" aria-label="下载后最小字节数" /> B</label>
      <button class="btn sm" :disabled="imgFilterSaving" @click="saveImgFilter">{{ imgFilterSaving ? '保存中…' : '保存过滤配置' }}</button>
    </div>
    <div class="frow1" style="gap:8px;margin-top:6px" v-if="imgFilter.enabled">
      <input class="inp" style="flex:1" v-model="imgFilterUrlText" placeholder="URL 关键词（逗号分隔）：qrcode, 二维码, banner, logo…" aria-label="URL 关键词词表" />
      <input class="inp" style="flex:1" v-model="imgFilterAltText" placeholder="alt/标题关键词（逗号分隔）：点击关注, 公众号, 赞赏…" aria-label="alt 关键词词表" />
    </div>
    <div class="cap" style="margin-top:4px" v-if="imgFilter.enabled">命中任一信号即不入 md（HTML 快照不受影响）；无信号图片一律保留，词表可按需增补</div>
    <div v-if="webclipMsg" class="cap" :style="{ color: webclipMsg.ok ? 'var(--ok)' : 'var(--fail)' }">{{ webclipMsg.msg }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '../../api'

const props = defineProps<{ refreshSeq?: number }>()

const webclipRoot = ref('')
const webclipSaving = ref(false)
const webclipMsg = ref<{ ok: boolean; msg: string } | null>(null)
const webclipCfg = ref<any>({ storageRoot: null, rootRegistered: false, playwrightReady: false })
const limits = ref<Record<string, number>>({ pageMaxMB: 20, imgMaxMB: 5, imgMaxCount: 30, navTimeoutMs: 30000, deadlineMs: 45000 })
const limitsSaving = ref(false)
const imgFilter = ref<any>({ enabled: true, minPx: 80, maxRatio: 4, minBytes: 1024 })
const imgFilterUrlText = ref('')
const imgFilterAltText = ref('')
const imgFilterSaving = ref(false)

const splitList = (s: string) => s.split(/[,，]/).map(x => x.trim()).filter(Boolean)

async function loadWebclipCfg() {
  try {
    webclipCfg.value = await api.webclip.getConfig()
    webclipRoot.value = webclipCfg.value.storageRoot || ''
    if (webclipCfg.value.limits) limits.value = { ...webclipCfg.value.limits }
    if (webclipCfg.value.imageFilter) {
      const f = webclipCfg.value.imageFilter
      imgFilter.value = { enabled: !!f.enabled, minPx: f.minPx, maxRatio: f.maxRatio, minBytes: f.minBytes }
      imgFilterUrlText.value = (f.urlKeywords || []).join(', ')
      imgFilterAltText.value = (f.altKeywords || []).join(', ')
    }
  } catch { /* 网络错误静默，占位提示 */ }
}

async function saveImgFilter() {
  imgFilterSaving.value = true
  webclipMsg.value = null
  try {
    const r = await api.webclip.putImageFilter({
      enabled: !!imgFilter.value.enabled,
      minPx: Number(imgFilter.value.minPx) || 0,
      maxRatio: Number(imgFilter.value.maxRatio) || 0,
      minBytes: Number(imgFilter.value.minBytes) || 0,
      urlKeywords: splitList(imgFilterUrlText.value),
      altKeywords: splitList(imgFilterAltText.value)
    })
    if (r.success) webclipMsg.value = { ok: true, msg: '图片过滤配置已保存，下次剪藏生效' }
    else webclipMsg.value = { ok: false, msg: r.message || '图片过滤配置保存失败' }
  } catch (e: any) {
    webclipMsg.value = { ok: false, msg: `图片过滤配置保存失败：${e?.message || e}` }
  } finally {
    imgFilterSaving.value = false
  }
}

async function saveLimits() {
  limitsSaving.value = true
  webclipMsg.value = null
  try {
    const r = await api.webclip.putLimits({ ...limits.value })
    if (r.success) { limits.value = { ...r.limits }; webclipMsg.value = { ok: true, msg: '限额已保存' } }
    else webclipMsg.value = { ok: false, msg: r.message || '限额保存失败' }
  } catch (e: any) {
    webclipMsg.value = { ok: false, msg: `限额保存失败：${e?.message || e}` }
  } finally {
    limitsSaving.value = false
  }
}

async function saveWebclipRoot() {
  const v = webclipRoot.value.trim()
  if (!v) { webclipMsg.value = { ok: false, msg: '请输入绝对路径' }; return }
  webclipSaving.value = true
  webclipMsg.value = null
  try {
    const r = await api.webclip.putConfig(v)
    if (r.success) { webclipMsg.value = { ok: true, msg: '已保存并注册为扫描根（agent=webclip）' }; await loadWebclipCfg() }
    else webclipMsg.value = { ok: false, msg: r.message || '保存失败' }
  } catch (e: any) {
    webclipMsg.value = { ok: false, msg: `保存失败：${e?.message || e}` }
  } finally {
    webclipSaving.value = false
  }
}

// 父层「刷新」按钮递增 refreshSeq：重拉本 tab 配置（与各设置子面板同一机制）
watch(() => props.refreshSeq, loadWebclipCfg)

onMounted(loadWebclipCfg)
</script>
