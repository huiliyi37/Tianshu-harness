import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeToolUse as rawExecuteToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'
import { createTurnBudget } from '../turn-budget.js'
import type { EvidenceTrackerPublic } from '../evidence.js'
import { observeRun } from '../stall-observer.js'

// F2 — editedInput 绕过 deny/self-kill 门修复（2026-10 审批链路安全审计）。
// 审批等待期间人类可以编辑工具输入（applyApprovalEdit → editedInput），而
// deny / self-kill / bash-deny 三道门此前只判 ORIGINAL input。修复后在最终输入
// 生效前重跑这三道门——命中即拒绝执行，不抛异常，也不禁止 editedInput 本身。

const executeToolUse: typeof rawExecuteToolUse = (...args) =>
  observeRun(args[1].sessionId ?? 'default', () => rawExecuteToolUse(...args))

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

function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
  return {
    config: {
      toolRegistry: {
        execute: async () => ({ content: 'ok', isError: false }),
        get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
        needsApproval: () => true,
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

function makeExecDeps(permissions: Record<string, unknown>) {
  let executed = false
  const deps = makeDeps({
    config: {
      ...makeDeps().config,
      permissions,
      toolRegistry: {
        execute: async () => { executed = true; return { content: 'ok', isError: false } },
        get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
        needsApproval: () => true,
        resolveName: (n: string) => n,
      },
    } as any,
  })
  return { deps, wasExecuted: () => executed }
}

describe('F2 approval edit re-gate', () => {
  it('rejects an editedInput that matches a deny rule (deny gate re-run on final input)', async () => {
    const { deps, wasExecuted } = makeExecDeps({
      allow: [],
      deny: [{ tool: 'bash', params: { command: 'rm -rf*' } }],
      bash: { allowlist: [], denylist: [] },
    })
    let errorMsg = ''
    let approvalCalls = 0
    const callbacks = {
      ...noopCallbacks,
      onToolResult: (_id: string, _name: string, content: string, isError?: boolean) => { if (isError) errorMsg = content },
      onApprovalRequired: async () => {
        approvalCalls++
        return { approved: true, editedInput: { command: 'rm -rf /tmp/x' } }
      },
    }

    const result = await executeToolUse(
      { id: 'tu-edit-deny', name: 'bash', input: { command: 'echo hello' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 1, 'benign command must go through approval')
    assert.equal(wasExecuted(), false, 'edited denied command must NOT execute')
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content as string, /denied/i)
    assert.match(errorMsg, /denied/i, 'the model-facing tool result must carry the deny reason')
  })

  it('rejects an editedInput that is a self-destructive kill (self-kill gate re-run)', async () => {
    const { deps, wasExecuted } = makeExecDeps({ allow: [], deny: [], bash: { allowlist: [], denylist: [] } })
    let errorMsg = ''
    const callbacks = {
      ...noopCallbacks,
      onToolResult: (_id: string, _name: string, content: string, isError?: boolean) => { if (isError) errorMsg = content },
      onApprovalRequired: async () => {
        return { approved: true, editedInput: { command: 'pkill node' } }
      },
    }

    const result = await executeToolUse(
      { id: 'tu-edit-selfkill', name: 'bash', input: { command: 'echo hello' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(wasExecuted(), false, 'edited self-kill command must NOT execute')
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content as string, /own runtime|terminate/i)
    assert.match(errorMsg, /own runtime|terminate/i, 'the model-facing tool result must carry the self-kill reason')
  })

  it('rejects an editedInput that matches a bash denylist prefix', async () => {
    const { deps, wasExecuted } = makeExecDeps({ allow: [], deny: [], bash: { allowlist: [], denylist: ['curl'] } })
    const callbacks = {
      ...noopCallbacks,
      onApprovalRequired: async () => ({ approved: true, editedInput: { command: 'curl http://evil.example' } }),
    }

    const result = await executeToolUse(
      { id: 'tu-edit-bashdeny', name: 'bash', input: { command: 'echo hello' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(wasExecuted(), false, 'edited denylisted command must NOT execute')
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content as string, /denied/i)
  })

  it('executes a benign editedInput that clears every gate (re-gate does not forbid edits)', async () => {
    const { deps, wasExecuted } = makeExecDeps({ allow: [], deny: [], bash: { allowlist: [], denylist: [] } })
    const callbacks = {
      ...noopCallbacks,
      onApprovalRequired: async () => ({ approved: true, editedInput: { command: 'echo edited' } }),
    }

    const result = await executeToolUse(
      { id: 'tu-edit-benign', name: 'bash', input: { command: 'echo hello' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(wasExecuted(), true, 'a benign edited command must still execute')
    assert.notEqual((result.toolResult as any).is_error, true)
  })
})
