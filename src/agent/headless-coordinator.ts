import type { ModelSubmission } from '../models/model-runtime.js'
import { snapshotSessionBinding } from '../model/model-binding.js'
import { createWorkerRuntimeFactory } from './worker-runtime.js'
import { loadConfig } from '../config/manager.js'
/** Headless workers use the same saved policy and exact root binding as desktop workers. */

import { DelegationCoordinator } from './coordinator.js'
import { buildModelCards as buildSharedModelCards } from '../model/capability.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { Config, ProviderConfig } from '../config/schema.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { profileRegistry } from './profile-registry.js'

export interface HeadlessCoordinatorInput {
  runtimeSubmission?: ModelSubmission
  getExternalHookParent?: () => { runtimeId: string; runId: string } | undefined
  externalHookHost?: import('../hooks/external-hook-types.js').ExternalHookHostPort
  getUserInstructions: () => import('../prompt/user-instructions.js').UserInstructionsSnapshot
  toolRegistry: ToolRegistry
  provider: ProviderConfig
  providerName: string
  currentModelId: string
  keyId?: string
  config?: Config
  apiKey: string
  auth?: AuthProvider
  cwd: string
  sessionId?: string
  getRootCredentialPrincipal?: () => string | undefined
}

/** Build modelCards from a provider's models (统一口径：model/capability.ts)。 */
export function buildModelCards(provider: ProviderConfig): ModelCapabilityCard[] {
  return buildSharedModelCards(provider)
}

export function createHeadlessCoordinator(input: HeadlessCoordinatorInput): DelegationCoordinator {
  const modelCards = buildModelCards(input.provider)
  const rootSessionBinding = input.keyId
    ? { provider: input.providerName, model: input.currentModelId, keyId: input.keyId, baseUrl: input.provider.baseUrl }
    : snapshotSessionBinding(input.provider, input.currentModelId, input.apiKey, input.providerName)
  const runtime = createWorkerRuntimeFactory(() => ({
    runtimeSubmission: input.runtimeSubmission,
    externalHookHost: input.externalHookHost,
    externalHookParent: input.getExternalHookParent?.(),
    getUserInstructions: input.getUserInstructions,
    config: input.config ?? loadConfig({ cwd: input.cwd }), cwd: input.cwd,
    provider: input.provider, apiKey: input.apiKey, auth: input.auth,
    currentModelId: input.currentModelId, rootSessionBinding: { ...rootSessionBinding, credentialPrincipal: input.getRootCredentialPrincipal?.() }, rootSessionId: input.sessionId,
    listActiveClaims: () => [], sessionMemoryBlock: () => undefined,
    domainKnowledgeStore: undefined, writeProfiles: profileRegistry.listWriteProfiles(),
  }))
  return new DelegationCoordinator({
    baseToolRegistry: input.toolRegistry,
    modelCards,
    maxWorkers: 1, // headless goal only ever spawns goal_judge
    runtimeFactory: runtime.runtimeFactory,
    selectModel: runtime.selectModel,
    allowAutomaticModelRotation: () => (input.config ?? loadConfig({ cwd: input.cwd })).workers.defaultStrategy === 'auto',
    maxDelegationDepth: 1,
    sessionId: input.sessionId,
    // D8 L2：有意不接 getPlanConstraints——headless 只跑 goal_judge（maxWorkers:1），
    // 没有计划语境。此决定在 assembly-audit 检查项 4 的 allowlist 显式登记。
  })
}
