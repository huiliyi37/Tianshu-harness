import type { AgentCallbacks } from './loop-types.js'
import type { OaiChatRequest } from '../api/oai-types.js'
type Shift = Parameters<NonNullable<AgentCallbacks['onDecisionShift']>>[0]

/** Candidate ids stay internal; a rendered entry is not yet a built request. */
export class DecisionShiftDelivery {
  private sequence = 0
  private pending: { id: string; turn: number; payload: Shift; text: string; taskEpoch?: number } | null = null
  private warning: { turn: number; taskEpoch?: number } | null = null
  constructor(private record: (source: string) => void, private report: (event: { kind: string } & Record<string, unknown>) => void,
    private taskEpoch?: () => number) {}

  clearWarning(): void { this.warning = null }
  warnedEarlier(turn: number): boolean {
    return this.warning !== null && this.warning.taskEpoch === this.taskEpoch?.() && this.warning.turn < turn
  }

  registerConvergence(turn: number, phase: string, relativeTurn: number, text: string, level: number): string {
    return this.register(turn, { source: 'convergence', reason: `${phase} 阶段近 ${relativeTurn} 轮进度信号弱，已提示换一种推进方式`, methods: [text.slice(0, 200)], severity: level >= 2 ? 'warn' : 'info' }, text)
  }

  register(turn: number, payload: Shift, text: string): string {
    this.discard('replaced')
    const id = `conv:${++this.sequence}`
    this.pending = { id, turn, payload, text, taskEpoch: this.taskEpoch?.() }
    return id
  }

  discard(reason: string): void {
    if (this.pending) this.report({ kind: 'decision-shift-delivery', candidateId: this.pending.id, turn: this.pending.turn, emitted: false, reason })
    this.pending = null
  }

  confirm(delivered: ReadonlyArray<{ candidateId?: string; shadow?: boolean; renderedContent?: string }>, request: OaiChatRequest, callbacks: AgentCallbacks): boolean {
    const candidate = this.pending
    if (!candidate) return false
    const matched = delivered.find(d => d.candidateId === candidate.id)
    const wire = JSON.stringify(request.messages)
    const escaped = candidate.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    const included = (matched?.renderedContent ? [matched.renderedContent] : [candidate.text, escaped]).some(text => wire.includes(JSON.stringify(text).slice(1, -1)))
    const emitted = !!matched && matched.shadow !== true && included
    this.pending = null
    this.report({ kind: 'decision-shift-delivery', candidateId: candidate.id, turn: candidate.turn, shadow: matched?.shadow === true, emitted,
      reason: emitted ? 'request-built' : !matched ? 'not-delivered' : matched.shadow ? 'holdout' : 'not-in-request' })
    if (!emitted) return false
    this.record(candidate.payload.source)
    if (candidate.payload.source === 'convergence' && candidate.payload.severity === 'warn') {
      this.warning = { turn: candidate.turn, taskEpoch: candidate.taskEpoch }
    }
    callbacks.onDecisionShift?.(candidate.payload)
    return true
  }
}
