import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeStopReason,
  formatStopReasonLog,
  stopReasonAbortTag,
  emitStopReason,
  type StopReason,
} from '../stop-reason.js'

describe('stop-reason', () => {
  describe('describeStopReason', () => {
    it('marks voluntary finishes with ✓ (not a熔断)', () => {
      assert.match(describeStopReason({ source: 'natural-finish', turn: 12, voluntary: true }), /^✓/)
      assert.match(describeStopReason({ source: 'end-turn', turn: 3, voluntary: true }), /^✓/)
    })

    it('marks guard-forced stops with ⏹ and includes the criteria', () => {
      const conv = describeStopReason({
        source: 'convergence-abort', turn: 22, voluntary: false, score: 0.05, level: 3,
      })
      assert.match(conv, /^⏹/)
      assert.match(conv, /0\.05/)
      assert.match(conv, /L3/)

      const noTool = describeStopReason({
        source: 'no-tool-abort', turn: 22, voluntary: false, noToolTurnCount: 5,
      })
      assert.match(noTool, /^⏹/)
      assert.match(noTool, /noTool=5/)
    })

    it('flags a fresh-reasoning near-miss so a likely false熔断 is visible', () => {
      const withReasoning = describeStopReason({
        source: 'no-tool-abort', turn: 22, voluntary: false, noToolTurnCount: 5, reasoningActive: true,
      })
      assert.match(withReasoning, /fresh/)
      const stale = describeStopReason({
        source: 'no-tool-abort', turn: 22, voluntary: false, noToolTurnCount: 5, reasoningActive: false,
      })
      assert.match(stale, /stale/)
    })

    it('labels max-turns as a possibly-incomplete guard stop', () => {
      assert.match(describeStopReason({ source: 'max-turns', turn: 50, voluntary: false }), /最大轮次/)
    })
  })

  describe('stopReasonAbortTag', () => {
    it('maps convergence sources to distinct onAbort tags (not colliding with watchdog)', () => {
      assert.equal(stopReasonAbortTag({ source: 'convergence-abort', turn: 1, voluntary: false }), 'convergence')
      assert.equal(stopReasonAbortTag({ source: 'no-tool-abort', turn: 1, voluntary: false }), 'convergence:no-tool')
    })

    it('returns undefined for voluntary / non-guard sources', () => {
      assert.equal(stopReasonAbortTag({ source: 'natural-finish', turn: 1, voluntary: true }), undefined)
      assert.equal(stopReasonAbortTag({ source: 'max-turns', turn: 1, voluntary: false }), undefined)
      assert.equal(stopReasonAbortTag({ source: 'user-interrupt', turn: 1, voluntary: false }), undefined)
    })
  })

  describe('formatStopReasonLog', () => {
    it('emits a single structured line with the present fields only', () => {
      const line = formatStopReasonLog({
        source: 'convergence-abort', turn: 22, voluntary: false, score: 0.05, level: 3, reasoningActive: false,
      })
      assert.match(line, /^\[stop-reason\] /)
      assert.match(line, /source=convergence-abort/)
      assert.match(line, /turn=22/)
      assert.match(line, /score=0\.05/)
      assert.doesNotMatch(line, /noTool=/, 'absent fields are omitted')
    })
  })

  describe('emitStopReason', () => {
    it('fans out to every provided channel', () => {
      const phases: Array<{ phase: string; reason?: string }> = []
      const logs: string[] = []
      const tele: Array<Record<string, unknown>> = []
      let recorded: StopReason | null = null
      const reason: StopReason = { source: 'natural-finish', turn: 4, voluntary: true }

      emitStopReason(reason, {
        onPhaseChange: (phase, detail) => phases.push({ phase, reason: detail?.reason }),
        debug: m => logs.push(m),
        telemetry: rec => tele.push(rec),
        record: r => { recorded = r },
      })

      assert.equal(phases.length, 1)
      assert.equal(phases[0]!.phase, 'stop-reason')
      assert.equal(phases[0]!.reason, describeStopReason(reason))
      assert.equal(logs.length, 1)
      assert.equal(tele.length, 1)
      assert.equal(tele[0]!['kind'], 'stop-reason')
      assert.equal(tele[0]!['source'], 'natural-finish')
      assert.equal(recorded, reason)
    })

    it('is a no-op for absent channels', () => {
      assert.doesNotThrow(() => emitStopReason({ source: 'end-turn', turn: 1, voluntary: true }, {}))
    })
  })
})
