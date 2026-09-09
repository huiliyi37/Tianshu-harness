import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolExecutionController, type ToolExecutionDeps, type ToolExecBatchInput } from '../tool-execution.js'
import { createPredictionAccumulator } from '../prediction-error.js'
import { createTurnBudget } from '../turn-budget.js'

/**
 * Regression guard for the dropped-abortSignal bug (root-cause analysis
 * 2026-06-05, Thread 2). executeBatch builds per-tool ToolPipelineDeps in two
 * branches (parallel `makeDeps` for concurrency-safe tools, sequential
 * `pipelineDeps` for non-safe tools). Both MUST copy input.abortSignal into
 * deps.abortSignal — otherwise delegate_task passes undefined to the coordinator
 * and the entire abort path becomes dead code, causing worker hangs ("No
 * response 3m") and orphaned detached children.
 *
 * The tool receives the signal as params.abortSignal, so a mock registry
 * capturing params.abortSignal proves the whole chain.
 *
 * A1 (2026-06-15): the pipeline now composes the batch signal with a per-tool
 * timeout controller via AbortSignal.any, so the tool receives a *composite*
 * signal rather than the batch signal by identity. The contract this guard
 * protects is unchanged — aborting the batch signal MUST still abort the signal
 * the tool sees (and it must never be undefined) — so we assert propagation, not
 * object identity.
 */
describe('ToolExecutionController abort-signal threading', () => {
  function makeController(captured: { signal?: AbortSignal | undefined }, concurrencySafe: boolean) {
    const deps = {
      config: {
        toolRegistry: {
          execute: async (_name: string, params: any) => {
            captured.signal = params.abortSignal
            return { content: 'ok', isError: false }
          },
          get: () => ({
            definition: { input_schema: {} },
            isConcurrencySafe: () => concurrencySafe,
            timeoutMs: () => 5000,
          }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        contextWindow: 200_000,
        promptEngine: { getModel: () => 'test-model' },
      },
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      },
      prewarm: { get: () => null, invalidate: () => {} },
      evidence: {
        getState: () => ({ filesModified: new Set<string>() }),
        trackFileRead: () => {}, trackFileModified: () => {},
      },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
      runtimeHooks: { runPostTool: async () => {} },
      contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
      trajectory: { getEntries: () => [] },
      getPredictionAccumulator: () => createPredictionAccumulator(),
      setPredictionAccumulator: () => {},
      getVigorState: () => ({}),
      setVigorState: () => {},
      getDoomLoopLevel: () => 'none' as const,
      getSessionTurnCount: () => 1,
      getSessionId: () => 'test-session',
      addToolResults: () => {},
      recordToolHistory: () => {},
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
    } as unknown as ToolExecutionDeps
    return new ToolExecutionController(deps)
  }

  function makeInput(signal: AbortSignal): ToolExecBatchInput {
    return {
      toolUses: [{ id: 't1', name: 'demo_tool', input: {} }],
      callbacks: { onToolResult: () => {} } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    }
  }

  it('threads input.abortSignal into the parallel (concurrency-safe) tool path', async () => {
    const captured: { signal?: AbortSignal | undefined } = {}
    const controller = makeController(captured, true)
    const ac = new AbortController()
    await controller.executeBatch(makeInput(ac.signal))
    assert.ok(captured.signal, 'safe-tool path must forward a signal, not undefined')
    assert.equal(captured.signal!.aborted, false, 'forwarded signal starts un-aborted')
    ac.abort()
    assert.equal(captured.signal!.aborted, true, 'aborting the batch signal must abort the tool-facing signal')
  })

  it('threads input.abortSignal into the sequential (non-safe) tool path', async () => {
    const captured: { signal?: AbortSignal | undefined } = {}
    const controller = makeController(captured, false)
    const ac = new AbortController()
    await controller.executeBatch(makeInput(ac.signal))
    assert.ok(captured.signal, 'non-safe-tool path must forward a signal, not undefined')
    assert.equal(captured.signal!.aborted, false, 'forwarded signal starts un-aborted')
    ac.abort()
    assert.equal(captured.signal!.aborted, true, 'aborting the batch signal must abort the tool-facing signal')
  })
})

/**
 * Sentinel for the empty-tool-result blindspot (session 803d897d): when a tool
 * is aborted mid-flight, the pipeline used to return `content: ''` with
 * is_error: false. The model received zero feedback on its most critical
 * deliveries and could not know the underlying work may have completed in the
 * background. Tool results must NEVER be empty.
 */
describe('aborted tool result is never empty', () => {
  it('returns a non-empty interruption note when the tool throws AbortError', async () => {
    const collected: any[] = []
    const deps = {
      config: {
        toolRegistry: {
          execute: async () => { throw new DOMException('Aborted', 'AbortError') },
          get: () => ({
            definition: { input_schema: {} },
            isConcurrencySafe: () => false,
            timeoutMs: () => 5000,
          }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        sessionId: 'test-session',
        contextWindow: 200_000,
        promptEngine: { getModel: () => 'test-model' },
      },
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      },
      prewarm: { get: () => null, invalidate: () => {} },
      evidence: {
        getState: () => ({ filesModified: new Set<string>() }),
        trackFileRead: () => {}, trackFileModified: () => {},
      },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
      runtimeHooks: { runPostTool: async () => {} },
      contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getVigorState: () => ({}),
      setVigorState: () => {},
      trajectory: { getEntries: () => [] },
      getPredictionAccumulator: () => createPredictionAccumulator(),
      setPredictionAccumulator: () => {},
      getDoomLoopLevel: () => 'none' as const,
      getSessionTurnCount: () => 1,
      getSessionId: () => 'test-session',
      addToolResults: (results: any[]) => { collected.push(...results) },
      recordToolHistory: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
    } as unknown as ToolExecutionDeps
    const controller = new ToolExecutionController(deps)
    const ac = new AbortController()
    await controller.executeBatch({
      toolUses: [{ id: 't1', name: 'deliver_task', input: {} }],
      callbacks: { onToolResult: () => {} } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: ac.signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    })
    const result = collected.find(r => r.type === 'tool_result' && r.tool_use_id === 't1')
    assert.ok(result, 'aborted tool must still produce a tool_result')
    assert.ok(typeof result.content === 'string' && result.content.length > 0, 'aborted tool_result content must not be empty')
    assert.match(result.content, /interrupted/i, 'content should tell the model the call was interrupted')
    assert.match(result.content, /background/i, 'content should warn that work may have completed in the background')
    assert.equal(result.is_error, false, 'user cancellation is not a tool failure')
  })
})

/**
 * Regression guard for the orphaned tool_calls API error (user-reported):
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'." When the batch loop breaks early on abort,
 * the tools past the break never run — but the assistant tool_calls message is
 * already committed. executeBatch MUST backfill a synthetic tool_result for every
 * tool_use so the count stays balanced and the next request is not rejected.
 */
describe('executeBatch backfills a result for every tool_use (no orphans)', () => {
  it('emits one tool_result per tool_use even when aborted before any tool runs', async () => {
    const collected: any[] = []
    const deps = {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => true, timeoutMs: () => 5000 }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        sessionId: 'test-session',
        contextWindow: 200_000,
        promptEngine: { getModel: () => 'test-model' },
      },
      cwd: '/tmp/test',
      harness: { executeTool: async ({ execute }: any) => { const r = await execute(); return { content: r.content, isError: r.isError ?? false, retried: false } } },
      prewarm: { get: () => null, invalidate: () => {} },
      evidence: { getState: () => ({ filesModified: new Set<string>() }), trackFileRead: () => {}, trackFileModified: () => {} },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
      runtimeHooks: { runPostTool: async () => {} },
      contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getVigorState: () => ({}),
      setVigorState: () => {},
      trajectory: { getEntries: () => [] },
      getPredictionAccumulator: () => createPredictionAccumulator(),
      setPredictionAccumulator: () => {},
      getDoomLoopLevel: () => 'none' as const,
      getSessionTurnCount: () => 1,
      getSessionId: () => 'test-session',
      addToolResults: (results: any[]) => { collected.push(...results) },
      recordToolHistory: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
    } as unknown as ToolExecutionDeps
    const controller = new ToolExecutionController(deps)
    const ac = new AbortController()
    ac.abort() // aborted before executeBatch → batch loop breaks immediately, no tool runs
    await controller.executeBatch({
      toolUses: [
        { id: 'a1', name: 'grep', input: {} },
        { id: 'a2', name: 'grep', input: {} },
        { id: 'a3', name: 'grep', input: {} },
      ],
      callbacks: { onToolResult: () => {} } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: ac.signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    })
    for (const id of ['a1', 'a2', 'a3']) {
      const r = collected.find((x) => x.type === 'tool_result' && x.tool_use_id === id)
      assert.ok(r, `every tool_use must have a matching tool_result (missing ${id})`)
      assert.ok(typeof r.content === 'string' && r.content.length > 0, `backfilled result for ${id} must be non-empty`)
    }
  })
})

/**
 * RED probe (2026-08-10 desktop "写文件时服务中断" 调查): batch 中第二个工具
 * 执行中途 abort 时，第一个已成功执行的结果必须仍进入 addToolResults。
 * 现场证据（test-huiliyi37 会话 jsonl L199-201）：edit_file batch 两个调用
 * 都变成 auto-recovered 占位，第一个在 trace 里有成功记录——结果在
 * addToolResults 之前丢失。本测试用真实 executeBatch 复现该路径。
 */
describe('executeBatch mid-batch abort keeps completed results', () => {
  it('commits the first tool result when abort fires during the second tool', async () => {
    const collected: any[] = []
    const ac = new AbortController()
    // 第一个工具立即成功；第二个工具挂起直到 abort
    const deps = {
      config: {
        toolRegistry: {
          execute: async (name: string, params: any) => {
            if (name === 'second') {
              await new Promise((_, reject) => {
                params.abortSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
              })
            }
            return { content: `result-of-${name}`, isError: false }
          },
          get: (name: string) => ({
            definition: { input_schema: {} },
            isConcurrencySafe: () => false,
            timeoutMs: () => 5000,
          }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        sessionId: 'test-session',
        contextWindow: 200_000,
        promptEngine: { getModel: () => 'test-model' },
      },
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      },
      prewarm: { get: () => null, invalidate: () => {} },
      evidence: { getState: () => ({ filesModified: new Set<string>() }), trackFileRead: () => {}, trackFileModified: () => {} },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) },
      runtimeHooks: { runPostTool: async () => {} },
      contextInjection: { setCerebellarHint: () => {}, clearCerebellarHint: () => {} },
      buildRuntimeSnapshot: () => ({}),
      requestThetaCheck: () => {},
      getAutoReasoning: () => false,
      getReasoningEffort: () => undefined,
      setClientReasoningEffort: () => {},
      getVigorState: () => ({}),
      setVigorState: () => {},
      trajectory: { getEntries: () => [] },
      getPredictionAccumulator: () => createPredictionAccumulator(),
      setPredictionAccumulator: () => {},
      getDoomLoopLevel: () => 'none' as const,
      getSessionTurnCount: () => 1,
      getSessionId: () => 'test-session',
      addToolResults: (results: any[]) => { collected.push(...results) },
      recordToolHistory: () => {},
      getSensorium: () => null,
      getReliabilityDecision: () => null,
      getTurnBudget: () => createTurnBudget(0),
      beginToolBatchObservability: () => {},
      endToolBatchObservability: () => {},
    } as unknown as ToolExecutionDeps
    const controller = new ToolExecutionController(deps)

    const batchPromise = controller.executeBatch({
      toolUses: [
        { id: 'first', name: 'first', input: {} },
        { id: 'second', name: 'second', input: {} },
      ],
      callbacks: { onToolResult: () => {} } as any,
      turn: 1,
      checkpointCreatedThisTurn: false,
      abortSignal: ac.signal,
      traceStore: { events: [], toolFingerprints: [] } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      latestRisk: { level: 'none', reasons: [], suggestedAction: '' } as any,
    })

    // 等第一个工具完成后触发 abort（第二个工具执行中）
    await new Promise(r => setTimeout(r, 50))
    ac.abort()

    let outcome: string
    try {
      await batchPromise
      outcome = 'resolved'
    } catch {
      outcome = 'rejected'
    }

    const firstResult = collected.find((r) => r.type === 'tool_result' && r.tool_use_id === 'first')
    const secondResult = collected.find((r) => r.type === 'tool_result' && r.tool_use_id === 'second')
    console.log(`[RED-probe] outcome=${outcome} collected=${collected.length} first=${firstResult ? 'present' : 'MISSING'} second=${secondResult ? 'present' : 'MISSING'}`)
    assert.ok(firstResult, `first tool's completed result must be committed (outcome=${outcome}, collected=${collected.length})`)
    assert.ok(typeof firstResult.content === 'string' && firstResult.content.includes('result-of-first'), 'first result content must be the real tool output, not a placeholder')
    assert.ok(secondResult, 'second tool must also have a backfilled/aborted result so tool_calls pairing stays balanced')
  })
})
