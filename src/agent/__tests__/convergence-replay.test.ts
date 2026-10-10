import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateConvergence, type ConvergenceInput } from '../convergence-detector.js'
import { recordConvergenceInput, replayConvergenceInput } from '../convergence-replay.js'

test('content-free scoring replay preserves signals, data quality, weights and decisions', () => {
  for (const text of [[], ['short'], Array(5).fill('同样的中文长文本'.repeat(40)),
    Array.from({ length: 5 }, (_, i) => `different report ${i} ${String.fromCharCode(97 + i).repeat(210)}`),
    Array(5).fill('repeated English description of the observed issue '.repeat(8))]) {
    const input: ConvergenceInput = { turn: 30, phaseClass: 'execute', contextWindow: 200_000,
      recentToolHistory: [
        { tool: 'bash', status: 'success', target: 'node -e "fixture command never recorded"', bashActivity: 'readonly' },
        { tool: 'grep', status: 'success', target: 'AssertionError sensitive-path-fixture' },
        { tool: 'read_file', status: 'success', target: 'fixture content never recorded' },
      ],
      textFingerprints: text, toolFingerprints: ['a', 'b', 'a', 'b'], noToolTurnCount: 2,
      runtimeAdvice: 'runtime advice stays in the live prompt', scoreRegimeKey: '1:2:required',
      evidenceState: { filesModified: new Set(['sensitive-path-fixture']), filesRead: new Set(), deliveryStatus: 'unverified' },
    }
    Object.assign(input.evidenceState, { verifications: [{ command: 'fixture command never recorded' }] })
    Object.assign(input.recentToolHistory[0]!, { error: 'fixture content never recorded' })
    const record = JSON.parse(JSON.stringify(recordConvergenceInput(input)))
    const direct = evaluateConvergence(input), replay = replayConvergenceInput(record)
    for (const field of ['score', 'signals', 'level', 'shouldAbort', 'abortCause', 'reasoningActive', 'scoreQuality', 'effectiveWeights', 'scoreRegimeKey'] as const) {
      assert.deepEqual(replay[field], direct[field], field)
    }
    assert.doesNotMatch(JSON.stringify(record), /fixture command never recorded|sensitive-path-fixture|fixture content never recorded|runtime advice stays|同样的中文长文本|repeated English description/)
    input.recentToolHistory = []
    input.evidenceState.filesModified.add('later edit')
    assert.equal(record.recentToolHistory.length, 3, 'live updates cannot rewrite a recorded boundary')
    assert.equal(record.evidenceState.filesModified.length, 1)
  }
})
