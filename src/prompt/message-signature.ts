import type { OaiMessage } from '../api/oai-types.js'

/**
 * Per-message request signature for the prefix-divergence probe (issue #139).
 *
 * Moved out of engine.ts together with the caches below: buildOaiRequest
 * re-signs the ENTIRE request on every main turn, but request prefixes are
 * byte-stable by design (frozen snapshots / exact-prefix discipline), so the
 * full-content djb2 over unchanged history is pure waste — O(history chars)
 * per turn, growing without bound in long sessions. The caches make the
 * steady state O(new + changed chars) instead.
 */

/** Full-content djb2 (no truncation) — prefix-divergence probe needs to detect
 *  byte changes anywhere in a message, not just the first 2000 chars. */
function fullHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${h}:${s.length}`
}

export interface MessageSignature {
  sig: string
  len: number
}

/**
 * Cache entry carries the source field refs it was computed from — an O(1)
 * belt-and-suspenders guard. Production code never mutates request messages
 * in place (every mutating pass spreads into a fresh object), but a stale hit
 * on a mutated object would silently blind the divergence probe, so a ref
 * mismatch falls through to a recompute. Same-value string replacement is
 * still correct: `===` compares contents before we reuse the cached hash.
 */
interface SigCacheEntry extends MessageSignature {
  role: string
  content: unknown
  toolCalls: unknown
  reasoning: unknown
  callId: unknown
}

/** Pass-through messages (tool results, assistant tool_calls) keep their object
 *  identity across turns — result only re-wraps user/system messages. */
const sigByObject = new WeakMap<OaiMessage, SigCacheEntry>()

/**
 * Rebuilt wrappers ({ role: 'user', content: frozen }) are fresh objects every
 * build, but their content strings come from frozenUserMerged and keep the
 * same instance across turns — a content-keyed map hits where the WeakMap
 * cannot (V8 caches string hashes, so Map lookups on a previously-seen string
 * instance don't rescan it). Entries are role-tagged: the signature includes
 * the role, so a user/system value collision must not cross-reuse. Messages
 * with tool_calls / reasoning_content / tool_call_id never take this path —
 * their signature is not a pure function of string content.
 */
const sigByContent = new Map<string, SigCacheEntry>()
const SIG_CONTENT_CACHE_CAP = 2048

/** Test observability: full-hash computations actually performed. Steady-state
 *  builds should only hash new/changed messages (issue #139 scaling guard). */
export const signatureCacheStats = { computations: 0 }

/** Serialize one request message to the byte-relevant parts for hashing. */
export function messageSignature(m: OaiMessage): MessageSignature {
  const rec = m as unknown as Record<string, unknown>
  const hit = sigByObject.get(m)
  if (
    hit && hit.role === m.role && hit.content === m.content && hit.toolCalls === rec.tool_calls
    && hit.reasoning === rec.reasoning_content && hit.callId === rec.tool_call_id
  ) {
    return hit
  }
  if (typeof m.content === 'string' && !rec.tool_calls && !rec.reasoning_content && !rec.tool_call_id) {
    const byContent = sigByContent.get(m.content)
    if (byContent && byContent.role === m.role) return byContent
    const entry = computeEntry(m, rec)
    if (sigByContent.size >= SIG_CONTENT_CACHE_CAP) sigByContent.clear()
    sigByContent.set(m.content, entry)
    return entry
  }
  const entry = computeEntry(m, rec)
  sigByObject.set(m, entry)
  return entry
}

function computeEntry(m: OaiMessage, rec: Record<string, unknown>): SigCacheEntry {
  let s = typeof m.content === 'string' ? m.content : (m.content == null ? '' : JSON.stringify(m.content))
  if (rec.tool_calls) s += '\u0000' + JSON.stringify(rec.tool_calls)
  if (rec.reasoning_content) s += '\u0000' + String(rec.reasoning_content)
  if (rec.tool_call_id) s += '\u0000' + String(rec.tool_call_id)
  signatureCacheStats.computations++
  return {
    sig: `${m.role}\u0000${fullHash(s)}`,
    len: s.length,
    role: m.role,
    content: m.content,
    toolCalls: rec.tool_calls,
    reasoning: rec.reasoning_content,
    callId: rec.tool_call_id,
  }
}
