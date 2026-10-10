import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRouter } from '../src/server/index.js'
import type { ImageGenerationService } from '../src/api/image-generation-service.js'
const output = await mkdtemp(join(tmpdir(), 'image-generation-defects-'))
const originalConfig = process.env.RIVET_CONFIG_PATH
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
async function moduleCopy(relative: string, name: string, transform: (source: string) => string) {
  const source = new URL(relative, import.meta.url), raw = await readFile(source, 'utf8')
  const transformed = transform(raw)
  const anchored = transformed.replace(/from (['"])(\.[^'"]+)\1/g, (_all, quote: string, specifier: string) => `from ${quote}${new URL(specifier.replace(/\.js$/, '.ts'), source).href}${quote}`)
  const path = join(output, `${name}.ts`); await writeFile(path, anchored)
  return import(pathToFileURL(path).href)
}
let calls = 0
const upstream = createServer((_req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png }] })) })
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
try {
  const address = upstream.address() as { port: number }
  for (const defect of [false, true]) {
    const name = defect ? 'implicit-paid-test' : 'save-baseline'
    const config = await moduleCopy('../src/server/config-routes.ts', name, source => defect ? source.replace("'POST /config/image-gen-model/onboard': withAuth(async (body) => {", "'POST /config/image-gen-model/onboard': withAuth(async (body) => {\n      await generateImage({ baseUrl: (body as any).baseUrl, model: (body as any).modelId, prompt: IMAGE_GEN_TEST_PROMPT, timeoutMs: 1000 })") : source)
    process.env.RIVET_CONFIG_PATH = join(output, `${name}.json`)
    const before = calls, router = createRouter(config.buildConfigRoutes('fixture'))
    const response = await router('POST', '/config/image-gen-model/onboard', { providerName: 'fixture-image', baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'fixture-image' }, { authorization: 'Bearer fixture' })
    assert.equal(response.status, 200)
    if (!defect) assert.equal(calls - before, 0)
    else assert.throws(() => assert.equal(calls - before, 0), /1 !== 0/)
    console.log(`${name}: ${defect ? 'restored defect correctly fails' : 'passes'}`)
  }
  for (const defect of [false, true]) {
    const name = defect ? 'duplicate-request' : 'idempotency-baseline'
    const module = await moduleCopy('../src/api/image-generation-service.ts', name, source => defect ? source.replace('if (reservation) {', 'if (false && reservation) {').replace('if (existing) {', 'if (false && existing) {') : source)
    const cwd = await mkdtemp(join(output, name)), service: ImageGenerationService = new module.ImageGenerationService(undefined, async () => ({ bytes: Buffer.from(png, 'base64'), mimeType: 'image/png', source: 'b64_json' }))
    const request = { cwd, requestId: randomUUID(), origin: 'workbench' as const, parameters: { provider: 'fixture', model: 'fixture', prompt: 'garden' }, connection: { baseUrl: 'https://example.test' } }
    const records = await Promise.all([service.start(request), service.start(request)])
    const unique = new Set(records.map(record => record.id)).size
    if (!defect) assert.equal(unique, 1)
    else assert.throws(() => assert.equal(unique, 1), /2 !== 1/)
    await service.wait(cwd, records.at(-1)!.id)
    console.log(`${name}: ${defect ? 'restored defect correctly fails' : 'passes'}`)
  }
  console.log(`Mutation evidence: ${output}`)
} finally {
  if (originalConfig === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = originalConfig
  upstream.closeAllConnections(); upstream.close()
}
