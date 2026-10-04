import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../../tools/bash.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { ToolResult } from '../../tools/types.js'
import { executeToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'
import { EvidenceTracker } from '../evidence.js'
import { TurnHarness } from '../turn-harness.js'
import { TrajectoryRecorder } from '../trajectory.js'
import { createTaskLedger } from '../task-ledger.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createVerificationAttribution, assessImpactedTestCoverage } from '../verification-attribution.js'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
import { createTurnBudget } from '../turn-budget.js'
import { observeRun } from '../stall-observer.js'

async function runVerification(command: string, failTest: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'rivet-bash-evidence-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = join(root, 'rivet-home')
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }))
    writeFileSync(join(cwd, 'good.test.mjs'), "import { test } from 'node:test'; test('passing fixture', () => {});\n")
    writeFileSync(join(cwd, 'bad.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('fixture assertion', () => assert.equal(1, ${failTest ? 2 : 1}));\n`)
    const ledger = createTaskLedger({ taskId: 'bash-evidence-test' })
    ledger.record({ type: 'file_write', path: 'feature.js' })
    const baseline = createWorktreeBaseline({ branch: 'fixture', head: 'fixture-head', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    const evidence = new EvidenceTracker()
    evidence.trackFileModified('feature.js')
    let actual: ToolResult | undefined
    const registry = new ToolRegistry()
    registry.register({ ...BASH_TOOL, execute: async params => { actual = await BASH_TOOL.execute(params); return actual } })
    const trajectory = new TrajectoryRecorder()
    const deps = {
      config: {
        toolRegistry: registry, hooks: null, lspEnabled: false, sessionId: 'bash-evidence-test',
        approvalMode: 'dangerously-skip-permissions',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'fixture-model' },
      },
      cwd, harness: new TurnHarness({ maxRetries: 0, retryableClasses: [] }, trajectory),
      prewarm: { get: () => null, invalidate: () => {} }, evidence,
      traceStore: { events: [], toolFingerprints: [] },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: unknown) => ({ output: input, telemetry: [] }) },
      importGraph: null, lastConflictCheckCount: 0, trajectory,
      getDoomLoopLevel: () => 'none', latestRisk: { level: 'none', reasons: [], suggestedAction: '' },
      sessionTurnCount: 1, sessionId: 'bash-evidence-test', recordToolHistory: () => {},
      turnBudget: createTurnBudget(0), taskLedger: ledger, ownershipLedger: ownership,
    } as unknown as ToolPipelineDeps
    const callbacks = {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: () => {},
      onTurnComplete: () => {}, onError: () => {}, onAbort: () => {},
      onApprovalRequired: async () => true, onCheckpoint: () => {},
    }
    await observeRun('bash-evidence-test', () => executeToolUse(
      { id: 'real-bash-verification', name: 'bash', input: { command } }, deps, callbacks, 1, false,
    ))
    const verification = evidence.getState().verifications.at(-1)!
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
    return { actual: actual!, verification, ledgerEvent: ledger.getVerifications().at(-1)!, gate: gate.assess([]) }
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}

describe('real bash verification pipeline', () => {
  it('blocks delivery after actual targeted assertion failure with isError=false', async () => {
    const result = await runVerification('node --test bad.test.mjs', true)
    assert.equal(result.actual.isError, false, 'normal execution is distinct from assertion success')
    assert.equal(result.actual.exitCode, 1)
    assert.equal(result.verification.exitCode, 1)
    assert.equal(result.verification.status, 'failed')
    assert.equal(result.ledgerEvent.meta?.exitCode, 1)
    assert.equal(result.ledgerEvent.status, 'failed')
    assert.equal(result.gate.state, 'RED')
    assert.equal(result.gate.canDeliver, false)
  })

  it('records actual full-suite failure without claiming verified delivery', async () => {
    const result = await runVerification('npm test', true)
    assert.equal(result.actual.exitCode, 1)
    assert.equal(result.verification.status, 'failed')
    assert.equal(result.verification.scope, 'full')
    assert.notEqual(result.gate.state, 'GREEN')
  })

  it('does not cover an unrun failing test with one actual successful targeted test', async () => {
    const result = await runVerification('node --test good.test.mjs', true)
    assert.equal(result.actual.exitCode, 0)
    assert.equal(result.verification.status, 'passed')
    assert.equal(result.verification.scope, 'targeted')
    assert.deepEqual(result.ledgerEvent.meta?.targetFiles, ['good.test.mjs'])
    assert.deepEqual(assessImpactedTestCoverage(['good.test.mjs', 'bad.test.mjs'], [result.verification], () => true), {
      uncovered: ['bad.test.mjs'], uncoverable: [],
    })
  })

  it('allows delivery after actual successful unfiltered node test execution', async () => {
    const result = await runVerification('node --test', false)
    assert.equal(result.actual.exitCode, 0)
    assert.equal(result.verification.status, 'passed')
    assert.equal(result.verification.scope, 'full')
    assert.equal(result.gate.state, 'GREEN')
    assert.equal(result.gate.canDeliver, true)
  })
})
