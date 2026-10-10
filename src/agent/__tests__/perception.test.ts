import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptThetaInterval,
  applyProviderHealth,
  buildHealthTelemetry,
  buildStarPhaseContext,
  buildTelemetrySnapshot,
} from '../perception.js'
import { createVigorState } from '../vigor.js'
import type { Sensorium, StrategyProfile } from '../sensorium.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.8,
    complexity: 0.4,
    freshness: 0.5,
    stability: 1,
    ...overrides,
  }
}

function makeStrategy(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    reasoningEffort: 'medium',
    explorationBreadth: 0.3,
    commitThreshold: 0.6,
    shouldEscalate: false,
    thetaCycleInterval: 7,
    ...overrides,
  }
}

describe('applyProviderHealth', () => {
  it('returns unchanged sensorium when degradation is zero', () => {
    const sensorium = makeSensorium({ stability: 0.8 })

    assert.deepEqual(applyProviderHealth(sensorium, 0), sensorium)
  })

  it('reduces stability by degradation ratio', () => {
    const adjusted = applyProviderHealth(makeSensorium({ stability: 1 }), 0.5)

    assert.equal(adjusted.stability, 0.85)
  })

  it('clamps degradation ratio to safe range', () => {
    const adjusted = applyProviderHealth(makeSensorium({ stability: 1 }), 2)

    assert.equal(adjusted.stability, 0.7)
  })
})

describe('adaptThetaInterval', () => {
  it('shortens interval as git change rate rises', () => {
    assert.equal(adaptThetaInterval(7, 1), 4)
  })

  it('never goes below floor of two', () => {
    assert.equal(adaptThetaInterval(3, 1), 2)
  })

  it('leaves interval unchanged when git change rate is zero', () => {
    assert.equal(adaptThetaInterval(7, 0), 7)
  })
})

describe('buildStarPhaseContext', () => {
  it('derives writing/testing/final flags from recent tools and turn', () => {
    const ctx = buildStarPhaseContext({
      turn: 9,
      maxTurns: 10,
      recentTools: ['read_file', 'edit_file', 'run_tests'],
      hasEnteredHighComplexity: true,
    })

    assert.deepEqual(ctx, {
      turn: 9,
      isWriting: true,
      isRunningTests: true,
      isFinalTurn: true,
      readyByEvidence: false,
      hasEnteredHighComplexity: true,
    })
  })

  // maxTurns=0 是 YOLO 的「无上限」哨兵（bootstrap/serve/slash-commands 三处都这么置），
  // turn-orchestrator 用 MAX_SAFE_INTEGER 解释它。这里若按字面算 turn >= -1 就恒为真，
  // 于是 momentum>0.8 的帧全部落进「瑶光归航」——无限轮次的会话被一路当成在收尾。
  it('maxTurns=0（YOLO 无上限）时永远不是最终轮', () => {
    for (const turn of [0, 1, 50, 500]) {
      const ctx = buildStarPhaseContext({
        turn,
        maxTurns: 0,
        recentTools: [],
        hasEnteredHighComplexity: false,
      })
      assert.equal(ctx.isFinalTurn, false, `turn=${turn} 不应判为最终轮`)
    }
  })

  // 复盘修复（2026-07-25）：YOLO 没有最终轮 → delivering 结构性不可达，
  // 归航改由交付证据门（deliveryStatus==='verified'）抬升。
  it('YOLO + 交付已验证 → readyByEvidence 为真（证据门归航）', () => {
    const ctx = buildStarPhaseContext({
      turn: 42,
      maxTurns: 0,
      recentTools: [],
      hasEnteredHighComplexity: false,
      deliveryVerified: true,
    })
    assert.equal(ctx.isFinalTurn, false)
    assert.equal(ctx.readyByEvidence, true)
  })

  it('有界会话不走证据门——交付已验证也不置 readyByEvidence（语义保持最终轮才归航）', () => {
    const ctx = buildStarPhaseContext({
      turn: 3,
      maxTurns: 10,
      recentTools: [],
      hasEnteredHighComplexity: false,
      deliveryVerified: true,
    })
    assert.equal(ctx.readyByEvidence, false)
  })
})

describe('buildHealthTelemetry', () => {
  it('flat-low triggers rigidity, elmDue stays false (below elm threshold)', () => {
    const health = buildHealthTelemetry(createVigorState({
      vigor: 0.4,
      history: Array(10).fill(0.4),
    }), 1)

    assert.equal(health.rigidity, true)
    assert.equal(health.elmDue, false)
  })

  it('flat-high does NOT trigger rigidity (sustained success is healthy)', () => {
    const health = buildHealthTelemetry(createVigorState({
      vigor: 0.9,
      history: Array(10).fill(0.9),
    }), 1)

    assert.equal(health.rigidity, false)
    assert.equal(health.elmDue, true)
  })

  it('elmDue cools down within cooldown window (caller-held lastElmReleaseTurn)', () => {
    const highState = createVigorState({
      vigor: 0.86,
      history: [0.81, 0.83, 0.84, 0.82, 0.86],
    })

    // 首次：无冷却记录（lastElmReleaseTurn 默认 -Infinity）→ 触发
    const first = buildHealthTelemetry(highState, 1)
    assert.equal(first.elmDue, true)

    // 调用方记录 lastElmReleaseTurn=1 后，冷却期内（<5 轮）不再触发
    const second = buildHealthTelemetry(highState, 2, 1)
    assert.equal(second.elmDue, false)

    const third = buildHealthTelemetry(highState, 4, 1)
    assert.equal(third.elmDue, false)
  })

  it('elmDue re-triggers after cooldown expires', () => {
    const highState = createVigorState({
      vigor: 0.86,
      history: [0.81, 0.83, 0.84, 0.82, 0.86],
    })

    // 上次触发在第 10 轮；第 15 轮已过 5 轮冷却 → 再次触发
    const afterCooldown = buildHealthTelemetry(highState, 15, 10)
    assert.equal(afterCooldown.elmDue, true)
  })

  it('纯函数无模块级状态：重复调用（不传 lastElmReleaseTurn）互不污染', () => {
    const highState = createVigorState({
      vigor: 0.86,
      history: [0.81, 0.83, 0.84, 0.82, 0.86],
    })

    // 旧实现用模块级 lastElmReleaseTurn，第二次会被静默；
    // 改 per-session 纯函数后，不传冷却态 = 每次独立判定，均触发。
    assert.equal(buildHealthTelemetry(highState, 1).elmDue, true)
    assert.equal(buildHealthTelemetry(highState, 2).elmDue, true)
  })
})

describe('buildTelemetrySnapshot', () => {
  it('builds stable sensorium telemetry shape', () => {
    const snapshot = buildTelemetrySnapshot({
      ts: 123,
      turn: 2,
      phase: 'yuheng-implementing',
      sensorium: makeSensorium({ momentum: 0.9 }),
      strategy: makeStrategy({ reasoningEffort: 'low', thetaCycleInterval: 5 }),
      vigor: createVigorState({ tonic: 0.7, phasic: 0.2, vigor: 0.8 }),
      theta: {
        inFlight: false,
        lastReason: 'elm-micro-release',
        lastDurationMs: 42,
        lastErrorCount: 1,
        lastTimedOut: false,
        requestedCount: 3,
      },
      gitChangeRate: 0.25,
      prefixDrift: true,
    })

    assert.equal(snapshot.ts, 123)
    assert.equal(snapshot.turn, 2)
    assert.equal(snapshot.phase, 'yuheng-implementing')
    assert.equal(snapshot.momentum, 0.9)
    assert.deepEqual(snapshot.strategy, { reasoningEffort: 'low', shouldEscalate: false, thetaInterval: 5 })
    assert.equal(snapshot.vigor.vigor, 0.8)
    assert.equal(snapshot.theta.lastErrorCount, 1)
    assert.equal(snapshot.gitChangeRate, 0.25)
    assert.equal(snapshot.prefixDrift, true)
  })
})

describe('isWriting 写工具全族（2026-10-09：只认 write_file/edit_file 导致写码中被误判非写）', () => {
  it('hash_edit / ast_edit / apply_patch 都计入 isWriting', () => {
    for (const tool of ['hash_edit', 'ast_edit', 'apply_patch']) {
      const ctx = buildStarPhaseContext({ turn: 1, maxTurns: 10, recentTools: [tool], hasEnteredHighComplexity: false })
      assert.equal(ctx.isWriting, true, `${tool} 应计入 isWriting`)
    }
  })
})
