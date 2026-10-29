import { providerSchema, type ProviderConfig } from '../config/schema.js'
import { findModelInKey, findModelOwner } from '../config/provider-keys.js'
import { resolveApiKey, resolveCredentialKey } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import type { ProviderNetwork } from '../api/provider-network.js'
import { userConfigPath } from '../config/paths.js'
import { getPreparedModel, isOfficialProvider } from '../models/model-runtime.js'
import { OfficialError } from '../models/official-contract.js'

/** Serializable identity only; credentials never cross the worker protocol. */
export interface ModelBindingRef {
  provider: string
  model: string
  keyId?: string
  baseUrl?: string
  credentialPrincipal?: string
}

export type ModelUnavailableReason = 'provider_deleted' | 'model_deleted' | 'route_deleted' | 'missing_credentials' | 'oauth_not_authenticated'

export class ModelBindingUnavailable extends Error {
  /** 只含可序列化的身份；凭据、凭据主体与网关地址永不进入 worker 协议。 */
  readonly target?: Pick<ModelBindingRef, 'provider' | 'model' | 'keyId'>
  constructor(readonly reason: ModelUnavailableReason, target?: ModelBindingRef) {
    super(reason)
    this.name = 'ModelBindingUnavailable'
    if (target) this.target = { provider: target.provider, model: target.model, ...(target.keyId ? { keyId: target.keyId } : {}) }
  }

  /** 人读摘要：机器可读的 reason 保持不变（classifyWorkerError 与既有消费方按它匹配），
   *  额外补目标身份与**实际生效的**配置路径 + PID——主会话与 worker 可能连着不同实例，
   *  只报 model_deleted 让排查者无从判断该看哪份配置（2026-10-24 收编公开仓 PR #37）。 */
  describe(): string {
    if (!this.target) return this.reason
    return `${this.reason}: ${JSON.stringify(this.target)}; config=${JSON.stringify(userConfigPath())}; pid=${process.pid}`
  }
}

export function sessionProviderKey(providers: Record<string, ProviderConfig>, provider: ProviderConfig): string {
  const entries = Object.entries(providers)
  if (isOfficialProvider(provider)) {
    const model = provider.models[0]?.id
    if (!model) throw new ModelBindingUnavailable('provider_deleted')
    let prepared: ReturnType<typeof getPreparedModel>
    try { prepared = getPreparedModel(provider, model) }
    catch { throw new ModelBindingUnavailable('provider_deleted') }
    const candidates = entries.filter(([providerKey]) => {
      try {
        return resolveModelBinding(providers, { provider: providerKey, model, baseUrl: prepared.provider.baseUrl }, undefined, provider).provider === prepared.provider
      } catch { return false }
    })
    if (candidates.length !== 1) throw new ModelBindingUnavailable('provider_deleted')
    return candidates[0]![0]
  }
  const identities = entries.filter(([, configured]) => configured === provider)
  const sameCredentials = (left: Pick<ProviderConfig, 'keyRef' | 'apiKey' | 'apiKeyEnv'>, right: Pick<ProviderConfig, 'keyRef' | 'apiKey' | 'apiKeyEnv'>) =>
    left.keyRef === right.keyRef && left.apiKey === right.apiKey && left.apiKeyEnv === right.apiKeyEnv
  const sameAuth = (left: ProviderConfig['auth'], right: ProviderConfig['auth']) => left?.type === right?.type
    && (left?.type === 'oauth' ? right?.type === 'oauth' && left.provider === right.provider
      : left?.type === 'api-key' ? right?.type === 'api-key' && left.keyEnv === right.keyEnv : true)
  const candidates = identities.length ? identities : entries.filter(([, configured]) =>
    configured.name === provider.name && configured.baseUrl === provider.baseUrl && configured.protocol === provider.protocol
    && sameAuth(configured.auth, provider.auth)
    && (provider.keys?.length
      ? provider.keys.every(selected => configured.keys?.some(key => key.id === selected.id && sameCredentials(key, selected)
        && ((selected.keyRef || selected.apiKey || selected.apiKeyEnv) ? true : sameCredentials(configured, provider))))
      : sameCredentials(configured, provider)))
  if (candidates.length !== 1) throw new ModelBindingUnavailable('provider_deleted')
  return candidates[0]![0]
}

/** Exact lookup, with the same model-owner and credential rules as main sessions. */
export function resolveModelBinding(providers: Record<string, ProviderConfig>, target: ModelBindingRef, network?: ProviderNetwork, ownedProvider?: ProviderConfig) {
  const configured = providers[target.provider]
  if (!configured) throw new ModelBindingUnavailable('provider_deleted', target)
  const found = target.keyId
    ? findModelInKey(configured, target.keyId, target.model)
    : findModelOwner(configured, target.model)
  if (!found) throw new ModelBindingUnavailable('model_deleted', target)
  if (isOfficialProvider(configured)) {
    const authority = ownedProvider ?? configured
    if (!isOfficialProvider(authority) || authority.name !== configured.name) throw new OfficialError('auth_required', 401, false)
    const prepared = getPreparedModel(authority, found.model.id)
    if (configured.baseUrl !== prepared.provider.baseUrl && !providerSchema.safeParse(configured).success) throw new OfficialError('auth_required', 401, false)
    if (found.model.managed && found.model.managed.bindingId !== prepared.model.managed?.bindingId) throw new OfficialError('model_unavailable', 409, false)
    if (target.keyId !== undefined || target.baseUrl !== undefined && target.baseUrl !== prepared.provider.baseUrl) throw new OfficialError('model_unavailable', 409, false)
    return { provider: prepared.provider, apiKey: '', auth: undefined, spec: prepared.model, ref: {
      provider: target.provider, model: prepared.modelId, baseUrl: prepared.provider.baseUrl,
    } satisfies ModelBindingRef }
  }
  const provider = { ...configured, ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}) }
  let apiKey = ''
  let auth: ReturnType<typeof createAuthProvider> | undefined
  if (provider.auth?.type === 'oauth') {
    try {
      auth = createAuthProvider(provider.auth, process.env, provider.apiKey, { ...network, proxy: provider.proxy ?? network?.proxy })
      if (!auth.isAuthenticated()) throw new ModelBindingUnavailable('oauth_not_authenticated', target)
    } catch { throw new ModelBindingUnavailable('oauth_not_authenticated', target) }
  } else {
    const owner = found.owner
    try {
      apiKey = owner && (owner.keyRef || owner.apiKey || owner.apiKeyEnv)
        ? resolveCredentialKey({ name: provider.name, keyRef: owner.keyRef, apiKey: owner.apiKey, apiKeyEnv: owner.apiKeyEnv })
        : resolveApiKey(provider)
    } catch { throw new ModelBindingUnavailable('missing_credentials', target) }
  }
  return { provider, apiKey, auth, spec: found.model, ref: {
    provider: target.provider, model: found.model.id,
    ...(found.owner?.id ? { keyId: found.owner.id } : {}), baseUrl: provider.baseUrl,
  } satisfies ModelBindingRef }
}

export function modelBindingAvailability(providers: Record<string, ProviderConfig>, target: ModelBindingRef): ModelBindingRef & { available: boolean; reason?: ModelUnavailableReason } {
  try { resolveModelBinding(providers, target); return { ...target, available: true } }
  catch (error) {
    return { ...target, available: false, reason: error instanceof ModelBindingUnavailable ? error.reason : 'missing_credentials' as const }
  }
}

/** Identify the key already used by the root user session, including duplicate model IDs. */
export function snapshotSessionBinding(provider: ProviderConfig, model: string, apiKey: string, providerKey = provider.name): ModelBindingRef {
  if (isOfficialProvider(provider)) {
    const prepared = getPreparedModel(provider, model)
    return { provider: providerKey, model: prepared.modelId, baseUrl: prepared.provider.baseUrl }
  }
  const owner = provider.keys?.find(key => {
    if (!findModelInKey(provider, key.id, model)) return false
    try {
      return (key.keyRef || key.apiKey || key.apiKeyEnv
        ? resolveCredentialKey({ name: provider.name, keyRef: key.keyRef, apiKey: key.apiKey, apiKeyEnv: key.apiKeyEnv })
        : resolveApiKey(provider)) === apiKey
    } catch { return false }
  })
  if (provider.auth?.type !== 'oauth' && provider.keys?.length && !owner) throw new ModelBindingUnavailable('missing_credentials')
  return { provider: providerKey, model, ...(owner ? { keyId: owner.id } : {}), baseUrl: provider.baseUrl }
}
