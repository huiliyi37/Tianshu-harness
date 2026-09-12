import type { OaiChatRequest, OaiContentPart, OaiMessage, OaiToolDefinition } from '../api/oai-types.js'
import { pruneOutdatedQueryResults } from '../compact/semantic-prune.js'
import { collapseToolResult } from '../compact/context-collapse.js'
import { detectStaleness } from '../compact/staleness-detect.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'
import { estimateOaiTokens } from '../compact/micro.js'
import { buildSystemPrompt, type StaticPromptContext } from './static.js'
import type { ToolDefinition } from '../api/types.js'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendixParts, buildConsolidatedBlock, renderTaskDepthAdvisory, renderPlanMethodologyAdvisory, FROZEN_BLOCK_CAPS, type AppendixPart, type VolatileContext, type ToolHistoryEntry } from './volatile.js'
import type { CvmInjectionSource } from '../context/pressure-monitor.js'
import type { BudgetInput } from './prefix-budget.js'
import { analyzeVolatilePayload, LARGE_VOLATILE_PAYLOAD_CHARS, type VolatilePayloadReport } from '../context/payload-diagnostic.js'
import { selectProjectInstructions } from './project-instructions.js'
import type { TaskState } from '../agent/task-state.js'
import type { ContextClaim } from '../context/claims.js'
import type { PlaybookBullet } from '../agent/playbook.js'
import type { WorktreeReality } from '../agent/worktree-reality.js'
import {
  computeFingerprint,
  detectDrift,
  type PrefixFingerprint,
  type DriftEvent,
} from './fingerprint.js'
import { FieldHabituationTracker } from './field-habituation.js'
import { isSystemReminder } from './system-reminder.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import type { WriteProbe } from '../context/write-evidence-probe.js'
import { createContextLayer, createContextLayerReport, type ContextLayerReport } from './context-layer.js'
import { debugLog } from '../utils/debug.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { parseFrozenSnapshotData, type FrozenSnapshotData } from './frozen-snapshot.js'
import { stableStringify } from '../api/stable-json.js'

export type { PrefixFingerprint, DriftEvent, ContextLayerReport }
export type { FrozenSnapshotData } from './frozen-snapshot.js'

/**
 * T7 request-time collapse: window fill-ratio above which the *full* pass runs
 * (collapsing old tool results into summaries, not just the lightweight
 * reasoning-strip + dup-fold). The full pass breaks the exact-prefix cache on
 * DeepSeek-class providers, so it is deferred until the window is genuinely
 * near-full. See the call site in {@link PromptEngine} for the cost rationale.
 */
const FULL_COLLAPSE_FILL_RATIO = 0.85

/**
 * T7 collapse FLOOR: below this window fill-ratio, request-time collapse does
 * not run at all (neither the watermark advances nor any rewrite happens).
 *
 * Rationale (exact-prefix economics): old reasoning_content / tool results that
 * sit in the cached prefix are CHEAP to keep — they serve from cache-read
 * (~0.025元/M on V4-PRO). Collapsing them rewrites history, which breaks the
 * exact-prefix cache from the touched message onward — a one-time cache-MISS
 * rebuild (~3元/M, 120× the read price). Below the floor there is ample headroom
 * to the window limit, so keeping cached tokens is strictly cheaper than the
 * break. Session-overflow is handled separately by trySessionSplit at 86%, which
 * already rewrites at a cold-start boundary. Observed motivation: a session at
 * fillRatio ~0.2 took a 169K-token break when the watermark advanced for savings
 * it had no need for (mqhs/ed32f759 uMsg9). Collapse only earns its break when
 * the window is genuinely filling. Tunable.
 */
const COLLAPSE_FLOOR_FILL_RATIO = 0.5

/** Fast non-crypto hash for content dedup (djb2 on first 2000 chars + length). */
function simpleHash(s: string): string {
  let h = 5381
  const len = Math.min(s.length, 2000)
  for (let i = 0; i < len; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${h}:${s.length}`
}

/** Full-content djb2 (no truncation) — prefix-divergence probe needs to detect
 *  byte changes anywhere in a message, not just the first 2000 chars. */
function fullHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${h}:${s.length}`
}

/**
 * Prefix-divergence probe result: how this request's serialized messages
 * differ from the previous MAIN-turn request. `null`-able consume-once value —
 * see {@link PromptEngine.consumePrefixDivergence}.
 *
 * Motivation (2026-07-05 cache investigation): DeepSeek 落盘缓存按"完整前缀
 * 单元"命中。cacheRead 相对上一次调用倒退意味着两种可能——客户端字节改动
 * （历史消息被改写）或服务端落盘失败（尽力而为）。cache-log 只有 token 数，
 * 分不出两者。这个探针在客户端侧记录逐消息哈希差异：倒退事件若伴随
 * prefixDiverged 记录 → 客户端改动（并指认是哪条消息）；若无 → 服务端落盘失败。
 */
export interface PrefixDivergence {
  /** Index into the request's messages array (0 = system message). */
  idx: number
  role: string
  kind: 'message_changed' | 'message_removed'
  prevCount: number
  newCount: number
  /** Approximate char offset of the diverged message's start in the serialized request. */
  approxCharPos: number
}

/** Serialize one request message to the byte-relevant parts for hashing. */
function messageSignature(m: OaiMessage): { sig: string; len: number } {
  const rec = m as unknown as Record<string, unknown>
  let s = typeof m.content === 'string' ? m.content : (m.content == null ? '' : JSON.stringify(m.content))
  if (rec.tool_calls) s += '\u0000' + JSON.stringify(rec.tool_calls)
  if (rec.reasoning_content) s += '\u0000' + String(rec.reasoning_content)
  if (rec.tool_call_id) s += '\u0000' + String(rec.tool_call_id)
  return { sig: `${m.role}\u0000${fullHash(s)}`, len: s.length }
}

export interface PromptEngineConfig {
  model: string
  maxTokens: number
  staticCtx: StaticPromptContext
  volatileCtx: VolatileContext
  /** Approval mode at construction (AgentConfig.approvalMode). Live changes go
   *  through setApprovalMode(); only the unattended level renders a prompt note. */
  approvalMode?: string
  habituationThreshold?: number
  attentionProfile?: { effectiveAttentionRatio: number; toolDensityThreshold: number; collapseAgeTurns: number }
  /** Prefix cache mode — 'deepseek-native' enables immediate promotion of
   *  session-constant fields (star-domain) to skip habituation warm-up. */
  prefixCache?: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  /** Enable append-only delta context-update (only emit changed sub-blocks). */
  appendixDelta?: boolean
  /** /cd: inherit frozen snapshots + T7 watermark from a previous engine so a
   *  mid-session cwd switch replays historical user messages byte-identically.
   *  The prefix cache then only tail-cuts at the next user boundary (same cost
   *  model as a domain switch) instead of a /resume-style byte-0 full miss.
   *  FrozenSnapshotData 形态：resume 时从 `<id>.frozen.json` 读回的盘存快照，
   *  与活引擎继承同语义。形状不合法（v!==1/非数组）静默忽略继承。 */
  inheritFrozenFrom?: PromptEngine | FrozenSnapshotData
}

export class PromptEngine {
  private systemPrompt: string
  private volatileBlock: string
  private frozenBase: string
  private fingerprint: PrefixFingerprint
  private config: PromptEngineConfig
  private tracker: FieldHabituationTracker | null
  private consolidatedBlock: string = ''
  /** Cache key: last user message content — triggers rebuild when it changes. */
  private cachedFreshForUser: string = ''
  /** P1: cached dynamic appendix, appended as standalone message at end of result.
   *  Computed once when a new user message arrives, reused across tool-call turns. */
  private cachedAppendix: string = ''
  /** P1: cached consolidated block from habituation tracker.
   *  Stable across turns after promotion — placed BEFORE userContent so
   *  it enters the prefix cache (unlike cachedAppendix, which sits after). */
  private cachedConsolidated: string = ''
  /**
   * Frozen merged content for historical user messages (preserves prefix stability).
   * Maps user-message content → array of committed snapshots. One entry per
   * user-message *instance* (boundary commit); duplicate text ("继续" twice)
   * → index 0, index 1, … via frozenFetchIndex.
   *
   * Intra-turn appendix revisions live in frozenPendingMerged until the next
   * real user boundary — never pushed into this array per tool turn.
   */
  private frozenUserMerged: Map<string, string[]> = new Map()
  /** Latest merged trailer for the active last-user message (pre-commit). */
  private frozenPendingMerged: Map<string, string> = new Map()
  /** Per-content fetch index — tracks which entry to retrieve next per content key. */
  private frozenFetchIndex: Map<string, number> = new Map()
  /** Maximum total entries across all content keys before eviction kicks in. */
  private static readonly MAX_FROZEN_USER_MERGED = 64
  /**
   * Content key of the FIRST user message in the current session. Its frozen
   * snapshot is the byte-0 anchor of the whole prefix — if eviction deletes it,
   * the first user message rebuilds with the current (possibly swapped)
   * volatileBlock → full 0% prefix cache break. Excluded from eviction.
   */
  private firstUserKey: string | null = null
  private taskProgress?: TaskState
  private repairHint?: string | null
  private toolContext?: string | null
  private planCacheAdvisory?: string | null
  /** U6: serialized PlanExecutionTrace appendix (survives compaction). */
  private planTraceAppendix?: string | null
  /** Approved-plan pointer (slug/title/path only) — dynamic appendix, never frozen. */
  private activePlanPointer?: string
  private intentRetrievalRoute?: string | null
  private taskDepthLayer?: import('../context/task-contract.js').TaskDepthLayer
  /** Advisory text — only set when task depth layer changes, null otherwise to avoid noise. */
  private taskDepthAdvisory: string | null = null
  private planMethodology?: import('../context/task-contract.js').PlanMethodology
  private planMethodologyReason?: string
  /** Whether the last setPlanMethodology was under Plan Mode (design-doc advisory). */
  private planMethodologyPlanMode = false
  /** Advisory text — only set when methodology changes, null otherwise to avoid noise. */
  private planMethodologyAdvisory: string | null = null
  /** Approved-plan execution discipline block — set on plan approval, cleared
   *  on next plan-mode entry. Cache-safe: dynamic appendix only. */
  private planExecutingBlock: string | null = null
  private skillAdvisoryBlock?: string | null
  private invokedSkillNames = new Set<string>()
  private crossSessionMemoryBlock?: string | null
  private mentionContextBlock?: string | null
  private harnessAdvisoryBlock?: string | null
  private controlPlaneBlock?: string | null
  /** Doom-loop / storm turns: force terse output-style in dynamic appendix. */
  private tersenessEscalate = false
  private decisions?: string[]
  private activeDomain?: VolatileContext['activeDomain']
  private activeClaims?: VolatileContext['activeClaims']
  /** spec 3c 动作 B：排除路径锚点（spark 会话专属；追加式 + cap，创建序稳定）。
   *  非 spark 会话恒空 → <excluded-paths> 零渲染零字节差异。 */
  private excludedPathAnchors: string[] = []
  /** Goal anchor（spec 3c 动作 B 补强）：会话当前目标，覆盖语义。 */
  private goalAnchor: string | null = null
  private playbookLessons?: VolatileContext['playbookLessons']
  private onLessonsRendered?: (ids: string[]) => void
  private sessionMemoryOverride?: string
  private contextLayerReportData: ContextLayerReport
  private phaseHint?: string
  private cognitiveProjection?: string
  /** Per-turn one-shot cognitive hints, emitted outside appendixDelta (C1 fix). */
  private cognitiveEphemeral?: string
  private crossSessionEvents?: string
  private companionPresence?: string
  private sessionStateText?: string
  private worktreeReality?: WorktreeReality
  /** Plan Mode state — when 'planning', rendered into volatile block */
  private planModeState?: 'off' | 'planning' | 'approved'
  /** Ask Mode state — when 'asking', rendered into volatile appendix */
  private askModeState?: 'off' | 'asking'
  /** Approval mode — rendered into the dynamic appendix as a permission note
   *  when unattended (dangerously-skip-permissions). Live-updated via
   *  setApprovalMode(); never frozen — the mode flips mid-session. */
  private approvalMode?: string
  /** Active plan file path (relative) — shown in plan-mode block */
  private activePlanFilePath?: string | null
  /** One-shot: emit the plan-mode exit reminder on the next rendered turn. */
  private planExitReminderPending?: boolean
  /** Whether current turn message warrants task-mode scaffolding (task contract, CVM, etc.).
   *  Replaces the old binary chat/task PromptMode — auto-detected from message content. */
  private actionableTurn: boolean = true
  private gitDirty = false
  /**
   * T7 watermark: request-copy collapse only applies to message indices below
   * this boundary. Advancing only on 50K-token steps (not every turn) keeps the
   * collapse boundary stable across requests — a sliding boundary would rewrite
   * more request bytes every turn and permanently break the prefix cache.
   */
  private collapseWatermark = 0
  /** Last 50K-token step at which the watermark was advanced. */
  private collapseTokenStep = -1
  /** Cache-event counters (P2-6 breadcrumbs): queried per-turn by cache logging. */
  private frozenSnapshotClamps = 0
  private frozenFallbackRebuilds = 0
  private volatileSwapCount = 0
  private toolsUpdateCount = 0
  /** Tracks message array length to detect true duplicate messages vs tool-call turns. */
  private lastMessageCount: number = 0
  /** Hash of last message array to distinguish exact same call from true duplicate. */
  private lastMessageHash: string = ''
  private userMessagesSinceGitRefresh = 0
  /** Prefix-divergence probe: per-message signatures of the previous request. */
  private prevRequestSignatures: Array<{ sig: string; len: number }> | null = null
  /** Latest divergence vs the previous request (consume-once via consumePrefixDivergence). */
  private lastPrefixDivergence: PrefixDivergence | null = null
  /** Append-only delta: last emitted context-update sub-blocks (name→content). */
  private lastEmittedAppendixParts: Map<string, string> = new Map()
  /** Monotonic context-update sequence number (model orders updates by seq). */
  private appendixSeq = 0
  /** Whether a full baseline context-update was sent since last reset. */
  private appendixBaselineSent = false
  /**
   * CVM egress ledger: chars of metered appendix sub-blocks ACTUALLY written
   * into a <context-update> since the last drain. Booked at the emission point
   * so a block that is byte-stable (delta suppresses it), dropped by Top-K, or
   * simply not rebuilt on a tool turn costs nothing.
   *
   * Invariant: only main-path boundary builds write here — see
   * buildAppendixBody's chargeLedger parameter.
   */
  private appendixLedger: Map<CvmInjectionSource, number> = new Map()
  /** Fired by resetAppendixBaseline so CVM accounting tracks history rewrites. */
  private onResetAppendixBaselineCb?: () => void

  constructor(config: PromptEngineConfig) {
    this.config = config
    // /cd frozen inheritance — adopt the previous engine's committed snapshot
    // state BEFORE any build, so historical slots resolve to the old bytes.
    // resume 走同一入口：盘存 FrozenSnapshotData（<id>.frozen.json）与活引擎同语义。
    const inherit = config.inheritFrozenFrom
    if (inherit instanceof PromptEngine) {
      this.frozenUserMerged = new Map([...inherit.frozenUserMerged].map(([k, v]) => [k, [...v]]))
      this.frozenPendingMerged = new Map(inherit.frozenPendingMerged)
      this.firstUserKey = inherit.firstUserKey
      this.collapseWatermark = inherit.collapseWatermark
      this.collapseTokenStep = inherit.collapseTokenStep
    } else {
      const data = inherit ? parseFrozenSnapshotData(inherit) : undefined
      if (data) {
        // 深拷贝——盘存数据可能被调用方复用/再写，不得共享引用。
        this.frozenUserMerged = new Map(data.frozenUserMerged.map(([k, v]) => [k, [...v]]))
        this.frozenPendingMerged = new Map(data.frozenPendingMerged)
        this.firstUserKey = data.firstUserKey
        this.collapseWatermark = data.collapseWatermark
        this.collapseTokenStep = data.collapseTokenStep
      }
    }
    this.approvalMode = config.approvalMode
    this.systemPrompt = buildSystemPrompt(config.staticCtx)
    this.frozenBase = buildStableVolatileBlock(config.volatileCtx)
    this.volatileBlock = this.frozenBase
    this.fingerprint = computeFingerprint(this.systemPrompt, config.staticCtx.tools, this.volatileBlock)
    this.tracker = (config.habituationThreshold ?? 5) > 0
      ? new FieldHabituationTracker({ promotionThreshold: 0.8, decayRate: 0.3 })
      : null
    this.contextLayerReportData = createContextLayerReport([
      createContextLayer({ id: 'system', label: 'Stable System Prompt', stability: 'stable', channel: 'system', fingerprint: 'included', content: this.systemPrompt }),
      createContextLayer({ id: 'tools', label: 'Tool Definitions', stability: 'stable', channel: 'tools', fingerprint: 'included', content: JSON.stringify(config.staticCtx.tools) }),
      ...(config.volatileCtx.rivetMd ? [createContextLayer({ id: 'project-instructions', label: 'Project Instructions', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', content: config.volatileCtx.rivetMd })] : []),
      ...(config.volatileCtx.gitStatus ? [createContextLayer({ id: 'git-status', label: 'Git Status', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', content: config.volatileCtx.gitStatus })] : []),
      ...(config.volatileCtx.sessionMemoryBlock ? [createContextLayer({ id: 'session-memory', label: 'Session Memory', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', content: config.volatileCtx.sessionMemoryBlock })] : []),
      ...(config.volatileCtx.playbookLessons && config.volatileCtx.playbookLessons.length > 0 ? [createContextLayer({ id: 'historical-lessons', label: 'Historical Lessons', stability: 'dynamic', channel: 'volatile-user-message', fingerprint: 'excluded', content: config.volatileCtx.playbookLessons.map(b => b.lesson).join('\n') })] : []),
      ...(config.volatileCtx.workingSet && config.volatileCtx.workingSet.length > 0 ? [createContextLayer({ id: 'working-set', label: 'Working Set', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'partial', content: config.volatileCtx.workingSet.join('\n') })] : []),
    ])
  }

  /**
   * Build a request. Volatile context is injected as an independent user message
   * prepended before each user message with string content.
   *
   * Cache-critical design for agent loop mode (1 user message → 50 tool calls):
   * - The FRESH volatile block is generated ONCE per user message, then cached.
   * - Subsequent tool-call turns reuse the cached FRESH → prefix stays stable.
   * - Only when a NEW user text message arrives does FRESH get regenerated.
   * - Historical user text messages always use FROZEN (this.volatileBlock).
   *
   * This ensures DeepSeek's exact-prefix cache hits on API calls 2-50 within
   * a single user message's execution, not just across user messages.
   */
  /** volatile trailer 的文本前缀：frozen 的 volatileBlock + habituation 稳定的
   *  consolidated 块 + 分隔线。文本消息直接与之拼接——字节布局与历史一致，
   *  前缀缓存基线不动；多模态消息把这个前缀当作独立的 text part 使用。 */
  private trailerTextPrefix(): string {
    const consolidated = this.cachedConsolidated ? '\n' + this.cachedConsolidated : ''
    return this.volatileBlock + consolidated + '\n---\n'
  }

  /**
   * trailer 合并后的 user 消息内容。
   *
   * 文本消息拼成单串（既有字节布局，缓存基线不变）。多模态消息必须保留 parts：
   * 拼字符串只能把图片丢掉或降级成一串 base64 文本——模型于是一律回答「看不到
   * 图片」（2026-09-11 用户报障）。这类消息把 volatile 前缀作为首个 text part
   * 前置、用户 parts 原样保留、附录追加为末尾 text part。
   */
  private buildTraileredUserContent(msg: OaiMessage, appendix?: string): string | OaiContentPart[] {
    const prefix = this.trailerTextPrefix()
    if (Array.isArray(msg.content)) {
      const parts: OaiContentPart[] = [{ type: 'text', text: prefix }, ...msg.content]
      if (appendix) parts.push({ type: 'text', text: appendix })
      return parts
    }
    return prefix + msg.content + (appendix ? '\n\n' + appendix : '')
  }

  /**
   * Retrieve the next frozen snapshot for a given user-message content.
   * Maintains a per-content fetch index so that duplicate messages ("继续", "ok")
   * each get their own frozen snapshot in order.
   */
  private getNextFrozen(content: string): string | undefined {
    const arr = this.frozenUserMerged.get(content)
    if (!arr || arr.length === 0) return undefined
    const idx = this.frozenFetchIndex.get(content) ?? 0
    this.frozenFetchIndex.set(content, idx + 1)
    if (idx >= arr.length) {
      // Eviction shortened this array (or dedup collapsed duplicates) — clamp
      // to the last surviving snapshot instead of returning undefined. The
      // undefined path would rebuild with the CURRENT volatileBlock, and if
      // that block has swapped since, the first user message changes from
      // byte 0 → full 0% prefix cache break (cache-log #28/#44 root cause).
      this.frozenSnapshotClamps++
      debugLog('prompt-engine', `frozen snapshot clamp: key len=${content.length} requested idx=${idx} surviving=${arr.length}`)
      return arr[arr.length - 1]
    }
    return arr[idx]
  }

  /**
   * Commit the pending merged trailer for one user-message instance. Called
   * only at a real user boundary (new user text or duplicate-instance), NOT
   * on invalidateFreshCache pseudo-boundaries mid-tool-loop.
   */
  private commitFrozenSnapshot(content: string): void {
    const pending = this.frozenPendingMerged.get(content)
    if (!pending) return
    const arr = this.frozenUserMerged.get(content)
    if (arr) {
      if (arr[arr.length - 1] !== pending) arr.push(pending)
    } else {
      this.frozenUserMerged.set(content, [pending])
    }
    // 快照固化事件——resume 缓存继承的盘存写挂在这里（见 bootstrap 的
    // wireFrozenSnapshotPersist）。hook 异常绝不影响请求构建。
    if (this.onFrozenSnapshotCommitCb) {
      try { this.onFrozenSnapshotCommitCb() } catch { /* listener must not break builds */ }
    }
  }

  /** Fired by commitFrozenSnapshot（唯一快照固化点）；由 bootstrap 接线盘存写。 */
  private onFrozenSnapshotCommitCb?: () => void

  /** 注册快照固化回调（每次 user 边界 commit 后触发，低频）。 */
  setOnFrozenSnapshotCommit(fn: () => void): void {
    this.onFrozenSnapshotCommitCb = fn
  }

  /**
   * 导出冻结前缀快照的可序列化形态（深拷贝）——随会话落盘，
   * resume 时经 inheritFrozenFrom 喂回，历史 user 消息恢复原始字节。
   */
  exportFrozenSnapshot(): FrozenSnapshotData {
    return {
      v: 1,
      frozenUserMerged: [...this.frozenUserMerged].map(([k, v]) => [k, [...v]] as [string, string[]]),
      frozenPendingMerged: [...this.frozenPendingMerged],
      firstUserKey: this.firstUserKey,
      collapseWatermark: this.collapseWatermark,
      collapseTokenStep: this.collapseTokenStep,
    }
  }

  /** 冻结锚点总数（resume 公告「继承 N 个前缀锚点」用）。 */
  getFrozenAnchorCount(): number {
    let n = 0
    for (const arr of this.frozenUserMerged.values()) n += arr.length
    return n
  }

  buildOaiRequest(inputMessages: OaiMessage[], toolHistory?: ToolHistoryEntry[], contextWindow?: number, options?: { sidePath?: boolean; onOrphanRepair?: (repairedMessages: OaiMessage[], count: number) => void; writeProbe?: WriteProbe }): OaiChatRequest {
    // Side-path builds (compaction summaries etc.) pass an unrelated message
    // array through the same engine. They must be HERMETIC: any state write
    // here (cachedFreshForUser, frozen snapshots, firstUserKey, volatile swap,
    // T7 watermark) makes the NEXT main-turn request rebuild its last user
    // message with different bytes → prefix break at that position. Found by
    // the prefix-divergence probe, 2026-07-05.
    const sidePath = options?.sidePath === true
    const result: OaiMessage[] = []
    // Reset per-call fetch index — each call re-fetches frozen entries in order.
    this.frozenFetchIndex.clear()

    // API safety net: an assistant message with tool_calls MUST be followed by a
    // tool message for every tool_call_id, or the provider rejects the request
    // ("insufficient tool messages following tool_calls"). Orphans arise when a
    // tool batch is aborted/interrupted mid-flight (partial results committed) —
    // repair by inserting synthetic tool results before the request is sent.
    // No-op (same array reference) when there are no orphans, so the happy path
    // and prefix cache are untouched.
    const preflight = runResumePreflightOai(inputMessages, sidePath ? undefined : { writeProbe: options?.writeProbe })
    const oaiMessages = preflight.messages

    // P0-orphan-loop: when repair is transient (only in the outgoing request,
    // not written back to session), the same orphans are detected every turn,
    // causing the model to see "会话中断导致工具结果丢失" on every tool call.
    // Write repaired messages back to the session so orphans are healed once.
    if (preflight.repaired && preflight.syntheticResultsInserted > 0 && !sidePath && options?.onOrphanRepair) {
      options.onOrphanRepair(oaiMessages, preflight.syntheticResultsInserted)
    }

    // Compute GWT budget for dynamic appendix (context-update sub-blocks).
    // Track 4 预算审计：旧上限 200K chars（1M 窗口 5%≈50K token）是
    // payload-diagnostic 「large payload」阈值（12K chars）的 16 倍 —
    // 每轮重建的 appendix 直接顶在 prefix cache 尾部，绝对量必须收紧。
    // 新上限 = 4×LARGE_VOLATILE_PAYLOAD_CHARS = 48K chars（~12K token，
    // 1M 下 ~1.2%）。小窗口仍按 5% 缩放（128K 窗口 → 25.6K chars，未触顶）。
    const appendixMaxChars = contextWindow && contextWindow > 0
      ? Math.min(Math.max(Math.floor(contextWindow * 0.05 * 4), 2_000), 4 * LARGE_VOLATILE_PAYLOAD_CHARS)
      : undefined

    let firstUserIdx = -1
    let lastUserIdx = -1
    for (let i = 0; i < oaiMessages.length; i++) {
      const m = oaiMessages[i]!
      // Injected <system-reminder> messages are pseudo-user messages — they
      // must NOT act as user boundaries (no volatile swap, no appendix
      // rebuild, no trailer merge). Otherwise every injection breaks the
      // prefix cache mid-task.
      if (m.role === 'user' && !isSystemReminder(m.content)) {
        if (firstUserIdx === -1) firstUserIdx = i
        lastUserIdx = i
      }
    }

    // Remember the first user message's key so eviction never deletes its
    // frozen snapshot (the byte-0 prefix anchor). Refreshed each call so it
    // tracks the post-compaction anchor when history is rewritten.
    if (!sidePath && firstUserIdx >= 0) {
      const fm = oaiMessages[firstUserIdx]!
      this.firstUserKey = typeof fm.content === 'string' ? fm.content : ''
    }

    // Commit pending trailers BEFORE the message loop — historical slots are
    // processed before lastUserIdx, so a commit inside the boundary block
    // would leave getNextFrozen empty → fallback rebuild (8396ac51 class of
    // prefix breaks).
    //
    // Pending-driven sweep (2026-07-06 orphan fix): the previous guard keyed
    // off cachedFreshForUser, which invalidateFreshCache() clears. An
    // inter-turn invalidate (setIntentRetrievalRoute fires on EVERY user
    // message via turn-step-producer) landed between the final build of turn
    // N and the first build of turn N+1 — the commit was skipped, the pending
    // snapshot orphaned forever, and every subsequent request hit the FATAL
    // fallback (cache-log: frozenEvicted on 158/160 requests, prefix
    // truncations up to 189K tokens at each user boundary). Commit is now
    // driven by frozenPendingMerged itself, which survives invalidation.
    if (!sidePath && lastUserIdx >= 0) {
      const lastUserContent = typeof oaiMessages[lastUserIdx]!.content === 'string'
        ? oaiMessages[lastUserIdx]!.content as string
        : JSON.stringify(oaiMessages[lastUserIdx]!.content)
      // 1) Pending entries whose key is no longer the active last-user message
      //    belong to a finished turn — commit unconditionally and clear.
      for (const key of [...this.frozenPendingMerged.keys()]) {
        if (key === lastUserContent) continue
        this.commitFrozenSnapshot(key)
        this.frozenPendingMerged.delete(key)
      }
      // 2) Same-text cases: a prior instance of the SAME text is now
      //    historical (duplicate "继续", or same text re-sent). Commit the
      //    pending so the historical slot can fetch its snapshot; the active
      //    instance keeps updating pending as usual.
      const hasPriorInstanceNowHistorical = this.frozenPendingMerged.has(lastUserContent)
        && oaiMessages.some((m, idx) => m.role === 'user'
          && !isSystemReminder(m.content)
          && idx !== lastUserIdx
          && (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) === lastUserContent)
      const msgHash = oaiMessages.length > 0
        ? `${oaiMessages.length}:${typeof oaiMessages[oaiMessages.length - 1]!.content === 'string' ? oaiMessages[oaiMessages.length - 1]!.content as string : ''}`
        : ''
      const isDuplicate = lastUserContent === this.cachedFreshForUser
        && oaiMessages.length === this.lastMessageCount
        && msgHash !== this.lastMessageHash
        && ((this.frozenUserMerged.get(lastUserContent)?.length ?? 0) > 0
          || this.frozenPendingMerged.has(lastUserContent))
      if (hasPriorInstanceNowHistorical || isDuplicate) {
        this.commitFrozenSnapshot(lastUserContent)
      }
    }

    for (let i = 0; i < oaiMessages.length; i++) {
      const msg = oaiMessages[i]!
      if (msg.role === 'user' && isSystemReminder(msg.content)) {
        // Pass through untouched: bare user message, byte-stable forever.
        result.push(msg)
      } else if (msg.role === 'user' && this.volatileBlock) {
        if (i === lastUserIdx && sidePath) {
          // Hermetic side-path: trailer-merge the CURRENT volatileBlock without
          // touching cachedFreshForUser / frozen snapshots / swap state. The
          // summary prompt is one-shot; caching state for it poisons the next
          // main-turn build (its real last user message would look like a new
          // boundary → appendix rebuild + volatile swap → mid-round prefix break).
          result.push({ role: 'user', content: this.buildTraileredUserContent(msg) })
        } else if (i === lastUserIdx) {
          const userContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)

          // Force rebuild for true duplicate messages — they need their own frozen entry.
          // A true duplicate: same content, same message count, but different message array
          // (the user actually sent "继续" again, not just re-calling with the same messages).
          const msgHash = oaiMessages.length > 0
            ? `${oaiMessages.length}:${typeof oaiMessages[oaiMessages.length - 1]!.content === 'string' ? oaiMessages[oaiMessages.length - 1]!.content as string : ''}`
            : ''
          const isDuplicate = userContent === this.cachedFreshForUser
            && oaiMessages.length === this.lastMessageCount
            && msgHash !== this.lastMessageHash
            && ((this.frozenUserMerged.get(typeof userContent === 'string' ? userContent : '')?.length ?? 0) > 0
              || this.frozenPendingMerged.has(this.cachedFreshForUser))
          this.lastMessageCount = oaiMessages.length
          this.lastMessageHash = msgHash
          if (userContent !== this.cachedFreshForUser || isDuplicate) {
            // New user message boundary — apply any pending frozen base update.
            // rebuildFrozenBase() defers the volatileBlock swap to this point
            // so that tool-call turns within the same user message keep using
            // the old stable volatileBlock → exact-prefix cache preserved.
            if (this.frozenBase !== this.volatileBlock) {
              this.volatileBlock = this.frozenBase
              this.volatileSwapCount++
              // Old frozen entries embed old volatileBlock, which byte-matches
              // previous API calls — clearing them would force fallback with
              // newVolatileBlock and cause full prefix cache break. Keep them:
              // historical messages hit cache; only new user message misses.
            }
            this.cachedFreshForUser = userContent
            this.userMessagesSinceGitRefresh++
            const refreshGit = this.gitDirty || this.userMessagesSinceGitRefresh >= 3
            if (refreshGit) {
              this.gitDirty = false
              this.userMessagesSinceGitRefresh = 0
            }
            const dynamicCtx: VolatileContext = { ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, toolContext: this.toolContext, planCacheAdvisory: this.planCacheAdvisory, planTraceAppendix: this.planTraceAppendix, activePlanPointer: this.activePlanPointer, intentRetrievalRoute: this.intentRetrievalRoute, taskDepthAdvisory: this.taskDepthAdvisory, planMethodologyAdvisory: this.planMethodologyAdvisory, planExecutingBlock: this.planExecutingBlock, skillAdvisoryBlock: this.skillAdvisoryBlock ?? undefined, invokedSkillsBlock: skillRegistry.renderInvokedSkillsBlock([...this.invokedSkillNames], this.config.volatileCtx.cwd) ?? undefined, crossSessionMemoryBlock: this.crossSessionMemoryBlock ?? undefined, mentionContextBlock: this.mentionContextBlock ?? undefined, harnessAdvisoryBlock: this.harnessAdvisoryBlock, controlPlaneBlock: this.controlPlaneBlock, tersenessEscalate: this.tersenessEscalate, decisions: this.decisions, activeClaims: this.activeClaims, excludedPathAnchors: this.excludedPathAnchors.length > 0 ? this.excludedPathAnchors : undefined, goalAnchor: this.goalAnchor, playbookLessons: this.playbookLessons, onLessonsRendered: this.onLessonsRendered, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock, crossSessionEvents: this.crossSessionEvents, companionPresence: this.companionPresence, sessionState: this.sessionStateText, worktreeReality: this.worktreeReality, planModeState: this.planModeState, askModeState: this.askModeState, approvalMode: this.approvalMode, activePlanFilePath: this.activePlanFilePath, planExitReminderPending: this.planExitReminderPending, cognitiveProjection: this.cognitiveProjection, ...(refreshGit ? { gitStatus: undefined } : {}) } as VolatileContext
            // One-shot: the plan-mode exit reminder is snapshotted into dynamicCtx
            // above; clear it so it renders on this turn only, not every subsequent turn.
            if (this.planExitReminderPending) this.planExitReminderPending = false

            if (this.tracker) {
              // activeDomain is no longer habituation-tracked — it is a session
              // constant folded into the frozen prefix (volatile.ts, frozen 末尾)
              // via setActiveDomain → rebuildFrozenBase. Only playbookLessons still
              // warms up through habituation into the <consolidated> block.
              const fieldValues: Record<string, string> = {}
              if (dynamicCtx.playbookLessons && dynamicCtx.playbookLessons.length > 0) {
                fieldValues['playbookLessons'] = dynamicCtx.playbookLessons.map(b => b.lesson).join('|')
              }
              this.tracker.recordTurn(fieldValues, this.phaseHint)

              const habituatedContent = this.tracker.getHabituatedContent()
              const renderedHabituated = new Map<string, string>()
              for (const [name, content] of habituatedContent) {
                if (name === 'playbookLessons') {
                  renderedHabituated.set(name, `<historical-lessons>\n${content.split('|').map((l: string) => `- ${l}`).join('\n')}\n</historical-lessons>`)
                }
              }

              // NOTE: with activeDomain removed from tracking, consolidatedBlock is
              // empty until playbookLessons promotes (observable: consolidated length
              // drops to 0 early-session — expected, not a regression).
              const newConsolidated = buildConsolidatedBlock(renderedHabituated)
              if (newConsolidated !== this.consolidatedBlock) {
                this.consolidatedBlock = newConsolidated
                // consolidatedBlock is placed BEFORE userContent (adjacent to volatileBlock)
                // so its stable bytes enter the exact-prefix cache. Mutating volatileBlock
                // would break the cache for all subsequent turns (5-20% hit rate drop).
              }

              const activeCtx = { ...dynamicCtx }
              const habituated = this.tracker.getHabituated()
              if (habituated.has('playbookLessons')) activeCtx.playbookLessons = undefined

              const activeAppendix = this.actionableTurn ? this.buildAppendixBody(activeCtx, appendixMaxChars, !sidePath) : ''
              this.cachedConsolidated = this.consolidatedBlock
              this.cachedAppendix = this.withEphemeralProjection(activeAppendix, !sidePath)
            } else {
              if (this.actionableTurn) {
                const appendix = this.buildAppendixBody(dynamicCtx, appendixMaxChars, !sidePath)
                this.cachedConsolidated = this.consolidatedBlock
                this.cachedAppendix = this.withEphemeralProjection(appendix, !sidePath)
              } else {
                this.cachedConsolidated = ''
                this.cachedAppendix = ''
              }
            }
          }
          // Trailer mode: merge volatileBlock (FROZEN) into last user message.
          // consolidatedBlock (habituation-tracked stable blocks) is placed
          // BEFORE userContent so it enters the prefix cache alongside volatileBlock.
          // Dynamic appendix (per-turn volatile) is appended AFTER userContent.
          // Frozen snapshot captures the full content (including appendix),
          // so historical retrieval returns byte-identical content → cache hit.
          const trailered = this.buildTraileredUserContent(msg, this.cachedAppendix || undefined)
          // Track latest merged bytes for this last-user message; commit once at
          // the next real user boundary (not per tool turn / pseudo-boundary).
          // 多模态消息（parts 数组）不入 frozen 快照——快照只存字符串形态；parts 是
          // 稳定输入，重建字节不变，前缀缓存照常命中。
          if (typeof msg.content === 'string') {
            this.frozenPendingMerged.set(msg.content, trailered as string)
          }
          result.push({ role: 'user', content: trailered })
        } else if (i === firstUserIdx) {
          // Use frozen merged content if available (preserves prefix from when this was lastUserIdx)
          const frozen = this.getNextFrozen(typeof msg.content === 'string' ? msg.content : '')
          if (frozen) {
            result.push({ role: 'user', content: frozen })
          } else {
            // Fallback: trailer-merge volatileBlock to keep message count stable.
            // A 2-message fallback here would shift all subsequent indices and
            // break exact-prefix cache for the entire suffix.
            // This path only fires when the key's snapshot array was fully
            // evicted — if volatileBlock has swapped since, the FIRST user
            // message changes from byte 0 → fatal 0% prefix break. Log it.
            this.frozenFallbackRebuilds++
            debugLog('prompt-engine', `FATAL-CACHE: frozen snapshots fully evicted for FIRST user message (len=${typeof msg.content === 'string' ? msg.content.length : 0}) — rebuilding with current volatileBlock`)
            const rebuilt = this.buildTraileredUserContent(msg)
            // Memoize (self-heal): without this, every subsequent request
            // re-runs the fallback with live volatile bytes — flip-flopping
            // message bytes and paying cacheCreate tax on each request.
            // 多模态消息不入快照（快照只存字符串形态）——parts 稳定，重建字节一致。
            if (!sidePath && typeof msg.content === 'string' && msg.content !== '') {
              this.frozenUserMerged.set(msg.content, [rebuilt as string])
            }
            result.push({ role: 'user', content: rebuilt })
          }
        } else {
          // Historical user message: use frozen merged content if available
          // to preserve prefix stability (avoids content change when msg loses "last" status)
          const frozen = this.getNextFrozen(typeof msg.content === 'string' ? msg.content : '')
          if (frozen) {
            result.push({ role: 'user', content: frozen })
          } else {
            // Fallback: inject volatileBlock so the message still carries context.
            // Loses dynamic appendix vs frozen snapshot, causing one cache miss but
            // doesn't cascade (message count unchanged).
            this.frozenFallbackRebuilds++
            debugLog('prompt-engine', `frozen snapshots fully evicted for historical user message (len=${typeof msg.content === 'string' ? msg.content.length : 0}) — rebuilding with current volatileBlock`)
            const rebuilt = this.buildTraileredUserContent(msg)
            // Memoize (self-heal) — same rationale as the first-user fallback.
            // 多模态消息不入快照（快照只存字符串形态）——parts 稳定，重建字节一致。
            if (!sidePath && typeof msg.content === 'string' && msg.content !== '') {
              this.frozenUserMerged.set(msg.content, [rebuilt as string])
            }
            result.push({ role: 'user', content: rebuilt })
          }
        }
      } else {
        result.push(msg)
      }
    }

    const tools: OaiToolDefinition[] | undefined = this.config.staticCtx.tools.length > 0
      ? this.config.staticCtx.tools.map(tool => {
        const func: OaiToolDefinition['function'] = {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        }
        if (tool.providerFormat) {
          func.providerFormat = tool.providerFormat
        }
        return { type: 'function' as const, function: func }
      })
      : undefined

    // On 1M+ windows, skip pruning entirely — same rationale as observation masking:
    // mutating message content breaks DeepSeek exact-prefix cache. trySessionSplit (86%)
    // handles context overflow instead.
    if (!contextWindow || contextWindow < 1_000_000) {
      const { messages: prunedMessages, prunedCount, savedChars } = pruneOutdatedQueryResults(result, CACHE_ANCHOR_MESSAGES)
      if (prunedCount > 0) {
        debugLog(`[semantic-prune] pruned ${prunedCount} results, saved ${savedChars} chars`)
        result.length = 0
        result.push(...prunedMessages)
      }

      const { messages: stalenessPruned } = detectStaleness(result, CACHE_ANCHOR_MESSAGES, {
        suffixTokenLimit: 8_000, // only mutate cheap-to-recache tail
      })
      if (stalenessPruned !== result) {
        for (let i = 0; i < result.length; i++) result[i] = stalenessPruned[i]!
      }
    }

    // Observation masking: replace tool result content older than 10 user turns
    // with compact placeholder. On 1M+ context windows, skip masking entirely —
    // the 1M window has enough headroom, and masking mutates message content
    // which breaks exact prefix cache. trySessionSplit (86%) is the primary
    // defense against context overflow on 1M windows.
    const MASK_WINDOW = 10
    if (!contextWindow || contextWindow < 1_000_000) {
      let userCount = 0
      const userTurnIndices: number[] = []
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i]!.role === 'user') {
          userCount++
          userTurnIndices.push(i)
        }
      }
      if (userCount > MASK_WINDOW) {
        const cutoff = userTurnIndices[MASK_WINDOW - 1]!
        for (let i = 0; i < cutoff; i++) {
          const msg = result[i]!
          if (msg.role === 'tool' && msg.content.length > 200) {
            const preview = msg.content.slice(0, 100)
            result[i] = { ...msg, content: `[observation masked, ${msg.content.length} chars]\n${preview}…` }
          }
        }
      }
    }

    // File content dedup + disk budget: skip on 1M+ windows — mutating historical
    // tool results breaks DeepSeek exact-prefix cache (same rationale as pruning/masking).
    if (!contextWindow || contextWindow < 1_000_000) {
      const seenContent = new Map<string, number>()
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]!
        if (msg.role === 'tool' && msg.content.length > 500 && !msg.content.startsWith('[observation masked')) {
          const hash = simpleHash(msg.content)
          if (!seenContent.has(hash)) {
            seenContent.set(hash, i)
          } else {
            result[i] = { ...msg, content: `[duplicate content, see later tool result]` }
          }
        }
      }

      const DISK_BUDGET_CHARS = 50_000
      const PREVIEW_CHARS = 2000
      for (let i = 0; i < result.length; i++) {
        const msg = result[i]!
        if (msg.role === 'tool' && msg.content.length > DISK_BUDGET_CHARS) {
          const preview = msg.content.slice(0, PREVIEW_CHARS)
          result[i] = { ...msg, content: `${preview}\n\n[output truncated: ${msg.content.length} chars total, showing first ${PREVIEW_CHARS}]` }
        }
      }
    }

    // Evict oldest frozen entries when total count exceeds limit.
    // Each content key stores an array of snapshots (for duplicate messages).
    // Total count = sum of all array lengths. Evict by removing oldest entries
    // from the longest arrays first.
    let totalFrozen = 0
    for (const arr of this.frozenUserMerged.values()) totalFrozen += arr.length
    while (totalFrozen > PromptEngine.MAX_FROZEN_USER_MERGED && this.frozenUserMerged.size > 0) {
      let maxKey = '', maxLen = 0
      for (const [k, arr] of this.frozenUserMerged) {
        // Never evict the first user message's snapshot — it's the byte-0
        // prefix anchor; losing it forces a full 0% cache rebuild.
        if (k === this.firstUserKey) continue
        if (arr.length > maxLen) { maxKey = k; maxLen = arr.length }
      }
      // Only the protected first-user key remains — stop rather than break it.
      if (maxLen === 0) break
      if (maxLen <= 1) {
        this.frozenUserMerged.delete(maxKey)
      } else {
        this.frozenUserMerged.get(maxKey)!.shift()
      }
      totalFrozen--
    }

    // T7: Cache-Safe Context Collapse for 1M+ windows.
    // Operates on the request copy only — session messages remain intact
    // so DeepSeek exact-prefix cache is preserved up to the collapse point.
    // Gated at 50% window usage, with a watermark boundary that only advances
    // when crossing a 50K-token step — so the break happens once per step,
    // not on every turn (rolling break would defeat the prefix cache).
    if (contextWindow && contextWindow >= 200_000 && !sidePath) {
      const collapseAge = this.config.attentionProfile?.collapseAgeTurns ?? 8
      // Use the same CJK-aware accounting as the session layer
      // (estimateOaiMessageTokens: cjk/1.2, ascii/4, plus tool_calls and the
      // reasoning_content echoed back on tool-call turns). The old hand-rolled
      // `chars/4` undercounted CJK text by ~3.3× and ignored tool_calls, so on
      // CJK-heavy sessions the T7 gate fired far later than maybeCompact's
      // ratio — leaving the two subsystems' compaction decisions uncoordinated.
      const estTokens = estimateOaiTokens(result)
      const fillRatio = estTokens / contextWindow

      // Lightweight pass (0–85%): strip reasoning + fold duplicate grep/read.
      // Full pass (>85%): also collapse old tool results via semantic summaries.
      //
      // The full pass rewrites old tool results into summaries. On exact-prefix
      // providers (DeepSeek) that rewrite invalidates the whole prefix after the
      // touched message — one full pass costs a real cache-miss rebuild of the
      // collapsed region (observed: 240K tokens at 3元/M ≈ 0.71元 on a single
      // request, ~27% of a session's total spend). estTokens here is a char/4
      // estimate that *includes* echoed reasoning_content, so it runs well ahead
      // of the real billed prompt. Triggering the full pass at 0.5 fired while
      // the real prompt was only ~27% of the window — paying the cache break for
      // headroom that was never needed. FULL_COLLAPSE_FILL_RATIO defers the full
      // pass until the window is genuinely near-full (when avoiding overflow is
      // worth more than cache protection); the lightweight pass still runs the
      // whole time. Tunable: lower it to collapse more aggressively, raise it to
      // protect cache longer.
      if (fillRatio >= COLLAPSE_FLOOR_FILL_RATIO) {
        // History rewrite (compact / session split) invalidates stored indices.
        if (this.collapseWatermark > result.length) {
          this.collapseWatermark = 0
          this.collapseTokenStep = -1
        }
        const step = Math.floor(estTokens / 50_000)
        if (step > this.collapseTokenStep) {
          this.collapseTokenStep = step
          this.collapseWatermark = computeCollapseBoundary(result, collapseAge)
          debugLog('prompt-engine', `T7 watermark advanced: step=${step} boundary=${this.collapseWatermark} estTokens=${estTokens}`)
        }
        if (this.collapseWatermark > 0) {
          requestTimeCollapse(result, this.collapseWatermark, contextWindow, fillRatio < FULL_COLLAPSE_FILL_RATIO)
        }
      }
    }

    const request: OaiChatRequest = {
      model: this.config.model,
      messages: [{ role: 'system', content: this.systemPrompt }, ...result],
      max_tokens: this.config.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      tools,
      tool_choice: tools ? 'auto' : undefined,
      // Main-turn marker for the client's wire-level probe — the client only
      // fingerprints final send bytes for these requests (side-path calls
      // through the same client would poison its baseline too).
      prefixProbe: !sidePath || undefined,
    }
    // Side-path builds (compaction summaries etc.) have unrelated message
    // arrays — recording them would poison the main-turn baseline and report
    // phantom divergences.
    if (!sidePath) this.recordPrefixDivergence(request.messages)
    return request
  }

  /**
   * Prefix-divergence probe: compare this request's per-message signatures with
   * the previous request's. An exact-prefix provider only re-matches the shared
   * prefix, so any non-append change (message content mutated, message removed,
   * count shrank) is a real client-side cache break. Records the FIRST diverged
   * index; pure appends record nothing.
   */
  private recordPrefixDivergence(messages: OaiMessage[]): void {
    const sigs = messages.map(messageSignature)
    const prev = this.prevRequestSignatures
    this.prevRequestSignatures = sigs
    if (!prev) return

    const shared = Math.min(prev.length, sigs.length)
    let divergedIdx = -1
    for (let i = 0; i < shared; i++) {
      if (prev[i]!.sig !== sigs[i]!.sig) { divergedIdx = i; break }
    }
    if (divergedIdx === -1) {
      if (sigs.length >= prev.length) return // pure append (or identical) — prefix intact
      // History shrank with an intact shared prefix — a rewrite (compact/split).
      divergedIdx = sigs.length
    }
    let approxCharPos = 0
    for (let i = 0; i < divergedIdx; i++) approxCharPos += sigs[i]?.len ?? prev[i]!.len
    this.lastPrefixDivergence = {
      idx: divergedIdx,
      role: messages[divergedIdx]?.role ?? 'removed',
      kind: divergedIdx >= sigs.length ? 'message_removed' : 'message_changed',
      prevCount: prev.length,
      newCount: sigs.length,
      approxCharPos,
    }
  }

  /** Consume-once accessor for the latest prefix divergence (cache-log breadcrumb). */
  consumePrefixDivergence(): PrefixDivergence | null {
    const d = this.lastPrefixDivergence
    this.lastPrefixDivergence = null
    return d
  }

  getModel(): string {
    return this.config.model
  }

  getFingerprint(): PrefixFingerprint {
    return this.fingerprint
  }

  checkDrift(): DriftEvent | null {
    const current = computeFingerprint(this.systemPrompt, this.config.staticCtx.tools, this.volatileBlock)
    return detectDrift(this.fingerprint, current)
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  updateTools(tools: ToolDefinition[]): void {
    // 字节级幂等守卫（2026-09-06 缓存碎裂根修 P2）：MCP 重连/插件重复注册/
    // applyFace 重挂会以同一份工具定义反复重进这里——字节不变时跳过替换与
    // 计数，fingerprint 与请求字节完全不动（此前每次调用都 bump
    // toolsUpdateCount 并重算指纹，同名工具重注册也会把前缀打碎）。
    // 上线字节按数组序序列化（buildOaiRequest 的 .map 保序），比较必须同序——
    // 纯重排也视为变化（保守，与旧行为一致地重建）。
    if (stableStringify(tools) === stableStringify(this.config.staticCtx.tools)) return
    this.config.staticCtx.tools = tools
    this.fingerprint = computeFingerprint(this.systemPrompt, tools, this.volatileBlock)
    this.toolsUpdateCount++
  }

  /** Number of tool definitions (for prefix overhead estimation). */
  getToolCount(): number {
    return this.config.staticCtx.tools.length
  }

  /**
   * 当前 frozen 前缀的分块构成（`/prefix-budget` 与 scripts/prefix-budget.ts 共用口径）。
   *
   * 读的是这个引擎实际持有的字节，不重新加载磁盘——脚本量的是「新会话会是什么样」，
   * 这里量的是「本会话现在是什么样」。两者在会话中途切过 /domain 或 /cd 后会不同。
   */
  getPrefixBudgetInputs(): BudgetInput[] {
    const ctx = this.config.volatileCtx
    const caps = { ...FROZEN_BLOCK_CAPS, ...ctx.blockCaps }
    return [
      { name: 'static.ts BASE_PROMPT', category: 'brake', content: this.systemPrompt },
      { name: 'star-domain volatileBlock', category: 'brake', content: ctx.activeDomain?.volatileBlock },
      { name: '工具 schema (JSON)', category: 'tools', content: JSON.stringify(this.config.staticCtx.tools) },
      // 与渲染层同一套按节选取——`slice(0, cap)` 会把报告写成「按前 N 字符收录」，
      // 而实际收录的是另一组章节，归因数字对不上真实前缀。
      { name: 'project-instructions', category: 'reference', content: ctx.rivetMd ? selectProjectInstructions(ctx.rivetMd, caps.projectInstructions).text : undefined, cap: caps.projectInstructions, rawChars: ctx.rivetMd?.length },
      { name: 'project-memory', category: 'reference', content: ctx.projectMemoryBlock?.slice(0, caps.projectMemory), cap: caps.projectMemory, rawChars: ctx.projectMemoryBlock?.length },
      { name: 'knowledge-manifest', category: 'reference', content: ctx.knowledgeManifestBlock?.slice(0, caps.knowledgeManifest), cap: caps.knowledgeManifest, rawChars: ctx.knowledgeManifestBlock?.length },
      { name: 'codebase-index', category: 'reference', content: ctx.projectIndexBlock?.slice(0, caps.codebaseIndex), cap: caps.codebaseIndex, rawChars: ctx.projectIndexBlock?.length },
      { name: 'seed-capsule 索引', category: 'reference', content: ctx.seedCapsuleBlock },
      { name: 'session-memory', category: 'reference', content: ctx.sessionMemoryBlock },
      { name: 'appendix（每轮动态）', category: 'appendix', content: this.cachedAppendix },
    ]
  }

  /** Current cognitive projection length in chars (for cache-log observability). */
  getCognitiveProjectionLength(): number {
    return this.cognitiveProjection?.length ?? 0
  }

  /** Current cached appendix length in chars (for cache-log observability). */
  getCachedAppendixLength(): number {
    return this.cachedAppendix?.length ?? 0
  }

  /**
   * The appendix text as actually rendered this request. Nothing downstream of here
   * persists it — the session JSONL keeps what the user typed, not what was injected
   * alongside it — so without this accessor there is no way to answer "what did the
   * model actually see" after the fact. Read by the (gated) appendix trace recorder.
   */
  getCachedAppendix(): string | undefined {
    return this.cachedAppendix
  }
  updateSessionMemory(block: string): void {
    this.sessionMemoryOverride = block
    this.rebuildFrozenBase()
    this.invalidateFreshCache()
  }

  private rebuildFrozenBase(): void {
    const ctx = {
      ...this.config.volatileCtx,
      sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock,
      // activeDomain folded into the frozen prefix (session constant). The ?? is
      // explicit defense mirroring the appendix getter below: it allows a future
      // volatileCtx-preset domain to survive a reset. Today config.volatileCtx
      // .activeDomain is always undefined, so resetSessionDomain (this.activeDomain
      // = undefined) correctly drops the domain from the frozen prefix.
      activeDomain: this.activeDomain ?? this.config.volatileCtx.activeDomain,
    }
    this.frozenBase = buildStableVolatileBlock(ctx)
    // Rebuilding the frozen prefix is an intentional redefinition of the cache
    // baseline (domain fold / session-memory update). Update the drift fingerprint
    // accordingly — same contract as updateTools — so checkDrift() compares against
    // the new intended prefix once the deferred volatileBlock swap lands, rather
    // than flagging the deliberate change as drift.
    this.fingerprint = computeFingerprint(this.systemPrompt, this.config.staticCtx.tools, this.frozenBase)
    // P1: Do NOT update volatileBlock or clear frozenUserMerged here.
    // Changing volatileBlock mid-tool-loop mutates the merged user message
    // content from byte 0 and breaks DeepSeek exact-prefix cache entirely
    // (hit rate drops from 99%+ to ~16%). The frozenBase→volatileBlock swap
    // is deferred to the next user-message boundary in buildOaiRequest(),
    // which naturally triggers a full fresh rebuild — cache break at that
    // point is unavoidable and acceptable.
    //
    // frozenUserMerged entries embed old volatileBlock format. They stay
    // valid as long as volatileBlock hasn't changed. When volatileBlock
    // eventually swaps, frozenUserMerged is cleared at that boundary.
  }

  setActionableTurn(actionable: boolean): void {
    if (this.actionableTurn === actionable) return
    this.actionableTurn = actionable
    this.invalidateFreshCache()
  }

  /** @deprecated Use isActionableTurn from task-contract for auto-detection. */
  getMode(): 'task' {
    return 'task'
  }

  updateActiveClaims(claims: ContextClaim[]): void {
    this.activeClaims = claims
  }

  /** spec 3c 动作 B：追加排除路径锚点。去重（保首见序）+ cap 溢出淘汰最旧——
   *  字节只在语义变化（新锚点/挤出）时变化，appendixDelta 可吸收。 */
  appendExcludedPathAnchors(anchors: string[]): void {
    const MAX_ANCHORS = 20
    for (const a of anchors) {
      if (!this.excludedPathAnchors.includes(a)) this.excludedPathAnchors.push(a)
    }
    if (this.excludedPathAnchors.length > MAX_ANCHORS) {
      this.excludedPathAnchors = this.excludedPathAnchors.slice(-MAX_ANCHORS)
    }
  }

  /** spec 3c 动作 B 补强：设置会话当前目标（覆盖语义——目标只有一个）。
   *  与 appendExcludedPathAnchors 的追加语义不同：目标切换 = 整段替换，
   *  字节只在目标实际变化时变（goalChanged 判定由调用方负责）。 */
  setGoalAnchor(goal: string | null): void {
    this.goalAnchor = goal
  }

  /** 已收集锚点数（loop 惰性重建判空用）。 */
  getExcludedPathAnchorCount(): number {
    return this.excludedPathAnchors.length
  }

  updatePlaybookLessons(lessons: PlaybookBullet[]): void {
    this.playbookLessons = lessons
  }

  setOnLessonsRendered(cb: (ids: string[]) => void): void {
    this.onLessonsRendered = cb
  }

  setTaskProgress(state: TaskState): void {
    this.taskProgress = state
  }

  setRepairHint(hint: string | null): void {
    this.repairHint = hint
  }



  setToolContext(ctx: string | null): void {
    this.toolContext = ctx ?? undefined
  }

  getToolContextLength(): number {
    return this.toolContext?.length ?? 0
  }

  setPlanCacheAdvisory(advisory: string | null): void {
    this.planCacheAdvisory = advisory ?? undefined
  }

  /** U6: set serialized PlanExecutionTrace appendix (rendered in dynamic appendix, survives compaction). */
  setPlanTraceAppendix(appendix: string | null): void {
    this.planTraceAppendix = appendix ?? undefined
  }

  /**
   * Set the approved-plan pointer (slug/title/path block). Rendered ONLY into
   * the dynamic appendix — does NOT rebuild the frozen base or invalidate the
   * fresh cache, so approving/revising a plan never shatters the prefix cache.
   * Mirrors setPlanModeState / setWorktreeReality: the pointer refreshes at the
   * next user-message boundary (which rebuilds the appendix anyway).
   */
  setActivePlan(pointer: string | null): void {
    this.activePlanPointer = pointer ?? undefined
  }

  /** Return the currently approved-plan pointer (slug/title/path block), if any. */
  getActivePlanPointer(): string | undefined {
    return this.activePlanPointer
  }

  setIntentRetrievalRoute(route: string | null): void {
    this.intentRetrievalRoute = route ?? undefined
    this.invalidateFreshCache()
  }

  setTaskDepthLayer(layer: import('../context/task-contract.js').TaskDepthLayer | undefined): void {
    const changed = this.taskDepthLayer !== layer
    this.taskDepthLayer = layer
    // Only inject the advisory when task depth changes or is first set.
    // Repeated identical advisory every user message is pure noise.
    this.taskDepthAdvisory = changed
      ? renderTaskDepthAdvisory(layer)
      : null
  }

  setPlanMethodology(
    methodology: import('../context/task-contract.js').PlanMethodology | undefined,
    reason?: string,
    opts?: { planMode?: boolean },
  ): void {
    const changed = this.planMethodology !== methodology
      || this.planMethodologyPlanMode !== !!opts?.planMode
    this.planMethodology = methodology
    this.planMethodologyReason = reason
    this.planMethodologyPlanMode = !!opts?.planMode
    // Only inject the advisory when methodology changes or is first set.
    // Repeated identical advisory every turn is pure noise (~60 tokens/turn).
    this.planMethodologyAdvisory = changed
      ? renderPlanMethodologyAdvisory(methodology, reason, opts)
      : null
  }

  setPlanExecutingBlock(block: string | null): void {
    this.planExecutingBlock = block
  }

  getPlanExecutingBlock(): string | null {
    return this.planExecutingBlock
  }

  getPlanMethodology(): import('../context/task-contract.js').PlanMethodology | undefined {
    return this.planMethodology
  }

  setSkillAdvisoryBlock(block: string | null): void {
    this.skillAdvisoryBlock = block
  }

  markSkillInvoked(name: string): void {
    this.invokedSkillNames.add(name)
  }

  markSkillCompleted(name: string): void {
    // Resolve case-insensitively then remove the canonical name.
    const canonical = skillRegistry.get(name)?.name
      ?? [...this.invokedSkillNames].find(n => n.toLowerCase() === name.toLowerCase())
      ?? name
    this.invokedSkillNames.delete(canonical)
  }

  getInvokedSkillNames(): string[] {
    return [...this.invokedSkillNames]
  }

  setCrossSessionMemoryBlock(block: string | null): void {
    this.crossSessionMemoryBlock = block
  }

  setMentionContextBlock(block: string | null): void {
    this.mentionContextBlock = block
  }

  getTaskDepthLayer(): import('../context/task-contract.js').TaskDepthLayer | undefined {
    return this.taskDepthLayer
  }

  /** Wave 4 控制面 appendix — 仅 active 模式由 turn-step-producer 调用。
   *  只影响 dynamic appendix（buildStableVolatileBlock 已剥离），不进 frozen、
   *  不改写历史消息。 */
  setControlPlaneAppendix(block: string | null): void {
    this.controlPlaneBlock = block ?? undefined
  }

  setHarnessAdvisoryBlock(block: string | null): void {
    this.harnessAdvisoryBlock = block ?? undefined
  }

  /**
   * When true, the next dynamic appendix render enables the terseness nudge in
   * escalate mode (doom-loop / storm). Cache-safe: dynamic appendix only.
   */
  setTersenessEscalate(escalate: boolean): void {
    this.tersenessEscalate = escalate
  }

  setDecisions(decisions: string[]): void {
    this.decisions = decisions
  }

  setCrossSessionEvents(events: string | null): void {
    this.crossSessionEvents = events ?? undefined
  }

  setCompanionPresence(block: string | null): void {
    this.companionPresence = block ?? undefined
  }

  /**
   * Update session-state snapshot. Byte-stable: only stores when the content
   * actually differs from the previously stored snapshot. This means within an
   * auto-continuation run where nothing changed (model only read files), the
   * appendix stays identical → DeepSeek prefix cache preserved. When files are
   * modified or task step advances, the state updates and the model sees it.
   * See: prompt/volatile.ts VolatileContext.sessionState comment.
   */
  setSessionState(text: string | null): void {
    const next = text ?? undefined
    if (next === this.sessionStateText) return // byte-identical — no churn
    this.sessionStateText = next
  }

  /**
   * Update worktree reality check result. Does NOT invalidate the fresh cache:
   * rendered ONLY into the dynamic appendix when severity !== 'green'.
   * This is required to preserve DeepSeek prefix cache across tool turns.
   */
  setWorktreeReality(reality: WorktreeReality | null): void {
    this.worktreeReality = reality ?? undefined
  }

  /** Update plan-mode state — rendered into volatile block to instruct agent */
  setPlanModeState(state: 'off' | 'planning' | 'approved' | undefined): void {
    this.planModeState = state
  }

  /** Update ask-mode state — rendered into volatile appendix (never frozen). */
  setAskModeState(state: 'off' | 'asking' | undefined): void {
    this.askModeState = state
  }

  /** Update the approval mode — rendered into the dynamic appendix as a
   *  permission note when unattended (never frozen). */
  setApprovalMode(mode: string | undefined): void {
    this.approvalMode = mode
  }

  /** Active plan file path for incremental plan writing in plan mode. */
  setActivePlanFilePath(path: string | null): void {
    this.activePlanFilePath = path
  }

  /** Arm/disarm the one-shot plan-mode exit reminder. */
  setPlanExitReminderPending(pending: boolean): void {
    this.planExitReminderPending = pending
  }

  setPhaseHint(hint: string): void {
    this.phaseHint = hint
  }

  getPhaseHint(): string | undefined {
    return this.phaseHint
  }

  /**
   * Update cognitive projection. Does NOT invalidate the fresh cache:
   * within the same user message, all tool-call turns reuse the cached fresh
   * volatile block — projection refreshes only at user-message boundaries.
   * This preserves DeepSeek prefix cache across tool turns (~10% hit rate gain).
   */
  setCognitiveProjection(projection: string | null, ephemeral?: string | null): void {
    this.cognitiveProjection = projection && projection.trim().length > 0 ? projection : undefined
    // Ephemeral one-shot hints (sycophancy / yaoguang / immune) are stored
    // separately and emitted OUTSIDE the appendixDelta context-update, so a
    // hint shown once never persists via the cumulative "absent = reuse last"
    // protocol. Only the state-derived stable projection participates in delta.
    this.cognitiveEphemeral = ephemeral && ephemeral.trim().length > 0 ? ephemeral : undefined
  }

  /** Prepend per-turn ephemeral cognitive hints OUTSIDE the delta context-update.
   *  cachedAppendix is frozen across a user message's tool turns, so this stays
   *  stable within a turn sequence and only refreshes at the next user boundary.
   *  These bytes ship in full every boundary (no delta), so they book in full. */
  private withEphemeralProjection(appendix: string, chargeLedger: boolean): string {
    if (!this.cognitiveEphemeral) return appendix
    if (chargeLedger) this.chargeAppendixLedger('ephemeral', this.cognitiveEphemeral.length)
    return appendix ? `${this.cognitiveEphemeral}\n${appendix}` : this.cognitiveEphemeral
  }

  private invalidateFreshCache(): void {
    // P1 diagnostic: log caller when fresh cache is cleared mid-tool-loop.
    // cachedFreshForUser should only be emptied at user-message boundaries.
    // If cleared between tool-call turns, the appendix changes → prefix
    // cache breaks → hit rate drops from 99%+ to ~16%.
    if (this.cachedFreshForUser !== '') {
      const err = new Error('invalidateFreshCache')
      debugLog(`[fresh-cache] CLEARED cachedFreshForUser="${this.cachedFreshForUser.slice(0, 80)}..." by: ${err.stack?.split('\n').slice(2, 5).join(' → ') ?? 'unknown'}`)
    }
    // NOTE (2026-07-06 orphan fix): do NOT commit the pending trailer here.
    // An intra-turn invalidate is followed by a boundary rebuild that produces
    // the message's FINAL wire bytes — committing the intermediate version
    // would leave a stale extra snapshot and historical retrieval (index 0)
    // would stop byte-matching the last request. The pending entry survives in
    // frozenPendingMerged; buildOaiRequest's pending sweep commits it at the
    // next main-path build regardless of cachedFreshForUser.
    this.cachedFreshForUser = ''
    this.cachedAppendix = ''
    this.cachedConsolidated = ''
    // Delta baseline reset: force next context-update to be a full baseline.
    this.lastEmittedAppendixParts = new Map()
    this.appendixBaselineSent = false
  }

  /**
   * Build the <context-update> body — full when delta off or baseline not yet
   * sent, otherwise only changed sub-blocks. Mutates lastEmittedAppendixParts.
   *
   * Delta logic: compare current parts against last emitted. On new user
   * boundary, emit full baseline (seq=1). Subsequent boundaries emit only
   * changed sub-blocks (mode="delta"), or self-closing tag if nothing changed.
   * Tool-call turns reuse cachedAppendix (never calling this method).
   *
   * `chargeLedger` must be false for hermetic side-path builds: their appendix
   * bytes never reach the main history, so booking them would re-introduce the
   * overcounting this metering exists to avoid.
   */
  private buildAppendixBody(ctx: VolatileContext, maxChars: number | undefined, chargeLedger: boolean): string {
    const parts = buildDynamicAppendixParts(ctx, maxChars)
    if (!this.config.appendixDelta) {
      if (parts.length === 0) return ''
      this.chargeAppendixParts(parts, chargeLedger)
      return `<context-update>\n${parts.map(p => p.content).join('\n\n')}\n</context-update>`
    }
    this.appendixSeq++
    const current = new Map<string, string>()
    const changed: AppendixPart[] = []
    for (const p of parts) {
      current.set(p.name, p.content)
      if (this.lastEmittedAppendixParts.get(p.name) !== p.content) changed.push(p)
    }
    const sendFull = !this.appendixBaselineSent
    this.lastEmittedAppendixParts = current
    this.appendixBaselineSent = true
    if (sendFull) {
      if (parts.length === 0) return ''
      this.chargeAppendixParts(parts, chargeLedger)
      return `<context-update seq="${this.appendixSeq}">\n${parts.map(p => p.content).join('\n\n')}\n</context-update>`
    }
    if (changed.length === 0) return `<context-update seq="${this.appendixSeq}"/>`
    this.chargeAppendixParts(changed, chargeLedger)
    return `<context-update seq="${this.appendixSeq}" mode="delta">\n${changed.map(p => p.content).join('\n\n')}\n</context-update>`
  }

  /** Book the chars of appendix sub-blocks that carry a CVM source tag. */
  private chargeAppendixLedger(source: CvmInjectionSource, chars: number): void {
    if (chars <= 0) return
    this.appendixLedger.set(source, (this.appendixLedger.get(source) ?? 0) + chars)
  }

  private chargeAppendixParts(emitted: AppendixPart[], chargeLedger: boolean): void {
    if (!chargeLedger) return
    for (const p of emitted) {
      if (p.source) this.chargeAppendixLedger(p.source, p.content.length)
    }
  }

  /**
   * Hand over the CVM egress booked since the last call and clear it.
   *
   * Consume-once on purpose. The alternative — hanging the ledger off the
   * OaiChatRequest — would leak through `{...request}` spreads (llm-speculation)
   * and be replayed verbatim by FallbackStreamClient failover, double-charging
   * every retried turn. Same class of bug as the prefixProbe poisoning of 2026-07-06.
   */
  drainAppendixLedger(): Array<{ source: CvmInjectionSource; chars: number }> {
    if (this.appendixLedger.size === 0) return []
    const rows = [...this.appendixLedger].map(([source, chars]) => ({ source, chars }))
    this.appendixLedger.clear()
    return rows
  }

  /**
   * Mark git status as dirty — next user-message boundary will use live gitStatusCache
   * instead of the frozen session-start snapshot. Call after file-modifying tools
   * (Write, Edit, Bash with git commands) to keep multi-session git state fresh.
   */
  markGitDirty(): void {
    this.gitDirty = true
  }

  /**
   * Force the next context-update to be a full baseline. Call after history
   * rewrite/compaction drops messages carrying prior context-update blocks —
   * the model needs a fresh full snapshot because delta's "absent = unchanged"
   * semantics rely on the history still being present.
   *
   * The same event invalidates CVM accounting: the appendix bytes booked so far
   * just left the context. Registered listeners (the pressure monitor) are
   * notified here rather than at each of the ten call sites, so the two cannot
   * drift apart.
   */
  resetAppendixBaseline(): void {
    this.lastEmittedAppendixParts = new Map()
    this.appendixBaselineSent = false
    this.appendixLedger.clear()
    this.onResetAppendixBaselineCb?.()
  }

  /** Register the CVM accounting reset that must accompany a baseline reset. */
  setOnResetAppendixBaseline(fn: () => void): void {
    this.onResetAppendixBaselineCb = fn
  }

  /**
   * Cache-event counters for cache-log breadcrumbs (P2-6).
   * Cumulative since engine creation — callers diff across turns.
   */
  getCacheEventStats(): { volatileSwaps: number; frozenClamps: number; frozenFallbackRebuilds: number; collapseWatermark: number; toolsUpdates: number } {
    return {
      volatileSwaps: this.volatileSwapCount,
      frozenClamps: this.frozenSnapshotClamps,
      frozenFallbackRebuilds: this.frozenFallbackRebuilds,
      collapseWatermark: this.collapseWatermark,
      toolsUpdates: this.toolsUpdateCount,
    }
  }

  /**
   * Pre-refresh git status cache when stale. Call in async context before
   * buildOaiRequest() to ensure the model sees fresh git state instead of the
   * up-to-30s-old cached value returned by the synchronous get() path.
   */
  async refreshGitContextIfNeeded(cwd: string): Promise<void> {
    const { gitStatusCache } = await import('./volatile-git.js')
    await gitStatusCache.refreshIfStale(cwd)
  }

  setActiveDomain(domain: VolatileContext['activeDomain']): void {
    this.activeDomain = domain
    // Fold the (session-constant) domain into the frozen prefix. Only rebuild —
    // do NOT invalidateFreshCache(): domain switches can land mid-tool-loop
    // (/domain, model switch) where clearing cachedFreshForUser would make the
    // next same-message tool-call turn look like a new user boundary, forcing an
    // early volatileBlock swap + appendix rebuild → mid-tool-loop prefix break
    // (the exact failure invalidateFreshCache's diagnostic guards against). The
    // frozenBase→volatileBlock swap is deferred to the next real user-message
    // boundary in buildOaiRequest, which rebuilds fresh naturally. (Differs from
    // updateSessionMemory, which is called at turn boundaries and can safely
    // invalidate.) First-bind is safe too: cachedFreshForUser is '' at startup,
    // so the first buildOaiRequest enters the boundary and applies the swap.
    this.rebuildFrozenBase()
  }

  getVolatilePayloadReport(toolHistory?: ToolHistoryEntry[]): VolatilePayloadReport {
    const latest = buildLatestTurnVolatileBlock({
      ...this.config.volatileCtx,
      toolHistory,
      taskProgress: this.taskProgress,
      toolContext: this.toolContext,
      planCacheAdvisory: this.planCacheAdvisory,
      planTraceAppendix: this.planTraceAppendix,
      intentRetrievalRoute: this.intentRetrievalRoute,
      taskDepthAdvisory: this.taskDepthAdvisory,
      planMethodologyAdvisory: this.planMethodologyAdvisory,
      harnessAdvisoryBlock: this.harnessAdvisoryBlock,
      decisions: this.decisions,
      activeDomain: this.activeDomain ?? this.config.volatileCtx.activeDomain,
      activeClaims: this.activeClaims ?? this.config.volatileCtx.activeClaims,
      playbookLessons: this.playbookLessons ?? this.config.volatileCtx.playbookLessons,
      sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock,
      sessionState: this.sessionStateText,
      worktreeReality: this.worktreeReality,
    })
    return analyzeVolatilePayload(latest)
  }

  getContextLayerReport(): ContextLayerReport {
    return this.contextLayerReportData
  }
}

/**
 * Compute the T7 collapse boundary: the first message index AFTER the last
 * message whose turn age >= collapseAge. Messages below this index are
 * eligible for request-time collapse.
 */
export function computeCollapseBoundary(messages: OaiMessage[], collapseAge: number): number {
  let currentTurn = 0
  for (const m of messages) {
    if (m.role === 'user') currentTurn++
  }

  let turnCounter = 0
  let boundary = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user') turnCounter++
    if (currentTurn - turnCounter >= collapseAge) boundary = i + 1
  }
  return boundary
}

/**
 * Request-time collapse for 1M+ windows (T7).
 * Mutates the request message array in-place — NOT the stored session messages.
 * Tool results below boundaryIndex (a stable watermark held by PromptEngine)
 * are replaced with semantic summaries. The watermark — rather than a per-call
 * sliding age window — keeps the collapsed region byte-stable across requests.
 *
 * Reasoning stripping rides the same watermark: assistant `reasoning_content`
 * below the boundary is dropped from the request copy. In tool-dense sessions
 * reasoning accumulates linearly (DeepSeek requires echoing it on tool-call
 * turns), becoming the dominant hidden token sink at 1M. Old rounds — the
 * boundary trails the head by collapseAge (≥8) user turns, so the active
 * thinking round is never touched — don't need their reasoning echoed, and
 * because the strip happens at exactly the same boundary/step as the tool
 * collapse, it adds zero additional prefix-cache breaks.
 */
export function requestTimeCollapse(messages: OaiMessage[], boundaryIndex: number, contextWindow: number, lightOnly = false): void {
  let currentTurn = 0
  for (const m of messages) {
    if (m.role === 'user') currentTurn++
  }

  // Build dedup index: for each tool+target pair, track all occurrences
  // below the boundary so older duplicates can be folded.
  const toolOccurrences = new Map<string, number[]>()
  const end = Math.min(boundaryIndex, messages.length)
  for (let i = 0; i < end; i++) {
    const msg = messages[i]!
    if (msg.role !== 'tool' || msg.content.length < 200) continue
    if (msg.content.startsWith('[collapsed ') || msg.content.startsWith('[storm-collapsed') || msg.content.startsWith('[tiered-')) continue
    const toolName = inferToolName(messages, i)
    if (toolName === 'grep' || toolName === 'search' || toolName === 'read_file') {
      const target = inferToolTarget(messages, i, toolName)
      if (target) {
        const key = `${toolName}:${target}`
        const indices = toolOccurrences.get(key)
        if (indices) indices.push(i)
        else toolOccurrences.set(key, [i])
      }
    }
  }

  // Indices of tool results that are superseded by a later call with the same target
  const superseded = new Set<number>()
  for (const indices of toolOccurrences.values()) {
    if (indices.length > 1) {
      for (let k = 0; k < indices.length - 1; k++) superseded.add(indices[k]!)
    }
  }

  let turnCounter = 0
  for (let i = 0; i < end; i++) {
    const msg = messages[i]!
    if (msg.role === 'user') turnCounter++

    if (msg.role === 'assistant' && 'reasoning_content' in msg && msg.reasoning_content) {
      const { reasoning_content: _dropped, ...rest } = msg
      messages[i] = rest.content == null && !rest.tool_calls?.length
        ? { ...rest, content: '' }
        : rest
      continue
    }

    if (msg.role !== 'tool') continue
    if (msg.content.length < 200) continue
    if (msg.content.startsWith('[collapsed ') || msg.content.startsWith('[storm-collapsed') || msg.content.startsWith('[tiered-')) continue

    const toolName = inferToolName(messages, i)

    // Dedup fold: if a newer call to the same tool+target exists below boundary,
    // collapse this older result regardless of lightOnly mode.
    if (superseded.has(i)) {
      const target = inferToolTarget(messages, i, toolName)
      messages[i] = { ...msg, content: `[collapsed ${toolName}: superseded by later ${toolName} on ${target ?? 'same target'}]` }
      continue
    }

    // In light-only mode, skip full semantic collapse — only dedup + reasoning strip.
    if (lightOnly) continue

    const turnAge = currentTurn - turnCounter
    const collapsed = collapseToolResult(toolName, msg.content, turnAge, contextWindow)
    if (collapsed) {
      messages[i] = { ...msg, content: collapsed.summary }
    }
  }
}

/**
 * Extract tool target from the assistant's tool_call arguments.
 * For grep/search: the pattern or path argument.
 * For read_file: the file path argument.
 */
function inferToolTarget(messages: OaiMessage[], toolMsgIndex: number, toolName: string): string | null {
  const toolMsg = messages[toolMsgIndex]!
  if (toolMsg.role !== 'tool' || !('tool_call_id' in toolMsg)) return null
  const toolCallId = (toolMsg as { tool_call_id?: string }).tool_call_id
  if (!toolCallId) return null

  for (let j = toolMsgIndex - 1; j >= 0; j--) {
    const prev = messages[j]!
    if (prev.role !== 'assistant') continue
    const calls = (prev as { tool_calls?: Array<{ id: string; function: { arguments: string } }> }).tool_calls
    if (!calls) continue
    const call = calls.find(c => c.id === toolCallId)
    if (!call) continue
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>
      if (toolName === 'grep' || toolName === 'search') {
        return (args['pattern'] as string | undefined) ?? (args['query'] as string | undefined) ?? null
      }
      if (toolName === 'read_file') {
        return (args['path'] as string | undefined) ?? (args['file'] as string | undefined) ?? null
      }
    } catch { return null }
  }
  return null
}

function inferToolName(messages: OaiMessage[], toolMsgIndex: number): string {
  const toolMsg = messages[toolMsgIndex]!
  if (toolMsg.role !== 'tool' || !('tool_call_id' in toolMsg)) return 'unknown'
  const toolCallId = (toolMsg as { tool_call_id?: string }).tool_call_id
  if (!toolCallId) return 'unknown'

  for (let j = toolMsgIndex - 1; j >= 0; j--) {
    const prev = messages[j]!
    if (prev.role !== 'assistant') continue
    const tc = (prev as { tool_calls?: Array<{ id: string; function?: { name: string } }> }).tool_calls
    if (!tc) continue
    const match = tc.find(c => c.id === toolCallId)
    if (match?.function?.name) return match.function.name
  }
  return 'unknown'
}
