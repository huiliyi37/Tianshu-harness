import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapSensoriumToPhase,
  createStarEvent,
  createThetaState,
  tickTheta,
  completeTheta,
  advanceThetaCounter,
  getThetaPhase,
  PHASE_LABELS,
  PHASE_GLYPHS,
} from '../star-event.js'
import { shouldEscalateFromKick } from '../dissipative-kick.js'
import { computeStrategy } from '../sensorium.js'
import type { Sensorium } from '../sensorium.js'
import type { StarPhaseContext, ThetaState, ThetaPhase, StarEvent } from '../star-event.js'

// ─── Phase Labels & Glyphs ──────────────────────────────────────────

describe('PHASE_LABELS', () => {
  it('has all 8 phases', () => {
    const phases: string[] = [
      'tianshu-planning', 'tianxuan-locating', 'tianji-decomposing',
      'tianquan-contracting', 'yuheng-implementing', 'kaiyang-testing',
      'yaoguang-delivering', 'tianshu-encore',
    ]
    for (const p of phases) {
      assert.ok(PHASE_LABELS[p as keyof typeof PHASE_LABELS], `missing label for ${p}`)
      assert.ok(PHASE_GLYPHS[p as keyof typeof PHASE_GLYPHS], `missing glyph for ${p}`)
    }
    // Verify all 8 are present
    assert.equal(Object.keys(PHASE_LABELS).length, 8)
    assert.equal(Object.keys(PHASE_GLYPHS).length, 8)
  })
})

// ─── mapSensoriumToPhase ────────────────────────────────────────────

describe('mapSensoriumToPhase', () => {
  function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
    return {
      momentum: 0.5,
      pressure: 0.3,
      confidence: 0.7,
      complexity: 0.3,
      freshness: 0.5,
      stability: 0.8,
      ...overrides,
    }
  }

  function makeCtx(overrides: Partial<StarPhaseContext> = {}): StarPhaseContext {
    return {
      turn: 3,
      isWriting: false,
      isRunningTests: false,
      isFinalTurn: false,
      hasEnteredHighComplexity: false,
      ...overrides,
    }
  }

  it('returns kaiyang-testing when running tests', () => {
    const s = makeSensorium()
    const ctx = makeCtx({ isRunningTests: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'kaiyang-testing')
  })

  it('returns yaoguang-delivering on final turn with high momentum', () => {
    const s = makeSensorium({ momentum: 0.9 })
    const ctx = makeCtx({ isFinalTurn: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('does not deliver on final turn with low momentum', () => {
    const s = makeSensorium({ momentum: 0.3 })
    const ctx = makeCtx({ isFinalTurn: true })
    assert.notEqual(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('returns yuheng-implementing when confident and writing', () => {
    const s = makeSensorium({ confidence: 0.8 })
    const ctx = makeCtx({ isWriting: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yuheng-implementing')
  })

  it('returns tianji-decomposing when complexity high', () => {
    const s = makeSensorium({ complexity: 0.6 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianji-decomposing')
  })

  it('returns tianxuan-locating when freshness high', () => {
    const s = makeSensorium({ freshness: 0.8, complexity: 0.3 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianxuan-locating')
  })

  it('returns tianquan-contracting when was high complexity + confident + low complexity + not writing', () => {
    const s = makeSensorium({ confidence: 0.8, complexity: 0.3, freshness: 0.5 })
    const ctx = makeCtx({ isWriting: false, isRunningTests: false, hasEnteredHighComplexity: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianquan-contracting')
  })

  it('skips contracting when hasEnteredHighComplexity is false', () => {
    const s = makeSensorium({ confidence: 0.8, complexity: 0.3 })
    const ctx = makeCtx({ isWriting: false, isRunningTests: false, hasEnteredHighComplexity: false })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianxuan-locating')
  })

  it('returns tianshu-planning only via the freshness default（首轮升级那条已随死码移除）', () => {
    const s = makeSensorium({ freshness: 0.3 })
    const ctx = makeCtx({ turn: 1 })
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianshu-planning')
  })

  it('相位映射永不产出 tianshu-encore —— 它的活体入口只有 kick', () => {
    // 曾有两条以 ctx.shouldEscalate 为前置的分支，5ae389d1 把该字段关成恒 false 后
    // 不可达，已移除。这里穷举它们原来的触发形状，防止有人凭旧文档改回来。
    for (const turn of [1, 2, 5, 20]) {
      for (const confidence of [0, 0.1, 0.2, 0.29]) {
        for (const isRunningTests of [true, false]) {
          const phase = mapSensoriumToPhase(
            makeSensorium({ confidence }),
            makeCtx({ turn, isRunningTests }),
          )
          assert.notEqual(phase, 'tianshu-encore',
            `turn=${turn} confidence=${confidence} tests=${isRunningTests} 竟产出了 encore`)
        }
      }
    }
    // 活体入口仍在：kick 侧的升级判据（confidence<0.2 && complexity>0.5）。
    assert.equal(shouldEscalateFromKick(makeSensorium({ confidence: 0.1, complexity: 0.6 })), true)
    assert.equal(shouldEscalateFromKick(makeSensorium({ confidence: 0.5, complexity: 0.6 })), false)
  })

  it('computeStrategy 不请求自动升级 —— 移除上面那两条分支的前提', () => {
    // 5ae389d1 起自动升级改人工决策。若有人把这个开关改回条件式，上面那条
    // "永不产出 encore" 的护栏就失去前提，必须连带重新设计相位映射。
    for (const s of [
      makeSensorium({ confidence: 0, momentum: 0 }),
      makeSensorium({ confidence: 0.1, momentum: 0.1, stability: 0.1 }),
      makeSensorium({ confidence: 1, momentum: 1 }),
    ]) {
      assert.equal(computeStrategy(s).shouldEscalate, false)
    }
  })

  it('testing takes priority over other phases', () => {
    const s = makeSensorium({ momentum: 0.9, confidence: 0.9, complexity: 0.8, freshness: 0.9 })
    const ctx = makeCtx({ isRunningTests: true, isFinalTurn: true, isWriting: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'kaiyang-testing')
  })

  it('testing 现在是最高优先级（原先压在它上面的 encore 分支已移除）', () => {
    const s = makeSensorium({ confidence: 0.1 })
    const ctx = makeCtx({ turn: 5, isRunningTests: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'kaiyang-testing')
  })

  it('delivering takes priority over implementing', () => {
    const s = makeSensorium({ momentum: 0.9, confidence: 0.9 })
    const ctx = makeCtx({ isFinalTurn: true, isWriting: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('skips contracting when isWriting or isRunningTests', () => {
    const s = makeSensorium({ confidence: 0.8, complexity: 0.3 })
    // Writing → should be implementing, not contracting
    const writingCtx = makeCtx({ isWriting: true, isRunningTests: false, hasEnteredHighComplexity: true })
    assert.equal(mapSensoriumToPhase(s, writingCtx), 'yuheng-implementing')
    // Testing → should be testing, not contracting
    const testingCtx = makeCtx({ isWriting: false, isRunningTests: true, hasEnteredHighComplexity: true })
    assert.equal(mapSensoriumToPhase(s, testingCtx), 'kaiyang-testing')
  })

  it('defaults to locating when freshness above 0.4', () => {
    const s = makeSensorium({ freshness: 0.5 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianxuan-locating')
  })

  it('defaults to planning when freshness low', () => {
    const s = makeSensorium({ freshness: 0.2 })
    const ctx = makeCtx()
    assert.equal(mapSensoriumToPhase(s, ctx), 'tianshu-planning')
  })

  // ─── W4 momentum no-data 三态消费（2026-07-25 advisory-ecology-repair）──

  it('W4: no-data momentum 不进 delivering 臂——即使数值巧合越过 0.8', () => {
    const s = makeSensorium({ momentum: 0.9, quality: { confidence: 'measured', momentum: 'no-data', stability: 'measured', decisiveness: 'measured' } })
    const ctx = makeCtx({ isFinalTurn: true })
    assert.notEqual(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering', 'no-data 不得作为交付相证据')
  })

  it('YOLO 证据门：readyByEvidence 为真时非最终轮也可归航（复盘修复 2026-07-25）', () => {
    const s = makeSensorium({ momentum: 0.9 })
    const ctx = makeCtx({ isFinalTurn: false, readyByEvidence: true })
    assert.equal(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('YOLO 证据门：无交付证据且非最终轮 → 不归航（YOLO 原语义保持）', () => {
    const s = makeSensorium({ momentum: 0.9 })
    const ctx = makeCtx({ isFinalTurn: false, readyByEvidence: false })
    assert.notEqual(mapSensoriumToPhase(s, ctx), 'yaoguang-delivering')
  })

  it('W4: 实测高动量照常进 delivering（quality 缺省 = measured 兼容旧构造点）', () => {
    const measured = makeSensorium({ momentum: 0.9, quality: { confidence: 'measured', momentum: 'measured', stability: 'measured', decisiveness: 'measured' } })
    const legacy = makeSensorium({ momentum: 0.9 })
    const ctx = makeCtx({ isFinalTurn: true })
    assert.equal(mapSensoriumToPhase(measured, ctx), 'yaoguang-delivering')
    assert.equal(mapSensoriumToPhase(legacy, ctx), 'yaoguang-delivering')
  })
})

// ─── createStarEvent ────────────────────────────────────────────────

describe('createStarEvent', () => {
  it('creates a complete StarEvent with all fields', () => {
    const s: Sensorium = {
      momentum: 0.9, pressure: 0.3, confidence: 0.7,
      complexity: 0.3, freshness: 0.5, stability: 0.8,
    }
    const ctx: StarPhaseContext = {
      turn: 5, isFinalTurn: true, isWriting: false,
      isRunningTests: false,
      hasEnteredHighComplexity: false,
    }
    const event: StarEvent = createStarEvent(s, ctx)
    assert.equal(event.phase, 'yaoguang-delivering')
    assert.equal(event.turn, 5)
    assert.equal(typeof event.timestamp, 'number')
    assert.ok(event.label.length > 0)
    assert.ok(event.glyph.length > 0)
    assert.deepEqual(event.sensorium, s)
  })

  it('is deterministic', () => {
    const s: Sensorium = {
      momentum: 0.5, pressure: 0.3, confidence: 0.7,
      complexity: 0.3, freshness: 0.5, stability: 0.8,
    }
    const ctx: StarPhaseContext = {
      turn: 1, isFinalTurn: false, isWriting: false,
      isRunningTests: false,
      hasEnteredHighComplexity: false,
    }
    const e1 = createStarEvent(s, ctx)
    const e2 = createStarEvent({ ...s }, { ...ctx })
    assert.equal(e1.phase, e2.phase)
    assert.equal(e1.label, e2.label)
    assert.equal(e1.glyph, e2.glyph)
  })
})

// ─── Theta-Gamma Rhythm ─────────────────────────────────────────────

describe('ThetaState', () => {
  it('createThetaState initializes with given interval', () => {
    const state = createThetaState(5)
    assert.equal(state.toolCallCount, 0)
    assert.equal(state.lastThetaAt, 0)
    assert.equal(state.interval, 5)
    assert.equal(state.phase, 0)
    assert.equal(state.cycleCount, 0)
  })

  it('default interval is 7', () => {
    const state = createThetaState()
    assert.equal(state.interval, 7)
  })

  it('tickTheta returns false before interval reached', () => {
    const state = createThetaState(5)
    // Only 3 tool calls — not yet time
    const s = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))
    assert.equal(s.toolCallCount, 3)
    assert.equal(tickTheta(s, 0), false)
  })

  it('tickTheta returns true when interval reached and phase in retrieval', () => {
    const state = createThetaState(3)
    // 5 tool calls at step=1/3 → phase=1.666→0.666 (retrieval)
    const s = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))))
    assert.equal(s.toolCallCount, 5)
    assert.ok(s.phase >= 0.5, 'phase should be in retrieval')
    assert.equal(tickTheta(s, 0), true)
  })

  it('completeTheta resets lastThetaAt and wraps phase to 0', () => {
    // Use interval=5: 3 steps → phase = 3/5 = 0.6 > 0.5 (retrieval)
    const state = createThetaState(5)
    const advanced = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(state)))
    assert.ok(advanced.phase > 0, `phase should advance, got ${advanced.phase}`)
    const after = completeTheta(advanced)
    assert.equal(after.lastThetaAt, advanced.toolCallCount)
    assert.equal(after.phase, 0, 'phase should wrap to 0 after completion')
    assert.equal(after.cycleCount, 1)
    assert.equal(tickTheta(after, 0), false)
  })

  it('full cycle: advance → tick → complete → advance again', () => {
    let state = createThetaState(3)

    // 3 tool calls
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    state = advanceThetaCounter(state)
    // Phase: 3/3 = 1.0 → 0.0 (wrapped). 0.0 < 0.5 → not in retrieval
    // So tickTheta should return false because of phase gate
    assert.equal(state.phase, 0, '3 steps at 1/3 each wraps to 0')
    assert.equal(tickTheta(state, 0), false, 'not in retrieval phase')

    // 3 more calls → phase = 0.0 + 3/3 = 1.0 → 0.0 again
    // Hmm, this means at interval=3 we oscillate between 0 and 1
    // Actually step = 1/3, after 3 steps = 1.0, phase = 0.0
    // But lastThetaAt=0, toolCallCount=3, next=4 → 4>=3 true
    // Phase=0.0 < 0.5 → false
    // After completeTheta: lastThetaAt=3, phase=0
    // 3 more: toolCallCount=6, next=7, 7-3=4>=3 true, phase after 6 steps = 6/3=2.0→0.0
    // This oscillation is the intended behavior at exact interval boundaries
    
    // Let me adjust: after 4 calls (not 3), phase = 4/3 = 1.333 → 0.333 (still encoding)
    // After 5 calls, phase = 5/3 = 1.666 → 0.666 (retrieval!)
    state = advanceThetaCounter(state) // 4th call
    state = advanceThetaCounter(state) // 5th call
    assert.ok(state.phase >= 0.5, `phase should be in retrieval, got ${state.phase}`)
    assert.equal(tickTheta(state, 0), true)
    state = completeTheta(state)
    assert.equal(tickTheta(state, 0), false)
  })

  // ── Theta Phase Machine ──────────────────────────────────────────

  it('getThetaPhase returns encoding when phase < 0.5', () => {
    const state = createThetaState(7)
    assert.equal(getThetaPhase(state), 'encoding')
    // Advance phase past 0.5
    const advanced = { ...state, phase: 0.6 }
    assert.equal(getThetaPhase(advanced), 'retrieval')
  })

  it('phase advances linearly without modulation', () => {
    const state = createThetaState(10)
    // Each step = 1/10 = 0.1
    const s1 = advanceThetaCounter(state)
    assert.ok(Math.abs(s1.phase - 0.1) < 0.001, `expected ~0.1, got ${s1.phase}`)

    const s5 = advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(advanceThetaCounter(s1))))
    assert.ok(Math.abs(s5.phase - 0.5) < 0.001, `expected ~0.5, got ${s5.phase}`)
  })

  it('phase wraps and increments cycleCount', () => {
    const state = createThetaState(5)
    // 6 steps at 1/5 = 0.2 each → total 1.2, phase = 0.2, cycles = 1
    let s = state
    for (let i = 0; i < 6; i++) s = advanceThetaCounter(s)
    assert.ok(Math.abs(s.phase - 0.2) < 0.001, `expected ~0.2, got ${s.phase}`)
    assert.equal(s.cycleCount, 1)
  })

  it('high vigor slows phase advance', () => {
    const state = createThetaState(10)
    const slowPhase = advanceThetaCounter(state, { vigor: 0.9, complexity: 0.5 })
    const fastPhase = advanceThetaCounter(state, { vigor: 0.1, complexity: 0.5 })
    // High vigor → slower advance → smaller phase
    assert.ok(slowPhase.phase < fastPhase.phase,
      `high vigor phase ${slowPhase.phase} should be < low vigor phase ${fastPhase.phase}`)
  })

  it('high complexity accelerates phase advance', () => {
    const state = createThetaState(10)
    const slowPhase = advanceThetaCounter(state, { vigor: 0.5, complexity: 0.1 })
    const fastPhase = advanceThetaCounter(state, { vigor: 0.5, complexity: 0.9 })
    // High complexity → faster advance → larger phase
    assert.ok(fastPhase.phase > slowPhase.phase,
      `high complexity phase ${fastPhase.phase} should be > low complexity phase ${slowPhase.phase}`)
  })

  it('tickTheta respects phase gate — encoding phase blocks checks', () => {
    // Create state where interval is met but phase is in encoding
    const state: ThetaState = {
      toolCallCount: 10,
      lastThetaAt: 0,
      interval: 5,
      phase: 0.2,  // encoding
      cycleCount: 0,
    }
    // Interval met (10+1-0 >= 5) but phase < 0.5
    assert.equal(tickTheta(state, 0), false)
  })

  it('tickTheta allows checks when both interval and phase gates pass', () => {
    const state: ThetaState = {
      toolCallCount: 10,
      lastThetaAt: 0,
      interval: 5,
      phase: 0.7,  // retrieval
      cycleCount: 0,
    }
    assert.equal(tickTheta(state, 0), true)
  })
})

describe('plan 相位进入门禁 + 后台活动证据（2026-10-09 用户报告：写码中被误报「plan 阶段进度信号弱」）', () => {
  function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
    return { momentum: 0.5, pressure: 0.3, confidence: 0.7, complexity: 0.3, freshness: 0.5, stability: 0.8, ...overrides }
  }
  function makeCtx(overrides: Partial<StarPhaseContext> = {}): StarPhaseContext {
    return { turn: 3, isWriting: false, isRunningTests: false, isFinalTurn: false, hasEnteredHighComplexity: false, ...overrides }
  }

  it('执行/验证/交付相位不得无信号退回 plan 类相位', () => {
    for (const prev of ['yuheng-implementing', 'kaiyang-testing', 'yaoguang-delivering'] as const) {
      const s = makeSensorium({ complexity: 0.6 })
      assert.equal(mapSensoriumToPhase(s, makeCtx({ previousPhase: prev })), prev, `${prev} → plan 类退回必须被门禁挡住`)
    }
  })

  it('无上一相位（新 run 首评）时 plan 类相位正常可达', () => {
    assert.equal(mapSensoriumToPhase(makeSensorium({ complexity: 0.6 }), makeCtx()), 'tianji-decomposing')
  })

  it('探索相位向 plan 演进不受门禁影响（早期自然流）', () => {
    assert.equal(mapSensoriumToPhase(makeSensorium({ complexity: 0.6 }), makeCtx({ previousPhase: 'tianxuan-locating' })), 'tianji-decomposing')
  })

  it('后台 job 在推进时不落「规划」兜底相位', () => {
    const s = makeSensorium({ freshness: 0.3 })
    assert.equal(mapSensoriumToPhase(s, makeCtx({ backgroundWorkActive: true })), 'tianxuan-locating')
    assert.equal(mapSensoriumToPhase(s, makeCtx()), 'tianshu-planning')
  })
})
