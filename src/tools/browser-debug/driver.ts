/**
 * browser-debug/driver — Playwright-backed CDP driver (lazy, optional dep).
 */

import { shouldCaptureResponseBody, truncateResponseBody } from './log-capture.js'
import { PLAYWRIGHT_INSTALL_HINT, isBrowserMissingError, loadPlaywrightCore } from '../net/playwright-driver.js'

export interface DriverEvents {
  onConsole(level: string, text: string): void
  onRequestStart(
    requestId: string,
    method: string,
    url: string,
    resourceType?: string,
    headers?: Record<string, string>,
    postData?: string,
  ): void
  onResponse(requestId: string, status: number, resourceType?: string, headers?: Record<string, string>): void
  onRequestFailed(requestId: string, method: string, url: string, errorText?: string, resourceType?: string): void
  onResponseBody(requestId: string, body: string, contentType?: string): void
}

export type LoadState = 'load' | 'domcontentloaded' | 'networkidle'
export type ScrollTarget = 'top' | 'bottom'
export type StorageKind = 'local' | 'session'

export interface BrowserCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface ScreenshotOptions {
  /** Take a full-page screenshot instead of just the viewport. Default: false. */
  fullPage?: boolean
  /** Skip animation-disabling CSS injection and font-ready wait.
   *  Use for pages where the injected stylesheet itself causes a
   *  meaningful layout shift. Default: false. */
  raw?: boolean
  /** CSS selector to clip the screenshot to this element's bounding box. */
  element?: string
}

/** 实时帧流配置。帧率由页面**绘制**驱动——静态页不产帧（方案探针实测），
 *  所以连接瞬间另有 captureFrame() 补首帧，否则用户看到黑屏。 */
export interface ScreencastOptions {
  format?: 'jpeg' | 'png'
  /** jpeg 质量 0-100，默认 60。 */
  quality?: number
  maxWidth?: number
  maxHeight?: number
  /** 每 N 帧采样一次，默认 1。 */
  everyNthFrame?: number
}

/** 一帧实时画面。 */
export interface ScreencastFrame {
  /** base64 图像数据（不含 `data:` 前缀）。 */
  data: string
  width: number
  height: number
  /** 单调递增帧号——前端据此丢弃过期帧（背压）。 */
  seq: number
}

/** 反向输入事件（面板 → CDP Input 域）。坐标是视口 CSS 像素。 */
export interface BrowserInputEvent {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'char'
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle' | 'none'
  clickCount?: number
  deltaX?: number
  deltaY?: number
  key?: string
  code?: string
  text?: string
  /** CDP modifiers 位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift。 */
  modifiers?: number
}

export interface BrowserDebugDriver {
  goto(url: string, signal?: AbortSignal): Promise<void>
  evaluate(expression: string): Promise<string>
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>
  snapshot(selector?: string): Promise<string>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  press(selector: string | undefined, key: string): Promise<void>
  selectOption(selector: string, value: string): Promise<string[]>
  hover(selector: string): Promise<void>
  scroll(selector: string | undefined, to: ScrollTarget): Promise<void>
  waitForSelector(selector: string, timeoutMs?: number, signal?: AbortSignal): Promise<void>
  waitForLoadState(state: LoadState, timeoutMs?: number, signal?: AbortSignal): Promise<void>
  reload(signal?: AbortSignal): Promise<void>
  goBack(signal?: AbortSignal): Promise<boolean>
  goForward(signal?: AbortSignal): Promise<boolean>
  cookies(urlFilter?: string): Promise<BrowserCookie[]>
  storage(kind: StorageKind): Promise<Record<string, string>>
  addCookie(cookie: { name: string; value: string; url?: string; domain?: string; path?: string }): Promise<void>
  clearCookies(): Promise<void>
  setStorage(kind: StorageKind, key: string, value: string): Promise<void>
  clearStorage(kind: StorageKind): Promise<void>
  /** Resize the active page. Responsive breakpoints are a first-class part of
   *  a UI change, so verification has to be able to move the window — a bug
   *  that only shows at one width is invisible from a single fixed size. */
  setViewport(width: number, height: number): Promise<void>
  /** Current page size, so a screenshot can say what it is a screenshot of. */
  viewportSize(): { width: number; height: number } | null
  currentUrl(): string
  /** URLs of all open pages/tabs in the context (active page last). */
  pageUrls(): string[]
  bringToFront(): Promise<void>
  close(): Promise<void>
  /**
   * 实时帧流能力——**可选**：仅 Chromium 系 driver 提供，测试桩/假 driver 可不实现
   * （调用方先做能力探测再使用）。启动后每次页面绘制回调一帧。
   */
  startScreencast?(opts: ScreencastOptions, onFrame: (frame: ScreencastFrame) => void): Promise<void>
  stopScreencast?(): Promise<void>
  /** 主动取一张当前画面——用于连接瞬间补首帧（静态页不产帧）。 */
  captureFrame?(opts?: ScreencastOptions): Promise<ScreencastFrame | null>
  /** 反向注入鼠标/键盘事件。 */
  dispatchInput?(evt: BrowserInputEvent): Promise<void>
}

/** Viewport bounds. The lower bound keeps a resize from producing a degenerate
 *  page that no real device would show; the upper bound keeps a screenshot from
 *  turning into a megapixel payload on the vision channel. */
export const MIN_VIEWPORT = 240
export const MAX_VIEWPORT = 3840
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const

/**
 * 防渲染节流开关。被遮挡/最小化/后台的窗口会被 Chromium 降频甚至停绘，screencast
 * 随之停帧——对内嵌实时视图的现场表现就是「画面卡住不刷新」。这几个开关让不可见
 * 窗口保持全速渲染。（2026-09-21 探针实测本机 headed/headless 均能收帧；此组参数
 * 用于消除「窗口被遮挡即停帧」这一现场风险。）
 */
const ANTI_THROTTLE_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
]

export interface DriverLaunchOptions {
  headless: boolean
  userDataDir: string
  events: DriverEvents
  connectUrl?: string
  /** Initial page size; defaults to DEFAULT_VIEWPORT. */
  viewport?: { width: number; height: number }
}

export type BrowserDebugDriverFactory = (opts: DriverLaunchOptions) => Promise<BrowserDebugDriver>

interface PwRequest {
  method(): string
  url(): string
  resourceType(): string
  failure(): { errorText: string } | null
  headers(): Record<string, string>
  postData(): string | null
}
interface PwResponse {
  status(): number
  request(): PwRequest
  headers(): Record<string, string>
  text(): Promise<string>
}
interface PwConsoleMessage {
  type(): string
  text(): string
}
interface PwKeyboard {
  press(key: string): Promise<void>
}
interface PwPage {
  goto(url: string, opts: Record<string, unknown>): Promise<unknown>
  evaluate(expr: string): Promise<unknown>
  screenshot(opts: Record<string, unknown>): Promise<Buffer>
  click(selector: string, opts: Record<string, unknown>): Promise<void>
  fill(selector: string, text: string, opts: Record<string, unknown>): Promise<void>
  press(selector: string, key: string, opts: Record<string, unknown>): Promise<void>
  selectOption(selector: string, value: string, opts: Record<string, unknown>): Promise<string[]>
  hover(selector: string, opts: Record<string, unknown>): Promise<void>
  textContent(selector: string, opts?: Record<string, unknown>): Promise<string | null>
  waitForSelector(selector: string, opts: Record<string, unknown>): Promise<unknown>
  waitForLoadState(state: string, opts: Record<string, unknown>): Promise<void>
  reload(opts: Record<string, unknown>): Promise<unknown>
  goBack(opts: Record<string, unknown>): Promise<unknown>
  goForward(opts: Record<string, unknown>): Promise<unknown>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  viewportSize(): { width: number; height: number } | null
  keyboard: PwKeyboard
  url(): string
  bringToFront(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
}
/** Playwright CDPSession 的最小面——只声明本模块用到的三件事。 */
interface PwCDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, handler: (arg: never) => void): void
  detach(): Promise<void>
}
interface PwContext {
  pages(): PwPage[]
  newPage(): Promise<PwPage>
  close(): Promise<void>
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>
  addCookies(cookies: unknown[]): Promise<void>
  clearCookies(): Promise<void>
  on(event: string, handler: (arg: never) => void): void
  newCDPSession(page: PwPage): Promise<PwCDPSession>
}
interface PwBrowser {
  contexts(): PwContext[]
  close(): Promise<void>
}
interface PwChromium {
  launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<PwContext>
  connectOverCDP(endpointUrl: string): Promise<PwBrowser>
}

async function loadPlaywright(): Promise<{ chromium: PwChromium }> {
  return (await loadPlaywrightCore()) as never
}

function stringifyEvalResult(result: unknown): string {
  if (result === undefined) return 'undefined'
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function mergeAbortSignal(timeoutMs: number, signal?: AbortSignal): { signal?: AbortSignal; cleanup?: () => void } {
  if (!signal) return {}
  if (signal.aborted) return { signal }
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

async function captureResponseBody(res: PwResponse, requestId: string, events: DriverEvents): Promise<void> {
  try {
    const headers = res.headers()
    const contentType = headers['content-type'] ?? headers['Content-Type']
    const text = await res.text()
    const { body } = truncateResponseBody(text)
    events.onResponseBody(requestId, body, contentType)
  } catch {
    /* binary or unreadable body — skip */
  }
}

/** Wire Playwright page events into our DriverEvents sink. The id counter is
 *  shared across all pages of a session so popup/tab requests don't collide
 *  with the main page's request ids (r1, r2, …). */
function wireEvents(page: PwPage, events: DriverEvents, counter: { seq: number }): void {
  const ids = new WeakMap<PwRequest, string>()
  const idFor = (req: PwRequest): string => {
    let id = ids.get(req)
    if (!id) {
      id = `r${++counter.seq}`
      ids.set(req, id)
    }
    return id
  }

  page.on('console', ((msg: PwConsoleMessage) => {
    try {
      events.onConsole(msg.type(), msg.text())
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('pageerror', ((err: Error) => {
    events.onConsole('error', err?.message ?? String(err))
  }) as never)

  page.on('request', ((req: PwRequest) => {
    try {
      let headers: Record<string, string> | undefined
      let postData: string | undefined
      try { headers = req.headers() } catch { /* ignore */ }
      try { postData = req.postData() ?? undefined } catch { /* ignore */ }
      events.onRequestStart(idFor(req), req.method(), req.url(), req.resourceType(), headers, postData)
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('response', ((res: PwResponse) => {
    try {
      const req = res.request()
      const id = idFor(req)
      const resourceType = req.resourceType()
      const status = res.status()
      let headers: Record<string, string> | undefined
      try { headers = res.headers() } catch { /* ignore */ }
      events.onResponse(id, status, resourceType, headers)
      if (shouldCaptureResponseBody(resourceType, status)) {
        void captureResponseBody(res, id, events)
      }
    } catch {
      /* ignore */
    }
  }) as never)

  page.on('requestfailed', ((req: PwRequest) => {
    try {
      events.onRequestFailed(idFor(req), req.method(), req.url(), req.failure()?.errorText, req.resourceType())
    } catch {
      /* ignore */
    }
  }) as never)
}

export interface PageTracker {
  getActivePage(): PwPage
  pageUrls(): string[]
}

/**
 * Track every page/tab in a context. The active page is the most recently
 * opened one (so OAuth popups become the action target); when the active page
 * closes we fall back to the last remaining open page (back to the app after
 * the login popup closes). Every page's console/network is wired to the sink.
 */
export function attachPageTracker(
  context: PwContext,
  events: DriverEvents,
  initial: PwPage,
): PageTracker {
  const counter = { seq: 0 }
  let active = initial
  const known = new WeakSet<PwPage>()
  const track = (page: PwPage): void => {
    if (known.has(page)) return
    known.add(page)
    wireEvents(page, events, counter)
    active = page
    page.on('close', (() => {
      if (active !== page) return
      const open = context.pages().filter((p) => p !== page)
      if (open.length > 0) active = open[open.length - 1]!
    }) as never)
  }
  track(initial)
  context.on('page', ((page: PwPage) => {
    try { track(page) } catch { /* ignore */ }
  }) as never)
  return {
    getActivePage: () => active,
    pageUrls: () => context.pages().map((p) => p.url()),
  }
}

function buildDriver(
  getPage: () => PwPage,
  context: PwContext,
  pageUrls: () => string[],
  closeFn: () => Promise<void>,
): BrowserDebugDriver {
  // ── 实时帧流（可选能力）────────────────────────────────────────────────
  // 一个 driver 同时只跑一条 screencast；CDP session 惰性建立并绑定 active page，
  // page 变化（OAuth 弹窗接管）时下次 start 重新绑定。
  let cdp: PwCDPSession | null = null
  let cdpPage: PwPage | null = null
  let frameSeq = 0
  let frameSink: ((frame: ScreencastFrame) => void) | null = null

  const detachCdp = async (): Promise<void> => {
    const cur = cdp
    cdp = null
    cdpPage = null
    if (!cur) return
    try {
      await cur.detach()
    } catch {
      /* 已断开——detach 失败不影响后续重建 */
    }
  }

  /** 绑定到当前 active page；page 换了就重建（旧 session 先 detach）。 */
  const ensureCdp = async (): Promise<PwCDPSession> => {
    const page = getPage()
    if (cdp && cdpPage === page) return cdp
    await detachCdp()
    cdp = await context.newCDPSession(page)
    cdpPage = page
    return cdp
  }

  return {
    goto: async (url, signal) => {
      const page = getPage()
      const merged = mergeAbortSignal(30_000, signal)
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    evaluate: async (expression) => stringifyEvalResult(await getPage().evaluate(expression)),
    screenshot: async (opts) => {
      const page = getPage()
      const fullPage = opts?.fullPage ?? false
      const raw = opts?.raw ?? false

      if (!raw) {
        // Inject animation-disabling CSS so the frame is visually stable
        // before we capture it. Without this, mid-transition states produce
        // diff noise that look like UI changes.
        await page.evaluate(`
          (() => {
            const el = document.createElement('style');
            el.id = '__rivet_screenshot';
            el.textContent = '*{animation:none!important;transition:none!important;animation-duration:0s!important;transition-duration:0s!important}';
            document.head.appendChild(el);
          })()
        `)
        // Wait for web fonts to finish loading so text isn't captured in a
        // fallback face (rendering-diff false positive).
        try {
          await page.evaluate('document.fonts.ready')
        } catch { /* font API unavailable (e.g. about:blank) */ }
      }

      const pwOpts: Record<string, unknown> = {}
      if (fullPage) pwOpts.fullPage = true

      try {
        if (opts?.element) {
          const clip = await page.evaluate(`
            (() => {
              const el = document.querySelector(${JSON.stringify(opts.element)});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()
          `)
          if (!clip) throw new Error(`元素 "${opts.element}" 未找到。`)
          pwOpts.clip = clip
        }
        return await page.screenshot(pwOpts)
      } finally {
        if (!raw) {
          try {
            await page.evaluate('document.getElementById("__rivet_screenshot")?.remove()')
          } catch { /* ignore cleanup failure */ }
        }
      }
    },
    snapshot: async (selector) => {
      const page = getPage()
      if (selector) return (await page.textContent(selector, { timeout: 10_000 })) ?? ''
      return String(await page.evaluate('document.body?.innerText ?? ""'))
    },
    click: (selector) => getPage().click(selector, { timeout: 10_000 }),
    type: (selector, text) => getPage().fill(selector, text, { timeout: 10_000 }),
    press: async (selector, key) => {
      const page = getPage()
      if (selector) await page.press(selector, key, { timeout: 10_000 })
      else await page.keyboard.press(key)
    },
    selectOption: (selector, value) => getPage().selectOption(selector, value, { timeout: 10_000 }),
    hover: (selector) => getPage().hover(selector, { timeout: 10_000 }),
    scroll: async (selector, to) => {
      const page = getPage()
      if (selector) {
        const sel = JSON.stringify(selector)
        await page.evaluate(
          `document.querySelector(${sel})?.scrollIntoView({ block: 'center', inline: 'nearest' })`,
        )
      } else if (to === 'top') {
        await page.evaluate('window.scrollTo(0, 0)')
      } else {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
      }
    },
    waitForSelector: async (selector, timeoutMs = 10_000, signal) => {
      const merged = mergeAbortSignal(timeoutMs, signal)
      try {
        await getPage().waitForSelector(selector, { state: 'visible', timeout: timeoutMs, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    waitForLoadState: async (state, timeoutMs = 10_000, signal) => {
      const merged = mergeAbortSignal(timeoutMs, signal)
      try {
        await getPage().waitForLoadState(state, { timeout: timeoutMs, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    reload: async (signal) => {
      const merged = mergeAbortSignal(30_000, signal)
      try {
        await getPage().reload({ waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
      } finally {
        merged.cleanup?.()
      }
    },
    goBack: async (signal) => {
      const merged = mergeAbortSignal(30_000, signal)
      try {
        const res = await getPage().goBack({ waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
        return res !== null
      } finally {
        merged.cleanup?.()
      }
    },
    goForward: async (signal) => {
      const merged = mergeAbortSignal(30_000, signal)
      try {
        const res = await getPage().goForward({ waitUntil: 'domcontentloaded', timeout: 30_000, signal: merged.signal })
        return res !== null
      } finally {
        merged.cleanup?.()
      }
    },
    cookies: async (urlFilter) => {
      const all = await context.cookies()
      if (!urlFilter) return all
      return all.filter((c) => `${c.domain ?? ''}${c.path ?? ''} ${c.name}`.includes(urlFilter))
    },
    storage: async (kind) => {
      const varName = kind === 'session' ? 'sessionStorage' : 'localStorage'
      const expr = `(() => { const s = ${varName}; const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k != null) o[k] = s.getItem(k); } return o; })()`
      const result = await getPage().evaluate(expr)
      return result && typeof result === 'object' ? (result as Record<string, string>) : {}
    },
    addCookie: async (cookie) => {
      const c: Record<string, unknown> = { name: cookie.name, value: cookie.value }
      if (cookie.url) c.url = cookie.url
      if (cookie.domain) c.domain = cookie.domain
      if (cookie.path) c.path = cookie.path
      await context.addCookies([c])
    },
    clearCookies: () => context.clearCookies(),
    setStorage: async (kind, key, value) => {
      const varName = kind === 'session' ? 'sessionStorage' : 'localStorage'
      await getPage().evaluate(`${varName}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
    },
    clearStorage: async (kind) => {
      const varName = kind === 'session' ? 'sessionStorage' : 'localStorage'
      await getPage().evaluate(`${varName}.clear()`)
    },
    setViewport: async (width, height) => {
      await getPage().setViewportSize({ width, height })
    },
    viewportSize: () => getPage().viewportSize(),
    currentUrl: () => getPage().url(),
    pageUrls,
    bringToFront: () => getPage().bringToFront(),
    close: closeFn,
    startScreencast: async (opts, onFrame) => {
      const session = await ensureCdp()
      frameSink = onFrame
      session.on('Page.screencastFrame', ((params: {
        data?: string
        sessionId?: number
        metadata?: { deviceWidth?: number; deviceHeight?: number }
      }) => {
        frameSeq += 1
        const frame: ScreencastFrame = {
          data: params.data ?? '',
          width: params.metadata?.deviceWidth ?? 0,
          height: params.metadata?.deviceHeight ?? 0,
          seq: frameSeq,
        }
        try {
          frameSink?.(frame)
        } catch {
          /* 订阅方抛错不得打断推流 */
        }
        // ack 必须回：CDP 收到 ack 前不推下一帧，漏 ack 的表现是「画面冻住」。
        if (params.sessionId != null) {
          void session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
        }
      }) as never)
      await session.send('Page.startScreencast', {
        format: opts.format ?? 'jpeg',
        quality: opts.quality ?? 60,
        maxWidth: opts.maxWidth ?? DEFAULT_VIEWPORT.width,
        maxHeight: opts.maxHeight ?? DEFAULT_VIEWPORT.height,
        everyNthFrame: opts.everyNthFrame ?? 1,
      })
    },
    stopScreencast: async () => {
      frameSink = null
      if (cdp) {
        try {
          await cdp.send('Page.stopScreencast')
        } catch {
          /* 未在推流时 stop 会抛——忽略 */
        }
      }
      await detachCdp()
    },
    captureFrame: async (opts) => {
      const session = await ensureCdp()
      try {
        const res = (await session.send('Page.captureScreenshot', {
          format: opts?.format ?? 'jpeg',
          quality: opts?.quality ?? 60,
        })) as { data?: string } | undefined
        if (!res?.data) return null
        const size = getPage().viewportSize()
        frameSeq += 1
        return { data: res.data, width: size?.width ?? 0, height: size?.height ?? 0, seq: frameSeq }
      } catch {
        return null
      }
    },
    dispatchInput: async (evt) => {
      const session = await ensureCdp()
      const params: Record<string, unknown> = {}
      for (const k of ['x', 'y', 'button', 'clickCount', 'deltaX', 'deltaY', 'key', 'code', 'text', 'modifiers'] as const) {
        const v = evt[k]
        if (v != null) params[k] = v
      }
      const method = evt.type.startsWith('mouse') ? 'Input.dispatchMouseEvent' : 'Input.dispatchKeyEvent'
      await session.send(method, { type: evt.type, ...params })
    },
  }
}

export const playwrightDriverFactory: BrowserDebugDriverFactory = async (opts) => {
  const mod = await loadPlaywright()
  // 安装提示只挂在真正"浏览器可执行文件缺失"的启动失败上（与 net/playwright-driver
  // 的 launchChromium 同口径）。挂在模块加载失败上会把排查引向错误方向。
  let context: PwContext
  try {
    context = await mod.chromium.launchPersistentContext(opts.userDataDir, {
      headless: opts.headless,
      viewport: opts.viewport ?? DEFAULT_VIEWPORT,
      args: ANTI_THROTTLE_ARGS,
    })
  } catch (err) {
    if (isBrowserMissingError(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`${PLAYWRIGHT_INSTALL_HINT}\n（原始错误：${msg.split('\n')[0]}）`)
    }
    throw err
  }
  const existing = context.pages()
  const page = existing.length > 0 ? existing[0]! : await context.newPage()
  const tracker = attachPageTracker(context, opts.events, page)
  return buildDriver(tracker.getActivePage, context, tracker.pageUrls, () => context.close())
}

export const playwrightConnectFactory: BrowserDebugDriverFactory = async (opts) => {
  if (!opts.connectUrl) {
    throw new Error('connectUrl is required for CDP connect mode')
  }
  const mod = await loadPlaywright()
  const browser = await mod.chromium.connectOverCDP(opts.connectUrl)
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close()
    throw new Error(`No browser context found at ${opts.connectUrl}. Is Chrome running with --remote-debugging-port?`)
  }
  const existing = context.pages()
  const page = existing.length > 0 ? existing[0]! : await context.newPage()
  // Only resize when asked: an adopted browser is the user's own window, and
  // silently reshaping it would be a surprising side effect of connecting.
  if (opts.viewport) await page.setViewportSize(opts.viewport)
  const tracker = attachPageTracker(context, opts.events, page)
  return buildDriver(tracker.getActivePage, context, tracker.pageUrls, () => browser.close())
}

export const defaultDriverFactory: BrowserDebugDriverFactory = async (opts) =>
  opts.connectUrl ? playwrightConnectFactory(opts) : playwrightDriverFactory(opts)
