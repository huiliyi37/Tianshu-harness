/**
 * browser — headless browser verification tool (N4).
 *
 * New attack surface, so it is locked down hard:
 *  - requiresApproval() ALWAYS true — every action goes through the N2 approval
 *    gate (a human confirms each navigation).
 *  - URL host must be on a fail-closed allowlist (empty allowlist = deny all).
 *  - Every request (main document + redirects + iframes + subresources) is
 *    re-checked per request via a page.route interceptor: host on the allowlist,
 *    and — for suffix-matched subdomains — not a private/reserved address.
 *    Checking only the initial URL lets an allowlisted host 302 / <iframe> /
 *    page fetch() straight into 127.0.0.1 or the cloud metadata service
 *    (issue #213).
 *  - 显式列名（精确匹配）的主机是**指名信任**：本地/内网模型服务（127.0.0.1:11434、
 *    192.168.x.x、gpu-box.local 之类）不该被私网预检误杀，故跳过预检；子域后缀匹配
 *    是**继承的信任**，仍做私网预检以防被攻陷的子域把请求带去内网。未列名的私网
 *    目标一律照拦——#213 的核心防护（跳内网 IP 被挡）不依赖预检那一步。
 *  - screenshots are persisted as `screenshot`-kind Artifacts (base64 PNG) so the
 *    desktop browser panel can render them.
 *
 * The Playwright dependency is loaded lazily through an injectable driver factory
 * so the tool ships without forcing the browser binaries on every install, and so
 * the security logic is unit-testable with a fake driver.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { resolveAndAssertPublic, SSRFError, type LookupFn } from './net/ssrf.js'
import type { PwRouteHandler } from './net/playwright-driver.js'

export interface BrowserDriver {
  goto(url: string): Promise<void>
  screenshot(): Promise<Buffer>
  textContent(selector?: string): Promise<string>
  click(selector: string): Promise<void>
  /**
   * 逐请求拦截（重定向 / iframe / 子资源）——实现须转发到 page.route。
   * 只校验初始 URL 会被 30x / <iframe> / 页面内 fetch() 打穿到内网（#213）。
   */
  route(pattern: string, handler: PwRouteHandler): Promise<void>
  close(): Promise<void>
}

export type BrowserDriverFactory = () => Promise<BrowserDriver>

export interface BrowserToolOptions {
  /** Builds a live browser session. Defaults to headless Playwright (lazy). */
  driverFactory?: BrowserDriverFactory
  /** Returns the allowed host list. Empty ⇒ deny all (fail-closed). */
  allowlist?: () => string[]
  /** 逐请求 SSRF 预检的 DNS 解析（测试注入；默认 node:dns/promises）。 */
  lookup?: LookupFn
  enabled?: boolean
}

// 导航/截图结果前缀已抽至 output-markers.ts（零依赖叶子，桌面端共享）；
// 此处 re-export 保持内核调用方不变。
export { BROWSER_NAVIGATED_PREFIX, BROWSER_SCREENSHOT_OF_PREFIX } from './output-markers.js'
import { BROWSER_NAVIGATED_PREFIX, BROWSER_SCREENSHOT_OF_PREFIX } from './output-markers.js'
import { PLAYWRIGHT_INSTALL_HINT, PLAYWRIGHT_CORE_INSTALL_HINT } from './net/playwright-driver.js'

/** Default allowlist: comma-separated hosts in RIVET_BROWSER_ALLOWLIST. */
function envAllowlist(): string[] {
  return (process.env.RIVET_BROWSER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false // fail-closed
  const h = host.toLowerCase()
  return allowlist.some((entry) => h === entry || h.endsWith('.' + entry))
}

/**
 * 该 host 是否被 allowlist **显式列名**（精确匹配，与后缀匹配区分）。
 *
 * 显式列名 = 用户对该主机的指名信任：它解析到回环/内网地址也要放行——内网跑本地
 * 模型（Ollama / vLLM / LM Studio 等）是本工具的正当场景，#213 的修复不该把它们
 * 一起误杀。后缀匹配（`app.example.com` 命中 `example.com`）是**继承的信任**，
 * 子域可能由他人控制，那部分仍走私网预检。
 */
export function isHostExplicitlyListed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase()
  return allowlist.some((entry) => h === entry)
}

/** 单请求判定结果（reason 供测试/遥测使用）。 */
export interface BrowserRequestDecision {
  allow: boolean
  reason:
    | 'ok'
    | 'local-scheme'
    | 'unsupported-scheme'
    | 'not-allowlisted'
    | 'private-address'
    | 'dns-failure'
  hostname?: string
}

/** data:/blob:/about: 不产生网络请求，放行；其余非 http(s) scheme 一律阻断（同 render-fetch）。 */
function isLocalScheme(protocol: string): boolean {
  return protocol === 'data:' || protocol === 'blob:' || protocol === 'about:'
}

/**
 * 对**单个请求**做与初始 URL 同一套判定：scheme 白名单 → allowlist 主机 →
 * （仅子域）私网/保留地址预检（复用 net/ssrf 的 resolveAndAssertPublic）。
 * DNS 经 lookup 注入，因此可脱离 Playwright 单测。不合规一律 fail-closed。
 *
 * 显式列名的主机跳过预检：那是指名信任（内网/回环的本地模型服务是正当目标），
 * 因此这些请求连 lookup 都不会被调用。
 */
export async function evaluateBrowserRequest(
  reqUrl: string,
  allowlist: string[],
  lookup: LookupFn,
): Promise<BrowserRequestDecision> {
  let parsed: URL
  try {
    parsed = new URL(reqUrl)
  } catch {
    return { allow: false, reason: 'unsupported-scheme' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return isLocalScheme(parsed.protocol)
      ? { allow: true, reason: 'local-scheme' }
      : { allow: false, reason: 'unsupported-scheme' }
  }
  const hostname = parsed.hostname
  if (!isHostAllowed(hostname, allowlist)) {
    return { allow: false, reason: 'not-allowlisted', hostname }
  }
  // 显式列名 = 指名信任：不做私网预检——内网/回环的本地服务（模型端点等）不受误杀。
  if (isHostExplicitlyListed(hostname, allowlist)) {
    return { allow: true, reason: 'ok', hostname }
  }
  // 子域（后缀匹配）= 继承的信任：保留私网预检，防被攻陷/劫持的子域把请求带去内网。
  try {
    await resolveAndAssertPublic(hostname, lookup)
    return { allow: true, reason: 'ok', hostname }
  } catch (err) {
    // 私网目标或 DNS 解析失败一律阻断（fail-closed）
    return {
      allow: false,
      reason: err instanceof SSRFError ? 'private-address' : 'dns-failure',
      hostname,
    }
  }
}

/**
 * 构造 page.route 处理器：逐请求判定，合规放行、不合规 abort。
 * 与 render-fetch 的第二层拦截同构——只是把「广告域名」换成了「allowlist」。
 */
export function createBrowserRequestGuard(
  allowlist: string[],
  lookup: LookupFn,
  onBlocked?: (decision: BrowserRequestDecision) => void,
): PwRouteHandler {
  return async (route, request) => {
    const decision = await evaluateBrowserRequest(request.url(), allowlist, lookup)
    if (decision.allow) {
      await route.continue()
    } else {
      onBlocked?.(decision)
      await route.abort()
    }
  }
}

async function playwrightDriver(): Promise<BrowserDriver> {
  // Dynamic specifier via a variable so tsc doesn't try to resolve the optional
  // 'playwright-core' types at build time.
  const specifier = 'playwright-core'
  let mod: { chromium: { launch: (o: { headless: boolean }) => Promise<unknown> } }
  try {
    mod = (await import(specifier)) as never
  } catch {
    throw new Error(`未安装 playwright-core。${PLAYWRIGHT_CORE_INSTALL_HINT}`)
  }
  const browser = (await mod.chromium.launch({ headless: true })) as {
    newPage: () => Promise<never>
    close: () => Promise<void>
  }
  const page = (await browser.newPage()) as {
    goto: (u: string, o: Record<string, unknown>) => Promise<unknown>
    screenshot: (o: Record<string, unknown>) => Promise<Buffer>
    textContent: (s: string) => Promise<string | null>
    evaluate: (fn: string) => Promise<string>
    click: (s: string) => Promise<void>
    route: (pattern: string, handler: PwRouteHandler) => Promise<void>
  }
  return {
    goto: async (url) => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }) },
    screenshot: () => page.screenshot({ fullPage: true }),
    textContent: async (selector) =>
      selector
        ? (await page.textContent(selector)) ?? ''
        : await page.evaluate('document.body.innerText'),
    click: (selector) => page.click(selector),
    route: (pattern, handler) => page.route(pattern, handler),
    close: () => browser.close(),
  }
}

type BrowserAction = 'screenshot' | 'text' | 'click'

export function createBrowserTool(options: BrowserToolOptions = {}): Tool {
  const driverFactory = options.driverFactory ?? playwrightDriver
  const allowlist = options.allowlist ?? envAllowlist
  const lookup: LookupFn = options.lookup ?? ((hostname) => dnsLookup(hostname))
  const enabled = options.enabled ?? false

  return {
    definition: {
      name: 'browser',
      description: `驱动无头浏览器验证 Web UI。导航到许可名单中的 URL 并截图、提取文本或点击元素。
始终需要显式人工审批，且目标主机必须在配置的许可名单中（fail-closed）。截图保存为可查看的 artifact。`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['screenshot', 'text', 'click'], description: '导航后执行的操作。' },
          url: { type: 'string', description: '要导航到的 URL（主机必须在许可名单中）。' },
          selector: { type: 'string', description: 'text/click 操作的 CSS 选择器。' },
        },
        required: ['action', 'url'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action as BrowserAction
      const rawUrl = params.input.url as string
      const selector = params.input.selector as string | undefined

      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        return { content: `无效 URL：${rawUrl}`, isError: true }
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { content: `不支持的协议：${url.protocol}。仅允许 http/https。`, isError: true }
      }

      const list = allowlist()
      if (!isHostAllowed(url.hostname, list)) {
        return {
          content:
            `browser 已拦截：主机 "${url.hostname}" 不在许可名单中（fail-closed）。` +
            (list.length === 0
              ? '当前未配置任何许可主机——请设置 RIVET_BROWSER_ALLOWLIST。'
              : `已允许：${list.join(', ')}。`),
          isError: true,
        }
      }

      let driver: BrowserDriver | null = null
      try {
        driver = await driverFactory()
        if (typeof driver.route !== 'function') {
          return {
            content:
              'browser 已拒绝：浏览器驱动未提供逐请求拦截（route）——无法拦截重定向/iframe/子资源的内网访问（fail-closed）。',
            isError: true,
          }
        }
        // 逐请求防护（#213）：必须在 goto 之前挂上，覆盖主文档 + 重定向 + iframe + 子资源。
        let blockedRequests = 0
        const blockedSuffix = (): string =>
          blockedRequests > 0 ? `（已拦截 ${blockedRequests} 个不合规子请求）` : ''
        await driver.route('**/*', createBrowserRequestGuard(list, lookup, () => { blockedRequests += 1 }))
        await driver.goto(rawUrl)

        if (action === 'click') {
          if (!selector) return { content: 'click 需要 "selector"。', isError: true }
          await driver.click(selector)
          return { content: `已在 ${rawUrl} 点击 ${selector}${blockedSuffix()}` }
        }

        if (action === 'text') {
          const text = await driver.textContent(selector)
          const trimmed = text.slice(0, 20_000)
          return { content: `来自 ${rawUrl}${selector ? `（${selector}）` : ''} 的文本：\n\n${trimmed}${blockedSuffix()}` }
        }

        // screenshot
        const png = await driver.screenshot()
        const base64 = png.toString('base64')
        let artifactId: string | undefined
        if (params.artifactStore) {
          artifactId = await params.artifactStore.save({
            tool: 'browser_screenshot',
            target: `${url.hostname}-screenshot.png`,
            rawContent: base64,
            summary: `Screenshot of ${rawUrl}`,
            sections: [],
          })
        }
        return {
          content:
            `${BROWSER_SCREENSHOT_OF_PREFIX} ${rawUrl}` +
            (artifactId ? ` → artifact ${artifactId}` : '') +
            blockedSuffix(),
          rawPath: undefined,
        }
      } catch (err) {
        return { content: `browser 失败：${(err as Error).message}`, isError: true }
      } finally {
        try { await driver?.close() } catch { /* ignore */ }
      }
    },

    requiresApproval: () => true, // forced — every browser action needs a human
    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: () => 60_000,
  }
}

export const BROWSER_TOOL: Tool = createBrowserTool({ enabled: true })
