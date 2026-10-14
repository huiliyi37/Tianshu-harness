import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { withExecutionContinuity } from '../execution-continuity.js'
import type { OaiChatRequest, OaiMessage } from '../oai-types.js'
import type { StreamCallbacks, StreamAttemptAbortedInfo } from '../stream-client.js'
import type { Usage } from '../types.js'
import type { ContinuationPrefixProof } from '../continuation-prefix.js'
import { REASONING_REPETITION_CORRECTION } from '../reasoning-repetition.js'

function makeClient() {
  const transport = new OpenAIClient({
    providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture',
    model: 'deepseek-flash', maxTokens: 2048, thinking: 'enabled', maxRetries: 2,
    preservedThinkingProtocol: true,
    retry: { backoff: { baseDelayMs: 1, jitterRatio: 0 }, overrides: { stream_parse: { maxRetries: 2, retryDelayMs: 1 } } },
  })
  return { transport, client: withExecutionContinuity(transport, { provider: 'deepseek', model: 'deepseek-flash', credentialScope: 'fixture' }) }
}

function history(count: number): OaiMessage[] {
  return Array.from({ length: count }, (_, index): OaiMessage => index === 0
    ? { role: 'system', content: 'stable system' }
    : { role: index % 2 ? 'user' : 'assistant', content: `history ${index}` })
}

function response(reasoning: string, complete: boolean): Response {
  const event = { choices: [{ delta: complete ? { content: 'answer', reasoning_content: reasoning } : { reasoning_content: reasoning }, finish_reason: complete ? 'stop' : null }] }
  return new Response(`data: ${JSON.stringify(event)}\n\n${complete ? 'data: [DONE]\n\n' : ''}`, { headers: { 'content-type': 'text/event-stream' } })
}

const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError() {} }

function lastReasoning(body: Record<string, unknown>): string | undefined {
  const message = (body.messages as OaiMessage[]).at(-1)
  assert.ok(message?.role === 'assistant')
  return message.reasoning_content
}

for (const count of [72, 101]) {
  test(`transport reasoning replay preserves a ${count}-message canonical prefix across the next turn and resume`, async () => {
    const originalFetch = globalThis.fetch
    const bodies: Array<Record<string, unknown>> = []
    const observations: Array<Partial<Usage>> = []
    const snapshots: ContinuationPrefixProof[] = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return response(bodies.length === 1 ? 'partial reasoning' : 'new reasoning', bodies.length !== 1)
    }
    try {
      const { client } = makeClient()
      const request: OaiChatRequest = { model: 'deepseek-flash', messages: history(count), prefixProbe: true, onExecutionSnapshot: proof => { snapshots.push(proof) } }
      await client.stream(request, { ...callbacks, onStopReason: (_reason, usage) => { observations.push(usage) } })
      const saved = structuredClone(client.getMainPrefixProof!()!)
      assert.equal(bodies.length, 2)
      assert.equal(lastReasoning(bodies[1]!), 'partial reasoning')
      assert.deepEqual((bodies[1]!.messages as OaiMessage[]).slice(0, count), bodies[0]!.messages)
      const next: OaiChatRequest = { ...request, messages: [...request.messages, { role: 'assistant', content: 'answer', reasoning_content: 'new reasoning' }, { role: 'user', content: 'continue' }] }
      await assert.doesNotReject(client.stream(next, callbacks))
      const resumed = makeClient().client
      resumed.restoreExecutionSnapshot!(saved)
      await assert.doesNotReject(resumed.stream(next, callbacks))
      assert.equal(saved.messages.length, count)
      assert.equal(snapshots[0]!.messages.length, count)
      assert.equal(observations[0]!.observation!.wire!.messages.length, count + 1)
      assert.equal(observations[0]!.observation!.executionSnapshot!.messages.length, count)
      assert.equal(bodies.length, 4)
      assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
    } finally { globalThis.fetch = originalFetch }
  })
}

test('multiple interrupted attempts may replace only their temporary reasoning suffix', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return response(`reasoning ${bodies.length}`, bodies.length > 2)
  }
  try {
    const { client } = makeClient()
    await assert.doesNotReject(client.stream({ model: 'deepseek-flash', prefixProbe: true, messages: history(3) }, callbacks))
    assert.equal(bodies.length, 3)
    assert.equal(lastReasoning(bodies[1]!), 'reasoning 1')
    assert.equal(lastReasoning(bodies[2]!), 'reasoning 2')
    assert.deepEqual((bodies[2]!.messages as OaiMessage[]).slice(0, 3), bodies[0]!.messages)
    assert.equal(client.getMainPrefixProof!()!.messages.length, 3)
  } finally { globalThis.fetch = originalFetch }
})

test('a blocked history rewrite keeps both baselines intact and records the actual fork', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  const aborted: StreamAttemptAbortedInfo[] = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return response('complete', true)
  }
  try {
    const { client, transport } = makeClient()
    const request: OaiChatRequest = { model: 'deepseek-flash', prefixProbe: true, messages: history(3) }
    await client.stream(request, callbacks)
    const saved = structuredClone(client.getMainPrefixProof!()!)
    const wireSaved = structuredClone(transport.getMainPrefixProof()!)
    const corrupted = { ...request, messages: [request.messages[0]!, { role: 'user' as const, content: 'rewritten' }, request.messages[2]!] }
    await assert.rejects(client.stream(corrupted, { ...callbacks, onStreamAttemptAborted: info => { aborted.push(info) } }), /prefix diverged at 1/)
    assert.equal(bodies.length, 1)
    assert.deepEqual(client.getMainPrefixProof!(), saved)
    assert.deepEqual(transport.getMainPrefixProof(), wireSaved)
    assert.equal(aborted.length, 1)
    assert.equal(aborted[0]!.usage!.observation!.wire!.comparison, 'fork')
    assert.deepEqual(aborted[0]!.usage!.observation!.continuity, {
      cacheGenerationId: saved.cacheGenerationId, generationReason: saved.generationReason,
      optionsHash: saved.optionsHash, toolsHash: saved.toolsHash, credentialScope: saved.credentialScope,
    })
    assert.deepEqual(aborted[0]!.usage!.observation!.fields, {})
    await assert.doesNotReject(client.stream({ ...request, messages: [...request.messages, { role: 'user', content: 'valid continuation' }] }, callbacks))
    assert.equal(bodies.length, 2)
  } finally { globalThis.fetch = originalFetch }
})

test('reasoning correction survives a following transport retry without entering the saved history', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) return response('echo\n'.repeat(128), false)
    return response('healthy reasoning', bodies.length > 2)
  }
  try {
    const { client } = makeClient()
    const request: OaiChatRequest = { model: 'deepseek-flash', prefixProbe: true, messages: history(3) }
    await assert.doesNotReject(client.stream(request, callbacks))
    assert.equal(bodies.length, 3)
    for (const body of bodies.slice(1)) {
      const messages = body.messages as OaiMessage[]
      assert.equal(messages.filter(message => message.role === 'user' && message.content === REASONING_REPETITION_CORRECTION).length, 1)
      assert.ok(!JSON.stringify(messages).includes('echo\\n'))
      assert.deepEqual(messages.slice(0, 3), bodies[0]!.messages)
    }
    assert.equal(lastReasoning(bodies[2]!), 'healthy reasoning')
    assert.equal(client.getMainPrefixProof!()!.messages.length, 3)
    await assert.doesNotReject(client.stream({ ...request, messages: [...request.messages, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' }] }, callbacks))
    assert.equal(bodies.length, 4)
  } finally { globalThis.fetch = originalFetch }
})

test('worker cardinality rejection reports the unsent body rather than the previous successful wire', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  const aborted: StreamAttemptAbortedInfo[] = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return response('complete', true)
  }
  try {
    const { transport } = makeClient()
    const adapter = { stream: async (request: OaiChatRequest, observer: StreamCallbacks, signal?: AbortSignal) => {
      await transport.stream(request, observer, signal)
      await transport.stream({ ...request, messages: [...request.messages, { role: 'user', content: 'must not send' }] }, observer, signal)
    } }
    const client = withExecutionContinuity(adapter, { provider: 'deepseek', model: 'deepseek-flash', singleAttempt: true, credentialScope: 'fixture' })
    await assert.rejects(client.stream({ model: 'deepseek-flash', prefixProbe: true, messages: history(1) }, {
      ...callbacks, onStreamAttemptAborted: info => { aborted.push(info) },
    }), /already sent/)
    assert.equal(bodies.length, 1)
    assert.equal(aborted.length, 1)
    assert.equal(aborted[0]!.usage!.observation!.prefix!.messages, 2)
    assert.equal(aborted[0]!.usage!.observation!.wire!.messages.length, 2)
    assert.equal(aborted[0]!.usage!.observation!.wire!.baseline, 'present')
    assert.equal(aborted[0]!.usage!.observation!.wire!.comparison, 'not_checked')
    assert.equal(client.getMainPrefixProof!()!.messages.length, 1)
    await assert.rejects(client.stream({ model: 'deepseek-flash', prefixProbe: true, messages: history(1) }, callbacks), /already sent/)
    assert.equal(bodies.length, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('a nested cardinality rejection cannot replace the parent attempt diagnostic body', async () => {
  const originalFetch = globalThis.fetch
  const parentAborts: StreamAttemptAbortedInfo[] = []
  const childAborts: StreamAttemptAbortedInfo[] = []
  const { transport: parentTransport } = makeClient()
  const { transport: childTransport } = makeClient()
  const parent = withExecutionContinuity(parentTransport, {
    provider: 'deepseek', model: 'deepseek-flash', singleAttempt: true, credentialScope: 'fixture',
  })
  const child = withExecutionContinuity(childTransport, {
    provider: 'deepseek', model: 'deepseek-flash', credentialScope: 'fixture',
  })
  let sends = 0
  globalThis.fetch = async () => {
    sends++
    await assert.rejects(child.stream({ model: 'deepseek-flash', prefixProbe: true, messages: history(2) }, {
      ...callbacks, onStreamAttemptAborted: info => { childAborts.push(info) },
    }), /already sent/)
    throw new Error('synthetic parent transport failure')
  }
  try {
    await assert.rejects(parent.stream({ model: 'deepseek-flash', prefixProbe: true, messages: history(1) }, {
      ...callbacks, onStreamAttemptAborted: info => { parentAborts.push(info) },
    }), /synthetic parent transport failure/)
    assert.equal(sends, 1)
    assert.equal(childAborts.length, 1)
    assert.equal(childAborts[0]!.usage!.observation!.prefix!.messages, 2)
    assert.equal(childAborts[0]!.usage!.observation!.wire!.messages.length, 2)
    assert.equal(childAborts[0]!.usage!.observation!.wire!.comparison, 'not_checked')
    assert.equal(parentAborts.length, 1)
    assert.equal(parentAborts[0]!.usage!.observation!.prefix!.messages, 1)
    assert.equal(parentAborts[0]!.usage!.observation!.wire!.messages.length, 1)
    assert.equal(parentAborts[0]!.usage!.observation!.wire!.comparison, 'baseline_missing')
    assert.equal(parentAborts[0]!.usage!.observation!.executionSnapshot!.messages.length, 1)
    assert.notEqual(parentAborts[0]!.requestId, childAborts[0]!.requestId)
  } finally { globalThis.fetch = originalFetch }
})

test('same-request rejected attempt diagnostics cannot replace an earlier delayed abort', async () => {
  const originalFetch = globalThis.fetch
  const aborted: StreamAttemptAbortedInfo[] = []
  const { transport } = makeClient()
  let sends = 0
  let successfulUsage: Partial<Usage> | undefined
  globalThis.fetch = async () => { sends++; return response('complete', true) }
  const adapter = { stream: async (request: OaiChatRequest, observer: StreamCallbacks, signal?: AbortSignal) => {
    await transport.stream(request, { ...observer, onStopReason: (reason, usage) => {
      successfulUsage = usage
      observer.onStopReason(reason, usage)
    } }, signal)
    await assert.rejects(transport.stream({ ...request,
      messages: [...request.messages, { role: 'user', content: 'must not send' }],
    }, observer, signal), /already sent/)
    assert.ok(successfulUsage?.observation)
    observer.onStreamAttemptAborted!({
      requestId: successfulUsage.observation.requestId, attemptId: successfulUsage.observation.attemptId,
      provider: 'deepseek', receivedChars: 0, elapsedMs: 1,
      errorName: 'Error', errorMessage: 'synthetic delayed abort',
      usage: { ...successfulUsage, observation: { ...successfulUsage.observation, status: 'aborted' } },
    })
  } }
  const client = withExecutionContinuity(adapter, {
    provider: 'deepseek', model: 'deepseek-flash', singleAttempt: true, credentialScope: 'fixture',
  })
  try {
    await assert.doesNotReject(client.stream({ model: 'deepseek-flash', prefixProbe: true,
      messages: history(1), contextBudget: { requestId: 'shared-request', revision: 0,
        sampledAt: 0, model: 'deepseek-flash', windowTokens: 1_000_000, inputBudget: 990_000,
        inputTokens: 1, outputReserve: 2048, safetyMargin: 7952, imageTokens: 0,
        reasoningTokens: 0, toolTokens: 0, source: 'estimate', state: 'ready' },
    }, { ...callbacks, onStreamAttemptAborted: info => { aborted.push(info) } }))
    assert.equal(sends, 1)
    assert.equal(aborted.length, 2)
    assert.equal(aborted[0]!.requestId, aborted[1]!.requestId)
    assert.notEqual(aborted[0]!.attemptId, aborted[1]!.attemptId)
    assert.equal(aborted[0]!.usage!.observation!.prefix!.messages, 2)
    assert.equal(aborted[0]!.usage!.observation!.wire!.messages.length, 2)
    assert.equal(aborted[1]!.usage!.observation!.prefix!.messages, 1)
    assert.equal(aborted[1]!.usage!.observation!.wire!.messages.length, 1)
    assert.equal(aborted[1]!.usage!.observation!.executionSnapshot!.messages.length, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('an abort without usage preserves the real transport request and attempt identities', async () => {
  const originalFetch = globalThis.fetch
  const aborted: StreamAttemptAbortedInfo[] = []
  let sends = 0
  globalThis.fetch = async () => { sends++; return response('complete', true) }
  try {
    const { transport } = makeClient()
    const client = withExecutionContinuity(transport, {
      provider: 'deepseek', model: 'deepseek-flash', singleAttempt: true, credentialScope: 'fixture',
    })
    await assert.rejects(client.stream({ model: 'deepseek-flash', prefixProbe: true, messages: history(1) }, {
      ...callbacks, onStopReason: () => { throw new Error('synthetic stop observer failure') },
      onStreamAttemptAborted: info => { aborted.push(info) },
    }), /synthetic stop observer failure/)
    assert.equal(sends, 1)
    assert.equal(aborted.length, 1)
    assert.ok(aborted[0]!.requestId)
    assert.ok(aborted[0]!.attemptId)
    assert.notEqual(aborted[0]!.attemptId, aborted[0]!.requestId)
    assert.equal(aborted[0]!.usage!.observation!.requestId, aborted[0]!.requestId)
    assert.equal(aborted[0]!.usage!.observation!.attemptId, aborted[0]!.attemptId)
    assert.deepEqual(aborted[0]!.usage!.observation!.fields, {})
    assert.equal('input_tokens' in aborted[0]!.usage!, false)
  } finally { globalThis.fetch = originalFetch }
})
