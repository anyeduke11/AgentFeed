import { WebclipError, assertPublicUrl } from './ssrf.js'

// page.evaluate 回调运行于浏览器上下文；server tsconfig lib 无 DOM，仅声明以通过 Node 端编译
declare const window: any
declare const document: any

// Playwright 动态 import：未安装时不影响服务启动，调用时 fail-loud 报「未就绪」
let browser: any = null
let launching: Promise<any> | null = null
let idleTimer: NodeJS.Timeout | null = null
const IDLE_MS = 60 * 1000

export async function isReady(): Promise<boolean> {
  try {
    const mod: any = await import('playwright')
    return typeof mod.chromium.executablePath === 'function' && !!mod.chromium.executablePath()
  } catch { return false }
}

async function getBrowser(): Promise<any> {
  if (browser) return browser
  if (!launching) {
    launching = (async () => {
      let mod: any
      try { mod = await import('playwright') }
      catch { throw new WebclipError('notready', 'Playwright 未安装：cd server && npm i playwright && npx playwright install chromium') }
      return mod.chromium.launch({ headless: true })
    })()
  }
  try {
    browser = await launching
  } catch (e) {
    // 启动失败（如 chromium 缺失）时重置缓存，下次调用可重试，避免死等同一个 rejected promise
    launching = null
    browser = null
    throw e
  }
  return browser
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(async () => {
    const b = browser
    browser = null
    launching = null
    try { await b?.close() } catch { /* 已退出 */ }
  }, IDLE_MS)
}

/** 渲染目标页：DOM ready 后等 networkidle（8s 上限兜底）+ 滚动触发懒加载 */
export async function renderPage(url: string, timeoutMs = 30000): Promise<{ html: string; finalUrl: string }> {
  const b = await getBrowser()
  touchIdle()
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AgentFeed-WebClip/1.0'
  })
  try {
    // 逐请求 SSRF 拦截：导航、重定向目标、子资源统一过 DNS 私网校验，命中即 abort
    await context.route('**/*', async (route: any) => {
      try { await assertPublicUrl(route.request().url()) } catch { return route.abort() }
      route.continue()
    })
    const page = await context.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { /* 常驻连接页兜底放行 */ })
    } catch (e: any) {
      if (String(e?.message || '').includes('ERR_ABORTED')) throw new WebclipError('ssrf', '重定向或子资源指向私网/保留地址，已拦截')
      throw new WebclipError('fetch', `页面导航失败：${e?.message || e}`)
    }
    await page.evaluate(async () => {
      window.scrollTo(0, Math.floor(document.body.scrollHeight / 2))
      await new Promise(r => setTimeout(r, 1500))
    })
    const html = await page.content()
    return { html, finalUrl: page.url() }
  } finally {
    touchIdle()
    await context.close().catch(() => {})
  }
}
