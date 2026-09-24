# 会话管理 PRD（批次 A：归档/标记/搜索/删除留痕）

## 背景

Chat 会话目前只有 `chat_messages`（session_id, role, content, refs）一张表，会话本身是隐式的
session_id 字符串聚合，无元数据，导致：无法归档、无法标记领域/标签、无法搜索、删除无留痕。

## 基座：chat_sessions 元数据表（惰性建，同 chat_messages J1 模式）

```sql
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT,                          -- 默认首问截断 60 字符，可重命名
  domain TEXT,                         -- 会话领域标记（首问所用 domain 自动落，可改）
  tags TEXT,                           -- JSON string[]，手动标记
  archived INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
CREATE TABLE IF NOT EXISTS chat_delete_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, preview TEXT, msg_count INTEGER,
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

- DDL 放 routes/chat.ts `ensureChatTables()`（原 ensureChatTable 扩展）；零破坏性迁移
- `POST /api/chat` 落 user 消息时 `INSERT OR IGNORE` 元数据（title=首问截断，domain=本次 domain 参数），
  已有行不动（保留用户改过的 title/domain）

## 端点（统一 `{ success }` 信封）

| 端点 | 行为 |
| --- | --- |
| `GET /sessions` | 扩展：LEFT JOIN 元数据返回 title/domain/tags/archived；title 缺省回退首问预览。过滤参数：`archived=1` 归档视图；`q=` 搜索（LIKE 命中 title/首问预览/消息正文/tags/domain） |
| `PATCH /sessions/:id` | body `{ title?, domain?, tags?, archived? }` 任意子集；元数据行缺失则先补建。校验：title≤80、domain≤30、tags 去重字符串数组≤20 项且每项≤30 |
| `DELETE /sessions/:id` | 删该会话全部 chat_messages + chat_sessions 行；删前写 chat_delete_logs（preview=首问截断, msg_count）。llm_call_logs 保留（成本审计，不挂 session）。返回 `{ success, deletedMessages }` |
| `GET /deletions` | 近 50 条删除日志 |

只读红线更新：chat 路由允许写chat_messages / chat_sessions / chat_delete_logs / llm_call_logs
（同族会话留存表，J1 批次扩展），库内知识表照旧分毫不动。

## 前端（Chat.vue + api.ts）

- 侧栏顶部：搜索框（防抖 300ms，带 q 重拉列表）；「全部 / 已归档」切换
- 会话项：显示 title（回退首问）、domain/tags chips、消息数与时间；hover 操作：归档/恢复、删除（confirm）、重命名（行内 input）
- 会话打开时工具条尾部「标记」区：domain 复用现有 domainOptions 下拉 + tags 输入（datalist 候选来自现有 tags API），变更即 PATCH
- 删除日志：本期只落库 + 端点，不做 UI（YAGNI）

## 测试（server/test/chat.test.ts 追加）

1. POST 问答后 chat_sessions 自动落元数据（title=首问截断、domain 正确；二次提问不覆盖）
2. GET /sessions 返回元数据字段；archived 过滤生效
3. PATCH 各字段 + 越界校验
4. 搜索 q 分别命中 title / 消息正文 / tags
5. DELETE：消息与元数据清除、日志落库、GET /deletions 可查、会话从列表消失
6. 既有用例全绿（含只读红线指纹）

## 批次 B（已交付）：会话 → 知识复利

两种形态均经「预览确认后落盘」交互（Chat 会话项 hover「出」弹层，markdown 可编辑）：

- **纯导出**：`GET /sessions/:id/export/preview`（组装 markdown + 解析目标目录，不写盘）
  → `POST /sessions/:id/export`（落盘，不入库）
- **蒸馏入库**：预览勾选「AI 提炼」（`refined=1`，distillLlmFn 把会话沉淀为词条 markdown，
  失败回退对话体导出 fail-soft）→ 确认后 `POST /sessions/:id/distill`（落盘 +
  复用 wiki import 单文件挂载内核 `importMarkdownFile`：解析行内元数据 → 比对库内文件 →
  wiki_entries_meta + FTS 同步；同路径重复入库幂等 already）

关键设计：

- 导出目录：config 键 `chat.exportDir`（设置→检索页配置）。空 = 首个启用扫描根下 `conversations/`；
  任何入参/配置目录写盘前过 `withinScanRoots`（红线 1 fail-closed，越界 400）
- 蒸馏产物遵循 wiki import 的行内解析约定（`# 标题` + `**来源**/**标签** \`#tag\`` + 末行 最后更新），
  首段正文即词条摘要；入库后立即可被混合检索 / MCP search_knowledge 命中（FTS 同步写入）
- 只读红线口径更新：wiki_entries_meta 的唯一合法新增入口 = 蒸馏入库（source_type='imported'），
  files 表照旧分毫不动（测试钉死）
- 实现注记：wiki.ts 的 /import 单词条挂载体抽为 `mountExtEntry`（与 importMarkdownFile 共用，防漂移）；
  esbuild 词法层陷阱两枚已钉死——模板串内嵌裸反引号、块注释内容含 `*/` 序列（`**xx**/**yy**` 即中招）
