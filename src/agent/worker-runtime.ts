/**
 * worker-runtime.ts — WorkerSessionConfig 的三分支组装（从 bootstrap runtimeFactory 抽出）。
 *
 * 抽取动机（worker 子进程隔离 v1）：runtimeFactory 原是 bootstrap 内闭包，
 * 子进程无法复用。抽出为纯函数后：bootstrap 传主会话闭包 deps 照旧；
 * 子进程（worker-process/child.ts）传自建 deps（loadConfig 重建 config、
 * init 载荷携带 activeClaims/sessionMemoryBlock 快照、reviewOverrides 由
 * buildReviewOverrideState 重算）——三条分支（modelOverride / review-override /
 * 常规+workers routing）单源，分头构造迟早跑偏。
 *
 * 纯重构纪律：分支逻辑逐字搬运，仅把闭包访问改为 deps 字段。任何行为
 * 变化都必须在此之外显式声明。
 */

import type { ModelCapabilityCard } from '../model/capability.js'
import type { Config, ProviderConfig } from '../config/schema.js'
import type { ContextClaim } from '../context/claims.js'
import { subagentPromptBlocks } from '../prompt/block-policy.js'
import { applyDescriptionMode } from '../tools/description-compact.js'
import { createProviderClient, resolveApiKey } from '../api/factory.js'
import type { ResolvedReviewOverride } from './review-model-override.js'
import { createAuthProvider } from '../auth/registry.js'
import { resolveCapabilities } from '../api/provider.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { WorkOrder } from './work-order.js'
import type { WorkerRouteConfig } from './coordinator.js'
import type { WorkerSessionConfig } from './worker-session.js'
import { debugLog } from '../utils/debug.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { deriveWorkerSessionId, mapWorkOrderKindToCapabilityTask } from './work-order.js'

/** 主会话闭包的最小面——子进程用自建实现逐项替换。 */
export interface WorkerRuntimeDeps {
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
  reviewOverrides: Map<string, ResolvedReviewOverride>
  reviewOverrideApiKeys: Map<string, string>
  workerRouting: WorkerRouteConfig | undefined
  /** 写工 profile 名单（profileRegistry.listWriteProfiles()）。 */
  writeProfiles: string[]
}

export function buildWorkerRuntime(
  deps: WorkerRuntimeDeps,
  _order: WorkOrder,
  card: ModelCapabilityCard,
  workerRegistry: ToolRegistry,
): WorkerSessionConfig {
  const { config, cwd, provider, apiKey, auth, currentModelId } = deps
  const isWrite = deps.writeProfiles.includes(_order.profile)
  // 上游（OpenCode Go）按会话做路由/缓存亲和。worker 的请求若全进程共用 factory
  // 的兜底 ID，多会话（桌面端多窗口同进程）的委派会被上游当成同一段对话。
  // 只取 order.id、不带 sessionNonce：子进程重建 client 时（worker-process/child.ts）
  // 拿不到 nonce，父子必须用同一公式，否则同一 order 会算出两个 ID。
  const wireSessionId = deriveWorkerSessionId(_order.id)
  // 子代理块策略：收紧 project-instructions 预算 + compact 描述档。三条分支
  // （modelOverride / review-override / 常规）共用同一份——分头构造迟早跑偏。
  const blocks = subagentPromptBlocks()
  const subagentTools = () => applyDescriptionMode(workerRegistry.getDefinitions(), blocks.toolDescriptions)

  // Per-order modelOverride: highest precedence (above review override and
  // workers routing). Builds a dedicated client for the seat's provider/model
  // so e.g. a council with one DeepSeek-Pro seat and one GLM seat runs each on
  // its own server-side cache. Falls through to normal routing when the
  // provider is unknown / lacks the model / has no credentials (silent
  // fallback, consistent with the other routing layers).
  if (_order.modelOverride) {
    const ovProvider = config.provider.providers[_order.modelOverride.provider]
    const ovModel = _order.modelOverride.model
    const ovModelOk = ovProvider?.models.some(m => m.id === ovModel || m.alias === ovModel)
    if (ovProvider && ovModelOk) {
      let ovApiKey = ''
      let ovAuth: ReturnType<typeof createAuthProvider> | undefined
      let ovReady = false
      try {
        if (ovProvider.auth?.type === 'oauth') {
          ovAuth = ovProvider.name === provider.name ? auth : createAuthProvider(ovProvider.auth, process.env)
          ovReady = Boolean(ovAuth?.isAuthenticated())
        } else {
          ovApiKey = resolveApiKey(ovProvider)
          ovReady = Boolean(ovApiKey)
        }
      } catch {
        ovReady = false
      }
      if (ovReady) {
        const ovSpec = ovProvider.models.find(m => m.id === ovModel || m.alias === ovModel)
        const ovContextWindow = ovSpec?.contextWindow ?? card.contextWindow
        const ovMaxTokens = isWrite
          ? Math.min(16384, ovSpec?.maxTokens ?? ovContextWindow)
          : Math.min(16384, ovSpec?.maxTokens ?? ovContextWindow)
        const ovCapabilities = resolveCapabilities(ovProvider.name, ovProvider.capabilities, ovSpec?.capabilities)
        debugLog(`[worker-model] modelOverride active: profile=${_order.profile} authority=${_order.authority} → ${ovProvider.name}/${ovModel} isWrite=${isWrite}`)
        return {
          order: _order,
          runtimeDecision: {
            providerName: ovProvider.name,
            model: ovModel,
            maxTokens: ovMaxTokens,
            contextWindow: ovContextWindow,
            thinkingBudget: isWrite ? 8192 : 4096,
            isWrite,
          },
          providerName: ovProvider.name,
          baseUrl: ovProvider.baseUrl,
          slowThinking: ovProvider.slowThinking,
          client: createProviderClient(ovProvider, ovCapabilities, {
            apiKey: ovApiKey,
            model: ovModel,
            reasoningEffort: undefined,
            maxTokens: ovMaxTokens,
            thinkingBudget: isWrite ? 8192 : 4096,
            auth: ovAuth,
            sessionId: wireSessionId,
          }),
          promptEngine: new PromptEngine({
            model: ovModel,
            maxTokens: ovMaxTokens,
            staticCtx: { tools: subagentTools(), audience: 'subagent' },
            volatileCtx: { cwd, sessionMemoryBlock: deps.sessionMemoryBlock(), blockCaps: blocks.caps },
          }),
          toolRegistry: workerRegistry,
          blockPolicy: blocks,
          cwd,
          maxTurns: 100,
          contextWindow: ovContextWindow,
          compact: { enabled: false, model: 'flash' },
          activeClaims: deps.listActiveClaims(),
          domainKnowledgeStore: deps.domainKnowledgeStore,
          forceJsonRepair: ovCapabilities.supportsResponseFormat,
        }
      }
      debugLog(`[worker-model] modelOverride skip: ${_order.modelOverride.provider}/${ovModel} no credentials → fallback`)
    } else {
      debugLog(`[worker-model] modelOverride skip: provider=${_order.modelOverride.provider} modelOk=${ovModelOk} → fallback`)
    }
  }

  // Review override fast path: if the profile is configured for a different
  // provider, use the pre-resolved override (different provider+model from
  // session primary). This is the whole point of the override — review
  // workers must NOT touch the session primary's server-side cache (GLM
  // cache-killer mechanism). StreamClient is built lazily here (not at
  // bootstrap) so maxTokens/thinkingBudget reflect this call's isWrite —
  // 读写同档 16384（实测只读大报告在 4096 顶格截断触发整轮续跑，一次截断
  // 的代价远超档位放宽的成本），matching the non-override worker path.
  const overrideResolved = deps.reviewOverrides.get(_order.profile)
  if (overrideResolved) {
    const overrideApiKey = deps.reviewOverrideApiKeys.get(_order.profile)
    if (!overrideApiKey) {
      debugLog(`[review-override] skip ${_order.profile}: no cached API key (credential failure at bootstrap)`)
    } else {
      const overrideSpec = overrideResolved.providerConfig.models.find(
        m => m.id === overrideResolved.modelId || m.alias === overrideResolved.modelId,
      )
      const overrideContextWindow = overrideSpec?.contextWindow ?? card.contextWindow
      const overrideMaxTokens = isWrite
        ? Math.min(16384, overrideSpec?.maxTokens ?? overrideContextWindow)
        : Math.min(16384, overrideSpec?.maxTokens ?? overrideContextWindow)
      debugLog(`[worker-model] review-override active: profile=${_order.profile} model=${overrideResolved.modelId} isWrite=${isWrite}`)
      const overrideCapabilities = resolveCapabilities(overrideResolved.providerName, overrideResolved.providerConfig.capabilities, overrideSpec?.capabilities)
      return {
        order: _order,
        runtimeDecision: {
          providerName: overrideResolved.providerName,
          model: overrideResolved.modelId,
          maxTokens: overrideMaxTokens,
          contextWindow: overrideContextWindow,
          thinkingBudget: isWrite ? 8192 : 4096,
          isWrite,
        },
        providerName: overrideResolved.providerName,
        baseUrl: overrideResolved.providerConfig.baseUrl,
        slowThinking: overrideResolved.providerConfig.slowThinking,
        client: createProviderClient(
          overrideResolved.providerConfig,
          overrideCapabilities,
          {
            apiKey: overrideApiKey,
            model: overrideResolved.modelId,
            reasoningEffort: undefined,
            maxTokens: overrideMaxTokens,
            thinkingBudget: isWrite ? 8192 : 4096,
            sessionId: wireSessionId,
          },
        ),
        promptEngine: new PromptEngine({
          model: overrideResolved.modelId,
          maxTokens: overrideMaxTokens,
          staticCtx: { tools: subagentTools(), audience: 'subagent' },
          volatileCtx: { cwd, sessionMemoryBlock: deps.sessionMemoryBlock(), blockCaps: blocks.caps },
        }),
        toolRegistry: workerRegistry,
        blockPolicy: blocks,
        cwd,
        maxTurns: 100,
        contextWindow: overrideContextWindow,
        compact: { enabled: false, model: 'flash' },
        activeClaims: deps.listActiveClaims(),
        domainKnowledgeStore: deps.domainKnowledgeStore,
        forceJsonRepair: overrideCapabilities.supportsResponseFormat,
      }
    }
  }

  let workerProvider = provider
  let workerApiKey = apiKey
  let workerAuth = auth
  let workerModel = card.model

  if (deps.workerRouting) {
    const routeName = deps.workerRouting.routing[mapWorkOrderKindToCapabilityTask(_order.kind)]
    if (routeName && deps.workerRouting.profiles[routeName]) {
      const routeProfile = deps.workerRouting.profiles[routeName]!
      const resolved = config.provider.providers[routeProfile.provider]
      // Route to the configured provider+model as long as the provider exists and
      // actually offers the configured model. The previous guard required
      // `routeProfile.model === card.model`, which defeated the whole point of
      // worker routing (independent model → isolated server-side prefix cache):
      // any profile configured with a DIFFERENT model was silently skipped and
      // workers fell back to the primary model, competing with the primary
      // session's cache entries. Now we allow a distinct model and set it on
      // workerModel so the worker actually runs on the routed model.
      if (resolved && resolved.models.some(m => m.id === routeProfile.model || m.alias === routeProfile.model)) {
        try {
          if (resolved.auth?.type === 'oauth') {
            const routedAuth = resolved.name === provider.name
              ? auth
              : createAuthProvider(resolved.auth, process.env)
            if (routedAuth?.isAuthenticated()) {
              workerProvider = resolved
              workerModel = routeProfile.model
              workerApiKey = ''
              workerAuth = routedAuth
            }
          } else {
            workerProvider = resolved
            workerModel = routeProfile.model
            workerApiKey = resolveApiKey(resolved)
            workerAuth = undefined
          }
        } catch {
          workerProvider = provider
          workerApiKey = apiKey
          workerAuth = auth
        }
      }
    }
  }

  if (!workerProvider.models.some(m => m.id === workerModel || m.alias === workerModel)) {
    workerModel = currentModelId
  }
  const workerModelSpec = workerProvider.models.find(m => m.id === workerModel || m.alias === workerModel)
  const workerContextWindow = workerModelSpec?.contextWindow ?? card.contextWindow
  const workerMaxTokens = isWrite
    ? Math.min(16384, workerModelSpec?.maxTokens ?? workerContextWindow)
    : Math.min(16384, workerModelSpec?.maxTokens ?? workerContextWindow)

  debugLog(`[worker-model] runtimeFactory: kind=${_order.kind} profile=${_order.profile} model=${workerModel} provider=${workerProvider.name} contextWindow=${workerContextWindow}`)

  const workerCapabilities = resolveCapabilities(workerProvider.name, workerProvider.capabilities, workerModelSpec?.capabilities)
  return {
    order: _order,
    runtimeDecision: {
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
    client: createProviderClient(workerProvider, workerCapabilities, {
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
      volatileCtx: { cwd, sessionMemoryBlock: deps.sessionMemoryBlock(), blockCaps: blocks.caps },
    }),
    toolRegistry: workerRegistry,
    blockPolicy: blocks,
    cwd,
    maxTurns: 100,
    contextWindow: workerContextWindow,
    compact: { enabled: false, model: 'flash' },
    activeClaims: deps.listActiveClaims(),
    domainKnowledgeStore: deps.domainKnowledgeStore,
    // Use response_format: json_object on repair turns when the provider
    // supports it — forces valid JSON output, eliminating the most common
    // worker-result parse-failure cause (free-text prose / truncation).
    // Only applied to the tool-free repair turn, so it never conflicts with
    // function calling on normal turns.
    forceJsonRepair: workerCapabilities.supportsResponseFormat,
  }
}
