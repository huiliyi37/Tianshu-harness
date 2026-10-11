/**
 * forum-sync — 把 token 消耗快照推送到论坛端点的客户端（唯一上传通道）。
 *
 * 契约（预留接口，论坛端按此实现）：
 *   POST {endpoint}                —— 完整 URL 由配置给出，不拼路径
 *   Headers: Content-Type: application/json
 *            Authorization: Bearer <apiKey>（配置了才带）
 *   Body: TokenUsageSnapshot（version:1，累计语义，按 deviceId upsert）
 *   2xx = 已受理；4xx = 载荷/鉴权问题（不重试）；5xx/429/网络 = 瞬态（重试一次）。
 *
 * 与 account-license 同纪律：永不 throw，返回结果码联合，调用方映射处置。
 * fetch 可注入——sidecar 进程没有全局代理 dispatcher（见 account.ts 注释），
 * 测试也经此打桩。
 */
import { isSafeLedgerEndpoint } from './settings.js'
import type { TokenUsageSnapshot } from './types.js'

export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    redirect?: 'error'
  },
) => Promise<{ status: number; text(): Promise<string> }>

export type ForumPushCode = 'no_endpoint' | 'timeout' | 'network' | 'http_4xx' | 'http_5xx' | 'invalid_endpoint' | 'invalid_receipt' | 'stale_receipt'

export type ForumPushResult =
  | { ok: true; status: number }
  | { ok: false; code: ForumPushCode; status?: number; error?: string }

export interface ForumPushOptions {
  /** 完整推送 URL；缺省 = 未配置，返回 no_endpoint */
  endpoint?: string
  apiKey?: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
  /** 单次尝试超时，默认 10s（与 account.ts HTTP_TIMEOUT_MS 一致） */
  timeoutMs?: number
  /** 瞬态失败的额外重试次数，默认 1 */
  retries?: number
  /** 重试间隔，默认 1s */
  backoffMs?: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function pushTokenUsageSnapshot(
  snapshot: TokenUsageSnapshot,
  options: ForumPushOptions,
): Promise<ForumPushResult> {
  const endpoint = options.endpoint?.trim()
  if (!endpoint) return { ok: false, code: 'no_endpoint' }
  if (!isSafeLedgerEndpoint(endpoint)) return { ok: false, code: 'invalid_endpoint' }

  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = options.timeoutMs ?? 10_000
  const retries = options.retries ?? 1
  const backoffMs = options.backoffMs ?? 1_000

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = options.apiKey?.trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const body = JSON.stringify(snapshot)

  let lastTransient: ForumPushResult = { ok: false, code: 'network' }
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) return { ok: false, code: 'timeout' }
    if (attempt > 0) await sleep(backoffMs * attempt)
    if (options.signal?.aborted) return { ok: false, code: 'timeout' }
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        body,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
      const responseBody = await res.text()
      if (res.status >= 200 && res.status < 300) {
        let receipt: unknown
        try { receipt = JSON.parse(responseBody) } catch { return { ok: false, code: 'invalid_receipt', status: res.status } }
        if (!receipt || typeof receipt !== 'object' || (receipt as { ok?: unknown }).ok !== true) {
          return { ok: false, code: 'invalid_receipt', status: res.status }
        }
        if ((receipt as { stale?: unknown }).stale !== false) {
          return { ok: false, code: 'stale_receipt', status: res.status }
        }
        return { ok: true, status: res.status }
      }
      // 4xx（除 429）是载荷/鉴权问题，重试同一载荷无意义——往少做侧失效。
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { ok: false, code: 'http_4xx', status: res.status }
      }
      lastTransient = { ok: false, code: 'http_5xx', status: res.status }
    } catch (err) {
      const name = (err as Error)?.name
      const code: ForumPushCode = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
      lastTransient = { ok: false, code }
    }
  }
  return lastTransient
}
