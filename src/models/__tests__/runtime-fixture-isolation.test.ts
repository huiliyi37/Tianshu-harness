import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialRuntimeFixture } from '../../__tests__/helpers/official-runtime-fixture.js'
import { prepareModelRuntime } from '../model-runtime.js'

const environmentKeys = ['RIVET_HOME', 'RIVET_CONFIG_PATH', 'RIVET_ACCOUNT_API', 'RIVET_TOKEN_STORE'] as const

for (const firstClosesFirst of [true, false]) {
  test(`runtime fixtures retain independent transports and restore their environment: firstClosesFirst=${firstClosesFirst}`, async () => {
    const originalFetch = globalThis.fetch
    const originalEnvironment = environmentKeys.map(name => process.env[name])
    let first: Awaited<ReturnType<typeof createOfficialRuntimeFixture>> | undefined
    let second: typeof first
    try {
      first = await createOfficialRuntimeFixture()
      second = await createOfficialRuntimeFixture()
      const firstRuntime = await prepareModelRuntime(first.input, first.deps)
      const secondRuntime = await prepareModelRuntime(second.input, second.deps)
      assert.equal(firstRuntime.modelId, 'fixture-model')
      assert.equal(secondRuntime.modelId, 'fixture-model')
      const closing = firstClosesFirst ? first : second
      const retained = firstClosesFirst ? second : first
      await closing.close()
      await closing.close()
      assert.equal(globalThis.fetch, retained.fetchImpl)
      assert.equal(process.env.RIVET_HOME, retained.home)
      await prepareModelRuntime(retained.input, retained.deps)
      await retained.close()
      assert.equal(globalThis.fetch, originalFetch)
      assert.deepEqual(environmentKeys.map(name => process.env[name]), originalEnvironment)
    } finally {
      await Promise.allSettled([first?.close(), second?.close()])
    }
  })
}
