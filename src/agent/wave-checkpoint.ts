/**
 * Wave Checkpoint — persist team wave state so failed waves can resume.
 *
 * After each wave completes, the team orchestrator calls `saveCheckpoint`.
 * On failure, the user can call `/team resume <groupId>` to re-dispatch
 * from the last completed wave instead of starting over.
 *
 * Checkpoints are stored in `.rivet/checkpoints/<groupId>.json` and contain:
 * - completed wave results
 * - remaining task definitions
 * - wave index to resume from
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { DependencyEdge, WorkerResult, WorkOrder } from './work-order.js'
import { dependencyId } from './work-order.js'
import { serializeUnifiedPlan, type UnifiedPlan } from './unified-plan.js'
import { isSafeFileName } from '../utils/safe-path.js'

const CHECKPOINT_DIR = '.rivet/checkpoints'

/**
 * Deterministic team group id from the objective. Multi-wave runs call
 * team_orchestrate once per wave with the same objective, so hashing the
 * objective maps all waves of one run to a single checkpoint file.
 */
export function deriveTeamGroupId(objective: string): string {
  const hash = createHash('sha1').update(objective.trim()).digest('hex').slice(0, 8)
  return `team-${hash}`
}

export interface WaveCheckpoint {
  /** Team group identifier (from team_orchestrate groupId). */
  groupId: string
  /** Timestamp of checkpoint creation. */
  timestamp: number
  /** Index of the last completed wave (0-based). Resume starts at +1. */
  lastCompletedWave: number
  /** Results from all completed waves. */
  completedResults: WorkerResult[]
  /**
   * Remaining tasks not yet dispatched.
   *
   * `dependsOn` 随任务一起存盘（2026-08-05）：此前 checkpoint 只存
   * id/objective/profile/kind/scope/authority，resume 重建计划时依赖恒为空，
   * 剩余任务之间的显式顺序（T3 依赖 T2）与条件边（onFailure=skip/alternate）
   * 全部丢失——重新分波只能靠同文件串行等启发式反推，可能乱序执行。
   * 数据源 TeamTask 本来就带 dependsOn，是保存时没拷。
   *
   * 旧 checkpoint 无此字段 → 读回为 undefined，按空依赖处理（向后兼容）。
   */
  remainingOrders: Array<
    Pick<WorkOrder, 'id' | 'objective' | 'profile' | 'kind' | 'scope' | 'authority'>
    & { dependsOn?: Array<string | DependencyEdge> }
  >
  /** Original objective for context. */
  objective: string
  /** Total waves planned. */
  totalWaves: number
}

function getCheckpointPath(cwd: string, groupId: string): string {
  // groupId 会拼进文件名——拒绝分隔符与父目录逃逸（与 coordinator 的
  // isSafeRoundNonce 同族；groupId 亦来自 HTTP body，路由层之外的第二道门）。
  if (!isSafeFileName(groupId)) throw new Error(`Invalid checkpoint group id: ${JSON.stringify(groupId)}`)
  return join(cwd, CHECKPOINT_DIR, `${groupId}.json`)
}

/** Save a wave checkpoint to disk. Overwrites any existing checkpoint for the group. */
export function saveCheckpoint(cwd: string, checkpoint: WaveCheckpoint): void {
  const dir = join(cwd, CHECKPOINT_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getCheckpointPath(cwd, checkpoint.groupId), JSON.stringify(checkpoint, null, 2), 'utf-8')
}

/** Load the latest checkpoint for a group. Returns null if none exists. */
export function loadCheckpoint(cwd: string, groupId: string): WaveCheckpoint | null {
  const path = getCheckpointPath(cwd, groupId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WaveCheckpoint
  } catch {
    return null
  }
}

/** Delete a checkpoint after successful completion (no need to keep it). */
export function clearCheckpoint(cwd: string, groupId: string): void {
  const path = getCheckpointPath(cwd, groupId)
  if (existsSync(path)) unlinkSync(path)
}

/** List all available checkpoints for display. */
export function listCheckpoints(cwd: string): Array<{ groupId: string; wave: number; totalWaves: number; timestamp: number }> {
  const dir = join(cwd, CHECKPOINT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => {
      try {
        const cp = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as WaveCheckpoint
        return { groupId: cp.groupId, wave: cp.lastCompletedWave, totalWaves: cp.totalWaves, timestamp: cp.timestamp }
      } catch {
        return null
      }
    })
    .filter((x: unknown): x is { groupId: string; wave: number; totalWaves: number; timestamp: number } => x !== null)
    .sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp)
}

/**
 * A2 (/team-resume): turn a checkpoint into a resumable plan + kickoff prompt.
 *
 * The remaining orders become a fresh UnifiedPlan (the resumed run re-groups
 * waves from wave 0 over the remaining tasks), which the caller stores via
 * plan-store so a bare `team_orchestrate` call auto-consumes it. Returns null
 * when there is nothing left to dispatch (e.g. the final wave failed — rerun
 * that wave manually instead).
 */
export function buildResumeFromCheckpoint(cp: WaveCheckpoint): { planJson: string; prompt: string } | null {
  if (cp.remainingOrders.length === 0) return null
  // 只保留指向「同样还没跑」的任务的依赖。被依赖方若已在前面的波完成，它不在
  // remainingOrders 里——留着这条边会让 validateUnifiedPlan 判 dangling 而拒绝
  // 整份计划。剥掉等价于「该依赖已满足」，与 dispatchWaveAt 对跨波已完成依赖
  // 的处理同口径。
  const remainingIds = new Set(cp.remainingOrders.map(o => o.id))
  const keepDeps = (deps: Array<string | DependencyEdge> | undefined): Array<string | DependencyEdge> =>
    (deps ?? []).filter(d => remainingIds.has(dependencyId(d)))
  const plan: UnifiedPlan = {
    version: 1,
    objective: cp.objective,
    tasks: cp.remainingOrders.map(order => ({
      id: order.id,
      title: order.id,
      objective: order.objective,
      profile: order.profile,
      kind: order.kind,
      files: order.scope.files ?? [],
      dependsOn: keepDeps(order.dependsOn),
      riskTier: 'medium' as const,
    })),
    source: 'team_orchestrate',
    createdAt: Date.now(),
  }
  const completed = cp.completedResults
  const failed = completed.filter(r => r.status !== 'passed')
  const doneLines = [
    `已完成 ${cp.lastCompletedWave + 1}/${cp.totalWaves} 波（${completed.length} 个 worker，${failed.length} 个未通过）。`,
    ...failed.slice(0, 3).map(r => `  ✗ ${r.workOrderId}: ${r.summary.slice(0, 120)}`),
  ]
  const prompt = [
    `[TEAM RESUME] 从 checkpoint ${cp.groupId} 续跑团队任务。`,
    '',
    `Objective: ${cp.objective}`,
    doneLines.join('\n'),
    '',
    `剩余 ${cp.remainingOrders.length} 个任务已重组为计划并存入会话（plan-store）。`,
    `直接调用 team_orchestrate({ objective: ${JSON.stringify(cp.objective)} })（不要传 planJson/planMarkdown——存储的计划会被自动消费，波次从剩余任务重新分组）。`,
    failed.length > 0 ? '注意：先检查上面未通过的 worker 是否需要先修复其遗留，再派发剩余任务。' : '',
  ].filter(Boolean).join('\n')
  return { planJson: serializeUnifiedPlan(plan), prompt }
}

/** Format checkpoint list for display. */
export function formatCheckpointList(checkpoints: Array<{ groupId: string; wave: number; totalWaves: number; timestamp: number }>): string {
  if (checkpoints.length === 0) return 'No checkpoints available.'
  const lines = ['Available checkpoints:', '']
  for (const cp of checkpoints) {
    const age = Math.round((Date.now() - cp.timestamp) / 1000)
    const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`
    lines.push(`  ${cp.groupId} — wave ${cp.wave + 1}/${cp.totalWaves} (${ageStr})`)
  }
  lines.push('', 'Use: /team resume <groupId> to resume from checkpoint.')
  return lines.join('\n')
}
