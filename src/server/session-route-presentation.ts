import type { PlanDocument } from '../plan/plan-store.js'
import type { SseStream } from './sse-stream.js'

export function planSummary(p: PlanDocument) {
  return {
    slug: p.slug,
    completion: p.completion,
    title: p.title,
    status: p.status,
    path: p.path,
    createdAt: p.createdAt instanceof Date ? p.createdAt.getTime() : p.createdAt,
    approvedAt: p.approvedAt instanceof Date ? p.approvedAt.getTime() : p.approvedAt,
    options: p.options,
    model: p.model,
    modelTier: p.modelTier,
  }
}

const REPLAY_SLICE_EVENTS = 200
const REPLAY_SLICE_MS = 4

export async function sendReplayTimeSliced(
  res: import('node:http').ServerResponse,
  sse: SseStream,
  events: ReadonlyArray<{ type: string }>,
): Promise<void> {
  const canCork = typeof res.cork === 'function'
  let index = 0
  while (index < events.length && !sse.isClosed()) {
    const startedAt = performance.now()
    let sent = 0
    if (canCork) res.cork()
    try {
      while (
        index < events.length &&
        sent < REPLAY_SLICE_EVENTS &&
        (sent === 0 || performance.now() - startedAt < REPLAY_SLICE_MS)
      ) {
        const event = events[index]!
        sse.send(event.type, event)
        index++
        sent++
        if (sse.isClosed()) break
      }
    } finally {
      if (canCork) res.uncork()
    }
    if (index < events.length && !sse.isClosed()) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}
