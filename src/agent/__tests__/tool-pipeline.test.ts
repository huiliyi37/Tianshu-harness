import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { executeToolUse, patchTargetPaths, type ToolPipelineDeps } from '../tool-pipeline.js'
import { createTurnBudget } from '../turn-budget.js'
import { fingerprintToolCall } from '../trace-store.js'
import { createPermissionOverlay } from '../permissions.js'
import type { EvidenceTrackerPublic } from '../evidence.js'
import { ArtifactStore } from '../../artifact/store.js'
import { _setSandboxBackendForTest, _resetSandboxBackendCache } from '../../tools/sandbox-profile.js'
import { isWriteGranted, _resetGrantsForTest, loadPersistedGrants, revokeGrant } from '../../tools/path-grants.js'
import { rivetHome } from '../../config/paths.js'

/** Sandbox-safe temp directory — macOS sandbox blocks os.tmpdir() /var/folders/...
 *  Must be absolute so resolve(cwd, target) in path validation works correctly. */
const TEST_TMP = resolvePath('.rivet', 'tmp')
mkdirSync(TEST_TMP, { recursive: true })
function testTmp(): string { return TEST_TMP }

const mockEvidence = {
  trackFileRead: () => {},
  trackFileModified: () => {},
  trackImpact: () => {},
  trackVerification: () => {},
  getState: () => ({
    filesRead: new Set<string>(),
    filesModified: new Set<string>(),
    verifications: [],
    deliveryStatus: 'unverified' as const,
    impactedFiles: new Set<string>(),
    impactedTests: new Set<string>(),
  }),
  getVerificationSummary: () => ({ total: 0, verified: 0, pending: 0, files: [] }),
  getGateState: () => ({
    filesModified: 0,
    verifications: 0,
    editsSinceLastTest: 0,
    hasFailedTests: false,
    hasCodeEdits: false,
    hasReadTestFiles: false,
  }),
  buildSummary: () => ({
    filesRead: [],
    filesModified: [],
    verificationStatus: 'unverified',
    verifications: [],
    gate: { state: 'ok', label: 'ok' },
    impactedFiles: [],
    impactedTests: [],
  }),
  reset: () => {},
} satisfies EvidenceTrackerPublic

describe('executeToolUse', () => {
  function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'test-model' },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      ...overrides,
    }
  }

  it('refuses to execute a tool call whose args were truncated by stream interruption', async () => {
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-trunc', name: 'bash', input: {}, argsTruncated: true },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, false, 'tool must NOT execute with the {} placeholder input')
    const tr = result.toolResult as any
    assert.equal(tr.is_error, true)
    assert.equal(tr.tool_use_id, 'tu-trunc')
    assert.ok(tr.content.includes('NOT executed'), 'error result must state the call did not run')
    assert.ok(tr.content.includes('Re-issue'), 'error result must tell the model to re-issue the call')
  })

  it('adds read-loop strategy signal after repeated diet no-info read_file results', async () => {
    const deps = makeDeps({
      trajectory: {
        getEntries: () => [
          {
            turn: 1,
            tool: 'read_file',
            target: 'src/agent/loop.ts',
            durationMs: 10,
            status: 'success',
            inputSummary: '',
            resultSummary: '[diet:redundant] re-read later',
          },
        ],
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '[diet:useless] retried successfully', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-read-loop', name: 'read_file', input: { file_path: 'src/agent/loop.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.includes('[策略信号：读取循环]'))
    assert.ok(content.includes('grep / repo_graph / ask_user_question'))
  })

  it('does not add read-loop strategy signal for first diet placeholder', async () => {
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '[diet:redundant] re-read later', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-read-loop-first', name: 'read_file', input: { file_path: 'src/agent/loop.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(!content.includes('[策略信号：读取循环]'))
  })

  it('VSW: injects verificationSnapshot into run_tests params when the manager returns a plan', async () => {
    let seen: any
    const deps = makeDeps({
      ownershipLedger: { getOwnedFiles: () => ['a.ts'], getBaselineHead: () => 'head1' } as any,
      verificationSnapshotManager: {
        prepare: (owned: string[]) => ({ path: '/snap/dir', snapshotRef: 'head1+diffX', decision: { snapshot: true } as any, ownedFiles: owned }),
        lastDecision: () => null,
        currentSnapshotRef: () => 'head1+diffX',
        destroy: () => {},
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async (_name: string, params: any) => { seen = params.verificationSnapshot; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-rt', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(seen, { path: '/snap/dir', snapshotRef: 'head1+diffX' })
  })

  it('VSW: leaves verificationSnapshot unset when the manager returns null (in-place)', async () => {
    let seen: any = 'sentinel'
    const deps = makeDeps({
      ownershipLedger: { getOwnedFiles: () => [], getBaselineHead: () => '' } as any,
      verificationSnapshotManager: {
        prepare: () => null,
        lastDecision: () => null,
        currentSnapshotRef: () => undefined,
        destroy: () => {},
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async (_name: string, params: any) => { seen = params.verificationSnapshot; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-rt2', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(seen, undefined)
  })

  it('VSW: degrades to in-place when snapshot build (prepare) rejects', async () => {
    // Real pipeline degrade contract: manager.prepare throwing (e.g. VSW overlay
    // git diff failure) must be swallowed by executeToolUse's catch — run_tests
    // still executes, with no verificationSnapshot injected.
    let seen: any = 'sentinel'
    let executed = false
    const deps = makeDeps({
      ownershipLedger: { getOwnedFiles: () => ['a.ts'], getBaselineHead: () => 'head1' } as any,
      verificationSnapshotManager: {
        prepare: async () => { throw new Error('VSW overlay: git diff failed for baseline head1: fatal: bad object') },
        lastDecision: () => null,
        currentSnapshotRef: () => undefined,
        destroy: () => {},
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async (_name: string, params: any) => {
            executed = true
            seen = params.verificationSnapshot
            return { content: 'ok', isError: false }
          },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-rt3', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, true, 'run_tests must still execute after snapshot build failure')
    assert.equal(seen, undefined, 'no verificationSnapshot must be injected on degrade')
    assert.ok(
      String((result.toolResult as any).content).includes('ok'),
      'degrade must return the in-place tool result, not an error',
    )
  })

  it('A1: tool timeout cascades an abort into the underlying op before rejecting', async () => {
    let captured: AbortSignal | undefined
    let abortedInTool = false
    const loopController = new AbortController()
    const deps = makeDeps({
      abortSignal: loopController.signal,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          // Underlying op that only settles when its abortSignal fires — proves
          // that a tool-level timeout must cascade an abort (not merely reject the wrapper).
          execute: (_name: string, params: any) => {
            captured = params.abortSignal
            return new Promise((resolve) => {
              params.abortSignal?.addEventListener('abort', () => {
                abortedInTool = true
                resolve({ content: 'aborted', isError: true })
              }, { once: true })
            })
          },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false, timeoutMs: () => 20 }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        } as any,
      } as any,
    })

    await executeToolUse(
      { id: 'tu-timeout', name: 'grep', input: { pattern: 'x' } },
      deps, noopCallbacks as any, 1, false,
    ).catch(() => {})

    assert.ok(captured, 'tool received a composed abortSignal via params')
    assert.equal(captured!.aborted, true, 'composed signal aborted when the tool timed out')
    assert.equal(abortedInTool, true, 'underlying op observed the abort')
    assert.equal(loopController.signal.aborted, false, 'loop signal itself is not aborted by a single tool timeout')
  })

  it('write-ledger: ast_edit absolute path normalizes to the same cwd-relative key the pre-write guard uses', async () => {
    const events: any[] = []
    const owned: string[] = []
    const claimed: string[] = []
    const deps = makeDeps({
      cwd: '/tmp/ws',
      sessionId: 'mine',
      sessionRegistry: {
        acquireClaim: (_sid: string, path: string) => { claimed.push(path); return true },
        checkClaim: () => null,
      } as any,
      taskLedger: { record: (event: any) => { events.push(event) } } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ast-abs', name: 'ast_edit', input: { paths: ['/tmp/ws/src/foo.ts'], ops: [{ replace: 'x' }], dryRun: false } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'file_write')
    assert.equal(event.path, 'src/foo.ts', 'absolute path must normalize to the cwd-relative claim key')
    assert.deepEqual(owned, ['src/foo.ts'])
    assert.deepEqual([...new Set(claimed)], ['src/foo.ts'], 'pre-write guard and post-write ledger must stake the same key')
  })

  it('write-ledger: ast_edit singular `path` alias is no longer dropped from the ledger', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      cwd: '/tmp/ws',
      taskLedger: { record: (event: any) => { events.push(event) } } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ast-singular', name: 'ast_edit', input: { path: 'src/bar.ts', ops: [{ replace: 'x' }], dryRun: false } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'file_write', 'singular `path` is a real write target (ast-edit.ts:100)')
    assert.equal(event.path, 'src/bar.ts')
    assert.deepEqual(owned, ['src/bar.ts'])
  })

  it('write-ledger: ast_edit preview (no dryRun) stays tool_exec — no ledger entry, no claim', async () => {
    const events: any[] = []
    const owned: string[] = []
    const claimed: string[] = []
    const deps = makeDeps({
      cwd: '/tmp/ws',
      sessionId: 'mine',
      sessionRegistry: {
        acquireClaim: (_sid: string, path: string) => { claimed.push(path); return true },
        checkClaim: () => null,
      } as any,
      taskLedger: { record: (event: any) => { events.push(event) } } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ast-prev', name: 'ast_edit', input: { paths: ['src/foo.ts'], ops: [{ replace: 'x' }] } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'tool_exec', 'a preview writes nothing')
    assert.deepEqual(owned, [])
    assert.deepEqual(claimed, [], 'preview must not stake a claim')
  })

  it('write-ledger: apply_patch absolute diff header normalizes to the cwd-relative key', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      cwd: '/tmp/ws',
      taskLedger: { record: (event: any) => { events.push(event) } } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
    })

    const diff = ['--- a//tmp/ws/src/a.ts', '+++ b//tmp/ws/src/a.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')
    await executeToolUse(
      { id: 'tu-patch-abs', name: 'apply_patch', input: { diff } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'file_write')
    assert.equal(event.path, 'src/a.ts', 'patch target must normalize like every other write tool')
    assert.deepEqual(owned, ['src/a.ts'])
  })

  it('records applied plan_close as file_write in task ledger', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'Plan closed: docs/superpowers/plans/demo.md', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-plan-close-apply', name: 'plan_close', input: { file_path: 'docs/superpowers/plans/demo.md', tasks: '1', apply: true } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'file_write')
    assert.equal(event.path, 'docs/superpowers/plans/demo.md')
    assert.deepEqual(owned, ['docs/superpowers/plans/demo.md'])
  })

  it('records preview plan_close as tool_exec without owning the file', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
        getOwnedFiles: () => owned,
      } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'Plan close preview: docs/superpowers/plans/demo.md', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-plan-close-preview', name: 'plan_close', input: { file_path: 'docs/superpowers/plans/demo.md', tasks: '1', apply: false } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'tool_exec')
    assert.equal(event.tool, 'plan_close')
    assert.equal(event.path, 'docs/superpowers/plans/demo.md')
    assert.deepEqual(owned, [])
  })

  it('records hash_edit as file_write in task ledger (claim-audit freshness)', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
        getEvents: () => [],
        getOwnedFiles: () => owned,
      } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'edited', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-hash-edit', name: 'hash_edit', input: { file_path: 'src/agent/loop.ts', anchors: ['x'], new_string: 'y' } },
      deps, noopCallbacks as any, 1, false,
    )

    const write = events.find(e => e.type === 'file_write')
    assert.ok(write, 'hash_edit must record a file_write event')
    assert.equal(write.path, 'src/agent/loop.ts')
    assert.deepEqual(owned, ['src/agent/loop.ts'])
  })

  it('records apply_patch target files as file_write; check_only stays tool_exec', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
        getEvents: () => [],
        getOwnedFiles: () => owned,
      } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'patch applied', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n')

    await executeToolUse(
      { id: 'tu-apply-patch', name: 'apply_patch', input: { diff } },
      deps, noopCallbacks as any, 1, false,
    )
    const writes = events.filter(e => e.type === 'file_write').map(e => e.path)
    assert.deepEqual(writes.sort(), ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(owned.sort(), ['src/a.ts', 'src/b.ts'])

    events.length = 0
    await executeToolUse(
      { id: 'tu-apply-patch-check', name: 'apply_patch', input: { diff, check_only: true } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal(events.filter(e => e.type === 'file_write').length, 0)
    assert.ok(events.some(e => e.type === 'tool_exec' && e.tool === 'apply_patch'))
  })

  it('records structured git tool actions as git_action in task ledger', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
        getEvents: () => [],
        getOwnedFiles: () => [],
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'stashed', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-git-stash-pop', name: 'git', input: { action: 'stash_pop' } },
      deps, noopCallbacks as any, 1, false,
    )

    const action = events.find(e => e.type === 'git_action')
    assert.ok(action, 'structured git tool must record a git_action event')
    assert.equal(action.meta.command, 'git stash_pop')
  })

  it('patchTargetPaths parses adds/updates/deletes from unified diff headers', () => {
    const diff = [
      '--- a/src/updated.ts',
      '+++ b/src/updated.ts',
      '@@ -1 +1 @@',
      '--- /dev/null',
      '+++ b/src/added.ts',
      '@@ -0,0 +1 @@',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
    ].join('\n')
    assert.deepEqual(patchTargetPaths(diff).sort(), ['src/added.ts', 'src/deleted.ts', 'src/updated.ts'])
    assert.deepEqual(patchTargetPaths('not a diff'), [])
  })

  it('warns before editing sensitive paths when manifest was not read', async () => {
    const events: any[] = []
    const callbackChunks: string[] = []
    const deps = makeDeps({
      taskLedger: {
        getEvents: () => [],
        record: (event: any) => { events.push(event) },
        getOwnedFiles: () => events.filter(e => e.type === 'file_write').map(e => e.path),
      } as any,
      ownershipLedger: {
        registerOwned: () => {},
        getOwnedFiles: () => [],
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'edited', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onToolResult: (_id: string, _name: string, content: string) => { callbackChunks.push(content) } }

    await executeToolUse(
      { id: 'tu-sensitive-edit', name: 'edit_file', input: { file_path: 'src/context/project-memory-loader.ts' } },
      deps, callbacks as any, 1, false,
    )

    assert.ok(callbackChunks.some(chunk => chunk.includes('Sensitive-area preflight required')))
    assert.ok(callbackChunks.some(chunk => chunk.includes('.rivet/knowledge/manifest.md')))
  })

  it('does not warn for sensitive edits after manifest was read', async () => {
    const callbackChunks: string[] = []
    const deps = makeDeps({
      taskLedger: {
        getEvents: () => [{ type: 'file_read', path: '.rivet/knowledge/manifest.md', timestamp: Date.now() }],
        record: () => {},
        getOwnedFiles: () => [],
      } as any,
      ownershipLedger: {
        registerOwned: () => {},
        getOwnedFiles: () => [],
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'edited', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onToolResult: (_id: string, _name: string, content: string) => { callbackChunks.push(content) } }

    await executeToolUse(
      { id: 'tu-sensitive-edit-after-read', name: 'edit_file', input: { file_path: 'src/context/project-memory-loader.ts' } },
      deps, callbacks as any, 1, false,
    )

    assert.ok(!callbackChunks.some(chunk => chunk.includes('Sensitive-area preflight required')))
  })

  it('records run_tests as verification in task ledger', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ledger-run-tests', name: 'run_tests', input: { filter: 'src/foo.test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'verification')
    assert.equal(event.command, 'run_tests src/foo.test.ts')
    assert.equal(event.status, 'passed')
    assert.equal(event.meta.scope, 'targeted')
  })

  it('marks git dirty after successful deliver_task commit', async () => {
    const events: any[] = []
    let gitDirtyCalls = 0
    const base = makeDeps()
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      config: {
        ...base.config,
        promptEngine: {
          markGitDirty: () => { gitDirtyCalls++ },
          getModel: () => 'test-model',
        },
      } as any,
    })
    await executeToolUse(
      { id: 'tu-deliver-commit', name: 'deliver_task', input: { commit: true, message: 'feat: x' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(gitDirtyCalls, 1, 'markGitDirty must be called after successful deliver_task commit')
    const event = events.at(-1)
    assert.equal(event.type, 'git_action')
  })

  it('does not mark git dirty for deliver_task readiness check (commit=false)', async () => {
    let gitDirtyCalls = 0
    const base = makeDeps()
    const deps = makeDeps({
      taskLedger: { record: () => {} } as any,
      config: {
        ...base.config,
        promptEngine: {
          markGitDirty: () => { gitDirtyCalls++ },
          getModel: () => 'test-model',
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-deliver-check', name: 'deliver_task', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(gitDirtyCalls, 0)
  })

  it('records run_tests parsed verification counts in task ledger meta', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({
            content: '退出码：1\n0 通过，0 失败，0 跳过',
            isError: true,
            verification: {
              command: 'tsx --test src/foo.test.ts',
              status: 'failed',
              scope: 'targeted',
              exitCode: 1,
              passed: 0,
              failed: 0,
              skipped: 0,
              durationMs: 25,
            },
          }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ledger-run-tests-failed', name: 'run_tests', input: { filter: 'src/foo.test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'verification')
    assert.equal(event.command, 'run_tests src/foo.test.ts')
    assert.equal(event.status, 'failed')
    assert.deepEqual(event.meta, {
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 25,
      resolvedCommand: 'tsx --test src/foo.test.ts',
      recommendedCommand: 'tsx --test src/foo.test.ts',
    })
  })

  it('LSP narrowing: in-region errors surface fully, out-of-region errors collapse, warnings drop', async () => {
    const base = makeDeps()
    const lspCwd = mkdtempSync(join(testTmp(), 'lsp-narrow-'))
    const deps = makeDeps({
      cwd: lspCwd,
      lspManager: {
        isReady: () => true,
        changeFile: () => {},
        getFileDiagnostics: async () => [
          { range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } }, severity: 1, message: 'in-region type error' },
          { range: { start: { line: 199, character: 0 }, end: { line: 199, character: 1 } }, severity: 1, message: 'far away error' },
          { range: { start: { line: 249, character: 0 }, end: { line: 249, character: 1 } }, severity: 2, message: 'far away warning' },
        ],
      } as any,
      config: {
        ...base.config,
        toolRegistry: {
          execute: async () => ({
            content: 'Applied edit to src/foo.ts',
            isError: false,
            uiContent: 'diff-body',
            changedRanges: [{ start: 10, end: 10 }],
          }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    let uiContent: string | undefined
    const cb = {
      ...noopCallbacks,
      onToolResult: (_id: string, _n: string, _c: string, _e?: boolean, _rp?: string, ui?: string) => { uiContent = ui },
    }

    const result = await executeToolUse(
      { id: 'tu-lsp-narrow', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      deps, cb as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.includes('[LSP Diagnostics]'), 'appends an LSP block')
    assert.ok(content.includes('ERROR L10: in-region type error'), 'in-region error surfaced fully')
    assert.ok(!content.includes('far away error'), 'out-of-region error message not dumped to model')
    assert.ok(content.includes('+1 error(s) elsewhere in file (L200)'), 'out-of-region error collapsed to nudge')
    assert.ok(!content.includes('far away warning'), 'out-of-region warning dropped from model')
    // UI gets the full list (errors + warnings), whole file.
    assert.ok(uiContent && uiContent.includes('ERROR L200: far away error'), 'UI shows out-of-region error')
    assert.ok(uiContent!.includes('WARNING L250: far away warning'), 'UI shows out-of-region warning')
    assert.ok(uiContent!.startsWith('diff-body'), 'UI keeps the original diff, then appends diagnostics')
    rmSync(lspCwd, { recursive: true, force: true })
  })

  it('LSP narrowing: falls back to whole-file model output when changedRanges is absent', async () => {
    const base = makeDeps()
    const lspCwd = mkdtempSync(join(testTmp(), 'lsp-fallback-'))
    const deps = makeDeps({
      cwd: lspCwd,
      lspManager: {
        isReady: () => true,
        changeFile: () => {},
        getFileDiagnostics: async () => [
          { range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } }, severity: 1, message: 'err a' },
          { range: { start: { line: 199, character: 0 }, end: { line: 199, character: 1 } }, severity: 1, message: 'err b' },
        ],
      } as any,
      config: {
        ...base.config,
        toolRegistry: {
          execute: async () => ({ content: 'Applied edit to src/foo.ts', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-lsp-fallback', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.includes('ERROR L10: err a'), 'both errors surfaced when unlocalized')
    assert.ok(content.includes('ERROR L200: err b'), 'both errors surfaced when unlocalized')
    assert.ok(!content.includes('elsewhere in file'), 'no collapse without ranges')
    rmSync(lspCwd, { recursive: true, force: true })
  })

  it('records failed bash typecheck as failed verification', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'type error', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ledger-tsc', name: 'bash', input: { command: 'npx tsc --noEmit' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(events.at(-1), {
      type: 'verification',
      command: 'npx tsc --noEmit',
      status: 'failed',
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0 },
    })
  })

  const noopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  it('denies tool calls matching a deny rule before execution', async () => {
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        permissions: {
          allow: [],
          deny: [{ tool: 'bash', params: { command: 'rm -rf*' } }],
          bash: { allowlist: [], denylist: [] },
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-deny', name: 'bash', input: { command: 'rm -rf /tmp' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal((result.toolResult as any).is_error, true)
    assert.ok((result.toolResult as any).content.includes('denied'))
  })

  it('R2: blocks write_file when another session holds an exclusive claim (fail-closed)', async () => {
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, _path: string, _type: string) => false,
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    let resultMsg = ''
    const callbacks = {
      ...noopCallbacks,
      onToolResult: (_id: string, _name: string, content: string, isError?: boolean) => {
        if (isError) resultMsg = content
      },
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-w', name: 'write_file', input: { file_path: 'foo.ts', content: 'x' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal((result.toolResult as any).is_error, true, 'must be an error tool result')
    assert.equal(executed, false, 'harness must NOT execute the write when claim is contested')
    assert.match((result.toolResult as any).content as string, /另一个会话/)
    assert.match(resultMsg, /阻断/)
  })

  it('R2: allows write_file when the claim is uncontended (acquireClaim true)', async () => {
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, _path: string, _type: string) => true,
      checkClaim: () => null,
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: r.isError ?? false, retried: false } },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-w2', name: 'write_file', input: { file_path: 'foo.ts', content: 'x' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, true, 'uncontended write must reach the harness (not blocked)')
    assert.doesNotMatch((result.toolResult as any).content as string, /阻断/, 'must not be the R2 block message')
  })

  it('R2: blocks hash_edit when another session holds an exclusive claim (fail-closed)', async () => {
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, _path: string, _type: string) => false,
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-hash', name: 'hash_edit', input: { file_path: 'foo.ts', anchors: [], new_string: 'x' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal((result.toolResult as any).is_error, true, 'hash_edit must hit the same R2 guard as write_file')
    assert.equal(executed, false, 'harness must NOT execute the contested hash_edit')
    assert.match((result.toolResult as any).content as string, /另一个会话/)
  })

  it('R2: blocks apply_patch when another session claims a patch target (path parsed from diff)', async () => {
    const claimed: string[] = []
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, path: string, _type: string) => { claimed.push(path); return false },
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const diff = ['--- a/src/foo.ts', '+++ b/src/foo.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')
    const result = await executeToolUse(
      { id: 'tu-patch', name: 'apply_patch', input: { diff } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(claimed, ['src/foo.ts'], 'claim must target the path parsed from the diff header')
    assert.equal((result.toolResult as any).is_error, true, 'contested patch target must be blocked pre-write')
    assert.equal(executed, false, 'harness must NOT execute the contested apply_patch')
  })

  it('R2: apply_patch check_only is read-only — no claim, reaches the harness', async () => {
    let claims = 0
    let executed = false
    const fakeRegistry = {
      acquireClaim: () => { claims++; return true },
      checkClaim: () => null,
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: r.isError ?? false, retried: false } },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-patch-check', name: 'apply_patch', input: { diff: '--- a/x.ts\n+++ b/x.ts\n', check_only: true } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(claims, 0, 'check_only never writes — must not claim')
    assert.equal(executed, true)
  })

  it('R2: blocks contested ast_edit target; plan_close without apply never claims', async () => {
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, path: string, _type: string) => path !== 'src/renamed.ts',
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const blocked = await executeToolUse(
      { id: 'tu-ast', name: 'ast_edit', input: { paths: ['src/renamed.ts'], ops: [{ replace: 'x' }], dryRun: false } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal((blocked.toolResult as any).is_error, true, 'contested ast_edit target must be blocked pre-write')
    assert.equal(executed, false)

    let claims = 0
    const spyRegistry = {
      acquireClaim: () => { claims++; return true },
      checkClaim: () => null,
    }
    const deps2 = makeDeps({
      sessionRegistry: spyRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })
    await executeToolUse(
      { id: 'tu-plan', name: 'plan_close', input: { file_path: 'docs/plans/p.md' } },
      deps2, noopCallbacks as any, 1, false,
    )
    assert.equal(claims, 0, 'plan_close without apply must not pre-claim')
  })

  it('R2: ast_edit preview (no dryRun) never claims — default is read-only (ast-edit.ts:105)', async () => {
    const claimed: string[] = []
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, path: string, _type: string) => { claimed.push(path); return true },
      checkClaim: () => null,
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ast-preview', name: 'ast_edit', input: { paths: ['src/foo.ts'], ops: [{ replace: 'x' }] } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(claimed, [], 'ast_edit without dryRun is a preview — must not stake an exclusive claim')
    assert.equal(executed, true, 'a preview is not a write — the R2 guard must not intercept it')
  })

  it('R2: ast_edit singular `path` alias + dryRun:false claims the real write target', async () => {
    const claimed: string[] = []
    const fakeRegistry = {
      acquireClaim: (_sid: string, path: string, _type: string) => { claimed.push(path); return false },
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-ast-single', name: 'ast_edit', input: { path: 'src/bar.ts', ops: [{ replace: 'x' }], dryRun: false } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(claimed, ['src/bar.ts'], 'ast-edit.ts accepts singular `path` as a write target — the guard must too')
    assert.equal((result.toolResult as any).is_error, true)
  })

  it('R2: a refused multi-file patch releases the claims it already staked', async () => {
    const acquired: string[] = []
    const released: string[] = []
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, path: string, _type: string) => { acquired.push(path); return path !== 'src/b.ts' },
      releaseClaim: (_sid: string, path: string) => { released.push(path) },
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const diff = [
      '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,1 @@', '-a', '+b',
      '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1,1 +1,1 @@', '-a', '+b',
    ].join('\n')
    const result = await executeToolUse(
      { id: 'tu-patch-multi', name: 'apply_patch', input: { diff } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(acquired, ['src/a.ts', 'src/b.ts'], 'every target is checked before the write')
    assert.deepEqual(released, ['src/a.ts'], 'the staked a.ts claim must go back when the patch is refused')
    assert.equal(executed, false, 'harness must NOT execute the contested patch')
    assert.equal((result.toolResult as any).is_error, true)
  })

  it('executes a tool and returns result', async () => {
    const deps = makeDeps()
    const result = await executeToolUse(
      { id: 'tu-1', name: 'read_file', input: { file_path: 'test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal((result.toolResult as any).tool_use_id, 'tu-1')
    assert.equal((result.toolResult as any).content, 'ok\n── 观象（read_file）')
    assert.equal((result.toolResult as any).is_error, false)
    assert.equal(result.checkpointCreated, false)
  })

  it('traces grep input keys when pattern disappears during repair', async () => {
    const oldDebug = process.env.RIVET_DEBUG
    const oldToolInputDebug = process.env.RIVET_DEBUG_TOOL_INPUT
    const oldSessionDir = process.env.RIVET_SESSION_DIR
    const oldWarn = console.warn
    const traceDir = mkdtempSync(join(testTmp(), 'tool-input-trace-'))
    const warnings: string[] = []
    delete process.env.RIVET_DEBUG
    delete process.env.RIVET_DEBUG_TOOL_INPUT
    // getSessionDir reads RIVET_SESSION_DIR; without this the trace file
    // writes to ~/.rivet/sessions/<slug> instead of the temp dir.
    process.env.RIVET_SESSION_DIR = join(traceDir, '.rivet', 'sessions')
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const deps = makeDeps({
        config: {
          ...makeDeps().config,
          toolRegistry: {
            execute: async () => ({ content: 'Error: pattern is required (non-empty string)', isError: true }),
            get: () => ({
              definition: {
                input_schema: {
                  type: 'object',
                  properties: { pattern: { type: 'string' }, path: { type: 'string' }, context_lines: { type: 'integer' } },
                  required: ['pattern'],
                },
              },
              isConcurrencySafe: () => false,
            }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
        repairPipeline: {
          run: () => ({
            output: { path: 'src/bootstrap.ts', context_lines: 10 },
            telemetry: [{ pass: 'test', fixType: 'dropPattern', toolName: 'grep', timestamp: 1 }],
          }),
        } as any,
        cwd: traceDir,
      })

      await executeToolUse(
        { id: 'tu-grep-trace', name: 'grep', input: { pattern: 'switchAgentRuntime', path: 'src/bootstrap.ts', context_lines: 10 } },
        deps, noopCallbacks as any, 1, false,
      )
    } finally {
      console.warn = oldWarn
      if (oldDebug === undefined) delete process.env.RIVET_DEBUG
      else process.env.RIVET_DEBUG = oldDebug
      if (oldToolInputDebug === undefined) delete process.env.RIVET_DEBUG_TOOL_INPUT
      else process.env.RIVET_DEBUG_TOOL_INPUT = oldToolInputDebug
      if (oldSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = oldSessionDir
    }

    assert.deepEqual(warnings, [], 'natural grep trace must not write directly to terminal stderr')
    const tracePath = join(traceDir, '.rivet', 'sessions', 'test-session', 'tool-input-trace.jsonl')
    assert.equal(existsSync(tracePath), true)
    const trace = readFileSync(tracePath, 'utf8')
    assert.match(trace, /\[tool-input-trace\]/)
    assert.match(trace, /id=tu-grep-trace/)
    assert.match(trace, /name=grep/)
    assert.match(trace, /isError=true/)
    assert.match(trace, /beforeHook=\["context_lines","path","pattern"\]/)
    assert.match(trace, /afterHook=\["context_lines","path","pattern"\]/)
    assert.match(trace, /afterRepair=\["context_lines","path"\]/)
    rmSync(traceDir, { recursive: true, force: true })
  })

  it('calls onToolResult callback', async () => {
    const deps = makeDeps()
    let called = false
    const cb = { ...noopCallbacks, onToolResult: () => { called = true } }
    await executeToolUse(
      { id: 'tu-2', name: 'read_file', input: { file_path: 'x.ts' } },
      deps, cb as any, 1, false,
    )
    assert.ok(called)
  })

  it('records success in repairHintTracker on success', async () => {
    let successCalled = false
    const deps = makeDeps({
      repairHintTracker: { recordSuccess: () => { successCalled = true }, recordFailure: () => {} } as any,
    })
    await executeToolUse(
      { id: 'tu-3', name: 'read_file', input: { file_path: 'y.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.ok(successCalled)
  })

  it('truncates oversized successful tool results', async () => {
    const hugeContent = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        contextWindow: 10_000,
        toolRegistry: {
          execute: async () => ({ content: hugeContent, isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-5', name: 'read_file', input: { file_path: 'huge.txt' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.length < hugeContent.length)
    assert.ok(content.startsWith('HEAD_MARKER'))
    assert.ok(content.endsWith('── 观象（read_file）'))
    assert.match(content, /TAIL_MARKER/)
    assert.match(content, /\.\.\.\[truncated \d+ chars\]\.\.\./)
  })

  it('truncates oversized run_tests diagnosis results', async () => {
    const hugeContent = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        contextWindow: 10_000,
        toolRegistry: {
          execute: async () => ({ content: hugeContent, isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      repairPipeline: {
        run: (input: any) => ({
          output: input,
          telemetry: [{ pass: 'failure-classifier', kind: 'test_failure', suggestion: 'Run the focused failing test.' }],
        }),
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-6', name: 'run_tests', input: { command: 'npm test' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.length < hugeContent.length)
    assert.ok(content.startsWith('HEAD_MARKER'))
    assert.match(content, /\.\.\.\[truncated \d+ chars\]\.\.\./)
    assert.match(content, /TAIL_MARKER|Diagnosis:/)
  })

  it('blocks write tools in degraded reliability mode before approval', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      getReliabilityDecision: () => ({ mode: 'degraded', reason: 'resource pressure rising', blockedTools: ['bash_write'] }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }

    const result = await executeToolUse(
      { id: 'tu-degraded-write', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, false)
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content, /reliability mode: degraded/)
  })

  it('allows read-only tools in minimal reliability mode', async () => {
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'read', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      getReliabilityDecision: () => ({ mode: 'minimal', reason: 'memory pressure critical', blockedTools: ['bash'] }),
    })

    const result = await executeToolUse(
      { id: 'tu-minimal-read', name: 'read_file', input: { file_path: 'README.md' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('requires approval for risky bash writes (rm) when NO sandbox boundary is active (fail-closed)', async () => {
    // Without a kernel sandbox risky writes (rm/mv/git) could escape the workspace,
    // so the approval gate must stay closed even at high confidence.
    _setSandboxBackendForTest('none')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'removed', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    try {
      const result = await executeToolUse(
        { id: 'tu-bash-rm', name: 'bash', input: { command: 'rm out.txt' } },
        deps, callbacks as any, 1, false,
      )

      assert.equal(approvalCalls, 1)
      assert.equal(executed, false)
      assert.equal((result.toolResult as any).is_error, true)
      assert.match((result.toolResult as any).content, /requires explicit user approval/)
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('auto-approves safe bash writes (mkdir/touch/echo>) with NO sandbox in auto-safe mode', async () => {
    // Safe writes (mkdir/touch/cp/echo>file) auto-approve without sandbox in
    // auto-safe mode to avoid approval fatigue on Windows.
    _setSandboxBackendForTest('none')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    try {
      await executeToolUse(
        { id: 'tu-bash-mkdir', name: 'bash', input: { command: 'mkdir newdir' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 0, 'mkdir is a safe write — must not prompt in auto-safe')
      assert.equal(executed, true)
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('autonomy-first: bash writes do NOT require approval when a sandbox boundary is active', async () => {
    // The kernel boundary confines writes to the workspace and B2 rollback makes
    // them reversible, so an unattended run must not be interrupted for approval.
    _setSandboxBackendForTest('seatbelt')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    try {
      await executeToolUse(
        { id: 'tu-bash-write-sb', name: 'bash', input: { command: 'echo hello > out.txt' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 0, 'sandboxed bash write must not prompt for approval')
      assert.equal(executed, true, 'sandboxed bash write should execute')
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('lets explicit allowlist override bash write approval', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [{ tool: 'bash', params: { command: 'echo hello > out.txt' } }] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-bash-allow', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('dangerously-skip-permissions bypasses high-risk and bash-write approval prompts', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'dangerously-skip-permissions',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'reset', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.2, pressure: 0.9, confidence: 0.1, complexity: 0.9, freshness: 0.1, stability: 0.1 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-danger-skip', name: 'bash', input: { command: 'git reset --hard HEAD~1' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('computer_use js_eval / browser_adopt ride dangerously-skip-permissions — YOLO waives the unconditional gate', async () => {
    // 自治/完全访问 (YOLO) is the user's explicit opt-out of prompts: the
    // safety net is checkpoints + rollback, so even the arbitrary-JS /
    // endpoint-takeover surface executes without asking.
    for (const input of [
      { action: 'js_eval', app: 'Google Chrome', expression: '1+1' },
      { action: 'browser_adopt', endpoint: 'localhost:9222' },
    ]) {
      let approvalCalls = 0
      let executed = false
      const deps = makeDeps({
        config: {
          ...makeDeps().config,
          approvalMode: 'dangerously-skip-permissions',
          permissions: { allow: [] },
          toolRegistry: {
            execute: async () => { executed = true; return { content: 'ran', isError: false } },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => true,
            resolveName: (n: string) => n,
          },
        } as any,
      })
      const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

      const result = await executeToolUse(
        { id: `tu-cu-${input.action}`, name: 'computer_use', input },
        deps, callbacks as any, 1, false,
      )

      assert.equal(approvalCalls, 0, `${input.action} must NOT prompt in YOLO`)
      assert.equal(executed, true, `${input.action} must execute in YOLO`)
      assert.equal((result.toolResult as any).is_error, false)
    }
  })

  it('computer_use js_eval / browser_adopt still prompt in auto-safe — allow rules and sensorium confidence cannot waive the gate', async () => {
    // Outside YOLO the hard gate holds: arbitrary JS in the user's browser /
    // DevTools endpoint takeover can never ride allowlists or sensorium
    // auto-approve in supervised/default modes.
    for (const input of [
      { action: 'js_eval', app: 'Google Chrome', expression: '1+1' },
      { action: 'browser_adopt', endpoint: 'localhost:9222' },
    ]) {
      let approvalCalls = 0
      let executed = false
      const deps = makeDeps({
        config: {
          ...makeDeps().config,
          approvalMode: 'auto-safe',
          permissions: { allow: [{ tool: 'computer_use' }] },
          toolRegistry: {
            execute: async () => { executed = true; return { content: 'ran', isError: false } },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => true,
            resolveName: (n: string) => n,
          },
        } as any,
        getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
      })
      const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

      const result = await executeToolUse(
        { id: `tu-cu-safe-${input.action}`, name: 'computer_use', input },
        deps, callbacks as any, 1, false,
      )

      assert.equal(approvalCalls, 1, `${input.action} must prompt in auto-safe`)
      assert.equal(executed, false, `denied ${input.action} must not execute`)
      assert.equal((result.toolResult as any).is_error, true)
    }
  })

  it('computer_use non-privileged actions still ride dangerously-skip-permissions', async () => {
    // The unconditional gate is scoped to js_eval/browser_adopt — snapshot etc.
    // keep the normal mode semantics.
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'dangerously-skip-permissions',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'snap', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-cu-snapshot', name: 'computer_use', input: { action: 'snapshot', app: 'Google Chrome' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('out-of-workspace write_file forces an approval prompt even in auto-safe, and records a grant on approval', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    const external = mkdtempSync(join(testTmp(), 'rivet-ext-'))
    const target = join(external, 'out.txt')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      cwd: workspace,
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    try {
      const result = await executeToolUse(
        { id: 'tu-oow-write', name: 'write_file', input: { file_path: target, content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 1, 'out-of-workspace write must prompt despite auto-safe')
      assert.equal(executed, true, 'op proceeds after approval')
      assert.equal((result.toolResult as any).is_error, false)
      assert.equal(isWriteGranted(target), true, 'subtree grant recorded on approval')
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denying the out-of-workspace prompt blocks the op and records no grant', async () => {
    _resetGrantsForTest()
    const external = mkdtempSync(join(testTmp(), 'rivet-ext-'))
    const target = join(external, 'out.txt')
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => false }
    try {
      const result = await executeToolUse(
        { id: 'tu-oow-deny', name: 'write_file', input: { file_path: target, content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(executed, false)
      assert.equal((result.toolResult as any).is_error, true)
      assert.match((result.toolResult as any).content, /requires explicit user approval/)
      assert.equal(isWriteGranted(target), false, 'no grant on denial')
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('safe bash writes with out-of-workspace targets do NOT auto-approve in no-sandbox auto-safe (H6)', async () => {
    // `echo key >> ~/.ssh/authorized_keys` / `cp payload D:\x\b` 以前经 SAFE_WRITE_PATTERNS
    // 零提示执行——写目标在 cwd 外时必须回到人工审批。
    _setSandboxBackendForTest('none')
    const cases: Array<{ command: string; label: string }> = [
      { command: 'echo ssh-key >> ~/.ssh/authorized_keys', label: 'tilde redirect target' },
      { command: 'cp payload D:\\x\\b.exe', label: 'drive-letter cp target' },
      { command: 'mkdir /usr/local/share/x', label: 'POSIX-absolute mkdir target' },
    ]
    try {
      for (const { command, label } of cases) {
        let approvalCalls = 0
        let executed = false
        const deps = makeDeps({
          config: {
            ...makeDeps().config,
            approvalMode: 'auto-safe',
            permissions: { allow: [] },
            toolRegistry: {
              execute: async () => { executed = true; return { content: 'ok', isError: false } },
              get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
              needsApproval: () => false,
              resolveName: (n: string) => n,
            },
          } as any,
        })
        const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }
        const result = await executeToolUse(
          { id: 'tu-bash-oow', name: 'bash', input: { command } },
          deps, callbacks as any, 1, false,
        )
        assert.equal(approvalCalls, 1, `${label} must prompt despite safe-write pattern`)
        assert.equal(executed, false, `${label} must not execute without approval`)
        assert.equal((result.toolResult as any).is_error, true)
      }
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('in-workspace safe bash writes still auto-approve (no approval fatigue regression)', async () => {
    _setSandboxBackendForTest('none')
    let approvalCalls = 0
    let executed = 0
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed++; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }
    try {
      for (const command of ['echo hi > out.txt', 'npm install', 'mkdir src/new']) {
        await executeToolUse(
          { id: 'tu-bash-iw', name: 'bash', input: { command } },
          deps, callbacks as any, 1, false,
        )
      }
      assert.equal(approvalCalls, 0, 'in-workspace safe writes must stay auto-approved')
      assert.equal(executed, 3)
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('export_file with out-of-workspace destination routes through the approval flow in auto-safe (M7)', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    const external = mkdtempSync(join(testTmp(), 'rivet-ext-'))
    const dest = join(external, 'logo.svg')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      cwd: workspace,
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'exported', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    try {
      const result = await executeToolUse(
        { id: 'tu-export-oow', name: 'export_file', input: { destination_path: dest, content: '<svg/>' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 1, 'out-of-workspace export must prompt despite auto-safe')
      assert.equal(executed, true, 'op proceeds after approval')
      assert.equal((result.toolResult as any).is_error, false)
      assert.equal(isWriteGranted(dest), true, 'write grant recorded on approval')
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('ast_edit with out-of-workspace paths routes through the approval flow instead of hard-failing (M7)', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    const external = mkdtempSync(join(testTmp(), 'rivet-ext-'))
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      cwd: workspace,
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'edited', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    try {
      const result = await executeToolUse(
        { id: 'tu-ast-oow', name: 'ast_edit', input: { paths: [join(external, 'x.ts')], rule: { pattern: 'x' } } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 1, 'out-of-workspace ast_edit must prompt')
      assert.equal(executed, true)
      assert.equal((result.toolResult as any).is_error, false)
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('open_path / create_document out-of-workspace targets route through the approval flow (M7)', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    const external = mkdtempSync(join(testTmp(), 'rivet-ext-'))
    try {
      const calls: Record<string, number> = { open_path: 0, create_document: 0 }
      const deps = makeDeps({
        cwd: workspace,
        config: {
          ...makeDeps().config,
          approvalMode: 'auto-safe',
          permissions: { allow: [] },
          toolRegistry: {
            execute: async () => ({ content: 'ok', isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })
      const callbacks = {
        ...noopCallbacks,
        onApprovalRequired: async (_id: string, name: string) => { calls[name] = (calls[name] ?? 0) + 1; return true },
      }
      await executeToolUse(
        { id: 'tu-open-oow', name: 'open_path', input: { path: join(external, 'report.pdf') } },
        deps, callbacks as any, 1, false,
      )
      await executeToolUse(
        { id: 'tu-credoc-oow', name: 'create_document', input: { destination_path: join(external, 'notes.md'), content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(calls['open_path'], 1, 'out-of-workspace open_path must prompt')
      assert.equal(calls['create_document'], 1, 'out-of-workspace create_document must prompt')
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('export_file tilde destinations expand to home and route through approval (no lexical-cwd laundering)', async () => {
    // `~/x` 若不展开，resolve(cwd, '~/x') 会词法落进工作区而绕过门禁——路由必须与
    // execute 侧同做 expandHome。
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    let approvalCalls = 0
    const deps = makeDeps({
      cwd: workspace,
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => ({ content: 'exported', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    try {
      await executeToolUse(
        { id: 'tu-export-tilde', name: 'export_file', input: { destination_path: '~/rivet-test-export-oow.svg', content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 1, 'tilde destination must prompt (expands outside cwd)')
    } finally {
      _resetGrantsForTest()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('in-workspace export_file destination does not route through the path-grant flow', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      cwd: workspace,
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'exported', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }
    try {
      await executeToolUse(
        { id: 'tu-export-iw', name: 'export_file', input: { destination_path: join(workspace, 'assets', 'out.svg'), content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 0, 'in-workspace export destination needs no path grant')
      assert.equal(executed, true)
    } finally {
      _resetGrantsForTest()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('approval with remember=true persists the grant per-workspace; without remember it stays session-only', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(testTmp(), 'rivet-ws-'))
    const external = mkdtempSync(join(testTmp(), 'rivet-ext-'))
    const external2 = mkdtempSync(join(testTmp(), 'rivet-ext2-'))
    try {
      // ── remember=true：授权经 resolved.remember 落盘，模拟新会话重载后仍在 ──
      const target = join(external, 'out.txt')
      let approved = 0
      const deps = makeDeps({
        cwd: workspace,
        config: {
          ...makeDeps().config,
          approvalMode: 'manual',
          permissions: { allow: [] },
          toolRegistry: {
            execute: async () => ({ content: 'wrote', isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => true,
            resolveName: (n: string) => n,
          },
        } as any,
      })
      const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approved++; return { approved: true, remember: true } } }
      const result = await executeToolUse(
        { id: 'tu-rem', name: 'write_file', input: { file_path: target, content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approved, 1, 'out-of-workspace write must prompt')
      assert.equal((result.toolResult as any).is_error, false)

      // 模拟新会话：清内存后从 per-workspace store 回灌——remembered grant 必须复活
      _resetGrantsForTest()
      loadPersistedGrants(workspace)
      assert.equal(isWriteGranted(target), true, 'remembered grant must hydrate from the per-workspace store')

      // ── remember 缺省：仅本会话生效，重载后消失（用独立目录，避免与上一步的
      //    持久化授权同根——那会让磁盘上的 external 授权误覆盖本断言）──
      _resetGrantsForTest()
      const target2 = join(external2, 'out2.txt')
      const callbacks2 = { ...noopCallbacks, onApprovalRequired: async () => { approved++; return { approved: true } } }
      await executeToolUse(
        { id: 'tu-norem', name: 'write_file', input: { file_path: target2, content: 'x' } },
        deps, callbacks2 as any, 1, false,
      )
      assert.equal(isWriteGranted(target2), true, 'session grant active in-process')
      _resetGrantsForTest()
      loadPersistedGrants(workspace)
      assert.equal(isWriteGranted(target2), false, 'un-remembered grant must not hydrate from disk')
      assert.equal(isWriteGranted(target), true, 'remembered grant still hydrates alongside')
    } finally {
      _resetGrantsForTest()
      // 清掉 store 文件里的授权条目，并彻底删除文件本身——避免测试残留真实
      // ~/.rivet 下的 grants 文件（既有测试已累积 600+ 个此类残骸，不再添新）。
      revokeGrant(external, { cwd: workspace })
      revokeGrant(external2, { cwd: workspace })
      const slug = resolvePath(workspace).replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
      rmSync(join(rivetHome(), `path-grants-${slug}.json`), { force: true })
      for (const d of [workspace, external, external2]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('in-workspace read_file does not trigger the out-of-workspace gate', async () => {
    _resetGrantsForTest()
    let approvalCalls = 0
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    await executeToolUse(
      { id: 'tu-inws-read', name: 'read_file', input: { file_path: 'src/file.ts' } },
      deps, callbacks as any, 1, false,
    )
    assert.equal(approvalCalls, 0, 'in-workspace read must not prompt')
    _resetGrantsForTest()
  })

  it('denied approval returns an instructive non-retry message and records a fingerprint', async () => {
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'manual',
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => false }
    const result = await executeToolUse(
      { id: 'tu-deny-edit', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      deps, callbacks as any, 1, false,
    )
    const content = (result.toolResult as any).content as string
    assert.equal((result.toolResult as any).is_error, true)
    assert.match(content, /requires explicit user approval/)
    assert.match(content, /Do NOT re-emit/)
    assert.match(content, /edit_file/)
    assert.match(content, /src\/foo\.ts/)
    // Fingerprint recorded so the doom-loop detector can see repeated denials
    // (denied calls short-circuit before the post-exec recorder at the bottom).
    const expectedFp = fingerprintToolCall('edit_file', { file_path: 'src/foo.ts' }, 'error')
    assert.ok(result.traceStore.toolFingerprints.includes(expectedFp), 'denied call fingerprint recorded')
  })

  it('headless: auto-approves in-workspace file writes without prompting', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        headless: true,
        approvalMode: 'manual',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }
    const result = await executeToolUse(
      { id: 'tu-headless-write', name: 'write_file', input: { file_path: 'src/foo.ts', content: 'x' } },
      deps, callbacks as any, 1, false,
    )
    assert.equal(approvalCalls, 0, 'headless must not prompt for an in-workspace file write')
    assert.equal(executed, true, 'the write proceeds (worktree/claim isolation, diff reviewed by primary)')
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('headless: fast-denies other approval-required tools with a model-facing message (no hang)', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        headless: true,
        approvalMode: 'manual',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'ran', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    // onApprovalRequired mirrors the worker's rejecting callback — must NOT hang.
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }
    const result = await executeToolUse(
      { id: 'tu-headless-deny', name: 'some_gated_tool', input: {} },
      deps, callbacks as any, 1, false,
    )
    assert.equal(executed, false, 'gated non-write tool must not execute')
    const content = (result.toolResult as any).content as string
    assert.equal((result.toolResult as any).is_error, true)
    assert.match(content, /not available in a headless worker/, 'carries the stable headless deny marker')
    assert.match(content, /status "blocked"/, 'instructs the worker to report blocked instead of stalling')
  })

  it('manual-mode approval of edit_file learns a file-scoped allow so the same file is not re-prompted', async () => {
    let approvalCalls = 0
    const overlay = createPermissionOverlay()
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'manual',
        permissionsOverlay: overlay,
        toolRegistry: {
          execute: async () => ({ content: 'edited', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    await executeToolUse(
      { id: 'tu-edit-1', name: 'edit_file', input: { file_path: 'src/bar.ts' } },
      deps, callbacks as any, 1, false,
    )
    assert.equal(approvalCalls, 1, 'first edit prompts')
    assert.ok(
      overlay.allow.some(r => r.tool === 'edit_file' && r.params?.file_path === 'src/bar.ts'),
      'file-scoped allow learned after approval',
    )
    await executeToolUse(
      { id: 'tu-edit-2', name: 'edit_file', input: { file_path: 'src/bar.ts' } },
      deps, callbacks as any, 1, false,
    )
    assert.equal(approvalCalls, 1, 'same file must not re-prompt after learning')
  })

  it('P1.3: strips trailing whitespace from tool result content', async () => {
    const deps = makeDeps()
    // Override tool registry to return content with trailing whitespace.
    // bash → star sig "── 执令（bash）" is appended at the end, so the
    // raw content (before star sig) must not end with whitespace.
    ;(deps.config as any).toolRegistry.execute = async () => ({
      content: 'hello world  \t\n\n',
      isError: false,
    })
    const result = await executeToolUse(
      { id: 'tu-norm', name: 'bash', input: { command: 'echo hello' } },
      deps, noopCallbacks as any, 1, false,
    )
    const fullContent = (result.toolResult as any).content as string
    // Strip the star signature suffix to get the raw content
    const starSig = '\n── 执令（bash）'
    const rawContent = fullContent.endsWith(starSig)
      ? fullContent.slice(0, -starSig.length)
      : fullContent
    // Raw content (before star sig) must not end with whitespace
    assert.ok(!/\s$/.test(rawContent),
      `raw content must not end with whitespace, got: ${JSON.stringify(rawContent)}`)
    // Must still contain the payload
    assert.ok(rawContent.includes('hello world'),
      'tool result must still contain the payload')
  })

  describe('doom-loop blocked gate (deadlock fix)', () => {
    const cb = { onToolResult: () => {}, onApprovalRequired: async () => false } as any
    // A fingerprint window where read_file('looping.ts','error') repeats to the
    // blocking threshold — that exact call is the offender.
    function loopingTraceStore() {
      const offenderFp = fingerprintToolCall('read_file', { file_path: 'looping.ts' }, 'error')
      return { events: [], toolFingerprints: Array(6).fill(offenderFp), bashClassFingerprints: [] } as any
    }

    it('blocks the offending call when doomLevel is blocked', async () => {
      const deps = makeDeps({ getDoomLoopLevel: () => 'blocked' as const, traceStore: loopingTraceStore() })
      const result = await executeToolUse(
        { id: 'tu-offend', name: 'read_file', input: { file_path: 'looping.ts' } },
        deps, cb, 1, false,
      )
      assert.equal((result.toolResult as any).is_error, true)
      assert.ok(((result.toolResult as any).content as string).includes('Recovery: try a different tool'))
    })

    it('lets a DIFFERENT tool through under blocked — the deadlock fix', async () => {
      // Before the fix this returned is_error with "Repeated identical failures";
      // now a non-offending call executes normally so the window can refresh.
      let executed = false
      const deps = makeDeps({
        getDoomLoopLevel: () => 'blocked' as const,
        traceStore: loopingTraceStore(),
        config: {
          ...makeDeps().config,
          toolRegistry: {
            execute: async () => { executed = true; return { content: 'todo updated', isError: false } },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })
      const result = await executeToolUse(
        { id: 'tu-different', name: 'todo', input: { action: 'list' } },
        deps, cb, 1, false,
      )
      assert.equal(executed, true, 'different tool must actually execute under blocked')
      assert.notEqual((result.toolResult as any).is_error, true)
    })

    it('lets the same tool with DIFFERENT input through under blocked', async () => {
      let executed = false
      const deps = makeDeps({
        getDoomLoopLevel: () => 'blocked' as const,
        traceStore: loopingTraceStore(),
        config: {
          ...makeDeps().config,
          toolRegistry: {
            execute: async () => { executed = true; return { content: 'file body', isError: false } },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })
      const result = await executeToolUse(
        { id: 'tu-diff-input', name: 'read_file', input: { file_path: 'other.ts' } },
        deps, cb, 1, false,
      )
      assert.equal(executed, true, 'same tool / different target must execute under blocked')
      assert.notEqual((result.toolResult as any).is_error, true)
    })
  })

  it('skip 档出界路径首触即授——未读过的出界路径写操作当场授予（零审批打扰）', async () => {
    // 唯一路径：进程内 grant store 会话级累积，避免跨测试污染
    _resetGrantsForTest()
    const target = `/opt/rivet-skip-grant-probe/${Date.now()}/file.txt`
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'dangerously-skip-permissions',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
          resolveName: (n: string) => n,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { throw new Error('skip 档不得触发审批') } }

    const result = await executeToolUse(
      { id: 'tu-skip-firstwrite', name: 'write_file', input: { file_path: target, content: 'x' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
    assert.ok(isWriteGranted(target), '写授权应当场授予（旧行为要求先读过才升级，未读先写要多花一轮）')
    _resetGrantsForTest()
  })
})

// ── Artifact Intercept 端到端验证 ──────────────────────────────────────
// 验证 delegate_batch worker 内部 pipeline 的 artifactIntercept 行为：
// 1. 大输出非 read 工具 → 被拦截并持久化到磁盘
// 2. 返回内容变为 [artifact:ID] 摘要引用
// 3. read_file/read_section 不被拦截（模型的眼睛）；grep/glob/bash 等搜索工具在 3x 阈值下可拦截
// 4. 两个独立 ArtifactStore 实例互不干扰（worker 隔离）

describe('artifactIntercept in tool pipeline', () => {
  let tempDir: string
  let store: ArtifactStore

  function setup() {
    tempDir = mkdtempSync(join(testTmp(), 'rivet-artifact-test-'))
    store = new ArtifactStore(tempDir, 'test-session')
  }

  function cleanup() {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  function makeDepsWithStore(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'test-model' },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      artifactStore: store,
      ...overrides,
    }
  }

  const noopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  it('intercepts large non-read tool output and persists to disk', async () => {
    setup()
    try {
      // 10000 chars — must exceed effective threshold.
      // With turnBudget.maxTokensPerTurn=0, remainingBudgetFraction defaults to 1,
      // triggering 3x scaling: 2500 * 3 = 7500. So 10000 > 7500.
      const largeOutput = 'A'.repeat(10000)
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-artifact-1', name: 'run_tests', input: { command: 'npm test' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // Must be replaced with artifact reference
      assert.ok(content.startsWith('[artifact:'),
        `expected artifact reference, got: ${content.slice(0, 100)}`)
      assert.ok(content.includes('Use read_section'),
        'artifact ref should include read_section hint')
      // Must NOT contain the original large output
      assert.ok(!content.includes('AAAAA'),
        'original large output should not be inline')

      // Verify artifact was persisted to disk
      const artifacts = store.list()
      assert.equal(artifacts.length, 1, 'should have one artifact')
      const art = artifacts[0]!
      assert.equal(art.tool, 'run_tests')
      assert.equal(art.charCount, 10000)
      assert.ok(existsSync(art.rawPath), `artifact raw file should exist at ${art.rawPath}`)
      const diskContent = readFileSync(art.rawPath, 'utf-8')
      assert.equal(diskContent, largeOutput, 'disk content should match original output')
    } finally {
      cleanup()
    }
  })

  it('does NOT re-wrap grep output already carrying a trailing artifact ref (L0→L1 double-save)', async () => {
    setup()
    try {
      // Simulate an L0-wrapped grep result: large inline body + trailing [artifact:] marker.
      // 40000 chars exceeds the budget-scaled READ threshold (2500*3*3=22500 when
      // remainingBudgetFraction=1), so the current startsWith check would re-save.
      const l0Wrapped =
        'G'.repeat(40000) +
        '\n\nmatches summary\nUse read_section(artifactId="preexisting-l0", section="L1-L200") to expand.\n[artifact:preexisting-l0]'
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: l0Wrapped, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-grep-double', name: 'grep', input: { pattern: 'x' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // L1 must NOT create a new artifact for an already-wrapped result.
      assert.equal(store.list().length, 0,
        'L1 must not double-save a grep result that already carries a trailing artifact ref')
      // The original L0 artifact ref must survive untouched.
      assert.ok(content.includes('[artifact:preexisting-l0]'),
        'original L0 artifact ref must survive')
    } finally {
      cleanup()
    }
  })

  it('does NOT intercept read_file output (read-class tool bypass)', async () => {
    setup()
    try {
      const largeOutput = 'B'.repeat(5000)
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-read-bypass', name: 'read_file', input: { file_path: 'big.ts' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // read_file should NOT be intercepted — content stays inline
      // (may be truncated by truncateSuccessfulToolResult, but not wrapped in [artifact:])
      assert.ok(!content.startsWith('[artifact:'),
        `read_file should not be artifact-intercepted, got: ${content.slice(0, 100)}`)

      // No artifacts should be created
      assert.equal(store.list().length, 0, 'read_file should not create artifacts')
    } finally {
      cleanup()
    }
  })

  it('delivers a large skill body COMPLETE and inline (fidelity-exempt, no artifact, no truncation)', async () => {
    setup()
    try {
      // 20000 chars — well above the 7500 effective artifact threshold, so a
      // non-exempt tool (see run_tests test above) would be summarized to an
      // [artifact:...] ref. The skill tool must NOT: it loads instructions the
      // model will follow verbatim, so the body must arrive whole.
      const skillBody = `<skill name="huge">\n${'Z'.repeat(20000)}\n</skill>`
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: skillBody, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-skill-fidelity', name: 'skill', input: { name: 'huge' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.startsWith('[artifact:'),
        `skill output must not be artifact-intercepted, got: ${content.slice(0, 100)}`)
      assert.ok(!content.includes('[truncated'),
        'skill output must not be head/tail truncated')
      assert.ok(!content.includes('<stored '),
        'skill output must not be collapsed to a budget preview')
      // The ENTIRE body survives intact.
      assert.ok(content.includes('Z'.repeat(20000)),
        'full skill body must be present inline')
      assert.equal(store.list().length, 0, 'skill should not create artifacts')
    } finally {
      cleanup()
    }
  })

  it('does NOT intercept small non-read tool output below threshold', async () => {
    setup()
    try {
      const smallOutput = 'C'.repeat(500) // well below 2500-char threshold
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: smallOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-small', name: 'bash', input: { command: 'echo hello' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.startsWith('[artifact:'),
        'small output should not be artifact-intercepted')
      assert.equal(store.list().length, 0, 'small output should not create artifacts')
    } finally {
      cleanup()
    }
  })

  it('intercepts large error output from non-read tool', async () => {
    setup()
    try {
      const largeError = 'Error: something went wrong\n'.repeat(200) // ~6000 chars
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeError, isError: true }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-error-artifact', name: 'run_tests', input: { command: 'npm test' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // Error output above threshold should be artifact-intercepted
      assert.ok(content.startsWith('[artifact:'),
        `expected artifact reference for large error, got: ${content.slice(0, 100)}`)
      // Error artifacts include an excerpt for debugging
      assert.ok(content.includes('Error'),
        'error artifact should include error excerpt')

      const artifacts = store.list()
      assert.equal(artifacts.length, 1)
      assert.ok(existsSync(artifacts[0]!.rawPath))
    } finally {
      cleanup()
    }
  })

  it('does NOT intercept read-only bash commands (cat, grep, git log)', async () => {
    setup()
    try {
      const largeOutput = 'D'.repeat(5000)
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-bash-read', name: 'bash', input: { command: 'cat /tmp/big.txt' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.startsWith('[artifact:'),
        'read-only bash (cat) should not be artifact-intercepted')
      assert.equal(store.list().length, 0)
    } finally {
      cleanup()
    }
  })

  it('two ArtifactStore instances are isolated (worker independence)', async () => {
    const dir1 = mkdtempSync(join(testTmp(), 'rivet-worker-a-'))
    const dir2 = mkdtempSync(join(testTmp(), 'rivet-worker-b-'))
    try {
      const storeA = new ArtifactStore(dir1, 'worker-a')
      const storeB = new ArtifactStore(dir2, 'worker-b')

      // Save artifact in store A
      const idA = await storeA.save({
        tool: 'run_tests',
        target: 'npm test',
        rawContent: 'A'.repeat(5000),
        summary: 'test output A',
        sections: [],
      })

      // Save different artifact in store B
      const idB = await storeB.save({
        tool: 'bash',
        target: 'echo hello',
        rawContent: 'B'.repeat(3000),
        summary: 'test output B',
        sections: [],
      })

      // Verify isolation: store A only has A's artifact
      assert.equal(storeA.list().length, 1)
      assert.equal(storeA.list()[0]!.id, idA)
      assert.equal(storeA.list()[0]!.tool, 'run_tests')

      // Verify isolation: store B only has B's artifact
      assert.equal(storeB.list().length, 1)
      assert.equal(storeB.list()[0]!.id, idB)
      assert.equal(storeB.list()[0]!.tool, 'bash')

      // Cross-store lookups return null
      assert.equal(storeA.get(idB), null, 'store A should not find store B artifact')
      assert.equal(storeB.get(idA), null, 'store B should not find store A artifact')

      // Disk paths are in separate directories
      assert.ok(storeA.list()[0]!.rawPath.startsWith(dir1))
      assert.ok(storeB.list()[0]!.rawPath.startsWith(dir2))

      // Verify disk files are independent
      const contentA = await storeA.readRaw(idA)
      assert.equal(contentA!.length, 5000)
      const contentB = await storeB.readRaw(idB)
      assert.equal(contentB!.length, 3000)
    } finally {
      try { rmSync(dir1, { recursive: true, force: true }) } catch { /* */ }
      try { rmSync(dir2, { recursive: true, force: true }) } catch { /* */ }
    }
  })

  it('delegate_batch scenario: two workers with independent artifact stores', async () => {
    // Simulates the delegate_batch end-to-end scenario:
    // Worker 1 (code_scout) produces large output → artifact intercepted
    // Worker 2 (reviewer) produces large output → artifact intercepted
    // Each worker has its own ArtifactStore, artifacts don't leak across stores
    const dir1 = mkdtempSync(join(testTmp(), 'rivet-batch-w1-'))
    const dir2 = mkdtempSync(join(testTmp(), 'rivet-batch-w2-'))
    try {
      const store1 = new ArtifactStore(dir1, 'worker-wo_1')
      const store2 = new ArtifactStore(dir2, 'worker-wo_2')

      const largeOutput1 = 'Worker1 findings: '.repeat(600) // ~10800 chars (>7500 effective threshold)
      const largeOutput2 = 'Worker2 review: '.repeat(600) // ~9600 chars

      // Worker 1: inspect_project tool with large output (no L0 wrap → L1 intercepts)
      const deps1 = makeDepsWithStore({
        artifactStore: store1,
        config: {
          ...makeDepsWithStore().config,
          sessionId: 'worker-wo_1',
          toolRegistry: {
            execute: async () => ({ content: largeOutput1, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
        sessionId: 'worker-wo_1',
      })

      // Worker 2: run_tests tool with large output
      const deps2 = makeDepsWithStore({
        artifactStore: store2,
        config: {
          ...makeDepsWithStore().config,
          sessionId: 'worker-wo_2',
          toolRegistry: {
            execute: async () => ({ content: largeOutput2, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          resolveName: (n: string) => n,
          },
        } as any,
        sessionId: 'worker-wo_2',
      })

      // Execute both workers
      const result1 = await executeToolUse(
        { id: 'tu-w1', name: 'inspect_project', input: {} },
        deps1, noopCallbacks as any, 1, false,
      )
      const result2 = await executeToolUse(
        { id: 'tu-w2', name: 'run_tests', input: { command: 'npm test' } },
        deps2, noopCallbacks as any, 1, false,
      )

      // Both should be artifact-intercepted
      const content1 = (result1.toolResult as any).content as string
      const content2 = (result2.toolResult as any).content as string
      assert.ok(content1.startsWith('[artifact:'), 'worker 1 output should be artifact-ref')
      assert.ok(content2.startsWith('[artifact:'), 'worker 2 output should be artifact-ref')

      // Verify isolation: each store has exactly one artifact
      assert.equal(store1.list().length, 1, 'store 1 should have 1 artifact')
      assert.equal(store2.list().length, 1, 'store 2 should have 1 artifact')

      // Artifact IDs are different
      const id1 = store1.list()[0]!.id
      const id2 = store2.list()[0]!.id
      assert.notEqual(id1, id2, 'artifact IDs should be different across workers')

      // Cross-store isolation
      assert.equal(store1.get(id2), null, 'store 1 should not find store 2 artifact')
      assert.equal(store2.get(id1), null, 'store 2 should not find store 1 artifact')

      // Disk files are in separate directories
      assert.ok(existsSync(store1.list()[0]!.rawPath))
      assert.ok(existsSync(store2.list()[0]!.rawPath))
      assert.ok(store1.list()[0]!.rawPath.startsWith(dir1))
      assert.ok(store2.list()[0]!.rawPath.startsWith(dir2))
    } finally {
      try { rmSync(dir1, { recursive: true, force: true }) } catch { /* */ }
      try { rmSync(dir2, { recursive: true, force: true }) } catch { /* */ }
    }
  })
})

// ─── Phase-aware prediction recording (TDD RED fix) ──

describe('phase-aware prediction recording', () => {
  function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'test output', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'test-model' },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      ...overrides,
    }
  }

  const noopCallbacks = { onWrite: () => {}, onRead: () => {}, onBash: () => {}, onEdit: () => {}, onToolResult: () => {}, onApprovalRequired: async () => true }

  it('does NOT record prediction for run_tests failure in verify phase (TDD RED)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'verify',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '1 test failed', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-tdd-red', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, undefined, 'TDD RED in verify phase should NOT record prediction')
  })

  it('DOES record prediction for run_tests failure in execute phase (real bug)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'execute',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '1 test failed', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-bug-red', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, false, 'run_tests failure in execute phase should record as prediction error')
  })

  it('DOES record prediction for non-run_tests failure regardless of phase', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'verify',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'file not found', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-read-fail', name: 'read_file', input: { file_path: 'nonexistent' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, false, 'non-run_tests failures always record prediction')
  })

  it('does NOT record prediction for environment-class failure (Windows command-not-found)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'execute',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: "命令未找到：'python'", isError: true, errorClass: 'environment' }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-env-red', name: 'bash', input: { command: 'python --version' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, undefined, 'environment-class failure must NOT erode momentum (信念) via prediction')
  })

  it('threads errorClass through to recordToolHistory', async () => {
    let captured: string | undefined = 'unset'
    const deps = makeDeps({
      phaseHint: 'execute',
      recordToolHistory: (_n: any, _i: any, _e: any, _c: any, errorClass?: string) => { captured = errorClass },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '命令未找到', isError: true, errorClass: 'environment' }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-env-hist', name: 'bash', input: { command: 'python' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(captured, 'environment', 'recordToolHistory must receive errorClass for immune neutralisation')
  })

  it('threads errorKind through to recordToolHistory (transient 判定走结构化管道)', async () => {
    let captured: string | undefined = 'unset'
    const deps = makeDeps({
      phaseHint: 'execute',
      recordToolHistory: (...args: unknown[]) => { captured = args[5] as string | undefined },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '语法检查失败，已自动回滚', isError: true, errorKind: 'syntax_error' }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-kind-hist', name: 'edit_file', input: { file_path: 'a.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(captured, 'syntax_error', 'recordToolHistory 必须收到 errorKind——transient 不再按结果子串匹配')
  })

  it('DOES record prediction for run_tests success in verify phase (TDD GREEN)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'verify',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'all tests passed', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-tdd-green', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, true, 'run_tests success in verify phase should record as correct prediction')
  })

  it('phaseHint defaults to execute — verify exemption does NOT trigger', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      // phaseHint NOT set — should default to 'execute'
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '1 test failed', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-no-phase', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, false, 'without phaseHint, run_tests failure records as prediction error')
  })
})

describe('deliver_task abort — post-abort commit attribution', () => {
  function makeDeps(cwd: string, overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'test-model' },
      } as any,
      cwd,
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      ...overrides,
    }
  }

  const noopCallbacks = { onToolResult: () => {}, onApprovalRequired: async () => true }

  function initRepo(): string {
    const dir = mkdtempSync(join(testTmp(), 'abort-commit-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'initial')
    return dir
  }

  function abortError(): Error {
    const e = new Error('aborted')
    e.name = 'AbortError'
    return e
  }

  it('reports the landed commit when deliver_task is aborted AFTER committing', async () => {
    const dir = initRepo()
    try {
      const deps = makeDeps(dir, {
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => {
              // Simulate the 50073c39 incident: the commit lands, THEN the call is cancelled.
              execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'fix: landed before cancel'], { cwd: dir })
              throw abortError()
            },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-abort-landed', name: 'deliver_task', input: {} },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(content.includes('[interrupted]'), 'must still carry the interrupted marker')
      assert.ok(content.includes('commit already landed'), `must state the commit landed, got: ${content}`)
      assert.ok(content.includes('fix: landed before cancel'), 'must include the commit subject')
      assert.ok(content.includes('Do NOT re-commit'), 'must instruct against retrying')
      assert.equal((result.toolResult as any).is_error, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports HEAD unchanged when deliver_task is aborted BEFORE committing', async () => {
    const dir = initRepo()
    try {
      const deps = makeDeps(dir, {
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => { throw abortError() },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-abort-clean', name: 'deliver_task', input: {} },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(content.includes('no new commit has landed'), `must state no commit landed, got: ${content}`)
      assert.ok(content.includes('may still complete in the background'), 'must keep the background caveat')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('probe failure (unusable cwd) falls back to the generic interrupted note', async () => {
    // A nonexistent cwd makes both git probes fail → preAbortHead stays null →
    // the enriched note must not be attempted and the generic note survives.
    const dir = join(testTmp(), 'abort-missing-dir-does-not-exist')
    const deps = makeDeps(dir, {
      config: {
        ...makeDeps(dir).config,
        toolRegistry: {
          execute: async () => { throw abortError() },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-abort-nogit', name: 'deliver_task', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.includes('[interrupted] deliver_task was cancelled'), 'generic note preserved')
    assert.ok(content.includes('verify actual state'), 'generic verification guidance preserved')
  })

  it('other tools keep the generic interrupted note (no git probe)', async () => {
    const dir = initRepo()
    try {
      const deps = makeDeps(dir, {
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => { throw abortError() },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-abort-bash', name: 'bash', input: { command: 'echo hi' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(content.includes('[interrupted] bash was cancelled'), 'generic note for non-deliver tools')
      assert.ok(!content.includes('commit already landed'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 240s 事故链 (2026-07-07): a pipeline TIMEOUT (non-abort error) used to
  // replace the entire deliver_task result with a bare error — the model never
  // learned the commit had landed and re-committed / bypassed the tool.
  it('reports the landed commit when deliver_task times out AFTER committing', async () => {
    const dir = initRepo()
    try {
      const deps = makeDeps(dir, {
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => {
              execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'fix: landed before timeout'], { cwd: dir })
              throw new Error('Tool deliver_task timed out after 240s')
            },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-timeout-landed', name: 'deliver_task', input: {} },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(content.includes('timed out after 240s'), 'original error preserved')
      assert.ok(content.includes('commit already landed'), `must state the commit landed, got: ${content}`)
      assert.ok(content.includes('fix: landed before timeout'), 'must include the commit subject')
      assert.ok(content.includes('Do NOT re-commit'), 'must instruct against retrying')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports HEAD unchanged when deliver_task errors BEFORE committing', async () => {
    const dir = initRepo()
    try {
      const deps = makeDeps(dir, {
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => { throw new Error('Tool deliver_task timed out after 240s') },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-timeout-clean', name: 'deliver_task', input: {} },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(content.includes('No new commit landed'), `must state no commit landed, got: ${content}`)
      assert.ok(content.includes('Check git log before retrying'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-deliver tool errors get no commit attribution', async () => {
    const dir = initRepo()
    try {
      const deps = makeDeps(dir, {
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => { throw new Error('Tool bash timed out after 120s') },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-timeout-bash', name: 'bash', input: { command: 'echo hi' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.includes('commit'), 'no attribution noise for non-deliver tools')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('touches tool:start and tool:end around execute (stall-observer wiring)', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-tmp', 'toolpipeline-touch-'))
    try {
      const deps = makeDeps(dir, {
        sessionId: 'touch-wiring-test',
        config: {
          ...makeDeps(dir).config,
          toolRegistry: {
            execute: async () => ({ content: 'ok', isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
            resolveName: (n: string) => n,
          },
        } as any,
      })
      const { _resetStallObserverForTest, getLastActivity } = await import('../stall-observer.js')
      _resetStallObserverForTest()
      const result = await executeToolUse(
        { id: 'tu-touch', name: 'write_file', input: { file_path: join(dir, 'a.ts'), content: 'export {}' } },
        deps, noopCallbacks as any, 1, false,
      )
      assert.ok(result.toolResult, 'tool executed')
      const last = getLastActivity('touch-wiring-test')
      // 2026-09-10 纵深修复后：end 之后还有 post 段的阶段打点，末次活动是 post:impact
      // （阶段可见性的代价——告警的 last 从含糊的 :end 升级为可指认的具体阶段）。
      assert.equal(last.source, 'tool:write_file:post:impact', 'post 段末次阶段打点应成为末次活动')
      _resetStallObserverForTest()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stage touch: pre 段在 trackEdit 前可指认（stall-observer 纵深 2026-09-10）', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-tmp', 'toolpipeline-stage-pre-'))
    try {
      const { _resetStallObserverForTest, getLastActivity } = await import('../stall-observer.js')
      _resetStallObserverForTest()
      let observed = ''
      const deps = makeDeps(dir, {
        sessionId: 'stage-pre-test',
        config: {
          ...makeDeps(dir).config,
          fileHistory: {
            trackEdit: async () => { observed = getLastActivity('stage-pre-test').source },
          },
        } as any,
      })
      await executeToolUse(
        { id: 'tu-stage-pre', name: 'edit_file', input: { file_path: join(dir, 'a.ts'), old_string: 'a', new_string: 'b' } },
        deps, noopCallbacks as any, 1, false,
      )
      assert.equal(observed, 'tool:edit_file:pre:track-edit', 'pre 段应在 fileHistory.trackEdit 前打点指认阶段')
      _resetStallObserverForTest()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stage touch: post 段在 firePostToolUse 前可指认（stall-observer 纵深 2026-09-10）', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.test-tmp', 'toolpipeline-stage-post-'))
    try {
      const { _resetStallObserverForTest, getLastActivity } = await import('../stall-observer.js')
      _resetStallObserverForTest()
      let observed = ''
      const deps = makeDeps(dir, {
        sessionId: 'stage-post-test',
        config: {
          ...makeDeps(dir).config,
          hooks: {
            firePreToolUse: () => ({}),
            firePostToolUse: () => { observed = getLastActivity('stage-post-test').source; return {} },
          },
        } as any,
      })
      const result = await executeToolUse(
        { id: 'tu-stage-post', name: 'write_file', input: { file_path: join(dir, 'b.ts'), content: 'export {}' } },
        deps, noopCallbacks as any, 1, false,
      )
      const lastTouch = getLastActivity('stage-post-test').source
      assert.equal(
        observed, 'tool:write_file:post:hooks',
        `post 段应在 firePostToolUse 前打点指认阶段（hookSeen=${JSON.stringify(observed)} lastTouch=${lastTouch} result=${JSON.stringify((result.toolResult as any)?.content ?? '').slice(0, 120)}）`,
      )
      _resetStallObserverForTest()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


// ── TDD gate suggest → tool-result annotation ───────────────────────────────
// tool 层 suggest 此前是 no-op；现在达到阈值的 suggest 会附加到编辑成功结果
// 尾部（追加在对话末尾，不动前缀缓存）。探索窗口与 RED 步骤保持安静。
describe('TDD gate suggest annotation', () => {
  const annotateNoopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  function tddDeps(gateState: {
    editsSinceLastTest: number
    hasFailedTests?: boolean
    verifications?: number
  }): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
          resolveName: (n: string) => n,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {}, getModel: () => 'test-model' },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: {
        ...mockEvidence,
        getGateState: () => ({
          filesModified: gateState.editsSinceLastTest,
          verifications: gateState.verifications ?? 0,
          editsSinceLastTest: gateState.editsSinceLastTest,
          hasFailedTests: gateState.hasFailedTests ?? false,
          hasCodeEdits: true,
          hasReadTestFiles: true,
        }),
      },
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
    }
  }

  it('appends [TDD] note to a successful edit once edits cross the threshold (suggest mode)', async () => {
    const result = await executeToolUse(
      { id: 'tu-tdd1', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      tddDeps({ editsSinceLastTest: 3 }), annotateNoopCallbacks as any, 1, false,
    )
    const tr = result.toolResult as any
    assert.equal(tr.is_error, false, 'suggest must not block the edit')
    assert.ok(tr.content.includes('[TDD]'), 'threshold-crossing suggest annotates the result')
    assert.ok(tr.content.includes('0 verifications'), 'carries the gate message')
  })

  it('stays silent inside the exploration window (< threshold)', async () => {
    const result = await executeToolUse(
      { id: 'tu-tdd2', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      tddDeps({ editsSinceLastTest: 1 }), annotateNoopCallbacks as any, 1, false,
    )
    const tr = result.toolResult as any
    assert.equal(tr.is_error, false)
    assert.ok(!tr.content.includes('[TDD]'), 'exploration window must not be annotated')
  })

  it('annotates when previously-run tests are failing', async () => {
    const result = await executeToolUse(
      { id: 'tu-tdd3', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      tddDeps({ editsSinceLastTest: 1, hasFailedTests: true, verifications: 2 }),
      annotateNoopCallbacks as any, 1, false,
    )
    const tr = result.toolResult as any
    assert.equal(tr.is_error, false)
    assert.ok(tr.content.includes('[TDD]'), 'failing tests annotate even below the edit threshold')
    assert.ok(tr.content.includes('failed'), 'carries the failing-tests message')
  })

  it('does not annotate a failed edit result', async () => {
    const deps = tddDeps({ editsSinceLastTest: 3 })
    ;(deps.config as any).toolRegistry = {
      execute: async () => ({ content: 'edit failed', isError: true }),
      get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
      needsApproval: () => false,
      resolveName: (n: string) => n,
    }
    const result = await executeToolUse(
      { id: 'tu-tdd4', name: 'edit_file', input: { file_path: 'src/foo.ts' } },
      deps, annotateNoopCallbacks as any, 1, false,
    )
    const tr = result.toolResult as any
    assert.equal(tr.is_error, true)
    assert.ok(!tr.content.includes('[TDD]'), 'failed edit result is not annotated')
  })

  it('meridian 快路径：写工具绝对路径先相对化（issue #61 族 Windows 死角）', async () => {
    // 写工具按工具文档恒传绝对路径——旧判据 `db && !isAbsolute(filePath)` 让
    // meridian SQLite 快路径恒不走，每次 run 首个写工具全量同步扫仓。修复后
    // 应先 relative(cwd) 再进 analyzeImpact。
    const seen: string[] = []
    const fakeDb = {
      hasFiles: () => true,
      getTestsFor: (f: string) => { seen.push(f); return [] },
      getReverseDependents: (_f: string) => [] as { file: string }[],
      getCoEditNeighbors: (_f: string) => [] as { file: string }[],
    }
    const deps = tddDeps({ editsSinceLastTest: 0 })
    deps.meridianIndexer = { getDb: () => fakeDb } as any
    deps.cwd = '/tmp/test'
    const result = await executeToolUse(
      { id: 'tu-meridian-abs', name: 'write_file', input: { file_path: '/tmp/test/src/foo.ts', content: 'x' } },
      deps, annotateNoopCallbacks as any, 1, false,
    )
    assert.equal((result.toolResult as any).is_error ?? false, false)
    assert.ok(seen.includes('src/foo.ts'), `analyzeImpact 应收到相对化后的路径，实际记录: ${JSON.stringify(seen)}`)
    assert.ok(!seen.some((f) => f.startsWith('/tmp/test')), '不得把绝对路径直接喂给 meridian')
  })

  it('meridian 冷库（hasFiles=false）不查空索引——落回 importGraph 兜底分支（P1-2）', async () => {
    // 新 clone 冷启动期 indexer 已建但 files 表为空——旧判据只查 db 真值，
    // analyzeImpact 返回空集且不落回 buildImportGraph，impact hint 静默变空。
    // 修复后空库与 indexer=null 同路走 else（importGraph 兜底），meridian 不被打。
    const seen: string[] = []
    const fakeDb = {
      hasFiles: () => false,
      getTestsFor: (f: string) => { seen.push(f); return [] },
      getReverseDependents: (_f: string) => [] as { file: string }[],
      getCoEditNeighbors: (_f: string) => [] as { file: string }[],
    }
    const deps = tddDeps({ editsSinceLastTest: 0 })
    deps.meridianIndexer = { getDb: () => fakeDb } as any
    deps.cwd = '/nonexistent-p12-fallback-dir'
    const result = await executeToolUse(
      { id: 'tu-meridian-cold', name: 'write_file', input: { file_path: '/nonexistent-p12-fallback-dir/src/foo.ts', content: 'x' } },
      deps, annotateNoopCallbacks as any, 1, false,
    )
    assert.equal((result.toolResult as any).is_error ?? false, false)
    assert.equal(seen.length, 0, '空库时不得查询 meridian（analyzeImpact 各方法都不该被调）')
  })
})
