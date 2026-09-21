/**
 * browser-debug/session — per-sessionKey persistent browser sessions.
 *
 * Desktop runs multiple agent sessions in parallel; each gets its own browser
 * instance keyed by params.sessionId (TUI falls back to __default__).
 */

import {
  LogCapture,
  normalizeConsoleLevel,
  formatConsoleLine,
  formatNetworkLine,
} from './log-capture.js'
import {
  defaultDriverFactory,
  type BrowserDebugDriver,
  type BrowserDebugDriverFactory,
  type BrowserInputEvent,
  type DriverEvents,
  type ScreencastFrame,
  type ScreencastOptions,
} from './driver.js'

export const DEFAULT_SESSION_KEY = '__default__'

export type BrowserSessionMode = 'launch' | 'connect'

export interface OpenSessionOptions {
  sessionKey: string
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
  /** Initial page size. Omitted = the driver's default. */
  viewport?: { width: number; height: number }
}

export type OutputSink = (chunk: string) => void

export class BrowserDebugSession {
  readonly sessionKey: string
  readonly driver: BrowserDebugDriver
  readonly log = new LogCapture()
  readonly headless: boolean
  readonly mode: BrowserSessionMode
  readonly connectUrl?: string
  readonly userDataDir?: string
  private outputSink: OutputSink | null = null
  /** 实时帧流订阅者；每次订阅/退订按引用计数决定是否起停 screencast。 */
  private frameSubscribers = new Set<(frame: ScreencastFrame) => void>()
  private screencastActive = false

  private constructor(
    sessionKey: string,
    driver: BrowserDebugDriver,
    headless: boolean,
    mode: BrowserSessionMode,
    meta: { connectUrl?: string; userDataDir?: string },
  ) {
    this.sessionKey = sessionKey
    this.driver = driver
    this.headless = headless
    this.mode = mode
    this.connectUrl = meta.connectUrl
    this.userDataDir = meta.userDataDir
  }

  setOutputSink(sink: OutputSink | null): void {
    this.outputSink = sink
  }

  private emit(line: string): void {
    try {
      this.outputSink?.(line.endsWith('\n') ? line : line + '\n')
    } catch {
      /* ignore */
    }
  }

  // ── 实时帧流（供内嵌浏览器视图订阅）────────────────────────────────────
  // 多订阅者共享**一条** screencast；引用计数归零即停播——面板关掉之后不该让
  // 浏览器继续无谓地编码帧。

  /** 订阅实时画面，返回幂等退订函数。driver 无帧流能力时返回 no-op 退订。 */
  async subscribeFrames(
    onFrame: (frame: ScreencastFrame) => void,
    opts?: ScreencastOptions,
  ): Promise<() => void> {
    if (typeof this.driver.startScreencast !== 'function') {
      return () => {}
    }
    this.frameSubscribers.add(onFrame)
    if (!this.screencastActive) {
      this.screencastActive = true
      try {
        await this.driver.startScreencast(opts ?? {}, (frame) => {
          for (const cb of this.frameSubscribers) {
            try {
              cb(frame)
            } catch {
              /* 单个订阅者抛错不影响其余 */
            }
          }
        })
      } catch (err) {
        this.screencastActive = false
        this.frameSubscribers.delete(onFrame)
        throw err
      }
    }
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      this.frameSubscribers.delete(onFrame)
      if (this.frameSubscribers.size === 0 && this.screencastActive) {
        this.screencastActive = false
        void this.driver.stopScreencast?.().catch(() => {})
      }
    }
  }

  /** 是否正在推流。 */
  get streaming(): boolean {
    return this.screencastActive
  }

  /** 取一张当前画面（连接瞬间补首帧，避免静态页黑屏）。无能力时返回 null。 */
  async captureFrame(opts?: ScreencastOptions): Promise<ScreencastFrame | null> {
    if (typeof this.driver.captureFrame !== 'function') return null
    return await this.driver.captureFrame(opts).catch(() => null)
  }

  /** 反向注入输入事件。返回是否被驱动接受（无能力时 false）。 */
  async dispatchInput(evt: BrowserInputEvent): Promise<boolean> {
    if (typeof this.driver.dispatchInput !== 'function') return false
    await this.driver.dispatchInput(evt)
    return true
  }

  static async open(opts: OpenSessionOptions): Promise<BrowserDebugSession> {
    const mode: BrowserSessionMode = opts.connectUrl ? 'connect' : 'launch'
    let self: BrowserDebugSession | null = null
    const events: DriverEvents = {
      onConsole: (rawLevel, text) => {
        const level = normalizeConsoleLevel(rawLevel)
        const entry = self!.log.addConsole(level, text)
        self!.emit(formatConsoleLine(entry))
      },
      onRequestStart: (id, method, url, resourceType, headers, postData) => {
        const entry = self!.log.startRequest(id, method, url, Date.now(), resourceType, headers, postData)
        self!.emit(formatNetworkLine(entry))
      },
      onResponse: (id, status, resourceType, headers) => {
        const entry = self!.log.completeRequest(id, status, Date.now(), resourceType, headers)
        self!.emit(formatNetworkLine(entry))
      },
      onRequestFailed: (id, method, url, errorText, resourceType) => {
        const entry = self!.log.failRequest(id, method, url, errorText, Date.now(), resourceType)
        self!.emit(formatNetworkLine(entry))
      },
      onResponseBody: (id, body, contentType) => {
        self!.log.attachResponseBody(id, body, contentType)
      },
    }
    const factory = opts.driverFactory ?? defaultDriverFactory
    const driver = await factory({
      headless: opts.headless,
      userDataDir: opts.userDataDir,
      connectUrl: opts.connectUrl,
      viewport: opts.viewport,
      events,
    })
    self = new BrowserDebugSession(opts.sessionKey, driver, opts.headless, mode, {
      connectUrl: opts.connectUrl,
      userDataDir: mode === 'launch' ? opts.userDataDir : undefined,
    })
    return self
  }

  async close(): Promise<void> {
    try {
      await this.driver.close()
    } finally {
      this.log.clear()
      this.outputSink = null
      // 关会话即断流：清空订阅者并复位推流标记，否则复用的 sessionKey 会误判
      // 「已经在推流」而不再启动 screencast。
      this.frameSubscribers.clear()
      this.screencastActive = false
    }
  }
}

const sessions = new Map<string, BrowserDebugSession>()
const opening = new Map<string, Promise<BrowserDebugSession>>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    for (const s of sessions.values()) {
      void s.close().catch(() => {})
    }
    sessions.clear()
    opening.clear()
  }
  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
}

export function resolveSessionKey(sessionId?: string): string {
  return sessionId?.trim() ? sessionId.trim() : DEFAULT_SESSION_KEY
}

export async function getOrCreateSession(opts: {
  sessionKey: string
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
  viewport?: { width: number; height: number }
}): Promise<BrowserDebugSession> {
  const key = opts.sessionKey
  const existing = sessions.get(key)
  if (existing) return existing

  const inflight = opening.get(key)
  if (inflight) return inflight

  installExitHook()
  const promise = BrowserDebugSession.open({
    sessionKey: key,
    headless: opts.headless,
    userDataDir: opts.userDataDir,
    connectUrl: opts.connectUrl,
    driverFactory: opts.driverFactory,
    viewport: opts.viewport,
  })
    .then((s) => {
      sessions.set(key, s)
      opening.delete(key)
      return s
    })
    .catch((err) => {
      opening.delete(key)
      throw err
    })
  opening.set(key, promise)
  return promise
}

export function getSession(sessionKey: string = DEFAULT_SESSION_KEY): BrowserDebugSession | null {
  return sessions.get(sessionKey) ?? null
}

/** 当前活跃会话的 sessionKey 列表——供实时视图列举「可以看哪个浏览器」。 */
export function listSessionKeys(): string[] {
  return [...sessions.keys()]
}

export async function closeSession(sessionKey: string = DEFAULT_SESSION_KEY): Promise<void> {
  const s = sessions.get(sessionKey)
  sessions.delete(sessionKey)
  opening.delete(sessionKey)
  if (s) await s.close()
}

/** Test hook: drop all sessions without touching real browsers. */
export function __resetSessionForTest(): void {
  sessions.clear()
  opening.clear()
}

/** Test hook: count open sessions. */
export function __sessionCountForTest(): number {
  return sessions.size
}
