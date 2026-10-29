import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type PersistedSession,
  type SessionEvent,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/** Never settles, so a session started with it stays genuinely running. */
class HangingAgent implements ManagedAgent {
  aborted = false
  private resolveRun?: () => void
  run(_p: string, _cb: AgentCallbacks): Promise<void> {
    return new Promise<void>((r) => { this.resolveRun = r })
  }
  abort(): void { this.aborted = true; this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_m: OaiMessage[]): void {}
  rewindToMessages(_m: OaiMessage[]): void {}
}

/** Lazy-boot adapter (the production shape) that records every write. */
class RecordingPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  appended: Array<{ id: string; type: string }> = []
  savedIds: string[] = []

  constructor(seed: PersistedSession[] = []) {
    for (const s of seed) {
      this.records.set(s.record.id, s.record)
      this.events.set(s.record.id, s.events.slice())
    }
  }
  saveRecord(record: SessionRecord): void {
    this.savedIds.push(record.id)
    this.records.set(record.id, { ...record })
  }
  appendEvent(id: string, event: SessionEvent): void {
    this.appended.push({ id, type: event.type })
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] {
    return [...this.records.values()].map((r) => ({ record: r, events: this.events.get(r.id) ?? [] }))
  }
  loadRecords(): SessionRecord[] { return [...this.records.values()].map((r) => ({ ...r })) }
  loadEvents(id: string): SessionEvent[] { return (this.events.get(id) ?? []).map((e) => ({ ...e })) }
}

function finished(id: string, status: SessionRecord['status'], updatedAt: number): PersistedSession {
  return {
    record: { id, status, createdAt: 1_000, updatedAt, cwd: '/work', lastSeq: 2, pendingApprovals: 0 },
    events: [
      { seq: 1, ts: 1_000, type: 'status', data: { status: 'running' } },
      { seq: 2, ts: updatedAt, type: 'status', data: { status } },
    ],
  }
}

function reset(p: RecordingPersistence): void {
  p.appended.length = 0
  p.savedIds.length = 0
}

test('abortAll leaves sessions that were not running completely untouched', () => {
  // rehydrate() loads every persisted session into memory, so abortAll() —
  // sidecar shutdown and the global POST /abort both call it — walks all of
  // them. It used to append a `status: aborted` marker to and re-stamp
  // updatedAt on each one, so every restart or Stop click flattened the
  // recency order the sidebar and session lists sort by.
  const seed = [
    finished('done', 'completed', 5_000),
    finished('idle', 'idle', 6_000),
    finished('stopped', 'aborted', 7_000),
  ]
  const persistence = new RecordingPersistence(seed)
  const mgr = new RuntimeSessionManager({ createAgent: () => new HangingAgent(), persistence })
  reset(persistence)

  const before = mgr.listSessions().map((s) => ({ id: s.id, status: s.status, updatedAt: s.updatedAt }))
  mgr.abortAll()

  assert.deepEqual(
    mgr.listSessions().map((s) => ({ id: s.id, status: s.status, updatedAt: s.updatedAt })),
    before,
    'timestamps and statuses must survive abortAll',
  )
  assert.deepEqual(persistence.appended, [], 'no marker events appended to finished sessions')
  assert.deepEqual(persistence.savedIds, [], 'no records rewritten')
})

test('abort on an existing idle session still reports success', () => {
  // POST /sessions/:id/abort maps false to 404, so "nothing to stop" must not
  // be confused with "no such session".
  const persistence = new RecordingPersistence([finished('done', 'completed', 5_000)])
  const mgr = new RuntimeSessionManager({ createAgent: () => new HangingAgent(), persistence })

  assert.equal(mgr.abort('done'), true, 'known session → not a 404')
  assert.equal(mgr.abort('ghost'), false, 'unknown session → 404')
})

test('abort still stops a running session and records the marker', async () => {
  const persistence = new RecordingPersistence()
  const agents: HangingAgent[] = []
  const mgr = new RuntimeSessionManager({
    createAgent: () => { const a = new HangingAgent(); agents.push(a); return a },
    persistence,
  })
  const s = mgr.createSession({ prompt: 'go' })
  assert.equal(mgr.getSession(s.id)!.status, 'running')
  for (let elapsed = 0; agents.length === 0 && elapsed < 1000; elapsed += 10) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(agents.length, 1, 'project preparation eventually starts the live agent')
  reset(persistence)

  assert.equal(mgr.abort(s.id), true)
  assert.equal(agents[0]!.aborted, true, 'the live agent is still stopped')
  assert.equal(mgr.getSession(s.id)!.status, 'aborted')
  assert.ok(
    persistence.appended.some((e) => e.id === s.id && e.type === 'status'),
    'a real abort still lands an honest status marker',
  )
  assert.ok(persistence.savedIds.includes(s.id), 'a real abort still persists the record')
})
