/**
 * provider-probe — probe-first onboarding (Wave 3).
 *
 * probeProvider() verifies a candidate endpoint before anything is written to
 * config:
 *   1. GET /models              → model id list (timeout/404 degrades, not fails)
 *   2. one minimal completion   → stream liveness + capability hints
 *      (max_tokens=8, "hi")       - non-SSE 200 → "missing /v1?" guidance
 *                                 - reasoning_content in the wire → reasoningSplit hint
 *                                 - 401/403/404 → classified, actionable text
 *
 * The probe is skippable (--no-probe / UI skip): it spends a handful of the
 * user's tokens, so nothing here is mandatory.
 */

import { normalizeBaseUrl, resolveProbeEndpoints } from './endpoint-map.js'
import { providerIdentityHeaders } from './caller-identity.js'
import { type ModelAliasEntry, type ModelAliasMetadata } from './model-aliases.js'
import { matchModelId } from './model-id-matcher.js'
import { ENRICHED_ALIAS_TABLE } from './model-meta-kb.js'

/**
 * 视觉真测内置图：16×16 纯红方块（79 字节 PNG）。选探测模型是视觉档时，
 * 最小补全改为携带这张图的多模态请求——模型能正常描述即视为通过；
 * 回答文本与图片真相一并回报，由用户肉眼核对，不做字符串自动判分。
 */
export const VISION_PROBE_IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg=='
export const VISION_PROBE_GROUND_TRUTH = '一张 16×16 像素的纯红色正方形图片'
const VISION_PROBE_PROMPT = '请用一句简短的话描述这张图片的内容。'
const VISION_PROBE_MAX_TOKENS = 100

/** 别名表认定为识图/多模态的型号才走视觉真测（metadata.supportsVision）。 */
export function isVisionCapableId(rawId: string, table: readonly ModelAliasEntry[] = ENRICHED_ALIAS_TABLE): boolean {
  return matchModelId(rawId, table).entry?.metadata.supportsVision === true
}

export interface ProbeOptions {
  baseUrl: string
  apiKey?: string
  protocol?: 'openai' | 'anthropic' | 'openai-responses'
  /** Provider/preset name — selects the endpoint-path mapping (unknown → OpenAI-compatible default). */
  providerName?: string
  /** Per-request timeout. Default 15s — cold endpoints should not hang onboarding. */
  timeoutMs?: number
  /** Model for the completion probe. Defaults to the first fetched model id. */
  probeModel?: string
  /** Skip the completion probe entirely (models list only). */
  skipCompletion?: boolean
  /** 视觉探测三态（2026-09-09「测试没用」反馈）：undefined=按模型名启发（现状，
   *  ProviderRow 无视觉声明场景）；true=强制图片真测；false=压制启发按纯文本测
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
  contextWindow?: number
  maxOutputTokens?: number
  maxReasoningTokens?: number
  /** 该模型只出图（DashScope 的 `response_modality` 含 Image 而不含 Text）。
   *  issue #8 §7.2：这类模型仍保留在列表里——否则用户在自己的模型列表里看不到它，
   *  就无法在生图槽里选中。由消费方按此标记决定是否从 chat 选择器中隐藏。 */
  supportsImageGen?: boolean
}

export interface ProbeReport {
  models: string[]
  /** GET /models returned a usable list. */
  modelsOk: boolean
  /** 结构化 models 拉取错误——适配层（桌面 test-key）按 code 映射前端 i18n 键
   *  （auth-failed/timeout/network-error/quota/http-<status>）。CLI 仍消费 errors
   *  字符串，本字段是增量，不替代。 */
  modelListError?: { code: string; status?: number; message: string }
  /** The minimal completion succeeded. */
  completionOk: boolean
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

function anthropicHeaders(apiKey?: string, identity: Record<string, string> = {}): Record<string, string> {
  return { ...(apiKey ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {}), ...identity }
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
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
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
function modelListErrorCode(status: number, bodyText: string): string {
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
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
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
}

async function fetchModelList(options: ProbeOptions, errors: string[]): Promise<FetchedModelList> {
  const anthropic = options.protocol === 'anthropic'
  // DashScope：优先原生形态（带规格元数据），失败回退 OpenAI 兼容形状。
  if (!anthropic && options.providerName === 'dashscope') {
    const native = await fetchDashscopeNativeModels(options)
    if (native) return { ids: native.ids, infos: Object.keys(native.infos).length > 0 ? native.infos : undefined }
  }
  const url = anthropic
    ? `${normalizeBaseUrl(options.baseUrl)}/v1/models`
    : resolveProbeEndpoints(options.baseUrl, options.providerName).modelsUrl
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'GET',
      headers: anthropic
        ? anthropicHeaders(options.apiKey, probeIdentityHeaders(options))
        : authHeaders(options.apiKey, probeIdentityHeaders(options)),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      const message = classifyHttpError(response.status, bodyText, options.baseUrl)
      errors.push(`GET /models failed: ${message}`)
      return { ids: [], modelListError: { code: modelListErrorCode(response.status, bodyText), status: response.status, message } }
    }
    const payload = await response.json() as unknown
    const ids = parseModelIds(payload)
    if (ids.length === 0) errors.push('GET /models returned no usable model ids.')
    return { ids }
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
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return { ok: false, hints: {}, latencyMs, error: classifyHttpError(response.status, bodyText, options.baseUrl) }
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
        error: 'Vision probe returned an SSE stream but no answer text — image understanding was not demonstrated.',
      }
    }
    return { ok: true, hints, latencyMs, answer }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason }
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
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return { ok: false, hints: {}, latencyMs, error: classifyHttpError(response.status, bodyText, options.baseUrl) }
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
        error: 'Vision probe returned an SSE stream but no answer text — image understanding was not demonstrated.',
      }
    }
    return { ok: true, hints: {}, latencyMs, answer }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason }
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
        ...(options.apiKey ? { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' } : {}),
        ...probeIdentityHeaders(options),
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return { ok: false, hints: {}, latencyMs, error: classifyHttpError(response.status, bodyText, options.baseUrl) }
    }
    const bodyText = await readCappedText(response)
    const hints: CapabilityHints = {}
    if (bodyText.includes('thinking')) hints.reasoningSplit = true
    return { ok: true, hints, latencyMs }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason }
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
  const errors: string[] = []
  const fetched = await fetchModelList(options, errors)
  const models = fetched.ids

  const report: ProbeReport = {
    models,
    modelsOk: models.length > 0,
    completionOk: false,
    hints: {},
    errors,
    ...(fetched.modelListError ? { modelListError: fetched.modelListError } : {}),
    ...(fetched.infos ? { modelInfos: fetched.infos } : {}),
  }

  if (options.skipCompletion) return report
  // 型号选取：建议型号在列表中存在则优先；建议型号是视觉档但端点没有它时
  // （聚合站命名各异），优先挑别名表认识的识图/多模态型号——盲取 models[0]
  // 容易撞上 embedding/TTS 或未开通的型号导致误报失败；其余情况回退首个发现。
  // vision 三态（见 ProbeOptions.vision）：显式 false 压制名字启发，显式 true
  // 强制图片真测。
  const nameHeuristicVision = !!options.probeModel && isVisionCapableId(options.probeModel)
  const wantVision = options.vision === true || (options.vision !== false && nameHeuristicVision)
  let model: string | undefined
  if (options.probeModel && models.includes(options.probeModel)) {
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

  // 视觉真测对 OpenAI 兼容与 Responses 协议生效（anthropic 探测保持纯文本最小请求）。
  const vision = wantVision && options.protocol !== 'anthropic' && isVisionCapableId(model)
  const outcome = options.protocol === 'anthropic'
    ? await probeAnthropicCompletion(options, model)
    : options.protocol === 'openai-responses'
      ? await probeResponsesCompletion(options, model, vision)
      : await probeOpenAICompletion(options, model, vision)
  report.probedModel = model
  if (vision) report.visionTested = true
  report.completionOk = outcome.ok
  report.hints = outcome.hints
  report.latencyMs = outcome.latencyMs
  // 失败不展示模型输出——只在成功时携带回答文本。
  if (outcome.ok && vision && outcome.answer) report.visionAnswer = outcome.answer
  if (outcome.error) errors.push(outcome.error)
  return report
}

/**
 * 探测元数据 → 临时别名表条目：端点自报的规格是权威的，合成条目让发现的模型
 * 直接命中匹配（带真实 contextWindow/maxTokens），不落 L4 手填。已在别名表中的
 * 条目不覆盖——preset 元数据含 pricing / effort 等人工配置，优先保留。
 */
export function aliasTableWithProbeInfos(
  infos: Record<string, ProbedModelInfo> | undefined,
  base: readonly ModelAliasEntry[] = ENRICHED_ALIAS_TABLE,
): readonly ModelAliasEntry[] {
  if (!infos || Object.keys(infos).length === 0) return base
  const known = new Set(base.map(e => e.canonicalId))
  const synthetic: ModelAliasEntry[] = []
  for (const [id, info] of Object.entries(infos)) {
    if (known.has(id)) continue
    const metadata: ModelAliasMetadata = {}
    if (info.contextWindow !== undefined) metadata.contextWindow = info.contextWindow
    if (info.maxOutputTokens !== undefined) metadata.maxTokens = info.maxOutputTokens
    // 端点声明推理 token 上限 → 思考输出走独立通道（百炼实测 reasoning_content）。
    if (info.maxReasoningTokens !== undefined) metadata.capabilities = { reasoningSplit: true }
    if (Object.keys(metadata).length === 0) continue
    synthetic.push({ canonicalId: id, aliases: [], metadata })
  }
  return synthetic.length > 0 ? [...base, ...synthetic] : base
}
