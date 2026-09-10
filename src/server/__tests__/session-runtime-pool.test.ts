import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type SessionStatus,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

class ControlledAgent implements ManagedAgent {
  callbacks: AgentCallbacks[] = []
  concurrentRunAttempts = 0
  private active = false
  private resolvers: Array<() => void> = []

  run(_prompt: string, callbacks: AgentCallbacks): Promise<void> {
    if (this.active) {
      this.concurrentRunAttempts++
      return Promise.reject(new Error('concurrent run'))
    }
    this.active = true
    this.callbacks.push(callbacks)
    return new Promise((resolve) => { this.resolvers.push(resolve) })
  }

  finish(index: number): void {
    const resolve = this.resolvers[index]
    if (!resolve) return
    this.active = false
    resolve()
  }

  abort(): void {}
  listArtifacts() { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages() { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
}

class TrackedAbortSignal {
  aborted = false
  listenerCount = 0
  private readonly listeners = new Set<() => void>()

  addEventListener(type: string, callback: () => void): void {
    if (type !== 'abort') return
    this.listeners.add(callback)
    this.listenerCount = this.listeners.size
  }

  removeEventListener(type: string, callback: () => void): void {
    if (type !== 'abort') return
    this.listeners.delete(callback)
    this.listenerCount = this.listeners.size
  }

  abort(): void {
    this.aborted = true
    for (const listener of [...this.listeners]) listener()
  }
}

function setup() {
  const agents: ControlledAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = new ControlledAgent()
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
    idleAgentTtlMs: 0,
  })
  const pool = new SessionRuntimePool({ manager, defaultCwd: '/tmp/work' })
  return { manager, pool, agents }
}

function listenerCount(manager: RuntimeSessionManager, id: string): number {
  return (manager as unknown as {
    sessions: Map<string, { listeners: Set<unknown> }>
  }).sessions.get(id)?.listeners.size ?? 0
}

async function observed<T>(promise: Promise<T>): Promise<
  { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'pending' }
> {
  let result:
    | { kind: 'resolved'; value: T }
    | { kind: 'rejected'; error: unknown }
    | { kind: 'pending' } = { kind: 'pending' }
  void promise.then(
    (value) => { result = { kind: 'resolved', value } },
    (error: unknown) => { result = { kind: 'rejected', error } },
  )
  await new Promise((resolve) => setImmediate(resolve))
  return result
}

async function startPoolRun() {
  const env = setup()
  const handle = await env.pool.acquire('task-1')
  const signal = new TrackedAbortSignal()
  let sessionId = ''
  const execution = handle.execute(
    'work',
    signal as unknown as AbortSignal,
    undefined,
    (id) => { sessionId = id },
  )
  return { ...env, handle, signal, sessionId, execution, agent: env.agents[0]! }
}

test('runtime pool runAndWait settles normally and removes all waiters', async () => {
  const run = await startPoolRun()
  assert.equal(listenerCount(run.manager, run.sessionId), 0)
  assert.equal(run.signal.listenerCount, 1)

  run.agent.finish(0)
  const result = await run.execution
  assert.match(result.summary, /status=completed/)
  assert.equal(
    run.manager.getEvents(run.sessionId, 0)!.events.some((event) => event.type === 'done'),
    true,
  )
  assert.equal(listenerCount(run.manager, run.sessionId), 0)
  assert.equal(run.signal.listenerCount, 0)
})

test('runtime pool cancellation waits for exact aborted run settlement', async () => {
  const run = await startPoolRun()
  run.signal.abort()
  assert.equal((await observed(run.execution)).kind, 'pending')

  run.agent.finish(0)
  const outcome = await observed(run.execution)
  assert.equal(outcome.kind, 'rejected')
  assert.match(String(outcome.kind === 'rejected' ? outcome.error : ''), /aborted/)
  assert.equal(listenerCount(run.manager, run.sessionId), 0)
  assert.equal(run.signal.listenerCount, 0)
})

test('runtime pool pre-aborted signal cancels the run it starts', async () => {
  const { manager, pool, agents } = setup()
  const handle = await pool.acquire('task-pre-aborted')
  const signal = new TrackedAbortSignal()
  signal.abort()
  let sessionId = ''
  const execution = handle.execute(
    'work',
    signal as unknown as AbortSignal,
    undefined,
    (id) => { sessionId = id },
  )

  assert.equal((await observed(execution)).kind, 'pending')
  agents[0]!.finish(0)
  const outcome = await observed(execution)
  assert.equal(outcome.kind, 'rejected')
  assert.match(String(outcome.kind === 'rejected' ? outcome.error : ''), /aborted/)
  assert.equal(listenerCount(manager, sessionId), 0)
  assert.equal(signal.listenerCount, 0)
})

test('runAndWait settles on archive and hard delete without public done', async () => {
  for (const hardDelete of [false, true]) {
    const run = await startPoolRun()
    const listeners = (run.manager as unknown as {
      sessions: Map<string, { listeners: Set<unknown> }>
    }).sessions.get(run.sessionId)!.listeners
    const internalEvents = (run.manager as unknown as {
      sessions: Map<string, { events: Array<{ type: string }> }>
    }).sessions.get(run.sessionId)!.events
    assert.equal(run.manager.archiveSession(run.sessionId), true)
    if (hardDelete) {
      assert.equal(run.manager.deleteSession(run.sessionId).ok, true)
    }
    run.agent.finish(0)

    const outcome = await observed(run.execution)
    assert.equal(outcome.kind, 'rejected')
    assert.match(String(outcome.kind === 'rejected' ? outcome.error : ''), /aborted/)
    assert.equal(internalEvents.some((event) => event.type === 'done'), false)
    assert.equal(listeners.size, 0)
    assert.equal(run.signal.listenerCount, 0)
  }
})

test('runAndWait is tied to its exact run across rapid next run', async () => {
  const { manager, agents } = setup()
  const session = manager.createSession()
  const first = manager.runAndWait(session.id, 'first')
  assert.equal(manager.abort(session.id), true)
  agents[0]!.finish(0)

  const firstOutcome = await observed(first)
  assert.equal(firstOutcome.kind, 'resolved')
  assert.equal(
    firstOutcome.kind === 'resolved' ? firstOutcome.value.status : undefined,
    'aborted' satisfies SessionStatus,
  )
  const second = manager.runAndWait(session.id, 'second')
  assert.equal((await observed(second)).kind, 'pending')
  assert.equal(agents[0]!.concurrentRunAttempts, 0)

  agents[0]!.finish(1)
  const secondOutcome = await observed(second)
  assert.equal(secondOutcome.kind, 'resolved')
  assert.equal(
    secondOutcome.kind === 'resolved' ? secondOutcome.value.status : undefined,
    'completed' satisfies SessionStatus,
  )
  assert.equal(listenerCount(manager, session.id), 0)
})


test('execute options.cwd 优先于池 defaultCwd（2026-09-11 F2：cron 任务在创建工作区跑）', async () => {
  const env = setup()
  const captured: Array<string | undefined> = []
  const orig = env.manager.createSession.bind(env.manager)
  env.manager.createSession = ((opts: { cwd?: string } & Record<string, unknown>) => {
    captured.push(opts?.cwd)
    return orig(opts)
  }) as typeof env.manager.createSession

  const handle = await env.pool.acquire('task-cwd')
  const signal = new TrackedAbortSignal()
  const withCwd = handle.execute('work', signal as unknown as AbortSignal, undefined, () => {}, { cwd: '/workspace/A' })
  env.agents[0]!.finish(0)
  await withCwd
  const withoutCwd = handle.execute('work', signal as unknown as AbortSignal, undefined, () => {})
  env.agents[1]!.finish(0)
  await withoutCwd

  assert.equal(captured[0], '/workspace/A', '任务自带 cwd 优先')
  assert.equal(captured[1], '/tmp/work', '缺省回退池 defaultCwd（行为不变）')
})

