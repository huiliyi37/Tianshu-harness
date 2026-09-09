import type { StreamClient } from '../api/stream-client.js'
import type { ContentBlockToolUse, Usage } from '../api/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { CompactionConfig } from '../compact/constants.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { AgentLoop } from './loop.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { classifyFailure, isTransient } from './failure-classifier.js'
import {
  WORKER_RESULT_SUBMIT_SCHEMA,
  buildBlockedWorkerResult,
  clampWorkerMaxTurns,
  classifyWorkerParseError,
  deriveWorkerSessionId,
  parseWorkerResult,
  salvageWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { STALL_TOOL_CALL_THRESHOLD, subtractUsage } from './worker-continuation.js'
import { clearActivity } from './stall-observer.js'
import { toolArgSummary } from '../tui/tool-label.js'
import { buildWorkerPrompt, buildWorkerRepairPrompt, buildFinalizationInstruction, workerOrderHasWriteTools } from './worker-prompts.js'
import { reconcileCapturedWorkerFacts } from './worker-evidence.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
import { buildDomainKnowledgeBlock, formatBatchStigmergyBlock } from './domain-knowledge-block.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import type { WorkerMailbox } from './worker-mailbox.js'
import { createWorkerMailboxSender } from './worker-mailbox.js'

/** Max transient-retry attempts for network/API errors during worker execution.
 *  Independent of order.budget.maxRetries (which covers output parse failures). */
const MAX_TRANSIENT_RETRIES = 2
const TRANSIENT_BACKOFF_BASE_MS = 2_000

/** Worker read cap (2026-07-24 max-turns 诊断): workers run compact-disabled
 *  on 1M windows, where the window-derived cap is 120K chars — one uncapped
 *  full-file read (50K chars observed) stays in history and is re-sent every
 *  turn until the turn budget dies. 16K (~主控 cap 的 1/7.5) still fits any
 *  focused offset/limit slice; oversized full reads degrade to the fold
 *  skeleton + navigation hints instead (see read-file.ts), teaching the model
 *  where to re-read precisely. Head/tail split mirrors computeModelReadCap
 *  (60% / 30%, 10% marker buffer). */
const WORKER_READ_CAP: import('../tools/model-read-cap.js').ModelReadCap = {
  maxChars: 16_000,
  headChars: 9_600,
  tailChars: 4_800,
}

/** Checkpoint saved from a previous worker run — allows Flash workers to resume
 *  from their last successful turn instead of redoing all work on retry. */
export interface WorkerCheckpoint {
  /** 0-based index of the last successfully completed turn. */
  turnIndex: number
  /** Accumulated partial output from completed turns. */
  partialResult: string
  /** Tool calls completed (for audit/dedup). */
  completedTools: string[]
}

/** buildWorkerRuntime 的路由决策投影（子进程重建 client/promptEngine 的依据）。 */
export interface WorkerRuntimeDecision {
  providerName: string
  model: string
  maxTokens: number
  contextWindow: number
  thinkingBudget: number
  isWrite: boolean
}

export interface WorkerSessionConfig {
  order: WorkOrder
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  /** 子代理块策略（subagentPromptBlocks）——loop 内描述档位/块预算消费。
   *  历史上 bootstrap runtimeFactory 一直设置但接口漏声明（tsc 基线 3 条债），
   *  worker-runtime.ts 抽出时补正。 */
  blockPolicy?: import('../prompt/block-policy.js').PromptBlockPolicy
  /** 子进程隔离协议（worker-process v1）：runtimeFactory 路由决策的可序列化
   *  投影。buildWorkerRuntime 三分支盖戳；OOP 运行器据此让子进程忠实重建
   *  client/promptEngine——子进程不重跑路由，防父/子两端决策漂移。
   *  进程内路径不消费，缺席不影响行为。 */
  runtimeDecision?: WorkerRuntimeDecision
  /** Provider key used for this worker run (e.g. 'deepseek', 'openai'). */
  providerName?: string
  /** Worker 端点 baseUrl 与显式慢思考声明——供 deriveWorkerStallMs 的
   *  isSlowThinkingProvider 三级判定（名称/URL/配置），自定义 provider 名
   *  不再漏判慢速窗口。 */
  baseUrl?: string
  slowThinking?: boolean
  /** Whether to use response_format: json_object on the repair turn (when the
   *  provider supports it) to force valid JSON output. The repair turn is a
   *  tool-free single-shot request, so json_object does not conflict with
   *  function calling (unlike normal turns where tools + json_object cause
   *  duplicate/spurious output). Also gates json_object on the B 终轮定型
   *  finalization turn (finalizeWorkerReport) — same tool-free shape, same
   *  provider-capability semantics. */
  forceJsonRepair?: boolean
  /** B（终轮定型）：探索循环结束后，由系统发起一个带完整会话历史、无工具、
   *  json_object（随 forceJsonRepair 门）的收尾轮，把报告统一挤经受约束通道——
   *  根治 2026-07-24 无历史修复编造假 summary 事故。默认 true（undefined 即开）；
   *  coordinator 在 RIVET_WORKER_FINALIZE=0 时传 false，回退旧契约
   *  （主提示词内联 JSON、无收尾轮）。 */
  finalizeReport?: boolean
  activeClaims?: import('../context/claims.js').ContextClaim[]
  /** Review-router re-entrancy depth propagated to worker tool calls. */
  reviewDepth?: number
  /** Parent abort signal — propagated to worker AgentLoop for immediate abort. */
  abortSignal?: AbortSignal
  /** Approval mode of the dispatching (parent) session. Only `dangerously-skip-permissions`
   *  is honored here as a downward delegation of trust — it lets the worker inherit the
   *  parent's opt-out of all prompts. Any other parent mode is ignored; the worker relies on
   *  headless approval semantics (in-workspace writes auto-approved, other asks fast-denied)
   *  rather than the parent's manual/auto-safe gating, since no human is attached to a worker. */
  parentApprovalMode?: import('./loop-types.js').ApprovalMode
  /** V3 Component B: optional per-domain lessons recalled into worker prompt. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Liveness signal — fired on every worker activity (text/thinking/tool)
   *  so the coordinator can feed a stall clock and the UI can show progress.
   *  Without this the worker's internal heartbeat fires into the void.
   *  `detail` carries the tool name for tool events and the delta for text. */
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void
  /** WC: 输入直达通道 — coordinator 注入的 per-order steer 队列 drain。
   *  worker 的 AgentLoop 在工具回合结算时调用，把用户直达消息以
   *  [User guidance] 形态注入 tool_result（与主会话 steer 同一机制）。 */
  onSteerDrain?: () => string | null
  /** 运行中转录快照通道 — session 建好后上报一次消息 getter。coordinator 把它
   *  注册进 per-order 表，服务端 getWorkerLog 借此在 saveWorkerSession 终态
   *  落盘之前就能读到活转录（续跑/重试每次新 session 会再上报、覆盖旧 getter）。 */
  onSessionReady?: (getMessages: () => readonly import('../api/oai-types.js').OaiMessage[]) => void
  /** 嵌套委派上行通道 — 本 worker 自己再调 delegate_task/delegate_batch 时，
   *  sub-worker 的 DelegationActivity 经 worker AgentLoop 的
   *  onDelegationActivity 回调流到这里。不接就是历史行为：嵌套 worker 对
   *  UI 完全不可见。coordinator 注入时会盖 parentWorkerId 戳（本 order id）。 */
  onNestedDelegation?: (activity: import('../tools/types.js').DelegationActivity) => void
  /** Resume from a previous checkpoint — inject partial results as context so
   *  the worker doesn't redo completed work. Especially valuable for multi-turn
   *  Flash workers (test_scaffolder generating multiple files). */
  checkpoint?: WorkerCheckpoint
  /** Structured mailbox for inter-agent communication. Worker tools can send
   *  progress, findings, and escalations through this channel. The coordinator
   *  drains the mailbox after the wave completes. */
  mailbox?: WorkerMailbox
  /** Batch-scoped shared PrewarmCache (delegateBatch 注入)——同批 worker 共享
   *  派发前预热与彼此读热的文件条目。缺省 undefined 时 worker 用 AgentLoop
   *  实例自带的隔离 cache（历史行为，单发 delegate 路径）。 */
  prewarm?: import('./prewarm.js').PrewarmCache
  /** Batch-scoped shared StigmergyStore（星河收编 #3，delegateBatch 注入）。
   *  同批 worker 共享内存信息素库：先完成的 worker 沉积的信号被后启动的
   *  worker 读到（prompt 知识块附加）。缺省 undefined → worker 用自己
   *  sessionDir 的持久化 store（历史行为）。 */
  stigmergy?: import('../context/stigmergy.js').StigmergyStore
  /** Prior conversation history to resume from. When provided, the session is
   *  pre-seeded with these messages before the first agent.run(), so the worker
   *  sees its previous context. The current objective is appended as a new user
   *  message on top of the history. */
  priorMessages?: readonly import('../api/oai-types.js').OaiMessage[]
  /** Prior rounds' cumulative token usage for the SAME worker session file
   *  (usage-ledger alignment, 2026-08-18). Every cross-round re-entry of the
   *  same dispatch — continuation, retry, escalation, summary expansion —
   *  reuses the sessionId (same order.id + nonce) and therefore the same
   *  `<sid>.meta.json` / `<sid>/cache-log.jsonl`. cache-log is append-only and
   *  records the full lifetime, but meta.tokenUsage is overwritten on every
   *  message append from the CURRENT SessionContext's totals — a fresh context
   *  per round rewound meta to the last round only (playtest battle audit:
   *  worker meta 36M vs cache-log 142M input). Seeding the fresh context via
   *  addSidePathUsage (not addUsage — that would poison occupancy anchors)
   *  makes meta monotone and byte-comparable with the cache-log sum. The
   *  run's returned `usage` stays a DELTA (total − seed) so coordinator-side
   *  mergeUsage bookkeeping is unchanged. */
  priorUsage?: Partial<Usage>
  /** 上一轮（续跑/复核/重试，同 order.id+nonce）导出的冻结前缀快照——新引擎
   *  经 inheritFrozenFrom 继承，历史 user 消息恢复原始字节，前缀缓存只在新
   *  user 边界断尾而非 byte-0 全 miss。进程内续跑直接用；OOP 子进程经协议
   *  init 帧携带。缺省/坏数据 = 冷启动（历史行为）。 */
  priorFrozenSnapshot?: import('../prompt/frozen-snapshot.js').FrozenSnapshotData
  /** Per-dispatch nonce mixed into the worker's session id (see
   *  deriveWorkerSessionId) — batch order ids repeat across delegation runs,
   *  and without the nonce every run appends to the same conversation JSONL.
   *  Set by the coordinator; standalone callers may omit (legacy layout). */
  sessionNonce?: string
}

/** `turn` 事件在每个 worker turn 结束时上报，detail 为累计 token 总数（字符串）。
 *  `retry` 事件在 API 层内部瞬时重试的每次 attempt 起始上报——重试中的健康
 *  请求必须喂 liveness，否则被 stall sweep 误判为静默（慢 ≠ 死）。
 *  `lifecycle` 多数由 coordinator / hands-session 在补偿轮开始时上报（续跑、证据
 *  复核），detail 是给人看的中文短语；worker-session 自己在终轮定型
 *  （finalizeWorkerReport）开始时也会发一条 'finalizing report'——收尾轮不走
 *  AgentLoop，没有它 stall clock 在收尾期间吃不到任何信号。 */
export type WorkerActivityKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'turn' | 'retry' | 'lifecycle'

/** tool_use 活动行:`name(关键参数)`。toolArgSummary 覆盖常见工具;未覆盖的
 *  回退到常见参数键,再退到裸名。所有消费方(桌面 feed/TUI mirror)按纯文本展示。 */
export function summarizeToolUseLine(name: string, input: unknown): string {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  let arg = toolArgSummary(name, rec)
  if (!arg) {
    const cand = rec.file_path ?? rec.path ?? rec.pattern ?? rec.query ?? rec.url ?? rec.command ?? rec.objective
    if (typeof cand === 'string' && cand) arg = cand.length > 50 ? `${cand.slice(0, 49)}…` : cand
  }
  return arg ? `${name}(${arg})` : name
}

export interface WorkerTranscript {
  text: string
  thinking: string
  toolUses: string[]
  toolResults: string[]
  errors: string[]
  repairAttempts: number
  /** bash 工具的 command 参数留痕——worker-evidence 用它判定"验证形状"的命令
   *  是否真实执行过（VERIFY_BASH_RE）。可选：旧序列化/测试固件可缺省。 */
  bashCommands?: string[]
  /** 执行失败（isError）的 bash 命令——worker-evidence 用它区分"跑过验证"和
   *  "验证跑挂了"：npm test 失败不能当 verified 证据。可选：旧固件缺省时
   *  按全部成功处理（不误杀历史数据）。 */
  failedBashCommands?: string[]
  /** 写工具（edit_file/write_file/hash_edit/apply_patch）实际触及的文件——
   *  worker-evidence 以它为系统捕获口径交叉校验自报 changedFiles。可选：
   *  旧固件/测试缺省时捕获视为未激活，changedFiles 保持自报不校验。 */
  mutatedFiles?: string[]
  /** 本次运行累计等模型首字节的毫秒数，与采样轮数配对。用来把「墙钟花在等模型」
   *  与「花在跑工具」分开——只看 toolUses 数量时，每次调用间隔 15–36s 的慢通道
   *  和健康通道长得一样。可选：缺席表示未采到（provider 未回 stop_reason 等）。 */
  waitingFirstByteMs?: number
  /** 上面那个累计值的采样轮数，用于还原平均值。 */
  ttftSamples?: number
}

export interface WorkerSessionRun {
  result: WorkerResult
  transcript: WorkerTranscript
  session: SessionContext
  usage: Usage
  /** Extracted checkpoint when the worker was aborted mid-work — can be passed
   *  back as config.checkpoint to resume on retry. */
  checkpoint?: WorkerCheckpoint
  /** 本轮终态导出的冻结前缀快照——下一轮（续跑/复核/重试）经
   *  WorkerSessionConfig.priorFrozenSnapshot 回传给新引擎继承（OOP 经协议
   *  result/init 帧携带）。导出失败缺席 = 下一轮冷启动（历史行为）。 */
  frozenSnapshot?: import('../prompt/frozen-snapshot.js').FrozenSnapshotData
}

function emptyTranscript(): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses: [],
    toolResults: [],
    errors: [],
    repairAttempts: 0,
    bashCommands: [],
    failedBashCommands: [],
    mutatedFiles: [],
  }
}

/**
 * Detect streaming-layer tool-call argument pollution from the worker transcript.
 *
 * Signature of the cross-tool pollution bug (openai-client.ts resolveToolCallIndex):
 * a read tool (grep/glob) repeatedly fails with a "required argument missing"
 * error that also names a FOREIGN field — e.g. grep reporting
 * `Received input keys: file_path, path` (file_path belongs to read_section),
 * or the explicit "streaming tool_call argument pollution" marker grep emits.
 * When the model did the real work but got stuck retrying these poisoned calls,
 * it never reaches the final JSON → the worker is reported as "Parse failed" /
 * "aborted", masking the upstream streaming root cause.
 *
 * Returns a diagnostic hint to surface in the blocked result so the operator
 * does not chase "model can't output JSON" when the real cause is streaming.
 */
function detectPollutionFailure(transcript: WorkerTranscript): string | null {
  const errs = transcript.errors
  if (errs.length === 0) return null
  // Either the explicit pollution marker (grep.ts), or a "required" error that
  // also names a foreign key (file_path on a non-file tool, etc.).
  const hits = errs.filter(e =>
    e.includes('argument pollution')
    || (/\brequired\b/i.test(e) && /file_path|section|command\b/.test(e) && /pattern|path|glob\b/.test(e)),
  )
  if (hits.length < 2) return null  // a single transient blip is not a pattern
  return `Worker stalled on ${hits.length} streaming-polluted tool calls (foreign arguments grafted onto read tools). The review work above is likely real; the missing JSON is a symptom of the upstream OpenAIClient parallel-tool_call parsing bug, not a model failure. See .rivet/tool-stream-*.jsonl.`
}

/** Stable marker emitted by tool-pipeline's headless deny branch. Kept as a local
 *  const (not imported) to avoid a worker-session → loop → tool-pipeline import
 *  cycle; a drift-guard test asserts it matches tool-pipeline.HEADLESS_DENY_MARKER. */
export const HEADLESS_DENY_MARKER = 'not available in a headless worker'

/**
 * Detect approval-deadlock from the worker transcript.
 *
 * A headless worker cannot self-approve write operations that require it. When it
 * hits such a gate, the tool pipeline emits an error tool_result carrying
 * HEADLESS_DENY_MARKER. A small model often responds by emitting an approval
 * request in prose rather than result JSON, so the run ends as "Parse failed" —
 * masking the real cause (a gated operation, not malformed output).
 *
 * Returns a diagnostic hint to surface in the blocked result so the operator does
 * not chase "model can't output JSON" when the real cause is an approval gate.
 */
export function detectApprovalDeadlock(transcript: WorkerTranscript): string | null {
  const hits = transcript.errors.filter(e => e.includes(HEADLESS_DENY_MARKER))
  if (hits.length === 0) return null
  return `Worker was gated on ${hits.length} approval-required tool call(s) it cannot self-approve as a headless worker. This blocked/parse result is a symptom of the gated operation (the worker likely emitted an approval request in prose), NOT malformed JSON. Fix by giving this profile a non-gated path to the change (e.g. it should already auto-approve in-workspace file writes), or run the task inline in the primary session.`
}

/** Minimal agent surface needed by the retry layer — injectable so tests can
 *  exercise the real retry→blocked path without constructing a full AgentLoop. */
export interface RunnableAgent {
  run: AgentLoop['run']
  /** 累计等首字节耗时与采样轮数（AgentLoop 实例字段）。可选：测试 mock 不必提供，
   *  缺席时 transcript 不写该度量，续跑判据按「无度量」处理。 */
  readonly ttftTotalMs?: number
  readonly ttftSamples?: number
}

/** 长工具 keepalive 默认节拍：远低于最短 stall 容忍（90s），30s 一拍。 */
let TOOL_KEEPALIVE_MS = 30_000
/** Test-only: shrink the long-tool keepalive cadence so tests don't wait 30s. */
export function __setToolKeepaliveMs(ms: number): void { TOOL_KEEPALIVE_MS = ms }

async function runOnce(
  agent: RunnableAgent,
  prompt: string,
  transcript: WorkerTranscript,
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void,
  onSteerDrain?: () => string | null,
  onDelegationActivity?: (activity: import('../tools/types.js').DelegationActivity) => void,
): Promise<string> {
  let text = ''
  // AgentLoop.run never rethrows stream errors — it reports them via onError
  // and resolves. Capture and rethrow here so the transient-retry layer above
  // actually sees ECONNRESET/429/timeout instead of an empty transcript.
  let streamError: Error | null = null
  let aborted = false
  // tool id → bash command，供 onToolResult 把失败结果精确归到具体命令。
  const bashCommandById = new Map<string, string>()
  // 长工具 keepalive：tool_use→tool_result 之间没有任何流式事件——跑数分钟的
  // 测试套件/构建在 liveness 静默窗口内会被 stall sweep 误杀（慢 ≠ 死，与
  // finalize 轮保活同理）。工具在飞期间每 30s 发一条 lifecycle 心跳。
  // 代价：工具真死锁不再被 stall 提前杀，改由 budget 墙钟兜底（更晚但有界）——
  // 误杀健康长任务的代价比晚杀死锁高，取此交换。
  const toolsInFlight = new Map<string, { name: string; since: number }>()
  // 模型首字节等待同样可能长时间没有任何 worker 事件。单独记录最近一次
  // 活动，让 keepalive 只在真正静默时播报；这条心跳会同时喂给 TUI 和
  // coordinator 的上游活动流，避免健康请求被渲染层误报为「No response」。
  let lastActivityAt = Date.now()
  const emitActivity = (kind: WorkerActivityKind, detail?: string): void => {
    lastActivityAt = Date.now()
    onActivity?.(kind, detail)
  }
  const keepalive = setInterval(() => {
    const now = Date.now()
    if (now - lastActivityAt < TOOL_KEEPALIVE_MS) return
    const oldest = toolsInFlight.values().next().value
    if (oldest) {
      const elapsedS = Math.round((now - oldest.since) / 1000)
      emitActivity('lifecycle', `tool still running: ${oldest.name} (${elapsedS}s, ${toolsInFlight.size} in flight)`)
      return
    }
    const elapsedS = Math.round((now - lastActivityAt) / 1000)
    emitActivity('lifecycle', `model request still running: waiting for first response (${elapsedS}s)`)
  }, TOOL_KEEPALIVE_MS)
  keepalive.unref?.()
  try {
  await agent.run(prompt, {
    onTextDelta: (delta) => {
      text += delta
      transcript.text += delta
      emitActivity('text', delta)
    },
    onThinkingDelta: (delta) => {
      transcript.thinking += delta
      emitActivity('thinking', delta)
    },
    onToolUse: (id, name, input) => {
      toolsInFlight.set(id, { name, since: Date.now() })
      transcript.toolUses.push(name)
      const inputRec = input as Record<string, unknown> | undefined
      if (name === 'bash' && typeof inputRec?.command === 'string') {
        const command = (input as { command: string }).command
        ;(transcript.bashCommands ??= []).push(command)
        bashCommandById.set(id, command)
      }
      // 写工具触及的文件留痕——worker-evidence 以此交叉校验自报 changedFiles
      // （系统捕获为主，自报仅作对照）。worktree 里报相对路径，与自报口径一致，
      // 不做路径归一化。
      if ((name === 'edit_file' || name === 'write_file' || name === 'hash_edit') && typeof inputRec?.file_path === 'string') {
        ;(transcript.mutatedFiles ??= []).push(inputRec.file_path)
      }
      if (name === 'apply_patch' && typeof inputRec?.diff === 'string') {
        for (const line of inputRec.diff.split('\n')) {
          // 统一 diff 的 +++ 行标记目标文件；删除文件的 +++ /dev/null 不算改动。
          if (line.startsWith('+++ b/')) (transcript.mutatedFiles ??= []).push(line.slice(6).trim())
        }
      }
      // 活动流带关键参数(name(arg))——桌面委派 UI / TUI worker mirror 直接展示,
      // 光秃工具名无法回答"它在读哪个文件/跑什么命令"。
      emitActivity('tool_use', summarizeToolUseLine(name, input))
    },
    onToolResult: (id, name, result, isError) => {
      toolsInFlight.delete(id)
      transcript.toolResults.push(name)
      if (isError) {
        transcript.errors.push(result)
        const failedCommand = bashCommandById.get(id)
        if (failedCommand) (transcript.failedBashCommands ??= []).push(failedCommand)
      }
      emitActivity('tool_result', name)
    },
    // usage 是累计快照（getTotalUsage）——上报累计 token 总数，供 fleet 面板实时显示。
    onTurnComplete: (usage) => {
      const total = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
      if (total > 0) emitActivity('turn', String(total))
    },
    // WC: 输入直达 — drain coordinator 注入的 per-order steer 队列
    onSteerDrain: onSteerDrain ? () => onSteerDrain() : undefined,
    // 嵌套委派：worker 自己派的 sub-worker 活动上行（tool-pipeline 只在此回调
    // 存在时才给 delegate 工具接 onWorkerActivity——不接嵌套 worker 就不可见）。
    onDelegationActivity,
    onError: (error) => {
      transcript.errors.push(error.message)
      streamError = error
    },
    onAbort: () => {
      transcript.errors.push('Worker aborted')
      aborted = true
    },
    onApprovalRequired: async () => false,
  })
  } finally {
    clearInterval(keepalive)
    // 写在 finally：抛错路径（transient retry 会重跑）同样要留下度量，否则最慢的
    // 那几轮恰好因为失败而不计入，等首字节的耗时会被系统性低估。累计值取自
    // agent 实例，重跑时覆盖为最新累计，不会重复累加。
    if (agent.ttftSamples !== undefined && agent.ttftSamples > 0) {
      transcript.waitingFirstByteMs = agent.ttftTotalMs
      transcript.ttftSamples = agent.ttftSamples
    }
  }
  // Aborts are a deliberate stop (budget timer / parent signal), not a fault —
  // return the partial text and let the parse/blocked path handle it.
  if (streamError && !aborted) throw streamError
  return text
}

/**
 * response_format 被 provider 拒绝的识别——严格 provider（能力表
 * supportsResponseFormat:false 的 mimo/minimax/longcat 等）对未知参数直接
 * 400。只在错误信息明确指向 json 模式/未知参数时判定：网络抖动等瞬断不算，
 * 否则一次偶发失败就会永久关掉本会话的 json 收尾通道。
 */
function isResponseFormatRejection(err: Error | undefined): boolean {
  if (!err) return false
  return /response_format|json_object|json.mode|unknown\s+(parameter|field|argument)|unrecognized\s+(parameter|field|argument)|not[-_ ]supported/i.test(err.message)
}

/** 终型收尾轮强制工具（W2C）：唯一 submit_result。OAI 对象形式 tool_choice，
 *  anthropic/codex client 层各自映射为 provider 强制工具选择（W2D/W2E）。 */
const SUBMIT_RESULT_TOOL_NAME = 'submit_result'
/** submit_result 的 parameters 与 WORKER_RESULT_SUBMIT_SCHEMA（work-order.ts，
 *  workerResultIngestSchema 同源）严格一致——模型看到的参数形状与解析侧 ingest
 *  权威校验共用一份定义，改 schema 两侧自然同步。zod-to-json-schema 是 MCP SDK
 *  的传递依赖（package-lock 已锁定，未直接声明）。 */
const SUBMIT_RESULT_PARAMETERS: Record<string, unknown> = zodToJsonSchema(
  WORKER_RESULT_SUBMIT_SCHEMA,
  { target: 'openApi3' },
)

/**
 * 阶段 1 终型（W2C）：唯一 submit_result 工具 + forced tool_choice。模型把完整
 * 报告作为工具参数提交——参数形状与 ingest 校验同源；散文伴随输出忽略（最终
 * 结果只取工具参数，不拼散文）。
 *
 * 捕获恰好一个 ContentBlockToolUse(name='submit_result') 且参数未截断 → 序列化
 * 参数走 parseWorkerResult/ingest 权威校验（缺 workOrderId / 非法 status 等抛错
 * 即回退，绝不把未过校验的模型输出当报告）。零/多 tool-call、截断参数（
 * argsTruncated）、provider 拒绝（stream error）→ { ok: false }，调用方回退无
 * 工具 json_object 终型——fallback 至多一次，同 worker run 不重复白烧。
 *
 * 成功返回的 text 与 JSON 终型同构：调用方把它当 latestText 交给下游同一套
 * parse + reconcile 管线，证据门不因工具路径被绕过。
 */
async function attemptWithSubmitTool(
  config: WorkerSessionConfig,
  session: SessionContext,
  order: WorkOrder,
  hasWriteTools: boolean,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const toolUses: ContentBlockToolUse[] = []
  let error: Error | undefined
  await config.client.stream(
    {
      model: config.promptEngine.getModel(),
      messages: [
        ...session.getMessages(),
        { role: 'user' as const, content: buildFinalizationInstruction(order, hasWriteTools) },
      ],
      // 报告再生与修复轮同档（16384）——报告写大被截时照样需要这份空间。
      max_tokens: Math.min(16384, order.budget.maxTokens ?? config.contextWindow),
      stream: true,
      tools: [{
        type: 'function' as const,
        function: {
          name: SUBMIT_RESULT_TOOL_NAME,
          description: '提交最终 WorkerResult 报告：把完整报告作为参数 JSON 传入，与参数 JSON Schema 对齐。',
          parameters: SUBMIT_RESULT_PARAMETERS,
        },
      }],
      tool_choice: { type: 'function' as const, function: { name: SUBMIT_RESULT_TOOL_NAME } },
    },
    {
      onTextDelta: () => {}, // 伴随散文忽略——结果只取 submit_result 参数。
      onThinkingDelta: () => {},
      onContentBlock: (block) => { if (block.type === 'tool_use') toolUses.push(block) },
      onStopReason: () => {},
      onError: (e) => { error = e },
    },
    config.abortSignal,
  ).catch((e: unknown) => { error = e as Error })
  if (error) return { ok: false }
  // 契约：恰好一个 tool_use 且必须是 submit_result——零 tool-call、多 tool-call
  // （即使其中一个是 submit_result）一律回退无工具终型。
  if (toolUses.length !== 1) return { ok: false }
  const call = toolUses[0]!
  if (call.name !== SUBMIT_RESULT_TOOL_NAME) return { ok: false }
  if (call.argsTruncated) return { ok: false }
  try {
    const serialized = JSON.stringify(call.input)
    // 权威校验：与解析侧 ingest 共用同一 schema，抛错即回退。
    parseWorkerResult(serialized, order.id)
    return { ok: true, text: serialized }
  } catch {
    return { ok: false }
  }
}

/**
 * Single-shot repair request with response_format: json_object and NO tools.
 *
 * Normal worker turns carry tool definitions, and combining response_format:
 * json_object with tools is a known-broken combination (duplicate JSON, spurious
 * tool_calls, empty content — see OpenAI community reports). The repair turn,
 * however, only needs the model to re-emit its result as valid JSON from the
 * repair prompt (which embeds the previous broken output). It carries no tools,
 * so json_object is safe here and forces the model to emit parseable JSON,
 * eliminating the most common parse-failure cause (free-text prose / truncation).
 *
 * Bypasses AgentLoop entirely (no tool-calling loop) — just one client.stream
 * call. Returns the accumulated text ('' on stream error — caller falls back to
 * the AgentLoop repair path) plus a `rejected` flag telling the caller the
 * provider refused response_format itself, so it can stop offering it.
 */
async function repairWithJsonMode(
  client: StreamClient,
  model: string,
  repairPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ text: string; rejected: boolean }> {
  let text = ''
  let error: Error | undefined
  await client.stream(
    {
      model,
      messages: [{ role: 'user' as const, content: repairPrompt }],
      max_tokens: maxTokens,
      stream: true,
      // Force JSON output. The repair prompt already mentions "json" (required
      // by DeepSeek/GLM when response_format is set).
      response_format: { type: 'json_object' as const },
    },
    {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: (e) => { error = e },
    },
    signal,
  ).catch((e: unknown) => { error = e as Error })
  return { text: error ? '' : text, rejected: isResponseFormatRejection(error) }
}

/**
 * B（终轮定型）——带完整会话历史、无工具的收尾轮，把报告统一挤经受约束通道。
 *
 * 与 repairWithJsonMode 同骨架（直接 client.stream，不经 AgentLoop、不占 turn
 * 预算），本质区别在 messages：修复轮是无历史单发，正是 2026-07-24 假 summary
 * 事故的根因（模型凭空编造 "No work order context provided" 且解析通过）；
 * 收尾轮的 messages = worker 自己的完整会话历史 + 一条收尾指令，模型只能基于
 * 实际发生的工具调用与结果写报告。前缀与 worker 自己的 API 请求一致，provider
 * 前缀缓存接近全命中，净成本只有收尾指令 + 报告输出。
 *
 * response_format: json_object 复用 forceJsonRepair 的 provider 门——provider
 * 不支持时退化为无 json_object 的收尾（仍无工具 + 带历史）。
 * 流失败/空文本 → 返回 ''，调用方走回退（parse 自然输出 / max-turns 阶梯）。
 *
 * 探针式自愈（P0）：coordinator 对能力表外的 provider 乐观置 forceJsonRepair，
 * 若 provider 明确拒绝 response_format（isResponseFormatRejection），立刻不带
 * 它重试本收尾轮——收尾轮不白烧——并关闭本会话的 json 通道（后续 repair 轮
 * 同样跳过），严格 provider 从此零额外成本。
 */
async function finalizeWorkerReport(
  config: WorkerSessionConfig,
  session: SessionContext,
  order: WorkOrder,
  hasWriteTools: boolean,
): Promise<string> {
  // 收尾轮不走 AgentLoop，没有任何自然流式事件——先发一条 lifecycle 喂 stall
  // clock，再把 delta 按 'text' 上行（与探索轮同一保活通道）。
  config.onActivity?.('lifecycle', 'finalizing report')
  // 阶段 1（首选，W2C）：唯一 submit_result 工具 + forced tool_choice。成功即
  // 返回——结果已过 parseWorkerResult 权威校验。
  const toolResult = await attemptWithSubmitTool(config, session, order, hasWriteTools)
  if (toolResult.ok) {
    config.onActivity?.('lifecycle', 'finalize accepted via submit_result tool')
    return toolResult.text
  }
  // 阶段 2（fallback 一次，同 worker run 不重复白烧）：provider 拒绝工具定义、
  // 零/多/截断 tool-call、参数过不了权威校验，都落到无工具 json_object 终型。
  const attempt = async (withJson: boolean): Promise<{ text: string; error?: Error }> => {
    let text = ''
    let error: Error | undefined
    await config.client.stream(
      {
        model: config.promptEngine.getModel(),
        messages: [
          ...session.getMessages(),
          { role: 'user' as const, content: buildFinalizationInstruction(order, hasWriteTools) },
        ],
        // 报告再生与修复轮同档（16384）——报告写大被截时照样需要这份空间。
        max_tokens: Math.min(16384, order.budget.maxTokens ?? config.contextWindow),
        stream: true,
        // 收尾指令已含 "JSON"（DeepSeek/GLM 在 response_format 下要求提及 json）。
        ...(withJson ? { response_format: { type: 'json_object' as const } } : {}),
      },
      {
        onTextDelta: (delta) => { text += delta; config.onActivity?.('text', delta) },
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: (e) => { error = e },
      },
      config.abortSignal,
    ).catch((e: unknown) => { error = e as Error })
    return { text, error }
  }
  let result = await attempt(Boolean(config.forceJsonRepair))
  if (result.error && config.forceJsonRepair && isResponseFormatRejection(result.error)) {
    config.forceJsonRepair = false
    config.onActivity?.('lifecycle', 'provider rejected response_format — json channel disabled, retrying without')
    result = await attempt(false)
  }
  // 空文本等同失败——调用方回退旧路径（parse 自然输出 / max-turns 阶梯）。
  return result.error || !result.text.trim() ? '' : result.text
}

/** Soft-landing wrap-up steer, delivered ONCE through the per-tool-round steer
 *  drain when the budget soft timer fires. After delivery (or before arming),
 *  the drain passes through to the inner (coordinator) steer queue.
 *  文案按报告契约分体：finalized（B 终轮定型）时报告由系统收尾轮单独索取，
 *  软着陆只需让 worker 停探索、用散文收束——再叫它自产 JSON 会与收尾轮重复。 */
export function createSoftLandingDrain(
  inner?: () => string | null,
  reportContract: 'inline-json' | 'finalized' = 'inline-json',
): {
  drain: () => string | null
  requestWrapUp: () => void
} {
  let requested = false
  let delivered = false
  const wrapUpSteer = reportContract === 'finalized'
    ? '[budget warning] Less than 25% of your time budget remains. STOP exploring now. Wrap up your findings in prose based on the evidence you already have — the structured report will be requested separately by the system. Do not start new tool-call chains.'
    : '[budget warning] Less than 25% of your time budget remains. STOP exploring now. Based on the evidence you already have, emit your final report as a single valid JSON object (WorkerResult contract) immediately. Do not start new tool-call chains.'
  return {
    requestWrapUp: () => { requested = true },
    drain: () => {
      if (requested && !delivered) {
        delivered = true
        return wrapUpSteer
      }
      return inner?.() ?? null
    },
  }
}

/** Abort-path salvage ladder: the abort (budget timer / parent signal) may have
 *  landed after the worker already emitted its final report — or mid-stream
 *  with enough of the report on the wire to recover findings. Full contract
 *  parse first (degraded to unverified evidence), then field-level salvage.
 *  Returns null when nothing usable is present. */
export function salvageAbortedReport(
  latestText: string,
  orderId: string,
  abortSource: 'timeout' | 'caller_aborted',
): WorkerResult | null {
  if (!latestText.trim()) return null
  let parseError: unknown
  try {
    const parsed = parseWorkerResult(latestText, orderId)
    return {
      ...parsed,
      evidenceStatus: parsed.evidenceStatus === 'verified' ? 'unverified' : parsed.evidenceStatus,
      risks: [...parsed.risks, `salvaged after ${abortSource === 'timeout' ? 'budget timeout' : 'parent abort'} — verification evidence downgraded`],
      failureReason: abortSource,
    }
  } catch (error) {
    parseError = error
    // Fall through to field-level salvage.
  }
  const salvaged = salvageWorkerResult(latestText, orderId, parseError)
  if (!salvaged) return null
  return { ...salvaged, failureReason: abortSource }
}

/** Deterministic handling for a run cut off by maxTurns (2026-07-24 假 summary 事故).
 *
 *  When the initial run exhausts its turn budget without a final turn, the
 *  accumulated text is exploratory prose — NOT a report. The repair ladder is
 *  actively harmful here: `repairWithJsonMode` is a context-free single-shot
 *  request (no conversation history), so the model fabricates a plausible
 *  report like "No work order context provided" — which then parses cleanly
 *  and masks the real budget failure as a fake missing-context failure
 *  (observed on 5 review workers, 7-21~7-24; see
 *  docs/审查子代理max-turns耗尽与大read诊断.md).
 *
 *  Ladder: full contract parse (the report may have landed on the final turn
 *  via soft-landing) → return null so the caller proceeds normally; else
 *  field-level salvage (honest "salvaged" summary, findings downgraded); else
 *  a structured blocked result whose summary carries the
 *  "max-turns: exhausted without a final turn" marker that
 *  classifyInfraFailure keys on for 'budget' retry-routing. Never repair. */
export function buildMaxTurnsExhaustedResult(
  order: WorkOrder,
  transcript: WorkerTranscript,
  latestText: string,
  maxTurns: number,
): WorkerResult | null {
  let parseError: unknown
  try {
    parseWorkerResult(latestText, order.id)
    return null // 终轮已产出合法报告(soft-landing 成功)——走正常路径
  } catch (error) {
    parseError = error
    // fall through — the run genuinely ended without a report
  }
  const salvaged = salvageWorkerResult(latestText, order.id, parseError)
  if (salvaged) {
    // 空跑标记（2026-08-10 worker 日志实证：rivet-continuation 两个 worker 撞
    // max_turns 但 0 工具调用——纯推理空转被轮次切断）。工具调用 ≤ 阈值 =
    // 产出停滞（等首字节/空转），failureReason 标 'stalled' 而非 'max_turns'，
    // 让主控/议事会区分「空跑」与「真干活没干完」；续跑判据不含 stalled，
    // 不会对空跑原样续跑再烧一轮预算。
    // maxTurns 下限：预算 1-3 轮却只做 ≤3 次调用是「预算太小」不是「空跑」；
    // 只有预算 ≥4 轮仍停滞才算纯推理空转（worker 日志实证：48 轮 0 工具调用）。
    const stalled = maxTurns >= 4 && transcript.toolUses.length <= STALL_TOOL_CALL_THRESHOLD
    return {
      ...salvaged,
      risks: [...salvaged.risks, `${stalled ? 'stalled' : 'max-turns'}: exhausted without a final turn (budget ${maxTurns} turns, ${transcript.toolUses.length} tool calls) — findings salvaged from a mid-work report, treat as unverified leads`],
      failureReason: stalled ? 'stalled' : 'max_turns',
    }
  }
  const stalled = maxTurns >= 4 && transcript.toolUses.length <= STALL_TOOL_CALL_THRESHOLD
  const blocked = buildBlockedWorkerResult(
    order,
    stalled
      ? `stalled: exhausted without a final turn. Worker used its full ${maxTurns}-turn budget with only ${transcript.toolUses.length} tool call(s) — pure reasoning spin, no real work done. Re-dispatch with a narrower scope or check provider health; do NOT retry the same objective verbatim.`
      : `max-turns: exhausted without a final turn. Worker used its full ${maxTurns}-turn budget while still exploring (${transcript.toolUses.length} tool calls issued, no verdict JSON produced). This is a deterministic budget failure — do NOT trust any prose the model wrote about missing context; re-dispatch with a bigger budget or a narrower scope.`,
    stalled ? 'stalled' : 'max_turns',
  )
  return latestText.trim()
    ? {
        ...blocked,
        artifacts: [
          ...blocked.artifacts,
          { kind: 'note' as const, title: 'Max-turns worker partial output', content: latestText.slice(0, 2000) },
        ],
      }
    : blocked
}

/** Run a single agent turn, retrying transient network/API errors with backoff.
 *  Exported for direct testing with an injected mock agent. */
export async function runOnceWithTransientRetry(
  agent: RunnableAgent,
  prompt: string,
  transcript: WorkerTranscript,
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void,
  onSteerDrain?: () => string | null,
  onDelegationActivity?: (activity: import('../tools/types.js').DelegationActivity) => void,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await runOnce(agent, prompt, transcript, onActivity, onSteerDrain, onDelegationActivity)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const classified = classifyFailure(message)
      if (classified.retryable && isTransient(classified.class) && attempt < MAX_TRANSIENT_RETRIES) {
        const backoff = TRANSIENT_BACKOFF_BASE_MS * Math.pow(2, attempt)
        transcript.errors.push(`Transient error (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1}): ${message} — retrying in ${backoff}ms`)
        // 喂 liveness：内部重试（含 backoff 等待）期间没有任何流式事件，
        // 不上报会被 stall sweep 记为静默误杀（慢 ≠ 死）。
        onActivity?.('retry', String(attempt + 1))
        await new Promise<void>(resolve => setTimeout(resolve, backoff))
        continue
      }
      throw err
    }
  }
  // Unreachable, but satisfy TypeScript
  throw new Error('runOnceWithTransientRetry: exhausted retries')
}

async function runWorkerSessionImpl(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  if (config.activeClaims && config.activeClaims.length > 0) {
    config.promptEngine.updateActiveClaims(config.activeClaims)
  }
  // Build knowledge blocks for prompt injection. Domain lessons are scoped to
  // the worker authority and stay in the worker prompt only; they never mutate
  // the primary session prompt/prefix.
  const knowledgeBlocks = [
    config.activeClaims ? buildWorkerKnowledgeBlock(config.activeClaims) : '',
    config.domainKnowledgeStore && config.order.authority
      ? buildDomainKnowledgeBlock(config.domainKnowledgeStore, config.order.authority)
      : '',
    // 批级共享信息素（星河收编 #3）：同批先完成的 worker 的信号。
    // 写工默认不注入（守护实现独立性）——coordinator 只在显式 opt-in 时
    // 给写工挂共享 store。
    config.stigmergy ? await formatBatchStigmergyBlock(config.stigmergy) : '',
  ].filter(Boolean)
  // B（终轮定型）：默认报告由带完整会话历史的收尾轮统一产出，主提示词用
  // finalized 契约（不携带 shape/转义段）；finalizeReport === false
  // （RIVET_WORKER_FINALIZE=0）时完全旧契约——inline JSON、无收尾轮。
  const finalizeReport = config.finalizeReport !== false
  const reportContract = finalizeReport ? 'finalized' as const : 'inline-json' as const
  const hasWriteTools = workerOrderHasWriteTools(config.order)
  const baseParts = [...knowledgeBlocks, buildWorkerPrompt(config.order, undefined, { ledgerCwd: config.cwd, reportContract })]
  // Checkpoint resume: inject partial results so the worker doesn't redo completed work
  if (config.checkpoint && config.checkpoint.partialResult) {
    baseParts.push(
      `<checkpoint turn="${config.checkpoint.turnIndex}" tools="${config.checkpoint.completedTools.length}">`,
      'The following work was already completed in a previous run. Do NOT redo it — continue from where it stopped:',
      config.checkpoint.partialResult,
      '</checkpoint>',
    )
  }
  const prompt = baseParts.join('\n\n')

  const session = new SessionContext()
  // usage-ledger alignment：先种入前几轮的累计用量，meta 从此单调递增且与
  // cache-log 的终身合计对账一致。走 addSidePathUsage——它只进 totalUsage，
  // 不碰 lastRealPromptTokens / tailEstimate / 校准比这些 occupancy 锚点。
  if (config.priorUsage) session.addSidePathUsage(config.priorUsage)
  // 对外返回差值（本轮净增）：coordinator / hands-session 用 mergeUsage 逐轮
  // 累加，透传「种入+本轮」的累计值会把 prior 份额重复计入派发总账。
  const sessionUsage = (): Usage =>
    (config.priorUsage
      ? subtractUsage(session.getTotalUsage(), config.priorUsage)
      : session.getTotalUsage()) as Usage
  // Session resume: pre-seed the conversation history so the worker continues
  // from its previous context. The new objective is then appended as a fresh
  // user message by agent.run() below.
  if (config.priorMessages && config.priorMessages.length > 0) {
    session.replaceMessages([...config.priorMessages])
  }
  config.onSessionReady?.(() => session.getMessages())
  const agent = new AgentLoop({
    client: config.client,
    promptEngine: config.promptEngine,
    toolRegistry: config.toolRegistry,
    // R3.1: honor the per-profile turn budget even for direct callers — the
    // coordinator already clamps, this guards runWorkerSession used standalone.
    maxTurns: clampWorkerMaxTurns(config.maxTurns, config.order.budget.maxTurns),
    contextWindow: config.contextWindow,
    compact: config.compact,
    // 紧 read cap:worker 关压缩 + 1M 窗口跳过请求时修剪,首次全量大 read
    // 会永久占据后续每轮 prompt——用摘要骨架替代全文,精读走 offset/limit。
    readCapOverride: WORKER_READ_CAP,
    sessionId: deriveWorkerSessionId(config.order.id, config.sessionNonce),
    // Headless: no human answers approval prompts for a worker. The tool pipeline
    // auto-approves in-workspace writes (worktree/claim isolation) and fast-denies
    // anything else that would ask, instead of stalling on onApprovalRequired.
    headless: true,
    // Trust downward-delegation: a parent running dangerously-skip-permissions
    // opted out of all prompts, so the worker inherits that. Other parent modes
    // are left unset — headless semantics govern instead.
    approvalMode: config.parentApprovalMode === 'dangerously-skip-permissions'
      ? 'dangerously-skip-permissions'
      : undefined,
    reviewDepth: config.reviewDepth,
    // B3: the worker knows its own nesting depth, so any delegate_task it
    // issues carries it and the coordinator can cap recursion.
    delegationDepth: config.order.delegationDepth,
    thetaCheckDisabled: true,
    // V3: pin the worker's frozen <star-domain> to order.authority so the
    // structural constant position carries the correct domain identity.
    // authority 缺席时 bindSessionDomain 的 `?? 'qiming'` 兜底会钉定启明——
    // 不会落到关键词路由（那条分支只有显式传字符串 'auto' 才进得去）。
    defaultDomain: config.order.authority,
    // 构造期注入批级共享 prewarm（loop.ts 构造器在 createToolExecutionController
    // 之前应用）——构造后替换字段到不了 tool-pipeline 消费端（值捕获）。
    prewarm: config.prewarm,
    // 批级共享信息素 store（星河收编 #3）：同批 worker 共用内存库，
    // 不各自落盘 sessionDir。
    stigmergyStore: config.stigmergy,
  }, session, config.cwd)

  // Record the selected model into the worker session JSONL so the actual
  // model used is auditable without opening the .meta.json sidecar.
  const workerModel = config.promptEngine.getModel()
  agent.persist?.appendModelSwitch({ to: workerModel })

  // Create mailbox sender for structured inter-agent communication.
  // Workers report progress, findings, and escalations through this channel;
  // the coordinator drains the mailbox after the wave completes.
  const mbox = config.mailbox
    ? createWorkerMailboxSender(config.mailbox, config.order.id)
    : null

  // Abort latch — once the budget timer or the parent signal fires, the
  // session must STOP. Each agent.run() creates a fresh AbortController, so
  // without this latch the parse-repair loop below would happily re-run an
  // "aborted" worker with a live signal and keep issuing API calls.
  // `abortSource` records WHICH fired first so the blocked result can carry a
  // machine-readable failureReason (timeout vs caller_aborted — different
  // recovery strategies for the primary).
  let abortLatched = false
  let abortSource: 'timeout' | 'caller_aborted' | null = null
  const timeoutMs = config.order.budget.timeoutMs
  const timer = setTimeout(() => {
    abortLatched = true
    abortSource ??= 'timeout'
    agent.abort()
  }, timeoutMs)

  // Soft landing — at ~75% of the budget (or 60s before the hard timer for
  // long budgets), inject ONE wrap-up steer through the per-tool-round drain
  // channel so the worker stops exploring and emits its final report while
  // there is still time. Session 2c1186f5: a scout was hard-killed 37s INTO
  // streaming its final report — the report was seconds from landing.
  // Cache-safe: the steer is an append-only tail message in the worker's own
  // session (same mechanism as coordinator steerWorker).
  const softLanding = createSoftLandingDrain(config.onSteerDrain, reportContract)
  const steerDrain = softLanding.drain
  const softMs = Math.max(timeoutMs * 0.75, timeoutMs - 60_000)
  const softTimer = softMs > 0 && softMs < timeoutMs
    ? setTimeout(() => { softLanding.requestWrapUp() }, softMs)
    : null

  // Propagate parent abort signal — when parent aborts, worker must stop
  // immediately instead of waiting for the internal budget timeout.
  const onParentAbort = config.abortSignal
    ? () => { abortLatched = true; abortSource ??= 'caller_aborted'; agent.abort(); clearTimeout(timer) }
    : null
  if (onParentAbort && !config.abortSignal!.aborted) {
    config.abortSignal!.addEventListener('abort', onParentAbort, { once: true })
  }
  const wasAborted = (): boolean => abortLatched || (config.abortSignal?.aborted ?? false)

  try {
    const transcript = emptyTranscript()
    let latestText = await runOnceWithTransientRetry(agent, prompt, transcript, config.onActivity, steerDrain, config.onNestedDelegation)
    mbox?.progress(1, config.order.budget.maxRetries + 1, 'initial run')

    // Max-turns 熔断判定：初始 run 被 maxTurns 非自愿切断时，累计文本是探索
    // 散文而非报告（2026-07-24 假 summary 事故背景，见 buildMaxTurnsExhaustedResult）。
    const initialStop = agent.latestStopReason
    const maxTurnsExhausted = initialStop?.source === 'max-turns' && !initialStop.voluntary
    // 确定性 max-turns 阶梯（终型失败回退与旧契约闸门共用）：返回 null 说明
    // 终轮已产出合法报告（soft-landing 成功），落入下方正常 parse 路径。
    const maxTurnsFallback = (): WorkerSessionRun | null => {
      const exhausted = buildMaxTurnsExhaustedResult(
        config.order,
        transcript,
        latestText,
        clampWorkerMaxTurns(config.maxTurns, config.order.budget.maxTurns),
      )
      if (!exhausted) return null
      mbox?.escalate(`Worker exhausted max-turns budget (${transcript.toolUses.length} tool calls, no verdict)`)
      return {
        result: exhausted,
        transcript,
        session,
        usage: sessionUsage(),
        checkpoint: {
          turnIndex: 0,
          partialResult: latestText.slice(0, 8000),
          completedTools: [...transcript.toolUses],
        },
      }
    }

    // Abort 绝对优先：预算/父信号一到就不再花任何 API（终型轮也是一次调用）。
    // 被掐断的 worker 跳过终型与 max-turns 闸，直接落入下方循环 attempt 0 的
    // abort 分支走 salvage 阶梯。
    if (!wasAborted()) {
      if (finalizeReport) {
        // B（终轮定型）：报告不再由探索轮自产，统一经带完整会话历史的无工具
        // 收尾轮产出（根治无历史修复编造）。max-turns 非自愿耗尽同样改走终型——
        // 带历史的收尾能如实产出「探索到哪」的报告；终型失败才回退 max-turns 阶梯。
        const reportText = await finalizeWorkerReport(config, session, config.order, hasWriteTools)
        if (reportText) {
          latestText = reportText
        } else if (maxTurnsExhausted) {
          const run = maxTurnsFallback()
          if (run) return run
        }
        // 终型为空（非 max-turns）→ 回退旧路径：下方 parse 自然输出 → 修复梯
      } else if (maxTurnsExhausted) {
        // 旧契约（RIVET_WORKER_FINALIZE=0）：max-turns 熔断闸门原样——
        // 初始 run 被 maxTurns 切断时绝不进修复梯。
        const run = maxTurnsFallback()
        if (run) return run
      }
    }

    for (let attempt = 0; attempt <= config.order.budget.maxRetries; attempt++) {
      // Abort wins over repair: never re-run an aborted worker.
      if (wasAborted()) {
        const partialSummary = latestText.slice(0, 500)
        mbox?.escalate(`Worker aborted: ${partialSummary.slice(0, 100)}`)
        // Extract checkpoint for potential resume
        const abortCheckpoint: WorkerCheckpoint = {
          turnIndex: attempt,
          partialResult: latestText.slice(0, 8000),
          completedTools: [...transcript.toolUses],
        }
        // Abort salvage — the abort may have landed AFTER the worker finished
        // (or nearly finished) its final report. Try the full contract first
        // (degraded to unverified evidence), then field-level salvage, before
        // discarding everything into an empty blocked result.
        const abortSalvaged = salvageAbortedReport(latestText, config.order.id, abortSource ?? 'timeout')
        if (abortSalvaged) {
          return {
            result: abortSalvaged,
            transcript,
            session,
            usage: sessionUsage(),
            checkpoint: abortCheckpoint,
          }
        }
        const pollutionHint = detectPollutionFailure(transcript)
        const approvalHint = detectApprovalDeadlock(transcript)
        return {
          result: {
            ...buildBlockedWorkerResult(
              config.order,
              `Worker aborted (${abortSource === 'caller_aborted' ? 'parent signal' : 'budget timeout'}). Partial output: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}${approvalHint ? ` ${approvalHint}` : ''}`,
              abortSource ?? 'timeout',
            ),
            artifacts: [
              { kind: 'note' as const, title: 'Aborted worker partial output', content: latestText.slice(0, 2000) },
            ],
          },
          transcript,
          session,
          usage: sessionUsage(),
          checkpoint: abortCheckpoint,
        }
      }
      try {
        // 系统捕获优先：用本次 transcript 的工具调用痕迹交叉校验自报的
        // changedFiles/verification（聚合侧二次过闸还会再校一次，函数幂等）。
        const result = reconcileCapturedWorkerFacts(parseWorkerResult(latestText, config.order.id), transcript)
        // Report structured findings back to coordinator
        if (result.findings?.length) {
          for (const f of result.findings.slice(0, 3)) {
            mbox?.reportFinding(f.claim ?? 'finding', 'info', result.changedFiles)
          }
        }
        if (mbox) {
          mbox.progress(config.order.budget.maxRetries + 1, config.order.budget.maxRetries + 1, 'completed')
        }
        return {
          result,
          transcript,
          session,
          usage: sessionUsage(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        transcript.errors.push(message)
        mbox?.escalate(`Parse failed (attempt ${attempt + 1}): ${message.slice(0, 100)}`)
        if (attempt === config.order.budget.maxRetries) {
          // Terminal tier ladder: repair retries exhausted → field-level salvage
          // (recover independently parseable findings from the malformed report)
          // → empty blocked only when nothing is salvageable.
          // evidenceRoots = worker cwd：打捞 findings 的 evidenceRefs 相对被侦察
          // 项目（幻觉引用检测的机械校验根）。
          const salvaged = salvageWorkerResult(latestText, config.order.id, error, [config.cwd])
          if (salvaged) {
            mbox?.progress(config.order.budget.maxRetries + 1, config.order.budget.maxRetries + 1, 'parse-salvaged')
            return {
              result: salvaged,
              transcript,
              session,
              usage: sessionUsage(),
            }
          }
          const partialSummary = latestText.slice(0, 300)
          const pollutionHint = detectPollutionFailure(transcript)
          const approvalHint = detectApprovalDeadlock(transcript)
          return {
            result: {
              ...buildBlockedWorkerResult(config.order, `Parse failed after ${attempt + 1} attempts: ${message}. Partial: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}${approvalHint ? ` ${approvalHint}` : ''}`, 'json_parse'),
              parseErrorKind: classifyWorkerParseError(error) ?? 'json_syntax',
              artifacts: [
                { kind: 'note' as const, title: 'Unparseable worker output', content: latestText.slice(0, 2000) },
              ],
            },
            transcript,
            session,
            usage: sessionUsage(),
          }
        }
        transcript.repairAttempts++
        // JSON-mode repair: provider supports response_format: json_object and
        // the combination is safe here (no tools on this turn). Prefer it over
        // the AgentLoop repair loop — it directly forces valid JSON output,
        // short-circuiting the most common parse-failure cause.
        if (config.forceJsonRepair && !abortLatched) {
          const repair = await repairWithJsonMode(
            config.client,
            config.promptEngine.getModel(),
            buildWorkerRepairPrompt(config.order, latestText, message),
            // 修复再生与首发同档（16384）——报告当初写大被截，修复照样需要这份空间。
            Math.min(16384, config.order.budget.maxTokens ?? config.contextWindow),
            config.abortSignal,
          )
          // provider 明确拒绝 response_format——关闭本会话 json 通道，后续
          // finalize/repair 轮不再白试（与 finalizeWorkerReport 的探针同理）。
          if (repair.rejected) config.forceJsonRepair = false
          if (repair.text) {
            latestText = repair.text
            // Skip the AgentLoop repair — go straight to re-parse at loop top.
            continue
          }
          // json-mode repair produced nothing (stream error) → fall through to AgentLoop repair
        }
        latestText = await runOnceWithTransientRetry(agent, buildWorkerRepairPrompt(config.order, latestText, message), transcript, config.onActivity, steerDrain, config.onNestedDelegation)
      }
    }

    return {
      result: buildBlockedWorkerResult(config.order, 'Worker result parser exited unexpectedly'),
      transcript,
      session,
      usage: sessionUsage(),
    }
  } finally {
    clearTimeout(timer)
    if (softTimer) clearTimeout(softTimer)
    if (onParentAbort && config.abortSignal) {
      config.abortSignal.removeEventListener('abort', onParentAbort)
    }
    // 刷掉 loop 侧 persist 缓存里最后一批 meta 更新（尾轮 tokenUsage 只在
    // 内存，worker 不走主会话的 shutdown drain）。必须在 wrapper 写终态前
    // 完成，否则 wrapper 从盘上 merge 到的是缺了尾巴的旧账。
    try { await agent.drainPersistWrites() } catch { /* best-effort */ }
    // worker 会话本次运行终结（含 blocked/salvaged/abort/throw 全出口）：清
    // stall-observer 活动表条目——否则结束后残留 key 被周期性重报（delegate
    // 返回后仍见 [stall-observer] worker 噪音，2026-09-09）。resume 续跑会
    // 重新 touch，无需保留条目。
    clearActivity(deriveWorkerSessionId(config.order.id, config.sessionNonce))
  }
}

/**
 * runWorkerSession 的收尾包装（P0-3：席位 worker 会话结束后 meta 有终态）。
 *
 * 内部实现有 6+ 个返回点（正常 parse / parse-salvaged / parse-blocked / abort /
 * max-turns 回退 / 兜底 blocked），逐一注入收尾会漏——统一经 wrapper 出口写终态。
 *
 * 收尾语义（与 loop.ts:990-997 的启动侧对应）：
 * - 正常结束（含 blocked/salvaged）：status='completed' + cleanExit=true，失败归因
 *   走 failureReason（salvage 路径已带 'timeout'/'max_turns'/'json_parse' 等）。
 * - caller_aborted：**不写**——保持 active + cleanExit:false，与 R1 crash-recoverable
 *   语义一致（abort 后父会话可能接管续跑，不能误标已收尾）。
 * - crash（本函数 throw）：不经过此出口，天然保持 active——「还在跑/跑挂了」可区分。
 *
 * 只写 worker 自己的会话 meta（sessionId 派生自 order.id），不碰主会话。
 */
export async function runWorkerSession(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  const run = await runWorkerSessionImpl(config)
  // 冻结前缀快照随 run 带回（coordinator 续跑/复核/重试回传继承；caller_aborted
  // 分支同样要挂——那正是父会话接管续跑的场景）。导出失败 = 下轮冷启动，不毁结果。
  try { run.frozenSnapshot = config.promptEngine.exportFrozenSnapshot() } catch { /* best-effort */ }
  // caller_aborted：不写终态——保持 active + cleanExit:false，与 R1 crash-recoverable
  // 语义一致（abort 后父会话可能接管续跑，不能误标已收尾）。timeout 是预算耗尽
  // （文档要修的形态），failureReason 已编码在结果上，正常写终态 + 归因。
  if (run.result.failureReason === 'caller_aborted') {
    return run
  }
  try {
    const persist = new SessionPersist(deriveWorkerSessionId(config.order.id, config.sessionNonce), config.cwd)
    // 快照落盘与主会话同语义（worker 目录此前 0 个 frozen.json）——本轮在
    // 哪个进程跑就写哪个进程的盘；OOP 子进程 cwd 相同，落点一致。
    if (run.frozenSnapshot) {
      try { persist.writeFrozenSnapshot(run.frozenSnapshot) } catch { /* best-effort */ }
    }
    // 无条件写（成功时为 undefined）：续跑各轮共用同一 meta——order.id 与 nonce 都不变，
    // 而 updateMetadata 是合并语义。条件展开会让首轮的 'timeout' 在续跑成功后残留，
    // 把最终成功的 worker 读成预算耗尽，正好抵消这里要提供的归因能力。
    persist.updateMetadata({
      status: 'completed',
      cleanExit: true,
      failureReason: run.result.failureReason,
      // 同样无条件写：续跑覆盖为最新一轮的度量，未采到时清空而不是留着上一轮的数。
      waitingFirstByteMs: run.transcript.waitingFirstByteMs,
      ttftSamples: run.transcript.ttftSamples,
    })
    // updateMetadata 只进本实例的内存缓存（batch-flush 语义）——这个孤儿实例
    // 无人再碰，终态会随 GC 丢失（wo_meta 测试在 HEAD 上的失败即此因）。
    // 显式刷盘收口。
    await persist.flushSessionBuffer().catch(() => {})
  } catch {
    // meta 写回失败不吞结果——worker 已完成，收尾标注只是可观测性增强。
  }
  return run
}
