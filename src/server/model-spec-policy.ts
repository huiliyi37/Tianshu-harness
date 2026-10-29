import { getPreparedModel, isOfficialProvider } from '../models/model-runtime.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import { resolveApiKey, resolveCredentialKey } from '../api/factory.js'
import { contractModels } from '../config/contract-models.js'
import { createAuthProvider } from '../auth/registry.js'
import type { ProviderConfig } from '../config/schema.js'
import type { ResolvedModelSpec } from './serve.js'

export function providerHasUsableAuth(provName: string, prov: ProviderConfig): boolean {
  if (isOfficialProvider(prov)) {
    try { return contractModels(prov).some(model => !!getPreparedModel(prov, model.id)) } catch { return false }
  }
  if (isKeylessProviderEntry(provName, prov)) return true
  if (prov.auth?.type === 'oauth') {
    try {
      return createAuthProvider(prov.auth, process.env, prov.apiKey).isAuthenticated()
    } catch {
      return false
    }
  }
  try {
    if (resolveApiKey(prov).length > 0) return true
  } catch {  }
  return (prov.keys ?? []).some(key => {
    if (!(key.keyRef || key.apiKey || key.apiKeyEnv)) return false
    try {
      return resolveCredentialKey({ name: provName, keyRef: key.keyRef, apiKey: key.apiKey, apiKeyEnv: key.apiKeyEnv }).length > 0
    } catch { return false }
  })
}

export function isModelSpecUsable(spec: ResolvedModelSpec): boolean {
  return isOfficialProvider(spec.provider) || isKeylessProviderEntry(spec.provider.name, spec.provider) || spec.apiKey !== '' || !!spec.auth
}

export function unconfiguredSpecMessage(spec: ResolvedModelSpec): string {
  const provider = spec.provider.name
  const envHint = spec.provider.apiKeyEnv
    ? ` The provider is configured to read its key from the \`${spec.provider.apiKeyEnv}\` environment variable, which is not set in this process (a common cause after a sidecar restart). Set it and relaunch, or store the key inline via Settings.`
    : ' Configure it in Settings (or run `rivet config setup`).'
  return `No usable API key for provider "${provider}" — the request was not sent.${envHint}`
}
