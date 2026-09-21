<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">03</span>
      <h1 class="vtitle">分拣区</h1>
      <span class="vsub">领域树与标签治理</span>
      <div class="vright">
        <button class="btn sm primary" @click="ui.openModal('domain')"><Icon name="plus" :size="13" /> 新增领域</button>
      </div>
    </div>

    <div class="domgrid" v-if="domains.tree.length">
      <div v-for="d in domains.tree" :key="d.id" class="domcard">
        <div class="domband" :style="{ background: d.color || '#2456A6' }"></div>
        <div class="dom-in">
          <div class="dom-top">
            <span class="domname">{{ d.name }}</span>
            <button v-if="d.children?.length" class="btn ghost icon-btn" @click="domains.toggleOpen(d.id)" aria-label="展开或收起子领域" title="展开 / 收起">
              <Icon :name="isOpen(d.id) ? 'chevronDown' : 'chevronRight'" :size="15" />
            </button>
          </div>
          <div class="domcount">{{ total(d) }}</div>
          <div class="dom-sub">有效文件{{ d.children?.length ? '（含子领域）' : '' }}</div>

          <div v-if="d.children?.length && isOpen(d.id)" class="dom-children">
            <div v-for="c in d.children" :key="c.id" class="domchild">
              <span class="dot" :style="{ background: c.color || '#2456A6' }"></span>
              <span class="dc-name">{{ c.name }}</span>
              <span class="dc-count">{{ c.count }}</span>
              <button class="btn ghost icon-btn" @click="editDomain(c)" title="编辑名称" :aria-label="`编辑 ${c.name}`"><Icon name="edit" :size="13" /></button>
              <button class="btn ghost icon-btn" @click="editDomain(c)" title="更换配色" :aria-label="`更换 ${c.name} 配色`"><Icon name="droplet" :size="13" /></button>
              <button class="btn ghost icon-btn" @click="delDomain(c)" title="删除" :aria-label="`删除 ${c.name}`"><Icon name="trash" :size="13" /></button>
            </div>
          </div>
        </div>
        <div class="dom-acts">
          <button class="btn ghost icon-btn" @click="editDomain(d)" title="编辑名称" aria-label="编辑领域"><Icon name="edit" :size="13" /></button>
          <button class="btn ghost icon-btn" @click="editDomain(d)" title="更换配色" aria-label="更换配色"><Icon name="droplet" :size="13" /></button>
          <button class="btn ghost icon-btn" :disabled="isFirst(d.id)" @click="domains.move(d.id, -1)" title="上移" aria-label="上移"><Icon name="up" :size="13" /></button>
          <button class="btn ghost icon-btn" :disabled="isLast(d.id)" @click="domains.move(d.id, 1)" title="下移" aria-label="下移"><Icon name="down" :size="13" /></button>
          <button class="btn ghost icon-btn" @click="delDomain(d)" title="删除" aria-label="删除领域"><Icon name="trash" :size="13" /></button>
        </div>
      </div>
    </div>
    <div v-else class="empty">
      <span class="e-ic"><Icon name="grid" :size="30" /></span>
      <div class="e-t">尚无领域</div>
      <div class="e-s">创建一级领域后，可在收件坪将文件批量归类到领域。</div>
      <button class="btn sm primary" @click="ui.openModal('domain')"><Icon name="plus" :size="13" /> 新增领域</button>
    </div>

    <div class="tagzone">
      <!-- 标签墙 -->
      <div class="sect">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">标签墙</h2>
          <div class="sright"><span class="cap mono">共 {{ tagTotal }} 个</span></div>
        </div>
        <div class="ttools">
          <input class="inp tsearch" v-model="kw" placeholder="搜索标签…" @input="onKwInput" />
          <button class="chip" :class="{ on: chip === 'primary' }" @click="setChip('primary')" title="一级 = 关键领域，挂靠领域树，用于内容标记">主要（一级）</button>
          <button class="chip" :class="{ on: chip === 'secondary' }" @click="setChip('secondary')" title="二级 = 次要关键领域，仍参与标记，视觉降级">次要（二级）</button>
          <button class="chip" :class="{ on: chip === 'normal' }" @click="setChip('normal')" title="普通标签（新建默认），可经治理选拔升为一级 / 二级">普通</button>
          <button class="chip" :class="{ on: chip === 'all' }" @click="setChip('all')">全部有效</button>
          <button class="chip" :class="{ on: chip === 'retired' }" @click="setChip('retired')">已停用</button>
          <button class="btn ghost icon-btn" @click="loadTags(true)" title="刷新" aria-label="刷新标签"><Icon name="refresh" :size="14" /></button>
        </div>
        <div class="trow mergebar" v-if="merging">
          <span class="cap">正在合并「<b>{{ merging.name }}</b>」：点击墙上任一标签作为合并目标</span>
          <button class="btn xs" @click="merging = null">取消合并</button>
        </div>
        <div class="trow mergebar" v-if="pickingParent">
          <span class="cap">正在将「<b>{{ pickingParent.name }}</b>」设为次要：点击墙上任一<b>一级</b>标签作为挂靠父级</span>
          <button class="btn xs" @click="pickingParent = null">取消</button>
        </div>
        <div class="tagwall" :class="{ picking: !!merging || !!pickingParent }">
          <span v-for="t in wallTags" :key="t.id" class="tagc tagpick" :class="{ sel: selected?.id === t.id, src: merging?.id === t.id, sec: t.level === 'secondary' }"
            :title="merging ? `点击将「${merging.name}」合并进「${t.name}」` : (t.level === 'primary' ? `领域标签（同名领域对齐）· 挂载 ${t.file_count ?? 0} 篇` : `来源：${sourceLabel(t.source)} · 挂载 ${t.file_count ?? 0} 篇`)" @click="wallClick(t)">
            <span class="dot" :style="{ background: t.level === 'primary' && t.domain_color ? t.domain_color : sourceColor(t.source) }"></span>{{ t.name }}
            <i class="pn" v-if="t.level === 'secondary' && t.parent_name">{{ t.parent_name }}</i>
            <span class="cnt mono">{{ t.file_count ?? 0 }}</span>
            <span class="tacts" v-if="t.status !== 'retired'" @click.stop>
              <button class="ta-btn" title="合并到其他标签（点击后选择目标）" :aria-label="`合并 ${t.name}`" @click="startMerge(t)"><Icon name="arrowRight" :size="11" /></button>
              <button class="ta-btn ta-x" title="停用（不再用于内容标记，可恢复）" :aria-label="`停用 ${t.name}`" @click="quickRetire(t)"><Icon name="x" :size="11" /></button>
            </span>
          </span>
          <span v-if="!tags.length && !loading" class="cap">暂无标签。入库自动标注、手动添加或调整上方筛选后会显示在这里。</span>
        </div>
        <div class="tmore" v-if="tags.length < tagTotal">
          <button class="btn sm" :disabled="loading" @click="loadTags(false)">
            加载更多（已显示 {{ tags.length }} / {{ tagTotal }}）
          </button>
        </div>
        <div class="legend">
          <span class="lg"><span class="dot dot-ink"></span>规则自动</span>
          <span class="lg"><span class="dot" style="background:#2456A6"></span>手动添加</span>
          <span class="lg"><span class="dot" style="background:#1E8E5A"></span>蒸馏生成</span>
          <span class="lg muted">一级 = 领域（与同名领域对齐，色带同源）；二级 = 一级的子标签（树形挂靠，仍参与标记）；普通 = 其余标签；父级合并/停用后子标签回落「未挂靠」</span>
        </div>
      </div>

      <!-- 标签树：一级 → 二级 树形关联 -->
      <div class="sect">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">标签树</h2>
          <div class="sright cap mono">挂靠 {{ attachedSecCount }} 个二级 · 未挂靠 {{ orphanSecondary.length }} 个</div>
        </div>
        <div class="tagtree" v-if="tagTree.length || orphanSecondary.length">
          <div v-for="node in tagTree" :key="node.id" class="tt-node">
            <div class="tt-parent">
              <span class="tagc tagpick" :title="`领域「${node.name}」· 查看标签详情`" @click="openTag(node)"><span class="dot" :style="{ background: node.domain_color || '#2456A6' }"></span>{{ node.name }} <span class="cnt mono">{{ node.file_count ?? 0 }}</span></span>
            </div>
            <div class="tt-children">
              <span v-for="c in node.children" :key="c.id" class="tagc sec tagpick" :title="`查看「${c.name}」详情`" @click="openTag(c)">{{ c.name }} <span class="cnt mono">{{ c.file_count ?? 0 }}</span></span>
            </div>
          </div>
          <div class="tt-node" v-if="orphanSecondary.length">
            <div class="tt-parent"><span class="tagc sec">未挂靠</span></div>
            <div class="tt-children">
              <span v-for="c in orphanSecondary" :key="c.id" class="tagc sec tagpick" :title="`查看「${c.name}」详情，可在详情面板补挂父级`" @click="openTag(c)">{{ c.name }} <span class="cnt mono">{{ c.file_count ?? 0 }}</span></span>
            </div>
          </div>
        </div>
        <div class="cap" style="padding:0 14px 12px" v-else>暂无树形关联：接受「AI 二级选拔」提案或在详情面板把标签设为次要并挂靠到一级后，会在这里展示。</div>
      </div>

      <!-- 标签详情 -->
      <div class="sect" v-if="selected">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">标签详情</h2>
          <div class="sright"><button class="btn ghost icon-btn" @click="selected = null" aria-label="关闭详情"><Icon name="x" :size="14" /></button></div>
        </div>
        <div class="tdetail">
          <div class="trow">
            <input class="inp" style="max-width:280px" v-model="editName" @keyup.enter="saveName" />
            <button class="btn sm" @click="saveName">保存改名</button>
            <span style="flex:1"></span>
            <span class="cap mono">挂载 {{ selected.file_count ?? 0 }} 篇</span>
            <template v-if="selected.status === 'retired'">
              <span class="chip">已停用</span>
              <button class="btn sm" @click="restoreOp">恢复使用</button>
            </template>
            <template v-else>
              <button class="chip" :class="{ on: selected.level === 'primary' }" @click="setLevelOp('primary')" title="一级即领域：与同名领域自动对齐，无同名领域时自动创建">主要（一级）</button>
              <button class="chip" :class="{ on: selected.level === 'secondary' }" @click="setLevelOp('secondary')" title="二级 = 一级的子标签，树形挂靠某个一级标签，仍参与标记">次要（二级）</button>
              <button class="chip" :class="{ on: selected.level === 'normal' }" @click="setLevelOp('normal')" title="普通 = 日常标记标签，可随时选拔升级">普通</button>
              <button class="btn sm danger" @click="retireOp">停用</button>
            </template>
          </div>
          <div class="trow" v-if="selected.status !== 'retired' && selected.level === 'secondary'">
            <span class="cap">挂靠一级：</span>
            <span class="tagc" :class="{ sec: !selected.parent_name }">{{ selected.parent_name || '未挂靠' }}</span>
            <input class="inp" style="max-width:200px" v-model="parentKw" placeholder="搜索一级标签补挂 / 换父" @keyup.enter="findParentCands" />
            <button class="btn sm" @click="findParentCands">查找</button>
            <span v-for="c in parentCands" :key="c.id" class="tagc tagpick" :title="`点击挂靠到「${c.name}」`" @click="attachParent(c)">
              <Icon name="check" :size="12" /> {{ c.name }} <span class="cnt mono">{{ c.file_count ?? 0 }}</span>
            </span>
          </div>
          <div class="trow" v-if="selected.status !== 'retired'">
            <span class="cap">合并到：</span>
            <input class="inp" style="max-width:220px" v-model="mergeKw" placeholder="输入目标标签名搜索" @keyup.enter="findMergeCands" />
            <button class="btn sm" @click="findMergeCands">查找</button>
            <span v-for="c in mergeCands" :key="c.id" class="tagc tagpick" :title="`点击合并进「${c.name}」`" @click="mergeInto(c)">
              <Icon name="arrowRight" :size="12" /> {{ c.name }} <span class="cnt mono">{{ c.file_count ?? 0 }}</span>
            </span>
          </div>
          <div class="trow" v-if="related.length">
            <span class="cap">常一起出现：</span>
            <span v-for="r in related" :key="r.id" class="tagc tagpick" :title="`共现 ${r.cnt} 次，点击查看`" @click="openTag({ status: 'active', level: r.level, file_count: r.cnt, ...r })">
              {{ r.name }} <span class="cnt mono">{{ r.cnt }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 标签治理 -->
      <div class="sect">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">标签治理</h2>
          <div class="sright cap">收敛 · 分级 · 审计（AI 建议，人工确认后生效）</div>
        </div>
        <div class="gov">
          <div class="trow">
            <button class="btn sm" :disabled="!!scan.running" @click="runNormalize" title="全半角/大小写/空格变体的确定性归并，同步完成"><Icon name="zap" :size="13" /> 规则归一</button>
            <button class="btn sm" :disabled="!!scan.running" @click="runScan('semantic')" title="AI 语义相似度归组，产出合并建议"><Icon name="activity" :size="13" /> AI 语义归组</button>
            <button class="btn sm" :disabled="!!scan.running" @click="runScan('level')" title="AI 从高频普通标签中挑具备领域概念的，产出设为二级领域的建议"><Icon name="filter" :size="13" /> AI 二级选拔</button>
            <span class="cap">规则归一自动生效；AI 扫描后台执行，结果进入待审建议</span>
          </div>
          <div class="trow" v-if="scan.running">
            <span class="cap mono">{{ scan.running === 'semantic' ? 'AI 语义归组' : 'AI 二级选拔' }}进行中：{{ scan.done }}/{{ scan.total }} {{ scan.message }}</span>
          </div>
          <div class="trow" v-else-if="scan.lastError">
            <span class="cap" style="color:var(--fail)">上次扫描出错：{{ scan.lastError }}</span>
          </div>

          <div class="statgrid" v-if="stats">
            <div class="statc"><b class="mono">{{ stats.total }}</b><span>标签总数</span></div>
            <div class="statc"><b class="mono">{{ stats.active }}</b><span>有效</span></div>
            <div class="statc" title="一级关键领域，挂靠领域树"><b class="mono">{{ stats.primary }}</b><span>主要（一级）</span></div>
            <div class="statc" title="二级次要领域，仍参与标记"><b class="mono">{{ stats.secondary }}</b><span>次要（二级）</span></div>
            <div class="statc" title="普通标签（新建默认），可经治理选拔升级"><b class="mono">{{ stats.normal }}</b><span>普通</span></div>
            <div class="statc"><b class="mono">{{ stats.merged }}</b><span>已合并</span></div>
            <div class="statc"><b class="mono">{{ stats.retired }}</b><span>已停用</span></div>
            <div class="statc"><b class="mono">{{ stats.orphan }}</b><span>零挂载</span></div>
          </div>
          <div class="trow" v-if="stats?.trend?.length">
            <span class="cap" style="width:64px;flex:none">新增趋势<br />（15天/格）</span>
            <div class="trend">
              <div v-for="t in stats.trend" :key="t.month" class="bar" :title="`${t.month} 起 15 天新增 ${t.newTags} 个标签`">
                <b class="mono">{{ t.newTags }}</b><i :style="{ height: trendH(t.newTags) }"></i><em>{{ t.month }}</em>
              </div>
            </div>
          </div>

          <details>
            <summary>待审建议（{{ proposals.length }}）—— 语义归组合并 / 二级领域选拔</summary>
            <div>
              <div v-if="!proposals.length" class="cap">暂无待审建议。运行 AI 语义归组 / 二级选拔后，结果会在这里逐条确认。</div>
              <div v-for="p in proposals" :key="p.id" class="pcard">
                <div class="trow">
                  <span class="chip on">{{ p.kind === 'semantic' ? '语义归组' : '二级选拔' }}</span>
                  <span class="cap mono">{{ p.created_at }}</span>
                  <span style="flex:1"></span>
                  <button class="btn xs primary" @click="acceptProposal(p)"><Icon name="check" :size="12" /> 接受</button>
                  <button class="btn xs" @click="rejectProposal(p)"><Icon name="x" :size="12" /> 驳回</button>
                </div>
                <div v-if="p.kind === 'semantic'" class="trow">
                  <span class="tagc"><span class="dot" style="background:#1E8E5A"></span>{{ p.canonical }}</span>
                  <span class="cap">← 合并</span>
                  <span class="trow">
                    <span v-for="m in pMembers(p.members).filter(n => n !== p.canonical)" :key="m" class="tagc">{{ m }}</span>
                  </span>
                </div>
                <div v-else class="trow">
                  <span class="cap">设为次要领域：</span>
                  <span v-for="m in pMembers(p.members)" :key="m" class="tagc">{{ m }}</span>
                </div>
                <div class="cap" v-if="p.reason">{{ p.reason }}</div>
              </div>
            </div>
          </details>

          <details @toggle="onOpsToggle">
            <summary>操作审计（最近 {{ ops.length }} 条）</summary>
            <div class="opslist">
              <div v-if="!ops.length" class="cap">暂无记录。</div>
              <div v-for="o in ops" :key="o.id" class="opline mono">{{ o.created_at }} · {{ o.op }} · {{ o.detail }}</div>
            </div>
          </details>

          <div class="trow">
            <span class="cap">数据：</span>
            <button class="btn sm" @click="doExport('json')">导出 JSON</button>
            <button class="btn sm" @click="doExport('csv')">导出 CSV</button>
            <button class="btn sm" @click="importFile?.click()">导入 JSON</button>
            <input ref="importFile" type="file" accept=".json,application/json" style="display:none" @change="onImportFile" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { useDomainsStore } from '../stores/useDomainsStore'
import { useUiStore } from '../stores/useUiStore'
import { api } from '../api'

const domains = useDomainsStore()
const ui = useUiStore()

const isOpen = (id: number) => domains.domOpen[id] !== false
const total = (d: any) => d.total ?? d.count ?? 0

function isFirst(id: number) {
  return domains.tree[0]?.id === id
}
function isLast(id: number) {
  return domains.tree[domains.tree.length - 1]?.id === id
}

function editDomain(d: any) {
  ui.openModal('domain', { mode: 'edit', id: d.id })
}
function delDomain(d: any) {
  ui.openModal('domdel', { id: d.id })
}

function sourceColor(s?: string) {
  return s === 'manual' ? '#2456A6' : s === 'llm' ? '#1E8E5A' : '#14181B'
}
function sourceLabel(s?: string) {
  return s === 'manual' ? '手动添加' : s === 'llm' ? '蒸馏生成' : '规则自动'
}

// ---- 标签墙 ----
const tags = ref<any[]>([])
const tagTotal = ref(0)
const kw = ref('')
const chip = ref<'primary' | 'secondary' | 'normal' | 'all' | 'retired'>('primary')
const loading = ref(false)
const LIMIT = 200

// 墙上渲染列表：挂靠父级选拔中只显示可作父级的一级标签
const wallTags = computed(() => pickingParent.value ? tags.value.filter((t: any) => t.level === 'primary') : tags.value)

function chipParams(): Record<string, string> {
  if (chip.value === 'retired') return { status: 'retired' }
  const p: Record<string, string> = { status: 'active' }
  if (chip.value !== 'all') p.level = chip.value
  return p
}

async function loadTags(reset = true) {
  loading.value = true
  try {
    const params = chipParams()
    params.sort = 'count'
    params.limit = String(LIMIT)
    params.offset = reset ? '0' : String(tags.value.length)
    if (kw.value.trim()) params.kw = kw.value.trim()
    const r = await api.tags.list(params)
    tags.value = reset ? r.items || [] : tags.value.concat(r.items || [])
    tagTotal.value = r.total || 0
  } catch { ui.toast('标签加载失败') } finally { loading.value = false }
}

let kwTimer: ReturnType<typeof setTimeout> | null = null
function onKwInput() {
  if (kwTimer) clearTimeout(kwTimer)
  kwTimer = setTimeout(() => loadTags(true), 300)
}
function setChip(c: typeof chip.value) {
  chip.value = c
  loadTags(true)
}

// ---- 标签详情 ----
const selected = ref<any>(null)
const editName = ref('')
const related = ref<any[]>([])
const mergeKw = ref('')
const mergeCands = ref<any[]>([])
// ---- 二级挂靠：手动点选一级父标签（树形关联） ----
const pickingParent = ref<any>(null)
const parentKw = ref('')
const parentCands = ref<any[]>([])
// ---- 标签树：全量 active 标签按 parent_tag_id 组树 ----
const treeTags = ref<any[]>([])
const tagTree = computed(() => {
  const kids = treeTags.value.filter((t: any) => t.level === 'secondary' && t.parent_tag_id)
  return treeTags.value
    .filter((t: any) => t.level === 'primary')
    .map((p: any) => ({ ...p, children: kids.filter((k: any) => k.parent_tag_id === p.id) }))
    .filter((p: any) => p.children.length)
})
const orphanSecondary = computed(() => treeTags.value.filter((t: any) => t.level === 'secondary' && !t.parent_tag_id))
const attachedSecCount = computed(() => treeTags.value.filter((t: any) => t.level === 'secondary' && t.parent_tag_id).length)

async function openTag(t: any) {
  if (selected.value?.id === t.id) { selected.value = null; return }
  selected.value = { status: 'active', level: 'primary', file_count: 0, ...t }
  editName.value = t.name
  mergeKw.value = ''
  mergeCands.value = []
  parentKw.value = ''
  parentCands.value = []
  try { related.value = await api.tags.related(t.id) } catch { related.value = [] }
}

// ---- 标签墙快捷操作：合并（点选目标）/ 停用 ----
const merging = ref<any>(null)

function wallClick(t: any) {
  if (pickingParent.value) { quickAttach(t); return }
  if (merging.value) { quickMerge(t); return }
  openTag(t)
}

function startMerge(t: any) {
  merging.value = t
  ui.toast(`请点击目标标签，将「${t.name}」合并进去`)
}

async function quickMerge(dst: any) {
  const src = merging.value
  if (!src) return
  if (dst.id === src.id) return ui.toast('合并目标不能是自身')
  merging.value = null
  const r = await api.tags.merge(src.id, dst.id)
  if (r.success === false) return ui.toast(r.message || '合并失败')
  ui.toast(`已合并「${src.name}」→「${dst.name}」，转移 ${r.moved} 处挂载`)
  if (selected.value?.id === src.id) selected.value = null
  loadTags(true)
  loadGov()
}

async function quickRetire(t: any) {
  const r = await api.tags.retire(t.id)
  if (r.success === false) return ui.toast(r.message || '停用失败')
  ui.toast(`已停用「${t.name}」，可在「已停用」筛选中恢复`)
  if (selected.value?.id === t.id) selected.value = null
  loadTags(true)
  loadGov()
}

// 点选一级父标签，把「选拔中」的标签树形挂靠进去
async function quickAttach(parent: any) {
  const child = pickingParent.value
  if (!child) return
  if (parent.id === child.id) return ui.toast('不能挂靠到自身')
  if (parent.level !== 'primary') return ui.toast('只能挂靠到一级标签')
  pickingParent.value = null
  const r = await api.tags.update(child.id, { level: 'secondary', parentTagId: parent.id })
  if (r.success === false) return ui.toast(r.message || '挂靠失败')
  ui.toast(`已将「${child.name}」挂靠到「${parent.name}」`)
  if (selected.value?.id === child.id) { selected.value.level = 'secondary'; selected.value.parent_name = parent.name }
  loadTags(true)
  loadGov()
}

async function saveName() {
  const name = editName.value.trim()
  if (!name || !selected.value || name === selected.value.name) return
  const r = await api.tags.update(selected.value.id, { name })
  if (r.success === false) return ui.toast(r.message || '保存失败')
  selected.value.name = name
  ui.toast('已改名')
  loadTags(true)
}

async function setLevelOp(level: 'primary' | 'secondary' | 'normal') {
  // 二级强制挂靠：进入父级选拔模式，点选墙上一级标签后携带 parentTagId 提交
  if (level === 'secondary') {
    if (selected.value.level === 'secondary') return
    pickingParent.value = selected.value
    parentKw.value = ''
    parentCands.value = []
    ui.toast(`请点击墙上任一一级标签，将「${selected.value.name}」挂靠进去`)
    return
  }
  const r = await api.tags.update(selected.value.id, { level })
  if (r.success === false) return ui.toast(r.message || '操作失败')
  // 升级一级回显服务端分析：同名领域挂靠提示 + 现有一级格局中的量级排名（门禁透明化）
  if (level === 'primary') {
    const notes: string[] = Array.isArray(r.warnings) ? r.warnings : []
    if (r.analysis) notes.push(`挂载 ${r.analysis.mounts} 次，在现有 ${r.analysis.totalPrimaries} 个领域中排第 ${r.analysis.rank}`)
    if (notes.length) ui.toast(notes.join('；'))
  }
  selected.value.level = level
  selected.value.parent_name = null
  const row = tags.value.find((x: any) => x.id === selected.value.id)
  if (row) { row.level = level; row.parent_name = null }
  loadGov()
}

async function retireOp() {
  const r = await api.tags.retire(selected.value.id)
  if (r.success === false) return ui.toast(r.message || '停用失败')
  ui.toast('已停用，不再用于内容标记')
  selected.value = null
  loadTags(true)
  loadGov()
}

async function restoreOp() {
  const r = await api.tags.restore(selected.value.id)
  if (r.success === false) return ui.toast(r.message || '恢复失败')
  ui.toast('已恢复为有效标签')
  selected.value = null
  loadTags(true)
  loadGov()
}

async function findMergeCands() {
  const k = mergeKw.value.trim()
  if (!k) return
  try {
    const r = await api.tags.list({ kw: k, status: 'active', limit: '10' })
    mergeCands.value = (r.items || []).filter((x: any) => x.id !== selected.value.id)
  } catch { mergeCands.value = [] }
}

async function mergeInto(dst: any) {
  const r = await api.tags.merge(selected.value.id, dst.id)
  if (r.success === false) return ui.toast(r.message || '合并失败')
  ui.toast(`已合并进「${dst.name}」，转移 ${r.moved} 处挂载`)
  selected.value = null
  loadTags(true)
  loadGov()
}

async function findParentCands() {
  const k = parentKw.value.trim()
  if (!k) return
  try {
    const r = await api.tags.list({ kw: k, status: 'active', level: 'primary', limit: '10' })
    parentCands.value = (r.items || []).filter((x: any) => x.id !== selected.value.id)
  } catch { parentCands.value = [] }
}

async function attachParent(c: any) {
  const r = await api.tags.update(selected.value.id, { level: 'secondary', parentTagId: c.id })
  if (r.success === false) return ui.toast(r.message || '挂靠失败')
  ui.toast(`已挂靠到「${c.name}」`)
  selected.value.parent_name = c.name
  const row = tags.value.find((x: any) => x.id === selected.value.id)
  if (row) row.parent_name = c.name
  parentKw.value = ''
  parentCands.value = []
  loadGov()
}

// ---- 标签治理 ----
const scan = ref<any>({ running: '', total: 0, done: 0, message: '', lastError: '', lastResult: null })
const stats = ref<any>(null)
const proposals = ref<any[]>([])
const ops = ref<any[]>([])
const importFile = ref<HTMLInputElement | null>(null)

async function loadGov() {
  try { scan.value = await api.tags.scanStatus() } catch { /* 保持现状 */ }
  try { stats.value = await api.tags.stats() } catch { /* 保持现状 */ }
  try { proposals.value = await api.tags.proposals('pending') } catch { /* 保持现状 */ }
  try { treeTags.value = (await api.tags.list({ status: 'active', sort: 'name', limit: '5000' })).items || [] } catch { /* 保持现状 */ }
}

async function runNormalize() {
  const r: any = await api.tags.scanNormalize()
  if (r.success === false) return ui.toast(r.message || '规则归一失败')
  ui.toast(`规则归一完成：${r.groups} 组，合并 ${r.mergedTags} 个标签`)
  loadTags(true)
  loadGov()
}

async function runScan(kind: 'semantic' | 'level') {
  const r: any = kind === 'semantic' ? await api.tags.scanSemantic() : await api.tags.scanLevel()
  if (r.success === false) return ui.toast(r.message || '启动失败')
  ui.toast('扫描已启动，后台执行中')
  startPolling()
}

let pollTimer: ReturnType<typeof setInterval> | null = null
function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    try { scan.value = await api.tags.scanStatus() } catch { /* 下轮再试 */ }
    if (!scan.value.running) {
      stopPolling()
      if (scan.value.lastError) ui.toast(`扫描出错：${scan.value.lastError}`)
      else ui.toast('扫描完成，待审建议已生成')
      loadTags(true)
      loadGov()
    }
  }, 2000)
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
onUnmounted(stopPolling)

function pMembers(m: string): string[] {
  try { return JSON.parse(m) || [] } catch { return [] }
}

async function acceptProposal(p: any) {
  const r: any = await api.tags.proposalAccept(p.id)
  if (r.success === false) return ui.toast(r.message || '接受失败')
  ui.toast(p.kind === 'semantic' ? `已合并，转移 ${r.moved} 处挂载` : `已设为次要 ${r.downgraded} 个标签`)
  proposals.value = proposals.value.filter((x: any) => x.id !== p.id)
  loadTags(true)
  loadGov()
}

async function rejectProposal(p: any) {
  const r: any = await api.tags.proposalReject(p.id)
  if (r.success === false) return ui.toast(r.message || '操作失败')
  proposals.value = proposals.value.filter((x: any) => x.id !== p.id)
}

function onOpsToggle(e: Event) {
  if ((e.target as HTMLDetailsElement).open) {
    api.tags.ops(50).then((rows: any[]) => { ops.value = rows || [] }).catch(() => { /* 保持现状 */ })
  }
}

function doExport(format: 'json' | 'csv') {
  window.open(api.tags.exportUrl(format))
}

async function onImportFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const data = JSON.parse(await f.text())
    const items = Array.isArray(data) ? data : data.tags
    if (!Array.isArray(items)) throw new Error('格式不符：需要标签数组或 { tags: [...] }')
    const r: any = await api.tags.import(items)
    if (r.success === false) throw new Error(r.message || '导入失败')
    ui.toast(`导入完成：新建 ${r.created}，跳过 ${r.skipped}`)
    loadTags(true)
    loadGov()
  } catch (err: any) {
    ui.toast('导入失败：' + String(err?.message || err))
  } finally {
    (e.target as HTMLInputElement).value = ''
  }
}

function trendH(n: number) {
  const max = Math.max(...(stats.value?.trend || []).map((t: any) => t.newTags), 1)
  return Math.max(4, Math.round((n / max) * 36)) + 'px'
}

onMounted(async () => {
  await domains.fetchDomains()
  loadTags(true)
  loadGov().then(() => { if (scan.value.running) startPolling() })
})
</script>
