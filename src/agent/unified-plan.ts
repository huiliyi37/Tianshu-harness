/**
 * Unified Plan intermediate representation — bridges plan_task and team_orchestrate.
 *
 * plan_task can output UnifiedPlan JSON that team_orchestrate consumes directly
 * (via the planJson parameter), replacing the need for Markdown plan parsing.
 *
 * Also serves as the canonical serialization format for the max-mode planner fanout,
 * enabling plan caching and re-execution without re-running the LLM fanout.
 */

import { dependencyEdgeSchema, dependencyId, type DependencyRef, type WorkOrderKind, type WorkerProfile } from './work-order.js'
import type { TaskGraph, TaskGraphNode } from './task-graph.js'
import { validateTaskGraph } from './task-graph.js'
import type { TeamTask, TeamTaskDraft } from './team-plan.js'

// ── Unified types ──────────────────────────────────────────────────────────

export interface UnifiedTaskNode {
  /** Stable identifier across serialization round-trips. */
  id: string
  /** Short human-readable descriptor. */
  title: string
  /** Full objective text the worker receives. */
  objective: string
  /** Worker profile — determines tool set and budget. */
  profile: WorkerProfile
  /** Work order kind — code_search / plan / review / verify / patch_proposal / doc_research. */
  kind: WorkOrderKind
  /** File scope for the task (may be empty for global tasks). */
  files: string[]
  /** Task dependencies. Conditional edges preserve failure routing metadata. */
  dependsOn: DependencyRef[]
  /** Risk classification for scheduling (affects serialization and review gates). */
  riskTier: 'low' | 'medium' | 'high'
  /** Logical group for wave grouping. Undefined = auto-group by file overlap. */
  groupId?: string
  /** Route hint for worker selection (planner_strong / review_strong / executor_cheap / executor_strong). */
  routeHint?: TeamTask['routeHint']
  /** Verification commands (e.g. "npx tsc --noEmit"). Only from plan source. */
  verification?: string[]
  /** Touch set — all files this task may modify. Falls back to `files` when empty. */
  touchSet?: string[]
  /** Extension slot for source-specific metadata (e.g. plan_task's sessionTurn). */
  metadata?: Record<string, unknown>
}

export interface UnifiedPlan {
  /** Schema version for forward compatibility. */
  version: 1
  /** The mission statement / high-level objective. */
  objective: string
  /** Ordered task nodes. */
  tasks: UnifiedTaskNode[]
  /** Source tool: plan_task or team_orchestrate. */
  source: 'plan_task' | 'team_orchestrate' | 'manual'
  /** Creation timestamp (epoch ms). */
  createdAt: number
  /** Non-goals / exclusions from the plan. */
  nonGoals?: string[]
}

// ── Conversion: TaskGraph ↔ UnifiedPlan ────────────────────────────────────

/** Convert a TaskGraph (plan_task output) into a UnifiedPlan. */
export function taskGraphToUnifiedPlan(
  graph: TaskGraph,
  source: 'plan_task' | 'manual' = 'plan_task',
): UnifiedPlan {
  const tasks: UnifiedTaskNode[] = graph.nodes.map((node: TaskGraphNode) => ({
    id: node.id,
    title: node.title,
    objective: node.objective,
    profile: node.profile,
    kind: node.kind,
    files: node.files,
    dependsOn: node.dependsOn.map(dependencyId),
    riskTier: node.riskTier,
  }))

  return {
    version: 1,
    objective: graph.mission,
    tasks,
    source,
    createdAt: graph.createdAt,
  }
}

/** Convert a UnifiedPlan back into a TaskGraph (for validation and wave grouping).
 *  Note: TaskGraph is a subset — groupId, routeHint, verification, touchSet,
 *  metadata, source, version, and nonGoals are intentionally dropped as they
 *  have no representation in TaskGraphNode. Use UnifiedPlan→TeamTask[] for a
 *  full-fidelity round-trip that preserves all execution fields. */
export function unifiedPlanToTaskGraph(plan: UnifiedPlan): TaskGraph {
  return {
    mission: plan.objective,
    nodes: plan.tasks.map(node => ({
      id: node.id,
      title: node.title,
      objective: node.objective,
      profile: node.profile,
      kind: node.kind,
      files: node.files,
      dependsOn: node.dependsOn.map(dependencyId),
      riskTier: node.riskTier,
    })),
    createdAt: plan.createdAt,
  }
}

// ── Conversion: UnifiedPlan → TeamTask[] ───────────────────────────────────

/** Convert a UnifiedPlan into TeamTask[] for team_orchestrate consumption.
 *  This is the bridge that lets plan_task output flow into team_orchestrate. */
export function unifiedPlanToTeamTasks(plan: UnifiedPlan): TeamTask[] {
  return plan.tasks.map((node): TeamTask => ({
    id: node.id,
    title: node.title,
    objective: node.objective,
    files: node.files,
    profile: node.profile,
    kind: node.kind,
    verification: node.verification ?? [],
    dependsOn: node.dependsOn,
    riskTier: node.riskTier,
    touchSet: node.touchSet ?? node.files,
    groupId: node.groupId,
    routeHint: node.routeHint,
  }))
}

/** Convert a UnifiedPlan into TeamTaskDraft[] (lightweight version without deps/risk). */
export function unifiedPlanToTeamTaskDrafts(plan: UnifiedPlan): TeamTaskDraft[] {
  return plan.tasks.map((node): TeamTaskDraft => ({
    id: node.id,
    title: node.title,
    objective: node.objective,
    files: node.files,
    profile: node.profile,
    kind: node.kind,
    verification: node.verification ?? [],
  }))
}

// ── Validation ─────────────────────────────────────────────────────────────

export interface UnifiedPlanValidation {
  valid: boolean
  errors: string[]
  /** Per-node validation messages. */
  nodeErrors: Array<{ nodeId: string; error: string }>
  /** Non-blocking advisories (e.g. orthogonal-shard overlap without ordering).
   *  Do not affect `valid`; surfaced to the controller as guidance. */
  warnings: string[]
}

/** Minimal task shape for overlap/ordering checks — works for UnifiedTaskNode
 *  and TeamTask alike (touchSet optional). */
export interface OverlapCheckTask {
  id: string
  files: string[]
  touchSet?: string[]
  dependsOn: DependencyRef[]
}

/** Build transitive dependency reachability: id → set of all ids it depends on
 *  (directly or transitively). Visited-guarded so cycles don't loop forever. */
function buildDependencyReachability(tasks: Array<{ id: string; dependsOn: DependencyRef[] }>): Map<string, Set<string>> {
  const direct = new Map<string, string[]>()
  for (const t of tasks) direct.set(t.id, t.dependsOn.map(dependencyId))
  const reach = new Map<string, Set<string>>()
  for (const t of tasks) {
    const acc = new Set<string>()
    const stack = t.dependsOn.map(dependencyId)
    while (stack.length > 0) {
      const dep = stack.pop()!
      if (acc.has(dep)) continue
      acc.add(dep)
      for (const d of direct.get(dep) ?? []) stack.push(d)
    }
    reach.set(t.id, acc)
  }
  return reach
}

/**
 * Advisory detector: two shards that touch the same file but with no dependsOn
 * (direct or transitive) between them. Not an error — groupTeamTasks serializes
 * same-file writes onto different waves and the file-claim registry is a second
 * backstop — but explicit dependsOn makes the intended write order clear and
 * avoids surprise serialization. Caller should skip this when the graph has
 * cycles (reachability is meaningless then). Reused by plan_task validation and
 * the team max merged-plan check.
 */
export function detectOverlapWithoutOrder(tasks: OverlapCheckTask[]): string[] {
  const warnings: string[] = []
  const reach = buildDependencyReachability(tasks)
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!
      const b = tasks[j]!
      const aFiles = a.touchSet && a.touchSet.length > 0 ? a.touchSet : a.files
      const bFiles = b.touchSet && b.touchSet.length > 0 ? b.touchSet : b.files
      if (aFiles.length === 0 || bFiles.length === 0) continue
      const shared = aFiles.filter(f => bFiles.includes(f))
      if (shared.length === 0) continue
      const ordered = reach.get(a.id)?.has(b.id) === true || reach.get(b.id)?.has(a.id) === true
      if (!ordered) {
        warnings.push(
          `分片 ${a.id} 与 ${b.id} 都改 ${shared.join(', ')} 但未标 dependsOn —— `
          + `补一条依赖让写入顺序明确(否则会被同文件检测自动串行排波)。`,
        )
      }
    }
  }
  return warnings
}

/** Validate a UnifiedPlan before execution. */
export function validateUnifiedPlan(plan: UnifiedPlan): UnifiedPlanValidation {
  const errors: string[] = []
  const nodeErrors: Array<{ nodeId: string; error: string }> = []

  if (!plan.objective.trim()) {
    errors.push('objective is empty')
  }

  if (plan.tasks.length === 0) {
    errors.push('no tasks defined')
  }

  const ids = new Set<string>()
  for (const node of plan.tasks) {
    if (!node.id.trim()) {
      nodeErrors.push({ nodeId: '(empty)', error: 'node has empty id' })
      continue
    }
    if (ids.has(node.id)) {
      nodeErrors.push({ nodeId: node.id, error: 'duplicate node id' })
    }
    ids.add(node.id)

    if (!node.objective.trim()) {
      nodeErrors.push({ nodeId: node.id, error: 'objective is empty' })
    }
  }

  // Check for dangling dependencies
  for (const node of plan.tasks) {
    for (const dep of node.dependsOn) {
      const depId = dependencyId(dep)
      if (!ids.has(depId)) {
        nodeErrors.push({ nodeId: node.id, error: `depends on unknown task: ${depId}` })
      }
    }
  }

  // Validate via TaskGraph (catches cycles)
  const graph = unifiedPlanToTaskGraph(plan)
  const graphValidation = validateTaskGraph(graph)
  if (!graphValidation.valid) {
    for (const d of graphValidation.dangling) {
      errors.push(`dangling dep: ${d.taskId} → ${d.missingDep}`)
    }
    for (const cycle of graphValidation.cycles) {
      errors.push(`cycle: ${cycle.join(' → ')}`)
    }
  }

  // Advisory: orthogonal-shard overlap without ordering (skip when cycles exist —
  // reachability is meaningless then). Shared with the team max merged-plan check.
  const warnings = graphValidation.cycles.length === 0
    ? detectOverlapWithoutOrder(plan.tasks)
    : []

  return {
    valid: errors.length === 0 && nodeErrors.length === 0,
    errors,
    nodeErrors,
    warnings,
  }
}

// ── Serialization ──────────────────────────────────────────────────────────

/** Serialize a UnifiedPlan to compact JSON (no pretty-print for prompt efficiency). */
export function serializeUnifiedPlan(plan: UnifiedPlan): string {
  return JSON.stringify(plan)
}

/** Deserialize a UnifiedPlan from JSON string. Returns null on parse failure. */
export function deserializeUnifiedPlan(json: string): UnifiedPlan | null {
  try {
    const obj = JSON.parse(json) as unknown
    if (!obj || typeof obj !== 'object') return null
    const plan = obj as UnifiedPlan
    // Basic shape check
    if (plan.version !== 1) return null
    if (!Array.isArray(plan.tasks)) return null
    if (typeof plan.objective !== 'string') return null
    // Per-node type validation — reject before downstream consumers crash on malformed entries
    for (const node of plan.tasks) {
      if (typeof node.id !== 'string' || !node.id.trim()) return null
      if (typeof node.objective !== 'string') return null
      if (typeof node.profile !== 'string') return null
      if (typeof node.kind !== 'string') return null
      if (!Array.isArray(node.files)) return null
      if (!node.dependsOn.every(dep => typeof dep === 'string' || dependencyEdgeSchema.safeParse(dep).success)) return null
    }
    return plan
  } catch {
    return null
  }
}

/** Render a UnifiedPlan as human-readable summary (for tool output). */
export function renderUnifiedPlanSummary(plan: UnifiedPlan): string {
  const validated = validateUnifiedPlan(plan)
  const lines: string[] = [
    `Mission: ${plan.objective}`,
    `Tasks: ${plan.tasks.length} | Source: ${plan.source}`,
    `Valid: ${validated.valid ? 'yes' : 'no'}`,
  ]

  if (!validated.valid) {
    lines.push('')
    lines.push('Validation errors:')
    for (const err of validated.errors) {
      lines.push(`  - ${err}`)
    }
    for (const ne of validated.nodeErrors) {
      lines.push(`  - [${ne.nodeId}] ${ne.error}`)
    }
  }

  if (validated.warnings.length > 0) {
    lines.push('')
    lines.push('Advisories (non-blocking):')
    for (const w of validated.warnings) {
      lines.push(`  - ${w}`)
    }
  }

  if (validated.valid) {
    lines.push('')
    // Group by dependsOn depth
    const depthMap = new Map<string, number>()
    function getDepth(nodeId: string): number {
      if (depthMap.has(nodeId)) return depthMap.get(nodeId)!
      const node = plan.tasks.find(n => n.id === nodeId)
      if (!node || node.dependsOn.length === 0) {
        depthMap.set(nodeId, 0)
        return 0
      }
      const max = Math.max(0, ...node.dependsOn.map(d => getDepth(dependencyId(d)) + 1))
      depthMap.set(nodeId, max)
      return max
    }
    for (const node of plan.tasks) getDepth(node.id)

    const byDepth = new Map<number, UnifiedTaskNode[]>()
    for (const node of plan.tasks) {
      const depth = depthMap.get(node.id) ?? 0
      const group = byDepth.get(depth) ?? []
      group.push(node)
      byDepth.set(depth, group)
    }

    for (const [depth, nodes] of [...byDepth.entries()].sort(([a], [b]) => a - b)) {
      const label = depth === 0 ? 'Wave 1 (no deps)' : `Wave ${depth + 1}`
      lines.push(`${label}:`)
      for (const node of nodes) {
        const deps = node.dependsOn.length > 0 ? ` ← ${node.dependsOn.map(dependencyId).join(', ')}` : ''
        lines.push(`  ${node.id} [${node.profile}] ${node.title}${deps}`)
      }
    }
  }

  if (plan.nonGoals?.length) {
    lines.push('')
    lines.push('Non-goals:')
    for (const ng of plan.nonGoals) lines.push(`  - ${ng}`)
  }

  return lines.join('\n')
}
