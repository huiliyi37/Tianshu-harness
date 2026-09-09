import type { ModelCapabilityCard, CapabilityTask } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import type { ProviderConfig } from '../config/schema.js'
import { filterToolRegistry, ToolRegistry } from '../tools/registry.js'
import type { DelegationActivity, DelegationIdentity } from '../tools/types.js'
import { BatchShortCircuitJudge, cancelRestEnabled } from './batch-short-circuit.js'
import { ProviderHealthTracker } from './provider-health.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { subagentsDir } from '../config/paths.js'
import { debugLog } from '../utils/debug.js'
import { CircuitBreakerManager } from './worker-circuit-breaker.js'
import { InMemoryMailbox, type WorkerMailbox } from './worker-mailbox.js'
import { profileRegistry } from './profile-registry.js'
import {
  WRITE_DEFAULT_MAX_TURNS,
  historyBudgetEnabled,
  historyBudgetFloor,
  mergeBudgetOverride,
  parseWorkerActualRows,
  shapeWriteBudgetForProfile,
} from './budget-shape.js'
import { hashObjective } from './worker-episode.js'
import { PLAN_CONSTRAINT_PREFIX } from './plan-constraints.js'
import {
  createReadOnlyWorkOrder,
  createWriteWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  parseWorkerResult,
  salvageWorkerResult,
  READ_ONLY_WORKER_TOOLS,
  WRITE_WORKER_TOOLS,
  type AggregationPolicy,
  type WorkOrder,
  type WorkOrderKind,
  type WorkerProfile,
  type WorkerResult,
  type WorkerBudget,
  type WorkOrderScope,
  type WorkerFailureReason,
  buildPolicyCancelledResult,
  clampWorkerMaxTurns,
  deriveWorkerSessionId,
  normalizeReviewVerdictStatus,
} from './work-order.js'
import { buildContractProjection, type ContractProjection } from './contract-projection.js'
import { reconcileWithObjective } from './worker-objective-gate.js'
import { buildPrimaryWorkerPacket } from './worker-prompts.js'
import { runWorkerSession, type WorkerActivityKind, type WorkerCheckpoint, type WorkerSessionConfig, type WorkerSessionRun } from './worker-session.js'
import { saveWorkerSession, loadWorkerSession, consumeCheckpointOnce } from './worker-session-persist.js'
import { buildContinuationObjective, decideContinuation, markContinued, mergeUsage, MAX_BUDGET_CONTINUATIONS } from './worker-continuation.js'
import {
  buildRevisionObjective,
  decideRevision,
  detectEvidenceShortfall,
  markRevised,
  type EvidenceShortfall,
} from './worker-revision.js'
import { WorkerLiveness, EXPLORE_STALL_MS, deriveWorkerStallMs } from './worker-liveness.js'
import { runHandsSession, type HandsSessionConfig, type HandsSessionRun } from './hands-session.js'
import { buildWorkerEpisode, persistWorkerActualIndex } from './worker-episode.js'
import { recordWorkerEpisodeClosure } from './reward-loop.js'
import { signalFromWorkerEpisode, signalsFromVerifiedResults } from './control-plane-adapters.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { classifyProfile } from './coordination-policy.js'
import { aggregateResults } from './aggregation.js'
import { CoordinatorState } from './coordinator-state.js'
import { WorkOrderQueue } from './work-queue.js'
import { CollaborationProtocol, type CollaborationConfig } from './collaboration-protocol.js'
import type { LockIntent } from './semantic-lock.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { precipitateDomainLessons } from './domain-lesson-precipitate.js'
import { inferModelTierFromCard, recommendModelTier, type FailureEscalationCap, type ModelRiskTier, type ModelTier, type ModelTierRecommendation } from './model-tier-policy.js'
import { buildHistoricalModelTierState, recommendModelTierArm, type ModelTierBanditRecommendation } from './model-tier-bandit.js'
import { evaluateModelTierGate, type ModelTierGateDecision } from './model-tier-gate.js'
import {
  buildModelTierGatedDecisionEvent,
  buildModelTierShadowEvent,
  persistModelTierGatedDecision,
  persistModelTierShadow,
  type ModelTierGatedDecisionEvent,
  type ModelTierShadowEvent,
} from './model-tier-shadow.js'
import {
  buildGatedInfluenceAuditEvent,
  persistGatedInfluenceAudit,
  type GatedInfluenceAuditEvent,
} from './gated-influence-audit.js'
import { buildModelPolicyCandidates, selectModelPolicy } from './model-policy-selection.js'
import { buildHistoricalModelRewards } from './model-reward-summary.js'
import type { EFEComponents } from './prediction-error.js'
import type { Sensorium } from './sensorium.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'
import type { Usage } from '../api/types.js'
import { PrewarmCache } from './prewarm.js'
import { StigmergyStore } from '../context/stigmergy.js'
import { batchPrewarm } from './prewarm-file.js'
import type { RuntimeCoordinatorSnapshot } from './runtime-self-model.js'
import { deriveCandidateModels, type CandidateModel } from './candidate-models.js'

/** 等槽 waiter：角色决定它能吃哪个池的槽位。 */
interface WorkerSlotWaiter {
  role: 'explore' | 'write'
  wake: () => void
}

/** Per-turn free-energy signals pulled from the primary loop at delegation time. */
export interface EFERoutingSignals {
  efe: EFEComponents
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
}

export interface EFERoutingConfig {
  /** Gated apply. When false, EFE ranking runs shadow-only (audit events, no dispatch effect). */
  enabled: boolean
  /** Pull latest EFE + sensorium from the primary loop. Undefined → skip EFE routing this call. */
  getSignals: () => EFERoutingSignals | undefined
}

/** Real-time activity event from an in-flight worker (T9 P3 实时上行). */
export interface WorkerActivityEvent {
  workOrderId: string
  profile: string
  /** Optional dispatch scope and execution identity; legacy activity omits them. */
  dispatchId?: string
  attemptId?: string
  parentAttemptId?: string
  /** Worker task objective (from WorkOrder) — desktop panel / activity mapper. */
  objective?: string
  /** 用户契约投影（白名单构造，随每条事件携带；mapper 只在首条转发）。 */
  contract?: ContractProjection
  /** 星域 id（星名来源），由 coordinator 从 order.authority 透传。 */
  authority?: string
  /** Why this authority was chosen (from WorkOrder.authorityReason). */
  authorityReason?: string
  kind: WorkerActivityKind
  /** Tool name for tool events; text delta for text/thinking; 累计 token 总数 for turn;
   *  中文阶段短语 for lifecycle. */
  detail?: string
}

const CONTINUATION_REASON_LABEL: Record<'max_turns' | 'timeout', string> = {
  max_turns: '轮次预算耗尽',
  timeout: '时间预算耗尽',
}

const SHORTFALL_LABEL: Record<EvidenceShortfall, string> = {
  claimed_verified_downgraded: '宣称已验证但证据不成立',
  unproven_claim_in_summary: '摘要含未经验证的宣称',
}

/**
 * 补偿轮的阶段事件。走 worker 自己那条 onActivity 通道（已由 delegateOrder 包成
 * liveness + 请求侧上行的扇出），因此不需要额外的传输管线——但补偿轮**不是** worker
 * 发起的，worker 不知道自己在第几次续跑，只有派发侧知道，所以由这里补发。
 */
function emitLifecycle(workerConfig: WorkerSessionConfig, detail: string): void {
  try {
    workerConfig.onActivity?.('lifecycle', detail)
  } catch { /* UI upstream must never break dispatch */ }
}

/**
 * Derive a stable WorkOrder id from a parentTurnId that carries a known
 * scheduling prefix:
 *  - `team:` — planner/task ids, so WorkOrderQueue can resolve dependency refs;
 *  - `council:` —议事会席位 id，让 runCouncil 能用 result.workOrderId 把每席
 *    结果绑回对应席位（=== `council:seat-${seat}`）。
 *  - `batch:` — delegate_batch task index, so the model can declare cross-task
 *    `dependsOn` and WorkOrderQueue can enforce ordering within one batch.
 * Returns undefined for ad-hoc turns — caller falls back to `wo_<uuid>`.
 * 取末两段（slice(-2)）以容忍 `prefix:team:T1` / `prefix:council:seat-x` 形态。
 */
export function deriveStableWorkOrderId(parentTurnId: string): string | undefined {
  return /\b(team|council|batch):/.test(parentTurnId)
    ? parentTurnId.split(':').slice(-2).join(':')
    : undefined
}

/**
 * Order id 派生（含嵌套命名空间）——coordinator 建单与 delegate-batch 预计算
 * （objectiveById / dependencies）共用同一口径，防漂移。
 *
 * deriveStableWorkOrderId 只取末两段：顶层批靠它获得跨重派稳定 id（rerun 去重、
 * fleet 卡片复用）。但 worker 内再派 delegate_batch（delegationDepth>0）会产出
 * 同样的 'batch:N'——orderControllers/liveness/steerQueues 等 side-table 互踩，
 * 父批 finally 还会误删嵌套 worker 的注册项（kill/steer 误伤）。嵌套批保留
 * parentTurnId 的工具调用前缀作命名空间（每次工具调用唯一）；team:/council:
 * 的跨波/重派语义不动；顶层批（depth 0）行为完全不变。
 */
export function deriveWorkOrderId(parentTurnId: string, delegationDepth?: number): string | undefined {
  const stableId = deriveStableWorkOrderId(parentTurnId)
  if (!stableId || (delegationDepth ?? 0) === 0) return stableId
  if (!stableId.startsWith('batch:')) return stableId
  const ns = parentTurnId.slice(0, parentTurnId.length - stableId.length - 1)
  return ns ? `${ns}:${stableId}` : stableId
}

const TIER_FLOOR_RANK: Record<ModelTier, number> = { cheap: 0, balanced: 1, strong: 2 }

/** 瑶光门语义：floor 是「不得低于」的硬地板，只抬升不降级。 */
export function applyTierFloor(tier: ModelTier, floor?: ModelTier): ModelTier {
  if (!floor) return tier
  return TIER_FLOOR_RANK[tier] >= TIER_FLOOR_RANK[floor] ? tier : floor
}

/** 失败升档天花板下允许的最高档位。'off' 时不允许任何升档(返回 null)。
 *  缺省 fail-closed：升档是全新会话零缓存全量重跑（成本可达 flash 数倍），
 *  构造路径漏传 escalationCap 时必须等于关死——想开就显式配 workers.escalationCap。 */
export function escalationTierAllowed(cap: FailureEscalationCap | undefined): ModelTier | null {
  const effective = cap ?? 'off'
  if (effective === 'off') return null
  return effective
}

export interface DelegationRequest {
  parentTurnId: string
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  scope: WorkOrderScope
  /** Task-level constraints rendered into the worker prompt. Absent falls back
   *  to profile boilerplate, which is what every dispatch got before this field
   *  existed — the plan's anti-goals died in the orchestrator's paraphrase
   *  (see docs/design/2026-08-02-工单约束通道.md). */
  constraints?: string[]
  /** Review-router re-entrancy depth to pass into worker tool contexts. */
  reviewDepth?: number
  /** B3: delegation nesting depth (0 = primary → worker). Requests at
   *  MAX_DELEGATION_DEPTH or deeper are rejected as blocked. */
  delegationDepth?: number
  /** Real-time worker activity upstream (T9 P3). Fired for every worker
   *  text/thinking/tool event so the calling tool can stream live progress
   *  into the UI tool card. NOT serialized into the WorkOrder. */
  onActivity?: (event: WorkerActivityEvent) => void
  /** 嵌套委派上行（已映射的 DelegationActivity 透传通道）：本次派发的 worker
   *  自己再派 sub-worker 时，sub-worker 的活动事件经此回传调用方（通常直通
   *  params.onWorkerActivity → 会话事件流）。coordinator 转发前会把
   *  parentWorkerId 盖为本 order id，UI 据此渲染真实委派层级。NOT serialized. */
  onNestedActivity?: (activity: DelegationActivity) => void
  /** Work order IDs this task depends on — propagated to WorkOrder.dependencies.
   *  支持条件边（收编 #6）：{ dependsOn, onFailure: 'skip'|'alternate', alternateOrderId }。 */
  dependencies?: Array<string | import('./work-order.js').DependencyEdge>
  /** Logical group identifier for related tasks (e.g. team wave). */
  groupId?: string
  /** 写工显式 opt-in 批级共享信息素（星河收编 #3）。读工默认共享；写工只有
   *  显式声明才挂批级 store——信号可能引导实现偏向，守护实现独立性。
   *  Not serialized into the WorkOrder. */
  batchStigmergy?: boolean
  /** Group-level quorum threshold (only meaningful when groupId is set).
   *  When the batch policy is `{ kind: 'quorum' }`, this overrides the global
   *  k for this group — e.g. galaxy DP replicas with different replica counts
   *  need per-group thresholds. Not serialized into the WorkOrder. */
  quorumK?: number
  /** Star domain authority for cognitive injection (V3 Component A).
   *  When set, the worker's frozen <star-domain> prefix is pinned to this domain
   *  (worker-session.ts defaultDomain: order.authority； volatileBlock + 共享纪律
   *  在该结构常量位注入，user 消息不再重复）。Tool access becomes the
   *  intersection profile.allowedTools ∩ domain.toolWhitelist (work-order.ts
   *  toolsForAuthority) — fail-closed: an unknown/unloaded authority yields []
   *  (deny-all). Built-in domains currently ship full-set whitelists, so the
   *  intersection degenerates to the profile set, but custom domains can and
   *  do restrict tools. Custom domains are loaded at startup, so this must
   *  remain an open string. */
  authority?: string
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier?: ModelRiskTier
  /** 瑶光门 tier 下限：路由结果不得低于此档（council 席位 tierHint+noDowngrade）。
   *  只抬升不降级；modelOverride 仍然最高优先。 */
  tierFloor?: ModelTier
  /** B2: current session turn for progressive timeout alignment. */
  sessionTurn?: number
  /** Per-request budget overrides (timeout/turns/tokens/retries). Takes
   *  precedence over profile defaults — used e.g. by the auto wiring review
   *  to run a reviewer-profile worker on a short, non-blocking budget. */
  budget?: Partial<WorkerBudget>
  /** Resume a previous worker session by work order id. When provided, the
   *  coordinator loads the prior session's messages and the worker continues
   *  from that context instead of starting fresh. The objective should
   *  describe the continuation task. */
  resumeWorkOrderId?: string
  /** Per-request provider/model override (highest routing precedence). Threaded
   *  onto the WorkOrder; the runtime factory builds a dedicated client for it.
   *  Used by heterogeneous council seats. Silently falls back to the session
   *  model when the provider is unknown or lacks credentials. */
  modelOverride?: { provider: string; model: string }
}

export interface CoordinatorRun {
  status: 'completed' | 'skipped'
  order?: WorkOrder
  selectedModel?: string
  /** True when consecutive failures exceed threshold — primary agent should switch to inline execution. */
  escalated?: boolean
  /** Batch-only metadata: selected worker model per work order. Telemetry only; never affects dispatch. */
  workerModels?: Array<{ workOrderId: string; model: string }>
  /** Append-only tier recommendation telemetry; shadow-only and never affects dispatch. */
  modelTierShadows?: ModelTierShadowEvent[]
  /** Append-only gated tier decisions; applied only behind explicit feature flag and hard gates. */
  modelTierGatedDecisions?: ModelTierGatedDecisionEvent[]
  /** Unified append-only Shadow→Gated audit events; never used as a decision source. */
  gatedInfluenceAudits?: GatedInfluenceAuditEvent[]
  results: IdentifiedWorkerResult[]
  packet: string
  aggregationPolicy?: AggregationPolicy
}

/** Runtime result metadata stamped by the coordinator, never trusted from the worker packet. */
export type IdentifiedWorkerResult = WorkerResult & DelegationIdentity

export function stampWorkerResultIdentity(
  result: WorkerResult,
  identity: DelegationIdentity,
): IdentifiedWorkerResult {
  const stamped = { ...result } as IdentifiedWorkerResult
  delete stamped.dispatchId
  delete stamped.attemptId
  delete stamped.parentAttemptId
  if (identity.dispatchId !== undefined) stamped.dispatchId = identity.dispatchId
  if (identity.attemptId !== undefined) stamped.attemptId = identity.attemptId
  if (identity.parentAttemptId !== undefined) stamped.parentAttemptId = identity.parentAttemptId
  return stamped
}

export type WorkerRuntimeFactory = (
  order: WorkOrder,
  card: ModelCapabilityCard,
  workerRegistry: ToolRegistry,
) => WorkerSessionConfig

export interface WorkerRouteConfig {
  profiles: Record<string, { provider: string; model: string }>
  routing: Record<string, string>
  providers?: Record<string, ProviderConfig>
}

export interface DelegationCoordinatorConfig {
  baseToolRegistry: ToolRegistry
  modelCards: ModelCapabilityCard[]
  /** Global max concurrent workers (cap for both explore and write pools). */
  maxWorkers: number
  /** Max concurrent explore (read-only) workers. Default: maxWorkers. */
  maxExploreWorkers?: number
  /** Max concurrent hands (write) workers. Default: maxWorkers. */
  maxWriteWorkers?: number
  /** S4：DP 副本 A/B 候选模型池来源。整份 provider 配置传入即可——推导侧按
   *  凭据就绪过滤（preset 快照含用户没配 key 的提供商）。缺省 undefined →
   *  无候选池，DP 副本不轮换（旧行为）。 */
  providers?: Record<string, ProviderConfig>
  /** S4：显式候选模型提供者（测试/定制装配用）。缺省 → 用 providers 推导。 */
  getCandidateModels?: () => Array<{ provider: string; model: string }>
  runtimeFactory: WorkerRuntimeFactory
  routing?: WorkerRouteConfig
  runWorker?: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  runHands?: (config: HandsSessionConfig) => Promise<HandsSessionRun>
  cwd?: string
  activeClaims?: () => import('../context/claims.js').ContextClaim[]
  /** Optional provider health tracker for Physarum-style routing.
   *  When set, cold-tier providers are excluded from model selection. */
  providerHealth?: ProviderHealthTracker
  /** Wave 3 控制面：worker 事实上报出口（episode 路径 + aggregation 路径）。
   *  best-effort——控制面故障绝不影响派发。 */
  onControlSignal?: (signal: import('./control-plane.js').ControlSignal) => void
  /** 证据义务出口（evidence-driven reasoning loop）：verifyWorkerEvidence 后的
   *  gated 结果回调，主控为未验证写入声明创建 external_claim 义务。设置后
   *  worker unverified 信号降级为 status（worker_claim_single_voice——义务是
   *  唯一的模型可见声音）。best-effort，义务归账故障绝不影响派发。 */
  onVerifiedResults?: (results: readonly WorkerResult[]) => void
  /** Optional session registry for cross-process file claim coordination. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current session ID for claim management. */
  sessionId?: string
  /** Primary session artifact store. When set, worker artifacts are made resolvable
   *  by registering their session directories as fallbacks, and large worker
   *  packets can be offloaded into the primary store. */
  artifactStore?: import('../artifact/store.js').ArtifactStore
  /** Optional collaboration protocol for semantic locking and merge coordination. */
  collaboration?: CollaborationConfig
  /** AbortSignal to propagate to workers — fires when the tool-level timeout
   *  rejects the outer promise, so zombie workers are cleaned up immediately
   *  instead of waiting for their internal 180s timeout. */
  abortSignal?: AbortSignal
  /** Review-specific model cards keyed by WorkerProfile name (e.g. 'adversarial_verifier',
   *  'reviewer', 'verifier', 'patcher'). When a delegated work order's profile matches
   *  a key, the override card is used directly (bypasses tier filtering and worker
   *  routing). Lets review workers use a different provider/model from the session's
   *  primary — key motivation: prevent server-side-cache providers (GLM/Kimi
   *  implicit caches, Codex) review workers from evicting the main session's cache. */
  reviewOverrideCards?: Map<string, ModelCapabilityCard>
  /** V3 Component B: domain knowledge store for precipitate/recall lifecycle.
   *  When provided, coordinator auto-precipitates lessons from worker results. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Optional append-only store for P3/P4-d model tier shadow telemetry and reward history. */
  modelTierShadowStore?: import('./model-tier-shadow.js').ModelTierShadowStore | null
  /** P4-d gated worker tier influence flag. Defaults to shadow-only. */
  modelTierBanditEnabled?: boolean
  /** Append-only unified gated influence audit store. Defaults to modelTierShadowStore when omitted. */
  gatedInfluenceAuditStore?: import('./gated-influence-audit.js').GatedInfluenceAuditStore | null
  /** Track 1: EFE × provider-health worker model routing.
   *  Always audited; applied to dispatch only when enabled (explicit user routing
   *  config still takes precedence over EFE). */
  efeRouting?: EFERoutingConfig
  /** A4: silence tolerance before an in-flight worker is considered stalled
   *  and aborted by the sweep. Defaults to EXPLORE_STALL_MS (write workers
   *  get WRITE_STALL_MS). Workers die for silence, never for duration. */
  workerStallMs?: number
  /** Injectable clock for liveness tests. */
  livenessClock?: () => number
  /** T5: enable fingerprint-based result resume. Default false (opt-in); set true in bootstrap. */
  resumeEnabled?: boolean
  /** Per-profile circuit breaker — fast-fails delegation to profiles that are
   *  repeatedly failing, preventing cascade waste. When omitted a default
   *  instance is created internally. */
  circuitBreaker?: CircuitBreakerManager
  /** Max nesting depth for delegation. Falls back to MAX_DELEGATION_DEPTH when unset. */
  maxDelegationDepth?: number
  /** Injectable sleep function for backoff retry testing. Defaults to real setTimeout. */
  retrySleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Shared-worktree mode: when true, write (hands) workers run directly in the
   *  shared cwd (the controller's single worktree/branch) instead of each
   *  spawning its own git worktree. Orthogonal shards touch disjoint files; the
   *  file-claim registry + groupTeamTasks same-file serialization prevent
   *  stomping. Trades the per-worker isolated diff for a simpler "all changes
   *  land in one workspace, controller reads aggregate git diff" model. */
  sharedWorktree?: boolean
  /** 天梁 patcher 子代理的默认 tier（config.workers.patcherTier）。
   *  传入 recommendModelTier 的 workerTierOverride——用户可自定义执行者用哪档模型。 */
  patcherTier?: ModelTier
  /** 失败升档天花板（config.workers.escalationCap）。只约束失败驱动的升档——
   *  规则升档（consecutiveFailures≥2）与 Flash→Pro 升档重试；不影响前置路由
   *  （workers.routing 如 planning→capable、hardFloor、瑶光门 tierFloor）。
   *  动机：升档重试是全新会话零缓存全量重跑整个 work order，成本可达 flash
   *  的数十倍；而规划类 worker 本就从小上下文起步，前置用强模型成本可控。
   *  'off' = 失败不升档；'balanced' = 最多升到 balanced 卡重试；
   *  'strong' = 旧行为。缺省视为 'strong'（库级向后兼容，产品默认 config 层给 'off'）。 */
  escalationCap?: FailureEscalationCap
  /** Approval mode of the primary session. Only `dangerously-skip-permissions` is
   *  delegated downward to workers (see WorkerSessionConfig.parentApprovalMode). */
  parentApprovalMode?: import('./loop-types.js').ApprovalMode
  /** 计划约束兜底注入（D8 L2）。返回已渲染的 constraints 条目，与 request.constraints
   *  合并后进工单（request 在前，计划级在后）。best-effort——抛错或返回空都只是少
   *  几条约束，绝不阻断派发。 */
  getPlanConstraints?: (objective: string) => readonly string[] | undefined
}

/**
 * L2 计划约束兜底注入：request.constraints 在前（任务级更贴，优先占满 12 条预算），
 * 计划级在后。getPlanConstraints 抛错时退化为只用 request.constraints——fail-open，
 * 计划解析失败绝不影响派发。四个工单创建点共用，不复制四遍。
 *
 * 双源防冲突（D8 接线后）：request.constraints 已含计划级条目（PLAN_CONSTRAINT_PREFIX
 * 前缀 = plan-constraints.ts PREFIX_BY_KIND 的渲染指纹）时直接返回——显式来源（如
 * starflow 契约 nonGoals/obligations、team planJson）在场，兜底让位；否则照旧
 * 追加 getPlanConstraints（含「最近 approved 计划」零接线回退）。
 */
export function withPlanConstraints(
  constraints: string[] | undefined,
  objective: string,
  config: Pick<DelegationCoordinatorConfig, 'getPlanConstraints'>,
): string[] | undefined {
  if (constraints?.some(c => c.startsWith(PLAN_CONSTRAINT_PREFIX))) return constraints
  if (!config.getPlanConstraints) return constraints
  let planLevel: readonly string[] | undefined
  try {
    planLevel = config.getPlanConstraints(objective)
  } catch {
    planLevel = undefined
  }
  if (!planLevel || planLevel.length === 0) return constraints
  return [...(constraints ?? []), ...planLevel]
}

export function shouldDelegateObjective(objective: string, scope: WorkOrderScope): boolean {
  const trimmed = objective.trim()
  const words = trimmed.split(/\s+/).filter(Boolean).length
  // CJK text carries no whitespace, so whitespace word-count drastically
  // undercounts Chinese/Japanese objectives — a fully-detailed Chinese task (and
  // even the patcher's Chinese instruction prefix) reads as ~1 "word" and would
  // be wrongly skipped, silently dispatching zero workers. Count CJK characters
  // as tokens so substantive non-Latin objectives clear the gate. Additive: pure
  // OR branch, so existing Latin behavior is unchanged.
  const cjkChars = (trimmed.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length
  return words >= 6 || cjkChars >= 8 || (scope.files?.length ?? 0) >= 2 || (scope.symbols?.length ?? 0) >= 2
}

/**
 * Sleep with abort support. Resolves after `ms` or rejects immediately when
 * the signal fires. Listener is cleaned up on resolve to prevent accumulation.
 * In test environments (RIVET_TEST=1), delay is clamped to 0 for speed.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const actualMs = process.env.RIVET_TEST ? 0 : ms
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted during backoff: signal already fired'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted during backoff'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, actualMs)
  })
}

export function classifyWorkerError(error: unknown): WorkerFailureReason {
  const msg = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout|exceeded.*time/i.test(msg)) return 'timeout'
  if (/JSON|parse.*fail|malformed|unexpected token|Unterminated string/i.test(msg)) return 'json_parse'
  if (/schema|validation.*fail|does not match/i.test(msg)) return 'schema_mismatch'
  if (/circuit.*open|breaker/i.test(msg)) return 'circuit_open'
  // stall-sweep 击杀消息自带 "stalled:"（wrapAbort 构造）；置 caller_aborted 之前——
  // 该消息同时含 "aborted by stall sweep"，空转语义优先于取消语义（2026-08-26 收尾）。
  if (/stalled/i.test(msg)) return 'stalled'
  if (/delegation aborted|aborted during|caller.*cancelled|cancelled.*caller/i.test(msg)) return 'caller_aborted'
  if (/claim.*conflict|claimed by/i.test(msg)) return 'claim_conflict'
  // 不带裸 'signal'：含 signal 但非崩溃的消息（如"signal already used"）会
  // 误判 worker_crash；"killed by signal 9" 由 killed 覆盖，漏归 unknown
  // 比误判崩溃更诚实（审查 LOW 收口，2026-08-25）。
  if (/crash|killed|ECONNRESET/i.test(msg)) return 'worker_crash'
  return 'unknown'
}

export function workerFailureResult(order: WorkOrder, error: unknown, opts?: { nextActions?: string[]; failureReason?: WorkerFailureReason }): WorkerResult {
  const reason = error instanceof Error ? error.message : String(error)
  const nextActions = opts?.nextActions ?? ['Primary should continue without trusting this worker result']
  // 兜底归类：未显式传 reason 时按错误消息推断（timeout/crash/parse 等），
  // 不再一律盖 'unknown'——消费方可按 failureReason 差异化恢复。
  const failureReason = opts?.failureReason ?? classifyWorkerError(error)
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker ${failureReason === 'timeout' ? 'timed out' : 'failed'}: ${reason}`,
    findings: [],
    artifacts: [{ kind: 'risk', title: `Worker execution ${failureReason === 'timeout' ? 'timed out' : 'failed'}`, content: reason }],
    changedFiles: [],
    risks: [`worker ${failureReason === 'timeout' ? 'timed out' : 'failed'}: ${reason}`],
    nextActions,
    evidenceStatus: 'blocked',
    failureReason,
  }
}

/**
 * A3: a task whose dependency failed (or never completed) must be reported as
 * `blocked`, not silently dropped. Without this, `delegateBatch` returns
 * "completed" while dependents of a failed worker vanish from `run.results` —
 * the primary never learns the sub-tree was abandoned.
 */
function blockedDependencyResult(order: WorkOrder, unmetDeps: string[], failedDeps: string[]): WorkerResult {
  const detail = failedDeps.length > 0
    ? `dependency failed: ${failedDeps.join(', ')}`
    : `dependency never completed: ${unmetDeps.join(', ')}`
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Task blocked — ${detail}`,
    findings: [],
    artifacts: [{ kind: 'risk', title: 'Dependency unmet', content: detail }],
    changedFiles: [],
    risks: [`blocked by unmet dependency: ${detail}`],
    nextActions: ['Re-dispatch this task after its dependency succeeds, or drop the dependency'],
    evidenceStatus: 'blocked',
  }
}

/**
 * 条件依赖边 skipped（星河收编 #6）：依赖失败且 onFailure=skip（或 alternate
 * 也失败）→ 本任务不执行。status 仍 blocked（无 skipped 状态），但 summary/
 * risks 明确「跳过」语义——不是依赖未完成，是主动放弃。
 */
function skippedDependencyResult(order: WorkOrder, skippedDeps: string[]): WorkerResult {
  const detail = skippedDeps.join(', ')
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Task skipped — conditional dependency failed (onFailure=skip): ${detail}`,
    findings: [],
    artifacts: [{ kind: 'risk', title: 'Dependency skipped', content: detail }],
    changedFiles: [],
    risks: [`skipped by conditional dependency: ${detail}`],
    nextActions: ['Drop the conditional dependency, or re-dispatch with a passing dependency'],
    evidenceStatus: 'blocked',
  }
}

/** Cap on persisted worker-result files under ~/.rivet/subagents/. Without a
 *  TTL/cap this write-mostly sink grew unbounded (one+ file per worker, forever). */
export const MAX_SUBAGENT_RESULTS = 500

/** Minimum acceptable summary length. When a worker's summary is shorter, the
 *  coordinator auto-triggers a follow-up expansion turn so the parent agent
 *  receives a technically complete handoff. */
export const SUMMARY_MIN_LENGTH = 200
/** Max follow-up attempts for brief summaries. 1 = single retry, then accept. */
export const SUMMARY_CONTINUATION_ATTEMPTS = 1

/** LRU-evict ~/.rivet/subagents/ down to `limit` files (oldest mtime first).
 *  Best-effort and exported for testing. Returns the basenames evicted. */
export function evictOldSubagentResults(dir: string, limit = MAX_SUBAGENT_RESULTS): string[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  if (files.length <= limit) return []
  const withMtime = files.map(f => {
    let mtime = 0
    try { mtime = statSync(join(dir, f)).mtimeMs } catch { /* ignore */ }
    return { f, mtime }
  })
  withMtime.sort((a, b) => a.mtime - b.mtime)
  const toEvict = withMtime.slice(0, files.length - limit).map(({ f }) => f)
  for (const f of toEvict) {
    try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
  }
  return toEvict
}

/**
 * Persist worker result to ~/.rivet/subagents/ for future resume/inspection.
 *
 * 落三类文件：
 * - `<orderId>.json` —— 最新一轮副本（loadPersistedResult 读它，行为不变）。
 * - `<orderId>.<nonce>.json` —— 按派发 nonce 的逐轮归档（有 nonce 时）。稳定
 *   order id（batch:0 / team:T1）跨委派复用，没有 nonce 时第二次派发会把第一轮
 *   的 findings/usage 物理覆盖（L1）。nonce 与 worker 会话 JSONL 同源
 *   （deriveWorkerSessionId 那颗）。
 * - `<fingerprint>.json` —— T5 resume 指纹副本。
 *
 * LRU 说明：归档让每次派发多占一个文件，MAX_SUBAGENT_RESULTS 会比「复用免费」
 * 时代更早触顶；淘汰仍按最旧 mtime 优先，语义不变——最旧的轮次先死。
 * homeDir 仅供测试注入（与 loadPersistedResult 同例）。
 */
export function persistWorkerResult(result: WorkerResult, fingerprint?: string, dispatchNonce?: string, homeDir?: string): void {
  try {
    const dir = coordinatorSubagentsDir(homeDir)
    mkdirSync(dir, { recursive: true })
    const json = JSON.stringify(result, null, 2)
    writeFileSync(join(dir, `${result.workOrderId}.json`), json, 'utf-8')
    if (dispatchNonce) {
      writeFileSync(join(dir, `${result.workOrderId}.${dispatchNonce}.json`), json, 'utf-8')
    }
    // T5: also write a fingerprint-indexed copy for resume lookup
    if (fingerprint) {
      writeFileSync(join(dir, `${fingerprint}.json`), json, 'utf-8')
    }
    // Keep the sink bounded — LRU-evict once it exceeds the cap.
    evictOldSubagentResults(dir)
  } catch {
    // Best-effort: never block primary session on persistence failure
  }
}

/** B1: read back a previously persisted worker result for resume/inspection.
 *  The persistWorkerResult sink used to have no reader (write-only grave).
 *  Returns null on cold miss or unparseable content — callers must handle it. */
function coordinatorSubagentsDir(homeDir?: string): string {
  // `homeDir` is the legacy "user home" parameter used by tests.
  // In production, default to the unified subagentsDir() under RIVET_HOME.
  if (homeDir) return join(homeDir, '.rivet', 'subagents')
  return subagentsDir()
}

export function loadPersistedResult(orderId: string, homeDir?: string): WorkerResult | null {
  try {
    const path = join(coordinatorSubagentsDir(homeDir), `${orderId}.json`)
    if (!existsSync(path)) return null
    return parseWorkerResult(readFileSync(path, 'utf-8'), orderId)
  } catch {
    return null
  }
}

/** nonce 必须是不含路径语义的裸标识符——它会拼进文件名，拒绝分隔符与父目录逃逸。 */
function isSafeRoundNonce(nonce: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(nonce)
}

/** 一轮派发的归档元数据（L1）。 */
export interface PersistedResultRound {
  /** 派发 nonce，与 worker 会话 JSONL（worker-<id>-<nonce>.jsonl）后缀同源。 */
  nonce: string
  /** 文件 mtime——派发完成时间，兼作轮次排序键。 */
  savedAt: number
}

/**
 * 列出某个 order id 的全部归档轮次，按时间升序（第 0 条是首轮）。
 * 只数 `<orderId>.<nonce>.json`：`<orderId>.json` 最新副本（nonce 为空被排除）
 * 与指纹文件（不带 order id 前缀）都不算轮次。
 */
export function listPersistedResultRounds(orderId: string, homeDir?: string): PersistedResultRound[] {
  try {
    const dir = coordinatorSubagentsDir(homeDir)
    const prefix = `${orderId}.`
    const rounds: PersistedResultRound[] = []
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.json')) continue
      const nonce = f.slice(prefix.length, -'.json'.length)
      if (!isSafeRoundNonce(nonce)) continue
      let savedAt = 0
      try { savedAt = statSync(join(dir, f)).mtimeMs } catch { /* ignore */ }
      rounds.push({ nonce, savedAt })
    }
    rounds.sort((a, b) => a.savedAt - b.savedAt)
    return rounds
  } catch {
    return []
  }
}

/** 读取指定轮次的归档结果；未知轮次、非法 nonce 或无法解析一律返回 null。 */
export function loadPersistedResultRound(orderId: string, nonce: string, homeDir?: string): WorkerResult | null {
  if (!isSafeRoundNonce(nonce)) return null
  try {
    const path = join(coordinatorSubagentsDir(homeDir), `${orderId}.${nonce}.json`)
    if (!existsSync(path)) return null
    return parseWorkerResult(readFileSync(path, 'utf-8'), orderId)
  } catch {
    return null
  }
}

/** delegateOrder 内部流转的单次派发状态（首轮 / 重试 / 升级 / 续跑共用同一形状）。 */
interface DelegateRunState {
  result: WorkerResult
  transcript?: WorkerSessionRun['transcript']
  sessionMessages?: readonly OaiMessage[]
  /** Resume checkpoint carried from this run (abort/continuation). Persisted
   *  on final save so a later (possibly cross-process) resume can pick it up. */
  checkpoint?: WorkerCheckpoint
  /** 本轮导出的冻结前缀快照——续跑/复核/扩写/重试经
   *  WorkerSessionConfig.priorFrozenSnapshot 回传给新引擎继承（跨进程边界
   *  保持历史 user 消息字节，前缀缓存只在新 user 边界断尾）。与
   *  sessionMessages 同生命周期：每轮新快照覆盖，缺席则保留上一轮。 */
  frozenSnapshot?: FrozenSnapshotData
  usage?: Usage | Partial<Usage>
  providerName?: string
}

/** T5: fingerprint a delegation request for result reuse. */
function fingerprintRequest(objective: string, files: string[] | undefined, profile: string): string {
  const key = `${objective}|${(files ?? []).sort().join(',')}|${profile}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** T5: scan ~/.rivet/subagents/ for a matching completed result within the last hour. */
function tryResumeWorkerResult(
  objective: string,
  files: string[] | undefined,
  profile: string,
  nowMs: number,
  homeDir?: string,
): WorkerResult | null {
  const fp = fingerprintRequest(objective, files, profile)
  const path = join(coordinatorSubagentsDir(homeDir), `${fp}.json`)
  if (!existsSync(path)) return null
  try {
    const stat = statSync(path)
    if (nowMs - stat.mtimeMs > 3_600_000) return null
    const result = parseWorkerResult(readFileSync(path, 'utf-8'), fp)
    if (result && result.status === 'passed') {
      return { ...result, summary: `[resumed] ${result.summary}` }
    }
  } catch {
    // Corrupt file — skip
  }
  return null
}

/** B3: max delegation nesting depth — primary(0) → worker(1) → grand-worker(2 ✗).
 *  Aligned with Cursor's "nested but gated" stance rather than Claude's full ban:
 *  planner profiles legitimately think-then-delegate, but unbounded recursion
 *  must be impossible. */
export const MAX_DELEGATION_DEPTH = 2

/** Grace period (ms) given to worker-session's internal salvageAbortedReport
 *  before wrapAbort rejects. Without this, the abort signal's immediate reject
 *  races ahead of the worker's wasAborted() handler, discarding partial output.
 *  5s is enough for the salvage parse + field extraction; the worker's own API
 *  call has already been aborted by its internal controller at this point. */
const WORKER_ABORT_SALVAGE_GRACE_MS = 5_000

/** B2: background (async) work order handle — Cursor `is_background` analog.
 *  The parent is NOT blocked; results are collected later by id (and are also
 *  persisted to ~/.rivet/subagents/ by the normal dispatch path). */
export interface BackgroundRunHandle {
  id: string
  objective: string
  startedAt: number
  status: 'running' | 'completed' | 'failed'
  run?: CoordinatorRun
  error?: string
}

export class DelegationCoordinator {
  private runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
  private runHands: (config: HandsSessionConfig) => Promise<HandsSessionRun>
  private state: CoordinatorState
  private collaboration: CollaborationProtocol | null
  /** A4: per-worker silence clocks — the runtime primary gate. */
  private readonly liveness: WorkerLiveness
  /** A4: per-order controllers so a stall sweep aborts only the wedged worker. */
  private readonly orderControllers = new Map<string, AbortController>()
  /** 策略短路取消登记簿：delegateBatch 在 abort 前登记，wrapAbort 据此出
   *  'Delegation aborted: policy short-circuit' 消息（保证 isAbort=true 不进
   *  重试、不记 provider 恶评），processNext catch 据此合成非故障结果。 */
  private readonly policyCancelledIds = new Set<string>()
  /** 运行中转录快照 — per-order 活消息 getter（worker session 建好时经
   *  onSessionReady 注册；续跑/重试的新 session 覆盖旧 getter）。终态清除，
   *  读方回落到 saveWorkerSession 的落盘记录。 */
  private readonly liveMessages = new Map<string, () => readonly OaiMessage[]>()
  /** 嵌套委派上行 — per-order DelegationActivity 透传（callbacks don't survive
   *  zod parsing，与 activityUpstream 同款 side table）。 */
  private readonly nestedUpstream = new Map<string, (activity: DelegationActivity) => void>()
  /** T9 P3: per-order real-time activity upstream (request callback survives
   *  the zod request→order conversion via this side table). */
  private readonly activityUpstream = new Map<string, (event: WorkerActivityEvent) => void>()
  /** Batch-scoped shared PrewarmCache — one instance per delegateBatch call,
   *  keyed by order id (side-table pattern, same as activityUpstream) so
   *  overlapping batches never share. Same-batch workers read files warmed by
   *  the pre-dispatch pass and by each other (e.g. DP replicas hitting the
   *  same evidence). Entries are removed as orders settle; the cache itself
   *  stays alive via workerConfig references until the batch drains. */
  private readonly batchPrewarmByOrder = new Map<string, PrewarmCache>()
  /** Batch-scoped shared StigmergyStore（星河收编 #3）— one memory-only instance
   *  per delegateBatch call, keyed by order id (same side-table pattern as
   *  batchPrewarmByOrder). Same-batch workers deposit/read shared pheromones:
   *  a replica finding "X is suspicious" steers later workers to verify X first.
   *  Entries are removed as orders settle; never persisted (batch-scoped GC). */
  private readonly batchStigmergyByOrder = new Map<string, StigmergyStore>()
  /** Per-order prior messages for session resume. Set by delegate() when
   *  resumeWorkOrderId is provided; consumed by delegateOrder() when building
   *  the worker config. Side-table pattern (same as activityUpstream). */
  private readonly resumeMessages = new Map<string, readonly OaiMessage[]>()
  /** W3 re-dispatch entry: latest abort checkpoint per order — captured from
   *  aborted worker runs, re-injected as config.checkpoint when the primary
   *  re-dispatches with resume:'<orderId>'. Bounded FIFO (insertion order). */
  private readonly abortCheckpoints = new Map<string, WorkerCheckpoint>()
  private static readonly MAX_ABORT_CHECKPOINTS = 8
  /** Per-NEW-order checkpoint staged for a resume dispatch (side-table keyed by
   *  the new order id, same pattern as resumeMessages). */
  private readonly resumeCheckpoints = new Map<string, WorkerCheckpoint>()
  /** WC: per-order steer 队列 — 用户在 TUI worker 视图输入的直达消息。
   *  worker 的 onSteerDrain 在工具回合结算时 drain 注入 tool_result。 */
  private readonly steerQueues = new Map<string, string[]>()
  private stallSweep: ReturnType<typeof setInterval> | null = null
  /** T3: Flash→Pro escalation counter per session. Max 3 Pro upgrades. */
  private proUpgradeCount = 0
  private static readonly MAX_PRO_UPGRADES = 3
  /** Per-profile circuit breaker for fast-failing repeatedly broken profiles. */
  readonly circuitBreaker: CircuitBreakerManager
  /** P1-6: global worker concurrency gate — single delegate() / background /
   *  user-launched workers bypass WorkOrderQueue, so we enforce a coordinator
   *  level semaphore (activeWorkerCount ≤ maxWorkers) that covers ALL paths.
   *  batch workers go through the same gate, so batch + single + background
   *  share one concurrency budget instead of each having its own. */
  private activeWorkerCount = 0
  /** S1 分池并发：只读工（explore）与写工（hands）各自的活跃计数，配合
   *  maxExploreWorkers / maxWriteWorkers 池帽；全局 activeWorkerCount 守
   *  总上限（三帽最大值）。 */
  private activeExploreCount = 0
  private activeWriteCount = 0
  /** 等槽队列带角色——释放方按角色定向唤醒，见 wakeEligibleWaiter。 */
  private readonly workerWaiters: WorkerSlotWaiter[] = []
  /** S4 候选池 memo（getCandidateModels 首次推导后缓存）。 */
  private candidateModelsCache?: CandidateModel[]
  private shuttingDown = false
  /** P1-8: global in-flight file claim table. Captures scope + write intent
   *  for every dispatched order so checkGlobalFileConflict can detect cross-
   *  wave overlap (WorkOrderQueue only guards within one batch). */
  private readonly inflightFiles = new Map<string, { files: string[]; writes: boolean }>()
  /** Every dispatch promise currently owned by this coordinator.  Keeping the
   * promise itself (rather than only its AbortController) lets handoff wait for
   * the delegateOrder finally blocks that release file claims. */
  private readonly activeDelegations = new Set<Promise<CoordinatorRun>>()

  constructor(private config: DelegationCoordinatorConfig) {
    this.runWorker = config.runWorker ?? runWorkerSession
    this.runHands = config.runHands ?? runHandsSession
    this.state = new CoordinatorState(config.maxWorkers)
    this.collaboration = config.collaboration ? new CollaborationProtocol(config.collaboration) : null
    this.liveness = new WorkerLiveness({
      stallMs: config.workerStallMs ?? EXPLORE_STALL_MS,
      now: config.livenessClock,
    })
    this.circuitBreaker = config.circuitBreaker ?? new CircuitBreakerManager()
  }

  /** W3: stash an aborted worker's checkpoint (bounded FIFO) and annotate the
   *  blocked result with an explicit re-dispatch entry, so the primary KNOWS
   *  the partial work is resumable instead of writing the worker off. */
  private captureAbortCheckpoint(orderId: string, checkpoint: WorkerCheckpoint | undefined, result: WorkerResult): void {
    if (!checkpoint?.partialResult) return
    if (this.abortCheckpoints.size >= DelegationCoordinator.MAX_ABORT_CHECKPOINTS && !this.abortCheckpoints.has(orderId)) {
      const oldest = this.abortCheckpoints.keys().next().value
      if (oldest !== undefined) this.abortCheckpoints.delete(oldest)
    }
    this.abortCheckpoints.set(orderId, checkpoint)
    if (result.status === 'blocked') {
      result.nextActions = [
        ...result.nextActions,
        `Resumable: re-dispatch with delegate_task/delegate_batch resume:'${orderId}' — the worker's partial progress (${checkpoint.completedTools.length} tool calls, ${checkpoint.partialResult.length} chars) is checkpointed and will be injected as context.`,
      ]
    }
  }

  /** Per-order dispatch nonce — minted once per delegateOrder so the worker's
   *  conversation JSONL / artifact dir are unique per dispatch even though
   *  batch order ids (`batch:0`) repeat across delegation runs. Consulted by
   *  workerArtifactSessionId so the artifact fallback registration matches the
   *  session id the worker actually ran under. */
  private readonly dispatchNonces = new Map<string, string>()

  /** Artifact session id used by a worker for its own ArtifactStore. */
  private workerArtifactSessionId(orderId: string): string {
    return deriveWorkerSessionId(orderId, this.dispatchNonces.get(orderId))
  }

  /** Make worker-produced artifacts resolvable from the primary session store. */
  private registerWorkerArtifacts(orderId: string): void {
    this.config.artifactStore?.addFallbackSession(this.workerArtifactSessionId(orderId))
  }

  /** Lazily start the stall sweep; stop it when no workers are in flight. */
  private ensureStallSweep(): void {
    if (this.stallSweep) return
    const stallMs = this.config.workerStallMs ?? EXPLORE_STALL_MS
    const intervalMs = Math.min(Math.max(Math.floor(stallMs / 2), 50), 15_000)
    const sweep = setInterval(() => {
      for (const id of this.liveness.stalled()) {
        // Abort ONLY the wedged worker — its processNext falls to catch →
        // workerFailureResult; Promise.all(inflight) is unaffected.
        this.orderControllers.get(id)?.abort()
        this.liveness.unregister(id)
      }
      if (this.liveness.size() === 0) this.stopStallSweep()
    }, intervalMs)
    sweep.unref() // never keep the process alive
    this.stallSweep = sweep
  }

  private stopStallSweep(): void {
    if (this.stallSweep) {
      clearInterval(this.stallSweep)
      this.stallSweep = null
    }
  }

  /**
   * 释放进程级资源：用于丢弃 coordinator 时（典型场景是 sidecar
   * switchModel 重建装配栈）。调用后实例不得复用。
   *
   * 副作用：
   * - clearInterval(stallSweep)——`.unref()` 已防止其阻塞进程退出，但
   *   sidecar 长驻进程频繁 switchModel 会累积泄漏的 timer。
   * - abort 所有在途 orderControllers——worker 的 processNext 走 catch
   *   → workerFailureResult 路径，消费者收到 degraded run。
   * - 清空 orderControllers / activityUpstream / backgroundRuns / backgroundPromises
   *   引用，便于 GC 立刻回收（不主动 reject promise，让 worker 自然结算）。
   *
   * 不清理 mailbox / circuitBreaker / collaboration——它们不持有 timer/进程级资源。
   */
  private abortInFlight(): void {
    this.shuttingDown = true
    this.stopStallSweep()
    for (const controller of this.orderControllers.values()) {
      try { controller.abort() } catch { /* ignore */ }
    }
    // Dispatches that are waiting for a semaphore slot do not have an order
    // controller yet. Waking their waiters lets the parent abort propagate and
    // prevents a successor session from inheriting a permanently occupied slot.
    while (this.workerWaiters.length > 0) this.workerWaiters.shift()?.wake()
  }

  private clearDispatchState(): void {
    this.orderControllers.clear()
    this.policyCancelledIds.clear()
    this.liveMessages.clear()
    this.nestedUpstream.clear()
    this.activityUpstream.clear()
    this.resumeMessages.clear()
    this.resumeCheckpoints.clear()
    this.abortCheckpoints.clear()
    this.dispatchNonces.clear()
    this.steerQueues.clear()
    this.backgroundRuns.clear()
    this.backgroundPromises.clear()
    this.inflightFiles.clear()
  }

  /**
   * Abort the current run and wait until delegateOrder finally blocks have
   * released session claims and global file reservations.  The bounded wait is
   * important for providers that ignore AbortSignal; those are reported as a
   * shutdown timeout and the process can still exit without hanging forever.
   *
   * Returns false when the timeout elapsed before every delegation settled.
   * Callers that own the session registry must keep its claims in that case:
   * a worker may still be writing after the abort signal was delivered.
   */
  async shutdownAndWait(timeoutMs = 8_000): Promise<boolean> {
    this.abortInFlight()
    const pending = [...this.activeDelegations]
    let settled = true
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              settled = false
              debugLog(`[coordinator] shutdown timed out with ${this.activeDelegations.size} delegation(s) still settling`)
              resolve()
            }, timeoutMs)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    this.clearDispatchState()
    return settled
  }

  shutdown(): void {
    this.abortInFlight()
    this.clearDispatchState()
  }

  // ── WC: TUI worker 视图直达通道（steer / kill） ──

  /**
   * 向在跑 worker 的 steer 队列投递一条用户消息。
   * worker 在下一个工具回合结算时以 [User guidance] 形态注入 tool_result。
   * 返回 false 表示该 order 已不在跑（终态/未知），消息未入队。
   */
  steerWorker(workOrderId: string, text: string): boolean {
    if (!this.orderControllers.has(workOrderId)) return false
    const q = this.steerQueues.get(workOrderId) ?? []
    q.push(text)
    this.steerQueues.set(workOrderId, q)
    return true
  }

  /**
   * 主动停止单个在跑 worker（TUI /tasks 的 x 键）。
   * 复用 per-order AbortController（与 stall sweep 同一通道）：worker 的
   * processNext 落入 catch → workerFailureResult，批内兄弟不受影响。
   * 返回 false 表示该 order 已不在跑。
   */
  killWorker(workOrderId: string): boolean {
    const controller = this.orderControllers.get(workOrderId)
    if (!controller) return false
    try { controller.abort() } catch { /* already aborted */ }
    return true
  }

  /** 指定 order 当前是否在跑（TUI 判断直达通道可用性）。 */
  isWorkerRunning(workOrderId: string): boolean {
    return this.orderControllers.has(workOrderId)
  }

  /**
   * 运行中 worker 的内存转录快照（服务端 getWorkerLog 优先于落盘记录消费）。
   * 终态/未知 order 返回 undefined——读方回落到 loadWorkerSession。
   * getter 抛错按无快照处理：转录可观测性绝不能反噬派发主路径。
   */
  getLiveWorkerMessages(workOrderId: string): readonly OaiMessage[] | undefined {
    const getMessages = this.liveMessages.get(workOrderId)
    if (!getMessages) return undefined
    try {
      return getMessages()
    } catch {
      return undefined
    }
  }

  /** 任意 worker（前台批次或后台 run）仍在跑时为 true —— /cd 借此拒绝
   *  在 worker 存活期间切换 cwd（worker 会话绑定旧目录）。 */
  hasRunningWork(): boolean {
    if (this.orderControllers.size > 0) return true
    for (const run of this.backgroundRuns.values()) {
      if (run.status === 'running') return true
    }
    return false
  }

  /**
   * Read-only runtime snapshot for session_vitals and diagnostics.
   *
   * This deliberately exposes counters, not worker transcripts or mutable
   * internals. A snapshot must never become a second coordination protocol;
   * callers may display or prioritize signals, but dispatch still goes through
   * the existing gates below.
   */
  getRuntimeSnapshot(): RuntimeCoordinatorSnapshot {
    let activeClaims = 0
    let providerDegradation = 0
    try {
      activeClaims = this.config.activeClaims?.().length ?? 0
    } catch {
      // Diagnostics must remain fail-open when a claim store is unavailable.
    }
    try {
      providerDegradation = this.config.providerHealth?.getDegradationRatio() ?? 0
    } catch {
      // A broken health probe must not break worker dispatch or diagnostics.
    }
    return {
      activeWorkers: this.activeWorkerCount,
      maxWorkers: Math.max(0, this.config.maxWorkers),
      pendingWorkers: this.workerWaiters.length,
      stalledWorkers: this.liveness.stalled().length,
      inFlightFileScopes: this.inflightFiles.size,
      backgroundRunning: [...this.backgroundRuns.values()].filter(run => run.status === 'running').length,
      activeClaims,
      providerDegradation,
      shuttingDown: this.shuttingDown,
    }
  }

  // ── B2: background (async) work orders ──

  private readonly backgroundRuns = new Map<string, BackgroundRunHandle>()
  private readonly backgroundPromises = new Map<string, Promise<CoordinatorRun>>()

  /** Dispatch a worker WITHOUT blocking the caller. Returns a handle id —
   *  poll with getBackgroundRun() or await with waitBackgroundRun(). */
  delegateBackground(request: DelegationRequest, abortSignal?: AbortSignal): string {
    const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const handle: BackgroundRunHandle = {
      id,
      objective: request.objective,
      startedAt: Date.now(),
      status: 'running',
    }
    this.backgroundRuns.set(id, handle)
    const promise = this.delegate(request, abortSignal).then(
      (run) => {
        // T3 alignment: delegate() now converts worker exceptions into degraded
        // completed results (Flash→Pro escalation). Detect degraded runs so the
        // background handle still reflects failure for waitBackgroundRun() callers.
        const resultStatus = run.results[0]?.status
        if (run.status === 'completed' && resultStatus && resultStatus !== 'passed') {
          const reason = run.results[0]?.summary ?? `Worker returned ${resultStatus}`
          handle.status = 'failed'
          handle.error = reason
          handle.run = run
          throw new Error(reason)
        }
        handle.status = 'completed'
        handle.run = run
        return run
      },
      (error: unknown) => {
        handle.status = 'failed'
        handle.error = error instanceof Error ? error.message : String(error)
        throw error
      },
    )
    // Swallow unhandled rejection — the error is captured on the handle and
    // re-surfaces when the caller awaits waitBackgroundRun().
    promise.catch(() => {})
    this.backgroundPromises.set(id, promise)
    return id
  }

  /** Non-blocking status check for a background run. */
  getBackgroundRun(id: string): BackgroundRunHandle | undefined {
    return this.backgroundRuns.get(id)
  }

  /** Await a background run's completion (rethrows its failure). */
  async waitBackgroundRun(id: string): Promise<CoordinatorRun> {
    const p = this.backgroundPromises.get(id)
    if (!p) throw new Error(`Unknown background run: ${id}`)
    return p
  }

  /** All background handles, newest first. */
  listBackgroundRuns(): BackgroundRunHandle[] {
    return [...this.backgroundRuns.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  getState(): CoordinatorState {
    return this.state
  }

  /** Resolve a capability card for an explicit model override. Prefers an
   *  existing card (same model in the primary provider) so tier/telemetry stay
   *  accurate; otherwise clones a base card's quality numbers and swaps the
   *  model name — the override model may live in a different provider not present
   *  in modelCards. The real provider/client is resolved by runtimeFactory. */
  private cardForModelOverride(model: string): ModelCapabilityCard {
    const existing = this.config.modelCards.find(c => c.model === model)
    if (existing) return existing
    const base = this.config.modelCards[0]
    if (base) return { ...base, model }
    return {
      model,
      toolUseReliability: 0.8,
      jsonStability: 0.8,
      editSuccessRate: 0.7,
      testRepairRate: 0.6,
      contextWindow: 128_000,
      cacheEconomics: 'strong',
      recommendedTasks: ['code_edit', 'risky_refactor', 'test_failure_diagnosis'],
    }
  }

  private selectModelForTask(task: CapabilityTask, preferredTier?: ModelTier, profile?: string): ModelCapabilityCard {
    // Review override fast path: when a profile-targeted override card is configured,
    // use it directly. Bypasses tier filtering + worker routing — review workers
    // get exactly the user-configured provider/model. Set up by bootstrap.ts from
    // config.agent.review.profiles. Skip when absent → fall through to normal flow.
    if (profile && this.config.reviewOverrideCards?.has(profile)) {
      const overrideCard = this.config.reviewOverrideCards.get(profile)!
      debugLog(`[worker-model] review-override: profile=${profile} → ${overrideCard.model} ✓`)
      return overrideCard
    }

    const eligibleCards = preferredTier
      ? this.config.modelCards.filter(card => inferModelTierFromCard(card) === preferredTier)
      : this.config.modelCards
    const cards = eligibleCards.length > 0 ? eligibleCards : this.config.modelCards

    if (this.config.routing) {
      const routeName = this.config.routing.routing[task]
      if (routeName && this.config.routing.profiles[routeName]) {
        const routeProfile = this.config.routing.profiles[routeName]

        // Physarum routing: skip cold-tier providers
        const skipCold = this.config.providerHealth?.getWeights()
          .find(h => h.providerId === routeProfile.provider && h.tier === 'cold')
        if (!skipCold) {
          const provider = this.config.routing.providers?.[routeProfile.provider]
          const routeModelExists = !provider || provider.models.some(m => m.id === routeProfile.model || m.alias === routeProfile.model)
          const routeHasCredentials = !provider || provider.auth?.type === 'oauth' || Boolean(provider.apiKey || (provider.apiKeyEnv && process.env[provider.apiKeyEnv]))
          if (routeModelExists && routeHasCredentials) {
            const routed = cards.find(c => c.model === routeProfile.model)
            if (routed) {
              debugLog(`[worker-model] routing: task=${task} → ${routeName} → ${routeProfile.provider}/${routeProfile.model} ✓`)
              return routed
            }
            debugLog(`[worker-model] routing: task=${task} → ${routeName} → ${routeProfile.model} NOT in cards=[${cards.map(c => c.model).join(',')}]`)
          } else {
            debugLog(`[worker-model] routing: task=${task} → ${routeName} skipped (modelExists=${routeModelExists} creds=${routeHasCredentials})`)
          }
        } else {
          debugLog(`[worker-model] routing: task=${task} → ${routeName} skipped (provider ${routeProfile.provider} is cold)`)
        }
      }
    }
    // Track 1: EFE × provider-health routing — consulted after explicit user
    // routing (user intent wins) but before the static capability heuristic.
    const efeChoice = this.selectModelByEFE(task, cards)
    if (efeChoice) {
      debugLog(`[worker-model] efe-routing: task=${task} → ${efeChoice.model}`)
      return efeChoice
    }

    const fallback = recommendModelForTask(task, cards)
    debugLog(`[worker-model] fallback: task=${task} → ${fallback.model} (routing=${this.config.routing ? 'configured' : 'none'})`)
    return fallback
  }

  /**
   * EFE model selection over the candidate cards, re-ranked by Physarum
   * provider health: cold-tier providers are excluded, degraded providers pay
   * an EFE penalty proportional to lost weight. Every evaluation emits a
   * gated-influence audit event; dispatch is only affected when
   * `efeRouting.enabled` is true (shadow→gated pattern).
   */
  private selectModelByEFE(task: CapabilityTask, cards: ModelCapabilityCard[]): ModelCapabilityCard | undefined {
    const cfg = this.config.efeRouting
    if (!cfg) return undefined

    let signals: EFERoutingSignals | undefined
    try {
      signals = cfg.getSignals()
    } catch {
      return undefined
    }
    if (!signals) return undefined

    const weights = this.config.providerHealth?.getWeights() ?? []
    const healthFor = (model: string) => {
      const providerId = this.providerIdForModel(model)
      if (!providerId) return undefined
      return weights.find(h => h.providerId === providerId)
    }

    const warmOrHot = cards.filter(card => healthFor(card.model)?.tier !== 'cold')
    const pool = warmOrHot.length > 0 ? warmOrHot : cards

    let best: { model: string; expectedFreeEnergy: number; adjustedG: number } | undefined
    try {
      const historicalRewards = buildHistoricalModelRewards(this.config.modelTierShadowStore)
      const ranked = selectModelPolicy({
        candidates: buildModelPolicyCandidates(pool, { historicalRewards }),
        efe: signals.efe,
        sensorium: signals.sensorium,
      })
      if (ranked.length === 0) return undefined

      const adjusted = ranked
        .map(sel => {
          const h = healthFor(sel.model)
          const penalty = h ? 0.25 * (1 - h.weight) : 0
          return { model: sel.model, expectedFreeEnergy: sel.expectedFreeEnergy, adjustedG: sel.expectedFreeEnergy + penalty }
        })
        .sort((a, b) => a.adjustedG - b.adjustedG || a.model.localeCompare(b.model))
      best = adjusted[0]!
    } catch {
      return undefined
    }

    const applied = cfg.enabled
    persistGatedInfluenceAudit(
      this.config.gatedInfluenceAuditStore ?? this.config.modelTierShadowStore,
      buildGatedInfluenceAuditEvent({
        source: 'model_routing',
        sessionId: this.config.sessionId ?? 'unknown',
        targetId: `efe_routing:${task}`,
        gateOpen: cfg.enabled,
        applied,
        reason: applied
          ? `EFE routing selected ${best.model} (G=${best.expectedFreeEnergy}, health-adjusted=${best.adjustedG})`
          : 'shadow only — efeRouting.enabled=false',
        evidenceWindow: {
          task,
          selectedModel: best.model,
          expectedFreeEnergy: best.expectedFreeEnergy,
          healthAdjustedG: best.adjustedG,
          candidateCount: pool.length,
          coldExcluded: cards.length - pool.length,
        },
      }),
    )

    if (!applied) return undefined
    return cards.find(c => c.model === best.model)
  }

  /** Resolve which routing provider serves a given model id (or alias). */
  private providerIdForModel(modelId: string): string | undefined {
    const providers = this.config.routing?.providers
    if (!providers) return undefined
    for (const [id, prov] of Object.entries(providers)) {
      if (prov.models.some(m => m.id === modelId || m.alias === modelId)) return id
    }
    return undefined
  }

  /** Feed worker run outcomes into the Physarum provider health tracker.
   *  Only API/runtime-level outcomes count — a worker that completes with a
   *  failed task verdict still proves the provider is healthy. */
  private recordProviderOutcome(modelId: string, ok: boolean): void {
    const health = this.config.providerHealth
    if (!health) return
    const providerId = this.providerIdForModel(modelId)
    if (!providerId) return
    health.registerProvider(providerId)
    if (ok) health.recordSuccess(providerId)
    else health.recordFailure(providerId)
  }

  /** W4-D3: persist one worker episode (+ derived reward closure when the
   *  outcome is capability-attributable) into the shared routing-metrics
   *  store. Shadow-first: rows only influence FUTURE dispatch ranking via
   *  buildHistoricalModelRewards behind the efeRouting gate — never the
   *  current task. Telemetry failures must never affect delegation. */
  private recordWorkerEpisode(order: WorkOrder, handsRun: HandsSessionRun, model: string, dispatchStartedAt?: number): void {
    try {
      const actuals = {
        ...(handsRun.toolUses !== undefined ? { toolUses: handsRun.toolUses } : {}),
        ...(dispatchStartedAt !== undefined ? { durationMs: Math.max(0, Date.now() - dispatchStartedAt) } : {}),
        ...(handsRun.usage && ((handsRun.usage.input_tokens ?? 0) > 0 || (handsRun.usage.output_tokens ?? 0) > 0)
          ? { usage: { input: handsRun.usage.input_tokens ?? 0, output: handsRun.usage.output_tokens ?? 0 } }
          : {}),
        budget: { maxTurns: order.budget.maxTurns, timeoutMs: order.budget.timeoutMs },
      }
      const episode = buildWorkerEpisode({
        order,
        result: handsRun.result,
        sessionId: this.config.sessionId ?? 'unknown',
        model,
        role: 'hands',
        ...(handsRun.writeGate ? { writeGate: handsRun.writeGate } : {}),
        actuals,
      })
      recordWorkerEpisodeClosure(this.config.modelTierShadowStore, episode)
      // 预算回馈索引行：objectiveHash 进 key，同目标重派时前缀查询直达。
      persistWorkerActualIndex(this.config.modelTierShadowStore, episode.objectiveHash, {
        toolUses: handsRun.toolUses ?? 0,
        durationMs: actuals.durationMs ?? 0,
        ...(actuals.usage ? { usage: actuals.usage } : {}),
        budget: actuals.budget,
        exhausted: episode.exhausted === true,
        status: episode.status,
      })
      // Wave 3 episode path: control plane consumes writeGate/falseGreen/
      // repairCount facts here (NOT via aggregation — its signature stays).
      this.config.onControlSignal?.(signalFromWorkerEpisode(episode))
    } catch {
      // Episode telemetry is best-effort.
    }
  }

  /** Wave 3: map gated results to control signals (best-effort, never throws). */
  private emitWorkerResultSignals(results: WorkerResult[]): void {
    // 义务出口先行：external_claim 义务创建后，同事实的 worker unverified
    // 信号降级为 status（obligationVoice），不出现两份决策门文案。
    const obligationVoice = this.config.onVerifiedResults !== undefined
    if (obligationVoice) {
      try {
        this.config.onVerifiedResults!(results)
      } catch {
        // Obligation accounting must never affect delegation.
      }
    }
    if (!this.config.onControlSignal) return
    try {
      for (const signal of signalsFromVerifiedResults(results, { obligationVoice })) {
        this.config.onControlSignal(signal)
      }
    } catch {
      // Control-plane telemetry must never affect delegation.
    }
  }

  /** Attach runtime model/provider/usage metadata to a worker result so that
   *  downstream insights panels can render per-delegation costs and routing. */
  private enrichResult(
    result: WorkerResult,
    model: string,
    provider: string | undefined,
    usage?: Usage | Partial<Usage>,
  ): WorkerResult {
    return {
      ...result,
      model: result.model ?? model,
      provider: result.provider ?? provider,
      // 实测遥测优先于 worker 自报 usage——result.usage 是模型生成的 JSON 文本，
      // 不可信（冒烟实测：副本虚报 514K cacheRead，其会话真实累计仅 ~103K，
      // 聚合命中率被虚报数污染）。字段级合并：有遥测的字段用遥测，无遥测的
      // 保留 worker 自报值——避免遥测缺字段（如 API 未返回 cache 字段）时静默归零。
      usage: usage ? {
        input_tokens: usage.input_tokens ?? result.usage?.input_tokens,
        output_tokens: usage.output_tokens ?? result.usage?.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? result.usage?.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? result.usage?.cache_creation_input_tokens,
        reasoning_tokens: usage.reasoning_tokens ?? result.usage?.reasoning_tokens,
        total_tokens: (usage.input_tokens ?? result.usage?.input_tokens ?? 0)
          + (usage.output_tokens ?? result.usage?.output_tokens ?? 0),
      } : result.usage,
    }
  }

  private buildTierRecommendation(order: WorkOrder): ModelTierRecommendation {
    return recommendModelTier({
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      riskTier: order.riskTier,
      objective: order.objective,
      consecutiveFailures: this.state.getSummary().failed,
      ...(this.config.patcherTier ? { workerTierOverride: this.config.patcherTier } : {}),
      ...(this.config.escalationCap ? { failureEscalationCap: this.config.escalationCap } : {}),
    })
  }

  private buildTierShadow(order: WorkOrder, selected: ModelCapabilityCard, recommendation: ModelTierRecommendation): ModelTierShadowEvent {
    return buildModelTierShadowEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      recommendedTier: recommendation.tier,
      actualModel: selected.model,
      actualTier: inferModelTierFromCard(selected),
      reason: recommendation.reason,
    })
  }

  /** Record a Flash→Pro escalation event: increment quota, persist shadow, return event for caller's array. */
  private recordEscalation(order: WorkOrder, strongCard: ModelCapabilityCard, errorMsg: string): ModelTierShadowEvent {
    this.proUpgradeCount++
    const escalatedTier = inferModelTierFromCard(strongCard)
    const shadow = buildModelTierShadowEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      recommendedTier: escalatedTier,
      actualModel: strongCard.model,
      actualTier: escalatedTier,
      reason: `Flash→Pro 升级重试 #${this.proUpgradeCount}: 上次尝试失败 "${errorMsg.slice(0, 200)}"`,
    })
    persistModelTierShadow(this.config.modelTierShadowStore, shadow)
    return shadow
  }

  private evaluateTierInfluence(recommendation: ModelTierRecommendation): { candidate: ModelTierBanditRecommendation; gate: ModelTierGateDecision } {
    const state = buildHistoricalModelTierState(this.config.modelTierShadowStore)
    const candidate = recommendModelTierArm(state)
    const gate = evaluateModelTierGate({
      state,
      candidateArm: candidate.arm,
      ruleRecommendation: recommendation,
      recentFalseGreenRate: state.recentFalseGreenRate,
      scopeHealthSeverity: state.worstScopeHealthSeverity,
      featureFlagEnabled: this.config.modelTierBanditEnabled === true,
    })
    return { candidate, gate }
  }

  /** Drain mailbox into run packet and clear. Called after every wave (batch or single).
   *  P1-7: mailbox is per-wave — each delegate()/delegateBatch() creates its own
   *  instance and passes it down, so concurrent waves never share message space. */
  private async drainMailboxIntoRun(run: CoordinatorRun, mailbox: WorkerMailbox): Promise<CoordinatorRun> {
    const findings = mailbox.byType('finding')
    const escalations = mailbox.byType('escalation')
    const notes: string[] = []
    for (const f of findings) notes.push(`📬 ${f.from}: ${f.payload.summary}`)
    for (const e of escalations) notes.push(`🚨 ${e.from}: ${e.payload.summary}`)
    mailbox.clear()
    if (notes.length === 0) return run
    return { ...run, packet: `${run.packet}\n\nMailbox:\n${notes.join('\n')}` }
  }

  async delegate(
    request: DelegationRequest,
    abortSignal?: AbortSignal,
    onOrderCreated?: (orderId: string) => void,
  ): Promise<CoordinatorRun> {
    // P1-7: per-call abort signal is passed down as a parameter — never mutated
    // on the shared config. The old save/restore raced across concurrent
    // delegate()/delegateBatch() calls (background worker + main batch) and
    // could route abort to the wrong run or leave the wrong signal installed.
    const parentSignal = abortSignal ?? this.config.abortSignal
    // P1-7: per-wave mailbox — each wave gets a fresh instance so concurrent
    // waves never interleave messages in a shared mailbox.
    const waveMailbox = new InMemoryMailbox()
    try {
      // B3: hard depth cap — nesting allowed (planner workers think-then-
      // delegate) but bounded. Reject, don't throw: the requesting worker
      // gets a structured blocked result it can act on.
      const depth = request.delegationDepth ?? 0
      const depthCap = this.config.maxDelegationDepth ?? MAX_DELEGATION_DEPTH
      if (depth >= depthCap) {
        // Build the packet from the SAME blocked result the caller sees in
        // `results` — an empty packet ([]) tells the primary model nothing and
        // invites a blind retry of the identical delegation.
        const depthCapped: WorkerResult[] = [{
          workOrderId: `depth-capped-${request.parentTurnId}`,
          status: 'blocked',
          summary: `Delegation rejected: max delegation depth (${depthCap}) reached — do the work inline instead of delegating further`,
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: ['unbounded delegation recursion prevented'],
          nextActions: ['Perform the objective directly in this worker session'],
          evidenceStatus: 'blocked',
        }]
        return {
          status: 'completed',
          results: depthCapped,
          packet: await buildPrimaryWorkerPacket(depthCapped, this.config.artifactStore),
        }
      }

      if (!shouldDelegateObjective(request.objective, request.scope)) {
        return {
          status: 'skipped',
          results: [],
          packet: await buildPrimaryWorkerPacket([], this.config.artifactStore),
        }
      }

      // Circuit breaker: fast-fail tier-locked profiles (Flash army) that are tripped.
      // Non-locked profiles use Flash→Pro escalation as their resilience mechanism.
      const profileDef = profileRegistry.get(request.profile)
      if (profileDef?.tierLock) {
        const circuitCheck = this.circuitBreaker.canDelegate(request.profile)
        if (!circuitCheck.allowed) {
          const circuitBlocked: WorkerResult[] = [{
            workOrderId: `circuit-open-${request.parentTurnId}`,
            status: 'blocked',
            summary: `Circuit breaker open: ${circuitCheck.reason}`,
            findings: [],
            artifacts: [{ kind: 'risk', title: 'Circuit breaker tripped', content: circuitCheck.reason ?? 'Profile circuit is open' }],
            changedFiles: [],
            risks: [`circuit breaker: ${request.profile} is open`],
            nextActions: ['Wait for cooldown or use a different profile'],
            evidenceStatus: 'blocked',
          }]
          return {
            status: 'completed',
            results: circuitBlocked,
            packet: await buildPrimaryWorkerPacket(circuitBlocked, this.config.artifactStore),
          }
        }
      }

      // T5: fingerprint-based resume — only read-only profiles can resume; write results are never safe to replay
      const _isWrite = classifyProfile(request.profile) === 'hands'
      const resumeHit = !_isWrite && this.config.resumeEnabled === true
        ? tryResumeWorkerResult(request.objective, request.scope.files, request.profile, Date.now())
        : null
      if (resumeHit) {
        // resume 命中是主控最可能已经丢掉目标的场景（结果来自更早的轮次甚至上一
        // 个会话），所以这里也要盖章。但**不覆盖**已有的 objective：那是当初真正
        // 产出这份结果的目标，用「这次请求的目标」盖掉它，会把两者的不一致藏起来。
        const resumed: WorkerResult = { ...resumeHit, objective: resumeHit.objective ?? request.objective }
        return {
          status: 'completed',
          selectedModel: '[resumed]',
          modelTierShadows: [],
          modelTierGatedDecisions: [],
          gatedInfluenceAudits: [],
          results: [resumed],
          packet: await buildPrimaryWorkerPacket([resumed], this.config.artifactStore),
        }
      }

      const isWrite = classifyProfile(request.profile) === 'hands'
      const stableId = deriveWorkOrderId(request.parentTurnId, request.delegationDepth)
      const order = isWrite
        ? createWriteWorkOrder({
            id: stableId,
            parentTurnId: request.parentTurnId,
            kind: request.kind,
            profile: request.profile,
            objective: request.objective,
            scope: request.scope,
            constraints: withPlanConstraints(request.constraints, request.objective, this.config),
            reviewDepth: request.reviewDepth,
            delegationDepth: (request.delegationDepth ?? 0) + 1,
            dependencies: request.dependencies,
            authority: request.authority,
            riskTier: request.riskTier,
            sessionTurn: request.sessionTurn,
            budget: isWrite ? this.budgetWithHistory(request) : request.budget,
            modelOverride: request.modelOverride,
            tierFloor: request.tierFloor,
          })
        : createReadOnlyWorkOrder({
            id: stableId,
            parentTurnId: request.parentTurnId,
            kind: request.kind,
            profile: request.profile,
            objective: request.objective,
            scope: request.scope,
            constraints: withPlanConstraints(request.constraints, request.objective, this.config),
            reviewDepth: request.reviewDepth,
            delegationDepth: (request.delegationDepth ?? 0) + 1,
            dependencies: request.dependencies,
            authority: request.authority,
            riskTier: request.riskTier,
            sessionTurn: request.sessionTurn,
            modelOverride: request.modelOverride,
            tierFloor: request.tierFloor,
            budget: request.budget,
          })

      // T9 P3: callbacks don't survive zod parsing — stash by order id.
      if (request.onActivity) this.activityUpstream.set(order.id, request.onActivity)
      // 建单完成即通知工具侧（异常补发终态用）：worker 开始跑之前回调，
      // 此后 delegate() 若抛错，工具侧可凭 orderId 为已派发 worker 补终态。
      onOrderCreated?.(order.id)
      if (request.onNestedActivity) this.nestedUpstream.set(order.id, request.onNestedActivity)
      // Session resume: load prior messages from disk so the worker continues
      // from its previous context. Degrades to a fresh worker if no history.
      if (request.resumeWorkOrderId) {
        const record = loadWorkerSession(request.resumeWorkOrderId)
        if (record) {
          this.resumeMessages.set(order.id, record.messages)
          debugLog(`[worker-resume] loaded ${record.messages.length} messages from ${request.resumeWorkOrderId} for ${order.id}`)
        } else {
          debugLog(`[worker-resume] no prior session for ${request.resumeWorkOrderId} — starting fresh`)
        }
        // W3: abort checkpoint rides along (consumed once). Memory stash wins
        // (same-process abort), else the persisted disk checkpoint (enables
        // cross-process resume via a NEW coordinator instance).
        const memCheckpoint = this.abortCheckpoints.get(request.resumeWorkOrderId)
        const checkpoint = memCheckpoint ?? record?.checkpoint
        if (checkpoint) {
          this.resumeCheckpoints.set(order.id, checkpoint)
          if (memCheckpoint) this.abortCheckpoints.delete(request.resumeWorkOrderId)
          // Staged → the disk copy is spent. Consume it so a stale checkpoint
          // cannot replay into a later resume of the same id.
          if (record?.checkpoint) consumeCheckpointOnce(request.resumeWorkOrderId)
        }
      }
      // P1-6/7/8: single delegate() goes through the same global gate as batch
      // workers — concurrency semaphore + cross-wave file-conflict registration.
      const run = await this.runDelegationWithGlobalGate(order, parentSignal, waveMailbox)
      return this.drainMailboxIntoRun(run, waveMailbox)
    } finally {
      // P1-7: config.abortSignal was never mutated — nothing to restore.
    }
  }

  /**
   * Summary quality gate: when the worker returns a brief summary, trigger a
   * follow-up expansion turn so the parent agent receives a technically complete
   * handoff. The expansion reuses the worker's session messages as priorMessages
   * so it continues from the same context. Returns the (possibly expanded) result
   * and updated sessionMessages.
   */
  private async maybeExpandSummary(
    order: WorkOrder,
    workerConfig: WorkerSessionConfig,
    mergedSignal: AbortSignal,
    currentResult: WorkerResult,
    sessionMessages: readonly OaiMessage[],
    priorUsage?: Partial<Usage>,
    priorFrozenSnapshot?: FrozenSnapshotData,
  ): Promise<{ result: WorkerResult; sessionMessages: readonly OaiMessage[]; frozenSnapshot?: FrozenSnapshotData }> {
    let result = currentResult
    let messages = sessionMessages
    // 扩写轮同样落同一会话文件——回种累计用量，逐轮滚动。
    let expansionUsage: Partial<Usage> | undefined = priorUsage
    // 冻结快照与 messages 同生命周期：只在扩写被采纳时换扩写轮快照。
    let expansionSnapshot: FrozenSnapshotData | undefined = priorFrozenSnapshot

    for (let attempt = 0; attempt < SUMMARY_CONTINUATION_ATTEMPTS; attempt++) {
      if (result.summary.length >= SUMMARY_MIN_LENGTH) break
      // Only expand passed results — blocked/failed results are inherently terse
      if (result.status !== 'passed') break

      const expansionOrder: WorkOrder = {
        ...order,
        objective: `Your previous summary was too brief (${result.summary.length} chars). Expand it to at least ${SUMMARY_MIN_LENGTH} characters. Include: what you found, what you changed, what remains open. Previous summary: "${result.summary}"`,
      }
      const expansionConfig: WorkerSessionConfig = {
        ...workerConfig,
        order: expansionOrder,
        priorMessages: messages,
        ...(expansionUsage ? { priorUsage: expansionUsage } : {}),
        ...(expansionSnapshot ? { priorFrozenSnapshot: expansionSnapshot } : {}),
      }
      try {
        const expansionRun = await this.runWorker(expansionConfig)
        expansionUsage = mergeUsage(expansionUsage, expansionRun.usage) ?? expansionUsage
        const expandedResult = expansionRun.result
        // Only accept the expansion when it is itself passed AND actually longer.
        // A failed/blocked expansion (e.g. 收尾轮 JSON 解析崩后 salvage 出的长
        // summary) must never flip a passed result — 2026-08-02 c12c8 工单：
        // 首轮 passed 被扩展轮的 failed/json_parse 长报告翻盘成 failed。
        if (expandedResult.status === 'passed' && expandedResult.summary.length > result.summary.length) {
          result = expandedResult
          messages = expansionRun.session.getMessages()
          expansionSnapshot = expansionRun.frozenSnapshot ?? expansionSnapshot
        }
      } catch {
        // Expansion failure is not critical — keep the original result
        break
      }
    }

    return { result, sessionMessages: messages, frozenSnapshot: expansionSnapshot }
  }

  /**
   * 预算耗尽后的自动续跑。worker 被 max-turns / 墙钟超时切断时会**正常返回**一个
   * blocked 结果，走不到下面那套 `catch` 里的重试阶梯——续跑链路（priorMessages +
   * checkpoint）早就通了，缺的只是扳机。这里把它接上：带着上一轮完整对话再跑，
   * 字节是热前缀缓存，续一轮几乎不花钱。
   *
   * 只覆盖只读工，写工的边界见 `decideContinuation` 的注释。
   */
  private async maybeContinueExhausted(
    order: WorkOrder,
    workerConfig: WorkerSessionConfig,
    mergedSignal: AbortSignal,
    isWrite: boolean,
    current: DelegateRunState,
  ): Promise<DelegateRunState> {
    let run = current
    let attempt = 0

    while (true) {
      const decision = decideContinuation({
        result: run.result,
        attempt,
        aborted: mergedSignal.aborted,
        isWrite,
        sharedWorktree: this.config.sharedWorktree === true,
        hasSessionMessages: (run.sessionMessages?.length ?? 0) > 0,
        // 上一轮产出度量：toolCalls 少 + 预算耗尽 = 停滞空转，续跑判据据此拦截。
        // 首轮（current）的 transcript 在 runWorker 返回时已填充（coordinator.ts:2496）。
        // transcript 缺席时整个 productivity 不传：`?? 0` 会把「度量未知」兜成「0 次
        // 调用」，正好命中停滞判据而拒绝续跑——缺度量该放行，判据自己也是这么声明的。
        ...(run.transcript
          ? {
              productivity: {
                toolCalls: run.transcript.toolUses.length,
                ...(run.transcript.waitingFirstByteMs !== undefined
                  ? { waitingFirstByteMs: run.transcript.waitingFirstByteMs, ttftSamples: run.transcript.ttftSamples }
                  : {}),
              },
            }
          : {}),
      })
      if (!decision.proceed) {
        if (attempt > 0) debugLog(`[worker-continuation] ${order.id} 停在第 ${attempt} 次续跑：${decision.skipReason}`)
        break
      }
      attempt++

      const continuationOrder: WorkOrder = {
        ...order,
        objective: buildContinuationObjective(order.objective, decision.reason, attempt),
      }
      const checkpoint = this.abortCheckpoints.get(order.id)
      const continuationConfig: WorkerSessionConfig = {
        ...workerConfig,
        order: continuationOrder,
        priorMessages: run.sessionMessages,
        // 回种此前各轮累计用量——续跑轮的 meta 从「只剩本轮」变为「派发终身」
        priorUsage: run.usage,
        // 冻结快照随续跑回传——新进程/新引擎继承历史字节，前缀只在新边界断尾
        priorFrozenSnapshot: run.frozenSnapshot,
        ...(checkpoint ? { checkpoint } : {}),
      }

      // 续跑重新占用 liveness 槽位——首轮的 finally 已经把它清掉了，不重注册的话
      // stall sweep 看不到这一轮，静默卡死没人收。跑完必须再清，否则槽位泄漏。
      this.liveness.register(order.id, this.config.workerStallMs ?? deriveWorkerStallMs({ providerName: workerConfig.providerName, baseUrl: workerConfig.baseUrl, slowThinking: workerConfig.slowThinking, isWrite }))
      this.ensureStallSweep()
      debugLog(`[worker-continuation] ${order.id} 第 ${attempt} 次续跑（${decision.reason}）`)
      // 补偿轮对用户是不可见的额外时间：不发事件的话，面板上只看到一个 worker
      // 卡在那儿"还在跑"，看不出它已经进入第二次续跑。
      emitLifecycle(workerConfig, `续跑 ${attempt}/${MAX_BUDGET_CONTINUATIONS} · ${CONTINUATION_REASON_LABEL[decision.reason]}`)

      let continued: WorkerSessionRun
      try {
        continued = await this.runWorker(continuationConfig)
      } catch (error) {
        // 续跑失败不覆盖首轮成果——保留原结果，让主控看到原始 failureReason。
        debugLog(`[worker-continuation] ${order.id} 第 ${attempt} 次续跑抛错：${error instanceof Error ? error.message : String(error)}`)
        break
      } finally {
        this.liveness.unregister(order.id)
        if (this.liveness.size() === 0) this.stopStallSweep()
      }

      this.captureAbortCheckpoint(order.id, continued.checkpoint, continued.result)
      const messages = typeof continued.session?.getMessages === 'function'
        ? continued.session.getMessages()
        : run.sessionMessages
      run = {
        ...run,
        result: markContinued(continued.result, attempt, decision.reason),
        transcript: continued.transcript ?? run.transcript,
        sessionMessages: messages,
        frozenSnapshot: continued.frozenSnapshot ?? run.frozenSnapshot,
        usage: mergeUsage(run.usage, continued.usage),
      }
    }

    return run
  }

  /**
   * 证据不达标 → 有界复核（Wave 8）。只读工没有写工那样的闸门修复，宣称与证据对
   * 不上时此前只是被静默降级。这里给它一轮打回：要么真的复现，要么诚实撤回宣称。
   *
   * 三条边界：只覆盖只读工（写工走写闸门的有界修复）；上限一轮；**不阻断交付**
   * ——复核后仍不达标就照常降级交回，门禁始终在主控收口。
   */
  private async maybeReviseEvidence(
    order: WorkOrder,
    workerConfig: WorkerSessionConfig,
    mergedSignal: AbortSignal,
    isWrite: boolean,
    current: DelegateRunState,
  ): Promise<DelegateRunState> {
    const shortfall = detectEvidenceShortfall(current.result, order.profile, current.transcript)
    const decision = decideRevision({
      result: current.result,
      shortfall,
      attempt: 0,
      aborted: mergedSignal.aborted,
      isWrite,
      hasSessionMessages: (current.sessionMessages?.length ?? 0) > 0,
    })
    if (!decision.proceed) return current

    const revisionOrder: WorkOrder = {
      ...order,
      objective: buildRevisionObjective(order.objective, decision.shortfall, current.result.summary),
    }
    this.liveness.register(order.id, this.config.workerStallMs ?? deriveWorkerStallMs({ providerName: workerConfig.providerName, baseUrl: workerConfig.baseUrl, slowThinking: workerConfig.slowThinking, isWrite }))
    this.ensureStallSweep()
    debugLog(`[worker-revision] ${order.id} 证据不达标（${decision.shortfall}），打回复核一轮`)
    emitLifecycle(workerConfig, `证据复核 · ${SHORTFALL_LABEL[decision.shortfall]}`)

    let revised: WorkerSessionRun
    try {
      revised = await this.runWorker({
        ...workerConfig,
        order: revisionOrder,
        priorMessages: current.sessionMessages,
        priorUsage: current.usage,
        priorFrozenSnapshot: current.frozenSnapshot,
      })
    } catch (error) {
      debugLog(`[worker-revision] ${order.id} 复核抛错：${error instanceof Error ? error.message : String(error)}`)
      return current
    } finally {
      this.liveness.unregister(order.id)
      if (this.liveness.size() === 0) this.stopStallSweep()
    }

    // 复核不该以丢失既有发现为代价——收窄了就不要这一轮，照常降级交回原结果。
    if (revised.result.findings.length < current.result.findings.length) {
      debugLog(`[worker-revision] ${order.id} 复核产出的 findings 变少，弃用复核结果`)
      return current
    }

    const messages = typeof revised.session?.getMessages === 'function'
      ? revised.session.getMessages()
      : current.sessionMessages
    return {
      ...current,
      result: markRevised(revised.result, decision.shortfall),
      transcript: revised.transcript ?? current.transcript,
      sessionMessages: messages,
      frozenSnapshot: revised.frozenSnapshot ?? current.frozenSnapshot,
      usage: mergeUsage(current.usage, revised.usage),
    }
  }

  /** P1-6: wait until the role pool (and the global cap) has a free slot, then
   *  claim it. 池化并发（S1）：只读工（explore）与写工（hands）各自按
   *  maxExploreWorkers / maxWriteWorkers 计数；全局上限为三者的最大值——
   *  未配置分池时 explore=write=maxWorkers，总上限即 maxWorkers，行为与
   *  旧版完全一致。abort 感知（审查 H1/H3 修复）：等槽期间监听
   *  parentSignal——触发即从 waiter 队列移除并 reject，不再出现「主控已超时、
   *  槽位释放后僵尸唤醒继续跑完整 worker」。 */
  private rolePoolCap(role: 'explore' | 'write'): number {
    return role === 'write'
      ? (this.config.maxWriteWorkers ?? this.config.maxWorkers)
      : (this.config.maxExploreWorkers ?? this.config.maxWorkers)
  }

  private totalWorkerCap(): number {
    const explore = this.config.maxExploreWorkers ?? this.config.maxWorkers
    const write = this.config.maxWriteWorkers ?? this.config.maxWorkers
    return Math.max(this.config.maxWorkers, explore, write)
  }

  /** S4：DP 副本 A/B 候选模型池。显式注入优先；缺省从 providers 配置推导，
   *  并按凭据就绪过滤——`config.provider.providers` 是 preset 全量快照而非
   *  「用户配了哪几家」，不过滤会把副本派到没有 key 的提供商上（必然失败且
   *  归因困难）。推导结果 memo 一次：DP 每副本各调一次，而 OAuth 判定要读
   *  token 文件；候选池随 coordinator 实例的生命周期固定，换模型会重建。 */
  getCandidateModels(): Array<{ provider: string; model: string }> {
    if (this.config.getCandidateModels) return this.config.getCandidateModels()
    return (this.candidateModelsCache ??= deriveCandidateModels(this.config.providers))
  }

  /** 该角色当前是否有可用槽位（池帽 + 总帽双闸）。必须每次实时读计数——
   *  此前 acquireWorkerSlot 把 poolCount 取成 const 快照后在 while 条件里
   *  复用：同角色占满池帽时该条件恒真，被唤醒者永远退不出循环，只能等
   *  abort/shutdown。 */
  private hasFreeWorkerSlot(role: 'explore' | 'write'): boolean {
    const poolCount = role === 'write' ? this.activeWriteCount : this.activeExploreCount
    return this.activeWorkerCount < this.totalWorkerCap() && poolCount < this.rolePoolCap(role)
  }

  private async acquireWorkerSlot(order: WorkOrder, parentSignal?: AbortSignal): Promise<void> {
    if (this.shuttingDown) throw new Error('Coordinator is shutting down')
    const role = classifyProfile(order.profile) === 'hands' ? 'write' : 'explore'
    while (!this.hasFreeWorkerSlot(role)) {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const waiter: WorkerSlotWaiter = {
          role,
          wake: () => { if (!settled) { settled = true; cleanup(); resolve() } },
        }
        const cleanup = () => {
          const i = this.workerWaiters.indexOf(waiter)
          if (i >= 0) this.workerWaiters.splice(i, 1)
          parentSignal?.removeEventListener('abort', onAbort)
        }
        const onAbort = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(parentSignal!.reason instanceof Error ? parentSignal!.reason : new Error('delegation aborted while waiting for a worker slot'))
        }
        if (parentSignal?.aborted) { onAbort(); return }
        this.workerWaiters.push(waiter)
        parentSignal?.addEventListener('abort', onAbort, { once: true })
      })
      if (this.shuttingDown) throw new Error('Coordinator is shutting down')
    }
    this.activeWorkerCount++
    if (role === 'write') this.activeWriteCount++
    else this.activeExploreCount++
  }

  /** P1-6: release a slot and wake the first waiter that can actually take it. */
  private releaseWorkerSlot(order: WorkOrder): void {
    const role = classifyProfile(order.profile) === 'hands' ? 'write' : 'explore'
    this.activeWorkerCount--
    if (role === 'write') this.activeWriteCount--
    else this.activeExploreCount--
    this.wakeEligibleWaiter()
  }

  /** FIFO 扫描唤醒：分池下队首 waiter 未必是能进的那个——写槽释放却唤醒等
   *  explore 池的 waiter 时，被唤者原地重排且不链式唤醒，腾出的槽位会空转到
   *  下一次 settle。只唤一个：被唤者自己 settle 时会再唤下一个。 */
  private wakeEligibleWaiter(): void {
    for (const waiter of this.workerWaiters) {
      if (!this.hasFreeWorkerSlot(waiter.role)) continue
      waiter.wake()
      return
    }
  }

  /** P1-8: cross-wave file conflict — conflicting files, or null. Same semantics
   *  as WorkOrderQueue.hasFileConflict: two read-only workers may inspect the
   *  same snapshot in parallel; serialization applies whenever either side can
   *  write. The queue only guards within one batch — this table catches single
   *  delegate() (which bypasses the queue) overlapping any in-flight worker. */
  private checkGlobalFileConflict(order: WorkOrder): string[] | null {
    const orderFiles = order.scope.files ?? []
    if (orderFiles.length === 0) return null
    const orderWrites = classifyProfile(order.profile) === 'hands'
    const orderFileSet = new Set(orderFiles)
    for (const [inflightId, entry] of this.inflightFiles) {
      if (inflightId === order.id) continue
      if (entry.files.length === 0) continue
      if (!orderWrites && !entry.writes) continue
      const hits = entry.files.filter(f => orderFileSet.has(f))
      if (hits.length > 0) return hits
    }
    return null
  }

  /** P1-6/7/8: the single entry point for every order dispatch (single delegate,
   *  batch, background). Enforces the global concurrency semaphore, registers
   *  in-flight file claims for cross-wave conflict detection, and passes the
   *  wave's abort signal / mailbox down explicitly instead of inheriting them
   *  from shared instance state. */
  private runDelegationWithGlobalGate(
    order: WorkOrder,
    parentSignal: AbortSignal | undefined,
    mailbox: WorkerMailbox,
  ): Promise<CoordinatorRun> {
    // M2 时间账：从进全局门到 settle 的总墙钟（含等槽排队）——galaxy 报告
    // 据此暴露「哪一维最慢、哪里在排队」，维度划分质量从此有数据支撑。
    const startedAt = Date.now()
    const promise = this.runDelegationWithGlobalGateImpl(order, parentSignal, mailbox)
      .then(run => {
        const wall = Math.max(0, Date.now() - startedAt)
        for (const result of run.results) result.durationMs = wall
        return run
      })
    this.activeDelegations.add(promise)
    // Do not use a bare finally() here: its derived promise would rethrow a
    // worker rejection as an unhandled rejection. The original promise is
    // still returned to the caller, while this observer only removes tracking.
    void promise.then(
      () => { this.activeDelegations.delete(promise) },
      () => { this.activeDelegations.delete(promise) },
    )
    return promise
  }

  private async runDelegationWithGlobalGateImpl(
    order: WorkOrder,
    parentSignal: AbortSignal | undefined,
    mailbox: WorkerMailbox,
  ): Promise<CoordinatorRun> {
    // P1-8: write workers must declare a file scope — without one, conflict
    // detection and change-reconciliation have no boundary to check against.
    // 豁免（审查 M1）：verifier 的合法形态就是「不声明 files 跑全量测试」，
    // 其写副作用仅限测试文件，不在此闸口径内。
    if (classifyProfile(order.profile) === 'hands' && order.profile !== 'verifier' && !(order.scope.files?.length)) {
      const blocked: WorkerResult[] = [{
        workOrderId: order.id,
        status: 'blocked',
        summary: 'Write worker requires an explicit scope.files — refusing to dispatch a writer with no file boundary',
        findings: [],
        artifacts: [{ kind: 'risk', title: 'Missing write scope', content: 'scope.files is empty for a hands-profile worker' }],
        changedFiles: [],
        risks: ['write worker dispatched without scope.files'],
        nextActions: ['Re-dispatch with explicit scope.files before delegating write work'],
        evidenceStatus: 'blocked',
      }]
      return {
        status: 'completed',
        order,
        results: blocked,
        packet: await buildPrimaryWorkerPacket(blocked, this.config.artifactStore),
      }
    }
    // H1 修复（审查）：嵌套委派不计入全局信号量——planner（brain）持槽等子工、
    // 子工再等槽是结构性自死锁（RIVET_MAX_WORKERS=1 时任何 planner 派发必死，
    // 默认 3 槽时 3 个并发 planner 即死）。顶层仍受闸，嵌套恢复改动前的
    // per-batch 语义（深度另有 maxDelegationDepth 兜底）。
    // 深度口径：两条构造路径（delegate/delegateBatch）统一在 request 深度上
    // +1 落 order——顶层 order.delegationDepth===1，嵌套 ≥2。
    const nested = (order.delegationDepth ?? 0) >= 2
    // P1-6: wait for a global concurrency slot (covers batch + single + background).
    if (!nested) await this.acquireWorkerSlot(order, parentSignal)
    try {
      // P1-8: cross-wave conflict — 检查与登记必须在同一同步块内（审查 H2：
      // 此前检查在 await 槽位之前，同 tick 两个同文件写工双双绕过 TOCTOU）。
      // 等槽后被唤醒的订单用最新登记表重查，语义自洽。
      const conflict = this.checkGlobalFileConflict(order)
      if (conflict) {
        const blocked: WorkerResult[] = [{
          workOrderId: order.id,
          status: 'blocked',
          summary: `Cross-wave file conflict: ${conflict.join(', ')} already in-flight by another worker — refusing overlapping dispatch`,
          findings: [],
          artifacts: [{ kind: 'risk', title: 'Cross-wave file conflict', content: `Files in-flight: ${conflict.join(', ')}` }],
          changedFiles: [],
          risks: [`cross-wave file conflict: ${conflict.join(', ')}`],
          nextActions: ['Wait for the in-flight worker to settle, or narrow scope.files to non-overlapping files'],
          evidenceStatus: 'blocked',
        }]
        return {
          status: 'completed',
          order,
          results: blocked,
          packet: await buildPrimaryWorkerPacket(blocked, this.config.artifactStore),
        }
      }
      this.inflightFiles.set(order.id, {
        files: order.scope.files ?? [],
        writes: classifyProfile(order.profile) === 'hands',
      })
      return await this.delegateOrder(order, parentSignal, mailbox)
    } finally {
      this.inflightFiles.delete(order.id)
      if (!nested) this.releaseWorkerSlot(order)
    }
  }

  /** P1-7: parentSignal / mailbox are explicit parameters (not read from
   *  this.config / this.mailbox) so concurrent waves never inherit another
   *  wave's abort signal or mailbox. */
  /** 预算发准（2026-08-18）：写工派发前查同 objective 的历史实际用量
   *  （worker_actual 索引行）——耗尽 / near-miss 样本给预算上地板（3× 帽 +
   *  绝对帽），让反复续跑的任务一次发准。模型显式 budget 逐字段全胜；
   *  store 缺席 / 闸门关闭 / 坏数据一律静默降级为原 budget。 */
  private budgetWithHistory(request: DelegationRequest): DelegationRequest['budget'] {
    if (!historyBudgetEnabled()) return request.budget
    const store = this.config.modelTierShadowStore
    const load = store?.loadBanditStatesByPrefix?.bind(store)
    if (!load) return request.budget
    try {
      const hash = hashObjective(request.objective)
      const samples = parseWorkerActualRows(load(`worker_actual:${hash}:`, 5), hash)
      if (samples.length === 0) return request.budget
      const shaped = shapeWriteBudgetForProfile(request.scope.files, request.profile)
      const current = {
        maxTurns: request.budget?.maxTurns ?? shaped?.maxTurns ?? WRITE_DEFAULT_MAX_TURNS,
        timeoutMs: request.budget?.timeoutMs ?? shaped?.timeoutMs
          ?? profileRegistry.get(request.profile ?? '')?.defaultTimeoutMs ?? 600_000,
      }
      const floor = historyBudgetFloor(samples, current)
      if (!floor) return request.budget
      return mergeBudgetOverride(request.budget, floor)
    } catch {
      return request.budget
    }
  }

  private async delegateOrder(
    order: WorkOrder,
    parentSignal: AbortSignal | undefined,
    mailbox: WorkerMailbox,
  ): Promise<CoordinatorRun> {
    // 预算回馈（2026-08-18）：派发墙钟从入口起算——episode 落盘早于
    // WorkerResult.durationMs 盖章（runDelegationWithGlobalGate 的 .then），
    // 实际用量须在 episode 构建时自算。
    const dispatchStartedAt = Date.now()
    const identity: DelegationIdentity = {
      // dispatchId 用 parentTurnId 作兼容派发域。attemptId 是本次派发的执行
      // 身份：per-dispatch 而非 per-attempt——delegateOrder 内的同模型重试 /
      // Flash→Pro 升级重试复用同一 identity，只有重新派发才换新；且不复用
      // 持久化 nonce。
      dispatchId: order.parentTurnId,
      attemptId: randomUUID(),
    }
    const identify = (result: WorkerResult): IdentifiedWorkerResult =>
      stampWorkerResultIdentity(result, identity)

    // Abort guard: if the caller's abort signal fires (e.g. tool-level timeout),
    // reject immediately instead of waiting for the worker's internal 180s timeout.
    // This prevents zombie workers from blocking the main agent loop.
    if (parentSignal?.aborted) {
      const abortedResults = [identify(workerFailureResult(order, new Error('Delegation aborted: caller signal fired'), { failureReason: 'caller_aborted' }))]
      return {
        status: 'completed',
        order,
        results: abortedResults,
        packet: await buildPrimaryWorkerPacket(abortedResults, this.config.artifactStore),
      }
    }

    const role = classifyProfile(order.profile)
    const isWrite = role === 'hands'
    this.state.recordEvent({ type: 'queued', workOrderId: order.id, timestamp: Date.now() })

    const task = mapWorkOrderKindToCapabilityTask(order.kind)

    // Scope budget check for exploration workers (code_search, doc_research, plan)
    if (order.kind === 'code_search' || order.kind === 'doc_research' || order.kind === 'plan') {
      if (order.scope.maxFiles !== undefined && (order.scope.files?.length ?? 0) > order.scope.maxFiles) {
        const scopeBlocked = [identify({
          workOrderId: order.id,
          status: 'blocked',
          summary: `Scope budget exceeded: ${order.scope.files!.length} files exceeds maxFiles=${order.scope.maxFiles}`,
          findings: [],
          artifacts: [{ kind: 'risk', title: 'Scope budget exceeded', content: `Requested ${order.scope.files!.length} files but maxFiles=${order.scope.maxFiles}` }],
          changedFiles: [],
          risks: [`scope budget: ${order.scope.files!.length} > ${order.scope.maxFiles} maxFiles`],
          nextActions: ['Reduce file scope or increase maxFiles budget'],
          evidenceStatus: 'blocked',
        })]
        return {
          status: 'completed',
          order,
          results: scopeBlocked,
          packet: await buildPrimaryWorkerPacket(scopeBlocked, this.config.artifactStore),
        }
      }
    }

    const tierRecommendation = this.buildTierRecommendation(order)
    const tierInfluence = this.evaluateTierInfluence(tierRecommendation)
    // 瑶光门 tierFloor：调用方声明的「不得低于」硬地板，对规则推荐与 bandit gate
    // 的结果统一生效（只抬升不降级）。modelOverride 仍然最高优先。
    const preferredTier = applyTierFloor(
      tierInfluence.gate.applied ? tierInfluence.gate.effectiveTier : tierRecommendation.tier,
      order.tierFloor,
    )
    // Per-order modelOverride wins over all routing (review override, workers
    // routing, EFE, tier). The card is mostly telemetry/reporting (the real
    // client is built by runtimeFactory from order.modelOverride); synthesize
    // one when the override model isn't in the primary provider's cards.
    let selected = order.modelOverride
      ? this.cardForModelOverride(order.modelOverride.model)
      : this.selectModelForTask(task, preferredTier, order.profile)
    const selectedTier = inferModelTierFromCard(selected)
    const tierShadow = this.buildTierShadow(order, selected, tierRecommendation)
    const tierGatedDecision = buildModelTierGatedDecisionEvent({
      sessionId: this.config.sessionId ?? 'unknown',
      workOrderId: order.id,
      authority: order.authority,
      profile: order.profile,
      kind: order.kind,
      ruleTier: tierRecommendation.tier,
      candidateTier: tierInfluence.candidate.tier,
      applied: tierInfluence.gate.applied,
      gateOpen: tierInfluence.gate.gateOpen,
      reason: `${tierInfluence.gate.reason}; ${tierInfluence.candidate.reason}`,
      selectedModel: selected.model,
      selectedTier,
    })
    const gatedInfluenceAudit = buildGatedInfluenceAuditEvent({
      source: 'model_tier_bandit',
      sessionId: this.config.sessionId ?? 'unknown',
      targetId: order.id,
      gateOpen: tierInfluence.gate.gateOpen,
      applied: tierInfluence.gate.applied,
      reason: tierInfluence.gate.reason,
      evidenceWindow: {
        ...tierInfluence.gate.evidenceWindow,
        candidateConfidence: tierInfluence.candidate.confidence,
        candidateScore: tierInfluence.candidate.score,
        selectedTier,
      },
      vetoSignals: tierInfluence.gate.vetoSignals,
    })
    persistModelTierShadow(this.config.modelTierShadowStore, tierShadow)
    persistModelTierGatedDecision(this.config.modelTierShadowStore, tierGatedDecision)
    persistGatedInfluenceAudit(this.config.gatedInfluenceAuditStore ?? this.config.modelTierShadowStore, gatedInfluenceAudit)
    // Use the work order's allowedTools (from ProfileRegistry) instead of hardcoded sets.
    // A profile may allowlist a tool that isn't registered in THIS session — gated
    // tools (web_search), MCP tools, or a host-trimmed registry. filterToolRegistry
    // is fail-closed and throws on any unknown name, which would kill the whole
    // worker over one missing tool. Degrade gracefully instead: keep the tools that
    // exist, drop the absent ones (with a warning), so the worker still runs.
    const presentTools = order.allowedTools.filter(name => this.config.baseToolRegistry.has(name))
    const missingTools = order.allowedTools.filter(name => !this.config.baseToolRegistry.has(name))
    if (missingTools.length > 0) {
      debugLog(`[worker-tools] order ${order.id} (${order.profile}): dropping ${missingTools.length} unregistered tool(s) [${missingTools.join(', ')}] — not in base registry this session`)
    }
    const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, presentTools)
    const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
    // R3.1: the runtime factory returns a generic default maxTurns; clamp it to
    // the work order's per-profile budget so caps like reviewer=6 actually bite.
    // Covers both read (runWorker) and write (runHands → runWorker) paths.
    workerConfig.maxTurns = clampWorkerMaxTurns(workerConfig.maxTurns, order.budget.maxTurns)
    workerConfig.reviewDepth = order.reviewDepth
    // Downward trust delegation: only dangerously-skip-permissions flows to workers.
    workerConfig.parentApprovalMode = this.config.parentApprovalMode
    workerConfig.domainKnowledgeStore = this.config.domainKnowledgeStore
    workerConfig.mailbox = mailbox
    // Batch-scoped shared prewarm (delegateBatch 派发前预热 + 同批 worker 互暖)。
    // 单发 delegate() 路径不入表，worker 用 AgentLoop 实例默认 cache（历史行为）。
    const batchPrewarmCache = this.batchPrewarmByOrder.get(order.id)
    if (batchPrewarmCache) workerConfig.prewarm = batchPrewarmCache
    // 批级共享信息素（星河收编 #3）：读工默认共享；写工显式 opt-in 才挂——
    // 信号可能引导实现偏向，守护写工实现独立性。
    const batchStigmergy = this.batchStigmergyByOrder.get(order.id)
    if (batchStigmergy && (classifyProfile(order.profile) !== 'hands' || order.batchStigmergy)) {
      workerConfig.stigmergy = batchStigmergy
    }
    // Enable JSON-mode repair for OpenAI-protocol providers. The repair path
    // sends a tool-free request with response_format: json_object, which is an
    // OpenAI API standard. Optimistic even when the capability card says
    // supportsResponseFormat:false (LongCat accepts it in practice and its
    // malformed worker JSON badly needs the structured repair path) — now safe
    // because worker-session probes the first rejection: a provider that
    // refuses response_format gets one immediate retry WITHOUT it (the round
    // is not wasted) and the json channel stays off for the rest of the run.
    if (!workerConfig.forceJsonRepair) workerConfig.forceJsonRepair = true
    // B（终轮定型）：报告统一经带完整会话历史的无工具收尾轮产出（默认开）。
    // RIVET_WORKER_FINALIZE=0 一键回退旧契约——主提示词内联 JSON、无收尾轮。
    workerConfig.finalizeReport = process.env.RIVET_WORKER_FINALIZE !== '0'
    // Dispatch nonce: batch order ids repeat across delegation runs — without
    // this, every run appends to the same worker-batch-N.jsonl (cumulative
    // context + stale artifacts, session 2c1186f5). Same-order retries within
    // THIS dispatch reuse the nonce on purpose (same session, same artifacts).
    const dispatchNonce = randomUUID().slice(0, 5)
    this.dispatchNonces.set(order.id, dispatchNonce)
    workerConfig.sessionNonce = dispatchNonce
    // Session resume: inject prior messages so the worker continues from its
    // previous context. Side-table pattern (same as activityUpstream).
    const priorMessages = this.resumeMessages.get(order.id)
    if (priorMessages && priorMessages.length > 0) {
      workerConfig.priorMessages = priorMessages
    }
    // W3: inject the aborted run's checkpoint so the resumed worker starts from
    // its partial result instead of redoing all work (worker-session embeds it
    // into the prompt as a <checkpoint> block).
    const resumeCheckpoint = this.resumeCheckpoints.get(order.id)
    if (resumeCheckpoint) {
      workerConfig.checkpoint = resumeCheckpoint
      this.resumeCheckpoints.delete(order.id)
    }

    // A4: per-order AbortController merged with the parent signal — the stall
    // sweep can abort ONLY this worker without touching its batch siblings,
    // while a parent abort still kills everything. parentSignal is the explicit
    // parameter (P1-7) — never read from this.config here.
    const orderController = new AbortController()
    const mergedSignal = parentSignal
      ? AbortSignal.any([parentSignal, orderController.signal])
      : orderController.signal
    // Propagate merged signal so worker stops immediately on abort
    // instead of waiting for its internal budget timeout (中间层 #1).
    workerConfig.abortSignal = mergedSignal
    // A2: worker liveness signal feeds the stall clock.
    // T9 P3: …and fans out to the per-request real-time upstream, so the
    // calling tool can stream live worker progress into the UI.
    const upstreamActivity = workerConfig.onActivity
    const requestUpstream = this.activityUpstream.get(order.id)
    // 用户契约投影：每 order 构造一次（白名单纯函数），随事件引用携带；
    // mapper 只在首条事件转发（同 objective 先例），SSE 无重复负载。
    const contractProjection = requestUpstream ? buildContractProjection(order) : undefined
    const forwardActivity = (kind: WorkerActivityKind, detail?: string): void => {
      this.liveness.tick(order.id)
      upstreamActivity?.(kind, detail)
      try {
        requestUpstream?.({
          workOrderId: order.id,
          profile: order.profile,
          ...identity,
          objective: order.objective,
          contract: contractProjection,
          authority: order.authority,
          authorityReason: order.authorityReason,
          kind,
          detail,
        })
      } catch { /* UI upstream must never break dispatch */ }
    }
    workerConfig.onActivity = forwardActivity
    // 运行中转录快照：worker session 建好后注册活消息 getter（服务端
    // getWorkerLog 优先读它，终态前的转录才可见）。
    workerConfig.onSessionReady = (getMessages) => {
      this.liveMessages.set(order.id, getMessages)
    }
    // 嵌套委派上行：本 worker 再派的 sub-worker 活动盖上 parentWorkerId 戳
    // （更深层已盖过的保留——祖先只透传，父子关系以最近一层为准）后回传调用方。
    workerConfig.onNestedDelegation = (activity) => {
      const upstream = this.nestedUpstream.get(order.id)
      if (!upstream) return
      try {
        upstream({
          ...activity,
          parentWorkerId: activity.parentWorkerId ?? order.id,
          parentAttemptId: activity.parentAttemptId ?? identity.attemptId,
        })
      } catch { /* UI upstream must never break dispatch */ }
    }
    // WC: 输入直达 — worker 每个工具回合结算时 drain 本 order 的 steer 队列。
    workerConfig.onSteerDrain = () => {
      const q = this.steerQueues.get(order.id)
      if (!q || q.length === 0) return null
      const text = q.join('\n')
      q.length = 0
      return text
    }

    this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })

    let run: DelegateRunState | undefined

    // usage-ledger 对齐（2026-08-18）：同一派发（同 order.id + nonce → 同一 worker
    // 会话文件）跨轮累计的净增用量。每轮 runWorker 前经 priorUsage 回种进新
    // SessionContext（meta 单调递增、与 cache-log 对账一致），轮后并入本账。
    // 各轮返回的是差值，mergeUsage 累加即派发真值；DelegateRunState.usage 与
    // enrichResult 用的都是这份累计，而非「最后一轮」。
    let dispatchUsage: Partial<Usage> | undefined

    // T3: escalation shadow events collected during retry
    const escalationShadows: ModelTierShadowEvent[] = []

    // Wrap worker execution with abort signal so the caller unblocks immediately
    // when the tool-level timeout fires, instead of waiting for the worker's
    // internal 180s timeout. The worker's own agent.abort() will fire from its
    // internal timer, but we don't block on it.
    //
    // IMPORTANT: wrapAbort guarantees listener cleanup. If the worker resolves
    // before the signal fires, the 'abort' listener is removed to prevent
    // accumulation across repeated delegate calls in a long session.
    const abortSignal = mergedSignal

    const wrapAbort = <T>(p: Promise<T>): Promise<T> => {
      if (!abortSignal) return p
      if (abortSignal.aborted) return Promise.reject(new Error('Delegation aborted: caller signal already fired'))

      return new Promise<T>((resolve, reject) => {
        let settled = false
        const onAbort = () => {
          if (settled) return
          // Distinguish policy-cancel (must not go to stall/provider-fault path) from
          // stall-sweep abort (per-order controller fired, parent did not).
          const policyCancel = this.policyCancelledIds.has(order.id)
          const stallAbort = !policyCancel && orderController.signal.aborted && !parentSignal?.aborted
          const stallSecs = (() => {
            const ms = this.liveness.tolerance(order.id)
            return ms ? Math.round(ms / 1000) : null
          })()
          const abortMsg = policyCancel
            ? `Delegation aborted: policy short-circuit — aggregation already satisfied, worker ${order.id} cancelled to save budget`
            : stallAbort
            ? `Worker ${order.id} stalled: no activity for ${stallSecs ?? '?'}s (provider: ${workerConfig.providerName ?? 'unknown'}) — upstream may be slow to first byte rather than dead; aborted by stall sweep`
            : 'Delegation aborted: caller signal fired'

          // Grace period: give the worker-session a bounded window (5s) to run
          // its internal salvageAbortedReport before rejecting. Without this,
          // the immediate reject races ahead of worker-session's wasAborted()
          // handler, discarding any partial report the worker already produced.
          // The worker Promise will resolve with the salvaged result if it
          // finishes within the grace period; otherwise we reject.
          const graceTimer = setTimeout(() => {
            if (!settled) {
              settled = true
              reject(new Error(abortMsg))
            }
          }, WORKER_ABORT_SALVAGE_GRACE_MS)
          // Allow the Node process to exit even if the grace timer is pending.
          graceTimer.unref?.()
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })

        p.then(
          (result) => {
            settled = true
            abortSignal.removeEventListener('abort', onAbort)
            resolve(result)
          },
          (err) => {
            settled = true
            abortSignal.removeEventListener('abort', onAbort)
            reject(err)
          },
        )
      })
    }

    let semanticLockAcquired = false
    // Acquire semantic lock via CollaborationProtocol only after all pre-dispatch
    // validation has passed. Otherwise early blocked returns (e.g. scope budget)
    // would need cleanup too and could leak fail-closed locks.
    if (this.collaboration && this.config.sessionId && order.scope.files?.length) {
      const intent: LockIntent = {
        operation: isWrite ? 'edit' : 'refactor',
        files: order.scope.files,
        description: order.objective,
      }
      const lockResult = this.collaboration.acquireLock(this.config.sessionId, intent)
      if (!lockResult.acquired) {
        const lockBlocked = [identify({
          workOrderId: order.id,
          status: 'blocked',
          summary: `Semantic lock conflict: ${lockResult.conflictingFiles.join(', ')} held by another session`,
          findings: [],
          artifacts: [{ kind: 'risk', title: 'Lock conflict', content: `Files locked by another session: ${lockResult.conflictingFiles.join(', ')}` }],
          changedFiles: [],
          risks: [`semantic lock conflict: ${lockResult.conflictingFiles.join(', ')}`],
          nextActions: ['Wait for other session to release locks, or use non-overlapping file scope'],
          evidenceStatus: 'blocked',
        })]
        return {
          status: 'completed',
          order,
          results: lockBlocked,
          packet: await buildPrimaryWorkerPacket(lockBlocked, this.config.artifactStore),
        }
      }
      semanticLockAcquired = true
    }

    // A4: arm the stall clock only once dispatch is committed (all early
    // blocked returns above never register, so they can't leak entries).
    this.orderControllers.set(order.id, orderController)
    this.liveness.register(order.id, this.config.workerStallMs ?? deriveWorkerStallMs({ providerName: workerConfig.providerName, baseUrl: workerConfig.baseUrl, slowThinking: workerConfig.slowThinking, isWrite }))
    this.ensureStallSweep()

    try {
      if (role === 'hands') {
        const acquiredClaimFiles: string[] = []
        try {
          // Check file claims before dispatching write worker
          if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
            const registry = this.config.sessionRegistry
            const sid = this.config.sessionId
            const conflictedFiles: string[] = []
            for (const f of order.scope.files) {
              if (registry.acquireClaim(sid, f, 'exclusive')) {
                acquiredClaimFiles.push(f)
              } else {
                conflictedFiles.push(f)
              }
            }
            if (conflictedFiles.length > 0) {
              // P1-1: first claim conflict — preserve actionable nextActions for the primary model
              const degraded = identify({
                workOrderId: order.id,
                status: 'blocked',
                summary: `文件声明冲突: ${conflictedFiles.join('、')} 被另一会话持有`,
                findings: [],
                artifacts: [{ kind: 'risk', title: '声明冲突', content: `以下文件被另一会话锁定: ${conflictedFiles.join('、')}` }],
                changedFiles: [],
                risks: [`声明冲突: ${conflictedFiles.join('、')}`],
                nextActions: ['等待其他会话释放声明后再重试', '或改用只读 profile 避免写冲突'],
                evidenceStatus: 'blocked',
              })
              return {
                status: 'completed',
                order,
                selectedModel: selected.model,
                modelTierShadows: [tierShadow],
                modelTierGatedDecisions: [tierGatedDecision],
                gatedInfluenceAudits: [gatedInfluenceAudit],
                results: [degraded],
                packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore),
              }
            }
          }

          const activeClaims = this.config.activeClaims?.() ?? workerConfig.activeClaims ?? []
          const cwd = this.config.cwd ?? workerConfig.cwd
          // Capture session messages from the hands worker for resume persistence.
          let handsSessionMessages: readonly OaiMessage[] | undefined
          // 本次 hands 会话内（首轮 + 续跑 + 修复）逐轮增长的回种基线；
          // 初始 = 派发级累计（可能含此前失败尝试的用量），会话结束后整包
          // 并回 dispatchUsage。
          let handsPriorUsage: Partial<Usage> | undefined = dispatchUsage
          // 写工的断点此前整个丢掉——runHands 只透传 result/usage，内层
          // WorkerSessionRun.checkpoint 无人接。结果是最容易耗尽预算的一档
          // worker（32 轮的实现+验证）连「可续跑」这句提示都拿不到。
          let handsCheckpoint: WorkerCheckpoint | undefined
          // 冻结快照与 handsSessionMessages 同生命周期——续跑（continueSession）
          // 经 priorFrozenSnapshot 回传给新进程继承，每轮新快照覆盖。
          let handsFrozenSnapshot: FrozenSnapshotData | undefined
          // Write workers (patcher/verifier) execute in an isolated git worktree.
          // Worktree lifecycle is managed by runHands → runHandsSession: create
          // before agent runs, collect diff after, cleanup on exit.
          // NOTE: The host agent framework (Claude Code etc.) may still sandbox
          // subagent write operations (edit_file/write_file/bash) even when Rivet
          // correctly provisions write tools and worktree isolation. This is a
          // host-layer constraint, not a Rivet work-order or worktree bug.
          // Register the worker's fallback session BEFORE runHands so any diff
          // persisted during the run is resolvable by the primary store, and hand
          // a worker-scoped store to runHands for persistence.
          this.registerWorkerArtifacts(order.id)
          const workerStore = this.config.artifactStore?.forSession(this.workerArtifactSessionId(order.id))
          const handsRun = await wrapAbort(this.runHands({
            order,
            wtCoordinator: new WorktreeCoordinator(cwd),
            cwd,
            sharedWorkspace: this.config.sharedWorktree,
            maxTurns: workerConfig.maxTurns,
            contextWindow: workerConfig.contextWindow,
            compact: workerConfig.compact,
            activeClaims,
            domainKnowledgeStore: this.config.domainKnowledgeStore,
            artifactStore: workerStore,
            onLifecycle: (detail) => emitLifecycle(workerConfig, detail),
            runAgent: async (_prompt, callbacks, workerCwd, options) => {
              // worker prompt 由 order 重建，所以额外轮次的意图走结构化字段而非
              // prompt 文本：objective 覆盖本轮目标，continueSession 让这一轮接上
              // 前一轮的完整对话（Wave 7 的 worktree 内续跑靠这两个）。
              const sessionRun = await this.runWorker({
                ...workerConfig,
                order: options?.objective ? { ...order, objective: options.objective } : order,
                cwd: workerCwd,
                activeClaims,
                domainKnowledgeStore: this.config.domainKnowledgeStore,
                ...(handsPriorUsage ? { priorUsage: handsPriorUsage } : {}),
                ...(options?.continueSession && handsSessionMessages && handsSessionMessages.length > 0
                  ? { priorMessages: handsSessionMessages }
                  : {}),
                ...(options?.continueSession && handsFrozenSnapshot
                  ? { priorFrozenSnapshot: handsFrozenSnapshot }
                  : {}),
              })
              handsPriorUsage = mergeUsage(handsPriorUsage, sessionRun.usage) ?? handsPriorUsage
              if (typeof sessionRun.session?.getMessages === 'function') {
                handsSessionMessages = sessionRun.session.getMessages()
              }
              handsFrozenSnapshot = sessionRun.frozenSnapshot ?? handsFrozenSnapshot
              handsCheckpoint = sessionRun.checkpoint
              callbacks.onTurnComplete(sessionRun.usage, 1, true)
              return JSON.stringify(sessionRun.result)
            },
          }))
          this.captureAbortCheckpoint(order.id, handsCheckpoint, handsRun.result)
          dispatchUsage = mergeUsage(dispatchUsage, handsRun.usage) ?? dispatchUsage
          run = { result: handsRun.result, sessionMessages: handsSessionMessages, checkpoint: handsCheckpoint, frozenSnapshot: handsFrozenSnapshot, usage: dispatchUsage, providerName: workerConfig.providerName }
          this.recordWorkerEpisode(order, handsRun, selected.model, dispatchStartedAt)
        } finally {
          if (this.config.sessionRegistry && this.config.sessionId) {
            for (const file of acquiredClaimFiles) {
              this.config.sessionRegistry.releaseClaim(this.config.sessionId, file)
            }
          }
        }
      } else {
        const workerRun = await wrapAbort(this.runWorker({
          ...workerConfig,
          ...(dispatchUsage ? { priorUsage: dispatchUsage } : {}),
        }))
        this.captureAbortCheckpoint(order.id, workerRun.checkpoint, workerRun.result)
        dispatchUsage = mergeUsage(dispatchUsage, workerRun.usage) ?? dispatchUsage
        const sessionMessages = typeof workerRun.session?.getMessages === 'function'
          ? workerRun.session.getMessages()
          : undefined
        run = { result: workerRun.result, transcript: workerRun.transcript, sessionMessages, frozenSnapshot: workerRun.frozenSnapshot, usage: dispatchUsage, providerName: workerConfig.providerName }
        this.registerWorkerArtifacts(order.id)
      }
    } catch (error) {
      // Physarum health: worker run threw (API/runtime fault, not task outcome).
      // Caller-initiated aborts are not the provider's fault — skip those.
      const msg = error instanceof Error ? error.message : String(error)
      const isAbort = (error instanceof Error && error.name === 'AbortError') || msg.includes('Delegation aborted')
      if (!isAbort) this.recordProviderOutcome(selected.model, false)

      // ── Exponential backoff retry (same-model) ──────────────────────
      // Transient errors (429, network blips) are not model-capability issues.
      // Retry with the same model before attempting Flash→Pro escalation.
      if (!isAbort && order.budget.maxRetries > 0 && !run) {
        const retrySleep = this.config.retrySleepFn ?? sleep
        for (let attempt = 1; attempt <= order.budget.maxRetries; attempt++) {
          const delay = Math.min(
            order.budget.retryBackoffMs * Math.pow(2, attempt - 1),
            order.budget.maxRetryBackoffMs,
          )
          try {
            await retrySleep(delay, mergedSignal)
          } catch {
            // sleep aborted — stop retrying, fall through to degraded return
            break
          }
          // Re-register liveness for the retry attempt
          this.liveness.register(order.id, this.config.workerStallMs ?? deriveWorkerStallMs({ providerName: workerConfig.providerName, baseUrl: workerConfig.baseUrl, slowThinking: workerConfig.slowThinking, isWrite }))
          this.orderControllers.set(order.id, orderController)
          try {
            if (role === 'hands') {
              const retryClaimFiles: string[] = []
              try {
                if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
                  const registry = this.config.sessionRegistry
                  const sid = this.config.sessionId
                  const conflicted: string[] = []
                  for (const f of order.scope.files) {
                    if (registry.acquireClaim(sid, f, 'exclusive')) retryClaimFiles.push(f)
                    else conflicted.push(f)
                  }
                  if (conflicted.length > 0) {
                    for (const f of retryClaimFiles) registry.releaseClaim(sid, f)
                    break // can't retry — claims blocked
                  }
                }
                const retryCwd = this.config.cwd ?? workerConfig.cwd
                let retryHandsMessages: readonly OaiMessage[] | undefined
                let retryHandsFrozenSnapshot: FrozenSnapshotData | undefined
                let retryHandsPriorUsage: Partial<Usage> | undefined = dispatchUsage
                // Retry reuses the same order.id, so the fallback session is
                // already registered by the primary branch above. Re-derive the
                // worker-scoped store so retry diffs also persist (otherwise the
                // delegation diff review would silently miss retry/escalation paths).
                const retryWorkerStore = this.config.artifactStore?.forSession(this.workerArtifactSessionId(order.id))
                const retryHandsRun = await wrapAbort(this.runHands({
                  order,
                  wtCoordinator: new WorktreeCoordinator(retryCwd),
                  cwd: retryCwd,
                  sharedWorkspace: this.config.sharedWorktree,
                  maxTurns: workerConfig.maxTurns,
                  contextWindow: workerConfig.contextWindow,
                  compact: workerConfig.compact,
                  activeClaims: this.config.activeClaims?.() ?? workerConfig.activeClaims ?? [],
                  domainKnowledgeStore: this.config.domainKnowledgeStore,
                  artifactStore: retryWorkerStore,
                  onLifecycle: (detail) => emitLifecycle(workerConfig, detail),
                  runAgent: async (_prompt, callbacks, workerCwd, options) => {
                    const sessionRun = await this.runWorker({
                      ...workerConfig,
                      order: options?.objective ? { ...order, objective: options.objective } : order,
                      cwd: workerCwd,
                      activeClaims: workerConfig.activeClaims ?? [],
                      domainKnowledgeStore: this.config.domainKnowledgeStore,
                      ...(retryHandsPriorUsage ? { priorUsage: retryHandsPriorUsage } : {}),
                      ...(options?.continueSession && retryHandsMessages && retryHandsMessages.length > 0
                        ? { priorMessages: retryHandsMessages }
                        : {}),
                      ...(options?.continueSession && retryHandsFrozenSnapshot
                        ? { priorFrozenSnapshot: retryHandsFrozenSnapshot }
                        : {}),
                    })
                    retryHandsPriorUsage = mergeUsage(retryHandsPriorUsage, sessionRun.usage) ?? retryHandsPriorUsage
                    if (typeof sessionRun.session?.getMessages === 'function') {
                      retryHandsMessages = sessionRun.session.getMessages()
                    }
                    retryHandsFrozenSnapshot = sessionRun.frozenSnapshot ?? retryHandsFrozenSnapshot
                    callbacks.onTurnComplete(sessionRun.usage, 1, true)
                    return JSON.stringify(sessionRun.result)
                  },
                }))
                dispatchUsage = mergeUsage(dispatchUsage, retryHandsRun.usage) ?? dispatchUsage
                run = { result: retryHandsRun.result, sessionMessages: retryHandsMessages, frozenSnapshot: retryHandsFrozenSnapshot, usage: dispatchUsage, providerName: workerConfig.providerName }
                this.recordWorkerEpisode(order, retryHandsRun, selected.model, dispatchStartedAt)
              } finally {
                if (this.config.sessionRegistry && this.config.sessionId) {
                  for (const f of retryClaimFiles) this.config.sessionRegistry.releaseClaim(this.config.sessionId, f)
                }
              }
            } else {
              const workerRun = await wrapAbort(this.runWorker({
                ...workerConfig,
                ...(dispatchUsage ? { priorUsage: dispatchUsage } : {}),
              }))
              this.captureAbortCheckpoint(order.id, workerRun.checkpoint, workerRun.result)
              dispatchUsage = mergeUsage(dispatchUsage, workerRun.usage) ?? dispatchUsage
              const sessionMessages = typeof workerRun.session?.getMessages === 'function'
                ? workerRun.session.getMessages()
                : undefined
              run = { result: workerRun.result, transcript: workerRun.transcript, sessionMessages, frozenSnapshot: workerRun.frozenSnapshot, usage: dispatchUsage, providerName: workerConfig.providerName }
            }
            // Retry succeeded — record provider health and exit loop
            this.recordProviderOutcome(selected.model, true)
            if (profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordSuccess(order.profile)
            break
          } catch (retryError) {
            // This retry attempt failed — continue to next attempt (or fall through)
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
            const retryIsAbort = (retryError instanceof Error && retryError.name === 'AbortError') || retryMsg.includes('Delegation aborted')
            if (retryIsAbort) break // abort stops all retries
            if (attempt === order.budget.maxRetries) {
              // All same-model retries exhausted — fall through to Flash→Pro
            }
          } finally {
            this.liveness.unregister(order.id)
            this.orderControllers.delete(order.id)
          }
        }
      }

      // T3: Flash→Pro escalation — retry with a higher-tier model if budget allows.
      // tierLock:'cheap' profiles (reviewer / adversarial_verifier) must NOT be
      // escalated: review workers are deliberately pinned to a cheap/isolated
      // model so they don't evict the main session's prefix cache (see
      // .rivet/knowledge/debug-glm-cache-break-deliver-task.md). Honor the lock.
      // workers.escalationCap：升档重试是全新会话零缓存全量重跑整个 work order，
      // 'off' 时完全禁止；'balanced' 时最多用 balanced 卡重试（不碰 Pro）。
      const flashTier = inferModelTierFromCard(selected)
      const tierLocked = profileRegistry.get(order.profile)?.tierLock === 'cheap'
      const maxEscalationTier = escalationTierAllowed(this.config.escalationCap)
      const canUpgrade = !isAbort
        && !tierLocked
        && maxEscalationTier !== null
        && (order.budget.maxRetries > 0)
        && this.proUpgradeCount < DelegationCoordinator.MAX_PRO_UPGRADES
        && TIER_FLOOR_RANK[flashTier] < TIER_FLOOR_RANK[maxEscalationTier ?? 'cheap']
      if (canUpgrade) {
        // 候选：比当前卡高、且不超过 escalationCap 的卡，取档位最高的一张。
        const upgradeCards = this.config.modelCards
          .filter(c => {
            const t = inferModelTierFromCard(c)
            return TIER_FLOOR_RANK[t] > TIER_FLOOR_RANK[flashTier]
              && TIER_FLOOR_RANK[t] <= TIER_FLOOR_RANK[maxEscalationTier!]
          })
          .sort((a, b) => TIER_FLOOR_RANK[inferModelTierFromCard(b)] - TIER_FLOOR_RANK[inferModelTierFromCard(a)])
        const strongCard = upgradeCards[0]
        if (strongCard) {
          // Re-create worker config with Pro model
          const upgradedConfig = this.config.runtimeFactory(order, strongCard, workerRegistry)
          upgradedConfig.maxTurns = clampWorkerMaxTurns(upgradedConfig.maxTurns, order.budget.maxTurns)
          upgradedConfig.reviewDepth = order.reviewDepth
          upgradedConfig.parentApprovalMode = this.config.parentApprovalMode
          upgradedConfig.domainKnowledgeStore = this.config.domainKnowledgeStore
          upgradedConfig.abortSignal = mergedSignal
          upgradedConfig.onActivity = forwardActivity
          // 升级重试是全新 config——转录快照与嵌套上行不接就在 Pro 重试段丢失。
          upgradedConfig.onSessionReady = workerConfig.onSessionReady
          upgradedConfig.onNestedDelegation = workerConfig.onNestedDelegation
          upgradedConfig.mailbox = mailbox
          // 升级重试是全新 config——finalizeReport（RIVET_WORKER_FINALIZE 灰度）
          // 不从原 config 接就在 Pro 重试段失守（一键回退覆盖不全）。
          upgradedConfig.finalizeReport = workerConfig.finalizeReport

          // Re-register liveness for retry — leash derives from the UPGRADED
          // provider (escalation may land on a slow-thinking one).
          this.liveness.register(order.id, this.config.workerStallMs ?? deriveWorkerStallMs({ providerName: upgradedConfig.providerName, baseUrl: upgradedConfig.baseUrl, slowThinking: upgradedConfig.slowThinking, isWrite }))

          try {
            if (role === 'hands') {
              // P1-1: re-acquire claims before Pro retry (original claims released in inner finally)
              const retryClaimFiles: string[] = []
              try {
                if (this.config.sessionRegistry && this.config.sessionId && order.scope.files?.length) {
                  const registry = this.config.sessionRegistry
                  const sid = this.config.sessionId
                  const conflictedFiles: string[] = []
                  for (const f of order.scope.files) {
                    if (registry.acquireClaim(sid, f, 'exclusive')) {
                      retryClaimFiles.push(f)
                    } else {
                      conflictedFiles.push(f)
                    }
                  }
                  if (conflictedFiles.length > 0) {
                    for (const f of retryClaimFiles) registry.releaseClaim(sid, f)
                    const degraded = identify(this.enrichResult(
                      workerFailureResult(order, new Error(`Retry blocked: ${conflictedFiles.join(', ')} claimed by another session`), { failureReason: 'claim_conflict' }),
                      strongCard.model,
                      upgradedConfig.providerName,
                    ))
                    return { status: 'completed' as const, order, selectedModel: strongCard.model, modelTierShadows: [tierShadow, ...escalationShadows], modelTierGatedDecisions: [tierGatedDecision], gatedInfluenceAudits: [gatedInfluenceAudit], results: [degraded], packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore) }
                  }
                }

                // P1-1: increment quota and write escalation shadow only after claim check passes
                escalationShadows.push(this.recordEscalation(order, strongCard, msg))
                const cwd = this.config.cwd ?? upgradedConfig.cwd
                let retryHandsMessages: readonly OaiMessage[] | undefined
                // 升档换了模型（缓存命名空间不同）——旧模型快照不回传，只追踪
                // 新轮自己的快照供后续续跑继承。
                let escalateHandsFrozenSnapshot: FrozenSnapshotData | undefined
                let escalateHandsPriorUsage: Partial<Usage> | undefined = dispatchUsage
                // Escalation retries with the same order.id → fallback session already
                // registered. Re-derive worker store so the escalated run's diff persists
                // (parity with primary + retry branches).
                const escalateWorkerStore = this.config.artifactStore?.forSession(this.workerArtifactSessionId(order.id))
                const handsRun = await wrapAbort(this.runHands({
                  order, wtCoordinator: new WorktreeCoordinator(cwd), cwd,
                  sharedWorkspace: this.config.sharedWorktree,
                  maxTurns: upgradedConfig.maxTurns,
                  contextWindow: upgradedConfig.contextWindow,
                  compact: upgradedConfig.compact,
                  activeClaims: upgradedConfig.activeClaims ?? [],
                  domainKnowledgeStore: this.config.domainKnowledgeStore,
                  artifactStore: escalateWorkerStore,
                  onLifecycle: (detail) => emitLifecycle(workerConfig, detail),
                  runAgent: async (_prompt, callbacks, workerCwd, options) => {
                    const sessionRun = await this.runWorker({
                      ...upgradedConfig,
                      order: options?.objective ? { ...order, objective: options.objective } : order,
                      cwd: workerCwd,
                      activeClaims: upgradedConfig.activeClaims ?? [],
                      domainKnowledgeStore: this.config.domainKnowledgeStore,
                      ...(escalateHandsPriorUsage ? { priorUsage: escalateHandsPriorUsage } : {}),
                      ...(options?.continueSession && retryHandsMessages && retryHandsMessages.length > 0
                        ? { priorMessages: retryHandsMessages }
                        : {}),
                    })
                    escalateHandsPriorUsage = mergeUsage(escalateHandsPriorUsage, sessionRun.usage) ?? escalateHandsPriorUsage
                    if (typeof sessionRun.session?.getMessages === 'function') {
                      retryHandsMessages = sessionRun.session.getMessages()
                    }
                    escalateHandsFrozenSnapshot = sessionRun.frozenSnapshot ?? escalateHandsFrozenSnapshot
                    callbacks.onTurnComplete(sessionRun.usage, 1, true)
                    return JSON.stringify(sessionRun.result)
                  },
                }))
                dispatchUsage = mergeUsage(dispatchUsage, handsRun.usage) ?? dispatchUsage
                run = { result: handsRun.result, sessionMessages: retryHandsMessages, frozenSnapshot: escalateHandsFrozenSnapshot, usage: dispatchUsage, providerName: upgradedConfig.providerName }
                this.recordWorkerEpisode(order, handsRun, strongCard.model, dispatchStartedAt)
              } finally {
                if (this.config.sessionRegistry && this.config.sessionId)
                  for (const f of retryClaimFiles)
                    this.config.sessionRegistry.releaseClaim(this.config.sessionId, f)
              }
            } else {
              // P1-1: increment quota and write escalation shadow for read-only retry
              escalationShadows.push(this.recordEscalation(order, strongCard, msg))
              const workerRun = await wrapAbort(this.runWorker({
                ...upgradedConfig,
                ...(dispatchUsage ? { priorUsage: dispatchUsage } : {}),
              }))
              dispatchUsage = mergeUsage(dispatchUsage, workerRun.usage) ?? dispatchUsage
              const sessionMessages = typeof workerRun.session?.getMessages === 'function'
                ? workerRun.session.getMessages()
                : undefined
              run = { result: workerRun.result, transcript: workerRun.transcript, sessionMessages, usage: dispatchUsage, providerName: upgradedConfig.providerName }
            }
            // Upgrade succeeded — record provider outcome; circuit recovery for tier-locked profiles
            this.recordProviderOutcome(strongCard.model, true)
            if (profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordSuccess(order.profile)
            selected = strongCard
            // Rebuild tierShadow for the Pro model so telemetry is coherent
            const freshTierShadow = this.buildTierShadow(order, selected, tierRecommendation)
            persistModelTierShadow(this.config.modelTierShadowStore, freshTierShadow)
            // Replace the stale flash-tier tierShadow; escalation shadow records the retry event
            escalationShadows.push(freshTierShadow)
          } catch (_retryError) {
            // Pro upgrade also failed — record provider outcome; circuit failure for tier-locked profiles
            this.recordProviderOutcome(strongCard.model, false)
            if (profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordFailure(order.profile)
            const degraded = identify(this.enrichResult(workerFailureResult(order, error, { failureReason: classifyWorkerError(error) }), strongCard.model, upgradedConfig.providerName))
            return {
              status: 'completed' as const,
              order,
              selectedModel: strongCard.model,
              modelTierShadows: [tierShadow, ...escalationShadows],
              modelTierGatedDecisions: [tierGatedDecision],
              gatedInfluenceAudits: [gatedInfluenceAudit],
              results: [degraded],
              packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore),
            }
          }
        }
      }

      // If retry didn't happen, return degraded — circuit records failure for tier-locked profiles
      if (!run) {
        // Abort salvage: wrapAbort's immediate reject can race ahead of
        // worker-session's internal salvageAbortedReport. Try to recover the
        // worker's partial output from the abort checkpoint BEFORE returning
        // an empty failure — the worker may have produced a valid (if unverified)
        // report that just didn't reach us through the Promise chain.
        if (isAbort) {
          const checkpoint = this.abortCheckpoints.get(order.id)
          if (checkpoint?.partialResult) {
            const salvaged = salvageWorkerResult(checkpoint.partialResult, order.id)
            if (salvaged) {
              const enriched = identify(this.enrichResult(salvaged, selected.model, workerConfig.providerName))
              return {
                status: 'completed' as const,
                order,
                selectedModel: selected.model,
                modelTierShadows: [tierShadow],
                modelTierGatedDecisions: [tierGatedDecision],
                gatedInfluenceAudits: [gatedInfluenceAudit],
                results: [enriched],
                packet: await buildPrimaryWorkerPacket([enriched], this.config.artifactStore),
              }
            }
          }
        }
        if (!isAbort && profileRegistry.get(order.profile)?.tierLock) this.circuitBreaker.recordFailure(order.profile)
        const degraded = identify(this.enrichResult(workerFailureResult(order, error, { failureReason: classifyWorkerError(error) }), selected.model, workerConfig.providerName))
        return {
          status: 'completed' as const,
          order,
          selectedModel: selected.model,
          modelTierShadows: [tierShadow],
          modelTierGatedDecisions: [tierGatedDecision],
          gatedInfluenceAudits: [gatedInfluenceAudit],
          results: [degraded],
          packet: await buildPrimaryWorkerPacket([degraded], this.config.artifactStore),
        }
      }
    } finally {
      // A4: stop tracking — no false stall after completion/failure.
      this.liveness.unregister(order.id)
      this.orderControllers.delete(order.id)
      this.liveMessages.delete(order.id)
      this.nestedUpstream.delete(order.id)
      this.activityUpstream.delete(order.id)
      this.batchPrewarmByOrder.delete(order.id)
      this.batchStigmergyByOrder.delete(order.id)
      this.resumeMessages.delete(order.id)
      this.steerQueues.delete(order.id)
      if (this.liveness.size() === 0) this.stopStallSweep()
      if (semanticLockAcquired && this.collaboration && this.config.sessionId) {
        this.collaboration.releaseLocks(this.config.sessionId)
      }
    }

    // 预算耗尽 → 自动续跑。必须在 enrichResult / 熔断记账 / 升级判定之前：否则
    // 首轮的 blocked 先污染连败计数，而续跑产出的结果又拿不到模型元数据。
    run = await this.maybeContinueExhausted(order, workerConfig, mergedSignal, isWrite, run)

    // 证据不达标 → 打回复核一轮。同样必须在 enrichResult / 熔断记账之前：复核
    // 产出的才是最终结果，让它拿到模型元数据、也让熔断记的是最终判定。
    run = await this.maybeReviseEvidence(order, workerConfig, mergedSignal, isWrite, run)

    // verdict ≠ status：审查/验证工单的结论性 failed/escalated 归一为 passed（缺陷
    // 走 findings/polarity 通道）——必须在熔断记账、连败计数、升级判定之前，否则
    // 审查发现会被当成 worker 运行失败（2026-08-02 三连败误升级事故）。
    run = { ...run, result: normalizeReviewVerdictStatus(order, run.result) }

    // P0-5: 契约失败升档——worker 正常返回但结果因契约破碎 blocked
    //（json_parse / schema_mismatch）。同模型修复梯在 worker 内部已用尽
    //（finalize 收尾轮 + repair 轮 + salvage），此时升一档模型一轮合规的概率
    // 远高于同模型继续原地碎。复用 Flash→Pro 的配额与档位条件；只限只读路径
    //（hands 有写闸门/续跑自有阶梯）。升档结果只在「确实更好」（不再是契约
    // 破碎）时才替换原结果——升档是机会，不是赌博。
    if (!isWrite
      && run.result.status === 'blocked'
      && (run.result.failureReason === 'json_parse' || run.result.failureReason === 'schema_mismatch')) {
      const contractFlashTier = inferModelTierFromCard(selected)
      const contractTierLocked = profileRegistry.get(order.profile)?.tierLock === 'cheap'
      const contractMaxTier = escalationTierAllowed(this.config.escalationCap)
      const canEscalateContract = !contractTierLocked
        && contractMaxTier !== null
        && this.proUpgradeCount < DelegationCoordinator.MAX_PRO_UPGRADES
        && TIER_FLOOR_RANK[contractFlashTier] < TIER_FLOOR_RANK[contractMaxTier]
      if (canEscalateContract) {
        const upgradeCards = this.config.modelCards
          .filter(c => {
            const t = inferModelTierFromCard(c)
            return TIER_FLOOR_RANK[t] > TIER_FLOOR_RANK[contractFlashTier]
              && TIER_FLOOR_RANK[t] <= TIER_FLOOR_RANK[contractMaxTier!]
          })
          .sort((a, b) => TIER_FLOOR_RANK[inferModelTierFromCard(b)] - TIER_FLOOR_RANK[inferModelTierFromCard(a)])
        const strongCard = upgradeCards[0]
        if (strongCard) {
          const upgradedConfig = this.config.runtimeFactory(order, strongCard, workerRegistry)
          upgradedConfig.maxTurns = clampWorkerMaxTurns(upgradedConfig.maxTurns, order.budget.maxTurns)
          upgradedConfig.reviewDepth = order.reviewDepth
          upgradedConfig.parentApprovalMode = this.config.parentApprovalMode
          upgradedConfig.domainKnowledgeStore = this.config.domainKnowledgeStore
          upgradedConfig.abortSignal = mergedSignal
          upgradedConfig.onActivity = forwardActivity
          // 升级重试是全新 config——转录快照/嵌套上行/灰度开关逐项接回（同 catch 路径）。
          upgradedConfig.onSessionReady = workerConfig.onSessionReady
          upgradedConfig.onNestedDelegation = workerConfig.onNestedDelegation
          upgradedConfig.mailbox = mailbox
          upgradedConfig.finalizeReport = workerConfig.finalizeReport
          this.liveness.register(order.id, this.config.workerStallMs ?? deriveWorkerStallMs({ providerName: upgradedConfig.providerName, baseUrl: upgradedConfig.baseUrl, slowThinking: upgradedConfig.slowThinking, isWrite }))
          this.orderControllers.set(order.id, orderController)
          try {
            escalationShadows.push(this.recordEscalation(order, strongCard, `契约失败(${run.result.failureReason})升档重试`))
            const workerRun = await wrapAbort(this.runWorker({
              ...upgradedConfig,
              ...(dispatchUsage ? { priorUsage: dispatchUsage } : {}),
            }))
            dispatchUsage = mergeUsage(dispatchUsage, workerRun.usage) ?? dispatchUsage
            this.recordProviderOutcome(strongCard.model, true)
            const stillBroken = workerRun.result.status === 'blocked'
              && (workerRun.result.failureReason === 'json_parse' || workerRun.result.failureReason === 'schema_mismatch')
            if (!stillBroken) {
              const escSessionMessages = typeof workerRun.session?.getMessages === 'function'
                ? workerRun.session.getMessages()
                : undefined
              run = {
                ...run,
                result: workerRun.result,
                sessionMessages: escSessionMessages ?? run.sessionMessages,
                // 快照跟随 sessionMessages 的选择：用了升档轮消息就换升档轮快照
                frozenSnapshot: (escSessionMessages ? workerRun.frozenSnapshot : undefined) ?? run.frozenSnapshot,
                usage: dispatchUsage,
                providerName: upgradedConfig.providerName,
              }
              selected = strongCard
            }
            // 升档后契约仍碎——保留原结果：失败不源于模型档位，不浪费替换。
          } catch {
            // 升档运行本身抛错——保留原契约破碎结果，provider 健康记账失败。
            this.recordProviderOutcome(strongCard.model, false)
          } finally {
            this.liveness.unregister(order.id)
            this.orderControllers.delete(order.id)
          }
        }
      }
    }


    // Run completed — regardless of task verdict, the provider's API delivered.
    run.result = this.enrichResult(run.result, selected.model, run.providerName ?? workerConfig.providerName, run.usage)
    this.recordProviderOutcome(selected.model, true)

    // Circuit breaker: record outcome for tier-locked profiles (Flash army)
    if (profileRegistry.get(order.profile)?.tierLock) {
      if (run.result.status === 'passed') {
        this.circuitBreaker.recordSuccess(order.profile)
      } else {
        this.circuitBreaker.recordFailure(order.profile)
      }
    }

    this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

    if (this.state.shouldEscalate()) {
      this.state.recordEvent({ type: 'escalated', workOrderId: order.id, timestamp: Date.now() })
      // Build results and packet from the SAME escalated result — previously the
      // packet carried the raw run.result while results carried the escalated
      // rewrite, so the model and the caller saw different stories. Keep the
      // last worker summary inline so the failure detail is not lost.
      const escalatedResults = [identify({
        ...run.result,
        status: 'blocked' as const,
        summary: `Escalated: ${this.state.getSummary().failed} consecutive failures. Last worker result: ${run.result.summary}`,
      })]
      return {
        status: 'completed' as const,
        escalated: true,
        order,
        selectedModel: selected.model,
        modelTierShadows: escalationShadows.length > 0 ? escalationShadows : [tierShadow],
        modelTierGatedDecisions: [tierGatedDecision],
        gatedInfluenceAudits: [gatedInfluenceAudit],
        results: escalatedResults,
        packet: await buildPrimaryWorkerPacket(escalatedResults, this.config.artifactStore),
      }
    }

    const profileMap = new Map([[order.id, order.profile]])
    const transcriptMap = run.transcript ? new Map([[order.id, run.transcript]]) : undefined

    // Summary quality gate: expand brief summaries before persisting/returning.
    if (run.sessionMessages && run.sessionMessages.length > 0 && run.result.status === 'passed' && run.result.summary.length < SUMMARY_MIN_LENGTH) {
      const expanded = await this.maybeExpandSummary(order, workerConfig, mergedSignal, run.result, run.sessionMessages, dispatchUsage, run.frozenSnapshot)
      run = { ...run, result: expanded.result, sessionMessages: expanded.sessionMessages, frozenSnapshot: expanded.frozenSnapshot ?? run.frozenSnapshot }
    }

    // 目标对账：盖上派发侧的 objective，并核一次交回物是否回答了受派的问题。
    // 位置在摘要扩写**之后**——扩写有机会把偏短的 summary 补起来，先判空壳会把
    // 本可救回的误判成空。也在 aggregateResults 之前：evidence 门只会把 status
    // 往严处改，不会把这里判出的 blocked 翻回 passed。
    //
    // 批量派发每个 order 也走这条路（delegateBatch → delegateOrder），所以对账
    // 对 batch worker 同样生效，无须在批聚合处再来一遍。
    run = { ...run, result: reconcileWithObjective(order, run.result, run.transcript) }

    const results = aggregateResults([run.result], 'primary_decides', profileMap, transcriptMap).map(identify)
    // Wave 3 aggregation path: consume ONLY the verifyWorkerEvidence-gated
    // output — the adapter maps, never re-derives evidence policy.
    this.emitWorkerResultSignals(results)

    // V3 Component B-loop: precipitate domain lessons from results
    if (order.authority && this.config.domainKnowledgeStore) {
      precipitateDomainLessons(this.config.domainKnowledgeStore, {
        domainId: order.authority,
        results,
        objective: order.objective,
      })
    }

    // D1: persist worker result to ~/.rivet/subagents/ for future resume/inspection.
    // 带上本次派发 nonce——稳定 order id 复用时逐轮归档，前轮结果不再被覆盖（L1）。
    const fp = fingerprintRequest(order.objective, order.scope.files, order.profile)
    for (const r of results) {
      persistWorkerResult(r, fp, dispatchNonce)
    }

    // Save worker session history for resume support. Best-effort: never blocks.
    // W3: carry the run's checkpoint (if any) into the persisted record so a
    // later resume — possibly a NEW coordinator instance / process — can pick
    // it up from disk instead of only from the in-memory abortCheckpoints map.
    if (run.sessionMessages && run.sessionMessages.length > 0) {
      saveWorkerSession(order.id, order.profile, order.objective, run.sessionMessages, undefined, run.checkpoint)
    }

    return {
      status: 'completed' as const,
      order,
      selectedModel: selected.model,
      modelTierShadows: escalationShadows.length > 0 ? escalationShadows : [tierShadow],
      modelTierGatedDecisions: [tierGatedDecision],
      gatedInfluenceAudits: [gatedInfluenceAudit],
      results,
      packet: await buildPrimaryWorkerPacket(results, this.config.artifactStore),
    }
  }

  async delegateBatch(
    requests: DelegationRequest[],
    policy: AggregationPolicy = 'primary_decides',
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
    /**
     * Per-worker settle hook — fires the moment EACH worker reaches its final
     * result (success / failure / blocked-dependency sweep), instead of waiting
     * for the whole batch. Consumers: TUI fleet panel terminal glyphs (a fast
     * worker must not show ◐ running while a slow sibling is still going).
     */
    onWorkerSettled?: (result: IdentifiedWorkerResult) => void,
  ): Promise<CoordinatorRun> {
    // P1-7: per-call abort signal passed down as parameter — never mutated on
    // the shared config (save/restore raced across concurrent calls).
    const batchParentSignal = abortSignal ?? this.config.abortSignal
    // P1-7: per-wave mailbox — fresh instance per delegateBatch call so
    // concurrent waves (background worker + main batch) never interleave mail.
    const batchMailbox = new InMemoryMailbox()
    // Pre-create work orders for deduplication and dependency ordering
    // （声明在 try 之外——finally 清理 policyCancelledIds 需要访问它；
    //  声明在 try 块内会让 finally 报 TS2304，见 678a4c4c 事故）
    const orders: WorkOrder[] = []
    try {
      // B3: depth-capped requests are rejected as blocked, not silently dropped.
      const depthCap = this.config.maxDelegationDepth ?? MAX_DELEGATION_DEPTH
      const depthCapped: WorkerResult[] = requests
        .filter(r => (r.delegationDepth ?? 0) >= depthCap)
        .map(r => ({
          workOrderId: `depth-capped-${r.parentTurnId}`,
          status: 'blocked' as const,
          summary: `Delegation rejected: max delegation depth (${depthCap}) reached — do the work inline instead of delegating further`,
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: ['unbounded delegation recursion prevented'],
          nextActions: ['Perform the objective directly in this worker session'],
          evidenceStatus: 'blocked' as const,
        }))
      const runnables = requests.filter(r =>
        (r.delegationDepth ?? 0) < depthCap && shouldDelegateObjective(r.objective, r.scope))
      if (runnables.length === 0 && depthCapped.length === 0) {
        return { status: 'skipped', results: [], packet: await buildPrimaryWorkerPacket([], this.config.artifactStore) }
      }
      if (runnables.length === 0) {
        return { status: 'completed', results: depthCapped, packet: await buildPrimaryWorkerPacket(depthCapped, this.config.artifactStore) }
      }

    // S1 分池：queue 全局帽与 coordinator 信号量同一口径（三帽最大值）——
    // 否则 explore 角色帽在全局帽之下形同虚设，只读 fan-out 依旧被 maxWorkers 压住。
    const queue = new WorkOrderQueue(this.totalWorkerCap(), {
      explore: this.config.maxExploreWorkers,
      write: this.config.maxWriteWorkers,
    })

    for (const r of runnables) {
      const isWrite = classifyProfile(r.profile) === 'hands'
      const stableId = deriveWorkOrderId(r.parentTurnId, r.delegationDepth)
      const order = isWrite
        ? createWriteWorkOrder({
            id: stableId,
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
            constraints: withPlanConstraints(r.constraints, r.objective, this.config),
            reviewDepth: r.reviewDepth,
            delegationDepth: (r.delegationDepth ?? 0) + 1,
            dependencies: r.dependencies,
            groupId: r.groupId,
            batchStigmergy: r.batchStigmergy,
            authority: r.authority,
            riskTier: r.riskTier,
            sessionTurn: r.sessionTurn,
            budget: isWrite ? this.budgetWithHistory(r) : r.budget,
            modelOverride: r.modelOverride,
            // 瑶光门：batch 路径曾丢弃 tierFloor（只传 modelOverride），护栏席
            // 声明 strong 实际可能跑低档——与单发 delegate() 路径对齐补传。
            tierFloor: r.tierFloor,
          })
        : createReadOnlyWorkOrder({
            id: stableId,
            parentTurnId: r.parentTurnId,
            kind: r.kind,
            profile: r.profile,
            objective: r.objective,
            scope: r.scope,
            constraints: withPlanConstraints(r.constraints, r.objective, this.config),
            reviewDepth: r.reviewDepth,
            delegationDepth: (r.delegationDepth ?? 0) + 1,
            dependencies: r.dependencies,
            groupId: r.groupId,
            batchStigmergy: r.batchStigmergy,
            authority: r.authority,
            riskTier: r.riskTier,
            sessionTurn: r.sessionTurn,
            budget: r.budget,
            modelOverride: r.modelOverride,
            tierFloor: r.tierFloor,
          })
      if (queue.enqueue(order)) {
        orders.push(order)
        // T9 P3: callbacks don't survive zod parsing — stash by order id.
        if (r.onActivity) this.activityUpstream.set(order.id, r.onActivity)
        if (r.onNestedActivity) this.nestedUpstream.set(order.id, r.onNestedActivity)
        // Session resume: load prior messages (same side-table pattern as delegate()).
        if (r.resumeWorkOrderId) {
          const record = loadWorkerSession(r.resumeWorkOrderId)
          if (record) {
            this.resumeMessages.set(order.id, record.messages)
            debugLog(`[worker-resume] batch: loaded ${record.messages.length} messages from ${r.resumeWorkOrderId} for ${order.id}`)
          }
          // W3: abort checkpoint rides along (consumed once). Memory stash wins,
          // else the persisted disk checkpoint (cross-process resume).
          const memCheckpoint = this.abortCheckpoints.get(r.resumeWorkOrderId)
          const checkpoint = memCheckpoint ?? record?.checkpoint
          if (checkpoint) {
            this.resumeCheckpoints.set(order.id, checkpoint)
            if (memCheckpoint) this.abortCheckpoints.delete(r.resumeWorkOrderId)
            // Staged → disk copy is spent; consume to prevent stale replay.
            if (record?.checkpoint) consumeCheckpointOnce(r.resumeWorkOrderId)
          }
        }
      }
    }

    // Batch-scoped shared prewarm: one PrewarmCache per batch, registered per
    // order before scheduling starts. Pre-warm the union of scope.files BEFORE
    // the concurrent dispatch loop — otherwise early workers start cold while
    // later siblings' warm-up is still in flight. Best-effort: failures are
    // silent and never block dispatch.
    if (orders.length > 0) {
      const batchCache = new PrewarmCache(60_000, 50)
      const files = [...new Set(orders.flatMap(o => o.scope.files ?? []))]
      for (const order of orders) this.batchPrewarmByOrder.set(order.id, batchCache)
      // 批级共享信息素（星河收编 #3）：内存 store 不落盘，生命周期 = 本次
      // delegateBatch。写工默认不注入（守护实现独立性），读工共享。
      const batchStigmergy = new StigmergyStore(undefined)
      for (const order of orders) this.batchStigmergyByOrder.set(order.id, batchStigmergy)
      if (files.length > 0) {
        await batchPrewarm(this.config.cwd ?? process.cwd(), files, batchCache, 25).catch(() => {})
      }
    }

    // Process queue with concurrency control
    const allResults: WorkerResult[] = []
    const workerModels: NonNullable<CoordinatorRun['workerModels']> = []
    const modelTierShadows: ModelTierShadowEvent[] = []
    const modelTierGatedDecisions: ModelTierGatedDecisionEvent[] = []
    const gatedInfluenceAudits: GatedInfluenceAuditEvent[] = []
    const inflight: Promise<void>[] = []
    let completedCount = 0

    // 短路判定器（策略达标 cancel-rest）：quorumGroups 收集从批末上移至
    // 此处（批末 aggregateResults 复用同一份）。quorumGroups 用于组阈值解析，
    // groupMembers/groupOf 用于组内成员范围判定。
    const quorumGroupsForJudge = new Map<string, number>()
    for (const req of requests) {
      if (req.groupId && req.quorumK !== undefined && !quorumGroupsForJudge.has(req.groupId)) {
        quorumGroupsForJudge.set(req.groupId, req.quorumK)
      }
    }
    const groupMembers = new Map<string, string[]>()
    const groupOf = new Map<string, string | undefined>()
    for (const o of orders) {
      groupOf.set(o.id, o.groupId)
      if (o.groupId) {
        const list = groupMembers.get(o.groupId) ?? []
        list.push(o.id)
        groupMembers.set(o.groupId, list)
      }
    }
    const profileMapForJudge = new Map(orders.map(o => [o.id, o.profile] as const))
    const judge = new BatchShortCircuitJudge(
      policy,
      profileMapForJudge,
      groupMembers,
      groupOf,
      quorumGroupsForJudge.size > 0 ? quorumGroupsForJudge : undefined,
    )
    const policyLabel = typeof policy === 'object' ? `quorum k=${policy.k}` : policy

    const processNext = async (): Promise<void> => {
      const order = queue.dequeue()
      if (!order) return
      queue.markInFlight(order)
      try {
        // P1-6/7/8: batch workers go through the same global gate as single
        // delegates — concurrency semaphore + cross-wave conflict registration,
        // with the wave's abort signal / mailbox passed explicitly.
        const run = await this.runDelegationWithGlobalGate(order, batchParentSignal, batchMailbox)
        allResults.push(...run.results)
        if (run.modelTierShadows) modelTierShadows.push(...run.modelTierShadows)
        if (run.modelTierGatedDecisions) modelTierGatedDecisions.push(...run.modelTierGatedDecisions)
        if (run.gatedInfluenceAudits) gatedInfluenceAudits.push(...run.gatedInfluenceAudits)
        if (run.selectedModel) {
          workerModels.push({ workOrderId: order.id, model: run.selectedModel })
        }
        queue.markCompleted(order)
        for (const r of run.results) onWorkerSettled?.(r)
        // 策略短路：每个 settle 结果喂入判定器，达标则取消剩余兄弟 worker
        if (cancelRestEnabled()) {
          for (const r of run.results) {
            const decision = judge.onSettle(r)
            if (decision.kind === 'none') continue
            const inScope = (o: WorkOrder) =>
              (decision.kind === 'cancel_all' || o.groupId === decision.groupId) && judge.cancellable(o)
            // pending：撤出队列，当场合成结果
            for (const cancelled of queue.cancelPending(inScope)) {
              const settled = buildPolicyCancelledResult(cancelled, policyLabel)
              allResults.push(settled)
              onWorkerSettled?.(settled)
              completedCount++
              onProgress?.(completedCount, orders.length)
            }
            // in-flight：登记后 abort（结果经 catch 合成）
            for (const o of queue.inFlight().filter(x => x.id !== order.id && inScope(x))) {
              this.policyCancelledIds.add(o.id)
              this.orderControllers.get(o.id)?.abort()
            }
          }
        }
      } catch (error) {
        const failure = this.policyCancelledIds.has(order.id)
          ? buildPolicyCancelledResult(order, policyLabel)
          : workerFailureResult(order, error, { failureReason: classifyWorkerError(error) })
        allResults.push(failure)
        queue.markFailed(order)
        onWorkerSettled?.(failure)
      }
      completedCount++
      onProgress?.(completedCount, orders.length)
      // Recurse: try to process next pending order (respecting concurrency limit)
      await processNext()
    }

    // Start initial batch of workers — pool-aware: read-only fan-outs (galaxy
    // 多维度只读) 需要比 maxWorkers 更多的循环才能吃满 explore 池帽。
    for (let i = 0; i < this.totalWorkerCap(); i++) {
      inflight.push(processNext())
    }
    await Promise.all(inflight)

    // A3: drain any orders that could never be scheduled because a dependency
    // failed (or itself ended up blocked). processNext stops dequeuing these, so
    // without an explicit sweep they would be silently lost from the result set.
    for (const order of queue.pending()) {
      // 条件依赖边（星河收编 #6）：onFailure=skip → 依赖失败则本任务跳过；
      // onFailure=alternate → 改等 alternateOrderId（完成放行、失败跳过）。
      const skippedDeps: string[] = []
      const unmet: string[] = []
      const failedDeps: string[] = []
      for (const dep of order.dependencies) {
        const edge = typeof dep === 'string' ? undefined : dep
        const depId: string = typeof dep === 'string' ? dep : dep.dependsOn
        if (queue.isCompleted(depId)) continue
        if (queue.hasFailed(depId)) {
          if (edge?.onFailure === 'skip') { skippedDeps.push(depId); continue }
          if (edge?.onFailure === 'alternate' && edge.alternateOrderId) {
            if (queue.isCompleted(edge.alternateOrderId)) continue
            if (queue.hasFailed(edge.alternateOrderId)) { skippedDeps.push(depId); continue }
            unmet.push(depId)
            continue
          }
          failedDeps.push(depId)
          continue
        }
        unmet.push(depId)
      }
      const settled = skippedDeps.length > 0
        ? skippedDependencyResult(order, skippedDeps)
        : blockedDependencyResult(order, unmet, failedDeps)
      allResults.push(settled)
      queue.markFailed(order)
      onWorkerSettled?.(settled)
    }

    const profileMap = new Map(orders.map(o => [o.id, o.profile] as const))
    const aggregated = [
      ...aggregateResults(allResults, policy, profileMap, undefined, quorumGroupsForJudge.size > 0 ? quorumGroupsForJudge : undefined),
      ...depthCapped,
    ]
    // Wave 3 aggregation path: post-verifyWorkerEvidence facts only.
    this.emitWorkerResultSignals(aggregated)
    // D1: persist worker results to ~/.rivet/subagents/。每个 order 此前已走
    // delegateOrder（那里有 nonce 归档）；这里按各自 nonce 再落一次终态，
    // 合成结果（深度封顶 / 依赖清扫）没有 nonce，只更新最新副本。
    for (const r of aggregated) {
      persistWorkerResult(r, undefined, this.dispatchNonces.get(r.workOrderId))
    }

    const baseRun: CoordinatorRun = {
      status: 'completed',
      results: aggregated,
      packet: await buildPrimaryWorkerPacket(aggregated, this.config.artifactStore),
      aggregationPolicy: policy,
      ...(workerModels.length > 0 ? { workerModels } : {}),
      ...(modelTierShadows.length > 0 ? { modelTierShadows } : {}),
      ...(modelTierGatedDecisions.length > 0 ? { modelTierGatedDecisions } : {}),
      ...(gatedInfluenceAudits.length > 0 ? { gatedInfluenceAudits } : {}),
    }
    return this.drainMailboxIntoRun(baseRun, batchMailbox)
    // NOTE (P1-7): this batch's abort signal and mailbox are explicit parameters
    // of runDelegationWithGlobalGate → delegateOrder, so per-order dispatch is
    // safe under true concurrent execution — no shared instance state is
    // mutated per call, hence nothing to restore here.
    } finally {
      for (const o of orders) this.policyCancelledIds.delete(o.id)
    }
  }
}
