import { resolveProbeEndpoints } from './endpoint-map.js'
import { providerIdentityHeaders } from './caller-identity.js'
import { matchModelId } from './model-id-matcher.js'
import { ENRICHED_ALIAS_TABLE } from './model-meta-kb.js'
import { VISION_PROBE_IMAGE_DATA_URI } from './provider-probe.js'

const DEFAULT_TIMEOUT_MS = 15_000
const VISION_MAX_TOKENS = 1024
const VISION_PROMPT = '请用一句简短的话描述这张图片的内容。'
const GLM_VISION_THINKING_MODELS = new Set([
  'glm-4.6v-flash',
  'glm-4.1v-thinking-flash',
  'glm-4v-flash',
])

export interface VisionDiscoveryOptions {
  baseUrl: string
  apiKey?: string
  providerName?: string
  timeoutMs?: number
}

export interface VisionModelCandidate {
  id: string
  label?: string
  knownVision: boolean
}

export interface VisionDiscoveryResult {
  candidates: VisionModelCandidate[]
}

export interface VisionValidationOptions extends VisionDiscoveryOptions {
  modelId: string
}

export interface VisionValidationResult {
  modelId: string
  answer: string
}

function authHeaders(apiKey?: string, identity: Record<string, string> = {}): Record<string, string> {
  return { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...identity }
}

/** 视觉校验也直发 chat/completions——同样要带出站身份头（OpenCode Go 缺
 *  x-opencode-session 即 400，视觉 onboarding 会假报"模型不支持视觉"）。 */
function visionIdentityHeaders(options: VisionDiscoveryOptions | VisionValidationOptions): Record<string, string> {
  return providerIdentityHeaders(options.providerName, options.baseUrl, VISION_PROBE_SESSION_ID)
}

const VISION_PROBE_SESSION_ID = 'tianshu-vision-probe'

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseModelIds(payload: unknown): string[] {
  const data = Array.isArray(payload) ? payload : (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of data) {
    const id = typeof item === 'string'
      ? item
      : (item && typeof (item as { id?: unknown }).id === 'string'
          ? (item as { id: string }).id
          : undefined)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function responseSnippet(text: string): string {
  return text.slice(0, 200).replace(/\s+/g, ' ').trim()
}

async function fetchVisionModelIds(options: VisionDiscoveryOptions): Promise<string[]> {
  const url = resolveProbeEndpoints(options.baseUrl, options.providerName).modelsUrl
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: authHeaders(options.apiKey, visionIdentityHeaders(options)),
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const suffix = responseSnippet(body)
    throw new Error(`GET /models failed with HTTP ${response.status}${suffix ? `: ${suffix}` : ''}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('GET /models returned malformed JSON')
  }
  const ids = parseModelIds(payload)
  if (ids.length === 0) throw new Error('GET /models returned no usable model ids')
  return ids
}

export async function discoverVisionModels(options: VisionDiscoveryOptions): Promise<VisionDiscoveryResult> {
  const ids = await fetchVisionModelIds(options)
  return {
    candidates: ids.map(id => {
      const match = matchModelId(id, ENRICHED_ALIAS_TABLE).entry
      return {
        id,
        ...(match?.canonicalId && match.canonicalId !== id ? { label: match.canonicalId } : {}),
        knownVision: match?.metadata.supportsVision === true,
      }
    }),
  }
}

function endpointHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function vendorVisionRequestExtras(baseUrl: string, modelId: string): Record<string, unknown> {
  const hostname = endpointHostname(baseUrl)
  if (hostname === 'api.agnes.ai' && /^agnes-\d+\.\d+-(?:flash|pro)$/i.test(modelId)) {
    return { chat_template_kwargs: { enable_thinking: true, budget_tokens: 2048 } }
  }
  if (hostname === 'open.bigmodel.cn' && GLM_VISION_THINKING_MODELS.has(modelId)) {
    return { thinking: { type: 'enabled' } }
  }
  return {}
}

function assistantText(payload: unknown): string {
  const content = (payload as {
    choices?: Array<{ message?: { content?: unknown } }>
  })?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => typeof part === 'object' && part !== null)
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
    .trim()
}

export async function validateVisionModel(options: VisionValidationOptions): Promise<VisionValidationResult> {
  const modelIds = await fetchVisionModelIds(options)
  if (!modelIds.includes(options.modelId)) {
    throw new Error(`Selected model "${options.modelId}" was not returned by /models`)
  }

  const url = resolveProbeEndpoints(options.baseUrl, options.providerName).chatUrl
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(options.apiKey, visionIdentityHeaders(options)) },
    body: JSON.stringify({
      model: options.modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: VISION_PROBE_IMAGE_DATA_URI } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
      max_tokens: VISION_MAX_TOKENS,
      stream: false,
      ...vendorVisionRequestExtras(options.baseUrl, options.modelId),
    }),
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const suffix = responseSnippet(body)
    throw new Error(`Vision validation failed with HTTP ${response.status}${suffix ? `: ${suffix}` : ''}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Vision validation returned malformed JSON')
  }
  const answer = assistantText(payload)
  if (!answer) throw new Error('Vision validation returned no answer text')
  return { modelId: options.modelId, answer }
}
