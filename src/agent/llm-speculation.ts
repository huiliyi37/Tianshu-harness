/**
 * Tier 2 LLM speculation engine (2026-05-24 P3 scout design, module B).
 *
 * During a tool-batch await window, fire a side-path LLM request that shares
 * the main session's message prefix (near-100% prefix cache hit on DeepSeek —
 * input cost ≈ 0) and asks the model to predict the next read-only tool calls.
 * Predictions feed the existing ShadowQueue speculative execution chain.
 * NOTE (2026-07-06): tool-pipeline no longer SERVES ShadowQueue results to the
 * model — the cache then had no mtime/TTL validation and served pre-edit file
 * content as a live read_file result (stale-read incident).
 * SEALED (2026-07-07): with serving cut, an opted-in engine would burn
 * side-path LLM calls for nothing — loop-factory stopped constructing it.
 * 状态更新（2026-08-07 spark v2）：当年的重启契约（ShadowQueue mtime 校验）
 * **已实现**（shadow-queue.ts + 测试），封存维持原因 = 经济性待证。观察态
 * （RIVET_SPEC_OBSERVE=1 且 llmSpeculation.enabled）下 loop-factory 重新构造
 * 本引擎：预测只入队记统计（enqueue-only），serving 仍封存；解封 serving
 * 需观察数据 + 用户确认（T5c）。缓存安全是结构性保证（见下方硬边界），
 * 不构成解封障碍。
 *
 * Hard boundaries:
 * - Never mutates the main request or its messages array (prefix safety).
 * - Read-only tools only; ShadowQueue enforces its own whitelist as a second gate.
 * - Best-effort: failures/timeouts are silently absorbed, never touch the main path.
 * - Nothing is ever injected into the prompt (pure B-arm, zero prefix-cache cost).
 */

import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { ToolPrediction } from './tool-pattern-miner.js'
import type { TelemetryRecord } from './telemetry-writer.js'

export interface LlmSpeculationConfig {
  /** Master switch. Default off — speculation is opt-in. */
  enabled: boolean
  /** Max speculative LLM calls per turn. */
  maxPerTurn: number
  /** max_tokens for the speculative completion (predictions are short JSON). */
  maxTokens: number
  /** Abort the speculative call after this many milliseconds. */
  timeoutMs: number
  /** Drop parsed predictions below this probability before enqueueing. */
  minProbability: number
  /** Only fire when the executing batch contains a slow tool (the await window
   *  must be long enough for the speculative round-trip to land in time). */
  slowToolsOnly: boolean
}

export type LlmSpeculationConfigInput = Partial<LlmSpeculationConfig> | boolean | undefined

export const DEFAULT_LLM_SPECULATION_CONFIG: LlmSpeculationConfig = {
  enabled: false,
  maxPerTurn: 3,
  maxTokens: 320,
  timeoutMs: 8_000,
  minProbability: 0.5,
  slowToolsOnly: true,
}

export function normalizeLlmSpeculationConfig(input: LlmSpeculationConfigInput): LlmSpeculationConfig {
  if (input === true) return { ...DEFAULT_LLM_SPECULATION_CONFIG, enabled: true }
  if (input === false || input === undefined) return { ...DEFAULT_LLM_SPECULATION_CONFIG }
  return {
    ...DEFAULT_LLM_SPECULATION_CONFIG,
    ...input,
    enabled: input.enabled === true,
    maxPerTurn: positiveInt(input.maxPerTurn, DEFAULT_LLM_SPECULATION_CONFIG.maxPerTurn),
    maxTokens: positiveInt(input.maxTokens, DEFAULT_LLM_SPECULATION_CONFIG.maxTokens),
    timeoutMs: positiveInt(input.timeoutMs, DEFAULT_LLM_SPECULATION_CONFIG.timeoutMs),
    minProbability: clamp01(input.minProbability, DEFAULT_LLM_SPECULATION_CONFIG.minProbability),
    slowToolsOnly: input.slowToolsOnly !== false,
  }
}

/** Tools whose execution window is long enough to hide a speculative round-trip. */
const SLOW_TOOLS = new Set([
  'bash',
  'run_tests',
  'delegate_task',
  'delegate_batch',
  'web_search',
  'council_convene',
])

/** The only tools the LLM is allowed to predict. Mirrors ShadowQueue's whitelist. */
const READ_ONLY_PREDICTION_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir'])

const MAX_PREDICTIONS_PER_CALL = 5

export interface SpeculateParams {
  /** The main turn request. Read-only — the engine must never mutate it. */
  request: OaiChatRequest
  /** Tools currently executing in the batch. */
  toolUses: ReadonlyArray<{ name: string; input: Record<string, unknown> }>
  turn: number
  /** Main loop abort signal; the speculative call also self-aborts on timeout. */
  signal?: AbortSignal
}

export interface LlmSpeculationEngineDeps {
  client: StreamClient
  config?: LlmSpeculationConfigInput
  enqueue: (predictions: ToolPrediction[]) => void
  writeTelemetry?: (record: TelemetryRecord) => void
  /** Side-path usage accounting sink (2026-07-06 cost blind spot fix):
   *  speculative calls are billed like any other request — report their usage
   *  so session totals and the cache-log reflect the real spend. */
  recordUsage?: (usage: Partial<Usage>) => void
}

export interface LlmSpeculationStats {
  fired: number
  enqueued: number
  parseFailures: number
  errors: number
}

export interface LlmSpeculationEngine {
  /** Fire-and-forget: kicks off a speculative prediction call when gates allow. */
  maybeSpeculate(params: SpeculateParams): void
  /** True while a speculative call is in flight (exposed for tests/observability). */
  inFlight(): boolean
  stats(): LlmSpeculationStats
}

/** Summarize the executing batch for the prediction instruction. */
function describeToolUses(toolUses: SpeculateParams['toolUses']): string {
  return toolUses.slice(0, 8).map(tu => {
    const target = toolTargetHint(tu.input)
    return target ? `${tu.name}(${target})` : tu.name
  }).join(', ')
}

function toolTargetHint(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'command', 'pattern']) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 120)
  }
  return ''
}

export function buildSpeculationInstruction(toolUses: SpeculateParams['toolUses']): string {
  return [
    '[speculative-prefetch] The tools currently executing are: ' + (describeToolUses(toolUses) || 'none') + '.',
    'Do NOT answer the task. Do NOT call tools. Predict which read-only lookups you will most likely need next, after these tool results arrive.',
    'Allowed tools: read_file, grep, glob, list_dir. target = file path (read_file), search pattern (grep/glob), or directory (list_dir).',
    'Output ONLY a JSON array, no prose, no markdown fences:',
    '[{"tool":"read_file","target":"src/foo.ts","probability":0.8}]',
    'At most 5 entries. Only include predictions you are confident about; an empty array [] is a valid answer.',
  ].join('\n')
}

/** Extract the first balanced JSON array from arbitrary model text. */
export function parseSpeculationPredictions(text: string, minProbability: number): ToolPrediction[] {
  const raw = extractJsonArray(text)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const predictions: ToolPrediction[] = []
  for (const item of parsed) {
    if (predictions.length >= MAX_PREDICTIONS_PER_CALL) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const tool = typeof record.tool === 'string' ? record.tool.trim() : ''
    const target = typeof record.target === 'string' ? record.target.trim() : ''
    const probability = typeof record.probability === 'number' && Number.isFinite(record.probability)
      ? record.probability
      : NaN
    if (!READ_ONLY_PREDICTION_TOOLS.has(tool)) continue
    if (!target) continue
    if (!(probability > 0 && probability <= 1)) continue
    if (probability < minProbability) continue
    predictions.push({ tool, likelyTarget: target, probability, source: 'llm' })
  }
  return predictions
}

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

export function createLlmSpeculationEngine(deps: LlmSpeculationEngineDeps): LlmSpeculationEngine {
  const config = normalizeLlmSpeculationConfig(deps.config)
  let inFlight = false
  let currentTurn = -1
  let firedThisTurn = 0
  const stats: LlmSpeculationStats = { fired: 0, enqueued: 0, parseFailures: 0, errors: 0 }

  function shouldFire(params: SpeculateParams): boolean {
    if (!config.enabled) return false
    if (inFlight) return false
    if (params.toolUses.length === 0) return false
    if (params.turn !== currentTurn) {
      currentTurn = params.turn
      firedThisTurn = 0
    }
    if (firedThisTurn >= config.maxPerTurn) return false
    if (config.slowToolsOnly && !params.toolUses.some(tu => SLOW_TOOLS.has(tu.name))) return false
    return true
  }

  async function speculate(params: SpeculateParams): Promise<void> {
    const startedAt = Date.now()
    // Prefix safety: new array + appended instruction; the original
    // request.messages is never touched, so the main turn's prefix bytes
    // are guaranteed identical. Same model + same tools ⇒ the provider-side
    // serialized prefix matches the main request and rides its cache.
    const messages: OaiMessage[] = [
      ...params.request.messages,
      { role: 'user', content: buildSpeculationInstruction(params.toolUses) },
    ]
    const request: OaiChatRequest = {
      ...params.request,
      messages,
      max_tokens: config.maxTokens,
      temperature: 0,
      tool_choice: 'none',
      stream: true,
      // The spread above would leak the main turn's `prefixProbe: true` into
      // this side-path request, poisoning the client's wire-divergence baseline
      // (the next main turn then reports a phantom wireDiverged). Side-path
      // requests must never carry the probe flag.
      prefixProbe: undefined,
      // The spread would also inherit the main turn's diagnostics; stamp the
      // side-path purpose so call-audit never bills speculation to main_execution.
      diagnostics: { purpose: 'llm_speculation' },
      ...(params.request.reasoning_effort !== undefined ? { reasoning_effort: 'low' as const } : {}),
    }

    let text = ''
    let streamError: Error | null = null
    let usage: Partial<Usage> | null = null
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
    const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal
    try {
      await deps.client.stream(request, {
        onTextDelta: d => { text += d },
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        // onStopReason can fire more than once (finish_reason frame, then the
        // usage frame) — only book the call once real token counts arrive.
        onStreamAttemptAborted: info => { if (info.usage) deps.recordUsage?.(info.usage) },
        onStopReason: (_reason, u) => {
          if (u && (u.input_tokens ?? 0) > 0) {
            usage = u
            deps.recordUsage?.(u)
          }
        },
        onError: e => { streamError = e },
      }, signal)
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err))
    }

    const usageFields = usage
      ? {
          inputTokens: (usage as Partial<Usage>).input_tokens,
          cacheReadTokens: (usage as Partial<Usage>).cache_read_input_tokens,
          outputTokens: (usage as Partial<Usage>).output_tokens,
        }
      : {}

    if (streamError && !text) {
      stats.errors++
      deps.writeTelemetry?.({
        kind: 'llm-speculation',
        turn: params.turn,
        outcome: 'error',
        latencyMs: Date.now() - startedAt,
        ...usageFields,
      })
      return
    }

    const predictions = parseSpeculationPredictions(text, config.minProbability)
    if (predictions.length === 0) {
      stats.parseFailures++
    } else {
      stats.enqueued += predictions.length
      deps.enqueue(predictions)
    }
    deps.writeTelemetry?.({
      kind: 'llm-speculation',
      turn: params.turn,
      outcome: predictions.length > 0 ? 'enqueued' : 'empty',
      parsedCount: predictions.length,
      latencyMs: Date.now() - startedAt,
      ...usageFields,
    })
  }

  return {
    maybeSpeculate(params: SpeculateParams): void {
      if (!shouldFire(params)) return
      inFlight = true
      firedThisTurn++
      stats.fired++
      void speculate(params)
        .catch(() => { stats.errors++ })
        .finally(() => { inFlight = false })
    },
    inFlight: () => inFlight,
    stats: () => ({ ...stats }),
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}
