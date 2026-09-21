/**
 * endpoint-map — configurable probe-endpoint path mapping.
 *
 * The connectivity probe needs two URLs per provider: the model list
 * (GET …/models) and a minimal completion (POST …/chat/completions). Where
 * the "/v1" version segment lives differs per deployment:
 *   openai-style : base_url = https://api.openai.com/v1   → append paths directly
 *   oneapi-style : base_url = http://localhost:3000/api   → paths carry /v1
 * Users also paste full request URLs (…/v1/chat/completions) into the base-URL
 * field — normalizeBaseUrl() strips those tails so we never double-append
 * ("/chat/completions/chat/completions") or probe "…/chat/completions/models".
 */

export interface EndpointPaths {
  /** Path appended to the base URL for GET model list. */
  models: string
  /** Path appended to the base URL for POST minimal completion. */
  chat: string
  /** Path appended to the base URL for POST Responses API completion
   *  (protocol 'openai-responses', issue #239). */
  responses: string
  /** Path appended to the base URL for POST image generation (issue #8). */
  images: string
}

/** Unified default for OpenAI-compatible endpoints (unknown providers included). */
export const DEFAULT_ENDPOINT_PATHS: EndpointPaths = {
  models: '/models',
  chat: '/chat/completions',
  responses: '/responses',
  images: '/images/generations',
}

/**
 * Per-provider overrides keyed by provider/preset name. Absent entries fall
 * back to DEFAULT_ENDPOINT_PATHS. Paths are relative to the NORMALIZED base
 * URL (version segment stripped, see resolveProbeEndpoints).
 */
export const PROVIDER_ENDPOINT_MAP: Record<string, Partial<EndpointPaths>> = {
  // All built-in presets are version-in-base OpenAI-compatible — defaults fit.
  // Add entries here for exotic deployments (azure query params, etc.).
}

/** Tails users paste from curl/docs that are request paths, not the base URL.
 *  Longest first; the version segment (/v1) stays — it belongs to the base. */
const STRIPPABLE_SUFFIXES = [
  // issue #8：注册生图 provider 时，用户最常粘贴的就是完整生图端点 URL
  // （从 provider 文档的 curl 示例里复制）。不剥这个尾巴，后续拼接会得到
  // …/images/generations/models → 404，而报错只提 "path may be wrong"。
  '/images/generations',
  '/chat/completions',
  '/completions',
  '/responses',
  '/messages',
  '/models',
  '/embeddings',
]

/** Strip trailing slashes and known request-path tails from a user-supplied base URL. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  for (const suffix of STRIPPABLE_SUFFIXES) {
    if (url.toLowerCase().endsWith(suffix)) {
      url = url.slice(0, -suffix.length).replace(/\/+$/, '')
      break
    }
  }
  return url
}

export interface ResolvedProbeEndpoints {
  /** Normalized base (no trailing slash, no request-path tail). */
  base: string
  modelsUrl: string
  chatUrl: string
  /** Responses API endpoint — used by the 'openai-responses' onboarding probe. */
  responsesUrl: string
  /** Image-generation endpoint — used by the image-gen onboarding probe (issue #8). */
  imagesUrl: string
}

/**
 * Resolve the probe URLs for a base URL. `providerName` selects an override
 * from PROVIDER_ENDPOINT_MAP; anything unknown (custom providers included)
 * uses the OpenAI-compatible default. When the base carries no version
 * segment (oneapi-style "/api"), "/v1" is inserted before the paths.
 */
export function resolveProbeEndpoints(baseUrl: string, providerName?: string): ResolvedProbeEndpoints {
  const base = normalizeBaseUrl(baseUrl)
  const override = providerName ? PROVIDER_ENDPOINT_MAP[providerName] : undefined
  const paths: EndpointPaths = { ...DEFAULT_ENDPOINT_PATHS, ...override }
  const versioned = /\/v\d+$/i.test(base)
  const prefix = versioned ? '' : '/v1'
  return {
    base,
    modelsUrl: `${base}${prefix}${paths.models}`,
    chatUrl: `${base}${prefix}${paths.chat}`,
    responsesUrl: `${base}${prefix}${paths.responses}`,
    imagesUrl: `${base}${prefix}${paths.images}`,
  }
}
