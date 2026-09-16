import { getDb } from '../db.js'
import { callLlm } from './index.js'
import { getDefaultProvider, getDefaultModel } from './llmClient.js'

// ---- 标签治理引擎：规则归一（自动）+ AI 语义归组（待审）+ AI 次要标签判定（待审） ----

/** 归一化 key：全角转半角 + 小写 + 去所有空白（「4C 能力模型」≡「4C能力模型」） */
export function normalizeKey(name: string): string {
  return String(name).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

/** 打标入口统一防重：已合并的标签自动跟随指向（链式最多 5 跳防环），不存在则创建 */
export async function ensureTag(db: any, rawName: string): Promise<number | null> {
  const name = String(rawName || '').trim()
  if (!name) return null
  const stmt = await db.prepare('SELECT id, status, merged_into FROM tags WHERE name = ?')
  let row = await stmt.get(name) as any
  if (!row) {
    await db.exec(`INSERT OR IGNORE INTO tags (name) VALUES ('${name.replace(/'/g, "''")}')`)
    row = await stmt.get(name) as any
  }
  if (!row) return null
  for (let i = 0; i < 5 && row.status === 'merged' && row.merged_into; i++) {
    row = await (await db.prepare('SELECT id, status, merged_into FROM tags WHERE id = ?')).get(row.merged_into) as any
    if (!row) return null
  }
  return row.id
}

/** 把 memberIds 的挂载关系全部转移给 canonical，并将成员标记为 merged（事务 + 审计） */
export async function mergeTagsInto(db: any, canonicalId: number, memberIds: number[], op: string): Promise<number> {
  const members = memberIds.filter(id => Number(id) !== Number(canonicalId))
  if (!members.length) return 0
  let moved = 0
  await db.transactionalize(async () => {
    for (const mid of members) {
      const cntRow = await (await db.prepare('SELECT COUNT(*) AS n FROM file_tags WHERE tag_id = ?')).get(mid) as any
      moved += Number(cntRow?.n || 0)
      await db.exec(`INSERT OR IGNORE INTO file_tags (file_id, tag_id, source)
        SELECT file_id, ${Number(canonicalId)}, source FROM file_tags WHERE tag_id = ${Number(mid)}`)
      await db.exec(`DELETE FROM file_tags WHERE tag_id = ${Number(mid)}`)
      await db.exec(`UPDATE tags SET status = 'merged', merged_into = ${Number(canonicalId)} WHERE id = ${Number(mid)}`)
    }
    const detail = JSON.stringify({ canonicalId, members }).replace(/'/g, "''")
    await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('${op}', '${detail}')`)
  })
  return moved
}

// ---- 扫描任务状态（内存态；server 单进程，重启即清零，proposals 落库不受影响） ----

export const scanState = {
  running: '' as '' | 'semantic' | 'level',
  total: 0,
  done: 0,
  message: '',
  lastError: '',
  finishedAt: '',
  lastResult: null as any
}

function parseLlmJson(text: string): any | null {
  try {
    const cleaned = String(text).replace(/```json|```/g, '').trim()
    const start = cleaned.indexOf('{')
    if (start < 0) return null
    return JSON.parse(cleaned.slice(start))
  } catch {
    return null
  }
}

/** 规则归一：归一 key 相同的 active 标签直接合并（确定性代码，秒级） */
export async function runNormalizeScan(): Promise<{ groups: number; mergedTags: number }> {
  const db = await getDb()
  const rows = await (await db.prepare(`
    SELECT t.id, t.name, COUNT(ft.file_id) AS fc
    FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
    WHERE t.status = 'active'
    GROUP BY t.id
  `)).all() as any[]
  const groups = new Map<string, any[]>()
  for (const r of rows) {
    const key = normalizeKey(r.name)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  let groupCount = 0
  let mergedTags = 0
  for (const members of groups.values()) {
    if (members.length < 2) continue
    // 代表标签：挂载文件最多优先，其次名字更短，最后按 id 稳定排序
    const sorted = [...members].sort((a, b) => b.fc - a.fc || a.name.length - b.name.length || a.id - b.id)
    const canonical = sorted[0]
    const rest = sorted.slice(1).map(m => m.id)
    await mergeTagsInto(db, canonical.id, rest, 'auto_normalize_merge')
    groupCount++
    mergedTags += rest.length
  }
  await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('scan_normalize', '{"groups":${groupCount},"mergedTags":${mergedTags}}')`)
  return { groups: groupCount, mergedTags }
}

async function loadActiveTags(maxFc?: number): Promise<Array<{ id: number; name: string; fc: number }>> {
  const db = await getDb()
  const cond = maxFc === undefined ? '' : `HAVING fc <= ${Number(maxFc)}`
  const rows = await (await db.prepare(`
    SELECT t.id, t.name, COUNT(ft.file_id) AS fc
    FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
    WHERE t.status = 'active' AND t.level = 'primary'
    GROUP BY t.id ${cond}
    ORDER BY fc DESC, t.name
  `)).all() as any[]
  return rows.map(r => ({ id: Number(r.id), name: String(r.name), fc: Number(r.fc) }))
}

/** 查重：同 kind + canonical + members（排序规范化）的 pending proposal 已存在则跳过 */
async function proposalExists(db: any, kind: string, canonical: string, members: string[]): Promise<boolean> {
  const key = JSON.stringify([...members].sort())
  const row = await (await db.prepare(
    "SELECT id FROM tag_proposals WHERE status = 'pending' AND kind = ? AND canonical = ? AND members = ?"
  )).get(kind, canonical, key) as any
  return !!row
}

async function callLlmJson(prompt: string): Promise<any | null> {
  const provider = await getDefaultProvider()
  const model = await getDefaultModel()
  const { text } = await callLlm(provider, model, prompt)
  return parseLlmJson(text)
}

/** AI 语义归组（后台）：分批送 LLM 找同义/变体组，产出待审 proposals */
async function semanticScanJob(batchSize: number) {
  const db = await getDb()
  try {
    const tags = await loadActiveTags()
    const batches: Array<typeof tags> = []
    for (let i = 0; i < tags.length; i += batchSize) batches.push(tags.slice(i, i + batchSize))
    scanState.total = batches.length
    scanState.done = 0
    scanState.message = `语义归组：${tags.length} 个标签分 ${batches.length} 批`
    let proposals = 0
    let failedBatches = 0
    for (const batch of batches) {
      const nameSet = new Set(batch.map(t => t.name))
      const prompt = `你是内容管理系统的标签治理助手。下面是一批标签（JSON 数组，n 为名字，c 为使用次数）。
找出其中语义相同或高度相近的重复标签组：中英文空格差异、单复数、别名、同义翻译、简写全称等变体应合并；仅仅主题相关或互相包含的不要合并。
每组规范名 canonical 必须从该组成员中选出（优先使用次数最高、表达最通用的写法），members 为全部组成员名字。
输出 json：{"groups":[{"canonical":"规范名","members":["成员1","成员2"],"reason":"简短理由"}]}
没有可合并的组时输出 {"groups":[]}

标签列表：
${JSON.stringify(batch.map(t => ({ n: t.name, c: t.fc })))}`
      try {
        const data = await callLlmJson(prompt)
        const groups: any[] = Array.isArray(data?.groups) ? data.groups : []
        for (const g of groups) {
          const members: string[] = (Array.isArray(g?.members) ? g.members : []).map(String).filter((m: string) => nameSet.has(m))
          const canonical = String(g?.canonical || '')
          if (members.length < 2 || !nameSet.has(canonical) || !members.includes(canonical)) continue
          const key = JSON.stringify([...members].sort())
          if (await proposalExists(db, 'semantic', canonical, members)) continue
          await db.exec(`INSERT INTO tag_proposals (kind, canonical, members, reason)
            VALUES ('semantic', '${canonical.replace(/'/g, "''")}', '${key.replace(/'/g, "''")}', '${String(g?.reason || '').replace(/'/g, "''")}')`)
          proposals++
        }
      } catch (e: any) {
        failedBatches++
        scanState.lastError = String(e?.message || e)
      }
      scanState.done++
      await new Promise(r => setTimeout(r, 1000)) // 批间节流，降低限流概率
    }
    scanState.lastResult = { proposals, failedBatches }
    scanState.message = `语义归组完成：新增 ${proposals} 条合并建议${failedBatches ? `（${failedBatches} 批失败）` : ''}`
    await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('scan_semantic', '{"proposals":${proposals},"failedBatches":${failedBatches}}')`)
  } catch (e: any) {
    scanState.lastError = String(e?.message || e)
    scanState.message = '语义归组失败'
  } finally {
    scanState.running = ''
    scanState.finishedAt = new Date().toISOString()
  }
}

/** AI 次要标签判定（后台）：低频标签分批送 LLM 判定是否应降为次要标签 */
async function levelScanJob(maxCount: number, batchSize: number) {
  const db = await getDb()
  try {
    const tags = await loadActiveTags(maxCount)
    const batches: Array<typeof tags> = []
    for (let i = 0; i < tags.length; i += batchSize) batches.push(tags.slice(i, i + batchSize))
    scanState.total = batches.length
    scanState.done = 0
    scanState.message = `次要标签判定：${tags.length} 个低频（≤${maxCount} 次）标签分 ${batches.length} 批`
    let proposals = 0
    let failedBatches = 0
    for (const batch of batches) {
      const nameSet = new Set(batch.map(t => t.name))
      const prompt = `你是内容管理系统的标签分级助手。下面是标签列表（n 为名字，c 为使用次数）。
主标签应能代表一个主题概念、有检索归类价值；过于细节、碎片化、只对单篇内容有意义、或属于过度拆分的标签应归为次要标签（仅存档，不再用于标记）。
从列表中挑出应归为次要的标签，宁缺勿滥（不超过列表的一半）。
输出 json：{"secondary":["标签名"],"reason":"整体说明"}

标签列表：
${JSON.stringify(batch.map(t => ({ n: t.name, c: t.fc })))}`
      try {
        const data = await callLlmJson(prompt)
        const names: string[] = (Array.isArray(data?.secondary) ? data.secondary : []).map(String).filter((n: string) => nameSet.has(n))
        if (names.length) {
          const key = JSON.stringify([...names].sort())
          if (!(await proposalExists(db, 'level', 'secondary', names))) {
            await db.exec(`INSERT INTO tag_proposals (kind, canonical, members, reason)
              VALUES ('level', 'secondary', '${key.replace(/'/g, "''")}', '${String(data?.reason || '').replace(/'/g, "''")}')`)
            proposals++
          }
        }
      } catch (e: any) {
        failedBatches++
        scanState.lastError = String(e?.message || e)
      }
      scanState.done++
      await new Promise(r => setTimeout(r, 1000))
    }
    scanState.lastResult = { proposals, failedBatches }
    scanState.message = `次要标签判定完成：新增 ${proposals} 条分级建议${failedBatches ? `（${failedBatches} 批失败）` : ''}`
    await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('scan_level', '{"proposals":${proposals},"failedBatches":${failedBatches}}')`)
  } catch (e: any) {
    scanState.lastError = String(e?.message || e)
    scanState.message = '次要标签判定失败'
  } finally {
    scanState.running = ''
    scanState.finishedAt = new Date().toISOString()
  }
}

export function startSemanticScan(batchSize = 400): boolean {
  if (scanState.running) return false
  scanState.running = 'semantic'
  scanState.lastError = ''
  void semanticScanJob(batchSize)
  return true
}

export function startLevelScan(maxCount = 2, batchSize = 400): boolean {
  if (scanState.running) return false
  scanState.running = 'level'
  scanState.lastError = ''
  void levelScanJob(maxCount, batchSize)
  return true
}

// ---- 查询与统计 ----

/** 共现关联：与指定标签最常一起出现的标签 Top N */
export async function relatedTags(tagId: number, limit = 12): Promise<any[]> {
  const db = await getDb()
  return await (await db.prepare(`
    SELECT t.id, t.name, t.level, COUNT(*) AS cnt
    FROM file_tags a
    JOIN file_tags b ON b.file_id = a.file_id AND b.tag_id != a.tag_id
    JOIN tags t ON t.id = b.tag_id AND t.status = 'active'
    WHERE a.tag_id = ?
    GROUP BY t.id ORDER BY cnt DESC
    LIMIT ${Math.max(1, Math.min(50, Number(limit) || 12))}
  `)).all(tagId) as any[]
}

/** 标签体系统计：各级数量 + Top 频次 + 近 180 天新标签趋势（15 天一桶） */
export async function tagStats(): Promise<any> {
  const db = await getDb()
  const one = async (sql: string) => Number((await (await db.prepare(sql)).get() as any)?.n || 0)
  const total = await one('SELECT COUNT(*) AS n FROM tags')
  const active = await one("SELECT COUNT(*) AS n FROM tags WHERE status = 'active'")
  const primary = await one("SELECT COUNT(*) AS n FROM tags WHERE status = 'active' AND level = 'primary'")
  const secondary = await one("SELECT COUNT(*) AS n FROM tags WHERE status = 'active' AND level = 'secondary'")
  const merged = await one("SELECT COUNT(*) AS n FROM tags WHERE status = 'merged'")
  const retired = await one("SELECT COUNT(*) AS n FROM tags WHERE status = 'retired'")
  const used = await one('SELECT COUNT(DISTINCT tag_id) AS n FROM file_tags')
  const top = await (await db.prepare(`
    SELECT t.id, t.name, t.level, COUNT(ft.file_id) AS file_count
    FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
    WHERE t.status = 'active'
    GROUP BY t.id ORDER BY file_count DESC LIMIT 20
  `)).all() as any[]
  // 新标签趋势：按「标签首次被使用」的 15 天周期分桶，取近 12 桶（约 180 天）
  const trendRows = await (await db.prepare(`
    SELECT CAST((julianday('now') - julianday(MIN(created_at))) / 15 AS INTEGER) AS idx, COUNT(*) AS n
    FROM file_tags GROUP BY tag_id
  `)).all() as any[]
  const byIdx = new Map<number, number>()
  for (const r of trendRows) {
    const idx = Number(r.idx)
    if (Number.isFinite(idx) && idx >= 0) byIdx.set(idx, (byIdx.get(idx) || 0) + 1)
  }
  const now = new Date()
  const fmtMD = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const trend: { month: string; newTags: number }[] = []
  for (let i = 11; i >= 0; i--) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 15)
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 14)
    trend.push({ month: fmtMD(start), newTags: byIdx.get(i) || 0 })
  }
  return { total, active, primary, secondary, merged, retired, orphan: total - used, top, trend }
}

/** 批量导出（含挂载计数与生命周期字段） */
export async function exportTags(): Promise<any[]> {
  const db = await getDb()
  return await (await db.prepare(`
    SELECT t.id, t.name, t.color, t.level, t.status, t.merged_into, COUNT(ft.file_id) AS file_count
    FROM tags t LEFT JOIN file_tags ft ON ft.tag_id = t.id
    GROUP BY t.id ORDER BY t.id
  `)).all() as any[]
}

/** 批量导入：存在即跳过，返回新建/跳过计数 */
export async function importTags(items: Array<{ name?: string; color?: string }>): Promise<{ created: number; skipped: number }> {
  const db = await getDb()
  let created = 0
  let skipped = 0
  const stmt = await db.prepare('SELECT id FROM tags WHERE name = ?')
  await db.transactionalize(async () => {
    for (const it of Array.isArray(items) ? items : []) {
      const name = String(it?.name || '').trim()
      if (!name) { skipped++; continue }
      if (await stmt.get(name)) { skipped++; continue }
      const esc = name.replace(/'/g, "''")
      const color = String(it?.color || '#67c23a').replace(/'/g, "''")
      await db.exec(`INSERT OR IGNORE INTO tags (name, color) VALUES ('${esc}', '${color}')`)
      created++
    }
    await db.exec(`INSERT INTO tag_ops (op, detail) VALUES ('import', '${JSON.stringify({ created, skipped }).replace(/'/g, "''")}')`)
  })
  return { created, skipped }
}
