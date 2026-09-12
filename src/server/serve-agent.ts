/**
 * Heavy agent assembly for `rivet serve` — loaded via dynamic import after the
 * HTTP listener is up (or on first session), so /health cold-start does not pay
 * for AgentLoop / tools / Meridian / council / MCP SDK graph.
 */
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDelegationActivityMapper } from '../tools/worker-activity-stream.js'
import type { DelegationActivity, DelegationIdentity } from '../tools/types.js'
import type { DelegateWorkerInput, DelegateActivityUpdate, ManagedAgent, RuntimeSessionManager } from './session-manager.js'
import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { runGateCompletion } from '../agent/gate-completion.js'
import { memoryBackfillEnabled, runMemoryBackfill } from '../memory/backfill.js'
import { restoreGoalTracker } from '../agent/goal-persist.js'
import { FileHistory } from '../agent/file-history.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
import { pluginToolsSnapshot, partitionPluginTools } from './plugin-session-cache.js'
import { AgentLoop } from '../agent/loop.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import { SessionContext } from '../agent/context.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import { createTaskLedger } from '../agent/task-ledger.js'
import { createOwnershipLedger } from '../agent/ownership-ledger.js'
import { createWorktreeBaseline } from '../agent/worktree-baseline.js'
import { captureGitBaseline, createInteractiveToolRegistry, createAgentRuntime, type RuntimeRefs } from '../bootstrap.js'
import { TodoStore } from '../tools/todo-store.js'
import { applyConfiguredPathGrants, applyDefaultDependencyReadGrants, applyRivetRuntimeReadGrants, loadPersistedGrants } from '../tools/path-grants.js'
import { loadProjectSkills } from '../skills/skill-loader.js'
import { recordSkillLoadErrors, forgetSkillLoadErrors } from './skill-load-errors.js'
import { createMemoryTool } from '../tools/memory.js'
import { DomainKnowledgeStore } from '../agent/domain-knowledge-store.js'
import type { ProviderHealthTracker } from '../agent/provider-health.js'
import { MeridianIndexer } from '../repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from '../repo/meridian-backfill.js'
import { resetLegacyMemoryIfNeeded } from '../agent/memory-epoch.js'
import { buildCockpitSnapshot } from '../tui/cockpit/state.js'
import { computeUsageCost, findModelPricing } from '../utils/pricing.js'
import { createMultiLspManager } from '../lsp/multi-manager.js'
import type { LspManager } from '../lsp/manager.js'
import { createGotoDefinitionTool, createFindReferencesTool } from '../lsp/tools.js'
import { runCouncil, runCouncilDebate, type CouncilInput } from '../agent/council/council-orchestrator.js'
import type { CouncilSeat } from '../agent/council/council-routing.js'
import { renderCouncilPlan, summarizeCouncilPlan } from '../agent/council/council-render.js'
import { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'
import { compileCouncilPlan } from '../agent/council/council-to-plan.js'
import { sealPlan } from '../agent/council/council-seal.js'
import { extractObligations, attachObligations } from '../agent/council/council-obligations.js'
import { serializeUnifiedPlan, deserializeUnifiedPlan, type UnifiedPlan } from '../agent/unified-plan.js'
import { buildCouncilSessionEvent, recordCouncilSession } from '../agent/council/council-telemetry.js'
import { persistCouncilRoutingShadow } from '../agent/council/council-routing.js'
import type { PlanItem } from '../agent/council/council-plan.js'
import type { CouncilPanelModel } from '../tui/council-panel-model.js'
import type { McpManager } from '../mcp/manager.js'
import { findProjectConfig } from '../config/manager.js'
import { isProjectTrusted, notifyUntrustedOnce } from '../config/project-trust.js'
import { proRegistry } from '../api/pro-registry.js'
import { anchorsFromMessages } from '../agent/reasoning-anchors.js'
import type { Config } from '../config/schema.js'
import { readFileSync } from 'node:fs'
import {
  type ServeContext,
  type ResolvedModelSpec,
  type HistoryRestoreInfo,
  resolveServeContext,
  resolveModelSpec,
  resolveModelSpecWithReload,
  isModelSpecUsable,
  unconfiguredSpecMessage,
  restoreHistoryMessages,
  buildDelegateSummary,
} from './serve.js'

/** Spark review profile defaults: when the sidecar detects a spark provider
 *  (deepseek-spark), these profiles are auto-populated into
 *  config.agent.review.profiles so review sub-agents run on spark-flash.
 *  Only fills omitted slots — user-configured profiles take precedence. */
const sparkReviewProfiles: Record<string, { provider: string; model: string }> = {
  reviewer: { provider: 'deepseek-spark', model: 'deepseek-v4-flash' },
  verifier: { provider: 'deepseek-spark', model: 'deepseek-v4-flash' },
  adversarial_verifier: { provider: 'deepseek-spark', model: 'deepseek-v4-flash' },
}

export interface BuiltAgent {
  agent: AgentLoop
  sessionId: string
}

/**
 * Wave J: sidecar 级共享运行时状态——跨 session + switchModel 保持，避免
 * createAgentRuntime per-call new 导致状态丢失。`runServe` 顶层创建一份，
 * 透传给每个 buildManagedAgent / assembleAgentLoop。
 *
 * 当前共享对象：
 * - providerHealth: 进程级单例，所有 session 共享 provider 健康统计
 *   （registerProvider 幂等，重复注册不重置）
 * - domainStores: cwd-keyed 缓存，同 cwd 多 session 复用同一个磁盘绑定的
 *   DomainKnowledgeStore（避免重复 load + 跨 session lessons 可见）
 * - sameCwdRunningCount: late-bound (Wave F)——RuntimeSessionManager 创建后
 *   回写。给 verificationSnapshotManager 做多 session worktree 冲突检测；
 *   修复硬编码 () => 0 假设（TUI 单 session 路径不受影响，sidecar 走真实计数）。
 *
 * 未来候选：bandit gates evaluation 结果缓存（避免 switchModel 重算）。
 */
export interface SharedRuntime {
  providerHealth: ProviderHealthTracker
  // per-cwd 资源统一用 Map<string, X> 模式（镜像 domainStores），防模式漂移。
  domainStores: Map<string, DomainKnowledgeStore>
  /** per-cwd MeridianIndexer——SQLite 单写者，同 cwd 多 session 必须共享单实例。 */
  meridianIndexers: Map<string, MeridianIndexer>
  /** per-cwd LSP 管理器——语言服务器子进程池，重复 spawn 浪费且互踩。
   *  entry.ready 是 initialize() 的完成 Promise（true=至少一个 server 可用）；
   *  每次 assembleAgentLoop 都对它订阅 .then 以捕获当次 agent（switchModel 安全）。 */
  lspManagers: Map<string, { manager: LspManager; ready: Promise<boolean> }>
  /** late-bound: 在 sessions = new RuntimeSessionManager(...) 之后由 runServe
   *  回写。值为 null 时退化为 0（sessions 尚未初始化的窗口期）。 */
  sameCwdRunningCount: ((cwd: string, excludeSessionId?: string) => number) | null
  /** Server-level MCP manager — one connection pool for all sessions. */
  mcpManager: McpManager | null
  /** I4: late-bound RuntimeSessionManager so hooks can emit `hook_result` events. */
  sessions: RuntimeSessionManager | null
}

/** sidecar 内部：按 cwd 取/建 DomainKnowledgeStore，多 session 共享同一实例。 */
function getOrCreateDomainStore(shared: SharedRuntime, cwd: string): DomainKnowledgeStore {
  const existing = shared.domainStores.get(cwd)
  if (existing) return existing
  const store = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))
  shared.domainStores.set(cwd, store)
  return store
}

/** 按 cwd 取/建 MeridianIndexer（镜像 getOrCreateDomainStore）。SQLite 单写者，
 *  同 cwd 多 session 共享同一实例；runServe close() 统一释放。exported for tests. */
export function getOrCreateMeridianIndexer(shared: SharedRuntime, cwd: string): MeridianIndexer {
  const existing = shared.meridianIndexers.get(cwd)
  if (existing) return existing
  const indexer = new MeridianIndexer(cwd)
  // Memory epoch reset（镜像 TUI bootstrapInteractiveSession）——桌面端会话
  // 首次触达某 cwd 时清空中毒的跨会话学习存量，见 memory-epoch.ts。
  try {
    resetLegacyMemoryIfNeeded(cwd, {
      clearMistakeEntries: () => indexer.getDb().clearMistakeEntries(),
    })
  } catch { /* 清理绝不阻塞会话创建 */ }
  shared.meridianIndexers.set(cwd, indexer)
  // 后台闲时全量索引（镜像 CLI bootstrap）——同 cwd 多会话共享单例，天然只跑一次。
  setImmediate(() => { scheduleMeridianBackfill(indexer, cwd, { reason: 'startup' }) })
  return indexer
}

/** 按 cwd 取/建 LSP manager entry。首个触达某 cwd 的会话触发 initialize()
 *  （异步，不阻塞会话创建）；后续会话复用同一 entry。ready resolve 为
 *  isReady()——false 表示该 cwd 没有可用的语言服务器（工具不注册）。 */
function getOrCreateLspEntry(
  shared: SharedRuntime,
  cwd: string,
): { manager: LspManager; ready: Promise<boolean> } {
  const existing = shared.lspManagers.get(cwd)
  if (existing) return existing
  const manager = createMultiLspManager(cwd)
  const ready = manager
    .initialize()
    .then(() => manager.isReady())
    .catch(() => false)
  const entry = { manager, ready }
  shared.lspManagers.set(cwd, entry)
  return entry
}

/** Wave G: LSP late-init 订阅（照 TUI bootstrap.ts initializeLsp 的 .then 语义）。
 *  设计约束（switchModel 安全性）：每次 assembleAgentLoop 调用时挂载——捕获
 *  当次的新 agent。Promise 已 resolve 时晚订阅立即触发，所以 switchModel
 *  重建的 agent 照样收到 updateTools()；重复 register 无害（ToolRegistry.register
 *  是 Map.set 幂等覆盖）。老 agent 的旧回调对废弃对象空刷一次，无害。
 *  exported for tests（注入 mock entry，不真实 spawn 语言服务器）。 */
export function attachLspTools(
  entry: { manager: LspManager; ready: Promise<boolean> },
  toolRegistry: Pick<ReturnType<typeof createDefaultToolRegistry>, 'register'>,
  refs: Pick<RuntimeRefs, 'lspManager'>,
  updateTools: () => void,
): Promise<void> {
  return entry.ready.then((ok) => {
    if (!ok) return
    toolRegistry.register(createGotoDefinitionTool(entry.manager))
    toolRegistry.register(createFindReferencesTool(entry.manager))
    refs.lspManager = entry.manager
    updateTools()
  })
}

/** Wave G: 释放 per-cwd 共享资源（runServe close()）。每个调用 try-catch
 *  包裹（防御习惯；MeridianDb.close 本身幂等，LspManager.dispose 内部已
 *  best-effort）。exported for tests. */
export function disposeSharedCwdResources(shared: SharedRuntime): void {
  for (const indexer of shared.meridianIndexers.values()) {
    try { indexer.close() } catch { /* best-effort */ }
  }
  shared.meridianIndexers.clear()
  for (const entry of shared.lspManagers.values()) {
    try { entry.manager.dispose() } catch { /* best-effort */ }
  }
  shared.lspManagers.clear()
}

/**
 * Per-session, model-independent pieces. Built once and reused across model
 * rebuilds so switchModel preserves conversation (same SessionContext) and
 * shared stores (claims/file-history/playbook/tools/ledgers).
 */
interface SessionStores {
  persist: SessionPersist
  claimStore: ReturnType<SessionPersist['createClaimStore']>
  fileHistory: FileHistory
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  session: SessionContext
  taskLedger: ReturnType<typeof createTaskLedger>
  ownershipLedger: ReturnType<typeof createOwnershipLedger>
  /** Outcome of the boot-time history restore — lets the session layer warn
   *  when the UI shows history but the model context came back empty. */
  historyRestore: HistoryRestoreInfo
  /** RuntimeRefs 在 createInteractiveToolRegistry 中被工具体内闭包持有；
 *  Wave C: assembleAgentLoop 通过 createAgentRuntime 装配 coordinator 后
 *  回写 refs.coordinator，让 5 个 coordinator 依赖工具激活。 */
  refs: RuntimeRefs
  /** deep_recall 侧路晚绑定盒：stores 构建期被 memory 工具闭包捕获，
   *  assembleAgentLoop 产出 agent 后回填（per-session，switchModel 重建覆盖）。 */
  deepRecallAgentRef?: { current?: AgentLoop }
}

/**
 * Per-session SessionStores registry, keyed by sessionId. Used by
 * resolveGoalHandles (below) so the session-manager can reach the
 * RuntimeRefs.goalTrackerRef + sessionDir for goal mode wiring — without
 * exposing the full stores surface or coupling the generic manager to the
 * serve-agent module.
 *
 * Entries are written in buildManagedAgent and overwritten on rebuild
 * (switchModel rebuilds stores' agent half on the SAME stores instance).
 * Forgetting is best-effort: a stale entry holds a modest object; rebuild
 * overwrites it. Call forgetSessionStores when a session is permanently
 * destroyed to bound memory.
 */
const sessionStoresById = new Map<string, { stores: SessionStores; cwd: string }>()

/** Late-bound goal handles for the session-manager's goal methods. Returns
 *  undefined when no stores have been built for this session yet (idle /
 *  rehydrated session whose agent hasn't been created).
 *
 *  注：`allProviders` 必须从 `config.provider.providers` 填入，否则
 *  `maybeAutoTitle` / `extractCriteria` 的 `!handles.allProviders` 守卫会恒
 *  早退——桌面 sidecar 路径的会话标题自动生成曾因此从未生效（详见
 *  commit `9835c856`）。TUI 路径在 `main.ts:366` 正确设置了此字段。 */
export function resolveGoalHandles(
  sessionId: string,
  config: {
    workers?: { profiles?: { cheap?: { provider: string; model: string } } }
    provider?: { providers?: Record<string, unknown> }
  } | undefined,
): import('./session-manager.js').GoalHandles | undefined {
  const entry = sessionStoresById.get(sessionId)
  if (!entry) return undefined
  return {
    goalTrackerRef: entry.stores.refs.goalTrackerRef,
    sessionDir: getSessionDir(entry.cwd),
    ...(config?.workers?.profiles?.cheap ? { cheapProfile: config.workers.profiles.cheap } : {}),
    ...(config?.provider?.providers ? { allProviders: config.provider.providers } : {}),
  }
}

/** Drop the stores entry for a permanently-destroyed session (memory bound). */
export function forgetSessionStores(sessionId: string): void {
  sessionStoresById.delete(sessionId)
  forgetSkillLoadErrors(sessionId)
}

/** Late-bound review-gate ref for the session-manager's getReviewGate /
 *  setReviewGate. Undefined when no stores exist yet (idle / rehydrated
 *  session whose agent hasn't been built) — the manager's session override
 *  still applies once stores are built (applySelections re-push). */
export function resolveReviewGateRef(sessionId: string): { current: 'auto' | 'off' } | undefined {
  return sessionStoresById.get(sessionId)?.stores.refs.reviewGateRef
}

/** Resolve the initial review gate state from config, gated by provider.
 *  spark (deepseek-spark) sessions read skipAutoSpark (default false = ON);
 *  standard sessions read skipAuto (default true = OFF).
 *  RIVET_REVIEW_DISCIPLINE=0 overrides both to 'off' in bootstrap
 *  (isReviewDisciplineEnabled check), so this only matters when the env
 *  override is absent. */
function resolveReviewGate(ctx: ServeContext): 'auto' | 'off' {
  const isSpark = ctx.provider.name === 'deepseek-spark'
  const flag = isSpark ? ctx.config.agent.review.skipAutoSpark : ctx.config.agent.review.skipAuto
  return flag ? 'off' : 'auto'
}

function buildSessionStores(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry?: SessionRegistry,
  shared?: SharedRuntime,
): SessionStores {
  const persist = new SessionPersist(sessionId, cwd)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore, cwd)
  for (const rule of loadProjectRules(cwd)) claimStore.propose(rule)
  // Path grants: hydrate the "remember"-persisted grants for this workspace and
  // apply standing config-declared grants (additionalReadDirs/WriteDirs). The
  // TUI does this in bootstrapInteractiveSession; without the mirror here,
  // desktop sessions silently lose every remembered/configured authorization
  // and re-block out-of-workspace paths (a major Windows papercut when the
  // project lives outside the opened folder).
  loadPersistedGrants(cwd)
  applyConfiguredPathGrants(ctx.config.agent.permissions)
  applyDefaultDependencyReadGrants()
  applyRivetRuntimeReadGrants()
  // Load skills into the shared registry (same as CLI bootstrap). Without this,
  // skillRegistry.list() returns empty and the desktop PlusMenu shows no skills.
  const skillLoad = loadProjectSkills(cwd, { importFromClaude: ctx.config.skills?.importFromClaude })
  recordSkillLoadErrors(sessionId, skillLoad.errors) // 此前丢弃；见 skill-load-errors.ts
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()
  // Restore prior conversation from disk (sidecar restart recovery).
  // Matches TUI bootstrap.ts:1461 — loadOai returns [] for new sessions.
  const historyRestore = restoreHistoryMessages(persist, session, cwd)

  // sidecar 工具装配——复用 bootstrap 的 createInteractiveToolRegistry，与 TUI 端
  // 共享一套装配链。Wave C 后所有工具（含 coordinator 依赖工具）均通过
  // refs 闭包后绑定 coordinator，assembleAgentLoop 通过 createAgentRuntime
  // 装配 coordinator 后回写 refs.coordinator，工具被激活。
  const refs: RuntimeRefs = {
    coordinator: null,
    fileHistory,
    claimStore,
    sessionId,
    sessionRegistry: registry ?? null,
    taskLedger: null,
    ownershipLedger: null,
    verificationSnapshotManager: null,
    deliveryGate: null,
    // Wave G: per-cwd 共享 Meridian——repo_graph/related_tests 惰性读 refs，
    // 但在 createInteractiveToolRegistry 之前设值（代码清晰）。legacy /prompt
    // 路径（无 shared）保持 null。
    meridianIndexer: shared ? getOrCreateMeridianIndexer(shared, cwd) : null,
    // 对称性回写：sidecar 无功能性消费者（服务器级 MCP 走 SharedRuntime），
    // 但避免 refs 硬编码 null 造成读到假状态。
    mcpManager: shared?.mcpManager ?? null,
    // Wave G: LSP 是异步 init——assembleAgentLoop 在 entry.ready 后回写。
    lspManager: null,
    banditState: null,
    promptEngine: null,
    // Wave F: 通过 SharedRuntime → RuntimeSessionManager.sameCwdRunningCount
    // 注入真实计数；shared 缺失或 manager 未就绪退化为 0（保持 TUI 兼容行为）。
    getSameCwdRunningSessions: shared
      ? () => shared.sameCwdRunningCount?.(cwd, sessionId) ?? 0
      : undefined,
    goalTrackerRef: { current: null },
    // 域知识库引用：buildAgentLoop 解析 store（SharedRuntime.domainStores 优先）
    // 后回写——galaxy 路由学习经此存取。
    domainKnowledgeStoreRef: { current: null },
    obligationTrackerRef: { current: null },
    // 会话级审查门开关：初始值取 review.skipAuto / skipAutoSpark 配置快照。
    // spark provider 默认开（skipAutoSpark=false），标准 deepseek 默认关（skipAuto=true）。
    // 用户可在桌面端 Settings 中独立控制两路。RIVET_REVIEW_DISCIPLINE=0 仍全局关闭。
    reviewGateRef: { current: resolveReviewGate(ctx) },
    // 插件 hooks/commands：sidecar 暂不加载插件（TUI bootstrap 专属装配链），
    // 保持空数组与 RuntimeRefs 契约对齐——消费方按空集处理，不影响会话。
    pluginHooks: [],
    pluginCommands: [],
    // 多会话隔离：每会话独立内存态 TodoStore，杜绝并发会话清单串台（提示词注入污染）。
    // 不做磁盘持久化（按决策），展示与跨重启恢复靠事件日志重放。
    todoStore: new TodoStore(),
  }
  // Goal mode restore — recover an in-flight goal across sidecar restarts.
  // restoreGoalTracker internally normalizes active→paused (safe downgrade)
  // so a restarted sidecar never auto-resumes a goal without user opt-in.
  // Aligns with the TUI bootstrap path (bootstrap.ts:1739-1745).
  const sessionDir = getSessionDir(cwd)
  try {
    const restored = restoreGoalTracker(sessionDir, sessionId, { maxJudgeRuns: ctx.config.agent?.goal?.judge?.maxRuns })
    if (restored) refs.goalTrackerRef.current = restored
  } catch { /* non-fatal — start without a restored goal */ }
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, ctx.config, cwd)

  // 插件工具合入（2026-09-12 补齐 sidecar 装配缺口——此前桌面会话不加载插件，
  // 是 TUI 专属装配链）：启动暖场缓存（plugin-session-cache）同步快照注册，
  // pluginHooks/pluginCommands 由空数组换真装配。暖场未完成的早期会话按无
  // 插件装配（与此前行为一致）。per-call cwd 覆盖 load-time cwd（multi-session
  // 安全，wrapPluginTool 既有设计）。
  const pluginSnap = pluginToolsSnapshot()
  if (pluginSnap) {
    // 二次冲突过滤（2026-09-12 审查）：暖场期的冲突检测基座是
    // createDefaultToolRegistry（21 个基础工具），而上面刚装配的
    // createInteractiveToolRegistry 还额外注册了 galaxy / deliver_task / 域工具等
    // ——那些名字不在基座里，插件取用即可绕过检测，随后经 register（Map.set）
    // 静默覆盖真工具。此处以真实注册表兜底，冲突项跳过并点名。
    const { accepted, blocked } = partitionPluginTools(pluginSnap.tools, new Set(toolRegistry.getAllNames()))
    if (blocked.length > 0) {
      console.warn(`[plugins] 以下插件工具与已装配工具同名，已跳过：${blocked.join(', ')}`)
    }
    for (const tool of accepted) toolRegistry.register(tool)
    for (const name of pluginSnap.suppressTools) toolRegistry.remove(name)
    refs.pluginHooks = pluginSnap.hooks
    refs.pluginCommands = pluginSnap.commands
  }

  // Spark provider: auto-populate review profiles with spark models so
  // review sub-agents (wiring inspector, verifier, squadron) run on spark-flash
  // instead of falling back to the session model. Only fills omitted profiles;
  // user-configured profiles in agent.review.profiles take precedence.
  if (ctx.provider.name === 'deepseek-spark') {
    const sparkConfig = ctx.config.agent.review
    for (const [profileName, entry] of Object.entries(sparkReviewProfiles)) {
      if (!sparkConfig.profiles[profileName]) {
        sparkConfig.profiles[profileName] = entry
      }
    }
  }

  // memory (unified recall + remember + deep_recall)：bootstrap 在 createInteractiveToolRegistry 外装的工具，
  // 这里复用 sidecar 已有的 claimStore + session 完成对齐。deep_recall 侧路通道
  // 经 deepRecallAgentRef 晚绑定到 assembleAgentLoop 产出的当次 agent（与 TUI 同构）。
  const deepRecallAgentRef: { current?: AgentLoop } = {}
  toolRegistry.register(createMemoryTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
    deepRecallComplete: async (prompt, timeoutMs) => {
      const client = deepRecallAgentRef.current?.config.compactClient
        ?? deepRecallAgentRef.current?.config.primaryClient
        ?? deepRecallAgentRef.current?.config.client
      if (!client) throw new Error('deep recall: no client')
      return runGateCompletion(client, () => {}, prompt, timeoutMs)
    },
    sessionDir,
    excludeSessionId: sessionId,
  }))

  // taskLedger / ownershipLedger 由 createInteractiveToolRegistry 的 B1 装配段
  // 原地填入 refs；fallback 仅用于装配失败时不破坏 assembleAgentLoop 的 deps。
  const taskLedger = refs.taskLedger ?? createTaskLedger({ taskId: sessionId })
  const ownershipLedger = refs.ownershipLedger ?? createOwnershipLedger({
    baseline: createWorktreeBaseline(captureGitBaseline(cwd)),
    taskLedger,
  })

  // Register MCP tools (if the server-level manager has already initialized).
  // Late-init: sessions created before MCP finishes connecting won't get MCP
  // tools, but subsequent sessions will.
  const mcpMgr = shared?.mcpManager
  if (mcpMgr) {
    const mcpTools = mcpMgr.getAllTools()
    for (const tool of mcpTools) {
      toolRegistry.register(tool)
    }
  }

  return { persist, claimStore, fileHistory, toolRegistry, session, taskLedger, ownershipLedger, refs, historyRestore, deepRecallAgentRef }
}

/**
 * 会话级全局配置基座：生产 sidecar（serve.ts 传入 specReload）经 reload 取磁盘
 * 新值——运行中经 Settings 修改的 agent.visionModel / visionAutoBridge 等会话级
 * 配置对「下一个新会话」必须生效（此前这里恒读启动快照，桌面端配识图桥不重启
 * 永远落空——视觉桥 P0 回归根因）。注入 ctx 的路径（测试/CLI）无 reload，
 * 回落启动快照保持确定性。
 */
export function resolveSessionBaseConfig(ctx: ServeContext, reload?: () => ServeContext): Config {
  return reload ? reload().config : ctx.config
}

/**
 * Merge project-level .rivet-config.json agent block into the startup config.
 * Only agent fields are merged — provider/model/auth stay on the startup snapshot
 * (the sidecar may have been started unconfigured, and the key was set later via
 * Settings). toolGating is deep-merged so project config can add extraCore without
 * clobbering the startup snapshot's other gating fields (enabled, disabledTools).
 *
 * Only reads the project config FILE (if it exists) — does NOT call loadConfig()
 * which merges user-level + defaults, which would clobber the startup snapshot
 * with unrelated user settings.
 *
 * Exported for testing. Malformed project config returns the unmodified startup
 * config.
 */
export function mergeProjectAgentConfig(
  startupConfig: Config,
  cwd: string,
): Config {
  try {
    const projectPath = findProjectConfig(cwd)
    if (!projectPath) return startupConfig
    // 信任门：agent 块含 approval/unsandboxed 等授权键——未授信项目不并入
    // （与 loadConfig Layer 3 剥离同语义；桌面端项目信任 UI 落地前的 fail-closed）。
    if (!isProjectTrusted(dirname(projectPath))) {
      notifyUntrustedOnce('config', dirname(projectPath))
      return startupConfig
    }
    const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>
    const agent = raw?.agent
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return startupConfig
    const projectAgent = agent as Record<string, unknown>
    const projectTG = projectAgent.toolGating
    const projectToolGating =
      projectTG && typeof projectTG === 'object' && !Array.isArray(projectTG)
        ? (projectTG as Record<string, unknown>)
        : undefined
    return {
      ...startupConfig,
      agent: {
        ...startupConfig.agent,
        ...projectAgent,
        ...(projectToolGating ? {
          toolGating: {
            ...startupConfig.agent?.toolGating,
            ...projectToolGating,
          },
        } : {}),
      },
    }
  } catch {
    return startupConfig
  }
}

/**
 * Assemble an AgentLoop from prebuilt session stores + a resolved model spec.
 * Reusing `stores.session` across calls is what lets switchModel hot-swap the
 * model while keeping the conversation history intact.
 *
 * Wave C: 通过 bootstrap.createAgentRuntime 装配——它会构造 DelegationCoordinator
 * 并填到 stores.refs.coordinator，激活之前注册占位的 5 个 coordinator 依赖工具
 * （delegate_task / delegate_batch / team_orchestrate / council_convene /
 * plan_task）以及 deliver_task 的审查 worker spawn 路径。与 TUI bootstrap 路径
 * 共享同一份装配逻辑，行为完全等价。
 */
function assembleAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  stores: SessionStores,
  spec: ResolvedModelSpec,
  approvalMode: ApprovalMode | undefined,
  registry?: SessionRegistry,
  shared?: SharedRuntime,
  allowedTools?: string[],
  reload?: () => ServeContext,
): AgentLoop {
  // Wave J: domainKnowledgeStore 优先从 sidecar SharedRuntime.domainStores
  // 按 cwd 取；fallback 是 per-call new（与 bootstrap 单 session 行为一致——
  // 用于 buildAgentLoop legacy /prompt 路径未传 shared 的情况）。
  const domainKnowledgeStore = shared
    ? getOrCreateDomainStore(shared, cwd)
    : new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))
  if (stores.refs.domainKnowledgeStoreRef) stores.refs.domainKnowledgeStoreRef.current = domainKnowledgeStore

  // sessionRegistry 透传：bootstrap.createAgentRuntime 通过 refs.sessionRegistry
  // 间接接到 AgentLoop，所以在调装配前先回写 refs（buildSessionStores 已经接收
  // 过 registry，但 switchModel 重建路径需要在每次调用都确保 refs 同步）。
  if (registry) stores.refs.sessionRegistry = registry

  const mergedConfig = mergeProjectAgentConfig(resolveSessionBaseConfig(ctx, reload), cwd)

  const { agent } = createAgentRuntime({
    provider: spec.provider,
    apiKey: spec.apiKey,
    auth: spec.auth,
    config: mergedConfig,
    sessionId,
    cwd,
    toolRegistry: stores.toolRegistry,
    persist: stores.persist,
    claimStore: stores.claimStore,
    fileHistory: stores.fileHistory,
    refs: stores.refs,
    domainKnowledgeStore,
    modelId: spec.model.id,
    session: stores.session,
    // Wave J: 跨 session 复用 ProviderHealthTracker，让 switchModel 不丢
    // provider 健康累积；coordinator 冷层路由有正确依据。
    sharedProviderHealth: shared?.providerHealth,
    // I4: user hook results → desktop event stream via the session manager.
    emitHookResult: (results, meta) => shared?.sessions?.emitHookResult(sessionId, results, meta),
    // Per-session 工具白名单（蒸馏回放等自动化场景）。
    allowedTools,
  })
  stores.deepRecallAgentRef!.current = agent
  // 记忆回填（opt-in：RIVET_MEMORY_BACKFILL=1）：sidecar 场景桌面端常驻、更适合
  // 闲时补采；与 TUI bootstrap 同门（30s debounce + ledger 幂等 + 每轮 ≤5 会话）。
  if (memoryBackfillEnabled()) {
    const backfillTimer = setTimeout(() => {
      const client = agent.config.compactClient ?? agent.config.primaryClient ?? agent.config.client
      if (!client) return
      void runMemoryBackfill({
        cwd,
        sessionDir: getSessionDir(cwd),
        currentSessionId: sessionId,
        complete: (prompt, timeoutMs) => runGateCompletion(client, () => {}, prompt, timeoutMs),
      }).catch(() => { /* 回填是尽力而为 */ })
    }, 30_000)
    backfillTimer.unref?.()
  }

  // approvalMode 在 createAgentRuntime 内部未接收；构造后立即覆盖
  // （setApprovalMode 直接 mutate config.approvalMode，与构造时设等价）。
  if (approvalMode) {
    agent.setApprovalMode(approvalMode)
    // 自治级别（dangerously-skip-permissions）联动无限轮次：真正全自动。
    if (approvalMode === 'dangerously-skip-permissions') {
      agent.config.maxTurns = 0
    }
  }

  // 交付门禁的影响测试覆盖检查（delivery-gate-v2.ts:330）读的是 ctx.getImpactedTests。
  // TUI 在 bootstrapInteractiveSession 里赋值，sidecar 走 createAgentRuntime 不经过那里——
  // 不补这一行，桌面端与插件的 moduleCoverage 恒为 undefined，该检查整体不执行。
  stores.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]

  // Wave G: LSP late-init——per-assemble 订阅（见 attachLspTools 的设计约束注释）。
  // 不阻塞会话创建（LSP spawn 可能秒级）。
  if (shared) {
    void attachLspTools(
      getOrCreateLspEntry(shared, cwd),
      stores.toolRegistry,
      stores.refs,
      () => agent.updateTools(),
    )
  }

  // Phase 2: 注册 coordinator 引用到 session-manager，让桌面 per-worker steer/kill 路由可达。
  // 闭包每次实时读 stores.refs.coordinator——switchModel 会替换 coordinator，闭包必须跟到新实例。
  shared?.sessions?.setCoordinatorRef(sessionId, () => stores.refs.coordinator ?? undefined)

  // 锚点补课（spec 3c 动作 B）：sidecar 重启恢复与 switchModel 重建都会新建
  // PromptEngine（锚点数组归零），而历史消息在 wire 上仍被截断——从完整历史
  // 惰性重建（与逐轮增量同粒度，并集确定性等价；append 去重保证幂等）。
  // spark 唯一发布面是桌面端，此处正是主生产路径；TUI 对应接线在
  // bootstrap.ts 的 resume 分支。非 spark / 开源构建 extractor 恒 undefined → 零行为差异。
  const priorMessages = stores.session.getMessages()
  if (priorMessages.length > 0) {
    const anchorExtractor = proRegistry.getAnchorExtractor(spec.provider.name)
    if (anchorExtractor) {
      const anchors = anchorsFromMessages(priorMessages, anchorExtractor, spec.model.id, agent.config.wireContext)
      if (anchors.length > 0) agent.config.promptEngine.appendExcludedPathAnchors(anchors)
    }
  }
  // 目标锚注入（spec 3c 动作 B 补强）：无条件注入——resume 有历史 → 从 meta
  // 或历史重建基线；首启无历史 → 初始基线 null，第一条 user 消息进入时经
  // addUserMessage 增量提取建立目标（审查 HIGH-1：注入不得放在 priorMessages
  // 块内，否则桌面端新会话目标锚永不建立）。非 spark extractor 恒 undefined
  // → 零行为差异。
  const goalExtractor = proRegistry.getGoalExtractor(spec.provider.name)
  if (goalExtractor) {
    const frozen = stores.persist.loadMetadata()?.goalAnchor
    // 历史提取结果复用（审查：不得对同一输入二次调用 extractor——
    // baseline 与写入 meta 的值必须同源，不依赖确定性才等价）
    let goalFromHistory: string | null = null
    if (frozen) {
      agent.config.promptEngine.setGoalAnchor(frozen)
    } else if (priorMessages.length > 0) {
      goalFromHistory = goalExtractor(priorMessages as never)
      if (goalFromHistory) {
        agent.config.promptEngine.setGoalAnchor(goalFromHistory)
        try { stores.persist.updateMetadata({ goalAnchor: goalFromHistory }) } catch { /* best-effort */ }
      }
    }
    // 后续 user 消息进入时增量更新（延续指令不触发；变更回调更新 engine + meta）
    // initialBaseline = frozen ?? 历史提取结果（同源复用，防初始提取覆盖）
    const baseline = frozen ?? goalFromHistory
    stores.session.setGoalTracking(
      (msgs) => goalExtractor(msgs as never),
      (next) => {
        agent.config.promptEngine.setGoalAnchor(next)
        if (next !== null) {
          try { stores.persist.updateMetadata({ goalAnchor: next }) } catch { /* best-effort */ }
        }
      },
      baseline,
    )
  }

  return agent
}

/**
 * Build a fully-wired AgentLoop for one session rooted at `cwd`. Each call gets
 * its own SessionPersist / claim store / FileHistory / PlaybookStore / tool
 * registry / PromptEngine (via createAgentConfig) and its own ArtifactStore
 * (created internally by AgentLoop, keyed by sessionId) — so concurrent
 * sessions never share prompt cache state or artifacts.
 *
 * R1: when a shared `registry` is supplied (desktop multi-session path), each
 * session also gets its own TaskLedger + OwnershipLedger and the registry is
 * threaded into AgentLoop config so file claims / OwnershipGuard / cross-session
 * conflict blocking become live. Omitting `registry` (CLI / single-session)
 * keeps the previous behavior byte-for-byte.
 */
/**
 * Resolve the initial model spec for a new session. When the server started
 * in setup mode (ctx.configured=false), the user may have since configured
 * an API key via /config routes — re-read from disk to pick it up. Falls
 * back to ctx.apiKey when the key is still unavailable.
 */
/** A resolved spec can actually authenticate when it carries either an inline
 *  API key or an OAuth provider. After a sidecar crash-restart, a provider that
 *  relies on `apiKeyEnv` whose variable is not present in the respawned process
 *  resolves to apiKey='' — running against it produces a raw upstream 401. */
function specOfContext(ctx: ServeContext): ResolvedModelSpec {
  return {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    model: { id: ctx.model.id, maxTokens: ctx.model.maxTokens, contextWindow: ctx.model.contextWindow, reasoningEffort: ctx.model.reasoningEffort, capabilities: ctx.model.capabilities },
  }
}

/**
 * Resolve the spec a new session starts on. When `reload` is provided (the
 * production sidecar path), prefer a fresh on-disk read so a key rotated via
 * desktop Settings takes effect for the next session WITHOUT a sidecar restart
 * — the startup snapshot's key may be stale or revoked. Tests that inject a
 * synthetic context pass no `reload` and keep the deterministic snapshot.
 */
function resolveInitialSpec(ctx: ServeContext, reload?: () => ServeContext): ResolvedModelSpec {
  if (reload) {
    try {
      const fresh = reload()
      if (fresh.configured) return specOfContext(fresh)
    } catch { /* mid-edit / broken config on disk — fall back to the snapshot */ }
  }
  if (ctx.configured) return specOfContext(ctx)
  // Re-read config — the user may have called POST /config/providers since startup.
  return specOfContext(resolveServeContext())
}

export function buildAgentLoop(
  ctx: ServeContext,
  cwd: string,
  sessionId: string = randomUUID(),
  registry?: SessionRegistry,
  approvalMode?: ApprovalMode,
  shared?: SharedRuntime,
  reload?: () => ServeContext,
): BuiltAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  const spec = resolveInitialSpec(ctx, reload)
  const agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared, undefined, reload)
  return { agent, sessionId }
}

/**
 * Build a ManagedAgent whose underlying AgentLoop can be hot-swapped onto a new
 * model (switchModel) without losing the conversation. The shared SessionStores
 * (including SessionContext) are built once; switchModel re-assembles only the
 * AgentLoop on a freshly resolved model spec and re-points the holder, so every
 * delegating method below transparently uses the live agent.
 */
export function buildManagedAgent(
  ctx: ServeContext,
  cwd: string,
  sessionId: string,
  registry: SessionRegistry | undefined,
  approvalMode: ApprovalMode | undefined,
  shared?: SharedRuntime,
  reload?: () => ServeContext,
  preferredModelId?: string,
  allowedTools?: string[],
): import('./session-manager.js').ManagedAgent {
  const stores = buildSessionStores(ctx, cwd, sessionId, registry, shared)
  // Register stores so the session-manager's goal methods can reach
  // refs.goalTrackerRef + sessionDir via resolveGoalHandles. Overwrites any
  // stale entry from a prior build of the same session (switchModel rebuild).
  sessionStoresById.set(sessionId, { stores, cwd })
  // Model affinity: a rehydrated session carries the model its prefix cache
  // was built on (record.model → preferredModelId). Build directly on it so a
  // resumed conversation never silently lands on the default model. Falls back
  // to the default only when the preferred id no longer resolves — resumeRun()
  // gates that case fail-closed before it ever reaches a run.
  let spec: ResolvedModelSpec =
    (preferredModelId
      ? reload
        ? resolveModelSpecWithReload(ctx, preferredModelId, reload)
        : resolveModelSpecWithReload(ctx, preferredModelId)
      : null) ?? resolveInitialSpec(ctx, reload)
  let agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, approvalMode, registry, shared, allowedTools, reload)
  // Rebuild the loop on a new spec, preserving conversation + stores. Shared
  // by switchModel and the run pre-flight self-heal below.
  const rebuildOnSpec = (next: ResolvedModelSpec) => {
    const oldCoordinator = stores.refs.coordinator
    const oldAgent = agent
    void oldAgent.cancelIdleCompaction()
    spec = next
    const liveApprovalMode = oldAgent.config.approvalMode
    agent = assembleAgentLoop(ctx, cwd, sessionId, stores, spec, liveApprovalMode, registry, shared, allowedTools, reload)
    if (oldCoordinator && oldCoordinator !== stores.refs.coordinator) {
      try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
    }
    return oldAgent
  }
  return {
    run: (prompt, callbacks, images) => {
      // Auth pre-flight: if this session's model has no usable key (e.g. an
      // apiKeyEnv provider after a sidecar restart lost its env), fail with a
      // clear, actionable message instead of sending the request and surfacing
      // an opaque upstream 401. Rejecting routes through the manager's error
      // path (append 'error' event + status=failed).
      if (!isModelSpecUsable(spec)) {
        // Self-heal first: the key may have been configured or rotated via
        // Settings AFTER this agent was built. Re-resolve the same model
        // against the live config and rebuild in place — the session then
        // just works instead of demanding a sidecar restart.
        const healed = reload ? resolveModelSpecWithReload(ctx, spec.model.id, reload) : null
        if (healed && isModelSpecUsable(healed)) {
          rebuildOnSpec(healed)
        } else {
          return Promise.reject(new Error(unconfiguredSpecMessage(spec)))
        }
      }
      return agent.run(prompt, callbacks, images)
    },
    abort: () => agent.abort(),
    setApprovalMode: (mode) => {
      agent.setApprovalMode(mode)
      // 自治联动无限轮次，非自治恢复默认 200
      agent.config.maxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
    },
    enterPlanMode: () => agent.enterPlanMode(),
    exitPlanMode: () => agent.exitPlanMode(),
    setActivePlan: (plan) => agent.setActivePlan(plan),
    listArtifacts: () => agent.artifactStore?.list() ?? [],
    readArtifact: (artifactId) => agent.artifactStore?.readRaw(artifactId) ?? Promise.resolve(null),
    getMessages: () => agent.session.getMessages(),
    getHistoryRestore: () => stores.historyRestore,
    replaceMessages: (msgs) => { agent.session.replaceMessages(msgs); agent.config.promptEngine.resetAppendixBaseline() },
    rewindToMessages: (msgs) => { agent.session.rewindToMessages(msgs); agent.config.promptEngine.resetAppendixBaseline() },
    getFileHistory: () => agent.getFileHistory(),
    // PlusMenu — star domain (delegate to the live agent).
    setSessionDomain: (domain) => agent.setSessionDomain(domain),
    resetSessionDomain: () => agent.resetSessionDomain(),
    restoreAutoResolvedDomain: (domain) => agent.restoreAutoResolvedDomain(domain),
    getSessionDomain: () => agent.getSessionDomain(),
    // PlusMenu — skills (per-session discovery filter on the live agent).
    setDisabledSkills: (names) => agent.setDisabledSkills(names),
    // PlusMenu — model hot-switch (rebuild on the same SessionContext).
    // Wave C-followup P0: createAgentRuntime 在 refs 上原地装新 coordinator/
    // providerHealth/runtimeFactory，但旧 coordinator 的 stallSweep 定时器与
    // 在途 worker AbortController 仍持有句柄。sidecar 长驻进程 + 频繁
    // switchModel 会累积泄漏。先 capture old，装新后调 shutdown 释放。
    // Wave J: 透传 shared 让 switchModel 后仍复用 providerHealth/domainStore，
    // 健康数据不丢、knowledge 不重 load。
    switchModel: (modelId) => {
      // First-install / post-startup config edits: resolve against the live
      // config, not just the startup snapshot. See resolveModelSpecWithReload.
      const next = resolveModelSpecWithReload(ctx, modelId)
      if (!next) return null
      // Audit: capture the outgoing model before the rebuild replaces it.
      // (rebuildOnSpec cancels the old loop's idle compaction — it shares this
      // SessionContext with the incoming loop — and preserves the live
      // approvalMode the user may have switched since session creation.)
      const oldAgent = rebuildOnSpec(next)
      let fromModel: string | undefined
      try { fromModel = oldAgent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }
      // 持久化切换（与 TUI bootstrap.switchAgentRuntime 同源）：metadata.model/
      // provider 反映当前模型，JSONL 落 model_switch 审计行——没有这两笔，
      // 桌面端换模型在会话日志里是隐形的。best-effort，不阻塞切换。
      // 会话侧存 provider:modelId，避免 deepseek / deepseek-spark 同 wire id 撞车
      // （resume / listModels current 才能消歧）；发给 API 的仍是 spec.model.id。
      const modelRef = `${spec.provider.name}:${spec.model.id}`
      try {
        stores.persist.updateMetadata({ model: spec.model.id, provider: spec.provider.name })
        stores.persist.appendModelSwitch({ from: fromModel, to: spec.model.id, provider: spec.provider.name })
      } catch { /* persistence is best-effort — never block a model switch */ }
      return modelRef
    },
    // Context usage display (desktop header progress bar) — real occupancy
    // (last API prompt_tokens + tail estimate), provider-agnostic.
    getEstimatedTokens: () => agent.session.getRealOccupancy(),
    getContextWindow: () => spec.model.contextWindow,
    getReasoningEffort: () => agent.getReasoningEffort(),
    // 识图桥真实状态（供桌面端准确显示，而非只看 config 有没有 visionModel 键）。
    // 依赖当前会话模型，故取活 agent 的 config 而非静态 config。
    getVisionBridge: () => agent.config.visionBridge,
    // Cockpit snapshot for the desktop cockpit panel. Assembles the full
    // runtime state (safety/verify/context/model/advisory) via the pure
    // buildCockpitSnapshot function — same source the TUI uses (main.ts:706).
    // try/catch: the agent may be mid-rebuild (switchModel) — degrade to null
    // instead of 500'ing the cockpit poll.
    getCockpitSnapshot: () => {
      try {
        const usage = agent.session.getTotalUsage()
        const pricing = findModelPricing(ctx.config.provider?.providers, spec.provider.name, spec.model.id)
        const cost = computeUsageCost(usage, pricing).total
        return buildCockpitSnapshot({
          agent,
          session: agent.session,
          model: spec.model.id,
          cacheHitRate: agent.session.getRecentTurnHitRate(3) ?? agent.session.getCacheHitRate(),
          cost,
          mcpManager: shared?.mcpManager ?? null,
          reasoningEffort: agent.getReasoningEffort(),
          // claimCounts / advisoryStatusNotices omitted — safe degradation
          // (claimCounts defaults to zero counts, statusNotices to []).
        })
      } catch {
        return null
      }
    },
    // Wave L: 进程退出释放本 session 的 coordinator timer + in-flight worker
    // 句柄。abort() 仅中止当前 turn；shutdown() 是终结性操作。
    shutdown: async () => {
      try { void agent.cancelIdleCompaction() } catch { /* best-effort */ }
      const coordinator = stores.refs.coordinator
      let settled = !coordinator
      try {
        if (coordinator?.shutdownAndWait) settled = await coordinator.shutdownAndWait()
        else if (coordinator) {
          coordinator.shutdown()
          settled = false
        }
      } catch {
        settled = false
      }
      shared?.sessions?.clearCoordinatorRef(sessionId)
      return settled
    },
    // I1: 桌面端议事会入口，直接评审 artifact 中的 council-plan-json。
    conveneCouncil: (input) => conveneCouncilOnCoordinator(agent, stores.refs.coordinator, stores.refs, input),
    // 用户主动派后台子代理：独立 AbortSignal，跑在隔离子会话，不碰主历史。
    delegateWorker: (input, opts) => delegateWorkerOnCoordinator(stores.refs.coordinator, input, opts),
    // P0-2: plan_task 成功后 onToolResult 通过此方法读取 TodoStore 发 todo_state SSE
    getTodos: () => stores.refs.todoStore.read(),
    // Hot-inject MCP tools discovered after this agent was built (mid-session
    // connector enable). register is Map.set-idempotent; updateTools refreshes
    // the prompt tool list the same way attachLspTools does for LSP tools.
    registerExternalTools: (tools) => {
      for (const tool of tools) {
        stores.toolRegistry.register(tool)
      }
      agent.updateTools()
    },
  }
}

class CouncilError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message)
    this.name = 'CouncilError'
  }
}

/**
 * I1: 在指定 session 上召集议事会。输入 artifactId 必须指向一个包含
 * ```council-plan-json 代码块的可执行计划；后端从 raw 中提取 UnifiedPlan
 * 作为 draftItems。并发安全：agent 正在跑 turn 时直接拒绝。
 */
async function conveneCouncilOnCoordinator(
  agent: AgentLoop,
  coordinator: import('../agent/coordinator.js').DelegationCoordinator | null,
  refs: RuntimeRefs,
  input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  },
): Promise<{ planMarkdown: string; artifactId: string; councilPanel?: CouncilPanelModel }> {
  if (agent.isRunning()) {
    throw new CouncilError('Session is already running a turn', 409)
  }
  if (!coordinator) {
    throw new Error('DelegationCoordinator not initialized')
  }
  const raw = await agent.artifactStore?.readRaw(input.artifactId)
  if (!raw) {
    throw new CouncilError('Artifact not found', 404)
  }
  const planJson = extractCouncilPlanJson(raw)
  if (!planJson) {
    throw new CouncilError('Artifact does not contain a valid council-plan-json block', 400)
  }
  const draftItems: PlanItem[] = planJson.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.objective,
    files: t.files,
  }))
  const seats: CouncilSeat[] = input.seats && input.seats.length > 0
    ? input.seats.map((s) => ({ authority: s.authority, ...(s.charter ? { charter: s.charter } : {}) }))
    : [...DEFAULT_COUNCIL_SEATS]
  const abortController = new AbortController()
  const councilInput: CouncilInput = {
    draft: { objective: input.objective ?? planJson.objective, items: draftItems },
    seats,
    abortSignal: abortController.signal,
    ...(typeof input.rounds === 'number' ? { maxRounds: input.rounds } : {}),
  }
  const now = Date.now()
  const deps = {
    delegateBatch: async (
      requests: import('../agent/council/council-orchestrator.js').CouncilFanoutRequest[],
      policy: 'all_required',
      signal?: AbortSignal,
      onProgress?: (completed: number, total: number) => void,
    ) => {
      const delegationReqs: import('../agent/coordinator.js').DelegationRequest[] = requests.map((r) => ({
        parentTurnId: r.parentTurnId,
        objective: r.objective,
        kind: r.kind,
        profile: r.profile,
        scope: r.scope,
        // 席位路由字段透传：曾在此处丢弃，桌面路由的异构席/瑶光门失效。
        authority: r.authority,
        ...(r.modelOverride ? { modelOverride: r.modelOverride } : {}),
        ...(r.tierFloor ? { tierFloor: r.tierFloor } : {}),
      }))
      const run = await coordinator.delegateBatch(
        delegationReqs,
        policy,
        signal,
        onProgress,
      )
      return { results: run.results, workerModels: run.workerModels }
    },
    now: () => now,
    sessionId: refs.sessionId ?? 'unknown',
    recordRoutingShadow: (event: import('../agent/council/council-routing.js').CouncilRoutingShadowEvent) => persistCouncilRoutingShadow(refs.meridianIndexer?.getDb(), event),
  }
  const runner = councilInput.maxRounds && councilInput.maxRounds >= 2 ? runCouncilDebate : runCouncil
  const plan = await runner(councilInput, deps)
  const planMarkdown = renderCouncilPlan(plan)
  // Da'at 编译门（与 council_convene 工具同款）：否决态不嵌可执行 planJson。
  const compiled = plan.aggregate.mergedItems.length > 0 ? compileCouncilPlan(plan) : undefined
  const sealed = compiled?.ok && compiled.plan
    ? sealPlan(attachObligations(compiled.plan, extractObligations(plan)))
    : undefined
  const outputRaw = sealed
    ? [planMarkdown, '', '```council-plan-json', serializeUnifiedPlan(sealed), '```'].join('\n')
    : compiled && !compiled.ok
      ? [planMarkdown, '', '## ⛔ 议事会否决（blocking challenge 未化解）', ...compiled.vetoes.map(v => `- ${v.description}: ${v.left}`)].join('\n')
      : planMarkdown
  const savedArtifactId = await agent.artifactStore?.save({
    tool: 'council_convene',
    target: `council:${plan.meta.objectiveHash}`,
    rawContent: outputRaw,
    summary: summarizeCouncilPlan(plan),
    sections: [],
  })
  try {
    // 复用 buildCouncilSessionEvent（与 council_convene 工具同一构造器），
    // 避免手工展开字段随 schema 演进漂移（Phase 2 新增分歧度指标即此教训）。
    recordCouncilSession(refs.meridianIndexer?.getDb(), buildCouncilSessionEvent({
      sessionId: refs.sessionId ?? 'unknown',
      plan,
      timestamp: Date.now(),
    }))
  } catch {
    // 遥测失败不影响交付
  }
  if (!savedArtifactId) {
    throw new Error('Failed to save council plan artifact')
  }
  const councilPanel: CouncilPanelModel = {
    schemaVersion: 1,
    objective: plan.objective,
    seats: plan.contributions.map(c => ({
      authority: c.authority,
      status: 'passed',
      round: c.round ?? 1,
      modelUsed: c.modelUsed,
    })),
    verdict: {
      accepted: plan.aggregate.decisions.filter(d => d.verdict === 'accepted').length,
      rejected: plan.aggregate.decisions.filter(d => d.verdict === 'rejected').length,
      deferred: plan.aggregate.decisions.filter(d => d.verdict === 'deferred').length,
      conflicts: plan.aggregate.conflicts.length,
    },
    sealVersion: sealed?.seal?.version,
    pillarsMode: false,
    failedSeats: plan.meta.failedSeats,
    qliphothCount: plan.meta.qliphoth?.length,
  }
  return { planMarkdown, artifactId: savedArtifactId, councilPanel }
}

function extractCouncilPlanJson(raw: string): UnifiedPlan | null {
  const match = raw.match(/```council-plan-json\n([\s\S]*?)\n```/)
  if (!match) return null
  return deserializeUnifiedPlan(match[1]!)
}

/** Map a friendly profile to a work-order kind so patch/review/verify workers
 *  get the right execution mode (mirrors delegate_task's kind semantics). */
function kindForProfile(profile: string): import('../agent/coordinator.js').DelegationRequest['kind'] {
  switch (profile) {
    case 'patcher': return 'patch_proposal'
    case 'reviewer': return 'review'
    case 'verifier':
    case 'adversarial_verifier': return 'verify'
    case 'planner':
    case 'perspective_planner': return 'plan'
    case 'doc_scout': return 'doc_research'
    default: return 'code_search'
  }
}

/** Build the terminal digest shown in the panel + adopted into the composer by
 *  the "汇入主会话" button. Markdown: objective + outcome + changed files +
 *  worker summary (truncated). Pure — easy to unit test. */
/** User-dispatched background subagent runner. Mirrors delegate_task's request
 *  shaping but bridges activity to a plain callback (no tool pipeline) and
 *  produces a terminal summary for the adopt-to-composer flow. */
async function delegateWorkerOnCoordinator(
  coordinator: import('../agent/coordinator.js').DelegationCoordinator | null,
  input: DelegateWorkerInput,
  opts: { workerId: string; signal: AbortSignal; onActivity: (a: DelegateActivityUpdate) => void },
): Promise<void> {
  if (!coordinator) throw new Error('DelegationCoordinator not initialized')
  const profile = input.profile && input.profile.trim() ? input.profile.trim() : 'code_scout'
  const activityMapper = createDelegationActivityMapper(opts.workerId, (a) => {
    opts.onActivity({
      workOrderId: opts.workerId,
      parentToolId: a.parentToolId,
      ...(a.dispatchId ? { dispatchId: a.dispatchId } : {}),
      ...(a.attemptId ? { attemptId: a.attemptId } : {}),
      ...(a.parentAttemptId ? { parentAttemptId: a.parentAttemptId } : {}),
      profile: a.profile ?? profile,
      authority: a.authority,
      status: a.status,
      progressLine: a.progressLine,
      toolUseCount: a.toolUseCount,
      tokenCount: a.tokenCount,
      eventKind: a.eventKind,
      eventDetail: a.eventDetail,
      contract: a.contract,
    })
  })
  const request: import('../agent/coordinator.js').DelegationRequest = {
    // Use the manager-owned workerId as the stable node key (parentTurnId derives
    // the work order id), so every activity update merges into the same panel node.
    parentTurnId: opts.workerId,
    objective: input.objective,
    kind: kindForProfile(profile),
    profile: profile as import('../agent/work-order.js').WorkerProfile,
    scope: input.files && input.files.length ? { files: input.files } : {},
    delegationDepth: 0,
    // Reuse the shared mapper so user-dispatched workers get the same live
    // counters (toolUseCount/tokenCount) and eventKind/eventDetail passthrough
    // as agent-initiated delegations.
    onActivity: activityMapper,
  }
  if (input.authority) request.authority = input.authority
  if (input.resume) request.resumeWorkOrderId = input.resume
  try {
    const run = await coordinator.delegate(request, opts.signal)
    const result = run.results[0]
    if (result) {
      const identity = result as typeof result & DelegationIdentity
      const terminal: DelegationActivity = {
        workOrderId: result.workOrderId,
        parentToolId: opts.workerId,
        ...(identity.dispatchId ? { dispatchId: identity.dispatchId } : {}),
        ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
        ...(identity.parentAttemptId ? { parentAttemptId: identity.parentAttemptId } : {}),
        profile,
        status: result.status === 'passed' ? 'completed' : result.status,
        progressLine: result.summary ? result.summary.slice(0, 120) : undefined,
        failureReason: result.failureReason,
        summary: buildDelegateSummary(input, run),
        changedFiles: result.changedFiles.length > 0 ? result.changedFiles : undefined,
        artifactId: result.diffArtifactId,
        model: run.selectedModel ?? result.model,
        provider: result.provider,
        usage: result.usage,
        // 终态证据摘要（与 delegate_task 的 emitTerminal 对齐）。
        findingsCount: result.findings.length > 0 ? result.findings.length : undefined,
        topFinding: result.findings[0]?.claim,
        verificationBrief: result.verification
          ? { status: result.verification.status, passed: result.verification.passed, failed: result.verification.failed }
          : undefined,
        evidenceStatus: result.evidenceStatus,
      }
      activityMapper.finish(terminal)
    } else {
      activityMapper.finish({
        workOrderId: opts.workerId,
        parentToolId: opts.workerId,
        profile,
        status: run.status === 'skipped' ? 'blocked' : 'completed',
        summary: buildDelegateSummary(input, run),
      })
    }
  } finally {
    activityMapper.dispose()
  }
}
