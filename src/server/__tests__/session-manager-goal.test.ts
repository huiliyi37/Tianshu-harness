/**
 * Goal mode wiring tests for RuntimeSessionManager.
 *
 * Covers the layer added in commit 5f76e7fc: setGoal/pauseGoal/resumeGoal/
 * cancelGoal/getGoalState, the resolveGoalHandles callback contract, and the
 * critical cancel→setGoal race that motivated making cancelGoal async.
 *
 * These tests use a REAL GoalTracker + a REAL temp sessionDir (via os.tmpdir)
 * so the persist/restore path is exercised end-to-end — not a mock.
 */
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent, type GoalHandles } from '../session-manager.js'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { GoalTracker } from '../../agent/goal-tracker.js'
import { saveGoalState, restoreGoalTracker, loadGoalState } from '../../agent/goal-persist.js'
import type { GoalSnapshot } from '../session-manager.js'
import type { Artifact } from '../../artifact/types.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { PlanDocument } from '../../plan/plan-store.js'
import type { SessionEvent, SessionRecord } from '../protocol.js'

/** Minimal fake agent that remembers the tracker it was handed (for the
 *  double-track assertion: cancelGoal must clear BOTH refs AND agent field). */
class GoalFakeAgent implements ManagedAgent {
  tracker: GoalTracker | null = null
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  setGoalTracker(t: GoalTracker | null): void { this.tracker = t }
  getGoalTracker(): GoalTracker | null { return this.tracker }
}

function makeManager(sessionDir: string) {
  // The goalTrackerRef is shared between the resolver and the fake agent via
  // closure — mirrors how serve-agent wires it (refs hold the slot that tool
  // closures read; agent holds its own field).
  const goalTrackerRef: { current: GoalTracker | null } = { current: null }
  const fakeAgents: GoalFakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new GoalFakeAgent(); fakeAgents.push(a); return a },
    defaultCwd: '/tmp',
    resolveGoalHandles: () => ({ goalTrackerRef, sessionDir } as GoalHandles),
  })
  return { manager, goalTrackerRef, fakeAgents }
}

describe('RuntimeSessionManager goal mode', () => {
  let sessionDir: string

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'rivet-goal-test-'))
  })
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  test('setGoal creates a tracker, syncs agent + refs, and persists state', async () => {
    const { manager, goalTrackerRef, fakeAgents } = makeManager(sessionDir)
    const s = manager.createSession({})
    // Trigger agent build so setGoalTracker has a target.
    void manager.run(s.id, "go")

    const snap = await manager.setGoal(s.id, {
      goal: 'refactor foo',
      maxIterations: 50,
      contextWindow: 100_000,
    })
    assert.equal(snap?.status, 'active')
    assert.equal(snap?.goal, 'refactor foo')
    // Double-track sync: both the refs slot and the agent field point at it.
    assert.ok(goalTrackerRef.current, 'refs.goalTrackerRef.current populated')
    assert.equal(fakeAgents[0]?.tracker, goalTrackerRef.current, 'agent tracker === refs tracker')
    // Persisted to disk (GoalStateRecord uses `objective`, not `goal`).
    const record = loadGoalState(sessionDir, s.id)
    assert.ok(record, 'goal state persisted')
    assert.equal(record!.objective, 'refactor foo')
  })

  test('getGoalState reads from refs first, falls back to agent field', async () => {
    const { manager, goalTrackerRef } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, "go")
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    // Primary path: refs.current populated.
    assert.equal(manager.getGoalState(s.id)?.goal, 'x')

    // Fallback path: clear refs.current, agent field still has it.
    goalTrackerRef.current = null
    const fromAgent = manager.getGoalState(s.id)
    assert.equal(fromAgent?.goal, 'x', 'getGoalState falls back to agent.getGoalTracker()')
  })

  test('pauseGoal/resumeGoal round-trip through tracker state', async () => {
    const { manager } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, "go")
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    const paused = manager.pauseGoal(s.id)
    assert.equal(paused?.status, 'paused')

    const resumed = manager.resumeGoal(s.id)
    assert.equal(resumed?.status, 'active')
  })

  test('cancelGoal clears agent field + refs + persisted file', async () => {
    const { manager, goalTrackerRef, fakeAgents } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, "go")
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })
    assert.ok(existsSync(join(sessionDir, `${s.id}.goal.json`)), 'state file written')

    const snap = await manager.cancelGoal(s.id)
    assert.equal(snap?.status, 'complete')
    assert.equal(snap?.terminalReason, 'cancelled')
    assert.equal(goalTrackerRef.current, null, 'refs cleared')
    assert.equal(fakeAgents[0]?.tracker, null, 'agent field cleared')
    assert.equal(existsSync(join(sessionDir, `${s.id}.goal.json`)), false, 'persisted file deleted')
  })

  test('cancel→setGoal race: a setGoal right after cancel is NOT wiped', async () => {
    // Regression guard for the fire-and-forget delete race (commit msg §①).
    // Before the fix, cancelGoal's delete was a dynamic-import .then() that
    // could land AFTER a subsequent setGoal's saveGoalState, deleting the new
    // goal's state file. Now cancelGoal awaits the delete.
    const { manager } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, "go")
    await manager.setGoal(s.id, { goal: 'first', maxIterations: 10, contextWindow: 1000 })

    await manager.cancelGoal(s.id)
    // Immediately set a new goal — this is the race window.
    const snap = await manager.setGoal(s.id, { goal: 'second', maxIterations: 10, contextWindow: 1000 })
    assert.equal(snap?.goal, 'second')

    // The new goal's state file must still exist (not wiped by a late delete).
    // Give any pending microtasks a chance to flush — if the old fire-and-
    // forget delete were still in play, it would land here.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 10))
    const record = loadGoalState(sessionDir, s.id)
    assert.ok(record, 'second goal state survived (no late delete)')
    assert.equal(record!.objective, 'second', 'persisted state is the NEW goal, not wiped')
    // And the live tracker reflects the new goal.
    assert.equal(manager.getGoalState(s.id)?.goal, 'second')
  })

  test('restoreGoalTracker normalizes active→paused across a restart', () => {
    // Mirrors the sidecar-restart safety: a goal that was active when the
    // sidecar died must come back as paused, never auto-resume.
    const sessionId = 'restart-test'
    const tracker = new GoalTracker({
      goal: 'survive restart',
      maxIterations: 20,
      contextWindow: 1000,
    })
    saveGoalState(sessionDir, sessionId, tracker)
    assert.equal(loadGoalState(sessionDir, sessionId)?.status, 'active')

    // Simulate a restart: restore via the same path serve-agent uses.
    const restored = restoreGoalTracker(sessionDir, sessionId, { maxJudgeRuns: 3 })
    assert.ok(restored, 'restored from disk')
    assert.equal(restored!.getStatus(), 'paused', 'active downgraded to paused on restore')
    assert.equal(restored!.getGoal(), 'survive restart')
  })

  test('cancelGoal on a session with no tracker returns null (no throw)', async () => {
    const { manager } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, "go")
    // No setGoal yet — cancelGoal must degrade cleanly.
    const snap = await manager.cancelGoal(s.id)
    assert.equal(snap, null)
  })

  test('goal methods return null when resolveGoalHandles is absent', async () => {
    // Test doubles / legacy sidecar: no resolveGoalHandles wired. Every goal
    // method must degrade to null rather than throw.
    const manager = new RuntimeSessionManager({
      createAgent: () => new GoalFakeAgent(),
      defaultCwd: '/tmp',
      // Note: NO resolveGoalHandles.
    })
    const s = manager.createSession({})
    void manager.run(s.id, "go")
    assert.equal(manager.getGoalState(s.id), null)
    assert.equal(manager.pauseGoal(s.id), null)
    assert.equal(await manager.cancelGoal(s.id), null)
    assert.equal(await manager.setGoal(s.id, { goal: 'x', maxIterations: 5, contextWindow: 1000 }), null)
  })

  test('run emits a goal_state baseline snapshot on first user message', async () => {
    // P2-B Wave 1: wasFirstUser 分支内追加 goal_state 基线快照，
    // 让 MissionProjector 不再因 goal_state 零出现而空转。
    const { manager } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, 'hello world')

    // Flush microtasks so the synchronous append calls (user + status + goal_state) complete.
    await new Promise((r) => setImmediate(r))

    const evs = manager.getEvents(s.id)
    assert.ok(evs, 'events exist')
    const goalEvs = evs!.events.filter((e) => e.type === 'goal_state')
    assert.equal(goalEvs.length, 1, 'exactly one goal_state baseline snapshot')
    const data = goalEvs[0]!.data as Record<string, unknown>
    assert.equal(data.status, 'active')
    assert.equal(data.iteration, 0)
    assert.equal(typeof data.wallClockElapsedMs, 'number')
  })

  test('run does NOT emit goal_state baseline on subsequent (non-first) messages', async () => {
    // Only the FIRST user message should trigger the baseline — not every run.
    const { manager } = makeManager(sessionDir)
    const s = manager.createSession({})
    void manager.run(s.id, 'first message')
    await new Promise((r) => setImmediate(r))

    // Second run — wasFirstUser should be false.
    void manager.run(s.id, 'second message')
    await new Promise((r) => setImmediate(r))

    const evs = manager.getEvents(s.id)
    const goalEvs = evs!.events.filter((e) => e.type === 'goal_state')
    assert.equal(goalEvs.length, 1, 'still only 1 goal_state (baseline not re-emitted)')
  })
})

describe('Goal 计划倒计时自动批准（2026-07-24）', () => {
  let sessionDir: string

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'rivet-goal-plan-auto-'))
  })
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  type CapturingAgent = GoalFakeAgent & { callbacks?: AgentCallbacks }

  function makePlanManager(opts: { delayMs: number; plans: PlanDocument[]; globalApprovalMode?: string }) {
    const goalTrackerRef: { current: GoalTracker | null } = { current: null }
    const agents: CapturingAgent[] = []
    const manager = new RuntimeSessionManager({
      createAgent: () => {
        const a = new GoalFakeAgent() as CapturingAgent
        a.run = (_p, cb) => { a.callbacks = cb; return Promise.resolve() }
        agents.push(a)
        return a
      },
      defaultCwd: '/tmp',
      resolveGoalHandles: () => ({ goalTrackerRef, sessionDir } as GoalHandles),
      goalPlanAutoApproveMs: opts.delayMs,
      globalApprovalMode: opts.globalApprovalMode as any,
      listPlans: async () => opts.plans,
    })
    return { manager, agents }
  }

  function submittedPlan(slug = 'p-1'): PlanDocument {
    return {
      slug,
      title: 'Plan One',
      status: 'submitted',
      content: '# P1',
      path: `.rivet/plans/${slug}.md`,
      createdAt: new Date(),
    }
  }

  async function submitPlanViaTool(cb: AgentCallbacks): Promise<void> {
    cb.onToolUse('t1', 'plan', { action: 'submit' })
    cb.onToolResult('t1', 'plan', 'ok', false)
    await new Promise((r) => setTimeout(r, 20))
  }

  test('goal 激活时计划提交武装倒计时；非 submit action 不武装', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 5000, plans: [submittedPlan()] })
    const s = manager.createSession({ planAutoApproveUi: true })
    void manager.run(s.id, 'go')
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    const cb = agents[0]!.callbacks!
    await submitPlanViaTool(cb)

    const pending = manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 1, 'goal 激活 + submit → 武装一次')
    assert.equal(pending[0]!.data.slug, 'p-1')
    assert.equal(typeof pending[0]!.data.deadlineMs, 'number')

    // 未登记 toolId 的 plan 结果（非 submit action）不得触发第二次武装
    cb.onToolResult('t2', 'plan', 'ok', false)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending').length, 1)
  })

  test('非 goal 会话不武装（纯手动审批语义不变）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 5000, plans: [submittedPlan()] })
    const s = manager.createSession({ planAutoApproveUi: true })
    void manager.run(s.id, 'go')

    await submitPlanViaTool(agents[0]!.callbacks!)
    const pending = manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 0)
  })

  test('到期触发 approvePlan（同 slug）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 40, plans: [submittedPlan()] })
    const s = manager.createSession({ planAutoApproveUi: true })
    void manager.run(s.id, 'go')
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    const calls: Array<[string, string]> = []
    ;(manager as unknown as { approvePlan: (id: string, slug: string) => Promise<{ ok: boolean }> }).approvePlan =
      async (id, slug) => { calls.push([id, slug]); return { ok: true } }

    await submitPlanViaTool(agents[0]!.callbacks!)
    await new Promise((r) => setTimeout(r, 150))
    assert.deepEqual(calls, [[s.id, 'p-1']])
  })

  test('显式取消后到期不触发（cancelled 事件带 reason）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 40, plans: [submittedPlan()] })
    const s = manager.createSession({ planAutoApproveUi: true })
    void manager.run(s.id, 'go')
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    const calls: Array<[string, string]> = []
    ;(manager as unknown as { approvePlan: (id: string, slug: string) => Promise<{ ok: boolean }> }).approvePlan =
      async (id, slug) => { calls.push([id, slug]); return { ok: true } }

    await submitPlanViaTool(agents[0]!.callbacks!)
    assert.equal(manager.cancelPlanAutoApproveForUser(s.id), true)
    await new Promise((r) => setTimeout(r, 150))

    assert.deepEqual(calls, [], '取消后定时器不得触发')
    const cancelled = manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_cancelled')
    assert.equal(cancelled.length, 1)
    assert.equal(cancelled[0]!.data.reason, 'user')
  })

  test('P1b: planAutoApproveUi=false 时不武装（fail-closed，vscode-extension 安全边界）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 40, plans: [submittedPlan()] })
    // 默认不传 planAutoApproveUi → fail-closed：goal 激活 + 计划提交 → 不武装
    const s = manager.createSession({})
    void manager.run(s.id, 'go')
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    await submitPlanViaTool(agents[0]!.callbacks!)
    const pending = manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 0, 'planAutoApproveUi 未设置 → 不发射 plan_auto_approve_pending')
  })

  test('P1b: planAutoApproveUi=true 时正常武装（desktop 可见倒计时）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 40, plans: [submittedPlan()] })
    const s = manager.createSession({ planAutoApproveUi: true })
    void manager.run(s.id, 'go')
    await manager.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    await submitPlanViaTool(agents[0]!.callbacks!)
    const pending = manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 1, 'planAutoApproveUi=true → 正常武装倒计时')
    assert.equal(pending[0]!.data.slug, 'p-1')
  })

  // P1b 的标记此前只活在 InternalSession——sidecar 重启 rehydrate 后静默丢失，
  // 同一客户端重启前后行为不一致。现在随 record 持久化，恢复路径读回。
  test('P1b: planAutoApproveUi 随 record 持久化——重启 rehydrate 后仍武装', async () => {
    type Entry = { record: SessionRecord; events: SessionEvent[] }
    const store = new Map<string, Entry>()
    const persistence = {
      saveRecord: (record: SessionRecord) => {
        store.set(record.id, { record: { ...record }, events: store.get(record.id)?.events ?? [] })
      },
      appendEvent: (sessionId: string, event: SessionEvent) => { store.get(sessionId)?.events.push(event) },
      loadAll: () => [...store.values()].map(v => ({ record: v.record, events: v.events })),
      loadRecords: () => [...store.values()].map(v => ({ ...v.record })),
      loadEvents: (sessionId: string) => [...(store.get(sessionId)?.events ?? [])],
    }

    const m1 = new RuntimeSessionManager({
      createAgent: () => new GoalFakeAgent() as CapturingAgent,
      defaultCwd: '/tmp',
      goalPlanAutoApproveMs: 5000,
      persistence,
    })
    const s = m1.createSession({ planAutoApproveUi: true })
    assert.equal(store.get(s.id)?.record.planAutoApproveUi, true, '创建时标记必须随 record 落盘')

    // 第二个 manager 模拟 sidecar 重启：构造即 rehydrate，走 loadRecords 懒路径
    const goalTrackerRef: { current: GoalTracker | null } = { current: null }
    const agents2: CapturingAgent[] = []
    const m2 = new RuntimeSessionManager({
      createAgent: () => {
        const a = new GoalFakeAgent() as CapturingAgent
        a.run = (_p, cb) => { a.callbacks = cb; return Promise.resolve() }
        agents2.push(a)
        return a
      },
      defaultCwd: '/tmp',
      resolveGoalHandles: () => ({ goalTrackerRef, sessionDir } as GoalHandles),
      goalPlanAutoApproveMs: 5000,
      listPlans: async () => [submittedPlan()],
      persistence,
    })
    void m2.run(s.id, 'go')
    await m2.setGoal(s.id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    await submitPlanViaTool(agents2[0]!.callbacks!)
    const pending = m2.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 1, '重启 rehydrate 后 planAutoApproveUi 应读回并正常武装')
  })

  // 上面两个 P1b 测试直连 manager.createSession，绕过了 HTTP 路由——而 bb445ac6
  // 落地时字段恰好丢在路由层（POST /sessions 逐字段构造入参，未透传），导致
  // desktop 与 vscode 一并 fail-closed。以下两个测试走真实路由表，钉住这一跳。
  const ROUTE_TOKEN = 'goal-plan-token'
  const ROUTE_AUTH = { authorization: `Bearer ${ROUTE_TOKEN}` }

  async function createSessionViaRoute(
    manager: RuntimeSessionManager,
    body: Record<string, unknown>,
  ): Promise<string> {
    const router = createRouter(buildSessionRoutes(manager, ROUTE_TOKEN))
    const created = await router('POST', '/sessions', body, ROUTE_AUTH)
    assert.equal(created.status, 201)
    return (created.body as { id: string }).id
  }

  test('P1b 路由层：POST /sessions 必须透传 planAutoApproveUi（desktop 真实路径）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 40, plans: [submittedPlan()] })
    const id = await createSessionViaRoute(manager, { planAutoApproveUi: true })
    void manager.run(id, 'go')
    await manager.setGoal(id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    await submitPlanViaTool(agents[0]!.callbacks!)
    const pending = manager.getEvents(id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 1, '路由层丢字段会让 desktop 一并被 fail-closed')
  })

  test('P1b 路由层：POST /sessions 不带该字段 → 仍 fail-closed（vscode 真实路径）', async () => {
    const { manager, agents } = makePlanManager({ delayMs: 40, plans: [submittedPlan()] })
    const id = await createSessionViaRoute(manager, {})
    void manager.run(id, 'go')
    await manager.setGoal(id, { goal: 'x', maxIterations: 10, contextWindow: 1000 })

    await submitPlanViaTool(agents[0]!.callbacks!)
    const pending = manager.getEvents(id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
    assert.equal(pending.length, 0, '路由层不得把缺省值兜成 true')
  })
// ── 2026-09-05 完全读写档（skip）：审批零打扰——计划提交即自动批准 ──────────

  test('skip 档（会话级 override）计划提交立即自动批准——不等 goal、不等倒计时、无需倒计时 UI', async () => {
  const { manager, agents } = makePlanManager({ delayMs: 5000, plans: [submittedPlan()] })
  const s = manager.createSession({ planAutoApproveUi: false, approvalMode: 'dangerously-skip-permissions' })
  void manager.run(s.id, 'go')

  const calls: Array<[string, string]> = []
  ;(manager as unknown as { approvePlan: (id: string, slug: string) => Promise<{ ok: boolean }> }).approvePlan =
    async (id, slug) => { calls.push([id, slug]); return { ok: true } }

  await submitPlanViaTool(agents[0]!.callbacks!)
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(calls, [[s.id, 'p-1']], 'skip 档提交即批准（0 延迟），P1b UI 守卫不适用')
})

  test('skip 档（全局档、无 override）同样立即自动批准', async () => {
  const { manager, agents } = makePlanManager({
    delayMs: 5000,
    globalApprovalMode: 'dangerously-skip-permissions',
    plans: [submittedPlan()],
  })
  const s = manager.createSession({ planAutoApproveUi: false }) // 无 override
  void manager.run(s.id, 'go')

  const calls: Array<[string, string]> = []
  ;(manager as unknown as { approvePlan: (id: string, slug: string) => Promise<{ ok: boolean }> }).approvePlan =
    async (id, slug) => { calls.push([id, slug]); return { ok: true } }

  await submitPlanViaTool(agents[0]!.callbacks!)
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(calls, [[s.id, 'p-1']])
})

  test('非 skip 档无 override 无 goal 仍不武装（旧行为回归锚点）', async () => {
  const { manager, agents } = makePlanManager({
    delayMs: 5000,
    globalApprovalMode: 'auto-safe',
    plans: [submittedPlan()],
  })
  const s = manager.createSession({ planAutoApproveUi: true })
  void manager.run(s.id, 'go')

  await submitPlanViaTool(agents[0]!.callbacks!)
  const pending = manager.getEvents(s.id)!.events.filter((e) => e.type === 'plan_auto_approve_pending')
  assert.equal(pending.length, 0, 'auto-safe 无 goal 不武装——零打扰只属于 skip 档')
})
})
