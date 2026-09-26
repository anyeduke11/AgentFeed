# 注意力预算改造：评审结论与修订路线（基于真实基线）

> 版本：v1.3 · 2026-09-26
> 性质：**评审 + 修订方案（终版排期）**。上游 spec ×3：`AgentFeed注意力预算改造方案-元宝.md`（v2.0 草案）、`AgentFeed 改造方案 v1.0-豆包.md`、`agentfeed-refactor-plan-智谱清言.md`（AF-RFC-2026-001，均已在文头打评审标记）。
> 数据锚点：2026-09-26 从生产库 `app.db` 拉取的真实消化基线（见 §2）。
> 排期状态：三份方案评审完成（3/4，第 4 份待发；如无新机制将仅增量并入映射表，不再改路线）。**本版起 §6 为可开工的实施排期。**

---

## 0. 三方案合成结论

三份方案共享同一诊断（注意力稀缺、门禁只有下限、压缩≠减量），能力分布互补：

- **元宝强在入库侧时间抑制**：冷却池是唯一不依赖用户行为数据/LLM 成本的减负机制
- **豆包强在库侧与周维度**：M5 使用侧衰减直击「过载在库不在流」（74k 拉取式存量立即生效）；M4 周度一页纸补聚合粒度；M6 安全忽略报告做可解释性；M7 纯熵减 MCP 无概念混淆；§5 行为红线成熟
- **智谱强在工程与成本素养**：①三层摘要生成时机矩阵（hook 并入既有蒸馏调用零新增成本 / brief 懒生成 / 超长截断禁重调）是全场唯一真降本设计；②marginal（以**已读集**为参照的边际信息量）替代全库参照 novelty，是唯一贴合拉取式基线的评分参照系；③A-1 廉价去重前置到蒸馏前（省 LLM 成本，判冷不判死）；④features 灰度开关全关=行为对等、迁移只增不改不删、score_breakdown 可解释——工程护栏最完整；⑤§11 禁止动作总表（四域 12 条）最全
- **三者共病**：投喂/预算/消化机制全部架在「用户会来标记」的假设上，而真实基线消化信号 ≈ 零（§2）——预算面三案齐推，全部进阶段③
- **智谱独有否决**：daily_quota 30 入库配额直接管采集端（本地库价值锚点=全量留存，187 条/天配额 30 = 84% 产物进待审池→自动判冷，自断「跨项目阅历沉淀」粮草；且待审池放行按 importance 排序、importance 产自蒸馏、蒸馏在去重后——没过配额的条目拿不到 importance，管线 DAG 有环）；focus_mode 的 MCP 快照-only 把人的专注外溢成 agent 任务降级（元宝概念混淆病的变体）；deep_read_ratio≥40% / 冷层占比≥60% 两个验收值没对过存量基线（后者按 74k 未触及存量跑 90 天≈100%）

**合成公式**：入库冷却（元宝）× 蒸馏前去重（智谱 A-1）× 库侧使用衰减（豆包 M5）× 三层摘要（智谱骨架+元宝字段）× 周度聚合（豆包 M4/M6）× marginal 评分（智谱）× 出口熵减（豆包 M7）× 行为红线（智谱 §11 为主+豆包 §5 并入）× 预算推迟（三案同判）

---

## 1. 对元宝方案的评审结论

**总判定：哲学方向采纳，落地规格重构。** 「门禁只有下限没有上限」「压缩≠减量」「用死亡率的思维替代增长率」三个诊断在 74k 文件的真实库上成立。但按本库现状，其阶段划分与参数体系需要重排。

### 1.1 采纳（无条件）

| 元宝条目 | 理由 |
|---|---|
| 冷却池机制（T3 表，24~72h 静置、死亡判死） | 全文最好设计：不依赖用户行为数据的唯一减负机制，且与红线 3（幂等加表）兼容 |
| 生命周期分层 hot/warm/cold + TTL 自动下沉 | 「未消费不堆积为焦虑」直接可落地，只动 files 侧写 |
| 指标反转：suppression/cooling_death 进入看板 | 方向正确（但阈值重定，见 1.3） |
| 决策卡片作为「代读层」复用蒸馏产物 | 不建新层，llmWorker 已产摘要/要点，对入选条目补结构化输出即可 |

### 1.2 重构（方向对、落点错）

| 元宝条目 | 问题 | 修订 |
|---|---|---|
| 阶段一「几乎不动架构」 | 冷却闸门要在 scanner→recommend 链路插强制拦截点，首屏改造横跨 8 页，是被低估的 UX 大改 | 重排为三阶段（见 §3），冷却池先行、配额最后 |
| MCP 预算化（attention_budget_status 扣注意力配额） | 概念混淆：MCP 拉取是任务驱动的机器消费，花的是任务 token 不是人的注意力；agent 不会因额度自停 | 拆开：`get_minimal_context` 的 token 效率目标保留（属检索质量）；注意力配额只管「推」的面（daily/精选/feed），不管「拉」的面 |
| goals 表（T2）与现有周目标双轨 | 阅读闭环 M1~M5 的周目标是既有目标系统，v2 只给 recommendations 加 3 字段就引入第二套 | 推迟：先在现有周目标上验证「目标相关加权」，需要独立 goals 表时再迁 |

### 1.3 否决或降级（数据不支持 / 概念不成立）

| 元宝条目 | 判定 | 依据 |
|---|---|---|
| `digestion_rate` 自适应规则（4.4，<0.4 降额、<0.3 连续两周进 digestion_first） | **推迟到阶段③之后** | 真实基线消化率 ≈ 0.1（§2），上线即触发「暂停供给」——规则会锁死系统；且消化信号源本身近乎为零（12 天 1 条打分） |
| `suppression_rate ≥ 95%` 目标 | 降级为观测项 | 日采集 ~187 vs 配额 3，第一天什么都不做即 98.4%，天然满足的数字没有信息量 |
| `need_read` 以 confidence<0.7 卡阈值 | 降级 | LLM 自报 confidence 校准性差，用噪声做闸门；改为「卡片缺失关键字段即 need_read=1」的结构化判定 |
| novelty 同源同主题 ×0.3 惩罚 | 移除该乘子 | 本库语料高度领域聚集（网络安全 1362 篇），该乘子系统性压制核心领域增量更新，与 R 因子方向对冲 |
| trust 来源分类器（官方 0.8/解读 0.5） | 推迟 | 需要现在不存在的来源分类能力；先用 agent 归因（已有 source_agent）做粗粒度区分 |

### 1.4 元宝方案未覆盖、修订路线需要补的

- **存量迁移**：74k 既有文件如何入冷却语义（不能全量重冷却，按 mtime 分批）；WebClip 剪藏产物（用户主动行为）应豁免冷却直接入 hot。
- **消化信号的产品化**：现两维打分 12 天 1 条——信号源比算法更优先。
- **与 G1 日预算（LLM 成本）的命名分家**：设置页将出现两个「预算」，需显式区隔（注意力预算 / 蒸馏预算）。

---

## 2. 真实消化基线（2026-09-15 ~ 09-26，生产库实测）

| 指标 | 数值 | 备注 |
|---|---|---|
| read_history 总量 | 46 次 / 10 个去重文件 | 日均 3.8 次、**0.8 个文件/天** |
| 消化信号（打分） | **1 条**（9/16，4 星 later） | reading_feedback 表 |
| 供给面打开（daily/pool/exec/preview） | 仅 9/15-16 两天共 3 个文件，此后归零 | 每日精选/推荐池实际零消费 |
| reader 渠道 38 次 | 其中 28 次为 webclip e2e 开发流量 | 真实站内阅读 ≈ 个位数 |
| 推荐池 | 历史仅 10 文件曾入池，当前 active = 0 | 供给侧近乎空转 |
| exec_queue | 4 行 | 打分→执行链路有零星使用 |

**三条硬结论**：
1. **过载的位置在库，不在消息流**——当前系统没有在「推」（池空、精选零打开），是纯拉取式使用。给没人走的路装红绿灯（配额闸门）没有意义。
2. **消化信号无米之炊**——元宝方案阶段二/三全部架在 digestion_log 上，但这个信号源今天近乎为零，必须先建信号再建算法。
3. **0.8 条/天的真实基线** vs 元宝拍的配额 3——参数必须从数据出发，且自适应规则在低基线下会锁死系统。

---

## 3. 修订路线：三阶段（依赖排序：先减负 → 再建信号 → 后配额）

### 阶段 ① 冷却池 + 生命周期（不依赖任何用户行为数据，立刻减负）

范围：
- 新表 `cooling_pool`（CREATE IF NOT EXISTS + ensureColumns，红线 3）：file_id / entered_at / release_at / status(cooling|promoted|expired) / death_reason
- 入池闸门：scanner 入库 → 默认入冷却（`release_at = entered_at + cooling_hours`，config `attention.coolingHours` 默认 48h）；**豁免清单**：WebClip 产物（用户主动剪藏=已表达兴趣）、路径白名单命中、filenameWhitelist 命中（AGENTS.md 等）
- **蒸馏前廉价去重（智谱 A-1）**：入冷却前对 30 天窗口内条目做 embedding 余弦查重（≥0.92），命中判 `duplicate` 落冷（可检索），**不判死**——位置前置省 LLM 蒸馏成本；embedding 未启用时降级为标题+关键词近似并标注 degraded
- 冷却结束 → 出池进推荐候选；到期未消费 → expired 判死（可查可恢复，同门禁 skipped 语义）
- 生命周期分层（**合成：元宝 TTL + 豆包 M5 使用侧衰减，取后者为主**）：files 加 `lifecycle`(hot|warm|cold) + `lifecycle_deadline` + `last_touched_at` + `touch_count` + `pinned`（ensureColumns 幂等加列）；`last_touched_at` 由 read_history / MCP read_entry 调用回写（智谱 touch 语义：read/search_hit/mcp_fetch 都算触及）；每日 job 执行下沉：**90d 未触及且 touch_count ≤1 → 降推荐可见性；180d 未触及 → cold（搜索默认折叠）；pinned 永不降级**——对 74k 拉取式存量立即生效
- 指标：suppression_metrics 日表（collected / deduped / cooling_died / delivered / digested 起步）；**智谱 daily_quota 改造为观测仪表**——记录「若配额 30 生效今日超额多少」只记不拦，为将来是否需要供给端限额积累数据
- **红线清理先行（智谱 P0 动作，即豆包 §5 的执行面）**：下线总览/看板未读徽标与「>14 天停滞」催更提示

验收门禁：
1. 新采集条目 100% 过冷却闸门（豁免清单除外），无旁路
2. `cooling_death_rate` 连续 7 天可计算且在可解释区间（先观测真实值，不强设 60~80% 目标）
3. 存量迁移按 mtime 分批完成，无一次性全量重冷却
4.（豆包 M5）`last_touched_at` 回写链路（Web 打开 + MCP read_entry）上线；首跑 dry_run 报告 would_demote/would_archive 数量先观测再启用
5.（智谱 A-1）去重前置后蒸馏队列日均入队量下降可观测；灰度开关 `attention.features.*` 全关 = 行为与改造前完全一致（对等回归）

### 阶段 ② 消化动作极简化（先建信号源，再谈算法）

范围：
- 轻量消化动作：`POST /api/v2/digest`（或挂在既有 reading 路由下）——一个动作三个参数可选（conclusion ≥10 字 / minutes / drop），读毕 100% 自动提示一键 digest；**禁止系统自动标记 digested**（豆包 §5.4 红线收编）；**并入智谱 one_line_use**（≤50 字「这条信息用在哪」，比 conclusion 更指向行动，两者二选一填即算消化信号）
- **三层摘要（智谱 B 骨架 + 元宝卡片字段合成）**：hook（≤30 字结论 + ≤20 字判断 + action 枚举 ignore/keep/act_now/schedule）**并入现有蒸馏调用同步输出，零新增 LLM 成本**；brief（problem/method/conclusion/limitation 四段各 ≤50 字）首次打开懒生成，生成中先返 hook；full=现有蒸馏产物原样。呈现层用豆包 L0/L1/L2（hook=列表 3 秒决策 / brief=碎片消费 / full+阅读器=深读）
- 评分参照系切换：**marginal（智谱）替代全库 novelty**——`1 − max(sim(候选, 已读条目 Top-K))`，已读集为参照天然只压制「看过类似的」；≥0.85 打「已掌握」标记置 0（可解释）；embedding 未启用降级关键词近似 + degraded 标注
- **周度一页纸（豆包 M4）**：每周日日批（复用 startDailyReportJob 模式），本周 L1+ 条目按领域聚类 3-5 簇，每簇 ≤150 字「本周该领域发生了什么」+ 至多 1 条值得展开
- **安全忽略报告（豆包 M6）**：与一页纸同期产出——本周总产出 / 实际读 / 安全忽略数及可解释理由（复用冷却死亡/生命周期下沉/门禁拒绝/去重命中的既有数据，不建理由分类器）
- Web：阅读器读毕弹层加「留一句消化」输入框；Overview 周卡加消化计数 + 周度一页纸入口

验收门禁：
1. 日均消化信号 ≥ 1 条（连续 7 天）——先有数据飞轮，低于此说明动作还不够轻
2. need_read 结构化判定上线（卡片缺关键字段即 need_read=1），观测真实比例；hook 覆盖率（蒸馏条目带 hook 的比例）≥ 90%，超长由后处理截断而非重调 LLM
3.（豆包 M4/M6）周度一页纸连续 2 周产出，安全忽略报告的数字口径可对账（collected − read − ignored ≈ 冷却/门禁/下沉/去重计数之和）
4.（智谱）brief 懒生成首开延迟可接受（生成中返回 hook 不阻塞）；蒸馏 token 成本较改造前不上升（hook 并入调用的验证）

### 阶段 ③ 配额与自适应（等 2~3 周真实消化数据再定参）

范围：
- `attention_budget` 配额表 + 首屏配额条（「今日 3/3，已用完，明天见」）+ 移除未读红点
- daily 精选硬上限 = 配额；超配额条目标 truncated 次日重参（衰减规则待数据定）
- 自适应：**仅当阶段②累计 ≥ 50 条消化信号后启用**；规则从基线出发（初始配额 = 近 14 天日均消化数 × 1.5，向上取整，clamp 1~10），替换元宝的 0.4/0.6 阈值体系
- MCP：`get_minimal_context`（token 效率，不挂注意力配额）+ 豆包 M7 熵减工具族（`get_summary` 800 字上限/单 file_id 指针、`read_entry` 加 purpose 记账 touch_count）；search_knowledge 加 token_budget 与 `include_cold`（默认 false，冷层需显式检索）
- 推荐可解释性（智谱）：推荐结果必须携带 score_breakdown（goal/marginal/quality/final 分项）；**配额调整只能改配置且次日生效，禁即时加额入口**；off_feed_open_ratio 只观测不拦截

验收门禁：
1. 连续 7 天 delivered ≤ quota 无泄漏
2. 自适应触发后 digestion_rate 不下降
3. 首屏无任何「新增/未读」计数

### 实施行为红线（智谱 §11 为主 + 豆包 §5 并入，全程生效）

**数据与隐私**：禁遥测/外发/云同步（local-first，LLM 调用仅摘要最小文本）；禁任何自动删除（降级/过期/reject 均不删，冷层可检索）
**成本与架构**：禁为 hook/brief 新增独立 LLM 调用（hook 并入蒸馏、brief 懒生成）；禁在规则门禁与去重阶段调生成式 LLM；禁新外部服务依赖（推送/消息通道）；SQLite 只增不改不删（红线 3 同源）
**产品行为（反焦虑）**：禁未读数/红点/角标/进度羞辱 UI 与「你落后了」文案；禁停滞催更（>14 天提示）；禁绕过投喂上限或专注模式的任何后门；禁把点击率/停留时长/打开数当优化目标（注意力榨取指标）；禁系统自动标记 digested
**消费粒度**：禁未经主动点击展开就在 feed 流渲染全文；feed 卡片摘要 ≤300 字（hook ≤30 字）
**推荐与检索**：禁冷层条目进推荐/投喂/看板；禁隐藏 score_breakdown

### 明确不做（本路线否决项）

- MCP 拉取扣注意力配额 / focus_mode 的 MCP 快照-only（概念混淆：人的注意力预算不得外溢为 agent 任务降级，元宝与智谱同病两形态）
- **智谱 daily_quota 入库配额与待审池主通道化**（本地库价值锚点=全量留存；超额只观测不拦截；待审池自动过期判冷不采纳）
- goals 独立表（三份方案各画一套，先复用现有周目标）
- trust 来源分类器、novelty ×0.3 惩罚、suppression≥95% 目标（见 §1.3）
- 豆包 900s 预算默认与「读前预估分钟数」入参（upgrade-to-full 摩擦设计）
- 豆包领域级 24h 冷却（读完一篇冷却大半个库；待细化到领域树叶级再议）
- 「日均主动检索次数应下降」指标（拉取式产品的核心消费面，不应定义为主指标下降）
- M6 理由分类器（duplicate/draft/off_topic 能力不存在，改用既有可解释数据源）
- 智谱 deep_read_ratio≥40% / 冷层占比≥60% 验收值（未对存量基线校准；先观测后定标）
- 留白页（哲学装饰，等指标体系跑通后看是否真需要）

---

## 4. 与三份方案的映射速查

| 机制 | 元宝 | 豆包 | 智谱 | 处置 | 去向 |
|---|---|---|---|---|---|
| 入库侧时间抑制 | §2 L1 冷却池 | — | — | 采纳元宝 | 阶段① |
| 入库侧去重 | 冷却期 sim 判死 | — | **A-1 蒸馏前廉价去重** | **取智谱**（前置省 LLM 成本、判冷不判死） | 阶段① |
| 入库侧条数配额 | — | — | A-2 daily_quota 30 + 待审池 | **否决拦截**，改造为观测仪表 | 阶段①（只记不拦） |
| 库侧减负 | TTL 时间衰减 | **M5 使用侧衰减** | C 分层（instant/digest/cold） | 取豆包衰减为主 + 智谱 pinned/touch 语义 | 阶段① |
| 摘要分层 | L4 决策卡片 | M2 one_liner | **B 三层（hook 并蒸馏调用/brief 懒生成/full）** | **取智谱骨架** + 元宝卡片字段 + 豆包 L0/L1/L2 呈现 | 阶段② |
| 新颖性参照系 | 全库 novelty | 全库 novelty | **D marginal（已读集参照）** | **取智谱**（唯一贴合拉取式基线） | 阶段② |
| 消费粒度 | need_read 二值 | M2 三级模型 | hook/brief/full | 合成（见上） | 阶段② |
| 周维度压缩 | 无 | **M4 周度一页纸** | — | 采纳豆包 | 阶段② |
| 抑制可解释性 | suppressed_reason | **M6 安全忽略报告** | score_breakdown | 豆包 M6（用户面）+ 智谱 breakdown（推荐面） | 阶段②③ |
| 消化信号 | T5 digestion_log | M3 digest_queue | rate_entry + **one_line_use** | 简化采纳，one_line_use 并入 | 阶段② |
| MCP 出口 | 绑注意力预算（错） | **M7 纯熵减** | focus_mode MCP 快照-only（错） | **取豆包** + include_cold；智谱快照-only 否决 | 阶段③ |
| 预算与自适应 | §4.4 会锁死系统 | M3 900s 休眠死代码 | E daily_feed_limit 5 | 三案齐推；≥50 信号门槛 + 基线定参 + **改配置次日生效**（智谱） | 阶段③后段 |
| 行为红线 | 无 | **§5 禁止动作** | **§11 四域总表** | 智谱 §11 为主 + 豆包 §5 并入 | 全程 |
| 迁移与灰度 | /api/v2 并行 | 字段可空+一键回退 | **features 灰度开关全关=对等** | **取智谱** + 豆包可空原则 | 全程 |

### 元宝方案逐章处置（原表保留）

| 元宝章节 | 处置 | 去向 |
|---|---|---|
| §2 五层架构 L1 冷却池 | 采纳 | 阶段① |
| §2 L2 价值评分（R/N/A/T/U/C） | 部分采纳 | A/T 简化、N 去 ×0.3、U 推迟（依赖 goals）→ 阶段②③ |
| §2 L3 配额闸门+装箱 | 重构 | 阶段③ |
| §2 L4 决策卡片 | 简化采纳 | 阶段②（复用蒸馏，不建独立层） |
| §2 L5 预算自适应 | 推迟+重定参 | 阶段③后段（≥50 条信号门槛） |
| §3 T1/T6 表 | 采纳（T6 简化）/推迟（T1 阶段③） | 分阶段 |
| §3 T2 goals 表 | 推迟 | 先复用周目标 |
| §3 T4/T5 卡片/消化表 | 简化采纳 | 阶段② |
| §6 REST /api/v2/* | 只取消化+配额两个端面 | 阶段②③ |
| §7 MCP 改造 | 拆分：token 效率保留、注意力配额否决 | 阶段③ |
| §8 首屏重构+留白页 | 首屏配额条采纳（阶段③）、留白页不做 | — |
| §9 指标反转 | 采纳但重定阈值 | 各阶段验收门禁 |

---

## 5. 待评审队列与开工口径

三份方案评审完成：元宝 ✅（v1.0）、豆包 ✅（v1.1）、智谱清言 ✅（v1.2/v1.3）。第 4 份方案待发——**如无新机制，将仅增量并入 §4 映射表，路线与排期不再变更；P0 可即刻开工**。

## 6. 实施排期（v1.3：落点到文件级，可开工）

> 排期基于 2026-09-26 代码侦察锚点（feeder 入队/周目标 config/selectDailyPicks/read_history 索引与 MCP 记账路径均已核实），行号随代码演进需复核。全程遵守 §3「实施行为红线」与仓库 CLAUDE.md 硬规则。

### P0 · 红线清理 + 生命周期基建（≈2 个会话）

| # | 任务 | 落点 | 依据 |
|---|---|---|---|
| P0-1 | files 加列 `lifecycle` / `lifecycle_deadline` / `last_touched_at` / `touch_count` / `pinned`（ensureColumns 幂等） | `db.ts` getDb 迁移链 | 豆包 M5 + 智谱 C |
| P0-2 | touch 回写：Web 打开（files.ts open 已写 read_history 处顺带 UPDATE files）+ MCP read_entry（mcpTools.ts `logMcpConsumption` 顺带）；存量 `last_touched_at` 回填 = read_history 首次 opened_at，无记录 = file_mtime | `routes/files.ts` L148 附近、`mcpTools.ts` L45-52 | 豆包 M5；read_history 已有 idx_read_hist_file 索引 |
| P0-3 | 红线清理：下线 Overview 停滞提示（>14 天催更）与未读徽标类元素 | `web/src/views/Overview.vue` 周卡区块 | 智谱 P0 / 豆包 §5 |
| P0-4 | 生命周期日批 job：90d 未触及且 touch≤1 → 降推荐可见性；180d → cold（搜索默认折叠）；pinned 豁免；先 dry_run 报告观测一周再启用 | 复用 `startDailyReportJob` 日批模式挂 `index.ts` | 豆包 M5 + 智谱 C |
| P0-5 | 灰度开关 `attention.features.lifecycle`（默认 on）+ 全关对等回归跑全量测试 | config seed + 测试 | 智谱 §8.3 |

### P1 · 冷却池 + 蒸馏前去重（≈2 个会话）

| # | 任务 | 落点 | 依据 |
|---|---|---|---|
| P1-1 | 新表 `cooling_pool`（CREATE IF NOT EXISTS）+ config `attention.coolingHours`(48) + `attention.features.cooling`(默认 **off**，观测一周期后开) | `db.ts` | 元宝 T3 简化版 |
| P1-2 | 入池闸门：llm feeder 捞取（llm/index.ts L253-258 的 pending 查询）追加条件——cooling 状态内不喂蒸馏（冷却与蒸馏解耦：文件照常入库，蒸馏延迟）；豁免：webclip 来源 / 路径白名单 / filenameWhitelist | `llm/index.ts` feeder | 元宝；豁免清单见 §3 |
| P1-3 | 蒸馏前廉价去重：入队前对 30 天窗 embedding 余弦 ≥0.92 → 判 duplicate 落 cold（可检索），不进蒸馏；embedding 未启用降级标题+关键词近似（标 degraded） | `llm/index.ts` feeder（hasFile 去重旁） | 智谱 A-1 |
| P1-4 | daily 精选接入冷却：`selectDailyPicks`（recommend.ts L184-222）排除 cooling 中条目；精选数量暂不设配额（P3 再限） | `routes/recommend.ts` | 元宝 |
| P1-5 | suppression_metrics 日表 + daily report 追加抑制段落（collected/deduped/cooling_died/delivered/digested） | `db.ts` + `reports.ts` | 元宝 T6 简化版 + 智谱观测仪表（含「若配额 30 生效今日超额」模拟值） |

### P2 · 三层摘要 + 消化信号 + 周度聚合（≈2~3 个会话）

| # | 任务 | 落点 | 依据 |
|---|---|---|---|
| P2-1 | hook 并入蒸馏调用：llmWorker 蒸馏 prompt 追加输出 `{importance, hook{text,verdict,action}}`（超长后处理截断）；存 wiki_entries_meta | `llm/llmWorker.ts` | 智谱 B（零新增调用） |
| P2-2 | brief 懒生成：首次打开触发异步任务（复用 assess 任务形态），生成中先返 hook | `routes/files.ts` content 或新端点 | 智谱 B |
| P2-3 | 轻量消化动作：`POST /api/reading/digest`（conclusion 或 one_line_use 二选一 ≥10 字 / minutes / drop）；reading_feedback 兼容并存（stars 打分保留，digest 是新信号） | `routes/reading.ts` | 元宝 T5 + 智谱 E 合并 |
| P2-4 | 读毕弹层加「留一句消化」；Overview 周卡加消化计数 | `Reader.vue` / `Overview.vue` | 信号飞轮 |
| P2-5 | 周度一页纸：周日日批，本周 hook-action∈{keep,act_now} 条目按领域聚类 3-5 簇 → LLM 每簇 ≤150 字 | 新 job 挂 `reports.ts` 模式 | 豆包 M4 |
| P2-6 | 安全忽略报告：与一页纸同期，数字口径对账（collected − read − ignored ≈ 冷却/门禁/下沉/去重之和） | 同上 | 豆包 M6（复用既有数据，不建分类器） |

### P3 · 配额 + 评分参照系 + MCP 熵减（≥50 条消化信号后启动）

| # | 任务 | 说明 |
|---|---|---|
| P3-1 | `attention_budget` + daily 精选硬上限（初始配额 = 近 14 天日均消化 ×1.5，clamp 1~10）+ 首屏配额条 | 前置：P2 累计 ≥50 条信号 |
| P3-2 | marginal 替代全库 novelty 进排序（已读集 Top-K 参照，≥0.85 打「已掌握」）；score_breakdown 随推荐返回 | 智谱 D |
| P3-3 | MCP 熵减：get_summary（800 字上限/单指针）、read_entry 加 purpose、search_knowledge 加 token_budget 与 include_cold | 豆包 M7 + 智谱 |
| P3-4 | 自适应调额（digestion_rate 驱动；改配置次日生效，禁即时加额） | 三案合成 |

### 排期原则

1. **P0/P1 不依赖任何用户行为数据**——立刻对 74k 存量减负，随时可开工
2. **P2 是信号飞轮**——验收只看「日均消化 ≥1 条」，算法参数全部等数据
3. **P3 有硬门槛**（≥50 条信号）——防止把休眠机器提前上线
4. 每阶段收尾：`npm test -w server` 全绿 + features 全关对等回归 + `npm run build -w web` 零错

## 变更日志

- 2026-09-26 v1.0：初稿。基于生产库真实基线（消化率≈0.1、推送面空转、信号源为零）完成元宝方案评审，产出三阶段修订路线。
- 2026-09-26 v1.1：合并豆包方案评审。新增 §0 双方案合成结论；§3 阶段①吸收 M5 使用侧衰减、阶段②吸收 M4 周度一页纸 + M6 安全忽略报告 + L0/L1/L2 呈现层、阶段③吸收 M7 熵减工具族；新增「实施行为红线」节（豆包 §5 收编）；否决清单扩至 8 项。已评审 2/4。
- 2026-09-26 v1.2：合并智谱清言方案评审。§0 升三方案结论；阶段①吸收 A-1 蒸馏前去重/pinned/touch/红线清理先行/daily_quota 改观测仪表/灰度开关对等验收；阶段②吸收三层摘要（hook 并蒸馏调用零新增成本）+ marginal 已读集参照系 + one_line_use；阶段③吸收 score_breakdown 与「配额改配置次日生效」；实施行为红线升版为智谱 §11 四域为主；否决清单扩至 10 项（新增：入库配额拦截、MCP 快照-only、deep_read/冷层占比验收值）。已评审 3/4。
- 2026-09-26 v1.3：新增 §6 文件级实施排期（P0 红线清理+生命周期 / P1 冷却池+蒸馏前去重 / P2 三层摘要+消化信号+周度聚合 / P3 配额+marginal+MCP 熵减，共 20 任务，每项带代码落点与方案依据），排期锚点经代码侦察核实（feeder 入队点 / 周目标 config 键 / selectDailyPicks / read_history 索引与 MCP 记账）。P3 设 ≥50 条消化信号硬门槛。P0 可即刻开工。
