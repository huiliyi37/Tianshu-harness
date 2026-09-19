import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBrowserRequestGuard,
  createBrowserTool,
  evaluateBrowserRequest,
  isHostAllowed,
  type BrowserDriver,
} from '../browser.js'
import type { PwRequest, PwRoute, PwRouteHandler } from '../net/playwright-driver.js'
import type { LookupFn } from '../net/ssrf.js'
import type { ToolCallParams } from '../types.js'
import type { SaveArtifactInput } from '../../artifact/store.js'

/** 直连测试用的假 DNS：除显式私网外一律解析为公网地址。 */
const PUBLIC_LOOKUP: LookupFn = async () => ({ address: '93.184.216.34', family: 4 })

class FakeDriver implements BrowserDriver {
  static last?: FakeDriver
  gotoUrl?: string
  closed = false
  routePattern?: string
  handler?: PwRouteHandler
  continued: string[] = []
  aborted: string[] = []
  constructor() { FakeDriver.last = this }
  async goto(url: string) { this.gotoUrl = url }
  async screenshot() { return Buffer.from('PNGDATA') }
  async textContent(sel?: string) { return sel ? `text:${sel}` : 'body text' }
  async click() {}
  async route(pattern: string, handler: PwRouteHandler) { this.routePattern = pattern; this.handler = handler }
  async close() { this.closed = true }
  /** 让一条请求走一遍已安装的 guard，返回放行 / 拦截。 */
  async dispatch(url: string): Promise<'continue' | 'abort'> {
    const route: PwRoute = {
      continue: async () => { this.continued.push(url) },
      abort: async () => { this.aborted.push(url) },
    }
    const request: PwRequest = { url: () => url }
    assert.ok(this.handler, 'route guard must be installed before requests are dispatched')
    await this.handler(route, request)
    return this.aborted.includes(url) ? 'abort' : 'continue'
  }
}

class FakeArtifactStore {
  saved: SaveArtifactInput[] = []
  async save(input: SaveArtifactInput): Promise<string> {
    this.saved.push(input)
    return `browser_screenshot:${this.saved.length}`
  }
}

function params(input: Record<string, unknown>, store?: FakeArtifactStore): ToolCallParams {
  return { input, toolUseId: 't1', cwd: '/work', artifactStore: store as never }
}

function guardedTool(opts: { allowlist: string[]; lookup?: LookupFn }): ReturnType<typeof createBrowserTool> {
  return createBrowserTool({
    enabled: true,
    allowlist: () => opts.allowlist,
    lookup: opts.lookup ?? PUBLIC_LOOKUP,
    driverFactory: async () => new FakeDriver(),
  })
}

test('isHostAllowed is fail-closed and supports subdomain suffix', () => {
  assert.equal(isHostAllowed('example.com', []), false)
  assert.equal(isHostAllowed('example.com', ['example.com']), true)
  assert.equal(isHostAllowed('app.example.com', ['example.com']), true)
  assert.equal(isHostAllowed('evil.com', ['example.com']), false)
  assert.equal(isHostAllowed('notexample.com', ['example.com']), false)
})

test('browser action ALWAYS requires approval', () => {
  const tool = createBrowserTool({ enabled: true, allowlist: () => ['example.com'] })
  assert.equal(tool.requiresApproval(params({ action: 'screenshot', url: 'https://example.com' })), true)
})

test('navigation to a non-allowlisted host is rejected (fail-closed), driver never built', async () => {
  let built = false
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () => { built = true; return new FakeDriver() },
  })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://evil.com/x' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /不在许可名单/)
  assert.equal(built, false, 'must not launch a browser for a blocked host')
})

test('empty allowlist denies everything', async () => {
  const tool = createBrowserTool({ enabled: true, allowlist: () => [] })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://example.com' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /未配置任何许可主机/)
})

test('screenshot of an allowlisted host saves a screenshot artifact', async () => {
  const store = new FakeArtifactStore()
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () => new FakeDriver(),
  })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://example.com/page' }, store))
  assert.equal(res.isError, undefined)
  assert.equal(store.saved.length, 1)
  assert.equal(store.saved[0]!.tool, 'browser_screenshot')
  assert.match(store.saved[0]!.target, /\.png$/)
  assert.equal(store.saved[0]!.rawContent, Buffer.from('PNGDATA').toString('base64'))
  assert.equal(FakeDriver.last!.closed, true, 'driver is always closed')
})

test('text action returns extracted content and closes the driver', async () => {
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () => new FakeDriver(),
  })
  const res = await tool.execute(params({ action: 'text', url: 'https://example.com', selector: '#main' }))
  assert.match(res.content, /text:#main/)
  assert.equal(FakeDriver.last!.closed, true)
})

test('invalid protocol is rejected', async () => {
  const tool = createBrowserTool({ enabled: true, allowlist: () => ['example.com'] })
  const res = await tool.execute(params({ action: 'screenshot', url: 'file:///etc/passwd' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /不支持的协议/)
})

test('tool is disabled by default', () => {
  assert.equal(createBrowserTool().isEnabled(), false)
  assert.equal(createBrowserTool({ enabled: true }).isEnabled(), true)
})

// --- issue #213: per-request (redirect / iframe / subresource) guard ---

test('evaluateBrowserRequest applies the same scheme + allowlist rules to every request', async () => {
  const allow = ['example.com']
  assert.equal((await evaluateBrowserRequest('https://example.com/a', allow, PUBLIC_LOOKUP)).reason, 'ok')
  assert.equal((await evaluateBrowserRequest('about:blank', allow, PUBLIC_LOOKUP)).reason, 'local-scheme')
  assert.equal((await evaluateBrowserRequest('data:text/html,hi', allow, PUBLIC_LOOKUP)).reason, 'local-scheme')
  assert.equal((await evaluateBrowserRequest('ftp://example.com/x', allow, PUBLIC_LOOKUP)).allow, false)
  assert.equal((await evaluateBrowserRequest('not a url', allow, PUBLIC_LOOKUP)).reason, 'unsupported-scheme')
  assert.equal(
    (await evaluateBrowserRequest('http://127.0.0.1/x', allow, PUBLIC_LOOKUP)).reason,
    'not-allowlisted',
  )
  assert.equal(
    (await evaluateBrowserRequest('https://example.com/a', [], PUBLIC_LOOKUP)).reason,
    'not-allowlisted',
    'an empty allowlist must fail closed per request too',
  )
})

test('evaluateBrowserRequest fails closed when DNS resolution fails', async () => {
  const failing: LookupFn = async () => { throw new Error('ENOTFOUND') }
  const d = await evaluateBrowserRequest('https://example.com/a', ['example.com'], failing)
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'dns-failure')
})

test('evaluateBrowserRequest blocks an allowlisted host that resolves to a private IP (rebinding)', async () => {
  const privateLookup: LookupFn = async () => ({ address: '169.254.169.254', family: 4 })
  const d = await evaluateBrowserRequest('https://internal.example.com/', ['internal.example.com'], privateLookup)
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'private-address')
})

test('createBrowserRequestGuard continues allowlisted requests and aborts the rest', async () => {
  const blocked: Array<string | undefined> = []
  const guard = createBrowserRequestGuard(['example.com'], PUBLIC_LOOKUP, (d) => blocked.push(d.hostname))
  const cont: string[] = []
  const abort: string[] = []
  const route = (u: string): PwRoute => ({
    continue: async () => { cont.push(u) },
    abort: async () => { abort.push(u) },
  })
  await guard(route('https://example.com/app.js'), { url: () => 'https://example.com/app.js' })
  await guard(route('http://169.254.169.254/latest/meta-data/'), { url: () => 'http://169.254.169.254/latest/meta-data/' })
  await guard(route('https://cdn.evil.com/x'), { url: () => 'https://cdn.evil.com/x' })
  assert.deepEqual(cont, ['https://example.com/app.js'])
  assert.deepEqual(abort, ['http://169.254.169.254/latest/meta-data/', 'https://cdn.evil.com/x'])
  assert.deepEqual(blocked, ['169.254.169.254', 'cdn.evil.com'])
})

test('browser tool installs a request guard (all requests) before goto', async () => {
  const tool = guardedTool({ allowlist: ['example.com'] })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://example.com/page' }))
  assert.equal(res.isError, undefined)
  const driver = FakeDriver.last!
  assert.equal(driver.routePattern, '**/*', 'guard must cover every request')
  assert.equal(driver.gotoUrl, 'https://example.com/page')
})

test('a 302 / subresource to a private host is aborted; an allowlisted one is continued (#213)', async () => {
  const tool = guardedTool({ allowlist: ['example.com'] })
  await tool.execute(params({ action: 'text', url: 'https://example.com/page' }))
  const driver = FakeDriver.last!
  assert.equal(await driver.dispatch('https://example.com/app.css'), 'continue')
  assert.equal(await driver.dispatch('http://127.0.0.1/admin'), 'abort', 'redirect to loopback')
  assert.equal(await driver.dispatch('http://169.254.169.254/latest/'), 'abort', 'redirect to metadata')
})

test('an iframe host outside the allowlist is aborted (#213)', async () => {
  const tool = guardedTool({ allowlist: ['example.com'] })
  await tool.execute(params({ action: 'text', url: 'https://example.com/page' }))
  const driver = FakeDriver.last!
  assert.equal(await driver.dispatch('https://frame.evil.com/embed'), 'abort')
  assert.equal(await driver.dispatch('https://app.example.com/iframe'), 'continue')
})

test('an allowlisted host resolving to a private IP is aborted through the tool (#213)', async () => {
  const privateLookup: LookupFn = async () => ({ address: '10.0.0.5', family: 4 })
  const tool = guardedTool({ allowlist: ['internal.example.com'], lookup: privateLookup })
  await tool.execute(params({ action: 'text', url: 'https://internal.example.com/' }))
  assert.equal(await FakeDriver.last!.dispatch('https://internal.example.com/secret'), 'abort')
})

test('a driver without per-request interception is refused (fail-closed, #213)', async () => {
  const tool = createBrowserTool({
    enabled: true,
    allowlist: () => ['example.com'],
    driverFactory: async () =>
      ({
        goto: async () => {},
        screenshot: async () => Buffer.from(''),
        textContent: async () => '',
        click: async () => {},
        close: async () => {},
      }) as never,
  })
  const res = await tool.execute(params({ action: 'screenshot', url: 'https://example.com' }))
  assert.equal(res.isError, true)
  assert.match(res.content, /逐请求拦截/)
})
