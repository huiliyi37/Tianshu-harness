import { realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { readCompletionCoverage } from '../tools/test-completion.js'
import { hasIsolatedComparison } from './verification-comparison.js'
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
  /** Count of verifications dropped on the workspace-fingerprint dimension
   *  (meta.stale === true). This counts ALL stale drops; typical causes fall
   *  into two classes:
   *  (a) 仓内再编辑 — an in-repo owned/written file changed after the verification
   *      ran (file_write 判废或指纹比对失配)。正常开发循环里会频繁非零，是良性多数；
   *  (b) 指纹不可计算 — no comparable fingerprint could be produced at all
   *      (归属/写入集含敏感路径、非 git 工作区，或 4251eea67 之前台账里 owned 路径
   *      在仓库根之外的旧毒化形态)。
   *  Distinct from snapshotRef staleness ({@link staleSnapshotDropped}) — a
   *  different evidence dimension. 越界类病因的修复指引锚点见
   *  DeliveryGateResult.outOfRootFingerprintPaths。 */
  staleFingerprintDropped: number
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

function verificationKind(meta: Record<string, unknown> | undefined): VerificationMetadata['kind'] {
  const kind = meta?.kind
  return kind === 'test' || kind === 'typecheck' || kind === 'lint' || kind === 'build' || kind === 'check'
    ? kind : undefined
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
  const scope = event.meta?.scope === 'full' ? 'full' as const : event.meta?.scope === 'unknown' ? 'unknown' as const : 'targeted' as const
  const status = (event.status ?? 'passed') as 'passed' | 'failed' | 'blocked'
  const command = event.command ?? 'unknown'
  const targetFiles = getMetaTargetFiles(event.meta)
  const resolvedCommand = asString(event.meta?.resolvedCommand)
  const recommendedCommand = asString(event.meta?.recommendedCommand)
  const snapshotRef = asString(event.meta?.snapshotRef)
  const phaseRaw = asString(event.meta?.verificationPhase)
  const verificationPhase = phaseRaw === 'isolated' || phaseRaw === 'integration' ? phaseRaw : undefined
  const failureKind = deriveFailureKind(command, status, event.meta)
  // Preserve structured producer facts through the ledger boundary.
  const blockedReasonRaw = asString(event.meta?.blockedReason)
  const blockedReason = blockedReasonRaw === 'no_test_framework' || blockedReasonRaw === 'no_tests_found'
    || blockedReasonRaw === 'filter_unresolved' || blockedReasonRaw === 'unknown_runner'
    || blockedReasonRaw === 'timeout' || blockedReasonRaw === 'invocation_failure'
    ? blockedReasonRaw : undefined

  return {
    command,
    status,
    scope,
    kind: verificationKind(event.meta),
    ...(readCompletionCoverage(event.meta?.coverage) ? { coverage: readCompletionCoverage(event.meta?.coverage) } : {}),
    exitCode: asNumber(event.meta?.exitCode, status === 'failed' ? 1 : 0),
    passed: typeof event.meta?.passed === 'number' ? event.meta.passed : undefined,
    failed: typeof event.meta?.failed === 'number' ? event.meta.failed : undefined,
    skipped: typeof event.meta?.skipped === 'number' ? event.meta.skipped : undefined,
    durationMs: asNumber(event.meta?.durationMs, 0),
    ...(failureKind ? { failureKind } : {}),
    ...(asString(event.meta?.userGuidance) ? { userGuidance: asString(event.meta?.userGuidance) } : {}),
    ...(targetFiles.length > 0 ? { targetFiles } : {}),
    ...(resolvedCommand ? { resolvedCommand } : {}),
    ...(recommendedCommand ? { recommendedCommand } : {}),
    ...(snapshotRef ? { snapshotRef } : {}),
    ...(verificationPhase ? { verificationPhase } : {}),
    ...(typeof event.meta?.isolatedPassed === 'boolean' ? { isolatedPassed: event.meta.isolatedPassed } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(typeof event.meta?.countsReliable === 'boolean' ? { countsReliable: event.meta.countsReliable } : {}),
    ...(asString(event.meta?.executionId) ? { executionId: asString(event.meta?.executionId) } : {}),
    ...(asString(event.meta?.comparisonId) ? { comparisonId: asString(event.meta?.comparisonId) } : {}),
    timestamp: asNumber(event.meta?.timestamp, event.timestamp),
  }
}

/**
 * Generate a stable deduplication key for a verification event.
 * Events with the same key are considered "same verification" for supersession.
 */
function verificationKey(event: TaskLedgerEvent): string {
  const command = event.command ?? 'unknown'
  const scope = event.meta?.scope ?? 'targeted'
  const identity = `${verificationKind(event.meta) ?? 'unknown'}::${asString(event.meta?.verificationPhase) ?? 'in-place'}::${asString(event.meta?.snapshotRef) ?? asString(event.meta?.workspaceFingerprint) ?? 'legacy'}`
  const resolvedCommand = asString(event.meta?.resolvedCommand) ?? ''

  // meta.targetFiles (populated by tools like run_tests) is authoritative:
  // it contains the actual resolved test file paths, not the raw filter string.
  // Using it prevents key mismatch when the same tests are run with
  // different filter syntax (e.g. "volatile-snapshot.test" vs
  // "src/prompt/__tests__/volatile-snapshot.test.ts").
  const coverage = readCompletionCoverage(event.meta?.coverage)
  if (coverage) return `completion::${coverage.runner}::${coverage.cwd}::${scope}::${coverage.filtered}::${coverage.files.map(f => f.path).sort().join('|')}::${identity}`
  const metaTargetFiles = getMetaTargetFiles(event.meta)
  const cmdTargetFiles = extractTestFiles(command)
  const resolvedTargetFiles = extractTestFiles(resolvedCommand)
  const targetFiles = metaTargetFiles.length > 0
    ? metaTargetFiles
    : [...cmdTargetFiles, ...resolvedTargetFiles]
  const uniqueTargetFiles = [...new Set(targetFiles)].sort()

  if (uniqueTargetFiles.length > 0) {
    return `tests::${scope}::${runnerFamily(`${command} ${resolvedCommand}`)}::${uniqueTargetFiles.join('|')}::${identity}`
  }

  return `${normalizeCommand(command)}::${scope}::${identity}`
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
  // meta.stale=true 的丢弃单列计数。该计数覆盖**所有** stale 判废，不挑病因——
  // 典型病因两类：① 仓内再编辑（验证后又改写仓内文件，正常开发循环里频繁非零，
  // 良性多数）；② 指纹不可计算（敏感路径/非 git 工作区/4251eea67 前台账的越界
  // owned 路径）。与 snapshotRef 陈旧是不同维度——不区分就会把病因报成"没跑过
  // 测试"（本缺陷的原症状）。
  let staleFingerprintDropped = 0
  const currentEvents = allVerificationEvents.filter(e => {
    if (e.meta?.stale === true) { staleFingerprintDropped++; return false }
    return true
  })
  const verificationEvents = currentSnapshotRef
    ? currentEvents.filter(e => {
        const ref = asString(e.meta?.snapshotRef)
        if (ref && ref !== currentSnapshotRef) {
          staleSnapshotDropped++
          return false
        }
        return true
      })
    : currentEvents

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
  for (const { event } of [...keyMap.values()].sort((a, b) => a.index - b.index)) {
    effective.push(eventToVerificationMetadata(event))
  }

  return { effective, supersededFailures, totalRawCount: allVerificationEvents.length, staleSnapshotDropped, staleFingerprintDropped }
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
  failed?: string[]
  /** Tests that exist on disk but were never covered by a passed verification. */
  uncovered: string[]
  /** Tests from the impact set that no longer exist (deleted/renamed) — recorded, never blocking. */
  uncoverable: string[]
}

function canonicalRoot(path: string): string { try { return realpathSync(path) } catch { return resolve(path) } }

function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 命令文本是否点名了该测试文件——coverage 缺失时的兜底归因。
 * 只做仓库相对路径的子串匹配：调用方（run_tests / 门禁分批命令）传的都是
 * 相对路径，绝对路径也含该子串，不会误配到别的文件。
 * 命令侧同样归一化（405bfc4c1 评审遗留）：Windows 反斜杠路径与 ./ 前缀形态
 * 也要命中，否则该平台上兜底归因整档失效（漏配方向=退回旧行为，非误配）。
 */
function commandMentionsTest(command: string, test: string): boolean {
  const normalizedCommand = command.replace(/\\/g, '/').replace(/(^|\s|['"])\.\//g, '$1')
  return normalizedCommand.includes(normalizePathForMatch(test))
}

/**
 * Assess which Meridian-impacted tests were actually covered by passed
 * verifications. Pure function — filesystem access is injected via existsFn.
 *
 * Only explicit test evidence covers selected files. A full label alone does
 * not identify a runner's suite and cannot cover tests in other suites.
 */
export function assessImpactedTestCoverage(
  impactedTests: readonly string[],
  verifications: readonly VerificationMetadata[],
  existsFn: (path: string) => boolean,
  repositoryRoot?: string,
): ImpactedTestCoverage {
  if (impactedTests.length === 0) return { uncovered: [], uncoverable: [] }

  const coveredFiles = new Set<string>()
  const failedFiles = new Set<string>()
  for (const v of verifications) {
    const c = readCompletionCoverage(v.coverage)
    // coverage 缺失的失败记录不能静默消失：下面的 `if (!c) continue` 会把它整条跳过，
    // 其点名的文件随后落进 uncovered——而 uncovered 的语义是「从未跑过」，那一档
    // 没有归因、直接硬拦。实测现场：run_tests 的隔离快照里失败（快照只含本会话的
    // owned diff，未跟踪的依赖不在其中 → 模块缺失），拿不到 per-file coverage，
    // 于是共享工作区下的 required 覆盖义务成为永久缺口（跑多少次都填不上）。
    // 这里按命令文本兜底归因，把它送回 failed 档——failed 档的归因门槛不放宽
    //（仍要求外部在途改动证据或隔离配对），只是不让它逃逸到错误的档位。
    if (!v.stale && v.status === 'failed' && v.kind === 'test' && !c && v.command) {
      for (const test of impactedTests) {
        if (commandMentionsTest(v.command, test)) failedFiles.add(normalizePathForMatch(test))
      }
    }
    if (repositoryRoot) {
      if (!c) continue
      const inside = relative(canonicalRoot(c.repositoryRoot), canonicalRoot(repositoryRoot))
      if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) continue
    }
    const pathForScope = (path: string) => repositoryRoot && c
      ? normalizePathForMatch(relative(canonicalRoot(repositoryRoot), resolve(canonicalRoot(c.repositoryRoot), path)))
      : normalizePathForMatch(path)
    if (!v.stale && v.status === 'failed' && v.kind === 'test' && c && !hasIsolatedComparison(v, verifications)) for (const f of c.files) if (f.outcome === 'failed') failedFiles.add(pathForScope(f.path))
    // 覆盖判定逐文件（证据粒度 = 责任粒度）：同批其他文件的失败不得作废本文件
    // 已拿到的通过证据。`status` / `exitCode` 是**整批**判据，用它筛掉整批会丢掉
    // 批内逐文件证据——现场：一次全量运行里 7862 个文件通过，因同批混入 1 个既有
    // 失败而全部作废，于是 required 全覆盖义务在共享工作区下不可满足。
    // 三条完整性判据原样保留：stale（记录失效）、complete（reporter 完整落盘）、
    // filtered（名称过滤不证明整文件执行）——它们管「证据可不可信」，与「这批整体
    // 成不成功」正交，不能一起放开（同构先例：编译器不因一文件报错丢掉其他文件的
    // 诊断；CI 矩阵里 job 红不过作废别的 job 结果）。
    if (v.stale || v.kind !== 'test' || !c?.complete || c.filtered) continue
    for (const f of c.files) {
      if (f.outcome === 'passed' && f.tests > f.skipped && f.cancelled === 0) coveredFiles.add(pathForScope(f.path))
    }
  }

  const uncovered: string[] = []
  const uncoverable: string[] = []
  for (const test of [...new Set(impactedTests)].sort()) {
    if (!existsFn(test)) {
      uncoverable.push(test)
      continue
    }
    const normalized = normalizePathForMatch(test)
    if (!coveredFiles.has(normalized)) {
      uncovered.push(test)
    }
  }
  const failed = impactedTests.filter(test => existsFn(test) && failedFiles.has(normalizePathForMatch(test)))
  return { uncovered, uncoverable, ...(failed.length ? { failed } : {}) }
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
  attribute(result: VerificationMetadata, verifications?: readonly VerificationMetadata[]): AttributionResult
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
  function attribute(result: VerificationMetadata, verifications: readonly VerificationMetadata[] = []): AttributionResult {
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
      if (hasIsolatedComparison(result, verifications)) {
        return {
          attribution: 'integration_conflict',
          isBlocking: false,
          reason: `Isolation passed, integration failed: ${result.command}. Matching complete proofs establish an integration difference; its cause is unresolved. Delivery is not blocked.`,
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
      if (result.scope === 'targeted' && result.targetFiles?.some(file => _opts.ownership.isOwned(file) || _opts.ownership.isCoOwned(file))) {
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

    const attributions = results.map(r => attribute(r, results))

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
        reason: `Isolation passed, integration failed: ${first.source.command}. Matching proofs establish an integration difference. Delivery not blocked.`,
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
