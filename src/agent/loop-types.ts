import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import type { StreamRule } from './turn-stream.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { HookRegistry } from '../hooks/registry.js'
import type { RuntimeHookPipeline } from './runtime-hooks.js'
import type { HookEvent, HookResult } from '../hooks/user-hooks-runner.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { PlanModeState } from './plan-mode.js'
import type { PermissionConfig, PermissionOverlay } from './permissions.js'
import type { ApprovalResult } from './approval-edit.js'
import type { ResourceSensorOptions } from './resource-sensor.js'
import type { ProviderHealthTracker } from './provider-health.js'
import type { PlaybookStore } from './playbook-store.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import type { IntentPreview } from './intent-preview.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import type { DelegationActivity } from '../tools/types.js'
import type { EvidenceSummary } from './evidence.js'
import type { DomainDriftResult } from './domain-drift-detector.js'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

export interface AgentConfig {
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  /**
   * C3 检查点间隔 — Auto 模式下每 N 轮暂停并同步进度摘要（0 = 关）。
   * YOLO 和 Manual 模式不读此字段。
   */
  checkpointEveryTurns?: number
  contextWindow: number
  compact: CompactionConfig
  /** Working directory for the session. */
  cwd?: string
  /** 会话启动期解析并冻结的提示词档位策略（2026-07-25 复盘修复）。
   *  活会话的一切档位消费必须读这份快照而非 resolvePromptBlocks() 的进程级
   *  memo——长驻 sidecar 里 memo 会被新会话创建时 invalidate，live 读会让
   *  tools 描述字节中途翻转 → 整段前缀缓存 miss。缺省时回退 live 解析
   *  （手工构造 config 的测试路径）。 */
  blockPolicy?: import('../prompt/block-policy.js').PromptBlockPolicy
  providerProfile?: ProviderProfile
  /** Per-agent read-cap override forwarded to tool calls (read_file/grep).
   *  Set for worker sessions: they run compact-disabled on a 1M window, so the
   *  window-derived 120K cap lets one full-file read permanently occupy every
   *  subsequent turn's prompt. Absent → cap derived from contextWindow. */
  readCapOverride?: import('../tools/model-read-cap.js').ModelReadCap
  /** Batch-scoped shared PrewarmCache（worker 经 WorkerSessionConfig.prewarm 透传）。
   *  必须在构造期注入——toolExecution 的 deps 在构造时按值捕获 self.prewarm，
   *  构造后替换字段到不了消费端（read-file consumePrewarm）。 */
  prewarm?: import('./prewarm.js').PrewarmCache
  /** Batch-scoped shared StigmergyStore（星河收编 #3，worker 经
   *  WorkerSessionConfig.stigmergy 透传）。提供时覆盖本会话默认的
   *  按 sessionDir 持久化 store——同批 worker 共享同一内存信息素库。
   *  缺省 undefined → 构造期按 sessionDir 新建（历史行为）。 */
  stigmergyStore?: import('../context/stigmergy.js').StigmergyStore
  /** Provider registry key (e.g. 'deepseek') — used as ProviderHealthTracker id. */
  providerName?: string
  /** 会话冻结的 wire 变换上下文（spark truncate N 等）。随 meta 持久化、
   *  resume 读回；wire 截断与锚点提取两个消费点必须同源取这份（同 N 互补）。 */
  wireContext?: import('../api/pro-registry.js').WireTransformContext
  /** Cost-aware reclaim profile resolved from provider+model economics
   *  (billing / cache kind / reclaim floors). Absent → controllers derive a
   *  conservative per-token fallback from providerProfile. */
  compactionProfile?: import('../compact/compaction-profile.js').CompactionProfile
  /** Primary model's StreamClient — reused for LLM compaction via Forked Agent pattern. */
  primaryClient?: StreamClient
  /** Optional dedicated StreamClient for compaction summarization, built from
   *  compact.provider+model. When set, CompactionController distills on this
   *  (cheap) client instead of primaryClient — isolated cache, no main-model
   *  token spend. Undefined → compaction falls back to primaryClient. */
  compactClient?: StreamClient
  approvalMode?: ApprovalMode
  /** Headless mode — no human is attached to answer approval prompts (worker
   *  sub-agents, `serve` sidecar callers that pass a rejecting onApprovalRequired).
   *  When true, the approval gate never blocks on a prompt that would hang: in-workspace
   *  file writes are auto-approved (worktree / claim isolation makes them reversible and
   *  the primary reviews the diff afterward), and any other operation that would otherwise
   *  ask is denied immediately with a model-facing instruction instead of stalling on a
   *  prompt no one can answer. Deny rules and the self-kill guard still win. */
  headless?: boolean
  sessionId?: string
  /** Review-router re-entrancy depth. Worker contexts spawned by review routing use depth > 0. */
  reviewDepth?: number
  /** B3: delegation nesting depth of THIS agent (primary=0, worker=1, grand-worker=2).
   *  Propagated into delegate tool calls so the coordinator can cap recursion. */
  delegationDepth?: number
  /** Optional session registry for cross-session event communication. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  transcriptPath?: string
  getSessionMemoryState?: () => import('../context/types.js').LedgerSessionMemoryState | undefined
  hooks?: HookRegistry
  runtimeHooks?: RuntimeHookPipeline
  /** P2: CVM 五阶段管线装配配置（来自磁盘 Config.hooks，bootstrap 填入）。
   *  disabled 会话级禁用的 hook id；交互模式可热更（config-watcher 更新
   *  RuntimeHookPipeline.setDisabledHookIds）。与上方 hooks（用户自定义
   *  HookRegistry）独立。 */
  hookAssembly?: {
    disabled?: string[]
    timeoutMs?: number
    slowMs?: number
  }
  /** I4: emit user hook results to the desktop event stream. */
  emitHookResult?: (results: HookResult[], meta: { event: HookEvent; turn?: number; toolName?: string; error?: string }) => void
  /** Lazy-binding getter for plugin-contributed hooks (absolute script paths).
   *  Plugins load after agent assembly; this getter lets the user-hooks bridge
   *  read the current set at fire time. Returns [] when no plugins loaded. */
  getPluginHooks?: () => import('../plugins/plugin-loader.js').PluginHookEntry[]
  /** Lazy-binding getter for plugin-contributed slash commands (absolute .md
   *  paths). Read by the slash-command resolver at input time. */
  getPluginCommands?: () => import('../plugins/plugin-loader.js').PluginCommandEntry[]
  fileHistory?: import('./file-history.js').FileHistory
  modelCards?: ModelCapabilityCard[]
  /** Shadow-only model routing telemetry cards. Does not enable model switching. */
  modelRoutingShadowModelCards?: ModelCapabilityCard[]
  /** Record routing recommendations as append-only telemetry without changing model selection. Default: enabled when a MeridianDb is available. */
  modelRoutingShadowEnabled?: boolean
  onModelSwitch?: (newModel: string) => void
  getCurrentModel?: () => string
  autoReasoning?: boolean
  reasoningEffort?: import('./auto-reasoning.js').ReasoningEffort
  reasoningFloor?: import('./auto-reasoning.js').ReasoningEffort
  /** T2-02 Track A2: Enable bandit-controlled effort delta. Default false.
   *  When false, bandit runs in shadow mode only (telemetry, no behavior change).
   *  When true, bandit recommendations may adjust reasoning effort after the
   *  consistency-promotion gate passes. */
  effortBanditEnabled?: boolean
  /** Turn-level thinking: disable thinking on tool execution turns (GLM turn-level thinking).
   *  Reduces reasoning_content accumulation and prevents context window stalls. */
  turnLevelThinking?: boolean
  /**
   * 2D（默认关）：客户端重试耗尽后的 agent 层有界重连。仅当本轮 streamError 被
   * classifyApiError 判为 shouldReconnect、且未 abort 时，丢弃本轮 partial blocks 与
   * streamedText（守护 prefix cache 不被污染），用**相同 request** 重新发起流。
   * 默认禁用——保守特性，需显式开启。 */
  agentReconnect?: {
    enabled: boolean
    /** 最大重连次数（不含首次）。默认 1。 */
    maxAttempts?: number
    /** 每次重连前的退避（ms，可被 abort 打断）。默认 500。 */
    backoffMs?: number
  }
  lspEnabled?: boolean
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy.
   *  Use `getLspManager` for late-binding (LSP initialized asynchronously after AgentLoop). */
  lspManager?: import('../lsp/manager.js').LspManager
  /** T4: late-bound LSP manager getter. Preferred over static `lspManager` for T9 path
   *  where LSP initializes asynchronously after AgentLoop construction. */
  getLspManager?: () => import('../lsp/manager.js').LspManager | null
  permissions?: PermissionConfig
  /** Runtime permission overrides that apply only to the current session. */
  permissionsOverlay?: PermissionOverlay
  contextClaimStore?: ContextClaimStore
  /** Optional provider health tracker for Physarum-style routing.
   *  Degradation ratio affects sensorium stability dimension. */
  providerHealth?: ProviderHealthTracker
  playbookStore?: PlaybookStore
  /** Optional resource sensor injection for reliability tests and custom deployments. */
  resourceSensorOptions?: ResourceSensorOptions
  /** Disable fs watcher in tests or constrained environments. Enabled by default. */
  fsWatcherEnabled?: boolean
  /** Optional TaskLedger for B1 ownership tracking — records file_read/file_write/tool_exec events. */
  taskLedger?: import('./task-ledger.js').TaskLedger
  /** Track 3: 权威交付门禁（v2 GREEN/YELLOW/RED）。接入后 evidence badge 与
   *  收敛检测以 v2 状态为准；缺省回退 v1（EvidenceState 推导）。 */
  deliveryGateV2?: (currentDirtyFiles?: string[]) => import('./delivery-gate-v2.js').DeliveryGateResult
  /**
   * 会话 Auto 是否按消息关键词匹配换域（defaultDomain='auto' 或当前会话
   * 显式选择 Auto 时生效）。
   * 默认 true：按首条消息在 auto 池（DOMAIN_AUTO_POOL 四个均衡工程域 +
   * 自定义域）内 matchDomain，未命中回退天权。显式 false 时 Auto 固定落到
   * DEFAULT_DOMAIN（天权）。
   */
  domainKeywordRouting?: boolean
  /** 默认星域（qiming | tianshu | kaiyang | … | auto）。
   *  非 auto 时由 bindSessionDomain 首次钉定，所有入口统一。
   *  auto 时跳过钉定，走关键词路由。默认 qiming（启明）。 */
  defaultDomain?: string
  /** Explicit opt-in for Songline substrate post-session pheromone/cycle relay. Disabled by default. */
  songlineEnabled?: boolean
  /** Explicit opt-in for constellation post-session milestone capture. Default false. */
  constellationEnabled?: boolean
  /** Explicit opt-in for companion presence heartbeat. Default false. */
  companionPresenceEnabled?: boolean
  /** Session-end dream / skill-distill. Default true; lean forces off. */
  dreamEnabled?: boolean
  /** Runtime lean profile — trims postTool meridian/physarum and postSession dream. */
  runtimeLean?: boolean
  /** 资源压力状态行回调（TUI setStatusLine 通道）：resource_pressure trigger
   *  触发时收到提醒文本，资源恢复时收到 null 清除。缺省不接（sidecar/worker
   *  无 TUI）。只承载资源压力信息，不与其他状态行来源（StatusLineRunner）协调。 */
  onStatusLine?: (text: string | null) => void
  /** 安全模式正则告警（层1）。默认开；false 或 RIVET_SECURITY_GUIDANCE=0 关闭。 */
  securityGuidance?: boolean
  /** Explicit opt-in for HEARTH anchor invariant observation (postTurn, diagnostic only). Disabled by default. */
  hearthObserveEnabled?: boolean
  /** Enable cross-session knowledge loading (memory block, playbook events, companion presence).
   *  Default true — injects distilled project knowledge into prompt.
   *  Env RIVET_NO_CROSS_SESSION=1 overrides as force-off. */
  crossSessionEnabled?: boolean
  /** Explicit opt-in for anti-anchoring harness hooks. Disabled by default. */
  antiAnchoring?: AntiAnchoringConfig
  /** Disable theta (tsc --noEmit) checks. Workers use this to skip redundant typechecking. Default: false (enabled). */
  thetaCheckDisabled?: boolean
  /** Optional current-turn intent retrieval route guidance. Disabled by default. */
  intentRetrievalRouter?: IntentRetrievalRouterConfigInput
  /** Tier 2 LLM speculation — shared-prefix next-tool prediction during tool-batch waits. Default off. */
  llmSpeculation?: import('./llm-speculation.js').LlmSpeculationConfigInput
  /** Optional OwnershipLedger for real-time file ownership — updated on every file_write. */
  ownershipLedger?: import('./ownership-ledger.js').OwnershipLedger
  /** VSW: session-scoped snapshot manager. When present, run_tests asks it for a
   *  verification snapshot plan; §6 policy decides snapshot-vs-in-place, so the
   *  default (single clean session) stays in-place and behavior is unchanged. */
  verificationSnapshotManager?: import('./verification-snapshot-manager.js').VerificationSnapshotManager
  /** Optional Meridian code graph indexer for structural context. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  /** 冷库回落 import-graph 的会话级共享盒（2026-09-12）：meridian 索引为空时
   *  写工具的 impact 分析图与后台构建 Promise 放这里——buildDeps 逐调用新建
   *  deps 包，只有 config 是逐调用引用转发的会话级持有者（与 meridianIndexer
   *  同构）。lazy init（??=），不要预初始化。 */
  impactGraphState?: { graph: import('./import-graph.js').ImportGraph | null; building: Promise<void> | null }
  /** Plan Mode state — when 'planning', write tools are blocked in tool-pipeline. */
  planModeState?: PlanModeState
  /** Active plan draft file (relative to cwd) — only this path is writable in plan mode. */
  activePlanFilePath?: string | null
  /** Ask Mode state — when 'asking', only pure read-only Q&A tools are allowed. */
  askModeState?: import('./ask-mode.js').AskModeState
  /** Optional stream rules — abort and inject reminders when model output matches patterns.
   *  Each rule has a regex `pattern` and an `inject` message appended as a user reminder. */
  streamRules?: StreamRule[]
  /** V3 Component B: per-domain knowledge persistence for worker lesson precipitation. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Lazy getter for DelegationCoordinator — wired by main.tsx for auto-delegation hooks. */
  coordinatorRef?: () => import('./coordinator.js').DelegationCoordinator | null
  /** All configured providers, keyed by name. Used by goal-criteria's buildCheapClient
   *  to construct a dedicated cheap StreamClient (and by the fallback chain). */
  allProviders?: Record<string, import('../config/schema.js').ProviderConfig>
  /** Explicit opt-in for auto-delegation. Default false — workers cost API budget. */
  autoDelegateEnabled?: boolean
  /** Goal completion judge config (gates /goal & --goal self-declared completion). */
  goalJudge?: {
    /** Default true. When false, the orchestrator accepts the GOAL ACHIEVED marker directly. */
    enabled?: boolean
    /** Max judge runs before accepting unverified (anti reject-loop). Default 3. */
    maxRuns?: number
    /** Phase 2: allow the judge UI/API/DB browser verification. Default false. */
    browser?: boolean
  }
  /** 主控工具门控配置。决定哪些 EXTENDED 工具从主控摘除（委派给 worker）。
   *  updateTools() 复用此状态重新过滤，避免 MCP/LSP 异步注册后把门控整个还原。
   *  缺省 undefined → 不门控（全量）。 */
  toolGating?: {
    enabled: boolean
    coreOverride?: readonly string[]
    extraCore?: readonly string[]
    domainTier?: readonly string[]
    disabledTools?: readonly string[]
  }
  /** 当前 provider 的前缀缓存策略 — 逃生口 /tools enable 用它量化挂载的缓存代价。 */
  prefixCacheStrategy?: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  /** 当前模型是否接受图片输入（多模态 user 消息）。按模型声明（config.models[].supportsVision），
   *  switchModel 重建 agent 时随 ModelSpec 更新。门控工具边界视觉通道：
   *  computer_use 截图仅在 true 时以尾部追加 user 消息回灌模型，false 时静默丢弃。 */
  supportsVision?: boolean
  /** Optional dedicated multimodal client. When supportsVision is false and the user
   *  sends images, this client generates text descriptions that are prepended to
   *  the primary prompt. */
  visionClient?: StreamClient
  /** Prompt template used by the vision bridge. */
  visionModelPrompt?: string
  /** Max output tokens for the vision bridge description. */
  visionModelMaxTokens?: number
  /** 识图桥真实状态（供 UI 显示准确提示，而非只看 config 有没有 visionModel 键）。
   *  active=桥可用；source 区分显式配置 / 自动选择 / 无；reason 记未启用/降级原因。 */
  visionBridge?: {
    active: boolean
    source: 'native' | 'configured' | 'auto' | 'same-provider' | 'none'
    /** 桥接生效或未生效的可读原因（configured/auto 时为选中的 provider/model；none 时为原因）。 */
    detail?: string
  }
  /** TDD gate config — controls whether edit tools are blocked when the model
   *  edits files without running tests. Parsed from RIVET_TDD_GATE env var.
   *  Default: enabled, enforce mode, threshold 3 edits. */
  tddGate?: import('./tdd-gate.js').TddGateConfig
  /** 多会话隔离：读取本会话 TodoStore。turn-end 任务进度回灌与 todo-reminder 快照
   *  统一经此读取，避免并发会话共用全局 defaultStore 串台。缺省回退全局 getTodos()。 */
  getTodos?: () => import('../tools/todo-store.js').TodoItem[]
  /** 同上，读本会话 TodoStore 的退回计数。postSession 落 meta，供跨会话取「todo
   *  退回率」基线——这是本仓唯一的结果侧探测器，此前触发即进黑洞。 */
  getTodoRegressionStats?: () => import('../tools/todo-store.js').TodoRegressionStats
}

/**
 * A structured "course-correction" signal (R4). Emitted only at moments that are
 * meaningful to a watching human: the agent was stuck / convergence stalled, the
 * star-domain harness offered a different framing, and the agent is about to act
 * on it. Internal bookkeeping (heartbeat / sensorium curves / cache diagnostics)
 * deliberately does NOT emit these — selective visibility.
 */
export interface DecisionShift {
  /** Which mechanism produced the nudge. */
  source: 'kick' | 'convergence' | 'radio'
  /** Star-domain persona / domain label (e.g. '天璇'), when applicable. */
  domain?: string
  /** Human-readable reason the agent was stuck / why a shift is warranted. */
  reason: string
  /** Alternative methods / frameworks offered to break the impasse. */
  methods: string[]
  /** Visual weight hint for the UI. Defaults to 'info'. */
  severity?: 'info' | 'warn'
}

/** C3 — payload for Auto mode checkpoint pauses. */
export interface AutonomyCheckpointInfo {
  /** Turns completed in this run when the event fired. */
  turns: number
  /** Human-readable progress digest: files modified, recent tools, token usage. */
  digest: string
  /** Always true for checkpoints (the run pauses awaiting confirmation). */
  paused: true
}

export interface DomainResolvedPayload {
  key: string
  name: string
  matchedKeywords: string[]
  reason: 'keyword' | 'fallback'
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  /** 自动续轮原因（obligation-verification / action-intent / steer / goal-continuation）。
   *  Additive wire field：仅当中间 turn 之后由系统注入提醒并继续运行时携带；
   *  desktop 用它把“给系统的自检回复”与“给用户的交付文本”区分开。 */
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean, evidenceSummary?: EvidenceSummary, continuationReason?: string) => void
  onError: (error: Error) => void
  onAbort: (reason?: string) => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string; suggestion?: string; voluntary?: boolean; source?: string }) => void
  /** Auto session domain resolved at the first bind; observability only. */
  onDomainResolved?: (payload: DomainResolvedPayload) => void
  /** Auto domain drift is user-facing observability only; it never changes model state. */
  onDomainDrift?: (drift: DomainDriftResult) => void
  /** R4 — structured course-correction signal surfaced to the desktop conversation. */
  onDecisionShift?: (shift: DecisionShift) => void
  /**
   * Non-blocking "direction note": fired when the intent gate trips (high commit
   * threshold / linked dead-end / thrashing). The agent always continues — this
   * only surfaces the reasoning/risk as a passive timeline card. The user steers
   * by typing if they want to change direction. (Replaces the old blocking
   * 3-way onIntentPreview confirmation.)
   */
  onIntentNote?: (intent: IntentPreview) => void
  /** Called to drain any pending steer guidance for injection into tool results */
  onSteerDrain?: () => string | null
  /** C3 Auto 模式检查点 — 仅在 auto-safe 模式下、checkpointEveryTurns > 0
   *  时触发。run 暂停等待用户确认（"continue" 继续）。digest 为进度摘要。 */
  onAutonomyCheckpoint?: (info: AutonomyCheckpointInfo) => void
  /** T4 — structured per-worker delegation status/progress (subagent panel). */
  onDelegationActivity?: (activity: DelegationActivity) => void
  /**
   * E4 — optional client tool-landing delegation. Return null to fail-back to
   * local execution (no client / capability miss / timeout). A resolved
   * DelegateResult becomes the tool_result; reject uses isError=false.
   */
  onToolDelegate?: (
    kind: 'apply_edit' | 'terminal_exec',
    payload: Record<string, unknown>,
  ) => Promise<{ content: string; isError?: boolean; uiContent?: string; status?: 'ok' | 'rejected' } | null>
}
