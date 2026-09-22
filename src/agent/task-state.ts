import type { TrajectoryEntry } from './trajectory.js'
import type { TodoItem } from '../tools/todo-store.js'
import { detectDependencies, orderPendingByExecutability } from '../tools/todo-deps.js'
import { oaiMessageText, type OaiMessage } from '../api/oai-types.js'

export interface TaskState {
  completed: string[]
  current: string
  remaining: string[]
  /** Key decisions/findings extracted from model text for reflective compaction */
  decisions: string[]
}

const NEXT_STEP_RE = /(?:next|then|after that|i will|step \d|接下来|然后|下一步)[^.。]*(?:[.。]|$)/gi
const DECISION_RE = /(?:I(?:'ll| will) (?:use|go with|choose|pick|implement)|decided to|approach:|strategy:)[^.。]*(?:[.。]|$)/gi
const FINDING_RE = /(?:found that|discovered|the (?:issue|problem|root cause) (?:is|was)|turns out|发现|原因是)[^.。]*(?:[.。]|$)/gi

export function extractTaskState(entries: TrajectoryEntry[], lastModelText: string): TaskState {
  if (entries.length === 0) return { completed: [], current: 'starting', remaining: [], decisions: [] }

  const successful = entries.filter(e => e.status === 'success' || e.status === 'retried-success')
  const completed = successful.slice(-5).map(e => `${e.tool} ${e.target.split('/').pop() ?? e.target}`)

  const lastEntry = entries[entries.length - 1]!
  const current = lastEntry.status === 'failed' || lastEntry.status === 'retried-failed'
    ? `fixing ${lastEntry.errorClass ?? 'error'} in ${lastEntry.target.split('/').pop()}`
    : `${lastEntry.tool} ${lastEntry.target.split('/').pop()}`

  const remaining: string[] = []
  for (const match of lastModelText.matchAll(NEXT_STEP_RE)) {
    remaining.push(match[0].trim().slice(0, 60))
    if (remaining.length >= 3) break
  }

  const decisions: string[] = []
  for (const match of lastModelText.matchAll(DECISION_RE)) {
    decisions.push(match[0].trim().slice(0, 80))
    if (decisions.length >= 3) break
  }
  for (const match of lastModelText.matchAll(FINDING_RE)) {
    decisions.push(match[0].trim().slice(0, 80))
    if (decisions.length >= 5) break
  }

  return { completed, current, remaining, decisions }
}

/**
 * Extract the user's actual request from the session's first user turn.
 *
 * History (fixed 2026-09-22): the structured handoff rendered
 * `TaskState.current` — a mechanical "last tool + target basename" label —
 * under the heading "1. 用户核心需求", so every recorded handoff in this repo
 * claimed the user's core need was e.g. "ask_user_question ask_user_question"
 * or "grep README.md" (153/153 wrong). `current` describes where the trajectory
 * stopped; it has no causal relation to what the user asked for.
 * See docs/analysis/2026-09-22-session-retrospective.md §3.
 *
 * Runtime-injected `<system-reminder>` blocks are stripped: they are appended
 * to user turns by the guardrail channels and are not user intent.
 */
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const USER_GOAL_MAX_CHARS = 160

export function extractUserGoal(messages: ReadonlyArray<OaiMessage>): string | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const raw = oaiMessageText(message)
    if (typeof raw !== 'string') continue
    const cleaned = raw
      .replace(SYSTEM_REMINDER_BLOCK_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) continue
    return cleaned.length > USER_GOAL_MAX_CHARS
      ? `${cleaned.slice(0, USER_GOAL_MAX_CHARS)}…`
      : cleaned
  }
  return undefined
}

/**
 * Build TaskState from the authoritative todo list instead of trajectory
 * heuristics. The TodoStore is the model's canonical record, but nothing ever
 * read it back into the prompt — so after compaction discarded the todo tool
 * messages the model rebuilt the list from lossy memory and re-ran finished
 * work. Re-injecting the real list every turn closes that gap.
 * Decisions still come from the heuristic pass (todos don't carry them).
 * (root-cause analysis 2026-06-05, Thread 3)
 */
export function taskStateFromTodos(todos: TodoItem[], decisions: string[]): TaskState {
  const completed = todos.filter(t => t.status === 'completed').map(t => t.content)

  // Dependency-aware ordering: surface executable items first, blocked items
  // after — but NEVER drop a real pending todo. A stale or false-positive
  // dependency edge must not make work vanish from the prompt (that was the
  // exact post-compaction loss this function exists to fix). We only reorder.
  const deps = detectDependencies(todos)
  const ordered = orderPendingByExecutability(todos, deps)

  const inProgress = todos.find(t => t.status === 'in_progress')
  const current = inProgress?.content ?? ordered[0]?.content ?? 'working'
  // remaining = all pending items that are NOT the current focus
  const currentId = inProgress?.id ?? ordered[0]?.id
  const remaining = ordered
    .filter(t => t.id !== currentId)
    .map(t => t.content)
  return { completed, current, remaining, decisions }
}
