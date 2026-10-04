import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHookPipeline } from '../runtime-hooks.js'
import { TurnPerceptionController } from '../turn-perception.js'
import { createVigorState } from '../vigor.js'
import { createThetaState } from '../star-event.js'
import { createTraceStore } from '../trace-store.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { EvidenceTracker, type EvidenceState } from '../evidence.js'
import { createPerceptionRuntimeHook } from '../hooks/perception-hook.js'
import type { TelemetryWriter } from '../telemetry-writer.js'
import type { PrefixFingerprint } from '../../prompt/fingerprint.js'

function evidenceState(): EvidenceState {
  return {
    filesRead: new Set(),
    filesModified: new Set(),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
  }
}

function fingerprint(hash = 'same'): PrefixFingerprint {
  return {
    systemSha256: hash,
    toolsSha256: hash,
    stableVolatileSha256: hash,
    combinedSha256: hash,
  }
}

function makeInput(turn = 1) {
  return {
    turn,
    estimatedTokens: 100,
    pressureResult: { ratio: 0.1, tier: 0 as const, shouldCompact: false, thrashing: false, fastGrowth: false, growthRate: 0, cvmOverheadRatio: 0, shouldThrottleCvm: false },
    evidenceState: evidenceState(),
    predictionAccumulator: createPredictionAccumulator(),
    recentToolHistory: [],
    loadedPheromones: [],
    traceStore: createTraceStore(),
    gitChangeRate: 0,
    season: null,
    sensorium: null,
    strategy: null,
    vigor: createVigorState(),
    thetaState: createThetaState(7),
    thetaTelemetry: { lastReason: null, lastDurationMs: null, lastErrorCount: 0, lastTimedOut: false, requestedCount: 0 },
    thetaCheckInFlight: false,
    baselineFingerprint: fingerprint('same'),
  }
}

describe('TurnPerceptionController', () => {
  it('counts distinct verified files instead of successful commands in production perception', async () => {
    const tracker = new EvidenceTracker()
    for (const file of ['src/cache.ts', 'src/billing.ts', 'src/permissions.ts']) tracker.trackFileModified(file)
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project', maxTurns: 5,
      runtimeHooks: new RuntimeHookPipeline([createPerceptionRuntimeHook()]),
      telemetryWriter: { write: () => {}, flush: async () => {} },
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0, addUserMessage: () => {}, requestThetaCheck: () => {},
      setReasoningEffort: () => {}, getFingerprint: () => fingerprint(),
    })
    const perceive = () => controller.perceive({ ...makeInput(), evidenceState: tracker.getState() }, { emitPhaseChange: () => {} })
    for (let i = 0; i < 3; i++) tracker.trackVerification({ command: 'run_tests cache', status: 'passed', scope: 'targeted', targetFiles: ['src/cache.ts'], exitCode: 0 })
    const targeted = await perceive()
    assert.equal(targeted.sensoriumInput.evidenceState.verifiedCount, 1)
    assert.equal(targeted.sensorium.verificationCoverage, 1 / 3)
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0 })
    assert.equal((await perceive()).sensorium.verificationCoverage, 1)
    tracker.trackFileModified('src/cache.ts')
    assert.equal((await perceive()).sensoriumInput.evidenceState.verifiedCount, 2)
  })

  it('runs perception hooks, emits star phase, writes telemetry, and adapts theta interval', async () => {
    const snapshots: unknown[] = []
    const phases: string[] = []
    const writer: TelemetryWriter = { write: snapshot => { snapshots.push(snapshot) }, flush: async () => {} }
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'perception-test',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.8, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'high', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 3 })
      },
    }])
    let reasoningEffort = 'medium'
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project',
      maxTurns: 5,
      runtimeHooks,
      telemetryWriter: writer,
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0,
      addUserMessage: () => {},
      requestThetaCheck: () => {},
      setReasoningEffort: effort => { reasoningEffort = effort },
      getFingerprint: () => fingerprint('same'),
    })

    const result = await controller.perceive(makeInput(), {
      emitPhaseChange: phase => { phases.push(phase) },
    })

    assert.equal(result.sensorium.complexity, 0.8)
    assert.equal(result.sensoriumInput.fsEventRate, undefined)
    assert.equal(result.strategy.reasoningEffort, 'high')
    assert.equal(result.thetaState.interval, 3)
    assert.equal(reasoningEffort, 'high')
    assert.equal(result.event.phase, 'tianji-decomposing')
    assert.deepEqual(phases, ['tianji-decomposing'])
    assert.equal(snapshots.length, 2)
    assert.ok(snapshots.some(s => (s as { kind?: string }).kind === 'phase-source'))
    assert.equal(controller.getSnapshots().length, 1)
  })

  it('passes filesystem event rate through to sensorium input', async () => {
    let observedFsEventRate: number | undefined
    const writer: TelemetryWriter = { write: () => {}, flush: async () => {} }
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'perception-fs-rate-test',
      run: ctx => {
        observedFsEventRate = ctx.snapshot.sensoriumInput?.fsEventRate
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.1, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }])
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project',
      maxTurns: 5,
      runtimeHooks,
      telemetryWriter: writer,
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0,
      addUserMessage: () => {},
      requestThetaCheck: () => {},
      setReasoningEffort: () => {},
      getFingerprint: () => fingerprint('same'),
    })

    const result = await controller.perceive({ ...makeInput(), fsEventRate: 0.75 }, { emitPhaseChange: () => {} })

    assert.equal(result.sensoriumInput.fsEventRate, 0.75)
    assert.equal(observedFsEventRate, 0.75)
  })

  it('keeps only the latest 100 sensorium snapshots', async () => {
    const writer: TelemetryWriter = { write: () => {}, flush: async () => {} }
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'perception-test',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.1, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }])
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project',
      maxTurns: 200,
      runtimeHooks,
      telemetryWriter: writer,
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0,
      addUserMessage: () => {},
      requestThetaCheck: () => {},
      setReasoningEffort: () => {},
      getFingerprint: () => fingerprint('same'),
    })

    for (let turn = 1; turn <= 105; turn++) {
      await controller.perceive(makeInput(turn), { emitPhaseChange: () => {} })
    }

    assert.equal(controller.getSnapshots().length, 100)
    assert.equal(controller.getSnapshots()[0]!.turn, 6)
  })
})

describe('verification activity production perception', () => {
  it('propagates current/previous model-turn tests into phase and command-free telemetry, then expires', async () => {
    const records: Array<Record<string, unknown>> = []
    const controller = new TurnPerceptionController({
      cwd: '/tmp/project', maxTurns: 100, runtimeHooks: new RuntimeHookPipeline([{ phase: 'preTurn', name: 'fixture', run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.9, complexity: 0.2, freshness: 0.5, stability: 1 })
        ctx.effects.setStrategy({ reasoningEffort: 'high', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 3 })
      } }]),
      telemetryWriter: { write: row => { records.push({ ...row }) }, flush: async () => {} },
      getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
      getProviderDegradationRatio: () => 0, addUserMessage: () => {}, requestThetaCheck: () => {},
      setReasoningEffort: () => {}, getFingerprint: () => fingerprint(),
    })
    const input = { ...makeInput(), modelTurn: 42, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'private command omitted', verificationAttempted: true, modelTurn: 41 }] }
    assert.equal((await controller.perceive(input, { emitPhaseChange: () => {} })).event.phase, 'kaiyang-testing')
    const phase = records.find(r => r.kind === 'phase-source')!
    assert.equal(phase.source, 'verification-activity')
    assert.equal(phase.observedTurn, 41)
    assert.ok(!JSON.stringify(phase).includes('private command'))
    assert.notEqual((await controller.perceive({ ...input, modelTurn: 43 }, { emitPhaseChange: () => {} })).event.phase, 'kaiyang-testing')
  })
})
