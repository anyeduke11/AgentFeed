/**
 * FTS 全量回填（一次性运维脚本，2026-09-21 裁决「先补齐再复测」）：
 * 对库执行 rebuildFts 全量重建（清空 wiki_fts 后从 wiki_entries_meta + entry.md 逐条回填），
 * 修复「FTS_BACKFILL_CAP=20000 跳过启动期回填 → FTS 覆盖率停留 ≈5.2%」的存量欠账。
 *
 * 与运行中服务的写共存：WAL + busy_timeout=5000 + synchronous=NORMAL（与 src/db.ts 同口径；
 * NORMAL 为 WAL 模式下安全档，批量 autocommit 场景避免逐条 fsync 拖慢回填），写写冲突时等待不抛错；
 * 逐行 autocommit 保证细粒度锁释放，不阻塞蒸馏工人的偶发写入。
 * 结束前做 entry_id 重复行自检（防与蒸馏增量同步并发交错产生重复索引行），重复则去重保最小 rowid。
 *
 * 用法：npx tsx server/scripts/ftsBackfill.ts [--db <sqlite 路径>]
 *   --db 缺省 = $AGENTFEED_DATA_DIR/app.db，未设环境变量时为 server/data/app.db（与 src/db.ts 口径一致）
 *
 * 运行后需 ./service.sh restart：长驻服务进程存在连接级读快照冻结缺陷（见 docs/search-baseline-2026-10.md），
 * 外部进程的写入在旧进程内不可见，重启后才对 MCP/检索生效。
 */

import { SqliteDatabase } from '@homeofthings/sqlite3'
import path from 'path'
import { DATA_DIR } from '../src/db.js'
import { ensureFtsTable, rebuildFts } from '../src/search/ftsIndex.js'

function resolveDbPath(): string {
  const i = process.argv.indexOf('--db')
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1])
  return path.join(DATA_DIR, 'app.db')
}

async function count(db: SqliteDatabase, sql: string): Promise<number> {
  return Number((await (await db.prepare(sql)).get() as any)?.n || 0)
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath()
  const db = await SqliteDatabase.open(dbPath)
  await db.exec('PRAGMA journal_mode = WAL')
  await db.exec('PRAGMA busy_timeout = 5000')
  await db.exec('PRAGMA synchronous = NORMAL')
  await ensureFtsTable(db)

  const before = await count(db, 'SELECT COUNT(*) AS n FROM wiki_fts')
  const total = await count(db, 'SELECT COUNT(*) AS n FROM wiki_entries_meta')
  console.log(`[ftsBackfill] 回填前：wiki_fts=${before} 行 / wiki_entries_meta=${total} 行`)

  const n = await rebuildFts(db, {
    onProgress: (done, t) => console.log(`[ftsBackfill] 进度 ${done}/${t}`)
  })

  // 自检：并发增量同步交错可能产生同 entry_id 重复行，去重保最小 rowid（无重复时为空操作）
  const dups = await count(db, 'SELECT COUNT(*) AS n FROM (SELECT entry_id FROM wiki_fts GROUP BY entry_id HAVING COUNT(*) > 1)')
  if (dups > 0) {
    await db.exec('DELETE FROM wiki_fts WHERE rowid NOT IN (SELECT MIN(rowid) FROM wiki_fts GROUP BY entry_id)')
    console.log(`[ftsBackfill] 发现 ${dups} 个重复 entry_id，已去重`)
  }
  const after = await count(db, 'SELECT COUNT(*) AS n FROM wiki_fts')
  console.log(`[ftsBackfill] 完成：重建 ${n} 条，wiki_fts=${after} 行（重复 entry_id=${dups}）`)
  try { await db.close() } catch { /* 进程退出由 OS 回收连接 */ }
}

main().catch(e => {
  console.error('[ftsBackfill] 失败：', String((e as any)?.message || e))
  process.exit(1)
})
