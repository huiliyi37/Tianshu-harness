import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCliArgs, runHeadless } from '../headless.js'
import { GoalTracker, buildGoalModePrompt } from '../agent/goal-tracker.js'
import type { AgentCallbacks } from '../agent/loop-types.js'
import type { SessionEvent } from '../server/protocol.js'

describe('headless CLI parsing', () => {
  it('recognizes -p prompt input', () => {
    assert.deepEqual(parseCliArgs(['-p', 'echo hello']), { headless: true, prompt: 'echo hello', json: false, streamJson: false })
  })

  it('recognizes --print prompt input with --json', () => {
    assert.deepEqual(parseCliArgs(['--print', 'summarize', '--json']), { headless: true, prompt: 'summarize', json: true, streamJson: false })
  })

  it('leaves interactive args alone', () => {
    assert.deepEqual(parseCliArgs([]), { headless: false, json: false, streamJson: false })
  })

  it('recognizes --goal with --budget', () => {
    assert.deepEqual(
      parseCliArgs(['--goal', 'make tests pass', '--budget', '20']),
      { headless: true, prompt: undefined, json: false, streamJson: false, goal: 'make tests pass', budget: 20 },
    )
  })

  it('--goal 缺省 budget = undefined —— 缺省值由定价层负责，解析层不预置', () => {
    const result = parseCliArgs(['--goal', 'fix lint'])
    assert.equal(result.goal, 'fix lint')
    // 解析层填缺省（曾经的 100）会让定价层把它当成 explicitBudget 而短路——
    // 缺省 100 只允许有一个来源：agent/goal-budget.ts 的 GOAL_BUDGET_BASE。
    assert.equal(result.budget, undefined)
    assert.equal(result.headless, true)
  })

  it('--budget 非数字/非正值归为"没给"（NaN 会让上限静默变成无上限）', () => {
    assert.equal(parseCliArgs(['--goal', 'x', '--budget', 'abc']).budget, undefined)
    assert.equal(parseCliArgs(['--goal', 'x', '--budget', '0']).budget, undefined)
    assert.equal(parseCliArgs(['--goal', 'x', '--budget', '-5']).budget, undefined)
    assert.equal(parseCliArgs(['--goal', 'x', '--budget', '20']).budget, 20)
  })
})

describe('runHeadless', () => {
  it('returns stdout-friendly text output', async () => {
    const result = await runHeadless({
      prompt: 'hello',
      json: false,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Hello')
          callbacks.onTextDelta(' world')
          callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 3 }, 1)
        },
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'Hello world')
    assert.equal(result.json, undefined)
  })

  it('returns structured JSON output in json mode', async () => {
    const result = await runHeadless({
      prompt: 'hello',
      json: true,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Done')
          callbacks.onTurnComplete({ input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 }, 1)
        },
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, JSON.stringify(result.json))
    assert.deepEqual(result.json, {
      success: true,
      text: 'Done',
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 },
    })
  })

  it('returns structured error output when the agent fails', async () => {
    const result = await runHeadless({
      prompt: 'fail',
      json: true,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onError(new Error('boom'))
        },
      }),
    })

    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.json, { success: false, text: '', error: 'boom' })
  })
})

// Headless --goal reuses the same AgentLoop + GoalTracker as the TUI /goal
// command: createAgent attaches a GoalTracker, the continuation loop runs inside
// agent.run() (TurnOrchestrator), and main.ts reads tracker.isGoalAchieved()
// afterwards to derive the exit code. These tests pin that wiring contract
// without needing a live provider.
describe('runHeadless goal-mode wiring', () => {
  it('passes the goal-mode prompt verbatim and surfaces achievement via the tracker', async () => {
    let tracker: GoalTracker | null = null
    await runHeadless({
      prompt: buildGoalModePrompt('finish the task'),
      json: false,
      streamJson: false,
      createAgent: () => {
        tracker = new GoalTracker({ goal: 'finish the task', maxIterations: 5, contextWindow: 1000 })
        return {
          run: async (prompt: string, callbacks: AgentCallbacks) => {
            assert.ok(prompt.includes('finish the task'))
            assert.ok(prompt.includes('GOAL ACHIEVED'))
            callbacks.onTextDelta('working...')
            // The TurnOrchestrator deactivates with 'achieved' when it detects
            // the completion marker; emulate that terminal transition here.
            tracker!.deactivate('achieved')
            callbacks.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1)
          },
        }
      },
    })
    // main.ts maps this to exit code 0.
    assert.equal((tracker as GoalTracker | null)?.isGoalAchieved(), true)
  })

  it('reports not-achieved when the budget is exhausted (maps to exit 1)', async () => {
    let tracker: GoalTracker | null = null
    await runHeadless({
      prompt: buildGoalModePrompt('unreachable goal'),
      json: false,
      streamJson: false,
      createAgent: () => {
        tracker = new GoalTracker({ goal: 'unreachable goal', maxIterations: 1, contextWindow: 1000 })
        return {
          run: async (_prompt: string, callbacks: AgentCallbacks) => {
            callbacks.onTextDelta('still working, not done')
            tracker!.deactivate('budget_exhausted')
            callbacks.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1)
          },
        }
      },
    })
    assert.equal((tracker as GoalTracker | null)?.isGoalAchieved(), false)
  })

  it('stream-json: emits system init, forwards worker events, and closes with result', async () => {
    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true }
    try {
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: true,
        sessionId: 's-test',
        model: 'deepseek-v4',
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onToolUse('t1', 'read_file', { path: 'a.ts' })
            cb.onToolResult('t1', 'read_file', 'file body', false)
            cb.onDelegationActivity?.({ workOrderId: 'wo1', parentToolId: 't1', status: 'running', profile: 'code_scout', toolUseCount: 1 })
            cb.onTextDelta('answer')
            cb.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1, true)
          },
        }),
      })
    } finally {
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
    }
    const events = lines.join('').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.equal(events[0]!.type, 'system')
    assert.equal(events[0]!.subtype, 'init')
    assert.equal(events[0]!.session_id, 's-test')
    assert.ok(events.some(e => e.type === 'tool_use' && e.id === 't1'))
    assert.ok(events.some(e => e.type === 'worker' && e.work_order_id === 'wo1'))
    const last = events[events.length - 1]!
    assert.equal(last.type, 'result')
    assert.equal(last.is_error, false)
    assert.equal(last.result, 'answer')
  })
})

  it('stream-json: 密钥模式全链路脱敏（tool_use/tool_result/text/result）', async () => {
    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true }
    try {
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: true,
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onToolUse('t1', 'bash', { command: 'curl -H "Authorization: Bearer sk-live-abc123" x', api_key: 'sk-in-field' })
            cb.onToolResult('t1', 'bash', 'token=sk-secret-xyz', false)
            cb.onTextDelta('got Authorization: Bearer sk-ant-def456 back')
            cb.onTurnComplete({ input_tokens: 1 }, 1, true)
          },
        }),
      })
    } finally {
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
    }
    const out = lines.join('')
    assert.ok(!out.includes('sk-live-abc123'), 'tool_use 不得泄钥')
    assert.ok(!out.includes('sk-in-field'), 'tool_use 敏感字段不得泄钥')
    assert.ok(!out.includes('sk-secret-xyz'), 'tool_result 不得泄钥')
    assert.ok(!out.includes('sk-ant-def456'), 'text_delta/result 不得泄钥')
    // result 信封仍是最后一行（脱敏不得改变协议形状）
    const events = out.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.equal(events[events.length - 1]!.type, 'result')
  })

  it('stream-json: 不返回遗留 payload（终止态只由 result 信封承载）', async () => {
    const streamResult = await runHeadless({
      prompt: 'hi',
      json: false,
      streamJson: true,
      createAgent: () => ({ run: async () => {} }),
    })
    assert.equal(streamResult.json, undefined, 'streamJson 下遗留 payload 必须缺省——同流双 schema 收尾')
    assert.equal(streamResult.stdout, '')

    const jsonResult = await runHeadless({
      prompt: 'hi',
      json: true,
      streamJson: false,
      createAgent: () => ({ run: async () => {} }),
    })
    assert.ok(jsonResult.json, '--json 模式 payload 不受影响')
  })

  // --stream-events 在无头下必须真的镜像出事件（issue：`-p` 模式下 sink 只在 TUI
  // 装配路径被接进 sinks，无头分支压根到不了那行——文件 0 字节且无任何告警）。
  // 这一组锁的是「接线已存在且与输出格式解耦」，不是文件写入细节（那是 sink 自己的测试）。
  describe('runHeadless --stream-events 接线', () => {
    it('非 stream-json 下也把 run 镜像进 sink，且 stdout 行为不变', async () => {
      const events: SessionEvent[] = []
      const result = await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        eventSink: e => events.push(e),
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onToolUse('t1', 'read_file', { path: 'a.ts' })
            cb.onToolResult('t1', 'read_file', 'file body', false)
            cb.onTextDelta('answer')
            cb.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1, true)
          },
        }),
      })

      // 接线不得改变原有 stdout 契约。
      assert.equal(result.stdout, 'answer')
      assert.equal(result.exitCode, 0)

      const types = events.map(e => e.type)
      assert.ok(types.includes('tool_use'), 'tool_use 必须进事件流')
      assert.ok(types.includes('tool_result'), 'tool_result 必须进事件流')
      assert.ok(types.includes('turn_complete'), 'turn_complete 必须进事件流')
      assert.equal(events[0]!.seq, 1)
      assert.deepEqual(
        events.map(e => e.seq),
        events.map((_, i) => i + 1),
        'seq 必须单调递增无空洞——消费者按它做断点续读',
      )
    })

    it('run 结束时仍压着的尾段文本也必须落进 sink（tap 合并缓冲 → 关闭前 flush）', async () => {
      const events: SessionEvent[] = []
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        eventSink: e => events.push(e),
        // 只发 delta、不发任何后续非 delta 事件：tap 会把文本合并到 4000 字符才落盘，
        // 不收尾 flush 的话这一段就永久留在缓冲里（丢的正好是 run 的最后一段输出）。
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onTextDelta('tail segment')
          },
        }),
      })

      const text = events.filter(e => e.type === 'text_delta')
      assert.equal(text.length, 1, '尾段文本必须被 flush 成一条 text_delta')
      assert.equal(text[0]!.data.text, 'tail segment')
    })

    it('phase / delegation 在非 stream-json 下也进事件流（事件面与 TUI 同宽）', async () => {
      const events: SessionEvent[] = []
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        eventSink: e => events.push(e),
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onPhaseChange?.('tool', { tool: 'read_file' })
            cb.onDelegationActivity?.({
              workOrderId: 'wo1',
              parentToolId: 't1',
              status: 'running',
              profile: 'code_scout',
              toolUseCount: 1,
            })
            cb.onTurnComplete({ input_tokens: 5, output_tokens: 2 }, 1, true)
          },
        }),
      })

      assert.ok(events.some(e => e.type === 'phase'), 'phase 不得因未开 --stream-json 而从事件流消失')
      const delegation = events.find(e => e.type === 'delegation')
      assert.ok(delegation, 'delegation 不得因未开 --stream-json 而从事件流消失')
      assert.equal(delegation!.data.workerId, 'wo1')
    })

    it('sink 落盘内容与 stdout 同口径脱敏', async () => {
      const events: SessionEvent[] = []
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        eventSink: e => events.push(e),
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onTextDelta('got Authorization: Bearer sk-ant-def456 back')
            cb.onToolResult('t1', 'bash', 'token=sk-secret-xyz', false)
          },
        }),
      })

      const dumped = JSON.stringify(events)
      assert.ok(!dumped.includes('sk-ant-def456'), 'text_delta 不得把密钥写进事件文件')
      assert.ok(!dumped.includes('sk-secret-xyz'), 'tool_result 不得把密钥写进事件文件')
    })

    it('sink 抛错不拖垮 run（事件流是诊断通道）', async () => {
      const result = await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        eventSink: () => { throw new Error('disk full') },
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onTextDelta('answer')
            cb.onTurnComplete({ input_tokens: 1 }, 1, true)
          },
        }),
      })
      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'answer')
    })

    // tap 只在 inner **定义了**回调时才投影 SessionEvent（event-tap.ts 里那几个
    // 可选回调都是条件挂载）。所以「无头回调集少了某个键」在类型与行为上都无感，
    // 只在事件文件里表现为静默少一类。这两条把该契约钉住：先钉回调面，再钉事件面。
    it('回调面覆盖 TUI 侧会投影给 tap 的可选回调（缺定义 = 事件流静默少一类）', async () => {
      let captured: AgentCallbacks | undefined
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => { captured = cb },
        }),
      })

      // 对照面 = src/tui/engine/bridge.ts 里 wrapCallbacksWithTuiApp 定义、且 tap 会包装
      // 的那批（onSteerDrain 不在内：它有返回值，tap 刻意不观测）。
      const required = [
        'onTextDelta', 'onThinkingDelta', 'onToolUse', 'onToolResult', 'onTurnComplete',
        'onError', 'onAbort', 'onApprovalRequired',
        'onCheckpoint', 'onPhaseChange', 'onDomainDrift', 'onIntentNote', 'onDelegationActivity',
      ] as const
      const cb = captured as AgentCallbacks | undefined
      assert.ok(cb, 'agent.run 必须收到回调集')
      for (const key of required) {
        assert.equal(
          typeof cb[key], 'function',
          `${key} 未定义——tap 不会投影它对应的事件，--stream-events 的文件会静默少一类记录`,
        )
      }
    })

    it('checkpoint / domain_drift / intent_note 实际落进事件流', async () => {
      const events: SessionEvent[] = []
      await runHeadless({
        prompt: 'hello',
        json: false,
        streamJson: false,
        eventSink: e => events.push(e),
        createAgent: () => ({
          run: async (_p: string, cb: AgentCallbacks) => {
            cb.onCheckpoint?.('deadbeef')
            cb.onDomainDrift?.({
              recommendedId: 'pojun',
              recommendedName: '破军',
              currentId: 'tianshu',
              currentName: '天枢',
              matchedKeywords: ['refactor'],
            })
            cb.onIntentNote?.({ summary: '方向：先收敛测试', confidence: 0.7 })
            cb.onTurnComplete({ input_tokens: 1 }, 1, true)
          },
        }),
      })

      const types = events.map(e => e.type)
      assert.ok(types.includes('checkpoint'), 'checkpoint 必须进事件流')
      assert.ok(types.includes('domain_drift'), 'domain_drift 必须进事件流')
      assert.ok(types.includes('intent_note'), 'intent_note 必须进事件流')
      assert.equal(events.find(e => e.type === 'checkpoint')?.data.hash, 'deadbeef')
    })
  })
