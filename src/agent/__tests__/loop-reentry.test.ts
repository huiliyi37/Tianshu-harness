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
    // 改道卡候选登记迁进 DecisionShiftDelivery（2026-10-10 0c8840f60）：run() 在
    // 首个 await 前 discard 上一轮候选。裸 fake 缺这个字段 → 同款「fake 过时」红
    // （症状与前三次一致：_running 看着像没被同步置位）。最小桩，与本轮不变量无关。
    decisionShifts: { discard: () => {} },
    // CourseEpisodes 接线（同一次改动）：run() 用它把 callbacks 包一层，补
    // onHumanGuidanceAccepted（指导被接受后推进核销周期）。桩成透传即可——本用例
    // 断言的是「守卫先于首个 await 被占」，与包装本身无关。
    courseEpisodes: { callbacks: (cb: unknown) => cb },
    // run/runObserved 拆分（2026-09-27）：run() 现在只做「早退 + observeRun 包裹」，
    // 主体搬进 runObserved。裸 fake 只实现叶子依赖（_runInner/cancelIdleCompaction…），
    // 没有这条原型方法 → `this.runObserved is not a function`，且因为是 async 里抛的，
    // 症状表现为「_running 没被同步置位」——看着像 re-entry 契约回归，实为 fake 过时
    // （同 2026-09-15 / toolRegistry 两处）。借真原型方法，保持「只换叶子」的原意。
    runObserved: (AgentLoop.prototype as unknown as { runObserved: unknown }).runObserved,
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

test('AgentLoop 必须真的实现 getTranscriptWatermark（否则生产检查点永远写不进水位）', () => {
  // 管理器用可选调用 agent.getTranscriptWatermark?.()：方法不存在时不报错、只是静默
  // 恒为 undefined —— 测试替身有、真身没有，是最容易骗过 review 的缺接线。
  const fn = (AgentLoop.prototype as unknown as { getTranscriptWatermark?: () => number }).getTranscriptWatermark
  assert.equal(typeof fn, 'function', 'AgentLoop 必须实现 getTranscriptWatermark')
  const persist = { getTranscriptWatermark: () => 42 }
  assert.equal(fn!.call({ persist } as unknown as AgentLoop), 42, '应转发到 SessionPersist 的水位')
  assert.equal(fn!.call({ persist: undefined } as unknown as AgentLoop), 0, '无 persist（匿名会话）时降级为 0，不抛')
})
