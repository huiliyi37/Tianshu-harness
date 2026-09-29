import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createExitFuse } from '../exit-fuse.js'

function harness(timeoutMs = 20) {
  const events: string[] = []
  const fuse = createExitFuse({
    onGraceful: () => events.push('graceful'),
    forceExit: code => events.push(`force:${code}`),
    log: message => events.push(`log:${message}`),
    timeoutMs,
  })
  return { fuse, events }
}

describe('createExitFuse', () => {
  it('首信号走优雅关停，不强退', () => {
    const { fuse, events } = harness()
    fuse.signal('SIGINT')
    assert.deepEqual(events, ['graceful'])
  })

  it('关停进行中的第二次信号强退（非 0 码），不再触发优雅关停', () => {
    const { fuse, events } = harness()
    fuse.signal('SIGINT')
    fuse.signal('SIGINT')
    assert.deepEqual(events, ['graceful', 'log:second SIGINT — forcing immediate exit', 'force:1'])
  })

  it('arm 后超时保险丝触发强退（悬挂不无限推迟退出）', async () => {
    const { fuse, events } = harness(10)
    fuse.arm()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(events, ['log:graceful shutdown did not finish in 10ms — forcing exit', 'force:1'])
  })

  it('arm 幂等：重复调用只装一个保险丝（只强退一次）', async () => {
    const { fuse, events } = harness(10)
    fuse.arm()
    fuse.arm()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(events.filter(e => e === 'force:1').length, 1)
  })

  it('程序化关停（arm）启动后再来信号 = 二次信号语义，强退', () => {
    const { fuse, events } = harness()
    fuse.arm() // 模拟 shutdown() 内部装保险丝
    fuse.signal('SIGTERM')
    assert.deepEqual(events, ['log:second SIGTERM — forcing immediate exit', 'force:1'])
  })

  it('dispose 摘除保险丝：超时不再强退', async () => {
    const { fuse, events } = harness(10)
    fuse.arm()
    fuse.dispose()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(events, [])
  })
})
