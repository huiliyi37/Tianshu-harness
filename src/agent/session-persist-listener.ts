import { type SessionContext } from './context.js'
import { type SessionPersist } from './session-persist.js'
import { debugLog } from '../utils/debug.js'

/**
 * Wire the SessionContext mutation listener that mirrors every in-memory
 * message change to durable storage. Extracted verbatim from the AgentLoop
 * constructor (W-L5a) — pure persistence concern, no prefix-cache coupling.
 *
 * - append: serialize via a single promise chain to keep file order stable
 *   even when consecutive tool_results fire fast.
 * - replace: full atomic rewrite via compactOai (compaction/reset).
 */
export function attachSessionPersistListener(deps: {
  session: SessionContext
  persist: SessionPersist
}): { drain: () => Promise<void> } {
  const { session, persist } = deps
  let writeChain: Promise<void> = Promise.resolve()
  session.setMutationListener((m) => {
    if (m.type === 'append') {
      const msg = m.message
      // 2026-09-08 crash-recovery fix: shrink the hard-kill loss window to
      // the in-flight record. Tool calls, their results, and user turns are
      // flushed immediately; streaming assistant deltas keep the 200ms batch.
      const toolCalls = (msg as { tool_calls?: Array<unknown> }).tool_calls
      const flushNow = msg.role === 'user' || msg.role === 'tool' ||
        (msg.role === 'assistant' && !!toolCalls && toolCalls.length > 0)
      writeChain = writeChain
        .then(() => persist.appendOaiWithChecksum(msg, { flush: flushNow }))
        .then(() => {
          // P0-1 trace: verify every message triggers persistence
          debugLog(`[persist] append message role=${msg.role}`)
          // P1: Update metadata on every append. Snapshot once instead of
          // re-reading .meta.json per field — this runs on the hot append
          // path (N tool calls = N appends per turn).
          try {
            const snapshot = persist.loadMetadata()
            const patch: Partial<import('../context/types.js').SessionMetadata> = {}
            // TTSR injects guardrail reminders as <system-reminder>-wrapped
            // role:user messages; they are not real user turns (history-replay
            // also excludes them), so don't title/count them.
            const isReminder = typeof msg.content === 'string' && msg.content.startsWith('<system-reminder>')
            if (msg.role === 'user' && !isReminder) {
              if (typeof msg.content === 'string' && !snapshot?.title) {
                patch.title = msg.content.slice(0, 120)
              }
              patch.turnCount = (snapshot?.turnCount ?? 0) + 1
            }
            if (msg.role === 'assistant' && msg.tool_calls) {
              patch.toolCallCount = (snapshot?.toolCallCount ?? 0) + msg.tool_calls.length
            }
            const usage = session.getTotalUsage()
            // Usage.input_tokens is cache-INCLUSIVE by codebase convention
            // (see Usage in api/types.ts). Adding cache_read/cache_creation on
            // top double-counted the prompt exactly 2x for DeepSeek, where
            // input = hit + miss (cache-log 6bfc4465: meta 11.34M vs real 5.67M).
            patch.tokenUsage = {
              prompt: usage.input_tokens,
              completion: usage.output_tokens,
              total: usage.input_tokens + usage.output_tokens,
            }
            persist.updateMetadata(patch)
          } catch { /* metadata update failures are non-critical */ }
        })
        .catch(err => {
          // Persistence failures must not crash the agent loop.
          // Surface to stderr; the in-memory state is still authoritative.
          // eslint-disable-next-line no-console
          console.error('[session-persist] append failed:', err)
        })
    } else {
      // replace is rare (compaction/reset); do it asynchronously after the
      // current append queue drains so the rewrite reflects the latest state.
      writeChain = writeChain
        .then(() => persist.compactOaiAsync(m.messages))
        .catch(err => {
          // eslint-disable-next-line no-console
          console.error('[session-persist] compact failed:', err)
        })
    }
  })
  return { drain: async () => {
    await writeChain
    // P1 write-behind: drain must also flush the pending batch so /cd
    // migration, shutdown, and abort paths leave no unwritten tail.
    await persist.flushSessionBuffer()
  } }
}
