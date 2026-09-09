import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, summaryOutputBudgetChars } from '../compact/constants.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { deriveCompactionProfile, cacheKindFromProviderProfile, type CompactionProfile, type CompactionAction } from '../compact/compaction-profile.js'
import { estimateReclaim, buildReclaimDecision, type ReclaimDecisionRecord } from '../compact/reclaim-estimate.js'

import { debugLog } from '../utils/debug.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import type { WriteProbe } from '../context/write-evidence-probe.js'
import { decideCompactAction, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import type { CompactCircuitBreakerState, CompactTier } from '../context/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { PressureMonitor } from '../context/pressure-monitor.js'
import type { SessionContext } from './context.js'
import { extractTaskState } from './task-state.js'
import { renderTaskAnchor, type TaskContract } from '../context/task-contract.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import { extractSessionMemories, type ExtractedMemory } from './session-memory-extract.js'
import type { ArtifactSection } from '../artifact/types.js'
import { serializeMessagesForArchive, buildArchiveCatalog, buildRecallRefBlock } from './compact-archive.js'
import { parseRecallMarker } from '../compact/recall-marker.js'

/**
 * How many of the most-recent compact-history recall blocks in the recent zone
 * to keep verbatim. The model just pulled these back; folding them immediately
 * would cancel out the recall it asked for. Older recalls are folded to
 * pointers (A3).
 */
export const RECALL_KEEP_RECENT = 10

/** Markers identifying an earlier compaction summary already in the history.
 *  Their presence switches llmCompact / tryPartialCompact into lossless
 *  iterative-merge mode (preserve the prior summary, then fold in new messages). */
const PRIOR_SUMMARY_MARKERS = ['<compact-summary', '<partial-compact-summary', '<session-handoff', '<checkpoint-resume'] as const

/**
 * Fold aged compact-history recall blocks sitting in the recent zone back into
 * one-line pointers. The original content remains in the source artifact and
 * stays re-recallable; this only reclaims the recalled bytes that have aged out
 * of the last `keepRecent` recalls. Idempotent: a folded pointer still parses
 * as a recall marker, so re-running fold is a no-op. Non-recall messages and
 * the most recent `keepRecent` recalls are returned untouched.
 */
export function foldAgedRecallBlocks(recentZone: OaiMessage[], keepRecent: number): OaiMessage[] {
  const recallIdxs: number[] = []
  for (let i = 0; i < recentZone.length; i++) {
    const c = recentZone[i]!.content
    if (typeof c === 'string' && parseRecallMarker(c)) recallIdxs.push(i)
  }
  if (recallIdxs.length <= keepRecent) return recentZone

  const foldUpTo = recallIdxs.length - keepRecent
  const agedIdxs = new Set(recallIdxs.slice(0, foldUpTo))
  return recentZone.map((msg, i) => {
    if (!agedIdxs.has(i)) return msg
    const parsed = parseRecallMarker(msg.content as string)!
    return { ...msg, content: `[recalled ${parsed.artifactId} ${parsed.section}]` }
  })
}

/**
 * Extract the user intent chain: all user messages in order,
 * truncated to a reasonable preview for the compaction prompt.
 * This ensures the LLM summary preserves the user's full intent
 * evolution, including corrections and clarifications.
 */
function extractUserIntentChain(messages: OaiMessage[]): string[] {
  const MAX_PER_MESSAGE = 300
  const MAX_MESSAGES = 20

  return messages
    .filter(m => m.role === 'user')
    .slice(-MAX_MESSAGES)
    .map(m => {
      const text = (typeof m.content === 'string' ? m.content : '').trim().replace(/\n+/g, ' ')
      return text.length > MAX_PER_MESSAGE
        ? text.slice(0, MAX_PER_MESSAGE) + '...'
        : text
    })
}

/**
 * File-write tools that mutate the workspace. Read/search tools are excluded so
 * the change chain stays precise (zero false positives). Non-read-only bash is
 * left to the prompt instruction — command read/write classification is
 * unreliable and over-enumeration would pollute the summary.
 */
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'edit', 'apply_patch', 'ast_edit', 'hash_edit',
])

/**
 * Extract the write-action chain: every file-write operation in the trajectory,
 * in order, rendered as `[T<turn>] <tool> <target>` (with a FAIL marker). This
 * mirrors extractUserIntentChain — a deterministic injection so the LLM summary
 * never loses "what was changed on the machine", which is the primary guard
 * against a fresh session redoing already-completed work.
 */
export function extractWriteActionChain(trajectory: TrajectoryEntry[]): string[] {
  const MAX = 40
  return trajectory
    .filter(e => WRITE_TOOLS.has(e.tool))
    .slice(-MAX)
    .map(e => {
      const failed = e.status === 'failed' || e.status === 'retried-failed'
      return `[T${e.turn}] ${e.tool} ${e.target}${failed ? ' (FAIL)' : ''}`
    })
}

/**
 * Find a safe split point that doesn't cut through a tool_calls ↔ tool group.
 *
 * The OpenAI-compatible API requires every assistant message with tool_calls
 * to be immediately followed by matching tool messages. If tryPartialCompact
 * splits between an assistant(tool_calls) and its tool results, the resulting
 * message list becomes invalid and the API returns an error.
 *
 * This function walks backward from the desired split point to ensure we
 * split only at group boundaries: a tool call group (assistant + its tool
 * results) stays together in either oldZone or recentZone, not split across.
 */
export function findSafeSplitPoint(
  messages: OaiMessage[],
  desiredSplit: number,
  minSplit: number,
): number {
  let sp = desiredSplit

  // Walk backward while the message at sp is a tool — its owning assistant
  // must be before sp, so we move sp before that assistant to keep the group intact.
  let iterations = 0
  while (sp > minSplit && sp < messages.length && messages[sp]?.role === 'tool') {
    if (++iterations > 100) break // safety valve
    const toolCallId = (messages[sp] as unknown as Record<string, unknown>).tool_call_id as string | undefined
    if (!toolCallId) break
    let found = false
    for (let i = sp - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant') {
        const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as Array<{ id: string }> | undefined
        if (toolCalls?.some(tc => tc.id === toolCallId)) {
          sp = i // move split before the assistant that owns this tool
          found = true
          break
        }
      }
    }
    if (!found) break // orphaned tool with no matching assistant — shouldn't happen
  }

  return sp
}

export type HandoffToolStatus = TrajectoryEntry['status'] | 'running'

export interface StructuredHandoffInput {
  taskState: {
    current: string
    completed: string[]
    remaining: string[]
    decisions: string[]
  }
  turnCount: number
  filesSeen: string[]
  reasoningSnippet: string
  errorCount: number
  errors: Array<{ turn: number; tool: string; target: string; errorClass: string; summary: string }>
  toolHistory: Array<{ tool: string; target: string; status: HandoffToolStatus }>
  /** Collaboration-stance evidence derived from virtue signals. */
  stanceSummary?: string | null
}

export const STRUCTURED_HANDOFF_SECTIONS = [
  '1. 用户核心需求',
  '2. 关键技术决策',
  '3. 文件与代码',
  '4. 错误与修复',
  '5. 当前工作',
  '6. 已完成工作',
  '7. 待办事项',
  '8. 最近工具轨迹',
  '9. 下一步',
] as const

function statusLabel(status: HandoffToolStatus): string {
  if (status === 'failed' || status === 'retried-failed') return 'FAIL'
  if (status === 'retried-success') return 'ok*'
  if (status === 'running') return 'running'
  return 'ok'
}

export function buildStructuredHandoff(input: StructuredHandoffInput): string {
  const taskState = input.taskState
  const lines: string[] = [
    '<session-handoff>',
    `Turn: ${input.turnCount}`,
    '',
    `## ${STRUCTURED_HANDOFF_SECTIONS[0]}`,
    taskState.current || '（无明确记录）',
    '',
    `## ${STRUCTURED_HANDOFF_SECTIONS[1]}`,
  ]

  if (taskState.decisions.length > 0) {
    for (const decision of taskState.decisions.slice(-8)) lines.push(`- ${decision}`)
  } else {
    lines.push('（无记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[2]}`)
  if (input.filesSeen.length > 0) {
    for (const file of input.filesSeen.slice(0, 15)) {
      const tools = [...new Set(input.toolHistory.filter(t => t.target === file).map(t => t.tool))]
      lines.push(`- ${file}${tools.length > 0 ? ` [${tools.join(', ')}]` : ''}`)
    }
  } else {
    lines.push('（无文件记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[3]}`)
  if (input.errors.length > 0) {
    lines.push(`Error count: ${input.errorCount}`)
    for (const error of input.errors.slice(0, 8)) {
      lines.push(`- [Turn ${error.turn}] failed: ${error.tool} ${error.target}: ${error.summary} (${error.errorClass})`)
    }
  } else {
    lines.push('（无错误）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[4]}`)
  lines.push(taskState.current || '（无记录）')

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[5]}`)
  if (taskState.completed.length > 0) {
    for (const item of taskState.completed.slice(-8)) lines.push(`- [x] ${item}`)
  } else {
    lines.push('（无记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[6]}`)
  if (taskState.remaining.length > 0) {
    for (const item of taskState.remaining.slice(0, 8)) lines.push(`- [ ] ${item}`)
  } else {
    lines.push('（无明确待办）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[7]}`)
  if (input.toolHistory.length > 0) {
    for (const tool of input.toolHistory.slice(-12)) {
      lines.push(`- ${tool.tool} ${tool.target} [${statusLabel(tool.status)}]`)
    }
  } else {
    lines.push('（无工具记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[8]}`)
  lines.push(taskState.remaining[0] ?? taskState.current ?? '继续当前任务')

  if (input.stanceSummary && input.stanceSummary.trim().length > 0) {
    lines.push('', '## 协作姿态（从行为轨迹涌现，非身份注入）')
    lines.push(input.stanceSummary.trim())
  }

  if (input.reasoningSnippet.trim().length > 0) {
    lines.push('', '## 附录：最近推理摘要')
    lines.push(input.reasoningSnippet.trim().slice(-2000))
  }

  lines.push('', '</session-handoff>')
  return lines.join('\n')
}

/**
 * Build a compact 4-field summary for injection into the message list after
 * compaction.  Deterministic (zero LLM cost) — all fields sourced from
 * extractTaskState / trajectory.
 *
 * Fields: Goals (current + remaining), Progress (completed), Active Files, Errors.
 */
export function buildCompactSummary(input: StructuredHandoffInput): string {
  const taskState = input.taskState
  const parts: string[] = []

  // Goals
  parts.push('## Goals')
  parts.push(`- Current: ${taskState.current || '(none)'}`)
  if (taskState.remaining.length > 0) {
    for (const item of taskState.remaining.slice(0, 5)) parts.push(`- [ ] ${item}`)
  }

  // Progress
  parts.push('', '## Progress')
  if (taskState.completed.length > 0) {
    for (const item of taskState.completed.slice(-5)) parts.push(`- [x] ${item}`)
  } else {
    parts.push('- (none)')
  }

  // Active files
  parts.push('', '## Active Files')
  if (input.filesSeen.length > 0) {
    for (const file of input.filesSeen.slice(0, 10)) parts.push(`- ${file}`)
  } else {
    parts.push('- (none)')
  }

  // Errors
  parts.push('', '## Errors')
  if (input.errors.length > 0) {
    for (const error of input.errors.slice(0, 5)) {
      parts.push(`- [Turn ${error.turn}] ${error.tool} ${error.target}: ${error.summary}`)
    }
  } else {
    parts.push('- (none)')
  }

  return `<compact-summary>\n${parts.join('\n')}\n</compact-summary>`
}

export interface CompactionControllerDeps {
  session: SessionContext
  promptEngine: PromptEngine
  contextWindow: number
  providerProfile?: ProviderProfile
  primaryClient?: StreamClient
  /**
   * Optional dedicated client for compaction summarization (compact.provider+
   * model). When set, llmCompact / tryPartialCompact distill on this cheap
   * model — isolated server-side cache, no primary-model token spend — and use
   * a more generous summary budget (Flash is cheap; prefer fidelity over
   * over-compression). Falls back to primaryClient when undefined.
   */
  compactClient?: StreamClient
  /**
   * When false, discretionary compaction (ratio tiers, 1M partial/full LLM
   * compact) is skipped entirely. Emergency paths — session split and the
   * 95% context ceiling — stay active regardless, because exceeding the
   * window is a hard API failure, not a tuning preference.
   * Worker sessions pass `compact.enabled: false` and previously relied on
   * this being silently ignored.
   */
  compactEnabled?: boolean
  pressureMonitor: PressureMonitor
  getTrajectoryEntries: () => TrajectoryEntry[]
  getStreamedText: () => string
  refreshLedger: () => void
  cacheAdvisor?: CacheAdvisor
  /** Collaboration-stance evidence, rendered into handoff so it survives compaction. */
  getStanceSummary?: () => string | null
  persistMemories?: (memories: Array<{ text: string; source: ExtractedMemory['source']; kind: ExtractedMemory['kind'] }>) => void | Promise<void>
  /** Current abort signal from the agent loop, so LLM compact can be cancelled. */
  getAbortSignal?: () => AbortSignal | undefined
  /**
   * C4: the live authoritative task contract. Re-injected into the appendix
   * region after every compaction so the goal / constraints / forbidden items
   * survive verbatim even when the LLM summary above drifts or drops them.
   */
  getActiveContract?: () => TaskContract | undefined
  /**
   * Layered archival: persist a discarded message zone as a recallable
   * `compact-history` artifact, returning its id (or null on failure).
   * Wired to ArtifactStore.save in loop.ts. Archiving only writes to disk and
   * never touches the prompt prefix — fully prefix-cache safe. Fail-soft:
   * compaction must continue even if the archive write fails.
   */
  archiveHistory?: (input: ArchiveHistoryInput) => Promise<string | null>
  /** Notified with the new artifact id + creation turn for recall observability. */
  onArchive?: (artifactId: string, turn: number) => void
  /** Snapshot the full pre-compaction message list for disaster recovery. */
  backupTranscript?: (messages: OaiMessage[], turn: number) => void
  /**
   * Fired after every history rewrite that goes through safeReplaceMessages
   * (maybeCompact / checkpoint / partial / micro / context ceiling). Wired in
   * loop.ts to invalidateSessionReadDedup: the historical tool_results that
   * read-ref points at ("回看上文") may no longer exist after the rewrite, so
   * "already read" dedup claims must be dropped.
   */
  onHistoryRewritten?: () => void
  /**
   * Side-path usage accounting (2026-07-06 cost blind spot fix): summary
   * requests carry a large input (anchor + oldZone) and are billed like any
   * other call — report their usage so session totals and the cache-log
   * reflect the real spend. `model` is the request's model (the dedicated
   * compact client may run a different model than the session primary).
   */
  recordSummaryUsage?: (usage: Partial<Usage>, model: string) => void
  /** Disk evidence probe for write-tool orphan synthesis during compaction repair. */
  writeProbe?: WriteProbe
  /**
   * Cost-aware reclaim profile (2026-07-16 plan). When absent, a conservative
   * per-token profile is derived from providerProfile + contextWindow — an
   * unknown provider must never get looser cache protection than DeepSeek.
   */
  compactionProfile?: CompactionProfile
  /** Structured sink for reclaim-gate decisions (committed AND rejected). */
  onReclaimDecision?: (record: ReclaimDecisionRecord) => void
}

export interface ArchiveHistoryInput {
  rawContent: string
  summary: string
  sections: ArtifactSection[]
  target: string
}

export interface MaybeCompactInput {
  loopTurn: number
  failures: CompactCircuitBreakerState
}

export interface MaybeCompactResult {
  failures: CompactCircuitBreakerState
  compacted: boolean
}

export class CompactionController {
  private _llmCompactInFlight = false
  private _prefixOverheadSet = false

  constructor(private deps: CompactionControllerDeps) {}

  /** Client used for compaction summarization: the dedicated cheap compact
   *  client when configured, else the session primary. */
  private summaryClient(): StreamClient | undefined {
    return this.deps.compactClient ?? this.deps.primaryClient
  }

  /** Summary char budget. Generous (≈2×) when a dedicated compact client is
   *  configured — distillation is near-free, so retain more detail. */
  private summaryBudget(): { full: number; partial: number } {
    return summaryOutputBudgetChars(this.deps.contextWindow, { generous: Boolean(this.deps.compactClient) })
  }

  /**
   * True when the zone being compacted already contains an earlier compaction
   * summary. Repeated compactions otherwise re-summarize a summary, drifting and
   * dropping early decisions; when detected we instruct the model to merge the
   * prior summary losslessly instead of rewriting from scratch (oh-my-pi's
   * <previous-summary> iterative-merge contract).
   */
  private hasPriorSummary(messages: OaiMessage[]): boolean {
    for (const m of messages) {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => (typeof c === 'string' ? c : ((c as { text?: string }).text ?? ''))).join('')
          : ''
      if (PRIOR_SUMMARY_MARKERS.some(mk => text.includes(mk))) return true
    }
    return false
  }

  /** Merge-preservation clause appended to the compact prompt when a prior
   *  summary is present, or [] otherwise. */
  private mergeClause(present: boolean): string[] {
    if (!present) return []
    return [
      '## 迭代合并（最高优先）',
      '上文已包含上一次压缩产生的摘要（`<compact-summary>` / `<partial-compact-summary>` / `<session-handoff>` 等标记）。',
      '你必须把那份既有摘要的**全部信息无损保留**，再把其后的新消息合并进去——绝不能因为“重新总结”而丢失早期摘要里的任何决策、文件、错误或待办。',
      '',
    ]
  }

  /**
   * Compute the fixed token overhead from system prompt and tool definitions.
   * Called once per session. Without this baseline, estimatedTokens is
   * systematically 5K-8K tokens too low, causing compaction decisions to
   * trigger too late.
   */
  ensurePrefixOverhead(force = false): void {
    if (!force && this._prefixOverheadSet) return
    this._prefixOverheadSet = true

    // System prompt tokens
    const sysPrompt = this.deps.promptEngine.getSystemPrompt()
    const sysTokens = estimateOaiTokens([{ role: 'system', content: sysPrompt }])

    // Tool definition tokens: ~200 chars per tool, CHARS_PER_TOKEN=4 → ~50/tool
    // Conservative estimate based on typical tool schema size
    const toolCount = this.deps.promptEngine.getToolCount?.() ?? 12
    const toolTokens = toolCount * 50

    // Volatile block overhead (frozen hints, git-status, session-state)
    // — stripped for cache stability but still present in token count
    const volatileOverhead = 400

    const overhead = sysTokens + toolTokens + volatileOverhead
    this.deps.session.setPrefixOverhead(overhead)
  }

  async maybeCompact(input: MaybeCompactInput): Promise<MaybeCompactResult> {
    // Ensure prefix overhead is always set before any early return.
    // Without this, getEstimatedTokens() omits the system prompt + tool
    // definition cost, making GlanceBar show ctx 0% and ◧ 0/1.0M.
    this.ensurePrefixOverhead()

    if (this.deps.compactEnabled === false) {
      return { failures: input.failures, compacted: false }
    }

    const messages = this.deps.session.getMessages()

    // Prune removed (C4): pruneStaleToolResults was called here solely for debugLog
    // stats — it never mutated storage. The actual request-time pruning happens in
    // PromptEngine.buildOaiRequest via semanticPruneLayer1 + detectStaleness.

    this.ensurePrefixOverhead()
    const estimatedTokens = this.deps.session.getEstimatedTokens()
    const contextWindow = this.deps.contextWindow
    const ratio = contextWindow > 0 ? estimatedTokens / contextWindow : 0
    debugLog(`[compaction-check] contextWindow=${contextWindow} estimatedTokens=${estimatedTokens} ratio=${(ratio * 100).toFixed(1)}% turn=${this.deps.session.getTurnCount()}`)

    // Unified window-aware action decision (2026-07-16 reclaim gate plan
    // task 4). The old dedicated 1M branch early-returned past
    // decideCompactTier, silently bypassing the precision ceiling; windows now
    // share one action vocabulary and only thresholds differ. The 60%/75% LLM
    // ladder and circuit-breaker semantics live inside decideCompactAction.
    const actionDecision = decideCompactAction({
      estimatedTokens,
      maxTokens: contextWindow,
      turn: this.deps.session.getTurnCount(),
      failures: input.failures,
      providerProfile: this.deps.providerProfile,
      recentHitRate: this.deps.cacheAdvisor?.getRecentHitRate() ?? null,
      profile: this.reclaimProfile(),
    })
    debugLog(`[compaction-decision] action=${actionDecision.action} tier=${actionDecision.tier} force=${actionDecision.force} precisionRisk=${actionDecision.precisionRisk} reason="${actionDecision.reason}"`)

    if (actionDecision.action === 'none') {
      return { failures: input.failures, compacted: false }
    }

    if (actionDecision.action === 'partial-llm' || actionDecision.action === 'full-llm' || actionDecision.action === 'checkpoint') {
      if (!this.summaryClient()) {
        return { failures: input.failures, compacted: false }
      }
      // P2: on exact-prefix providers (DeepSeek), the LLM-compact paths used
      // to bypass shouldDelayCompact entirely — breaking the prefix cache even
      // when it was hot. Non-force actions defer to cache warmth; the forced
      // ceiling checkpoint must stay reachable (an over-window request is a
      // hard API failure, so "cache healthy, delay" cannot stall it forever).
      const cachePreserving = this.isCachePreservingProvider()
      const delayTier = actionDecision.action === 'partial-llm' ? 1 : 2
      if (!actionDecision.force && cachePreserving && this.deps.cacheAdvisor?.shouldDelayCompact(delayTier, { estimatedTokens, contextWindow })) {
        debugLog(`[llm-compact] ${actionDecision.action} at ${(ratio * 100).toFixed(0)}% — cache healthy, delaying`)
        return { failures: input.failures, compacted: false }
      }

      // Try partial compact first for every LLM action (lighter, preserves
      // the recent zone) — unchanged ladder order.
      debugLog(`[llm-compact] ${actionDecision.action} at ${(ratio * 100).toFixed(0)}% — trying partial compact first`)
      const partialResult = await this.tryPartialCompact(60)
      if (partialResult) {
        return { failures: recordCompactSuccess(input.failures), compacted: true }
      }
      if (actionDecision.action === 'partial-llm') {
        debugLog('[partial-compact] partial compact failed — will wait for the full-compact rung')
        return { failures: input.failures, compacted: false }
      }

      debugLog(`[llm-compact] partial compact insufficient — triggering full LLM compact`)
      const summary = await this.llmCompact(undefined, this.deps.getAbortSignal?.())
      if (this.isAbortRequested()) {
        debugLog('[llm-compact] turn aborted after compact returned — skipping checkpoint replacement')
        return { failures: input.failures, compacted: false }
      }
      if (summary) {
        // P3: persist heuristic session memories BEFORE replaceWithCheckpoint
        // wipes history (extractSessionMemories reads the live message list).
        // Placed AFTER llmCompact so the compaction request itself still reuses
        // the prefix cache with the pre-refresh frozen base — the persist
        // callback hot-refreshes session memory, which rebuilds the frozen base.
        this.persistExtractedMemories(this.deps.getTrajectoryEntries())
        const committed = await this.replaceWithCheckpoint({
          tier: 2,
          reason: `LLM compact at ${(ratio * 100).toFixed(0)}% context (${actionDecision.action})`,
          summary,
          maxFallback: this.deps.contextWindow * 0.3,
          fallbackText: '<compact-summary>LLM compact failed to fit; session continues with cache anchors.</compact-summary>',
          action: actionDecision.action,
          force: actionDecision.force,
        })
        if (!committed) {
          // Gate veto is an economic decision, not a pipeline error.
          return { failures: input.failures, compacted: false }
        }
        return { failures: recordCompactSuccess(input.failures), compacted: true }
      }
      debugLog(`[llm-compact] LLM compact failed (null summary)`)
      return {
        failures: recordCompactFailure(input.failures, this.deps.session.getTurnCount()),
        compacted: false,
      }
    }

    // Deterministic actions ('micro' / 'stale-round') from here on.
    // 1M windows never ran a deterministic rewrite in maybeCompact before the
    // precision band was surfaced — introduce it strictly at user boundaries
    // (turn 0) so this new path can never shatter a mid-turn prefix.
    if (contextWindow >= 1_000_000 && input.loopTurn !== 0) {
      return { failures: input.failures, compacted: false }
    }

    // Track 4: 显式 cache-miss 成本 vs 压缩收益权衡 — 传入压力上下文，
    // 热缓存只在低压力时挡住压缩，高压力时放行（1M 余量 > 前缀重建成本）。
    if (!actionDecision.force && this.deps.cacheAdvisor?.shouldDelayCompact(actionDecision.tier, { estimatedTokens, contextWindow })) {
      return { failures: input.failures, compacted: false }
    }

    try {
      const { messages: compacted } = this.compactMessages(messages, estimatedTokens)

      // Reclaim gate (2026-07-16 plan task 2): the candidate must prove it
      // reclaims enough context to be worth the prefix-cache rebuild before
      // any history replacement. Rejected candidates leave the session
      // untouched — the next boundary re-evaluates with fresh pressure. A
      // gate skip is NOT a compaction failure (the circuit breaker tracks
      // pipeline errors, not economic vetoes).
      const decision = buildReclaimDecision(
        'micro',
        estimateReclaim(messages, compacted),
        this.reclaimProfile(),
        actionDecision.force,
      )
      this.deps.onReclaimDecision?.(decision)
      if (!decision.commit) {
        debugLog(`[compaction-gate] micro candidate rejected (${decision.reason}): reclaimed=${decision.reclaimedTokens} floor=${this.reclaimProfile().minReclaimTokens}`)
        return { failures: input.failures, compacted: false }
      }

      // Tier 2+: inject a deterministic 4-field summary so the model retains
      // goals/progress/active-files/errors across compaction boundaries.
      // Only inject when compaction actually reduced message count (otherwise
      // the summary adds noise without reclaiming context).
      if (actionDecision.tier >= 2 && compacted.length < messages.length) {
        const taskState = extractTaskState(
          this.deps.getTrajectoryEntries(),
          this.deps.getStreamedText(),
        )
        const filePattern = /(?:\/[^\s\n"'`{}()[\]]+\.[a-z]{1,6})\b/g
        const filesSeen = new Set<string>()
        for (const m of compacted) {
          if (m.role !== 'tool') continue
          for (const match of m.content.matchAll(filePattern)) filesSeen.add(match[0])
        }
        const failures = this.deps.getTrajectoryEntries().filter(
          t => t.status === 'failed' || t.status === 'retried-failed',
        )
        const summaryText = buildCompactSummary({
          taskState: {
            current: taskState.current,
            completed: taskState.completed,
            remaining: taskState.remaining,
            decisions: taskState.decisions,
          },
          turnCount: this.deps.session.getTurnCount(),
          filesSeen: [...filesSeen],
          reasoningSnippet: '',
          errorCount: failures.length,
          errors: failures.slice(0, 5).map(f => ({
            turn: f.turn,
            tool: f.tool,
            target: f.target,
            errorClass: f.errorClass ?? 'unknown',
            summary: f.resultSummary || `${f.tool} in ${f.target} failed`,
          })),
          toolHistory: [],
        })
        compacted.push({ role: 'user', content: summaryText })

        // C4: re-inject the authoritative task anchor after the summary so the
        // objective / constraints / forbidden items survive verbatim.
        const anchorAppendix = this.buildTaskAnchorAppendix()
        if (anchorAppendix) {
          compacted.push({ role: 'user', content: anchorAppendix })
        }
      }

      this.safeReplaceMessages(compacted)
      this.deps.promptEngine.resetAppendixBaseline()
      this.deps.session.markCompacted(input.loopTurn)
      this.deps.pressureMonitor.recordCompaction(this.deps.session.getTurnCount())
      // CVM 开销计数由 resetAppendixBaseline 的回调归零，此处不再单独调用。
      const afterTokens = this.deps.session.getEstimatedTokens()
      this.deps.session.recordCompactEvent({
        turn: this.deps.session.getTurnCount(),
        tier: 1,
        reason: `auto compact: ${actionDecision.reason}`,
        beforeTokens: estimatedTokens,
        afterTokens,
        createdAt: Date.now(),
      })

      // Cache-anchor drift is already captured by the recordCompaction above;
      // recording the same turn a second time inflates the thrashing counter.
      // The anchor-touch check remains for future cache-invalidation tracking.

      this.deps.refreshLedger()
      return { failures: recordCompactSuccess(input.failures), compacted: true }
    } catch {
      return {
        failures: recordCompactFailure(input.failures, this.deps.session.getTurnCount()),
        compacted: false,
      }
    }
  }

  async enforceContextCeiling(): Promise<void> {
    const ceiling = this.deps.contextWindow * 0.95
    if (this.deps.session.getEstimatedTokens() <= ceiling) return

    this.persistExtractedMemories(this.deps.getTrajectoryEntries())

    // Try LLM compact first (short timeout — emergency path, can't wait long)
    if (this.summaryClient()) {
      const summary = await this.llmCompact(30_000, this.deps.getAbortSignal?.())
      if (this.isAbortRequested()) {
        debugLog('[llm-compact] turn aborted after compact returned — skipping ceiling checkpoint replacement')
        return
      }
      if (summary) {
        await this.replaceWithCheckpoint({
          tier: 4,
          reason: 'context ceiling exceeded; LLM compact checkpoint',
          summary,
          maxFallback: ceiling,
          fallbackText: '<checkpoint-resume>Context ceiling exceeded. Continue from preserved cache anchors.</checkpoint-resume>',
          action: 'checkpoint',
          force: true,
        })
        return
      }
    }

    // Fallback: structured extraction when LLM unavailable or fails
    const trajectory = this.deps.getTrajectoryEntries()
    const taskState = extractTaskState(trajectory, this.deps.getStreamedText())

    const stateLines = [
      `Current: ${taskState.current}`,
      ...taskState.completed.map(item => `Completed: ${item}`),
      ...taskState.remaining.map(item => `Remaining: ${item}`),
      ...taskState.decisions.map(item => `Decision: ${item}`),
    ]

    const recentTools = trajectory.slice(-10)
    for (const t of recentTools) {
      const status = t.status === 'failed' ? 'FAIL' : t.status === 'retried-success' ? 'ok*' : 'ok'
      stateLines.push(`Tool: ${t.tool} ${t.target} [${status}]`)
    }

    const failures = trajectory.filter(t => t.status === 'failed' || t.status === 'retried-failed')
    for (const f of failures.slice(0, 5)) {
      stateLines.push(`Failed: ${f.tool} in ${f.target} (${f.errorClass ?? 'unknown'})`)
    }

    const resumeContent = `<checkpoint-resume>\n${stateLines.join('\n')}\n</checkpoint-resume>`

    await this.replaceWithCheckpoint({
      tier: 4,
      reason: 'context ceiling exceeded; checkpoint-resume required',
      summary: resumeContent,
      maxFallback: ceiling,
      fallbackText: '<checkpoint-resume>Context ceiling exceeded. Continue from preserved cache anchors and ask for missing details if needed.</checkpoint-resume>',
      action: 'checkpoint',
      force: true,
    })
  }

  /**
   * Phase 2.3: Proactive session split at 86% context threshold.
   * Tries LLM compact first; falls back to structured handoff extraction.
   */
  async trySessionSplit(): Promise<boolean> {
    if (this.deps.contextWindow < 500_000) return false

    const ratio = this.deps.session.getEstimatedTokens() / this.deps.contextWindow
    if (ratio < 0.86) return false

    const trajectory = this.deps.getTrajectoryEntries()
    this.persistExtractedMemories(trajectory)

    // Try LLM compact first for higher-fidelity summary
    if (this.summaryClient()) {
      const summary = await this.llmCompact(undefined, this.deps.getAbortSignal?.())
      if (this.isAbortRequested()) {
        debugLog('[llm-compact] turn aborted after compact returned — skipping session-split checkpoint replacement')
        return false
      }
      if (summary) {
        await this.replaceWithCheckpoint({
          tier: 3,
          reason: `session split at ${(ratio * 100).toFixed(0)}% context (LLM compact)`,
          summary,
          maxFallback: this.deps.contextWindow * 0.3,
          fallbackText: `<session-handoff>Session split at ${(ratio * 100).toFixed(0)}% context.</session-handoff>`,
          action: 'session-split',
          force: true,
        })
        debugLog(`[session-split] LLM compact ratio=${ratio.toFixed(2)} tokens=${this.deps.session.getEstimatedTokens()}`)
        return true
      }
    }

    // Fallback: deterministic structured handoff (no LLM available or it failed).
    const taskState = extractTaskState(trajectory, this.deps.getStreamedText())
    const handoffContent = this.buildHandoffFromState()

    await this.replaceWithCheckpoint({
      tier: 3,
      reason: `session split at ${(ratio * 100).toFixed(0)}% context`,
      summary: handoffContent,
      maxFallback: this.deps.contextWindow * 0.3,
      fallbackText: `<session-handoff>Session split at ${(ratio * 100).toFixed(0)}% context. ${taskState.current}</session-handoff>`,
      action: 'session-split',
      force: true,
    })

    debugLog(`[session-split] structured handoff ratio=${ratio.toFixed(2)} tokens=${this.deps.session.getEstimatedTokens()}`)

    return true
  }

  /**
   * P6: build the deterministic structured handoff from current session state
   * (task-state + trajectory + recent reasoning). Shared by trySessionSplit's
   * non-LLM fallback and llmCompact's post-check fallback.
   */
  private buildHandoffFromState(): string {
    const trajectory = this.deps.getTrajectoryEntries()
    const messages = this.deps.session.getMessages()
    const taskState = extractTaskState(trajectory, this.deps.getStreamedText())

    const MAX_REASONING_CHARS = 2000
    const reasoningParts: string[] = []
    for (let i = messages.length - 1; i >= 0 && reasoningParts.join('\n').length < MAX_REASONING_CHARS; i--) {
      const m = messages[i]!
      if (m.role === 'assistant' && m.content && m.content.length > 0) {
        reasoningParts.unshift(m.content)
      }
    }

    const filePattern = /(?:\/[^\s\n"'`{}()[\]]+\.[a-z]{1,6})\b/g
    const filesSeen = new Set<string>()
    for (const m of messages) {
      if (m.role !== 'tool') continue
      for (const match of m.content.matchAll(filePattern)) {
        filesSeen.add(match[0])
      }
    }

    const recentTools = trajectory.slice(-10)
    const failures = trajectory.filter(t => t.status === 'failed' || t.status === 'retried-failed')
    return buildStructuredHandoff({
      taskState: {
        current: taskState.current,
        completed: taskState.completed,
        remaining: taskState.remaining,
        decisions: taskState.decisions,
      },
      turnCount: this.deps.session.getTurnCount(),
      filesSeen: [...filesSeen],
      reasoningSnippet: reasoningParts.join('\n\n---\n\n').slice(-MAX_REASONING_CHARS),
      errorCount: failures.length,
      errors: failures.slice(0, 5).map(f => ({
        turn: f.turn,
        tool: f.tool,
        target: f.target,
        errorClass: f.errorClass ?? 'unknown',
        summary: f.resultSummary || `${f.tool} in ${f.target} failed`,
      })),
      toolHistory: recentTools.map(t => ({
        tool: t.tool,
        target: t.target,
        status: t.status,
      })),
      stanceSummary: this.deps.getStanceSummary?.(),
    })
  }

  /**
   * P6: post-check that an LLM summary reflects the material state recorded in
   * the trajectory (failed error classes / touched files). Conservative — only
   * fails when the summary reflects NONE of the dimensions that actually exist,
   * to avoid false positives on legitimate paraphrasing.
   */
  private summaryCoversState(summary: string): boolean {
    const trajectory = this.deps.getTrajectoryEntries()
    const lower = summary.toLowerCase()

    const failures = trajectory.filter(t => t.status === 'failed' || t.status === 'retried-failed')
    const errorClasses = [...new Set(
      failures.map(f => f.errorClass).filter((e): e is string => Boolean(e)),
    )]
    const fileBasenames = [...new Set(
      trajectory
        .map(t => t.target)
        .filter((t): t is string => Boolean(t) && /\.[a-z0-9]{1,8}$/i.test(t))
        .map(t => t.split('/').pop()!.toLowerCase()),
    )]

    const covered: boolean[] = []
    if (errorClasses.length > 0) covered.push(errorClasses.some(e => lower.includes(e.toLowerCase())))
    if (fileBasenames.length > 0) covered.push(fileBasenames.some(f => lower.includes(f)))

    // Nothing material in the trajectory → nothing to verify against.
    if (covered.length === 0) return true
    // Pass if at least one present dimension is reflected in the summary.
    return covered.some(c => c)
  }

  refreshCacheDiagnostic(loopTurn: number): string | null {
    const history = this.deps.session.getCacheHistory()
    // No provider cache data this turn (both counters 0) → no-data, not a 0%
    // hit. getLatestTurnHitRate reports 0 here (inputTokens denominator), which
    // would otherwise surface a spurious "First turn" diagnostic. Nothing to
    // diagnose when the provider reported no cache numbers at all.
    const latest = history[history.length - 1]
    if (latest && latest.cacheRead === 0 && latest.cacheCreation === 0) return null
    const hitRate = this.deps.session.getLatestTurnHitRate()
    if (hitRate !== null && hitRate < 0.8) {
      const diagnostic = diagnoseCacheMiss(
        history,
        this.deps.session.getTurnCount(),
        this.deps.promptEngine.checkDrift(),
        this.deps.session.wasCompactedAt(loopTurn),
      )
      return diagnostic?.message ?? null
    }
    return null
  }

  private compactMessages(
    messages: OaiMessage[],
    tokenCount: number,
  ): { messages: OaiMessage[] } {
    return microCompactOai(messages, this.deps.contextWindow, tokenCount)
  }

  private isAbortRequested(): boolean {
    return this.deps.getAbortSignal?.()?.aborted === true
  }

  /** Whether this provider uses exact-prefix cache (e.g. DeepSeek). */
  isCachePreservingProvider(): boolean {
    return this.deps.providerProfile?.cacheType === 'exact-prefix' && (this.deps.providerProfile?.persistent ?? false)
  }

  /** Reclaim-gate profile: injected model-aware profile, else a conservative
   *  per-token derivation from the provider cache profile (never looser). */
  private reclaimProfile(): CompactionProfile {
    return this.deps.compactionProfile ?? deriveCompactionProfile({
      contextWindow: this.deps.contextWindow,
      billing: 'per-token',
      cache: cacheKindFromProviderProfile(this.deps.providerProfile),
    })
  }

  /**
   * Replace session messages after running OAI orphan-tool_call preflight.
   *
   * Compaction paths (tryPartialCompact, replaceWithCheckpoint, microCompact)
   * can produce message lists where an assistant(tool_calls) survives but its
   * matching tool result was deleted. The OpenAI-compatible API rejects such
   * sequences with: "An assistant message with 'tool_calls' must be followed
   * by tool messages responding to each 'tool_call_id'."
   *
   * runResumePreflightOai detects orphans and inserts synthetic tool results,
   * making the sequence safe to send.
   */
  private safeReplaceMessages(messages: OaiMessage[]): void {
    // Optional pre-compaction transcript snapshot: capture the CURRENT (pre-replace)
    // message list before it is overwritten. This is the single choke point for
    // every compaction path, so one hook covers partial / checkpoint / micro.
    this.maybeBackupTranscript()
    const preflight = runResumePreflightOai(messages, { writeProbe: this.deps.writeProbe })
    if (preflight.repaired) {
      debugLog(`[compact-preflight] repaired ${preflight.syntheticResultsInserted} orphan tool_call(s)`)
    }
    this.deps.session.replaceMessages(preflight.messages)
    // History rewritten — read-ref's "look above" targets may be gone.
    try { this.deps.onHistoryRewritten?.() } catch { /* never block compaction */ }
  }

  private maybeBackupTranscript(): void {
    if (!this.deps.backupTranscript) return
    try {
      this.deps.backupTranscript(this.deps.session.getMessages(), this.deps.session.getTurnCount())
    } catch {
      // Disaster-recovery snapshot is best-effort; never block compaction.
    }
  }

  /**
   * Archive a discarded message zone to cold storage and return a recall
   * reference block to embed in the surviving summary message. Returns null
   * when archiving is unavailable, the zone is empty, or the write fails —
   * compaction must never be blocked by archival (fail-soft).
   */
  private async archiveDiscardedHistory(
    history: OaiMessage[],
    reason: string,
  ): Promise<{ id: string; ref: string } | null> {
    if (!this.deps.archiveHistory) return null
    if (history.length === 0) return null
    try {
      const { rawContent, sections, turnRanges } = serializeMessagesForArchive(history)
      if (rawContent.trim().length === 0) return null
      const turn = this.deps.session.getTurnCount()
      const id = await this.deps.archiveHistory({
        rawContent,
        summary: `compacted ${history.length} messages at turn ${turn} (${reason})`,
        sections,
        target: `session-history@turn${turn}`,
      })
      if (!id) return null
      this.deps.onArchive?.(id, turn)
      const catalog = buildArchiveCatalog(turnRanges, id)
      return { id, ref: buildRecallRefBlock(id, history.length, catalog) }
    } catch {
      return null
    }
  }

  private persistExtractedMemories(trajectory: TrajectoryEntry[]): void {
    if (!this.deps.persistMemories) return

    try {
      const memories = extractSessionMemories(this.deps.session.getMessages(), {
        recentToolTargets: trajectory.map(t => t.target),
      })
      if (memories.length === 0) return
      const payload = memories.map(memory => ({
        text: memory.text,
        source: memory.source,
        kind: memory.kind,
      }))
      void Promise.resolve(this.deps.persistMemories(payload)).catch(() => {})
    } catch {
      // Session memory extraction is opportunistic; compaction must continue.
    }
  }

  /**
   * C4: render the authoritative task anchor for appendix re-injection.
   * Fuses the verbatim contract (objective / constraints / success) with live
   * progress (completed / remaining) from the trajectory-derived task state.
   * Returns null when there is no actionable contract.
   */
  private buildTaskAnchorAppendix(): string | null {
    const contract = this.deps.getActiveContract?.()
    if (!contract) return null
    const taskState = extractTaskState(
      this.deps.getTrajectoryEntries(),
      this.deps.getStreamedText(),
    )
    const anchor = renderTaskAnchor(contract, {
      completed: taskState.completed,
      remaining: taskState.remaining,
    })
    return anchor.length > 0 ? anchor : null
  }

  /**
   * Replace message history with cache anchors + checkpoint summary.
   * Called by trySessionSplit (86% threshold, richer handoff),
   * enforceContextCeiling (95% threshold, emergency fallback), and the
   * maybeCompact LLM ladder.
   *
   * Task 6 force semantics: every checkpoint-style rewrite passes through the
   * reclaim gate and emits a decision record. Forced callers (ceiling /
   * session split — the alternative is an over-window API failure) always
   * commit; discretionary LLM commits must clear the profile floors.
   * Returns whether the rewrite was committed.
   */
  private async replaceWithCheckpoint(params: {
    tier: CompactTier
    reason: string
    summary: string
    maxFallback: number
    fallbackText: string
    action: CompactionAction
    force: boolean
  }): Promise<boolean> {
    const messages = this.deps.session.getMessages()
    const anchorMessages = messages.slice(0, CACHE_ANCHOR_MESSAGES)

    // 尾随「尚未消费的 user 消息」保护（desktop 长消息回归根因）：enforceContextCeiling
    // 在 addUserMessage 之后、模型请求之前评估——此路径上末尾 user 恰是用户刚发送的
    // 指令。整体归档（旧实现 slice(CACHE_ANCHOR_MESSAGES) 一刀切）会把它连同历史一起
    // 摘要替换，模型下一请求看到的是压缩版指令（用户观感 = 消息被截断）。
    // 判据「末尾即 user」复用 history-invariant 探针口径：末尾 user 必未被模型消费
    // （消费后会接 assistant 回复）；turn 内工具循环中末尾是 assistant/tool，不命中，
    // 压缩范围与旧行为一致。
    const tail = messages[messages.length - 1]
    const tailIsFreshUser = tail?.role === 'user' && messages.length - 1 > CACHE_ANCHOR_MESSAGES
    const archiveEnd = tailIsFreshUser ? messages.length - 1 : messages.length
    const tailPreserved: OaiMessage[] = tailIsFreshUser ? [tail] : []

    // Layered archival: the messages after the anchor are about to be dropped
    // and replaced by the summary. Archive them as a recallable compact-history
    // artifact and embed the recall reference into the summary (and fallback)
    // text — both are freshly-written messages, so the anchor prefix is intact.
    // 尾随 user 原文不在丢弃段内（archiveEnd 已止于其前）——原文不进归档、留在上下文。
    const discarded = messages.slice(CACHE_ANCHOR_MESSAGES, archiveEnd)
    const archive = await this.archiveDiscardedHistory(discarded, params.reason)
    const summaryText = archive ? `${params.summary}${archive.ref}` : params.summary
    const fallbackText = archive ? `${params.fallbackText}${archive.ref}` : params.fallbackText

    // 摘要以 assistant 角色置于原文之前（仅当存在尾随原文）：避免中间位置出现第二条
    // user 消息——promptEngine 对非 trailer 的历史 user 会做 volatileBlock 回退注入
    // （双份注入/膨胀）；原文占据 trailer 位，volatile/appendix 注入路径与无 tail 一致。
    // 无尾随 user 时保持旧形态（user 摘要收尾）。
    const summaryRole = tailPreserved.length > 0 ? 'assistant' : 'user'
    let candidate: OaiMessage[] = [
      ...anchorMessages,
      { role: summaryRole, content: summaryText },
      ...tailPreserved,
    ]

    if (estimateOaiTokens(candidate) > params.maxFallback) {
      candidate = [
        ...anchorMessages,
        { role: summaryRole, content: fallbackText },
        ...tailPreserved,
      ]
    }

    // C4: append the authoritative task anchor at the tail (appendix region —
    // never the frozen prefix, so prefix-cache stays intact). The anchor is the
    // ground truth the model defers to if the summary above drifted.
    const anchorAppendix = this.buildTaskAnchorAppendix()
    if (anchorAppendix) {
      candidate.push({ role: 'user', content: anchorAppendix })
    }

    const decision = buildReclaimDecision(
      params.action,
      estimateReclaim(messages, candidate),
      this.reclaimProfile(),
      params.force,
    )
    this.deps.onReclaimDecision?.(decision)
    if (!decision.commit) {
      debugLog(`[compaction-gate] ${params.action} checkpoint rejected (${decision.reason}): reclaimed=${decision.reclaimedTokens}`)
      return false
    }

    const beforeTokens = decision.beforeTokens
    this.safeReplaceMessages(candidate)
    this.deps.promptEngine.resetAppendixBaseline()
    this.deps.session.recordCompactEvent({
      turn: this.deps.session.getTurnCount(),
      tier: params.tier,
      reason: params.reason,
      beforeTokens,
      afterTokens: this.deps.session.getEstimatedTokens(),
      createdAt: Date.now(),
    })
    this.deps.refreshLedger()
    return true
  }

  /**
   * T8: Partial Compact — summarize only old messages, preserve recent ones.
   * Splits messages into: anchor (first 2) + old zone + recent zone (last N).
   * Only the old zone is summarized via LLM; recent messages are kept intact.
   * Returns true if successful, false if LLM summary failed.
   */
  async tryPartialCompact(recentToPreserve = 60): Promise<boolean> {
    const summaryClient = this.summaryClient()
    if (!summaryClient) return false
    if (this._llmCompactInFlight) return false

    const messages = this.deps.session.getMessages()
    const anchorCount = CACHE_ANCHOR_MESSAGES
    if (messages.length <= anchorCount + recentToPreserve + 4) {
      debugLog(`[partial-compact] not enough messages to split (${messages.length} total, need > ${anchorCount + recentToPreserve + 4})`)
      return false
    }

    const anchor = messages.slice(0, anchorCount)
    const rawSplitPoint = messages.length - recentToPreserve
    const splitPoint = findSafeSplitPoint(messages, rawSplitPoint, anchorCount)
    // If the safe split point leaves too few oldZone messages, skip compaction
    if (splitPoint <= anchorCount + 4) {
      debugLog(`[partial-compact] safe split point ${splitPoint} too close to anchor ${anchorCount} — skipping`)
      return false
    }
    const oldZone = messages.slice(anchorCount, splitPoint)
    const recentZone = messages.slice(splitPoint)

    debugLog(`[partial-compact] anchor=${anchor.length} old=${oldZone.length} recent=${recentZone.length}`)

    const userIntentChain = extractUserIntentChain(oldZone)
    const writeActionChain = extractWriteActionChain(this.deps.getTrajectoryEntries())
    const partialBudget = this.summaryBudget().partial
    const summaryPrompt: OaiMessage = {
      role: 'user',
      content: [
        '请总结以下对话片段的关键信息（这是对话的较早部分，最近的消息会被完整保留）。',
        '',
        ...this.mergeClause(this.hasPriorSummary(oldZone)),
        '## 用户意图链（按时间序）',
        ...userIntentChain.map((m, i) => `${i + 1}. ${m}`),
        '',
        ...(writeActionChain.length > 0
          ? [
              '## 变更动作清单（防止重复劳动，必须逐条保留）',
              ...writeActionChain.map((m, i) => `${i + 1}. ${m}`),
              '同时列出所有改动机器状态的非只读命令；不要列入只读动作（读取/搜索/grep/glob）。',
              '',
            ]
          : []),
        '## 保留',
        '1. 每条用户消息的核心意图',
        '2. 关键技术决策和原因',
        '3. 涉及的文件路径和变更摘要',
        '4. 错误和修复方法',
        '',
        '## 丢弃',
        '- 工具输出详情（只保留结论）',
        '- 探索性搜索的中间过程',
        '',
        `控制在 ${partialBudget} 字以内。只输出总结，不要调用工具。`,
      ].join('\n'),
    }

    this._llmCompactInFlight = true
    try {
      const compactMessages: OaiMessage[] = [...anchor, ...oldZone, summaryPrompt]
      const request = this.deps.promptEngine.buildOaiRequest(
        compactMessages,
        undefined,
        this.deps.contextWindow,
        { sidePath: true },
      )
      request.tools = undefined

      const chunks: string[] = []
      let errored = false
      const signal = this.deps.getAbortSignal?.()
      const timeoutSignal = AbortSignal.timeout(60_000)
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal

      try {
        await summaryClient.stream(request, {
          onTextDelta: (text) => { chunks.push(text) },
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          // onStopReason can fire more than once (finish frame, then usage
          // frame) — only book the call once real token counts arrive.
          onStopReason: (_reason, usage) => {
            if (usage && (usage.input_tokens ?? 0) > 0) {
              this.deps.recordSummaryUsage?.(usage, request.model)
            }
          },
          onError: () => { errored = true },
        }, combinedSignal)
      } catch {
        return false
      }

      if (errored || chunks.length === 0) return false
      const summary = chunks.join('').trim()
      if (summary.length === 0) return false

      // Layered archival: archive the oldZone (verbatim) and embed a recall
      // reference into the summary message so the model can read_section any
      // earlier message instead of trusting the lossy LLM summary alone. The
      // ref lives inside the freshly-written summary message — never the anchor
      // prefix — so this stays prefix-cache safe. Fail-soft: a null archive
      // simply means the summary ships without a recall pointer.
      const archive = await this.archiveDiscardedHistory(oldZone, 'partial-compact')

      // W3-C1: same state-coverage post-check as llmCompact (line ~1344).
      // Partial compact has two deterministic backstops — the verbatim archive
      // (recall ref) and the task-anchor appendix. Only when BOTH are absent
      // would this lossy summary be the sole carrier of the discarded history;
      // in that case a summary reflecting none of the material state must not
      // commit the rewrite (fail-open to context occupancy).
      if (!archive && !this.buildTaskAnchorAppendix() && !this.summaryCoversState(summary)) {
        debugLog('[partial-compact] summary failed state-coverage post-check with no archive/anchor backstop — skipping rewrite')
        return false
      }

      const summaryBody = archive ? `${summary}${archive.ref}` : summary

      const summaryMessage: OaiMessage = {
        role: 'assistant',
        content: `<partial-compact-summary turn="${this.deps.session.getTurnCount()}">\n${summaryBody}\n</partial-compact-summary>`,
      }

      // P3: persist heuristic memories before history is replaced —
      // extractSessionMemories reads the live message list, so it must run while
      // the old zone is still present (same ordering as enforceContextCeiling).
      this.persistExtractedMemories(this.deps.getTrajectoryEntries())

      // P1: append the authoritative task anchor, matching replaceWithCheckpoint.
      // The LLM summary above may drift or drop constraints/scope, and the
      // preserved recent zone may not contain the original constraint
      // declarations — without this anchor, partial compact has no deterministic
      // fallback for the task contract (issue 1 × issue 2 crossover gap).
      // A3: proactively evict aged compact-history recall blocks that are still
      // sitting in the recent zone. A recall pulls a (potentially large) block
      // back via read_section; once it has aged past the last RECALL_KEEP_RECENT
      // recalls it can be folded back to a one-line pointer here — the original
      // bytes remain in the artifact and stay re-recallable. The most recent
      // recalls are kept verbatim: the model just asked for them.
      const collapsedRecent = foldAgedRecallBlocks(recentZone, RECALL_KEEP_RECENT)

      const newMessages = [...anchor, summaryMessage, ...collapsedRecent]
      const anchorAppendix = this.buildTaskAnchorAppendix()
      if (anchorAppendix) {
        newMessages.push({ role: 'user', content: anchorAppendix })
      }

      // Reclaim gate: a partial compact that fails to reclaim the profile
      // floor (e.g. tiny oldZone vs a large recall-laden summary) must not
      // shatter the prefix for nothing. The side-path summary cost is already
      // booked either way; skipping the rewrite keeps the cache intact.
      const decision = buildReclaimDecision('partial-llm', estimateReclaim(messages, newMessages), this.reclaimProfile(), false)
      this.deps.onReclaimDecision?.(decision)
      if (!decision.commit) {
        debugLog(`[compaction-gate] partial-llm candidate rejected (${decision.reason}): reclaimed=${decision.reclaimedTokens}`)
        return false
      }
      this.safeReplaceMessages(newMessages)
      this.deps.promptEngine.resetAppendixBaseline()
      this.deps.refreshLedger()

      debugLog(`[partial-compact] success: ${messages.length} → ${newMessages.length} messages (removed ${oldZone.length} old, kept ${recentZone.length} recent${anchorAppendix ? ', +task-anchor' : ''})`)
      return true
    } finally {
      this._llmCompactInFlight = false
    }
  }

  /**
   * Issue one side-path summary request and return its text (null on
   * error/timeout/empty).
   *
   * Callers pass the full live history plus a trailing instruction message, so
   * the request prefix stays identical to the main conversation and the side
   * path reuses the prefix cache rather than paying for a fresh read.
   *
   * Side-path discipline (CLAUDE.md): `buildOaiRequest` is called with
   * `{ sidePath: true }` so the main path's wire baseline is never touched, and
   * the caller's message objects are only spread — never mutated in place,
   * which would flip system bytes mid-flight for a concurrent `stream()`.
   */
  private async streamSummary(
    requestMessages: OaiMessage[],
    timeoutMs: number,
    userSignal?: AbortSignal,
  ): Promise<string | null> {
    const summaryClient = this.summaryClient()
    if (!summaryClient) return null

    const request = this.deps.promptEngine.buildOaiRequest(
      requestMessages,
      undefined,
      this.deps.contextWindow,
      { sidePath: true },
    )
    request.tools = undefined

    const chunks: string[] = []
    let errored = false
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = userSignal
      ? AbortSignal.any([userSignal, timeoutSignal])
      : timeoutSignal
    try {
      await summaryClient.stream(request, {
        onTextDelta: (text) => { chunks.push(text) },
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        // Same usage booking as tryPartialCompact — see recordSummaryUsage.
        onStopReason: (_reason, usage) => {
          if (usage && (usage.input_tokens ?? 0) > 0) {
            this.deps.recordSummaryUsage?.(usage, request.model)
          }
        },
        onError: () => { errored = true },
      }, signal)
    } catch {
      return null
    }

    if (errored || chunks.length === 0) return null
    const text = chunks.join('').trim()
    return text.length > 0 ? text : null
  }

  /**
   * Forked Agent LLM compaction: sends a compact-summary request through the
   * primary model's StreamClient, reusing cache anchors (first 2 messages)
   * for ~90% prefix cache hit rate.
   *
   * @returns compact summary string, or null if primaryClient unavailable
   *          or session has insufficient messages.
   */
  async llmCompact(timeoutMs = 60_000, userSignal?: AbortSignal): Promise<string | null> {
    const summaryClient = this.summaryClient()
    if (!summaryClient) return null
    if (this._llmCompactInFlight) return null
    this._llmCompactInFlight = true

    try {
      const messages = this.deps.session.getMessages()
      if (messages.length < CACHE_ANCHOR_MESSAGES + 2) return null

      const userIntentChain = extractUserIntentChain(messages)
      const writeActionChain = extractWriteActionChain(this.deps.getTrajectoryEntries())
      const compactMessages: OaiMessage[] = [
        ...messages,
        {
          role: 'user' as const,
          content: [
            '请总结上述对话的关键信息，用于上下文压缩。',
            '',
            ...this.mergeClause(this.hasPriorSummary(messages)),
            '## 必须完整保留的用户意图链',
            '以下是用户所有消息（按时间序），**必须逐条保留核心意图，不得合并或遗漏**：',
            ...userIntentChain.map((m, i) => `${i + 1}. ${m}`),
            '',
            ...(writeActionChain.length > 0
              ? [
                  '## 必须完整保留的变更动作清单（防止新会话重复劳动）',
                  '以下是本会话已执行的文件写操作（按时间序），**必须逐条保留，不得省略或合并**：',
                  ...writeActionChain.map((m, i) => `${i + 1}. ${m}`),
                  '此外必须列出所有改动过机器状态的**非只读命令**（安装/生成/迁移/git commit·push/构建产物）；',
                  '**不要**列入只读动作（读取/搜索/grep/glob/git status·diff）——它们无需保留。',
                  '',
                ]
              : []),
            '## 保留以下内容',
            '1. 用户的核心需求和意图演变（如果用户纠正了 agent 的理解，以用户的纠正为准）',
            '2. 所有关键技术决策及其原因',
            '3. 涉及的文件路径及变更摘要',
            '4. 遇到的错误及修复方法',
            '5. 当前工作状态和进度',
            '6. 明确的待办事项和下一步',
            '',
            '## 丢弃以下内容',
            '- 工具输出的详细内容（只保留结论）',
            '- 探索性搜索的中间过程',
            '- 重复的状态汇报',
            '（注意：只读探索动作可丢弃，但**写操作本身不可丢**——只丢弃其冗长输出）',
            '',
            `只输出总结内容，不要调用工具。格式用 markdown，控制在 ${this.summaryBudget().full} 字以内。`,
          ].join('\n'),
        },
      ]

      const summary = await this.streamSummary(compactMessages, timeoutMs, userSignal)
      if (summary === null) return null

      // P6: post-check — if the summary reflects none of the material state
      // (failed error classes / touched files) recorded in the trajectory, fall
      // back to the deterministic structured handoff rather than trust a summary
      // that likely dropped critical context.
      if (!this.summaryCoversState(summary)) {
        debugLog('[llm-compact] summary failed state-coverage post-check — using structured handoff')
        return this.buildHandoffFromState()
      }

      return `<compact-summary turn="${this.deps.session.getTurnCount()}" tokens="${this.deps.session.getEstimatedTokens()}">\n${summary}\n</compact-summary>`
    } finally {
      this._llmCompactInFlight = false
    }
  }

  /**
   * Rewind point-summarisation: replace ONE contiguous range of the history
   * with an LLM summary, leaving everything outside the range byte-identical.
   * `/compact` compresses everything; this compresses a span the user picked.
   *
   * Cache cost differs sharply by scope, which is why the two are distinct
   * actions rather than one with a flag:
   *  - `from`: keeps `messages[0..messageIndex)` verbatim, so the prefix still
   *    hits all the way up to the cut. Only the new tail is paid for.
   *  - `to`:   rewrites near the head, so every byte after the cache anchors
   *    changes → full prefix rebuild on the next request. Callers must surface
   *    that cost to the user (see the rewind overlay's risk line), and only for
   *    providers where it is actually a cost — `isCachePreservingProvider()`.
   *
   * Unlike the automatic ladder this deliberately runs NO reclaim gate: that
   * gate is an economic veto for compaction the system chose to do on its own.
   * Here the user explicitly asked, so vetoing it would just look broken.
   */
  async summarizeRange(params: {
    scope: 'from' | 'to'
    messageIndex: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ ok: true; beforeTokens: number; afterTokens: number; replaced: number } | { ok: false; reason: string }> {
    if (!this.summaryClient()) return { ok: false, reason: '未配置可用于摘要的模型客户端' }

    const messages = this.deps.session.getMessages()
    const idx = Math.max(0, Math.min(params.messageIndex, messages.length))

    // The replaced span. `to` keeps the cache anchors verbatim for the same
    // reason replaceWithCheckpoint does — they are the cheapest bytes to hold
    // on to, and dropping them buys nothing.
    //
    // 边界含选中消息的方向是 `to`（idx 不进 [from, to)）；`from` 必须 idx+1——
    // UI 文案承诺「把此消息之后的内容压成摘要」，选中消息本身是用户挑的保留
    // 锚点，卷进摘要就违背承诺（off-by-one，2026-07-27 审查发现）。
    const from = params.scope === 'from' ? idx + 1 : Math.min(CACHE_ANCHOR_MESSAGES, idx)
    const to = params.scope === 'from' ? messages.length : idx
    const span = to - from
    if (span < 2) return { ok: false, reason: '选定范围内的消息太少，无需摘要' }

    const budget = this.summaryBudget().partial
    const scopeClause = params.scope === 'from'
      ? `本次**只总结上述对话的最后 ${span} 条消息**，此前的内容原样保留、不要复述。`
      : `本次**只总结上述对话最前面的第 ${from + 1} 至 ${to} 条消息**，其后的内容原样保留、不要复述。`

    const summary = await this.streamSummary(
      [
        ...messages,
        {
          role: 'user' as const,
          content: [
            '请对下述指定范围内的对话做压缩摘要。',
            '',
            scopeClause,
            '',
            '## 保留',
            '1. 用户在该范围内的核心需求与意图演变（用户纠正过 agent 的理解时，以用户的纠正为准）',
            '2. 关键技术决策及其原因',
            '3. 涉及的文件路径与变更摘要',
            '4. 遇到的错误及修复方法',
            '5. 该范围结束时的工作状态与未完成事项',
            '',
            '## 丢弃',
            '- 工具输出的详细内容（只保留结论）',
            '- 探索性搜索的中间过程与重复的状态汇报',
            '（只读探索可丢弃，但**写操作本身不可丢**——只丢弃其冗长输出）',
            '',
            `只输出总结内容，不要调用工具。格式用 markdown，控制在 ${budget} 字以内。`,
          ].join('\n'),
        },
      ],
      params.timeoutMs ?? 60_000,
      params.signal,
    )
    if (summary === null) return { ok: false, reason: '摘要生成失败（模型无响应、超时或被中断）' }

    const beforeTokens = estimateOaiTokens(messages)
    const archive = await this.archiveDiscardedHistory(
      messages.slice(from, to),
      `rewind summarize-${params.scope}`,
    )
    const body = `<rewind-summary scope="${params.scope}" messages="${span}">\n${summary}\n</rewind-summary>${archive?.ref ?? ''}`

    const candidate: OaiMessage[] = [
      ...messages.slice(0, from),
      { role: 'user', content: body },
      ...messages.slice(to),
    ]

    this.safeReplaceMessages(candidate)
    this.deps.promptEngine.resetAppendixBaseline()
    const afterTokens = this.deps.session.getEstimatedTokens()
    this.deps.session.recordCompactEvent({
      turn: this.deps.session.getTurnCount(),
      tier: 2,
      reason: `rewind summarize-${params.scope} (${span} messages)`,
      beforeTokens,
      afterTokens,
      createdAt: Date.now(),
    })
    this.deps.refreshLedger()
    return { ok: true, beforeTokens, afterTokens, replaced: span }
  }

  /**
   * Build a structured handoff text from current session state.
   * Called by AgentLoop.runPostSession to persist for the next session.
   */
  buildSessionHandoff(): string {
    const messages = this.deps.session.getMessages()
    const trajectory = this.deps.getTrajectoryEntries()
    const streamedText = this.deps.getStreamedText()
    const taskState = extractTaskState(trajectory, streamedText)
    const turnCount = this.deps.session.getTurnCount()

    // Extract files seen from user + assistant messages
    const filesSeen = new Set<string>()
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        const matches = m.content.matchAll(/(?:^|\s)([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml))/g)
        for (const match of matches) {
          if (match[1]) filesSeen.add(match[1])
        }
      }
    }

    // Extract errors from trajectory
    const errors: StructuredHandoffInput['errors'] = trajectory
      .filter(t => t.status === 'failed' || t.status === 'retried-failed')
      .map(t => ({
        turn: t.turn,
        tool: t.tool,
        target: t.target,
        errorClass: t.errorClass ?? 'unknown',
        summary: t.resultSummary.slice(0, 120),
      }))

    // Build tool history
    const toolHistory: StructuredHandoffInput['toolHistory'] = trajectory.map(t => ({
      tool: t.tool,
      target: t.target,
      status: t.status,
    }))

    const reasoningParts: string[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        reasoningParts.push(m.content)
      }
    }
    const reasoningSnippet = reasoningParts.slice(-3).join('\n')

    return buildStructuredHandoff({
      taskState,
      turnCount,
      filesSeen: [...filesSeen].sort(),
      reasoningSnippet,
      errorCount: errors.length,
      errors,
      toolHistory,
      stanceSummary: this.deps.getStanceSummary?.() ?? null,
    })
  }
}
