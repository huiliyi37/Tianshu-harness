import { createHash } from 'node:crypto'

export type TraceEventKind = 'model' | 'tool' | 'verification' | 'checkpoint' | 'cache'
export type TraceEventStatus = 'running' | 'passed' | 'failed' | 'blocked'
export type DoomLoopLevel = 'none' | 'warn' | 'blocked'

export interface TraceEvent {
  id: string
  turn: number
  kind: TraceEventKind
  name: string
  status: TraceEventStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  rawPath?: string
  predictedSuccess?: boolean
}

export type TraceEventStartInput = Pick<TraceEvent, 'id' | 'turn' | 'kind' | 'name' | 'startedAt' | 'summary' | 'predictedSuccess'>

export interface TraceStore {
  maxEvents: number
  events: TraceEvent[]
  toolFingerprints: string[]
  toolNameHistory?: string[]
  /** bash 命令类指纹（归一化后的命令类，如 "git:status·success"）。
   *  精确指纹对 sed/head/python/tee 变体免疫——每个变体都是新 hash，
   *  doom-loop 检测器全程不拦（会话 43443098：28 次 git status 变体零拦截）。
   *  类指纹把同一命令类的变体归并，配合 getClassDoomLoopLevel 的保守阈值拦截。 */
  bashClassFingerprints?: string[]
}

export function createTraceStore(maxEvents = 50): TraceStore {
  return { maxEvents, events: [], toolFingerprints: [] }
}

function capEvents(store: TraceStore, events: TraceEvent[]): TraceEvent[] {
  return events.slice(-store.maxEvents)
}

export function recordTraceEvent(store: TraceStore, event: TraceEvent): TraceStore {
  return { ...store, events: capEvents(store, [...store.events, event]) }
}

export function startTraceEvent(
  store: TraceStore,
  input: TraceEventStartInput,
): TraceStore {
  return recordTraceEvent(store, { ...input, status: 'running' })
}

export function finishTraceEvent(
  store: TraceStore,
  id: string,
  update: { status: TraceEventStatus; endedAt: number; summary?: string; rawPath?: string },
): TraceStore {
  const events = store.events.map(event => {
    if (event.id !== id) return event
    return {
      ...event,
      ...update,
      durationMs: Math.max(0, update.endedAt - event.startedAt),
    }
  })
  return { ...store, events }
}

function sortedStringify(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key]
    sorted[key] = val && typeof val === 'object' && !Array.isArray(val)
      ? JSON.parse(sortedStringify(val as Record<string, unknown>))
      : val
  }
  return JSON.stringify(sorted)
}

export function fingerprintToolCall(
  name: string,
  input: Record<string, unknown>,
  outputClass: string,
): string {
  const payload = sortedStringify({ name, input, outputClass })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** Binaries whose first non-flag argument is a subcommand worth distinguishing
 *  (npm test ≠ npm install). Keeps class granularity coarse enough to merge
 *  variants but fine enough to avoid flagging normal multi-step workflows. */
const SUBCOMMAND_BINARIES = new Set(['git', 'npm', 'pnpm', 'yarn', 'cargo', 'docker', 'kubectl', 'go', 'npx'])

/**
 * Normalize a bash command string into a command class.
 *
 * Doom-loop 变体归并：`git status --porcelain | sed -n 1,50p`、
 * `git status --porcelain | head -100`、`git status --porcelain | tee /tmp/s`
 * 全部归并为 "git:status"。git 出现在管道/子串中也能匹配（python -c 内嵌同理）。
 */
export function bashCommandClass(command: string): string {
  // git anywhere in the command dominates — pipes/tee/embedding included.
  const gitMatch = command.match(/\bgit\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/)
  if (gitMatch) return `git:${gitMatch[1]}`

  const tokens = command.trim().split(/\s+/)
  let i = 0
  // Skip leading env assignments (FOO=bar cmd ...)
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const bin = (tokens[i] ?? '').replace(/^.*\//, '')
  if (!bin) return 'empty'
  const next = tokens[i + 1]
  if (SUBCOMMAND_BINARIES.has(bin) && next && !next.startsWith('-')) {
    return `${bin}:${next}`
  }
  return bin
}

/**
 * Class fingerprint for a tool call. Only bash gets one — bash is the
 * text-parsing escape hatch where the model mutates flags/pipes to "retry";
 * structured tools (read_file/grep/...) legitimately repeat with new inputs.
 *
 * Only failing bash commands produce a class fingerprint. Successful
 * exploration commands (grep, find, cat, npx tsc, etc.) are legitimate
 * repetition, not a doom loop — 20 unique successful grep patterns must NOT
 * be mistaken for the same tool failing repeatedly.
 * Returns null for non-bash tools or successful bash commands.
 */
export function fingerprintToolClass(
  name: string,
  input: Record<string, unknown>,
  outputClass: string,
): string | null {
  if (name !== 'bash') return null
  // Successful bash commands are normal exploration — don't class-track them.
  if (outputClass === 'success') return null
  const command = typeof input.command === 'string' ? input.command : ''
  return `${bashCommandClass(command)}·${outputClass}`
}

export function recordToolFingerprint(store: TraceStore, fingerprint: string, classFingerprint?: string | null): TraceStore {
  return {
    ...store,
    toolFingerprints: [...store.toolFingerprints, fingerprint].slice(-20),
    ...(classFingerprint
      ? { bashClassFingerprints: [...(store.bashClassFingerprints ?? []), classFingerprint].slice(-20) }
      : {}),
  }
}

export function recordToolNamedFingerprint(
  store: TraceStore,
  fingerprint: string,
  toolName: string,
): TraceStore {
  return {
    ...store,
    toolFingerprints: [...store.toolFingerprints, fingerprint].slice(-20),
    toolNameHistory: [...(store.toolNameHistory ?? []), toolName].slice(-20),
  }
}

export type ToolStormLevel = 'none' | 'warn' | 'storm'

/**
 * Detects "tool storms" — consecutive calls to the same tool TYPE
 * regardless of input parameters (different grep queries still count).
 *
 * Thresholds:
 * - 4+ consecutive same tool type → warn
 * - 8+ consecutive same tool type → storm
 */
export function getToolStormLevel(toolNames: string[]): ToolStormLevel {
  if (toolNames.length < 4) return 'none'

  const recent = toolNames.slice(-12)
  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  if (maxConsecutive >= 7) return 'storm'
  if (maxConsecutive >= 3) return 'warn'
  return 'none'
}

/** Threshold presets for doom-loop detection, selectable by goal mode. */
export interface DoomLoopThresholds {
  exact: { window: number; blockConsec: number; blockFreq: number; warnConsec: number; warnFreq: number }
  class: { window: number; blockConsec: number; blockFreq: number; warnConsec: number }
}

/** Normal mode: relaxed from original to avoid blocking normal workflows.
 *  Exact: 5 consecutive / 7-of-8 freq → block (was 4/7)
 *  Class: 9 consecutive / 10-of-12 freq → block (was 7/9 in window 10)
 *  Bash class fingerprints aggregate many different commands into one bin
 *  (e.g. all grep/rg/find patterns share `grep·error`), so the class
 *  thresholds must be higher to avoid making sequential debugging unusable. */
export const NORMAL_DOOM_THRESHOLDS: DoomLoopThresholds = {
  exact: { window: 8, blockConsec: 5, blockFreq: 7, warnConsec: 3, warnFreq: 5 },
  class: { window: 12, blockConsec: 9, blockFreq: 10, warnConsec: 6 },
}

/** Goal mode: significantly relaxed for long autonomous tasks.
 *  Already using larger windows, scaled proportionally from normal thresholds. */
export const GOAL_DOOM_THRESHOLDS: DoomLoopThresholds = {
  exact: { window: 10, blockConsec: 6, blockFreq: 8, warnConsec: 3, warnFreq: 6 },
  class: { window: 14, blockConsec: 10, blockFreq: 12, warnConsec: 7 },
}

export function getDoomLoopThresholds(goalActive: boolean): DoomLoopThresholds {
  return goalActive ? GOAL_DOOM_THRESHOLDS : NORMAL_DOOM_THRESHOLDS
}

/**
 * Detects doom loops using a dual-strategy approach:
 * 1. Consecutive repeats: tight-loop pattern where the same tool is called back-to-back.
 * 2. Sliding-window frequency: oscillation pattern (A→B→A→B→A) where a tool
 *    dominates the recent window even if not consecutive.
 *
 * Thresholds are parameterized via DoomLoopThresholds to allow goal-mode relaxation.
 */
export function getDoomLoopLevel(
  fingerprints: string[],
  t: DoomLoopThresholds['exact'] = NORMAL_DOOM_THRESHOLDS.exact,
): DoomLoopLevel {
  const recent = fingerprints.slice(-t.window)

  // Strategy 1: consecutive repeats
  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i! - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  // Strategy 2: sliding-window frequency
  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const maxCount = Math.max(0, ...counts.values())

  if (maxConsecutive >= t.blockConsec || maxCount >= t.blockFreq) return 'blocked'
  if (maxConsecutive >= t.warnConsec || maxCount >= t.warnFreq) return 'warn'
  return 'none'
}

/**
 * Class-level doom-loop detection over bash command-class fingerprints.
 *
 * 比精确指纹阈值保守（类粒度更粗，避免把"连续几次不同的 rg 搜索"误判为循环）：
 * - 4+ 连续同类（第 5 次同类调用）→ warn
 * - 6+ 连续同类 OR 8+/10 窗口占比 → blocked
 *
 * 会话 43443098 的 28 次 git status 变体在第 5 次就会进入 warn、第 7 次 blocked。
 */
export function getClassDoomLoopLevel(
  classFingerprints: string[],
  t: DoomLoopThresholds['class'] = NORMAL_DOOM_THRESHOLDS.class,
): DoomLoopLevel {
  const recent = classFingerprints.slice(-t.window)

  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const maxCount = Math.max(0, ...counts.values())

  if (maxConsecutive >= t.blockConsec || maxCount >= t.blockFreq) return 'blocked'
  if (maxConsecutive >= t.warnConsec) return 'warn'
  return 'none'
}

/**
 * Identify the specific fingerprints that pushed a window to `blocked` — i.e.
 * the actual offenders in the loop, not every fingerprint in the window.
 *
 * Used by the doom-loop gate to block *only* repeats of the looping call while
 * letting different tools/inputs through. Without this, hitting `blocked` once
 * blocks every subsequent tool unconditionally; since blocked calls never get
 * recorded, the window never refreshes and the turn deadlocks until the next
 * user input. Returns the set of offending fingerprints (empty if not blocked).
 *
 * Mirrors getDoomLoopLevel's thresholds: a fingerprint is an offender if it
 * appears 3+ times consecutively OR 6+ times within the last WINDOW entries.
 */
export function offendingFingerprints(fingerprints: string[], window = 8, freqThreshold = 6, consecThreshold = 3): Set<string> {
  const recent = fingerprints.slice(-window)
  const offenders = new Set<string>()

  // Frequency offenders.
  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  for (const [fp, n] of counts) {
    if (n >= freqThreshold) offenders.add(fp)
  }

  // Consecutive-run offenders.
  let run = 1
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i - 1]) {
      run++
      // consecThreshold consecutive *repeats* = consecThreshold+1 identical calls.
      if (run >= consecThreshold + 1) offenders.add(recent[i]!)
    } else {
      run = 1
    }
  }
  return offenders
}

const DOOM_LEVEL_ORDER: Record<DoomLoopLevel, number> = { none: 0, warn: 1, blocked: 2 }

/** Combine exact-fingerprint and class-fingerprint detection — strictest wins. */
export function combineDoomLoopLevels(a: DoomLoopLevel, b: DoomLoopLevel): DoomLoopLevel {
  return DOOM_LEVEL_ORDER[a] >= DOOM_LEVEL_ORDER[b] ? a : b
}
