import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { ApprovalResult } from '../../agent/approval-edit.js'

// F1 — 审批 answer 路由 fail-open 修复（2026-10 审批链路安全审计）。
// 旧行为 `const decision = data.decision ?? 'approve'` 让空 body / 缺 decision 的
// POST 静默批准高风险待批。合法 decision 只有 'approve' / 'deny'（vscode
// ApprovalAnswer 契约；serve.ts 发 'deny'）。本文件锁死 fail-closed 语义：
// 缺失 / 非法 decision → 400，且目标审批保持 pending（未被批准）。

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  run(_prompt: string, cb: AgentCallbacks) {
    this.callbacks = cb
    return new Promise<void>(() => { /* stays running until answered */ })
  }
  abort() {}
  listArtifacts() { return [] }
  readArtifact() { return Promise.resolve(null) }
  getMessages() { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
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

async function startPending(router: ReturnType<typeof setup>['router'], agents: FakeAgent[]) {
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const pending = agents[0]!.callbacks!.onApprovalRequired('req-1', 'bash', { command: 'rm -rf /tmp/x' })
  return { id, pending }
}

async function stillPending(
  router: ReturnType<typeof setup>['router'],
  manager: RuntimeSessionManager,
  id: string,
): Promise<boolean> {
  const snap = await router('GET', `/sessions/${id}/interventions`, {}, AUTH)
  const approvals = (snap.body as { approvals: Array<{ requestId: string }> }).approvals
  void manager
  return approvals.some((a) => a.requestId === 'req-1')
}

test('POST empty body to answer does NOT silently approve (fail-closed 400)', async () => {
  const { manager, agents, router } = setup()
  const { id, pending } = await startPending(router, agents)

  const res = await router('POST', `/sessions/${id}/interventions/req-1/answer`, {}, AUTH)
  assert.equal(res.status, 400, 'missing decision must be rejected with 400')
  assert.match(((res.body as { error?: string }).error ?? ''), /decision/i)

  assert.equal(await stillPending(router, manager, id), true, 'target approval must remain pending')
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, false, 'pending approval must NOT have resolved/approved')
})

test('POST with only editedInput (no decision) does NOT silently approve', async () => {
  const { manager, agents, router } = setup()
  const { id, pending } = await startPending(router, agents)

  const res = await router(
    'POST', `/sessions/${id}/interventions/req-1/answer`,
    { editedInput: { command: 'echo hi' } }, AUTH,
  )
  assert.equal(res.status, 400, 'editedInput alone must not imply an approve decision')

  assert.equal(await stillPending(router, manager, id), true, 'target approval must remain pending')
  let settled: ApprovalResult | boolean | undefined
  void pending.then((v) => { settled = v })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, undefined, 'pending approval must NOT have resolved/approved')
})

test('POST with an illegal decision value does NOT silently approve (fail-closed 400)', async () => {
  const { manager, agents, router } = setup()
  const { id, pending } = await startPending(router, agents)

  const res = await router(
    'POST', `/sessions/${id}/interventions/req-1/answer`,
    { decision: 'maybe' }, AUTH,
  )
  assert.equal(res.status, 400, 'unknown decision values must be rejected with 400')

  assert.equal(await stillPending(router, manager, id), true, 'target approval must remain pending')
  let settled: ApprovalResult | boolean | undefined
  void pending.then((v) => { settled = v })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, undefined, 'pending approval must NOT have resolved/approved')
})

test('POST with decision "deny" resolves the pending approval as denied', async () => {
  const { agents, router } = setup()
  const { id, pending } = await startPending(router, agents)

  const res = await router(
    'POST', `/sessions/${id}/interventions/req-1/answer`,
    { decision: 'deny' }, AUTH,
  )
  assert.equal(res.status, 200)
  assert.deepEqual(await pending, { approved: false })
})

test('POST with decision "approve" still resolves the pending approval as approved', async () => {
  const { agents, router } = setup()
  const { id, pending } = await startPending(router, agents)

  const res = await router(
    'POST', `/sessions/${id}/interventions/req-1/answer`,
    { decision: 'approve' }, AUTH,
  )
  assert.equal(res.status, 200)
  assert.deepEqual(await pending, { approved: true })
})
