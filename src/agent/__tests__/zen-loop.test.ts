import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { SessionPersist } from '../session-persist.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { EDIT_FILE_TOOL } from '../../tools/edit.js'
import { BASH_TOOL } from '../../tools/bash.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import { resolveZenConfig, type ResolvedZenConfig } from '../zen-mode.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-zen-loop-'))

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** 首轮产出 tool_use（stopReason=tool_use），后续轮次产出文本（end_turn）。 */
function zenClient(firstBlocks: ContentBlock[]): StreamClient {
  let callCount = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      const blocks = callCount === 1 ? firstBlocks : [makeTextBlock('done')]
      for (const b of blocks) {
        if (b.type === 'text' && 'text' in b) cb.onTextDelta(b.text)
        cb.onContentBlock(b)
      }
      cb.onStopReason(callCount === 1 ? 'tool_use' : 'end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as StreamClient
}

function makeCallbacks(collect?: {
  toolResults: string[]
  /** 结果回调的终态标记留痕：undefined 会被 TUI 解释成「流式中间更新」。 */
  isErrorLog?: Array<{ name: string; isError?: boolean }>
}) {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: (_id: string, name: string, _result?: string, isError?: boolean) => {
      collect?.toolResults.push(name)
      collect?.isErrorLog?.push({ name, isError })
    },
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

/** 读面单工具配置（tests 用最小面，契约默认面由 resolveZenConfig 物化）。 */
function makeZenConfig(overrides: Partial<Parameters<typeof resolveZenConfig>[0] & object> = {}): ResolvedZenConfig {
  return resolveZenConfig({ enabled: true, face: ['read_file'], ...overrides })
}

function makeBaseConfig(zen: ResolvedZenConfig | undefined) {
  return {
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    approvalMode: 'dangerously-skip-permissions' as const,
    zen,
  }
}

function makeRegistry() {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  registry.register(EDIT_FILE_TOOL)
  registry.register(BASH_TOOL)
  return registry
}

describe('Zen Mode — AgentLoop 接线（真实 loop + mock LLM）', () => {
  it('① 新会话首轮工具定义 = 读面（不含 edit_file/bash，含 read_file）', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    const names = agent.getActiveToolNames()
    assert.ok(names.includes('read_file'), `读面必须含 read_file，实际 ${names.join(', ')}`)
    assert.ok(!names.includes('edit_file'), `读面不得含 edit_file，实际 ${names.join(', ')}`)
    assert.ok(!names.includes('bash'), `读面不得含 bash，实际 ${names.join(', ')}`)
  })

  it('①b 防御：直构传未物化 zen（{enabled:true} 缺 face）→ 二次物化补默认读面，不落空面', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      // LOW-1：绕过 ResolvedZenConfig 类型的非法形态（真实入口都传物化结果，
      // 此用例锁住 loop 内二次物化防线——裸 ?? 会 new Set(undefined) → 空读面）。
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig({ enabled: true } as unknown as ResolvedZenConfig) },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true, 'enabled:true 必须 arm')
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('read_file'), `缺 face 的配置必须物化出默认读面，实际 ${names.join(', ')}`)
    assert.ok(!names.includes('edit_file'), 'arm 后仍为读面')
  })

  it('② 首轮模型调 read_file → 不晋升（相位保持 zen）', async () => {
    const session = new SessionContext()
    writeFileSync(join(TEST_CWD, 'target.txt'), 'hello')

    const agent = new AgentLoop(
      { client: zenClient([makeToolUseBlock('t1', 'read_file', { file_path: join(TEST_CWD, 'target.txt') })]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    await agent.run('读一下 target.txt\n并给出分析', makeCallbacks())

    assert.equal(agent.zenController.isZen, true, '读工具调用不得触发晋升')
    const names = agent.getActiveToolNames()
    assert.ok(!names.includes('edit_file'), '读工具调用后工具面必须仍为读面')
  })

  it('③ 首轮模型调 edit_file → 晋升 full 且该调用执行成功（放行语义）', async () => {
    const session = new SessionContext()
    const filePath = join(TEST_CWD, 'edit-target.txt')
    writeFileSync(filePath, 'foo')

    const agent = new AgentLoop(
      {
        client: zenClient([makeToolUseBlock('t1', 'edit_file', { file_path: filePath, old_string: 'foo', new_string: 'bar' })]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig()),
      },
      session,
      TEST_CWD,
    )

    const toolResults: string[] = []
    await agent.run('帮我改文件\n这是多行任务请求', makeCallbacks({ toolResults }))

    // 晋升：相位从 zen → full
    assert.equal(agent.zenController.isZen, false, '面外调用必须晋升 full')
    assert.equal(agent.zenController.currentPhase, 'full')
    assert.equal(agent.zenController.lastPromoteReason, 'tool')
    // 放行语义：该 edit_file 调用真实执行成功（不是被拦也不是报错）
    assert.ok(toolResults.includes('edit_file'), `edit_file 必须执行，实际工具结果 ${toolResults.join(', ')}`)
    assert.equal(readFileSync(filePath, 'utf8'), 'bar', 'edit_file 必须真实生效')
  })

  it('④ 晋升后工具定义 = 全量', async () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true)
    agent.promoteZen('triage')
    assert.equal(agent.zenController.isZen, false)

    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `晋升后必须恢复全量（含 edit_file），实际 ${names.join(', ')}`)
    assert.ok(names.includes('bash'), `晋升后必须恢复全量（含 bash），实际 ${names.join(', ')}`)
    assert.ok(names.includes('read_file'), `晋升后必须恢复全量（含 read_file），实际 ${names.join(', ')}`)
  })

  it('⑤ enabled:false → 全量面（zen 禁用恒放行）', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig({ enabled: false })) },
      session,
      TEST_CWD,
    )

    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `enabled:false 必须全量面（含 edit_file），实际 ${names.join(', ')}`)
    assert.ok(names.includes('bash'), `enabled:false 必须全量面（含 bash），实际 ${names.join(', ')}`)
    assert.equal(agent.zenController.isZen, false)
  })

  it('⑥ worker 会话不 arm（headless）', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      {
        client: zenClient([]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig()),
        headless: true,
      },
      session,
      TEST_CWD,
    )

    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `worker 会话不 arm——必须全量面（含 edit_file），实际 ${names.join(', ')}`)
    assert.equal(agent.zenController.isZen, false)
  })

  it('⑦ triage：单行短消息首轮前晋升（首轮面即全量）', async () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true, '构造后应先 arm')
    await agent.run('ok', makeCallbacks())

    assert.equal(agent.zenController.isZen, false, '短消息必须跳过禅')
    assert.equal(agent.zenController.lastPromoteReason, 'triage')
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `triage 后首轮面即全量（含 edit_file），实际 ${names.join(', ')}`)
  })

  it('⑧ timeout：步数预算到 → 晋升 full（reason=timeout）', async () => {
    const session = new SessionContext()
    writeFileSync(join(TEST_CWD, 'timeout-target.txt'), 'hello')

    const agent = new AgentLoop(
      {
        client: zenClient([makeToolUseBlock('t1', 'read_file', { file_path: join(TEST_CWD, 'timeout-target.txt') })]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig({ timeoutSteps: 1 })),
      },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true)
    // 多行消息——避免 triage（短消息分诊只认单行）
    await agent.run('读一下 timeout-target.txt\n并给出分析', makeCallbacks())

    assert.equal(agent.zenController.isZen, false, '预算 1 个 turn 必须超时晋升')
    assert.equal(agent.zenController.lastPromoteReason, 'timeout')
  })

  it('⑨ /fast：promoteZen(user) → 用户跳过晋升', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true)
    assert.equal(agent.promoteZen('user'), true)
    assert.equal(agent.zenController.isZen, false)
    assert.equal(agent.zenController.lastPromoteReason, 'user')
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `/fast 后必须全量面，实际 ${names.join(', ')}`)
  })

  it('⑩ resume：meta 记录 full → 不重入 zen（全量面）', async () => {
    const sid = `zen-resume-full-${Date.now()}`
    const p = new SessionPersist(sid, TEST_CWD)
    // initMetadata（同步写盘）→ updateMetadata（内存）→ flushSessionBuffer（落盘）
    p.initMetadata()
    p.updateMetadata({ zenPhase: 'full' })
    await p.flushSessionBuffer()

    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()), sessionId: sid },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, false, 'resume full 不得重入 zen')
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `resume full 必须全量面（含 edit_file），实际 ${names.join(', ')}`)
  })

  it('⑩b resume：meta 记录 zen → 恢复读面', async () => {
    const sid = `zen-resume-zen-${Date.now()}`
    const p = new SessionPersist(sid, TEST_CWD)
    p.initMetadata()
    p.updateMetadata({ zenPhase: 'zen' })
    await p.flushSessionBuffer()

    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()), sessionId: sid },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true, 'resume zen 必须恢复读面')
    const names = agent.getActiveToolNames()
    assert.ok(!names.includes('edit_file'), `resume zen 必须读面（不含 edit_file），实际 ${names.join(', ')}`)
  })

  it('⑩c resume：meta 记录 zen 且 zenTurns 已到预算 → 立即 timeout 晋升（不无限续期）', async () => {
    const sid = `zen-resume-budget-${Date.now()}`
    const p = new SessionPersist(sid, TEST_CWD)
    p.initMetadata()
    p.updateMetadata({ zenPhase: 'zen', zenStats: { armed: true, zenTurns: 8 } })
    await p.flushSessionBuffer()

    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()), sessionId: sid },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, false, '预算已耗尽的 resume 不得重入 zen')
    assert.equal(agent.zenController.lastPromoteReason, 'timeout', 'resume 续期漏洞必须记 timeout 晋升')
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('edit_file'), `resume 预算耗尽必须恢复全量面，实际 ${names.join(', ')}`)
  })

  it('⑩d resume：meta 记录 zen 且 zenTurns=7 → 恢复读面并保留剩余预算', async () => {
    const sid = `zen-resume-remaining-${Date.now()}`
    const p = new SessionPersist(sid, TEST_CWD)
    p.initMetadata()
    p.updateMetadata({ zenPhase: 'zen', zenStats: { armed: true, zenTurns: 7 } })
    await p.flushSessionBuffer()

    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()), sessionId: sid },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true, '未到预算的 resume 应恢复读面')
    assert.equal(agent.zenController.snapshot().zenStats.zenTurns, 7, '剩余预算必须从 meta 恢复')
  })

  it('⑩e turn 边界必须落盘 zenStats（写侧）——真实会话中途退出后 resume 不清零预算', async () => {
    const sid = `zen-boundary-persist-${Date.now()}`
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()), sessionId: sid },
      session,
      TEST_CWD,
    )
    assert.equal(agent.zenController.isZen, true, '前置：会话应处于 zen')

    // 真实路径：turn 边界 tick 两次（不手工伪造 meta——伪造前提正是旧测试掩盖写侧断链的方式）。
    // 多行消息绕过首消息分诊（单行短消息会 promote('triage')，tick 就不计数了）。
    const boundary = (agent as unknown as { zenTurnBoundary: (input: string, hasAttachments: boolean) => void }).zenTurnBoundary.bind(agent)
    boundary('第一条读请求\n这是多行任务请求，不触发分诊', false)
    boundary('第二条读请求\n同样是多行任务请求', false)
    assert.equal(agent.zenController.snapshot().zenStats.zenTurns, 2, 'tick 两次后内存计数应为 2')

    await agent.persist!.flushSessionBuffer()
    const meta = new SessionPersist(sid, TEST_CWD).loadMetadata()
    assert.equal(meta?.zenStats?.zenTurns, 2, 'turn 边界必须把步数计数落盘——否则 resume 清零预算（无限续期）')
    assert.equal(meta?.zenPhase, 'zen', '落盘时相位应保持 zen')
  })

  it('⑪ meta：arm 落 zenPhase + zenStats；晋升落 full + 原因', async () => {
    const sid = `zen-meta-${Date.now()}`
    const session = new SessionContext()
    const filePath = join(TEST_CWD, 'meta-target.txt')
    writeFileSync(filePath, 'foo')

    const agent = new AgentLoop(
      {
        client: zenClient([makeToolUseBlock('t1', 'edit_file', { file_path: filePath, old_string: 'foo', new_string: 'bar' })]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig()),
        sessionId: sid,
      },
      session,
      TEST_CWD,
    )

    // arm 后：meta 落 zenPhase + zenStats.armed（flush 落盘后读）
    await agent.persist!.flushSessionBuffer()
    let meta = new SessionPersist(sid, TEST_CWD).loadMetadata()
    assert.equal(meta?.zenPhase, 'zen', 'arm 必须落盘 zenPhase=zen')
    assert.equal(meta?.zenStats?.armed, true, 'arm 必须落盘 zenStats.armed=true')

    // 面外调用晋升后：meta 落 full + 原因
    await agent.run('帮我改文件\n这是多行任务请求', makeCallbacks())
    await agent.persist!.flushSessionBuffer()
    meta = new SessionPersist(sid, TEST_CWD).loadMetadata()
    assert.equal(meta?.zenPhase, 'full', '晋升必须落盘 zenPhase=full')
    assert.equal(meta?.zenPromoteReason, 'tool', '晋升必须落盘晋升原因')
  })

  it('⑫ zen_unlock：首轮模型调 zen_unlock → 晋升 full（reason=tool）且同轮后续写工具放行', async () => {
    const session = new SessionContext()
    const filePath = join(TEST_CWD, 'unlock-target.txt')
    writeFileSync(filePath, 'foo')

    const agent = new AgentLoop(
      {
        client: zenClient([
          makeToolUseBlock('t1', 'zen_unlock', { intent: '需要修改文件' }),
          makeToolUseBlock('t2', 'edit_file', { file_path: filePath, old_string: 'foo', new_string: 'bar' }),
        ]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig()),
      },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true, '构造后应先 arm')
    const toolResults: string[] = []
    await agent.run('把 unlock-target.txt 里 foo 改成 bar\n这是多行任务', makeCallbacks({ toolResults }))

    // 解锁声明 → 晋升 full（reason=tool——与面外工具调用同语义：动手意图）
    assert.equal(agent.zenController.isZen, false, 'zen_unlock 必须晋升 full')
    assert.equal(agent.zenController.lastPromoteReason, 'tool')
    // zen_unlock 返回成功结果（虚拟工具不执行不报错）
    assert.ok(toolResults.includes('zen_unlock'), `zen_unlock 必须返回成功结果，实际 ${toolResults.join(', ')}`)
    // 同轮后续 edit_file 放行执行（解锁即时生效）
    assert.ok(toolResults.includes('edit_file'), `同轮后续 edit_file 必须执行，实际 ${toolResults.join(', ')}`)
    assert.equal(readFileSync(filePath, 'utf8'), 'bar', 'edit_file 必须真实生效')
  })

  it('⑬ 读面含 zen_unlock（解锁声明工具恒可见），不含 edit_file/bash', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    assert.equal(agent.zenController.isZen, true)
    const names = agent.getActiveToolNames()
    assert.ok(names.includes('zen_unlock'), `读面必须含 zen_unlock（动手表达通道），实际 ${names.join(', ')}`)
    assert.ok(names.includes('read_file'), `读面必须含 read_file，实际 ${names.join(', ')}`)
    assert.ok(!names.includes('edit_file'), `读面不得含 edit_file，实际 ${names.join(', ')}`)
    assert.ok(!names.includes('bash'), `读面不得含 bash，实际 ${names.join(', ')}`)
  })

  it('⑭ full 面不含 zen_unlock（解锁已完成，虚拟工具消失）', () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    agent.promoteZen('user')
    assert.equal(agent.zenController.isZen, false)
    const names = agent.getActiveToolNames()
    assert.ok(!names.includes('zen_unlock'), `full 面不得含 zen_unlock，实际 ${names.join(', ')}`)
    assert.ok(names.includes('edit_file'), `full 面必须含 edit_file，实际 ${names.join(', ')}`)
  })

  it('⑮ zen 下幻觉调用未注册工具：不晋升，但报错附 zen_unlock 行动指引', async () => {
    const session = new SessionContext()
    const collected: Array<{ name: string; content: string }> = []
    const callbacks = {
      ...makeCallbacks(),
      onToolResult: (_id: string, name: string, content: string) => {
        collected.push({ name, content })
      },
    }

    const agent = new AgentLoop(
      {
        client: zenClient([makeToolUseBlock('t1', 'warp_tool', {})]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig()),
      },
      session,
      TEST_CWD,
    )

    await agent.run('用 warp_tool 处理一下\n这是多行任务请求', callbacks)

    assert.equal(agent.zenController.isZen, true, '未注册工具是幻觉调用，不得晋升')
    const result = collected.find(r => r.name === 'warp_tool')
    assert.ok(result, 'warp_tool 必须返回 tool_result')
    assert.ok(result.content.includes('zen_unlock'), `报错必须给解锁出路，实际：${result.content}`)
    assert.ok(result.content.includes('warp_tool'), `报错必须点名工具，实际：${result.content}`)
  })

  it('⑯ onZenPhaseChange：run 开始补发构造期 arm 的 zen 镜像', async () => {
    const session = new SessionContext()
    const events: Array<{ phase: string; reason?: string; stats?: { armed: boolean; zenTurns: number } }> = []
    const callbacks = {
      ...makeCallbacks(),
      onZenPhaseChange: (phase: 'zen' | 'full', reason?: string, stats?: { armed: boolean; zenTurns: number }) => {
        events.push({ phase, reason, stats })
      },
    }

    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    await agent.run('这是一个多行任务请求\n读一下代码再动手', callbacks)

    assert.ok(events.length >= 1, 'run 开始必须补发 zen 相位事件')
    assert.equal(events[0]!.phase, 'zen')
    assert.equal(events[0]!.stats?.armed, true)
    assert.equal(events[0]!.stats?.zenTurns, 0, 'run 开始事件在 turn 边界 tick 前发出')
    assert.equal(agent.zenController.isZen, true)
  })
})

// 清理临时目录（node:test 的 after 钩子）。Windows 上句柄释放与 rm 存在竞态，
// 同步 rmSync 会 EPERM（POSIX 删除不受打开句柄限制，故 CI 不可见）——异步
// 重试的等待窗口推进事件循环，句柄释放后即删成功。
import { after } from 'node:test'
after(async () => {
  await rm(TEST_CWD, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

  it('⑰ zen 未配置 / disabled 时工具面与无 zen 版本逐项一致（opt-in 零行为面哨兵）', () => {
    const names = (zen: ResolvedZenConfig | undefined) => new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(zen) },
      new SessionContext(),
      TEST_CWD,
    ).getActiveToolNames()

    const noZenField = names(undefined)
    assert.deepEqual(names(resolveZenConfig(undefined)), noZenField, '未配置 → 默认关：工具面必须与不带 zen 字段逐项一致')
    assert.deepEqual(names(makeZenConfig({ enabled: false })), noZenField, 'enabled:false 同样零行为面')
    // 哨兵有效性：无 zen 版本本身必须是全量面（否则上面的 deepEqual 是"空对空"）
    assert.ok(noZenField.includes('edit_file') && noZenField.includes('bash'), `基线应为全量面，实际 ${noZenField.join(', ')}`)
    assert.ok(!noZenField.includes('zen_unlock'), 'zen 未启用时不得出现 zen_unlock')
  })

  it('⑱ onZenPhaseChange 回调抛异常不得让会话假死（run 补发曾在 try 保护网之外）', async () => {
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: makeEngine(), toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )
    const exploding = {
      ...makeCallbacks(),
      onZenPhaseChange: () => { throw new Error('sse append failed') },
    }

    // 历史缺陷：run() 的相位补发在 try 之外，且 emitZenPhaseEvent 没有保护——
    // 回调抛一次，run() 就 reject 而 _running 恒 true，后续输入全部
    // skipped-already-running（会话假死，只能重启进程）。
    await agent.run('了解整个项目进度', exploding)

    assert.equal(agent.isRunning(), false, '回调异常后 _running 必须复位')

    const outcome = await agent.run('继续', makeCallbacks())
    assert.equal(outcome, 'completed', `会话假死检测：第二次 run 实际返回 ${outcome}`)
  })

  it('⑲ promote 时 setZenLean 的值取自物化配置（appendixLean:false 必须传导）', () => {
    const engine = makeEngine()
    const seen: boolean[] = []
    mock.method(engine, 'setZenLean', (v: boolean) => { seen.push(v) })

    const session = new SessionContext()
    const agent = new AgentLoop(
      {
        client: zenClient([]), promptEngine: engine, toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig({ appendixLean: false })),
      },
      session,
      TEST_CWD,
    )
    agent.promoteZen('tool')

    // 行为等价性说明：这条断言在旧写法（config.zen?.appendixLean ?? true）下同样为真
    // ——ResolvedZenConfig 的字段必填，`?? true` 只在类型放宽/未物化形态下才分叉。
    // 它锁定的是「配置传导」这条链：arm（zen 相位）与 promote（full 相位）两次相位
    // 变化都必须取物化配置——前者传导 appendixLean:false（禅相位但不裁剪），后者恒
    // false（full 不裁剪）。防止未来再冒出第二个默认值真相源。
    assert.deepEqual(seen, [false, false], `两次相位变化都必须传导 appendixLean:false，实际 ${JSON.stringify(seen)}`)
  })

  it('⑳ 工具面断言打在 engine 实际持有的定义上（非 getActiveToolNames 重算路径）', () => {
    // 背景（2026-09-13 审查台账 #5）：既有工具面断言全部走 getActiveToolNames()，
    // 而它是 gatedToolDefinitions() 的现场重算——applyFace 若断成 no-op（engine 的
    // staticCtx.tools 永不更新），那些断言仍全绿，而模型实际收到的还是旧工具面。
    // 这里改读 engine 持有的字节本身（updateTools 直接替换 staticCtx.tools 引用）。
    const staticCtx = { tools: [EDIT_FILE_TOOL.definition, BASH_TOOL.definition, READ_FILE_TOOL.definition] }
    const engine = new PromptEngine({
      model: 'deepseek-v4-pro',
      maxTokens: 1024,
      staticCtx,
      volatileCtx: { cwd: TEST_CWD },
    })
    const session = new SessionContext()
    const agent = new AgentLoop(
      { client: zenClient([]), promptEngine: engine, toolRegistry: makeRegistry(), ...makeBaseConfig(makeZenConfig()) },
      session,
      TEST_CWD,
    )

    const afterArm = staticCtx.tools.map(t => t.name).sort()
    assert.deepEqual(
      afterArm,
      ['read_file', 'zen_unlock'],
      `arm 后 engine 持有的必须是读面（含 zen_unlock 解锁入口），实际 [${afterArm.join(', ')}]`,
    )

    agent.promoteZen('tool')
    const afterPromote = staticCtx.tools.map(t => t.name).sort()
    assert.ok(
      afterPromote.includes('edit_file') && afterPromote.includes('bash'),
      `promote 后 engine 持有的必须恢复全量，实际 [${afterPromote.join(', ')}]`,
    )
    assert.ok(!afterPromote.includes('zen_unlock'), 'promote 后 zen_unlock 必须从工具面消失')
  })

  it('㉑ zen_unlock 的结果必须带终态标记（isError=false）——缺参会让 UI 永久占用 live 卡', async () => {
    // 缺参后果（真实用户报告「禅解除提示一直挂在推理区下面」）：
    // TUI 的 handleToolResult 把 isError===undefined 解释为「流式中间更新」→ 结果
    // 累积进 live 工具卡等待终态；而 zen_unlock 是虚拟工具（无 registry 执行），
    // 永远不会再有回调 → 那张卡永久悬停、永不消失。
    const session = new SessionContext()
    const agent = new AgentLoop(
      {
        client: zenClient([makeToolUseBlock('t1', 'zen_unlock', { intent: '准备动手' })]),
        promptEngine: makeEngine(),
        toolRegistry: makeRegistry(),
        ...makeBaseConfig(makeZenConfig()),
      },
      session,
      TEST_CWD,
    )
    const isErrorLog: Array<{ name: string; isError?: boolean }> = []
    await agent.run('准备动手改代码\n先解锁全量工具', makeCallbacks({ toolResults: [], isErrorLog }))

    const unlock = isErrorLog.find(e => e.name === 'zen_unlock')
    assert.ok(unlock, 'zen_unlock 必须有结果回调')
    assert.equal(
      unlock.isError,
      false,
      'zen_unlock 的结果必须标终态（undefined 会被 UI 当成流式更新 → 永久占用 live 卡）',
    )
  })
