/**
 * Track 2: PlanCache 接线 team max — 计划骨架缓存。
 *
 * team max 的三视角 planner fanout（3×并行规划 worker）是整条链路上最贵的
 * 一步，且多波执行时主控按 fromWave 逐波重入 team_orchestrate，每波都会
 * 重新付一次规划成本。本模块把合并后的 TeamTask[] 骨架按 objective 哈希
 * 持久化到 bandit-state 存储（meridian DB，append-only 同一张表）：
 *
 * - 命中（同 objective 或关键词高重叠）→ 跳过 planner fanout，直接分波
 * - 失效：按 maxAgeMs 过期；结构校验失败的行直接忽略
 *
 * 与 agent 层 PlanCache（工具序列模板，进程内）互补：这里缓存的是
 * 团队级任务骨架，跨 session 持久化。
 */

import { createHash } from 'node:crypto'
import type { TeamTask } from './team-plan.js'

export interface TeamPlanCacheStore {
  saveBanditState?(kind: string, json: string): void
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

export interface TeamPlanSkeleton {
  schemaVersion: 1
  objectiveHash: string
  keywords: string[]
  mode: 'standard' | 'max'
  tasks: TeamTask[]
  createdAt: number
}

export const TEAM_PLAN_CACHE_PREFIX = 'team_plan_cache:'
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h — plans go stale as the repo moves
const SIMILARITY_THRESHOLD = 0.6
const SCAN_LIMIT = 100

export function hashPlanObjective(objective: string): string {
  return createHash('sha256').update(objective.trim().toLowerCase()).digest('hex').slice(0, 16)
}

export function teamPlanCacheKind(objectiveHash: string): string {
  return `${TEAM_PLAN_CACHE_PREFIX}${objectiveHash}`
}

export function extractPlanKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\u4e00-\u9fff]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && w.length < 40)
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 16)
}

function isValidTask(task: unknown): task is TeamTask {
  if (!task || typeof task !== 'object') return false
  const t = task as Record<string, unknown>
  return typeof t.id === 'string' && t.id.length > 0
    && typeof t.objective === 'string' && t.objective.length > 0
    && typeof t.profile === 'string'
    && typeof t.kind === 'string'
    && Array.isArray(t.files)
    && Array.isArray(t.dependsOn)
    && (t.riskTier === 'low' || t.riskTier === 'medium' || t.riskTier === 'high')
}

function parseSkeleton(json: string): TeamPlanSkeleton | null {
  try {
    const parsed = JSON.parse(json) as TeamPlanSkeleton
    if (parsed?.schemaVersion !== 1) return null
    if (typeof parsed.objectiveHash !== 'string' || !Array.isArray(parsed.keywords)) return null
    if (parsed.mode !== 'standard' && parsed.mode !== 'max') return null
    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return null
    if (!parsed.tasks.every(isValidTask)) return null
    if (typeof parsed.createdAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function saveTeamPlanSkeleton(
  store: TeamPlanCacheStore | undefined | null,
  input: { objective: string; mode: 'standard' | 'max'; tasks: TeamTask[]; timestamp?: number },
): void {
  if (!store?.saveBanditState || input.tasks.length === 0) return
  const skeleton: TeamPlanSkeleton = {
    schemaVersion: 1,
    objectiveHash: hashPlanObjective(input.objective),
    keywords: extractPlanKeywords(input.objective),
    mode: input.mode,
    tasks: input.tasks,
    createdAt: input.timestamp ?? Date.now(),
  }
  try {
    store.saveBanditState(teamPlanCacheKind(skeleton.objectiveHash), JSON.stringify(skeleton))
  } catch {
    // Plan cache writes must never affect team dispatch.
  }
}

export interface LoadTeamPlanSkeletonOptions {
  maxAgeMs?: number
  now?: number
}

/**
 * Exact objective-hash hit first; otherwise best keyword-overlap entry above
 * the similarity threshold. Returns null on miss, expiry, or store errors.
 */
export function loadTeamPlanSkeleton(
  store: TeamPlanCacheStore | undefined | null,
  objective: string,
  mode: 'standard' | 'max',
  options: LoadTeamPlanSkeletonOptions = {},
): TeamPlanSkeleton | null {
  if (!store?.loadBanditStatesByPrefix) return null
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const now = options.now ?? Date.now()
  const fresh = (s: TeamPlanSkeleton): boolean => now - s.createdAt <= maxAgeMs && s.mode === mode

  try {
    // Exact hash hit
    const hash = hashPlanObjective(objective)
    for (const row of store.loadBanditStatesByPrefix(teamPlanCacheKind(hash), 1)) {
      const skeleton = parseSkeleton(row.json)
      if (skeleton && fresh(skeleton)) return skeleton
    }

    // Keyword-similarity fallback
    const keywords = extractPlanKeywords(objective)
    if (keywords.length === 0) return null
    let best: TeamPlanSkeleton | null = null
    let bestScore = 0
    for (const row of store.loadBanditStatesByPrefix(TEAM_PLAN_CACHE_PREFIX, SCAN_LIMIT)) {
      const skeleton = parseSkeleton(row.json)
      if (!skeleton || !fresh(skeleton)) continue
      const overlap = keywords.filter(k => skeleton.keywords.includes(k)).length
      const score = overlap / Math.max(keywords.length, skeleton.keywords.length)
      if (score >= SIMILARITY_THRESHOLD && score > bestScore) {
        bestScore = score
        best = skeleton
      }
    }
    return best
  } catch {
    return null
  }
}
