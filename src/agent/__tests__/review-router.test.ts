import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeReviewWorkflow } from '../review-router.js'
import type { ChangeSet } from '../review-discipline.js'
import type { ReviewRouterDeps, VerifierResult } from '../review-router.js'

const fixChange: ChangeSet = { files: ['package.json'], crossModule: false, isFix: true }

const okDeps: ReviewRouterDeps = {
  spawnVerifier: async () => ({ verdict: 'verified', evidence: 'ran: npx tsx --test src/server/__tests__/task-registry.test.ts → 43/43' }),
  spawnPatcher: async () => ({ patched: true }),
  spawnSquadron: async () => ({ findings: [] }),
}

describe('routeReviewWorkflow', () => {
  it('routes L1 README to nudge only and spawns no agents', async () => {
    let verifierCalls = 0
    let patcherCalls = 0
    let squadronCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['README.md'], crossModule: false, isFix: false },
      {
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: docs check' } },
        spawnPatcher: async () => { patcherCalls++; return { patched: true } },
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
      },
    )

    assert.equal(outcome.tier, 'L1')
    assert.equal(outcome.verdict, 'nudge')
    assert.equal(verifierCalls, 0)
    assert.equal(patcherCalls, 0)
    assert.equal(squadronCalls, 0)
  })

  it('routes L1 test-only fix to nudge (isFix does NOT force L2)', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['src/agent/__tests__/theta-check.test.ts'], crossModule: false, isFix: true },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: ok' } },
      },
    )

    assert.equal(outcome.tier, 'L1')
    assert.equal(outcome.verdict, 'nudge')
    assert.equal(verifierCalls, 0, 'test-only fix should not spawn verifier')
  })

  it('routes security boundary file to L3 squadron', async () => {
    let squadronCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['src/agent/approval-risk.ts'], crossModule: false, isFix: true },
      {
        ...okDeps,
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified')
    assert.equal(squadronCalls, 1, 'security boundary file should trigger squadron')
  })

  it('routes L2 fix through verifier and passes only with evidence', async () => {
    const outcome = await routeReviewWorkflow(fixChange, okDeps)

    assert.equal(outcome.tier, 'L2')
    assert.equal(outcome.verdict, 'verified')
    assert.match(outcome.evidence ?? '', /ran:/)
    assert.equal(outcome.rounds, 1)
  })

  it('treats verified without evidence as rejected and patches before retrying', async () => {
    const verdicts: VerifierResult[] = [
      { verdict: 'verified', evidence: '   ' },
      { verdict: 'verified', evidence: 'ran: npx test → pass' },
    ]
    let patcherCalls = 0

    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => verdicts.shift() ?? { verdict: 'verified', evidence: 'ran: fallback' },
      spawnPatcher: async () => {
        patcherCalls++
        return { patched: true, changedFiles: ['package.json'], patchSummary: '补了 scripts.test' }
      },
    }, { maxRounds: 2 })

    assert.equal(outcome.verdict, 'verified')
    assert.equal(outcome.rounds, 2)
    assert.equal(patcherCalls, 1)
    // verified 路径也要披露补丁产物——补丁工的改动不在主控工作树里，
    // 不披露就会被读成「修复已落地」（I2）。
    assert.deepEqual(outcome.patcherArtifacts, [
      { round: 1, changedFiles: ['package.json'], patchSummary: '补了 scripts.test' },
    ])
  })

  it('closed loop is bounded by maxRounds and then escalates', async () => {
    let verifierCalls = 0
    let patcherCalls = 0
    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => { verifierCalls++; return { verdict: 'rejected', evidence: 'counterexample: concurrent create duplicates task' } },
      spawnPatcher: async () => { patcherCalls++; return { patched: true, changedFiles: ['package.json'] } },
    }, { maxRounds: 3 })

    assert.equal(outcome.tier, 'L2')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.equal(outcome.rounds, 3)
    assert.equal(verifierCalls, 3)
    assert.equal(patcherCalls, 3)
    // rejected 路径：逐轮累积披露，主控能看到补丁工每轮改了什么
    assert.deepEqual(outcome.patcherArtifacts?.map(a => a.round), [1, 2, 3])
    assert.deepEqual(outcome.patcherArtifacts?.[0]?.changedFiles, ['package.json'])
  })

  it('routes L3 through squadron before verifier workflow', async () => {
    let squadronCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified')
    assert.equal(squadronCalls, 1)
  })

  it('rejects L3 when squadron reports high-severity findings before verifier can pass it', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: should not matter' } },
        spawnSquadron: async () => ({ findings: [{ severity: 'HIGH', claim: 'race condition in foo.ts:42', evidence: 'grep shows async setState without lock at foo.ts:42' }], infraFailures: [] }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.match(outcome.evidence ?? '', /squadron/i)
    assert.equal(verifierCalls, 0)
  })

  it('L3 squadron HIGH finding without evidence is downgraded to non-blocking (verified)', async () => {
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnSquadron: async () => ({
          findings: [{ severity: 'HIGH', claim: 'fromWave possibly undefined' }],
          infraFailures: [],
        }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    // No evidence → finding downgraded → squadron passes → verified
    assert.equal(outcome.verdict, 'verified')
    assert.match(outcome.evidence ?? '', /no blocking findings/i)
  })

  it('L3 squadron CRITICAL confirmation (polarity) never blocks — counted as 核实确认', async () => {
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnSquadron: async () => ({
          findings: [
            { severity: 'CRITICAL', claim: '注册链 + handler 三路径均已读码确认', evidence: 'src/a.ts:10', polarity: 'confirmation' },
            { severity: 'HIGH', claim: '四象限口径全对齐', evidence: 'src/b.ts:20', polarity: 'confirmation' },
          ],
          infraFailures: [],
        }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified', '确认性结论不是缺陷，不得 blocking')
    assert.match(outcome.evidence ?? '', /2 项核实确认/)
  })

  it('L3 squadron explicit defect CRITICAL still blocks', async () => {
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnSquadron: async () => ({
          findings: [{ severity: 'CRITICAL', claim: 'reasoningFloor 钳制使降档零净效果', evidence: 'src/c.ts:30', polarity: 'defect' }],
          infraFailures: [],
        }),
      },
    )

    assert.equal(outcome.verdict, 'rejected')
    assert.match(outcome.evidence ?? '', /reasoningFloor/)
  })

  it('L3 squadron CRITICAL without polarity still blocks (fail-closed 兼容存量)', async () => {
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnSquadron: async () => ({
          findings: [{ severity: 'CRITICAL', claim: 'yolo 豁免 request_path_access', evidence: 'src/d.ts:40' }],
          infraFailures: [],
        }),
      },
    )

    assert.equal(outcome.verdict, 'rejected')
  })

  it('L3 squadron with infra-only failures returns verified (no L2 fallthrough)', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: npx tsc --noEmit → ok' } },
        spawnSquadron: async () => ({
          findings: [],
          infraFailures: [{ kind: 'json', claim: 'Worker result did not contain a JSON object' }],
        }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified')
    assert.equal(verifierCalls, 0, 'L3 squadron pass skips L2 verifier')
    assert.equal(outcome.infraFailures?.length, 1)
    assert.match(outcome.evidence ?? '', /squadron/i)
  })

  it('L3 squadron with infra-only failures still passes (no L2 fallthrough)', async () => {
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => ({ verdict: 'verified', evidence: '   ' }),
        spawnSquadron: async () => ({
          findings: [],
          infraFailures: [{ kind: 'timeout', claim: 'review worker timed out' }],
        }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified', 'L3 squadron pass: no blocking findings → verified')
    assert.equal(outcome.infraFailures?.length, 1)
  })

  describe('auto mode (in-task review)', () => {
    const codeChange: ChangeSet = { files: ['src/agent/loop.ts'], crossModule: false, isFix: false }

    it('routes non-trivial change to a single wiring reviewer, not squadron/verifier', async () => {
      let wiringCalls = 0
      let squadronCalls = 0
      let verifierCalls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: x' } },
        spawnPatcher: async () => ({ patched: true }),
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
        spawnWiringReviewer: async () => { wiringCalls++; return { findings: [], infraFailures: [] } },
      }, { mode: 'auto' })

      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'verified')
      assert.equal(wiringCalls, 1)
      assert.equal(squadronCalls, 0, 'auto mode must never spawn the full squadron')
      assert.equal(verifierCalls, 0, 'auto mode must never spawn the adversarial verifier')
    })

    it('auto mode: wiring CRITICAL confirmation → verified with 核实确认 count', async () => {
      const outcome = await routeReviewWorkflow(codeChange, {
        spawnVerifier: async () => ({ verdict: 'verified', evidence: 'ran: x' }),
        spawnPatcher: async () => ({ patched: true }),
        spawnSquadron: async () => ({ findings: [] }),
        spawnWiringReviewer: async () => ({
          findings: [{ severity: 'CRITICAL', claim: '接线闭环已读码确认', evidence: 'src/agent/loop.ts:10', polarity: 'confirmation' }],
          infraFailures: [],
        }),
      }, { mode: 'auto' })

      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'verified', '确认性 CRITICAL 不得 blocking')
      assert.match(outcome.evidence ?? '', /1 项核实确认/)
    })

    it('downgrades structural L3 signals to the single wiring reviewer in auto mode', async () => {
      let wiringCalls = 0
      let squadronCalls = 0
      const outcome = await routeReviewWorkflow(
        { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: true, isFix: false },
        {
          ...okDeps,
          spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
          spawnWiringReviewer: async () => { wiringCalls++; return { findings: [] } },
        },
        { mode: 'auto' },
      )

      assert.equal(outcome.tier, 'auto')
      assert.equal(wiringCalls, 1)
      assert.equal(squadronCalls, 0)
    })

    it('blocks on CRITICAL/HIGH wiring findings', async () => {
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => ({
          findings: [{ severity: 'HIGH', claim: 'dead param: activeTaskIds has zero callers', evidence: 'grep -rn activeTaskIds src/ → 0 call sites outside declaration' }],
        }),
      }, { mode: 'auto' })

      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'rejected')
      assert.match(outcome.evidence ?? '', /dead param/)
    })

    it('fails open on infra failures as INCONCLUSIVE — never claims verified', async () => {
      let calls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => {
          calls++
          return {
            findings: [],
            infraFailures: [{ kind: 'timeout', claim: 'wiring reviewer timed out' }],
          }
        },
      }, { mode: 'auto' })

      assert.equal(outcome.verdict, 'inconclusive', 'infra failure must not produce a verified verdict')
      assert.equal(outcome.infraFailures?.length, 1)
      assert.match(outcome.evidence ?? '', /DID NOT run/)
      assert.doesNotMatch(outcome.evidence ?? '', /verified/i)
      assert.equal(calls, 1, 'timeout infra failure must NOT be retried — budget is exhausted')
    })

    it('does NOT retry on non-timeout infra failure (no retry policy, 2026-07-29)', async () => {
      let calls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => {
          calls++
          return { findings: [], infraFailures: [{ kind: 'json', claim: 'non-JSON worker output' }] }
        },
      }, { mode: 'auto' })

      assert.equal(calls, 1, 'no retry — same model + budget = same failure')
      assert.equal(outcome.verdict, 'inconclusive')
    })

    it('keeps trivial docs/test-only changes at nudge with no child agents', async () => {
      let wiringCalls = 0
      const outcome = await routeReviewWorkflow(
        { files: ['README.md', 'src/agent/__tests__/x.test.ts'], crossModule: false, isFix: false },
        { ...okDeps, spawnWiringReviewer: async () => { wiringCalls++; return { findings: [] } } },
        { mode: 'auto' },
      )

      assert.equal(outcome.verdict, 'nudge')
      assert.equal(wiringCalls, 0)
    })

    it('degrades to nudge when spawnWiringReviewer is not wired', async () => {
      const outcome = await routeReviewWorkflow(codeChange, okDeps, { mode: 'auto' })
      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'nudge')
    })

    it('auto-L1：小改动（单文件、非核心路径）不 spawn worker', async () => {
      let wiringCalls = 0
      const outcome = await routeReviewWorkflow(
        { files: ['src/utils/format.ts'], crossModule: false, isFix: false },
        { ...okDeps, spawnWiringReviewer: async () => { wiringCalls++; return { findings: [] } } },
        { mode: 'auto' },
      )
      assert.equal(outcome.verdict, 'nudge')
      assert.equal(wiringCalls, 0, 'auto-L1 零 worker 成本')
    })

    it('auto-L2：≥3 文件（非核心路径）仍 spawn wiring reviewer', async () => {
      let wiringCalls = 0
      const outcome = await routeReviewWorkflow(
        { files: ['src/utils/a.ts', 'src/utils/b.ts', 'src/utils/c.ts'], crossModule: false, isFix: false },
        { ...okDeps, spawnWiringReviewer: async () => { wiringCalls++; return { findings: [], infraFailures: [] } } },
        { mode: 'auto' },
      )
      assert.equal(outcome.verdict, 'verified')
      assert.equal(wiringCalls, 1)
    })

    it('budget 失败（max-turns 耗尽）不重试，标签为「审查预算耗尽」', async () => {
      let calls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => {
          calls++
          return { findings: [], infraFailures: [{ kind: 'budget', claim: 'max-turns: exhausted without a final turn' }] }
        },
      }, { mode: 'auto' })

      assert.equal(calls, 1, 'budget 是确定性失败，同预算重试必死，不得重试')
      assert.equal(outcome.verdict, 'inconclusive')
      assert.match(outcome.evidence ?? '', /审查预算耗尽/)
      assert.doesNotMatch(outcome.evidence ?? '', /infra failure/)
    })
  })

  it('escalates immediately when patcher reports it did not patch a verifier rejection', async () => {
    let verifierCalls = 0
    let patcherCalls = 0
    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => { verifierCalls++; return { verdict: 'rejected', evidence: 'broken' } },
      spawnPatcher: async () => { patcherCalls++; return { patched: false } },
    }, { maxRounds: 3 })

    assert.equal(outcome.tier, 'L2')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.equal(outcome.rounds, 1)
    assert.equal(outcome.evidence, 'broken')
    assert.equal(verifierCalls, 1)
    assert.equal(patcherCalls, 1)
  })

  it('forwards options.onActivity to wiring reviewer spawns in auto mode (review-gate UI visibility)', async () => {
    const onActivity = () => {}
    const seen: unknown[] = []
    const outcome = await routeReviewWorkflow(
      { files: ['src/agent/loop.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnWiringReviewer: async (_change, _signal, activity) => {
          seen.push(activity)
          return { findings: [] }
        },
      },
      { mode: 'auto', onActivity },
    )

    assert.equal(outcome.verdict, 'verified')
    assert.equal(seen.length, 1)
    assert.equal(seen[0], onActivity)
  })

  it('forwards options.onActivity to verifier/patcher/squadron spawns in manual mode', async () => {
    const onActivity = () => {}
    const seen: Record<string, unknown> = {}
    let verifyCalls = 0
    const outcome = await routeReviewWorkflow(fixChange, {
      spawnVerifier: async (_c, _s, activity) => {
        verifyCalls++
        seen.verifier = activity
        return verifyCalls === 1
          ? { verdict: 'rejected', evidence: 'broken' }
          : { verdict: 'verified', evidence: 'ran: ok' }
      },
      spawnPatcher: async (_c, _v, _s, activity) => { seen.patcher = activity; return { patched: true } },
      spawnSquadron: async (_c, _s, activity) => { seen.squadron = activity; return { findings: [] } },
    }, { onActivity, maxRounds: 2 })

    assert.equal(outcome.verdict, 'verified')
    assert.equal(seen.verifier, onActivity)
    assert.equal(seen.patcher, onActivity)
    assert.equal(seen.squadron, undefined, 'L2 fix must not spawn the squadron')

    const l3 = await routeReviewWorkflow(
      { files: ['src/agent/approval-risk.ts'], crossModule: false, isFix: true },
      {
        ...okDeps,
        spawnSquadron: async (_c, _s, activity) => { seen.squadron = activity; return { findings: [] } },
      },
      { onActivity },
    )
    assert.equal(l3.verdict, 'verified')
    assert.equal(seen.squadron, onActivity)
  })

  // ── 补丁产物句柄透传 + verified 出口覆盖（本轮修复） ──

  it('rejected 出口：diffArtifactId 一路透传到 patcherArtifacts', async () => {
    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => ({ verdict: 'rejected', evidence: 'counterexample: x' }),
      spawnPatcher: async () => ({ patched: true, changedFiles: ['package.json'], diffArtifactId: 'art_r1' }),
    })

    assert.equal(outcome.verdict, 'rejected')
    assert.equal(
      outcome.patcherArtifacts?.[0]?.diffArtifactId,
      'art_r1',
      '补丁句柄在 review 内部被丢弃——主控拿不到补丁，只能重新派发',
    )
  })

  it('maxRounds≥2 且第二轮验证通过：verified 出口同样携带补丁产物与句柄', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      fixChange,
      {
        ...okDeps,
        spawnVerifier: async () => {
          verifierCalls++
          return verifierCalls === 1
            ? { verdict: 'rejected', evidence: 'counterexample: x' }
            : { verdict: 'verified', evidence: 'ran: ok after patch' }
        },
        spawnPatcher: async () => ({ patched: true, changedFiles: ['package.json'], diffArtifactId: 'art_r2' }),
      },
      { maxRounds: 2 },
    )

    assert.equal(outcome.verdict, 'verified')
    assert.deepEqual(
      outcome.patcherArtifacts?.map(a => a.round),
      [1],
      'verified 出口漏掉补丁产物 → 主控会把「验证通过」读成「修复已落地」',
    )
    assert.equal(outcome.patcherArtifacts?.[0]?.diffArtifactId, 'art_r2')
  })
})
