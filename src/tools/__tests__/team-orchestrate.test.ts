import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTeamOrchestrateTool,
  collectBlockedAttribution,
  collectAllDirtyRows,
  formatTeamSummary,
  teamReviewChangedFiles,
  teamReviewForceLevel,
  teamReviewFocusHint,
} from '../team-orchestrate.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import type { ChangeSet } from '../../agent/review-discipline.js'
import type { TeamTask } from '../../agent/team-plan.js'
import type { TeamRunSummary } from '../../agent/team-orchestrator.js'
import { parseTeamTasks } from '../../agent/team-plan.js'
import { teamTasksToDelegationRequests } from '../../agent/team-orchestrator.js'
import { decodeTeamPanelModel } from '../../tui/team-panel-model.js'
import { storePlan, consumePlan, getStoredPlan } from '../../agent/plan-store.js'

function stubRun(packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results: [], packet }
}

function mkTask(over: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'T1',
    title: 'task',
    objective: 'objective',
    files: [],
    profile: 'patcher',
    kind: 'patch_proposal',
    verification: [],
    dependsOn: [],
    riskTier: 'low',
    touchSet: [],
    ...over,
  }
}

type RunResult = CoordinatorRun['results'][number]

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    workOrderId: 'w',
    status: 'passed',
    summary: 's',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...over,
  }
}

const singleFileChange: ChangeSet = { files: ['src/agent/x.ts'], crossModule: false, isFix: false }

test('team_orchestrate dispatches a standard plan first wave', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('dispatched') },
  })
  const md = [
    '### Task 1: edit foo',
    'Modify `src/agent/foo.ts`',
    '### Task 2: edit bar',
    'Modify `src/agent/bar.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: execute the plan deliberately', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-1',
  })
  assert.equal(result.isError, false)
  assert.equal(captured.length, 2)
  assert.match(result.content, /派发 2/)
  const panel = decodeTeamPanelModel(result.uiContent ?? '')
  assert.ok(panel)
  assert.equal(panel.dispatched, 2)
  assert.equal(panel.tasks.length, 2)
  // D4：出站槽——orchestration 与 summary/panel 同源一致
  assert.equal(result.orchestration?.kind, 'team')
  assert.equal(result.orchestration?.dispatched, panel.dispatched)
  assert.equal(result.orchestration?.wave, 0)
  assert.equal(result.orchestration?.totalWaves, panel.totalWaves)
})

test('0 任务硬拦：设计文档形态 markdown 不再静默——isError + 改走 plan_task 指引（2026-10-09 踩坑）', async () => {
  let dispatched = 0
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => { dispatched++; return stubRun() },
  })
  const designDoc = [
    '## 分波实施',
    '',
    '### Wave 1',
    '',
    '- [ ] 实现 A',
    '- [ ] 实现 B',
    '',
    '### Wave 2',
    '',
    '- [ ] 实现 C',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: 执行设计文档', planMarkdown: designDoc },
    cwd: process.cwd(),
    toolUseId: 'tu-zero',
  })
  assert.equal(result.isError, true, '解析 0 任务必须报错（改动前是 isError:false 的静默空派发）')
  assert.equal(dispatched, 0, '0 任务不得派发任何 worker')
  assert.match(String(result.content), /Task N/, '报错应说明任务行文法')
  assert.match(String(result.content), /plan_task/, '报错应给出改走 plan_task 的指引')
  assert.match(String(result.content), /\.rivet\/plans\//, '应带完整路径示例')
})

test('0 任务 + confirm:false：proposal 仍走友好展示（不报错，守住既有行为）', async () => {
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => stubRun(),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: x', planMarkdown: '## 设计\n\n- [ ] a', confirm: false },
    cwd: process.cwd(),
    toolUseId: 'tu-zero-proposal',
  })
  assert.notEqual(result.isError, true, 'proposal 阶段不拦（展示语义，守卫在其之后）')
  assert.match(String(result.content), /解析未产生任务/)
})

test('team_orchestrate 透传条件依赖边（收编 #6：markdown → DependencyEdge）', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('dispatched') },
  })
  const md = [
    '### T1: 重构核心模块',
    'Refactor `src/agent/loop.ts`',
    '### T2: 备选调研',
    '调研 `src/agent/loop.ts` 的替代路径',
    '### T3: 测试覆盖',
    '测试 `src/agent/loop.ts`',
    '依赖 T1(onFailure:alternate:T2)',
    '### T4: 文档同步',
    '更新 `docs/architecture.md`',
    '依赖 T1(onFailure:skip)',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: execute the plan with conditional edges', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-edge',
  })
  assert.equal(result.isError, false)
  // 默认语义（W3C）：无 fromWave 且 autoAdvance 缺省 → 自动推进到末波。
  // stubRun 返回空 results → priorResults 为空 → 依赖边不被跨波剥离——
  // 末波（wave1）的 T3/T4 必须带 DependencyEdge 到达派发层。
  assert.ok(captured.some(r => r.parentTurnId?.includes('team:T3')), `默认自动推进应执行到末波含 T3，got ${captured.map(r => r.parentTurnId).join(',')}`)
  assert.ok(captured.some(r => r.parentTurnId?.includes('team:T4')), `默认自动推进应执行到末波含 T4，got ${captured.map(r => r.parentTurnId).join(',')}`)

  // fromWave 推进第二波：delegateBatch 实收数组必须携带 DependencyEdge 对象。
  captured = []
  const second = await tool.execute({
    input: { mode: 'standard', objective: 'force: continue wave execution', planMarkdown: md, fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-edge-w2',
  })
  assert.equal(second.isError, false)
  const w2t3 = captured.find(r => r.parentTurnId?.includes('team:T3'))
  const w2t4 = captured.find(r => r.parentTurnId?.includes('team:T4'))
  assert.ok(w2t3, '第二波应含 T3')
  assert.ok(w2t4, '第二波应含 T4')
  assert.deepEqual(w2t3!.dependencies, [{ dependsOn: 'team:T1', onFailure: 'alternate', alternateOrderId: 'team:T2' }])
  assert.deepEqual(w2t4!.dependencies, [{ dependsOn: 'team:T1', onFailure: 'skip' }])

  // 映射层直测：条件边 → DependencyEdge（team: 前缀）
  const tasks = parseTeamTasks(md)
  const reqs = teamTasksToDelegationRequests(tasks, 'tu-edge')
  const t3 = reqs.find(r => r.parentTurnId?.includes('team:T3'))
  const t4 = reqs.find(r => r.parentTurnId?.includes('team:T4'))
  assert.ok(t3, 'T3 映射存在')
  assert.ok(t4, 'T4 映射存在')
  assert.deepEqual(t3!.dependencies, [{ dependsOn: 'team:T1', onFailure: 'alternate', alternateOrderId: 'team:T2' }])
  assert.deepEqual(t4!.dependencies, [{ dependsOn: 'team:T1', onFailure: 'skip' }])
})

test('team_orchestrate forwards telemetry sink, reward closure sink, and session id', async () => {
  const telemetry: unknown[] = []
  const rewardClosures: unknown[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => stubRun('telemetry-dispatched'),
    recordTeamWaveTelemetry: event => { telemetry.push(event) },
    recordTeamWaveRewardClosure: event => { rewardClosures.push(event) },
    getSessionId: () => 'session-tool',
  })
  const md = [
    '### T1: edit foo',
    'Modify `src/agent/foo.ts`',
  ].join('\n')

  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: execute with telemetry', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-telemetry',
  })

  assert.equal(result.isError, false)
  assert.equal(telemetry.length, 1)
  assert.equal(rewardClosures.length, 1)
  assert.equal((telemetry[0] as any).sessionId, 'session-tool')
  assert.equal((rewardClosures[0] as any).sessionId, 'session-tool')
  assert.equal((telemetry[0] as any).mode, 'standard')
  assert.equal((telemetry[0] as any).fromWave, 0)
})

test('team_orchestrate streams worker progress through onOutput', async () => {
  const progress: string[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (_requests, _policy, _abortSignal, onProgress) => {
      onProgress?.(1, 2)
      onProgress?.(2, 2)
      return stubRun('progress')
    },
  })
  const md = [
    '### T1: edit foo',
    'Modify `src/agent/foo.ts`',
    '### T2: edit bar',
    'Modify `src/agent/bar.ts`',
  ].join('\n')

  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: execute with progress', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-progress',
    onOutput: chunk => { progress.push(chunk) },
  })

  assert.equal(result.isError, false)
  // onOutput 现会先流式推一帧 rivet:team-panel:v1 舰队面板（TUI 解码渲染），
  // 再推进度行；进度契约只校验进度帧本身。
  const progressLines = progress.filter(c => c.includes('team progress'))
  assert.deepEqual(progressLines, [
    '✦ team progress: 1/2 workers done\n',
    '✦ team progress: 2/2 workers done\n',
  ])
  assert.ok(
    progress.some(c => c.includes('rivet:team-panel:v1')),
    '应先流式推送一帧舰队面板',
  )
})

test('team_orchestrate blocks a planPath outside the project', async () => {
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => stubRun(),
  })
  // force: 前缀绕过 task-size gate——否则 objective 过短会被 gate 先行拦截并
  // 返回 isError（断言命中的是 gate 输出而非 planPath 越界检查，测试假绿）
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: execute this plan', planPath: '/etc/passwd' },
    cwd: process.cwd(),
    toolUseId: 'tu-2',
  })
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project|已拦截|blocked/i)
})

test('team_orchestrate passes fromWave through and reports the next wave value', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('wave2') },
  })
  const md = [
    '### T1: edit first',
    'Modify `src/agent/foo.ts`',
    '### T2: edit second',
    'Modify `src/agent/foo.ts`',
    '### T3: edit third',
    'Modify `src/agent/foo.ts`',
  ].join('\n')

  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: continue wave execution', planMarkdown: md, fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-3',
  })

  assert.equal(result.isError, false)
  assert.ok(captured.some(r => r.parentTurnId.includes('T2')))
  assert.ok(!captured.some(r => r.parentTurnId.includes('T1')))
  assert.match(result.content, /fromWave: 2/)
})

test('team_orchestrate runs the review gate on a cross-module final wave', async () => {
  let squadronInvoked = false
  const rewardClosures: unknown[] = []
  const tool = createTeamOrchestrateTool({
    delegate: async () => ({
      status: 'completed',
      packet: 'verified',
      results: [{
        workOrderId: 'verifier',
        status: 'passed',
        summary: 'verified',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      }],
    }),
    recordTeamWaveRewardClosure: event => { rewardClosures.push(event) },
    delegateBatch: async (requests) => {
      if (requests.every(r => r.kind === 'review')) {
        squadronInvoked = true
        return { status: 'completed', results: [], packet: 'reviewed' }
      }
      return {
        status: 'completed',
        packet: 'executed',
        results: [{
          workOrderId: 'w',
          status: 'passed',
          summary: 's',
          findings: [],
          artifacts: [],
          changedFiles: ['src/agent/a.ts', 'src/tui/b.ts', 'src/tools/c.ts', 'src/api/d.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        }],
      }
    },
  })
  const md = '### T1: change\n修改 `src/agent/a.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: feature work across modules', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-rev',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate/)
  assert.equal(squadronInvoked, true)
  assert.equal(rewardClosures.length, 1)
  assert.equal((rewardClosures[0] as any).outcome.reviewVerdict, 'verified')
})

// ── Perspective-density review gate helpers (unit) ──────────────────────────

test('teamReviewForceLevel: max mode always forces L3 squadron', () => {
  assert.equal(teamReviewForceLevel('max', singleFileChange, []), 'L3')
  assert.equal(teamReviewForceLevel('max', singleFileChange, [mkTask()]), 'L3')
})

test('teamReviewForceLevel: standard single-module change raises floor to L2 (no silent L1)', () => {
  assert.equal(teamReviewForceLevel('standard', singleFileChange, [mkTask()]), 'L2')
})

test('teamReviewForceLevel: standard upgrades to L3 on structural signals', () => {
  // cross-module
  assert.equal(
    teamReviewForceLevel('standard', { files: ['src/a/x.ts', 'src/b/y.ts'], crossModule: true, isFix: false }, [mkTask()]),
    'L3',
  )
  // >=3 tasks in the wave
  assert.equal(
    teamReviewForceLevel('standard', singleFileChange, [mkTask({ id: 'a' }), mkTask({ id: 'b' }), mkTask({ id: 'c' })]),
    'L3',
  )
  // any high-risk task
  assert.equal(
    teamReviewForceLevel('standard', singleFileChange, [mkTask({ riskTier: 'high' })]),
    'L3',
  )
})

test('teamReviewChangedFiles: derives authoritative files from diff artifact, union with self-report', () => {
  // self-report empty but diff artifact carries the real file → still detected
  const fromDiffOnly = teamReviewChangedFiles({
    status: 'completed',
    packet: 'p',
    results: [mkResult({
      changedFiles: [],
      artifacts: [{ kind: 'diff', title: 'Patch', content: '--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
    })],
  })
  assert.deepEqual(fromDiffOnly, ['src/agent/x.ts'])

  // union of self-report + diff
  const union = teamReviewChangedFiles({
    status: 'completed',
    packet: 'p',
    results: [mkResult({
      changedFiles: ['src/agent/y.ts'],
      artifacts: [{ kind: 'diff', title: 'Patch', content: '+++ b/src/agent/x.ts' }],
    })],
  })
  assert.deepEqual([...union].sort(), ['src/agent/x.ts', 'src/agent/y.ts'])

  assert.deepEqual(teamReviewChangedFiles(undefined), [])
})

test('teamReviewFocusHint: builds a hint from planned verification, undefined when none', () => {
  const hint = teamReviewFocusHint([mkTask({ verification: ['npm test', 'tsc --noEmit'] })])
  assert.ok(hint)
  assert.match(hint!, /Planned acceptance gates/)
  assert.match(hint!, /npm test/)
  assert.equal(teamReviewFocusHint([mkTask()]), undefined)
})

// ── Perspective-density review gate (integration, standard mode) ────────────

test('team_orchestrate review gate fires on honest diff even when worker self-reports no changedFiles', async () => {
  let verifierObjective = ''
  let verifyKind = ''
  const tool = createTeamOrchestrateTool({
    delegate: async (request) => {
      verifierObjective = request.objective
      verifyKind = request.kind
      return {
        status: 'completed',
        packet: 'verified',
        results: [mkResult({ workOrderId: 'verifier', summary: 'ran: npm test → pass', evidenceStatus: 'verified' })],
      }
    },
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        // self-report empty, but the diff artifact carries the real edit
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
  })
  const md = '### T1: tweak helper\n修改 `src/agent/x.ts`，运行 `npm test` 验证'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-honest',
  })

  assert.equal(result.isError, false)
  // L2 floor (single-module, non-structural) — review still runs, not skipped.
  assert.match(result.content, /Review gate \[L2\]/)
  assert.equal(verifyKind, 'verify')
  // Planned verification reaches the reviewer as a focus hint.
  assert.match(verifierObjective, /Planned acceptance gates/)
  assert.match(verifierObjective, /npm test/)
})

// ── formatTeamSummary: council merge ledger + whole-wave failure guard ──────

function mkSummary(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return {
    mode: 'max',
    planned: [],
    tasks: [],
    waves: [
      { id: 'w0', risk: 'low', taskIds: ['T1'], reason: 'first', parallelLimit: 1 },
      { id: 'w1', risk: 'low', taskIds: ['T2'], reason: 'second', parallelLimit: 1 },
    ],
    dispatched: 1,
    blocked: [],
    packet: 'pkt',
    ...over,
  }
}

test('formatTeamSummary renders the council merge ledger when present', () => {
  const out = formatTeamSummary(mkSummary({
    planMerge: {
      conflicts: [{ description: 'Dependency conflict on T1', tianquan: 'a', tianfu: 'b' }],
      risks: [{ taskId: 'T1', severity: 'high', claim: 'race', mitigation: 'lock' }],
      deferred: [{ source: 'tianxuan', title: 'Alt approach', reason: 'simpler' }],
      rejected: [],
      augmented: [{ source: 'tianxuan', title: 'Gap-fill shard: T3', reason: 'orthogonal shard folded in' }],
    },
    advisories: ['分片 T1 与 T2 都改 src/x.ts 但未标 dependsOn —— 补一条依赖让写入顺序明确(否则会被同文件检测自动串行排波)。'],
  }), 0)

  assert.match(out, /计划冲突/)
  assert.match(out, /Dependency conflict on T1/)
  assert.match(out, /风险账本/)
  assert.match(out, /\[high\] T1: race/)
  assert.match(out, /暂缓的备选方案/)
  assert.match(out, /Alt approach — simpler/)
  assert.match(out, /已补入执行图的分片/)
  assert.match(out, /Gap-fill shard: T3/)
  assert.match(out, /分片建议（不阻断）/)
})

test('formatTeamSummary omits the merge ledger on cache-hit waves (planMerge absent)', () => {
  const out = formatTeamSummary(mkSummary({ planCacheHit: true }), 0)
  assert.doesNotMatch(out, /计划冲突/)
  assert.doesNotMatch(out, /风险账本/)
})

test('formatTeamSummary warns instead of advancing when the whole wave failed', () => {
  const run: CoordinatorRun = {
    status: 'completed',
    packet: 'p',
    results: [mkResult({ status: 'failed' }), mkResult({ status: 'blocked' })],
  }
  const out = formatTeamSummary(mkSummary({ run }), 0)

  assert.match(out, /全部 2 个 worker 失败/)
  assert.match(out, /修复前不要派发 fromWave 1/)
  assert.doesNotMatch(out, /再次调用 team_orchestrate 并传 fromWave/)
})

test('formatTeamSummary keeps the normal next-wave hint when a worker passed', () => {
  const run: CoordinatorRun = {
    status: 'completed',
    packet: 'p',
    results: [mkResult({ status: 'failed' }), mkResult({ status: 'passed' })],
  }
  const out = formatTeamSummary(mkSummary({ run }), 0)

  assert.match(out, /再次调用 team_orchestrate 并传 fromWave: 1/)
  assert.doesNotMatch(out, /worker 失败/)
})

test('formatTeamSummary does not warn on the onPlanReady pre-render (run absent)', () => {
  const out = formatTeamSummary(mkSummary(), 0)
  assert.match(out, /再次调用 team_orchestrate 并传 fromWave: 1/)
  assert.doesNotMatch(out, /worker 失败/)
})

// ── Scope-health wiring (advisory) ─────────────────────────────────────────

test('team_orchestrate surfaces scope leak and folds leaked files into review focus', async () => {
  let verifierObjective = ''
  const persisted: Array<{ kind: string; json: string }> = []
  const tool = createTeamOrchestrateTool({
    delegate: async request => {
      verifierObjective = request.objective
      return {
        status: 'completed',
        packet: 'verified',
        results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
      }
    },
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        // worker touched a file OUTSIDE the planned scope (src/agent/x.ts)
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/leak.ts b/src/agent/leak.ts\n--- a/src/agent/leak.ts\n+++ b/src/agent/leak.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    getTeamSchedulerRewardStore: () => ({
      saveBanditState: (kind, json) => { persisted.push({ kind, json }) },
    }),
  })
  const md = '### T1: tweak helper\n修改 `src/agent/x.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-leak',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Scope health \[(medium|high)\]/)
  assert.match(result.content, /src\/agent\/leak\.ts/)
  // leaked file reaches the reviewer focus.
  assert.match(verifierObjective, /Scope leak/)
  assert.match(verifierObjective, /src\/agent\/leak\.ts/)
  // scope-health is persisted to the reward store.
  assert.ok(persisted.some(p => p.kind.startsWith('team_scope_health:')))
})

test('team_orchestrate emits no scope-health noise when changes stay in plan; survives missing store', async () => {
  const tool = createTeamOrchestrateTool({
    delegate: async () => ({
      status: 'completed',
      packet: 'verified',
      results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
    }),
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    // no getTeamSchedulerRewardStore → persist must no-op without throwing
  })
  const md = '### T1: tweak helper\n修改 `src/agent/x.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-clean',
  })

  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /Scope health/)
})

// ── Meridian blast-radius wiring (advisory) ────────────────────────────────

const NON_EMPTY_IMPACT = {
  direct: ['src/consumer.ts'],
  transitive: ['src/api/h.ts'],
  tests: ['src/__tests__/consumer.test.ts'],
  totalImpact: 2,
}

function impactTool(over: {
  impact?: () => typeof NON_EMPTY_IMPACT
  getMeridianIndexer?: () => { impact: () => typeof NON_EMPTY_IMPACT } | null
  getTypecheckRunner?: () => import('../../agent/typecheck-gate.js').TypecheckRunner | undefined
  capture?: (objective: string) => void
} = {}) {
  return createTeamOrchestrateTool({
    delegate: async request => {
      over.capture?.(request.objective)
      return {
        status: 'completed',
        packet: 'verified',
        results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
      }
    },
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        // diff targets the planned file → no scope leak; drives observedChangedFiles
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    ...(over.getMeridianIndexer !== undefined
      ? { getMeridianIndexer: over.getMeridianIndexer }
      : { getMeridianIndexer: () => ({ impact: over.impact ?? (() => NON_EMPTY_IMPACT) }) }),
    ...(over.getTypecheckRunner ? { getTypecheckRunner: over.getTypecheckRunner } : {}),
  })
}

const impactPlan = '### T1: tweak helper\n修改 `src/agent/x.ts`'

test('team_orchestrate injects meridian blast radius into review focus and content', async () => {
  let verifierObjective = ''
  const tool = impactTool({ capture: o => { verifierObjective = o } })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact',
  })

  assert.equal(result.isError, false)
  // Reaches the reviewer focus.
  assert.match(verifierObjective, /Blast radius/)
  assert.match(verifierObjective, /src\/consumer\.ts/)
  assert.match(verifierObjective, /src\/__tests__\/consumer\.test\.ts/)
  // And the returned content.
  assert.match(result.content, /Blast radius \[meridian\]/)
})

test('team_orchestrate emits no blast-radius noise when impact is empty', async () => {
  let verifierObjective = ''
  const tool = impactTool({
    capture: o => { verifierObjective = o },
    impact: () => ({ direct: [], transitive: [], tests: [], totalImpact: 0 }),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact-empty',
  })

  assert.equal(result.isError, false)
  assert.doesNotMatch(verifierObjective, /Blast radius/)
  assert.doesNotMatch(result.content, /Blast radius/)
})

test('team_orchestrate review survives a null/missing meridian indexer', async () => {
  const tool = impactTool({ getMeridianIndexer: () => null })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact-none',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate \[L2\]/)
  assert.doesNotMatch(result.content, /Blast radius/)
})

test('team_orchestrate injects typecheck breakage into review content, ahead of blast radius', async () => {
  const brokenRunner: import('../../agent/typecheck-gate.js').TypecheckRunner = async () => ({
    diagnostics: [{ file: 'src/agent/x.ts', line: 7, col: 1, severity: 'error', message: 'TS2300: duplicate identifier' }],
    formatted: '',
    ranOk: true,
  })
  const tool = impactTool({ getTypecheckRunner: () => brokenRunner })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-tc-broken',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Typecheck broken \[tsc\]/)
  assert.match(result.content, /src\/agent\/x\.ts/)
  // Typecheck note precedes the meridian blast-radius note in the content.
  assert.ok(
    result.content.indexOf('Typecheck broken [tsc]') < result.content.indexOf('Blast radius [meridian]'),
    result.content,
  )
})

test('team_orchestrate emits no typecheck noise when the runner is clean', async () => {
  const cleanRunner: import('../../agent/typecheck-gate.js').TypecheckRunner = async () => ({ diagnostics: [], formatted: '', ranOk: true })
  const tool = impactTool({ getTypecheckRunner: () => cleanRunner })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-tc-clean',
  })
  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /Typecheck broken/)
})

test('team_orchestrate review survives a throwing typecheck runner', async () => {
  const throwingRunner: import('../../agent/typecheck-gate.js').TypecheckRunner = async () => { throw new Error('tsc boom') }
  const tool = impactTool({ getTypecheckRunner: () => throwingRunner })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-tc-throw',
  })
  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /Typecheck broken/)
})

test('team_orchestrate review survives a throwing impact analyzer', async () => {
  const tool = createTeamOrchestrateTool({
    delegate: async () => ({
      status: 'completed',
      packet: 'verified',
      results: [mkResult({ workOrderId: 'verifier', evidenceStatus: 'verified' })],
    }),
    delegateBatch: async () => ({
      status: 'completed',
      packet: 'executed',
      results: [mkResult({
        changedFiles: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/agent/x.ts b/src/agent/x.ts\n--- a/src/agent/x.ts\n+++ b/src/agent/x.ts\n@@\n+x' }],
        evidenceStatus: 'verified',
      })],
    }),
    getMeridianIndexer: () => ({ impact: () => { throw new Error('boom') } }),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: small single-module tweak', planMarkdown: impactPlan, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-impact-throw',
  })

  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate \[L2\]/)
  assert.doesNotMatch(result.content, /Blast radius/)
})

test('team_orchestrate auto-consumes plan from session store when planJson omitted', async () => {
  const sessionId = 'team-auto-consume'
  consumePlan(sessionId) // ensure clean
  const plan = JSON.stringify({
    version: 1,
    objective: 'auto consume test',
    tasks: [{
      id: 'T1',
      title: 'Edit foo',
      objective: 'Modify src/agent/foo.ts',
      profile: 'patcher',
      kind: 'patch_proposal',
      files: ['src/agent/foo.ts'],
      dependsOn: [],
      riskTier: 'low',
    }],
    source: 'plan_task',
    createdAt: Date.now(),
  })
  storePlan(plan, sessionId)

  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('auto-consumed') },
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: auto consume plan' },
    cwd: process.cwd(),
    toolUseId: 'tu-auto-consume',
    sessionId,
  })

  assert.equal(result.isError, false)
  assert.equal(captured.length, 1)
  assert.match(captured[0]!.objective, /Modify src\/agent\/foo\.ts/)
  // team_orchestrate consumes then re-stores the plan for multi-wave continuity.
  assert.ok(getStoredPlan(sessionId) !== null)
})

// ── Atropos 密封校验（Phase 3）：密封契约静默改写 → 消费入口硬拦 ──

function sealablePlan(): import('../../agent/unified-plan.js').UnifiedPlan {
  return {
    version: 1,
    objective: 'sealed contract test',
    tasks: [{
      id: 'T1', title: 'Edit foo', objective: 'Modify src/agent/foo.ts',
      profile: 'patcher', kind: 'patch_proposal',
      files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low',
    }],
    source: 'plan_task',
    createdAt: Date.now(),
  }
}

test('team_orchestrate 密封完好 → 放行并留密封状态行', async () => {
  const { sealPlan } = await import('../../agent/council/council-seal.js')
  const sealed = sealPlan(sealablePlan())
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => stubRun('sealed-ok') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: sealed contract run', planJson: JSON.stringify(sealed) },
    cwd: process.cwd(),
    toolUseId: 'tu-seal-ok',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /契约已密封 v1/)
})

test('team_orchestrate 密封破损（静默改写 files）→ 硬拦且零派发', async () => {
  const { sealPlan } = await import('../../agent/council/council-seal.js')
  const sealed = sealPlan(sealablePlan())
  const tampered = {
    ...sealed,
    tasks: sealed.tasks.map(t => ({ ...t, files: ['src/agent/other.ts'] })),
  }
  let dispatched = false
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => { dispatched = true; return stubRun() } })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: tampered contract run', planJson: JSON.stringify(tampered) },
    cwd: process.cwd(),
    toolUseId: 'tu-seal-broken',
  })
  assert.equal(result.isError, true)
  assert.match(result.content, /密封破损/)
  assert.match(result.content, /revisePlanSeal/)
  assert.equal(dispatched, false, '破封契约必须在派发前拦截')
})

test('team_orchestrate 豁免修订后（revisePlanSeal v2）→ 放行', async () => {
  const { sealPlan, revisePlanSeal } = await import('../../agent/council/council-seal.js')
  const sealed = sealPlan(sealablePlan())
  const modified = { ...sealed, tasks: sealed.tasks.map(t => ({ ...t, files: ['src/agent/moved.ts'] })) }
  const revised = revisePlanSeal(modified, '波间复议调整范围')
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => stubRun('revised-ok') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: revised contract run', planJson: JSON.stringify(revised) },
    cwd: process.cwd(),
    toolUseId: 'tu-seal-revised',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /契约已密封 v2/)
})

test('team_orchestrate 未密封计划不受密封门影响（向后兼容）', async () => {
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => stubRun('unsealed-ok') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: unsealed plan run', planJson: JSON.stringify(sealablePlan()) },
    cwd: process.cwd(),
    toolUseId: 'tu-seal-none',
  })
  assert.equal(result.isError, false)
  assert.doesNotMatch(result.content, /密封/)
})

// ── Pro gate（双层模式）：mode:'max' 仅 Pro 可用 ──

test('team_orchestrate max mode blocked without plan when teamMax Pro gate off', async () => {
  const tool = createTeamOrchestrateTool(
    { delegateBatch: async () => stubRun() },
    { teamMaxEnabled: false },
  )
  const result = await tool.execute({
    input: { mode: 'max', objective: 'force: a sufficiently large mission statement' },
    cwd: process.cwd(),
    toolUseId: 'tu-pro-gate-1',
  })
  assert.equal(result.isError, true)
  assert.match(result.content, /Pro 功能/)
  assert.match(result.content, /plan_task/)
})

test('team_orchestrate max mode downgrades to standard with existing plan when teamMax gate off', async () => {
  const tool = createTeamOrchestrateTool(
    { delegateBatch: async () => stubRun('downgraded') },
    { teamMaxEnabled: false },
  )
  const md = [
    '### Task 1: edit foo',
    'Modify `src/agent/foo.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'max', objective: 'force: execute the provided plan', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-pro-gate-2',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /team standard/)
  assert.match(result.content, /\[Pro\]/)
})

test('【回归】不传 teamMaxEnabled 时缺省关——max 降级 standard（Pro 门 fail-closed）', async () => {
  // 缺省由 true 改为 false：门控参数的缺省必须是「关」。缺省放行意味着任何未来
  // 新增的构造方（集成、嵌入、忘记传参）都白送 Pro 功能；bootstrap 注册路径总是
  // 显式传 pro-license 的真值，因此运行路径不受影响。
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => stubRun() })
  const md = ['### Task 1: edit foo', 'Modify `src/agent/foo.ts`'].join('\n')
  const result = await tool.execute({
    input: { mode: 'max', objective: 'force: run max with plan provided', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-pro-gate-3',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /team standard/, '缺省门下 max 应降级执行现有计划')
  assert.match(result.content, /\[Pro\]/, '降级必须留 Pro 提示')
})

test('confirm:false → 只展示波次分派方案，零派发（收编 #7）', async () => {
  let dispatched = false
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => { dispatched = true; return stubRun('should-not-run') },
  })
  const md = [
    '### Task 1: edit foo',
    'Modify `src/agent/foo.ts`',
    '### Task 2: edit bar',
    'Modify `src/agent/bar.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: preview the plan before dispatch', planMarkdown: md, confirm: false },
    cwd: process.cwd(),
    toolUseId: 'tu-confirm',
  })
  assert.equal(dispatched, false, 'proposal 阶段不得派发任何 worker')
  assert.ok(result.content.includes('team 编排方案'))
  assert.ok(result.content.includes('波次分派'))
  assert.ok(result.content.includes('confirm: true'))
})

test('confirm 缺省（未传）→ 直接派发（向后兼容）', async () => {
  let dispatched = false
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { dispatched = true; return stubRun('dispatched') },
  })
  const md = ['### Task 1: edit foo', 'Modify `src/agent/foo.ts`'].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: execute without confirm', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-default',
  })
  assert.equal(dispatched, true)
  assert.ok(!result.content.includes('调用 team_orchestrate'))
})

// ── W3C 多波自动推进行为矩阵 ─────────────────────────────────────────────

test('W3C: 无 fromWave 且 autoAdvance 缺省 → 一次调用自动推进全部波', async () => {
  const wavesSeen: string[][] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => {
      wavesSeen.push(requests.map(r => r.parentTurnId ?? ''))
      return stubRun('dispatched')
    },
  })
  // 同文件冲突 → 序列化 3 波（每波一个任务）。
  const md = [
    '### T1: 改造',
    'Modify `src/a.ts`',
    '### T2: 收尾',
    'Modify `src/a.ts`',
    '### T3: 复查',
    'Modify `src/a.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: auto-advance multi-wave', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-adv',
  })
  assert.equal(result.isError, false)
  assert.equal(wavesSeen.length, 3, `默认应一次调用推进 3 波，got ${wavesSeen.length}`)
  assert.ok(wavesSeen[2]!.some(p => p.includes('T3')), '末波应含 T3')
  // 聚合输出：所有波 results 进 summary/panel，completedWaves 与总波数一致。
  // OrchestrationOutcome 是联合类型——kind 收窄后访问 team 专属字段。
  if (result.orchestration?.kind === 'team') {
    assert.equal(result.orchestration.completedWaves, 3)
    assert.equal(result.orchestration.wave, 2, 'outcome 的 wave 取最后执行波')
  } else {
    assert.fail('默认推进应产出 team outcome')
  }
})

test('W3C: fromWave:N + autoAdvance:true → 从 N 推进到底', async () => {
  const wavesSeen: string[][] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => {
      wavesSeen.push(requests.map(r => r.parentTurnId ?? ''))
      return stubRun('resumed')
    },
  })
  const md = [
    '### T1: 改造',
    'Modify `src/a.ts`',
    '### T2: 收尾',
    'Modify `src/a.ts`',
    '### T3: 复查',
    'Modify `src/a.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: resume-and-advance', planMarkdown: md, fromWave: 1, autoAdvance: true },
    cwd: process.cwd(),
    toolUseId: 'tu-resume-adv',
  })
  assert.equal(result.isError, false)
  assert.equal(wavesSeen.length, 2, `fromWave:1 + autoAdvance:true 应推进 wave1..wave2 共 2 波，got ${wavesSeen.length}`)
  assert.ok(wavesSeen[0]!.some(p => p.includes('T2')), '起始波应为 T2（wave1）')
  assert.ok(wavesSeen[1]!.some(p => p.includes('T3')), '末波应含 T3')
  if (result.orchestration?.kind === 'team') {
    assert.equal(result.orchestration.wave, 2)
  } else {
    assert.fail('推进执行应产出 team outcome')
  }
})

test('W3C: 自动推进在整波门禁失败（零通过）处停止', async () => {
  const calls: string[][] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => {
      calls.push(requests.map(r => r.parentTurnId ?? ''))
      return {
        status: 'completed',
        results: [mkResult({ workOrderId: 'team:T1', status: 'failed' })],
        packet: 'failed-wave',
      }
    },
  })
  const md = [
    '### T1: 改造',
    'Modify `src/a.ts`',
    '### T2: 收尾',
    'Modify `src/a.ts`',
    '### T3: 复查',
    'Modify `src/a.ts`',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: stop on gated failure', planMarkdown: md },
    cwd: process.cwd(),
    toolUseId: 'tu-gate-stop',
  })
  assert.equal(result.isError, false)
  assert.equal(calls.length, 1, 'wave0 零通过 → 停止推进，不得派发后续波')
  if (result.orchestration?.kind === 'team') {
    assert.equal(result.orchestration.stoppedReason, 'all-failed')
  } else {
    assert.fail('停止路径应产出 team outcome')
  }
})

// ── 复盘 D（docs/tasks/2026-08-03-starflow-iteration-plan.md）：blocked 归属 ──

test('D: blocked 且本波次 worker 有 changedFiles → 报告含工作树归属段与下一步建议', () => {
  const summary: TeamRunSummary = {
    mode: 'standard',
    planned: [],
    tasks: [],
    waves: [{ id: 'wave-0', risk: 'low', taskIds: ['T1'], reason: 'r', parallelLimit: 1 }],
    dispatched: 1,
    blocked: ['T1 门禁未过'],
    packet: '<packet/>',
    run: {
      status: 'completed',
      results: [mkResult({ workOrderId: 'T1', status: 'failed', changedFiles: ['src/agent/a.ts'] })],
      packet: '<packet/>',
    },
  }
  const out = formatTeamSummary(summary, 0, { hits: [' M src/agent/a.ts'], precise: true })
  assert.match(out, /工作树本会话已产生改动/)
  assert.match(out, /src\/agent\/a\.ts/, 'git status 命中行原样列出')
  assert.match(out, /下一步/, '附建议下一步')
})

test('D: 降级归属段（precise:false）——全量 dirty + 无法逐文件归属标注', () => {
  const summary: TeamRunSummary = {
    mode: 'standard',
    planned: [],
    tasks: [],
    waves: [{ id: 'wave-0', risk: 'low', taskIds: ['T1'], reason: 'r', parallelLimit: 1 }],
    dispatched: 1,
    blocked: ['T1 门禁未过'],
    packet: '<packet/>',
    run: {
      status: 'completed',
      results: [mkResult({ workOrderId: 'T1', status: 'failed', changedFiles: [] })],
      packet: '<packet/>',
    },
  }
  const out = formatTeamSummary(summary, 0, { hits: [' M src/other.ts', '?? newdir/'], precise: false })
  assert.match(out, /工作树 dirty 改动全量列出/)
  assert.match(out, /无法逐文件归属/)
  assert.match(out, /勿整目录 add/)
  assert.match(out, /src\/other\.ts/)
})

test('D: 无改动 worker → 不出归属段', () => {
  const summary: TeamRunSummary = {
    mode: 'standard',
    planned: [],
    tasks: [],
    waves: [{ id: 'wave-0', risk: 'low', taskIds: ['T1'], reason: 'r', parallelLimit: 1 }],
    dispatched: 1,
    blocked: ['T1 门禁未过'],
    packet: '<packet/>',
    run: {
      status: 'completed',
      results: [mkResult({ workOrderId: 'T1', status: 'failed' })],
      packet: '<packet/>',
    },
  }
  const out = formatTeamSummary(summary, 0, undefined)
  assert.doesNotMatch(out, /工作树本会话已产生改动/)
})

test('D: collectBlockedAttribution——git 仓库命中 changedFiles；非 git 目录降级为空', () => {
  // 非 git 目录：返回 []（降级跳过，不炸）
  const plainDir = mkdtempSync(join(tmpdir(), 'team-attr-nogit-'))
  assert.deepEqual(collectBlockedAttribution(plainDir, ['src/a.ts']), [])

  // git 仓库：dirty 的 changedFiles 命中行原样返回
  const dir = mkdtempSync(join(tmpdir(), 'team-attr-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), '// v1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  writeFileSync(join(dir, 'src', 'a.ts'), '// v2\n')
  const hits = collectBlockedAttribution(dir, ['src/a.ts'])
  assert.ok(hits.length >= 1, `应命中 dirty 文件，got ${JSON.stringify(hits)}`)
  assert.match(hits[0]!, /src\/a\.ts/)
  // 未改动的路径不命中
  assert.deepEqual(collectBlockedAttribution(dir, ['src/never-touched.ts']), [])
})

test('D: rename 与未跟踪目录的 status 行也能命中 changedFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-attr-shape-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'old\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  execFileSync('git', ['mv', 'a.txt', 'b.txt'], { cwd: dir })
  mkdirSync(join(dir, 'newdir'))
  writeFileSync(join(dir, 'newdir', 'f.txt'), 'x\n')
  // `R  a.txt -> b.txt` 与 `?? newdir/` 两种 status 行都应命中对应 changedFiles
  const hits = collectBlockedAttribution(dir, ['b.txt', 'newdir/f.txt'])
  assert.ok(hits.some(h => h.includes('b.txt')), `rename 目标应命中，got ${JSON.stringify(hits)}`)
  assert.ok(hits.some(h => h.includes('newdir')), `未跟踪目录内文件应命中，got ${JSON.stringify(hits)}`)
  // 未跟踪目录展开属目录级归属——必须带防误提交标注（多会话共享工作区误报修正）
  assert.ok(hits.some(h => h.includes('newdir') && h.includes('目录级归属')), `目录级命中应带标注，got ${JSON.stringify(hits)}`)
})

test('D: 目录级命中附「可能含其他会话改动，勿整目录 add」标注', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-attr-dir-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'other.md'), 'x\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  writeFileSync(join(dir, 'docs', 'other.md'), 'y\n')
  // worker 自报目录级条目：多会话共享工作区下，目录内可能混有他会话改动
  const dirHits = collectBlockedAttribution(dir, ['docs'])
  assert.ok(dirHits.some(h => h.includes('docs/other.md')), `目录内文件应命中，got ${JSON.stringify(dirHits)}`)
  assert.ok(dirHits.some(h => h.includes('目录级归属')), `目录级命中必须带防误提交标注，got ${JSON.stringify(dirHits)}`)
})

test('D: quotePath=false——中文/非 ASCII 文件名命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-attr-utf8-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '计划文档.md'), 'x\n') // 未跟踪：?? 计划文档.md
  const hits = collectBlockedAttribution(dir, ['计划文档.md'])
  assert.ok(hits.some(h => h.includes('计划文档.md')), `中文路径应命中（quotePath=false），got ${JSON.stringify(hits)}`)
})

test('D: collectAllDirtyRows——全量 dirty 行返回；非 git 目录降级为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-alldirty-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'x.txt'), 'x\n')
  const rows = collectAllDirtyRows(dir)
  assert.ok(rows.some(r => r.includes('x.txt')), `未跟踪文件应出现在全量行，got ${JSON.stringify(rows)}`)
  const plainDir = mkdtempSync(join(tmpdir(), 'team-alldirty-nogit-'))
  assert.deepEqual(collectAllDirtyRows(plainDir), [])
})

test('D: 数据源合并——diff artifact 的真实文件也能进归属段（blocked worker 自报为空）', () => {
  const run: CoordinatorRun = {
    status: 'completed',
    results: [mkResult({
      workOrderId: 'T1', status: 'blocked', changedFiles: [],
      artifacts: [{ kind: 'diff', title: 'Patch: src/a.ts', content: 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n' }],
    })],
    packet: '<packet/>',
  }
  const summary: TeamRunSummary = {
    mode: 'standard', planned: [], tasks: [],
    waves: [{ id: 'wave-0', risk: 'low', taskIds: ['T1'], reason: 'r', parallelLimit: 1 }],
    dispatched: 1, blocked: ['T1 门禁未过'], packet: '<packet/>', run,
  }
  // 与 execute 相同的合并路径：teamReviewChangedFiles（diff artifact ∪ 自报）
  const merged = teamReviewChangedFiles(summary.run)
  assert.deepEqual(merged, ['src/a.ts'], 'diff artifact 路径应并入自报集合')

  const dir = mkdtempSync(join(tmpdir(), 'team-attr-merge-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), '// v1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir })
  writeFileSync(join(dir, 'src', 'a.ts'), '// v2\n')
  const hits = collectBlockedAttribution(dir, merged)
  assert.ok(hits.length >= 1, `合并路径应命中 dirty 文件，got ${JSON.stringify(hits)}`)
  assert.match(hits[0]!, /src\/a\.ts/)
})


// ── D 审查修复（2026-08-03）：门禁收窄 + 降级归属 execute 全链路 ──

test('D 门禁收窄：blocked 仅含 waiting for wave（健康中段波）不出归属段', async () => {
  // 全 passed 且带 changedFiles 的健康波次——旧门禁（blocked.length>0）会因
  // 「waiting for wave」占位出归属段+「回退」建议（行动误导）；收窄后不出。
  const dir = mkdtempSync(join(tmpdir(), 'team-gate-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'x\n')
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => ({
      status: 'completed',
      results: [
        mkResult({ workOrderId: 'team:T1', status: 'passed', changedFiles: ['src/a.ts'] }),
        mkResult({ workOrderId: 'team:T2', status: 'passed', changedFiles: [] }),
      ],
      packet: 'p',
    }),
  })
  const md = [
    '### T1: 主线改造',
    'Refactor `src/a.ts`',
    '### T2: 备选调研',
    '调研 `src/a.ts` 的替代路径',
    '### T3: 测试覆盖',
    '测试 `src/a.ts`',
    '依赖 T1(onFailure:alternate:T2)',
  ].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: healthy mid-wave', planMarkdown: md },
    cwd: dir,
    toolUseId: 'tu-gate',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /waiting for wave/, '未来波占位仍在阻塞列表（信息不丢）')
  assert.doesNotMatch(result.content, /工作树本会话已产生改动/, 'waiting 占位不触发精确归属段')
  assert.doesNotMatch(result.content, /工作树 dirty 改动全量列出/, 'waiting 占位不触发降级归属段')
  assert.doesNotMatch(result.content, /回退/, '健康中段波不应收到「回退」建议')
})

test('D 降级归属 execute 全链路：真实阻塞 + 空自报（共享模式无 diff）→ 全量 dirty 段', async () => {
  // 审查 MEDIUM 4 的真回归：走 execute → teamReviewChangedFiles（空）→ 降级全量。
  const dir = mkdtempSync(join(tmpdir(), 'team-fallback-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'x.txt'), 'x\n') // 工作树有 dirty 行（来源不明——其他会话或未捕获）
  const tool = createTeamOrchestrateTool({
    delegateBatch: async () => ({
      status: 'completed',
      results: [mkResult({ workOrderId: 'team:T1', status: 'failed', changedFiles: [] })],
      packet: 'p',
    }),
  })
  const md = ['### T1: 主线改造', 'Refactor `src/a.ts`'].join('\n')
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: blocked worker with no file list', planMarkdown: md },
    cwd: dir,
    toolUseId: 'tu-fallback',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /工作树 dirty 改动全量列出/)
  assert.match(result.content, /无法逐文件归属/)
  assert.match(result.content, /勿整目录 add/)
  assert.match(result.content, /x\.txt/, '工作树 dirty 行原样列出')
})

test('team_orchestrate planJson 带 nonGoals/obligations → 派发 request 携带计划约束', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async (requests) => { captured = requests; return stubRun('planjson-constraints') },
  })
  const planJson = JSON.stringify({
    version: 1,
    objective: 'planJson 约束注入',
    tasks: [{
      id: 'T1',
      title: 'Edit foo',
      objective: 'Modify src/agent/foo.ts',
      profile: 'patcher',
      kind: 'patch_proposal',
      files: ['src/agent/foo.ts'],
      dependsOn: [],
      riskTier: 'low',
    }],
    nonGoals: ['不动 team 归层', '不做运行时动态挂载'],
    obligations: [
      { id: 'deferred_decision:0', kind: 'deferred_decision', text: '暂缓项「备选方案B」——交付前需有着落', source: 'tianquan' },
      { id: 'advisory_gate:1', kind: 'advisory_gate', text: 'npx tsc --noEmit', source: 'yaoguang', gate: 'npx tsc --noEmit' },
    ],
    source: 'manual',
    createdAt: Date.now(),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: planJson constraints', planJson },
    cwd: process.cwd(),
    toolUseId: 'tu-planjson-constraints',
  })
  assert.equal(result.isError, false, result.content)
  assert.equal(captured.length, 1)
  const constraints = captured[0]!.constraints ?? []
  assert.ok(constraints.includes('[计划反目标] 不动 team 归层'), JSON.stringify(constraints))
  assert.ok(constraints.includes('[计划反目标] 不做运行时动态挂载'), JSON.stringify(constraints))
  assert.ok(constraints.includes('[计划约束] 暂缓项「备选方案B」——交付前需有着落'), JSON.stringify(constraints))
  assert.ok(!constraints.some(c => c.includes('npx tsc')), 'advisory_gate 不应注入 constraints（走 verification 通道）')
})
