/**
 * deliver_task — 语义化交付工具 (B1-8)
 *
 * 从低层 git commit 升级到语义化工程交付原语。
 *
 * 行为：
 * - 读取 TaskLedger + OwnershipLedger + DeliveryGate v2
 * - 如果 RED（owned failures / unverified），拒绝交付
 * - 如果 YELLOW（external blockers），说明但不阻塞
 * - 如果 GREEN，输出结构化交付报告
 *
 * 默认只输出交付门报告。
 * 当 commit=true 且 approval 通过时，会执行 ownership-scoped commit。
 *
 * HEARTH 兼容：交付报告可沉积为 cycle_close 的 durable evidence。
 * Songline 兼容：交付状态是 obligation fulfillment 信号，可沉积 pheromone。
 *
 * @module deliver-task
 * @task B1-8
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { spawnGitSync } from '../tools/spawn-git.js'
import { parseVerifyCommand, spawnVerifyArgv } from './verify-command.js'
import { join, isAbsolute } from 'node:path'
import type { Tool, ToolCallParams, ToolResult, DelegationActivity } from '../tools/types.js'
import { createDelegationActivityMapper } from '../tools/worker-activity-stream.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import { debugLog } from '../utils/debug.js'

/**
 * 阶段时间戳标记（commit 卡死诊断插桩，主控可靠性闭环 2026-08-06）。
 * 返回 (stage) => void：记录「execute 开始以来的相对毫秒」到 debug 通道
 * （RIVET_DEBUG=1 才输出，生产零开销）。下次 deliver_task commit=true 卡死时，
 * 日志里最后一个 stage 就是卡点：在 execute 内（缺 execute:return）或
 * execute 已返回但工具未完成（全标记齐全 = harness 结果回传层卡死）。
 */
export function createStageMarker(prefix: string): (stage: string) => void {
  const t0 = Date.now()
  return (stage: string): void => {
    debugLog(`[${prefix}] ${stage} +${Date.now() - t0}ms`)
  }
}

/** 义务账 gate 的默认异步执行器（2026-08-09 楔子清理）：60s 超时不阻塞事件循环，
 *  摘要尾部 3 行 / 300 字符。H4 收口：gate 命令源是议事会席位输出，先过
 *  parseVerifyCommand，解析失败按不可执行收口，绝不退回字符串拼 shell。 */
function runGateAsync(command: string, cwd: string): Promise<{ ok: boolean; detail?: string }> {
  const argv = parseVerifyCommand(command)
  if (!argv) return Promise.resolve({ ok: false, detail: '非白名单 gate 命令形状——拒绝 shell 执行' })
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const tail = (): string => `${stdout}\n${stderr}`.trim().split('\n').slice(-3).join('\n').slice(0, 300)
    const settle = (r: { ok: boolean; detail?: string }): void => {
      if (!settled) { settled = true; resolvePromise(r) }
    }
    try {
      const child = spawnVerifyArgv(cwd, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        settle({ ok: false, detail: tail() })
      }, 60_000)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) settle({ ok: true })
        else settle({ ok: false, detail: tail() })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        settle({ ok: false, detail: err.message })
      })
    } catch (err) {
      settle({ ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  })
}
import type { DeliveryGateV2 } from './delivery-gate-v2.js'
import { filterExternalNoise } from './delivery-gate-v2.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import { classifyChange, createGitDiffProvider, isMechanicalFastPathEnabled } from './change-classification.js'
import { commitScopedFiles, type ScopedCommitResult } from './scoped-git-commit.js'
import { buildReviewPrincipleChecklist } from './review-principle-checklist.js'
import { checkCommitCohesion } from './commit-cohesion.js'
import { isCrossModule, isFixContext, shouldRouteReviewWorkflow, GENERAL_DEV_DISCIPLINES, LARGE_FILE_WARN_THRESHOLD, type ChangeSet, type ReviewScale } from './review-discipline.js'
import { routeReviewWorkflow, reviewWorkflowBudgetMs, type ReviewRouterDeps, type ReviewOutcome, type ReviewMode } from './review-router.js'
import { isReviewDisciplineEnabled } from '../config/review-discipline-config.js'
import type { ReviewConfig } from '../config/schema.js'
import { recordAutoReviewRun } from './review-health.js'
import { detectWroteButNeverRead, formatWroteButNeverRead, detectReadButNeverProduced, formatReadButNeverProduced } from './wiring-nudge.js'
import { readUnacknowledged, acknowledgeAll, type RecoveryEntry } from './recovery-journal.js'
import { analyzeImpact } from '../repo/meridian-impact.js'
import { evaluateTestPresence, testPresenceGateEnabled } from './test-presence.js'
import { auditDeliveryClaims, claimAuditEnabled } from './claim-audit.js'
import { scanFilesForProbes, formatProbeHits, type ProbeHit } from './probe-detector.js'
import { checkStructureGate } from './structure-gate.js'
import { findApprovedPlanInventory, verifyRegressionInventory, formatInventoryReport, type InventorySearcher } from './regression-inventory.js'
import { verifyObligations, formatObligationReport, type GateRunner, type PlanWithObligations } from './council/council-obligations.js'
import { declaredVerificationCommands, reconcileVerificationCommands, formatVerificationReconcileReport } from './verification-reconcile.js'
import { getStoredPlan } from './plan-store.js'
import { deserializeUnifiedPlan } from './unified-plan.js'
import { enqueuePostCommitReviewOutcome } from './post-commit-review-queue.js'
import { addPendingReviewFiles, consumePendingReview, __resetPostCommitReviewPending } from './post-commit-review-pending.js'
import { isUiFilePath, isVisualVerifyTool } from './hooks/render-verify-hook.js'
import { findUnverifiedClaimRefs } from './hooks/external-claim-tracking-hook.js'
import { isScoutFirewallEnabled } from '../config/scout-firewall-config.js'
import { appendMemoryEntry, countSimilarMemoryEntries } from '../memory/unified-memory.js'

export interface B1Context {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  gate: DeliveryGateV2
  /** Optional SessionRegistry for cross-session claim conflict detection */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current session ID for claim management */
  sessionId?: string
  /** Test hook / alternate runtime source for current dirty files. */
  getCurrentDirtyFiles?: (cwd: string) => string[] | undefined
  /** Test hook / alternate runtime source for project memory markdown. */
  getProjectMemoryContent?: (cwd: string) => string | undefined
  /** Test hook / alternate runtime executor for scoped commits. */
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => ScopedCommitResult
  /** Review router entry point. Defaults to routeReviewWorkflow when reviewDeps is provided. */
  routeReviewWorkflow?: typeof routeReviewWorkflow
  /** Dependencies used by the review router to spawn verifier/patcher/squadron workers. */
  reviewDeps?: ReviewRouterDeps
  /** Re-entrancy guard: child review contexts must not recursively trigger review routing. */
  reviewDepth?: number
  /** Task dependency depth — upgrades review scale for wiring/system tasks.
   *  Accept a getter so the value is resolved at review-time, not context-creation time. */
  getDepthLayer?: () => import('../context/task-contract.js').TaskDepthLayer | undefined
  /** Test hook for the wrote-but-never-read static check. */
  detectWroteButNeverRead?: typeof detectWroteButNeverRead
  /** Test hook for the read-but-never-produced (虚假绿灯) static check. */
  detectReadButNeverProduced?: typeof detectReadButNeverProduced
  /** VSW: current active snapshotRef. When provided, the gate drops verifications
   *  whose snapshotRef is stale (owned diff changed since they ran). Absent →
   *  no supersession (unchanged default). */
  getCurrentSnapshotRef?: () => string | undefined
  /** True when a goal tracker is actively driving auto-continuation.
   *  When active, post-commit auto-review is suppressed (L1 nudge-only)
   *  to prevent child review workers from stalling the goal loop. */
  isGoalActive?: () => boolean
  /** True when the goal tracker deactivated with reason='achieved'.
   *  Signals deliver_task to auto-upgrade the final commit review to L3. */
  isGoalAchieved?: () => boolean
  /** Last goal judge verdict stored on the tracker, for surfacing in the
   *  delivery report. Null when the judge hasn't run (e.g. judge disabled
   *  or goal completed before the judge had a chance to run). */
  getLastVerdict?: () => import('./goal-tracker.js').StoredGoalJudgeVerdict | null
  /** Review configuration snapshot (subset of agent.review). Used for per-config
   *  gating of auto review (review.skipAuto) without re-reading the full Config.
   *  Optional: absent → no-skip (preserves current behavior). */
  reviewConfig?: ReviewConfig
  /** 会话级运行时开关（TUI `/review off` 写入）：true 时抑制系统自动审查。
   *  显式 review_level（手动 /review）是用户明确意图，不受此开关影响。 */
  isAutoReviewOff?: () => boolean
  /** Meridian indexer — when available, blast radius is injected into review
   *  focusHint so verifier/inspector know which downstream consumers to check. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
  /** Injectable typecheck runner for the review-gate backstop. Absent → the
   *  real `tsc --noEmit` is used (covers worker/headless). Tests pass a mock. */
  typecheckRunner?: import('./typecheck-gate.js').TypecheckRunner
  /** Injectable runner for the non-TS declared verify.typecheck/build backstop
   *  (A2). Absent → the real bash spawn is used. Tests pass a mock. */
  declaredCheckRunner?: import('./typecheck-gate.js').DeclaredCommandRunner
  /** Injectable probe scanner for the probe-residue gate. Absent → the real
   *  scanFilesForProbes with readFileSync is used. Tests pass a mock. */
  scanProbes?: (files: string[], cwd: string) => import('./probe-detector.js').ProbeHit[]
  /** Injectable structure-ratchet checker for the advisory structure gate
   *  (行数棘轮预警). Absent → the real checkStructureGate (fs reads) is used.
   *  Tests pass a mock. */
  checkStructure?: typeof checkStructureGate
  /** 层3 重构回归契约：当前主控任务契约 getter。契约带 regressionInventory
   *  时交付前逐项核验；缺失时回退到最近 APPROVED 计划的「回归清单」章节。 */
  getTaskContract?: () => import('../context/task-contract.js').TaskContract | undefined
  /** 层3 测试钩子：注入清单锚点搜索器（默认 git grep -F）。 */
  inventorySearcher?: InventorySearcher
  /** Norns 义务账：advisory_gate 白名单命令执行器（默认 sh -c，60s 超时）。
   *  测试注入 mock 免真实 spawn。 */
  obligationGateRunner?: GateRunner
  /** 星河收编 #2：运行时证据义务 store 入口。提供时，声明了 redundancy 的
   *  义务未达 k 个独立证据会阻断交付（不静默降级为 satisfied）。缺省 →
   *  冗余门禁关闭（现状行为不变）。 */
  getObligationStore?: () => import('./evidence-obligation.js').ObligationStore
  /** 证据防火墙 Phase 2：external-claim tracker 入口。提供且防火墙开启时，
   *  commit 引用未核验 scout 断言会被拦截。缺省 → 门禁关闭（现状行为不变）。 */
  getClaimTracker?: () => import('./hooks/external-claim-tracking-hook.js').ClaimTracker | undefined
  /** config agent.scoutEvidenceFirewall 值（env RIVET_SCOUT_FIREWALL 优先，
   *  判定走 isScoutFirewallEnabled）。 */
  scoutFirewallConfig?: boolean
  /** W1 回归防线: Meridian blast-radius tests (EvidenceTracker.impactedTests).
   *  Absent → coverage check disabled (unchanged behavior). */
  getImpactedTests?: () => string[]
  /** P4 收束闸：PAL 收敛案件快照（bootstrap 闭包现读 store）。收敛假设的
   *  targets 完全没进本次交付范围 → 弱 advisory 提示，绝不阻断。 */
  getPalConvergedCases?: () => import('./problem-attack-loop.js').ConvergedCaseEntry[]
  /** 遗产回收 W-A1：PAL needs_user 案件快照（minimalQuestion 由 store 预计算）。
   *  交付时卡在等用户裁决的案件必须披露为遗留项 → 弱 advisory，绝不阻断。 */
  getPalNeedsUserCases?: () => Array<{ caseId: string; problem: string; minimalQuestion: string }>
  /** config.agent.delivery.autoCommit。false 时即使 commit=true 也不实际
   *  执行 git commit，仅输出交付报告。 */
  autoCommit?: boolean
}

// ── Post-commit review batching ──
// When multiple deliver_task commits fire in quick succession (e.g. splitting
// a large changeset into area-scoped commits), each would trigger a separate
// review worker — wasteful when one review can cover the whole session's work.
// Two layers of batching:
// 1. Cooldown: after a review launches, skip subsequent launches within this
//    window — but RECORD the commit scope into post-commit-review-pending so
//    the next launched review covers it (previously it went unreviewed).
// 2. In-flight singleton: at most one system-triggered review worker at a
//    time. Commits arriving while one runs (e.g. a git-lock retry landing
//    40s later, inside the 180s review budget) merge into the pending scope
//    instead of spawning an overlapping worker; the in-flight review's
//    completion chains ONE follow-up review over the accumulated scope.
const POST_COMMIT_REVIEW_COOLDOWN_MS = 30_000
let lastPostCommitReviewAt = 0
let postCommitReviewInFlight = false

/** Test-only: reset the module-level batching state (cooldown, in-flight
 *  flag, pending scope) so it does not leak across cases. */
export function resetPostCommitReviewCooldown(): void {
  lastPostCommitReviewAt = 0
  postCommitReviewInFlight = false
  __resetPostCommitReviewPending()
}

/** Test-only: expire ONLY the time cooldown, keeping the in-flight flag and
 *  pending scope — needed to exercise the in-flight merge branch (a commit
 *  landing >30s after a still-running review launched). */
export function __expirePostCommitReviewCooldown(): void {
  lastPostCommitReviewAt = 0
}

/** Format a review outcome into report lines. Shared by the synchronous path
 *  (explicit review_level → lines go into the tool result) and the detached
 *  path (system-triggered review → lines flow through the advisory queue). */
export function formatReviewOutcomeLines(outcome: ReviewOutcome): string[] {
  const lines: string[] = []
  if (outcome.verdict === 'rejected' || outcome.escalated) {
    // Advisory: the commit has already landed. Surface the finding
    // as a strong warning + follow-up recommendation, not a block.
    lines.push(`⚠️ 审查门发现问题 (${outcome.tier})：${outcome.evidence ?? '对抗性审查未验证此交付'}`)
    if (typeof outcome.rounds === 'number') lines.push(`   轮次：${outcome.rounds}`)
    lines.push('   → 提交已落地。请在后续提交中处理审查发现。')
    lines.push('   ⚠ 以上审查意见来自 worker，未经主控独立核验。汇报用户前请用 grep/read 确认每条声称的文件:行号真实存在。')
  } else if (outcome.verdict === 'verified') {
    if (outcome.infraFailures && outcome.infraFailures.length > 0) {
      lines.push(`⚠️ 审查门 YELLOW (${outcome.tier})：审查基础设施有注意事项，交付已通过可用证据验证。`)
      lines.push(`   ${outcome.evidence ?? '已通过审查基础设施注意事项验证'}`)
    } else {
      lines.push(`✅ 审查通过 (${outcome.tier})：${outcome.evidence ?? '已验证'}`)
    }
  } else if (outcome.verdict === 'inconclusive') {
    lines.push(`⚠️ 审查未决 (${outcome.tier})：${outcome.evidence ?? '提交后审查未运行（基础设施故障）'}`)
    lines.push('   → 此变更未经审查。运行 /review max 进行完整编队审查。')
  } else if (outcome.verdict === 'nudge') {
    lines.push(`⚠️ 审查提醒 (${outcome.tier})：请在后续工作中应用审查纪律。`)
    lines.push('通用开发方法论：')
    for (const directive of GENERAL_DEV_DISCIPLINES) lines.push(`  - ${directive}`)
  }
  return lines
}

function parseNulFileList(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

function readProjectMemory(cwd: string): string | undefined {
  try { return readFileSync(join(cwd, '.rivet', 'knowledge', 'project-memory.md'), 'utf-8') } catch { return undefined }
}

/** Collect files exceeding the large-file threshold so review workers can avoid
 *  reading them in full (use offset/limit instead). Best-effort — stat failures
 *  are silently skipped. */
function collectLargeFiles(cwd: string, filePaths: readonly string[]): Array<{ path: string; sizeBytes: number }> | undefined {
  const large: Array<{ path: string; sizeBytes: number }> = []
  for (const p of filePaths) {
    try {
      const st = statSync(join(cwd, p))
      if (st.size >= LARGE_FILE_WARN_THRESHOLD) {
        large.push({ path: p, sizeBytes: st.size })
      }
    } catch { /* best-effort: missing / broken symlink / permission denied → skip */ }
  }
  return large.length > 0 ? large : undefined
}

function gitNameList(cwd: string, args: string[]): string[] | null {
  const result = spawnGitSync(['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (result.status !== 0) return null
  return parseNulFileList(result.stdout)
}

/**
 * Detect a "symptom-patch": a tiny single-file change touching only fallback
 * operators (`??` `||` default values). These are the shape of the trained-mode
 * reflex — patch the last hop, not the root. Returns a stance hint, or null.
 */
export function detectSymptomPatch(cwd: string): string | null {
  const res = spawnGitSync(['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (res.status !== 0) return null
  const rows = res.stdout.split(/\r?\n/).filter(Boolean)
    .map(l => l.split('\t'))
    .filter(c => c.length === 3 && !(c[2] ?? '').includes('test'))
  if (rows.length !== 1) return null
  const row = rows[0]!
  const added = Number(row[0]) || 0
  if (added > 2) return null
  const patch = spawnGitSync(['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', row[2]!], { cwd, encoding: 'utf-8', timeout: 5000 })
  if (patch.status !== 0) return null
  const addedLines = patch.stdout.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++'))
  const fallbackOnly = addedLines.length > 0 && addedLines.every(l => /\?\?|\|\||=\s*['"`]?\w*['"`]?\s*$|fallback|default/.test(l))
  if (!fallbackOnly) return null
  return '⚖️  这是症状处的 fallback 补丁(单行、改默认值)。是源头修复还是就近打补丁？数据流追到源头了吗？(清醒锚点，不阻塞)'
}

export function collectCurrentDirtyFiles(cwd: string): string[] | undefined {
  const unstaged = gitNameList(cwd, ['diff', '--name-only', '-z'])
  const staged = gitNameList(cwd, ['diff', '--cached', '--name-only', '-z'])
  const untracked = gitNameList(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!unstaged || !staged || !untracked) return undefined

  const files = new Set<string>()
  for (const file of [...unstaged, ...staged, ...untracked]) {
    files.add(file)
  }
  return [...files].sort()
}

/**
 * W5 (render-verify): check whether the delivery includes UI file changes
 * without any visual verification action (browser/computer_use/browser_debug).
 * Returns a warning line, or null if no issue.
 */
export function detectMissingVisualVerify(
  ownedFiles: readonly string[],
  getEvents?: () => ReadonlyArray<import('./task-ledger.js').TaskLedgerEvent>,
): string | null {
  const uiFiles = ownedFiles.filter(f => isUiFilePath(f))
  if (uiFiles.length === 0) return null

  const events = getEvents?.() ?? []
  const hasVisualVerify = events.some(
    e => e.type === 'tool_exec' && e.tool && isVisualVerifyTool(e.tool),
  )
  if (hasVisualVerify) return null

  return `⚠️ 渲染未验证：UI 文件已修改（${uiFiles.slice(0, 2).join(', ')}${uiFiles.length > 2 ? ' 等' : ''}），但未见 browser_debug/computer_use 视觉验证。交付前用 browser_debug open → navigate → screenshot 检查渲染结果。`
}

// ── 虚空仓库 P0：learned 参数解析 ──────────────────────────────────────────

export interface LearnedPattern {
  text: string
  evidence: string
  tags: string[]
  topic?: string
}

/** 解析 deliver_task `learned` 数组。约定格式："模式描述——证据：文件路径或复现步骤"。
 *  分隔符容忍 "——证据："/"--证据:" 等变体；缺分隔符时整条入 text、evidence 为空。
 *  topic 从 evidence 里提取第一个带扩展名的路径样 token（供召回结构化预过滤）。 */
export function parseLearnedEntries(raw: unknown): LearnedPattern[] {
  if (!Array.isArray(raw)) return []
  const out: LearnedPattern[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    const sep = trimmed.match(/[—–-]{1,2}\s*证据\s*[:：]/)
    let text = trimmed
    let evidence = ''
    if (sep && sep.index !== undefined) {
      text = trimmed.slice(0, sep.index).trim()
      evidence = trimmed.slice(sep.index + sep[0].length).trim()
    }
    if (!text) continue
    const pathLike = evidence.match(/[\w@./-]+\.[A-Za-z]{1,8}\b/)
    out.push({
      text,
      evidence,
      tags: ['agent-learned'],
      topic: pathLike?.[0],
    })
  }
  return out
}

export function createDeliverTaskTool(getB1Context: (params?: ToolCallParams) => B1Context): Tool {
  return {
    definition: {
      name: 'deliver_task',
      description: `基于 B1 归属与验证台账检查任务交付就绪度。

### 用法
- 用 deliver_task 检查当前任务是否可交付/提交
- 报告 GREEN（就绪）、YELLOW（就绪但附外部注意事项）或 RED（阻塞）
- 包含已归属文件、外部文件与验证状态
- 默认只报告就绪度，不执行提交
- commit=true 时，在审批通过后执行一次归属范围限定的提交

### 参数
- commit: 设为 true 以请求限定范围提交的审批（默认：false）
- message: 提交信息（commit=true 时必填）
- files: 可选，要提交的已归属文件路径数组（子集）。省略时提交全部已归属文件。用此参数把逻辑单元分开提交。
- adopt: 提交前要认领归属的外部或共同归属文件路径数组。用于接管崩溃/冻结会话的工作。要求 commit=true。被认领的文件会强制加入已归属集合，并纳入提交范围。
- force: 设为 true 可在跨多个区域提交大量文件时覆盖内聚性门禁。谨慎使用。
- learned: 本次会话确认的可复用模式数组（每条格式："模式描述——证据：路径或复现步骤"）。持久化到项目知识库，未来会话自动注入。只提交已验证的模式。
- review_policy: 长任务的提交后审查分批。each（默认）每次提交都审查；defer 不审查，把提交累积进会话待审范围；final 对所有累积提交做一次审查。相比大量小提交，优先 defer+final，避免每次提交都消耗一个 review worker。

### 复杂 spec 交付清单
对复杂 spec 或跨模块集成，清单条目要包含：事实流图已验证、条件矩阵已验证、反例测试已验证。`,
      input_schema: {
        type: 'object',
        properties: {
          commit: { type: 'boolean', description: '请求对已归属文件做限定范围的提交' },
          message: { type: 'string', description: '提交信息（commit=true 时必填）' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '可选，要提交的已归属文件子集。省略时提交全部已归属文件。用于把工作拆成独立的逻辑提交。',
          },
          adopt: {
            type: 'array',
            items: { type: 'string' },
            description: '提交前认领进已归属集合的外部文件路径。用于另一会话崩溃后的跨会话接管。要求 commit=true。',
          },
          force: {
            type: 'boolean',
            description: '覆盖内聚性门禁。仅在提交尽管跨多个区域、但确实是一个逻辑单元时使用。',
          },
          checklist: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string' },
                done: { type: 'boolean' },
                files: { type: 'array', items: { type: 'string' } },
              },
              required: ['item', 'done'],
            },
            description: '任务完成度审计条目。对复杂 spec，要包含事实流图已验证、条件矩阵已验证、反例测试已验证/已延期。',
          },
          review_level: {
            type: 'string',
            enum: ['L2', 'L3'],
            description: '显式设置审查工作流深度。L2 = 单个对抗式验证器。L3 = Review Squadron（5 个检查员）。省略时按变更结构自动分级（默认：L1 仅提醒）。用于对高风险或关键路径变更手动触发更深的审查。',
          },
          skipAutoReview: {
            type: 'boolean',
            description: '抑制提交后的自动审查。goal tracker 激活时（目标驱动的自动续跑）自动设置。对琐碎或紧急变更可手动设置以绕过审查。',
          },
          review_policy: {
            type: 'string',
            enum: ['each', 'defer', 'final'],
            description: '长任务的提交后审查分批。each（默认）：每次提交都审查。defer：跳过即时审查，把本次提交累积进会话待审范围。final：对所有累积的延迟提交连同本次做一次审查。设置 review_level 时忽略此参数。',
          },
          learned: {
            type: 'array',
            items: { type: 'string' },
            description: '本次 session 确认的可复用知识（每条格式："模式描述——证据：文件路径或复现步骤"）。只在交付时提交经过验证的模式：诊断方法/架构边界/工具链事实/已验证修复。不确定的不要写。',
          },
        },
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const mark = createStageMarker('deliver-task')
      mark('execute:start')
      const ctx = getB1Context(params)
      const reviewDepth = params.reviewDepth ?? ctx.reviewDepth ?? 0
      ctx.ownership.autoOwnFromLedger()
      const currentDirtyFiles = ctx.getCurrentDirtyFiles?.(params.cwd) ?? collectCurrentDirtyFiles(params.cwd)
      if (currentDirtyFiles) ctx.ownership.autoOwnFromBaseline(currentDirtyFiles)
      // W1 回归防线: feed Meridian blast radius into the gate. existsSync filters
      // deleted/renamed tests (static-analysis false positives) into "uncoverable".
      const impactedTests = ctx.getImpactedTests?.() ?? []
      const moduleCoverage = impactedTests.length > 0
        ? {
            impactedTests,
            testExists: (p: string) => existsSync(isAbsolute(p) ? p : join(params.cwd, p)),
          }
        : undefined
      const report = ctx.gate.getReport([], currentDirtyFiles, ctx.getCurrentSnapshotRef?.(), moduleCoverage)
      mark('report:done')

      // Cap file lists and filter external noise to keep the GREEN/YELLOW signal readable.
      const FILE_LIST_CAP = 5
      const renderFileList = (files: string[], extraHiddenCount = 0): string[] => {
        if (files.length === 0 && extraHiddenCount === 0) return ['  (none)']
        const shown = files.slice(0, FILE_LIST_CAP).map(f => `  ${f}`)
        const hidden = files.length - Math.min(files.length, FILE_LIST_CAP) + extraHiddenCount
        if (hidden > 0) shown.push(`  (+${hidden} more${extraHiddenCount > 0 ? `, ${extraHiddenCount} junk/gitignored` : ''})`)
        return shown
      }
      const externalSplit = filterExternalNoise(report.externalFiles, params.cwd)

      const lines: string[] = [
        `Delivery Gate: ${report.state}`,
        `Task: ${report.taskId}`,
        '',
        `Owned files (${report.ownedFileCount}):`,
        ...renderFileList(report.ownedFiles),
        '',
        `Co-owned files (${report.coOwnedFileCount}):`,
        ...renderFileList(report.coOwnedFiles),
        '',
        `Historical owned files (${report.historicalOwnedFileCount}):`,
        ...renderFileList(report.historicalOwnedFiles),
        '',
        `External files (${report.externalFileCount}):`,
        ...renderFileList(externalSplit.files, externalSplit.noiseCount),
        '',
        report.verificationCount > 0
          ? `Verifications: ${report.verificationCount}`
          : 'Verifications: none (no tests were run for this task)',
      ]

      // 层 1a: echo latest verification totals so agents copy real numbers
      // into delivery reports instead of guessing from memory.
      if (report.latestVerificationTotals) {
        const v = report.latestVerificationTotals
        lines.push(`  Latest: ${v.passed} pass ${v.failed} fail ${v.skipped} skip — ${v.command}`)
      } else if (report.verificationCount === 0) {
        lines.push('  (Typecheck passed, but no test suite was executed. Run tests before claiming "verified".)')
      }

      // 测试存在性警告（advisory 不阻断）：交付物含 ≥3 个源文件却零测试文件。
      // 主会话有人看着，硬拦交给 wave-gate 管无人值守场景。
      if (testPresenceGateEnabled()) {
        const presence = evaluateTestPresence(report.ownedFiles)
        if (!presence.ok) {
          lines.push('', `⚠️ 零测试交付：${presence.detail}`)
          lines.push('  交付报告中不要宣称"已验证"——这批源文件没有任何测试背书。')
        }
      }

      // W5 (render-verify): warn when UI files were changed without visual verification.
      if (ctx.taskLedger && process.env.RIVET_RENDER_VERIFY !== '0') {
        const visualWarn = detectMissingVisualVerify(
          report.ownedFiles,
          () => ctx.taskLedger.getEvents(),
        )
        if (visualWarn) lines.push('', visualWarn)
      }

      const hasVerificationDiagnostics = report.currentBlockingFailure
        || report.supersededFailures > 0
      if (hasVerificationDiagnostics) {
        lines.push('')
        if (report.currentBlockingFailure) {
          lines.push(`  阻断项：${report.currentBlockingFailure}`)
        }
        if (report.staleFailureCandidates > 0) {
          lines.push(`  预存量失败：${report.staleFailureCandidates} 条（改动前已存在，不归本次改动，可 force 交付）`)
        }
        // no_test_infra: project lacks testing infrastructure entirely.
        // Give user-facing guidance rather than generic "run tests" advice.
        if (report.attributionClass === 'no_test_infra') {
          lines.push('', '  ⚠️ 测试基础设施缺失 — 项目没有可自动检测的测试框架或测试文件。')
          lines.push('  run_tests 每次都会以同样原因受阻，继续重试不会改变结果。')
          lines.push('  建议向用户报告：')
          lines.push('    1. 当前项目缺少什么（package.json 中的 test 脚本 / pytest / vitest 等）')
          lines.push('    2. 用户是否需要协助搭建测试框架')
          lines.push('    3. 或者用 bash 运行替代验证（编译检查/手动测试/脚本输出检查）后交付')
          lines.push('  ⚠ 不要只说"请运行测试"——项目根本没有测试可以运行。')
        }
      }

      // Memory-driven review checklist (non-blocking, informational only).
      // Deferred: only append after commit determination so it doesn't
      // clutter the primary gate output.
      const projectMemory = ctx.getProjectMemoryContent?.(params.cwd) ?? readProjectMemory(params.cwd)
      const reviewChecklist = projectMemory
        ? buildReviewPrincipleChecklist({ knowledgeMarkdown: projectMemory, changedFiles: report.ownedFiles })
        : []

      const health = summarizeOwnershipHealth({
        ownedFiles: report.ownedFiles,
        coOwnedFiles: report.coOwnedFiles,
        externalFiles: report.externalFiles,
        dirtyFiles: currentDirtyFiles ?? [...report.ownedFiles, ...report.coOwnedFiles, ...report.externalFiles],
      })
      if (health.warningLines.length > 0) {
        lines.push('', 'Ownership health warnings:')
        lines.push(...health.warningLines.map(line => `  ${line}`))
      }
      if (health.infoLines.length > 0) {
        lines.push('', 'Ownership caveats:')
        lines.push(...health.infoLines.map(line => `  ${line}`))
      }

      if (report.blockingReason) {
        lines.push('', `⚠️  Blocking: ${report.blockingReason}`)
      }

      // P2 cross-session signal: detect claim conflicts with other sessions
      const claimConflicts: Array<{ file: string; holder: string; claimType: string }> = []
      if (ctx.sessionRegistry && ctx.sessionId && report.ownedFiles.length > 0) {
        for (const f of report.ownedFiles) {
          const claim = ctx.sessionRegistry.checkClaim(f)
          if (claim && claim.sessionId !== ctx.sessionId) {
            claimConflicts.push({ file: f, holder: claim.sessionId, claimType: claim.claimType })
          }
        }
        if (claimConflicts.length > 0) {
          lines.push('', '⚠️  Cross-session claim conflicts:')
          for (const c of claimConflicts) {
            const claimKind = c.claimType === 'exclusive' ? 'exclusive lock' : 'shared read'
            lines.push(`  ${c.file} — ${claimKind} held by session ${c.holder}`)
          }
          lines.push('', '  (Continue only if you have verified this conflict is safe to override.)')
        }
      }

      lines.push('', `Attribution: ${report.attributionSummary}`)

      // Failure attribution summary: distinguish "my fault" vs "not my fault" failures.
      // Helps the agent understand: which failures should I fix, which are external?
      {
        const parts: string[] = []
        if (report.currentBlockingFailure) parts.push(`1 条阻断失败（你需处理）`)
        if (report.supersededFailures > 0) parts.push(`${report.supersededFailures} 条预存量（改动前已存在，不归你）`)
        if (parts.length > 0) {
          lines.push(`失败归因：${parts.join(' | ')}`)
          lines.push('→ 只处理"阻断失败"——那是你的改动引入的。预存量失败不归你，可 force 交付。')
        }
      }

      // Recovery journal: detect files that were restored (undo/git checkout) during this session.
      // A clean file after restore may hide unfinished intent — surface it explicitly.
      const recoverySessionId = ctx.sessionId ?? params.sessionId
      const recoveries = readUnacknowledged(params.cwd, recoverySessionId)
      if (recoveries.length > 0) {
        lines.push('', '--- Recovery Journal ---')
        lines.push('  Files restored during this session (edit failure → restore):')
        for (const r of recoveries) {
          lines.push(`  ⚠️  ${r.file} (${r.action}, ~${r.linesLost} lines lost at ${r.ts.slice(11, 19)})`)
        }
        lines.push('', '  ⚠️  Verify no intended changes were lost in these recoveries.')
        lines.push('  If all recovered changes have been re-applied, this warning will clear on next deliver_task.')
      }

      const commit = params.input.commit === true
      const message = params.input.message as string | undefined

      // Task completion audit: surface incomplete items prominently.
      // Prevents silent omissions where the agent claims X is done but only Y was implemented.
      const auditList = params.input.checklist as Array<{ item: string; done: boolean; files?: string[] }> | undefined
      if (auditList && Array.isArray(auditList) && auditList.length > 0) {
        const incomplete = auditList.filter(entry => !entry.done)
        const complete = auditList.filter(entry => entry.done)
        lines.push('', '--- Task Completion Audit ---')
        for (const entry of complete) {
          lines.push(`  ✅ ${entry.item}` + (entry.files?.length ? ` (${entry.files.join(', ')})` : ''))
        }
        for (const entry of incomplete) {
          lines.push(`  ⚠️  NOT DONE: ${entry.item}`)
        }
        if (incomplete.length > 0) {
          // P2: wave-split detection — when a large plan has been partially executed,
          // suggest finishing the current wave before starting the next batch.
          const totalCount = auditList.length
          const doneCount = complete.length
          // Threshold: >=4 — a plan with 4+ tasks executed in one unbroken batch
          // is the exact failure mode for missing task-level commits.
          if (totalCount >= 4) {
            const remainingRatio = incomplete.length / totalCount
            if (remainingRatio > 0.4) {
              lines.push('', `  💡 ${incomplete.length}/${totalCount} tasks remaining (${Math.round(remainingRatio * 100)}%). Consider pausing after this wave — typecheck+test the completed batch, then continue with the next ${Math.min(incomplete.length, 3)} tasks.`)
            } else {
              lines.push('', `  ⚠️  ${incomplete.length} of ${totalCount} tasks incomplete. Verify these are intentionally deferred to the next wave, not forgotten.`)
            }
          } else {
            lines.push('', '  ⚠️  Incomplete tasks detected. Verify these are intentionally deferred, not forgotten.')
          }
        }
      }

      // ── 层3: 重构行为等价契约 — 回归清单逐项核验（advisory，绝不阻断交付）──
      // 重构类交付且零清单 → 按 YELLOW 处理并留痕，防止重构丢失功能。
      try {
        const { isRefactorObjective } = await import('../context/task-contract.js')
        const contract = ctx.getTaskContract?.()
        const inventory = contract?.regressionInventory && contract.regressionInventory.length > 0
          ? contract.regressionInventory
          : findApprovedPlanInventory(params.cwd)
        const refactorish = isRefactorObjective(contract?.objective ?? '')
          || isRefactorObjective(typeof params.input.message === 'string' ? params.input.message : '')
        if (inventory && inventory.length > 0) {
          const results = verifyRegressionInventory(params.cwd, inventory, ctx.inventorySearcher)
          lines.push(...formatInventoryReport(results))
        } else if (refactorish) {
          lines.push('', '⚠️ 重构类交付缺少回归清单（task contract regressionInventory / 计划「回归清单」章节均为空）。')
          lines.push('   行为等价未核验 → 按 YELLOW 处理：交付报告必须说明哪些既有功能（路由/导航/导出/命令入口）已人工确认仍在。')
        }
      } catch {
        // advisory: 回归契约核验绝不让交付本身失败
      }

      // ── Norns 义务账: 议事会契约随附的未偿义务，交付前逐项核验（advisory）──
      // 义务账随 UnifiedPlan JSON 存活在会话 plan-store（多波续跑期间 re-store）。
      // advisory_gate 白名单命令真实执行；暂缓项/缓解承诺列账要求报告逐项披露。
      try {
        const storedJson = getStoredPlan(params.sessionId)
        const storedPlan = storedJson ? (deserializeUnifiedPlan(storedJson) as PlanWithObligations | null) : null
        // ── 验证命令对账（advisory）：计划声明的验证命令逐条核销 ──
        // 覆盖"选择性报绿"：命令挂死/未跑时报告只列跑通的套件也能穿过
        // 诚实门禁——对账把 passed/failed/blocked/not_run 四态机械披露。
        if (storedPlan && ctx.taskLedger) {
          const declared = declaredVerificationCommands(storedPlan)
          if (declared.length > 0) {
            const reconciled = reconcileVerificationCommands(declared, ctx.taskLedger.getVerifications())
            lines.push(...formatVerificationReconcileReport(reconciled))
          }
        }
        if (storedPlan?.obligations && storedPlan.obligations.length > 0) {
          // 默认 runner 异步化（2026-08-09）：spawnSync 会把整个 sidecar 事件循环
          // 冻结至 60s 超时——/health、SSE 全灭，桌面端探针误判 hung。改 spawnHidden
          // 异步执行，摘要语义不变（尾部 3 行 / 300 字符）。
          const runGate: GateRunner = ctx.obligationGateRunner ?? ((command) => runGateAsync(command, params.cwd))
          const results = await verifyObligations(storedPlan.obligations, runGate)
          lines.push(...formatObligationReport(results))
        }
      } catch {
        // advisory: 义务账核验绝不让交付本身失败
      }

      // ── P4 收束闸: PAL 收敛假设 ↔ 交付范围一致性（弱 advisory，绝不阻断）──
      // 攻坚案件收敛出了 selectedHypothesis，但其 targets 完全没出现在本次
      // 交付文件里 → 大概率"诊断收敛了、修复没落地"或改错了地方。只提示。
      try {
        const converged = ctx.getPalConvergedCases?.() ?? []
        if (converged.length > 0) {
          const deliveredFiles = [
            ...report.ownedFiles, ...report.coOwnedFiles,
            ...(currentDirtyFiles ?? []),
          ]
          for (const c of converged) {
            const fileTargets = c.targets.filter(t => t.includes('/') || t.includes('.'))
            if (fileTargets.length === 0) continue
            const touched = fileTargets.some(t =>
              deliveredFiles.some(f => f.includes(t) || t.includes(f)))
            if (!touched) {
              lines.push('', `⚠️ 攻坚案件 ${c.caseId} 已收敛（假设 ${c.selectedHypothesisId}，targets: ${fileTargets.slice(0, 3).join(', ')}${fileTargets.length > 3 ? ' …' : ''}），但这些 targets 不在本次交付文件中——确认修复真的落在了收敛假设指向的位置。`)
            }
          }
        }
      } catch {
        // advisory: PAL 收束闸绝不让交付本身失败
      }

      // ── 遗产回收 W-A1: needs_user 案件披露（弱 advisory，绝不阻断）──
      // 卡在等用户裁决的攻坚案件在交付时静默消失 = 违反交付报告"必须覆盖
      // 遗留项"纪律。只提示：列为遗留项并附最小决策问题。
      try {
        const needsUser = ctx.getPalNeedsUserCases?.() ?? []
        for (const c of needsUser) {
          lines.push('', `⚠️ 攻坚案件 ${c.caseId} 卡在等用户裁决（needs_user）：${c.problem} —— 交付报告必须把它列为遗留项，并附最小决策问题：${c.minimalQuestion}`)
        }
      } catch {
        // advisory: PAL 披露绝不让交付本身失败
      }

      // ── 虚空仓库 P0: 知识收割邀请（弱 advisory，绝不阻断）──
      // 条件展示控 token：本次调用未带 learned，且 session 有实质工作量
      // （存在 PAL 案件，或交付 ≥3 个文件）。agent 看到邀请后在 commit
      // 调用（或下一次调用）里经 learned 参数提交。
      try {
        const learnedProvided = Array.isArray(params.input.learned) && params.input.learned.length > 0
        const palActivity = (ctx.getPalConvergedCases?.() ?? []).length > 0
          || (ctx.getPalNeedsUserCases?.() ?? []).length > 0
        if (!learnedProvided && (palActivity || report.ownedFileCount >= 3)) {
          lines.push(
            '',
            '### 知识收割（虚空仓库）',
            '本次 session 若确认了可复用模式（诊断方法/架构边界/工具链事实/已验证修复），',
            '在 commit 调用时通过 learned 参数提交（每条："模式描述——证据：路径或复现步骤"）。不确定的不要写。',
          )
        }
      } catch {
        // advisory: 收割邀请绝不让交付本身失败
      }

      // ── 冗余义务门禁（星河收编 #2）──────────────────────────────
      // 声明了 redundancy 的义务未达 k 个独立证据时交付 blocked——不静默
      // 降级为 satisfied。force 不豁免：这是当前任务的证据义务，不是预存量
      // 失败。未提供 store 入口时门禁关闭（现状行为不变）。
      let redundancyBlocked = false
      const obligationStore = ctx.getObligationStore?.()
      if (obligationStore) {
        const unsatisfied = obligationStore.obligations.filter(o =>
          o.redundancy && o.state !== 'satisfied' && o.state !== 'superseded'
        )
        if (unsatisfied.length > 0) {
          redundancyBlocked = true
          lines.push('', '❌ 冗余验证未达 quorum（blocked，不静默降级）：')
          for (const ob of unsatisfied) {
            lines.push(`  - 义务「${ob.claim}」需要 ${ob.redundancy!.k} 个独立证据，当前 ${ob.satisfyCount ?? 0} 个（状态 ${ob.state}）`)
          }
          lines.push('  提供额外的独立证据（DP 副本验证、独立工具复现）后再次 deliver。')
        }
      }

      // ── 证据防火墙 Phase 2（jidoka）──────────────────────────────
      // 位置 A：报告组装段——commit 与否都算好未核验引用，警示行恒开。
      // 扫描面与宣称-证据对账同源（message + checklist items）。
      const firewallTracker = ctx.getClaimTracker?.()
      const deliveryText = [
        typeof params.input.message === 'string' ? params.input.message : '',
        ...(auditList ?? []).map(e => e.item),
      ].join('\n')
      const firewallRefs = firewallTracker
        ? findUnverifiedClaimRefs(firewallTracker, deliveryText)
        : []
      if (firewallRefs.length > 0) {
        lines.push('', `⚠ 证据防火墙：交付文本引用了 delegate 报告的路径，但本会话未独立核验：${firewallRefs.join('、')}`)
        lines.push('  worker 的 file:line 是待核验假设——read_file/grep 确认后再作为交付结论，或标注 [待核] 降级为线索。')
      }

      if (commit) {
        // Manual commit mode — user wants to review before committing.
        // Still run the full gate report, just skip the actual git commit.
        if (ctx.autoCommit === false) {
          lines.push(
            '',
            '🛑 自动提交已关闭（agent.delivery.autoCommit = false）。',
            '以上交付报告与门禁状态仅供参考——变更未提交。',
            '审查完成后由用户手动执行 git commit。',
          )
          return { content: lines.join('\n') }
        }
        // Atomic commit reminder — injected at the exact moment before commit,
        // not in system prompt. Keeps prompt noise low while catching "accidental
        // batch commit" at the most dangerous moment.
        lines.push(
          '',
          '<atomic-commit-reminder>',
          '提交前只确认本次一个逻辑单元：',
          '1. 是否只包含当前任务文件？',
          '2. 是否混入外部/他人改动？',
          '3. 测试与 typecheck 是否对应本逻辑单元？',
          '4. commit message 是否描述一个原子变更？',
          '</atomic-commit-reminder>',
        )

        const forceGate = params.input.force === true

        // 位置 B：commit 硬拦——在 RED 判定之前，作为独立拦截条件并列
        // （不与 delivery gate 的 RED 语义混合，防火墙有自己的 Recovery 文案）。
        // force 不豁免：这是当前交付的证据债，不是预存量失败。
        if (commit && firewallRefs.length > 0 && isScoutFirewallEnabled(ctx.scoutFirewallConfig)) {
          lines.push('', '❌ Cannot commit: evidence firewall — 交付引用了未经独立核验的 scout/delegate 断言。')
          lines.push('   （force 不豁免：这是当前交付的证据义务，不是预存量失败。）')
          lines.push('', 'Recovery:')
          lines.push(`  → 用 read_file / grep 逐一核验：${firewallRefs.join('、')}，然后重跑 deliver_task`)
          lines.push('  → 或从提交信息/清单中移除该引用，或为该行添加 [待核] 标注（诚实降级为线索）。')
          return { content: lines.join('\n'), isError: true }
        }

        // Mechanical-change classification (computed once, reused for gate bypass
        // and post-commit review). Only meaningful when fast-path is enabled.
        let mechanicalClass: import('./change-classification.js').ChangeClassification | undefined
        if (isMechanicalFastPathEnabled(ctx.reviewConfig)) {
          mechanicalClass = classifyChange(
            report.ownedFiles,
            createGitDiffProvider(params.cwd, report.ownedFiles, currentDirtyFiles ?? undefined),
          )
        }

        if (report.state === 'RED' || redundancyBlocked) {
          if (redundancyBlocked) {
            // 冗余义务未达 quorum：当前任务的证据义务，force 不豁免。
            lines.push('', '❌ Cannot commit: redundancy obligations not met — quorum evidence insufficient.')
            lines.push('', 'Recovery:')
            lines.push('  → 提供额外的独立证据满足冗余义务（DP 副本验证、独立工具复现、')
            lines.push('    第二条 file:line 证据链），或显式 supersede 该义务后重试。')
            return { content: lines.join('\n'), isError: true }
          } else if (forceGate && report.supersededFailures > 0) {
            lines.push('', '⚠️  RED overridden (force=true): superseded failures detected (these were later fixed).')
            lines.push('   Verify these pre-existing failures are unrelated to your changes before proceeding.')
          } else if (
            report.attributionClass === 'unverified'
            && mechanicalClass?.skipVerification
          ) {
            lines.push('', `✅ 机械式变更 (${mechanicalClass.class})，免验证交付：${mechanicalClass.reason}`)
          } else {
            lines.push('', '❌ Cannot commit: delivery gate is RED.')
            if (report.supersededFailures > 0) {
              lines.push('   (Superseded failures found — these were later fixed, use force=true if pre-existing.)')
            }
            lines.push('', 'Recovery:')
            if (report.blockingReason) {
              lines.push(`  Reason: ${report.blockingReason}`)
            }
            if (report.currentBlockingFailure) {
              lines.push(`  Detail: ${report.currentBlockingFailure}`)
            }
            lines.push('')
            // Unverified: guide to targeted verification instead of full suite
            if (report.ownedFiles.length > 0 && report.verificationCount === 0) {
              lines.push('  → Files are unverified. Run TARGETED tests first:')
              lines.push('    Use run_tests with filter="test-file-name" for each changed file.')
              lines.push('    Use related_tests(sourceFile) to find the right test file.')
              lines.push('')
              lines.push('    Do NOT run the full test suite as first step — it may timeout.')
            } else {
              lines.push('  → Fix the blocking issue above, then re-run deliver_task.')
              lines.push('    If tests keep timing out, run them in smaller batches by directory.')
            }
            return { content: lines.join('\n'), isError: true }
          }
        }
        // W1 回归防线: module_unverified 在 assess 层是 YELLOW（可带条件交付），
        // 但 commit=true 是不可逆落地动作 → 升 RED 硬拦。force=true 是逃生口
        // （用户确认波及测试为静态分析假阳性时）。
        if (report.state === 'YELLOW' && report.attributionClass === 'module_unverified') {
          if (forceGate) {
            lines.push('', '⚠️  module_unverified overridden (force=true): impacted tests remain unverified.')
            lines.push('   Confirm the uncovered tests are static-analysis false positives before proceeding.')
          } else {
            lines.push('', '❌ Cannot commit: impacted tests were never covered by a passed verification.')
            lines.push(`  Reason: ${report.attributionSummary}`)
            const uncovered = report.uncoveredImpactedTests ?? []
            if (uncovered.length > 0) {
              lines.push('', '  Uncovered impacted tests:')
              for (const t of uncovered.slice(0, 10)) lines.push(`    ${t}`)
              if (uncovered.length > 10) lines.push(`    (+${uncovered.length - 10} more)`)
            }
            lines.push('', '  → Run these tests (run_tests with filter) or a full-scope verification, then re-run deliver_task.')
            lines.push('    If they are unrelated to your change (static-analysis false positive), use force=true.')
            return { content: lines.join('\n'), isError: true }
          }
        }
        if (report.state === 'YELLOW') {
          const stanceHint = detectSymptomPatch(params.cwd)
          if (stanceHint) lines.push('', stanceHint)
        }
        if (!message) {
          lines.push('', '❌ Commit requires a "message" parameter.')
          return { content: lines.join('\n'), isError: true }
        }

        // 宣称-证据对账（复现即证明）：commit message / checklist 里宣称测试绿，
        // 但 ledger 里最后一次文件变更后零条 passed 验证记录 → RED 硬拦；
        // 宣称的 N/N 与最新验证记录对不上 → 软警不阻断。
        if (claimAuditEnabled()) {
          const checklistText = (auditList ?? []).map(e => e.item).join('\n')
          const audit = auditDeliveryClaims({
            claimText: `${message}\n${checklistText}`,
            events: ctx.taskLedger.getEvents(),
          })
          if (audit.status === 'block') {
            lines.push('', ...audit.lines)
            return { content: lines.join('\n'), isError: true }
          }
          if (audit.status === 'warn') {
            lines.push('', ...audit.lines)
          }
        }
        // Adopt external files into owned set (cross-session takeover)
        const adoptFiles = params.input.adopt as string[] | undefined
        if (adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length > 0) {
          // Validate: adopted files must be external OR co-owned (shared ownership).
          // Co-owned files can be adopted when the other session is done/crashed.
          const externalSet = new Set(report.externalFiles)
          const coOwnedSet = new Set(report.coOwnedFiles)
          const adoptableSet = new Set([...externalSet, ...coOwnedSet])
          const notAdoptable = adoptFiles.filter(f => !adoptableSet.has(f))
          if (notAdoptable.length > 0) {
            lines.push('', `❌ Adopt: file(s) not in external or co-owned files: ${notAdoptable.join(', ')}. Only external and co-owned files can be adopted.`)
            return { content: lines.join('\n'), isError: true }
          }
          const adopted = ctx.ownership.adoptFiles(adoptFiles)
          if (adopted.length > 0) {
            const wasCoOwned = adopted.filter(f => coOwnedSet.has(f))
            const wasExternal = adopted.filter(f => externalSet.has(f))
            if (wasCoOwned.length > 0) lines.push('', `🔓 Adopted ${wasCoOwned.length} co-owned file(s) into exclusive ownership:`)
            if (wasExternal.length > 0) lines.push('', `🔓 Adopted ${wasExternal.length} external file(s) into owned set:`)
            for (const f of adopted) lines.push(`   ${f}`)
            if (wasCoOwned.length > 0) lines.push('', '  ⚠️ These files were shared with another session. Verify the other session has finished before committing.')
            if (wasExternal.length > 0) lines.push('', '  ⚠️ These files were modified by another session. Verify the changes are correct before committing.')
            // Refresh report after adoption — the gate may change
          }
        } else if (adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length === 0) {
          // adopt: [] is equivalent to omitting adopt — no files to adopt, not an error.
          // Previously this was treated as a user mistake, but callers (especially
          // model-generated tool calls) may pass an explicit empty array to mean "no adoption".
        }

        const postAdoptionReport = adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length > 0
          ? ctx.gate.getReport([], currentDirtyFiles, ctx.getCurrentSnapshotRef?.(), moduleCoverage)
          : report
        if (postAdoptionReport.state === 'RED') {
          // Mechanical fast-path also applies to the post-adoption gate
          // (when no adoption happens, postAdoptionReport === report, and the
          // bypass was already decided above — don't re-block).
          const postAdoptionBypass = postAdoptionReport.attributionClass === 'unverified'
            && mechanicalClass?.skipVerification
          if (!postAdoptionBypass) {
            lines.push('', '❌ Cannot commit: delivery gate is RED after adoption.')
            if (postAdoptionReport.blockingReason) {
              lines.push(`  Reason: ${postAdoptionReport.blockingReason}`)
            }
            if (postAdoptionReport.currentBlockingFailure) {
              lines.push(`  Detail: ${postAdoptionReport.currentBlockingFailure}`)
            }
            lines.push('  → Run verification for the adopted files, then re-run deliver_task.')
            return { content: lines.join('\n'), isError: true }
          }
        }

        // Resolve files to commit: subset from `files` param, or all owned
        // Note: after adoption, use refreshed owned set from ledger (not stale report)
        const requestedFiles = params.input.files as string[] | undefined
        const currentOwnedFiles = ctx.ownership.getOwnedFiles()
        let filesToCommit = currentOwnedFiles

        if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length > 0) {
          const ownedSet = new Set(currentOwnedFiles)
          const notOwned = requestedFiles.filter(f => !ownedSet.has(f))
          if (notOwned.length > 0) {
            lines.push('', `❌ File(s) not in owned files: ${notOwned.join(', ')}. Cannot commit non-owned files.`)
            return { content: lines.join('\n'), isError: true }
          }
          filesToCommit = requestedFiles
        } else if (requestedFiles && Array.isArray(requestedFiles) && requestedFiles.length === 0) {
          lines.push('', '❌ No files specified for commit. Provide non-empty files array or omit to commit all owned files.')
          return { content: lines.join('\n'), isError: true }
        }

        const commitConflictFiles = new Set(filesToCommit)
        const blockingClaimConflicts = claimConflicts.filter(conflict => commitConflictFiles.has(conflict.file))
        if (blockingClaimConflicts.length > 0 && !forceGate) {
          lines.push('', '❌ Cannot commit: cross-session claim conflicts are present.')
          lines.push('   → Resolve the other session claim or use force=true only after independently verifying the override is safe.')
          return { content: lines.join('\n'), isError: true }
        }
        if (blockingClaimConflicts.length > 0 && forceGate) {
          lines.push('', '⚠️ Cross-session claim conflicts overridden with force=true. Verify the other session has finished or approved the takeover.')
        }

        // ── PRE-COMMIT GATES (blocking) ──────────────────────────────────
        // Static checks that don't need worker API calls — run before commit.

        // D-fix: cheap static wrote-but-never-read check. Mechanically catches
        // the modelOverride class of dead wiring (field/symbol added, zero
        // read-side consumers) at the moment of delivery. YELLOW, non-blocking.
        try {
          const deadSymbols = (ctx.detectWroteButNeverRead ?? detectWroteButNeverRead)(params.cwd, filesToCommit)
          lines.push(...formatWroteButNeverRead(deadSymbols))
        } catch {
          // best-effort: never let the nudge break delivery
        }

        // 虚假绿灯对偶检查：字段被生产代码读取，却只有测试 fixture 赋值、生产无写入点
        // = fixture 伪造了真实系统不产出的形状。YELLOW，非阻断。仅抓子型A（生产零写入）；
        // 子型B（写入点存在但运行时永空）是 review 门的职责。
        try {
          const falseGreen = (ctx.detectReadButNeverProduced ?? detectReadButNeverProduced)(params.cwd, filesToCommit)
          lines.push(...formatReadButNeverProduced(falseGreen))
        } catch {
          // best-effort: never let the nudge break delivery
        }

        // Probe-residue gate: scan owned files for leftover debug probes
        // (console.log/debugger/.only etc.). YELLOW, non-blocking — the model
        // may have intentionally added logging. fs re-scan is authoritative:
        // probes already cleaned by a later edit won't be in the file.
        try {
          const scanner = ctx.scanProbes ?? ((files, cwd) => {
            return scanFilesForProbes(files, cwd, (p) => {
              try { return readFileSync(p, 'utf-8') } catch { return null }
            })
          })
          const probeHits = scanner(filesToCommit, params.cwd)
          if (probeHits.length > 0) {
            lines.push(...formatProbeHits(probeHits))
          }
        } catch {
          // best-effort: never let probe scanning break delivery
        }

        // Structure gate（行数棘轮预警）: committed files over their named
        // ceiling or the new-file redline get an actionable split nudge.
        // YELLOW, non-blocking — the hard stop is architecture-guards in
        // npm test; this surfaces the ratchet before CI does.
        try {
          const structure = (ctx.checkStructure ?? checkStructureGate)(filesToCommit, params.cwd)
          if (structure.needsWarning) {
            lines.push('', ...structure.warningLines.map(l => `  ${l}`))
          }
        } catch {
          // best-effort: never let the structure nudge break delivery
        }

        // Cohesion gate: RED if files span too many areas (unless force=true)
        // When files were adopted (cross-session takeover), auto-override cohesion
        // since the adoption scope is intentional.
        const cohesionOverride = forceGate
          || (adoptFiles && Array.isArray(adoptFiles) && adoptFiles.length > 0)
        const cohesion = checkCommitCohesion(filesToCommit)
        mark('cohesion:done')
        if (cohesion.needsWarning && !cohesionOverride) {
          lines.push('', ...cohesion.warningLines.map(l => `  ${l}`))
          mark('cohesion:denied')
          return { content: lines.join('\n'), isError: true }
        }
        if (cohesion.needsWarning && cohesionOverride) {
          lines.push('', '  ⚠️ Cohesion gate overridden with force=true. Verify this is truly one logical unit.')
        }

        // ── COMMIT (no longer blocked by review) ─────────────────────────
        // Review is post-commit (advisory) — the commit must land first so
        // the main loop never stalls on a slow/timeout review worker.

        // Pre-flight: detect another git process holding the index lock.
        // A stale lock (crashed / zombie git) is cleaned up automatically;
        // a live lock (another session mid-commit) fails fast with an
        // actionable message instead of hanging until the tool times out.
        const lockPath = join(params.cwd, '.git', 'index.lock')
        if (existsSync(lockPath)) {
          try {
            const lockAge = Date.now() - statSync(lockPath).mtimeMs
            if (lockAge > 30_000) {
              // Stale lock (> 30s): clean up and proceed.
              unlinkSync(lockPath)
              lines.push('', '  ♻️  Cleared a stale git lock file before committing.')
            } else {
              lines.push('', `  ⚠️  Git index is locked (another session mid-commit, lock age ${Math.round(lockAge / 1000)}s).`)
              lines.push('     Wait a few seconds and retry deliver_task. Do NOT fall back to raw git commit — that bypasses ownership scoping.')
              return { content: lines.join('\n'), isError: true }
            }
          } catch {
            // Permission denied or race — let the commit attempt surface the real error.
          }
        }

        // Capture HEAD before the commit so the result carries verifiable
        // evidence that a new commit actually landed (vs. agent guessing from
        // a possibly-stale git status snapshot).
        const headBefore = spawnGitSync(['rev-parse', '--short', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 5000 })
        mark('commit:before')
        const headBeforeHash = headBefore.status === 0 ? headBefore.stdout.trim() : null

        const executor = ctx.commitOwnedFiles ?? ((cwd, files, msg) => commitScopedFiles({ cwd, files, message: msg }))
        const commitResult = executor(params.cwd, filesToCommit, message)
        if (!commitResult.ok) {
          lines.push('', `❌ Scoped commit failed: ${commitResult.output}`)
          return { content: lines.join('\n'), isError: true }
        }
        lines.push('', `✅ Scoped commit created with message: "${message}"`)
        lines.push(`   Files: ${filesToCommit.join(', ') || '(none)'}`)
        if (commitResult.output) lines.push(`   ${commitResult.output}`)
        // Post-commit truth readback: verify HEAD actually moved + surface hash.
        const headAfter = spawnGitSync(['rev-parse', '--short', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 5000 })
        mark('commit:after')
        const headAfterHash = headAfter.status === 0 ? headAfter.stdout.trim() : null
        if (headBeforeHash && headAfterHash) {
          if (headBeforeHash !== headAfterHash) {
            lines.push(`   VERIFIED: HEAD moved ${headBeforeHash} → ${headAfterHash}. The commit is real — do NOT re-attempt it.`)
          } else {
            lines.push(`   ⚠️ WARNING: HEAD did not move (still ${headAfterHash}). The commit may not have landed — verify with git log before retrying.`)
          }
        }
        const readback = spawnGitSync(['-c', 'core.quotePath=false', 'show', '--stat', '--format=%h%d', 'HEAD'], { cwd: params.cwd, encoding: 'utf-8', timeout: 10_000 })
        if (readback.status === 0 && readback.stdout.trim()) {
          lines.push('', '--- actual changes (git show --stat) ---')
          lines.push(readback.stdout.trim())
        }
        // Acknowledge recovery journal entries — the commit confirms intent was preserved.
        if (recoveries.length > 0) acknowledgeAll(params.cwd, recoverySessionId)

        // ── POST-COMMIT REVIEW (advisory, non-blocking) ──────────────────
        // Review runs AFTER the commit so a slow/timeout worker never stalls
        // the main loop or blocks delivery. Findings are surfaced as warnings;
        // the commit has already landed and cannot be un-done by review.
        // The reviewDepth guard prevents verifier/patcher child contexts from
        // recursively reviewing themselves.
        // RIVET_REVIEW_DISCIPLINE=0 / false / off / no disables the gate (default: enabled).
        const explicitReviewLevel = params.input.review_level as ReviewScale | undefined
        // 只抑制「系统自动」审查（auto / defer / final / goal-achieved L3）。
        // 显式 review_level（手动 /review）是用户明确意图，永远绕过本抑制。
        const skipAutoReview = params.input.skipAutoReview === true
          || ctx.isGoalActive?.() === true
          || ctx.reviewConfig?.skipAuto === true
          || ctx.isAutoReviewOff?.() === true
        const goalAchieved = ctx.isGoalAchieved?.() === true
        const goalVerdict = ctx.getLastVerdict?.() ?? null
        // review_policy（长任务审查批处理）：'each' 默认逐 commit；'defer'
        // 跳过即时审查并累积进会话 pending；'final' 对累积范围一次终审。
        // 显式 review_level 优先——组合传入时 review_policy 被忽略。
        const reviewPolicyRaw = params.input.review_policy
        const reviewPolicy: 'each' | 'defer' | 'final' =
          reviewPolicyRaw === 'defer' || reviewPolicyRaw === 'final' ? reviewPolicyRaw : 'each'

        // Goal-achieved commit: auto-upgrade to L3 for final review sweep.
        // Best-effort — if review deps are unavailable the commit still lands.
        const effectiveReviewLevel: ReviewScale | undefined = goalAchieved && !explicitReviewLevel
          ? 'L3'
          : explicitReviewLevel

        const change: ChangeSet = {
          files: filesToCommit,
          crossModule: isCrossModule(filesToCommit),
          isFix: isFixContext(message),
          goalActive: ctx.isGoalActive?.() === true,
          largeFiles: collectLargeFiles(params.cwd, filesToCommit),
          commitMessage: typeof message === 'string' ? message : undefined,
          ...(effectiveReviewLevel ? { forceLevel: effectiveReviewLevel } : {}),
          ...(mechanicalClass ? { changeClass: mechanicalClass } : {}),
        }

        // Inject meridian blast radius into focusHint so verifier/inspector
        // know which downstream consumers to verify. Absolute paths filtered
        // (repo-relative LIKE silently returns empty on absolute paths).
        const meridianDb = ctx.meridianIndexer?.getDb()
        const relChangeFiles = change.files.filter(f => !isAbsolute(f))
        if (meridianDb && relChangeFiles.length > 0) {
          const impact = analyzeImpact(meridianDb, relChangeFiles)
          const parts: string[] = []
          if (impact.direct.length > 0)
            parts.push(`downstream consumers: ${impact.direct.slice(0, 8).join(', ')}${impact.direct.length > 8 ? ` (+${impact.direct.length - 8} more)` : ''}`)
          if (impact.tests.length > 0)
            parts.push(`related tests: ${impact.tests.slice(0, 8).join(', ')}${impact.tests.length > 8 ? ` (+${impact.tests.length - 8} more)` : ''}`)
          if (parts.length > 0) {
            const blast = `Blast radius — ${parts.join('; ')}`
            change.focusHint = change.focusHint ? `${change.focusHint} | ${blast}` : blast
          }
        }

        // Surface the judge verdict alongside the delivery report so L3 review
        // Surface the judge verdict alongside the delivery report so L3 review
        // can focus on code quality — the judge already established functional
        // completeness. When verdict is null, the judge didn't run (disabled,
        // no coordinator, or goal completed before first judge invocation).
        if (goalVerdict) {
          const v = goalVerdict
          if (v.overall === 'verified') {
            lines.push('', `✅ Goal judge: verified (${v.criteriaMet}/${v.criteriaTotal} criteria met). L3 review can focus on code quality.`)
          } else if (v.overall === 'rejected') {
            lines.push('', `⚠️ Goal judge: rejected (${v.criteriaUnmet} unmet of ${v.criteriaTotal}). Accepted at judge cap — residual: ${v.summary}`)
          } else {
            lines.push('', `⚠️ Goal judge: inconclusive. Accepted unverified — ${v.summary}`)
          }
        }

        // Suppress auto review when goal is active OR caller explicitly skips.
        // Goal-driven auto-continuation can't afford child review worker stalls.
        // 显式 review_level（手动 /review）是用户明确意图，绕过一切自动审查抑制——
        // off 模式关闭的是「自动审查」，不是「禁止用户手动审」。
        if (skipAutoReview && !explicitReviewLevel) {
          lines.push('', '⏭ 自动审查已跳过（goal 模式 / skipAuto / /review off）。手动 /review [max] 审查不受影响。')
        } else if (reviewDepth === 0 && shouldRouteReviewWorkflow(change) && isReviewDisciplineEnabled()) {
          // review_policy=defer：长任务声明"过程不审、收尾终审"——commit 范围
          // 累积进会话级 pending（typecheck 升级标记一并记录），由 final /
          // goal-achieved L3 / 下一次换审统一消费，本轮不起 worker。
          if (reviewPolicy === 'defer' && !explicitReviewLevel) {
            const scope = addPendingReviewFiles(ctx.sessionId, filesToCommit, { escalate: change.forceLevel === 'L3' })
            lines.push('', `⏭ 提交后审查已延迟（review_policy=defer）：会话已累积 ${scope.commits} 个 commit、${scope.files.size} 个文件待审。收尾用 review_policy:'final' 或 /review max 统一审查。`)
          } else {
            // 批量约束只作用于系统触发的审查。显式 review_level（手动 /review）
            // 与 goal-achieved L3 终审是明确意图，不被冷却/在飞单例跳过；
            // final 绕过冷却但在在飞时仍并入 pending（重叠审查比延迟更浪费）。
            const bypassCooldown = explicitReviewLevel !== undefined || reviewPolicy === 'final' || goalAchieved
            const bypassInFlight = explicitReviewLevel !== undefined || goalAchieved
            const now = Date.now()
            if (!bypassCooldown && now - lastPostCommitReviewAt < POST_COMMIT_REVIEW_COOLDOWN_MS) {
              const sinceSec = Math.round((now - lastPostCommitReviewAt) / 1000)
              const windowSec = Math.round(POST_COMMIT_REVIEW_COOLDOWN_MS / 1000)
              addPendingReviewFiles(ctx.sessionId, filesToCommit, { escalate: change.forceLevel === 'L3' })
              lines.push('', `⏭ 提交后审查跳过：距上轮审查仅 ${sinceSec}s（<${windowSec}s 冷却窗口）。本轮变更已记入待审范围，下次审查自动覆盖，也可 /review 手动立即审查。`)
            } else if (!bypassInFlight && postCommitReviewInFlight) {
              const scope = addPendingReviewFiles(ctx.sessionId, filesToCommit, { escalate: change.forceLevel === 'L3' })
              lines.push('', `⏭ 已有在飞审查：本轮 commit 并入待审范围（会话累计 ${scope.commits} 个 commit），在飞审查完成后统一补审，不重复起 worker。`)
            } else {
              const route = ctx.routeReviewWorkflow ?? (ctx.reviewDeps ? routeReviewWorkflow : undefined)
              if (!route || !ctx.reviewDeps) {
                // Advisory: review deps unavailable is a caveat, not a blocker.
                lines.push('', '⚠️ 提交后审查跳过：审查依赖不可用（ReviewRouter 未接入）。')
              } else {
                // Fold the session's accumulated pending scope (cooldown-skipped /
                // in-flight-merged / deferred commits) into this launch — recorded
                // commits must be covered by the next review, never stranded.
                const accumulated = consumePendingReview(ctx.sessionId)
                let reviewChange: ChangeSet = change
                if (accumulated && accumulated.files.size > 0) {
                  const mergedFiles = [...new Set([...accumulated.files, ...change.files])]
                  reviewChange = {
                    ...change,
                    files: mergedFiles,
                    crossModule: isCrossModule(mergedFiles),
                    largeFiles: collectLargeFiles(params.cwd, mergedFiles),
                    ...(accumulated.escalate && !change.forceLevel
                      ? {
                          forceLevel: 'L3' as ReviewScale,
                          focusHint: change.focusHint
                            ? `Deferred commits escalated by typecheck/declared-check failure | ${change.focusHint}`
                            : 'Deferred commits escalated by typecheck/declared-check failure',
                        }
                      : {}),
                  }
                  lines.push('', reviewPolicy === 'final'
                    ? `🔍 终审（review_policy=final）：覆盖 ${accumulated.commits} 个延迟 commit + 本次提交，共 ${mergedFiles.length} 个文件。`
                    : `📎 本次审查一并覆盖此前累积的 ${accumulated.commits} 个未审 commit（共 ${mergedFiles.length} 个文件）。`)
                } else if (reviewPolicy === 'final') {
                  lines.push('', '🔍 终审（review_policy=final）：无累积的延迟 commit，仅审查本次提交。')
                }
                const reviewMode: ReviewMode = reviewChange.forceLevel ? 'manual' : 'auto'
                const REVIEW_TIMEOUT_MS = reviewWorkflowBudgetMs(reviewMode, reviewChange.forceLevel)
                const reviewAbort = new AbortController()
                if (params.abortSignal) {
                  if (params.abortSignal.aborted) {
                    lines.push('', '⚠️ 提交后审查跳过：工具已取消。')
                  } else {
                    params.abortSignal.addEventListener('abort', () => reviewAbort.abort(), { once: true })
                  }
                }
                if (!params.abortSignal?.aborted) {
                  const budgetSec = Math.round(REVIEW_TIMEOUT_MS / 1000)
                  const reviewDeps = ctx.reviewDeps
                  // 审查门 UI 可见性：复用会话级 DelegationActivity 通道把审查
                  // worker 进度上行到子代理面板（tool 完成后该回调仍有效）。
                  // 真实审查 worker（wo_<uuid>）只经 mapper 发 running、没有任何
                  // 终态事件源（phantom review-gate-* 行才有）——记录本轮出现过
                  // 的真实 worker id，审查 round 结束时逐个补发终态，否则它们
                  // 永远挂在子代理面板 running（deliver_task 非委派工具，走不到
                  // clearGroup）。
                  const reviewTerminalOf = (outcome: ReviewOutcome) => {
                    // rejected = 审查正常走完并发现问题（已落地，不是系统失败）
                    const terminalStatus: DelegationActivity['status'] =
                      outcome.verdict === 'verified' || outcome.verdict === 'nudge'
                        ? 'completed'
                        : outcome.verdict === 'rejected'
                          ? 'completed'
                          : 'failed'
                    const failureReason = outcome.verdict === 'rejected' ? 'review-findings'
                      : outcome.verdict === 'inconclusive' ? 'review-infra' : undefined
                    const lines0 = formatReviewOutcomeLines(outcome)
                    const progressLine = outcome.verdict === 'nudge'
                      ? '审查门完成 (nudge)：变更琐碎，免深审'
                      : (lines0[0] ?? `审查门完成 (${outcome.verdict})`)
                    const summary = outcome.verdict === 'rejected' || outcome.verdict === 'inconclusive'
                      ? lines0.join('\n')
                      : undefined
                    return { terminalStatus, failureReason, progressLine, summary }
                  }
                  const settleReviewWorkers = (
                    outcome: ReviewOutcome,
                    activityMapper: ReturnType<typeof createDelegationActivityMapper> | undefined,
                    latestByWorker: Map<string, DelegationActivity>,
                  ): void => {
                    if (!activityMapper || latestByWorker.size === 0) return
                    const { terminalStatus, failureReason, progressLine, summary } = reviewTerminalOf(outcome)
                    for (const [wid, latest] of latestByWorker) {
                      activityMapper.finish({
                        ...latest,
                        workOrderId: wid,
                        parentToolId: params.toolUseId,
                        profile: 'reviewer',
                        status: terminalStatus,
                        progressLine,
                        ...(failureReason ? { failureReason } : {}),
                        ...(summary ? { summary } : {}),
                      })
                    }
                    latestByWorker.clear()
                  }
                  const runReviewOnce = async (
                    targetChange: ChangeSet,
                    runMode: ReviewMode,
                    timeoutMs: number,
                    controller: AbortController,
                    activityMapper: ReturnType<typeof createDelegationActivityMapper> | undefined,
                  ): Promise<ReviewOutcome> => {
                    const fallbackTier = runMode === 'auto' ? 'auto' as const : (targetChange.forceLevel ?? effectiveReviewLevel ?? 'L2')
                    let reviewTimer: NodeJS.Timeout | undefined
                    let outcome: ReviewOutcome
                    try {
                      const timeoutPromise = new Promise<never>((_, reject) => {
                        reviewTimer = setTimeout(() => {
                          controller.abort()
                          reject(new Error('Review workflow timed out'))
                        }, timeoutMs)
                      })
                      outcome = await Promise.race([
                        route(targetChange, reviewDeps, { abortSignal: controller.signal, mode: runMode, depthLayer: ctx.getDepthLayer?.(), onActivity: activityMapper }),
                        timeoutPromise,
                      ])
                    } catch (err) {
                      const reason = err instanceof Error ? err.message : String(err)
                      // Review is best-effort post-commit: a timeout/crash never blocks
                      // delivery — the commit already landed. Report honestly.
                      outcome = {
                        tier: fallbackTier,
                        verdict: 'inconclusive',
                        rounds: 0,
                        evidence: `post-commit review DID NOT run (${reason.includes('timed out') ? 'timed out' : 'infra failure'}: ${reason})`,
                        infraFailures: [{ kind: reason.includes('timed out') ? 'timeout' : 'crash', claim: reason }],
                      }
                    } finally {
                      if (reviewTimer) clearTimeout(reviewTimer)
                    }
                    // Review infra health observability (/status): auto runs only.
                    if (runMode === 'auto' && outcome.rounds !== undefined && outcome.verdict !== 'nudge') {
                      if (outcome.verdict === 'inconclusive') {
                        recordAutoReviewRun({ ran: false, failureKinds: (outcome.infraFailures ?? []).map(f => f.kind) })
                      } else {
                        recordAutoReviewRun({ ran: true, ...(outcome.recoveredByRetry ? { recoveredByRetry: true } : {}) })
                      }
                    }
                    return outcome
                  }

                  // Detached launcher — shared by the initial system-triggered
                  // review and the in-flight follow-up sweep. Owns the in-flight
                  // singleton: commits landing while a review runs merge into the
                  // session pending scope (see the inFlight branch above) instead
                  // of spawning an overlapping worker, and the completion chain
                  // below consumes that scope with ONE follow-up review.
                  const launchDetached = (targetChange: ChangeSet, runMode: ReviewMode, commitRef: string): void => {
                    lastPostCommitReviewAt = Date.now()
                    postCommitReviewInFlight = true
                    const controller = new AbortController()
                    if (params.abortSignal) {
                      if (params.abortSignal.aborted) {
                        postCommitReviewInFlight = false
                        return
                      }
                      params.abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
                    }
                    const timeoutMs = reviewWorkflowBudgetMs(runMode, targetChange.forceLevel)
                    const runBudgetSec = Math.round(timeoutMs / 1000)
                    // Each detached review owns one mapper lifecycle. A follow-up
                    // review must not reuse a mapper that has already been sealed.
                    const latestByWorker = new Map<string, DelegationActivity>()
                    const trackedUpstream = params.onWorkerActivity
                      ? (activity: DelegationActivity) => {
                          latestByWorker.set(activity.workOrderId, activity)
                          params.onWorkerActivity!(activity)
                        }
                      : undefined
                    const activityMapper = trackedUpstream
                      ? createDelegationActivityMapper(params.toolUseId, trackedUpstream)
                      : undefined
                    // 审查门 UI 可见性（detached 路径此前对用户完全隐形）：
                    // 启动行走 onOutput；「审查门自身」发 phantom running/终态事件
                    // （独立于 worker 事件，保证 nudge/超时也至少有始有终）；
                    // worker 实时进度由上面的 activityMapper 上行。
                    params.onOutput?.(`\n⏳ 提交后审查启动中 (${runMode}${targetChange.forceLevel ? ' ' + targetChange.forceLevel : ''}, ≤${runBudgetSec}s)——审查 worker 进度见子代理面板...\n`)
                    const reviewRunId = `review-gate-${String(commitRef).slice(0, 7)}-${Math.random().toString(36).slice(2, 7)}`
                    params.onWorkerActivity?.({ workOrderId: reviewRunId, parentToolId: params.toolUseId, profile: 'reviewer', status: 'running', progressLine: `审查门启动 (${runMode}…)` })
                    void runReviewOnce(targetChange, runMode, timeoutMs, controller, activityMapper).then(outcome => {
                      enqueuePostCommitReviewOutcome({
                        lines: [`提交 ${commitRef} 的提交后审查完成：`, ...formatReviewOutcomeLines(outcome)],
                        verdict: outcome.verdict,
                        tier: String(outcome.tier),
                      })
                      const { terminalStatus, failureReason, progressLine, summary } = reviewTerminalOf(outcome)
                      params.onWorkerActivity?.({
                        workOrderId: reviewRunId,
                        parentToolId: params.toolUseId,
                        profile: 'reviewer',
                        status: terminalStatus,
                        progressLine,
                        ...(failureReason ? { failureReason } : {}),
                        ...(summary ? { summary } : {}),
                      })
                      // 真实审查 worker（wo_<uuid>）补终态——它们只发过 running，
                      // 不补会永远挂在子代理面板（deliver_task 不走 clearGroup）。
                      settleReviewWorkers(outcome, activityMapper, latestByWorker)
                    }).catch(() => { /* runReviewOnce never rejects; double guard */ }).finally(() => {
                      activityMapper?.dispose()
                      postCommitReviewInFlight = false
                      if (params.abortSignal?.aborted) return
                      // 补审：在飞期间到达的 commit 已并入会话 pending（inFlight
                      // 分支与冷却分支），统一一轮覆盖，不再逐 commit 起 worker。
                      // （defer 累积的范围也可能被提前消费——审查是 advisory，
                      // 提前覆盖不违反交付语义，final 时只会看到更小的范围。）
                      const followUp = consumePendingReview(ctx.sessionId)
                      if (!followUp || followUp.files.size === 0) return
                      const mergedFiles = [...followUp.files]
                      const followChange: ChangeSet = {
                        files: mergedFiles,
                        crossModule: isCrossModule(mergedFiles),
                        isFix: false,
                        goalActive: false,
                        largeFiles: collectLargeFiles(params.cwd, mergedFiles),
                        ...(followUp.escalate ? { forceLevel: 'L3' as ReviewScale } : {}),
                      }
                      const followMode: ReviewMode = followChange.forceLevel ? 'manual' : 'auto'
                      launchDetached(followChange, followMode, 'HEAD（合并补审）')
                    })
                  }

                  const commitRef = headAfterHash ?? 'HEAD'
                  mark('review:dispatch-start')

                  if (explicitReviewLevel) {
                    // Explicit review_level (补丁 1 方案 A): unified with
                    // system-triggered path — review runs detached so it never
                    // blocks the commit return. Verdict flows through
                    // post-commit-review-queue → AdvisoryBus in a later turn.
                    lastPostCommitReviewAt = Date.now()
                    launchDetached(reviewChange, reviewMode, String(commitRef))
                    lines.push('', `⏳ 提交后审查已转后台 (${reviewMode} ${explicitReviewLevel}, ≤${budgetSec}s)——审查结论将通过 system 通道注入后续对话，本次交付不等待。`)
                  } else {
                    // System-triggered review (auto wiring inspector / typecheck-
                    // escalated L3 / goal-achieved L3): detach. The 240s-timeout
                    // incident chain (2026-07-07) showed a synchronous 180s review
                    // await drives models to bypass deliver_task for raw git
                    // commit — the review is advisory, the commit has already
                    // landed, so the main loop must not stall on it. Outcome
                    // flows through post-commit-review-queue → runtime hook →
                    // AdvisoryBus into a later turn.
                    lastPostCommitReviewAt = Date.now()
                    launchDetached(reviewChange, reviewMode, String(commitRef))
                    lines.push('', `⏳ 提交后审查已转后台 (${reviewMode}${reviewChange.forceLevel ? ' ' + reviewChange.forceLevel : ''}, ≤${budgetSec}s)——进度见子代理面板，结论将以 system 通道注入后续对话并汇总到面板，本次交付不等待。`)
                  }
                }
              }
            }
          }
        }
      }

      // Append review principle checklist at end (non-blocking, informational)
      if (reviewChecklist.length > 0) {
        lines.push('', '审查原则清单：')
        for (const item of reviewChecklist.slice(0, 2)) {
          lines.push(`  - ${item.question}`)
        }
        if (reviewChecklist.length > 2) {
          lines.push(`  ... 还有 ${reviewChecklist.length - 2} 条原则`)
        }
      }

      // ── 交付后自检（硬性，不替代人工审查，但减少静默带偏）─────────────
      // 每次交付结束时提醒 agent 核验两件事：① 提交的文件是否就是本次要交的
      // （避免 --all 事故）；② 工作区是否有不该出现的未跟踪文件（可能是
      // 上一步操作意外写入的临时文件/缓存/构件产物）。
      lines.push('',
        '交付后自检（提交后 10 秒内看一眼）：',
        '  1. 刚才的提交文件列表是否符合「本次改动的文件」——是的话继续，有陌生的立刻 revert',
        '  2. 项目目录下有没有不该出现的新文件（git status 里的 ?? 行）——有的话加 gitignore 或清理',
      )

      // ── 虚空仓库 P0: learned 收割 → memory.jsonl 直写 ──────────────────
      // 改为 fire-and-forget：不阻塞 commit 返回。I/O 失败由 .catch 防御，
      // 不崩进程（unhandled rejection guard）。
      // 只在成功路径执行（错误分支已早退，交付被拦时不收割）。
      setImmediate(() => {
        try {
          const entries = parseLearnedEntries(params.input.learned)
          let written = 0
          for (const lp of entries) {
            // 写前相似去重：上一次 learned 重提 / 第四层 PAL 自动收割同结论 → 跳过
            if (countSimilarMemoryEntries(params.cwd, lp.text) > 0) continue
            appendMemoryEntry(params.cwd, {
              text: lp.text,
              kind: 'verified_pattern',
              confidence: 0.95,
              source: 'agent-crafted',
              status: 'verified',
              evidence: lp.evidence || undefined,
              sessionId: ctx.sessionId,
              tags: lp.tags,
              transferableTo: ['all'],
              topic: lp.topic,
            })
            written++
          }
          // Fire-and-forget: no lines.push — the return has already been sent.
        } catch {
          // 收割失败绝不阻断交付；.catch 防止 unhandled rejection
        }
      })

      return { content: lines.join('\n') }
    },

    requiresApproval(params: ToolCallParams): boolean {
      return params.input.commit === true
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,

    // Budget: typecheck and review are now agent-owned steps (run before
    // calling deliver_task), not internal stages. commit=false is a fast
    // ownership query; commit=true does file I/O + git.
    //
    // commit 预算 60s→180s（2026-07-21 事故）：多会话共享工作区（几十个外部
    // 改动文件）+ 并发 tsc/test 满载 CPU 时，所有权扫描 + claim 审计 + git
    // 操作 60s 跑不完 → 超时重试全灭 → 模型退回裸 git 提交 → 把并发会话的
    // 半成品 tracked 改动卷进提交、漏掉 untracked 依赖文件（损毁提交
    // 7b0c2936）。提交是终态动作，宁可慢不可断。
    timeoutMs: (params) => {
      if (params?.input?.commit !== true) return 60_000    // 门禁查询：ownership + cohesion + claim audit
      return 180_000                                       // commit：文件读写 + git 操作（满载机器留余量）
    },
  }
}
