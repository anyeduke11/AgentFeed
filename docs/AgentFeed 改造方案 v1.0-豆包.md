# AgentFeed 改造方案：从知识库到注意力管家

> 版本：v1.0 ｜ 状态：方案设计（不改代码）
> 核心命题：知识不再稀缺，注意力与大脑处理容量才是稀缺资源。
> 改造目标：让 AgentFeed 从"收集—分类—推荐"的 feed 形态，转向"过滤—分级—控量"的注意力管家形态。

> ---
> **【评审标记 2026-09-26】状态：已评审——库侧衰减/周度聚合/MCP 熵减/行为红线四项采纳，预算面与元宝同病推迟。**
> 评审产物：`docs/attention-budget-review-and-plan.md` v1.1（§0 双方案合成结论 + §4 双方案映射表）。
> 采纳亮点：M5 使用侧衰减（last_touched 90d/180d，对 74k 拉取式存量立即生效，优于元宝入库时间 TTL）、M4 周度一页纸（聚合级压缩）、M6 安全忽略报告（抑制可解释性产品化）、M7 纯熵减 MCP（无元宝注意力预算概念混淆）、§5 禁止动作清单（整体收编为实施红线）、L0/L1/L2 三级消费骨架。
> 核心修正：①预算机器（900s）在真实基线（日均阅读趋近零）下为休眠死代码，与元宝一并推迟至阶段③；②novelty 全库相似度继承元宝领域偏差且未算 74k embedding 成本；③领域级 24h 冷却粒度过粗（读完一篇≈冷却大半个库）；④「主动检索次数应下降」与拉取式使用现状相悖；⑤M6 理由分类器能力不存在。逐项处置见评审文档 §4。
> ---

---

## 1. 背景与诊断

### 1.1 当前架构的隐含假设

AgentFeed 当前管线为：

```
Agent 数据目录 → 双通道采集 → 内容门禁（体积/代码占比）→ SQLite → LLM 蒸馏（摘要/标签/向量）→ Web 看板 + MCP
```

其隐含假设是**信息稀缺时代**的：知识散落各处，收进来、分类好、方便找回来就是价值。

### 1.2 与新困境的冲突点

| 环节 | 当前行为 | 冲突本质 |
|---|---|---|
| 门禁 | 只挡"低质垃圾"，入库量只增不减 | 不判断"值不值得占用注意力" |
| 推荐 | 规则分 + 质量分排序，每日精选置顶，周目标催阅读量 | 加量逻辑，默认你读得不够多 |
| 消费 | 站内阅读器为默认入口，要求 25/50/75/100% 进度 | 最高认知成本档被当成默认 |
| MCP 出口 | `search_knowledge` 返回条目，`read_entry` 读全文 | 把原始认知负担转给 Agent，再转给人 |
| 知识生命周期 | 只增不减，无衰减/遗忘 | 推荐池持续膨胀，永久占用决策带宽 |

### 1.3 改造后的成功指标

产品度量从"系统产出了多少"反转为"替你省了多少注意力"：

- **注意力预算执行率**：本周实际摄入时长 / 预算时长
- **高价值命中率**：L2 精读后用户标记"值得行动"的比例
- **安全忽略率**：被冷归档/跳过清单覆盖、且用户未主动召回的比例
- **日均主动检索次数**（应下降）：系统推得准，你不需要主动搜

---

## 2. 改造总览

改造分七个模块，均在现有采集/存储层之上叠加，不破坏既有管线：

| 模块 | 解决问题 | 优先级 |
|---|---|---|
| M1 注意力门禁与分级 | 入库后、推荐前预判认知成本与新增信息量 | P0 |
| M2 三级消费模型 | 默认从最轻粒度开始，全文需主动升级 | P0 |
| M3 摄入预算与消化冷却 | 控制总量，给大脑留沉淀空间 | P0 |
| M4 主题聚合一页纸 | 用 3–5 段话替代 N 条条目流 | P1 |
| M5 遗忘与冷归档 | 知识断舍离，不删数据但不再打扰 | P1 |
| M6 每周"安全忽略"报告 | 缓解 FOMO，给人关掉电脑的理由 | P2 |
| M7 MCP 出口熵减 | Agent 之间传结论，不传原文堆 | P1 |

---

## 3. 数据模型变更

在现有 SQLite 19 表基础上，新增/扩展以下字段（不破坏既有表）。

### 3.1 `files` 表扩展

| 字段 | 类型 | 说明 |
|---|---|---|
| `attention_level` | TEXT ENUM | `L0` 扫标题即可 / `L1` 读摘要 / `L2` 值得精读。门禁打分后写入 |
| `cognitive_cost_sec` | INTEGER | 预估阅读秒数（按篇幅+密度估算） |
| `novelty_score` | REAL 0–1 | 相对库内已有条目的新增信息量（重复度越高越低） |
| `superseded_by` | TEXT NULL | 被哪个 entry_id 取代；被取代后自动降权 |
| `last_touched_at` | DATETIME | 最后一次被人工打开 / MCP 调用的时间 |
| `touch_count` | INTEGER DEFAULT 0 | 累计被触及次数 |

### 3.2 新表 `attention_budget`

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | DATE PRIMARY KEY | 自然日 |
| `budget_sec` | INTEGER | 当日预算秒数（默认 900 = 15 分钟） |
| `spent_sec` | INTEGER DEFAULT 0 | 当日已消耗秒数 |
| `cool_until` | DATETIME NULL | 同领域冷却截止时间 |
| `cool_domain` | TEXT NULL | 冷却针对的领域 |

### 3.3 新表 `digest_queue`（消化队列）

| 字段 | 类型 | 说明 |
|---|---|---|
| `file_id` | TEXT | 关联 files |
| `digest_state` | TEXT ENUM | `consumed` 已读待沉淀 / `digested` 已消化 / `archived` 已归档 |
| `consumed_at` | DATETIME | 读完时间 |
| `digested_at` | DATETIME NULL | 用户标记"已消化"或系统自动判定 |
| `action_taken` | BOOLEAN DEFAULT FALSE | 是否产生了后续行动 |

---

## 4. 模块详细设计

### M1. 注意力门禁与分级

**触发时机**：文件过现有内容门禁、入库后、LLM 蒸馏完成后。

**打分输入**：

- `cognitive_cost_sec` = f(字符数, 代码占比, 图表密度, 是否依赖外部上下文)
- `novelty_score` = 1 − max(与库内同领域条目的 embedding 相似度)
- `quality_score` = 现有 LLM 质量分

**分级规则**：

```
if quality_score < 0.3:                      level = L0（入库不推）
elif novelty_score < 0.2 and cost < 120:    level = L0
elif cognitive_cost_sec > 600:              level = L2（需主动展开）
else:                                        level = L1
```

**REST API**：

```
POST /api/files/:id/attention-level
Request:  {}
Response: {
  "file_id": "…",
  "attention_level": "L1",
  "cognitive_cost_sec": 180,
  "novelty_score": 0.74,
  "quality_score": 0.81,
  "reason": "新增信息量高，预估 3 分钟读完"
}

GET /api/files?min_level=L1&domain=backend&limit=20
Response: { "items": [...], "total": 42 }
```

---

### M2. 三级消费模型

**入口默认行为**：

- 总览页只渲染 `attention_level ∈ {L1, L2}` 的卡片，且只展示标题 + 一句话判断。
- L0 条目**不出现**在任何推荐流，只能通过主动搜索到达。
- L1 卡片点击后直接展开 LLM 摘要，不进入阅读器。
- L2 摘要下方展示按钮"展开原文精读"，点击才进阅读器。

**REST API**：

```
GET /api/feed/today
Response: {
  "budget": { "budget_sec": 900, "spent_sec": 420, "remaining_sec": 480 },
  "items": [
    {
      "file_id": "…",
      "level": "L1",
      "title": "…",
      "one_liner": "一句话判断",
      "summary": "LLM 摘要全文（≤300字）",
      "cost_sec": 180,
      "domain": "backend"
    }
  ],
  "cooling": { "domain": "infra", "cool_until": "2026-09-26T10:00:00Z" }
}

POST /api/reader/:id/upgrade-to-full
Request:  { "user_estimated_minutes": 5 }
Response: { "started_at": "…", "budget_debit_sec": 300 }
```

**阅读器消耗记账**：进入 L2 阅读器时按 `cognitive_cost_sec` 从当日预算预扣；退出时按实际停留时长结算。

---

### M3. 摄入预算与消化冷却

**预算规则**：

- 默认 `budget_sec = 900`（15 分钟/天），用户可在设置页调整 300–3600。
- 当日 `spent_sec >= budget_sec` 后：`GET /api/feed/today` 返回空 items，仅显示冷却提示。
- 预算不跨日结转，次日重置。

**消化冷却规则**：

- 用户读完一篇 L2 并标记"已读"时：写入 `digest_queue`，`digest_state = consumed`，并设置 `cool_until = now + 24h`，`cool_domain = 该文领域`。
- 冷却期内，同领域新条目即使达到 L1/L2，也不出现在 `today` feed。
- 用户主动将 `digest_state` 标记为 `digested` 后，冷却提前解除。

**REST API**：

```
GET /api/budget/today
Response: { "date": "2026-09-25", "budget_sec": 900, "spent_sec": 420, "cooling": null }

POST /api/digest/:id/consume
Request:  { "state": "consumed" }
Response: { "cool_until": "2026-09-26T11:30:00Z", "cool_domain": "backend" }

POST /api/digest/:id/digest
Request:  { "action_taken": true }
Response: { "digested_at": "…", "cooling_released": true }
```

---

### M4. 主题聚合一页纸

**触发**：每周日 08:00（本地时区）批量任务，或用户手动触发。

**输入**：本周入库的 L1+ 条目，按领域 + embedding 聚类成 3–5 个主题簇。

**LLM 产出**：每簇一段 ≤150 字的"本周这个领域发生了什么"，并标注簇内真正值得展开的 1 条原文（如有）。

**REST API**：

```
GET /api/digest/weekly?week=2026-W39
Response: {
  "week": "2026-W39",
  "total_items": 47,
  "covered_in_digest": 5,
  "clusters": [
    {
      "topic": "MCP 工具调用稳定性",
      "one_paragraph": "……（≤150字）",
      "worth_expanding": { "file_id": "…", "title": "…" },
      "member_count": 12
    }
  ],
  "skipped_safely": 42
}

POST /api/digest/weekly/generate
Request:  {}
Response: { "job_id": "…", "status": "queued" }
```

---

### M5. 遗忘与冷归档

**自动任务**：每日 03:00 扫描。

**降权规则**：

```
if last_touched_at < now - 90d and touch_count <= 1:
    attention_level 降级为 L0（不进推荐流，仍可搜索）
if last_touched_at < now - 180d:
    标记 cold_archived = true（搜索结果默认折叠，需显式展开）
if superseded_by is not null:
    立即降为 L0
```

**不删除任何原文**，仅改变推荐可见性。

**REST API**：

```
POST /api/maintenance/cold-archive
Request:  { "dry_run": true }
Response: { "would_demote": 23, "would_archive": 8, "samples": [...] }

GET /api/files?cold_archived=true&limit=20
Response: { "items": [...], "total": 8 }
```

---

### M6. 每周"安全忽略"报告

**与 M4 同期生成**，面向用户的一段总结：

> 本周 5 个 Agent 共产出 47 篇。你主动读了 3 篇。以下 42 篇未读，系统判断你不需要读，主要理由是：与上周已读内容重复（18）、属于中间过程草稿（14）、领域与你当前项目无关（10）。

**REST API**：

```
GET /api/report/safe-to-skip?week=2026-W39
Response: {
  "total_produced": 47,
  "user_read": 3,
  "safe_to_skip": 42,
  "breakdown": { "duplicate": 18, "intermediate_draft": 14, "off_topic": 10 },
  "items": [ { "file_id": "…", "reason": "duplicate" } ]
}
```

---

### M7. MCP 出口熵减

**改造现有工具签名**：

```
# 现有（保留，但降级为内部工具）
search_knowledge(query: string, limit: number) -> Entry[]
read_entry(file_id: string) -> FullText

# 新增（Agent 默认应优先调用）
get_headlines(query: string, top_n: number = 5) -> Headline[]
  # 只返回标题 + one_liner + attention_level，不返回摘要正文

get_summary(query: string) -> DigestResult
  # 返回一段结论性摘要 + 最多 1 个溯源 file_id，不返回原文片段
  # Agent 若需要原文，必须显式调用 read_entry

get_weekly_digest(week?: string) -> WeeklyDigest
  # 直接拿到 M4 的一页纸结果
```

**MCP 工具行为约束**：

- `get_summary` 返回内容长度硬上限 800 字。
- 单条响应最多携带 1 个 `file_id` 溯源链接，不批量返回 N 条条目。
- Agent 调用 `read_entry` 需在调用参数中声明 `purpose: string`，用于记账 `touch_count`。

---

## 5. 禁止动作（红线）

以下行为在改造后**禁止出现**，无论用户配置如何：

### 5.1 推荐与推送

- **禁止**在当日注意力预算耗尽后仍推送新条目到 `today` feed。
- **禁止**在冷却期内将同领域条目排入推荐流。
- **禁止**默认把 L0 条目展示在任何总览/看板首页。
- **禁止**用红点、角标、数字未读计数等强提醒元素推送条目（避免制造 FOMO）。
- **禁止**跨日结转或累积预算——每日预算用完即止，不制造"今天没读就亏了"的焦虑。

### 5.2 消费粒度

- **禁止**未经用户点击"展开原文"就把 L2 全文渲染在 feed 流里。
- **禁止**在 MCP 响应中默认返回 `read_entry` 的全文内容；Agent 必须显式调用。
- **禁止**把 LLM 摘要长度超过 300 字直接推送到 feed 卡片（摘要页可更长）。

### 5.3 数据与隐私

- **禁止**因任何原因删除用户已入库的原文文件——冷归档只改可见性，不删数据。
- **禁止**在未配置 LLM 服务商时，以本地规则模拟"质量分"并冒充 LLM 判断结果。
- **禁止**把 `digest_queue` 的消化状态、行动记录外发给任何第三方（包括默认配置的 LLM）。
- **禁止**MCP 工具以任何方式监听网络端口（维持 stdio-only）。

### 5.4 产品行为

- **禁止**把"周阅读完成率"作为正向指标展示给用户——它是加量逻辑的残余。
- **禁止**自动替用户标记 `digested`（消化必须由用户主动确认，系统不能假设"你没说就是消化了"）。
- **禁止**在用户连续阅读超过 30 分钟后仍继续推送 L2 条目（应提示休息）。

---

## 6. 迁移与兼容

- 现有 19 张表只读，新字段全部可空，旧版本升级后无需回填即可运行。
- 现有 MCP 工具 `search_knowledge` / `read_entry` 保留签名不变，仅在文档中标注"高级/显式调用"。
- 现有阅读进度、打分数据原样保留，映射到 `digest_queue` 的 `consumed` 状态。
- 默认配置：`budget_sec = 900`，`cooling_hours = 24`，`demote_after_days = 90`，`archive_after_days = 180`。全部可在设置页调整，用户可一键关闭全部新模块回退到旧行为。

---

## 7. 改造优先级

| 阶段 | 模块 | 交付物 |
|---|---|---|
| 第一阶段（2 周） | M1 + M2 + M3 | 注意力分级、三级 feed、预算与冷却——立刻降低每日摄入 |
| 第二阶段（2 周） | M5 + M7 | 冷归档自动任务、MCP 工具拆分——长期减负 |
| 第三阶段（1 周） | M4 + M6 | 周度一页纸 + 安全忽略报告——周维度复盘 |
