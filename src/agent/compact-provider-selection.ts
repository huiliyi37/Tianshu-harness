import type { ProviderConfig } from '../config/schema.js'
import { contractModels } from '../config/contract-models.js'

export function resolveCompactProviderName(input: {
  compact: { provider?: string; model?: string }
  provider: ProviderConfig
  allProviders?: Record<string, ProviderConfig>
}): string | undefined {
  if (input.compact.provider) return input.compact.provider
  const model = input.compact.model
  if (!model) return undefined
  const hasModel = (prov: ProviderConfig) =>
    contractModels(prov).some(m => m.id === model)
  if (hasModel(input.provider)) return input.provider.name
  for (const [name, prov] of Object.entries(input.allProviders ?? {})) {
    if (hasModel(prov)) return name
  }
  return undefined
}
