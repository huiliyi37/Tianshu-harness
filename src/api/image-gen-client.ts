import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { resolveProbeEndpoints } from './endpoint-map.js'
// 图片地址来自服务响应；复用网络工具的代理解析、逐跳 SSRF 检查和下载上限。
import type { LookupFn } from '../tools/net/ssrf.js'
import { httpFetchGuarded, type FetchLike } from '../tools/net/http-fetch.js'
import { resolveProxyForUrl, type ProxyResolverOptions } from '../tools/net/proxy-resolver.js'

/**
 * image-gen-client — 文生图端点客户端（issue #8 Wave 2）。
 *
 * 只做一件事：把 prompt 变成**图片字节**。落盘、路径授权、ToolResult 构造都在
 * 工具层（`tools/generate-image.ts`）——这样「base64 不进上下文」是结构性保证，
 * 而不是靠调用方自觉：本模块的返回类型里根本没有 base64 字符串。
 *
 * 协议分歧按 issue #8 的实测结论吸收（两处，均可在官方文档复核）：
 *  - 请求侧：尺寸字段名。OpenAI 发 `size`，SiliconFlow 发 `image_size`，值语法
 *    相同。由槽位配置的 `sizeField` 选择，**只发一个**。
 *  - 响应侧：宽容解析。依次尝试 `data[].b64_json` → `data[].url` →
 *    `images[].url`（SiliconFlow 形状）。全落空时报错并附响应片段——响应形状是
 *    可枚举的有限集，为它加配置项等于把实现细节推给用户。
 *
 * ComfyUI **不在 v1 支持范围**：它的原生 API 是「提交 workflow JSON → 轮询
 * /history/{prompt_id} → 另走 /view 取字节」的三步异步链路，没有
 * `/v1/images/generations` 形态端点。用户侧可用 comfyui-openai-api 类插件桥接。
 */

/** 生图端到端常达 10–60s，高档模型更久。文本请求量级的默认值必然超时。 */
export const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 180_000

/** 单张图片的字节上限。与 `export-file.ts` 的导出口径（50MB）对齐——超过它的
 *  响应既不该落盘，也几乎必然意味着该端点返回的不是图片。 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/** 超限时的共同提示：超限几乎总意味着端点返回的不是图片。 */
const BIGNESS_HINT = 'The provider likely returned something other than an image.'

/** 超限即拒绝。**在分配内存之前**按估算值调用一次，解码后再按真值调用一次。 */
function assertWithinLimit(actualBytes: number, maxBytes: number, hint: string): void {
  if (actualBytes <= maxBytes) return
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`
  throw new Error(
    `Image payload too large: ${mb(actualBytes)} exceeds the ${mb(maxBytes)} limit. ${hint}`,
  )
}

export interface GenerateImageOptions {
  baseUrl: string
  apiKey?: string
  model: string
  prompt: string
  size?: string
  /** 尺寸参数的线上字段名。缺省 'size'（OpenAI 形态）。 */
  sizeField?: 'size' | 'image_size'
  timeoutMs?: number
  signal?: AbortSignal
  /** provider/global proxy overrides; otherwise follow environment and system proxy. */
  proxy?: ProxyResolverOptions
  trustProxyFakeIp?: boolean
  onStage?: (stage: 'generating' | 'downloading') => void
  /** 图片字节上限。缺省 MAX_IMAGE_BYTES。 */
  maxBytes?: number
  /** 测试注入点。生产路径使用与代理 dispatcher 同版本的 undici fetch。 */
  fetchImpl?: typeof fetch
  /** 测试注入点：SSRF 预检用的 DNS 解析。 */
  lookupImpl?: LookupFn
}

export interface GeneratedImage {
  bytes: Uint8Array
  mimeType: string
  /** 图片来源——诊断用。url 形态意味着多走了一次下载。 */
  source: 'b64_json' | 'url'
}

/** 按魔数嗅探图片类型。URL 没有扩展名（或带查询串）时这是唯一可靠依据。 */
function sniffMimeType(bytes: Uint8Array, fallbackFromUrl?: string): string {
  if (bytes.length >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return 'image/webp'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  }
  if (fallbackFromUrl) {
    const ext = fallbackFromUrl.split('?')[0]?.split('.').pop()?.toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'gif') return 'image/gif'
  }
  return 'image/png'
}

/** 按状态码给出可执行的诊断，而不是笼统的「请求失败」。 */
function classifyImageGenError(status: number, bodyText: string, baseUrl: string): string {
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim()
  const tail = snippet ? ` — server said: ${snippet}` : ''
  if (status === 401 || status === 403) {
    return `Authentication failed (HTTP ${status})${tail}. Check the API key for this image-gen provider.`
  }
  if (status === 404) {
    return `HTTP 404 from ${baseUrl}${tail} — the image endpoint path may be wrong (expected /v1/images/generations), or the model id does not exist.`
  }
  if (status === 429) {
    return `Rate limited or quota exhausted (HTTP 429)${tail}. The API key may be valid but out of allowance.`
  }
  if (status === 503 || status === 502 || status === 504) {
    return `Provider overloaded or gateway failed (HTTP ${status})${tail}. Retry later.`
  }
  return `HTTP ${status}${tail}`
}

interface ImageRef {
  kind: 'b64_json' | 'url'
  value: string
}

/** 错误文案里的响应片段必须先脱敏。
 *
 *  端点完全可以把整张图的 base64 直接放在响应体里（形状各家不同：数组根、
 *  `{data:{…}}`、外面再套一层 result……）。原样回显就等于把图片数据送进对话
 *  上下文，与「base64 不进上下文」的承诺自相矛盾。判据刻意不依赖字段名——
 *  任何够长的 base64 字面量一律抹掉。 */
function redactedSnippet(payload: unknown): string {
  let raw: string
  try {
    raw = JSON.stringify(payload) ?? '(unserializable)'
  } catch {
    return '(unserializable)'
  }
  return raw
    // 主判据按**字段名**：不依赖长度。1×1 PNG 的 base64 也才 ~90 字符，纯长度
    // 判据会把它整段漏出去，而这正是最该拦住的那类内容。
    .replace(/"(b64_json|base64|image_data|imageData)":\s*"[^"]*"/gi, '"$1":"<base64 data omitted>"')
    // 长度兜底：字段名没给出提示、但值确实是一大坨 base64 的情况。
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '<base64 data omitted>')
    .slice(0, 300)
}

/** 宽容解析：三种已知形状依次尝试，全落空时返回 null（由调用方带片段报错）。 */
function extractImageRef(payload: unknown): ImageRef | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>

  const fromEntry = (entry: unknown): ImageRef | null => {
    if (!entry || typeof entry !== 'object') return null
    const obj = entry as Record<string, unknown>
    if (typeof obj.b64_json === 'string' && obj.b64_json.length > 0) {
      return { kind: 'b64_json', value: obj.b64_json }
    }
    if (typeof obj.url === 'string' && obj.url.length > 0) return { kind: 'url', value: obj.url }
    return null
  }

  // OpenAI: { data: [{ b64_json | url }] }
  if (Array.isArray(record.data)) {
    for (const entry of record.data) {
      const ref = fromEntry(entry)
      if (ref) return ref
    }
  }
  // SiliconFlow: { images: [{ url }], timings, seed }
  if (Array.isArray(record.images)) {
    for (const entry of record.images) {
      const ref = fromEntry(entry)
      if (ref) return ref
    }
  }
  return null
}

/**
 * 带超时地完成一次请求**及其 body 读取**。
 *
 * 早先的版本在 `await fetchImpl(...)` 返回（响应头到达）时就 clearTimeout，于是后面
 * 的 `response.json()` / `arrayBuffer()` 完全没有保护——一个只发 headers、不写完 body
 * 的端点能让调用一直挂住。写这条修复时的实测：不中止的情况下，那个用例会挂到进程被
 * 外部杀掉为止（这也正是它一开始"看起来通过"的假绿来源）。超时预算必须覆盖到 consume
 * 返回为止，所以 body 读取作为参数传进来，而不是在调用点另起一次计时。
 */
async function withTimeout<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
  signal?: AbortSignal,
  network?: ProxyResolverOptions,
): Promise<T> {
  const proxyUrl = network ? resolveProxyForUrl(url, network) : undefined
  const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    signal?.throwIfAborted()
    const requestInit: RequestInit = { ...init, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal }
    if (dispatcher) (requestInit as { dispatcher?: unknown }).dispatcher = dispatcher
    const response = await fetchImpl(url, requestInit)
    return await consume(response)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError')
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Image generation timed out after ${timeoutMs}ms. Increase agent.imageGenModel.timeoutMs if the provider is slow.`)
    }
    throw describeNetworkError(error, url, !!proxyUrl)
  } finally {
    clearTimeout(timer)
    if (dispatcher) await dispatcher.destroy().catch(() => {})
  }
}

/** Only expose the host and known error codes; signed URLs and proxy credentials stay private. */
function describeNetworkError(error: unknown, url: string, proxied: boolean): unknown {
  const codes = new Set<string>()
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 4) return
    const e = value as { code?: unknown; cause?: unknown; errors?: unknown[] }
    if (typeof e.code === 'string' && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(e.code)) codes.add(e.code)
    visit(e.cause, depth + 1)
    if (Array.isArray(e.errors)) e.errors.forEach(child => visit(child, depth + 1))
  }
  visit(error)
  if (!codes.size && !(error instanceof Error && error.message === 'fetch failed')) return error
  return new Error(`Image network request failed (${new URL(url).hostname}; ${proxied ? 'proxy' : 'direct'}; ${[...codes].join(', ') || 'NETWORK_ERROR'}). Check the network, proxy and certificate configuration.`, { cause: error })
}

/**
 * 生成一张图片并返回其字节。**不落盘、不返回 base64 字符串**——调用方拿到的
 * 是可以直接写文件的 `Uint8Array`。
 */
export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage> {
  options.signal?.throwIfAborted()
  options.onStage?.('generating')
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch)
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_GEN_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  // 复用 endpoint-map 的归一化：用户从 provider 文档粘贴完整端点 URL 时也不会
  // 拼出 …/images/generations/images/generations。
  const url = resolveProbeEndpoints(options.baseUrl).imagesUrl

  const sizeKey = options.sizeField ?? 'size'
  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
  }
  if (options.size) body[sizeKey] = options.size

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  const payload = await withTimeout(fetchImpl, url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeoutMs, async (response) => {
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      throw new Error(classifyImageGenError(response.status, bodyText, options.baseUrl))
    }
    return (await response.json().catch((error: unknown) => {
      // 不能把 abort 吞成 null——那会把"超时"伪装成"响应不是 JSON"。
      if (error instanceof Error && error.name === 'AbortError') throw error
      return null
    })) as unknown
  }, options.signal, options.fetchImpl ? undefined : options.proxy ?? {})
  const ref = extractImageRef(payload)
  if (!ref) {
    throw new Error(
      `Image response did not contain a known image field (looked for data[].b64_json, data[].url, images[].url). Got: ${redactedSnippet(payload)}`,
    )
  }

  if (ref.kind === 'b64_json') {
    // 先按 base64 长度估算：超限就直接拒绝，不必为一个注定被丢弃的响应真的分配
    // 4/3 倍的内存。解码后再按真值核一次。
    assertWithinLimit(Math.floor(ref.value.length * 3 / 4), maxBytes, BIGNESS_HINT)
    const bytes = new Uint8Array(Buffer.from(ref.value, 'base64'))
    assertWithinLimit(bytes.byteLength, maxBytes, BIGNESS_HINT)
    return { bytes, mimeType: sniffMimeType(bytes), source: 'b64_json' }
  }

  options.onStage?.('downloading')
  // SSRF 预检：这个 url 完全来自响应体，不受我们控制。恶意或被劫持的生图端点可以
  // 借它打到内网或云元数据地址（169.254.169.254 一类），而且取回的字节会落盘、进而
  // 被 read_file 读回上下文——外泄链是闭合的。下载前必须解析目标并确认它不在保留
  // 网段内，与 web_fetch 走同一套判据（src/tools/net/ssrf.ts）。
  try {
    const download = await httpFetchGuarded(ref.value, {
      lookup: options.lookupImpl,
      ...(options.fetchImpl ? { fetch: options.fetchImpl as unknown as FetchLike } : {}),
    }, { timeoutMs, maxResponseBytes: maxBytes, proxy: options.proxy, trustProxyFakeIp: options.trustProxyFakeIp, signal: options.signal })
    if (download.status < 200 || download.status >= 300) {
      throw new Error(`Failed to download the generated image from ${new URL(download.finalUrl).hostname} (HTTP ${download.status}).`)
    }
    return { bytes: download.bytes, mimeType: sniffMimeType(download.bytes, download.finalUrl), source: 'url' }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (error instanceof Error && error.message.startsWith('Response body exceeds maximum allowed size')) throw new Error(`Image payload too large: exceeds the ${maxBytes} byte limit. ${BIGNESS_HINT}`)
    throw describeNetworkError(error, ref.value, !options.fetchImpl && !!resolveProxyForUrl(ref.value, options.proxy))
  }
}
