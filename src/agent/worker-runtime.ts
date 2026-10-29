import { createSubmissionClient, isOfficialProvider, type ModelSubmission } from '../models/model-runtime.js'
import { OfficialError } from '../models/official-contract.js'
import { currentWorkspaceRoots } from '../tools/workspace-context.js'
import { clampReadConcurrency } from '../config/read-concurrency.js'
import { reviewSnapshotCwd } from './review-snapshot.js'
import { parseUserInstructionsSnapshot, type UserInstructionsSnapshot } from '../prompt/user-instructions.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { Config, ProviderConfig } from '../config/schema.js'
import type { ContextClaim } from '../context/claims.js'
import { subagentPromptBlocks } from '../prompt/block-policy.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { createProviderClient } from '../api/factory.js'
import { createAuthProvider } from '../auth/registry.js'
import { resolveCapabilities } from '../api/provider.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { WorkOrder } from './work-order.js'
import type { WorkerRuntimeFactory } from './coordinator.js'
import type { WorkerSessionConfig } from './worker-session.js'
import { debugLog } from '../utils/debug.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { deriveWorkerSessionId } from './work-order.js'
import { buildModelCards } from '../model/capability.js'
import { workerModelPolicy, type WorkerModelPolicy } from './worker-model-policy.js'
import { resolveModelBinding, sessionProviderKey, snapshotSessionBinding, ModelBindingUnavailable, type ModelBindingRef, type ModelUnavailableReason } from '../model/model-binding.js'

export interface WorkerRuntimeDeps {
  runtimeSubmission?: ModelSubmission
  externalHookParent?: { runtimeId: string; runId: string }
  externalHookHost?: import('../hooks/external-hook-types.js').ExternalHookHostPort
  getUserInstructions: () => import('../prompt/user-instructions.js').UserInstructionsSnapshot
  rootSessionId?: string
  rootSessionBinding?: ModelBindingRef
  config: Config
  cwd: string
  /** 会话主 provider（routing 未命中时的回退位）。 */
  provider: ProviderConfig
  apiKey: string
  auth: ReturnType<typeof createAuthProvider> | undefined
  /** 主会话当前模型 id（routing 目标模型不存在时的回退）。 */
  currentModelId: string
  /** 主会话 active claims 快照（子进程 = init 载荷种入的 stub）。 */
  listActiveClaims: () => ContextClaim[]
  /** 会话记忆块快照（子进程 = init 载荷的静态快照）。 */
  sessionMemoryBlock: () => string | undefined
  domainKnowledgeStore: DomainKnowledgeStore | undefined
  /** 写工 profile 名单（profileRegistry.listWriteProfiles()）。 */
  writeProfiles: string[]
}

type Binding = ReturnType<typeof resolveModelBinding>
interface PreparedModel {
  userInstructions: UserInstructionsSnapshot
  deps: WorkerRuntimeDeps
  policy: WorkerModelPolicy
  root: ModelBindingRef
  binding?: Binding
  fallbackReason?: ModelUnavailableReason
}

function prepareModel(deps: WorkerRuntimeDeps, order: WorkOrder, ownedProvider = deps.provider): PreparedModel {
  const userInstructions = parseUserInstructionsSnapshot(deps.getUserInstructions())
  const policy = workerModelPolicy(deps.config, order)
  const root = deps.rootSessionBinding ?? snapshotSessionBinding(deps.provider, deps.currentModelId, deps.apiKey, sessionProviderKey(deps.config.provider.providers, deps.provider))
  if ('strategy' in policy.target && policy.target.strategy === 'auto') return { deps, policy, root, userInstructions }
  let binding: Binding
  if ('provider' in policy.target) {
    if (policy.unavailableReason) throw new ModelBindingUnavailable(policy.unavailableReason)
    binding = resolveModelBinding(deps.config.provider.providers, policy.target, deps.config.network, ownedProvider)
  } else binding = resolveModelBinding(deps.config.provider.providers, root, deps.config.network, ownedProvider)
  return { deps, policy, root, binding, userInstructions }
}

/** One policy snapshot per dispatch; new saved settings apply only to new orders. */
export function createWorkerRuntimeFactory(getDeps: () => WorkerRuntimeDeps) {
  const prepared = new WeakMap<WorkOrder, PreparedModel | Promise<PreparedModel>>()
  const get = (order: WorkOrder, signal?: AbortSignal) => {
    let result = prepared.get(order)
    if (!result) {
      const current = getDeps()
      const instructions = parseUserInstructionsSnapshot(current.getUserInstructions())
      const deps = { ...current, getUserInstructions: () => instructions, runtimeSubmission: current.runtimeSubmission?.capture() }
      signal?.throwIfAborted()
      const policy = workerModelPolicy(deps.config, order)
      const target = 'provider' in policy.target && !policy.unavailableReason ? policy.target : undefined
      const configured = target && deps.config.provider.providers[target.provider]
      result = target && configured && isOfficialProvider(configured) && deps.runtimeSubmission
        ? deps.runtimeSubmission.resolve({ config: deps.config, provider: configured, apiKey: '', modelId: target.model, purpose: 'agent', signal }).then(runtime => {
          signal?.throwIfAborted()
          return prepareModel(deps, order, runtime.provider)
        })
        : prepareModel(deps, order)
      prepared.set(order, result)
    }
    return result
  }
  return {
    selectModel: (order: WorkOrder, signal?: AbortSignal) => {
      const selected = get(order, signal)
      const card = (value: PreparedModel) => value.binding ? buildModelCards({ models: [value.binding.spec] })[0] : undefined
      return selected instanceof Promise ? selected.then(card) : card(selected)
    },
    runtimeFactory: ((order, card, registry) => {
      const selected = get(order)
      const assemble = (model: Awaited<ReturnType<typeof get>>) => assembleWorkerRuntime(order.scope.reviewSnapshot ? { ...model, deps: { ...model.deps, cwd: reviewSnapshotCwd(order.scope.reviewSnapshot) } } : model, order, card, registry)
      return selected instanceof Promise ? selected.then(assemble) : assemble(selected)
    }) as WorkerRuntimeFactory,
  }
}

export function buildWorkerRuntime(deps: WorkerRuntimeDeps, order: WorkOrder, card: ModelCapabilityCard, registry: ToolRegistry): WorkerSessionConfig {
  return assembleWorkerRuntime(prepareModel(deps, order), order, card, registry)
}

function assembleWorkerRuntime(prepared: PreparedModel, _order: WorkOrder, card: ModelCapabilityCard, workerRegistry: ToolRegistry): WorkerSessionConfig {
  const { deps, policy, root } = prepared
  const { config, cwd } = deps
  const userInstructions = prepared.userInstructions
  let binding = prepared.binding
  const fallbackReason = undefined
  if (!binding) {
    // Only an explicit automatic policy reaches the recommendation's candidate.
    binding = resolveModelBinding(config.provider.providers, { provider: root.provider, model: card.model }, config.network, deps.provider)
  }
  const workerProvider = binding.provider
  const workerApiKey = binding.apiKey
  const workerAuth = binding.auth
  const workerModel = binding.ref.model
  const runtimeSubmission = deps.runtimeSubmission?.capture()
  if (isOfficialProvider(workerProvider) && !runtimeSubmission) throw new OfficialError('auth_required', 401, false)
  const selectionMetadata = {
    strategy: fallbackReason ? 'session' as const : 'provider' in policy.target ? 'fixed' as const : policy.target.strategy,
    source: policy.source, requestedTarget: policy.target, fallbackReason,
    capabilityCard: buildModelCards({ models: [binding.spec] })[0],
    keyId: binding.ref.keyId, baseUrl: binding.ref.baseUrl, rootSessionBinding: root, rootSessionId: deps.rootSessionId,
  }
  const isWrite = deps.writeProfiles.includes(_order.profile)
  const wireSessionId = deriveWorkerSessionId(_order.id)
  const blocks = subagentPromptBlocks()
  const subagentTools = () => applyDescriptionMode(workerRegistry.getDefinitions(), blocks.toolDescriptions)
  const workerModelSpec = binding.spec
  const workerContextWindow = workerModelSpec?.contextWindow ?? card.contextWindow
  const workerMaxTokens = Math.min(16384, workerModelSpec.maxTokens ?? workerContextWindow)

  debugLog(`[worker-model] runtimeFactory: kind=${_order.kind} profile=${_order.profile} model=${workerModel} provider=${workerProvider.name} contextWindow=${workerContextWindow}`)

  const workerCapabilities = resolveCapabilities(workerProvider.name, workerProvider.capabilities, workerModelSpec?.capabilities)
  const expectedPrincipal = 'strategy' in policy.target && policy.target.strategy === 'session' ? root.credentialPrincipal : undefined
  return {
    readConcurrency: clampReadConcurrency(config.tools?.readConcurrency),
    runtimeSubmission,
    runtimeContext: { config, provider: workerProvider, apiKey: workerApiKey, auth: workerAuth, modelId: workerModel, purpose: 'agent' },
    automaticMemoryReview: !isOfficialProvider(workerProvider),
    order: _order,
    runtimeDecision: {
      ...selectionMetadata,
      expectedPrincipal,
      providerKey: binding.ref.provider,
      providerName: workerProvider.name,
      model: workerModel,
      maxTokens: workerMaxTokens,
      contextWindow: workerContextWindow,
      thinkingBudget: isWrite ? 8192 : 4096,
      isWrite,
    },
    providerName: workerProvider.name,
    baseUrl: workerProvider.baseUrl,
    slowThinking: workerProvider.slowThinking,
    client: isOfficialProvider(workerProvider) ? createSubmissionClient({ config, provider: workerProvider, apiKey: '', modelId: workerModel, purpose: 'agent' }, runtimeSubmission!, {
      network: config.network,
      singleAttempt: true,
      credentialScope: `${binding.ref.provider}:${binding.ref.keyId ?? 'default'}`,
      expectedPrincipal,
      reasoningEffort: undefined,
      maxTokens: workerMaxTokens,
      thinkingBudget: isWrite ? 8192 : 4096,
      sessionId: wireSessionId,
    }) : createProviderClient(workerProvider, workerCapabilities, {
      network: config.network,
      singleAttempt: true,
      credentialScope: `${binding.ref.provider}:${binding.ref.keyId ?? 'default'}`,
      expectedPrincipal,
      apiKey: workerApiKey,
      model: workerModel,
      reasoningEffort: undefined,
      maxTokens: workerMaxTokens,
      thinkingBudget: isWrite ? 8192 : 4096,
      auth: workerAuth,
      sessionId: wireSessionId,
    }),
    promptEngine: new PromptEngine({
      model: workerModel,
      maxTokens: workerMaxTokens,
      // audience:'subagent' — 分档精简的 system 段：删主控专属循环/契约，
      // 工具耦合段按 worker 实际工具集门控。主控路径不传该字段，字节不变。
      staticCtx: { tools: subagentTools(), audience: 'subagent' },
      volatileCtx: { cwd, userInstructions, sessionMemoryBlock: deps.sessionMemoryBlock(), blockCaps: blocks.caps },
    }),
    toolRegistry: workerRegistry,
    blockPolicy: blocks,
    externalHookHost: deps.externalHookHost,
    externalHookParent: deps.externalHookParent,
    cwd,
    workspaceRoots: [...currentWorkspaceRoots(cwd)],
    maxTurns: 100,
    contextWindow: workerContextWindow,
    compact: { enabled: false, model: 'flash' },
    activeClaims: deps.listActiveClaims(),
    domainKnowledgeStore: deps.domainKnowledgeStore,
    // Legacy configuration remains readable; worker report repair is disabled.
    forceJsonRepair: false,
  }
}
