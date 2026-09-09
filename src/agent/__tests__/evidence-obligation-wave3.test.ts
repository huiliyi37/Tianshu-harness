import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyControlPlaneFrame,
  reduceControlSignals,
  type ControlSignal,
} from '../control-plane.js'
import { signalsFromObligations, signalsFromVerifiedResults } from '../control-plane-adapters.js'
import { ObligationTracker } from '../obligation-tracker.js'
import { createObligation, upsertObligation, emptyObligationStore, blockObligation, deriveObligationId } from '../evidence-obligation.js'
import { createCognitiveLedger, buildCognitiveProjectionParts } from '../../context/cognitive-ledger.js'
import type { EvidenceState } from '../evidence.js'
import { createSelfVerifyHook } from '../hooks/self-verify-hook.js'
import type { WorkerResult } from '../work-order.js'

function gateSignal(key: string, kind: ControlSignal['kind']): ControlSignal {
  return {
    key,
    kind,
    severity: 'attention',
    summary: `${key} summary`,
    requiresDecision: true,
    ttlTurns: 2,
    cacheImpact: 'none',
  }
}

describe('control-plane focus split by gate kind (Wave 3)', () => {
  it('obligation-only decision gates route focus to verify/inspect, not await-user', () => {
    const verify = reduceControlSignals(emptyControlPlaneFrame(), [gateSignal('obligation:verify:ob_1', 'obligation')])
    assert.equal(verify.focus, 'verify')
    assert.equal(verify.decisionGates.length, 1)

    const inspect = reduceControlSignals(emptyControlPlaneFrame(), [gateSignal('obligation:inspect:ob_2', 'obligation')])
    assert.equal(inspect.focus, 'inspect')
  })

  it('mixed gates: any non-obligation gate keeps await-user (no regression)', () => {
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      gateSignal('obligation:verify:ob_1', 'obligation'),
      gateSignal('worker:false-green:wo1', 'worker'),
    ])
    assert.equal(frame.focus, 'await-user')
  })

  it('worker timeout / verification gates still produce await-user', () => {
    const worker = reduceControlSignals(emptyControlPlaneFrame(), [gateSignal('worker:blocked:wo1', 'worker')])
    assert.equal(worker.focus, 'await-user')
    const verification = reduceControlSignals(emptyControlPlaneFrame(), [gateSignal('worker:unverified:wo2', 'verification')])
    assert.equal(verification.focus, 'await-user')
  })
})

describe('signalsFromObligations (Wave 3 adapter)', () => {
  it('high open → decision gate with obligation kind and verify/inspect key verb', () => {
    let store = emptyObligationStore()
    store = upsertObligation(store, { family: 'bugfix', claim: '缺陷已复现', targets: ['src/a.ts'], risk: 'high' })
    store = upsertObligation(store, { family: 'existence', claim: 'X 存在', targets: ['src/b.ts'], risk: 'high' })
    const signals = signalsFromObligations(store)
    assert.equal(signals.length, 2)
    const bugfix = signals.find(s => s.summary.includes('缺陷已复现'))!
    assert.equal(bugfix.kind, 'obligation')
    assert.equal(bugfix.requiresDecision, true)
    assert.ok(bugfix.key.startsWith('obligation:verify:'))
    const existence = signals.find(s => s.summary.includes('X 存在'))!
    assert.ok(existence.key.startsWith('obligation:inspect:'))
  })

  it('medium → status lane (single voice: the projection block is the model-visible copy); low → no signal', () => {
    let store = emptyObligationStore()
    store = upsertObligation(store, { family: 'behavior', claim: '诊断结论待交叉验证', risk: 'medium' })
    store = upsertObligation(store, { family: 'existence', claim: '小改动', risk: 'low' })
    const signals = signalsFromObligations(store)
    assert.equal(signals.length, 1)
    assert.equal(signals[0]!.requiresDecision, false)
    assert.equal(signals[0]!.routeHint, 'status')
  })

  it('high blocked → status disclosure, not a decision gate', () => {
    let store = emptyObligationStore()
    const ob = createObligation({ family: 'bugfix', claim: '需要 staging 复现', risk: 'high' })
    store = { obligations: [ob] }
    store = blockObligation(store, ob.id, 'no_staging_access')
    const signals = signalsFromObligations(store)
    assert.equal(signals.length, 1)
    assert.equal(signals[0]!.requiresDecision, false)
    assert.ok(signals[0]!.key.startsWith('obligation:blocked:'))
    assert.match(signals[0]!.summary, /未验证/)
  })

  it('byte-stable: identical store state → identical signals (revision quiet)', () => {
    let store = emptyObligationStore()
    store = upsertObligation(store, { family: 'delivery', claim: '代码已验证', risk: 'high' })
    const a = signalsFromObligations(store)
    const b = signalsFromObligations(store)
    assert.deepEqual(a, b)
    const frame1 = reduceControlSignals(emptyControlPlaneFrame(), a)
    const frame2 = reduceControlSignals(frame1, b)
    assert.equal(frame1.revision, frame2.revision)
  })
})

describe('worker_claim_single_voice (Wave 3)', () => {
  const unverifiedWrite: WorkerResult = {
    workOrderId: 'wo-1',
    status: 'passed',
    summary: 'wrote code',
    findings: [],
    artifacts: [],
    changedFiles: ['src/x.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
  }

  it('without obligationVoice: unverified write claim is a decision gate (legacy)', () => {
    const [signal] = signalsFromVerifiedResults([unverifiedWrite])
    assert.equal(signal!.requiresDecision, true)
    assert.equal(signal!.kind, 'verification')
  })

  it('with obligationVoice: same fact degrades to status — obligation is the only voice', () => {
    const [signal] = signalsFromVerifiedResults([unverifiedWrite], { obligationVoice: true })
    assert.equal(signal!.requiresDecision, false)
    assert.equal(signal!.routeHint, 'status')
    assert.match(signal!.summary, /external_claim obligation/)
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [signal!])
    assert.equal(frame.decisionGates.length, 0)
    assert.notEqual(frame.focus, 'await-user')
  })
})

describe('cognitive ledger obligation block (Wave 3)', () => {
  function makeEvidence(modified: string[]): EvidenceState {
    return {
      filesRead: new Set<string>(),
      filesModified: new Set(modified),
      verifications: [],
      deliveryStatus: 'unverified',
      impactedFiles: new Set<string>(),
      impactedTests: new Set<string>(),
    }
  }
  const trace = { entries: [] } as never

  it('non-empty obligation block replaces the generic verification-gap line', () => {
    const tracker = new ObligationTracker()
    tracker.upsert({ family: 'delivery', claim: '本任务修改的代码已通过相关验证', risk: 'high' })
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(['src/a.ts']),
      trace,
      turn: 3,
      obligationBlock: tracker.renderBlock(),
    })
    const { stable } = buildCognitiveProjectionParts(ledger)
    assert.match(stable, /<evidence-obligation /)
    assert.doesNotMatch(stable, /<verification-gap /)
  })

  it('empty obligation block falls back to verification-gap (no regression)', () => {
    const ledger = createCognitiveLedger({
      evidence: makeEvidence(['src/a.ts']),
      trace,
      turn: 3,
      obligationBlock: '',
    })
    const { stable } = buildCognitiveProjectionParts(ledger)
    assert.match(stable, /<verification-gap /)
  })
})

describe('ObligationTracker version (misfire telemetry basis)', () => {
  it('bumps on state change, stays put on no-op transforms', () => {
    const tracker = new ObligationTracker()
    assert.equal(tracker.getVersion(), 0)
    const id = tracker.upsert({ family: 'bugfix', claim: 'bug', targets: ['src/a.ts'], risk: 'high' })
    assert.equal(tracker.getVersion(), 1)
    // Idempotent upsert (same id, same risk) — reducer returns same store ref.
    tracker.upsert({ family: 'bugfix', claim: 'bug', targets: ['src/a.ts'], risk: 'high' })
    assert.equal(tracker.getVersion(), 1)
    tracker.recordAttempt(id, { evidenceRef: 'probe:read_file:src/a.ts' })
    assert.equal(tracker.getVersion(), 2)
    // Probe on an unrelated target: no matching obligation → no change.
    tracker.applyProbe({ tool: 'read_file', target: 'src/zzz.ts' })
    assert.equal(tracker.getVersion(), 2)
  })

  it('final gate ladder: continue_once → markContinued → honest_blocked downgrade', () => {
    const tracker = new ObligationTracker()
    tracker.upsert({ family: 'bugfix', claim: '缺陷已复现并修复', targets: ['src/a.ts'], risk: 'high' })
    const first = tracker.evaluateFinal()
    assert.equal(first.verdict, 'continue_once')
    assert.ok(first.nextAction)
    tracker.markContinued(first.nextAction!.obligationId)
    const second = tracker.evaluateFinal()
    assert.equal(second.verdict, 'honest_blocked')
    assert.equal(second.alreadyContinued, true)
  })

  it('low/medium obligations never gate the final (low_risk_small_edit_never_gates_final)', () => {
    const tracker = new ObligationTracker()
    tracker.upsert({ family: 'regression', claim: '重构未破坏行为', risk: 'medium' })
    tracker.upsert({ family: 'existence', claim: '小编辑', risk: 'low' })
    assert.equal(tracker.evaluateFinal().verdict, 'allow')
  })
})

describe('self-verify hook obligation supersede (Wave 3)', () => {
  function runHook(opts: { withObligation: boolean }) {
    const advisories: string[] = []
    const controlSignals: ControlSignal[] = []
    const tracker = new ObligationTracker()
    if (opts.withObligation) {
      tracker.upsert({ family: 'delivery', claim: '代码已验证', risk: 'high' })
    }
    const hook = createSelfVerifyHook({
      advisoryBus: { submit: a => { advisories.push(a.key) } },
      submitControlSignal: s => { controlSignals.push(s) },
      obligations: tracker,
    })
    hook.run({
      snapshot: {
        turn: 5,
        recentToolHistory: [
          { tool: 'read_file', target: 'src/a.ts', turn: 4 },
          { tool: 'edit_file', target: 'src/a.ts', turn: 4 },
        ],
      },
      effects: {},
    } as never)
    return { advisories, controlSignals }
  }

  it('active high delivery obligation → structured signal only, no duplicate advisory', () => {
    const { advisories, controlSignals } = runHook({ withObligation: true })
    assert.equal(controlSignals.length, 1)
    assert.equal(controlSignals[0]!.kind, 'verification')
    assert.ok(!advisories.includes('self-verify'))
  })

  it('no obligation → legacy advisory still fires', () => {
    const { advisories } = runHook({ withObligation: false })
    assert.ok(advisories.includes('self-verify'))
  })
})

describe('obligation id stability across sessions (cache discipline)', () => {
  it('same family+claim+targets → same id regardless of target order/slashes', () => {
    const a = deriveObligationId('bugfix', ' 修复  崩溃 ', ['src\\b.ts', 'src/a.ts'])
    const b = deriveObligationId('bugfix', '修复 崩溃', ['src/a.ts', 'src/b.ts'])
    assert.equal(a, b)
  })
})
