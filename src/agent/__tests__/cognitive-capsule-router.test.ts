import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCcrHook, computeReadOnlyStreak, computeVerifyFailStreak, _RULES_FOR_TESTING, _fillTemplate, _isTestIntent, _STAR_FALLBACK_POOLS, type CcrTriggerEvent } from '../hooks/cognitive-capsule-router.js'
import { extractPrinciplesFromRaw } from '../seed-capsule-store.js'
import type { AdvisoryEntry } from '../advisory-bus.js'
import type { EvidenceState } from '../evidence.js'
import type { RuntimeHookContext, RuntimeHookSnapshot } from '../runtime-hooks.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'

// ─── Helpers ─────────────────────────────────────────────────────

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    confidence: 1.0,
    complexity: 0.3,
    momentum: 0.5,
    stability: 0.8,
    freshness: 0.9,
    pressure: 0.1,
    ...overrides,
  }
}

function makeVigor(overrides: Partial<VigorState> = {}): VigorState {
  return {
    tonic: 0.7,
    phasic: 0.0,
    curiosity: 0.5,
    vigor: 0.8,
    variability: 0.1,
    history: [0.8],
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<EvidenceState> = {}): EvidenceState {
  return {
    filesModified: new Set<string>(),
    filesRead: new Set<string>(),
    deliveryStatus: 'unverified',
    ...overrides,
  } as EvidenceState
}

function makeSnapshot(overrides: Partial<RuntimeHookSnapshot> = {}): RuntimeHookSnapshot {
  return {
    cwd: '/test',
    turn: 5,
    recentToolHistory: [],
    sensorium: makeSensorium(),
    strategy: null,
    vigor: makeVigor(),
    gitChangeRate: 0,
    season: null,
    ...overrides,
  }
}

interface TestHarness {
  submitted: AdvisoryEntry[]
  convergenceTriggered: boolean
  evidence: EvidenceState
  triggerEvents: CcrTriggerEvent[]
  run: (snapshot: RuntimeHookSnapshot) => void
}

interface HarnessOptions {
  evidenceOverrides?: Partial<EvidenceState>
  cwd?: string
}

function createHarness(evidenceOrOpts?: Partial<EvidenceState> | HarnessOptions): TestHarness {
  const opts: HarnessOptions = evidenceOrOpts && ('evidenceOverrides' in evidenceOrOpts || 'cwd' in evidenceOrOpts)
    ? evidenceOrOpts as HarnessOptions
    : { evidenceOverrides: evidenceOrOpts as Partial<EvidenceState> | undefined }

  const submitted: AdvisoryEntry[] = []
  const triggerEvents: CcrTriggerEvent[] = []
  let convergenceTriggered = false
  const evidence = makeEvidence(opts.evidenceOverrides ?? {})

  const hook = createCcrHook({
    advisoryBus: {
      submit(entry: AdvisoryEntry) { submitted.push(entry) },
    },
    wasConvergenceTriggered: () => convergenceTriggered,
    getEvidenceState: () => evidence,
    cwd: opts.cwd,
    onTrigger: (event) => { triggerEvents.push(event) },
  })

  return {
    submitted,
    triggerEvents,
    get convergenceTriggered() { return convergenceTriggered },
    set convergenceTriggered(v: boolean) { convergenceTriggered = v },
    evidence,
    run(snapshot: RuntimeHookSnapshot) {
      const ctx: RuntimeHookContext = {
        snapshot,
        effects: {
          setSensorium() {},
          setStrategy() {},
          setVigor() {},
          setGitChangeRate() {},
          injectUserMessage() {},
          requestThetaCheck() {},
          emitPhaseChange() {},
          emitDecisionShift() {},
          markClaimStale() {},
        },
      }
      hook.run(ctx)
    },
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('CognitiveCapsuleRouter', () => {
  describe('fillTemplate', () => {
    it('replaces known variables', () => {
      const result = _fillTemplate('modified {files_modified} files at turn {turn}', {
        files_modified: 3,
        turn: 7,
      })
      assert.equal(result, 'modified 3 files at turn 7')
    })

    it('leaves unknown variables as-is', () => {
      const result = _fillTemplate('{known} and {unknown}', { known: 'yes' })
      assert.equal(result, 'yes and {unknown}')
    })
  })

  describe('isTestIntent', () => {
    it('detects run_tests tool', () => {
      assert.equal(_isTestIntent('run_tests', 'src/foo.ts'), true)
    })

    it('detects test in target', () => {
      assert.equal(_isTestIntent('read_file', 'src/__tests__/foo.test.ts'), true)
    })

    it('edit tools are NOT test intent (2026-07-04 触发面修复：编辑不是验证)', () => {
      assert.equal(_isTestIntent('edit_file', 'src/foo.ts'), false)
      assert.equal(_isTestIntent('hash_edit', 'src/foo.ts'), false)
      assert.equal(_isTestIntent('write_file', 'src/foo.ts'), false)
    })

    it('returns false for read_file on non-test target', () => {
      assert.equal(_isTestIntent('read_file', 'src/foo.ts'), false)
    })
  })

  describe('convergence mutual exclusion', () => {
    it('does not fire when convergence is triggered', () => {
      const h = createHarness({ filesModified: new Set(['a', 'b', 'c']) })
      h.convergenceTriggered = true
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.1 }),
      }))
      assert.equal(h.submitted.length, 0)
    })
  })

  describe('P1: 瑶光 — low verification coverage', () => {
    it('fires when verif_cov < 0.3 and turn > 3', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【瑶光】'))
      assert.equal(h.submitted[0]!.category, 'star_domain', 'CCR 走独立类别，不与 discipline 争预算')
    })

    it('does not fire at turn 2', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 2,
        sensorium: makeSensorium({ confidence: 0.1 }),
      }))
      assert.equal(h.submitted.length, 0)
    })

    it('is suppressed when last tool is run_tests', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        recentToolHistory: [{ tool: 'run_tests', status: 'success', target: 'src/test.ts' }],
      }))
      assert.equal(h.submitted.length, 0)
    })
  })

  describe('P3 vs P1 priority: dual-deficit routes to 天权', () => {
    it('routes to 天权 when both verif_cov and vigor are low', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts', 'c.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.15 }),
        vigor: makeVigor({ vigor: 0.2 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【天权】'))
      assert.match(h.submitted[0]!.key, /ccr-天权-P3/)
    })

    it('routes to 瑶光 when verif_cov low but vigor normal', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts', 'c.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.15 }),
        vigor: makeVigor({ vigor: 0.7 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【瑶光】'))
      assert.match(h.submitted[0]!.key, /ccr-瑶光-P1/)
    })
  })

  describe('P5: 瑶光 — large diff unverified', () => {
    it('fires when files_modified > 5 and verif_cov < 0.5', () => {
      const files = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
      const h = createHarness({ filesModified: files })
      h.run(makeSnapshot({
        turn: 3,
        sensorium: makeSensorium({ confidence: 0.4 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.startsWith('【瑶光】'))
      assert.match(h.submitted[0]!.key, /ccr-瑶光-P5/)
    })
  })

  describe('cooldown', () => {
    it('does not fire same star within cooldown window', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      const snapshot = makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      })
      h.run(snapshot)
      assert.equal(h.submitted.length, 1, 'first trigger')
      assert.match(h.submitted[0]!.key, /P1/)

      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1, 'blocked by cooldown')
    })

    it('fires again after cooldown expires', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)

      h.run(makeSnapshot({
        turn: 11, // 6 turns later, cooldown=5 for 瑶光
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 2)
    })

    it('allows escalation override when value degrades to 50%', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)

      // Turn 7, within cooldown (5), but confidence degraded from 0.2 to 0.05 (<0.1)
      h.run(makeSnapshot({
        turn: 7,
        sensorium: makeSensorium({ confidence: 0.05 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 2, 'escalation override')
    })
  })

  describe('shared star cooldown across rules', () => {
    it('P1 trigger puts P5 in cooldown (same star 瑶光)', () => {
      const files = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
      const h = createHarness({ filesModified: files })

      // P1 fires (verif_cov < 0.3, vigor normal)
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.match(h.submitted[0]!.key, /P1/)

      // P5 would match (files>5, verif<0.5) but 瑶光 in cooldown
      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({ confidence: 0.4 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      // P5 blocked by 瑶光 cooldown, but P4 or P2 might fire depending on values
      const p5Entries = h.submitted.filter(e => e.key.includes('P5'))
      assert.equal(p5Entries.length, 0, 'P5 blocked by shared 瑶光 cooldown')
    })
  })

  describe('one reminder per turn', () => {
    it('only submits one advisory even when multiple rules match', () => {
      const files = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
      const h = createHarness({ filesModified: files })
      h.run(makeSnapshot({
        turn: 6,
        sensorium: makeSensorium({ confidence: 0.1 }),
        vigor: makeVigor({ vigor: 0.1 }),
      }))
      // P3 matches (dual-deficit: confidence<0.3, vigor<0.3, turn>3)
      // P1 also matches but P3 is higher priority (first match wins)
      assert.equal(h.submitted.length, 1, 'exactly one advisory per turn')
      assert.match(h.submitted[0]!.key, /ccr-天权-P3/)
    })
  })

  describe('no sensorium → no-op', () => {
    it('does nothing when sensorium is null', () => {
      const h = createHarness()
      h.run(makeSnapshot({ sensorium: null }))
      assert.equal(h.submitted.length, 0)
    })
  })

  describe('template variables', () => {
    it('fills files_modified and turn in advisory content', () => {
      const h = createHarness({ filesModified: new Set(['a', 'b', 'c']) })
      h.run(makeSnapshot({
        turn: 7,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.includes('3 个文件'))
    })
  })

  // ─── Phase 2 Tests ─────────────────────────────────────────────

  describe('extractPrinciplesFromRaw', () => {
    it('extracts principles with key and action', () => {
      const raw = `
Some preamble text.
<principle key="Y1" action="do the thing">Maxim one</principle>
More text.
<principle key="Y2" action="another thing">Maxim two</principle>
`
      const result = extractPrinciplesFromRaw(raw)
      assert.equal(result.length, 2)
      assert.equal(result[0]!.key, 'Y1')
      assert.equal(result[0]!.actionPrompt, 'do the thing')
      assert.equal(result[0]!.maxim, 'Maxim one')
      assert.equal(result[1]!.key, 'Y2')
    })

    it('returns empty array when no tags present', () => {
      const result = extractPrinciplesFromRaw('Just plain text, no tags.')
      assert.equal(result.length, 0)
    })
  })

  describe('dynamic principle pool (with cwd)', () => {
    it('loads principles from capsule docs when cwd is set', () => {
      const previousTrust = process.env.RIVET_TRUST_PROJECT
      process.env.RIVET_TRUST_PROJECT = '1'
      try {
        const cwd = process.cwd()
        const h = createHarness({ evidenceOverrides: { filesModified: new Set(['a.ts']) }, cwd })
        h.run(makeSnapshot({
          turn: 5,
          sensorium: makeSensorium({ confidence: 0.2 }),
          vigor: makeVigor({ vigor: 0.8 }),
        }))
        const ccrEntries = h.submitted.filter(e => e.key.startsWith('ccr-'))
        assert.equal(ccrEntries.length, 1)
        assert.equal(h.triggerEvents.length, 1)
        assert.equal(h.triggerEvents[0]!.dynamicPool, true, 'should use dynamic pool from capsule docs')
      } finally {
        if (previousTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
        else process.env.RIVET_TRUST_PROJECT = previousTrust
      }
    })

    it('falls back to hardcoded pool when cwd has no capsule docs', () => {
      const h = createHarness({ evidenceOverrides: { filesModified: new Set(['a.ts']) }, cwd: '/nonexistent/path' })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      const ccrEntries = h.submitted.filter(e => e.key.startsWith('ccr-'))
      assert.equal(ccrEntries.length, 1)
      assert.equal(h.triggerEvents.length, 1)
      assert.equal(h.triggerEvents[0]!.dynamicPool, false, 'should fall back to hardcoded pool')
    })
  })

  describe('capsule recall attachment (触发面修复 2026-07-04)', () => {
    it('attaches an informational capsule-recall entry when a rule fires with capsule docs', () => {
      const previousTrust = process.env.RIVET_TRUST_PROJECT
      process.env.RIVET_TRUST_PROJECT = '1'
      try {
        const cwd = process.cwd()
        const h = createHarness({ evidenceOverrides: { filesModified: new Set(['a.ts']) }, cwd })
        h.run(makeSnapshot({
          turn: 5,
          sensorium: makeSensorium({ confidence: 0.2 }),
          vigor: makeVigor({ vigor: 0.8 }),
        }))
        const recall = h.submitted.find(e => e.key === 'capsule-recall')
        assert.ok(recall, 'capsule-recall entry attached alongside the CCR entry')
        assert.equal(recall!.tier, 'informational')
        assert.equal(recall!.category, 'star_domain')
        assert.ok(recall!.content.includes('recall_capsule'), 'content points to the recall entrypoint')
      } finally {
        if (previousTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
        else process.env.RIVET_TRUST_PROJECT = previousTrust
      }
    })

    it('does not attach recall when cwd is absent (no capsule source)', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.filter(e => e.key === 'capsule-recall').length, 0)
    })

    it('includes the selected principle action in the CCR content', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.ok(h.submitted[0]!.content.includes('行动指引：'), 'principle actionPrompt 必须送达模型')
    })
  })

  describe('P7: 天权 — verification failure inflation', () => {
    const failedRun = { tool: 'run_tests', status: 'failed' as const, target: 'src/foo.test.ts' }
    const okRun = { tool: 'run_tests', status: 'success' as const, target: 'src/foo.test.ts' }
    const edit = { tool: 'edit_file', status: 'success' as const, target: 'src/foo.ts' }

    it('fires on >=2 consecutive semantic verification failures without edits (true loop)', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [failedRun, failedRun],
      }))
      assert.equal(h.submitted.length, 1)
      assert.match(h.submitted[0]!.key, /ccr-天权-P7/)
      assert.ok(h.submitted[0]!.content.includes('有效连败 2 次'))
    })

    it('does NOT fire on RED→edit→RED — TDD loop gets one dilution', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [failedRun, edit, failedRun],
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P7')).length, 0)
    })

    it('does NOT fire on RED→read→RED — diagnostic gap gets one dilution (H1)', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [failedRun, { tool: 'read_file', status: 'success' as const, target: 'src/foo.ts' }, failedRun],
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P7')).length, 0)
    })

    it('fires on RED→edit→RED→edit→RED — dilution is capped at one', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [failedRun, edit, failedRun, edit, failedRun],
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P7')).length, 1)
    })

    it('does not fire when a later verification succeeded', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [failedRun, failedRun, okRun],
      }))
      const p7 = h.submitted.filter(e => e.key.includes('P7'))
      assert.equal(p7.length, 0)
    })

    it('ignores environment/timeout failures (non-semantic)', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [
          { tool: 'run_tests', status: 'failed' as const, target: 't', errorClass: 'environment' as const },
          { tool: 'run_tests', status: 'failed' as const, target: 't', errorClass: 'timeout' as const },
        ],
      }))
      const p7 = h.submitted.filter(e => e.key.includes('P7'))
      assert.equal(p7.length, 0)
    })

    it('is NOT suppressed by test intent — the failing test IS the moment', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 4,
        recentToolHistory: [failedRun, failedRun],
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P7')).length, 1)
    })
  })

  describe('computeVerifyFailStreak — 封顶稀释矩阵（计划瑶光复核版）', () => {
    const RED = { tool: 'run_tests', status: 'failed' as const, target: 't.test.ts' }
    const RED_TEST_RED = { tool: 'run_tests', status: 'failed' as const, target: 't.test.ts', errorClass: 'test_red' }
    const GREEN = { tool: 'run_tests', status: 'success' as const, target: 't.test.ts' }
    const BASH_FAIL = { tool: 'bash', status: 'failed' as const, target: 'npm test' }
    const EDIT = { tool: 'edit_file', status: 'success' as const, target: 'src/a.ts' }
    const PATCH = { tool: 'apply_patch', status: 'success' as const, target: 'src/a.ts' }
    const READ = { tool: 'read_file', status: 'success' as const, target: 'src/a.ts' }
    const TIMEOUT = { tool: 'run_tests', status: 'failed' as const, target: 't', errorClass: 'timeout' }

    it('RED→edit→RED = 1（TDD 豁免一次）', () => {
      assert.equal(computeVerifyFailStreak([RED, EDIT, RED]), 1)
    })

    it('RED→RED 无编辑 = 2（真死循环）', () => {
      assert.equal(computeVerifyFailStreak([RED, RED]), 2)
    })

    it('RED→edit→RED→edit→RED = 2（稀释封顶 1）', () => {
      assert.equal(computeVerifyFailStreak([RED, EDIT, RED, EDIT, RED]), 2)
    })

    it('RED→edit→RED→GREEN = 0（成功重置）', () => {
      assert.equal(computeVerifyFailStreak([RED, EDIT, RED, GREEN]), 0)
    })

    it('timeout 失败跳过保持：RED(timeout)→RED = 1', () => {
      assert.equal(computeVerifyFailStreak([TIMEOUT, RED]), 1)
    })

    it('混合验证工具：bash(fail)→edit→run_tests(test_red) = 1', () => {
      assert.equal(computeVerifyFailStreak([BASH_FAIL, EDIT, RED_TEST_RED]), 1)
    })

    it('取证间隔也豁免一次：RED→read_file→RED = 1（诊断循环，H1 修复）', () => {
      assert.equal(computeVerifyFailStreak([RED, READ, RED]), 1)
    })

    it('取证豁免封顶 1：RED→read→RED→read→RED = 2（读两次仍不改代码，触发）', () => {
      assert.equal(computeVerifyFailStreak([RED, READ, RED, READ, RED]), 2)
    })

    it('编辑与取证豁免独立封顶：RED→edit→RED→read→RED = 1（TDD+诊断，活跃工作）', () => {
      assert.equal(computeVerifyFailStreak([RED, EDIT, RED, READ, RED]), 1)
    })

    it('同一间隔夹编辑+只读只算编辑豁免：RED→read→edit→RED = 1', () => {
      assert.equal(computeVerifyFailStreak([RED, READ, EDIT, RED]), 1)
    })

    it('apply_patch 也是编辑：RED→patch→RED = 1', () => {
      assert.equal(computeVerifyFailStreak([RED, PATCH, RED]), 1)
    })

    it('test_red 不进 skip 名单：纯重跑 test_red×2 = 2（真死循环检测保留）', () => {
      assert.equal(computeVerifyFailStreak([RED_TEST_RED, RED_TEST_RED]), 2)
    })

    it('长 TDD 链：RED→edit→RED→edit→RED→edit→RED = 3（持续触发）', () => {
      assert.equal(computeVerifyFailStreak([RED, EDIT, RED, EDIT, RED, EDIT, RED]), 3)
    })
  })

  describe('computeReadOnlyStreak — PRODUCTIVE_TOOLS 单一事实源（A2）', () => {
    const read = { tool: 'read_file', status: 'success' as const, target: 'src/a.ts' }

    it('apply_patch 打断只读 streak（含 check_only 预检——按纪律预检不算空转）', () => {
      assert.equal(computeReadOnlyStreak([read, read, { tool: 'apply_patch', status: 'success' as const, target: 'src/a.ts' }, read]), 1)
    })

    it('ast_edit 打断只读 streak（含 dryRun 预览）', () => {
      assert.equal(computeReadOnlyStreak([read, read, { tool: 'ast_edit', status: 'success' as const, target: 'src/a.ts' }, read]), 1)
    })

    it('plan_submit 打断只读 streak（规划产出是有意义动作）', () => {
      assert.equal(computeReadOnlyStreak([read, { tool: 'plan_submit', status: 'success' as const, target: 'plan' }, read, read]), 2)
    })

    it('纯只读不打断', () => {
      assert.equal(computeReadOnlyStreak([read, { tool: 'grep', status: 'success' as const, target: 'x' }, read]), 3)
    })
  })

  describe('P6: 天璇 — investigation stall (read-only + low momentum)', () => {
    const makeReads = (n: number) => Array.from({ length: n }, (_, i) => ({
      tool: 'read_file', status: 'success' as const, target: `src/f${i}.ts`,
    }))
    const reads = makeReads(7)

    it('diagnostic 态阈值抬到 10：纯只读 10 连击才触发（A1 阈值分级）', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 8,
        sensorium: makeSensorium({ momentum: 0.2 }),
        recentToolHistory: makeReads(10),
      }))
      assert.equal(h.submitted.length, 1)
      assert.match(h.submitted[0]!.key, /ccr-天璇-P6/)
    })

    it('diagnostic 态 streak 6-9 不触发——正常取证批次不误罚（M2 修复）', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 8,
        sensorium: makeSensorium({ momentum: 0.2 }),
        recentToolHistory: reads,
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P6')).length, 0)
    })

    it('build 态（窗口内有产出工具）保持阈值 6：干着干着卡进读循环才是真停滞', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 8,
        sensorium: makeSensorium({ momentum: 0.2 }),
        // 窗口 8：前 2 个产出 + 后 6 个只读 → 只读占比 0.75 < 0.8 → build
        recentToolHistory: [
          { tool: 'bash', status: 'success' as const, target: 'npm run build' },
          { tool: 'bash', status: 'success' as const, target: 'npm run lint' },
          ...makeReads(6),
        ],
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P6')).length, 1)
      assert.match(h.submitted[0]!.key, /ccr-天璇-P6/)
    })

    it('does not fire when momentum is healthy', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 8,
        sensorium: makeSensorium({ momentum: 0.7 }),
        recentToolHistory: makeReads(10),
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P6')).length, 0)
    })

    it('does not fire when files were modified (implementation, not investigation)', () => {
      const h = createHarness({ filesModified: new Set(['a.ts']) })
      h.run(makeSnapshot({
        turn: 8,
        sensorium: makeSensorium({ momentum: 0.2 }),
        recentToolHistory: reads,
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P6')).length, 0)
    })

    it('does not fire when an edit interrupts the read streak', () => {
      const h = createHarness()
      h.run(makeSnapshot({
        turn: 8,
        sensorium: makeSensorium({ momentum: 0.2 }),
        recentToolHistory: [...reads.slice(0, 3), { tool: 'edit_file', status: 'success' as const, target: 'a.ts' }, ...reads.slice(0, 3)],
      }))
      assert.equal(h.submitted.filter(e => e.key.includes('P6')).length, 0)
    })
  })

  describe('telemetry callback', () => {
    it('fires onTrigger with correct event shape', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.2 }),
        vigor: makeVigor({ vigor: 0.8 }),
      }))
      assert.equal(h.triggerEvents.length, 1)
      const event = h.triggerEvents[0]!
      assert.equal(event.rule, 'P1')
      assert.equal(event.star, '瑶光')
      assert.equal(event.turn, 5)
      assert.ok('verificationCoverage' in event.dimValues)
      assert.ok('vigor' in event.dimValues)
      assert.ok('vigorTonic' in event.dimValues)
      assert.ok('vigorPhasic' in event.dimValues)
    })
  })

  describe('synthetic playback: 排查任务 10 轮只读 + 验证失败 2 次', () => {
    it('CCR fires for both investigation-stall and verify-fail, within anti-spam bounds', () => {
      const h = createHarness()
      type Entry = { tool: string; status: 'success' | 'failed'; target: string }
      const history: Entry[] = []

      // A1 阈值分级后：纯只读排查（diagnostic 态）需要 streak≥10 才触发 P6，
      // 回放延长到 10 轮只读 + 2 轮验证失败。
      for (let turn = 1; turn <= 12; turn++) {
        if (turn <= 10) {
          history.push({ tool: turn % 2 === 0 ? 'grep' : 'read_file', status: 'success', target: `src/f${turn}.ts` })
        }
        if (turn === 11 || turn === 12) {
          history.push({ tool: 'run_tests', status: 'failed', target: 'src/foo.test.ts' })
        }
        h.run(makeSnapshot({
          turn,
          sensorium: makeSensorium({ momentum: 0.2 }),
          recentToolHistory: [...history],
        }))
      }

      const ccrEntries = h.submitted.filter(e => e.key.startsWith('ccr-'))
      assert.ok(ccrEntries.some(e => e.key.includes('P6')), '排查停滞（天璇）至少触发一次')
      assert.ok(ccrEntries.some(e => e.key.includes('P7')), '验证失败膨胀（天权）至少触发一次')
      // 防刷屏上界：12 轮内 CCR 触发不超过 3 次（星域冷却生效）
      assert.ok(ccrEntries.length <= 3, `anti-spam bound: got ${ccrEntries.length} CCR triggers in 12 turns`)
      // 任意连续 6 轮窗口内不超过 2 次
      const triggerTurns = h.triggerEvents.map(e => e.turn)
      for (let start = 1; start <= 7; start++) {
        const inWindow = triggerTurns.filter(t => t >= start && t < start + 6).length
        assert.ok(inWindow <= 2, `6-turn window starting at ${start} has ${inWindow} triggers`)
      }
    })
  })

  describe('瑶光 fallback pool ↔ capsule doc sync (静音之道 Y8–Y10)', () => {
    it('fallback pool mirrors every <principle> key in the shipped capsule doc', () => {
      const raw = readFileSync('docs/seed-capsule-yaoguang.md', 'utf-8')
      const docKeys = extractPrinciplesFromRaw(raw).map(p => p.key)
      const fallbackKeys = _STAR_FALLBACK_POOLS['瑶光'].map(p => p.key)
      for (const key of docKeys) {
        assert.ok(fallbackKeys.includes(key),
          `capsule principle ${key} missing from YAOGUANG_FALLBACK — 兜底落后于胶囊，裸环境缺方法论`)
      }
    })

    it('capsule doc carries the silence-audit principles Y8/Y9/Y10', () => {
      const raw = readFileSync('docs/seed-capsule-yaoguang.md', 'utf-8')
      const keys = extractPrinciplesFromRaw(raw).map(p => p.key)
      for (const key of ['Y8', 'Y9', 'Y10']) {
        assert.ok(keys.includes(key), `${key} missing from capsule doc`)
      }
    })
  })

  describe('P3 vigor tonic/phasic split', () => {
    it('selects Q3 when tonic is low', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.15 }),
        vigor: makeVigor({ vigor: 0.2, tonic: 0.2, phasic: 0.0 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.match(h.submitted[0]!.key, /ccr-天权-P3/)
      assert.equal(h.triggerEvents[0]!.principleKey, 'Q3')
    })

    it('selects X3 when phasic is very negative', () => {
      const h = createHarness({ filesModified: new Set(['a.ts', 'b.ts']) })
      h.run(makeSnapshot({
        turn: 5,
        sensorium: makeSensorium({ confidence: 0.15 }),
        vigor: makeVigor({ vigor: 0.2, tonic: 0.5, phasic: -0.4 }),
      }))
      assert.equal(h.submitted.length, 1)
      assert.match(h.submitted[0]!.key, /ccr-天权-P3/)
      assert.equal(h.triggerEvents[0]!.principleKey, 'X3')
    })
  })
})
