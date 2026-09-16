import { SqliteDatabase } from '@homeofthings/sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../data')
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
    initTables(db)
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
    // 既有库列迁移（标签治理：生命周期 status + 合并指向 merged_into + 分级 level）
    await ensureColumns(db, 'tags', [
      { name: 'status', ddl: "status TEXT DEFAULT 'active'" },
      { name: 'merged_into', ddl: 'merged_into INTEGER' },
      { name: 'level', ddl: "level TEXT DEFAULT 'primary'" }
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
  }
  return db
}

function initTables(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    CREATE INDEX IF NOT EXISTS idx_read_hist_file ON read_history(file_id);
    CREATE INDEX IF NOT EXISTS idx_read_hist_time ON read_history(opened_at);
    CREATE INDEX IF NOT EXISTS idx_exec_queue_status ON exec_queue(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_files_llm_state ON files(llm_state);
    CREATE INDEX IF NOT EXISTS idx_files_domain ON files(domain_id);
    CREATE INDEX IF NOT EXISTS idx_files_agent ON files(source_agent);
    CREATE INDEX IF NOT EXISTS idx_file_tags_file ON file_tags(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_file ON llm_call_logs(file_id);

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

async function seedDefaults(db: SqliteDatabase) {
  const domains = [
    { name: '人工智能', parent: null, color: '#409eff' },
    { name: '网络安全', parent: null, color: '#f56c6c' },
    { name: '前端开发', parent: null, color: '#67c23a' },
    { name: '后端开发', parent: null, color: '#e6a23c' },
    { name: '数据工程', parent: null, color: '#909399' },
    { name: '运维部署', parent: null, color: '#409eff' }
  ]

  await db.transactionalize(async () => {
    for (const d of domains) {
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
    { key: 'ai.embedding', value: JSON.stringify({ enabled: false, provider: 'ollama', model: '' }), type: 'json', description: '蒸馏向量化配置' }
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

export async function closeDb() {
  if (db) {
    await db.close()
    db = null as any
  }
}
