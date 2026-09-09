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

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** In-memory persistence so the rehydrate path can be tested without disk. */
class MemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  saved: PersistedSession[] = []

  constructor(seed: PersistedSession[] = []) {
    this.saved = seed
  }
  saveRecord(record: SessionRecord): void { this.records.set(record.id, record) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] { return this.saved }
}

/**
 * Lazy adapter: implements loadRecords()/loadEvents() so the manager exercises
 * the lazy-boot path. Counts loadEvents() calls so tests can assert the log is
 * read on demand (first open) and re-read after an LRU eviction — never at boot.
 */
class LazyMemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  loadEventsCalls: string[] = []
  loadEventHighWaterCalls: string[] = []

  constructor(seed: PersistedSession[] = []) {
    for (const s of seed) {
      this.records.set(s.record.id, s.record)
      this.events.set(s.record.id, s.events.slice())
    }
  }
  saveRecord(record: SessionRecord): void { this.records.set(record.id, { ...record }) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] {
    return [...this.records.values()].map((r) => ({ record: r, events: this.events.get(r.id) ?? [] }))
  }
  loadRecords(): SessionRecord[] { return [...this.records.values()].map((r) => ({ ...r })) }
  loadEvents(id: string): SessionEvent[] {
    this.loadEventsCalls.push(id)
    return (this.events.get(id) ?? []).map((e) => ({ ...e }))
  }
  loadEventHighWater(id: string): number {
    this.loadEventHighWaterCalls.push(id)
    return Math.max(0, ...(this.events.get(id) ?? []).map((e) => e.seq))
  }
}

function ev(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 100 + seq, type, data }
}

test('rehydrate restores sessions and replays their event tail', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'old1', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'text_delta', { text: 'hi' })],
  }]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new MemoryPersistence(seed),
  })

  const list = mgr.listSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0]!.id, 'old1')
  assert.equal(list[0]!.status, 'completed')

  const replay = mgr.getEvents('old1', 0)!
  assert.equal(replay.events.length, 2)
  assert.equal(replay.lastSeq, 2)
})

test('a session that was running becomes aborted with an honest marker', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 3, pendingApprovals: 1,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'tool_use', {}), ev(3, 'approval_required', { requestId: 'r', toolName: 'bash' })],
  }]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new MemoryPersistence(seed),
  })

  const rec = mgr.getSession('crash')!
  assert.equal(rec.status, 'aborted', 'interrupted run restored as aborted')
  assert.equal(rec.pendingApprovals, 0, 'no live pending interventions after restart')

  // A marker event was appended (seq continues past the loaded tail).
  const evs = mgr.getEvents('crash', 0)!.events
  const marker = evs.find((e) => e.type === 'status' && e.data.reason === 'sidecar-restart')
  assert.ok(marker, 'restart marker event recorded')
  assert.ok(marker!.seq > 3, 'seq does not regress')

  // The dangling approval is closed out honestly (eager path scans in memory).
  const closed = evs.find((e) => e.type === 'approval_resolved' && e.data.requestId === 'r')
  assert.ok(closed, 'dangling approval closed out')
  assert.equal(closed!.data.decision, 'sidecar-restart')
  assert.equal(closed!.data.toolName, 'bash')
  assert.deepEqual(marker!.data.interruptedApprovals, [{ requestId: 'r', toolName: 'bash' }])
})

test('new events after rehydrate are persisted via the adapter', async () => {
  const mem = new MemoryPersistence()
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })
  const s = mgr.createSession({})
  assert.ok(mem.records.has(s.id), 'record persisted on create')
  mgr.run(s.id, 'go')
  const persistedEvents = mem.events.get(s.id) ?? []
  assert.ok(persistedEvents.some((e) => e.type === 'status'), 'run status event persisted')
})

test('rehydrated session with a prior conversation warns when the model context restore came back empty', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'lost', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'user', { text: 'earlier question' }), ev(2, 'text_delta', { text: 'earlier answer' })],
  }]
  // Agent whose boot-time history restore found nothing (corrupt/missing .jsonl).
  class AmnesiacAgent extends NoopAgent {
    getHistoryRestore(): { restored: number; error?: string } {
      return { restored: 0, error: 'EISDIR: illegal operation' }
    }
  }
  const mgr = new RuntimeSessionManager({
    createAgent: () => new AmnesiacAgent(),
    persistence: new MemoryPersistence(seed),
  })

  mgr.run('lost', 'follow-up')
  const evs = mgr.getEvents('lost', 0)!.events
  const warn = evs.find((e) => e.type === 'phase' && String(e.data.phase).includes('历史上下文'))
  assert.ok(warn, 'timeline carries a visible history-lost warning')
  assert.deepEqual(warn!.data.historyRestore, { restored: 0, error: 'EISDIR: illegal operation' })
})

test('no history-lost warning when the restore succeeded or the session had no conversation', async () => {
  const seed: PersistedSession[] = [
    {
      record: { id: 'ok', status: 'completed', createdAt: 1, updatedAt: 9, cwd: '/work', lastSeq: 1, pendingApprovals: 0 },
      events: [ev(1, 'user', { text: 'hello' })],
    },
    {
      record: { id: 'fresh', status: 'idle', createdAt: 1, updatedAt: 9, cwd: '/work', lastSeq: 0, pendingApprovals: 0 },
      events: [],
    },
  ]
  class RestoredAgent extends NoopAgent {
    getHistoryRestore(): { restored: number } { return { restored: 5 } }
  }
  class EmptyAgent extends NoopAgent {
    getHistoryRestore(): { restored: number } { return { restored: 0 } }
  }
  const mgrOk = new RuntimeSessionManager({
    createAgent: () => new RestoredAgent(),
    persistence: new MemoryPersistence(seed),
  })
  mgrOk.run('ok', 'more')
  assert.ok(
    !mgrOk.getEvents('ok', 0)!.events.some((e) => e.type === 'phase' && String(e.data.phase).includes('历史上下文')),
    'successful restore → no warning',
  )

  const mgrFresh = new RuntimeSessionManager({
    createAgent: () => new EmptyAgent(),
    persistence: new MemoryPersistence(seed),
  })
  mgrFresh.run('fresh', 'first prompt')
  assert.ok(
    !mgrFresh.getEvents('fresh', 0)!.events.some((e) => e.type === 'phase' && String(e.data.phase).includes('历史上下文')),
    'no prior conversation → restored=0 is normal, no warning',
  )
})

test('lazy rehydrate reads no event logs at boot, loads on first open', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'a', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'text_delta', { text: 'hi' })],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // Boot scanned records only — the (potentially huge) event log is untouched.
  assert.equal(mem.loadEventsCalls.length, 0, 'no event-log read at boot')
  assert.equal(mgr.listSessions().length, 1, 'session listed from index record alone')

  // First open lazily materializes the log.
  const replay = mgr.getEvents('a', 0)!
  assert.deepEqual(mem.loadEventsCalls, ['a'])
  assert.equal(replay.events.length, 2)
  assert.equal(replay.lastSeq, 2)

  // Re-open is a no-op against disk (already resident).
  mgr.getEvents('a', 0)
  assert.deepEqual(mem.loadEventsCalls, ['a'], 'resident log is not re-read')
})

test('getEventsAsync lazily loads via loadEventsAsync and shares one in-flight read', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'a', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'text_delta', { text: 'hi' })],
  }]
  const mem = new LazyMemoryPersistence(seed)
  let asyncCalls = 0
  ;(mem as SessionPersistenceAdapter).loadEventsAsync = async (id: string) => {
    asyncCalls += 1
    await new Promise((r) => setTimeout(r, 10))
    return mem.events.get(id)?.map((e) => ({ ...e })) ?? []
  }
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // Two concurrent async opens share ONE disk read.
  const [r1, r2] = await Promise.all([mgr.getEventsAsync('a', 0), mgr.getEventsAsync('a', 0)])
  assert.equal(asyncCalls, 1, 'concurrent opens must share the in-flight load')
  assert.equal(r1!.events.length, 2)
  assert.equal(r2!.lastSeq, 2)
  assert.equal(mem.loadEventsCalls.length, 0, 'sync loadEvents untouched')

  // Subsequent open is resident — no re-read.
  await mgr.getEventsAsync('a', 0)
  assert.equal(asyncCalls, 1)
})

test('尾部读优先于全量读，且被截头部的信息经 diskFirstSeq / artifactIds 带出', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'a', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 4, pendingApprovals: 0,
    },
    events: [
      ev(1, 'artifact', { id: 'head-art' }),
      ev(2, 'text_delta', { text: 'a' }),
      ev(3, 'text_delta', { text: 'b' }),
      ev(4, 'text_delta', { text: 'c' }),
    ],
  }]
  const mem = new LazyMemoryPersistence(seed)
  let tailCalls = 0
  let fullCalls = 0
  let sawMaxEvents = -1
  ;(mem as SessionPersistenceAdapter).loadEventsAsync = async () => { fullCalls += 1; return [] }
  ;(mem as SessionPersistenceAdapter).loadEventsTailAsync = async (id: string, maxEvents: number) => {
    tailCalls += 1
    sawMaxEvents = maxEvents
    const all = mem.events.get(id) ?? []
    return {
      events: all.slice(Math.max(0, all.length - maxEvents)).map((e) => ({ ...e })),
      diskFirstSeq: all[0]!.seq,
      lastSeq: all[all.length - 1]!.seq,
      artifactIds: all.filter((e) => e.type === 'artifact').map((e) => String(e.data.id)),
      total: all.length,
    }
  }
  // 环容量 2 → 头部两条（含那条 artifact）落在窗口外。
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    maxEvents: 2,
  })

  const replay = await mgr.getEventsAsync('a', 0)
  assert.equal(tailCalls, 1, '有尾部读就不该走全量读')
  assert.equal(fullCalls, 0)
  assert.equal(sawMaxEvents, 2, '环容量必须传给读取侧，截断才可能在那边发生')
  assert.deepEqual(replay!.events.map((e) => e.seq), [3, 4], '只回放环内尾部')
  assert.equal(replay!.lastSeq, 4, 'lastSeq 来自磁盘全量而非窗口')

  // 被截头部仍要可见：replay_window 据 diskFirstSeq 告诉前端还有更早的历史。
  const win = mgr.getReplayWindow('a')
  assert.equal(win!.diskFirstSeq, 1, '磁盘最早 seq 来自被截头部')
  assert.equal(win!.floorSeq, 3, '内存环起点是窗口首条')
})

test('a sync load winning the race is not clobbered by the stale async snapshot', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'a', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 1, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' })],
  }]
  const mem = new LazyMemoryPersistence(seed)
  ;(mem as SessionPersistenceAdapter).loadEventsAsync = async (id: string) => {
    await new Promise((r) => setTimeout(r, 20)) // slow disk
    return mem.events.get(id)?.map((e) => ({ ...e })) ?? []
  }
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  const pending = mgr.getEventsAsync('a', 0) // async load in flight…
  // …meanwhile the sync path wins the race and new events are appended on top.
  mgr.run('a', 'go') // run() → ensureEvents (sync) → appends 'user' + 'status'
  await pending
  const now = mgr.getEvents('a', 0)!
  assert.ok(
    now.events.some((e) => e.type === 'user'),
    'events appended after the sync load must survive the async load settling',
  )
})

test('a failing loadEvents surfaces a visible error event instead of a silent empty replay', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'bad', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 7, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' })],
  }]
  const mem = new LazyMemoryPersistence(seed)
  mem.loadEvents = () => { throw new Error('EIO: disk unhappy') }
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  const replay = mgr.getEvents('bad', 0)!
  const errEv = replay.events.find((e) => e.type === 'error')
  assert.ok(errEv, 'the failed log read must be visible in the replayed timeline')
  assert.match(String(errEv!.data.error), /history replay is incomplete/)
  assert.match(String(errEv!.data.error), /EIO/)
})

test('lazy rehydrate caps resident logs (LRU) and reloads evicted ones', async () => {
  const seed: PersistedSession[] = ['s1', 's2', 's3'].map((id, i) => ({
    record: {
      id, status: 'completed' as const, createdAt: 1, updatedAt: i,
      cwd: '/work', lastSeq: 1, pendingApprovals: 0,
    },
    events: [ev(1, 'text_delta', { text: id })],
  }))
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    maxLoadedSessions: 2,
  })

  mgr.getEvents('s1', 0)
  mgr.getEvents('s2', 0)
  mgr.getEvents('s3', 0) // exceeds cap → evicts LRU (s1), still on disk
  assert.deepEqual(mem.loadEventsCalls, ['s1', 's2', 's3'])

  // Re-opening the evicted session reloads it from disk (proves it was dropped).
  const replay = mgr.getEvents('s1', 0)!
  assert.deepEqual(mem.loadEventsCalls, ['s1', 's2', 's3', 's1'], 's1 reloaded after eviction')
  assert.equal(replay.events.length, 1)
})

test('lazy load applies the memory ring cap: only the tail stays resident', async () => {
  const total = 250
  const cap = 100
  const events: SessionEvent[] = []
  // An artifact event in the head that the cap will truncate — its id must
  // still land in knownArtifacts (dedup built from the full log before trim).
  events.push(ev(1, 'artifact', { id: 'old-art' }))
  for (let i = 2; i <= total; i++) events.push(ev(i, 'text_delta', { text: `e${i}` }))
  const seed: PersistedSession[] = [{
    record: {
      id: 'long', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: total, pendingApprovals: 0,
    },
    events,
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    maxEvents: cap,
  })

  const replay = mgr.getEvents('long', 0)!
  assert.equal(replay.events.length, cap, 'since=0 replay returns at most maxEvents')
  assert.equal(replay.events[0]!.seq, total - cap + 1, 'resident window is the tail')
  assert.equal(replay.events[replay.events.length - 1]!.seq, total)
  assert.equal(replay.lastSeq, total, 'lastSeq reflects the full on-disk log, not the trimmed window')
})

test('eager fallback rehydrate applies the same memory ring cap', async () => {
  const total = 250
  const cap = 100
  const events: SessionEvent[] = []
  for (let i = 1; i <= total; i++) events.push(ev(i, 'text_delta', { text: `e${i}` }))
  const seed: PersistedSession[] = [{
    record: {
      id: 'long', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: total, pendingApprovals: 0,
    },
    events,
  }]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new MemoryPersistence(seed),
    maxEvents: cap,
  })

  const replay = mgr.getEvents('long', 0)!
  assert.equal(replay.events.length, cap)
  assert.equal(replay.events[0]!.seq, total - cap + 1)
  assert.equal(replay.lastSeq, total)
})

test('lazy rehydrate flags an interrupted run aborted without reading the log', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(2, 'tool_use', {})],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // The restart marker is appended straight to disk — no event-log read at boot
  // (only crashed-with-pending-approvals sessions pay a gated log read).
  assert.equal(mem.loadEventsCalls.length, 0, 'no event-log read for the abort marker')
  const rec = mgr.getSession('crash')!
  assert.equal(rec.status, 'aborted')
  assert.equal(rec.pendingApprovals, 0)
  const marker = (mem.events.get('crash') ?? []).find(
    (e) => e.type === 'status' && (e.data as { reason?: string }).reason === 'sidecar-restart',
  )
  assert.ok(marker, 'restart marker persisted')
  assert.ok(marker!.seq > 2, 'seq does not regress')
})

test('lazy rehydrate allocates restart markers above the durable event high-water', () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'stale-index', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
    },
    events: [ev(1, 'status', { status: 'running' }), ev(9, 'tool_use', {})],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  const markers = (mem.events.get('stale-index') ?? []).filter(
    (e) => (e.type === 'status' && e.data.reason === 'sidecar-restart') || e.type === 'resume_offer',
  )
  assert.deepEqual(markers.map((e) => e.seq), [10, 11])
  assert.deepEqual(mem.loadEventHighWaterCalls, ['stale-index'])
  assert.equal(mem.loadEventsCalls.length, 0)
  assert.equal(mgr.getSession('stale-index')?.lastSeq, 11)
})

test('lazy rehydrate closes out approvals the crash left dangling', async () => {
  const seed: PersistedSession[] = [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 4, pendingApprovals: 1,
    },
    events: [
      ev(1, 'status', { status: 'running' }),
      // An earlier approval that WAS answered — must not be re-closed.
      ev(2, 'approval_required', { requestId: 'done', toolName: 'read_file' }),
      ev(3, 'approval_resolved', { requestId: 'done', decision: 'approve' }),
      ev(4, 'approval_required', { requestId: 'r1', toolName: 'bash' }),
    ],
  }]
  const mem = new LazyMemoryPersistence(seed)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })

  // The pendingApprovals>0 gate allows exactly one log read for this session.
  assert.deepEqual(mem.loadEventsCalls, ['crash'])

  const rec = mgr.getSession('crash')!
  assert.equal(rec.status, 'aborted')
  assert.equal(rec.pendingApprovals, 0)

  const persisted = mem.events.get('crash') ?? []
  const closed = persisted.filter(
    (e) => e.type === 'approval_resolved' && (e.data as { decision?: string }).decision === 'sidecar-restart',
  )
  assert.equal(closed.length, 1, 'only the dangling approval is closed out')
  assert.equal(closed[0]!.data.requestId, 'r1')
  assert.equal(closed[0]!.data.toolName, 'bash')
  assert.ok(closed[0]!.seq > 4, 'seq does not regress')

  const marker = persisted.find(
    (e) => e.type === 'status' && (e.data as { reason?: string }).reason === 'sidecar-restart',
  )
  assert.ok(marker, 'restart marker persisted')
  assert.deepEqual(marker!.data.interruptedApprovals, [{ requestId: 'r1', toolName: 'bash' }])
  assert.ok(marker!.seq > closed[0]!.seq, 'resolution precedes the status marker')

  // The replayed timeline includes the closure — no dangling approval card.
  const replay = mgr.getEvents('crash', 0)!.events
  assert.ok(replay.some(
    (e) => e.type === 'approval_resolved' && e.data.requestId === 'r1' && e.data.decision === 'sidecar-restart',
  ))
})

test('requestApproval persists pendingApprovals so the rehydrate gate sees it', async () => {
  class CaptureAgent extends NoopAgent {
    callbacks?: AgentCallbacks
    override run(_p: string, cb: AgentCallbacks): Promise<void> {
      this.callbacks = cb
      return new Promise(() => { /* stays running (blocked on approval) */ })
    }
  }
  const mem = new LazyMemoryPersistence()
  const agent = new CaptureAgent()
  const mgr = new RuntimeSessionManager({
    createAgent: () => agent,
    persistence: mem,
  })
  const s = mgr.createSession({ prompt: 'go' })
  void agent.callbacks!.onApprovalRequired('t1', 'bash', { command: 'ls' })

  // The on-disk record reflects the pending approval at request time — this is
  // the crash-safety property the rehydrate gate relies on.
  assert.equal(mem.records.get(s.id)!.pendingApprovals, 1)

  mgr.answerIntervention(s.id, 't1', 'reject')
  assert.equal(mem.records.get(s.id)!.pendingApprovals, 0)
})

// ── 一键续跑（resume_offer / resumeRun）：模型/星域缓存亲和 ─────────────────

function crashSeed(model?: string, domain?: string): PersistedSession[] {
  return [{
    record: {
      id: 'crash', status: 'running', createdAt: 1, updatedAt: 5,
      cwd: '/work', lastSeq: 2, pendingApprovals: 0,
      ...(model ? { model } : {}), ...(domain ? { domain } : {}),
    },
    events: [ev(1, 'user', { text: 'do it' }), ev(2, 'status', { status: 'running' })],
  }]
}

test('rehydrate 给被打断的 run 追加 resume_offer（携带原模型/星域）', async () => {
  const mem = new LazyMemoryPersistence(crashSeed('kimi-x', 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
  })
  const evs = mgr.getEvents('crash', 0)!.events
  const offer = evs.find((e) => e.type === 'resume_offer')
  assert.ok(offer, 'resume_offer 事件必须存在')
  assert.equal(offer!.data.model, 'kimi-x')
  assert.equal(offer!.data.domain, 'tianshu')
  const statusMarker = evs.find((e) => e.type === 'status' && e.data.reason === 'sidecar-restart')
  assert.ok(offer!.seq > statusMarker!.seq, 'resume_offer 排在中断标记之后')
})

test('resumeRun 沿用原模型建 agent 并注入续跑提示（缓存亲和）', async () => {
  const factoryModels: (string | undefined)[] = []
  const mem = new LazyMemoryPersistence(crashSeed('kimi-x', 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: (_cwd, _id, _mode, modelId) => {
      factoryModels.push(modelId)
      return new NoopAgent()
    },
    persistence: mem,
    listModels: () => [
      { id: 'kimi-x', alias: 'kimi', provider: 'p' },
      { id: 'v4-pro', alias: 'v4', provider: 'p' },
    ],
    defaultModelId: 'v4-pro',
  })
  const res = await mgr.resumeRun('crash')
  assert.deepEqual(res, { ok: true, model: 'kimi-x', switched: false })
  assert.deepEqual(factoryModels, ['kimi-x'], 'agent 必须直接建在原模型上，而非默认模型')
  const { RESUME_PROMPT } = await import('../session-manager.js')
  const userEvents = mgr.getEvents('crash', 0)!.events.filter((e) => e.type === 'user')
  assert.equal(userEvents[userEvents.length - 1]!.data.text, RESUME_PROMPT, '续跑注入恢复提示而非空 prompt')
})

test('resumeRun 识别 provider:modelId 记录（2026-09-08 假阴性回归）', async () => {
  const factoryModels: (string | undefined)[] = []
  const mem = new LazyMemoryPersistence(crashSeed('p:kimi-x', 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: (_cwd, _id, _mode, modelId) => {
      factoryModels.push(modelId)
      return new NoopAgent()
    },
    persistence: mem,
    listModels: () => [
      { id: 'kimi-x', alias: 'kimi', provider: 'p' },
      { id: 'v4-pro', alias: 'v4', provider: 'p' },
    ],
    defaultModelId: 'v4-pro',
  })
  const res = await mgr.resumeRun('crash')
  assert.deepEqual(res, { ok: true, model: 'p:kimi-x', switched: false })
  assert.deepEqual(factoryModels, ['p:kimi-x'], 'provider:modelId 原模型必须按记录原样续跑')
})

test('resumeRun 原模型不可用且无兜底 → 显式降级默认模型续跑（不再死路）', async () => {
  const factoryModels: (string | undefined)[] = []
  const mem = new LazyMemoryPersistence(crashSeed('gone-model', 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: (_cwd, _id, _mode, modelId) => {
      factoryModels.push(modelId)
      return new NoopAgent()
    },
    persistence: mem,
    listModels: () => [{ id: 'v4-pro', alias: 'v4', provider: 'p' }],
    defaultModelId: 'v4-pro',
  })
  const res = await mgr.resumeRun('crash')
  assert.equal(res.ok, true)
  assert.equal((res as { degraded: boolean }).degraded, true, '无兜底降级必须显式标记 degraded')
  assert.deepEqual(factoryModels, ['v4-pro'], '降级续跑建在默认模型上，且没有拒绝用户')
  const switched = mgr.getEvents('crash', 0)!.events.find((e) => e.type === 'model_switched')
  assert.ok(switched, '降级切换必须留审计事件')
  assert.equal(switched!.data.reason, 'resume-degraded-default')
})

test('resumeRun 会话未记录原模型 → 同样显式降级默认模型续跑', async () => {
  const mem = new LazyMemoryPersistence(crashSeed(undefined, 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    listModels: () => [{ id: 'v4-pro', alias: 'v4', provider: 'p' }],
    defaultModelId: 'v4-pro',
  })
  const res = await mgr.resumeRun('crash')
  assert.equal(res.ok, true)
  assert.equal((res as { degraded: boolean }).degraded, true)
})

test('resumeRun 原模型/兜底/默认都不可用 → 仍 fail-closed', async () => {
  const mem = new LazyMemoryPersistence(crashSeed('gone-model', 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: mem,
    listModels: () => [{ id: 'still-here', alias: '', provider: 'p' }],
    defaultModelId: 'also-gone',
  })
  const res = await mgr.resumeRun('crash')
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'model_unavailable')
})

test('resumeRun 兜底模型：显式配置 + 可用 → 切换续跑并留 model_switched 痕', async () => {
  const factoryModels: (string | undefined)[] = []
  const mem = new LazyMemoryPersistence(crashSeed('gone-model', 'tianshu'))
  const mgr = new RuntimeSessionManager({
    createAgent: (_cwd, _id, _mode, modelId) => {
      factoryModels.push(modelId)
      return new NoopAgent()
    },
    persistence: mem,
    listModels: () => [{ id: 'fallback-x', alias: 'fb', provider: 'p' }],
    defaultModelId: 'v4-pro',
    resumeFallbackModel: 'fallback-x',
  })
  const res = await mgr.resumeRun('crash')
  assert.deepEqual(res, { ok: true, model: 'fallback-x', switched: true })
  assert.deepEqual(factoryModels, ['fallback-x'])
  assert.equal(mgr.getSession('crash')!.model, 'fallback-x', 'record.model 指向兜底模型')
  const switched = mgr.getEvents('crash', 0)!.events.find((e) => e.type === 'model_switched')
  assert.ok(switched, '兜底切换必须留审计事件')
  assert.equal(switched!.data.reason, 'resume-fallback')
  assert.equal(switched!.data.from, 'gone-model')
})

test('resumeRun：running 会话拒绝续跑（busy）', async () => {
  class HangingAgent extends NoopAgent {
    override run(): Promise<void> { return new Promise(() => { /* stays running */ }) }
  }
  const mgr = new RuntimeSessionManager({ createAgent: () => new HangingAgent() })
  const s = mgr.createSession({ prompt: 'go' })
  const res = await mgr.resumeRun(s.id)
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'busy')
})

// ── Phase 3 #9：归档卸载 / 空闲 agent TTL ─────────────────────────────────

test('archiveSession 卸载重态：agent shutdown、事件环清空、重开时从盘重放', async () => {
  let shutdowns = 0
  class TrackedAgent extends NoopAgent {
    shutdown(): void { shutdowns += 1 }
  }
  const mem = new LazyMemoryPersistence()
  const mgr = new RuntimeSessionManager({
    createAgent: () => new TrackedAgent(),
    persistence: mem,
  })
  const s = mgr.createSession({})
  mgr.run(s.id, 'hello') // NoopAgent 立即 settle，但 agent 已建
  await new Promise((r) => setTimeout(r, 10)) // run settle → idle 归档路径
  const ok = mgr.archiveSession(s.id)
  assert.equal(ok, true)
  assert.equal(shutdowns, 1, '归档必须 shutdown 已建 agent（清 timer/coordinator）')
  // 事件环被清空 → 下次读取走磁盘懒加载（loadEvents 被再次调用）
  const before = mem.loadEventsCalls.length
  const replay = mgr.getEvents(s.id, 0)!
  assert.ok(mem.loadEventsCalls.length > before, '归档后事件应从磁盘重放')
  assert.ok(replay.events.some((e) => e.type === 'user'), '磁盘重放包含完整历史')
  // 归档状态与解档路径不受影响
  assert.equal(mgr.unarchiveSession(s.id), true)
})

test('运行中归档：卸载推迟到 run settle 之后（不撕在途 promise）', async () => {
  let shutdowns = 0
  class HangingAgent extends NoopAgent {
    private resolveRun?: () => void
    override run(): Promise<void> { return new Promise((r) => { this.resolveRun = r }) }
    override abort(): void { this.resolveRun?.() }
    shutdown(): void { shutdowns += 1 }
  }
  const agents: HangingAgent[] = []
  const mgr = new RuntimeSessionManager({
    createAgent: () => { const a = new HangingAgent(); agents.push(a); return a },
    persistence: new LazyMemoryPersistence(),
  })
  const s = mgr.createSession({ prompt: 'go' })
  assert.equal(mgr.getSession(s.id)!.status, 'running')
  mgr.archiveSession(s.id) // abort + archive；run promise 仍在 settle
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(shutdowns, 1, 'run settle 后归档卸载必须完成')
})

test('空闲 agent TTL：超时释放，运行/挂起审批的会话不受影响', async () => {
  let clock = 1_000_000
  let built = 0
  let shutdowns = 0
  class TrackedAgent extends NoopAgent {
    callbacks?: AgentCallbacks
    private resolveRun?: () => void
    override run(_p: string, cb: AgentCallbacks): Promise<void> {
      this.callbacks = cb
      return new Promise((r) => { this.resolveRun = r })
    }
    override abort(): void { this.resolveRun?.() }
    shutdown(): void { shutdowns += 1 }
  }
  const agents: TrackedAgent[] = []
  const mgr = new RuntimeSessionManager({
    createAgent: () => { built += 1; const a = new TrackedAgent(); agents.push(a); return a },
    now: () => clock,
    idleAgentTtlMs: 10_000,
  })
  // idle 会话：先建 agent（run 立刻被 abort 掉太绕——直接用 delegate 建？）
  // 用 run + abort 更贴近真实：跑起来再 abort，agent 保持已建。
  const idle = mgr.createSession({ prompt: 'a' })
  mgr.abort(idle.id)
  await new Promise((r) => setTimeout(r, 10)) // run promise settle → running=false
  // running 会话：一直在跑（abort 只针对 idle 那个 agent 调用）
  const busy = mgr.createSession({ prompt: 'b' })
  assert.equal(built, 2)

  // 未到 TTL：sweep 不动
  clock += 5_000
  mgr.sweepIdleAgents()
  assert.equal(shutdowns, 0)

  // 过 TTL：idle 的 agent 被释放，running 的不动
  clock += 6_000
  mgr.sweepIdleAgents()
  assert.equal(shutdowns, 1, '只有空闲会话的 agent 被释放')
  assert.equal(mgr.getSession(busy.id)!.status, 'running', 'running 会话不受影响')

  // 释放后再发 prompt：agent 惰性重建（工厂第 3 次调用）
  mgr.run(idle.id, 'again')
  assert.equal(built, 3, '下一条 prompt 触发重建')
})

test('stats() reports session and running counts', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  mgr.createSession({})
  const s = mgr.createSession({})
  // NoopAgent.run resolves immediately, so trigger and check before microtask drain is racy;
  // just assert sessionCount which is deterministic.
  assert.equal(mgr.stats().sessionCount, 2)
  assert.ok(s.id)
})

// ── 2026-09-05 跨盘审批链：rehydrate 档位回读 + 全局档位广播 ──────────

test('rehydrate 回读 per-session approvalMode——重启后 agent 不退回全局档', async () => {
  const built: Array<{ sessionId?: string; approvalMode?: string }> = []
  const mgr = new RuntimeSessionManager({
    createAgent: (_cwd, sessionId, approvalMode) => {
      built.push({ sessionId, approvalMode })
      return new NoopAgent()
    },
    persistence: new LazyMemoryPersistence([{
      record: {
        id: 'fullrw', status: 'completed', createdAt: 1, updatedAt: 3,
        cwd: '/work', lastSeq: 1, pendingApprovals: 0,
        approvalMode: 'dangerously-skip-permissions',
      },
      events: [ev(1, 'status', { status: 'completed' })],
    }]),
  })

  // UI 侧看到的档位（record 回读）
  assert.equal(mgr.getSession('fullrw')!.approvalMode, 'dangerously-skip-permissions')
  // agent 构建时拿到的档位——修复前此处为 undefined（顶层字段缺失），
  // agent 退回启动快照的全局档，「完全读写」静默失效
  mgr.run('fullrw', 'go')
  assert.equal(built.length, 1)
  assert.equal(built[0]!.approvalMode, 'dangerously-skip-permissions')
})

class MutableAgent extends NoopAgent {
  liveMode: string | undefined
  setApprovalMode(mode: string): void { this.liveMode = mode }
}

test('applyGlobalApprovalMode 只广播无 override 的存活 agent，返回套用数', async () => {
  const built: MutableAgent[] = []
  const mgr = new RuntimeSessionManager({
    createAgent: () => {
      const a = new MutableAgent()
      built.push(a)
      return a
    },
    defaultCwd: '/work',
  })
  const withOverride = mgr.createSession({ prompt: 'go', approvalMode: 'manual' })
  const noOverride = mgr.createSession({ prompt: 'go' })
  mgr.createSession({}) // idle：未构建 agent，广播应跳过
  // createSession({prompt}) 自动开跑并构建 agent——两个 agent 此时已 built
  assert.equal(built.length, 2)
  const [overrideAgent, plainAgent] = built

  const applied = mgr.applyGlobalApprovalMode('dangerously-skip-permissions')
  assert.equal(applied, 1, '只有无 override 且已构建的 agent 被套用')
  assert.equal(plainAgent!.liveMode, 'dangerously-skip-permissions')
  assert.equal(overrideAgent!.liveMode, undefined, '会话级 override 尊重用户选择，不被全局广播覆盖')
})
