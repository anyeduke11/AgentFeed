<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">05</span>
      <h1 class="vtitle">成品仓</h1>
      <span class="vsub">wiki 词条 · 摘要 / 要点 / 实体 / 关系</span>
      <div class="vright">
        <span class="cap mono">共 {{ wiki.total }} 条</span>
        <button class="btn sm" @click="ui.openModal('wikiImport')"><Icon name="folder" :size="13" /> 挂载外部 Wiki</button>
        <button class="btn sm" :disabled="wiki.loading" @click="reload"><Icon name="refresh" :size="13" :class="{ spin: wiki.loading }" /> 刷新</button>
      </div>
    </div>

    <div class="filterbox" style="margin-bottom:12px">
      <div class="frow1">
        <div class="search-wrap">
          <Icon name="search" :size="16" />
          <input class="inp" v-model="kw" type="text" placeholder="搜索词条标题 / 摘要" aria-label="搜索词条" />
        </div>
        <span class="cap mono">命中 {{ wiki.total }} 条</span>
      </div>
      <div class="frow-line"><span class="flabel">领域</span><div class="chips">
        <button class="chip" :class="{ on: domain === '' }" @click="domain = ''">全部</button>
        <template v-for="d in domains.tree" :key="d.id">
          <button class="chip" :class="{ on: domain === d.name }" @click="domain = d.name">{{ d.name }}</button>
          <!-- 子领域 chip：仅在筛选正落在此树的子域时显示（平时不撑长 chip 条） -->
          <template v-if="isChildSelected(d)">
            <button v-for="c in d.children" :key="c.id" class="chip sub" :class="{ on: domain === c.name }" @click="domain = c.name">{{ c.name }}</button>
          </template>
        </template>
      </div></div>
    </div>

    <div class="entry-grid">
      <!-- 词条列表 -->
      <div class="elist">
        <button v-for="e in wiki.items" :key="e.id" class="eitem" :class="{ on: currentId === e.id }" @click="select(e.id)">
          <span class="en">{{ e.source_type === 'imported' ? 'M.' + String(e.no).slice(1) : 'No.' + e.no }}</span>
          <span style="min-width:0;flex:1">
            <span style="display:flex;align-items:center;gap:6px;min-width:0">
              <span class="etit" style="flex:1">{{ e.title || '（无标题）' }}</span>
              <span v-if="e.source_type === 'imported'" class="tagchip" style="padding:0 6px;font-size:10px;flex:none">外部</span>
            </span>
            <span class="emeta">
              <span class="dot" :style="{ background: e.domain_color || 'var(--skip)' }"></span> {{ e.domain || '未分类' }}
              <span class="mono dim3">{{ fmtTime(e.distilled_at) }}</span>
              <span v-if="e.conf != null" class="mono dim3">置信 {{ e.conf }}</span>
            </span>
          </span>
        </button>
        <div v-if="!wiki.items.length && !wiki.loading" class="empty" style="border:0">
          <span class="e-ic"><Icon name="box" :size="30" /></span>
          <div class="e-t">暂无词条</div>
          <div class="e-s">完成精炼的文件会在这里生成 wiki 词条。可前往收件坪对文件执行重新蒸馏。</div>
          <router-link class="btn sm" to="/library"><Icon name="beaker" :size="14" /> 前往收件坪</router-link>
        </div>
      </div>

      <!-- 词条详情 -->
      <div v-if="detail" class="entry-panel">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="plate" style="min-width:64px">{{ detail.source_type === 'imported' ? 'M.' + String(detail.no).slice(1) : 'No.' + detail.no }}</span>
          <span v-if="detail.source_type === 'imported'" class="stb"><span class="dot" style="background:var(--wikilink)"></span>外部挂载</span>
          <span v-else class="stb"><span class="dot dot-done"></span>已蒸馏</span>
          <span v-if="detail.source_type !== 'imported'" class="mono dim3" style="font-size:11.5px">llm_state: {{ detail.llm_state || 'done' }}</span>
          <span v-else class="cap mono dim3" style="font-size:11.5px" :title="detail.path">{{ (detail.path || '').split('/').slice(0, 3).join('/') }}/…</span>
        </div>
        <h2 class="entry-title">{{ detail.title }}</h2>
        <div class="entry-meta">
          <span>来源 <b class="mono">{{ detail.agent || '—' }}</b></span>
          <span>领域 <b>{{ detail.domainPath || detail.domain || '未分类' }}</b></span>
          <span v-if="detail.conf != null">置信 <b class="mono">{{ detail.conf }}</b></span>
          <span>蒸馏于 <b class="mono">{{ fmtTime(detail.distilled_at) }}</b></span>
          <span v-if="detailTags.length" style="display:flex;gap:5px;flex-wrap:wrap">
            <span v-for="t in detailTags" :key="t.name" class="tagchip">{{ t.name }}</span>
          </span>
        </div>

        <div v-if="detail.orig_title || detail.alias" class="entry-meta" style="margin-top:-4px">
          <span v-if="detail.orig_title">原始标题 <b class="mono">{{ detail.orig_title }}</b></span>
          <span v-if="detail.alias">别名 <b class="mono">{{ detail.alias }}</b></span>
        </div>

        <div class="entry-sec">
          <div class="sect-head"><span class="sq"></span><h3 class="stitle">摘要</h3><span class="sect-en">Summary</span></div>
          <p class="entry-summary">{{ detail.summary || '（暂无摘要）' }}</p>
        </div>

        <div class="entry-sec" v-if="detail.content && !points.length">
          <div class="sect-head"><span class="sq"></span><h3 class="stitle">正文</h3><span class="sect-en">Full Text</span></div>
          <div class="mdview" v-html="mdContent"></div>
        </div>

        <div class="entry-sec" v-if="points.length">
          <div class="sect-head"><span class="sq"></span><h3 class="stitle">关键要点</h3><span class="sect-en">Key Points</span></div>
          <ul class="points">
            <li v-for="(p, i) in points" :key="i"><span class="pnum">{{ String(i + 1).padStart(2, '0') }}</span><span>{{ p.point || p.text || p }}</span></li>
          </ul>
        </div>

        <div class="entry-sec" v-if="entities.length">
          <div class="sect-head"><span class="sq"></span><h3 class="stitle">实体</h3><span class="sect-en">Entities</span></div>
          <div class="ents">
            <span v-for="(x, i) in entities" :key="i" class="ent">{{ x.name || x.n }}<span class="et">{{ x.type || x.t }}</span></span>
          </div>
        </div>

        <div class="entry-sec" v-if="relations.length">
          <div class="sect-head"><span class="sq"></span><h3 class="stitle">关系</h3><span class="sect-en">Relations</span></div>
          <div class="flows">
            <div v-for="(r, i) in relations" :key="i" class="flow">
              <span class="flownode">{{ r.source || r.a }}</span>
              <span class="flowrel"><Icon name="arrowRight" :size="18" /><span>{{ r.relation || r.v }}</span></span>
              <span class="flownode">{{ r.target || r.b }}</span>
              <span v-if="r.note" class="flow-note">（{{ r.note }}）</span>
            </div>
          </div>
        </div>

        <div class="entry-sec">
          <div class="sect-head"><span class="sq"></span><h3 class="stitle">回链（源文件）</h3><span class="sect-en">Source Link</span></div>
          <div class="pathbox">
            <span class="mono">{{ detail.path }}</span>
            <button class="btn xs" @click="copyText(detail.path)"><Icon name="copy" :size="12" /> 复制路径</button>
            <button v-if="detail.source_type !== 'imported'" class="btn xs" @click="openSource"><Icon name="external" :size="12" /> 在默认应用中打开</button>
            <span v-if="detail.source_type === 'imported' && detail.readable === false" class="cap mark-fail">⚠ 外部卷未挂载或文件已移动，正文不可读</span>
          </div>
        </div>
      </div>

      <!-- 未选中 -->
      <div v-else class="entry-panel" style="display:flex;align-items:center;justify-content:center;min-height:420px">
        <div class="empty" style="border:0">
          <span class="e-ic"><Icon name="file" :size="30" /></span>
          <div class="e-t">选择左侧词条查看详情</div>
          <div class="e-s">词条包含摘要、关键要点、实体与关系四类蒸馏产物，并保留源文件回链。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '../components/Icon.vue'
import { useWikiStore } from '../stores/useWikiStore'
import { useDomainsStore } from '../stores/useDomainsStore'
import { useUiStore } from '../stores/useUiStore'
import { api } from '../api'
import { fmtTimeRelative as fmtTime } from '../utils/format'
import { useCopyToClipboard, useDebouncedWatch } from '../composables/ui'

const route = useRoute()

const wiki = useWikiStore()
const domains = useDomainsStore()
const ui = useUiStore()

const kw = ref(typeof route.query.kw === 'string' ? route.query.kw : '')
// 领域筛选初始值来自 route query（分拣区领域卡跳转 /entry?domain=X 自动套用筛选）
const domain = ref(typeof route.query.domain === 'string' ? route.query.domain : '')
const currentId = ref<number | string | null>(null)

/** 筛选是否落在这棵一级树的子域上（决定是否展开显示子领域 chip 行） */
function isChildSelected(d: any): boolean {
  return !!d.children?.length && d.children.some((c: any) => c.name === domain.value)
}

const detail = computed(() => wiki.current)
const points = computed<any[]>(() => detail.value?.points || [])
const entities = computed<any[]>(() => detail.value?.entities || [])
const relations = computed<any[]>(() => detail.value?.relations || [])
const detailTags = computed<any[]>(() => detail.value?.tags || [])

/** 极简 markdown 渲染（外部词条正文展示用）：转义 → 常见块级/行内语法。不引入第三方依赖 */
function renderMd(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>')
  const lines = src.split(/\r?\n/)
  const out: string[] = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  // 表格：| a | b | 行 + 下一行 |---|---| 分隔线 → <table>
  const isTableRow = (s: string) => s.startsWith('|') && s.endsWith('|') && s.length > 2
  const isSepRow = (s: string) => /^\|[-\s|:]+\|$/.test(s)
  const cells = (s: string) => s.slice(1, -1).split('|').map(c => c.trim())
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    const next = (lines[i + 1] || '').trim()
    if (isTableRow(t) && isSepRow(next)) {
      closeList()
      let html = '<table class="mdtable"><thead><tr>' + cells(t).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
      i += 2
      while (i < lines.length && isTableRow(lines[i].trim())) {
        html += '<tr>' + cells(lines[i].trim()).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'
        i++
      }
      out.push(html + '</tbody></table>')
      continue
    }
    i++
    const hm = t.match(/^(#{1,4})\s+(.*)$/)
    if (hm) {
      closeList()
      out.push(`<h${hm[1].length + 1}>${inline(hm[2])}</h${hm[1].length + 1}>`)
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      closeList(); out.push('<hr />')
    } else if (/^>\s?/.test(t)) {
      closeList(); out.push(`<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`)
    } else if (/^[-*]\s+/.test(t)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(t.replace(/^[-*]\s+/, ''))}</li>`)
    } else if (/^\d+\.\s+/.test(t)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(t.replace(/^\d+\.\s+/, ''))}</li>`)
    } else if (!t) {
      closeList()
    } else {
      closeList(); out.push(`<p>${inline(t)}</p>`)
    }
  }
  closeList()
  return out.join('\n')
}

const mdContent = computed(() => (detail.value?.content ? renderMd(detail.value.content) : ''))

async function reload() {
  const params: Record<string, string> = {}
  if (kw.value.trim()) params.kw = kw.value.trim()
  if (domain.value) params.domain = domain.value
  await wiki.fetchEntries(params)
}

useDebouncedWatch(kw, reload, 350)
watch(domain, reload)
// 已在成品仓时再次从别处跳转（query 变化）→ 同步筛选并重查（watch(domain) 链式触发 reload）
watch(() => route.query.domain, (v) => {
  const d = typeof v === 'string' ? v : ''
  if (d !== domain.value) domain.value = d
})
// 智能检索纯词条跳转（/entry?kw=X）：同步搜索框并触发检索（watch(kw) 链式生效）
watch(() => route.query.kw, (v) => {
  const k = typeof v === 'string' ? v : ''
  if (k !== kw.value) kw.value = k
})

async function select(id: number | string) {
  currentId.value = id
  await wiki.fetchDetail(id)
}

const { copy: copyText } = useCopyToClipboard()

async function openSource() {
  if (!detail.value) return
  await api.files.open(detail.value.id)
  ui.toast('已调用系统默认应用打开源文件')
}

onMounted(async () => {
  await Promise.all([reload(), domains.fetchDomains()])
  if (wiki.items.length) select(wiki.items[0].id)
})
</script>
