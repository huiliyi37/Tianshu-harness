import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { GoalTracker, GOAL_ROLLOVER_REASON } from '../goal-tracker.js'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'

test('real agent loop finalizes after a tool batch at the rollover threshold', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-loop-rollover-'))
  t.after(async () => {
    // Windows：句柄释放竞态（EPERM）——异步重试等待期间推进事件循环。
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  writeFileSync(join(cwd, 'evidence.md'), 'evidence')
  const session = new SessionContext()
  session.getEstimatedTokens = () => 60_000
  let calls = 0
  const client = { stream: async (_req: unknown, cb: StreamCallbacks) => {
    calls++
    cb.onTextDelta('Reading evidence')
    cb.onContentBlock({ type: 'tool_use', id: `read_${calls}`, name: 'read_file', input: { file_path: join(cwd, 'evidence.md') } })
    cb.onStopReason('tool_use', { input_tokens: 60_000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  } } as unknown as StreamClient
  const registry = new ToolRegistry(); registry.register(READ_FILE_TOOL)
  const agent = new AgentLoop({ client, promptEngine: new PromptEngine({ model: 'deepseek-v4-pro', maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] }, volatileCtx: { cwd } }),
    toolRegistry: registry, maxTurns: 3, contextWindow: 100_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, cwd)
  const goal = new GoalTracker({ goal: 'migrate files', maxIterations: 20, contextWindow: 100_000,
    rollover: { ratio: .5, maxSessions: 3, generation: 1 } })
  agent.setGoalTracker(goal)
  let finals = 0
  await agent.run('read evidence and continue', {
    onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {},
    onTurnComplete(_usage, final) { if (final) finals++ },
    onError(error) { throw error }, onAbort() {}, onApprovalRequired: async () => false,
  })
  assert.equal(calls, 1, 'the caller must stop after the tool batch, before another API request')
  assert.equal(goal.getStatus(), 'paused')
  assert.equal(goal.getTerminalReason(), GOAL_ROLLOVER_REASON)
  assert.equal(finals, 1)
})
