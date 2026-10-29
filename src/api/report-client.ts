import { createProviderClient } from './factory.js'
import type { StreamClient } from './stream-client.js'

/** Independent instance: disabling report reasoning never changes the execution client. */
export function createReportClientFactory(
  provider: Parameters<typeof createProviderClient>[0],
  capabilities: Parameters<typeof createProviderClient>[1],
  params: Omit<Parameters<typeof createProviderClient>[2], 'maxTokens'>,
): () => StreamClient {
  return () => {
    const client = createProviderClient(provider.auth?.type === 'tianshu-account' ? provider : { ...provider, thinking: 'disabled', maxRetries: 0 }, capabilities, {
      ...params, maxTokens: 16_384, thinkingBudget: undefined, reasoningEffort: provider.auth?.type === 'tianshu-account' ? 'off' : undefined,
    })
    client.setThinking?.('disabled')
    return client
  }
}
