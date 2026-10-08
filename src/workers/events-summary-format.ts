import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'

export const SUMMARY_VERSION = 2
export const BLOCK_BYTES = 256 * 1024
export const BLOCK_EVENTS = 500
export const MANIFEST_LIMIT = 1024 * 1024
export const SUMMARY_LIMIT = 8 * 1024 * 1024

export interface SourceStamp {
  dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string
}
export interface EventReference { seq: number; offset: number; length: number }
export interface ArtifactReference { seq: number; offset: number; id: string }
export interface BlockSummary {
  start: number; end: number; rawHash: string
  total: number; ordinary: number; firstSeq: number | null; lastSeq: number | null
  delegations: EventReference[]; artifacts: ArtifactReference[]
  queueTransitions: EventReference[]
}
export interface BlockReference {
  digest: string; start: number; end: number; total: number; ordinary: number
  firstSeq: number | null; lastSeq: number | null; delegations: number
  queueTransitions: number
}
export interface SummaryManifest {
  formatVersion: number; parserVersion: number; producerVersion: number
  snapshotId: string; source: SourceStamp; coveredBytes: number; sourceSize: number
  total: number; ordinary: number; delegations: number; blocks: BlockReference[]; digest: string
}

export function sourceStamp(stat: BigIntStats): SourceStamp {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }
}
export function sameSource(a: SourceStamp, b: SourceStamp): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
export function cacheableSource(s: SourceStamp): boolean {
  return s.ino !== '0' && BigInt(s.mtimeNs) % 1_000_000n !== 0n && BigInt(s.ctimeNs) % 1_000_000n !== 0n
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}
export function summaryDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export function manifestDigest(manifest: SummaryManifest): string {
  const { digest: _digest, ...content } = manifest
  return summaryDigest(content)
}
export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
export const hashName = (n: unknown): n is string => typeof n === 'string' && /^[a-f0-9]{64}$/.test(n)
function endpoints(total: number, first: unknown, last: unknown): void {
  check(total === 0 ? first === null && last === null : integer(first) && integer(last) && first <= last, 'Invalid summary seq range')
}

export function validateManifest(value: unknown): SummaryManifest {
  check(value && typeof value === 'object', 'Invalid summary manifest')
  const m = value as SummaryManifest
  check(m.formatVersion === SUMMARY_VERSION && m.parserVersion === SUMMARY_VERSION && m.producerVersion === SUMMARY_VERSION, 'Unknown summary version')
  check(typeof m.snapshotId === 'string' && /^[a-f0-9-]{36}$/.test(m.snapshotId), 'Invalid summary snapshot')
  check(m.source && typeof m.source === 'object', 'Invalid summary source')
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) check(typeof m.source[key] === 'string' && /^\d+$/.test(m.source[key]), 'Invalid summary stamp')
  check(integer(m.coveredBytes) && integer(m.sourceSize) && m.coveredBytes <= m.sourceSize && String(m.sourceSize) === m.source.size, 'Invalid summary coverage')
  check(integer(m.total) && integer(m.ordinary) && integer(m.delegations), 'Invalid summary count')
  check(Array.isArray(m.blocks) && hashName(m.digest) && manifestDigest(m) === m.digest, 'Invalid manifest digest')
  let end = 0, total = 0, ordinary = 0, delegations = 0
  let previous: number | null = null
  for (const b of m.blocks) {
    check(b && hashName(b.digest) && integer(b.start) && integer(b.end) && b.start === end && b.end > b.start && b.end <= m.coveredBytes, 'Invalid summary block range')
    check(integer(b.total) && integer(b.ordinary) && integer(b.delegations) && b.total === b.ordinary + b.delegations, 'Invalid block count')
    check(integer(b.queueTransitions) && b.queueTransitions <= b.ordinary, 'Invalid queue transition count')
    endpoints(b.total, b.firstSeq, b.lastSeq)
    if (b.firstSeq !== null) {
      check(previous === null || previous <= b.firstSeq, 'Unordered summary blocks')
      previous = b.lastSeq
    }
    end = b.end; total += b.total; ordinary += b.ordinary; delegations += b.delegations
    check(integer(total) && integer(ordinary) && integer(delegations), 'Summary count overflow')
  }
  check(end === m.coveredBytes && total === m.total && ordinary === m.ordinary && delegations === m.delegations, 'Summary totals do not match')
  return m
}

export function validateBlock(value: unknown, ref: BlockReference): BlockSummary {
  check(value && typeof value === 'object' && summaryDigest(value) === ref.digest, 'Invalid block digest')
  const b = value as BlockSummary
  check(b.start === ref.start && b.end === ref.end && b.total === ref.total && b.ordinary === ref.ordinary && b.firstSeq === ref.firstSeq && b.lastSeq === ref.lastSeq && hashName(b.rawHash), 'Block metadata does not match')
  check(Array.isArray(b.delegations) && Array.isArray(b.artifacts) && b.delegations.length === ref.delegations && b.artifacts.length <= b.ordinary, 'Invalid summary references')
  check(Array.isArray(b.queueTransitions) && b.queueTransitions.length === ref.queueTransitions, 'Invalid queue references')
  for (const [refs, delegation] of [[b.delegations, true], [b.artifacts, false], [b.queueTransitions, true]] as const) {
    let offset = b.start - 1
    let seq = b.firstSeq ?? 0
    for (const r of refs) {
      check(r && integer(r.offset) && r.offset >= b.start && r.offset < b.end && r.offset > offset && integer(r.seq) && r.seq >= seq && r.seq <= (b.lastSeq ?? -1), 'Invalid event reference')
      offset = r.offset; seq = r.seq
      if (delegation) {
        const d = r as EventReference
        check(integer(d.length) && d.length > 0 && integer(d.offset + d.length) && d.offset + d.length <= b.end, 'Invalid delegation length')
      } else check(typeof (r as ArtifactReference).id === 'string', 'Invalid artifact ID')
    }
  }
  return b
}

export function blockReference(block: BlockSummary): BlockReference {
  return { digest: summaryDigest(block), start: block.start, end: block.end, total: block.total, ordinary: block.ordinary,
    firstSeq: block.firstSeq, lastSeq: block.lastSeq, delegations: block.delegations.length, queueTransitions: block.queueTransitions.length }
}
