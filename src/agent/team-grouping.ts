import type { TeamTask } from './team-plan.js'
import { dependencyId } from './work-order.js'

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_WRITE_WORKERS = 3
export const MAX_READ_WORKERS = 3

export interface GroupingOptions {
  maxWriteWorkers?: number
  maxReadWorkers?: number
}

export interface TeamWave {
  id: string
  taskIds: string[]
  reason: string
  parallelLimit: number
  risk: 'low' | 'medium' | 'high'
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get all files touched by a task. */
function touchFiles(task: TeamTask): string[] {
  return task.touchSet.length > 0 ? task.touchSet : task.files
}

/** Check if a task is read-only (scout, reviewer). */
function isReadOnly(task: TeamTask): boolean {
  return task.profile === 'code_scout'
    || task.profile === 'doc_scout'
    || (task.profile === 'reviewer' && task.kind === 'review')
}

/** Check if two write tasks share any file (partial overlap). */
function hasFileOverlap(a: TeamTask, b: TeamTask): boolean {
  const aFiles = new Set(touchFiles(a))
  const bFiles = touchFiles(b)
  if (aFiles.size === 0 || bFiles.length === 0) return false
  return bFiles.some(f => aFiles.has(f))
}

/** Topological sort of tasks by dependsOn. Returns ordered task IDs. */
function topologicalSort(tasks: TeamTask[]): string[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const result: string[] = []

  function visit(id: string): void {
    if (visited.has(id)) return
    visited.add(id)
    const task = taskMap.get(id)
    if (task) {
      // 条件边（收编 #6）：拓扑只看主依赖（dependsOn）；skip/alternate 的
      // 运行时分支由 coordinator 的 WorkOrderQueue 处理。
      for (const dep of task.dependsOn) {
        const depId = dependencyId(dep)
        if (taskMap.has(depId)) visit(depId)
      }
    }
    result.push(id)
  }

  for (const t of tasks) visit(t.id)
  return result
}

export interface DependencyDiagnostics {
  /** Deps that point to a task id not present in the set (typos, stale refs). */
  dangling: Array<{ taskId: string; missingDep: string }>
  /** Dependency cycles, each as the list of task ids forming the loop. */
  cycles: string[][]
}

/**
 * Validate the dependency graph BEFORE scheduling.
 *
 * Surfaces two failure classes that the scheduler would otherwise absorb
 * silently:
 *  - dangling deps: `dependsOn` referencing a non-existent task id. The
 *    scheduler treats an unknown dep as "satisfied" (tolerant by design), but
 *    that means a typo'd dep silently drops and the task dispatches early.
 *    This makes it visible.
 *  - cycles: A→B→A. The scheduler force-breaks them, but generically; this
 *    names the exact loop so callers/logs can report it.
 *
 * Pure function — no side effects. Tolerance policy is unchanged; this only
 * reports.
 */
export function validateTaskDependencies(tasks: TeamTask[]): DependencyDiagnostics {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const dangling: Array<{ taskId: string; missingDep: string }> = []
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      const depId = dependencyId(dep)
      if (!taskMap.has(depId)) dangling.push({ taskId: t.id, missingDep: depId })
    }
  }

  // Cycle detection via DFS with a recursion stack (white/gray/black coloring).
  const cycles: string[][] = []
  const state = new Map<string, 'gray' | 'black'>()
  const stack: string[] = []

  function dfs(id: string): void {
    state.set(id, 'gray')
    stack.push(id)
    const task = taskMap.get(id)
    if (task) {
      for (const dep of task.dependsOn) {
        const depId = dependencyId(dep)
        if (!taskMap.has(depId)) continue
        const depState = state.get(depId)
        if (depState === 'gray') {
          const start = stack.indexOf(depId)
          if (start >= 0) cycles.push(stack.slice(start))
        } else if (depState !== 'black') {
          dfs(depId)
        }
      }
    }
    stack.pop()
    state.set(id, 'black')
  }

  for (const t of tasks) {
    if (!state.has(t.id)) dfs(t.id)
  }

  return { dangling, cycles }
}

/** Check if a file is a test file for a given source file.
 *  Extension-agnostic (T5 同族修复, 2026-07-30): the old version only knew
 *  .ts/.tsx, so .mjs/.js source+test pairs never bound and raced in the same
 *  wave as two independent write shards. */
function isTestFor(testFile: string, sourceFile: string): boolean {
  // src/agent/foo.ts → src/agent/__tests__/foo.test.ts
  // src/agent/foo.ts → src/__tests__/foo.test.ts  (flatter layout)
  // toolkit2/slug.mjs → toolkit2/slug.test.mjs
  // Only a `.test.<ext>` suffix marks a test file; without it testBase keeps
  // its extension and can never equal the extension-stripped source base.
  const base = sourceFile.replace(/\.[^./\\]+$/, '')
  const testBase = testFile.replace(/\.test\.[^./\\]+$/, '').replace(/\/__tests__/, '')
  return base === testBase
}

/**
 * Bind source+test pairs: if a patcher task's files are all test files
 * for another patcher task's source files, merge them.
 */
function bindSourceTestPairs(tasks: TeamTask[]): TeamTask[] {
  const result: TeamTask[] = []
  const consumed = new Set<string>()

  for (const task of tasks) {
    if (consumed.has(task.id)) continue
    consumed.add(task.id)

    const files = touchFiles(task)
    // Only look for test-only tasks to merge into this one.
    // Empty scope tasks can't have source-test relationships.
    if (files.length === 0) {
      result.push(task)
      continue
    }
    let merged = false
    for (const other of tasks) {
      if (consumed.has(other.id)) continue
      if (other.profile !== 'patcher') continue
      const otherFiles = touchFiles(other)
      if (otherFiles.length === 0) continue

      // Check if other's files are all test files for this task's files
      const allTestPairs = otherFiles.every(of =>
        files.some(f => isTestFor(of, f))
      )
      if (allTestPairs) {
        consumed.add(other.id)
        const mergedFiles = [...new Set([...files, ...otherFiles])]
        result.push({
          ...task,
          files: mergedFiles,
          touchSet: mergedFiles,
          verification: [...task.verification, ...other.verification],
          objective: [task.objective, other.objective].join('\n'),
        })
        merged = true
        break
      }
    }

    if (!merged) {
      result.push(task)
    }
  }

  return result
}

// ── Main grouping function ─────────────────────────────────────────────────

/**
 * Group team tasks into execution waves respecting:
 * 1. Topological order of dependencies
 * 2. Same-file write tasks must serialize
 * 3. source+test pairs are bound into one task
 * 4. Read-only tasks can parallel with write tasks
 * 5. maxWriteWorkers / maxReadWorkers caps per wave
 */
export function groupTeamTasks(tasks: TeamTask[], options?: GroupingOptions): TeamWave[] {
  if (tasks.length === 0) return []

  const maxWrite = options?.maxWriteWorkers ?? MAX_WRITE_WORKERS
  const maxRead = options?.maxReadWorkers ?? MAX_READ_WORKERS

  // Bind source+test pairs
  const bound = bindSourceTestPairs(tasks)
  const taskMap = new Map(bound.map(t => [t.id, t]))

  // Validate dependency graph up front so cycles/dangling refs become visible
  // in wave reasons instead of being silently absorbed by the scheduler.
  const diag = validateTaskDependencies(bound)
  const danglingByTask = new Map<string, string[]>()
  for (const d of diag.dangling) {
    const arr = danglingByTask.get(d.taskId) ?? []
    arr.push(d.missingDep)
    danglingByTask.set(d.taskId, arr)
  }

  // Topological order
  const topoOrder = topologicalSort(bound)

  const waves: TeamWave[] = []
  let waveCounter = 0
  const completed = new Set<string>()
  const remaining = [...topoOrder]

  while (remaining.length > 0) {
    // Find tasks whose dependencies are all completed
    const ready: string[] = []
    const notReady: string[] = []

    for (const id of remaining) {
      const task = taskMap.get(id)
      if (!task) { notReady.push(id); continue }

      const depsMet = task.dependsOn.every(dep => {
        const depId = dependencyId(dep)
        return completed.has(depId) || !taskMap.has(depId)
      })
      if (depsMet) {
        ready.push(id)
      } else {
        notReady.push(id)
      }
    }

    if (ready.length === 0) {
      // All remaining are blocked — force one through. Name the exact cause
      // instead of a generic message so the high-risk forcing is auditable.
      const forced = remaining[0]!
      const cycle = diag.cycles.find(c => c.includes(forced))
      const reason = cycle
        ? `forced: dependency cycle ${cycle.join('→')}→${cycle[0]}`
        : 'forced: unresolvable dependency order'
      waves.push({
        id: `W${++waveCounter}`,
        taskIds: [forced],
        reason,
        parallelLimit: 1,
        risk: 'high',
      })
      completed.add(forced)
      remaining.shift()
      continue
    }

    // Partition ready tasks into write and read
    const writeReady: string[] = []
    const readReady: string[] = []

    for (const id of ready) {
      const task = taskMap.get(id)!
      if (isReadOnly(task)) {
        readReady.push(id)
      } else {
        writeReady.push(id)
      }
    }

    // Group write tasks: serialize same-file, cap at maxWrite
    const waveWriteTasks: string[] = []
    const writeFilesInWave = new Set<string>()
    const deferredWrites: string[] = []

    for (const id of writeReady) {
      const task = taskMap.get(id)!

      if (hasFileOverlapWithSet(task, writeFilesInWave)) {
        deferredWrites.push(id)
        continue
      }

      if (waveWriteTasks.length >= maxWrite) {
        deferredWrites.push(id)
        continue
      }

      waveWriteTasks.push(id)
      for (const f of touchFiles(task)) writeFilesInWave.add(f)
    }

    // Cap read tasks
    const waveReadTasks = readReady.slice(0, maxRead)
    const deferredReads = readReady.slice(maxRead)

    // Build wave
    const waveTaskIds = [...waveWriteTasks, ...waveReadTasks]
    if (waveTaskIds.length > 0) {
      // Tasks whose deps were dropped as dangling may be dispatching earlier
      // than intended — surface that and treat the wave as at least medium risk.
      const danglingNotes = waveTaskIds
        .filter(id => danglingByTask.has(id))
        .map(id => `${id} has unknown dep(s) ${danglingByTask.get(id)!.join(', ')}`)

      const waveRisk = waveTaskIds.some(id => taskMap.get(id)?.riskTier === 'high') ? 'high'
        : (waveTaskIds.some(id => taskMap.get(id)?.riskTier === 'medium') || danglingNotes.length > 0) ? 'medium'
        : 'low'

      const writeCount = waveWriteTasks.length
      const readCount = waveReadTasks.length
      const baseReason = writeCount > 0 && readCount > 0
        ? `${writeCount} write + ${readCount} read tasks`
        : writeCount > 0
          ? `${writeCount} write tasks`
          : `${readCount} read tasks`
      const reason = danglingNotes.length > 0
        ? `${baseReason} (⚠ ${danglingNotes.join('; ')})`
        : baseReason

      waves.push({
        id: `W${++waveCounter}`,
        taskIds: waveTaskIds,
        reason,
        parallelLimit: waveTaskIds.length,
        risk: waveRisk,
      })

      for (const id of waveTaskIds) completed.add(id)
    }

    // Remaining = deferred writes + deferred reads + not-ready
    remaining.length = 0
    remaining.push(...deferredWrites, ...deferredReads, ...notReady)
  }

  return waves
}

function hasFileOverlapWithSet(task: TeamTask, filesInWave: Set<string>): boolean {
  const taskFiles = touchFiles(task)
  if (taskFiles.length === 0 || filesInWave.size === 0) return false
  return taskFiles.some(f => filesInWave.has(f))
}
