import { Router } from 'express'
import { getDb } from '../db.js'
import { searchKnowledgeCore, type SearchKnowledgeParams } from '../knowledge.js'
import { parseAliases } from '../search/querySyntax.js'

export const searchRouter = Router()

/**
 * Web 端混合检索出口（批次① · Hister 竞品分析落地）：
 * 三路 RRF（files LIKE + wiki FTS5 + 分块向量）此前只服务 MCP search_knowledge 与 chat，
 * Web 收件坪/成品仓一直是 LIKE 列表——本路由把同一内核 searchKnowledgeCore 暴露给人侧。
 * 与 MCP 工具同参同源（query/domain/tags/agent/limit/since/until），出口层清洗共用，
 * 保证 agent 与人看到完全一致的结果（E1 漏斗诊断的 Web 半边数据从此可采）。
 */
searchRouter.get('/', async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || '').trim()
    if (!query) return res.json({ success: true, items: [], total: 0, message: '缺少 query' })
    const params: SearchKnowledgeParams = {
      query,
      domain: req.query.domain ? String(req.query.domain) : undefined,
      agent: req.query.agent ? String(req.query.agent) : undefined,
      tags: req.query.tags ? String(req.query.tags).split(',').map(s => s.trim()).filter(Boolean) : undefined,
      limit: Math.min(50, Math.max(1, parseInt(String(req.query.limit)) || 20)),
      since: req.query.since ? String(req.query.since) : undefined,
      until: req.query.until ? String(req.query.until) : undefined,
    }
    const items = await searchKnowledgeCore(await getDb(), params)
    // Web 检索埋点（source='search' + query 词）：人侧搜索行为的可观测性，E1 漏斗诊断 Web 半边数据源；
    // 失败不阻塞检索返回（埋点是旁路）
    try {
      const db = await getDb()
      await (await db.prepare("INSERT INTO read_history (path, source, query) VALUES ('', 'search', ?)")).run([query])
    } catch { /* 埋点失败静默 */ }
    res.json({ success: true, items, total: items.length })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * Web 检索点击归因（批次⑤）：用户点击混合检索结果时落一条带 file_id 的 read_history。
 * 口径约定：source='search' 且 file_id 非空 = 「搜索后点击打开」，file_id 空 = 「发起搜索」——
 * 一张表两种事件，funnel Web 半边据此计算 search→click 转化率（E1 人侧漏斗 level1）。
 * query 参数化截断 200 字符，与发起搜索时落库的词一致才可配对。
 */
searchRouter.post('/click', async (req, res) => {
  try {
    const fileId = parseInt(String(req.body?.fileId))
    const query = String(req.body?.query || '').trim().slice(0, 200)
    if (!Number.isInteger(fileId) || fileId <= 0 || !query) {
      return res.status(400).json({ success: false, message: '缺少 fileId 或 query' })
    }
    const db = await getDb()
    const file = await (await db.prepare('SELECT id, path FROM files WHERE id = ?')).get(fileId) as any
    if (!file) return res.status(404).json({ success: false, message: 'file not found' })
    await (await db.prepare("INSERT INTO read_history (file_id, path, source, query) VALUES (?, ?, 'search', ?)")).run([fileId, String(file.path || ''), query])
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * 检索健康自检（批次④ · Hister doctor 同款思路）：FTS 覆盖率 / 向量路配置 / 别名表合法性 /
 * 混合开关 / 过滤记录体量，一次体检全量呈现。每项 { key, ok, detail }——ok=false 不代表故障，
 * detail 解释现状与动作入口（向量未启用是合法态）。
 */
/** L1 延迟治理：doctor 为 7+ 个全表级聚合（FTS 反连接 55k + done-no-meta 反连接 74k，实测 13s+），
 *  诊断语义无需实时——5 分钟 TTL 缓存；写路径（fts/prune、reconsile）触发后清缓存即刻见效。 */
export let doctorCache: { at: number; checks: any[] } | null = null
export function invalidateDoctorCache() { doctorCache = null }
searchRouter.get('/doctor', async (_req, res) => {
  try {
    if (doctorCache && Date.now() - doctorCache.at < 300_000) {
      return res.json({ success: true, checks: doctorCache.checks, cached: true })
    }
    const db = await getDb()
    const cfgVal = async (key: string): Promise<string | null> => {
      try {
        const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get(key) as any
        return row?.value ?? null
      } catch { return null }
    }
    const count = async (sql: string): Promise<number> => {
      try { return Number((await (await db.prepare(sql)).get() as any)?.n ?? 0) } catch { return 0 }
    }

    const checks: { key: string; ok: boolean; detail: string }[] = []

    const activeFiles = await count("SELECT COUNT(*) as n FROM files WHERE status = 'active'")
    checks.push({ key: 'files', ok: activeFiles > 0, detail: activeFiles > 0 ? `${activeFiles.toLocaleString('en-US')} 个有效文件在库` : '库内暂无有效文件 · 先在扫描页挂载并扫描' })

    const hybridEnabled = (await cfgVal('search.hybridEnabled')) !== 'false'
    checks.push({ key: 'hybrid', ok: hybridEnabled, detail: hybridEnabled ? '三路混合检索开启（全文 + 摘要 + 语义）' : '混合检索已关闭 · 当前回退旧单路标题匹配（可在本页重开）' })

    const wikiEntries = await count('SELECT COUNT(*) as n FROM wiki_entries_meta')
    let ftsCount = 0
    let ftsOrphans = 0
    try {
      ftsCount = await count('SELECT COUNT(*) as n FROM wiki_fts')
      ftsOrphans = await count('SELECT COUNT(*) as n FROM wiki_fts WHERE entry_id NOT IN (SELECT id FROM wiki_entries_meta)')
    } catch { /* 虚表缺失按 0 */ }
    const ftsOk = ftsOrphans === 0 && ftsCount >= wikiEntries
    checks.push({
      key: 'fts',
      ok: ftsOk,
      detail: ftsOk
        ? `全文索引覆盖 ${ftsCount}/${wikiEntries} 词条，无孤儿行`
        : ftsOrphans > 0
          ? `全文索引含 ${ftsOrphans} 条孤儿行（指向已删词条）· 过滤门禁页「检索健康」或 POST /api/wiki/fts/prune 清理`
          : `全文索引缺覆盖（${ftsCount}/${wikiEntries}）· 重启服务触发 ensureFtsPopulated 兜底`
    })

    let embEnabled = false
    let embModel = ''
    try {
      const emb = JSON.parse((await cfgVal('ai.embedding')) || '{}')
      embEnabled = !!emb.enabled
      embModel = String(emb.model || '')
    } catch { /* 坏配置按未启用 */ }
    const chunkCount = await count('SELECT COUNT(*) as n FROM entry_chunks')
    // 方案 B 口径迁移：file 级向量（files.embed_state）随 file_embeddings DROP 废止，
    // 覆盖口径切词条分块——covered/entries 与词条页补嵌面板同源
    const embEntries = await count('SELECT COUNT(*) as n FROM wiki_entries_meta')
    const embCovered = await count('SELECT COUNT(DISTINCT entry_id) as n FROM entry_chunks WHERE embedding IS NOT NULL')
    const embPending = Math.max(0, embEntries - embCovered)
    const coverage = `词条向量覆盖 ${embCovered}/${embEntries} · 待嵌 ${embPending}（词条页「补嵌一批」推进）`
    if (!embEnabled) {
      checks.push({ key: 'vector', ok: true, detail: `语义向量路未启用（可选）· 已有 ${chunkCount} 个词条分块` })
    } else if (!embModel) {
      checks.push({ key: 'vector', ok: false, detail: `向量已启用但未配置嵌入模型 · 前往 AI 设置补全，否则语义路静默跳过 · ${coverage}` })
    } else {
      checks.push({ key: 'vector', ok: chunkCount > 0, detail: chunkCount > 0 ? `向量路就绪 · ${embModel} · ${chunkCount} 个词条分块 · ${coverage}` : `向量路已启用（${embModel}）但尚无分块 · 待蒸馏回填 · ${coverage}` })
    }

    const aliasesRaw = await cfgVal('search.aliases')
    if (aliasesRaw === null || aliasesRaw.trim() === '') {
      checks.push({ key: 'aliases', ok: true, detail: '查询别名未配置（可选）· 支持 title:/tag:/短语/-排除 迷你语法' })
    } else {
      const aliases = parseAliases(aliasesRaw)
      const parsedOk = Object.keys(aliases).length > 0 || aliasesRaw.trim() === '{}'
      checks.push({ key: 'aliases', ok: parsedOk, detail: parsedOk ? `别名表合法 · ${Object.keys(aliases).length} 条` : '别名表 JSON 损坏（已按空表降级）· 在本页重新保存即可修复' })
    }

    const skipped = await count("SELECT COUNT(*) as n FROM gate_records WHERE status = 'skipped'")
    checks.push({ key: 'gate', ok: true, detail: skipped > 0 ? `${skipped} 条内容被门禁拦截（过滤门禁页可恢复/归档）` : '门禁无拦截记录' })

    // 新鲜度（P0 修复配套）：done 且有词条、但文件 mtime 晚于 distilled_at 的"陈旧词条"——
    // 蒸馏后内容又变更而词条未刷新，检索召回的是旧知识。修复后应自动归零（feeder 消化 pending），
    // 持续 >0 说明重蒸馏链路堵了（队列暂停/预算闸/autoTag 关闭），detail 指向排查方向
    const staleBuckets = await (await db.prepare(`
      SELECT CASE
        WHEN julianday(f.file_mtime) - julianday(w.distilled_at) < 1 THEN 'd0'
        WHEN julianday(f.file_mtime) - julianday(w.distilled_at) < 7 THEN 'd7'
        WHEN julianday(f.file_mtime) - julianday(w.distilled_at) < 30 THEN 'd30'
        ELSE 'd30p'
      END as bucket, COUNT(*) as n
      FROM files f JOIN wiki_entries_meta w ON w.file_id = f.id
      WHERE f.llm_state = 'done' AND f.status = 'active' AND f.file_mtime > w.distilled_at
      GROUP BY bucket`)).all() as any[]
    const staleTotal = staleBuckets.reduce((s, b) => s + Number(b.n), 0)
    const pendingNow = await count("SELECT COUNT(*) as n FROM files WHERE llm_state = 'pending' AND status = 'active'")
    checks.push({
      key: 'freshness',
      ok: staleTotal === 0,
      detail: staleTotal === 0
        ? `词条全部新鲜（蒸馏后无未刷新的内容变更）· 待蒸馏 ${pendingNow}`
        : `${staleTotal} 个词条落后于文件内容（<1天 ${staleBuckets.find(b => b.bucket === 'd0')?.n ?? 0} · 1-7天 ${staleBuckets.find(b => b.bucket === 'd7')?.n ?? 0} · 7-30天 ${staleBuckets.find(b => b.bucket === 'd30')?.n ?? 0} · >30天 ${staleBuckets.find(b => b.bucket === 'd30p')?.n ?? 0}）· 待蒸馏 ${pendingNow} · 持续不降查队列暂停/预算闸`
    })

    // M4 资产一致性（链路分析 P1-1）：done ≠ 可消费——done 但无 wiki_entries_meta 的文件
    // 意味着状态与资产脱钩（历史迁移/部分写入失败），检索与 MCP 都取不到词条。
    // 「被可靠消费」的前提是 done 必有词条；修复入口 POST /api/llm/queue/reconsile-done（有界重排）
    const doneNoMeta = await count(`
      SELECT COUNT(*) as n FROM files f
      WHERE f.llm_state = 'done' AND f.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM wiki_entries_meta w WHERE w.file_id = f.id)`)
    checks.push({
      key: 'consistency',
      ok: doneNoMeta === 0,
      detail: doneNoMeta === 0
        ? '蒸馏状态与词条资产一致（done 必有词条）'
        : `${doneNoMeta} 个文件标记完成但无词条资产 · POST /api/llm/queue/reconsile-done 有界重排（默认 500/批）`
    })

    doctorCache = { at: Date.now(), checks }
    res.json({ success: true, checks })
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message })
  }
})
