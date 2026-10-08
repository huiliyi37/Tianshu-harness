import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { setImmediate as tick } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { AgentCallbacks, ApprovalMode, AutonomyCheckpointInfo } from '../loop-types.js'
import { buildProgressDigest } from '../loop-factory.js'
import { StigmergyStore } from '../../context/stigmergy.js'

// C3 (Auto 模式检查点): in auto-safe mode the run pauses after
// `checkpointEveryTurns` turns with a progress digest. YOLO and manual
// modes are unaffected (YOLO runs uninterrupted; manual brakes via approvals).

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-autonomy-cp-'))
writeFileSync(join(TEST_CWD, 'f.txt'), 'hello')

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** Emits a read_file tool_use for `toolTurns` calls, then a final text turn. */
function makeToolClient(toolTurns: number): StreamClient & { calls: () => number } {
  let callCount = 0
  return {
    calls: () => callCount,
    stream: async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      callCount++
      if (callCount <= toolTurns) {
        cb.onContentBlock({ type: 'tool_use', id: `tu_${callCount}`, name: 'read_file', input: { file_path: join(TEST_CWD, 'f.txt') } })
        cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
      } else {
        cb.onTextDelta('done')
        cb.onContentBlock({ type: 'text', text: 'done' })
        cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
      }
    },
  } as unknown as StreamClient & { calls: () => number }
}

function makeCallbacks(checkpoints: AutonomyCheckpointInfo[]): AgentCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => true,
    onAutonomyCheckpoint: (info) => { checkpoints.push(info) },
  }
}

function makeAgent(client: StreamClient, opts: {
  checkpointEveryTurns?: number
  approvalMode?: ApprovalMode
  stigmergyStore?: StigmergyStore
}): AgentLoop {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 20,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    ...(opts.checkpointEveryTurns !== undefined ? { checkpointEveryTurns: opts.checkpointEveryTurns } : {}),
    ...(opts.approvalMode ? { approvalMode: opts.approvalMode } : {}),
    ...(opts.stigmergyStore ? { stigmergyStore: opts.stigmergyStore } : {}),
  }, new SessionContext(), TEST_CWD)
}

describe('TurnOrchestrator: autonomy checkpoint (C3)', () => {
  it('autonomous mode (cruise) pauses after checkpointEveryTurns turns', async () => {
    const client = makeToolClient(10) // would run 11 turns unchecked
    const checkpoints: AutonomyCheckpointInfo[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 3, approvalMode: 'auto-safe' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 3, 'run must stop after 3 turns at the checkpoint')
    assert.equal(checkpoints.length, 1, 'onAutonomyCheckpoint fires once')
    assert.equal(checkpoints[0]!.turns, 3)
    assert.equal(checkpoints[0]!.paused, true, 'cruise checkpoint is a pause')
  })

  it('cruise checkpoint digest includes files and token usage', async () => {
    const client = makeToolClient(10)
    const checkpoints: AutonomyCheckpointInfo[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 3, approvalMode: 'auto-safe' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    const digest = checkpoints[0]!.digest
    assert.match(digest, /已执行 3 轮/, 'digest reports the turn count')
    assert.match(digest, /最近工具：.*read_file/, 'digest lists recent tool activity')
    assert.match(digest, /Token：输入/, 'digest reports token usage')
  })

  it('yolo mode runs without any checkpoint (approvalMode=dangerously-skip-permissions)', async () => {
    const client = makeToolClient(7)
    const checkpoints: AutonomyCheckpointInfo[] = []
    const agent = makeAgent(client, {
      checkpointEveryTurns: 3,
      approvalMode: 'dangerously-skip-permissions',
    })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 8, 'yolo run proceeds to its natural finish')
    assert.equal(checkpoints.length, 0, 'yolo does not emit any checkpoint callbacks')
  })

  it('supervised/manual mode ignores the checkpoint', async () => {
    const client = makeToolClient(5)
    const checkpoints: AutonomyCheckpointInfo[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 3, approvalMode: 'manual' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 6, 'manual run proceeds to its natural finish')
    assert.deepEqual(checkpoints, [], 'no checkpoint event outside auto-safe mode')
  })

  it('checkpointEveryTurns=0 disables the brake in autonomous mode', async () => {
    const client = makeToolClient(5)
    const checkpoints: AutonomyCheckpointInfo[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 0, approvalMode: 'auto-safe' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 6)
    assert.deepEqual(checkpoints, [])
  })

  it('buildProgressDigest formats files, tools, todos and usage', () => {
    const digest = buildProgressDigest({
      turns: 25,
      filesModified: ['src/a.ts', 'src/b.ts'],
      recentTools: [
        { tool: 'edit_file', target: 'src/a.ts', status: 'success' },
        { tool: 'bash', target: 'npm test', status: 'failed' },
      ],
      usage: { input_tokens: 123_400, output_tokens: 950 },
      todos: [
        { content: '任务一', status: 'completed' },
        { content: '任务二', status: 'in_progress' },
        { content: '任务三', status: 'pending' },
      ],
    })

    assert.match(digest, /已执行 25 轮/)
    assert.match(digest, /修改文件 \(2\)：src\/a\.ts, src\/b\.ts/)
    assert.match(digest, /edit_file src\/a\.ts ✓/)
    assert.match(digest, /bash npm test ✗/)
    assert.match(digest, /任务进度：1\/3 完成，进行中：任务二/)
    assert.match(digest, /Token：输入 123\.4k \/ 输出 950/)
  })

  it('buildProgressDigest caps the modified-file list at 8', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
    const digest = buildProgressDigest({
      turns: 5,
      filesModified: files,
      recentTools: [],
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    assert.match(digest, /修改文件 \(12\)：/)
    assert.match(digest, /\(\+4 more\)/)
  })

  it('buildProgressDigest handles an empty run gracefully', () => {
    const digest = buildProgressDigest({
      turns: 3,
      filesModified: [],
      recentTools: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    assert.match(digest, /修改文件：无/)
    assert.ok(!digest.includes('最近工具'), 'no tool line when history is empty')
    assert.ok(!digest.includes('任务进度'), 'no todo line when todos are absent')
  })

  it('auto-safe mode pauses at checkpoint interval', async () => {
    const client = makeToolClient(10)
    const checkpoints: AutonomyCheckpointInfo[] = []
    const agent = makeAgent(client, { checkpointEveryTurns: 4, approvalMode: 'auto-safe' })

    await agent.run('read the file repeatedly', makeCallbacks(checkpoints))

    assert.equal(client.calls(), 4, 'run paused at checkpoint, did not finish all turns')
    assert.equal(checkpoints.length, 1, 'checkpoint fired after interval')
    assert.equal(checkpoints[0]!.turns, 4)
    assert.equal(checkpoints[0]!.paused, true)
    assert.ok(checkpoints[0]!.digest.includes('已执行'), 'digest was generated')
  })
})

it('Agent persistence drain waits for accepted pheromones before settling', async () => {
  const path = join(TEST_CWD, 'drained-pheromones.json'), store = new StigmergyStore(path)
  const agent = makeAgent(makeToolClient(0), { stigmergyStore: store })
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = promises.rename
  let settled = false
  promises.rename = async (source, target) => {
    if (target === path) { entered(); await gate }
    return original(source, target)
  }
  syncBuiltinESMExports()
  let drain: Promise<void> | undefined
  try {
    await store.deposit({ path: 'accepted.ts', signal: 'entry-point', strength: 0.4 })
    drain = agent.drainPersistWrites().then(() => { settled = true })
    await started; await tick()
    assert.equal(settled, false, 'Agent drain cannot return while pheromone publication is in flight')
    release(); await drain
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].path, 'accepted.ts')
  } finally {
    release(); await drain; await store.flush()
    promises.rename = original; syncBuiltinESMExports()
  }
})

it('最后一个可用轮注入「最终轮」警告(轮次预算硬预警,其余轮不注入)', async () => {
  const seenTexts: string[] = []
  let callCount = 0
  const client = {
    stream: async (req: { messages?: unknown }, cb: StreamCallbacks) => {
      callCount++
      seenTexts.push(JSON.stringify(req?.messages ?? []))
      cb.onContentBlock({ type: 'tool_use', id: `tu_${callCount}`, name: 'read_file', input: { file_path: join(TEST_CWD, 'f.txt') } })
      cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
    },
  } as unknown as StreamClient
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  const agent = new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), TEST_CWD)

  await agent.run('keep reading the file', makeCallbacks([]))

  assert.equal(callCount, 3, '用尽全部 3 轮')
  assert.ok(!seenTexts[0]!.includes('FINAL turn'), '第 1 轮不注入')
  assert.ok(!seenTexts[1]!.includes('FINAL turn'), '第 2 轮不注入')
  assert.ok(seenTexts[2]!.includes('FINAL turn'), '最后一个可用轮注入「最终轮」警告')
  assert.ok(seenTexts[2]!.includes('WorkerResult JSON'), '警告含 worker 契约提示')
})
