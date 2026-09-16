import chokidar from 'chokidar'
import { getDb } from './db.js'
import { scanFile } from './scanner.js'
import { loadGateConfig, isExcludedPath } from './gate.js'

let watcher: chokidar.FSWatcher | null = null
let lastOnChange: ((stats: any) => void) | null = null

export async function startWatcher(roots: string[], onChange: (stats: any) => void) {
  if (watcher) {
    watcher.close()
  }
  lastOnChange = onChange
  const cfg = await loadGateConfig()
  watcher = chokidar.watch(roots, {
    ignored: (fp: string) => {
      // 隐藏目录/文件：只看扫描根之后的部分（根本身可以是 .openclaw-autoclaw 这类隐藏目录）
      const rootHit = roots.find(r => fp === r || fp.startsWith(r + '/'))
      const rel = rootHit ? fp.slice(rootHit.length) : fp
      if (rel.split('/').some(seg => seg.startsWith('.') && seg.length > 0)) return true
      return isExcludedPath(fp, cfg, roots)
    },
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200
    }
  })

  // 单文件增量入库：新增/变更只评估该文件，不做全目录遍历
  watcher.on('add', async (fp) => {
    try {
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
