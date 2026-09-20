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
    // zen 相位接入后 run() 在首个 await 前发一次相位镜像（emitZenPhaseEvent：
    // 参数求值读 this.zenController，方法体读 this.config.zen）、drain 后再打
    // 一次 turn 边界。裸 fake 缺这些 → 第一次 run 在进入 cancelIdleCompaction
    // 之前就抛 TypeError（先是 is not a function，补桩后是 currentPhase），于是
    // cancelCalls 恒为 0——这条红看着像产品契约回归，实为 fake 过时（2026-09-15
    // 收口）。两个方法桩 + 参数求值所需的 zenController 即可，与本轮不变量无关。
    emitZenPhaseEvent: () => {},
    zenTurnBoundary: () => {},
    zenController: { currentPhase: 'full', lastPromoteReason: undefined },
    // 晚到注册闸门（3.14alpha 71872ed9f 回流）：run() 在 drain 前还要查
    // toolRegistry 的异步注册清零状态。裸 fake 缺 config，同款「fake 过时」形态
    // （补前的症状一样：cancelCalls 恒为 0）——最小桩即可，与本轮不变量无关。
    config: { toolRegistry: { awaitExtraRegistrations: async () => {} } },
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
