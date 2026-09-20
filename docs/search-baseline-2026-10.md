# 检索基线记录（2026-10 裁决对照）
> 正文（query 重放 Top-3 对比表）由检索基线任务补充；本文件先落附录。

## 正文：search_knowledge Top-3 重放（生成于 2026-09-20，复现命令：`npx tsx server/scripts/searchBaseline.ts /tmp/af-baseline-queries.txt --db server/data/app.db`）

query 来源：**第 1 级（CLI queries 文件）**，去重后共 21 条 = 脚本内置兜底集 20 条（见 `server/scripts/searchBaseline.ts` 的 `FALLBACK_QUERIES`，覆盖 title / summary / path 命中、中文/英文、常见领域词、故意 miss）+ 真实日志可提取的唯一 query「MCP 部署」。说明：`mcp_call_logs` 中 search_knowledge 共 25 条，其中 24 条为早期版本落库、args 为 NULL 无法解析，仅 1 条可提取出 query，单条不足以构成对照组，故按最高优先级来源改用文件重放，并把该条真实 query 追加进文件一并重放。重放统一仅按 query 检索（不携带原调用的 domain/limit 等参数），limit 固定 3；`/tmp/af-baseline-queries.txt` 为临时文件，内容即上述 21 条，每行一条。

| # | query | Top-1 | Top-2 | Top-3 | 标注 |
| --- | --- | --- | --- | --- | --- |
| 1 | MCP | #126602  · 记录 2026-09 期间 MCP 消费链路的漏斗指标，数据来源于 mcp_call_logs 数据库。样本期内 search → read_entry 链路完 | #123337  · AgentFeed 是一个本地 AI Agent 知识管理系统，自动采集多 Agent 工作产物并通过门禁过滤、领域分拣与 LLM 蒸馏沉淀为结构化知识。支持 | #86681  · 本文档介绍了腾讯云 CloudBase MCP（Model Context Protocol）的配置与使用指南，涵盖国内外站点区分、插件安装、IDE 原生 MC |  |
| 2 | LLM | #123337  · AgentFeed 是一个本地 AI Agent 知识管理系统，自动采集多 Agent 工作产物并通过门禁过滤、领域分拣与 LLM 蒸馏沉淀为结构化知识。支持 | #18172  · 本开发日志记录了 SecNews Analytics 平台的三次关键迭代：修复 CVE 热力图与合规矩阵因后端路由缺少 /api 前缀导致的 404 故障及前端 | #125328  · 该设计方案旨在将 pi provider 集成至 ai_hub 作为第五种 LLM 供应商，实现采集管线与手动任务的双通道统一路由。方案补齐语义门禁、智能分类增 |  |
| 3 | Agent | #126425  · 记录了VibeCanon产品从PRD解析到V4双新案的全链路开发过程，涵盖四套设计方案（A/B/C/D/E）及无限画布的多轮迭代。重点描述了利用无头Chrome | #148830 灵典 · 交付版 · 无限画布 ·  | #126465 灵典 · 交付版 · 工作台 / 资产库 / 标准包 / 设置 ·  |  |
| 4 | SQLite | #126395  · 该文件记录了 VibeCanon（标准化 Vibecoding 助手工作台）从项目立项、竞品调研到 P0 设计文档集产出的完整开发过程。内容涵盖 PRD 的迭代 | #126276  · AgentFeed 是一个基于 npm workspace 的全栈项目，包含 Express + SQLite 后端与 Vue 3 + Vite 前端仪表盘。该 | #27019  · SecNews是一个面向AI和安全从业者的单机本地工作站，采用单一FastAPI进程和SQLite数据库整合热点聚合、知识管理、代码花园等六大子系统。系统通过引 |  |
| 5 | scanner | #74626  ·  | #75394  ·  | #95082  · 本技能文档系统阐述了软件供应链安全评估的完整方法论，涵盖 SBOM 生成与审计、SCA 漏洞扫描、CI/CD 管道安全、容器镜像安全、依赖溯源与漏洞可达性验证六 |  |
| 6 | 架构 | #126466 {"cards":10,"drawer":true,"chk":"false>true","moved":true,"r… · 该文件定义了一个基于 1440x900 视口的 Web 页面架构，采用响应式设计策略支持桌面、平板和移动设备。配置中包含详细的断点定义、CSS 变量体系及深色调 | #126392  · VibeCanon（灵典）是用户于 2026-09-20 立项的 vibe coding 标准化工作台，用于管理提示词、Skill、vibe 术语、技巧及 co | #125547  · 该文档确立了以“镜子优先”为核心的需求架构，明确了标讯抓取、涉密处理及复盘沉淀的四层循环模型。同时，通过工程审查修正了涉密壳（classified shell） |  |
| 7 | 指南 | #86681  · 本文档介绍了腾讯云 CloudBase MCP（Model Context Protocol）的配置与使用指南，涵盖国内外站点区分、插件安装、IDE 原生 MC | #126540  · 本文档是知识库检索系统的工具参考指南，提供关键词搜索、文档片段获取及同步状态查询等功能。包含六个核心工具接口，支持灵活的知识库查询与上下文补全操作。 | #126328  · Finance Lite是用于简单预算、费用报表、项目成本追踪等基础财务场景的轻量级模板指南，适用于不需要DCF、LBO或三表联动的财务表格。它提供了标准表格结 |  |
| 8 | 实践 | #71625  · 本文档为AutoClaw智能代理的系统配置与使用规范，涵盖浏览器自动化、图像识别及飞书/Lark集成的最佳实践。文档明确了各场景下的工具优先级与技能安装路径，确 | #86636  · 该文档介绍了腾讯云 CloudBase 云存储管理 CLI 工具（tcb storage）的核心功能与操作流程。内容涵盖了文件上传、下载、删除、复制/移动、临时 | #126329  · 该文件定义了 ZCode 生态中插件（.zcode-plugin/plugin.json）与市场（marketplace.json）的结构化配置标准。详细说明了 |  |
| 9 | 总结 | #126539  · 予非AI知识大脑（verya）是一个支持自然语言搜索、读取和总结外部知识资料的技能连接器。它融合了知识图谱关联分析，通过多工具协同工作，能够洞察实体关系并梳理知 | #125050  · 该技能定义了一套结构化的盘后复盘工作流，用于对自选股清单进行每日收盘总结，涵盖个股涨跌幅、市场/板块对标、异动归因与决策摘要。核心流程包括加载清单、拉取行情、建 | #93955 Cubox 内容质量评测报告 v1.6.5等保大模型测评 Skill：面向大模型系统（训练/推理/RAG/Agent/一… · Cubox 内容质量评测系统 v1.6.5 对 5873 张评测卡片进行混合规则评测，覆盖 8 类文章、8 个维度、4 个角度，采用 S/A/B/C/D 五级评 |  |
| 10 | 蒸馏 | #123337  · AgentFeed 是一个本地 AI Agent 知识管理系统，自动采集多 Agent 工作产物并通过门禁过滤、领域分拣与 LLM 蒸馏沉淀为结构化知识。支持 | #125325 AgentFeed - 本地知识看板 · AgentFeed 是一款面向本地 AI Agent 产物管理的知识看板应用，采用单页应用（SPA）架构，通过 TypeScript 模块化脚本入口加载。其核心 | #134663  · AgentFeed 是一款本地优先的 AI Agent 知识聚合平台，自动采集散落在 Claude Code、Trae、Qoder 等 20+ 主流 Agent |  |
| 11 | server | #123337  · AgentFeed 是一个本地 AI Agent 知识管理系统，自动采集多 Agent 工作产物并通过门禁过滤、领域分拣与 LLM 蒸馏沉淀为结构化知识。支持 | #111213  · ZCode与bid-master的联动机制，涵盖MCP server工具集、统一CLI命令行入口、ZCode MCP注册约定及一键启停脚本。该机制实现AI会话与 | #134663  · AgentFeed 是一款本地优先的 AI Agent 知识聚合平台，自动采集散落在 Claude Code、Trae、Qoder 等 20+ 主流 Agent |  |
| 12 | web | #123337  · AgentFeed 是一个本地 AI Agent 知识管理系统，自动采集多 Agent 工作产物并通过门禁过滤、领域分拣与 LLM 蒸馏沉淀为结构化知识。支持 | #126491  · 定义 Web 端标准包的组装向导、文件生成、导出与版本治理功能。标准包以 Markdown/YAML 格式交付，支持多平台目标（Claude Code、Curs | #126476 {"cards":10,"drawer":true,"chk":"false>true","moved":true,"r… · 该文件定义了一套完整的响应式 Web 应用设计系统，涵盖设计令牌（CSS 变量）、布局框架、侧栏导航与顶栏组件等，适用于桌面、平板和移动设备。文件以 artif |  |
| 13 | README | #123337  · AgentFeed 是一个本地 AI Agent 知识管理系统，自动采集多 Agent 工作产物并通过门禁过滤、领域分拣与 LLM 蒸馏沉淀为结构化知识。支持 | #126396  · VibeCanon（灵典）是 Vibe Coding 的标准化工作台，将提示词、Skill、术语、技巧和项目流程转化为可管理、可复用、可分发的工程标准。核心采用 | #126390  · Qoder Context 是 Qoder 的内置插件，旨在提供项目知识理解、代码检索和上下文获取能力。该套件包含 Wiki 和检索引擎等核心功能，允许用户直接 |  |
| 14 | docs | #86323  · 金山文档（WPS云文档/Kdocs）的官方Skill，提供云端文档的完整操作能力，包括新建、读取、编辑、搜索、分享和整理等功能。支持智能文档、Word、Exce | #126602  · 记录 2026-09 期间 MCP 消费链路的漏斗指标，数据来源于 mcp_call_logs 数据库。样本期内 search → read_entry 链路完 | #126494  ·  |  |
| 15 | config | #126344  ·  | #126345  · 该文档定义了一套跨渲染管线的字体系统，涵盖 Creative（Playwright/HTML）、Report（ReportLab）和 Academic（Tect | #126351  · 该文件定义了创意管线中严格的组件词汇表，规定仅通过JSON输出而非HTML/CSS，包含七种组件类型及蓝图组装指南。组件将由design_engine.py自动 |  |
| 16 | 前端 | #126477 {"cards":10,"drawer":true,"chk":"false>true","moved":true,"r… · 该文件定义了一个前端PRD应用的设计系统和UI组件样式，包含响应式布局配置、CSS设计令牌和侧栏导航组件。采用暖色调配色方案，支持桌面、平板和移动设备的多视图适 | #126466 {"cards":10,"drawer":true,"chk":"false>true","moved":true,"r… · 该文件定义了一个基于 1440x900 视口的 Web 页面架构，采用响应式设计策略支持桌面、平板和移动设备。配置中包含详细的断点定义、CSS 变量体系及深色调 | #126276  · AgentFeed 是一个基于 npm workspace 的全栈项目，包含 Express + SQLite 后端与 Vue 3 + Vite 前端仪表盘。该 |  |
| 17 | 后端 | #126309  · Built-in Browser Automation API 定义了 ZCode 平台中浏览器后端类型（iab、extension、cdp）与 Tab API | #126276  · AgentFeed 是一个基于 npm workspace 的全栈项目，包含 Express + SQLite 后端与 Vue 3 + Vite 前端仪表盘。该 | #126241  · 第四十五次自动化执行的项目看板快照，因连续 5 次零变更触发 R6 空转熔断机制，系统不重写台账与看板正文，仅更新时间戳与熔断状态。Duke 工作台后端离线导致 |  |
| 18 | 数据库 | #126602  · 记录 2026-09 期间 MCP 消费链路的漏斗指标，数据来源于 mcp_call_logs 数据库。样本期内 search → read_entry 链路完 | #27019  · SecNews是一个面向AI和安全从业者的单机本地工作站，采用单一FastAPI进程和SQLite数据库整合热点聚合、知识管理、代码花园等六大子系统。系统通过引 | #17477  · 该文档定义了 bid-master 多智能体系统的核心运行纪律，确立了以 SQLite 数据库为唯一事实源的状态管理流程。它详细规定了 L3 敏感数据红线、外部 |  |
| 19 | zzxq自造词mISS | （无结果） | （无结果） | （无结果） |  |
| 20 | quantum-blockchain-xyz | （无结果） | （无结果） | （无结果） |  |
| 21 | MCP 部署 | （无结果） | （无结果） | （无结果） |  |

> 标注说明：hit=精准命中 / partial=部分相关 / miss=不相关。本表为 Phase 2 检索改造（LIKE → 更强检索）的验收对照组。

### AI 预标注（待人工复核）

> 以下为生成本表的 AI 基于结果文本给出的初步判断，仅用于对齐标注口径，**不构成人工结论**；表内「标注」列留空，以人工勾选为准。Top-N 单元格仅展示 title（超 60 字符截断，语料存在 title 长达 11 万字符的脏数据）与 summary 前 80 字符，部分命中依据（如 path 子串）未完整展示，判断可能存在偏差。

| # | query | AI 预标注 | 一句话依据 |
| --- | --- | --- | --- |
| 1 | MCP | partial | Top3 CloudBase MCP 指南才是 MCP 主题文档；Top1 是本基线附录自身、Top2 是 AgentFeed README，靠性低 |
| 2 | LLM | partial | Top3（LLM 供应商方案）直接相关；Top1/Top2 仅 summary 截断外部分可能涉及 |
| 3 | Agent | partial | 「Agent」在 Agent 产物库中泛化，命中宽泛不聚焦 |
| 4 | SQLite | hit | Top2/Top3 均为 SQLite 主题文档 |
| 5 | scanner | partial | Top1/Top2 摘要为空、疑靠 path 命中；Top3 是「扫描」主题而非 scanner 本身 |
| 6 | 架构 | partial | Top1 title 为 JSON 配置脏数据，靠 summary「页面架构」勉强相关 |
| 7 | 指南 | hit | Top3 均为「指南」类文档 |
| 8 | 实践 | partial | 「最佳实践」相关但主题分散 |
| 9 | 总结 | partial | 命中分散；Top3 title 为 11.7 万字符脏数据（已截断展示） |
| 10 | 蒸馏 | hit | Top 全部指向 LLM 蒸馏 / 知识沉淀主题（含 AgentFeed 核心文档） |
| 11 | server | hit | MCP server 联动、后端服务主题明确 |
| 12 | web | hit | Web 端标准包、响应式 Web 设计系统直接相关 |
| 13 | README | hit | path 命中 README 文件本身，符合该 query 的预期语义 |
| 14 | docs | partial | path 子串误命中 kdocs（金山文档），真实 docs 目录命中与噪声并存 |
| 15 | config | partial | Top1 摘要为空疑靠 path 命中，整体相关性弱 |
| 16 | 前端 | hit | 前端 PRD 设计系统、AgentFeed Vue 前端直接相关 |
| 17 | 后端 | hit | 后端类型、Express+SQLite 后端直接相关 |
| 18 | 数据库 | hit | SQLite 数据库主题文档为主 |
| 19 | zzxq自造词mISS | miss | 兜底故意 miss 词，返回空符合预期 |
| 20 | quantum-blockchain-xyz | miss | 兜底故意 miss 词，返回空符合预期 |
| 21 | MCP 部署 | miss | 真实日志 query 返回空：LIKE 要求「MCP 部署」作为连续子串，不支持空格分词（原调用还带 domain=infra 过滤，本重放未带） |

AI 预标注小结（待人工复核）：21 条中 9 条偏 hit、9 条偏 partial、3 条 miss（含 1 条真实日志 query「MCP 部署」）。对 Phase 2 的两点直接论据：① 空格词组检索完全失效（#21），LIKE 无分词能力；② path 子串误命中引入噪声（#14 kdocs）、脏 title 挤占展示位（#9），均指向需要更强检索与结果可读性治理。

## 附录 A：MCP 消费链路指标（mcpFunnel，生成于 2026-09-20）

数据源：`mcp_call_logs`（`server/data/app.db`，只读）。会话口径：按时间升序聚类，同一会话内相邻两次调用间隔 ≤ 30 分钟，超过则切分。链路口径：一级 = search_knowledge 后同会话 30 分钟内跟随 read_entry 的会话占比（分母 = 含 search 的会话）；二级 = read_entry 后同会话 30 分钟内跟随 get_source 的占比（分母 = 含 read_entry 的会话）。

| 指标 | 数值 |
| --- | --- |
| totalSessions（总会话数） | 3 |
| sessionsWithSearch（含 search_knowledge 会话数） | 2 |
| level1Rate（一级链路完成率） | 0（0/2） |
| level2Rate（二级链路完成率） | 0（0/0，分母为 0：无会话含 read_entry） |

上下文：总调用 29 条；时间范围 2026-09-16 06:31:58 ~ 2026-09-19 00:55:35（UTC）；非法时间戳剔除 0 条。

解读提示：样本期内 3 个会话中 2 个发起过 search_knowledge，但没有任何会话在 search 后 30 分钟内进入 read_entry（read_entry 调用数为 0），消费链路在 search → read 环节完全断裂；二级指标因分母为 0 无意义。样本量小（29 条 / 3 会话），裁决时需结合正文 query 重放结果综合判断。

复现方式：`npx tsx server/scripts/mcpFunnel.ts --json /tmp/mcpFunnel.json`（脚本见 `server/scripts/mcpFunnel.ts`，只读打开库）。
