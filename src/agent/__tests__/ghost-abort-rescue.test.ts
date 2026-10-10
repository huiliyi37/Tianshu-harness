import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'tianshu-ghost-abort-'))

function createTestLoop(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: TEST_CWD },
  })
  return new AgentLoop(
    {
      client: { stream: async () => {} } as any,
      promptEngine: engine,
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 100_000,
      compact: { enabled: false, autoThreshold: 80_000, autoFloor: 50_000, model: 'flash' },
    },
    new SessionContext(),
    TEST_CWD,
  )
}

describe('Watchdog ghost abort rescue lifecycle (#430, #431)', () => {
  it('clearWatchdogAbort clears watchdog state and resets abortController', () => {
    const loop = createTestLoop()
    ;(loop as any).abortController = new AbortController()

    // Trigger watchdog stall abort
    loop.abortStalledTurn()
    assert.equal((loop as any)._watchdogAborted, true)
    assert.equal((loop as any).abortController.signal.aborted, true)
    assert.equal(loop.isPendingAbort(), false)

    // Ghost abort rescue: watchdog was false positive
    loop.clearWatchdogAbort()
    assert.equal((loop as any)._watchdogAborted, false)
    assert.equal((loop as any).abortController.signal.aborted, false, 'signal must be fresh so next turn is not rejected')
  })

  it('clearWatchdogAbort respects user pending abort (fail-closed for Esc)', () => {
    const loop = createTestLoop()
    ;(loop as any).abortController = new AbortController()

    // User aborts explicitly
    loop.abort()
    assert.equal(loop.isPendingAbort(), true)

    // Even if watchdog flag was set, rescue must NOT un-abort a user abort
    ;(loop as any)._watchdogAborted = true
    loop.clearWatchdogAbort()
    assert.equal((loop as any).abortController.signal.aborted, true, 'user Esc must remain aborted')
  })
})

