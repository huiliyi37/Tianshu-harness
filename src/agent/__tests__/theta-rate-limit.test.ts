import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createThetaController, THETA_MAX_SESSION, THETA_MAX_PER_TURN, type ThetaControllerHost, type ThetaTelemetryState } from '../theta-controller.js'
import type { ThetaCheckResult, ThetaOutcome } from '../theta-check.js'

/**
 * 真实 controller 测试（主控可靠性闭环 Wave 1）。
 *
 * 旧版 theta-rate-limit.test.ts 是复制算术的假测试（把 controller 里的
 * `Math.min(4, consecutiveTimeouts)` 抄一遍再断言）——它永远绿，但证明不了
 * controller 行为。这里注入 mock runner + mock host，直接驱动 controller。
 */

function makeTelemetry(over: Partial<ThetaTelemetryState> = {}): ThetaTelemetryState {
  return {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
    consecutiveTimeouts: 0,
    cooldownUntilTurn: 0,
    suppressedCount: 0,
    outcomes: { ok: 0, type_errors: 0, timeout: 0, spawn_error: 0, busy: 0, backoff: 0, 'no-fresh-verdict': 0 },
    ...over,
  }
}

function makeHost(over: Partial<ThetaControllerHost> = {}): ThetaControllerHost {
  return {
    cwd: '/work',
    thetaCheckInFlight: false,
    thetaRequestsThisTurn: 0,
    thetaTelemetry: makeTelemetry(),
    session: { getTurnCount: () => 1 },
    repairHintTracker: { recordFailure: () => {} },
    ...over,
  }
}

function result(outcome: ThetaOutcome, errors: string[] = []): ThetaCheckResult {
  return { errors, durationMs: 10, timedOut: outcome === 'timeout', outcome }
}

/** 同步 runner——把 controller 的 async 流程收进微任务，测试无需等待真实 tsc。 */
function syncRunner(r: ThetaCheckResult): (cwd: string) => Promise<ThetaCheckResult> {
  return async () => r
}

/** 让 controller 的 promise 链（then/finally）跑完。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('theta-controller: outcome 分类与退避', () => {
  it('真实 timeout 推进连续超时退避并累计 outcome', async () => {
    const host = makeHost()
    const request = createThetaController(host, syncRunner(result('timeout')))

    request('elm')
    await settle()

    assert.equal(host.thetaTelemetry.consecutiveTimeouts, 1)
    assert.equal(host.thetaTelemetry.cooldownUntilTurn, 2, 'cooldown = currentTurn(1) + 1')
    assert.equal(host.thetaTelemetry.lastTimedOut, true)
    assert.equal(host.thetaTelemetry.outcomes.timeout, 1)
  })

  it('成功结果清零连续超时（含 type_errors——tsc 跑了就有答案）', async () => {
    const host = makeHost({
      // 退避已过期（cooldownUntilTurn=0）——请求可放行，成功结果负责清零
      thetaTelemetry: makeTelemetry({ consecutiveTimeouts: 3, cooldownUntilTurn: 0 }),
    })
    const request = createThetaController(host, syncRunner(result('type_errors', ['a.ts'])))

    request('elm')
    await settle()

    assert.equal(host.thetaTelemetry.consecutiveTimeouts, 0)
    assert.equal(host.thetaTelemetry.cooldownUntilTurn, 0)
    assert.equal(host.thetaTelemetry.lastTimedOut, false)
    assert.equal(host.thetaTelemetry.outcomes.type_errors, 1)
  })

  it('busy/backoff 只记抑制次数，不推进退避', async () => {
    for (const outcome of ['busy', 'backoff'] as const) {
      const host = makeHost({
        thetaTelemetry: makeTelemetry({ consecutiveTimeouts: 2, cooldownUntilTurn: 0 }),
      })
      const request = createThetaController(host, syncRunner(result(outcome)))

      request('elm')
      await settle()

      assert.equal(host.thetaTelemetry.consecutiveTimeouts, 2, `${outcome} 不得推进退避`)
      assert.equal(host.thetaTelemetry.lastTimedOut, false)
      assert.equal(host.thetaTelemetry.suppressedCount, 1, `${outcome} 记一次抑制`)
    }
  })

  it('spawn_error 不推进退避（不是 timeout），也不伪装成绿色', async () => {
    const host = makeHost({
      thetaTelemetry: makeTelemetry({ consecutiveTimeouts: 1, cooldownUntilTurn: 0 }),
    })
    const request = createThetaController(host, syncRunner(result('spawn_error')))

    request('elm')
    await settle()

    assert.equal(host.thetaTelemetry.consecutiveTimeouts, 1, 'spawn_error 不是 timeout，不得推进退避')
    assert.equal(host.thetaTelemetry.lastTimedOut, false)
    assert.equal(host.thetaTelemetry.outcomes.spawn_error, 1)
  })

  it('cooldown 窗口内拒绝请求（真实超时后的退避）', async () => {
    let runs = 0
    const host = makeHost({
      thetaTelemetry: makeTelemetry({ consecutiveTimeouts: 1, cooldownUntilTurn: 5 }),
      session: { getTurnCount: () => 4 },
    })
    const request = createThetaController(host, async () => { runs++; return result('ok') })

    request('elm')
    assert.equal(runs, 0, 'cooldown 未过期不得 spawn')
    assert.equal(host.thetaTelemetry.requestedCount, 0, '被拒绝的请求不计入 requestedCount')
  })
})

describe('theta-controller: 上限与防重入', () => {
  it('in-flight 防重入', async () => {
    let runs = 0
    const host = makeHost({ thetaCheckInFlight: true })
    const request = createThetaController(host, async () => { runs++; return result('ok') })

    request('elm')

    assert.equal(runs, 0)
    assert.equal(host.thetaTelemetry.requestedCount, 0)
  })

  it('per-turn cap 2', async () => {
    let runs = 0
    const host = makeHost({ thetaRequestsThisTurn: THETA_MAX_PER_TURN })
    const request = createThetaController(host, async () => { runs++; return result('ok') })

    request('elm')

    assert.equal(runs, 0)
  })

  it('session cap 40', async () => {
    let runs = 0
    const host = makeHost({
      thetaTelemetry: makeTelemetry({ requestedCount: THETA_MAX_SESSION }),
    })
    const request = createThetaController(host, async () => { runs++; return result('ok') })

    request('elm')

    assert.equal(runs, 0)
  })

  it('每次真实尝试都记入 requestedCount 与 lastReason', async () => {
    const host = makeHost()
    const request = createThetaController(host, syncRunner(result('ok')))

    request('elm-micro-release')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(host.thetaTelemetry.requestedCount, 1)
    assert.equal(host.thetaTelemetry.lastReason, 'elm-micro-release')
    assert.equal(host.thetaTelemetry.lastTimedOut, false)
  })

  it('onThetaResult 收到一次一结果（含耗时与预算）', async () => {
    const seen: Array<{ outcome: ThetaOutcome; budgetMs: number }> = []
    const host = makeHost({
      onThetaResult: (r, budgetMs) => seen.push({ outcome: r.outcome, budgetMs }),
    })
    const request = createThetaController(host, syncRunner(result('timeout')))

    request('elm')
    await settle()

    assert.deepEqual(seen, [{ outcome: 'timeout', budgetMs: 15_000 }])
  })

  it('type_errors 结果把错误文件喂给 repairHintTracker', async () => {
    const failed: string[] = []
    const host = makeHost({
      repairHintTracker: { recordFailure: (file: string) => { failed.push(file) } },
    })
    const request = createThetaController(host, syncRunner(result('type_errors', ['src/a.ts', 'src/b.ts'])))

    request('elm')
    await settle()

    assert.deepEqual(failed, ['src/a.ts', 'src/b.ts'])
  })
})

describe('theta-controller: no-fresh-verdict 语义（2026-09-22 只读消费者）', () => {
  it('no-fresh-verdict 只记抑制，不推进退避、不清零既有退避', async () => {
    // theta 现在是共享闸门结论的只读消费者：本工作树没进过验证期就没有结论可
    // 回放。这是「没有结论」，不是「失败」——不得像 timeout 那样推进退避，
    // 也不得像 ok/type_errors 那样清零（那会洗掉真实超时的记忆）。
    const host = makeHost({
      thetaTelemetry: makeTelemetry({ consecutiveTimeouts: 2, cooldownUntilTurn: 0 }),
    })

    createThetaController(host, syncRunner(result('no-fresh-verdict')))('theta-cycle:retrieval')
    await settle()

    assert.equal(host.thetaTelemetry.outcomes['no-fresh-verdict'], 1)
    assert.equal(host.thetaTelemetry.consecutiveTimeouts, 2, 'not a failure — must not advance backoff')
    // cooldownUntilTurn 是每次从 consecutiveTimeouts 派生的（turnCount + min(4, n)），
    // 不是保留值：2 未变 ⇒ 派生结果仍是 1+2=3，而不是被这次调用推进到更长。
    assert.equal(host.thetaTelemetry.cooldownUntilTurn, 3, 'derived from the UNCHANGED timeout count')
    assert.equal(host.thetaTelemetry.suppressedCount, 1, 'counted as suppressed')
    assert.equal(host.thetaTelemetry.lastTimedOut, false, 'must never masquerade as a timeout')
  })
})
