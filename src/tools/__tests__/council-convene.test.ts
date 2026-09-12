import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCouncilConveneTool, DEFAULT_COUNCIL_SEATS, setDeprecatedModelNotesForTest, type CouncilConveneCoordinator } from '../council-convene.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { deriveStableWorkOrderId } from '../../agent/coordinator.js'
import type { WorkerResult } from '../../agent/work-order.js'
import { validateUnifiedPlan, type UnifiedPlan } from '../../agent/unified-plan.js'
import { consumePlan } from '../../agent/plan-store.js'
import { decodeCouncilPanel, COUNCIL_PANEL_UI_PREFIX } from '../../tui/council-panel-model.js'
import type { ToolCallParams } from '../types.js'

function extractPlanJson(content: string): UnifiedPlan | undefined {
  const m = content.match(/```council-plan-json\n([\s\S]*?)\n```/)
  return m ? (JSON.parse(m[1]!) as UnifiedPlan) : undefined
}

function workerResultFor(req: DelegationRequest): WorkerResult {
  const contrib = JSON.stringify({ authority: req.authority, summary: `${req.authority}-said`, additions: [], risks: [], challenges: [], alternatives: [] })
  return {
    workOrderId: deriveStableWorkOrderId(req.parentTurnId) ?? 'wo_unstable',
    status: 'passed',
    summary: `${req.authority} done`,
    findings: [],
    artifacts: [{ kind: 'note', title: 'seat-contribution', content: contrib }],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
  }
}

function makeCoordinator(extra?: Partial<CouncilConveneCoordinator>): {
  coordinator: CouncilConveneCoordinator
  calls: { requests: DelegationRequest[][] }
} {
  const calls = { requests: [] as DelegationRequest[][] }
  const coordinator: CouncilConveneCoordinator = {
    delegateBatch: async (requests): Promise<CoordinatorRun> => {
      calls.requests.push(requests)
      const results = requests.map(workerResultFor)
      return {
        status: 'completed',
        results,
        packet: '',
        // workerModels 回填真实模型信息 → runCouncil 注入 contribution.modelUsed
        workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'test-model' })),
      }
    },
    getSessionId: () => 'sess-1',
    ...extra,
  }
  return { coordinator, calls }
}

function paramsWith(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 't1', cwd: process.cwd() }
}

describe('council_convene 工具', () => {
  const savedEnv = process.env.COUNCIL
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.COUNCIL
    else process.env.COUNCIL = savedEnv
  })

  it('definition 名为 council_convene，objective 必填', () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    assert.equal(tool.definition.name, 'council_convene')
    assert.deepEqual(tool.definition.input_schema?.required, ['objective'])
  })

  it('非法输入（缺 objective）→ isError', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({}))
    assert.equal(res.isError, true)
    assert.equal(calls.requests.length, 0)
  })

  // issue #105（收编自公开仓 PR #108）——把每个席位「实际命中的模型」摊开给用户看，
  // 避免「显示 v4.1f、实际静默走了别的档」的错觉（官方模型切换走的是静默路由：请求
  // 照样成功、模型已换、计费已变）。命中带弃用声明的模型时额外标 ⚠ 与说明。
  it('输出「席位实际调用模型」段；命中弃用模型时带 ⚠ 说明', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'trace seat models' }))
    assert.equal(res.isError, false)
    assert.match(res.content, /## 席位实际调用模型/)
    assert.match(res.content, /test-model/, '应列出每个席位实际命中的模型')

    // 注入弃用表（真实来源是模型配置里的 deprecated 声明；当前内置 presets 无弃用项）
    setDeprecatedModelNotesForTest(new Map([['test-model', '测试用弃用说明']]))
    try {
      const res2 = await tool.execute(paramsWith({ objective: 'trace seat models 2' }))
      assert.match(res2.content, /⚠/)
      assert.match(res2.content, /测试用弃用说明/)
    } finally {
      setDeprecatedModelNotesForTest(undefined)
    }
  })

  it('缺省席位 → 扇出 tianquan/tianfu/tianxuan，全部 plan/council_expert', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'split loop.ts' }))
    assert.equal(res.isError, false)
    assert.equal(calls.requests.length, 1)
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), DEFAULT_COUNCIL_SEATS.map(s => s.authority))
    for (const r of reqs) {
      assert.equal(r.kind, 'plan')
      assert.equal(r.profile, 'council_expert')
    }
    assert.match(res.content, /议事会计划/)
    // uiContent: 工具卡紧凑摘要（≤4 行），全文 markdown 仍在 content。
    assert.ok(res.uiContent, 'council_convene 应返回 uiContent 紧凑摘要')
    assert.ok(res.uiContent!.split('\n').length <= 4)
    assert.match(res.uiContent!, /议事会 · \d+ 席 \d+ 轮/)
    assert.notEqual(res.uiContent, res.content)
    // ── Wave 2 帧断言：成功路径 uiContent 含 council-panel 帧 ──
    assert.ok(res.uiContent?.includes(COUNCIL_PANEL_UI_PREFIX), '成功路径 uiContent 应包含 council-panel 帧')
    const panel = decodeCouncilPanel(res.uiContent!)
    assert.ok(panel, '帧应可解码为 CouncilPanelModel')
    assert.equal(panel!.schemaVersion, 1)
    assert.equal(panel!.objective, 'split loop.ts')
    assert.ok(panel!.seats.length >= 1, '至少一个席位')
    for (const s of panel!.seats) {
      assert.ok(s.authority, '每席应有 authority')
      assert.equal(s.round, 1)
      assert.ok(s.modelUsed, '每席应有 modelUsed')
    }
    assert.ok(panel!.verdict.accepted >= 0)
    assert.equal(panel!.pillarsMode, false)
  })

  it('per-call seats 带 provider+model → 扇出请求携带 modelOverride（异构议事会）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({
      objective: 'x',
      seats: [
        { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
        { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
        { authority: 'tianxuan' },
      ],
    }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.find(r => r.authority === 'tianquan')?.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    assert.deepEqual(reqs.find(r => r.authority === 'tianfu')?.modelOverride, { provider: 'glm', model: 'glm-4.6' })
    assert.equal(reqs.find(r => r.authority === 'tianxuan')?.modelOverride, undefined)
  })

  it('config defaultSeats（无 per-call seats）→ 用配置席位并带 modelOverride', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
    ])
    await tool.execute(paramsWith({ objective: 'x' }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), ['tianquan', 'tianfu'])
    assert.deepEqual(reqs.find(r => r.authority === 'tianquan')?.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    assert.deepEqual(reqs.find(r => r.authority === 'tianfu')?.modelOverride, { provider: 'glm', model: 'glm-4.6' })
  })

  it('重复 authority（per-call）→ isError 且零派发', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'x',
      seats: [
        { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
        { authority: 'tianquan', provider: 'glm', model: 'glm-4.6' },
      ],
    }))
    assert.equal(res.isError, true)
    assert.match(res.content, /重复/)
    assert.equal(calls.requests.length, 0, '重复席位必须在派发前拦截')
  })

  it('重复 authority（config defaultSeats）→ isError', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianfu', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
    ])
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(res.isError, true)
    assert.equal(calls.requests.length, 0)
  })

  it('per-call seats 优先于 config defaultSeats', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
    ])
    await tool.execute(paramsWith({ objective: 'x', seats: [{ authority: 'wenqu' }] }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), ['wenqu'])
    assert.equal(reqs[0]!.modelOverride, undefined)
  })

  it('解耦：扇出请求绝不携带写/执行语义（kind 全 plan，无 patch/verify）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({ objective: 'x', seats: [{ authority: 'tianquan' }] }))
    const reqs = calls.requests[0]!
    assert.ok(reqs.every(r => r.kind === 'plan'), '议事会只出意见，绝不派执行')
  })

  it('COUNCIL=0 → 零派发，isEnabled=false', async () => {
    process.env.COUNCIL = '0'
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    assert.equal(tool.isEnabled(), false)
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(calls.requests.length, 0, 'kill switch 必须零派发')
    assert.match(res.content, /已禁用/)
  })

  it('遥测 + 路由 shadow 旁路落盘（不影响返回）', async () => {
    const sessions: unknown[] = []
    const shadows: unknown[] = []
    const { coordinator } = makeCoordinator({
      recordCouncilSession: e => sessions.push(e),
      recordRoutingShadow: e => shadows.push(e),
    })
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(res.isError, false)
    assert.equal(sessions.length, 1, '应记一条会诊遥测')
    assert.equal(shadows.length, DEFAULT_COUNCIL_SEATS.length, '每席记一条路由 shadow')
  })

  it('遥测 store 抛错不影响交付', async () => {
    const { coordinator } = makeCoordinator({
      recordCouncilSession: () => { throw new Error('db down') },
    })
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x' }))
    assert.equal(res.isError, false)
    assert.match(res.content, /议事会计划/)
  })

  it('rounds=2 + 冲突 → 触发 round2（2 次 delegateBatch）', async () => {
    const calls = { requests: [] as DelegationRequest[][] }
    let batchCalls = 0
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        calls.requests.push(requests)
        batchCalls++
        const results = requests.map(req => {
          if (req.parentTurnId.endsWith('-r2')) {
            return {
              ...workerResultFor(req),
              artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({ authority: req.authority, summary: 'r2', rebuttals: [] }) }],
            }
          }
          // round1：两席对同 id 给出不同 detail → 产生冲突
          const detail = req.authority === 'tianquan' ? 'X' : 'Y'
          return {
            ...workerResultFor(req),
            artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({ authority: req.authority, summary: `${req.authority}-s`, additions: [{ id: 'NEW', title: 't', detail }], risks: [], challenges: [], alternatives: [] }) }],
          }
        })
        return {
          status: 'completed',
          results,
          packet: '',
          workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'test-model' })),
        }
      },
      getSessionId: () => 'sess-1',
    }
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'split loop.ts',
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
      rounds: 2,
    }))
    assert.equal(res.isError, false)
    assert.equal(batchCalls, 2, 'rounds=2 + 冲突 → 两次扇出')
    // round2 请求带 -r2 后缀
    const r2Reqs = calls.requests[1]!
    assert.ok(r2Reqs.every(r => r.parentTurnId.endsWith('-r2')), 'round2 parentTurnId 带 -r2')
  })

  // ── P1 终态回路：席位在桌面子代理面板必须从 running 走到真实终态 ──────────

  it('终态回路：failed 席位终态保持 failed（不虚构 passed），passed 席位带贡献摘要', async () => {
    // 3 席中 1 席持续失败（首轮 + 重试均无 artifact）：法定人数 2/3 仍满足，
    // 会诊继续；失败席位以 failed 终态 + contribution_failed 留痕。
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        const results = requests.map(req => {
          if (req.authority === 'tianquan') {
            return {
              ...workerResultFor(req),
              status: 'failed' as const,
              failureReason: 'timeout' as const,
              summary: 'tianquan exploded',
              artifacts: [],
            }
          }
          return workerResultFor(req)
        })
        return { status: 'completed', results, packet: '', workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'm' })) }
      },
      getSessionId: () => 'sess-1',
    }
    const events: import('../types.js').DelegationActivity[] = []
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute({
      input: { objective: 'x', seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }, { authority: 'tianxuan' }] },
      toolUseId: 't1',
      cwd: process.cwd(),
      onWorkerActivity: (a) => events.push(a),
    } as ToolCallParams)
    assert.equal(res.isError, false)

    const failed = events.find(e => e.workOrderId === 'council:seat-tianquan')
    assert.ok(failed, 'failed 席位应收到终态事件')
    assert.equal(failed!.status, 'failed', 'failed 结果不得被映射成 passed')
    assert.equal(failed!.failureReason, 'timeout')

    // 解析失败触发的单席重试也各自收到终态（-retry id，authority 归并回席位名）
    const retried = events.find(e => e.workOrderId === 'council:seat-tianquan-retry')
    assert.ok(retried, '重试 worker 应收到终态事件')
    assert.equal(retried!.authority, 'tianquan')

    const passed = events.find(e => e.workOrderId === 'council:seat-tianfu')
    assert.ok(passed, 'passed 席位应收到终态事件')
    assert.equal(passed!.status, 'completed')
    assert.equal(passed!.summary, 'tianfu-said', 'passed 席位优先带解析后的贡献摘要')
    assert.equal(passed!.parentToolId, 't1')
  })

  it('终态回路：法定人数不足流会时，已跑席位仍收到终态事件（面板不悬挂）', async () => {
    // 2 席中 1 席持续失败：有效 1 < 法定 ⌈4/3⌉=2 → 流会 isError；
    // 但已真实派发的席位 worker 必须转终态。
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        const results = requests.map(req => {
          if (req.authority === 'tianquan') {
            return { ...workerResultFor(req), status: 'failed' as const, failureReason: 'timeout' as const, artifacts: [] }
          }
          return workerResultFor(req)
        })
        return { status: 'completed', results, packet: '' }
      },
      getSessionId: () => 'sess-1',
    }
    const events: import('../types.js').DelegationActivity[] = []
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute({
      input: { objective: 'x', seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }] },
      toolUseId: 't1',
      cwd: process.cwd(),
      onWorkerActivity: (a) => events.push(a),
    } as ToolCallParams)
    assert.equal(res.isError, true)
    assert.match(String(res.content), /流会/)
    // ── Wave 2 降级帧：流会路径 uiContent 含降级 council-panel 帧 ──
    assert.ok(res.uiContent?.includes(COUNCIL_PANEL_UI_PREFIX), '流会路径应发降级帧')
    const degraded = decodeCouncilPanel(res.uiContent!)
    assert.ok(degraded)
    assert.equal(degraded!.verdict.accepted, 0, '降级帧 verdict 全零')
    assert.equal(degraded!.verdict.rejected, 0)
    assert.equal(degraded!.verdict.conflicts, 0)
    assert.ok(degraded!.seats.length >= 1, '降级帧含席位终态')
    assert.ok(events.find(e => e.workOrderId === 'council:seat-tianquan' && e.status === 'failed'))
    assert.ok(events.find(e => e.workOrderId === 'council:seat-tianfu' && e.status === 'completed'))
    assert.ok(events.find(e => e.workOrderId === 'council:seat-tianquan-retry'), '重试 worker 也须终态')
  })

  it('终态回路：rounds=2 时 r2 席位（-r2 workOrderId）也各自收到终态，且每 id 恰好一条', async () => {
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        const results = requests.map(req => {
          if (req.parentTurnId.endsWith('-r2')) {
            return {
              ...workerResultFor(req),
              artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({ authority: req.authority, summary: 'r2', rebuttals: [] }) }],
            }
          }
          // round1：两席对同 id 给出不同 detail → 产生冲突，触发 r2
          const detail = req.authority === 'tianquan' ? 'X' : 'Y'
          return {
            ...workerResultFor(req),
            artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({ authority: req.authority, summary: `${req.authority}-s`, additions: [{ id: 'NEW', title: 't', detail }], risks: [], challenges: [], alternatives: [] }) }],
          }
        })
        return { status: 'completed', results, packet: '', workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'm' })) }
      },
      getSessionId: () => 'sess-1',
    }
    const events: import('../types.js').DelegationActivity[] = []
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute({
      input: { objective: 'x', seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }], rounds: 2 },
      toolUseId: 't1',
      cwd: process.cwd(),
      onWorkerActivity: (a) => events.push(a),
    } as ToolCallParams)
    assert.equal(res.isError, false)

    const ids = events.map(e => e.workOrderId).sort()
    assert.deepEqual(ids, [
      'council:seat-tianfu',
      'council:seat-tianfu-r2',
      'council:seat-tianquan',
      'council:seat-tianquan-r2',
    ], 'r1 与 r2 各 workOrderId 恰好一条终态，无重复无遗漏')
    assert.ok(events.every(e => e.status === 'completed'))
    // r2 事件的 authority 剥掉 -r2 后缀
    const r2 = events.find(e => e.workOrderId === 'council:seat-tianquan-r2')
    assert.equal(r2!.authority, 'tianquan')
  })

  it('rounds 透传：默认（不传）→ 单轮（1 次 delegateBatch）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({
      objective: 'split loop.ts',
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
    }))
    assert.equal(calls.requests.length, 1, '默认单轮')
  })

  it('W-C7：有任务 → content 内嵌可执行 council-plan-json 块且通过 validateUnifiedPlan', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'split loop.ts',
      draftItems: [{ id: 'T1', title: 'Split', detail: 'do it' }],
    }))
    const planJson = extractPlanJson(res.content)
    assert.ok(planJson, 'content 应内嵌 council-plan-json 块')
    const v = validateUnifiedPlan(planJson)
    assert.equal(v.valid, true, JSON.stringify(v))
    // uiContent 紧凑摘要不应被 planJson 污染
    assert.doesNotMatch(res.uiContent!, /council-plan-json/)
  })

  it('W-C7：席位 addition 的 files 透传进 planJson 任务节点', async () => {
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        const results = requests.map(req => ({
          ...workerResultFor(req),
          artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: JSON.stringify({
            authority: req.authority, summary: 's',
            additions: req.authority === 'tianquan' ? [{ id: 'A1', title: 'a', detail: 'd', files: ['src/loop.ts', 'src/api.ts'] }] : [],
            risks: [], challenges: [], alternatives: [],
          }) }],
        }))
        return { status: 'completed', results, packet: '', workerModels: results.map(r => ({ workOrderId: r.workOrderId, model: 'm' })) }
      },
      getSessionId: () => 'sess-1',
    }
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'x',
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
    }))
    const planJson = extractPlanJson(res.content)!
    const a1 = planJson.tasks.find(t => t.id === 'A1')
    assert.ok(a1, 'addition A1 应进入 planJson')
    assert.deepEqual(a1!.files, ['src/loop.ts', 'src/api.ts'])
  })

  it('W-C7：无任务（空 mergedItems）→ content 不附加 planJson 块', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x', seats: [{ authority: 'tianquan' }] }))
    assert.equal(extractPlanJson(res.content), undefined, '无任务时不应内嵌 planJson')
  })

  // A3：council 产出直接存入 plan-store 会话桥，免模型手工提取 JSON。
  it('A3：有任务（非 autoExecute）→ storePlan 入会话桥且话术指向 bare team_orchestrate', async () => {
    const sessionId = `council-a3-${Date.now()}`
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute({
      ...paramsWith({ objective: 'split loop.ts', draftItems: [{ id: 'T1', title: 'Split', detail: 'do it', files: ['src/loop.ts'] }] }),
      sessionId,
    })
    assert.equal(res.isError, false)
    const stored = consumePlan(sessionId)
    assert.ok(stored, '计划应存入会话桥')
    const v = validateUnifiedPlan(JSON.parse(stored!) as UnifiedPlan)
    assert.equal(v.valid, true)
    assert.match(res.content, /计划已存入会话/)
    assert.match(res.content, /team_orchestrate/)
  })

  it('Da\'at 否决：blocking challenge 未化解 → 不产 planJson、不 storePlan、不 autoExecute', async () => {
    const sessionId = `council-veto-${Date.now()}`
    let executed = 0
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        executed++
        const results = requests.map(req => {
          const contrib = JSON.stringify({
            authority: req.authority, summary: `${req.authority}-said`,
            additions: [], risks: [], alternatives: [],
            challenges: req.authority === 'tianfu'
              ? [{ text: '无回滚方案不得动 schema', severity: 'blocking' }]
              : [],
          })
          return { ...workerResultFor(req), artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: contrib }] }
        })
        return { status: 'completed', results, packet: '' }
      },
      getSessionId: () => sessionId,
    }
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute({
      ...paramsWith({
        objective: 'risky schema change',
        draftItems: [{ id: 'T1', title: 'Migrate', detail: 'do it', files: ['src/db.ts'] }],
        seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }, { authority: 'tianxuan' }],
        autoExecute: true,
      }),
      sessionId,
    })
    assert.equal(res.isError, false, '否决是结构化结果，不是工具错误')
    assert.match(res.content, /⛔ 议事会否决/)
    assert.match(res.content, /无回滚方案不得动 schema/)
    assert.ok(!res.content.includes('council-plan-json'), '否决态不得内嵌可执行 planJson')
    assert.ok(!res.content.includes('已自动执行'), '否决态不得 autoExecute')
    assert.equal(consumePlan(sessionId), null, '否决态不得 storePlan')
    assert.equal(executed, 1, '只有席位扇出，无执行波派发')
  })

  it('A3：无任务 → 不 storePlan', async () => {
    const sessionId = `council-a3-empty-${Date.now()}`
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute({ ...paramsWith({ objective: 'x', seats: [{ authority: 'tianquan' }] }), sessionId })
    assert.equal(consumePlan(sessionId), null)
  })

  // A4：autoExecute 走 executePlan 完整闭环（波分组 + checkpoint），不再裸 delegateBatch。
  it('A4：autoExecute → 经 executor.delegateBatch 派发执行波，content 带 已自动执行', async () => {
    const sessionId = `council-a4-${Date.now()}`
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-council-a4-'))
    const execCalls: DelegationRequest[][] = []
    const { coordinator } = makeCoordinator({
      executor: {
        delegateBatch: async (requests): Promise<CoordinatorRun> => {
          execCalls.push(requests)
          const results = requests.map(req => ({
            ...workerResultFor(req),
            artifacts: [],
          }))
          return { status: 'completed', results, packet: 'exec-done', workerModels: [] }
        },
      },
    })
    const tool = createCouncilConveneTool(coordinator)
    try {
      const res = await tool.execute({
        ...paramsWith({
          objective: 'split loop.ts',
          draftItems: [{ id: 'T1', title: 'Split', detail: 'do it', files: ['src/loop.ts'] }],
          autoExecute: true,
        }),
        sessionId,
        cwd,
      })
      assert.equal(res.isError, false)
      assert.equal(execCalls.length, 1, '执行波应经 executor.delegateBatch 派发')
      assert.ok(execCalls[0]!.every(r => r.parentTurnId.includes(':w0')), '执行请求应带波前缀')
      assert.match(res.content, /## 已自动执行（\d+ 个 worker，\d+ 波）/)
      // autoExecute 成功时不留存 plan-store（避免 stale 泄漏到后续 bare call）。
      assert.equal(consumePlan(sessionId), null)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('A4：autoExecute 执行失败 → 回落 storePlan + 修复指引', async () => {
    const sessionId = `council-a4-fail-${Date.now()}`
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-council-a4f-'))
    const { coordinator } = makeCoordinator({
      executor: {
        delegateBatch: async () => { throw new Error('dispatch exploded') },
      },
    })
    const tool = createCouncilConveneTool(coordinator)
    try {
      const res = await tool.execute({
        ...paramsWith({
          objective: 'split loop.ts',
          draftItems: [{ id: 'T1', title: 'Split', detail: 'do it', files: ['src/loop.ts'] }],
          autoExecute: true,
        }),
        sessionId,
        cwd,
      })
      assert.equal(res.isError, false, '评审产物仍交付')
      assert.match(res.content, /自动执行失败/)
      assert.ok(consumePlan(sessionId), '失败时计划回存会话桥供手工续跑')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('Phase 3：autoExecute 波间门禁失败 → 自动复议（-reconvene 派发）+ 停波 + 回存计划', async () => {
    const sessionId = `council-reconvene-${Date.now()}`
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-council-recon-'))
    // 席位贡献：tianquan 对 T1 声明一个必然失败的白名单 gate 命令。
    // 两个 draft 条目共享文件 → 编译层生成 dependsOn → 两波；wave 0 完成后
    // 出口门禁执行该命令失败 → 触发复议。
    const dispatchedTurnIds: string[] = []
    const failingGate = 'node --test ./definitely-missing-gate.test.js'
    const coordinator: CouncilConveneCoordinator = {
      delegateBatch: async (requests): Promise<CoordinatorRun> => {
        for (const r of requests) dispatchedTurnIds.push(r.parentTurnId)
        const results = requests.map(req => {
          if (req.parentTurnId.startsWith('council:seat-')) {
            const contrib = JSON.stringify({
              authority: req.authority, summary: `${req.authority}-view`, additions: [], risks: [],
              challenges: req.authority === 'tianquan'
                ? [{ text: '必须过门禁', severity: 'advisory', gate: failingGate, itemId: 'T1' }]
                : [],
              alternatives: [],
            })
            return { ...workerResultFor(req), artifacts: [{ kind: 'note' as const, title: 'seat-contribution', content: contrib }] }
          }
          return { ...workerResultFor(req), artifacts: [] }
        })
        return { status: 'completed', results, packet: '', workerModels: [] }
      },
      getSessionId: () => sessionId,
    }
    const tool = createCouncilConveneTool(coordinator)
    try {
      const res = await tool.execute({
        ...paramsWith({
          objective: 'refactor with gates',
          draftItems: [
            { id: 'T1', title: 'a', detail: 'da', files: ['src/shared.ts'] },
            { id: 'T2', title: 'b', detail: 'db', files: ['src/shared.ts'] },
          ],
          autoExecute: true,
        }),
        sessionId,
        cwd,
      })
      assert.equal(res.isError, false, '门禁失败是波级事实，评审产物仍交付')
      assert.match(res.content, /⛔ 门禁未通过/)
      assert.match(res.content, /## 波间复议/)
      assert.match(res.content, /revisePlanSeal/)
      const reconveneDispatches = dispatchedTurnIds.filter(id => id.endsWith('-reconvene'))
      assert.ok(reconveneDispatches.length > 0, '复议席位应以 -reconvene 后缀派发')
      assert.ok(!dispatchedTurnIds.some(id => id.includes(':w1')), '门禁失败后不得推 wave 1')
      assert.ok(consumePlan(sessionId), '停波时计划回存会话桥供修订续跑')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // ── Pro gate（双层模式）：rounds≥2 仅 Pro 可用 ──

  it('rounds:2 且 multiRoundEnabled=false → 降级单轮并注明，不报错', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, undefined, { multiRoundEnabled: false })
    const res = await tool.execute(paramsWith({ objective: 'review the plan', rounds: 2 }))
    assert.equal(res.isError, false)
    assert.match(res.content, /\[Pro\] 议事会第 2 轮/)
    // 单轮 = 一次席位 fanout。
    assert.equal(calls.requests.length, 1)
  })

  it('rounds:2 缺省 gate（未传 options）→ 不注入 Pro 提示', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'review the plan', rounds: 2 }))
    assert.equal(res.isError, false)
    assert.ok(!res.content.includes('[Pro]'))
  })

  it('rounds:1 在 gate 关闭时不受影响', async () => {
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, undefined, { multiRoundEnabled: false })
    const res = await tool.execute(paramsWith({ objective: 'review the plan', rounds: 1 }))
    assert.equal(res.isError, false)
    assert.ok(!res.content.includes('[Pro]'))
  })

  // ── Phase 2: pillars 三柱模式（council max）──

  it('pillars:true → 扇出三柱五席（破军/天机/天权/华盖/瑶光）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({ objective: 'x', pillars: true }))
    assert.equal(res.isError, false)
    const reqs = calls.requests[0]!
    assert.deepEqual(
      reqs.map(r => r.authority).sort(),
      ['huagai', 'pojun', 'tianji', 'tianquan', 'yaoguang'],
    )
  })

  it('pillars:true → 约束柱与平衡柱请求带 tierFloor（瑶光门接线）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({ objective: 'x', pillars: true }))
    const reqs = calls.requests[0]!
    for (const authority of ['tianquan', 'huagai', 'yaoguang']) {
      const req = reqs.find(r => r.authority === authority)
      assert.equal(req?.tierFloor, 'strong', `${authority} 应带 strong tierFloor`)
    }
  })

  it('pillars:true + config defaultSeats → 按 authority 沿用专属模型绑定（mergeSeatOverrides）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator, [
      { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' }, // 不在三柱席 → 忽略
    ])
    await tool.execute(paramsWith({ objective: 'x', pillars: true }))
    const reqs = calls.requests[0]!
    assert.equal(reqs.length, 5, '仍是三柱五席，配置席不追加')
    assert.deepEqual(
      reqs.find(r => r.authority === 'tianquan')?.modelOverride,
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
    )
    assert.equal(reqs.find(r => r.authority === 'tianfu'), undefined)
  })

  it('per-call seats 优先于 pillars:true（显式席位覆盖三柱结构）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({ objective: 'x', pillars: true, seats: [{ authority: 'wenqu' }] }))
    const reqs = calls.requests[0]!
    assert.deepEqual(reqs.map(r => r.authority), ['wenqu'])
  })

  it('编译通过的 planJson 已密封（Atropos v1，可校验完好）', async () => {
    const { verifyPlanSeal } = await import('../../agent/council/council-seal.js')
    const { coordinator } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const res = await tool.execute(paramsWith({
      objective: 'x',
      draftItems: [{ id: 'T1', title: 't', detail: 'd', files: ['src/a.ts'] }],
    }))
    const plan = extractPlanJson(res.content)
    assert.ok(plan, '应产出 planJson')
    const check = verifyPlanSeal(plan as never)
    assert.deepEqual(check, { status: 'intact', version: 1 })
  })

  it('pillars:true → 会诊遥测事件带 pillarsMode=true 与模型构成', async () => {
    const sessions: Array<Record<string, unknown>> = []
    const { coordinator } = makeCoordinator({ recordCouncilSession: e => sessions.push(e as unknown as Record<string, unknown>) })
    const tool = createCouncilConveneTool(coordinator)
    await tool.execute(paramsWith({ objective: 'x', pillars: true }))
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.pillarsMode, true)
    assert.deepEqual(sessions[0]!.modelsUsed, ['test-model'])
    assert.equal(sessions[0]!.heterogeneous, false)
  })

  it('confirm:false → 只展示席位分配方案，零派发（收编 #7）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const result = await tool.execute(paramsWith({
      objective: '评审新缓存策略',
      confirm: false,
    }))

    assert.equal(result.isError, undefined)
    assert.equal(calls.requests.length, 0, 'proposal 阶段不得派发任何席位')
    assert.ok(result.content.includes('议事会席位分配方案'))
    assert.ok(result.content.includes('天权'))
    assert.ok(result.content.includes('confirm: true'))
  })

  it('confirm 缺省（未传）→ 直接执行（向后兼容）', async () => {
    const { coordinator, calls } = makeCoordinator()
    const tool = createCouncilConveneTool(coordinator)
    const result = await tool.execute(paramsWith({ objective: '评审默认行为' }))
    assert.equal(calls.requests.length, 1, '缺省 confirm 保持直接执行')
    assert.ok(result.content.includes('议事会'))
  })
})
