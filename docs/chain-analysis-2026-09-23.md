# AgentFeed 采集、门禁、蒸馏、消费链路结构化分析报告

- **报告时间**: 2026-09-23 14:55
- **项目路径**: `/Users/duke/Documents/AgentFeed`
- **分析对象**: AgentFeed 全仓代码、设计文档、前后端实现、当前运行数据库、自动化测试
- **数据库快照**: `/Users/duke/Documents/AgentFeed/server/data/app.db`
- **报告性质**: 只读分析 + 验证报告；本报告不包含业务代码修复
- **验证命令**:
  - `npm test -w server`：通过，346 tests passed，0 failed
  - `npm run build -w web`：通过，`vue-tsc` 与 Vite production build 均通过

---

## 0. 一页结论

最终 owner 需要做的核心决策不是“还要不要继续扩展页面”，而是：

> AgentFeed 目前已经具备完整的知识生产能力，下一阶段应从“继续生产更多知识”切换到“证明已有知识被可靠消费和复用”

AgentFeed 当前已经形成一条较完整的本地知识生产和消费管线：

```text
本地文件系统
  → 采集扫描
  → 路径/内容门禁
  → files 热数据层
  → LLM 蒸馏
  → Wiki / 标签 / 领域 / FTS / 向量索引
  → Web / MCP / Chat / 推荐 / Reader 消费
  → 阅读反馈 / MCP 调用日志 / 执行队列
```

总体判断：

| 链路 | 当前状态 | Owner 视角结论 |
|---|---|---|
| 采集 | ✅ 较成熟 | 文件发现、增量更新、软删除、版本识别、异常护栏已经比较完整；继续扩大采集范围不是当前第一优先级。 |
| 门禁 | ✅ 规则完整 | 能有效过滤低价值文件，并保留恢复与归档通道；下一步重点是用真实误杀数据校准规则。 |
| 蒸馏 | ⚠️ 功能完整但稳定性仍是瓶颈 | 队列、重试、provider failover、JSON 宽容解析已经存在；但累计失败量、状态一致性和索引一致性仍需专项治理。 |
| 检索 | ⚠️ 三路混合检索已落地 | files LIKE + Wiki FTS + entry chunks 向量已实现；但向量覆盖并非全量，FTS 存在孤儿索引疑点。 |
| 消费 | ⚠️ 出口齐全但真实消费偏弱 | Web、MCP、Chat、推荐、Reader、getContext、用户画像出口都已接线；但真实调用和深读数据很少。 |
| 反馈闭环 | ❌ 尚未有效形成 | 目前能证明“知识被生产出来”，还不能充分证明“知识被持续复用”。 |

当前最重要的三个问题：

1. **蒸馏资产一致性不足**：存在 `files.llm_state=done` 但缺少 `wiki_entries_meta` 的文件，也存在少量反向不一致。
2. **索引覆盖和一致性需要治理**：`entry_chunks` 向量覆盖约四成 active Wiki；`wiki_fts` 行数高于 Wiki meta，存在孤儿索引疑点。
3. **消费闭环过弱**：MCP 调用只有几十次，`read_entry` 和 `get_source` 深度消费样本极少，`read_history` 只有个位数。

---

## 1. 分析范围与方法

### 1.1 已阅读和对照的主要文件

#### 后端核心链路

- `/Users/duke/Documents/AgentFeed/server/src/index.ts`
- `/Users/duke/Documents/AgentFeed/server/src/scanner.ts`
- `/Users/duke/Documents/AgentFeed/server/src/watcher.ts`
- `/Users/duke/Documents/AgentFeed/server/src/gate.ts`
- `/Users/duke/Documents/AgentFeed/server/src/extractor.ts`
- `/Users/duke/Documents/AgentFeed/server/src/db.ts`
- `/Users/duke/Documents/AgentFeed/server/src/knowledge.ts`
- `/Users/duke/Documents/AgentFeed/server/src/context.ts`
- `/Users/duke/Documents/AgentFeed/server/src/mcp.ts`
- `/Users/duke/Documents/AgentFeed/server/src/mcpTools.ts`

#### LLM、蒸馏、向量与检索

- `/Users/duke/Documents/AgentFeed/server/src/llm/index.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmQueue.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmWorker.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmClient.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/embeddings.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/hybrid.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/ftsIndex.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/chunkEmbed.ts`

#### HTTP API

- `/Users/duke/Documents/AgentFeed/server/src/routes/files.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/scan.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/gate.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/llm.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/wiki.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/search.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/chat.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/recommend.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/reading.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/stats.ts`

#### 前端消费界面

- `/Users/duke/Documents/AgentFeed/web/src/api.ts`
- `/Users/duke/Documents/AgentFeed/web/src/views/Overview.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Pipeline.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Library.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Entry.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Reader.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Chat.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Supply.vue`
- `/Users/duke/Documents/AgentFeed/web/src/stores/useFilesStore.ts`
- `/Users/duke/Documents/AgentFeed/web/src/stores/useLlmStore.ts`
- `/Users/duke/Documents/AgentFeed/web/src/stores/useWikiStore.ts`

#### 设计文档

- `/Users/duke/Documents/AgentFeed/docs/gate-design.md`
- `/Users/duke/Documents/AgentFeed/docs/knowledge-flywheel-design.md`
- `/Users/duke/Documents/AgentFeed/docs/dual-consumer-exits-design.md`
- `/Users/duke/Documents/AgentFeed/docs/context-kernel.md`
- `/Users/duke/Documents/AgentFeed/docs/feedback-loop-design.md`
- `/Users/duke/Documents/AgentFeed/docs/llm-failure-attribution.md`
- `/Users/duke/Documents/AgentFeed/docs/reading-recommendation-prd.md`
- `/Users/duke/Documents/AgentFeed/docs/v0.1.5-prd.md`
- `/Users/duke/Documents/AgentFeed/docs/privacy-boundary.md`
- `/Users/duke/Documents/AgentFeed/docs/search-baseline-2026-10.md`

### 1.2 当前工作区状态说明

分析时项目处于已有大量未提交修改状态，且本轮执行 `npm run build -w web` 会刷新 `/Users/duke/Documents/AgentFeed/server/public/` 下的前端构建产物。报告不对这些已有改动做清理或回滚。

---

## 2. 当前运行数据库快照

> 以下数据来自 `/Users/duke/Documents/AgentFeed/server/data/app.db`，服务运行中，数字会随后台任务继续变化。

### 2.1 核心表规模

| 指标 | 数量 |
|---|---:|
| files 总数 | 70,178 |
| active 文件 | 55,183 |
| deleted 文件 | 14,995 |
| active + `llm_state=done` | 约 50,700 |
| active + `llm_state=pending` | 约 2,700 |
| active + `llm_state=running` | 8 |
| active + `llm_state=failed` | 约 1,700 |
| wiki_entries_meta | 约 45,100 |
| file_embeddings | 3,054 |
| entry_chunks | 35,456 |
| 有 chunk 的 entry | 17,552 |
| gate_records | 35,218 |
| read_history | 6 |
| mcp_call_logs | 43 |
| llm_call_logs | 约 81,000+ |

### 2.2 扫描台账

| source | jobs | scanned | added | updated | deleted | gated |
|---|---:|---:|---:|---:|---:|---:|
| boot | 50 | 3,309,256 | 66 | 9,680 | 4,768 | 1,020,849 |
| interval | 86 | 4,033,680 | 31 | 6,481 | 20,050 | 1,196,567 |
| manual | 13 | 13 | 5 | 1 | 120 | 6 |
| test | 7 | 9 | 7 | 1 | 95 | 1 |

观察：扫描范围很大，新增文件很少，说明系统大部分工作是在维护已有状态，而不是持续接收大量新文件。

### 2.3 LLM 调用与失败

| 指标 | 数量 |
|---|---:|
| LLM 调用总数 | 约 81,000+ |
| success | 约 55,000+ |
| failed | 约 25,000+ |
| rate_limited | 1 |

失败主因分布中，历史累计主要是：

| 失败类型 | 数量级 |
|---|---:|
| `llm_output_not_json` | 约 19,000+ |
| `content_too_long_for_model` | 约 5,800 |
| `Stream ended without finish_reason` | 约 200 |
| embedding 约束错误 | 约 180 |
| `terminated` | 约 160 |

说明：历史失败主要集中在 JSON 输出契约、内容过长、网关/模型异常和 embedding 配置/约束问题。

### 2.4 MCP 与阅读消费

| 消费信号 | 数量 |
|---|---:|
| MCP 调用总数 | 43 |
| `search_knowledge` | 35 |
| `stats` | 3 |
| `get_source` | 2 |
| `read_entry` | 1 |
| `list_domains` | 1 |
| `legacy_tool` | 1 |
| read_history | 6 |

观察：搜索调用已经有少量使用，但深读和引用链路极弱。当前还不能证明知识资产被稳定复用。

---

## 3. 采集链路分析

### 3.1 采集入口

采集有四种触发来源：

1. **启动扫描**：服务启动后延迟执行，补齐停机期间变化。
2. **watcher 实时监听**：文件新增、修改、删除时调用单文件扫描。
3. **周期扫描**：默认按配置周期执行增量扫描。
4. **手动扫描**：由 Web/API 触发。

对应代码：

- `/Users/duke/Documents/AgentFeed/server/src/index.ts`
- `/Users/duke/Documents/AgentFeed/server/src/watcher.ts`
- `/Users/duke/Documents/AgentFeed/server/src/scanner.ts`

### 3.2 单文件采集流程

```text
scanFile(fp, roots)
  → 扩展名过滤：仅 .md / .html
  → 路径排除：Gate 1
  → stat 读取文件大小和 mtime
  → mtime + size 快路径判断
  → md5 流式计算
  → 门禁判定
  → extractor 提取 title / alias / content_time / source_agent
  → files upsert
  → status=active
  → llm_state=pending
```

### 3.3 增量机制

采集层具备多重增量优化：

- `mtime + size` 未变时跳过重算。
- 文件变化后用 md5 判断实际内容变化。
- md5 相同但路径变化时，可以复用 deleted 行，保留既有知识资产。
- 内容真正变化时写入版本链。

这使系统可以承受几百万级扫描记录，而不必每轮都重复蒸馏。

### 3.4 删除和恢复机制

文件删除不会立刻物理清理，而是：

```text
files.status = deleted
```

价值：

- 保留历史知识资产。
- 支持后续恢复。
- 支持同 md5 文件迁移后重链接。

但这也带来一个风险：当扫描根被移除或外部卷异常时，deleted 数据可能积累，需要更明确的恢复/清理策略。

### 3.5 墓碑化护栏

`/Users/duke/Documents/AgentFeed/server/src/scanner.ts` 中定义：

```text
SWEEP_TOMBSTONE_CAP = 200
```

含义：

- 单个扫描根一轮最多允许自动墓碑化 200 个文件。
- 如果本轮 walk 结果为空，则放弃对该根做批量 deleted。
- 如果候选删除量超过上限，则跳过该根批量删除。

这是一个非常重要的防事故设计，用于避免符号链接、挂载盘、权限异常导致“几万文件被误删状态”。

### 3.6 采集链路评价

优点：

- 采集入口完整。
- watcher 与周期扫描互补。
- md5 和 mtime/size 快路径合理。
- 软删除和版本链适合知识资产场景。
- 对异常扫尾有明确护栏。
- 支持 agent 归因。

风险：

| 风险 | 等级 | 说明 |
|---|---|---|
| 扫描根删除后的孤儿文件 | P1 | 删除根后，旧文件可能长期处于 deleted 或无法自然恢复。 |
| 周期扫描成本较高 | P2 | 扫描量巨大但有效新增很少，需要根级扫描收益分析。 |
| 自定义 data 目录口径不一致 | P2 | 部分代码使用 `process.cwd()/data`，与配置化 data dir 口径可能不完全一致。 |

---

## 4. 门禁链路分析

### 4.1 门禁目标

门禁的核心目标是：

```text
入库前过滤低价值文件
  → 低价值文件不进入蒸馏队列
  → 降低 LLM 成本
  → 保持 Wiki 资产质量
  → 误杀时可恢复
```

设计文档：

- `/Users/duke/Documents/AgentFeed/docs/gate-design.md`

实现代码：

- `/Users/duke/Documents/AgentFeed/server/src/gate.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/gate.ts`
- `/Users/duke/Documents/AgentFeed/server/src/scanner.ts`

### 4.2 门禁优先级

实际优先级如下：

```text
1. gate.enabled=false
   → 大小/内容门禁关闭，放行

2. pathWhitelist
   → 最高优先级，强制放行

3. excludeDirs / 内置路径排除
   → 无痕忽略，不入 files，不入 gate_records

4. blacklist
   → 拦截，可恢复，写 gate_records

5. filenameWhitelist
   → 文件名精确白名单，放行

6. keywords
   → 文件名关键词白名单，放行

7. minSize
   → 文件过小，拦截

8. minChars
   → 有效正文过短，拦截

9. codeRatio
   → 代码围栏占比过高，拦截
```

### 4.3 默认规则

| 规则 | 默认值 / 示例 |
|---|---|
| 最小文件大小 | 512B |
| 最小有效正文字符 | 300 |
| 代码围栏占比上限 | 0.6 |
| 文件名白名单 | `AGENTS.md`, `CLAUDE.md`, `SKILL.md` 等 |
| 关键词白名单 | `prd`, `需求`, `测试`, `复盘`, `设计`, `方案`, `总结`, `笔记` 等 |
| 排除目录 | `node_modules`, `dist`, `.git`, `.vscode`, `server/public` 等 |

### 4.4 大文件门禁策略

大文件不整读：

```text
文件大小 > 512KB
  → 只读头部 64KB 做正文长度检查
  → 再通过流式方式统计代码围栏比例
  → 标记 gate_sampled=1
```

价值：

- 避免大文件导致内存峰值。
- 仍保留基本质量判断。
- 将大文件正文处理交给下游分块/蒸馏压缩。

局限：

- 头部样本不一定代表全文。
- 结构化文档如果正文在后半部分，可能误判。

### 4.5 门禁记录和归档

被内容门禁拦截的文件会写入：

```text
gate_records
```

字段包括：

- path
- name
- ext
- size
- md5
- gate_reason
- rule_id
- gate_metric
- status

历史归档：

- 当前月保留在数据库。
- 历史月份归档到 `/Users/duke/Documents/AgentFeed/server/data/gate-archives/YYYY-MM.csv`。

### 4.6 当前门禁数据

| 指标 | 数量 |
|---|---:|
| gate_records | 35,218 |
| skipped | 35,217 |
| restored | 1 |

按规则：

| rule_id | 数量 |
|---|---:|
| minChars | 18,281 |
| minSize | 15,027 |
| codeRatio | 1,546 |
| blacklist | 3 |
| 历史空值 | 361 |

结论：当前拦截主要来自“正文过短”和“文件过小”，说明门禁主要承担清理占位文档、小 README、简短说明等低价值文件的作用。

### 4.7 门禁链路评价

优点：

- 规则层次清晰。
- 本地执行，不外发 LLM。
- 有恢复和归档通道。
- 能显著减少 LLM 蒸馏成本。
- 有结构化 `rule_id` 和 `gate_metric`，后续可做评估。

风险：

| 风险 | 等级 | 说明 |
|---|---|---|
| 路径排除无记录 | P2 | 命中 excludeDirs 的文件不会留下 gate_records，后续难解释“为什么没入库”。 |
| 关键词白名单可能过宽 | P2 | 文件名命中关键词即放行，可能放过低价值内容。 |
| pathWhitelist 是强制入库 | P2 | 不是排除方向，而是强放行方向，配置错误会绕过门禁。 |
| 历史分析需读 CSV | P2 | 只看数据库无法得到完整门禁历史。 |

---

## 5. 蒸馏链路分析

### 5.1 蒸馏目标

蒸馏层负责把原始文件变成可消费的知识资产：

```text
原始 Markdown / HTML
  → LLM 结构化理解
  → Wiki entry
  → 摘要 / 要点 / 实体 / 关系
  → 领域 / 标签
  → 质量分
  → FTS / chunk / vector
```

核心代码：

- `/Users/duke/Documents/AgentFeed/server/src/llm/index.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmWorker.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmQueue.ts`

### 5.2 调度流程

```text
files.llm_state='pending'
  → startLlmFeeder 定期扫描 pending
  → 放入 LlmQueue
  → provider 并发控制
  → processJob
  → processDistill
  → callLlmWithFallback
  → safeParseWikiJson
  → 写 entry.md / points.json / entities.json / relations.json
  → 写 wiki_entries_meta
  → 更新 files.summary / domain / tags
  → sync FTS
  → enqueue embedding
  → files.llm_state='done'
```

### 5.3 可靠性机制

当前已实现：

| 机制 | 作用 |
|---|---|
| running 重启恢复 | 服务重启后把卡住的 running 任务恢复为 pending。 |
| provider failover | 当前 provider 失败时尝试其他节点。 |
| 网络重试 | 对网络错误和 5xx 做重试。 |
| 429 慢速重试 | 对 RPM/TPM 窗口类错误进行 15s/30s 慢速重试。 |
| maxTokens 显式设置 | 降低模型默认输出上限导致 JSON 截断的概率。 |
| thinking 文本回捞 | 模型把 JSON 放在 thinking 内容时尝试恢复。 |
| JSON 宽容解析 | 支持围栏剥离、截断容错和部分字段恢复。 |
| content_too_long 分类 | 将内容过长与普通 JSON 失败区分，避免无意义重试。 |
| triage 熔断 | 连续失败达到阈值后暂停 triage 类批次。 |
| 日预算闸 | 防止无人消费时继续烧钱。 |
| 调用日志 | 记录 provider、model、token、耗时、状态、错误。 |

### 5.4 蒸馏产物

一个文件蒸馏成功后通常会产生：

- `/Users/duke/Documents/AgentFeed/server/data/wiki/entries/<fileId>/entry.md`
- `/Users/duke/Documents/AgentFeed/server/data/wiki/entries/<fileId>/points.json`
- `/Users/duke/Documents/AgentFeed/server/data/wiki/entries/<fileId>/entities.json`
- `/Users/duke/Documents/AgentFeed/server/data/wiki/entries/<fileId>/relations.json`
- `wiki_entries_meta` 行
- `files.summary`
- LLM 标签
- domain 归类
- FTS 索引
- entry_chunks
- chunk embedding

### 5.5 LLM 失败历史与当前状态

`/Users/duke/Documents/AgentFeed/docs/llm-failure-attribution.md` 已经记录过 H1 根因：

- 大文档导致 JSON 输出截断。
- flash 模型短响应拒答。
- `response_format=json_object` 对部分 provider 不一定真正生效。
- 历史上 `llm_output_not_json` 占失败绝大多数。

代码中已经落地多项修复，包括：

- 显式 `maxTokens=4096`
- thinking 内容回捞
- 空文本重试
- `stopReason` 落库
- `safeParseWikiJson` 宽容解析
- `content_too_long_for_model` 分类

但当前运行数据仍显示累计失败量较大，需要继续看“修复后窗口”的失败率，而不是只看历史累计总量。

### 5.6 蒸馏资产一致性问题

本次数据库检查发现：

| 检查项 | 发现 |
|---|---:|
| active + done 但无 wiki_entries_meta | 约 6,650 |
| active + 非 done 但有 wiki_entries_meta | 少量 |
| active + failed 但有 wiki_entries_meta | 1 左右 |

这意味着当前不能简单地把：

```text
files.llm_state = done
```

等同于：

```text
该文件一定有完整可消费 Wiki 资产
```

可能原因包括：

- 历史迁移遗留。
- Wiki 文件清理后状态未同步。
- 旧版本状态语义变化。
- 导入词条与 LLM 词条混用。
- 某些写入过程部分成功、部分失败。

需要专项一致性审计。

### 5.7 蒸馏链路评价

优点：

- 功能闭环完整。
- 有较多可靠性补丁。
- 对高成本 LLM 调用有日志和预算保护。
- 已经从“直接解析 JSON”演进到“截断容错 + 失败分类”。

风险：

| 风险 | 等级 | 说明 |
|---|---|---|
| 历史失败量高 | P1 | 累计失败调用超过 2.5 万，需要按修复后窗口重新看失败率。 |
| 状态与资产不一致 | P1 | done 不一定有 Wiki，影响消费可信度。 |
| 内容过长仍是难题 | P1 | `content_too_long_for_model` 仍有大量记录，需要更好的文档压缩/分段策略。 |
| embedding 异步最终一致 | P2 | 蒸馏完成不代表向量可用。 |
| provider/model 差异大 | P2 | 不同 provider 的结构化输出能力不同，需要模型级策略。 |

---

## 6. 检索与索引链路分析

### 6.1 检索入口

检索内核：

- `/Users/duke/Documents/AgentFeed/server/src/knowledge.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/hybrid.ts`

HTTP 出口：

- `/Users/duke/Documents/AgentFeed/server/src/routes/search.ts`

MCP 出口：

- `/Users/duke/Documents/AgentFeed/server/src/mcp.ts`

Chat 出口：

- `/Users/duke/Documents/AgentFeed/server/src/routes/chat.ts`

### 6.2 三路混合检索

当前检索为三路融合：

```text
路 1：files LIKE
  - title / summary / path
  - 保留旧搜索行为

路 2：Wiki FTS
  - wiki_fts
  - trigram tokenizer
  - 面向 Wiki entry 的标题、摘要、正文

路 3：分块向量
  - entry_chunks
  - query embedding
  - cosine similarity
```

融合方式：

```text
RRF 合并
  → quality_score × 3 + rule_score 作为先验
  → 可选外部 rerank
  → 返回 Top-K
```

### 6.3 逃生舱

如果：

```text
search.hybridEnabled=false
```

则完全回退到旧 files LIKE 检索。

如果向量不可用：

```text
search.vectorEnabled=false
或 embedding 配置缺失
或 query embedding 失败
```

则跳过向量路，保留 LIKE + FTS。

这是比较好的降级设计。

### 6.4 当前索引数据

| 索引 | 数量 |
|---|---:|
| file_embeddings | 3,054 |
| entry_chunks | 35,456 |
| 有 chunk 的 entry | 17,552 |
| active Wiki entry | 约 44,000 |
| wiki_fts | 约 52,961 |
| wiki_entries_meta | 约 45,100 |

重要说明：

- `file_embeddings` 不是当前混合检索的唯一向量来源。
- 目前混合检索的向量主路是 `entry_chunks.embedding`。
- 以 entry_chunks 计算，向量覆盖约为 active Wiki 的四成左右，而不是 `file_embeddings / wiki_entries_meta` 的 6% 左右。

### 6.5 索引一致性风险

本次检查发现 `wiki_fts` 行数明显高于 `wiki_entries_meta`，且存在约 7,800+ 条 FTS 行无法关联到现有 meta。

可能原因：

- 历史删除后没有清理 FTS。
- 旧索引结构迁移遗留。
- 导入/重建流程曾经产生过孤儿。
- FTS rebuild 未覆盖全部边界。

Owner 视角影响：

- 搜索可能召回已经不存在或无法读取的词条。
- RRF 融合时会有无效候选。
- 相关性评估会被污染。

建议下一步先只读审计，再备份后执行安全重建。

---

## 7. 消费链路分析

### 7.1 消费出口总览

当前消费出口包括：

| 出口 | 面向对象 | 主要用途 |
|---|---|---|
| Web Overview / Pipeline | Owner / 运维 | 看采集、门禁、蒸馏、调用、执行队列状态。 |
| Library / Entry | 人 | 浏览文件和 Wiki 成品。 |
| Reader | 人 | 站内阅读、进度、评分、相关阅读、理解度检查。 |
| Supply | 人 | 推荐池、AI 策展、执行队列。 |
| Chat | 人 | 基于知识库的对话问答和 skill。 |
| MCP | agent | 搜索、读词条、取源路径、开工上下文、用户画像。 |
| API search | 前端/外部 | Web 与其他功能复用搜索内核。 |

### 7.2 Web 看板

`/Users/duke/Documents/AgentFeed/web/src/views/Overview.vue` 已能看到：

- 今日流量
- 收件数量
- 精炼中数量
- Wiki 入库量
- MCP 本周调用
- watcher 状态
- 扫描根数量
- 执行队列
- 阅读统计

这说明 owner 已有基础运营视图。

### 7.3 Reader 阅读链路

`/Users/duke/Documents/AgentFeed/web/src/views/Reader.vue` 与 `/Users/duke/Documents/AgentFeed/server/src/routes/files.ts`、`/Users/duke/Documents/AgentFeed/server/src/routes/reading.ts` 配合实现：

```text
打开 reader/:id
  → GET /api/files/:id/content
  → 服务端校验扫描根边界
  → 读取 md/html
  → 清洗渲染
  → iframe sandbox 展示
  → 写 read_history source=reader
  → 前端上报进度
  → 用户评分/反馈
  → 可进入执行队列
```

安全点：

- 只支持 md/html。
- 文件必须位于启用扫描根内。
- iframe sandbox 不允许 script。
- 图片资源代理有后缀白名单和大小上限。
- 资源路径也必须位于扫描根内。

### 7.4 推荐与执行队列

相关文件：

- `/Users/duke/Documents/AgentFeed/server/src/routes/recommend.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/reading.ts`
- `/Users/duke/Documents/AgentFeed/web/src/views/Supply.vue`

支持能力：

- 推荐预览
- 手动入池
- AI 策展
- 每日推荐
- 阅读评分
- 执行意图：立即试 / 稍后试 / 纯了解
- 执行队列
- 间隔复习
- 完成/忽略

问题：当前真实阅读和执行数据太少，推荐算法很难形成反馈闭环。

### 7.5 MCP 工具链路

当前 `/Users/duke/Documents/AgentFeed/server/src/mcp.ts` 中注册的工具包括：

| 工具 | 作用 |
|---|---|
| `search_knowledge` | 搜索文件和 Wiki。 |
| `read_entry` | 读取蒸馏后的 Wiki entry。 |
| `get_source` | 获取原始源文件路径。 |
| `list_domains` | 列领域。 |
| `list_agents` | 列 agent。 |
| `list_tags` | 列标签。 |
| `stats` | 获取知识库统计。 |
| `getContext` | 获取领域开工上下文。 |
| `get_user_context` | 获取用户画像上下文。 |

注意：部分早期文档仍写“7 个工具”，但当前实现已经是 9 个工具。

### 7.6 Agent 侧理想消费路径

理想路径应该是：

```text
list_domains 或 getContext
  → search_knowledge
  → read_entry
  → get_source
  → 在真实任务中引用或复用
```

但当前真实数据是：

```text
search_knowledge: 35
read_entry: 1
get_source: 2
```

说明 agent 侧大多停留在浅搜索，没有形成稳定深读。

### 7.7 Chat 链路

`/Users/duke/Documents/AgentFeed/server/src/routes/chat.ts` 实现：

```text
用户问题
  → 可选领域上下文 aggregateDomainContext
  → searchKnowledgeCore 检索 Top-5
  → 拼接 title/summary 摘要上下文
  → callLlm
  → SSE 流式返回
  → chat_messages 落库
```

失败时：

- 返回 fallback 搜索结果。
- 记录失败 LLM 调用。
- 不写入半成品 assistant 消息。

隐私边界：

- 普通问答外发用户问题和检索摘要，不直接外发完整原文。
- 会话复盘会外发会话消息全文。
- 相关说明见 `/Users/duke/Documents/AgentFeed/docs/privacy-boundary.md`。

### 7.8 消费链路评价

优点：

- 出口齐全。
- Web 与 MCP 共用检索内核。
- Reader 安全边界较清晰。
- Chat 有失败 fallback。
- MCP 有 args 摘要埋点。
- getContext 和用户画像已经接入 agent 侧。

风险：

| 风险 | 等级 | 说明 |
|---|---|---|
| 真实消费弱 | P1 | MCP 和阅读数据都很少，难证明产品闭环。 |
| search 后深读不足 | P1 | `read_entry` 只有个位数调用。 |
| 消费信号未回流排序 | P2 | 反馈设计已有，但当前主要还是先验分，不是消费驱动。 |
| args 仅摘要 | P2 | 足够用于轻量归因，不适合完整审计。 |
| 文档状态滞后 | P2 | MCP 工具数量、getContext 接线状态与早期文档不完全一致。 |

---

## 8. 设计文档与实现对照

### 8.1 已实现且基本对齐

| 文档 | 对照结论 |
|---|---|
| `/Users/duke/Documents/AgentFeed/docs/gate-design.md` | 门禁三层结构、恢复、归档、配置项和结构化 rule_id 已基本实现。 |
| `/Users/duke/Documents/AgentFeed/docs/llm-failure-attribution.md` | H1 截断容错和失败分类已落地到代码。 |
| `/Users/duke/Documents/AgentFeed/docs/privacy-boundary.md` | 外发链路描述与代码整体一致，门禁本地执行、不外发。 |
| `/Users/duke/Documents/AgentFeed/docs/v0.1.5-prd.md` | 大部分 v0.1.5 能力已有实现，包括混合检索、Chat、Reader、画像、MCP args。 |

### 8.2 部分实现或需要重新标注状态

| 文档 | 差异 |
|---|---|
| `/Users/duke/Documents/AgentFeed/docs/context-kernel.md` | 文档中仍有“待接线”表述，但代码中 `getContext` 和 Chat 已经接入聚合内核。 |
| `/Users/duke/Documents/AgentFeed/docs/dual-consumer-exits-design.md` | 第一、二期部分能力已实现，但真实消费验收数据还不足。 |
| `/Users/duke/Documents/AgentFeed/docs/feedback-loop-design.md` | 消费信号回流仍主要是蓝本，尚未成为排序核心。 |
| `/Users/duke/Documents/AgentFeed/docs/knowledge-flywheel-design.md` | 产品 thesis 仍依赖 agent 消费数据验证，目前数据不足。 |

### 8.3 建议的文档治理方式

建议每个设计文档头部增加：

```markdown
- 状态: 设计中 / 部分实现 / 已实现 / 已验证 / 已废弃
- 对应代码:
- 最近验证时间:
- 验证命令:
- 已知偏差:
```

这样 owner 可以快速区分：哪些是已实现能力，哪些只是设计目标。

---

## 9. 测试与验证状态

### 9.1 后端测试

执行：

```bash
npm test -w server
```

结果：

```text
346 tests passed
0 failed
0 cancelled
0 skipped
0 todo
```

覆盖范围包括：

- scanner
- gate
- sweep guard
- domain/tag
- LLM provider
- tolerant JSON parse
- prompt compression
- hybrid search
- FTS
- chunk embedding
- MCP args log
- getContext
- Chat
- Reader
- recommendation / reading signals
- exec queue
- profile
- quality eval

### 9.2 前端构建

执行：

```bash
npm run build -w web
```

结果：

```text
vue-tsc 通过
vite build 通过
```

说明当前前端类型检查和生产构建通过。

### 9.3 验证边界

虽然自动化测试通过，但本报告中发现的数据问题属于“运行库一致性”和“真实使用闭环”，不能被单元测试完全覆盖。例如：

- done 文件是否都有 Wiki。
- Wiki 是否都有 entry.md。
- FTS 是否存在孤儿。
- chunk embedding 是否全覆盖。
- MCP search 后是否真的 read_entry。
- Reader 反馈是否足够驱动推荐。

这些需要专门的数据审计任务。

---

## 10. 成熟度评分

| 模块 | 成熟度 | 理由 |
|---|---:|---|
| 采集 | 8/10 | 增量、watcher、软删除、异常护栏较完善；根级成本和孤儿清理仍需增强。 |
| 门禁 | 8/10 | 规则和恢复归档完整；需要误杀校准和历史审计增强。 |
| 蒸馏 | 6/10 | 功能完整，可靠性补丁较多；失败量和资产一致性仍是瓶颈。 |
| 检索 | 6.5/10 | 三路融合已落地；索引覆盖和孤儿 FTS 需治理。 |
| Web 消费 | 7/10 | 页面功能齐全；真实使用量不足。 |
| MCP 消费 | 5.5/10 | 工具齐全且有埋点；深读和复用证据不足。 |
| Chat | 7/10 | 问答链路完整，有 fallback；质量仍依赖检索和蒸馏资产。 |
| 推荐/阅读闭环 | 5/10 | 功能存在，但反馈样本太少。 |
| 数据治理 | 5/10 | 有日志和台账，但跨表一致性审计不足。 |

---

## 11. 优先级问题清单

### P1-1：建立蒸馏资产一致性审计

目标：回答每个文件是否拥有完整可消费资产。

建议检查：

```text
files
  ↔ wiki_entries_meta
  ↔ entry.md
  ↔ wiki_fts
  ↔ entry_chunks
  ↔ embedding
```

输出分类：

- done 但无 meta
- meta 但无 entry.md
- meta 但 file deleted
- failed 但有 meta
- FTS 孤儿
- chunk 孤儿
- chunk 无 embedding

### P1-2：安全重建 FTS

当前 `wiki_fts` 行数高于 `wiki_entries_meta`，存在孤儿索引疑点。

建议流程：

1. 备份数据库。
2. 导出当前 FTS 与 meta 对账结果。
3. 执行 rebuild。
4. 重跑搜索基线。
5. 对比 Top-K 差异。

### P1-3：按修复后窗口统计 LLM 失败率

不要只看历史累计失败，应按 H1 修复后的时间窗口统计：

- 总调用
- 成功率
- parse 失败率
- `content_too_long_for_model`
- stop reason=length
- provider/model 分布
- token 浪费

### P1-4：验证 MCP 深度消费漏斗

核心漏斗：

```text
search_knowledge
  → 30 分钟内 read_entry
  → 30 分钟内 get_source
  → 任务中引用或复用
```

当前 `search_knowledge=35`，`read_entry=1`，说明此漏斗还没有跑起来。

### P1-5：明确消费驱动的蒸馏策略

当前仍有大量蒸馏资产和 pending/failed 文件。如果真实消费不足，应避免继续无差别蒸馏，优先：

- 被搜索命中过的文件。
- 被 read_entry 深读过的领域。
- owner 当前任务相关领域。
- 高质量且低成本文档。

### P2-1：门禁误杀校准

建议统计：

- 每个 rule_id 的恢复率。
- 恢复后是否进入 read_history/MCP。
- 哪些白名单放行后从未被消费。
- 大文件 sampled 的误杀情况。

### P2-2：统一文档状态

将设计文档分成：

- 已实现已验证
- 已实现未验证
- 部分实现
- 仅设计
- 已废弃

避免 owner 误把设计目标当成当前能力。

### P2-3：扫描成本观测

建议新增根级指标：

- 每个 root 扫描耗时
- walked 文件数
- added/updated/deleted/gated
- 有效变更率
- 上次扫描时间

用于降低大范围周期扫描成本。

---

## 12. Owner 决策建议

### 12.1 不建议马上继续扩展新页面

当前页面已经足够多，且真实消费数据不足。继续加页面会扩大维护面，但不能解决核心问题。

### 12.2 建议下一阶段主题改为“链路健康审计”

优先做一个只读健康面板或脚本，回答：

1. 采集进来的文件是否稳定？
2. 门禁有没有误杀高价值文件？
3. 蒸馏成功的文件是否真的有 Wiki？
4. Wiki 是否真的可被搜索？
5. 搜索结果是否被深读？
6. 深读内容是否被任务复用？

### 12.3 建议把成功标准从“生产多少知识”改为“复用多少知识”

更适合作为下一阶段指标：

| 指标 | 目标示例 |
|---|---|
| MCP search 调用 | 每周 ≥ 20 次 |
| search → read_entry 跟随率 | ≥ 20% |
| read_entry → get_source 跟随率 | ≥ 10% |
| Reader 打开 | 每周 ≥ 10 次 |
| 阅读评分 | 每周 ≥ 5 次 |
| 被消费词条占比 | 持续上升 |
| 消费驱动蒸馏占比 | 持续上升 |

---

## 13. 本轮已实现 / 未实现 / 需补充考虑和增强

### 13.1 已实现

本轮完成的是分析、文档化和验证：

- 已梳理 AgentFeed 从采集、门禁、蒸馏、索引到消费的完整链路。
- 已读取核心后端、前端、MCP、LLM、检索、Reader 和推荐相关代码。
- 已对照主要设计文档，区分已实现、部分实现和文档滞后。
- 已读取当前运行数据库，整理采集、门禁、蒸馏、索引和消费数据。
- 已运行后端测试，结果为 346 个测试全部通过。
- 已运行前端构建，`vue-tsc` 与 Vite build 均通过。
- 已输出本 Markdown 报告。

### 13.2 未实现

本轮未做以下事项：

- 未修复任何代码逻辑。
- 未重建 FTS。
- 未修复 `files` 与 `wiki_entries_meta` 的不一致。
- 未批量重试 failed 蒸馏任务。
- 未补齐全部 embedding。
- 未调整门禁阈值。
- 未新增 MCP 或 Reader 埋点。
- 未清理当前工作区已有未提交改动。
- 未对历史 gate archive CSV 做完整跨月统计。

### 13.3 需补充考虑和增强

建议下一轮优先落地：

1. **链路健康审计脚本/页面**：对 files、Wiki、FTS、chunks、embedding 做一致性检查。
2. **LLM 失败窗口化分析**：只看 H1 修复后的失败率，避免历史失败干扰判断。
3. **FTS 安全重建流程**：解决孤儿索引疑点。
4. **MCP 消费漏斗面板**：统计 search → read_entry → get_source 的真实跟随率。
5. **门禁误杀反馈闭环**：恢复后的文件若被消费，应反向提示规则可能过严。
6. **消费驱动蒸馏策略**：停止无差别扩张，优先蒸馏真实 query 和任务指向的内容。

---

## 14. 附录：关键路径速查

### 14.1 采集

- `/Users/duke/Documents/AgentFeed/server/src/scanner.ts`
- `/Users/duke/Documents/AgentFeed/server/src/watcher.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/scan.ts`

### 14.2 门禁

- `/Users/duke/Documents/AgentFeed/server/src/gate.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/gate.ts`
- `/Users/duke/Documents/AgentFeed/docs/gate-design.md`

### 14.3 蒸馏

- `/Users/duke/Documents/AgentFeed/server/src/llm/index.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmWorker.ts`
- `/Users/duke/Documents/AgentFeed/server/src/llm/llmQueue.ts`
- `/Users/duke/Documents/AgentFeed/docs/llm-failure-attribution.md`

### 14.4 检索

- `/Users/duke/Documents/AgentFeed/server/src/knowledge.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/hybrid.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/ftsIndex.ts`
- `/Users/duke/Documents/AgentFeed/server/src/search/chunkEmbed.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/search.ts`

### 14.5 消费

- `/Users/duke/Documents/AgentFeed/server/src/mcp.ts`
- `/Users/duke/Documents/AgentFeed/server/src/mcpTools.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/chat.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/files.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/recommend.ts`
- `/Users/duke/Documents/AgentFeed/server/src/routes/reading.ts`
- `/Users/duke/Documents/AgentFeed/web/src/views/Reader.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Chat.vue`
- `/Users/duke/Documents/AgentFeed/web/src/views/Supply.vue`

下一阶段建议优先做一个“链路健康审计”而不是继续加新功能，输出以下四张表：

1. **蒸馏资产一致性表**
   - 文件状态
   - Wiki meta
   - entry.md
   - FTS
   - chunks
   - embedding
2. **LLM 失败归因表**
   - provider/model
   - 错误类型
   - stop reason
   - 文件大小
   - 是否最终成功
3. **门禁误杀/恢复表**
   - 规则
   - 恢复次数
   - 恢复后的消费次数
   - 是否应调整规则
4. **消费漏斗表**
   - search
   - read_entry
   - get_source
   - Chat 引用
   - Reader 打开
   - 阅读反馈
   - 执行队列完成

