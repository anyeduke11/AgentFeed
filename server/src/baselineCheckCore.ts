/**
 * 评估闭环 baseline:check 的纯函数核心（v0.1.5 D1）。
 * WHY：语料漂移后，基线文档里的重放数字（Top-3 对照表）随之失效，但无法机械检测——
 * searchBaseline 在文档头部锚定 corpusFingerprint（active files 数 + 最大 id，
 * 与 exportWiki.computeCorpusFingerprint 同口径），check 时重算对比即可判断
 * 「这份基线的重放数字是否仍可信」。解析与对比在此做纯函数，CLI 壳（scripts/baselineCheck.ts）
 * 只管 IO，保证本文件可被 node:test 直接覆盖、不依赖任何 db/fs 模块。
 */

export interface BaselineFingerprint {
  filesCount: number
  maxFileId: number
}

/** 从基线 markdown 提取头部指纹锚点行（形如 `> corpusFingerprint: {...} generatedAt: ...`）。
 * 无该行 / JSON 非法 / 形状不对（缺键、非整数）一律返回 null = 旧版基线，无锚点可用。 */
export function extractFingerprintFromDoc(md: string): BaselineFingerprint | null {
  const matched = md.match(/^>?\s*corpusFingerprint:\s*(\{[^\n]*?\})/m)
  if (!matched) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(matched[1])
  } catch {
    return null
  }
  const { filesCount, maxFileId } = parsed as Record<string, unknown>
  if (typeof filesCount !== 'number' || !Number.isInteger(filesCount)) return null
  if (typeof maxFileId !== 'number' || !Number.isInteger(maxFileId)) return null
  return { filesCount, maxFileId }
}

/** 指纹一致 = active files 数与最大 id 均相同；任一变动即语料已漂移 */
export function compareFingerprints(a: BaselineFingerprint, b: BaselineFingerprint): boolean {
  return a.filesCount === b.filesCount && a.maxFileId === b.maxFileId
}
