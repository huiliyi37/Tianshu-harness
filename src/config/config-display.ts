import type { Config } from './schema.js'

function maskEndpoint(value: string): string {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? value : '***'
  } catch {
    return '***'
  }
}

/** Mask every credential in a config snapshot for display (`config show`).
 *  provider.apiKey may be a secrets-store value materialized by loadConfig. */
function maskKey(value: string | undefined): string | undefined {
  if (!value) return value
  return '***' + value.slice(-4)
}

export function maskConfigSecrets(config: Config): Config {
  const masked = structuredClone(config)
  for (const provider of Object.values(masked.provider.providers)) provider.apiKey = maskKey(provider.apiKey)
  const forum = masked.tokenLedger.forum
  if (forum?.apiKey) forum.apiKey = '***'
  if (forum?.endpoint) forum.endpoint = maskEndpoint(forum.endpoint)
  const search = masked.search
  if (search) {
    search.bochaApiKey = maskKey(search.bochaApiKey)
    search.braveApiKey = maskKey(search.braveApiKey)
    search.tavilyApiKey = maskKey(search.tavilyApiKey)
  }
  return masked
}
