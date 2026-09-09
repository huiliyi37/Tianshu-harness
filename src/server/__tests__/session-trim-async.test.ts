import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { FileSessionPersistence } from '../session-persistence.js'

/**
 * Wave C: trim 异步化——常规 flush 只入队（setImmediate），裁剪不阻塞
 * flush 热路径；flushSync（关闭/读前）保持同步裁剪。语义不变，时机后移。
 */
describe('FileSessionPersistence deferred trim', () => {
  let dir: string
  let store: FileSessionPersistence
  const sid = 's1'
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-trim-async-'))
    store = new FileSessionPersistence(dir, { maxEventsDiskBytes: 200 })
    mkdirSync(join(dir, sid), { recursive: true })
    file = join(dir, sid, 'events.jsonl')
    // 预置超限文件：50 行 × ~45 字节 ≈ 2250 字节
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ seq: i + 1, ts: i, type: 'status', data: { pad: 'x'.repeat(20) } }) + '\n',
    )
    writeFileSync(file, lines.join(''))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appendEvent flush defers trim: file not trimmed until event loop yields', async () => {
    // 追加一条触发立即 flush（critical type）
    store.appendEvent(sid, { seq: 51, ts: 51, type: 'status', data: { pad: 'y'.repeat(20) } })
    // 写链由 queueMicrotask 启动——同步断言点上既未 append 也未 trim，文件仍超限
    assert.ok(statSync(file).size > 200, 'trim must NOT have run synchronously')

    await store.flushSessionAsync(sid) // 等写链 append + 链内 trim 收尾
    const after = statSync(file).size
    assert.ok(after <= 200 + 512, `expected trimmed to ~200+marker, got ${after}`)
  })

  it('flushSync trims synchronously (shutdown path unchanged)', () => {
    store.appendEvent(sid, { seq: 51, ts: 51, type: 'status', data: { pad: 'y'.repeat(20) } })
    store.flushSync()
    // 无需 yield——flushSync 路径同步裁剪
    const after = statSync(file).size
    assert.ok(after <= 200 + 512, `expected trimmed to ~200+marker, got ${after}`)
  })

  it('concurrent flushes coalesce: one trim, one marker', async () => {
    store.appendEvent(sid, { seq: 51, ts: 51, type: 'status', data: { pad: 'y'.repeat(20) } })
    // 同 tick 第二次 flush——pendingTrims 去重，不会排两个 trim 任务
    store.appendEvent(sid, { seq: 52, ts: 52, type: 'status', data: { pad: 'z'.repeat(20) } })
    await store.flushSessionAsync(sid)
    const markers = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(l => (JSON.parse(l) as { type?: string }).type === 'events_trimmed')
    assert.equal(markers.length, 1)
    const after = statSync(file).size
    assert.ok(after <= 200 + 512, `expected trimmed to ~200+marker, got ${after}`)
  })

  it('marker dedup: repeated trims keep exactly one marker', async () => {
    store.appendEvent(sid, { seq: 51, ts: 51, type: 'status', data: { pad: 'y'.repeat(20) } })
    await store.flushSessionAsync(sid)
    // 再追加并再等链收尾：文件仍可能超限 → 再次 trim，但保留区尾部已是 marker → 不追加
    store.appendEvent(sid, { seq: 52, ts: 52, type: 'status', data: { pad: 'z'.repeat(20) } })
    await store.flushSessionAsync(sid)
    const markers = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(l => (JSON.parse(l) as { type?: string }).type === 'events_trimmed')
    assert.equal(markers.length, 1)
  })

  it('deleteSession clears pending trim without error', async () => {
    store.appendEvent(sid, { seq: 51, ts: 51, type: 'status', data: { pad: 'y'.repeat(20) } })
    store.deleteSession(sid)
    await yieldLoop() // 在途任务应安全返回（目录已删 / Set 已清）
    assert.equal(existsSync(join(dir, sid)), false)
  })
})
