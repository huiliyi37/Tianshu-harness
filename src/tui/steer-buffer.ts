/**
 * Steer Buffer — accumulates user guidance messages and commands during agent
 * execution, then drains them at the next tool result or turn boundary.
 *
 * Upgraded from a plain string FIFO to a priority queue:
 *   now  > next > later
 * Within the same priority, items stay FIFO. This prevents task notifications
 * from starving user steer messages and keeps urgent slash commands ahead of
 * background guidance.
 *
 * Entries also carry a deterministic SteerIntent (see steer-intent.ts). Drain
 * tags non-guidance messages and attaches one action tip for the drained
 * subset only — all-guidance drains stay byte-identical to the legacy format.
 */

import { debugLog } from '../utils/debug.js'
import {
  actionTipForIntent,
  classifySteerIntent,
  highestSteerIntent,
  type SteerIntent,
} from './steer-intent.js'

export type SteerPriority = 'now' | 'next' | 'later'

export interface SteerEntry {
  /** Queue-unique id */
  id: number
  /** Raw text payload */
  text: string
  /** Drain priority */
  priority: SteerPriority
  /** Classified intent (guidance for explicit pushNow / slash path). */
  intent: SteerIntent
}

const PRIORITY_ORDER: Record<SteerPriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

const HEADER = '[User guidance — 用户新指令，优先于当前计划/目标/续跑指示，立即遵从并调整方向]'

/** Raise priority for halt/redirect; never lower an explicitly higher request. */
function elevatePriority(requested: SteerPriority, intent: SteerIntent): SteerPriority {
  const floor: SteerPriority =
    intent === 'halt' ? 'now' : intent === 'redirect' ? 'next' : 'later'
  return PRIORITY_ORDER[requested] <= PRIORITY_ORDER[floor] ? requested : floor
}

function formatDrain(entries: readonly SteerEntry[]): string {
  const allGuidance = entries.every(e => e.intent === 'guidance')
  const texts = entries.map(e =>
    allGuidance ? e.text : `[${e.intent}] ${e.text}`,
  )

  if (allGuidance) {
    return texts.length === 1
      ? `${HEADER}: ${texts[0]}`
      : `${HEADER}:\n${texts.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
  }

  const tipIntent = highestSteerIntent(entries.map(e => e.intent))
  const tip = actionTipForIntent(tipIntent)
  const body = texts.length === 1
    ? `${HEADER}: ${texts[0]}`
    : `${HEADER}:\n${texts.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
  return tip ? `${body}\n${tip}` : body
}

export class SteerBuffer {
  private pending: SteerEntry[] = []
  private listeners: Array<() => void> = []
  private nextId = 1

  /** Add a user guidance message to the buffer (default priority: later). */
  push(message: string, priority: SteerPriority = 'later'): void {
    const { intent } = classifySteerIntent(message)
    this.pending.push({
      id: this.nextId++,
      text: message,
      priority: elevatePriority(priority, intent),
      intent,
    })
    this.notify()
  }

  /**
   * Add an urgent command that should be processed before normal guidance.
   * Skips intent classification (slash / explicit path) — always `guidance`
   * at `now` priority so caller-chosen urgency is not rewritten.
   */
  pushNow(message: string): void {
    this.pending.push({
      id: this.nextId++,
      text: message,
      priority: 'now',
      intent: 'guidance',
    })
    this.notify()
  }

  /**
   * 显式加入排队队列（严格保持 later 优先级，不被 mid-turn 工具边界 drain，在轮次结束后依次独立执行）。
   */
  pushQueue(message: string): void {
    const { intent } = classifySteerIntent(message)
    this.pending.push({
      id: this.nextId++,
      text: message,
      priority: 'later',
      intent,
    })
    this.notify()
  }

  /**
   * 显式加入插队转向引导（以 next 优先级在下一个工具调用边界前作为 [User guidance] 注入）。
   */
  pushSteer(message: string): void {
    const { intent } = classifySteerIntent(message)
    this.pending.push({
      id: this.nextId++,
      text: message,
      priority: 'next',
      intent: intent === 'guidance' ? 'redirect' : intent,
    })
    this.notify()
  }

  /** 获取所有排队消息（later 级，将在轮次结束后依次独立执行）。 */
  getQueuedEntries(): readonly SteerEntry[] {
    return this.pending.filter(entry => entry.priority === 'later')
  }

  /** 获取所有即时插队引导（now/next 级，将在工具调用前注入）。 */
  getSteerEntries(): readonly SteerEntry[] {
    return this.pending.filter(entry => entry.priority === 'now' || entry.priority === 'next')
  }

  /** Add a high-priority message, processed after `now` but before `later`. */
  pushNext(message: string): void {
    this.push(message, 'next')
  }

  /** Check if there are pending messages. Optional `maxPriority` restricts the check. */
  hasPending(maxPriority?: SteerPriority): boolean {
    if (this.pending.length === 0) return false
    if (maxPriority === undefined) return true
    const threshold = PRIORITY_ORDER[maxPriority]
    return this.pending.some(entry => PRIORITY_ORDER[entry.priority] <= threshold)
  }

  /** Get pending message texts in insertion order (backward compatible). */
  getPending(): readonly string[] {
    return this.pending.map(entry => entry.text)
  }

  /** Get pending entries in drain order (priority then insertion order). */
  getPendingEntries(): readonly SteerEntry[] {
    return this.sorted()
  }

  /**
   * Drain pending messages and format them for injection.
   * If `maxPriority` is given, only messages at or above that priority are
   * drained; the rest remain queued.
   *
   * Action tip is chosen from the drained subset only (not leftover queue).
   */
  drain(maxPriority?: SteerPriority): string | null {
    if (this.pending.length === 0) return null

    const threshold = maxPriority === undefined ? Infinity : PRIORITY_ORDER[maxPriority]
    const drainable = this.pending.filter(entry => PRIORITY_ORDER[entry.priority] <= threshold)
    if (drainable.length === 0) return null

    this.pending = this.pending.filter(entry => PRIORITY_ORDER[entry.priority] > threshold)
    this.notify()

    const ordered = drainable.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority]
      const pb = PRIORITY_ORDER[b.priority]
      if (pa !== pb) return pa - pb
      return a.id - b.id
    })

    // W3 observation: class distribution for the drained subset.
    const counts: Partial<Record<SteerIntent, number>> = {}
    for (const e of ordered) {
      counts[e.intent] = (counts[e.intent] ?? 0) + 1
    }
    const dist = (Object.entries(counts) as [SteerIntent, number][])
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')
    if (dist) debugLog(`[steer-intent] ${dist}`)

    return formatDrain(ordered)
  }

  /** Peek at the highest-priority pending text without removing it. */
  peek(maxPriority?: SteerPriority): string | null {
    const entries = this.sorted()
    if (entries.length === 0) return null
    if (maxPriority === undefined) return entries[0]!.text
    const threshold = PRIORITY_ORDER[maxPriority]
    const entry = entries.find(e => PRIORITY_ORDER[e.priority] <= threshold)
    return entry?.text ?? null
  }

  /**
   * 取出队列头部一条的原文（drain 序：优先级再 FIFO），不包 [User guidance]。
   * 给 run 结束后自动发出下一条用——drain() 的注入格式不能当新 prompt。
   */
  shift(): string | null {
    if (this.pending.length === 0) return null
    const first = this.sorted()[0]!
    this.pending = this.pending.filter(entry => entry.id !== first.id)
    this.notify()
    return first.text
  }

  /** Take back the most recently queued message (Up-arrow recall). */
  popLast(): string | null {
    if (this.pending.length === 0) return null
    const last = this.pending.pop()!
    this.notify()
    return last.text
  }

  /** Clear all pending messages. */
  clear(): void {
    if (this.pending.length === 0) return
    this.pending = []
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private sorted(): SteerEntry[] {
    return [...this.pending].sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority]
      const pb = PRIORITY_ORDER[b.priority]
      if (pa !== pb) return pa - pb
      return a.id - b.id
    })
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
