# AgentFeed 改造方案：从「知识库」到「注意力预算系统」

> 版本：v2.0 规格草案
> 性质：**纯方案文档**。本文件只定义目标、数据模型、算法规则、接口契约与验收标准，不包含任何代码落地动作。
> 适用对象：AgentFeed 现有链路（采集 → 门禁 Gate → LLM 蒸馏 → SQLite 19 表 → Express :5188 REST → Vue3 看板 8 页 + MCP stdio 9 工具）

> ---
> **【评审标记 2026-09-26】状态：已评审——哲学方向采纳，落地规格重构。**
> 评审产物：`docs/attention-budget-review-and-plan.md`（含生产库真实消化基线数据）。
> 核心修正：①真实消化基线 ≈0.1（元宝 4.4 自适应规则上线即锁死系统）；②推送面实测空转（推荐池 active=0、精选零打开），过载在库不在消息流，配额闸门降为阶段③；③MCP 拉取扣注意力配额属概念混淆，已否决；④阶段重排为「冷却池先行 → 消化信号 → 配额自适应」，逐项处置见评审文档 §4 映射表。
> ---

---

## 0. 一页纸摘要

| 维度 | 现状（v1） | 改造后（v2） |
|---|---|---|
| 目标函数 | 最大化可检索知识量 | 固定注意力预算下最大化价值密度 |
| 门禁 | 只管下限（过滤低质） | 下限 + 上限（配额截断） |
| 推送时机 | 实时采集、即时可见 | 秒级入库、日批推送 + 冷却期 |
| 出口形态 | 原文 / 摘要列表 | 30 秒决策卡片（默认不读原文） |
| 排序依据 | 相关性 + 质量分 | （相关性×新颖性×可执行性×可信度）÷ 消费成本 |
| 核心 KPI | 采集量、蒸馏量、阅读时长 | 截断率、消化率、注意力 ROI、pending 下降趋势 |
| MCP 语义 | 最大相关上下文 | 最小充分上下文 + Token 预算 |

一句话定位升级：**从「本地 Agent 产物知识库」升级为「Agent 注意力的守门人」**。

---

## 1. 问题诊断：目标函数错配

v1 的每一项优化都指向供给侧最大化：20+ Agent 自动接入、chokidar 秒级采集、mtime+size 缓存把万级重扫从 22s 降到 2s、蒸馏队列自动重试回填、Web+MCP 双出口。这在「知识稀缺」时代是正确的，其隐含假设是**多存一点、多推一点总是好的**。

在注意力稀缺的新困境下，该假设反转：**每多推一条，都是对大脑的一次征税**。由此产生三个结构性错配：

1. **门禁只有下限、没有上限**：Gate 过滤低质文件，但不约束总量。库越大、推荐池越满，人的负担越重，未读堆积反成焦虑源。
2. **出口是拉取式的**：8 个看板页面 + 9 个 MCP 工具，本质都在问「你想看点什么」，拣选决策成本仍压在人脑上。
3. **蒸馏是压缩，不是择取**：摘要/标签/实体/要点/关系把 20 分钟压成 5 分钟，但你仍然要读。压缩 ≠ 减量。

**核心结论**：系统缺的不是「找到好内容」的能力，而是**替你决定不读什么**的能力。

---

## 2. 架构增量：在原链路上叠加五个新层

```
采集层（不变）→ Gate 门禁（不变）
   ↓
【新增 L1】冷却池 Cooling Pool —— 24~72h 静置，天然淘汰
   ↓
【新增 L2】价值评分与新颖性过滤（复用已有 embedding + 规则分）
   ↓
【新增 L3】注意力配额闸门 + 背包装箱（硬上限截断）
   ↓
【新增 L4】决策卡片生成（默认不暴露原文）
   ↓
蒸馏管线（改造：输出卡片字段，而非仅摘要）
   ↓
存储（SQLite：新增 6 表 + 已有表新增字段）
   ↓
出口：Web 看板（改造首屏 + 新增留白页） / MCP（预算化改造）
   ↓
【新增 L5】消化闭环与预算自适应（摄入多、消化少 → 自动降额）
```

设计原则：**采集与存储保持实时（机器侧继续全量），推送与暴露改为日批限额（人侧严格限量）**。

---

## 3. 数据模型改造规格

### 3.1 新增表（6 张）

**T1 `attention_budget` —— 配额主表（单行或按周分区）**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | — | — |
| `period` | TEXT | `daily` | `daily` / `weekly` |
| `items_quota` | INTEGER | 3 | 每日可推送条目数上限，取值 1~10 |
| `minutes_quota` | INTEGER | 30 | 每日预计消费分钟上限，取值 10~180 |
| `weekly_minutes_quota` | INTEGER | 180 | 周预算兜底，防止日配额被绕过 |
| `cooling_hours` | INTEGER | 48 | 冷却时长，取值 24/48/72 |
| `hot_ttl_days` | INTEGER | 7 | 热层存活期 |
| `warm_ttl_days` | INTEGER | 30 | 温层存活期 |
| `auto_adapt` | INTEGER | 1 | 是否启用预算自适应，0/1 |
| `used_items` | INTEGER | 0 | 当日已推送计数 |
| `used_minutes` | INTEGER | 0 | 当日已消费分钟 |
| `reset_at` | TEXT | — | ISO8601 下次重置时间 |
| `mode` | TEXT | `normal` | `normal` / `digestion_first`（消化优先，暂停新供给） |

**T2 `goals` —— 目标表（让「对我有用」可计算）**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK | — | — |
| `title` | TEXT | — | 如「软考信息安全工程师备考」 |
| `status` | TEXT | `active` | `active` / `paused` / `closed` |
| `deadline` | TEXT | NULL | 目标期限，用于紧迫度加权 |
| `weight` | REAL | 1.0 | 目标权重，0.1~3.0 |
| `capacity_share` | REAL | — | 占日预算比例，全部 active 目标之和须 = 1.0 |
| `keywords` | TEXT | — | JSON 数组，用于规则侧召回 |
| `embedding` | BLOB | NULL | 目标向量，用于语义相关度 |

约束：相关性 R 的第一权重来自本表；目标 `closed` 后，其绑定条目自动降权并进入温层，不再参与推荐。

**T3 `cooling_pool` —— 冷却池**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | — |
| `file_id` | INTEGER FK | 指向 `files` |
| `entered_at` | TEXT | 入池时间 |
| `release_at` | TEXT | `entered_at + cooling_hours` |
| `initial_score` | REAL | 入池时评分 |
| `status` | TEXT | `cooling` / `promoted` / `expired`（死亡） |
| `death_reason` | TEXT | `timeout` / `duplicate` / `goal_closed` / `manual` |

**T4 `decision_cards` —— 决策卡片**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | — |
| `file_id` | INTEGER FK | — |
| `claim` | TEXT | 一句话主张，≤50 字，必填 |
| `evidence` | TEXT | 关键证据，≤3 条，每条 ≤30 字 |
| `so_what` | TEXT | 我该做什么，≤40 字 |
| `need_read` | INTEGER | 0/1，是否需要亲自读原文 |
| `est_minutes` | INTEGER | 预计消费分钟 |
| `confidence` | REAL | 0~1，卡片置信度 |
| `priority` | REAL | 装箱排序分 |
| `state` | TEXT | `pending` / `acted` / `digested` / `deferred` / `dropped` |
| `goal_id` | INTEGER FK | 绑定目标 |

**T5 `digestion_log` —— 消化日志（预算自适应唯一输入）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | — |
| `card_id` | INTEGER FK | — |
| `action_type` | TEXT | `conclusion`（留结论）/ `action`（转行动）/ `drop` |
| `conclusion` | TEXT | 消化产物，≥10 字，`conclusion` 类型必填 |
| `minutes_spent` | INTEGER | 实际耗时 |
| `linked_goal_id` | INTEGER | — |
| `created_at` | TEXT | — |

**T6 `suppression_metrics` —— 抑制指标（每日一行）**

| 字段 | 说明 |
|---|---|
| `date` | 日期 |
| `collected_count` | 当日采集量 |
| `gate_rejected_count` | 门禁拒绝量 |
| `cooling_entered` / `cooling_died` | 入池数 / 冷却死亡数 |
| `truncated_count` | 装箱截断数 |
| `delivered_count` | 实际推送数（≈ 配额） |
| `digested_count` | 消化数 |
| `pending_delta` | pending 队列净变化 |
| `quiet_minutes` | 当日未被信息占用的留白时长 |

### 3.2 已有表新增字段

在 `files`（或等价主表）上追加：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `lifecycle` | TEXT | `hot` | `hot` / `warm` / `cold` |
| `lifecycle_deadline` | TEXT | — | 过期时间，到期自动下沉 |
| `novelty` | REAL | NULL | 新颖性分 0~1 |
| `actionability` | REAL | NULL | 可执行性 0~1 |
| `trust` | REAL | NULL | 可信度 0~1 |
| `est_minutes` | INTEGER | NULL | 预计消费分钟 |
| `priority` | REAL | NULL | 综合优先级 |
| `goal_id` | INTEGER | NULL | 绑定目标 |
| `suppressed_reason` | TEXT | NULL | 被抑制原因，用于可解释性 |

在 `recommendations` 上追加：`budget_status`（`in_quota` / `over_quota`）、`card_id`、`delivered_at`。

---

## 4. 核心算法规格（规则定义，非实现）

### 4.1 价值密度评分

```
priority = (R × N × A × T × U) / C
```

| 因子 | 含义 | 计算规则 | 取值 |
|---|---|---|---|
| R | 相关性 | 与 active 目标 embedding 的最大相似度；无目标时取与近期消费主题的相似度 | 0~1 |
| N | 新颖性 | `1 - max_sim(候选, 已有 wiki ∪ 近90天已消费条目 top5)`；若近 7 天已有同源同主题条目，再乘 0.3 | 0~1 |
| A | 可执行性 | 含代码/命令/明确步骤 → 0.8；含结论观点 → 0.5；纯背景叙述 → 0.2；LLM 可在 0~1 内微调 | 0~1 |
| T | 可信度 | 自产 Agent 产物 0.9 / 官方文档 0.8 / 二次解读 0.5；被 ≥2 条独立条目交叉印证 +0.1（上限 1.0） | 0~1 |
| U | 紧迫度 | 绑定目标有 deadline 时，按剩余天数线性加权，无 deadline 取 1.0 | 1.0~1.5 |
| C | 消费成本 | `字数/400 × 类型系数`，类型系数：代码 1.5、长文 1.0、卡片 0.3，下限 1 分钟 | ≥1 |

说明：**N 是全式最关键的因子**。它让「看起来很棒但我早就会」的内容自动降级，直接对冲信息冗余。

### 4.2 背包装箱（硬上限落地的执行环节）

- 输入：冷却池中已过 release_at 且 novelty ≥ `novelty_min` 的候选集，各带 `priority` 与 `est_minutes`。
- 约束：`Σ est_minutes ≤ 当日剩余分钟`，`Σ 条数 ≤ 当日剩余条数`。
- 策略：按 `priority / est_minutes`（单位时间价值密度）降序贪心装入；装满即止。
- 输出：装入选集 → 生成决策卡片；未装入选集 → 标记 `truncated`，**当日不再出现**，次日重新参与（但 priority 衰减 10%，连续 3 次截断则下沉温层）。

### 4.3 冷却期与生命周期

- 新采集条目一律先入 `cooling_pool`，`release_at` 前不进推荐池、不看板、不出现在 MCP 返回中。
- 冷却期内若被重复条目命中（相似度 ≥ 0.92），直接判 `duplicate` 死亡。
- 生命周期下沉：`hot (7d)` → `warm (30d，仅检索不推荐)` → `cold（归档，不打扰，可搜索但不主动出现）`。
- 未消费条目到期自动下沉，不再堆积为「未读焦虑」。

### 4.4 预算自适应（每周日结算）

```
digestion_rate = 近7天 digested_count / delivered_count
```

| 消化率区间 | 动作 |
|---|---|
| ≥ 0.6 | 下周 `items_quota` 上调 10%（不超过上限 10） |
| 0.4 ~ 0.6 | 保持不变 |
| < 0.4 | 下周 `items_quota` 下调 20%（不低于下限 1） |
| 连续 2 周 < 0.3 | 进入 `digestion_first` 模式：暂停新供给，只推复盘与消化任务 |

### 4.5 决策卡片生成规则（代读层）

- 每个入选条目生成一张卡片，字段见 T4。
- `need_read = 1` 的条件（满足任一）：含必须本人判断的决策点；`confidence < 0.7`；绑定目标处于冲刺期且为关键材料。
- 其余一律 `need_read = 0`，用户只需读卡片即可完成消费。
- **目标：90% 的条目以 `need_read = 0` 形态被消费掉，人永远不必读原文。**

---

## 5. 配置参数清单（设置页 / config）

| 参数 | 默认 | 建议范围 | 作用 |
|---|---|---|---|
| `daily_items_quota` | 3 | 1~10 | 每日推送条数硬上限 |
| `daily_minutes_quota` | 30 | 10~180 | 每日消费分钟硬上限 |
| `weekly_minutes_quota` | 180 | 60~600 | 周兜底 |
| `cooling_hours` | 48 | 24/48/72 | 冷却时长 |
| `novelty_min` | 0.5 | 0.3~0.8 | 新颖性门槛，低于此值不进推荐池 |
| `hot_ttl_days` / `warm_ttl_days` | 7 / 30 | 3~14 / 14~90 | 分层存活期 |
| `mcp_token_budget` | 4000 | 1000~16000 | MCP 单次返回 token 上限 |
| `mcp_max_items` | 5 | 1~10 | MCP 单次返回条目上限 |
| `auto_adapt` | true | true/false | 预算自适应开关 |
| `digestion_min_chars` | 10 | 5~50 | 消化产物最小字数，防空标记 |
| `quiet_target_hours` | 2 | 0~6 | 每日目标留白时长 |

---

## 6. REST API 规格（`/api/v2/*`，Express :5188）

> 约定：所有时间字段 ISO8601；分页统一 `page` / `size`；错误码沿用现有风格，新增 `429 QUOTA_EXHAUSTED`、`409 CARD_STATE_CONFLICT`、`422 DIGESTION_TOO_SHORT`。

### 6.1 配额

**`GET /api/v2/budget`** — 查询配额状态
- 参数：无
- 返回：`{ period, items_quota, used_items, minutes_quota, used_minutes, cooling_hours, mode, reset_at, quiet_minutes_today }`

**`PUT /api/v2/budget`** — 更新配额配置
- 参数（body）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `items_quota` | int | 否 | 3 | 1~10 |
| `minutes_quota` | int | 否 | 30 | 10~180 |
| `weekly_minutes_quota` | int | 否 | 180 | 60~600 |
| `cooling_hours` | int | 否 | 48 | ∈{24,48,72} |
| `auto_adapt` | bool | 否 | true | — |
| `quiet_target_hours` | int | 否 | 2 | 0~6 |

- 返回：`{ updated_at, effective_from, budget }`；`effective_from` 默认下一周期，避免当日反复调额。

### 6.2 每日供给

**`GET /api/v2/feed/today`** — 今日配额内供给
- 参数（query）：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | enum | `digest` | `digest`（仅卡片）/ `raw`（含原文链接）/ `mixed` |
| `include_cooling` | bool | false | 是否显示冷却中条目（默认否） |
| `limit` | int | 配额余量 | 上限不超过 `items_quota` |

- 返回：`{ quota: {...}, cards: [ {card_id, claim, evidence[], so_what, need_read, est_minutes, confidence, priority, goal_title, source_ref} ], truncated_count, cooling_pending_count }`
- 行为：配额用尽时返回 `cards: []` + `429 QUOTA_EXHAUSTED` 语义的 `quota_exhausted: true`，**不兜底补量**。

**`POST /api/v2/triage/run`** — 手动/定时触发截断批处理
- 参数（body）：`{ dry_run: bool = true, target_date?: string, force_recompute?: bool = false }`
- 返回：`{ candidates, selected[], truncated[], cooling_died[], est_total_minutes, suppression_rate }`
- 说明：`dry_run=true` 时只出报告不落库，用于调参观察。

### 6.3 冷却池

**`GET /api/v2/cooling`**
- 参数：`status`（`cooling`/`promoted`/`expired`，默认 `cooling`）、`page`、`size`
- 返回：`{ items: [{cooling_id, file_id, title, initial_score, entered_at, release_at, remaining_hours}], total }`

**`POST /api/v2/cooling/:id/promote`** — 提前出池（人工提级）
- 参数（body）：`{ force: bool = false }`
- 规则：`force=false` 时若当日配额已满，拒绝并返回 `429`；`force=true` 允许超额但计入 `used_items` 并在次日触发降额提示。

**`POST /api/v2/cooling/:id/discard`** — 手动判死
- 参数（body）：`{ reason: enum = manual }`，枚举同 `death_reason`
- 返回：`{ ok, cooling_id, status: "expired" }`

### 6.4 决策与消化闭环

**`POST /api/v2/cards/:id/decide`** — 卡片决策
- 参数（body）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `decision` | enum | 是 | `act` / `read` / `defer` / `drop` |
| `note` | string | 否 | ≤200 字 |
| `minutes_spent` | int | 否 | 实际耗时，用于校正 `est_minutes` |

- 副作用：`act`/`read` 计 `used_minutes`；`defer` 回冷却池并重置 24h；`drop` 直接判死。

**`POST /api/v2/cards/:id/digest`** — 标记已消化（预算自适应输入）
- 参数（body）：

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `conclusion` | string | 是（action_type=conclusion） | ≥ `digestion_min_chars`，否则 `422` |
| `action` | string | 否 | 转成的下一步行动 |
| `action_type` | enum | 是 | `conclusion` / `action` / `drop` |
| `minutes_spent` | int | 否 | — |
| `linked_goal_id` | int | 否 | 默认继承卡片 `goal_id` |

- 返回：`{ ok, digestion_id, digestion_rate_7d, next_week_quota_hint }`

### 6.5 目标

**`GET /api/v2/goals`** — 参数：`status`（默认 `active`）
**`POST /api/v2/goals`** — 参数（body）：`title`(必填)、`deadline?`、`weight?`(0.1~3.0)、`capacity_share`(必填，全部 active 之和须=1.0，否则 `422`)、`keywords[]?`
**`PUT /api/v2/goals/:id`** — 同上字段可增量更新，`status=closed` 时触发绑定条目降权与温层下沉。

### 6.6 生命周期

**`POST /api/v2/items/:id/lifecycle`**
- 参数（body）：`{ stage: enum(hot/warm/cold), ttl_days?: int, reason?: string }`
- 返回：`{ ok, file_id, stage, deadline }`

### 6.7 指标与留白

**`GET /api/v2/metrics/attention`**
- 参数（query）：`from`（默认近 7 天）、`to`、`granularity`（`day`/`week`）
- 返回：`{ collected, gate_rejected, cooling_died, truncated, delivered, digested, digestion_rate, suppression_rate, pending_delta, quiet_minutes, attention_roi }`
- 其中 `attention_roi = digested × 平均价值分 ÷ 总消费分钟`；`suppression_rate = 1 - delivered / collected`

**`GET /api/v2/quiet`** — 返回当日/本周留白时长与目标对比：`{ quiet_minutes_today, quiet_target_hours, weekly_free_hours }`

---

## 7. MCP 工具规格（新增 4 + 改造 3）

> 原则：MCP 是最大的「无意识摄入」入口——任意 Agent 都能把噪音灌满上下文窗口，因此必须预算化。

### 7.1 新增

**`attention_budget_status`**
- 参数：`{}`
- 返回：`{ remaining_items, remaining_minutes, next_reset_at, mode, quiet_hours }`
- 用途：Agent 在拉取知识前先查额度，超额即自行停止检索。

**`triage_candidates`**
- 参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 检索意图 |
| `goal_id` | int | null | 绑定目标，未提供则按 active 目标加权 |
| `k` | int | 5 | 返回条数上限 |
| `token_budget` | int | 2000 | 返回内容 token 上限 |
| `novelty_only` | bool | true | 仅返回新颖性达标条目 |

- 返回：`{ cards: [...], omitted_count, cooling_pending_count, est_minutes_total }`
- 行为：只返回决策卡片，不返回原文；`omitted_count` 告知被截断量，避免 Agent 误以为「没有更多」。

**`get_minimal_context`**（定位为 `getContext` 的替代）
- 参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `task` | string | 必填 | 当前任务描述 |
| `token_budget` | int | 4000 | 硬上限 |
| `max_items` | int | 5 | 条目上限 |
| `min_confidence` | float | 0.6 | 低于此置信度的条目不返回 |
| `max_age_days` | int | 30 | 时效过滤 |

- 返回：`{ context, items_used, omitted_count, pointers[], confidence, freshness_warning }`
- 语义变更：**返回「最小充分上下文」而非「最大相关上下文」**；超出部分只给指针（`pointers`），由调用方显式二次请求。

**`record_digestion`**
- 参数：`{ item_id: int, conclusion: string(≥10字), action?: string, minutes?: int, goal_id?: int }`
- 返回：`{ ok, digestion_id, digestion_rate_7d }`
- 用途：让 Agent 侧消费也进入消化闭环，参与预算自适应。

### 7.2 改造

| 工具 | 改造点 |
|---|---|
| `search_knowledge` | 新增 `token_budget`(默认 2000)、`novelty_min`(默认 0.5)、`dedupe`(默认 true，同源同主题合并)；默认按 `priority` 排序而非纯相关度 |
| `stats` | 返回值追加 `suppression_rate`、`digestion_rate`、`pending_delta`、`quiet_minutes` |
| `read_entry` | 新增 `full`(默认 false)：`false` 时只返回决策卡片且不扣配额；`true` 才返回原文并扣减 `used_minutes`；增加 `min_confidence` 过滤 |

---

## 8. Web 看板改造规格（8 页 → 首屏重构 + 1 新增）

| 页面 | 改造要点 |
|---|---|
| 总览（首屏） | 第一行改为**配额条**：`今日 3/3，已用完，明天见`（替代「今日新增 187 条」）；次行显示 pending 趋势（应下降）与当日留白时长；移除一切「新增/未读」红点计数 |
| 看板 | 卡片流改为决策卡片；`need_read=0` 的卡片默认展开即可完成消费，原文入口折叠 |
| 库 | 增加 `lifecycle` 筛选与 TTL 倒计时；cold 层默认不展示 |
| 分拣 | 新增「冷却池」与「截断区」两个视图，展示被拦掉的内容及原因（可解释性，防误杀焦虑） |
| 管线 | 增加截断率、冷却死亡率曲线（越高越好） |
| 供给 | 增加 MCP 配额消耗面板，按 Agent 维度统计 token 消耗 |
| 阅读 | 阅读统计改为**消化统计**：摄入/沉淀比、周复盘；「已读」不计入成就 |
| 设置 | 新增配额、冷却、TTL、novelty_min、quiet_target 等参数区 |
| **新增：留白页** | 展示本周未被信息占用的空白时长，把它做成**被系统认可的正当状态**，而非待填满的空隙 |

交互原则：**默认收起**。所有列表默认折叠，展开是主动动作；不做无限下拉、不做自动加载更多。

---

## 9. 评价指标反转

| 弃用（旧 KPI） | 启用（新 KPI） | 目标方向 |
|---|---|---|
| 采集量、蒸馏量、库条目数 | `suppression_rate`（拦截比例） | 越高越好，目标 ≥ 95% |
| 覆盖率、召回率 | `attention_roi`（消化价值/消费分钟） | 持续上升 |
| 日活、阅读时长 | `digestion_rate` | 稳定 ≥ 0.5 |
| 推荐点击率 | `pending_delta`（队列净变化） | 持续 ≤ 0 |
| — | `cooling_death_rate` | 60%~80% 为健康区间 |
| — | `quiet_minutes` | ≥ 目标留白时长 |

**继续优化左侧那列，只会让困境更严重。**

---

## 10. 分阶段实施计划与验收门禁

### 阶段一：策略层（改动最小、收益最大，几乎不动架构）
范围：配额闸门 + 冷却池 + 冷热分层 TTL + 指标反转 + 看板首屏改造
验收门禁：
1. 连续 7 天 `delivered_count ≤ items_quota`，无超额泄漏；
2. `cooling_death_rate` 落在 60%~80%；
3. 首屏不再出现任何「新增/未读」计数；
4. `suppression_rate ≥ 95%`。

### 阶段二：模型层
范围：Goal 模型、novelty 计算、价值密度评分、背包装箱、决策卡片、代读层
验收门禁：
1. `need_read=0` 卡片占比 ≥ 90%；
2. 人工抽样 20 条，评分排序与主观价值排序相关性 ≥ 0.7；
3. 绑定目标条目的平均 R 值显著高于未绑定条目。

### 阶段三：交互与预算自适应
范围：留白页、默认收起、周度消化复盘、MCP 预算化改造
验收门禁：
1. MCP 单次返回 token 不超 `token_budget`，超额时返回 `omitted_count` 而非静默截断；
2. 预算自适应触发后下周配额按规则变化，且 `digestion_rate` 回升；
3. 连续 4 周 `pending_delta ≤ 0`。

---

## 11. 风险与回退

| 风险 | 表现 | 缓解 |
|---|---|---|
| 误杀高价值内容 | 重要材料被冷却/截断 | 冷却池与截断区**可查、可恢复**；白名单与手动 promote 保留；`suppressed_reason` 全量可解释 |
| 用户绕过配额 | 反复调高额度 | 调额默认次日生效；`force promote` 计入超额并触发次周降额提示 |
| novelty 计算依赖 embedding | LLM/嵌入未配置时退化 | 降级为关键词+标题相似度近似，并在指标中标注 `degraded: true` |
| 卡片质量不足 | 卡片无法替代原文，`need_read` 被迫升高 | 监控 `need_read` 比例，超过 30% 即视为代读层失败，回退到 mixed 模式 |
| 与 v1 行为冲突 | 既有推荐逻辑与新配额打架 | 通过 `/api/v2/*` 与 v1 接口并行，设置页提供 `legacy_mode` 开关，可一键回退 |

---

## 12. 附录：关键判定速查

1. **这条该不该推？** 冷却未过 → 否；配额已满 → 否；novelty < 阈值 → 否；与 active 目标 R 过低 → 否；装箱未选中 → 否。**五关全过才推。**
2. **该不该读原文？** 卡片 `need_read=1` 才读，其余读卡片即完成消费。
3. **额度该不该调？** 看 `digestion_rate`，而非看「我还有多少没读」。
4. **系统成功的标志是什么？** 库在增长，但人读得更少、消化得更多、pending 在下降。

---

*本方案仅定义规格与验收标准，落地实现需另行排期。*
