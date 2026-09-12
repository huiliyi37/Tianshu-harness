/**
 * Wave 3d end-to-end verification: against a mock OpenAI-compatible server
 * (in-test http server) run the FULL onboarding chain —
 * `rivet provider add` (probe-first) → `rivet provider models` → first real
 * completion through OpenAIClient against the registered endpoint.
 */
import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../manager.js'
import { runProviderCLI } from '../provider-cli.js'
import { OpenAIClient } from '../../api/openai-client.js'

function sse(chunks: string[]): string {
  return chunks.map(c => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n'
}

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = http.createServer(handler)
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

describe('provider onboarding end-to-end (mock OpenAI-compatible server)', () => {
  let dir = ''
  let server: { baseUrl: string; close: () => Promise<void> } | undefined
  const out: string[] = []
  const errOut: string[] = []
  const io = {
    write: (line: string) => out.push(line),
    writeErr: (line: string) => errOut.push(line),
    exit: (code: number) => { throw new Error(`exit:${code}`) },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-onboarding-e2e-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    out.length = 0
    errOut.length = 0
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  after(async () => {
    await server?.close()
  })

  it('add → probe → models → first completion', async () => {
    let sawAuth = ''
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        sawAuth = req.headers.authorization ?? ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'brand-new-model-x' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([
          JSON.stringify({ choices: [{ delta: { content: 'pong' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
        ]))
        return
      }
      res.writeHead(404).end()
    })

    // 1. add — probe-first registers BOTH probed models (known + unknown).
    await runProviderCLI(['add', 'mock-e2e', '--base-url', server.baseUrl, '--api-key', 'sk-e2e', '--default'], io)
    assert.equal(sawAuth, 'Bearer sk-e2e')

    const config = loadConfig()
    assert.equal(config.provider.default, 'mock-e2e')
    const provider = config.provider.providers['mock-e2e']!
    assert.equal(provider.baseUrl, server.baseUrl)
    assert.equal(provider.models.length, 2)
    // Known model: alias-table metadata backfilled (1M window).
    const known = provider.models.find(m => m.id === 'deepseek-v4-flash')!
    assert.equal(known.contextWindow, 1_000_000)
    // Unknown model: schema default, not a silently wrong value.
    const unknown = provider.models.find(m => m.id === 'brand-new-model-x')!
    assert.equal(unknown.contextWindow, 131_072)
    assert.ok(errOut.some(l => l.includes('[TODO]')), 'unknown model annotated as TODO')

    // 2. models — pasteable snippet lists both models.
    await runProviderCLI(['models', 'mock-e2e'], io)
    const snippetLine = out.find(l => l.includes('"models"'))!
    const snippet = JSON.parse(snippetLine) as { models: Array<{ id: string }> }
    assert.deepEqual(snippet.models.map(m => m.id), ['deepseek-v4-flash', 'brand-new-model-x'])

    // 3. first completion through the real client against the onboarded endpoint.
    const client = new OpenAIClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey!,
      model: known.id,
      maxTokens: 64,
    })
    const text: string[] = []
    let stopReason = ''
    await client.stream(
      { model: known.id, messages: [{ role: 'user', content: 'ping' }] },
      {
        onTextDelta: t => text.push(t),
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: r => { stopReason = r },
        onError: e => { throw e },
      },
    )
    assert.equal(text.join(''), 'pong')
    assert.equal(stopReason, 'end_turn')

    await server.close()
    server = undefined
  })
})
