/**
 * bootstrap.ts — 共享初始化层，由 T9 ANSI 唯一生产入口 src/main.ts 调用。
 *
 * 纯异步函数，零 React 依赖。历史上同时服务过已退役的 Ink 入口
 * （main.tsx，已从仓库移除）与 main-ansi.ts；现仅 src/main.ts 使用。
 *
 * 架构：
 *   bootstrapInteractiveSession() → BootstrapContext
 *   └── src/main.ts 直接 await 调用，连接 AgentLoop 到 TuiApp（engine/app.ts）
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { randomUUID, createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'fs'
import { spawn } from 'child_process'
import { spawnGitSync } from './tools/spawn-git.js'

import type { Config, ProviderConfig } from './config/schema.js'
import type { AuthProvider } from './auth/types.js'
import type { BaselineSnapshot } from './agent/worktree-baseline.js'
import { buildModelCards } from './model/capability.js'
import type { ModelCapabilityCard } from './model/capability.js'

import { loadConfig as loadLayeredConfig } from './config/manager.js'
import { isRuntimeLeanAspect } from './config/runtime-lean.js'
import { isProFeatureEnabled } from './config/pro-license.js'
import { lastSessionPointerDir, rivetHome, stateDir } from './config/paths.js'
import { setTargetConventions, applyConfiguredGitBashPath } from './platform.js'
import { AgentLoop } from './agent/loop.js'
import { createAgentConfig, createMainAgentConfigInput } from './agent/create-agent-config.js'
import { SessionContext } from './agent/context.js'
import { SessionPersist, evictOldSessions, getSessionDir } from './agent/session-persist.js'
import { runGateCompletion } from './agent/gate-completion.js'
import { memoryBackfillEnabled, runMemoryBackfill } from './memory/backfill.js'
import { migrateSessionFiles } from './agent/session-cd.js'
import { decideStartupSession, RESUME_FRESHNESS_MS } from './agent/session-recovery.js'
import { runResumePreflightOai } from './context/resume-preflight.js'
import {
  createWriteEvidenceProbe,
  findRecentUnrecordedWrites,
  formatDiskReconciliationNote,
  shouldReconcileDisk,
} from './context/write-evidence-probe.js'
import { FileHistory } from './agent/file-history.js'
import { PromptEngine } from './prompt/engine.js'
import { subagentPromptBlocks } from './prompt/block-policy.js'
import { applyDescriptionMode } from './tools/description-compact.js'
import { createDefaultToolRegistry } from './tools/default-registry.js'
import { presetIncludes, resolveToolPreset } from './tools/tool-preset.js'
import { BROWSER_DEBUG_TOOL } from './tools/browser-debug/tool.js'
import { defaultStore as defaultTodoStore } from './tools/todo.js'
import { TodoStore } from './tools/todo-store.js'
import { createCoordinatorDelegateAdapter, createDelegateTaskTool } from './tools/delegate-task.js'
import { createUndoTool } from './tools/undo.js'
import { maybeWarnNoSandbox, applySandboxPolicyForApprovalMode, applyUnsandboxedEnvDefault } from './tools/sandbox-profile.js'
import { applyConfiguredPathGrants, applyDefaultDependencyReadGrants, applyRivetRuntimeReadGrants, loadPersistedGrants } from './tools/path-grants.js'
import { createCoordinatorBatchDelegateAdapter, createDelegateBatchTool } from './tools/delegate-batch.js'
import { createGalaxyTool } from './tools/galaxy.js'
import { createStarflowTool } from './tools/starflow.js'
import { createTeamOrchestrateTool } from './tools/team-orchestrate.js'
import type { PlanExecutorDeps } from './agent/plan-executor.js'
import { runTypeCheck } from './lsp/client.js'
import { GATE_TSC_TIMEOUT_MS } from './agent/typecheck-gate.js'
import { createCouncilConveneTool, type CouncilConveneCoordinator } from './tools/council-convene.js'
import { needsTemplatesInit } from './bootstrap/project-templates.js'
import { debugLog } from './utils/debug.js'
import { persistCouncilRoutingShadow } from './agent/council/council-routing.js'
import { recordCouncilSession } from './agent/council/council-telemetry.js'
import { createRecallCapsuleTool } from './tools/recall-capsule.js'
import { createRecallGeneralTool } from './tools/recall-general.js'
import { createRecordGeneralFindingTool } from './tools/record-general-finding.js'
import { createDeliverTaskTool } from './agent/deliver-task.js'
import { createUpdateGoalTool } from './tools/update-goal.js'
import { createTaskLedger } from './agent/task-ledger.js'
import { createOwnershipLedger } from './agent/ownership-ledger.js'
import { createVerificationAttribution } from './agent/verification-attribution.js'
import { createDeliveryGateV2 } from './agent/delivery-gate-v2.js'
import { createWorktreeBaseline } from './agent/worktree-baseline.js'
import { createVerificationSnapshotManager, reapOrphanSnapshots, reapOrphanHandsWorktrees } from './agent/verification-snapshot-manager.js'
import { cleanupStaleHandsBranches } from './agent/worktree.js'
import { initializePlugins } from './plugins/plugin-loader.js'
import { loadProModule, proRegistry } from './api/pro-registry.js'
import { anchorsFromMessages } from './agent/reasoning-anchors.js'
import { createProviderClient, resolveApiKey } from './api/factory.js'
import { buildReviewOverrideState } from './agent/review-model-override.js'
import { buildWorkerRuntime } from './agent/worker-runtime.js'
import { createModeAwareRunner, workerIsolationEnabled, workerIsolationMode } from './agent/worker-process/parent.js'
import type { ResolvedReviewOverride } from './agent/review-model-override.js'
import { createAuthProvider } from './auth/registry.js'
import { resolveCapabilities } from './api/provider.js'
import { DelegationCoordinator } from './agent/coordinator.js'
import { ProviderHealthTracker } from './agent/provider-health.js'
import { effectiveBanditMode, resolveBanditPromotion } from './agent/bandit-promotion.js'
import { DomainKnowledgeStore } from './agent/domain-knowledge-store.js'
import { emptyObligationStore } from './agent/evidence-obligation.js'
import { resolvePlanConstraints } from './agent/plan-constraints.js'
import { profileRegistry } from './agent/profile-registry.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import type { WorkerRuntimeFactory } from './agent/coordinator.js'
import { mapWorkOrderKindToCapabilityTask } from './agent/work-order.js'
import { PlaybookStore } from './agent/playbook-store.js'
import { resetLegacyMemoryIfNeeded } from './agent/memory-epoch.js'
import { ASK_USER_QUESTION_TOOL } from './tools/ask-user-question.js'
import { createRepoGraphTool } from './tools/repo-graph.js'
import { createRelatedTestsTool } from './tools/related-tests.js'
import { SEMANTIC_SEARCH_TOOL } from './tools/semantic-search.js'
import { buildSearchBackends } from './tools/web-search.js'
import { buildFetchOptions } from './tools/web-fetch/build-options.js'
import { APPLY_PATCH_TOOL } from './tools/apply-patch.js'
import { createSessionVitalsTool } from './tools/session-vitals.js'
import { createAttackCaseTool } from './tools/attack-case.js'
import { createPlanTaskTool } from './tools/plan-task.js'
import { createMemoryTool } from './tools/memory.js'
import { MeridianIndexer } from './repo/meridian-indexer.js'
import { scheduleMeridianBackfill } from './repo/meridian-backfill.js'
import { detectProjectFingerprint } from './repo/project-fingerprint.js'
import { loadProjectRules } from './context/rules-loader.js'
import { loadProjectSkills } from './skills/skill-loader.js'
import { killAllSync } from './tools/process-tracker.js'
import { persistFileHistory } from './agent/file-history-persist.js'
import { cleanupOrphanedTmpFiles } from './fs-atomic.js'
import { cleanupOldArtifactSessions } from './artifact/store.js'
import { createLspManager } from './lsp/manager.js'
import { createMultiLspManager } from './lsp/multi-manager.js'
import { availableServers } from './lsp/server-registry.js'
import { createGotoDefinitionTool, createFindReferencesTool } from './lsp/tools.js'
import { createCoordinatorReviewDeps } from './agent/review-coordinator-deps.js'
import { persistTeamWaveTelemetry, type TeamWaveTelemetry } from './agent/team-wave-telemetry.js'
import { buildTeamSchedulerRewardEvent, persistTeamSchedulerReward, persistTeamSchedulerShadow, type TeamSchedulerShadowEvent } from './agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './agent/gated-influence-audit.js'
import { computeTeamWaveReward, deriveTeamWaveRewardInput } from './agent/team-reward.js'
import { teamSchedulerArmForParallelism } from './agent/team-scheduler-bandit.js'
import { recordTeamWaveRewardClosure } from './agent/reward-loop.js'
import type { TuiPerfSummary } from './tui/engine/perf-monitor.js'

// ── Types ──────────────────────────────────────────────────────

/** 运行时可变引用 — 替代 main.tsx 中的 module-level _xxxRef 全局变量 */
export interface RuntimeRefs {
  coordinator: DelegationCoordinator | null
  fileHistory: FileHistory | null
  claimStore: import('./context/claim-store.js').ContextClaimStore | null
  sessionId: string | null
  sessionRegistry: import('./agent/session-registry.js').SessionRegistry | null
  taskLedger: import('./agent/task-ledger.js').TaskLedger | null
  ownershipLedger: import('./agent/ownership-ledger.js').OwnershipLedger | null
  /** VSW: session-scoped snapshot manager (in-place by default per §6 policy). */
  verificationSnapshotManager: import('./agent/verification-snapshot-manager.js').VerificationSnapshotManager | null
  /** Track 3: 权威交付门禁（v2）— badge 与收敛检测共用。 */
  deliveryGate: import('./agent/delivery-gate-v2.js').DeliveryGateV2 | null
  meridianIndexer: MeridianIndexer | null
  mcpManager: any | null
  lspManager: ReturnType<typeof createLspManager> | null
  /** T5: bandit promotion state for /status observability. */
  banditState: import('./server/routes.js').BanditStatusEntry[] | null
  /** Prompt engine ref for depth-layer queries at deliver-task time. */
  promptEngine: import('./prompt/engine.js').PromptEngine | null
  /**
   * Wave F: 当前 cwd 下其他活跃 session 数（不含自己）。给
   * verificationSnapshotManager 做多 session worktree 冲突检测。
   *
   * TUI 单 session 路径不设置，createInteractiveToolRegistry 回退到 `() => 0`
   * 保持原行为。sidecar 多 session 路径通过 SharedRuntime → manager.sameCwdRunningCount
   * 接入真实计数，让 VSW snapshot 决策（in-place vs worktree）真实可用。
   */
  getSameCwdRunningSessions?: () => number
  /** Mutable ref to the current GoalTracker. Set by slash-commands /goal,
   *  read by deliver_task B1Context for auto-review gating. */
  goalTrackerRef: { current: import('./agent/goal-tracker.js').GoalTracker | null }
  /** 域知识库可变引用（galaxy 路由学习收编 #5 的存取口）：注册工具时经
   *  getter 惰性读取，/cd 切换 cwd 后由 switchAgentCwd 更新指向新 store。 */
  domainKnowledgeStoreRef?: { current: DomainKnowledgeStore | null }
  /** 证据义务追踪器可变引用（收编 #2 的生产链）：createAgentRuntime 在 agent
   *  构建后回写；deliver_task 读 store 做门禁，galaxy DP 创建/满足冗余义务。 */
  obligationTrackerRef?: { current: import('./agent/obligation-tracker.js').ObligationTracker | null }
  /** 证据防火墙 Phase 2：claim tracker getter 可变引用——createAgentRuntime 回写；
   *  deliver_task 门禁经闭包惰性读取。 */
  claimTrackerRef?: { current: (() => import('./agent/hooks/external-claim-tracking-hook.js').ClaimTracker) | null }
  /** 会话级审查门开关：TUI /review off|on 写入，deliver_task B1Context 经
   *  isAutoReviewOff 读取。初始值取 review.skipAuto 配置（配置成为会话默认）。 */
  reviewGateRef: { current: 'auto' | 'off' }
  /** Plugin-contributed hooks (absolute script paths). initializePlugins fills
   *  this; the user-hooks bridge reads it at fire time so plugin hooks are
   *  picked up even though plugins load after agent assembly. */
  pluginHooks: import('./plugins/plugin-loader.js').PluginHookEntry[]
  /** Plugin-contributed slash commands (absolute .md paths). Same lazy-binding
   *  pattern as pluginHooks — read by resolveCustomCommand at input time. */
  pluginCommands: import('./plugins/plugin-loader.js').PluginCommandEntry[]
  /** 层3 回归契约：当前主控任务契约 getter（agent 创建后回填）。
   *  deliver_task 用它取 regressionInventory / objective 做重构回归核验。 */
  getTaskContract?: () => import('./context/task-contract.js').TaskContract | undefined
  /** W1 回归防线：EvidenceTracker.impactedTests getter（agent 创建后回填）。
   *  deliver_task 用它做改动波及测试的验证归因（module_unverified）。 */
  getImpactedTests?: () => string[]
  /** W5 清醒认知闭环：session_vitals 数据源（agent 创建后回填）。
   *  模型写"系统状态"类结论前的取证入口，全部运行时内存态实测。 */
  getSessionVitals?: () => import('./tools/session-vitals.js').SessionVitalsData
  /** PAL 攻坚层：会话级案件容器（agent 创建后回填）。attack_case 工具经此
   *  与 problem-attack-hook 共享同一 store。 */
  getProblemAttackStore?: () => import('./agent/problem-attack-loop.js').ProblemAttackStore
  /** H2 证据验真器（agent 创建后回填）：对 recentToolHistory / ObligationStore
   *  验真 evidence_ref，不建第二套注册表。 */
  getAttackEvidenceVerifier?: () => import('./tools/attack-case.js').AttackEvidenceVerifier
  /** 多会话隔离：本会话独立的 todo 清单 store。后端所有读/写（todo 工具、plan_task
   *  回灌、turn-end 任务进度注入、todo-reminder 快照）统一走它。TUI 复用全局
   *  defaultStore（保持 setTodoSession/loadTodos 持久化与会话切换语义），server 每会话 new。
   *  缓存不变量：会话生命周期内复用同一实例，loop 重建时随 refs 复用，不可重 new。 */
  todoStore: TodoStore
}

/** bootstrapInteractiveSession 的聚合返回值 */
export interface BootstrapContext {
  config: Config
  provider: ProviderConfig
  apiKey: string
  auth: AuthProvider | undefined
  sessionId: string
  session: SessionContext
  persist: SessionPersist
  claimStore: import('./context/claim-store.js').ContextClaimStore
  fileHistory: FileHistory
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  agent: AgentLoop
  refs: RuntimeRefs
  domainKnowledgeStore: DomainKnowledgeStore
  meridianIndexer: MeridianIndexer
  cwd: string
  shutdown: () => Promise<void>
  /** Persist the final TUI perf summary through the existing telemetry writer. */
  flushTuiPerfSummary: (summary: TuiPerfSummary) => Promise<void>
  heartbeatInterval: ReturnType<typeof setInterval>
  /** True when first-run template init is pending — TUI layer handles the
   *  AGENTS.md prompt. Set by needsTemplatesInit() during bootstrap. */
  templatesPendingAgents?: boolean
  /** 资源压力状态行 sink——TUI 层在创建 TuiApp 后回填（agent 早于 TUI 创建，
   *  agent 的 onStatusLine 经闭包晚绑定读此字段）。缺省 undefined（sidecar/
   *  worker 无 TUI）时 agent 侧回调为 no-op。 */
  setStatusLine?: (text: string | null) => void
}

// ── HTTP Proxy ─────────────────────────────────────────────────

let _proxySetup = false

export function setupHttpProxy(): void {
  if (_proxySetup) return
  _proxySetup = true
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent())
  }
}

// ── Config ─────────────────────────────────────────────────────

function approvalOverlayFromArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.includes('--dangerously-skip-permissions') || args.includes('--dangerously-skip-approvals')) {
    return { agent: { approval: 'dangerously-skip-permissions' } }
  }
  const modeIndex = args.indexOf('--approval-mode')
  if (modeIndex >= 0) {
    const mode = args[modeIndex + 1]
    if (!mode) {
      console.error('--approval-mode requires a value')
      process.exit(2)
    }
    return { agent: { approval: mode } }
  }
  return undefined
}

export function loadRivetConfig(cwd?: string, args: string[] = process.argv.slice(2)): Config {
  return loadLayeredConfig({ cwd, sessionOverlay: approvalOverlayFromArgs(args) })
}

// ── Provider + Auth ────────────────────────────────────────────

export function resolveProviderAndAuth(
  config: Config,
  providerName?: string,
  opts?: { allowMissingKey?: boolean },
): { provider: ProviderConfig; apiKey: string; auth: AuthProvider | undefined } {
  const name = providerName ?? config.provider.default
  const provider = config.provider.providers[name]
  if (!provider) {
    console.error(`Provider "${name}" not configured. Available: ${Object.keys(config.provider.providers).join(', ')}`)
    process.exit(1)
  }

  if (provider.auth?.type === 'oauth') {
    const auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
    return { provider, apiKey: '', auth }
  }

  // 降级模式（allowMissingKey）：无 key 不抛错，返回空 apiKey。
  // 用于首启跳过 wizard 的场景——让 TUI 先起来，发消息时报错指引配 key，
  // 与桌面端「先进界面再提醒」体验对齐。OAuth 模式天然走空 apiKey，此处对齐。
  if (opts?.allowMissingKey) {
    try {
      const apiKey = resolveApiKey(provider)
      return { provider, apiKey, auth: undefined }
    } catch {
      return { provider, apiKey: '', auth: undefined }
    }
  }

  const apiKey = resolveApiKey(provider)
  return { provider, apiKey, auth: undefined }
}

// ── Git Baseline ───────────────────────────────────────────────

export function captureGitBaseline(cwd: string): BaselineSnapshot {
  try {
    const branch = spawnGitSync(['-c', 'core.quotePath=false', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const head = spawnGitSync(['-c', 'core.quotePath=false', 'rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const dirty = spawnGitSync(['-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    const untracked = spawnGitSync(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf-8', timeout: 5000 }).stdout.trim()
    return {
      branch,
      head,
      preExistingDirty: dirty ? dirty.split(/\r?\n/) : [],
      preExistingUntracked: untracked ? untracked.split(/\r?\n/) : [],
      capturedAt: Date.now(),
    }
  } catch {
    return { branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() }
  }
}

// ── Session ID ─────────────────────────────────────────────────

let _cachedSessionId: string | null = null
let _sessionWasResumed = false

/** True when the active session id was explicitly resumed (--continue / --resume [id]). */
export function wasSessionResumed(): boolean {
  return _sessionWasResumed
}

/** Per-cwd last-session pointer file (so `--continue` returns *this* project's
 *  session, never another project's). Hashed cwd mirrors the memory-store
 *  convention (sha256(cwd).slice(0,12)). */
function lastSessionPointerFile(cwd: string): string {
  const dir = lastSessionPointerDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(dir, `${hash}.txt`)
}

/**
 * Resolve the session id for this run. Default is a FRESH session — there is NO
 * implicit/crash auto-resume. We only return to a previous session when the
 * user explicitly asks:
 *   - RIVET_RESUME_ID=<full-id>  → resume that specific session (highest prio)
 *   - RIVET_RESUME=1             → resume the most recent session for this cwd
 * See `decideStartupSession` for the full contract. Resuming reuses the existing
 * startup path (`persist.loadOai()` + `replaceMessages()`) to rehydrate — the
 * resumed id becomes this run's session id = log id = pointer id.
 *
 * Escape hatches: RIVET_NEW_SESSION=1 forces fresh; RIVET_NO_AUTO_RESUME=1 is a
 * no-op for default startup (kept for back-compat) since fresh is already default.
 */
export function getOrCreateSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId
  const cwd = process.cwd()
  const dir = rivetHome()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const pointerFile = lastSessionPointerFile(cwd)
  let lastSessionId: string | null = null
  try {
    if (existsSync(pointerFile)) lastSessionId = readFileSync(pointerFile, 'utf-8').trim() || null
  } catch { /* ignore */ }
  // One-time compatibility fallback to the legacy global pointer. The cwd gate
  // in decideStartupSession rejects it if it belongs to a different project.
  if (!lastSessionId) {
    try {
      const legacy = join(dir, 'session-id.txt')
      if (existsSync(legacy)) lastSessionId = readFileSync(legacy, 'utf-8').trim() || null
    } catch { /* ignore */ }
  }

  const decision = decideStartupSession({
    lastSessionId,
    now: Date.now(),
    freshnessMs: RESUME_FRESHNESS_MS,
    forceNew: process.env.RIVET_NEW_SESSION === '1',
    resume: process.env.RIVET_RESUME === '1',
    resumeSessionId: process.env.RIVET_RESUME_ID || undefined,
    disableAutoResume: process.env.RIVET_NO_AUTO_RESUME === '1',
    currentCwd: cwd,
    load: (id) => {
      try {
        const persist = new SessionPersist(id, cwd)
        const meta = persist.loadMetadata()
        return {
          hasContent: persist.loadOai().length > 0,
          status: meta?.status,
          updatedAt: meta?.updatedAt,
          cwd: meta?.cwd,
          cleanExit: meta?.cleanExit,
        }
      } catch {
        return null
      }
    },
  })

  const id = decision.sessionId ?? randomUUID()
  _sessionWasResumed = decision.resumed
  try { writeFileSync(pointerFile, id) } catch { /* ignore */ }
  _cachedSessionId = id
  return id
}

/**
 * Clean up stale worker session directories under ~/.rivet/sessions/<slug>/.
 * Worker sessions (worker-*) create per-session dirs here (pheromones.json,
 * sensorium.jsonl). Removes worker dirs older than STALE_THRESHOLD_MS to
 * avoid deleting dirs that might still be in use by a concurrent worker.
 */
export const WORKER_DIR_STALE_THRESHOLD_MS = 3_600_000 // 1 hour
/** worker 文件（jsonl/meta 等）保留窗口：排查资产（查 worker 模型/对话），
 *  价值随时间快速衰减；7 天后清退。目录阈值(1h)不适用——目录是遥测/信息素
 *  临时物，文件是事后排查凭据。 */
export const WORKER_FILE_STALE_THRESHOLD_MS = 7 * 24 * 3_600_000 // 7 days

export function cleanupStaleWorkerSessionDirs(
  cwd: string,
  thresholdMs = WORKER_DIR_STALE_THRESHOLD_MS,
  fileThresholdMs = WORKER_FILE_STALE_THRESHOLD_MS,
): number {
  const sessionsDir = getSessionDir(cwd)
  if (!existsSync(sessionsDir)) return 0
  let cleaned = 0
  try {
    const entries = readdirSync(sessionsDir)
    for (const entry of entries) {
      if (!entry.startsWith('worker-')) continue
      const fullPath = join(sessionsDir, entry)
      try {
        const st = statSync(fullPath)
        const age = Date.now() - st.mtimeMs
        if (st.isDirectory()) {
          if (age > thresholdMs) {
            rmSync(fullPath, { recursive: true, force: true })
            cleaned++
          }
        } else if (age > fileThresholdMs) {
          // worker-<id>.jsonl 及附属（.meta.json/.claims.jsonl…）。evict 额度池
          // 已排除 worker（否则洪水挤掉主会话），生命周期由此处接管——否则无限累积。
          unlinkSync(fullPath)
          cleaned++
        }
      } catch { /* best-effort — skip unreadable entries */ }
    }
  } catch { /* best-effort */ }
  return cleaned
}

// ── Tool Registry (with all tools registered) ──────────────────

export function createInteractiveToolRegistry(
  refs: RuntimeRefs,
  config: Config,
  cwd: string,
): { registry: ReturnType<typeof createDefaultToolRegistry> } {
  // 域工具档位：defaultDomain 钉定某域且该域配置了 toolPreset 时按域装配
  // （如 taiyi 域默认 taiyi 档）。运行期 /domain 切换不改（装配已过）。
  const toolPreset = resolveToolPreset(cwd, config.agent.defaultDomain)
  const reg = createDefaultToolRegistry([], {
    preset: toolPreset,
    desktopTools: config.agent.desktopTools,
    todoStore: refs.todoStore,
    // Computer Use（桌面 GUI 自动化）：EXTENDED 层，注册≠主控可见（tool gating
    // 过滤），@Computer / /tools enable 挂载时才进主控视野。darwin/win32 + Pro gated。
    computerUse: (process.platform === 'darwin' || process.platform === 'win32') && process.env.RIVET_COMPUTER_USE !== '0',
    proEnabled: isProFeatureEnabled(config, 'computerUse'),
    // web_search 后端链（bing/DDG 默认 / Brave / Tavily），按 config.search 顺序 fallback。
    // 透传 network.{proxy,noProxy}：web_search 与 web_fetch 走同一代理解析路径，
    // 否则配了代理仍直连，国内 GFW 外的 backend 全超时。
    searchBackends: buildSearchBackends(config, {
      proxy: {
        ...(config.network.proxy ? { proxyUrl: config.network.proxy } : {}),
        ...(config.network.noProxy ? { noProxy: config.network.noProxy } : {}),
      },
    }),
    // web_fetch 配置注入（超时/大小上限/UA/正文抽取）
    fetchOptions: buildFetchOptions(config),
  })

  // delegate_task —— taiyi 评测档排除（编排类不在 16 核心集；TAIYI_EXCLUDES），
  // 其余档位照旧无条件注册。
  if (presetIncludes(toolPreset, 'delegate_task')) {
    reg.register(createDelegateTaskTool(
      // 三参（signal / onOrderCreated）全透传的适配器——丢参史：H3 丢 signal、
      // 35f459b8f 复评发现丢 onOrderCreated（补发终态变死代码）。
      createCoordinatorDelegateAdapter(() => refs.coordinator),
      () => refs.claimStore ?? undefined,
      () => refs.sessionId ?? undefined,
      () => refs.getProblemAttackStore?.() ?? null,
    ))
  }

  // undo — preset full 才含（全会话零使用）。
  if (presetIncludes(toolPreset, 'undo')) {
    reg.register(createUndoTool(() => refs.fileHistory ?? undefined))
  }

  // delegate_batch —— taiyi 排除（同 delegate_task）。
  if (presetIncludes(toolPreset, 'delegate_batch')) {
    reg.register(createDelegateBatchTool(
      // 五参全透传——第五参 onWorkerSettled 曾丢失，防翻转守卫（settledIds）
      // 在生产失效（同 35f459b8f 复评的丢参事故形态）。
      createCoordinatorBatchDelegateAdapter(() => refs.coordinator),
      () => refs.claimStore ?? undefined,
      () => refs.sessionId ?? undefined,
      () => refs.getProblemAttackStore?.() ?? null,
    ))
  }

  // galaxy — 星河集群派发（子 Agent 内部分子 Agent 并行）
  // 实例同时喂给 starflow（星流状态机的攻坚阶段复用同一工具）。
  const galaxyTool = createGalaxyTool(
    {
      delegateBatch: async (requests, policy, abortSignal, onProgress, onWorkerSettled) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress, onWorkerSettled)
      },
      getRuntimeSnapshot: () => refs.coordinator?.getRuntimeSnapshot() ?? {
        activeWorkers: 0,
        maxWorkers: 0,
        pendingWorkers: 0,
        stalledWorkers: 0,
        inFlightFileScopes: 0,
        backgroundRunning: 0,
        activeClaims: 0,
        providerDegradation: 0,
        shuttingDown: true,
      },
      // 路由学习（收编 #5）存取口——getter 惰性读取，/cd 换 store 后自动指向新实例。
      get domainKnowledgeStore() { return refs.domainKnowledgeStoreRef?.current ?? undefined },
      // DP 证据冗余（收编 #2）——agent 构建后经 createAgentRuntime 回写。
      get obligationTracker() { return refs.obligationTrackerRef?.current ?? undefined },
    },
  )
  // galaxy 实例恒构造（starflow 复用同一实例）；注册按档位——taiyi 排除。
  if (presetIncludes(toolPreset, 'galaxy')) reg.register(galaxyTool)

  // Shared plan-execution kernel deps: team_orchestrate and plan_task(execute:true)
  // run the SAME closed loop through executePlan (dispatch + scope-health +
  // telemetry + reward/episode closure). plan_task opts out of the review gate
  // (its post-commit auto review covers the diff).
  const planExecutorDeps: PlanExecutorDeps = {
    delegate: async (request, abortSignal) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegate(request, abortSignal)
    },
    delegateBatch: async (requests, policy, abortSignal, onProgress) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
    },
    recordTeamWaveTelemetry: (event: TeamWaveTelemetry) => {
      persistTeamWaveTelemetry(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamWaveRewardClosure: (event: TeamWaveTelemetry) => {
      recordTeamWaveRewardClosure(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamSchedulerShadow: (event: TeamSchedulerShadowEvent) => {
      persistTeamSchedulerShadow(refs.meridianIndexer?.getDb(), event)
    },
    recordGatedInfluenceAudit: (event: GatedInfluenceAuditEvent) => {
      persistGatedInfluenceAudit(refs.meridianIndexer?.getDb(), event)
    },
    recordTeamSchedulerReward: (event: TeamWaveTelemetry) => {
      const rewardInput = deriveTeamWaveRewardInput(event)
      persistTeamSchedulerReward(refs.meridianIndexer?.getDb(), buildTeamSchedulerRewardEvent({
        sessionId: event.sessionId,
        objective: event.objectiveHash,
        waveId: event.waveId,
        arm: teamSchedulerArmForParallelism(event.outcome.dispatched),
        rewardInput: {
          teamWaveReward: computeTeamWaveReward(rewardInput),
          conflictRate: Number(rewardInput.normalizedConflict),
          scopeLeakRate: Number(rewardInput.normalizedScopeLeak),
          falseGreen: rewardInput.falseGreen,
        },
        timestamp: event.timestamp,
      }))
    },
    getTeamSchedulerRewardStore: () => refs.meridianIndexer?.getDb(),
    isTeamSchedulerBanditEnabled: () => resolveBanditPromotion({
      source: 'team_scheduler_bandit',
      mode: effectiveBanditMode(config.agent.banditPromotion?.teamScheduler, config.agent.teamSchedulerBanditEnabled, config.agent.banditPromotion?.killSwitch),
      store: refs.meridianIndexer?.getDb(),
    }).enabled,
    getSessionId: () => refs.sessionId ?? undefined,
    getMeridianIndexer: () => refs.meridianIndexer,
    // 门禁预算（5 分钟）而非默认 2 分钟：这个 runner 喂 wave-gate 硬门禁，
    // 满载机器 tsc 超时曾被记成 passed 放行（2026-07-07）。
    getTypecheckRunner: () => (cwd: string) => runTypeCheck(cwd, '*', GATE_TSC_TIMEOUT_MS),
  }
  let teamOrchestrateTool: ReturnType<typeof createTeamOrchestrateTool> | undefined
  if (presetIncludes(toolPreset, 'team_orchestrate')) {
    teamOrchestrateTool = createTeamOrchestrateTool(planExecutorDeps, {
      defaultMaxParallel: config.agent.maxTeamParallel,
      // Pro gate（双层模式）：桌面端由 Rust 验签后注入 RIVET_PRO=1；CLI 保持软 gate。
      teamMaxEnabled: isProFeatureEnabled(config, 'teamMax'),
    })
    reg.register(teamOrchestrateTool)
  }

  // council_convene — 单轮多星域会诊出计划（与 team_orchestrate 解耦，默认绝不派执行；
  // autoExecute 经 executor 走完整 executePlan 闭环，与 team_orchestrate 同路径）。
  const councilCoordinator: CouncilConveneCoordinator = {
    delegateBatch: async (requests, policy, abortSignal, onProgress) => {
      if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
      return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
    },
    getSessionId: () => refs.sessionId ?? undefined,
    recordRoutingShadow: event => persistCouncilRoutingShadow(refs.meridianIndexer?.getDb(), event),
    recordCouncilSession: event => recordCouncilSession(refs.meridianIndexer?.getDb(), event),
    executor: planExecutorDeps,
  }
  const councilDefaultSeats = config.agent.council.seats.length > 0 ? config.agent.council.seats : undefined
  const councilOptions = { multiRoundEnabled: isProFeatureEnabled(config, 'councilMultiRound') }
  let councilConveneTool: ReturnType<typeof createCouncilConveneTool> | undefined
  if (presetIncludes(toolPreset, 'council_convene')) {
    councilConveneTool = createCouncilConveneTool(councilCoordinator, councilDefaultSeats, councilOptions)
    reg.register(councilConveneTool)
  }

  // starflow — 星流代码级编排（council→team→galaxy 硬门禁状态机，替代纯 prompt 注入）。
  // minimal/frontend 档 preset 排除 council_convene 注册，但 preset 只挡注册可见性
  // 不挡工具构造——星流缺失的实例按相同参数等价自构，行为与注册实例一致。
  // taiyi 排除（编排类；TAIYI_EXCLUDES）。
  if (presetIncludes(toolPreset, 'starflow')) {
    reg.register(createStarflowTool({
      councilTool: councilConveneTool ?? createCouncilConveneTool(councilCoordinator, councilDefaultSeats, councilOptions),
      teamTool: teamOrchestrateTool ?? createTeamOrchestrateTool(planExecutorDeps, {
        defaultMaxParallel: config.agent.maxTeamParallel,
        teamMaxEnabled: isProFeatureEnabled(config, 'teamMax'),
      }),
      galaxyTool,
      cwd,
    }))
  }

  // recall_capsule —— taiyi 排除（不在 16 核心集）。
  if (presetIncludes(toolPreset, 'recall_capsule')) reg.register(createRecallCapsuleTool(() => cwd))

  // 将星账本（B1/B2）：recall_general 读战绩，record_general_finding 追加战绩。
  // 胶囊 = 方法论基因，账本 = 跨会话战绩记忆。preset full 才含。
  if (presetIncludes(toolPreset, 'recall_general')) reg.register(createRecallGeneralTool(() => cwd))
  if (presetIncludes(toolPreset, 'record_general_finding')) reg.register(createRecordGeneralFindingTool(() => cwd))

  // ask_user_question —— taiyi 排除（评测无人在环，注册只会诱发无效调用）。
  if (presetIncludes(toolPreset, 'ask_user_question')) reg.register(ASK_USER_QUESTION_TOOL)

  // browser_debug — persistent browser for local frontend/backend联调 (CDP route).
  // preset frontend/full 含；RIVET_BROWSER_DEBUG=1 强制开启。
  // render-verify-hook 有能力降级分支。
  if (presetIncludes(toolPreset, 'browser_debug') || process.env.RIVET_BROWSER_DEBUG === '1') {
    reg.register(BROWSER_DEBUG_TOOL)
  }

  // repo_graph — meridian 图查询。preset full 含；RIVET_REPO_GRAPH=1 强制开启。
  if (presetIncludes(toolPreset, 'repo_graph') || process.env.RIVET_REPO_GRAPH === '1') {
    reg.register(createRepoGraphTool(() => refs.meridianIndexer))
  }

  // related_tests — override the no-indexer default with a meridian-aware factory
  if (presetIncludes(toolPreset, 'related_tests')) {
    reg.register(createRelatedTestsTool(() => refs.meridianIndexer))
  }

  if (presetIncludes(toolPreset, 'semantic_search')) reg.register(SEMANTIC_SEARCH_TOOL)
  // APPLY_PATCH: EXTENDED layer — overlap with hash_edit covers >90% of
  // use cases; kept here (interactive) for edge cases (e.g. git-format patches).
  // taiyi 排除（16 核心集已有 edit_file/hash_edit 覆盖编辑面）。
  if (presetIncludes(toolPreset, 'apply_patch')) reg.register(APPLY_PATCH_TOOL)
  // W5 session_vitals: EXTENDED layer（interactive 装配，不占 kernel budget）。
  // 只读自查工具——模型写"系统状态"类结论前的取证入口（incident 20b9714e）。
  // 工具定义跟版本发布上车（新定义 = 前缀一次性 miss，绝不热更）。
  if (presetIncludes(toolPreset, 'session_vitals')) {
    reg.register(createSessionVitalsTool(() => refs.getSessionVitals?.() ?? null))
  }
  // PAL attack_case：攻坚案件账本——竞争假设 + 判别探针 + 证据结算。
  // preset full 才含（零使用率的重工具，2026-07-19 工具审计降级）。
  if (presetIncludes(toolPreset, 'attack_case')) {
    reg.register(createAttackCaseTool({
      getStore: () => refs.getProblemAttackStore?.() ?? null,
      getVerifier: () => refs.getAttackEvidenceVerifier?.() ?? null,
    }))
  }

  // web_search is now in the kernel default-registry (CORE layer).
  // Remove the interactive registration to avoid double-registration.
  // PLAN_MODE_ALLOWED_TOOLS already references web_search alongside recall.
  // plan_task —— taiyi 排除（编排类；16 核心集保留 plan_submit/plan_close 轻量对）。
  if (presetIncludes(toolPreset, 'plan_task')) {
    reg.register(createPlanTaskTool({
      getCoordinator: () => refs.coordinator,
      getExecutorDeps: () => planExecutorDeps,
      getSessionId: () => refs.sessionId ?? undefined,
      // 多会话隔离：plan_task 写本会话 store（TUI 即 defaultStore，行为不变）。
      writeTodos: todos => refs.todoStore.write(todos),
    }))
  }

  // B1 deliver_task
  // sidecar 多 session 路径必须用 refs.sessionId（每个 session 独立装配），
  // 全局 getOrCreateSessionId 仅作 TUI 单 session 路径的兼容 fallback。
  const b1TaskLedger = createTaskLedger({ taskId: refs.sessionId ?? getOrCreateSessionId() })
  refs.taskLedger = b1TaskLedger
  const b1Baseline = createWorktreeBaseline(captureGitBaseline(cwd))
  const b1Ownership = createOwnershipLedger({
    baseline: b1Baseline,
    taskLedger: b1TaskLedger,
  })
  refs.ownershipLedger = b1Ownership
  // VSW: best-effort reap of worktrees left by dead sessions, then a session-scoped
  // manager. §6 policy keeps a single clean session in-place (head==='' → not a git
  // repo → in-place; no other sessions on this cwd in the CLI path → in-place),
  // so behavior is unchanged unless the baseline is dirty or RIVET_VSW=1 forces it.
  try { reapOrphanSnapshots({ baseCwd: cwd, currentSessionId: refs.sessionId ?? undefined }) } catch { /* best-effort */ }
  try { reapOrphanHandsWorktrees({ baseCwd: cwd, currentSessionId: refs.sessionId ?? undefined }) } catch { /* best-effort */ }
  try { cleanupStaleHandsBranches(cwd) } catch { /* best-effort */ }
  // C4: config-declared VSW mode. 'off' skips the manager entirely (pipeline
  // degrades to in-place); 'always' forces isolation; 'auto' = §6 matrix.
  // RIVET_VSW=1 keeps its historical force semantics on top of any mode.
  const vswMode = config.agent.verificationSnapshot
  const b1SnapshotManager = vswMode === 'off' ? null : createVerificationSnapshotManager({
    baseCwd: cwd,
    sessionId: refs.sessionId ?? getOrCreateSessionId(),
    baselineHead: b1Baseline.getHead() || undefined,
    isGitRepo: b1Baseline.getHead().length > 0,
    preExistingDirtyCount: b1Baseline.getExternalDirtyCount(),
    preExistingUntrackedCount: b1Baseline.getExternalUntrackedCount(),
    // C2: sameCwdRunningSessions fallback now queries SessionRegistry (cross-process,
    // registry.db in shared stateDir). Previously hardcoded () => 0 so VSW never
    // activated for multi-TUI scenarios. Sidecar-provided getSameCwdRunningSessions
    // still takes priority when available.
    sameCwdRunningSessions: refs.getSameCwdRunningSessions
      ?? (() => refs.sessionRegistry?.countSameCwdActive(cwd, refs.sessionId ?? '') ?? 0),
    forceSnapshot: process.env.RIVET_VSW === '1' || vswMode === 'always',
  })
  refs.verificationSnapshotManager = b1SnapshotManager
  const b1Attribution = createVerificationAttribution({ ownership: b1Ownership })
  const b1Gate = createDeliveryGateV2({
    taskLedger: b1TaskLedger,
    ownership: b1Ownership,
    attribution: b1Attribution,
  })
  refs.deliveryGate = b1Gate
  reg.register(createDeliverTaskTool((params) => ({
    taskLedger: b1TaskLedger,
    ownership: b1Ownership,
    gate: b1Gate,
    getCurrentSnapshotRef: () => b1SnapshotManager?.currentSnapshotRef() ?? undefined,
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    reviewDepth: params?.reviewDepth ?? 0,
    getDepthLayer: () => refs.promptEngine?.getTaskDepthLayer(),
    reviewDeps: createCoordinatorReviewDeps({
      delegate: async (request, abortSignal) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegate(request, abortSignal)
      },
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        if (!refs.coordinator) throw new Error('DelegationCoordinator not initialized')
        return refs.coordinator.delegateBatch(requests, policy, abortSignal, onProgress)
      },
    }, { reviewDepth: params?.reviewDepth ?? 0 }),
    isGoalActive: () => refs.goalTrackerRef.current?.isActive() ?? false,
    isGoalAchieved: () => refs.goalTrackerRef.current?.isGoalAchieved() ?? false,
    getLastVerdict: () => refs.goalTrackerRef.current?.getLastVerdict() ?? null,
    reviewConfig: config.agent.review,
    autoCommit: config.agent.delivery?.autoCommit !== false,
    isAutoReviewOff: () => refs.reviewGateRef.current === 'off',
    meridianIndexer: refs.meridianIndexer,
    getTaskContract: () => refs.getTaskContract?.(),
    getImpactedTests: () => refs.getImpactedTests?.() ?? [],
    // P4 收束闸：PAL 收敛案件快照（闭包现读 store——B1Context 每次调用现构造，
    // hook 无法"写入"它；这是与其他 getter 一致的既有注入模式）
    getPalConvergedCases: () => refs.getProblemAttackStore?.()?.convergedCasesSnapshot() ?? [],
    // 遗产回收 W-A1：needs_user 案件披露（minimalQuestion 由 store 预计算）
    getPalNeedsUserCases: () => refs.getProblemAttackStore?.()?.needsUserCasesSnapshot() ?? [],
    // 收编 #2：冗余义务门禁消费——生产注入（此前仅测试注入，链路不可达）。
    getObligationStore: () => refs.obligationTrackerRef?.current?.getStore() ?? emptyObligationStore(),
    getClaimTracker: () => refs.claimTrackerRef?.current?.() ?? undefined,
    scoutFirewallConfig: config.agent.scoutEvidenceFirewall,
  })))

  // update_goal — model-driven goal lifecycle control (paused/blocked/complete)
  if (presetIncludes(toolPreset, 'update_goal')) {
    reg.register(createUpdateGoalTool(
      () => refs.goalTrackerRef.current,
      () => ({ sessionId: refs.sessionId ?? undefined, cwd }),
    ))
  }

  return { registry: reg }
}

// ── Agent Runtime ──────────────────────────────────────────────

/**
 * resume 缓存继承的写侧接线：引擎每个 user 边界固化冻结快照后，
 * 把它落到 `<id>.frozen.json`（best-effort——盘存写失败不影响会话，
 * 顶多下次 resume 退化为全量重建）。startup / /resume 切换 / /cd 三处统一挂。
 */
function wireFrozenSnapshotPersist(persist: SessionPersist, engine: import('./prompt/engine.js').PromptEngine): void {
  engine.setOnFrozenSnapshotCommit(() => {
    try { persist.writeFrozenSnapshot(engine.exportFrozenSnapshot()) } catch { /* best-effort */ }
  })
}

/** 已报过的「配置的模型名不存在」告警——本函数每会话 + 每次 switchModel 重建都跑，
 *  不去重会在长驻 sidecar 里反复刷屏。 */
const warnedModelFallback = new Set<string>()

export function createAgentRuntime(deps: {
  provider: ProviderConfig
  apiKey: string
  auth: AuthProvider | undefined
  config: Config
  sessionId: string
  cwd: string
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>
  persist: SessionPersist
  claimStore: import('./context/claim-store.js').ContextClaimStore
  fileHistory: FileHistory
  refs: RuntimeRefs
  domainKnowledgeStore: DomainKnowledgeStore
  modelId?: string
  session: SessionContext
  /**
   * Wave J: 可选共享 ProviderHealthTracker。sidecar 多 session + switchModel
   * 频繁场景下，per-call new 会丢失累积的 provider 健康统计（成功率/延迟），
   * coordinator 的冷层路由跳过逻辑失据。传入共享实例后，registerProvider
   * 幂等不会重置已有状态。TUI 单 session 路径不传，保持原行为。
   */
  sharedProviderHealth?: ProviderHealthTracker
  /** I4: optional callback to surface user hook results to the desktop event stream. */
  emitHookResult?: import('./agent/loop-types.js').AgentConfig['emitHookResult']
  /** 资源压力状态行回调（透传 AgentConfig.onStatusLine；TUI 经 ctx.setStatusLine
   *  晚绑定，sidecar/worker 不传即 no-op）。 */
  onStatusLine?: (text: string | null) => void
  /** /cd: previous PromptEngine whose frozen snapshots the new engine inherits
   *  (keeps the historical prefix byte-stable across the cwd switch).
   *  resume 场景传盘存 FrozenSnapshotData（<id>.frozen.json），同语义。 */
  inheritFrozenFrom?: import('./prompt/engine.js').PromptEngine | import('./prompt/frozen-snapshot.js').FrozenSnapshotData
  /** Per-session 工具白名单（蒸馏回放等自动化场景）。有值时 LLM 的工具列表
   *  收窄到这个集合（覆盖 config.agent.toolGating.coreOverride）。缺省 = 默认。 */
  allowedTools?: string[]
}): { agent: AgentLoop } {
  const {
    provider, apiKey, auth, config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId,
  } = deps

  // 模型名匹配不上时不做静默兜底。用户配的可能是多模态档（deepseek-flash 等），
  // 而兜底的 models[0] 常常是同名的纯文本档——症状是「配了视觉模型却完全看不到
  // 图片」，界面上却毫无异常，是最难查的一类故障。别名失配尤其容易踩：preset 给
  // 模型加的 alias 进不了存量 config 快照（数组整组替换 + alias 不在回填白名单）。
  const matchedModel = modelId
    ? provider.models.find(m => m.id === modelId || m.alias === modelId)
    : undefined
  if (modelId && !matchedModel && !warnedModelFallback.has(modelId)) {
    warnedModelFallback.add(modelId)
    // 与 warnVisionBridge 同惯例：console.warn 在终端可见（stderr，不进渲染回路）。
    console.warn(
      `[model] 配置的模型 "${modelId}" 不在 provider "${provider.name}" 下，已回退到 `
      + `"${provider.models[0]!.id}"（该档不支持视觉时图片将无法被识别）。`
      + `可选：${provider.models.map(m => m.id).join(', ')}`,
    )
  }
  const currentModel = matchedModel ?? provider.models[0]!

  // wire 上下文会话固化（2026-08-07 spark T1）：meta 已有值 → 恒用之（resume/
  // 跨端字节稳定）；无值且 provider 注册了默认（spark 的 env 解析 N）→ 取默认
  // 冻结进 meta。非 spark / 开源构建：defaults 恒 undefined → 恒不写不传，零差异。
  // TUI 与 sidecar（serve-agent assembleAgentLoop）都经本函数，单点覆盖两端。
  let wireContext = persist.loadMetadata()?.wireContext
  if (!wireContext) {
    const defaults = proRegistry.getWireContextDefaults(provider.name)?.()
    if (defaults) {
      wireContext = defaults
      try { persist.updateMetadata({ wireContext }) } catch { /* best-effort——写失败退化为下次再冻结 */ }
    }
  }

  const agentCfg = createAgentConfig(createMainAgentConfigInput({
    apiKey,
    model: {
      id: currentModel.id,
      maxTokens: currentModel.maxTokens,
      contextWindow: currentModel.contextWindow,
      // 用户显式 defaultEffort（/model 面板随「设为默认」持久化）压过 preset 默认档；
      // 未配置时沿用 preset/模型的 reasoningEffort（auto-reasoning 仍可在其上动态调）。
      reasoningEffort: config.agent.defaultEffort ?? currentModel.reasoningEffort,
      supportsVision: currentModel.supportsVision,
    },
    cwd,
    provider,
    allProviders: config.provider.providers,
    config,
    sessionId,
    // 全量传入；门控统一在 createAgentConfig 内经 gateToolDefinitions 施加，
    // 与 AgentLoop.updateTools() 共用同一过滤逻辑（避免 MCP/LSP 异步注册后被还原）。
    toolDefinitions: toolRegistry.getDefinitions(),
    sessionMemoryBlock: persist.buildMemoryBlock(),
    auth,
    inheritFrozenFrom: deps.inheritFrozenFrom,
    onStatusLine: deps.onStatusLine,
    allowedTools: deps.allowedTools,
    wireContext,
    // CLI meridian 接线（2026-09-06）：serve 路径经 serve-agent.ts:341 直连，CLI 此前
    // 漏接——refs.meridianIndexer（bootstrapInteractiveSession :2102 构造）从未进
    // agent config → tool-pipeline 写工具收尾走 importGraph fallback 每会话全量扫仓。
    meridianIndexer: deps.refs?.meridianIndexer ?? null,
  }))

  // Model capability cards（统一口径在 model/capability.ts——v4-flash 特例也在那里）
  const modelCards: ModelCapabilityCard[] = buildModelCards(provider)

  // Review override: pre-resolve each profile's provider/model + validate
  // credentials eagerly, but defer StreamClient construction to runtimeFactory
  // so maxTokens/thinkingBudget can be set from per-call isWrite (read vs write
  // profile). Without this deferral, override workers were hardcoded to 4096
  // even for write profiles like 'patcher' — half the token budget of normal
  // workers. Mirrors create-agent-config.ts:162-168 cross-provider client
  // factory. Skip on credential failure → fall through to primary client.
  const overrideState = config.agent.review?.profiles
    ? buildReviewOverrideState(config.agent.review.profiles, config.provider.providers)
    : { cards: new Map<string, ModelCapabilityCard>(), overrides: new Map<string, ResolvedReviewOverride>() }
  const reviewOverrideCards = overrideState.cards
  const reviewOverrides = overrideState.overrides
  const reviewOverrideApiKeys = new Map<string, string>()
  for (const [profileName, resolved] of reviewOverrides) {
    try { reviewOverrideApiKeys.set(profileName, resolveApiKey(resolved.providerConfig)) } catch {
      debugLog(`[review-override] skip ${profileName}: no API key for ${resolved.providerName}`)
      reviewOverrides.delete(profileName)
      reviewOverrideCards.delete(profileName)
    }
  }

  // Worker routing
  const workerRouting = config.workers?.profiles && Object.keys(config.workers.profiles).length > 0
    ? { profiles: config.workers.profiles, routing: config.workers.routing, providers: config.provider.providers }
    : undefined

  // Physarum provider health: shared between main loop (sensorium stability)
  // and coordinator (cold-tier routing skip). Stream outcomes feed weights.
  // Wave J: sidecar 可传 sharedProviderHealth 让 health 数据跨 session +
  // switchModel 持久（registerProvider 幂等不重置已有状态）；TUI 不传则保持
  // per-call new 的原行为（单 session 进程影响有限）。
  const providerHealth = deps.sharedProviderHealth ?? new ProviderHealthTracker()
  providerHealth.registerProvider(provider.name)
  if (workerRouting?.providers) {
    for (const name of Object.keys(workerRouting.providers)) providerHealth.registerProvider(name)
  }

  const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => buildWorkerRuntime(
    {
      config,
      cwd,
      provider,
      apiKey,
      auth,
      currentModelId: currentModel.id,
      listActiveClaims: () => claimStore.listActiveClaims(),
      sessionMemoryBlock: () => persist.buildMemoryBlock(),
      domainKnowledgeStore,
      reviewOverrides,
      reviewOverrideApiKeys,
      workerRouting,
      writeProfiles: profileRegistry.listWriteProfiles(),
    },
    _order,
    card,
    workerRegistry,
  )

  // EFE routing pulls per-turn signals from the agent. Build the agent first so
  // its ArtifactStore can be wired into the coordinator for worker artifact fallback.
  let agentForSignals: AgentLoop | undefined

  // Track 1: unified shadow→gated promotion gate. Evidence is evaluated once
  // per session; `banditPromotion.killSwitch` rolls every path back at once.
  const promo = config.agent.banditPromotion
  const promotionStore = refs.meridianIndexer?.getDb()
  const modelTierGate = resolveBanditPromotion({
    source: 'model_tier_bandit',
    mode: effectiveBanditMode(promo?.modelTier, config.agent.modelTierBanditEnabled, promo?.killSwitch),
    store: promotionStore,
  })
  const modelRoutingGate = resolveBanditPromotion({
    source: 'model_routing',
    mode: effectiveBanditMode(promo?.modelRouting, config.agent.modelRoutingGatedEnabled, promo?.killSwitch),
    store: promotionStore,
  })
  const effortGate = resolveBanditPromotion({
    source: 'effort_bandit',
    mode: effectiveBanditMode(promo?.effort, undefined, promo?.killSwitch),
    store: promotionStore,
  })

  // T5: expose bandit state for /status observability
  refs.banditState = [modelTierGate, modelRoutingGate, effortGate].map(g => ({
    source: g.source,
    mode: g.mode,
    enabled: g.enabled,
    reason: g.reason,
    totalShadowSamples: g.evidence.totalShadowSamples,
  }))

  const agent = new AgentLoop(
    {
      ...agentCfg,
      toolRegistry,
      // P2: CVM 管线装配配置——磁盘 Config.hooks 填入 AgentLoop 选项
      // （createRuntimeHooksPipeline 经 resolveDisabledHookIds 消费；
      // 交互模式热更见 config-watcher）。
      hookAssembly: {
        disabled: config.hooks.disabled,
        timeoutMs: config.hooks.timeoutMs,
        slowMs: config.hooks.slowMs,
      },
      // YOLO 联动无限轮次——启动恢复路径。运行时切换（/yes、权限面板、sidecar
      // serve.ts）都会把 maxTurns 置 0，唯独「持久化 YOLO 为默认 → 重启」的构造
      // 路径漏了联动：YOLO 会话按 config maxTurns（如 50）跑，turn 45 注入预算
      // 预警、turn 50 被 GUARD 硬截断（session 92a38900，用户观感=自己停止）。
      maxTurns: config.agent.approval === 'dangerously-skip-permissions' ? 0 : config.agent.maxTurns,
      checkpointEveryTurns: config.agent.checkpointEveryTurns,
      getSessionMemoryState: () => persist.getSessionMemoryState(),
      fileHistory,
      contextClaimStore: claimStore,
      // Playbook 默认停用（2026-07-06，RIVET_PLAYBOOK=1 重新启用）。取证结论：
      // 注入内容是错误转储级噪音（deliver_task 报文原样入库、context 字段 merge
      // 滚雪球），且 matchScore 的 useCount 加成 + recordUsage 强化构成自增强回路
      // ——垃圾教训越注入越常被选中、几乎不衰减（单项目 2 条垃圾 ×8 会话注入）。
      // 不构造 store 即全链路关闭：注入 / dream 蒸馏 / playbook-reflect 收割 /
      // recordUsage 均为判空跳过。修复质量闸前不要复活（上次复活见 80e0c530）。
      playbookStore: process.env['RIVET_PLAYBOOK'] === '1' ? new PlaybookStore(cwd) : undefined,
      providerHealth,
      effortBanditEnabled: effortGate.enabled,
      taskLedger: refs.taskLedger ?? undefined,
      ownershipLedger: refs.ownershipLedger ?? undefined,
      verificationSnapshotManager: refs.verificationSnapshotManager ?? undefined,
      // T4: late-bound LSP manager — initialized asynchronously after agent creation
      getLspManager: () => refs.lspManager,
      // Track 3 门禁合一：badge 与收敛检测读权威 v2 状态。
      deliveryGateV2: refs.deliveryGate
        ? (dirty) => refs.deliveryGate!.assess([], dirty)
        : undefined,
      meridianIndexer: refs.meridianIndexer,
      modelRoutingShadowModelCards: modelCards,
      domainKnowledgeStore,
      emitHookResult: deps.emitHookResult,
      // 多会话隔离：turn-end 任务进度回灌与 todo-reminder 快照统一读本会话 store。
      // TUI 下 refs.todoStore 即全局 defaultStore（行为不变）；server 下每会话独立。
      // 闭包绑定 refs（switchModel 重建 loop 时复用同一 refs/todoStore）→ 守住缓存不变量。
      getTodos: () => refs.todoStore.read(),
      getTodoRegressionStats: () => refs.todoStore.getRegressionStats(),
    },
    deps.session,
    cwd,
  )
  agentForSignals = agent

  refs.coordinator = new DelegationCoordinator({
    baseToolRegistry: toolRegistry,
    modelCards,
    // worker 子进程隔离（RIVET_WORKER_ISOLATION：1/all=全部 worker，review=仅审查
    // worker，未设置=默认进程内）：每次派发 spawn 独立子进程，sidecar 结构性免疫
    // worker 冻结/爆内存（/scout 蜂群卡死事故的结构解；协议与回退见
    // worker-process/parent.ts）。review 是针对「审查 worker 卡死连累主 TUI」的
    // 窄口径开关——不动其余 worker 的成熟进程内路径。
    // entry 缺失自动回退进程内——公开仓裁剪与 dev 场景零破坏。
    ...(workerIsolationEnabled()
      ? { runWorker: createModeAwareRunner(workerIsolationMode(), { getMemoryBlock: () => persist.buildMemoryBlock() }) }
      : {}),
    // P1-6 全局并发闸输入：不再硬编码 3，配置化（见 resolveCoordinatorMaxWorkers）。
    // 该值同时是 CoordinatorState 的并发上限与 WorkOrderQueue 的容量基准——
    // 全局信号量（activeWorkerCount ≤ maxWorkers）在 coordinator 层实施。
    maxWorkers: resolveCoordinatorMaxWorkers(config),
    ...resolveCoordinatorPoolCaps(config),
    providers: config.provider.providers,
    runtimeFactory,
    routing: workerRouting,
    providerHealth,
    domainKnowledgeStore,
    modelTierShadowStore: refs.meridianIndexer?.getDb(),
    modelTierBanditEnabled: modelTierGate.enabled,
    gatedInfluenceAuditStore: refs.meridianIndexer?.getDb(),
    efeRouting: {
      enabled: modelRoutingGate.enabled,
      getSignals: () => agentForSignals?.getPolicySignals(),
    },
    sessionRegistry: refs.sessionRegistry ?? undefined,
    sessionId: refs.sessionId ?? undefined,
    artifactStore: agent.artifactStore,
    // Wave 3 控制面双源接线：episode 路径（writeGate/falseGreen）+ aggregation
    // 路径（verifyWorkerEvidence 后结果）都汇入主控控制面（shadow 记账）。
    onControlSignal: signal => { agent.controlPlane.submit(signal) },
    // 证据义务接线（evidence-driven reasoning loop）：worker 未验证写入声明
    // 创建 external_claim 义务——delegate 结果只是外部声明，主控 read/grep/
    // 测试后才关闭（worker_claim_requires_primary_evidence）。设置本回调即
    // 触发 worker unverified 信号降级（single voice）。
    onVerifiedResults: results => {
      for (const result of results) {
        if (result.evidenceStatus === 'unverified' && result.changedFiles.length > 0) {
          agent.obligations.upsert({
            family: 'external_claim',
            claim: `worker ${result.workOrderId} 的写入声明未经主控独立验证`,
            targets: result.changedFiles,
            risk: 'high',
          })
        }
      }
    },
    resumeEnabled: true,
    reviewOverrideCards: reviewOverrideCards.size > 0 ? reviewOverrideCards : undefined,
    maxDelegationDepth: config.agent.maxDelegationDepth,
    // Shared-worktree mode: write workers run directly in the controller's single
    // shared cwd/branch (no per-worker git worktree, no diff回流/apply_patch merge).
    // Orthogonal shards write disjoint files; the file-claim registry +
    // groupTeamTasks same-file serialization prevent stomping. Mirrors the real
    // "multiple sessions, one branch" workflow.
    sharedWorktree: true,
    patcherTier: config.workers.patcherTier,
    escalationCap: config.workers.escalationCap,
    // Downward trust delegation: a primary running dangerously-skip-permissions
    // opted out of all prompts, so its workers inherit that. Any other mode is
    // ignored downstream — workers rely on headless approval semantics instead.
    parentApprovalMode: config.agent.approval as import('./agent/loop-types.js').ApprovalMode,
    // D8 L2：计划约束兜底注入——objective 里带 .md 路径时自动解析反目标与待验证假设，
    // 注入 worker 工单。best-effort，任何异常降级为空，绝不阻断派发。
    getPlanConstraints: objective =>
      resolvePlanConstraints(cwd, {
        objective,
        fromContract: agent.getTaskContract()?.planConstraints,
      }),
  })

  // H4-D3 恢复半边：session meta 里有 PAL 快照就原地恢复（覆盖 resume、
  // 模型切换重建、会话切换三条 agent 重建路径——都经本函数）。快照缺席或
  // schemaVersion 未知 → 保持空 store（fail-closed，不半恢复）。
  try {
    const palSnapshot = persist.loadMetadata()?.palSnapshot
    if (palSnapshot) agent.problemAttack.restoreSnapshot(palSnapshot)
  } catch { /* best-effort：恢复失败不阻断 agent 创建 */ }

  // 证据义务追踪器引用：deliver_task 门禁读 store（收编 #2 冗余义务消费）、
  // galaxy DP 派发创建/满足冗余义务。switchModel 重建路径经本函数每次刷新。
  if (refs.obligationTrackerRef) refs.obligationTrackerRef.current = agent.obligations
  if (refs.claimTrackerRef) refs.claimTrackerRef.current = agent.externalClaimTracker ?? null

  return { agent }
}

// ── MCP Initialization ─────────────────────────────────────────

export async function initializeMcp(
  config: Config,
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
  refs: RuntimeRefs,
): Promise<void> {
  if (!config.mcp.enabled || Object.keys(config.mcp.servers).length === 0) return

  try {
    const { McpManager } = await import('./mcp/manager.js')
    const mgr = new McpManager(config.mcp)
    refs.mcpManager = mgr

    await mgr.initialize()
    const mcpTools = mgr.getAllTools()
    for (const tool of mcpTools) {
      toolRegistry.register(tool)
    }

    const states = mgr.getStates()
    const connected = states.filter(s => s.status === 'connected')
    const failed = states.filter(s => s.status === 'error')
    if (connected.length > 0 || failed.length > 0) {
      const parts: string[] = []
      if (connected.length > 0) {
        const toolCount = connected.reduce((s, c) => s + c.toolCount, 0)
        parts.push(`${connected.length} server(s) connected (${toolCount} tools)`)
      }
      if (failed.length > 0) {
        parts.push(`${failed.length} server(s) failed: ${failed.map(s => `${s.serverId}: ${s.error}`).join(', ')}`)
      }
      // Use debugLog instead of console.error — console.error writes directly
      // to stderr, bypassing the LiveEngine's row management. When MCP loads
      // asynchronously after the TUI's first frame, this rogue line corrupts
      // the engine's cursor tracking, causing double-border ghost rendering
      // on the next slash-command redraw.
      debugLog(`[MCP] ${parts.join('; ')}`)
    }
  } catch (err) {
    console.error('[MCP] Initialization failed:', (err as Error).message)
  }
}

// ── LSP Initialization ─────────────────────────────────────────

export async function initializeLsp(
  cwd: string,
  toolRegistry: ReturnType<typeof createDefaultToolRegistry>,
): Promise<ReturnType<typeof createLspManager>> {
  // Polyglot: the multi-language manager routes each file to its matching
  // server (typescript-language-server / pyright / gopls / rust-analyzer /
  // clangd / jdtls), lazily spawning installed ones on first use.
  const lspManager = createMultiLspManager(cwd)

  try {
    await lspManager.initialize()
    if (lspManager.isReady()) {
      toolRegistry.register(createGotoDefinitionTool(lspManager))
      toolRegistry.register(createFindReferencesTool(lspManager))
      if (process.env['RIVET_DEBUG']) {
        const servers = availableServers().map(s => s.id).join(', ')
        console.error(`[LSP] polyglot LSP ready — available servers: ${servers}`)
      }
    } else if (process.env['RIVET_DEBUG']) {
      console.error('[LSP] no language servers installed — code-intelligence tools not registered')
    }
  } catch (err) {
    console.error('[LSP] Initialization error:', (err as Error).message)
  }

  return lspManager
}

// ── Session Infrastructure ─────────────────────────────────────

export async function createSessionInfrastructure(): Promise<{
  registry: import('./agent/session-registry.js').SessionRegistry
  sessionId: string
  heartbeatInterval: ReturnType<typeof setInterval>
}> {
  const stateDirPath = stateDir()
  const { SessionRegistry } = await import('./agent/session-registry.js')
  // Reap dead sessions' registry rows/claims so they don't block fresh claims.
  // Default startup is fresh — we do NOT auto-resume crashed sessions; this only
  // releases their locks. Recover a crashed session explicitly with
  // `rivet --continue` (most recent) or `rivet --resume <id>`.
  const registry = await SessionRegistry.createWithReap(stateDirPath, (crashedSessions) => {
    // 一行短提示即可——恢复入口（--continue/--resume）在 /help 与历史会话提示里都有。
    console.error(`↺ 已清理 ${crashedSessions.length} 个异常退出会话的锁定`)
  })

  const sessionId = getOrCreateSessionId()
  registry.register(sessionId, process.cwd())

  const heartbeatInterval = setInterval(() => {
    try { registry.heartbeat(sessionId) } catch { /* ignore */ }
  }, 10_000).unref()

  return { registry, sessionId, heartbeatInterval }
}

// ── Shutdown Handler ───────────────────────────────────────────

/** H2 瘦身版证据验真器：对既有账本（recentToolHistory / ObligationStore）
 *  验真 attack_case 的 evidence_ref，不建第二套事件注册表。
 *  tool: 引用按工具名 + 目标提示对最近历史窗口匹配（窗口淘汰 = unverified
 *  零分，不算伪造）；obligation: 对义务账本查 id。 */
function makeAttackEvidenceVerifier(agent: AgentLoop): import('./tools/attack-case.js').AttackEvidenceVerifier {
  return {
    toolRan: (name, targetHint) => agent.recentToolHistory.some(e => {
      if (e.tool !== name) return false
      if (!targetHint || !e.target) return true
      return e.target.includes(targetHint) || targetHint.includes(e.target)
    }),
    obligationExists: id => agent.obligations.getStore().obligations.some(o => o.id === id),
    // H4-D4：worker 引用验真——该 orderId 必须已完成（不是仅"会话曾委派"）
    workerCompleted: orderId => agent.problemAttack.hasWorkerCompleted(orderId),
    // P4 收束闸：close(converged) 回执的"先核销再交付"提示数据源
    openObligationIdsForTargets: targets => agent.obligations.getStore().obligations
      .filter(o => (o.state === 'open' || o.state === 'attempted')
        && o.targets.some(t => targets.some(ht => t.includes(ht) || ht.includes(t))))
      .map(o => o.id),
  }
}

export function createShutdownHandler(ctx: BootstrapContext): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined
  return () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      try {
        // Mark a clean exit. Next startup mints a fresh session by default;
        // returning here requires explicit --continue / --resume <id> (R1).
        try { ctx.persist.updateMetadata({ cleanExit: true }) } catch { /* best-effort */ }
        // resume 缓存继承的 shutdown flush：覆盖 collapse watermark 等不经
        // commit 钩子的漂移（边界写由 wireFrozenSnapshotPersist 已覆盖）。
        try { ctx.persist.writeFrozenSnapshot(ctx.agent.config.promptEngine.exportFrozenSnapshot()) } catch { /* best-effort */ }
        ctx.persist.compactOai(ctx.session.getMessages())
        if (ctx.fileHistory) {
          persistFileHistory(
            join(getSessionDir(ctx.cwd), ctx.sessionId, 'file-history.json'),
            ctx.fileHistory.getAllSnapshots(),
          )
        }
        ctx.agent.flushStigmergySync()
        ctx.agent.abort()
      } catch (err) {
        try { process.stderr.write(`[shutdown] callback error: ${(err as Error)?.message}\n`) } catch { /* noop */ }
      } finally {
        if (ctx.heartbeatInterval) clearInterval(ctx.heartbeatInterval)
        try { ctx.refs.lspManager?.dispose() } catch { /* best-effort */ }
        try { ctx.refs.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
        void ctx.refs.mcpManager?.shutdown?.()
        // Wait for coordinator finally blocks so session claims are released
        // before a handoff or the next process can enter this workspace.  Do
        // not unregister on a timeout: an abort is advisory for providers that
        // ignore AbortSignal, and their worker may still be writing files.
        let workersSettled = !ctx.refs.coordinator
        try {
          if (ctx.refs.coordinator?.shutdownAndWait) {
            workersSettled = await ctx.refs.coordinator.shutdownAndWait()
          } else if (ctx.refs.coordinator) {
            ctx.refs.coordinator.shutdown()
            workersSettled = false
          }
        } catch {
          workersSettled = false
        }
        let mainRunSettled = false
        try { mainRunSettled = !ctx.agent.isRunning() } catch { /* fail closed */ }
        if (workersSettled && mainRunSettled) {
          try { ctx.refs.sessionRegistry?.unregister(ctx.sessionId) } catch { /* best-effort */ }
        }
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false)
        }
        killAllSync()
        // Note: does NOT call process.exit — callers should do so after additional cleanup
      }
    })()
    return shutdownPromise
  }
}

// ── Model Switch (T9 + React 共用) ─────────────────────────────

export interface SwitchModelResult {
  ok: boolean
  error?: string
  /** 成功时返回的展示名（alias 优先）与上下文窗口，供 UI 刷新 */
  modelName?: string
  contextWindow?: number
}

/** 跨 provider 解析模型 + 凭证（switchAgentRuntime 与 resume 原模型恢复共用）。
 *  模型不在任何 provider → null；找到但 API key 缺失 → { error }（oauth 免 key）；
 *  命中且凭证就绪 → 完整解析（provider/apiKey/auth 已按目标 provider 摆正）。 */
export interface ResolvedModelTarget {
  provider: ProviderConfig
  providerName: string
  apiKey: string
  auth: AuthProvider | undefined
  modelId: string
  alias?: string
  contextWindow?: number
}
export function resolveProviderForModel(ctx: Pick<BootstrapContext, 'config' | 'provider' | 'apiKey' | 'auth'>, modelId: string, targetProvider?: string): ResolvedModelTarget | { error: string } | null {
  // Accept the `provider:modelId` / `provider:alias` form used by desktop
  // session records. Before this parse, "deepseek:deepseek-v4-flash" never
  // matched any provider model entry (id was compared with the prefix still
  // attached) — the same false negative behind the 2026-09-08 resume failure.
  const colon = modelId.indexOf(':')
  const pinnedProvider = colon > 0 ? modelId.slice(0, colon) : undefined
  const modelRef = pinnedProvider ? modelId.slice(colon + 1) : modelId
  const providerFilter = targetProvider ?? pinnedProvider
  if (!modelRef) return null

  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    if (providerFilter && provName !== providerFilter) continue
    const found = prov.models.find(m => m.id === modelRef || m.alias === modelRef)
    if (!found) continue
    let provider = ctx.provider
    let apiKey = ctx.apiKey
    let auth = ctx.auth
    if (prov.auth?.type === 'oauth') {
      if (provName !== ctx.provider.name) {
        provider = prov
        apiKey = ''
        auth = createAuthProvider(prov.auth, process.env, prov.apiKey)
      }
    } else {
      const provKey = prov.apiKey ?? process.env[prov.apiKeyEnv ?? ''] ?? (() => {
        try { return resolveApiKey(prov) } catch { return undefined }
      })()
      if (!provKey) {
        return { error: `API key not set for ${provName}. Set ${prov.apiKeyEnv ?? 'apiKey'} in config or environment.` }
      }
      if (provName !== ctx.provider.name || provKey !== apiKey) {
        provider = prov
        apiKey = provKey
        auth = undefined
      }
    }
    return { provider, providerName: provName, apiKey, auth, modelId: found.id, alias: found.alias, contextWindow: found.contextWindow }
  }
  return null
}

/**
 * 跨 provider 查找并切换模型 —— 重建 AgentLoop（与 React main.tsx 的 useMemo 重建同构，
 * 不存在仅热换 client 的轻量路径）。成功时**原地更新** ctx 的 agent/provider/apiKey/auth，
 * 使所有持有 ctx 引用的闭包（onSubmit/onAbort）自动用上新 agent。
 *
 * session / persist / toolRegistry / refs / fileHistory 等全部复用，前缀缓存与历史不受影响。
 */
export function switchAgentRuntime(ctx: BootstrapContext, modelId: string, targetProvider?: string): SwitchModelResult {
  // 切换前记录当前模型 id，供 JSONL 审计事件的 from 字段。
  let fromModel: string | undefined
  try { fromModel = ctx.agent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }
  const resolved = resolveProviderForModel(ctx, modelId, targetProvider)
  if (!resolved) return { ok: false, error: `Model "${modelId}" not found in any provider.` }
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { provider, apiKey, auth, providerName: provName } = resolved

  // Wave K (P0 同源修复): createAgentRuntime 内部会 new DelegationCoordinator
    // 写入 refs.coordinator，旧 coordinator 被覆盖但其 stallSweep 定时器与在途
    // worker AbortController 仍在持有句柄。TUI 单 session 进程 + switch 频率低，
    // 影响有限——但与 sidecar 同源 (serve.ts 已修)，一并对齐避免长会话切换密集
    // 场景累积泄漏。
    const oldCoordinator = ctx.refs.coordinator
    // 旧 agent 的 fs.watch 句柄随丢弃释放（三条 switch 路径统一纪律）。
    try { ctx.agent.stopFsWatcher() } catch { /* best-effort */ }
    // config 热载 watcher 同款释放：不关则旧实例 watcher 僵尸存活，继续回调死管线。
    try { ctx.agent.stopConfigWatcher() } catch { /* best-effort */ }

    const { agent } = createAgentRuntime({
      provider,
      apiKey,
      auth,
      config: ctx.config,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      toolRegistry: ctx.toolRegistry,
      persist: ctx.persist,
      claimStore: ctx.claimStore,
      fileHistory: ctx.fileHistory,
      refs: ctx.refs,
      domainKnowledgeStore: ctx.domainKnowledgeStore,
      modelId: resolved.modelId,
      session: ctx.session,
      onStatusLine: text => ctx.setStatusLine?.(text),
    })

    // 搬运后台 job 注册表到新 agent：不搬则新 AgentLoop 自建空 SessionJobs，
    // 旧 agent 上在跑的后台 job 被孤立（仍在跑但无人管理/无事件）。setJobs 会
    // 复用旧实例（其 EventEmitter 监听器保持有效，TUI 订阅在 main 侧按 attach
    // 幂等重挂）。
    const carriedJobs = ctx.agent.jobs
    if (carriedJobs) { try { agent.setJobs(carriedJobs) } catch { /* best-effort */ } }

    ctx.agent = agent
    ctx.refs.promptEngine = agent.config.promptEngine
    // /model 切换后新引擎重新积累冻结快照——不接线则盘存文件停留在旧引擎状态。
    wireFrozenSnapshotPersist(ctx.persist, agent.config.promptEngine)
    ctx.refs.getTaskContract = () => agent.getTaskContract()
    ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
    ctx.refs.getSessionVitals = () => agent.getSessionVitals()
    ctx.refs.getProblemAttackStore = () => agent.problemAttack
    ctx.refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)
    ctx.provider = provider
    ctx.apiKey = apiKey
    ctx.auth = auth

    // 同一身份判等防御：若装配未实际替换 coordinator（理论不该发生），不动旧的。
    if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
      try { oldCoordinator.shutdown() } catch { /* best-effort: shutdown is fail-open */ }
    }

    // 持久化切换：metadata.model/provider 反映当前模型（会话恢复/列表显示用），
    // 并在 JSONL 落一条审计事件（每次切换可溯源）。best-effort，不阻塞切换。
    try {
      ctx.persist.updateMetadata({ model: resolved.modelId, provider: provName })
      ctx.persist.appendModelSwitch({ from: fromModel, to: resolved.modelId, provider: provName })
    } catch { /* persistence is best-effort — never block a model switch */ }

    return { ok: true, modelName: resolved.alias ?? resolved.modelId, contextWindow: resolved.contextWindow }
}

export interface SwitchSessionResult {
  ok: boolean
  error?: string
  /** 成功时:载入的消息条数 / 是否做了 orphan 修复 / preflight 是否 apiSafe */
  messageCount?: number
  repaired?: boolean
  safe?: boolean
}

/**
 * 运行时会话身份切换（TUI /resume <id>）。与 switchAgentRuntime 同构:通过
 * createAgentRuntime 整体重建 AgentLoop —— 构造函数内部按 targetId 重建所有
 * sessionId-bound 子系统(persist / telemetryWriter / stigmergyStore /
 * artifactStore / sessionStateManager 与持久化监听),从此 会话id = 日志id =
 * pointer id = registry id 名副其实,彻底修掉"看着是旧会话、其实写进原 id"的身份分裂。
 *
 * targetId 必须是已解析的完整 id(调用方用 SessionPersist.resolveSessionId 解析短前缀)。
 * resume 全量 replay 目标历史(显式代价、会重建前缀缓存),不跨会话吃当前上下文。
 */
export interface StartupResumeModelDecision {
  target: ResolvedModelTarget | null
  originalModel?: string
  fallbackUsed: boolean
  degradedWarning?: string
}

/**
 * 启动 resume 模型亲和决策（纯函数，可测）：前缀缓存是 per-model 命名空间，
 * resume 不换回原模型，继承的冻结快照也落不进缓存。显式 --model/--provider
 * 优先（用户意图 > 缓存亲和）；原模型不可用走 resumeFallbackModel 兜底；
 * 兜底也没有 → 警告降级（不 fail-closed——startup 是进程入口，拒跑等于
 * 会话打不开，用户连开新会话都要绕路 --new；与 switchAgentSession 的
 * fail-closed 语义差异是刻意的）。
 */
export function decideStartupResumeModel(input: {
  resumed: boolean
  explicitModel?: string
  explicitProvider?: string
  originalModel?: string
  fallbackModelId?: string
  resolve: (modelId: string) => ResolvedModelTarget | { error: string } | null
}): StartupResumeModelDecision {
  if (!input.resumed || input.explicitModel || input.explicitProvider) {
    return { target: null, fallbackUsed: false }
  }
  if (!input.originalModel) return { target: null, fallbackUsed: false }
  const hit = input.resolve(input.originalModel)
  if (hit && !('error' in hit)) {
    return { target: hit, originalModel: input.originalModel, fallbackUsed: false }
  }
  const fb = input.fallbackModelId ? input.resolve(input.fallbackModelId) : null
  if (fb && !('error' in fb)) {
    return { target: fb, originalModel: input.originalModel, fallbackUsed: true }
  }
  return {
    target: null,
    originalModel: input.originalModel,
    fallbackUsed: false,
    degradedWarning: `⚠ 原模型 ${input.originalModel} 当前不可用，且未配置续跑兜底模型（agent.resumeFallbackModel）——按默认模型续跑，前缀缓存将全量重建。`,
  }
}

export function switchAgentSession(ctx: BootstrapContext, targetId: string): SwitchSessionResult {
  if (targetId === ctx.sessionId) {
    return { ok: false, error: '已经在该会话中。' }
  }

  let targetPersist: SessionPersist
  try {
    targetPersist = new SessionPersist(targetId, ctx.cwd)
  } catch (err) {
    return { ok: false, error: `无法打开会话 ${targetId.slice(0, 8)}: ${(err as Error).message}` }
  }

  // 跨 cwd 守卫:别让别的项目会话渗进当前 cwd。
  const meta = targetPersist.loadMetadata()
  if (meta?.cwd && meta.cwd !== ctx.cwd) {
    return { ok: false, error: '该会话属于其他工作目录,拒绝载入。' }
  }

  // 缓存亲和（2026-07-25，对齐桌面 resumeRun 硬契约）：resume 切回目标会话记录的
  // 原模型——旧语义「仅换身份、保留当前模型」（da015480 起）会把整段历史塞进
  // 错误前缀全量重建（~10x 成本），事后再切回又烧一次。meta 无 model 记录（旧
  // 会话）退回保留当前模型；原模型不可用走 agent.resumeFallbackModel 兜底（落
  // 审计），无兜底 fail-closed——宁可拒绝续跑也不静默换前缀。重建前判定，失败零成本。
  const originalModel = meta?.model
  let resumeTarget: ResolvedModelTarget | null = null
  let resumeFallbackUsed = false
  if (originalModel) {
    const hit = resolveProviderForModel(ctx, originalModel)
    if (hit && !('error' in hit)) {
      resumeTarget = hit
    } else {
      const fallbackId = ctx.config.agent?.resumeFallbackModel
      const fb = fallbackId ? resolveProviderForModel(ctx, fallbackId) : null
      if (fb && !('error' in fb)) {
        resumeTarget = fb
        resumeFallbackUsed = true
      } else {
        return {
          ok: false,
          error: `原模型 ${originalModel} 当前不可用，且未配置续跑兜底模型（agent.resumeFallbackModel）——请开新会话继续`,
        }
      }
    }
  }

  const rawMsgs = targetPersist.loadOai()
  const preflight = runResumePreflightOai(rawMsgs, { writeProbe: createWriteEvidenceProbe(ctx.cwd) })
  // 2026-09-08 磁盘对账：崩溃后工作区可能领先于会话记录。把近期、且历史里
  // 从未提及的产物主动告诉模型——先 read_file 核实，避免把已完成工作重做。
  //
  // 只在**上次非正常退出**时扫（与 serve 侧 restoreHistoryMessages 同一判据，
  // 见 shouldReconcileDisk）：findRecentUnrecordedWrites 是同步全树遍历
  // （readdirSync + 逐文件 statSync，实测本仓 5000 文件 270~447ms 阻塞事件
  // 循环），正常切换会话不该付这个成本。
  const resumeMeta = targetPersist.loadMetadata()
  let messagesToRestore = preflight.messages
  if (shouldReconcileDisk(resumeMeta)) {
    const recentSinceMs = resumeMeta?.updatedAt ? resumeMeta.updatedAt - 10 * 60 * 1000 : undefined
    const recentWrites = findRecentUnrecordedWrites(ctx.cwd, preflight.messages, { sinceMs: recentSinceMs })
    const diskNote = formatDiskReconciliationNote(recentWrites)
    if (diskNote) {
      messagesToRestore = [...preflight.messages, { role: 'user' as const, content: diskNote }]
    }
  }

  // 目标会话无 model 记录（旧会话）时保留当前模型。
  let currentModelId: string | undefined
  try { currentModelId = ctx.agent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }

  // flush 旧会话的 volatile store(信息素),避免切换丢数据。
  try { ctx.agent.stigmergyStore.flushSync() } catch { /* best-effort */ }
  // 旧 agent 的 fs.watch 句柄随丢弃释放（三条 switch 路径统一纪律）。
  try { ctx.agent.stopFsWatcher() } catch { /* best-effort */ }
  // config 热载 watcher 同款释放：不关则旧实例 watcher 僵尸存活，继续回调死管线。
  try { ctx.agent.stopConfigWatcher() } catch { /* best-effort */ }

  const oldId = ctx.sessionId
  // Wave K (P0 同源修复): 与 switchAgentRuntime 同源——createAgentRuntime 会
  // new DelegationCoordinator 写入 refs.coordinator，需在装新后关闭旧的避免
  // stallSweep 定时器 + 在途 worker 句柄泄漏。
  const oldCoordinator = ctx.refs.coordinator

  // 整体重建 AgentLoop —— 构造函数内部按 targetId 重建子系统并重挂持久化监听。
  // 冻结快照随目标会话落盘读回（无文件/坏文件 → undefined → 旧的 byte-0 重建）。
  const { agent } = createAgentRuntime({
    provider: resumeTarget?.provider ?? ctx.provider,
    apiKey: resumeTarget?.apiKey ?? ctx.apiKey,
    auth: resumeTarget ? resumeTarget.auth : ctx.auth,
    config: ctx.config,
    sessionId: targetId,
    cwd: ctx.cwd,
    toolRegistry: ctx.toolRegistry,
    persist: targetPersist,
    claimStore: ctx.claimStore,
    fileHistory: ctx.fileHistory,
    refs: ctx.refs,
    domainKnowledgeStore: ctx.domainKnowledgeStore,
    modelId: resumeTarget?.modelId ?? currentModelId,
    session: ctx.session,
    inheritFrozenFrom: targetPersist.readFrozenSnapshot(),
    onStatusLine: text => ctx.setStatusLine?.(text),
  })

  // 原地更新 ctx —— 持有 ctx 引用的闭包(onSubmit/onAbort/handlerCtx)即时一致。
  ctx.agent = agent
  ctx.persist = targetPersist
  ctx.sessionId = targetId
  ctx.refs.sessionId = targetId
  ctx.refs.promptEngine = agent.config.promptEngine
  wireFrozenSnapshotPersist(targetPersist, agent.config.promptEngine)
  ctx.refs.getTaskContract = () => agent.getTaskContract()
  ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  ctx.refs.getSessionVitals = () => agent.getSessionVitals()
  ctx.refs.getProblemAttackStore = () => agent.problemAttack
  ctx.refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)
  // resume 换到原模型的 provider 时，后续切换/重建的基线凭证同步摆正
  //（同 switchAgentRuntime 的原地更新纪律）。
  if (resumeTarget) {
    ctx.provider = resumeTarget.provider
    ctx.apiKey = resumeTarget.apiKey
    ctx.auth = resumeTarget.auth
  }
  // 兜底模型续跑：meta + JSONL 审计，对齐桌面 resume-fallback 语义。
  if (resumeFallbackUsed && resumeTarget) {
    try {
      targetPersist.updateMetadata({ model: resumeTarget.modelId, provider: resumeTarget.providerName })
      targetPersist.appendModelSwitch({ from: originalModel, to: resumeTarget.modelId, provider: resumeTarget.providerName })
    } catch { /* best-effort */ }
  }

  // 星域恢复（2026-07-25）：resume 恢复原域，不重新路由——重路由落点与旧域
  // 不同 = 前缀再碎一次。meta.domain 由 setSessionDomain/bindSessionDomain 变更
  // 即写（shutdown 另有兜底）；无记录按配置默认钉定（defaultDomain 非 auto 时），
  // auto 保持未钉定维持重路由语义。恢复失败不阻断会话切换。
  try {
    const configuredDefault = ctx.config.agent?.defaultDomain
    const defaultPinned = configuredDefault && configuredDefault !== 'auto'
      ? starDomainRegistry.get(configuredDefault)
      : undefined
    const restoredDomain = (meta?.domain ? starDomainRegistry.get(meta.domain) : undefined) ?? defaultPinned
    if (restoredDomain) {
      agent.setSessionDomain({
        id: restoredDomain.id as import('./agent/star-domain.js').StarDomainId,
        name: restoredDomain.name,
        volatileBlock: restoredDomain.volatileBlock,
        motto: restoredDomain.motto,
        courageThreshold: restoredDomain.courageThreshold,
      })
    }
  } catch { /* domain restore best-effort */ }

  // 同一身份判等防御：装配实际替换 coordinator 才关旧的。
  if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
    try { oldCoordinator.shutdown() } catch { /* best-effort */ }
  }

  // 载入历史 —— 新 AgentLoop 的持久化监听会把 replace 镜像回 targetPersist。
  ctx.session.replaceMessages(messagesToRestore)

  // pointer + registry + 缓存 sessionId 一并切到 targetId,使下次 --continue 命中它。
  try { writeFileSync(lastSessionPointerFile(ctx.cwd), targetId) } catch { /* ignore */ }
  _cachedSessionId = targetId
  _sessionWasResumed = true
  try {
    ctx.refs.sessionRegistry?.unregister(oldId)
    ctx.refs.sessionRegistry?.register(targetId, ctx.cwd)
  } catch { /* registry best-effort */ }

  return {
    ok: true,
    messageCount: messagesToRestore.length,
    repaired: preflight.repaired,
    safe: preflight.safe,
  }
}

// ── Plan-mode restore（resume/切换会话共用）─────────────────────

/**
 * Re-enter plan mode from persisted session metadata after a resume or an
 * in-app session switch. The runtime plan-mode state lives in AgentLoop memory
 * and dies with the process; the meta mirror (written by syncPlanModeToConfig)
 * lets us restore it. Returns the restored draft path, or null when the session
 * was not planning / the draft file no longer exists (silent downgrade to off).
 */
export function restorePlanModeFromMeta(
  agent: AgentLoop,
  cwd: string,
  meta: Pick<import('./context/types.js').SessionMetadata, 'planModeState' | 'activePlanFilePath'> | null | undefined,
): string | null {
  if (meta?.planModeState !== 'planning' || !meta.activePlanFilePath) return null
  const rel = meta.activePlanFilePath.replace(/\\/g, '/')
  if (!existsSync(join(cwd, rel))) return null
  agent.enterPlanMode({ planFilePath: rel })
  return rel
}

// ── /cd：会话中途切换工作目录（保前缀缓存）──────────────────────

export interface SwitchCwdResult {
  ok: boolean
  error?: string
  from?: string
  to?: string
  /** 迁移到新 slug 目录的会话文件（相对名）。 */
  movedFiles?: string[]
}

/**
 * 运行时工作目录切换（TUI /cd）。与 switchAgentSession 同构——经
 * createAgentRuntime 整体重建 AgentLoop，让 ~12 个构造期绑定 cwd 的子系统
 * （工具执行/路径校验/hooks/persist/stigmergy/artifact/telemetry…）一次性
 * 指向新目录，杜绝原地变异漏改。
 *
 * 缓存语义（与 /resume 的本质区别）：新 PromptEngine 经 inheritFrozenFrom
 * 继承旧引擎的 frozen 快照 + T7 水位——历史 user 消息字节不变，前缀只在新
 * user 边界断尾（同 /domain 切换代价），不是 /resume 的 byte-0 全 miss。
 * 新边界的 volatile 块按新 cwd 重采（AGENTS.md/verify/project-memory 等），
 * 对模型是诚实的。
 *
 * 会话归属：会话文件迁移到新 slug 目录（move 语义），meta.cwd/pointer/
 * registry 同步——新项目的 /resume 与 --continue 从此看到本会话。
 */
export async function switchAgentCwd(ctx: BootstrapContext, target: string): Promise<SwitchCwdResult> {
  // 1. 解析目标路径（~ 展开 + 相对当前 cwd）并校验。
  const expanded = target.startsWith('~') ? target.replace(/^~(?=$|[\\/])/, homedir()) : target
  const newCwd = resolve(ctx.cwd, expanded)
  if (newCwd === ctx.cwd) {
    return { ok: false, error: '已经在该目录中。' }
  }
  if (!existsSync(newCwd) || !statSync(newCwd).isDirectory()) {
    return { ok: false, error: `目录不存在：${newCwd}` }
  }
  // 2. worker 存活守卫——worker 会话/artifact 绑定旧 cwd，切换会留孤儿。
  if (ctx.refs.coordinator?.hasRunningWork()) {
    return { ok: false, error: '仍有运行中的 worker，请先等待完成或用 /tasks 停止后再切换目录。' }
  }
  // 2b. plan mode 守卫——计划文件在旧项目 .rivet/plans/ 下（activePlanFilePath
  //     是相对路径），切目录后新旧项目都找不对它。先 close/approve 再切换。
  if (ctx.agent.getPlanModeState() !== 'off') {
    return { ok: false, error: 'Plan Mode 进行中（计划文件属于当前项目）。请先 /plan-close 关闭或完成审批后再切换目录。' }
  }

  const oldCwd = ctx.cwd
  const sessionId = ctx.sessionId

  // 3. flush 旧会话信息素（写入旧路径后再迁移，次序不可换）+ drain 排队中的
  //    异步持久化写（否则迁移后队列落盘会在旧路径重建出悬空 jsonl）。
  try { ctx.agent.stigmergyStore.flushSync() } catch { /* best-effort */ }
  try { await ctx.agent.drainPersistWrites() } catch { /* best-effort */ }

  // 4. 迁移会话文件到新 slug 目录（失败则拒绝切换——半迁移比不切换更糟）。
  let movedFiles: string[] = []
  try {
    movedFiles = migrateSessionFiles(sessionId, oldCwd, newCwd).moved
  } catch (err) {
    return { ok: false, error: `会话文件迁移失败: ${(err as Error).message}` }
  }

  // 5. 新 cwd 的 persist + 整体重建（新 volatile 快照、新工具/hooks cwd），
  //    frozen 快照继承保历史前缀。模型保持不变。
  let currentModelId: string | undefined
  try { currentModelId = ctx.agent.config.promptEngine.getModel() } catch { /* idle/未初始化 */ }
  const oldEngine = ctx.agent.config.promptEngine
  const oldCoordinator = ctx.refs.coordinator
  const newPersist = new SessionPersist(sessionId, newCwd)

  const { agent } = createAgentRuntime({
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    config: ctx.config,
    sessionId,
    cwd: newCwd,
    toolRegistry: ctx.toolRegistry,
    persist: newPersist,
    claimStore: ctx.claimStore,
    fileHistory: ctx.fileHistory,
    refs: ctx.refs,
    domainKnowledgeStore: ctx.domainKnowledgeStore,
    modelId: currentModelId,
    session: ctx.session,
    inheritFrozenFrom: oldEngine,
  })

  // 6. 原地更新 ctx —— 持有 ctx 引用的闭包（onSubmit/handlerCtx）即时一致。
  const oldAgent = ctx.agent
  const oldLspManager = ctx.refs.lspManager
  ctx.agent = agent
  ctx.persist = newPersist
  ctx.cwd = newCwd
  ctx.refs.promptEngine = agent.config.promptEngine
  wireFrozenSnapshotPersist(newPersist, agent.config.promptEngine)
  ctx.refs.getTaskContract = () => agent.getTaskContract()
  ctx.refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  ctx.refs.getSessionVitals = () => agent.getSessionVitals()
  ctx.refs.getProblemAttackStore = () => agent.problemAttack
  ctx.refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)

  if (oldCoordinator && oldCoordinator !== ctx.refs.coordinator) {
    try { oldCoordinator.shutdown() } catch { /* best-effort */ }
  }
  // 旧 agent 的 fs.watch 句柄随丢弃释放（/model、/resume 同款统一纪律）。
  try { oldAgent.stopFsWatcher() } catch { /* best-effort */ }
  // config 热载 watcher 同款释放：不关则旧实例 watcher 僵尸存活，继续回调死管线。
  try { oldAgent.stopConfigWatcher() } catch { /* best-effort */ }

  // 7. 会话归属账本：meta.cwd（跨 cwd resume 守卫读它）+ pointer + registry。
  try { newPersist.updateMetadata({ cwd: newCwd }) } catch { /* best-effort */ }
  try { writeFileSync(lastSessionPointerFile(newCwd), sessionId) } catch { /* ignore */ }
  try {
    // 旧 pointer 若仍指向本会话则清除——旧项目 --continue 不应再找回它。
    const oldPointer = lastSessionPointerFile(oldCwd)
    if (existsSync(oldPointer) && readFileSync(oldPointer, 'utf-8').trim() === sessionId) {
      rmSync(oldPointer, { force: true })
    }
  } catch { /* ignore */ }
  try {
    ctx.refs.sessionRegistry?.unregister(sessionId)
    ctx.refs.sessionRegistry?.register(sessionId, newCwd)
  } catch { /* registry best-effort */ }

  // 8. LSP 按新 cwd 异步重建（复用启动路径的 re-attach + updateTools 模式），
  //    旧 manager 的语言服务器进程即时释放；Meridian/domain knowledge 换新。
  //    MCP 不动（进程级，配置来自启动 cwd——见设计文档「明确不做」）。
  initializeLsp(newCwd, ctx.toolRegistry).then(lsp => {
    ctx.refs.lspManager = lsp
    agent.updateTools()
  }).catch(() => {})
  if (oldLspManager) {
    try { oldLspManager.dispose() } catch { /* best-effort */ }
  }
  try {
    ctx.meridianIndexer = new MeridianIndexer(newCwd)
    ctx.refs.meridianIndexer = ctx.meridianIndexer
    // P1-2：agent.config.meridianIndexer 在第 5 步 createAgentRuntime 时钉死（早于本步
    // refs 更新），不替换则写工具仍查旧 cwd 的 meridian.db（恒空且不回落）。随 refs
    // 一起换新实例——tool-pipeline 经 loop-factory 读 config.meridianIndexer。
    agent.config.meridianIndexer = ctx.meridianIndexer
  } catch { /* 索引器重建失败不阻断切换（repo 工具降级为空图） */ }
  try {
    ctx.domainKnowledgeStore = new DomainKnowledgeStore(join(newCwd, '.rivet', 'knowledge'))
    if (ctx.refs.domainKnowledgeStoreRef) ctx.refs.domainKnowledgeStoreRef.current = ctx.domainKnowledgeStore
  } catch { /* best-effort */ }

  // 9. 语义漂移护栏：提醒模型历史里的路径属于旧目录（functional 通道，
  //    不占 discipline 额度、不被限流吞掉）。
  ctx.session.appendSystemReminder(
    `工作目录已从 ${oldCwd} 切换到 ${newCwd}。此前上下文中的文件路径、工具结果与 claim 均属于旧目录；后续操作请基于新目录。`,
    'functional',
  )

  return { ok: true, from: oldCwd, to: newCwd, movedFiles }
}


// ── Aggregate Bootstrap ────────────────────────────────────────

/**
 * P1-6 全局并发闸输入：coordinator 的 maxWorkers 配置化。
 *
 * 读取优先级：config.agent.maxWorkers（schema 分片落地后生效，见
 * src/config/schema.ts agentSchema）→ 环境变量 RIVET_MAX_WORKERS → 默认 3。
 * 本函数只做解析与夹取，真正的全局并发信号量
 * （activeWorkerCount ≤ maxWorkers，delegate()/delegateBackground/后台
 * worker 统一入队等槽位）由 coordinator 层实现。非法值（非正整数）回退
 * 默认 3——fail-closed 保守侧。
 */
function resolveCoordinatorMaxWorkers(config: Config): number {
  const raw = (config.agent as { maxWorkers?: unknown }).maxWorkers
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw
  const envN = Number(process.env['RIVET_MAX_WORKERS'])
  if (Number.isInteger(envN) && envN >= 1) return envN
  return isRuntimeLeanAspect('pool', config.runtime?.lean) ? 1 : 3
}

/** S1 分池并发帽：只读/写工各自的可选池帽，缺省 undefined（= maxWorkers）。
 *  非法值回退缺省——fail-closed 保守侧。 */
function resolveCoordinatorPoolCaps(config: Config): { maxExploreWorkers?: number; maxWriteWorkers?: number } {
  const agent = config.agent as { maxExploreWorkers?: unknown; maxWriteWorkers?: unknown }
  const cap = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined
  return {
    ...(cap(agent.maxExploreWorkers) !== undefined ? { maxExploreWorkers: cap(agent.maxExploreWorkers) } : {}),
    ...(cap(agent.maxWriteWorkers) !== undefined ? { maxWriteWorkers: cap(agent.maxWriteWorkers) } : {}),
  }
}

export interface BootstrapOptions {
  cwd?: string
  args?: string[]
  modelId?: string
  providerName?: string
  /** If true, MCP and LSP are initialized asynchronously (non-blocking) */
  asyncExtras?: boolean
  /** 首启跳过 wizard 后降级启动：无 key 不抛错，让 TUI 先起来。
   *  发消息时报错指引配 key（与桌面端「先进界面再提醒」对齐）。 */
  allowMissingKey?: boolean
}

/**
 * 一站式初始化 — 返回 BootstrapContext。
 *
 * main-ansi.ts 直接 await 调用。
 * main.tsx 在 React hooks 内部调用（handleShutdown 使用返回的 shutdown）。
 */
export async function bootstrapInteractiveSession(opts: BootstrapOptions = {}): Promise<BootstrapContext> {
  const cwd = opts.cwd ?? process.cwd()

  // 1. HTTP Proxy
  setupHttpProxy()

  // 2. Config
  const config = loadRivetConfig(cwd, opts.args)
  setTargetConventions(config.editor.platform, config.editor.eol)
  applyConfiguredGitBashPath(config.env.gitBashPath)

  // 2026-09-07 语义：yolo = 完全权限（免审批 + 无写沙箱），approval 不再驱动沙箱。
  // agent.unsandboxed 保留为显式豁免（RIVET_SANDBOX=0）；沙箱只由 RIVET_SANDBOX=1 显式开启。
  // P1-1：显式 RIVET_SANDBOX 永远赢——仅当 env 未显式设置时才从 config 落默认。
  applyUnsandboxedEnvDefault(config.agent.unsandboxed === true)
  applySandboxPolicyForApprovalMode(config.agent.approval) // 兼容保留；函数当前为 no-op

  // Announce the command sandbox's protection level up-front. Stays silent when
  // a real kernel boundary is active; warns loudly (esp. on native Windows, or
  // when RIVET_SANDBOX was requested but no backend exists) — in that case
  // writes are unbounded and rollback is the only, after-the-fact, file-only
  // safety net.
  maybeWarnNoSandbox({ cwd })

  // Re-activate out-of-workspace path grants the user chose to "remember" for
  // this workspace, so previously-approved external paths work from turn one.
  loadPersistedGrants(cwd)
  // Standing config-declared grants (permissions.additionalReadDirs/WriteDirs):
  // Codex-style folder authorization without an approval round-trip.
  applyConfiguredPathGrants(config.agent.permissions)
  // Default read-only grants for common dependency/toolchain caches under $HOME
  // (.pub-cache, .cargo, .gradle, node package stores…). Lets read_file/grep
  // inspect third-party dependency source without hitting a hang-prone approval
  // gate — see path-grants.ts::applyDefaultDependencyReadGrants.
  applyDefaultDependencyReadGrants()
  // Read grants for dirs Rivet itself writes and then tells the model to read
  // back ($TMPDIR/rivet-raw full tool output). Without this the truncation
  // footer's `read_file <rawPath>` instruction is a closed dead end.
  applyRivetRuntimeReadGrants()

  // 3. Provider + Auth
  // 默认启动模型（config 驱动的一键启动）：`agent.defaultModel` 为
  // "provider:modelId" 格式——拆出 provider（作默认 provider 选择）与
  // modelId（作默认模型选择）。显式启动参数（--model/--provider）恒优先。
  // defaultDomain 的钉定在 bindSessionDomain（loop.ts）消费，无需在此处理。
  const defaultModelRef = config.agent.defaultModel
  const defaultModelParts = defaultModelRef && defaultModelRef.includes(':')
    ? {
        provider: defaultModelRef.slice(0, defaultModelRef.indexOf(':')),
        modelId: defaultModelRef.slice(defaultModelRef.indexOf(':') + 1),
      }
    : null
  const effectiveProviderName = opts.providerName ?? defaultModelParts?.provider
  const effectiveModelId = opts.modelId ?? defaultModelParts?.modelId

  const { provider, apiKey, auth } = resolveProviderAndAuth(config, effectiveProviderName, (opts.allowMissingKey ? { allowMissingKey: true } : {}))

  // 4. Session infrastructure
  const { registry: sessionRegistry, sessionId, heartbeatInterval } = await createSessionInfrastructure()

  // 4a. First-run template detection — set flag for TUI layer to prompt.
  // We only detect here; actual file creation + sentinel write happens in
  // main.ts after the user decides (so file creation and sentinel stay atomic).
  const templatesPendingAgents = needsTemplatesInit(cwd)

  // 5. Session persist + claim store
  const persist = new SessionPersist(sessionId, cwd)
  const claimStore = persist.createClaimStore()
  persist.injectDurableClaims(claimStore, cwd)
  for (const rule of loadProjectRules(cwd)) {
    claimStore.propose(rule)
  }
  // A3: no-test-infra advisory — recomputed live each session (disappears the
  // moment tests exist). Only for recognized languages: docs/unknown repos
  // would be pure noise. Makes the delivery-gate impact explicit and nudges
  // 主控 to offer a minimal test scaffold instead of silently degrading.
  try {
    const fp = detectProjectFingerprint(cwd)
    if (fp.language !== 'unknown' && !fp.hasTestInfra) {
      const now = Date.now()
      claimStore.propose({
        kind: 'project_rule',
        scope: 'project',
        text: `本项目（${fp.language}）未检测到测试基础设施。影响：deliver_task 交付门禁会因无验证证据降级为 YELLOW。首次合适时机向用户说明此影响，并主动提出「要我帮你搭一个最小测试骨架吗」（不强制——尊重用户选择，但让影响显性化）。`,
        confidence: 1.0,
        fitness: 5,
        source: { actor: 'hook', sessionId: 'project', turn: 0, eventId: 'fingerprint:no-test-infra' },
        evidence: [{ id: 'fingerprint:no-test-infra', kind: 'file', summary: `project fingerprint: language=${fp.language}, hasTestInfra=false`, path: cwd, createdAt: now }],
        createdAt: now,
        tags: ['no_test_infra'],
      })
    }
  } catch { /* advisory only — never block bootstrap */ }
  const skillLoad = loadProjectSkills(cwd, { importFromClaude: config.skills?.importFromClaude })
  if (skillLoad.loaded.length > 0 && process.env['RIVET_DEBUG']) {
    // 常规启动不打（/skills 可随时查看已加载技能）——首屏保持干净。
    console.error(`[skills] Loaded ${skillLoad.loaded.length} skill(s)`)
  }
  for (const err of skillLoad.errors) {
    console.warn(`[skills] ${err}`)
  }
  const fileHistory = new FileHistory(persist.getBackupDir(), sessionId)
  const session = new SessionContext()

  // Load prior messages. When the session id was explicitly resumed
  // (--continue / --resume <id>), this rehydrates that session's history.
  const existingMessages = persist.loadOai()
  // resume 缓存继承的读侧：冻结前缀快照随会话落盘（<id>.frozen.json），
  // 有则经 inheritFrozenFrom 喂给新引擎——历史 user 消息恢复原始字节，
  // 服务商缓存 TTL 内不再 byte-0 全 miss；无快照/坏文件降级为旧行为。
  const resumedFrozen = wasSessionResumed() ? persist.readFrozenSnapshot() : undefined
  if (existingMessages.length > 0) {
    session.replaceMessages(existingMessages)
    if (wasSessionResumed()) {
      const anchorNote = resumedFrozen
        ? `继承 ${resumedFrozen.frozenUserMerged.reduce((n, [, arr]) => n + arr.length, 0)} 个前缀锚点`
        : '无冻结快照，将重建前缀缓存'
      console.error(`🔄 已恢复会话 ${sessionId.slice(0, 8)}: ${existingMessages.length} 条消息（${anchorNote}）。默认启动为全新会话；指定会话用 rivet --resume <id>,查看列表用 rivet --list。`)
    }
  }

  // Evict old sessions
  evictOldSessions(sessionId, cwd)

  // Clean up stale worker session directories under ~/.rivet/sessions/<slug>/.
  // Worker sessions create worker-xxx/ (pheromones, sensorium).
  cleanupStaleWorkerSessionDirs(cwd)

  // Clean up orphaned files
  const rivetDir = join(cwd, '.rivet')
  const dirsToScan = [
    rivetDir,
    join(rivetDir, 'sessions'),
    join(rivetDir, 'artifacts'),
    join(rivetDir, 'checkpoints'),
  ]
  const tmpCleaned = cleanupOrphanedTmpFiles(dirsToScan)
  if (tmpCleaned > 0) {
    console.error(`[startup] Cleaned ${tmpCleaned} orphaned .tmp file(s)`)
  }
  const artifactCleaned = cleanupOldArtifactSessions(join(rivetDir, 'artifacts'), sessionId)
  if (artifactCleaned > 0) {
    console.error(`[startup] Cleaned ${artifactCleaned} old artifact session(s)`)
  }

  // 6. Meridian indexer
  const meridianIndexer = new MeridianIndexer(cwd)
  // 启动全量回填改为 opt-in（RIVET_MERIDIAN_BACKFILL=1）。默认只靠 read_file 懒索引；
  // 首次 repo_graph / repo_map 等工具会 on-demand 调度 backfill（见 scheduleMeridianBackfill）。
  setImmediate(() => {
    scheduleMeridianBackfill(meridianIndexer, cwd, { reason: 'startup' })
  })

  // Memory epoch reset — 首次/升级后启动时一次性清空中毒的跨会话学习存量
  // （playbook.jsonl / recovery-journal / advisory-efficacy / mistake_entries），
  // 见 memory-epoch.ts 取证背景。必须在 loadSessionMemories warmup 之前跑，
  // 否则旧 mistake entries 先被载入内存、会话末又原样存回。
  try {
    const memReset = resetLegacyMemoryIfNeeded(cwd, {
      clearMistakeEntries: () => meridianIndexer.getDb().clearMistakeEntries(),
    })
    if (!memReset.skipped && memReset.cleared.length > 0) {
      console.error(`[startup] Memory epoch ${memReset.epoch}: cleared ${memReset.cleared.join(', ')}`)
    }
  } catch { /* 清理绝不阻塞启动 */ }

  // 7. Domain knowledge store
  const domainKnowledgeStore = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

  // 8. Load profiles + star domains
  const agentsDir = join(cwd, '.rivet', 'agents')
  const agentLoadResult = await profileRegistry.loadFromDirectory(agentsDir)
  if (agentLoadResult.loaded.length > 0 || agentLoadResult.errors.length > 0) {
    for (const err of agentLoadResult.errors) {
      console.warn(`[agents] ${err}`)
    }
  }
  const domainsDir = join(cwd, '.rivet', 'domains')
  const domainLoadResult = await starDomainRegistry.loadFromDirectory(domainsDir)
  if (domainLoadResult.errors.length > 0) {
    for (const err of domainLoadResult.errors) {
      console.warn(`[domains] ${err}`)
    }
  }

  // 9. Runtime refs
  const refs: RuntimeRefs = {
    coordinator: null,
    fileHistory,
    claimStore,
    sessionId,
    sessionRegistry,
    taskLedger: null,
    ownershipLedger: null,
    verificationSnapshotManager: null,
    deliveryGate: null,
    meridianIndexer,
    mcpManager: null,
    lspManager: null,
    banditState: null,
    promptEngine: null,
    goalTrackerRef: { current: null },
    domainKnowledgeStoreRef: { current: domainKnowledgeStore },
    obligationTrackerRef: { current: null },
    claimTrackerRef: { current: null },
    reviewGateRef: { current: config.agent.review.skipAuto ? 'off' : 'auto' },
    pluginHooks: [],
    pluginCommands: [],
    // TUI 单会话：复用全局 defaultStore，沿用其 setTodoSession/loadTodos 持久化与
    // 会话切换语义（行为零变化），仅把后端读取入口统一到 refs.todoStore。
    todoStore: defaultTodoStore,
  }

  // 10. Tool registry
  const { registry: toolRegistry } = createInteractiveToolRegistry(refs, config, cwd)

  // 11. Memory tool (unified recall + remember + deep_recall)
  // deep_recall 的侧路通道晚绑定到 step 12 的 agent（compact 廉价路由同源）。
  let runtimeAgent: ReturnType<typeof createAgentRuntime>['agent'] | undefined
  toolRegistry.register(createMemoryTool(claimStore, {
    sessionId,
    getTurn: () => session.getTurnCount(),
    cwd,
    deepRecallComplete: async (prompt, timeoutMs) => {
      const client = runtimeAgent?.config.compactClient ?? runtimeAgent?.config.primaryClient ?? runtimeAgent?.config.client
      if (!client) throw new Error('deep recall: no client')
      return runGateCompletion(client, () => {}, prompt, timeoutMs)
    },
    sessionDir: getSessionDir(cwd),
    excludeSessionId: sessionId,
  }))

  // 12. Agent runtime
  // 启动 resume 模型亲和（决策见 decideStartupResumeModel 注释）。
  const startupResume = decideStartupResumeModel({
    resumed: wasSessionResumed(),
    explicitModel: effectiveModelId,
    explicitProvider: opts.providerName,
    originalModel: wasSessionResumed() ? persist.loadMetadata()?.model : undefined,
    fallbackModelId: config.agent?.resumeFallbackModel,
    resolve: modelId => resolveProviderForModel({ config, provider, apiKey, auth }, modelId),
  })
  if (startupResume.degradedWarning) console.error(startupResume.degradedWarning)
  const { agent } = createAgentRuntime({
    provider: startupResume.target?.provider ?? provider,
    apiKey: startupResume.target?.apiKey ?? apiKey,
    auth: startupResume.target ? startupResume.target.auth : auth,
    config, sessionId, cwd,
    toolRegistry, persist, claimStore, fileHistory, refs,
    domainKnowledgeStore, modelId: startupResume.target?.modelId ?? effectiveModelId,
    session,
    inheritFrozenFrom: resumedFrozen,
    // 晚绑定：ctx.setStatusLine 由 TUI 层在 TuiApp 创建后回填（agent 早于
    // TUI 创建，资源压力提醒发生在运行期，届时已就绪）。
    onStatusLine: text => ctx.setStatusLine?.(text),
  })
  refs.promptEngine = agent.config.promptEngine
  runtimeAgent = agent
  // 记忆回填（opt-in：RIVET_MEMORY_BACKFILL=1，对齐 dsh memory-pipeline）：
  // 启动 30s 后闲时补采历史会话——ledger 幂等，每轮至多 5 个会话。
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
  wireFrozenSnapshotPersist(persist, agent.config.promptEngine)
  // 锚点补课（spec 3c 动作 B · 缺口 3）：恢复会话的历史消息在 wire 上
  // 同样被截断，惰性重建锚点（与逐轮增量同粒度，并集确定性等价）。
  // 非 spark / 开源构建：extractor 恒 undefined → 零行为差异。
  if (existingMessages.length > 0 && wasSessionResumed()) {
    const extractor = proRegistry.getAnchorExtractor(effectiveProviderName ?? '')
    if (extractor) {
      const anchors = anchorsFromMessages(existingMessages, extractor, agent.config.promptEngine.getModel(), agent.config.wireContext)
      if (anchors.length > 0) agent.config.promptEngine.appendExcludedPathAnchors(anchors)
    }
  }
  // 目标锚注入（spec 3c 动作 B 补强）：resume 有历史 → 从 meta 或历史重建；
  // 首启无历史 → 仅注入增量跟踪（第一条 user 消息进入时经 setGoalTracking
  // 提取初始目标）。非 spark extractor 恒 undefined → 零行为差异。
  const goalExtractor = proRegistry.getGoalExtractor(effectiveProviderName ?? '')
  if (goalExtractor) {
    let baseline: string | null = null
    if (existingMessages.length > 0) {
      const frozenGoal = persist.loadMetadata()?.goalAnchor
      if (frozenGoal) {
        agent.config.promptEngine.setGoalAnchor(frozenGoal)
        baseline = frozenGoal
      } else {
        const goal = goalExtractor(existingMessages as never)
        if (goal) {
          agent.config.promptEngine.setGoalAnchor(goal)
          baseline = goal
          try { persist.updateMetadata({ goalAnchor: goal }) } catch { /* best-effort */ }
        }
      }
    }
    // 后续 user 消息增量更新（延续指令不触发；变更回调更新 engine + meta）。
    // initialBaseline = frozen ?? 历史提取——防止初始提取覆盖已固化目标（审查 HIGH-2）。
    session.setGoalTracking(
      (msgs) => goalExtractor(msgs as never),
      (next) => {
        agent.config.promptEngine.setGoalAnchor(next)
        if (next !== null) {
          try { persist.updateMetadata({ goalAnchor: next }) } catch { /* best-effort */ }
        }
      },
      baseline,
    )
  }
  // 兜底模型续跑：meta + JSONL 审计，对齐 switchAgentSession/桌面 resume-fallback 语义。
  if (startupResume.fallbackUsed && startupResume.target) {
    try {
      persist.updateMetadata({ model: startupResume.target.modelId, provider: startupResume.target.providerName })
      persist.appendModelSwitch({ from: startupResume.originalModel, to: startupResume.target.modelId, provider: startupResume.target.providerName })
    } catch { /* best-effort */ }
  }
  refs.getTaskContract = () => agent.getTaskContract()
  refs.getImpactedTests = () => [...agent.getEvidenceState().impactedTests]
  refs.getSessionVitals = () => agent.getSessionVitals()
  refs.getProblemAttackStore = () => agent.problemAttack
  refs.getAttackEvidenceVerifier = () => makeAttackEvidenceVerifier(agent)

  // 12b. Restore goal tracker from persisted state (if session was resumed).
  // normalizeAfterResume: active → paused (the process that wrote active is gone).
  if (wasSessionResumed()) {
    try {
      const { restoreGoalTracker } = await import('./agent/goal-persist.js')
      const restored = restoreGoalTracker(getSessionDir(cwd), sessionId, {
        maxJudgeRuns: config.agent.goal?.judge?.maxRuns,
      })
      if (restored) {
        agent.setGoalTracker(restored)
        refs.goalTrackerRef.current = restored
        console.error(`🎯 已恢复目标（暂停状态）: ${restored.getGoal().slice(0, 60)}…  使用 /goal-resume 继续。`)
      }
    } catch { /* best-effort: goal restore failure is non-fatal */ }
  }

  // 13. MCP + Plugin + LSP initialization
  // asyncExtras (default true): fire-and-forget, non-blocking for faster startup
  // asyncExtras=false: synchronous await, completes before bootstrap returns
  if (opts.asyncExtras !== false) {
    initializeMcp(config, toolRegistry, refs).then(() => {
      agent.updateTools()
    }).catch(() => {})
    initializePlugins(config.plugins, toolRegistry, cwd).then((result) => {
      refs.pluginHooks = result.hooks
      refs.pluginCommands = result.commands
      for (const name of result.suppressTools) {
        toolRegistry.remove(name)
      }
      if (result.warnings.length > 0) {
        debugLog(`[plugins] ${result.loaded}/${result.scanned} loaded, ${result.totalTools} tools; warnings: ${result.warnings.join('; ')}`)
      }
      // Always refresh tools when plugins change the registry (tools added OR suppressed).
      // Suppress-only plugins (zero own tools) must still trigger an update to remove
      // the suppressed built-in tools from the model's tool list.
      if (result.totalTools > 0 || result.suppressTools.length > 0) {
        agent.updateTools()
      }
    }).catch((err) => {
      debugLog(`[plugins] Initialization failed: ${(err as Error).message}`)
    })
    initializeLsp(cwd, toolRegistry).then((lspManager) => {
      refs.lspManager = lspManager
      agent.updateTools()
    }).catch(() => {})
  } else {
    await initializeMcp(config, toolRegistry, refs)
    agent.updateTools()
    const pluginResult = await initializePlugins(config.plugins, toolRegistry, cwd)
    // Expose plugin hooks/commands via refs so the user-hooks bridge and the
    // slash-command resolver pick them up (lazy binding — plugins load after
    // agent assembly, refs are read at fire/input time).
    refs.pluginHooks = pluginResult.hooks
    refs.pluginCommands = pluginResult.commands
    for (const name of pluginResult.suppressTools) {
      toolRegistry.remove(name)
    }
    if (pluginResult.warnings.length > 0) {
      debugLog(`[plugins] ${pluginResult.loaded}/${pluginResult.scanned} loaded, ${pluginResult.totalTools} tools; warnings: ${pluginResult.warnings.join('; ')}`)
    }
    if (pluginResult.totalTools > 0) agent.updateTools()
    const lsp = await initializeLsp(cwd, toolRegistry)
    refs.lspManager = lsp
    agent.updateTools()
  }

  // Pro 扩展点加载（spec 3b）：闭源模块（src/pro/）动态 import，失败静默降级。
  // 必须在 server / config-routes 首次查询之前完成——否则 spark 节点不可见
  // （sidecar 时序缝隙：先查后载则合并视图查不到注册项）。
  await loadProModule()

  // 14. Shutdown handler
  const shutdown = createShutdownHandler({
    config, provider, apiKey, auth, sessionId, session, persist,
    claimStore, fileHistory, toolRegistry, agent, refs,
    domainKnowledgeStore, meridianIndexer, cwd,
    shutdown: async () => {}, // placeholder, replaced below
    flushTuiPerfSummary: async () => {}, // placeholder; TUI bridge is attached on final context
    heartbeatInterval,
  })

  let ctx: BootstrapContext
  const flushTuiPerfSummary = async (summary: TuiPerfSummary): Promise<void> => {
    const writer = ctx.agent.telemetryWriter
    writer.write({
      kind: summary.kind,
      samples: summary.samples,
      cache: summary.cache,
      loopLag: summary.loopLag,
    })
    await writer.flush()
  }
  ctx = {
    config, provider, apiKey, auth, sessionId, session, persist,
    claimStore, fileHistory, toolRegistry, agent, refs,
    domainKnowledgeStore, meridianIndexer, cwd,
    shutdown,
    flushTuiPerfSummary,
    heartbeatInterval,
    templatesPendingAgents,
  }

  return ctx
}
