# CLAUDE.md — AgentFeed AI 协作规则

本地 AI Agent 产物知识库：采集 → 门禁 → 分拣 → LLM 蒸馏 → Web 看板 + MCP 双出口；
npm workspaces（server + web），SQLite 单文件（19 表），端口 5188。阅读推荐闭环（M1~M5）与站内阅读器（R4-M1~M3）已全部交付。

## 开工指引（E2）

开工先调 AgentFeed MCP 工具 `getContext('<domain>')` 获取领域知识库上下文（可用域名先查 `list_domains`）；检索命中只是摘要，深读用 `read_entry`。工具分层见 `MCP_SETUP.md`。

## 命令速查

| 命令 | 说明 |
| --- | --- |
| `./service.sh start\|restart\|build\|status\|logs` | 服务启停/构建（自动构建缺失产物） |
| `npm test -w server` | 后端测试（node:test，当前 107 个；改 reader.ts / 门禁 / 打分 / 归因必跑） |
| `npm run build -w web` | 前端构建（vue-tsc + vite，构建即类型检查） |
| `cd server && npm run mcp` | 启动 MCP stdio server |

## 结构速查

- `server/src/routes/` — 11 个 Express router：files（含 R4 阅读器 content/asset）、reading（进度/打分/stats/周目标）、recommend（池/策展/daily 轮转）、scan、domains、tags、stats、config、llm、wiki、gate
- `server/src/reader.ts` — 站内阅读器管线：md/html 渲染 → cheerio 白名单清洗 → TOC 锚点 → 图片代理改写 → 包壳
- `server/src/llm/` — 蒸馏队列/工人、8 家 LLM 服务商、embeddings、tagGovernance
- `server/src/db.ts` — 建表 + `ensureColumns` 幂等加列迁移链
- 标签体系三态（2026-09-18 起）：`level` ∈ primary（一级关键领域，必须挂靠领域树 `tags.domain_id`）/ secondary（次要领域，仍参与标记）/ normal（普通默认，新建/导入/自动创建均落此）；存量迁移由 config 键 `tagSystem.levelVersion` 驱动（db.ts `migrateTagLevels`：同名领域锚点自动挂靠，其余碎片 primary 转 normal）；PATCH 设 primary 强制挂靠（同名自动匹配或显式 domainId，否则 400）；levelScanJob 方向 = 从 normal 高频（≥50）中选拔二级领域提案（不再是低频降级）
- 采集边界与可观测性：LLM 蒸馏图片引用必须落在已启用扫描根内（llmWorker `extractLocalImageRefs` 的 `allowedRoots`，fail-closed）；wiki import/preview 过 `withinScanRoots`；agent 归因信任序 = frontmatter 声明 > 扫描根绑定 > 根后首段目录名，存量回填由 config 键 `agentAttribution.version` 驱动（scanner.ts `backfillAgentAttribution`）；gate_records 落 `rule_id` + `gate_metric`（GateVerdict 结构化裁决），files.`gate_sampled` 标记 >512KB 抽样门禁（D6 前端口径拆分用，stats 拆分延后至 D6）
- `web/src/views/` — Overview（周卡/每日精选/执行队列/目标环）、Supply（推荐池/进度挡位）、Reader（站内阅读）、Library、Domains、Pipeline、Entry、Settings

## 硬规则（红线，违反即事故）

1. **扫描根边界**：任何读磁盘的端点（open/reveal/asset）目标路径必须落在已启用扫描根内——复用 files.ts 的 `withinScanRoots`（L163）模式，新端点碰磁盘先过这关
2. **阅读器零脚本执行**：站内渲染内容的安全承诺 = 服务端白名单清洗（reader.ts）+ iframe sandbox 不含 allow-scripts，双保险缺一不可；改清洗管线必跑 `server/test/reader.test.ts`（6 个安全用例钉死 script/on*/危险协议/危险标签）
3. **SQLite 迁移**：只用 `ensureColumns(db, table, columns)` 幂等加列（PRAGMA 检查后 ALTER ADD），不写破坏性迁移
4. **API 约定**：响应统一 `{ success: boolean, ... }`；前端 `api.ts` 是**命名导出** `{ api }`（不是默认导出，曾踩坑）
5. **埋点 source 集合**：`preview / pool / exec / daily / reader`——新增打开出口先对齐这个集合，read_history 按 source 区分渠道

## 已知债务与陷阱

- ~~`server/src/mcp.ts` 既有 zod 类型错误~~ 已修复（2026-09-17）：根因是 zod 双副本冲突——server 锁 `^3.23.0` 装到 3.25.76，与 SDK 1.30 类型引用的根 zod 4.x 结构不兼容（ShapeOutput/TS2589）；已将 server zod 升到 `^4.0.0` 统一大版本，tsc 全绿。注意 zod 声明勿再回退到 3.x
- web 依赖曾被根目录 npm install 波及丢失（removed 330 packages 事件）：若 `npm run build -w web` 报 vue-tsc 缺失，先 `cd web && npm install`
- SearchReplace 跨大段替换时警惕吞掉相邻路由声明行（曾误删 `/:id/reveal`），替换后跑测试确认

## 深入文档

| 文档 | 内容 |
| --- | --- |
| `docs/reading-recommendation-prd.md` | 阅读闭环 PRD v2.1（M1~M5 全交付，含 API/表结构定义） |
| `docs/preview-reader-prd.md` | R4 站内阅读器 PRD（M1~M3 全交付，双保险沙箱设计） |
| `docs/gate-design.md` | 内容门禁设计 |
| `MCP_SETUP.md` | MCP 挂载与 7 个工具说明 |
