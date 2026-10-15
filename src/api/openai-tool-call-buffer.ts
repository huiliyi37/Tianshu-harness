import type { ToolCallName } from './tool-call-name.js'
import { ToolNameProtocolError } from './tool-call-name.js'

export interface ToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export interface ToolCallBuffer {
  id?: string
  type?: string
  function: { name?: string; arguments: string }
  nameState?: ToolCallName
  nameEvents?: Set<string>
}

export type ToolStreamEvent = {
  phase: 'drop-ambiguous' | 'reattach-by-id' | 'reattach-sole' | 'final-flush-empty' | 'name-repeat' | 'name-snapshot' | 'name-rejected'
  idx?: number
  fragments?: number
  candidateCount?: number
  reason?: string
  openBuffers?: number
  id?: string
  name?: string
  argsLen?: number
}

/** Explicit identities take precedence over the single-open-buffer fallback. */
export function resolveToolCallIndex(
  tc: ToolCallChunk,
  buffers: ReadonlyMap<number, ToolCallBuffer>,
  completedIds: ReadonlySet<string>,
  completedIndexes: ReadonlySet<number>,
  log: (event: ToolStreamEvent) => void,
): number | null {
  const rejectIdentity = (): never => {
    log({ phase: 'name-rejected', idx: tc.index, id: tc.id, reason: 'identity' })
    throw new ToolNameProtocolError('identity')
  }
  if (tc.id && completedIds.has(tc.id)) return null
  if (tc.index !== undefined) {
    if (!Number.isSafeInteger(tc.index) || tc.index < 0) rejectIdentity()
    if (!tc.id && !buffers.has(tc.index) && completedIndexes.has(tc.index)) return null
    for (const [index, buf] of buffers) {
      if ((index === tc.index && buf.id && tc.id && buf.id !== tc.id)
        || (index !== tc.index && tc.id && buf.id === tc.id)) rejectIdentity()
    }
    return tc.index
  }
  // Continuation chunk (typically a trailing-arguments delta after
  // finish_reason). Providers omit index here; reattach by identity.
  if (tc.id !== undefined) {
    for (const [idx, buf] of buffers) {
      if (buf.id === tc.id) {
        log({
          phase: 'reattach-by-id', openBuffers: buffers.size,
          id: tc.id, name: buf.function.name,
          argsLen: tc.function?.arguments?.length,
        })
        return idx
      }
    }
    // A new explicit ID is a new call, never a continuation of the sole
    // open buffer. A typed header may precede the first nonempty name.
    if (!tc.function?.name && tc.type !== 'function' && buffers.size > 0) rejectIdentity()
    let idx = 0
    while (buffers.has(idx) || completedIndexes.has(idx)) idx++
    return idx
  }
  // No identity on the chunk: if exactly one buffer is open, it must be the
  // target (the common single-call trailing-args case). With multiple open we
  // cannot know — drop rather than guess and pollute.
  if (buffers.size === 1) {
    const idx = buffers.keys().next().value!
    log({
      phase: 'reattach-sole', openBuffers: 1,
      argsLen: tc.function?.arguments?.length,
    })
    return idx
  }
  // Fallback: preserve historical behavior for the degenerate "no buffer open
  // yet" case (a first chunk with no index) by seeding slot 0; otherwise drop.
  if (buffers.size === 0) return 0
  // Ambiguous: multiple open buffers, no index/id. Dropping is the fail-safe
  // choice (one call's JSON may be incomplete) vs. the old `?? 0` which grafted
  // onto a different tool and corrupted both. Log so this provider pathology
  // is visible without RIVET_DEBUG.
  log({
    phase: 'drop-ambiguous', openBuffers: buffers.size,
    argsLen: tc.function?.arguments?.length,
  })
  return null
}
