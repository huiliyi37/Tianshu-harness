/**
 * B2 turn-call-limit 收敛提醒的 planMode / 星域感知（缺陷 2 修复）。
 *
 * 背景（会话 aa9737bb 审查）：模型进入规划/探寻模式时被无差别催收敛，
 * 只产生妥协（L572-576 模型自我收束放弃取证）。修复后：
 * - planning 态完全不发收敛提醒（高轮次是任务性质，不是发散）
 * - 探寻型星域（tianji/tianxuan/pojun）即使被判 build 也降级为诊断文案
 *
 * 集成测试：构造真实 AgentLoop + mock client 连续输出工具调用，
 * 驱动 turn >= 12 触发 B2，检查注入的 system-reminder 内容。
 */
import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { BASH_TOOL } from '../../tools/bash.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { WRITE_FILE_TOOL } from '../../tools/write-file.js'
import { cpuPool } from '../../workers/cpu-pool.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'b2-mode-test-'))

// 真实执行写类工具会触发 edit-diff → cpuPool 懒加载 worker，其 MessagePort
// 保持 ref 阻止 node:test 进程退出（Worker.unref() 不覆盖 MessagePort）。
// 文件跑完后 dispose：terminate worker + 永久标记 dead，后续用例走 inline
// fallback（cpu-pool 设计如此）。缺这行，本文件含写工具用例时会挂起至超时。
after(() => {
  cpuPool.dispose()
})

function makeToolUseBlock(id: string, command: string): ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'bash',
    input: { command },
  } as ContentBlock
}

function makeReadFileBlock(id: string, filePath: string): ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'read_file',
    input: { file_path: filePath },
  } as ContentBlock
}

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock
}

function makeWriteFileBlock(id: string, filePath: string): ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'write_file',
    input: { file_path: filePath, content: 'probe\n' },
  } as ContentBlock
}

/** Mock client: 前 N 次调用输出只读 bash 工具调用，之后 clean 结束。 */
function mockClientReadProbes(probeTimes: number): StreamClient {
  let callCount = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      if (callCount <= probeTimes) {
        cb.onTextDelta('Gathering evidence...')
        cb.onContentBlock(makeToolUseBlock('call_1', 'grep -n "turnCallLimitAdvisoryFired" src/agent/turn-orchestrator.ts'))
        cb.onStopReason('tool_use', usage)
      } else {
        cb.onTextDelta('Done.')
        cb.onContentBlock(makeTextBlock('Done.'))
        cb.onStopReason('end_turn', usage)
      }
    }),
  } as unknown as StreamClient
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [BASH_TOOL.definition, READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeCallbacks() {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

/** write_file 需要审批——批准所有写操作，让工具真实执行成功。 */
function makeApprovingCallbacks() {
  return { ...makeCallbacks(), onApprovalRequired: async () => true }
}

/** 从会话消息中提取 system-reminder 内容列表 */
function remindersIn(session: SessionContext): string[] {
  return session.getMessages()
    .filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<system-reminder>'))
    .map(m => m.content as string)
}

describe('B2 turn-call-limit planMode/star-domain awareness (defect 2)', () => {
  it('planning 态不发收敛提醒（即使 turn >= 28，1M 窗口阈值）', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)

    // 30 次 productive bash → turn 必然 >= 28；若 planning 分流失效会注入「请收敛」→ 测试红
    const client = mockClientReadProbes(30)
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    agent.enterPlanMode()
    await agent.run('investigate the hang', makeCallbacks())

    const reminders = remindersIn(session)
    const convergence = reminders.filter(r => r.includes('28+ 次 API 调用'))
    assert.equal(convergence.length, 0,
      'RED: planning 态不得注入收敛提醒（高轮次是任务性质，不是发散）')
  })

  it('探寻型星域（tianji）被判 build 时收到诊断文案而非强收敛文案', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)

    // 30 次 productive bash（tsc 免审批）→ 窗口只读占比低 → build 态
    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (callCount <= 30) {
          cb.onTextDelta('Committing...')
          cb.onContentBlock(makeToolUseBlock('call_1', 'echo probe-step'))
          cb.onStopReason('tool_use', usage)
        } else {
          cb.onTextDelta('Done.')
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', usage)
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 1_000_000,
      defaultDomain: 'tianji',
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    await agent.run('explore the space', makeCallbacks())

    const reminders = remindersIn(session)
    const convergence = reminders.filter(r => r.includes('28+ 次 API 调用'))
    assert.equal(convergence.length, 1, 'tianji 域仍发收敛提醒（有界提醒，不静默）')
    assert.ok(convergence[0]!.includes('先用工具核实你将要写进结论的关键断言'),
      'RED: 探寻型星域应收到诊断文案（核实断言），而非"请收敛当前动作并输出结论"')
  })

  it('非探寻星域 + build 态保持强收敛文案（回归：行为与修复前一致）', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (callCount <= 30) {
          cb.onTextDelta('Committing...')
          cb.onContentBlock(makeToolUseBlock('call_1', 'echo probe-step'))
          cb.onStopReason('tool_use', usage)
        } else {
          cb.onTextDelta('Done.')
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', usage)
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 1_000_000,
      defaultDomain: 'tianliang',
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    await agent.run('commit the work', makeCallbacks())

    const reminders = remindersIn(session)
    const convergence = reminders.filter(r => r.includes('28+ 次 API 调用'))
    assert.equal(convergence.length, 1, '非探寻域仍发收敛提醒')
    assert.ok(convergence[0]!.includes('请收敛当前动作并输出结论'),
      '非探寻星域 build 态保持原强收敛文案（回归锚点）')
  })

  it('build 态 B2 携带 course_changed，并在后续改道后核销 adopted', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)
    writeFileSync(join(TEST_CWD, 'evidence.txt'), 'verified\n')

    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (callCount <= 29) {
          cb.onTextDelta('Building...')
          cb.onContentBlock(makeToolUseBlock(`call_${callCount}`, 'echo build-step'))
          cb.onStopReason('tool_use', usage)
        } else if (callCount === 30) {
          cb.onTextDelta('Changing course...')
          cb.onContentBlock(makeReadFileBlock(`call_${callCount}`, 'evidence.txt'))
          cb.onStopReason('tool_use', usage)
        } else {
          cb.onTextDelta('Done.')
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', usage)
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 1_000_000,
      defaultDomain: 'tianliang',
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    let b2Expect: unknown
    const submit = agent.advisoryBus.submit.bind(agent.advisoryBus)
    agent.advisoryBus.submit = entry => {
      if (entry.key === 'turn-call-limit') b2Expect = entry.expect
      submit(entry)
    }

    await agent.run('build then verify another surface', makeCallbacks())

    assert.deepEqual(b2Expect, { kind: 'course_changed', withinTurns: 2 },
      'B2 build 文案必须携带 course_changed 核销谓词')
    const stats = agent.advisoryReadback.getStats().get('turn-call-limit')
    assert.equal(stats?.delivered, 1, 'B2 SR 应进入 readback delivered 桶')
    assert.equal(stats?.adopted, 1, '后续切换工具族应核销为 adopted')
    assert.equal(stats?.ignored, 0)
  })

  it('200K 窗口保持 12 轮阈值（回归锚点：小窗口旧行为不变）', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)

    // 14 次 productive bash（echo 非只读 → build 态）→ 200K 下 turn >= 12 触发，
    // 文案仍是「12+ 次」强收敛。用 echo 而非 grep probe：grep 会被判 diagnostic
    // 态走诊断文案，测不到 build 文案锚点。
    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (callCount <= 14) {
          cb.onTextDelta('Committing...')
          cb.onContentBlock(makeToolUseBlock('call_1', 'echo probe-step'))
          cb.onStopReason('tool_use', usage)
        } else {
          cb.onTextDelta('Done.')
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', usage)
        }
      }),
    } as unknown as StreamClient
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 200_000,
      defaultDomain: 'tianliang',
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    await agent.run('commit the work', makeCallbacks())

    const reminders = remindersIn(session)
    const convergence = reminders.filter(r => r.includes('12+ 次 API 调用'))
    assert.equal(convergence.length, 1, '200K 窗口 12 轮仍触发收敛提醒')
    assert.ok(convergence[0]!.includes('请收敛当前动作并输出结论'),
      '200K 窗口保持原强收敛文案（回归锚点）')
  })

  it('轨迹转坏后触发：先收敛后空转，收敛提醒在转坏后发出恰一次', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)

    // 预填 20 个高分（历史上限）→ 初始轨迹收敛。30 次 echo 空转由真实
    // loop 每轮 push 低分（execute 相位 editRatio=0 → score 低），20 轮后
    // 高分被 shift 挤光 → 轨迹转坏 → turn >= 28 时触发恰一次。
    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (callCount <= 30) {
          cb.onTextDelta('Idle...')
          cb.onContentBlock(makeToolUseBlock(`call_${callCount}`, 'echo idle-step'))
          cb.onStopReason('tool_use', usage)
        } else {
          cb.onTextDelta('Done.')
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', usage)
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 1_000_000,
      defaultDomain: 'tianliang',
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    agent.convergenceScoreHistory.push(...Array.from({ length: 20 }, () => 0.9))

    await agent.run('build then idle', makeCallbacks())

    const reminders = remindersIn(session)
    const convergence = reminders.filter(r => r.includes('28+ 次 API 调用'))
    assert.equal(convergence.length, 1,
      'RED: 轨迹转坏（持续空转）后应触发收敛提醒，且每 run 恰一次')
  })

  it('轨迹收敛（持续写不同文件）时静默：turn >= 28 不发收敛提醒（会话 506a5e86 优化）', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(BASH_TOOL)
    registry.register(READ_FILE_TOOL)
    registry.register(WRITE_FILE_TOOL)

    // 30 次成功 write_file（每次不同文件，novelty 不塌）→ editRatio 高、
    // 收敛 score 高 → 轮数高是任务性质不是发散，B2 应静默。
    let callCount = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (callCount <= 30) {
          cb.onTextDelta('Writing module...')
          cb.onContentBlock(makeWriteFileBlock(`call_${callCount}`, join(TEST_CWD, `mod-${callCount}.ts`)))
          cb.onStopReason('tool_use', usage)
        } else {
          cb.onTextDelta('Done.')
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', usage)
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 60,
      contextWindow: 1_000_000,
      defaultDomain: 'tianliang',
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    } as any, session, TEST_CWD)

    await agent.run('build the modules', makeApprovingCallbacks())

    const reminders = remindersIn(session)
    const convergence = reminders.filter(r => r.includes('28+ 次 API 调用'))
    assert.equal(convergence.length, 0,
      'RED: 轨迹收敛（持续成功写入）时不得催收敛——轮数高是任务性质，不是发散')
  })
})
