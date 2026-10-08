/**
 * model-resolution — 跨 provider / 多 key 模型与凭证解析。
 *
 * 从 src/bootstrap.ts 沿接缝拆出，以遵守 architecture-guards max-lines ratchet。
 * 供 switchAgentRuntime、startup resume、headless 等入口统一消费。
 */

import type { Config, ProviderConfig, ModelConfig, ProviderKeyConfig } from '../config/schema.js'
import type { AuthProvider } from '../auth/types.js'
import { createAuthProvider } from '../auth/registry.js'
import { canonicalizeModelId } from '../api/model-aliases.js'
import { contractModels } from '../config/contract-models.js'
import { resolveModelRef, findModelOwner, findModelInKey } from '../config/provider-keys.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import { tryResolveCredentialKey } from '../api/factory.js'

export interface ResolvedModelTarget {
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
}

interface ResolvedCredentials {
  apiKey: string
  auth: AuthProvider | undefined
}

type CredentialResult =
  | { ok: true; cred: ResolvedCredentials }
  | { ok: false; error: string }

function resolveCredentials(
  ctx: ModelResolutionContext,
  provName: string,
  prov: ProviderConfig,
  ownerKey: ProviderKeyConfig | null,
  pinnedKeyId?: string,
): CredentialResult {
  if (prov.auth?.type === 'oauth') {
    if (provName !== ctx.provider?.name) {
      const auth = createAuthProvider(prov.auth, process.env, prov.apiKey)
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
): ResolvedModelTarget {
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

  const auth = prov.auth?.type === 'oauth'
    ? (provName === ctx.provider?.name ? ctx.auth : cred.auth)
    : undefined

  return {
    provider: runtimeProvider,
    providerName: provName,
    apiKey: cred.apiKey,
    auth,
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
): ResolvedModelTarget | { error: string } | null {
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
