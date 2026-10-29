import type { ModelConfig, ProviderConfig } from '../config/schema.js'
import type { OfficialIdentityRef } from '../models/official-contract.js'
import { assertDefaultModelRef, contractModels } from '../config/contract-models.js'
import { resolveModelRef } from '../config/provider-keys.js'
import { getPreparedModel, isOfficialProvider, isPreparedModelEligible, resolveProviderForModel, type ModelResolutionContext } from '../models/model-runtime.js'
import { withCurrentOfficialIdentity } from '../auth/official-model-auth.js'
import { providerHasUsableAuth } from './model-spec-policy.js'
import { resolveSessionDefaults } from './session-defaults.js'

export interface SessionAutoDefault {
  modelRef: string
  kind: 'official' | 'known-byok'
  available: boolean
  provider: ProviderConfig
  model: ModelConfig
}

export function resolveSessionAutoDefault(
  cwd: string,
  context: ModelResolutionContext,
  published?: { identity: OfficialIdentityRef; providers: Readonly<Record<string, ProviderConfig>>; modelRefs: readonly string[] },
): SessionAutoDefault | undefined {
  const config = context.config
  const providers = { ...config.provider.providers }
  for (const [name, provider] of Object.entries(published?.providers ?? {})) {
    if (isOfficialProvider(provider) && (!providers[name] || isOfficialProvider(providers[name]!))) providers[name] = provider
  }
  const snapshot = { ...context, config: { ...config, provider: { ...config.provider, providers } } }
  const resolve = (modelRef: string): SessionAutoDefault | undefined => {
    const target = resolveProviderForModel(snapshot, modelRef)
    if (!target || 'error' in target) {
      if (config.agent.defaultModel !== modelRef) return undefined
      try {
        assertDefaultModelRef(providers, modelRef)
        const parsed = resolveModelRef(providers, modelRef)
        const provider = providers[parsed.provider!]!
        const models = parsed.keyId ? provider.keys?.find(key => key.id === parsed.keyId)?.models : contractModels(provider)
        const model = models?.find(entry => entry.id === parsed.modelRef)
        if (model && !isOfficialProvider(provider)) return { modelRef, kind: 'known-byok', available: false, provider, model }
      } catch {}
      return undefined
    }
    if (!isOfficialProvider(target.provider)) return { modelRef, kind: 'known-byok', available: !target.model.supportsImageGen && providerHasUsableAuth(target.providerName, target.provider), provider: target.provider, model: target.model }
    if (!published || published.providers[target.providerName] !== target.provider) return undefined
    try {
      return withCurrentOfficialIdentity(published.identity, () => {
        const prepared = getPreparedModel(target.provider, target.model.id)
        if (!isPreparedModelEligible(target.provider, target.model.id, 'agent')) return undefined
        return { modelRef, kind: 'official' as const, available: true, provider: target.provider, model: prepared.model }
      })
    } catch { return undefined }
  }
  const explicit = config.agent.defaultModel
  const normalRef = explicit || resolveSessionDefaults(cwd, undefined, 'qiming', () => config).modelRef
  const normal = normalRef ? resolve(normalRef) : undefined
  if (explicit || normal?.available) return normal
  for (const modelRef of published?.modelRefs ?? []) {
    const candidate = resolve(modelRef)
    if (candidate?.kind === 'official' && candidate.available) return candidate
  }
  return normal
}
