import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RequestContextController } from '../request-context-controller.js'
import { SessionContext } from '../context.js'
import { buildContextBudget } from '../../context/request-budget.js'
import type { AgentLoop } from '../loop.js'
import type { OaiMessage } from '../../api/oai-types.js'

const budget = buildContextBudget({ model: 'deepseek-flash', messages: [], max_tokens: 256_000 },
  { windowTokens: 1_000_000, maxOutputTokens: 393_216 }, { requestId: 'r', revision: 1 })

test('a failed small reclaim does not resummarize on every tool round', async () => {
  let calls = 0, events = 0
  const messages: OaiMessage[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(1_800_000) },
    { role: 'user', content: 'active' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: '<system-reminder>note</system-reminder>' }, { role: 'assistant', content: 'answer' }]
  const session = new SessionContext()
  session.replaceMessages(messages)
  const recordCompactEvent = session.recordCompactEvent.bind(session)
  session.recordCompactEvent = event => { events++; recordCompactEvent(event) }
  const fake = {
    persist: {}, artifactStore: {}, config: { client: { stream: async () => { throw new Error('execution client must stay separate') } }, budgetSummaryClient: () => ({ stream: async () => { calls++ } }), promptEngine: { getModel: () => 'deepseek-flash' } },
    session, drainPersistWrites: async () => {}, recordSidePathUsage: () => {},
  } as unknown as AgentLoop
  const controller = new RequestContextController(fake)
  controller.record({ ...budget, inputTokens: 600_000 })
  assert.equal(await controller.compact(), false)
  controller.record({ ...budget, inputTokens: 600_010 })
  assert.equal(await controller.compact(), false)
  assert.equal(calls, 0, 'ordinary quality pressure cannot invoke summarization')
  assert.equal(events, 0)
  await controller.compact(true)
  assert.equal(calls, 1, 'explicit user compaction may invoke one summary')
  assert.equal(events, 1)
})

test('late measured observations cannot replace a newer request budget', () => {
  const controller = new RequestContextController({} as AgentLoop)
  controller.record({ ...budget, requestId: 'new' })
  assert.equal(controller.record({ ...budget, requestId: 'old', source: 'measured', inputTokens: 900_000 }).requestId, 'new')
  assert.equal(controller.record({ ...budget, requestId: 'old', source: 'estimate', inputTokens: 900_000 }).requestId, 'new')
  assert.equal(controller.record({ ...budget, requestId: 'next' }, true).requestId, 'next')
})

test('headless/TUI preparation records the budget even without a UI callback', async () => {
  const controller = new RequestContextController({ config: { promptEngine: { getRequestBudgetPolicy: () => ({ windowTokens: 1_000_000, maxOutputTokens: 393_216 }) } } } as unknown as AgentLoop)
  // outputReserve 现封顶到 DEEPSEEK_OUTPUT_RESERVE(256_000)，故 256_000/384_000 都落到
  // 同一 inputBudget = 1_000_000 − 256_000 − 50_000。
  await controller.prepare(() => ({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }], max_tokens: 256_000 }), {} as any)
  assert.equal(controller.snapshot?.inputBudget, 694_000)
  assert.equal(controller.snapshot?.state, 'ready')
  const previousId = controller.snapshot?.requestId
  await controller.prepare(() => ({ model: 'deepseek-flash', messages: [], max_tokens: 384_000 }), {} as any)
  assert.notEqual(controller.snapshot?.requestId, previousId)
  assert.equal(controller.snapshot?.inputBudget, 694_000)
})

test('预算闸门最终拒绝时发出 compact-blocked 相位（含可读原因）', async () => {
  const phases: Array<{ phase: string; reason?: string }> = []
  const controller = new RequestContextController({ config: { promptEngine: { getRequestBudgetPolicy: () => ({ windowTokens: 1_000_000, maxOutputTokens: 393_216 }) } } } as unknown as AgentLoop)
  await assert.rejects(
    controller.prepare(
      () => ({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x'.repeat(4_000_000) }], max_tokens: 384_000 }),
      { onPhaseChange: (phase: string, detail?: { reason?: string }) => { phases.push({ phase, reason: detail?.reason }) } } as never,
    ),
    { name: 'ContextBudgetExceededError' },
  )
  assert.equal(phases.length, 1, '最终拒绝应恰好发一次相位')
  assert.equal(phases[0]!.phase, 'compact-blocked')
  assert.ok(phases[0]!.reason && phases[0]!.reason.length > 0, '必须带可读原因')
})


const SUMMARY = JSON.stringify({ version: 1, summary: 'Archived tool output.', facts: [], requirements: [], pendingApprovals: [] })

function selfHostedAgent(enabled = true, contextWindow = 524_288) {
  const session = new SessionContext()
  session.replaceMessages([
    { role: 'user', content: 'Keep the original requirements.' },
    { role: 'assistant', content: 'x'.repeat(80_000) },
    { role: 'user', content: 'u'.repeat(900_000) },
    { role: 'assistant', content: 'recent answer' },
    { role: 'user', content: '<system-reminder>recent note</system-reminder>' },
    { role: 'assistant', content: 'latest answer' },
  ])
  const original = session.getMessages().slice(), writes: string[] = []
  const model = 'self-hosted-model'
  const fake = {
    persist: {},
    artifactStore: { saveDurable: async () => { writes.push('archive'); return 'original-history' } },
    config: {
      contextWindow, compact: { enabled },
      client: { authorizeCacheGeneration: () => {} },
      budgetSummaryClient: () => ({ stream: async (_request: unknown, cb: import('../../api/stream-client.js').StreamCallbacks) => {
        cb.onTextDelta(SUMMARY)
        cb.onStopReason('stop', { input_tokens: 1, output_tokens: 1 } as never)
      } }),
      promptEngine: {
        getRequestBudgetPolicy: () => undefined,
        getModel: () => model,
        getRewindAuthorization: () => undefined, getExecutionSnapshot: () => undefined,
        assertPublishedHistory: () => false, getPublishedUserCount: () => 0,
        buildOaiRequest: (messages: OaiMessage[]) => ({ model, max_tokens: 256_000, messages }),
        authorizeCacheGeneration: () => {}, resetAppendixBaseline: () => {},
      },
    },
    session, drainPersistWrites: async () => {}, recordSidePathUsage: () => {},
    commitBudgetHistory: async (expected: OaiMessage[], candidate: OaiMessage[]) => {
      assert.deepEqual(session.getMessages(), expected)
      assert.equal(writes.at(-1), 'archive', 'archive must be durable before changing history')
      writes.push('commit'); session.replaceMessages(candidate)
    },
  } as unknown as AgentLoop
  const controller = new RequestContextController(fake)
  Object.defineProperty(fake, 'requestContext', { value: controller })
  controller.activeUserMessage = original[2]
  const build = () => ({ model, max_tokens: 256_000, messages: session.getMessages() })
  return { controller, original, writes, build, messages: () => session.getMessages() }
}

test('self-hosted manual refresh uses the same generic budget as request preparation', () => {
  const { controller } = selfHostedAgent()
  controller.refreshSnapshot()
  assert.equal(controller.snapshot?.windowTokens, 524_288)
  assert.equal(controller.snapshot?.outputReserve, 256_000)
  assert.equal(controller.snapshot?.inputBudget, 242_073)
})

for (const enabled of [true, false]) {
  test(`self-hosted hard-budget recovery accepts a useful reclaim below 32K (discretionary enabled=${enabled})`, async () => {
    const { controller, original, writes, build, messages } = selfHostedAgent(enabled)
    const before = buildContextBudget(build(), { windowTokens: 524_288, maxOutputTokens: 524_288, transportLimits: 'none' }, { requestId: 'before', revision: 0 })
    assert.equal(before.state, 'blocked')
    assert.ok(before.inputTokens - before.inputBudget < 32_768)
    const request = await controller.prepare(build, {} as never)
    assert.equal(request.contextBudget?.state, 'warning', 'the protected active user may remain near the limit')
    assert.ok(request.contextBudget!.inputTokens <= request.contextBudget!.inputBudget, 'the rebuilt request must fit')
    assert.equal(request.max_tokens, 256_000, 'recovery must not silently lower the configured output limit')
    assert.deepEqual(writes, ['archive', 'commit'])
    for (const user of [original[0], original[2]]) {
      assert.ok(messages().some(message => JSON.stringify(message) === JSON.stringify(user)), 'human requirements survive verbatim')
    }
    assert.ok(messages().includes(controller.activeUserMessage!), 'the active boundary is rebound after the transactional rewrite')
    assert.ok(before.inputTokens - request.contextBudget!.inputTokens < 32_768)
  })
}

test('explicit self-hosted compaction works below the hard limit even if discretionary compaction is off', async () => {
  const { controller, original, writes, messages } = selfHostedAgent(false, 1_048_576)
  assert.equal(await controller.compact(true), true)
  assert.deepEqual(writes, ['archive', 'commit'])
  assert.ok(messages().some(message => JSON.stringify(message) === JSON.stringify(original[2])))
  assert.ok(messages().includes(controller.activeUserMessage!))
})
