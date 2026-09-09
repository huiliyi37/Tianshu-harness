import { classifyChangeScale, isTrivialChange, upgradeScaleByDepth, classifyAutoReviewTier, type ChangeSet, type ReviewScale } from './review-discipline.js'
import { profileRegistry } from './profile-registry.js'
import type { WorkerActivityEvent } from './coordinator.js'

export type ReviewVerdict = 'verified' | 'rejected'

export interface VerifierResult {
  verdict: ReviewVerdict
  /** Required command + observed output evidence. Blank evidence makes verified fail closed. */
  evidence: string
}

export interface PatcherResult {
  patched: boolean
}

export type ReviewFindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

/** 结论极性：'defect' = 缺陷发现；'confirmation' = 核实通过（确认无问题）。
 *  undefined 按 defect 处理（fail-closed，兼容无 polarity 的存量 worker 输出）。 */
export type ReviewFindingPolarity = 'defect' | 'confirmation'

export interface ReviewFinding {
  severity?: ReviewFindingSeverity | Lowercase<ReviewFindingSeverity> | string
  claim?: string
  /** Required for blocking severity (CRITICAL/HIGH). A finding without evidence
   *  is downgraded to non-blocking — this prevents hallucinated claims from
   *  blocking delivery. Evidence = file:line reference, command output, or
   *  other ground truth the reviewer used to substantiate the claim. */
  evidence?: string
  /** blocking 判定只认 'defect'；'confirmation' 单独汇总为已核实清单。 */
  polarity?: ReviewFindingPolarity
}

export type ReviewInfraFailureKind = 'worker' | 'json' | 'timeout' | 'skip'

export interface ReviewInfraFailure {
  kind: ReviewInfraFailureKind | string
  claim: string
  /** parse-salvaged 恢复的发现（unverified）——infra 归因时透传价值供主控止损，
   *  不参与 blocking 判定（803d897d 教训：死防线不得冒充通过，反之亦然：
   *  有价值的发现不得被「DID NOT RUN」一行吞掉）。2026-09-06 F1。 */
  salvagedFindings?: { claim: string; confidence?: string }[]
}

export interface SquadronResult {
  /** Real code/design findings produced by review workers. CRITICAL/HIGH blocks. */
  findings: ReviewFinding[]
  /** Review infrastructure failures: worker crash, non-JSON output, timeout, skipped review. */
  infraFailures?: ReviewInfraFailure[]
}

export interface ReviewRouterDeps {
  spawnVerifier: (change: ChangeSet, signal?: AbortSignal, onActivity?: (event: WorkerActivityEvent) => void) => Promise<VerifierResult>
  spawnPatcher: (change: ChangeSet, verifier: VerifierResult, signal?: AbortSignal, onActivity?: (event: WorkerActivityEvent) => void) => Promise<PatcherResult>
  spawnSquadron: (change: ChangeSet, signal?: AbortSignal, onActivity?: (event: WorkerActivityEvent) => void) => Promise<SquadronResult>
  /** Auto mode: single wiring-effectiveness inspector on a short budget.
   *  When absent, auto mode degrades to a non-blocking nudge. */
  spawnWiringReviewer?: (change: ChangeSet, signal?: AbortSignal, onActivity?: (event: WorkerActivityEvent) => void) => Promise<SquadronResult>
}

export type ReviewMode = 'auto' | 'manual'

export interface ReviewRouterOptions {
  maxRounds?: number
  /** AbortSignal to propagate to spawned verifier/patcher/squadron workers.
   *  When aborted, coordinator.delegate() will cancel in-flight worker sessions. */
  abortSignal?: AbortSignal
  /** 'auto'  — in-task review without explicit review_level: one wiring
   *            inspector, infra failures NEVER block delivery.
   *  'manual' — explicit /review (L2) or /review max (L3): full workflows.
   *  Default: 'manual' (preserves direct-caller behavior). */
  mode?: ReviewMode
  /** Task dependency depth — upgrades review scale for wiring/system tasks. */
  depthLayer?: import('../context/task-contract.js').TaskDepthLayer
  /** User-provided focus hint (from /review max <focus>). Injected into
   *  inspector/verifier objectives so workers know what to prioritize. */
  focusHint?: string
  /** Review-gate UI visibility: forwarded to every spawned review worker as
   *  DelegationRequest.onActivity so the subagent panel sees live progress. */
  onActivity?: (event: WorkerActivityEvent) => void
}

export interface ReviewOutcome {
  tier: ReviewScale | 'auto'
  /** 'inconclusive' (auto only): the review DID NOT run — infra failure, no
   *  usable verdict. Renderers must never describe this as verified. */
  verdict: ReviewVerdict | 'nudge' | 'inconclusive'
  evidence?: string
  escalated?: boolean
  rounds?: number
  /** True when the auto-mode quick retry recovered a usable verdict. */
  recoveredByRetry?: boolean
  /** Non-code review infrastructure caveats from L3 squadron workers. */
  infraFailures?: ReviewInfraFailure[]
}

// ─── Review workflow budgets ────────────────────────────────────────
// P0 timeout alignment: the outer review-workflow cap must dominate the
// inner worker budgets (profile defaultTimeoutMs), otherwise deep review
// budgets are dead wiring — the old fixed 90s cap killed every reviewer
// long before its 600s budget could matter.

/** Auto in-task review: short and predictable — never stalls the main loop.
 *  必须压过内层 computeAutoReviewBudget 最大超时(480s)——2026-08-01 随
 *  审查预算三档全升(→480s)同步放宽,否则内层 timer 永远打不响(死接线)。 */
export const AUTO_REVIEW_BUDGET_MS = 600_000
/** Extra slack so worker-internal timers fire before the workflow cap. */
const REVIEW_BUDGET_GRACE_MS = 60_000

/** Outer budget for one review workflow run, derived from worker budgets. */
export function reviewWorkflowBudgetMs(mode: ReviewMode, tier?: ReviewScale): number {
  if (mode === 'auto') return AUTO_REVIEW_BUDGET_MS
  const profile = tier === 'L2' ? 'adversarial_verifier' : 'reviewer'
  const workerBudget = profileRegistry.get(profile)?.defaultTimeoutMs ?? 600_000
  return workerBudget + REVIEW_BUDGET_GRACE_MS
}

function hasEvidence(result: VerifierResult): boolean {
  return result.evidence.trim().length > 0
}

function normalizeVerifierResult(result: VerifierResult): VerifierResult {
  if (result.verdict === 'verified' && !hasEvidence(result)) {
    return { verdict: 'rejected', evidence: 'verified verdict missing command + observed output evidence' }
  }
  return result
}

function isBlockingSeverity(severity: string | undefined): boolean {
  const upper = severity?.toUpperCase()
  return upper === 'CRITICAL' || upper === 'HIGH'
}

function findingHasEvidence(finding: ReviewFinding): boolean {
  return Boolean(finding.evidence && finding.evidence.trim().length > 0)
}

/** blocking 只认缺陷极性——confirmation（核实通过）永远 non-blocking。
 *  polarity 省略按 defect 处理（fail-closed，兼容存量输出）。 */
function isDefect(finding: ReviewFinding): boolean {
  return finding.polarity !== 'confirmation'
}

function hasBlockingSquadronFinding(result: SquadronResult): boolean {
  return result.findings.some(finding => {
    if (!isDefect(finding)) return false
    if (!isBlockingSeverity(finding.severity)) return false
    // A HIGH/CRITICAL finding without evidence cannot block — it may be a
    // hallucinated claim (e.g. referencing a file:line that doesn't exist).
    // Downgrade to non-blocking; surface it as a caveat in the summary.
    return findingHasEvidence(finding)
  })
}

/** 已核实清单条数（confirmation 极性）——verified 文案用它替代「无 blocking
 *  findings」的空话，让审查通过带上实质内容。 */
function countConfirmations(result: SquadronResult): number {
  return result.findings.filter(finding => finding.polarity === 'confirmation').length
}

function summarizeSquadronFindings(result: SquadronResult): string {
  const blocking = result.findings.filter(finding => isDefect(finding) && isBlockingSeverity(finding.severity))
  const summary = blocking
    .map(finding => {
      const label = `${finding.severity ?? 'UNKNOWN'}: ${finding.claim ?? 'review finding'}`
      if (!findingHasEvidence(finding)) {
        return `${label} [NO EVIDENCE — downgraded to non-blocking]`
      }
      return label
    })
    .join('; ')
  return summary.length > 0 ? `squadron blocking findings: ${summary}` : 'squadron blocking findings'
}

function summarizeInfraFailures(failures: ReviewInfraFailure[]): string {
  return failures
    .map(failure => `${failure.kind}: ${failure.claim}`)
    .join('; ')
}

/**
 * Route a change set through the review workflow selected by mode and scale.
 *
 * auto (in-task, no explicit review_level):
 *   - trivial change (docs/test-only) → nudge, no child agents
 *   - everything else → ONE wiring-effectiveness inspector on a short budget;
 *     CRITICAL/HIGH findings block, infra failures NEVER block (fail-open
 *     with caveat) — auto review must not stall the main workflow.
 *
 * manual (explicit /review or /review max):
 *   - L1: nudge only, no child agents.
 *   - L2: single adversarial verifier, then bounded patch→verify loop on rejection.
 *   - L3: Review Squadron (5 inspectors). Squadron pass → verified (skip L2 loop).
 *     Squadron finds blocking issues → rejected.
 */
export async function routeReviewWorkflow(
  change: ChangeSet,
  deps: ReviewRouterDeps,
  options: ReviewRouterOptions = {},
): Promise<ReviewOutcome> {
  const signal = options.abortSignal

  // Merge focusHint from options into change so inspector objectives pick it up.
  if (options.focusHint && !change.focusHint) {
    change = { ...change, focusHint: options.focusHint }
  }

  if (options.mode === 'auto') {
    // Mechanical-change fast-path: skip review workers for docs/rename/heuristic-rename
    if (change.changeClass?.skipReview) return { tier: 'auto', verdict: 'nudge' }
    if (isTrivialChange(change.files)) return { tier: 'auto', verdict: 'nudge' }
    if (!deps.spawnWiringReviewer) return { tier: 'auto', verdict: 'nudge' }
    // auto-L1/L2 分层：基础层（小改动、非核心路径）零 worker 成本——静态门禁
    // 摘要即结论；进阶层（核心路径/≥3 文件/forceLevel/依赖配置）才付 worker。
    if (classifyAutoReviewTier(change) === 'L1') return { tier: 'auto', verdict: 'nudge' }

    // "The review did not run": no findings at all AND infra failures present.
    // For the single wiring inspector this means its output was unusable.
    const reviewDidNotRun = (w: SquadronResult): boolean =>
      w.findings.length === 0 && (w.infraFailures?.length ?? 0) > 0

    const wiring = await deps.spawnWiringReviewer(change, signal, options.onActivity)
    const infraFailures = wiring.infraFailures ?? []
    const attempts = 1
    // No retry (2026-07-29): deterministic failures (budget/timeout) were never
    // retried; non-deterministic failures (json/worker crash) had a retry that
    // empirically never recovered — same model + same budget + same prompt =
    // same failure.  Don't pay the second worker's cost for nothing.

    if (hasBlockingSquadronFinding(wiring)) {
      return {
        tier: 'auto',
        verdict: 'rejected',
        evidence: summarizeSquadronFindings(wiring),
        rounds: attempts,
        ...(infraFailures.length > 0 ? { infraFailures } : {}),
      }
    }
    // Infra failure with no usable verdict: report honestly as inconclusive.
    // Fail-open (delivery proceeds) but NEVER described as verified — the
    // previous wording ("delivery verified by available evidence") let a dead
    // defense line masquerade as a passed review (session 803d897d, T3).
    // 标签按失败 kind 区分:预算耗尽与超时是配置信号,不应混进 infra failure。
    if (reviewDidNotRun(wiring)) {
      const kindLabel = infraFailures.some(f => f.kind === 'budget')
        ? '审查预算耗尽(max-turns)'
        : infraFailures.some(f => f.kind === 'timeout')
          ? '审查超时'
          : 'infra failure'
      // F1（2026-09-06）：parse-salvaged 的发现是「报告坏了但活着」的价值——透传
      // claims 而非只报一行 DID NOT RUN。仍标 unverified、不参与阻塞（803d897d）。
      const salvaged = infraFailures.flatMap(f => f.salvagedFindings ?? [])
      const base = `review DID NOT run (${kindLabel}${attempts > 1 ? '; retry also failed' : ''}): ${summarizeInfraFailures(infraFailures)}`
      const evidence = salvaged.length > 0
        ? `review 报告解析失败，salvaged ${salvaged.length} 条发现（unverified，不参与阻塞判定）：\n${salvaged
            .map(s => `- [${s.confidence ?? '?'}] ${s.claim}`)
            .join('\n')}\n—— ${base}`
        : base
      return {
        tier: 'auto',
        verdict: 'inconclusive',
        evidence,
        rounds: attempts,
        infraFailures,
      }
    }
    return {
      tier: 'auto',
      verdict: 'verified',
      evidence: `auto wiring review: no blocking findings${countConfirmations(wiring) > 0 ? `（${countConfirmations(wiring)} 项核实确认）` : ''}`,
      rounds: attempts,
      ...(infraFailures.length > 0 ? { infraFailures } : {}),
    }
  }

  const baseTier = classifyChangeScale(change)
  const tier = upgradeScaleByDepth(baseTier, options.depthLayer)
  if (tier === 'L1') return { tier, verdict: 'nudge' }

  let infraFailures: ReviewInfraFailure[] = []
  if (tier === 'L3') {
    const squadron = await deps.spawnSquadron(change, signal, options.onActivity)
    infraFailures = squadron.infraFailures ?? []
    if (hasBlockingSquadronFinding(squadron)) {
      return {
        tier,
        verdict: 'rejected',
        evidence: summarizeSquadronFindings(squadron),
        escalated: true,
        rounds: 0,
        ...(infraFailures.length > 0 ? { infraFailures } : {}),
      }
    }
    // Squadron passed without blocking findings — skip L2 verifier loop.
    // The 5-inspector squadron covers Security/Lifecycle/DataFlow/Silence/Wiring.
    return {
      tier,
      verdict: 'verified',
      evidence: `L3 squadron verified (5 inspectors): no blocking findings${countConfirmations(squadron) > 0 ? `（${countConfirmations(squadron)} 项核实确认）` : ''}`,
      rounds: 0,
      ...(infraFailures.length > 0 ? { infraFailures } : {}),
    }
  }

  const maxRounds = Math.max(1, options.maxRounds ?? 1)
  let last: VerifierResult = { verdict: 'rejected', evidence: '' }

  for (let round = 1; round <= maxRounds; round++) {
    last = normalizeVerifierResult(await deps.spawnVerifier(change, signal, options.onActivity))
    if (last.verdict === 'verified') {
      const infraEvidence = infraFailures.length > 0
        ? `${last.evidence}\nReview infra caveats: ${summarizeInfraFailures(infraFailures)}`
        : last.evidence
      return {
        tier,
        verdict: 'verified',
        evidence: infraEvidence,
        rounds: round,
        ...(infraFailures.length > 0 ? { infraFailures } : {}),
      }
    }
    const patcher = await deps.spawnPatcher(change, last, signal, options.onActivity)
    if (!patcher.patched) {
      return {
        tier,
        verdict: 'rejected',
        evidence: last.evidence,
        escalated: true,
        rounds: round,
      }
    }
  }

  return {
    tier,
    verdict: 'rejected',
    evidence: last.evidence,
    escalated: true,
    rounds: maxRounds,
  }
}
