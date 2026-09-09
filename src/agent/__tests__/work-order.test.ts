import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBlockedWorkerResult,
  buildPolicyCancelledResult,
  workerResultSchema,
  classifyWorkerParseError,
  createReadOnlyWorkOrder,
  createWriteWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  parseWorkerResult,
  READ_ONLY_WORKER_TOOLS,
  salvageWorkerResult,
  WORKER_RESULT_SUBMIT_SCHEMA,
  WorkerResultParseError,
  WRITE_WORKER_TOOLS,
  clampWorkerMaxTurns,
} from '../work-order.js'

describe('work-order contract', () => {
  it('creates a read-only code_search work order with safe defaults', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find where model routing is currently configured.',
      scope: { files: ['src/main.tsx'] },
    })

    assert.equal(order.id, 'wo_1')
    assert.equal(order.kind, 'code_search')
    // allowedTools now come from ProfileRegistry — includes read_section, repo_graph
    assert.ok(order.allowedTools.includes('inspect_project'))
    assert.ok(order.allowedTools.includes('repo_map'))
    assert.ok(order.allowedTools.includes('related_tests'))
    assert.ok(order.allowedTools.includes('read_section'))
    assert.ok(order.allowedTools.includes('repo_graph'))
    assert.ok(!order.allowedTools.includes('edit_file'))
    assert.deepEqual(order.disallowedTools, ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task', 'delegate_batch'])
    assert.equal(order.budget.maxRetries, 2)
    // Read-only default turn budget (raised from 8 — flash has a 1M window).
    assert.equal(order.budget.maxTurns, 24)
    assert.equal(order.aggregationPolicy, 'primary_decides')
  })

  it('accepts all built-in registry profiles in work orders', () => {
    const architect = createReadOnlyWorkOrder({
      id: 'wo_architect',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'architect',
      objective: 'Review architectural boundaries in the worker registry implementation.',
      scope: { files: ['src/agent/profile-registry.ts'] },
    })
    const troubleshooter = createReadOnlyWorkOrder({
      id: 'wo_troubleshooter',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'troubleshooter',
      objective: 'Trace root cause across worker evidence and aggregation modules.',
      scope: { files: ['src/agent/worker-evidence.ts'] },
    })

    assert.equal(architect.profile, 'architect')
    assert.ok(architect.allowedTools.includes('lsp_goto_definition'))
    assert.equal(troubleshooter.profile, 'troubleshooter')
    assert.ok(troubleshooter.allowedTools.includes('grep'))
  })

  it('parses a fenced WorkerResult JSON packet', () => {
    const result = parseWorkerResult(`Here is the packet:\n\n\`\`\`json
{
  "workOrderId": "wo_1",
  "status": "passed",
  "summary": "Model routing is only configured in main.",
  "findings": [
    {
      "claim": "main.tsx constructs the active AgentLoop.",
      "evidence": "src/main.tsx creates PromptEngine and AgentLoop inside useMemo.",
      "confidence": "high"
    }
  ],
  "artifacts": [
    {
      "kind": "note",
      "title": "Runtime seam",
      "content": "Inject coordinator next to the existing AgentLoop construction."
    }
  ],
  "changedFiles": [],
  "risks": [],
  "nextActions": ["Create a coordinator factory"]
}
\`\`\``, 'wo_1')

    assert.equal(result.status, 'passed')
    assert.equal(result.findings[0]!.confidence, 'high')
    assert.deepEqual(result.changedFiles, [])
  })

  it('ingest schema 保留 sourcesReviewed（双 schema 同步回归：裸 z.object strip 陷阱）', () => {
    // 反证 1（计划 §瑶光）：只改 result schema 不改 ingest → worker 自报字段
    // 在 parseWorkerResult 入口被 zod strip 静默剥掉。这条红说明双 schema 没同步。
    const raw = JSON.stringify({
      workOrderId: 'wo_src',
      status: 'passed',
      summary: 'checked sources',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      sourcesReviewed: 5,
    })
    const ingest = WORKER_RESULT_SUBMIT_SCHEMA.parse(JSON.parse(raw))
    assert.equal(ingest.sourcesReviewed, 5, 'ingest 侧必须收下该键')
    const result = parseWorkerResult(raw, 'wo_src')
    assert.equal(result.sourcesReviewed, 5, 'parse 后 result 保留该键')
  })

  it('skips non-result JSON before the WorkerResult packet', () => {
    const result = parseWorkerResult(`I inspected this scope {"note":"not the result"} and found:\n{
  "workOrderId": "wo_1",
  "status": "passed",
  "summary": "Worker result packet follows incidental JSON.",
  "findings": [],
  "artifacts": [],
  "changedFiles": [],
  "risks": [],
  "nextActions": []
}`, 'wo_1')

    assert.equal(result.status, 'passed')
    assert.equal(result.summary, 'Worker result packet follows incidental JSON.')
  })

  it('normalizes legacy string findings and fills optional arrays', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Legacy worker packet was normalized.',
      findings: ['Coordinator creates isolated worker sessions.'],
      artifacts: ['Use ToolRegistry allowlist for workers.'],
    }), 'wo_1')

    assert.equal(result.findings[0]!.claim, 'Coordinator creates isolated worker sessions.')
    assert.equal(result.findings[0]!.confidence, 'medium')
    assert.deepEqual(result.changedFiles, [])
    assert.equal(result.artifacts[0]!.kind, 'note')
  })

  it('throws WorkerResultParseError when candidates exist but none validates (repair loop must fire)', () => {
    // parseWorkerResult THROWS on all-candidates-failed — swallowing this into a
    // blocked return bypassed the caller's catch-driven repair loop entirely
    // (session 2c1186f5: a complete scout report was discarded over one syntax
    // error because the repair re-ask never ran).
    assert.throws(
      () => parseWorkerResult(`{"note":"incidental"}\n{
  "workOrderId": "wo_1",
  "status": "done",
  "summary": "Invalid result status"
}`, 'wo_1'),
      (error: unknown) => {
        assert.ok(error instanceof WorkerResultParseError)
        assert.ok(error.candidateCount >= 2)
        // The diagnostic includes errors from ALL candidates; the important one
        // (invalid enum value "done") should be present somewhere.
        assert.ok(error.message.includes('done') || error.message.includes('invalid_enum_value')
          || error.message.includes('Invalid'), `expected error to mention the "done" status error. Got: ${error.message}`)
        return true
      },
    )
  })

  it('auto-fixes wrong workOrderId to expected one (fault tolerance for cheap models)', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'other',
      status: 'passed',
      summary: 'wrong id',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1')
    assert.equal(result.workOrderId, 'wo_1')
    assert.equal(result.status, 'passed')
  })

  it('rejects summary-only results without workOrderId (no fabricated green)', () => {
    // A summary-only object (e.g. {"summary":"done","status":"passed"}) is NOT
    // a worker packet — patching an id onto it would fabricate a fake passed.
    // Must throw so the caller's repair loop fires instead of a green.
    assert.throws(
      () => parseWorkerResult(JSON.stringify({
        summary: 'done',
        status: 'passed',
      }), 'wo_1'),
      WorkerResultParseError,
    )
  })

  it('defaults missing status to blocked only for real packets with workOrderId', () => {
    // Fault tolerance applies to genuine worker packets: a real workOrderId
    // with a missing status defaults to 'blocked' (never fabricated 'passed').
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      summary: 'real packet without status',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1')
    assert.equal(result.status, 'blocked')
    assert.equal(result.workOrderId, 'wo_1')
  })

  it('builds a blocked result without leaking raw transcript content', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review coordinator risk.',
      scope: {},
    })

    const result = buildBlockedWorkerResult(order, 'Worker result was not valid JSON')

    assert.equal(result.status, 'blocked')
    assert.equal(result.summary, 'Worker blocked: Worker result was not valid JSON')
    assert.equal(result.findings.length, 0)
    assert.ok(result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('maps work order kinds to existing capability task names', () => {
    assert.equal(mapWorkOrderKindToCapabilityTask('code_search'), 'repo_summarization')
    assert.equal(mapWorkOrderKindToCapabilityTask('review'), 'risky_refactor')
    assert.equal(mapWorkOrderKindToCapabilityTask('verify'), 'test_failure_diagnosis')
    assert.equal(mapWorkOrderKindToCapabilityTask('plan'), 'planning')
  })

  it('creates a write-capable work order with expanded tool allowlist', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Fix the null check in coordinator.',
      scope: { files: ['src/agent/coordinator.ts'] },
    })

    assert.equal(order.profile, 'patcher')
    // allowedTools now come from ProfileRegistry — includes read_section, repo_graph
    assert.ok(order.allowedTools.includes('edit_file'))
    assert.ok(order.allowedTools.includes('write_file'))
    assert.ok(order.allowedTools.includes('bash'))
    assert.ok(order.allowedTools.includes('run_tests'))
    assert.ok(order.allowedTools.includes('read_file'))
    assert.ok(order.allowedTools.includes('read_section'))
    assert.ok(order.allowedTools.includes('repo_graph'))
    assert.equal(order.disallowedTools.includes('delegate_task'), true)
    assert.equal(order.disallowedTools.includes('delegate_batch'), true)
    // Self-contained shards run a full implement+verify loop, so write workers
    // get a generous turn budget (raised from 14, then 32→48 with the 600s
    // wall-clock alignment — flash has a 1M window).
    assert.equal(order.budget.maxTurns, 48)
    assert.ok(order.dedupeKey.startsWith('write:'))
  })

  it('threads modelOverride through read-only and write work orders', () => {
    const ro = createReadOnlyWorkOrder({
      id: 'wo_ov_ro',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'council_expert',
      objective: 'council seat',
      scope: {},
      modelOverride: { provider: 'glm', model: 'glm-4.6' },
    })
    assert.deepEqual(ro.modelOverride, { provider: 'glm', model: 'glm-4.6' })

    const rw = createWriteWorkOrder({
      id: 'wo_ov_rw',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'patch',
      scope: { files: ['a.ts'] },
      modelOverride: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    })
    assert.deepEqual(rw.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })

    // Absent override → undefined (not an empty object).
    const none = createReadOnlyWorkOrder({
      id: 'wo_ov_none', parentTurnId: 'turn_1', kind: 'plan', profile: 'council_expert', objective: 'x', scope: {},
    })
    assert.equal(none.modelOverride, undefined)
  })

  it('accepts patchSummary in worker result schema', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Applied fix.',
      patchSummary: 'Changed null check on line 42.',
      findings: [],
      artifacts: [],
      changedFiles: ['src/agent/coordinator.ts'],
      risks: [],
      nextActions: [],
    }), 'wo_1')

    assert.equal(result.patchSummary, 'Changed null check on line 42.')
    assert.deepEqual(result.changedFiles, ['src/agent/coordinator.ts'])
  })

  it('validates worker result evidence fields', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Implemented retry policy',
      findings: [],
      artifacts: [],
      changedFiles: ['src/agent/turn-harness.ts'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }), 'wo_1')

    assert.equal(result.evidenceStatus, 'verified')
  })

  it('defaults evidenceStatus to unverified when omitted', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Read-only scan complete.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1')

    assert.equal(result.evidenceStatus, 'unverified')
  })

  it('includes evidenceStatus in blocked worker result', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_blocked',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review risk.',
      scope: {},
    })

    const result = buildBlockedWorkerResult(order, 'Parse error')
    assert.equal(result.evidenceStatus, 'blocked')
  })

  it('creates work order without domain (backward compatible)', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_nodomain',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Scan codebase.',
      scope: { files: ['src/main.tsx'] },
    })
    assert.equal(order.domain, undefined)
  })

  it('creates work order with domain field', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_domain',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Analyze TUI components.',
      scope: { files: ['src/tui/app.tsx'] },
      domain: 'frontend',
    })
    assert.equal(order.domain, 'frontend')
  })

  it('authorityReason: omitted when no authority; hit reason when matches; 显式指定 otherwise', () => {
    const none = createReadOnlyWorkOrder({
      id: 'wo_ar_none',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: '重构优化性能',
      scope: {},
    })
    assert.equal(none.authorityReason, undefined)

    const hit = createWriteWorkOrder({
      id: 'wo_ar_hit',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: '重构优化性能',
      scope: { files: ['a.ts'] },
      authority: 'tianfu',
    })
    assert.ok(hit.authorityReason?.startsWith('命中:'), hit.authorityReason)

    const override = createWriteWorkOrder({
      id: 'wo_ar_ov',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: '重构优化性能',
      scope: { files: ['a.ts'] },
      authority: 'tianquan',
    })
    assert.equal(override.authorityReason, '显式指定')

    // Fail-closed tools whitelist still applies for unknown authority
    const unknown = createReadOnlyWorkOrder({
      id: 'wo_ar_unk',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'scan',
      scope: {},
      authority: 'not_a_real_domain',
    })
    assert.equal(unknown.authorityReason, '显式指定')
    assert.deepEqual(unknown.allowedTools, [])
  })

  it('creates write work order with domain field', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write_domain',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Fix prompt engine.',
      scope: { files: ['src/prompt/engine.ts'] },
      domain: 'prompt',
    })
    assert.equal(order.domain, 'prompt')
    assert.equal(order.profile, 'patcher')
  })

  // ─── P0-A1 fail-closed: authority typo → deny-all ──────────
  it('authority typo (read-only) → deny-all (empty allowedTools), NOT profile full set', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_auth_typo',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
      authority: 'tianfuu',  // typo — no such domain
    })
    assert.equal(order.allowedTools.length, 0, 'unknown authority should produce empty allowedTools (deny-all)')
  })

  it('authority typo (write) → deny-all (empty allowedTools)', () => {
    const order = createWriteWorkOrder({
      id: 'wo_auth_typo_write',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Patch something.',
      scope: {},
      authority: 'nonexistent_domain',
    })
    assert.equal(order.allowedTools.length, 0, 'unknown authority should produce empty allowedTools (deny-all)')
  })

  it('valid authority intersects with profile tools correctly', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_auth_valid',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
      authority: 'tianquan',  // valid built-in domain
    })
    assert.ok(order.allowedTools.length > 0, 'valid authority should produce non-empty intersection')
  })

  // ── Wave 1: retryBackoffMs / maxRetryBackoffMs ──────────────────

  it('WorkerBudget defaults retryBackoffMs to 10000 and maxRetryBackoffMs to 300000', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_backoff',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
    })
    assert.equal(order.budget.retryBackoffMs, 10000)
    assert.equal(order.budget.maxRetryBackoffMs, 300000)
  })

  it('WorkerBudget allows overriding retryBackoffMs and maxRetryBackoffMs', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_backoff_custom',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
      budget: { retryBackoffMs: 5000, maxRetryBackoffMs: 60000 },
    })
    assert.equal(order.budget.retryBackoffMs, 5000)
    assert.equal(order.budget.maxRetryBackoffMs, 60000)
  })

  it('write work order also gets backoff defaults', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write_backoff',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      profile: 'patcher',
      objective: 'Patch something.',
      scope: {},
    })
    assert.equal(order.budget.retryBackoffMs, 10000)
    assert.equal(order.budget.maxRetryBackoffMs, 300000)
  })

  // ── evidenceKind / evidenceRefs: 结构化一手/转述标注 ─────────

  it('parseWorkerResult accepts finding with evidenceKind "firsthand" + evidenceRefs', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_ev',
      status: 'passed',
      summary: 'scanned routing config',
      findings: [{
        claim: 'model routing is hardcoded in src/main.ts',
        confidence: 'high',
        evidence: 'Found route map literal at L42-L58',
        evidenceKind: 'firsthand',
        evidenceRefs: ['src/main.ts:42', 'src/main.ts:58'],
      }],
      artifacts: [],
      changedFiles: [],
    }), 'wo_ev')
    assert.equal(result.findings.length, 1)
    const f = result.findings[0]!
    assert.equal(f.claim, 'model routing is hardcoded in src/main.ts')
    assert.equal(f.evidenceKind, 'firsthand')
    assert.deepEqual(f.evidenceRefs, ['src/main.ts:42', 'src/main.ts:58'])
  })

  it('parseWorkerResult accepts finding with evidenceKind "inferred" without refs', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_infer',
      status: 'passed',
      summary: 'speculation',
      findings: [{
        claim: 'this module likely has dead code',
        confidence: 'medium',
        evidence: 'No imports found in the three callers I checked',
        evidenceKind: 'inferred',
      }],
      artifacts: [],
      changedFiles: [],
    }), 'wo_infer')
    assert.equal(result.findings[0]!.evidenceKind, 'inferred')
    assert.equal(result.findings[0]!.evidenceRefs, undefined)
  })

  it('parseWorkerResult: finding without evidenceKind still parses (backward compat)', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_legacy',
      status: 'passed',
      summary: 'old format',
      findings: [{
        claim: 'something',
        confidence: 'low',
        evidence: 'just a hunch',
      }],
      artifacts: [],
      changedFiles: [],
    }), 'wo_legacy')
    assert.equal(result.findings[0]!.evidenceKind, undefined)
    assert.equal(result.findings[0]!.evidenceRefs, undefined)
  })

  it('parseWorkerResult rejects invalid evidenceKind', () => {
    assert.throws(() => {
      parseWorkerResult(JSON.stringify({
        workOrderId: 'wo_bad',
        status: 'passed',
        summary: 'bad kind',
        findings: [{
          claim: 'x',
          confidence: 'low',
          evidence: 'y',
          evidenceKind: 'definitely_real',
        }],
        artifacts: [],
        changedFiles: [],
      }), 'wo_bad')
    })
  })
})

describe('classifyWorkerParseError (D 度量细分)', () => {
  function catchParse(text: string): unknown {
    try {
      parseWorkerResult(text, 'wo_x')
      return null
    } catch (e) {
      return e
    }
  }

  it('no JSON at all → no_json', () => {
    const err = catchParse('纯散文，没有任何 JSON。')
    assert.ok(err)
    assert.equal(classifyWorkerParseError(err), 'no_json')
  })

  it('unescaped quote breaks syntax → json_syntax', () => {
    // 结构性垃圾（非白名单模式）仍不可修 → json_syntax
    const err = catchParse('{"workOrderId":"wo_x","status":"passed","summary": }')
    assert.ok(err instanceof WorkerResultParseError)
    assert.equal(classifyWorkerParseError(err), 'json_syntax')
  })

  it('F2: 裸引号不再是 syntax 错误——repairJsonSyntax 修复后整包解析（2026-09-06）', () => {
    const result = parseWorkerResult('{"workOrderId":"wo_x","status":"passed","summary":"他说"你好"","findings":[],"artifacts":[],"changedFiles":[],"risks":[],"nextActions":[]}', 'wo_x')
    assert.equal(result.summary, '他说"你好"')
  })

  it('truncated output → truncated', () => {
    const err = catchParse('{"workOrderId":"wo_x","status":"passed","summary":"被截断的报')
    assert.ok(err instanceof WorkerResultParseError)
    assert.equal(classifyWorkerParseError(err), 'truncated')
  })

  // 策略 6 会给截断的报告补上闭合符，补完就能解析——于是一份被 maxTokens 砍断的
  // 报告曾直接变成 status:passed、summary 断在半句、findings 为空，与「worker 真的
  // 没什么可报」在编排者眼里完全一样。
  it('截断的报告不得被自动闭合成 status=passed', () => {
    const truncated = '{"workOrderId":"wo_x","status":"passed","summary":"被截断的报'
    assert.throws(() => parseWorkerResult(truncated, 'wo_x'), WorkerResultParseError)
  })

  it('截断但含 findings 时，救回内容而非伪装通过', () => {
    const truncated = '{"workOrderId":"wo_x","status":"passed","summary":"报告","findings":'
      + '[{"claim":"c1","evidence":"e1","confidence":"high"},{"claim":"c2","evidence":"e2","confidence":"high"}]'
      + ',"artifacts":[{"kind":"note","title":"t","content":"被截断'
    const salvaged = salvageWorkerResult(truncated, 'wo_x', catchParse(truncated))
    assert.ok(salvaged, '两条完整 finding 应当被救回')
    assert.equal(salvaged.findings.length, 2)
    assert.equal(salvaged.status, 'blocked', '救回的报告不能顶着 passed')
    assert.equal(salvaged.evidenceStatus, 'unverified')
  })

  it('valid JSON failing schema → schema_field', () => {
    const err = catchParse(JSON.stringify({ workOrderId: 'wo_x', status: 'banana', summary: 's' }))
    assert.ok(err instanceof WorkerResultParseError)
    assert.equal(classifyWorkerParseError(err), 'schema_field')
  })

  it('salvageWorkerResult attaches parseErrorKind from the parse error', () => {
    const text = '{"workOrderId":"wo_x","status":"passed","summary":"partial","findings":[{"claim":"c1","evidence":"e1","confidence":"high"}],"artifacts":[],"changedFiles":[],"risks":[],"nextActions":[],'
    const err = catchParse(text)
    const salvaged = salvageWorkerResult(text, 'wo_x', err)
    assert.ok(salvaged)
    assert.equal(salvaged.failureReason, 'json_parse')
    assert.equal(salvaged.parseErrorKind, 'json_syntax')
  })
})

// 任务级约束通道（docs/design/2026-08-02-工单约束通道.md）。
// 这条链此前三处断开：模型无插槽、DelegationRequest 无字段、coordinator 不转发，
// 于是 worker 永远只看到 profile 样板，计划的反目标一条都到不了。
describe('work-order task constraints', () => {
  const base = {
    parentTurnId: 'turn_1',
    kind: 'code_search' as const,
    objective: 'Migrate the meridian schema.',
    scope: { files: ['src/repo/meridian-db.ts'] },
  }

  it('appends task constraints to read-only profile discipline instead of replacing it', () => {
    const order = createReadOnlyWorkOrder({
      ...base,
      profile: 'code_scout',
      constraints: ['迁移必须带 user_version 守卫，只跑一次。'],
    })
    assert.ok(order.constraints.includes('Do not request write, edit, bash, or test execution tools.'),
      '只读纪律不能被任务约束顶掉')
    assert.ok(order.constraints.includes('迁移必须带 user_version 守卫，只跑一次。'))
  })

  it('appends task constraints on the write path too', () => {
    const order = createWriteWorkOrder({
      ...base,
      constraints: ['不要推广 council/galaxy，先过观察窗口。'],
    })
    assert.ok(order.constraints.includes('Return a patchSummary describing all changes made.'))
    assert.ok(order.constraints.includes('不要推广 council/galaxy，先过观察窗口。'))
  })

  it('falls back to profile boilerplate when constraints are absent or empty', () => {
    const absent = createReadOnlyWorkOrder({ ...base, profile: 'code_scout' })
    const empty = createReadOnlyWorkOrder({ ...base, profile: 'code_scout', constraints: [] })
    assert.deepEqual(empty.constraints, absent.constraints, '空数组等同缺席，不得清空纪律')
  })

  it('drops blanks and duplicates, and caps the list', () => {
    const order = createReadOnlyWorkOrder({
      ...base,
      profile: 'code_scout',
      constraints: ['  ', 'Return only evidence-backed claims.', 'A', 'A',
        ...Array.from({ length: 20 }, (_, i) => `extra-${i}`)],
    })
    assert.equal(order.constraints.filter(c => c === 'Return only evidence-backed claims.').length, 1,
      '回声的样板行不得重复')
    assert.equal(order.constraints.filter(c => c === 'A').length, 1)
    assert.ok(order.constraints.length <= 3 + 12, `约束总量需有上限，实得 ${order.constraints.length}`)
  })

  // ── buildPolicyCancelledResult ──

  it('buildPolicyCancelledResult produces valid schema-passable result', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_cancel', parentTurnId: 't1', kind: 'code_search',
      profile: 'code_scout', objective: 'test', scope: {},
    })
    const r = buildPolicyCancelledResult(order, 'quorum k=2')
    // schema parse must not throw
    workerResultSchema.parse(r)
    assert.equal(r.status, 'blocked')
    assert.equal(r.failureReason, 'policy_short_circuit')
    assert.equal(r.evidenceStatus, 'skipped')
    assert.ok(r.summary.includes('quorum k=2'))
    assert.ok(r.summary.includes('不是故障'))
  })

  it('buildPolicyCancelledResult preserves groupId and objective from the order', () => {
    // P1 regression: cancelled results bypass reconcileWithObjective → groupId
    // was missing, causing quorum members to land in the "independent" group (k=1)
    // and produce false quorum-not-reached warnings.
    const order = createReadOnlyWorkOrder({
      id: 'wo_grp', parentTurnId: 't1', kind: 'code_search',
      profile: 'code_scout', objective: 'find the bug', scope: {},
      groupId: 'replica-set-a',
    })
    const r = buildPolicyCancelledResult(order, 'quorum k=2')
    assert.equal(r.groupId, 'replica-set-a')
    assert.equal(r.objective, 'find the bug')
  })
})

/**
 * Regression (2026-08-10 c8108f646 审查 HIGH): runtime factory 默认 maxTurns:40
 * 曾把写工 order 预算 48 / 显式 100 经 clampWorkerMaxTurns 静默截断为 40——
 * 上轮"写工 32→48"放宽在生产路径从未生效。修复后 runtime 默认提到 100，
 * clamp 语义不变（min），48/100 不再被截断。此测试钉死：runtime 默认必须
 * ≥ 显式预算上限，否则放大类改动会再次"构建≠接线≠有效"。
 */
describe('clampWorkerMaxTurns — runtime default must not cap explicit budgets', () => {
  it('write-order budget 48 survives the runtime-default clamp', () => {
    assert.equal(clampWorkerMaxTurns(100, 48), 48, '写工 48 轮预算不能被 runtime 默认截断')
  })

  it('explicit budget 100 survives the runtime-default clamp', () => {
    assert.equal(clampWorkerMaxTurns(100, 100), 100, '显式 100 轮预算不能被 runtime 默认截断')
  })

  it('tighter per-profile caps still bite (min semantics preserved)', () => {
    assert.equal(clampWorkerMaxTurns(100, 6), 6, 'reviewer=6 等紧预算仍应生效')
    assert.equal(clampWorkerMaxTurns(100, 24), 24, '只读工 24 轮仍应生效')
  })
})
