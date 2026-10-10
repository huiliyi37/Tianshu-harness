import { buildReportRepairPacket, repairReportOnce, degradeRepairedReport, reportFailureKind, isReportChannelError, type ReportDiagnostic, recordReportFailure } from './worker-report-repair.js'
import type { ContinuationPrefixProof } from '../api/continuation-prefix.js'
import { withWorkspaceRoots, currentWorkspaceRoots } from '../tools/workspace-context.js'
import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { CompactionConfig } from '../compact/constants.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { AgentLoop } from './loop.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { classifyFailure, isTransient } from './failure-classifier.js'
import {
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
import { buildWorkerPrompt, buildFinalizationInstruction, workerOrderHasWriteTools } from './worker-prompts.js'
import { withTruncationRisk } from './worker-repair-route.js'
import {
  buildClosingRequest, mountSubmitResultTool, observeMainRequests, requestSubmittedReport,
  type FinalizeStreamHooks, type MainRequestSnapshot,
} from './worker-submit-result.js'
import { reconcileCapturedWorkerFacts } from './worker-evidence.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
import { buildDomainKnowledgeBlock, formatBatchStigmergyBlock } from './domain-knowledge-block.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import type { WorkerMailbox } from './worker-mailbox.js'
import { createWorkerMailboxSender } from './worker-mailbox.js'
import { createProgressTracker, recordToolCall, pickSteer } from './worker-progress.js'

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
  routeReason?: string
  workspaceRoots?: string[]
  order: WorkOrder
  client: StreamClient
  reportRepairClient?: StreamClient | (() => StreamClient)
  priorPrefixProof?: ContinuationPrefixProof
  continuationSource?: string
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
  /** Legacy capability hint, retained for old callers; independent repair always attempts JSON once. */
  forceJsonRepair?: boolean
  /** Mount submit_result from the first turn and append at most one closing request if needed. */
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
   *  same dispatch — continuation, retry, escalation —
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

/** tool_use 活动行:`name(关键参数)`。toolArgSummary 已覆盖常见工具，并对未覆盖的
 *  工具用常见参数键兜底（tool-label.ts genericArgSummary）——下面的 fallback 因此
 *  基本不再触发，只在参数全是数组/对象（无字符串可用）时退到裸名。
 *  所有消费方(桌面 feed/TUI mirror)按纯文本展示。 */
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
  reportDiagnostics?: ReportDiagnostic[]
  /** bash 工具的 command 参数留痕——worker-evidence 用它判定"验证形状"的命令
   *  是否真实执行过（isVerificationIntent）。可选：旧序列化/测试固件可缺省。 */
  bashCommands?: string[]
  /** 执行失败（isError）的 bash 命令——worker-evidence 用它区分"跑过验证"和
   *  "验证跑挂了"：npm test 失败不能当 verified 证据。可选：旧固件缺省时
   *  按全部成功处理（不误杀历史数据）。 */
  failedBashCommands?: string[]
  /** 写工具（edit_file/write_file/hash_edit/apply_patch）实际触及的文件——
   *  worker-evidence 以它为系统捕获口径交叉校验自报 changedFiles。可选：
   *  旧固件/测试缺省时捕获视为未激活，changedFiles 保持自报不校验。 */
  mutatedFiles?: string[]
  examinedFiles?: string[]
  /** 本次运行累计等模型首字节的毫秒数，与采样轮数配对。用来把「墙钟花在等模型」
   *  与「花在跑工具」分开——只看 toolUses 数量时，每次调用间隔 15–36s 的慢通道
   *  和健康通道长得一样。可选：缺席表示未采到（provider 未回 stop_reason 等）。 */
  waitingFirstByteMs?: number
  /** 上面那个累计值的采样轮数，用于还原平均值。 */
  ttftSamples?: number
}

export interface WorkerSessionRun {
  prefixProof?: ContinuationPrefixProof
  result: WorkerResult
  transcript: WorkerTranscript
  session: SessionContext
  usage: Usage
  /** Extracted checkpoint when the worker was aborted mid-work — can be passed
   *  back as config.checkpoint to resume on retry. */
  checkpoint?: WorkerCheckpoint
  /** 本轮终态导出的冻结前缀快照——下一轮（执行续跑/重试）经
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

/** 这次工具结果是否"零新增信息"——空转检测用。保守：只把明确的空结果算作无进展
 *  （宁可漏报，不可误杀有产出的探索）。出错不算空转——那是另一条通道的事。 */
function isEmptyToolResult(result: string, isError: boolean): boolean {
  if (isError) return false
  const t = result.trim()
  if (t.length === 0) return true
  return /^(命令已执行成功，只是没有 stdout|No matches|未找到匹配|Command executed successfully)/.test(t)
}

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
  const readsById = new Map<string, string>()
  const toolsInFlight = new Map<string, { name: string; since: number }>()
  // 空转检测（2026-10-06 verifier 空转事故）：连续 3 次工具调用无新增信息即
  // 通过同一个 drain 通道注入收敛 steer（append-only tail，缓存安全）。
  let progress = createProgressTracker()
  let pendingFingerprint = ''
  let convergenceSent = false
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
      if (['read_file', 'read_section'].includes(name) && typeof inputRec?.file_path === 'string') readsById.set(id, inputRec.file_path)
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
      pendingFingerprint = `${name}:${JSON.stringify(input ?? null)}`
    },
    onToolResult: (id, name, result, isError) => {
      toolsInFlight.delete(id)
      const readFile = readsById.get(id)
      if (readFile && !isError) (transcript.examinedFiles ??= []).push(readFile)
      readsById.delete(id)
      transcript.toolResults.push(name)
      if (isError) {
        transcript.errors.push(result)
        const failedCommand = bashCommandById.get(id)
        if (failedCommand) (transcript.failedBashCommands ??= []).push(failedCommand)
      }
      emitActivity('tool_result', name)
      progress = recordToolCall(progress, pendingFingerprint || name, isEmptyToolResult(result ?? '', isError === true))
    },
    // usage 是累计快照（getTotalUsage）——上报累计 token 总数，供 fleet 面板实时显示。
    onTurnComplete: (usage) => {
      const total = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
      if (total > 0) emitActivity('turn', String(total))
    },
    // WC: 输入直达 — drain coordinator 注入的 per-order steer 队列
    // 空转收敛 steer 与外部（soft-landing / coordinator）steer 共用这一条
    // drain 通道：收敛优先，发一次即止（决策在 worker-progress.pickSteer，可单测）。
    onSteerDrain: () => {
      const picked = pickSteer(progress, convergenceSent, () => onSteerDrain?.() ?? null)
      convergenceSent = picked.convergenceSent
      return picked.steer
    },
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

async function finalizeWorkerReport(
  config: WorkerSessionConfig, session: SessionContext, order: WorkOrder,
  hasWriteTools: boolean, hooks: (kind: string) => FinalizeStreamHooks,
  lastMain: MainRequestSnapshot | undefined,
): Promise<{ text: string; truncated: boolean }> {
  config.onActivity?.('lifecycle', 'finalizing report')
  const closing = buildClosingRequest({
    lastMain, sessionMessages: session.getMessages(),
    instruction: buildFinalizationInstruction(order, hasWriteTools), engine: config.promptEngine,
    contextWindow: config.contextWindow, maxTokens: Math.min(16384, order.budget.maxTokens ?? config.contextWindow),
  })
  if (!closing) return { text: '', truncated: false }
  const priorPrefix = config.client.getMainPrefixProof?.()
  closing.diagnostics = { purpose: 'worker_finalize', workOrderId: order.id, continuationSource: 'worker_finalize', priorPrefix, previousMainRequestId: priorPrefix?.requestId }
  const submitted = await requestSubmittedReport(config.client, closing, order.id, hooks('worker-finalize'))
  return { text: submitted ?? '', truncated: false }
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
    ? '[budget warning] Less than 25% of your time budget remains. STOP exploring now. Call submit_result now with the complete WorkerResult based on captured evidence. Do not start new exploration or verification tool-call chains.'
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
  if (config.priorFrozenSnapshot) config.promptEngine = config.promptEngine.withFrozenSnapshot(config.priorFrozenSnapshot)
  if (!config.priorMessages?.length && config.activeClaims && config.activeClaims.length > 0) {
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
  // 从首轮到软着陆统一通过 submit_result 提交；旧 inline 契约仍可读。
  const finalizeReport = config.finalizeReport !== false
  const reportContract = finalizeReport ? 'finalized' as const : 'inline-json' as const
  const hasWriteTools = workerOrderHasWriteTools(config.order)
  // finalized 契约下 submit_result 从首轮起就在工具表里（收尾请求与探索轮共用前缀）；
  // 模型在执行循环内经它交的报告已过 ingest 校验，直接收下。
  const rejectedReports: Array<{ reason: string; raw: string }> = []
  const submission: { report?: string } = {}
  const toolRegistry = finalizeReport
    ? mountSubmitResultTool({
        registry: config.toolRegistry,
        engine: config.promptEngine,
        toolDescriptions: config.blockPolicy?.toolDescriptions,
        orderId: config.order.id,
        onAccepted: (report) => { submission.report = report },
        onRejected: (reason, raw) => { rejectedReports.push({ reason, raw }) },
      })
    : config.toolRegistry
  const baseParts = config.priorMessages?.length
    ? [`继续执行本次目标：${config.order.objective}`, `本次工单 ID：${config.order.id}。保留既有观察；完成后${finalizeReport ? '调用 submit_result 提交' : '输出完整 WorkerResult JSON'}。`]
    : [...knowledgeBlocks, buildWorkerPrompt(config.order, undefined, { ledgerCwd: config.cwd, reportContract })]
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
  const observed: { lastMain?: MainRequestSnapshot } = {}
  let firstMain = true
  const loopClient = observeMainRequests(config.client, (request) => {
    observed.lastMain = { request, sessionLength: session.getMessages().length }
    request.diagnostics = {
      ...request.diagnostics,
      purpose: request.diagnostics?.purpose ?? 'worker_execution',
      routeReason: config.routeReason,
      workOrderId: config.order.id,
      ...(firstMain && config.priorMessages?.length ? {
        continuationSource: config.continuationSource ?? 'resume', priorPrefix: config.priorPrefixProof,
        previousMainRequestId: config.priorPrefixProof?.requestId,
      } : {}),
    }
    firstMain = false
  })
  const agent = new AgentLoop({
    inputOrigin: 'worker_task',
    client: loopClient,
    providerName: config.providerName,
    promptEngine: config.promptEngine,
    toolRegistry,
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
  agent.persist?.updateMetadata({ title: config.order.objective.slice(0, 120) })
  agent.persist?.appendModelSwitch({ to: workerModel })
  // 收尾/修复直发请求不经 AgentLoop：用量记进 worker 自己的总账与 cache-log 的 side_path 行。
  const directHooks = (kind: string): FinalizeStreamHooks => ({
    onReportRejected: (reason, raw) => { rejectedReports.push({ reason, raw }) },
    onActivity: config.onActivity,
    recordUsage: (usage) => agent.recordSidePathUsage(kind, usage, workerModel, config.providerName),
    keepaliveMs: TOOL_KEEPALIVE_MS,
    signal: config.abortSignal,
  })

  // Create mailbox sender for structured inter-agent communication.
  // Workers report progress, findings, and escalations through this channel;
  // the coordinator drains the mailbox after the wave completes.
  const mbox = config.mailbox
    ? createWorkerMailboxSender(config.mailbox, config.order.id)
    : null

  // Abort latch — once the budget timer or the parent signal fires, the
  // session must STOP. Each agent.run() creates a fresh AbortController, so
  // without this latch report closing could issue another API request after
  // the execution budget was already exhausted.
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
    const runAgent = async (input: string): Promise<{ text: string; submitted: boolean }> => {
      submission.report = undefined
      const text = await runOnceWithTransientRetry(agent, input, transcript, config.onActivity, steerDrain, config.onNestedDelegation)
      return submission.report ? { text: submission.report, submitted: true } : { text, submitted: false }
    }
    const initialRun = await runAgent(prompt)
    for (const rejected of rejectedReports) {
      const diagnostic: ReportDiagnostic = { kind: reportFailureKind(rejected.raw, new Error(rejected.reason)), error: rejected.reason }
      diagnostic.artifact = await recordReportFailure(agent.artifactStore, config.cwd,
        deriveWorkerSessionId(config.order.id, config.sessionNonce), diagnostic, rejected.raw)
      transcript.reportDiagnostics ??= []
      transcript.reportDiagnostics.push(diagnostic)
    }
    let latestText = initialRun.text
    let finalizeTruncated = false // 收尾轮在 max_tokens 处被截断——终局失败时透传到 risks
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
        // 已提交或完整本地报告不再索取；缺报告只追加一次同前缀收尾。
        let completeLocal = false
        if (!isReportChannelError(latestText)) {
          try { parseWorkerResult(latestText, config.order.id); completeLocal = true } catch { /* closing needed */ }
        }
        const finalized = initialRun.submitted || completeLocal
          ? { text: latestText, truncated: false }
          : await finalizeWorkerReport(config, session, config.order, hasWriteTools, directHooks, observed.lastMain)
        if (!finalized.text && rejectedReports.at(-1)?.raw) latestText = rejectedReports.at(-1)!.raw
        if (finalized.text) {
          latestText = finalized.text
          finalizeTruncated = finalized.truncated
        } else if (maxTurnsExhausted) {
          const run = maxTurnsFallback()
          if (run) return run
        }
        // 收尾未成形：下方只走本地解析、一次独立报告修复及降级。
      } else if (maxTurnsExhausted) {
        // 旧契约（RIVET_WORKER_FINALIZE=0）：max-turns 熔断闸门原样——
        // 初始 run 被 maxTurns 切断时绝不进修复梯。
        const run = maxTurnsFallback()
        if (run) return run
      }
    }

    for (let attempt = 0; attempt <= 1; attempt++) {
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
        // 这里的 blocked 是「abort 时的原始形态」——coordinator 回收侧还会过一道
        // completed-aborted 产物校验（upgradeAbortedDelivery）：scope 声明产物已
        // 按预期写盘的 abort 结果会在那里升级为 passed + deliveredOnAbort。
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
        if (isReportChannelError(latestText)) throw new Error('channel: DSML is not a report')
        const parsed = parseWorkerResult(latestText, config.order.id)
        const result = reconcileCapturedWorkerFacts(attempt > 0 ? degradeRepairedReport(parsed) : parsed, transcript)
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
        const failureRaw = rejectedReports.at(-1)?.raw || latestText
        finalizeTruncated ||= rejectedReports.some(r => r.reason.includes('truncated'))
        const diagnostic: ReportDiagnostic = {
          kind: reportFailureKind(failureRaw, error, finalizeTruncated), error: rejectedReports.at(-1)?.reason ?? message,
        }
        diagnostic.artifact = await recordReportFailure(agent.artifactStore, config.cwd,
          deriveWorkerSessionId(config.order.id, config.sessionNonce), diagnostic,
          JSON.stringify({ rejectedReports, raw: latestText, transcript, messages: session.getMessages() }))
        transcript.reportDiagnostics ??= []
        transcript.reportDiagnostics.push(diagnostic)
        if (attempt === 1 || !config.reportRepairClient || config.order.budget.maxRetries === 0) {
          // Terminal tier ladder: repair retries exhausted → field-level salvage
          // (recover independently parseable findings from the malformed report)
          // → empty blocked only when nothing is salvageable.
          // evidenceRoots = worker cwd：打捞 findings 的 evidenceRefs 相对被侦察
          // 项目（幻觉引用检测的机械校验根）。
          const salvaged = salvageWorkerResult(latestText, config.order.id, error, [config.cwd])
          if (salvaged) {
            mbox?.progress(config.order.budget.maxRetries + 1, config.order.budget.maxRetries + 1, 'parse-salvaged')
            return {
              result: withTruncationRisk(salvaged, finalizeTruncated),
              transcript,
              session,
              usage: sessionUsage(),
            }
          }
          const partialSummary = latestText.slice(0, 300)
          const pollutionHint = detectPollutionFailure(transcript)
          const approvalHint = detectApprovalDeadlock(transcript)
          const blockedResult = {
            ...buildBlockedWorkerResult(config.order, `Parse failed after ${attempt + 1} attempts: ${message}. Partial: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}${approvalHint ? ` ${approvalHint}` : ''}`, 'json_parse'),
            parseErrorKind: classifyWorkerParseError(error) ?? 'json_syntax',
            artifacts: [
              { kind: 'note' as const, title: 'Unparseable worker output', content: latestText.slice(0, 2000) },
            ],
          }
          return {
            result: withTruncationRisk(blockedResult, finalizeTruncated),
            transcript,
            session,
            usage: sessionUsage(),
          }
        }
        const packet = buildReportRepairPacket(config.order, failureRaw, transcript, diagnostic)
        if (!packet || wasAborted()) { attempt = 0; config.reportRepairClient = undefined; continue }
        diagnostic.omitted = packet.omitted
        transcript.repairAttempts++
        let repaired: string | null = null
        try {
          const client = typeof config.reportRepairClient === 'function' ? config.reportRepairClient() : config.reportRepairClient
          repaired = await repairReportOnce(client!, config.promptEngine.getModel(), packet.prompt, directHooks('worker-report-repair'), { workOrderId: config.order.id, parentRequestId: config.client.getMainPrefixProof?.()?.requestId, routeReason: config.routeReason })
        } catch (err) { transcript.errors.push(String(err)) }
        // A rejected mode never falls back to exploration or a second report request.
        if (repaired) latestText = repaired

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
export function runWorkerSession(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  return withWorkspaceRoots(config.workspaceRoots ?? currentWorkspaceRoots(config.cwd), () => runWorkerSessionInWorkspace(config))
}
async function runWorkerSessionInWorkspace(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  const run = await runWorkerSessionImpl(config)
  run.prefixProof = config.client.getMainPrefixProof?.()
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
