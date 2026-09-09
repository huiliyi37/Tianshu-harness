/**
 * CPU-bound pure functions offloaded to a worker_threads pool.
 *
 * These are the single source of truth for diff computation — shared between
 * the worker thread (4s timeout) and the main-thread inline fallback (1s
 * timeout). The jsdiff functions are synchronous and O((N+M)·D); running them
 * in a worker keeps the TUI event loop alive during heavy rewrites.
 *
 * No side effects, no process/env — safe to run in any context.
 */

import { createTwoFilesPatch, structuredPatch, diffLines } from 'diff'

// ── Unified diff (for `buildFileDiff`) ──

export function diffUnifiedRaw(
  relPath: string,
  before: string,
  after: string,
  timeout: number,
): string | undefined {
  return createTwoFilesPatch(relPath, relPath, before, after, '', '', {
    context: 3,
    timeout,
  })
}

// ── Structured patch hunks (for `computeChangedLineRanges`) ──

export interface RawHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export function diffStructuredRaw(
  before: string,
  after: string,
  timeout: number,
): { hunks: RawHunk[] } | undefined {
  const patch = structuredPatch('a', 'a', before, after, '', '', {
    context: 0,
    timeout,
  })
  if (!patch) return undefined
  return { hunks: patch.hunks as RawHunk[] }
}

// ── Line-level diff (for `getDiffStats`) ──

export interface RawChange {
  added?: boolean
  removed?: boolean
  count?: number
}

export function diffLinesRaw(
  oldContent: string,
  newContent: string,
  timeout: number,
): RawChange[] | undefined {
  return diffLines(oldContent, newContent, { timeout }) as RawChange[] | undefined
}

// ── Session event-log parsing (reconnect replay) ──

/** Minimal structural shape of a persisted session event. Kept local so this
 *  module stays dependency-free (worker bundles it standalone). */
export interface RawSessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

/**
 * Parse an events.jsonl text into sorted events, dropping corrupt/partial
 * lines (crash mid-write). Single source of truth shared by the sync read
 * path and the worker-offloaded reconnect replay — JSON.parse over a large
 * log is exactly the kind of synchronous stretch that starves the sidecar
 * event loop (SSE pings included), so replays run it off-thread.
 */
/** 尾部读的回传形状——`events` 已按内存环容量截断，其余字段是「被截掉的头部
 *  里仍然需要的那点信息」，避免调用方为了拿它们而要求全量。 */
export interface RawEventsTail {
  /** 尾部 maxEvents 条（日志更短时即全部）。 */
  events: RawSessionEvent[]
  /** 磁盘日志最早 seq（空日志为 0）——前端据此判断头部是否被截。 */
  diskFirstSeq: number
  /** 磁盘日志最大 seq（空日志为 0）。 */
  lastSeq: number
  /** 全量日志里出现过的 artifact id——去重集必须完整，否则被截头部的
   *  artifact 会在重放时被重新公告。 */
  artifactIds: string[]
  /** 全量事件数（0 用于区分空日志与「有日志但全是坏行」）。 */
  total: number
}

/**
 * 与 parseEventsJsonlRaw 同源，但只回传内存环留得下的尾部。
 *
 * parse 本身在 worker 里做多少都不占主线程，真正的开销是把结果搬过线程边界：
 * structured clone 的成本与条数成正比（实测 43,717 条 139ms / 5,000 条 14ms）。
 * 调用方拿到全量后立刻丢掉 90%，那份搬运是纯浪费——所以截断挪到这一侧做。
 */
export function parseEventsTailRaw(text: string, maxEvents: number): RawEventsTail {
  const all = parseEventsJsonlRaw(text)
  if (all.length === 0) {
    return { events: [], diskFirstSeq: 0, lastSeq: 0, artifactIds: [], total: 0 }
  }
  const artifactIds: string[] = []
  for (const e of all) {
    if (e.type === 'artifact') artifactIds.push(String(e.data.id))
  }
  return {
    // delegation 事件豁免截尾（M1：stale 对账与回放依赖它们完整；被截尾的
    // 早期 running 节点对账不可见，回放永久卡「运行中」）。与
    // session-manager.trimEventRing 同语义——尾部窗口 + 保留 delegation。
    events: tailExemptDelegation(all, maxEvents),
    diskFirstSeq: all[0]!.seq,
    lastSeq: all[all.length - 1]!.seq,
    artifactIds,
    total: all.length,
  }
}

/** 保留尾部 maxEvents 条，但 delegation 事件永远保留（从头部淘汰普通事件）。 */
function tailExemptDelegation(events: RawSessionEvent[], maxEvents: number): RawSessionEvent[] {
  if (events.length <= maxEvents) return events
  const overflow = events.length - maxEvents
  const kept: RawSessionEvent[] = []
  let dropped = 0
  for (const e of events) {
    if (dropped < overflow && e.type !== 'delegation') {
      dropped++
      continue
    }
    kept.push(e)
  }
  return kept
}

export function parseEventsJsonlRaw(text: string): RawSessionEvent[] {
  const events: RawSessionEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as RawSessionEvent
      if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
        events.push(parsed)
      }
    } catch {
      // corrupt/partial line (e.g. crash mid-write) — drop it, keep the rest
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

// ── esbuild 语法解析（写工具 syntax-check 的 worker 通道）──
// 主线程永不 require esbuild（issue #61 族：Windows AV/EDR 下首次加载原生
// 二进制可阻塞事件循环数分钟——worker 线程内阻塞只影响本任务，主线程的
// 软超时照常生效并降级）。与上面纯函数不同：本任务带模块级缓存的副作用。
import { createRequire } from 'node:module'

interface EsbuildLike {
  transform(content: string, options: unknown): Promise<unknown>
}
let _esbuild: EsbuildLike | null | undefined

export async function esbuildTransformRaw(content: string, options: unknown): Promise<true> {
  if (_esbuild === undefined) {
    try {
      const req = createRequire(import.meta.url)
      _esbuild = req('esbuild') as EsbuildLike
    } catch {
      _esbuild = null
    }
  }
  if (!_esbuild) throw new Error('esbuild unavailable in worker')
  await _esbuild.transform(content, options)
  return true
}
