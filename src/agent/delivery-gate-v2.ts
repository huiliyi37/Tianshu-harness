/**
 * DeliveryGate v2 — 归因感知交付门 (B1-7)
 *
 * 基于 TaskLedger + OwnershipLedger + VerificationAttribution，
 * 生成结构化的交付门状态。使用 GREEN/YELLOW/RED 三态，对齐
 * Stable-State Regression Protocol 的状态机。
 *
 * GREEN  → 稳定态：owned files verified，可交付
 * YELLOW → 不确定态：external blockers，但 owned files verified，可带条件交付
 * RED    → 阻断态：owned failures 或 unverified owned files，禁止交付
 *
 * HEARTH 兼容：交付报告可作为 cycle_close 的证据沉积。
 * Songline 兼容：交付状态是 obligation fulfillment 的生态信号。
 *
 * @module delivery-gate-v2
 * @task B1-7
 */

import { spawnGitSync } from '../tools/spawn-git.js'
import type { TaskLedger } from './task-ledger.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { VerificationAttribution, AttributionClass } from './verification-attribution.js'
import { getEffectiveVerifications, assessImpactedTestCoverage, isInvocationFailure } from './verification-attribution.js'
import { summarizeOwnershipHealth } from './ownership-health.js'
import type { VerificationMetadata } from '../tools/types.js'

// ─── External-file noise filtering (C-fix, session 803d897d) ───────────────
// 67 untracked .test-tmp files drowned the GREEN/YELLOW signal in every
// delivery report. External files from junk directories are noise, not
// blockers — filter them from display and summarize the count.

const JUNK_PATH_PREFIXES = [
  '.test-tmp/',
  '.rivet/',
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  'tmp/',
]

export function isJunkExternalPath(file: string): boolean {
  return JUNK_PATH_PREFIXES.some(prefix => file.startsWith(prefix))
}

/** Files matched by .gitignore (batched `git check-ignore`). Fails open to []. */
function gitIgnoredSubset(files: string[], cwd: string): Set<string> {
  if (files.length === 0) return new Set()
  try {
    const r = spawnGitSync(['check-ignore', '--stdin'], {
      cwd,
      input: files.join('\n'),
      encoding: 'utf-8',
      timeout: 5000,
    })
    // exit 0: some ignored; exit 1: none ignored; other: error → fail open
    if (r.status !== 0 && r.status !== 1) return new Set()
    return new Set(r.stdout.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

export interface ExternalNoiseSplit {
  /** Signal-bearing external files, in original order. */
  files: string[]
  /** Count of filtered junk/gitignored paths. */
  noiseCount: number
}

/**
 * Split external files into signal vs noise (junk dirs + gitignored paths).
 * cwd is used for the gitignore check; omit to use prefix rules only.
 */
export function filterExternalNoise(files: string[], cwd?: string): ExternalNoiseSplit {
  const prefixKept = files.filter(f => !isJunkExternalPath(f))
  const ignored = cwd ? gitIgnoredSubset(prefixKept, cwd) : new Set<string>()
  const kept = prefixKept.filter(f => !ignored.has(f))
  return { files: kept, noiseCount: files.length - kept.length }
}

export type GateState = 'GREEN' | 'YELLOW' | 'RED'

export interface DeliveryGateResult {
  state: GateState
  canDeliver: boolean
  isBlocked: boolean
  reason?: string
  blockingReason?: string
  ownedFileCount: number
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes — these were fixed. */
  supersededFailures: number
  /** Count of verifications dropped because their snapshotRef is stale
   *  (owned diff changed since they ran — ran on outdated code). */
  staleSnapshotDropped: number
  latestVerificationTotals?: { passed: number; failed: number; skipped: number; command: string }
  /** @deprecated use supersededFailures instead — renamed for semantic clarity. */
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  /** The verification attribution class that caused this gate state.
   *  Used by deliver_task to decide mechanical-change bypass. */
  attributionClass?: AttributionClass
  /** W1 回归防线: Meridian-impacted tests that exist but were never covered
   *  by a passed verification. Present when attributionClass === 'module_unverified'. */
  uncoveredImpactedTests?: string[]
  /** Impacted tests that no longer exist on disk (deleted/renamed) — recorded
   *  for the report, never blocking. */
  uncoverableImpactedTests?: string[]
}

export interface DeliveryReport {
  taskId: string
  state: GateState
  canDeliver: boolean
  ownedFiles: string[]
  ownedFileCount: number
  coOwnedFiles: string[]
  coOwnedFileCount: number
  historicalOwnedFiles: string[]
  historicalOwnedFileCount: number
  externalFiles: string[]
  externalFileCount: number
  verificationCount: number
  /** Count of earlier failures superseded by later successes — these were fixed. */
  supersededFailures: number
  /** Count of verifications dropped because their snapshotRef is stale. */
  staleSnapshotDropped: number
  /** Latest verification pass/fail/skipped totals — for "声明即实测" echo in deliver_task output.
   *  Agents copy these numbers into delivery reports instead of guessing from memory. */
  latestVerificationTotals?: { passed: number; failed: number; skipped: number; command: string }
  /** @deprecated use supersededFailures instead — renamed for semantic clarity. */
  staleFailureCandidates: number
  toolInvocationFailureCandidates: string[]
  currentBlockingFailure?: string
  shortestNextStep?: string
  blockingReason?: string
  /** The verification attribution class causing this gate state.
   *  Used by deliver_task to decide mechanical-change bypass. */
  attributionClass?: AttributionClass
  /** W1 回归防线: impacted tests never covered by a passed verification. */
  uncoveredImpactedTests?: string[]
  /** Impacted tests that no longer exist on disk (deleted/renamed). */
  uncoverableImpactedTests?: string[]
  /** Full attribution result for diagnostics */
  attributionSummary: string
}

/** W1 回归防线: inputs for impacted-test coverage assessment. Both provided by
 *  the caller (deliver_task) — the gate itself stays filesystem-free. */
export interface ModuleCoverageInput {
  /** Meridian blast radius tests (EvidenceTracker.impactedTests). */
  impactedTests: readonly string[]
  /** Existence probe — resolves relative paths against the session cwd. */
  testExists: (path: string) => boolean
}

export interface DeliveryGateV2 {
  /** Assess delivery readiness, optionally with external verification metadata,
   *  current dirty files, and the current VSW snapshotRef (drops stale snapshot
   *  verifications when provided). */
  assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryGateResult
  /** Full structured report suitable for cycle_close deposit */
  getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryReport
}

/**
 * Track 3 门禁合一：收敛检测 L2+ 时基于权威门禁状态生成结束/修复指引。
 * GREEN → 指示输出最终摘要结束回合；RED → 指示阻断项与最短下一步；
 * YELLOW → 可带条件交付。返回的字符串作为 system-reminder 注入。
 */
export function buildGateConvergenceHint(
  gate: Pick<DeliveryGateResult, 'state' | 'reason' | 'blockingReason' | 'shortestNextStep' | 'attributionClass'>,
  depthLayer?: import('../context/task-contract.js').TaskDepthLayer,
): string {
  const depthSuffix = depthLayer && depthLayer !== 'unit'
    ? `\n[depth=${depthLayer}] 验证必须覆盖跨模块边界，不仅仅是单函数行为。`
    : ''
  if (gate.state === 'GREEN') {
    return '交付门禁 GREEN：所有 owned 文件已验证。请输出最终摘要并结束回合，不再调用工具。' + depthSuffix
  }
  if (gate.state === 'RED') {
    const lines = [`交付门禁 RED：${gate.blockingReason ?? gate.reason ?? 'owned 文件存在未验证或失败项。'}`]
    lines.push('请先解决阻断项再继续；若无法解决，明确报告阻断原因后结束回合。')
    if (gate.shortestNextStep) lines.push(`方向：${gate.shortestNextStep}`)
    return lines.join('\n') + depthSuffix
  }
  // YELLOW — differentiate no_test_infra from transient external blocks
  if (gate.attributionClass === 'module_unverified') {
    return `交付门禁 YELLOW（波及面未验证）：${gate.reason ?? '改动波及的测试从未被任何 passed 验证覆盖。'}\n引入回归是最常见的交付失败——请运行上述受波及测试（或一次 full-scope 验证）后再交付；commit=true 会被硬拦。` + depthSuffix
  }
  if (gate.attributionClass === 'no_test_infra') {
    return `交付门禁 YELLOW（测试基础设施缺失）：${gate.reason ?? '项目无可自动检测的测试框架。'}\n\n不要反复重试 run_tests——它每次都会以同样原因受阻。应向用户报告具体缺失项，并询问是否需要协助搭建测试框架，或用 bash 运行替代验证后交付。` + depthSuffix
  }
  return `交付门禁 YELLOW：${gate.reason ?? '存在外部阻塞，owned 文件已验证。'}\n可带条件交付：输出最终摘要并明确标注 caveat，然后结束回合。${depthSuffix}`
}

export function createDeliveryGateV2(opts: {
  taskLedger: TaskLedger
  ownership: OwnershipLedger
  attribution: VerificationAttribution
}): DeliveryGateV2 {
  const { taskLedger, ownership, attribution } = opts

  const emptyDiagnostics = {
    supersededFailures: 0,
    staleFailureCandidates: 0,
    staleSnapshotDropped: 0,
    toolInvocationFailureCandidates: [] as string[],
  }

  // Single source of truth — the gate used to carry its own copy of this
  // predicate, which drifted from the attribution module's semantics.
  function isToolInvocationFailure(v: VerificationMetadata): boolean {
    return isInvocationFailure(v)
  }

  function verificationDiagnostics(verifications: VerificationMetadata[], supersededFailures: number, staleSnapshotDropped: number): Pick<DeliveryGateResult, 'supersededFailures' | 'staleFailureCandidates' | 'staleSnapshotDropped' | 'toolInvocationFailureCandidates' | 'shortestNextStep'> {
    const invocationFailures = verifications.filter(isToolInvocationFailure)
    const shortestNextStep = invocationFailures
      .map(v => v.recommendedCommand ?? v.resolvedCommand)
      .find((cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0)
    return {
      supersededFailures,
      staleFailureCandidates: supersededFailures,
      staleSnapshotDropped,
      toolInvocationFailureCandidates: invocationFailures.map(v => v.command),
      ...(shortestNextStep ? { shortestNextStep } : {}),
    }
  }

  function getGateFiles(currentDirtyFiles?: string[]): {
    ownedFilesForGate: string[]
    coOwnedFiles: string[]
    historicalOwnedFiles: string[]
    externalFiles: string[]
  } {
    const allOwnedFiles = ownership.getOwnedFiles()
    const allCoOwnedFiles = ownership.getCoOwnedFiles()
    const allExternalFiles = ownership.getExternalFiles(currentDirtyFiles)
    if (!currentDirtyFiles) {
      return {
        ownedFilesForGate: allOwnedFiles,
        coOwnedFiles: allCoOwnedFiles,
        historicalOwnedFiles: [],
        externalFiles: allExternalFiles,
      }
    }

    const currentDirty = new Set(currentDirtyFiles)
    const ownedFilesForGate = allOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const coOwnedFiles = allCoOwnedFiles.filter(f => currentDirty.has(f)).sort()
    const historicalOwnedFiles = allOwnedFiles.filter(f => !currentDirty.has(f)).sort()
    const externalFiles = allExternalFiles.filter(f => currentDirty.has(f)).sort()
    return { ownedFilesForGate, coOwnedFiles, historicalOwnedFiles, externalFiles }
  }

  function assess(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryGateResult {
    const { ownedFilesForGate: ownedFiles, coOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)

    // Check ownership health for unclassified dirty files
    if (currentDirtyFiles) {
      const health = summarizeOwnershipHealth({
        ownedFiles,
        coOwnedFiles,
        externalFiles,
        dirtyFiles: currentDirtyFiles,
      })
      if (health.warningLines.length > 0) {
        // Unclassified dirty files → YELLOW with caveat
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${health.warningLines.length} dirty file(s) have no ownership classification. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: externalVerifications.length,
          ...emptyDiagnostics,
        }
      }
    }

    // Use effective verifications (deduplicated by supersession + VSW staleness)
    const rawVerifications = taskLedger.getVerifications()
    const { effective: ownedVerifications, supersededFailures, staleSnapshotDropped } = getEffectiveVerifications(rawVerifications, currentSnapshotRef)

    // Combine owned + external verifications for full picture
    const allVerifications = [
      ...ownedVerifications,
      ...externalVerifications,
    ]
    const diagnostics = verificationDiagnostics(allVerifications, supersededFailures, staleSnapshotDropped)

    // 层 1a: latest verification totals for "声明即实测" echo
    const _lv = allVerifications.length > 0 ? allVerifications[allVerifications.length - 1] : undefined
    const latestVerificationTotals = _lv
      ? { passed: _lv.passed ?? 0, failed: _lv.failed ?? 0, skipped: _lv.skipped ?? 0, command: _lv.command }
      : undefined

    // Nothing to deliver
    if (ownedFiles.length === 0) {
      const hasExternals = externalFiles.length > 0
      return {
        state: 'GREEN',
        canDeliver: true,
        isBlocked: false,
        reason: hasExternals
          ? `No owned files modified. ${externalFiles.length} external dirty file(s) present but excluded from delivery scope.`
          : 'No file modifications.',
        ownedFileCount: 0,
        externalFileCount: externalFiles.length,
        verificationCount: allVerifications.length,
        ...diagnostics,
      latestVerificationTotals,
      }
    }

    // Check attribution
    const aggregate = attribution.getAggregateAttribution(allVerifications)

    switch (aggregate.attribution) {
      case 'verified': {
        // W1 回归防线: "有 passed 验证" ≠ "改动波及面被验证过"。Meridian 波及
        // 的测试若存在于磁盘且从未被任何 passed 验证覆盖 → 降为 YELLOW
        // (module_unverified)。deliver_task(commit=true) 时升 RED 硬拦。
        if (moduleCoverage && moduleCoverage.impactedTests.length > 0) {
          const coverage = assessImpactedTestCoverage(
            moduleCoverage.impactedTests,
            allVerifications,
            moduleCoverage.testExists,
          )
          if (coverage.uncovered.length > 0) {
            const sample = coverage.uncovered.slice(0, 5)
            return {
              state: 'YELLOW',
              canDeliver: true,
              isBlocked: false,
              reason: `${ownedFiles.length} owned file(s) have passed verifications, but ${coverage.uncovered.length} impacted test file(s) (Meridian blast radius) were never covered by any passed run: ${sample.join(', ')}${coverage.uncovered.length > sample.length ? ` (+${coverage.uncovered.length - sample.length} more)` : ''}. Regression risk — run these tests or a full-scope verification.`,
              ownedFileCount: ownedFiles.length,
              externalFileCount: externalFiles.length,
              verificationCount: allVerifications.length,
              ...diagnostics,
              latestVerificationTotals,
              attributionClass: 'module_unverified',
              uncoveredImpactedTests: coverage.uncovered,
              ...(coverage.uncoverable.length > 0 ? { uncoverableImpactedTests: coverage.uncoverable } : {}),
            }
          }
          if (coverage.uncoverable.length > 0) {
            // 留痕不阻断：已删/重命名的测试只出现在报告里
            return {
              state: 'GREEN',
              canDeliver: true,
              isBlocked: false,
              reason: `${ownedFiles.length} owned file(s) verified. Ready to deliver. (${coverage.uncoverable.length} impacted test path(s) no longer exist — deleted/renamed, excluded from coverage check.)`,
              ownedFileCount: ownedFiles.length,
              externalFileCount: externalFiles.length,
              verificationCount: allVerifications.length,
              ...diagnostics,
              latestVerificationTotals,
              uncoverableImpactedTests: coverage.uncoverable,
            }
          }
        }
        return {
          state: 'GREEN',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified. Ready to deliver.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }
      }

      case 'external_blocked':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified, but external verification blocked: ${aggregate.reason}. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'no_test_infra':
        // Project has no test framework / test files — not a transient error,
        // but a structural gap. YELLOW: deliverable with specific guidance to
        // the user about setting up testing. Do NOT keep retrying run_tests —
        // it will keep failing the same way.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `测试基础设施缺失：${aggregate.reason}\n\n该项目无可自动检测的测试框架或测试文件。run_tests 不会自动生效，继续重试不会改变结果。请向用户说明具体缺失项和下一步。`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          attributionClass: 'no_test_infra',
        }

      case 'owned_failure':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: aggregate.reason,
          blockingReason: `Owned verification failed. Fix failures before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          currentBlockingFailure: aggregate.reason,
          attributionClass: 'owned_failure',
        }

      case 'verification_timeout':
        // Timeout means we learned nothing about the code, and the underlying
        // process may still be running/mutating the workspace. Non-blocking for
        // delivery (same safety posture as before) but with honest guidance —
        // the previous text told the model this was "not a code failure, re-run",
        // which is wrong on both counts.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${aggregate.reason}\n\nNothing was verified by this run. Do not assume the code is broken, and do not blindly re-run: confirm the workspace is settled (git status / no orphaned process still writing) before re-verifying with a bounded command. You may still deliver if you have independently verified correctness.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          attributionClass: 'verification_timeout',
        }

      case 'tool_invocation_failure':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${aggregate.reason}\n\nThis is a tool invocation issue — the runner did not execute. Re-run with the recommended command. You may still deliver if you have independently verified correctness.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'unattributed_failure':
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) are not directly implicated, but verification has unresolved full-suite failure: ${aggregate.reason}. Deliverable with caveat.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'integration_conflict':
        // Phase B failed on current HEAD but the owned diff passed in isolation
        // (Phase A). Concurrent-change conflict — advisory, not this session's
        // fault. Deliverable with a rebase/coordinate caveat.
        return {
          state: 'YELLOW',
          canDeliver: true,
          isBlocked: false,
          reason: `${ownedFiles.length} owned file(s) verified in isolation, but integration on current HEAD conflicts: ${aggregate.reason}`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
        }

      case 'unverified':
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: `${ownedFiles.length} owned file(s) modified but unverified.`,
          blockingReason: `Run verification before delivery.`,
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          currentBlockingFailure: `${ownedFiles.length} owned file(s) modified but unverified.`,
          attributionClass: 'unverified',
        }

      default:
        return {
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          reason: 'Unknown verification state.',
          ownedFileCount: ownedFiles.length,
          externalFileCount: externalFiles.length,
          verificationCount: allVerifications.length,
          ...diagnostics,
      latestVerificationTotals,
          currentBlockingFailure: 'Unknown verification state.',
          attributionClass: 'unverified',
        }
    }
  }

  function getReport(externalVerifications: VerificationMetadata[], currentDirtyFiles?: string[], currentSnapshotRef?: string, moduleCoverage?: ModuleCoverageInput): DeliveryReport {
    const result = assess(externalVerifications, currentDirtyFiles, currentSnapshotRef, moduleCoverage)
    const { ownedFilesForGate, coOwnedFiles, historicalOwnedFiles, externalFiles } = getGateFiles(currentDirtyFiles)
    return {
      taskId: taskLedger.getTaskId(),
      state: result.state,
      canDeliver: result.canDeliver,
      ownedFiles: ownedFilesForGate,
      ownedFileCount: result.ownedFileCount,
      coOwnedFiles,
      coOwnedFileCount: coOwnedFiles.length,
      historicalOwnedFiles,
      historicalOwnedFileCount: historicalOwnedFiles.length,
      externalFiles,
      externalFileCount: result.externalFileCount,
      verificationCount: result.verificationCount,
      supersededFailures: result.supersededFailures,
      staleSnapshotDropped: result.staleSnapshotDropped,
      latestVerificationTotals: result.latestVerificationTotals,
      staleFailureCandidates: result.staleFailureCandidates,
      toolInvocationFailureCandidates: result.toolInvocationFailureCandidates,
      currentBlockingFailure: result.currentBlockingFailure,
      shortestNextStep: result.shortestNextStep,
      blockingReason: result.blockingReason,
      attributionClass: result.attributionClass,
      uncoveredImpactedTests: result.uncoveredImpactedTests,
      uncoverableImpactedTests: result.uncoverableImpactedTests,
      attributionSummary: result.reason ?? 'No attribution available.',
    }
  }

  return { assess, getReport }
}
