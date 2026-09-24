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
    // 既有库列迁移（Phase 2 任务 2.2：entry_chunks content_hash——旧库补列，hash 相同不重嵌）
    await ensureColumns(db, 'entry_chunks', [
      { name: 'content_hash', ddl: 'content_hash TEXT' }
    ])
    // 既有库列迁移（P1 向量覆盖状态化：文件级向量化终态——NULL 未尝试/'done'/'failed'；
    // 重试耗尽不再静默，收敛由 embed sweeper 周期补齐；embedding_disabled 为配置级缺失不落文件态）
    await ensureColumns(db, 'files', [
      { name: 'embed_state', ddl: 'embed_state TEXT' }
    ])
    // 「有向量行 = done」存量对账随 file_embeddings DROP（方案 B）移除；embed_state 列保留兼容存量库
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
    // J1 用户画像（v0.1.5 第 7 批）：单一事实源，人读维护页与机读双出口（get_user_context 工具 + AGENTS.md 托管区块）
    // 共用——content 为断言列表 JSON（schema 见 profile/model.ts），版本链靠 active 标记（新版 1 旧版 0），可 diff 可回滚
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'domain')),
        domain_id INTEGER REFERENCES domains(id),
        content TEXT NOT NULL,
        evidence JSON,
        confidence REAL,
        generated_at DATETIME,
        active INTEGER DEFAULT 1,
        UNIQUE(scope, domain_id, generated_at)
      );
      CREATE INDEX IF NOT EXISTS idx_user_profile_active ON user_profile(active, scope, domain_id);
    `)
    // I2 用户理解信号预留：评分（1-5 星）与一句话反馈落 read_history（J1 聚合统计包的 avgRating 来源）
    await ensureColumns(db, 'read_history', [
      { name: 'rating', ddl: 'rating INTEGER CHECK(rating BETWEEN 1 AND 5)' },
      { name: 'feedback', ddl: 'feedback TEXT' }
    ])
    // 批次②：Web 检索埋点（source='search' 时 query 记搜索词）——E1 漏斗诊断的人侧半边数据源。
    // 埋点 source 集合相应扩展：preview / pool / exec / daily / reader / search
    await ensureColumns(db, 'read_history', [
      { name: 'query', ddl: 'query TEXT' }
    ])
    // 版本链激活：同 path 内容变更（md5 迭代）时记录旧 md5——file_versions 曾是无写入方的休眠表
    await ensureColumns(db, 'file_versions', [
      { name: 'old_md5', ddl: 'old_md5 TEXT' }
    ])
    // 配套修复③（2026-09-22 残留 12%）：落网关 finish_reason 原文，失败分桶区分截断/拒答形态
    await ensureColumns(db, 'llm_call_logs', [
      { name: 'stop_reason', ddl: 'stop_reason TEXT' }
    ])
    // 既有库列迁移（webclip M2：失败分类 code——ssrf/config/dup/fetch/notready/toolarge/busy 落库可观测）
    await ensureColumns(db, 'webclip_records', [
      { name: 'code', ddl: 'code TEXT' }
    ])
    await seedDefaults(db)
    await migrateTagLevels(db)
    await reconcileDomainTagSync(db)
  }
  return db
}

/** 归一化 key：全角转半角 + 小写 + 去所有空白（「4C 能力模型」≡「4C能力模型」）——领域/标签查重与对齐统一口径 */
export function normalizeKey(name: string): string {
  return String(name).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

/** 强一致不变式：领域 ≡ 一级主要标签——确保领域拥有同名 active 一级标签（缺则建，同名普通/停用标签则升格绑定） */
export async function ensureDomainTag(db: SqliteDatabase, domainId: number, name: string) {
  // 语句用毕即 finalize：未 finalize 的读取语句会让同连接后续 DDL（如 DROP/CREATE INDEX）报 SQLITE_LOCKED
  const stmt = await db.prepare('SELECT id, level, status FROM tags WHERE name = ?')
  const exist = await stmt.get([name]) as any
  stmt.finalize()
  if (!exist) {
    await db.exec(`INSERT INTO tags (name, level, status, domain_id) VALUES ('${String(name).replace(/'/g, "''")}', 'primary', 'active', ${Number(domainId)})`)
  } else if (exist.level !== 'primary' || exist.status !== 'active') {
    await db.exec(`UPDATE tags SET level = 'primary', status = 'active', domain_id = ${Number(domainId)}, parent_tag_id = NULL WHERE id = ${Number(exist.id)}`)
  }
}

/** 标签体系一次性迁移（v1~v4）：level 三态化——一级=领域挂靠标签（同名自动锚定），其余碎片 primary 转 normal；config 版本键防重跑 */
export async function migrateTagLevels(db: SqliteDatabase) {
  const key = 'tagSystem.levelVersion'
  const cfgStmt = await db.prepare('SELECT value FROM config WHERE key = ?')
  const row = await cfgStmt.get([key]) as any
  cfgStmt.finalize()
  const ver = row ? (parseInt(row.value) || 0) : 0
  if (ver >= 4) return
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
    const domStmt = await db.prepare('SELECT id, name FROM domains')
    const drows = await domStmt.all() as any[]
    domStmt.finalize()
    for (const d of drows) await ensureDomainTag(db, Number(d.id), String(d.name))
    // v4（2026-09-21）：重复领域去重——UNIQUE(name, parent_id) 对 NULL 父级失效（SQLite NULL 互不相等），
    // 真实库「缺省域」×2、「预算域」×3 即此缺口。按名分组：保留挂文件最多者，files/tags 引用先重指向再删除其余，
    // 避免悬挂 domain_id；然后建部分唯一索引堵住 NULL 父级重复的再生入口（应用层查重之外的 DB 底线）
    await db.exec(`
      WITH grp AS (
        SELECT g.name AS name,
          (SELECT d.id FROM domains d WHERE d.name = g.name
            ORDER BY (SELECT COUNT(*) FROM files f WHERE f.domain_id = d.id) DESC, d.id ASC LIMIT 1) AS keeper
        FROM (SELECT DISTINCT name FROM domains) g
      )
      UPDATE files SET domain_id = (SELECT keeper FROM grp WHERE grp.name = (SELECT name FROM domains WHERE id = files.domain_id))
      WHERE domain_id IN (SELECT d.id FROM domains d JOIN grp ON grp.name = d.name WHERE d.id <> grp.keeper)`)
    await db.exec(`
      WITH grp AS (
        SELECT g.name AS name,
          (SELECT d.id FROM domains d WHERE d.name = g.name
            ORDER BY (SELECT COUNT(*) FROM files f WHERE f.domain_id = d.id) DESC, d.id ASC LIMIT 1) AS keeper
        FROM (SELECT DISTINCT name FROM domains) g
      )
      UPDATE tags SET domain_id = (SELECT keeper FROM grp WHERE grp.name = (SELECT name FROM domains WHERE id = tags.domain_id))
      WHERE domain_id IN (SELECT d.id FROM domains d JOIN grp ON grp.name = d.name WHERE d.id <> grp.keeper)`)
    await db.exec(`
      WITH grp AS (
        SELECT g.name AS name,
          (SELECT d.id FROM domains d WHERE d.name = g.name
            ORDER BY (SELECT COUNT(*) FROM files f WHERE f.domain_id = d.id) DESC, d.id ASC LIMIT 1) AS keeper
        FROM (SELECT DISTINCT name FROM domains) g
      )
      DELETE FROM domains WHERE id IN (SELECT d.id FROM domains d JOIN grp ON grp.name = d.name WHERE d.id <> grp.keeper)`)
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_domains_name_root ON domains(name) WHERE parent_id IS NULL`)
    await db.exec(`INSERT INTO config (key, value, type, description)
      VALUES ('${key}', '4', 'number', '标签三态+领域挂靠+领域去重迁移已执行（防重跑）')
      ON CONFLICT(key) DO UPDATE SET value = '4', updated_at = CURRENT_TIMESTAMP`)
  })
}

/** 领域↔标签对账（每次启动执行，非一次性迁移）：日常漂移自愈。
 * 迁移版本键防重跑，但「标签改名不同步领域名」「领域改名同步静默失败」等漂移在运行期持续产生，
 * 只靠一次性迁移清不干净——对账必须常态化：幽灵一级降级、死头衔清理、领域缺标签补齐。 */
export async function reconcileDomainTagSync(db: SqliteDatabase) {
  await db.transactionalize(async () => {
    // active 一级但未挂靠（或挂靠指向已删领域）→ 降普通（一级必须绑定领域的约束）
    await db.exec(`UPDATE tags SET level = 'normal'
      WHERE status = 'active' AND level = 'primary'
        AND (domain_id IS NULL OR domain_id NOT IN (SELECT id FROM domains))`)
    // 非 active 残留 primary 头衔清理（v2 逻辑日常化）
    await db.exec(`UPDATE tags SET level = 'normal' WHERE status != 'active' AND level = 'primary'`)
    // 每个领域必须拥有同名 active 一级标签（v3 逻辑日常化）
    const domStmt = await db.prepare('SELECT id, name FROM domains')
    const drows = await domStmt.all() as any[]
    domStmt.finalize()
    for (const d of drows) await ensureDomainTag(db, Number(d.id), String(d.name))
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

    -- file_embeddings 表随方案 B（2026-09-24 向量冗余收敛）移除：file 级向量链路整体下线，
    -- 检索主路唯一为词条分块向量（entry_chunks + P2 内存索引）。存量库由运维脚本 DROP + VACUUM。

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
    -- L1 延迟治理：时间窗口查询（logs 页/趋势/funnel）原为 129k 行全表 SCAN，EXPLAIN 实锤
    CREATE INDEX IF NOT EXISTS idx_llm_logs_time ON llm_call_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_gate_records_status ON gate_records(status);
    CREATE INDEX IF NOT EXISTS idx_mcp_logs_time ON mcp_call_logs(created_at);
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
    -- 向量存法对齐 file_embeddings（JSON 文本），UNIQUE(entry_id, chunk_index) 支撑回填幂等；
    -- content_hash = sha256(嵌入文本)，hash 相同跳过重嵌（chunkEmbed.ts chunkHash）
    CREATE TABLE IF NOT EXISTS entry_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading_path TEXT DEFAULT '',
      content TEXT NOT NULL,
      model TEXT,
      dim INTEGER,
      embedding TEXT,
      content_hash TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_entry_chunks_entry ON entry_chunks(entry_id);

    -- webclip（M1）：网页剪藏记录——md/html 文档对落盘路径与 files 表经 md_file_id/html_file_id 关联
    CREATE TABLE IF NOT EXISTS webclip_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      slug_ts TEXT,
      md_path TEXT,
      html_path TEXT,
      md_file_id INTEGER,
      html_file_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      snapshot INTEGER DEFAULT 0,
      error TEXT,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

/** 既有库的列迁移：缺失则 ALTER ADD（幂等）。导出供 chat_messages 等惰性建表的路由复用同一迁移模式 */
export async function ensureColumns(db: SqliteDatabase, table: string, columns: Array<{ name: string; ddl: string }>) {
  const rows = (await (await db.prepare(`PRAGMA table_info(${table})`)).all()) as any[]
  const has = (n: string) => rows.some(r => r.name === n)
  for (const c of columns) {
    if (!has(c.name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.ddl}`)
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
    { key: 'ai.embedding', value: JSON.stringify({ enabled: true, provider: 'ollama', model: 'qwen3-embedding:4b' }), type: 'json', description: '蒸馏向量化配置（默认本地 Ollama 开启：蒸馏成功即自动向量化，模型由 service.sh 随服务拉起）' },
    { key: 'search.vectorEnabled', value: 'true', type: 'boolean', description: '检索向量路总开关（分块嵌入回填，provider 可用时才生效）' },
    { key: 'search.hybridEnabled', value: 'true', type: 'boolean', description: '混合检索总开关（false 时完全回退旧单路 LIKE，等价逃生舱）' },
    { key: 'search.rerankEndpoint', value: '', type: 'string', description: '外部 rerank 端点（OpenAI 兼容 /rerank；空=关。3s 超时失败自动降级 RRF 序）' },
    { key: 'search.aliases', value: '{}', type: 'json', description: '查询别名表（查询时改写，如 {"gh":"tag:github"}）；支持 title:/tag:/短语/-排除 迷你语法' },
    { key: 'ai.pricing', value: '{}', type: 'json', description: 'LLM 单价表（元/百万 token），key=provider/model，如 {"ollama/qwen3":{"input":0,"output":0}}' },
    { key: 'llm.dailyBudgetCost', value: '', type: 'number', description: 'LLM 日预算（元/日）：当日成功调用成本超限则暂停蒸馏队列，次日自动恢复；空/0=无闸' },
    { key: 'ai.modelContextTokens', value: '', type: 'number', description: '蒸馏模型上下文窗口（tokens）：超预算 60% 的长文件触发结构化压缩；空=默认 32768（保守口径）' },
    { key: 'webclip.storageRoot', value: '', type: 'string', description: '网页剪藏存储目录（保存时自动注册为扫描根，agent=webclip）' },
    { key: 'webclip.limits', value: '{"pageMaxMB":20,"imgMaxMB":5,"imgMaxCount":30,"navTimeoutMs":30000,"deadlineMs":45000}', type: 'json', description: '网页剪藏限额（页面MB/单图MB/单页图数/导航ms/总时限ms）' },
    { key: 'chat.exportDir', value: '', type: 'string', description: '会话导出/蒸馏入库目录（须在已启用扫描根内；空=首个启用扫描根下 conversations/）' }
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
