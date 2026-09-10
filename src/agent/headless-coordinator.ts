/**
 * Headless DelegationCoordinator — minimal coordinator for `--goal` mode.
 *
 * The full bootstrap coordinator (bootstrap.ts) captures 10+ closure variables
 * (reviewOverrides, workerRouting, providerHealth, banditPromotion, efeRouting,
 * domainKnowledgeStore, …). Rather than extract a shared factory with a God-sized
 * param type, we build a dedicated lightweight coordinator here that only needs
 * to spawn `goal_judge` (read-only + test) workers with the same provider/apiKey
 * as the main session.
 *
 * Not wired: review overrides, worker routing, bandit, session registry.
 */

import { DelegationCoordinator } from './coordinator.js'
import type { WorkerRuntimeFactory } from './coordinator.js'
import { buildModelCards as buildSharedModelCards } from '../model/capability.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { ProviderConfig } from '../config/schema.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { createProviderClient } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { PromptEngine } from '../prompt/engine.js'
import { subagentPromptBlocks } from '../prompt/block-policy.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { profileRegistry } from './profile-registry.js'
import type { CompactionConfig } from '../compact/constants.js'

export interface HeadlessCoordinatorInput {
  toolRegistry: ToolRegistry
  provider: ProviderConfig
  providerName: string
  apiKey: string
  auth?: AuthProvider
  cwd: string
  sessionId?: string
}

/** Build modelCards from a provider's models (统一口径：model/capability.ts)。 */
export function buildModelCards(provider: ProviderConfig): ModelCapabilityCard[] {
  return buildSharedModelCards(provider)
}

const HEADLESS_COMPACT: CompactionConfig = {
  enabled: false,
  model: 'flash',
}

/**
 * Build a minimal DelegationCoordinator for headless goal mode.
 * Only supports spawning read-only workers (goal_judge) — no review
 * overrides, no worker routing, no bandit, no session registry.
 */
export function createHeadlessCoordinator(input: HeadlessCoordinatorInput): DelegationCoordinator {
  const modelCards = buildModelCards(input.provider)
  const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
    const isWrite = profileRegistry.listWriteProfiles().includes(order.profile)
    const blocks = subagentPromptBlocks()
    const modelSpec = input.provider.models.find(
      m => m.id === card.model || m.alias === card.model,
    )
    const ctxWindow = modelSpec?.contextWindow ?? card.contextWindow
    const maxTokens = isWrite
      ? Math.min(16384, modelSpec?.maxTokens ?? ctxWindow)
      : Math.min(16384, modelSpec?.maxTokens ?? ctxWindow)
    return {
      order,
      client: createProviderClient(
        input.provider,
        resolveCapabilities(input.providerName, input.provider.capabilities),
        {
          apiKey: input.apiKey,
          model: card.model,
          reasoningEffort: undefined,
          maxTokens,
          thinkingBudget: isWrite ? 8192 : 4096,
          auth: input.auth,
          // 会话级 ID 而非 factory 的进程兜底：上游按会话做路由/缓存亲和，
          // 进程级常量会把不同会话的委派合并成同一段对话。
          sessionId: input.sessionId,
        },
      ),
      promptEngine: new PromptEngine({
        model: card.model,
        maxTokens,
        staticCtx: { tools: applyDescriptionMode(workerRegistry.getDefinitions(), blocks.toolDescriptions), audience: 'subagent' },
        volatileCtx: { cwd: input.cwd, blockCaps: blocks.caps },
      }),
      toolRegistry: workerRegistry,
      blockPolicy: blocks,
      cwd: input.cwd,
      // Far backstop only — the work order budget (clamped via clampWorkerMaxTurns)
      // is the real turn controller.
      maxTurns: 100,
      contextWindow: ctxWindow,
      compact: HEADLESS_COMPACT,
      activeClaims: [],
    }
  }
  return new DelegationCoordinator({
    baseToolRegistry: input.toolRegistry,
    modelCards,
    maxWorkers: 1, // headless goal only ever spawns goal_judge
    runtimeFactory,
    maxDelegationDepth: 1,
    sessionId: input.sessionId,
    // D8 L2：有意不接 getPlanConstraints——headless 只跑 goal_judge（maxWorkers:1），
    // 没有计划语境。此决定在 assembly-audit 检查项 4 的 allowlist 显式登记。
  })
}
