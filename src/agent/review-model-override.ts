/**
 * Review worker model override resolution.
 *
 * Pure functions that translate the `review.profiles` config block into a
 * concrete provider+model lookup for review worker dispatch.
 *
 * Why this exists: server-side prefix caches (GLM/Kimi implicit caches, Codex)
 * are evicted when a concurrent review worker (running with the same primary
 * model + API key) issues requests against a different prompt. Routing the
 * review worker to a different provider+model decouples its cache footprint
 * from the session's primary prefix cache.
 */

import type { ProviderConfig } from '../config/schema.js'
import type { WorkerProfile } from './work-order.js'
import type { ModelCapabilityCard } from '../model/capability.js'

/** A resolved override: the provider config + model id to use for this profile. */
export interface ResolvedReviewOverride {
  providerName: string
  modelId: string
  providerConfig: ProviderConfig
}

/**
 * Resolve a review profile override against the configured providers.
 *
 * Returns undefined when:
 * - No override configured for this profile
 * - Configured provider does not exist in providers map
 * - Configured model does not exist in provider's models list
 *
 * @param profile The worker profile name (e.g. 'adversarial_verifier')
 * @param reviewProfiles The `review.profiles` record from config
 * @param providers The full providers map from config.provider.providers
 */
export function resolveReviewOverride(
  profile: WorkerProfile,
  reviewProfiles: Record<string, { provider: string; model: string }>,
  providers: Record<string, ProviderConfig>,
): ResolvedReviewOverride | undefined {
  const override = reviewProfiles[profile]
  if (!override) return undefined

  const providerConfig = providers[override.provider]
  if (!providerConfig) return undefined

  const modelExists = providerConfig.models.some(
    m => m.id === override.model,
  )
  if (!modelExists) return undefined

  return {
    providerName: override.provider,
    modelId: override.model,
    providerConfig,
  }
}

/**
 * Build a ModelCapabilityCard for a review override model.
 *
 * Tier inference (isPro / isFlash / treatAsStrong) is intentionally duplicated
 * from bootstrap.ts's modelCards construction — see `bootstrap.ts` near the
 * `modelCards` map. Kept duplicated to avoid a circular import between this
 * pure module and the runtime bootstrap; the bootstrap version feeds
 * `inferModelTierFromCard` in `model-tier-policy.ts`. If the tier heuristic
 * changes in either place, update both.
 *
 * Review is read-only verification — heavy capability scoring is unnecessary,
 * conservative values are fine.
 */
export function buildReviewOverrideCard(
  modelId: string,
  providerConfig: ProviderConfig,
): ModelCapabilityCard {
  const model = providerConfig.models.find(
    m => m.id === modelId,
  )
  const contextWindow = model?.contextWindow ?? 128_000

  // Mirrors the isPro/isFlash detection used to build bootstrap.ts's modelCards
  // map. Kept duplicated to avoid a circular import between this pure module
  // and the runtime bootstrap. See JSDoc above — if this heuristic changes,
  // update both places (and verify `inferModelTierFromCard` in
  // model-tier-policy.ts still agrees).
  const isPro = modelId.includes('pro')
  const isFlash = modelId.includes('flash')
  const treatAsStrong = isPro || (!isFlash && !isPro)

return {
      model: modelId,
      toolUseReliability: treatAsStrong ? 0.8 : 0.6,
      jsonStability: treatAsStrong ? 0.8 : 0.65,
      editSuccessRate: treatAsStrong ? 0.7 : 0.5,
      testRepairRate: treatAsStrong ? 0.6 : 0.45,
      contextWindow,
      cacheEconomics: 'strong' as const,
      recommendedTasks: ['code_search'],
    }
}

/**
 * Result of building the review override state from config. Cards feed the
 * DelegationCoordinator's fast path; resolved overrides feed the runtimeFactory
 * where StreamClients are constructed lazily (so per-call isWrite sets the
 * right maxTokens/thinkingBudget).
 *
 * Both maps are sparse — profiles whose provider/model can't be resolved are
 * silently dropped (logged at the call site) so the coordinator/runtimeFactory
 * fall through to the session's primary model.
 */
export interface ReviewOverrideState {
  cards: Map<string, ModelCapabilityCard>
  overrides: Map<string, ResolvedReviewOverride>
}

/**
 * Build the per-profile override state for review workers from config.
 *
 * Iterates `review.profiles` and resolves each profile's provider+model against
 * the providers map. Profiles that fail to resolve (unknown provider or model)
 * are dropped — bootstrap logs and falls through.
 */
export function buildReviewOverrideState(
  reviewProfiles: Record<string, { provider: string; model: string }>,
  providers: Record<string, ProviderConfig>,
): ReviewOverrideState {
  const cards = new Map<string, ModelCapabilityCard>()
  const overrides = new Map<string, ResolvedReviewOverride>()
  for (const profileName of Object.keys(reviewProfiles)) {
    const resolved = resolveReviewOverride(
      profileName as WorkerProfile,
      reviewProfiles,
      providers,
    )
    if (!resolved) continue
    cards.set(profileName, buildReviewOverrideCard(resolved.modelId, resolved.providerConfig))
    overrides.set(profileName, resolved)
  }
  return { cards, overrides }
}
