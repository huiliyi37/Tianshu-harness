// @ts-ignore Native development workers load TypeScript directly.
import { DelegationStateIndex } from './delegation-state.ts'
import { open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
// @ts-ignore — native source worker imports.
import { parseEventLine, scanEventLines, readEventsTailSnapshot, TailAccumulator } from './events-tail.ts'
// @ts-ignore — native source worker imports.
import { BLOCK_BYTES, BLOCK_EVENTS, SUMMARY_LIMIT, SUMMARY_VERSION, blockReference, cacheableSource, check, manifestDigest, sameSource, sourceStamp, summaryDigest } from './events-summary-format.ts'
// @ts-ignore — native source worker imports.
import { cachedSummary, cacheSummary, clearEventsSummaryCache, loadSummaryBlocks, publishSummaryBlock, publishSummaryManifest, readSummaryManifest } from './events-summary-store.ts'
import type { EventFile } from './events-tail.js'
import type { RawEventsTail, RawSessionEvent } from './cpu-tasks.js'
import type { ArtifactReference, BlockSummary, SourceStamp, SummaryManifest } from './events-summary-format.js'
import type { LoadedSummary } from './events-summary-store.js'

export interface SummaryMetrics {
  mode: 'scan' | 'cold' | 'warm' | 'extended'
  validationReason: string; scannedLogBytes: number; parsedLogBytes: number; indexBytes: number; rebuilt: boolean
}
export interface IndexedEventsTail { tail: RawEventsTail; metrics: SummaryMetrics }
export interface SummaryReadOptions { strict?: boolean; maxEventBytes?: number }
const running = new Map<string, Promise<unknown>>()
const rejected = new Map<string, string>()

function lastBlockSeq(blocks: BlockSummary[]): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.lastSeq !== null) return blocks[i]!.lastSeq
  return null
}

class BlockCollector {
  readonly block: BlockSummary
  private hash = createHash('sha256')
  constructor(start: number) {
    this.block = { start, end: start, rawHash: '', total: 0, ordinary: 0, firstSeq: null, lastSeq: null, delegations: [], artifacts: [], queueTransitions: [] }
  }
  add(raw: Buffer, offset: number, event: RawSessionEvent | undefined): void {
    const b = this.block
    check(offset === b.end, 'Non-contiguous log block')
    this.hash.update(raw); b.end += raw.length
    if (!event) return
    check(Number.isSafeInteger(event.seq) && event.seq >= 0 && (b.lastSeq === null || b.lastSeq <= event.seq), 'Log seq is not eligible for summary')
    b.firstSeq ??= event.seq; b.lastSeq = event.seq; b.total++
    if (event.type === 'delegation') b.delegations.push({ seq: event.seq, offset, length: raw.length })
    else b.ordinary++
    if (event.type === 'artifact') b.artifacts.push({ seq: event.seq, offset, id: String(event.data.id) })
    if (event.type === 'queue_pending' || event.type === 'queue_status') b.queueTransitions.push({ seq: event.seq, offset, length: raw.length })
  }
  finish(): BlockSummary { this.block.rawHash = this.hash.digest('hex'); return this.block }
}

class SummaryBuilder {
  readonly blocks: BlockSummary[]
  enabled = true
  private current: BlockCollector
  private file: string
  private bytes: number
  private lastSeq: number | null
  constructor(file: string, prefix: BlockSummary[] = []) {
    this.file = file; this.blocks = [...prefix]
    this.current = new BlockCollector(prefix.at(-1)?.end ?? 0)
    this.bytes = prefix.reduce((sum, b) => sum + Buffer.byteLength(JSON.stringify(b)), 0)
    this.lastSeq = lastBlockSeq(prefix)
  }
  async add(raw: Buffer, offset: number, complete: boolean, event: RawSessionEvent | undefined): Promise<void> {
    if (!this.enabled || !complete) return
    try {
      if (event) check(this.lastSeq === null || this.lastSeq <= event.seq, 'Unordered log blocks')
      this.current.add(raw, offset, event)
      if (event) this.lastSeq = event.seq
      if (this.current.block.end - this.current.block.start < BLOCK_BYTES && this.current.block.total < BLOCK_EVENTS) return
      const block = this.current.finish()
      this.bytes += Buffer.byteLength(JSON.stringify(block))
      check(this.bytes <= SUMMARY_LIMIT, 'Summary exceeds size budget')
      await publishSummaryBlock(this.file, block)
      this.blocks.push(block); this.current = new BlockCollector(block.end)
    } catch { this.enabled = false }
  }
  async publish(source: SourceStamp): Promise<LoadedSummary | undefined> {
    if (!this.enabled) return undefined
    const refs = this.blocks.map(blockReference)
    const manifest: SummaryManifest = {
      formatVersion: SUMMARY_VERSION, parserVersion: SUMMARY_VERSION, producerVersion: SUMMARY_VERSION,
      snapshotId: randomUUID(), source, coveredBytes: refs.at(-1)?.end ?? 0, sourceSize: Number(source.size),
      total: refs.reduce((sum, b) => sum + b.total, 0), ordinary: refs.reduce((sum, b) => sum + b.ordinary, 0),
      delegations: refs.reduce((sum, b) => sum + b.delegations, 0), blocks: refs, digest: '',
    }
    manifest.digest = manifestDigest(manifest)
    const bytes = this.bytes + Buffer.byteLength(JSON.stringify(manifest))
    if (bytes > SUMMARY_LIMIT) return undefined
    await publishSummaryManifest(this.file, manifest)
    return { manifest, blocks: this.blocks, bytes }
  }
}

async function verifyRawBlock(handle: EventFile, b: BlockSummary, metrics: SummaryMetrics): Promise<void> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = b.start
  while (position < b.end) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, b.end - position), position)
    check(bytesRead > 0, 'Log block truncated')
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; metrics.scannedLogBytes += bytesRead
    await yieldToLoop()
  }
  check(hash.digest('hex') === b.rawHash, 'Log block hash mismatch')
}

function metrics(): SummaryMetrics {
  return { mode: 'scan', validationReason: 'missing', scannedLogBytes: 0, parsedLogBytes: 0, indexBytes: 0, rebuilt: false }
}
const reason = (error: unknown): string => error instanceof Error ? error.message : 'Summary unavailable'

async function scanAndBuild(handle: EventFile, file: string, source: SourceStamp, maxEvents: number, m: SummaryMetrics, maxEventBytes?: number): Promise<RawEventsTail> {
  m.mode = 'scan'
  clearEventsSummaryCache(file)
  const builder = new SummaryBuilder(file)
  const tail = await readEventsTailSnapshot(handle, Number(source.size), maxEvents,
    (raw, offset, complete, event) => builder.add(raw, offset, complete, event),
    n => { m.scannedLogBytes += n; m.parsedLogBytes += n }, maxEventBytes)
  if (sameSource(source, sourceStamp(await handle.stat({ bigint: true })))) {
    try {
      const published = await builder.publish(source)
      if (published) {
        rejected.delete(file)
        m.rebuilt = true; m.indexBytes = published.bytes
        if (cacheableSource(source) && sameSource(source, sourceStamp(await handle.stat({ bigint: true })))) cacheSummary(file, source, published)
      }
    } catch { /* A cache failure never discards an already scanned tail. */ }
  }
  return tail
}

async function readIndexedSnapshot(handle: EventFile, file: string, source: SourceStamp, maxEvents: number, options: SummaryReadOptions, m: SummaryMetrics): Promise<RawEventsTail> {
  const { manifest, bytes } = await readSummaryManifest(file)
  check(rejected.get(file) !== manifest.digest, 'Summary failed semantic audit')
  check(manifest.source.dev === source.dev && manifest.source.ino === source.ino && manifest.coveredBytes <= Number(source.size), 'Summary belongs to another log generation')
  const warm = !options.strict && cacheableSource(source) ? cachedSummary(file, source, manifest.digest) : undefined
  const loaded = warm ?? await loadSummaryBlocks(file, manifest, bytes)
  m.indexBytes = loaded.bytes; m.mode = warm ? 'warm' : 'cold'; m.validationReason = warm ? 'validated stamp' : 'verified raw prefix'
  if (!warm) for (const b of loaded.blocks) await verifyRawBlock(handle, b, m)

  const builder = new SummaryBuilder(file, loaded.blocks)
  const suffixArtifacts: ArtifactReference[] = []
  let suffixTotal = 0
  let suffixFirst: number | null = null
  let last = lastBlockSeq(loaded.blocks)
  await scanEventLines(handle, manifest.coveredBytes, Number(source.size), (raw, offset, complete) => {
    m.parsedLogBytes += raw.length
    const event = parseEventLine(raw.toString('utf8'))
    if (event) {
      check(Number.isSafeInteger(event.seq) && event.seq >= 0 && (last === null || last <= event.seq), 'Active suffix is unordered')
      suffixFirst ??= event.seq; last = event.seq; suffixTotal++
      if (event.type === 'artifact') suffixArtifacts.push({ seq: event.seq, offset, id: String(event.data.id) })
    }
    return builder.add(raw, offset, complete, event)
  }, n => { m.scannedLogBytes += n })

  let wanted = Math.max(0, maxEvents - suffixTotal)
  const selected = new Set<number>()
  for (let i = loaded.blocks.length - 1; i >= 0; i--) {
    const b = loaded.blocks[i]!
    if (wanted > 0 && b.total > 0) { selected.add(i); wanted -= b.total }
    if (b.delegations.length) selected.add(i)
    if (b.queueTransitions.length) selected.add(i)
  }
  const tail = new TailAccumulator(maxEvents, options.maxEventBytes)
  const lifecycle = new DelegationStateIndex()
  for (const i of [...selected].sort((a, b) => a - b)) {
    const expected = loaded.blocks[i]!
    const collector = new BlockCollector(expected.start)
    await scanEventLines(handle, expected.start, expected.end, (raw, offset, complete) => {
      check(complete, 'Summary block is not line aligned')
      m.parsedLogBytes += raw.length
      const event = parseEventLine(raw.toString('utf8'))
      collector.add(raw, offset, event)
      if (event) { tail.addEvent(event); lifecycle.add(event) }
    }, n => { m.scannedLogBytes += n })
    check(summaryDigest(collector.finish()) === manifest.blocks[i]!.digest, 'Summary semantics do not match log block')
  }
  // Feed the suffix in file order, including transitions outside the payload budget.
  await scanEventLines(handle, manifest.coveredBytes, Number(source.size), (raw) => {
    m.parsedLogBytes += raw.length
    const event = parseEventLine(raw.toString('utf8')); if (event) { tail.addEvent(event); lifecycle.add(event) }
  }, n => { m.scannedLogBytes += n })
  const result = tail.finish()
  result.delegationState = lifecycle.snapshot()
  result.total = manifest.total + suffixTotal
  result.diskFirstSeq = loaded.blocks.find(b => b.firstSeq !== null)?.firstSeq ?? suffixFirst ?? 0
  result.lastSeq = last ?? 0
  result.artifactIds = [...loaded.blocks.flatMap(b => b.artifacts), ...suffixArtifacts].map(a => a.id)
  check(sameSource(source, sourceStamp(await handle.stat({ bigint: true }))), 'Log changed during indexed read')

  let current: LoadedSummary = loaded
  if (!sameSource(manifest.source, source) || builder.blocks.length !== loaded.blocks.length) {
    try {
      const published = await builder.publish(source)
      if (published) { current = published; m.mode = 'extended'; m.rebuilt = true; m.indexBytes = published.bytes }
    } catch { /* Read succeeded; a publication failure only disables reuse. */ }
  }
  if (cacheableSource(source) && sameSource(source, sourceStamp(await handle.stat({ bigint: true })))) cacheSummary(file, source, current)
  return result
}

async function readOne(file: string, maxEvents: number, options: SummaryReadOptions): Promise<IndexedEventsTail> {
  check(Number.isSafeInteger(maxEvents) && maxEvents >= 0, 'Invalid event tail capacity')
  const m = metrics()
  let handle: EventFile
  try { handle = await open(file, 'r') } catch { return { tail: new TailAccumulator(maxEvents, options.maxEventBytes).finish(), metrics: m } }
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) return { tail: new TailAccumulator(maxEvents, options.maxEventBytes).finish(), metrics: m }
    const source = sourceStamp(stat)
    let tail: RawEventsTail
    try { tail = await readIndexedSnapshot(handle, file, source, maxEvents, options, m) }
    catch (error) {
      m.validationReason = reason(error)
      // Reuse the FD and bound, preserving the generation across a path rename.
      const now = sourceStamp(await handle.stat({ bigint: true }))
      if (!sameSource(source, now)) throw new Error('Log changed during indexed read')
      tail = await scanAndBuild(handle, file, source, maxEvents, m, options.maxEventBytes)
    }
    return { tail, metrics: m }
  } finally { await handle.close() }
}

/** Serializes builders per file in this process; foreign writers still require raw verification. */
export async function readEventsTailIndexed(file: string, maxEvents: number, options: SummaryReadOptions = {}): Promise<IndexedEventsTail> {
  const previous = running.get(file)
  const task = (async () => {
    await previous?.catch(() => {})
    try { return await readOne(file, maxEvents, options) }
    catch (error) {
      if (reason(error) !== 'Log changed during indexed read') throw error
      // One bounded retry; persistence retains its plain streaming fallback.
      return readOne(file, maxEvents, { ...options, strict: true })
    }
  })()
  running.set(file, task)
  try { return await task } finally { if (running.get(file) === task) running.delete(file) }
}

/** Re-derive every covered block, even if a damaged summary has a recomputed checksum. */
export async function auditEventsSummary(file: string): Promise<{ valid: boolean; coveredBytes: number; reason?: string }> {
  let handle: EventFile | undefined
  let digest: string | undefined
  try {
    handle = await open(file, 'r')
    const before = sourceStamp(await handle.stat({ bigint: true }))
    const { manifest, bytes } = await readSummaryManifest(file)
    digest = manifest.digest
    check(manifest.source.dev === before.dev && manifest.source.ino === before.ino && manifest.coveredBytes <= Number(before.size), 'Summary belongs to another log generation')
    const loaded = await loadSummaryBlocks(file, manifest, bytes)
    for (let i = 0; i < loaded.blocks.length; i++) {
      const b = loaded.blocks[i]!
      const collector = new BlockCollector(b.start)
      await scanEventLines(handle, b.start, b.end, (raw, offset, complete) => {
        check(complete, 'Summary block is not line aligned')
        collector.add(raw, offset, parseEventLine(raw.toString('utf8')))
      })
      check(summaryDigest(collector.finish()) === manifest.blocks[i]!.digest, `Summary semantics mismatch at block ${i}`)
    }
    check(sameSource(before, sourceStamp(await handle.stat({ bigint: true }))), 'Log changed during audit')
    return { valid: true, coveredBytes: manifest.coveredBytes }
  } catch (error) {
    clearEventsSummaryCache(file)
    if (digest) {
      rejected.delete(file); rejected.set(file, digest)
      if (rejected.size > 16) rejected.delete(rejected.keys().next().value!)
    }
    return { valid: false, coveredBytes: 0, reason: reason(error) }
  }
  finally { await handle?.close() }
}
