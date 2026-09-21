// J3 机读画像第二出口：AGENTS.md/CLAUDE.md 托管区块同步器（v0.1.5 PRD 3.3.10 J3）。
// 授权模型：只写 config userProfile.syncTargets 明列的绝对路径（不做目录扫描发现）——
// 未授权文件天然不可达；文件存在但无标记 → 保守跳过（missing-marker：用户可能手删了授权区块，应停不应重建）。
// 红线：生效断言只经 projectProfile 投影（model.ts 单一事实源），vetoed 永不写入区块，本文件不得自拼 claims。
import fs from 'fs/promises'
import { getDb } from '../db.js'
import { getActiveProfile, parseProfileContent, projectProfile, type ProfileContent } from './model.js'
import { isProfileDistillEnabled } from './distill.js'

export const BLOCK_START = '<!-- agentfeed:profile start -->'
export const BLOCK_END = '<!-- agentfeed:profile end -->'
/** 授权同步清单（type=json，元素=AGENTS.md/CLAUDE.md 绝对路径）；全局开关复用 userProfile.enabled */
export const CONFIG_SYNC_TARGETS = 'userProfile.syncTargets'

/** 区块正文：画像 markdown（role_pattern + 生效断言行）+ 版本行 */
function buildBlockBody(profile: { id: number, content: ProfileContent }, syncedAt: string): string {
  const projected = projectProfile(profile.content)
  const lines: string[] = []
  if (projected.role_pattern) lines.push(`角色画像：${projected.role_pattern}`)
  if (projected.claims.length > 0) lines.push('生效断言：')
  for (const c of projected.claims) lines.push(`- ${c.claim}（置信 ${c.confidence}）`)
  lines.push(`> profile version: ${profile.id} synced: ${syncedAt}`)
  return lines.join('\n')
}

/**
 * 把文件内容中已有区块（含标记）整体替换为新区块；无区块则在文件末尾追加（前空一行）。纯函数。
 * 区块外内容字节原样保留（slice 不重排）——幂等地基：同区块正文重复渲染结果逐字节相等。
 */
export function renderManagedBlock(fileContent: string, blockBody: string): string {
  const newBlock = `${BLOCK_START}\n${blockBody}\n${BLOCK_END}`
  const startIdx = fileContent.indexOf(BLOCK_START)
  const endIdx = fileContent.indexOf(BLOCK_END)
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return fileContent.slice(0, startIdx) + newBlock + fileContent.slice(endIdx + BLOCK_END.length)
  }
  const base = fileContent.replace(/\s+$/, '')
  return base === '' ? `${newBlock}\n` : `${base}\n\n${newBlock}\n`
}

/**
 * 单文件同步：按 versionId 读画像 → 读目标文件 → 有标记替换写回。
 * 文件不存在/版本不存在/content 损坏 → 'noop'（交调用方记录）；文件存在但无标记 → 'missing-marker'（一个字节不动）。
 * syncedAt 取 ISO 日期（非时刻）——同画像同日重复 sync 字节级幂等；测试可注入固定日期。
 */
export async function syncProfileToFile(
  versionId: number, absPath: string, opts?: { syncedAt?: string }
): Promise<'updated' | 'noop' | 'missing-marker'> {
  const db = await getDb()
  const row = await (await db.prepare('SELECT id, content FROM user_profile WHERE id = ?')).get([Number(versionId)]) as any
  if (!row) return 'noop'
  const content = parseProfileContent(String(row.content))
  if (!content) return 'noop' // content 损坏 fail loud 拒写（同 model.ts 口径）
  let raw: string
  try {
    raw = await fs.readFile(absPath, 'utf8')
  } catch {
    return 'noop'
  }
  if (!raw.includes(BLOCK_START) || !raw.includes(BLOCK_END)) return 'missing-marker'
  const syncedAt = opts?.syncedAt ?? new Date().toISOString().slice(0, 10)
  await fs.writeFile(absPath, renderManagedBlock(raw, buildBlockBody({ id: Number(row.id), content }, syncedAt)), 'utf8')
  return 'updated'
}

/**
 * 授权清单批量同步（手动端点与蒸馏成功后共用）：开关关/清单空/无生效画像 → []。
 * 逐文件调 syncProfileToFile 收集结果——清单外路径根本不进循环，未授权写入天然不可达。
 */
export async function syncAuthorizedProjects(): Promise<Array<{ path: string, result: string }>> {
  const db = await getDb()
  if (!(await isProfileDistillEnabled(db))) return []
  const row = await (await db.prepare('SELECT value FROM config WHERE key = ?')).get([CONFIG_SYNC_TARGETS]) as any
  let targets: string[] = []
  if (row) {
    try {
      const parsed = JSON.parse(String(row.value))
      if (Array.isArray(parsed)) targets = parsed.map(String)
    } catch { /* 坏值视同未配置（零授权零写入） */ }
  }
  if (targets.length === 0) return []
  const profile = await getActiveProfile(db, 'global', null)
  if (!profile) return []
  const results: Array<{ path: string, result: string }> = []
  for (const p of targets) {
    results.push({ path: p, result: await syncProfileToFile(profile.id, p) })
  }
  return results
}
