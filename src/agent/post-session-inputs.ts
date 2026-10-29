import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentLoop } from './loop.js'
import type { RetrospectInput } from './retrospect.js'
import type { KnowledgeCandidate } from '../memory/essence-gate.js'
import type { FailureJournal } from './failure-journal.js'

function liveCandidates(self: AgentLoop): KnowledgeCandidate[] {
  const manual = (self.config.contextClaimStore?.listClaims({ scope: ['project'] }) ?? [])
    .filter(c => c.source.sessionId === self.config.sessionId && c.source.eventId.startsWith('memory:'))
    .map(c => ({ text: c.text, kind: c.kind, confidence: c.confidence, origin: 'manual' as const,
      tags: c.tags, sessionId: self.config.sessionId }))
  return self.config.automaticMemoryReview === false ? manual : [...self.knowledgeCandidates, ...manual]
}

function liveRetrospect(self: AgentLoop): RetrospectInput {
  const es = self.evidence.getState()
  return {
    sensoriumEntries: self.sensoriumSnapshots, gitLog: [],
    toolEvents: self.traceStore.events.filter(e => e.kind === 'tool').map(e => ({ turn: e.turn, name: e.name, status: e.status === 'passed' ? 'passed' : 'failed' })),
    evidenceSummary: { filesModified: es.filesModified.size, verifiedCount: es.verifications.filter(v => v.status === 'passed').length },
    pheromoneSignals: self.loadedPheromones.map(p => ({ signal: p.signal, path: p.path, strength: p.strength })),
  }
}

function snapshotInputs(self: AgentLoop) {
  const messages = self.session.getMessages()
  const entries = structuredClone(self.failureJournal.getEntries())
  const patterns = structuredClone(self.failureJournal.detectPatterns())
  const failureJournal: FailureJournal = { record() {}, clear() {}, getEntries: () => entries,
    getRecentEntries: count => entries.slice(-count), detectPatterns: () => patterns }
  return {
    ...structuredClone({
      evidence: self.evidence.getState(), decisions: self.decisions, trajectory: self.trajectory.getEntries(),
      retrospect: liveRetrospect(self), candidates: liveCandidates(self),
      objective: self.taskContract?.objective ?? self.initialUserMessage ?? null,
      domainId: self.sessionDomain?.id ?? null, pendingMark: self.pendingLeaveMark,
      taskSummary: self.config.taskLedger?.getSummary() ?? null,
      doomLevel: self.getDoomLoopLevel(),
    }),
    transcript: messages.filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => typeof m.content === 'string' ? m.content : '').join('\n'),
    assistantText: messages.filter(m => m.role === 'assistant' && typeof m.content === 'string')
      .map(m => m.content as string).join('\n'),
    // Post-session readers receive an isolated journal, never the next run's live entries.
    failureJournal,
  }
}

type Inputs = ReturnType<typeof snapshotInputs>
const context = new AsyncLocalStorage<{ owner: AgentLoop; inputs: Inputs }>()

/** Capture synchronously, before an aborted run yields ownership to the next run. */
export function capturePostSessionInputs(self: AgentLoop): <T>(run: () => T) => T {
  const inputs = snapshotInputs(self)
  return run => context.run({ owner: self, inputs }, run)
}

export function postSessionInput<K extends keyof Inputs>(self: AgentLoop, key: K, live: () => Inputs[K]): Inputs[K] {
  const captured = context.getStore()
  return captured?.owner === self ? captured.inputs[key] : live()
}

export function postSessionCandidates(self: AgentLoop): KnowledgeCandidate[] {
  return postSessionInput(self, 'candidates', () => liveCandidates(self))
}

export function postSessionRetrospect(self: AgentLoop): RetrospectInput {
  return postSessionInput(self, 'retrospect', () => liveRetrospect(self))
}

export function addPostSessionCandidates(self: AgentLoop, candidates: KnowledgeCandidate[]): void {
  const captured = context.getStore()
  const target = captured?.owner === self ? captured.inputs.candidates : self.knowledgeCandidates
  target.push(...candidates)
  if (target.length > 60) target.splice(0, target.length - 60)
}
