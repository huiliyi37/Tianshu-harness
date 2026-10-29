import { closed, validatePurpose, thinkingCapabilities, publicModel } from './managed-model-policy.js'
/**
 * model-resolution — 跨 provider / 多 key 模型与凭证解析。
 *
 * 从 src/bootstrap.ts 沿接缝拆出，以遵守 architecture-guards max-lines ratchet。
 * 供 switchAgentRuntime、startup resume、headless 等入口统一消费。
 */

import type { Config, ProviderConfig, ModelConfig, ProviderKeyConfig } from '../config/schema.js'
import type { AuthProvider } from '../auth/types.js'
import { resolveCredentials, type ResolvedCredentials } from './provider-credentials.js'
import { canonicalizeModelId } from '../api/model-aliases.js'
import { contractModels } from '../config/contract-models.js'
import { resolveModelRef, findModelOwner, findModelInKey } from '../config/provider-keys.js'
import { createProviderClient } from '../api/factory.js'

export interface ResolvedModelTarget {
  model?: ModelConfig
  keyId?: string
  provider: ProviderConfig
  providerName: string
  apiKey: string
  auth: AuthProvider | undefined
  modelId: string
  contextWindow?: number
}

export interface ModelResolutionContext {
  config: Config
  provider: ProviderConfig
  apiKey: string
  auth?: AuthProvider
  signal?: AbortSignal
}


function getActiveKey(
  ctx: ModelResolutionContext,
  prov: ProviderConfig,
): ProviderKeyConfig | undefined {
  if (!ctx.provider || ctx.provider.name !== prov.name) return undefined
  if (ctx.provider.keys && ctx.provider.keys.length > 0) {
    const key0 = ctx.provider.keys[0]
    if (key0) {
      const matched = prov.keys?.find(k => k.id === key0.id)
      if (matched) return matched
    }
  }
  if (prov.keys && ctx.apiKey) {
    const matched = prov.keys.find(k => {
      if (k.apiKey && k.apiKey === ctx.apiKey) return true
      if (k.apiKeyEnv && process.env[k.apiKeyEnv] === ctx.apiKey) return true
      return false
    })
    if (matched) return matched
  }
  return undefined
}

function buildResolvedTarget(
  ctx: ModelResolutionContext,
  provName: string,
  prov: ProviderConfig,
  model: ModelConfig,
  cred: ResolvedCredentials,
  ownerKey: ProviderKeyConfig | null,
): ResolvedModelTarget & { model: ModelConfig } {
  let runtimeProvider: ProviderConfig = prov
  if (ownerKey && prov.keys && prov.keys.length > 0) {
    const { apiKey: _clearApiKey, apiKeyEnv: _clearApiKeyEnv, keyRef: _clearKeyRef, ...restProv } = prov
    runtimeProvider = {
      ...restProv,
      ...(ownerKey.apiKey !== undefined ? { apiKey: ownerKey.apiKey } : {}),
      ...(ownerKey.apiKeyEnv !== undefined ? { apiKeyEnv: ownerKey.apiKeyEnv } : {}),
      ...(ownerKey.keyRef !== undefined ? { keyRef: ownerKey.keyRef } : {}),
      keys: [ownerKey],
      models: ownerKey.models,
    }
  }

  const auth = prov.auth?.type === 'oauth' || prov.auth?.type === 'tianshu-account'
    ? (provName === ctx.provider?.name ? ctx.auth : cred.auth)
    : undefined

  return {
    provider: runtimeProvider,
    providerName: provName,
    apiKey: cred.apiKey,
    auth,
    model,
    ...(ownerKey ? { keyId: ownerKey.id } : {}),
    modelId: model.id,
    contextWindow: model.contextWindow,
  }
}

function findModelForProvider(
  ctx: ModelResolutionContext,
  provName: string,
  prov: ProviderConfig,
  modelRef: string,
  pinnedKeyId?: string,
): { model: ModelConfig; ownerKey: ProviderKeyConfig | null } | undefined {
  if (pinnedKeyId) {
    const owner = findModelInKey(prov, pinnedKeyId, modelRef)
    if (!owner) return undefined
    return { model: owner.model, ownerKey: owner.owner }
  }

  // 当前激活 provider 且未显式钉 key 时，优先保持已选中的 active key
  if (ctx.provider?.name === provName) {
    const activeKey = getActiveKey(ctx, prov)
    if (activeKey) {
      const owner = findModelInKey(prov, activeKey.id, modelRef)
      if (owner) {
        return { model: owner.model, ownerKey: owner.owner }
      }
    }
  }

  const owner = findModelOwner(prov, modelRef)
  if (owner) {
    return { model: owner.model, ownerKey: owner.owner }
  }

  const contractPool = contractModels(prov)
  const wanted = canonicalizeModelId(modelRef)
  const found = contractPool.find(m => m.id === modelRef)
    ?? (wanted !== modelRef ? contractPool.find(m => m.id === wanted) : undefined)
  if (found) {
    return { model: found, ownerKey: null }
  }
  return undefined
}

/**
 * 跨 provider / 多 key 解析目标模型及其凭证。
 *
 * 解析规则：
 * 1. 若显式指定 targetProvider，先对未拆分的原始 modelId 尝试在 targetProvider 的 contractModels 中精确匹配
 * 2. 经 resolveModelRef 消歧（处理 provider:keyId:modelId 与模型 id 自带冒号）
 * 3. 未显式限定 provider 时优先采用当前 provider；凭据缺失时直接报告，不静默借用其他账户
 * 4. 否则按配置顺序遍历各 provider 进行解析
 */
export function resolveProviderForModel(
  ctx: ModelResolutionContext,
  modelId: string,
  targetProvider?: string,
): (ResolvedModelTarget & { model: ModelConfig }) | { error: string } | null {
  const providers = ctx.config.provider.providers

  // 1. 显式 targetProvider 下原始 modelId 精确匹配优先（如包含冒号或斜杠的原始 id）
  if (targetProvider) {
    const targetProv = providers[targetProvider]
    if (targetProv) {
      const contractPool = contractModels(targetProv)
      const exactModel = contractPool.find(m => m.id === modelId)
      if (exactModel) {
        const hit = findModelForProvider(ctx, targetProvider, targetProv, modelId, undefined)
        const ownerKey = hit?.ownerKey ?? null
        const selectedModel = hit?.model ?? exactModel
        const credRes = resolveCredentials(ctx, targetProvider, targetProv, ownerKey, undefined)
        if (!credRes.ok) return { error: credRes.error }
        return buildResolvedTarget(ctx, targetProvider, targetProv, selectedModel, credRes.cred, ownerKey)
      }
    }
  }

  // 2. 命名空间解析
  const { provider: pinnedProvider, keyId: pinnedKeyId, modelRef } = resolveModelRef(
    providers,
    modelId,
    targetProvider,
  )
  const providerFilter = targetProvider ?? pinnedProvider
  if (!modelRef) return null

  // 3. 当前激活 provider 优先（未限定 provider 时）
  if (!providerFilter && ctx.provider?.name) {
    const activeName = ctx.provider.name
    const activeProv = providers[activeName]
    if (activeProv) {
      const activeHit = findModelForProvider(ctx, activeName, activeProv, modelRef, pinnedKeyId)
      if (activeHit) {
        const credRes = resolveCredentials(ctx, activeName, activeProv, activeHit.ownerKey, pinnedKeyId)
        if (!credRes.ok) {
          return { error: credRes.error }
        }
        return buildResolvedTarget(ctx, activeName, activeProv, activeHit.model, credRes.cred, activeHit.ownerKey)
      }
    }
  }

  // 4. 按配置顺序遍历所有 provider
  for (const [provName, prov] of Object.entries(providers)) {
    if (providerFilter && provName !== providerFilter) continue

    const hit = findModelForProvider(ctx, provName, prov, modelRef, pinnedKeyId)
    if (!hit) continue

    const credRes = resolveCredentials(ctx, provName, prov, hit.ownerKey, pinnedKeyId)
    if (!credRes.ok) {
      return { error: credRes.error }
    }
    return buildResolvedTarget(ctx, provName, prov, hit.model, credRes.cred, hit.ownerKey)
  }

  return null
}

// Official authority lives only in these process-local maps, never in JSON config.
import { createHash } from 'node:crypto'
import { captureOfficialIdentity, withCurrentOfficialIdentity, getOfficialCatalog, getOfficialCredential, getOfficialPriceQuote, getOfficialDirectAccess, peekOfficialDirectAccess, getOfficialDirectSignal, invalidateOfficialDirectAccess } from '../auth/official-model-auth.js'
import { OfficialError, type OfficialIdentityRef, type OfficialCredential, type OfficialDirectGrant, type Catalog, type Binding, type PriceQuote, type Purpose } from './official-contract.js'
import { resolveCapabilities, type ProviderCapabilities } from '../api/provider.js'
import { isModelRequestAuthorizer, sealModelRequestAuthorizer, type ModelRequestAuthorizer } from '../api/request-authorization.js'

export interface ModelRuntimeDeps {
  captureIdentity(): OfficialIdentityRef | null
  getCatalog(identity: OfficialIdentityRef, purpose: Purpose, signal?: AbortSignal): Promise<Catalog>
  getQuote(identity: OfficialIdentityRef, input: { bindingId: string; catalogRevision: string; pricingRevision: string }, signal?: AbortSignal): Promise<PriceQuote>
  getCredential(identity: OfficialIdentityRef): Promise<OfficialCredential>
  getDirectAccess?(identity: OfficialIdentityRef): Promise<OfficialDirectGrant | null>
  peekDirectAccess?(identity: OfficialIdentityRef): OfficialDirectGrant | null
  directSignal?(identity: OfficialIdentityRef): AbortSignal
  invalidateDirectAccess?(identity: OfficialIdentityRef): void
  withIdentity?<T>(identity: OfficialIdentityRef, action: (epoch: number) => T): T
  now(): number
}
export const defaultModelRuntimeDeps: ModelRuntimeDeps = { captureIdentity: captureOfficialIdentity, getCatalog: getOfficialCatalog, getQuote: getOfficialPriceQuote, getCredential: getOfficialCredential, getDirectAccess: getOfficialDirectAccess, peekDirectAccess: peekOfficialDirectAccess, directSignal: getOfficialDirectSignal, invalidateDirectAccess: invalidateOfficialDirectAccess, withIdentity: withCurrentOfficialIdentity, now: Date.now }
export interface ResolveModelInput extends ModelResolutionContext {
  modelId: string
  targetProvider?: string
  purpose: Purpose
  signal?: AbortSignal
  prepared?: PreparedModelRuntime
  scope?: ModelUserScope
}
export interface PreparedModelRuntime extends ResolvedModelTarget { readonly model: ModelConfig; readonly purpose: Purpose; readonly capabilities: ProviderCapabilities }
export interface ResolvedModelRuntime extends PreparedModelRuntime { requestAuth?: ModelRequestAuthorizer }
export interface ModelUserScope { readonly bindingId: string }
interface Authority { identity: OfficialIdentityRef; deps: ModelRuntimeDeps; catalog: Catalog; binding: Binding; sourceModel: Catalog['models'][number]; local: ModelConfig; provider: ProviderConfig; principal?: string; direct: boolean }
interface Scope { authority: Authority; catalog: Catalog; quotes: Map<string, Promise<PriceQuote>>; primary?: PriceQuote; signal?: AbortSignal; refused?: OfficialError }
const preparedAuthorities = new WeakMap<PreparedModelRuntime, Authority>()
const delegatedProviders = new WeakMap<ProviderConfig, Map<string, PreparedModelRuntime>>()
const delegatedMetadata = new WeakMap<ProviderConfig, Map<string, DelegatedModelSnapshot>>()
const providerAuthorities = new WeakMap<ProviderConfig, Map<string, PreparedModelRuntime>>()
const authIdentities = new WeakMap<AuthProvider, { identity: OfficialIdentityRef | null; deps: ModelRuntimeDeps }>()
const scopes = new WeakMap<ModelUserScope, Scope>()
export function createManagedAccountAuth(deps = defaultModelRuntimeDeps): AuthProvider {
  const identity = deps.captureIdentity()
  const auth: AuthProvider = { getHeaders: async () => { throw closed('auth_required') }, isAuthenticated: () => identity !== null, authenticate: async () => { throw closed('auth_required') }, dispose() {} }
  authIdentities.set(auth, { identity, deps })
  return auth
}
export function isOfficialProvider(provider: ProviderConfig): boolean { return provider.auth?.type === 'tianshu-account' }
export function getPreparedModel(provider: ProviderConfig, modelId: string): PreparedModelRuntime {
  const prepared = providerAuthorities.get(provider)?.get(modelId) ?? delegatedProviders.get(provider)?.get(modelId)
  if (!prepared) throw closed('auth_required')
  return prepared
}
export function isPreparedModelEligible(provider: ProviderConfig, modelId: string, purpose: Purpose): boolean {
  try {
    const prepared = providerAuthorities.get(provider)?.get(modelId) ?? delegatedProviders.get(provider)?.get(modelId)
    const authority = prepared && preparedAuthorities.get(prepared)
    const delegated = delegatedMetadata.get(provider)?.get(modelId)
    if (authority) validatePurpose(authority.sourceModel, authority.binding, purpose)
    else if (delegated) validatePurpose(delegated.sourceModel, delegated.binding, purpose)
    else return false
    return true
  } catch { return false }
}
export async function prepareModelRuntime(input: ResolveModelInput, deps = defaultModelRuntimeDeps): Promise<PreparedModelRuntime> {
  input.signal?.throwIfAborted()
  const selection = resolveProviderForModel(input, input.modelId, input.targetProvider)
  if (!selection || 'error' in selection) throw closed('model_unavailable')
  if (!isOfficialProvider(selection.provider)) return { ...selection, purpose: input.purpose, capabilities: resolveCapabilities(selection.provider.name, selection.provider.capabilities, selection.model.capabilities) }
  const old = providerAuthorities.get(selection.provider)?.get(selection.modelId)
  const previous = old && preparedAuthorities.get(old)
  const owner = input.auth && authIdentities.get(input.auth)
  const identity = owner ? owner.identity : previous ? previous.identity : deps.captureIdentity()
  deps = owner?.deps ?? previous?.deps ?? deps
  if (!identity) throw closed('auth_required')
  const catalog = await deps.getCatalog(identity, input.purpose, input.signal)
  input.signal?.throwIfAborted()
  const sourceModel = catalog.models.find(m => m.id === selection.modelId)
  if (!sourceModel) throw closed('model_unavailable')
  const candidates = sourceModel.bindings.filter(b => !selection.model.managed || b.id === selection.model.managed.bindingId)
  if (candidates.length !== 1) throw closed('model_unavailable')
  const binding = candidates[0]!
  validatePurpose(sourceModel, binding, input.purpose)
  const candidate = binding.billingMode === 'server' && binding.operation === 'chat' && binding.protocol === 'openai' ? await deps.getDirectAccess?.(identity) : null
  const direct = candidate?.bindingId === binding.id && candidate.modelId === binding.modelId ? candidate : null
  if (!direct) await deps.getCredential(identity)
  input.signal?.throwIfAborted()
  const capabilities = thinkingCapabilities(sourceModel, binding, selection.model, selection.provider)
  Object.freeze(capabilities.effortCap); Object.freeze(capabilities.stripParams); Object.freeze(capabilities)
  const model = publicModel(sourceModel, binding, selection.model, capabilities)
  Object.freeze(model.capabilities); Object.freeze(model.managed); Object.freeze(model)
  const provider = { ...selection.provider, auth: Object.freeze({ type: 'tianshu-account' as const }), protocol: binding.protocol, baseUrl: binding.origin, models: [model], keys: undefined, apiKey: undefined, apiKeyEnv: undefined, keyRef: undefined, capabilities: { ...model.capabilities, cacheControl: false, prefixCache: 'none' as const } }
  Object.freeze(provider.models); Object.freeze(provider.capabilities); Object.freeze(provider)
  const auth = (owner ? input.auth : selection.auth) ?? createManagedAccountAuth({ ...deps, captureIdentity: () => identity })
  authIdentities.set(auth, { identity, deps })
  const prepared: PreparedModelRuntime = Object.freeze({ ...selection, provider, auth, apiKey: '', model, modelId: model.id, contextWindow: model.contextWindow, purpose: input.purpose, capabilities })
  const principal = deps.withIdentity?.(identity, epoch => createHash('sha256').update(JSON.stringify([
    'official-owner-v1', identity.incarnation, identity.generation, identity.subject, identity.accountSessionId, identity.deviceId, epoch,
    binding.id, binding.modelId, binding.operation, binding.protocol, binding.origin, binding.path,
  ])).digest('hex'))
  const authority: Authority = { identity, deps, catalog, binding: structuredClone(binding), sourceModel: structuredClone(sourceModel), local: structuredClone(selection.model), provider, principal, direct: !!direct }
  if (direct) directCredential(authority)
  preparedAuthorities.set(prepared, authority)
  providerAuthorities.set(provider, new Map([[model.id, prepared]]))
  return prepared
}
function equivalentBinding(a: Binding, b: Binding): boolean { return JSON.stringify({ ...a, pricingRevision: '' }) === JSON.stringify({ ...b, pricingRevision: '' }) }
function directCredential(authority: Authority): OfficialDirectGrant {
  const grant = authority.deps.peekDirectAccess?.(authority.identity)
  const binding = authority.binding
  if (!grant || Date.parse(grant.expiresAt) <= authority.deps.now()) throw new OfficialError('service_error', 503, false)
  if (grant.subject !== authority.identity.subject || grant.accountSessionId !== authority.identity.accountSessionId) throw closed('account_changed')
  if (binding.billingMode !== 'server' || binding.protocol !== 'openai' || binding.operation !== 'chat' || grant.protocol !== binding.protocol || grant.bindingId !== binding.id || grant.modelId !== binding.modelId || grant.path !== binding.path || grant.catalogRevision !== authority.catalog.revision) throw closed('catalog_unavailable')
  return grant
}
async function checkAuthority(authority: Authority): Promise<void> {
  if (authority.direct) directCredential(authority)
  else await authority.deps.getCredential(authority.identity)
}
async function checkScope(scope: Scope): Promise<void> {
  scope.signal?.throwIfAborted()
  if (scope.refused) throw scope.refused
  if (scope.primary && Date.parse(scope.primary.validUntil) <= scope.authority.deps.now()) { scope.refused = closed('pricing_changed'); throw scope.refused }
  try { await checkAuthority(scope.authority) } catch (error) { scope.refused = error instanceof OfficialError ? error : new OfficialError('service_error', 503, false); throw scope.refused }
  scope.signal?.throwIfAborted()
  if (scope.refused) throw scope.refused
  if (scope.primary && Date.parse(scope.primary.validUntil) <= scope.authority.deps.now()) { scope.refused = closed('pricing_changed'); throw scope.refused }
}
async function quoteFor(authority: Authority, catalog: Catalog, signal?: AbortSignal): Promise<PriceQuote> {
  const source = catalog.models.find(m => m.id === authority.sourceModel.id)
  const binding = source?.bindings.find(b => b.id === authority.binding.id)
  if (!source || source.status !== 'available' || !binding || !equivalentBinding(binding, authority.binding) || JSON.stringify(source.capabilities) !== JSON.stringify(authority.sourceModel.capabilities) || source.contextWindow !== authority.sourceModel.contextWindow || source.maxOutputTokens !== authority.sourceModel.maxOutputTokens) throw closed('catalog_unavailable')
  signal?.throwIfAborted()
  const quote = await authority.deps.getQuote(authority.identity, { bindingId: binding.id, catalogRevision: catalog.revision, pricingRevision: binding.pricingRevision }, signal)
  signal?.throwIfAborted()
  await authority.deps.getCredential(authority.identity)
  signal?.throwIfAborted()
  if (quote.bindingId !== binding.id || quote.modelId !== binding.modelId || quote.pricingRevision !== binding.pricingRevision || quote.kind === 'unknown' || Date.parse(quote.asOf) > authority.deps.now() || Date.parse(quote.validUntil) <= authority.deps.now()) throw closed('pricing_changed')
  return Object.freeze(structuredClone(quote))
}
export async function beginModelUserScope(prepared: PreparedModelRuntime, signal?: AbortSignal): Promise<ModelUserScope> {
  const authority = preparedAuthorities.get(prepared)
  if (!authority) throw closed('auth_required')
  signal?.throwIfAborted()
  if (authority.binding.billingMode === 'server') {
    await checkAuthority(authority)
    signal?.throwIfAborted()
    const handle = Object.freeze({ bindingId: authority.binding.id })
    scopes.set(handle, { authority, catalog: authority.catalog, signal, quotes: new Map() })
    return handle
  }
  const catalog = await authority.deps.getCatalog(authority.identity, prepared.purpose === 'image-generation' || prepared.purpose === 'embedding' ? prepared.purpose : 'probe', signal)
  signal?.throwIfAborted()
  const primary = await quoteFor(authority, catalog, signal)
  const handle = Object.freeze({ bindingId: authority.binding.id })
  scopes.set(handle, { authority, catalog, primary, signal, quotes: new Map([[authority.binding.id, Promise.resolve(primary)]]) })
  return handle
}
function applyPolicy(authority: Authority, capabilities: ProviderCapabilities, body: Record<string, unknown>, effort?: string): void {
  if (body.model !== undefined && body.model !== authority.binding.modelId) throw closed('model_unavailable')
  if (Array.isArray(body.tools) && body.tools.length && (authority.sourceModel.capabilities?.tools !== true || authority.binding.capabilities?.tools !== true)) throw closed('capability_unknown')
  const hasImage = (value: unknown): boolean => Array.isArray(value) ? value.some(hasImage) : !!value && typeof value === 'object' && (['image', 'image_url', 'input_image'].includes(String((value as Record<string, unknown>).type)) || Object.hasOwn(value, 'inlineData') || Object.values(value).some(hasImage))
  if (hasImage(body) && (authority.local.supportsVision === false || authority.sourceModel.capabilities?.vision !== true || authority.binding.capabilities?.vision !== true)) throw closed('capability_unknown')
  delete body.thinking; delete body.reasoning_effort; delete body.reasoning; delete body.output_config
  const generation = body.generationConfig as Record<string, unknown> | undefined
  if (generation) generation.thinkingConfig = { thinkingBudget: 0 }
  for (const key of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) if (typeof body[key] === 'number') body[key] = Math.min(body[key] as number, authority.sourceModel.maxOutputTokens ?? 0)
  if (generation && typeof generation.maxOutputTokens === 'number') generation.maxOutputTokens = Math.min(generation.maxOutputTokens, authority.sourceModel.maxOutputTokens ?? 0)
  const selected = effort ?? authority.local.reasoningEffort ?? 'medium'
  if (!['off', 'low', 'medium', 'high', 'max'].includes(selected)) throw closed('capability_unknown')
  const enabled = capabilities.supportsThinking && selected !== 'off'
  const wire = capabilities.effortCap?.[selected] ?? selected
  const outputLimit = Number(body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens ?? generation?.maxOutputTokens ?? authority.sourceModel.maxOutputTokens ?? 1)
  const budget = Math.max(1, Math.min(outputLimit - 1, ({ low: 1024, medium: 8192, high: 16384, max: 32768 } as Record<string, number>)[wire] ?? 8192))
  switch (authority.binding.thinkingPolicy) {
    case 'reasoning_effort': if (enabled) { if (authority.binding.protocol === 'openai-responses') body.reasoning = { effort: wire }; else body.reasoning_effort = wire } break
    case 'thinking_budget': if (enabled) body.thinking = { type: 'enabled', budget_tokens: budget }; break
    case 'adaptive': if (enabled) { body.thinking = { type: 'adaptive' }; body.output_config = { effort: wire } } break
    case 'gemini_budget': if (enabled && generation) generation.thinkingConfig = { thinkingBudget: budget }; break
    case 'preserved_reasoning': body.thinking = { type: enabled ? 'enabled' : 'disabled' }; body.reasoning_effort = enabled ? wire : 'none'; break
  }
}
function authorizerFor(prepared: PreparedModelRuntime, getScope: () => ModelUserScope | undefined): ModelRequestAuthorizer {
  const authority = preparedAuthorities.get(prepared)
  if (!authority) throw closed('auth_required')
  const current = (): Scope => { const handle = getScope(); const scope = handle && scopes.get(handle); if (!scope || scope.authority.identity !== authority.identity || scope.authority.deps !== authority.deps) throw closed('auth_required'); return scope }
  const authorizer: ModelRequestAuthorizer = { async authorize(input) {
    const scope = current()
    await checkScope(scope)
    if (input.method !== 'POST' || input.operation !== authority.binding.operation) throw closed('model_unavailable')
    let quote = scope.quotes.get(authority.binding.id)
    if (!quote && authority.binding.billingMode !== 'server') {
      // R1 purpose views omit other operations; retain the original revision while
      // validating the auxiliary binding against its same-revision purpose view.
      if (authority.catalog.revision !== scope.catalog.revision) throw closed('catalog_unavailable')
      quote = quoteFor(authority, authority.catalog, scope.signal); scope.quotes.set(authority.binding.id, quote)
    }
    let accepted: PriceQuote | undefined
    try { accepted = await quote } catch (error) { scope.refused = error instanceof OfficialError ? error : new OfficialError('service_error', 503, false); throw scope.refused }
    const direct = authority.direct ? directCredential(authority) : undefined
    const credential = direct ?? await authority.deps.getCredential(authority.identity)
    scope.signal?.throwIfAborted()
    if (scope.refused) throw scope.refused
    if (scope.primary && Date.parse(scope.primary.validUntil) <= authority.deps.now()) { scope.refused = closed('pricing_changed'); throw scope.refused }
    if (accepted && Date.parse(accepted.validUntil) <= authority.deps.now()) { scope.refused = closed('pricing_changed'); throw scope.refused }
    const headers: Record<string, string> = {}
    for (const [name, value] of new Headers(input.headers)) if (['content-type', 'accept', 'anthropic-version'].includes(name)) headers[name] = value
    for (const [name, value] of Object.entries(authority.binding.requiredHeaders ?? {})) { const key = name.toLowerCase(); if (!['content-type', 'accept', 'anthropic-version'].includes(key) || /[\r\n]/.test(value)) throw closed('catalog_unavailable'); headers[key] = value }
    headers.authorization = `Bearer ${credential.credential}`
    if (direct) {
      if (input.url !== authority.binding.origin + authority.binding.path && input.url !== authority.binding.origin + '/chat/completions') throw closed('model_unavailable')
      delete headers['anthropic-version']
      return { url: direct.origin + direct.path, headers, redirect: 'error' }
    }
    headers['x-tianshu-binding-id'] = authority.binding.id
    if (authority.binding.billingMode === 'server') headers['x-tianshu-billing-mode'] = 'server'
    else {
      if (!accepted) throw closed('pricing_changed')
      headers['x-tianshu-catalog-revision'] = scope.catalog.revision
      headers['x-tianshu-pricing-revision'] = accepted.pricingRevision
      headers['x-tianshu-quote-id'] = accepted.quoteId
    }
    return { url: authority.binding.origin + authority.binding.path, headers, redirect: 'error' }
  } }
  return sealModelRequestAuthorizer(authorizer, { owner: prepared, model: prepared.modelId, principal: authority.principal, direct: authority.direct, ...(authority.direct ? { signal: () => { const signal = authority.deps.directSignal?.(authority.identity); if (!signal) throw closed('auth_required'); return signal } } : {}), capture: () => { const handle = getScope(); current(); return authorizerFor(prepared, () => handle) }, check: () => checkScope(current()), refuse: error => { current().refused = error; if (authority.direct && ['credential_revoked', 'insufficient_balance'].includes(error.code)) { try { authority.deps.invalidateDirectAccess?.(authority.identity) } catch {} } }, policy: (body, effort) => applyPolicy(authority, prepared.capabilities, body, effort) })
}
/** Node-only capability. Captures never follow a subsequent root submission. */
export interface ModelSubmission {
  prepare(signal: AbortSignal): Promise<void>
  forModel(provider: ProviderConfig, model: string): ModelRequestAuthorizer | undefined
  capture(): ModelSubmission
  prepareModel(input: ResolveModelInput): Promise<PreparedModelRuntime>
  resolve(input: ResolveModelInput): Promise<ResolvedModelRuntime>
  standaloneResolve(input: ResolveModelInput): Promise<ResolvedModelRuntime>
  check(): Promise<void>
  settle(): void
  onSettlement(): () => void
  afterPrepare(listener: () => void): () => void
}
const submissionBoundaries = new WeakMap<ModelSubmission, () => SubmissionBoundary | undefined>()
interface ScopeOpening { controller: AbortController; promise: Promise<ModelUserScope>; consumers: number }
interface SubmissionBoundary { signal: AbortSignal; controller: AbortController; scope?: ModelUserScope; opening?: ScopeOpening; retired: boolean }
function awaitLive<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
export function createModelSubmission(provider: ProviderConfig, model: string, providers?: Record<string, ProviderConfig>): ModelSubmission | undefined {
  const primary = isOfficialProvider(provider) ? getPreparedModel(provider, model) : undefined
  if (!primary && !Object.values(providers ?? {}).some(isOfficialProvider)) return undefined
  // Even a missing source is retained; a later login cannot replace it.
  const auth = primary?.auth ?? createManagedAccountAuth()
  const source = auth && authIdentities.get(auth)
  const listeners = new Set<() => void>()
  let current: SubmissionBoundary | undefined
  const active = (boundary: SubmissionBoundary | undefined): SubmissionBoundary => {
    if (!boundary || boundary.retired) throw closed('auth_required')
    boundary.signal.throwIfAborted()
    return boundary
  }
  const check = async (boundary: SubmissionBoundary | undefined): Promise<void> => {
    const b = active(boundary)
    if (!source?.identity) throw closed('auth_required')
    await source.deps.getCredential(source.identity)
    active(b)
    if (b.scope) await checkScope(scopes.get(b.scope)!)
    active(b)
  }
  const retire = (b: SubmissionBoundary | undefined) => { if (b) { b.retired = true; b.controller.abort(closed('auth_required')); const scope = b.scope && scopes.get(b.scope); if (scope) scope.refused ??= closed('auth_required') } }
  const openScope = async (b: SubmissionBoundary, prepared: PreparedModelRuntime, signal: AbortSignal): Promise<ModelUserScope> => {
    active(b); signal.throwIfAborted()
    if (b.scope) return b.scope
    let entry = b.opening
    if (!entry) {
      const controller = new AbortController()
      const openingSignal = AbortSignal.any([b.signal, controller.signal])
      entry = { controller, consumers: 0, promise: undefined! }
      const owned = entry
      b.opening = owned
      owned.promise = beginModelUserScope(prepared, openingSignal).then(scope => {
        active(b); openingSignal.throwIfAborted()
        if (b.opening !== owned || owned.consumers === 0) throw closed('auth_required')
        // Once accepted, scope lifetime belongs to the root, not a preparer.
        scopes.get(scope)!.signal = b.signal
        b.scope = scope
        return scope
      }).finally(() => { if (b.opening === owned) b.opening = undefined })
    }
    entry.consumers++
    try { return await awaitLive(entry.promise, signal) }
    finally {
      entry.consumers--
      if (!entry.consumers && !b.scope) {
        entry.controller.abort(closed('auth_required'))
        if (b.opening === entry) b.opening = undefined
      }
    }
  }
  const view = (get: () => SubmissionBoundary | undefined, root: boolean): ModelSubmission => { const result: ModelSubmission = {
    async prepare(signal) {
      if (!root) { const b = active(get()); if (b.opening) { await b.opening.promise; await check(b) }; return }
      retire(current)
      const controller = new AbortController()
      const b: SubmissionBoundary = { signal: AbortSignal.any([signal, controller.signal]), controller, retired: false }
      current = b
      // BYOK roots record a boundary without requiring a managed account.
      if (primary) {
        await check(b)
        await openScope(b, primary, b.signal)
        await check(b)
      }
      for (const listener of listeners) listener()
    },
    afterPrepare(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    forModel(p, id) {
      if (!isOfficialProvider(p)) return undefined
      const prepared = getPreparedModel(p, id)
      if (!source?.identity || preparedAuthorities.get(prepared)?.identity !== source.identity) throw closed('auth_required')
      return authorizerFor(prepared, () => { const b = active(get()); return b.scope })
    },
    capture() { const b = get(); return view(() => b, false) },
    async standaloneResolve(input) {
      if (!root || !source?.identity) throw closed('auth_required')
      await source.deps.getCredential(source.identity)
      return resolveModelRuntime({ ...input, auth }, source.deps)
    },
    async prepareModel(input) {
      const b = active(get())
      const signal = input.signal ? AbortSignal.any([b.signal, input.signal]) : b.signal
      signal.throwIfAborted()
      await check(b)
      signal.throwIfAborted()
      const selected = resolveProviderForModel(input, input.modelId, input.targetProvider)
      const existing = input.prepared ?? (selected && !('error' in selected) ? providerAuthorities.get(selected.provider)?.get(selected.modelId) : undefined) ?? providerAuthorities.get(input.provider)?.get(input.modelId)
      if (existing && preparedAuthorities.get(existing)?.identity !== source?.identity) throw closed('auth_required')
      const prepared = await prepareModelRuntime({ ...input, auth, signal }, source!.deps)
      signal.throwIfAborted()
      await check(b)
      if (isOfficialProvider(prepared.provider) && preparedAuthorities.get(prepared)?.identity !== source?.identity) throw closed('auth_required')
      return prepared
    },
    async resolve(input) {
      const b = active(get())
      const signal = input.signal ? AbortSignal.any([b.signal, input.signal]) : b.signal
      const prepared = await result.prepareModel({ ...input, signal })
      if (!isOfficialProvider(prepared.provider)) return prepared
      await openScope(b, prepared, signal)
      signal.throwIfAborted()
      await check(b)
      const requestAuth = authorizerFor(prepared, () => { active(b); return b.scope })
      return { ...prepared, requestAuth }
    },
    check: () => check(get()),
    settle() { if (root) retire(get()) },
    onSettlement() { const b = get(); return () => { if (root) retire(b) } },
  }; submissionBoundaries.set(result, get); return result }
  return view(() => current, true)
}

/** Defers managed auxiliary preparation until its original user boundary exists. */
export function createSubmissionClient(input: ResolveModelInput, submission: ModelSubmission, params: Omit<Parameters<typeof createProviderClient>[2], 'apiKey' | 'model'>): import('../api/stream-client.js').StreamClient {
  let thinking: 'enabled' | 'disabled' | undefined
  let effort: string | undefined
  const clients = new WeakMap<object, import('../api/stream-client.js').StreamClient>()
  let client: import('../api/stream-client.js').StreamClient | undefined
  return {
    async stream(request, callbacks, signal) {
      const pinned = submission.capture()
      await pinned.check()
      const boundary = submissionBoundaries.get(pinned)?.() ?? pinned
      client = clients.get(boundary)
      if (!client) {
        // Each pending stream is a live preparation consumer. Only accepted
        // clients are reusable; a cancelled first caller cannot poison siblings.
        const runtime = await pinned.resolve({ ...input, signal })
        signal?.throwIfAborted()
        client = createProviderClient(runtime.provider, runtime.capabilities, { ...params, apiKey: runtime.apiKey, model: runtime.modelId, auth: runtime.auth, requestAuth: runtime.requestAuth })
        clients.set(boundary, client)
      }
      if (thinking) client.setThinking?.(thinking)
      if (effort) client.setReasoningEffort?.(effort)
      await client.stream(request, callbacks, signal)
    },
    setThinking(value) { thinking = value; client?.setThinking?.(value) },
    setReasoningEffort(value) { effort = value; client?.setReasoningEffort?.(value) },
    consumeWireDivergence: () => client?.consumeWireDivergence?.() ?? null,
    getMainPrefixProof: () => client?.getMainPrefixProof?.(),
  }
}
export async function resolveModelRuntime(input: ResolveModelInput, deps = defaultModelRuntimeDeps): Promise<ResolvedModelRuntime> {
  const prepared = input.prepared ?? await prepareModelRuntime(input, deps)
  if (!isOfficialProvider(prepared.provider)) return prepared
  const scope = input.scope ?? await beginModelUserScope(prepared, input.signal)
  return { ...prepared, requestAuth: authorizerFor(prepared, () => scope) }
}

async function reusablePreparedModel(context: ModelResolutionContext, target: ResolvedModelTarget, purpose: Purpose, signal?: AbortSignal): Promise<PreparedModelRuntime | null> {
  signal?.throwIfAborted()
  const prepared = providerAuthorities.get(target.provider)?.get(target.modelId)
  const authority = prepared && preparedAuthorities.get(prepared)
  const owner = context.auth && authIdentities.get(context.auth)
  if (!prepared || !authority || prepared.purpose !== purpose || prepared.auth !== context.auth || owner?.identity !== authority.identity || owner.deps !== authority.deps) return null
  validatePurpose(authority.sourceModel, authority.binding, purpose)
  await authority.deps.getCredential(authority.identity)
  signal?.throwIfAborted()
  return prepared
}

/** Async normal entrypoint. BYOK callers retain the synchronous selector above. */
export async function prepareRuntimeContext<T extends ModelResolutionContext>(context: T, modelId?: string, purpose: Purpose = 'agent', deps = defaultModelRuntimeDeps, options: { reusePrepared?: boolean; signal?: AbortSignal } = {}): Promise<T & { model: ModelConfig }> {
  const signal = options.signal ?? context.signal
  signal?.throwIfAborted()
  const wanted = modelId ?? contractModels(context.provider)[0]?.id
  if (!wanted) throw closed('model_unavailable')
  const target = resolveProviderForModel(context, wanted)
  if (!target || 'error' in target) throw closed('model_unavailable')
  if (!isOfficialProvider(target.provider)) return { ...context, ...target }
  const primary = (options.reusePrepared ? await reusablePreparedModel(context, target, purpose, signal) : null)
    ?? await prepareModelRuntime({ ...context, modelId: wanted, purpose, signal }, deps)
  const providers = { ...context.config.provider.providers }
  for (const [name, configured] of Object.entries(providers)) {
    if (!isOfficialProvider(configured)) continue
    const models = new Map<string, PreparedModelRuntime>()
    if (name === primary.providerName) models.set(primary.modelId, primary)
    for (const model of contractModels(configured)) {
      if (models.has(model.id) || model.supportsImageGen) continue
      try {
        const prepared = await prepareModelRuntime({ ...context, auth: primary.auth, modelId: model.id, targetProvider: name, purpose: 'probe', signal }, deps)
        models.set(model.id, prepared)
      } catch (error) {
        if (error instanceof OfficialError && ['model_unavailable', 'capability_unknown'].includes(error.code)) continue
        throw error
      }
    }
    const publicView = { ...configured, auth: Object.freeze({ type: 'tianshu-account' as const }), models: [...models.values()].map(value => value.model).concat(contractModels(configured).filter(model => model.supportsImageGen)), keys: undefined }
    Object.freeze(publicView.models); Object.freeze(publicView)
    providerAuthorities.set(publicView, models)
    providers[name] = publicView
  }
  // The selected exact view also exposes its prepared auxiliary bindings.
  const own = providers[primary.providerName]!
  providerAuthorities.set(primary.provider, providerAuthorities.get(own)!)
  providers[primary.providerName] = own
  providerAuthorities.set(providers[primary.providerName]!, providerAuthorities.get(own)!)
  return { ...context, ...primary, config: { ...context.config, provider: { ...context.config.provider, providers } } }
}

/** Public routing facts; this projection is never an R1 identity capability. */
export interface DelegatedModelSnapshot {
  direct?: boolean
  identity: OfficialIdentityRef
  principal?: string
  provider: ProviderConfig
  model: ModelConfig
  purpose: Purpose
  capabilities: ProviderCapabilities
  binding: Binding
  sourceModel: Catalog['models'][number]
  local: ModelConfig
  catalogRevision: string
}
export function exportModelDelegation(runtime: ResolvedModelRuntime): DelegatedModelSnapshot {
  const prepared = getPreparedModel(runtime.provider, runtime.modelId)
  const authority = preparedAuthorities.get(prepared)
  if (!authority || !isModelRequestAuthorizer(runtime.requestAuth, prepared)) throw closed('auth_required')
  return exportPreparedModelDelegation(prepared)
}
export function exportPreparedModelDelegation(prepared: PreparedModelRuntime): DelegatedModelSnapshot {
  const authority = preparedAuthorities.get(prepared)
  if (!authority) throw closed('auth_required')
  return structuredClone({ identity: authority.identity, principal: authority.principal, direct: authority.direct, provider: prepared.provider, model: prepared.model, purpose: prepared.purpose, capabilities: prepared.capabilities, binding: authority.binding, sourceModel: authority.sourceModel, local: authority.local, catalogRevision: authority.catalog.revision })
}
export interface WorkerModelSelection { selectionId: string; providerName: string; modelId: string; purpose: Purpose }
export function createDelegatedSubmission(initial: readonly DelegatedModelSnapshot[], transport: {
  signal?: AbortSignal
  authorize(snapshot: DelegatedModelSnapshot, input: Parameters<ModelRequestAuthorizer['authorize']>[0]): ReturnType<ModelRequestAuthorizer['authorize']>
  check(snapshot: DelegatedModelSnapshot): Promise<void>
  refuse(snapshot: DelegatedModelSnapshot, error: OfficialError): void
  prepare?(selection: WorkerModelSelection, mode?: 'runtime' | 'metadata', signal?: AbortSignal): Promise<DelegatedModelSnapshot>
}, selections: readonly WorkerModelSelection[] = []): { submission: ModelSubmission; runtimes: ResolvedModelRuntime[] } {
  // Only live, correlated channel responses enter this separate owner map.
  const snapshots: DelegatedModelSnapshot[] = []
  const runtimes: ResolvedModelRuntime[] = []
  const install = (snapshot: DelegatedModelSnapshot): ResolvedModelRuntime => {
    if (snapshot.direct !== undefined && typeof snapshot.direct !== 'boolean') throw closed('auth_required')
    if (snapshot.principal !== undefined && (typeof snapshot.principal !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.principal))) throw closed('auth_required')
    validatePurpose(snapshot.sourceModel, snapshot.binding, snapshot.purpose)
    if (snapshot.model.id !== snapshot.binding.modelId || snapshot.model.managed?.bindingId !== snapshot.binding.id || snapshot.provider.protocol !== snapshot.binding.protocol || snapshot.provider.baseUrl !== snapshot.binding.origin) throw closed('model_unavailable')
    const provider = Object.freeze(structuredClone(snapshot.provider))
    const prepared: PreparedModelRuntime = Object.freeze({ provider, providerName: provider.name, model: snapshot.model, modelId: snapshot.model.id, apiKey: '', auth: undefined, purpose: snapshot.purpose, capabilities: snapshot.capabilities, contextWindow: snapshot.model.contextWindow })
    const authorizer: ModelRequestAuthorizer = { authorize: input => transport.authorize(snapshot, input) }
    sealModelRequestAuthorizer(authorizer, { owner: prepared, model: prepared.modelId, principal: snapshot.principal, direct: snapshot.direct === true, ...(transport.signal ? { signal: () => transport.signal! } : {}), capture: () => authorizer, check: () => transport.check(snapshot), refuse: error => transport.refuse(snapshot, error), policy: (body, effort) => applyPolicy({ binding: snapshot.binding, sourceModel: snapshot.sourceModel, local: snapshot.local } as Authority, snapshot.capabilities, body, effort) })
    delegatedProviders.set(provider, new Map([[prepared.modelId, prepared]]))
    delegatedMetadata.set(provider, new Map([[prepared.modelId, snapshot]]))
    const runtime = { ...prepared, requestAuth: authorizer }
    snapshots.push(snapshot); runtimes.push(runtime)
    return runtime
  }
  initial.forEach(install)
  const find = (p: ProviderConfig, id: string) => runtimes.find(r => r.provider.name === p.name && r.modelId === id)
  const prepareSnapshot = async (input: ResolveModelInput, mode: 'runtime' | 'metadata'): Promise<DelegatedModelSnapshot> => {
    const selection = selections.find(s => s.providerName === input.provider.name && s.modelId === input.modelId && s.purpose === input.purpose)
    if (!selection || !transport.prepare) throw closed('model_unavailable')
    const snapshot = await transport.prepare(selection, mode, input.signal)
    input.signal?.throwIfAborted()
    if (snapshot.provider.name !== selection.providerName || snapshot.model.id !== selection.modelId || snapshot.purpose !== selection.purpose) throw closed('model_unavailable')
    validatePurpose(snapshot.sourceModel, snapshot.binding, input.purpose)
    if (snapshot.model.id !== snapshot.binding.modelId || snapshot.model.managed?.bindingId !== snapshot.binding.id || snapshot.provider.protocol !== snapshot.binding.protocol || snapshot.provider.baseUrl !== snapshot.binding.origin) throw closed('model_unavailable')
    return snapshot
  }
  const submission: ModelSubmission = {
    prepare: async signal => { signal.throwIfAborted(); await submission.check() },
    check: async () => { for (const snapshot of snapshots) await transport.check(snapshot) },
    forModel: (p, id) => { const runtime = find(p, id); if (!runtime) throw closed('model_unavailable'); return runtime.requestAuth },
    capture: () => submission,
    standaloneResolve: async () => { throw closed('auth_required') },
    async prepareModel(input) {
      input.signal?.throwIfAborted()
      const runtime = find(input.provider, input.modelId)
      if (runtime) { const snapshot = snapshots[runtimes.indexOf(runtime)]!; validatePurpose(snapshot.sourceModel, snapshot.binding, input.purpose); await transport.check(snapshot); input.signal?.throwIfAborted(); return runtime }
      const snapshot = await prepareSnapshot(input, 'metadata')
      const provider = Object.freeze(structuredClone(snapshot.provider))
      delegatedMetadata.set(provider, new Map([[snapshot.model.id, snapshot]]))
      return Object.freeze({ provider, providerName: provider.name, model: snapshot.model, modelId: snapshot.model.id, apiKey: '', auth: undefined, purpose: snapshot.purpose, capabilities: snapshot.capabilities, contextWindow: snapshot.model.contextWindow })
    },
    async resolve(input) {
      input.signal?.throwIfAborted()
      let runtime = find(input.provider, input.modelId)
      if (!runtime) {
        const snapshot = await prepareSnapshot(input, 'runtime')
        await transport.check(snapshot)
        input.signal?.throwIfAborted()
        runtime = find(input.provider, input.modelId) ?? install(snapshot)
      }
      const snapshot = snapshots[runtimes.indexOf(runtime)]!
      validatePurpose(snapshot.sourceModel, snapshot.binding, input.purpose)
      await transport.check(snapshot)
      input.signal?.throwIfAborted()
      return runtime
    },
    settle() {}, onSettlement: () => () => {}, afterPrepare: () => () => {},
  }
  return { submission, runtimes }
}

export function originalRuntimeIdentity(runtime: ResolvedModelRuntime): OfficialIdentityRef {
  const owner = getPreparedModel(runtime.provider, runtime.modelId)
  const authority = preparedAuthorities.get(owner)
  if (!authority || !isModelRequestAuthorizer(runtime.requestAuth, owner)) throw closed('auth_required')
  return authority.identity
}

/** Explicit standalone auxiliary calls capture their account before any async work. */
export function createPurposeClient(providers: Record<string, ProviderConfig>, provider: ProviderConfig, modelId: string, purpose: Purpose, params: Omit<Parameters<typeof createProviderClient>[2], 'apiKey' | 'model'>, submission?: ModelSubmission, standalone = false): import('../api/stream-client.js').StreamClient {
  const input = { config: { provider: { providers } } as Config, provider, apiKey: '', auth: submission ? undefined : createManagedAccountAuth(), modelId, targetProvider: provider.name, purpose }
  if (submission && !standalone) return createSubmissionClient(input, submission, params)
  let client: import('../api/stream-client.js').StreamClient | undefined
  return {
    async stream(request, callbacks, signal) {
      const runtime = await (submission ? submission.standaloneResolve({ ...input, signal }) : resolveModelRuntime({ ...input, signal }))
      client = createProviderClient(runtime.provider, runtime.capabilities, { ...params, apiKey: '', auth: runtime.auth, model: runtime.modelId, requestAuth: runtime.requestAuth })
      await client.stream(request, callbacks, signal)
    },
  }
}
