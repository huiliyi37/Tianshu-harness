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
 * the model as if it were an answer.
 */
export async function runBackendChain(
  backends: readonly SearchBackend[],
  query: string,
  count: number,
  timeoutMs: number,
): Promise<ChainResult> {
  const errors: BackendError[] = []

  for (const backend of backends) {
    if (!backend.isAvailable()) continue

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const results = await backend.search(query, count, controller.signal)
      if (results.length > 0) {
        if (looksOffTopic(query, results)) {
          errors.push({ backend: backend.name, message: OFF_TOPIC_ERROR })
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

  return { backend: null, results: [], errors }
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
