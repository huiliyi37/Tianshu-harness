import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDeliverTaskTool, detectSymptomPatch, parseLearnedEntries, resetPostCommitReviewCooldown, __expirePostCommitReviewCooldown } from '../deliver-task.js'
import { appendMemoryEntry, readMemoryEntries } from '../../memory/unified-memory.js'
import { consumePostCommitReviewOutcomes, __resetPostCommitReviewQueue } from '../post-commit-review-queue.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import type { ChangeSet } from '../review-discipline.js'
import type { ReviewOutcome, ReviewRouterDeps, ReviewRouterOptions } from '../review-router.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import type { ToolCallParams, ToolResult, DelegationActivity } from '../../tools/types.js'
import type { SessionRegistry } from '../session-registry.js'
import { getReviewHealth, resetReviewHealth } from '../review-health.js'

function makeContext(opts: {
  taskId: string
  ownedFiles: string[]
  externalFiles?: string[]
  preExistingUntracked?: string[]
  dirtyFiles?: string[]
  verifications?: Array<{ command: string; status: 'passed' | 'failed' | 'blocked'; meta?: Record<string, unknown> }>
  projectMemory?: string
  commitOwnedFiles?: (cwd: string, files: string[], message: string) => { ok: boolean; output: string }
  routeReviewWorkflow?: (change: ChangeSet, deps: ReviewRouterDeps, options?: ReviewRouterOptions) => Promise<ReviewOutcome>
  reviewDeps?: ReviewRouterDeps
  disableReviewDeps?: boolean
  reviewDepth?: number
  sessionRegistry?: SessionRegistry
  sessionId?: string
  detectWroteButNeverRead?: (cwd: string, files: string[]) => Array<{ symbol: string; file: string; kind: 'export' | 'field' }>
  meridianDb?: import('../../repo/meridian-db.js').MeridianDb
  typecheckRunner?: import('../typecheck-gate.js').TypecheckRunner
  declaredCheckRunner?: import('../typecheck-gate.js').DeclaredCommandRunner
  taskContract?: import('../../context/task-contract.js').TaskContract
  inventorySearcher?: import('../regression-inventory.js').InventorySearcher
  obligationGateRunner?: import('../council/council-obligations.js').GateRunner
  impactedTests?: string[]
  palConvergedCases?: import('../problem-attack-loop.js').ConvergedCaseEntry[]
  palNeedsUserCases?: Array<{ caseId: string; problem: string; minimalQuestion: string }>
  reviewConfig?: import('../../config/schema.js').ReviewConfig
  isAutoReviewOff?: boolean
  goalAchieved?: boolean
  autoCommit?: boolean
  obligationStore?: import('../evidence-obligation.js').ObligationStore
  claimTracker?: import('../hooks/external-claim-tracking-hook.js').ClaimTracker
  scoutFirewall?: boolean
}) {
  const baseline = createWorktreeBaseline({
    branch: 'feat/b1',
    head: 'abc123',
    preExistingDirty: opts.externalFiles ?? [],
    preExistingUntracked: opts.preExistingUntracked ?? [],
    capturedAt: Date.now(),
  })
  const ledger = createTaskLedger({ taskId: opts.taskId })
  for (const f of opts.ownedFiles) ledger.record({ type: 'file_write', path: f })
  for (const v of (opts.verifications ?? [])) ledger.record({ type: 'verification', command: v.command, status: v.status, meta: v.meta })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  ownership.autoOwnFromLedger()
  const attribution = createVerificationAttribution({ ownership })
  const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution })

  const tool = createDeliverTaskTool(() => ({
    taskLedger: ledger,
    ownership,
    gate,
    sessionRegistry: opts.sessionRegistry,
    sessionId: opts.sessionId,
    getCurrentDirtyFiles: () => opts.dirtyFiles,
    getProjectMemoryContent: () => opts.projectMemory,
    commitOwnedFiles: opts.commitOwnedFiles,
    routeReviewWorkflow: opts.disableReviewDeps
      ? opts.routeReviewWorkflow
      : (opts.routeReviewWorkflow ?? (async () => ({ tier: 'L2', verdict: 'verified', evidence: 'test review shim', rounds: 1 }))),
    reviewDeps: opts.disableReviewDeps ? undefined : (opts.reviewDeps ?? {} as ReviewRouterDeps),
    reviewDepth: opts.reviewDepth,
    detectWroteButNeverRead: opts.detectWroteButNeverRead ?? (() => []),
    meridianIndexer: opts.meridianDb ? { getDb: () => opts.meridianDb! } as unknown as import('../../repo/meridian-indexer.js').MeridianIndexer : null,
    typecheckRunner: opts.typecheckRunner,
    declaredCheckRunner: opts.declaredCheckRunner,
    getTaskContract: opts.taskContract ? () => opts.taskContract : undefined,
    inventorySearcher: opts.inventorySearcher,
    obligationGateRunner: opts.obligationGateRunner,
    getImpactedTests: opts.impactedTests ? () => opts.impactedTests! : undefined,
    getPalConvergedCases: opts.palConvergedCases ? () => opts.palConvergedCases! : undefined,
    getPalNeedsUserCases: opts.palNeedsUserCases ? () => opts.palNeedsUserCases! : undefined,
    reviewConfig: opts.reviewConfig,
    isAutoReviewOff: opts.isAutoReviewOff !== undefined ? () => opts.isAutoReviewOff! : undefined,
    isGoalAchieved: opts.goalAchieved !== undefined ? () => opts.goalAchieved! : undefined,
    autoCommit: opts.autoCommit,
    getObligationStore: opts.obligationStore ? () => opts.obligationStore! : undefined,
    getClaimTracker: opts.claimTracker ? () => opts.claimTracker! : undefined,
    scoutFirewallConfig: opts.scoutFirewall,
  }))

  const params: ToolCallParams = {
    input: {},
    toolUseId: 'test-1',
    cwd: '/fake/project',
    taskId: opts.taskId,
    ownedFiles: opts.ownedFiles,
  }

  return { tool, params, ledger, ownership, gate }
}

function toolDescription(): string {
  const { tool } = makeContext({
    taskId: 'schema',
    ownedFiles: [],
  })
  return tool.definition.description
}

/** Let the detached (fire-and-forget) post-commit review promise settle. */
async function settleDetachedReview(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** Settle a whole detached review CHAIN: initial review + in-flight follow-up
 *  sweep (each hop is microtask-only once the route mock resolves, but the
 *  chain is launched from .finally callbacks — give it several macrotask
 *  ticks instead of one). */
async function settleReviewChain(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

describe('deliver-task — semantic task delivery tool', () => {
  beforeEach(() => {
    resetPostCommitReviewCooldown()
    __resetPostCommitReviewQueue()
  })

  it('reports GREEN delivery readiness when verified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('GREEN'))
  })

  it('reports RED without marking status-only report as tool error when unverified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('RED'))
  })

  it('W1: commit=true blocked when impacted tests were never covered (module_unverified → RED)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-impacted-'))
    try {
      mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(dir, 'src', '__tests__', 'consumer.test.ts'), '// impacted test')
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsx --test src/__tests__/a.test.ts', status: 'passed', meta: { scope: 'targeted' } }],
        impactedTests: ['src/__tests__/consumer.test.ts'],
        commitOwnedFiles: () => {
          throw new Error('commit executor should not run when impacted tests are uncovered')
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'fix: test' } })
      assert.equal(result.isError, true)
      assert.ok(result.content.includes('impacted tests'))
      assert.ok(result.content.includes('src/__tests__/consumer.test.ts'))
      assert.ok(result.content.includes('force=true'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('W1: force=true overrides module_unverified block (逃生口)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-force-'))
    try {
      mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(dir, 'src', '__tests__', 'consumer.test.ts'), '// impacted test')
      let committed = false
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsx --test src/__tests__/a.test.ts', status: 'passed', meta: { scope: 'targeted' } }],
        impactedTests: ['src/__tests__/consumer.test.ts'],
        commitOwnedFiles: () => {
          committed = true
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, force: true, message: 'fix: test' } })
      assert.equal(result.isError ?? false, false)
      assert.equal(committed, true)
      assert.ok(result.content.includes('module_unverified overridden'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('W1: status-only module_unverified reports YELLOW without tool error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-status-'))
    try {
      mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(dir, 'src', '__tests__', 'consumer.test.ts'), '// impacted test')
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsx --test src/__tests__/a.test.ts', status: 'passed', meta: { scope: 'targeted' } }],
        impactedTests: ['src/__tests__/consumer.test.ts'],
      })

      const result = await tool.execute({ ...params, cwd: dir })
      assert.equal(result.isError ?? false, false)
      assert.ok(result.content.includes('YELLOW'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('W1: nonexistent impacted tests are uncoverable — commit proceeds (假阳性防御)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-uncoverable-'))
    try {
      let committed = false
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsx --test src/__tests__/a.test.ts', status: 'passed', meta: { scope: 'targeted' } }],
        impactedTests: ['src/deleted/__tests__/gone.test.ts'],
        commitOwnedFiles: () => {
          committed = true
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'fix: test' } })
      assert.equal(result.isError ?? false, false)
      assert.equal(committed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks commit=true RED as tool error because commit request is rejected', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run when gate is RED')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: test' } })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('RED'))
    assert.ok(result.content.includes('Cannot commit'))
    // Recovery guidance should be present
    assert.ok(result.content.includes('Recovery'))
    assert.ok(result.content.includes('TARGETED'))
  })

  it('RED with unverified files suggests targeted tests, not full suite', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run when gate is RED')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: test' } })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('unverified'))
    assert.ok(result.content.includes('Do NOT run the full test suite'))
  })

  it('reports YELLOW when external verification blocked but owned files verified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    // With only owned files verified and no external blocked verifications,
    // the gate is GREEN. YELLOW requires external blocked verifications.
    const result = await tool.execute(params)
    assert.ok(result.content.includes('GREEN'))
  })

  it('includes ownership report in output', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      externalFiles: ['src/ext.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)
    assert.ok(result.content.includes('src/a.ts'))
    assert.ok(result.content.includes('src/b.ts'))
    assert.ok(result.content.includes('src/ext.ts'))
  })

  it('handles empty delivery (no owned files)', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
    })

    const result = await tool.execute(params)
    assert.ok(result.content.includes('GREEN'))
    assert.ok(result.content.includes('(none)'))
  })

  it('reports failed verification details', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsx --test', status: 'failed' }],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('RED'))
    assert.ok(result.content.includes('failure'))
  })

  it('requires approval for commit action', () => {
    const { tool } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const needsApproval = tool.requiresApproval({
      input: { message: 'feat: deliver', commit: true },
      toolUseId: 'test-1',
      cwd: '/fake',
    })
    assert.equal(needsApproval, true)
  })

  it('executes scoped commit for commit=true when gate is green', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'feat: scoped delivery' }])
    assert.match(result.content, /Scoped commit created/)
    assert.match(result.content, /commit abc123/)
  })

  it('autoCommit=false skips git commit but still produces delivery report', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
      autoCommit: false,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    // Must NOT have called commitOwnedFiles
    assert.deepEqual(calls, [])
    // Must contain the manual-commit-mode message
    assert.match(result.content, /自动提交已关闭/)
    assert.match(result.content, /agent\.delivery\.autoCommit/)
  })

  it('describes complex spec checklist audit in the tool schema', () => {
    const description = toolDescription()

    assert.match(description, /复杂 spec 交付清单/)
    assert.match(description, /事实流图已验证/)
    assert.match(description, /条件矩阵已验证/)
    assert.match(description, /反例测试已验证/)
  })

  it('denoises junk external files: capped list + summary count (C-fix)', async () => {
    const junk = Array.from({ length: 67 }, (_, i) => `.test-tmp/corrupt-${i}.json`)
    const signal = ['src/important.ts', 'docs/notes.md']
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      externalFiles: [...junk, ...signal],
      dirtyFiles: ['src/a.ts', ...junk, ...signal],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute(params)

    assert.doesNotMatch(result.content, /\.test-tmp\/corrupt-/, 'junk paths must not be listed')
    assert.match(result.content, /src\/important\.ts/)
    assert.match(result.content, /\(\+67 more, 67 junk\/gitignored\)/)
    assert.match(result.content, /External files \(69\)/, 'count stays truthful even when display is filtered')
    // Gate section (up to "Verifications:") must stay compact.
    const gateSection = result.content.split('\n')
    const verifIdx = gateSection.findIndex(l => l.startsWith('Verifications:'))
    assert.ok(verifIdx >= 0 && verifIdx < 25, `gate file lists must stay compact, got ${verifIdx + 1} lines`)
  })

  it('caps long owned-file lists at 5 with a (+N more) summary (C-fix)', async () => {
    const owned = Array.from({ length: 12 }, (_, i) => `src/mod-${i}.ts`)
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: owned,
      dirtyFiles: owned,
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const result = await tool.execute({ ...params, ownedFiles: owned })

    assert.match(result.content, /Owned files \(12\)/)
    assert.match(result.content, /\(\+7 more\)/)
    assert.doesNotMatch(result.content, /src\/mod-9\.ts/, 'files beyond the cap are summarized, not listed')
  })

  it('surfaces wrote-but-never-read findings as a YELLOW hint without blocking the commit (D-fix)', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      detectWroteButNeverRead: () => [
        { symbol: 'modelOverride', file: 'src/a.ts', kind: 'field' },
      ],
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: add override' } })

    assert.equal(result.isError ?? false, false, 'nudge must not block delivery')
    assert.equal(committed, true)
    assert.match(result.content, /wrote-but-never-read/)
    assert.match(result.content, /modelOverride/)
    assert.match(result.content, /non-blocking/)
  })

  it('routes fix commits through ReviewRouter before scoped commit', async () => {
    const calls: Array<{ files: string[]; message: string }> = []
    let routedChange: ChangeSet | undefined
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedChange = change
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: npx tsc --noEmit → ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: (_cwd, files, message) => {
        calls.push({ files, message })
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routedChange?.files.join(','), 'src/a.ts')
    assert.equal(routedChange?.crossModule, false)
    assert.equal(routedChange?.isFix, true)
    assert.equal(routedChange?.goalActive, false)
    assert.deepEqual(calls, [{ files: ['src/a.ts'], message: 'fix: scoped delivery' }])
    // System-triggered review is detached — the tool result reports the handoff,
    // the verdict flows through the post-commit review queue.
    assert.match(result.content, /提交后审查已转后台/)
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.verdict, 'verified')
    assert.match(outcomes[0]!.lines.join('\n'), /审查通过 \(L2\)/)
  })

  it('commit succeeds when ReviewRouter rejects — review is advisory post-commit', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'L2', verdict: 'rejected', escalated: true, rounds: 3, evidence: 'still broken' }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    // Post-commit advisory: the commit has landed even if review found issues.
    assert.equal(result.isError ?? false, false)
    assert.equal(committed, true)
    assert.match(result.content, /提交后审查已转后台/)
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.verdict, 'rejected')
    const text = outcomes[0]!.lines.join('\n')
    assert.match(text, /审查门发现问题 \(L2\)/)
    assert.match(text, /still broken/)
    assert.match(text, /提交已落地/)
    assert.match(text, /未经主控独立核验/, 'rejected review must carry independent-verification nudge')
  })

  it('renders auto-review infra failure as INCONCLUSIVE, never as verified (B-fix)', async () => {
    resetReviewHealth()
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({
        tier: 'auto',
        verdict: 'inconclusive',
        evidence: 'review DID NOT run (infra failure): worker: reviewer crashed',
        rounds: 1,
        infraFailures: [{ kind: 'worker', claim: 'reviewer crashed' }],
      }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false, 'inconclusive auto review must fail open')
    assert.equal(committed, true, 'delivery proceeds despite infra failure')
    assert.match(result.content, /提交后审查已转后台/)
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.verdict, 'inconclusive')
    const text = outcomes[0]!.lines.join('\n')
    assert.match(text, /审查未决 \(auto\)/)
    assert.match(text, /DID NOT run/)
    assert.match(text, /未经审查/)
    assert.doesNotMatch(text, /审查通过/, 'the word verified must not describe a review that never ran')
    assert.ok(result.content.length > 0, 'sentinel: content must never be empty')
    const health = getReviewHealth()
    assert.equal(health.infraFailureCount, 1)
    assert.equal(health.consecutiveInfraFailures, 1)
    assert.deepEqual(health.lastFailureKinds, ['worker'])
  })

  it('reports an honest INCONCLUSIVE when the auto review workflow throws (B-fix)', async () => {
    resetReviewHealth()
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { throw new Error('Review workflow timed out') },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false, 'auto review crash must fail open')
    assert.equal(committed, true)
    assert.match(result.content, /提交后审查已转后台/)
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.verdict, 'inconclusive')
    const text = outcomes[0]!.lines.join('\n')
    assert.match(text, /审查未决 \(auto\)/)
    assert.match(text, /DID NOT run/)
    assert.doesNotMatch(text, /审查通过/)
    assert.ok(result.content.length > 0, 'sentinel: content must never be empty')
    const health = getReviewHealth()
    assert.equal(health.infraFailureCount, 1)
    assert.deepEqual(health.lastFailureKinds, ['timeout'])
  })

  it('records healthy auto-review runs in review health (B-fix)', async () => {
    resetReviewHealth()
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'auto', verdict: 'verified', evidence: 'no blocking findings', rounds: 1 }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })
    await settleDetachedReview()

    const health = getReviewHealth()
    assert.equal(health.totalRuns, 1)
    assert.equal(health.infraFailureCount, 0)
    assert.equal(health.consecutiveInfraFailures, 0)
  })

  it('explicit review_level runs detached — verdict enqueued, not in tool result', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'L2', verdict: 'verified', evidence: 'ran: npx tsc --noEmit → ok', rounds: 1 }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery', review_level: 'L2' } })

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /提交后审查已转后台/, 'explicit review must be detached now')
    assert.doesNotMatch(result.content, /审查通过 \(L2\)/, 'verdict must NOT be in the tool result')
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1, 'detached path must enqueue')
    assert.ok(outcomes[0]!.lines.some(l => /审查通过 \(L2\)/.test(l)), 'verdict must land in post-commit queue')
  })

  it('off 模式（review.skipAuto）：系统自动审查被抑制，不 spawn 审查 worker', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { routeCalls++; return { tier: 'auto', verdict: 'verified', evidence: 'ok', rounds: 1 } },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      reviewConfig: { profiles: {}, skipAuto: true, skipAutoSpark: false, mechanicalFastPath: true },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })
    await settleDetachedReview()

    assert.equal(result.isError ?? false, false, 'off 模式不影响交付/提交本身')
    assert.equal(routeCalls, 0, 'off 模式下不得路由自动审查')
    assert.match(result.content, /自动审查已跳过/)
  })

  it('off 模式下显式 review_level 永远放行（skipAuto 不拦手动 /review）', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { routeCalls++; return { tier: 'L2', verdict: 'verified', evidence: 'ran: npx tsc --noEmit → ok', rounds: 1 } },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      reviewConfig: { profiles: {}, skipAuto: true, skipAutoSpark: false, mechanicalFastPath: true },
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery', review_level: 'L2' } })
    await settleDetachedReview()

    assert.equal(routeCalls, 1, '显式 review_level 是用户明确意图，必须绕过 off 抑制')
    assert.doesNotMatch(result.content, /自动审查已跳过/)
  })

  it('off 模式（isAutoReviewOff 会话开关）：自动审查被抑制', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { routeCalls++; return { tier: 'auto', verdict: 'verified', evidence: 'ok', rounds: 1 } },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      isAutoReviewOff: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })
    await settleDetachedReview()

    assert.equal(routeCalls, 0)
    assert.match(result.content, /自动审查已跳过/)
  })

  it('off 模式（isAutoReviewOff）+ 显式 review_level → 放行', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { routeCalls++; return { tier: 'L2', verdict: 'verified', evidence: 'ok', rounds: 1 } },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      isAutoReviewOff: true,
    })

    await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery', review_level: 'L2' } })
    await settleDetachedReview()

    assert.equal(routeCalls, 1, '会话 off 不得拦截显式手动审查')
  })

  it('off 模式下 goal-achieved 不再自动升 L3 终审', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => { routeCalls++; return { tier: 'L3', verdict: 'verified', evidence: 'ok', rounds: 0 } },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      reviewConfig: { profiles: {}, skipAuto: true, skipAutoSpark: false, mechanicalFastPath: true },
      goalAchieved: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: goal complete' } })
    await settleDetachedReview()

    assert.equal(routeCalls, 0, 'goal-achieved L3 是系统触发，off 模式一并抑制（用户可 /review max 手动终审）')
    assert.match(result.content, /自动审查已跳过/)
  })

  it('detached review outcome carries the commit reference for attribution', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'auto', verdict: 'verified', evidence: 'ok', rounds: 1 }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)
    assert.match(outcomes[0]!.lines[0]!, /^提交 \S+ 的提交后审查完成：$/)
  })

  it('detached review is visible: startup line + phantom running/terminal events (review-gate UI)', async () => {
    const outputs: string[] = []
    const activities: DelegationActivity[] = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => ({ tier: 'auto', verdict: 'verified', evidence: 'no blocking findings', rounds: 1 }),
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({
      ...params,
      input: { commit: true, message: 'feat: scoped delivery' },
      onOutput: chunk => outputs.push(chunk),
      onWorkerActivity: activity => activities.push(activity),
    })

    assert.match(result.content, /提交后审查已转后台/)
    // 启动行同步发出，措辞与显式路径一致并指向子代理面板
    assert.match(outputs.join(''), /提交后审查启动中 \(auto, ≤\d+s\)——审查 worker 进度见子代理面板/)
    const running = activities.filter(a => a.status === 'running')
    assert.equal(running.length, 1, '审查门自身必须有一条 phantom running 事件')
    assert.match(running[0]!.workOrderId, /^review-gate-/)
    assert.equal(running[0]!.parentToolId, 'test-1')
    assert.equal(running[0]!.profile, 'reviewer')

    await settleDetachedReview()
    const terminal = activities.filter(a => a.status !== 'running')
    assert.equal(terminal.length, 1, '有始必须有终：detached 审查结束要补终态事件')
    assert.equal(terminal[0]!.workOrderId, running[0]!.workOrderId)
    assert.equal(terminal[0]!.status, 'completed')
    assert.match(terminal[0]!.progressLine ?? '', /审查通过 \(auto\)/)
    assert.equal(terminal[0]!.failureReason, undefined)
  })

  it('detached review terminal events map verdict → status/failureReason (rejected/inconclusive/nudge)', async () => {
    const activities: DelegationActivity[] = []
    const cases: Array<{ outcome: ReviewOutcome; status: DelegationActivity['status']; failureReason?: string; progress: RegExp }> = [
      {
        outcome: { tier: 'L2', verdict: 'rejected', escalated: true, rounds: 3, evidence: 'still broken' },
        status: 'completed', failureReason: 'review-findings', progress: /审查门发现问题 \(L2\)/,
      },
      {
        outcome: { tier: 'auto', verdict: 'inconclusive', evidence: 'review DID NOT run (infra failure): timed out', rounds: 1, infraFailures: [{ kind: 'timeout', claim: 'x' }] },
        status: 'failed', failureReason: 'review-infra', progress: /审查未决 \(auto\)/,
      },
      {
        outcome: { tier: 'auto', verdict: 'nudge' },
        status: 'completed', failureReason: undefined, progress: /审查门完成 \(nudge\)：变更琐碎，免深审/,
      },
    ]
    for (const c of cases) {
      // 同一用例内多次 deliver 会触发 30s 冷却，逐轮复位
      resetPostCommitReviewCooldown()
      activities.length = 0
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        routeReviewWorkflow: async () => c.outcome,
        reviewDeps: {} as ReviewRouterDeps,
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })
      await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: scoped delivery' },
        onWorkerActivity: activity => activities.push(activity),
      })
      await settleDetachedReview()
      const terminal = activities.filter(a => a.status !== 'running')
      assert.equal(terminal.length, 1, `verdict=${c.outcome.verdict} 必须补终态事件`)
      assert.equal(terminal[0]!.status, c.status)
      assert.equal(terminal[0]!.failureReason, c.failureReason)
      assert.match(terminal[0]!.progressLine ?? '', c.progress)
    }
  })

  it('tool timeout budget — fast ownership query, no blocking stages', () => {
    const { tool, params } = makeContext({ taskId: 't1', ownedFiles: [] })
    const timeoutMs = tool.timeoutMs!
    // Readiness check: ownership query, no blocking stages.
    assert.equal(timeoutMs({ ...params, input: {} }), 60_000)
    // Commit: file I/O + git, no typecheck/review stages inside. 180s（而非
    // 60s）：满载机器 + 多会话大工作区上 60s 超时导致模型退回裸 git 提交
    //（2026-07-21 损毁提交事故），提交是终态动作，宁可慢不可断。
    assert.equal(timeoutMs({ ...params, input: { commit: true } }), 180_000)
    // Explicit review_level no longer adds budget — review is detached.
    assert.equal(timeoutMs({ ...params, input: { commit: true, review_level: 'L2' } }), 180_000)
  })

  it('routes non-fix code commits through ReviewRouter as objective review assistance', async () => {
    let routedChange: ChangeSet | undefined
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedChange = change
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: targeted tests and boundary probe → ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routedChange?.files.join(','), 'src/a.ts')
    assert.equal(routedChange?.crossModule, false)
    assert.equal(routedChange?.isFix, false)
    assert.equal(routedChange?.goalActive, false)
    assert.match(result.content, /提交后审查已转后台/)
    assert.match(result.content, /Scoped commit created/)
    await settleDetachedReview()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)
    assert.match(outcomes[0]!.lines.join('\n'), /审查通过 \(L2\)/)
  })

  it('post-commit review cooldown reports an honest skip, not a false merge', async () => {
    let routeCalls = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => {
        routeCalls++
        return { tier: 'auto', verdict: 'verified', evidence: 'no blocking findings', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    // First commit runs the review and arms the 30s cooldown.
    await tool.execute({ ...params, input: { commit: true, message: 'feat: part 1' } })
    // Second commit within the window hits the cooldown branch.
    const second = await tool.execute({ ...params, input: { commit: true, message: 'feat: part 2' } })

    assert.equal(routeCalls, 1, 'second review must be skipped by cooldown')
    assert.match(second.content, /提交后审查跳过：距上轮审查/)
    assert.doesNotMatch(second.content, /合并入上一轮/, 'must not claim a merge that never happens')
  })

  it('in-flight review singleton: a commit landing while a review runs merges into pending, one follow-up covers it', async () => {
    const routedFiles: string[][] = []
    let releaseFirstReview!: () => void
    const firstReviewGate = new Promise<void>(resolve => { releaseFirstReview = resolve })
    let callIdx = 0
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      dirtyFiles: ['src/a.ts', 'src/b.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedFiles.push([...change.files])
        callIdx++
        if (callIdx === 1) await firstReviewGate // hold review #1 in flight
        return { tier: 'auto', verdict: 'verified', evidence: 'ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    await tool.execute({ ...params, input: { commit: true, message: 'feat: part 1', files: ['src/a.ts'] } })
    assert.equal(routedFiles.length, 1, 'first commit launches the review')
    // Review #1 is still in flight. Expire ONLY the time cooldown so the
    // second commit reaches the in-flight branch (the git-lock retry scenario:
    // retry lands >30s later, well inside the 180s review budget).
    __expirePostCommitReviewCooldown()
    const second = await tool.execute({ ...params, input: { commit: true, message: 'feat: part 2', files: ['src/b.ts'] } })

    assert.match(second.content, /已有在飞审查/)
    assert.equal(routedFiles.length, 1, 'no overlapping review worker while one is in flight')

    releaseFirstReview()
    await settleReviewChain()

    assert.equal(routedFiles.length, 2, 'exactly one follow-up review for the merged scope')
    assert.deepEqual(routedFiles[1], ['src/b.ts'], 'follow-up covers the merged commit, not a re-review of everything')
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 2)
    assert.match(outcomes[1]!.lines[0]!, /HEAD（合并补审）/)
  })

  it('cooldown-skipped commits are recorded and folded into the next launched review', async () => {
    const routedFiles: string[][] = []
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      dirtyFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedFiles.push([...change.files])
        return { tier: 'auto', verdict: 'verified', evidence: 'ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    await tool.execute({ ...params, input: { commit: true, message: 'feat: part 1', files: ['src/a.ts'] } })
    await settleReviewChain()
    assert.equal(routedFiles.length, 1)
    // Second commit inside the 30s cooldown: skipped, but its scope is recorded.
    const second = await tool.execute({ ...params, input: { commit: true, message: 'feat: part 2', files: ['src/b.ts'] } })
    assert.match(second.content, /提交后审查跳过：距上轮审查/)
    assert.match(second.content, /已记入待审范围/)
    assert.equal(routedFiles.length, 1, 'cooldown skip must not launch a worker')
    // Third commit after the cooldown expires: the launched review folds the
    // recorded scope in — commit #2 no longer silently unreviewed.
    __expirePostCommitReviewCooldown()
    const third = await tool.execute({ ...params, input: { commit: true, message: 'feat: part 3', files: ['src/c.ts'] } })
    assert.match(third.content, /一并覆盖此前累积的 1 个未审 commit（共 2 个文件）/)
    assert.equal(routedFiles.length, 2)
    assert.deepEqual(routedFiles[1]!.slice().sort(), ['src/b.ts', 'src/c.ts'])
    await settleReviewChain()
    assert.equal(consumePostCommitReviewOutcomes().length, 2)
  })

  it('review_policy=defer accumulates commits; review_policy=final runs one review over the union', async () => {
    const routedFiles: string[][] = []
    const { tool, params } = makeContext({
      taskId: 't1',
      sessionId: 'sess-defer',
      ownedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      dirtyFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routedFiles.push([...change.files])
        return { tier: 'auto', verdict: 'verified', evidence: 'ok', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const d1 = await tool.execute({ ...params, input: { commit: true, message: 'feat: step 1', files: ['src/a.ts'], review_policy: 'defer' } })
    assert.match(d1.content, /已延迟（review_policy=defer）：会话已累积 1 个 commit、1 个文件/)
    const d2 = await tool.execute({ ...params, input: { commit: true, message: 'feat: step 2', files: ['src/b.ts'], review_policy: 'defer' } })
    assert.match(d2.content, /会话已累积 2 个 commit、2 个文件/)
    assert.equal(routedFiles.length, 0, 'defer must never spawn a review worker')

    const fin = await tool.execute({ ...params, input: { commit: true, message: 'feat: step 3', files: ['src/c.ts'], review_policy: 'final' } })
    assert.match(fin.content, /终审（review_policy=final）：覆盖 2 个延迟 commit \+ 本次提交，共 3 个文件/)
    assert.equal(routedFiles.length, 1, 'final runs exactly one review')
    assert.deepEqual(routedFiles[0]!.slice().sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'final review covers the deferred union + this commit')

    await settleReviewChain()
    const outcomes = consumePostCommitReviewOutcomes()
    assert.equal(outcomes.length, 1)

    // pending consumed: a later plain commit sees no leftover accumulation.
    __expirePostCommitReviewCooldown()
    const after = await tool.execute({ ...params, input: { commit: true, message: 'feat: step 4', files: ['src/a.ts'] } })
    assert.doesNotMatch(after.content, /一并覆盖此前累积/)
    assert.equal(routedFiles.length, 2)
    assert.deepEqual(routedFiles[1], ['src/a.ts'])
  })

  it('defer records explicit review_level escalation; final review inherits forceLevel L3', async () => {
    let captured: ChangeSet | undefined
    let routeCalls = 0
    // First commit (defer) defers. Second commit (final) passes explicit
    // review_level='L3' — forceLevel must be L3 on the routed change.
    const { tool, params } = makeContext({
      taskId: 't1',
      sessionId: 'sess-defer-explicit',
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      dirtyFiles: ['src/a.ts', 'src/b.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async change => {
        routeCalls++
        captured = change
        return { tier: 'L3', verdict: 'verified', evidence: 'shim', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const d1 = await tool.execute({ ...params, input: { commit: true, message: 'feat: step 1', files: ['src/a.ts'], review_policy: 'defer' } })
    assert.match(d1.content, /已延迟（review_policy=defer）/)
    assert.equal(routeCalls, 0, 'defer must not route')

    // Final commit with explicit review_level='L3' — now detached, but
    // forceLevel must still be L3 on the routed change.
    await tool.execute({ ...params, input: { commit: true, message: 'feat: step 2', files: ['src/b.ts'], review_policy: 'final', review_level: 'L3' } })
    await settleDetachedReview()
    assert.ok(captured, 'final must route the accumulated scope')
    assert.equal(captured!.forceLevel, 'L3', 'explicit review_level L3 must set forceLevel')
    assert.deepEqual(captured!.files.slice().sort(), ['src/a.ts', 'src/b.ts'])
  })

  it('commit succeeds when review deps are not wired — advisory skip, not block', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
      disableReviewDeps: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: scoped delivery' } })

    // Post-commit: unwired review is advisory, not a blocker.
    assert.equal(result.isError ?? false, false)
    assert.equal(committed, true)
    assert.match(result.content, /提交后审查跳过.*审查依赖不可用/)
    assert.match(result.content, /Scoped commit created/)
  })

  it('unwired review with force=true — commit succeeds, advisory skip', async () => {
    let committed = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        committed = true
        return { ok: true, output: 'commit abc123' }
      },
      disableReviewDeps: true,
    })

    const result = await tool.execute({ ...params, input: { commit: true, force: true, message: 'feat: scoped delivery' } })

    // Post-commit: force no longer needed for unwired review, but commit still succeeds.
    assert.equal(result.isError ?? false, false)
    assert.equal(committed, true)
    assert.match(result.content, /提交后审查跳过.*审查依赖不可用/)
    assert.match(result.content, /Scoped commit created/)
  })

  it('skips ReviewRouter when reviewDepth indicates child review context', async () => {
    let routerCalled = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      reviewDepth: 1,
      routeReviewWorkflow: async () => {
        routerCalled = true
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: should not happen', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routerCalled, false)
    assert.match(result.content, /Scoped commit created/)
  })

  it('skips ReviewRouter when ToolCallParams reviewDepth indicates child worker context', async () => {
    let routerCalled = false
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      routeReviewWorkflow: async () => {
        routerCalled = true
        return { tier: 'L2', verdict: 'verified', evidence: 'ran: should not happen', rounds: 1 }
      },
      reviewDeps: {} as ReviewRouterDeps,
      commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
    })

    const result = await tool.execute({ ...params, reviewDepth: 1, input: { commit: true, message: 'fix: scoped delivery' } })

    assert.equal(result.isError ?? false, false)
    assert.equal(routerCalled, false)
    assert.match(result.content, /Scoped commit created/)
  })

  it('rejects commit=true without message before running executor', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => {
        throw new Error('commit executor should not run without message')
      },
    })

    const result = await tool.execute({ ...params, input: { commit: true } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Commit requires/)
  })

  it('reports scoped commit executor failure as tool error', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      dirtyFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => ({ ok: false, output: 'git commit failed' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: fail' } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Scoped commit failed/)
    assert.match(result.content, /git commit failed/)
  })

  it('reports commit=true with no owned files as scoped commit failure', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      commitOwnedFiles: () => ({ ok: false, output: 'No owned files to commit.' }),
    })

    const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: empty' } })

    assert.equal(result.isError, true)
    assert.match(result.content, /Delivery Gate: GREEN/)
    assert.match(result.content, /No owned files to commit/)
  })

  it('does not require approval for status-only delivery report', () => {
    const { tool } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
    })

    const needsApproval = tool.requiresApproval({
      input: {},
      toolUseId: 'test-1',
      cwd: '/fake',
    })
    assert.equal(needsApproval, false)
  })

  it('reports external dirty files as informational caveats, not ownership warnings', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: [],
      externalFiles: ['.rivet/prefix-diag.jsonl'],
    })

    const result = await tool.execute(params)

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Delivery Gate: GREEN/)
    assert.match(result.content, /Owned files \(0\)/)
    assert.match(result.content, /External files \(1\)/)
    assert.doesNotMatch(result.content, /Ownership health warnings:/)
    assert.match(result.content, /Ownership caveats:/)
    assert.match(result.content, /External dirty files are present and excluded from delivery scope\./)
  })

  it('auto-populates ownership from task ledger at execution time', async () => {
    const ctx = makeContext({
      taskId: 't1',
      ownedFiles: [],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    ctx.ledger.record({ type: 'file_write', path: 'src/late-write.ts' })
    const result = await ctx.tool.execute(ctx.params)

    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Owned files \(1\)/)
    assert.match(result.content, /src\/late-write\.ts/)
  })

  it('treats clean historical owned files as non-blocking when current dirty snapshot is empty', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/already-committed.ts'],
      dirtyFiles: [],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Delivery Gate: GREEN/)
    assert.match(result.content, /Owned files \(0\)/)
    assert.match(result.content, /Historical owned files \(1\)/)
    assert.match(result.content, /src\/already-committed\.ts/)
  })

  it('still blocks current dirty owned files when unverified', async () => {
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/current-dirty.ts'],
      dirtyFiles: ['src/current-dirty.ts'],
    })

    const result = await tool.execute(params)
    assert.equal(result.isError ?? false, false)
    assert.match(result.content, /Delivery Gate: RED/)
    assert.match(result.content, /Owned files \(1\)/)
  })

  it('generates consistent report for same state', async () => {
    const ctx1 = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })
    const ctx2 = makeContext({
      taskId: 't1',
      ownedFiles: ['src/a.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
    })

    const r1 = await ctx1.tool.execute(ctx1.params)
    const r2 = await ctx2.tool.execute(ctx2.params)

    assert.equal(r1.content, r2.content)
  })

  it('includes review principle checklist for owned files matching project memory evidence', async () => {
    const projectMemory = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: Boundary clarity comes before speed.

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/loop.ts\`
`
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/agent/loop.ts'],
      dirtyFiles: ['src/agent/loop.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      projectMemory,
    })

    const result = await tool.execute(params)

    assert.match(result.content, /审查原则清单：/)
    assert.match(result.content, /Do not declare a streamed response duplicate/)
    assert.match(result.content, /Delivery Gate: GREEN/)
  })

  it('does not include checklist when no evidence paths match owned files', async () => {
    const projectMemory = `### 2026-05-27 — Real-Time Systems Need Boundary Clarity Before Speed

**Kind**: architectural_invariant / review_principle

**Claim**: Boundary clarity comes before speed.

**Review rule**:
Do not declare a streamed response duplicate in the middle of the stream.

**Evidence**:
- \`src/agent/loop.ts\`
`
    const { tool, params } = makeContext({
      taskId: 't1',
      ownedFiles: ['src/config/schema.ts'],
      verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      projectMemory,
    })

    const result = await tool.execute(params)

    assert.doesNotMatch(result.content, /审查原则清单：/)
    assert.match(result.content, /Delivery Gate: GREEN/)
  })

  describe('preExistingUntracked scenarios', () => {
    it('treats preExistingUntracked files as external in ownership report', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: ['src/untracked.ts', 'temp.txt'],
        dirtyFiles: ['src/owned.ts', 'src/untracked.ts', 'temp.txt'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/untracked\.ts/)
      assert.match(result.content, /temp\.txt/)
    })

    it('prevents registerOwned from claiming preExistingUntracked files', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        preExistingUntracked: ['src/pre-existing.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      // Try to register the pre-existing untracked file
      ctx.ownership.registerOwned('src/pre-existing.ts')

      // Should not be owned
      assert.equal(ctx.ownership.isOwned('src/pre-existing.ts'), false)

      // Now execute and verify it appears as external
      const result = await ctx.tool.execute(ctx.params)
      assert.match(result.content, /External files \(1\)/)
      assert.match(result.content, /src\/pre-existing\.ts/)
    })

    it('shows ownership health warning when dirty file has no classification', async () => {
      // Note: dirtyFiles passed to makeContext are used by getCurrentDirtyFiles mock.
      // In real usage, deliver-task computes dirtyFiles from owned + external only.
      // Files that are neither owned nor external are not included in the health check.
      // This test verifies the current behavior: unknown files are silently excluded.
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: [],
        dirtyFiles: ['src/owned.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      // No warnings because all dirty files are classified
      assert.doesNotMatch(result.content, /Ownership health warnings:/)
    })

    it('allows commit=true for owned files even when preExistingUntracked are present', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        preExistingUntracked: ['src/untracked.ts'],
        dirtyFiles: ['src/owned.ts', 'src/untracked.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only owned file should be committed, not the untracked one
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('handles mixed preExistingDirty and preExistingUntracked correctly', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/dirty-ext.ts'],
        preExistingUntracked: ['src/untracked-ext.ts'],
        dirtyFiles: ['src/owned.ts', 'src/dirty-ext.ts', 'src/untracked-ext.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute(params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/dirty-ext\.ts/)
      assert.match(result.content, /src\/untracked-ext\.ts/)
    })
  })

  describe('co-ownership scenarios', () => {
    it('shows co-owned files in report when external file is registered', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      // Register external file as co-owned
      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(1\)/)
      assert.match(result.content, /src\/owned\.ts/)
      assert.match(result.content, /Co-owned files \(1\)/)
      assert.match(result.content, /src\/shared\.ts/)
      assert.match(result.content, /External files \(1\)/)
    })

    it('shows co-owned caveat in ownership health', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Ownership caveats:/)
      assert.match(result.content, /co-owned file\(s\) present/)
    })

    it('allows commit=true for owned files when co-owned files exist', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only truly owned file should be committed, not co-owned
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('distinguishes co-owned from external in ownership report', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/shared.ts', 'src/external.ts'],
        dirtyFiles: ['src/owned.ts', 'src/shared.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      ctx.ownership.registerOwned('src/shared.ts')

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Co-owned files \(1\)/)
      assert.match(result.content, /src\/shared\.ts/)
      assert.match(result.content, /External files \(2\)/)
      assert.match(result.content, /src\/external\.ts/)
    })
  })

  describe('verification diagnostics', () => {
    it('reports invocation failure as YELLOW (non-blocking)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{
          command: 'run_tests src/a.test.ts',
          status: 'failed',
          meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0, recommendedCommand: 'tsx --test src/a.test.ts' },
        }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: YELLOW/)
      assert.match(result.content, /Attribution: Verification invocation failure/)
      assert.doesNotMatch(result.content, /Owned verification failed\. Fix failures before delivery\./)
    })

    it('reports stale superseded failures without blocking wording', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [
          {
            command: 'run_tests src/a.test.ts',
            status: 'failed',
            meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
          },
          {
            command: 'tsx --test src/a.test.ts',
            status: 'passed',
            meta: { scope: 'targeted', exitCode: 0, passed: 1, failed: 0, skipped: 0 },
          },
        ],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /预存量失败：1 条/)
      assert.doesNotMatch(result.content, /Cannot commit/)
    })

    it('does not amplify stale failures when no current owned dirty files', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/already-clean.ts'],
        dirtyFiles: [],
        verifications: [{
          command: 'run_tests src/a.test.ts',
          status: 'failed',
          meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
        }],
      })

      const result = await tool.execute(params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.match(result.content, /Owned files \(0\)/)
      // b34ba6b2 语义化归因后：无 owned 改动时归因为"无文件修改"，
      // 关键语义是失败未被放大成阻断（GREEN + 无 Blocking）。
      assert.match(result.content, /Attribution: No file modifications/)
      assert.doesNotMatch(result.content, /⚠️  Blocking:/)
    })
  })

  // ── 层3: 重构行为等价契约 — 回归清单核验（重构事故链缺口 3）──
  describe('regression inventory verification', () => {
    function contractWith(objective: string, inventory?: string[]): import('../../context/task-contract.js').TaskContract {
      return {
        id: 'c1', objective, scope: { mentionedFiles: [] }, constraints: [], successCriteria: [],
        status: 'executing', createdAtTurn: 0, updatedAtTurn: 0, isActionable: true,
        ...(inventory ? { regressionInventory: inventory } : {}),
      }
    }

    it('verifies contract inventory items and flags missing anchors in the report', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        taskContract: contractWith('重构导航系统', ['导航项 `settingsSurface` 仍注册', '路由 `/api/plans` 仍存在']),
        inventorySearcher: (_cwd, needle) => needle === 'settingsSurface' ? 'present' : 'missing',
      })

      const result = await tool.execute(params)

      assert.match(result.content, /回归清单核验 \(1\/2 仍存在\)/)
      assert.match(result.content, /✅ 导航项/)
      assert.match(result.content, /❌ 路由/)
      assert.match(result.content, /重构丢功能/)
    })

    it('warns YELLOW-style when a refactor delivery has no inventory at all', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        taskContract: contractWith('重构 TUI 面板布局'),
        // findApprovedPlanInventory 在 /fake/project 找不到计划 → 走缺清单分支
      })

      const result = await tool.execute(params)

      assert.match(result.content, /重构类交付缺少回归清单/)
      assert.match(result.content, /行为等价未核验/)
    })

    it('stays silent for non-refactor deliveries without inventory', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        taskContract: contractWith('修复登录按钮的 typo'),
      })

      const result = await tool.execute(params)

      assert.doesNotMatch(result.content, /回归清单/)
    })
  })

  // ── Norns 义务账：议事会契约随附义务的交付前核验（Phase 3）──
  describe('council obligation ledger verification', () => {
    function storedPlanWith(obligations: import('../council/council-obligations.js').ObligationEntry[]): string {
      return JSON.stringify({
        version: 1, objective: 'council plan', source: 'manual', createdAt: 1,
        tasks: [{ id: 'T1', title: 't', objective: 'o', profile: 'implementer', kind: 'patch_proposal', files: [], dependsOn: [], riskTier: 'low' }],
        obligations,
      })
    }

    it('会话存有带义务账的契约 → 交付报告核验：gate 执行 + manual 项披露要求', async () => {
      const sessionId = `deliver-obligations-${Date.now()}`
      const { storePlan, clearPlan } = await import('../plan-store.js')
      storePlan(storedPlanWith([
        { id: 'advisory_gate:0', kind: 'advisory_gate', text: '类型必须过', source: 'tianquan', gate: 'npx tsc --noEmit' },
        { id: 'deferred_decision:1', kind: 'deferred_decision', text: '暂缓项「备选B」待裁', source: 'tianfu' },
      ]), sessionId)
      try {
        const ran: string[] = []
        const { tool, params } = makeContext({
          taskId: 't1',
          ownedFiles: ['src/a.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          obligationGateRunner: cmd => { ran.push(cmd); return { ok: true } },
        })
        const result = await tool.execute({ ...params, sessionId })
        assert.deepEqual(ran, ['npx tsc --noEmit'], '白名单 gate 应真实执行')
        assert.match(result.content, /议事会义务账核验/)
        assert.match(result.content, /✅ \[tianquan\] 类型必须过/)
        assert.match(result.content, /📒 \[tianfu\] 暂缓项/)
        assert.match(result.content, /逐项披露/)
      } finally {
        clearPlan(sessionId)
      }
    })

    it('gate 未过 → 强警告（advisory 不阻断交付）', async () => {
      const sessionId = `deliver-obligations-fail-${Date.now()}`
      const { storePlan, clearPlan } = await import('../plan-store.js')
      storePlan(storedPlanWith([
        { id: 'advisory_gate:0', kind: 'advisory_gate', text: '测试必须过', source: 'huagai', gate: 'npm test' },
      ]), sessionId)
      try {
        const { tool, params } = makeContext({
          taskId: 't1',
          ownedFiles: ['src/a.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          obligationGateRunner: () => ({ ok: false, detail: '2 failed' }),
        })
        const result = await tool.execute({ ...params, sessionId })
        assert.match(result.content, /❌ \[huagai\] 测试必须过/)
        assert.match(result.content, /验收 gate 未通过/)
        assert.equal(result.isError, undefined, '义务账是 advisory，绝不让交付失败')
      } finally {
        clearPlan(sessionId)
      }
    })

    it('无存储契约或零义务 → 零输出', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      const result = await tool.execute({ ...params, sessionId: `deliver-obligations-none-${Date.now()}` })
      assert.doesNotMatch(result.content, /义务账/)
    })
  })

  // ── 验证命令对账：计划声明的 verification 命令逐条核销（advisory）──
  describe('plan verification command reconciliation', () => {
    function storedPlanWithVerification(verification: string[][]): string {
      return JSON.stringify({
        version: 1, objective: 'plan', source: 'manual', createdAt: 1,
        tasks: verification.map((v, i) => ({
          id: `T${i}`, title: 't', objective: 'o', profile: 'implementer',
          kind: 'patch_proposal', files: [], dependsOn: [], riskTier: 'low',
          verification: v,
        })),
      })
    }

    it('声明命令部分未跑/挂死 → 报告逐条披露四态（advisory 不阻断）', async () => {
      const sessionId = `deliver-reconcile-${Date.now()}`
      const { storePlan, clearPlan } = await import('../plan-store.js')
      storePlan(storedPlanWithVerification([
        ['npx tsc --noEmit', 'npx tsx --test src/__tests__/a.test.ts'],
        ['npx tsx --test src/__tests__/b.test.ts'],
      ]), sessionId)
      try {
        const { tool, params } = makeContext({
          taskId: 't1',
          ownedFiles: ['src/a.ts'],
          verifications: [
            { command: 'npx tsc --noEmit', status: 'passed', meta: { passed: 0, failed: 0 } },
            { command: 'npx tsx --test src/__tests__/a.test.ts', status: 'blocked', meta: { blockedReason: 'timeout' } },
          ],
        })
        const result = await tool.execute({ ...params, sessionId })
        assert.match(result.content, /验证命令对账（计划声明 3 条，2 条未核销）/)
        assert.match(result.content, /⏱ npx tsx --test src\/__tests__\/a\.test\.ts — blocked（timeout）——跑了但没跑完/)
        assert.match(result.content, /∅ npx tsx --test src\/__tests__\/b\.test\.ts — 无运行记录/)
        assert.match(result.content, /与虚报同罪/)
        assert.equal(result.isError, undefined, '对账是 advisory，绝不让交付失败')
      } finally {
        clearPlan(sessionId)
      }
    })

    it('全部有通过记录 → 单行带过', async () => {
      const sessionId = `deliver-reconcile-green-${Date.now()}`
      const { storePlan, clearPlan } = await import('../plan-store.js')
      storePlan(storedPlanWithVerification([['npx tsc --noEmit']]), sessionId)
      try {
        const { tool, params } = makeContext({
          taskId: 't1',
          ownedFiles: ['src/a.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        })
        const result = await tool.execute({ ...params, sessionId })
        assert.match(result.content, /✓ 验证命令对账：计划声明 1 条，全部有通过记录/)
      } finally {
        clearPlan(sessionId)
      }
    })

    it('计划无声明验证命令 → 零输出', async () => {
      const sessionId = `deliver-reconcile-none-${Date.now()}`
      const { storePlan, clearPlan } = await import('../plan-store.js')
      storePlan(storedPlanWithVerification([[]]), sessionId)
      try {
        const { tool, params } = makeContext({
          taskId: 't1',
          ownedFiles: ['src/a.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        })
        const result = await tool.execute({ ...params, sessionId })
        assert.doesNotMatch(result.content, /验证命令对账/)
      } finally {
        clearPlan(sessionId)
      }
    })
  })

  describe('unclassified dirty files → dynamic external reclassification', () => {
    it('reports GREEN when dirty unclassified files are lazily reclassified as dynamic externals', async () => {
      // P1 living baseline: files with no ledger trace that are NOT in the baseline
      // external set are now lazily reclassified as "dynamic externals" —
      // created by other sessions after our baseline was taken.
      // This eliminates false YELLOWs from stale baseline information.
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts', 'src/new-session-file.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute(ctx.params)

      // src/new-session-file.ts is dynamically reclassified as external → GREEN
      assert.match(result.content, /Delivery Gate: GREEN/)
      // It appears in the external files section, not as an "unclassified" warning
      assert.match(result.content, /External files \(1\)/)
      assert.match(result.content, /src\/new-session-file\.ts/)
      // No ownership health warning for unclassified files
      assert.doesNotMatch(result.content, /no ownership classification/)
    })

    it('allows commit=true when dirty unclassified files are reclassified as external (only owned committed)', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts', 'src/new-session-file.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: test' } })

      assert.equal(result.isError ?? false, false)
      // Only src/owned.ts has a ledger trace → only it is owned and committed
      assert.deepEqual(calls, [{ files: ['src/owned.ts'], message: 'feat: test' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('does not report YELLOW when all dirty files are classified', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/owned.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute(ctx.params)

      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Ownership health warnings:/)
    })
  })

  describe('detectSymptomPatch', () => {
    function tmpRepo(file: string, before: string, after: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'sym-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      writeFileSync(join(dir, file), before)
      run(['add', '.']); run(['commit', '-qm', 'base'])
      writeFileSync(join(dir, file), after)
      return dir
    }

    it('flags a single-line fallback patch', () => {
      const dir = tmpRepo('a.ts', 'const x = v ?? "medium"\n', 'const x = v || "medium"\n')
      assert.match(detectSymptomPatch(dir)!, /症状处的 fallback 补丁/)
    })

    it('ignores a multi-line structural change', () => {
      const dir = tmpRepo('a.ts', 'const x = 1\n', 'const a = 1\nconst b = 2\nconst c = 3\n')
      assert.equal(detectSymptomPatch(dir), null)
    })
  })

  // ── P2 cross-session claim conflicts ──

  describe('cross-session claim conflict detection', () => {
    it('reports conflict when other session holds exclusive claim on owned file', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-'))
      const otherRegistry = await SR.create(tmpDir)
      otherRegistry.register('other-session', '/fake/project')
      otherRegistry.acquireClaim('other-session', 'src/owned.ts', 'exclusive')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: otherRegistry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.match(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /src\/owned\.ts.*exclusive lock held by session other-session/)
      } finally {
        otherRegistry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('blocks commit when other session holds a claim on an owned file', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-commit-block-'))
      const registry = await SR.create(tmpDir)
      registry.register('other-session', '/fake/project')
      registry.acquireClaim('other-session', 'src/owned.ts', 'exclusive')
      let committed = false

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
          commitOwnedFiles: () => {
            committed = true
            return { ok: true, output: 'commit should-not-happen' }
          },
        })

        const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, message: 'feat: claim conflict' } })

        assert.equal(result.isError, true)
        assert.equal(committed, false)
        assert.match(result.content, /Cannot commit: cross-session claim conflicts are present/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('allows force=true to override a cross-session claim conflict explicitly', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-commit-force-'))
      const registry = await SR.create(tmpDir)
      registry.register('other-session', '/fake/project')
      registry.acquireClaim('other-session', 'src/owned.ts', 'shared_read')
      let committed = false

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
          commitOwnedFiles: () => {
            committed = true
            return { ok: true, output: 'commit abc123' }
          },
        })

        const result = await ctx.tool.execute({ ...ctx.params, input: { commit: true, force: true, message: 'feat: claim conflict override' } })

        assert.equal(result.isError ?? false, false)
        assert.equal(committed, true)
        assert.match(result.content, /Cross-session claim conflicts overridden with force=true/)
        assert.match(result.content, /Scoped commit created/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('does NOT report conflict when own session holds the claim', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-self-'))
      const registry = await SR.create(tmpDir)
      registry.register('my-session', '/fake/project')
      // My own session holds the claim — no conflict
      registry.acquireClaim('my-session', 'src/owned.ts', 'exclusive')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /Delivery Gate: GREEN/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('does NOT report conflict when no session holds claims', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-none-'))
      const registry = await SR.create(tmpDir)

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: registry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /Delivery Gate: GREEN/)
      } finally {
        registry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('reports conflict for shared_read claim from other session too', async () => {
      const { SessionRegistry: SR } = await import('../session-registry.js')
      const tmpDir = mkdtempSync(join(tmpdir(), 'p2-claims-read-'))
      const otherRegistry = await SR.create(tmpDir)
      otherRegistry.register('other-session', '/fake/project')
      otherRegistry.acquireClaim('other-session', 'src/owned.ts', 'shared_read')

      try {
        const ctx = makeContext({
          taskId: 't1',
          ownedFiles: ['src/owned.ts'],
          dirtyFiles: ['src/owned.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionRegistry: otherRegistry,
          sessionId: 'my-session',
        })

        const result = await ctx.tool.execute(ctx.params)

        assert.match(result.content, /Cross-session claim conflicts:/)
        assert.match(result.content, /shared read held by session other-session/)
      } finally {
        otherRegistry.close()
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })

    it('no crash when sessionRegistry is absent (backward compatible)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/owned.ts'],
        dirtyFiles: ['src/owned.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        // sessionRegistry not provided
      })

      const result = await ctx.tool.execute(ctx.params)

      assert.doesNotMatch(result.content, /Cross-session claim conflicts:/)
      assert.match(result.content, /Delivery Gate: GREEN/)
    })
  })

  describe('files parameter — subset commit', () => {
    it('commits only specified subset of owned files when files param provided', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1 only', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1 only' }])
      assert.match(result.content, /Scoped commit created/)
    })

    it('rejects files param containing non-owned file', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: ['src/agent/a.ts', 'src/tools/NOT-OWNED.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in owned files/)
    })

    it('rejects empty files array', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: test', files: [] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /No files specified/)
    })

    it('ignores files param when commit is false (status-only)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts'],
        dirtyFiles: ['src/agent/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await tool.execute({
        ...params,
        input: { files: ['src/agent/a.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Scoped commit/)
    })
  })

  describe('cohesion RED gate on commit', () => {
    it('BLOCKS commit when files span 3+ areas without force', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('commit executor should NOT be called when cohesion gate blocks')
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: big batch' },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Suggested split by area/)
    })

    it('allows commit with force=true when cohesion gate triggers', async () => {
      const files = [
        'src/agent/a.ts', 'src/agent/b.ts',
        'src/tools/c.ts',
        'src/tui/d.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: files,
        dirtyFiles: files,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: truly one unit', force: true },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Cohesion gate overridden/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files, message: 'feat: truly one unit' }])
    })

    it('does not block small focused commit (≤2 areas, ≤5 files)', async () => {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        dirtyFiles: ['src/agent/a.ts', 'src/agent/b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })

      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: focused' },
      })

      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /Commit cohesion gate/)
      assert.match(result.content, /Scoped commit created/)
    })

    it('applies cohesion gate to files subset too', async () => {
      const allFiles = ['src/agent/a.ts', 'src/agent/b.ts', 'src/tools/c.ts', 'src/tui/d.ts', 'src/config/e.ts']
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('should not be called')
        },
      })

      // Request a subset that still spans 3 areas
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: subset', files: ['src/agent/a.ts', 'src/tools/c.ts', 'src/tui/d.ts'] },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /Commit cohesion gate/)
    })

    it('allows small subset commit even when total owned files are large', async () => {
      const allFiles = [
        'src/agent/a.ts', 'src/agent/b.ts', 'src/agent/c.ts',
        'src/tools/d.ts', 'src/tui/e.ts', 'src/config/f.ts',
      ]
      const calls: Array<{ files: string[]; message: string }> = []
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: allFiles,
        dirtyFiles: allFiles,
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, f, msg) => {
          calls.push({ files: f, message: msg })
          return { ok: true, output: 'commit abc123' }
        },
      })

      // Request a focused subset (1 area, 2 files) — should pass
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'feat: P1', files: ['src/agent/a.ts', 'src/agent/b.ts'] },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/agent/a.ts', 'src/agent/b.ts'], message: 'feat: P1' }])
    })
  })

  describe('adopt — cross-session takeover', () => {
    it('adopts external files and commits them alongside owned files', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        dirtyFiles: ['src/mine.ts', 'src/other-session-a.ts', 'src/other-session-b.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit abc123' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: take over crashed session work',
          adopt: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Adopted 2 external file/)
      assert.match(result.content, /src\/other-session-a\.ts/)
      assert.match(result.content, /src\/other-session-b\.ts/)
      assert.match(result.content, /Scoped commit created/)
      // All 3 files should be committed (1 owned + 2 adopted)
      assert.deepEqual(calls, [{
        files: ['src/mine.ts', 'src/other-session-a.ts', 'src/other-session-b.ts'],
        message: 'fix: take over crashed session work',
      }])
    })

    it('adopts external files even when no owned files exist', async () => {
      const calls: Array<{ files: string[]; message: string }> = []
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        externalFiles: ['src/crashed-work.ts'],
        dirtyFiles: ['src/crashed-work.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: (_cwd, files, message) => {
          calls.push({ files, message })
          return { ok: true, output: 'commit def456' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: adopt orphaned work',
          adopt: ['src/crashed-work.ts'],
        },
      })

      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /Adopted 1 external file/)
      assert.match(result.content, /Scoped commit created/)
      assert.deepEqual(calls, [{ files: ['src/crashed-work.ts'], message: 'fix: adopt orphaned work' }])
    })

    it('blocks adopted files when the refreshed delivery gate is RED', async () => {
      let committed = false
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: [],
        externalFiles: ['src/crashed-work.ts'],
        dirtyFiles: ['src/crashed-work.ts'],
        commitOwnedFiles: () => {
          committed = true
          return { ok: true, output: 'commit should-not-happen' }
        },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: adopt unverified orphaned work',
          adopt: ['src/crashed-work.ts'],
        },
      })

      assert.equal(result.isError, true)
      assert.equal(committed, false)
      assert.match(result.content, /delivery gate is RED after adoption/)
      assert.match(result.content, /Run verification before delivery/)
    })

    it('rejects adopt for file not in external list', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/mine.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => { throw new Error('should not be called') },
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: try adopt non-external',
          adopt: ['src/nonexistent.ts'],
        },
      })

      assert.equal(result.isError, true)
      assert.match(result.content, /not in external or co-owned files/)
    })

    it('accepts empty adopt array as no-op (not an error)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        dirtyFiles: ['src/mine.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc1234' }),
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: {
          commit: true,
          message: 'fix: empty adopt is no-op',
          adopt: [],
        },
      })

      // Empty adopt array should be treated the same as omitting adopt — not an error
      assert.equal(result.isError, undefined)
    })

    it('ignores adopt when commit is false (status-only)', async () => {
      const ctx = makeContext({
        taskId: 't1',
        ownedFiles: ['src/mine.ts'],
        externalFiles: ['src/external.ts'],
        dirtyFiles: ['src/mine.ts', 'src/external.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })

      const result = await ctx.tool.execute({
        ...ctx.params,
        input: { adopt: ['src/external.ts'] },
      })

      // adopt is ignored in status-only mode — no adoption log
      assert.match(result.content, /Delivery Gate: GREEN/)
      assert.doesNotMatch(result.content, /Adopted/)
    })
  })

  // ── Mechanical-change fast-path (docs/rename bypass) ──

  describe('mechanical-change fast-path', () => {
    function tmpGitRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'mech-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      writeFileSync(join(dir, 'README.md'), '# Base\n')
      run(['add', '.']); run(['commit', '-qm', 'base'])
      return dir
    }

    function tmpGitRepoWithTracked(file: string, content: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'mech-'))
      const run = (args: string[]) => spawnSync('git', args, { cwd: dir })
      run(['init', '-q'])
      run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, file), content)
      run(['add', '.']); run(['commit', '-qm', 'base'])
      return dir
    }

    it('docs-only untracked file bypasses RED gate and commits successfully', async () => {
      const dir = tmpGitRepo()
      // Create a new untracked docs file
      writeFileSync(join(dir, 'CHANGELOG.md'), '# v2\n')

      const { tool, params } = makeContext({
        taskId: 't-docs',
        ownedFiles: ['CHANGELOG.md'],
        dirtyFiles: ['CHANGELOG.md'],
        verifications: [],  // no verification → unverified RED
        commitOwnedFiles: (_cwd, files, msg) => {
          const add = spawnSync('git', ['add', ...files], { cwd: dir })
          const commit = spawnSync('git', ['commit', '-qm', msg], { cwd: dir })
          return { ok: add.status === 0 && commit.status === 0, output: '' }
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'docs: update changelog' } })
      assert.equal(result.isError, undefined, `Expected successful commit, got error:\n${result.content}`)
      assert.match(result.content, /机械式变更.*docs-only/)
    })

    it('normal code change with unverified RED is NOT bypassed', async () => {
      const dir = tmpGitRepoWithTracked('src/a.ts', 'const x = 1\n')
      // Modify the tracked code file
      writeFileSync(join(dir, 'src/a.ts'), 'const x = 2\nconst y = 3\n')

      const { tool, params } = makeContext({
        taskId: 't-code',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [],
        commitOwnedFiles: () => ({ ok: true, output: '' }),
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'feat: change x' } })
      assert.equal(result.isError, true)
      assert.match(result.content, /Cannot commit/)
    })

    it('pure file rename (R100) bypasses RED gate — only the new path is owned', async () => {
      const dir = tmpGitRepoWithTracked('src/old.ts', 'export const x = 1\n')
      spawnSync('git', ['mv', 'src/old.ts', 'src/new.ts'], { cwd: dir }) // byte-identical rename

      const { tool, params } = makeContext({
        taskId: 't-rename',
        ownedFiles: ['src/new.ts'],            // old path is pre-existing/external
        dirtyFiles: ['src/old.ts', 'src/new.ts'],
        verifications: [],                      // no verification → unverified RED
        commitOwnedFiles: (_cwd, _files, msg) => {
          const add = spawnSync('git', ['add', '-A'], { cwd: dir })
          const commit = spawnSync('git', ['commit', '-qm', msg], { cwd: dir })
          return { ok: add.status === 0 && commit.status === 0, output: '' }
        },
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'refactor: rename old to new' } })
      assert.equal(result.isError, undefined, `Expected rename bypass, got error:\n${result.content}`)
      assert.match(result.content, /机械式变更.*rename-mechanical/)
    })

    it('owned_failure RED is NEVER bypassed even for docs files', async () => {
      const dir = tmpGitRepo()
      writeFileSync(join(dir, 'GUIDE.md'), '# Guide\n')

      const { tool, params } = makeContext({
        taskId: 't-fail',
        ownedFiles: ['GUIDE.md'],
        dirtyFiles: ['GUIDE.md'],
        verifications: [{ command: 'npm test', status: 'failed' }],
        commitOwnedFiles: () => ({ ok: true, output: '' }),
      })

      const result = await tool.execute({ ...params, cwd: dir, input: { commit: true, message: 'docs: guide' } })
      assert.equal(result.isError, true)
      assert.match(result.content, /Cannot commit/)
    })
  })

  describe('meridian blast radius focusHint', () => {
    function mockMeridianDb(reverse: Record<string, Array<{ file: string; kind: string; weight: number }>>, tests: Record<string, string[]> = {}): import('../../repo/meridian-db.js').MeridianDb {
      return {
        getReverseDependents: (f: string) => reverse[f] ?? [],
        getTestsFor: (f: string) => tests[f] ?? [],
        getCoEditNeighbors: () => [],
      } as unknown as import('../../repo/meridian-db.js').MeridianDb
    }

    it('injects blast radius into focusHint when meridianDb has consumers', async () => {
      const db = mockMeridianDb(
        { 'src/foo.ts': [{ file: 'src/bar.ts', kind: 'import', weight: 1 }] },
        { 'src/foo.ts': ['src/__tests__/foo.test.ts'] },
      )
      const { tool, params } = makeContext({
        taskId: 't-br',
        ownedFiles: ['src/foo.ts'],
        dirtyFiles: ['src/foo.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
        meridianDb: db,
      })
      const result = await tool.execute({ ...params, input: { commit: true, message: 'test: br' } })
      assert.equal(result.isError ?? false, false)
    })

    it('does not crash when meridianDb is null', async () => {
      const { tool, params } = makeContext({
        taskId: 't-no-db',
        ownedFiles: ['src/baz.ts'],
        dirtyFiles: ['src/baz.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })
      const result = await tool.execute({ ...params, input: { commit: true, message: 'test: nodb' } })
      assert.equal(result.isError ?? false, false)
    })
  })

  describe('claim audit (宣称-证据对账)', () => {
    it('blocks commit when message claims green but verification predates last write', async () => {
      const { tool, params, ledger } = makeContext({
        taskId: 't-claim-stale',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npm test', status: 'passed' }],
        commitOwnedFiles: () => {
          throw new Error('commit executor must not run when claim audit blocks')
        },
      })
      // 改完代码没重跑：验证记录之后又有文件变更（新鲜度失效）
      await new Promise(r => setTimeout(r, 10))
      ledger.record({ type: 'file_write', path: 'src/a.ts' })

      const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: done, 全绿' } })
      assert.equal(result.isError, true)
      assert.ok(result.content.includes('宣称对账失败'))
    })

    it('allows commit when green claim is backed by fresh verification', async () => {
      const { tool, params, ledger } = makeContext({
        taskId: 't-claim-fresh',
        ownedFiles: ['src/a.ts'],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })
      await new Promise(r => setTimeout(r, 10))
      ledger.record({ type: 'verification', command: 'npm test', status: 'passed' })

      const result = await tool.execute({ ...params, input: { commit: true, message: 'feat: all tests pass' } })
      assert.equal(result.isError ?? false, false)
      assert.ok(!result.content.includes('宣称对账失败'))
    })

    it('non-claim commit messages are not audited', async () => {
      const { tool, params } = makeContext({
        taskId: 't-claim-none',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npm test', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      })
      const result = await tool.execute({ ...params, input: { commit: true, message: 'fix: retry backoff' } })
      assert.equal(result.isError ?? false, false)
    })
  })

  describe('test-presence advisory (零测试交付警告)', () => {
    it('warns when delivery has ≥3 source files and zero test files', async () => {
      const { tool, params } = makeContext({
        taskId: 't-presence',
        ownedFiles: ['plugins/a/index.js', 'plugins/b/index.js', 'plugins/c/index.js'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      const result = await tool.execute(params)
      assert.ok(result.content.includes('零测试交付'), 'should surface the zero-test warning line')
      assert.ok(result.content.includes('plugins/a/index.js'))
      // advisory 不阻断：GREEN 状态不因此翻转
      assert.equal(result.isError ?? false, false)
    })

    it('does not warn when a test file is part of the delivery', async () => {
      const { tool, params } = makeContext({
        taskId: 't-presence-ok',
        ownedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/__tests__/a.test.ts'],
        verifications: [{ command: 'npm test', status: 'passed' }],
      })
      const result = await tool.execute(params)
      assert.ok(!result.content.includes('零测试交付'))
    })

    it('respects RIVET_TEST_PRESENCE_GATE=0', async () => {
      const prev = process.env.RIVET_TEST_PRESENCE_GATE
      process.env.RIVET_TEST_PRESENCE_GATE = '0'
      try {
        const { tool, params } = makeContext({
          taskId: 't-presence-off',
          ownedFiles: ['plugins/a/index.js', 'plugins/b/index.js', 'plugins/c/index.js'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        })
        const result = await tool.execute(params)
        assert.ok(!result.content.includes('零测试交付'))
      } finally {
        if (prev === undefined) delete process.env.RIVET_TEST_PRESENCE_GATE
        else process.env.RIVET_TEST_PRESENCE_GATE = prev
      }
    })
  })

  describe('P4 收束闸：PAL 收敛假设 ↔ 交付范围（弱 advisory）', () => {
    const CONVERGED = [{ caseId: 'case-9', selectedHypothesisId: 'hyp-9', targets: ['src/root-cause.ts'], claim: '根因在 root-cause 模块', evidenceRefs: ['tool:grep:4'] }]

    it('收敛 targets 不在交付文件中 → 提示但不阻断', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-miss',
        ownedFiles: ['src/unrelated.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        palConvergedCases: CONVERGED,
      })
      const result = await tool.execute(params)
      assert.equal(result.isError ?? false, false, '弱 advisory 绝不让交付失败')
      assert.match(result.content, /攻坚案件 case-9 已收敛/)
      assert.match(result.content, /src\/root-cause\.ts/)
    })

    it('收敛 targets 在交付文件中 → 零提示（修复真的落在收敛位置）', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-hit',
        ownedFiles: ['src/root-cause.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        palConvergedCases: CONVERGED,
      })
      const result = await tool.execute(params)
      assert.equal(/攻坚案件 case-9 已收敛/.test(result.content), false)
    })

    it('反证：非文件形态 targets（纯符号名）不触发路径比对提示', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-symbol',
        ownedFiles: ['src/a.ts'],
        palConvergedCases: [{ caseId: 'case-s', selectedHypothesisId: 'hyp-s', targets: ['someSymbolName'], claim: '符号级假设', evidenceRefs: [] }],
      })
      const result = await tool.execute(params)
      assert.equal(/攻坚案件 case-s/.test(result.content), false)
    })

    it('getter 缺席（headless 旧接线）→ 行为不变', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-absent',
        ownedFiles: ['src/a.ts'],
      })
      const result = await tool.execute(params)
      assert.equal(/攻坚案件/.test(result.content), false)
    })
  })

  describe('遗产回收 W-A1：needs_user 案件披露（弱 advisory）', () => {
    it('needs_user 案件 → 遗留项提示 + 最小决策问题，不阻断', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-nu',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        palNeedsUserCases: [
          { caseId: 'case-nu', problem: '登录偶发 401', minimalQuestion: '生产环境的 token 刷新周期是多少？' },
        ],
      })
      const result = await tool.execute(params)
      assert.equal(result.isError ?? false, false, '弱 advisory 绝不让交付失败')
      assert.match(result.content, /攻坚案件 case-nu 卡在等用户裁决/)
      assert.match(result.content, /登录偶发 401/)
      assert.match(result.content, /生产环境的 token 刷新周期是多少？/)
    })

    it('无 needs_user 案件（空数组）→ 零提示', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-nu-empty',
        ownedFiles: ['src/a.ts'],
        palNeedsUserCases: [],
      })
      const result = await tool.execute(params)
      assert.equal(/等用户裁决/.test(result.content), false)
    })

    it('getter 缺席（headless 旧接线）→ 行为不变', async () => {
      const { tool, params } = makeContext({
        taskId: 't-pal-nu-absent',
        ownedFiles: ['src/a.ts'],
      })
      const result = await tool.execute(params)
      assert.equal(/等用户裁决/.test(result.content), false)
    })
  })

  // ── 虚空仓库 P0：learned 参数解析 ──
  describe('parseLearnedEntries — learned 参数解析', () => {
    it('标准格式："模式描述——证据：..." 拆出 text/evidence/topic', () => {
      const [e] = parseLearnedEntries(['此项目用 npx tsx --test 运行测试——证据：package.json scripts 全用 tsx'])
      assert.ok(e)
      assert.equal(e!.text, '此项目用 npx tsx --test 运行测试')
      assert.equal(e!.evidence, 'package.json scripts 全用 tsx')
      assert.equal(e!.topic, 'package.json', 'topic 从证据里提取路径样 token')
      assert.deepEqual(e!.tags, ['agent-learned'])
    })

    it('分隔符变体容忍："--证据:" 也能拆', () => {
      const [e] = parseLearnedEntries(['模式 X 成立--证据: src/a/b.ts 的实现'])
      assert.equal(e!.text, '模式 X 成立')
      assert.equal(e!.evidence, 'src/a/b.ts 的实现')
      assert.equal(e!.topic, 'src/a/b.ts')
    })

    it('缺分隔符 → 整条入 text、evidence 为空、topic undefined', () => {
      const [e] = parseLearnedEntries(['没有证据分隔符的整句知识'])
      assert.equal(e!.text, '没有证据分隔符的整句知识')
      assert.equal(e!.evidence, '')
      assert.equal(e!.topic, undefined)
    })

    it('非数组 / 空数组 / 非字符串元素 / 空白串 → 全部安全过滤', () => {
      assert.deepEqual(parseLearnedEntries(undefined), [])
      assert.deepEqual(parseLearnedEntries('not-an-array'), [])
      assert.deepEqual(parseLearnedEntries([]), [])
      assert.deepEqual(parseLearnedEntries([42, null, '   ', { x: 1 }]), [])
    })
  })

  // ── 虚空仓库 P0：deliver_task 收割集成 ──
  describe('虚空仓库 P0：learned 收割 → memory.jsonl 直写', () => {
    it('带两条 learned → 写入两条 agent-crafted 记录（fire-and-forget，消息不入工具结果）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'void-harvest-'))
      try {
        const { tool, params } = makeContext({
          taskId: 't-learn',
          ownedFiles: ['src/a.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
          sessionId: 'sess-learn',
        })
        params.cwd = dir
        params.input = { learned: [
          '此项目用 tsx 而非 ts-node——证据：package.json',
          '压缩只在 turn 0 重写历史——证据：compact-boundary-coordinator.ts',
        ] }
        const result = await tool.execute(params)
        assert.equal(result.isError ?? false, false)
        // Fire-and-forget: 收割消息不再出现在工具结果中
        assert.doesNotMatch(result.content, /🧠 虚空仓库：已收割/)

        // Flush deferred setImmediate before reading
        await new Promise<void>(resolve => setImmediate(() => resolve()))

        const entries = readMemoryEntries(dir)
        assert.equal(entries.length, 2)
        for (const e of entries) {
          assert.equal(e.source, 'agent-crafted')
          assert.equal(e.kind, 'verified_pattern')
          assert.equal(e.status, 'verified')
          assert.equal(e.sessionId, 'sess-learn')
          assert.ok(e.id.startsWith('mem_') && e.ts > 0, 'id/ts 由 appendMemoryEntry 生成')
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('相似条目已存在 → 跳过不双写（含第四层 PAL 收割同结论场景）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'void-dedup-'))
      try {
        appendMemoryEntry(dir, {
          text: '此项目用 tsx 而非 ts-node',
          kind: 'verified_pattern', confidence: 0.95, source: 'agent-crafted', status: 'verified', tags: [],
        })
        const { tool, params } = makeContext({
          taskId: 't-learn-dup',
          ownedFiles: ['src/a.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        })
        params.cwd = dir
        params.input = { learned: ['此项目用 tsx 而非 ts-node——证据：package.json'] }
        const result = await tool.execute(params)
        assert.equal(readMemoryEntries(dir).length, 1, '相似条目挡住重复写入')
        assert.equal(/已收割/.test(result.content), false, '零新写入不报收割')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('收割失败（cwd 不可写）不阻断交付', async () => {
      const { tool, params } = makeContext({
        taskId: 't-learn-fail',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      // params.cwd 保持 '/fake/project'（不存在且不可创建）
      params.input = { learned: ['某模式——证据：某路径'] }
      const result = await tool.execute(params)
      assert.equal(result.isError ?? false, false, '收割失败绝不阻断交付')
      assert.ok(result.content.includes('GREEN'))
    })
  })

  // ── 虚空仓库 P0：收割邀请（条件展示）──
  describe('虚空仓库 P0：知识收割邀请', () => {
    it('有 PAL 案件且未带 learned → 展示收割邀请', async () => {
      const { tool, params } = makeContext({
        taskId: 't-invite-pal',
        ownedFiles: ['src/root-cause.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        palConvergedCases: [{ caseId: 'case-i', selectedHypothesisId: 'hyp-i', targets: ['src/root-cause.ts'], claim: 'c', evidenceRefs: [] }],
      })
      const result = await tool.execute(params)
      assert.match(result.content, /知识收割（虚空仓库）/)
      assert.match(result.content, /learned 参数提交/)
    })

    it('交付 ≥3 文件（长 session 代理指标）且未带 learned → 展示邀请', async () => {
      const { tool, params } = makeContext({
        taskId: 't-invite-big',
        ownedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      const result = await tool.execute(params)
      assert.match(result.content, /知识收割（虚空仓库）/)
    })

    it('本次调用已带 learned → 不重复邀请', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'void-invite-'))
      try {
        const { tool, params } = makeContext({
          taskId: 't-invite-provided',
          ownedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        })
        params.cwd = dir
        params.input = { learned: ['模式——证据：路径'] }
        const result = await tool.execute(params)
        assert.equal(/知识收割（虚空仓库）/.test(result.content), false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('小交付（<3 文件）且无 PAL 活动 → 零邀请（token 纪律）', async () => {
      const { tool, params } = makeContext({
        taskId: 't-invite-small',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      const result = await tool.execute(params)
      assert.equal(/知识收割（虚空仓库）/.test(result.content), false)
    })
  })

  describe('冗余义务门禁（星河收编 #2）', () => {
    const redundantStore = (satisfyCount: number, state: import('../evidence-obligation.js').ObligationState = 'attempted'): import('../evidence-obligation.js').ObligationStore => ({
      obligations: [{
        id: 'ob_test',
        family: 'behavior',
        claim: 'migration is reversible',
        targets: ['src/db/migrate.ts'],
        risk: 'high',
        requiredAction: 'micro_probe' as const,
        state,
        attempts: 1,
        evidenceRefs: ['probe-a'],
        redundancy: { kind: 'quorum', k: 2 },
        ...(state === 'satisfied' ? {} : { satisfyCount }),
      }],
    })

    it('冗余义务未达 k → commit 阻断（isError，不静默降级）', async () => {
      const { tool, params } = makeContext({
        taskId: 't-redundant',
        ownedFiles: ['src/db/migrate.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        obligationStore: redundantStore(1),
        commitOwnedFiles: () => { throw new Error('commit executor should not run when redundancy gate blocks') },
      })
      const result = await tool.execute({ ...params, input: { commit: true, message: 'redundant check' } })
      assert.equal(result.isError, true)
      assert.match(result.content, /冗余验证未达 quorum/)
      assert.match(result.content, /需要 2 个独立证据，当前 1 个/)
      assert.match(result.content, /Cannot commit/)
    })

    it('冗余义务达 k → 不阻断', async () => {
      let committed = false
      const { tool, params } = makeContext({
        taskId: 't-redundant-ok',
        ownedFiles: ['src/db/migrate.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        obligationStore: redundantStore(2, 'satisfied'),
        commitOwnedFiles: () => { committed = true; return { ok: true, output: 'committed' } },
      })
      const result = await tool.execute({ ...params, input: { commit: true, message: 'redundant ok' } })
      assert.equal(result.isError, undefined)
      assert.doesNotMatch(result.content, /冗余验证未达 quorum/)
      assert.equal(committed, true)
    })

    it('未提供义务 store 入口 → 门禁关闭（现状不变）', async () => {
      const { tool, params } = makeContext({
        taskId: 't-redundant-off',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
        commitOwnedFiles: () => ({ ok: true, output: 'committed' }),
      })
      const result = await tool.execute({ ...params, input: { commit: true, message: 'no store' } })
      assert.equal(result.isError, undefined)
      assert.doesNotMatch(result.content, /冗余验证未达 quorum/)
    })
  })

  // ── 证据防火墙 Phase 2（jidoka 硬门禁）──────────────────────────

  describe('evidence firewall (Phase 2)', () => {
    const unverifiedTracker = (): import('../hooks/external-claim-tracking-hook.js').ClaimTracker => ({
      claims: [{ filePath: 'src/agent/loop.ts', turn: 1, expiresAtTurn: 99 }],
    })
    const verifiedTracker = (): import('../hooks/external-claim-tracking-hook.js').ClaimTracker => ({
      claims: [{ filePath: 'src/agent/loop.ts', turn: 1, expiresAtTurn: 99, verifiedAt: 2 }],
    })

    function greenCtx(overrides: Partial<Parameters<typeof makeContext>[0]> = {}) {
      const base: Parameters<typeof makeContext>[0] = {
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        dirtyFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsx --test src/__tests__/a.test.ts', status: 'passed', meta: { scope: 'targeted' } }],
        commitOwnedFiles: () => ({ ok: true, output: 'commit abc123' }),
      }
      return makeContext({ ...base, ...overrides })
    }

    it('防火墙开 + commit + 引用未核验 claim → isError 硬拦', async () => {
      const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: true })
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: src/agent/loop.ts:100 的问题' },
      })
      assert.equal(result.isError, true)
      assert.ok(result.content.includes('evidence firewall'))
      assert.ok(result.content.includes('src/agent/loop.ts'))
      assert.ok(result.content.includes('Recovery'))
    })

    it('claim 已 verifiedAt → 放行（走正常 gate 流程）', async () => {
      const { tool, params } = greenCtx({ claimTracker: verifiedTracker(), scoutFirewall: true })
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: src/agent/loop.ts:100 的问题' },
      })
      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /evidence firewall/)
    })

    it('引用非声称路径 → 不拦', async () => {
      const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: true })
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: src/tools/bar.ts:45 的问题' },
      })
      assert.equal(result.isError ?? false, false)
    })

    it('commit=false → 无 isError，警示行在报告里（报告轮恒开）', async () => {
      const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: true })
      const result = await tool.execute({
        ...params,
        input: { message: 'fix: src/agent/loop.ts:100 的问题' },
      })
      assert.equal(result.isError ?? false, false)
      assert.match(result.content, /证据防火墙：交付文本引用了 delegate 报告的路径/)
    })

    it('防火墙关（config false、env 未设）→ 不拦，警示行仍在', async () => {
      const prev = process.env.RIVET_SCOUT_FIREWALL
      delete process.env.RIVET_SCOUT_FIREWALL
      try {
        const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: false })
        const result = await tool.execute({
          ...params,
          input: { commit: true, message: 'fix: src/agent/loop.ts:100 的问题' },
        })
        assert.equal(result.isError ?? false, false)
        assert.match(result.content, /证据防火墙：交付文本引用了 delegate 报告的路径/)
      } finally {
        if (prev !== undefined) process.env.RIVET_SCOUT_FIREWALL = prev
      }
    })

    it('getClaimTracker 缺省 → 完全现状行为（无警示行）', async () => {
      const { tool, params } = greenCtx()
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: 'fix: src/agent/loop.ts:100 的问题' },
      })
      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /证据防火墙/)
    })

    it('[待核] 标注行豁免 → 不拦不警示', async () => {
      const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: true })
      const result = await tool.execute({
        ...params,
        input: { commit: true, message: '已修复（[待核] src/agent/loop.ts:100 尚待核验）' },
      })
      assert.equal(result.isError ?? false, false)
      assert.doesNotMatch(result.content, /证据防火墙/)
    })

    it('force=true 不豁免', async () => {
      const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: true })
      const result = await tool.execute({
        ...params,
        input: { commit: true, force: true, message: 'fix: src/agent/loop.ts:100 的问题' },
      })
      assert.equal(result.isError, true)
      assert.ok(result.content.includes('force 不豁免'))
    })

    it('env RIVET_SCOUT_FIREWALL=1 覆盖 config false → 拦', async () => {
      const prev = process.env.RIVET_SCOUT_FIREWALL
      process.env.RIVET_SCOUT_FIREWALL = '1'
      try {
        const { tool, params } = greenCtx({ claimTracker: unverifiedTracker(), scoutFirewall: false })
        const result = await tool.execute({
          ...params,
          input: { commit: true, message: 'fix: src/agent/loop.ts:100 的问题' },
        })
        assert.equal(result.isError, true)
        assert.ok(result.content.includes('evidence firewall'))
      } finally {
        if (prev === undefined) delete process.env.RIVET_SCOUT_FIREWALL
        else process.env.RIVET_SCOUT_FIREWALL = prev
      }
    })
  })
})

// ── 提交卡死诊断插桩（2026-08-06，deliver_task isError 结果卡死排查）─────
// RIVET_DEBUG=1 时 execute 关键阶段打时间戳标记；卡死时日志最后一个
// stage 即卡点（execute 内 vs harness 结果回传层可区分）。
describe('deliver-task stage markers', () => {
  it('emits execute:start / report:done markers on the fast path (RIVET_DEBUG=1)', async () => {
    const prevDebug = process.env.RIVET_DEBUG
    process.env.RIVET_DEBUG = '1'
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')) }
    try {
      const { tool, params } = makeContext({
        taskId: 't1',
        ownedFiles: ['src/a.ts'],
        verifications: [{ command: 'npx tsc --noEmit', status: 'passed' }],
      })
      const result = await tool.execute(params)
      assert.equal(result.isError ?? false, false)
      assert.ok(result.content.includes('GREEN'))
    } finally {
      console.warn = origWarn
      if (prevDebug === undefined) delete process.env.RIVET_DEBUG
      else process.env.RIVET_DEBUG = prevDebug
    }
    const markers = warns.filter(w => w.includes('[deliver-task]'))
    assert.ok(markers.some(m => m.includes('execute:start')), `missing execute:start in: ${markers.join(' | ')}`)
    assert.ok(markers.some(m => m.includes('report:done')), `missing report:done in: ${markers.join(' | ')}`)
  })

  it('stays silent without RIVET_DEBUG (zero production overhead)', async () => {
    const prevDebug = process.env.RIVET_DEBUG
    delete process.env.RIVET_DEBUG
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')) }
    try {
      const { tool, params } = makeContext({ taskId: 't2', ownedFiles: [] })
      await tool.execute(params)
    } finally {
      console.warn = origWarn
      if (prevDebug !== undefined) process.env.RIVET_DEBUG = prevDebug
    }
    assert.equal(warns.some(w => w.includes('[deliver-task]')), false)
  })
})
