/**
 * Recovery Trigger Classifier
 *
 * Determines whether the current execution link is unsafe to continue and
 * the user must choose a recovery strategy. Panic is NOT "any failure" — it
 * is a specific state where forward progress is blocked.
 *
 * Five trigger categories:
 *   1. repeated_interrupt  — 2+ interrupts in same turn, or pending tools after interrupt
 *   2. doom_loop_blocked    — same tool/fingerprint failed to blocking threshold
 *   3. context_thrashing    — consecutive compactions still high-pressure, or compact failures
 *   4. session_integrity    — broken tool_use/tool_result pairs, session file damage
 *   5. resource_pressure    — memory/disk sensors report dangerous pressure
 */

import type { DoomLoopLevel } from './trace-store.js'

// ─── Trigger Types ────────────────────────────────────────────

export type RecoveryTrigger =
  | 'repeated_interrupt'
  | 'doom_loop_blocked'
  | 'context_thrashing'
  | 'session_integrity'
  | 'resource_pressure'

export interface RecoveryTriggerResult {
  /** Which trigger fired, or null if no recovery needed */
  trigger: RecoveryTrigger | null
  severity: 'warn' | 'error'
  summary: string
  evidence: string[]
  suggestedActions: string[]
}

// ─── Classifier Input Types ───────────────────────────────────

export interface InterruptClassifierInput {
  /** Number of times the user interrupted (Ctrl+C) in the current turn */
  interruptCountThisTurn: number
  /** Whether there are pending tool_use blocks without tool_result */
  hasPendingTools: boolean
  /** Current turn number */
  turn: number
}

export interface DoomLoopClassifierInput {
  doomLoopLevel: DoomLoopLevel
  /** Recent tool fingerprints (from TraceStore.toolFingerprints) */
  recentFingerprints: string[]
  /** Count of unique fingerprints in the recent window */
  uniqueFingerprintCount: number
}

export interface ThrashingClassifierInput {
  /** Turns on which compaction occurred (most recent last) */
  compactionTurns: number[]
  /** Current turn number */
  currentTurn: number
  /** Number of consecutive compaction failures */
  consecutiveCompactFailures: number
  /** Current estimated token count */
  estimatedTokens: number
  /** Context window size */
  contextWindow: number
  /** Whether the last compaction failed (not just decided, but execution failed) */
  lastCompactFailed: boolean
}

export interface IntegrityClassifierInput {
  /** Number of orphan tool_use blocks (no matching tool_result) */
  orphanToolUseCount: number
  /** Number of orphan tool_result blocks (no matching tool_use) */
  orphanToolResultCount: number
  /** Whether the session was repaired on load (synthetic results inserted) */
  wasRepaired: boolean
  /** Number of synthetic tool_results inserted during repair */
  syntheticResultsInserted: number
  /** Total message count in the session */
  messageCount: number
}

export interface ResourcePressureClassifierInput {
  /** Resident set size in bytes */
  rssBytes: number
  /** Heap used in bytes */
  heapUsedBytes: number
  /** Process memory limit in bytes (usually v8 heap size limit or configured cap) */
  memoryLimitBytes: number
  /** Session JSONL bytes on disk */
  sessionBytes: number
  /** Disk threshold in bytes */
  sessionByteLimit: number
  /** Optional memory leak trend slope, bytes per sample */
  memoryTrendBytesPerSample?: number
  /**
   * When true (ResourceSensor post-reset cooldown), absolute heap ratios do not
   * contribute warn/error — only disk pressure and (after samples accumulate)
   * rising trend evidence. Prevents desktop cross-session heap residual lockout.
   */
  suppressAbsoluteMemoryPressure?: boolean
}

// ─── Classifiers ──────────────────────────────────────────────

export function classifyInterrupt(input: InterruptClassifierInput): RecoveryTriggerResult | null {
  const evidence: string[] = []
  const actions: string[] = []

  // Only trigger when interrupts actually happened — pending tools alone
  // (e.g. normal in-flight tool execution) are NOT a recovery trigger.
  // Requires: 2+ interrupts OR (1+ interrupt with pending tools as aggravating factor)
  const hadInterrupts = input.interruptCountThisTurn >= 2
  const singleInterruptWithPending = input.interruptCountThisTurn >= 1 && input.hasPendingTools

  if (!hadInterrupts && !singleInterruptWithPending) {
    return null
  }

  if (input.interruptCountThisTurn >= 2) {
    evidence.push(`Turn ${input.turn}: ${input.interruptCountThisTurn} interrupts received`)
    actions.push('Resume current task from last successful step')
    actions.push('Cancel current task and start a new prompt')
  }

  if (input.hasPendingTools && input.interruptCountThisTurn >= 1) {
    const pending = 'Tool execution was interrupted mid-flight — pending tool_use may leave incomplete state'
    evidence.push(pending)
    actions.push('Review pending tool calls before continuing')
    actions.push('Use /rollback to restore agent-owned files to checkpoint')
  }

  if (evidence.length === 0) return null

  return {
    trigger: 'repeated_interrupt',
    severity: input.hasPendingTools ? 'error' : 'warn',
    summary: input.hasPendingTools
      ? 'Interrupted with pending tool execution — state may be inconsistent'
      : 'Repeatedly interrupted — confirm recovery strategy',
    evidence,
    suggestedActions: actions,
  }
}

export function classifyDoomLoop(input: DoomLoopClassifierInput): RecoveryTriggerResult | null {
  if (input.doomLoopLevel !== 'blocked') return null

  const mostFrequent = findMostFrequent(input.recentFingerprints)
  const evidence = [
    `Doom loop blocked: same tool/fingerprint repeated to threshold`,
    `Recent fingerprints: ${input.recentFingerprints.length} total, ${input.uniqueFingerprintCount} unique`,
  ]
  if (mostFrequent) {
    evidence.push(`Most frequent fingerprint: ${mostFrequent.value} (${mostFrequent.count}x)`)
  }

  return {
    trigger: 'doom_loop_blocked',
    severity: 'error',
    summary: 'Same tool call is failing repeatedly — strategy may need to change',
    evidence,
    suggestedActions: [
      'Review the failing tool and its error messages',
      'Try a different approach or tool to achieve the same goal',
      'Ask the user for guidance on the correct approach',
      'Use /rollback to revert to last checkpoint if files are corrupted',
    ],
  }
}

export function classifyThrashing(input: ThrashingClassifierInput): RecoveryTriggerResult | null {
  const evidence: string[] = []
  const actions: string[] = []

  // Check 1: 3+ compactions in 4-turn window
  const windowCompactions = input.compactionTurns.filter(
    t => input.currentTurn - t <= 4,
  )
  const isThrashing = windowCompactions.length >= 3

  // Check 2: compact failures >= 3
  const compactBroken = input.consecutiveCompactFailures >= 3

  // Check 3: still > 95% — but only relevant after compaction activity.
  // High watermark alone is for compact policy, not panic recovery.
  // "压缩后 >95%" per roadmap: must follow a compaction attempt.
  const ratio = input.contextWindow > 0 ? input.estimatedTokens / input.contextWindow : 1
  const hasCompactionActivity = input.compactionTurns.length > 0 ||
    input.consecutiveCompactFailures > 0 ||
    input.lastCompactFailed
  const stillCritical = ratio >= 0.95 && hasCompactionActivity

  // Check 4: last compact itself failed
  const lastFailed = input.lastCompactFailed

  if (!isThrashing && !compactBroken && !stillCritical && !lastFailed) {
    return null
  }

  if (isThrashing) {
    evidence.push(
      `${windowCompactions.length} compactions in last 4 turns (turns: ${windowCompactions.join(', ')})`,
    )
    actions.push('Consider breaking the task into smaller sub-tasks')
    actions.push('Summarize older conversation rounds to free context')
  }

  if (compactBroken) {
    evidence.push(
      `${input.consecutiveCompactFailures} consecutive compaction failures — circuit breaker open`,
    )
    actions.push('Manual compaction may be needed — type /compact')
    actions.push('Check if the session transcript is too large to process')
  }

  if (stillCritical) {
    const pct = (ratio * 100).toFixed(1)
    evidence.push(`Context at ${pct}% of window even after compaction`)
    actions.push('Trigger checkpoint-resume to start a fresh context')
    actions.push('Archive current session and continue in a new one')
  }

  if (lastFailed) {
    evidence.push('Last compaction attempt failed')
    actions.push('Check compaction model availability')
    actions.push('Try manual compaction with /compact')
  }

  if (evidence.length === 0) return null

  return {
    trigger: 'context_thrashing',
    severity: stillCritical || compactBroken ? 'error' : 'warn',
    summary: stillCritical
      ? 'Context window critically full — compaction cannot reduce further'
      : compactBroken
        ? 'Compaction repeatedly failing — manual intervention needed'
        : 'Context is thrashing — too many compactions in a short window',
    evidence,
    suggestedActions: [...new Set(actions)],
  }
}

export function classifyResourcePressure(input: ResourcePressureClassifierInput): RecoveryTriggerResult | null {
  const evidence: string[] = []
  const actions: string[] = []

  // Use heapUsed as primary signal — RSS is inflated in Node.js because V8
  // retains freed pages. heapUsed reflects actual live object pressure.
  const heapRatio = input.memoryLimitBytes > 0 ? input.heapUsedBytes / input.memoryLimitBytes : 0
  const diskRatio = input.sessionByteLimit > 0 ? input.sessionBytes / input.sessionByteLimit : 0
  const trend = input.memoryTrendBytesPerSample ?? 0
  const suppressHeap = input.suppressAbsoluteMemoryPressure === true

  if (!suppressHeap) {
    if (heapRatio >= 0.9) {
      evidence.push(`Heap used at ${(heapRatio * 100).toFixed(1)}% of limit (${input.heapUsedBytes}/${input.memoryLimitBytes} bytes)`)
      actions.push('Enter minimal mode and trigger auto-compact before continuing')
      actions.push('Start a fresh session if memory does not drop after compaction')
    } else if (heapRatio >= 0.75) {
      evidence.push(`Heap used at ${(heapRatio * 100).toFixed(1)}% of limit (${input.heapUsedBytes}/${input.memoryLimitBytes} bytes)`)
      actions.push('Enter degraded mode and avoid high-risk or memory-heavy tools')
    }
  }

  if (trend > 0 && input.memoryLimitBytes > 0 && trend / input.memoryLimitBytes >= 0.03) {
    evidence.push(`Memory trend rising by ${trend} bytes/sample`)
    actions.push('Watch for leaks; compact or restart if trend continues')
  }

  if (diskRatio >= 1) {
    evidence.push(`Session JSONL exceeds disk sensor limit (${input.sessionBytes}/${input.sessionByteLimit} bytes)`)
    actions.push('Checkpoint and truncate session persistence')
    actions.push('Archive old transcript segments before continuing')
  } else if (diskRatio >= 0.8) {
    evidence.push(`Session JSONL at ${(diskRatio * 100).toFixed(1)}% of disk sensor limit (${input.sessionBytes}/${input.sessionByteLimit} bytes)`)
    actions.push('Schedule session persistence checkpoint soon')
  }

  if (evidence.length === 0) return null

  const heapError = !suppressHeap && heapRatio >= 0.9
  return {
    trigger: 'resource_pressure',
    severity: heapError || diskRatio >= 1 ? 'error' : 'warn',
    summary: heapError
      ? 'Memory pressure critical — minimal mode recommended'
      : diskRatio >= 1
        ? 'Session persistence too large — checkpoint/truncate required'
        : 'Resource pressure rising — degraded mode recommended',
    evidence,
    suggestedActions: [...new Set(actions)],
  }
}

export function classifySessionIntegrity(
  input: IntegrityClassifierInput,
): RecoveryTriggerResult | null {
  const evidence: string[] = []
  const actions: string[] = []
  let hasIssue = false

  if (input.orphanToolUseCount > 0) {
    hasIssue = true
    evidence.push(`${input.orphanToolUseCount} orphan tool_use block(s) without tool_result`)
    actions.push('Restore from last safe snapshot if available')
    actions.push('Start a fresh session to avoid context corruption')
  }

  if (input.orphanToolResultCount > 0) {
    hasIssue = true
    evidence.push(`${input.orphanToolResultCount} orphan tool_result block(s) without tool_use`)
    actions.push('These tool_results may pollute context — consider trimming')
  }

  // A repaired session is a RESOLVED condition, not an integrity issue. The
  // orphan counts above are computed from the same repaired message list the
  // request builder sends, so when repair healed everything both counts are
  // zero and no recovery trigger should fire (2026-09-08 abort→orphan chain).

  // Also flag very large sessions with known issues
  if (input.messageCount > 500 && (input.orphanToolUseCount > 0 || input.orphanToolResultCount > 0)) {
    evidence.push(`Large session (${input.messageCount} messages) with integrity issues`)
    actions.push('Consider archiving this session and starting fresh')
  }

  if (!hasIssue) return null

  return {
    trigger: 'session_integrity',
    severity: input.orphanToolUseCount > 0 ? 'error' : 'warn',
    summary: input.orphanToolUseCount > 0
      ? 'Session has broken tool_use/tool_result pairs — context may be corrupted'
      : 'Session integrity issues detected — may affect agent behavior',
    evidence,
    suggestedActions: [...new Set(actions)],
  }
}

// ─── Aggregator ───────────────────────────────────────────────

export type ClassifyInputs = {
  interrupt: InterruptClassifierInput
  doomLoop: DoomLoopClassifierInput
  thrashing: ThrashingClassifierInput
  integrity: IntegrityClassifierInput
  resourcePressure?: ResourcePressureClassifierInput
}

/**
 * Run all 4 classifiers and return the highest-severity result.
 * When multiple triggers fire, 'error' takes priority over 'warn'.
 * Returns null when no recovery is needed.
 */
export function classifyRecoveryTrigger(inputs: ClassifyInputs): RecoveryTriggerResult | null {
  const results: RecoveryTriggerResult[] = []

  const interrupt = classifyInterrupt(inputs.interrupt)
  if (interrupt) results.push(interrupt)

  const doomLoop = classifyDoomLoop(inputs.doomLoop)
  if (doomLoop) results.push(doomLoop)

  const thrashing = classifyThrashing(inputs.thrashing)
  if (thrashing) results.push(thrashing)

  const integrity = classifySessionIntegrity(inputs.integrity)
  if (integrity) results.push(integrity)

  if (inputs.resourcePressure) {
    const resourcePressure = classifyResourcePressure(inputs.resourcePressure)
    if (resourcePressure) results.push(resourcePressure)
  }

  if (results.length === 0) return null

  // Priority: error > warn. Among errors, first one wins (by classifier order).
  const errors = results.filter(r => r.severity === 'error')
  if (errors.length > 0) return errors[0]!

  return results[0]!
}

// ─── Helpers ──────────────────────────────────────────────────

function findMostFrequent(
  fingerprints: string[],
): { value: string; count: number } | null {
  const counts = new Map<string, number>()
  for (const fp of fingerprints) {
    counts.set(fp, (counts.get(fp) ?? 0) + 1)
  }
  let best: { value: string; count: number } | null = null
  for (const [value, count] of counts) {
    if (!best || count > best.count) {
      best = { value, count }
    }
  }
  return best
}
