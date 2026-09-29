import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { SessionContext } from '../context.js'
import { createReadOnlyWorkOrder, deriveWorkerSessionId, type WorkOrder } from '../work-order.js'
import { SessionPersist } from '../session-persist.js'
import { isTruncationStopReason } from '../worker-repair-route.js'
import {
  runWorkerSession,
  createSoftLandingDrain,
  detectApprovalDeadlock,
  buildMaxTurnsExhaustedResult,
  HEADLESS_DENY_MARKER,
  __setToolKeepaliveMs,
  type WorkerActivityKind,
  type WorkerSessionConfig,
  type WorkerTranscript,
} from '../worker-session.js'
import { HEADLESS_DENY_MARKER as PIPELINE_HEADLESS_DENY_MARKER } from '../tool-pipeline.js'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function clientFromTexts(texts: string[]): StreamClient {
  let index = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      const text = texts[Math.min(index, texts.length - 1)]!
      index++
      cb.onTextDelta(text)
      cb.onContentBlock(textBlock(text))
      cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    }),
  } as unknown as StreamClient
}

function makePromptEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
}

function validPacket(workOrderId: string) {
  return JSON.stringify({
    workOrderId,
    status: 'passed',
    summary: 'Worker found one seam.',
    findings: [{ claim: 'AgentLoop is injectable', evidence: 'src/agent/loop.ts constructor', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: ['Use an independent SessionContext'],
  })
}

describe('runWorkerSession', () => {
  it('runs a headless worker and returns a schema-valid result', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find AgentLoop constructor seams.',
      scope: { files: ['src/agent/loop.ts'] },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_1')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.session.getTurnCount(), 1)
    assert.deepEqual(run.transcript.toolUses, [])
  })

  it('正常结束的 worker 会话 meta 有终态（status=completed + cleanExit=true），事后归因不用翻 jsonl', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_meta',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Verify worker session meta finalization.',
      scope: {},
    })

    await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_meta')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    // AgentLoop 构造器已实例化同一 SessionPersist（loop.ts:987）；收尾写回必须落在同一 meta 文件。
    const meta = new SessionPersist(deriveWorkerSessionId(order.id), '/repo').loadMetadata()
    assert.equal(meta?.status, 'completed', '会话正常结束应写 status=completed')
    assert.equal(meta?.cleanExit, true, '正常结束应标 cleanExit=true')
  })

  it('transcript 带上等首字节度量——墙钟去向可从内存直读，不依赖 cache-log 落盘', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_ttft',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Verify TTFT lands on the worker transcript.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_ttft')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.transcript.ttftSamples, 1, '单轮流式应采到一次 TTFT')
    assert.equal(typeof run.transcript.waitingFirstByteMs, 'number', '采到样本就必须带累计毫秒数')
    assert.ok((run.transcript.waitingFirstByteMs ?? -1) >= 0)
  })

  it('续跑成功后清空上一轮的 failureReason——同一份 meta 合并写入不得残留旧归因', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_meta_continued',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Verify failureReason is cleared when a continuation succeeds.',
      scope: {},
    })

    // 首轮墙钟耗尽的落盘现场：续跑各轮 order.id 与 nonce 都不变，共用这一份 meta。
    const persist = new SessionPersist(deriveWorkerSessionId(order.id), '/repo')
    persist.updateMetadata({ status: 'completed', cleanExit: true, failureReason: 'timeout' })
    assert.equal(persist.loadMetadata()?.failureReason, 'timeout', '前置条件：首轮归因已落盘')

    await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_meta_continued')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    const meta = new SessionPersist(deriveWorkerSessionId(order.id), '/repo').loadMetadata()
    assert.equal(meta?.status, 'completed')
    assert.equal(
      meta?.failureReason,
      undefined,
      '续跑成功后仍带 timeout 会把成功的 worker 读成预算耗尽——updateMetadata 是合并语义，省略键不等于清空',
    )
  })

  it('uses an independent SessionContext instead of mutating the primary session', async () => {
    const primary = new SessionContext()
    primary.addUserMessage('primary user message')
    const before = primary.getMessages().length

    const order = createReadOnlyWorkOrder({
      id: 'wo_2',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review isolation.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts([validPacket('wo_2')]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(primary.getMessages().length, before)
    assert.ok(run.session.getMessages().length > 0)
  })

  it('recovers without repair when prose contains incidental JSON before the result packet', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_incidental',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find worker result parser seams across coordinator and worker session modules.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const text = `Observed tool input {"pattern":"WorkerResult"}. Final packet:\n${validPacket('wo_incidental')}`
    const run = await runWorkerSession({
      order,
      client: clientFromTexts([text]),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 0)
  })

  it('runs one repair prompt after invalid worker JSON', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_3',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan coordinator tests.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    const client = clientFromTexts(['not valid json', validPacket('wo_3')])
    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      // 修复梯专用用例——钉旧契约（无收尾轮），否则终型轮先把报告救回、
      // repairAttempts 恒为 0。终型失败再走修复梯的情形由终轮定型 describe 覆盖。
      finalizeReport: false,
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1)
  })

  it('returns blocked after retry budget is exhausted', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_4',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review invalid result handling.',
      scope: {},
      budget: { maxRetries: 0 },
    })

    const run = await runWorkerSession({
      order,
      client: clientFromTexts(['not valid json']),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'blocked')
    assert.ok(run.result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('forceJsonRepair sends response_format on the repair request and recovers', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_json',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'planner',
      objective: 'Plan json repair.',
      scope: {},
      budget: { maxRetries: 1 },
    })

    // Capture whether the repair request carried response_format.
    let sawResponseFormat = false
    let repairCallCount = 0
    const client = {
      stream: mock.fn(async (req: { response_format?: unknown }, cb: StreamCallbacks) => {
        // First call: invalid output (no response_format — normal turn via AgentLoop).
        // Second call: json-mode repair (response_format set).
        if (req.response_format) {
          sawResponseFormat = true
          repairCallCount++
          cb.onTextDelta(validPacket('wo_json'))
          cb.onContentBlock(textBlock(validPacket('wo_json')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          return
        }
        // The AgentLoop also issues calls without response_format; only emit
        // invalid text the first time so repair triggers.
        cb.onTextDelta('definitely not json at all')
        cb.onContentBlock(textBlock('definitely not json at all'))
        cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
      }),
    } as unknown as StreamClient

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      forceJsonRepair: true,
      // 钉旧契约：本用例验证的是「修复轮」带 response_format——终型轮同样
      // 带 response_format 且会先跑，不钉死会让计数误把终型轮当修复轮。
      finalizeReport: false,
    })

    assert.equal(run.result.status, 'passed', 'json-mode repair should recover to passed')
    assert.ok(sawResponseFormat, 'repair request must carry response_format: json_object')
    assert.equal(repairCallCount, 1, 'exactly one json-mode repair call')
  })
})

describe('buildMaxTurnsExhaustedResult (2026-07-24 假 summary 事故)', () => {
  // classifyInfraFailure (review-coordinator-deps.ts) 的 budget 分流正则——
  // blocked summary 必须命中它，否则 review-router 会当瞬时故障重试（同预算必死）。
  const BUDGET_CLASSIFIER_RE = /max.?turns|exhausted without a final turn/i

  function makeOrder(id: string) {
    return createReadOnlyWorkOrder({
      id,
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review the wiring of the plan approval chain.',
      scope: {},
    })
  }

  function exploringTranscript(toolCalls: number): WorkerTranscript {
    return {
      text: '',
      thinking: '',
      toolUses: Array.from({ length: toolCalls }, (_, i) => (i % 2 === 0 ? 'read_file' : 'grep')),
      toolResults: [],
      errors: [],
      repairAttempts: 0,
    }
  }

  it('终轮已产出合法报告 → 返回 null（soft-landing 成功，走正常路径）', () => {
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt1'), exploringTranscript(8), validPacket('wo_mt1'), 12)
    assert.equal(result, null)
  })

  it('纯探索散文 → 结构化 budget blocked，绝不进修复梯', () => {
    const prose = '我需要检查提交的差异。先看 session-manager.ts 的 onToolResult……'
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt2'), exploringTranscript(21), prose, 12)
    assert.ok(result, 'expected a structured result')
    assert.equal(result!.status, 'blocked')
    assert.equal(result!.failureReason, 'max_turns')
    assert.match(result!.summary, /max-turns: exhausted without a final turn/)
    assert.match(result!.summary, /21 tool calls/)
    assert.match(result!.summary, BUDGET_CLASSIFIER_RE)
    // 半成品散文只作为 artifact 留痕，不进 summary（防"缺上下文"假象上桌）
    const note = result!.artifacts.find(a => a.title === 'Max-turns worker partial output')
    assert.ok(note, 'partial output preserved as artifact')
    assert.match(note!.content, /session-manager/)
  })

  it('空输出 + 停滞调用数（预算 12 只做 3 次调用）→ blocked 标 stalled，不附 partial artifact', () => {
    // 2026-08-10 空跑标记：预算 ≥4 轮却只做 ≤3 次工具调用 = 纯推理空转，
    // failureReason 标 'stalled' 而非 'max_turns'，让主控区分「空跑」与「没干完」。
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt3'), exploringTranscript(3), '   ', 12)
    assert.ok(result)
    assert.equal(result!.status, 'blocked')
    assert.equal(result!.failureReason, 'stalled')
    assert.match(result!.summary, /stalled: exhausted without a final turn/)
    assert.equal(result!.artifacts.some(a => a.title === 'Max-turns worker partial output'), false)
  })

  it('半成品报告可字段级抢救 → findings 保留 + max_turns 标注（不丢工作成果）', () => {
    // 一个 finding 的 "claim": 键名丢失 → 整体 JSON.parse 失败，但其余 finding 可独立抢救
    const malformed = `{
      "workOrderId": "wo_mt4",
      "status": "passed",
      "summary": "wiring 审查中间产物",
      "findings": [
        { "claim": "plan_submitted 事件断链", "evidence": "src/server/session-manager.ts:2101", "confidence": "high" },
        { 缺键名的坏对象" }
      ],
      "artifacts": [],
      "changedFiles": [],
      "risks": [],
      "nextActions": []
    }`
    const result = buildMaxTurnsExhaustedResult(makeOrder('wo_mt4'), exploringTranscript(15), malformed, 12)
    assert.ok(result)
    assert.equal(result!.failureReason, 'max_turns')
    assert.ok(result!.findings.length >= 1, 'salvaged findings preserved')
    assert.ok(
      result!.risks.some(r => BUDGET_CLASSIFIER_RE.test(r)),
      'budget marker present in risks for classifyInfraFailure routing',
    )
  })
})

describe('detectApprovalDeadlock', () => {
  function transcriptWithErrors(errors: string[]): WorkerTranscript {
    return { text: '', thinking: '', toolUses: [], toolResults: [], errors, repairAttempts: 0 }
  }

  it('drift guard: local marker matches the one tool-pipeline actually emits', () => {
    // worker-session keeps a local copy of the marker to avoid an import cycle;
    // if the two constants drift apart, deadlock detection silently goes blind.
    assert.equal(HEADLESS_DENY_MARKER, PIPELINE_HEADLESS_DENY_MARKER)
  })

  it('returns null when no headless denial appears in the transcript', () => {
    assert.equal(detectApprovalDeadlock(transcriptWithErrors([])), null)
    assert.equal(detectApprovalDeadlock(transcriptWithErrors(['some other tool error'])), null)
  })

  it('names the approval gate when headless denials are present', () => {
    const hint = detectApprovalDeadlock(transcriptWithErrors([
      `Tool "run_migration" is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
      'unrelated error',
      `Tool "run_migration" is ${HEADLESS_DENY_MARKER}: it requires an approval that no human can grant in this context.`,
    ]))
    assert.ok(hint, 'expected a diagnostic hint')
    assert.match(hint!, /2 approval-required tool call/)
    assert.match(hint!, /NOT malformed JSON/)
  })
})


describe('mutatedFiles capture (系统捕获 changedFiles)', () => {
  function toolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
    return { type: 'tool_use', id, name, input }
  }

  /** 每轮发一个 tool_use（未注册工具，loop 容错继续），末轮给结果 JSON。 */
  function clientWithToolUses(uses: Array<{ id: string; name: string; input: Record<string, unknown> }>, finalText: string): StreamClient {
    let index = 0
    const turns = [...uses, null]
    return {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        const use = turns[Math.min(index, turns.length - 1)]
        index++
        if (use) {
          cb.onContentBlock(toolUseBlock(use.id, use.name, use.input))
          cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
        } else {
          cb.onTextDelta(finalText)
          cb.onContentBlock(textBlock(finalText))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
  }

  it('captures edit_file/write_file/hash_edit file_path and apply_patch diff targets', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_mut',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Exercise mutatedFiles capture.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientWithToolUses([
        { id: 'tu_1', name: 'edit_file', input: { file_path: 'src/edited.ts' } },
        { id: 'tu_2', name: 'write_file', input: { file_path: 'src/written.ts' } },
        { id: 'tu_3', name: 'hash_edit', input: { file_path: 'src/hashed.ts' } },
        {
          id: 'tu_4',
          name: 'apply_patch',
          input: {
            diff: [
              '--- a/src/patched.ts',
              '+++ b/src/patched.ts',
              '@@ -1 +1 @@',
              '--- a/src/deleted.ts',
              '+++ /dev/null',
            ].join('\n'),
          },
        },
      ], validPacket('wo_mut')),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 8,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    // /dev/null（删除文件的 +++ 行）不算改动。
    assert.deepEqual(run.transcript.mutatedFiles, ['src/edited.ts', 'src/written.ts', 'src/hashed.ts', 'src/patched.ts'])
    // 成功路径已接 reconcile：捕获的改动并入自报为空的 changedFiles。
    assert.deepEqual(run.result.changedFiles, ['src/edited.ts', 'src/written.ts', 'src/hashed.ts', 'src/patched.ts'])
  })

  it('ignores write tools without a string file_path', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_mut_empty',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Exercise mutatedFiles capture guards.',
      scope: {},
    })

    const run = await runWorkerSession({
      order,
      client: clientWithToolUses([
        { id: 'tu_1', name: 'edit_file', input: { old_text: 'a', new_text: 'b' } },
        { id: 'tu_2', name: 'read_file', input: { file_path: 'src/read-only.ts' } },
      ], validPacket('wo_mut_empty')),
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 6,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.equal(run.result.status, 'passed')
    assert.deepEqual(run.transcript.mutatedFiles, [])
  })
})


/** 终轮定型（B：带完整会话历史的无工具收尾轮）。报告不再由探索轮自产，
 *  统一经收尾轮受约束通道产出；abort 不终型、max-turns 非自愿改终型、
 *  终型为空回退旧路径、parse 失败走原修复梯。 */
describe('worker finalization turn (B：终轮定型)', () => {
  interface CapturedRequest {
    messages: Array<{ role: string; content: unknown }>
    tools?: unknown
    tool_choice?: unknown
    response_format?: unknown
    max_tokens?: number
  }

  type ScriptEntry = string | { toolUse: { id: string; name: string; input: Record<string, unknown> } }

  /** 按脚本逐次应答的捕获 client——记录每个请求的 messages/tools/response_format，
   *  供终型轮形状断言。脚本耗尽后重复末条（与既有 clientFromTexts 同语义）。 */
  function capturingClient(script: ScriptEntry[]) {
    const requests: CapturedRequest[] = []
    let index = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        const entry = script[Math.min(index, script.length - 1)]!
        index++
        if (typeof entry === 'string') {
          if (entry) {
            cb.onTextDelta(entry)
            cb.onContentBlock(textBlock(entry))
          }
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else {
          cb.onContentBlock({ type: 'tool_use', id: entry.toolUse.id, name: entry.toolUse.name, input: entry.toolUse.input } as ContentBlock)
          cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
    return { client, requests }
  }

  function finalizeConfig(order: WorkOrder, client: StreamClient, over: Partial<WorkerSessionConfig> = {}): WorkerSessionConfig {
    return {
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      ...over,
    }
  }

  function scoutOrder(id: string, budget?: { maxTurns?: number; maxRetries?: number }): WorkOrder {
    return createReadOnlyWorkOrder({
      id,
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find the finalization seam.',
      scope: {},
      budget,
    })
  }

  function messageTexts(req: CapturedRequest): string {
    return req.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
  }

  type BlockScriptEntry = string | { blocks: ContentBlock[] }

  /** 支持任意 block 序列（散文 + 多 tool_use + argsTruncated）的捕获 client——
   *  供 submit_result 终型形状断言。脚本耗尽后重复末条（与 capturingClient 同语义）。 */
  function blockClient(script: BlockScriptEntry[]) {
    const requests: CapturedRequest[] = []
    let index = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        const entry = script[Math.min(index, script.length - 1)]!
        index++
        if (typeof entry === 'string') {
          if (entry) {
            cb.onTextDelta(entry)
            cb.onContentBlock(textBlock(entry))
          }
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else {
          for (const block of entry.blocks) cb.onContentBlock(block)
          cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
    return { client, requests }
  }

  /** 合规的 submit_result 工具参数（与 validPacket 同构）。 */
  function toolPacket(workOrderId: string): Record<string, unknown> {
    return {
      workOrderId,
      status: 'passed',
      summary: 'Report submitted via submit_result tool.',
      findings: [{ claim: 'Tool path works', evidence: 'tool_use block', confidence: 'high' }],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }
  }

  it('收尾轮 max_tokens 取报告档：未声明 = 16384；显式档（format_checker 4096）不被改写', async () => {
    // 审查补遗（0926f5b8d）：「报告实际拿到多少预算」原先只在工厂层有断言
    // （work-order.test.ts），消费端三处实参被改写不会变红——这里钉生产端实际值。
    const scoutReport =
      '{"workOrderId":"wo_budget_scout","status":"passed","summary":"报告档探针","findings":[],"artifacts":[],"changedFiles":[],"risks":[],"nextActions":[]}'
    const c1 = capturingClient(['prose only', scoutReport])
    await runWorkerSession(finalizeConfig(scoutOrder('wo_budget_scout'), c1.client))
    assert.equal(c1.requests[1]?.max_tokens, 16384, '未声明档（code_scout）收尾轮应发报告档 16384')
    assert.equal(c1.requests[2]?.max_tokens, 16384, '无工具 fallback 轮同档')

    const fmtOrder = createReadOnlyWorkOrder({
      id: 'wo_budget_fmt',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'format_checker',
      objective: 'probe format budget',
      scope: {},
    })
    const fmtReport =
      '{"workOrderId":"wo_budget_fmt","status":"passed","summary":"报告档探针","findings":[],"artifacts":[],"changedFiles":[],"risks":[],"nextActions":[]}'
    const c2 = capturingClient(['prose only', fmtReport])
    await runWorkerSession(finalizeConfig(fmtOrder, c2.client))
    assert.equal(c2.requests[1]?.max_tokens, 4096, '显式档（format_checker）不被兜底改写')
  })

  it('探索后发起终型轮：带完整会话历史、无 tools、json_object 随 forceJsonRepair', async () => {
    const order = scoutOrder('wo_fin')
    const { client, requests } = capturingClient([
      'I read src/agent/loop.ts and found the constructor seam.', // 探索：无 JSON 散文
      validPacket('wo_fin'), // 终型：合规报告
    ])
    const activities: Array<[WorkerActivityKind, string | undefined]> = []
    const run = await runWorkerSession(finalizeConfig(order, client, {
      forceJsonRepair: true,
      onActivity: (kind, detail) => activities.push([kind, detail]),
    }))

    assert.equal(run.result.status, 'passed', '自然输出无 JSON 也能经终型轮产出合规结果')
    assert.equal(requests.length, 3, '探索 + 终型工具轮 + fallback（工具轮零 tool-call 时）')
    // 阶段 1：唯一 submit_result 工具轮（带完整历史 + 收尾指令）
    const toolReq = requests[1]!
    const last = toolReq.messages.at(-1)!
    assert.equal(last.role, 'user')
    assert.ok(String(last.content).includes('工单 ID（原样复制）：wo_fin'), '尾消息是收尾指令')
    assert.ok(String(last.content).includes('只基于上方对话中实际发生的工具调用及其结果'))
    assert.deepEqual(
      toolReq.messages.slice(0, -1),
      run.session.getMessages(),
      '终型轮 messages 前缀必须等于 worker 会话历史（前缀缓存命中 + 只准如实总结）',
    )
    assert.ok(Array.isArray(toolReq.tools) && toolReq.tools.length === 1, '工具轮带唯一 submit_result 定义')
    assert.deepEqual(toolReq.tool_choice, { type: 'function', function: { name: 'submit_result' } })
    // 阶段 2（fallback）：零 tool-call → 无工具 json_object 终型
    const fallbackReq = requests[2]!
    assert.equal(fallbackReq.tools, undefined, 'fallback 轮不带 tools')
    assert.deepEqual(fallbackReq.response_format, { type: 'json_object' }, 'json_object 随 forceJsonRepair 门')
    // 主提示词已切 finalized 契约（不再要求探索轮自产 JSON）
    assert.ok(messageTexts(requests[0]!).includes('无需自己输出报告 JSON'), '探索轮主提示词是 finalized 契约')
    // 保活：收尾开始发 lifecycle，delta 转发 text（stall clock 不吃空）
    assert.ok(activities.some(([k, d]) => k === 'lifecycle' && d === 'finalizing report'))
    assert.ok(activities.some(([k]) => k === 'text'))
  })

  it('forceJsonRepair 未开时终型轮退化为无 json_object 的收尾（仍无工具+带历史）', async () => {
    const order = scoutOrder('wo_fin_gate')
    const { client, requests } = capturingClient(['exploration prose', validPacket('wo_fin_gate')])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(requests.length, 3, '探索 + 工具轮 + fallback')
    assert.equal(requests[2]!.response_format, undefined, 'provider 门未开时 fallback 不带 response_format')
    assert.equal(requests[2]!.tools, undefined, 'fallback 仍是无工具收尾')
    assert.ok(String(requests[1]!.messages.at(-1)!.content).includes('工单 ID'), '工具轮收尾指令照发')
  })

  it('provider 拒绝 response_format：立即不带它重试收尾轮，并关闭本会话 json 通道', async () => {
    const order = scoutOrder('wo_probe')
    const requests: CapturedRequest[] = []
    let call = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        call++
        if (call === 1) {
          // 探索轮：散文无 JSON
          cb.onTextDelta('exploration prose')
          cb.onContentBlock(textBlock('exploration prose'))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else if (call === 2) {
          // 终型工具轮：模型没调 submit_result（纯文本）→ 零 tool-call → fallback
          cb.onTextDelta('model refused tool call')
          cb.onContentBlock(textBlock('model refused tool call'))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else if (call === 3) {
          // fallback 轮带 response_format——严格 provider 直接 400 拒绝未知参数
          cb.onError(new Error('HTTP 400: Unknown parameter: `response_format` is not supported'))
        } else {
          // 探针重试（不带 response_format）成功产出合规报告
          cb.onTextDelta(validPacket('wo_probe'))
          cb.onContentBlock(textBlock(validPacket('wo_probe')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
    const activities: Array<[WorkerActivityKind, string | undefined]> = []
    const config = finalizeConfig(order, client, {
      forceJsonRepair: true,
      onActivity: (kind, detail) => activities.push([kind, detail]),
    })
    const run = await runWorkerSession(config)

    assert.equal(run.result.status, 'passed', '探针重试救回收尾轮——被拒的整轮不白烧')
    assert.equal(requests.length, 4, '探索 + 工具轮 + 被拒 fallback + 无 response_format 重试')
    assert.ok(Array.isArray(requests[1]!.tools), '工具轮先发 submit_result 定义')
    assert.deepEqual(requests[2]!.response_format, { type: 'json_object' }, 'fallback 乐观带 json_object')
    assert.equal(requests[3]!.response_format, undefined, '被拒后立即不带 response_format 重试')
    assert.equal(config.forceJsonRepair, false, '会话级关闭 json 通道——后续 repair 轮不再白试')
    assert.ok(activities.some(([k, d]) => k === 'lifecycle' && String(d).includes('rejected response_format')))
  })

  it('瞬断不误判为 response_format 拒绝：json 通道保持开启', async () => {
    const order = scoutOrder('wo_probe_net')
    // 收尾轮网络错误（无 response_format 字样）→ 探针不触发，回退旧路径
    const requests: CapturedRequest[] = []
    let call = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        call++
        if (call === 1) {
          const natural = JSON.stringify({
            workOrderId: 'wo_probe_net',
            status: 'passed',
            summary: 'report from exploration text after finalize network failure',
            findings: [],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
          })
          cb.onTextDelta(natural)
          cb.onContentBlock(textBlock(natural))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else {
          cb.onError(new Error('socket hang up'))
        }
      }),
    } as unknown as StreamClient
    const config = finalizeConfig(order, client, { forceJsonRepair: true })
    const run = await runWorkerSession(config)

    assert.equal(requests.length, 3, '工具轮 + fallback 都瞬断，不再重试（回退 parse 自然输出）')
    assert.equal(config.forceJsonRepair, true, '网络错误不关闭 json 通道')
    assert.equal(run.result.status, 'passed')
  })

  it('终型输出 parse 失败 → 落入原有修复梯', async () => {
    const order = scoutOrder('wo_fin_repair', { maxRetries: 1 })
    const { client, requests } = capturingClient([
      'exploration prose, no JSON',
      'finalized but still not json', // 终型工具轮：零 tool-call → fallback
      'finalized but still not json', // fallback 轮：parse 失败 → 落入修复梯
      validPacket('wo_fin_repair'), // 修复轮救回
    ])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1, '终型失败后的修复梯照走')
    assert.equal(requests.length, 4, '探索 + 工具轮 + fallback + 修复')
  })

  it('终型返回空 → 回退旧路径（parse 自然输出）', async () => {
    const order = scoutOrder('wo_fin_empty')
    const natural = JSON.stringify({
      workOrderId: 'wo_fin_empty',
      status: 'passed',
      summary: 'report recovered from exploration text',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    })
    const { client, requests } = capturingClient([natural, '   ']) // 终型空输出
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.result.summary, 'report recovered from exploration text', '结果来自自然输出而非终型')
    assert.equal(requests.length, 3, '工具轮 + fallback 各试过一次才回退 parse 自然输出')
    assert.equal(run.transcript.repairAttempts, 0, '自然输出本就合规，不进修复梯')
  })

  it('max-turns 非自愿耗尽 → 终型成功即正常返回（不再一律 blocked）', async () => {
    const order = scoutOrder('wo_fin_mt', { maxTurns: 1, maxRetries: 0 })
    const { client, requests } = capturingClient([
      { toolUse: { id: 'tu_1', name: 'grep', input: { pattern: 'seam' } } }, // 唯一一轮耗在工具上
      validPacket('wo_fin_mt'), // 终型轮如实产出
    ])
    const run = await runWorkerSession(finalizeConfig(order, client, { maxTurns: 1 }))

    assert.equal(run.result.status, 'passed', '终型成功即正常返回')
    assert.equal(run.result.failureReason, undefined, '不再盖章 max_turns')
    assert.equal(requests.length, 3, '探索 1 次 + 工具轮 + fallback 各 1 次（旧路径此处直接 blocked）')
  })

  it('max-turns 非自愿耗尽 + 终型失败 → 回退确定性 max-turns 阶梯', async () => {
    const order = scoutOrder('wo_fin_mt_fail', { maxTurns: 1, maxRetries: 0 })
    const { client, requests } = capturingClient([
      { toolUse: { id: 'tu_1', name: 'grep', input: { pattern: 'seam' } } },
      '', // 终型流失败/空
    ])
    const run = await runWorkerSession(finalizeConfig(order, client, { maxTurns: 1 }))

    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'max_turns')
    assert.match(run.result.summary, /max-turns: exhausted without a final turn/)
    assert.equal(requests.length, 3, '探索 + 工具轮 + fallback 失败后才回退，不进修复梯')
  })

  it('abort → 不发起终型调用（abort 绝对优先）', async () => {
    const order = scoutOrder('wo_fin_abort', { maxRetries: 1 })
    const controller = new AbortController()
    let streamCalls = 0
    let streamStarted!: () => void
    const started = new Promise<void>(r => { streamStarted = r })
    // 挂起直到 abort 的卡死流（镜像 fault-client 的 idle_stall）
    const client = {
      stream: mock.fn(async (_req: unknown, _cb: StreamCallbacks, signal?: AbortSignal) => {
        streamCalls++
        streamStarted()
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
    } as unknown as StreamClient
    const p = runWorkerSession(finalizeConfig(order, client, { abortSignal: controller.signal }))
    // 等第一次 stream 真正进入挂起态再 abort——固定 50ms 延时在慢环境（Windows
    // 冷启动/负载下初始化 >50ms）会抢跑于首次调用，streamCalls=0 假失败。
    await started
    controller.abort()
    const run = await p

    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'caller_aborted')
    assert.equal(streamCalls, 1, 'abort 后不再花 API——终型轮也没有')
  })

  it('finalizeReport: false → 完全旧行为（inline 契约、无收尾轮、修复梯照旧）', async () => {
    const order = scoutOrder('wo_fin_off', { maxRetries: 1 })
    const { client, requests } = capturingClient(['prose, no json', validPacket('wo_fin_off')])
    const run = await runWorkerSession(finalizeConfig(order, client, { finalizeReport: false }))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.transcript.repairAttempts, 1, '旧路径：parse 失败走修复梯')
    assert.equal(requests.length, 2, '无终型轮：探索 + 修复')
    for (const req of requests) {
      assert.ok(!String(req.messages.at(-1)!.content).includes('只基于上方对话中实际发生的工具调用及其结果'), '任何请求都不含收尾指令')
    }
    assert.ok(messageTexts(requests[0]!).includes('只返回一个 JSON 对象'), '主提示词回到 inline 契约')
  })

  it('soft-landing steer 按契约分体', () => {
    const finalized = createSoftLandingDrain(undefined, 'finalized')
    finalized.requestWrapUp()
    const steer = finalized.drain()
    assert.ok(steer?.includes('requested separately'), 'finalized：报告由系统单独索取')
    assert.ok(!steer!.includes('emit your final report as a single valid JSON object'), 'finalized 不再催自产 JSON')

    const inline = createSoftLandingDrain()
    inline.requestWrapUp()
    assert.ok(inline.drain()?.includes('emit your final report as a single valid JSON object'), 'inline 契约文案不变')
  })

  it('终型轮强制 submit_result：唯一工具调用参数过权威校验即成功，伴随散文忽略', async () => {
    const order = scoutOrder('wo_submit')
    const { client, requests } = blockClient([
      'exploration prose',
      { blocks: [
        textBlock('Ignored prose next to the tool call.'),
        { type: 'tool_use', id: 'tu_submit', name: 'submit_result', input: toolPacket('wo_submit') } as ContentBlock,
      ] },
    ])
    const run = await runWorkerSession(finalizeConfig(order, client, { forceJsonRepair: true }))

    assert.equal(run.result.status, 'passed')
    assert.equal(run.result.summary, 'Report submitted via submit_result tool.', '结果来自工具参数而非散文')
    assert.equal(requests.length, 2, '工具路径成功：探索 + 终型工具轮，无 fallback 轮')
    const finalizeReq = requests[1]!
    // 唯一工具定义 + forced tool_choice（OAI 对象形式）
    assert.ok(Array.isArray(finalizeReq.tools) && finalizeReq.tools.length === 1, '恰好一个工具定义')
    const tool = (finalizeReq.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>)[0]!
    assert.equal(tool.function.name, 'submit_result')
    const params = tool.function.parameters as { type: string; properties: Record<string, unknown>; required?: string[] }
    assert.equal(params.type, 'object')
    assert.ok(params.properties.workOrderId, 'parameters 是 ingest 同源 JSON Schema（含 workOrderId）')
    assert.ok(params.properties.status, 'parameters 含 status 枚举')
    assert.deepEqual(finalizeReq.tool_choice, { type: 'function', function: { name: 'submit_result' } })
    // 收尾指令照发 + 带完整会话历史
    assert.ok(String(finalizeReq.messages.at(-1)!.content).includes('工单 ID（原样复制）：wo_submit'))
    assert.deepEqual(finalizeReq.messages.slice(0, -1), run.session.getMessages(), '终型轮 messages 前缀仍等于会话历史')
  })

  it('终型轮零 tool-call → 回退无工具 json_object 终型（fallback 一次）', async () => {
    const order = scoutOrder('wo_submit_zero')
    const { client, requests } = blockClient([
      'exploration prose',
      'model emitted prose instead of calling submit_result', // 工具轮零 tool-call
      validPacket('wo_submit_zero'), // fallback 轮合规产出
    ])
    const run = await runWorkerSession(finalizeConfig(order, client, { forceJsonRepair: true }))

    assert.equal(run.result.status, 'passed')
    assert.equal(requests.length, 3, '探索 + 工具轮 + fallback 轮')
    const toolReq = requests[1]!
    assert.ok(Array.isArray(toolReq.tools) && toolReq.tools.length === 1, '工具轮带唯一 submit_result 定义')
    const fallbackReq = requests[2]!
    assert.equal(fallbackReq.tools, undefined, 'fallback 轮无工具')
    assert.deepEqual(fallbackReq.response_format, { type: 'json_object' }, 'fallback 走 json_object 终型')
  })

  it('终型轮多 tool-call → 回退无工具终型', async () => {
    const order = scoutOrder('wo_submit_multi')
    const { client, requests } = blockClient([
      'exploration prose',
      { blocks: [
        { type: 'tool_use', id: 'tu_grep', name: 'grep', input: { pattern: 'x' } } as ContentBlock,
        { type: 'tool_use', id: 'tu_submit', name: 'submit_result', input: toolPacket('wo_submit_multi') } as ContentBlock,
      ] },
      validPacket('wo_submit_multi'),
    ])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(requests.length, 3, '探索 + 工具轮(多调用) + fallback 轮')
    assert.equal(requests[2]!.tools, undefined)
  })

  it('终型轮截断参数（argsTruncated）→ 回退无工具终型', async () => {
    const order = scoutOrder('wo_submit_trunc')
    const { client, requests } = blockClient([
      'exploration prose',
      { blocks: [
        { type: 'tool_use', id: 'tu_submit', name: 'submit_result', input: { workOrderId: 'wo_submit_trunc' }, argsTruncated: true } as ContentBlock,
      ] },
      validPacket('wo_submit_trunc'),
    ])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(requests.length, 3, '探索 + 工具轮(截断) + fallback 轮')
    assert.equal(requests[2]!.tools, undefined)
  })

  it('终型工具轮 provider 拒绝 → 回退无工具终型，forceJsonRepair 通道保留', async () => {
    const order = scoutOrder('wo_submit_reject')
    const requests: CapturedRequest[] = []
    let call = 0
    const client = {
      stream: mock.fn(async (req: CapturedRequest, cb: StreamCallbacks) => {
        requests.push(req)
        call++
        if (call === 1) {
          cb.onTextDelta('exploration prose')
          cb.onContentBlock(textBlock('exploration prose'))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        } else if (call === 2) {
          // 工具轮：provider 拒绝 tools/tool_choice 参数。
          cb.onError(new Error('HTTP 400: Unknown parameter: `tools` is not supported by this endpoint'))
        } else {
          cb.onTextDelta(validPacket('wo_submit_reject'))
          cb.onContentBlock(textBlock(validPacket('wo_submit_reject')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }
      }),
    } as unknown as StreamClient
    const config = finalizeConfig(order, client, { forceJsonRepair: true })
    const run = await runWorkerSession(config)

    assert.equal(run.result.status, 'passed', '工具被拒后 fallback 救回收尾轮')
    assert.equal(requests.length, 3, '探索 + 工具轮(被拒) + fallback 轮')
    assert.ok(Array.isArray(requests[1]!.tools), '工具轮带 submit_result 定义')
    assert.equal(requests[2]!.tools, undefined, 'fallback 轮无工具')
    assert.deepEqual(requests[2]!.response_format, { type: 'json_object' })
    assert.equal(config.forceJsonRepair, true, '工具被拒不关闭 json 通道——json 通道只管 response_format')
  })

  it('submit_result 路径不绕过证据门：自报 changedFiles 无系统捕获痕迹 → verified 降级', async () => {
    const order = scoutOrder('wo_submit_ev')
    const input = toolPacket('wo_submit_ev')
    input.changedFiles = ['src/fabricated.ts']
    input.evidenceStatus = 'verified'
    const { client, requests } = blockClient([
      'exploration prose',
      { blocks: [
        { type: 'tool_use', id: 'tu_submit', name: 'submit_result', input } as ContentBlock,
      ] },
    ])
    const run = await runWorkerSession(finalizeConfig(order, client))

    assert.equal(run.result.status, 'passed')
    assert.equal(requests.length, 2, '工具路径成功（reconcile 不触发 fallback）')
    assert.equal(run.result.evidenceStatus, 'unverified', '自报 verified 但 changedFiles 无工具调用痕迹 → 对账降级，证据门未被绕过')
    assert.ok(run.result.risks.some((r) => String(r).includes('src/fabricated.ts')), '无痕迹文件被记 risk')
  })
})

/** 收尾轮截断（2026-09-13 两例 review worker json_parse 事故）——
 *  长报告在 max_tokens 处被截断成未闭合 JSON，parse 必失败；截断这一
 *  真实原因必须透传到失败结果的 risks，而不是被 salvage 的笼统 summary 吞掉。 */
describe('finalize truncation (2026-09-13 json_parse 事故)', () => {
  it('isTruncationStopReason：mapFinishReason 归一的截断值命中，其余不误报', () => {
    assert.equal(isTruncationStopReason('max_tokens'), true) // openai finish_reason='length' 的归一值
    assert.equal(isTruncationStopReason('length'), true) // 原始 finish_reason 直通也认
    assert.equal(isTruncationStopReason('end_turn'), false)
    assert.equal(isTruncationStopReason('tool_use'), false)
    assert.equal(isTruncationStopReason(undefined), false)
  })

  it('收尾轮被 max_tokens 截断 → 失败结果带截断标记（事故现场回归）', async () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_trunc',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review a report that overflows the output budget.',
      scope: {},
      budget: { maxRetries: 0 },
    })
    // 未闭合的长报告：首条 finding 完整可打捞，尾部在 max_tokens 处断开
    const truncatedJson =
      '{"workOrderId":"wo_trunc","status":"passed","summary":"长报告","findings":[' +
      '{"claim":"缺陷一","evidence":"src/a.ts:1","confidence":"high"},{"claim":"缺陷'
    let call = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        call++
        if (call === 1) {
          // 探索轮：无 JSON 散文
          cb.onTextDelta('Let me read the diff first.')
          cb.onContentBlock(textBlock('Let me read the diff first.'))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          return
        }
        if (call === 2) {
          // 终型阶段 1（submit_result 工具轮）：零 tool-call → 回退阶段 2
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          return
        }
        // 终型阶段 2：输出在 max_tokens 处被截断
        cb.onTextDelta(truncatedJson)
        cb.onContentBlock(textBlock(truncatedJson))
        cb.onStopReason('max_tokens', { input_tokens: 10, output_tokens: 4096 })
      }),
    } as unknown as StreamClient

    const run = await runWorkerSession({
      order,
      client,
      promptEngine: makePromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })

    assert.notEqual(run.result.status, 'passed')
    assert.ok(
      run.result.risks.some(r => /truncated at max_tokens/i.test(r)),
      `截断事实必须出现在 risks（实际 ${JSON.stringify(run.result.risks)}）`,
    )
  })
})

describe('worker doom-loop gate（回归锁定：worker 与主循环共用同一指纹闸）', () => {
  it('worker 内同一失败调用循环被 doom 闸锁死：执行次数有界', async () => {
    let executeCount = 0
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'grep', description: 'fake grep', input_schema: { type: 'object', properties: {} } },
      execute: async () => { executeCount++; return { content: 'boom: pattern exploded', isError: true } },
      requiresApproval: () => false,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
    } as never)
    let toolCallSeq = 0
    const client = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        // 模型死不悔改：永远重发同一失败调用（doom-loop 最纯粹形态）。
        // doom 闸生效 → 后续调用被预执行拦截，executeCount 停在 ~7；
        // 不生效 → 每次都真执行，executeCount 烧到 maxTurns。
        toolCallSeq++
        cb.onContentBlock({ type: 'tool_use', id: `tu_${toolCallSeq}`, name: 'grep', input: { pattern: 'same-pattern' } } as ContentBlock)
        cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
      }),
    } as unknown as StreamClient
    const order = createReadOnlyWorkOrder({
      id: 'wo_doom', parentTurnId: 'turn_1', kind: 'code_search', profile: 'code_scout',
      objective: 'Probe doom gate wiring in worker.', scope: {},
      budget: { maxTurns: 15, maxRetries: 0 },
    })
    await runWorkerSession({
      order, client, promptEngine: makePromptEngine(), toolRegistry: registry,
      cwd: '/repo', maxTurns: 15, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    })
    assert.ok(
      executeCount <= 8,
      `doom 闸应在 ~7 次内锁死失败循环；实际执行了 ${executeCount} 次（maxTurns=15）——worker 内闸门未接线`,
    )
  })
})

describe('worker long-tool keepalive（P0-3：tool_use→tool_result 静默窗不再裸奔）', () => {
  it('工具执行期间周期性发 lifecycle 心跳喂 liveness', async () => {
    __setToolKeepaliveMs(15)
    try {
      const registry = new ToolRegistry()
      registry.register({
        definition: { name: 'slow_probe', description: 'fake slow tool', input_schema: { type: 'object', properties: {} } },
        execute: async () => { await new Promise((r) => setTimeout(r, 120)); return { content: 'done' } },
        requiresApproval: () => false,
        isConcurrencySafe: () => true,
        isEnabled: () => true,
      } as never)
      let call = 0
      const client = {
        stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
          call++
          if (call === 1) {
            cb.onContentBlock({ type: 'tool_use', id: 'tu_slow', name: 'slow_probe', input: {} } as ContentBlock)
            cb.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
          } else {
            cb.onTextDelta(validPacket('wo_keep'))
            cb.onContentBlock(textBlock(validPacket('wo_keep')))
            cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
          }
        }),
      } as unknown as StreamClient
      const order = createReadOnlyWorkOrder({
        id: 'wo_keep', parentTurnId: 'turn_1', kind: 'code_search', profile: 'code_scout',
        objective: 'Probe keepalive during a slow tool.', scope: {},
        budget: { maxTurns: 4, maxRetries: 0 },
      })
      const activities: Array<[WorkerActivityKind, string | undefined]> = []
      const run = await runWorkerSession({
        order, client, promptEngine: makePromptEngine(), toolRegistry: registry,
        cwd: '/repo', maxTurns: 4, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        onActivity: (kind, detail) => activities.push([kind, detail]),
      })
      assert.equal(run.result.status, 'passed')
      const beats = activities.filter(([k, d]) => k === 'lifecycle' && String(d).startsWith('tool still running: slow_probe'))
      assert.ok(beats.length >= 2, `120ms 工具执行 + 15ms 节拍应产出多次心跳，实际 ${beats.length} 次`)
    } finally {
      __setToolKeepaliveMs(30_000)
    }
  })

  it('模型等待首字节期间也发 lifecycle 心跳', async () => {
    __setToolKeepaliveMs(15)
    try {
      let calls = 0
      const client = {
        stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
          calls++
          await new Promise(resolve => setTimeout(resolve, 70))
          cb.onTextDelta(validPacket('wo_first_byte'))
          cb.onContentBlock(textBlock(validPacket('wo_first_byte')))
          cb.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        }),
      } as unknown as StreamClient
      const order = createReadOnlyWorkOrder({
        id: 'wo_first_byte', parentTurnId: 'turn_1', kind: 'code_search', profile: 'code_scout',
        objective: 'Probe first-byte keepalive.', scope: {}, budget: { maxTurns: 1, maxRetries: 0 },
      })
      const activities: Array<[WorkerActivityKind, string | undefined]> = []
      const run = await runWorkerSession({
        order, client, promptEngine: makePromptEngine(), toolRegistry: new ToolRegistry(),
        cwd: '/repo', maxTurns: 1, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        finalizeReport: false,
        onActivity: (kind, detail) => activities.push([kind, detail]),
      })
      assert.equal(calls, 1)
      assert.equal(run.result.status, 'passed')
      assert.ok(
        activities.some(([kind, detail]) => kind === 'lifecycle' && String(detail).includes('waiting for first response')),
        'provider first-byte wait must be visible as a lifecycle heartbeat',
      )
    } finally {
      __setToolKeepaliveMs(30_000)
    }
  })
})

describe('runWorkerSession · priorUsage 回种（usage-ledger 对齐）', () => {
  it('续跑轮回种前轮用量：meta 单调递增到派发累计，返回值保持本轮净增', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-prior-usage-'))
    const prevHome = process.env.RIVET_HOME
    const prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_HOME = home
    delete process.env.RIVET_SESSION_DIR
    try {
      const order = createReadOnlyWorkOrder({
        id: 'wo_seed',
        parentTurnId: 'turn_1',
        kind: 'code_search',
        profile: 'code_scout',
        objective: 'Verify priorUsage seeding across continuation rounds.',
        scope: {},
      })
      const base = {
        order,
        client: clientFromTexts([validPacket('wo_seed')]),
        promptEngine: makePromptEngine(),
        toolRegistry: new ToolRegistry(),
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        finalizeReport: false,
      }
      // 首轮：无回种。返回净增；meta 记下首轮量。
      const round1 = await runWorkerSession(base)
      assert.ok(round1.usage.input_tokens > 0, 'mock client 每次调用报 10 input，首轮必须有量')
      // 每次读取都用全新实例——metaStore 有内存缓存，复用实例会读到旧快照。
      const readMeta = () => new SessionPersist(deriveWorkerSessionId(order.id), '/repo').loadMetadata()
      const meta1 = readMeta()
      assert.ok(meta1?.tokenUsage, '首轮应写 tokenUsage')
      const meta1Prompt = meta1!.tokenUsage!.prompt

      // 续跑轮：priorUsage = 首轮净增（coordinator 的 dispatchUsage 语义）。
      // 同一 orderId + 默认 nonce → 同一 meta 文件；回种后 meta.prompt 应叠加而非回零。
      const round2 = await runWorkerSession({ ...base, priorUsage: round1.usage })
      const meta2 = readMeta()
      const meta2Prompt = meta2!.tokenUsage!.prompt

      assert.equal(
        meta2Prompt,
        meta1Prompt + round2.usage.input_tokens,
        'meta.prompt 应为 回种(首轮) + 本轮净增，而非回零重计',
      )
      assert.ok(meta2Prompt > meta1Prompt, 'meta 必须单调递增')
      assert.equal(round2.usage.input_tokens, round1.usage.input_tokens, '同形 worker 两轮净增应相等')
      assert.equal(meta2!.status, 'completed', 'wrapper 终态应落盘（收尾 flush）')
    } finally {
      if (prevHome === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = prevHome
      if (prevSessionDir !== undefined) process.env.RIVET_SESSION_DIR = prevSessionDir
      rmSync(home, { recursive: true, force: true })
    }
  })
})
