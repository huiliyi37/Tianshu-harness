import type { ProviderConfig } from '../config/schema.js'
import type { ResolvedModelTarget, ModelResolutionContext } from '../models/model-runtime.js'
import { isDeepStrictEqual } from 'node:util'
import { contractModels } from '../config/contract-models.js'
import { sessionProviderKey } from '../model/model-binding.js'
export { resolveProviderForModel } from '../models/model-runtime.js'
export type { ResolvedModelTarget, ModelResolutionContext } from '../models/model-runtime.js'

export function isCurrentModelTarget(ctx: ModelResolutionContext, currentModel: string | undefined, target: ResolvedModelTarget): boolean {
  if (currentModel !== target.modelId || ctx.apiKey !== target.apiKey || ctx.auth !== target.auth) return false
  try {
    if (sessionProviderKey(ctx.config.provider.providers, ctx.provider) !== target.providerName) return false
  } catch { return false }
  const contract = (provider: ProviderConfig) => {
    const { models: _models, keys, apiKey: _key, apiKeyEnv: _env, keyRef: _ref, ...settings } = provider
    return {
      settings,
      keyId: keys?.[0]?.id,
      model: contractModels(provider).find(model => model.id === currentModel),
    }
  }
  return isDeepStrictEqual(contract(ctx.provider), contract(target.provider))
}
