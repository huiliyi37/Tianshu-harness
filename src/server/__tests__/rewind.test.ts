/**
 * Rewind feature tests — covers RuntimeSessionManager.listRewindPoints + rewind,
 * plus session-routes GET /rewind-points + POST /rewind.
 *
 * Anti-proof table (each test would FAIL against a specific lazy implementation):
 *   #1 "only truncates events, no rewind marker" → test 4 checks for type=rewind event
 *   #2 "replaceMessages without checking running" → test 3 verifies running is rejected
 *   #3 "rewind doesn't actually truncate messages" → test 2 verifies message count after rewind
 *   #4 "listRewindPoints returns all messages" → test 1 verifies only user+string entries returned
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { SessionContext } from '../../agent/context.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Agent with a real in-memory message store for testing rewind. */
class RewindableAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  messages: OaiMessage[] = []
  artifacts: Artifact[] = []
  private resolveRun?: () => void

  run(_prompt: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    // Immediately resolve so session returns to idle right away.
    return Promise.resolve()
  }
  finish(): void { this.resolveRun?.() }
  abort(): void { this.resolveRun?.() }
  listArtifacts(): Artifact[] { return this.artifacts }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
}

function makeMessages(): OaiMessage[] {
  return [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Do task A' },
    { role: 'assistant', content: 'Doing A' },
    { role: 'user', content: 'Now do B' },
    { role: 'assistant', content: 'Doing B' },
  ]
}

/**
 * Agent that mirrors each run into user+assistant messages, so the event log's
 * `user` events line up 1:1 with user messages (the real prompt flow). rewind
 * points only carry a seq anchor when such a pairing exists — messages injected
 * out-of-band (RewindableAgent + makeMessages) have no event and are therefore
 * deliberately absent from the list (fail-closed: the desktop toasts instead of
 * cutting at a wrong index).
 */
class TurnMirrorAgent implements ManagedAgent {
  messages: OaiMessage[] = []
  run(prompt: string, _cb: AgentCallbacks): Promise<void> {
    this.messages.push({ role: 'user', content: prompt })
    this.messages.push({ role: 'assistant', content: 'ok' })
    return Promise.resolve()
  }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(m: OaiMessage[]): void { this.messages = m }
  rewindToMessages(m: OaiMessage[]): void { this.messages = m }
}

/** Three mirrored turns: messages [u,a,u,a,u,a], three `user` events. */
async function makeMirrorSession(): Promise<{ manager: RuntimeSessionManager; id: string }> {
  const manager = new RuntimeSessionManager({
    createAgent: () => new TurnMirrorAgent(),
    defaultCwd: '/tmp',
  })
  const s = manager.createSession({ prompt: 'Hello' })
  await new Promise(r => setTimeout(r, 10))
  manager.run(s.id, 'Do task A')
  await new Promise(r => setTimeout(r, 10))
  manager.run(s.id, 'Now do B')
  await new Promise(r => setTimeout(r, 10))
  return { manager, id: s.id }
}

function setup() {
  const agents: RewindableAgent[] = []
  const manager = new RuntimeSessionManager({
    // Sync agent: resolves run immediately → session returns to idle at once.
    createAgent: () => {
      const a = new RewindableAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router, agents }
}

/** Create a session with messages populated, in idle state. */
async function makeSession(manager: RuntimeSessionManager, agents: RewindableAgent[]): Promise<string> {
  const s = manager.createSession({ prompt: 'init' })
  // Wait for the auto-run to settle (RewindableAgent resolves immediately)
  await new Promise(r => setTimeout(r, 10))
  agents[agents.length - 1]!.messages = makeMessages()
  return s.id
}

test('#1 listRewindPoints returns only user messages with string content', async () => {
  const { manager, id } = await makeMirrorSession()

  const points = (await manager.listRewindPoints(id))!
  assert.equal(points.length, 3, 'should find 3 user messages')
  assert.equal(points[0]!.content, 'Hello')
  assert.equal(points[1]!.content, 'Do task A')
  assert.equal(points[2]!.content, 'Now do B')
  // Indices must match the message array positions
  assert.equal(points[0]!.index, 0)
  assert.equal(points[1]!.index, 2)
  assert.equal(points[2]!.index, 4)
  // Every entry carries the seq of its originating `user` event — the desktop
  // anchors the edit-resend on `u-${seq}`.
  const seqs = manager.getEvents(id, 0)!.events.filter(e => e.type === 'user').map(e => e.seq)
  assert.deepEqual(points.map(p => p.seq), seqs, 'each point exposes its user event seq')
})

test('#2 rewind truncates messages to the selected index', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  // Rewind to index 2 ("Do task A") — keeps messages 0..1, drops the rest
  const ok = manager.rewind(id, 2)
  assert.ok(ok, 'rewind should succeed')

  const msgs = agents[agents.length - 1]!.messages
  assert.equal(msgs.length, 2, 'should have truncated to 2 messages')
  assert.equal(msgs[0]!.role, 'user')
  assert.equal((msgs[0] as { content: string }).content, 'Hello')
  assert.equal(msgs[1]!.role, 'assistant')
})

test('#3 rewind is rejected while session is running', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  // Start a new run (don't wait — session stays running)
  manager.run(id, 'another prompt')

  const ok = manager.rewind(id, 2)
  assert.equal(ok, false, 'rewind must be rejected while running')
  // Messages should NOT have been modified
  assert.equal(agents[agents.length - 1]!.messages.length, 6, 'messages must be untouched')
})

test('#4 rewind appends a rewind event to the event log (append-only)', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  manager.rewind(id, 2)

  const result = manager.getEvents(id, 0)!
  const rewindEvent = result.events.find((e) => e.type === 'rewind')
  assert.ok(rewindEvent, 'event log must contain a rewind event')
  assert.equal(rewindEvent!.data.messageIndex, 2)
  assert.equal(rewindEvent!.data.prompt, 'Do task A')
})

test('#4b rewind emits an anchorSeq matching the rewound user event', async () => {
  // Only a 1:1 event/message pairing lets the manager resolve a duplicate-proof
  // UI anchor — see TurnMirrorAgent.
  const { manager, id } = await makeMirrorSession()

  // messages: [u Hello, a ok, u Do task A, a ok, u Now do B, a ok]
  const points = (await manager.listRewindPoints(id))!
  assert.deepEqual(points.map(p => [p.index, p.content]), [[0, 'Hello'], [2, 'Do task A'], [4, 'Now do B']])

  // Each point exposes the seq of its originating `user` event — the desktop
  // timeline uses it to anchor preview/fork on the exact `u-${seq}` block, so
  // preview equals the post-fork state.
  const userEventSeqs = manager.getEvents(id, 0)!.events.filter(e => e.type === 'user').map(e => e.seq)
  assert.deepEqual(points.map(p => p.seq), userEventSeqs, 'point.seq matches its user event seq')

  assert.ok(manager.rewind(id, 2), 'rewind to "Do task A" should succeed')
  const events = manager.getEvents(id, 0)!.events
  const rewindEvent = events.find(e => e.type === 'rewind')!
  const userEvent = events.find(e => e.type === 'user' && e.data.text === 'Do task A')!
  assert.equal(rewindEvent.data.messageIndex, 2)
  assert.equal(rewindEvent.data.prompt, 'Do task A')
  assert.equal(rewindEvent.data.anchorSeq, userEvent.seq, 'anchorSeq points at the rewound user event')
})

test('#4c rewind omits anchorSeq when the event log diverges from messages', async () => {
  // The default harness injects messages out-of-band (no matching `user`
  // events), so the ordinal/text guard must drop anchorSeq and let the client
  // fall back to its text heuristic — never emit a wrong anchor.
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  manager.rewind(id, 2)
  const rewindEvent = manager.getEvents(id, 0)!.events.find(e => e.type === 'rewind')!
  assert.equal(rewindEvent.data.anchorSeq, undefined, 'diverged log → no anchor emitted')
})

test('#5 rewind with invalid index returns false', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  assert.equal(manager.rewind(id, -1), false, 'negative index rejected')
  assert.equal(manager.rewind(id, 999), false, 'out-of-range index rejected')
  assert.equal(manager.rewind(id, 6), false, 'index == length rejected')
})

test('#6 GET /sessions/:id/rewind-points returns points via HTTP route', async () => {
  const { manager, id } = await makeMirrorSession()
  const router = createRouter(buildSessionRoutes(manager, TOKEN))

  const res = await router('GET', `/sessions/${id}/rewind-points`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { points: { index: number; content: string }[] }
  assert.equal(body.points.length, 3)
  assert.equal(body.points[1]!.content, 'Do task A')
})

test('#7 POST /sessions/:id/rewind truncates via HTTP route', async () => {
  const { manager, router, agents } = setup()
  const id = await makeSession(manager, agents)

  const res = await router('POST', `/sessions/${id}/rewind`, { messageIndex: 2 }, AUTH)
  assert.equal(res.status, 200)
  assert.equal(agents[agents.length - 1]!.messages.length, 2, 'messages truncated via route')
})

test('#8 POST /rewind returns 409 when session is running', async () => {
  // HangingRunAgent keeps the session running until aborted. The route became
  // async (lazy agent build for rehydrated sessions) — without a hanging run
  // the auto-run would settle during the awaited build and the running guard
  // would never be observed (regression caught when #63's lazy-build landed).
  class HangingRunAgent extends RewindableAgent {
    run(_prompt: string, cb: AgentCallbacks): Promise<void> {
      this.callbacks = cb
      return new Promise<void>(() => {})
    }
  }
  const agents: HangingRunAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new HangingRunAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  const s = manager.createSession({ prompt: 'init' }) // auto-run hangs → session stays running
  await new Promise(r => setTimeout(r, 10))
  agents[0]!.messages = makeMessages()

  const res = await router('POST', `/sessions/${s.id}/rewind`, { messageIndex: 2 }, AUTH)
  assert.equal(res.status, 409, 'rewind must be rejected while session is running')
  assert.equal(agents[0]!.messages.length, 6, 'messages must be untouched while running')
})

test('#9 [反证 #2] SessionContext.rewindToMessages resets turnCount + turnCacheHistory + files', () => {
  const ctx = new SessionContext()
  // Simulate 3 turns
  ctx.addUserMessage('msg1')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp1' }])
  ctx.addUserMessage('msg2')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp2' }])
  ctx.addUserMessage('msg3')
  ctx.addAssistantBlocks([{ type: 'text', text: 'resp3' }])
  ctx.recordTurnCache(3, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 })
  ctx.trackFileRead('src/a.ts')
  ctx.trackFileModified('src/b.ts')

  assert.equal(ctx.getTurnCount(), 3, '3 user messages → turnCount 3')
  assert.ok(ctx.getFilesRead().includes('src/a.ts'), 'filesRead tracks read files')

  // Rewind to turn 1: keep only first user+assistant pair
  const msgs = ctx.getMessages().slice(0, 2)
  ctx.rewindToMessages(msgs)

  assert.equal(ctx.getTurnCount(), 1, 'after rewind turnCount should be 1')
  assert.equal(ctx.getCacheHistory().length, 0, 'turnCacheHistory should be cleared')
  assert.equal(ctx.getFilesRead().length, 0, 'filesRead should be cleared')
  assert.equal(ctx.getFilesModified().length, 0, 'filesModified should be cleared')
})

test('#10 timestamp comes from the paired user event', async () => {
  const { manager, id } = await makeMirrorSession()
  const points = (await manager.listRewindPoints(id))!

  assert.equal(points.length, 3, 'only messages with a matching user event are listed')
  assert.ok(points.every(p => p.timestamp > 0), 'each point carries its user event timestamp')
})

test('#11 rewind with rollbackFiles does not crash', async () => {
  const { manager, agents } = setup()
  const id = await makeSession(manager, agents)

  // rollbackFiles: true triggers dynamic import of checkpoint.ts.
  // In unit tests there's no real git repo → the best-effort catch swallows.
  // The important thing is: rewind still succeeds on the message path.
  const ok = manager.rewind(id, 2, { rollbackFiles: true })
  assert.ok(ok, 'rewind with rollbackFiles should return true')
  // Messages should still be truncated even if file rollback failed silently.
  assert.equal(agents[agents.length - 1]!.messages.length, 2, 'messages truncated')
})

test('#12 listRewindPoints lazily builds an agent for a no-agent session (rehydrated)', async () => {
  // Issue #63 root cause: a rehydrated session (sidecar restart) has no live
  // agent; the old `if (!s.agent) return []` made every "保存并重发" edit-save
  // fail after an app restart. listRewindPoints must ensure the agent — which
  // restores disk history — instead of returning an empty list.
  const agents: RewindableAgent[] = []
  let restoreMessages: OaiMessage[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new RewindableAgent()
      if (restoreMessages.length > 0) a.messages = [...restoreMessages]
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  // History-only session: no prompt → no auto-run → agent stays null.
  const s = manager.createSession({ title: 'history-only' })
  assert.equal(agents.length, 0, 'precondition: no agent built yet')
  restoreMessages = makeMessages() // what the agent restores from disk

  const points = (await manager.listRewindPoints(s.id))!
  assert.equal(agents.length, 1, 'must lazily build the agent instead of returning []')
  // 这些消息是 out-of-band 注入的（没有 `user` 事件）→ 无 seq 可锚定，按新语义
  // 不产出条目（宁可前端报「回退点未就绪」，也不切到错误的消息索引）。真实
  // rehydrate 会话的事件日志在磁盘上（getAllEventsAsync 全量读），配得上。
  assert.equal(points.length, 0, '无事件锚点的消息不进 rewind 点')
})

test('#13 POST /rewind succeeds on a no-agent session via lazy build', async () => {
  const agents: RewindableAgent[] = []
  let restoreMessages: OaiMessage[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new RewindableAgent()
      if (restoreMessages.length > 0) a.messages = [...restoreMessages]
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  const s = manager.createSession({ title: 'history-only' })
  assert.equal(agents.length, 0, 'precondition: no agent built yet')
  restoreMessages = makeMessages()

  const res = await router('POST', `/sessions/${s.id}/rewind`, { messageIndex: 2 }, AUTH)
  assert.equal(res.status, 200, 'rewind must lazily build the agent and truncate')
  assert.equal(agents.length, 1, 'one agent built on demand')
  assert.equal(agents[0]!.messages.length, 2, 'messages truncated to index 2')
})

test('#14 concurrent listRewindPoints share one lazy agent build (agentBuilds lock)', async () => {
  // Production createAgent is async (dynamic serve-agent import); every other
  // harness stub returns synchronously, so ensureAgent's promise branch — the
  // agentBuilds lock (set / inflight share / finally cleanup) — was never
  // executed. Two concurrent callers on an agent-less session must trigger
  // exactly ONE build and both observe the same agent.
  const agents: RewindableAgent[] = []
  const resolvers: ((a: RewindableAgent) => void)[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new RewindableAgent()
      agents.push(a)
      return new Promise<ManagedAgent>((res) => { resolvers.push(() => res(a)) })
    },
    defaultCwd: '/tmp',
  })
  const s = manager.createSession({ title: 'concurrent' })
  assert.equal(agents.length, 0, 'precondition: no agent built yet')

  const p1 = manager.listRewindPoints(s.id)
  const p2 = manager.listRewindPoints(s.id)
  // Let both calls reach ensureAgent (first triggers the build, second must
  // hit the in-flight lock instead of starting a second createAgent).
  await new Promise(r => setTimeout(r, 5))
  assert.equal(agents.length, 1, 'exactly one build started for two concurrent callers')

  // Resolve the build → both callers complete against the same agent.
  const agent = agents[0]!
  agent.messages = makeMessages()
  resolvers[0]!(agent)
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1!.length, 0, 'out-of-band 消息无事件锚点（本用例主体是锁与共享）')
  assert.deepEqual(r2, r1, 'second caller shares the same agent (same points)')

  // Once the agent exists, a follow-up call short-circuits (no second build).
  const r3 = await manager.listRewindPoints(s.id)
  assert.equal(agents.length, 1, 'settled agent is reused, no rebuild')
  assert.deepEqual(r3, r1, 'same points again')
})

test('#15 failed lazy build does not leak an unhandled rejection (lock cleanup)', async () => {
  // createAgent rejects (cwd removed / config invalid) → listRewindPoints
  // catches → []. But if the lock cleanup is `void pending.finally(...)`, the
  // derived promise inherits the rejection and nobody awaits it → an
  // unhandledRejection fires (the eperm-filter global handler prints stderr
  // noise on every failed build; Node default would crash). Cleanup must use a
  // two-arg then so the derived promise settles either way.
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const manager = new RuntimeSessionManager({
      createAgent: () => Promise.reject(new Error('cwd missing')),
      defaultCwd: '/tmp',
    })
    const s = manager.createSession({ title: 'broken' })
    const points = await manager.listRewindPoints(s.id)
    assert.equal(points!.length, 0, 'build failure degrades to empty list (no throw)')
    // Give the unhandledRejection check a chance to fire if the lock cleanup leaked.
    await new Promise(r => setTimeout(r, 20))
    assert.equal(unhandled.length, 0, 'no unhandled rejection leaked from the lock cleanup')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
