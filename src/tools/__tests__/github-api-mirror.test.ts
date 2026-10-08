/**
 * Tests for the GitHub REST API mirror fallback (issue #365).
 *
 * Reproduction: before this module existed, the update checker always hit
 * `https://api.github.com` directly and gave up when it was unreachable — a
 * RED on case (b)/(c) below. These tests pin the resolve behaviour against an
 * injected fetch so they never touch the real network.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveGithubApiUrl,
  clearApiMirrorMemory,
  GITHUB_API_DIRECT,
  GITHUB_API_PROXIES,
} from '../github-api-mirror.js'
import type { MirrorsConfig } from '../../config/schema.js'

const API_PATH = '/repos/o/r/releases/latest'

/** Minimal MirrorsConfig factory (only the fields this module reads). */
function mirrorConfig(over: Partial<MirrorsConfig> = {}): MirrorsConfig {
  return {
    enabled: false,
    preset: 'default',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
    autoFallback: true,
    fallbackMemoryMinutes: 30,
    fallbackTimeoutSec: 5,
    ...over,
  } as MirrorsConfig
}

/** fetch that answers ok only for URLs containing any of `okFragments`. */
function fetchOkFor(okFragments: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url)
    if (okFragments.some((f) => u.includes(f))) {
      return new Response('{}', { status: 200 })
    }
    throw new Error('network down')
  }) as unknown as typeof fetch
}

beforeEach(() => clearApiMirrorMemory())

describe('resolveGithubApiUrl', () => {
  // (a) direct reachable → direct wins, no proxy prefix.
  it('uses the direct endpoint when it answers', async () => {
    const url = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig(),
      fetchFn: fetchOkFor([GITHUB_API_DIRECT]),
    })
    assert.equal(url, `${GITHUB_API_DIRECT}${API_PATH}`)
  })

  // (b) direct unreachable → falls through to a proxy.
  it('falls back to a proxy when direct fails', async () => {
    const url = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig(),
      fetchFn: fetchOkFor([GITHUB_API_PROXIES[0]]),
    })
    assert.equal(url, `${GITHUB_API_PROXIES[0]}${GITHUB_API_DIRECT}${API_PATH}`)
  })

  // (b') direct times out (abort) → proxy still wins.
  it('falls back to a proxy when direct times out', async () => {
    const slow = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.startsWith(GITHUB_API_DIRECT)) {
        // Never resolve until aborted.
        return await new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
        })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const url = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig(),
      fetchFn: slow,
      timeoutMs: 30,
    })
    assert.ok(url.startsWith(GITHUB_API_PROXIES[0]))
  })

  // (c) everything fails → fail-open to direct, no throw.
  it('returns the direct url when all candidates fail', async () => {
    const failing = (async () => {
      throw new Error('all down')
    }) as unknown as typeof fetch
    const url = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig(),
      fetchFn: failing,
    })
    assert.equal(url, `${GITHUB_API_DIRECT}${API_PATH}`)
  })

  // (d) user-explicit mirror → deterministic proxy, no race.
  it('honours an explicitly configured mirror without racing', async () => {
    let calls = 0
    const counting = (async () => {
      calls += 1
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    const url = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig({ enabled: true, github: 'kkgithub' }),
      fetchFn: counting,
    })
    assert.equal(url, `${GITHUB_API_PROXIES[0]}${GITHUB_API_DIRECT}${API_PATH}`)
    assert.equal(calls, 0, 'user-explicit path must not probe')
  })

  // (e) cache: second call reuses the remembered winner without re-racing.
  it('caches the winning prefix for the session', async () => {
    let calls = 0
    const counting = (async (url: string | URL) => {
      calls += 1
      const u = String(url)
      if (u.includes(GITHUB_API_PROXIES[0])) return new Response('{}', { status: 200 })
      throw new Error('down')
    }) as unknown as typeof fetch

    const first = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig(),
      fetchFn: counting,
    })
    const callsAfterFirst = calls
    assert.ok(first.startsWith(GITHUB_API_PROXIES[0]))

    const second = await resolveGithubApiUrl(API_PATH, {
      config: mirrorConfig(),
      fetchFn: counting,
    })
    assert.equal(second, first)
    assert.equal(calls, callsAfterFirst, 'cached call must not probe again')
  })
})
