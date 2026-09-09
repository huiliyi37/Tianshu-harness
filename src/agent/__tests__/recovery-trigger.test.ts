import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyInterrupt,
  classifyDoomLoop,
  classifyThrashing,
  classifySessionIntegrity,
  classifyResourcePressure,
  classifyRecoveryTrigger,
  type InterruptClassifierInput,
  type DoomLoopClassifierInput,
  type ThrashingClassifierInput,
  type IntegrityClassifierInput,
  type ResourcePressureClassifierInput,
  type RecoveryTriggerResult,
} from '../recovery-trigger.js'

// ─── Interrupt Tests ──────────────────────────────────────────

test('classifyInterrupt returns null when no repeated interrupt', () => {
  const input: InterruptClassifierInput = {
    interruptCountThisTurn: 1,
    hasPendingTools: false,
    turn: 3,
  }
  assert.equal(classifyInterrupt(input), null)
})

test('classifyInterrupt returns null when count is 0 and no pending tools', () => {
  const input: InterruptClassifierInput = {
    interruptCountThisTurn: 0,
    hasPendingTools: false,
    turn: 1,
  }
  assert.equal(classifyInterrupt(input), null)
})

test('classifyInterrupt triggers on 2+ interrupts', () => {
  const input: InterruptClassifierInput = {
    interruptCountThisTurn: 2,
    hasPendingTools: false,
    turn: 5,
  }
  const result = classifyInterrupt(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'repeated_interrupt')
  assert.equal(result!.severity, 'warn')
  assert.ok(result!.summary.includes('Repeatedly interrupted'))
  assert.ok(result!.evidence.length > 0)
  assert.ok(result!.suggestedActions.length > 0)
})

test('classifyInterrupt triggers on pending tools after interrupt', () => {
  const input: InterruptClassifierInput = {
    interruptCountThisTurn: 1,
    hasPendingTools: true,
    turn: 7,
  }
  const result = classifyInterrupt(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'repeated_interrupt')
  assert.equal(result!.severity, 'error')
  assert.ok(result!.summary.includes('Interrupted with pending tool'))
})

test('classifyInterrupt error severity overrides warn when pending tools', () => {
  const input: InterruptClassifierInput = {
    interruptCountThisTurn: 3,
    hasPendingTools: true,
    turn: 4,
  }
  const result = classifyInterrupt(input)
  assert.notEqual(result, null)
  assert.equal(result!.severity, 'error')
  assert.ok(result!.evidence.some(e => e.includes('pending')))
})

test('classifyInterrupt does NOT trigger on pending tools without interrupts', () => {
  // Normal in-flight tool execution with zero interrupts is NOT a recovery trigger
  const input: InterruptClassifierInput = {
    interruptCountThisTurn: 0,
    hasPendingTools: true,
    turn: 3,
  }
  assert.equal(classifyInterrupt(input), null)
})

// ─── Doom Loop Tests ──────────────────────────────────────────

test('classifyDoomLoop returns null when level is none', () => {
  const input: DoomLoopClassifierInput = {
    doomLoopLevel: 'none',
    recentFingerprints: ['abc123', 'def456'],
    uniqueFingerprintCount: 2,
  }
  assert.equal(classifyDoomLoop(input), null)
})

test('classifyDoomLoop returns null when level is warn', () => {
  const input: DoomLoopClassifierInput = {
    doomLoopLevel: 'warn',
    recentFingerprints: ['abc123', 'abc123'],
    uniqueFingerprintCount: 1,
  }
  assert.equal(classifyDoomLoop(input), null)
})

test('classifyDoomLoop triggers when level is blocked', () => {
  const input: DoomLoopClassifierInput = {
    doomLoopLevel: 'blocked',
    recentFingerprints: ['fp1', 'fp1', 'fp1', 'fp2'],
    uniqueFingerprintCount: 2,
  }
  const result = classifyDoomLoop(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'doom_loop_blocked')
  assert.equal(result!.severity, 'error')
  assert.ok(result!.summary.includes('failing repeatedly'))
  assert.ok(result!.evidence.some(e => e.includes('Doom loop blocked')))
  assert.ok(result!.evidence.some(e => e.includes('fp1')))
  assert.ok(result!.suggestedActions.some(a => a.includes('different approach')))
})

test('classifyDoomLoop includes most frequent fingerprint', () => {
  const input: DoomLoopClassifierInput = {
    doomLoopLevel: 'blocked',
    recentFingerprints: ['aa', 'bb', 'aa', 'cc', 'aa'],
    uniqueFingerprintCount: 3,
  }
  const result = classifyDoomLoop(input)
  assert.notEqual(result, null)
  const fingerprintLine = result!.evidence.find(e => e.includes('Most frequent'))
  assert.ok(fingerprintLine)
  assert.ok(fingerprintLine!.includes('aa'))
  assert.ok(fingerprintLine!.includes('3x'))
})

// ─── Thrashing Tests ──────────────────────────────────────────

test('classifyThrashing returns null when everything is healthy', () => {
  const input: ThrashingClassifierInput = {
    compactionTurns: [10],
    currentTurn: 15,
    consecutiveCompactFailures: 0,
    estimatedTokens: 500_000,
    contextWindow: 1_000_000,
    lastCompactFailed: false,
  }
  assert.equal(classifyThrashing(input), null)
})

test('classifyThrashing triggers on 3+ compactions in 4-turn window', () => {
  const input: ThrashingClassifierInput = {
    compactionTurns: [8, 9, 10],
    currentTurn: 11,
    consecutiveCompactFailures: 0,
    estimatedTokens: 600_000,
    contextWindow: 1_000_000,
    lastCompactFailed: false,
  }
  const result = classifyThrashing(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'context_thrashing')
  assert.equal(result!.severity, 'warn')
  assert.ok(result!.evidence.some(e => e.includes('3 compactions')))
  assert.ok(result!.suggestedActions.some(a => a.includes('sub-task')))
})

test('classifyThrashing triggers on consecutive compact failures', () => {
  const input: ThrashingClassifierInput = {
    compactionTurns: [],
    currentTurn: 10,
    consecutiveCompactFailures: 3,
    estimatedTokens: 500_000,
    contextWindow: 1_000_000,
    lastCompactFailed: false,
  }
  const result = classifyThrashing(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'context_thrashing')
  assert.equal(result!.severity, 'error')
  assert.ok(result!.evidence.some(e => e.includes('consecutive compaction failures')))
})

test('classifyThrashing triggers on >95% after compaction', () => {
  const input: ThrashingClassifierInput = {
    compactionTurns: [4, 5],   // has compaction activity
    currentTurn: 5,
    consecutiveCompactFailures: 0,
    estimatedTokens: 960_000,
    contextWindow: 1_000_000,
    lastCompactFailed: false,
  }
  const result = classifyThrashing(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'context_thrashing')
  assert.equal(result!.severity, 'error')
  assert.ok(result!.evidence.some(e => e.includes('96.0%')))
  assert.ok(result!.suggestedActions.some(a => a.includes('checkpoint-resume')))
})

test('classifyThrashing does NOT trigger on >95% without compaction activity', () => {
  // High watermark alone belongs to compact policy, not panic recovery
  const input: ThrashingClassifierInput = {
    compactionTurns: [],            // no compaction activity
    currentTurn: 5,
    consecutiveCompactFailures: 0,
    estimatedTokens: 960_000,
    contextWindow: 1_000_000,
    lastCompactFailed: false,
  }
  assert.equal(classifyThrashing(input), null)
})

test('classifyThrashing triggers on last compact failed', () => {
  const input: ThrashingClassifierInput = {
    compactionTurns: [],
    currentTurn: 3,
    consecutiveCompactFailures: 0,
    estimatedTokens: 500_000,
    contextWindow: 1_000_000,
    lastCompactFailed: true,
  }
  const result = classifyThrashing(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'context_thrashing')
  assert.equal(result!.severity, 'warn')
  assert.ok(result!.evidence.some(e => e.includes('Last compaction attempt failed')))
})

test('classifyThrashing deduplicates suggested actions', () => {
  const input: ThrashingClassifierInput = {
    compactionTurns: [8, 9, 10],
    currentTurn: 11,
    consecutiveCompactFailures: 3,
    estimatedTokens: 960_000,
    contextWindow: 1_000_000,
    lastCompactFailed: true,
  }
  const result = classifyThrashing(input)
  assert.notEqual(result, null)
  // All four checks fire — actions should be deduplicated
  const unique = new Set(result!.suggestedActions)
  assert.equal(unique.size, result!.suggestedActions.length)
})

// ─── Session Integrity Tests ──────────────────────────────────

test('classifySessionIntegrity returns null when session is healthy', () => {
  const input: IntegrityClassifierInput = {
    orphanToolUseCount: 0,
    orphanToolResultCount: 0,
    wasRepaired: false,
    syntheticResultsInserted: 0,
    messageCount: 50,
  }
  assert.equal(classifySessionIntegrity(input), null)
})

test('classifySessionIntegrity triggers on orphan tool_use', () => {
  const input: IntegrityClassifierInput = {
    orphanToolUseCount: 2,
    orphanToolResultCount: 0,
    wasRepaired: false,
    syntheticResultsInserted: 0,
    messageCount: 100,
  }
  const result = classifySessionIntegrity(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'session_integrity')
  assert.equal(result!.severity, 'error')
  assert.ok(result!.evidence.some(e => e.includes('2 orphan tool_use')))
  assert.ok(result!.suggestedActions.some(a => a.includes('Restore from last safe snapshot')))
})

test('classifySessionIntegrity triggers on orphan tool_result', () => {
  const input: IntegrityClassifierInput = {
    orphanToolUseCount: 0,
    orphanToolResultCount: 3,
    wasRepaired: false,
    syntheticResultsInserted: 0,
    messageCount: 200,
  }
  const result = classifySessionIntegrity(input)
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'session_integrity')
  assert.equal(result!.severity, 'warn')
  assert.ok(result!.evidence.some(e => e.includes('3 orphan tool_result')))
})

test('classifySessionIntegrity does NOT punish an already-repaired session', () => {
  const input: IntegrityClassifierInput = {
    orphanToolUseCount: 0,
    orphanToolResultCount: 0,
    wasRepaired: true,
    syntheticResultsInserted: 5,
    messageCount: 100,
  }
  const result = classifySessionIntegrity(input)
  assert.equal(result, null, 'repair is a resolution, not a reliability issue')
})

test('classifySessionIntegrity flags large damaged sessions', () => {
  const input: IntegrityClassifierInput = {
    orphanToolUseCount: 1,
    orphanToolResultCount: 2,
    wasRepaired: false,
    syntheticResultsInserted: 0,
    messageCount: 600,
  }
  const result = classifySessionIntegrity(input)
  assert.notEqual(result, null)
  assert.ok(result!.evidence.some(e => e.includes('600 messages')))
})

test('classifySessionIntegrity error priority over warn for orphan tool_use', () => {
  const input: IntegrityClassifierInput = {
    orphanToolUseCount: 1,
    orphanToolResultCount: 2,
    wasRepaired: true,
    syntheticResultsInserted: 3,
    messageCount: 100,
  }
  const result = classifySessionIntegrity(input)
  assert.notEqual(result, null)
  // orphan tool_use is present → error
  assert.equal(result!.severity, 'error')
})

// ─── Resource Pressure Tests ──────────────────────────────────

function makeResourcePressure(overrides?: Partial<ResourcePressureClassifierInput>): ResourcePressureClassifierInput {
  return {
    rssBytes: 100,
    heapUsedBytes: 50,
    memoryLimitBytes: 1_000,
    sessionBytes: 100,
    sessionByteLimit: 1_000,
    memoryTrendBytesPerSample: 0,
    ...overrides,
  }
}

test('classifyResourcePressure returns null when memory and disk are healthy', () => {
  assert.equal(classifyResourcePressure(makeResourcePressure()), null)
})

test('classifyResourcePressure warns at memory degraded threshold', () => {
  const result = classifyResourcePressure(makeResourcePressure({ heapUsedBytes: 800 }))
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'resource_pressure')
  assert.equal(result!.severity, 'warn')
  assert.ok(result!.summary.includes('Resource pressure'))
  assert.ok(result!.suggestedActions.some(action => action.includes('degraded')))
})

test('classifyResourcePressure errors at memory minimal threshold', () => {
  const result = classifyResourcePressure(makeResourcePressure({ heapUsedBytes: 950 }))
  assert.notEqual(result, null)
  assert.equal(result!.severity, 'error')
  assert.ok(result!.summary.includes('Memory pressure critical'))
  assert.ok(result!.suggestedActions.some(action => action.includes('minimal')))
})

test('classifyResourcePressure detects oversized session JSONL', () => {
  const result = classifyResourcePressure(makeResourcePressure({ sessionBytes: 1_200 }))
  assert.notEqual(result, null)
  assert.equal(result!.severity, 'error')
  assert.ok(result!.evidence.some(e => e.includes('Session JSONL exceeds')))
  assert.ok(result!.suggestedActions.some(action => action.includes('Checkpoint')))
})

test('classifyResourcePressure includes rising memory trend', () => {
  const result = classifyResourcePressure(makeResourcePressure({ memoryTrendBytesPerSample: 40 }))
  assert.notEqual(result, null)
  assert.equal(result!.severity, 'warn')
  assert.ok(result!.evidence.some(e => e.includes('Memory trend rising')))
})

// ─── Aggregator Tests ─────────────────────────────────────────

function makeInterrupt(overrides?: Partial<InterruptClassifierInput>): InterruptClassifierInput {
  return { interruptCountThisTurn: 0, hasPendingTools: false, turn: 1, ...overrides }
}

function makeDoomLoop(overrides?: Partial<DoomLoopClassifierInput>): DoomLoopClassifierInput {
  return {
    doomLoopLevel: 'none',
    recentFingerprints: ['fp1', 'fp2'],
    uniqueFingerprintCount: 2,
    ...overrides,
  }
}

function makeThrashing(overrides?: Partial<ThrashingClassifierInput>): ThrashingClassifierInput {
  return {
    compactionTurns: [],
    currentTurn: 1,
    consecutiveCompactFailures: 0,
    estimatedTokens: 100_000,
    contextWindow: 1_000_000,
    lastCompactFailed: false,
    ...overrides,
  }
}

function makeIntegrity(overrides?: Partial<IntegrityClassifierInput>): IntegrityClassifierInput {
  return {
    orphanToolUseCount: 0,
    orphanToolResultCount: 0,
    wasRepaired: false,
    syntheticResultsInserted: 0,
    messageCount: 50,
    ...overrides,
  }
}

test('classifyRecoveryTrigger returns null when no trigger fires', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt(),
    doomLoop: makeDoomLoop(),
    thrashing: makeThrashing(),
    integrity: makeIntegrity(),
  })
  assert.equal(result, null)
})

test('classifyRecoveryTrigger returns single interrupt trigger', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt({ interruptCountThisTurn: 2 }),
    doomLoop: makeDoomLoop(),
    thrashing: makeThrashing(),
    integrity: makeIntegrity(),
  })
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'repeated_interrupt')
})

test('classifyRecoveryTrigger returns single doom loop trigger', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt(),
    doomLoop: makeDoomLoop({ doomLoopLevel: 'blocked', recentFingerprints: ['fp1', 'fp1', 'fp1'], uniqueFingerprintCount: 1 }),
    thrashing: makeThrashing(),
    integrity: makeIntegrity(),
  })
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'doom_loop_blocked')
})

test('classifyRecoveryTrigger returns single thrashing trigger', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt(),
    doomLoop: makeDoomLoop(),
    thrashing: makeThrashing({ compactionTurns: [8, 9, 10], currentTurn: 11 }),
    integrity: makeIntegrity(),
  })
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'context_thrashing')
})

test('classifyRecoveryTrigger returns single integrity trigger', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt(),
    doomLoop: makeDoomLoop(),
    thrashing: makeThrashing(),
    integrity: makeIntegrity({ orphanToolUseCount: 1 }),
  })
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'session_integrity')
})

test('classifyRecoveryTrigger returns resource pressure trigger', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt(),
    doomLoop: makeDoomLoop(),
    thrashing: makeThrashing(),
    integrity: makeIntegrity(),
    resourcePressure: makeResourcePressure({ heapUsedBytes: 800 }),
  })
  assert.notEqual(result, null)
  assert.equal(result!.trigger, 'resource_pressure')
})

test('classifyRecoveryTrigger error takes priority over warn', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt({ interruptCountThisTurn: 2 }), // warn
    doomLoop: makeDoomLoop({ doomLoopLevel: 'blocked', recentFingerprints: ['fp1', 'fp1', 'fp1'], uniqueFingerprintCount: 1 }), // error
    thrashing: makeThrashing(),
    integrity: makeIntegrity(),
  })
  assert.notEqual(result, null)
  // Doom loop is error, interrupt is warn → error wins
  assert.equal(result!.trigger, 'doom_loop_blocked')
})

test('classifyRecoveryTrigger first error wins when multiple errors', () => {
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt({ interruptCountThisTurn: 1, hasPendingTools: true }), // error
    doomLoop: makeDoomLoop({ doomLoopLevel: 'blocked', recentFingerprints: ['fp1', 'fp1', 'fp1'], uniqueFingerprintCount: 1 }), // error
    thrashing: makeThrashing(),
    integrity: makeIntegrity({ orphanToolUseCount: 2 }), // error
  })
  assert.notEqual(result, null)
  // All three are errors — first one (interrupt by classifier order) wins
  assert.equal(result!.trigger, 'repeated_interrupt')
})

test('classifyRecoveryTrigger returns null for empty results list', () => {
  // All null-producing inputs
  const result = classifyRecoveryTrigger({
    interrupt: makeInterrupt({ interruptCountThisTurn: 0, hasPendingTools: false }),
    doomLoop: makeDoomLoop({ doomLoopLevel: 'none' }),
    thrashing: makeThrashing({ compactionTurns: [], consecutiveCompactFailures: 0, estimatedTokens: 100_000, contextWindow: 1_000_000, lastCompactFailed: false }),
    integrity: makeIntegrity({ orphanToolUseCount: 0, orphanToolResultCount: 0, wasRepaired: false, syntheticResultsInserted: 0 }),
  })
  assert.equal(result, null)
})

// ─── Suggested Actions Structure Tests ────────────────────────

test('all trigger results have non-empty suggestedActions', () => {
  const inputs = [
    classifyInterrupt({ interruptCountThisTurn: 2, hasPendingTools: false, turn: 1 }),
    classifyDoomLoop({ doomLoopLevel: 'blocked', recentFingerprints: ['a', 'a', 'a'], uniqueFingerprintCount: 1 }),
    classifyThrashing({ compactionTurns: [1, 2, 3], currentTurn: 4, consecutiveCompactFailures: 0, estimatedTokens: 500_000, contextWindow: 1_000_000, lastCompactFailed: false }),
    classifySessionIntegrity({ orphanToolUseCount: 1, orphanToolResultCount: 0, wasRepaired: false, syntheticResultsInserted: 0, messageCount: 100 }),
  ]
  for (const result of inputs) {
    assert.notEqual(result, null)
    assert.ok((result as RecoveryTriggerResult).suggestedActions.length > 0,
      `${(result as RecoveryTriggerResult).trigger} should have suggested actions`)
  }
})
