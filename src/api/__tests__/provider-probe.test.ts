import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { inflateSync } from 'node:zlib'
import { probeProvider, VISION_PROBE_IMAGE_DATA_URI } from '../provider-probe.js'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

function startServer(handler: Handler): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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

function sse(chunks: string[]): string {
  return chunks.map(c => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n'
}

describe('probeProvider', () => {
  let server: { baseUrl: string; close: () => Promise<void> } | undefined

  after(async () => {
    await server?.close()
  })

  it('fetches the model list and detects reasoning_split via a minimal completion', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'my-model' }, { id: 'other-model' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
        ]))
        return
      }
      res.writeHead(404).end()
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-test' })
    assert.deepEqual(report.models, ['my-model', 'other-model'])
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.equal(report.hints.reasoningSplit, true)
    assert.ok(typeof report.latencyMs === 'number')
    assert.deepEqual(report.errors, [])
    await server.close()
    server = undefined
  })

  // 覆盖缺口回归：探测请求此前只带认证头，打 OpenCode Go 的 chat 端点会因缺
  // x-opencode-session 被 400——连接测试要么假失败，要么在只测 /models 时假通过。
  it('探测请求带出站身份头（会话头 + 专属 UA），不再只有认证头', async () => {
    const seen: Array<http.IncomingHttpHeaders> = []
    server = await startServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })]))
    })

    const report = await probeProvider({
      baseUrl: server.baseUrl,
      apiKey: 'sk-test',
      providerName: 'opencode-go',
    })
    assert.equal(report.completionOk, true)
    assert.ok(seen.length >= 2, `models + completion 两次探测都该带头，实际 ${seen.length}`)
    for (const headers of seen) {
      assert.equal(
        headers['x-opencode-session'],
        'tianshu-probe',
        'name 层兜底：本地/中转 baseUrl 不匹配 host 规则时仍要发会话头',
      )
      assert.match(String(headers['user-agent'] ?? ''), /^tianshu-tui\//)
    }
    await server.close()
    server = undefined
  })

  it('classifies a 401 on /models and degrades instead of throwing', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid api key' }))
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'bad', skipCompletion: true })
    assert.equal(report.modelsOk, false)
    assert.deepEqual(report.models, [])
    assert.ok(report.errors.some(e => e.includes('Authentication failed')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('classifies quota exhaustion (FreeTierOnly 403) as a billing problem, not auth', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'AllocationQuota.FreeTierOnly', message: 'Free quota exhausted. To continue accessing the model on a paid basis, please add funds.' }))
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-ok', skipCompletion: true })
    assert.equal(report.modelsOk, false)
    assert.ok(report.errors.some(e => e.includes('Quota/billing problem')), report.errors.join('; '))
    assert.ok(!report.errors.some(e => e.includes('Authentication failed')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('flags a non-SSE 200 completion with missing-/v1 guidance', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not an api</html>')
    })

    const report = await probeProvider({ baseUrl: server.baseUrl })
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, false)
    assert.ok(report.errors.some(e => e.includes('SSE')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('404 on completion suggests checking the model id / path', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      res.writeHead(404).end('{"error":"not found"}')
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'ghost-model' })
    assert.equal(report.completionOk, false)
    assert.ok(report.errors.some(e => e.includes('404')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('prefers a discovered model over the suggested probeModel for completion', async () => {
    let probedModel = ''
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'workspace-model' }] }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        probedModel = (JSON.parse(body) as { model: string }).model
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      })
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'template-default' })
    assert.equal(report.completionOk, true)
    assert.equal(probedModel, 'workspace-model')
    await server.close()
    server = undefined
  })

  it('uses the suggested probeModel when it exists in the discovered list', async () => {
    let probedModel = ''
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'expensive-flagship' }, { id: 'template-default' }] }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        probedModel = (JSON.parse(body) as { model: string }).model
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      })
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'template-default' })
    assert.equal(report.completionOk, true)
    assert.equal(probedModel, 'template-default')
    await server.close()
    server = undefined
  })

  it('normalizes a pasted full chat URL instead of double-appending paths', async () => {
    const hits: string[] = []
    server = await startServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]))
    })

    const report = await probeProvider({ baseUrl: `${server.baseUrl}/chat/completions` })
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.deepEqual(hits, ['/v1/models', '/v1/chat/completions'])
    await server.close()
    server = undefined
  })

  it('version-less base (oneapi-style) gets /v1 inserted before the paths', async () => {
    const hits: string[] = []
    server = await startServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]))
    })

    // startServer's baseUrl ends in /v1 — strip it to simulate a bare /api base.
    const bareBase = server.baseUrl.replace(/\/v1$/, '')
    const report = await probeProvider({ baseUrl: bareBase })
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.deepEqual(hits, ['/v1/models', '/v1/chat/completions'])
    await server.close()
    server = undefined
  })

  it('skipCompletion never touches the completion endpoint', async () => {
    let completionHits = 0
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'only-model' }] }))
        return
      }
      completionHits++
      res.writeHead(200).end()
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, skipCompletion: true })
    assert.deepEqual(report.models, ['only-model'])
    assert.equal(report.completionOk, false)
    assert.equal(completionHits, 0)
    await server.close()
    server = undefined
  })

  it('degrades gracefully when the endpoint refuses the connection', async () => {
    // Reserve a port and close it immediately → guaranteed ECONNREFUSED.
    const placeholder = await startServer((_req, res) => res.end())
    const deadUrl = placeholder.baseUrl
    await placeholder.close()

    const report = await probeProvider({ baseUrl: deadUrl, timeoutMs: 3_000 })
    assert.equal(report.modelsOk, false)
    assert.equal(report.completionOk, false)
    assert.ok(report.errors.length >= 1)
  })

  it('probes the anthropic messages endpoint with x-api-key for protocol anthropic', async () => {
    let sawApiKey = false
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-x' }] }))
        return
      }
      if (req.url === '/v1/messages') {
        sawApiKey = req.headers['x-api-key'] === 'sk-ant'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('event: message_start\ndata: {"type":"message_start"}\n\n')
        return
      }
      res.writeHead(404).end()
    })

    // baseUrl for anthropic clients excludes /v1 (the client appends it).
    const baseUrl = server.baseUrl.replace(/\/v1$/, '')
    const report = await probeProvider({ baseUrl, apiKey: 'sk-ant', protocol: 'anthropic' })
    assert.equal(report.completionOk, true)
    assert.equal(sawApiKey, true)
    await server.close()
    server = undefined
  })
})

describe('vision real-test (视觉真测)', () => {
  let server: { baseUrl: string; close: () => Promise<void> } | undefined

  after(async () => {
    await server?.close()
  })

  function visionServer(modelIds: string[], answer: string, capture: { model?: string; body?: unknown }) {
    return startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: modelIds.map(id => ({ id })) }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        capture.body = JSON.parse(body)
        capture.model = (capture.body as { model: string }).model
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([JSON.stringify({ choices: [{ delta: { content: answer } }] })]))
      })
    })
  }

  it('sends the built-in image when the probe model is vision-capable, and reports the answer', async () => {
    const capture: { model?: string; body?: unknown } = {}
    server = await visionServer(['glm-4v-flash'], '一张红色的正方形图片', capture)
    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-x', probeModel: 'glm-4v-flash' })
    assert.equal(report.completionOk, true)
    assert.equal(report.visionTested, true)
    assert.equal(report.visionAnswer, '一张红色的正方形图片')
    assert.equal(report.probedModel, 'glm-4v-flash')
    const content = (capture.body as { messages: Array<{ content: unknown }> }).messages[0]!.content
    assert.ok(Array.isArray(content), '视觉真测必须是多模态 content 数组')
    const parts = content as Array<Record<string, unknown>>
    assert.ok(parts.some(p => p.type === 'image_url'), '携带内置图片')
    assert.ok(JSON.stringify(parts).startsWith('[') && JSON.stringify(parts).includes('data:image/png;base64,'))
    await server.close()
    server = undefined
  })

  it('extracts a content-parts array answer (OpenAI-compatible delta.content array form)', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'glm-4v-flash' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([
        JSON.stringify({ choices: [{ delta: { content: [{ type: 'text', text: '一张红色' }] } }] }),
        JSON.stringify({ choices: [{ delta: { content: [{ type: 'text', text: '的正方形' }] } }] }),
      ]))
    })
    try {
      const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'glm-4v-flash' })
      assert.equal(report.visionTested, true)
      assert.equal(report.completionOk, true, 'content-parts 数组形态的回答不应被判为无回答')
      assert.equal(report.visionAnswer, '一张红色的正方形')
    } finally {
      await server.close()
      server = undefined
    }
  })

  it('falls back to a discovered vision-capable model when the suggested one is absent', async () => {
    const capture: { model?: string } = {}
    // 聚合站没有 glm-4v-flash；列表里第一个是纯文本模型，glm-5.2 是别名表认识的视觉档。
    server = await visionServer(['some-text-model', 'glm-5.2'], '红色方块', capture)
    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-x', probeModel: 'glm-4v-flash' })
    assert.equal(report.completionOk, true)
    assert.equal(report.probedModel, 'glm-5.2', '必须优先挑别名表认识的视觉档，而非 models[0]')
    assert.equal(report.visionTested, true)
    assert.equal(report.visionAnswer, '红色方块')
    await server.close()
    server = undefined
  })

  it('the built-in image is exactly 16×16 pure RGB red', () => {
    const png = Buffer.from(VISION_PROBE_IMAGE_DATA_URI.split(',')[1]!, 'base64')
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
    assert.equal(png.readUInt32BE(16), 16)
    assert.equal(png.readUInt32BE(20), 16)
    assert.equal(png[24], 8, '8-bit channels')
    assert.equal(png[25], 2, 'RGB color type')

    const idat: Buffer[] = []
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset)
      const type = png.subarray(offset + 4, offset + 8).toString('ascii')
      if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
      offset += 12 + length
    }
    const raw = inflateSync(Buffer.concat(idat))
    const stride = 16 * 3
    let previous = Buffer.alloc(stride)
    for (let y = 0; y < 16; y++) {
      const filter = raw[y * (stride + 1)]
      assert.equal(filter, 0, 'fixture uses unfiltered scanlines so pixel truth stays transparent')
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      for (let x = 0; x < stride; x += 3) assert.deepEqual([...row.subarray(x, x + 3)], [255, 0, 0])
      previous = Buffer.from(row)
    }
    assert.equal(previous.length, stride)
  })

  it('does not pass a vision real-test when the SSE stream contains no answer text', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'glm-4v-flash' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
    try {
      const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'glm-4v-flash' })
      assert.equal(report.visionTested, true)
      assert.equal(report.completionOk, false)
      assert.equal(report.visionAnswer, undefined)
      assert.ok(report.errors.some(error => /no answer text/i.test(error)), report.errors.join('; '))
    } finally {
      await server.close()
      server = undefined
    }
  })

  it('keeps the plain-text probe for non-vision models (no visionTested flag)', async () => {
    const capture: { body?: unknown } = {}
    server = await visionServer(['deepseek-chat'], 'hi', capture)
    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-x', probeModel: 'deepseek-chat' })
    assert.equal(report.completionOk, true)
    assert.equal(report.visionTested, undefined)
    assert.equal(report.visionAnswer, undefined)
    const content = (capture.body as { messages: Array<{ content: unknown }> }).messages[0]!.content
    assert.equal(content, 'hi')
    await server.close()
    server = undefined
  })
})

describe('dashscope native models enrichment (E3)', () => {
  let server: { baseUrl: string; close: () => Promise<void> } | undefined

  after(async () => {
    await server?.close()
  })

  function nativeModel(id: string, modality: string[], info?: Record<string, unknown>) {
    return {
      model: id,
      name: id,
      model_info: info ?? null,
      inference_metadata: { response_modality: modality },
    }
  }

  it('switches compatible-mode base to /api/v1/models, parses native shape, filters modalities, carries metadata', async () => {
    const seenUrls: string[] = []
    server = await startServer((req, res) => {
      seenUrls.push(req.url ?? '')
      if ((req.url ?? '').startsWith('/api/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          output: {
            models: [
              nativeModel('qwen-new-max', ['Text'], { context_window: 1_000_000, max_output_tokens: 131_072, max_reasoning_tokens: 262_144 }),
              nativeModel('qwen-image-3', ['Image']),
              nativeModel('qwen-audio-x', ['Audio']),
              nativeModel('qwen-vl-new', ['Multimodal'], { context_window: 131_072 }),
            ],
          },
        }))
        return
      }
      if (req.url === '/compatible-mode/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]))
        return
      }
      res.writeHead(404).end()
    })

    const baseUrl = server.baseUrl.replace(/\/v1$/, '/compatible-mode/v1')
    const report = await probeProvider({ baseUrl, apiKey: 'sk-x', providerName: 'dashscope' })
    assert.deepEqual(report.models, ['qwen-new-max', 'qwen-vl-new'])
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.deepEqual(report.modelInfos?.['qwen-new-max'], {
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      maxReasoningTokens: 262_144,
    })
    assert.ok(!('qwen-image-3' in (report.modelInfos ?? {})))
    // 补全仍走 compatible-mode 路径（/api/v1 没有 OpenAI 风格 chat）。
    assert.ok(seenUrls.some(u => u === '/compatible-mode/v1/chat/completions'))
    await server.close()
    server = undefined
  })

  it('falls back to the OpenAI-compatible /models when the native endpoint fails', async () => {
    server = await startServer((req, res) => {
      if ((req.url ?? '').startsWith('/api/v1/models')) {
        res.writeHead(500).end()
        return
      }
      if (req.url === '/compatible-mode/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'fallback-model' }] }))
        return
      }
      res.writeHead(404).end()
    })

    const baseUrl = server.baseUrl.replace(/\/v1$/, '/compatible-mode/v1')
    const report = await probeProvider({ baseUrl, apiKey: 'sk-x', providerName: 'dashscope', skipCompletion: true })
    assert.deepEqual(report.models, ['fallback-model'])
    assert.equal(report.modelInfos, undefined)
    assert.deepEqual(report.errors, [])
    await server.close()
    server = undefined
  })

  it('paginates while a page is full (raw count, not filtered count)', async () => {
    const pages: string[] = []
    server = await startServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/api/v1/models')) {
        pages.push(url)
        const pageNo = Number(new URL(`http://x${url}`).searchParams.get('page_no'))
        res.writeHead(200, { 'content-type': 'application/json' })
        if (pageNo === 1) {
          // 满页 200 条：199 图像 + 1 文本——过滤后只有 1 条，但必须翻页。
          const models = Array.from({ length: 199 }, (_, i) => nativeModel(`img-${i}`, ['Image']))
          models.push(nativeModel('qwen-page1-text', ['Text'], { context_window: 1000 }))
          res.end(JSON.stringify({ output: { models } }))
        } else {
          res.end(JSON.stringify({ output: { models: [nativeModel('qwen-page2-text', ['Text'], { context_window: 2000 })] } }))
        }
        return
      }
      res.writeHead(404).end()
    })

    const baseUrl = server.baseUrl.replace(/\/v1$/, '/compatible-mode/v1')
    const report = await probeProvider({ baseUrl, apiKey: 'sk-x', providerName: 'dashscope', skipCompletion: true })
    assert.deepEqual(report.models, ['qwen-page1-text', 'qwen-page2-text'])
    assert.equal(pages.length, 2)
    await server.close()
    server = undefined
  })
})

describe('aliasTableWithProbeInfos', () => {
  it('synthesizes entries for unknown ids and never overrides existing table entries', async () => {
    const { aliasTableWithProbeInfos } = await import('../provider-probe.js')
    const { matchModelId } = await import('../model-id-matcher.js')

    const table = aliasTableWithProbeInfos({
      'qwen3.8-max': { contextWindow: 12345 }, // 已在别名表（preset 模板）——不覆盖
      'brand-new-model': { contextWindow: 500_000, maxOutputTokens: 65_536, maxReasoningTokens: 81_920 },
      'no-metadata-model': {},
    })

    const kept = matchModelId('qwen3.8-max', table)
    assert.equal(kept.tier, 'exact')
    assert.equal(kept.entry?.metadata.contextWindow, 1_000_000)

    const synthesized = matchModelId('brand-new-model', table)
    assert.equal(synthesized.tier, 'exact')
    assert.equal(synthesized.entry?.metadata.contextWindow, 500_000)
    assert.equal(synthesized.entry?.metadata.maxTokens, 65_536)
    assert.deepEqual(synthesized.entry?.metadata.capabilities, { reasoningSplit: true })

    const empty = matchModelId('no-metadata-model', table)
    assert.equal(empty.entry, undefined, '无元数据的 id 不合成条目，仍走 L4')
  })

  it('returns the enriched base table (别名表 + 官网知识库) without infos', async () => {
    const { aliasTableWithProbeInfos } = await import('../provider-probe.js')
    const { ENRICHED_ALIAS_TABLE } = await import('../model-meta-kb.js')
    const { matchModelId } = await import('../model-id-matcher.js')
    assert.equal(aliasTableWithProbeInfos(undefined), ENRICHED_ALIAS_TABLE)
    assert.equal(aliasTableWithProbeInfos({}), ENRICHED_ALIAS_TABLE)

    // 官网知识库命中：GLM 全系规格免补参（大小写不敏感）。
    const table = aliasTableWithProbeInfos(undefined)
    const glm = matchModelId('GLM-4.6', table)
    assert.notEqual(glm.entry, undefined, 'KB 收录 glm-4.6')
    assert.equal(glm.entry?.metadata.contextWindow, 204_800)
    assert.equal(glm.entry?.metadata.maxTokens, 131_072)
    assert.deepEqual(glm.entry?.metadata.capabilities, { reasoningSplit: true })

    // Kimi 官网未公布最大输出 → 半已知（有 ctx 无 max，向导预填已知项）。
    const kimi = matchModelId('kimi-k2.6', table)
    assert.equal(kimi.entry?.metadata.contextWindow, 262_144)
    assert.equal(kimi.entry?.metadata.maxTokens, undefined)
  })
})
