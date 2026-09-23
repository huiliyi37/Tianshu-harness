import type { SearchBackend, SearchResult } from './types.js'
import { fetchCauseDetail } from '../../api/error-classifier.js'
import { OFF_TOPIC_ERROR, looksOffTopic } from './relevance.js'

export interface BackendError {
  backend: string
  message: string
}

export interface ChainResult {
  /** Name of the backend that produced results, or null when all fell through. */
  backend: string | null
  results: SearchResult[]
  /** Per-backend failures/empties accumulated while walking the chain. */
  errors: BackendError[]
  /**
   * 链序第一个被判跑题的非空批次。
   *
   * 它不参与胜出判定（`results` 仍为空），只作**低置信兜底**：全部后端都无相关
   * 结果时，tool 层用它降级返回并附显式低相关标注——避免单后端配置下把「后端
   * 降级返回泛结果」直接变成「什么都搜不到」。仅当有后端返回过跑题内容时存在。
   */
  offTopicFallback?: { backend: string; results: SearchResult[] }
}

/**
 * Try backends in order. The first available backend that returns a usable
 * non-empty result wins and short-circuits. Unavailable backends (missing key)
 * are skipped without an error; empty results, off-topic results and thrown
 * errors are recorded and the walk continues to the next backend.
 *
 * "Off-topic" is the silently-wrong case: HTTP 200, a full block of parsed
 * results, and none of them about the query (see `relevance.ts`). It must fall
 * through like an empty result — otherwise the chain hands unrelated content to
 * the model as if it were an answer. The first such batch is retained on
 * `offTopicFallback` so the caller can **downgrade** (label) rather than
 * discard it when no backend produced anything relevant.
 */
export async function runBackendChain(
  backends: readonly SearchBackend[],
  query: string,
  count: number,
  timeoutMs: number,
): Promise<ChainResult> {
  const errors: BackendError[] = []
  let offTopicFallback: { backend: string; results: SearchResult[] } | undefined

  for (const backend of backends) {
    if (!backend.isAvailable()) continue

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const results = await backend.search(query, count, controller.signal)
      if (results.length > 0) {
        if (looksOffTopic(query, results)) {
          errors.push({ backend: backend.name, message: OFF_TOPIC_ERROR })
          // 链序优先：只保留第一个跑题批次，后续批次不得覆盖它。
          offTopicFallback ??= { backend: backend.name, results }
          continue
        }
        return { backend: backend.name, results, errors }
      }
      errors.push({ backend: backend.name, message: 'no results' })
    } catch (err) {
      errors.push({ backend: backend.name, message: describeError(err, timeoutMs) })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return {
    backend: null,
    results: [],
    errors,
    ...(offTopicFallback ? { offTopicFallback } : {}),
  }
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return `timed out after ${timeoutMs / 1000}s`
  }
  const message = err instanceof Error ? err.message : String(err)
  // Surface undici's err.cause (real network failure) — bare "fetch failed"
  // is undiagnosable for both the model and the user.
  const detail = fetchCauseDetail(err)
  return detail ? `${message}: ${detail}` : message
}
