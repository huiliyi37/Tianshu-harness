/**
 * Goal success-criteria extraction.
 *
 * `/goal` and `--goal` historically judged completion by a single regex on the
 * model's self-reported "GOAL ACHIEVED" marker, with no concrete acceptance
 * checklist. This module derives 3-6 independently checkable success criteria
 * from the raw goal via a single cheap-model call, so the goal judge has real
 * verification targets to test against. It is a side-path call (never enters the
 * main session prefix) and fails open to a generic template so the goal loop is
 * never blocked by extraction failure.
 */

import type { OaiMessage } from '../api/oai-types.js'
import type { StreamClient } from '../api/stream-client.js'
import type { ProviderConfig } from '../config/schema.js'
import { createProviderClient } from '../api/factory.js'
import { resolveCapabilities } from '../api/provider.js'
import { resolveApiKey } from '../api/factory.js'

/**
 * Generic completion: (system, user) → assistant text. Injectable so the
 * extraction logic stays unit-testable without constructing a real client.
 */
export type CompletionFn = (system: string, user: string, signal?: AbortSignal) => Promise<string>

/**
 * Fallback used when extraction is unavailable or fails. Deliberately vague —
 * the judge degrades to "was the objective genuinely handled?" wide judgment.
 */
export const GENERIC_SUCCESS_CRITERIA: readonly string[] = [
  'The requested change or behavior is actually implemented, not merely described.',
  'Relevant verification (tests / typecheck / observed behavior) passed, or any gap is explicitly disclosed.',
] as const

const MAX_CRITERIA = 8

const EXTRACTION_SYSTEM = `You decompose a software engineering goal into concrete, independently verifiable success criteria.

Rules:
- Output ONLY a JSON array of 3 to 6 short strings. No prose, no markdown, no keys.
- Each criterion must be checkable by running a command, reading a file, or observing a concrete behavior — never vague ("works well", "is good").
- Prefer criteria a reviewer could test without asking the author.
- Do not restate the goal verbatim; break it into discrete acceptance checks.

Example output:
["All new functions have unit tests under __tests__/", "npm test passes with 0 failures", "The CLI accepts --foo and prints the parsed value"]`

/** Build the user turn for criteria extraction. Exported for testing/transparency. */
export function buildCriteriaExtractionUser(goal: string): string {
  return `Goal:\n${goal.trim()}\n\nReturn a JSON array of 3-6 concrete success criteria.`
}

/**
 * Parse a JSON array of criteria strings out of arbitrary model text. Tolerant
 * of code fences and surrounding prose: extracts the first balanced [...] block.
 * Returns null when nothing usable is found.
 */
export function parseCriteria(text: string): string[] | null {
  if (!text) return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  const slice = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const items = parsed
    .filter((x): x is string => typeof x === 'string')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  return items.length > 0 ? items : null
}

/**
 * Extract concrete success criteria from a goal. Always resolves: on any error
 * or empty/invalid output it falls back to {@link GENERIC_SUCCESS_CRITERIA}.
 */
export async function extractGoalCriteria(
  goal: string,
  complete: CompletionFn,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const raw = await complete(EXTRACTION_SYSTEM, buildCriteriaExtractionUser(goal), signal)
    const parsed = parseCriteria(raw)
    if (parsed && parsed.length > 0) return parsed.slice(0, MAX_CRITERIA)
  } catch {
    // fall through to generic template
  }
  return [...GENERIC_SUCCESS_CRITERIA]
}

/**
 * Adapt a streaming {@link StreamClient} into a one-shot {@link CompletionFn}.
 * Consumes text deltas only; used by the `/goal` and `--goal` entry points to
 * run a cheap, non-interactive extraction without touching the agent loop.
 */
export function completionFromClient(
  client: StreamClient,
  model: string,
  maxTokens = 1024,
): CompletionFn {
  return async (system, user, signal) => {
    let text = ''
    let err: Error | undefined
    const messages: OaiMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
    await client.stream(
      { model, messages, max_tokens: maxTokens, temperature: 0, stream: true },
      {
        onTextDelta: (d) => { text += d },
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: (e) => { err = e },
      },
      signal,
    )
    if (err && !text) throw err
    return text
  }
}

/**
 * Build a dedicated StreamClient from a cheap worker profile, so criteria
 * extraction doesn't share the main session's client (avoiding lifecycle
 * controller contention and socket-pool interference).
 *
 * Returns null when the profile's provider isn't configured or has no API key,
 * so callers can fall back to the main client.
 *
 * Known limitation: even with a separate StreamClient, Node.js default HTTP
 * agent shares connection pools — extreme concurrency may still queue at the
 * socket layer. Non-blocking for typical criteria extraction (single short call).
 */
export function buildCheapClient(
  profile: { provider: string; model: string },
  providers: Record<string, ProviderConfig>,
  sessionId?: string,
): { client: StreamClient; model: string } | null {
  const prov = providers[profile.provider]
  if (!prov) return null
  let apiKey: string
  try {
    apiKey = resolveApiKey(prov)
  } catch {
    return null
  }
  if (!apiKey) return null
  const modelSpec = prov.models.find(m => m.id === profile.model || m.alias === profile.model)
  const model = modelSpec?.id ?? profile.model
  const maxTokens = Math.min(1024, modelSpec?.maxTokens ?? 4096)
  const client = createProviderClient(
    prov,
    resolveCapabilities(profile.provider, prov.capabilities),
    // 判据抽取是主会话的 side-path，会话 ID 仍用主会话的——上游按会话做路由/
    // 缓存亲和，缺省会落到 factory 的进程级兜底，把不同会话的判据请求混成一段。
    { apiKey, model, maxTokens, sessionId },
  )
  return { client, model }
}
