import { observeAuditResponse } from './transport-audit.js'
/**
 * provider-probe — probe-first onboarding (Wave 3).
 *
 * probeProvider() verifies a candidate endpoint before anything is written to
 * config:
 *   1. GET /models              → model id list (timeout/404 degrades, not fails)
 *      (endpoints without a list — 火山方舟 Agent Plan /api/plan/v3 等 — skip
 *       this step entirely and are verified by the completion probe alone)
 *   2. one minimal completion   → stream liveness + capability hints
 *      (max_tokens=8, "hi")       - non-SSE 200 → "missing /v1?" guidance
 *                                 - reasoning_content in the wire → reasoningSplit hint
 *                                 - 401/403/404 → classified, actionable text
 *
 * The probe is skippable (--no-probe / UI skip): it spends a handful of the
 * user's tokens, so nothing here is mandatory.
 */

import { hasModelsListEndpoint, normalizeBaseUrl, resolveProbeEndpoints } from './endpoint-map.js'
import { resolveProviderWire } from './provider-catalog.js'
import { providerIdentityHeaders } from './caller-identity.js'
// Single source of truth for the wire-protocol union — an inline copy here
// silently rejects any protocol added to PROVIDER_PROTOCOL_VALUES, which is
// exactly how 'gemini' first broke this file's callers.
import type { ProviderProtocol } from '../config/schema.js'
import type { ModelAliasEntry } from './model-aliases.js'
import { matchModelId } from './model-id-matcher.js'
import { ENRICHED_ALIAS_TABLE } from './model-meta-kb.js'
import { beginCallAudit } from './call-audit.js'
import { randomUUID } from 'node:crypto'

/**
 * 视觉真测内置图：16×16 纯红方块（79 字节 PNG）。选探测模型是视觉档时，
 * 最小补全改为携带这张图的多模态请求——模型能正常描述即视为通过；
 * 回答文本与图片真相一并回报，由用户肉眼核对，不做字符串自动判分。
 */
export const VISION_PROBE_IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg=='
export const VISION_PROBE_GROUND_TRUTH = '一张 16×16 像素的纯红色正方形图片'
const VISION_PROBE_PROMPT = '请用一句简短的话描述这张图片的内容。'
// 思考与回答共享输出预算，100 token 可能在最终回答前耗尽。
const VISION_PROBE_MAX_TOKENS = 2048
const VISION_PROBE_EMPTY_ANSWER = 'Vision probe returned an SSE stream but no answer text. The output may have been consumed by reasoning or truncated; image understanding could not be verified. This does not establish that the model lacks vision support.'

/**
 * 别名表**认定**为识图/多模态的型号才走视觉真测（metadata.supportsVision）。
 *
 * L3 模糊命中（needsReview=true）不算「认定」——那是按 token 相似度猜的，会跨厂商串味：
 * 实测 `step-3.5-flash`（阶跃星辰，官方为纯语言模型）以 Jaccard 0.600 命中智谱
 * `glm-5.3-flash`，于是继承了它的 supportsVision 与 1M/131072，在向导里被标成
 * 「识图/多模态」并预填 1M/131K；而 `step-3.7-flash`（官方反而支持图片+视频）因为
 * 查不到落了默认值。契约见 model-id-matcher.ts:21 / :35——L1/L2 静默回填，
 * **L3 回填必须标注「推断值，请确认」**：推断值可以进可编辑的预填表单，但不能拿来做
 * 能力断言。
 */
export function isVisionCapableId(rawId: string, table: readonly ModelAliasEntry[] = ENRICHED_ALIAS_TABLE): boolean {
  const match = matchModelId(rawId, table)
  if (match.needsReview) return false
  return match.entry?.metadata.supportsVision === true
}

export interface ProbeOptions {
  baseUrl: string
  apiKey?: string
  protocol?: ProviderProtocol
  /** Provider/preset name — selects the endpoint-path mapping (unknown → OpenAI-compatible default). */
  providerName?: string
  /** Per-request timeout. Default 15s — cold endpoints should not hang onboarding. */
  timeoutMs?: number
  /** Model for the completion probe. Defaults to the first fetched model id. */
  probeModel?: string
  /** Skip the completion probe entirely (models list only). */
  skipCompletion?: boolean
  /** 端点没有 GET /models 列表（如火山方舟 Agent Plan /api/plan/v3）。缺省按
   *  providerName + baseUrl 经 hasModelsListEndpoint 判定；显式传值只用于测试。 */
  modelsListUnavailable?: boolean
  /** 视觉探测三态（2026-09-09「测试没用」反馈）：undefined=按模型名启发（现状，
   *  尚未保存模型的场景）；true=强制图片真测；false=压制启发按纯文本测
   *  （自定义 provider 未勾「支持视觉」时与用户声明一致——模型名带 vision 词
   *  但网关不支持图片时，旧启发会误报失败而实际纯文本对话可用）。 */
  vision?: boolean
}

export interface CapabilityHints {
  /** Wire carried `reasoning_content` → provider separates reasoning output. */
  reasoningSplit?: boolean
}

/** Per-model metadata surfaced by rich models endpoints (DashScope 原生形态)。 */
export interface ProbedModelInfo {
  /** Native thinking levels and default from rich OpenAI-compatible model cards. */
  effortLevels?: string[]
  defaultEffort?: string
  contextWindow?: number
  maxOutputTokens?: number
  maxReasoningTokens?: number
  /** 该模型只出图（DashScope 的 `response_modality` 含 Image 而不含 Text）。
   *  issue #8 §7.2：这类模型仍保留在列表里——否则用户在自己的模型列表里看不到它，
   *  就无法在生图槽里选中。由消费方按此标记决定是否从 chat 选择器中隐藏。 */
  supportsImageGen?: boolean
}

export interface ProbeReport {
  operationId?: string
  testedAt?: number
  models: string[]
  /** GET /models returned a usable list. */
  modelsOk: boolean
  /** 端点没有 GET /models 列表（火山方舟订阅制端点等）——models/modelsOk 恒空/false
   *  不是失败信号，连接有效性以 completionOk 为准。 */
  modelsUnavailable?: boolean
  /** 结构化 models 拉取错误——适配层（桌面 test-key）按 code 映射前端 i18n 键
   *  （auth-failed/timeout/network-error/quota/http-<status>）。CLI 仍消费 errors
   *  字符串，本字段是增量，不替代。 */
  modelListError?: { code: string; status?: number; message: string }
  /** The minimal completion succeeded. */
  completionOk: boolean
  /** 结构化补全探测错误——modelsUnavailable 的端点（跳过了 /models）只能靠这条
   *  报错误码，与 modelListError 同形状。 */
  completionError?: { code: string; status?: number; message: string }
  hints: CapabilityHints
  /** First-byte latency of the completion probe. */
  latencyMs?: number
  /** 端点自带规格元数据时按模型 id 携带——消费侧物化 contextWindow/maxTokens，跳过手填。 */
  modelInfos?: Record<string, ProbedModelInfo>
  /** 实际用于补全探测的型号（选取策略可能与建议型号不同）。 */
  probedModel?: string
  /** 补全探测携带了内置图片（所选型号为别名表认定的视觉/多模态档）。 */
  visionTested?: boolean
  /** 视觉真测时模型的描述文本——成功才携带，失败报告不展示模型输出。 */
  visionAnswer?: string
  /** Classified human-readable problems (empty when everything succeeded). */
  errors: string[]
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024

/** 连接探测的会话标识——固定值：探测不属于任何真实对话，但上游（OpenCode Go）
 *  仍要求带会话头；用常量避免每次探测都被上游当成新对话。 */
const PROBE_SESSION_ID = 'tianshu-probe'

function authHeaders(apiKey?: string, identity: Record<string, string> = {}): Record<string, string> {
  return { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...identity }
}

/** Gemini 原生协议：x-goog-api-key 头（无 Bearer）。 */
function geminiHeaders(apiKey?: string, identity: Record<string, string> = {}): Record<string, string> {
  return { ...(apiKey ? { 'x-goog-api-key': apiKey } : {}), ...identity }
}

function anthropicHeaders(apiKey?: string, identity: Record<string, string> = {}, authMode?: 'x-api-key' | 'bearer'): Record<string, string> {
  if (!apiKey) return { ...identity }
  return {
    'anthropic-version': '2023-06-01',
    ...(authMode === 'bearer' ? { authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey }),
    ...identity,
  }
}

/**
 * 探测请求也是「客户端对上游说话」，同样要带身份头——OpenCode Go 对 chat /
 * messages 端点缺 x-opencode-session 即 400，只带认证的连接测试会假失败
 * （或假通过，如果只测 /models）。探测不是某段真实对话，用固定标识而非兜底 UUID。
 */
function probeIdentityHeaders(options: ProbeOptions): Record<string, string> {
  return providerIdentityHeaders(options.providerName, options.baseUrl, PROBE_SESSION_ID)
}

async function fetchWithProbeTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  options?: ProbeOptions & { operationId?: string },
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let model: string | undefined
  try { model = typeof init.body === 'string' ? JSON.parse(init.body).model : undefined } catch { /* no body */ }
  const audit = beginCallAudit({ requestId: options?.operationId, provider: options?.providerName ?? new URL(url).hostname, model, purpose: model ? 'provider_probe' : 'provider_models' })
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return observeAuditResponse(response, {}, audit)
  } catch (error) {
    audit.finish({ status: controller.signal.aborted ? 'aborted' : 'failed', errorName: (error as Error).name })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Extract model ids from OpenAI/Anthropic /models response shapes. */
function parseModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown })?.data
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string') ids.push(item)
    else if (item && typeof (item as { id?: unknown }).id === 'string') {
      ids.push((item as { id: string }).id)
    }
  }
  return ids
}

function classifyHttpError(status: number, bodyText: string, baseUrl: string): string {
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim()
  if (/quota|FreeTierOnly|insufficient|arrearage/i.test(bodyText)) {
    return `Quota/billing problem (HTTP ${status}). The API key is valid but the account quota is exhausted or unpaid — enable paid access or top up in the provider console${snippet ? ` — server said: ${snippet}` : ''}.`
  }
  if (status === 401 || status === 403) {
    return `Authentication failed (HTTP ${status}). Check the API key${snippet ? ` — server said: ${snippet}` : ''}.`
  }
  if (status === 404) {
    return `HTTP 404 from ${baseUrl} — the endpoint path may be wrong (missing "/v1"?) or the model id does not exist. Run \`rivet provider models\` to list valid ids.`
  }
  return `HTTP ${status}${snippet ? ` — ${snippet}` : ''}`
}

/**
 * classifyHttpError 的结构化 code 投影——前端 i18n 键（connect.probeError.*）
 * 按 code 取值。分支优先级必须与 classifyHttpError 一致：quota body 判定先于
 * 401/403（FreeTierOnly 是 403 但属账单问题，不是鉴权失败）。
 */
function probeErrorCode(status: number, bodyText: string): string {
  if (/quota|FreeTierOnly|insufficient|arrearage/i.test(bodyText)) return 'quota'
  if (status === 401 || status === 403) return 'auth-failed'
  if (status === 404) return 'http-404'
  return `http-${status}`
}

/**
 * DashScope（百炼）原生模型列表形态：`{output: {models: [{model, model_info,
 * inference_metadata}]}}`——与 OpenAI 兼容形状的 `{data: [{id}]}` 完全不同，
 * 但带真实规格元数据（context_window / max_output_tokens / max_reasoning_tokens）。
 * 只保留文本产出模型（response_modality 含 Text / Multimodal），过滤图像/语音/向量。
 */
function parseDashscopeNative(payload: unknown): { ids: string[]; infos: Record<string, ProbedModelInfo>; rawCount: number } | null {
  const list = (payload as { output?: { models?: unknown } })?.output?.models
  if (!Array.isArray(list)) return null
  const ids: string[] = []
  const infos: Record<string, ProbedModelInfo> = {}
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { model?: unknown }).model
    if (typeof id !== 'string') continue
    const modalities = (item as { inference_metadata?: { response_modality?: unknown } }).inference_metadata?.response_modality
    const modalityList = Array.isArray(modalities) ? modalities : []
    const textual = modalityList.some(m => m === 'Text' || m === 'Multimodal')
    // issue #8 §7.2：生图模型（Image）不再丢弃——否则百炼用户在自己的模型列表里看不到
    // 它，也就无法在生图槽里选它。纯音频/向量这类与天枢无关的产出仍然丢弃。是否展示交给
    // 下游：chat 模型选择器按 supportsImageGen 隐藏，生图槽则据此列出。
    const generatesImages = modalityList.some(m => m === 'Image')
    if (!textual && !generatesImages) continue
    ids.push(id)
    const info: ProbedModelInfo = {}
    if (!textual && generatesImages) info.supportsImageGen = true
    const raw = (item as { model_info?: Record<string, unknown> }).model_info
    if (raw && typeof raw === 'object') {
      if (typeof raw.context_window === 'number') info.contextWindow = raw.context_window
      if (typeof raw.max_output_tokens === 'number') info.maxOutputTokens = raw.max_output_tokens
      if (typeof raw.max_reasoning_tokens === 'number') info.maxReasoningTokens = raw.max_reasoning_tokens
    }
    if (Object.keys(info).length > 0) infos[id] = info
  }
  return { ids, infos, rawCount: list.length }
}

/**
 * DashScope 原生模型列表 URL。compatible-mode base 换轨到 /api/v1（同一 workspace
 * 主机两种形态并存，实测 /api/v1/models 带元数据而 compatible-mode 只有裸 id）；
 * 已经是 /api/v1 形态则直接追加。分页上限 page_size=200（服务端拒绝更大的值）。
 */
function dashscopeNativeModelsUrl(baseUrl: string, pageNo: number): string | null {
  const base = normalizeBaseUrl(baseUrl)
  const query = `page_no=${pageNo}&page_size=${DASHSCOPE_MODELS_PAGE_SIZE}`
  if (/\/compatible-mode\/v\d+$/i.test(base)) {
    return `${base.replace(/\/compatible-mode\/v\d+$/i, '/api/v1')}/models?${query}`
  }
  if (/\/api\/v\d+$/i.test(base)) {
    return `${base}/models?${query}`
  }
  return null
}

const DASHSCOPE_MODELS_PAGE_SIZE = 200
const DASHSCOPE_MODELS_MAX_PAGES = 3

async function fetchDashscopeNativeModels(options: ProbeOptions): Promise<{ ids: string[]; infos: Record<string, ProbedModelInfo> } | null> {
  const ids: string[] = []
  const infos: Record<string, ProbedModelInfo> = {}
  for (let pageNo = 1; pageNo <= DASHSCOPE_MODELS_MAX_PAGES; pageNo++) {
    const url = dashscopeNativeModelsUrl(options.baseUrl, pageNo)
    if (!url) return null
    try {
      const response = await fetchWithProbeTimeout(url, {
        method: 'GET',
        headers: authHeaders(options.apiKey),
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options)
      if (!response.ok) return ids.length > 0 ? { ids, infos } : null
      const parsed = parseDashscopeNative(await response.json() as unknown)
      if (!parsed) return ids.length > 0 ? { ids, infos } : null
      ids.push(...parsed.ids)
      Object.assign(infos, parsed.infos)
      // 不满一页 = 已到尾页（按原始条目数判定，过滤不能影响翻页）。
      if (parsed.rawCount < DASHSCOPE_MODELS_PAGE_SIZE) break
    } catch {
      return ids.length > 0 ? { ids, infos } : null
    }
  }
  return ids.length > 0 ? { ids, infos } : null
}

interface FetchedModelList {
  ids: string[]
  infos?: Record<string, ProbedModelInfo>
  /** models 拉取失败时的结构化错误（HTTP 分支）；超时/网络错误分支不带 status。 */
  modelListError?: { code: string; status?: number; message: string }
  /** 端点没有 /models 列表（未发请求，非失败）。 */
  modelsUnavailable?: boolean
}

async function fetchModelList(options: ProbeOptions, errors: string[]): Promise<FetchedModelList> {
  const anthropic = options.protocol === 'anthropic'
  const gemini = options.protocol === 'gemini'
  const modelsUnavailable = options.modelsListUnavailable
    ?? !hasModelsListEndpoint(options.providerName, options.baseUrl)
  // 无 /models 的端点直接跳过列表拉取：404 不是 Key/连通性结论，补全探测才是。
  if (modelsUnavailable) return { ids: [], modelsUnavailable: true }
  // DashScope：优先原生形态（带规格元数据），失败回退 OpenAI 兼容形状。
  if (!anthropic && options.providerName === 'dashscope') {
    const native = await fetchDashscopeNativeModels(options)
    if (native) return { ids: native.ids, infos: Object.keys(native.infos).length > 0 ? native.infos : undefined }
  }
  // Gemini 原生：GET {base}/models（base 自带 /v1beta 版本段，resolveProbeEndpoints
  // 的 /v\d+ 版本识别不认 v1beta 会拼错路径——故走原生形状，不经过它）。
  const url = anthropic
    ? `${normalizeBaseUrl(options.baseUrl)}/v1/models`
    : gemini
      ? `${normalizeBaseUrl(options.baseUrl)}/models`
      : resolveProbeEndpoints(options.baseUrl, options.providerName).modelsUrl
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'GET',
      headers: anthropic
        ? anthropicHeaders(options.apiKey, probeIdentityHeaders(options), resolveProviderWire(options.providerName ?? '', options.baseUrl)?.anthropicAuthMode)
        : gemini
          ? geminiHeaders(options.apiKey, probeIdentityHeaders(options))
          : authHeaders(options.apiKey, probeIdentityHeaders(options)),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options)
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      const message = classifyHttpError(response.status, bodyText, options.baseUrl)
      errors.push(`GET /models failed: ${message}`)
      return { ids: [], modelListError: { code: probeErrorCode(response.status, bodyText), status: response.status, message } }
    }
    const payload = await response.json() as unknown
    // Gemini 原生列表：{ models: [{ name: 'models/<id>', inputTokenLimit, outputTokenLimit }] }
    if (gemini) {
      const entries = (payload as { models?: unknown })?.models
      const ids: string[] = []
      const infos: Record<string, ProbedModelInfo> = {}
      if (Array.isArray(entries)) for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string') continue
        const id = entry.name.replace(/^models\//, '')
        if (!id) continue
        ids.push(id)
        const e = entry as { inputTokenLimit?: unknown; outputTokenLimit?: unknown }
        const info: ProbedModelInfo = {}
        if (Number.isSafeInteger(e.inputTokenLimit) && (e.inputTokenLimit as number) > 0) info.contextWindow = e.inputTokenLimit as number
        if (Number.isSafeInteger(e.outputTokenLimit) && (e.outputTokenLimit as number) > 0) info.maxOutputTokens = e.outputTokenLimit as number
        if (Object.keys(info).length) infos[id] = info
      }
      if (ids.length === 0) errors.push('GET /models returned no usable model ids.')
      return { ids, ...(Object.keys(infos).length ? { infos } : {}) }
    }
    const ids = parseModelIds(payload)
    if (ids.length === 0) errors.push('GET /models returned no usable model ids.')
    const infos: Record<string, ProbedModelInfo> = {}
    const entries = (payload as { data?: unknown })?.data
    if (Array.isArray(entries)) for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue
      const info: ProbedModelInfo = {}
      if (Number.isSafeInteger(entry.context_window) && entry.context_window > 0) info.contextWindow = entry.context_window
      if (Number.isSafeInteger(entry.max_output_tokens) && entry.max_output_tokens > 0) info.maxOutputTokens = entry.max_output_tokens
      const levels = entry.effort?.supported_levels
      if (Array.isArray(levels) && levels.every((level: unknown) => typeof level === 'string' && level.length > 0)) {
        info.effortLevels = [...new Set<string>(levels)]
        if (info.effortLevels.includes(entry.effort.default_level)) info.defaultEffort = entry.effort.default_level
      }
      if (Object.keys(info).length) infos[entry.id] = info
    }
    return { ids, ...(Object.keys(infos).length ? { infos } : {}) }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    const code = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network-error'
    errors.push(`GET /models failed: ${reason}`)
    return { ids: [], modelListError: { code, message: reason } }
  }
}

interface CompletionProbeOutcome {
  ok: boolean
  hints: CapabilityHints
  latencyMs?: number
  error?: string
  /** 结构化错误码（与 modelListError 同枚举），供 modelsUnavailable 端点报给 UI。 */
  errorCode?: string
  errorStatus?: number
  /** 流式回答文本（视觉真测展示用；非视觉探测也会顺带提取）。 */
  answer?: string
}

/** 从 SSE 流文本中重建助手回答（delta.content 拼接；容忍 keep-alive 等非 JSON 行）。 */
function extractSseAssistantText(bodyText: string): string {
  let text = ''
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>
      }
      const piece = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content
      text += contentPieceToText(piece)
    } catch { /* 非 JSON 数据行——忽略 */ }
  }
  return text.trim()
}

/**
 * delta.content 可为字符串，也可为 content-parts 数组（OpenAI 兼容视觉端点
 * 流式返回的常见形态，如 [{type:'text',text:'…'}]）——统一还原为文本。
 */
function contentPieceToText(piece: unknown): string {
  if (typeof piece === 'string') return piece
  if (!Array.isArray(piece)) return ''
  return piece
    .filter((part): part is { type?: unknown; text?: unknown } =>
      typeof part === 'object' && part !== null)
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
}

async function probeOpenAICompletion(options: ProbeOptions, model: string, vision: boolean): Promise<CompletionProbeOutcome> {
  const url = resolveProbeEndpoints(options.baseUrl, options.providerName).chatUrl
  const startedAt = Date.now()
  // 视觉真测：多模态 content（内置图片 + 描述指令）；否则纯文本 "hi"。
  const content: unknown = vision
    ? [
        { type: 'image_url', image_url: { url: VISION_PROBE_IMAGE_DATA_URI } },
        { type: 'text', text: VISION_PROBE_PROMPT },
      ]
    : 'hi'
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(options.apiKey, probeIdentityHeaders(options)) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        // 64 而非 8：reasoning 网关（思考型/需要 max_completion_tokens 的 o 系
        // 变体）对过小 max_tokens 会 400 或把预算全吃在思考通道——用户侧
        // 「能对话但测试失败」的次生形态之一。64 token 成本仍可忽略。
        max_tokens: vision ? VISION_PROBE_MAX_TOKENS : 64,
        stream: true,
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: classifyHttpError(response.status, bodyText, options.baseUrl),
        errorCode: probeErrorCode(response.status, bodyText),
        errorStatus: response.status,
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const bodyText = await readCappedText(response)
    if (!contentType.includes('text/event-stream') && !bodyText.includes('data:')) {
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: 'Endpoint answered but not with an SSE stream — it may not support streaming, or the base URL is wrong (missing "/v1"?).',
      }
    }
    const hints: CapabilityHints = {}
    if (bodyText.includes('reasoning_content')) hints.reasoningSplit = true
    const answer = extractSseAssistantText(bodyText)
    if (vision && answer.length === 0) {
      return {
        ok: false,
        hints,
        latencyMs,
        error: VISION_PROBE_EMPTY_ANSWER,
      }
    }
    return { ok: true, hints, latencyMs, answer }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    const reason = aborted
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason, errorCode: aborted ? 'timeout' : 'network-error' }
  }
}

/** 从 Responses API 的 SSE 流文本中重建助手回答（issue #239）。
 *  事件面比 chat/completions 宽：增量走 response.output_text.delta，整段可能只在
 *  output_item.done / response.completed 里出现——两条都收，兼容只发其中一种的网关。 */
function extractResponsesSseText(bodyText: string): string {
  let text = ''
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const type = parsed.type as string | undefined
      if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        text += parsed.delta
      } else if (type === 'response.output_item.done') {
        const item = parsed.item as Record<string, unknown> | undefined
        if (item?.type === 'message') {
          for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
            if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
          }
        }
      } else if (type === 'response.completed') {
        const resp = parsed.response as Record<string, unknown> | undefined
        for (const item of (resp?.output as Array<Record<string, unknown>> | undefined) ?? []) {
          if (item.type !== 'message') continue
          for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
            if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
          }
        }
      }
    } catch { /* 非 JSON 数据行——忽略 */ }
  }
  return text.trim()
}

/** Responses 协议最小补全探测（issue #239）：POST /responses，解析 response.* 事件。
 *  与 OpenAI 探测同职：验证流式活性 + 端点真的会对话；视觉档走 input_image 真测。 */
async function probeResponsesCompletion(
  options: ProbeOptions,
  model: string,
  vision: boolean,
): Promise<CompletionProbeOutcome> {
  const url = resolveProbeEndpoints(options.baseUrl, options.providerName).responsesUrl
  const startedAt = Date.now()
  const content: unknown = vision
    ? [
        { type: 'input_image', image_url: VISION_PROBE_IMAGE_DATA_URI },
        { type: 'input_text', text: VISION_PROBE_PROMPT },
      ]
    : [{ type: 'input_text', text: 'hi' }]
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(options.apiKey, probeIdentityHeaders(options)) },
      body: JSON.stringify({
        model,
        input: [{ type: 'message', role: 'user', content }],
        // 64 同 OpenAI 探测：过小的预算会把 reasoning 型模型的输出全吃在思考通道。
        max_output_tokens: vision ? VISION_PROBE_MAX_TOKENS : 64,
        stream: true,
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: classifyHttpError(response.status, bodyText, options.baseUrl),
        errorCode: probeErrorCode(response.status, bodyText),
        errorStatus: response.status,
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const bodyText = await readCappedText(response)
    if (!contentType.includes('text/event-stream') && !bodyText.includes('data:')) {
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: 'Endpoint answered but not with an SSE stream — it may not support streaming, or the base URL is wrong (missing "/v1"?).',
      }
    }
    const answer = extractResponsesSseText(bodyText)
    if (vision && answer.length === 0) {
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: VISION_PROBE_EMPTY_ANSWER,
      }
    }
    return { ok: true, hints: {}, latencyMs, answer }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    const reason = aborted
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason, errorCode: aborted ? 'timeout' : 'network-error' }
  }
}

async function probeAnthropicCompletion(options: ProbeOptions, model: string): Promise<CompletionProbeOutcome> {
  const url = `${normalizeBaseUrl(options.baseUrl)}/v1/messages`
  const startedAt = Date.now()
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...anthropicHeaders(options.apiKey, probeIdentityHeaders(options), resolveProviderWire(options.providerName ?? '', options.baseUrl)?.anthropicAuthMode),
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: classifyHttpError(response.status, bodyText, options.baseUrl),
        errorCode: probeErrorCode(response.status, bodyText),
        errorStatus: response.status,
      }
    }
    const bodyText = await readCappedText(response)
    const hints: CapabilityHints = {}
    if (bodyText.includes('thinking')) hints.reasoningSplit = true
    return { ok: true, hints, latencyMs }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    const reason = aborted
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason, errorCode: aborted ? 'timeout' : 'network-error' }
  }
}

/**
 * Gemini 原生补全探测：POST {base}/models/{model}:generateContent（非流式）。
 * 只验证连通与鉴权——gemini 思考模型可能把输出预算吃在思考通道，故只需 200 +
 * candidates 在场，不要求文本非空。maxOutputTokens 取 64（对齐 openai 侧注释：
 * 过小预算在推理系模型上会被思考吃光）。
 */
async function probeGeminiCompletion(options: ProbeOptions, model: string): Promise<CompletionProbeOutcome> {
  const url = `${normalizeBaseUrl(options.baseUrl)}/models/${encodeURIComponent(model)}:generateContent`
  const startedAt = Date.now()
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...geminiHeaders(options.apiKey, probeIdentityHeaders(options)) },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 64 },
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: classifyHttpError(response.status, bodyText, options.baseUrl),
        errorCode: probeErrorCode(response.status, bodyText),
        errorStatus: response.status,
      }
    }
    const payload = await response.json().catch(() => null) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
      usageMetadata?: unknown
    } | null
    if (!payload || !Array.isArray(payload.candidates)) {
      return { ok: false, hints: {}, latencyMs, error: 'Endpoint answered but not with a Gemini generateContent payload — the base URL may be wrong (expected the native v1beta shape).', errorCode: 'unknown' }
    }
    const hints: CapabilityHints = {}
    const parts = payload.candidates[0]?.content?.parts ?? []
    if (parts.some(p => p.thought === true)) hints.reasoningSplit = true
    return { ok: true, hints, latencyMs }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    const reason = aborted
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason, errorCode: aborted ? 'timeout' : 'network-error' }
  }
}

async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      text += decoder.decode(value, { stream: true })
      if (text.length >= MAX_BODY_BYTES) break
    }
  }
  reader.cancel().catch(() => {})
  return text
}

export async function probeProvider(options: ProbeOptions): Promise<ProbeReport> {
  options = { ...options, operationId: randomUUID() } as ProbeOptions
  const errors: string[] = []
  const fetched = await fetchModelList(options, errors)
  const models = fetched.ids

  const report: ProbeReport = {
    operationId: (options as ProbeOptions & { operationId: string }).operationId, testedAt: Date.now(),
    models,
    modelsOk: models.length > 0,
    completionOk: false,
    hints: {},
    errors,
    ...(fetched.modelsUnavailable ? { modelsUnavailable: true } : {}),
    ...(fetched.modelListError ? { modelListError: fetched.modelListError } : {}),
    ...(fetched.infos ? { modelInfos: fetched.infos } : {}),
  }

  if (options.skipCompletion) {
    // 无 /models 端点跳过补全后就失去了唯一的连通性信号——给出可操作的指引，
    // 而不是让消费方看到「ok=false 且无任何错误文案」。
    if (report.modelsUnavailable) {
      errors.push('Endpoint exposes no GET /models list — provide a model id to run a completion probe.')
    }
    return report
  }
  // 型号选取：建议型号在列表中存在则优先；建议型号是视觉档但端点没有它时
  // （聚合站命名各异），优先挑别名表认识的识图/多模态型号——盲取 models[0]
  // 容易撞上 embedding/TTS 或未开通的型号导致误报失败；其余情况回退首个发现。
  // vision 三态（见 ProbeOptions.vision）：显式 false 压制名字启发，显式 true
  // 强制图片真测。
  const nameHeuristicVision = !!options.probeModel && isVisionCapableId(options.probeModel)
  const wantVision = options.vision === true || (options.vision !== false && nameHeuristicVision)
  let model: string | undefined
  if (options.probeModel) {
    model = options.probeModel
  } else if (wantVision) {
    model = models.find(id => isVisionCapableId(id)) ?? models[0] ?? options.probeModel
  } else {
    model = models[0] ?? options.probeModel
  }
  if (!model) {
    errors.push('Completion probe skipped: no model id available (fetch a list first or pass probeModel).')
    return report
  }

  // 视觉真测对 OpenAI 兼容与 Responses 协议生效（anthropic/gemini 探测保持纯文本最小请求——
  // gemini 原生视觉走 inlineData 形态，预设已静态声明 supportsVision，探测不做真测）。
  const vision = wantVision && options.protocol !== 'anthropic' && options.protocol !== 'gemini'
  const outcome = options.protocol === 'anthropic'
    ? await probeAnthropicCompletion(options, model)
    : options.protocol === 'openai-responses'
      ? await probeResponsesCompletion(options, model, vision)
      : options.protocol === 'gemini'
        ? await probeGeminiCompletion(options, model)
        : await probeOpenAICompletion(options, model, vision)
  report.probedModel = model
  if (vision) report.visionTested = true
  report.completionOk = outcome.ok
  report.hints = outcome.hints
  report.latencyMs = outcome.latencyMs
  // 失败不展示模型输出——只在成功时携带回答文本。
  if (outcome.ok && vision && outcome.answer) report.visionAnswer = outcome.answer
  if (outcome.error) errors.push(outcome.error)
  if (!outcome.ok && outcome.error && outcome.errorCode) {
    report.completionError = {
      code: outcome.errorCode,
      ...(outcome.errorStatus !== undefined ? { status: outcome.errorStatus } : {}),
      message: outcome.error,
    }
  }
  return report
}

export { aliasTableWithProbeInfos } from './model-probe-enrichment.js'
