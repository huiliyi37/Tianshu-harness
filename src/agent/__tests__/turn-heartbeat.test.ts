import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnHeartbeat } from '../turn-heartbeat.js'
import { wrapCallbacksWithHeartbeat } from '../turn-orchestrator.js'
import { clearActivity, getLastActivity, touchActivity } from '../stall-observer.js'
import type { AgentCallbacks } from '../loop-types.js'

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('TurnHeartbeat', () => {
  it('fires after silentMs of silence', async () => {
    const events: Array<{ elapsed: number; activity: string }> = []
    const hb = new TurnHeartbeat({
      silentMs: 50,
      repeatMs: 50,
      onHeartbeat: (elapsed, activity) => events.push({ elapsed, activity }),
    })
    hb.start()
    await delay(80)
    hb.stop()
    assert.ok(events.length >= 1, `expected at least 1 heartbeat, got ${events.length}`)
    assert.equal(events[0]!.activity, 'starting')
    assert.ok(events[0]!.elapsed >= 50, `elapsed should be >= 50ms, got ${events[0]!.elapsed}`)
  })

  it('does not fire if tick happens before silentMs', async () => {
    const events: Array<{ elapsed: number; activity: string }> = []
    const hb = new TurnHeartbeat({
      silentMs: 100,
      repeatMs: 100,
      onHeartbeat: (e, a) => events.push({ elapsed: e, activity: a }),
    })
    hb.start()
    await delay(40)
    hb.tick('reading file')
    await delay(40)
    hb.tick('processing')
    await delay(40)
    hb.stop()
    assert.equal(events.length, 0, 'should not fire when ticks reset the clock')
  })

  it('reports the most recent activity in heartbeat events', async () => {
    const events: Array<{ activity: string }> = []
    const hb = new TurnHeartbeat({
      silentMs: 40,
      repeatMs: 40,
      onHeartbeat: (_, a) => events.push({ activity: a }),
    })
    hb.start()
    hb.tick('compacting messages')
    await delay(70)
    hb.stop()
    assert.ok(events.length >= 1)
    assert.equal(events[0]!.activity, 'compacting messages')
  })

  it('repeats after first fire at repeatMs interval', async () => {
    const fireTimes: number[] = []
    const hb = new TurnHeartbeat({
      silentMs: 50,
      repeatMs: 30,
      onHeartbeat: () => fireTimes.push(Date.now()),
    })
    const t0 = Date.now()
    hb.start()
    await delay(150)
    hb.stop()
    // First fire ~50ms, second ~80ms, third ~110ms — expect 3 fires total
    assert.ok(fireTimes.length >= 2, `expected >=2 fires, got ${fireTimes.length}`)
    if (fireTimes.length >= 2) {
      const gap = fireTimes[1]! - fireTimes[0]!
      assert.ok(gap >= 25 && gap <= 60, `repeat gap should be ~30ms, got ${gap}`)
    }
    // First fire should be after silentMs, not repeatMs
    const firstDelay = fireTimes[0]! - t0
    assert.ok(firstDelay >= 45, `first fire should respect silentMs (>=45ms), got ${firstDelay}`)
  })

  it('stops cleanly on stop()', async () => {
    let count = 0
    const hb = new TurnHeartbeat({
      silentMs: 30,
      repeatMs: 30,
      onHeartbeat: () => { count++ },
    })
    hb.start()
    await delay(50)
    hb.stop()
    const afterStop = count
    await delay(80)
    assert.equal(count, afterStop, 'should not fire after stop()')
  })

  it('survives errors in callback', async () => {
    let calls = 0
    const hb = new TurnHeartbeat({
      silentMs: 30,
      repeatMs: 30,
      onHeartbeat: () => {
        calls++
        throw new Error('callback boom')
      },
    })
    hb.start()
    await delay(100)
    hb.stop()
    // Should keep firing despite the throws
    assert.ok(calls >= 2, `expected >=2 calls despite errors, got ${calls}`)
  })

  describe('hard-stall watchdog', () => {
    it('fires onHardStall once when silence exceeds hardStallMs', async () => {
      const stalls: Array<{ elapsed: number; activity: string }> = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 60,
        onHeartbeat: () => {},
        onHardStall: (elapsed, activity) => stalls.push({ elapsed, activity }),
      })
      hb.start()
      hb.tick('read_file returned')
      await delay(140)
      hb.stop()
      assert.equal(stalls.length, 1, `onHardStall must fire exactly once, got ${stalls.length}`)
      assert.equal(stalls[0]!.activity, 'read_file returned')
      assert.ok(stalls[0]!.elapsed >= 60, `elapsed should be >= hardStallMs, got ${stalls[0]!.elapsed}`)
    })

    it('does not fire onHardStall when a tick resets the clock in time', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 80,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      // Tick every 30ms — never silent for the full 80ms ceiling.
      for (let i = 0; i < 5; i++) {
        await delay(30)
        hb.tick(`activity ${i}`)
      }
      hb.stop()
      assert.equal(stalls.length, 0, 'watchdog must not fire while ticks keep arriving')
    })

    it('re-arms the watchdog after a tick (fires again on a second stall)', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      await delay(90)        // first stall fires
      hb.tick('recovered')   // re-arm
      await delay(90)        // second stall fires
      hb.stop()
      assert.ok(stalls.length >= 2, `expected watchdog to re-arm and fire twice, got ${stalls.length}`)
    })

    it('disables the watchdog when hardStallMs is 0', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 0,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      await delay(120)
      hb.stop()
      assert.equal(stalls.length, 0, 'hardStallMs=0 must disable the watchdog')
    })

    it('keeps emitting heartbeats after a hard stall fires', async () => {
      let beats = 0
      let stalls = 0
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => { beats++ },
        onHardStall: () => { stalls++ },
      })
      hb.start()
      await delay(140)
      hb.stop()
      assert.equal(stalls, 1, 'hard stall fires once')
      assert.ok(beats >= 3, `heartbeats keep emitting while abort propagates, got ${beats}`)
    })
  })

  describe('pause / resume', () => {
    it('pause prevents heartbeats from firing', async () => {
      let count = 0
      const hb = new TurnHeartbeat({
        silentMs: 30,
        repeatMs: 30,
        onHeartbeat: () => { count++ },
      })
      hb.start()
      hb.pause()
      await delay(120)
      assert.equal(count, 0, 'pause must suppress heartbeats')
      hb.stop()
    })

    it('resume restarts heartbeat after pause', async () => {
      const events: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 40,
        repeatMs: 40,
        onHeartbeat: () => events.push(Date.now()),
      })
      hb.start()
      hb.pause()
      await delay(80)
      // Still paused — no events
      assert.equal(events.length, 0)
      const t0 = Date.now()
      hb.resume()
      await delay(80)
      hb.stop()
      assert.ok(events.length >= 1, `expected at least 1 heartbeat after resume, got ${events.length}`)
      assert.ok(events[0]! - t0 >= 35, 'first heartbeat after resume should respect silentMs')
    })

    it('tick exits pause and resets the clock', async () => {
      const events: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 40,
        repeatMs: 40,
        onHeartbeat: () => events.push(Date.now()),
      })
      hb.start()
      hb.pause()
      await delay(80)
      // tick while paused should exit pause and reset clock
      const t0 = Date.now()
      hb.tick('activity after pause')
      await delay(80)
      hb.stop()
      assert.ok(events.length >= 1, `tick should resume and heartbeat fires after silentMs, got ${events.length}`)
      assert.ok(events[0]! - t0 >= 35)
    })

    it('hard-stall watchdog does not fire while paused', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      hb.pause()
      await delay(120)
      assert.equal(stalls.length, 0, 'watchdog must not fire while paused')
      hb.stop()
    })

    it('hard-stall watchdog re-arms after resume', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      hb.pause()
      await delay(80)
      hb.resume()
      await delay(100)
      hb.stop()
      // After resume, the watchdog should fire after hardStallMs of silence
      assert.equal(stalls.length, 1, 'watchdog must re-arm after resume')
    })

    it('double pause is a no-op', async () => {
      let count = 0
      const hb = new TurnHeartbeat({
        silentMs: 30,
        repeatMs: 30,
        onHeartbeat: () => { count++ },
      })
      hb.start()
      hb.pause()
      hb.pause() // second pause — no-op
      await delay(100)
      assert.equal(count, 0, 'double pause should not restart timer')
      hb.stop()
    })

    it('resume without pause is a no-op', async () => {
      let count = 0
      const hb = new TurnHeartbeat({
        silentMs: 30,
        repeatMs: 30,
        onHeartbeat: () => { count++ },
      })
      hb.start()
      hb.resume() // resume without pause — no-op, should not reset clock
      await delay(60)
      hb.stop()
      assert.ok(count >= 1, 'resume without pause should not reset the clock')
    })
  })

  describe('disarm / rearm watchdog (stream-phase cold TTFT)', () => {
    it('suppresses the hard stall but KEEPS informational heartbeats', async () => {
      let beats = 0
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => { beats++ },
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      hb.disarmWatchdog()
      await delay(140)
      hb.stop()
      assert.equal(stalls.length, 0, 'disarmed watchdog must not abort during a long busy gap')
      assert.ok(beats >= 3, `heartbeats must keep firing while disarmed (got ${beats}) — unlike pause()`)
    })

    it('rearm restores the hard stall', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      hb.disarmWatchdog()
      await delay(90)
      assert.equal(stalls.length, 0, 'still disarmed → no stall')
      hb.rearmWatchdog()
      await delay(100)
      hb.stop()
      assert.equal(stalls.length, 1, 'rearm must re-enable the hard stall')
    })

    it('phase-change tick does NOT re-arm a disarmed watchdog', async () => {
      const stalls: number[] = []
      const hb = new TurnHeartbeat({
        silentMs: 20,
        repeatMs: 20,
        hardStallMs: 50,
        onHeartbeat: () => {},
        onHardStall: (elapsed) => stalls.push(elapsed),
      })
      hb.start()
      hb.disarmWatchdog()
      // Simulate onStreamStart's onPhaseChange('working') tick mid-gap — under
      // pause() this would re-arm the timer; disarm must survive it.
      await delay(30)
      hb.tick('waiting for first token')
      await delay(110)
      hb.stop()
      assert.equal(stalls.length, 0, 'a tick must not re-arm the hard stall while disarmed')
    })
  })
})

describe('wrapCallbacksWithHeartbeat', () => {
  /** Minimal callbacks: only onTurnComplete is under test. */
  function makeCallbacks(
    onTurnComplete: (
      usage: unknown,
      turnNumber: number,
      isFinal?: boolean,
      evidenceSummary?: unknown,
      continuationReason?: string,
    ) => void,
  ): AgentCallbacks {
    return {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete,
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => true,
    } as unknown as AgentCallbacks
  }

  it('forwards continuationReason through onTurnComplete', () => {
    // The heartbeat wrapper is the callbacks object the orchestrator actually
    // uses after initializeRun (turn-orchestrator.ts: callbacks =
    // wrappedCallbacks). Dropping an argument here silently disables every
    // downstream consumer of the wire field (sidecar turn_complete event →
    // desktop delivery/self-verification split).
    const hb = new TurnHeartbeat({ silentMs: 10_000, repeatMs: 10_000, onHeartbeat: () => {} })
    const seen: Array<{ turnNumber: number; isFinal?: boolean; continuationReason?: string }> = []
    const wrapped = wrapCallbacksWithHeartbeat(
      makeCallbacks((_usage, turnNumber, isFinal, _evidence, continuationReason) => {
        seen.push({ turnNumber, isFinal, continuationReason })
      }),
      hb,
    )
    wrapped.onTurnComplete({}, 3, false, undefined, 'obligation-verification')
    assert.deepEqual(seen, [{ turnNumber: 3, isFinal: false, continuationReason: 'obligation-verification' }])
    // tick() inside the wrapper arms a timer while !stopped — stop it or the
    // test file never lets the event loop drain.
    hb.stop()
  })

  it('still forwards the pre-existing arguments (no regression)', () => {
    const hb = new TurnHeartbeat({ silentMs: 10_000, repeatMs: 10_000, onHeartbeat: () => {} })
    const seen: Array<{ turnNumber: number; isFinal?: boolean; evidence?: unknown }> = []
    const wrapped = wrapCallbacksWithHeartbeat(
      makeCallbacks((_usage, turnNumber, isFinal, evidenceSummary) => {
        seen.push({ turnNumber, isFinal, evidence: evidenceSummary })
      }),
      hb,
    )
    const evidence = { gate: 'GREEN' }
    wrapped.onTurnComplete({}, 7, true, evidence as never)
    assert.deepEqual(seen, [{ turnNumber: 7, isFinal: true, evidence }])
    hb.stop()
  })

  it('markIdle survives the callback itself touching activity (session-manager append order)', () => {
    // 集成顺序回归：session-manager 的 onTurnComplete 内 append turn_complete
    // 事件并对所有事件无条件 touchActivity——若 markIdle 在 cb 之前打，
    // 同一同步链里会被 touch 覆盖成 idle:false，sidecar/desktop 下
    // 「交付后等用户 >150s 误报」修复永不生效（956564a83 遗留缺口）。
    const key = 'test-idle-order'
    try {
      touchActivity(key, 'test-setup')
      const hb = new TurnHeartbeat({ silentMs: 10_000, repeatMs: 10_000, onHeartbeat: () => {} })
      const wrapped = wrapCallbacksWithHeartbeat(
        makeCallbacks(() => {
          // 模拟 session-manager append('turn_complete')：回调内同步打点
          touchActivity(key, 'evt:turn_complete')
        }),
        hb,
        () => key,
      )
      wrapped.onTurnComplete({}, 1, true)
      assert.equal(getLastActivity(key).idle, true, 'idle 标记必须在回调内 touchActivity 之后仍成立')
      hb.stop()
    } finally {
      clearActivity(key)
    }
  })
})
