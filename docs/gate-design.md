# AgentFeed 入库过滤门禁与归档系统 — 设计方案

> 版本：1.0 · 日期：2026-09-14 · 状态：已实现并验证

## 1. 背景与目标

扫描根覆盖 `~/Documents` 等真实目录后，大量无价值文件混入看板：node_modules 的 README、占位小文件、纯代码清单。问题分三类：

1. 小体积配置/占位文件不该纳入
2. 简单文件不纳入（只收 PRD、测试记录、AGENT.md、CLAUDE.md、skill 等有价值内容）
3. 不需要跟踪阅读的文件（依赖目录、构建产物、日志）不纳入

设计目标：**入库前过滤、拦截可追溯、误杀可恢复、历史可归档**，且不影响大文件（大文件交给已有切片/分段解析）。

## 2. 总体架构

```
文件发现（walk / watcher）
   │
   ├─ Gate 1 路径门禁 ──命中──→ 彻底忽略（不入库、不记录）
   │
   ├─ 大小预检（>512KB 跳过内容分析，防 OOM）
   │
   ├─ Gate 2 大小门禁 ──命中──→ gate_records (skipped)
   │
   ├─ Gate 3 内容门禁 ──命中──→ gate_records (skipped)
   │
   └─ 通过 ──→ files 表入库（active / llm_state=pending）→ LLM 精炼队列
```

三层按成本递增排列，任何一层拦截即终止：

| 层 | 成本 | 判定依据 |
|---|---|---|
| Gate 1 路径 | 0 IO（目录剪枝） | 目录名/文件名黑名单 |
| Gate 2 大小 | 1 次 stat | 字节数下限 |
| Gate 3 内容 | 1 次读取（≤512KB） | 有效字符数、代码占比 |

## 3. 门禁规则详情

### 3.1 Gate 1 — 路径门禁（始终生效，不受开关控制）

| 类型 | 规则 | 拦截后行为 |
|---|---|---|
| 目录黑名单（可配置） | node_modules、dist、build、out、coverage、.git、__pycache__、.venv、venv、target、vendor、.next、.cache、.trae、.openclaw-autoclaw、.idea、.vscode、.output、.nuxt、server/public | **直接 DELETE 级联清理**，不进回收区、不记录 |
| 文件黑名单（内置） | CHANGELOG.md、LICENSE.md、LICENSE、NOTICE、*.log | 同上 |
| 应用自身数据目录 | `server/data/`（数据库、wiki 词条、门禁存档） | walk 剪枝 + 启动/扫描时清理历史污染行 |

**扫描根相对判定（v1.3）**：若路径位于某已注册扫描根之下，排除判断只作用于根之后的部分——因此 `.trae`、`.openclaw-autoclaw` 等本身在黑名单里的 agent 目录可以整体挂载为扫描根，根内内容正常入库（根内的 node_modules 等仍会被排除）。`isExcludedPath` / 存量清洗 `purgeExcludedFiles` / watcher `ignored` 三处逻辑保持一致。

回收区语义保持纯净：**只有"符合基本要求但用户手动删除"的文件才进回收区**。

### 3.2 Gate 2 — 大小门禁

- 仅保留**下限** `gate.minSize`（默认 512B），拦截占位符、单行说明。
- **无上限**：大文件不限入，扫描时只做流式 md5 + 头部 512KB 元数据提取，正文交给下游切片解析。

### 3.3 Gate 3 — 内容门禁

判定顺序：

1. **白名单直通**（命中即放行，跳过后续判断）：
   - 精确文件名（大小写不敏感）：AGENTS.md、AGENT.md、CLAUDE.md、SKILL.md、SKILLS.md
   - 文件名含关键词：prd、需求、测试、test record、复盘、设计、方案、总结、笔记
2. **有效字符数 < `gate.minChars`（默认 300）→ 拦截**。有效正文 = 去 frontmatter、去代码围栏、去 md 语法符号、去空白后的字符数。
3. **代码围栏占比 > `gate.codeRatio`（默认 0.6）→ 拦截**（围栏行数 / 总行数）。

`gate.enabled=false` 可整体关闭 Gate 2/3（Gate 1 不受影响）。

## 4. 数据模型

### 4.1 gate_records 表

```sql
CREATE TABLE IF NOT EXISTS gate_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  name TEXT, ext TEXT, title TEXT,
  size INTEGER, md5 TEXT,
  gate_reason TEXT,              -- 人类可读原因，如「正文过短（207 字符 < 300）」
  status TEXT DEFAULT 'skipped' CHECK(status IN ('skipped', 'restored')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

`files` 表完全不动——不扩 status 枚举、不加字段，回收区语义零污染。

### 4.2 config 表新增项

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| gate.enabled | boolean | true | 大小/内容门禁总开关（各规则另可单独开关） |
| gate.minSizeEnabled | boolean | true | 最小文件大小门禁单规则开关 |
| gate.minCharsEnabled | boolean | true | 最小正文字符门禁单规则开关 |
| gate.codeRatioEnabled | boolean | true | 代码占比门禁单规则开关 |
| gate.excludeDirsEnabled | boolean | true | 排除目录门禁单规则开关（内置文件黑名单 CHANGELOG/LICENSE/*.log 不受控） |
| gate.filenameWhitelistEnabled | boolean | true | 文件名白名单单规则开关 |
| gate.keywordsEnabled | boolean | true | 关键词白名单单规则开关 |
| gate.pathWhitelist | json | [] | 路径白名单（绝对路径前缀匹配；命中无视大小与内容门禁强制入库蒸馏，优先级高于排除目录与内置文件黑名单） |
| gate.pathWhitelistEnabled | boolean | true | 路径白名单开关 |
| gate.minSize | number | 512 | 最小文件字节数 |
| gate.minChars | number | 300 | 最小有效正文字符数 |
| gate.codeRatio | number | 0.6 | 代码围栏行占比上限 |
| gate.excludeDirs | json | 见 3.1 | 排除目录列表 |
| gate.filenameWhitelist | json | 见 3.3 | 文件名白名单 |
| gate.keywords | json | prd、需求、测试、test record、复盘、设计、方案、总结、笔记 | 文件名关键词白名单（包含即放行） |

## 5. 状态机与生命周期

```
磁盘新文件 ──Gate1命中──→ 无痕忽略
       │
       └─Gate2/3命中──→ gate_records(skipped) + 原 files 行级联删除
       │                    │
       │                    ├─ 用户恢复 → files(active, pending) + records(restored 豁免)
       │                    ├─ 用户删除记录 → 行删除（下次扫描会重新判定）
       │                    └─ 归档 → 按月 CSV + 行删除
       │
       └─通过──→ files(active, pending) → LLM 队列
                    │
                    ├─ 磁盘消失 → status=deleted（回收区，手动删除语义）
                    └─ 内容变化 → md5 更新，重新过门禁
```

关键规则：

- **restored 豁免**：恢复过的路径永久跳过门禁，避免每次扫描误杀。
- **合格后自动出列**：曾 skipped、现合格的文件，扫描时自动删除其过滤记录。
- **全量重扫清洗**：对已入库但不满足新规则的存量文件，扫描时级联删除或转入 skipped。

## 6. 归档子系统

### 6.1 归档规则

- 范围：全部 `status='skipped'` 记录，按 `substr(updated_at, 1, 7)` 分月。
- 落盘：`server/data/gate-archives/YYYY-MM.csv`，追加写入；文件首建时写 UTF-8 BOM + 表头。
- CSV 列：`path, name, ext, title, size, md5, gate_reason, created_at, updated_at`（标准转义，Excel 兼容）。
- 归档后：记录从 `gate_records` **删除**，不再出现在过滤记录列表。

### 6.2 触发时机（三条）

| 触发点 | 范围 | 说明 |
|---|---|---|
| 每次扫描开始 | 仅非当月记录 | 自动滚动归档，失败不阻塞扫描 |
| 服务启动时 | 仅非当月记录 | 兜底，失败不阻塞启动 |
| 前端「全部存档」按钮 | 全部记录 | 用户主动 |

### 6.3 查看

- `GET /api/gate/archives`：按月列表（月份/条数/大小/URL），倒序。
- `GET /api/gate/archives/:name`：内联返回 CSV（`text/csv; charset=utf-8`），文件名正则 `^\d{4}-\d{2}\.csv$` 白名单校验，防路径穿越。
- 前端「查看 CSV」按钮新标签页打开。

## 7. API 设计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/gate/records?status=skipped\|all&limit=200 | 分页列表，返回 `{total, items}`，limit 上限 1000 |
| POST | /api/gate/records/:id/restore | 恢复入库 + 豁免标记；文件不在磁盘时返回 409 |
| DELETE | /api/gate/records/:id | 删除单条记录 |
| POST | /api/gate/archive | 全部存档，返回 `{archived, files[]}` |
| GET | /api/gate/archives | 月度存档列表 |
| GET | /api/gate/archives/search?q=&month= | 检索已归档记录（关键字 + 可选月份，最多 100 条） |
| GET | /api/gate/archives/:name | 查看 CSV |
| GET | /api/scan/status | 扩展：新增 `gated`（当前 skipped 总数） |

## 8. 前端 UI（调度室 Settings.vue）

**过滤门禁区块**（AI 设置与队列之后）：

- 门禁开关（switch）、最小文件大小、最小正文字符、代码占比上限（number 输入）
- 排除目录、文件名白名单（逗号分隔文本，支持中英文逗号）
- 「保存门禁配置」按钮 + 提示语（对存量生效需全量重扫）

**过滤记录区块**：

- 标题显示总数；右上「全部存档」按钮（无记录时禁用）
- 每行：路径 + 拦截原因 + 「恢复」「删除记录」
- 空态引导文案
- 「历史存档」子列表：月份 + 条数 + 体积 + 「查看 CSV」（新标签页）

## 9. 性能与安全设计

| 问题 | 方案 |
|---|---|
| 大文件整读 OOM（实测 4GB 堆打满崩溃） | md5 流式计算（64KB 分块）；>512KB 跳过内容门禁；extractor 只读头部 512KB |
| frontmatter 被截断导致 gray-matter 抛异常 | try/catch 降级为纯文本 |
| 外键约束导致级联删除失败 | 统一 `deleteFileCascade`：file_tags → file_versions → llm_feedback → llm_call_logs → wiki_entries_meta → files |
| 存档下载路径穿越 | 文件名严格正则白名单 |
| 2 万条记录撑爆前端 | API 强制 limit（默认 200 / 上限 1000），UI 显示「总数 + 仅显示最近 N 条」 |
| watcher 与扫描规则不一致 | ignored 回调复用 `isExcludedPath` + 根相对隐藏目录判断 |
| 应用自吃自尾（data 目录被扫描） | SELF_DATA_DIR 剪枝 + 历史污染级联清理 |

## 10. 实现落点

| 文件 | 改动 |
|---|---|
| server/src/gate.ts | 新增：三层门禁、配置加载、级联清理、按月归档、存档列表 |
| server/src/db.ts | gate_records 表 + 6 个 gate.* 配置 seed |
| server/src/scanner.ts | 门禁接入、流式 md5、大小预检、self-dir 排除与清洗、扫描前自动归档；`ingestFile` 单文件入库逻辑复用 + `scanFile` 单文件增量入口 |
| server/src/extractor.ts | 头部 512KB 读取 + frontmatter 容错 |
| server/src/watcher.ts | add/change 事件走 `scanFile` 单文件增量入库（不做全目录遍历）；ignored 与门禁同步 |
| server/src/routes/gate.ts | 新增：records/restore/archive/archives 六个端点 |
| server/src/routes/scan.ts | status 返回 gated 计数 |
| server/src/index.ts | 挂载 /api/gate、启动时归档 |
| web/src/api.ts | api.gate 五个方法 |
| web/src/views/Settings.vue | 门禁配置 + 过滤记录 + 历史存档 UI |

## 11. 验证记录（2026-09-14）

```
全量重扫：49,273 文件 → 入库 ~29k / 拦截 20,040 / node_modules 残留 0
拦截分布：正文过短 ~11k · 文件过小 ~4k · 代码占比过高 ~5k
全部存档：20,062 条 → 2026-09.csv（4.8MB），records 归零后新拦截正常累积
污染清理：server/data 下 26 条误入库记录级联清除
构建：server tsc + web vue-tsc/vite 全部通过
```

## 12. 后续优化项实现记录（v1.1 · 2026-09-14）

初版的 4 个已知边界已全部落地：

1. **关键词配置化**：`gate.keywords` 入 config 表（json），调度室 UI 可编辑；checkGate 不再读硬编码常量。
2. **存档检索**：`GET /api/gate/archives/search` 服务端解析 CSV 过滤（RFC4180 单行解析 + 快速预筛），前端历史存档区新增关键字 + 月份搜索框。
3. **取消豁免**：records API 支持 `status=restored`；过滤记录区新增「拦截中 / 已豁免」切换，豁免记录可一键取消（删除记录，下次全量重扫重新评估）；恢复时不再清空 gate_reason，豁免列表保留当初拦截原因。
4. **watcher 单文件优化**：scanner 提取 `ingestFile` 共用逻辑 + `scanFile` 单文件入口；watcher add/change 只评估触发文件，不再全目录遍历（实测：新增文件 ~4s 内入库/拦截，与库内文件总量解耦）。
5. **单规则开关（v1.2）**：三个阈值门禁（minSize / minChars / codeRatio）各有独立开关（`gate.*Enabled`），checkGate 逐条跳过；UI 阈值行内嵌 switch（关闭时输入框置灰），切换即静默保存。实测：关闭 minSize 后 449B 文件放行入库、重新开启后文件变更即被重新拦截并移出 files。
6. **Agent 目录挂载（v1.3）**：`GET /api/scan/agents` 探测 18 个国内外常见智能体默认目录（ClaudeCode/OpenCode/OpenClaw/AutoClaw/Hermes/Trae/TraeWork/Qoder/Workbuddy/Codebuddy/Loomy/Zcode/MiniMaxCode/KimiCode/KimiWork/CodexCLI/Cursor/GeminiCLI，多候选路径按序取第一个存在的）；调度室扫描根区芯片式一键挂载/启停；根增删改后 watcher 热重载；新增根后台自动全量扫描。配套修复：路径排除改为扫描根相对判定（否则黑名单内的 agent 目录无法挂载）；软删范围限定在本次扫描根内（修复单根重扫误软删其他根文件的既有缺陷）；存量清洗补删 32 条历史漏网。
7. **全规则独立开关（v1.4）**：六个规则（minSize/minChars/codeRatio/excludeDirs/filenameWhitelist/keywords）各有独立开关，checkGate 与 isExcludedPath 逐条守卫；walk、watcher ignored 同步跟随。UI 所有阈值/文本行统一「输入框 + switch」内联布局（flex-wrap:nowrap 修复代码占比行按钮换行）。`PATCH /api/config` 涉及 gate.* 时自动热重载 watcher，规则变更即时生效。实测：关键词关闭后「测试」文件名小文件被 minSize 拦截、开启后变更即直通入库且旧拦截记录自动出列；排除目录关闭后 dist 内文件被 watcher 感知并入库；白名单关闭后 AGENTS.md 小文件被拦截、开启后直通。
8. **路径白名单（v1.5）**：`gate.pathWhitelist`（绝对路径前缀列表）+ 开关。优先级全门禁最高：checkGate 首位直通（无视 minSize/minChars/codeRatio）；isExcludedPath 首位放行（覆盖排除目录与 CHANGELOG/LICENSE/*.log 内置黑名单）；walk 目录剪枝时若白名单条目位于被剪目录之下则放行下钻。入库存库后走常规 pending 队列蒸馏。实测：60B 文件置于白名单路径下强制入库（active/pending、无拦截记录），移除白名单后恢复默认。单测 8 个新增用例（前缀边界、开关双向、Gate 1 覆盖、黑名单覆盖、剪枝放行、尾斜杠归一化）。

仍开放的方向：

- 归档检索为顺序扫描，月度数据量大（>50MB/文件）时可考虑 SQLite FTS。
- `scanFile` 的 roots 参数取自启动快照，扫描根变更后需重启或重扫以刷新 watcher。
