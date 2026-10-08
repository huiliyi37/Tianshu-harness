import assert from 'node:assert/strict'
import { SessionJobs } from '../../../tools/job-store.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL } from '../../../tools/run-tests.js'
import { BASH_TOOL } from '../../../tools/bash.js'
import { ToolRegistry } from '../../../tools/registry.js'
import type { ToolCallParams, ToolResult } from '../../../tools/types.js'
import { executeToolUse, type ToolPipelineDeps } from '../../tool-pipeline.js'
import { EvidenceTracker } from '../../evidence.js'
import { TurnHarness } from '../../turn-harness.js'
import { TrajectoryRecorder } from '../../trajectory.js'
import { createTaskLedger } from '../../task-ledger.js'
import { createOwnershipLedger } from '../../ownership-ledger.js'
import { createWorktreeBaseline } from '../../worktree-baseline.js'
import { createVerificationAttribution } from '../../verification-attribution.js'
import { createDeliveryGateV2 } from '../../delivery-gate-v2.js'
import { createTurnBudget } from '../../turn-budget.js'
import { observeRun } from '../../stall-observer.js'
import { ArtifactStore } from '../../../artifact/store.js'

export async function runVerification(command: string, failTest: boolean, ownFailingTest = false, options: { tool?: 'bash' | 'run_tests'; noTestInfra?: boolean; background?: boolean; artifactize?: boolean; expectedVerificationCount?: number; snapshot?: { omittedDirtyFiles: string[]; retry?: boolean } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rivet-bash-evidence-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = join(root, 'rivet-home')
  mkdirSync(process.env.RIVET_HOME)
  writeFileSync(join(process.env.RIVET_HOME, 'config.json'), '{}')
  const jobs = new SessionJobs(join(root, 'jobs'))
  try {
    if (!options.noTestInfra) writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test', typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }))
    writeFileSync(join(cwd, 'good.test.mjs'), "import { test } from 'node:test'; test('passing fixture', () => {});\n")
    writeFileSync(join(cwd, 'bad.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('fixture assertion', () => assert.equal(1, ${failTest ? 2 : 1}));\n`)
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd })
    const ledger = createTaskLedger({ taskId: 'bash-evidence-test' })
    ledger.record({ type: 'file_write', path: 'feature.js' })
    if (ownFailingTest) ledger.record({ type: 'file_write', path: 'bad.test.mjs' })
    const baseline = createWorktreeBaseline({ branch: 'fixture', head: 'fixture-head', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now() })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    const evidence = new EvidenceTracker()
    evidence.trackFileModified('feature.js')
    let actual: ToolResult | undefined
    let capturedParams: ToolCallParams | undefined
    let emittedContent = ''
    const registry = new ToolRegistry()
    const tool = options.tool === 'run_tests' ? RUN_TESTS_TOOL : BASH_TOOL
    registry.register({ ...tool, execute: async params => { capturedParams = params; actual = await tool.execute(params); return actual } })
    const trajectory = new TrajectoryRecorder()
    const deps = {
      config: {
        toolRegistry: registry, hooks: null, lspEnabled: false, sessionId: 'bash-evidence-test',
        approvalMode: 'dangerously-skip-permissions',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'fixture-model' },
      },
      cwd, jobs, harness: new TurnHarness({ maxRetries: 0, retryableClasses: [] }, trajectory),
      prewarm: { get: () => null, invalidate: () => {} }, evidence,
      traceStore: { events: [], toolFingerprints: [] },
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} },
      repairPipeline: { run: (input: unknown) => ({ output: input, telemetry: [] }) },
      importGraph: null, lastConflictCheckCount: 0, trajectory,
      getDoomLoopLevel: () => 'none', latestRisk: { level: 'none', reasons: [], suggestedAction: '' },
      sessionTurnCount: 1, sessionId: 'bash-evidence-test', recordToolHistory: () => {},
      turnBudget: createTurnBudget(0), taskLedger: ledger, ownershipLedger: ownership,
      ...(options.artifactize ? { artifactStore: new ArtifactStore(join(root, 'artifacts'), 'fixture'), cacheAdvisor: { getArtifactThreshold: () => 1 } } : {}),
      ...(options.snapshot ? {
        verificationSnapshotManager: {
          prepare: async () => options.snapshot?.retry ? null : { path: cwd, snapshotRef: 'fixture-snapshot', omittedDirtyFiles: options.snapshot!.omittedDirtyFiles },
          prepareRetry: async () => ({ path: cwd, snapshotRef: 'fixture-retry', omittedDirtyFiles: options.snapshot!.omittedDirtyFiles }),
        },
        ...(options.snapshot.retry ? { sessionRegistry: { consumeEvents: () => [{ eventType: 'workspace_mutation' }] } } : {}),
      } : {}),
    } as unknown as ToolPipelineDeps
    const callbacks = {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: (_id: string, _name: string, content: string) => { emittedContent = content },
      onTurnComplete: () => {}, onError: () => {}, onAbort: () => {},
      onApprovalRequired: async () => true, onCheckpoint: () => {},
    }
    const pipelineResult = await observeRun('bash-evidence-test', () => executeToolUse(
      { id: 'real-bash-verification', name: tool.definition.name, input: options.tool === 'run_tests' ? (command ? { filter: command } : {}) : { command, run_in_background: options.background === true } }, deps, callbacks, 1, false,
    ))
    const initialVerificationCount = ledger.getVerifications().length
    if (options.background) {
      assert.equal(initialVerificationCount, 0, 'launch cannot count as completed verification')
      assert.ok(actual?.backgroundJobId)
      const finished = await jobs.await(actual.backgroundJobId, { timeoutMs: 60_000 })
      assert.ok(finished && !finished.timedOut && finished.job.status !== 'running', finished?.tail ?? 'fixture background verification must settle before reading evidence')
      await jobs.await(actual.backgroundJobId, { timeoutMs: 1 })
      jobs.logs(actual.backgroundJobId)
      assert.equal(ledger.getVerifications().length, options.expectedVerificationCount ?? 1, 'completion records only verification invocations, once')
    }
    const verification = evidence.getState().verifications.at(-1)!
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })
    return { actual: actual!, capturedParams, emittedContent, pipelineResult, initialVerificationCount, verification, ledgerEvent: ledger.getVerifications().at(-1)!, gate: gate.assess([]), deliveryGate: gate, ledger, ownership }
  } finally {
    await jobs.killAllAsync()
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
}
