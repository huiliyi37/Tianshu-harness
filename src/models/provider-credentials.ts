import type { ProviderConfig, ProviderKeyConfig } from '../config/schema.js'
import type { AuthProvider } from '../auth/types.js'
import type { ModelResolutionContext } from './model-runtime.js'
import { createAuthProvider } from '../auth/registry.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import { tryResolveCredentialKey } from '../api/factory.js'

export interface ResolvedCredentials {
  apiKey: string
  auth: AuthProvider | undefined
}

type CredentialResult =
  | { ok: true; cred: ResolvedCredentials }
  | { ok: false; error: string }

export function resolveCredentials(
  ctx: ModelResolutionContext,
  provName: string,
  prov: ProviderConfig,
  ownerKey: ProviderKeyConfig | null,
  pinnedKeyId?: string,
): CredentialResult {
  if (prov.auth?.type === 'tianshu-account') return { ok: true, cred: { apiKey: '', auth: ctx.provider === prov ? ctx.auth : undefined } }
  if (prov.auth?.type === 'oauth') {
    if (provName !== ctx.provider?.name) {
      const auth = createAuthProvider(prov.auth, process.env, prov.apiKey, { ...ctx.config.network, proxy: prov.proxy ?? ctx.config.network?.proxy })
      return { ok: true, cred: { apiKey: '', auth } }
    }
    return { ok: true, cred: { apiKey: ctx.apiKey, auth: ctx.auth } }
  }

  let provKey: string | undefined
  if (pinnedKeyId) {
    // 显式限定 key 时，仅从该 key 槽位解析凭据（不回退 provider 级默认凭据）
    provKey = ownerKey
      ? tryResolveCredentialKey({
          name: provName,
          keyRef: ownerKey.keyRef,
          apiKey: ownerKey.apiKey,
          apiKeyEnv: ownerKey.apiKeyEnv,
        })
      : undefined
  } else if (ownerKey && (ownerKey.keyRef || ownerKey.apiKey || ownerKey.apiKeyEnv)) {
    provKey = tryResolveCredentialKey({
      name: provName,
      keyRef: ownerKey.keyRef,
      apiKey: ownerKey.apiKey,
      apiKeyEnv: ownerKey.apiKeyEnv,
    })
  } else {
    provKey =
      prov.apiKey ??
      process.env[prov.apiKeyEnv ?? ''] ??
      tryResolveCredentialKey({
        name: provName,
        keyRef: prov.keyRef,
        apiKey: prov.apiKey,
        apiKeyEnv: prov.apiKeyEnv,
      })
  }

  if (provKey !== undefined && provKey !== '') {
    return { ok: true, cred: { apiKey: provKey, auth: undefined } }
  }

  // keyless provider（如 ollama / loopback 端点）免 key 放行
  if (isKeylessProviderEntry(provName, prov)) {
    return { ok: true, cred: { apiKey: '', auth: undefined } }
  }

  const missingEnvVar =
    (pinnedKeyId && ownerKey?.apiKeyEnv) || prov.apiKeyEnv || 'apiKey'
  return {
    ok: false,
    error: `API key not set for ${provName}. Set ${missingEnvVar} in config or environment.`,
  }
}
