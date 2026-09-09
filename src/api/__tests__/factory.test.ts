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
