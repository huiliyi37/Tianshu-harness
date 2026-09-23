/**
 * 付费版 v1 · T2 — 审查策略（reviewPolicy）与无人值守 fail-closed 中止
 *
 * 覆盖：
 * - resolveRunUnattended 判定矩阵（always/first-runs/auto-proceed/缺省）
 * - normalizeReviewPolicy 清洗
 * - createScheduledTask 保留 reviewPolicy
 * - /schedule 路由：reviewPolicy 校验 + unattendedAutomation Pro gate
 * - SessionManager：unattended 会话审批请求立即拒绝 + unattended_halt 事件 + 中止
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import {
  CronScheduler,
  createScheduledTask,
  normalizeApprovalMode,
  normalizeReviewPolicy,
  resolveRunUnattended,
  FIRST_RUNS_TRUST_THRESHOLD,
} from '../cron-scheduler.js'
import { buildScheduleRoutes } from '../schedule-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// ─── resolveRunUnattended ────────────────────────────────────

test('resolveRunUnattended: 缺省与 always-review 永不无人值守', () => {
  assert.equal(resolveRunUnattended({ triggerCount: 99 }), false)
  assert.equal(resolveRunUnattended({ reviewPolicy: 'always-review', triggerCount: 99 }), false)
})

test('resolveRunUnattended: auto-proceed 恒无人值守', () => {
  assert.equal(resolveRunUnattended({ reviewPolicy: 'auto-proceed', triggerCount: 0 }), true)
})

test('resolveRunUnattended: first-runs 前 N 次人工，之后自动放行', () => {
  for (let n = 0; n < FIRST_RUNS_TRUST_THRESHOLD; n++) {
    assert.equal(resolveRunUnattended({ reviewPolicy: 'first-runs', triggerCount: n }), false, `run #${n + 1}`)
  }
  assert.equal(resolveRunUnattended({ reviewPolicy: 'first-runs', triggerCount: FIRST_RUNS_TRUST_THRESHOLD }), true)
})

// ─── normalize + createScheduledTask ─────────────────────────

test('normalizeReviewPolicy 只接受合法值', () => {
  assert.equal(normalizeReviewPolicy('auto-proceed'), 'auto-proceed')
  assert.equal(normalizeReviewPolicy('always-review'), 'always-review')
  assert.equal(normalizeReviewPolicy('first-runs'), 'first-runs')
  assert.equal(normalizeReviewPolicy('yolo'), undefined)
  assert.equal(normalizeReviewPolicy(undefined), undefined)
  assert.equal(normalizeReviewPolicy(42), undefined)
})

test('createScheduledTask 保留 reviewPolicy，缺省不写字段', () => {
  const withPolicy = createScheduledTask('p', { type: 'interval', spec: '60000' }, [], { reviewPolicy: 'auto-proceed' })
  assert.equal(withPolicy.reviewPolicy, 'auto-proceed')
  const bare = createScheduledTask('p', { type: 'interval', spec: '60000' })
  assert.equal('reviewPolicy' in bare, false)
})

// ─── issue #259：任务可声明的审批档位 ──────────────────────────

test('normalizeApprovalMode 只接受安全子集（manual / dangerously-skip-permissions 被拒）', () => {
  assert.equal(normalizeApprovalMode('auto-safe'), 'auto-safe')
  assert.equal(normalizeApprovalMode('auto-accept'), 'auto-accept')
  assert.equal(normalizeApprovalMode('manual'), undefined, 'manual 与现状等价，声明它只会误导')
  assert.equal(normalizeApprovalMode('dangerously-skip-permissions'), undefined, '不得开「无人值守全自动」的后门')
  assert.equal(normalizeApprovalMode('nonsense'), undefined)
  assert.equal(normalizeApprovalMode(undefined), undefined)
  assert.equal(normalizeApprovalMode(null), undefined)
})

test('createScheduledTask 保留 approval，缺省不写字段（默认零差异）', () => {
  const withApproval = createScheduledTask('p', { type: 'interval', spec: '60000' }, [], { approval: 'auto-safe' })
  assert.equal(withApproval.approval, 'auto-safe')
  const bare = createScheduledTask('p', { type: 'interval', spec: '60000' })
  assert.equal('approval' in bare, false, '缺省不得注入——否则语义从 fail-closed 漂移')
})

// ─── /schedule 路由：校验 + Pro gate ──────────────────────────

function makeRouter(proEnabled: boolean, dir: string) {
  const scheduler = new CronScheduler({ schedulePath: join(dir, 'sched.json') })
  const router = createRouter(buildScheduleRoutes(scheduler, TOKEN, {
    isUnattendedAutomationEnabled: () => proEnabled,
  }))
  return { scheduler, router }
}

test('POST /schedule 拒绝非法 reviewPolicy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rp-'))
  try {
    const { router } = makeRouter(true, dir)
    const res = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' }, reviewPolicy: 'yolo',
    }, AUTH)
    assert.equal(res.status, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// issue #259：审批档位走与 reviewPolicy 同形的校验 / Pro gate
test('POST /schedule 接受安全子集 approval 并回显', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rp-'))
  try {
    const { router } = makeRouter(true, dir)
    const res = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' }, approval: 'auto-safe',
    }, AUTH)
    assert.equal(res.status, 201)
    assert.equal((res.body as { approval?: string }).approval, 'auto-safe')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /schedule 拒绝危险档位（manual / dangerously-skip-permissions）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rp-'))
  try {
    const { router } = makeRouter(true, dir)
    for (const bad of ['manual', 'dangerously-skip-permissions', 'nonsense']) {
      const res = await router('POST', '/schedule', {
        prompt: 'x', trigger: { type: 'interval', spec: '1000' }, approval: bad,
      }, AUTH)
      assert.equal(res.status, 400, `${bad} 应被拒`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Pro gate：无 Pro 时仅声明 approval 也 403（与 reviewPolicy 同口径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rp-'))
  try {
    const { router } = makeRouter(false, dir)
    const res = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' }, approval: 'auto-safe',
    }, AUTH)
    assert.equal(res.status, 403)
    assert.equal((res.body as { feature: string }).feature, 'unattendedAutomation')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Pro gate：无 Pro 时非 always-review 或含 computer_use 均 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rp-'))
  try {
    const { router, scheduler } = makeRouter(false, dir)
    const autoProceed = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' }, reviewPolicy: 'auto-proceed',
    }, AUTH)
    assert.equal(autoProceed.status, 403)
    assert.equal((autoProceed.body as { feature: string }).feature, 'unattendedAutomation')

    const withComputerUse = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' }, allowedTools: ['computer_use'],
    }, AUTH)
    assert.equal(withComputerUse.status, 403)

    // always-review（或缺省）不含 computer_use → 免费版照常可用。
    const plain = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' }, reviewPolicy: 'always-review',
    }, AUTH)
    assert.equal(plain.status, 201)
    assert.equal(scheduler.list().length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Pro gate：有 Pro 时 auto-proceed + computer_use 放行且策略入库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rp-'))
  try {
    const { router, scheduler } = makeRouter(true, dir)
    const res = await router('POST', '/schedule', {
      prompt: 'x', trigger: { type: 'interval', spec: '1000' },
      allowedTools: ['computer_use'], reviewPolicy: 'auto-proceed',
    }, AUTH)
    assert.equal(res.status, 201)
    const id = (res.body as { id: string }).id
    assert.equal(scheduler.get(id)!.reviewPolicy, 'auto-proceed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─── SessionManager：unattended fail-closed ──────────────────

class ApprovalAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  aborted = false
  run(_p: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    return new Promise<void>((res) => { this.finish = res })
  }
  finish: () => void = () => {}
  abort(): void { this.aborted = true; this.callbacks?.onAbort(); this.finish() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_m: OaiMessage[]): void {}
  rewindToMessages(_m: OaiMessage[]): void {}
}

const settle = async () => {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 10))
}

test('unattended 会话：审批请求立即拒绝并 fail-closed 中止', async () => {
  const agents: ApprovalAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new ApprovalAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const s = manager.createSession({ prompt: 'go', unattended: true })
  const agent = agents[0]!

  const result = await agent.callbacks!.onApprovalRequired('tool-1', 'computer_use', { action: 'click', app: 'Safari' })
  assert.equal(typeof result === 'boolean' ? result : result.approved, false)

  await settle()
  assert.equal(agent.aborted, true, 'session should be aborted after denial')

  const events = manager.getEvents(s.id, 0)!.events
  const halt = events.find((e) => e.type === 'unattended_halt')
  assert.ok(halt, 'unattended_halt event should be recorded')
  assert.equal(halt!.data.toolName, 'computer_use')
  assert.match(String(halt!.data.reason), /computer_use/)
  const resolved = events.find((e) => e.type === 'approval_resolved')
  assert.equal(resolved!.data.decision, 'unattended_blocked')
})

test('有人值守会话：审批请求照常挂起（回归）', async () => {
  const agents: ApprovalAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new ApprovalAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
  })
  const s = manager.createSession({ prompt: 'go' })
  const agent = agents[0]!

  let resolvedValue: { approved: boolean } | boolean | undefined
  let resolvedCount = 0
  void agent.callbacks!.onApprovalRequired('tool-2', 'computer_use', { action: 'click' })
    .then((r) => { resolvedValue = r; resolvedCount += 1 })
  await settle()
  // 不能对 resolvedValue 直接断言「=== undefined」：@types/node 的 strict
  // assert.equal/ok 带 `asserts` 收窄签名，会把这个只在闭包里赋值的变量永久
  // 钉成 undefined（闭包赋值对 TS 流分析不可见，后续 typeof 分支推成 never）。
  // 用计数器断言 pending，绕开对该变量的一切收窄。
  assert.equal(resolvedCount, 0, 'approval should stay pending')

  assert.equal(manager.answerIntervention(s.id, 'tool-2', 'approve'), true)
  await settle()
  assert.equal(resolvedCount, 1, 'approval should resolve after answerIntervention')
  assert.equal(typeof resolvedValue === 'boolean' ? resolvedValue : resolvedValue?.approved, true)
  agent.finish()
})
