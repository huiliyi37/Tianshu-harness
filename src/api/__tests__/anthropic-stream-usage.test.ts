import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicClient } from '../anthropic-client.js'
import type { Usage } from '../types.js'
import { aggregateUsageRows } from '../../cache/usage-aggregator.js'

function assertCompleteUsage(usage: Partial<Usage>): asserts usage is Usage {
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    assert.equal(typeof usage[field], 'number', `${field} must be reported`)
  }
}

async function streamUsage(start: Record<string, unknown>, deltas: Record<string, unknown>[]): Promise<Usage> {
  const events = [
    { type: 'message_start', message: { usage: start } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    ...deltas.map(usage => ({ type: 'message_delta', usage })),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  const originalFetch = globalThis.fetch
  let offset = 0
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + 17))
      offset += 17
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
  try {
    const client = new AnthropicClient({
      baseUrl: 'https://relay.example.test', apiKey: 'test-key',
      model: 'deepseek-v4.1-flash', maxTokens: 128,
    })
    const stops: Partial<Usage>[] = []
    const text: string[] = []
    await client.stream({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 128 }, {
      onTextDelta: delta => text.push(delta),
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onError: error => { throw error },
      onStopReason: (reason, usage) => {
        assert.equal(reason, 'end_turn')
        stops.push(usage)
      },
    })
    assert.deepEqual(text, ['Hello'])
    assert.equal(stops.length, 1)
    const usage = stops[0]!
    assertCompleteUsage(usage)
    return usage
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('issue #468: relay final usage replaces message_start placeholders and reaches cache accounting', async () => {
  const usage = await streamUsage({ input_tokens: 17929, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, [{
    input_tokens: 161, cache_read_input_tokens: 19968, cache_creation_input_tokens: 0, output_tokens: 24,
    billing_usage: { source: 'oai_chat', semantic: 'openai', openai_usage: { prompt_tokens: 20129 } },
  }])
  assert.deepEqual(usage, { input_tokens: 20129, output_tokens: 24, cache_read_input_tokens: 19968, cache_creation_input_tokens: 0 })
  const aggregate = aggregateUsageRows([{
    t: Date.now(), model: 'deepseek-v4.1-flash', input: usage.input_tokens,
    cacheRead: usage.cache_read_input_tokens, cacheCreate: usage.cache_creation_input_tokens,
    output: usage.output_tokens, sidePath: false,
  }], { resolvePricing: () => ({ input: 4, output: 12, cacheRead: 0.4 }) })
  assert.equal(aggregate.totals.hitRate, 99.2)
  assert.ok(typeof aggregate.totals.savings === 'number')
  assert.ok(aggregate.totals.savings > 0)
})

test('official output-only deltas retain input and both cache buckets', async () => {
  assert.deepEqual(await streamUsage({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 50 }, [{ output_tokens: 24 }]), {
    input_tokens: 950, output_tokens: 24, cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
  })
})

test('repeated deltas replace cumulative counters and preserve omitted fields', async () => {
  assert.deepEqual(await streamUsage({ input_tokens: 500 }, [
    { input_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 10 },
    { input_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 150, output_tokens: 24 },
    { cache_read_input_tokens: 950 },
    { output_tokens: 25 },
  ]), { input_tokens: 1130, output_tokens: 25, cache_read_input_tokens: 950, cache_creation_input_tokens: 150 })
})

test('explicit zeros replace earlier nonzero counters', async () => {
  assert.deepEqual(await streamUsage({ input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 50, output_tokens: 10 }, [
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  ]), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
})

test('message_start output is retained when later usage omits it', async () => {
  assert.deepEqual(await streamUsage({ input_tokens: 100, output_tokens: 1 }, [{}]), {
    input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  })
})

test('missing usage fields stay zero', async () => {
  assert.deepEqual(await streamUsage({}, [{}]), {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  })
})

for (const invalid of [null, '999', -1, {}]) {
  test(`invalid usage value ${String(invalid)} cannot erase valid counters`, async () => {
    const start = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 50 }
    const bad = Object.fromEntries(Object.keys(start).map(key => [key, invalid]))
    assert.deepEqual(await streamUsage(bad, [start, bad]), {
      input_tokens: 950, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
    })
  })
}
