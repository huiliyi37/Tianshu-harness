import { proveWirePrefix, assertContinuationPrefix, wireObservation, type ContinuationPrefixProof, type RequestDiagnostics } from './continuation-prefix.js'
import { beginCallAudit, auditConfigFingerprint, observedAuditUsage } from './call-audit.js'
import { createHash } from 'node:crypto'
import type { Usage } from './types.js'
import { assertCompleteAttachments } from './attachment-integrity.js'
import { UsageSettlement } from './usage-settlement.js'
import type { StreamClient, WireDivergence } from './stream-client.js'
import type { StreamCallbacks } from './stream-client.js'
import { normalizeOaiMessage, oaiMessagesHaveImageParts, stripOaiImageParts, stripOaiProviderMetadata } from './oai-types.js'
import type { OaiChatRequest, OaiMessage } from './oai-types.js'
import { proRegistry } from './pro-registry.js'
import { estimateOaiTokens } from '../compact/micro.js'
import type { ProviderProfile } from './provider-profile.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { resolveWireEffort } from './provider.js'
import { ReasoningRepetitionGuard, REASONING_REPETITION_CORRECTION } from './reasoning-repetition.js'
import { deepSeekImageLimitError } from '../context/image-input-limits.js'
import { isOfficialDeepSeek, deepSeekBudgetPolicy, buildContextBudget, assertContextBudget, DEEPSEEK_BODY_LIMIT, DEEPSEEK_OUTPUT_RESERVE } from '../context/request-budget.js'
import type { ContextBudgetSnapshot } from '../server/protocol.js'
import { classifyApiError } from './error-classifier.js'
import { normalizeBaseUrl } from './endpoint-map.js'
import { sanitizeMessageContent, countContentChars, FULL_SANITIZE_CHARS } from '../utils/sanitize.js'
import { parseOpenAIError } from './error-hints.js'
import { createBodyGuardNotifyState, enforceRequestBodyLimit, notifyBodyGuard } from './request-body-guard.js'
import { stableStringify } from './stable-json.js'
import { RequestInvariantMonitor } from './request-invariant.js'
import { recoverDsmlToolCallsFromContent } from './dsml-tool-calls.js'
import { stripThinkTags, filterThinkTagDelta } from './inline-reasoning.js'
import { wireAbortToReaderCancel, wrapBodyTimeoutError } from './abort-reader.js'
import { debugLog } from '../utils/debug.js'
import { repairInvalidJsonEscapes } from './json-escape-repair.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ProxyAgent } from 'undici'
import { acquireRateLimitSlot } from './rate-limiter.js'
import type { ProviderRetryConfig } from '../config/retry-schema.js'

/**
 * Parse accumulated tool_call arguments into an input object.
 *
 * Returns:
 *  - `{}` when the buffer holds no arguments (a genuine no-arg tool call).
 *  - the parsed object on success.
 *  - a salvaged object when the buffer is two concatenated JSON objects
 *    (`{...}{...}`), which happens when a provider reuses a single
 *    `tool_calls[].index` for distinct calls — we recover the first object.
 *  - `null` when the buffer is non-empty but not yet (or not) valid JSON,
 *    signalling the caller to defer until more chunks arrive.
 *
 * The `null` signal is what stops a premature `finish_reason` flush from
 * emitting an empty-input tool_use block (GLM-5.2 streams trailing argument
 * deltas AFTER finish_reason; flushing eagerly fed `{}` to the tool, which then
 * failed with a misleading "X is required").
 */
/** Hash only; diagnostics never include prompt or image contents. */
function wireHash(s: string): string { return createHash('sha256').update(s).digest('hex') }

/**
 * SSE transport ended before the provider's terminal `data: [DONE]` marker.
 *
 * A clean socket close is not by itself proof of a complete generation: the
 * connection may be cut by a proxy, an idle LB, or a retryable transport reset
 * after a partial body. Previously that EOF was settled as `complete`, so the
 * discarded partial turn looked successful and no `stream_attempt_aborted`
 * breadcrumb existed. Treat it as an incomplete attempt and let the retry /
 * fallback policy decide the next step.
 */
export class IncompleteStreamError extends Error {
  constructor() {
    super('OpenAI SSE stream ended before [DONE] completion marker (incomplete stream)')
    this.name = 'IncompleteStreamError'
  }
}


function tryParseToolArguments(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    // Windows-path recovery: raw backslashes in string values (`"F:\src\app"`)
    // are invalid JSON escapes that fail the whole buffer. Repair and re-parse
    // before falling back to salvage, so the call executes instead of being
    // refused as argsTruncated.
    const repaired = repairInvalidJsonEscapes(raw)
    if (repaired !== null) {
      try {
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
      } catch { /* fall through to salvage */ }
    }
    // Salvage a single leading JSON object from a concatenated buffer.
    return salvageFirstJsonObject(repaired ?? raw)
  }
}

/** Extract and parse the first balanced top-level `{...}` from a string. */
function salvageFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1))
          return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export interface OpenAIClientConfig {
  contextWindow?: number
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinking?: 'enabled' | 'disabled'
  /** What type of thinking block to send. 'enabled' = {type:'enabled'}, 'adaptive' = {type:'adaptive'}, 'none' = reasoning_effort only */
  thinkingBlockType?: 'enabled' | 'adaptive' | 'none'
  /** Whether the provider separates reasoning into a reasoning_content field */
  reasoningSplit?: boolean
  /** Which field carries the thinking budget inside the thinking block */
  thinkingBudgetField?: 'budget_tokens'
  /** Per-provider effort ceiling — values above this cap are clamped */
  effortCap?: Record<string, string>
  /** How effort/thinking intensity is controlled. 'none' = provider doesn't support reasoning_effort */
  effortFormat?: 'reasoning_effort' | 'output_config' | 'none'
  auth?: import('../auth/types.js').AuthProvider
  /** Stable session identifier for cache routing affinity */
  sessionId?: string
  /** Provider params to strip at all levels (preserves canonical prefix) */
  unsupported?: string[]
  /** Provider profile for cache strategy application */
  providerProfile?: ProviderProfile
  /** Provider name for feature gating (e.g. 'glm' for web_search) */
  providerName?: string
  /** Env var holding the API key — surfaced in 401/403 error hints. */
  apiKeyEnv?: string
  /** Session-frozen wire-transform context (spark truncate N 等)。随会话 meta
   *  冻结、resume 读回——wire 字节在 env 漂移/跨端下保持稳定（前缀缓存前提）。 */
  wireContext?: import('./pro-registry.js').WireTransformContext
  /**
   * Preserved-thinking protocol family (DeepSeek native: reasoning_content echoed
   * back on tool-call turns, Chinese-thinking system suffix). Capability-table
   * field: the factory passes `capabilities.preservedThinkingProtocol` resolved
   * from WELL_KNOWN_DEFAULTS / user overrides — no providerName inference here.
   */
  preservedThinkingProtocol?: boolean
  /** Enable DeepSeek Beta prefix completion (skip preamble) */
  prefixCompletion?: boolean
  /** Use max_completion_tokens instead of max_tokens (MiMo requires this per API docs) */
  useMaxCompletionTokens?: boolean
  /** Custom User-Agent header — required by providers that verify caller identity (e.g. Kimi) */
  userAgent?: string
  /** Header name carrying sessionId. Default 'X-Request-Session'; providers that
   *  mandate their own name (OpenCode Go: x-opencode-session) set it via wire. */
  sessionHeader?: string
  /**
   * Thinking-stall timeout (ms): once reasoning tokens have arrived but no text/tool
   * output yet, abort the stream if no further chunk within this window.
   * 默认 undefined = 禁用（等于 read 超时，不提前触发）—— 故意为之：Opus/GPT-5.5 等
   * 深思模型会合法地在推理段之间停顿 90s+，过短的 stall 会造成误杀。
   * 显式设置一个 < read 的值可对易卡死的 provider 开启更早的 stall 检测。
   */
  thinkingStallTimeoutMs?: number
  /**
   * First-byte (pre-first-chunk) timeout base override (ms). Optional.
   * 默认 undefined = 按 provider/thinking 推导（45/90/180s）。这一 base 之上还会按
   * 请求预估输入规模自动上浮（见 computeFirstByteTimeoutMs），故只有当某个自定义/慢
   * OpenAI 兼容模型即便小上下文也迟迟不出首 token 时才需要显式抬高 base。
   */
  firstByteTimeoutMs?: number
  /**
   * 显式声明本端点为慢思考（更长首字节/read 窗口、思考重试上限 2）。
   * 三态：undefined = 按 providerName/baseUrl 启发式（isSlowThinkingProvider）。
   */
  slowThinking?: boolean
  /** Provider-specific capability flags (网#1). */
  capabilities?: {
    /** DeepSeek sometimes emits tool JSON as plain text content. */
    hasToolJsonInContentBug?: boolean
  }
  /** Force JSON output mode (response_format: json_object) for every request.
   *  Worker sessions use per-request response_format instead, but this flag is
   *  available for clients that always want JSON. */
  jsonMode?: boolean
  /**
   * Provider usage calibration factor for `prompt_tokens` (0–1).
   * 1.0 (default) = trust the API's prompt_tokens as-is.
   * 0 = discard prompt_tokens; use local estimate instead.
   */
  usageCalibrationFactor?: number
  /**
   * Total request timeout (ms) for a single stream attempt — replaces the
   * 10min（glm 20min）硬顶 base。显式配置即严格：不做按进度续期（续期机制只
   * 服务于内置默认），到点直接 abort。firstByte/thinkingStall/read 三层计时器
   * 不受影响，谁先到谁生效。
   */
  requestTimeoutMs?: number
  /** 发送前请求体体积护栏上限（字节）。undefined = 不限制（默认，零开销不量体）。
   *  配置后超限先截断历史 tool 输出，削完仍超限抛可行动错误。 */
  maxBodyBytes?: number
  /** Max retry attempts for retryable API errors. undefined = 分类器 per-category
   *  默认（显式值不再被向下夹取）；0 = 禁用重试。thinking 模式仍受内置节流
   *  （slow-thinking 2 次 / 其余 1 次），显式配置覆盖之。 */
  maxRetries?: number
  /** Provider-level retry policy (issue #75)：退避曲线 / 类别覆盖 / 客户端限速。
   *  undefined = 历史行为（分类器固定延迟 + 内置预算）。 */
  retry?: ProviderRetryConfig
  /**
   * 共享重试预算 getter（PLAN §3）：返回**当前逻辑运行**的预算（agent 重连与
   * provider 重试共用一份）。undefined = 不启用共享预算（历史行为）。
   * 用 getter 而非实例：客户端在 agent 构造期建好，预算是 per-run 的。
   */
  retryBudget?: () => import('./retry-budget.js').RetryBudget | undefined
  /** Provider-level sampling temperature default (0–2)。仅当请求未显式指定
   *  temperature 且 thinking 未启用时注入——推理模式下多数服务端拒绝调温。 */
  temperature?: number
  /** Per-provider HTTP proxy（优先于全局 network.proxy）。构造时物化为
   *  undici ProxyAgent，经 fetchWithTimeout 的 dispatcher 槽位透传。 */
  proxy?: string
}

interface ToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

const FIRST_BYTE_TIMEOUT_MS = 45_000
export const REASONING_FIRST_BYTE_TIMEOUT_MS = 90_000
const READ_TIMEOUT_MS = 120_000
const REASONING_READ_TIMEOUT_MS = 180_000
// GLM-5.1, Mimo, and DeepSeek (max reasoning) mandatory thinking can take 2-3
// minutes before first token. Use generous timeouts to avoid false-positive errors.
export const SLOW_FIRST_BYTE_TIMEOUT_MS = 180_000
const SLOW_READ_TIMEOUT_MS = 300_000
// Size-scaled first-byte budget (B): a large cold-context prefill legitimately
// needs longer before the first token arrives. On top of the derived/configured
// base first-byte timeout, add PER_100K per 100k estimated input tokens, capped
// by MAX (kept below the 10min base hard cap and retry budget). Pre-first-chunk
// only — read timeout and thinking-stall detection are unchanged.
export const FIRST_BYTE_PER_100K_MS = 60_000
const FIRST_BYTE_MAX_MS = 420_000
// GLM-5.2 reasoning_effort=max: 服务端完整推理阶段可能 5min+ 不发 token，
// 300s read timeout 会误杀。单独给到 720s（12min 硬顶兜底 runaway）。
const GLM_READ_TIMEOUT_MS = 720_000
/** Providers whose thinking mode can exceed 90s before first token. */
export const SLOW_THINKING_PROVIDERS = new Set(['glm', 'mimo', 'deepseek', 'codex', 'minimax'])

/**
 * 慢思考端点的 baseUrl host 特征（第二级启发式）。自定义 provider 名自由发挥
 * （如 deepseek-spark），精确名匹配必然漏判（2026-08-09 会话 mskl1neqgwksu66h：
 * deepseek-spark 拿到 90s/180s 紧窗口而非 180s/300s）。按 hostname 子串匹配，
 * 覆盖官方域名与自建中转。
 */
const SLOW_THINKING_HOST_HINTS = ['deepseek', 'bigmodel.cn', 'xiaomimimo', 'minimax', 'chatgpt.com']

/**
 * 慢思考 provider 判定（三级优先级）：
 *   1. 显式配置 slowThinking（provider config / client config）——true/false 都压过启发式；
 *   2. providerName 精确命中 SLOW_THINKING_PROVIDERS（既有行为）；
 *   3. baseUrl hostname 子串命中 SLOW_THINKING_HOST_HINTS。
 */
export function isSlowThinkingProvider(input: {
  providerName?: string
  baseUrl?: string
  slowThinking?: boolean
}): boolean {
  if (input.slowThinking !== undefined) return input.slowThinking
  if (SLOW_THINKING_PROVIDERS.has(input.providerName ?? '')) return true
  if (input.baseUrl) {
    try {
      const host = new URL(input.baseUrl).hostname.toLowerCase()
      return SLOW_THINKING_HOST_HINTS.some((hint) => host.includes(hint))
    } catch {
      // 非法 baseUrl 跳过 URL 启发式
    }
  }
  return false
}
/**
 * Per-process cap on the always-on tool-stream event log (logToolStreamEvent).
 * These events fire only on rare streaming pathologies (ambiguous continuation
 * chunks dropped, final-flush empty tool_use), so a long healthy session writes
 * zero lines. Hitting the cap means the provider is misbehaving — stop logging
 * rather than fill disk.
 */
const TOOL_STREAM_LOG_MAX_LINES = 2000

/**
 * Best-effort redaction for tool-argument previews before they reach stderr
 * debug logs (CWE-532): blank out string values of sensitive-looking JSON keys
 * (password/token/secret/api_key/...). Works on truncated fragments too — an
 * unterminated trailing string value is masked as well. Not a guarantee: args
 * that embed secrets in free-form strings can still slip through; the always-on
 * disk log therefore carries no argument content at all.
 */
export function redactSensitiveArgs(fragment: string): string {
  return fragment
    .replace(
      /("(?:[^"\\]*(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key|access[_-]?key)[^"\\]*)"\s*:\s*")((?:[^"\\]|\\.)*)("?)/gi,
      '$1[REDACTED]$3',
    )
}
// Thinking-stall timeout 现由 config.thinkingStallTimeoutMs 控制（默认禁用，见
// resetIdleTimer 与 OpenAIClientConfig 注释）。旧的模块级常量已移除——它恒等于
// SLOW_READ_TIMEOUT_MS（实为禁用），且配套错误文案硬编码"90s"与实际值不符。

/** Recent-progress window for hard-cap extension: a data event within this
 *  window counts as "still producing" and earns another extension slice. */
const HARD_CAP_PROGRESS_WINDOW_MS = 60_000
const HARD_CAP_EXTENSION_SLICE_MS = 60_000
/** GLM reasoning can pause 30-60s between deltas without being stalled.
 *  Use a wider progress window so the hard cap doesn't abort healthy streams. */
const GLM_HARD_CAP_PROGRESS_WINDOW_MS = 120_000

/**
 * Size-scaled first-byte timeout (B). Pure function for testability.
 *
 * Adds a size term on top of the base first-byte budget so a genuinely large
 * cold-context prefill is not false-killed before the first token arrives, while
 * small requests keep the existing base. The result is capped so a truly dead
 * connection still fails within a bounded window.
 *
 * @param baseMs derived-or-configured base first-byte timeout (ms)
 * @param estInputTokens estimated prompt tokens for this request
 */
export function computeFirstByteTimeoutMs(input: {
  baseMs: number
  estInputTokens: number
  per100kMs?: number
  capMs?: number
}): number {
  const per100kMs = input.per100kMs ?? FIRST_BYTE_PER_100K_MS
  const capMs = input.capMs ?? FIRST_BYTE_MAX_MS
  const buckets = Math.floor(Math.max(0, input.estInputTokens) / 100_000)
  const scaled = input.baseMs + buckets * per100kMs
  return Math.min(scaled, capMs)
}

export type StreamHardCapAction =
  | { kind: 'abort' }
  | { kind: 'rearm'; rearmMs: number; extended: boolean }

/**
 * Track 4 自适应流硬顶：固定 10min 硬顶会误杀 1M+max-reasoning 的健康长输出
 * （死流早被 idle/stall 计时器拦截）。到达基础硬顶后，只要最近 progressWindowMs
 * 内仍有 data 事件就按 60s 一档续期，绝对上限 3×基础时长兜底 runaway。纯函数，
 * 由 openai-client 的硬顶计时器驱动。
 *
 * @param progressWindowMs 进度窗口（ms），默认 30s。GLM reasoning 模式传 120s
 *   以防止深度推理中 30-60s 的无 delta 停顿被误判为卡死。
 */
export function decideStreamHardCap(input: {
  now: number
  startedAt: number
  lastDataEventAt: number
  baseStreamMs: number
}, progressWindowMs = HARD_CAP_PROGRESS_WINDOW_MS): StreamHardCapAction {
  const absoluteMaxMs = input.baseStreamMs * 3
  const elapsed = input.now - input.startedAt
  if (elapsed >= absoluteMaxMs) return { kind: 'abort' }
  if (elapsed >= input.baseStreamMs) {
    if (input.now - input.lastDataEventAt > progressWindowMs) return { kind: 'abort' }
    return { kind: 'rearm', rearmMs: Math.min(HARD_CAP_EXTENSION_SLICE_MS, absoluteMaxMs - elapsed), extended: true }
  }
  return { kind: 'rearm', rearmMs: input.baseStreamMs - elapsed, extended: false }
}

export class OpenAIClient implements StreamClient {
  private toolCallBuffer = new Map<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>()
  private toolCallHintFired = new Set<number>()
  /** Resolved raw-SSE dump path (undefined = unresolved, null = disabled/failed). */
  private rawSsePath: string | null | undefined = undefined
  private pendingStopReason: string | null = null
  /** Messages from the current stream request — used for usage calibration. */
  private lastRequestMessages: OaiChatRequest['messages'] = []
  /** Accumulated text for DeepSeek tool-JSON-in-content fallback (网#1). */
  private _textAccum = ''
  /** Whether any content delta has started this stream (channel monotonicity:
   *  reasoning_content arriving after content is a protocol anomaly, reclassified as text). */
  private contentStarted = false
  /** 流式 think 标签过滤的扣留窗口（跨增量；见 inline-reasoning.ts）。 */
  private thinkHold = ''
  /** Stable suffix appended to system message for Chinese thinking (computed once, cache-safe). */
  private readonly systemSuffix: string
  /**
   * Resolved path for the lightweight tool-stream event log (always-on, best-effort).
   * undefined = unresolved, null = disabled/failed. Appends one JSON line per
   * notable streaming event (pollution-risk drops, final-flush empties) so the
   * cross-tool argument corruption class of bug leaves a trace WITHOUT requiring
   * RIVET_DEBUG. Capped at TOOL_STREAM_LOG_MAX_LINES per process to bound disk.
   */
  private toolStreamLogPath: string | null | undefined = undefined
  private toolStreamLogLines = 0
  /** Wire-level prefix probe: per-message signatures of the previous main-turn
   *  request's FINAL bytes (post reasoning-strip / sanitize / system-suffix).
   *  Only updated for requests with `prefixProbe: true` so side-path calls
   *  through this client don't poison the baseline. */
  private mainPrefixProof?: ContinuationPrefixProof
  getMainPrefixProof(): ContinuationPrefixProof | undefined { return this.mainPrefixProof }
  private prevWireSignatures: Array<{ sig: string; len: number; role: string }> | null = null
  /** 上一次主轮请求的 tools 数组指纹（同序 stable-json——上线字节保数组序）。
   *  消息级探针对工具定义变化隐形（2026-09-06 主会话 toolsUpdated 碎裂事件
   *  双探针皆净即此因），单独一个维度。 */
  private prevWireToolsSig: string | null = null
  /** Latest wire divergence (consume-once via consumeWireDivergence). */
  private lastWireDivergence: WireDivergence | null = null

  /**
   * 请求重建不变式（强制）：同一个 request.messages 数组在同一 client 上两次
   * 派发之间必须字节一致。刻意**按 client 实例**持有——换成进程单例会让
   * FallbackStreamClient 的 provider 故障转移（换 client 即换 system 后缀、
   * 换缓存命名空间）被误判为违规，把一次优雅降级变成硬错误。
   */
  private readonly requestInvariant = new RequestInvariantMonitor()
  /** undici ProxyAgent for config.proxy (undefined = no per-provider proxy). */
  private readonly proxyDispatcher: ProxyAgent | undefined

  constructor(private config: OpenAIClientConfig) {
    this.systemSuffix = Boolean(config.preservedThinkingProtocol) && config.thinking === 'enabled'
      ? '\n\n请在内部思考链中使用中文进行推理。不要在回复中输出你的推理过程，只输出最终答案或工具调用。'
      : ''
    this._sanitizedCount = 0
    this.proxyDispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined
  }

  /** 慢思考端点判定（名称/URL/显式配置三级，见 isSlowThinkingProvider）。 */
  private get isSlowThinking(): boolean {
    return isSlowThinkingProvider({
      providerName: this.config.providerName,
      baseUrl: this.config.baseUrl,
      slowThinking: this.config.slowThinking,
    })
  }

  // ── Incremental sanitize ─────────────────────────────────────
  // Historical messages are already sanitized at entry points
  // (addUserMessage/addAssistantBlocks/addToolResults). Re-sanitizing
  // the full message array every turn is O(history) overhead that grows
  // linearly with conversation length — particularly wasteful at 1M
  // context windows. We track the sanitized count and only apply the
  // safety-net sanitize to newly appended messages.
  private _sanitizedCount: number
  /** body 护栏上报节律（跨请求保持；去重语义见 notifyBodyGuard）。 */
  private readonly bodyGuardNotify = createBodyGuardNotifyState()

  setReasoningEffort(effort: string): void {
    // OpenAI uses reasoning_effort in request body — store for next request
    this.config = { ...this.config, reasoningEffort: effort }
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.config = { ...this.config, thinking: mode }
  }

  /**
   * 会话历史 → wire messages。reasoning_content 的保留/剥离规则：
   * - preserved-thinking 协议（capability 声明，如 DeepSeek/MiMo）：工具轮保留，纯文本轮剥离
   * - 独立推理（如 GLM，无 preservedThinkingProtocol）：一律剥离
   * - thinking 关闭：一律剥离
   *
   * `opts.preserveReasoning` 是一次性覆盖（issue #258）：当网关明确回 400
   * 「reasoning_content must be passed back」时，重试必须把思考内容原样发回，
   * 否则同一个请求再发一次还是同样的 400。覆盖只作用于本次 attempt，成功后由
   * stream() 把 `preservedThinkingProtocol` 粘到实例上（后续轮次不再重试）。
   */
  private mapWireMessages(
    messages: OaiMessage[],
    opts?: {
      toolsPresent?: boolean
      preserveReasoning?: boolean
      /** 该历史数组已派发过 → 忽略粘性的 preservedThinkingProtocol，保持原字节。 */
      suppressStickyPreserve?: boolean
    },
  ): OaiMessage[] {
    const stickyPreserved = Boolean(this.config.preservedThinkingProtocol)
      && opts?.suppressStickyPreserve !== true
    const isPreservedThinking = this.config.thinking === 'enabled'
      && (stickyPreserved || opts?.preserveReasoning === true)
    return messages.map(stripOaiProviderMetadata).map(m => {
      if (m.role !== 'assistant') return m
      const hasToolCalls = Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0
      // DeepSeek preserved-thinking: tool-call turns must echo reasoning_content.
      // Some turns omit the field entirely (model skipped thinking). Absent vs
      // present changes wire bytes and breaks prefix cache at the next user
      // boundary (8396ac51: truncations aligned with first no-reasoning assistant).
      if (isOfficialDeepSeek(this.config.baseUrl, this.config.model) && opts?.toolsPresent && this.config.thinking !== 'disabled') {
        // Keep the existing empty-field normalization for tool turns with no
        // recorded reasoning; never replace non-empty historical reasoning.
        return hasToolCalls && !('reasoning_content' in m) ? { ...m, reasoning_content: '' } : m
      }
      if (isPreservedThinking && hasToolCalls && !('reasoning_content' in m)) {
        return { ...m, reasoning_content: '' }
      }
      if (!('reasoning_content' in m)) return m
      if (isPreservedThinking && hasToolCalls) {
        // Pro wire transform（spec 3c 截断落点）：闭源模块注册的 copy-on-write
        // 消息变换（如 reasoning 尾部截断）。开源构建注册表恒空 → 原样返回。
        // wireContext = 会话冻结参数（truncate N），保证 resume/跨端字节稳定。
        const transform = proRegistry.getWireTransform(this.config.providerName ?? '')
        if (transform) return transform(m, this.config.model, this.config.wireContext)
        return m
      }
      // 被迫保留（preserveReasoning 覆盖）时，纯文本轮也保留——网关要求的是
      // 「历史里的思考内容原样回传」，只保工具轮会在下一个纯文本 assistant 轮
      // 再次触发同一个 400。
      if (opts?.preserveReasoning === true && isPreservedThinking) return m
      const { reasoning_content: _, ...rest } = m
      // DeepSeek requires assistant messages to have `content` or `tool_calls`.
      // After stripping reasoning_content, ensure `content` exists.
      if (!('content' in rest) && !hasToolCalls) {
        (rest as Record<string, unknown>).content = ''
      }
      return rest
    }).map(normalizeOaiMessage)
  }

  previewContextRequest(request: OaiChatRequest): OaiChatRequest {
    const model = request.model || this.config.model
    return { ...request, model, max_tokens: this.capOutputTokens(request.max_tokens ?? this.config.maxTokens, model),
      messages: this.mapWireMessages(request.messages, { toolsPresent: !!request.tools?.length,
        suppressStickyPreserve: this.requestInvariant.hasObserved(request) }) }
  }

  /** 官方 DeepSeek 的单次输出封顶到「现实预留」（DEEPSEEK_OUTPUT_RESERVE）——与预算侧
   *  outputReserve 同源，保证 `input + max_tokens ≤ window` 不被大输入破坏。其他 provider 原样。 */
  private capOutputTokens(maxTokens: number, model: string): number {
    return isOfficialDeepSeek(this.config.baseUrl, model) ? Math.min(maxTokens, DEEPSEEK_OUTPUT_RESERVE) : maxTokens
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    this.lastRequestMessages = request.messages
    // 已派发过的历史数组必须保持原字节（request invariant 硬门禁，2026-07-06 事故类）：
    // 粘性 preservedThinkingProtocol（reasoning_echo 自愈）只作用于此后的**新**数组，
    // 否则「侧路复用主请求 / 故障转移重放同一 request」会看到不同的字节。
    // 判断必须早于 observe()（observe 会登记本次派发，之后恒真）。
    assertCompleteAttachments(request.messages)
    const reentrantDispatch = this.requestInvariant.hasObserved(request)
    const messages = this.mapWireMessages(request.messages, {
      toolsPresent: !!request.tools?.length,
      suppressStickyPreserve: reentrantDispatch,
    })

    const body: Record<string, unknown> = {
      // 空 model 回退到 client 绑定值——侧路调用（essence-gate / vision bridge）
      // 传 model: '' 期望"client already binds the model"；不回退会被 provider 400。
      model: request.model || this.config.model,
      messages,
      stream: true,
    }

    // MiMo API uses max_completion_tokens, standard OpenAI uses max_tokens
    const wireMaxTokens = this.capOutputTokens(request.max_tokens ?? this.config.maxTokens, String(body.model))
    if (this.config.useMaxCompletionTokens) {
      body.max_completion_tokens = wireMaxTokens
    } else {
      body.max_tokens = wireMaxTokens
    }

    // stream_options: { include_usage: true } is an OpenAI extension.
    // Some providers return 400 if unsupported.
    if (!this.config.unsupported?.includes('stream_options')) {
      body.stream_options = { include_usage: true }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
      if (request.tool_choice) body.tool_choice = request.tool_choice
    }

    // JSON output mode: force the model to emit valid JSON. Per-request
    // response_format (worker final turn) takes precedence; config.jsonMode is a
    // fallback for always-JSON clients. DeepSeek/GLM require the prompt to
    // mention "json" when this is set — worker prompts already satisfy this.
    if (request.response_format) {
      body.response_format = request.response_format
    } else if (this.config.jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    } else if (this.config.temperature !== undefined && this.config.thinking !== 'enabled') {
      // provider 级采样温度默认值；思考模式下多数推理服务端拒绝调温，不注入。
      body.temperature = this.config.temperature
    }

    // Provider-specific reasoning output separation (e.g. MiniMax sends thinking
    // in a dedicated reasoning_content field rather than embedded in content).
    if (this.config.reasoningSplit) {
      body.reasoning_split = true
    }

    // Thinking / reasoning dispatch — fully capability-driven.
    // thinkingBlockType determines what type of thinking block to send:
    //   'enabled'  → {thinking: {type: 'enabled'}}
    //   'adaptive' → {thinking: {type: 'adaptive'}}
    //   'none'     → no thinking block; use reasoning_effort param instead
    const blockType = this.config.thinkingBlockType ?? 'none'
    if (['worker_report_repair', 'compact_summary'].includes(request.diagnostics?.purpose ?? '') && this.config.thinking === 'disabled' && blockType !== 'none') body.thinking = { type: 'disabled' }

    if (this.config.thinking === 'enabled') {
      if (blockType !== 'none') {
        body.thinking = { type: blockType }

        // Thinking budget (e.g. Claude's budget_tokens).
        if (this.config.thinkingBudgetField === 'budget_tokens' && this.config.reasoningEffort) {
          const budgetMap: Record<string, number> = {
            max: this.config.maxTokens,
            high: Math.floor(this.config.maxTokens * 0.6),
            medium: Math.floor(this.config.maxTokens * 0.3),
            low: 8192,
            off: 0,
          }
          const budget = budgetMap[this.config.reasoningEffort ?? 'high'] ?? Math.floor(this.config.maxTokens * 0.6)
          ;(body.thinking as Record<string, unknown>)['budget_tokens'] = budget
        }

        // DeepSeek-style: thinking block + reasoning_effort coexist.
        // Only for providers that accept reasoning_effort alongside the thinking block.
        // Providers with in-block effort encoding (budget_tokens / adaptive) don't need
        // a separate reasoning_effort field.
        if (this.config.effortFormat === 'reasoning_effort') {
          // 档位映射（含 `off` 的省略语义）统一走 resolveWireEffort：旧代码只在
          // 这里单独判 `!== 'off'`，下面两个写入点漏判——issue #258 的
          // `reasoning_effort: off` 就是从那里漏出去的。
          const wireEffort = resolveWireEffort(this.config.reasoningEffort, this.config.effortCap)
          if (wireEffort) body.reasoning_effort = wireEffort
        }
      } else if (this.config.effortFormat !== 'none') {
        // 未配档位 → 网关默认 medium；显式 `off` 且 provider 未给映射 → 不发该字段
        //（`off` 不是任何端点的合法枚举值，直发即 400）。
        const wireEffort = this.config.reasoningEffort === undefined
          ? 'medium'
          : resolveWireEffort(this.config.reasoningEffort, this.config.effortCap)
        if (wireEffort) body.reasoning_effort = wireEffort
      }
    }
    if (this.config.effortFormat !== 'none' && request.reasoning_effort) {
      // 请求级档位是**更具体**的意图（auto-reasoning 逐轮决定走这条），必须能覆盖
      // 上面写入的 provider 默认档——包括「显式 off 表示本轮不要该字段」这种清空
      // 语义。否则 off 会被上面刚写进去的 'medium' 掩盖，等于降档失效。
      const wireEffort = resolveWireEffort(request.reasoning_effort, this.config.effortCap)
      if (wireEffort) body.reasoning_effort = wireEffort
      else delete body.reasoning_effort
    }

    // Apply stable system suffix (Chinese thinking instruction) — computed once
    // at construction. Copy-on-write, NEVER `content +=`: the system message
    // object is shared by reference with the caller's request.messages, and the
    // same request object can re-enter stream() (llm-speculation reuses the main
    // request's messages; FallbackStreamClient replays the request on failover).
    // In-place mutation double-appended the suffix on re-entry → system bytes
    // changed mid-session → full prefix-cache miss for that request (2026-07-06
    // wireDiverged idx 0 incident).
    if (this.systemSuffix) {
      const wireMessages = body.messages as Record<string, unknown>[]
      const sysIdx = wireMessages.findIndex(m => m.role === 'system')
      const sysMsg = sysIdx >= 0 ? wireMessages[sysIdx]! : undefined
      if (sysMsg && typeof sysMsg.content === 'string') {
        wireMessages[sysIdx] = { ...sysMsg, content: sysMsg.content + this.systemSuffix }
      }
    }

    // Incremental sanitize: only re-sanitize messages appended since last
    // request. Historical messages were already sanitized at entry points
    // (addUserMessage/addAssistantBlocks/addToolResults). This avoids O(n)
    // overhead that grows linearly with conversation length.
    //
    // 大体积请求（>FULL_SANITIZE_CHARS）一律全量清洗：增量路径会漏掉「历史段被原地
    // 改写」与「client 实例跨数组复用」两处窗口，而漏过的一个控制字符在 wire 上就是
    // `\u00XX` 转义——正是上游按字节截断 body 时的切口（maxBodyBytes 护栏只是兜底且默认关闭，源头也得
    // 干净）。全量扫描与本次必做的 JSON.stringify 同阶，1M 字符以上已可忽略。
    const msgArray = body.messages as Array<Record<string, unknown>>
    if (msgArray.length <= this._sanitizedCount || countContentChars(msgArray) > FULL_SANITIZE_CHARS) {
      // Compaction / message replacement / 大体积请求: reset and full sanitize
      this._sanitizedCount = 0
    }
    const newMessages = msgArray.slice(this._sanitizedCount)
    if (newMessages.length > 0) {
      const sanitizedNew = sanitizeMessageContent(newMessages)
      for (let i = 0; i < sanitizedNew.length; i++) {
        msgArray[this._sanitizedCount + i] = sanitizedNew[i]!
      }
      this._sanitizedCount = msgArray.length
    }

    // Wire-level prefix probe (2026-07-06 cache investigation): fingerprint the
    // FINAL messages — everything above (reasoning-strip, system-suffix,
    // sanitize) has already been applied, so this hashes exactly what goes on
    // the socket. The engine-level probe proved the pre-transform arrays are
    // append-only; cacheRead regressions kept happening anyway, so the
    // remaining client-side suspects are these transforms. Joined with
    // cacheRead regressions in the cache-log this separates send-layer byte
    // churn from provider-side rendering/落盘 behavior.
    // 请求重建不变式：断言这一份最终上线字节与「同一个 request 对象上次派发」一致。
    // 刻意对**所有**请求生效（不止 prefixProbe 的主轮）——侧路复用主请求的
    // messages 数组、故障转移重放同一 request，这两条路径原先完全没有守护，
    // 而 2026-07-06 的原地双追加事故正是发生在它们的形状上。
    this.requestInvariant.observe(request, msgArray, body.tools as unknown[] | undefined)


    await this.sendStream(body, callbacks, signal, request.messages, request.contextBudget, request.prefixProbe, request.diagnostics)
  }

  /** Compare this request's final wire bytes with the previous main-turn
   *  request's; record the first diverged message. Pure appends record nothing.
   *  tools 数组单独成维——它不进 messages，消息级对比对其隐形。 */
  private recordWireDivergence(messages: Array<Record<string, unknown>>, tools?: unknown[]): void {
    this.lastWireDivergence = null
    const sigs = messages.map(m => {
      const s = JSON.stringify(m)
      return { sig: wireHash(s), len: s.length, role: String(m.role ?? '?') }
    })
    const toolsSig = tools && tools.length > 0 ? wireHash(stableStringify(tools)) : null
    const prev = this.prevWireSignatures
    const prevToolsSig = this.prevWireToolsSig
    this.prevWireSignatures = sigs
    this.prevWireToolsSig = toolsSig
    if (!prev) return

    // 工具定义变化优先报告——它打的是整个前缀（system+tools 段），不是某条消息。
    if (prevToolsSig !== toolsSig) {
      this.lastWireDivergence = {
        idx: -1,
        role: 'tools',
        kind: 'tools_changed',
        prevCount: prev.length,
        newCount: sigs.length,
        approxCharPos: 0,
      }
      return
    }

    const shared = Math.min(prev.length, sigs.length)
    let divergedIdx = -1
    for (let i = 0; i < shared; i++) {
      if (prev[i]!.sig !== sigs[i]!.sig) { divergedIdx = i; break }
    }
    if (divergedIdx === -1) {
      if (sigs.length >= prev.length) return // pure append (or identical)
      divergedIdx = sigs.length
    }
    let approxCharPos = 0
    for (let i = 0; i < divergedIdx; i++) approxCharPos += sigs[i]?.len ?? prev[i]!.len
    this.lastWireDivergence = {
      idx: divergedIdx,
      role: sigs[divergedIdx]?.role ?? 'removed',
      kind: divergedIdx >= sigs.length ? 'message_removed' : 'message_changed',
      prevCount: prev.length,
      newCount: sigs.length,
      approxCharPos,
    }
  }

  /** Consume-once accessor for the latest wire-level prefix divergence. */
  consumeWireDivergence(): WireDivergence | null {
    const d = this.lastWireDivergence
    this.lastWireDivergence = null
    return d
  }

  /** Shared inner retry+fetch+SSE loop used by both stream and streamOai. */
  private async sendStream(
    body: Record<string, unknown>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    /**
     * 未剥离的原始历史。`body.messages` 是已按 preserved-thinking 规则剥离过的
     * 副本——reasoning_echo 自愈（issue #258）必须从原始数组重建，否则剥掉的
     * 思考内容回不来。缺省 = 该调用方没提供，自愈分支直接跳过（不猜）。
     */
    sourceMessages?: OaiMessage[],
    preparedBudget?: ContextBudgetSnapshot,
    prefixProbe = false,
    diagnostics?: RequestDiagnostics,
  ): Promise<void> {
    // reasoningRef survives retry attempts within this sendStream call.
    // When a mid-stream failure occurs (e.g. idle timeout, connection reset),
    // the accumulated reasoning_content is saved here and echoed back to the
    // model on the next retry so it doesn't have to redo all the thinking.
    const requestId = preparedBudget?.requestId ?? crypto.randomUUID()
    let attempt = 0
    const reasoningRef = { content: '' }
    const isThinking = this.config.thinking === 'enabled'

    // image_strip 恢复状态：上一次失败是否被判定为图片负载问题（要求剥图重发）、
    // 是否已经剥过。流程：首次原样带图 → 分类器判 image_strip 时剥图重发一次 →
    // 若仍 413，这一次请求体已无图，client 会在错误上标 payloadHadImages: false，
    // 分类器据此改判 context_overflow（不可重试），不会再发第三次。
    let stripRequested = false
    let imagesStripped = false

    // reasoning_echo 恢复状态（issue #258）：网关回 400「reasoning_content must be
    // passed back」时，本次请求重发一次**保留思考内容**的历史；成功后把
    // preservedThinkingProtocol 粘到实例上，后续轮次不再吃这一发。
    let preserveReasoningRequested = false
    let preserveReasoningApplied = false

    // reasoning_repetition 恢复状态（2026-09-24，issue #260）：思考退化成复读短句时，
    // 先**纠正重试一次**——丢掉那段退化推理（绝不回放，回放会强化循环）+ 尾部附一句
    // 纠正指令；第二次仍命中才冒泡成终态错误。判定阈值见 reasoning-repetition.ts。
    let repeatCorrectionRequested = false
    let repeatCorrectionApplied = false

    // Size-scaled first-byte budget (B): estimate prompt size once (stable across
    // retries; the per-retry reasoning re-injection is negligible) and derive a
    // first-byte timeout that grows with input so large cold-context prefills are
    // not false-killed before the first token. Used for both the fetch headers
    // guard and the pre-first-chunk SSE idle timer.
    const estInputTokens = estimateOaiTokens((body.messages as OaiMessage[]) ?? [])
    const derivedFirstByteBaseMs = isThinking
      ? (this.isSlowThinking ? SLOW_FIRST_BYTE_TIMEOUT_MS : REASONING_FIRST_BYTE_TIMEOUT_MS)
      : FIRST_BYTE_TIMEOUT_MS
    const firstByteMs = computeFirstByteTimeoutMs({
      baseMs: this.config.firstByteTimeoutMs ?? derivedFirstByteBaseMs,
      estInputTokens,
    })

    await withStructuredRetry(async () => {
      // Unique attempt IDs prevent failover usage dedupe collisions.
      const identity: Omit<NonNullable<Usage['observation']>, 'status' | 'fields'> = { requestId, attemptId: `${requestId}:${++attempt}:${crypto.randomUUID()}` }
      // Reset instance state for each attempt
      this.toolCallBuffer.clear()
      this.toolCallHintFired.clear()
      this.pendingStopReason = null
      this._textAccum = ''
      this.thinkHold = ''
      this.contentStarted = false

      // Inject previous reasoning into messages on retry so the model can
      // resume from where it left off instead of restarting from scratch.
      // DeepSeek requires assistant messages to have `content` or `tool_calls`.
      //
      // GLM exception: GLM's preserved thinking (clear_thinking: false) has its
      // own incremental protocol — it expects complete prior-turn reasoning, not
      // partial mid-stream fragments. Injecting partial reasoning_content breaks
      // the increment and causes GLM to re-reason from scratch (the exact
      // "推理到一半中断然后从头推一遍" symptom). GLM retains reasoning server-side,
      // so skipping client-side reinjection is safe.
      // 剥图重发（上一次失败被判为 image_strip）：在 reasoning 注入之前先把
      // image_url part 摘掉。只改本次请求体，绝不 in-place 改 body——会话历史与
      // 后续轮次仍保图（用户下一句「这张图里…」还能对上）。stripOaiImageParts
      // 是纯函数，无图可剥时返回原引用，下面按引用比较走原路径。
      let wireMessages = body.messages as OaiMessage[]
      // 已剥图的重试：每次 attempt 都从原始 body 重建，必须幂等重放剥离，否则后续
      // 因别的原因重试（500 等）会把毒图又发出去（pinned by image_strip recovery 测试）。
      if (imagesStripped) wireMessages = stripOaiImageParts(wireMessages).messages
      // 保留思考内容重发（上一次失败被判 reasoning_echo）：从**原始** request.messages
      // 重建（body.messages 已经是剥离后的历史，剥掉的信息回不来）。与剥图同理，
      // 只改本次 attempt 的 wire 副本，不动 request.messages / body。
      if (preserveReasoningRequested && !preserveReasoningApplied && sourceMessages) {
        wireMessages = this.mapWireMessages(sourceMessages, { preserveReasoning: true, toolsPresent: Array.isArray(body.tools) && body.tools.length > 0 })
        preserveReasoningApplied = true
        // wire 形态被改了（历史里多出 reasoning_content，前缀字节随之变化）——
        // 静默改形态是本仓最贵的 bug 形状，必须让调用方有机会说出来。
        callbacks.onReasoningEchoRecovered?.()
      }
      if (stripRequested && !imagesStripped) {
        const stripped = stripOaiImageParts(wireMessages)
        if (stripped.removedCount > 0) {
          wireMessages = stripped.messages
          imagesStripped = true
          // 模型这一轮再也看不到这些图了——必须让调用方有机会告诉用户，
          // 否则「模型没理我的截图」会被当成模型变笨。
          callbacks.onImageStripped?.({ removedCount: stripped.removedCount, uniqueUrlCount: stripped.uniqueUrlCount })
        }
      }

      // 复读纠正重发（2026-09-24，issue #260）：不清掉那段退化推理就等于把同一个
      // 循环再喂一遍（故 reasoningRef 置空 + 历史里本来就只存正常轮），尾部附一句
      // 纠正让模型换思路。只改本次 attempt 的 wire 副本，不进口历史。
      if (repeatCorrectionRequested && !repeatCorrectionApplied) {
        repeatCorrectionApplied = true
        reasoningRef.content = ''
        wireMessages = [...wireMessages, { role: 'user', content: REASONING_REPETITION_CORRECTION }]
        debugLog('[openai-client] reasoning_repetition 自愈：丢弃退化推理 + 尾部纠正指令，重发一次')
      }

      let effectiveBody = body
      const isGlm = this.config.providerName === 'glm'
      if (isThinking && reasoningRef.content && !isGlm) {
        const msgs = [...wireMessages, {
          role: 'assistant',
          content: '',
          reasoning_content: reasoningRef.content,
        }]
        effectiveBody = { ...body, messages: msgs }
      } else if (wireMessages !== body.messages) {
        effectiveBody = { ...body, messages: wireMessages }
      }

      // Resolve auth headers: AuthProvider takes precedence over static apiKey
      const authHeaders = this.config.auth
        ? await this.config.auth.getHeaders()
        : { 'Authorization': `Bearer ${this.config.apiKey}` }

      // Pre-first-byte timeout prevents fetch from hanging forever when the
      // server accepts the connection but never sends response headers. Uses the
      // size-scaled first-byte budget computed above.
      const fetchTimeout = firstByteMs
      // 共享 lifecycle controller：传给 fetch 的信号。它由外部 user signal 联动，
      // 也由 parseStreamFromReader 在任何退出路径（idle/硬顶超时、错误、正常结束）
      // 于 finally 中 abort —— 确保 keep-alive 下仅 reader.cancel() 可能拆不掉的 TCP
      // 连接被 fetch 侧 abort 真正拆除（mid-body abort 同时拆 fetch）。
      // 请求体体积护栏（可选）：provider 网关超限时会**按字节截断 body**，切进一个
      // `\uXXXX` 转义就报 "unexpected end of hex escape" HTTP 400——用户只看到一句
      // 英文 serde 报错，会话从此发不出去。护栏只截 wire 副本（入参不动）、且确定性
      // （同输入同字节，降级后前缀仍稳定，不会每轮碎缓存）。
      // 未配置 maxBodyBytes 时不启用（不量体、零额外成本）；上游报错文案会引导配置。
      const policy = deepSeekBudgetPolicy(this.config.baseUrl, String(effectiveBody.model), this.config.contextWindow)
      let wireBudget: ContextBudgetSnapshot | undefined
      if (policy) {
        const budget = buildContextBudget({
          model: String(effectiveBody.model), messages: effectiveBody.messages as OaiMessage[],
          tools: effectiveBody.tools as OaiChatRequest['tools'],
          max_tokens: Number(effectiveBody.max_tokens ?? effectiveBody.max_completion_tokens ?? this.config.maxTokens),
        }, policy, preparedBudget ?? { requestId: crypto.randomUUID(), revision: 0 })
        wireBudget = budget
        callbacks.onContextBudget?.(budget)
        const imageError = deepSeekImageLimitError(effectiveBody.messages as OaiMessage[])
        if (imageError) { callbacks.onContextBudget?.({ ...budget, state: 'blocked' }); throw imageError }
        assertContextBudget(budget)
      }
      let guard: ReturnType<typeof enforceRequestBodyLimit>
      try { guard = enforceRequestBodyLimit(effectiveBody, {
        limitBytes: policy ? Math.min(this.config.maxBodyBytes ?? DEEPSEEK_BODY_LIMIT, DEEPSEEK_BODY_LIMIT) : this.config.maxBodyBytes,
        preserveContent: !!policy,
      }) } catch (error) {
        if (wireBudget) callbacks.onContextBudget?.({ ...wireBudget, state: 'blocked', bodyBytes: (error as { bytes?: number }).bytes })
        throw error
      }
      if (wireBudget) callbacks.onContextBudget?.({ ...wireBudget, bodyBytes: guard.bytes })
      // 降级/逼近上限必须可见（同 issue #94 的剥图教训：wire 层降级静默 = 用户读成
      // 「模型变笨了」）。节流规则（降级集合变化才报一次、逼近上限每会话一次）在
      // notifyBodyGuard 里与 anthropic 侧共用一份。
      notifyBodyGuard(guard, this.bodyGuardNotify, callbacks.onBodyGuard)
      const lifecycle = new AbortController()
      if (signal) {
        if (signal.aborted) lifecycle.abort()
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
      }
      // 客户端限速（未配置 rateLimit 时零开销）：同 provider 的所有 client 实例共享一只桶。
      await acquireRateLimitSlot(this.config.providerName ?? this.config.baseUrl, this.config.retry?.rateLimit, lifecycle.signal)
      const proof = proveWirePrefix(guard.body, this.config.providerName ?? 'openai', requestId, normalizeBaseUrl(this.config.baseUrl))
      identity.wire = wireObservation(guard.body, proof, diagnostics, this.mainPrefixProof)
      if (diagnostics?.continuationSource) {
        try {
          const baseline = assertContinuationPrefix(diagnostics.priorPrefix, proof)
          identity.wire.baseline = baseline
          identity.wire.comparison = baseline === 'present' ? 'preserved' : baseline
        } catch (error) { identity.wire.comparison = 'fork'; throw error }
      }
      if (prefixProbe) this.mainPrefixProof = proof
      if (prefixProbe) {
        const messages = guard.body.messages as Array<Record<string, unknown>>
        this.recordWireDivergence(messages, guard.body.tools as unknown[] | undefined)
        identity.prefix = {
          system: wireHash(JSON.stringify(messages.filter(m => m.role === 'system'))),
          tools: wireHash(stableStringify(guard.body.tools ?? [])),
          history: wireHash(JSON.stringify(messages.filter(m => m.role !== 'system'))),
          chars: JSON.stringify(messages).length, messages: messages.length,
          changed: this.lastWireDivergence !== null, firstChange: this.lastWireDivergence?.idx,
        }
      }
      let parserStarted = false
      const sentAt = Date.now()
      const audit = beginCallAudit({ requestId, attemptId: identity.attemptId, sessionId: this.config.sessionId,
        provider: this.config.providerName ?? 'openai', model: String(guard.body.model), purpose: diagnostics?.purpose ?? (this.config.sessionId?.startsWith('worker-') ? 'worker_execution' : 'main_execution'),
        workOrderId: diagnostics?.workOrderId, routeReason: diagnostics?.routeReason, parentRequestId: diagnostics?.parentRequestId ?? diagnostics?.previousMainRequestId,
        configFingerprint: auditConfigFingerprint(identity.wire?.options) })
      const observedCallbacks: StreamCallbacks = { ...callbacks,
        onStopReason: (reason, usage) => { audit.finish({ status: 'complete', responseId: identity.responseId, responseModel: identity.responseModel, systemFingerprint: identity.systemFingerprint, finishReason: identity.finishReason ?? reason, usage: observedAuditUsage(usage) }); callbacks.onStopReason?.(reason, usage) },
        onStreamAttemptAborted: info => { audit.finish({ status: 'aborted', responseId: identity.responseId, errorName: info.errorName, usage: observedAuditUsage(info.usage) }); callbacks.onStreamAttemptAborted?.(info) },
      }
      try {
      const response = await fetchWithTimeout(`${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
          ...(this.config.userAgent ? { 'User-Agent': this.config.userAgent } : {}),
          ...authHeaders,
          ...(this.config.sessionId
            ? { [this.config.sessionHeader ?? 'X-Request-Session']: this.config.sessionId }
            : {}),
        },
        body: guard.serializedBody ?? JSON.stringify(guard.body),
        signal: lifecycle.signal,
      }, fetchTimeout, this.proxyDispatcher)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(parseOpenAIError(response.status, errorBody, { providerName: this.config.providerName, baseUrl: this.config.baseUrl, apiKeyEnv: this.config.apiKeyEnv })),
          {
            status: response.status,
            // 413 的两种成因（图片过重 / 上下文超限）在 wire 层同形，分类器无法
            // 自行区分——只有这里知道刚发出去的体里有没有图。标在错误上让分类器
            // 分流：无图 = 纯上下文超限，重发同一个体必然再 413，不该重试。
            ...(response.status === 413
              ? { payloadHadImages: oaiMessagesHaveImageParts((effectiveBody.messages as OaiMessage[]) ?? []) }
              : {}),
          },
        )
        // Attach parsed retry-after for the error classifier to use
        if (policy && response.status === 413) {
          err.name = 'RequestBodyTooLargeError'
          err.message = '服务拒收请求体（413）。原历史和图片已保留，请减少附件或整理上下文后重试。'
        } else if (policy && classifyApiError(err).category === 'image_strip') err.name = 'ImageInputRejectedError'
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) {
          const retryAfterMs = parseRetryAfterMs(retryAfter)
          if (retryAfterMs !== undefined) {
            ;(err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs
          }
        }
        throw err
      }

      // Content-type gate: a 200 that is NOT an SSE stream means the endpoint
      // answered something else entirely — usually a JSON error page (wrong
      // path / missing /v1 suffix) or an HTML gateway. Fail fast with an
      // actionable hint instead of feeding HTML to the SSE parser.
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType && !contentType.includes('event-stream') && !contentType.includes('octet-stream')) {
        const snippet = await response.text().catch(() => '')
        throw Object.assign(
          new Error(
            `端点返回 200 但 content-type 是 ${contentType}（不是 SSE 流）——端点可能不支持流式，或路径错误（baseUrl 是否缺 /v1？）。baseUrl=${this.config.baseUrl}。响应片段：${snippet.slice(0, 200)}`,
          ),
          { status: 200, nonSse: true },
        )
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is not readable')

      parserStarted = true
      await this.parseStreamFromReader(reader, observedCallbacks, signal, reasoningRef, lifecycle, firstByteMs, identity, !!((body.tools as unknown[] | undefined)?.length))
      audit.finish({ status: 'complete', responseId: identity.responseId, responseModel: identity.responseModel, systemFingerprint: identity.systemFingerprint, finishReason: identity.finishReason })
      } catch (error) {
        audit.finish({ status: lifecycle.signal.aborted ? 'aborted' : 'failed', responseId: identity.responseId, errorName: (error as Error).name })
        if (!parserStarted) callbacks.onStreamAttemptAborted?.({
          ...identity, provider: this.config.providerName ?? 'openai', receivedChars: 0,
          elapsedMs: Date.now() - sentAt, errorName: (error as Error).name, errorMessage: (error as Error).message,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            observation: { ...identity, status: 'aborted', fields: {} } },
        })
        throw error
      } finally { lifecycle.abort() }
    }, signal, {
      budget: this.config.retryBudget?.(),
      maxTotalDurationMs: this.config.retry?.maxTotalDurationMs
        ?? (this.config.providerName === 'glm' ? 20 * 60_000 : 10 * 60_000),
      // Thinking retries are normally throttled to 1 because re-reasoning is costly.
      // 例外：slow-thinking providers 在被中止的那次尝试里已把整个 prompt 灌进服务端
      // 前缀缓存，重试命中近 100% 缓存（实测 deepseek 99.4% hit、~12s 完成），代价极低。
      // 给它们 2 次重试，让「单次服务端 thinking 卡死」甚至「连续两次卡死」都能自愈而
      // 不冒泡成错误。maxTotalDurationMs 仍是总时长兜底，防 runaway。
      // An explicit provider maxRetries overrides the built-in thinking budget (0 disables retries).
      maxTotalRetries: this.config.maxRetries ?? (isThinking
        ? (this.isSlowThinking ? 2 : 1)
        : undefined),
      policy: this.config.retry,
      onRetry: (info) => {
        if (info.classified.category === 'rate_limit') {
          callbacks.onRateLimit?.(info.classified.retryDelayMs)
        }
        // image_strip 分类 = 上一次失败被判定为图片负载问题：下一次 attempt
        // 剥掉 image_url 再发（剥离点见 fn 内的 wireMessages）。分类器只在
        // 「请求体带图」时才给这个类别，所以这里不必再判有无图可剥。
        if (info.classified.category === 'image_strip') {
          stripRequested = true
        }
        // reasoning_echo 分类 = 网关要求回传 reasoning_content：下一次 attempt
        // 用保留思考内容的历史重发（重建点见 fn 内的 wireMessages）。
        if (info.classified.category === 'reasoning_echo') {
          preserveReasoningRequested = true
        }
        // reasoning_repetition 分类 = 上一次尝试的思考退化成复读：下一次 attempt
        // 丢掉那段退化推理、尾部附纠正指令重发（补丁点见 fn 内的 wireMessages）。
        // 只在这里置位——分类器给这个类别带的就是「一次性」语义（maxRetries 1）。
        if (info.classified.category === 'reasoning_repetition') {
          repeatCorrectionRequested = true
        }
        // 重试可见性（dsh 式）：429/503 的退避可持续 10-20 分钟（maxTotalDurationMs
        // 预算），此前零事件——用户看到的是「卡住」。仅 rate_limit/overloaded 两类
        // （其余类别有一次性专属通道：image-stripped / reasoning-echo / 剥图），
        // 第 1 次与之后每 3 次发一次防轰炸；瞬态相位，不进历史。
        if (
          (info.classified.category === 'rate_limit' || info.classified.category === 'overloaded')
          && (info.attempt === 1 || (info.attempt - 1) % 3 === 0)
        ) {
          callbacks.onRetryNotice?.({
            category: info.classified.category,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            nextDelayMs: info.nextDelayMs,
          })
        }
      },
    })

    // 自愈成功 → 把「该端点需要回传思考内容」粘到实例上（本实例 = 该 provider +
    // 模型），后续轮次不再白吃一次 400 + 重试。只在**成功之后**落：重试同样失败
    // 时保持剥离语义，不把未经证实的假设固化。
    //
    // 已派发过的历史数组不受粘性影响（mapWireMessages 的 suppressStickyPreserve）：
    // 那些数组再次派发必须字节一致，否则撞 request invariant 硬门禁。生产里每轮
    // 都是新数组，所以粘性对「下一轮」照常生效。
    //
    // 注意 systemSuffix 不跟着翻转：它在构造期按 preservedThinkingProtocol 拼进
    // system，中途追加会改前缀字节（缓存断点）。保守做法＝本轮起只改历史里的
    // reasoning_content，system 保持字节稳定。
    if (preserveReasoningRequested && !this.config.preservedThinkingProtocol) {
      this.config = { ...this.config, preservedThinkingProtocol: true }
      debugLog('[openai-client] reasoning_echo 自愈：已为该 provider 打开 preservedThinkingProtocol（后续轮次不再重试）')
    }
  }

  /** Parse SSE stream from a reader — exposed for testing */
  async parseStreamFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onThinkingDelta' | 'onContentBlock' | 'onStopReason' | 'onStreamAttemptAborted'>>,
    signal?: AbortSignal,
    reasoningRef?: { content: string },
    /**
     * 传给 fetch 的共享 lifecycle controller。任何退出路径（正常结束 / idle 或硬顶
     * 超时 / 错误 / 用户 abort）都会在 finally 中 abort 它，确保 keep-alive 下
     * reader.cancel() 拆不掉的连接被 fetch 侧 abort 真正拆除。
     */
    lifecycle?: AbortController,
    /**
     * Size-scaled first-byte (pre-first-chunk) timeout (ms). When provided,
     * overrides the derived first-byte value in resetIdleTimer. Direct test
     * callers may omit it to keep the legacy derived behavior.
     */
    firstByteTimeoutMs?: number,
    identity: Omit<NonNullable<Usage['observation']>, 'status' | 'fields'> = { requestId: crypto.randomUUID(), attemptId: crypto.randomUUID() },
    /** 本请求是否声明了 tools——DSML 兜底的开关（默认 true，保持测试直调语义）。 */
    toolsDeclared = true,
  ): Promise<void> {
    const settlement = new UsageSettlement()
    const settledUsage = (status: 'complete' | 'aborted') => {
      const usage = settlement.finish(identity, status)
      if (!usage) return undefined
      const calibrated = this.calibrateUsage({ input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        reasoning_tokens: usage.reasoning_tokens })
      return { ...calibrated, observation: usage.observation }
    }
    const decoder = new TextDecoder()
    let buffer = ''
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false
    /** 本次 idle timer 实际生效的超时（ms），供触发时输出准确文案。 */
    let lastIdleTimeoutMs = 0
    /** 本次 idle timer 是否以"thinking-stall"（短于 read）名义触发。 */
    let lastFiredAsThinkingStall = false
    /** Whether any reasoning_content has been received — used to detect thinking stalls. */
    let receivedThinking = false
    // GLM-5.1 mandatory thinking mode outputs everything as reasoning_content
    // with no content field. Accumulate reasoning to promote if no content arrives.
    let reasoningAccum = ''
    let textReceived = false
    let promotionFired = false
    let toolProgressReceived = false
    const repetitionGuard = this.config.providerName === 'deepseek'
      ? new ReasoningRepetitionGuard() : undefined
    const processPayload = (payload: string): void => {
      let parsed: Parameters<OpenAIClient['processDelta']>[0]
      try { parsed = JSON.parse(payload) } catch { return }
      if (!parsed || typeof parsed !== 'object') return
      const metadata = parsed as typeof parsed & { id?: string; model?: string; system_fingerprint?: string }
      if (metadata.id) identity.responseId = metadata.id
      if (metadata.model) identity.responseModel = metadata.model
      if (metadata.system_fingerprint) identity.systemFingerprint = metadata.system_fingerprint
      if (parsed.choices?.[0]?.finish_reason) identity.finishReason = parsed.choices[0].finish_reason
      const delta = parsed?.choices?.[0]?.delta
      if (parsed.choices?.[0] && !delta && !parsed.choices[0].finish_reason && !parsed.usage) return
      // Completed calls leave toolCallBuffer when flushed. Progress remains
      // monotonic for this attempt, even if reasoning arrives after finish_reason.
      if (delta?.tool_calls?.length) toolProgressReceived = true
      // Match processDelta's channel ordering, including reasoning and content
      // arriving in the same event. Only JSON decoding errors are recoverable;
      // guard and consumer errors must reach stream cleanup and retry policy.
      if (delta?.reasoning_content && !textReceived) {
        reasoningAccum += delta.reasoning_content
        receivedThinking = true
        if (reasoningRef) reasoningRef.content = reasoningAccum
        if (!delta.content && !toolProgressReceived && this.toolCallBuffer.size === 0) {
          repetitionGuard?.push(delta.reasoning_content)
        }
      }
      settlement.observe(parsed.usage, parsed.choices?.[0]?.finish_reason)
      // processDelta remains a chunk decoder; only the attempt owner settles.
      this.processDelta(parsed, { ...callbacks, onStopReason: () => {} })
      if (delta?.content) textReceived = true
    }

    // Create an internal timeout AbortSignal for hard timeout guarantee.
    // This ensures reader.read() is unblocked even if reader.cancel() alone
    // cannot break the TCP connection (e.g. GLM server keeps connection alive).
    //
    // Track 4 自适应硬顶：固定 10min 会误杀 1M+max-reasoning 的健康长输出
    // （死流早被 idle/stall 计时器拦截，硬顶杀掉的只能是仍在产出的流）。
    // 改为按输出进度续期：到达基础硬顶时若最近 30s 内仍有 data 事件，
    // 续 60s 一档，绝对上限 3×基础（30min）兜底 runaway。
    const timeoutController = new AbortController()
    const isGlm = this.config.providerName === 'glm'
    // provider 级 requestTimeoutMs：显式配置 = 严格总时限（不做按进度续期——
    // 续期机制只服务于内置默认，避免用户设了 5min 却被续到 15min）。
    const explicitRequestTimeoutMs = this.config.requestTimeoutMs
    const baseStreamMs = explicitRequestTimeoutMs ?? (isGlm ? 20 * 60_000 : 10 * 60_000)
    const streamStartedAt = Date.now()
    let lastDataEventAt = streamStartedAt
    let hardCapExtended = false
    const progressWindowMs = isGlm ? GLM_HARD_CAP_PROGRESS_WINDOW_MS : HARD_CAP_PROGRESS_WINDOW_MS
    const checkHardCap = (): void => {
      const action = decideStreamHardCap({
        now: Date.now(),
        startedAt: streamStartedAt,
        lastDataEventAt,
        baseStreamMs,
      }, progressWindowMs)
      if (action.kind === 'abort') {
        timeoutController.abort()
        return
      }
      if (action.extended) hardCapExtended = true
      maxStreamTimer = setTimeout(checkHardCap, action.rearmMs)
    }
    let maxStreamTimer: ReturnType<typeof setTimeout> = explicitRequestTimeoutMs !== undefined
      ? setTimeout(() => timeoutController.abort(), explicitRequestTimeoutMs)
      : setTimeout(checkHardCap, baseStreamMs)

    // Wire both external and timeout signals to reader.cancel() so that
    // either agent.abort() OR the hard timeout can interrupt blocking read().
    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const isReasoning = this.config.thinking === 'enabled'
      const isSlowProvider = this.isSlowThinking
      // Prefer the size-scaled first-byte budget computed by sendStream (B);
      // fall back to the derived value for direct callers (tests) that omit it.
      const firstByteMs = firstByteTimeoutMs ?? (isSlowProvider ? SLOW_FIRST_BYTE_TIMEOUT_MS
        : isReasoning ? REASONING_FIRST_BYTE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS)
      const isGlm = this.config.providerName === 'glm'
      const readMs = isGlm && isReasoning ? GLM_READ_TIMEOUT_MS
        : isSlowProvider ? SLOW_READ_TIMEOUT_MS
        : isReasoning ? REASONING_READ_TIMEOUT_MS : READ_TIMEOUT_MS
      // Thinking-stall detection: once thinking tokens have arrived but no text
      // content yet, use a (configurable) shorter timeout to catch stalled thinking
      // streams. If the provider has already sent a complete content block (for
      // example a tool_use) but no text delta, do not treat the stream as
      // thinking-only: some APIs finalize tool calls without any text content.
      // 默认 thinkingStallTimeoutMs 未配置 → 取 readMs（等于禁用，不提前触发），
      // 保留对深思模型不误杀的既有行为；显式配置可对易卡死 provider 开启更早 stall。
      const hasActionableBlock = this.toolCallBuffer.size > 0 || this._textAccum.length > 0
      const inThinkingOnly = receivedThinking && !textReceived && !hasActionableBlock
      const thinkingStallMs = inThinkingOnly
        ? Math.min(this.config.thinkingStallTimeoutMs ?? readMs, readMs)
        : null
      const timeout = receivedFirstChunk
        ? (thinkingStallMs ?? readMs)
        : firstByteMs
      // 记录本次实际生效的超时，供 idle 触发时输出准确文案（不再硬编码"90s"）。
      lastIdleTimeoutMs = timeout
      lastFiredAsThinkingStall = thinkingStallMs !== null && thinkingStallMs < readMs
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, timeout)
    }

    try {
      resetIdleTimer()
      let streamDone = false
      let doneMarkerReceived = false
      // 硬顶 abort 可能发生在 reader.read() 阻塞期间——cancel() 让 read() 以
      // done=true 返回，若不在此显式抛出会变成"静默正常结束"，严格时限形同虚设。
      const throwIfHardCapAborted = (): void => {
        if (!timeoutController.signal.aborted) return
        const mins = Math.round((Date.now() - streamStartedAt) / 60_000)
        throw new Error(explicitRequestTimeoutMs !== undefined
          ? `OpenAI SSE stream request timeout (${Math.round(explicitRequestTimeoutMs / 1000)}s, provider requestTimeoutMs) — total request duration exceeded configured limit`
          : hardCapExtended
            ? `OpenAI SSE stream hard timeout (~${mins}min, progress-extended) — stream exceeded maximum duration`
            : 'OpenAI SSE stream hard timeout (10min) — stream stopped progressing')
      }
      while (!streamDone) {
        // Check both external signal and internal timeout signal.
        // External signal: agent.abort() / worker budget / Ctrl+C
        // Timeout signal: hard 10min ceiling on stream duration
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        throwIfHardCapAborted()

        const { done, value } = await reader.read()
        // Check user cancellation BEFORE trusting done=true: aborting the signal
        // calls reader.cancel(), so the blocked read resolves with done=true.
        // Without this re-check the attempt fell through to the success path and
        // emitted `complete` despite the user pressing abort.
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        // Check timeout AFTER read — reader.cancel() from idle timer causes
        // read() to return done=true, but we must throw, not silently break.
        if (streamTimedOut) {
          const secs = Math.round(lastIdleTimeoutMs / 1000)
          const msg = lastFiredAsThinkingStall
            ? `OpenAI SSE stream thinking stall timeout (${secs}s) — model stopped producing thinking tokens`
            : `OpenAI SSE stream idle timeout (${secs}s)`
          throw new Error(msg)
        }
        if (done) {
          throwIfHardCapAborted()
          break
        }

        receivedFirstChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        // keepalive 感知：只有解析出真正的 `data:` 事件才算"进展"并重置 idle timer。
        // 服务端心跳是 `:` 注释行 / 空行（被下面 startsWith('data:') 过滤掉），
        // 若按任意字节重置（旧行为），纯心跳流会让 stall 检测失效、最坏拖到 10min 硬顶。
        let sawDataEvent = false
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const payload = trimmed.slice(5).trimStart()
          if (payload === '[DONE]') { doneMarkerReceived = true; streamDone = true; break }
          sawDataEvent = true

          if (process.env.RIVET_DEBUG_RAW_SSE) this.dumpRawSse(payload)

          processPayload(payload)
        }
        // 仅在收到真实内容事件时重置 idle timer（心跳不重置）
        if (sawDataEvent) {
          lastDataEventAt = Date.now()
          resetIdleTimer()
        }
      }

      // Process any residual data in the SSE buffer (final chunk without trailing newline)
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trimStart()
        if (payload === '[DONE]') doneMarkerReceived = true
        else processPayload(payload)
      }

      // Re-check after the stream loop: user abort may have resolved the final
      // read/done path, and hard-cap abort can land between reads as well.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      throwIfHardCapAborted()
      // A missing terminal marker means the socket/stream ended mid-flight
      // (proxy idle close, connection reset, provider bug). Settling this as
      // `complete` loses the abort breadcrumb and lets a partial turn pass as a
      // finished answer. `error-classifier` maps it to stream_parse so retry and
      // FallbackStreamClient provider switching both apply.
      if (!doneMarkerReceived) throw new IncompleteStreamError()

      this.flushToolCalls(callbacks, { final: true })
      // 网#1: DeepSeek tool-JSON-in-content fallback
      let textConsumedAsToolJson = false
      if (this.toolCallBuffer.size === 0 && this._textAccum && this.config.capabilities?.hasToolJsonInContentBug) {
        textConsumedAsToolJson = this.tryParseToolJsonFromContent(this._textAccum, callbacks) > 0
      }

      // 网#2: DSML 标记文本形态兜底（实现/抓样见 dsml-tool-calls.ts；只对声明了 tools 的请求开）
      const dsmlRemainingText = !textConsumedAsToolJson && toolsDeclared && this.toolCallBuffer.size === 0 && this._textAccum
        ? recoverDsmlToolCallsFromContent(this._textAccum, b => callbacks.onContentBlock?.(b))
        : null

      // Emit thinking content block so reasoning_content can be passed back
      // in subsequent requests. Mimo, MiniMax, and other OpenAI-compatible
      // providers that return reasoning_content require it to be echoed.
      if (reasoningAccum) {
        callbacks.onContentBlock?.({ type: 'thinking', thinking: reasoningAccum })
      }

      // GLM-5.1 mandatory thinking: if only reasoning_content arrived (no content),
      // promote reasoning to visible text so the TUI shows a reply.
      // ONLY promote for GLM — MiMo/DeepSeek properly separate reasoning from
      // content. When MiMo sends a tool-call turn (reasoning_content + tool_calls
      // but no content), promoting would leak thinking into visible text.
      if (!textReceived && reasoningAccum && this.config.providerName === 'glm') {
        callbacks.onTextDelta?.(reasoningAccum)
        promotionFired = true
      }

      // Persist final text only on successful completion, never during retries.
      const visibleText = stripThinkTags(dsmlRemainingText ?? this._textAccum)
      const finalText = !textConsumedAsToolJson && visibleText
        ? visibleText
        : promotionFired ? reasoningAccum : ''
      if (finalText) {
        callbacks.onContentBlock?.({ type: 'text', text: finalText })
      }
      this._textAccum = ''
      this.thinkHold = ''
      this.contentStarted = false

      const usage = settledUsage('complete')
      if (usage && (settlement.reason || Object.keys(usage.observation!.fields).length)) {
        callbacks.onStopReason?.(mapFinishReason(settlement.reason ?? 'stop'), usage)
      }
      this.pendingStopReason = null
    } catch (err) {
      // Observability: surface how much streamed output this attempt discards.
      // Release the unfinished response even for direct parser callers without
      // a fetch lifecycle controller (including repetition/consumer failures).
      void reader.cancel().catch(() => {})
      callbacks.onStreamAttemptAborted?.({
        ...identity, usage: settledUsage('aborted'),
        provider: this.config.providerName ?? 'openai',
        receivedChars: reasoningAccum.length + this._textAccum.length,
        elapsedMs: Date.now() - streamStartedAt,
        errorName: (err as Error)?.name ?? 'Error',
        errorMessage: (err as Error)?.message ?? String(err),
      })
      // Body-phase TimeoutError (raw undici DOMException) → descriptive,
      // classifiable Error. User AbortError and other errors pass through.
      throw wrapBodyTimeoutError(err, 'OpenAI', streamStartedAt)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (maxStreamTimer) clearTimeout(maxStreamTimer)
      if (signalCleanup) signalCleanup()
      // 拆 fetch 连接：keep-alive 下 reader.cancel() 可能把连接还给连接池而非关闭，
      // abort 传给 fetch 的 lifecycle signal 强制 undici 销毁底层 socket。已结束的
      // 响应上 abort 为无操作，故正常结束路径安全。
      lifecycle?.abort()

      // Failed attempts are sealed by onStreamAttemptAborted. Never emit more
      // content here: it would leak into the next retry's execution/history.
    }
  }

  /**
   * Resolve which toolCallBuffer slot a streaming chunk belongs to.
   *
   * Returns the slot index, or null to DROP the chunk. Dropping is the
   * fail-safe choice when a continuation chunk carries no `index`/`id` and more
   * than one buffer is open — misgrafting it onto another tool's arguments
   * corrupts both (the parallel tool_call pollution bug). A dropped trailing
   * fragment at worst leaves one call's JSON incomplete, which the existing
   * final-flush + salvageFirstJsonObject path already handles.
   */
  private resolveToolCallIndex(tc: ToolCallChunk): number | null {
    if (tc.index !== undefined) return tc.index
    // Continuation chunk (typically a trailing-arguments delta after
    // finish_reason). Providers omit index here; reattach by identity.
    if (tc.id !== undefined) {
      for (const [idx, buf] of this.toolCallBuffer) {
        if (buf.id === tc.id) {
          this.logToolStreamEvent({
            phase: 'reattach-by-id', openBuffers: this.toolCallBuffer.size,
            id: tc.id, name: buf.function.name,
            argsLen: tc.function?.arguments?.length,
          })
          return idx
        }
      }
    }
    // No identity on the chunk: if exactly one buffer is open, it must be the
    // target (the common single-call trailing-args case). With multiple open we
    // cannot know — drop rather than guess and pollute.
    if (this.toolCallBuffer.size === 1) {
      const idx = this.toolCallBuffer.keys().next().value!
      this.logToolStreamEvent({
        phase: 'reattach-sole', openBuffers: 1,
        argsLen: tc.function?.arguments?.length,
      })
      return idx
    }
    // Fallback: preserve historical behavior for the degenerate "no buffer open
    // yet" case (a first chunk with no index) by seeding slot 0; otherwise drop.
    if (this.toolCallBuffer.size === 0) return 0
    // Ambiguous: multiple open buffers, no index/id. Dropping is the fail-safe
    // choice (one call's JSON may be incomplete) vs. the old `?? 0` which grafted
    // onto a different tool and corrupted both. Log so this provider pathology
    // is visible without RIVET_DEBUG.
    this.logToolStreamEvent({
      phase: 'drop-ambiguous', openBuffers: this.toolCallBuffer.size,
      argsLen: tc.function?.arguments?.length,
    })
    return null
  }

  /** Process a single SSE delta chunk — exposed for testing */
  processDelta(
    chunk: {
      choices?: Array<{
        delta: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<ToolCallChunk> }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }
    },
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onThinkingDelta' | 'onContentBlock' | 'onStopReason' | 'onToolCallHint' | 'onToolCallDelta'>>,
  ): void {
    const choice = chunk.choices?.[0]

    // Usage-only chunk (final chunk with include_usage)
    if (chunk.usage && choice === undefined) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason ?? 'end_turn'
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), this.calibrateUsage({
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
      }))
      return
    }

    if (!choice) return

    const delta = choice.delta

    // DeepSeek reasoning_content → thinking delta.
    // Channel monotonicity: once content has started, a later reasoning_content
    // is a protocol anomaly (desktop C→R 折叠: code block then conclusion).
    // Reclassify it as text so the final conclusion stays in the visible reply
    // instead of being folded into the thinking timeline.
    if (delta.reasoning_content) {
      if (this.contentStarted) {
        callbacks.onTextDelta?.(delta.reasoning_content)
        this._textAccum += delta.reasoning_content
      } else {
        callbacks.onThinkingDelta?.(delta.reasoning_content)
      }
    }

    if (delta.content) {
      this.contentStarted = true
      // 推理结束标签必须在实时流就挡掉：漏出去的话，用户先看到带 `</think>` 的串，
      // 回合结束时落盘 block 又是干净的——同一次回复出现两种形态。
      const filtered = filterThinkTagDelta(this.thinkHold, delta.content)
      this.thinkHold = filtered.hold
      if (filtered.out) callbacks.onTextDelta?.(filtered.out)
      // Always accumulate: the final text content block (emitted at stream end)
      // is built from this — it is what the agent loop persists into session
      // history. Without it, text-only replies were displayed but never stored,
      // and the model re-answered the previous turn on the next user message.
      this._textAccum += delta.content
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        callbacks.onToolCallDelta?.()
        // Resolve the buffer slot for this chunk. Naive `tc.index ?? 0` was the
        // root cause of cross-tool argument pollution (oh-my-pi/384919c7): when a
        // provider (DeepSeek/GLM) streams trailing argument deltas AFTER
        // finish_reason, those continuation chunks frequently omit `index`. `?? 0`
        // routed them onto index 0's buffer — a DIFFERENT tool (e.g. read_section),
        // grafting `{"path":...,"pattern":...}` onto its `{"file_path":...}`. grep
        // then received `{file_path}` or `{}` and failed "pattern is required" in a
        // tight loop, draining the reviewer worker's budget before it could emit
        // JSON. resolveToolCallIndex attaches index-less continuation chunks to the
        // correct slot by id / single-open-buffer, and drops them rather than
        // misgrafting when ambiguous (fail-safe beats fail-loud pollution).
        const idx = this.resolveToolCallIndex(tc)
        if (idx === null) continue
        const buf = this.toolCallBuffer.get(idx) ?? { function: { arguments: '' } }
        if (tc.id) buf.id = tc.id
        if (tc.type) buf.type = tc.type
        if (tc.function?.name) {
          buf.function.name = (buf.function.name ?? '') + tc.function.name
        }
        if (tc.function?.arguments) {
          buf.function.arguments += tc.function.arguments
        }
        this.toolCallBuffer.set(idx, buf)

        // Speculative prewarm: emit hint once when tool name + args are parseable
        if (callbacks.onToolCallHint && buf.function.name && !this.toolCallHintFired.has(idx)) {
          try {
            const partial = JSON.parse(buf.function.arguments)
            this.toolCallHintFired.add(idx)
            callbacks.onToolCallHint(buf.function.name, partial)
          } catch { /* args not yet complete JSON — wait for more chunks */ }
        }
      }
    }

    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      // Buffer the stop reason — will be emitted when usage chunk arrives
      this.pendingStopReason = choice.finish_reason
    }

    // If usage arrived together with finish_reason in the same SSE chunk,
    // emit onStopReason immediately with usage data. This handles providers
    // (DeepSeek) that combine finish_reason + usage into one chunk, unlike
    // OpenAI which sends usage as a separate trailing chunk.
    // Must run AFTER flushToolCalls (tool_use content blocks emitted first)
    // and AFTER pendingStopReason is set (so we can read it here).
    if (chunk.usage && this.pendingStopReason !== null) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), this.calibrateUsage({
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
      }))
    }
  }

  /**
   * Emit buffered tool_use blocks.
   *
   * Called twice per stream: once when `finish_reason` arrives (non-final) and
   * once at end-of-stream (`final: true`). On the non-final flush, entries whose
   * arguments are not yet valid JSON are LEFT in the buffer so trailing argument
   * deltas (GLM-5.2 sends them after finish_reason) can complete them before the
   * final flush. Only emitted entries are removed — the buffer is never cleared
   * wholesale, so a deferred entry survives to the final flush.
   */
  private flushToolCalls(
    callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock' | 'onStopReason'>>,
    opts: { final?: boolean } = {},
  ): void {
    const final = opts.final ?? false
    for (const [idx, buf] of this.toolCallBuffer) {
      if (!buf.id || !buf.function.name) {
        // Header (id/name) not yet seen. Can never complete on the final flush.
        if (final) this.toolCallBuffer.delete(idx)
        continue
      }
      const parsed = tryParseToolArguments(buf.function.arguments)
      if (parsed === null) {
        // Non-empty but unparseable arguments. Defer to a later flush so
        // post-finish_reason argument deltas can complete the JSON.
        if (!final) {
          this.maybeTraceToolStream('defer', idx, buf)
          continue
        }
        // Final flush and still unparseable — surface it loudly instead of
        // silently feeding {} into the tool (the misleading "X is required").
        // argsTruncated marks the block so the tool pipeline refuses to
        // EXECUTE it (running a half-received command is worse than failing:
        // session 4df36bcd executed a truncated bash call as {}). The block
        // is still emitted — the assistant message needs the tool_use so the
        // paired error tool_result keeps the history well-formed.
        this.warnToolArgParseFailure(buf)
        this.logToolStreamEvent({
          phase: 'final-flush-empty', openBuffers: this.toolCallBuffer.size,
          id: buf.id, name: buf.function.name,
          argsLen: buf.function.arguments.length,
        })
        callbacks.onContentBlock?.({ type: 'tool_use', id: buf.id, name: buf.function.name, input: {}, argsTruncated: true })
        this.toolCallBuffer.delete(idx)
        continue
      }
      this.maybeTraceToolStream(final ? 'emit-final' : 'emit', idx, buf)
      callbacks.onContentBlock?.({ type: 'tool_use', id: buf.id, name: buf.function.name, input: parsed })
      this.toolCallBuffer.delete(idx)
    }
  }

  /**
   * Append one raw SSE `data:` payload to disk for offline analysis.
   * Gated by RIVET_DEBUG_RAW_SSE: `1` → `<cwd>/.rivet/raw-sse[-<sessionId>].jsonl`,
   * any other value is treated as an explicit target file path.
   */
  private dumpRawSse(payload: string): void {
    const env = process.env.RIVET_DEBUG_RAW_SSE
    if (!env) return
    if (this.rawSsePath === undefined) {
      const target = env === '1'
        ? join(process.cwd(), '.rivet', `raw-sse${this.config.sessionId ? `-${this.config.sessionId}` : ''}.jsonl`)
        : env
      try {
        mkdirSync(dirname(target), { recursive: true })
        this.rawSsePath = target
      } catch {
        this.rawSsePath = null
      }
    }
    if (!this.rawSsePath) return
    try {
      appendFileSync(this.rawSsePath, `${JSON.stringify({ t: Date.now(), model: this.config.model, payload })}\n`)
    } catch { /* best-effort diagnostics */ }
  }

  /** Gated stream-level tool-call diagnostics (RIVET_DEBUG_TOOL_STREAM=1). */
  private maybeTraceToolStream(
    phase: string,
    idx: number,
    buf: { id?: string; function: { name?: string; arguments: string } },
  ): void {
    if (process.env.RIVET_DEBUG_TOOL_STREAM !== '1') return
    debugLog(
      `[tool-stream] phase=${phase} idx=${idx} id=${buf.id ?? '?'} name=${buf.function.name ?? '?'}` +
      ` argsLen=${buf.function.arguments.length} args=${JSON.stringify(redactSensitiveArgs(buf.function.arguments.slice(0, 200)))}`,
    )
  }

  /**
   * Append one notable tool-stream event to the always-on session log. Unlike
   * maybeTraceToolStream (gated, stderr), this writes to disk by default so the
   * cross-tool argument-pollution class of bug leaves a trace without anyone
   * having to enable RIVET_DEBUG up front. Best-effort: any IO failure disables
   * further logging for this client (sets path to null), never throws.
   *
   * Security: events carry argsLen only, NEVER raw argument content — tool
   * arguments can embed secrets (passwords/tokens passed to Bash etc.) and an
   * always-on disk log must not capture them (CWE-532). Content previews exist
   * only in the RIVET_DEBUG_TOOL_STREAM stderr path, redacted.
   *
   * Capped at TOOL_STREAM_LOG_MAX_LINES per process — once hit, logging stops to
   * bound disk on long sessions. The cap is generous: these events are rare
   * (only fire on ambiguous continuation chunks / final-flush empties), so
   * hitting the cap itself signals a provider streaming pathology worth flagging.
   */
  private logToolStreamEvent(event: {
    phase: 'drop-ambiguous' | 'reattach-by-id' | 'reattach-sole' | 'final-flush-empty'
    openBuffers?: number
    id?: string
    name?: string
    argsLen?: number
  }): void {
    if (this.toolStreamLogPath === null) return
    if (this.toolStreamLogLines >= TOOL_STREAM_LOG_MAX_LINES) return
    if (this.toolStreamLogPath === undefined) {
      try {
        const file = join(
          process.cwd(), '.rivet',
          `tool-stream${this.config.sessionId ? `-${this.config.sessionId}` : ''}.jsonl`,
        )
        mkdirSync(dirname(file), { recursive: true })
        this.toolStreamLogPath = file
      } catch {
        this.toolStreamLogPath = null
        return
      }
    }
    try {
      appendFileSync(this.toolStreamLogPath, `${JSON.stringify({
        t: new Date().toISOString(),
        model: this.config.model,
        provider: this.config.providerName ?? null,
        session: this.config.sessionId ?? null,
        ...event,
      })}\n`)
      this.toolStreamLogLines++
    } catch {
      this.toolStreamLogPath = null
    }
  }

  /** Diagnostic log when a tool call's arguments never became valid JSON.
   *
   * Kept debug-only to avoid writing directly to stderr and corrupting the TUI
   * render (the failure is already surfaced to the model/user through the
   * `argsTruncated` tool_use block + tool_result error). Offline diagnosis is
   * still available via the tool-stream JSONL event log and RIVET_DEBUG.
   */
  private warnToolArgParseFailure(
    buf: { id?: string; function: { name?: string; arguments: string } },
  ): void {
    const msg =
      `[tool-arg-parse-failure] id=${buf.id ?? '?'} name=${buf.function.name ?? '?'}` +
      ` argsLen=${buf.function.arguments.length} args=${JSON.stringify(redactSensitiveArgs(buf.function.arguments.slice(0, 300)))}`
    debugLog(msg)
  }

  /**
   * Calibrate API-reported usage for providers with inflated prompt_tokens.
   * When usageCalibrationFactor=0 (GLM coding API), replace input_tokens with
   * a local chars/4 estimate and scale cache fields proportionally.
   */
  private calibrateUsage(usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    reasoning_tokens?: number
  }): typeof usage {
    const factor = this.config.usageCalibrationFactor
    if (factor === undefined || factor >= 1) return usage
    if (factor <= 0) {
      // Complete replacement: estimate from request messages
      const estTokens = estimateRequestTokens(this.lastRequestMessages)
      const apiRatio = usage.input_tokens > 0
        ? estTokens / usage.input_tokens
        : 1
      return {
        ...usage,
        input_tokens: estTokens,
        cache_read_input_tokens: Math.round(usage.cache_read_input_tokens * apiRatio),
        cache_creation_input_tokens: Math.round(usage.cache_creation_input_tokens * apiRatio),
      }
    }
    // Partial: scale by factor
    return {
      ...usage,
      input_tokens: Math.round(usage.input_tokens * factor),
      cache_read_input_tokens: Math.round(usage.cache_read_input_tokens * factor),
      cache_creation_input_tokens: Math.round(usage.cache_creation_input_tokens * factor),
    }
  }

  /** 网#1: Parse tool JSON from accumulated text content (DeepSeek bug workaround).
   *  Returns the number of tool_use blocks emitted so the caller knows whether
   *  the text was consumed as tool calls (and must not also persist as text). */
  private tryParseToolJsonFromContent(
    text: string,
    callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock'>>,
  ): number {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 0
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const toolCalls = Array.isArray(parsed) ? parsed : [parsed]
      let emitted = 0
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue
        const obj = tc as Record<string, unknown>
        if (typeof obj.name !== 'string') continue
        const input = typeof obj.arguments === 'object' && obj.arguments !== null
          ? obj.arguments as Record<string, unknown>
          : typeof obj.arguments === 'string'
            ? (() => { try { return JSON.parse(obj.arguments as string) as Record<string, unknown> } catch { return {} } })()
            : {}
        callbacks.onContentBlock?.({ type: 'tool_use', id: `fallback_${obj.name}_${emitted}`, name: obj.name, input })
        emitted++
      }
      return emitted
    } catch { return 0 /* Not valid JSON */ }
  }

}

/**
 * Quick token estimate from request messages (chars/4 for ASCII, chars/1.5 for CJK).
 * Used for providers (GLM coding API) whose prompt_tokens is inflated.
 */
function estimateRequestTokens(messages: OaiChatRequest['messages']): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') chars += msg.content.length
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          chars += String((part as { text: string }).text).length
        }
      }
    }
    if (msg.role === 'assistant') {
      const m = msg as unknown as Record<string, unknown>
      if (typeof m.reasoning_content === 'string') chars += m.reasoning_content.length
      if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length
    }
  }
  // For a coding agent, content is mostly ASCII (code + English text).
  // chars/4 is a good baseline; CJK-heavy sessions will slightly underestimate
  // but this is far better than GLM's 20-100x overcounting.
  return Math.ceil(chars / 4)
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'insufficient_system_resource': return 'end_turn'  // DeepSeek-specific
    default: return 'end_turn'
  }
}

export { parseOpenAIError, type ApiErrorProviderContext } from './error-hints.js'
