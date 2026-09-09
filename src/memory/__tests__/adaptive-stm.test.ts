import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { adaptiveMemoryMode, resetAdaptiveMemoryState, reviewAdaptiveMemory } from '../adaptive-stm.js'
import type { KnowledgeHit } from '../knowledge-index.js'

beforeEach(() => resetAdaptiveMemoryState())

describe('adaptive STM', () => {
  it('defaults to shadow and accepts explicit rollout modes', () => {
    assert.equal(adaptiveMemoryMode(undefined), 'on')
    assert.equal(adaptiveMemoryMode('on'), 'on')
    assert.equal(adaptiveMemoryMode('1'), 'on')
    assert.equal(adaptiveMemoryMode('off'), 'off')
    assert.equal(adaptiveMemoryMode('shadow'), 'shadow')
  })

  it('keeps identical bytes for a stable intent and refreshes relevant changes', async () => {
    let hits: KnowledgeHit[] = [{ id: 'kentry:one', text: 'Never rewrite a cached historical message.', score: 1 }]
    const index = { search: async () => hits }
    const base = {
      cwd: '/project', sessionId: 'session-a', intentText: 'fix prefix cache', userInput: 'fix prefix cache',
      mode: 'on' as const, index,
    }

    const first = await reviewAdaptiveMemory({ ...base, turn: 1 })
    assert.equal(first.reason, 'initial')
    assert.match(first.block ?? '', /<cross-session-memory source="adaptive"/)

    const stable = await reviewAdaptiveMemory({ ...base, turn: 2 })
    assert.equal(stable.reason, undefined)
    assert.equal(stable.block, first.block)

    hits = [{ id: 'kentry:one', text: 'Append memory only through the context-update tail.', score: 1 }]
    const changed = await reviewAdaptiveMemory({ ...base, turn: 3 })
    assert.equal(changed.reason, 'relevant-memory')
    assert.notEqual(changed.block, first.block)
  })

  it('shadow mode selects without producing model-visible bytes', async () => {
    const result = await reviewAdaptiveMemory({
      cwd: '/project', sessionId: 'session-shadow', turn: 1,
      intentText: 'implement memory', userInput: 'implement memory', mode: 'shadow',
      index: { search: async () => [{ id: 'memory', text: 'candidate', score: 1 }] },
    })
    assert.equal(result.reason, 'initial')
    assert.equal(result.block, null)
    assert.deepEqual(result.selectedIds, ['memory'])
  })

  it('emits an explicit empty replacement when a new intent has no hits', async () => {
    let hits: KnowledgeHit[] = [{ id: 'old', text: 'old task memory', score: 1 }]
    const index = { search: async () => hits }
    await reviewAdaptiveMemory({
      cwd: '/project', sessionId: 'session-clear', turn: 1,
      intentText: 'debug cache', userInput: 'debug cache', mode: 'on', index,
    })
    hits = []
    const cleared = await reviewAdaptiveMemory({
      cwd: '/project', sessionId: 'session-clear', turn: 2,
      intentText: 'write documentation', userInput: 'write documentation', mode: 'on', index,
    })
    assert.equal(cleared.reason, 'intent-change')
    assert.match(cleared.block ?? '', /state="empty"/)
  })

  it('forces a pressure-turns re-evaluation after 8 turns without refresh', async () => {
    const hits: KnowledgeHit[] = [{ id: 'stable', text: 'stable memory text', score: 1 }]
    const index = { search: async () => hits }
    const base = {
      cwd: '/project', sessionId: 'session-pressure', turn: 1,
      intentText: 'long running task', userInput: 'long running task', mode: 'on' as const, index,
    }
    const first = await reviewAdaptiveMemory(base)
    assert.equal(first.reason, 'initial')

    // 轮 2-7：intent/实体/命中签名全未变 → 无刷新因，逐字节续用。
    for (let turn = 2; turn <= 7; turn++) {
      const reused = await reviewAdaptiveMemory({ ...base, turn })
      assert.equal(reused.reason, undefined)
      assert.equal(reused.block, first.block)
    }
    // 轮 9（1 + 8）：距上次刷新 ≥8 轮 → pressure-turns 强制重评估。
    const pressured = await reviewAdaptiveMemory({ ...base, turn: 9 })
    assert.equal(pressured.reason, 'pressure-turns')
    // 确定性渲染：重评估产物与原 block 逐字节一致（前缀缓存纪律不破）。
    assert.equal(pressured.block, first.block)
    // 刷新后 pressure 计数归零：轮 10 又回到无因续用。
    const after = await reviewAdaptiveMemory({ ...base, turn: 10 })
    assert.equal(after.reason, undefined)
  })
})
