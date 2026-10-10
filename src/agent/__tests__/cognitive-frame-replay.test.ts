import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCognitiveFrameRecord,
  buildCognitiveFrameLiteRecord,
  replayCognitiveFrames,
  replayStageScoreFixture,
  COGNITIVE_FRAME_KIND,
  COGNITIVE_FRAME_LITE_KIND,
  type CognitiveFrameRecord,
} from '../cognitive-frame-replay.js'
import { assembleCognitiveFrame, projectStructureFlowInputs, type CognitiveFrameInput } from '../cognitive-frame.js'
import { computeStructureFlowControl } from '../structure-flow-controller.js'
import { WorkStage } from '../work-stage.js'
import type { VerificationExecutionStart, WorkFactSnapshot } from '../work-progress-facts.js'
import { evaluateConvergence } from '../convergence-detector.js'

function frameInput(overrides: Partial<CognitiveFrameInput> = {}): CognitiveFrameInput {
  return {
    turn: 8,
    phaseClass: 'explore',
    efe: { epistemicValue: 0.15, pragmaticValue: 0.9, noveltyBonus: 0.2, precision: 0.9 },
    sensorium: { momentum: 1, momentumHasData: true, stability: 1 },
    flow: { score: 0.9, sampleCount: 4, requiredSamples: 4 },
    pal: { activeCases: 0, anyNeedsUser: false, anyStalled: false, hasPlannedProbes: false },
    evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 0 },
    user: { intervened: false },
    plan: { activePlanFile: false, planModeState: 'off' },
    progress: { todoCompletedDelta: 2 },
    ...overrides,
  }
}

/** 构造一条自洽记录：装配 → 投影 → 控制器 → 记录（经 JSON 往返模拟落盘）。 */
function consistentRecord(overrides: Partial<CognitiveFrameInput> = {}): CognitiveFrameRecord {
  const frame = assembleCognitiveFrame(frameInput(overrides))
  const inputs = projectStructureFlowInputs(frame)
  const sf = inputs ? computeStructureFlowControl(inputs) : null
  const record = buildCognitiveFrameRecord(frame, sf, { level: 0, shouldAbort: false, abortCause: undefined, messageVariant: null })
  return JSON.parse(JSON.stringify(record)) as CognitiveFrameRecord
}

describe('buildCognitiveFrameRecord / lite', () => {
  it('full 记录含 v/facts/quality/输出摘要；kind 正确', () => {
    const record = consistentRecord()
    assert.equal(record.kind, COGNITIVE_FRAME_KIND)
    assert.equal(record.v, 2)
    assert.equal(record.facts.progress.todoCompletedDelta, 2)
    assert.equal(record.quality.efe, 'measured')
    assert.equal(record.structureFlow?.mode, 'flow')
    assert.equal(record.convergence?.abortCause, null)
  })

  it('lite 记录单行 <200B，quality 压缩码按固定顺序', () => {
    const frame = assembleCognitiveFrame(frameInput({ efe: null, sensorium: null }))
    const lite = buildCognitiveFrameLiteRecord(frame, null, { level: 1, shouldAbort: false, abortCause: undefined })
    assert.equal(lite.kind, COGNITIVE_FRAME_LITE_KIND)
    assert.ok(Buffer.byteLength(JSON.stringify(lite), 'utf-8') < 200, 'lite 行必须 <200B')
    // 顺序 efe,sensorium,flow,pal,evidence,user,plan,progress → x x m m m m m m
    assert.equal(lite.q, 'xxmmmmmm')
    assert.equal(lite.fp.length, 12)
  })

  it('P3：记录可含评分口径（score/quality/effectiveWeights/regimeKey）；缺省时不写键（旧形态不变）', () => {
    const frame = assembleCognitiveFrame(frameInput())
    const withScoring = buildCognitiveFrameRecord(frame, null, {
      level: 2, shouldAbort: false, abortCause: undefined, messageVariant: null,
      score: 0.42, scoreQuality: 'ok',
      effectiveWeights: { editRatio: 0.4, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.18, tokenEfficiency: 0.08, oscillationPenalty: 0.06, textRepetitionPenalty: 0.12 },
    }, null, '1:2:required')
    assert.equal(withScoring.convergence?.score, 0.42)
    assert.equal(withScoring.convergence?.scoreQuality, 'ok')
    assert.equal(withScoring.convergence?.regimeKey, '1:2:required')
    assert.equal(withScoring.convergence?.effectiveWeights?.editRatio, 0.4)

    const legacyShape = buildCognitiveFrameRecord(frame, null, { level: 0, shouldAbort: false, abortCause: undefined, messageVariant: null })
    assert.ok(!('score' in (legacyShape.convergence ?? {})), '缺省调用不写评分口径键（旧记录形态不变）')
    assert.ok(!('regimeKey' in (legacyShape.convergence ?? {})))
  })
})

describe('replayCognitiveFrames', () => {
  it('自洽记录 → 零 divergence、零 violation；两次回放深相等（确定性）', () => {
    const records = [consistentRecord(), consistentRecord({ turn: 9, progress: { todoCompletedDelta: 1 } })]
    const a = replayCognitiveFrames(records)
    const b = replayCognitiveFrames(records)
    assert.deepEqual(a, b)
    assert.equal(a.checkedCount, 2)
    assert.deepEqual(a.divergences, [])
    assert.deepEqual(a.violations, [])
  })

  it('篡改 fact → fingerprint divergence（facts 完整性对账）', () => {
    const record = consistentRecord()
    record.facts.progress.todoCompletedDelta = 99
    const report = replayCognitiveFrames([record])
    assert.ok(report.divergences.some(d => d.field === 'inputFingerprint'))
  })

  it('篡改输出摘要 → projection divergence（重算抓到输出漂移）', () => {
    const record = consistentRecord()
    record.structureFlow = { ...record.structureFlow!, relaxation: 0.1, mode: 'balanced' }
    // 同步 fingerprint 无关——fingerprint 只覆盖 facts，输出漂移由重算比对抓。
    const report = replayCognitiveFrames([record])
    assert.ok(report.divergences.some(d => d.field === 'structureFlow.relaxation'))
    assert.ok(report.divergences.some(d => d.field === 'structureFlow.mode'))
  })

  it('EFE 缺失记录：structureFlow=null 自洽通过，turn 报 degraded 不报 healthy', () => {
    const frame = assembleCognitiveFrame(frameInput({ efe: null }))
    const record = JSON.parse(JSON.stringify(
      buildCognitiveFrameRecord(frame, null, { level: 0, shouldAbort: false, abortCause: undefined, messageVariant: null }),
    )) as CognitiveFrameRecord
    const report = replayCognitiveFrames([record])
    assert.deepEqual(report.divergences, [])
    assert.deepEqual(report.degradedTurns, [8])
  })

  it('缺 sensorium → degraded；健康记录不进 degraded', () => {
    const degraded = consistentRecord({ sensorium: null, flow: { score: null, sampleCount: 0, requiredSamples: 4 } })
    const healthy = consistentRecord({ turn: 9 })
    const report = replayCognitiveFrames([degraded, healthy])
    assert.deepEqual(report.degradedTurns, [8])
  })

  it('硬线机检：硬收紧事实为真而 relaxation>0 → violation（四类 + 连续失败）', () => {
    const cases: Array<[string, Partial<CognitiveFrameInput>]> = [
      ['pal.anyNeedsUser', { pal: { activeCases: 1, anyNeedsUser: true, anyStalled: false, hasPlannedProbes: false } }],
      ['pal.anyStalled', { pal: { activeCases: 1, anyNeedsUser: false, anyStalled: true, hasPlannedProbes: false } }],
      ['user.intervened', { user: { intervened: true } }],
      ['evidence.hasVerificationDebt', { evidence: { hasVerificationDebt: true, deliveryStatus: 'failed', consecutiveFailures: 0 } }],
      ['evidence.consecutiveFailures>=2', { evidence: { hasVerificationDebt: false, deliveryStatus: 'unverified', consecutiveFailures: 2 } }],
    ]
    for (const [name, overrides] of cases) {
      const record = consistentRecord(overrides)
      // 伪造越线输出：硬收紧事实在场却记录了 relaxation>0。
      record.structureFlow = { mode: 'flow', relaxation: 0.2, planRecommendation: 'none', tddRecommendation: 'neutral', reasons: [] }
      const report = replayCognitiveFrames([record])
      assert.ok(
        report.violations.some(v => v.rule === 'hard-tighten-bypassed' && v.detail.includes(name)),
        `${name} 应触发 hard-tighten-bypassed`,
      )
    }
  })

  it('硬线机检：relaxation 越界 [0, 0.25] → violation', () => {
    const record = consistentRecord()
    record.structureFlow = { ...record.structureFlow!, relaxation: 0.4 }
    const report = replayCognitiveFrames([record])
    assert.ok(report.violations.some(v => v.rule === 'relaxation-range'))
  })

  it('未知 schema 版本 → divergence(v)，不猜语义', () => {
    const record = consistentRecord()
    ;(record as { v: number }).v = 99
    const report = replayCognitiveFrames([record])
    assert.ok(report.divergences.some(d => d.field === 'v'))
  })

  it('无副作用：回放不修改传入记录', () => {
    const record = consistentRecord()
    const before = JSON.stringify(record)
    replayCognitiveFrames([record])
    assert.equal(JSON.stringify(record), before)
  })

  it('P3：含工作观测的帧自洽通过；缺字段旧帧报 legacy（不冒充已回放）', () => {
    const withWork = consistentRecord({
      phaseClass: 'execute',
      work: {
        committedPhase: 'execute', candidatePhase: 'execute', candidateTurns: 1, candidateSource: 'sensorium',
        transition: 'initialized', reason: 'provisional-init', taskEpoch: 1, stageEpoch: 2,
        mutationRevision: 1, progressRevision: 0, editExpectationKind: 'required', editExpectationSource: 'task-kind',
        progressAgeTurns: 3, verificationWait: 'none',
      },
    })
    const legacy = consistentRecord({ turn: 9 })
    const report = replayCognitiveFrames([withWork, legacy])
    assert.deepEqual(report.divergences, [])
    assert.deepEqual(report.violations, [])
    assert.deepEqual(report.legacyFrameTurns, [9], '缺 work 字段的旧帧报 legacy、不报失败')
    assert.deepEqual(report, replayCognitiveFrames([withWork, legacy]), '两次回放深相等（确定性）')
  })

  it('P3：work.committedPhase 与帧 phaseClass 不一致 → violation（同一确认点应同源）', () => {
    const record = consistentRecord({
      phaseClass: 'execute',
      work: {
        committedPhase: 'verify', candidatePhase: 'execute', candidateTurns: 1, candidateSource: 'sensorium',
        transition: 'switched', reason: 'verification-started', taskEpoch: 1, stageEpoch: 3,
        mutationRevision: 1, progressRevision: 0, editExpectationKind: 'required', editExpectationSource: 'task-kind',
        progressAgeTurns: 4, verificationWait: 'active',
      },
    })
    const report = replayCognitiveFrames([record])
    assert.ok(report.violations.some(v => v.rule === 'work-committed-phaseclass-mismatch'))
  })
})

describe('replayStageScoreFixture — P3 阶段/评分夹具回放', () => {
  const SNAP = (over: Partial<WorkFactSnapshot> = {}): WorkFactSnapshot => ({
    modelObservationTurn: 10, taskEpoch: 0, taskStartModelTurn: 0,
    mutationRevision: 0, lastMutationSequence: -1,
    progressRevision: 0, lastProgressReason: null, lastMeaningfulProgressModelTurn: -1,
    waitingVerification: null, latestVerificationExecution: null,
    ...over,
  })
  const EXEC = (over: Partial<VerificationExecutionStart> = {}): VerificationExecutionStart => ({
    sequence: 5, purpose: 'test', life: 'finite', finite: true, waitingEligible: true,
    scope: { scope: 'full', kind: 'test' }, taskEpochAtStart: 0, mutationRevisionAtStart: 1,
    modelTurnAtStart: 11, at: 0, ...over,
  })

  function fixtureSequence() {
    return [
      // 写码 → provisional 初始化 execute
      { confirm: { modelObservationTurn: 10, snapshot: SNAP({ mutationRevision: 1, lastMutationSequence: 4 }), verificationExecutions: [], rawCandidate: 'execute' as const, candidateSource: 'sensorium' as const, deliveryReady: false } },
      // 验证启动（关联当前版本）→ verify
      { confirm: { modelObservationTurn: 11, snapshot: SNAP({ mutationRevision: 1, lastMutationSequence: 4 }), verificationExecutions: [EXEC()], rawCandidate: 'execute' as const, candidateSource: 'sensorium' as const, deliveryReady: false } },
      // 读日志（无新事实）→ 保持 verify
      { confirm: { modelObservationTurn: 12, snapshot: SNAP({ mutationRevision: 1, lastMutationSequence: 4 }), verificationExecutions: [EXEC()], rawCandidate: 'execute' as const, candidateSource: 'sensorium' as const, deliveryReady: false } },
      // 新真实写入 → execute 即时
      { confirm: { modelObservationTurn: 13, snapshot: SNAP({ mutationRevision: 2, lastMutationSequence: 6 }), verificationExecutions: [EXEC()], rawCandidate: 'execute' as const, candidateSource: 'sensorium' as const, deliveryReady: false } },
    ]
  }

  it('确定性 + 与真实 WorkStage 对拍：同一输入序列产生相同转换（loop 装配与 replay 同源）', () => {
    const stages = fixtureSequence()
    const a = replayStageScoreFixture({ stages })
    const b = replayStageScoreFixture({ stages })
    assert.deepEqual(a, b, '两次回放深相等')

    const ws = new WorkStage()
    const direct = stages.map(f => {
      const d = ws.confirm(f.confirm)
      return `${d.committedPhase}|${d.transition}`
    })
    assert.deepEqual(a.transitions.map(t => `${t.committedPhase}|${t.transition}`), direct, 'replay 与真实确认器逐条一致')
    assert.deepEqual(a.transitions.map(t => t.committedPhase), ['execute', 'verify', 'verify', 'execute'])
    assert.equal(a.transitions[3]!.reason, 'write-after-verify')
  })

  it('缺字段不填成「正常」：snapshot=null → no-fact；editExpectation 缺席 → regime 记 none；scoreHistory 缺席 → score=null', () => {
    const result = replayStageScoreFixture({
      stages: [
        { confirm: { modelObservationTurn: 10, snapshot: null, verificationExecutions: [], rawCandidate: 'execute', candidateSource: 'sensorium', deliveryReady: false } },
        { confirm: { modelObservationTurn: 11, snapshot: SNAP(), verificationExecutions: [], rawCandidate: 'execute', candidateSource: 'sensorium', deliveryReady: false } },
      ],
    })
    assert.equal(result.transitions[0]!.transition, 'no-fact')
    assert.equal(result.transitions[0]!.committedPhase, null, '历史恢复缺事实不从候选伪造初始化')
    assert.ok(result.regimes[1]!.regimeKey.endsWith(':none'), '编辑期待缺席 → 口径键记 none，不冒充 required')
    assert.equal(result.score, null, 'scoreHistory 缺席 → 评分段不产出')
  })

  it('评分侧：同口径持续下降可判；混合口径不足不燃', () => {
    const sample = (score: number, regimeKey: string | null, quality: 'ok' | 'insufficient' = 'ok') => ({ score, regimeKey, quality })
    const declining = replayStageScoreFixture({
      stages: [],
      scoreHistory: [0.5, 0.4, 0.3, 0.2, 0.1, 0.04].map(s => sample(s, '1:2:required')),
    })
    assert.equal(declining.score?.declining, true)
    const mixed = replayStageScoreFixture({
      stages: [],
      scoreHistory: [0.9, 0.8, 0.7, 0.6].map(s => sample(s, '1:1:required'))
        .concat([sample(0.05, '1:2:required'), sample(0.04, '1:2:required')]),
    })
    assert.equal(mixed.score?.declining, false, '混合口径旧分数不构成下降证据')
  })

  it('回放从原始评分输入重算分数、等级和熔断，等待否决及缺数据均可复现', () => {
    const confirm = fixtureSequence()[0]!.confirm
    const scoring = {
      turn: 30, phaseClass: 'execute' as const, contextWindow: 200_000,
      evidenceState: { filesModified: new Set<string>(), filesRead: new Set<string>(), deliveryStatus: 'unverified' as const },
      recentToolHistory: Array.from({ length: 8 }, () => ({ tool: 'read_file', status: 'success' as const, target: 'same.ts' })),
      textFingerprints: Array.from({ length: 6 }, () => '一样的长推理内容'.repeat(50)),
      priorWarningAtL2Plus: false,
    }
    const stages = [
      { confirm, convergenceInput: scoring },
      { confirm: { ...confirm, modelObservationTurn: 11 }, convergenceInput: { ...scoring, progressBeacons: { awaitingVerification: true, todoCompletedDelta: 0, activePlan: false } } },
      { confirm: { ...confirm, modelObservationTurn: 12 }, convergenceInput: { ...scoring, recentToolHistory: [], textFingerprints: [] } },
      { confirm: { ...confirm, modelObservationTurn: 13 } },
    ]
    const replay = replayStageScoreFixture({ stages }) as any
    assert.equal(replay.scoring?.length, 4, '必须调用实际评分器，趋势摘要不足以充当评分回放')
    assert.ok(replay.scoring[0], '有原始输入时必须重算评分结果')
    assert.equal(replay.scoring[0].score, evaluateConvergence(scoring).score)
    assert.equal(replay.scoring[0].shouldAbort, false, '未送达警告保留宽限')
    assert.ok(replay.scoring[0].level >= 2)
    assert.equal(replay.scoring[1].level, 1, 'running 验证软否决')
    assert.equal(replay.scoring[2].scoreQuality, 'insufficient')
    assert.equal(replay.scoring[3], null, '缺失输入必须报告未回放')
    assert.deepEqual(replayStageScoreFixture({ stages }), replay)
  })

  it('评分回放保留真正低分熔断、实际警告宽限及不被等待否决的无工具硬上限', () => {
    const confirm = fixtureSequence()[0]!.confirm
    const convergenceInput = { turn: 30, phaseClass: 'execute' as const, contextWindow: 200_000,
      evidenceState: { filesModified: new Set<string>(), filesRead: new Set<string>(), deliveryStatus: 'unverified' as const },
      recentToolHistory: Array.from({ length: 8 }, () => ({ tool: 'read_file', status: 'failed' as const, target: 'same.ts' })),
      textFingerprints: Array.from({ length: 6 }, () => '重复的长推理文本'.repeat(50)), outputTokens: 1_000_000,
      priorWarningAtL2Plus: true }
    const stages = [{ confirm, convergenceInput }]
    const initial = replayStageScoreFixture({ stages })
    const scoreHistory = [0.5, 0.4, 0.3, 0.2, 0.1, 0.04].map(score => ({ score, regimeKey: initial.regimes[0]!.regimeKey, quality: 'ok' as const }))
    const scored = replayStageScoreFixture({ stages, scoreHistory }).scoring[0]!
    assert.ok(scored.score < 0.05)
    assert.equal(scored.shouldAbort, true)
    assert.equal(scored.abortCause, 'score')
    assert.equal(replayStageScoreFixture({ stages: [{ confirm, convergenceInput: { ...convergenceInput, priorWarningAtL2Plus: false } }], scoreHistory }).scoring[0]!.shouldAbort, false)
    const waiting = { ...convergenceInput, progressBeacons: { awaitingVerification: true, todoCompletedDelta: 0, activePlan: false } }
    assert.equal(replayStageScoreFixture({ stages: [{ confirm, convergenceInput: waiting }], scoreHistory }).scoring[0]!.shouldAbort, false)
    const hard = replayStageScoreFixture({ stages: [{ confirm, convergenceInput: { ...waiting, noToolTurnCount: 5 } }], scoreHistory }).scoring[0]!
    assert.equal(hard.shouldAbort, true)
    assert.equal(hard.abortCause, 'no-tool')
  })
})
