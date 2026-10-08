import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import type { StreamCallbacks } from '../stream-client.js'

describe('keyless model request authentication matches connect probing', () => {
  for (const apiKey of ['', 'fixture-configured-key']) {
    it(apiKey ? 'preserves a configured API key header' : 'omits authorization for a keyless endpoint', async () => {
      const originalFetch = globalThis.fetch
      let authorization: string | null = null
      globalThis.fetch = async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization')
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      try {
        const client = new OpenAIClient({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey, model: 'local/model:latest', maxTokens: 8_000, providerName: 'ollama' })
        const noop = () => {}
        const callbacks: StreamCallbacks = { onTextDelta: noop, onThinkingDelta: noop, onContentBlock: noop, onStopReason: noop, onError: error => { throw error } }
        await client.stream({ model: 'local/model:latest', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8_000 }, callbacks)
        assert.equal(authorization, apiKey ? `Bearer ${apiKey}` : null)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }
})
