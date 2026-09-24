import chokidar from 'chokidar'
import { lstat } from 'fs/promises'
import { getDb } from './db.js'
import { scanFile } from './scanner.js'
import { loadGateConfig, isExcludedPath } from './gate.js'

/**
 * 入库层符号链接防御（P1-⑭ 根治）：chokidar followSymlinks:false 只约束自身遍历，
 * macOS FSEvents 仍可能泄露符号链接子树内的事件（全量测试并行负载下稳定复现）——
 * 生产 lingxi-claw 13776 文件「收编即墓碑化」事故即此形态。扫描通道 walk() 的口径是
 * withFileTypes 判目录（永不跟随符号链接），watcher 入库前必须对齐：路径从所属根
 * 到文件的任一组件（含文件自身）是符号链接即拒收，双通道可见性恒一致。
 */
export async function realPathWithinRoots(fp: string, roots: string[]): Promise<boolean> {
  try {
    // 最长匹配根：fp 不落在任何根下时不在此拦（交 scanFile 按无主路径处理）
    const base = roots
      .filter(r => fp === r || fp.startsWith(r.endsWith('/') ? r : r + '/'))
      .sort((a, b) => b.length - a.length)[0]
    if (!base) return true
    // 逐组件 lstat：根之后每个路径段都不得是符号链接
    let cur = base.endsWith('/') ? base.slice(0, -1) : base
    const rest = fp.slice(cur.length).split('/').filter(Boolean)
    for (const seg of rest) {
      cur = cur + '/' + seg
      if ((await lstat(cur)).isSymbolicLink()) return false
    }
    return true
  } catch { return true } // lstat 失败（写入竞态等）按放行，交 scanFile 自然处理
}

let watcher: chokidar.FSWatcher | null = null
let lastOnChange: ((stats: any) => void) | null = null

export async function startWatcher(roots: string[], onChange: (stats: any) => void) {
  if (watcher) {
    watcher.close()
  }
  lastOnChange = onChange
  const cfg = await loadGateConfig()
  watcher = chokidar.watch(roots, {
    // 忽略规则与扫描 walk 的排除口径必须一致，否则「已入库的文件收不到实时增改」。
    // walk() 只按 cfg.excludeDirs 剪枝（不额外跳隐藏目录），故这里也只信 isExcludedPath：
    // 隐藏目录若不在排除名单（如 <root>/.claude），扫描会收编，watcher 就必须同样能跟改。
    ignored: (fp: string) => isExcludedPath(fp, cfg, roots),
    persistent: true,
    ignoreInitial: true,
    // chokidar 默认跟随符号链接并按链接路径上报，而 scanner 的 walk() 用 withFileTypes 判目录
    // （symlink 为 false）永不跟随：watcher 收编的文件下一轮增量必然被清理下线，形成加删循环
    //（生产实测 lingxi-claw 的 skills 符号链接子树 13776 个文件即如此）。两侧可见性必须对齐。
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200
    }
  })

  // 等监听流装配完成再返回：watch() 创建与 FSEvents/inotify 流就绪之间存在异步窗口，
  // 落在窗口内的变更会被 ignoreInitial 吞掉、永不补发——startWatcher 返回后立即写文件的
  // 调用方（scanRepro P1-③ 控制组）会确定性抖动丢事件。有界等待：大根目录 ready 慢时
  // 不阻塞服务重启流程；超时照常返回，漏掉的实时事件由下一轮增量扫描兜底。
  await Promise.race([
    new Promise<void>(r => watcher!.once('ready', r)),
    new Promise<void>(r => { const t = setTimeout(r, 2000); t.unref() }),
  ])

  // 单文件增量入库：新增/变更只评估该文件，不做全目录遍历
  watcher.on('add', async (fp) => {
    try {
      if (!await realPathWithinRoots(fp, roots)) return
      const out = await scanFile(fp, roots)
      if (out && (out.added || out.updated || out.restored)) {
        onChange({ scanned: 1, added: out.added ? 1 : 0, updated: out.updated || out.restored ? 1 : 0, deleted: 0, gated: 0 })
      } else if (out?.gated) {
        onChange({ scanned: 1, added: 0, updated: 0, deleted: 0, gated: 1 })
      }
    } catch { /* 单文件入库失败不阻塞 watcher */ }
  })

  watcher.on('change', async (fp) => {
    try {
      if (!await realPathWithinRoots(fp, roots)) return
      const out = await scanFile(fp, roots)
      if (out && (out.updated || out.restored)) {
        onChange({ scanned: 1, added: 0, updated: 1, deleted: 0, gated: 0 })
      } else if (out?.gated) {
        onChange({ scanned: 1, added: 0, updated: 0, deleted: 0, gated: 1 })
      }
    } catch { /* 单文件入库失败不阻塞 watcher */ }
  })

  watcher.on('unlink', async (fp) => {
    const db = await getDb()
    const existingStmt = await db.prepare("SELECT id FROM files WHERE path = ? AND status = 'active'")
    const existing = await existingStmt.get(fp) as any
    if (existing) {
      await db.exec(`UPDATE files SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`)
      onChange({ deleted: 1, scanned: 0, added: 0, updated: 0 })
    }
  })
}

export function stopWatcher() {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

/** 扫描根增删/启停后重载 watcher（沿用最近一次 onChange 回调） */
export async function restartWatcherForRoots(): Promise<number> {
  if (!lastOnChange) return 0
  const db = await getDb()
  const rows = await (await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')).all() as any[]
  const roots = rows.map((r: any) => r.path)
  await startWatcher(roots, lastOnChange)
  return roots.length
}
