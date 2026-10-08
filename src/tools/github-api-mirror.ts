/**
 * GitHub REST API mirror fallback for the update checker.
 *
 * `src/tui/updater.ts` builds release URLs against `https://api.github.com`.
 * Users behind the GFW frequently cannot reach that host (issue #365), so the
 * update check silently fails and they never see upgrade banners. This module
 * resolves the *base URL* for a GitHub REST path, racing the direct endpoint
 * against domestic prefix proxies and returning whichever answers first.
 *
 * ## Why not reuse GITHUB_MIRRORS?
 * `mirror-env.ts`'s git mirrors (gitcode / kkgithub / fastgit) are **clone URL
 * templates** — they front `https://github.com/<owner>/<repo>.git`, not the
 * REST API. Proxying `api.github.com` needs generic prefix proxies instead,
 * which is why this module carries its own {@link GITHUB_API_PROXIES} list.
 *
 * ## Safety invariants (mirrors github-mirror-fallback.ts)
 * - fail-open: any error → the direct api.github.com URL, never a throw.
 * - user-respect: when the user explicitly chose a mirror
 *   (`resolveGithubMirrorId` truthy) we skip the race and route through the
 *   proxy list deterministically instead of hammering the direct endpoint.
 * - observable/cached: the winning prefix is remembered per session (TTL from
 *   `mirrors.fallbackMemoryMinutes`, default 30 min) so repeat checks do not
 *   re-race.
 */

import { resolveGithubMirrorId } from './mirror-env.js'
import type { MirrorsConfig } from '../config/schema.js'

/** Canonical direct REST endpoint for GitHub releases. */
export const GITHUB_API_DIRECT = 'https://api.github.com'

/**
 * Domestic prefix proxies that front `api.github.com`.
 *
 * Prefix form: `proxy + <full direct url>`, e.g.
 * `https://ghproxy.net/https://api.github.com/repos/o/r/releases/latest`.
 */
export const GITHUB_API_PROXIES: string[] = [
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
]

const DEFAULT_TIMEOUT_SEC = 5
const DEFAULT_MEMORY_MINUTES = 30

// ── session memory ─────────────────────────────────────────────────

/** Single key: the winning prefix for this process (direct or a proxy). */
const apiMemory = new Map<string, { prefix: string; expiresAt: number }>()
const MEMORY_KEY = 'github-api'

/** Clear all session memory (exposed for testing). */
export function clearApiMirrorMemory(): void {
  apiMemory.clear()
}

// ── helpers ────────────────────────────────────────────────────────

/**
 * Fire a HEAD probe against `url` with a hard timeout. Resolves `true` if the
 * endpoint answered with an ok status, `false` on error / abort / non-ok.
 * Never throws.
 */
async function probe(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Race all candidate prefixes; resolve with the first that answers, or null
 * when every candidate fails. Never rejects.
 */
function firstSuccess(
  prefixes: string[],
  apiPath: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let pending = prefixes.length
    let settled = false
    if (pending === 0) {
      resolve(null)
      return
    }
    for (const prefix of prefixes) {
      void probe(`${prefix}${GITHUB_API_DIRECT}${apiPath}`, fetchFn, timeoutMs).then((ok) => {
        if (settled) return
        if (ok) {
          settled = true
          resolve(prefix)
          return
        }
        pending -= 1
        if (pending === 0) {
          settled = true
          resolve(null)
        }
      })
    }
  })
}

// ── main resolver ──────────────────────────────────────────────────

export interface ResolveGithubApiUrlOptions {
  /** Mirror configuration (from `loadConfig().mirrors`). */
  config?: MirrorsConfig
  /** Injected fetch (defaults to `globalThis.fetch`). */
  fetchFn?: typeof fetch
  /** Per-probe timeout override (ms). Defaults to `fallbackTimeoutSec` or 5s. */
  timeoutMs?: number
  /** Memory TTL override (minutes). Defaults to `fallbackMemoryMinutes` or 30. */
  memoryMinutes?: number
}

/**
 * Resolve the full URL for a GitHub REST path such as
 * `/repos/owner/repo/releases/latest`.
 *
 * Returns the complete URL — either the direct `https://api.github.com` URL
 * or the same path behind a prefix proxy. Never throws; on total failure
 * returns the direct URL (fail-open).
 */
export async function resolveGithubApiUrl(
  apiPath: string,
  opts: ResolveGithubApiUrlOptions = {},
): Promise<string> {
  const direct = `${GITHUB_API_DIRECT}${apiPath}`
  const timeoutMs =
    opts.timeoutMs ?? (opts.config?.fallbackTimeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000
  const memoryMinutes =
    opts.memoryMinutes ?? opts.config?.fallbackMemoryMinutes ?? DEFAULT_MEMORY_MINUTES
  const fetchFn = opts.fetchFn ?? globalThis.fetch

  try {
    // ── user explicitly chose a mirror → deterministic proxy, no race ──
    const userMirror = opts.config ? resolveGithubMirrorId(opts.config) : undefined
    if (userMirror) {
      return `${GITHUB_API_PROXIES[0]}${direct}`
    }

    // ── remember the last winning prefix ───────────────────────────────
    const remembered = apiMemory.get(MEMORY_KEY)
    if (remembered && remembered.expiresAt > Date.now()) {
      return `${remembered.prefix}${direct}`
    }

    // ── race direct + proxies, first success wins ──────────────────────
    // candidates are URL prefixes: '' means "direct" (no proxy prefix).
    const candidates = ['', ...GITHUB_API_PROXIES]
    const winner = await firstSuccess(candidates, apiPath, fetchFn, timeoutMs)
    if (winner) {
      apiMemory.set(MEMORY_KEY, {
        prefix: winner,
        expiresAt: Date.now() + memoryMinutes * 60_000,
      })
      return `${winner}${direct}`
    }

    // ── nothing answered → fail-open to direct ─────────────────────────
    return direct
  } catch {
    return direct
  }
}
