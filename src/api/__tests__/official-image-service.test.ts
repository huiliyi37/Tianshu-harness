import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OfficialError } from '../../models/official-contract.js'
import { ImageGenerationService } from '../image-generation-service.js'
import { generateImage } from '../image-gen-client.js'
import { sealModelRequestAuthorizer, type ModelRequestAuthorizer } from '../request-authorization.js'

test('image service preserves typed official failure for admission callers without changing ordinary polling', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'official-image-service-'))
  let preparations = 0
  let sends = 0
  const authorizer: ModelRequestAuthorizer = { async authorize(input) {
    assert.equal(input.operation, 'image-generation')
    return { url: 'https://synthetic.invalid/v1/images/generations', headers: { authorization: 'Bearer synthetic' }, redirect: 'manual' }
  } }
  sealModelRequestAuthorizer(authorizer, { owner: {}, model: 'image', capture: () => authorizer, async check() {}, refuse() {}, policy() {} })
  const service = new ImageGenerationService(undefined, options => generateImage({ ...options,
    lookupImpl: async () => ({ address: '8.8.8.8', family: 4 }),
    fetchImpl: async (_url, init) => {
      sends++
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic')
      return new Response(JSON.stringify({ version: 1, requestId: 'synthetic', error: { code: 'pricing_changed', retryable: true, message: 'private-upstream-diagnostic' } }), { status: 409 })
    },
  }))
  const input = { cwd, requestId: 'synthetic-request', origin: 'test' as const, parameters: { provider: 'official', model: 'image', prompt: 'synthetic' }, connection: { baseUrl: 'https://synthetic.invalid', async prepareRequestAuth() { preparations++; return authorizer } } }
  try {
    const record = await service.start(input)
    assert.equal((await service.wait(cwd, record.id))?.state, 'failed')
    await assert.rejects(service.wait(cwd, record.id, { propagateOfficialFailure: true }), (error: unknown) => error instanceof OfficialError && error.code === 'pricing_changed' && !error.retryable)
    await service.start(input)
    assert.equal(preparations, 1)
    assert.equal(sends, 1)
    assert.ok(!JSON.stringify(await service.get(cwd, record.id)).includes('private-upstream-diagnostic'))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
