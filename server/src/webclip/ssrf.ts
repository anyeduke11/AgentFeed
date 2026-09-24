import dns from 'dns/promises'

/** webclip 统一业务错误：code 映射 HTTP 状态（router 层统一处理） */
export class WebclipError extends Error {
  constructor(public code: 'ssrf' | 'config' | 'dup' | 'fetch' | 'notready' | 'toolarge', message: string) {
    super(message)
    this.name = 'WebclipError'
  }
}

/** 解析后的 IP 是否私网/保留段（IPv4 常见段 + IPv6 环回/链路本地/ULA）；解析异常按私网处理（fail-closed，红线 1 同款思路） */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const low = ip.toLowerCase()
    return low === '::1' || low === '::' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')
      || low.startsWith('::ffff:127.') || low.startsWith('::ffff:10.') || low.startsWith('::ffff:192.168.')
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a >= 224) return true // 组播/保留段
  return false
}

/** URL 语法层校验：仅 http/https、不带凭据、非本机域名 */
export function checkUrlSyntax(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new WebclipError('ssrf', 'URL 格式非法') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebclipError('ssrf', `仅支持 http/https，收到 ${u.protocol}`)
  if (u.username || u.password) throw new WebclipError('ssrf', '不允许带 user:pass@ 凭据的 URL')
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) {
    throw new WebclipError('ssrf', '不允许访问本机/本地域名')
  }
  return u
}

/** 完整校验：语法 + DNS 解析逐 IP 拒私网；解析失败按拦截（fail-closed） */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = checkUrlSyntax(raw)
  let addrs: { address: string }[]
  try { addrs = await dns.lookup(u.hostname, { all: true }) } catch { throw new WebclipError('ssrf', `域名解析失败：${u.hostname}`) }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new WebclipError('ssrf', `目标解析到私网/保留地址（${a.address}），已拦截`)
  }
  return u
}
