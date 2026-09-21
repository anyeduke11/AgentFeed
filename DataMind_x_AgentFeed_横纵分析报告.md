# 海马体与考古队：DataMind × AgentFeed 横纵分析报告

> 研究时间：2026-09-20 | 所属领域：Agent 记忆与知识基础设施 | 研究对象类型：开源产品（DataMind）× pre-product 单人项目（AgentFeed）

## 一、一句话定义

DataMind 是给 Agent 装的「海马体」：一个对话中可写、下一句可读的 inference-time data plane，StoreAgent 写入五个数据面，RetrieveAgent 带着 evidence 取回。AgentFeed 是 Agent 世界的「考古队」：自动捕获 agent 排放的产物，门禁分拣，LLM 蒸馏成 wiki，再通过 Web 看板和 MCP 双出口喂给人和下一个 agent。

一个管「边聊边记住」，一个管「把痕迹变成资产」。母题相同——agent 时代的知识放哪、怎么被下次任务复用——但器官完全不同。

## 二、纵向分析：两条时间线的故事

### 2.1 DataMind：数据制备世家的第二个孩子（2026.03 – ）

要理解 DataMind，得先看它的家族。OpenDCAI 这个组织不是无名之辈：它背后的成名作 DataFlow，2024 年 10 月建仓，主打「用 LLM 算子做数据制备」——解析、清洗、合成、评估训练数据，8,000+ star，2025 年 12 月还发了 arXiv 技术报告（2512.16676），在医疗、金融、法律领域做过实证。这是一个有学术基因、有数据工程信仰、有社区基本盘的组织。

DataFlow 管的是「训练时数据」：喂给模型的东西。而 2026 年 3 月 29 日建仓的 DataMind，管的是「推理时数据」：agent 运行期间产生和消费的状态。从 DataFlow 到 DataMind，这个组织的叙事迁移非常干净——数据为中心的 AI，从训练侧延伸到推理侧。家族叙事一脉相承，这是很多独立开发者拿不到的起手牌。

但 DataMind 自己的路走得并不笔直。

**v0.1 阶段：一个 LlamaIndex 全家桶。** 仓库描述至今还挂着旧身份：「All-in-one intelligent assistant powered by LlamaIndex — RAG, GraphRAG, NL2SQL, Skills & Memory with multimodal support」。这是典型的科研集成项目形态：拿 LlamaIndex 把 RAG、图谱、NL2SQL、多模态拼成一个全能助手。文档站里至今残留着那个时代的配置页——`LLM_API_BASE` 指向 deepseek、`RETRIEVER_MODE=multi_query`、CLIP 模型配置、`python main.py` 的启动方式。功能齐全，身份模糊：又一个 all-in-one 助手，市面上这类项目一个手指头数不过来。

**v1.x 阶段：甩掉框架，自造概念。** 转折点是把 LlamaIndex 降级为「v0.1 原型保留在树内供对照」，新起 `datamind/` 包，自研 native loop 直接对话 Anthropic/OpenAI 官方 SDK。更重要的是提出了「inference-time data」这个概念，并把 runtime 切成两个角色：StoreAgent 只见 11 个写工具，RetrieveAgent 只见 19 个读工具，边界在代码层、工具到达模型之前就焊死。所有调用再过三道 hook：PathAllowlistHook 管路径、DestructiveSqlHook 管删库、AuditLogHook 管审计。

这个转向和 AgentFeed 去年踩过的 zod 双副本坑、以及自建蒸馏队列的选择是同一种本能：关键路径上的依赖，要么控制，要么甩掉。

**v1.0.0 到 v1.1.0：从「能用」到「可复现」。** v1.0.0 确立稳定基线：native 后端 + 本地 profile 存储。v1.1.0 的重心挪到了工程严肃性上——workspace build 管线（`inspect → ingest → freeze → verify → export`）、lineage 图谱（文件包含、引用、版本、依赖关系）、`raw_file_read` 带 SHA-256 和分页偏移的原始证据读取。这些词——freeze、verify、provenance、receipt——全部来自数据工程的世界观。DataFlow 的基因在 DataMind 身上表达得明明白白：agent 的运行时数据，被当作一条需要可追溯、可复现的数据管线来对待。

分发侧也在铺：PyPI 发包（`pip install datamind`）、FastAPI 服务、浏览器 UI、官方 Codex 插件（一层薄 MCP 适配，和主程序共享 profile）、Python SDK、CLI。一个内置的 enterprise demo 数据集——17 篇文档、64 个图谱节点、6 张表、101 行数据——让新用户 60 秒能跑通全链路。

**当下的真实温度。** 2026-09-20 仓库元数据：177 star、28 fork、1 个 open issue、当天仍有 push。半年从原型走到 v1.1.0，迭代活跃，但没有爆款迹象。1 个 open issue 是个诚实的信号：外部用户寥寥。文档贡献者名单上只有一个名字（Hao Liang）。这是「组织背书 + 单人冲锋」的结构——DataFlow 的 8,000 star 是它的引流水库，但水库里的水（炼数据的研究者和工程师）和 DataMind 想要的鱼（挂 Codex 的日常开发者）是不是同一群人，存疑。

### 2.2 AgentFeed：裁决期中的考古队（2026.09.13 – ）

AgentFeed 的故事在上一篇《WeKnora × AgentFeed 横纵分析报告》里已完整讲过，这里只补裁决之后的新进展，不重复旧叙事。

9 月 13 日开工，一周冲刺交付阅读闭环 M1~M5 和站内阅读器 R4；随后两次证伪——人读侧全历史仅 3 次打开；office-hours 诊断出失败模式「为那个不存在的用户持续加功能」；thesis 重定为「知识复利，第一消费者是 agent」；2026-09-20 落地了修订版路线图：Phase 0 裁决护航期（当下，至 10-03，用 MCP 调用埋点判定机读需求真伪，不达标即降级最小维护）、Phase 2 检索基建、Phase 3 getContext 注入、Phase 4 写回闭环、Phase 5 开源发布（2027-01 视数据）。

值得记下的一处姿态：路线图第 0 节明确写着「先说冲突，不平均处理」——对已批准计划的两处偏离逐条给出理由，而不是悄悄合并。这个项目正在学着用裁决制对抗自己加功能的本能。

### 2.3 纵向镜像：两条曲线为何在 2026 年交汇

把两条时间线并排放，有三处镜像。

第一，**都在 2026 年完成了「从堆功能到立边界」的转身**。DataMind 从 LlamaIndex 全家桶转向双 Agent 硬边界；AgentFeed 从 9 个 view 的功能冲刺转向裁决制路线图。一个用代码边界（工具可见性）管住 agent，一个用流程边界（裁决条件）管住自己。

第二，**都在「写入什么」上做文章，但方向相反**。DataMind 的演进是让写入更丰富（五数据面、多格式、lineage）；AgentFeed 的演进是让写入更克制（门禁冻结加码、triage 精选 500 篇而非清 3 万积压）。一个信「存得下就找得到」，一个信「进来的才值得找」。

第三，**都还没等到消费者**。DataMind 的 star 曲线和 issue 数说明外部消费未起量；AgentFeed 的机读消费数据还在 Phase 0 观察窗里。两条曲线在 2026 年 9 月交汇于同一个未验证的前提上：agent 真的会回来读吗。

## 三、横向分析：同一母题，不同器官

### 3.1 生态位判定：弱竞品，强参照

判定先行：DataMind 和 AgentFeed **不构成直接竞争**。重叠面只有两处——都走本地优先、都用 MCP 做机读出口、都宣称服务商中立。但核心资产完全错位：DataMind 的核心资产是「对话中写入与带证据读取」的 runtime；AgentFeed 的核心资产是「自动捕获 + 门禁 + 蒸馏」的内容管线。用户不会在两者间二选一，甚至在理想世界里可以串联使用。

所以这份对比的正确读法不是「谁赢」，而是「同一母题的两种解法，各自把哪一半做透了，又各自缺哪一半」。

### 3.2 结构化对比

| 维度 | DataMind | AgentFeed |
|---|---|---|
| 定位 | agent 的 inference-time data plane（读写双向） | agent 产物的本地知识库（捕获→门禁→蒸馏→双出口） |
| 出身 | OpenDCAI 组织（DataFlow 8k★，arXiv 报告） | 单人 pre-product，startup 探索 |
| 时间线 | 2026-03 建仓；v0.1 LlamaIndex 原型 → v1.1.0 native 自研 | 2026-09-13 开工；M1~M5 + R4 已交付；Phase 0 裁决期 |
| 技术形态 | Python；PyPI 包 + FastAPI + Codex 插件 + CLI | TypeScript；Express + Vue3 + MCP stdio，本机 5188 |
| 数据面 | 五面：KB/RAG、SQL 数据库、知识图谱、Skills、Memory | 单面深挖：文档库 + wiki 词条 + 三态标签/领域树 + 嵌入 |
| 写入方式 | 对话内显式写入，StoreAgent 返回 receipt | 扫描根自动捕获（隐式排放）+ wiki 导入 |
| 质量治理 | build freeze/verify/export 可复现、lineage、SHA-256 provenance | 门禁规则 + LLM 结构化裁决、rule/quality 双轨评分、triage |
| 消费出口 | RetrieveAgent + 聊天 UI（ask/chat SSE） | Web 看板（9 views）+ MCP 7 工具 + 日报（计划中） |
| 安全模型 | 工具到达模型前拦截（Path/DestructiveSQL/Audit 三 hook） | 内容到达人眼前清洗（reader 白名单 + iframe sandbox）+ 扫描根 fail-closed |
| LLM 依赖 | 协议显式声明（Anthropic/OpenAI），内外层共用 | 8 家服务商蒸馏队列 |
| 验证状态 | 177★ / 28 fork / 1 open issue，enterprise 种子 demo | 自用；MCP 埋点观察中，裁决日 10-03 |
| 开源状态 | Apache-2.0，PyPI 在架 | 未开源（Phase 5 计划 2027-01） |

### 3.3 三个值得深挖的差异

**差异一：写入语义——receipt 对排放物。** DataMind 的每个数据单元都自带意图标签：StoreAgent 写入时返回 receipt，描述什么变了、为什么变。AgentFeed 的数据单元是考古地层：agent 写文件时没打算被归档，归因靠信任序推断——frontmatter 声明 > 扫描根绑定 > 根后首段目录名。这是两种 provenance 哲学：一个是「写入者自证」，一个是「考古者鉴证」。前者干净但依赖写入方的自觉，后者嘈杂但能接住 agent 世界真实的混乱——agent 排放产物时不会给你开 receipt。

**差异二：治理重心——治管线对治内容。** DataMind 治「管线可复现」：freeze 之后的东西不再变，verify 保证构建结果可校验，export 可导出。但它不管「写进去的东西值不值得进」——KB 里是什么全凭 StoreAgent 的判断。AgentFeed 反过来，治「内容值得进」：门禁规则打分、LLM 结构化裁决、>512KB 抽样、三态标签。DataMind 的世界观里质量是写入方的责任，AgentFeed 的世界观里质量是入库口的公共责任。哪种对？取决于上游多脏。Codex 会话里手动写入的数据相对干净；扫描根里 3 万份 agent 排放物是泥沙俱下的。

**差异三：消费者假设——热缓存对冷蒸馏。** DataMind 的口号是「刚写入的数据，下一句话就能使用」，这是热路径：消费发生在写入后的同一个会话里。AgentFeed 的 thesis 是跨会话复利：上周 agent 沉淀的领域知识，被下周另一个项目的任务引用，中间隔着一道蒸馏。热的和冷的，架构代价完全不同——热路径要的是低延迟读写和精确召回，冷路径要的是筛选、聚合、可读性。这个差异比前面所有差异都根本：它决定了 DataMind 会长成一个 runtime 组件，AgentFeed 会长成一个媒体设施。

### 3.4 赛道背景：agent 记忆战场的梯队

把视野拉远，agent 记忆这个大盘子在 2026 年 9 月的格局大致三层。

第一层，runtime 巨头自带记忆。hermes-agent（约 23 万★，「The agent that grows with you」）、ECC（26 万★，skills/instincts/memory 全家桶）——agent 框架把记忆、技能、产物管理做成出厂标配。这一层的问题是：记忆绑定自家 runtime。

第二层，独立记忆服务。mem0、Zep、LangMem 这类，把记忆做成可插拔的中间件，服务所有 runtime。

第三层，数据面与知识基建。DataMind、mcp-local-rag 系、WeKnora、以及 AgentFeed 都挤在这一层——不造 runtime，不做通用记忆 API，而是给本地知识/数据提供存取设施。

AgentFeed 在第三层里占的细分格是「agent 产物自动捕获 + 质量门禁 + 蒸馏」，上一份报告的 landscape 扫描（mcp-local-rag / LocalSynapse / Lorekeeper / LobeHub 本地知识库，全是「手动喂文件做检索」）确认过：这个格子目前仍无人。DataMind 占的格子是「对话时双向数据面」，与 AgentFeed 的格子相邻但不重叠——DataMind 的 `datamind_use_folder` 也是把已有文件索引进 KB，形式上接近「喂文件」，但它没有捕获管线、没有门禁、没有蒸馏，文件进去是什么样出来还是什么样。

## 四、横纵交汇：两个赌注与一层可能

### 4.1 互相批判，先批自己

**对 AgentFeed 的三个批判：**

批判一，消费验证的债又多了一个参照物。DataMind 证明了一件事：连有 8,000 star 组织背书、概念包装漂亮的 data plane，也只攒到 177 star 和 1 个 issue。整个「agent 记忆基建」品类的外部需求都未被证实。这不是 AgentFeed 的独家风险，是全品类的系统性风险——Phase 0 裁决因此更不能手软。

批判二，五数据面的诱惑就在隔壁。看到 DataMind 的 SQL 面、Graph 面，很容易心动：「我也有 19 张表，加个图谱查询怎么样？」——这就是 9 view 时代的错误换了个马甲。DataMind 有组织弹药铺五个面，单人项目铺一个面深挖到底才有活路。路线图总原则第 6 条「单人产能，每期一条主线」必须压住这条冲动。

批判三，门禁资产的护城河有稀释路径。DataMind 的 StoreAgent 模式如果成立——写入前 agent 自己判断质量——那么「下游门禁」的存在意义会被上游治理蚕食。agent 什么时候会自觉治理自己的排放物？短期内不会，这是门禁的窗口期；但长期看，这个假设和「agent 会自己写测试」一样，属于「迟早会发生但总是迟到」的那类。

**对 DataMind 的三个批判：**

批判一，五个面，零个消费验证。它的企业 demo 是种子数据，不是真实工作流；issue 区空空荡荡。仓库描述还停留在 v0.1 的 LlamaIndex 时代，说明组织自己的叙事更新都跟不上代码——一个半年改了一次身份的项目，概念先行于需求的嫌疑不小。「inference-time data plane」是个漂亮的词，但漂亮词不自动等于有人需要。

批判二，热路径假设把宝押在 StoreAgent 的写入智能上。「下一句话就能用」意味着写入的选择正确率决定一切——什么值得存、存哪个面、什么粒度。这本身是一个未解决的 LLM 判断问题。存得太少，复用落空；存得太多，retrieve 又被噪声淹没。DataMind 把 agent 记忆领域最难的开放问题放进了架构的正中央，README 却只字不提这个风险。

批判三，引流水库的鱼不对口。DataFlow 的用户是炼训练数据的研究者，DataMind 要的用户是每天挂 Codex 写代码的开发者。组织在用上一款产品的社区声誉为下一款完全不同画像的产品导流，这条漏斗的转化率值得怀疑——177 star 对 8,000 star 的基本盘，本身就是漏斗效率的诚实读数。

### 4.2 第一性原理：复利公式在两个器官上的分配

上一份报告给出了能力复利公式：复利 = 沉淀率 × 转化率。用这把尺子量两个项目，分配方式截然相反。

DataMind 最大化沉淀率：写入零摩擦，五个面什么都能存，receipt 记录一切。但转化率靠 RetrieveAgent 现场发挥，没有任何离线加工。AgentFeed 最大化转化率：门禁拦下泥沙，蒸馏聚合出 wiki，进来的都是精选——但沉淀是被动的，只能等 agent 排放，且排放物天然是「冷」的（写完就结束，没有结构）。

两个项目各自把公式的一个因子做到位，另一个因子悬空。理想形态是乘积最大化，但那是资源充足者的游戏。单人项目的正确选择是选一个因子做到全市第一——AgentFeed 选转化率，方向没错，因为存储和写入的赛道太挤（第一层、第二层都在做），而「蒸馏」这个格子是空的。

### 4.3 三个剧本

**最可能——平行演化，互不相撞。** DataMind 靠组织推力涨到千星级，消费侧验证平平；AgentFeed 按 Phase 0~4 走完裁决，无论结果如何，两者在 MCP 生态里各占各的端口，用户重合度低。2027 年的 agent 记忆市场上，它们是同一面墙上的两块砖，不是对手。

**最危险——被从上游吞掉。** 两条路径：其一，runtime 巨头（hermes-agent、ECC 一系）内置 data plane + 产物沉淀，两端通吃，第三层整体失压；其二，更近的威胁——DataMind 已经有 `workspace_inspect` 和 `surface_ingest_path`，离「自动监视工作区、捕获 agent 产物」只差一个 watch 循环加归因逻辑。以它数据工程的基因，补齐这一步的工程量不大。一旦 DataMind 把「排放捕获」做成 StoreAgent 的一个 source，AgentFeed 的入口就被并进了别人的 data plane。前兆信号明确可观测：DataMind 的 workspace 能力是否走向自动 watch。

**最乐观——互补分层成型。** 市场教育完成后的分工：DataMind 类 data plane 做存储与检索底座，AgentFeed 做蒸馏、策展与人读层。DataMind 解决「存得下、查得到」，AgentFeed 解决「存的这些东西里什么值得看、值得注入」。集成故事可以很具体：AgentFeed 的蒸馏 wiki 通过 MCP 喂进 DataMind 的 KB，或 AgentFeed 给任何 data plane 当蒸馏车间。到那时 AgentFeed 开源（Phase 5）的定位陈述已经现成：不跟 runtime 竞争，不跟存储竞争，做 agent 排放物到可用知识之间的那一道蒸馏厂。

## 五、给 AgentFeed 的行动启示

1. **不追数据面。** Phase 2 检索基建（FTS5 + 分块向量 + RRF 融合）照计划做完做深。SQL/Graph 面不碰——V2 的「跨 agent 归因图谱」若要做，用现有 SQLite 关系查询实现，不引入 NetworkX 级的新依赖，控制在一周内。
2. **偷 provenance 叙事，不偷架构。** DataMind 的 freeze/verify/export、receipt、SHA-256 是好故事素材：AgentFeed 的 wiki 导出（Phase 5 开源前的信任资产）可以低成本加上「可复现导出 + 内容指纹」，让蒸馏结果可审计。这契合门禁路线的宪法——质量主张需要证据链支撑。
3. **热路径的差异化表述先想清楚。** DataMind 证明「热缓存」叙事有组织在做且能获得关注。AgentFeed 的 getContext（Phase 3）同属热路径，对外表述要错位：DataMind 存对话中学到的事实，AgentFeed 注入跨项目沉淀的领域知识——一个管会话内记忆，一个管跨项目阅历。这句话现在就写进 README 备用。
4. **裁决不受干扰。** DataMind 的存在不构成 Phase 0 裁决的任何输入。10-03 照常裁决：≥20 次真实调用跨 ≥3 天且链路完成率可解读才进 Phase 1，否则降级。别人的概念热度不是自己的需求证据。
5. **把 DataMind 挂上观察名单。** 每月看一次它的 workspace 能力演进（`surface_ingest_path` 是否走向自动 watch、是否出现 agent 产物归因类特性）——那是最危险剧本的前兆。真到那一天，AgentFeed 的应对不是加捕获功能对抗，而是加速往「蒸馏层」卡位。

## 六、信息来源

- DataMind 中文 README（GitHub）：https://github.com/OpenDCAI/DataMind/blob/main/README_zh.md （2026-09-20 访问）
- DataMind 仓库主页：https://github.com/OpenDCAI/DataMind （2026-09-20 访问）
- DataMind 仓库元数据（GitHub API，star/fork/建仓时间）：https://api.github.com/repos/OpenDCAI/DataMind （2026-09-20 访问）
- DataMind 文档站 Install & run：https://opendcai.github.io/DataMind-Doc/en/guide/basicinfo/install/ （2026-09-20 访问）
- DataMind 文档站 Configuration（v0.1 时代残留配置页）：https://opendcai.github.io/DataMind-Doc/en/guide/advanced/config/ （2026-09-20 访问）
- OpenDCAI/DataFlow star 与活跃度：https://www.gstars.dev/repo/OpenDCAI/DataFlow （2026-09-20 访问）
- AgentFeed 本地材料：`CLAUDE.md`、`docs/iteration-roadmap-2026Q4.md`、`docs/knowledge-flywheel-design.md`、`WeKnora_x_AgentFeed_横纵分析报告.md`

---

方法论说明：本报告采用横纵分析法（数字生命卡兹克提出）——纵向追时间深度，横向追同期广度，交汇处出判断。
