import { SqliteDatabase } from '@homeofthings/sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { ensureFtsTable } from './search/ftsIndex.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 测试/多实例隔离钩子：不设环境变量时行为与原来完全一致（生产路径不变）
// 导出供 reports.ts 等落盘模块复用同一数据目录口径（日报须与库同目录隔离，测试才不误伤真实 server/data）
export const DATA_DIR = process.env.AGENTFEED_DATA_DIR
  ? path.resolve(process.env.AGENTFEED_DATA_DIR)
  : path.join(__dirname, '../data')
const DB_PATH = path.join(DATA_DIR, 'app.db')

let db: SqliteDatabase | null = null

export async function getDb(): Promise<SqliteDatabase> {
  if (!db) {
    await fs.mkdir(DATA_DIR, { recursive: true })
    await fs.mkdir(path.join(DATA_DIR, 'wiki', 'entries'), { recursive: true })
    db = await SqliteDatabase.open(DB_PATH)
    await db.exec('PRAGMA journal_mode = WAL')
    await db.exec('PRAGMA foreign_keys = ON')
    // 蒸馏任务高频写库，写写冲突时等待而非立刻抛 SQLITE_BUSY
    await db.exec('PRAGMA busy_timeout = 5000')
    // WAL 上限：checkpoint 后按限截断回收空间，防止 WAL 文件无限膨胀
    await db.exec('PRAGMA journal_size_limit = 268435456')
    initTables(db)
    // Phase 2 检索基建（任务 2.1）：FTS5 关键词路虚表幂等创建（trigram 探测失败自动降级 unicode61，不阻塞启动）
    await ensureFtsTable(db)
    // 既有库列迁移（wiki_entries_meta：外部词条挂接 v2）
    await ensureColumns(db, 'wiki_entries_meta', [
      { name: 'source_type', ddl: "source_type TEXT DEFAULT 'llm'" },
      { name: 'title', ddl: 'title TEXT' },
      { name: 'summary', ddl: 'summary TEXT' },
      { name: 'tags', ddl: 'tags TEXT' },
      { name: 'confidence', ddl: 'confidence TEXT' }
    ])
    // 既有库列迁移（人读推荐：规则分缓存 + 别名；质量分复用 wiki_entries_meta.quality_score）
    await ensureColumns(db, 'files', [
      { name: 'rule_score', ddl: 'rule_score REAL' },
      { name: 'alias', ddl: 'alias TEXT' }
    ])
    // 既有库列迁移（agent 绑定：挂载时写入 agent 名，入库读绑定不再猜路径）
    await ensureColumns(db, 'scan_roots', [
      { name: 'agent', ddl: 'agent TEXT' }
    ])
    // 既有库列迁移（阅读进度 R1：手动挡进度 + 最近进度时间，仅池内文件生效）
    await ensureColumns(db, 'recommendations', [
      { name: 'progress', ddl: 'progress INTEGER DEFAULT 0' },
      { name: 'last_progress_at', ddl: 'last_progress_at DATETIME' }
    ])
    // 既有库列迁移（标签治理：生命周期 status + 合并指向 merged_into + 分级 level + 领域挂靠 domain_id + 二级父挂靠 parent_tag_id）
    await ensureColumns(db, 'tags', [
      { name: 'status', ddl: "status TEXT DEFAULT 'active'" },
      { name: 'merged_into', ddl: 'merged_into INTEGER' },
      { name: 'level', ddl: "level TEXT DEFAULT 'primary'" },
      { name: 'domain_id', ddl: 'domain_id INTEGER' },
      { name: 'parent_tag_id', ddl: 'parent_tag_id INTEGER' }
    ])
    // 既有库列迁移（D5 结构化门禁：命中规则 id + 指标值落库可观测；大文件抽样 flag 供口径拆分）
    await ensureColumns(db, 'gate_records', [
      { name: 'rule_id', ddl: 'rule_id TEXT' },
      { name: 'gate_metric', ddl: 'gate_metric TEXT' }
    ])
    // 既有库列迁移（MCP 埋点 v2：args 摘要落库，回答「agent 实际查了什么」）
    await ensureColumns(db, 'mcp_call_logs', [
      { name: 'args', ddl: 'args TEXT' }
    ])
    await ensureColumns(db, 'files', [
      { name: 'gate_sampled', ddl: 'gate_sampled INTEGER DEFAULT 0' }
    ])
    // exec_queue v2 迁移：间隔重复需要同文件多轮复习（多行），去掉 file_id UNIQUE（幂等：仅旧库触发）
    const qIdx = await (await db.prepare('PRAGMA index_list(exec_queue)')).all() as any[]
    if (qIdx.some(i => Number(i.unique) === 1 && i.origin === 'u')) {
      await db.exec(`
        CREATE TABLE exec_queue_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL,
          due_at DATETIME NOT NULL,
          interval_stage INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'dismissed')),
          done_at DATETIME
        );
        INSERT INTO exec_queue_v2 (id, file_id, due_at, interval_stage, status, done_at)
          SELECT id, file_id, due_at, interval_stage, status, done_at FROM exec_queue;
        DROP TABLE exec_queue;
        ALTER TABLE exec_queue_v2 RENAME TO exec_queue;
        CREATE INDEX IF NOT EXISTS idx_exec_queue_status ON exec_queue(status, due_at);
      `)
    }
    await seedDefaults(db)
    await migrateTagLevels(db)
  }
  return db
}

/** 强一致不变式：领域 ≡ 一级主要标签——确保领域拥有同名 active 一级标签（缺则建，同名普通/停用标签则升格绑定） */
export async function ensureDomainTag(db: SqliteDatabase, domainId: number, name: string) {
  const exist = await (await db.prepare('SELECT id, level, status FROM tags WHERE name = ?')).get([name]) as any
  if (!exist) {
    await db.exec(`INSERT INTO tags (name, level, status, domain_id) VALUES ('${String(name).replace(/'/g, "''")}', 'primary', 'active', ${Number(domainId)})`)
  } else if (exist.level !== 'primary' || exist.status !== 'active') {
    await db.exec(`UPDATE tags SET level = 'primary', status = 'active', domain_id = ${Number(domainId)}, parent_tag_id = NULL WHERE id = ${Number(exist.id)}`)
  }
}

/** 标签体系一次性迁移（v1）：level 三态化——一级=领域挂靠标签（同名自动锚定），其余碎片 primary 转 normal；config 版本键防重跑 */
export async function migrateTagLevels(db: SqliteDatabase) {
  const key = 'tagSystem.levelVersion'
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([key]) as any
  const ver = row ? (parseInt(row.value) || 0) : 0
  if (ver >= 3) return
  await db.transactionalize(async () => {
    // v1：与领域同名的 active 一级标签补挂靠（锚点）
    await db.exec(`UPDATE tags SET domain_id = (SELECT d.id FROM domains d WHERE d.name = tags.name)
      WHERE status = 'active' AND level = 'primary' AND domain_id IS NULL
        AND name IN (SELECT name FROM domains)`)
    // v1：未挂靠的 active primary 碎片统一转普通标签（不再冒充一级关键领域）
    await db.exec(`UPDATE tags SET level = 'normal' WHERE status = 'active' AND level = 'primary' AND domain_id IS NULL`)
    // v2（2026-09-19）：v1 只扫 active——merged/retired 残留的 primary 头衔一并清掉
    // （一级=领域语义下非 active 标签持 primary 是无效态；真实库 435 个 merged 孤儿即此缺口）
    await db.exec(`UPDATE tags SET level = 'normal' WHERE status != 'active' AND level = 'primary' AND domain_id IS NULL`)
    // v3（2026-09-20）：领域 ≡ 一级标签强一致——为缺同名 active 一级标签的领域补建/升格
    // （POST/PATCH 领域历史上不同步标签：真实库「前端开发」领域改名「应用开发」后一级标签留在旧名 retired）
    const drows = await (await db.prepare('SELECT id, name FROM domains')).all() as any[]
    for (const d of drows) await ensureDomainTag(db, Number(d.id), String(d.name))
    await db.exec(`INSERT INTO config (key, value, type, description)
      VALUES ('${key}', '3', 'number', '标签三态+领域挂靠迁移已执行（防重跑）')
      ON CONFLICT(key) DO UPDATE SET value = '3', updated_at = CURRENT_TIMESTAMP`)
  })
}

function initTables(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      agent TEXT,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scan_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      roots TEXT,
      full BOOLEAN DEFAULT 0,
      scanned INTEGER DEFAULT 0,
      added INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      gated INTEGER DEFAULT 0,
      duration_ms INTEGER,
      error TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES domains(id),
      color TEXT DEFAULT '#409eff',
      description TEXT,
      sort INTEGER DEFAULT 0,
      UNIQUE(name, parent_id)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      title TEXT,
      source_agent TEXT,
      file_mtime DATETIME,
      content_time DATETIME,
      size INTEGER,
      md5 TEXT,
      domain_id INTEGER REFERENCES domains(id),
      summary TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
      llm_state TEXT DEFAULT 'pending' CHECK(llm_state IN ('pending', 'running', 'done', 'failed', 'skipped')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#67c23a'
    );

    CREATE TABLE IF NOT EXISTS file_tags (
      file_id INTEGER REFERENCES files(id),
      tag_id INTEGER REFERENCES tags(id),
      source TEXT CHECK(source IN ('rule', 'manual', 'llm')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(file_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER REFERENCES files(id),
      related_file_id INTEGER REFERENCES files(id),
      relation_type TEXT CHECK(relation_type IN ('same_file', 'supersedes')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS llm_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER REFERENCES files(id),
      feedback TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS llm_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER REFERENCES files(id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      duration_ms INTEGER,
      status TEXT CHECK(status IN ('success', 'failed', 'timeout', 'rate_limited')),
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wiki_entries_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER UNIQUE REFERENCES files(id),
      entry_path TEXT NOT NULL,
      entities_count INTEGER DEFAULT 0,
      distilled_at DATETIME,
      quality_score REAL,
      source_type TEXT DEFAULT 'llm',
      title TEXT,
      summary TEXT,
      tags TEXT,
      confidence TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      client TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('string', 'number', 'boolean', 'json')),
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gate_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT,
      ext TEXT,
      title TEXT,
      size INTEGER,
      md5 TEXT,
      gate_reason TEXT,
      status TEXT DEFAULT 'skipped' CHECK(status IN ('skipped', 'restored')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS read_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'other',
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER UNIQUE NOT NULL,
      score REAL,
      reason TEXT,
      reason_source TEXT DEFAULT 'rule' CHECK(reason_source IN ('rule', 'llm', 'manual')),
      entry_source TEXT NOT NULL DEFAULT 'manual' CHECK(entry_source IN ('auto', 'llm', 'manual', 'curated')),
      status TEXT DEFAULT 'unread' CHECK(status IN ('unread', 'read', 'archived')),
      progress INTEGER DEFAULT 0,
      last_progress_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reading_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      stars INTEGER CHECK(stars BETWEEN 1 AND 5),
      exec_intent TEXT CHECK(exec_intent IN ('now', 'later', 'info')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS exec_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      due_at DATETIME NOT NULL,
      interval_stage INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'dismissed')),
      done_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS file_embeddings (
      file_id INTEGER PRIMARY KEY REFERENCES files(id),
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5);
    CREATE INDEX IF NOT EXISTS idx_read_hist_file ON read_history(file_id);
    CREATE INDEX IF NOT EXISTS idx_read_hist_time ON read_history(opened_at);
    CREATE INDEX IF NOT EXISTS idx_exec_queue_status ON exec_queue(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_files_llm_state ON files(llm_state);
    CREATE INDEX IF NOT EXISTS idx_files_domain ON files(domain_id);
    CREATE INDEX IF NOT EXISTS idx_files_agent ON files(source_agent);
    CREATE INDEX IF NOT EXISTS idx_file_tags_file ON file_tags(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_file ON llm_call_logs(file_id);
    CREATE INDEX IF NOT EXISTS idx_scan_jobs_time ON scan_jobs(started_at);

    CREATE TABLE IF NOT EXISTS tag_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('semantic', 'level')),
      canonical TEXT NOT NULL,
      members TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tag_proposals_status ON tag_proposals(status);

    CREATE TABLE IF NOT EXISTS tag_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op TEXT NOT NULL,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase 2 检索基建（任务 2.2）：entry.md 按 heading 分块的向量路；parent = wiki_entries_meta.id，
    -- 向量存法对齐 file_embeddings（JSON 文本），UNIQUE(entry_id, chunk_index) 支撑回填幂等
    CREATE TABLE IF NOT EXISTS entry_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading_path TEXT DEFAULT '',
      content TEXT NOT NULL,
      model TEXT,
      dim INTEGER,
      embedding TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_entry_chunks_entry ON entry_chunks(entry_id);
  `)
}

/** 既有库的列迁移：缺失则 ALTER ADD（幂等） */
async function ensureColumns(db: SqliteDatabase, table: string, columns: Array<{ name: string; ddl: string }>) {
  const rows = (await (await db.prepare(`PRAGMA table_info(${table})`)).all()) as any[]
  const has = (n: string) => rows.some(r => r.name === n)
  for (const c of columns) {
    if (!has(c.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.ddl}`)
  }
}

export async function seedDefaults(db: SqliteDatabase) {
  const domains = [
    { name: '人工智能', parent: null, color: '#409eff' },
    { name: '网络安全', parent: null, color: '#f56c6c' },
    { name: '前端开发', parent: null, color: '#67c23a' },
    { name: '后端开发', parent: null, color: '#e6a23c' },
    { name: '数据工程', parent: null, color: '#909399' },
    { name: '运维部署', parent: null, color: '#409eff' }
  ]

  // 墓碑：用户显式删除过的种子名不再重新播种（否则每次重启 seedDefaults 都会把删除的领域「复活」）
  let tombstones: string[] = []
  try {
    const tombRow = await (await db.prepare(`SELECT value FROM config WHERE key = 'domains.tombstones'`)).get() as any
    if (tombRow?.value) tombstones = JSON.parse(tombRow.value)
  } catch { /* config 未就绪或值损坏 → 视为无墓碑 */ }

  await db.transactionalize(async () => {
    for (const d of domains) {
      if (tombstones.includes(d.name)) continue
      const parentStmt = await db.prepare('SELECT id FROM domains WHERE name = ?')
      const parentRow = d.parent ? await parentStmt.get(d.parent) : null
      const parentId = parentRow?.id ?? null
      const existsStmt = await db.prepare('SELECT id FROM domains WHERE name = ? AND ((parent_id IS ?) OR (parent_id IS NULL AND ? IS NULL))')
      const exists = await existsStmt.get([d.name, parentId, parentId])
      if (!exists) {
        const escapedName = String(d.name).replace(/'/g, "''")
        const escapedColor = String(d.color).replace(/'/g, "''")
        await db.exec(`INSERT INTO domains (name, parent_id, color) VALUES ('${escapedName}', ${parentId === null ? 'NULL' : parentId}, '${escapedColor}')`)
      }
    }
  })

  const configs = [
    { key: 'ai.providers', value: JSON.stringify([{ name: 'sensenova', baseUrl: 'https://token.sensenova.cn/v1', apiKey: '' }]), type: 'json', description: 'LLM providers 列表' },
    { key: 'ai.defaultProvider', value: 'sensenova', type: 'string', description: '默认 LLM 服务商' },
    { key: 'ai.defaultModel', value: 'sensenova-6.8-flash-lite', type: 'string', description: '默认模型' },
    { key: 'ai.models', value: JSON.stringify(['sensenova-6.8-flash-lite', 'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.2', 'kimi-k3']), type: 'json', description: '可用模型列表' },
    { key: 'ai.autoTag', value: 'true', type: 'boolean', description: '入库自动蒸馏开关' },
    { key: 'scan.depth', value: '10', type: 'number', description: '扫描深度' },
    { key: 'lan.enabled', value: 'false', type: 'boolean', description: '局域网开放开关' },
    { key: 'lan.token', value: '', type: 'string', description: '局域网访问令牌' },
    { key: 'mcp.enabled', value: 'true', type: 'boolean', description: 'MCP 服务总闸：关闭后所有 MCP 工具调用拒绝响应' },
    { key: 'gate.enabled', value: 'true', type: 'boolean', description: '入库过滤门禁开关' },
    { key: 'gate.minSize', value: '512', type: 'number', description: '最小文件字节数（低于则拦截）' },
    { key: 'gate.minChars', value: '300', type: 'number', description: '最小有效正文字符数（低于则拦截）' },
    { key: 'gate.codeRatio', value: '0.6', type: 'number', description: '代码围栏行占比上限（超过则拦截）' },
    { key: 'gate.minSizeEnabled', value: 'true', type: 'boolean', description: '最小文件大小门禁开关' },
    { key: 'gate.minCharsEnabled', value: 'true', type: 'boolean', description: '最小正文字符门禁开关' },
    { key: 'gate.codeRatioEnabled', value: 'true', type: 'boolean', description: '代码占比门禁开关' },
    { key: 'gate.excludeDirsEnabled', value: 'true', type: 'boolean', description: '排除目录门禁开关' },
    { key: 'gate.filenameWhitelistEnabled', value: 'true', type: 'boolean', description: '文件名白名单开关' },
    { key: 'gate.keywordsEnabled', value: 'true', type: 'boolean', description: '关键词白名单开关' },
    { key: 'gate.pathWhitelistEnabled', value: 'true', type: 'boolean', description: '路径白名单开关' },
    { key: 'gate.pathWhitelist', value: '[]', type: 'json', description: '路径白名单（前缀匹配，命中无视大小与内容门禁强制入库）' },
    { key: 'gate.excludeDirs', value: JSON.stringify(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.next', '.cache', '.trae', '.openclaw-autoclaw', '.idea', '.vscode', '.output', '.nuxt', 'server/public']), type: 'json', description: '路径排除目录列表（命中即彻底忽略）' },
    { key: 'gate.filenameWhitelist', value: JSON.stringify(['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'SKILL.md', 'SKILLS.md']), type: 'json', description: '文件名白名单（命中即放行）' },
    { key: 'gate.keywords', value: JSON.stringify(['prd', '需求', '测试', 'test record', '复盘', '设计', '方案', '总结', '笔记']), type: 'json', description: '文件名关键词白名单（包含即放行）' },
    { key: 'gate.blacklistEnabled', value: 'true', type: 'boolean', description: '文件黑名单开关' },
    { key: 'gate.blacklist', value: '[]', type: 'json', description: '文件黑名单（*.tmp.md 通配 / .log 扩展名 / /正则/ / 纯文本，命中即拦截可恢复）' },
    { key: 'ai.ollama.enabledModels', value: '[]', type: 'json', description: 'Ollama 启用的模型列表' },
    { key: 'ai.ollama.modelTypes', value: '{}', type: 'json', description: 'Ollama 模型用途映射（chat/embedding）' },
    { key: 'ai.embedding', value: JSON.stringify({ enabled: false, provider: 'ollama', model: '' }), type: 'json', description: '蒸馏向量化配置' },
    { key: 'search.vectorEnabled', value: 'true', type: 'boolean', description: '检索向量路总开关（分块嵌入回填，provider 可用时才生效）' }
  ]

  await db.transactionalize(async () => {
    for (const c of configs) {
      const escapedKey = String(c.key).replace(/'/g, "''")
      const escapedValue = String(c.value).replace(/'/g, "''")
      const escapedType = String(c.type).replace(/'/g, "''")
      const escapedDesc = String(c.description).replace(/'/g, "''")
      await db.exec(`INSERT OR IGNORE INTO config (key, value, type, description) VALUES ('${escapedKey}', '${escapedValue}', '${escapedType}', '${escapedDesc}')`)
    }
  })
}

/** WAL 截断 checkpoint：best-effort。其他进程持锁时返回 busy=1 的行；异常向上抛，由调用方记录（fail loud） */
export async function checkpointWal(): Promise<{ busy: number; frames: number; checkpointed: number }> {
  const d = db ?? (await getDb())
  const row = await (await d.prepare('PRAGMA wal_checkpoint(TRUNCATE)')).get() as any
  return { busy: Number(row?.busy ?? 0), frames: Number(row?.log ?? 0), checkpointed: Number(row?.checkpointed ?? 0) }
}

export async function closeDb() {
  if (db) {
    await db.close()
    db = null as any
  }
}
