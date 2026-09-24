// 共享格式化工具：从 7 个视图的重复实现中提取（vercel-composition-patterns · DRY/复用性）。
// 注意口径差异：fmtTime 有「相对时间」与「短日期」两种，本文件提供两个命名函数；
// 旧实现散落各处且互相漂移（同输入不同视图显示不同），此处统一为单一事实源。

/** 短日期时间：`MM-DD HH:mm`（Pipeline/Library/Supply/Entry 的表格口径） */
export function fmtTime(t?: string | null): string {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

/** 相对日期时间：`今天 HH:mm` / `昨天 HH:mm` / `MM-DD HH:mm`（Overview/Domains 详情口径） */
export function fmtTimeRelative(t?: string | null): string {
  if (!t) return '—'
  const dt = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z')
  if (isNaN(dt.getTime())) return String(t)
  const now = new Date()
  const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
  if (dt.toDateString() === now.toDateString()) return `今天 ${hm}`
  const yest = new Date(now.getTime() - 86400000)
  if (dt.toDateString() === yest.toDateString()) return `昨天 ${hm}`
  return fmtTime(t)
}

/** token 数缩写：`1.23M / 45.6K / 789`（Overview/Pipeline 的 LLM 统计口径） */
export function fmtTokens(n?: number | null): string {
  if (!n) return '0'
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
}

/** 文件大小：`1.5 MB / 320.0 KB / 888 B`（Library/FileDrawer 口径） */
export function fmtSize(n?: number): string {
  if (!n) return '—'
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
}

/** 剪贴板写入：成功返回 true（调用方决定 toast 文案），失败不抛错 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
