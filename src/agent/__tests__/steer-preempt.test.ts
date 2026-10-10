import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { GoalTracker } from '../goal-tracker.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { AgentCallbacks } from '../loop-types.js'

// C1 (自治模式刹车): mid-run user steer must take precedence over
// auto-continuation on NO-TOOL turn boundaries. Previously steer only drained
// at tool-result boundaries, so a no-tool continuation chain (goal)
// starved queued guidance while injecting its own "keep going" reminder.
// Contract:
//   1. A no-tool turn with pending steer injects the guidance as a system
//      reminder and continues — the user's words get the next turn.
//   2. That same round SKIPS the goal-continuation reminder entirely
//      (no [GOAL CONTINUATION] injected alongside the user's words).

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-steer-preempt-'))

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** Text-only client: emits `texts[i]` on call i, then repeats the last one. */
function makeTextClient(texts: string[]): StreamClient & { calls: () => number } {
  let callCount = 0
  return {
    calls: () => callCount,
    stream: async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      const text = texts[Math.min(callCount, texts.length - 1)]!
      callCount++
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 20 })
    },
  } as unknown as StreamClient & { calls: () => number }
}

function makeCallbacks(steerQueue: string[]): AgentCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onSteerDrain: () => steerQueue.shift() ?? null,
  }
}

function makeAgent(client: StreamClient, session: SessionContext): AgentLoop {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 10,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, TEST_CWD)
}

describe('TurnOrchestrator: steer preempts no-tool auto-continuation (C1)', () => {
  it('a no-tool turn with pending steer injects the guidance and continues another turn', async () => {
    const client = makeTextClient(['part one of the answer', 'done, adjusted per your guidance'])
    const session = new SessionContext()
    const agent = makeAgent(client, session)

    await agent.run('do the thing', makeCallbacks(['[User guidance — 优先]: change direction please']))

    assert.equal(client.calls(), 2, 'pending steer must force one more turn instead of finishing')
    const injected = session.getMessages().filter(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('change direction please'))
    assert.equal(injected.length, 1, 'steer text must be injected exactly once as a reminder message')
  })

  it('without pending steer the run finishes on the first no-tool turn (baseline)', async () => {
    const client = makeTextClient(['all done'])
    const session = new SessionContext()
    const agent = makeAgent(client, session)

    await agent.run('do the thing', makeCallbacks([]))

    assert.equal(client.calls(), 1, 'no steer → natural finish, no extra turn')
  })

  it('the steer round skips the GOAL CONTINUATION reminder — user words own the next turn', async () => {
    const client = makeTextClient(['working on it', 'GOAL ACHIEVED — wrapped up per your correction'])
    const session = new SessionContext()
    const agent = makeAgent(client, session)
    agent.setGoalTracker(new GoalTracker({
      goal: 'demo goal', maxIterations: 5, contextWindow: 1_000_000,
    }))

    await agent.run('pursue the goal', makeCallbacks(['stop — do it differently']))

    assert.equal(client.calls(), 2)
    const messages = session.getMessages()
    const steerIdx = messages.findIndex(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('stop — do it differently'))
    assert.ok(steerIdx >= 0, 'steer guidance must be injected')
    const goalReminders = messages.filter(m =>
      typeof m.content === 'string' && m.content.includes('[GOAL CONTINUATION'))
    assert.equal(goalReminders.length, 0,
      'the steer round must NOT also inject a goal-continuation reminder')
  })
})

it('trusted human guidance is acknowledged after no-tool history append and legacy worker reminders never reset the course', async () => {
  for (const human of [true, false]) {
    const client = makeTextClient(['working', 'done'])
    const session = new SessionContext()
    const agent = makeAgent(client, session)
    const callbacks = makeCallbacks(human ? [] : ['[User guidance] worker soft-landing'])
    let pending = human
    if (human) callbacks.onHumanGuidanceDrain = () => { if (!pending) return null; pending = false; return { origin: 'human', inputSequence: 1, text: '改为先检查用例' } }
    await agent.run('修复内存泄漏', callbacks)
    assert.equal(agent.advisoryReadback.courseEpisode, human ? 2 : 1)
    if (human) assert.ok(session.getMessages().some(m => typeof m.content === 'string' && m.content.includes('改为先检查用例')))
  }
})
