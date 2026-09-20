import { spawn } from 'child_process'
import path from 'path'
import { getDb } from './db.js'

export async function openFile(fileId: number): Promise<{ success: boolean; message: string }> {
  const db = await getDb()
  const fileStmt = await db.prepare('SELECT path FROM files WHERE id = ? AND status = ?')
  const file = await fileStmt.get([fileId, 'active']) as any
  if (!file) {
    return { success: false, message: '文件不存在或已删除' }
  }
  const rootStmt = await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')
  const root = await rootStmt.all() as any[]
  // 严格边界：裸 startsWith 会误放行 /foo/bar2 这类兄弟目录
  const allowed = root.some(r => file.path === r.path || file.path.startsWith(r.path + path.sep))
  if (!allowed) {
    return { success: false, message: '文件不在已注册扫描根目录下' }
  }
  return new Promise((resolve) => {
    const ext = path.extname(file.path).toLowerCase()
    let command: string, args: string[]
    if (ext === '.md') {
      command = 'open'
      args = ['-a', 'Typora', file.path]
    } else {
      command = 'open'
      args = ['-a', 'Google Chrome', file.path]
    }
    const child = spawn(command, args, { detached: true })
    child.unref()
    child.on('error', () => {
      spawn('open', [file.path], { detached: true }).unref()
      resolve({ success: true, message: '已使用默认应用打开' })
    })
    child.on('spawn', () => {
      resolve({ success: true, message: '已打开' })
    })
    setTimeout(() => {
      resolve({ success: true, message: '已发送打开指令' })
    }, 500)
  })
}

export async function revealFile(fileId: number): Promise<{ success: boolean; message: string }> {
  const db = await getDb()
  const fileStmt = await db.prepare('SELECT path FROM files WHERE id = ? AND status = ?')
  const file = await fileStmt.get([fileId, 'active']) as any
  if (!file) {
    return { success: false, message: '文件不存在或已删除' }
  }
  const rootStmt = await db.prepare('SELECT path FROM scan_roots WHERE enabled = 1')
  const root = await rootStmt.all() as any[]
  const allowed = root.some(r => file.path === r.path || file.path.startsWith(r.path + path.sep))
  if (!allowed) {
    return { success: false, message: '文件不在已注册扫描根目录下' }
  }
  spawn('open', ['-R', file.path], { detached: true }).unref()
  return { success: true, message: '已定位到 Finder' }
}
