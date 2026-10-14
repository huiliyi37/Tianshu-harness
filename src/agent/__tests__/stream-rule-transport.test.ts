import { after, before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'
import type { ToolDefinition } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { AgentLoop } from '../loop.js'
import { TurnStreamController, type StreamRule } from '../turn-stream.js'

const fixtureUrl = 'https://stream-rule.fixture.test/v1'
const model = 'deepseek-custom-flash'
const temporaryReasoning = 'Inspect the fixture schema before choosing a command.\n'
const bashDefinition: ToolDefinition = {
  name: 'bash', description: 'Run a fixture command',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}
let fixtureRoot: string
const previousHome = process.env.RIVET_HOME
const previousSessions = process.env.RIVET_SESSION_DIR

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'rivet-stream-rule-transport-'))
  process.env.RIVET_HOME = join(fixtureRoot, 'home')
  process.env.RIVET_SESSION_DIR = join(fixtureRoot, 'sessions')
  mkdirSync(process.env.RIVET_HOME, { recursive: true })
  writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
})

after(() => {
  if (previousHome === undefined) delete process.env.RIVET_HOME
  else process.env.RIVET_HOME = previousHome
  if (previousSessions === undefined) delete process.env.RIVET_SESSION_DIR
  else process.env.RIVET_SESSION_DIR = previousSessions
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function createClient() {
  return createProviderClient({
    name: 'deepseek', baseUrl: fixtureUrl, protocol: 'openai', thinking: 'enabled',
    capabilities: resolveCapabilities('deepseek'),
    maxTokens: 4096, models: [{ id: model, contextWindow: 1_000_000, maxTokens: 4096 }],
    unsupported: [], maxRetries: 2,
    retry: {
      backoff: { baseDelayMs: 1, jitterRatio: 0 },
      overrides: {
        unknown: { maxRetries: 2, retryDelayMs: 1 },
        timeout: { maxRetries: 1, retryDelayMs: 1 },
        stream_parse: { maxRetries: 1, retryDelayMs: 1 },
        reasoning_repetition: { maxRetries: 1, retryDelayMs: 1 },
      },
    },
  }, resolveCapabilities('deepseek'), { apiKey: 'fixture', model, maxTokens: 4096 })
}

function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

function response(payload: string): Response {
  return new Response(payload + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}

function ruleResponse(command: string): Response {
  const args = JSON.stringify({ command })
  const splitAt = Math.floor(args.length / 2)
  return response(frame({ reasoning_content: temporaryReasoning })
    + frame({ tool_calls: [{ index: 0, id: 'blocked-command', type: 'function',
      function: { name: 'bash', arguments: args.slice(0, splitAt) } }] })
    + frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(splitAt) } }] }, 'tool_calls'))
}

function captureFetch(context: TestContext, reply: (attempt: number) => Response | Promise<Response>) {
  const bodies: Array<{ messages: OaiMessage[]; tools: unknown[] }> = []
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `${fixtureUrl}/chat/completions`)
    assert.equal(init?.method, 'POST')
    assert.equal(typeof init?.body, 'string')
    bodies.push(JSON.parse(String(init!.body)))
    return reply(bodies.length)
  })
  return bodies
}

function createController(client: ReturnType<typeof createClient>) {
  let streamedText = ''
  let prewarmAt = 0
  return new TurnStreamController({
    client, getAbortSignal: () => new AbortController().signal,
    getStreamedTextLength: () => streamedText.length,
    appendStreamedText: text => { streamedText += text },
    truncateStreamedText: length => { streamedText = streamedText.slice(0, length) },
    getLastPrewarmAt: () => prewarmAt,
    setLastPrewarmAt: position => { prewarmAt = position },
    maybePrewarm() {}, addUsage() {}, recordTurnCache() {},
  })
}

const ruleCases: Array<{ name: string; command: string; rule: StreamRule; custom?: boolean }> = [
  { name: 'built-in', command: 'psql -c "DROP TABLE fixture_users;"',
    rule: { pattern: 'DROP\\s+TABLE', inject: 'STOP: Do not execute DROP TABLE without explicit user confirmation. This is irreversible.' } },
  { name: 'configured', command: 'psql -c "DROP INDEX fixture_index;"', custom: true,
    rule: { pattern: 'DROP\\s+INDEX', inject: 'STOP: Do not drop the fixture index.' } },
]

for (const fixture of ruleCases) {
  test(`${fixture.name} rule returns from the real provider after one send and accepts an append-only correction`, async context => {
    const bodies = captureFetch(context, attempt => attempt === 1
      ? ruleResponse(fixture.command) : response(frame({ content: 'Safe response.' }, 'stop')))
    const client = createClient()
    assert.equal(client.getExecutionPolicy?.().singleAttempt, false)
    const controller = createController(client)
    const messages: OaiMessage[] = [
      { role: 'system', content: 'Inspect the fixture without destructive commands.' },
      { role: 'user', content: 'Review the schema.' },
    ]
    const request: OaiChatRequest = { model, messages, max_tokens: 4096, prefixProbe: true,
      tools: [{ type: 'function', function: { name: 'bash', description: bashDefinition.description,
        parameters: bashDefinition.input_schema! } }] }
    const originalMessages = structuredClone(messages)
    const thinking: string[] = []
    const notifiedTools: string[] = []
    const errors: Error[] = []
    const callbacks = {
      onTextDelta() {}, onThinkingDelta: (delta: string) => { thinking.push(delta) },
      onToolUse: (id: string) => { notifiedTools.push(id) }, onError: (error: Error) => { errors.push(error) },
    }
    const result = await controller.streamTurn({ request, turn: 0, lastTurnTextFingerprint: '', callbacks,
      streamRules: fixture.custom ? [fixture.rule] : undefined })

    assert.equal(bodies.length, 1, 'a local safety interruption must not cause provider retries')
    assert.deepEqual(result.triggeredRule, fixture.rule)
    assert.equal(result.streamError, null)
    assert.deepEqual(thinking, [temporaryReasoning], 'the fixture must pass through real reasoning deltas')
    assert.deepEqual(notifiedTools, [], 'blocked commands must not emit actionable tool notifications')
    assert.deepEqual(errors.map(error => error.name), [])
    assert.deepEqual(request.messages, originalMessages)
    assert.equal(client.getMainPrefixProof?.()?.messages.length, bodies[0]!.messages.length)

    const reminder = `<system-reminder>\n${result.triggeredRule!.inject}\n</system-reminder>`
    const next = await controller.streamTurn({
      request: { ...request, messages: [...messages, { role: 'user', content: reminder }] },
      turn: 1, lastTurnTextFingerprint: '', callbacks,
    })
    assert.equal(bodies.length, 2, 'the corrected next turn must reach HTTP normally')
    assert.equal(next.streamError, null)
    assert.equal(next.triggeredRule, undefined)
    assert.equal(next.stopReason, 'end_turn')
    assert.deepEqual(bodies[1]!.messages.slice(0, bodies[0]!.messages.length), bodies[0]!.messages)
    assert.deepEqual(bodies[1]!.messages.at(-1), { role: 'user', content: reminder })
    assert.ok(!JSON.stringify(bodies[1]).includes(temporaryReasoning.trim()))
    assert.deepEqual(notifiedTools, [])
  })
}

test('the main loop injects the matched rule before sending again and never executes or announces the blocked command', async context => {
  const fixture = ruleCases[0]!
  const bodies = captureFetch(context, attempt => attempt === 1
    ? ruleResponse(fixture.command) : response(frame({ content: 'The destructive command was not run.' }, 'stop')))
  const session = new SessionContext()
  const registry = new ToolRegistry()
  const executed: string[] = []
  registry.register({
    definition: bashDefinition,
    execute: async params => { executed.push(String(params.input.command)); return { content: 'fixture execution', isError: false } },
    requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true,
  })
  const client = createClient()
  const agent = new AgentLoop({
    client, providerName: 'deepseek', toolRegistry: registry, headless: true,
    maxTurns: 4, contextWindow: 1_000_000,
    agentReconnect: { enabled: true, maxAttempts: 1, backoffMs: 1 },
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    promptEngine: new PromptEngine({ model, maxTokens: 4096,
      staticCtx: { tools: [bashDefinition] }, volatileCtx: { cwd: fixtureRoot } }),
  }, session, fixtureRoot)
  const notifiedTools: string[] = []
  const errors: Error[] = []
  const correctedAt: number[] = []
  const thinking: string[] = []
  let completed = false
  try {
    await agent.run('Review the fixture schema without destructive changes.', {
      onTextDelta() {}, onThinkingDelta: delta => { thinking.push(delta) },
      onToolUse: id => { notifiedTools.push(id) }, onToolResult() {},
      onTurnComplete: (_usage, _turn, final) => {
        if (final) completed = true
        else if (session.getMessages().some(message => message.role === 'user'
          && typeof message.content === 'string' && message.content.includes(fixture.rule.inject))) correctedAt.push(bodies.length)
      },
      onError: error => { errors.push(error) }, onAbort: () => assert.fail('the local rule must not abort the run'),
      onApprovalRequired: async () => assert.fail('the blocked tool must not request approval'),
    })
    assert.deepEqual(errors.map(error => error.name), [])
    assert.deepEqual(correctedAt, [1], 'the rule must return to the main loop before any provider retry')
    assert.equal(bodies.length, 2)
    assert.equal(completed, true)
    assert.deepEqual(thinking, [temporaryReasoning])
    assert.deepEqual(executed, [])
    assert.deepEqual(notifiedTools, [])
    assert.deepEqual(bodies[1]!.messages.slice(0, bodies[0]!.messages.length), bodies[0]!.messages)
    assert.match(String(bodies[1]!.messages.at(-1)?.content), /<system-reminder>/)
    assert.ok(String(bodies[1]!.messages.at(-1)?.content).includes(fixture.rule.inject))
    assert.ok(!JSON.stringify(bodies[1]).includes(temporaryReasoning.trim()))
    assert.ok(!JSON.stringify(session.getMessages()).includes('blocked-command'))
  } finally {
    agent.stopFsWatcher()
    agent.stopConfigWatcher()
  }
})

for (const kind of ['network', 'reasoning repetition'] as const) {
  test(`real provider ${kind} failures still retry and recover`, async context => {
    const bodies = captureFetch(context, attempt => {
      if (attempt === 1) {
        if (kind === 'network') throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })
        return response(frame({ reasoning_content: '好。\n'.repeat(300) }))
      }
      return response(frame({ reasoning_content: 'A different, healthy reasoning path.\n' })
        + frame({ content: 'Recovered.' }, 'stop'))
    })
    const controller = createController(createClient())
    const result = await controller.streamTurn({
      request: { model, max_tokens: 4096, prefixProbe: true, messages: [{ role: 'user', content: 'Review the fixture.' }] },
      turn: 0, lastTurnTextFingerprint: '',
      callbacks: { onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onError() {} },
    })
    assert.equal(bodies.length, 2, 'transport and degenerate-reasoning failures must retain their retry paths')
    assert.equal(result.streamError, null)
    assert.equal(result.triggeredRule, undefined)
    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(result.collectedBlocks.filter(block => block.type === 'text'), [{ type: 'text', text: 'Recovered.' }])
    if (kind === 'reasoning repetition') {
      assert.match(String(bodies[1]!.messages.at(-1)?.content), /reasoning-repeat/)
      assert.ok(!JSON.stringify(bodies[1]).includes('好。'))
    }
  })
}
