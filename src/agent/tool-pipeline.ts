import type { AgentConfig, AgentCallbacks } from './loop-types.js'
import type { TurnBudget } from './turn-budget.js'
import type { ContentBlock } from '../api/types.js'
import type { ToolCallParams, VerificationMetadata, ToolErrorClass } from '../tools/types.js'
import type { TurnHarness } from './turn-harness.js'
import type { EvidenceTrackerPublic } from './evidence.js'
import type { TraceStore } from './trace-store.js'
import type { RepairHintTracker } from './repair-hint.js'
import type { ImportGraph } from './import-graph.js'
import { mkdir, appendFile } from 'node:fs/promises'
import { createCheckpoint, recordAgentTouchedFile, recordBashSideEffects, makeOwnershipGuard, type OwnershipGuard, type ClaimLookup } from './checkpoint.js'
import { validatePath, validatePathSafe } from '../tools/path-validate.js'
import { grantPath } from '../tools/path-grants.js'
import { expandHome } from '../platform.js'
import { dirname, join, relative, resolve as resolvePath, isAbsolute } from 'node:path'
import { getSessionDir } from './session-persist.js'
import { classifyFailure, classifyToolFailure, classifyTestRun, isTransient, resolveErrorKind, type FailureClass } from './failure-classifier.js'
import { extractClaimsFromToolResult } from '../context/claim-extractor.js'
import { appendProjectMemory, compactProjectMemory } from '../context/project-memory-writer.js'
import { detectConflicts } from '../context/conflict-detect.js'
import { createAntibodyProposal } from '../context/antibody.js'
import { touchActivity } from './stall-observer.js'
import { buildImportGraph, invalidateFile } from './import-graph.js'
import { generateImpactHint } from './impact-hint.js'
import { analyzeImpact } from '../repo/meridian-impact.js'
import { shouldRunDiagnostics, filterDiagnosticsForEdit } from '../lsp/client.js'
import type { LspManager } from '../lsp/manager.js'
import { startTraceEvent, finishTraceEvent, fingerprintToolCall, fingerprintToolClass, recordToolFingerprint, recordTraceEvent, offendingFingerprints, getDoomLoopThresholds } from './trace-store.js'
import { summarizeRepairTelemetry } from './repair-pipeline.js'
import type { InterventionLevel } from './prediction-error.js'
import { assessToolRisk, CONFIDENCE_THRESHOLDS, hasOutOfWorkspaceWriteTarget, isDestructiveGitAction, isSafeWriteOnly, requiresBashWriteApproval, requiresUnconditionalApproval } from './approval-risk.js'
import type { Sensorium } from './sensorium.js'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied, learnBashPrefix, learnFileApproval } from './permissions.js'
import { isSelfDestructiveKill, selfProcessTree } from './self-preservation.js'
import { isSandboxActive, sandboxCoversCommand } from '../tools/sandbox-profile.js'
import { applyApprovalEdit, type ApprovalResult } from './approval-edit.js'
import { debugEnabled, debugLog } from '../utils/debug.js'
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm } from './prewarm-file.js'

import { compactThresholds, pruneThresholds } from '../compact/constants.js'
import { getToolArtifactThreshold } from '../tools/artifact-threshold.js'
import { extractTrailingArtifactId } from './tool-result-tiering.js'
import { truncateToolResult } from './tool-result-truncate.js'
import { getStarSignature } from './star-signature.js'
import type { ImmuneHook } from './immune-hook.js'
import { detectMistakeResolution, sanitizeMistakeResolutionInput } from './mistake-detector.js'
import { isToolAllowedInReliabilityMode, reliabilityBlockMessage, type ReliabilityDecision } from './reliability-mode.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import type { TaskLedger } from './task-ledger.js'
import type { P3Integration } from './p3-integration.js'
import { buildCommitNudge } from './commit-nudge.js'
import { evaluateTddGate, parseTddGateConfig, EDIT_TOOLS, type TddGateConfig } from './tdd-gate.js'
import { checkPlanMode } from './plan-mode.js'
import { checkAskMode } from './ask-mode.js'
import { GIT_CLEAR_RE } from '../tools/destructive-patterns.js'
import { classifyDeclaredCommand, loadDeclaredVerify } from '../config/verify-config.js'
import { profileIsPlanModeSafe } from './profile-registry.js'
import { buildSensitivePreflightMessage, shouldRequireSensitivePreflight } from './sensitive-preflight.js'
import { toolTargetFromInput } from './tool-target.js'
import { execFileGit } from '../tools/spawn-git.js'
import { patchTargetPaths, preWriteClaimPaths } from './pre-write-claims.js'

/** Headless prefix on denial messages — a stable marker so worker-session's
 *  detectApprovalDeadlock can distinguish "gated by approval" from "bad JSON". */
export const HEADLESS_DENY_MARKER = 'not available in a headless worker'

/** File-mutation tools that a headless worker may run without approval. These
 *  write into an isolated git worktree (or claim-isolated in-place cwd), so the
 *  change is reversible and the primary reviews the diff afterward. Bash writes
 *  are intentionally NOT here — they are governed by the OS sandbox check
 *  (bashWriteRequiresApproval), which already auto-approves when a sandbox is
 *  active and denies when there is none. */
const HEADLESS_AUTO_APPROVE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit',
])

/** Re-exported for the existing importers (tests + TaskLedger attribution).
 *  实现与 preWriteClaimPaths 同住一个模块——写前守卫与写后归属共用同一套
 *  路径键形，拆开会让两侧漂移。 */
export { patchTargetPaths }

/** Infer the workspace_mutation `kind` from a git destructive command.
 *  Used by B1 cross-session stash awareness to differentiate stash / reset / checkout / clean. */
function gitMutationKind(cmd: string): string | undefined {
  const c = cmd.trim().replace(/\s+/g, ' ')
  if (/^git\s+stash\s*$/.test(c) || /\bgit\s+stash\s+(?!pop|list|show|apply|drop|branch)/.test(c)) return 'stash'
  if (/\bgit\s+stash\s+pop\b/.test(c)) return 'stash_pop'
  if (/\bgit\s+reset\s+--(?:hard|mixed)\b/.test(c)) return 'reset'
  if (/\bgit\s+checkout\s+--\b/.test(c)) return 'checkout'
  if (/\bgit\s+restore\s/.test(c)) return 'restore'
  if (/\bgit\s+clean\s/.test(c)) return 'clean'
  return undefined
}

/** Collect the worker profile name(s) a delegate_task/delegate_batch call requests.
 *  delegate_task carries a single `profile`; delegate_batch carries `tasks[].profile`.
 *  Absent profile → default read-only scout, so it need not be listed here. */
function delegateProfilesFromInput(input: Record<string, unknown>): string[] {
  const names: string[] = []
  if (typeof input.profile === 'string') names.push(input.profile)
  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (task && typeof task === 'object' && typeof (task as { profile?: unknown }).profile === 'string') {
        names.push((task as { profile: string }).profile)
      }
    }
  }
  return names
}

/** Extract artifact ID from content if it starts with [artifact:ID] */
function extractArtifactId(content: string): string | undefined {
  const m = content.match(/^\[artifact:([^\]]+)\]/)
  return m?.[1]
}

/** Failure classes that trigger onPhaseChange('blocked') — user-visible state. */
const BLOCKED_CLASSES: ReadonlySet<string> = new Set([
  'context_window_exceeded',
  'api_error',
  'permission_denied',
])

const DEFAULT_TOOL_TIMEOUT_MS = 120_000 // 2 minutes

/** L3 同步段慢阈值（2026-09-10 纵深修复）：同步代码无法被 Promise.race 打断，
 *  只能事后留痕——超过该值即在 stderr 打 [slow-sync-stage]（含工具/阶段/耗时）。
 *  动机：edit_file 后处理曾静默 185s/221s，同步段"无痕"是定案障碍之一。 */
const SLOW_SYNC_STAGE_MS = 3_000

function warnSlowSyncStage(tool: string, stage: string, ms: number): void {
  if (ms >= SLOW_SYNC_STAGE_MS) console.warn(`[slow-sync-stage] ${tool} ${stage} took ${ms}ms`)
}

/** TDD gate config — parsed once from env at module load. */
const _TDD_GATE_CONFIG: TddGateConfig = parseTddGateConfig()

/** Tools that may mutate the workspace and therefore open the rollback window. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'apply_patch', 'bash',
])
function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name)
}

function sortedInputKeys(input: Record<string, unknown>): string[] {
  return Object.keys(input).sort()
}

function toolInputTraceDebugEnabled(): boolean {
  return process.env.RIVET_DEBUG_TOOL_INPUT === '1'
}

function shouldEmitToolInputTrace(
  toolName: string,
  beforeHookKeys: string[] | undefined,
  afterHookKeys: string[] | undefined,
  afterRepairKeys: string[] | undefined,
): boolean {
  if (toolInputTraceDebugEnabled()) return true
  if (toolName !== 'grep') return false
  return !beforeHookKeys?.includes('pattern') ||
    !afterHookKeys?.includes('pattern') ||
    !afterRepairKeys?.includes('pattern')
}

async function emitToolInputTrace(input: { cwd: string; sessionId?: string; message: string }): Promise<void> {
  if (debugEnabled()) {
    debugLog(input.message)
    return
  }
  try {
    const sessionDir = input.sessionId
      ? join(getSessionDir(input.cwd), input.sessionId)
      : join(getSessionDir(input.cwd), 'unknown')
    await mkdir(sessionDir, { recursive: true })
    await appendFile(join(sessionDir, 'tool-input-trace.jsonl'), `${input.message}\n`, 'utf8')
  } catch {
    // Diagnostics must never affect tool execution or pollute model-visible output.
  }
}

/**
 * Unconditional tool-result trace — always writes (no sampling gate). This is the
 * primary diagnostic log for TUI rendering-loss bugs. Every tool result passing
 * through the pipeline is recorded BEFORE the onToolResult callback.
 *
 * Log path: ~/.rivet/sessions/<project-slug>/<sessionId>/tool-result-trace.jsonl
 * On Windows: %LOCALAPPDATA%\.rivet\sessions\<project-slug>\<sessionId>\tool-result-trace.jsonl
 *
 * Each line is JSON with: { ts, id, name, isError, contentLen, source }
 *   source: "pipeline" = emitted just before callbacks.onToolResult
 *           "bridge"   = received by TUI bridge
 *           "tui"      = processed by TUI handleToolResult
 *
 * To find the log file on any platform:
 *   1. Look at the "Watching" header line printed at TUI startup
 *   2. Or check %LOCALAPPDATA%\.rivet\sessions\ on Windows
 *   3. Or run: dir %LOCALAPPDATA%\.rivet\sessions\ /s /b | findstr tool-result-trace
 */
async function emitToolResultTrace(input: {
  cwd: string
  sessionId?: string
  id: string
  name: string
  isError: boolean | undefined
  contentLen: number
  source: 'pipeline' | 'bridge' | 'tui'
}): Promise<void> {
  try {
    const sessionDir = input.sessionId
      ? join(getSessionDir(input.cwd), input.sessionId)
      : join(getSessionDir(input.cwd), 'unknown')
    await mkdir(sessionDir, { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      id: input.id,
      name: input.name,
      isError: input.isError,
      contentLen: input.contentLen,
      source: input.source,
    })
    await appendFile(join(sessionDir, 'tool-result-trace.jsonl'), `${line}\n`, 'utf8')
  } catch {
    // Diagnostics must never affect tool execution or pollute model-visible output.
  }
}

/**
 * File tools whose path operand may target a path outside the workspace, with
 * the access mode they need. Used to gate out-of-workspace file ops behind an
 * approval-driven path grant (rather than a hard "Path outside workspace" error).
 * `read_section` is artifact-id based and `apply_patch` embeds paths in a patch
 * body — neither has a single extractable path, so they rely on request_path_access.
 * `ast_edit` (paths 数组) 走同一门禁；export_file / create_document / open_path 的
 * 参数形态不同（destination/source/path + execute 侧 trim），在下方专门分支提取。
 */
const FILE_TOOL_MODES: Record<string, 'read' | 'write'> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'write',
  hash_edit: 'write',
  ast_edit: 'write',
}

/**
 * Resolve the absolute paths a file tool would touch that currently fall OUTSIDE
 * the workspace and are not yet covered by a grant. Empty when in-workspace or
 * already granted (validatePathSafe consults the grant store).
 *
 * Exported so the desktop sidecar can label an approval as a path grant without
 * duplicating the path comparison — symlink/case handling lives in one place.
 */
export function outOfWorkspaceFilePaths(cwd: string, toolName: string, input: Record<string, unknown>): { mode: 'read' | 'write'; paths: string[] } | null {
  // 外部导出面（export_file/create_document）：destination 写侧优先于 source 读侧
  // ——更强的授权面决定整组 mode（返回结构保持单 mode 形态，桌面端 pathGrantHint
  // 依赖）。execute 侧对路径做 trim + expandHome（~ 展开到家目录），这里必须做
  // 同样的归一——否则 `~/Desktop/x.svg` 会词法 resolve 进 cwd 而绕过门禁。
  if (toolName === 'export_file' || toolName === 'create_document') {
    const dest = typeof input.destination_path === 'string' ? expandHome(input.destination_path.trim()) : ''
    const src = toolName === 'export_file' && typeof input.source_path === 'string' ? expandHome(input.source_path.trim()) : ''
    if (dest && !validatePathSafe(cwd, dest, 'write').ok) return { mode: 'write', paths: [resolvePath(cwd, dest)] }
    if (src && !validatePathSafe(cwd, src, 'read').ok) return { mode: 'read', paths: [resolvePath(cwd, src)] }
    return null
  }
  // open_path：只读打开（OS opener，不回读内容）；execute 侧同样 trim + expandHome
  if (toolName === 'open_path') {
    const p = typeof input.path === 'string' ? expandHome(input.path.trim()) : ''
    if (p && !validatePathSafe(cwd, p, 'read').ok) return { mode: 'read', paths: [resolvePath(cwd, p)] }
    return null
  }
  const mode = FILE_TOOL_MODES[toolName]
  if (!mode) return null
  const candidates: string[] = []
  if (typeof input.file_path === 'string') candidates.push(input.file_path)
  if (Array.isArray(input.file_paths)) {
    for (const p of input.file_paths) if (typeof p === 'string') candidates.push(p)
  }
  // ast_edit 的 paths 数组（文件或目录）；缺省 ['.'] 不在此展开——默认值即 cwd 本身
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) if (typeof p === 'string') candidates.push(p)
  }
  const paths: string[] = []
  for (const c of candidates) {
    if (!validatePathSafe(cwd, c, mode).ok) paths.push(resolvePath(cwd, c))
  }
  return paths.length > 0 ? { mode, paths } : null
}

/** Build a cross-session ownership guard from the live session registry, if any. */
function buildOwnershipGuard(deps: {
  cwd: string
  config: { sessionRegistry?: ClaimLookup; sessionId?: string }
}): OwnershipGuard | undefined {
  const registry = deps.config.sessionRegistry
  const sessionId = deps.config.sessionId
  if (!registry || !sessionId) return undefined
  return makeOwnershipGuard(registry, sessionId, deps.cwd)
}

function withToolTimeout<T>(
  promise: Promise<T>,
  toolName: string,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutController?: AbortController,
): Promise<T> {
  // Guard against NaN/Infinity/negative timeout (e.g. parameter misplacement bugs)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
 }
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Cascade abort to the underlying op (child proc / fetch) BEFORE rejecting,
      // so the tool stops consuming resources instead of orphaning.
      try { timeoutController?.abort() } catch { /* noop */ }
      reject(new Error(`Tool ${toolName} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e) },
    )
 })
}

export interface ToolPipelineDeps {
  config: AgentConfig
  cwd: string
  harness: TurnHarness
  prewarm: PrewarmCache
  evidence: EvidenceTrackerPublic
  /** 证据义务状态机：pre-tool RED 编辑门 + post-tool probe/失败归账。可缺省（测试/worker）。 */
  obligations?: import('./obligation-tracker.js').ObligationTracker
  traceStore: TraceStore
  repairHintTracker: RepairHintTracker
  repairPipeline: import('./repair-pipeline.js').RepairPipeline
  importGraph: ImportGraph | null
  /** Meridian indexer — when available, edit impact tracking prefers the
   *  persisted SQLite reverse BFS over the in-memory import-graph. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  lastConflictCheckCount: number
  trajectory: { getEntries(): { tool: string; target: string; status: string; errorClass?: string }[] }
  getDoomLoopLevel(): import('./trace-store.js').DoomLoopLevel
  /** Whether goal mode is active — relaxes doom-loop thresholds when true. */
  isGoalActive?: boolean
  latestRisk: import('./approval-risk.js').RiskAssessment
  sessionTurnCount: number
  sessionId: string | undefined
  abortSignal?: AbortSignal
  /** Capture an agent's departure mark (leave_mark tool) for 主控 to record at close. */
  onLeaveMark?: (mark: import('../tools/types.js').LeaveMarkInput) => void
  /** U6/C1: capture goal decomposition from plan_steps into the loop's PlanExecutionTrace. */
  onPlanSteps?: (steps: import('../tools/types.js').PlanStepInput[]) => void
  /** 用户级验收面的声明与核销（todo 的 acceptance 字段 → loop）。 */
  onAcceptance?: (items: import('../tools/types.js').AcceptanceItemInput[]) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: import('../tools/types.js').PlanClosedInput) => void
  /** Notify the UI that a plan was submitted for approval so it can prompt the user. */
  onPlanSubmitted?: (info: import('../tools/types.js').PlanSubmittedInfo) => void
  /** Notify the UI that the agent asked the user a question with selectable options. */
  onAskUserQuestion?: (info: import('../tools/types.js').AskUserQuestionInfo) => void
  /** ask_image 查询句柄（会话 ImageRegistry + 视觉桥）。 */
  visionAsk?: (imageId: string | undefined, question: string, signal?: AbortSignal) => Promise<import('../tools/types.js').VisionAskResult>
  /** Evidence-gated plan closure: assess the real delivery gate over owned/dirty files. */
  assessDelivery?: (dirtyFiles?: string[]) => import('./delivery-gate-v2.js').DeliveryGateResult
  /** 主动 plan mode：plan action=enter_mode → AgentLoop.enterPlanMode（仅主控有）。 */
  enterPlanMode?: () => { activePlanFilePath: string | null; alreadyPlanning: boolean }
  /** 闭环自动退出：plan action=close 标记 EXECUTED 后 → AgentLoop.exitPlanMode（仅主控有）。 */
  exitPlanMode?: () => void
  /** Real verification records for this session (evidence-gated plan closure). */
  getVerificationEvidence?: () => import('./evidence.js').VerificationSummary
  /** Called when the model explicitly loads a skill via the skill tool. */
  onSkillInvoked?: (name: string) => void
  /** Called when the model explicitly marks a skill as complete via the skill tool. */
  onSkillCompleted?: (name: string) => void
  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, content: string, errorClass?: ToolErrorClass, errorKind?: FailureClass): void
  getInterventionLevel?(): InterventionLevel
  recordPrediction?(correct: boolean): void
  /** Current sensorium snapshot — enables confidence-driven adaptive approval. */
  getSensorium?(): Sensorium | null
  /** Current reliability mode decision — blocks risky tools before approval/execution. */
  getReliabilityDecision?(): ReliabilityDecision | null
  /** Turn-level token budget — degrades tool results when exhausted. */
  turnBudget: TurnBudget
  /** Artifact store for persisting tool output — injected via params, no global setter */
  artifactStore?: import('../artifact/store.js').ArtifactStore
  /** Session-scoped background job registry — forwarded to bash / job tools. */
  jobs?: import('../tools/job-store.js').JobRegistry
  /** Session-scoped monitor registry — forwarded to the monitor tool. */
  monitors?: import('./monitor-registry.js').MonitorRegistry
  /** Immune system hook for recording repair success (failed→passed transitions) */
  immuneHook?: ImmuneHook
  /** Optional cache advisor for adaptive artifact thresholds */
  cacheAdvisor?: CacheAdvisor
  /** Phase hint passed to cache advisor (e.g. 'explore', 'execute', 'verify'). Defaults to 'execute'. */
  phaseHint?: string
  /** Optional TaskLedger for B1 ownership tracking */
  taskLedger?: TaskLedger
  /** Optional OwnershipLedger for real-time file ownership registration */
  ownershipLedger?: import('./ownership-ledger.js').OwnershipLedger
  /** VSW: session-scoped snapshot manager. Consulted before run_tests to decide
   *  isolated (Phase A) + integration (Phase B) verification vs in-place. */
  verificationSnapshotManager?: import('./verification-snapshot-manager.js').VerificationSnapshotManager
  /** Optional SessionRegistry for cross-session file claim coordination */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** P3 integration facade for speculative execution + mistake hints */
  p3?: P3Integration
  /** Turn-scoped accumulator: artifact IDs evicted (created by artifactIntercept) */
  artifactIdsEvicted?: string[]
  /** Turn-scoped accumulator: artifact IDs accessed (read_section calls) */
  artifactIdsAccessed?: string[]
  /** Optional LSP manager — notified on file changes for goto-def / find-refs accuracy */
  lspManager?: LspManager
  /** 破坏性命令 pre-execution 闸门(会话级状态,loop 持有)。pipeline 是唯一
   *  写者(noteVerification/noteToolExecuted)兼唯一读者(evaluate)。 */
  destructiveGate?: import('../tools/destructive-gate.js').DestructiveGateState
  /** T4: late-bound LSP manager getter. Checked first, falls back to `lspManager`.
   *  Enables T9 path where LSP initializes asynchronously after AgentLoop construction. */
  getLspManager?: () => LspManager | null
  /** W2 被拦不弃守护：每次 gate/deny 拦截时上报（cerebellar/tdd/destructive/
   *  hook/reliability/doom-loop/plan-mode/deny）。loop 持 turn 级计数，
   *  gate-block-guard hook 在 postTurn 读取——单 turn ≥2 次被拦触发反放弃 advisory。 */
  onGateBlocked?: (kind: string) => void
  /** P1b: TDD gate 同 target 被拦计数回调 */
  onTddBlocked?: (target?: string) => void
}

export interface ToolExecResult {
  toolResult: ContentBlock
  traceStore: TraceStore
  importGraph: ImportGraph | null
  lastConflictCheckCount: number
  checkpointCreated: boolean
  latestRisk: import('./approval-risk.js').RiskAssessment
  /** True when the tool returned endTurn: true (e.g. ask_user_question). */
  endTurn?: boolean
  /** Image attachments from ToolResult.images (data URLs). Tool messages are
   *  text-only at the protocol level, so the batch layer forwards these as a
   *  trailing multimodal user message — but ONLY when the active model
   *  declares supportsVision (dropped otherwise, matching legacy behavior). */
  images?: string[]
  /** 结构化失败分类（ToolResult.errorKind / errorClass 桥接后的解析值）——
   *  仅失败结果携带。postTool hook 层（vigor failureClass）优先消费此值，
   *  消息文案中文化后文本正则失灵时的失效防线。 */
  errorKind?: FailureClass
}

function truncateSuccessfulToolResult(content: string, config: AgentConfig): string {
  return truncateToolResult(content, compactThresholds({
    contextWindow: config.contextWindow ?? 1_000_000,
    providerProfile: config.providerProfile,
 }).toolResultMaxTokens)
}

/**
 * Artifact intercept: if content exceeds threshold and artifactStore is available,
 * persist to disk and replace with a compact reference. This keeps message history
 * append-only (no future truncation) → maximizes DeepSeek prefix cache hit rate.
 *
 * Tools that already return artifact refs (read_file, grep, bash) are detected by
 * the `[artifact:` prefix and skipped.
 */
const ARTIFACT_INTERCEPT_THRESHOLD = 2500 // chars — success results (raised from 800; review workflows need more inline content)
const ARTIFACT_ERROR_THRESHOLD = 1600 // chars — error results need more inline context for debugging

/**
 * Tools whose output MUST reach the model complete and inline — never replaced by
 * a lossy artifact summary, nor head/tail truncated, nor collapsed to a budget
 * preview. The `skill` tool loads a skill's full instructions that the model
 * explicitly asked for and will follow verbatim; a summary or a truncated middle
 * would make it act on partial/wrong instructions and force a whole-session redo
 * (fidelity is the #1 priority over context cleanliness). Unlike read tools,
 * `skill` has no offset/section param, so any truncation is unrecoverable. Heavy
 * reference material is split into sub-files (Tier-3) read on demand via
 * read_file (which DOES page), so the SKILL.md body stays bounded by author
 * convention and is safe to deliver in full.
 */
const FIDELITY_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['skill'])

/** Tools that perform their own L0 artifact wrapping (inside the tool impl) and
 *  emit a trailing [artifact:id] marker. L1 must NOT re-wrap their output:
 *  - read_file / read_section: content the model explicitly requested; re-wrap
 *    turns every recovery into [artifact:NEW_ID] -> read_section(NEW_ID) -> ...
 *    an infinite nesting loop (tianshu v4 pro post-mortem 2026-05-25).
 *  - grep / bash: L0 wraps at its own threshold with a trailing marker; the old
 *    startsWith('[artifact:') check missed the trailing marker and re-saved the
 *    already-truncated string (L0->L1 double-save bug). */
const L0_WRAPPED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'bash',
])

function isDietNoInfoReadResult(content: string): boolean {
  return content.includes('[diet:redundant]') || content.includes('[diet:useless]')
}

function countRecentReadLoopPlaceholders(
  entries: { tool: string; target: string; status: string; errorClass?: string; resultSummary?: string }[],
  target: string,
): number {
  return entries
    .slice(-8)
    .filter(entry =>
      entry.tool === 'read_file'
      && entry.target === target
      && isDietNoInfoReadResult(entry.resultSummary ?? ''),
    ).length
}

function buildReadLoopStrategySignal(
  toolName: string,
  target: string,
  content: string,
  priorNoInfoReads: number,
): string | null {
  if (toolName !== 'read_file') return null
  if (!isDietNoInfoReadResult(content)) return null
  if (priorNoInfoReads < 1) return null

  const targetLabel = target.length > 80 ? `${target.slice(0, 77)}...` : target
  return [
    '',
    '[策略信号：读取循环]',
    `这次 read_file 没有提供新信息。不要继续立刻读取 ${targetLabel}；请切换到 grep / repo_graph / ask_user_question，或说明为什么必须再次读取。`,
  ].join('\n')
}

async function artifactIntercept(
  content: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  artifactStore: ArtifactStore | undefined,
  isError = false,
  thresholdOverride?: number,
  remainingBudgetFraction?: number,
  contextWindow?: number,
): Promise<string> {
  if (!artifactStore) return content

  // Tools with their own L0 wrapping must not be re-intercepted here.
  if (L0_WRAPPED_TOOLS.has(toolName)) return content
  // Belt-and-suspenders: never re-wrap content that already ends in an artifact
  // ref (covers any future L0-wrapping tool not yet listed above). Uses the
  // shared trailing-marker convention, not startsWith — the marker is at the END.
  if (extractTrailingArtifactId(content)) return content

  let threshold = thresholdOverride ?? (isError ? ARTIFACT_ERROR_THRESHOLD : ARTIFACT_INTERCEPT_THRESHOLD)

  // Context-window-aware floor for SUCCESS results: align with L0 (per-tool)
  // artifact wrapping in read-file/bash/grep, which uses pruneThresholds.minChars.
  // Without this floor, cacheAdvisor.getArtifactThreshold (capped at MAX_ARTIFACT=4000)
  // and the static 2500-char fallback both wrap medium-sized outputs (delegate_batch
  // 14K, sandbox_exec 5K, bash sed 8K) even on a 1M window. Tianshu v4 pro's
  // post-mortem identified this as the L1 layer of the four-layer compression
  // architecture — small enough to misfire on every interesting tool result.
  // Errors keep the original behavior: stack traces below ~30K are useful inline,
  // and we want larger error blobs (e.g. 200K test output) to still be intercepted.
  if (!isError && contextWindow != null) {
    const floor = getToolArtifactThreshold(toolName, contextWindow)
    threshold = Math.max(threshold, floor)
 }

  // Budget-aware scaling: when context budget is ample, inline more aggressively
  if (remainingBudgetFraction != null) {
    if (remainingBudgetFraction > 0.5) {
      threshold = Math.max(threshold, threshold * 3) // plenty of room → 3x threshold
   } else if (remainingBudgetFraction > 0.3) {
      threshold = Math.max(threshold, threshold * 1.5) // moderate room → 1.5x
   }
    // < 0.3 → use base threshold (context is getting tight)
 }

  if (content.length <= threshold) {
    debugLog(`[artifact-intercept-skip] tool=${toolName} len=${content.length} threshold=${threshold} isError=${isError}`)
    return content
 }
  // Determine target label for the artifact
  const target = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : typeof toolInput.path === 'string'
      ? toolInput.path
      : typeof toolInput.command === 'string'
        ? (toolInput.command as string).slice(0, 80)
        : typeof toolInput.pattern === 'string'
          ? toolInput.pattern
          : typeof toolInput.url === 'string'
            ? toolInput.url
            : toolName

  // Generate a simple summary based on tool type
  const summary = generateToolSummary(content, toolName, toolInput)

  try {
    const artifactId = await artifactStore.save({
      tool: toolName,
      target: target as string,
      rawContent: content,
      summary,
      sections: [],
   })

    // For errors, include a head excerpt so the model can debug without read_section
    const headExcerpt = isError ? `\n${extractErrorHead(content)}` : ''
    return `[artifact:${artifactId}] ${summary}${headExcerpt}\nUse read_section(artifactId="${artifactId}", section="L1-L200") to expand.`
 } catch {
    // Graceful degradation: if disk write fails, return original content
    // and let downstream truncation handle it
    return content
 }
}

/** Extract the most diagnostic lines from error output (max ~600 chars). */
function extractErrorHead(content: string): string {
  const lines = content.split('\n')
  // Prioritize lines with error/fail keywords — use word boundaries to avoid matching identifiers like errorHandler
  const errorLines = lines.filter(l => /\b(?:error|Error|FAIL|AssertionError|TypeError|ReferenceError)\b|expect\(/.test(l))
  if (errorLines.length > 0) {
    return errorLines.slice(0, 8).map(l => l.trim().slice(0, 120)).join('\n')
 }
  // Fallback: last 8 lines (often contain the summary)
  return lines.slice(-8).map(l => l.trim().slice(0, 120)).join('\n')
}

function generateToolSummary(content: string, toolName: string, input: Record<string, unknown>): string {
  const lines = content.split('\n')
  const lineCount = lines.length
  const charCount = content.length

  switch (toolName) {
    case 'run_tests': {
      // Extract test summary from content
      const testLine = lines.find(l => /tests?\s*(?:pass|passed|fail|failed)|total/i.test(l))
        ?? lines.find(l => /\d+\s+pass/i.test(l))
      const errorLines = lines.filter(l => /error|Error|FAIL/i.test(l)).slice(0, 2)
      const parts = [`[run_tests] ${lineCount} lines.`]
      if (testLine) parts.push(testLine.trim())
      if (errorLines.length > 0) parts.push(`Errors: ${errorLines.map(l => l.trim().slice(0, 60)).join('; ')}`)
      return parts.join(' ')
   }
    case 'diff': {
      const files = lines.filter(l => l.startsWith('diff --git')).map(l => {
        const m = l.match(/b\/(.+)$/)
        return m ? m[1] : ''
     }).filter(Boolean)
      return `[diff] ${files.length} files changed, ${lineCount} lines. Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5})` : ''}`
   }
    case 'glob': {
      const matches = lines.filter(l => l.trim())
      const pattern = typeof input.pattern === 'string' ? input.pattern : '?'
      return `[glob "${pattern}"] ${matches.length} files found. First: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? ` (+${matches.length - 3})` : ''}`
   }
    case 'web_fetch': {
      const url = typeof input.url === 'string' ? input.url : '?'
      return `[web_fetch ${url}] ${charCount} chars, ${lineCount} lines fetched.`
   }
    case 'repo_map': {
      return `[repo_map] ${lineCount} lines. ${lines.find(l => /\d+ files/.test(l))?.trim() ?? `${lineCount} entries`}`
   }
    case 'inspect_project': {
      return `[inspect_project] ${lineCount} lines of project analysis.`
   }
    case 'bash': {
      const cmd = typeof input.command === 'string' ? input.command.slice(0, 80) : '?'
      // Detect test/typecheck output
      if (/\b(tsc|typecheck|type-check)\b/.test(cmd)) {
        const errorCount = lines.filter(l => /error TS\d+/.test(l)).length
        return `[bash typecheck] ${errorCount} errors, ${lineCount} lines. cmd: ${cmd}`
     }
      if (/\b(test|jest|vitest|mocha|pytest)\b/.test(cmd)) {
        const passLine = lines.find(l => /pass|fail|tests?\s+\d+/i.test(l))?.trim().slice(0, 80) ?? ''
        return `[bash test] ${lineCount} lines. ${passLine} cmd: ${cmd}`
     }
      return `[bash] ${charCount} chars, ${lineCount} lines. cmd: ${cmd}`
   }
    default: {
      // Generic: first meaningful line + stats
      const firstLine = lines.find(l => l.trim().length > 10)?.trim().slice(0, 80) ?? ''
      return `[${toolName}] ${charCount} chars, ${lineCount} lines. ${firstLine}`
   }
 }
}

/**
 * Best-effort HEAD probe for the deliver_task abort path. Never throws;
 * returns null on any failure (not a repo, git missing, timeout). Uses
 * execFile (no shell) with a hard timeout so an abort can't hang on git.
 */
function gitHeadQuiet(cwd: string): Promise<string | null> {
  return new Promise(resolve => {
    execFileGit(['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 1_500 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

/** One-line `<short-hash> <subject>` of HEAD, same failure semantics as gitHeadQuiet. */
function gitHeadSummaryQuiet(cwd: string): Promise<string | null> {
  return new Promise(resolve => {
    execFileGit(['log', '-1', '--format=%h %s'], { cwd, encoding: 'utf-8', timeout: 1_500 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

/**
 * edit_file / hash_edit 总闸（2026-09-08 wedge 纵深）：`withToolTimeout` inside
 * the body only bounds `toolRegistry.execute`; post-tool work (LSP diagnostics,
 * artifact intercept, hooks) ran outside that gate. Wrap the WHOLE call so any
 * unknown future hang becomes a visible timeout instead of a wedged turn. The
 * abort cascades into the inner execute path via the composed signal.
 */
export async function executeToolUse(
  tu: { id: string; name: string; input: Record<string, unknown>; argsTruncated?: boolean },
  deps: ToolPipelineDeps,
  callbacks: AgentCallbacks,
  turn: number,
  checkpointAlreadyCreated: boolean,
): Promise<ToolExecResult> {
  const canonicalName = deps.config.toolRegistry.resolveName(tu.name)
  const hasTotalGate = canonicalName === 'edit_file' || canonicalName === 'hash_edit'
  if (!hasTotalGate) {
    return executeToolUseInner(tu, deps, callbacks, turn, checkpointAlreadyCreated)
  }
  const totalAbort = new AbortController()
  const composedSignal = deps.abortSignal
    ? AbortSignal.any([deps.abortSignal, totalAbort.signal])
    : totalAbort.signal
  return withToolTimeout(
    executeToolUseInner(
      tu,
      { ...deps, abortSignal: composedSignal },
      callbacks,
      turn,
      checkpointAlreadyCreated,
    ),
    tu.name,
    DEFAULT_TOOL_TIMEOUT_MS,
    deps.abortSignal,
    totalAbort,
  )
}

async function executeToolUseInner(
  tu: { id: string; name: string; input: Record<string, unknown>; argsTruncated?: boolean },
  deps: ToolPipelineDeps,
  callbacks: AgentCallbacks,
  turn: number,
  checkpointAlreadyCreated: boolean,
): Promise<ToolExecResult> {
  let { traceStore, importGraph, lastConflictCheckCount, latestRisk } = deps
  let checkpointCreated = checkpointAlreadyCreated

  // 无进展哨兵的活动 key（工具级，2026-09-10 纵深修复）：pre 段（审批/checkpoint/
  // 快照）与 post 段（hooks/LSP/artifact/账本/影响面）都打在它上面——stall 告警
  // 的 last 字段由此能指认"卡在哪个阶段"（旧形态只能指认到 tool:<name>:end）。
  const activityKey = deps.sessionId ?? 'default'

  // Stream died while this call's arguments were still incomplete — input is
  // {} placeholder, NOT what the model asked for. Executing it ranges from a
  // misleading "X is required" error to actually running a half-received
  // command (session 4df36bcd). Refuse before any gate/alias/approval logic
  // and tell the model to re-issue the call with full arguments.
  if (tu.argsTruncated) {
    const msg = `Tool call NOT executed: the stream was interrupted before the arguments for \`${tu.name}\` finished transmitting (received an incomplete fragment). ` +
      `Nothing ran — no side effects. Re-issue the ${tu.name} call with its full arguments.`
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
  }

  // Canonicalize foreign tool aliases (task/agent/todowrite → Rivet names)
  // BEFORE any gate runs. Every downstream policy — plan-mode whitelist, deny
  // rules, approval, risk assessment, TDD gate — keys on tu.name; resolving
  // aliases inside registry.execute (after the gates) would let e.g. a deny
  // rule on `delegate_task` be bypassed by calling `task`.
  const canonicalToolName = deps.config.toolRegistry.resolveName(tu.name)
  const aliasNote = canonicalToolName !== tu.name
    ? `[NOTE: "${tu.name}" 自动映射为 "${canonicalToolName}" — 下次请直接调 ${canonicalToolName}]`
    : undefined
  if (canonicalToolName !== tu.name) {
    tu = { ...tu, name: canonicalToolName }
  }

  const params: ToolCallParams = {
    input: tu.input,
    toolUseId: tu.id,
    cwd: deps.cwd,
    onOutput: (chunk) => {
      callbacks.onToolResult(tu.id, tu.name, chunk)
   },
    // P6 follow-up: let tools (e.g. ast-edit) register internal file writes
    // so evidence/filesModified and cerebellar gate are aware.
    onFileWrite: (filePath) => deps.evidence.trackFileModified(filePath),
    // T4: structured per-worker delegation updates → subagent panel. Optional;
    // forwarded to the session layer alongside the text progress stream.
    onWorkerActivity: callbacks.onDelegationActivity
      ? (activity) => callbacks.onDelegationActivity!(activity)
      : undefined,
    // E4 — client landing delegation (apply_edit / terminal_exec). Absent when
    // the host did not wire onToolDelegate (CLI / no capabilities) → tools
    // fall through to local write/spawn with zero behavior change.
    onClientDelegate: callbacks.onToolDelegate
      ? (kind, payload) => callbacks.onToolDelegate!(kind, payload)
      : undefined,
    onLeaveMark: deps.onLeaveMark,
    onPlanSteps: deps.onPlanSteps,
    onAcceptance: deps.onAcceptance,
    onPlanClosed: deps.onPlanClosed,
    onPlanSubmitted: deps.onPlanSubmitted,
    onAskUserQuestion: deps.onAskUserQuestion,
    visionAsk: deps.visionAsk,
    assessDelivery: deps.assessDelivery,
    enterPlanMode: deps.enterPlanMode,
    exitPlanMode: deps.exitPlanMode,
    getVerificationEvidence: deps.getVerificationEvidence,
    onSkillInvoked: deps.onSkillInvoked,
    onSkillCompleted: deps.onSkillCompleted,
    sessionModifiedFiles: [...deps.evidence.getState().filesModified],
    ownedFiles: deps.ownershipLedger?.getOwnedFiles(),
    baselineHead: deps.ownershipLedger?.getBaselineHead(),
    artifactStore: deps.artifactStore,
    jobs: deps.jobs,
    monitors: deps.monitors,
    prewarmCache: deps.prewarm,
    contextWindow: deps.config.contextWindow,
    providerProfile: deps.config.providerProfile,
    readCapOverride: deps.config.readCapOverride,
    sessionTurnCount: deps.sessionTurnCount,
    sessionId: deps.config.sessionId,
    reviewDepth: deps.config.reviewDepth,
    delegationDepth: deps.config.delegationDepth,
    abortSignal: deps.abortSignal,
    activePlanFilePath: deps.config.activePlanFilePath,
    sessionModel: deps.config.promptEngine.getModel(),
 }

  // Star signature: counter training-mode regression at token level (思路 E)
  const starSig = getStarSignature(tu.name)

  // Post-abort commit attribution (session 50073c39): deliver_task got
  // cancelled AFTER its commit had landed, but the interrupted note only said
  // "may still have completed" — the model burned a turn re-verifying and the
  // user saw a finished task "wake up". Snapshot HEAD before commit-capable
  // tools so the abort path can report definitively whether a commit landed.
  let preAbortHead: string | null = null

  // TDD gate 的 suggest 决策此前在工具层是 no-op（只有 block 有下游动作），
  // 提醒只能等 turn 边界的 immune hint。这里把达到阈值的 suggest 提醒附加到
  // 本次编辑的成功结果尾部——追加在对话末尾，不改写 system prompt / 工具
  // 定义 / 历史消息，前缀缓存零影响。
  let tddSuggestNote: string | null = null

  try {
    // Cerebellar Loop: read-before-edit gate
    const intervention = deps.getInterventionLevel?.() ?? 'none'
    if ((intervention === 'gate' || intervention === 'escalate') && (tu.name === 'edit_file' || tu.name === 'write_file')) {
      const recentReads = deps.trajectory.getEntries().slice(-3).some(e => e.tool === 'read_file')
      if (!recentReads) {
        const gateMsg = `Tool blocked by cerebellar gate: recent prediction error rate is elevated. Read the file before editing to ensure mental model is current.`
        deps.onGateBlocked?.('cerebellar')
        callbacks.onToolResult(tu.id, tu.name, gateMsg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: gateMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
     }
   }

    // TDD Gate: block edit/write tools when the model has edited files
    // without running tests. Pure decision function, stateless — the
    // EvidenceTracker holds the edit counter and test-verification log.
    const tddConfig: TddGateConfig = deps.config.tddGate ?? _TDD_GATE_CONFIG
    if (tddConfig.enabled && EDIT_TOOLS.has(tu.name)) {
      const gateState = deps.evidence.getGateState()
      // Pass the edit target so test-file edits (the RED step) downgrade to suggest.
      const editTarget = typeof tu.input?.file_path === 'string' ? tu.input.file_path : undefined
      const decision = evaluateTddGate(gateState, tu.name, tddConfig, editTarget)
      if (decision.action === 'block') {
        deps.onGateBlocked?.('tdd')
        deps.onTddBlocked?.(editTarget)
        callbacks.onToolResult(tu.id, tu.name, decision.message!, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: decision.message!, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
     }
      // suggest 模式：编辑照跑，但只有进入"enforce 会拦"的区域（编辑数达阈值
      // 或测试已失败）才附加提醒——探索窗口（<threshold）与测试文件 RED 步骤
      // 保持安静，避免每次编辑都贴尾巴。
      if (
        decision.action === 'suggest' && decision.message
        && (gateState.hasFailedTests || gateState.editsSinceLastTest >= tddConfig.threshold)
      ) {
        tddSuggestNote = decision.message
     }
   }

    // Obligation RED gate（有界）：高风险 bugfix 义务尚无 RED 复现时，对目标
    // 源文件的首次编辑当轮拦截（测试/scratch 豁免；同一义务只拦一次，重发放行）。
    // TDD gate 之后——TDD 管"编辑未验证"节奏，这里管"缺陷未被证明存在"。
    if (deps.obligations && EDIT_TOOLS.has(tu.name)) {
      const editTarget = typeof tu.input?.file_path === 'string' ? tu.input.file_path : undefined
      const redDecision = deps.obligations.evaluateSourceEditGate(editTarget)
      if (redDecision.block) {
        deps.onGateBlocked?.('obligation-red')
        callbacks.onToolResult(tu.id, tu.name, redDecision.message!, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: redDecision.message!, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
    }

    // Destructive gate: 验证失败后 ≤3 个工具调用内的 git 清场命令当轮拦截
    // (首次拦截、原样重发放行)。TDD gate 之后、PreToolUse hook 之前。
    if (deps.destructiveGate && tu.name === 'bash') {
      const gateDecision = deps.destructiveGate.evaluate(tu.name, tu.input as Record<string, unknown>)
      if (gateDecision.block) {
        const blockedAt = Date.now()
        traceStore = recordTraceEvent(traceStore, {
          id: `${tu.id}:destructive-gate`,
          turn,
          kind: 'tool',
          name: 'destructive-gate:block',
          status: 'failed',
          startedAt: blockedAt,
          endedAt: blockedAt,
          durationMs: 0,
          summary: String((tu.input as Record<string, unknown>).command ?? '').slice(0, 200),
        })
        deps.onGateBlocked?.('destructive')
        callbacks.onToolResult(tu.id, tu.name, gateDecision.message, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: gateDecision.message, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
    }

    const shouldSampleToolInput = toolInputTraceDebugEnabled() || tu.name === 'grep'
    const beforeHookKeys = shouldSampleToolInput ? sortedInputKeys(tu.input) : undefined

    // PreToolUse hook
    const preHookResult = deps.config.hooks?.firePreToolUse({ toolName: tu.name, input: tu.input as Record<string, unknown> }) ?? {}
    if (preHookResult.block) {
      // 出路契约：无 reason 时给标准替代路径，不让模型面对"被拦且不知为何"的死路。
      const blockMsg = preHookResult.reason
        ? `Tool blocked by hook: ${preHookResult.reason}`
        : 'Tool blocked by a user-configured PreToolUse hook (no reason given). This is a per-tool policy, not a system failure — continue via another route: use read-only tools (read_file/grep) to gather evidence, write probes under .rivet/scratch/, or ask the user to adjust the hook in .rivet/hooks.json.'
      deps.onGateBlocked?.('pre-tool-hook')
      callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }
    if (preHookResult.input) {
      tu.input = preHookResult.input
      params.input = preHookResult.input
   }
    const afterHookKeys = shouldSampleToolInput ? sortedInputKeys(tu.input) : undefined

    // Multi-pass tool input repair
    const toolDef = deps.config.toolRegistry.get(tu.name)
    if (toolDef) {
      const repairResult = deps.repairPipeline.run(
        tu.input as Record<string, unknown>,
        { toolName: tu.name, schema: toolDef.definition.input_schema },
      )
      if (repairResult.telemetry.length > 0) {
        tu.input = repairResult.output
        params.input = repairResult.output
        const repairSummary = summarizeRepairTelemetry(repairResult.telemetry)
        if (repairSummary) {
          const now = Date.now()
          traceStore = recordTraceEvent(traceStore, {
            id: `${tu.id}:repair`,
            turn,
            kind: 'tool',
            name: `${tu.name}:repair`,
            status: 'passed',
            startedAt: now,
            endedAt: now,
            durationMs: 0,
            summary: repairSummary,
         })
       }
     }
   }
    const afterRepairKeys = shouldSampleToolInput ? sortedInputKeys(tu.input) : undefined

    // Reliability mode gate — Phase 2 degraded/minimal executor.
    const reliabilityDecision = deps.getReliabilityDecision?.() ?? null
    if (reliabilityDecision && !isToolAllowedInReliabilityMode(reliabilityDecision.mode, tu.name, tu.input)) {
      const msg = reliabilityBlockMessage(reliabilityDecision, tu.name)
      deps.onGateBlocked?.('reliability')
      callbacks.onToolResult(tu.id, tu.name, msg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }

    // Strategy shift + doom loop check
    const trajectorySummary: TrajectorySummary[] = deps.trajectory.getEntries().map(e => ({
      tool: e.tool,
      target: e.target,
      status: e.status === 'retried-failed' || e.status === 'failed' ? 'failed' : 'success',
      errorClass: e.errorClass,
   }))
    const doomLevel = deps.getDoomLoopLevel()
    const hint = suggestStrategyShift(trajectorySummary, doomLevel)
    if (doomLevel === 'blocked') {
      // Block ONLY repeats of the call(s) that are actually looping — not every
      // tool. The looping fingerprints are recorded with outputClass 'error'
      // (a passing call breaks the loop and wouldn't be blocked), so compare the
      // current call's error-variant fingerprint against the offenders. Letting
      // different tools/inputs through is what refreshes the window out of
      // 'blocked'; blocking everything deadlocks the turn (blocked calls are
      // never recorded, so the window never changes — see offendingFingerprints).
      const goalActive = deps.isGoalActive ?? false
      const thresholds = getDoomLoopThresholds(goalActive)
      const exactOffenders = offendingFingerprints(traceStore.toolFingerprints, thresholds.exact.window, thresholds.exact.blockFreq, thresholds.exact.blockConsec)
      const classOffenders = offendingFingerprints(traceStore.bashClassFingerprints ?? [], thresholds.class.window, thresholds.class.blockFreq, thresholds.class.blockConsec)
      const curExactFp = fingerprintToolCall(tu.name, tu.input, 'error')
      const curExactFpTransient = fingerprintToolCall(tu.name, tu.input, 'error-transient')
      const curClassFp = fingerprintToolClass(tu.name, tu.input, 'error')
      const isOffendingCall = exactOffenders.has(curExactFp) || exactOffenders.has(curExactFpTransient) || (curClassFp != null && classOffenders.has(curClassFp))

      if (isOffendingCall) {
        const fps = traceStore.toolFingerprints
        const lastFp = fps.at(-1)
        const maxCount = lastFp ? fps.filter(f => f === lastFp).length : 0
        const isTransientLoop = !exactOffenders.has(curExactFp) && exactOffenders.has(curExactFpTransient)
        const baseMsg = hint ?? (isTransientLoop
          ? 'Repeated transient failures (timeout/api error). The operation keeps failing for infra reasons — try a different approach instead of retrying.'
          : 'Repeated identical failures detected.')
        const msg = [
          baseMsg,
          `Tool: ${tu.name} | Consecutive same-pattern failures: ${maxCount} | Fingerprint: ${curExactFp.slice(0, 8)}`,
          isTransientLoop
            ? 'Recovery: the target may be too large or the infra overloaded. Try splitting the task, using a different tool, or reducing scope.'
            : 'Recovery: try a different tool (e.g. read_file, todo), change the input, or modify the target path.',
        ].join('\n')
        deps.onGateBlocked?.('doom-loop')
        callbacks.onToolResult(tu.id, tu.name, msg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
      }
      // Different tool/input under 'blocked' — let it run. It will be recorded
      // and slide the offending fingerprints out of the detection window.
   }

    // Plan-mode gate — block write tools during planning phase (except active plan file)
    const writePath = (tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string'
      ? tu.input.file_path
      : undefined
    const delegatesWriteCapableProfile = deps.config.planModeState === 'planning'
      && (tu.name === 'delegate_task' || tu.name === 'delegate_batch')
      && delegateProfilesFromInput(tu.input).some(p => !profileIsPlanModeSafe(p))
    const planModeResult = checkPlanMode(deps.config.planModeState ?? 'off', tu.name, {
      cwd: deps.cwd,
      targetFilePath: writePath,
      activePlanFilePath: deps.config.activePlanFilePath,
      delegatesWriteCapableProfile,
    })
    if (!planModeResult.allowed) {
      const planMsg = planModeResult.reason ?? 'Plan Mode: write operations blocked'
      deps.onGateBlocked?.('plan-mode')
      callbacks.onToolResult(tu.id, tu.name, planMsg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? planMsg + starSig : planMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }

    // Ask-mode gate — pure read-only Q&A (no write / execute / plan / delegate)
    const askModeResult = checkAskMode(deps.config.askModeState ?? 'off', tu.name)
    if (!askModeResult.allowed) {
      const askMsg = askModeResult.reason ?? 'Ask Mode: write operations blocked'
      deps.onGateBlocked?.('ask-mode')
      callbacks.onToolResult(tu.id, tu.name, askMsg, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? askMsg + starSig : askMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }

    // Sensitive-area preflight — nudge, don't block. The model must read the
    // knowledge manifest before editing prompt/memory/recall/verification/ownership
    // paths, but existing approval and edit gates remain responsible for hard safety.
    if (writePath && deps.taskLedger && shouldRequireSensitivePreflight({ path: writePath, events: deps.taskLedger.getEvents() })) {
      callbacks.onToolResult(tu.id, tu.name, buildSensitivePreflightMessage(writePath), false)
   }

    // Approval gate — with sensorium-driven adaptive confidence
    const needsApproval = deps.config.toolRegistry.needsApproval(tu.name, params)
    const antibodies = deps.config.contextClaimStore?.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] }) ?? []
    const sensorium = deps.getSensorium?.() ?? null
    const risk = assessToolRisk(tu.name, tu.input, deps.getDoomLoopLevel(), antibodies, sensorium ?? undefined, deps.config.toolRegistry?.get(tu.name)?.definition?.capability as import('../mcp/policy.js').McpCapability | undefined)
    latestRisk = risk
    const isHighRisk = risk.level === 'high'
    const approvalMode = deps.config.approvalMode ?? 'manual'
    const skipAllApproval = approvalMode === 'dangerously-skip-permissions'

    // Sensorium-driven auto-approve: high confidence + low risk → bypass approval
    const canAutoApprove = sensorium
      && sensorium.confidence >= CONFIDENCE_THRESHOLDS.autoApproveConfidence
      && (risk.level === 'none' || risk.level === 'low')
      && approvalMode === 'auto-safe'

    const allowRules = [
      ...(deps.config.permissions?.allow ?? []),
      ...(deps.config.permissionsOverlay?.allow ?? []),
    ]
    const denyRules = [
      ...(deps.config.permissions?.deny ?? []),
      ...(deps.config.permissionsOverlay?.deny ?? []),
    ]
    const bashAllowPrefixes = [
      ...(deps.config.permissions?.bash?.allowlist ?? []),
      ...(deps.config.permissionsOverlay?.bashAllow ?? []),
    ]
    const bashDenyPrefixes = [
      ...(deps.config.permissions?.bash?.denylist ?? []),
      ...(deps.config.permissionsOverlay?.bashDeny ?? []),
    ]

    // Deny rules always win, even in dangerously-skip-permissions.
    const denied = isToolDenied(tu.name, tu.input, denyRules)
    const bashDenied = tu.name === 'bash' && typeof tu.input.command === 'string'
      ? isBashCommandDenied(tu.input.command, bashDenyPrefixes)
      : false
    // Self-preservation: unconditionally block commands that would terminate the
    // agent's own runtime (the Node sidecar/TUI process). Killing the process the
    // agent runs in aborts the session and can drop its API auth → 401 cascade.
    // Always on, independent of config/approval mode — a self-kill is never a
    // legitimate autonomous action.
    const selfKill = tu.name === 'bash' && typeof tu.input.command === 'string'
      ? isSelfDestructiveKill(tu.input.command, selfProcessTree())
      : false
    if (denied || bashDenied || selfKill) {
      const reason = selfKill
        ? "Tool execution blocked: this command would terminate the agent's own runtime (the Rivet sidecar / Node process it runs in). That aborts the session and drops its API auth. To restart a local dev server, use a targeted command like `npx kill-port <port>` or kill a specific non-agent PID; otherwise ask the user to restart it manually."
        : `Tool execution denied: ${tu.name} matches an active deny rule. This is a user-configured permission boundary, not a dead end — continue via another route: gather evidence with read-only tools (read_file/grep/glob), write probes under .rivet/scratch/, or ask the user to adjust the permissions deny rules if this operation is genuinely required.`
      deps.onGateBlocked?.(selfKill ? 'self-kill' : 'deny')
      callbacks.onToolResult(tu.id, tu.name, reason, true)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: reason, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
    }

    const allowlisted = isToolAllowed(tu.name, tu.input, allowRules)
    const bashAllowlisted = tu.name === 'bash' && typeof tu.input.command === 'string'
      ? isBashCommandAllowlisted(tu.input.command, bashAllowPrefixes)
      : false
    // Autonomy-first: when a real kernel sandbox boundary is in effect, an
    // in-workspace bash write is safe-by-construction (writes can't escape the
    // workspace, and B2 rollback makes them reversible), so it must NOT
    // interrupt an unattended run for approval. When no sandbox is available we
    // stay fail-closed for risky writes, but auto-safe mode auto-approves safe
    // writes (mkdir/touch/cp/echo>file) to avoid approval fatigue on Windows.
    const bashCommand = tu.name === 'bash' && typeof tu.input.command === 'string' ? tu.input.command : ''
    // Per-command, not per-process: an incompatible-command bypass (brew /
    // docker / codesign) runs unsandboxed even when the sandbox is on, and must
    // stay fail-closed for approval.
    const noSandbox = bashCommand.length > 0
      ? !sandboxCoversCommand(bashCommand)
      : !isSandboxActive()
    const safeWriteInNoSandbox = noSandbox
      && approvalMode === 'auto-safe'
      && bashCommand.length > 0
      && isSafeWriteOnly(bashCommand)
      // 写目标必须留在工作区内：pipeline 的路径校验只覆盖文件工具，bash 写目标
      // （重定向/cp/mkdir 参数）不经 validatePathSafe——`echo k >> ~/.ssh/authorized_keys`
      // / `cp a D:\Startup\x.exe` 不能按"安全写"静默放行。
      && !hasOutOfWorkspaceWriteTarget(bashCommand)
    const bashWriteRequiresApproval =
      requiresBashWriteApproval(tu.name, tu.input)
      && !allowlisted && !bashAllowlisted
      && !safeWriteInNoSandbox
      && noSandbox

    // Protection mode: during doom-loop, destructive git actions always require
    // approval. warn is the live window (blocked is short-circuited earlier).
    const protectionMode = deps.getDoomLoopLevel() !== 'none' && isDestructiveGitAction(tu.name, tu.input)

    // Out-of-workspace file op: the path is outside the workspace and not yet
    // granted. Instead of hard-blocking in execute(), route through the approval
    // flow — on approval we record a directory-subtree grant so the op proceeds.
    //
    // request_path_access is relaxed under YOLO (B): the user already opted
    // out of prompts. File-tool write paths under an existing read grant are
    // auto-upgraded to write (C). The kernel sandbox still blocks writes to
    // ungranted paths; unattended runs can pre-authorize via additionalWriteDirs.
    const pathGrantNeed = outOfWorkspaceFilePaths(deps.cwd, tu.name, tu.input)

    // Hard gate: arbitrary-JS / endpoint-takeover actions (computer_use
    // js_eval / browser_adopt) and kernel-boundary widening (request_path_access)
    // always ask in supervised/default modes — no allow rule or sensorium
    // confidence can waive them there.
    const unconditionalApproval = requiresUnconditionalApproval(tu.name, tu.input)
    // YOLO (自治/完全访问) waives the unconditional gate entirely: the user
    // explicitly chose maximum autonomy — checkpoints/rollback are the safety
    // net, not prompts. Deny rules and self-kill protection still apply above.
    const yoloBypassesUnconditional = skipAllApproval

    let shouldAsk = (unconditionalApproval && !yoloBypassesUnconditional)
      ? true
      : skipAllApproval
        ? false
        : pathGrantNeed
          ? true
          : protectionMode
            ? true
            : bashWriteRequiresApproval
              ? true
              : allowlisted
                ? false
                : canAutoApprove
                  ? false
                  : approvalMode === 'manual'
                    ? needsApproval
                    : approvalMode === 'auto-safe'
                      ? isHighRisk
                      : false

    // YOLO mode intelligent fallback: auto-grant write access for file-tool
    // paths already covered by a read grant. This eliminates the validatePath →
    // request_path_access → unconditional popup chain that makes "完全访问"
    // (yolo + additionalReadDirs: ["/"]) meaningless for writes outside the
    // workspace. The kernel sandbox still blocks writes to ungranted paths;
    // unattended runs can pre-authorize via additionalWriteDirs.
    if (skipAllApproval && pathGrantNeed) {
      for (const p of pathGrantNeed.paths) {
        // 完全读写档：零审批打扰承诺——出界路径**首触即授**（会话级，不出会话）。
        // 此前仅「先读后写」升级：未读过就写要多花一轮 request_path_access
        // 自愈，违背 skip 档的零打断语义。读/写统一当场授予；持久授权仍只能
        // 经用户 remember（persist）。
        grantPath(dirname(p), pathGrantNeed.mode, { cwd: deps.cwd })
      }
    }

    // Headless override — no human can answer an approval prompt here, so a
    // shouldAsk that reaches onApprovalRequired would hang (the callback returns
    // false, denying every write and stalling the worker until its turn budget
    // runs out). Resolve it deterministically instead: in-workspace file writes
    // are auto-approved (worktree/claim isolation + primary diff review), and
    // everything else that would ask falls through to the deny path below with a
    // model-facing message. Deny rules / self-kill (handled above) and
    // out-of-workspace grants (pathGrantNeed) are NOT relaxed.
    if (deps.config.headless && shouldAsk && !pathGrantNeed) {
      if (HEADLESS_AUTO_APPROVE_WRITE_TOOLS.has(tu.name)) {
        shouldAsk = false
      }
      // Otherwise keep shouldAsk = true → onApprovalRequired returns false →
      // the deny branch emits the headless instruction message.
    }

    if (shouldAsk) {
      touchActivity(activityKey, `tool:${tu.name}:await-approval`)
      const approvalResult = await callbacks.onApprovalRequired(tu.id, tu.name, tu.input)
      const resolved: ApprovalResult = typeof approvalResult === 'boolean'
        ? { approved: approvalResult }
        : approvalResult
      const finalInput = applyApprovalEdit(tu.input, resolved)
      if (!finalInput) {
        // Record the denied call's fingerprint so the doom-loop detector can see
        // repeated identical denials. Denied calls short-circuit here, before the
        // post-exec recordToolFingerprint at the bottom, so without this the
        // anti-repeat window never sees them and the model re-emits the same
        // approval-blocked call forever (the classic "requires user approval" loop).
        // Use outputClass 'error' to match the offender fingerprint the doom-loop
        // gate compares against (see the doomLevel === 'blocked' branch above).
        traceStore = recordToolFingerprint(traceStore, fingerprintToolCall(tu.name, tu.input, 'error'), null)
        const target = writePath
          ? ` (${writePath})`
          : tu.name === 'bash' && typeof tu.input.command === 'string'
            ? ` (${tu.input.command.slice(0, 60)})`
            : ''
        // Instructive, non-retry denial: this is NOT a rejection of the change on
        // its merits — it needs explicit user approval the model cannot self-grant.
        // Re-emitting the identical call only re-hits the same gate, so tell the
        // model to stop and hand control back to the user instead of retrying.
        const noSandboxReason = bashWriteRequiresApproval && noSandbox
          ? '\n根因：当前命令不在文件系统沙箱保护下（原生 Windows 无内核沙箱 / 未装 bwrap / 该命令走了沙箱旁路），故写命令需人工审批。这不是命令本身的问题——审批后即可执行。要减少审批频率：Linux 装 bubblewrap、Windows 走 WSL，或用 permissions.bash.allowlist 为可信命令前缀免审批。'
          : ''
        const denyMsg = deps.config.headless
          ? [
              // HEADLESS_DENY_MARKER embedded here — detectApprovalDeadlock matches on it.
              `Tool "${tu.name}"${target} is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
              'Do NOT re-emit this call — it will keep hitting the same gate and waste your turn budget.',
              'Instead: accomplish the task using an allowed tool if possible, or finish now by returning your result JSON with status "blocked" and explain in the summary which operation was gated.',
              'If the gate was an out-of-workspace path grant, the operator must pre-authorize it in config: permissions.additionalWriteDirs.',
            ].join('\n')
          : [
              `Tool "${tu.name}"${target} was not executed: it requires explicit user approval, which you cannot grant yourself.${noSandboxReason}`,
              'This is NOT a rejection of the change itself. Do NOT re-emit the identical call — repeating it will keep hitting the same approval gate and make no progress.',
              'Instead: briefly state what you were about to do and why it needs approval, then stop and wait for the user to approve it (or adjust their instruction).',
            ].join('\n')
        callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
        return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: denyMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
     }
      if (finalInput !== tu.input) {
        tu.input = finalInput
        params.input = finalInput
     }
      // Thermocline 2: learn bash command prefix into session allowlist after approval
      if (tu.name === 'bash' && typeof tu.input.command === 'string') {
        learnBashPrefix(tu.input.command, deps.config.permissions)
     }
      // Learn a file-scoped approval so subsequent identical edits to the same
      // file don't re-prompt (a key driver of the "approve → edit → approve
      // again" fatigue that seeds retry loops). Manual mode only — auto-safe must
      // keep re-checking high-risk writes rather than trusting a one-off approve.
      if (approvalMode === 'manual' && (tu.name === 'edit_file' || tu.name === 'write_file') && typeof tu.input.file_path === 'string') {
        learnFileApproval(tu.name, tu.input.file_path, deps.config.permissionsOverlay)
     }
      // Out-of-workspace file op approved: record a directory-subtree grant so
      // both gates (validatePathSafe + sandbox) accept it. Recompute from the
      // (possibly edited) final input so an edited path is granted, not the stale one.
      // `remember` persists the grant to the per-workspace store so the same
      // directory is not re-prompted in the next session; without it the grant
      // stays in-process, which is what an unqualified "approve once" means.
      const approvedGrant = outOfWorkspaceFilePaths(deps.cwd, tu.name, tu.input)
      if (approvedGrant) {
        const persist = resolved.remember === true
        for (const p of approvedGrant.paths) {
          grantPath(dirname(p), approvedGrant.mode, { persist, cwd: deps.cwd })
        }
      }
   }

    // R2 — concurrent write conflict block (desktop multi-session). When a live
    // SessionRegistry is wired and another active session holds an exclusive
    // claim on a target file, fail-closed: refuse the write instead of
    // clobbering a peer session's in-flight edit. acquireClaim is idempotent for
    // the same session, so an uncontended write also stakes our claim here.
    // Covers every workspace-writing tool via preWriteClaimPaths — a guard
    // keyed to write_file/edit_file alone left the other four write tools as
    // an unguarded side door. Only active when a registry is present — CLI /
    // single-session / no-registry paths are completely unaffected.
    if (deps.sessionRegistry && deps.sessionId) {
      const staked: string[] = []
      for (const claimPath of preWriteClaimPaths(tu, deps.cwd)) {
        const acquired = deps.sessionRegistry.acquireClaim(deps.sessionId, claimPath, 'exclusive')
        if (!acquired) {
          // 多路径调用（apply_patch 补丁、ast_edit 多 paths）中途被拦时，把本次
          // 已认领的路径放回去——否则补丁被拒却留下无主 exclusive claim（claims
          // 表无 TTL，只随进程死亡回收），反把 peer 挡在门外。范式同 coordinator
          // 重试认领的回滚。
          for (const p of staked) deps.sessionRegistry.releaseClaim(deps.sessionId, p)
          const owner = deps.sessionRegistry.checkClaim(claimPath)
          const ownerTag = owner?.sessionId ? `（会话 ${owner.sessionId.slice(0, 8)}）` : ''
          const blockMsg =
            `文件「${claimPath}」正被另一个会话${ownerTag}独占编辑，已阻断本次写入以避免并发冲突。` +
            `请等待对方完成，或改写其它文件。`
          callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
          return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
        }
        staked.push(claimPath)
      }
    }

    // Checkpoint before the first MUTATING tool of the turn. Beyond file edits
    // this now covers bash (and apply_patch): any shell side effect must fall
    // inside the rollback window, so the snapshot baseline has to be taken
    // before bash runs — not only before write_file/edit_file.
    if (isMutatingTool(tu.name) && !checkpointCreated) {
      touchActivity(activityKey, `tool:${tu.name}:pre:checkpoint`)
      const cp = await createCheckpoint(deps.cwd, 'auto', deps.config.sessionId)
      checkpointCreated = true
      if (cp) callbacks.onCheckpoint?.(cp.hash)
   }

    if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
      recordAgentTouchedFile(deps.cwd, tu.input.file_path, deps.config.sessionId)
   }

    if (deps.config.fileHistory && (tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
      touchActivity(activityKey, `tool:${tu.name}:pre:track-edit`)
      await deps.config.fileHistory.trackEdit(tu.input.file_path, tu.id)
   }

    // Execute via TurnHarness
    // P3-C: trigger speculative pre-execution for next likely tool
    const toolTarget = toolTargetFromInput(tu.name, tu.input)
    const priorReadLoopPlaceholders = countRecentReadLoopPlaceholders(deps.trajectory.getEntries(), toolTarget)
    deps.p3?.onToolStart(tu.name, toolTarget)
    // T5b 观察态窥视（RIVET_SPEC_OBSERVE=1 时才有实效，封存态 no-op）：
    // 在真实工具执行点按 tool+target 记 would-hit/miss——这是命中率数据的
    // 唯一采集口。恒不取内容，serving 维持封存。
    deps.p3?.observeSpeculativeCache(tu.name, toolTarget)

    // P3-C speculative chain SEALED (2026-07-06 服务路径切除 → 2026-07-07 全链
    // 关停): 当时 ShadowQueue 缓存无 mtime/TTL 校验，预读结果曾在文件多次变更后
    // 仍被当作 read_file 结果返回（TDX 事故：模型推理"文件被回退"并连锁触发
    // old_string not found / hash_edit stale / 重读风暴）。
    // 状态更新（2026-08-07）：mtime 契约已实现（shadow-queue.ts，含写后
    // queue.clear 失效），封存维持原因 = 经济性——当年影子遥测判"预执行纯耗
    // 资源"。观察态（RIVET_SPEC_OBSERVE=1）重新采命中率，解封 serving 由
    // 数据 + 用户确认决定。见 P3Config.speculativeEnabled / speculativeObserve。

    const traceId = tu.id
    traceStore = startTraceEvent(traceStore, {
      id: traceId,
      turn,
      kind: 'tool',
      name: tu.name,
      startedAt: Date.now(),
      summary: JSON.stringify(tu.input).slice(0, 60),
      predictedSuccess: true,
   })
    let rawToolResult: import('../tools/types.js').ToolResult | undefined

    // VSW: for run_tests, ask the snapshot manager whether to isolate. §6 policy
    // decides; in the common single-clean-session case it returns null → params
    // stays unset → in-place single-phase verification (unchanged default). Any
    // failure here degrades to in-place — VSW must never break verification.
    if (tu.name === 'run_tests' && deps.verificationSnapshotManager) {
      try {
        touchActivity(activityKey, `tool:${tu.name}:pre:snapshot`)
        const plan = await deps.verificationSnapshotManager.prepare(deps.ownershipLedger?.getOwnedFiles() ?? [])
        if (plan) params.verificationSnapshot = { path: plan.path, snapshotRef: plan.snapshotRef }
      } catch {
        // degrade to in-place
      }
      // C3: when running in-place, arm the failure-attribution retry — but only
      // when live pollution signals make failures ambiguous: peer workspace
      // mutations (stash/reset events from B1). Without signals the retry stays
      // unarmed so a plain broken test doesn't pay for a worktree build.
      if (!params.verificationSnapshot && deps.sessionRegistry && deps.sessionId) {
        try {
          const polluted = deps.sessionRegistry.consumeEvents(deps.sessionId, 0, 10)
            .some(e => e.eventType === 'workspace_mutation')
          if (polluted) {
            const mgr = deps.verificationSnapshotManager
            params.prepareRetrySnapshot = async () => {
              const retry = await mgr.prepareRetry(deps.ownershipLedger?.getOwnedFiles() ?? [])
              return retry ? { path: retry.path, snapshotRef: retry.snapshotRef } : null
            }
          }
        } catch { /* attribution retry is best-effort */ }
      }
    }

    if (tu.name === 'deliver_task') {
      touchActivity(activityKey, `tool:${tu.name}:pre:git-head`)
      preAbortHead = await gitHeadQuiet(deps.cwd)
    }

    const harnessResult = await deps.harness.executeTool({
      id: tu.id,
      name: tu.name,
      input: tu.input,
      turn,
      execute: async () => {
        // 无进展哨兵打点：工具执行起止（CLI/server 共用 agent 内核）。start
        // 后无 end = 卡在工具内（stall-observer 90s 后指认）；end 后无下一
        // start = 卡在回合处理。finally 保证 end 在成功/失败/超时都触达。
        // activityKey 定义在函数头（pre/post 段共用）。
        touchActivity(activityKey, `tool:${tu.name}:start`)
        try {
          // P5+P6: read_file must always go through real execute to honor the
          // active contextWindow's read cap. The prewarm cache is shared with
          // P3 speculative reads which may have been populated under a different
          // (smaller) cap; serving cached content here would re-introduce the
          // truncation regression. fs.readFile + OS page cache is fast enough.
          const toolTimeout = toolDef?.timeoutMs?.(params) ?? DEFAULT_TOOL_TIMEOUT_MS
          // P0/H1: compose a per-tool timeout AbortController with the loop signal,
          // so a tool-level timeout cascades an abort into the underlying op
          // (child proc / fetch) instead of merely rejecting the wrapper Promise.
          const toolAbort = new AbortController()
          const composedSignal = deps.abortSignal
            ? AbortSignal.any([deps.abortSignal, toolAbort.signal])
            : toolAbort.signal
          const r = await withToolTimeout(
            deps.config.toolRegistry.execute(tu.name, { ...params, approvalMode, abortSignal: composedSignal }),
            tu.name,
            toolTimeout,
            deps.abortSignal,
            toolAbort,
          ).catch((err) => {
            // 超时错误补目标摘要（2026-09-08 写后挂起事故教训）：模型与 sidecar
            // 日志都能指认是哪个文件/命令超时，而非只有工具名。日志留痕——
            // 超时走 reject 路径不进 trajectory（turn-harness 只记录返回结果）。
            if (err instanceof Error && err.message.includes('timed out')) {
              console.warn(`[tool-timeout] ${tu.name} timed out after ${toolTimeout / 1000}s (target: ${toolTarget ?? 'unknown'})`)
              if (toolTarget) throw new Error(`${err.message} (target: ${toolTarget})`)
            }
            throw err
          })
          rawToolResult = r
          return { content: r.content, isError: r.isError }
        } finally {
          touchActivity(activityKey, `tool:${tu.name}:end`)
        }
     },
      classify: (content) => resolveErrorKind(rawToolResult ?? undefined) ?? classifyFailure(content).class,
      isConcurrencySafe: toolDef?.isConcurrencySafe() ?? false,
   })

    if (shouldSampleToolInput && shouldEmitToolInputTrace(tu.name, beforeHookKeys, afterHookKeys, afterRepairKeys)) {
      touchActivity(activityKey, `tool:${tu.name}:post:trace`)
      await emitToolInputTrace({
        cwd: deps.cwd,
        sessionId: deps.sessionId,
        message: `[tool-input-trace] id=${tu.id} name=${tu.name} isError=${harnessResult.isError}` +
        ` beforeHook=${JSON.stringify(beforeHookKeys ?? [])}` +
        ` afterHook=${JSON.stringify(afterHookKeys ?? [])}` +
        ` afterRepair=${JSON.stringify(afterRepairKeys ?? [])}`,
      })
    }

    // PostToolUse hook
    touchActivity(activityKey, `tool:${tu.name}:post:hooks`)
    const postHookResult = deps.config.hooks?.firePostToolUse({
      toolName: tu.name,
      input: tu.input as Record<string, unknown>,
      result: harnessResult.content,
      isError: harnessResult.isError,
   }) ?? {}
    let finalContent = postHookResult.result ?? harnessResult.content
    // Normalize: strip trailing whitespace to produce stable byte sequences
    // for DeepSeek exact-prefix cache. Non-deterministic trailing whitespace
    finalContent = finalContent.trimEnd()

    // Foreign-alias teaching note: the call was transparently remapped at the
    // pipeline entry; surface the canonical name so the model learns it.
    if (aliasNote) {
      finalContent = `${aliasNote}\n${finalContent}`
    }

    // LSP: notify the language server that a file changed on disk.
    // Must happen BEFORE diagnostics so the server's view is current.
    if (!harnessResult.isError && (tu.name === 'edit_file' || tu.name === 'write_file' || tu.name === 'apply_patch')) {
      (deps.getLspManager?.() ?? deps.lspManager)?.changeFile(tu.input.file_path as string)
   }

    // T4: LSP diagnostics via lspManager (async file-level, ~2s timeout)
    const mgr = deps.getLspManager?.() ?? deps.lspManager
    if (!harnessResult.isError && mgr?.isReady() && shouldRunDiagnostics(tu.name, tu.input.file_path as string | undefined)) {
      try {
        touchActivity(activityKey, `tool:${tu.name}:post:lsp`)
        const diagnostics = await mgr.getFileDiagnostics(tu.input.file_path as string)
        if (diagnostics.length > 0) {
          // 作用域收敛: only surface diagnostics from the edit's changed region to
          // the model — out-of-region errors collapse to a one-line nudge and
          // out-of-region warnings are dropped. Whole-file / cross-file type
          // errors are comprehensively caught by the post-commit typecheck-gate
          // (real tsc on all changed files) at delivery. The full list still goes
          // to uiContent so the human sees everything in the tool card.
          const { modelText, uiText } = filterDiagnosticsForEdit(diagnostics, rawToolResult?.changedRanges)
          const uiBase = rawToolResult?.uiContent ?? finalContent
          if (modelText) {
            finalContent = finalContent + `\n\n[LSP Diagnostics]\n${modelText}`
          }
          if (uiText && rawToolResult) {
            rawToolResult.uiContent = `${uiBase}\n\n[LSP Diagnostics]\n${uiText}`
          }
        }
      } catch {
        // Silent: LSP diagnostics are best-effort, never fail the turn
      }
   }

    // Capture bash/shell side effects into the rollback window. The per-edit
    // recorder above only sees write_file/edit_file; bash can create, delete or
    // rewrite arbitrary files. We diff the worktree against the turn's snapshot
    // baseline and attribute the changes to THIS session — never to paths a
    // different live session exclusively owns (parallel-branch safety).
    if (!harnessResult.isError && tu.name === 'bash' && checkpointCreated) {
      try {
        const guard = buildOwnershipGuard(deps)
        const bashCommand = typeof tu.input?.command === 'string' ? tu.input.command : undefined
        await recordBashSideEffects(deps.cwd, deps.config.sessionId, guard, bashCommand)
      } catch { /* best-effort: capture failure must not fail the turn */ }
    }

    if (!harnessResult.isError) {
      if (FIDELITY_EXEMPT_TOOLS.has(tu.name)) {
        // Fidelity-first: deliver the skill instructions verbatim. We still
        // account for the budget so later tools see the cost, but we never
        // rewrite the content (no artifact summary, no truncation, no preview).
        deps.turnBudget.consume(Math.ceil(finalContent.length / 4))
      } else {
        // Artifact intercept: persist long output to disk, replace with compact ref.
        // This must run BEFORE truncation — if we store an artifact, truncation is unnecessary.
        const successThreshold = deps.cacheAdvisor?.getArtifactThreshold(deps.phaseHint ?? 'execute', false)
        const budgetFraction = deps.turnBudget.maxTokensPerTurn > 0
          ? 1 - (deps.turnBudget.usedTokens / deps.turnBudget.maxTokensPerTurn)
          : 1
        touchActivity(activityKey, `tool:${tu.name}:post:artifact`)
        finalContent = await artifactIntercept(finalContent, tu.name, tu.input, deps.artifactStore, false, successThreshold, budgetFraction, deps.config.contextWindow)
        // Track eviction for GhostRegistry
        const evictedId = extractArtifactId(finalContent)
        if (evictedId) deps.artifactIdsEvicted?.push(evictedId)
        finalContent = truncateSuccessfulToolResult(finalContent, deps.config)
        const contentChars = finalContent.length
        const tokenEstimate = Math.ceil(contentChars / 4)
        deps.turnBudget.consume(tokenEstimate)
        if (deps.turnBudget.isExhausted()) {
          const preview = finalContent.slice(0, 500)
          const refPath = rawToolResult?.rawPath ?? 'unknown'
          finalContent = `<stored ref="${refPath}" chars=${contentChars} tool="${tu.name}">\n${preview}\n...(turn budget exceeded — use read_file with offset/limit for full content)</stored>`
        }
      }
   } else {
      // Error results can also be very long (e.g. failed test output).
      // Artifact-intercept them too to keep message history append-only.
      const errorThreshold = deps.cacheAdvisor?.getArtifactThreshold(deps.phaseHint ?? 'execute', true)
      const budgetFraction = deps.turnBudget.maxTokensPerTurn > 0
        ? 1 - (deps.turnBudget.usedTokens / deps.turnBudget.maxTokensPerTurn)
        : 1
      finalContent = await artifactIntercept(finalContent, tu.name, tu.input, deps.artifactStore, true, errorThreshold, budgetFraction, deps.config.contextWindow)
      // Track eviction for GhostRegistry (error artifacts too)
      const evictedErrId = extractArtifactId(finalContent)
      if (evictedErrId) deps.artifactIdsEvicted?.push(evictedErrId)

      // P3-A: inject mistake hints for known error patterns
      if (deps.p3) {
        const hints = deps.p3.getMistakeHints(finalContent.slice(0, 300), `${tu.name} ${toolTarget}`)
        if (hints) finalContent = finalContent + '\n' + hints
     }
   }

    const readLoopSignal = buildReadLoopStrategySignal(tu.name, toolTarget, finalContent, priorReadLoopPlaceholders)
    if (readLoopSignal) finalContent = `${finalContent}${readLoopSignal}`

    // Trace recording
    traceStore = finishTraceEvent(traceStore, traceId, {
      status: harnessResult.isError ? 'failed' : 'passed',
      endedAt: Date.now(),
      summary: harnessResult.content.slice(0, 100),
   })
    // Record prediction outcome for the cerebellar prediction loop.
    // In verify phase (kaiyang-testing), run_tests returning RED is expected
    // TDD behavior — an information gain, not a cognitive prediction failure.
    // Skipping prediction recording here prevents the phasic penalty feedback
    // loop that causes "信心 0%" self-fulfilling doubt during TDD cycles.
    const isTestRun = tu.name === 'run_tests'
    const isVerifyPhase = (deps.phaseHint ?? 'execute') === 'verify'
    const isTddRed = isTestRun && isVerifyPhase && harnessResult.isError
    // Environment-class failures (command-not-found on the host — endemic on
    // Windows where `python`/POSIX tools are simply absent) are NOT competence
    // failures. Recording them as prediction errors craters momentum/EFE and trips
    // the cerebellar prediction-error gate, making the agent timid (低信念 → 不敢做事).
    // Skip prediction recording entirely, exactly like TDD-red information gain.
    const isEnvFailure = harnessResult.isError && rawToolResult?.errorClass === 'environment'
    if (!isTddRed && !isEnvFailure) {
      deps.recordPrediction?.(!harnessResult.isError)
   }
    let outputClass: string
    if (!harnessResult.isError) {
      outputClass = 'success'
    } else {
      const fc = classifyToolFailure(rawToolResult, harnessResult.content)
      outputClass = isTransient(fc.class) ? 'error-transient' : 'error'
    }
    const fp = fingerprintToolCall(tu.name, tu.input, outputClass)
    // bash 类指纹：sed/head/python/tee 变体归并为同一命令类，堵 doom-loop 漏检
    const classFp = fingerprintToolClass(tu.name, tu.input, outputClass)
    traceStore = recordToolFingerprint(traceStore, fp, classFp)

    // P3-A: write path — when a tool resolves a prior failure of itself,
    // record the mistake into MistakeNotebook so getMistakeHints can find
    // it next time. Read path is already wired above (line ~558).
    if (!harnessResult.isError && deps.p3) {
      const resolution = detectMistakeResolution(traceStore, traceId, tu.name)
      if (resolution) {
        try {
          const inputDigest = JSON.stringify(sanitizeMistakeResolutionInput(tu.name, tu.input)).slice(0, 200)
          deps.p3.recordMistake(
            resolution.error,
            resolution.context,
            inputDigest,
            [tu.name],
          )
       } catch { /* non-critical: notebook learning is best-effort */ }

        // Immune adaptive learning: record successful repair fingerprint
        if (deps.immuneHook) {
          try {
            const fingerprint = `${tu.name}:${JSON.stringify(tu.input).slice(0, 100)}`
            deps.immuneHook.recordRepairSuccess(
              fingerprint,
              { type: 'quarantine', targetFile: undefined },
              turn,
            )
         } catch { /* non-critical: immune learning is best-effort */ }
       }
     }
   }

    // TDD suggest 提醒附加（编辑成功才贴；失败的编辑结果本身已是反馈）。
    // 追加在结果尾部 = 对话历史末尾，前缀缓存的已冻结前缀不变。
    if (tddSuggestNote && !harnessResult.isError) {
      finalContent = `${finalContent}\n\n[TDD] ${tddSuggestNote}`
    }

    // Normalize isError: tools may omit isError on success (undefined),
    // but the TUI treats undefined as a streaming chunk that never
    // commits to scrollback. Force false so terminal results render.
    // DEBUG: unconditional trace for TUI rendering-loss investigation.
    // Log file: ~/.rivet/sessions/<project-slug>/<sessionId>/tool-result-trace.jsonl
    void emitToolResultTrace({ cwd: deps.cwd, sessionId: deps.sessionId, id: tu.id, name: tu.name, isError: harnessResult.isError, contentLen: finalContent.length, source: 'pipeline' })
    callbacks.onToolResult(tu.id, tu.name, finalContent, harnessResult.isError ?? false, rawToolResult?.rawPath, rawToolResult?.uiContent)

    deps.recordToolHistory(tu.name, tu.input, harnessResult.isError, harnessResult.content, rawToolResult?.errorClass, rawToolResult?.errorKind)

    // Destructive gate 窗口计数:只数实际执行到这里的工具(被拦截的调用在
    // evaluate 处已短路返回,不计数,窗口保持)。
    deps.destructiveGate?.noteToolExecuted()

    touchActivity(activityKey, `tool:${tu.name}:post:ledger`)
    // B1 归属星轨：record tool events into TaskLedger
    if (deps.taskLedger) {
      let filePath = (tu.input.file_path ?? tu.input.path) as string | undefined
      // Normalize: if absolute path under cwd, convert to relative so it
      // matches git-reported paths in collectCurrentDirtyFiles.
      if (filePath && (filePath.startsWith(deps.cwd + '/') || filePath.startsWith(deps.cwd + '\\'))) {
        filePath = filePath.slice(deps.cwd.length + 1)
     }
      if (tu.name === 'read_file' && filePath) {
        deps.taskLedger.record({ type: 'file_read', path: filePath })
     } else if ((tu.name === 'write_file' || tu.name === 'edit_file' || tu.name === 'hash_edit') && filePath) {
        deps.taskLedger.record({ type: 'file_write', path: filePath })
        deps.ownershipLedger?.registerOwned(filePath)
        // P2 cross-session signal: auto-acquire exclusive claim on written file
        if (deps.sessionRegistry && deps.sessionId) {
          deps.sessionRegistry.acquireClaim(deps.sessionId, filePath, 'exclusive')
       }
        // B2: if edit_file failed due to external modification and there are
        // recent workspace_mutation events, append context so the agent knows
        // the file was changed by a peer stash/reset, not random corruption.
        if (harnessResult.isError && typeof harnessResult.content === 'string' &&
            /\bmodified\b/.test(harnessResult.content)) {
          const mutations = deps.sessionRegistry && deps.sessionId
            ? deps.sessionRegistry.consumeEvents(deps.sessionId, 0, 10)
                .filter(e => e.eventType === 'workspace_mutation')
            : []
          if (mutations.length > 0) {
            const detail = mutations.map(e => {
              try {
                const d = JSON.parse(e.detail ?? '{}') as { kind?: string; sessionId?: string }
                return `${d.kind ?? 'mutation'} by ${d.sessionId?.slice(-8) ?? 'peer'}`
              } catch { return e.detail ?? 'workspace mutation' }
            }).join('; ')
            finalContent += `\n\n[cross-session] Recent workspace mutations: ${detail}. Your edit may have failed because a peer session temporarily cleared the working tree — do NOT re-edit or revert. Wait for stash_pop or verify the current file state.`
          } else {
            // No attributable workspace mutation — non-git external change
            // (IDE autosave, file sync tool, manual edit in another terminal).
            // Give concrete triage guidance instead of the cryptic default.
            finalContent += `\n\n[external-change] The file changed on disk but no known workspace operation (stash/reset by a peer session) explains it. Likely causes: IDE autosave, a file-sync tool, or a manual edit in another terminal. Re-read the file to see its current state before editing — do NOT assume your earlier changes were lost or blindly re-apply them.`
          }
        }
        // Commit nudge: warn when uncommitted files accumulate
        const nudge = buildCommitNudge({ ownedFiles: deps.taskLedger.getOwnedFiles() })
        if (nudge) finalContent += nudge
     } else if (tu.name === 'apply_patch' || tu.name === 'ast_edit') {
        // 路径与写前守卫同源（pre-write-claims 的 preWriteClaimPaths）：同一套
        // cwd 相对键，绝对路径入参与 ast_edit 的单数 path 别名不再漂移；只读
        // 变体（apply_patch check_only、ast_edit 缺省即预览）在那里早退为空。
        // 目录 / '.' 原样记录（无法展开为具体文件，claim-audit 的代码判定会
        // 自然忽略）。漏记会让 claim-audit 的验证新鲜度对账失明：测完再 patch，
        // 旧验证仍显示"新鲜"，"全绿"宣称假放行（审查 2026-07-07 #1）。
        const paths = harnessResult.isError ? [] : preWriteClaimPaths(tu, deps.cwd)
        if (paths.length > 0) {
          for (const p of paths) {
            deps.taskLedger.record({ type: 'file_write', path: p })
            deps.ownershipLedger?.registerOwned(p)
            if (deps.sessionRegistry && deps.sessionId) {
              deps.sessionRegistry.acquireClaim(deps.sessionId, p, 'exclusive')
            }
          }
        } else {
          deps.taskLedger.record({ type: 'tool_exec', tool: tu.name })
        }
     } else if (tu.name === 'plan_close' && filePath) {
        if (tu.input.apply === true && !harnessResult.isError) {
          deps.taskLedger.record({ type: 'file_write', path: filePath })
          deps.ownershipLedger?.registerOwned(filePath)
          if (deps.sessionRegistry && deps.sessionId) {
            deps.sessionRegistry.acquireClaim(deps.sessionId, filePath, 'exclusive')
         }
       } else {
          deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, path: filePath })
       }
     } else if (tu.name === 'git') {
        // 结构化 git 工具记 git_action——否则 claim-audit 看不到 stash/stash_pop
        // 这类工作树变异，还原代码后旧验证仍显示"新鲜"（审查 2026-07-07 #7）。
        const action = (tu.input.action as string | undefined) ?? ''
        deps.taskLedger.record({ type: 'git_action', tool: tu.name, meta: { command: `git ${action}` } })
        // B1: publish workspace_mutation for stash/stash_pop so peer sessions
        // know the worktree is being temporarily cleared for verification.
        const kind = action === 'stash' ? 'stash' : action === 'stash_pop' ? 'stash_pop' : undefined
        if (kind && deps.sessionRegistry && deps.sessionId) {
          deps.sessionRegistry.publishEvent(deps.sessionId, {
            eventType: 'workspace_mutation',
            detail: JSON.stringify({ kind, sessionId: deps.sessionId }),
            priority: 1,
          })
        }
     } else if (tu.name === 'bash') {
        const cmd = (tu.input.command as string | undefined) ?? ''
        if (!harnessResult.isError && (cmd.startsWith('git ') || /\b(rm|mv|cp|touch|mkdir)\b/.test(cmd))) {
          deps.config.promptEngine.markGitDirty()
          // bash 写操作也追踪到 evidence——否则 CompletionCurtain 的 filesModified 为空。
          // 从命令里粗略提取文件路径（重定向目标、git add 文件等），best-effort。
          const redirectMatch = cmd.match(/>>?\s*([^\s|&;]+)/)
          if (redirectMatch?.[1]) deps.evidence.trackFileModified(redirectMatch[1]!)
       }
        if (cmd.startsWith('git ')) {
          deps.taskLedger.record({ type: 'git_action', tool: tu.name, meta: { command: cmd.slice(0, 200) } })
          // B1: publish workspace_mutation for bash-executed git destructive commands
          const kind = gitMutationKind(cmd)
          if (kind && deps.sessionRegistry && deps.sessionId) {
            deps.sessionRegistry.publishEvent(deps.sessionId, {
              eventType: 'workspace_mutation',
              detail: JSON.stringify({ kind, sessionId: deps.sessionId }),
              priority: 1,
            })
          }
       } else if (/\b(tsc|typecheck|check|test|jest|vitest|mocha|pytest|eslint|lint|build)\b/.test(cmd) || classifyDeclaredCommand(cmd, loadDeclaredVerify(deps.cwd))) {
          const testStatus = harnessResult.isError ? 'failed' : 'passed'
          // Parse test counts from bash output so deliver_task shows real numbers
          // instead of always "0 pass 0 fail". Supports node:test format
          // ("ℹ pass N" / "ℹ fail N") and common TAP/jest patterns.
          const output = typeof harnessResult.content === 'string' ? harnessResult.content : ''
          const passedMatch = output.match(/ℹ\s+pass\s+(\d+)|✅\s+(\d+)\s+passed|Tests?\s+(\d+)\s+passed/i)
          const failedMatch = output.match(/ℹ\s+fail\s+(\d+)|❌\s+(\d+)\s+failed|Tests?\s+(\d+)\s+failed/i)
          const skippedMatch = output.match(/ℹ\s+skip\s+(\d+)/i)
          const passed = passedMatch ? Number.parseInt(passedMatch[1] ?? passedMatch[2] ?? passedMatch[3] ?? '0', 10) : 0
          const failed = failedMatch ? Number.parseInt(failedMatch[1] ?? failedMatch[2] ?? failedMatch[3] ?? '0', 10) : 0
          const skipped = skippedMatch ? Number.parseInt(skippedMatch[1] ?? '0', 10) : 0
          // A2: bash commands matching a declared verify command get structured
          // semantics (kind + declared flag) instead of regex-only guesses.
          const declaredKind = classifyDeclaredCommand(cmd, loadDeclaredVerify(deps.cwd))
          deps.taskLedger.record({
            type: 'verification',
            command: cmd.slice(0, 200),
            status: testStatus,
            meta: { scope: 'full', passed, failed, skipped, ...(declaredKind ? { declared: true, kind: declaredKind } : {}) },
          })
          // bash 跑测试/typecheck/lint 也归零 TDD 门禁——否则 agent 用 bash npm test
          // 而非 run_tests 工具时门禁计数器永远不重置，第 4 次编辑必误报拦截。
          deps.evidence.trackVerification({
            command: cmd.slice(0, 200),
            status: testStatus === 'passed' ? 'passed' : 'failed',
            scope: 'full',
            exitCode: harnessResult.isError ? 1 : 0, passed, failed, skipped, durationMs: 0,
          })
          deps.destructiveGate?.noteVerification(testStatus === 'passed' ? 'passed' : 'failed')
       } else {
          deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, meta: { command: cmd.slice(0, 200) } })
       }
     } else if (tu.name === 'run_tests') {
        const filter = typeof tu.input.filter === 'string' ? tu.input.filter : undefined
        const command = filter ? `run_tests ${filter}` : 'run_tests'
        const verification = rawToolResult?.verification
        const buildMeta = (v?: VerificationMetadata): Record<string, unknown> => {
          const m: Record<string, unknown> = { scope: v?.scope ?? (filter ? 'targeted' : 'full') }
          if (v) {
            m.exitCode = v.exitCode
            m.passed = v.passed
            m.failed = v.failed
            m.skipped = v.skipped
            m.durationMs = v.durationMs
            m.resolvedCommand = v.command
            m.recommendedCommand = v.command
            if (v.failureKind) m.failureKind = v.failureKind
            if (v.targetFiles) m.targetFiles = v.targetFiles
            // VSW: carry snapshot identity + phase so the gate can apply
            // staleness supersession and integration_conflict attribution.
            if (v.snapshotRef) m.snapshotRef = v.snapshotRef
            if (v.verificationPhase) m.verificationPhase = v.verificationPhase
          }
          return m
        }
        deps.taskLedger.record({ type: 'verification', command, status: harnessResult.isError ? 'failed' : 'passed', meta: buildMeta(verification) })
        // VSW two-phase: record the integration (Phase B) verification too so a
        // Phase B failure surfaces as a non-blocking integration_conflict.
        for (const extra of rawToolResult?.extraVerifications ?? []) {
          deps.taskLedger.record({ type: 'verification', command, status: extra.status, meta: buildMeta(extra) })
        }
     } else if (tu.name === 'deliver_task' && tu.input.commit === true && !harnessResult.isError) {
        // Successful scoped commit changed git state — invalidate the frozen
        // git-status snapshot so the next appendix rebuild shows the post-commit
        // reality. Without this the model sees stale "modified" files and
        // re-attempts the commit (cache-log 6c9b3bd6 root cause).
        deps.config.promptEngine.markGitDirty()
        deps.taskLedger.record({ type: 'git_action', tool: tu.name, meta: { command: 'deliver_task commit' } })
     } else {
        deps.taskLedger.record({ type: 'tool_exec', tool: tu.name, path: filePath })
     }
   }

    // GhostRegistry: track read_section as artifact access
    if (tu.name === 'read_section' && !harnessResult.isError) {
      const accessedId = tu.input.artifactId as string | undefined
      if (accessedId) deps.artifactIdsAccessed?.push(accessedId)
   }

    // Claim extraction + conflict detection
    if (deps.config.contextClaimStore && deps.sessionId) {
      const existingPaths = new Set(
        deps.config.contextClaimStore.listClaims({ kind: ['file_observation'] })
          .flatMap(c => c.evidence.filter(e => e.path).map(e => e.path!)),
      )
      const proposals = extractClaimsFromToolResult(
        { toolName: tu.name, input: tu.input as Record<string, unknown>, result: harnessResult.content, isError: harnessResult.isError },
        { sessionId: deps.sessionId, turn: deps.sessionTurnCount, eventId: `turn-${deps.sessionTurnCount}:${tu.name}:${tu.id}` },
        existingPaths,
      )
      let projectMemoryDirty = false
      for (const proposal of proposals) {
        const claim = deps.config.contextClaimStore.propose(proposal)
        // Auto-write project-scoped claims to .rivet/knowledge/memory.jsonl
        // so they survive across sessions and auto-inject into every prompt.
        if (proposal.scope === 'project') {
          appendProjectMemory(deps.cwd, claim)
          projectMemoryDirty = true
       }
     }
      // Compact once after the batch, not per-claim.
      if (projectMemoryDirty) compactProjectMemory(deps.cwd)
      if (proposals.some(p => p.kind === 'file_observation')) {
        const allClaims = deps.config.contextClaimStore.listClaims()
        if (allClaims.length !== lastConflictCheckCount) {
          lastConflictCheckCount = allClaims.length
          const conflicts = detectConflicts(allClaims)
          for (const conflict of conflicts) {
            deps.config.contextClaimStore.updateClaimStatus(
              conflict.olderClaimId, 'conflicted',
              `superseded by ${conflict.newerClaimId} on ${conflict.sharedPath}`,
            )
         }
       }
     }
   }

    // Repair hint + antibody
    if (!harnessResult.isError) {
      deps.repairHintTracker.recordSuccess(tu.name)
   } else {
      const failureClass = classifyToolFailure(rawToolResult, harnessResult.content)
      deps.repairHintTracker.recordFailure(tu.name, failureClass.class)
      if (deps.config.contextClaimStore && deps.sessionId && failureClass.class !== 'unknown') {
        const proposal = createAntibodyProposal(failureClass, {
          toolName: tu.name,
          command: typeof tu.input.command === 'string' ? tu.input.command : undefined,
          sessionId: deps.sessionId,
          turn: deps.sessionTurnCount,
          eventId: `turn-${deps.sessionTurnCount}:${tu.name}:${tu.id}`,
       })
        deps.config.contextClaimStore.propose(proposal)
     }
   }

    // Activity status: notify TUI when tool is blocked by critical failure
    if (harnessResult.isError && callbacks.onPhaseChange) {
      const failureClass = classifyToolFailure(rawToolResult, harnessResult.content)
      if (BLOCKED_CLASSES.has(failureClass.class)) {
        callbacks.onPhaseChange('blocked', {
          tool: tu.name,
          reason: failureClass.class,
          suggestion: failureClass.suggestion,
       })
     }
   }

    // Prewarm invalidation after writes
    if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError && typeof tu.input.file_path === 'string') {
      try {
        deps.prewarm.invalidate(validatePath(deps.cwd, tu.input.file_path as string))
     } catch {
        deps.prewarm.invalidate(tu.input.file_path as string)
     }
      // ShadowQueue 投机预读队列失效（P4 解封配套）：队列不像 PrewarmCache
      // 按文件路径索引，没有对应单个 key 的失效方式（grep/glob/list_dir 的
      // target 常是目录，不是被改的那个文件）——整队清空是这个数据结构下
      // 唯一安全的等价物。checkHit 自带 mtime/size/TTL 校验兜底，这里是额外
      // 的一层尽早失效，不是唯一防线。
      deps.p3?.queue.clear()
   }

    // Prewarm grep-matched files: grep→read_file is the most common tool sequence.
    // After grep succeeds, prewarm up to 5 matched file paths so the next
    // read_file hits the PrewarmCache instead of doing a cold fs read.
    if (tu.name === 'grep' && !harnessResult.isError) {
      const matchedFiles = extractGrepMatchPaths(finalContent, deps.cwd)
      if (matchedFiles.length > 0) {
        void batchPrewarm(deps.cwd, matchedFiles, deps.prewarm).catch(() => {})
        // Obligation probe 归账：grep 命中的文件是存在性证据（cross_check 阶段
        // 的独立工具来源之一）。截断输出视为有损——不能关闭"不存在"断言。
        if (deps.obligations) {
          const grepLossy = finalContent.includes('[truncated') || finalContent.includes('results truncated')
          for (const matched of matchedFiles) {
            deps.obligations.applyProbe({ tool: 'grep', target: matched, lossy: grepLossy })
          }
        }
      }
    }

    touchActivity(activityKey, `tool:${tu.name}:post:impact`)
    // Evidence tracking + import graph
    if (tu.name === 'read_file' && !harnessResult.isError) {
      deps.evidence.trackFileRead(tu.input.file_path as string)

      // compaction_fail signal: read_file returns pruned/diet content
      const hasPruned = finalContent.includes('[pruned]') || finalContent.includes('[diet:redundant]')
      // Obligation probe 归账：无损读取关闭 read_source 阶段义务；
      // pruned/diet 内容是有损观察，只积累升级压力。
      deps.obligations?.applyProbe({
        tool: 'read_file',
        target: tu.input.file_path as string,
        lossy: hasPruned,
      })
      if (hasPruned) {
        try {
          deps.immuneHook?.injectSignal({
            kind: 'compaction_fail',
            severity: 0.6,
            turn,
            source: 'tool-pipeline',
            context: `read_file returned pruned content for ${tu.input.file_path}`,
         })
       } catch { /* non-critical: signal injection is best-effort */ }
     }
   } else if ((tu.name === 'write_file' || tu.name === 'edit_file' || tu.name === 'hash_edit') && !harnessResult.isError) {
      deps.evidence.trackFileModified(tu.input.file_path as string)
      deps.config.promptEngine.markGitDirty()
      deps.config.contextClaimStore?.markClaimsStaleForFile(
        tu.input.file_path as string,
        `file modified by ${tu.name}`,
      )
      // Prefer meridian graph (persisted SQLite reverse BFS) over in-memory import-graph.
      // 绝对路径死角修复（issue #61 族）：写工具按工具文档恒传绝对路径——
      // `db && !isAbsolute(filePath)` 旧判据让快路径在 Windows 恒不走、每次 run
      // 首个写工具全量同步扫仓（import-graph，数千次同步 syscall 冻结事件循环）。
      // 先相对化再判；出界路径（relative 以 .. 开头）才落回内存图。
      const filePath = tu.input.file_path as string
      const db = deps.meridianIndexer?.getDb()
      const relFilePath = isAbsolute(filePath) ? relative(deps.cwd, filePath) : filePath
      // P1-2：冷库（新 clone 首启索引为空）时 db 为真值但无数据——analyzeImpact 恒返回
      // 空集且不落回 importGraph，impact hint 静默变空（9a9bbf49b 提交信息「importGraph
      // 留作兜底」仅对 indexer=null/路径出界成立）。加 hasFiles() 空库探测：库空时与
      // indexer=null 同路落回 importGraph；索引非空但无 impact 才是真无影响，不兜底
      // （避免每写工具全量扫仓——issue #61 已修路径）。
      if (db && db.hasFiles() && !relFilePath.startsWith('..') && !isAbsolute(relFilePath)) {
        const impactT0 = Date.now()
        const impact = analyzeImpact(db, [relFilePath])
        warnSlowSyncStage(tu.name, 'meridian-impact', Date.now() - impactT0)
        if (impact.direct.length > 0 || impact.tests.length > 0) {
          deps.evidence.trackImpact(impact.direct, impact.tests)
        }
      } else {
        if (!importGraph) {
          try {
            const graphT0 = Date.now()
            importGraph = buildImportGraph(deps.cwd)
            warnSlowSyncStage(tu.name, 'import-graph', Date.now() - graphT0)
          } catch {
            // Best-effort impact analysis — must never produce tool errors.
            // collectTsFiles already catches per-dir errors; this is a belt
            // for any remaining fs failure (e.g. root cwd itself unreadable).
          }
        }
        if (importGraph) {
          importGraph = invalidateFile(importGraph, deps.cwd, filePath)
          const hint = generateImpactHint(importGraph, filePath, deps.cwd)
          if (hint) {
            deps.evidence.trackImpact(hint.impactedFiles, hint.relatedTests)
          }
        }
      }
   } else if (tu.name === 'run_tests' && rawToolResult) {
      // Reconnect EvidenceTracker verification pipeline.
      // run_tests returns VerificationMetadata, but this was never fed into
      // EvidenceTracker — leaving deliveryStatus stuck at 'unverified' and
      // buildDeliveryGate.canClaimComplete always false.
      if (rawToolResult.verification) {
        deps.evidence.trackVerification(rawToolResult.verification)
        deps.destructiveGate?.noteVerification(rawToolResult.verification.status)
     }

      if (rawToolResult.verification && rawToolResult.verification.status !== 'passed') {
        const failures = classifyTestRun(harnessResult.content)
        if (failures.length > 0 && failures[0]!.confidence >= 0.7) {
          const failureClass = classifyToolFailure(rawToolResult, harnessResult.content)
          deps.repairHintTracker.recordFailure(tu.name, failureClass.class)
          let diagnosedContent = `${finalContent}\n\nDiagnosis: ${failures[0]!.suggestion}`
          if (!harnessResult.isError) {
            diagnosedContent = truncateSuccessfulToolResult(diagnosedContent, deps.config)
         }
          const diagThreshold = deps.cacheAdvisor?.getArtifactThreshold(deps.phaseHint ?? 'execute', harnessResult.isError)
          const diagBudgetFrac = deps.turnBudget.maxTokensPerTurn > 0
            ? 1 - (deps.turnBudget.usedTokens / deps.turnBudget.maxTokensPerTurn)
            : 1
          diagnosedContent = await artifactIntercept(diagnosedContent, tu.name, tu.input, deps.artifactStore, harnessResult.isError, diagThreshold, diagBudgetFrac, deps.config.contextWindow)
          const diagEvictedId = extractArtifactId(diagnosedContent)
          if (diagEvictedId) deps.artifactIdsEvicted?.push(diagEvictedId)
          return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? diagnosedContent + starSig : diagnosedContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk, errorKind: harnessResult.isError ? resolveErrorKind(rawToolResult) : undefined }
       }
     }
   }

    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? finalContent + starSig : finalContent, is_error: harnessResult.isError }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk, endTurn: rawToolResult?.endTurn === true ? true : undefined, images: rawToolResult?.images, errorKind: harnessResult.isError ? resolveErrorKind(rawToolResult) : undefined }
 } catch (err) {
    // AbortError: user cancelled — not a tool failure.
    // Skip failure recording so immune/doom-loop signals aren't polluted.
    if ((err as Error).name === 'AbortError') {
      // NEVER return empty content: a silent '' success made the model fly
      // blind on its most critical deliveries (session 803d897d: two
      // deliver_task results came back empty after user steering aborted the
      // batch, while the detached execute kept running and landed commits).
      // The model must know (a) the call was interrupted and (b) the work may
      // still have completed in the background.
      let abortedNote = `[interrupted] ${tu.name} was cancelled before its result could be returned. The underlying operation may still have completed in the background — verify actual state (e.g. git log, file contents, test output) before assuming it failed or retrying.`
      // deliver_task: resolve the ambiguity on the spot (session 50073c39 —
      // the commit HAD landed but the note said "may have"; the model then
      // spent a turn re-verifying and the user saw a done task wake up).
      if (tu.name === 'deliver_task' && preAbortHead) {
        const headNow = await gitHeadQuiet(deps.cwd)
        if (headNow && headNow !== preAbortHead) {
          const summary = await gitHeadSummaryQuiet(deps.cwd)
          abortedNote = `[interrupted] deliver_task was cancelled mid-flight, BUT its commit already landed: ${summary ?? headNow.slice(0, 8)}. The delivery succeeded — only the result report was cut off. Do NOT re-commit or retry; treat the task as delivered and report it as such.`
        } else if (headNow) {
          abortedNote = `[interrupted] deliver_task was cancelled before its result could be returned. As of cancellation no new commit has landed (HEAD unchanged at ${headNow.slice(0, 8)}), but the underlying operation may still complete in the background — check git log before retrying to avoid a duplicate commit.`
        }
      }
      callbacks.onToolResult(tu.id, tu.name, abortedNote, false)
      return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: abortedNote, is_error: false }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk }
   }
    let msg = err instanceof Error ? err.message : String(err)
    // deliver_task timeout/crash attribution (240s 事故链 2026-07-07): the
    // pipeline timeout used to replace the ENTIRE tool result with an error,
    // swallowing the fact that the commit had already landed — the model then
    // re-committed or switched to raw git commit. Same resolution as the
    // abort path above: check HEAD and state the outcome definitively.
    if (tu.name === 'deliver_task' && preAbortHead) {
      const headNow = await gitHeadQuiet(deps.cwd)
      if (headNow && headNow !== preAbortHead) {
        const summary = await gitHeadSummaryQuiet(deps.cwd)
        msg += `\n\n⚠️ BUT the commit already landed before this error: ${summary ?? headNow.slice(0, 8)}. The delivery succeeded — only the result report was lost. Do NOT re-commit or retry; verify with git log and treat the task as delivered.`
      } else if (headNow) {
        msg += `\n\nNo new commit landed (HEAD unchanged at ${headNow.slice(0, 8)}). Check git log before retrying to avoid a duplicate commit.`
      }
    }
    const caughtFailureClass = classifyFailure(msg).class
    deps.repairHintTracker.recordFailure(tu.name, caughtFailureClass)
    // Obligation 失败归账：target 关联义务记一次失败尝试（同类失败重复 → 升级阶梯）。
    deps.obligations?.recordFailureSignal(
      caughtFailureClass,
      typeof tu.input?.file_path === 'string' ? tu.input.file_path as string : toolTargetFromInput(tu.name, tu.input),
    )
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: starSig ? msg + starSig : msg, is_error: true }, traceStore, importGraph, lastConflictCheckCount, checkpointCreated, latestRisk, errorKind: caughtFailureClass }
  }
}

/**
 * Extract unique file paths from grep output.
 * Grep output format: `relative/path.ts:42:  const x = 1`
 * We extract just the file path portion (before the first colon on each line).
 */
function extractGrepMatchPaths(grepOutput: string, cwd: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  const MAX_FILES = 5

  for (const line of grepOutput.split('\n')) {
    if (paths.length >= MAX_FILES) break
    // Match lines like "src/foo.ts:42:  content" or "src/foo.ts:content"
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue
    const filePath = line.slice(0, colonIdx)
    // Skip if it looks like a non-path (e.g. artifact markers, section headers)
    if (filePath.startsWith('[') || filePath.startsWith('Use ') || filePath.startsWith('...')) continue
    if (!seen.has(filePath)) {
      seen.add(filePath)
      paths.push(filePath)
    }
  }

  return paths
}

