# E2 聚合内核使用文档（server/src/context.ts）

> 版本：v0.1.5（PRD 3.3.5 E2 · 第 4 批前置解耦） | 状态：内核已交付，E2/I1 接线待办
> 一句话：领域上下文实时聚合器——按先验分取该领域 top 词条，组装 token 预算内的注入文本，零 DDL、零缓存表。

## 1. 定位与设计原则

**为什么是一个独立内核**：agent 侧注入（MCP 第 8 工具 getContext，E2）与人侧对话领域陪练官角色（I1）消费**同一份数据源**——两个出口读到同一份领域画像，不漂移。排序错、预算失守或口径漂移会同时污染两端。

**为什么零缓存**：蒸馏更新自然反映到下次聚合（纯 SQL 实时查询）；性能不足再加缓存（届时走 `ensureColumns` 或新表，另立迁移，PRD E2 明确）。

**先验口径**（与 [recommend.ts](../server/src/routes/recommend.ts) / [llmWorker.ts](../server/src/llm/llmWorker.ts) 完全一致，勿单方改动）：

```
排序 = quality_score IS NOT NULL DESC          -- 已评分词条优先
     → (quality_score × 3 + rule_score) DESC    -- 先验分（满分 40）
     → distilled_at DESC                        -- 同分取新
```

**排除口径**：软删文件（`status='deleted'`，防幽灵知识注入）、空标题词条不进入注入，也不虚增 entryCount。

## 2. API

### 2.1 `aggregateDomainContext(domain, opts?) → Promise<DomainContext | null>`

| 参数 | 类型 | 说明 |
|---|---|---|
| `domain` | `string \| number` | 领域名称或 id；纯数字字符串按 id 解析 |
| `opts.topN` | `number?` | top 条数，缺省 10（`DEFAULT_TOP_N`） |
| `opts.tokenBudget` | `number?` | 覆盖本次预算；缺省读 config 键 `getContext.tokenBudget`（仍缺省 1500，`DEFAULT_TOKEN_BUDGET`） |

**领域不存在返回 `null`**——「空领域/冷启动」的用户话术属出口层（E2 工具描述 / I1 角色），内核不做假设。

返回 `DomainContext`：

| 字段 | 说明 |
|---|---|
| `domainId` / `domainName` | 解析后的领域标识 |
| `entryCount` | 该领域可注入词条总数（口径与 top 查询一致：active + 有标题） |
| `topEntries[]` | 完整 top N 结构化清单（entryId/fileId/title/summary/priorScore/fileMtime），**不受预算截断影响**，调用方可按需再剪（如 I1 拼引用链接） |
| `summaryText` | 预算内注入文本（头部行 + 逐词条要点行） |
| `tokenEstimate` / `tokenBudget` / `truncated` | 预算口径；`truncated=true` 时 summaryText 末行带截断提示（不静默） |

### 2.2 `estimateTokens(text) → number`

确定性 token 估算：CJK 字符（含中文标点/全角）按 1 token，其余按 ~4 字符/token 折算。不追求精确，只求同一口径下可比较、可预算。I1 组装 system prompt 时复用它做总预算控制。

### 2.3 常量

- `DEFAULT_TOKEN_BUDGET = 1500`、`CONFIG_KEY_TOKEN_BUDGET = 'getContext.tokenBudget'`
- `DEFAULT_TOP_N = 10`

## 3. 预算与截断规则（三档行为）

| 档位 | 行为 |
|---|---|
| 预算充足 | 全部要点行进入，`truncated=false` |
| 预算紧张 | **整行放不下即停**（不撕半行，保持可读），追加提示行「超出 token 预算已截断，可用 getContext.tokenBudget 调整」 |
| 极小预算 | 首行硬截断兜底（预算再小也给出「领域存在 + 名称」的最小信号），头部行必保留 |

单词条要点行内 summary 截断 120 字符（`ENTRY_SUMMARY_SLICE`，与 A3 摘要 80 字符展示口径同量级，注入场景放宽）。title/summary 均折叠空白（脏 title 的连续换行不进注入文本）。

## 4. 使用示例

### 4.1 E2 薄壳（mcp.ts 注册第 8 工具，待接线）

```ts
import { aggregateDomainContext } from './context.js'

const ctx = await aggregateDomainContext(args.domain) // { domain: string }
if (!ctx) {
  return { content: [{ type: 'text', text: `领域「${args.domain}」不存在。可先调用 list_domains 查看。` }] }
}
return { content: [{ type: 'text', text: ctx.summaryText }] }
```

### 4.2 I1 领域陪练官角色注入（chat，待接线）

```ts
import { aggregateDomainContext, estimateTokens } from './context.js'

const ctx = await aggregateDomainContext(domainName, { tokenBudget: 800 }) // 角色背景预算与检索上下文分开控制
const system = [
  `你是 AgentFeed 的「${ctx.domainName}」领域陪练官，回答须锚定库内知识，超出库内范围时如实说明。`,
  ctx.summaryText
].join('\n')
// topEntries 可再拼为可点击引用列表（fileId → reader 链接）
```

### 4.3 终端快速体验

```bash
cd server && npx tsx -e "
import('./src/context.js').then(async m => {
  const ctx = await m.aggregateDomainContext(process.argv[1] ?? '')
  console.log(ctx ? ctx.summaryText : '(领域不存在)')
})" '你的领域名'
```

注意：直连的是 `server/data/app.db`（受 `AGENTFEED_DATA_DIR` 覆盖），只读不写。

## 5. 配置

| config 键 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `getContext.tokenBudget` | number | 1500 | E2 注入预算；I1 建议调用方显式传 `opts.tokenBudget` 与检索上下文分账 |

无迁移：本模块零 DDL（读 `domains/files/wiki_entries_meta/config` 既有表）。

## 6. 测试与验证

```bash
cd server
npx tsx --test test/context.test.ts   # 6 用例：排序口径/软删排除/预算三档/config 覆盖/token 估算
npx tsc --noEmit
```

契约钉住的「为什么」：先验口径错会同时污染 E2/I1 两出口；软删词条误注入 = 幽灵知识；截断静默 = agent/人不自知地拿到残缺画像。改动排序或预算逻辑必跑本套件（AGENTS.md 测试纪律）。

## 7. 后续接线清单（内核之外）

- [ ] E2：mcp.ts 注册 `getContext(domain)` 工具（含工具描述与 E1 的深读引导语）；`MCP_SETUP.md` 补第 8 工具说明
- [ ] I1：chat 角色背景注入 + topEntries 引用链接
- [ ] E2 验收门槛（PRD 10.2 第 6 条）：≥2 项目挂载指引、≥3 次真实消费、预算开关生效——其中"开关生效"已由本套件 config 用例背书
