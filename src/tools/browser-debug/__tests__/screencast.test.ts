import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getOrCreateSession, closeSession, __resetSessionForTest } from '../session.js'
import type {
  BrowserDebugDriver,
  BrowserInputEvent,
  DriverLaunchOptions,
  ScreencastFrame,
  ScreencastOptions,
} from '../driver.js'

/** 基线能力的假 driver——不含帧流方法（模拟不支持 CDP screencast 的实现）。 */
class BaseFakeDriver implements BrowserDebugDriver {
  closed = false
  async goto() {}
  async evaluate() { return '' }
  async screenshot() { return Buffer.from('') }
  async snapshot() { return '' }
  async click() {}
  async type() {}
  async press() {}
  async selectOption() { return [] as string[] }
  async hover() {}
  async scroll() {}
  async waitForSelector() {}
  async waitForLoadState() {}
  async reload() {}
  async goBack() { return true }
  async goForward() { return true }
  async cookies() { return [] }
  async storage() { return {} }
  async addCookie() {}
  async clearCookies() {}
  async setStorage() {}
  async clearStorage() {}
  async setViewport() {}
  viewportSize() { return { width: 1280, height: 800 } }
  currentUrl() { return 'about:blank' }
  pageUrls() { return ['about:blank'] }
  async bringToFront() {}
  async close() { this.closed = true }
}

/** 带帧流能力的假 driver，记录起停次数与最近一次帧回调。 */
class ScreencastFakeDriver extends BaseFakeDriver {
  startCount = 0
  stopCount = 0
  lastSink: ((f: ScreencastFrame) => void) | null = null
  inputEvents: BrowserInputEvent[] = []
  failStart = false

  async startScreencast(_opts: ScreencastOptions, onFrame: (f: ScreencastFrame) => void): Promise<void> {
    this.startCount += 1
    if (this.failStart) throw new Error('startScreencast failed')
    this.lastSink = onFrame
  }
  async stopScreencast(): Promise<void> {
    this.stopCount += 1
    this.lastSink = null
  }
  async captureFrame(): Promise<ScreencastFrame | null> {
    return { data: 'AAAA', width: 800, height: 600, seq: 1 }
  }
  async dispatchInput(evt: BrowserInputEvent): Promise<void> {
    this.inputEvents.push(evt)
  }
}

function factoryFor(make: () => BrowserDebugDriver) {
  return async (_o: DriverLaunchOptions): Promise<BrowserDebugDriver> => make()
}

async function openWith(key: string, driver: BrowserDebugDriver) {
  return await getOrCreateSession({
    sessionKey: key,
    headless: true,
    userDataDir: `profile-${key}`,
    driverFactory: factoryFor(() => driver),
  })
}

test('无帧流能力的 driver：能力探测全为否，退订是 no-op', async () => {
  __resetSessionForTest()
  const s = await openWith('k1', new BaseFakeDriver())

  const unsub = await s.subscribeFrames(() => {})
  assert.equal(s.streaming, false)
  assert.equal(await s.captureFrame(), null)
  assert.equal(await s.dispatchInput({ type: 'mouseMoved', x: 1, y: 1 }), false)

  unsub() // 不得抛
  await closeSession('k1')
})

test('引用计数：首个订阅启动推流，后续复用，全退订才停', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k2', driver)

  const unsubA = await s.subscribeFrames(() => {})
  assert.equal(driver.startCount, 1)
  assert.equal(s.streaming, true)

  const unsubB = await s.subscribeFrames(() => {})
  assert.equal(driver.startCount, 1, '第二个订阅者必须复用同一条 screencast')

  unsubA()
  assert.equal(driver.stopCount, 0, '仍有订阅者时不得停播')
  assert.equal(s.streaming, true)

  unsubB()
  assert.equal(driver.stopCount, 1)
  assert.equal(s.streaming, false)

  await closeSession('k2')
})

test('退订幂等：重复调用不会多停一次推流', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k3', driver)

  const unsub = await s.subscribeFrames(() => {})
  unsub()
  unsub()
  unsub()
  assert.equal(driver.stopCount, 1)

  await closeSession('k3')
})

test('帧分发给全部订阅者；单个订阅者抛错不影响其余', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k4', driver)

  const got: number[] = []
  await s.subscribeFrames(() => { throw new Error('subscriber blew up') })
  await s.subscribeFrames((f) => { got.push(f.seq) })

  driver.lastSink?.({ data: 'X', width: 10, height: 10, seq: 7 })
  assert.deepEqual(got, [7], '坏的订阅者不应吞掉其他订阅者的帧')

  await closeSession('k4')
})

test('startScreencast 失败：回滚订阅并如实抛出', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  driver.failStart = true
  const s = await openWith('k5', driver)

  await assert.rejects(() => s.subscribeFrames(() => {}), /startScreencast failed/)
  assert.equal(s.streaming, false, '启动失败后不得留下「正在推流」的假状态')

  // 回滚干净：修好之后再订阅仍能正常启动。
  driver.failStart = false
  const unsub = await s.subscribeFrames(() => {})
  assert.equal(s.streaming, true)
  unsub()

  await closeSession('k5')
})

test('close 清空订阅并复位推流标记', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k6', driver)
  await s.subscribeFrames(() => {})
  assert.equal(s.streaming, true)

  await closeSession('k6')
  assert.equal(s.streaming, false, '会话关闭后推流标记必须复位')
})

test('dispatchInput 透传事件；captureFrame 透传帧', async () => {
  __resetSessionForTest()
  const driver = new ScreencastFakeDriver()
  const s = await openWith('k7', driver)

  assert.equal(await s.dispatchInput({ type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 }), true)
  assert.deepEqual(driver.inputEvents, [{ type: 'mousePressed', x: 3, y: 4, button: 'left', clickCount: 1 }])

  const frame = await s.captureFrame()
  assert.equal(frame?.seq, 1)

  await closeSession('k7')
})
