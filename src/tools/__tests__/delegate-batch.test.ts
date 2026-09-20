import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCoordinatorBatchDelegateAdapter, createDelegateBatchTool, type DelegateBatchCoordinator } from '../delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { aggregationPolicyKinds, workOrderKindSchema, type AggregationPolicy } from '../../agent/work-order.js'

function makeRun(): CoordinatorRun {
  return {
    status: 'completed',
    results: [{
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Worker completed.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }],
    packet: '<worker_results>packet</worker_results>',
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('DELEGATE_BATCH_TOOL', () => {
  it('settle-time and backstop terminals share mapper.finish without late running replay', async () => {
    const events: Array<{ status: string; eventKind?: string; eventDetail?: string }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests, _policy, _signal, _progress, onWorkerSettled) => {
        requests[0]!.onActivity?.({
          workOrderId: 'batch:0',
          profile: 'code_scout',
          kind: 'text',
          detail: 'tail',
        })
        const base = makeRun()
        const run: CoordinatorRun = {
          ...base,
          results: [{ ...base.results[0]!, workOrderId: 'batch:0' }],
        }
        onWorkerSettled?.(run.results[0]!)
        return run
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_batch_mapper_finish',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: { tasks: [{ objective: 'flush the batch tail' }] },
      onWorkerActivity: (event: any) => events.push(event),
    } as any)

    assert.deepEqual(events.map(event => [event.status, event.eventKind, event.eventDetail]), [
      ['running', 'text', 'tail'],
      ['completed', undefined, undefined],
    ])
    await sleep(150)
    assert.equal(events.length, 2)
  })

  // B1 归属回流：delegate_batch 与 delegate_task 是两处独立接线（bootstrap 各一处），
  // 只测一处会让另一处静默腐烂——两条路径都必须把 passed worker 的 changedFiles
  // 交回主控（failed/blocked 的写入不构成归属证据）。
  it('B1 归属回流：passed worker 的 changedFiles 经第 5 参回填，failed 不回填', async () => {
    const backfilled: string[][] = []
    const base = makeRun()
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async () => ({
        ...base,
        results: [
          { ...base.results[0]!, workOrderId: 'batch:0', status: 'passed', changedFiles: ['src/worker-a.ts'] },
          { ...base.results[0]!, workOrderId: 'batch:1', status: 'failed', changedFiles: ['src/worker-b.ts'] },
        ],
      }),
    }
    const tool = createDelegateBatchTool(coordinator, undefined, undefined, undefined, files => backfilled.push(files))

    const result = await tool.execute({
      toolUseId: 'tu_batch_backfill',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: { tasks: [{ objective: 'Verify the backfill seam thoroughly.', kind: 'verify', profile: 'verifier' }] },
    } as never)

    assert.equal(result.isError, false, '无 backfill 也不该影响返回')
    assert.deepEqual(backfilled, [['src/worker-a.ts']], '只回填 passed worker 的文件')
  })

  it('exposes work-order kind and aggregation policy enums from the work-order schema', () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const schema = tool.definition.input_schema as any
    const taskProperties = schema.properties.tasks.items.properties

    assert.deepEqual(taskProperties.kind.enum, [...workOrderKindSchema.options])
    assert.deepEqual(schema.properties.policy.enum, [...aggregationPolicyKinds])
    assert.ok(schema.properties.policy.enum.includes('weighted_confidence'))
  })

  it('accepts schema-backed batch policy and forwards task kind', async () => {
    const calls: Array<{ requests: DelegationRequest[]; policy?: AggregationPolicy }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests, policy) => {
        calls.push({ requests, policy })
        return makeRun()
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_batch',
      cwd: '/repo',
      sessionTurnCount: 5,
      reviewDepth: 2,
      input: {
        tasks: [{ objective: 'Verify the unit test seam thoroughly.', kind: 'verify', profile: 'verifier' }],
        policy: 'weighted_confidence',
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls[0]?.policy, 'weighted_confidence')
    assert.equal(calls[0]?.requests[0]?.kind, 'verify')
    assert.equal(calls[0]?.requests[0]?.reviewDepth, 2)
  })

  it('终态事件透传派发侧身份（authority/profile）——完成后面板星域不断流', async () => {
    const terminalEvents: Array<{ status?: string; authority?: string; profile?: string }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests, _policy, _signal, _onProgress, onWorkerSettled) => {
        const run: CoordinatorRun = {
          status: 'completed',
          results: requests.map((r, i) => ({
            workOrderId: `batch:${i}`,
            status: 'passed' as const,
            summary: 'Worker completed.',
            findings: [],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
            // coordinator 盖章的派发侧身份（workerResultSchema.profile/authority）
            profile: r.profile,
            authority: r.authority,
          })),
          packet: '<worker_results>packet</worker_results>',
        }
        for (const r of run.results) onWorkerSettled?.(r)
        return run
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_terminal',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [{ objective: 'Verify the seam.', kind: 'verify', profile: 'verifier', authority: 'yaoguang' }],
      },
      onWorkerActivity: (ev: any) => { if (ev.status && ev.status !== 'running') terminalEvents.push(ev) },
    } as any)

    assert.equal(result.isError, false)
    // dual-emission contract：settle 即发 + 批末兜底重放（fleet 层去重），条数 ≥1；
    // 这里钉的是身份透传——每条终态都必须带派发侧 authority/profile。
    assert.ok(terminalEvents.length >= 1, '必须发出终态事件')
    assert.ok(terminalEvents.every(e => e.authority === 'yaoguang'), '终态事件必须透传 authority')
    assert.ok(terminalEvents.every(e => e.profile === 'verifier'), '终态事件必须透传 profile')
  })

  it('异常路径（coordinator 抛错）补发终态——已派发 worker 不得永远卡 running', async () => {
    // 回归锚点：delegate-batch 的 catch 此前直接 return isError，不发终态事件。
    // FleetRegistry 里这些 worker 永远停在 running、时间一直走（CLI TUI 无
    // session-manager 的 sweepStaleDelegationNodes 兜底，见 2026-08 调研）。
    const activities: Array<{ workOrderId?: string; status?: string }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async () => {
        throw new Error('simulated coordinator failure')
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_abort',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Task one.' },
          { objective: 'Task two.' },
        ],
      },
      onWorkerActivity: (ev: any) => activities.push(ev),
    } as any)

    assert.equal(result.isError, true)
    assert.ok(activities.length >= 2,
      `异常路径必须为每个已派发 worker 补发终态，实际 ${activities.length} 条`)
    for (const a of activities) {
      assert.notEqual(a.status, 'running', '异常路径补发的必须是终态，不是 running')
    }
  })

  it('异常路径不覆盖已 settle 的 worker（passed 后不补发 blocked 翻转）', async () => {
    // 审查门（35f459b8f）LOW-1：onWorkerSettled 快路径在 coordinator 内部先发
    // passed，delegateBatch 尾段抛错时 catch 若对同一 orderId 补发 blocked，
    // 事件流出现 passed→blocked 翻转（fleet 端虽免疫，SSE/日志层会记录怪序列）。
    const events: Array<{ workOrderId?: string; status?: string }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (_requests, _policy, _signal, _onProgress, onWorkerSettled) => {
        // worker 0 已 settle（passed 快路径已发）
        onWorkerSettled?.({
          workOrderId: 'batch:0',
          status: 'passed',
          summary: 'done',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        } as any)
        throw new Error('tail failure after settle')
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_flip',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Task one.' },
          { objective: 'Task two.' },
        ],
      },
      onWorkerActivity: (ev: any) => events.push(ev),
    } as any)

    assert.equal(result.isError, true)
    const w0 = events.filter(e => e.workOrderId === 'batch:0')
    assert.ok(w0.length >= 1, 'settled worker 必须收到终态')
    // batch:0 的终态序列不得出现 passed→blocked 翻转：最后一个状态仍是 passed。
    const lastW0 = w0[w0.length - 1]!
    assert.equal(lastW0.status, 'completed', '已 settle 的 worker 不被异常补发覆盖（防翻转）')
    // 未 settle 的 worker 1 仍要补发终态（不卡 running）。
    const w1 = events.filter(e => e.workOrderId === 'batch:1')
    assert.ok(w1.length >= 1, '未 settle 的 worker 必须补发终态')
    assert.equal(w1[0]!.status, 'blocked')
  })

  it('abort 路径：补发终态后 rethrow AbortError——用户取消不得记成批次失败', async () => {
    // 与 delegate-task 同款：catch 曾把 Esc 吞成 isError + 「不要重试」误导文案。
    const activities: Array<{ workOrderId?: string; status?: string }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async () => {
        throw new Error('Delegation aborted: user cancelled')
      },
    }
    const tool = createDelegateBatchTool(coordinator)

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      tool.execute({
        toolUseId: 'tu_batch_abort',
        cwd: '/repo',
        sessionTurnCount: 5,
        input: { tasks: [{ objective: 'Task one.' }, { objective: 'Task two.' }] },
        abortSignal: controller.signal,
        onWorkerActivity: (ev: any) => activities.push(ev),
      } as any),
      (err: unknown) => {
        assert.equal((err as Error).name, 'AbortError', '管道 [interrupted] 特判只认 name')
        return true
      },
    )
    // 终态照发：两个已派发 worker 都不许卡 running
    assert.ok(activities.length >= 2, 'abort 也要先补发终态再 rethrow')
    for (const a of activities) assert.equal(a.status, 'blocked')
  })

  it('生产接线适配器：五参全透传（onWorkerSettled 不得再静默丢失）', async () => {
    // bootstrap 内联适配器曾丢第五参——settledIds 恒空，防翻转守卫在生产失效。
    const seen: Array<{ hasSignal: boolean; hasProgress: boolean; hasSettled: boolean }> = []
    const adapter = createCoordinatorBatchDelegateAdapter(() => ({
      delegateBatch: async (_requests, _policy, signal, onProgress, onWorkerSettled) => {
        seen.push({
          hasSignal: signal !== undefined,
          hasProgress: typeof onProgress === 'function',
          hasSettled: typeof onWorkerSettled === 'function',
        })
        return makeRun()
      },
    }))

    const controller = new AbortController()
    await adapter.delegateBatch(
      [],
      'primary_decides',
      controller.signal,
      () => {},
      () => {},
    )
    assert.deepEqual(seen, [{ hasSignal: true, hasProgress: true, hasSettled: true }])

    await assert.rejects(
      createCoordinatorBatchDelegateAdapter(() => null).delegateBatch([]),
      /not initialized/,
    )
  })

  it('exposes dependsOn in the task schema', () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const schema = tool.definition.input_schema as any
    assert.equal(schema.properties.tasks.items.properties.dependsOn.type, 'array')
    // 收编 #6：dependsOn 支持数字索引或条件边对象
    const items = schema.properties.tasks.items.properties.dependsOn.items
    assert.ok(items.anyOf, 'dependsOn items 应为 anyOf（整数索引 | 条件边对象）')
    assert.equal(items.anyOf[0].type, 'integer')
    assert.equal(items.anyOf[1].properties.onFailure.enum.join(','), 'skip,alternate')
  })

  it('maps dependsOn indices to stable batch:N dependency ids and stable parentTurnId', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_dep',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Refactor the source module under review.' },
          { objective: 'Write tests for the refactored source module.', dependsOn: [0] },
        ],
      },
    })

    assert.equal(result.isError, false)
    const reqs = calls[0]!.requests
    assert.equal(reqs[0]?.parentTurnId, 'tu_dep:batch:0')
    assert.equal(reqs[1]?.parentTurnId, 'tu_dep:batch:1')
    assert.equal(reqs[0]?.dependencies, undefined)
    assert.deepEqual(reqs[1]?.dependencies, ['batch:0'])
  })

  it('maps conditional dependsOn edges to DependencyEdge objects（收编 #6 入口）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_edge',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Refactor the source module under review.' },
          { objective: 'Fallback exploration task for alternate routing.' },
          { objective: 'Write tests for the refactored source module.', dependsOn: [{ index: 0, onFailure: 'alternate', alternateOrderId: 1 }] },
          { objective: 'Lint the module after upstream completes.', dependsOn: [{ index: 0, onFailure: 'skip' }] },
        ],
      },
    })

    assert.equal(result.isError, false)
    const reqs = calls[0]!.requests
    assert.deepEqual(reqs[3]?.dependencies, [{ dependsOn: 'batch:0', onFailure: 'skip' }])
    assert.deepEqual(reqs[2]?.dependencies, [{ dependsOn: 'batch:0', onFailure: 'alternate', alternateOrderId: 'batch:1' }])
  })

  it('rejects conditional edges with out-of-range index / self-reference / bad alternateOrderId', async () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })

    const badIndex = await tool.execute({
      toolUseId: 'tu_edge_bad',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Only task in this batch.' },
          { objective: 'Depends on nonexistent task.', dependsOn: [{ index: 5, onFailure: 'skip' }] },
        ],
      },
    })
    assert.equal(badIndex.isError, true)
    assert.match(String(badIndex.content), /越界/)

    const selfRef = await tool.execute({
      toolUseId: 'tu_edge_self',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'First task does standalone work here.' },
          { objective: 'Second task depends on itself.', dependsOn: [{ index: 1, onFailure: 'skip' }] },
        ],
      },
    })
    assert.equal(selfRef.isError, true)
    assert.match(String(selfRef.content), /依赖了自身/)

    const badAlt = await tool.execute({
      toolUseId: 'tu_edge_alt',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Upstream task that will fail.' },
          { objective: 'Alternate fallback task.' },
          { objective: 'Dependent with out-of-range alternate.', dependsOn: [{ index: 0, onFailure: 'alternate', alternateOrderId: 9 }] },
        ],
      },
    })
    assert.equal(badAlt.isError, true)
    assert.match(String(badAlt.content), /越界/)
  })

  it('rejects 越界索引 dependsOn indices', async () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_bad',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Only task in this batch, no upstream exists.', dependsOn: [3] },
        ],
      },
    })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /越界索引/)
  })

  it('rejects self-referential dependsOn', async () => {
    const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_self',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'First task does standalone work here.' },
          { objective: 'Second task incorrectly 依赖了自身 here.', dependsOn: [1] },
        ],
      },
    })
    assert.equal(result.isError, true)
    assert.match(String(result.content), /依赖了自身/)
  })

  it('passes resume param through to the coordinator for each task', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_resume',
      cwd: '/repo',
      sessionTurnCount: 5,
      input: {
        tasks: [
          { objective: 'Continue the previous search task.', resume: 'wo_abc' },
          { objective: 'Fresh task without resume.' },
        ],
      },
    })

    const reqs = calls[0]!.requests
    assert.equal(reqs[0]?.resumeWorkOrderId, 'wo_abc', 'first task should have resume id')
    assert.equal(reqs[1]?.resumeWorkOrderId, undefined, 'second task should not have resume')
  })

  it('bypasses the progressive task cap when dependencies are declared', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    // sessionTurnCount 0 → progressiveTaskCap = 1; without deps this would trim
    // to a single task. With a declared dependency the full chain must dispatch.
    const result = await tool.execute({
      toolUseId: 'tu_cap',
      cwd: '/repo',
      sessionTurnCount: 0,
      input: {
        tasks: [
          { objective: 'Upstream task that produces the artifact for others.' },
          { objective: 'Midstream task consuming the upstream artifact now.', dependsOn: [0] },
          { objective: 'Downstream task consuming the midstream result now.', dependsOn: [1] },
        ],
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls[0]?.requests.length, 3)
  })

  it('still applies the progressive task cap when no dependencies are declared', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const coordinator: DelegateBatchCoordinator = {
      delegateBatch: async (requests) => { calls.push({ requests }); return makeRun() },
    }
    const tool = createDelegateBatchTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_nocap',
      cwd: '/repo',
      sessionTurnCount: 0,
      input: {
        tasks: [
          { objective: 'First independent scouting task to run now.' },
          { objective: 'Second independent scouting task to run now.' },
          { objective: 'Third independent scouting task to run now.' },
        ],
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls[0]?.requests.length, 1)
  })

  describe('按次预算（Wave 9）', () => {
    it('逐任务的 maxTurns / timeoutMs 透传成各自的 budget 覆盖', async () => {
      const calls: Array<{ requests: DelegationRequest[] }> = []
      const tool = createDelegateBatchTool({
        delegateBatch: async requests => { calls.push({ requests }); return makeRun() },
      })

      await tool.execute({
        toolUseId: 'tu_budget',
        cwd: '/repo',
        sessionTurnCount: 10,
        input: {
          tasks: [
            { objective: '只查一个入口在哪，给点预算就够。', maxTurns: 6 },
            { objective: '扫一遍整个模块的调用关系，慢慢来。', timeoutMs: 900_000 },
            { objective: '按 profile 默认预算跑就行，不做覆盖。' },
          ],
        },
      })

      assert.deepEqual(calls[0]?.requests[0]?.budget, { maxTurns: 6 })
      assert.deepEqual(calls[0]?.requests[1]?.budget, { timeoutMs: 900_000 })
      assert.equal(calls[0]?.requests[2]?.budget, undefined)
    })

    it('外层工具超时覆盖批内最大的按次 timeoutMs', () => {
      const tool = createDelegateBatchTool({ delegateBatch: async () => makeRun() })
      const withOverride = tool.timeoutMs?.({
        toolUseId: 'tu', cwd: '/repo', sessionTurnCount: 0,
        input: { tasks: [{ objective: 'a' }, { objective: 'b', timeoutMs: 900_000 }] },
      })!
      const withoutOverride = tool.timeoutMs?.({
        toolUseId: 'tu', cwd: '/repo', sessionTurnCount: 0,
        input: { tasks: [{ objective: 'a' }, { objective: 'b' }] },
      })!
      assert.ok(withOverride > withoutOverride, '调大的内层预算必须先抬高外层天花板')
      assert.ok(withOverride >= 900_000, '外层至少覆盖单个任务的按次预算')
    })
  })
})
