import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
// @ts-ignore Native development workers load TypeScript directly.
import { DelegationStateIndex } from './delegation-state.ts'
import type { RawEventsTail, RawSessionEvent } from './cpu-tasks.js'

interface OrderedEvent { event: RawSessionEvent; order: number }
const compare = (a: OrderedEvent, b: OrderedEvent): number => a.event.seq - b.event.seq || a.order - b.order

export const DEFAULT_TAIL_BYTES = 64 * 1024 * 1024
const byteSize = (item: OrderedEvent): number => Buffer.byteLength(JSON.stringify(item.event), 'utf8')

/** A contiguous suffix under both count and UTF-8 budgets, including unordered input. */
class EventHeap {
  private items: OrderedEvent[] = []
  private bytes = 0
  private discarded: OrderedEvent | undefined
  private readonly capacity: number
  private readonly maxBytes: number
  constructor(capacity: number, maxBytes: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid event tail budget')
    this.capacity = capacity; this.maxBytes = maxBytes
  }
  add(item: OrderedEvent): void {
    if (this.discarded && compare(item, this.discarded) <= 0) return
    let i = this.items.length
    this.items.push(item); this.bytes += byteSize(item)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (compare(this.items[parent]!, item) <= 0) break
      this.items[i] = this.items[parent]!; i = parent
    }
    this.items[i] = item
    while (this.items.length > this.capacity || (this.maxBytes > 0 && this.bytes > this.maxBytes)) this.removeOldest()
  }
  private removeOldest(): void {
    const oldest = this.items[0]!, last = this.items.pop()!
    this.bytes -= byteSize(oldest); this.discarded = oldest
    if (!this.items.length) return
    let i = 0
    while (i * 2 + 1 < this.items.length) {
      let child = i * 2 + 1
      if (child + 1 < this.items.length && compare(this.items[child + 1]!, this.items[child]!) < 0) child++
      if (compare(last, this.items[child]!) <= 0) break
      this.items[i] = this.items[child]!; i = child
    }
    this.items[i] = last
  }
  sorted(): OrderedEvent[] { return this.items.sort(compare) }
}

/** Retain only the replay window and the metadata required from its discarded head. */
export class TailAccumulator {
  private readonly ordinary: EventHeap
  private readonly delegationState = new DelegationStateIndex()
  private readonly queueState = new Map<string, { seq: number; order: number; pending: boolean }>()
  private artifacts: Array<{ seq: number; order: number; id: string }> = []
  private total = 0
  private firstSeq = Infinity
  private lastSeq = -Infinity

  constructor(maxEvents: number, maxEventBytes = DEFAULT_TAIL_BYTES) {
    this.ordinary = new EventHeap(maxEvents, maxEventBytes)
  }

  addLine(line: string): void {
    const event = parseEventLine(line)
    if (event) this.addEvent(event)
  }

  addEvent(event: RawSessionEvent): void {
    const order = this.total++
    this.firstSeq = Math.min(this.firstSeq, event.seq)
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    if (event.type === 'artifact') this.artifacts.push({ seq: event.seq, order, id: String(event.data.id) })
    const item = { event, order }
    this.delegationState.add(event)
    const laneId = event.data?.laneId
    if (typeof laneId === 'string' && (event.type === 'queue_pending' || event.type === 'queue_status')) {
      const previous = this.queueState.get(laneId)
      if (!previous || previous.seq <= event.seq) this.queueState.set(laneId, { seq: event.seq, order, pending: event.type === 'queue_pending' })
    }
    this.ordinary.add(item)
  }

  finish(): RawEventsTail {
    const events = this.ordinary.sorted().map(({ event }) => event)
    this.artifacts.sort((a, b) => a.seq - b.seq || a.order - b.order)
    return {
      events,
      ...(this.total > 0 ? { delegationState: this.delegationState.snapshot() } : {}),
      ...(this.total > 0 ? { pendingQueueLaneIds: [...this.queueState].filter(([, state]) => state.pending)
        .sort((a, b) => a[1].seq - b[1].seq || a[1].order - b[1].order).map(([id]) => id) } : {}),
      diskFirstSeq: this.total === 0 ? 0 : this.firstSeq,
      lastSeq: this.total === 0 ? 0 : this.lastSeq,
      artifactIds: this.artifacts.map(a => a.id),
      total: this.total,
    }
  }
}

export function parseEventLine(line: string): RawSessionEvent | undefined {
  let event: RawSessionEvent
  try { event = JSON.parse(line.trim()) as RawSessionEvent } catch { return }
  if (event && typeof event.seq === 'number' && typeof event.type === 'string') return event
  return undefined
}

export type EventFile = Awaited<ReturnType<typeof open>>

/** Byte-exact lines for hashing and offsets; includes LF, preserves invalid UTF-8. */
export async function scanEventLines(
  handle: EventFile, start: number, end: number,
  consume: (raw: Buffer, offset: number, complete: boolean) => void | Promise<void>,
  onRead?: (bytes: number) => void,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let pieces: Buffer[] = []
  let lineStart = start
  let position = start
  while (position < end) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position)
    if (bytesRead === 0) throw new Error('Event log changed while reading')
    onRead?.(bytesRead)
    let cursor = 0
    for (;;) {
      const nl = buffer.indexOf(0x0a, cursor)
      if (nl < 0 || nl >= bytesRead) break
      const part = buffer.subarray(cursor, nl + 1)
      const raw = pieces.length ? Buffer.concat([...pieces, part]) : part
      const result = consume(raw, lineStart, true)
      if (result) await result
      pieces = []
      lineStart = position + nl + 1
      cursor = nl + 1
    }
    if (cursor < bytesRead) pieces.push(Buffer.from(buffer.subarray(cursor, bytesRead)))
    position += bytesRead
    await yieldToLoop()
  }
  if (pieces.length) await consume(Buffer.concat(pieces), lineStart, false)
}

export async function readEventsTailSnapshot(
  handle: EventFile, size: number, maxEvents: number,
  consume?: (raw: Buffer, offset: number, complete: boolean, event: RawSessionEvent | undefined) => void | Promise<void>,
  onRead?: (bytes: number) => void,
  maxEventBytes = DEFAULT_TAIL_BYTES,
): Promise<RawEventsTail> {
  const tail = new TailAccumulator(maxEvents, maxEventBytes)
  await scanEventLines(handle, 0, size, (raw, offset, complete) => {
    const event = parseEventLine(raw.toString('utf8'))
    if (event) tail.addEvent(event)
    return consume?.(raw, offset, complete, event)
  }, onRead)
  return tail.finish()
}

/**
 * Scan a fixed file snapshot in 64 KiB chunks; never materialize the whole log.
 * Memory is the retained events + artifact IDs + one chunk + the longest line.
 * Delegation lifecycle identity is retained separately without activity payloads.
 */
export async function readEventsTailRaw(file: string, maxEvents: number, maxEventBytes = DEFAULT_TAIL_BYTES): Promise<RawEventsTail> {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) throw new Error('Invalid event tail capacity')
  const tail = new TailAccumulator(maxEvents, maxEventBytes)
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(file, 'r') } catch { return tail.finish() }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return tail.finish()
    const size = stat.size
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const decoder = new StringDecoder('utf8')
    let carry = ''
    let position = 0
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (bytesRead === 0) break
      position += bytesRead
      const text = carry + decoder.write(buffer.subarray(0, bytesRead))
      let start = 0
      let end: number
      while ((end = text.indexOf('\n', start)) !== -1) {
        tail.addLine(text.slice(start, end))
        start = end + 1
      }
      carry = text.slice(start)
      await yieldToLoop()
    }
    tail.addLine(carry + decoder.end())
    return tail.finish()
  } finally {
    await handle.close()
  }
}
