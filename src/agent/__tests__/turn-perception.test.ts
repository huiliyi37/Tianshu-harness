import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHookPipeline } from '../runtime-hooks.js'
import { TurnPerceptionController } from '../turn-perception.js'
import { WorkStage } from '../work-stage.js'
import type { WorkFactSnapshot, VerificationExecutionStart } from '../work-progress-facts.js'
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
    // P3：每轮 telemetry = 感知快照 + phase-source + work-stage 确认观测（3 条）。
    assert.equal(snapshots.length, 3)
    assert.ok(snapshots.some(s => (s as { kind?: string }).kind === 'phase-source'))
    assert.ok(snapshots.some(s => (s as { kind?: string }).kind === 'work-stage'))
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

// ─── P2 工作相位确认（committed）：事件与返回相位读同一确认结果 ──────────────

function p2Snap(over: Partial<WorkFactSnapshot> = {}): WorkFactSnapshot {
  return {
    modelObservationTurn: 1, taskEpoch: 0, taskStartModelTurn: 0,
    mutationRevision: 0, lastMutationSequence: -1,
    progressRevision: 0, lastProgressReason: null, lastMeaningfulProgressModelTurn: -1,
    waitingVerification: null, latestVerificationExecution: null,
    ...over,
  }
}

function p2Exec(over: Partial<VerificationExecutionStart> = {}): VerificationExecutionStart {
  return {
    sequence: 1, purpose: 'test', life: 'finite', finite: true, waitingEligible: true,
    scope: { scope: 'full', kind: 'test' }, taskEpochAtStart: 0, mutationRevisionAtStart: 0,
    modelTurnAtStart: 0, at: 0, ...over,
  }
}

function p2Controller(stage: WorkStage, records?: Array<Record<string, unknown>>) {
  return new TurnPerceptionController({
    cwd: '/tmp/project', maxTurns: 100,
    runtimeHooks: new RuntimeHookPipeline([{ phase: 'preTurn', name: 'fixture', run: ctx => {
      // confidence 高 + 写工具在窗口 → raw 候选铸形（execute）；momentum 低避免归航。
      ctx.effects.setSensorium({ momentum: 0.5, pressure: 0.2, confidence: 0.9, complexity: 0.2, freshness: 0.5, stability: 1 })
      ctx.effects.setStrategy({ reasoningEffort: 'high', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 3 })
    } }]),
    telemetryWriter: { write: row => { records?.push({ ...row }) }, flush: async () => {} },
    getRuntimeSnapshot: extra => ({ cwd: '/tmp/project', turn: 1, recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null, ...extra }),
    getProviderDegradationRatio: () => 0, addUserMessage: () => {}, requestThetaCheck: () => {},
    setReasoningEffort: () => {}, getFingerprint: () => fingerprint(),
    workStage: stage,
  })
}

describe('P2 工作相位确认（committed）', () => {
  it('编辑→验证→读日志形态：读两轮（旧写仍留窗口、raw 漂 execute）事件与返回相位保持 verify', async () => {
    const phases: string[] = []
    const controller = p2Controller(new WorkStage())
    const writeEntry = { tool: 'edit_file', status: 'success' as const, target: 'src/a.ts' }
    const readEntry = { tool: 'read_file', status: 'success' as const, target: 'src/a.ts' }
    // 第 1 轮：写码（rev 1 / seq 4）→ 弱候选铸形 → provisional 初始化 execute
    const r1 = await controller.perceive({
      ...makeInput(), modelTurn: 10, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [],
    }, { emitPhaseChange: p => phases.push(p) })
    assert.equal(r1.event.phase, 'yuheng-implementing')
    // 第 2 轮：验证启动（绑定当前版本）→ verify 即时（验证启动是活动）
    const verifyExec = p2Exec({ sequence: 5, mutationRevisionAtStart: 1, modelTurnAtStart: 11 })
    const r2 = await controller.perceive({
      ...makeInput(), modelTurn: 11,
      recentToolHistory: [writeEntry, { tool: 'run_tests', status: 'success' as const, target: 'suite', verificationAttempted: true, modelTurn: 11 }],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [verifyExec],
    }, { emitPhaseChange: p => phases.push(p) })
    assert.equal(r2.event.phase, 'kaiyang-testing')
    // 第 3/4 轮：读日志——工具窗口仍含写工具（raw 候选想翻回铸形），验证工具已出窗口。
    // committed 保持 verify：无新事实的候选翻转既不提交、也不刷新阶段计时。
    for (const t of [12, 13]) {
      const r = await controller.perceive({
        ...makeInput(), modelTurn: t, recentToolHistory: [writeEntry, readEntry],
        workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
        verificationExecutions: [verifyExec],
      }, { emitPhaseChange: p => phases.push(p) })
      assert.equal(r.event.phase, 'kaiyang-testing', `round ${t} 保持 verify`)
    }
    assert.deepEqual(phases, ['yuheng-implementing', 'kaiyang-testing', 'kaiyang-testing', 'kaiyang-testing'], '事件与返回相位同源')
    assert.equal(controller.getCurrentPhase(), 'yuheng-implementing', '原始候选仅内部记忆（观测用）')
  })

  it('真实"失败→新编辑→新验证"：execute→verify 即时往返（关联新版本）', async () => {
    const phases: string[] = []
    const controller = p2Controller(new WorkStage())
    const writeEntry = { tool: 'edit_file', status: 'success' as const, target: 'src/a.ts' }
    const verifyExec1 = p2Exec({ sequence: 5, mutationRevisionAtStart: 1, modelTurnAtStart: 11 })
    // 前两轮推到 verify（同上一用例）
    await controller.perceive({
      ...makeInput(), modelTurn: 10, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }), verificationExecutions: [],
    }, { emitPhaseChange: p => phases.push(p) })
    const verified = await controller.perceive({
      ...makeInput(), modelTurn: 11, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [verifyExec1],
    }, { emitPhaseChange: p => phases.push(p) })
    assert.equal(verified.event.phase, 'kaiyang-testing')
    // 第 3 轮：验证后的新真实写入 → execute 即时
    const reEdited = await controller.perceive({
      ...makeInput(), modelTurn: 12, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 2, lastMutationSequence: 6 }),
      verificationExecutions: [verifyExec1],
    }, { emitPhaseChange: p => phases.push(p) })
    assert.equal(reEdited.event.phase, 'yuheng-implementing')
    // 第 4 轮：新版本验证启动 → verify 即时
    const retested = await controller.perceive({
      ...makeInput(), modelTurn: 13,
      recentToolHistory: [writeEntry, { tool: 'run_tests', status: 'success' as const, target: 'suite', verificationAttempted: true, modelTurn: 13 }],
      workFactSnapshot: p2Snap({ mutationRevision: 2, lastMutationSequence: 6 }),
      verificationExecutions: [verifyExec1, p2Exec({ sequence: 7, mutationRevisionAtStart: 2, modelTurnAtStart: 13 })],
    }, { emitPhaseChange: p => phases.push(p) })
    assert.equal(retested.event.phase, 'kaiyang-testing')
    assert.deepEqual(phases, ['yuheng-implementing', 'kaiyang-testing', 'yuheng-implementing', 'kaiyang-testing'])
  })

  it('P3 观测：work-stage 确认结果落 lite 遥测（candidate/committed/source/转换/拒绝原因；不含正文与路径）', async () => {
    const records: Array<Record<string, unknown>> = []
    const controller = p2Controller(new WorkStage(), records)
    const writeEntry = { tool: 'edit_file', status: 'success' as const, target: 'private path omitted' }
    // 第 1 轮：写码 → provisional 初始化 execute
    await controller.perceive({
      ...makeInput(), modelTurn: 10, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [],
    }, { emitPhaseChange: () => {} })
    // 第 2 轮：验证启动（绑定当前版本）→ verify 切换
    await controller.perceive({
      ...makeInput(), modelTurn: 11, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [p2Exec({ sequence: 5, mutationRevisionAtStart: 1, modelTurnAtStart: 11 })],
    }, { emitPhaseChange: () => {} })

    const rows = records.filter(r => r.kind === 'work-stage')
    assert.equal(rows.length, 2, '每轮确认一条观测')
    assert.equal(rows[0]!.committed, 'execute')
    assert.equal(rows[0]!.transition, 'initialized')
    assert.equal(rows[0]!.candidate, 'execute')
    assert.equal(rows[0]!.source, 'sensorium')
    assert.equal(rows[1]!.committed, 'verify')
    assert.equal(rows[1]!.transition, 'switched')
    assert.equal(rows[1]!.reason, 'verification-started')
    assert.equal(typeof rows[1]!.entered, 'number')
    assert.ok(!JSON.stringify(rows).includes('private path'), '观测只含枚举与编号，不携带路径/正文')
  })

  it('§7 矩阵第 14 行：perception.reset 清采样但不清工作阶段——同任务续跑（自动继续/followUp 形态）保留 committed', async () => {
    const phaseChanges: string[] = []
    const controller = p2Controller(new WorkStage())
    const writeEntry = { tool: 'edit_file', status: 'success' as const, target: 'src/a.ts' }
    // 第 1 轮：写码 → provisional execute
    await controller.perceive({
      ...makeInput(), modelTurn: 10, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [],
    }, { emitPhaseChange: p => phaseChanges.push(p) })
    // 第 2 轮：验证启动 → verify
    await controller.perceive({
      ...makeInput(), modelTurn: 11, recentToolHistory: [writeEntry],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [p2Exec({ sequence: 5, mutationRevisionAtStart: 1, modelTurnAtStart: 11 })],
    }, { emitPhaseChange: p => phaseChanges.push(p) })
    // run 边界（runtime continue/compact 形态）：reset 清 Sensorium 采样
    controller.reset()
    // 新 run 首轮：读日志（写还在窗口，raw 漂 execute）。刻意不带验证执行快照——
    // 本轮无强事实可依，判定完全来自 committed 记忆：保留记忆 → 保持 verify；
    // 记忆随 run 清空 → 落新实例 provisional 初值（execute）→ 本断言红。
    const r3 = await controller.perceive({
      ...makeInput(), modelTurn: 12,
      recentToolHistory: [writeEntry, { tool: 'read_file', status: 'success' as const, target: 'src/a.ts' }],
      workFactSnapshot: p2Snap({ mutationRevision: 1, lastMutationSequence: 4 }),
      verificationExecutions: [],
    }, { emitPhaseChange: p => phaseChanges.push(p) })
    assert.equal(r3.event.phase, 'kaiyang-testing', 'reset 后同任务续跑保留工作阶段（相位记忆不随 run 清空）')
  })
})
