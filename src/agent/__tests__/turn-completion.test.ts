import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnCompletionController } from '../turn-completion.js'
import { SessionContext } from '../context.js'
import { TrajectoryRecorder } from '../trajectory.js'
import { RoutingMetricsCollector } from '../../model/routing-metrics.js'
import { EvidenceTracker } from '../evidence.js'
import type { AgentConfig } from '../loop.js'

function makeConfig(): AgentConfig {
  return {
    client: { stream: async () => {} },
    promptEngine: {
      setTaskProgress: () => {},
      setDecisions: () => {},
    } as unknown as AgentConfig['promptEngine'],
    toolRegistry: {} as AgentConfig['toolRegistry'],
    maxTurns: 1,
    contextWindow: 128_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }
}

describe('TurnCompletionController', () => {
  it('runs turn-end side effects and emits final completion', async () => {
    const session = new SessionContext()
    session.addUserMessage('finish task')
    const decisions: string[][] = []
    let ledgerRefreshed = 0
    let diagnosticTurn = -1
    let postTurn = 0
    let beforeComplete = 0
    const completions: Array<{ turn: number; isFinal?: boolean; evidence?: boolean }> = []
    const texts: string[] = []

    const controller = new TurnCompletionController({
      config: makeConfig(),
      session,
      trajectory: new TrajectoryRecorder(),
      routingMetrics: new RoutingMetricsCollector(),
      evidence: new EvidenceTracker(),
      getStreamedText: () => 'plan: keep implementation simple and verify incrementally.',
      getDecisions: () => [],
      setDecisions: next => { decisions.push(next) },
      refreshLedger: () => { ledgerRefreshed++ },
      refreshCacheDiagnostic: turn => { diagnosticTurn = turn },
      runPostTurn: async () => { postTurn++ },
      runBeforeComplete: async () => { beforeComplete++ },
    })

    await controller.complete({
      turn: 7,
      isFinal: true,
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onTurnComplete: (_usage, turn, isFinal, evidence) => { completions.push({ turn, isFinal, evidence: !!evidence }) },
      },
    })

    assert.deepEqual(decisions.at(-1), ['keep implementation simple and verify incrementally'])
    assert.equal(ledgerRefreshed, 1)
    assert.equal(diagnosticTurn, 7)
    assert.equal(postTurn, 1)
    assert.equal(beforeComplete, 1)
    assert.deepEqual(completions, [{ turn: 1, isFinal: true, evidence: true }])
    assert.deepEqual(texts, [])
  })

  it('forwards continuationReason to onTurnComplete for intermediate turns', async () => {
    const session = new SessionContext()
    session.addUserMessage('finish task')
    const completions: Array<{ isFinal?: boolean; continuationReason?: string }> = []

    const controller = new TurnCompletionController({
      config: makeConfig(),
      session,
      trajectory: new TrajectoryRecorder(),
      routingMetrics: new RoutingMetricsCollector(),
      evidence: new EvidenceTracker(),
      getStreamedText: () => '',
      getDecisions: () => [],
      setDecisions: () => {},
      refreshLedger: () => {},
      refreshCacheDiagnostic: () => {},
      runPostTurn: async () => {},
    })

    await controller.complete({
      turn: 3,
      isFinal: false,
      continuationReason: 'obligation-verification',
      callbacks: {
        onTextDelta: () => {},
        onTurnComplete: (_usage, _turn, isFinal, _evidence, continuationReason) => {
          completions.push({ isFinal, continuationReason })
        },
      },
    })

    assert.deepEqual(completions, [{ isFinal: false, continuationReason: 'obligation-verification' }])
  })

  it('persists effort_shadow evidence row when the shadow reward closes', async () => {
    const session = new SessionContext()
    session.addUserMessage('finish task')
    const saved: Array<{ kind: string; json: string }> = []

    const controller = new TurnCompletionController({
      config: makeConfig(),
      session,
      trajectory: new TrajectoryRecorder(),
      routingMetrics: new RoutingMetricsCollector(),
      evidence: new EvidenceTracker(),
      getStreamedText: () => '',
      getDecisions: () => [],
      setDecisions: () => {},
      refreshLedger: () => {},
      refreshCacheDiagnostic: () => {},
      runPostTurn: async () => {},
      getEffortShadow: () => ({
        context: [0.3, 0, 0, 0, 0, 0.5],
        recommendedArm: 'delta:-1',
        ruleBaseline: 'medium',
        pendingRewardId: 'effort_test_1',
        timestamp: Date.now(),
      }),
      clearEffortShadow: () => {},
      completeEffortShadow: () => ({ reward: 0.42, recommendedArm: 'delta:-1', ruleBaseline: 'medium' }),
      saveEffortShadowRow: (kind, json) => { saved.push({ kind, json }) },
    })

    await controller.complete({
      turn: 1,
      isFinal: false,
      callbacks: { onTextDelta: () => {}, onTurnComplete: () => {} },
    })

    assert.equal(saved.length, 1)
    assert.equal(saved[0]!.kind, 'effort_shadow:effort_test_1')
    const row = JSON.parse(saved[0]!.json)
    assert.equal(row.schemaVersion, 1)
    assert.equal(row.recommendedArm, 'delta:-1')
    assert.equal(row.reward, 0.42)
  })
})
