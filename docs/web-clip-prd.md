# PRD：网页剪藏（Web Clip，收件坪新 Tab）

> 版本 v1.0 · 2026-09-24 · 状态：设计定稿，待排期
> 决策记录：落盘目录用户自配（Settings）｜Playwright 抓取｜MD+HTML 双文件**均全量入库蒸馏向量化**并做关联｜同步单条 + 历史列表

## 第 1 章 · 背景与目标

AgentFeed 的知识来源目前依赖「Agent 产物落盘 → 扫描根发现」。网页（文档、博客、竞品公告）只能靠人工另存为文件再丢进扫描根，链路断裂且元数据（来源 URL、抓取时间）丢失。

目标：在收件坪（`/library`）新增「网页剪藏」tab，粘贴 URL → 服务端抓取转换 → 落盘到用户配置的剪藏目录 → **复用现有全部管线**（扫描 → 门禁 → 打分 → LLM 蒸馏/wiki → embeddings/FTS → 阅读器），不另建第二套入库通道。

非目标（M1~M3 明确不做）：
- 批量 URL 队列 / 定时订阅抓取
- 正文手动框选、阅读模式微调
- 登录态抓取（带 Cookie 的私有页面）

## 第 2 章 · 用户场景

1. **剪藏文档**：读一篇好文章，复制 URL 粘进收件坪剪藏 tab → 数秒后收件坪出现 1 个 md 文件（+1 个 html 快照），来源 agent 显示 `webclip`，自动进入蒸馏队列，稍后生成 wiki 词条并被混合检索命中。
2. **回溯原文**：蒸馏摘要不够看时，打开关联的 html 快照，离线还原页面原始排版。
3. **失败重试**：目标站 5xx/超时，历史列表标红，一键重试。

## 第 3 章 · 功能模块设计

### 3.1 收件坪 Tab 结构

Library.vue 顶部新增 tab 切换（复用 chip 样式体系）：「文件清单」（现视图原样）/「网页剪藏」。

剪藏面板组成：
- URL 输入框 + 提交按钮（同步执行，按钮 loading，超时 45s 报错）
- 选项：「保存 HTML 快照」（默认开）、「强制重剪」（默认关）
- 未配置存储目录时显示引导态 → 跳 Settings 配置
- 历史列表：时间 / 标题 / URL / 状态（成功/失败）/ 耗时 / 文件数（md+html）/ 操作（重试）

### 3.2 Settings 配置块

Settings.vue 新增「网页剪藏」区：
- `webclip.storageRoot`：存储目录（config 表键）。保存时服务端 `mkdir -p` 并**幂等注册**为 `scan_roots` 行（`enabled=1, agent='webclip'`），用户在既有扫描根管理中可见可停用
- 目录校验：不可与其他扫描根重复/嵌套（同 scan.ts 挂载校验口径）

## 第 4 章 · 系统架构设计

```
web/src/views/Library.vue (tab)
  └─ api.webclip.*  ──────────────┐
server/src/routes/webclip.ts (第 12 个 router)
  ├─ SSRF 校验（URL 白名单协议 + DNS 逐 IP 拒私网/环回 + 逐跳复检）
  ├─ server/src/webclip/fetcher.ts   ← Playwright(chromium) lazy 单例，空闲 60s 自关
  ├─ server/src/webclip/convert.ts   ← 渲染后 HTML → 正文提取 → MD（cheerio 白名单思路同 reader.ts）
  ├─ 图片本地化：下载到 <root>/assets/<docId>/，MD 与 HTML 同时改写引用
  ├─ 双文件落盘（同名成对，见第 6 章）→ 路径复验 withinScanRoots（红线 1）
  ├─ 触发剪藏根增量扫描（复用 scan 单根 rescan，await）
  └─ webclip_records 回填 md/html 的 files.id → 既有管线自动接手：
       scanner → gate → ruleScore → llmWorker（wiki 蒸馏）→ embeddings/FTS
```

依赖管理：`playwright` 为 server 可选依赖（`npm i -D playwright && npx playwright install chromium`）；未安装/无浏览器时报「剪藏未就绪」错误，fail-loud，不影响服务其他功能。

## 第 5 章 · 业务流分析

剪藏一次 URL 的完整时序：

1. 用户提交 → SSRF 校验失败即 4xx 返回
2. Playwright 渲染（导航超时 30s；页面 >20MB 终止）
3. 正文提取转 MD；图片按限额（单图 ≤5MB、单页 ≤30 张）下载，超限/防盗链失败保留 alt 文本降级
4. 生成文档对：`<ts>-<slug>.md` + `<ts>-<slug>.html` + `assets/<ts>-<slug>/`
5. MD 写 frontmatter（见 6.1）；HTML 注释锚点（见 6.2）
6. 触发剪藏根增量扫描并 await；扫描器按既有规则把**两个文件都**入库（门禁/打分/蒸馏队列，html 走 extractHtml，md 走 extractMd）
7. 按 path 查 files 回填 `md_file_id` / `html_file_id`；若扫描未命中（边缘时序），GET records 时懒回填
8. 前端刷新历史，成功行可点击打开文件抽屉（走既有 `files.openFile`，不新增埋点 source）

重复提交：同 URL 默认拒绝并提示「已剪藏，可勾选强制重剪」；强制重剪生成新文档对（保留历史记录，旧文件不动）。

## 第 6 章 · 数据模型设计（MD/HTML 关联，本 PRD 核心）

### 6.1 磁盘层关联（权威，防 DB 丢关联）

同一次剪藏产出同名成对文件，共享 assets 目录：

```
<storageRoot>/
  20260924-153012-<slug>.md        ← 主产物（正文提取版）
  20260924-153012-<slug>.html      ← 快照（原始排版保真版），与 md 平等入库
  assets/20260924-153012-<slug>/img-x.png
```

MD frontmatter（归因走信任序第一位，见 extractor.ts inferAgent）：

```yaml
---
agent: webclip
source_url: https://example.com/post
clipped_at: 2026-09-24T15:30:12+08:00
snapshot: ./20260924-153012-<slug>.html   # 相对路径指快照
---
```

HTML 文件 `<head>` 注入锚点注释：`<!-- AgentFeed webclip: 20260924-153012-<slug> | source: <url> -->`。HTML 无 frontmatter 通道，其 agent 归因由扫描根绑定 `scan_roots.agent='webclip'` 覆盖（信任序第二位）。

### 6.2 数据库层关联

新表 `webclip_records`（迁移走 db.ts `ensureColumns` 幂等链，红线 3）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| url | TEXT NOT NULL | 目标 URL |
| title | TEXT | 页面标题 |
| slug_ts | TEXT | 文档对共享基名（20260924-153012-\<slug\>），关联磁盘锚 |
| md_path / html_path | TEXT | 两文件绝对路径（html_path 可空 = 未存快照） |
| md_file_id / html_file_id | INTEGER | 扫描入库后回填的 files.id（可空，懒回填） |
| status | TEXT | success / failed |
| snapshot | INTEGER | 0/1 是否含快照 |
| error | TEXT | 失败原因（分类短语 + 详情） |
| duration_ms | INTEGER | 耗时 |
| created_at | TEXT | |

不改动 `files` 表结构：MD/HTML 在 files 中就是普通行，由既有管线平等处理；关联关系收敛在 webclip_records，前端从记录行双向跳转（MD 行 ↔ 快照行）。

**双入库的既知后果（已确认接受）**：同一内容两次 LLM 蒸馏（token 成本 ×2）、FTS 双命中（md 与 html 各一条）、wiki 可能产出近似词条。缓解：混合检索 RRF 天然按相关度排序；若后续词条冲突明显，D 阶段再评估 wiki 去重（挂 `tagSystem` 同款 config 版本键推进），M1 不做。

### 6.3 API（统一 `{ success, ... }`，红线 4）

| 端点 | 入参 | 出参/行为 |
|---|---|---|
| GET /api/webclip/config | — | storageRoot、是否已注册扫描根、playwright 就绪态 |
| PUT /api/webclip/config | { storageRoot } | mkdir + 幂等注册 scan_roots；目录冲突 400 |
| POST /api/webclip/convert | { url, snapshot?=true, force?=false } | 同步执行全流程，返回 record（含两个 file_id） |
| GET /api/webclip/records | ?status=&page=&limit= | 历史分页列表 |
| POST /api/webclip/records/:id/retry | — | 对 failed 记录重跑（=force 重剪） |

## 第 7 章 · 操作流分析

- 配置流：Settings 填目录 → 保存 → 提示「已注册为扫描根，agent=webclip」→ 扫描根列表出现新行
- 剪藏流：粘贴 URL → 提交 → loading → 成功：历史行绿标 + 「md · html」两个打开入口；失败：红标 + 错误短语 + 重试按钮
- 查看流：历史行点标题 → files.openFile(md_file_id) 开既有抽屉；点「html」→ files.openFile(html_file_id) 走站内阅读器（html 清洗管线 + 沙箱，红线 2 双保险自动生效）

## 第 8 章 · 安全设计（新增攻击面，纳入红线清单）

1. **SSRF**：仅 http/https；拒绝 `user:pass@`；DNS 解析后逐 IP 拒环回/私有/链路本地段；重定向逐跳复检（含 DNS 复检）
2. **资源限额**：页面 ≤20MB、单图 ≤5MB、单页 ≤30 图、导航 30s、端点总超时 45s
3. **并发**：同步模型天然串行（同一时刻至多 1 个 Playwright 页面）；Playwright 进程空闲 60s 自动关闭
4. **落盘边界**：所有写盘目标 resolve 后必须过 `withinScanRoots`（红线 1 的写侧对偶）
5. **零脚本承诺继承**：html 快照入库后在站内阅读器渲染时走既有服务端白名单清洗 + 无 allow-scripts 沙箱；原始文件本身仅磁盘存储，不在收件坪外暴露

## 第 9 章 · 开发优先级与里程碑

- **M1 主闭环**：config（Settings UI + 注册扫描根）、webclip 表、fetcher（Playwright + SSRF）、convert（正文转 MD + 图片本地化 + HTML 引用改写）、双文件落盘、扫描触发与回填、4 个 API（config GET/PUT、convert、records）、收件坪 tab + 历史列表、`server/test/webclip.test.ts`
- **M2 韧性**：retry API（= force 重剪）与重试按钮、失败原因分类（ssrf/timeout/too-large/5xx/network）、图片降级（防盗链失败保 alt）、限额进入 config 可配
- **M3 可观测**：剪藏统计（成功率/耗时分布）进 Overview 或 Settings 概览；Playwright 就绪态巡检提示

## 第 10 章 · 风险与缓解

| 风险 | 缓解 |
|---|---|
| 双入库蒸馏成本 ×2 / 词条近似重复 | 已确认接受；M3 评估 wiki 去重版本键 |
| Playwright 依赖重（~200MB chromium） | 可选依赖 + fail-loud 就绪态提示，不装不影响主服务 |
| 目标站反爬/防盗链 | 图片失败降级保 alt；失败分类给用户明确预期 |
| SPA 页面动态内容抓不全 | Playwright 已覆盖 JS 渲染；`networkidle` + 3s 兜底滚动 |
| storageRoot 被用户指向系统目录 | 注册扫描根时复用挂载校验；嵌套/重复拒绝 |

## 第 11 章 · 测试计划

`server/test/webclip.test.ts`（node:test，改本模块必跑）：
- SSRF 纯函数：私网/环回/链路本地/带凭据/非 http 协议/重定向复检
- 命名与关联：slug 生成、文档对同名、frontmatter snapshot 相对路径、HTML 锚点注释
- convert fixture：静态 html → md 结构断言（标题/段落/图片相对化改写），图片超限降级
- config：目录注册幂等、嵌套/重复拒绝、未配置时 convert 400
- 重复 URL：默认拒绝 / force 生成新对
- Playwright 网络层不进单测（mock fetcher 边界）

## 变更日志

- 2026-09-24 v1.0：初稿定稿。MD+HTML 双文件全量入库（均蒸馏+向量化），磁盘同名对 + frontmatter/锚点注释 + webclip_records 双 file_id 三层关联。
