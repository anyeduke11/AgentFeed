import { getDb } from '../db.js'
import { vecToBlob } from './embeddings.js'

/**
 * L1 延迟治理：存量向量 JSON TEXT → Float32 BLOB 后台迁移。
 * WHY：向量以 JSON TEXT 存储（注释原话「本地数千词条规模足够」），54k chunks 规模下
 * 检索全量 JSON.parse 是搜索 28s 的主因。新写入已走 vecToBlob（双读兼容），
 * 本迁移把存量 TEXT 行分批转 BLOB——幂等（typeof='text' 过滤天然只选中未转行），
 * 每批 500 行避免长事务阻塞 WAL checkpoint 与在线写入。
 */
const BATCH = 500

async function migrateColumn(table: string, column: string, pk: string): Promise<number> {
  const db = await getDb()
  const select = await db.prepare(
    `SELECT ${pk} AS id, ${column} AS vec FROM ${table} WHERE ${column} IS NOT NULL AND typeof(${column}) = 'text' LIMIT ${BATCH}`
  )
  const update = await db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${pk} = ?`)
  let total = 0
  for (;;) {
    const rows = await select.all() as any[]
    if (!rows.length) break
    for (const r of rows) {
      try {
        const arr = JSON.parse(String(r.vec))
        if (!Array.isArray(arr) || !arr.length) continue
        await update.run([vecToBlob(arr), r.id])
        total++
      } catch { /* 单条损坏跳过：保留原值，双读路径会将其过滤 */ }
    }
    if (rows.length < BATCH) break
  }
  return total
}

/** 词条分块向量迁移（幂等，可重复调用）；file_embeddings 随方案 B 移除不再涉及 */
export async function migrateVectorsToBlob(): Promise<{ chunks: number; files: number }> {
  const chunks = await migrateColumn('entry_chunks', 'embedding', 'rowid')
  return { chunks, files: 0 }
}
