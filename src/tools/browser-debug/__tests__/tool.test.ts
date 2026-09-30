import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  createBrowserDebugTool,
  isLoopbackHost,
  isDebugHostAllowed,
  isLoopbackCdpUrl,
  isCdpUrlAllowed,
} from '../tool.js'
import { __resetSessionForTest, DEFAULT_SESSION_KEY } from '../session.js'
import { defaultUserDataDir } from '../profiles.js'
import type { BrowserDebugDriver, DriverEvents, DriverLaunchOptions } from '../driver.js'
import type { ToolCallParams } from '../../types.js'
import type { SaveArtifactInput } from '../../../artifact/store.js'

class FakeDriver implements BrowserDebugDriver {
  static last?: FakeDriver
  static lastLaunchOpts?: DriverLaunchOptions
  url = 'about:blank'
  closed = false
  alive = true
  /** 下一次 click 抛这个错（用于死亡恢复测试）；抛完自动清空。 */
  failClickOnce: Error | null = null
  waitAborted = false
  calls: string[] = []
  private readonly events: DriverEvents
  constructor(events: DriverEvents) {
    this.events = events
    FakeDriver.last = this
  }
  async goto(url: string) {
    this.url = url
    this.events.onRequestStart('r1', 'GET', url, 'document')
    this.events.onResponse('r1', 200, 'document')
    this.events.onRequestStart(
      'r2', 'POST', `${url.replace(/\/$/, '')}/api/data`, 'fetch',
      { Authorization: 'Bearer tok-abcd1234', 'Content-Type': 'application/json' },
      '{"q":"x"}',
    )
    this.events.onResponse('r2', 500, 'fetch', { 'x-request-id': 'req-7' })
    this.events.onResponseBody('r2', '{"error":"server"}', 'application/json')
    this.events.onConsole('error', 'Uncaught boom')
    this.events.onConsole('log', 'hello world')
  }
  async evaluate(expr: string) {
    return `eval:${expr}`
  }
  async screenshot() {
    return Buffer.from('PNGDATA')
  }
  async snapshot(selector?: string) {
    return selector ? `snap:${selector}` : 'page body text'
  }
  async click() {
    if (this.failClickOnce) {
      const err = this.failClickOnce
      this.failClickOnce = null
      throw err
    }
  }
  async type() { this.calls.push('type') }
  async press(selector: string | undefined, key: string) { this.calls.push(`press:${selector ?? '-'}:${key}`) }
  async selectOption(selector: string, value: string) { this.calls.push(`select:${selector}:${value}`); return [value] }
  async hover(selector: string) { this.calls.push(`hover:${selector}`) }
  async scroll(selector: string | undefined, to: string) { this.calls.push(`scroll:${selector ?? '-'}:${to}`) }
  async waitForSelector(_selector: string, _timeoutMs?: number, signal?: AbortSignal) {
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          this.waitAborted = true
          reject(signal.reason ?? new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => {
          this.waitAborted = true
          reject(signal.reason ?? new Error('aborted'))
        })
        setTimeout(resolve, 50)
      })
    }
  }
  async waitForLoadState(state: string) { this.calls.push(`loadstate:${state}`) }
  async reload() { this.calls.push('reload') }
  async goBack() { this.calls.push('back'); return true }
  async goForward() { this.calls.push('forward'); return false }
  pages?: string[]
  async cookies(urlFilter?: string) {
    this.calls.push(`cookies:${urlFilter ?? '-'}`)
    const all = [
      { name: 'session', value: 'abcdef123456', domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
      { name: 'theme', value: 'dark', domain: 'localhost', path: '/' },
    ]
    return urlFilter ? all.filter((c) => c.name.includes(urlFilter)) : all
  }
  async storage(kind: 'local' | 'session'): Promise<Record<string, string>> {
    this.calls.push(`storage:${kind}`)
    return kind === 'session'
      ? { flow: 'checkout' }
      : { token: 'secretvalue1234', theme: 'dark' }
  }
  async addCookie(cookie: { name: string; value: string; url?: string; domain?: string; path?: string }) {
    this.calls.push(`addCookie:${cookie.name}:${cookie.url ?? cookie.domain ?? '-'}`)
  }
  async clearCookies() { this.calls.push('clearCookies') }
  async setStorage(kind: 'local' | 'session', key: string, value: string) {
    this.calls.push(`setStorage:${kind}:${key}:${value}`)
  }
  async clearStorage(kind: 'local' | 'session') { this.calls.push(`clearStorage:${kind}`) }
  size: { width: number; height: number } | null = { width: 1280, height: 800 }
  async setViewport(width: number, height: number) {
    this.calls.push(`viewport:${width}x${height}`)
    this.size = { width, height }
  }
  viewportSize() { return this.size }
  currentUrl() {
    return this.url
  }
  pageUrls() { return this.pages ?? [this.url] }
  async bringToFront() {}
  isAlive() { return this.alive }
  async close() {
    this.closed = true
  }
}

class FakeArtifactStore {
  saved: SaveArtifactInput[] = []
  async save(input: SaveArtifactInput): Promise<string> {
    this.saved.push(input)
    return `browser_screenshot:${this.saved.length}`
  }
}

function params(
  input: Record<string, unknown>,
  extra: { store?: FakeArtifactStore; onOutput?: (c: string) => void; sessionId?: string; abortSignal?: AbortSignal } = {},
): ToolCallParams {
  return {
    input,
    toolUseId: 't1',
    cwd: '/work',
    sessionId: extra.sessionId,
    abortSignal: extra.abortSignal,
    artifactStore: extra.store as never,
    onOutput: extra.onOutput,
  }
}

function makeTool(opts: { built?: { value: boolean }; allowlist?: string[]; userDataDir?: string } = {}) {
  return createBrowserDebugTool({
    enabled: true,
    allowlist: () => opts.allowlist ?? [],
    userDataDir: () => opts.userDataDir ?? '/tmp/test-browser-profile',
    driverFactory: async (o: DriverLaunchOptions) => {
      if (opts.built) opts.built.value = true
      FakeDriver.lastLaunchOpts = o
      return new FakeDriver(o.events)
    },
  })
}

test('isLoopbackHost recognises loopback names', () => {
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('example.com'), false)
})

test('localhost navigation uses sessionId bucket', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  const res = await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }, { sessionId: 'worker-1' }))
  assert.equal(res.isError, undefined)
  const status = await tool.execute(params({ action: 'status' }, { sessionId: 'worker-1' }))
  assert.match(status.content, /会话：worker-1/)
  await tool.execute(params({ action: 'close' }, { sessionId: 'worker-1' }))
})

test('open honours width/height and set_viewport resizes the live page', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/', width: 390, height: 844 }))
  assert.deepEqual(FakeDriver.lastLaunchOpts?.viewport, { width: 390, height: 844 })
  assert.deepEqual(FakeDriver.last?.size, { width: 390, height: 844 })

  const res = await tool.execute(params({ action: 'set_viewport', width: 1440, height: 900 }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /1440×900/)
  assert.deepEqual(FakeDriver.last?.size, { width: 1440, height: 900 })
  await tool.execute(params({ action: 'close' }))
})

test('width-only resize keeps the height the page already has', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/', width: 1440, height: 900 }))
  await tool.execute(params({ action: 'set_viewport', width: 768 }))
  assert.deepEqual(FakeDriver.last?.size, { width: 768, height: 900 })
  await tool.execute(params({ action: 'close' }))
})

test('set_viewport rejects out-of-range and non-integer sizes', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const tooWide = await tool.execute(params({ action: 'set_viewport', width: 99_999 }))
  assert.equal(tooWide.isError, true)
  assert.match(tooWide.content, /超出范围/)
  const fractional = await tool.execute(params({ action: 'set_viewport', width: 800.5 }))
  assert.equal(fractional.isError, true)
  assert.match(fractional.content, /整数/)
  const missing = await tool.execute(params({ action: 'set_viewport' }))
  assert.equal(missing.isError, true)
  await tool.execute(params({ action: 'close' }))
})

test('screenshot attaches the PNG on the vision channel and reports the viewport', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/', width: 1440, height: 900 }))
  const res = await tool.execute(params({ action: 'screenshot' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /视口 1440×900/)
  assert.deepEqual(res.images, [`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`])
  await tool.execute(params({ action: 'close' }))
})

test('oversized screenshot keeps the file reference but skips the vision channel', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  FakeDriver.last!.screenshot = async () => Buffer.alloc(4_000_000)
  const res = await tool.execute(params({ action: 'screenshot' }))
  assert.equal(res.images, undefined)
  assert.match(res.content, /超出视觉通道上限/)
  await tool.execute(params({ action: 'close' }))
})

test('network url_filter and include_body', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({
    action: 'network',
    url_filter: '/api/',
    failed_only: true,
    include_body: true,
  }))
  assert.match(res.content, /← 500 POST/)
  assert.match(res.content, /body: \{"error":"server"\}/)
  assert.doesNotMatch(res.content, /← 200 GET/)
  await tool.execute(params({ action: 'close' }))
})

test('network_detail returns full entry', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'network_detail', request_id: 'r2' }))
  assert.match(res.content, /id: r2/)
  assert.match(res.content, /status: 500/)
  assert.match(res.content, /"error":"server"/)
  await tool.execute(params({ action: 'close' }))
})

test('network_detail masks request/response headers and shows payload', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'network_detail', request_id: 'r2' }))
  assert.match(res.content, /request headers:/)
  assert.match(res.content, /Authorization: \*\*\*\(…1234\)/)
  assert.match(res.content, /request body:/)
  assert.match(res.content, /"q":"x"/)
  assert.match(res.content, /response headers:/)
  assert.doesNotMatch(res.content, /Bearer tok-abcd1234/)
  await tool.execute(params({ action: 'close' }))
})

test('type with submit fills then presses Enter', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'type', selector: '#q', text: 'hi', submit: true }))
  assert.match(res.content, /按下 Enter/)
  assert.deepEqual(FakeDriver.last!.calls, ['type', 'press:#q:Enter'])
  await tool.execute(params({ action: 'close' }))
})

test('press / select / hover / scroll dispatch to driver', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  await tool.execute(params({ action: 'press', key: 'Escape' }))
  await tool.execute(params({ action: 'select', selector: '#s', value: 'opt1' }))
  await tool.execute(params({ action: 'hover', selector: '#menu' }))
  await tool.execute(params({ action: 'scroll' }))
  assert.deepEqual(FakeDriver.last!.calls, ['press:-:Escape', 'select:#s:opt1', 'hover:#menu', 'scroll:-:bottom'])
  await tool.execute(params({ action: 'close' }))
})

test('press requires key; select requires selector+value', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const p = await tool.execute(params({ action: 'press' }))
  assert.equal(p.isError, true)
  const s = await tool.execute(params({ action: 'select', selector: '#s' }))
  assert.equal(s.isError, true)
  await tool.execute(params({ action: 'close' }))
})

test('wait with state waits for load state', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'wait', state: 'networkidle' }))
  assert.match(res.content, /载入状态 "networkidle"/)
  assert.ok(FakeDriver.last!.calls.includes('loadstate:networkidle'))
  const none = await tool.execute(params({ action: 'wait' }))
  assert.equal(none.isError, true)
  await tool.execute(params({ action: 'close' }))
})

test('history reload/back/forward dispatch and report', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const reload = await tool.execute(params({ action: 'history', go: 'reload' }))
  assert.match(reload.content, /已重新加载/)
  const back = await tool.execute(params({ action: 'history', go: 'back' }))
  assert.match(back.content, /已后退至/)
  const fwd = await tool.execute(params({ action: 'history', go: 'forward' }))
  assert.match(fwd.content, /没有可前进的历史记录/)
  assert.deepEqual(FakeDriver.last!.calls, ['reload', 'back', 'forward'])
  await tool.execute(params({ action: 'close' }))
})

test('cookies action lists masked values and honours url_filter', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const all = await tool.execute(params({ action: 'cookies' }))
  assert.match(all.content, /session=\*\*\*\(…3456\)/)
  assert.match(all.content, /theme=\*\*\*\(…\)/)
  assert.doesNotMatch(all.content, /abcdef123456/)
  const filtered = await tool.execute(params({ action: 'cookies', url_filter: 'session' }))
  assert.match(filtered.content, /session=/)
  assert.doesNotMatch(filtered.content, /theme=/)
  assert.ok(FakeDriver.last!.calls.includes('cookies:session'))
  await tool.execute(params({ action: 'close' }))
})

test('storage action dumps local/session with secret masking', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const local = await tool.execute(params({ action: 'storage' }))
  assert.match(local.content, /localStorage:/)
  assert.match(local.content, /token: \*\*\*\(…1234\)/)
  assert.match(local.content, /theme: dark/)
  assert.doesNotMatch(local.content, /secretvalue1234/)
  const session = await tool.execute(params({ action: 'storage', kind: 'session' }))
  assert.match(session.content, /sessionStorage:/)
  assert.match(session.content, /flow: checkout/)
  assert.deepEqual(FakeDriver.last!.calls, ['storage:local', 'storage:session'])
  await tool.execute(params({ action: 'close' }))
})

test('set_cookie / clear_cookies dispatch to driver', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const set = await tool.execute(params({ action: 'set_cookie', name: 'sid', value: 'abc' }))
  assert.match(set.content, /设置 cookie "sid"/)
  // no url/domain given → falls back to current page origin
  assert.ok(FakeDriver.last!.calls.includes('addCookie:sid:http://localhost:3000'))
  const missing = await tool.execute(params({ action: 'set_cookie', name: 'sid' }))
  assert.equal(missing.isError, true)
  const clear = await tool.execute(params({ action: 'clear_cookies' }))
  assert.match(clear.content, /已清除此上下文的全部 cookie/)
  assert.ok(FakeDriver.last!.calls.includes('clearCookies'))
  await tool.execute(params({ action: 'close' }))
})

test('set_storage / clear_storage write web storage', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const set = await tool.execute(params({ action: 'set_storage', key: 'flag', value: 'on', kind: 'session' }))
  assert.match(set.content, /已设置 sessionStorage\["flag"\]/)
  assert.ok(FakeDriver.last!.calls.includes('setStorage:session:flag:on'))
  const missing = await tool.execute(params({ action: 'set_storage', key: 'flag' }))
  assert.equal(missing.isError, true)
  const clear = await tool.execute(params({ action: 'clear_storage' }))
  assert.match(clear.content, /已清除 localStorage/)
  assert.ok(FakeDriver.last!.calls.includes('clearStorage:local'))
  await tool.execute(params({ action: 'close' }))
})

test('pages action lists open tabs with active marker; status shows count', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  FakeDriver.last!.pages = ['http://localhost:3000/', 'https://accounts.example/login']
  const pages = await tool.execute(params({ action: 'pages' }))
  assert.match(pages.content, /\[0\] http:\/\/localhost:3000\//)
  assert.match(pages.content, /\* \[1\] https:\/\/accounts\.example\/login/)
  const status = await tool.execute(params({ action: 'status' }))
  assert.match(status.content, /页面：2 个已打开（末个为活动）/)
  await tool.execute(params({ action: 'close' }))
})

test('network api_only filters xhr/fetch', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'network', api_only: true }))
  assert.match(res.content, /\[fetch\]/)
  assert.doesNotMatch(res.content, /\[document\]/)
  await tool.execute(params({ action: 'close' }))
})

test('wait respects abortSignal without closing session', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const controller = new AbortController()
  const promise = tool.execute(params({
    action: 'wait',
    selector: '#slow',
    timeout_ms: 60_000,
  }, { abortSignal: controller.signal }))
  controller.abort(new Error('user abort'))
  const res = await promise
  assert.equal(res.isError, true)
  assert.match(res.content, /wait 失败/)
  const status = await tool.execute(params({ action: 'status' }))
  assert.match(status.content, /会话：__default__/)
  await tool.execute(params({ action: 'close' }))
})

test('open with connect_url passes connectUrl to driver factory', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({
    action: 'open',
    url: 'http://localhost:3000/',
    connect_url: 'http://127.0.0.1:9222',
  }))
  assert.equal(FakeDriver.lastLaunchOpts?.connectUrl, 'http://127.0.0.1:9222')
  await tool.execute(params({ action: 'close' }))
})

test('non-loopback CDP endpoint is blocked fail-closed', async () => {
  __resetSessionForTest()
  const built = { value: false }
  const tool = makeTool({ built })
  const res = await tool.execute(params({
    action: 'open',
    url: 'http://localhost:3000/',
    connect_url: 'http://evil.com:9222',
  }))
  assert.equal(res.isError, true)
  assert.match(res.content, /CDP 端点/)
  assert.equal(built.value, false)
})

test('clear_logs wipes captured buffers', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  await tool.execute(params({ action: 'clear_logs' }))
  const consoleRes = await tool.execute(params({ action: 'console' }))
  assert.equal(consoleRes.content, '（无控制台输出）')
  await tool.execute(params({ action: 'close' }))
})

test('await_login ends the turn', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  const res = await tool.execute(params({ action: 'await_login' }))
  assert.equal(res.endTurn, true)
  await tool.execute(params({ action: 'close' }))
})

test('tool is disabled by default, enabled via option', () => {
  assert.equal(createBrowserDebugTool().isEnabled(), false)
  assert.equal(createBrowserDebugTool({ enabled: true }).isEnabled(), true)
})

test('refusals carry errorKind=refused; missing url carries format_error', async () => {
  __resetSessionForTest()
  const tool = makeTool()

  const host = await tool.execute(params({ action: 'open', url: 'https://example.com/' }))
  assert.equal(host.isError, true)
  assert.equal(host.errorKind, 'refused', '设计性拒绝必须结构化，不能落 unknown 全罚')

  const proto = await tool.execute(params({ action: 'open', url: 'about:blank' }))
  assert.equal(proto.isError, true)
  assert.equal(proto.errorKind, 'refused')

  const missing = await tool.execute(params({ action: 'open' }))
  assert.equal(missing.isError, true)
  assert.equal(missing.errorKind, 'format_error')
})

test('status reports liveness; dead session is rebuilt before the next action', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const first = FakeDriver.last!
  first.alive = false

  const status = await tool.execute(params({ action: 'status' }))
  assert.match(status.content, /状态：已失效（下次页面操作会自动重建）/)

  const evalRes = await tool.execute(params({ action: 'eval', expression: '1+1' }))
  assert.equal(evalRes.isError, undefined)
  assert.notEqual(FakeDriver.last, first, '死会话必须重建')
  assert.equal(first.closed, true, '死 driver 必须被驱逐')
  await tool.execute(params({ action: 'close' }))
})

test('death error during an action triggers one rebuild and retry', async () => {
  __resetSessionForTest()
  const tool = makeTool()
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const first = FakeDriver.last!
  first.failClickOnce = new Error('page.click: Target page, context or browser has been closed')

  const res = await tool.execute(params({ action: 'click', selector: 'button.plus' }))
  assert.equal(res.isError, undefined, '一次死亡应被恢复，不应把错误回给模型')
  assert.match(res.content, /已点击/)
  assert.notEqual(FakeDriver.last, first, '必须重建 session 后重试')
  assert.equal(first.closed, true, '死 driver 必须被驱逐')
  await tool.execute(params({ action: 'close' }))
})

test('default profile dirs are isolated per sessionKey; __default__ keeps legacy', () => {
  const legacy = defaultUserDataDir(DEFAULT_SESSION_KEY)
  assert.match(legacy, /browser-debug-profile$/)

  const a = defaultUserDataDir('session-a')
  const b = defaultUserDataDir('session-b')
  assert.notEqual(a, b, '不同 sessionKey 必须拿到不同 profile 目录')
  assert.match(a, /browser-debug-profiles/)
  assert.equal(defaultUserDataDir('session-a', true), legacy, 'shared_profile 回退共享目录')
  const weird = defaultUserDataDir('含中文/斜杠的 key')
  assert.match(weird, /browser-debug-profiles/)
  // basename 按平台语义取末段（Windows 反斜杠）——split('/') 在 Windows 上取不到末段，
  // 整个路径参与断言会恒红。
  assert.doesNotMatch(basename(weird), /[^\w.-]/, '目录名必须文件系统安全（中文/空格/斜杠已替换）')
})

test('per-session profile dirs are actually passed to the factory (RIVET_HOME hermetic)', async () => {
  const prev = process.env.RIVET_HOME
  const home = mkdtempSync(join(tmpdir(), 'rivet-bd-test-'))
  process.env.RIVET_HOME = home
  try {
    __resetSessionForTest()
    const dirs: string[] = []
    const tool = createBrowserDebugTool({
      enabled: true,
      allowlist: () => [],
      driverFactory: async (o: DriverLaunchOptions) => {
        dirs.push(o.userDataDir)
        return new FakeDriver(o.events)
      },
    })
    await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }, { sessionId: 'worker-a' }))
    await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }, { sessionId: 'worker-b' }))
    assert.equal(dirs.length, 2)
    assert.notEqual(dirs[0], dirs[1])
    assert.match(dirs[0]!, /browser-debug-profiles/)
    await tool.execute(params({ action: 'close' }, { sessionId: 'worker-a' }))
    await tool.execute(params({ action: 'close' }, { sessionId: 'worker-b' }))
  } finally {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('click timeout appends candidate elements and errorKind=timeout', async () => {
  __resetSessionForTest()
  class TimeoutDriver extends FakeDriver {
    async click(): Promise<void> {
      throw new Error("page.click: Timeout 10000ms exceeded. Call log: waiting for locator('button.plus-btn')")
    }
    async evaluate(): Promise<string> {
      return JSON.stringify([{
        selector: 'button.add', tag: 'button', role: null, text: '新增任务', ariaLabel: null,
        placeholder: null, value: null, title: null, name: null, id: null, type: null,
        disabled: false, visible: true,
      }])
    }
  }
  const tool = createBrowserDebugTool({
    enabled: true,
    allowlist: () => [],
    userDataDir: () => '/tmp/test-browser-profile',
    driverFactory: async (o: DriverLaunchOptions) => new TimeoutDriver(o.events),
  })
  await tool.execute(params({ action: 'open', url: 'http://localhost:3000/' }))
  const res = await tool.execute(params({ action: 'click', selector: 'button.plus-btn' }))
  assert.equal(res.isError, true)
  assert.equal(res.errorKind, 'timeout')
  assert.match(res.content, /当前页面可交互元素/)
  assert.match(res.content, /新增任务/)
  await tool.execute(params({ action: 'close' }))
})
