# AgentFeed「注意力管家」改造方案

---

**文档编号**：AF-RFC-2026-001

**版本**：v1.0

**日期**：2026-09-25

**状态**：评审稿

**性质**：设计文档（仅定义方案与接口契约，不含实现代码）

**改造哲学**：从"知识仓库"到"注意力管家"——知识不再稀缺，注意力和大脑处理容量才是稀缺资源。系统的目标从"帮用户读得更多"改为"帮用户敢于少读"。

> ---
> **【评审标记 2026-09-26】状态：已评审——工程与成本素养四项采纳（去重前置/三层摘要时机/marginal 参照系/灰度对等），入库配额与 MCP 快照-only 两项否决。**
> 评审产物：`docs/attention-budget-review-and-plan.md` v1.2（§0 三方案结论 + §4 三方案映射表）。
> 采纳亮点：A-1 蒸馏前廉价去重（前置省 LLM 成本、判冷不判死）、模块 B 生成时机矩阵（hook 并入既有蒸馏调用零新增成本 / brief 懒生成 / 超长截断禁重调，全场唯一真降本设计）、marginal 已读集参照系（替代全库 novelty，唯一贴合拉取式基线）、features 灰度开关全关=行为对等、§11 禁止动作总表（收编为实施红线主文档）、score_breakdown 可解释、pinned/touch 语义、one_line_use、配额改配置次日生效。
> 核心否决：①daily_quota 30 直接管采集端——本地库价值锚点=全量留存，187 条/天配额 30 = 84% 产物进待审池→自动判冷，且待审池放行按 importance 排序而 importance 产自蒸馏、蒸馏在去重之后，管线 DAG 有环（改为只记不拦的观测仪表）；②focus_mode 的 MCP 快照-only 把人的专注外溢成 agent 任务降级（概念混淆）；③deep_read_ratio≥40% / 冷层占比≥60% 验收值未对存量基线校准。逐项处置见评审文档 §4。
> ---

---

## 目录

1. 改造总览
2. 模块 A：注意力门禁（admission）
3. 模块 B：三层摘要蒸馏（digest）
4. 模块 C：时效分层存储（lifecycle）
5. 模块 D：最小必要推荐（recommend）
6. 模块 E：受控投喂与消化闭环（consumption）
7. 模块 F：MCP Server 接口变更清单
8. 数据模型变更与迁移原则
9. 验收标准
10. 实施节奏
11. 全局禁止动作总表

---

## 1. 改造总览

### 1.1 模块变更总览

| 模块 | 变更类型 | 核心改动 | 关联配置段 |
|---|---|---|---|
| A. 注意力门禁 | 新增 | 配额准入 + 廉价去重 + 三档重要性分流 | `attention.admission` |
| B. 三层摘要蒸馏 | 扩展 | hook / brief / full 三层粒度 + LLM 行动建议 | `attention.digest` |
| C. 时效分层存储 | 新增 | instant / digest / cold 三层 + 每日衰减任务 | `attention.lifecycle` |
| D. 最小必要推荐 | 重构 | 目标召回 + 边际价值评分 + 可解释评分明细 | `attention.recommend` |
| E. 受控投喂与消化闭环 | 新增 | 每日投喂上限 + 专注模式 + 消化指标 | `attention.consumption` |
| F. MCP Server | 扩展 | 工具增改 + 统一闸门 | — |

### 1.2 新数据管线

```
Agent 产物
   │
   ▼
① 规则门禁（原有，不动：硬过滤空文件/乱码/超体积）
   │ staged
   ▼
② 廉价去重（embedding 余弦查重，模块 A-1）──duplicate──▶ reject（落冷归档）
   │ unique
   ▼
③ 蒸馏管线（扩展：importance + hook 同次调用，模块 B）──noise──▶ reject（落冷归档）
   │ critical / useful
   ▼
④ 注意力门禁·配额判定（模块 A-2）──超额──▶ 待审池 queue
   │ accept
   ▼
⑤ 分层存储（instant 层入场，模块 C）
   │
   ▼
⑥ 最小必要推荐（模块 D）──▶ ⑦ 受控投喂（模块 E）──▶ 用户
                                 │
   lifecycle_tick 每日定时 ◀────┘ 打开/打分行为回流
```

---

## 2. 模块 A：注意力门禁（admission）

### 2.1 功能定义

将原有"只过滤低质"的规则门禁升级为"过滤低质 + 限额准入"。分两段执行：

- **A-1 廉价去重**：在蒸馏前执行，节省 LLM 成本；
- **A-2 配额判定**：在蒸馏后执行，依赖 importance 三档标签。

### 2.2 全局配置（agentfeed.yaml 新增段）

```yaml
attention:
  admission:
    enabled: true
    daily_quota: 30                # 每日入库上限（条）
    weekly_quota: 150              # 每周入库上限（条）
    critical_bypass_quota: true    # critical 条目不受配额限制
    overflow: queue                # queue | reject（超额处理策略）
    queue_expire_days: 7           # 待审池过期天数
    dedup:
      enabled: true
      embedding_threshold: 0.92    # 余弦相似度判定重复阈值
      window_days: 30              # 查重时间窗
```

### 2.3 接口定义

**接口签名**：`admit(entry: RawEntry, stage: "pre_distill" | "post_distill") -> AdmissionDecision`

| 参数 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| entry | RawEntry | 是 | — | 管线既有产物对象 |
| stage | enum | 是 | pre_distill \| post_distill | 两段判定入口 |

**返回值 AdmissionDecision**：

```json
{
  "decision": "accept | queue | reject",
  "reason": "ok | duplicate | quota_exceeded | low_importance | rule_filtered | queue_expired",
  "importance": "critical | useful | noise | null",
  "duplicate_of": "entry_id | null",
  "quota_snapshot": { "daily_used": 12, "daily_left": 18, "weekly_used": 88 }
}
```

### 2.4 判定规则表

| 阶段 | 条件 | 决策 | 去向 |
|---|---|---|---|
| A-1 | 与 30 天内已有条目余弦相似度 ≥ 0.92 | reject | 冷归档，reason=duplicate |
| A-2 | importance = noise | reject | 冷归档，reason=low_importance |
| A-2 | importance = critical 且 critical_bypass_quota=true | accept | instant 层（不占配额） |
| A-2 | importance = useful 且当日/周配额未满 | accept | instant 层（占配额） |
| A-2 | importance = useful 且配额已满 | queue / reject（按 overflow） | 待审池 |
| 待审池 | 超过 queue_expire_days 未处理 | 自动过期 | 冷归档，reason=queue_expired |

待审池出队规则：次日配额释放时按 importance 降序自动放行；用户可经 MCP `get_queue` 显式查看，**默认不推送、不显示数量**。

### 2.5 禁止动作（模块 A）

1. 禁止在规则门禁与去重阶段调用生成式 LLM（成本红线）
2. 禁止 accept 路径绕过查重
3. 禁止将待审池数量以红点/角标/推送形式暴露
4. 禁止任何自动上调配额的逻辑（配额只能由用户手动改配置）
5. 禁止 reject = 删除（reject 条目必须落入冷归档可检索）

---

## 3. 模块 B：三层摘要蒸馏（digest）

### 3.1 数据结构（Entry 蒸馏结果 Schema）

```json
{
  "hook": {
    "text": "≤30字核心结论",
    "verdict": "≤20字'是否值得深入'的判断句",
    "action": "ignore | keep | act_now | schedule",
    "generated_at": "ISO8601"
  },
  "brief": {
    "problem": "≤50字",
    "method": "≤50字",
    "conclusion": "≤50字",
    "limitation": "≤30字",
    "related": ["entry_id"]
  },
  "full": { "……现有完整摘要/标签/实体/要点/关系结构，原样保留……" }
}
```

### 3.2 全局配置

```yaml
attention:
  digest:
    hook_max_chars: 30             # hook 正文上限（字）
    hook_verdict_max_chars: 20     # hook 判断句上限（字）
    brief_trigger: first_open      # first_open | on_demand
    actions: [ignore, keep, act_now, schedule]
```

### 3.3 生成时机矩阵

| 层级 | 生成时机 | 触发方 | 失败兜底 | 消费场景 |
|---|---|---|---|---|
| hook | 蒸馏调用中同步输出（与 importance 合并同一次调用） | 管线 | 截取原文首行 | 列表页 3 秒决策 |
| brief | 用户首次点开时懒生成 | 前端/MCP 首次读取 | 生成中先返回 hook | 5 分钟碎片消费 |
| full | 现有管线时机 | 管线 | — | 深读场景 |

### 3.4 接口定义

**接口签名**：`get_summary(entry_id: str, level: "hook" | "brief" | "full" = "hook") -> SummaryObject`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| entry_id | str | 必填 | 条目 ID |
| level | enum | hook | brief 缺失时触发异步生成，本次先返回 hook（非阻塞） |

**蒸馏 LLM 输出 JSON 契约（prompt 约定，非代码）**：

```json
{
  "importance": "critical | useful | noise",
  "hook": { "text": "", "verdict": "", "action": "" }
}
```

### 3.5 禁止动作（模块 B）

1. 禁止为 hook / brief 新增独立 LLM 调用（hook 必须合并进现有蒸馏调用；brief 必须懒生成）
2. 禁止修改现有 full 蒸馏输出结构（向后兼容红线）
3. 禁止 hook 超 30 字（超长由后处理截断，禁止重新调用 LLM）
4. 禁止 action 枚举扩展携带"催促语义"（如 must_read / overdue）

---

## 4. 模块 C：时效分层存储（lifecycle）

### 4.1 全局配置

```yaml
attention:
  lifecycle:
    instant_ttl_hours: 72
    digest_ttl_days: 14
    digest_refresh_min_opens: 2    # 打开≥N次刷新停留期
    cold_reopen_repromote: true    # 用户显式打开冷层条目 → 升回 digest
    decay_check_cron: "0 3 * * *"  # 每日 03:00 执行衰减
```

### 4.2 层级规则表

| 层级 | 准入 | 流出 | 可见性 |
|---|---|---|---|
| **instant** | accept 条目一律先入此层 | 满 72h → digest | critical 强推送；useful 静默进即时区 |
| **digest** | instant 到期；冷层被用户显式打开 | 停留 14 天未被打开 → cold；打开 ≥2 次则刷新停留期 | 推荐池 / 投喂池 |
| **cold** | digest 超期；待审池过期；reject 条目 | 不可自动流出（仅用户手动清理） | 仅 `search_knowledge(include_cold=true)` 可达 |

### 4.3 Entry 新增字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| tier | enum | instant | instant / digest / cold |
| tier_entered_at | datetime | 入库时间 | 进入当前层的时刻 |
| last_accessed_at | datetime | = mtime | 旧数据迁移时以 mtime 填充 |
| open_count | int | 0 | 显式打开次数 |
| pinned | bool | false | 钉住后永不降级 |

### 4.4 接口定义

**接口 1**：`lifecycle_tick(now: datetime) -> DecayReport`

按 `decay_check_cron` 定时执行。返回：

```json
{ "demoted": ["entry_id"], "refreshed": ["entry_id"], "errors": ["str"] }
```

**接口 2**：`touch(entry_id: str, access_type: "read" | "search_hit" | "mcp_fetch") -> None`

更新 `last_accessed_at` 与 `open_count`；digest 层满足刷新条件时重置 `tier_entered_at`。

**接口 3**：`pin_entry(entry_id: str, pinned: bool) -> None`

### 4.5 禁止动作（模块 C）

1. 禁止任何自动删除（降级 ≠ 删除，冷层永久保留直至用户手动清理）
2. 禁止冷层条目出现在看板、推荐、投喂、推送的任何位置
3. 禁止生命周期任务改动 pinned 条目
4. 禁止检索命中自动将冷层条目升层（仅用户显式打开可回暖）
5. 禁止在降级时向用户发送提醒通知

---

## 5. 模块 D：最小必要推荐（recommend）

### 5.1 全局配置

```yaml
attention:
  recommend:
    engine: minimal_set            # minimal_set | legacy_max_push（灰度回退）
    marginal_top_k: 20             # 边际价值计算取已读近邻数
    similarity_floor: 0.85         # 高于此值视为"已掌握"，直接降权
    weights: { goal: 0.4, marginal: 0.3, quality: 0.3 }   # 必须合计 1.0
    goal_ttl_days: 30
    max_active_goals: 3
    ondemand_budget_cap: 20
```

**配置校验约束**：`weights` 三项之和必须为 1.0。

### 5.2 目标模型

```json
{
  "id": "goal_xxx",
  "description": "掌握 MCP 协议",
  "embedding": [],
  "created_at": "ISO8601",
  "expires_at": "ISO8601（默认 created_at + goal_ttl_days）",
  "status": "active | retired"
}
```

### 5.3 接口定义

| 接口 | 参数 | 返回 |
|---|---|---|
| `declare_goal(description: str, ttl_days: int = 30) -> Goal` | ttl_days ≤ 365；active 数超 `max_active_goals` 时拒绝并返回错误码 `GOAL_LIMIT` | Goal |
| `retire_goal(goal_id: str) -> None` | — | — |
| `list_goals() -> [Goal]` | — | Goal 列表 |
| `recommend(budget: int = 5, mode: "daily" \| "ondemand" = "daily") -> [Recommendation]` | 见下表 | 见下文 |

**recommend 参数约束**：

| 参数 | 约束 |
|---|---|
| mode=daily | budget 强制 clamp 为 `consumption.daily_feed_limit`，调用方传入值无效 |
| mode=ondemand | budget 上限 `ondemand_budget_cap`（20），结果不计入投喂配额，但计入消化报表的 off_feed 指标 |

### 5.4 评分公式（契约定义）

```
final = w_goal × goal_relevance + w_marginal × marginal + w_quality × quality

其中：
  goal_relevance = cos(候选embedding, 用户active目标embedding) 的最大值
  marginal       = 1 − max( cos(候选embedding, 已读条目embedding Top-K) )
                   （若 ≥ similarity_floor，marginal 置 0 并打"已掌握"标记）
  quality        = 现有规则分 + LLM 质量分（沿用旧管线，不改动）
```

**返回值 Recommendation**：

```json
{
  "entry_id": "…",
  "tier": "digest",
  "hook": { "text": "", "verdict": "", "action": "" },
  "score_breakdown": { "goal": 0.8, "marginal": 0.6, "quality": 0.7, "final": 0.71 }
}
```

### 5.5 禁止动作（模块 D）

1. 禁止推荐冷层条目
2. 禁止在无 active 目标时扩大召回范围兜底（此时仅按 quality + marginal 排序）
3. 禁止隐藏 score_breakdown（可解释性红线）
4. 禁止以点击率、停留时长、打开数作为推荐优化目标（此为注意力榨取指标）；推荐只允许优化：目标相关度、边际信息量、内容质量
5. 禁止自动续期 goal（到期自动转 retired，需用户手动重建）
6. 禁止恢复">14 天未更新"类停滞催更逻辑

---

## 6. 模块 E：受控投喂与消化闭环（consumption）

### 6.1 全局配置

```yaml
attention:
  consumption:
    daily_feed_limit: 5            # 每日投喂上限（硬性）
    feed_refresh_hour: 8           # 每日投喂批次生成时间
    over_limit_display: none       # none | count_only
    deep_read_min_seconds: 90      # 深读判定时长阈值
    focus_mode:
      default_minutes: 120
      max_minutes: 240
      mcp_snapshot_only: true
    report_window_days: 7
```

**配置校验约束**：`daily_feed_limit ≤ daily_quota`；`focus_mode.max_minutes` 为全局硬上限，改配置不可突破。

### 6.2 接口定义

**接口 1**：`get_today_feed() -> FeedBatch`

```json
{
  "date": "2026-09-25",
  "entries": ["…≤ daily_feed_limit 条 Recommendation…"],
  "quota_used": 3,
  "quota_left": 2,
  "refill_at": "2026-09-26 08:00"
}
```

达到上限后的返回行为由 `over_limit_display` 控制：`none` = 不返回剩余条目且不提示数量；`count_only` = 仅返回"还有 N 条，明日 08:00 补充"。

**接口 2**：`set_focus_mode(on: bool, duration_min: int = 120) -> FocusState`

```json
{
  "active": true,
  "until": "ISO8601",
  "effects": { "push_blocked": true, "badge_hidden": true, "mcp_snapshot_only": true }
}
```

约束：`duration_min ≤ max_minutes`；超限返回错误码 `FOCUS_CAP`；到期自动解除，不可叠加续期。

**接口 3**：`rate_entry(entry_id: str, usefulness: int, one_line_use: str | null = null) -> None`

| 参数 | 约束 |
|---|---|
| usefulness | 1–5 整数 |
| one_line_use | ≤50 字，说明"这条信息用在哪"；选填 |

### 6.3 消化指标定义（替代原周目标环）

| 指标 | 计算定义 | 展示倾向 |
|---|---|---|
| deep_read_ratio | 深读条数 ÷ 打开条数（深读 = 单条停留 ≥ `deep_read_min_seconds` 或调用了 full 摘要） | 越高越好，鼓励少而深 |
| scan_ratio | 打开未达深读阈值的条数 ÷ 打开条数 | — |
| rating_rate | 已打分条数 ÷ 打开条数 | — |
| used_ratio | 填写 one_line_use 或行动条数 ÷ 打开条数 | — |
| off_feed_open_ratio | 非当日投喂批次打开的条数 ÷ 总打开条数 | 监测"绕开投喂"行为，仅报表展示，不拦截 |

**接口 4**：`get_digestion_report(window_days: int = 7) -> DigestionReport`

约束：window_days ∈ [7, 90]，返回上述五项指标的时间序列。

### 6.4 禁止动作（模块 E）

1. 禁止提供"临时提高今日上限"的即时入口（调整只能改配置文件且次日生效）
2. 禁止在界面任何位置显示全局未读数、红点、角标
3. 禁止恢复周目标环、"执行队列进度""停滞提示"等催读组件
4. 禁止出现"你落后了 / 还剩 N 篇未读"类文案
5. 禁止投喂池外条目出现在看板默认视图
6. 禁止将 off_feed_open_ratio 用于拦截用户行为（只统计、不惩罚）

---

## 7. 模块 F：MCP Server 接口变更清单

| Tool | 变更类型 | 参数变更 | 行为变更 |
|---|---|---|---|
| `getContext` | 修改 | 新增返回字段 `focus_mode: {active, until}`；条目新增 `source: "snapshot" \| "feed" \| "cache"` | focus_mode 生效期间仅返回已打开条目的缓存快照，不含 instant 层新条目 |
| `search_knowledge` | 修改 | 新增 `include_cold: bool = false`；结果条目新增 `tier` 字段 | 默认不检索冷层 |
| `get_today_feed` | 新增 | 无入参 | 返回当日受控投喂批次（模块 E） |
| `set_focus_mode` | 新增 | on, duration_min | 见模块 E |
| `rate_entry` | 新增 | entry_id, usefulness, one_line_use? | 见模块 E |
| `declare_goal` / `retire_goal` / `list_goals` | 新增 | 见模块 D | 见模块 D |
| `get_digestion_report` | 新增 | window_days=7 | 见模块 E |
| `get_queue` | 新增 | 无 | 仅显式查看待审池，返回条目带 `expire_at` |
| `pin_entry` | 新增 | entry_id, pinned | 见模块 C |

### 禁止动作（模块 F）

1. 禁止新增任何 push / notify / subscribe 类 MCP 工具（MCP 只做拉取，不做推送）
2. 禁止任何 MCP 工具绕过 daily_feed_limit 与 focus_mode（所有返回条目的工具统一走投喂闸门）
3. 禁止在工具 description 中诱导调用方请求更多条目
4. 禁止为"绕过专注模式"提供任何参数开关

---

## 8. 数据模型变更与迁移原则

### 8.1 新增表

| 表 | 关键字段 | 用途 |
|---|---|---|
| admission_log | ts, decision, reason, importance, source_agent | 配额审计 |
| goals | id, description, embedding, created_at, expires_at, status | 目标 |
| feed_log | date, entry_id, opened, deep_read, rated, usefulness, off_feed | 消化统计 |
| queue_pool | entry_id, queued_at, expire_at | 待审池 |

### 8.2 迁移原则

1. **只增不改不删**：禁止修改或删除既有表字段，旧数据 `tier` 默认填 `digest`，`last_accessed_at` 默认填 `mtime`。
2. 迁移脚本必须**可重入、可回滚**。
3. `features.*` 全部关闭时，系统行为必须与旧版本**完全一致**（功能对等验收）。

### 8.3 灰度开关（features）

```yaml
attention:
  features:                        # off 时走旧路径，保持功能对等
    attention_gate: true
    tiered_storage: true
    minimal_recommend: false
    controlled_feed: false
```

---

## 9. 验收标准

| 指标 | 基线（现状） | 目标 |
|---|---|---|
| 日均入库条数 | 无上限 | ≤ daily_quota 的 80% |
| 用户日均打开条数 | 无约束 | ≤ daily_feed_limit |
| hook 层单条决策时长 | — | ≤ 3 秒/条 |
| deep_read_ratio | — | ≥ 40% |
| 冷层占比（运行 90 天后） | — | ≥ 60%（说明系统在替大脑"背"信息） |
| 旧功能对等回归 | — | features 全关时 100% 通过旧用例 |

---

## 10. 实施节奏

| 阶段 | 范围 | 说明 |
|---|---|---|
| **P0**（1–2 周） | 模块 B（hook + importance）+ 模块 E 的 daily_feed_limit + 红线清理（下线未读徽标与停滞提示） | 改动最小、收益最大 |
| **P1** | 模块 A + 模块 C + focus_mode | 供给端限额与库容瘦身 |
| **P2** | 模块 D + 消化报表 | 消费端哲学切换，待用户形成新习惯后开启 |

---

## 11. 全局禁止动作总表

**数据与隐私**

1. 禁止任何遥测、数据外发、云同步（维持 local-first；LLM 调用仅限摘要所需最小文本）
2. 禁止任何自动删除用户数据的行为（降级、过期、reject 均不等于删除）

**架构与成本**

3. 禁止为 hook / brief 新增独立生成式 LLM 调用
4. 禁止在规则门禁与去重阶段调用生成式 LLM
5. 禁止引入新的外部服务依赖（推送服务、消息通道等）
6. 禁止修改或删除既有 SQLite 字段（只允许新增表与字段）

**产品行为（反焦虑红线）**

7. 禁止未读数、红点、角标、进度羞辱类 UI 元素与文案
8. 禁止恢复停滞催更（>14 天未更新提示）及一切"你落后了"式提示
9. 禁止提供绕过每日投喂上限或专注模式的任何后门（配置即时改、隐藏参数、特殊工具均算）
10. 禁止以点击率 / 停留时长 / 打开数作为任何模块的优化目标

**推荐与检索**

11. 禁止冷层条目进入推荐、投喂、看板、推送
12. 禁止隐藏推荐评分明细（score_breakdown 必须随结果返回）

---

## 结语

本方案把 AgentFeed 的稀缺性假设从"知识稀缺"切换到"注意力稀缺"——供给端用门禁和分层控量，消费端用投喂上限和专注模式留白，中间用三层摘要把"读不读"的判断成本压缩到 3 秒。所有禁止动作共同守住一条底线：

**系统可以替用户记住一切，但绝不能催促用户消化一切。**
