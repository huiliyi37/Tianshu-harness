import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { loadConfig } from '../manager.js'
import { readSecret } from '../secrets-store.js'
import { runProviderCLI, toModelDescriptors } from '../provider-cli.js'
import { matchModelIds } from '../../api/model-id-matcher.js'

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`)
  }
}

function captureIO() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      write: (line: string) => { stdout.push(line) },
      writeErr: (line: string) => { stderr.push(line) },
      exit: (code: number) => { throw new ExitCalled(code) },
    },
  }
}

function startModelServer(modelIds: string[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: modelIds.map(id => ({ id })) }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

describe('toModelDescriptors', () => {
  it('backfills alias-table metadata on exact/normalized hits and keeps the raw id', () => {
    const { models, notes } = toModelDescriptors(matchModelIds(['deepseek-v4-flash', 'GLM-5.2']))
    assert.equal(models.length, 2)
    assert.equal(models[0]?.id, 'deepseek-v4-flash')
    assert.equal(models[0]?.contextWindow, 1_000_000)
    assert.equal(models[1]?.id, 'GLM-5.2', 'the endpoint raw id stays callable in config')
    assert.equal(models[1]?.contextWindow, 1_000_000)
    assert.deepEqual(notes, [])
  })

  it('emits bare skeletons + TODO notes for unknown ids', () => {
    const { models, notes } = toModelDescriptors(matchModelIds(['brand-new-model-9000']))
    assert.deepEqual(models, [{ id: 'brand-new-model-9000' }])
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /TODO/)
  })
})

describe('rivet provider CLI', () => {
  let dir = ''
  let server: { baseUrl: string; close: () => Promise<void> } | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(async () => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
    await server?.close()
    server = undefined
  })

  it('add: probe-first flow registers models with alias-table backfill', async () => {
    server = await startModelServer(['deepseek-v4-flash', 'mystery-model-x'])
    const { io, stdout } = captureIO()
    await runProviderCLI([
      'add', 'my-relay', '--base-url', server.baseUrl, '--api-key', 'sk-local', '--default',
    ], io)

    const cfg = loadConfig()
    const provider = cfg.provider.providers['my-relay']!
    assert.equal(cfg.provider.default, 'my-relay')
    assert.equal(provider.protocol, 'openai')
    assert.equal(provider.models.length, 2)
    const known = provider.models.find(m => m.id === 'deepseek-v4-flash')!
    assert.equal(known.contextWindow, 1_000_000, 'matched model backfills real metadata')
    const unknown = provider.models.find(m => m.id === 'mystery-model-x')!
    assert.equal(unknown.contextWindow, 131_072, 'unknown model gets the conservative schema default')
    assert.ok(stdout.some(line => line.includes('registered')))
  })

  it('add --no-probe registers without models', async () => {
    const { io } = captureIO()
    await runProviderCLI([
      'add', 'silent-one', '--base-url', 'https://api.example.com/v1', '--no-probe',
    ], io)
    const provider = loadConfig().provider.providers['silent-one']!
    assert.deepEqual(provider.models, [])
  })

  it('add: same name requires --force', async () => {
    const { io } = captureIO()
    await runProviderCLI(['add', 'dup', '--base-url', 'https://a.example.com/v1', '--no-probe'], io)

    const failing = captureIO()
    await assert.rejects(
      runProviderCLI(['add', 'dup', '--base-url', 'https://b.example.com/v1', '--no-probe'], failing.io),
      (error: unknown) => error instanceof ExitCalled && error.code === 1,
    )
    assert.ok(failing.stderr.some(line => line.includes('already exists')))

    const forced = captureIO()
    await runProviderCLI(['add', 'dup', '--base-url', 'https://b.example.com/v1', '--no-probe', '--force'], forced.io)
    assert.equal(loadConfig().provider.providers['dup']!.baseUrl, 'https://b.example.com/v1')
  })

  it('models: prints a pasteable snippet with backfills and TODO annotations', async () => {
    server = await startModelServer(['deepseek-v4-flash', 'alien-model'])
    const { io } = captureIO()
    await runProviderCLI(['add', 'src', '--base-url', server.baseUrl, '--no-probe'], io)

    const { io: modelsIO, stdout, stderr } = captureIO()
    await runProviderCLI(['models', 'src'], modelsIO)

    const jsonText = stdout.join('\n')
    const snippet = JSON.parse(jsonText.slice(jsonText.indexOf('{'))) as {
      models: Array<{ id: string; contextWindow?: number }>
    }
    assert.deepEqual(snippet.models.map(m => m.id), ['deepseek-v4-flash', 'alien-model'])
    assert.equal(snippet.models[0]?.contextWindow, 1_000_000)
    assert.equal(snippet.models[1]?.contextWindow, undefined, 'unknown models stay blank for manual fill')
    assert.ok(stderr.some(line => line.includes('TODO')))
  })

  it('models: unknown provider exits 1 with a helpful hint', async () => {
    const { io, stderr } = captureIO()
    await assert.rejects(
      runProviderCLI(['models', 'ghost'], io),
      (error: unknown) => error instanceof ExitCalled && error.code === 1,
    )
    assert.ok(stderr.some(line => line.includes('not found')))
  })

  it('list prints configured providers; remove deletes them', async () => {
    const { io } = captureIO()
    await runProviderCLI(['add', 'temp', '--base-url', 'https://t.example.com/v1', '--no-probe'], io)

    const { io: listIO, stdout } = captureIO()
    await runProviderCLI(['list'], listIO)
    assert.ok(stdout.some(line => line.startsWith('temp')))

    const { io: removeIO } = captureIO()
    await runProviderCLI(['remove', 'temp'], removeIO)
    assert.equal(loadConfig().provider.providers['temp'], undefined)
  })

  it('remove reports group size and clears the stored API key', async () => {
    const { io } = captureIO()
    await runProviderCLI(['add', 'keyed', '--base-url', 'https://t.example.com/v1', '--api-key', 'sk-keyed', '--no-probe'], io)

    const { io: removeIO, stdout } = captureIO()
    await runProviderCLI(['remove', 'keyed'], removeIO)
    assert.ok(stdout.some(line => line.includes('removed (0 models)')), stdout.join('\n'))
    assert.ok(stdout.some(line => line.includes('API key deleted from secrets.json')), stdout.join('\n'))
    assert.equal(readSecret('keyed'), undefined)
  })

  it('rejects an invalid --protocol value', async () => {
    const { io, stderr } = captureIO()
    await assert.rejects(
      runProviderCLI(['add', 'bad', '--base-url', 'https://x.example.com/v1', '--protocol', 'gemini'], io),
      (error: unknown) => error instanceof ExitCalled && error.code === 1,
    )
    assert.ok(stderr.some(line => line.includes('Invalid --protocol')))
  })
})
