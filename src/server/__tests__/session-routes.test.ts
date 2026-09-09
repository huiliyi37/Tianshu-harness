import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes, classifyArtifact, describeModelSwitchFailure } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { SessionRecord } from '../protocol.js'
import type { Config } from '../../config/schema.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillRegistry } from '../../skills/skill-loader.js'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  runPrompts: string[] = []
  activePlanCalls: ({ slug: string; title: string; selectedApproach?: string } | null)[] = []
  enterPlanModeCalls: Array<{ planFilePath?: string } | undefined> = []
  activePlanFilePath: string | null = null
  enabledTools: string[] = []
  settleOnAbort = true
  private resolveRun?: () => void
  run(p: string, cb: AgentCallbacks) { this.runPrompts.push(p); this.callbacks = cb; return new Promise<void>((r) => { this.resolveRun = r }) }
  abort() { if (this.settleOnAbort) this.resolveRun?.() }
  finish() { this.resolveRun?.() }
  enableTool(name: string) { this.enabledTools.push(name); return { status: 'mounted', cacheImpact: 'none' } as const }
  setActivePlan(plan: { slug: string; title: string; selectedApproach?: string } | null) { this.activePlanCalls.push(plan) }
  enterPlanMode(opts?: { planFilePath?: string }) { this.enterPlanModeCalls.push(opts) }
  switchModel(modelId: string): string | null { return modelId }
  getActivePlanFilePath() { return this.activePlanFilePath }
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
  reasoningEffortCalls: string[] = []
  getReasoningEffort() { return this.reasoningEffortCalls[this.reasoningEffortCalls.length - 1] }
  setReasoningEffort(effort: string) { this.reasoningEffortCalls.push(effort) }
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

test('unauthorized requests are rejected (fail-closed)', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions', {}, {})
  assert.equal(res.status, 401)
})

test('create + list + get session lifecycle', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'T' }, AUTH)
  assert.equal(created.status, 201)
  const id = (created.body as { id: string }).id

  const list = await router('GET', '/sessions', {}, AUTH)
  assert.equal((list.body as { sessions: unknown[] }).sessions.length, 1)

  const one = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal(one.status, 200)

  const missing = await router('GET', '/sessions/nope', {}, AUTH)
  assert.equal(missing.status, 404)
})

test('events route reads ?since= from the query string', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  agents[0]!.callbacks!.onTextDelta('one')

  const all = await router('GET', `/sessions/${id}/events?since=0`, {}, AUTH)
  const lastSeq = (all.body as { lastSeq: number }).lastSeq
  assert.ok(lastSeq > 0)

  agents[0]!.callbacks!.onTextDelta('two')
  const tail = await router('GET', `/sessions/${id}/events?since=${lastSeq}`, {}, AUTH)
  const events = (tail.body as { events: Array<{ data: { text: string } }> }).events
  assert.equal(events.length, 1)
  assert.equal(events[0]!.data.text, 'two')
})

test('prompt on a busy session returns 409', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const again = await router('POST', `/sessions/${id}/prompt`, { prompt: 'more' }, AUTH)
  assert.equal(again.status, 409)
})

test('prompt remains 409 through archive-abort settlement, then succeeds', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  agents[0]!.settleOnAbort = false

  assert.equal((await router('DELETE', `/sessions/${id}`, {}, AUTH)).status, 200)
  assert.equal((await router('POST', `/sessions/${id}/unarchive`, {}, AUTH)).status, 200)
  const settling = await router('POST', `/sessions/${id}/prompt`, { prompt: 'too soon' }, AUTH)
  assert.equal(settling.status, 409)
  assert.deepEqual(agents[0]!.runPrompts, ['go'])

  agents[0]!.finish()
  await new Promise((resolve) => setImmediate(resolve))
  const after = await router('POST', `/sessions/${id}/prompt`, { prompt: 'now safe' }, AUTH)
  assert.equal(after.status, 200)
  assert.deepEqual(agents[0]!.runPrompts, ['go', 'now safe'])
})

test('POST /sessions/:id/resume maps manager results to precise status codes', async () => {
  const { router } = setup()
  // busy 会话 → 409（附 code）
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const busy = await router('POST', `/sessions/${id}/resume`, {}, AUTH)
  assert.equal(busy.status, 409)
  assert.equal((busy.body as { code: string }).code, 'busy')
  // 不存在 → 404
  const missing = await router('POST', '/sessions/nope/resume', {}, AUTH)
  assert.equal(missing.status, 404)
  // Bearer-gated
  const unauth = await router('POST', `/sessions/${id}/resume`, {}, {})
  assert.equal(unauth.status, 401)
})

test('T3: POST /steer queues guidance on a running session', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/steer`, { text: 'prefer tests' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { queued: boolean }).queued, true)
})

test('T3: POST /steer on an idle session returns 409', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', {}, AUTH) // idle, no prompt
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/steer`, { text: 'hi' }, AUTH)
  assert.equal(res.status, 409)
})

test('T3: POST /steer validates the text field and is Bearer-gated', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const empty = await router('POST', `/sessions/${id}/steer`, { text: '  ' }, AUTH)
  assert.equal(empty.status, 400)

  const unauth = await router('POST', `/sessions/${id}/steer`, { text: 'x' }, {})
  assert.equal(unauth.status, 401)

  const missing = await router('POST', '/sessions/nope/steer', { text: 'x' }, AUTH)
  assert.equal(missing.status, 404)
})

// ── Phase 2: queue lane routes ──────────────────────────────────────

test('Phase 2: POST /queue queues on a running session; 409 idle; 404 missing; 400 empty', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const res = await router('POST', `/sessions/${id}/queue`, { text: 'follow up' }, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { queued: boolean; laneId: string }
  assert.equal(body.queued, true)
  assert.ok(typeof body.laneId === 'string' && body.laneId.length > 0)

  const empty = await router('POST', `/sessions/${id}/queue`, { text: '  ' }, AUTH)
  assert.equal(empty.status, 400)

  const unauth = await router('POST', `/sessions/${id}/queue`, { text: 'x' }, {})
  assert.equal(unauth.status, 401)

  const missing = await router('POST', '/sessions/nope/queue', { text: 'x' }, AUTH)
  assert.equal(missing.status, 404)

  const idleCreated = await router('POST', '/sessions', {}, AUTH)
  const idleId = (idleCreated.body as { id: string }).id
  const idle = await router('POST', `/sessions/${idleId}/queue`, { text: 'x' }, AUTH)
  assert.equal(idle.status, 409)
})

test('Phase 2: POST /steer accepts { laneId } and upgrades the queued entry', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const queued = await router('POST', `/sessions/${id}/queue`, { text: 'upgrade via route' }, AUTH)
  const { laneId } = queued.body as { laneId: string }

  const upgraded = await router('POST', `/sessions/${id}/steer`, { laneId }, AUTH)
  assert.equal(upgraded.status, 200)
  assert.equal((upgraded.body as { queued: boolean }).queued, true)

  // 已升级（非 queued）→ 409；未知 laneId → 404。
  const again = await router('POST', `/sessions/${id}/steer`, { laneId }, AUTH)
  assert.equal(again.status, 409)
  const ghost = await router('POST', `/sessions/${id}/steer`, { laneId: 'ghost' }, AUTH)
  assert.equal(ghost.status, 404)
  // 既无 text 也无 laneId → 400。
  const neither = await router('POST', `/sessions/${id}/steer`, {}, AUTH)
  assert.equal(neither.status, 400)
})

test('Phase 2: POST /queue/retract retracts a queued entry; 404 unknown; 409 settled', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const queued = await router('POST', `/sessions/${id}/queue`, { text: 'retract via route' }, AUTH)
  const { laneId } = queued.body as { laneId: string }

  const ok = await router('POST', `/sessions/${id}/queue/retract`, { laneId }, AUTH)
  assert.equal(ok.status, 200)
  assert.equal((ok.body as { ok: boolean }).ok, true)

  const again = await router('POST', `/sessions/${id}/queue/retract`, { laneId }, AUTH)
  assert.equal(again.status, 409)

  const ghost = await router('POST', `/sessions/${id}/queue/retract`, { laneId: 'ghost' }, AUTH)
  assert.equal(ghost.status, 404)

  const missingSession = await router('POST', '/sessions/nope/queue/retract', { laneId }, AUTH)
  assert.equal(missingSession.status, 404)

  const noField = await router('POST', `/sessions/${id}/queue/retract`, {}, AUTH)
  assert.equal(noField.status, 400)
})

test('@Computer mention in prompt mounts computer_use before the run', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', {}, AUTH) // idle
  const id = (created.body as { id: string }).id

  const res = await router('POST', `/sessions/${id}/prompt`, { prompt: '@Computer 帮我把 Safari 里的表单填了' }, AUTH)
  assert.equal(res.status, 200)
  assert.deepEqual(agents[0]!.enabledTools, ['computer_use'])
  assert.match(agents[0]!.runPrompts[0]!, /@Computer/, 'mention text stays in the prompt')
})

test('prompt without @Computer does not mount computer_use', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', {}, AUTH)
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/prompt`, { prompt: 'check my computer setup docs' }, AUTH)
  assert.equal(res.status, 200)
  assert.deepEqual(agents[0]!.enabledTools, [])
})

test('intervention answer route forwards remember to the manager (computer_use grant)', async (t) => {
  const { mkdtempSync: mkTmp, rmSync } = await import('node:fs')
  const home = mkTmp(join(tmpdir(), 'rivet-cu-route-'))
  const prevHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  t.after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })
  const { isAppGranted } = await import('../../tools/computer-use/app-grants.js')

  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const pending = agents[0]!.callbacks!.onApprovalRequired('cu-1', 'computer_use', { action: 'snapshot', app: 'Safari' })

  const answer = await router(
    'POST', `/sessions/${id}/interventions/cu-1/answer`, { decision: 'approve', remember: true }, AUTH,
  )
  assert.equal(answer.status, 200)
  assert.deepEqual(await pending, { approved: true, remember: true })
  assert.equal(isAppGranted('Safari'), true)
})

test('intervention answer route resolves a pending approval', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const pending = agents[0]!.callbacks!.onApprovalRequired('tool-9', 'bash', {})

  const answer = await router(
    'POST', `/sessions/${id}/interventions/tool-9/answer`, { decision: 'approve' }, AUTH,
  )
  assert.equal(answer.status, 200)
  assert.deepEqual(await pending, { approved: true })
})

test('artifacts list + read with taxonomy', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  agents[0]!.artifacts = [{
    id: 'edit_file:1', tool: 'edit_file', target: 'a.ts', sessionId: id, createdAt: 1,
    summary: 's', sections: [], rawPath: '/tmp/x', charCount: 3, lineCount: 1, sha256: 'h',
  }]

  const list = await router('GET', `/sessions/${id}/artifacts`, {}, AUTH)
  const artifacts = (list.body as { artifacts: Array<{ id: string; kind: string }> }).artifacts
  assert.equal(artifacts[0]!.kind, 'diff')

  const read = await router('GET', `/sessions/${id}/artifacts/edit_file:1`, {}, AUTH)
  assert.equal((read.body as { raw: string }).raw, 'raw:edit_file:1')
})

// ── R3: rollback routes ──────────────────────────────────────────────

test('R3: rollback preview 404 for missing session', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions/nope/rollback/preview', {}, AUTH)
  assert.equal(res.status, 404)
})

test('R3: rollback preview returns available:false when no checkpoint exists', async () => {
  const { manager, router } = setup()
  // Fresh session in a throwaway cwd → no checkpoint on disk.
  const s = manager.createSession({ cwd: '/tmp/rollback-none-' + Math.random().toString(36).slice(2) })
  const res = await router('GET', `/sessions/${s.id}/rollback/preview`, {}, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { available: boolean }).available, false)
})

test('R3: rollback execute requires a confirmationToken (400)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({ cwd: '/tmp/rollback-none-' + Math.random().toString(36).slice(2) })
  const res = await router('POST', `/sessions/${s.id}/rollback`, {}, AUTH)
  assert.equal(res.status, 400)
})

test('R3: rollback execute 404 for missing session', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions/nope/rollback', { confirmationToken: 'x' }, AUTH)
  assert.equal(res.status, 404)
})

test('R3: rollback routes are Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({ cwd: '/tmp/work' })
  const preview = await router('GET', `/sessions/${s.id}/rollback/preview`, {}, {})
  assert.equal(preview.status, 401)
  const exec = await router('POST', `/sessions/${s.id}/rollback`, { confirmationToken: 'x' }, {})
  assert.equal(exec.status, 401)
})

// ── S: per-session autonomy routes ──────────────────────────────────

test('S: POST /sessions accepts a valid approvalMode and reflects it on the record', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions', { approvalMode: 'dangerously-skip-permissions' }, AUTH)
  assert.equal(res.status, 201)
  assert.equal((res.body as { approvalMode?: string }).approvalMode, 'dangerously-skip-permissions')
})

test('S: POST /sessions rejects an invalid approvalMode (400)', async () => {
  const { router } = setup()
  const res = await router('POST', '/sessions', { approvalMode: 'yolo' }, AUTH)
  assert.equal(res.status, 400)
})

test('S: POST /sessions accepts welcome-composer reasoningEffort/planMode/askMode', async () => {
  const { manager, router } = setup()
  const res = await router('POST', '/sessions', {
    reasoningEffort: 'max',
    planMode: 'planning',
    askMode: 'off',
  }, AUTH)
  assert.equal(res.status, 201)
  const rec = manager.getSession((res.body as { id: string }).id)!
  assert.equal(rec.reasoningEffort, 'max')
  assert.equal(rec.planMode, 'planning')
  assert.equal(rec.askMode, 'off')
})

test('S: POST /sessions validates welcome-composer effort/plan/ask (400)', async () => {
  const { router } = setup()
  const badEffort = await router('POST', '/sessions', { reasoningEffort: 'ultra' }, AUTH)
  assert.equal(badEffort.status, 400)
  const badPlan = await router('POST', '/sessions', { planMode: 'maybe' }, AUTH)
  assert.equal(badPlan.status, 400)
  const badAsk = await router('POST', '/sessions', { askMode: 'sure' }, AUTH)
  assert.equal(badAsk.status, 400)
  const conflict = await router('POST', '/sessions', { planMode: 'planning', askMode: 'asking' }, AUTH)
  assert.equal(conflict.status, 400)
})

test('S: POST /sessions/:id/approval-mode switches the level', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/approval-mode`, { approvalMode: 'manual' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { approvalMode: string }).approvalMode, 'manual')
  assert.equal(manager.getSession(s.id)!.approvalMode, 'manual')
})

test('S: approval-mode route validates the body (400) and 404s a missing session', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const bad = await router('POST', `/sessions/${s.id}/approval-mode`, { approvalMode: 'nope' }, AUTH)
  assert.equal(bad.status, 400)
  const missing = await router('POST', '/sessions/nope/approval-mode', { approvalMode: 'manual' }, AUTH)
  assert.equal(missing.status, 404)
})

test('S: approval-mode route is Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/approval-mode`, { approvalMode: 'manual' }, {})
  assert.equal(res.status, 401)
})

// ── Reasoning effort routes ─────────────────────────────────────────

test('Effort: POST /effort switches the reasoning effort level', async () => {
  const { manager, agents, router } = setup()
  const s = manager.createSession({})
  // Build the agent eagerly so setReasoningEffort is called live.
  manager.run(s.id, 'go')
  const res = await router('POST', `/sessions/${s.id}/effort`, { effort: 'max' }, AUTH)
  assert.equal(res.status, 200)
  assert.equal((res.body as { effort: string }).effort, 'max')
  assert.equal(manager.getSession(s.id)!.reasoningEffort, 'max')
  assert.deepEqual(agents[0]!.reasoningEffortCalls, ['max'])
})

test('Effort: welcome-created session applies reasoning effort on first agent build', () => {
  const { manager, agents } = setup()
  const s = manager.createSession({ prompt: 'go', reasoningEffort: 'max', planMode: 'planning' })
  assert.equal(s.reasoningEffort, 'max')
  assert.deepEqual(agents[0]!.reasoningEffortCalls, ['max'], '首轮 run 构建 agent 时就要应用欢迎页选的推理档')
  assert.deepEqual(agents[0]!.enterPlanModeCalls, [undefined], 'planning 模式同样在首轮 agent 构建时生效')
})

test('Effort: route validates the body (400) and 404s a missing session', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const bad = await router('POST', `/sessions/${s.id}/effort`, { effort: 'nope' }, AUTH)
  assert.equal(bad.status, 400)
  const missing = await router('POST', '/sessions/nope/effort', { effort: 'low' }, AUTH)
  assert.equal(missing.status, 404)
})

test('Effort: route is Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/effort`, { effort: 'low' }, {})
  assert.equal(res.status, 401)
})

// ── Plan mode routes ────────────────────────────────────────────────

test('Plan: POST /plan-mode toggles state and 404s a missing session', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const on = await router('POST', `/sessions/${s.id}/plan-mode`, { state: 'planning' }, AUTH)
  assert.equal(on.status, 200)
  assert.equal((on.body as { planMode: string }).planMode, 'planning')
  assert.equal(manager.getSession(s.id)!.planMode, 'planning')

  const bad = await router('POST', `/sessions/${s.id}/plan-mode`, { state: 'nope' }, AUTH)
  assert.equal(bad.status, 400)

  const missing = await router('POST', '/sessions/nope/plan-mode', { state: 'off' }, AUTH)
  assert.equal(missing.status, 404)
})

test('Plan: plan-mode route is Bearer-gated (fail-closed)', async () => {
  const { manager, router } = setup()
  const s = manager.createSession({})
  const res = await router('POST', `/sessions/${s.id}/plan-mode`, { state: 'planning' }, {})
  assert.equal(res.status, 401)
})

test('Plan: GET /plans lists plans (newest first) and 404s a missing session', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'alpha.md'), '# Alpha Plan\n\nbody', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('GET', `/sessions/${s.id}/plans`, {}, AUTH)
  assert.equal(res.status, 200)
  const plans = (res.body as { plans: Array<{ slug: string; title: string; status: string }> }).plans
  assert.equal(plans.length, 1)
  assert.equal(plans[0]!.slug, 'alpha')
  assert.equal(plans[0]!.title, 'Alpha Plan')
  assert.equal(plans[0]!.status, 'submitted')

  const missing = await router('GET', '/sessions/nope/plans', {}, AUTH)
  assert.equal(missing.status, 404)
})

// 2026-07-04 缺陷复盘: plan-mode 空草稿（draft-<ts>.md）泄漏进列表，
// 桌面 Plan 面板出现 "Untitled Plan" 待审 chip。草稿走独立 draft 通道。
test('Plan: GET /plans filters drafts from the list and exposes the active draft while planning', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'alpha.md'), '# Alpha Plan\n\nbody', 'utf-8')
  writeFileSync(join(plansDir, 'draft-1751600000000.md'), '# Growing Draft\n\nwip', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  // Not planning — drafts never appear in the list, draft channel is null.
  const off = await router('GET', `/sessions/${s.id}/plans`, {}, AUTH)
  assert.equal(off.status, 200)
  const offBody = off.body as { plans: Array<{ slug: string }>; draft: unknown }
  assert.deepEqual(offBody.plans.map((p) => p.slug), ['alpha'])
  assert.equal(offBody.draft, null)

  // Planning with an active draft file — draft rides along with title+content.
  await manager.setPlanMode(s.id, 'planning')
  agents[0]!.activePlanFilePath = '.rivet/plans/draft-1751600000000.md'
  const planning = await router('GET', `/sessions/${s.id}/plans`, {}, AUTH)
  const body = planning.body as {
    plans: Array<{ slug: string }>
    draft: { path: string; title: string | null; content: string } | null
  }
  assert.deepEqual(body.plans.map((p) => p.slug), ['alpha'], 'drafts still filtered from the list')
  assert.ok(body.draft)
  assert.equal(body.draft!.title, 'Growing Draft')
  assert.match(body.draft!.content, /wip/)

  // Back to off — draft channel closes.
  await manager.setPlanMode(s.id, 'off')
  const closed = await router('GET', `/sessions/${s.id}/plans`, {}, AUTH)
  assert.equal((closed.body as { draft: unknown }).draft, null)
})

// 2026-07-06 缺陷复盘: plan mode 是 AgentLoop 内存态，agent 重建（switchModel /
// 懒构建恢复）后丢失——record.planMode='planning' 但新 agent 未进入 planning，
// 工具门禁失效、getActivePlanFilePath=null → 桌面「起草中」实时草稿断流。
// applySelections 现在按 record 补 enterPlanMode。
test('Plan: agent rebuild re-enters plan mode when record says planning', async () => {
  const { manager, agents } = setup()
  const s = manager.createSession({})

  await manager.setPlanMode(s.id, 'planning')
  const agent = agents[0]!
  assert.equal(agent.enterPlanModeCalls.length, 1, 'setPlanMode enters plan mode once')

  // switchModel rebuilds the loop and re-runs applySelections — planning must survive.
  assert.equal(await manager.switchModel(s.id, 'other-model'), true)
  assert.equal(agent.enterPlanModeCalls.length, 2, 'rebuild re-enters plan mode from record')

  // Off sessions must NOT be pushed into planning on rebuild.
  await manager.setPlanMode(s.id, 'off')
  const callsAfterOff = agent.enterPlanModeCalls.length
  assert.equal(await manager.switchModel(s.id, 'other-model'), true)
  assert.equal(agent.enterPlanModeCalls.length, callsAfterOff, 'off record does not re-enter')
})

test('Plan: GET /plans/:slug returns content; 404 for unknown plan', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'beta.md'), '# Beta\n\ncontent here', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const ok = await router('GET', `/sessions/${s.id}/plans/beta`, {}, AUTH)
  assert.equal(ok.status, 200)
  assert.match((ok.body as { plan: { content: string } }).plan.content, /content here/)

  const gone = await router('GET', `/sessions/${s.id}/plans/ghost`, {}, AUTH)
  assert.equal(gone.status, 404)
})

test('Plan: POST /plans/:slug/approve marks approved and starts a run', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'gamma.md'), '# Gamma\n\ndo it', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/gamma/approve`, {}, AUTH)
  assert.equal(res.status, 200)
  const after = readFileSync(join(plansDir, 'gamma.md'), 'utf-8')
  assert.match(after, /Status: APPROVED/)
  assert.equal(manager.getSession(s.id)!.planMode, 'off')

  // Pointer injected via setActivePlan (slug/title only — never the body),
  // and the kickoff run is a short one-liner, not the full plan content.
  const agent = agents[0]!
  assert.equal(agent.activePlanCalls.length, 1)
  assert.equal(agent.activePlanCalls[0]!.slug, 'gamma')
  assert.equal(agent.activePlanCalls[0]!.title, 'Gamma')
  assert.equal(agent.runPrompts.length, 1)
  const kickoff = agent.runPrompts[0]!
  assert.match(kickoff, /Gamma/)
  assert.match(kickoff, /\.rivet\/plans\/gamma\.md/)
  assert.ok(!kickoff.includes('do it'), 'kickoff must not embed the plan body')
})

// 2026-07-03 缺陷复盘: approve 曾先改文件再校验 selectedApproach,且改文件时
// 把 options frontmatter 抹掉 — 校验永远跳过、无效方案名被静默接受。
test('Plan: approve with valid option preserves options and threads the canonical label', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  const fm = '---\nrivet-options: [{"label":"Fast (Recommended)","description":"a"},{"label":"Safe","description":"b"}]\n---\n\n'
  writeFileSync(join(plansDir, 'opt.md'), `${fm}# Opt\n\ndo it`, 'utf-8')
  const s = manager.createSession({ cwd: dir })

  // Case-insensitive match resolves to the canonical label.
  const res = await router('POST', `/sessions/${s.id}/plans/opt/approve`, { selectedApproach: 'safe' }, AUTH)
  assert.equal(res.status, 200)
  const after = readFileSync(join(plansDir, 'opt.md'), 'utf-8')
  assert.match(after, /Status: APPROVED/)
  assert.match(after, /rivet-options/, 'options frontmatter must survive approval')
  const agent = agents[0]!
  assert.equal(agent.activePlanCalls[0]!.selectedApproach, 'Safe')
  assert.match(agent.runPrompts[0]!, /Selected approach: Safe/)
})

test('Plan: approve with unknown option fails BEFORE marking the file approved', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  const fm = '---\nrivet-options: [{"label":"Fast","description":"a"},{"label":"Safe","description":"b"}]\n---\n\n'
  writeFileSync(join(plansDir, 'opt2.md'), `${fm}# Opt2\n\ndo it`, 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/opt2/approve`, { selectedApproach: 'YOLO' }, AUTH)
  assert.equal(res.status, 409)
  assert.equal((res.body as { code: string }).code, 'bad-approach')
  const after = readFileSync(join(plansDir, 'opt2.md'), 'utf-8')
  assert.doesNotMatch(after, /Status: APPROVED/, 'file must stay untouched when the option is invalid')
  assert.equal(agents.length === 0 || agents[0]!.runPrompts.length === 0, true, 'no kickoff run on failed approval')
})

// 共享批准闭环对齐（TUI approvePlanAndKickoff 与桌面路由同一内核）：
// 空计划/占位符在批准边界硬拒，绝不标 APPROVED 或启动执行。
test('Plan: approve an empty plan hard-fails with 422 and stays untouched', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  // Title-only sections = a gutted/placeholder draft (same fixture family as
  // the TUI-side validatePlanContentForApproval suite).
  writeFileSync(join(plansDir, 'hollow.md'), '# Hollow\n\n## 设计\n\n## 实施\n', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/hollow/approve`, {}, AUTH)
  assert.equal(res.status, 422)
  assert.equal((res.body as { code: string }).code, 'invalid-content')
  assert.ok((res.body as { error: string }).error.length > 0, 'failure carries a human-readable reason')
  const after = readFileSync(join(plansDir, 'hollow.md'), 'utf-8')
  assert.doesNotMatch(after, /Status: APPROVED/, 'empty plan must never be marked approved')
  assert.equal(agents.length === 0 || agents[0]!.runPrompts.length === 0, true, 'no kickoff run on rejected content')
})

// 桌面批准必须走完整分波闭环——kickoff 指示 read_file → plan_task/team_orchestrate
// 逐波过审查门 → plan_close，否则 wave-gate 防线被绕过（旧版一句「开始执行」）。
test('Plan: approve kickoff drives wave execution through the review gates', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'wave.md'), '# Wave\n\n具体设计：先改 A，再改 B。', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/wave/approve`, {}, AUTH)
  assert.equal(res.status, 200)
  const kickoff = agents[0]!.runPrompts[0]!
  assert.match(kickoff, /read_file/, 'kickoff instructs reading the plan file')
  assert.match(kickoff, /plan_task\(execute=true\)|team_orchestrate/, 'kickoff instructs wave execution')
  assert.match(kickoff, /plan_close/, 'kickoff instructs closing the plan when done')
})

// Wave 3 — plan editing (review → tweak → Build): only submitted plans are
// editable; approved/executed/rejected are records. Edits emit plan_submitted
// so viewers re-fetch.
test('Plan: PUT /plans/:slug edits a submitted plan and emits plan_submitted', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'edit-me.md'), '# Edit Me\n\n原始内容', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('PUT', `/sessions/${s.id}/plans/edit-me`, { content: '# Edit Me v2\n\n修订后的内容' }, AUTH)
  assert.equal(res.status, 200)
  const after = readFileSync(join(plansDir, 'edit-me.md'), 'utf-8')
  assert.match(after, /修订后的内容/)
  const events = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'plan_submitted')
  assert.equal(events.length, 1)
  assert.equal((events[0]!.data as { title: string }).title, 'Edit Me v2')

  const missingContent = await router('PUT', `/sessions/${s.id}/plans/edit-me`, {}, AUTH)
  assert.equal(missingContent.status, 400)
})

test('Plan: PUT /plans/:slug refuses non-submitted plans and preserves options on body-only edits', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  const fm = '---\nrivet-options: [{"label":"Fast","description":"a"}]\n---\n\n'
  writeFileSync(join(plansDir, 'opted.md'), `${fm}# Opted\n\n正文`, 'utf-8')
  writeFileSync(join(plansDir, 'done.md'), '> **Status: APPROVED**\n\n# Done\n\n已批准', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  // Body-only edit (no frontmatter in the payload) keeps the recorded options.
  const ok = await router('PUT', `/sessions/${s.id}/plans/opted`, { content: '# Opted\n\n新正文' }, AUTH)
  assert.equal(ok.status, 200)
  const after = readFileSync(join(plansDir, 'opted.md'), 'utf-8')
  assert.match(after, /rivet-options/, 'options frontmatter survives a body-only edit')
  assert.match(after, /新正文/)

  // Approved plans are historical records — not editable.
  const refused = await router('PUT', `/sessions/${s.id}/plans/done`, { content: '# Done\n\n篡改' }, AUTH)
  assert.equal(refused.status, 409)
  assert.equal((refused.body as { code: string }).code, 'not-editable')
  assert.match(readFileSync(join(plansDir, 'done.md'), 'utf-8'), /已批准/)
})

// Wave 2 — plan_draft: while planning, write_file/edit_file emits a throttled
// event. Persistence/ring store metadata only; SSE listeners get `content` for
// live PlanPanel paint (≤200KB).
test('Plan: draft writes emit throttled plan_draft events while planning', async () => {
  const { manager, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'draft-99.md'), '# 草稿\n\n第一段', 'utf-8')
  const s = manager.createSession({ cwd: dir })
  await manager.setPlanMode(s.id, 'planning')
  const agent = agents[0]!
  agent.activePlanFilePath = '.rivet/plans/draft-99.md'
  manager.run(s.id, 'plan it')

  const live: Array<Record<string, unknown>> = []
  const unsub = manager.subscribe(s.id, (e) => {
    if (e.type === 'plan_draft') live.push(e.data)
  })

  const draftEvents = () =>
    manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'plan_draft')

  // Leading edge: first write fires immediately (emit is async — flush microtasks).
  agent.callbacks!.onToolResult('t1', 'write_file', 'ok', false)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(draftEvents().length, 1)
  const stored = draftEvents()[0]!.data as { path: string; title: string | null; size: number }
  assert.equal(stored.path, '.rivet/plans/draft-99.md')
  assert.equal(stored.title, '草稿')
  assert.ok(stored.size > 0)
  assert.ok(!('content' in stored), 'ring/persist store metadata only')
  assert.equal(live.length, 1)
  assert.ok(typeof live[0]!.content === 'string' && (live[0]!.content as string).includes('第一段'), 'SSE live frame carries body')

  // Burst inside the window: exactly one trailing event, not one per write.
  agent.callbacks!.onToolResult('t2', 'edit_file', 'ok', false)
  agent.callbacks!.onToolResult('t3', 'write_file', 'ok', false)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(draftEvents().length, 1, 'writes inside the throttle window do not emit immediately')
  await new Promise((r) => setTimeout(r, 350))
  assert.equal(draftEvents().length, 2, 'trailing timer lands exactly one event for the burst')
  assert.equal(live.length, 2)

  // Non-write tools and error results never emit.
  agent.callbacks!.onToolResult('t4', 'read_file', 'ok', false)
  agent.callbacks!.onToolResult('t5', 'write_file', 'denied', true)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(draftEvents().length, 2)
  unsub?.()
})

test('Plan: no plan_draft events outside plan mode', async () => {
  const { manager, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  mkdirSync(join(dir, '.rivet', 'plans'), { recursive: true })
  const s = manager.createSession({ cwd: dir })
  manager.run(s.id, 'go')
  agents[0]!.callbacks!.onToolResult('t1', 'write_file', 'ok', false)
  await new Promise((r) => setTimeout(r, 20))
  const drafts = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'plan_draft')
  assert.equal(drafts.length, 0)
})

test('Plan: approve on a running session returns 409 with session-running code', async () => {
  const { manager, router } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'busy.md'), '# Busy\n\ndo it', 'utf-8')
  const s = manager.createSession({ cwd: dir })
  manager.run(s.id, 'work work') // occupies the session (FakeAgent never resolves)

  const res = await router('POST', `/sessions/${s.id}/plans/busy/approve`, {}, AUTH)
  assert.equal(res.status, 409)
  assert.equal((res.body as { code: string }).code, 'session-running')
  const after = readFileSync(join(plansDir, 'busy.md'), 'utf-8')
  assert.doesNotMatch(after, /Status: APPROVED/)
})

test('Plan: POST /plans/:slug/reject keeps the file, re-enters plan mode, and kicks revision', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'delta.md'), '# Delta\n\nnope', 'utf-8')
  const s = manager.createSession({ cwd: dir })

  const res = await router('POST', `/sessions/${s.id}/plans/delta/reject`, { comment: 'too vague' }, AUTH)
  assert.equal(res.status, 200)
  const after = readFileSync(join(plansDir, 'delta.md'), 'utf-8')
  assert.match(after, /Status: REJECTED/)
  assert.equal(manager.getSession(s.id)!.planMode, 'planning')
  assert.equal(agents[0]!.enterPlanModeCalls.length, 1)
  assert.deepEqual(agents[0]!.enterPlanModeCalls[0], { planFilePath: '.rivet/plans/delta.md' })
  assert.equal(agents[0]!.runPrompts.length, 1)
  assert.match(agents[0]!.runPrompts[0]!, /User rejected the plan/)
  assert.match(agents[0]!.runPrompts[0]!, /too vague/)
})

// Wave 3 — mid-run rejection feedback rides the steer buffer instead of being
// dropped (the old code only kicked a revision turn on idle sessions).
test('Plan: reject with comment on a RUNNING session queues the feedback via steer', async () => {
  const { manager, router, agents } = setup()
  const dir = mkdtempSync(join(tmpdir(), 'rivet-plans-'))
  const plansDir = join(dir, '.rivet', 'plans')
  mkdirSync(plansDir, { recursive: true })
  writeFileSync(join(plansDir, 'epsilon.md'), '# Epsilon\n\nnope', 'utf-8')
  const s = manager.createSession({ cwd: dir })
  manager.run(s.id, 'busy work') // FakeAgent never resolves — session stays running

  const res = await router('POST', `/sessions/${s.id}/plans/epsilon/reject`, { comment: '方向错了' }, AUTH)
  assert.equal(res.status, 200)
  assert.match(readFileSync(join(plansDir, 'epsilon.md'), 'utf-8'), /Status: REJECTED/)
  // No new run was started (the original run is still the only one)…
  assert.equal(agents[0]!.runPrompts.length, 1)
  assert.equal(agents[0]!.runPrompts[0], 'busy work')
  // …and the revision feedback is queued as a steer event.
  const steered = manager.getEvents(s.id, 0)!.events.filter((e) => e.type === 'steer_queued')
  assert.equal(steered.length, 1)
  assert.match((steered[0]!.data as { text: string }).text, /方向错了/)
  assert.match((steered[0]!.data as { text: string }).text, /epsilon\.md/)
})

// ── PlusMenu routes (models / domains / skills) ─────────────────────

class ModelFakeAgent extends FakeAgent {
  switchModel(modelId: string): string | null {
    return modelId === 'model-b' ? modelId : null
  }
}

function setupPlus() {
  const agents: ModelFakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new ModelFakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    listModels: () => [
      { id: 'model-a', alias: 'Model A', provider: 'p', contextWindow: 128000 },
      { id: 'model-b', alias: 'Model B', provider: 'p', contextWindow: 256000 },
    ],
    defaultModelId: 'model-a',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router }
}

test('B4: describeModelSwitchFailure 附因优先 reload config——快照无模型但 reload 后有模型无 key → key-missing', () => {
  // 2026-09-07 审查：解析走 resolveModelSpecWithReload（磁盘 reload），附因若用
  // 启动快照 config——Settings 新加 provider 后至 server 重启窗口内，reload 能
  // 解析出模型但无 key（真实成因 key-missing），附因却基于旧快照报 unknown-model。
  const snapshot = { provider: { providers: {} } } as unknown as Config
  const reloaded = {
    provider: {
      providers: {
        p: { apiKeyEnv: 'NEVER_SET', models: [{ id: 'm1', alias: 'M1', contextWindow: 128_000, maxTokens: 8192 }] },
      },
    },
  } as unknown as Config
  const idle = { id: 's', status: 'idle' } as unknown as SessionRecord

  // 有 reloadConfig：附因用 reload 后 config → key-missing（旧实现只传快照 → unknown-model）
  const r = describeModelSwitchFailure(idle, snapshot, 'm1', () => reloaded)
  assert.match(r, /Model not found/)
  assert.match(r, /no usable API key/, 'reload 后模型存在无 key → key-missing（旧实现快照报 no configured provider）')
  // 对照：无 reloadConfig → 快照判定 unknown-model
  const r2 = describeModelSwitchFailure(idle, snapshot, 'm1')
  assert.match(r2, /no configured provider/)
  // reloadConfig 抛错 → 回退快照不炸
  const r3 = describeModelSwitchFailure(idle, snapshot, 'm1', () => { throw new Error('disk read failed') })
  assert.match(r3, /no configured provider/)
})

test('B4 集成：POST /model 409 附因走 reloadConfig 注入链路（快照无模型 + reload 有模型无 key → key-missing）', async () => {
  // 单元级已证 describeModelSwitchFailure 的 reload 优先；本条验证 route 注入链路：
  // buildSessionRoutes 第 5 参 dependencies.reloadConfig → handler → 409 分类用
  // reload 后 config。模拟「Settings 新加 provider 后 server 未重启」：
  // 快照 config 无任何模型（启动时），reload config 有 model-x 但 provider 无 key。
  const manager = new RuntimeSessionManager({
    createAgent: () => new ModelFakeAgent(),
    defaultCwd: '/tmp/work',
    listModels: () => [
      { id: 'model-a', alias: 'Model A', provider: 'p', contextWindow: 128000 },
      { id: 'model-b', alias: 'Model B', provider: 'p', contextWindow: 256000 },
    ],
    defaultModelId: 'model-a',
  })
  const snapshot = { provider: { providers: {} } } as unknown as Config
  const reloaded = {
    provider: {
      providers: {
        p: { apiKeyEnv: 'NEVER_SET', models: [{ id: 'model-x', alias: 'Model X', contextWindow: 128000, maxTokens: 8192 }] },
      },
    },
  } as unknown as Config
  const router = createRouter(buildSessionRoutes(manager, TOKEN, undefined, snapshot, { reloadConfig: () => reloaded }))
  const s = await router('POST', '/sessions', {}, AUTH)
  const id = (s.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/model`, { modelId: 'model-x' }, AUTH)
  assert.equal(res.status, 409)
  const err = (res.body as { error: string }).error
  assert.match(err, /no usable API key/, 'reloadConfig 注入应生效：reload 后有模型无 key → key-missing（无注入时快照报 unknown-model）')
})

test('A1 集成：running 会话 POST /model → 409 状态文案（route→manager→分流全链路）', async () => {
  // 单元矩阵已证 describeModelSwitchFailure 分流；本条验证 route 层真实接线：
  // running 会话（带 prompt 创建 → FakeAgent.run 挂起）切模型 → switchModel 在
  // manager 层早退 false → handler 查 getSession 分流给状态文案、无分类 hint。
  // 旧实现（86f50cd21）此场景返回 'Session missing/running or model not found'
  // ——文案等值断言在旧代码下必红。
  const { router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const res = await router('POST', `/sessions/${id}/model`, { modelId: 'model-x' }, AUTH)
  assert.equal(res.status, 409)
  const err = (res.body as { error: string }).error
  assert.equal(err, 'Session is running — stop it before switching the model')
  assert.ok(!err.includes('no usable API key'), 'running 场景不得附 key-missing hint')
  assert.ok(!err.includes('no configured provider'), 'running 场景不得附 unknown-model hint')
})

test('A1: describeModelSwitchFailure 分流——running/missing 不附模型分类提示', () => {
  // 86f50cd21 接线缺陷（2026-09-07 审查）：manager.switchModel 在 session
  // missing/running 时直接 return false（session-manager 早退，不触碰模型解析），
  // 但 409 无条件 classify 附因——running 会话切模型被附 key-missing/unknown-model
  // 提示，把用户引向查 key 而实际原因是会话在跑。分流：状态问题给状态文案，
  // 仅「会话存在且空闲 + 解析失败」才附分类提示。
  const noKeyCfg = {
    provider: {
      providers: {
        p: { apiKeyEnv: 'NEVER_SET', models: [{ id: 'm1', alias: 'M1', contextWindow: 128_000, maxTokens: 8192 }] },
      },
    },
  } as unknown as Config
  const running = { id: 's', status: 'running' } as unknown as SessionRecord
  const idle = { id: 's', status: 'idle' } as unknown as SessionRecord

  // missing：不附 hint
  assert.equal(describeModelSwitchFailure(undefined, noKeyCfg, 'm1'), 'Session not found')
  // running：不附 hint（旧实现无条件 classify → 误附 key-missing）
  assert.equal(
    describeModelSwitchFailure(running, noKeyCfg, 'm1'),
    'Session is running — stop it before switching the model',
  )
  // idle + 模型存在但 provider 无 key → key-missing hint（引导查 Settings）
  const keyMiss = describeModelSwitchFailure(idle, noKeyCfg, 'm1')
  assert.match(keyMiss, /Model not found/)
  assert.match(keyMiss, /no usable API key/)
  // idle + 任何 provider 都无此模型 → unknown-model hint
  const unknown = describeModelSwitchFailure(idle, noKeyCfg, 'ghost')
  assert.match(unknown, /no configured provider/)
  // idle + config 缺失（如单元测试宿主）：无 hint
  assert.equal(describeModelSwitchFailure(idle, undefined, 'm1'), 'Model not found')
})

test('GET /models lists provider models with current flag', async () => {  const { router } = setupPlus()
  // 显式 model —— 空 body 时起始模型由项目配置默认 provider 决定（a976167f），
  // 在本机真实 ~/.rivet 配置下不可预测，current 标记断言需要确定起点。
  const s = await router('POST', '/sessions', { model: 'model-a' }, AUTH)
  const id = (s.body as { id: string }).id
  const res = await router('GET', `/sessions/${id}/models`, {}, AUTH)
  assert.equal(res.status, 200)
  const models = (res.body as { models: Array<{ id: string; current: boolean }> }).models
  assert.equal(models.length, 2)
  assert.equal(models.find((m) => m.id === 'model-a')!.current, true)
})

test('POST /model switches model on an idle session; 409 on unknown', async () => {
  const { router } = setupPlus()
  const s = await router('POST', '/sessions', {}, AUTH)
  const id = (s.body as { id: string }).id
  const ok = await router('POST', `/sessions/${id}/model`, { modelId: 'model-b' }, AUTH)
  assert.equal(ok.status, 200)
  assert.equal((ok.body as { model: string }).model, 'model-b')

  const bad = await router('POST', `/sessions/${id}/model`, { modelId: 'ghost' }, AUTH)
  assert.equal(bad.status, 409)

  const missing = await router('POST', `/sessions/${id}/model`, {}, AUTH)
  assert.equal(missing.status, 400)
})

test('GET /domains + POST /domain round-trips a selection', async () => {
  const { router } = setupPlus()
  // 显式 domain —— 空 body 时起始星域由 ~/.rivet 全局配置 defaultDomain 决定
  // （同 a976167f 对 model 的处理），在本机真实配置下不可预测，需锚定起点。
  const s = await router('POST', '/sessions', { domain: 'auto' }, AUTH)
  const id = (s.body as { id: string }).id
  const before = await router('GET', `/sessions/${id}/domains`, {}, AUTH)
  const entries = (before.body as { entries: Array<{ key: string; current: boolean }> }).entries
  assert.equal(entries.find((e) => e.key === 'auto')!.current, true)

  const set = await router('POST', `/sessions/${id}/domain`, { key: 'tianshu' }, AUTH)
  assert.equal(set.status, 200)
  const after = await router('GET', `/sessions/${id}/domains`, {}, AUTH)
  const e2 = (after.body as { entries: Array<{ key: string; current: boolean }> }).entries
  assert.equal(e2.find((e) => e.key === 'tianshu')!.current, true)

  const bad = await router('POST', `/sessions/${id}/domain`, { key: 'nope' }, AUTH)
  assert.equal(bad.status, 404)
})

test('GET /skills + POST /skills toggles enablement', async () => {
  const { router } = setupPlus()
  const s = await router('POST', '/sessions', {}, AUTH)
  const id = (s.body as { id: string }).id
  const res = await router('GET', `/sessions/${id}/skills`, {}, AUTH)
  assert.equal(res.status, 200)
  assert.ok(Array.isArray((res.body as { skills: unknown[] }).skills))

  const toggled = await router('POST', `/sessions/${id}/skills`, { name: 'demo', enabled: false }, AUTH)
  assert.equal(toggled.status, 200)
  assert.equal((toggled.body as { enabled: boolean }).enabled, false)

  const bad = await router('POST', `/sessions/${id}/skills`, { name: 'demo' }, AUTH)
  assert.equal(bad.status, 400)
})

test('PlusMenu read routes 404 on a missing session', async () => {
  const { router } = setupPlus()
  for (const path of ['models', 'domains', 'skills']) {
    const res = await router('GET', `/sessions/ghost/${path}`, {}, AUTH)
    assert.equal(res.status, 404)
  }
})

// ── PlusMenu: review gate ─────────────────────────────────────────

function setupReviewGate() {
  const agents: ModelFakeAgent[] = []
  /** 模拟 serve-agent 的 sessionStoresById：agent 构建后存在的 live refs。 */
  const gateRefs = new Map<string, { current: 'auto' | 'off' }>()
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new ModelFakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    resolveReviewGateRef: (id) => gateRefs.get(id),
    defaultReviewGate: 'auto',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, agents, router, gateRefs }
}

test('GET /review-gate returns default auto; POST off/auto round-trips', async () => {
  const { router } = setupReviewGate()
  const s = await router('POST', '/sessions', {}, AUTH)
  const id = (s.body as { id: string }).id

  const before = await router('GET', `/sessions/${id}/review-gate`, {}, AUTH)
  assert.equal(before.status, 200)
  assert.equal((before.body as { mode: string }).mode, 'auto')

  const off = await router('POST', `/sessions/${id}/review-gate`, { mode: 'off' }, AUTH)
  assert.equal(off.status, 200)
  const after = await router('GET', `/sessions/${id}/review-gate`, {}, AUTH)
  assert.equal((after.body as { mode: string }).mode, 'off')

  const on = await router('POST', `/sessions/${id}/review-gate`, { mode: 'auto' }, AUTH)
  assert.equal(on.status, 200)
  const restored = await router('GET', `/sessions/${id}/review-gate`, {}, AUTH)
  assert.equal((restored.body as { mode: string }).mode, 'auto')
})

test('POST /review-gate validates mode; 404 on missing session', async () => {
  const { router } = setupReviewGate()
  const s = await router('POST', '/sessions', {}, AUTH)
  const id = (s.body as { id: string }).id

  const bad = await router('POST', `/sessions/${id}/review-gate`, { mode: 'nope' }, AUTH)
  assert.equal(bad.status, 400)
  const missing = await router('POST', `/sessions/${id}/review-gate`, {}, AUTH)
  assert.equal(missing.status, 400)

  const ghostGet = await router('GET', '/sessions/ghost/review-gate', {}, AUTH)
  assert.equal(ghostGet.status, 404)
  const ghostPost = await router('POST', '/sessions/ghost/review-gate', { mode: 'off' }, AUTH)
  assert.equal(ghostPost.status, 404)
})

test('setReviewGate 现写 live refs；agent 重建后 override 经 applySelections 重放', async () => {
  const { manager, router, gateRefs } = setupReviewGate()
  const s = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (s.body as { id: string }).id

  // agent 已构建（prompt 触发），模拟 stores 里的 live ref
  const refA: { current: 'auto' | 'off' } = { current: 'auto' }
  gateRefs.set(id, refA)

  const off = await router('POST', `/sessions/${id}/review-gate`, { mode: 'off' }, AUTH)
  assert.equal(off.status, 200)
  assert.equal(refA.current, 'off', 'override 必须现写 live refs，deliver_task 立即感知')

  // 模拟 switchModel 重建：stores 换成全新 refs（回退配置默认 auto），
  // applySelections 必须把用户 override 重放进去
  const refB: { current: 'auto' | 'off' } = { current: 'auto' }
  gateRefs.set(id, refB)
  const internal = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(id)
  ;(manager as unknown as { applySelections(s: unknown): void }).applySelections(internal)
  assert.equal(refB.current, 'off', '重建后的新 refs 必须重放 override，否则 Off 静默失效')
})

test('GET /skills/installable lists .claude candidates; POST /skills/install copies without hot-loading', async () => {
  const { router } = setupPlus()
  const cwd = mkdtempSync(join(tmpdir(), 'skill-install-route-'))
  const claudeSkill = join(cwd, '.claude', 'skills', 'install-route-demo')
  mkdirSync(claudeSkill, { recursive: true })
  writeFileSync(join(claudeSkill, 'SKILL.md'), '---\nname: install-route-demo\ndescription: a demo\n---\nBody.')

  const s = await router('POST', '/sessions', { cwd }, AUTH)
  const id = (s.body as { id: string }).id

  // Installable list surfaces the .claude candidate, not yet installed, plus cap context.
  const list = await router('GET', `/sessions/${id}/skills/installable`, {}, AUTH)
  assert.equal(list.status, 200)
  const listBody = list.body as { skills: Array<{ name: string; installed: boolean }>; installedCount: number; recommendedMax: number }
  const cand = listBody.skills.find((c) => c.name === 'install-route-demo')
  assert.ok(cand, 'candidate should appear')
  assert.equal(cand!.installed, false)
  assert.equal(listBody.installedCount, 0)
  assert.equal(listBody.recommendedMax, 5)

  // Install copies into .rivet/skills.
  const installed = await router('POST', `/sessions/${id}/skills/install`, { names: ['install-route-demo'] }, AUTH)
  assert.equal(installed.status, 200)
  assert.deepEqual((installed.body as { copied: string[] }).copied, ['install-route-demo'])
  assert.ok(existsSync(join(cwd, '.rivet', 'skills', 'install-route-demo', 'SKILL.md')))

  // No hot-load: the live registry must NOT contain the just-installed skill.
  assert.equal(skillRegistry.get('install-route-demo'), undefined)

  // Re-listing now flags it installed and bumps the installed count.
  const list2 = await router('GET', `/sessions/${id}/skills/installable`, {}, AUTH)
  const list2Body = list2.body as { skills: Array<{ name: string; installed: boolean }>; installedCount: number }
  const cand2 = list2Body.skills.find((c) => c.name === 'install-route-demo')
  assert.equal(cand2!.installed, true)
  assert.equal(list2Body.installedCount, 1)

  // Bad body → 400; ghost session → 404.
  const bad = await router('POST', `/sessions/${id}/skills/install`, { names: [] }, AUTH)
  assert.equal(bad.status, 400)
  const ghost = await router('GET', '/sessions/ghost/skills/installable', {}, AUTH)
  assert.equal(ghost.status, 404)
})

test('GET /skills surfaces loadErrors for a malformed installed skill', async () => {
  const { router } = setupPlus()
  const cwd = mkdtempSync(join(tmpdir(), 'skill-loaderr-route-'))
  // A directory skill whose SKILL.md has no frontmatter → parse throws → it must
  // NOT vanish silently; it should appear in loadErrors so the UI can show why.
  const broken = join(cwd, '.rivet', 'skills', 'broken-skill')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'SKILL.md'), 'No frontmatter here, just prose.')

  const s = await router('POST', '/sessions', { cwd }, AUTH)
  const id = (s.body as { id: string }).id

  const res = await router('GET', `/sessions/${id}/skills`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { skills: Array<{ name: string }>; loadErrors: string[] }
  assert.ok(Array.isArray(body.loadErrors), 'loadErrors is an array')
  assert.ok(
    body.loadErrors.some((e) => e.includes('broken-skill')),
    `expected a loadError mentioning broken-skill, got: ${JSON.stringify(body.loadErrors)}`,
  )
  // The malformed skill must not appear as a loaded, toggleable skill.
  assert.equal(body.skills.find((sk) => sk.name === 'broken-skill'), undefined)
})

test('classifyArtifact taxonomy mapping', async () => {
  const base = { id: 'x', sessionId: 's', createdAt: 0, summary: '', sections: [], rawPath: '', charCount: 0, lineCount: 0, sha256: '' }
  assert.equal(classifyArtifact({ ...base, tool: 'write_plan', target: 'plan.md' }), 'plan')
  assert.equal(classifyArtifact({ ...base, tool: 'todo', target: 'x' }), 'task-list')
  assert.equal(classifyArtifact({ ...base, tool: 'edit_file', target: 'a.ts' }), 'diff')
  assert.equal(classifyArtifact({ ...base, tool: 'bash', target: 'shot.png' }), 'screenshot')
  assert.equal(classifyArtifact({ ...base, tool: 'run_tests', target: 'x' }), 'test-result')
  assert.equal(classifyArtifact({ ...base, tool: 'bash', target: 'ls' }), 'walkthrough')
})

// ── Archive (DELETE /sessions/:id) ────────────────────────────────

test('DELETE /sessions/:id archives a session — removes from list, getSession still works', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'Close Me' }, AUTH)
  const id = (created.body as { id: string }).id

  // Before archive: visible in list
  const listBefore = await router('GET', '/sessions', {}, AUTH)
  assert.equal((listBefore.body as { sessions: unknown[] }).sessions.length, 1)

  // Archive it
  const del = await router('DELETE', `/sessions/${id}`, {}, AUTH)
  assert.equal(del.status, 200)
  assert.equal((del.body as { archived: boolean }).archived, true)

  // After archive: excluded from list
  const listAfter = await router('GET', '/sessions', {}, AUTH)
  assert.equal((listAfter.body as { sessions: unknown[] }).sessions.length, 0)

  // getSession still returns the record (data survives)
  const one = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal(one.status, 200)
  assert.equal((one.body as { archived?: boolean }).archived, true)
})

test('DELETE /sessions/:id returns 404 for missing or already-archived session', async () => {
  const { router } = setup()

  // Missing session
  const missing = await router('DELETE', '/sessions/ghost', {}, AUTH)
  assert.equal(missing.status, 404)

  // Create + archive + archive-again → second 404
  const created = await router('POST', '/sessions', {}, AUTH)
  const id = (created.body as { id: string }).id
  await router('DELETE', `/sessions/${id}`, {}, AUTH)
  const again = await router('DELETE', `/sessions/${id}`, {}, AUTH)
  assert.equal(again.status, 404)
})

test('DELETE /sessions/:id aborts a running session before archiving', async () => {
  const { router, agents } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  // Session is running (prompt started). Archive should abort + mark archived.
  const del = await router('DELETE', `/sessions/${id}`, {}, AUTH)
  assert.equal(del.status, 200)

  const one = await router('GET', `/sessions/${id}`, {}, AUTH)
  const rec = one.body as { archived?: boolean; status: string }
  assert.equal(rec.archived, true)
  assert.equal(rec.status, 'aborted')
})

test('DELETE /sessions/:id is Bearer-gated', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', {}, AUTH)
  const id = (created.body as { id: string }).id
  const unauth = await router('DELETE', `/sessions/${id}`, {}, {})
  assert.equal(unauth.status, 401)
})

// ── Unarchive (POST /sessions/:id/unarchive) ─────────────────────

test('POST /sessions/:id/unarchive restores an archived session to the list', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'Restore Me' }, AUTH)
  const id = (created.body as { id: string }).id

  // Archive first
  await router('DELETE', `/sessions/${id}`, {}, AUTH)
  const listAfter = await router('GET', '/sessions', {}, AUTH)
  assert.equal((listAfter.body as { sessions: unknown[] }).sessions.length, 0)

  // Unarchive
  const restore = await router('POST', `/sessions/${id}/unarchive`, {}, AUTH)
  assert.equal(restore.status, 200)
  assert.equal((restore.body as { archived: boolean }).archived, false)

  // Back in list
  const listFinal = await router('GET', '/sessions', {}, AUTH)
  assert.equal((listFinal.body as { sessions: unknown[] }).sessions.length, 1)

  // Record status reset to idle
  const one = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal((one.body as { status: string }).status, 'idle')
  assert.equal((one.body as { archived?: boolean }).archived, false)
})

test('POST /sessions/:id/unarchive 404 for missing or non-archived session', async () => {
  const { router } = setup()

  const missing = await router('POST', '/sessions/ghost/unarchive', {}, AUTH)
  assert.equal(missing.status, 404)

  // Not archived yet
  const created = await router('POST', '/sessions', {}, AUTH)
  const id = (created.body as { id: string }).id
  const notArchived = await router('POST', `/sessions/${id}/unarchive`, {}, AUTH)
  assert.equal(notArchived.status, 404)
})

// ── Rename + permanent delete ─────────────────────────────────────

test('PATCH /sessions/:id renames a session title', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'Old' }, AUTH)
  const id = (created.body as { id: string }).id

  const renamed = await router('PATCH', `/sessions/${id}`, { title: 'New' }, AUTH)
  assert.equal(renamed.status, 200)

  const one = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal((one.body as { title: string }).title, 'New')
})

test('PATCH /sessions/:id returns 404 for missing session', async () => {
  const { router } = setup()
  const res = await router('PATCH', '/sessions/ghost', { title: 'x' }, AUTH)
  assert.equal(res.status, 404)
})

test('DELETE /sessions/:id/permanent removes an archived session', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'Doomed' }, AUTH)
  const id = (created.body as { id: string }).id

  await router('DELETE', `/sessions/${id}`, {}, AUTH)
  const archived = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal((archived.body as { archived?: boolean }).archived, true)

  const deleted = await router('DELETE', `/sessions/${id}/permanent`, {}, AUTH)
  assert.equal(deleted.status, 200)
  assert.equal((deleted.body as { deleted: boolean }).deleted, true)

  const missing = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal(missing.status, 404)
})

test('DELETE /sessions/:id/permanent refuses active sessions', async () => {
  const { router } = setup()
  const created = await router('POST', '/sessions', { title: 'Active' }, AUTH)
  const id = (created.body as { id: string }).id

  const res = await router('DELETE', `/sessions/${id}/permanent`, {}, AUTH)
  assert.equal(res.status, 409)
})

// ── GET /sessions/search — cross-session transcript content search ──

test('GET /sessions/search scans transcripts and caps per-session hits', async () => {
  const prevDir = process.env.RIVET_SESSION_DIR
  const dir = mkdtempSync(join(tmpdir(), 'rivet-search-'))
  process.env.RIVET_SESSION_DIR = dir
  try {
    const { router } = setup()
    const a = await router('POST', '/sessions', { title: 'Alpha' }, AUTH)
    const b = await router('POST', '/sessions', { title: 'Beta' }, AUTH)
    const idA = (a.body as { id: string }).id
    const idB = (b.body as { id: string }).id

    // Session A: 5 matching lines → per-session cap of 3 applies. Mixed
    // plain-JSON (legacy) rows; audit + tool rows must be skipped.
    const linesA = [
      JSON.stringify({ type: 'model_switch', t: 1, to: 'x' }),
      JSON.stringify({ role: 'user', content: 'please refactor the flux capacitor wiring' }),
      JSON.stringify({ role: 'assistant', content: 'the flux capacitor is now rewired' }),
      JSON.stringify({ role: 'tool', tool_call_id: 't1', content: 'flux capacitor grep output' }),
      JSON.stringify({ role: 'user', content: 'flux capacitor round two' }),
      JSON.stringify({ role: 'assistant', content: 'flux capacitor round two done' }),
      JSON.stringify({ role: 'user', content: 'flux capacitor round three' }),
      'not-json-at-all',
    ]
    writeFileSync(join(dir, `${idA}.jsonl`), linesA.join('\n') + '\n')
    // Session B: one hit; session with a missing transcript must not break.
    writeFileSync(join(dir, `${idB}.jsonl`), JSON.stringify({ role: 'assistant', content: 'unrelated text about FLUX Capacitor casing' }) + '\n')

    const res = await router('GET', '/sessions/search?q=flux%20capacitor', {}, AUTH)
    assert.equal(res.status, 200)
    const { results } = res.body as { results: Array<{ sessionId: string; title: string; role: string; snippet: string }> }
    const hitsA = results.filter((r) => r.sessionId === idA)
    const hitsB = results.filter((r) => r.sessionId === idB)
    assert.equal(hitsA.length, 3) // capped at 3 despite 5 matching rows
    assert.equal(hitsB.length, 1) // case-insensitive match
    assert.equal(hitsA[0]!.title, 'Alpha')
    assert.equal(hitsA[0]!.role, 'user')
    assert.ok(hitsA[0]!.snippet.includes('flux capacitor'))
    // tool rows and audit rows never surface
    assert.ok(results.every((r) => r.role === 'user' || r.role === 'assistant'))
  } finally {
    if (prevDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevDir
  }
})

test('GET /sessions/search validates query length and auth', async () => {
  const { router } = setup()
  const short = await router('GET', '/sessions/search?q=a', {}, AUTH)
  assert.equal(short.status, 400)
  const missing = await router('GET', '/sessions/search', {}, AUTH)
  assert.equal(missing.status, 400)
  const unauthorized = await router('GET', '/sessions/search?q=hello', {}, {})
  assert.equal(unauthorized.status, 401)
})

test('GET /sessions/search returns empty results when transcripts are absent', async () => {
  const prevDir = process.env.RIVET_SESSION_DIR
  const dir = mkdtempSync(join(tmpdir(), 'rivet-search-empty-'))
  process.env.RIVET_SESSION_DIR = dir
  try {
    const { router } = setup()
    await router('POST', '/sessions', { title: 'NoFile' }, AUTH)
    const res = await router('GET', '/sessions/search?q=anything', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual((res.body as { results: unknown[] }).results, [])
  } finally {
    if (prevDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevDir
  }
})

test('GET /sessions/search aborts its scan when the client response closes', async () => {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const agent = new FakeAgent(); agents.push(agent); return agent },
    defaultCwd: '/tmp/work',
  })
  await createRouter(buildSessionRoutes(manager, TOKEN))('POST', '/sessions', { title: 'Searchable' }, AUTH)
  let observedSignal: AbortSignal | undefined
  const routes = buildSessionRoutes(manager, TOKEN, undefined, undefined, {
    searchSessionTranscripts: async (_sessions, _query, options) => {
      observedSignal = options?.signal
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return {
        results: [],
        metadata: { durationMs: 0, scannedFiles: 0 },
      }
    },
  })
  const router = createRouter(routes)
  const response = new EventEmitter() as ServerResponse
  const pending = router('GET', '/sessions/search?q=needle', {}, AUTH, response)
  await Promise.resolve()
  response.emit('close')
  const result = await pending

  assert.equal(observedSignal?.aborted, true)
  assert.equal(result.status, 200)
})
