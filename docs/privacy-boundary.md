# 数据与隐私边界（LLM 外发链路核实）

> v0.1.5 G2 交付物 · 核实日期 2026-09-21 · 方法：逐链路代码走读（下文每条均给 文件 + 函数 依据，行号以当日代码为准）
> 本文档是 README「数据与隐私边界」一节的详细版，供评审对照。只披露、不改动任何外发行为。

## 0. 总原则与服务商配置模型

- AgentFeed 本体无云端依赖、无遥测；所有 LLM 网络请求发往**用户自行配置**的服务商。
- 服务商配置：`server/src/llm/llmClient.ts` `PROVIDER_PRESETS`（8 家 OpenAI 兼容预设：sensenova / deepseek / zhipu / moonshot / qwen / xfyun / agnes / **ollama**），实际生效配置存 SQLite config 键 `ai.providers`（设置页写入），由 `getProviders()` 读取。
- **只配 Ollama（`http://127.0.0.1:11434/v1`）即可全本地、零外发。**
- 不配置任何服务商时：各 chat 环节 `no_llm_provider` 失败，嵌入环节优雅降级跳过——**不外发任何内容**。
- 注意：蒸馏队列支持跨节点 failover（`llmWorker.ts` `callLlmWithFallback`，经 `distillNodes.ts` 健康池最多 3 跳轮换），因此单次蒸馏可能送达你在节点池内启用的**任一**已配置节点，不只默认服务商。

## 1. 外发链路明细

### 1.1 蒸馏（wiki 词条生成）——外发原文

| 项 | 内容 |
| --- | --- |
| 代码 | `server/src/llm/llmWorker.ts` `processDistill`（辅：`readFileSafe` / `sanitizeSensitive` / `buildPrompt` / `loadImagesForPrompt` / `extractLocalImageRefs`） |
| 外发内容 | **原文**：文件头部 ≤512KB（`readFileSafe`）；文件 >100KB 时 `buildPrompt` 降为去标签的 4000 字摘要（`summarizeContent`）。发送前 `sanitizeSensitive` 正则脱敏（见第 4 节）。prompt 另含文件名与已有领域名单。视觉模型（`supportsVision`）另附文档内嵌本地图片 ≤3 张、单张 ≤2MB（base64），仅放行源文件所在扫描根内的引用（`extractLocalImageRefs` fail-closed，越界引用丢弃） |
| 触发时机 | 文件过门禁入库后自动入队（`llm/index.ts` 启动兜底、`routes/files.ts` 入库 enqueue）；另有 `routes/llm.ts` 手动蒸馏与 triage 按需精选批次 |
| 服务商 | job 指定或默认服务商 + failover 池轮换 |

### 1.2 推荐语 / 质量分 / 批量策展——外发头部片段或元数据（原清单外，如实补充）

| 项 | 内容 |
| --- | --- |
| 代码 | `server/src/llm/llmWorker.ts` `processAssess` / `processBackfill` / `processCurate` |
| 外发内容 | assess（推荐语）与 backfill（质量分）：标题 + 原文开头 **1500 字符**（`sanitizeSensitive` + `summarizeContent` 后）；curate（批量策展）：Top30 篇的 id / 标题 / 领域名 / 质量分 / 摘要前 60 字（**不含正文**） |
| 触发时机 | assess：文件入推荐池后自动（`routes/recommend.ts` enqueue `type:'assess'`）；backfill / curate：设置页手动触发（`routes/llm.ts` / `routes/recommend.ts`） |

### 1.3 向量化（embedding）——外发蒸馏产物与检索词

三条子路共用 `server/src/llm/embeddings.ts` `callEmbedding`（OpenAI 兼容 `/embeddings` 直连，provider 取 config 键 `ai.embedding`，**默认 `enabled:false`**）：

| 子路 | 代码 | 外发内容 | 触发时机 |
| --- | --- | --- | --- |
| 文件向量 | `embeddings.ts` `embedFileById` | `files.title + files.summary`——summary 为蒸馏 LLM 产物，**非原文** | 蒸馏成功后自动 `enqueueEmbed`（`llmWorker.ts`）+ 手动批量补齐（`routes/llm.ts`） |
| 词条分块向量 | `search/chunkEmbed.ts` `indexWikiChunks` / `ensureChunksIndexed` | wiki 词条 `entry.md` 按 heading 分块的文本（标题路径 + 块正文）。主体是 LLM 产物（标题/摘要/要点）；**边界情形**：蒸馏未产出 summary 时 `entryMd` 回退用原文前 2000 字符（`llmWorker.ts` `sanitized.slice(0, 2000)`），该部分会随分块外发。幂等：`content_hash` 未变的块零调用 | 蒸馏写词条后自动同步 + 启动回填；开关 `search.vectorEnabled`（默认 true） |
| 检索词向量 | `search/hybrid.ts` `resolveQueryVector`；`routes/llm.ts` `POST /embeddings/search` | **用户输入的检索词** | 使用语义 / 向量检索时 |

### 1.4 标签治理——外发标签名与计数，不含正文

| 项 | 内容 |
| --- | --- |
| 代码 | `server/src/llm/tagGovernance.ts` `semanticScanJob`（语义归组）/ `levelScanJob`（二级领域选拔），经 `callLlmJson` → `getDefaultProvider/getDefaultModel` |
| 外发内容 | 标签名 + 使用次数（JSON 数组，默认批 400 个）；level 扫描另附一级领域名与挂载次数。**不含任何文件正文** |
| 触发时机 | 设置页标签治理手动启动（`startSemanticScan` / `startLevelScan`），后台分批执行 |

### 1.5 对话问答 I1——随本版落地后生效（截至今日未实现）

`server/src/routes/chat.ts` **不存在**（核实于 2026-09-21，Glob 确认）。v0.1.5 第 6 批 I1 落地后生效，届时外发 = **用户提问 + 检索摘要上下文**。**I1 落地时须回填本节。**

### 1.6 用户画像蒸馏 J1——只外发统计，不含原始内容

| 项 | 内容 |
| --- | --- |
| 代码 | `server/src/profile/distill.ts` `processProfileJob` / `buildProfileDistillPrompt`（数据源 `profile/aggregate.ts` `buildProfileSignalBundle`） |
| 外发内容 | 30 天窗口**聚合统计**（全局与按域的读取次数 / agent 消费次数 / 评分均值 / 复习完成率 / top 标签及权重）+ 上版画像 active 断言 + 用户补充（user_added）/ 已否决（vetoed）断言 + 证据编号桶（仅 `read_history:123` 这类 `表名:行号` 指针，**不含记录内容**）。**不含任何原始阅读 / 对话正文**——画像链路的隐私优势：prompt 只见统计数字。低信号域（`meetsThreshold=false`）不进 prompt |
| 触发时机 | 信号累积或手动触发 `triggerProfileDistill`（月频任务，进程内单飞去重） |
| 开关 | config `userProfile.enabled`（默认开）；关闭后直接 return，不入队 |

## 2. 不外发的环节

- **门禁过滤**：`server/src/gate.ts` `isExcludedPath` / `checkGate` / `checkGateSample` 全部为本地规则（大小 / 有效字符 / 代码占比 / 黑白名单正则与通配）。全仓 `callLlm` / `callEmbedding` 调用点无一处位于门禁链路——**规则门禁不外发，且不存在 LLM 语义判定调用**（原清单第②项据此修正）。
- **FTS 关键词检索**（`search/ftsIndex.ts`）：本地 SQLite。
- **站内阅读器**（`reader.ts`）：本地渲染 + 图片代理。
- **MCP Server**：stdio 本地进程通信，不监听网络端口。

## 3. 排除与关闭机制

| 诉求 | 机制 | 语义 |
| --- | --- | --- |
| 某目录内容完全不外发 | 设置页「过滤门禁 → 排除目录」（`gate.excludeDirs`，`gate.ts` `isExcludedPath`） | 命中即**完全不入库**（不进任何 LLM 环节） |
| 拦截特定文件 | 文件黑名单（`gate.blacklist`） | 记入 gate_records，可恢复；恢复后进入常规流程（含蒸馏） |
| 全部 LLM chat 停 | 不配置任何服务商（`ai.providers` 为空） | 各环节静默失败 / 跳过 |
| 嵌入停 | `ai.embedding.enabled=false` 或 `search.vectorEnabled=false` | 文件向量 / 分块向量 / 检索词向量全停 |
| 画像停 | `userProfile.enabled=false` | 画像蒸馏不入队 |
| 混合检索回退 LIKE | `search.hybridEnabled=false` | 不再走向量路（含查询嵌入） |

注意方向性：`gate.pathWhitelist`（路径白名单）是**强制入库蒸馏**的放行方向，不是排除方向。

## 4. 脱敏边界（如实声明）

`llmWorker.ts` `sanitizeSensitive` 是**正则遮蔽**（匹配到的密钥赋值 / Bearer 令牌 / 带凭据 URL 替换为 `[REDACTED]`），不是加密也不提供不可逆保证；仅覆盖常见密钥书写形态。正文其余内容按第 1 节所列形态原样外发。

## 5. 核实口径修正记录

原始任务清单 6 处链路的核实结论：

| 原清单 | 结论 |
| --- | --- |
| ① 蒸馏 `llmWorker.processDistill` | ✔ 属实（原文形态，含脱敏与视觉附图边界） |
| ② 门禁语义判定 | ✘ **实无 LLM 调用**——纯规则门禁不外发，口径修正 |
| ③ embedding `embeddings.ts` / `chunkEmbed.ts` | ✔ 属实，实际拆为文件向量 / 词条分块 / 检索词三条子路 |
| ④ tag 治理 `tagGovernance.ts` | ✔ 属实（仅标签名 + 计数） |
| ⑤ 对话问答 I1 `routes/chat.ts` | 未实现（文件不存在），列待生效并要求落地时回填 |
| ⑥ 画像蒸馏 J1 `profile/distill.ts` | ✔ 属实（仅统计 + 标签权重 + 上版画像，无原始内容） |

清单外补充披露（事实优先）：`processAssess` / `processBackfill` / `processCurate` 三类 LLM 队列 job 与语义检索词嵌入，均为真实外发点，已并入第 1.2 / 1.3 节。
