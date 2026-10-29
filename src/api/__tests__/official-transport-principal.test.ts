import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sealModelRequestAuthorizer, captureModelAuthorization, currentOfficialRequestPrincipal, fetchModelWithTimeout, type ModelRequestAuthorizer } from '../request-authorization.js'
import { currentExecutionScope, withExecutionContinuity, credentialPrincipal } from '../execution-continuity.js'
import { OfficialError } from '../../models/official-contract.js'
import { FallbackStreamClient } from '../fallback-client.js'
import type { StreamCallbacks } from '../stream-client.js'

const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }
const request = { model: 'synthetic-model', messages: [{ role: 'user' as const, content: 'synthetic' }] }

function authority(owner = {}, principal = 'a'.repeat(64)) {
  let credential = 0
  let captures = 0
  const authorizer: ModelRequestAuthorizer = {
    async authorize(input) {
      return { url: input.url, headers: { authorization: 'Bearer synthetic-' + ++credential }, redirect: 'error' }
    },
  }
  sealModelRequestAuthorizer(authorizer, { owner, principal, model: request.model, capture() { captures++; return authorizer }, async check() {}, refuse() {}, policy() {} })
  return { authorizer, get captures() { return captures } }
}

test('sealed model authorization captures an owned identity and refuses forged or mismatched models', () => {
  const owned = authority()
  assert.ok(Object.isFrozen(owned.authorizer))
  assert.throws(() => captureModelAuthorization({ ...owned.authorizer }, request.model), OfficialError)
  assert.throws(() => captureModelAuthorization(owned.authorizer, 'other'), OfficialError)
  assert.equal(owned.captures, 0)
  assert.notEqual(captureModelAuthorization(owned.authorizer, request.model), owned.authorizer)
  assert.equal(owned.captures, 1)
})

test('official principal reaches actual beforeSend, survives credential rotation, and cannot be forged through headers', async context => {
  const owned = authority()
  const observed: Array<string | undefined> = []
  const headers: RequestInit['headers'][] = []
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    headers.push(init?.headers)
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  })
  const send = withExecutionContinuity({ async stream() {
    const scope = currentExecutionScope()!
    scope.beforeSend = (_url, _body, principal) => { observed.push(principal) }
    const captured = captureModelAuthorization(owned.authorizer, request.model)
    await fetchModelWithTimeout(captured, 'chat', 'https://synthetic.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: request.model, messages: [] }) })
  } }, { provider: 'official', model: request.model })
  await send.stream(request, callbacks)
  await send.stream(request, callbacks)
  assert.match(observed[0]!, /^[a-f0-9]{64}$/)
  assert.equal(observed[0], observed[1], 'credential refresh must not change the execution owner')
  assert.notEqual(new Headers(headers[0]).get('authorization'), new Headers(headers[1]).get('authorization'))
  assert.notEqual(observed[0], credentialPrincipal(headers[0]), 'expired request context cannot supply authority')
  assert.equal(currentOfficialRequestPrincipal(headers[0]), undefined)
  assert.equal(currentOfficialRequestPrincipal({ ...headers[0], 'x-official-principal': observed[0]! }), undefined)
})

test('official principal separates binding URLs and principals', async context => {
  const first = authority()
  const second = authority({}, 'b'.repeat(64))
  const observed: Array<string | undefined> = []
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    observed.push(credentialPrincipal(init?.headers))
    return new Response('{}')
  })
  for (const [authorizer, url] of [[first.authorizer, 'https://synthetic.invalid/a'], [first.authorizer, 'https://synthetic.invalid/b'], [second.authorizer, 'https://synthetic.invalid/a']] as const) {
    await fetchModelWithTimeout(captureModelAuthorization(authorizer, request.model), 'chat', url, {})
  }
  assert.equal(new Set(observed).size, 3)
  assert.ok(observed.every(value => /^[a-f0-9]{64}$/.test(value!)))
})

test('exhausted official rate limiting never crosses a provider fallback boundary', async () => {
  let fallbacks = 0
  const error = new OfficialError('rate_limited', 429, true, 1, 'account')
  const client = new FallbackStreamClient({ async stream() { throw error } }, 'official', [{ name: 'byok', create() { fallbacks++; return { async stream() {} } } }])
  await assert.rejects(client.stream(request, callbacks), value => value === error)
  assert.equal(fallbacks, 0)
})
