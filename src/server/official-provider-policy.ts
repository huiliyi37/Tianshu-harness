import { loadConfig } from '../config/manager.js'
import { isOfficialProvider } from '../models/model-runtime.js'
import type { RouteResponse } from './index.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function managedMetadata(value: unknown): boolean {
  const input = record(value)
  return !!input && (Object.hasOwn(input, 'managed') || record(input.auth)?.type === 'tianshu-account')
}

function officialProvider(name: string | undefined): boolean {
  if (name === 'tianshu-official') return true
  const provider = name ? loadConfig().provider.providers[name] : undefined
  return !!provider && isOfficialProvider(provider)
}

export function officialProviderMutationError(name: string | undefined, body: unknown): RouteResponse | undefined {
  const input = record(body)
  if (officialProvider(name) || managedMetadata(input) || managedMetadata(input?.model)
    || Array.isArray(input?.models) && input.models.some(managedMetadata)) {
    return { status: 403, body: { error: 'official_provider_read_only' } }
  }
}

export function officialProviderProbeError(name: string, body: unknown): RouteResponse | undefined {
  if (!officialProvider(name)) return
  const input = record(body) ?? {}
  const provider = loadConfig().provider.providers[name]
  if (!provider || ['apiKey', 'apiKeyEnv', 'keyRef', 'keys', 'auth', 'managed', 'endpointNetworkPolicy'].some(key => Object.hasOwn(input, key))
    || input.baseUrl !== undefined && input.baseUrl !== provider.baseUrl
    || input.protocol !== undefined && input.protocol !== provider.protocol) {
    return { status: 403, body: { error: 'official_provider_read_only' } }
  }
}
