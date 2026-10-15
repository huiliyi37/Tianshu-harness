import { hostname } from 'node:os'
import { z } from 'zod'
import { loadConfig, saveConfig } from '../config/manager.js'
import type { Config } from '../config/schema.js'

export const DEFAULT_FORUM_ENDPOINT = 'https://tianshuharness.com/token/v1/token-usage'

/** Credentials are accepted only over an authenticated write channel. */
export interface TokenLedgerSettings {
  enabled: boolean
  deviceName: string
  forum: { endpoint: string; apiKeyConfigured: boolean; apiKeySource: 'environment' | 'saved' | 'none'; autoSync: boolean; intervalMinutes: number }
}

export function isSafeLedgerEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.hash && !url.search &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}

export function readTokenLedgerSettings(config: Config): TokenLedgerSettings {
  const forum = config.tokenLedger.forum
  const candidateEndpoint = process.env.RIVET_FORUM_API || forum?.endpoint
  const environmentKey = process.env.RIVET_FORUM_TOKEN
  const effectiveKey = environmentKey || forum?.apiKey
  const apiKeyConfigured = Boolean(effectiveKey?.trim())
  return {
    enabled: config.tokenLedger.enabled !== false,
    deviceName: config.tokenLedger.deviceName || hostname(),
    forum: {
      endpoint: candidateEndpoint && isSafeLedgerEndpoint(candidateEndpoint) ? candidateEndpoint : DEFAULT_FORUM_ENDPOINT,
      apiKeyConfigured,
      apiKeySource: apiKeyConfigured ? (environmentKey ? 'environment' : 'saved') : 'none',
      autoSync: forum?.autoSync === true,
      intervalMinutes: forum?.intervalMinutes ?? 1,
    },
  }
}

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  deviceName: z.string().trim().min(1).max(128).optional(),
  forum: z.object({
    endpoint: z.string().trim().refine(isSafeLedgerEndpoint).optional(),
    apiKey: z.string().trim().max(4096).refine(value => value === '' || (!/\s|\*|[\x00-\x1f\x7f]/.test(value))).optional(),
    autoSync: z.boolean().optional(),
    intervalMinutes: z.number().int().min(1).max(1440).optional(),
  }).strict().optional(),
}).strict()

export function updateTokenLedgerSettings(
  patch: unknown,
  deps: { load?: () => Config; save?: (config: Config) => void } = {},
): Config {
  const parsed = patchSchema.safeParse(patch)
  // Zod diagnostics may embed the submitted credential. Keep errors controlled.
  if (!parsed.success) throw new Error('Invalid Token ledger settings')
  const config = (deps.load ?? loadConfig)()
  const input = parsed.data
  const forum = { ...config.tokenLedger.forum, ...input.forum }
  if (input.forum?.apiKey === '') { delete forum.apiKey; forum.autoSync = false }
  if (input.forum && !forum.endpoint) forum.endpoint = DEFAULT_FORUM_ENDPOINT
  if (input.forum && forum.autoSync === undefined) forum.autoSync = false
  if (forum.autoSync && !(process.env.RIVET_FORUM_TOKEN || forum.apiKey)?.trim()) {
    throw new Error('Configure a sync key before enabling automatic sync')
  }
  config.tokenLedger = { ...config.tokenLedger, ...input, ...(input.forum ? { forum } : {}) }
  ;(deps.save ?? saveConfig)(config)
  return config
}
