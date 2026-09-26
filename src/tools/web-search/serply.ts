import type { SearchBackend, SearchFetch, SearchResult } from './types.js'

const SERPLY_ENDPOINT = 'https://api.serply.io/v1/search'
/** Serply returns at most 10 organic results per request. */
const SERPLY_MAX_NUM = 10

interface SerplyResponse {
  results?: Array<{ title?: string; link?: string; description?: string }>
}

/**
 * Serply Search API backend (Google results over JSON). Requires an API key
 * (serply.io, 2,500 free credits, no card). Available only when a key was
 * resolved from config; otherwise the chain skips it.
 * Docs: https://serply.io/docs
 */
export class SerplyBackend implements SearchBackend {
  readonly name = 'serply'

  constructor(
    private readonly fetchImpl: SearchFetch,
    private readonly apiKey: string | undefined,
  ) {}

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, num: String(Math.min(count, SERPLY_MAX_NUM)) })
    const response = await this.fetchImpl(`${SERPLY_ENDPOINT}?${params.toString()}`, {
      signal,
      headers: {
        Accept: 'application/json',
        'X-Api-Key': this.apiKey ?? '',
        'User-Agent': 'Tianshu (+https://github.com/huiliyi37/Tianshu-harness)',
      },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as SerplyResponse
    const raw = data.results ?? []
    const results: SearchResult[] = []
    for (const r of raw) {
      if (!r.link || !r.title) continue
      results.push({ title: r.title, url: r.link, snippet: r.description ?? '' })
      if (results.length >= count) break
    }
    return results
  }
}
