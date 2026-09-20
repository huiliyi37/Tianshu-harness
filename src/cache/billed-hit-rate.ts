/**
 * Real, all-in billed cache hit rate — Σ cacheRead / Σ input across EVERY
 * request the provider actually charged for, side-path rows included.
 *
 * `usage-aggregator.ts`'s own `hitRate` (see `UsageTotals.hitRate` and its
 * doc comment) is computed over main rows only, by design — that's the
 * right number for "is our own turn-taking cache-efficient", and this file
 * does not change it. But it means a regression that quietly starts
 * generating a lot of side-path traffic (speculation retries, oversized
 * compaction summaries) at a poor hit rate is invisible to that metric:
 * cost goes up, `hitRate` doesn't move. `computeBilledHitRate` is the
 * complementary number — the one that actually reflects the bill — kept as
 * a separate function rather than changed in place so nothing depends on
 * `UsageTotals.hitRate`'s existing meaning being touched.
 */
import type { CacheUsageRow } from './usage-aggregator.js'

export interface BilledHitRateResult {
  /** Σ cacheRead / Σ input over every row, percent 0-100; null when there's no input at all. */
  hitRate: number | null
  input: number
  cacheRead: number
  /** main-row count */
  requests: number
  /** side_path-row count (speculation / compaction / other side-path kinds) */
  sidePathRequests: number
}

export function computeBilledHitRate(rows: readonly CacheUsageRow[]): BilledHitRateResult {
  let input = 0
  let cacheRead = 0
  let requests = 0
  let sidePathRequests = 0

  for (const row of rows) {
    input += row.input
    cacheRead += row.cacheRead
    if (row.sidePath) sidePathRequests += 1
    else requests += 1
  }

  return {
    hitRate: input > 0 ? Math.round((cacheRead / input) * 1000) / 10 : null,
    input,
    cacheRead,
    requests,
    sidePathRequests,
  }
}
