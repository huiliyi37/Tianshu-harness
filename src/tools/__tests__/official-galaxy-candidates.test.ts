import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGalaxyTool, type GalaxyCoordinator } from '../galaxy.js'
import type { ModelSubmission } from '../../models/model-runtime.js'
import type { DelegationRequest } from '../../agent/coordinator.js'
import { OfficialError } from '../../models/official-contract.js'
import { createOfficialRuntimeFixture } from '../../__tests__/helpers/official-runtime-fixture.js'
import { createAgentConfig } from '../../agent/create-agent-config.js'
import { providerSchema } from '../../config/schema.js'
import { DISABLED_USER_INSTRUCTIONS } from '../../prompt/user-instructions.js'
import { DelegationCoordinator } from '../../agent/coordinator.js'
import { ToolRegistry } from '../registry.js'

const input = {
  objective: 'Compare independently gathered evidence', autoReview: false, confirm: true,
  dimensions: [
    { name: 'verify', objective: 'Inspect the same evidence', authority: 'yaoguang', parallelism: 'data', replicas: 3 },
    { name: 'research', objective: 'Inspect independent evidence', authority: 'tianxuan', parallelism: 'data', replicas: 2 },
  ],
}

test('Galaxy captures invocation authority before inspection and reuses one authorized async pool', async () => {
  const original = {} as ModelSubmission
  let active = original
  const submission = { capture: () => active } as ModelSubmission
  const controller = new AbortController()
  let inspections = 0
  const requests: DelegationRequest[] = []
  const coordinator: GalaxyCoordinator = {
    getRuntimeSnapshot: () => {
      active = {} as ModelSubmission
      return { activeWorkers: 0, maxWorkers: 1, pendingWorkers: 0, stalledWorkers: 0, inFlightFileScopes: 0, backgroundRunning: 0, activeClaims: 0, providerDegradation: 0, shuttingDown: false }
    },
    resolveCandidateModels: async (signal, pinned) => {
      assert.equal(pinned, original)
      assert.equal(signal, controller.signal)
      inspections++
      await Promise.resolve()
      return [{ provider: 'official', model: 'authorized-candidate' }]
    },
    getCandidateModels: () => { throw new Error('async inspection cannot use an unbound legacy pool') },
    delegateBatch: async batch => { requests.push(...batch); return { status: 'completed', results: [], packet: '' } },
  }
  await createGalaxyTool(coordinator).execute({ input, toolUseId: 'authorized-galaxy', cwd: '/synthetic', modelSubmission: submission, abortSignal: controller.signal })
  assert.equal(inspections, 1)
  assert.equal(requests.length, 5)
  assert.deepEqual(requests.filter(request => request.modelOverride).map(request => request.modelOverride), Array.from({ length: 3 }, () => ({ provider: 'official', model: 'authorized-candidate' })))
})

test('Galaxy propagates an original-source refusal before dispatching any worker', async () => {
  const refusal = new OfficialError('pricing_changed', 409, false)
  let dispatched = false
  const coordinator: GalaxyCoordinator = {
    resolveCandidateModels: async () => { throw refusal },
    delegateBatch: async () => { dispatched = true; return { status: 'completed', results: [], packet: '' } },
  }
  await assert.rejects(createGalaxyTool(coordinator).execute({ input, toolUseId: 'refused-galaxy', cwd: '/synthetic' }), error => error === refusal)
  assert.equal(dispatched, false)
})

test('real Galaxy metadata cannot adopt a later root submission during runtime inspection', async () => {
  const fixture = await createOfficialRuntimeFixture()
  const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 1000 }] })
  fixture.input.config.provider.providers.byok = byok
  const config = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: fixture.home, sessionId: 'galaxy-real-scope', compact: fixture.input.config.compact, toolDefinitions: [], allProviders: fixture.input.config.provider.providers })
  await config.prepareModelSubmission!(new AbortController().signal)
  const coordinator = new DelegationCoordinator({ providers: fixture.input.config.provider.providers, runtimeSubmission: config.runtimeSubmission, baseToolRegistry: new ToolRegistry(), modelCards: [], maxWorkers: 1, runtimeFactory: () => { throw new Error('unexpected dispatch') } })
  let dispatched = false
  const tool = createGalaxyTool({
    getRuntimeSnapshot: () => {
      config.runtimeSubmission!.settle()
      void config.prepareModelSubmission!(new AbortController().signal)
      return { activeWorkers: 0, maxWorkers: 1, pendingWorkers: 0, stalledWorkers: 0, inFlightFileScopes: 0, backgroundRunning: 0, activeClaims: 0, providerDegradation: 0, shuttingDown: false }
    },
    resolveCandidateModels: (signal, pinned) => coordinator.resolveCandidateModels(signal, pinned),
    delegateBatch: async () => { dispatched = true; return { status: 'completed', results: [], packet: '' } },
  })
  try {
    let result: unknown
    let failure: unknown
    try { result = await tool.execute({ input, toolUseId: 'real-galaxy-boundary', cwd: fixture.home, modelSubmission: config.runtimeSubmission }) } catch (error) { failure = error }
    assert.ok(failure instanceof OfficialError, JSON.stringify(result))
    assert.equal(failure.code, 'auth_required')
    assert.equal(dispatched, false)
    assert.equal(fixture.catalogCount, 0)
    assert.equal(fixture.quoteCount, 0)
    assert.equal(fixture.calls.length, 0)
  } finally { config.runtimeSubmission!.settle(); await coordinator.shutdown(); await fixture.close() }
})
