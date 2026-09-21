<template>
  <div class="content">
    <div class="view-head">
      <span class="plate">01</span>
      <h1 class="vtitle">调度总览</h1>
      <span class="vsub">收件 · 分拣 · 精炼 · 入库 · 发车 · 执行</span>
      <div class="vright">
        <button class="btn sm" @click="refreshAll"><Icon name="refresh" :size="13" /> 刷新</button>
      </div>
    </div>

    <!-- Tab 条：总览 / 数据看板 -->
    <div class="ovtabs">
      <button :class="{ on: tab === 'main' }" @click="switchTab('main')">总览</button>
      <button :class="{ on: tab === 'board' }" @click="switchTab('board')">数据看板</button>
    </div>

    <!-- ============ Tab 1：总览（原有内容） ============ -->
    <template v-if="tab === 'main'">
    <!-- 今日流量 -->
    <div class="flowstrip">
      <div class="fs-main">
        <div class="fs-label"><span class="sq"></span>今日流量 <span class="mono dim3" style="font-size:11px">{{ todayLabel }}</span></div>
        <div class="bignums">
          <div class="bn"><span class="bn-k">收件</span><span class="bn-v">+{{ d.stats?.weekNew ?? 0 }}</span><span class="bn-s">本周新增 · 有效 {{ d.stats?.active ?? 0 }}</span></div>
          <div class="bn"><span class="bn-k">精炼中</span><span class="bn-v">{{ d.queue?.running ?? 0 }}</span><span class="bn-s">待处理 {{ d.queue?.pending ?? 0 }} · 失败 {{ d.queue?.failed ?? 0 }}</span></div>
          <div class="bn"><span class="bn-k">入库</span><span class="bn-v">{{ d.stats?.entries ?? 0 }}</span><span class="bn-s">wiki 词条总数</span></div>
          <div class="bn"><span class="bn-k">发车</span><span class="bn-v">{{ mcp.week }}</span><span class="bn-s">本周 MCP 调用</span></div>
        </div>
      </div>
      <div class="scanbox">
        <div style="display:flex;align-items:center;gap:7px">
          <span class="dot" :class="scan.watcherRunning ? 'dot-run' : 'dot-pend'"></span>
          <b style="font-size:12.5px">{{ scan.watcherRunning ? 'watcher 运行中' : 'watcher 未运行' }}</b>
        </div>
        <div class="scan-nums mono">启用 {{ scan.enabledRoots ?? 0 }} 根 · 文件 {{ scan.files ?? 0 }}</div>
        <div class="cap">{{ scanLastLabel }}</div>
        <div><button class="btn xs" :disabled="scanning" @click="scanNow"><Icon name="refresh" :size="13" :class="{ spin: scanning }" /> 立即扫描</button></div>
      </div>
    </div>

    <!-- 五段流程带 -->
    <div class="flowband">
      <button v-for="(s, i) in segs" :key="s.view" class="flowseg" @click="$router.push(s.view)">
        <span class="fs-top"><span class="fs-num">{{ s.n }}</span><span class="fs-name">{{ s.name }}</span></span>
        <span class="fs-count">{{ s.count }}</span>
        <span class="fs-sub">{{ s.sub }}</span>
        <span v-if="i < segs.length - 1" class="fs-arrow"><Icon name="arrowRight" :size="16" /></span>
      </button>
    </div>

    <!-- 执行队列（阅读闭环：到点调起重读/实操）· 通栏第 3 行，宽度对齐内容区 -->
    <div class="sect" style="margin-bottom:16px">
      <div class="sect-head">
        <span class="sq"></span><h2 class="stitle">执行队列</h2>
        <div class="sright"><span class="cap mono">待执行 {{ exec.counts?.pending ?? 0 }} · 逾期 {{ exec.counts?.overdue ?? 0 }} · 今日完成 {{ exec.counts?.doneToday ?? 0 }}</span><router-link class="btn xs" to="/supply">发车区</router-link></div>
      </div>
      <table class="rtable" v-if="exec.items?.length">
        <thead><tr><th>内容</th><th style="width:96px">到期</th><th style="width:196px">操作</th></tr></thead>
        <tbody>
          <tr v-for="e in exec.items" :key="e.id">
            <td>
              <b style="font-size:13px">{{ e.title }}</b>
              <br /><span class="cap">{{ e.domain_name || '未分类' }}<template v-if="e.ext"> · {{ String(e.ext).replace('.', '') }}</template></span>
            </td>
            <td><span class="cap" :style="e.overdue ? 'color:var(--fail);font-weight:600' : ''">{{ e.overdue ? '已逾期 ' : '' }}{{ fmtTime(e.due_at) }}</span></td>
            <td>
              <span style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn xs" @click="openExec(e)"><Icon name="external" :size="12" /> 打开</button>
                <button class="btn xs" @click="execDone(e)"><Icon name="check" :size="12" /> 完成</button>
                <button class="btn xs" @click="execDismiss(e)"><Icon name="x" :size="12" /> 忽略</button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="cap" style="padding:14px">执行队列是空的 · 在发车区给读完的文章打分并选「立即试 / 稍后试」，到点这里会调起重读。</div>
      <!-- 周卡（回顾区块）：本周阅读 / 打分分布 / 完成轮次 / 逾期堆积 / 周目标环（R3） -->
      <div class="cap" style="padding:0 14px 12px;display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px">
        <span>本周：打开 {{ rstats.opened7 ?? 0 }} 次（{{ rstats.openedFiles7 ?? 0 }} 篇） · 打分 {{ rstats.rated7 ?? 0 }} 篇<template v-if="starsDist"> · {{ starsDist }}</template><template v-if="rstats.avgStars"> · 均分 {{ rstats.avgStars }} 星</template> · 完成执行 {{ rstats.doneWeek ?? 0 }} 轮 · 推荐池待读 {{ rstats.pool?.unread ?? 0 }}/{{ rstats.pool?.total ?? 0 }}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:auto">
          <svg width="20" height="20" viewBox="0 0 36 36" role="img" :aria-label="`周目标完成 ${goalPct}%`">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" stroke-width="5" />
            <circle cx="18" cy="18" r="15" fill="none" :stroke="goalDone ? '#1E8E5A' : '#B4651A'" stroke-width="5" stroke-linecap="round" :stroke-dasharray="`${goalPct} ${100 - goalPct}`" stroke-dashoffset="25" />
          </svg>
          <template v-if="!editingGoal">
            <span class="mono" :style="goalDone ? 'color:#1E8E5A' : ''">周目标 {{ rstats.ratedFiles7 ?? 0 }}/{{ rstats.weeklyGoal ?? 5 }} 篇{{ goalDone ? ' · 已达成' : '' }}</span>
            <button class="btn xs" @click="startGoalEdit">改</button>
          </template>
          <template v-else>
            <input class="inp" v-model="goalInput" type="number" min="1" max="100" style="width:64px;height:24px" @keyup.enter="saveGoal" @keyup.esc="editingGoal = false" />
            <button class="btn xs primary" @click="saveGoal">存</button>
          </template>
        </span>
      </div>
      <div v-if="(rstats.staleCount ?? 0) > 0" class="notice" style="margin:0 14px 12px;color:#B4651A">
        有 {{ rstats.staleCount }} 篇到期超 7 天未执行，建议回顾或忽略：{{ (rstats.stale || []).map((s: any) => s.title).join('、') }}
      </div>
      <!-- 薄弱点提示（M3）：按领域聚合本周低星与逾期堆积 -->
      <div v-if="(rstats.weakDomains || []).length" class="notice" style="margin:0 14px 12px;color:#B4651A">
        本周期薄弱领域：{{ (rstats.weakDomains || []).map((w: any) => `${w.name}（${[w.lowStars ? `低星 ${w.lowStars}` : '', w.stale ? `逾期 ${w.stale}` : ''].filter(Boolean).join(' · ')}）`).join('、') }}，建议优先补强。
      </div>
    </div>

    <!-- 每日精选（M4 R2）：池内 unread 按分轮转 3 篇，池不足时池外高分补位 -->
    <div class="sect" style="margin-bottom:16px">
      <div class="sect-head">
        <span class="sq"></span><h2 class="stitle">每日精选</h2>
        <div class="sright"><span class="cap mono">{{ daily.date || '—' }} · 零成本轮转</span><router-link class="btn xs" to="/supply">推荐池</router-link></div>
      </div>
      <div v-if="daily.items?.length" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;padding:12px 14px">
        <div v-for="(it, i) in daily.items" :key="it.file_id" class="bcard" style="cursor:pointer" @click="openDaily(it)">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="mono" style="font-size:11px;color:var(--dim)">TOP{{ i + 1 }}</span>
            <span v-if="it.outOfPool" class="cap" style="color:#B4651A">池外推荐</span>
            <span class="cap mono" style="margin-left:auto">{{ it.quality_score != null ? 'Q ' + it.quality_score : 'R ' + (it.score ?? it.rule_score ?? 0) }}</span>
          </div>
          <b style="font-size:13px;line-height:1.5;display:block;margin:4px 0 2px">{{ it.title }}</b>
          <span class="cap">{{ it.domain_name || '未分类' }}<template v-if="it.ext"> · {{ String(it.ext).replace('.', '') }}</template></span>
          <p class="cap" style="margin:6px 0 0;line-height:1.6;color:var(--dim)">{{ it.reason }}</p>
        </div>
      </div>
      <div v-else class="cap" style="padding:14px">今日暂无精选 · 推荐池与库内有内容后这里每天自动换一批。</div>
    </div>

    <!-- 今日学习建议（I3 RSI）：信号聚合 + 模型判断时机 + 每日 ≤1 次硬顶，与消费链路诊断并列 -->
    <div class="sect" style="margin-bottom:16px">
      <div class="sect-head">
        <span class="sq"></span><h2 class="stitle">今日学习建议</h2>
        <div class="sright"><span class="cap">I3 · 到期复习 &gt; 高频在读 &gt; 目标缺口 · 每日至多推送一次</span></div>
      </div>
      <div v-if="rsi.items?.length" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;padding:12px 14px">
        <div v-for="it in rsi.items" :key="it.fileId" class="bcard" style="cursor:pointer" title="进站内阅读器" @click="router.push(`/reader/${it.fileId}`)">
          <b style="font-size:13px;line-height:1.5;display:block;margin:4px 0 2px">{{ it.title }}</b>
          <p class="cap" style="margin:6px 0 0;line-height:1.6;color:var(--dim)">{{ it.reason }}</p>
        </div>
      </div>
      <div v-else class="cap" style="padding:14px">{{ rsiHint }}</div>
    </div>

    <div class="sect">
      <div class="sect-head"><span class="sq"></span><h2 class="stitle">消费链路诊断</h2><div class="sright"><span class="cap">E1 · search→read→source · 与 mcpFunnel 脚本同口径</span></div></div>
      <template v-if="funnel">
        <div class="fn-funnel">
          <div class="fn-stage">
            <div class="fn-num">{{ funnel.metrics.sessionsWithSearch }}</div>
            <div class="fn-lab">search 会话</div>
          </div>
          <div class="fn-arrow">→</div>
          <div class="fn-stage">
            <div class="fn-num" :class="{ ok: funnel.metrics.level1Rate > 0 }">{{ funnel.metrics.level1Done }}</div>
            <div class="fn-lab">深读跟随 · {{ (funnel.metrics.level1Rate * 100).toFixed(0) }}%</div>
          </div>
          <div class="fn-arrow">→</div>
          <div class="fn-stage">
            <div class="fn-num" :class="{ ok: funnel.metrics.level2Rate > 0 }">{{ funnel.metrics.level2Done }}</div>
            <div class="fn-lab">取源码 · {{ (funnel.metrics.level2Rate * 100).toFixed(0) }}%</div>
          </div>
        </div>
        <div class="fn-attrib">
          <span v-for="k in (['followed', 'args_null', 'weak_match', 'needs_review'] as const)" :key="k" class="fn-chip" :class="k" :title="ATTRIB_HINT[k]">
            <b>{{ funnel.attribution.counts[k] ?? 0 }}</b> {{ ATTRIB_LABEL[k] }}
          </span>
        </div>
        <div class="fn-samples" v-if="funnel.attribution.samples?.length">
          <div v-for="s in funnel.attribution.samples.slice(0, 5)" :key="s.logId" class="fn-sample">
            <span class="mono c-dim">#{{ s.logId }}</span>
            <span class="fn-q">{{ s.query ?? '（args 缺失）' }}</span>
            <span class="c-dim" v-if="s.overlap !== null">重合 {{ (s.overlap * 100).toFixed(0) }}%</span>
          </div>
        </div>
        <div class="cap" style="margin-top:6px">归因重放为关键词路近似（与调用时刻索引或有漂移）；趋势：近 7 日 search {{ funnel.trend.reduce((s: number, t: any) => s + Number(t.calls || 0), 0) }} 次</div>
      </template>
      <div v-else class="cap" style="padding:14px">暂无 MCP 调用数据——agent 挂载并使用后，此处展示消费链路漏斗与断链归因。</div>
    </div>

    <div class="ov-grid">
      <div class="ov-col">
        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">近期动态</h2><div class="sright"><span class="cap">收件 · 精炼 · 入库</span></div></div>
          <div class="tl" v-if="d.events?.length">
            <div v-for="(e, i) in d.events" :key="i" class="tl-item">
              <span class="tl-dot" :style="{ background: e.c }"></span>
              <span class="tl-time">{{ fmtTime(e.t) }}</span>
              <span class="tl-text">{{ e.text }}</span>
            </div>
          </div>
          <div v-else class="cap" style="padding:14px">暂无动态，等待扫描与精炼任务。</div>
        </div>

        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">最近添加</h2><div class="sright"><router-link class="btn xs" to="/library">前往收件坪</router-link></div></div>
          <table class="rtable">
            <thead><tr><th>标题</th><th>领域</th><th>来源</th><th>时间</th><th>类型</th></tr></thead>
            <tbody>
              <tr v-for="f in d.recent" :key="f.id" class="lib-row" title="查看详情抽屉" @click="ui.openDrawer(f.id)">
                <td class="c-main">{{ f.title || f.name }}</td>
                <td data-l="领域"><span class="cv"><span class="dot" :style="{ background: f.domain_color || 'var(--skip)' }"></span> {{ f.domain || '未分类' }}</span></td>
                <td data-l="来源"><span class="cv"><span class="mono">{{ f.agent || '—' }}</span></span></td>
                <td data-l="时间"><span class="cv"><span class="c-dim">{{ fmtTime(f.file_mtime) }}</span></span></td>
                <td data-l="类型"><span class="cv"><span class="c-dim">{{ f.ext }}</span></span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="ov-col">
        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">领域分布</h2><div class="sright"><router-link class="btn xs" to="/domains">分拣区</router-link></div></div>
          <div class="bars" v-if="domBars.length">
            <div v-for="b in domBars" :key="b.key" class="bar-row" :class="{ child: b.child }" :title="`${b.name}：${b.count} 项 · 占比 ${b.pct}%`">
              <span class="bar-name">{{ b.name }}</span>
              <span class="bar-track"><span class="bar-fill" :style="{ width: b.pct + '%', background: b.color }"></span></span>
              <span class="bar-count">{{ b.count }}</span>
            </div>
          </div>
          <div v-else class="cap" style="padding:14px">尚无领域数据。</div>
        </div>

        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">来源文件</h2><div class="sright"><span class="cap mono">{{ (d.fileSources || []).length }} 个一级目录</span></div></div>
          <div class="bars" v-if="fileSourceBars.length">
            <div v-for="a in fileSourceBars" :key="a.name" class="bar-row" :title="`${a.name}：${a.count} 项 · 占比 ${a.pct}%`">
              <span class="bar-name">{{ a.name || '未知' }}</span>
              <span class="bar-track"><span class="bar-fill" :style="{ width: a.pct + '%', background: a.color }"></span></span>
              <span class="bar-count">{{ a.count }}</span>
            </div>
          </div>
          <div v-else class="cap" style="padding:14px">尚无来源数据。</div>
        </div>

        <div class="sect">
          <div class="sect-head"><span class="sq"></span><h2 class="stitle">来源 agent</h2><div class="sright"><span class="cap mono">{{ (d.agents || []).length }} 个 agent</span></div></div>
          <div class="bars" v-if="agentBars.length">
            <div v-for="a in agentBars" :key="a.name" class="bar-row" :title="`${a.name}：${a.count} 项 · 占比 ${a.pct}%`">
              <span class="bar-name">{{ a.name || '未知' }}</span>
              <span class="bar-track"><span class="bar-fill" :style="{ width: a.pct + '%', background: a.color }"></span></span>
              <span class="bar-count">{{ a.count }}</span>
            </div>
          </div>
          <div v-else class="cap" style="padding:14px">尚无来源数据。</div>
        </div>
      </div>
    </div>

    <!-- 近 15 天 LLM 调用 · 通栏区块，按模型细分着色 -->
    <div class="sect" style="margin-bottom:16px">
      <div class="sect-head"><span class="sq"></span><h2 class="stitle">近 15 天 LLM 调用</h2><div class="sright"><span class="cap mono">合计 {{ d.trend?.sum ?? 0 }}</span></div></div>
      <div class="trend" v-if="d.trend?.labels?.length">
        <div v-for="(v, i) in d.trend.vals" :key="i" class="tb" :class="{ today: i === d.trend.vals.length - 1 }">
          <span class="tb-v">{{ v || '' }}</span>
          <span class="tb-bar stack" :style="{ height: trendH(v) + '%' }">
            <i v-for="(m, mi) in trendModels" :key="mi" class="tb-seg" :style="{ height: segPct(m, i) + '%', background: modelColor(mi) }"></i>
          </span>
          <span class="tb-l">{{ d.trend.labels[i] }}</span>
        </div>
      </div>
      <div v-if="trendModels.length" class="cap" style="display:flex;flex-wrap:wrap;gap:6px 16px;padding:10px 14px 0">
        <span v-for="(m, mi) in trendModels" :key="m.name" style="display:flex;align-items:center;gap:5px" :title="`${m.name}：近 15 天共 ${m.vals.reduce((s: number, v: number) => s + v, 0)} 次调用`">
          <i :style="{ width: '10px', height: '10px', background: modelColor(mi), display: 'inline-block', borderRadius: '2px', border: '1px solid var(--border)' }"></i>
          <span class="mono">{{ m.name }}</span>· {{ m.vals.reduce((s: number, v: number) => s + v, 0) }} 次
        </span>
      </div>
      <div class="cap" style="padding:6px 14px 12px">近 30 天：{{ d.llm30?.calls ?? 0 }} 次调用 · {{ fmtTokens(d.llm30?.tokens) }} tokens · 成功率 {{ d.llm30?.rate ?? '—' }}%</div>
    </div>

    <div class="strip4">
      <div class="s4"><span class="s4-k">文件与资产</span><div class="s4-v">文件 {{ d.stats?.files ?? 0 }} · 有效 {{ d.stats?.active ?? 0 }} · 已删除 {{ d.stats?.deleted ?? 0 }} · 本周新增 {{ d.stats?.weekNew ?? 0 }}<br>词条 {{ d.stats?.entries ?? 0 }} · 领域 {{ d.stats?.domains ?? 0 }} · 标签 {{ d.stats?.tags ?? 0 }} · 来源 agent {{ d.stats?.agents ?? 0 }}</div></div>
      <div class="s4"><span class="s4-k">治理</span><div class="s4-v">不存全文（仅摘要与词条）· 软删除 {{ d.stats?.deleted ?? 0 }} 项<br>md5 版本链维护中 · 打开与定位校验扫描根边界</div></div>
      <div class="s4"><span class="s4-k">近 30 天 LLM</span><div class="s4-v">{{ d.llm30?.calls ?? 0 }} 次调用 · {{ fmtTokens(d.llm30?.tokens) }} tokens · 成功率 {{ d.llm30?.rate ?? '—' }}%<br>模型 <span class="mono">{{ llm.providers.defaultModel || '默认模型' }}</span></div></div>
      <div class="s4"><span class="s4-k">MCP 供给</span><div class="s4-v">本周发车 {{ mcp.week }} 次 · 累计 {{ mcp.total }} 次<br>工具 {{ (mcp.byTool || []).length }} 个 · 仅监听本机 127.0.0.1</div></div>
    </div>
    </template>

    <!-- ============ Tab 2：数据看板 ============ -->
    <template v-else>
      <!-- ① Agent 生产情况（下钻二级目录） -->
      <div class="sect" style="margin-bottom:16px">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">Agent 生产情况</h2>
          <div class="sright"><span class="cap mono">{{ (board.agentProd || []).length }} 个 agent 在产 · 目录条为该 agent 内占比</span></div>
        </div>
        <div class="bcards" v-if="(board.agentProd || []).length">
          <div v-for="a in board.agentProd" :key="a.name" class="bcard">
            <div class="bcard-head">
              <span class="bcard-name">{{ a.name }}</span>
              <span class="bcard-count mono">{{ a.count }} 项</span>
            </div>
            <div class="bcard-dirs">
              <div v-for="dir in a.dirs" :key="dir.name" class="bdir" :title="`${a.name} / ${dir.name}：${dir.count} 项 · 占该 agent ${dirPct(a, dir)}%`">
                <span class="bdir-name" :title="dir.name">{{ dir.name }}</span>
                <span class="bdir-track"><span class="bdir-fill" :style="{ width: dirPct(a, dir) + '%' }"></span></span>
                <span class="bdir-n mono">{{ dir.count }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="cap" style="padding:14px">暂无 agent 生产数据 · 先在扫描页挂载 agent 目录并完成扫描。</div>
      </div>

      <!-- ② 领域占比气泡图（XY 轴 · 圆色=领域色 · 圆面积=文件数） -->
      <div class="sect" style="margin-bottom:16px">
        <div class="sect-head">
          <span class="sq"></span><h2 class="stitle">领域占比气泡图</h2>
          <div class="sright"><span class="cap mono">X 轴 · 领域 / Y 轴 · 占比 / 圆面积 · 文件数</span></div>
        </div>
        <div class="bubblewrap" v-if="(board.domainBubbles || []).length">
          <svg class="bubble-svg" viewBox="0 0 1000 360" preserveAspectRatio="xMidYMid meet" role="img">
            <!-- 水平网格与 Y 轴刻度 -->
            <g v-for="g in bubbleGrid" :key="'g' + g.y">
              <line :x1="g.x1" :y1="g.y" :x2="g.x2" :y2="g.y" class="bgrid" />
              <text :x="g.x1 - 8" :y="g.y + 4" text-anchor="end" class="baxis">{{ g.label }}</text>
            </g>
            <!-- 轴线 -->
            <line :x1="axis.x1" :y1="axis.y1" :x2="axis.x2" :y2="axis.y1" class="baxisline" />
            <line :x1="axis.x1" :y1="axis.y1" :x2="axis.x1" :y2="axis.y2" class="baxisline" />
            <!-- 气泡与 X 轴领域名 -->
            <g v-for="b in bubbles" :key="b.name" class="bnode">
              <title>{{ b.name }}：{{ b.count }} 项 · 占比 {{ b.pct }}%</title>
              <circle :cx="b.cx" :cy="b.cy" :r="b.r" :fill="b.color" fill-opacity="0.82" />
              <text v-if="b.r >= 16" :x="b.cx" :y="b.cy + 4" text-anchor="middle" class="blabel">{{ b.pct }}%</text>
              <text :x="b.cx" :y="axis.y1 + 18" text-anchor="middle" class="bxname">{{ b.name }}</text>
            </g>
          </svg>
        </div>
        <div v-else class="cap" style="padding:14px">暂无领域数据 · 先在分拣区给文件归域。</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { api } from '../api'
import { useUiStore } from '../stores/useUiStore'
import { useLlmStore } from '../stores/useLlmStore'

const ui = useUiStore()
const llm = useLlmStore()
const router = useRouter()

const d = ref<any>({})
const mcp = ref<any>({ week: 0, total: 0, byTool: [] })
const scan = ref<any>({})
// E1 消费链路诊断面板（/api/stats/funnel）
const funnel = ref<any>(null)
const ATTRIB_LABEL: Record<string, string> = {
  followed: '跟随深读', args_null: '不可归因', weak_match: '疑似检索弱', needs_review: '待复核'
}
const ATTRIB_HINT: Record<string, string> = {
  followed: 'search 后 30 分钟内跟随 read_entry（链路健康）',
  args_null: '存量 args 缺失（埋点缺口，不可归因，单列计数）',
  weak_match: '重放 Top-3 与 query 词面重合低——疑似检索质量问题，A1/A2 是解药',
  needs_review: '词面重合尚可但未深读——summary 够用或工具描述未引导，人工复核'
}
const scanning = ref(false)
const exec = ref<any>({ items: [], counts: { pending: 0, overdue: 0, doneToday: 0 } })
const rstats = ref<any>({})
const daily = ref<any>({ items: [], date: '' })
// 今日学习建议（I3 RSI）：加载即正式触发一次，当日后续被硬顶自然拦截（不重复烧模型）
const rsi = ref<any>({ items: [], generated: false, hardBlocked: undefined })
const rsiHint = computed(() => {
  if (rsi.value.hardBlocked === 'daily-cap') return '今日学习建议已推送过 · 明天再来。'
  if (rsi.value.hardBlocked === 'disabled') return '学习建议推送已关闭 · 可在 设置 → AI 设置 中开启。'
  return '暂无建议 · 有到期复习、高频在读或周目标缺口时会出现在这里。'
})
let timer: ReturnType<typeof setInterval> | null = null

const todayLabel = computed(() => {
  const dt = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()]
  return `${dt.toISOString().slice(0, 10)} 周${week} · 实时`
})

const segs = computed(() => [
  { n: '01', name: '收件', count: d.value.stats?.active ?? 0, sub: `资料库 · 本周 +${d.value.stats?.weekNew ?? 0}`, view: '/library' },
  { n: '02', name: '分拣', count: d.value.stats?.domains ?? 0, sub: '领域 · 分拣区管理', view: '/domains' },
  { n: '03', name: '精炼', count: d.value.queue?.pending ?? 0, sub: `管线 · 进行中 ${d.value.queue?.running ?? 0} · 失败 ${d.value.queue?.failed ?? 0}`, view: '/pipeline' },
  { n: '04', name: '入库', count: d.value.stats?.entries ?? 0, sub: '词条 · 摘要与要点', view: '/entry' },
  { n: '05', name: '发车', count: mcp.value.week, sub: '供给 · MCP 工具调用', view: '/supply' }
])

/** 彩虹色系：按行序在色环上均匀取色；子行加亮以区分层级 */
function rainbow(i: number, n: number, child = false) {
  const hue = Math.round((i / Math.max(1, n)) * 330)
  return `hsl(${hue}, ${child ? '58' : '68'}%, ${child ? '64' : '50'}%)`
}

const domBars = computed(() => {
  const out: { key: string; name: string; count: number; color: string; child: boolean; pct: number }[] = []
  const list = d.value.domains || []
  // 占比基准 = 顶层领域总数之和（子领域是顶层总数的其中份额，避免父子重复计入）
  const total = list.reduce((s: number, dm: any) => s + (dm.total ?? dm.count ?? 0), 0)
  const rows = list.length + list.reduce((s: number, dm: any) => s + (dm.children?.length ?? 0), 0)
  let i = 0
  for (const dm of list) {
    const count = dm.total ?? dm.count ?? 0
    if (count <= 0) continue // 0 项领域不出现在占比图中，避免空行噪声
    // 颜色与分拣区领域卡（domband）同源：优先领域 color，未设置时回退彩虹序号色
    out.push({ key: 'd' + dm.id, name: dm.name, count, color: dm.color || rainbow(i++, rows), child: false, pct: total ? +(count / total * 100).toFixed(1) : 0 })
    for (const c of dm.children || []) {
      const cc = c.count ?? 0
      out.push({ key: 'c' + c.id, name: c.name, count: cc, color: c.color || rainbow(i++, rows, true), child: true, pct: total ? +(cc / total * 100).toFixed(1) : 0 })
    }
  }
  return out
})

// 来源类占比条通用转换（count → pct + 彩虹序号色）
const toBars = (list: any[]) => {
  const total = list.reduce((s: number, a: any) => s + (a.count ?? 0), 0)
  return list.map((a: any, i: number) => ({
    name: a.name,
    count: a.count ?? 0,
    color: rainbow(i, list.length),
    pct: total ? +((a.count ?? 0) / total * 100).toFixed(1) : 0
  }))
}
const fileSourceBars = computed(() => toBars(d.value.fileSources || []))
const agentBars = computed(() => toBars(d.value.agents || []))

// ===== Tab 2 · 数据看板 =====
const tab = ref<'main' | 'board'>('main')
const board = ref<any>({})
let boardLoaded = false

async function switchTab(t: 'main' | 'board') {
  tab.value = t
  if (t === 'board' && !boardLoaded) {
    boardLoaded = true
    try { board.value = await api.stats.board() } catch { boardLoaded = false }
  }
}

/** 目录条：占该 agent 总量的百分比 */
function dirPct(a: any, dir: any) {
  return a.count ? +((dir.count / a.count) * 100).toFixed(1) : 0
}

// 气泡图坐标：X = 领域均匀分布，Y = 占比，r = 面积随文件数（sqrt）
const AXIS = { x1: 52, y1: 312, x2: 970, y2: 26 }
const axis = AXIS
const maxBubblePct = computed(() => Math.max(10, ...(board.value.domainBubbles || []).map((b: any) => b.pct)))
const bubbles = computed(() => {
  const list: any[] = board.value.domainBubbles || []
  const step = list.length ? (AXIS.x2 - AXIS.x1) / list.length : 0
  const maxCount = Math.max(1, ...list.map((b: any) => b.count))
  return list.map((b: any, i: number) => ({
    ...b,
    cx: +(AXIS.x1 + step * i + step / 2).toFixed(1),
    cy: +(AXIS.y1 - (b.pct / maxBubblePct.value) * (AXIS.y1 - AXIS.y2)).toFixed(1),
    r: +(9 + Math.sqrt(b.count / maxCount) * 24).toFixed(1)
  }))
})
const bubbleGrid = computed(() =>
  [0, 0.25, 0.5, 0.75, 1].map(f => ({
    y: +(AXIS.y1 - f * (AXIS.y1 - AXIS.y2)).toFixed(1),
    x1: AXIS.x1, x2: AXIS.x2,
    label: Math.round(maxBubblePct.value * f) + '%'
  }))
)

const scanLastLabel = computed(() => {
  const ls = scan.value.lastScanAt || scan.value.lastScan?.at
  return ls ? `上次扫描 ${fmtTime(ls)}` : '尚未执行过扫描'
})

/** 打分分布摘要：★5×2 ★4×1 …（降序） */
const starsDist = computed(() => {
  const dist = rstats.value.dist as Record<number, number> | undefined
  if (!dist || !Object.keys(dist).length) return ''
  return Object.keys(dist).map(Number).sort((a, b) => b - a).map(s => `★${s}×${dist[s]}`).join(' ')
})

// ---- 周目标环（R3）：完成 = 本周打分去重篇数 ----
const editingGoal = ref(false)
const goalInput = ref('')
const goalPct = computed(() => {
  const goal = Math.max(1, rstats.value.weeklyGoal ?? 5)
  return Math.min(100, Math.round(((rstats.value.ratedFiles7 ?? 0) / goal) * 100))
})
const goalDone = computed(() => (rstats.value.ratedFiles7 ?? 0) >= Math.max(1, rstats.value.weeklyGoal ?? 5))

function startGoalEdit() {
  goalInput.value = String(rstats.value.weeklyGoal ?? 5)
  editingGoal.value = true
}

async function saveGoal() {
  const g = parseInt(goalInput.value)
  const r: any = await api.reading.goal(g)
  if (r?.success) {
    rstats.value.weeklyGoal = r.weeklyGoal
    ui.toast(`周阅读目标已设为 ${r.weeklyGoal} 篇`)
  } else {
    ui.toast(r?.message || '目标设置失败')
  }
  editingGoal.value = false
}

function trendH(v: number) {
  const max = Math.max(1, ...(d.value.trend?.vals || []))
  return Math.max(4, Math.round((v / max) * 100))
}

// 按模型细分：调色板 + 各日段高占比
const MODEL_COLORS = ['#2456A6', '#B4651A', '#2E7D4F', '#7B4BA6', '#B3402A', '#1F7A8C', '#8C6D1F', '#5A5A5A']
const trendModels = computed(() => d.value.trend?.models || [])
function modelColor(i: number) {
  return MODEL_COLORS[i % MODEL_COLORS.length]
}
function segPct(m: any, i: number) {
  const total = d.value.trend?.vals?.[i] || 0
  return total > 0 ? ((m.vals?.[i] || 0) / total) * 100 : 0
}

function fmtTime(t?: string) {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  const now = new Date()
  const sameDay = dt.toDateString() === now.toDateString()
  const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${hm}`
  const yest = new Date(now.getTime() - 86400000)
  if (dt.toDateString() === yest.toDateString()) return `昨天 ${hm}`
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${hm}`
}

function fmtTokens(n?: number | null) {
  if (!n) return '0'
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
}

async function refreshAll() {
  const [dash, m, s, ex, rs] = await Promise.all([
    api.stats.dashboard(),
    api.stats.mcp(),
    api.scan.status(),
    api.reading.exec().catch(() => null),
    api.reading.stats().catch(() => null)
  ])
  d.value = dash
  mcp.value = m
  scan.value = s
  api.stats.funnel().then((f: any) => { funnel.value = f?.success && f.metrics?.totalCalls > 0 ? f : null }).catch(() => {})
  if (ex) exec.value = ex
  if (rs) rstats.value = rs
  ui.queuePaused = !!dash.queue?.paused
  llm.fetchProviders().catch(() => {})
}

async function openExec(e: any) {
  // R4-M2 入口：md/html 站内优先（阅读器带回位与进度记录），其余外部打开
  if (/^\.md$|^\.html?$/i.test(String(e.ext || ''))) {
    router.push(`/reader/${e.file_id}`)
    return
  }
  const r: any = await api.files.open(e.file_id, 'exec')
  if (r?.success) ui.toast('已在本地打开 · 实操完记得回来点「完成」')
  else ui.toast(r?.message || '打开失败')
}

async function execDone(e: any) {
  const r: any = await api.reading.execDone(e.id)
  if (r?.rescheduled) ui.toast(`已完成 · ${r.nextDays} 天后再次调起重读`)
  else ui.toast(`已完成「${e.title}」· 已归档不再调起`)
  const ex = await api.reading.exec().catch(() => null)
  if (ex) exec.value = ex
}

async function execDismiss(e: any) {
  const r: any = await api.reading.execDismiss(e.id)
  ui.toast(r?.demoted ? '已忽略并降档 · 逾期超 7 天会在回顾中提示' : '已忽略 · 不再调起')
  const ex = await api.reading.exec().catch(() => null)
  if (ex) exec.value = ex
}

async function scanNow() {
  scanning.value = true
  try {
    await api.scan.run()
    ui.toast('扫描完成')
    await refreshAll()
  } catch (e: any) {
    ui.toast('扫描失败：' + (e?.message || e))
  } finally {
    scanning.value = false
  }
}

onMounted(async () => {
  await refreshAll()
  api.recommend.daily().then((r: any) => { daily.value = r }).catch(() => {})
  api.rsi.suggestions().then((r: any) => { if (r?.success) rsi.value = r }).catch(() => {})
  timer = setInterval(refreshAll, 15000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

/** 每日精选（R4-M2）：改走站内阅读器——/content 记 source=reader 埋点，进入自动回位到上次进度 */
function openDaily(it: any) {
  router.push(`/reader/${it.file_id}`)
}
</script>
