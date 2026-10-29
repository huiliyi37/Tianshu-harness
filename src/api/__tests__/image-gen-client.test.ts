import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateImage } from '../image-gen-client.js'

// 1×1 透明 PNG——最小的真图字节，避免用假数据掩盖解码路径的错误。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bytesResponse(body: Uint8Array, contentType = 'image/png'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

/** 下载 url 现在要过 SSRF 预检（会做 DNS 解析）。用假域名 cdn.example 的用例必须
 *  注入解析结果，否则预检会去查真实 DNS 并抛 ENOTFOUND——那是测试环境的问题，
 *  不是被测行为。 */
const PUBLIC_LOOKUP = async () => ({ address: '93.184.216.34', family: 4 })

interface Captured { url: string; body: Record<string, unknown>; method?: string }

function captureOnce(response: Response): { fetchImpl: typeof fetch; captured: () => Captured } {
  let seen: Captured | undefined
  const fetchImpl = (async (url: unknown, init?: { body?: unknown; method?: string }) => {
    seen = {
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
      ...(init?.method ? { method: init.method } : {}),
    }
    return response
  }) as unknown as typeof fetch
  return { fetchImpl, captured: () => seen as Captured }
}

describe('image-gen client — request shape (issue #8 协议分歧吸收点)', () => {
  it('sends `size` by default (the OpenAI shape)', async () => {
    const { fetchImpl, captured } = captureOnce(jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
    await generateImage({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      prompt: 'a red circle',
      size: '1024x1024',
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl,
    })

    assert.equal(captured().url, 'https://api.openai.com/v1/images/generations')
    assert.equal(captured().method, 'POST')
    assert.equal(captured().body.size, '1024x1024')
    assert.equal(
      Object.hasOwn(captured().body, 'image_size'),
      false,
      '默认形态不得同时发 image_size——两边都发会让端点行为不确定',
    )
  })

  it('sends `image_size` when sizeField says so, and never both', async () => {
    const { fetchImpl, captured } = captureOnce(jsonResponse({ images: [{ url: 'https://cdn.example/out.png' }] }))
    const result = await generateImage({
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKey: 'sk-test',
      model: 'black-forest-labs/FLUX.2-pro',
      prompt: 'a serene lake',
      size: '512x512',
      sizeField: 'image_size',
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: (async (url: unknown, init?: { body?: unknown; method?: string }) => {
        if (String(url).includes('/images/generations')) {
          const inner = await fetchImpl(url as never, init as never)
          return inner
        }
        return bytesResponse(PNG_BYTES)
      }) as unknown as typeof fetch,
    })

    assert.equal(captured().body.image_size, '512x512')
    assert.equal(
      Object.hasOwn(captured().body, 'size'),
      false,
      'sizeField=image_size 时不得再发 size',
    )
    assert.equal(result.source, 'url')
    assert.deepEqual(result.bytes, new Uint8Array(PNG_BYTES))
  })

  it('targets /images/generations straight off the base (no double version segment)', async () => {
    const { fetchImpl, captured } = captureOnce(jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
    await generateImage({
      baseUrl: 'http://localhost:3000/api',
      apiKey: 'sk-test',
      model: 'flux',
      prompt: 'x',
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl,
    })
    assert.equal(captured().url, 'http://localhost:3000/api/v1/images/generations')
  })

  it('carries the bearer token', async () => {
    let auth: string | undefined
    const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      auth = init?.headers?.Authorization ?? init?.headers?.authorization
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] })
    }) as unknown as typeof fetch
    await generateImage({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-secret',
      model: 'gpt-image-1',
      prompt: 'x',
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl,
    })
    assert.equal(auth, 'Bearer sk-secret')
  })
})

describe('image-gen client — tolerant response parsing (§4.3)', () => {
  it('parses the OpenAI b64_json shape', async () => {
    const { fetchImpl } = captureOnce(jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
    const result = await generateImage({
      baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', prompt: 'x', fetchImpl,
      lookupImpl: PUBLIC_LOOKUP,
    })
    assert.equal(result.source, 'b64_json')
    assert.deepEqual(result.bytes, new Uint8Array(PNG_BYTES))
    assert.equal(result.mimeType, 'image/png')
  })

  it('parses the OpenAI url shape (dall-e style), downloading the bytes', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/images/generations')) {
        return jsonResponse({ data: [{ url: 'https://cdn.example/a.png' }] })
      }
      return bytesResponse(PNG_BYTES)
    }) as unknown as typeof fetch
    const result = await generateImage({
      baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'dall-e-3', prompt: 'x', fetchImpl,
      lookupImpl: PUBLIC_LOOKUP,
    })
    assert.equal(result.source, 'url')
    assert.deepEqual(result.bytes, new Uint8Array(PNG_BYTES))
  })

  // 这条是本轮调研的核心发现：SiliconFlow 既不是 OpenAI 的 size 字段，也不是
  // {data:[…]} 响应——只认 OpenAI 形状的实现会在这里被打红。
  it('parses the SiliconFlow images[].url shape', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/images/generations')) {
        return jsonResponse({ images: [{ url: 'https://cdn.example/sf.png' }], timings: { inference: 12 }, seed: 7 })
      }
      return bytesResponse(PNG_BYTES)
    }) as unknown as typeof fetch
    const result = await generateImage({
      baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'k', model: 'flux', prompt: 'x', fetchImpl,
      lookupImpl: PUBLIC_LOOKUP,
    })
    assert.equal(result.source, 'url')
    assert.deepEqual(result.bytes, new Uint8Array(PNG_BYTES))
  })

  it('throws a descriptive error when no known image field is present', async () => {
    const { fetchImpl } = captureOnce(jsonResponse({ result: 'weird provider shape' }))
    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', prompt: 'x', fetchImpl,
        lookupImpl: PUBLIC_LOOKUP,
      }),
      (err: Error) => {
        // 报错必须能定位——含响应片段，而不是笼统的 "parse failed"。
        assert.match(err.message, /weird provider shape/)
        return true
      },
    )
  })
})

describe('image-gen client — error classification (§4.1 实测错误码)', () => {
  const cases: Array<{ status: number; body: unknown; expect: RegExp }> = [
    { status: 401, body: 'Invalid token', expect: /401|token|Authentication/i },
    { status: 404, body: '404 page not found', expect: /404|path/i },
    { status: 429, body: { message: 'TPM limit reached.' }, expect: /429|rate limit|quota/i },
    { status: 503, body: { code: 50505, message: 'Model service overloaded. Please try again later.' }, expect: /503|overload/i },
  ]

  for (const c of cases) {
    it(`classifies HTTP ${c.status} with an actionable message`, async () => {
      const { fetchImpl } = captureOnce(
        new Response(typeof c.body === 'string' ? c.body : JSON.stringify(c.body), {
          status: c.status,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await assert.rejects(
        () => generateImage({
          baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'k', model: 'flux', prompt: 'x', fetchImpl,
          lookupImpl: PUBLIC_LOOKUP,
        }),
        (err: Error) => {
          assert.match(err.message, c.expect)
          return true
        },
      )
    })
  }
})

describe('image-gen client — timeout', () => {
  it('surfaces a timeout with the configured budget rather than hanging', async () => {
    const fetchImpl = (async () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      throw err
    }) as unknown as typeof fetch
    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'k', model: 'flux', prompt: 'x',
        timeoutMs: 180_000, fetchImpl,
        lookupImpl: PUBLIC_LOOKUP,
      }),
      (err: Error) => {
        assert.match(err.message, /180000|180_000|timed out/i)
        return true
      },
    )
  })
})

// 审查发现（HIGH）：下载用的 url 来自**响应体**，不受我们控制。恶意或被劫持的生图
// 端点可以借它打到内网/云元数据地址，取回的字节还会落盘、被 read_file 读回上下文。
describe('image-gen client — SSRF 预检（审查修复）', () => {
  it('拒绝指向保留网段的下载 url，且在发起下载之前就拦下', async () => {
    let downloadAttempted = false
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/images/generations')) {
        return jsonResponse({ images: [{ url: 'http://169.254.169.254/latest/meta-data/' }] })
      }
      downloadAttempted = true
      return bytesResponse(PNG_BYTES)
    }) as unknown as typeof fetch

    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'k', model: 'flux', prompt: 'x',
        fetchImpl,
        lookupImpl: PUBLIC_LOOKUP,
      }),
      /endpoint_reserved_address_denied/i,
    )
    assert.equal(downloadAttempted, false, '预检必须在下载之前生效，而不是下载后再判断')
  })

  it('放行公网地址的正常下载', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/images/generations')) {
        return jsonResponse({ images: [{ url: 'https://cdn.example/x.png' }] })
      }
      return bytesResponse(PNG_BYTES)
    }) as unknown as typeof fetch
    const result = await generateImage({
      baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'k', model: 'flux', prompt: 'x',
      fetchImpl,
      lookupImpl: async () => ({ address: '93.184.216.34', family: 4 }),
    })
    assert.equal(result.source, 'url')
    assert.deepEqual(result.bytes, new Uint8Array(PNG_BYTES))
  })
})

// 审查发现（MEDIUM）：错误分支回显 payload 片段，端点把整图 base64 放在响应里时
// 就会进对话上下文，与「base64 不进上下文」的承诺冲突。
describe('image-gen client — 错误文案脱敏（审查修复）', () => {
  it('响应携带 base64 时不把它回显进错误消息', async () => {
    // 数组根形态：extractImageRef 不认它，因此会走"没有已知字段"的错误分支。
    const { fetchImpl } = captureOnce(jsonResponse([{ b64_json: PNG_B64 }]))
    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', prompt: 'x', fetchImpl,
        lookupImpl: PUBLIC_LOOKUP,
      }),
      (err: Error) => {
        assert.equal(
          err.message.includes(PNG_B64.slice(0, 120)),
          false,
          'base64 绝不能出现在错误文案里（它会随 content 进对话上下文）',
        )
        assert.match(err.message, /base64 data omitted|did not contain a known image field/)
        return true
      },
    )
  })

  it('仍保留诊断信息：非 base64 的响应片段照常回显', async () => {
    const { fetchImpl } = captureOnce(jsonResponse({ result: 'weird provider shape' }))
    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', prompt: 'x', fetchImpl,
        lookupImpl: PUBLIC_LOOKUP,
      }),
      /weird provider shape/,
    )
  })
})

// 审查发现（MEDIUM）：fetchWithTimeout 在响应头到达时就 clearTimeout，之后读 body
// （response.json() / arrayBuffer()）完全没有超时保护——一个只发 headers、不写 body
// 的端点能让调用挂到天荒地老。这里刻意用**真实 HTTP server** 验证：能否用 abort
// 打断"正在读的 body"是 undici 的行为，用 fake Response 自证不了。
describe('image-gen client — 超时覆盖 body 读取（审查修复）', () => {
  let hangingServer: Server
  let hangingBase = ''

  before(async () => {
    hangingServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // flushHeaders() 是这条测试的关键：writeHead 只是设置 headers，Node 会把它
      // 缓冲到首次 write/end——那样 fetch() 会卡在"等响应头"，测到的是本就已有的
      // headers 超时，而不是我们要锁的 body 读取超时。刷出去之后 headers 到达、
      // fetch 返回，body 才是那个永远不完成的环节。
      res.flushHeaders()
      // 故意不 res.end()：body 永不完成。
    })
    await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve))
    const address = hangingServer.address() as AddressInfo
    hangingBase = `http://127.0.0.1:${address.port}/v1`
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      hangingServer.close((err) => (err ? reject(err) : resolve()))
    })
  })

  // 显式超时：未修复时这个用例会永久挂起（node:test 默认 timeout 是 Infinity），
  // 挂死比红更难归因，所以自己设一个上限，让"红"是红。
  it('body 挂起时按 timeoutMs 中止，而不是无限等待', { timeout: 5_000 }, async () => {
    await assert.rejects(
      () => generateImage({
        baseUrl: hangingBase, endpointNetworkPolicy: { origin: new URL(hangingBase).origin, allowPrivateNetwork: true }, apiKey: 'k', model: 'flux', prompt: 'x',
        timeoutMs: 400,
      }),
      /endpoint_timeout/,
    )
  })
})

// 审查发现（MEDIUM）：响应体与落盘字节都没有上限。上限做成可注入，测试才能用
// 几 KB 验证，而不必真的分配 50MB。
describe('image-gen client — 字节上限（审查修复）', () => {
  it('b64 响应超过 maxBytes 时拒绝', async () => {
    const oversized = Buffer.alloc(4096, 0x41).toString('base64')
    const { fetchImpl } = captureOnce(jsonResponse({ data: [{ b64_json: oversized }] }))
    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', prompt: 'x',
        lookupImpl: PUBLIC_LOOKUP,
      fetchImpl, maxBytes: 1024,
      }),
      /too large|上限/i,
    )
  })

  it('url 下载超过 maxBytes 时拒绝', async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).includes('/images/generations')) {
        return jsonResponse({ images: [{ url: 'https://cdn.example/big.png' }] })
      }
      return bytesResponse(new Uint8Array(4096))
    }) as unknown as typeof fetch
    await assert.rejects(
      () => generateImage({
        baseUrl: 'https://api.siliconflow.com/v1', apiKey: 'k', model: 'flux', prompt: 'x',
        fetchImpl, lookupImpl: PUBLIC_LOOKUP, maxBytes: 1024,
      }),
      /too large|上限/i,
    )
  })

  it('上限内的正常图照常放行（防止判据把正常图也拦下）', async () => {
    const { fetchImpl } = captureOnce(jsonResponse({ data: [{ b64_json: PNG_B64 }] }))
    const result = await generateImage({
      baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', prompt: 'x',
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl, maxBytes: 1024 * 1024,
    })
    assert.equal(result.source, 'b64_json')
  })
})
