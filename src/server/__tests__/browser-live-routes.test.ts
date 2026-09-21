/**
 * /browser/sessions | /browser/live/:key | /browser/input — 实时视图路由层。
 *
 * 会话用注入桩替换（真浏览器另由 browser-debug 的集成冒烟覆盖）；这里只断言
 * 路由形状、鉴权、建连补帧与输入回传的分支。SSE 用最小 ServerResponse 桩抓字节。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { createRouter } from '../index.js'
import { buildBrowserRoutes, type BrowserLiveDeps } from '../browser-routes.js'
import type { BrowserDebugSession } from '../../tools/browser-debug/session.js'

const TOKEN = 'live-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function fakeSession(overrides: Record<string, unknown> = {}): BrowserDebugSession {
  const base = {
    sessionKey: 'sess-1',
    mode: 'launch',
    headless: true,
    streaming: false,
    driver: {
      currentUrl: () => 'http://localhost:3000/',
      pageUrls: () => ['http://localhost:3000/'],
    },
    subscribeFrames: async () => () => {},
    captureFrame: async () => ({ data: 'AAAA', width: 100, height: 100, seq: 1 }),
    dispatchInput: async () => true,
    ...overrides,
  }
  return base as unknown as BrowserDebugSession
}

function depsWith(sessions: Record<string, BrowserDebugSession | null>): BrowserLiveDeps {
  return {
    getSession: (key?: string) => (key ? (sessions[key] ?? null) : null),
    listSessionKeys: () => Object.keys(sessions),
  }
}

/** 抓字节的最小 ServerResponse 桩——SseStream 需要 writeHead/flushHeaders/write/end；
 *  SSE 路由另外监听 'close' 收尾，所以桩必须能主动触发它，否则 keepalive 泄漏、进程不退。 */
function fakeRes(): { res: ServerResponse; chunks: string[]; close: () => void } {
  const chunks: string[] = []
  const closeHandlers: Array<() => void> = []
  const res = {
    writeHead: () => {},
    flushHeaders: () => {},
    write: (s: string) => {
      chunks.push(s)
      return true
    },
    end: () => {},
    on: (event: string, cb: () => void) => {
      if (event === 'close') closeHandlers.push(cb)
    },
  }
  return {
    res: res as unknown as ServerResponse,
    chunks,
    close: () => {
      for (const cb of closeHandlers) cb()
    },
  }
}

describe('GET /browser/sessions', () => {
  it('lists active sessions with viewable shape', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({ 'sess-1': fakeSession() })))
    const res = await router('GET', '/browser/sessions', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { sessions: Array<Record<string, unknown>> }
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0]!.sessionKey, 'sess-1')
    assert.equal(body.sessions[0]!.url, 'http://localhost:3000/')
    assert.equal(body.sessions[0]!.streaming, false)
  })

  it('returns an empty list when no browser is open', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({})))
    const res = await router('GET', '/browser/sessions', {}, AUTH)
    assert.deepEqual((res.body as { sessions: unknown[] }).sessions, [])
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({})))
    const res = await router('GET', '/browser/sessions', {}, {})
    assert.equal(res.status, 401)
  })
})

describe('GET /browser/live/:sessionKey', () => {
  it('404 for an unknown session', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({})))
    const { res: stub } = fakeRes()
    const res = await router('GET', '/browser/live/nope', undefined, AUTH, stub)
    assert.equal(res.status, 404)
  })

  it('501 when the driver cannot stream frames', async () => {
    const router = createRouter(
      buildBrowserRoutes(TOKEN, depsWith({ 'sess-1': fakeSession({ subscribeFrames: undefined }) })),
    )
    const { res: stub } = fakeRes()
    const res = await router('GET', '/browser/live/sess-1', undefined, AUTH, stub)
    assert.equal(res.status, 501)
  })

  it('补一张快照帧再开流（静态页不产帧，不补会黑屏）', async () => {
    let unsubscribes = 0
    const router = createRouter(
      buildBrowserRoutes(
        TOKEN,
        depsWith({
          'sess-1': fakeSession({
            subscribeFrames: async () => {
              return () => {
                unsubscribes += 1
              }
            },
          }),
        }),
      ),
    )
    const { res: stub, chunks, close } = fakeRes()
    const res = await router('GET', '/browser/live/sess-1', undefined, AUTH, stub)
    assert.equal(res.status, 200)
    assert.equal(res.handled, true, 'SSE 独占 response，必须声明 handled')
    await new Promise((r) => setTimeout(r, 30))
    const text = chunks.join('')
    assert.ok(text.includes('event: frame'), '建连补帧必须以 frame 事件下发')
    assert.ok(text.includes('AAAA'), '帧体应是 base64 图像数据')

    // 断连必须收尾：退订 + 停心跳。否则引用计数永不归零（浏览器一直推流）、
    // keepalive 定时器泄漏（进程不退出——这正是本测试首版超时的原因）。
    close()
    assert.equal(unsubscribes, 1, '客户端断开后必须退订')
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({ 'sess-1': fakeSession() })))
    const { res: stub } = fakeRes()
    const res = await router('GET', '/browser/live/sess-1', undefined, {}, stub)
    assert.equal(res.status, 401)
  })
})

describe('POST /browser/input', () => {
  it('404 for an unknown session', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({})))
    const res = await router('POST', '/browser/input', { sessionKey: 'nope', event: { type: 'mouseMoved' } }, AUTH)
    assert.equal(res.status, 404)
  })

  it('400 when the input event is missing', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({ 'sess-1': fakeSession() })))
    const res = await router('POST', '/browser/input', { sessionKey: 'sess-1' }, AUTH)
    assert.equal(res.status, 400)
  })

  it('501 when the driver cannot inject input', async () => {
    const router = createRouter(
      buildBrowserRoutes(TOKEN, depsWith({ 'sess-1': fakeSession({ dispatchInput: async () => false }) })),
    )
    const res = await router(
      'POST',
      '/browser/input',
      { sessionKey: 'sess-1', event: { type: 'mouseMoved', x: 1, y: 2 } },
      AUTH,
    )
    assert.equal(res.status, 501)
  })

  it('forwards a valid input event', async () => {
    const seen: Array<Record<string, unknown>> = []
    const router = createRouter(
      buildBrowserRoutes(
        TOKEN,
        depsWith({
          'sess-1': fakeSession({
            dispatchInput: async (evt: Record<string, unknown>) => {
              seen.push(evt)
              return true
            },
          }),
        }),
      ),
    )
    const res = await router(
      'POST',
      '/browser/input',
      { sessionKey: 'sess-1', event: { type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 } },
      AUTH,
    )
    assert.equal(res.status, 200)
    assert.deepEqual(seen, [{ type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 }])
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildBrowserRoutes(TOKEN, depsWith({ 'sess-1': fakeSession() })))
    const res = await router('POST', '/browser/input', { sessionKey: 'sess-1', event: { type: 'mouseMoved' } }, {})
    assert.equal(res.status, 401)
  })
})
