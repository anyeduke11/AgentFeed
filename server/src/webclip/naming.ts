import fs from 'fs'
import path from 'path'

/** 标题转 slug：小写、空白/路径符折叠为 -，保留中英数字与连字符，截 40 字符 */
export function slugify(title: string): string {
  const s = (title || '').trim().toLowerCase()
    .replace(/[\s/_\\:.?*"'|#]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s.slice(0, 40) || 'untitled'
}

/** 文档对基名：YYYYMMDD-HHmmss-slug（md/html/assets 共享，磁盘层关联锚） */
export function buildDocBase(title: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${ts}-${slugify(title)}`
}

/** 同秒同名冲突时追加 -2/-3 序号，返回不与磁盘既有文档对冲突的基名 */
export function reserveBase(storageRoot: string, base: string): string {
  let cand = base
  let i = 2
  while (fs.existsSync(path.join(storageRoot, cand + '.md')) || fs.existsSync(path.join(storageRoot, cand + '.html'))) {
    cand = `${base}-${i++}`
  }
  return cand
}
