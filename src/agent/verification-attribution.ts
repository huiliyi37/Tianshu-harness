/**
 * VerificationAttribution — 验证结果归因 (B1-4)
 *
 * 将验证结果（typecheck、test run 等）归因到：
 * - owned_failure   → 当前任务拥有的文件失败（我的责任）
 * - external_blocked → 外部因素阻塞（非我的责任）
 * - ambiguous       → 无法明确归因（需要进一步诊断）
 * - verified        → 全部通过
 *
 * 核心原则：不是所有失败都属于我。区分 owned / external / ambiguous
 * 是共享 worktree 下负责任协作的基础。
 *
 * HEARTH 兼容：归因结果可被 invariant verifier 消费（INV-5 drift 检测）。
 * Songline 兼容：归因状态是 obligation fulfillment 的信号。
 *
 * @module verification-attribution
 * @task B1-4
 */

import type { VerificationFailureKind, VerificationMetadata } from '../tools/types.js'
import type { OwnershipLedger } from './ownership-ledger.js'
import type { TaskLedgerEvent } from './task-ledger.js'

/**
 * Result of getEffectiveVerifications — deduplicates verification events
 * by (command, scope) key, keeping only the latest event per key.
 */
export interface EffectiveVerifications {
  /** Deduplicated verification metadata (only latest per key) */
  effective: VerificationMetadata[]
  /** Count of earlier failures that were superseded by later successes */
  supersededFailures: number
  /** Total raw event count before deduplication */
  totalRawCount: number
  /** Count of verifications dropped because their snapshotRef is stale
   *  (owned diff changed since the verification ran). */
  staleSnapshotDropped: number
}

/**
 * Normalize a verification command for key generation.
 * Strips common noise (extra whitespace, quotes) to group equivalent commands.
 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/["']/g, '').replace(/\s+/g, ' ').toLowerCase()
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractTestFiles(command: string): string[] {
  const files = new Set<string>()
  const matches = command.matchAll(/[^\s'"]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)/g)
  for (const match of matches) {
    const file = match[0]?.trim().replace(/^['"]|['"]$/g, '')
    if (file) files.add(file)
  }
  return [...files].sort()
}

function getMetaTargetFiles(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.targetFiles
  if (!Array.isArray(raw)) return []
  return raw.filter((f): f is string => typeof f === 'string' && f.length > 0).sort()
}

function runnerFamily(command: string): string {
  const normalized = normalizeCommand(command)
  if (
    normalized.startsWith('run_tests')
    || normalized.includes('tsx --test')
    || normalized.includes('node --test')
  ) {
    return 'node-test'
  }
  return normalized.split(' ')[0] ?? normalized
}

function isInvocationFailureMeta(status: TaskLedgerEvent['status'], meta: Record<string, unknown> | undefined): boolean {
  if (status !== 'failed') return false
  if (asString(meta?.errorClass) === 'timeout' || meta?.timedOut === true) return false
  return asNumber(meta?.exitCode, 1) !== 0
    && asNumber(meta?.passed, 0) === 0
    && asNumber(meta?.failed, 1) === 0
    && asNumber(meta?.skipped, 0) === 0
}

/** Commands whose runner is expected to print a test summary. Only for these
 *  does "non-zero exit + no counts at all" indicate the runner never reported.
 *  Deliberately narrow: bare `npm test` is excluded because the underlying
 *  runner is unknown, and a false positive here re-introduces exactly the
 *  misattribution this guard exists to prevent. */
const TEST_RUNNER_RE = /(?:^|\s|\/)(?:tsx\s+--test|node\s+--test|jest|vitest|mocha|pytest|ava|tap)\b/

function expectsTestCounts(command: string): boolean {
  const normalized = normalizeCommand(command)
  return normalized.startsWith('run_tests') || TEST_RUNNER_RE.test(normalized)
}

/** Failure classes that are affirmative evidence the command RAN and produced a
 *  genuine failure. When one of these is present, absent test counts mean the
 *  verification kind simply does not emit counts (typecheck / lint / build) —
 *  it must never be read as "the runner crashed, just re-run". */
const AFFIRMATIVE_CODE_FAILURE_CLASSES = new Set<string>([
  'type_error',
  'syntax_error',
  'assertion',
  'format_error',
  'module_resolution',
  'test_red',
])

function isAffirmativeCodeFailure(errorClass: string | undefined): boolean {
  return errorClass !== undefined && AFFIRMATIVE_CODE_FAILURE_CLASSES.has(errorClass)
}

/** Derive the failure kind from raw ledger facts. Explicit producer stamps win;
 *  otherwise positive evidence is required before claiming
 *  `tool_invocation_failure` (see expectsTestCounts). Absence of test counts is
 *  NOT evidence that nothing executed — typecheck / lint / build never emit them. */
function deriveFailureKind(
  command: string,
  status: TaskLedgerEvent['status'],
  meta: Record<string, unknown> | undefined,
): VerificationFailureKind | undefined {
  const rawKind = asString(meta?.failureKind)
  const errorClass = asString(meta?.errorClass)

  // Timeout first: it is neither a test failure nor an invocation failure, and
  // conflating it with either produces actively wrong advice ("just re-run").
  // `blockedReason` covers producers that classify before the ledger (run_tests).
  if (rawKind === 'timeout' || meta?.timedOut === true || errorClass === 'timeout'
    || asString(meta?.blockedReason) === 'timeout') return 'timeout'
  if (rawKind === 'tool_invocation_failure') return 'tool_invocation_failure'
  if (rawKind === 'test_failure') return 'test_failure'

  if (isAffirmativeCodeFailure(errorClass)) return 'test_failure'
  if (!expectsTestCounts(command)) {
    // This kind of command has no counts to parse. Its failure is real (or at
    // least unattributable) — never "nothing executed".
    return status === 'failed' ? 'test_failure' : undefined
  }
  if (isInvocationFailureMeta(status, meta)) return 'tool_invocation_failure'
  return undefined
}

function eventToVerificationMetadata(event: TaskLedgerEvent): VerificationMetadata {
  const scope = event.meta?.scope === 'full' ? 'full' as const : 'targeted' as const
  const status = (event.status ?? 'passed') as 'passed' | 'failed' | 'blocked'
  const command = event.command ?? 'unknown'
  const targetFiles = getMetaTargetFiles(event.meta)
  const resolvedCommand = asString(event.meta?.resolvedCommand)
  const recommendedCommand = asString(event.meta?.recommendedCommand)
  const snapshotRef = asString(event.meta?.snapshotRef)
  const phaseRaw = asString(event.meta?.verificationPhase)
  const verificationPhase = phaseRaw === 'isolated' || phaseRaw === 'integration' ? phaseRaw : undefined
  const failureKind = deriveFailureKind(command, status, event.meta)

  return {
    command,
    status,
    scope,
    exitCode: asNumber(event.meta?.exitCode, status === 'failed' ? 1 : 0),
    passed: asNumber(event.meta?.passed, status === 'passed' ? 1 : 0),
    failed: asNumber(event.meta?.failed, status === 'failed' ? 1 : 0),
    skipped: asNumber(event.meta?.skipped, 0),
    durationMs: asNumber(event.meta?.durationMs, 0),
    ...(failureKind ? { failureKind } : {}),
    ...(targetFiles.length > 0 ? { targetFiles } : {}),
    ...(resolvedCommand ? { resolvedCommand } : {}),
    ...(recommendedCommand ? { recommendedCommand } : {}),
    ...(snapshotRef ? { snapshotRef } : {}),
    ...(verificationPhase ? { verificationPhase } : {}),
  }
}

/**
 * Generate a stable deduplication key for a verification event.
 * Events with the same key are considered "same verification" for supersession.
 */
function verificationKey(event: TaskLedgerEvent): string {
  const command = event.command ?? 'unknown'
  const scope = event.meta?.scope === 'full' ? 'full' : 'targeted'
  const resolvedCommand = asString(event.meta?.resolvedCommand) ?? ''

  // meta.targetFiles (populated by tools like run_tests) is authoritative:
  // it contains the actual resolved test file paths, not the raw filter string.
  // Using it prevents key mismatch when the same tests are run with
  // different filter syntax (e.g. "volatile-snapshot.test" vs
  // "src/prompt/__tests__/volatile-snapshot.test.ts").
  const metaTargetFiles = getMetaTargetFiles(event.meta)
  const cmdTargetFiles = extractTestFiles(command)
  const resolvedTargetFiles = extractTestFiles(resolvedCommand)
  const targetFiles = metaTargetFiles.length > 0
    ? metaTargetFiles
    : [...cmdTargetFiles, ...resolvedTargetFiles]
  const uniqueTargetFiles = [...new Set(targetFiles)].sort()

  if (uniqueTargetFiles.length > 0) {
    return `tests::${scope}::${runnerFamily(`${command} ${resolvedCommand}`)}::${uniqueTargetFiles.join('|')}`
  }

  return `${normalizeCommand(command)}::${scope}`
}

/**
 * Deduplicate verification events by (command, scope) key.
 * Later events supersede earlier events with the same key.
 * Old failures that are superseded by later successes are counted
 * but excluded from the effective set.
 */
export function getEffectiveVerifications(
  events: ReadonlyArray<TaskLedgerEvent>,
  currentSnapshotRef?: string,
): EffectiveVerifications {
  const allVerificationEvents = events.filter(e => e.type === 'verification')

  // VSW supersession: a verification recorded under a snapshotRef that differs
  // from the current owned diff is provably stale — the tree it ran on no longer
  // matches reality. Drop it. Verifications without a snapshotRef (in-place /
  // legacy runs) are never dropped, preserving existing behavior.
  let staleSnapshotDropped = 0
  const verificationEvents = currentSnapshotRef
    ? allVerificationEvents.filter(e => {
        const ref = asString(e.meta?.snapshotRef)
        if (ref && ref !== currentSnapshotRef) {
          staleSnapshotDropped++
          return false
        }
        return true
      })
    : allVerificationEvents

  // Process in chronological order (events are already sorted by timestamp)
  const keyMap = new Map<string, { event: TaskLedgerEvent; index: number }>()
  let supersededFailures = 0

  for (let i = 0; i < verificationEvents.length; i++) {
    const event = verificationEvents[i]!
    const key = verificationKey(event)

    const existing = keyMap.get(key)
    if (existing) {
      // Later event supersedes earlier — if earlier was failed and later is passed, count it
      if (existing.event.status === 'failed' && event.status === 'passed') {
        supersededFailures++
      }
    }
    keyMap.set(key, { event, index: i })
  }

  // Convert to VerificationMetadata
  const effective: VerificationMetadata[] = []
  for (const { event } of keyMap.values()) {
    effective.push(eventToVerificationMetadata(event))
  }

  return { effective, supersededFailures, totalRawCount: allVerificationEvents.length, staleSnapshotDropped }
}

export type AttributionClass =
  | 'verified'
  | 'owned_failure'
  | 'external_blocked'
  | 'no_test_infra'  // project has no test framework / no test files
  | 'tool_invocation_failure'
  /** The verification command exceeded its time budget. Distinct from both a
   *  test failure and an invocation failure: nothing was learned about the
   *  code, and the underlying process may still be running. Never reported as
   *  "not a code failure — just re-run". */
  | 'verification_timeout'
  | 'unattributed_failure'
  | 'unverified'
  /** Phase B (integration) failure: owned diff is correct in isolation but
   *  conflicts with concurrent changes on current HEAD. Not this session's
   *  fault → advisory (rebase/coordinate), never blocking. */
  | 'integration_conflict'
  /** Owned edits have Meridian-impacted tests (blast radius) that exist on
   *  disk but were never covered by any passed verification. The targeted
   *  runs that did pass don't reach the changed module's dependents —
   *  regression risk. YELLOW at gate; RED on deliver_task(commit=true). */
  | 'module_unverified'

// ─── Impacted-test coverage (W1 回归防线) ──────────────────────────────────
// Meridian blast radius (EvidenceTracker.impactedTests) lists tests that
// transitively import the files this session modified. "有任意 passed 验证"
// 不等于"波及面被验证过"——引入回归是评测暴露的最大失败类。
//
// 假阳性防御（天权评审）：Meridian import graph 是静态分析，impactedTests
// 可能包含已删除/重命名的测试文件。existsFn 过滤后归入 uncoverable，只留痕
// 不触发升级；仅"存在且从未被 passed 验证覆盖"的测试才计入 uncovered。

export interface ImpactedTestCoverage {
  /** Tests that exist on disk but were never covered by a passed verification. */
  uncovered: string[]
  /** Tests from the impact set that no longer exist (deleted/renamed) — recorded, never blocking. */
  uncoverable: string[]
}

function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Suffix-tolerant path equality: 'src/a/__tests__/b.test.ts' matches
 *  'a/__tests__/b.test.ts' and vice versa (verification target files may be
 *  recorded relative to different roots than Meridian paths). */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Assess which Meridian-impacted tests were actually covered by passed
 * verifications. Pure function — filesystem access is injected via existsFn.
 *
 * Coverage rules:
 * - any passed full-scope verification covers everything → uncovered = []
 * - a passed targeted verification covers its targetFiles (or test files
 *   extractable from command/resolvedCommand)
 */
export function assessImpactedTestCoverage(
  impactedTests: readonly string[],
  verifications: readonly VerificationMetadata[],
  existsFn: (path: string) => boolean,
): ImpactedTestCoverage {
  if (impactedTests.length === 0) return { uncovered: [], uncoverable: [] }

  const passed = verifications.filter(v => v.status === 'passed')
  if (passed.some(v => v.scope === 'full')) return { uncovered: [], uncoverable: [] }

  const coveredFiles: string[] = []
  for (const v of passed) {
    const targets = v.targetFiles && v.targetFiles.length > 0
      ? v.targetFiles
      : [...extractTestFiles(v.command), ...extractTestFiles(v.resolvedCommand ?? '')]
    for (const t of targets) coveredFiles.push(normalizePathForMatch(t))
  }

  const uncovered: string[] = []
  const uncoverable: string[] = []
  for (const test of [...new Set(impactedTests)].sort()) {
    if (!existsFn(test)) {
      uncoverable.push(test)
      continue
    }
    const normalized = normalizePathForMatch(test)
    if (!coveredFiles.some(c => pathsMatch(normalized, c))) {
      uncovered.push(test)
    }
  }
  return { uncovered, uncoverable }
}

export interface AttributionResult {
  attribution: AttributionClass
  /** Is this failure blocking delivery? */
  isBlocking: boolean
  /** Human-readable explanation */
  reason: string
  /** The source verification metadata */
  source: VerificationMetadata
}

export interface VerificationAttribution {
  attribute(result: VerificationMetadata): AttributionResult
  getAggregateAttribution(results: VerificationMetadata[]): AttributionResult
}

/** Is this verification a case of "the runner never executed"?
 *
 *  Only positive evidence counts. Historical bug (fixed 2026-09-22): this
 *  inferred non-execution from *absent* test counts, so any failing typecheck /
 *  lint / build (which never emit counts) was reported to the model as
 *  "a tool invocation issue — not a code failure", and a 7-minute timeout was
 *  reported the same way. See docs/analysis/2026-09-22-session-retrospective.md. */
export function isInvocationFailure(result: VerificationMetadata): boolean {
  // A timeout is its own class — never "the runner crashed, just re-run".
  if (result.failureKind === 'timeout') return false
  // Producer-stamped kinds are authoritative.
  if (result.failureKind === 'tool_invocation_failure') return true
  if (result.failureKind === 'test_failure') return false
  return result.status === 'failed'
    && result.exitCode !== 0
    && result.passed === 0
    && result.failed === 0
    && result.skipped === 0
}

export function createVerificationAttribution(_opts: {
  ownership: OwnershipLedger
}): VerificationAttribution {
  function attribute(result: VerificationMetadata): AttributionResult {
    // Passed → verified
    if (result.status === 'passed') {
      return {
        attribution: 'verified',
        isBlocking: false,
        reason: `Verification passed: ${result.command}`,
        source: result,
      }
    }

    // Blocked → determine root cause for differentiated feedback
    if (result.status === 'blocked') {
      const blockedReason = result.blockedReason
      // Test infrastructure missing — distinct from transient external blocks
      if (blockedReason === 'no_test_framework' || blockedReason === 'no_tests_found') {
        const userGuidance = result.userGuidance ?? '项目缺少可自动检测的测试框架。'
        return {
          attribution: 'no_test_infra',
          isBlocking: false,
          reason: `Verification infrastructure missing (${blockedReason}): ${result.command}. ${userGuidance}`,
          source: result,
        }
      }
      return {
        attribution: 'external_blocked',
        isBlocking: false,
        reason: `Verification blocked by external factors: ${result.command} (exit ${result.exitCode})`,
        source: result,
      }
    }

    // Failed — determine attribution
    if (result.status === 'failed') {
      // Timeout: the command exceeded its budget. Distinct from a crash — the
      // underlying process may still be running and mutating the workspace, so
      // the honest advice is "check state first", not "just re-run". Checked
      // before every other failure attribution so it can never be masked.
      if (result.failureKind === 'timeout') {
        return {
          attribution: 'verification_timeout',
          isBlocking: true,
          reason: `Verification timed out: ${result.command}. The command exceeded its time budget and produced no result — the underlying process may still be running and writing files. Inspect the current workspace/test state before rerunning, and do not treat the code as broken on this evidence alone.`,
          source: result,
        }
      }

      // Phase B (integration) failure on current HEAD: the owned diff already
      // passed in isolation (Phase A), so this is a concurrent-change conflict,
      // not an owned defect. Advisory only — never blocks delivery.
      if (result.verificationPhase === 'integration') {
        return {
          attribution: 'integration_conflict',
          isBlocking: false,
          reason: `Integration verification failed on current HEAD: ${result.command} — ${result.failed} test(s) failed. The owned diff passed in isolation; this is a concurrent-change conflict. Rebase/coordinate before merging; delivery is not blocked.`,
          source: result,
        }
      }

      if (result.failureKind === 'tool_invocation_failure' || isInvocationFailure(result)) {
        return {
          attribution: 'tool_invocation_failure',
          isBlocking: true,
          reason: `Verification invocation failed: ${result.command}. No tests were executed; rerun with the repo recommended command.`,
          source: result,
        }
      }

      // Targeted test: scope is narrow, likely owned
      if (result.scope === 'targeted') {
        return {
          attribution: 'owned_failure',
          isBlocking: true,
          reason: `Targeted verification failed: ${result.command} — ${result.failed} test(s) failed`,
          source: result,
        }
      }

      // Full test without failure-file attribution is a caveat, not an owned blocker.
      return {
        attribution: 'unattributed_failure',
        isBlocking: false,
        reason: `Full-scope verification failed: ${result.command} — ${result.failed} test(s) failed. Attribution to owned vs external files is unresolved.`,
        source: result,
      }
    }

    // Fallback
    return {
      attribution: 'unverified',
      isBlocking: true,
      reason: `Unknown verification status for: ${result.command}`,
      source: result,
    }
  }

  function getAggregateAttribution(results: VerificationMetadata[]): AttributionResult {
    if (results.length === 0) {
      return {
        attribution: 'unverified',
        isBlocking: true,
        reason: 'No verifications have been run.',
        source: {
          command: '(none)',
          status: 'blocked',
          scope: 'full',
          exitCode: -1,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
        },
      }
    }

    const attributions = results.map(r => attribute(r))

    // Priority: owned_failure > verification_timeout > tool_invocation_failure
    //           > no_test_infra > unattributed_failure > external_blocked > verified
    const hasOwnedFailure = attributions.some(a => a.attribution === 'owned_failure')
    if (hasOwnedFailure) {
      const first = attributions.find(a => a.attribution === 'owned_failure')!
      return {
        attribution: 'owned_failure',
        isBlocking: true,
        reason: `Owned verification failure: ${first.source.command}`,
        source: first.source,
      }
    }

    const hasVerificationTimeout = attributions.some(a => a.attribution === 'verification_timeout')
    if (hasVerificationTimeout) {
      const first = attributions.find(a => a.attribution === 'verification_timeout')!
      return {
        attribution: 'verification_timeout',
        isBlocking: true,
        reason: first.reason,
        source: first.source,
      }
    }

    const hasInvocationFailure = attributions.some(a => a.attribution === 'tool_invocation_failure')
    if (hasInvocationFailure) {
      const first = attributions.find(a => a.attribution === 'tool_invocation_failure')!
      return {
        attribution: 'tool_invocation_failure',
        isBlocking: true,
        reason: `Verification invocation failure: ${first.source.command}`,
        source: first.source,
      }
    }

    const hasNoTestInfra = attributions.some(a => a.attribution === 'no_test_infra')
    if (hasNoTestInfra) {
      const first = attributions.find(a => a.attribution === 'no_test_infra')!
      return {
        attribution: 'no_test_infra',
        isBlocking: false,
        reason: `Project test infrastructure missing: ${first.source.command}. ${first.source.userGuidance ?? ''}`,
        source: first.source,
      }
    }

    const hasUnattributedFailure = attributions.some(a => a.attribution === 'unattributed_failure')
    if (hasUnattributedFailure) {
      const first = attributions.find(a => a.attribution === 'unattributed_failure')!
      return {
        attribution: 'unattributed_failure',
        isBlocking: false,
        reason: `Full-suite verification failed without owned-file attribution: ${first.source.command}. Treat as delivery caveat until diagnosed.`,
        source: first.source,
      }
    }

    const hasExternalBlocked = attributions.some(a => a.attribution === 'external_blocked')
    if (hasExternalBlocked) {
      const first = attributions.find(a => a.attribution === 'external_blocked')!
      return {
        attribution: 'external_blocked',
        isBlocking: false,
        reason: `Verification blocked by external factors: ${first.source.command}`,
        source: first.source,
      }
    }

    // Phase B integration conflict: owned diff verified in isolation but clashes
    // with concurrent HEAD. Advisory — surfaced but non-blocking.
    const hasIntegrationConflict = attributions.some(a => a.attribution === 'integration_conflict')
    if (hasIntegrationConflict) {
      const first = attributions.find(a => a.attribution === 'integration_conflict')!
      return {
        attribution: 'integration_conflict',
        isBlocking: false,
        reason: `Integration conflict on current HEAD: ${first.source.command}. Owned changes passed in isolation; rebase/coordinate before merging. Delivery not blocked.`,
        source: first.source,
      }
    }

    // All passed
    return {
      attribution: 'verified',
      isBlocking: false,
      reason: `${results.length} verification(s) passed.`,
      source: results[0]!,
    }
  }

  return { attribute, getAggregateAttribution }
}
