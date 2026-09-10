import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { createProviderClient, resolveApiKey, type RuntimeParams } from '../factory.js'
import { resolveCapabilities } from '../provider.js'
import { OpenAIClient } from '../openai-client.js'
import { AnthropicClient } from '../anthropic-client.js'
import { ApiKeyAuth } from '../../auth/api-key.js'
import { cloneProviderPreset } from '../../config/provider-presets.js'
import type { ProviderConfig } from '../../config/schema.js'
import { providerSchema } from '../../config/schema.js'

const deepseekProvider: ProviderConfig = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  protocol: 'openai',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: true,
    prefixCache: 'deepseek-native',
    prefixCompletion: true,
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'deepseek-r1', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const kimiProvider: ProviderConfig = {
  name: 'kimi',
  baseUrl: 'https://api.kimi.com/coding',
  protocol: 'openai',
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: false,
    prefixCache: 'none',
    prefixCompletion: false,
  },
  thinking: 'enabled',
  maxTokens: 64000,
  models: [{ id: 'kimi-code', contextWindow: 128000, maxTokens: 8192 }],
  unsupported: [],
}

const runtimeParams: RuntimeParams = {
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 4096,
}

describe('createProviderClient', () => {
  it('creates a client for a deepseek provider', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    assert.ok(client)
  })

  it('creates a client for a kimi provider with well-known defaults', () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    assert.ok(client)
  })

  it('sends User-Agent header for kimi provider', async () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    await client.stream(
      { model: 'kimi-code', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
      { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: error => { throw error } },
    )

    globalThis.fetch = originalFetch
    assert.equal(capturedHeaders['User-Agent'], 'KimiCLI/1.0')
  })

  // 官方 Kimi Code 文档：k3 / k3-256k 的 reasoning_effort 支持 low|high|max。
  // 曾经的 effortCap {max:'high'} 会把用户选的 max 静默降成 high——这里钉住
  // 实际发出的请求体，防止再次被钳制。
  it('kimi 的 reasoning_effort=max 原样发出（K3 系原生支持 max）', async () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, { ...runtimeParams, model: 'k3', reasoningEffort: 'max' })
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    await client.stream(
      { model: 'k3', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
      { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: error => { throw error } },
    )

    globalThis.fetch = originalFetch
    assert.equal(capturedBody['reasoning_effort'], 'max')
  })

  it('creates OpenAIClient for openai protocol', () => {
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const capabilities = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
  })

  it('falls back to capabilities.stripParams when unsupported is empty', () => {
    // Provider with empty unsupported → should use capabilities.stripParams
    const caps = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, caps, runtimeParams)
    // OpenAIClient doesn't expose config, but construction succeeds
    assert.ok(client)
  })

  it('uses explicit provider.unsupported when set', () => {
    const providerWithUnsupported: ProviderConfig = {
      ...deepseekProvider,
      unsupported: ['custom_param'],
    }
    const caps = resolveCapabilities('deepseek')
    const client = createProviderClient(providerWithUnsupported, caps, runtimeParams)
    assert.ok(client)
  })

  it('passes providerProfile into OpenAIClient for cache strategy', async () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    let body = ''
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_delta\ndata: {"delta_stop_reason":"end_turn","usage":{}}\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 },
      { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: error => { throw error } },
    )

    globalThis.fetch = originalFetch
    assert.ok(!body.includes('cache_control'), body)
  })

  it('accepts AuthProvider in runtime params', () => {
    const auth = new ApiKeyAuth('sk-from-auth')
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const caps = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, caps, {
      ...runtimeParams,
      auth,
    })
    assert.ok(client instanceof OpenAIClient)
  })

  it('passes providerProfile into OpenAIClient', () => {
    const openaiProvider: ProviderConfig = {
      ...deepseekProvider,
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai',
    }
    const caps = resolveCapabilities('openai')
    const client = createProviderClient(openaiProvider, caps, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
  })

  it('creates CodexClient for codex OAuth provider without API key', () => {
    const provider = cloneProviderPreset('codex')
    const caps = resolveCapabilities('codex')
    const client = createProviderClient(provider, caps, {
      apiKey: '',
      model: 'gpt-5.5',
      maxTokens: 4096,
      auth: new ApiKeyAuth('oauth-token-for-test'),
    })
    assert.ok(client)
  })
  it('creates AnthropicClient for a custom provider declaring protocol anthropic', () => {
    const anthropicProvider: ProviderConfig = {
      name: 'my-claude-proxy',
      baseUrl: 'https://proxy.example.com',
      protocol: 'anthropic',
      capabilities: {},
      thinking: 'enabled',
      maxTokens: 64000,
      models: [{ id: 'claude-opus-4-7', contextWindow: 200000, maxTokens: 32000 }],
      unsupported: [],
    }
    const caps = resolveCapabilities('claude')
    const client = createProviderClient(anthropicProvider, caps, {
      ...runtimeParams,
      model: 'claude-opus-4-7',
    })
    assert.ok(client instanceof AnthropicClient)
  })

  it('schema parses a provider named "anthropic" to protocol anthropic (end-to-end dispatch)', () => {
    const parsed = providerSchema.parse({
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      models: [{ id: 'claude-opus-4-7', contextWindow: 200000, maxTokens: 32000 }],
    })
    assert.equal(parsed.protocol, 'anthropic')
    const caps = resolveCapabilities('anthropic')
    const client = createProviderClient(parsed, caps, { ...runtimeParams, model: 'claude-opus-4-7' })
    assert.ok(client instanceof AnthropicClient)
  })

  it('explicit protocol openai overrides the anthropic-name normalization', () => {
    const parsed = providerSchema.parse({
      name: 'anthropic',
      baseUrl: 'https://openai-compatible.example.com/v1',
      protocol: 'openai',
      models: [{ id: 'claude-opus-4-7', contextWindow: 200000, maxTokens: 32000 }],
    })
    assert.equal(parsed.protocol, 'openai')
    const caps = resolveCapabilities('anthropic')
    const client = createProviderClient(parsed, caps, { ...runtimeParams, model: 'claude-opus-4-7' })
    assert.ok(client instanceof OpenAIClient)
  })

  it('does NOT route to AnthropicClient via the retired prefixCacheStrategy backdoor', () => {
    const anthropicProvider: ProviderConfig = {
      name: 'some-openai-wire-endpoint',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai',
      capabilities: { prefixCache: 'anthropic-cache-control' },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [{ id: 'some-model', contextWindow: 128000, maxTokens: 8192 }],
      unsupported: [],
    }
    const caps = resolveCapabilities('claude')
    caps.prefixCacheStrategy = 'anthropic-cache-control'
    const client = createProviderClient(anthropicProvider, caps, runtimeParams)
    assert.ok(client instanceof OpenAIClient, 'dispatch is protocol-driven; capability heuristics must not switch wire clients')
  })

  it('injects thinkingStallTimeoutMs default for glm provider', () => {
    const glmProvider: ProviderConfig = {
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64000,
      models: [{ id: 'glm-4.6', contextWindow: 128000, maxTokens: 8192 }],
      unsupported: [],
    }
    const capabilities = resolveCapabilities('glm')
    const client = createProviderClient(glmProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
    // config is private but accessible at runtime
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, 420_000, 'glm should get default 420s thinking stall')
  })

  it('injects thinkingStallTimeoutMs default (120s) for deepseek provider', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, 120_000, 'deepseek should get default 120s thinking stall')
  })

  it('does NOT inject thinkingStallTimeoutMs for providers not in the map', () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    assert.ok(client instanceof OpenAIClient)
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, undefined, 'kimi should not get a thinking-stall default')
  })

  it('forwards hasToolJsonInContentBug capability into OpenAIClient for deepseek', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    const config = (client as unknown as { config: { capabilities?: { hasToolJsonInContentBug?: boolean } } }).config
    assert.equal(
      config.capabilities?.hasToolJsonInContentBug,
      true,
      'deepseek client must receive the tool-JSON-in-content recovery flag',
    )
  })

  it('does NOT enable tool-JSON-in-content recovery for providers without the bug', () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    const config = (client as unknown as { config: { capabilities?: { hasToolJsonInContentBug?: boolean } } }).config
    assert.equal(config.capabilities?.hasToolJsonInContentBug, false)
  })

  it('recovers a tool call emitted as plain-text JSON for deepseek (end-to-end)', async () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          // DeepSeek bug: tool call comes back inside the text content, not tool_calls.
          const toolJson = '{"name":"grep","arguments":{"pattern":"x"}}'
          controller.enqueue(new TextEncoder().encode(
            `data: {"choices":[{"delta":{"content":${JSON.stringify(toolJson)}},"finish_reason":"stop"}]}\n\n`,
          ))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    const blocks: Array<{ type: string; name?: string; input?: unknown }> = []
    await client.stream(
      { model: 'deepseek-r1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => { blocks.push(block as { type: string; name?: string; input?: unknown }) },
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )
    globalThis.fetch = originalFetch

    const toolUse = blocks.find(b => b.type === 'tool_use')
    assert.ok(toolUse, 'plain-text tool JSON should be recovered into a tool_use block')
    assert.equal(toolUse?.name, 'grep')
    assert.deepEqual(toolUse?.input, { pattern: 'x' })
  })

  it('provider config overrides default thinkingStallTimeoutMs for glm', () => {
    const glmProvider: ProviderConfig = {
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      protocol: 'openai',
      capabilities: {
        cacheControl: false,
        stripParams: [],
        toolJsonBug: false,
        prefixCache: 'none',
        prefixCompletion: false,
      },
      thinking: 'enabled',
      maxTokens: 64000,
      thinkingStallTimeoutMs: 90_000,
      models: [{ id: 'glm-4.6', contextWindow: 128000, maxTokens: 8192 }],
      unsupported: [],
    }
    const capabilities = resolveCapabilities('glm')
    const client = createProviderClient(glmProvider, capabilities, runtimeParams)
    const config = (client as unknown as { config: { thinkingStallTimeoutMs?: number } }).config
    assert.equal(config.thinkingStallTimeoutMs, 90_000, 'explicit provider config should override default')
  })

  it('forwards firstByteTimeoutMs override into OpenAIClient config', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(
      { ...deepseekProvider, firstByteTimeoutMs: 240_000 },
      capabilities,
      runtimeParams,
    )
    const config = (client as unknown as { config: { firstByteTimeoutMs?: number } }).config
    assert.equal(config.firstByteTimeoutMs, 240_000, 'explicit firstByteTimeoutMs should flow into client config')
  })

  it('leaves firstByteTimeoutMs undefined when the provider does not set it', () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    const config = (client as unknown as { config: { firstByteTimeoutMs?: number } }).config
    assert.equal(config.firstByteTimeoutMs, undefined, 'absent override should stay undefined (size scaling is the floor)')
  })

  it('slow-thinking provider (deepseek) retries a stalled stream twice then recovers', async () => {
    const capabilities = resolveCapabilities('deepseek')
    const client = createProviderClient(deepseekProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = mock.fn(async () => {
      calls++
      // 'invalid sse ...' → classified stream_parse (retryable, maxRetries 2).
      if (calls <= 2) throw new Error('invalid sse stream chunk')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    try {
      await client.stream(
        { model: 'deepseek-r1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
        { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: () => {} },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    // 1 initial + 2 retries (slow-thinking warm-cache retries are cheap) = 3 attempts
    assert.equal(calls, 3, 'deepseek should retry twice before succeeding')
  })

  it('non-slow thinking provider (kimi) retries a stalled stream only once', async () => {
    const capabilities = resolveCapabilities('kimi')
    const client = createProviderClient(kimiProvider, capabilities, runtimeParams)
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = mock.fn(async () => {
      calls++
      throw new Error('invalid sse stream chunk')
    }) as unknown as typeof fetch

    try {
      await assert.rejects(() => client.stream(
        { model: 'kimi-code', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
        { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: () => {} },
      ))
    } finally {
      globalThis.fetch = originalFetch
    }
    // 1 initial + 1 retry (thinking default) = 2 attempts, then exhausted
    assert.equal(calls, 2, 'kimi (thinking, non-slow) should retry once then throw')
  })
})

describe('resolveApiKey', () => {
  it('returns the apiKey from provider config', () => {
    const provider: ProviderConfig = { ...deepseekProvider, apiKey: 'sk-123' }
    assert.equal(resolveApiKey(provider), 'sk-123')
  })

  it('falls back to the standard <PROVIDER>_API_KEY env var', () => {
    const provider: ProviderConfig = { ...deepseekProvider } // no apiKey, no apiKeyEnv
    process.env.DEEPSEEK_API_KEY = 'sk-from-env'
    try {
      assert.equal(resolveApiKey(provider), 'sk-from-env')
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  it('prefers apiKeyEnv over the standard env var', () => {
    const provider: ProviderConfig = { ...deepseekProvider, apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' }
    process.env.DEEPSEEK_API_KEY = 'sk-standard'
    process.env.CUSTOM_DEEPSEEK_KEY = 'sk-custom'
    try {
      assert.equal(resolveApiKey(provider), 'sk-custom')
    } finally {
      delete process.env.DEEPSEEK_API_KEY
      delete process.env.CUSTOM_DEEPSEEK_KEY
    }
  })

  it('throws when no key is configured', () => {
    const provider: ProviderConfig = { ...deepseekProvider } // no apiKey, no apiKeyEnv
    assert.throws(
      () => resolveApiKey(provider),
      /No API key configured/,
    )
  })

  it('keyless 端点（ollama 预设 / 无密钥材料自定义）返回空串而不抛错', () => {
    // 预设 keyless：ollama 无 apiKey/apiKeyEnv/keyRef
    const ollama: ProviderConfig = {
      name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai',
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
      thinking: 'enabled', maxTokens: 32768, models: [], unsupported: [],
    }
    assert.equal(resolveApiKey(ollama), '')
    // 自定义 keyless（桌面表单 API Key 可空下有意不配）
    const custom: ProviderConfig = { ...ollama, name: 'my-local-relay' }
    assert.equal(resolveApiKey(custom), '')
  })

  it('keyless 豁免不误伤「需 key 而没配」：声明了 apiKeyEnv 但环境变量缺失仍抛错', () => {
    const provider: ProviderConfig = { ...deepseekProvider, apiKeyEnv: 'DEFINITELY_MISSING_KEY_XYZ' }
    delete process.env.DEFINITELY_MISSING_KEY_XYZ
    delete process.env.DEEPSEEK_API_KEY
    assert.throws(() => resolveApiKey(provider), /No API key configured/)
  })
})

// ── OpenCode Go：上游强制 x-opencode-session ──────────────────────────────
// 实测（2026-09，真实 key 打 https://opencode.ai/zen/go）：
//   POST /v1/chat/completions 缺头 → 400 {"type":"MissingSessionID"}
//   POST /v1/messages         缺头 → 400 {"type":"MissingSessionID"}
//   两者带上 x-opencode-session 后 → 200
// 该 provider 的 Anthropic 形态在用户配置里的 name 是 'anthropic'（catalog 无同名
// 条目），所以 wire 必须能按 baseUrl host 解析，只按 provider name 查表会漏。
describe('OpenCode Go wire headers', () => {
  const opencodeCapabilities = {
    cacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    toolJsonBug: false,
    prefixCache: 'none' as const,
    prefixCompletion: false,
  }

  const opencodeOpenAi: ProviderConfig = {
    name: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    protocol: 'openai',
    capabilities: opencodeCapabilities,
    thinking: 'enabled',
    maxTokens: 64000,
    models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 64000 }],
    unsupported: [],
  }

  const opencodeAnthropic: ProviderConfig = {
    // 用户配置里 anthropic 形态的 name 就是 'anthropic'——不是 opencode-go-*
    name: 'anthropic',
    baseUrl: 'https://opencode.ai/zen/go',
    protocol: 'anthropic',
    capabilities: {
      cacheControl: true,
      stripParams: [],
      toolJsonBug: false,
      prefixCache: 'anthropic-cache-control',
      prefixCompletion: false,
    },
    thinking: 'enabled',
    maxTokens: 64000,
    models: [{ id: 'qwen3.7-max', contextWindow: 1_000_000, maxTokens: 64000 }],
    unsupported: [],
  }

  /** Capture the outgoing request while answering with a minimal valid stream. */
  async function captureRequest(
    client: { stream: (req: never, cb: never) => Promise<void> },
    sse: string,
  ): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
    const originalFetch = globalThis.fetch
    let captured: { headers: Record<string, string>; body: Record<string, unknown> } = { headers: {}, body: {} }
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch
    try {
      await client.stream(
        { model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 } as never,
        {
          onTextDelta: () => {},
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          onStopReason: () => {},
          onError: () => {},
        } as never,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    return captured
  }

  async function captureHeaders(
    client: { stream: (req: never, cb: never) => Promise<void> },
    sse: string,
  ): Promise<Record<string, string>> {
    return (await captureRequest(client, sse)).headers
  }

  it('OpenAI 协议形态发出 x-opencode-session 与专属 UA', async () => {
    const client = createProviderClient(
      opencodeOpenAi,
      resolveCapabilities('opencode-go'),
      { ...runtimeParams, model: 'deepseek-v4-flash', sessionId: 'session-abc-123' },
    )
    const headers = await captureHeaders(
      client as never,
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
    assert.equal(headers['x-opencode-session'], 'session-abc-123')
    assert.match(headers['User-Agent'] ?? '', /^tianshu-tui\//, 'UA 必须是天枢自己的标识，不能是 SDK/HTTP 库名')
  })

  it('Anthropic 协议形态（provider name = anthropic）同样按 baseUrl host 命中 wire', async () => {
    const client = createProviderClient(
      opencodeAnthropic,
      resolveCapabilities('anthropic', opencodeAnthropic.capabilities),
      { ...runtimeParams, model: 'qwen3.7-max', sessionId: 'session-abc-123' },
    )
    const headers = await captureHeaders(
      client as never,
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\ndata: {"type":"message_stop"}\n\n',
    )
    assert.equal(headers['x-opencode-session'], 'session-abc-123')
    assert.match(headers['User-Agent'] ?? '', /^tianshu-tui\//)
  })

  it('非 OpenCode 端点不被注入该头（避免污染其他 provider）', async () => {
    const client = createProviderClient(
      deepseekProvider,
      resolveCapabilities('deepseek'),
      { ...runtimeParams, model: 'deepseek-r1', sessionId: 'session-abc-123' },
    )
    const headers = await captureHeaders(
      client as never,
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
    assert.equal(headers['x-opencode-session'], undefined)
  })

  it('wire 要求 session 头但调用方漏传 sessionId 时，仍发出稳定的兜底 ID（否则上游 400）', async () => {
    const client = createProviderClient(
      opencodeOpenAi,
      resolveCapabilities('opencode-go'),
      { ...runtimeParams, model: 'deepseek-v4-flash' }, // 无 sessionId
    )
    const headers = await captureHeaders(
      client as never,
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
    assert.ok(headers['x-opencode-session'], '缺 sessionId 时必须有兜底 ID')
    const again = await captureHeaders(
      client as never,
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
    assert.equal(
      headers['x-opencode-session'],
      again['x-opencode-session'],
      '兜底 ID 进程内稳定——每请求随机会让上游无法做会话路由亲和',
    )
  })

  // 推理透传：capability 里 effortFormat='none' / thinkingBlockType='none' 会让
  // openai-client 两个分支都不写 reasoning_effort（L518-548），用户的档位选择被静默
  // 吞掉。上游实测接受 reasoning_effort（low/medium/high/max/xhigh 全 200），是否照
  // 档位调节由上游决定——但天枢的职责是把用户选的档位原样送到，不能丢。
  it('透传 reasoning_effort（配置档位不被 capability 静默吞掉）', async () => {
    const client = createProviderClient(
      opencodeOpenAi,
      resolveCapabilities('opencode-go'),
      { ...runtimeParams, model: 'deepseek-v4-flash', reasoningEffort: 'max', sessionId: 'session-abc-123' },
    )
    const { body } = await captureRequest(
      client as never,
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
    assert.equal(body.reasoning_effort, 'max')
    assert.equal(body.thinking, undefined, '不发 thinking 块——上游默认已返回 reasoning_content')
  })

  it('请求级 reasoning_effort 同样透传（侧路/worker 按次覆盖）', async () => {
    const client = createProviderClient(
      opencodeOpenAi,
      resolveCapabilities('opencode-go'),
      { ...runtimeParams, model: 'deepseek-v4-flash', sessionId: 'session-abc-123' },
    )
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const stream = new ReadableStream({
        start(startController) {
          startController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          startController.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch
    try {
      await client.stream(
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 16,
          reasoning_effort: 'high',
        } as never,
        { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: () => {} } as never,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(capturedBody.reasoning_effort, 'high')
  })
})
