import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Flush enough event-loop iterations to cover setImmediate + setTimeout(0)
 *  (watchdog auto-continue's two-stage timer chain). Old settle(5) was too
 *  short when maybeWatchdogAutoContinue gained a setImmediate→setTimeout(0) hop. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
}

/** 轮询到条件成立。比固定 sleep 抗负载：机器繁忙时定时器晚触发不该判失败。 */
const waitUntil = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未成立`)
}
import {
  RuntimeSessionManager,
  extractObjective,
  type ManagedAgent,
  type ModelOption,
  type DelegateActivityUpdate,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ActiveStarDomain } from '../../agent/star-domain.js'

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  aborted = false
  artifacts: Artifact[] = []
  /** Rewind: in-memory message store for testing. */
  messages: OaiMessage[] = []
  /** S — captures the mode this agent was built with + any live switches. */
  builtApprovalMode?: string
  liveApprovalMode?: string
  /** 每次 run 收到的 prompt，按序记录（含自动续跑注入的 'continue'）。 */
  prompts: string[] = []
  private resolveRun?: () => void

  run(prompt: string, cb: AgentCallbacks): Promise<void> {
    this.prompts.push(prompt)
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  finish(): void { this.resolveRun?.() }
  abort(): void {
    this.aborted = true
    this.callbacks?.onAbort()
    this.resolveRun?.()
  }
  /** 模拟 agent 内部 watchdog 自中止：带 reason 的 onAbort + run settle。
   *  与 abort()（用户中止，无 reason）区分——manager.abort 不走这条路。 */
  watchdogAbort(reason = 'watchdog:goal'): void {
    this.callbacks?.onAbort(reason)
    this.resolveRun?.()
  }
  setApprovalMode(mode: string): void { this.liveApprovalMode = mode }
  listArtifacts(): Artifact[] { return this.artifacts }
  readArtifact(id: string): Promise<string | null> {
    return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null)
  }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  /** P0-2: optional — plan_task onToolResult reads this to emit todo_state */
  getTodos?: () => Array<{ id: string; content: string; status: string }>
}

function makeArtifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    tool: 'read_file',
    target: 'foo.ts',
    sessionId: 's',
    createdAt: 1,
    summary: 'sum',
    sections: [],
    rawPath: `/tmp/${id}.raw`,
    charCount: 10,
    lineCount: 2,
    sha256: 'x',
    ...over,
  }
}

function makeManager(opts: { watchdogContinueDelayMs?: number } = {}) {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
    // C2 倒计时默认 5s——测试里压到 0（setImmediate+setTimeout(0) 仍被 settle 覆盖），
    // 倒计时行为本身由专门用例以小延迟验证。
    watchdogContinueDelayMs: opts.watchdogContinueDelayMs ?? 0,
  })
  return { manager, agents }
}

test('createSession with prompt starts running; without prompt stays idle', async () => {
  const { manager } = makeManager()
  const idle = manager.createSession({})
  assert.equal(idle.status, 'idle')

  const live = manager.createSession({ prompt: 'go' })
  assert.equal(live.status, 'running')
  assert.notEqual(idle.id, live.id)
})

test('sameCwdRunningCount counts running sessions per cwd (VSW §6)', async () => {
  const { manager } = makeManager()
  const a = manager.createSession({ prompt: 'a', cwd: '/repo/x' })
  manager.createSession({ prompt: 'b', cwd: '/repo/x' })
  manager.createSession({ prompt: 'c', cwd: '/repo/y' })
  manager.createSession({ cwd: '/repo/x' }) // idle, not running

  // 2 running in /repo/x, 1 in /repo/y
  assert.equal(manager.sameCwdRunningCount('/repo/x'), 2)
  assert.equal(manager.sameCwdRunningCount('/repo/y'), 1)
  assert.equal(manager.sameCwdRunningCount('/repo/z'), 0)

  // excluding self yields "other concurrent sessions" → 1
  assert.equal(manager.sameCwdRunningCount('/repo/x', a.id), 1)

  // path forms of the same cwd resolve equal
  assert.equal(manager.sameCwdRunningCount('/repo/x/'), 2)
})

test('sameCwdRunningCount drops sessions once they finish', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'a', cwd: '/repo/q' })
  manager.createSession({ prompt: 'b', cwd: '/repo/q' })
  assert.equal(manager.sameCwdRunningCount('/repo/q'), 2)
  agents[0]!.finish()
  // The running flag clears in the run-completion handler (a microtask).
  await new Promise((r) => setImmediate(r))
  assert.equal(manager.sameCwdRunningCount('/repo/q'), 1)
})

test('two parallel sessions have distinct ids and abort is isolated', async () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  const b = manager.createSession({ prompt: 'b' })
  assert.notEqual(a.id, b.id)

  manager.abort(a.id)
  assert.equal(agents[0]!.aborted, true)
  assert.equal(agents[1]!.aborted, false, 'aborting A must not touch B')
  assert.equal(manager.getSession(a.id)!.status, 'aborted')
  assert.equal(manager.getSession(b.id)!.status, 'running')
})

test('unsubscribing an event viewer does NOT abort the session', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const stop = manager.subscribe(s.id, () => {})
  assert.ok(stop)
  stop!()
  assert.equal(agents[0]!.aborted, false)
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('getEvents(since) replays only newer events with monotonic seq', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onTextDelta('hello ')
  cb.onTextDelta('world')

  const all = manager.getEvents(s.id, 0)!
  // status(running) + 2 text deltas
  assert.ok(all.events.length >= 3)
  const seqs = all.events.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'seq must be monotonic')

  const since = all.lastSeq
  cb.onTextDelta('!')
  const tail = manager.getEvents(s.id, since)!
  assert.equal(tail.events.length, 1)
  assert.equal(tail.events[0]!.data.text, '!')
  assert.ok(tail.events[0]!.seq > since)
})

test('domain resolution callback appends a redacted replayable event', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go', domain: 'auto' })
  const cb = agents[0]!.callbacks!

  cb.onDomainResolved!({
    key: 'kaiyang',
    name: '开阳 token=server-secret',
    matchedKeywords: ['对账', 'token=keyword-secret', '插桩', '不得保留'],
    reason: 'keyword',
  })

  const replay = manager.getEvents(s.id, 0)!
  const event = replay.events.find((candidate) => candidate.type === 'domain_resolved')
  assert.ok(event, 'domain_resolved must be retained in normal event replay')
  assert.deepEqual(event.data, {
    key: 'kaiyang',
    name: '开阳 token=[REDACTED]',
    matchedKeywords: ['对账', 'token=[REDACTED]', '插桩'],
    reason: 'keyword',
  })
  assert.equal(manager.getSession(s.id)!.domain, 'auto', 'observability must not replace the Auto selection key')
})

test('domain drift callback appends a redacted replayable SSE event', () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go', domain: 'auto' })

  agents[0]!.callbacks!.onDomainDrift!({
    currentId: 'tianliang',
    currentName: '天梁 token=current-secret',
    recommendedId: 'tianquan',
    recommendedName: '天权 token=recommended-secret',
    matchedKeywords: ['审查', 'token=keyword-secret', '方案', '评估', '不得保留'],
  })

  const event = manager.getEvents(s.id, 0)!.events.find((candidate) => candidate.type === 'domain_drift')
  assert.ok(event)
  assert.deepEqual(event.data, {
    currentId: 'tianliang',
    currentName: '天梁 token=[REDACTED]',
    recommendedId: 'tianquan',
    recommendedName: '天权 token=[REDACTED]',
    matchedKeywords: ['审查', 'token=[REDACTED]', '方案', '评估'],
  })
})

// Redaction now lives ONLY here (the legacy /prompt route forwards manager
// events verbatim since its session rebase) — this is the single trust boundary
// keeping secrets out of event logs and every SSE stream.
test('manager redacts sensitive tool input and error text before they reach the event log', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('id-1', 'bash', { command: 'curl api', api_key: 'sk-super-secret' })
  cb.onError(new Error('upstream 401 token=server-secret'))

  const events = manager.getEvents(s.id, 0)!.events
  const toolUse = events.find((e) => e.type === 'tool_use')!
  assert.equal((toolUse.data.input as Record<string, unknown>).api_key, '[REDACTED]')
  const error = events.find((e) => e.type === 'error')!
  assert.ok(String(error.data.error).includes('token=[REDACTED]'))
  assert.ok(!String(error.data.error).includes('server-secret'))
})

test('createSession with prompt records a user event with the prompt text (Q1)', async () => {
  const { manager } = makeManager()
  const s = manager.createSession({ prompt: '帮我重构这个模块' })
  const events = manager.getEvents(s.id, 0)!.events
  const userEvent = events.find((e) => e.type === 'user')
  assert.ok(userEvent, 'a user event must be recorded')
  assert.equal(userEvent!.data.text, '帮我重构这个模块')
  // user must precede status:running so the conversation renders in order
  const userIdx = events.findIndex((e) => e.type === 'user')
  const statusIdx = events.findIndex((e) => e.type === 'status')
  assert.ok(userIdx < statusIdx, 'user event must precede status')
})

test('subsequent run() records another user event (Q1)', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'first' })
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(manager.run(s.id, 'second'), true)
  const texts = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'user')
    .map((e) => e.data.text)
  assert.deepEqual(texts, ['first', 'second'])
})

test('approval is a two-way intervention resolved out of band', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  const pending = cb.onApprovalRequired('tool-1', 'bash', { command: 'rm x' })
  assert.equal(manager.getSession(s.id)!.pendingApprovals, 1)
  const reqEvent = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'approval_required')
  assert.ok(reqEvent)
  assert.equal(reqEvent!.data.requestId, 'tool-1')

  const ok = manager.answerIntervention(s.id, 'tool-1', 'approve')
  assert.equal(ok, true)
  const result = await pending
  assert.deepEqual(result, { approved: true })
  assert.equal(manager.getSession(s.id)!.pendingApprovals, 0)
  const resolved = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'approval_resolved')
  assert.equal(resolved!.data.decision, 'approve')
})

test('computer_use approve + remember records a per-app grant (always allow)', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { isAppGranted } = await import('../../tools/computer-use/app-grants.js')
  const home = mkdtempSync(join(tmpdir(), 'rivet-cu-remember-'))
  const prevHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  t.after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  // approve WITHOUT remember → no grant
  const p1 = cb.onApprovalRequired('cu-1', 'computer_use', { action: 'snapshot', app: 'Safari' })
  manager.answerIntervention(s.id, 'cu-1', 'approve')
  assert.deepEqual(await p1, { approved: true })
  assert.equal(isAppGranted('Safari'), false, 'plain approve must not grant')

  // approve WITH remember → grant recorded + event annotated
  const p2 = cb.onApprovalRequired('cu-2', 'computer_use', { action: 'click', app: 'Safari', ref: 1 })
  manager.answerIntervention(s.id, 'cu-2', 'approve', undefined, true)
  assert.deepEqual(await p2, { approved: true, remember: true })
  assert.equal(isAppGranted('Safari'), true, 'approve+remember must grant the app')
  const resolved = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'approval_resolved')
    .find((e) => e.data.requestId === 'cu-2')
  assert.equal(resolved!.data.rememberedApp, 'Safari')

  // remember on a NON-computer_use tool → no grant side effect
  const p3 = cb.onApprovalRequired('b-1', 'bash', { command: 'ls' })
  manager.answerIntervention(s.id, 'b-1', 'approve', undefined, true)
  assert.deepEqual(await p3, { approved: true, remember: true })

  // reject + remember → no grant
  const p4 = cb.onApprovalRequired('cu-3', 'computer_use', { action: 'snapshot', app: 'Notes' })
  manager.answerIntervention(s.id, 'cu-3', 'reject', undefined, true)
  assert.deepEqual(await p4, { approved: false })
  assert.equal(isAppGranted('Notes'), false, 'reject+remember must not grant')
})

test('rejecting approval resolves with approved:false', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const pending = agents[0]!.callbacks!.onApprovalRequired('t', 'write_file', {})
  manager.answerIntervention(s.id, 't', 'reject')
  assert.deepEqual(await pending, { approved: false })
})

test('abort resolves all pending approvals (no hung promises)', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const pending = agents[0]!.callbacks!.onApprovalRequired('t', 'bash', {})
  manager.abort(s.id)
  assert.deepEqual(await pending, { approved: false })
  assert.equal(manager.getSession(s.id)!.pendingApprovals, 0)
  const resolved = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'approval_resolved')
    .find((e) => e.data.requestId === 't')
  assert.equal(resolved!.data.decision, 'aborted', '用户中止的审批关闭保持 aborted 语义')
})

test('run 正常完成时挂起 approval 关闭为 stale，不误标 aborted', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  const pending = a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'ls' })
  // run 正常 settle，approval 仍挂起（真实 agent 不应发生，但 manager 必须诚实收尾）
  a.finish()
  await settle()
  assert.deepEqual(await pending, { approved: false }, 'promise 必须被关闭，不能悬挂')
  const rec = manager.getSession(s.id)!
  assert.equal(rec.status, 'completed')
  assert.equal(rec.pendingApprovals, 0)
  const resolved = manager.getEvents(s.id, 0)!.events
    .filter((e) => e.type === 'approval_resolved')
    .find((e) => e.data.requestId === 't1')
  assert.ok(resolved, '必须有 approval_resolved 收尾事件')
  assert.equal(resolved!.data.decision, 'stale', '正常完成的收尾不得伪装成 aborted')
})

test('artifacts are surfaced per session and never cross-read', async () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  const b = manager.createSession({ prompt: 'b' })
  agents[0]!.artifacts = [makeArtifact('read_file:aaa')]
  agents[1]!.artifacts = [makeArtifact('grep:bbb', { tool: 'grep' })]

  // tool_result triggers an artifact scan + 'artifact' event
  agents[0]!.callbacks!.onToolResult('id1', 'read_file', 'ok', false)

  const aList = manager.listArtifacts(a.id)!
  const bList = manager.listArtifacts(b.id)!
  assert.deepEqual(aList.map((x) => x.id), ['read_file:aaa'])
  assert.deepEqual(bList.map((x) => x.id), ['grep:bbb'])

  const artEvent = manager.getEvents(a.id, 0)!.events.find((e) => e.type === 'artifact')
  assert.equal(artEvent!.data.id, 'read_file:aaa')

  assert.equal(await manager.readArtifact(b.id, 'read_file:aaa'), null, 'B must not read A artifact')
  assert.equal(await manager.readArtifact(a.id, 'read_file:aaa'), 'raw:read_file:aaa')
})

test('idle/rehydrated session reads artifact bodies straight off disk', async () => {
  // An agentless session (idle or restored after a sidecar restart) must still
  // serve artifact list + raw bodies from the on-disk log the live agent wrote.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ArtifactStore } = await import('../../artifact/store.js')

  const cwd = mkdtempSync(join(tmpdir(), 'rehydrate-art-'))
  const manager = new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: cwd,
  })
  // No prompt → agent stays null, exercising the rehydrated path.
  const s = manager.createSession({ cwd })

  // Mirror the live AgentLoop layout: <cwd>/.rivet/artifacts/<sessionId>
  const store = new ArtifactStore(join(cwd, '.rivet', 'artifacts'), s.id)
  const artId = await store.save({
    tool: 'read_file',
    target: 'foo.ts',
    summary: 'sum',
    sections: [],
    rawContent: 'line one\nline two',
  })

  const list = manager.listArtifacts(s.id)!
  assert.deepEqual(list.map((a) => a.id), [artId])
  assert.equal(await manager.readArtifact(s.id, artId), 'line one\nline two')
  assert.equal(await manager.readArtifact(s.id, 'missing:zzz'), null)
})

test('run() is rejected while a session is already running', async () => {
  const { manager } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  assert.equal(manager.run(s.id, 'again'), false)
})

test('completed run emits a terminal done event', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  const events = manager.getEvents(s.id, 0)!.events
  assert.ok(events.some((e) => e.type === 'done'))
  assert.equal(manager.getSession(s.id)!.status, 'completed')
})

// ── R1: registry lifecycle (register / heartbeat / release) ──────────

interface FakeRegistryCalls {
  registered: Array<{ id: string; cwd: string; role: string }>
  heartbeats: string[]
  released: string[]
}

function makeManagerWithRegistry() {
  const agents: FakeAgent[] = []
  const calls: FakeRegistryCalls = { registered: [], heartbeats: [], released: [] }
  const fakeRegistry = {
    register: (id: string, cwd: string, role: string) => calls.registered.push({ id, cwd, role }),
    heartbeat: (id: string) => calls.heartbeats.push(id),
    releaseAllClaims: (id: string) => calls.released.push(id),
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
    getSessionRegistry: () => fakeRegistry as any,
  })
  return { manager, agents, calls }
}

test('R1: createSession registers the session and run heartbeats the registry', async () => {
  const { manager, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ cwd: '/tmp/proj', prompt: 'go' })
  assert.deepEqual(calls.registered, [{ id: s.id, cwd: '/tmp/proj', role: 'standalone' }])
  assert.ok(calls.heartbeats.includes(s.id), 'run() must heartbeat the registry')
})

test('R1: a finished run releases the session claims', async () => {
  const { manager, agents, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ prompt: 'go' })
  assert.equal(calls.released.length, 0, 'no release while running')
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(calls.released, [s.id], 'terminal state must release claims')
})

test('R1: idle-agent eviction waits for async shutdown before releasing claims', async () => {
  const { manager, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ cwd: '/tmp/proj' })
  const internal = manager['sessions'].get(s.id)!
  let finishShutdown!: () => void
  const shutdownDone = new Promise<void>(resolve => { finishShutdown = resolve })
  internal.agent = { shutdown: () => shutdownDone } as ManagedAgent

  manager['releaseAgent'](internal)
  assert.deepEqual(calls.released, [], 'claims stay held while the old coordinator shuts down')
  finishShutdown()
  await shutdownDone
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(calls.released, [s.id])
})

test('R1: idle-agent eviction keeps claims when shutdown reports a timeout', () => {
  const { manager, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ cwd: '/tmp/proj' })
  const internal = manager['sessions'].get(s.id)!
  internal.agent = { shutdown: () => false } as ManagedAgent

  manager['releaseAgent'](internal)
  assert.deepEqual(calls.released, [], 'a timed-out coordinator may still be writing')
})

test('R1: shutdownAll releases claims for idle sessions after agent shutdown', async () => {
  const { manager, calls } = makeManagerWithRegistry()
  const s = manager.createSession({ cwd: '/tmp/proj' })
  const internal = manager['sessions'].get(s.id)!
  let finishShutdown!: () => void
  const shutdownDone = new Promise<void>(resolve => { finishShutdown = resolve })
  internal.agent = { shutdown: () => shutdownDone } as ManagedAgent

  const allShutdown = manager.shutdownAll()
  assert.deepEqual(calls.released, [], 'shutdown must await the idle agent before releasing claims')
  finishShutdown()
  await allShutdown
  assert.deepEqual(calls.released, [s.id])
})

test('R1: two concurrent sessions register & release independently', async () => {
  const { manager, agents, calls } = makeManagerWithRegistry()
  const a = manager.createSession({ prompt: 'a' })
  const b = manager.createSession({ prompt: 'b' })
  assert.deepEqual(calls.registered.map((r) => r.id).sort(), [a.id, b.id].sort())
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(calls.released, [a.id], 'finishing A must not release B')
  assert.equal(manager.getSession(b.id)!.status, 'running')
})

// ── R5: decision_shift event ─────────────────────────────────────────

test('R5: onDecisionShift appends a decision_shift event with structured payload', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.callbacks!.onDecisionShift!({
    source: 'kick',
    domain: '天璇',
    reason: '检测到停滞',
    methods: ['换用 grep', '重新框定问题'],
    severity: 'warn',
  })
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'decision_shift')
  assert.ok(ev, 'a decision_shift event must be recorded')
  assert.equal(ev!.data.source, 'kick')
  assert.equal(ev!.data.domain, '天璇')
  assert.equal(ev!.data.reason, '检测到停滞')
  assert.deepEqual(ev!.data.methods, ['换用 grep', '重新框定问题'])
  assert.equal(ev!.data.severity, 'warn')
})

// ── S: per-session autonomy (approvalMode) ───────────────────────────

function makeManagerCapturingMode() {
  const built: Array<{ cwd?: string; sessionId?: string; approvalMode?: string }> = []
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: (cwd, sessionId, approvalMode) => {
      const a = new FakeAgent()
      a.builtApprovalMode = approvalMode
      built.push({ cwd, sessionId, approvalMode })
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  return { manager, agents, built }
}

test('S: createSession threads approvalMode into the agent factory + record', async () => {
  const { manager, built } = makeManagerCapturingMode()
  const rec = manager.createSession({ prompt: 'go', approvalMode: 'dangerously-skip-permissions' })
  assert.equal(rec.approvalMode, 'dangerously-skip-permissions', 'record carries the mode')
  assert.equal(built.length, 1)
  assert.equal(built[0]!.approvalMode, 'dangerously-skip-permissions', 'factory received the mode')
})

test('S: createSession without approvalMode leaves it undefined (global default wins)', async () => {
  const { manager, built } = makeManagerCapturingMode()
  const rec = manager.createSession({ prompt: 'go' })
  assert.equal(rec.approvalMode, undefined)
  assert.equal(built[0]!.approvalMode, undefined)
})

test('S: setApprovalMode live-switches a built agent and updates the record', async () => {
  const { manager, agents } = makeManagerCapturingMode()
  const s = manager.createSession({ prompt: 'go' }) // builds the agent
  const ok = manager.setApprovalMode(s.id, 'dangerously-skip-permissions')
  assert.equal(ok, true)
  assert.equal(agents[0]!.liveApprovalMode, 'dangerously-skip-permissions', 'agent was live-mutated')
  assert.equal(manager.getSession(s.id)!.approvalMode, 'dangerously-skip-permissions', 'record updated')
})

test('S: setApprovalMode before first run applies on agent build', async () => {
  const { manager, agents, built } = makeManagerCapturingMode()
  const s = manager.createSession({}) // idle: no agent yet
  assert.equal(built.length, 0, 'no agent built for an idle session')
  manager.setApprovalMode(s.id, 'manual')
  manager.run(s.id, 'go') // now builds
  assert.equal(built[0]!.approvalMode, 'manual', 'stored override used at build time')
  assert.equal(agents[0]!.builtApprovalMode, 'manual')
})

test('S: setApprovalMode returns false for a missing session', async () => {
  const { manager } = makeManagerCapturingMode()
  assert.equal(manager.setApprovalMode('nope', 'manual'), false)
})

// ── T2: todo_state emission ─────────────────────────────────────────

test('T2: todo write tool emits a structured todo_state event', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('t1', 'todo', {
    action: 'write',
    todos: [
      { id: 'a', content: 'first', status: 'in_progress' },
      { id: 'b', content: 'second', status: 'pending' },
    ],
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 1)
  const items = evs[0]!.data.items as Array<{ id: string; content: string; status: string }>
  assert.deepEqual(items, [
    { id: 'a', content: 'first', status: 'in_progress' },
    { id: 'b', content: 'second', status: 'pending' },
  ])
})

test('T2: todo read action does NOT emit todo_state; bad statuses fall back to pending', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('r1', 'todo', { action: 'read' })
  cb.onToolUse('w1', 'todo', { action: 'write', todos: [{ id: 'x', content: 'c', status: 'bogus' }] })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 1, 'only the write action emits')
  const items = evs[0]!.data.items as Array<{ status: string }>
  assert.equal(items[0]!.status, 'pending')
})

test('P0-2: plan_task success emits todo_state via onToolResult', async () => {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      // P0-2: plan_task onToolResult reads session.agent.getTodos()
      a.getTodos = () => [
        { id: '1', content: 'step one', status: 'pending' },
        { id: '2', content: 'step two', status: 'pending' },
      ]
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  // plan_task success → todo_state emitted
  cb.onToolResult('plan1', 'plan_task', 'ok', false)
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 1)
  assert.deepEqual(evs[0]!.data.items, [
    { id: '1', content: 'step one', status: 'pending' },
    { id: '2', content: 'step two', status: 'pending' },
  ])
})

test('P0-2: plan_task error does NOT emit todo_state', async () => {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      a.getTodos = () => [
        { id: '1', content: 'step one', status: 'pending' },
      ]
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  // plan_task error → no todo_state
  cb.onToolResult('plan1', 'plan_task', 'error', true)
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'todo_state')
  assert.equal(evs.length, 0)
})

// ── T3: mid-run steering ────────────────────────────────────────────

test('T3: steer on a running session queues, echoes, and drains once', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  assert.equal(manager.steer(s.id, 'focus on tests'), 'queued')
  const echoed = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'steer_queued')
  assert.equal(echoed.length, 1)
  assert.equal(echoed[0]!.data.text, 'focus on tests')

  const drained = cb.onSteerDrain!()
  assert.match(String(drained), /focus on tests/)
  assert.equal(cb.onSteerDrain!(), null, 'second drain is empty')
})

test('T3: steer on an idle session returns idle; missing returns not_found', async () => {
  const { manager } = makeManager()
  const idle = manager.createSession({})
  assert.equal(manager.steer(idle.id, 'hi'), 'idle')
  assert.equal(manager.steer('nope', 'hi'), 'not_found')
})

// Phase 1.1 — run 结束后没赶上工具边界的 steer 残留不再被静默清除：下次
// prompt 时按 TUI idle 提交语义归并进新消息前部（原始文本，\n\n 分隔）。
test('Phase 1.1: steer residue from a finished run merges into the next prompt', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  manager.steer(s.id, 'stale one')
  manager.steer(s.id, 'stale two')
  agents[0]!.finish() // run resolves → session idle
  await new Promise((r) => setTimeout(r, 0)) // let the run's finally flip running=false
  assert.equal(manager.run(s.id, 'go again'), true) // reuses the same agent, fresh callbacks
  // 残留拼在新 prompt 前面，模型实际收到的就是归并后的文本。
  assert.equal(agents[0]!.prompts[1], 'stale one\n\nstale two\n\ngo again')
  // user 回声事件同样反映归并后的文本（UI 显示与模型收到的一致）。
  const users = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'user')
  assert.equal(users[users.length - 1]!.data.text, 'stale one\n\nstale two\n\ngo again')
  // buffer 已随归并清空——本轮首个 drain 不再看到上轮残留。
  assert.equal(agents[0]!.callbacks!.onSteerDrain!(), null)
})

// Phase 1.3 — drain 出内容时写 steer_delivered，count 为本次 drain 条数。
test('Phase 1.3: steer_delivered fires on drain with the drained entry count', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onSteerDrain!() // 空 buffer drain → 无事件
  manager.steer(s.id, 'one')
  manager.steer(s.id, 'two')
  const drained = cb.onSteerDrain!()
  assert.match(String(drained), /one/)
  const delivered = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'steer_delivered')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]!.data.count, 2)

  assert.equal(cb.onSteerDrain!(), null, 'second drain is empty')
  const after = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'steer_delivered')
  assert.equal(after.length, 1, 'empty drain emits nothing')
})

// ── Phase 2: queue lane ─────────────────────────────────────────────

test('Phase 2: queue gates on running and echoes queue_pending', async () => {
  const { manager } = makeManager()
  const idle = manager.createSession({})
  assert.equal(manager.queue(idle.id, 'hi'), 'idle')
  assert.equal(manager.queue('nope', 'hi'), 'not_found')

  const s = manager.createSession({ prompt: 'go' })
  const r = manager.queue(s.id, 'follow up later')
  assert.ok(typeof r === 'object' && typeof r.laneId === 'string' && r.laneId.length > 0)
  const echoed = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'queue_pending')
  assert.equal(echoed.length, 1)
  assert.equal(echoed[0]!.data.laneId, (r as { laneId: string }).laneId)
  assert.equal(echoed[0]!.data.text, 'follow up later')
})

test('Phase 2: steer { laneId } upgrades a queued entry into the steer buffer', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  const { laneId } = manager.queue(s.id, 'upgrade me') as { laneId: string }

  assert.equal(manager.steer(s.id, { laneId }), 'queued')
  // 状态迁移事件 + 文本进了 SteerBuffer（drain 可见）；升级路径不再重复 echo steer_queued。
  const status = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'queue_status')
  assert.deepEqual(status.map((e) => [e.data.laneId, e.data.status]), [[laneId, 'steered']])
  assert.equal(manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'steer_queued').length, 0)
  assert.match(String(cb.onSteerDrain!()), /upgrade me/)

  // 已非 queued：重复升级 / 撤回都拒绝。
  assert.equal(manager.steer(s.id, { laneId }), 'lane_not_queued')
  assert.equal(manager.retractQueued(s.id, laneId), 'lane_not_queued')
  assert.equal(manager.steer(s.id, { laneId: 'ghost' }), 'lane_not_found')
})

test('Phase 2: retractQueued flips a queued entry and echoes queue_status', async () => {
  const { manager } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const { laneId } = manager.queue(s.id, 'take it back') as { laneId: string }

  assert.equal(manager.retractQueued(s.id, laneId), 'retracted')
  const status = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'queue_status')
  assert.deepEqual(status.map((e) => [e.data.laneId, e.data.status]), [[laneId, 'retracted']])
  // 重复撤回 / 再升级均拒绝；不存在的 laneId / 会话 → not_found 家族。
  assert.equal(manager.retractQueued(s.id, laneId), 'lane_not_queued')
  assert.equal(manager.steer(s.id, { laneId }), 'lane_not_queued')
  assert.equal(manager.retractQueued(s.id, 'ghost'), 'lane_not_found')
  assert.equal(manager.retractQueued('nope', laneId), 'not_found')
})

test('Phase 2: queued entries merge into the next prompt with a section header', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = manager.queue(s.id, 'lane one') as { laneId: string }
  const b = manager.queue(s.id, 'lane two') as { laneId: string }
  // 混合场景：一条 steer 残留 + 两条 lane queued + 一条已 retracted（不参与归并）。
  manager.steer(s.id, 'steer residue')
  const c = manager.queue(s.id, 'retracted one') as { laneId: string }
  manager.retractQueued(s.id, c.laneId)
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))

  assert.equal(manager.run(s.id, 'next prompt'), true)
  const expected =
    'steer residue\n\n' +
    '[排队跟进 — 上轮运行期间排队，请一并处理]\n' +
    'lane one\n\nlane two\n\n' +
    'next prompt'
  assert.equal(agents[0]!.prompts[1], expected)
  // 归并后两条 queued 全部置 merged（逐条 queue_status），retracted 不再动。
  const status = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'queue_status')
  assert.deepEqual(
    status.map((e) => [e.data.laneId, e.data.status]),
    [
      [c.laneId, 'retracted'],
      [a.laneId, 'merged'],
      [b.laneId, 'merged'],
    ],
  )
  // lane 已清空（无 queued 残留）：再次 run 不会重复归并。
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(manager.run(s.id, 'third'), true)
  assert.equal(agents[0]!.prompts[2], 'third')
})

// ── T4: structured per-worker delegation ────────────────────────────

test('T4: onDelegationActivity emits per-worker delegation with progress + elapsed', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onDelegationActivity!({
    workOrderId: 'wo:T1',
    parentToolId: 'tool-1',
    profile: 'code_scout',
    status: 'running',
    progressLine: '⚙ grep',
  })
  cb.onDelegationActivity!({
    workOrderId: 'wo:T1',
    parentToolId: 'tool-1',
    status: 'completed',
    progressLine: 'found it',
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs.length, 2)
  assert.equal(evs[0]!.data.workerId, 'wo:T1')
  assert.equal(evs[0]!.data.parentId, 'tool-1')
  assert.equal(evs[0]!.data.status, 'running')
  assert.equal(evs[0]!.data.progressLine, '⚙ grep')
  assert.equal(typeof evs[0]!.data.elapsedMs, 'number')
  assert.equal(evs[1]!.data.status, 'completed')
})

test('T4: delegation events pass through counters, event mirror + failureReason', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onDelegationActivity!({
    workOrderId: 'wo:T2',
    parentToolId: 'tool-1',
    profile: 'patcher',
    status: 'running',
    progressLine: '⚙ edit_file',
    toolUseCount: 3,
    tokenCount: 1200,
    eventKind: 'tool_use',
    eventDetail: 'edit_file',
  })
  cb.onDelegationActivity!({
    workOrderId: 'wo:T2',
    parentToolId: 'tool-1',
    status: 'blocked',
    progressLine: 'timed out',
    failureReason: 'timeout',
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs.length, 2)
  assert.equal(evs[0]!.data.toolUseCount, 3)
  assert.equal(evs[0]!.data.tokenCount, 1200)
  assert.equal(evs[0]!.data.eventKind, 'tool_use')
  assert.equal(evs[0]!.data.eventDetail, 'edit_file')
  assert.equal(evs[1]!.data.failureReason, 'timeout')
})

// ── PlusMenu: model / star-domain / skills ──────────────────────────

/** Richer fake exposing the optional PlusMenu surface for wiring assertions. */
class PlusFakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  messages: OaiMessage[] = []
  domain: ActiveStarDomain | null | undefined = undefined
  disabled = new Set<string>()
  model = 'model-a'
  resetDomainCalls = 0
  restoredAutoDomainCalls = 0
  private resolveRun?: () => void
  run(_p: string, cb: AgentCallbacks): Promise<void> { this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  finish(): void { this.resolveRun?.() }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(m: OaiMessage[]): void { this.messages = m }
  rewindToMessages(m: OaiMessage[]): void { this.messages = m }
  setSessionDomain(d: ActiveStarDomain | null): void { this.domain = d }
  resetSessionDomain(): void { this.resetDomainCalls++; this.domain = undefined }
  restoreAutoResolvedDomain(d: ActiveStarDomain): void { this.restoredAutoDomainCalls++; this.domain = d }
  getSessionDomain(): ActiveStarDomain | null | undefined { return this.domain }
  setDisabledSkills(names: Set<string>): void { this.disabled = new Set(names) }
  switchModel(modelId: string): string | null {
    if (modelId === 'model-a' || modelId === 'model-b') { this.model = modelId; return modelId }
    return null
  }
}

class AutoResolvingFakeAgent extends PlusFakeAgent {
  constructor(private readonly autoKey: string, private readonly autoName: string) {
    super()
  }

  override run(prompt: string, callbacks: AgentCallbacks): Promise<void> {
    const pending = super.run(prompt, callbacks)
    if (this.domain === undefined) {
      callbacks.onDomainResolved?.({
        key: this.autoKey,
        name: this.autoName,
        matchedKeywords: ['自动路由'],
        reason: 'keyword',
      })
    }
    return pending
  }
}

function makePlusManager() {
  const agents: PlusFakeAgent[] = []
  const models: ModelOption[] = [
    { id: 'model-a', alias: 'Model A', provider: 'p', contextWindow: 128000 },
    { id: 'model-b', alias: 'Model B', provider: 'p', contextWindow: 256000 },
  ]
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new PlusFakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    listModels: () => models,
    defaultModelId: 'model-a',
  })
  return { manager, agents }
}

test('PlusMenu: listDomains flags Auto by default; setDomain pins a domain', async () => {
  const { manager } = makePlusManager()
  // 显式 domain —— 空 input 时起始星域由 ~/.rivet 全局配置 defaultDomain 决定
  // （同 a976167f 对 model 的处理），在本机真实配置下不可预测，需锚定起点。
  const s = manager.createSession({ domain: 'auto' })
  const entries = manager.listDomains(s.id)!
  assert.ok(entries.length >= 3)
  const auto = entries.find((e) => e.key === 'auto')!
  assert.equal(auto.current, true)

  assert.equal(manager.setDomain(s.id, 'tianshu'), true)
  const after = manager.listDomains(s.id)!
  assert.equal(after.find((e) => e.key === 'tianshu')!.current, true)
  assert.equal(after.find((e) => e.key === 'auto')!.current, false)
  assert.equal(manager.getSession(s.id)!.domain, 'tianshu')

  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'domain_changed')!
  assert.equal(ev.data.key, 'tianshu')
})

test('PlusMenu: setDomain rejects an unknown key', async () => {
  const { manager } = makePlusManager()
  const s = manager.createSession({})
  assert.equal(manager.setDomain(s.id, 'nope-xyz'), false)
})

test('PlusMenu: domain selection applies to a lazily-built agent', async () => {
  const { manager, agents } = makePlusManager()
  const s = manager.createSession({})
  manager.setDomain(s.id, 'tianshu') // before any agent exists
  manager.run(s.id, 'go')            // builds the agent → applySelections runs
  assert.equal(agents[0]!.domain?.id, 'tianshu')
})

test('PlusMenu: explicit Auto is replayed to a lazily-built agent', async () => {
  const { manager, agents } = makePlusManager()
  const s = manager.createSession({ domain: 'auto' })

  manager.run(s.id, '请实现、交付、编写并测试一个用户注册功能')

  assert.equal(agents[0]!.resetDomainCalls, 1)
  assert.equal(agents[0]!.domain, undefined)
})

test('Auto resolution survives agent rebuild without a second domain_resolved event', async () => {
  const agents: AutoResolvingFakeAgent[] = []
  const saved: SessionRecord[] = []
  const persistence: SessionPersistenceAdapter = {
    saveRecord: (record) => { saved.push(structuredClone(record)) },
    appendEvent: () => {},
    loadAll: () => [],
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const candidate = agents.length === 0
        ? new AutoResolvingFakeAgent('kaiyang', '开阳')
        : new AutoResolvingFakeAgent('tianliang', '天梁')
      agents.push(candidate)
      return candidate
    },
    defaultCwd: '/tmp/work',
    persistence,
  })

  const session = manager.createSession({ prompt: '首次自动路由', domain: 'auto' })
  const firstRecord = manager.getSession(session.id)!
  assert.equal(firstRecord.domain, 'auto')
  assert.deepEqual(firstRecord.resolvedDomain, {
    key: 'kaiyang',
    name: '开阳',
    matchedKeywords: ['自动路由'],
    reason: 'keyword',
  })
  assert.deepEqual(saved.at(-1)?.resolvedDomain, firstRecord.resolvedDomain)
  assert.equal(
    manager.getEvents(session.id, 0)!.events.filter((event) => event.type === 'domain_resolved').length,
    1,
  )

  agents[0]!.finish()
  await settle()
  manager['sessions'].get(session.id)!.agent = null
  assert.equal(manager.run(session.id, '重建后的新消息'), true)

  assert.equal(agents[1]!.domain?.id, 'kaiyang', 'rebuild must restore the first resolved domain')
  assert.equal(agents[1]!.restoredAutoDomainCalls, 1, 'rebuild must retain Auto lifecycle semantics')
  assert.equal(
    manager.getEvents(session.id, 0)!.events.filter((event) => event.type === 'domain_resolved').length,
    1,
    'restored resolution must suppress a second Auto bind event',
  )
  assert.equal(manager.getSession(session.id)!.domain, 'auto')
})

test('setDomain clears a persisted Auto resolution before any new selection', async () => {
  const agents: AutoResolvingFakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = new AutoResolvingFakeAgent('kaiyang', '开阳')
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
  })
  const session = manager.createSession({ prompt: '首次自动路由', domain: 'auto' })
  assert.deepEqual(manager.getSession(session.id)?.resolvedDomain, {
    key: 'kaiyang',
    name: '开阳',
    matchedKeywords: ['自动路由'],
    reason: 'keyword',
  })

  agents[0]!.finish()
  await settle()
  assert.equal(manager.setDomain(session.id, 'tianshu'), true)
  assert.equal(manager.getSession(session.id)?.resolvedDomain, undefined)
  assert.equal(manager.setDomain(session.id, 'auto'), true)
  assert.equal(manager.getSession(session.id)?.resolvedDomain, undefined)
  assert.equal(agents[0]!.domain, undefined, 'selecting Auto must allow the next run to resolve again')
})

test('unknown persisted selection normalizes to Auto, resolves once, and survives rebuild', async () => {
  const persisted = {
    id: 'auto-unknown',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp/work',
    lastSeq: 0,
    pendingApprovals: 0,
    domain: 'removed-custom-domain',
    resolvedDomain: 'kaiyang',
  } as unknown as SessionRecord
  const agents: AutoResolvingFakeAgent[] = []
  const saved: SessionRecord[] = []
  const persistence: SessionPersistenceAdapter = {
    saveRecord: (record) => { saved.push(structuredClone(record)) },
    appendEvent: () => {},
    loadAll: () => [{ record: persisted, events: [] }],
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = agents.length === 0
        ? new AutoResolvingFakeAgent('tianliang', '天梁')
        : new AutoResolvingFakeAgent('kaiyang', '开阳')
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
    persistence,
  })

  assert.equal(manager.getSession(persisted.id)?.domain, 'auto')
  assert.equal(manager.getSession(persisted.id)?.resolvedDomain, undefined)
  assert.equal(manager.run(persisted.id, '重新匹配'), true)
  assert.equal(agents[0]!.domain, undefined, 'unknown metadata must not pin a false domain')
  assert.deepEqual(manager.getSession(persisted.id)?.resolvedDomain, {
    key: 'tianliang',
    name: '天梁',
    matchedKeywords: ['自动路由'],
    reason: 'keyword',
  })
  assert.equal(saved.at(-1)?.domain, 'auto')
  assert.deepEqual(saved.at(-1)?.resolvedDomain, manager.getSession(persisted.id)?.resolvedDomain)

  agents[0]!.finish()
  await settle()
  manager['sessions'].get(persisted.id)!.agent = null
  assert.equal(manager.run(persisted.id, '重建后不应重算'), true)
  assert.equal(agents[1]!.domain?.id, 'tianliang')
  assert.equal(
    manager.getEvents(persisted.id, 0)!.events.filter((event) => event.type === 'domain_resolved').length,
    1,
  )
})

test('legacy string resolvedDomain migrates to a displayable fallback payload', () => {
  const persisted = {
    id: 'auto-legacy-string',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp/work',
    lastSeq: 0,
    pendingApprovals: 0,
    domain: 'auto',
    resolvedDomain: 'kaiyang',
  } as unknown as SessionRecord
  const agents: AutoResolvingFakeAgent[] = []
  const persistence: SessionPersistenceAdapter = {
    saveRecord: () => {},
    appendEvent: () => {},
    loadAll: () => [{ record: persisted, events: [] }],
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = new AutoResolvingFakeAgent('tianliang', '天梁')
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
    persistence,
  })

  assert.deepEqual(manager.getSession(persisted.id)?.resolvedDomain, {
    key: 'kaiyang',
    name: '开阳',
    matchedKeywords: [],
    reason: 'fallback',
  })
  assert.equal(manager.run(persisted.id, '恢复旧记录'), true)
  assert.equal(agents[0]!.domain?.id, 'kaiyang')
  assert.equal(
    manager.getEvents(persisted.id, 0)!.events.filter((event) => event.type === 'domain_resolved').length,
    0,
  )
})

test('unknown object resolvedDomain is discarded and reroutes Auto', () => {
  const persisted = {
    id: 'auto-unknown-object',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp/work',
    lastSeq: 0,
    pendingApprovals: 0,
    domain: 'auto',
    resolvedDomain: {
      key: 'removed-domain',
      name: '已删除',
      matchedKeywords: ['旧词'],
      reason: 'keyword',
    },
  } as unknown as SessionRecord
  const persistence: SessionPersistenceAdapter = {
    saveRecord: () => {},
    appendEvent: () => {},
    loadAll: () => [{ record: persisted, events: [] }],
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => new AutoResolvingFakeAgent('tianliang', '天梁'),
    defaultCwd: '/tmp/work',
    persistence,
  })

  assert.equal(manager.getSession(persisted.id)?.resolvedDomain, undefined)
  assert.equal(manager.run(persisted.id, '重新路由'), true)
  assert.deepEqual(manager.getSession(persisted.id)?.resolvedDomain, {
    key: 'tianliang',
    name: '天梁',
    matchedKeywords: ['自动路由'],
    reason: 'keyword',
  })
})

test('PlusMenu: listModels flags current; switchModel updates record + emits', async () => {
  const { manager } = makePlusManager()
  // 显式 input.model（新建会话对话框同路径，优先级最高）。a976167f 起空输入
  // 会被项目配置默认 provider 的首模型覆盖注入的 defaultModelId——本机会解析
  // 到真实 ~/.rivet 配置，起始模型不确定，断言必须钉在显式输入上。
  const s = manager.createSession({ model: 'model-a' })
  const before = manager.listModels(s.id)!
  assert.equal(before.find((m) => m.id === 'model-a')!.current, true)

  assert.equal(await manager.switchModel(s.id, 'model-b'), true)
  assert.equal(manager.getSession(s.id)!.model, 'model-b')
  const after = manager.listModels(s.id)!
  assert.equal(after.find((m) => m.id === 'model-b')!.current, true)
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'model_switched')!
  assert.equal(ev.data.modelId, 'model-b')
})

// a976167f 新建会话模型优先级：显式 input.model > 项目配置默认 provider 首模型
// > 注入的 defaultModelId。该特性此前无测试覆盖——上方 listModels 测试正因
// 优先级改动在本机真实配置下静默失效。
test('PlusMenu: createSession model precedence — project config beats injected default, explicit input beats project', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'rivet-plus-proj-'))
  // 信任门预存债收口：项目层 provider 键未授信即剥离（project-trust.ts）。
  // 本用例测优先级不测信任——显式授信后按原意图断言。
  const prevTrust = process.env.RIVET_TRUST_PROJECT
  process.env.RIVET_TRUST_PROJECT = '1'
  try {
    writeFileSync(join(projectDir, '.rivet-config.json'), JSON.stringify({
      provider: {
        default: 'p',
        providers: {
          p: {
            name: 'p',
            baseUrl: 'https://example.com/v1',
            models: [
              { id: 'proj-model', contextWindow: 128000, maxTokens: 8192 },
              { id: 'model-a', contextWindow: 128000, maxTokens: 8192 },
            ],
          },
        },
      },
    }, null, 2))

    const models: ModelOption[] = [
      { id: 'proj-model', alias: 'Proj Model', provider: 'p', contextWindow: 128000 },
      { id: 'model-a', alias: 'Model A', provider: 'p', contextWindow: 128000 },
    ]
    const manager = new RuntimeSessionManager({
      createAgent: () => new PlusFakeAgent(),
      defaultCwd: projectDir,
      listModels: () => models,
      defaultModelId: 'model-a',
    })

    // 项目配置默认 provider 的首模型 > 注入的 defaultModelId
    const s1 = manager.createSession({})
    assert.equal(manager.getSession(s1.id)!.model, 'proj-model')
    const flagged = manager.listModels(s1.id)!
    assert.equal(flagged.find((m) => m.id === 'proj-model')!.current, true)

    // 显式 input.model（新建会话对话框同路径）> 项目配置
    const s2 = manager.createSession({ model: 'model-a' })
    assert.equal(manager.getSession(s2.id)!.model, 'model-a')
  } finally {
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('PlusMenu: switchModel rejects unknown id and refuses while running', async () => {
  const { manager } = makePlusManager()
  const s = manager.createSession({})
  assert.equal(await manager.switchModel(s.id, 'ghost'), false)

  manager.run(s.id, 'go') // now running
  assert.equal(await manager.switchModel(s.id, 'model-b'), false)
})

test('PlusMenu: setSkillEnabled toggles disabled set + applies to live agent', async () => {
  const { manager, agents } = makePlusManager()
  const s = manager.createSession({})
  manager.run(s.id, 'go') // build agent so live-apply path runs
  assert.equal(manager.setSkillEnabled(s.id, 'leave-ritual', false), true)
  assert.ok(agents[0]!.disabled.has('leave-ritual'))
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'skills_changed')!
  assert.equal(ev.data.name, 'leave-ritual')
  assert.equal(ev.data.enabled, false)

  // Re-enabling removes it from the disabled set.
  manager.setSkillEnabled(s.id, 'leave-ritual', true)
  assert.equal(agents[0]!.disabled.has('leave-ritual'), false)
})

test('PlusMenu: missing session yields undefined/false from menu methods', async () => {
  const { manager } = makePlusManager()
  assert.equal(manager.listModels('nope'), undefined)
  assert.equal(manager.listDomains('nope'), undefined)
  assert.equal(manager.listSkills('nope'), undefined)
  assert.equal(manager.setDomain('nope', 'auto'), false)
  assert.equal(await manager.switchModel('nope', 'model-a'), false)
  assert.equal(manager.setSkillEnabled('nope', 'x', false), false)
})

// ── User-dispatched background subagent ─────────────────────────────

/** Fake exposing delegateWorker; lets a test drive activity + completion. */
class DelegateFakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  lastInput?: { objective: string; profile?: string; authority?: string; files?: string[] }
  lastOpts?: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void }
  private resolveRun?: () => void
  run(_p: string, cb: AgentCallbacks): Promise<void> { this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  finish(): void { this.resolveRun?.() }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  delegateWorker(
    input: { objective: string; profile?: string; authority?: string; files?: string[] },
    opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
  ): Promise<void> {
    this.lastInput = input
    this.lastOpts = opts
    // Stay pending so the test can drive onActivity then resolve manually.
    return new Promise<void>(() => {})
  }
}

function makeDelegateManager() {
  const agents: DelegateFakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new DelegateFakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  return { manager, agents }
}

test('delegate: dispatches a worker WITHOUT setting session.running', async () => {
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = await manager.delegate(s.id, { objective: '查登录验证码', profile: 'code_scout' })
  assert.equal(res.ok, true)
  // Session stays idle — a background worker must not flip the main turn flag.
  assert.notEqual(manager.getSession(s.id)!.status, 'running')
  // The agent received the request with our stable workerId as parent key.
  assert.equal(agents[0]!.lastInput!.objective, '查登录验证码')
  assert.equal(agents[0]!.lastOpts!.workerId, res.ok ? res.workerId : '')
})

test('delegate: emits a running delegation node with origin=user', async () => {
  const { manager } = makeDelegateManager()
  const s = manager.createSession({})
  const res = await manager.delegate(s.id, { objective: 'go', profile: 'reviewer' })
  assert.equal(res.ok, true)
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs.length, 1)
  assert.equal(evs[0]!.data.status, 'running')
  assert.equal(evs[0]!.data.origin, 'user')
  assert.equal(evs[0]!.data.objective, 'go')
  assert.equal(evs[0]!.data.profile, 'reviewer')
})

test('delegate: onActivity terminal update carries summary + origin', async () => {
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = await manager.delegate(s.id, { objective: 'go' })
  assert.ok(res.ok)
  const workerId = res.ok ? res.workerId : ''
  // Simulate the worker finishing with a digest.
  agents[0]!.lastOpts!.onActivity({
    workOrderId: workerId,
    status: 'passed',
    summary: '改了 2 个文件',
    changedFiles: ['a.ts', 'b.ts'],
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  const terminal = evs[evs.length - 1]!
  assert.equal(terminal.data.status, 'passed')
  assert.equal(terminal.data.summary, '改了 2 个文件')
  assert.equal(terminal.data.origin, 'user')
  assert.deepEqual(terminal.data.changedFiles, ['a.ts', 'b.ts'])
})

test('delegate: onActivity carries authority + authorityReason to the desktop mirror', async () => {
  // 桌面舰队面板要显示 worker 星域与命中理由——emitDelegationActivity 必须把
  // 两个字段都转发进 delegation 事件（此前 authority 接收后未转发）。
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = await manager.delegate(s.id, { objective: 'go' })
  assert.ok(res.ok)
  const workerId = res.ok ? res.workerId : ''
  agents[0]!.lastOpts!.onActivity({
    workOrderId: workerId,
    status: 'running',
    authority: 'tianfu',
    authorityReason: '命中: 重构+优化',
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  const last = evs[evs.length - 1]!
  assert.equal(last.data.authority, 'tianfu')
  assert.equal(last.data.authorityReason, '命中: 重构+优化')
})

test('delegate: empty objective is rejected', async () => {
  const { manager } = makeDelegateManager()
  const s = manager.createSession({})
  const res = await manager.delegate(s.id, { objective: '   ' })
  assert.deepEqual(res, { ok: false, reason: 'invalid' })
})

test('delegate: missing session is rejected', async () => {
  const { manager } = makeDelegateManager()
  const res = await manager.delegate('nope', { objective: 'go' })
  assert.deepEqual(res, { ok: false, reason: 'not_found' })
})

test('cancelDelegate: aborts the worker signal; unknown returns false', async () => {
  const { manager, agents } = makeDelegateManager()
  const s = manager.createSession({})
  const res = await manager.delegate(s.id, { objective: 'go' })
  assert.ok(res.ok)
  const workerId = res.ok ? res.workerId : ''
  assert.equal(agents[0]!.lastOpts!.signal.aborted, false)
  assert.equal(manager.cancelDelegate(s.id, workerId), true)
  assert.equal(agents[0]!.lastOpts!.signal.aborted, true)
  assert.equal(manager.cancelDelegate(s.id, 'ghost'), false)
})

test('delegate: coexists with a running main turn (anytime dispatch)', async () => {
  const { manager } = makeDelegateManager()
  const s = manager.createSession({ prompt: 'main task' })
  assert.equal(manager.getSession(s.id)!.status, 'running')
  // Background dispatch must succeed even while the main turn runs.
  const res = await manager.delegate(s.id, { objective: 'side quest' })
  assert.equal(res.ok, true)
})

// ── Watchdog stall auto-recovery (桌面端对齐 TUI v3) ────────────────────────

test('watchdog:goal 中止后自动续跑：agent 收到第二次 run(continue)，status 回到 running', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle()

  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'])
  assert.equal(manager.getSession(s.id)!.status, 'running', '续跑后不停留在 aborted')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.ok(ev, '必须追加 watchdog_recovery 事件')
  assert.equal(ev!.data.autoContinue, true)
})

test('普通 watchdog（非 goal）同样自动续跑', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog')
  await settle()
  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'])
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('用户 abort（无 reason）与 convergence 中止不自动续跑', async () => {
  const { manager, agents } = makeManager()
  const a = manager.createSession({ prompt: 'a' })
  manager.abort(a.id)                       // FakeAgent.abort → onAbort() 无 reason
  await settle()
  assert.deepEqual(agents[0]!.prompts, ['a'], '用户中止不得续跑')
  assert.equal(manager.getSession(a.id)!.status, 'aborted')

  const b = manager.createSession({ prompt: 'b' })
  agents[1]!.callbacks!.onAbort('convergence:no-tool')
  agents[1]!.finish()
  await settle()
  assert.deepEqual(agents[1]!.prompts, ['b'], 'convergence 中止不得续跑')
})

test('turn_complete forwards continuationReason to the event stream', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.callbacks!.onTurnComplete({}, 1, false, undefined, 'obligation-verification')
  a.finish()
  await settle()
  const ev = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'turn_complete').at(-1)
  assert.equal(ev?.data.continuationReason, 'obligation-verification')
})

test('密集 stall（tiny-turn 循环）12 次后停手，事件含 stopReason=session-total', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    a.callbacks!.onTurnComplete({}, 1, false)   // tiny-turn：重置 consecutive
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  const continues = a.prompts.filter((p) => p === 'continue').length
  assert.equal(continues, 12, `session-total cap 应在 12 次后停手，实得 ${continues}`)
  assert.equal(manager.getSession(s.id)!.status, 'aborted', '停手后落 aborted 等用户')
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'watchdog_recovery')
  assert.equal(evs[evs.length - 1]!.data.stopReason, 'session-total')
})

test('稀疏 stall（每次间隔 2 个工具批）不消耗配额，15 次全续跑', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 2; j++) {
      a.callbacks!.onToolResult(`t${i}-${j}`, 'read_file', 'ok', false)
      a.callbacks!.onTurnComplete({}, 1, false)
    }
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  assert.equal(a.prompts.filter((p) => p === 'continue').length, 15)
})

test('流式 chunk（isError=undefined）不计进度：密集 stall 仍 12 次停手', async () => {
  const { manager, agents } = makeManager()
  manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  for (let i = 0; i < 15; i++) {
    for (let j = 0; j < 4; j++) a.callbacks!.onToolResult(`t${i}`, 'bash', `chunk${j}`)  // 无 isError
    a.callbacks!.onToolResult(`t${i}`, 'bash', 'done', false)   // 终态
    a.callbacks!.onTurnComplete({}, 1, false)
    // 每周期真实进度 = 2 单元 < 4 → 密集
    a.watchdogAbort('watchdog:goal')
    await settle()
  }
  const continues = a.prompts.filter((p) => p === 'continue').length
  assert.equal(continues, 12, `chunk 若被误计会伪装稀疏无限续跑，实得 ${continues}`)
})

test('审批挂起时 stall → suppressed：不续跑，事件可观测', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  void a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'rm x' })  // 挂起不答复
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.deepEqual(a.prompts, ['go'], '审批挂起的 stall 不得续跑')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev!.data.stopReason, 'suppressed')
})

test('审批拒绝后 5s grace 窗口内的 stall 被抑制，窗口外恢复续跑（假时钟）', async () => {
  let clock = 1_000_000
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    now: () => clock,
    watchdogContinueDelayMs: 0,
  })
  const s = manager.createSession({ prompt: 'go' })
  const sid = s.id
  const a = agents[0]!
  const pending = a.callbacks!.onApprovalRequired('t1', 'bash', { command: 'rm x' })
  // requestApproval 用 toolId 作 requestId（session-manager.ts:2101 已核实）
  manager.answerIntervention(sid, 't1', 'reject')
  assert.deepEqual(await pending, { approved: false })

  clock += 1_000                              // 拒绝后 1s——窗口内
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.deepEqual(a.prompts, ['go'], 'grace 窗口内不得续跑')

  clock += 10_000                             // 拒绝后 11s——窗口外
  manager.run(sid, 'again')                   // 用户重新驱动
  a.watchdogAbort('watchdog:goal')
  await settle()
  assert.equal(a.prompts.filter((p) => p === 'continue').length, 1, '窗口外恢复续跑')
})

test('abort 后用户抢先提交新 prompt：自动续跑让位', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  // 只排干微任务（run().finally 是 promise 回调），不让 setImmediate 宏任务先跑
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(manager.run(s.id, '用户新指令'), true, '此刻 running 已清，用户可提交')
  await settle()
  assert.deepEqual(a.prompts, ['go', '用户新指令'], '自动 continue 必须让位给用户')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev, undefined, '让位时不产生 recovery 事件')
})

test('watchdog stall 后、setImmediate 执行前用户 abort → 不续跑（窄窗口竞态）', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  // 只排干微任务（run().finally），setImmediate 宏任务还没跑
  for (let i = 0; i < 10; i++) await Promise.resolve()
  // 用户在此窗口内 abort——abort() 对已停会话目前是空操作（status 已 aborted、
  // agent 已停、pending 已空），但用户意图是"停"，不应被自动续跑盖掉
  manager.abort(s.id)
  await settle()
  assert.deepEqual(a.prompts, ['go'], '用户 abort 后不得自动续跑')
  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.equal(ev, undefined, '用户 abort 抑制续跑，不产生 recovery 事件')
})

// ── C2 刹车：watchdog 续跑倒计时可取消 ────────────────────────────────────

// 倒计时统一取 200ms 而非 30ms：settle() 自身就要约 15ms，30ms 窗口只有一倍
// 余量，全量并行下定时器会抢在断言之前跑完，"倒计时内不得续跑"因此偶发假失败。
// 200ms 给到十余倍余量，同时"确实续跑了"改用轮询，空载时并不会因此变慢。
const CONTINUE_DELAY_MS = 200

test('C2: 续跑先发 pendingAutoContinue 事件，倒计时结束才真正 continue', async () => {
  const { manager, agents } = makeManager({ watchdogContinueDelayMs: CONTINUE_DELAY_MS })
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle() // setImmediate 已跑：事件已追加，但倒计时未到

  const ev = manager.getEvents(s.id, 0)!.events.find((e) => e.type === 'watchdog_recovery')
  assert.ok(ev, '决策后立即追加 watchdog_recovery 事件')
  assert.equal(ev!.data.pendingAutoContinue, true)
  assert.equal(ev!.data.delayMs, CONTINUE_DELAY_MS)
  assert.deepEqual(agents[0]!.prompts, ['go'], '倒计时内不得续跑')

  await waitUntil(() => agents[0]!.prompts.length > 1)
  assert.deepEqual(agents[0]!.prompts, ['go', 'continue'], '倒计时结束后续跑')
  assert.equal(manager.getSession(s.id)!.status, 'running')
})

test('C2: 倒计时窗口内用户 abort → 取消续跑并追加 cancelled 事件', async () => {
  const { manager, agents } = makeManager({ watchdogContinueDelayMs: CONTINUE_DELAY_MS })
  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.watchdogAbort('watchdog:goal')
  await settle() // 倒计时已挂起

  manager.abort(s.id)
  // 必须睡过倒计时截止点，否则"没续跑"只是因为还没到点，证明不了取消生效。
  await new Promise((r) => setTimeout(r, CONTINUE_DELAY_MS + 100))
  assert.deepEqual(agents[0]!.prompts, ['go'], '取消后不得续跑')
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'watchdog_recovery')
  assert.ok(evs.some((e) => e.data.cancelled === true), '必须追加 cancelled 事件供 UI 收卡片')
})

test('C2: 倒计时窗口内用户发新 prompt → 定时器清除，continue 不追发', async () => {
  const { manager, agents } = makeManager({ watchdogContinueDelayMs: CONTINUE_DELAY_MS })
  const s = manager.createSession({ prompt: 'go' })
  const a = agents[0]!
  a.watchdogAbort('watchdog:goal')
  await settle()

  assert.equal(manager.run(s.id, '用户新指令'), true)
  await new Promise((r) => setTimeout(r, CONTINUE_DELAY_MS + 100))
  assert.deepEqual(a.prompts, ['go', '用户新指令'], '用户 prompt 抢占，自动 continue 不得追发')
})

// ── Wave 2: delta 合并缓冲 ────────────────────────────────────────────────────

test('delta coalescing: first delta lands immediately, burst merges into one windowed event', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('a')          // first of the run → immediate
  cb.onTextDelta('b')
  cb.onTextDelta('c')
  cb.onTextDelta('d')

  // Live listeners must see only the immediate first event so far.
  const before = manager
    .getSession(s.id) && manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.equal(before!.length, 1)
  assert.equal(before![0]!.data.text, 'a')

  await new Promise((r) => setTimeout(r, 60)) // > DELTA_COALESCE_MS
  const after = manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.equal(after.length, 2, 'burst coalesces into one windowed event')
  assert.equal(after[1]!.data.text, 'bcd')
})

test('delta coalescing: non-delta event flushes the buffer first (order preserved)', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('x')
  cb.onTextDelta('y')          // buffered
  cb.onToolUse('t1', 'bash', { command: 'ls' })

  const evs = manager['sessions'].get(s.id)!.events
  const types = evs.map((e) => e.type)
  const yIdx = evs.findIndex((e) => e.type === 'text_delta' && e.data.text === 'y')
  const toolIdx = types.indexOf('tool_use')
  assert.ok(yIdx !== -1, 'buffered delta must be flushed by the tool_use')
  assert.ok(yIdx < toolIdx, 'flushed delta must precede the tool_use event')
})

test('delta coalescing: abort drains the buffer before the status event', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('head')
  cb.onTextDelta(' tail')      // buffered
  manager.abort(s.id)

  const evs = manager['sessions'].get(s.id)!.events
  const tailIdx = evs.findIndex((e) => e.type === 'text_delta' && e.data.text === ' tail')
  const statusIdx = evs.findIndex((e) => e.type === 'status' && e.data.status === 'aborted')
  assert.ok(tailIdx !== -1, 'buffered tail must not be lost on abort')
  assert.ok(tailIdx < statusIdx, 'tail must land before the aborted status')
})

test('delta coalescing: type switch (thinking↔text) flushes and keeps order', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onThinkingDelta('think1')  // immediate (first of thinking run)
  cb.onThinkingDelta('think2')  // buffered
  cb.onTextDelta('answer')      // type switch → flush think2, then immediate

  const evs = manager['sessions'].get(s.id)!.events.filter(
    (e) => e.type === 'text_delta' || e.type === 'thinking_delta',
  )
  assert.deepEqual(
    evs.map((e) => [e.type, e.data.text]),
    [['thinking_delta', 'think1'], ['thinking_delta', 'think2'], ['text_delta', 'answer']],
  )
})

test('delta coalescing: oversized buffer flushes at the char cap without waiting', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('first')                 // immediate
  cb.onTextDelta('x'.repeat(3000))        // exceeds cap → immediate flush

  const evs = manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.equal(evs.length, 2)
  assert.equal((evs[1]!.data.text as string).length, 3000)
})

test('delta coalescing: getEvents drains the window and seq stays monotonic', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('one ')
  cb.onTextDelta('two')        // buffered — poll must still see it
  const all = manager.getEvents(s.id, 0)!
  const texts = all.events.filter((e) => e.type === 'text_delta').map((e) => e.data.text)
  assert.deepEqual(texts, ['one ', 'two'])
  const seqs = all.events.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
})

test('delta coalescing: shutdownAll drains pending buffers', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!

  cb.onTextDelta('kept')
  cb.onTextDelta(' also kept')  // buffered
  manager.shutdownAll()

  const evs = manager['sessions'].get(s.id)!.events.filter((e) => e.type === 'text_delta')
  assert.deepEqual(evs.map((e) => e.data.text), ['kept', ' also kept'])
})

test('extractObjective: top-level objective preferred', () => {
  assert.equal(extractObjective({ objective: 'find bugs' }), 'find bugs')
  assert.equal(extractObjective({ prompt: 'scan auth' }), 'scan auth')
})

test('extractObjective: delegate_batch tasks[] summarized', () => {
  const o = extractObjective({
    tasks: [
      { objective: 'scout auth flow' },
      { objective: 'check rate limits' },
      { objective: 'verify tokens' },
      { objective: 'extra task' },
    ],
  })
  assert.match(o, /scout auth flow/)
  assert.match(o, /check rate limits/)
  assert.match(o, /\+1 more/)
})

test('extractObjective: empty when no usable fields', () => {
  assert.equal(extractObjective({}), '')
  assert.equal(extractObjective({ tasks: [{ profile: 'code_scout' }] }), '')
})

test('N3: delegate_batch parent node carries toolName + taskCount (group-head identity)', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('tool-1', 'delegate_batch', {
    tasks: [{ objective: 'scout A' }, { objective: 'scout B' }, { objective: 'scout C' }],
  })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs.length, 1)
  assert.equal(evs[0]!.data.workerId, 'tool-1')
  assert.equal(evs[0]!.data.toolName, 'delegate_batch')
  assert.equal(evs[0]!.data.taskCount, 3)
  assert.equal(evs[0]!.data.status, 'running')
})

test('N3: non-batch delegation tools omit taskCount; result event closes the group', async () => {
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' })
  const cb = agents[0]!.callbacks!
  cb.onToolUse('tool-2', 'council_convene', { seats: [{ authority: 'tianquan' }] })
  const evs = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs[0]!.data.toolName, 'council_convene')
  assert.equal(evs[0]!.data.taskCount, undefined)
  cb.onToolResult('tool-2', 'council_convene', 'ok', false)
  const evs2 = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'delegation')
  assert.equal(evs2.length, 2)
  assert.equal(evs2[1]!.data.status, 'completed')
})

test('idle sweep forgets session stores via the registered forgetter (Wave 3)', async () => {
  const agents: FakeAgent[] = []
  const forgotten: string[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
    idleAgentTtlMs: 5,
  })
  manager.setStoresForgetter((id) => forgotten.push(id))

  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 20))

  manager.sweepIdleAgents()
  assert.deepEqual(forgotten, [s.id], 'idle-swept session must drop its stores entry')
})

test('archive and hardDelete both forget session stores (Wave 3)', async () => {
  const agents: FakeAgent[] = []
  const forgotten: string[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new FakeAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp/work',
  })
  manager.setStoresForgetter((id) => forgotten.push(id))

  const s = manager.createSession({ prompt: 'go' })
  agents[0]!.finish()
  await new Promise((r) => setTimeout(r, 20))

  // archive → unloadSession → releaseAgent → forget
  assert.equal(manager.archiveSession(s.id), true)
  assert.deepEqual(forgotten, [s.id], 'archived session must drop its stores entry')

  // delete requires archived; hardDelete forgets again (idempotent).
  assert.equal(manager.deleteSession(s.id).ok, true)
  assert.deepEqual(forgotten, [s.id, s.id], 'hard-deleted session forgets unconditionally')
})

// ── stall-observer 收口回归（b3329e590 审查发现：run 收尾 done 事件在
// markIdle 之后无条件 touchActivity，sidecar/desktop 下交付后等用户仍会被
// 误报 stall——settlement 的 done 落盘后会话必须进入 idle）。───────────────
test('stall-observer: run 收尾 done 落盘后会话进入 idle（交付后等用户不误报）', async () => {
  const { _resetStallObserverForTest, getLastActivity, clearActivity } = await import('../../agent/stall-observer.js')
  _resetStallObserverForTest()
  const { manager, agents } = makeManager()
  const s = manager.createSession({ prompt: 'go' }) // run 起跑 → append user/status → touch
  try {
    // run 进行中：条目存在且非 idle（观察器正常监控）
    assert.equal(getLastActivity(s.id).idle, false, 'run 进行中不应 idle')
    agents[0]!.finish() // run resolve → settlement 收尾 append done
    await new Promise((r) => setTimeout(r, 0)) // settlement 微任务链跑完
    await new Promise((r) => setImmediate(r))
    const act = getLastActivity(s.id)
    assert.equal(act.idle, true, `done 收尾后会话应 idle（实际 source=${act.source} idle=${act.idle}）`)
    assert.equal(manager.getSession(s.id)!.status, 'completed')
  } finally {
    clearActivity(s.id)
  }
})
