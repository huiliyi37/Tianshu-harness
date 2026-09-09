import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'

test('run claims the instance synchronously before awaiting idle compaction', async () => {
  let releaseIdle!: () => void
  const idleGate = new Promise<void>(resolve => { releaseIdle = resolve })
  let cancelCalls = 0
  let innerCalls = 0
  let schedules = 0
  const fake = {
    _running: false,
    _pendingAbort: false,
    _watchdogAborted: false,
    abortController: null,
    // 64c692e4：run() 在 drain 前调用 session.resetSrCount()（SR 每轮上限）
    session: { resetSrCount: () => {} },
    cancelIdleCompaction: async () => {
      cancelCalls++
      await idleGate
    },
    _runInner: async () => { innerCalls++ },
    scheduleIdleCompaction: () => { schedules++ },
  }

  const first = AgentLoop.prototype.run.call(fake as unknown as AgentLoop, 'first', {} as never)
  assert.equal(fake._running, true, 'the guard must be claimed before run() returns its first promise')

  const duplicate = AgentLoop.prototype.run.call(fake as unknown as AgentLoop, 'second', {} as never)
  await duplicate
  assert.equal(cancelCalls, 1, 'duplicate run must preserve the existing no-op contract')
  assert.equal(innerCalls, 0)

  releaseIdle()
  await first
  assert.equal(innerCalls, 1)
  assert.equal(fake._running, false)
  assert.equal(schedules, 1)
})
