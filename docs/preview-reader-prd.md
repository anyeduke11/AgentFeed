# PRD：站内预览阅读器（R4）

> 版本：v1.0（2026-09-17）· 状态：立项（承接 reading-recommendation-prd.md 第 8 章 M5「R4 阅读器立项评估」结论）
> 范围：md / html 两类文件的站内只读渲染 + 自动阅读进度 + 滚动记忆
> 上游：阅读闭环 PRD v2.1 已交付 M1~M5；本 PRD 独立排期
> 修订（v1.1，2026-09-17）：移除 txt 兜底渲染——正常用户不会用 agent 产出 txt，采集端本就只收 md/html，站内放行收敛为 md/html 两类

---

## 第 1 章 · 背景与目标

**背景**：当前阅读动作全部在外部应用完成（md → Typora、html → Chrome），站内无法感知滚动与停留。R1 阅读进度因此只能做手动挡（25/50/75/100 快捷档），依赖用户自觉声明，失真风险高（原 PRD 第 9 章已列为高风险项）。站内渲染是拿到真实滚动位置、实现「自动进度 + 精确续读」的唯一正解。

**目标**：
1. 不跳出看板即可读完一篇：md / html 站内只读渲染，样式干净、无脚本执行
2. 进度自动化：滚动位置 → 百分比自动记录，再次进入精确回到上次位置，替代手动挡（手动挡保留为兜底）
3. 零安全面扩大：渲染内容不可执行脚本，资源加载收敛到白名单代理，路径校验复用现有根边界模式

**非目标（v1 明确不做）**：编辑与写回；txt / PDF / Office 渲染；全文检索；移动端适配；评论批注。

## 第 2 章 · 用户场景

- 长文一次读不完，希望下次打开直接落在上次位置，不从头找（R1 手动挡的自动化替代）
- 推荐池 / 每日精选点开即读，读完顺手打分（闭环不断流），而不是跳去 Typora 再切回来
- 阅读环境可信：agent 产出的 html 可能含任意脚本，站内打开必须零执行风险

## 第 3 章 · 功能模块设计

| 模块 | 优先级 | 说明 |
|---|---|---|
| 内容接口 `GET /files/:id/content` | P0 | 服务端读取原文并清洗，返回净化 html（含 md→html 转换）+ 元信息（title/mime/truncated） |
| 资源代理 `GET /files/:id/asset?rel=` | P0 | 相对路径图片/本地资源代理，后缀白名单 + 大小上限 + 路径归一化防穿越 |
| 阅读器路由 `/reader/:id` | P0 | 全屏独立路由（阅读是主任务，不用弹层/抽屉）；iframe sandbox 渲染 |
| 自动进度 | P0 | 滚动百分比节流上报，复用 `POST /reading/progress` 与 recommendations 现有列；进入时按 lastProgress 定位 |
| 打分联动 | P1 | 阅读器内嵌「读完打分」入口（复用 AppModal rate）；100% 时 toast 引导打分 |
| 入口铺设 | P1 | 详情抽屉「站内阅读」按钮、推荐池 B3 行、每日精选卡、执行队列「打开」改站内优先 |
| 手动挡保留 | P1 | Supply 快捷档保留（外部打开场景兜底）；进度以最后写入为准，两来源不冲突 |

依赖：progress 记忆仍**仅池内文件生效**（与 R1 同源同列，避免第二套存储）；非池内文件可读不可记。

## 第 4 章 · 系统架构设计

技术栈不变。新增依赖：server 端 `markdown-it`（纯 JS，md→html 统一管线）；前端零新依赖（渲染统一走 iframe，md 与 html 同一条代码路径）。

```
server/src/routes/files.ts     GET /content（清洗管线）/ GET /asset（资源代理）
server/src/reader.ts（新建）    sanitizeHtml（cheerio 清洗）+ renderMarkdown（markdown-it）
web/src/views/Reader.vue（新建） iframe sandbox + 滚动进度上报 + 打分联动
web/src/router/index.ts        新增 /reader/:id
```

**渲染管线（服务端，md/html 共用出口）**：
- md：markdown-it（`html: false`，天然挡内联 html 注入）→ 转 html 后进入同一清洗步骤
- html：cheerio 清洗，规则——移除 `script / iframe / object / embed / link[rel=import] / meta[http-equiv=refresh]`；移除全部 `on*` 事件属性与 `javascript:` href；保留结构与文本样式（`style` 标签内联保留，仅作用于 iframe 内部）
- 输出包裹基准样式（正文宽度 720px、行高 1.8、代码块/表格基础样式），`<base target="_blank">` 防导航劫持

**双保险沙箱**：iframe 属性 `sandbox="allow-same-origin"`（**不含 allow-scripts**）——即使清洗漏网，脚本也无法执行；srcdoc 注入。

**资源代理安全**：`rel` 参数 path.resolve 归一化后必须仍在该文件所属扫描根内（复用 opener.ts 根边界模式）；后缀白名单 `png/jpg/jpeg/gif/webp/svg/svgz`（svg 作为图片加载不执行脚本）；单资源 ≤ 5MB；命中失败返回 404 不暴露路径。

**外部 http(s) 图片**：v1 直接放行 `<img src=http...>`（浏览器加载，无脚本风险；http 页内脚本已被沙箱禁用）。

## 第 5 章 · 业务流分析

```
入口点击（池行/精选卡/抽屉）→ router /reader/:id
  → GET /files/:id/content（后端清洗，>2MB 截断并标 truncated）
  → iframe srcdoc 渲染 → 滚动至 lastProgress 对应位置（池内文件）
  → 滚动 → 百分比节流 3s 上报 POST /reading/progress（与手动挡同接口同列）
  → 滚到底部或 100% → toast「读完了？打个分」→ AppModal rate（两维 10 秒）
离开页面 → beforeunload flush 最终位置
```

**进度语义**：`pct = scrollTop / (scrollHeight - clientHeight)`，0 封顶、100 到底；上次进度 `scrollTo(0, pct × 可滚动高度)`。进度仍不参与推荐排序（与 R1 口径一致）。

**异常流**：
- 文件不在扫描根内 / 已删除 → 阅读器内联错误态，提供「外部打开」降级按钮（走现有 open 接口，埋点照常）
- 非 md/html 扩展 → 引导外部打开
- 上报失败 → 静默重试一次，不影响阅读

## 第 6 章 · 操作流分析

日常：入口点击即读（零决策）→ 滚动即记（零操作）→ 读完打分（10 秒）。外部打开入口全站保留（Typora 编辑场景不受影响）；「打开」按钮语义不变，阅读器是**新增**入口而非替换。

## 第 7 章 · 数据模型设计

**零新表、零新列**。进度复用 `recommendations.progress / last_progress_at` 与 `POST /reading/progress`；打开埋点复用 read_history（source='reader'，进阅读器即记一次，与外部打开并列区分）。资源代理与内容接口无状态。

## 第 8 章 · 开发优先级与里程碑

| Phase | 交付物 | 依赖 |
|---|---|---|
| R4-M1（P0） | 内容接口 + 清洗管线 + 资源代理 + /reader/:id 沙箱渲染 + md 渲染 | 无 |
| R4-M2（P1） | 自动进度上报与回位 + 打分联动 + 四处入口铺设 + 打开埋点 source='reader' | R4-M1 |
| R4-M3（P2，可选） | 目录侧栏（md 标题树）、字号/主题切换 | R4-M2 |

验收口径：md/html 打开成功率 ≥ 99%（库内抽样 20 篇）；续读位置误差 ≤ 1 屏；清洗后 iframe 内零脚本执行（安全自测用例：script 注入 / onerror / javascript: 链接 / 嵌套 iframe）。

## 第 9 章 · 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 清洗遗漏导致 XSS 面 | 低 | 高 | 双保险：服务端 cheerio 清洗 + iframe sandbox 无 allow-scripts；安全用例入测试 |
| 超大文件渲染卡顿 | 中 | 中 | >2MB 截断 + 提示「站内仅展示前 2MB，建议外部打开」 |
| 相对路径图片批量存在 | 高 | 低 | 资源代理一次实现全站受益；代理 404 时 img 显示占位不阻断 |
| 自动进度与手动挡互相覆盖 | 低 | 低 | 同列同接口，最后写入为准；toast 回溯文案不变 |
| 复杂 html 版式失真 | 中 | 低 | 只保底排版（阅读器定位是「读」不是「还原」），提供「外部打开」逃生门 |

---

## 变更日志

- v1.0（2026-09-17）：立项。承接 reading-recommendation-prd.md v2.1 M5 立项评估结论，范围收敛为「只读预览 md + html，禁脚本，进度自动记录，池内记忆」；零新表零新列，复用 R1 进度链路；双保险沙箱与资源代理为安全底线。
