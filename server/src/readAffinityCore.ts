// I2 用户理解信号：阅读会话聚类 + 簇主题标注（readAffinity 脚本与测试共享的纯计算核心）。
// WHY 抽模块：与 funnelCore.clusterSessions 同一思想（30 分钟间隔切会话），但数据结构不同
// （read_history：file_id/path/source/opened_at，主题标注还需 file→domain 映射），独立实现各自口径；
// 脚本（OPEN_READONLY CLI）与测试不各自复制聚类逻辑——聚类数字一旦双份就必然漂移。

import { parseTs } from './funnelCore.js'

/** 阅读会话切分阈值：相邻打开间隔 > 30 分钟视为新簇（与 funnelCore.SESSION_GAP_MS 同口径） */
export const READ_GAP_MS = 30 * 60 * 1000

/** 文件无域挂靠时的桶名（对齐 funnelPanel COALESCE(d.name,'未分类') 口径） */
export const UNCLASSIFIED = '未分类'

/** read_history 行（脚本从库拉取 / 测试手工构造的最小字段集） */
export interface ReadHistoryRow {
  id: number
  file_id: number | null
  path: string
  source: string
  opened_at: string | null
}

/** 聚类后的阅读事件（opened_at 已解析为毫秒，raw 保留原始串供输出） */
export interface ReadEvent {
  id: number
  fileId: number | null
  path: string
  source: string
  t: number
  raw: string
}

export interface LabeledCluster {
  /** 1 起簇号（输出表 #id 用） */
  id: number
  startsAt: string
  endsAt: string
  /** 簇内打开总次数 */
  opens: number
  /** 簇内去重文件数 */
  fileCount: number
  /** 出现 ≥2 次的域（按次数降序，同次数按首现顺序） */
  primaryDomains: string[]
  /** 去重域序列（首现顺序；跨域簇即学习路径候选） */
  domainSeq: string[]
  /** 去重域数 ≥2 */
  crossDomain: boolean
}

/** 事件的域归属：file_id 有映射取映射名（null → 未分类），无 file_id / 无映射同样归未分类 */
export function domainOf(e: ReadEvent, fileDomainMap: Map<number, string | null>): string {
  if (e.fileId == null || !fileDomainMap.has(e.fileId)) return UNCLASSIFIED
  return fileDomainMap.get(e.fileId) ?? UNCLASSIFIED
}

/** 阅读会话聚类：opened_at 升序输入，相邻间隔 > 30 分钟切新簇；非法时间戳剔除并计数 */
export function clusterReads(rows: ReadHistoryRow[]): { clusters: ReadEvent[][], skipped: number } {
  const clusters: ReadEvent[][] = []
  let skipped = 0
  for (const row of rows) {
    const t = parseTs(row.opened_at)
    if (t === null) { skipped++; continue }
    const ev: ReadEvent = { id: row.id, fileId: row.file_id, path: row.path, source: row.source, t, raw: row.opened_at! }
    const last = clusters[clusters.length - 1]
    if (!last || ev.t - last[last.length - 1].t > READ_GAP_MS) clusters.push([ev])
    else last.push(ev)
  }
  return { clusters, skipped }
}

/** 簇主题标注：主域 = 簇内出现 ≥2 次的域；跨 ≥2 域标跨域并列出域序列 */
export function labelClusters(clusters: ReadEvent[][], fileDomainMap: Map<number, string | null>): LabeledCluster[] {
  return clusters.map((events, i) => {
    const counts = new Map<string, number>()
    const order: string[] = []
    for (const e of events) {
      const name = domainOf(e, fileDomainMap)
      counts.set(name, (counts.get(name) || 0) + 1)
      if (!order.includes(name)) order.push(name)
    }
    return {
      id: i + 1,
      startsAt: events[0].raw,
      endsAt: events[events.length - 1].raw,
      opens: events.length,
      fileCount: new Set(events.map(e => e.fileId).filter(f => f != null)).size,
      primaryDomains: order
        .filter(d => (counts.get(d) || 0) >= 2)
        .sort((a, b) => (counts.get(b)! - counts.get(a)!) || order.indexOf(a) - order.indexOf(b)),
      domainSeq: order,
      crossDomain: order.length >= 2,
    }
  })
}
