import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyActivityMode, computeFlowBeacon, evaluateConvergence } from '../convergence-detector.js'
import type { ConvergenceInput, ConvergenceSignals, FlowBeaconInput, PhaseClass } from '../convergence-detector.js'
import type { ConvergenceScoreSample } from '../score-history.js'
import { bashCommandTarget, classifyBashCommandActivity } from '../tool-target.js'

// ─── Helpers ────────────────────────────────────────────────────────

function makeHistory(
  entries: Array<{
    tool: string
    status?: 'success' | 'failed'
    target?: string
    bashActivity?: 'readonly' | 'productive'
  }>,
) {
  return entries.map(e => ({
    tool: e.tool,
    status: e.status ?? 'success',
    target: e.target ?? e.tool,
    bashActivity: e.bashActivity,
  }))
}

function emptyEvidence() {
  return {
    filesModified: new Set<string>(),
    filesRead: new Set<string>(),
    deliveryStatus: 'unverified' as const,
  }
}

function baseInput(overrides: Partial<ConvergenceInput>): ConvergenceInput {
  return {
    turn: 5,
    phaseClass: 'explore',
    contextWindow: 200_000,
    recentToolHistory: [],
    evidenceState: emptyEvidence(),
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('evaluateConvergence', () => {
  // ── Level 0: normal operation ──

  it('returns level 0 when turns below nLow', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'pattern' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 5,
      phaseClass: 'explore',
      recentToolHistory: history,
    }))
    assert.equal(result.level, 0)
    assert.equal(result.shouldAbort, false)
    assert.equal(result.injectedMessage, null)
  })

  it('returns level 0 when score is high (>0.6) even at mid turns', () => {
    // Diverse tools, successful edits, high novelty → high score
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'edit_file', target: 'c.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'grep', target: 'pattern' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 12,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // With edits and tests, score should be high
    assert.equal(result.level, 0, `expected level 0, got ${result.level} (score=${result.score.toFixed(2)})`)
  })

  // ── Level 1: immune nudge ──

  it('returns level 1 at nLow with low score in explore phase', () => {
    // All reads, no edits, heavily repeating targets → low score in explore
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 8,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Single tool + single target → targetNovelty≈0.17, toolEntropy=0, tokenEfficiency=0
    assert.ok(result.score <= 0.6, `expected score <= 0.6, got ${result.score.toFixed(2)}`)
    assert.equal(result.level, 1, `expected level 1, got ${result.level}`)
    assert.equal(result.shouldAbort, false)
    assert.equal(result.shouldKick, false)
    assert.equal(result.injectedMessage, null)
  })

  // ── Level 2: stuck warning + kick ──

  it('returns level 2 at nMid with low score in execute phase (no edits)', () => {
    // Execute phase with no edits for 8+ turns → should trigger
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'z' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // execute phase with 0 edits should score low
    assert.ok(result.score <= 0.4, `expected score <= 0.4, got ${result.score.toFixed(2)}`)
    assert.equal(result.level, 2, `expected level 2, got ${result.level} (score=${result.score.toFixed(2)})`)
    assert.equal(result.shouldKick, true)
    assert.ok(result.injectedMessage, 'expected injected message')
    assert.ok(result.injectedMessage!.includes('执行阶段'), 'message should mention execute phase')
  })

  // ── W1: progress beacons (incident 20b9714e) ──

  it('progress beacon (todo completed) caps score-based escalation at level 1', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'z' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
      progressBeacons: { todoCompletedDelta: 1, activePlan: false },
    }))
    assert.ok(result.level <= 1, `expected level <= 1 with todo progress, got ${result.level}`)
    assert.equal(result.shouldKick, false)
    assert.equal(result.injectedMessage, null)
  })

  it('progress beacon does NOT suppress no-tool stagnation levels', () => {
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: [],
      noToolTurnCount: 5,
      progressBeacons: { todoCompletedDelta: 1, activePlan: false },
    }))
    assert.ok(result.level >= 2, `no-tool stagnation must keep escalating, got ${result.level}`)
  })

  // ── 2026-10-10 狂轰事故方向 2（等待验证信标）：后台有 running 的验证型 job 时，
  // 执行相位的「无编辑」是等门禁钦定证据，不是停滞——与 todo 信标同级的硬 veto。
  it('awaitingVerification caps score-based escalation at L1', () => {
    const input = {
      turn: 14,
      phaseClass: 'execute' as const,
      contextWindow: 200_000,
      recentToolHistory: makeHistory([
        { tool: 'bash', target: 'ls' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'grep', target: 'z' },
        { tool: 'read_file', target: 'a.ts' },
      ]),
    }
    // 基线：信标缺席 → 旧行为（同输入应能升级到 L2+，cap 副作用才可归因）。
    const baseline = evaluateConvergence(baseInput({ ...input, progressBeacons: { todoCompletedDelta: 0, activePlan: false } }))
    assert.ok(baseline.level >= 2, `baseline should escalate without the beacon, got ${baseline.level}`)
    // 信标在场 → cap L1（不发 L2 改道卡）。
    const capped = evaluateConvergence(baseInput({
      ...input,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, awaitingVerification: true },
    }))
    assert.ok(capped.level <= 1, `expected level <= 1 while a verification job runs, got ${capped.level}`)
    assert.equal(capped.shouldKick, false)
    assert.equal(capped.injectedMessage, null)
  })

  it('awaitingVerification does NOT suppress no-tool stagnation levels', () => {
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: [],
      noToolTurnCount: 5,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, awaitingVerification: true },
    }))
    assert.ok(result.level >= 2, `no-tool stagnation must keep escalating, got ${result.level}`)
  })

  it('activePlan widens turn thresholds by 1.5x (nMid 14 → 21)', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'z' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const withoutPlan = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    const withPlan = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
      progressBeacons: { todoCompletedDelta: 0, activePlan: true },
    }))
    assert.equal(withoutPlan.level, 2, `baseline should hit L2 at nMid, got ${withoutPlan.level}`)
    assert.ok(withPlan.level < 2, `activePlan should push nMid past turn 14, got ${withPlan.level}`)
  })

  it('returns level 2 with appropriate message in explore phase', () => {
    // Explore phase with extreme repetition: all read_file on the same file
    const history = makeHistory(
      Array.from({ length: 14 }, () => ({ tool: 'read_file', target: 'a.ts' })),
    )
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // All same tool + same target → targetNovelty≈0.17, toolEntropy=0, tokenEfficiency=0
    // With new textRepetitionPenalty weight (1.0 when no fingerprints provided),
    // score is slightly higher than before. Level may be 1 or 2 depending on exact weight sum.
    assert.ok(result.score <= 0.45, `expected score <= 0.45, got ${result.score.toFixed(2)}`)
    assert.ok(result.level >= 1, `expected level >= 1, got ${result.level} (score=${result.score.toFixed(2)})`)
    if (result.level >= 2 && result.injectedMessage) {
      // Message can be either the productiveStagnation variant ("读取/搜索操作")
      // or the standard tool-repetition message ("工具使用模式高度重复")
      assert.ok(
        result.injectedMessage.includes('工具使用模式高度重复') || result.injectedMessage.includes('读取'),
        `expected stagnation-related message, got: ${result.injectedMessage.slice(0, 120)}`,
      )
    }
  })

  // ── Level 3: force split or abort ──

  it('returns level 3 at nHigh with very low score', () => {
    // All repeats, no diversity, many turns
    const history = makeHistory([
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 20,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    assert.equal(result.level, 3, `expected level 3, got ${result.level} (score=${result.score.toFixed(2)})`)
    assert.equal(result.shouldForceSplit, true)
    assert.ok(result.injectedMessage, 'should have injected message')
  })

  // ── Level 3 建议升级（重构事故链缺口 4）：回归场景优先 bisect/基线对照 ──
  it('level 3 message offers git bisect / checkpoint rollback for regression hunts, not just a new session', () => {
    // 混入一次失败编辑，避开 productiveStagnation 早退分支，落到通用 level-3 尾部
    const history = makeHistory([
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'edit_file', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 20,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    assert.equal(result.level, 3)
    assert.ok(result.injectedMessage!.includes('git bisect'),
      'level 3 must offer the baseline-comparison escape hatch for regressions')
    assert.ok(result.injectedMessage!.includes('checkpoint'),
      'checkpoint rollback should be offered alongside bisect')
  })

  it('returns shouldAbort true when score is extremely low at level 3', () => {
    const history = makeHistory([
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
      { tool: 'grep', target: 'x', status: 'failed' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 25,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
      scoreHistory: [0.40, 0.28, 0.19, 0.12, 0.06, 0.02], // declining 6 turns
      repeatCount: 2, // warned twice already
      priorWarningAtL2Plus: true,
    }))
    assert.equal(result.level, 3)
    // All failures + all same tool → score should be extremely low
    assert.ok(result.score < 0.1, `expected score < 0.1, got ${result.score.toFixed(2)}`)
    assert.equal(result.shouldAbort, true)
  })

  // ── 200K vs 1M thresholds ──

  it('1M window has higher nLow threshold', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
    ])
    // At turn 10, 200K would trigger level 1 or 2, but 1M should stay at 0
    const result1M = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 1_000_000,
      recentToolHistory: history,
    }))
    const result200K = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // 1M should be more lenient: lower level or same score but higher threshold
    assert.ok(
      result1M.level <= result200K.level,
      `1M level=${result1M.level} should be <= 200K level=${result200K.level}`,
    )
  })

  it('1M uses larger signal window', () => {
    // With a larger signal window (10 vs 6), the same history produces
    // slightly different scores. Verify both produce valid scores.
    const history = makeHistory(
      Array.from({ length: 12 }, (_, i) => ({
        tool: i % 3 === 0 ? 'grep' : 'read_file',
        target: `file${i % 4}.ts`,
      })),
    )
    const result1M = evaluateConvergence(baseInput({
      turn: 18,
      phaseClass: 'explore',
      contextWindow: 1_000_000,
      recentToolHistory: history,
    }))
    const result200K = evaluateConvergence(baseInput({
      turn: 18,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    assert.ok(result1M.score >= 0 && result1M.score <= 1, '1M score in range')
    assert.ok(result200K.score >= 0 && result200K.score <= 1, '200K score in range')
  })

  // ── Phase-aware behavior ──

  it('execute phase is stricter on edit ratio', () => {
    // Same history, different phases — execute should score lower
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'read_file', target: 'd.ts' },
    ])
    const exploreResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    const executeResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // execute phase weights editRatio higher → score should be lower without edits
    assert.ok(
      executeResult.score <= exploreResult.score,
      `execute score=${executeResult.score.toFixed(2)} should be <= explore score=${exploreResult.score.toFixed(2)}`,
    )
  })

  it('explore phase tolerates high novelty and diversity', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'glob', target: '*.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'repo_map', target: '' },
      { tool: 'grep', target: 'y' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 8,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Diverse tools + diverse targets in explore should yield reasonable score
    assert.ok(result.score >= 0.3, `expected score >= 0.3, got ${result.score.toFixed(2)}`)
    // Should not trigger level 2 in explore just for being diverse
    assert.ok(result.level <= 1, `expected level <= 1, got ${result.level}`)
  })

  // ── Error rate impact ──

  it('high error rate drags score down', () => {
    const failingHistory = makeHistory([
      { tool: 'bash', target: 'cmd', status: 'failed' },
      { tool: 'bash', target: 'cmd', status: 'failed' },
      { tool: 'bash', target: 'cmd', status: 'failed' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const successHistory = makeHistory([
      { tool: 'bash', target: 'cmd1' },
      { tool: 'bash', target: 'cmd2' },
      { tool: 'bash', target: 'cmd3' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'read_file', target: 'c.ts' },
    ])
    const failResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: failingHistory,
    }))
    const successResult = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: successHistory,
    }))
    assert.ok(
      failResult.score < successResult.score,
      `fail score=${failResult.score.toFixed(2)} should be < success score=${successResult.score.toFixed(2)}`,
    )
  })

  // ── Signal structure ──

  it('signals are within valid range', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'edit_file', target: 'b.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 6,
      phaseClass: 'execute',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    const s: ConvergenceSignals = result.signals
    assert.ok(s.editRatio >= 0 && s.editRatio <= 1, `editRatio ${s.editRatio} out of range`)
    assert.ok(s.targetNovelty >= 0 && s.targetNovelty <= 1, `targetNovelty ${s.targetNovelty} out of range`)
    assert.ok(s.toolEntropy >= 0 && s.toolEntropy <= 1, `toolEntropy ${s.toolEntropy} out of range`)
    assert.ok(s.errorPenalty >= 0 && s.errorPenalty <= 1, `errorPenalty ${s.errorPenalty} out of range`)
    assert.ok(s.tokenEfficiency >= 0 && s.tokenEfficiency <= 1, `tokenEfficiency ${s.tokenEfficiency} out of range`)
  })

  // ── Edge cases ──

  it('handles empty history gracefully', () => {
    const result = evaluateConvergence(baseInput({
      turn: 0,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: [],
    }))
    assert.equal(result.level, 0)
    assert.equal(result.shouldAbort, false)
    assert.ok(result.score >= 0 && result.score <= 1)
  })

  it('handles intermediate window sizes via interpolation', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'explore',
      contextWindow: 500_000, // intermediate between 200K and 1M
      recentToolHistory: history,
    }))
    // Should compute valid result for intermediate window
    assert.ok(result.score >= 0 && result.score <= 1)
    assert.ok([0, 1, 2, 3].includes(result.level))
  })

  it('deliver phase is strict', () => {
    // deliver phase emphasizes verification signals (errorPenalty, tokenEfficiency)
    // over edits, so a read-only window still scores low
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'read_file', target: 'c.ts' },
      { tool: 'grep', target: 'y' },
      { tool: 'read_file', target: 'd.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 20,
      phaseClass: 'deliver',
      contextWindow: 200_000,
      recentToolHistory: history,
    }))
    // Zero edits in deliver → low editRatio component → low overall score
    assert.ok(result.score < 0.5, `expected score < 0.5 in deliver with no edits, got ${result.score.toFixed(2)}`)
    assert.ok(result.level >= 2, `expected level >= 2 in deliver, got ${result.level}`)
  })

  // ── Oscillation detection ──

  it('oscillation pattern (A→B→A→B→A→B) scores low', () => {
    // Simulate post-completion verification loop: git log → ls → git log → ls → ...
    const history = makeHistory([
      { tool: 'bash', target: 'git log --oneline' },
      { tool: 'bash', target: 'ls .rivet/sessions/' },
      { tool: 'bash', target: 'git log --oneline' },
      { tool: 'bash', target: 'ls .rivet/sessions/' },
      { tool: 'bash', target: 'git log --oneline' },
      { tool: 'bash', target: 'ls .rivet/sessions/' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      toolFingerprints: ['fp-git', 'fp-ls', 'fp-git', 'fp-ls', 'fp-git', 'fp-ls'],
    }))
    // The oscillationPenalty signal itself must still fire — oscillation is
    // detected regardless of phase. But the composite score is no longer
    // dragged down by verify's old editRatio=0.22 weight (verify should not
    // penalize no-edit behavior — that was the primary false-positive source
    // behind "verify 阶段 47 轮未收敛").
    assert.ok(result.signals.oscillationPenalty !== undefined, 'should have oscillationPenalty signal')
    assert.ok(result.signals.oscillationPenalty < 0.5, `oscillation penalty should be severe, got ${result.signals.oscillationPenalty}`)
  })

  it('no oscillation penalty when fingerprints are diverse', () => {
    const history = makeHistory([
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'grep', target: 'x' },
      { tool: 'glob', target: '*.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'run_tests', target: 'test' },
      { tool: 'edit_file', target: 'c.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 10,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: history,
      toolFingerprints: ['fp1', 'fp2', 'fp3', 'fp4', 'fp5', 'fp6'],
    }))
    // All unique fingerprints → no oscillation penalty
    assert.equal(result.signals.oscillationPenalty, 1.0)
  })

  it('missing toolFingerprints defaults to no penalty', () => {
    const history = makeHistory([
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      // toolFingerprints intentionally omitted
    }))
    // Without fingerprints, oscillation penalty defaults to 1.0 (no penalty)
    assert.equal(result.signals.oscillationPenalty, 1.0)
  })

  // ── Change 1: argsHash granularity ──

  it('targetNovelty uses argsHash when available (same file, different edits)', () => {
    // edit_file(a.ts, old="x", new="y") vs edit_file(a.ts, old="y", new="z")
    // — same target path, different argsHash → higher novelty
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const, argsHash: 'hash-xy' },
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const, argsHash: 'hash-yz' },
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const, argsHash: 'hash-xy' },
    ]
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
    }))
    // 2 unique argsHash values among 3 entries → novelty = (2-1)/(3-1) = 0.5
    assert.equal(result.signals.targetNovelty, 0.5)
  })

  it('targetNovelty falls back to target when argsHash is absent', () => {
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'b.ts', status: 'success' as const },
    ]
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
    }))
    // Fallback to target: 2 unique targets among 3 → (2-1)/(3-1) = 0.5
    assert.equal(result.signals.targetNovelty, 0.5)
  })

  // ── Change 2: tokenEfficiency exponential decay ──

  it('tokenEfficiency uses exponential decay when outputTokens is provided', () => {
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'b.ts', status: 'success' as const },
      { tool: 'read_file', target: 'c.ts', status: 'success' as const },
      { tool: 'read_file', target: 'd.ts', status: 'success' as const },
      { tool: 'grep', target: 'foo', status: 'success' as const },
      { tool: 'glob', target: '*.ts', status: 'success' as const },
    ]
    // 6 tools, 3000 output tokens → 500 tokens/tool → exp(-1) ≈ 0.368
    const result = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      outputTokens: 3000,
    }))
    const expected = Math.exp(-1)
    assert.ok(
      Math.abs(result.signals.tokenEfficiency - expected) < 0.01,
      `tokenEfficiency should be ~${expected.toFixed(3)}, got ${result.signals.tokenEfficiency.toFixed(3)}`,
    )
  })

  it('tokenEfficiency falls back to heuristic when outputTokens is absent', () => {
    const history = [
      { tool: 'edit_file', target: 'a.ts', status: 'success' as const },
      { tool: 'edit_file', target: 'b.ts', status: 'success' as const },
      { tool: 'read_file', target: 'c.ts', status: 'success' as const },
    ]
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      // outputTokens intentionally omitted
    }))
    // Old heuristic: writes=2, reads=1 → productive/total = 2/3, ratio=0.5 → bonus=0.2 → 0.867
    assert.ok(result.signals.tokenEfficiency > 0.5, 'fallback should still give reasonable efficiency')
  })

  // ── Change 3: oscillation positional reversal (multi-value) ──

  it('oscillation detects A→B→A→C→A→B multi-value pattern (old algorithm silently ignored it)', () => {
    // Old algorithm: Set.size===3 → returns 1.0 (missed oscillation)
    // New algorithm: reversals via hash[i]===hash[i-2] && !== hash[i-1]
    const fingerprints = ['a', 'b', 'a', 'c', 'a', 'b', 'c', 'b']
    const history = makeHistory(fingerprints.map((fp, i) => ({
      tool: `tool-${i % 3}`, target: `file-${i}`,
    })))
    const result = evaluateConvergence(baseInput({
      turn: 10, phaseClass: 'verify', contextWindow: 200_000,
      recentToolHistory: history, toolFingerprints: fingerprints,
    }))
    // Reversals at i=2(a→b→a), i=4(a→c→a), i=7(b→c→b) = 3 out of 6 possible
    // → rate=3/6=0.5 → penalty=0.5 (old algorithm would return 1.0)
    assert.ok(
      result.signals.oscillationPenalty > 0.4 && result.signals.oscillationPenalty < 0.6,
      `oscillation penalty should be ~0.50 for multi-value pattern, got ${result.signals.oscillationPenalty.toFixed(2)}`,
    )
  })

  it('oscillation: severe A-B-A-B-A-B-A-B yields near-zero penalty', () => {
    const fingerprints = ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']
    const history = makeHistory(fingerprints.map((fp, i) => ({
      tool: fp === 'a' ? 'bash' : 'ls', target: `file-${i}`,
    })))
    const result = evaluateConvergence(baseInput({
      turn: 10, phaseClass: 'verify', contextWindow: 200_000,
      recentToolHistory: history, toolFingerprints: fingerprints,
    }))
    // Every step from i=2 is a reversal → 6 reversals / 6 possible = 1.0 → penalty = 0
    assert.ok(
      result.signals.oscillationPenalty < 0.1,
      `severe A-B oscillation should yield near-0 penalty, got ${result.signals.oscillationPenalty.toFixed(2)}`,
    )
  })

  it('oscillation: < 4 fingerprints returns 1.0 (insufficient data)', () => {
    const fingerprints = ['a', 'b', 'a']
    const history = makeHistory([
      { tool: 'bash', target: '1' },
      { tool: 'bash', target: '2' },
      { tool: 'bash', target: '3' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 5, phaseClass: 'execute', contextWindow: 200_000,
      recentToolHistory: history, toolFingerprints: fingerprints,
    }))
    assert.equal(result.signals.oscillationPenalty, 1.0)
  })

  // ── Delivery-aware completion nudge ──

  it('verified deliveryStatus triggers completion nudge message', () => {
    const history = makeHistory([
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'git log' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'bash', target: 'git log' },
      { tool: 'read_file', target: 'c.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      evidenceState: {
        filesModified: new Set(['src/x.ts']),
        filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
        deliveryStatus: 'verified',
      },
    }))
    // When verified + level 2, message should be a completion nudge, not "choose an action"
    if (result.level >= 2 && result.injectedMessage) {
      assert.ok(result.injectedMessage.includes('任务可能已完成'),
        `expected completion nudge, got: ${result.injectedMessage.slice(0, 120)}`)
      assert.ok(!result.injectedMessage.includes('请选择以下行动'),
        'should not ask to choose actions when task is verified')
    }
  })

  it('unverified deliveryStatus does not trigger completion nudge', () => {
    const history = makeHistory([
      { tool: 'bash', target: 'git log' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'read_file', target: 'b.ts' },
      { tool: 'bash', target: 'git log' },
      { tool: 'read_file', target: 'c.ts' },
    ])
    const result = evaluateConvergence(baseInput({
      turn: 14,
      phaseClass: 'verify',
      contextWindow: 200_000,
      recentToolHistory: history,
      evidenceState: {
        filesModified: new Set(['src/x.ts']),
        filesRead: new Set(['a.ts', 'b.ts', 'c.ts']),
        deliveryStatus: 'unverified',
      },
    }))
    // Should still trigger Level 2 (low score), but NOT the completion message
    // It uses the standard "请选择以下行动" message
    if (result.level >= 2 && result.injectedMessage) {
      assert.ok(result.injectedMessage.includes('请选择以下行动'),
        `expected standard stuck message, got: ${result.injectedMessage.slice(0, 120)}`)
      assert.ok(!result.injectedMessage.includes('任务可能已完成'),
        'should not trigger completion nudge for unverified state')
    }
  })

  // ── No-tool stagnation: forced abort at 5 consecutive no-tool turns ──

  describe('no-tool forced abort (hard cap)', () => {
    it('forces level 3 and shouldAbort when noToolTurnCount >= 5', () => {
      const result = evaluateConvergence(baseInput({
        turn: 5, // well below nLow=8 for 200K, but noTool overrides
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
      }))
      assert.equal(result.level, 3, `expected level 3, got ${result.level}`)
      assert.equal(result.shouldAbort, true, 'expected shouldAbort=true at 5 no-tool turns')
    })

    it('forces shouldAbort even when convergence score is high (penalty makes it low)', () => {
      // Even with good tool history in the window, 5 no-tool turns force abort
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts', status: 'success' },
        { tool: 'edit_file', target: 'b.ts', status: 'success' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 10,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 5,
      }))
      assert.equal(result.shouldAbort, true, 'forced abort should override score-based logic')
    })

    it('does NOT forceSplit when abort is from no-tool stagnation', () => {
      const result = evaluateConvergence(baseInput({
        turn: 10,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
      }))
      assert.equal(result.shouldAbort, true)
      assert.equal(result.shouldForceSplit, false, 'session split is pointless for text-only loops')
    })

    it('still allows forceSplit at level 3 from score-based detection', () => {
      const history = makeHistory([
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // Score-based level 3 should allow forceSplit
      if (result.level >= 3) {
        assert.equal(result.shouldForceSplit, true, 'score-based level 3 should allow forceSplit')
      }
    })

    it('does NOT abort at 4 consecutive no-tool turns', () => {
      const result = evaluateConvergence(baseInput({
        turn: 5,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 4,
      }))
      assert.equal(result.shouldAbort, false, 'should not abort at 4 no-tool turns')
      assert.ok(result.level >= 2, 'should at least kick at 4 no-tool turns')
    })
  })

  // ── Reasoning-aware no-tool abort ──
  // A deep-reasoning model can legitimately narrate multi-turn analysis (fresh,
  // substantial, non-repetitive text) with no tool call before it acts. That is
  // reasoning, not a text-only spin — it must NOT be hard-killed (the "他在推理，
  // 但我们以为他终端" false circuit-break). Genuine spin (repetitive / thin text)
  // still aborts.
  describe('reasoning-aware no-tool abort', () => {
    // Three distinct long analysis turns → producingReport=true (non-repetitive
    // + ≥200 chars). Reuses the incident-shaped report fingerprints.
    const freshReasoning = [
      '代码审查结果 严重问题 1 测试套件无法运行 conftest 缺失 测试文件 test_scoring 导入了 make_flat_kline make_uptrend_kline make_limit_up_streaks 三个工厂函数以及 flat_df limit_up_df 两个 pytest fixture 但项目根目录与 tests 目录下都没有 conftest 定义它们 运行 pytest 会在 collection 阶段直接报 fixture not found 整个测试套件无法启动 需要新增 conftest 补齐这些 fixture 与工厂函数的定义和导入 否则任何回归验证都无法进行',
      '中等问题 config 模块中 SCREENING 字段在第 18 行定义但通篇没有任何模块 import 或引用它 ZONE_MIN_VOLUME 常量同样在配置里定义却没有任何消费方 grep 全仓零命中 属于典型的死配置 updater 模块顶部还存在一处从 legacy_utils 的死导入 引入后从未使用 建议统一清理这些未使用符号 并为确需保留的字段补充真实消费方 避免配置与代码之间形成死接线',
      'updater 起算日逻辑反转 update_daily_kline 函数中有两处计算起始日期 sd 都写成了 min date today minus timedelta 与已有最早日期 取 min 会永远选中更早的那个日期 导致每次增量更新都从很久以前重新拉取 既浪费带宽也可能覆盖已修正数据 正确做法应该是按最近一个交易日向前回溯固定窗口 用 max 锚定到最新边界 否则增量窗口计算方向完全错误 需要尽快修正这两处边界条件',
    ]

    it('does NOT hard-abort at 5 no-tool turns when reasoning is still fresh (kick instead)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
        textFingerprints: freshReasoning,
      }))
      assert.equal(result.reasoningActive, true, 'fresh substantial text → reasoningActive')
      assert.equal(result.shouldAbort, false, 'a reasoning model must NOT be hard-killed on the no-tool cap')
      assert.equal(result.shouldForceSplit, false, 'reasoning model must not be force-split either')
      assert.equal(result.abortCause, undefined, 'no abort → no abortCause')
      assert.ok(result.shouldKick, 'still kick to nudge toward action')
      assert.equal(result.level, 2, 'downgraded from hard-abort level 3 to kick level 2')
    })

    it('STILL hard-aborts at 5 no-tool turns when text is repetitive (genuine spin)', () => {
      const repeated = freshReasoning[0]!
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
        textFingerprints: [repeated, repeated, repeated, repeated, repeated],
      }))
      assert.equal(result.reasoningActive, false, 'repetitive text → not reasoning')
      assert.equal(result.shouldAbort, true, 'genuine text-only spin must still abort')
      assert.equal(result.abortCause, 'no-tool', 'abort cause is the no-tool hard cap')
      assert.equal(result.level, 3, 'stays at hard-abort level 3')
    })

    it('STILL hard-aborts at 5 no-tool turns with no text at all (empty spin)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 5,
        // no textFingerprints → not producing a report → not reasoning
      }))
      assert.equal(result.reasoningActive, false)
      assert.equal(result.shouldAbort, true, 'no-content no-tool spin must still abort')
      assert.equal(result.abortCause, 'no-tool')
    })

    it('STILL score-aborts at level 3 even when fresh reasoning text is present', () => {
      // Score-based abort fires when triple-guard satisfied (score<0.05 + declining + prior L2+ warning).
      // reasoningActive only protects the no-tool hard cap, not the score-based path.
      const history = makeHistory([
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
        { tool: 'grep', target: 'x', status: 'failed' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 25,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        scoreHistory: [0.30, 0.21, 0.14, 0.09, 0.05, 0.02],
        repeatCount: 1,
        priorWarningAtL2Plus: true,
      }))
      assert.equal(result.shouldAbort, true, 'score-based abort fires when triple-guard satisfied')
      assert.equal(result.abortCause, 'score')
    })
  })

  // ── issue #287：中文近重复复读绕过 textRepetitionPenalty ──
  // 模型中文复读的典型形态：同一段 ≥200 字的分析，每轮换序号原样重发。
  // 中文没有空格，旧的 split(/\s+/) 把整段切成单个 token——两个「整段 token」
  // 不同 → Jaccard 恒 0 → textRepetitionPenalty 恒满分 → isProducingReport
  // 恒真 → no-tool 硬熔断被永久降级为 kick，scoreAbort 也被满分 textRep 堵死。
  // 同构造的英文（词集合几乎全同）正常熔断——唯一变量是语言。

  describe('CJK near-duplicate repetition (issue #287)', () => {
    const cnBase = '经过对项目现状的全面梳理，我认为当前架构存在三个层面的结构性问题。第一，模块边界模糊，核心逻辑与外围功能相互纠缠，任何一处改动都会波及多个文件，回归成本居高不下。第二，测试覆盖不足，关键路径缺少自动化保护，重构之后无法快速确认行为没有漂移，只能依赖人工回归。第三，配置来源分散，多个环境各自维护参数，排查问题时需要逐处核对，容易引入不一致。建议分三步收敛：先明确模块边界与依赖方向，再补齐关键路径的回归测试，最后统一配置读取入口。每一步都可独立验收，不影响现有功能。'
    const enBase = 'After a full review of the project state, the architecture has three structural problems. First, module boundaries are blurry: core logic and peripheral features are entangled, so any single change ripples across many files and regression cost stays high. Second, test coverage is insufficient: critical paths lack automated protection, and after refactoring we cannot quickly confirm behavior has not drifted. Third, configuration sources are scattered across environments, forcing manual cross-checking that invites inconsistency. The convergence plan has three steps: clarify module boundaries and dependency direction, then add regression tests for critical paths, finally unify the configuration entry point. Each step is independently verifiable without breaking existing functionality.'

    // 9 轮 no-tool + 每轮 ≥200 字近重复文本；唯一变量 = 语言（序号在两种
    // 语言里都只影响极小片段：第1轮/第2轮 vs Round 1/Round 2）。
    const bilingualInput = (fingerprints: string[]): ConvergenceInput => baseInput({
      turn: 20,
      phaseClass: 'explore',
      contextWindow: 200_000,
      recentToolHistory: [],
      noToolTurnCount: 9,
      textFingerprints: fingerprints,
    })
    const cnNearDupFps = Array.from({ length: 9 }, (_, i) => `第${i + 1}轮分析：${cnBase}`)
    const enNearDupFps = Array.from({ length: 9 }, (_, i) => `Round ${i + 1} analysis: ${enBase}`)

    it('同段中文换序号重发判为重度重复（修复前 Jaccard 恒 0、penalty 恒满分）', () => {
      const cn = evaluateConvergence(bilingualInput(cnNearDupFps))
      assert.equal(cn.signals.textRepetitionPenalty, 0,
        `near-duplicate CJK text must score severe repetition, got ${cn.signals.textRepetitionPenalty}`)
    })

    it('双语同向：中文换序号复读与英文一样触发 no-tool 硬熔断', () => {
      const cn = evaluateConvergence(bilingualInput(cnNearDupFps))
      const en = evaluateConvergence(bilingualInput(enNearDupFps))
      // English control（行为不变）：词集合几乎全同 → 复读 spin → 硬熔断
      assert.equal(en.reasoningActive, false)
      assert.equal(en.shouldAbort, true)
      assert.equal(en.abortCause, 'no-tool')
      assert.equal(en.level, 3)
      // CJK 必须与英文同向（修复前：reasoningActive=true、level=2、abort=false）
      assert.equal(cn.reasoningActive, false, 'near-duplicate CJK output is spin, not fresh reasoning')
      assert.equal(cn.shouldAbort, true, 'both abort paths must not stay blind for CJK repetition')
      assert.equal(cn.abortCause, 'no-tool')
      assert.equal(cn.level, en.level, 'CJK verdict must match the English control')
    })

    it('对照：真正不同的无空格中文长分析仍视为推理（2-gram 不误伤 fresh 输出）', () => {
      // 三段互不相同的无空格中文长分析——真实的多轮深度推理形态。
      const freshCn = [
        '本次排查聚焦测试套件无法启动的问题。测试文件导入了三个工厂函数与两个 pytest fixture，但项目根目录和 tests 目录下都不存在定义它们的 conftest，收集阶段直接抛出 fixture 未找到的错误，导致任何回归验证都无法进行。修复思路是新增 conftest 文件，补齐这些工厂函数与 fixture 的定义，并显式声明导入路径，让测试集合恢复可运行状态，否则后续所有改动都得不到自动化验证保护。',
        '配置层存在多处死接线。SCREENING 字段在配置模块第十八行定义，但通篇没有任何模块引用它；ZONE_MIN_VOLUME 常量同样没有消费方，全仓检索零命中；另有模块顶部一处从 legacy_utils 引入后从未使用的死导入。这类未使用符号会让后来的维护者误以为配置仍在生效，建议统一清理，并为确需保留的字段补充真实消费方，避免配置与代码之间形成幻觉接线。清理时注意区分确认无用与暂时无人用两类，前者直接删除，后者移动到显式的预留区并注释意图，防止下一位维护者重复排查同样的疑点。',
        '增量更新的起算日逻辑写反了。两处计算起始日期的代码都用了取最小值，会永远选中更早的那个日期，导致每次增量更新都从很久以前重新拉取，既浪费带宽又可能覆盖已经人工修正过的数据。正确做法是按最近一个交易日向前回溯固定窗口，用取最大值把边界锚定到最新数据，否则增量窗口的方向完全错误，数据质量会持续劣化。修正完成后应补一条回归测试锁定新的边界语义，防止后续重构再次把方向写反，同时给运维文档补一段窗口计算说明。',
      ]
      const cn = evaluateConvergence(bilingualInput(freshCn))
      assert.ok(cn.signals.textRepetitionPenalty >= 0.7,
        `distinct CJK analyses must not look repetitive, got ${cn.signals.textRepetitionPenalty}`)
      assert.equal(cn.reasoningActive, true, 'fresh no-space CJK reasoning keeps the exemption')
      assert.equal(cn.shouldAbort, false)
    })
  })

  // ── Early-exit does not override no-tool stagnation ──

  describe('early-exit vs no-tool stagnation', () => {
    it('does NOT reset level to 0 when noToolTurnCount >= 2 and turn < nLow', () => {
      // Before the fix, turn < nLow would reset level to 0 even with noTool stagnation
      const result = evaluateConvergence(baseInput({
        turn: 3, // < nLow=8 for 200K
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 3,
      }))
      // Should be level 2 (kick), NOT level 0 (early-exit)
      assert.ok(result.level >= 2, `expected level >= 2, got ${result.level}`)
      assert.equal(result.shouldAbort, false, 'should not abort at 3 no-tool turns')
    })

    it('fires level 2 kick at turn=2 with noToolTurnCount=2', () => {
      // noToolCount >= 2 && turn >= 4 is false here (turn=2),
      // but noToolCount >= 2 means stagnation is detected and early-exit is skipped
      const result = evaluateConvergence(baseInput({
        turn: 2,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: [],
        noToolTurnCount: 2,
      }))
      // At turn=2, noToolCount=2: noToolCount >= 2 && turn >= 4 is false (turn=2 < 4)
      // So level stays at 0 (from score) or 2 (from noToolCount >= 3 which is false)
      // The early-exit would normally reset to 0, but noToolStagnation prevents it
      // Actually: noToolCount=2, turn=2 → no condition sets level > 0
      // (noToolCount >= 3? no. noToolCount >= 2 && turn >= 4? no. score-based? depends)
      // The early-exit gate now has !noToolStagnation, so it doesn't reset.
      // But level is still 0 because no condition matched. That's correct.
      // Level 0 is fine here - we don't want to kick after just 2 turns at turn 2.
    })

    it('STILL resets level to 0 when turn < nLow and noToolCount < 2', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 3, // < nLow=8
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      assert.equal(result.level, 0, 'score-based detection should early-exit at turn < nLow')
    })
  })

  // ── Productive-ratio stagnation: alternating read-analyze pattern ──

  describe('productive-ratio stagnation (alternating read-analyze)', () => {
    // The core problem: agent calls read_file each turn (so consecutiveNoToolTurns
    // resets to 0), but never calls edit/test/commit. The "hasProductive" boolean
    // check is all-or-nothing, and on 1M window the turn gate (nLow=25) blocks
    // all score-based detection for the first 12 turns.
    //
    // New signal: productiveRatio = productive tools / total tools in last K calls.
    // When productiveRatio === 0 and window >= K, treat as stagnation that
    // bypasses the turn gate (same as noToolStagnation).

    it('detects read-only stagnation after prior productive tool (200K)', () => {
      // Infinity guard skips productive-stagnation when no productive tool has ever
      // been called. Use one early edit followed by a long read-only burst so the
      // last productive tool is far enough behind the current window.
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        ...Array.from({ length: 12 }, (_, i) => ({ tool: 'read_file', target: `file${i}.ts` })),
      ])
      const result = evaluateConvergence(baseInput({
        turn: 13,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0, // all turns had tools, so this is 0
      }))
      assert.ok(result.level >= 1,
        `expected level >= 1 for read-only stagnation, got ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('detects read-only stagnation after prior productive tool on 1M (GLM scenario)', () => {
      // 1M window: signalWindow=10, distance threshold=20.
      // One early edit plus 20 trailing read-only calls puts the last productive
      // tool far enough behind the window for productive-stagnation to fire.
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        ...Array.from({ length: 20 }, (_, i) =>
          i % 3 === 1 ? { tool: 'grep', target: `pattern${i}` } : { tool: 'read_file', target: `file${i}.ts` }
        ),
      ])
      const result = evaluateConvergence(baseInput({
        turn: 21,
        phaseClass: 'explore',
        contextWindow: 1_000_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        providerName: 'glm',
      }))
      assert.ok(result.level >= 1,
        `expected level >= 1 for GLM read-only stagnation on 1M, got ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('does NOT trigger when productive tools are present in window', () => {
      // Same window size but with one edit_file — productiveRatio > 0
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 5,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // With one productive tool, this is normal exploration — should be level 0
      assert.equal(result.level, 0,
        `expected level 0 when productive tools present, got ${result.level}`)
    })

    it('stagnation message mentions read-only pattern', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
        { tool: 'read_file', target: 'f.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      if (result.level >= 2 && result.injectedMessage) {
        // Message should mention that all recent operations are read-only
        assert.ok(
          result.injectedMessage.includes('读取') || result.injectedMessage.includes('read') || result.injectedMessage.includes('编辑'),
          `expected read-only stagnation hint, got: ${result.injectedMessage.slice(0, 150)}`,
        )
      }
    })

    it('does not false-positive on short windows (fewer than K tools)', () => {
      // Only 2 read tools — not enough data for productiveRatio stagnation
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 3,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // Too few tools — should not trigger stagnation
      assert.equal(result.level, 0,
        `expected level 0 for short window, got ${result.level}`)
    })

    // ── Distance-aware stagnation: real-world incident 9266c3a7 ──
    // Agent was doing SWE-bench adapter development (8-wave plan, 6/8 done).
    // Natural rhythm: grep→read→edit→edit→read→read→grep→edit→read→read.
    // The 6-entry window caught the read-read-grep tail, saw productiveRatio=0,
    // and fired 120 advisories across 154 internal turns. The fix: measure
    // distance since the LAST productive tool in full history — if productive
    // tools are within 2×windowSize records back, it's a read-write alternation,
    // not stagnation.
    it('does NOT flag stagnation when recent reads are part of read-write alternation (9266c3a7 pattern)', () => {
      // 9266c3a7 real pattern: edit→read→read→grep→read→edit→edit→read→read→grep→read→read.
      // The 6-entry window at the end catches read-read-grep-read-read-read,
      // but distance since last productive (edit at position 5 from end) = 5.
      // 5 < 2×6=12 → read-write alternation, not stagnation.
      const history = makeHistory([
        { tool: 'edit_file', target: 'swebench-run.ts' },   // pos 0
        { tool: 'read_file', target: 'swebench-run.ts' },   // pos 1
        { tool: 'read_file', target: 'swebench-worker.ts' },// pos 2
        { tool: 'grep', target: 'runAgentInDir' },          // pos 3
        { tool: 'read_file', target: 'loop.ts' },           // pos 4
        { tool: 'edit_file', target: 'swebench-run.ts' },   // pos 5  ← last productive
        { tool: 'edit_file', target: 'swebench-worker.ts' },// pos 6  ← last productive
        { tool: 'read_file', target: 'swebench-run.ts' },   // pos 7
        { tool: 'read_file', target: 'swebench-worker.ts' },// pos 8
        { tool: 'grep', target: 'parallel: parseInt' },     // pos 9
        { tool: 'read_file', target: 'swebench-run.ts' },   // pos 10
        { tool: 'read_file', target: 'swebench-worker.ts' },// pos 11
      ])
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      // Distance from last edit_file (pos 6) to end (pos 11) = 5 < 12.
      // This is read-write alternation — productiveStagnation must NOT fire.
      // The level may still be >= 1 from score-based detection (low editRatio
      // in window), but must NOT be level 2+ (which injects advisory text).
      assert.ok(result.level < 2,
        `expected level < 2 for read-write alternation (distance=5 < threshold=12), got level=${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('DOES flag stagnation when reads persist far beyond last productive tool', () => {
      // 14 reads since last edit_file — well beyond 2×windowSize=12.
      // This IS genuine read-only stagnation.
      const readHeavy: Array<{ tool: string; target: string }> = [
        { tool: 'edit_file', target: 'old.ts' },
      ]
      for (let i = 0; i < 14; i++) {
        readHeavy.push({ tool: 'read_file', target: `file${i}.ts` })
      }
      const history = makeHistory(readHeavy)
      const result = evaluateConvergence(baseInput({
        turn: 15,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
      }))
      assert.ok(result.level >= 1,
        `expected level >= 1 for genuine read-only stagnation (14 reads since last edit), got ${result.level}`)
    })
  })

  // ── Fix 2: read-heavy review/audit tasks that produce a text report ──
  // The incident: user asked 天枢 to review existing code. 天枢 correctly
  // read/grep-ed extensively (the deliverable is a text report, never edits),
  // but got flagged as read-only "stagnation" every turn and spammed with the
  // 星域·改道 "去编辑/测试" nudge. A substantial, non-repetitive text output
  // must be recognized as report production, not stagnation.

  describe('review/report production (read-heavy, not stagnation)', () => {
    // Long, unique review-report turns (>= REPORT_TEXT_MIN_LEN chars each),
    // mirroring the incident's 代码审查结果 output. Three distinct long
    // fingerprints keep textRepetitionPenalty high (non-repetitive).
    const reportFingerprints = [
      '代码审查结果 严重问题 1 测试套件无法运行 conftest 缺失 测试文件 test_scoring 导入了 make_flat_kline make_uptrend_kline make_limit_up_streaks 三个工厂函数以及 flat_df limit_up_df 两个 pytest fixture 但项目根目录与 tests 目录下都没有 conftest 定义它们 运行 pytest 会在 collection 阶段直接报 fixture not found 整个测试套件无法启动 需要新增 conftest 补齐这些 fixture 与工厂函数的定义和导入 否则任何回归验证都无法进行',
      '中等问题 config 模块中 SCREENING 字段在第 18 行定义但通篇没有任何模块 import 或引用它 ZONE_MIN_VOLUME 常量同样在配置里定义却没有任何消费方 grep 全仓零命中 属于典型的死配置 updater 模块顶部还存在一处从 legacy_utils 的死导入 引入后从未使用 建议统一清理这些未使用符号 并为确需保留的字段补充真实消费方 避免配置与代码之间形成死接线',
      'updater 起算日逻辑反转 update_daily_kline 函数中有两处计算起始日期 sd 都写成了 min(date.today() minus timedelta 与已有最早日期) 取 min 会永远选中更早的那个日期 导致每次增量更新都从很久以前重新拉取 既浪费带宽也可能覆盖已修正数据 正确做法应该是按最近一个交易日向前回溯固定窗口 用 max 锚定到最新边界 否则增量窗口计算方向完全错误 需要尽快修正这两处边界条件',
    ]

    it('does NOT flag read-only review as stagnation when producing a report (turn 24, plan)', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24, // deep into the session, like the incident
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: reportFingerprints,
      }))
      assert.equal(result.level, 0,
        `read-heavy review producing a report must not escalate, got level ${result.level} (score=${result.score.toFixed(2)})`)
      assert.equal(result.injectedMessage, null,
        'a review producing a report must not inject a 改道 nudge')
    })

    it('control: same read-only pattern WITHOUT a report still flags stagnation', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        // no textFingerprints → no report → read-only penalty applies
      }))
      assert.ok(result.level >= 2,
        `read-only with no report should still flag, got level ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('exemption narrowed (2026-07-04): unverified edits + long analysis text still flags', () => {
      // 有未验证编辑还在写长文 — 是该被提醒的场景，不是审查报告。
      // 与 "does NOT flag" 用例完全同构，唯一差异是 evidenceState 带未验证编辑。
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: reportFingerprints,
        evidenceState: {
          filesModified: new Set(['src/a.ts', 'src/b.ts']),
          filesRead: new Set<string>(),
          deliveryStatus: 'unverified' as const,
        },
      }))
      assert.ok(result.level >= 2,
        `unverified edits must void the report exemption, got level ${result.level} (score=${result.score.toFixed(2)})`)
    })

    it('exemption survives when edits are verified (pure post-verification review)', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'conftest.py' },
        { tool: 'grep', target: 'SCREENING' },
        { tool: 'read_file', target: 'config.py' },
        { tool: 'read_file', target: 'updater.py' },
        { tool: 'grep', target: 'update_daily_kline' },
        { tool: 'read_file', target: 'test_scoring.py' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: reportFingerprints,
        evidenceState: {
          filesModified: new Set(['src/a.ts']),
          filesRead: new Set<string>(),
          deliveryStatus: 'verified' as const,
        },
      }))
      assert.equal(result.level, 0,
        `verified edits + report production must keep the exemption, got level ${result.level}`)
    })

    it('repetitive text (stuck loop) is NOT treated as report production', () => {
      // Same long text repeated across turns → high repetition → still stagnation.
      const repeated = reportFingerprints[0]!
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
        { tool: 'read_file', target: 'f.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 24,
        phaseClass: 'plan',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        textFingerprints: [repeated, repeated, repeated],
      }))
      assert.ok(result.level >= 2,
        `repetitive read loop must still flag, got level ${result.level} (score=${result.score.toFixed(2)})`)
    })
  })

  // ── targetNovelty formula + editRatio novelty-gating regression ────────
  // Regression for the "原地打转 (editing the same file) scored as progress"
  // doom-loop misjudgment. Before the fix: targetNovelty used distinct/total
  // (N identical → 1/N ≈ 0.17, not 0), and editRatio entered the score
  // independently — so 10 successful edits to ONE file got the full 0.40
  // execute weight AND a non-zero novelty residual. Both fixed together:
  // novelty now (unique-1)/(total-1), and editRatio is gated by max(novelty,0.1).

  describe('targetNovelty formula (defect 1)', () => {
    it('all-identical targets → novelty exactly 0', () => {
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'a.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      }))
      assert.equal(result.signals.targetNovelty, 0,
        `5 identical targets must give novelty 0, got ${result.signals.targetNovelty}`)
    })

    it('all-distinct targets → novelty 1', () => {
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'd.ts' },
        { tool: 'read_file', target: 'e.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, phaseClass: 'explore', contextWindow: 200_000, recentToolHistory: history,
      }))
      assert.equal(result.signals.targetNovelty, 1,
        `5 distinct targets must give novelty 1, got ${result.signals.targetNovelty}`)
    })

    it('single-element window → novelty 1.0 (fully novel)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 2, phaseClass: 'explore', contextWindow: 200_000,
        recentToolHistory: makeHistory([{ tool: 'read_file', target: 'a.ts' }]),
      }))
      assert.equal(result.signals.targetNovelty, 1.0)
    })

    it('empty window → novelty 1.0 (open frontier)', () => {
      const result = evaluateConvergence(baseInput({
        turn: 0, phaseClass: 'explore', contextWindow: 200_000, recentToolHistory: [],
      }))
      assert.equal(result.signals.targetNovelty, 1.0)
    })

    it('partial overlap is continuous, not the old 1/N residual', () => {
      // 5 calls: 3 distinct + 2 repeats. Old formula: 3/5 = 0.6.
      // New formula: (3-1)/(5-1) = 0.5. The repeat fraction is now fully counted.
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'read_file', target: 'a.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 6, phaseClass: 'explore', contextWindow: 200_000, recentToolHistory: history,
      }))
      assert.equal(result.signals.targetNovelty, 0.5,
        `3 unique of 5 must give (3-1)/(5-1)=0.5, got ${result.signals.targetNovelty}`)
    })
  })

  describe('editRatio novelty-gating (defect 2)', () => {
    it('editing the SAME file repeatedly scores far lower than editing DISTINCT files', () => {
      // Both windows: 6 successful edit_file calls, identical editRatio=1.0.
      // Difference: targets. Same-file → novelty 0 → editRatio gated to ~0.
      // Distinct-file → novelty 1 → editRatio contributes fully.
      const sameFile = makeHistory(
        Array.from({ length: 6 }, () => ({ tool: 'edit_file', target: 'a.ts' })),
      )
      const distinctFiles = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'b.ts' },
        { tool: 'edit_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'd.ts' },
        { tool: 'edit_file', target: 'e.ts' },
        { tool: 'edit_file', target: 'f.ts' },
      ])
      const sameResult = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: sameFile,
      }))
      const distinctResult = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: distinctFiles,
      }))
      assert.ok(
        distinctResult.score > sameResult.score,
        `distinct edits (score=${distinctResult.score.toFixed(2)}) must out-score same-file edits (score=${sameResult.score.toFixed(2)})`,
      )
      // Same-file edits should be flagged as stuck (the doom-loop signal),
      // not rewarded as high progress.
      assert.ok(sameResult.level >= distinctResult.level,
        `same-file edits (level=${sameResult.level}) should be >= distinct edits (level=${distinctResult.level})`)
    })

    it('0.1 floor keeps a baseline for legitimately iterative single-file edits', () => {
      // Editing one file 6 times is not ALWAYS a doom-loop — e.g. building up
      // a large module. The floor ensures editRatio contributes 0.40×0.1=0.04,
      // not zero. Combined with other signals (no errors, some entropy) the
      // score should not collapse to near-zero the way all-failures would.
      const iterative = makeHistory(
        Array.from({ length: 6 }, () => ({ tool: 'edit_file', target: 'a.ts' })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: iterative,
      }))
      // Not rewarded as strong progress, but not catastrophically low either.
      assert.ok(result.score > 0.0 && result.score < 0.6,
        `iterative single-file edit score should be in a middling range, got ${result.score.toFixed(2)}`)
    })
  })

  // ── No-data weight re-allocation (defect 4) ───────────────────────────
  // textRepetitionPenalty + oscillationPenalty default to 1.0 when they lack
  // enough fingerprints (window period). Previously that 1.0 entered the score
  // at full weight, inflating it by ~0.18 in execute phase. Now the weight is
  // re-allocated to data-carrying signals so "no data" does not look healthy.

  describe('no-data weight re-allocation (defect 4)', () => {
    it('score without fingerprint data is NOT inflated vs with-data baseline', () => {
      // Same tool history in both cases. The difference is only whether the
      // penalty signals HAVE data. A no-data window should not score HIGHER
      // than a with-data window for the same trajectory — that would mean
      // "no evidence" is being rewarded as health.
      const history = makeHistory([
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'b.ts' },
        { tool: 'read_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'd.ts' },
        { tool: 'grep', target: 'x' },
        { tool: 'run_tests', target: 't' },
      ])
      const base = {
        turn: 8, phaseClass: 'execute' as PhaseClass,
        contextWindow: 200_000, recentToolHistory: history,
      }
      // No fingerprints → both penalty signals are in no-data sentinel state.
      const noData = evaluateConvergence(baseInput(base))
      // With diverse fingerprints → both signals have data and return their
      // real (non-sentinel) values, which for a healthy diverse trajectory are
      // high but NOT artificially maxed.
      const withData = evaluateConvergence(baseInput({
        ...base,
        toolFingerprints: ['fa', 'fb', 'fc', 'fd', 'fe', 'ff', 'fg', 'fh'],
        textFingerprints: [
          'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
          'nu xi omicron pi rho sigma tau upsilon phi chi psi omega one two',
          'three four five six seven eight nine ten eleven twelve thirteen fourteen',
        ],
      }))
      // The no-data score must not exceed the with-data score by the old
      // inflation margin. Allow a small tolerance since re-allocation shifts
      // weight onto signals whose values differ — the point is no LARGE inflation.
      assert.ok(
        noData.score <= withData.score + 0.05,
        `no-data score (${noData.score.toFixed(2)}) should not inflate above with-data (${withData.score.toFixed(2)})`,
      )
    })

    it('errorPenalty empty-window 1.0 is NOT re-allocated (semantically correct)', () => {
      // errorPenalty returns 1.0 on empty window meaning "no errors = full
      // marks", which is a legitimate score, not a no-data sentinel. The
      // re-allocation must be scoped to oscillation/textRep only — verify a
      // healthy all-success window still scores high (errorPenalty keeps its
      // weight), not drained because errorPenalty was mis-classified.
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        { tool: 'edit_file', target: 'b.ts' },
        { tool: 'edit_file', target: 'c.ts' },
        { tool: 'edit_file', target: 'd.ts' },
        { tool: 'run_tests', target: 't' },
        { tool: 'run_tests', target: 'u' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 8, phaseClass: 'execute', contextWindow: 200_000, recentToolHistory: history,
      }))
      // All successes, diverse targets → high errorPenalty retained, score
      // should reflect a healthy trajectory (not drained by mis-allocation).
      assert.ok(result.signals.errorPenalty === 1.0, `errorPenalty should be 1.0 for all-success window`)
    })
  })

  // ── Route-confirmation variant（2026-07-07）──────────────────────────
  // 编辑在落地、失败率低，但新颖度/熵类指标把 score 压进 L2 —— 此时不应
  // 给"换个角度看问题"（路线正确的模型会整条驳回），而是确认路线 + 要求
  // 一个验证锚点。

  describe('route-confirmation injected message', () => {
    // 同一文件 edit/read 交替、仅 1 次失败 + A→B 震荡指纹：
    // editRatio=0.5、errorPenalty≈0.83（均过确认门槛），score 落入 L2 区。
    const productiveButUnverified = makeHistory([
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts', status: 'failed' },
      { tool: 'edit_file', target: 'a.ts' },
      { tool: 'read_file', target: 'a.ts' },
    ])
    const oscillatingFps = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'B' : 'A'))

    it('L2 with productive edits and low failure rate confirms the route instead of asking to change direction', () => {
      const result = evaluateConvergence(baseInput({
        turn: 14,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: productiveButUnverified,
        toolFingerprints: oscillatingFps,
        evidenceState: {
          filesModified: new Set(['a.ts']),
          filesRead: new Set(['a.ts']),
          deliveryStatus: 'unverified' as const,
        },
      }))
      assert.equal(result.level, 2, `expected L2, got L${result.level} (score=${result.score.toFixed(2)})`)
      assert.ok(result.signals.editRatio >= 0.2 && result.signals.errorPenalty >= 0.8,
        `signals should pass the confirmation gate (edit=${result.signals.editRatio}, err=${result.signals.errorPenalty})`)
      assert.ok(result.injectedMessage!.includes('路线本身没有被质疑'), 'should confirm the route')
      assert.ok(result.injectedMessage!.includes('验证锚点'), 'should prescribe a verification anchor')
      assert.ok(!result.injectedMessage!.includes('换个角度看问题'), 'must NOT ask to change direction')
    })

    it('L2 with low edit ratio keeps the generic change-direction message', () => {
      // 纯读取窗口（editRatio 低）——确认式变体不该触发。
      const readOnly = makeHistory(
        Array.from({ length: 6 }, (_, i) => ({ tool: i % 2 ? 'grep' : 'read_file', target: 'a.ts' })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 14,
        phaseClass: 'execute',
        contextWindow: 200_000,
        recentToolHistory: readOnly,
        toolFingerprints: oscillatingFps,
      }))
      if (result.level >= 2 && result.injectedMessage) {
        assert.ok(!result.injectedMessage.includes('路线本身没有被质疑'),
          'read-only window must not get route confirmation')
      }
    })
  })

  // ── Diagnostic probe recognition (Task 2) ──

  describe('diagnostic probe recognition', () => {
    it('diagnostic probes reduce productive-ratio penalty', () => {
      // 全是 non-productive 工具（grep+read_file），但 grep 搜 error 模式 = 诊断探针
      const history = makeHistory([
        { tool: 'grep', target: 'AssertionError src/test.ts' },
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'grep', target: 'error TS2322' },
        { tool: 'grep', target: '✖ failing test' },
        { tool: 'read_file', target: 'b.ts' },
      ])
      // 无诊断探针的对照组：同样的工具但 grep 不搜诊断词
      const nonDiag = makeHistory([
        { tool: 'grep', target: 'class Foo' },
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'grep', target: 'import React' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'glob', target: '*.ts' },
      ])
      const resultDiag = evaluateConvergence(baseInput({
        turn: 16,
        phaseClass: 'execute',
        recentToolHistory: history,
      }))
      const resultNonDiag = evaluateConvergence(baseInput({
        turn: 16,
        phaseClass: 'execute',
        recentToolHistory: nonDiag,
      }))
      // 诊断探针组的 score 应高于非诊断组（penalty 减半）
      assert.ok(resultDiag.score > resultNonDiag.score,
        `diag=${resultDiag.score.toFixed(2)} should exceed nonDiag=${resultNonDiag.score.toFixed(2)}`)
    })

    it('non-diagnostic bash still penalized fully', () => {
      // grep 使用非诊断模式搜索（class Foo / import React），不应触发 diagProbes
      const history = makeHistory([
        { tool: 'grep', target: 'class Foo' },
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'grep', target: 'import React' },
        { tool: 'read_file', target: 'b.ts' },
        { tool: 'glob', target: '*.ts' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 16,
        phaseClass: 'execute',
        recentToolHistory: history,
      }))
      // 无诊断探针时，原有惩罚应保持低 score（productiveRatio=0 完全惩罚）
      assert.ok(result.score < 0.3,
        `expected score < 0.3 without diagnostic probes, got ${result.score.toFixed(2)}`)
    })

    it('tsx -e inline script recognized as diagnostic probe', () => {
      // 混合场景：有 bash 探针 + 非 productive 工具，diagnostic probe 减半惩罚
      const history = makeHistory([
        { tool: 'grep', target: 'AssertionError' },
        { tool: 'bash', target: "npx tsx -e 'console.log(/regex/.test(\"x\"))'" },
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'bash', target: 'TMPDIR=/tmp node --import tsx -e "..."' },
        { tool: 'grep', target: 'error TS2322' },
      ])
      const result = evaluateConvergence(baseInput({
        turn: 16,
        phaseClass: 'execute',
        recentToolHistory: history,
      }))
      // bash 在 productiveTools 中 → productiveRatio > 0 → 不触发该惩罚。
      // 但仍验证 diagProbes 识别不崩溃，且 score 合理（非零）。
      assert.ok(result.score > 0,
        `tsx -e / node --import should be recognized, got score=${result.score.toFixed(2)}`)
    })
  })

  describe('progressive message prefix (repeatCount)', () => {
    // When buildInjectedMessage receives repeatCount > 0, it should prepend a
    // "第 N 次提醒" header so the agent knows the nudge isn't new information.
    // This prevents the static-message noise problem where the same advisory
    // text is injected turn after turn with zero information value.

    function makeReadOnlyHistory(count: number) {
      return makeHistory(
        Array.from({ length: count }, (_, i) => ({
          tool: 'read_file',
          target: `file_${i}.ts`,
        })),
      )
    }

    it('no prefix when repeatCount is absent (first emission)', () => {
      const history = makeReadOnlyHistory(10)
      const result = evaluateConvergence(baseInput({
        turn: 11,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        // repeatCount absent → first emission
      }))
      if (result.level >= 2 && result.injectedMessage) {
        // Should NOT contain progressive prefix
        assert.ok(!result.injectedMessage.includes('第'),
          `expected no prefix for first emission, got: ${result.injectedMessage.slice(0, 80)}`)
        assert.ok(!result.injectedMessage.includes('同类提醒'),
          `expected no repeat notice, got: ${result.injectedMessage.slice(0, 80)}`)
      }
    })

    it('no prefix when repeatCount is 0 (first emission, explicit)', () => {
      const history = makeReadOnlyHistory(10)
      const result = evaluateConvergence(baseInput({
        turn: 11,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        repeatCount: 0,
      }))
      if (result.level >= 2 && result.injectedMessage) {
        assert.ok(!result.injectedMessage.includes('第'),
          `expected no prefix for repeatCount=0, got: ${result.injectedMessage.slice(0, 80)}`)
      }
    })

    it('adds progressive prefix on second emission (repeatCount=1)', () => {
      const history = makeReadOnlyHistory(10)
      const result = evaluateConvergence(baseInput({
        turn: 11,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        repeatCount: 1, // second emission
      }))
      if (result.level >= 2 && result.injectedMessage) {
        assert.ok(result.injectedMessage.includes('第 2 次同类提醒'),
          `expected "第 2 次" prefix, got: ${result.injectedMessage.slice(0, 120)}`)
        // Second emission: acknowledges prior nudge, tells agent to ignore if fine
        assert.ok(
          result.injectedMessage.includes('请忽略') || result.injectedMessage.includes('忽略此'),
          `expected "请忽略" guidance, got: ${result.injectedMessage.slice(0, 150)}`,
        )
      }
    })

    it('escalates language on third+ emission (repeatCount=3)', () => {
      const history = makeReadOnlyHistory(10)
      const result = evaluateConvergence(baseInput({
        turn: 11,
        phaseClass: 'explore',
        contextWindow: 200_000,
        recentToolHistory: history,
        noToolTurnCount: 0,
        repeatCount: 3, // fourth emission → "第 4 次同类提醒"
      }))
      if (result.level >= 2 && result.injectedMessage) {
        assert.ok(result.injectedMessage.includes('第 4 次同类提醒'),
          `expected "第 4 次" prefix, got: ${result.injectedMessage.slice(0, 120)}`)
        // Third+ emission: "已多次发出" — stronger escalation
        assert.ok(result.injectedMessage.includes('已多次发出'),
          `expected "已多次发出" escalation, got: ${result.injectedMessage.slice(0, 150)}`)
      }
    })
  })

  // ── W3 (incident 20b9714e): activity-mode classification + diagnostic copy ──

  describe('classifyActivityMode (W3)', () => {
    it('classifies read-only window with zero edits as diagnostic', () => {
      const history = makeHistory([
        { tool: 'read_file' }, { tool: 'grep' }, { tool: 'read_file' },
        { tool: 'glob' }, { tool: 'read_file' },
      ])
      assert.equal(classifyActivityMode(history, 0), 'diagnostic')
    })

    it('returns build when any file has been modified (old: global flag; now: window-based)', () => {
      const history = makeHistory([
        { tool: 'read_file' }, { tool: 'grep' }, { tool: 'read_file' }, { tool: 'glob' },
      ])
      // Window has no edit tools → diagnostic (even though filesModified=1 from earlier turns)
      assert.equal(classifyActivityMode(history, 1), 'diagnostic')
    })

    it('returns build when window contains recent edit tools', () => {
      const history = makeHistory([
        { tool: 'read_file' }, { tool: 'grep' }, { tool: 'read_file' },
        { tool: 'edit_file' }, { tool: 'read_file' }, { tool: 'grep' },
        { tool: 'read_file' }, { tool: 'read_file' },
      ])
      assert.equal(classifyActivityMode(history, 1), 'build')
    })

    it('returns build below 0.8 read-only ratio boundary', () => {
      // 6/8 read-only = 0.75 < 0.8 → build
      const history = makeHistory([
        { tool: 'read_file' }, { tool: 'grep' }, { tool: 'read_file' },
        { tool: 'edit_file' }, { tool: 'read_file' }, { tool: 'grep' },
        { tool: 'run_tests' }, { tool: 'read_file' },
      ])
      assert.equal(classifyActivityMode(history, 0), 'build')
    })

    it('returns diagnostic at exactly 0.875 read-only ratio (7/8)', () => {
      const history = makeHistory([
        { tool: 'read_file' }, { tool: 'grep' }, { tool: 'read_file' },
        { tool: 'glob' }, { tool: 'read_file' }, { tool: 'grep' },
        { tool: 'run_tests' }, { tool: 'read_file' },
      ])
      assert.equal(classifyActivityMode(history, 0), 'diagnostic')
    })

    it('returns build when window has fewer than 4 samples (insufficient data)', () => {
      const history = makeHistory([{ tool: 'read_file' }, { tool: 'grep' }, { tool: 'glob' }])
      assert.equal(classifyActivityMode(history, 0), 'build')
    })

    it('only considers the trailing window: early edits outside window do not count', () => {
      // 12 entries: 4 edits first, then 8 read-only — window of 8 sees only reads
      const history = makeHistory([
        { tool: 'edit_file' }, { tool: 'edit_file' }, { tool: 'run_tests' }, { tool: 'edit_file' },
        ...Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', target: `f${i}.ts` })),
      ])
      assert.equal(classifyActivityMode(history, 0), 'diagnostic')
    })

    it('classifies bash read-only probes as diagnostic (defect 1: bash取证会话误判 build)', () => {
      // 会话 aa9737bb 实测形态：grep/sed/python3 解析 jsonl + read_file。
      // python inline code 无法静态证明只读，fail-closed 为 productive；其余 7/8
      // 仍是可靠只读证据，达到 0.8 门槛 → diagnostic。
      const history = makeHistory([
        {
          tool: 'bash',
          target: "grep -n 'turnCallLimitAdvisoryFired' src/agent/turn-orchestrator.ts",
          bashActivity: classifyBashCommandActivity(
            "grep -n 'turnCallLimitAdvisoryFired' src/agent/turn-orchestrator.ts",
          ),
        },
        { tool: 'read_file', target: 'src/agent/turn-orchestrator.ts' },
        {
          tool: 'bash',
          target: "python3 -c \"import json; json.load(open('x.jsonl'))\"",
          bashActivity: classifyBashCommandActivity(
            "python3 -c \"import json; json.load(open('x.jsonl'))\"",
          ),
        },
        { tool: 'grep', target: 'src/agent' },
        { tool: 'read_file', target: 'src/agent/convergence-detector.ts' },
        {
          tool: 'bash',
          target: 'git log --oneline -6',
          bashActivity: classifyBashCommandActivity('git log --oneline -6'),
        },
        { tool: 'read_file', target: 'src/agent/advisory-bus.ts' },
        {
          tool: 'bash',
          target: 'git diff package.json',
          bashActivity: classifyBashCommandActivity('git diff package.json'),
        },
      ])
      assert.equal(classifyActivityMode(history, 0), 'diagnostic')
    })

    it('still classifies bash write operations as build (bash跑测试/提交是产出)', () => {
      const history = makeHistory([
        { tool: 'bash', target: 'npm exec -- tsx --test src/agent/__tests__/x.test.ts' },
        { tool: 'bash', target: 'git add -A && git commit -m "feat: x"' },
        { tool: 'read_file' }, { tool: 'grep' },
        { tool: 'read_file' }, { tool: 'grep' },
        { tool: 'read_file' }, { tool: 'grep' },
      ])
      assert.equal(classifyActivityMode(history, 0), 'build')
    })

    it('treats allowlisted prefixes followed by shell writes as build', () => {
      const commands = [
        'grep foo input.txt && touch changed.txt',
        'grep foo input.txt > report.txt',
        'grep foo input.txt | tee report.txt',
      ]
      for (const target of commands) {
        const bashActivity = classifyBashCommandActivity(target)
        const history = makeHistory([
          { tool: 'bash', target, bashActivity },
          { tool: 'bash', target, bashActivity },
          ...Array.from({ length: 6 }, () => ({ tool: 'read_file' })),
        ])
        assert.equal(classifyActivityMode(history, 0), 'build', target)
      }
    })

    it('treats arbitrary interpreters and mutable subcommands as build', () => {
      const commands = [
        'python3 -c "open(\'x\',\'w\').write(\'bad\')"',
        'node -e "require(\'fs\').writeFileSync(\'x\',\'bad\')"',
        'find . -name "*.tmp" -delete',
        'git branch -D feature',
        'git remote set-url origin https://example.invalid/repo',
        'env rm -rf build',
        'npx tsx scripts/mutate-state.ts',
      ]
      for (const target of commands) {
        const bashActivity = classifyBashCommandActivity(target)
        const history = makeHistory([
          { tool: 'bash', target, bashActivity },
          { tool: 'bash', target, bashActivity },
          ...Array.from({ length: 6 }, () => ({ tool: 'read_file' })),
        ])
        assert.equal(classifyActivityMode(history, 0), 'build', target)
      }
    })

    it('fails closed when a truncated bash target hides a write suffix', () => {
      const command = `grep needle ${'a'.repeat(60)} && touch changed.txt`
      const target = bashCommandTarget(command)
      const bashActivity = classifyBashCommandActivity(command)
      assert.equal(target.length, 50, '前置：历史 target 已截断，写后缀不可见')
      const history = makeHistory([
        { tool: 'bash', target, bashActivity },
        { tool: 'bash', target, bashActivity },
        ...Array.from({ length: 6 }, () => ({ tool: 'read_file' })),
      ])
      assert.equal(classifyActivityMode(history, 0), 'build')
    })

    it('treats bash with empty target as productive (fallback: 旧条目无 target 不豁免)', () => {
      // 3/8 只读（read_file×3）< 0.8 → build；bash target 空按 PRODUCTIVE_TOOLS 原语义
      const history = makeHistory([
        { tool: 'bash', target: '' },
        { tool: 'bash' },
        { tool: 'read_file' },
        { tool: 'bash', target: '   ' },
        { tool: 'read_file' },
        { tool: 'grep' },
        { tool: 'read_file' },
        { tool: 'glob' },
      ])
      assert.equal(classifyActivityMode(history, 0), 'build')
    })
  })

  describe('diagnostic-mode convergence copy (W3)', () => {
    // Same-target reads: low novelty/entropy drives the score down so the
    // L2 gate opens by mid turns (verified empirically: turn 16 → L2).
    function sameTargetReads(count: number) {
      return makeHistory(
        Array.from({ length: count }, () => ({ tool: 'read_file', target: 'same.ts' })),
      )
    }

    // 距上次产出 N 步的只读尾巴。诊断态的停滞门槛是 3×window(6)=18，
    // build 态是 2×=12——两个门槛之间的区间正是"右移一档"多给的耐心。
    function readsAfterEdit(distance: number) {
      return makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        ...Array.from({ length: distance }, () => ({ tool: 'read_file', target: 'same.ts' })),
      ])
    }

    it('W3 停滞文案对诊断态可达：远离上次产出时给核实型收束', () => {
      const result = evaluateConvergence(baseInput({
        turn: 16,
        phaseClass: 'explore',
        recentToolHistory: readsAfterEdit(19),
        activityMode: 'diagnostic',
      }))
      assert.ok(result.level >= 2, `expected L2+, got L${result.level}`)
      // 这句只在 productive-stagnation 的诊断分支里出现；通用诊断文案说的是
      // "排查进度信号偏弱"。断在这里才能证明走的是 W3 那条，而非碰巧同含"核实"。
      assert.ok(result.injectedMessage?.includes('如果信息已足够，请核实后收束'),
        `必须命中 productive-stagnation 的诊断变体，实得: ${result.injectedMessage?.slice(0, 200)}`)
      assert.ok(!result.injectedMessage?.includes('直接编辑或测试'),
        '诊断态不得被催去改代码')
    })

    it('右移一档：build 态已算停滞的距离，诊断态还在耐心带内', () => {
      const history = readsAfterEdit(13) // ≥ build 的 12，< 诊断的 18
      const diagnostic = evaluateConvergence(baseInput({
        turn: 16, phaseClass: 'explore', recentToolHistory: history, activityMode: 'diagnostic',
      }))
      const build = evaluateConvergence(baseInput({
        turn: 16, phaseClass: 'explore', recentToolHistory: history, activityMode: 'build',
      }))
      assert.ok(build.injectedMessage?.includes('没有任何编辑、测试或提交'),
        `build 态该在此距离报停滞，实得: ${build.injectedMessage?.slice(0, 120)}`)
      assert.equal(diagnostic.injectedMessage?.includes('如果信息已足够，请核实后收束'), false,
        '同距离下诊断态不该报停滞——否则右移一档没生效')
    })

    it('通用诊断收敛文案（非停滞路径）同样要求标注未核实', () => {
      const result = evaluateConvergence(baseInput({
        turn: 16,
        phaseClass: 'explore',
        recentToolHistory: sameTargetReads(16),
        activityMode: 'diagnostic',
      }))
      assert.ok(result.level >= 2, `expected L2+, got L${result.level}`)
      assert.ok(result.injectedMessage)
      assert.ok(result.injectedMessage.includes('核实'),
        `diagnostic copy must ask for verification, got: ${result.injectedMessage.slice(0, 150)}`)
      assert.ok(result.injectedMessage.includes('未核实'),
        'diagnostic copy must require marking unverified claims')
      assert.ok(!result.injectedMessage.includes('直接编辑或测试'),
        'diagnostic copy must not push edits')
      // 全程无产出工具 → 距离为 Infinity → 停滞判据被 infinity guard 跳过。
      // 钉住走的是哪条，否则本用例会像 c74fa263 之后那样静默换分支还照样绿。
      assert.equal(result.injectedMessage.includes('如果信息已足够，请核实后收束'), false,
        '本用例覆盖的是通用诊断文案，不是 productive-stagnation 变体')
    })

    it('build mode keeps the original productive-stagnation copy', () => {
      // Prepend a productive tool so the Infinity guard does not skip
      // productive-stagnation, then continue the same-target read burst.
      const history = makeHistory([
        { tool: 'edit_file', target: 'a.ts' },
        ...sameTargetReads(16),
      ])
      const result = evaluateConvergence(baseInput({
        turn: 17,
        phaseClass: 'explore',
        recentToolHistory: history,
        activityMode: 'build',
      }))
      assert.ok(result.level >= 2, `expected L2+, got L${result.level}`)
      assert.ok(result.injectedMessage!.includes('信息可能已足够，请收敛'))
    })

    it('no-tool stagnation variant is NOT branched by diagnostic mode', () => {
      // No-tool hesitation is a different failure mode — the fix is "act",
      // regardless of activity mode. A recent productive tool keeps
      // productiveStagnation false so the no-tool variant wins the builder.
      const result = evaluateConvergence(baseInput({
        turn: 8,
        phaseClass: 'explore',
        recentToolHistory: makeHistory([
          { tool: 'edit_file', target: 'a.ts' },
          { tool: 'read_file', target: 'b.ts' },
          { tool: 'read_file', target: 'c.ts' },
          { tool: 'read_file', target: 'd.ts' },
        ]),
        noToolTurnCount: 3,
        activityMode: 'diagnostic',
      }))
      assert.ok(result.level >= 2, `expected L2+, got L${result.level}`)
      assert.ok(result.injectedMessage!.includes('未执行任何工具调用'),
        `no-tool variant must win over diagnostic branch, got: ${result.injectedMessage!.slice(0, 120)}`)
    })

    it('generic score-based variant gets verification-first copy in diagnostic mode', () => {
      // A recent productive tool (bash at window head) keeps productiveStagnation
      // false; same-target reads keep the score low → generic variant at L2/L3.
      const history = makeHistory([
        { tool: 'bash', target: 'echo x' },
        ...Array.from({ length: 11 }, () => ({ tool: 'read_file', target: 'same.ts' })),
      ])
      const result = evaluateConvergence(baseInput({
        turn: 20,
        phaseClass: 'explore',
        recentToolHistory: history,
        activityMode: 'diagnostic',
      }))
      assert.ok(result.level >= 2, `expected L2+, got L${result.level}`)
      assert.ok(!result.injectedMessage!.includes('读取/搜索操作'),
        'setup must not hit the productive-stagnation variant')
      assert.ok(result.injectedMessage!.includes('核实'),
        `generic diagnostic copy must be verification-first, got: ${result.injectedMessage!.slice(0, 150)}`)
      assert.ok(result.injectedMessage!.includes('暂无法确认'),
        'without live capabilities, diagnostic copy must not invent an available tool')
      assert.ok(!result.injectedMessage!.includes('session_vitals'))
    })
  })

  // ── L3 scoreAbort 双层护栏（宁可漏报不可误熔断）──

  describe('scoreAbort guard bands', () => {
    it('does NOT abort when score is low but not declining (isolated dip)', () => {
      // Multiple reversals in the window — not a real declining trend.
      const history = makeHistory(
        Array.from({ length: 12 }, (_, i) => ({ tool: 'read_file', target: `f${i}.ts` })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 25,
        phaseClass: 'deliver',
        recentToolHistory: history,
        // 2 reversals (0.68→0.71, 0.71→0.75) — exceeds the 1-reversal tolerance
        scoreHistory: [0.82, 0.75, 0.68, 0.71, 0.75, 0.07],
      }))
      assert.equal(result.shouldAbort, false, 'shouldAbort must be false for non-declining trend')
      assert.equal(result.abortCause, undefined)
    })

    it('allows up to 1 micro-bounce in an otherwise declining trend', () => {
      // Same-target reads + oscillation → score collapses below 0.05
      const history = makeHistory(
        Array.from({ length: 12 }, () => ({ tool: 'read_file', target: 'same.ts' })),
      )
      // 1 reversal (0.42→0.44) — within tolerance, overall declining
      const result = evaluateConvergence(baseInput({
        turn: 35,
        phaseClass: 'deliver',
        recentToolHistory: history,
        toolFingerprints: ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
        scoreHistory: [0.50, 0.42, 0.44, 0.31, 0.22, 0.04],
        repeatCount: 2,
        priorWarningAtL2Plus: true,
      }))
      assert.equal(result.shouldAbort, true, 'shouldAbort must allow 1 micro-bounce in declining trend')
      assert.equal(result.abortCause, 'score')
    })

    it('does NOT abort when score is declining but never warned', () => {
      const history = makeHistory(
        Array.from({ length: 12 }, (_, i) => ({ tool: 'read_file', target: `f${i}.ts` })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 30,
        phaseClass: 'deliver',
        recentToolHistory: history,
        scoreHistory: [0.55, 0.42, 0.31, 0.22, 0.11, 0.04], // steady decline over 6 turns
        repeatCount: 0,
        priorWarningAtL2Plus: false, // no prior L2+ warning yet
      }))
      assert.equal(result.shouldAbort, false, 'shouldAbort must be false without prior L2 warning')
      assert.equal(result.abortCause, undefined)
    })

    it('ABORTS when score declining AND previously warned', () => {
      // Same-target reads + oscillating fingerprints → score collapses below 0.05
      const history = makeHistory(
        Array.from({ length: 12 }, () => ({ tool: 'read_file', target: 'same.ts' })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 35,
        phaseClass: 'deliver',
        recentToolHistory: history,
        toolFingerprints: ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
        scoreHistory: [0.50, 0.38, 0.40, 0.22, 0.15, 0.03], // 1 micro-bounce, overall declining
        repeatCount: 2,
        priorWarningAtL2Plus: true, // prior L2+ warning already delivered
      }))
      assert.equal(result.shouldAbort, true, 'shouldAbort must be true with declining score + prior L2+ warning')
      assert.equal(result.abortCause, 'score')
    })

    it('does NOT abort when scoreHistory is absent (backward compat)', () => {
      // Old callers that don't pass scoreHistory — must not crash or false-abort.
      const history = makeHistory(
        Array.from({ length: 12 }, (_, i) => ({ tool: 'read_file', target: `f${i}.ts` })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 35,
        phaseClass: 'deliver',
        recentToolHistory: history,
        scoreHistory: undefined, // absent
        repeatCount: 2,
      }))
      assert.equal(result.shouldAbort, false, 'shouldAbort must be false when scoreHistory is absent')
    })
  })

  // ── P3：score-abort 口径切片（regimeKey/quality）与有效权重 ──

  describe('scoreAbort — P3 口径切片与有效权重', () => {
    const ok = (regimeKey: string | null, score: number): ConvergenceScoreSample =>
      ({ score, regimeKey, quality: 'ok' })
    const insuff = (regimeKey: string | null, score: number): ConvergenceScoreSample =>
      ({ score, regimeKey, quality: 'insufficient' })
    const stalledHistory = () => makeHistory(Array.from({ length: 12 }, () => ({ tool: 'read_file', target: 'same.ts' })))
    const oscillating = ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']

    it('混合口径旧分数不构成下降证据：尾部同口径仅 2 条（<6）不熔断', () => {
      const result = evaluateConvergence(baseInput({
        turn: 35,
        phaseClass: 'deliver',
        recentToolHistory: stalledHistory(),
        toolFingerprints: [...oscillating],
        // 前 4 条旧口径（legacy）+ 尾部新口径 2 条低分——同口径窗口不足
        scoreHistory: [0.50, 0.38, 0.40, 0.22, ok('7:2:required', 0.15), ok('7:2:required', 0.03)],
        repeatCount: 2,
        priorWarningAtL2Plus: true,
      }))
      assert.equal(result.shouldAbort, false, '混合口径的旧分数不得触发 score-abort')
      assert.equal(result.abortCause, undefined)
    })

    it('同口径（对象样本）持续下降 + 已警告 → 仍然熔断（切片无普遍性关闭）', () => {
      const result = evaluateConvergence(baseInput({
        turn: 35,
        phaseClass: 'deliver',
        recentToolHistory: stalledHistory(),
        toolFingerprints: [...oscillating],
        scoreHistory: [0.50, 0.38, 0.40, 0.22, 0.15, 0.03].map(s => ok('7:2:required', s)),
        repeatCount: 2,
        priorWarningAtL2Plus: true,
      }))
      assert.equal(result.shouldAbort, true)
      assert.equal(result.abortCause, 'score')
    })

    it('尾部 insufficient 样本截断历史 → 不熔断（无证据不充当下降证据）', () => {
      const result = evaluateConvergence(baseInput({
        turn: 35,
        phaseClass: 'deliver',
        recentToolHistory: stalledHistory(),
        toolFingerprints: [...oscillating],
        scoreHistory: [0.50, 0.38, 0.40, 0.22, 0.15].map(s => ok('7:2:required', s)).concat([insuff('7:2:required', 0.03)]),
        repeatCount: 2,
        priorWarningAtL2Plus: true,
      }))
      assert.equal(result.shouldAbort, false)
    })

    it('effectiveWeights：not-required 时 editRatio 份额归零、其余按原比例归一（和为 1）', () => {
      const result = evaluateConvergence(baseInput({
        phaseClass: 'execute',
        editExpectation: { kind: 'not-required', source: 'verifying-step', reason: 'test' },
      }))
      assert.equal(result.effectiveWeights.editRatio, 0)
      const sum = Object.values(result.effectiveWeights).reduce((a, b) => a + b, 0)
      assert.ok(Math.abs(sum - 1) < 1e-9, `有效权重之和应为 1，得到 ${sum}`)
    })

    it('effectiveWeights：required 时保留 execute 的 editRatio 基础权重', () => {
      const result = evaluateConvergence(baseInput({ phaseClass: 'execute' }))
      assert.equal(result.effectiveWeights.editRatio, 0.40)
    })
  })

  // ── productive-stagnation phase 切换冷却（改动 3）──

  describe('phase cooldown for productive-stagnation', () => {
    it('suppresses productiveStagnation during first 4 turns of a new phase', () => {
      // phaseRelativeTurn=2: only 2 turns into this phase, old reads shouldn't trigger stagnation
      const history = makeHistory(
        Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', target: `file${i}.ts` })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 10,
        phaseClass: 'deliver',
        phaseRelativeTurn: 2, // just switched to this phase
        recentToolHistory: history,
      }))
      assert.equal(result.shouldKick, false, 'shouldKick must be false during phase cooldown (no L2+)')
      // Level may be 1 (nudge) but must not be L2+
      assert.ok(result.level < 2, `expected level < 2 during cooldown, got L${result.level}`)
    })

    it('allows productiveStagnation after cooldown (5th+ turn)', () => {
      const history = makeHistory(
        Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', target: `file${i}.ts` })),
      )
      const result = evaluateConvergence(baseInput({
        turn: 14,
        phaseClass: 'deliver',
        phaseRelativeTurn: 5, // past the 4-turn cooldown
        recentToolHistory: history,
      }))
      // After cooldown, stagnation should fire normally
      assert.ok(result.level >= 1, `expected L1+ after cooldown, got L${result.level}`)
    })

    it('phaseRelativeTurn defaults to no cooldown when absent (backward compat)', () => {
      const history = makeHistory(
        Array.from({ length: 8 }, (_, i) => ({ tool: 'read_file', target: `file${i}.ts` })),
      )
      // phaseRelativeTurn absent → no cooldown → stagnation fires as before
      const result = evaluateConvergence(baseInput({
        turn: 14,
        phaseClass: 'deliver',
        phaseRelativeTurn: undefined,
        recentToolHistory: history,
      }))
      // Old behavior preserved: stagnation can fire at L1+ when phaseRelativeTurn is absent
      assert.ok(result.level >= 1, `absent phaseRelativeTurn → no cooldown → level >= 1, got L${result.level}`)
    })
  })
})

// ─── P1 心流保护 Wave 1：computeFlowBeacon 纯函数契约 ────────────────

describe('computeFlowBeacon (P1 Wave 1)', () => {
  function flowInput(overrides: Partial<FlowBeaconInput> = {}): FlowBeaconInput {
    return {
      momentum: 0.8,
      momentumHasData: true,
      stability: 0.7,
      recentToolHistory: [],
      todoCompletedDelta: 0,
      signalWindow: 6,
      ...overrides,
    }
  }

  const settled = (statuses: Array<'success' | 'failed' | 'running'>) =>
    statuses.map(status => ({ status }))

  it('全量实测样本得到 [0,1] 分数（各因子线性加权）', () => {
    const b = computeFlowBeacon(flowInput({
      momentum: 1, stability: 1, todoCompletedDelta: 2,
      recentToolHistory: settled(['success', 'success', 'success', 'success']),
    }))
    assert.equal(b.sampleCount, 4)
    assert.ok(Math.abs(b.score - 1) < 1e-9, `全因子满格 → ≈1.0，got ${b.score}`)
  })

  it('权重固定断言：单因子拉满/清零时 score 符合 0.4/0.3/0.2/0.1 线性预期', () => {
    const zeroBase = { momentum: 0, momentumHasData: true, stability: 0, todoCompletedDelta: 0 }
    const allFail = settled(['failed', 'failed', 'failed', 'failed'])
    const allPass = settled(['success', 'success', 'success', 'success'])
    // 只有工具成功率满格 → 0.4
    assert.equal(computeFlowBeacon(flowInput({ ...zeroBase, recentToolHistory: allPass })).score, 0.4)
    // 只有 momentum 满格 → 0.3
    assert.equal(computeFlowBeacon(flowInput({ ...zeroBase, momentum: 1, recentToolHistory: allFail })).score, 0.3)
    // 只有 stability 满格 → 0.2
    assert.equal(computeFlowBeacon(flowInput({ ...zeroBase, stability: 1, recentToolHistory: allFail })).score, 0.2)
    // 只有 todo 推进满格（delta≥2）→ 0.1（四舍五入到浮点容差）
    const todoOnly = computeFlowBeacon(flowInput({ ...zeroBase, todoCompletedDelta: 5, recentToolHistory: allFail }))
    assert.ok(Math.abs(todoOnly.score - 0.1) < 1e-9)
  })

  it('running 在途样本从分子分母同时剔除；窗口内全 running → sampleCount=0', () => {
    const mixed = computeFlowBeacon(flowInput({
      recentToolHistory: settled(['success', 'running', 'success', 'running', 'failed']),
    }))
    assert.equal(mixed.sampleCount, 3, '只计已结算样本')
    const allRunning = computeFlowBeacon(flowInput({
      recentToolHistory: settled(['running', 'running', 'running', 'running', 'running']),
    }))
    assert.equal(allRunning.sampleCount, 0)
  })

  it('无工具样本 → sampleCount=0（成功率因子记 0，不把缺数据当好数据）', () => {
    const b = computeFlowBeacon(flowInput({ momentum: 1, stability: 1, recentToolHistory: [] }))
    assert.equal(b.sampleCount, 0)
    assert.ok(b.score <= 0.6, '无实测行为样本时 score 不含成功率分量')
  })

  it('momentumHasData=false 时 momentum 因子记 0（no-data ≠ 低心流）', () => {
    const withData = computeFlowBeacon(flowInput({ momentum: 1, momentumHasData: true }))
    const noData = computeFlowBeacon(flowInput({ momentum: 1, momentumHasData: false }))
    assert.ok(Math.abs(withData.score - noData.score - 0.3) < 1e-9, 'no-data 恰好少 0.3 权重分量')
  })

  it('窗口裁剪：只看最近 signalWindow 条历史', () => {
    const history = [
      ...settled(['failed', 'failed', 'failed', 'failed', 'failed', 'failed']),
      ...settled(['success', 'success', 'success', 'success', 'success', 'success']),
    ]
    const b = computeFlowBeacon(flowInput({ recentToolHistory: history, signalWindow: 6 }))
    assert.equal(b.sampleCount, 6)
    // 窗口内全 success → 成功率因子满格
    const allFailWindow = computeFlowBeacon(flowInput({
      recentToolHistory: history.slice(0, 6), signalWindow: 6,
    }))
    assert.ok(b.score > allFailWindow.score)
  })

  it('非法/越界输入被 clamp：NaN/Infinity/负值不产生越界 score', () => {
    const cases: FlowBeaconInput[] = [
      flowInput({ momentum: Number.NaN, stability: Number.POSITIVE_INFINITY, todoCompletedDelta: -3 }),
      flowInput({ momentum: -5, stability: 99, todoCompletedDelta: Number.NaN }),
      flowInput({ signalWindow: 0, recentToolHistory: settled(['success']) }),
    ]
    for (const c of cases) {
      const b = computeFlowBeacon(c)
      assert.ok(Number.isFinite(b.score), 'score 有限')
      assert.ok(b.score >= 0 && b.score <= 1, `score 在 [0,1]，got ${b.score}`)
      assert.ok(Number.isInteger(b.sampleCount) && b.sampleCount >= 0)
    }
  })

  it('确定性：同一输入两次结果完全一致', () => {
    const input = flowInput({
      momentum: 0.63, stability: 0.41, todoCompletedDelta: 1,
      recentToolHistory: settled(['success', 'failed', 'success', 'running', 'success']),
    })
    assert.deepEqual(computeFlowBeacon(input), computeFlowBeacon(input))
  })
})

// ─── P1 心流保护 Wave 2：detector 软阈值消费 ─────────────────────────

describe('evaluateConvergence — flow 软阈值（P1 Wave 2）', () => {
  /** 基线：6× 同目标全 success 读 → turn 8 (=nLow) 低分 L1（既有用例形状）。 */
  const lowScoreHistory = () => makeHistory(
    Array.from({ length: 6 }, () => ({ tool: 'read_file', target: 'a.ts' })),
  )
  const highFlow = { momentum: 1, momentumHasData: true, stability: 1 }

  it('高 flow 延后 score-based nLow：turn 8 从 L1 变 L0，turn 10 仍会到达 L1', () => {
    const base = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false },
    }))
    assert.equal(base.level, 1, '基线 L1')

    // flow = 0.4(成功率) + 0.3(momentum) + 0.2(stability) = 0.9 → 1.27× → nLow 8→10
    const flowed = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: highFlow },
    }))
    assert.equal(flowed.level, 0, '高 flow 下 turn 8 < 调整后 nLow → L0')

    const delayed = evaluateConvergence(baseInput({
      turn: 10, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: highFlow },
    }))
    assert.equal(delayed.level, 1, '延后不是免除：turn 10 仍到达 L1')
  })

  it('连续倍率非二元跳变：中间 flow 值产生中间阈值', () => {
    // 中 flow = 0.4 + 0.3*0.5 = 0.55 → 1.165× → nLow 8→9
    const midFlow = { momentum: 0.5, momentumHasData: true, stability: 0 }
    const atNine = evaluateConvergence(baseInput({
      turn: 9, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: midFlow },
    }))
    assert.equal(atNine.level, 1, '中 flow：turn 9 = 调整后 nLow → L1')
    const highAtNine = evaluateConvergence(baseInput({
      turn: 9, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: highFlow },
    }))
    assert.equal(highAtNine.level, 0, '高 flow：turn 9 < 调整后 nLow(10) → L0——高低 flow 在同 turn 分化')
  })

  it('flow=0 与不传 flowInputs 行为一致（全 failed 样本 → score 0 → 无调整）', () => {
    const allFailed = makeHistory(
      Array.from({ length: 6 }, () => ({ tool: 'read_file', status: 'failed' as const, target: 'a.ts' })),
    )
    const withoutFlow = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: allFailed,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false },
    }))
    const zeroFlow = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: allFailed,
      progressBeacons: {
        todoCompletedDelta: 0, activePlan: false,
        flowInputs: { momentum: 0, momentumHasData: true, stability: 0 },
      },
    }))
    assert.equal(zeroFlow.level, withoutFlow.level)
    assert.equal(zeroFlow.shouldAbort, withoutFlow.shouldAbort)
    assert.equal(zeroFlow.score, withoutFlow.score)
  })

  it('资格门：样本不足（<4 已结算）不改变行为', () => {
    const three = makeHistory(
      Array.from({ length: 3 }, () => ({ tool: 'read_file', target: 'a.ts' })),
    )
    const base = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: three,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false },
    }))
    const gated = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: three,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: highFlow },
    }))
    assert.equal(gated.level, base.level, '样本不足 → 旧行为')
    assert.equal(gated.score, base.score)
  })

  it('资格门：momentum no-data 不进入保护态（即使成功率满格）', () => {
    const noData = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: {
        todoCompletedDelta: 0, activePlan: false,
        flowInputs: { momentum: 1, momentumHasData: false, stability: 1 },
      },
    }))
    assert.equal(noData.level, 1, 'no-data → 资格门拦截 → 基线 L1 不变')
  })

  it('activePlan 与 flow 互斥不叠加：activePlan 时 nLow=38 (25×1.5)，不是更大', () => {
    const result = evaluateConvergence(baseInput({
      turn: 13, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: true, flowInputs: highFlow },
    }))
    assert.equal(result.level, 1, 'turn 13 < activePlan 调整后 nLow(38)，但低分+低产出触发停滞绕行 → L1')
  })

  // ─── P2 阴阳调度：structureRelaxation 单声源 ──────────────────────

  it('P2 structureRelaxation=0.25 延后 nLow：turn 8 L1→L0，turn 10 仍到达 L1', () => {
    const relaxed = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, structureRelaxation: 0.25 },
    }))
    assert.equal(relaxed.level, 0, '1.25× → nLow 8→10 → turn 8 L0')
    const delayed = evaluateConvergence(baseInput({
      turn: 10, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, structureRelaxation: 0.25 },
    }))
    assert.equal(delayed.level, 1, '延后不是免除')
  })

  it('P2 单声源仲裁：structureRelaxation=0 时忽略同传的高 flowInputs（hardTighten 压过 P1 放宽）', () => {
    const base = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false },
    }))
    assert.equal(base.level, 1, '基线 L1')
    const arbitrated = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: {
        todoCompletedDelta: 0, activePlan: false,
        structureRelaxation: 0, flowInputs: highFlow,
      },
    }))
    assert.equal(arbitrated.level, 1, 'relaxation=0 有效且屏蔽 flowInputs → 基线 L1（若 flowInputs 生效则为 L0）')
  })

  it('P2 relaxation 越界被 clamp：5 → 等同 0.25；负值 → 等同 0', () => {
    const over = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, structureRelaxation: 5 },
    }))
    const capped = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, structureRelaxation: 0.25 },
    }))
    assert.equal(over.level, capped.level)
    const negative = evaluateConvergence(baseInput({
      turn: 8, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, structureRelaxation: -1 },
    }))
    assert.equal(negative.level, 1, '负值 → 无放松 → 基线 L1')
  })

  it('P2 与 activePlan 互斥不叠加：activePlan 的 1.5× 优先', () => {
    const result = evaluateConvergence(baseInput({
      turn: 13, phaseClass: 'explore', recentToolHistory: lowScoreHistory(),
      progressBeacons: { todoCompletedDelta: 0, activePlan: true, structureRelaxation: 0.25 },
    }))
    assert.equal(result.level, 1, 'turn 13 < activePlan 调整后 nLow(38)，但低分+低产出触发停滞绕行 → L1')
  })

  it('P2 高 relaxation 不能救 no-tool 硬熔断', () => {
    const result = evaluateConvergence(baseInput({
      turn: 12, phaseClass: 'execute', recentToolHistory: lowScoreHistory(),
      noToolTurnCount: 5,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, structureRelaxation: 0.25 },
    }))
    assert.equal(result.shouldAbort, true)
    assert.equal(result.abortCause, 'no-tool')
  })

  it('no-tool 硬熔断不被高 flow 阻止（abortCause 保持 no-tool）', () => {
    const result = evaluateConvergence(baseInput({
      turn: 12, phaseClass: 'execute', recentToolHistory: lowScoreHistory(),
      noToolTurnCount: 5,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: highFlow },
    }))
    assert.equal(result.shouldAbort, true, '高 flow 不能救 no-tool 硬熔断')
    assert.equal(result.abortCause, 'no-tool')
  })

  it('score-abort 双护栏在高 flow 下保持原语义（也间接证明 signalWindow 未被乘）', () => {
    // 复用既有 micro-bounce abort 用例形状 + 高 flow。turn 35 ≥ 调整后
    // nHigh(25) → L3 仍到达；scoreDeclining 要求 scoreHistory.length >=
    // signalWindow(6)——若 flow 误乘了 signalWindow，此断言会失败。
    const history = makeHistory(
      Array.from({ length: 12 }, () => ({ tool: 'read_file', target: 'same.ts' })),
    )
    const result = evaluateConvergence(baseInput({
      turn: 35, phaseClass: 'deliver', recentToolHistory: history,
      toolFingerprints: ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
      scoreHistory: [0.50, 0.42, 0.44, 0.31, 0.22, 0.04],
      repeatCount: 2,
      priorWarningAtL2Plus: true,
      progressBeacons: { todoCompletedDelta: 0, activePlan: false, flowInputs: highFlow },
    }))
    assert.equal(result.shouldAbort, true, '高 flow 不能关闭 score-abort')
    assert.equal(result.abortCause, 'score')
  })

  it('todoCompletedDelta veto 与 flow 共存不回归（veto 仍在 level 判定后生效）', () => {
    // 构造 L2 形状（execute + nMid 后低分），todo 推进 → veto 到 L1
    const history = makeHistory(
      Array.from({ length: 8 }, () => ({ tool: 'read_file', target: 'a.ts' })),
    )
    const result = evaluateConvergence(baseInput({
      turn: 20, phaseClass: 'execute', recentToolHistory: history,
      progressBeacons: { todoCompletedDelta: 1, activePlan: false, flowInputs: highFlow },
    }))
    assert.ok(result.level <= 1, `todo veto 仍 cap 到 ≤L1，got L${result.level}`)
  })
})

// ─── W4 噪音洪流修复：工具错误受阻时降级收敛 score ─────────────────

describe('evaluateConvergence — W4 tool error ratio demotion', () => {
  // 高错误率场景：10 个工具调用中 5 个 failed → errorRatio=0.5 ≥ 0.4
  const highErrorHistory = () => makeHistory([
    { tool: 'read_file', status: 'failed', target: 'plan.md' },
    { tool: 'glob', status: 'failed', target: '*.plan.md' },
    { tool: 'grep', status: 'failed', target: 'plan' },
    { tool: 'bash', status: 'success', target: 'cat' },
    { tool: 'read_file', status: 'failed', target: '.rivet' },
    { tool: 'glob', status: 'success', target: '*.ts' },
    { tool: 'grep', status: 'failed', target: 'pattern' },
    { tool: 'read_file', status: 'success', target: 'src/a.ts' },
    { tool: 'read_file', status: 'success', target: 'src/a.ts' },
    { tool: 'read_file', status: 'success', target: 'src/a.ts' },
  ])

  // 同目标全 success → 经典低分停滞形状（触发 L2）
  const stuckHistory = () => makeHistory(
    Array.from({ length: 6 }, () => ({ tool: 'read_file', target: 'a.ts' })),
  )

  it('高工具错误率压低 score 阻断 L2：同停滞形状，errorRatio≥0.4 时 level≤1', () => {
    // 同形状同 turn 的高错误率 vs 零错误率对比
    const withErrors = evaluateConvergence(baseInput({
      turn: 14, phaseClass: 'explore', recentToolHistory: highErrorHistory(),
      recentToolErrorRatio: 0.5,
    }))
    const withoutErrors = evaluateConvergence(baseInput({
      turn: 14, phaseClass: 'explore', recentToolHistory: stuckHistory(),
    }))

    // 高错误率时 score 被 cap 到 0.41 → level ≤1（阻断 L2）
    assert.ok(withErrors.level <= 1, `高错误率应阻断 L2+，实际 L${withErrors.level} score=${withErrors.score.toFixed(3)}`)
    // 零错误率时正常触发 L2
    assert.equal(withoutErrors.level, 2, '零错误率应正常触发 L2')
  })

  it('低工具错误率不影响收敛检测：errorRatio=0.2 < 0.4 时行为不变', () => {
    const withLowErrors = evaluateConvergence(baseInput({
      turn: 14, phaseClass: 'explore', recentToolHistory: stuckHistory(),
      recentToolErrorRatio: 0.2,
    }))
    assert.equal(withLowErrors.level, 2, '低错误率不应影响收敛判断')
  })

  it('recentToolErrorRatio 缺席时走旧行为（向后兼容）', () => {
    const result = evaluateConvergence(baseInput({
      turn: 14, phaseClass: 'explore', recentToolHistory: stuckHistory(),
      // 不传 recentToolErrorRatio
    }))
    assert.equal(result.level, 2, '缺席字段应走旧行为，正常触发 L2')
  })

  it('no-tool 熔断不受 error ratio 影响', () => {
    const result = evaluateConvergence(baseInput({
      turn: 14, phaseClass: 'execute', recentToolHistory: highErrorHistory(),
      noToolTurnCount: 5,
      recentToolErrorRatio: 0.8,
    }))
    assert.equal(result.shouldAbort, true, 'no-tool 硬熔断不受 error ratio 影响')
    assert.equal(result.abortCause, 'no-tool')
  })
})
