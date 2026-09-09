import { STAR_DOMAINS, type StarDomainId } from '../agent/star-domain.js'
import { dependencyId } from '../agent/work-order.js'
import type { TeamRunSummary } from '../agent/team-orchestrator.js'
import type { TeamTask } from '../agent/team-plan.js'
import type { TeamWave } from '../agent/team-grouping.js'
import type { WorkerResult } from '../agent/work-order.js'
import type { FleetWorkerView } from './fleet-registry.js'
import { encodeFrame, decodeFrame, registerFramePrefix } from './frame-codec.js'

export const TEAM_PANEL_UI_PREFIX = 'rivet:team-panel:v1:'

// P2-B Wave 2: register for 8K truncate whitelist
registerFramePrefix(TEAM_PANEL_UI_PREFIX)

export type TeamPanelStatus = 'waiting' | 'running' | 'done' | 'blocked' | 'failed'

export interface TeamPanelTask {
  id: string
  title: string
  authority: string
  profile: string
  kind: string
  dependsOn: string[]
  riskTier: 'low' | 'medium' | 'high'
  files: string[]
  status: TeamPanelStatus
  /** Named partner-star identity when a worker explicitly carries one. */
  identity?: {
    name: string
    glyph: string
  }
  summary?: string
  /** Live overlay: wall-clock ms since the worker for this task was first seen. */
  elapsedMs?: number
  /** Live overlay: latest worker activity line (running) or a readiness cue. */
  activity?: string
}

export interface TeamPanelWave {
  id: string
  taskIds: string[]
  risk: 'low' | 'medium' | 'high'
  reason: string
}

export interface TeamPanelModel {
  mode: 'standard' | 'max'
  currentWave: number
  totalWaves: number
  dispatched: number
  blocked: string[]
  waves: TeamPanelWave[]
  tasks: TeamPanelTask[]
  reviewVerdict?: string
  /** W2b — 波间硬门禁结构化结果，供桌面端渲染 gate 失败卡。 */
  gate?: { wave: number; passed: boolean; failures: string[] }
  /** W2b — review gate 审查全文（截 ~1000 字），供桌面端展开阅读。 */
  reviewDetail?: string
}

function authorityForTask(task: Pick<TeamTask, 'profile' | 'objective'>): string {
  if (task.profile === 'patcher') return 'tianliang'
  if (task.profile === 'reviewer' || task.profile === 'adversarial_verifier') return 'tianquan'
  const lower = task.objective.toLowerCase()
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.keywords.some(keyword => lower.includes(keyword.toLowerCase()))) return id
  }
  return 'tianliang'
}

function partnerIdentityForTask(task: Pick<TeamTask, 'profile' | 'title' | 'objective'>): TeamPanelTask['identity'] | undefined {
  const text = `${task.title}\n${task.objective}`.toLowerCase()
  if (task.profile === 'adversarial_verifier' || /瑶光|yaoguang|↻|复现|verification/.test(text)) {
    return { name: '瑶光', glyph: '↻' }
  }
  if (/贪狼|tanlang|⊕|勘探|prospect|prospecting/.test(text)) {
    return { name: '贪狼', glyph: '⊕' }
  }
  return undefined
}

function matchesResult(taskId: string, result: WorkerResult): boolean {
  return result.workOrderId === `team:${taskId}`
    || result.workOrderId.endsWith(`:${taskId}`)
    || result.workOrderId === taskId
}

function taskStatus(
  taskId: string,
  currentWave: TeamWave | undefined,
  runResults: readonly WorkerResult[] | undefined,
  activeTaskIds?: ReadonlySet<string>,
): TeamPanelStatus {
  const result = runResults?.find(r => matchesResult(taskId, r))
  if (result) {
    if (result.status === 'passed') return 'done'
    if (result.status === 'blocked') return 'blocked'
    return 'failed'
  }
  // B3: activity-driven incremental state — tasks with live activity are 'running'
  if (activeTaskIds?.has(taskId)) return 'running'
  return currentWave?.taskIds.includes(taskId) ? 'running' : 'waiting'
}

function taskSummary(taskId: string, runResults: readonly WorkerResult[] | undefined): string | undefined {
  return runResults?.find(r => matchesResult(taskId, r))?.summary
}

export function buildTeamPanelModel(
  summary: TeamRunSummary,
  currentWave = 0,
  reviewVerdict?: string,
  /** B3: active task IDs from live worker activity — marks tasks as 'running' */
  activeTaskIds?: ReadonlySet<string>,
  /** W2b: structured gate result from executePlan */
  gate?: TeamPanelModel['gate'],
  /** W2b: review detail text from executePlan */
  reviewDetail?: string,
): TeamPanelModel {
  const current = summary.waves[currentWave]
  return {
    mode: summary.mode,
    currentWave,
    totalWaves: summary.waves.length,
    dispatched: summary.dispatched,
    blocked: summary.blocked,
    waves: summary.waves.map(w => ({ id: w.id, taskIds: [...w.taskIds], risk: w.risk, reason: w.reason })),
    tasks: summary.tasks.map(task => ({
      id: task.id,
      title: task.title,
      authority: authorityForTask(task),
      profile: task.profile,
      kind: task.kind,
      dependsOn: task.dependsOn.map(dependencyId),
      riskTier: task.riskTier,
      files: [...task.files],
      status: taskStatus(task.id, current, summary.run?.results, activeTaskIds),
      identity: partnerIdentityForTask(task),
      summary: taskSummary(task.id, summary.run?.results),
    })),
    reviewVerdict,
    gate,
    reviewDetail,
  }
}

export function encodeTeamPanelModel(model: TeamPanelModel): string {
  return encodeFrame(model, TEAM_PANEL_UI_PREFIX)
}

export function decodeTeamPanelModel(value: string): TeamPanelModel | null {
  // T9 P3: live activity lines may accumulate BEFORE the final encoded panel
  // in the same tool content — locate the prefix anywhere, not only at start.
  return decodeFrame(value, TEAM_PANEL_UI_PREFIX, (p): p is TeamPanelModel =>
    p != null && typeof p === 'object' && Array.isArray((p as TeamPanelModel).waves) && Array.isArray((p as TeamPanelModel).tasks),
  )
}

export function starFor(authority: string): { name: string; glyph: string; colorKey: 'primary' | 'secondary' | 'success' | 'warning' | 'error' } {
  const domain = STAR_DOMAINS[authority as StarDomainId]
  if (!domain) return { name: authority || '未知', glyph: '☆', colorKey: 'secondary' }
  return { name: domain.name, glyph: domain.uiPersona.glyph, colorKey: domain.uiPersona.accent }
}

/**
 * B3: extract likely task IDs from a worker activity event's workOrderId.
 * Team work orders have IDs like "wo_team:T1" or "team:T1".
 * Returns the task ID (e.g. "T1") or undefined if not a team task.
 */
export function taskIdFromActivity(workOrderId: string): string | undefined {
  const match = workOrderId.match(/team:(\S+)/)
  return match ? match[1] : undefined
}

function fleetViewToPanelStatus(view: FleetWorkerView): TeamPanelStatus {
  if (view.status === 'completed') return 'done'
  if (view.status === 'blocked') return 'blocked'
  if (view.terminal) return 'failed' // failed / escalated
  return 'running'
}

/** Rank so an overlay never downgrades a more-advanced state (e.g. done→running). */
function panelStatusRank(status: TeamPanelStatus): number {
  switch (status) {
    case 'done': return 4
    case 'failed': return 3
    case 'blocked': return 3
    case 'running': return 2
    case 'waiting': return 1
  }
}

/**
 * P5: 把 FleetRegistry 的实时 per-worker 状态叠加到（通常是派发前全 waiting 的）
 * 面板模型上。纯读投影：
 *  - 经 taskIdFromActivity 把 worker 映射回 task，升级 status（不降级）；
 *  - 为有 worker 的 task 附 elapsedMs / 最新 activity 行；
 *  - 依赖解锁可视化：deps 全部 done 的 waiting task 标 "ready · deps met"。
 */
export function overlayFleetStatus(model: TeamPanelModel, workers: readonly FleetWorkerView[]): TeamPanelModel {
  if (workers.length === 0) return model

  const statusByTask = new Map<string, TeamPanelStatus>()
  const viewByTask = new Map<string, FleetWorkerView>()
  for (const view of workers) {
    const taskId = taskIdFromActivity(view.workerId)
    if (!taskId) continue
    const status = fleetViewToPanelStatus(view)
    const prev = statusByTask.get(taskId)
    if (!prev || panelStatusRank(status) >= panelStatusRank(prev)) {
      statusByTask.set(taskId, status)
      viewByTask.set(taskId, view)
    }
  }
  if (viewByTask.size === 0) return model

  const doneSet = new Set([...statusByTask].filter(([, status]) => status === 'done').map(([id]) => id))

  return {
    ...model,
    tasks: model.tasks.map(task => {
      const view = viewByTask.get(task.id)
      if (view) {
        const overlaid = statusByTask.get(task.id)!
        const status = panelStatusRank(overlaid) >= panelStatusRank(task.status) ? overlaid : task.status
        return {
          ...task,
          status,
          elapsedMs: view.elapsedMs,
          ...(view.activity ? { activity: view.activity } : {}),
        }
      }
      if (task.status === 'waiting' && task.dependsOn.length > 0 && task.dependsOn.every(dep => doneSet.has(dep))) {
        return { ...task, activity: 'ready · deps met' }
      }
      return task
    }),
  }
}
