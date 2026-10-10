import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FleetRegistry, TERMINAL_RECORDS_CAP } from '../fleet-registry.js'
import type { DelegationActivity } from '../../tools/types.js'

function running(workOrderId: string, parentToolId: string, profile?: string, progressLine?: string): DelegationActivity {
  return { workOrderId, parentToolId, profile, status: 'running', progressLine }
}

test('FleetRegistry: worker_gone 推断终态可被真实终态覆盖（误杀窗口修复）', () => {
  // 审查门（ee4134c5a）HIGH：isWorkerRunning 弱代理在「controller 清理→终态
  // 发布」间隙短暂为 false，5s reconcile 可能补发 failed(worker_gone)；
  // 随后真实 passed 到达时，终态重放分支若不覆盖 status，成功 worker 被永久误标。
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_w', 'tool_a', 'patcher'), 1000)
  // reconcile 误杀：补发推断终态
  fleet.apply({ workOrderId: 'wo_w', parentToolId: 'tool_a', status: 'failed', failureReason: 'worker_gone' }, 6000)
  assert.equal(fleet.getWorkerById('wo_w')!.status, 'failed')
  // 真实终态到达：必须覆盖 worker_gone 占位
  fleet.apply({ workOrderId: 'wo_w', parentToolId: 'tool_a', status: 'completed', progressLine: 'real done' }, 7000)
  const w = fleet.getWorkerById('wo_w')!
  assert.equal(w.status, 'completed', '真实终态必须覆盖 worker_gone 推断终态')
  assert.equal(w.panelStatus, 'done')
  assert.equal(w.failureReason, undefined)
  assert.equal(w.activity, 'real done')
  // elapsed 冻结在新终态时刻
  assert.equal(w.elapsedMs, 6000)
})

test('FleetRegistry: 非 worker_gone 终态不被后续事件覆盖（终态冻结语义不变）', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_r', 'tool_a', 'reviewer'), 1000)
  fleet.apply({ workOrderId: 'wo_r', parentToolId: 'tool_a', status: 'failed', failureReason: 'review-findings' }, 2000)
  // 迟到 passed 不覆盖真实失败终态
  fleet.apply({ workOrderId: 'wo_r', parentToolId: 'tool_a', status: 'completed' }, 3000)
  const w = fleet.getWorkerById('wo_r')!
  assert.equal(w.status, 'failed', '真实失败终态保持冻结')
  assert.equal(w.elapsedMs, 1000)
})

test('FleetRegistry: findGoneWorkers 只返回 running 且已不在跑的 worker（CLI reconcile 判定）', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_gone', 'tool_a', 'patcher'), 1000)
  fleet.apply(running('wo_alive', 'tool_b', 'reviewer'), 1000)
  fleet.apply(running('wo_done', 'tool_c', 'verifier'), 1000)
  fleet.apply({ workOrderId: 'wo_done', parentToolId: 'tool_c', status: 'completed' }, 2000)

  const isRunning = (id: string) => id === 'wo_alive'
  const gone = fleet.findGoneWorkers(isRunning, 3000)
  const ids = gone.map(v => v.workerId)
  // wo_gone：running 但 isRunning=false → 补发候选
  // wo_alive：running 且 isRunning=true → 不是
  // wo_done：已终态 → 不是
  assert.deepEqual(ids, ['wo_gone'])
  const g = gone[0]!
  assert.equal(g.terminal, false)
  assert.equal(g.parentToolId, 'tool_a', '补发需要原 parentToolId 归组')
})

test('FleetRegistry: findGoneWorkers 补发后不再重复返回（幂等）', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_g2', 'tool_a', 'patcher'), 1000)
  const isRunning = () => false
  assert.equal(fleet.findGoneWorkers(isRunning, 2000).length, 1)
  // 模拟补发终态后：fleet 已 terminal，再次扫不返回
  fleet.apply({ workOrderId: 'wo_g2', parentToolId: 'tool_a', status: 'failed', failureReason: 'worker_gone' }, 2500)
  assert.equal(fleet.findGoneWorkers(isRunning, 3000).length, 0)
})

test('FleetRegistry: 首见 running 进入 active，elapsed 自 startedAt 计', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_team:T1', 'tool_a', 'reviewer', '⚙ read_file'), 1000)
  const active = fleet.getActiveWorkers(1500)
  assert.equal(active.length, 1)
  const w = active[0]!
  assert.equal(w.workerId, 'wo_team:T1')
  assert.equal(w.shortLabel, 'T1')
  assert.equal(w.parentToolId, 'tool_a')
  assert.equal(w.profile, 'reviewer')
  assert.equal(w.status, 'running')
  assert.equal(w.panelStatus, 'running')
  assert.equal(w.terminal, false)
  assert.equal(w.activity, '⚙ read_file')
  assert.equal(w.elapsedMs, 500)
})

test('FleetRegistry: running→terminal 归约，elapsed 在终态后冻结', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_x', 'tool_a', 'patcher'), 1000)
  fleet.apply({ workOrderId: 'wo_x', parentToolId: 'tool_a', status: 'completed', progressLine: 'done summary' }, 2000)
  // 终态 worker 不在 active 列表
  assert.equal(fleet.getActiveWorkers(9999).length, 0)
  const all = fleet.getWorkers(9999)
  assert.equal(all.length, 1)
  const w = all[0]!
  assert.equal(w.status, 'completed')
  assert.equal(w.panelStatus, 'done')
  assert.equal(w.terminal, true)
  // terminal 事件无 profile → 保留首见 profile
  assert.equal(w.profile, 'patcher')
  assert.equal(w.activity, 'done summary')
  // elapsed 冻结在 terminal updatedAt - startedAt（不随 now 增长）
  assert.equal(w.elapsedMs, 1000)
})

test('FleetRegistry: blocked/escalated 归入 failed panelStatus', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ workOrderId: 'wo_b', parentToolId: 't', profile: 'p', status: 'blocked' }, 0)
  fleet.apply({ workOrderId: 'wo_e', parentToolId: 't', profile: 'p', status: 'escalated' }, 0)
  const views = fleet.getWorkers(0)
  assert.deepEqual(views.map(v => v.panelStatus).sort(), ['failed', 'failed'])
  assert.deepEqual(views.map(v => v.status).sort(), ['blocked', 'escalated'])
})

// ─── 7cf506eb 后续：completed 状态（审查拦截）在 TUI 端的归约 ───

test('FleetRegistry: completed（审查拦截）是终态，panelStatus=done，不卡 active', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_rev', 'tool_a', 'reviewer'), 1000)
  fleet.apply({ workOrderId: 'wo_rev', parentToolId: 'tool_a', status: 'completed', failureReason: 'review-findings', progressLine: '审查门发现问题 (L2)' }, 2000)
  // completed 是终态——不该留在 active（否则永远像"还在跑"）
  assert.equal(fleet.getActiveWorkers(9999).length, 0)
  const w = fleet.getWorkerById('wo_rev', 9999)!
  assert.equal(w.status, 'completed')
  assert.equal(w.terminal, true)
  assert.equal(w.panelStatus, 'done')
  assert.equal(w.elapsedMs, 1000, 'elapsed 应冻结在终态，不随 now 增长')
})

test('FleetRegistry: completed 透传 failureReason=review-findings（TUI warn 着色数据源）', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_r2', 'tool_a', 'reviewer'), 0)
  fleet.apply({ workOrderId: 'wo_r2', parentToolId: 'tool_a', status: 'completed', failureReason: 'review-findings' }, 100)
  const w = fleet.getWorkerById('wo_r2', 200)!
  assert.equal(w.failureReason, 'review-findings')
})

test('FleetRegistry: failed（infra 崩溃）透传 failureReason=review-infra', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_r3', 'tool_a', 'reviewer'), 0)
  fleet.apply({ workOrderId: 'wo_r3', parentToolId: 'tool_a', status: 'failed', failureReason: 'review-infra' }, 100)
  const w = fleet.getWorkerById('wo_r3', 200)!
  assert.equal(w.status, 'failed')
  assert.equal(w.failureReason, 'review-infra')
})

test('FleetRegistry: 分组进度按 parentToolId 计数派生', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo1', 'batchTool'), 0)
  fleet.apply(running('wo2', 'batchTool'), 0)
  fleet.apply(running('wo3', 'batchTool'), 0)
  fleet.apply({ workOrderId: 'wo1', parentToolId: 'batchTool', status: 'completed' }, 1)
  fleet.apply({ workOrderId: 'wo2', parentToolId: 'batchTool', status: 'blocked' }, 1)
  const prog = fleet.getGroupProgress('batchTool')
  assert.deepEqual(prog, { total: 3, done: 1, failed: 1, running: 1 })
})

test('FleetRegistry: 多组隔离 + getParentToolIds 保首见顺序', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('a1', 'toolA'), 0)
  fleet.apply(running('b1', 'toolB'), 1)
  fleet.apply(running('a2', 'toolA'), 2)
  assert.deepEqual(fleet.getParentToolIds(), ['toolA', 'toolB'])
  assert.equal(fleet.getGroupProgress('toolA').total, 2)
  assert.equal(fleet.getGroupProgress('toolB').total, 1)
})

test('FleetRegistry: clearGroup 仅清理目标组', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('a1', 'toolA'), 0)
  fleet.apply(running('b1', 'toolB'), 0)
  fleet.clearGroup('toolA')
  assert.equal(fleet.size, 1)
  assert.equal(fleet.getParentToolIds().length, 1)
  assert.equal(fleet.getParentToolIds()[0], 'toolB')
})

test('FleetRegistry: clearGroup 归档终态记录，仍可通过 getWorkerById 查询', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_x', 'toolA', 'patcher'), 0)
  fleet.apply({ workOrderId: 'wo_x', parentToolId: 'toolA', status: 'completed', progressLine: 'done' }, 100)
  fleet.clearGroup('toolA')
  assert.equal(fleet.size, 0)
  assert.equal(fleet.completedSize(), 1)
  const w = fleet.getWorkerById('wo_x', 200)
  assert.ok(w)
  assert.equal(w!.status, 'completed')
  assert.equal(w!.profile, 'patcher')
})

test('FleetRegistry: getCompletedWorkers / getAllWorkers 支持 filter', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_active', 'toolA'), 0)
  fleet.apply({ workOrderId: 'wo_done', parentToolId: 'toolA', status: 'completed' }, 0)
  assert.equal(fleet.getCompletedWorkers().length, 1)
  assert.equal(fleet.getAllWorkers(0, 'all').length, 2)
  assert.equal(fleet.getAllWorkers(0, 'active').length, 1)
  assert.equal(fleet.getAllWorkers(0, 'completed').length, 1)
})

test('FleetRegistry: hasActive 反映是否有未终态 worker', () => {
  const fleet = new FleetRegistry()
  assert.equal(fleet.hasActive(), false)
  fleet.apply(running('w', 't'), 0)
  assert.equal(fleet.hasActive(), true)
  fleet.apply({ workOrderId: 'w', parentToolId: 't', status: 'failed' }, 1)
  assert.equal(fleet.hasActive(), false)
})

test('FleetRegistry: toolUseCount/tokenCount 计数归约，只增不减', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ ...running('wo_c', 't'), toolUseCount: 1 }, 0)
  fleet.apply({ ...running('wo_c', 't'), toolUseCount: 3, tokenCount: 1200 }, 1)
  // 乱序/迟到事件不回退计数
  fleet.apply({ ...running('wo_c', 't'), toolUseCount: 2, tokenCount: 800 }, 2)
  const w = fleet.getWorkerById('wo_c', 3)!
  assert.equal(w.toolUseCount, 3)
  assert.equal(w.tokenCount, 1200)
})

test('FleetRegistry: 终态 usage/model 保留，tokenCount 从 usage 派生并在归档后可查', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ ...running('wo_u', 'toolA'), toolUseCount: 5, tokenCount: 2000 }, 0)
  fleet.apply({
    workOrderId: 'wo_u',
    parentToolId: 'toolA',
    status: 'completed',
    progressLine: 'done',
    model: 'deepseek-v4',
    usage: { input_tokens: 3000, output_tokens: 500, total_tokens: 3500 },
  }, 100)
  fleet.clearGroup('toolA')
  const w = fleet.getWorkerById('wo_u', 200)!
  assert.equal(w.terminal, true)
  assert.equal(w.model, 'deepseek-v4')
  assert.deepEqual(w.usage, { input_tokens: 3000, output_tokens: 500, total_tokens: 3500 })
  // usage.total_tokens > 运行中心跳 → tokenCount 升级为终态快照
  assert.equal(w.tokenCount, 3500)
  // 终态事件不带 toolUseCount → 保留运行中累计值
  assert.equal(w.toolUseCount, 5)
})

test('FleetRegistry: usage 缺 total_tokens 时 tokenCount 回退 input+output', () => {
  const fleet = new FleetRegistry()
  fleet.apply({
    workOrderId: 'wo_v',
    parentToolId: 't',
    status: 'completed',
    usage: { input_tokens: 100, output_tokens: 50 },
  }, 0)
  assert.equal(fleet.getWorkerById('wo_v', 1)!.tokenCount, 150)
})

test('FleetRegistry: getWorkers 按 startedAt 升序', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('late', 't'), 100)
  fleet.apply(running('early', 't'), 10)
  const ids = fleet.getWorkers(200).map(w => w.workerId)
  assert.deepEqual(ids, ['early', 'late'])
})

test('FleetRegistry: authorityReason 透传到 view', () => {
  const fleet = new FleetRegistry()
  fleet.apply({
    workOrderId: 'wo_ar',
    parentToolId: 't',
    profile: 'patcher',
    authority: 'tianfu',
    authorityReason: '命中: 重构+优化',
    status: 'running',
  }, 0)
  const view = fleet.getWorkerById('wo_ar', 1)!
  assert.equal(view.authority, 'tianfu')
  assert.equal(view.authorityReason, '命中: 重构+优化')
})

// ── 稳定 order id 跨轮复用 ───────────────────────────────────────────
//
// batch / team / council 走 deriveStableWorkOrderId，order id 是 `batch:0`
// 这类可预测值而非 wo_<uuid>，同一会话里多次派发必然撞 id。此前旧记录会被
// 移回 active 再合并，而 contract / summary 是「只在缺失时才写」，于是第一轮
// 的目标与结论永久粘住：/tasks 逐次显示同一个目标，与本轮任务毫无关系。

const CONTRACT_A = { objective: '审查缓存边界', profile: 'reviewer', scope: {}, constraints: [], budget: { maxTurns: 8, timeoutMs: 1000 }, allowedToolsDigest: 'grep +2' }
const CONTRACT_B = { objective: '为 rewind 补回归测试', profile: 'reviewer', scope: {}, constraints: [], budget: { maxTurns: 8, timeoutMs: 1000 }, allowedToolsDigest: 'grep +2' }

test('FleetRegistry: 稳定 id 再派发 → 契约换成本轮的，不粘住第一轮', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'running', contract: CONTRACT_A }, 0)
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'completed', summary: '第一轮结论' }, 100)
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'tool_2', status: 'running', contract: CONTRACT_B }, 200)

  const w = fleet.getWorkerById('batch:0', 300)!
  assert.equal(w.contract?.objective, '为 rewind 补回归测试', '目标必须是本轮派发的')
  assert.equal(w.summary, undefined, '上一轮的结论不得挂到这一轮的 worker 上')
  assert.equal(w.status, 'running')
  assert.equal(w.terminal, false)
  assert.equal(w.parentToolId, 'tool_2', '归属应换到发起本轮的那次工具调用')
})

test('FleetRegistry: 稳定 id 再派发 → 计数与耗时从本轮重新起算', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ workOrderId: 'team:T1', parentToolId: 'tool_1', status: 'running', toolUseCount: 7, tokenCount: 5000 }, 0)
  fleet.apply({ workOrderId: 'team:T1', parentToolId: 'tool_1', status: 'completed' }, 100)
  fleet.apply({ workOrderId: 'team:T1', parentToolId: 'tool_2', status: 'running' }, 1000)

  const w = fleet.getWorkerById('team:T1', 1500)!
  assert.equal(w.toolUseCount, 0, '计数只增不减是同轮内的防御，跨轮必须归零')
  assert.equal(w.tokenCount, 0)
  assert.equal(w.elapsedMs, 500, 'elapsed 应自本轮 startedAt 计')
})

test('FleetRegistry: 归档后再派发同一 id → 走新记录，不复活归档记录', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'toolA', status: 'running', contract: CONTRACT_A }, 0)
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'toolA', status: 'completed', summary: '旧结论' }, 100)
  fleet.clearGroup('toolA')
  assert.equal(fleet.completedSize(), 1)

  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'toolB', status: 'running', contract: CONTRACT_B }, 200)
  const w = fleet.getWorkerById('batch:0', 300)!
  assert.equal(w.contract?.objective, '为 rewind 补回归测试')
  assert.equal(w.summary, undefined)
  assert.equal(fleet.getActiveWorkers(300).length, 1, '新一轮应在 active 列表里')
})

test('FleetRegistry: 同轮内的终态重放不被误判成新一轮', () => {
  const fleet = new FleetRegistry()
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'toolA', status: 'running', contract: CONTRACT_A }, 0)
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'toolA', status: 'completed', summary: '结论' }, 100)
  // settle 即时事件 + 批末兜底循环双发是设计使然
  fleet.apply({ workOrderId: 'batch:0', parentToolId: 'toolA', status: 'completed', summary: '结论' }, 150)

  const w = fleet.getWorkerById('batch:0', 200)!
  assert.equal(w.summary, '结论')
  assert.equal(w.contract?.objective, '审查缓存边界', '重放不得清掉本轮契约')
  assert.equal(w.terminal, true)
})

// ─── version 计数（调用方按 version 缓存 fleet 面板，未变跳过重建） ───

test('FleetRegistry: version — apply 新增与更新各递增一次', () => {
  const fleet = new FleetRegistry()
  assert.equal(fleet.version, 0)
  fleet.apply(running('wo_v1', 't'), 0)
  assert.equal(fleet.version, 1, '新增记录')
  fleet.apply(running('wo_v1', 't', undefined, '⚙ grep'), 1)
  assert.equal(fleet.version, 2, '更新既有记录')
  fleet.apply({ workOrderId: 'wo_v1', parentToolId: 't', status: 'completed' }, 2)
  assert.equal(fleet.version, 3, 'running→terminal 更新')
})

test('FleetRegistry: version — 终态重放无变化不递增，补缺 model/usage 才递增', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_v2', 't'), 0)
  fleet.apply({ workOrderId: 'wo_v2', parentToolId: 't', status: 'completed' }, 1)
  const v = fleet.version
  // 完全相同（无 model/usage 可补）的终态重放 → 版本不变
  fleet.apply({ workOrderId: 'wo_v2', parentToolId: 't', status: 'completed' }, 2)
  assert.equal(fleet.version, v)
  // 重放补上此前缺失的 model → 真实状态变更
  fleet.apply({ workOrderId: 'wo_v2', parentToolId: 't', status: 'completed', model: 'm1' }, 3)
  assert.equal(fleet.version, v + 1)
  // model 已存在，重放无可补 → 不变
  fleet.apply({ workOrderId: 'wo_v2', parentToolId: 't', status: 'completed', model: 'm1' }, 4)
  assert.equal(fleet.version, v + 1)
  // 重放补上 usage → 递增
  fleet.apply({ workOrderId: 'wo_v2', parentToolId: 't', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } }, 5)
  assert.equal(fleet.version, v + 2)
})

test('FleetRegistry: version — clearGroup / markSeen / clear 的递增时机', () => {
  const fleet = new FleetRegistry()
  fleet.apply(running('wo_v3', 'toolA'), 0)
  fleet.apply({ workOrderId: 'wo_v3', parentToolId: 'toolA', status: 'completed' }, 1)
  const v0 = fleet.version

  fleet.markSeen('wo_v3')
  assert.equal(fleet.version, v0 + 1, 'unread true→false 是真实变更')
  fleet.markSeen('wo_v3')
  assert.equal(fleet.version, v0 + 1, '已读再 markSeen 无变更')
  fleet.markSeen('wo_missing')
  assert.equal(fleet.version, v0 + 1, '未知 id 无变更')

  fleet.clearGroup('other-tool')
  assert.equal(fleet.version, v0 + 1, '空组 clearGroup 无归档无淘汰，不计版本')
  const res = fleet.clearGroup('toolA')
  assert.equal(res.settled.length, 1)
  assert.deepEqual(res.evictedIds, [])
  assert.equal(fleet.version, v0 + 2, '归档是真实变更')

  fleet.clear()
  assert.equal(fleet.version, v0 + 3, '非空 clear 计版本')
  fleet.clear()
  assert.equal(fleet.version, v0 + 3, '空仓 clear 不计版本')
})

test('FleetRegistry: clearGroup — 归档区封顶 TERMINAL_RECORDS_CAP，按插入序淘汰最旧并回报 evictedIds', () => {
  const fleet = new FleetRegistry()
  const total = TERMINAL_RECORDS_CAP + 2
  for (let i = 0; i < total; i++) {
    fleet.apply({ workOrderId: `wo_cap_${i}`, parentToolId: `tool_${i}`, status: 'completed' }, i)
    const r = fleet.clearGroup(`tool_${i}`, i + total)
    // settled 内容不受封顶影响：本组刚归档的 worker 完整返回
    assert.equal(r.settled.length, 1)
    assert.equal(r.settled[0]!.workerId, `wo_cap_${i}`)
    assert.equal(r.settled[0]!.status, 'completed')
    if (i < TERMINAL_RECORDS_CAP) {
      assert.deepEqual(r.evictedIds, [], '未超上限不淘汰')
    } else {
      assert.deepEqual(r.evictedIds, [`wo_cap_${i - TERMINAL_RECORDS_CAP}`], '超上限时淘汰最旧归档')
    }
    assert.ok(fleet.completedSize() <= TERMINAL_RECORDS_CAP, '归档区永不超过上限')
  }
  assert.equal(fleet.completedSize(), TERMINAL_RECORDS_CAP)
  assert.equal(fleet.getWorkerById('wo_cap_0'), undefined, '最旧归档已被淘汰')
  assert.equal(fleet.getWorkerById('wo_cap_1'), undefined)
  assert.ok(fleet.getWorkerById(`wo_cap_${total - 1}`), '最新归档保留')
  assert.equal(fleet.getCompletedWorkers().length, TERMINAL_RECORDS_CAP)
})


test('FleetRegistry: concurrent dispatch identities preserve independent controls and terminal states', () => {
  const fleet = new FleetRegistry()
  const a = { ...running('batch:0', 'tool_A', 'code_scout'), dispatchId: 'tool_A:batch:0', attemptId: 'A' }
  const b = { ...running('batch:0', 'tool_B', 'code_scout'), dispatchId: 'tool_B:batch:0', attemptId: 'B' }
  fleet.apply(a); fleet.apply(b)
  assert.deepEqual(fleet.getActiveWorkers().map(w => w.workerId), [a.dispatchId, b.dispatchId])
  assert.equal(fleet.getWorkerById(a.dispatchId)?.workOrderId, 'batch:0')
  assert.equal(fleet.getWorkerById(a.dispatchId)?.shortLabel, '0')
  fleet.apply({ ...a, status: 'completed' })
  assert.equal(fleet.getWorkerById(b.dispatchId)?.terminal, false)
  fleet.apply(a)
  assert.equal(fleet.getWorkerById(a.dispatchId)?.terminal, true, 'late activity cannot revive completed dispatch')
  assert.deepEqual(fleet.findGoneWorkers(id => id === b.dispatchId).map(w => w.workerId), [])
  fleet.clearGroup('tool_A')
  assert.equal(fleet.getWorkerById(a.dispatchId)?.terminal, true)
  assert.equal(fleet.getWorkerById(b.dispatchId)?.terminal, false)
})
