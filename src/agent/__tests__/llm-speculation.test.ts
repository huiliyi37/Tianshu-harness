import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import type { ToolPrediction } from '../tool-pattern-miner.js'
import {
  createLlmSpeculationEngine,
  normalizeLlmSpeculationConfig,
  parseSpeculationPredictions,
  buildSpeculationInstruction,
  DEFAULT_LLM_SPECULATION_CONFIG,
} from '../llm-speculation.js'

function makeRequest(): OaiChatRequest {
  return {
    model: 'deepseek-v4',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: 'working on it' },
    ],
    max_tokens: 8192,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } }],
  }
}

interface MockCall {
  request: OaiChatRequest
  signal?: AbortSignal
}

function mockClient(text: string, opts?: { delayMs?: number; fail?: boolean; usage?: Record<string, number> }): StreamClient & { calls: MockCall[] } {
  const calls: MockCall[] = []
  return {
    calls,
    async stream(request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
      calls.push({ request, signal })
      if (opts?.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (opts?.fail) throw new Error('boom')
      callbacks.onTextDelta(text)
      if (opts?.usage) {
        // Mirror real clients: onStopReason can fire twice — first with the
        // finish_reason frame (empty usage), then with the usage frame.
        callbacks.onStopReason('end_turn', {})
        callbacks.onStopReason('end_turn', opts.usage)
      }
    },
  }
}

async function settle(engine: { inFlight(): boolean }): Promise<void> {
  const deadline = Date.now() + 2_000
  while (engine.inFlight()) {
    if (Date.now() > deadline) throw new Error('speculation did not settle')
    await new Promise(r => setTimeout(r, 5))
  }
  // one extra tick so .finally handlers run
  await new Promise(r => setTimeout(r, 5))
}

const SLOW_BATCH = [{ id: 't1', name: 'bash', input: { command: 'npm test' } }]

describe('normalizeLlmSpeculationConfig', () => {
  it('defaults to disabled', () => {
    assert.equal(normalizeLlmSpeculationConfig(undefined).enabled, false)
    assert.equal(normalizeLlmSpeculationConfig(false).enabled, false)
    assert.equal(DEFAULT_LLM_SPECULATION_CONFIG.enabled, false)
  })

  it('true enables with defaults', () => {
    const cfg = normalizeLlmSpeculationConfig(true)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.maxPerTurn, 3)
    assert.equal(cfg.slowToolsOnly, true)
  })

  it('partial object merges over defaults and sanitizes bad values', () => {
    const cfg = normalizeLlmSpeculationConfig({ enabled: true, maxPerTurn: -5, minProbability: 7, timeoutMs: 100 })
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.maxPerTurn, 3)
    assert.equal(cfg.minProbability, 0.5)
    assert.equal(cfg.timeoutMs, 100)
  })
})

describe('parseSpeculationPredictions', () => {
  it('parses a plain JSON array', () => {
    const preds = parseSpeculationPredictions(
      '[{"tool":"read_file","target":"src/a.ts","probability":0.8}]', 0.5)
    assert.equal(preds.length, 1)
    assert.equal(preds[0]?.tool, 'read_file')
    assert.equal(preds[0]?.likelyTarget, 'src/a.ts')
    assert.equal(preds[0]?.source, 'llm')
  })

  it('tolerates code fences and surrounding prose', () => {
    const text = 'Here you go:\n```json\n[{"tool":"grep","target":"foo","probability":0.9}]\n```\nDone.'
    const preds = parseSpeculationPredictions(text, 0.5)
    assert.equal(preds.length, 1)
    assert.equal(preds[0]?.tool, 'grep')
  })

  it('RED gate: write tools are never accepted', () => {
    const text = JSON.stringify([
      { tool: 'edit_file', target: 'src/a.ts', probability: 0.99 },
      { tool: 'write_file', target: 'src/b.ts', probability: 0.99 },
      { tool: 'bash', target: 'rm -rf /', probability: 0.99 },
      { tool: 'read_file', target: 'src/c.ts', probability: 0.9 },
    ])
    const preds = parseSpeculationPredictions(text, 0.5)
    assert.equal(preds.length, 1)
    assert.equal(preds[0]?.tool, 'read_file')
  })

  it('filters below minProbability and invalid probabilities', () => {
    const text = JSON.stringify([
      { tool: 'read_file', target: 'a.ts', probability: 0.3 },
      { tool: 'read_file', target: 'b.ts', probability: 1.5 },
      { tool: 'read_file', target: 'c.ts', probability: 'high' },
      { tool: 'read_file', target: '', probability: 0.9 },
      { tool: 'read_file', target: 'd.ts', probability: 0.7 },
    ])
    const preds = parseSpeculationPredictions(text, 0.5)
    assert.equal(preds.length, 1)
    assert.equal(preds[0]?.likelyTarget, 'd.ts')
  })

  it('returns empty on invalid JSON or non-array', () => {
    assert.deepEqual(parseSpeculationPredictions('not json at all', 0.5), [])
    assert.deepEqual(parseSpeculationPredictions('{"tool":"read_file"}', 0.5), [])
    assert.deepEqual(parseSpeculationPredictions('', 0.5), [])
  })

  it('caps predictions per call at 5', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ tool: 'read_file', target: `f${i}.ts`, probability: 0.9 }))
    const preds = parseSpeculationPredictions(JSON.stringify(items), 0.5)
    assert.equal(preds.length, 5)
  })
})

describe('createLlmSpeculationEngine', () => {
  it('disabled config never calls the client', async () => {
    const client = mockClient('[]')
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: false }, enqueue: () => {},
    })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)
    assert.equal(client.calls.length, 0)
    assert.equal(engine.stats().fired, 0)
  })

  it('RED gate: never mutates the original request or its messages', async () => {
    const client = mockClient('[{"tool":"read_file","target":"src/a.ts","probability":0.8}]')
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true }, enqueue: () => {},
    })
    const request = makeRequest()
    const originalMessages = request.messages
    const snapshot = JSON.stringify(request)

    engine.maybeSpeculate({ request, toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)

    // original untouched: same array reference, same length, same content
    assert.equal(request.messages, originalMessages)
    assert.equal(request.messages.length, 3)
    assert.equal(JSON.stringify(request), snapshot)

    // speculative request is a different array with the instruction appended
    const specRequest = client.calls[0]!.request
    assert.notEqual(specRequest.messages, originalMessages)
    assert.equal(specRequest.messages.length, 4)
    const last = specRequest.messages[3]!
    assert.equal(last.role, 'user')
    assert.match(last.content as string, /speculative-prefetch/)
  })

  it('speculative request shares model+tools and forces tool_choice none / small budget', async () => {
    const client = mockClient('[]')
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true, maxTokens: 200 }, enqueue: () => {},
    })
    const request = makeRequest()
    request.reasoning_effort = 'high'
    engine.maybeSpeculate({ request, toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)

    const spec = client.calls[0]!.request
    assert.equal(spec.model, 'deepseek-v4')
    assert.equal(spec.tools, request.tools)
    assert.equal(spec.tool_choice, 'none')
    assert.equal(spec.max_tokens, 200)
    assert.equal(spec.temperature, 0)
    assert.equal(spec.reasoning_effort, 'low')
    // main request's own reasoning_effort untouched
    assert.equal(request.reasoning_effort, 'high')
  })

  it('strips prefixProbe from the speculative request (2026-07-06 wire-probe poisoning)', async () => {
    const client = mockClient('[]')
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true }, enqueue: () => {},
    })
    const request = makeRequest()
    // Main-turn requests carry prefixProbe: true (engine.buildOaiRequest). The
    // spec request spreads the main request — without an explicit strip it
    // would inherit the flag, record itself into the client's wire-divergence
    // baseline, and the next main turn would report a phantom wireDiverged.
    request.prefixProbe = true
    engine.maybeSpeculate({ request, toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)

    const spec = client.calls[0]!.request
    assert.equal(spec.prefixProbe, undefined)
    // main request keeps its own flag
    assert.equal(request.prefixProbe, true)
  })

  it('stamps diagnostics.purpose=llm_speculation so call-audit never bills speculation to main_execution', async () => {
    const client = mockClient('[]')
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true }, enqueue: () => {},
    })
    // The spec request spreads the main request; without an explicit stamp it
    // would inherit undefined diagnostics and requestAuditContext would default
    // the audit row to main_execution, hiding speculation cost inside "main".
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)

    assert.equal(client.calls[0]!.request.diagnostics?.purpose, 'llm_speculation')
  })

  it('books usage via recordUsage and stamps token fields into telemetry (cost blind spot fix)', async () => {
    const usage = { input_tokens: 95_000, output_tokens: 320, cache_read_input_tokens: 94_000, cache_creation_input_tokens: 500 }
    const client = mockClient('[]', { usage })
    const recorded: Array<Record<string, unknown>> = []
    const telemetry: Array<Record<string, unknown>> = []
    const engine = createLlmSpeculationEngine({
      client,
      config: { enabled: true },
      enqueue: () => {},
      recordUsage: u => { recorded.push(u as Record<string, unknown>) },
      writeTelemetry: r => { telemetry.push(r as Record<string, unknown>) },
    })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)

    // The empty finish-frame onStopReason must be gated out — booked exactly once.
    assert.equal(recorded.length, 1)
    assert.deepEqual(recorded[0], usage)

    assert.equal(telemetry.length, 1)
    assert.equal(telemetry[0]!.inputTokens, 95_000)
    assert.equal(telemetry[0]!.cacheReadTokens, 94_000)
    assert.equal(telemetry[0]!.outputTokens, 320)
  })

  it('enqueues parsed predictions tagged with source llm', async () => {
    const client = mockClient('[{"tool":"read_file","target":"src/a.ts","probability":0.8},{"tool":"glob","target":"src/**","probability":0.6}]')
    const received: ToolPrediction[][] = []
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true }, enqueue: p => { received.push(p) },
    })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)

    assert.equal(received.length, 1)
    assert.equal(received[0]?.length, 2)
    assert.equal(received[0]?.[0]?.source, 'llm')
    assert.equal(engine.stats().enqueued, 2)
  })

  it('slow-tool gate: read-only-only batches do not fire; slowToolsOnly=false fires anyway', async () => {
    const readBatch = [{ id: 't1', name: 'read_file', input: { file_path: 'a.ts' } }]

    const client1 = mockClient('[]')
    const gated = createLlmSpeculationEngine({ client: client1, config: { enabled: true }, enqueue: () => {} })
    gated.maybeSpeculate({ request: makeRequest(), toolUses: readBatch, turn: 1 })
    await settle(gated)
    assert.equal(client1.calls.length, 0)

    const client2 = mockClient('[]')
    const open = createLlmSpeculationEngine({ client: client2, config: { enabled: true, slowToolsOnly: false }, enqueue: () => {} })
    open.maybeSpeculate({ request: makeRequest(), toolUses: readBatch, turn: 1 })
    await settle(open)
    assert.equal(client2.calls.length, 1)
  })

  it('serializes in-flight calls: second fire while first is pending is dropped', async () => {
    const client = mockClient('[]', { delayMs: 50 })
    const engine = createLlmSpeculationEngine({ client, config: { enabled: true }, enqueue: () => {} })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)
    assert.equal(client.calls.length, 1)
    assert.equal(engine.stats().fired, 1)
  })

  it('maxPerTurn caps calls within a turn and resets on a new turn', async () => {
    const client = mockClient('[]')
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true, maxPerTurn: 1 }, enqueue: () => {},
    })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)
    assert.equal(client.calls.length, 1, 'second call in same turn must be capped')

    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 2 })
    await settle(engine)
    assert.equal(client.calls.length, 2, 'new turn resets the cap')
  })

  it('stream errors are absorbed silently and recorded in stats', async () => {
    const client = mockClient('', { fail: true })
    let enqueued = 0
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true }, enqueue: () => { enqueued++ },
    })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)
    assert.equal(enqueued, 0)
    assert.equal(engine.stats().errors, 1)
  })

  it('unparseable output counts as parse failure, not error', async () => {
    const client = mockClient('sorry, I cannot predict anything right now')
    const engine = createLlmSpeculationEngine({ client, config: { enabled: true }, enqueue: () => {} })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 1 })
    await settle(engine)
    assert.equal(engine.stats().parseFailures, 1)
    assert.equal(engine.stats().errors, 0)
  })

  it('writes telemetry with outcome and latency', async () => {
    const client = mockClient('[{"tool":"read_file","target":"a.ts","probability":0.9}]')
    const records: Array<Record<string, unknown>> = []
    const engine = createLlmSpeculationEngine({
      client, config: { enabled: true }, enqueue: () => {},
      writeTelemetry: r => { records.push(r as Record<string, unknown>) },
    })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: SLOW_BATCH, turn: 7 })
    await settle(engine)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.kind, 'llm-speculation')
    assert.equal(records[0]?.turn, 7)
    assert.equal(records[0]?.outcome, 'enqueued')
  })

  it('empty tool batch does not fire', async () => {
    const client = mockClient('[]')
    const engine = createLlmSpeculationEngine({ client, config: { enabled: true }, enqueue: () => {} })
    engine.maybeSpeculate({ request: makeRequest(), toolUses: [], turn: 1 })
    await settle(engine)
    assert.equal(client.calls.length, 0)
  })
})

describe('buildSpeculationInstruction', () => {
  it('lists executing tools with target hints', () => {
    const text = buildSpeculationInstruction([
      { name: 'bash', input: { command: 'npm test' } },
      { name: 'read_file', input: { file_path: 'src/a.ts' } },
    ])
    assert.match(text, /bash\(npm test\)/)
    assert.match(text, /read_file\(src\/a\.ts\)/)
    assert.match(text, /Output ONLY a JSON array/)
  })
})
