import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialRuntimeFixture } from '../../__tests__/helpers/official-runtime-fixture.js'
import { createOfficialModelBroker } from '../../auth/official-model-auth.js'
import { createProviderClient } from '../../api/factory.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import { createWorkerAuthChannel, createWorkerCredentialBroker } from '../../agent/worker-process/credential-broker.js'
import { createDelegatedSubmission, originalRuntimeIdentity, prepareModelRuntime, resolveModelRuntime, type DelegatedModelSnapshot, type ModelRuntimeDeps } from '../model-runtime.js'

const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }

async function principalFixture() {
  const fixture = await createOfficialRuntimeFixture({ credentialLifetimeMs: 6500 })
  try {
    const broker = createOfficialModelBroker({ home: fixture.home, configuration: { gatewayOrigin: fixture.binding.origin }, fetchImpl: fixture.fetchImpl })
    const deps: ModelRuntimeDeps = {
      ...fixture.deps, captureIdentity: broker.captureOfficialIdentity, getCatalog: broker.getOfficialCatalog,
      getCredential: broker.getOfficialCredential, getQuote: broker.getOfficialPriceQuote, withIdentity: broker.withCurrentOfficialIdentity,
    }
    const input = { ...fixture.input, principal: 'f'.repeat(64) }
    const prepared = await prepareModelRuntime(input, deps)
    const runtime = await resolveModelRuntime({ ...input, prepared }, deps)
    const parent = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    const request = { model: runtime.modelId, messages: [{ role: 'user' as const, content: 'protected fixture' }], prefixProbe: true }
    await assert.doesNotReject(parent.stream(request, callbacks), 'the production-equivalent parent must establish its protected baseline')
    assert.equal(fixture.calls.length, 1)
    const principal = parent.getMainPrefixProof?.()?.credentialScope?.split(':principal:')[1]
    assert.match(principal ?? '', /^[a-f0-9]{64}$/)
    const credentials = createWorkerCredentialBroker(originalRuntimeIdentity(runtime), runtime)
    const channel = createWorkerAuthChannel(message => {
      if (message.t === 'model-prepare-cancel') { credentials.cancelPrepare(message.requestId); return }
      void (message.t === 'model-prepare' ? credentials.prepare(message) : credentials.handle(message)).then(result => channel.accept(JSON.parse(JSON.stringify(result))))
    }, new AbortController().signal)
    const delegated = channel.connect(JSON.parse(JSON.stringify(credentials.snapshots)))
    const child = delegated.runtimes[0]!
    const client = createProviderClient(child.provider, child.capabilities, { apiKey: '', model: child.modelId, maxTokens: 100, requestAuth: child.requestAuth, singleAttempt: true, expectedPrincipal: principal })
    const snapshot = credentials.snapshots[0]!
    const rawPrincipal = (snapshot as DelegatedModelSnapshot & { principal?: string }).principal
    return { fixture, parent, request, client, principal, rawPrincipal, snapshot, child, close: async () => { channel.dispose(); credentials.dispose(); await fixture.close() } }
  } catch (error) { await fixture.close(); throw error }
}

test('a real broker principal survives the correlated worker channel and the first protected child send', async () => {
  const setup = await principalFixture()
  try {
    await setup.client.stream(setup.request, callbacks)
    assert.match(setup.rawPrincipal ?? '', /^[a-f0-9]{64}$/)
    assert.notEqual(setup.rawPrincipal, 'f'.repeat(64), 'caller-supplied model input cannot choose the broker owner')
    assert.notEqual(setup.rawPrincipal, setup.principal, 'delegation carries the raw owner, not the already URL-bound transport hash')
    assert.equal(setup.fixture.calls.length, 2, 'both protected parent and child requests must reach the native transport')
    assert.equal(setup.client.getMainPrefixProof?.()?.credentialScope?.split(':principal:')[1], setup.principal)
  } finally { await setup.close() }
})

test('a present malformed delegated principal fails closed before any authorization request', async () => {
  const setup = await principalFixture()
  let authorizations = 0
  try {
    for (const principal of ['', 'not-an-owner', 'A'.repeat(64), null, 42]) {
      const snapshot = { ...setup.snapshot, principal } as unknown as DelegatedModelSnapshot
      assert.throws(() => createDelegatedSubmission([snapshot], {
        async authorize() { authorizations++; throw new Error('malformed owner reached authorization') },
        async check() {}, refuse() {},
      }), /auth_required/)
    }
    assert.equal(authorizations, 0)
  } finally { await setup.close() }
})

test('delegated protected continuation keeps its broker principal across credential renewal and rejects an account switch', async context => {
  const setup = await principalFixture()
  try {
    await setup.client.stream(setup.request, callbacks)
    const authorization = setup.fixture.calls.at(-1)!.headers.authorization
    const later = Date.now() + 7000
    setup.fixture.advance(7000)
    context.mock.method(Date, 'now', () => later)
    await setup.client.stream(setup.request, callbacks)
    assert.equal(setup.fixture.calls.length, 3)
    assert.notEqual(setup.fixture.calls.at(-1)!.headers.authorization, authorization)
    assert.equal(setup.client.getMainPrefixProof?.()?.credentialScope?.split(':principal:')[1], setup.principal)
    await setup.fixture.replaceAccount()
    await assert.rejects(setup.client.stream(setup.request, callbacks), /account_changed|auth_required/)
    assert.equal(setup.fixture.calls.length, 3)
  } finally { await setup.close() }
})
