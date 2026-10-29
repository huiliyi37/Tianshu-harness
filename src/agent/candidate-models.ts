import { OfficialError } from '../models/official-contract.js'
import { isOfficialProvider, isPreparedModelEligible, type ModelSubmission } from '../models/model-runtime.js'
/**
 * DP 副本 A/B 候选模型池推导（S4）。
 *
 * `config.provider.providers` 是 preset **全量快照**，不是「用户配了哪几家」
 * ——用户通常只有一两家有 key。未过滤的候选会把 DP 副本 2..N 路由到无凭据的
 * 提供商：副本必然失败、拉低 quorum 通过率，而失败原因（缺 key）在 galaxy
 * 报告里表现为普通的 worker 失败，归因困难。
 *
 * 凭据判定与 bootstrap 的 review-override / worker-routing 同口径。
 */

import { resolveApiKey } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import type { ProviderConfig } from '../config/schema.js'

export interface CandidateModel {
  provider: string
  model: string
}

/** 该 provider 当前是否真的能发出请求（OAuth 看登录态，其余看 key 解析）。 */
export function providerHasCredentials(provider: ProviderConfig): boolean {
  try {
    if (isOfficialProvider(provider)) return provider.models.some(model => { return isPreparedModelEligible(provider, model.id, 'agent') })
    if (provider.auth?.type === 'oauth') {
      return createAuthProvider(provider.auth, process.env).isAuthenticated()
    }
    return resolveApiKey(provider).length > 0
  } catch {
    // resolveApiKey 无 key 时抛错；判定失败一律视为不可用（fail-closed——
    // 宁可退化成「候选池为空、副本不轮换」的旧行为，也不派发注定失败的副本）。
    return false
  }
}

/**
 * 每个凭据就绪的 provider 取首个模型作为候选。
 *
 * `hasCredentials` 可注入以便测试——生产路径走 {@link providerHasCredentials}，
 * 其中 OAuth 分支要读 token 文件，调用方应缓存结果而非每副本重算。
 */
export function deriveCandidateModels(
  providers: Record<string, ProviderConfig> | undefined,
  hasCredentials: (provider: ProviderConfig) => boolean = providerHasCredentials,
): CandidateModel[] {
  const out: CandidateModel[] = []
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    const first = provider.models?.find(model => { if (model.supportsImageGen) return false; if (!isOfficialProvider(provider)) return true; return isPreparedModelEligible(provider, model.id, 'agent') })
    if (!first?.id) continue
    if (!hasCredentials(provider)) continue
    out.push({ provider: providerId, model: first.id })
  }
  return out
}

export async function resolveCandidateModels(providers: Record<string, ProviderConfig> | undefined, submission?: ModelSubmission, signal?: AbortSignal): Promise<CandidateModel[]> {
  const pinned = submission?.capture()
  const out: CandidateModel[] = []
  for (const [name, provider] of Object.entries(providers ?? {})) {
    signal?.throwIfAborted()
    if (!isOfficialProvider(provider)) { out.push(...deriveCandidateModels({ [name]: provider })); continue }
    if (!pinned) continue
    for (const model of provider.models) {
      try {
        const prepared = await pinned.prepareModel({ config: { provider: { providers } } as import('../config/schema.js').Config, provider, apiKey: '', modelId: model.id, targetProvider: name, purpose: 'agent', signal })
        if (isPreparedModelEligible(prepared.provider, prepared.modelId, 'agent')) { out.push({ provider: name, model: prepared.modelId }); break }
      } catch (error) {
        if (error instanceof OfficialError && ['model_unavailable', 'capability_unknown'].includes(error.code)) continue
        throw error
      }
    }
  }
  return out
}
