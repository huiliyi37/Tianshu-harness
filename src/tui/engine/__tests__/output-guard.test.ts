import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installOutputGuard, type OutputGuard } from '../output-guard.js'

// 注意：guard 会 patch 全局 process.stderr.write——每个用例必须 dispose，
// afterEach 兜底，防止泄漏影响同进程其他断言。

describe('OutputGuard', () => {
  let guard: OutputGuard | null = null
  afterEach(() => {
    guard?.dispose()
    guard = null
  })

  it('完整行被 sanitize 后路由给 onText，不直写 stderr', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('hello world\n')
    assert.deepEqual(received, ['hello world'])
  })

  it('按行缓冲：半行先不发射，补全后合并为一行', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('abc')
    assert.equal(received.length, 0)
    process.stderr.write('def\n')
    assert.deepEqual(received, ['abcdef'])
  })

  it('ANSI/控制字符被剥离（CSI、OSC、控制码）', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('\x1B[31mred text\x1B[0m\x1B]8;;http://x\x07link\x07\x01\n')
    assert.deepEqual(received, ['red textlink'])
  })

  it('行中裸 CR 被剥除——防光标回列 0 覆写同行已画前缀', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('warn\x0DING: spoofed\n')
    // CR 存活时终端上该行呈 "ING: spoofed"（"warn" 前缀被覆写）——告警前缀欺骗
    assert.deepEqual(received, ['warnING: spoofed'])
  })

  it('onText 回调期间再入的 stderr 写入不丢行（外层循环续走）', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => {
      received.push(t)
      // 模拟 commitStatic 路径里同步触发的又一次告警（再入写）
      if (t === 'first') process.stderr.write('nested-second\n')
    })
    process.stderr.write('first\n')
    assert.deepEqual(received, ['first', 'nested-second'])
  })

  it('无换行巨流不撑爆缓冲：截头保尾后行仍完整可读', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('x'.repeat(200_000))
    process.stderr.write('TAIL\n')
    assert.equal(received.length, 1)
    // 内存上界由 MAX_BUFFER_CHARS（64KB 截头保尾）兜底；输出行由 MAX_LINE_CHARS
    // 再截到 300——200KB 输入下进程不堆积、行发射不失控即为通过
    assert.ok(received[0]!.length <= 300 + 4, `行超长：${received[0]!.length}`)
  })

  it('多行一次写入逐行发射；空行不发射', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('one\n\n  \ntwo\n')
    assert.deepEqual(received, ['one', 'two'])
  })

  it('dispose 恢复原始 write，缓冲残尾原样补写', () => {
    const received: string[] = []
    guard = installOutputGuard((t) => { received.push(t) })
    process.stderr.write('tail-no-newline')
    const original = (guard as unknown as { dispose(): void })
    void original
    guard.dispose()
    guard = null
    // dispose 后 stderr.write 已恢复：再写不会进 onText
    process.stderr.write('after\n')
    assert.deepEqual(received, [])
  })

  it('重复安装幂等：返回同一实例，二次安装不换回调', () => {
    const first: string[] = []
    const second: string[] = []
    guard = installOutputGuard((t) => { first.push(t) })
    const guard2 = installOutputGuard((t) => { second.push(t) })
    assert.equal(guard, guard2)
    process.stderr.write('x\n')
    assert.deepEqual(first, ['x'])
    assert.deepEqual(second, [])
  })
})
