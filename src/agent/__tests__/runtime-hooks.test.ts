import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeHookPipeline,
  createRuntimeHookContext,
} from '../runtime-hooks.js'
import type {
  AfterPerceptionRuntimeHook,
  PostSessionRuntimeHook,
  PostToolRuntimeHook,
  PostTurnRuntimeHook,
  PreTurnRuntimeHook,
  RuntimeHookContext,
  RuntimeHookError,
} from '../runtime-hooks.js'

function makeContext(): RuntimeHookContext {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 3,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

describe('RuntimeHookPipeline', () => {
  it('runs preTurn hooks in registration order', async () => {
    const order: string[] = []
    const hookA: PreTurnRuntimeHook = { phase: 'preTurn', name: 'a', run: async () => { order.push('a') } }
    const hookB: PreTurnRuntimeHook = { phase: 'preTurn', name: 'b', run: async () => { order.push('b') } }
    const pipeline = new RuntimeHookPipeline([hookA, hookB])

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['a', 'b'])
  })

  it('runs afterPerception hooks after sensorium/strategy are available', async () => {
    const seen: string[] = []
    const hook: AfterPerceptionRuntimeHook = {
      phase: 'afterPerception',
      name: 'vigor-strategy',
      run: async (ctx) => {
        seen.push(ctx.snapshot.sensorium ? 'sensorium' : 'missing')
        seen.push(ctx.snapshot.strategy ? 'strategy' : 'missing')
      },
    }
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: { momentum: 0.5, pressure: 0.2, confidence: 0.9, complexity: 0.2, freshness: 0.5, stability: 1 },
      strategy: { reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 },
      vigor: null,
      gitChangeRate: 0,
    season: null,
    })
    const pipeline = new RuntimeHookPipeline([hook])

    await pipeline.runAfterPerception(ctx)

    assert.deepEqual(seen, ['sensorium', 'strategy'])
  })

  it('passes postTool events to postTool hooks', async () => {
    const events: string[] = []
    const hook: PostToolRuntimeHook = {
      phase: 'postTool',
      name: 'learner',
      run: async (_ctx, tool) => {
        events.push(`${tool.name}:${tool.success ? 'ok' : 'err'}:${tool.target ?? 'none'}`)
      },
    }
    const pipeline = new RuntimeHookPipeline([hook])

    await pipeline.runPostTool(makeContext(), { name: 'read_file', success: true, target: 'src/a.ts' })

    assert.deepEqual(events, ['read_file:ok:src/a.ts'])
  })

  it('runs postTurn hooks in registration order', async () => {
    const order: string[] = []
    const hookA: PostTurnRuntimeHook = { phase: 'postTurn', name: 'a', run: async () => { order.push('a') } }
    const hookB: PostTurnRuntimeHook = { phase: 'postTurn', name: 'b', run: async () => { order.push('b') } }
    const pipeline = new RuntimeHookPipeline([hookA, hookB])

    await pipeline.runPostTurn(makeContext())

    assert.deepEqual(order, ['a', 'b'])
  })

  it('runs postSession hooks in registration order', async () => {
    const order: string[] = []
    const hookA: PostSessionRuntimeHook = { phase: 'postSession', name: 'a', run: async () => { order.push('a') } }
    const hookB: PostSessionRuntimeHook = { phase: 'postSession', name: 'b', run: async () => { order.push('b') } }
    const pipeline = new RuntimeHookPipeline([hookA, hookB])

    await pipeline.runPostSession(makeContext())

    assert.deepEqual(order, ['a', 'b'])
  })

  it('isolates hook errors and continues later hooks', async () => {
    const order: string[] = []
    const errors: RuntimeHookError[] = []
    const bad: PreTurnRuntimeHook = { phase: 'preTurn', name: 'bad', run: async () => { throw new Error('boom') } }
    const good: PreTurnRuntimeHook = { phase: 'preTurn', name: 'good', run: async () => { order.push('good') } }
    const pipeline = new RuntimeHookPipeline([bad, good], { onError: error => errors.push(error) })

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['good'])
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.phase, 'preTurn')
    assert.equal(errors[0]!.hookName, 'bad')
    assert.match(errors[0]!.message, /boom/)
  })

  it('异步挂起的 hook 超时降级跳过，后续 hook 照常执行（超时护栏）', async () => {
    const order: string[] = []
    const errors: RuntimeHookError[] = []
    const wedged: PreTurnRuntimeHook = { phase: 'preTurn', name: 'wedged', run: () => new Promise<void>(() => {}) }
    const good: PreTurnRuntimeHook = { phase: 'preTurn', name: 'good', run: async () => { order.push('good') } }
    const pipeline = new RuntimeHookPipeline([wedged, good], {
      onError: error => errors.push(error),
      hookTimeoutMs: 50,
    })

    const start = Date.now()
    await pipeline.runPreTurn(makeContext())
    const elapsed = Date.now() - start

    assert.ok(elapsed < 2000, `runPhase 必须在超时后返回，实际 ${elapsed}ms`)
    assert.deepEqual(order, ['good'], '超时 hook 不得阻塞后续 hook')
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.hookName, 'wedged')
    // 500b5136 起超时消息不再带 [hook-timeout] 标记，改结构化 outcome。
    assert.match(errors[0]!.message, /timed out after 50ms/)
    assert.equal(pipeline.getStats()[0]!.timeouts, 1)
  })

  it('超时后迟到的 rejection 不成孤儿——迟到失败进 onError 保留现场（2026-09-10 修复）', async () => {
    const errors: RuntimeHookError[] = []
    const lateReject: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'late-reject',
      // 超时窗（50ms）过后 80ms 才 reject——修复前是 unhandledRejection：
      // main.ts 有 eperm-filter 兜底只打 stderr，未装的嵌入方在 Node ≥15 直接崩。
      run: () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('essence LLM 网络错误')), 130)),
    }
    const pipeline = new RuntimeHookPipeline([lateReject], {
      onError: error => errors.push(error),
      hookTimeoutMs: 50,
    })
    await pipeline.runPreTurn(makeContext())
    // 等迟到 rejection 落地
    await new Promise(resolve => setTimeout(resolve, 250))

    assert.equal(pipeline.getStats()[0]!.timeouts, 1, 'run 统计只记一次 timed_out，不重复计 runs')
    const late = errors.find(e => e.message.includes('late failure after timeout'))
    assert.ok(late, '迟到失败应进 onError 保留现场')
    assert.equal(late!.hookName, 'late-reject')
    assert.match(late!.message, /essence LLM 网络错误/)
  })

  it('超时 hook 只报一条 onError，不重复标 slow（slow 只认 completed 结局）', async () => {
    // 生产默认 hookTimeoutMs=10_000 > hookSlowMs=2_000（runtime-hooks.ts L154-155）。
    // 现有超时测试 hookTimeoutMs:50 未设 slowMs（默认 2000），elapsed≈50 < 2000，
    // 恰好避开双报路径——本测试用同比例（100 > 10）复现生产行为。
    const errors: RuntimeHookError[] = []
    const wedged: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'wedged',
      run: () => new Promise<void>(() => {}),
    }
    const pipeline = new RuntimeHookPipeline([wedged], {
      onError: error => errors.push(error),
      hookTimeoutMs: 100,
      hookSlowMs: 10,
    })

    await pipeline.runPreTurn(makeContext())

    assert.equal(errors.length, 1, '一次超时事件应只报一条 onError（用户 onError 钩子不应被触发两次）')
    // 500b5136 起消息无 [hook-timeout] 标记；slow 只在 outcome==='completed' 时
    // 置位（runtime-hooks.ts:353），超时 hook 结构上不可能再被标 slow。
    assert.match(errors[0]!.message, /timed out after 100ms/)
    assert.equal(pipeline.getStats()[0]!.slowRuns, 0, '超时 hook 不得计入 slowRuns')
  })

  it('慢 hook 遥测：执行超过 hookSlowMs 标 slow（onRun 事件 + stats 计数）', async () => {
    const events: Array<{ id: string; slow: boolean }> = []
    const slow: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'slow',
      run: () => {
        const until = Date.now() + 60
        while (Date.now() < until) { /* busy 60ms */ }
      },
    }
    const pipeline = new RuntimeHookPipeline([slow], {
      hookSlowMs: 30,
      onRun: event => events.push({ id: event.id, slow: event.slow }),
    })

    await pipeline.runPreTurn(makeContext())

    // slow ≠ error：500b5136 起慢 hook 不再走 onError/[hook-slow] 文案，
    // 改走 onRun 事件 + getStats().slowRuns 结构化遥测通道。
    assert.deepEqual(events, [{ id: 'slow', slow: true }])
    assert.equal(pipeline.getStats()[0]!.slowRuns, 1)
  })

  it('only runs hooks for the requested phase', async () => {
    const order: string[] = []
    const pre: PreTurnRuntimeHook = { phase: 'preTurn', name: 'pre', run: async () => { order.push('pre') } }
    const postTool: PostToolRuntimeHook = { phase: 'postTool', name: 'postTool', run: async () => { order.push('postTool') } }
    const pipeline = new RuntimeHookPipeline([pre, postTool])

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['pre'])
  })

  it('updates snapshot when state-setting effects are used', async () => {
    const ctx = makeContext()
    const errors: RuntimeHookError[] = []
    const pipeline = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'sensorium-setter',
      run: runtime => {
        runtime.effects.setSensorium({ momentum: 0.1, pressure: 0.2, confidence: 0.3, complexity: 0.4, freshness: 0.5, stability: 0.6 })
        runtime.effects.setStrategy({ reasoningEffort: 'high', explorationBreadth: 0.9, commitThreshold: 0.8, shouldEscalate: true, thetaCycleInterval: 3 })
      },
    }, {
      phase: 'preTurn',
      name: 'reader',
      run: runtime => {
        assert.equal(runtime.snapshot.sensorium?.momentum, 0.1)
        assert.equal(runtime.snapshot.strategy?.reasoningEffort, 'high')
      },
    }], { onError: error => errors.push(error) })

    await pipeline.runPreTurn(ctx)

    assert.deepEqual(errors, [])
  })

  it('exposes typed effects for controlled hook-to-loop communication', async () => {
    const messages: string[] = []
    const thetaRequests: string[] = []
    const phases: Array<{ phase: string; detail?: { tool?: string; reason?: string; suggestion?: string } }> = []
    const ctx = createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
    season: null,
    }, {
      injectUserMessage: message => { messages.push(message) },
      requestThetaCheck: reason => { thetaRequests.push(reason) },
      emitPhaseChange: (phase, detail) => { phases.push({ phase, detail }) },
    })
    const hook: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'effects',
      run: async (runtime) => {
        runtime.effects.injectUserMessage('hello')
        runtime.effects.requestThetaCheck('elm')
        runtime.effects.emitPhaseChange('tianshu-encore', { reason: 'kick' })
      },
    }
    const pipeline = new RuntimeHookPipeline([hook])

    await pipeline.runPreTurn(ctx)

    assert.deepEqual(messages, ['hello'])
    assert.deepEqual(thetaRequests, ['elm'])
    assert.deepEqual(phases, [{ phase: 'tianshu-encore', detail: { reason: 'kick' } }])
  })

  it('publishes a manifest and skips explicitly disabled hooks', async () => {
    const ran: string[] = []
    const disabled: PreTurnRuntimeHook = { phase: 'preTurn', name: 'disabled', run: () => { ran.push('disabled') } }
    const enabled: PostTurnRuntimeHook = { phase: 'postTurn', name: 'enabled', run: () => { ran.push('enabled') } }
    const pipeline = new RuntimeHookPipeline([disabled, enabled], { disabledHookIds: ['disabled'] })

    assert.deepEqual(pipeline.getManifest(), [
      { id: 'disabled', phase: 'preTurn', enabled: false },
      { id: 'enabled', phase: 'postTurn', enabled: true },
    ])

    await pipeline.runPreTurn(makeContext())
    await pipeline.runPostTurn(makeContext())

    assert.deepEqual(ran, ['enabled'])
    // 计数字段精确断言；时长字段在 1ms 分辨率的 Date.now() 下会跨边界测出
    // 1ms（间歇失败实录）——只断言非负，不钉绝对值。
    const stats = pipeline.getStats()
    assert.deepEqual(
      stats.map(s => ({ id: s.id, phase: s.phase, runs: s.runs, skipped: s.skipped, failures: s.failures, timeouts: s.timeouts, slowRuns: s.slowRuns })),
      [
        { id: 'disabled', phase: 'preTurn', runs: 0, skipped: 1, failures: 0, timeouts: 0, slowRuns: 0 },
        { id: 'enabled', phase: 'postTurn', runs: 1, skipped: 0, failures: 0, timeouts: 0, slowRuns: 0 },
      ],
    )
    for (const s of stats) {
      assert.ok(s.totalDurationMs >= 0 && s.maxDurationMs >= 0)
    }
  })

  it('reports hook timeouts and continues later hooks', async () => {
    const errors: RuntimeHookError[] = []
    const order: string[] = []
    const pipeline = new RuntimeHookPipeline([
      { phase: 'preTurn', name: 'stalled', run: () => new Promise<void>(() => {}) },
      { phase: 'preTurn', name: 'later', run: () => { order.push('later') } },
    ], { hookTimeoutMs: 10, onError: error => errors.push(error) })

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(order, ['later'])
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.hookName, 'stalled')
    assert.match(errors[0]!.message, /timed out after 10ms/)
    assert.equal(pipeline.getStats()[0]!.timeouts, 1)
  })

  it('marks completed hooks above the slow threshold', async () => {
    const events: Array<{ id: string; slow: boolean }> = []
    const pipeline = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'slow',
      run: async () => { await new Promise(resolve => setTimeout(resolve, 15)) },
    }], {
      hookTimeoutMs: 100,
      hookSlowMs: 1,
      onRun: event => events.push({ id: event.id, slow: event.slow }),
    })

    await pipeline.runPreTurn(makeContext())

    assert.deepEqual(events, [{ id: 'slow', slow: true }])
    assert.equal(pipeline.getStats()[0]!.slowRuns, 1)
  })

  it('per-hook budgetMs 覆盖全局超时（未声明的 hook 仍走全局护栏）', async () => {
    const errors: RuntimeHookError[] = []
    const events: Array<{ id: string; outcome: string; budgetMs?: number }> = []
    const wedged: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'wedged',
      budgetMs: 20,
      run: () => new Promise<void>(() => {}),
    }
    const normal: PreTurnRuntimeHook = {
      phase: 'preTurn',
      name: 'normal',
      run: async () => { await new Promise(resolve => setTimeout(resolve, 5)) },
    }
    const pipeline = new RuntimeHookPipeline([wedged, normal], {
      hookTimeoutMs: 5000, // 全局 5s——wedged 若误走全局会拖 5s
      hookSlowMs: 10,
      onError: error => errors.push(error),
      onRun: event => events.push({ id: event.id, outcome: event.outcome, budgetMs: event.budgetMs }),
    })

    const start = Date.now()
    await pipeline.runPreTurn(makeContext())
    const elapsed = Date.now() - start

    assert.ok(elapsed < 2000, `per-hook budget 必须生效，实际 ${elapsed}ms`)
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.hookName, 'wedged')
    assert.match(errors[0]!.message, /timed out after 20ms/)
    assert.equal(events.find(e => e.id === 'wedged')?.outcome, 'timed_out')
    assert.equal(events.find(e => e.id === 'wedged')?.budgetMs, 20, '事件必须带结构化 budgetMs')
    assert.equal(events.find(e => e.id === 'normal')?.outcome, 'completed')
    assert.equal(events.find(e => e.id === 'normal')?.budgetMs, 5000, '未声明预算的 hook 用全局值')
  })

  it('未传 hookTimeoutMs 时默认 10 秒护栏（事件 budgetMs=10000）', async () => {
    const events: Array<{ id: string; budgetMs?: number }> = []
    const quick: PreTurnRuntimeHook = { phase: 'preTurn', name: 'quick', run: async () => {} }
    const pipeline = new RuntimeHookPipeline([quick], {
      onRun: event => events.push({ id: event.id, budgetMs: event.budgetMs }),
    })

    await pipeline.runPreTurn(makeContext())

    assert.equal(events[0]!.budgetMs, 10_000)
  })

  it('setDisabledHookIds 热更：禁用后 runPhase skip 且 manifest 反映，恢复后重新执行', async () => {
    const order: string[] = []
    const hookA: PreTurnRuntimeHook = { phase: 'preTurn', name: 'a', run: async () => { order.push('a') } }
    const hookB: PreTurnRuntimeHook = { phase: 'preTurn', name: 'b', run: async () => { order.push('b') } }
    const events: Array<{ id: string; outcome: string }> = []
    const pipeline = new RuntimeHookPipeline([hookA, hookB], {
      onRun: event => events.push({ id: event.id, outcome: event.outcome }),
    })

    // 初始全启用
    await pipeline.runPreTurn(makeContext())
    assert.deepEqual(order, ['a', 'b'])
    assert.deepEqual(pipeline.getManifest().map(m => [m.id, m.enabled]), [['a', true], ['b', true]])

    // 热更：禁用 a
    pipeline.setDisabledHookIds(['a'])
    order.length = 0
    events.length = 0
    await pipeline.runPreTurn(makeContext())
    assert.deepEqual(order, ['b'], '禁用的 hook 不再执行')
    assert.equal(pipeline.isEnabled('a'), false)
    assert.equal(pipeline.isEnabled('b'), true)
    assert.deepEqual(pipeline.getManifest().map(m => [m.id, m.enabled]), [['a', false], ['b', true]])
    assert.equal(events.find(e => e.id === 'a')?.outcome, 'skipped', '禁用 hook 发布 skipped 事件')

    // 热更：恢复 a（空禁用集）
    pipeline.setDisabledHookIds([])
    order.length = 0
    await pipeline.runPreTurn(makeContext())
    assert.deepEqual(order, ['a', 'b'], '恢复后重新执行')
    assert.equal(pipeline.isEnabled('a'), true)
  })
})
