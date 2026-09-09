/**
 * galaxy tool — 星河集群派发。
 *
 * 子 Agent（星域 worker）通过此工具将任务拆解为多个维度，由不同星域的
 * 分子 Agent 并行执行，结果汇总后统一审查。
 *
 * 设计原则（与 skill 工具同构）：
 *  - 工具 definition 字节稳定：不嵌入具体星域名称、维度名称或示例参数
 *  - 动态内容仅在 tool result 中返回
 *  - 调用前需过意图门禁（任务适合度 + 用户意图），未确认时展示方案
 *
 * 内部完全复用 delegate_batch 通道。
 */

import { z } from 'zod'
import { deriveStableWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../agent/coordinator.js'
import { classifyProfile } from '../agent/coordination-policy.js'
import { aggregationPolicyKinds, aggregationPolicySchema, type AggregationPolicy, type WorkOrderKind } from '../agent/work-order.js'
import { profileCanEditFiles, profileIsWriteCapable, profileRegistry, delegationToolTimeoutMs } from '../agent/profile-registry.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { formatWorkerResultDigest } from '../agent/worker-result-digest.js'
import { validatePathSafe } from './path-validate.js'
import { resolvePlanConstraints } from '../agent/plan-constraints.js'
import {
  MAX_TURNS_TOOL_DESCRIPTION,
  TIMEOUT_MS_TOOL_DESCRIPTION,
  delegateMaxTurnsSchema,
  delegateTimeoutMsSchema,
  toBudgetOverride,
} from './delegate-budget.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { createActivityStreamer, createDelegationActivityMapper, terminalActivity } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'
import { validateGalaxyDimensionContract } from '../agent/galaxy-contract.js'
import { buildGalaxyBudgetInputs, isReviewGalaxyDimension, mapGalaxyDimensionToKind, mapGalaxyDimensionToProfile, mapGalaxyDimensionToTaskShape } from '../agent/galaxy-budget.js'
import type { RuntimeCoordinatorSnapshot } from '../agent/runtime-self-model.js'

// ── Coordinator interface（与 delegate_batch 同构） ──────────────────────

export interface GalaxyCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
    onWorkerSettled?: (result: CoordinatorRun['results'][number]) => void,
  ): Promise<CoordinatorRun>
  /** Read-only runtime boundary check; absent in lightweight test/worker hosts. */
  getRuntimeSnapshot?: () => RuntimeCoordinatorSnapshot
  /** S4：DP 副本 A/B 候选模型池。缺省 undefined → DP 副本全部走默认路由
   *  （与旧行为一致，不轮换）。 */
  getCandidateModels?: () => Array<{ provider: string; model: string }>
  /** 星河路由学习（收编 #5）：结算时沉淀路由事实、proposal 时召回胜率。
   *  缺省 undefined → 路由学习关闭（现状行为）。 */
  domainKnowledgeStore?: import('../agent/domain-knowledge-store.js').DomainKnowledgeStore
  /** DP 证据冗余（收编 #2）：DP 维度派发时创建 quorum 冗余义务，副本
   *  evidenceStatus=verified 各计一次独立证据；deliver_task 门禁消费。
   *  缺省 undefined → 不创建义务（现状行为）。 */
  obligationTracker?: import('../agent/obligation-tracker.js').ObligationTracker
}

// ── Schema ───────────────────────────────────────────────────────────────

/** Dynamic profile validation — same as delegate-task.ts */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `未知 profile "${val}"。可用：${profileRegistry.getProfileNames().join(', ')}` }),
)

/** Dynamic star-domain validation — same as delegate-task.ts.
 *  Accepts both Chinese names (天机) and Pinyin IDs (tianji).
 *  Empty string treated as unspecified (not validated). */
const authorityStringSchema = z.string().refine(
  (val) => val === '' || starDomainRegistry.get(val) !== undefined,
  (val) => ({ message: `未知星域 "${val}"。可用：${starDomainRegistry.getDomainIds().join(', ')}` }),
)

const parallelismSchema = z.enum(['expert', 'data'])

const dimensionSchema = z.object({
  name: z.string().min(1).describe('维度标识（如 frontend / backend / review / test / docs）'),
  objective: z.string().min(1).describe('该维度的具体执行目标'),
  constraints: z.array(z.string()).max(12).optional().describe(
    '该维度必须遵守的任务级约束：计划里的反目标、待验证假设、不许动的东西。**逐字抄写原文，不要转述**——转述会丢掉约束的判据（曾把「加版本守卫只跑一次」压缩成「幂等」，执行方据此实现成每次开库都跑，删掉了真实数据）。worker 看不到计划文档，这是唯一的送达通道。',
  ),
  authority: authorityStringSchema.optional().describe('该维度使用的星域（单星域，与 authorities 二选一）'),
  authorities: z.array(authorityStringSchema).min(2).max(5).optional().describe(
    '该维度使用的多个星域，分别给出独立的只读视角；它们不共享实时上下文，也不能用于并行写入。与 authority 二选一。',
  ),
  parallelism: parallelismSchema.default('expert').describe(
    'expert：按专长派发单个分片（默认）；data：把同一只读任务复制给多个独立副本。',
  ),
  replicas: z.number().int().min(2).max(5).optional().describe(
    '仅 parallelism=data 时必填，表示独立只读副本数量（2–5）。',
  ),
  profile: profileStringSchema.optional().describe('worker profile。省略时按维度名推导：review → reviewer，verify → verify_scout（只读+run_tests），plan → planner，docs/research → doc_scout，其余（含实现类）→ patcher'),
  tierFloor: z.enum(['cheap', 'balanced', 'strong']).optional().describe(
    '模型档位硬地板（瑶光门）：声明后路由只抬不降。审查/验证维度建议 strong，实现维度按需。',
  ),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  maxTurns: delegateMaxTurnsSchema,
  timeoutMs: delegateTimeoutMsSchema,
  modelOverride: z.object({
    provider: z.string(),
    model: z.string(),
  }).optional().describe('为该维度指定专用模型（如审查用强模型、实现用快模型）'),
}).refine(
  d => (d.authority !== undefined && d.authority !== '') || (d.authorities !== undefined && d.authorities.length > 0),
  { message: '每个维度必须指定 authority 或 authorities（至少一个）' },
)

const galaxyInputSchema = z.object({
  objective: z.string().min(1).describe('集群总目标——要解决的完整任务描述'),
  dimensions: z.array(dimensionSchema).min(2).max(5).describe(
    '至少 2 个维度，最多 5 个。每个维度由指定星域的分子 Agent 独立执行。',
  ),
  autoReview: z.boolean().default(true).describe(
    '执行完成后自动追加审查维度（瑶光审查者）。默认开启。',
  ),
  confirm: z.boolean().default(false).describe(
    '用户已确认集群方案。首次调用不带此参数以展示方案并请求确认。',
  ),
  policy: aggregationPolicySchema.optional().describe('聚合策略。默认：all_required。'),
  /** D8 L2：计划文件路径——让维度 worker 自动继承计划的反目标与待验证假设。
   *  解析不到就是空，不报错不拦截。 */
  planPath: z.string().optional().describe(
    '可选，计划文件路径。维度 worker 会自动继承该计划的反目标与待验证假设。',
  ),
})

// ── Dimension → WorkOrderKind 映射 ──────────────────────────────────────
// 语义分类与 profile / taskShape 共用 galaxy-budget 的单一事实源，避免两张
// 映射表兜底方向相反（详见 galaxy-budget.ts 模块注释）。

function mapDimensionToKind(name: string): WorkOrderKind {
  return mapGalaxyDimensionToKind(name)
}

function galaxyWorkerParentTurnId(
  toolUseId: string,
  dimensionIndex: number,
  authorityIndex: number,
  replicaIndex?: number,
): string {
  // `batch:` makes coordinator work-order IDs deterministic, so dependency
  // edges point at the IDs the queue actually tracks.
  // deriveStableWorkOrderId 只取末两段——replica 必须编进末段，否则同一 authority
  // 的多个 DP 副本（乃至跨维度同 authorityIndex 的副本）会撞 work order ID。
  const lastSegment = replicaIndex === undefined ? `${authorityIndex}` : `${authorityIndex}r${replicaIndex}`
  return `batch:${toolUseId}-galaxy-${dimensionIndex}:${lastSegment}`
}

function workerOrderId(parentTurnId: string): string {
  return deriveStableWorkOrderId(parentTurnId) ?? parentTurnId
}

// ── Formatting ───────────────────────────────────────────────────────────

const GALAXY_GLYPH = '🌌'

/** 任务形状限定枚举（收编 #5 设计推荐）——自由文本聚类成本高且不稳定
 *  （frontend / Frontend UI / 前端 各自独立，胜率被稀释成精确重名匹配）。
 *  分类与 profile / kind 同源于 galaxy-budget 的 classifyGalaxyDimension。 */
type GalaxyTaskShape = ReturnType<typeof mapGalaxyDimensionToTaskShape>

function normalizeTaskShape(name: string): GalaxyTaskShape {
  return mapGalaxyDimensionToTaskShape(name)
}

/** 同 taskShape 历史路由按 authority × model 聚合胜率（收编 #5 召回侧 + S4
 *  模型维度）——DP 副本 A/B 沉淀后，proposal 能对比「同任务形状下哪个模型
 *  性价比最高」。model 缺失（旧记录）归入 '' 组展示为「默认」。
 *  L3：同时聚合 token 成本，输出「每通过成本」——质量与成本双目标可见。 */
function buildRoutingStats(
  store: import('../agent/domain-knowledge-store.js').DomainKnowledgeStore,
  dimensions: z.infer<typeof dimensionSchema>[],
): Array<{ dimensionName: string; taskShape: string; authority: string; model: string; passed: number; total: number; passRate: string; costPerPass?: number }> {
  const out: Array<{ dimensionName: string; taskShape: string; authority: string; model: string; passed: number; total: number; passRate: string; costPerPass?: number }> = []
  for (const d of dimensions) {
    const taskShape = normalizeTaskShape(d.name)
    const records = store.recallGalaxyRouting(taskShape)
    if (records.length === 0) continue
    const byKey = new Map<string, import('../agent/domain-knowledge-store.js').GalaxyRoutingRecord[]>()
    for (const r of records) {
      const key = `${r.authority}\u0000${r.model ?? ''}`
      const list = byKey.get(key)
      if (list) list.push(r)
      else byKey.set(key, [r])
    }
    for (const [key, rs] of byKey) {
      const [authority, model] = key.split('\u0000')
      const passed = rs.filter(r => r.status === 'passed').length
      const totalCost = rs.reduce((acc, r) => acc + (r.costTokens ?? 0), 0)
      out.push({
        dimensionName: d.name,
        taskShape,
        authority: authority!,
        model: model!,
        passed,
        total: rs.length,
        passRate: String(Math.round((passed / rs.length) * 100)),
        ...(passed > 0 && totalCost > 0 ? { costPerPass: Math.round(totalCost / passed) } : {}),
      })
    }
  }
  return out
}

/** 写维度判定（proposal 预检与 execute 剥离共用同一事实来源——两处漂移会让
 *  proposal 承诺的与 execute 实际执行的不一致）。B：改用文件编辑权判定——
 *  bash/run_tests 有执行权但不改文件，持此能力的验证维度可以并行读快照，
 *  不参与写维度文件认领。 */
function dimensionIsWriteCapable(dim: z.infer<typeof dimensionSchema>): boolean {
  return profileCanEditFiles((dim.profile ?? mapGalaxyDimensionToProfile(dim.name)) as import('../agent/work-order.js').WorkerProfile)
}

/** 静态预检（proposal 阶段）：写维度文件范围的重叠与覆盖缺口。
 *  只读维度并行读同一文件是安全的（work-queue.hasFileConflict 读读放行），
 *  因此只对写维度做认领归属分析。与 execute 阶段的剥离逻辑同构：
 *  fileOwner 按写维度首次认领，后续声明同一文件的写维度将丢失该文件；
 *  声明文件全被夺走的写维度会被跳过派发。在用户确认前暴露这两类问题，
 *  把返工堵在派发之前。 */
export interface GalaxyPlanPrecheckIssue {
  dimensionIndex: number
  dimensionName: string
  files: string[]
  kind: 'overlap' | 'emptied'
}

export function analyzeWriteDimensionPlan(
  dimensions: readonly z.infer<typeof dimensionSchema>[],
): GalaxyPlanPrecheckIssue[] {
  const issues: GalaxyPlanPrecheckIssue[] = []
  const fileOwner = new Map<string, number>()
  for (let i = 0; i < dimensions.length; i++) {
    const dim = dimensions[i]!
    if (!dimensionIsWriteCapable(dim)) continue
    for (const f of dim.files ?? []) {
      if (!fileOwner.has(f)) fileOwner.set(f, i)
    }
  }
  for (let i = 0; i < dimensions.length; i++) {
    const dim = dimensions[i]!
    if (!dimensionIsWriteCapable(dim)) continue
    const owned = dim.files ?? []
    const overlaps: string[] = []
    let kept = 0
    for (const f of owned) {
      const owner = fileOwner.get(f)
      if (owner === undefined || owner === i) { kept++; continue }
      overlaps.push(f)
    }
    if (overlaps.length > 0) {
      issues.push({ dimensionIndex: i, dimensionName: dim.name, files: overlaps, kind: 'overlap' })
    }
    // 原本有文件、全部被夺走 → execute 将跳过派发（emptiedWriteDims）。
    // 原本就没声明文件的写维度不预警——其命运由 coordinator 的 scope 闸独立裁决。
    if (owned.length > 0 && kept === 0) {
      issues.push({ dimensionIndex: i, dimensionName: dim.name, files: owned, kind: 'emptied' })
    }
  }
  return issues
}

function formatPlanPrecheck(issues: GalaxyPlanPrecheckIssue[]): string {
  if (issues.length === 0) {
    return ['', '── 静态预检 ──', '✓ 写维度文件范围无重叠、无覆盖缺口。'].join('\n')
  }
  const lines: string[] = ['', '── 静态预检（执行前修正，避免派发后返工）──']
  for (const issue of issues) {
    if (issue.kind === 'overlap') {
      lines.push(`⚠ 维度「${issue.dimensionName}」的文件与更早的写维度重叠，执行时将被剥离：${issue.files.join(', ')}`)
    } else if (isReviewGalaxyDimension(issue.dimensionName)) {
      lines.push(`⚠ 维度「${issue.dimensionName}」是审查族，声明的文件全部被其他写维度认领，执行时将降级为只读验证继续派发：${issue.files.join(', ')}`)
    } else {
      lines.push(`⚠ 维度「${issue.dimensionName}」声明的文件全部被其他写维度认领，派发时将被跳过：${issue.files.join(', ')}`)
    }
  }
  lines.push('请调整维度划分：写维度文件范围必须互不重叠。')
  return lines.join('\n')
}

function formatGalaxyProposal(
  objective: string,
  dimensions: z.infer<typeof dimensionSchema>[],
  autoReview: boolean,
  routingStats?: Array<{ dimensionName: string; taskShape: string; authority: string; model: string; passed: number; total: number; passRate: string; costPerPass?: number }>,
): string {
  const lines: string[] = [
    `${GALAXY_GLYPH} 星河集群方案`,
    '',
    `目标：${objective}`,
    '',
    `分子 Agent 组成（${dimensions.length} 个维度${autoReview && !dimensions.some(d => isReviewGalaxyDimension(d.name)) ? ' + 1 自动审查' : ''}）：`,
  ]

  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i]!
    const stars = d.authorities ?? (d.authority ? [d.authority] : [])
    const starLabels = stars.map(s => {
      const star = starDomainRegistry.get(s)
      return star ? `${star.name}` : s
    })
    const parallelTag = d.parallelism === 'data' ? ` DP × ${d.replicas ?? '?'}` : ' EP'
    const roomTag = stars.length > 1 ? ` ◌ 多视角（${starLabels.join(' + ')}）` : ` — ${starLabels[0]}`
    lines.push(`  ${i + 1}. ${d.name}${parallelTag}${roomTag}`)
    lines.push(`     ${d.objective}`)
  }

  if (autoReview && !dimensions.some(d => isReviewGalaxyDimension(d.name))) {
    const yaoguang = starDomainRegistry.get('yaoguang')
    const label = yaoguang ? `瑶光（${yaoguang.motto.slice(0, 12)}…）` : '瑶光'
    lines.push(`  ${dimensions.length + 1}. review — ${label}`)
    lines.push(`     审查以上所有维度的输出，验证正确性、完整性和安全性`)
  }

  // 路由学习召回（收编 #5 + S4 + L3）：同任务形状的历史路由，按
  // authority × model 聚合胜率与每通过成本——模型性价比（质量/成本）对比可见。
  if (routingStats && routingStats.length > 0) {
    lines.push('', '历史路由（同任务形状 · authority × 模型：胜率 / 每通过成本）：')
    for (const r of routingStats) {
      const cost = r.costPerPass !== undefined ? ` · 每通过 ~${(r.costPerPass / 1000).toFixed(1)}k tokens` : ''
      lines.push(`  ${r.authority} @ ${r.dimensionName}${r.model ? ` · ${r.model}` : ' · 默认'}: ${r.passed}/${r.total} 通过（${r.passRate}%）${cost}`)
    }
  }

  lines.push('')
  lines.push('调用 galaxy({..., confirm: true}) 确认并执行。')

  return lines.join('\n')
}

interface GalaxyResultTarget {
  workOrderId: string
  label: string
  /** 该 worker 请求的 modelOverride.model——与实际选中模型对比以暴露静默回退。 */
  requestedModel?: string
}

interface GalaxyDataParallelGroup {
  label: string
  workOrderIds: string[]
  /** 派发时声明的组级 quorum 阈值（ceil(replicas/2)），展示判定用真实值。 */
  quorumK: number
}

/** 从聚合注记提取组内原始通过数。quorum 组未达 k 时通过成员被聚合降级为
 *  failed（组结论不可采信），status 统计已抹平原始通过数——它只存在于
 *  我们自己的 risks 注记里（格式见 aggregation.ts applyQuorum）。 */
function quorumOriginalPassed(risks: readonly string[]): number | undefined {
  for (const r of risks) {
    const m = /^quorum: group .* not reached — (\d+)\/\d+ passed/.exec(r)
    if (m) return Number(m[1])
  }
  return undefined
}

/** 检测所有 DP 组 quorum 是否达成。返回未达成的组名列表（空 = 全部达成）。 */
/** 组 quorum 通过数：聚合后的 status 已编码组判定（组未达 k → 成员全
 *  failed），原始通过数在组失败时从 risks 注记恢复（格式见 aggregation.ts
 *  applyQuorum）。组通过时无注记，直接统计 passed。 */
function quorumPassedCount(
  group: GalaxyDataParallelGroup,
  resultsById: Map<string, import('../agent/work-order.js').WorkerResult>,
): number {
  const replicaResults = group.workOrderIds
    .map(id => resultsById.get(id))
    .filter((r): r is import('../agent/work-order.js').WorkerResult => r !== undefined)
  let passed = replicaResults.filter(r => r.status === 'passed').length
  for (const r of replicaResults) {
    const original = quorumOriginalPassed(r.risks)
    if (original !== undefined) { passed = original; break }
  }
  return passed
}

function checkDpQuorum(
  dataParallelGroups: GalaxyDataParallelGroup[],
  resultsById: Map<string, import('../agent/work-order.js').WorkerResult>,
): string[] {
  const failed: string[] = []
  for (const group of dataParallelGroups) {
    if (quorumPassedCount(group, resultsById) < group.quorumK) failed.push(group.label)
  }
  return failed
}

function formatGalaxyResult(
  run: CoordinatorRun,
  targets: GalaxyResultTarget[],
  dataParallelGroups: GalaxyDataParallelGroup[],
  strippedFiles: Array<{ label: string; files: string[] }> = [],
  emptiedDims: string[] = [],
  downgradedReviewDims: string[] = [],
): string {
  const passed = run.results.filter(r => r.status === 'passed').length
  const total = run.results.length

  const lines: string[] = [
    `${GALAXY_GLYPH} 星河集群执行报告 · ${passed}/${total} 通过`,
    '',
  ]

  // modelOverride 静默 fallback 可见性（P2-3）：请求模型与实际选中不一致时
  // 必须写出来——否则「审查用强模型」的分派意图被降级了无人知晓。
  const actualModelById = new Map((run.workerModels ?? []).map(w => [w.workOrderId, w.model]))

  const resultsById = new Map(run.results.map(result => [result.workOrderId, result]))
  const unmatched = [...run.results]
  for (const target of targets) {
    const r = resultsById.get(target.workOrderId) ?? unmatched.shift()
    if (!r) continue
    const matchedIndex = unmatched.indexOf(r)
    if (matchedIndex >= 0) unmatched.splice(matchedIndex, 1)

    const digest = formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      sourcesReviewedCount: r.sourcesReviewed,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
      salvagedFindingsCount: r.findings?.filter(f => f.salvaged === true).length ?? 0,
    })

    const actualModel = actualModelById.get(target.workOrderId) ?? r.model
    const fallbackNote = target.requestedModel && actualModel && actualModel !== target.requestedModel
      ? ` ⚠ 模型回退：请求 ${target.requestedModel} → 实际 ${actualModel}`
      : ''
    // M2 时间账：每维度 wall-clock（含等槽排队）——排队长/执行慢可区分。
    const wallNote = r.durationMs !== undefined
      ? ` · ${(r.durationMs / 1000).toFixed(1)}s`
      : ''
    lines.push(`  ${target.label}: ${digest}${fallbackNote}${wallNote}`)
    if (r.changedFiles.length > 0) {
      lines.push(`      changed: ${r.changedFiles.slice(0, 5).join(', ')}`)
      if (r.changedFiles.length > 5) lines.push(`      … (+${r.changedFiles.length - 5} more)`)
    }
    lines.push('')
  }
  for (const r of unmatched) {
    const digest = formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      sourcesReviewedCount: r.sourcesReviewed,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
      salvagedFindingsCount: r.findings?.filter(f => f.salvaged === true).length ?? 0,
    })
    lines.push(`  未映射 worker ${r.workOrderId}: ${digest}`)
    lines.push('')
  }

  // 文件重叠剥离清单（P2-1）：重叠通常是维度划分问题，必须可见。
  if (strippedFiles.length > 0) {
    lines.push('  ⚠ 文件重叠已剥离（只保留首个可写维度的归属，请核查维度划分）：')
    for (const s of strippedFiles) {
      lines.push(`      ${s.label}: ${s.files.join(', ')}`)
    }
    lines.push('')
  }

  // 文件全被夺走的写维度（M3）：跳过派发而非派到闸口撞墙，必须可见。
  if (emptiedDims.length > 0) {
    lines.push(`  ⚠ 写维度文件全部被其他维度夺走，已跳过派发（请核查维度划分）：${emptiedDims.join('、')}`)
    lines.push('')
  }

  // B：审查族维度被夺空后降级为只读验证继续派发，必须可见。
  if (downgradedReviewDims.length > 0) {
    lines.push(`  ⚠ 审查族维度文件被夺空，已降级为只读验证继续派发：${downgradedReviewDims.join('、')}`)
    lines.push('')
  }

  for (const group of dataParallelGroups) {
    const replicaResults = group.workOrderIds
      .map(id => resultsById.get(id))
      .filter((result): result is NonNullable<typeof result> => result !== undefined)
    const passedReplicas = quorumPassedCount(group, resultsById)
    const verdict = passedReplicas >= group.quorumK ? 'reached' : 'not reached'
    lines.push(`  DP ${group.label}: execution quorum ${verdict} (${passedReplicas}/${group.workOrderIds.length}, quorum ${group.quorumK})`)
    // Per-replica cacheRead — 批级共享预热（P0-1）收益的直接度量：
    // 副本 1 冷读、副本 2..N 应显著更高。
    const replicaReads = group.workOrderIds.map(id => resultsById.get(id)?.usage?.cache_read_input_tokens)
    if (replicaReads.some(v => v !== undefined)) {
      lines.push(`      replica cacheRead: ${replicaReads.map(v => v ?? '—').join(' / ')}`)
    }
  }

  // DP quorum 结构化判定：未达成的组进报告红区并供上游消费。
  const quorumFailed = checkDpQuorum(dataParallelGroups, resultsById)
  if (quorumFailed.length > 0) {
    lines.push(`  ⚠ DP quorum 未达成：${quorumFailed.join('、')} 组多数副本未通过，结论不可采信。`)
    lines.push('')
  }

  if (dataParallelGroups.length > 0) {
    lines.push('  DP replicas are independent evidence sources; final semantic review remains required.')
    lines.push('')
  }

  // 聚合缓存/用量行（P0-2）——预热与缓存亲和的收益在报告里可见、可对照。
  // usage 是 Partial（worker 可能缺 cache 字段），缺失计 0。
  const usages = run.results.map(r => r.usage)
  const sumOf = (pick: (u: NonNullable<(typeof usages)[number]>) => number | undefined): number =>
    usages.reduce((acc, u) => acc + (u ? (pick(u) ?? 0) : 0), 0)
  const totalInput = sumOf(u => u.input_tokens)
  const totalCacheRead = sumOf(u => u.cache_read_input_tokens)
  if (totalInput > 0 || totalCacheRead > 0) {
    const hitRate = totalInput > 0 ? ((totalCacheRead / totalInput) * 100).toFixed(1) : '0.0'
    lines.push(`  缓存用量: input Σ${totalInput} · cacheRead Σ${totalCacheRead} · 命中率 ${hitRate}%（${total} worker 聚合）`)
    lines.push('')
  }

  // 聚合结论
  const allPassed = passed === total
  const hasFindings = run.results.some(r => r.findings.length > 0)

  // 核验护栏（对齐 WORKER_RESULTS_HINT 语义，worker-prompts.ts:410）：未经
  // verification 的只读发现是「待核验假设」，不是已验证事实。
  if (hasFindings && run.results.some(r => r.verification?.status !== 'passed')) {
    lines.push('核验提醒：以上发现来自只读扫描或子代理摘要，属「待核验假设」——引用到具体文件前，请用 read_file/grep 独立确认。')
  }

  if (allPassed) {
    lines.push('聚合结论: 所有维度通过。')
  } else {
    const failed = total - passed
    lines.push(`聚合结论: ${failed}/${total} 个维度未通过，请检查上述摘要并在本回合内修复后再交付。`)
  }
  if (hasFindings && !allPassed) {
    lines.push('各维度发现的问题已标注在上方，优先修复阻塞项。')
  }

  if (run.escalated) {
    lines.push('⚠ 子代理连续失败已升级，建议改为内联执行或缩小范围。')
  }

  return lines.join('\n')
}

function formatGalaxyUi(
  run: CoordinatorRun,
  dimensions: z.infer<typeof dimensionSchema>[],
): string {
  const passed = run.results.filter(r => r.status === 'passed').length
  const total = run.results.length
  return `${GALAXY_GLYPH} 星河 · ${passed}/${total} 通过`
}

// ── Tool factory ─────────────────────────────────────────────────────────

export function createGalaxyTool(coordinator: GalaxyCoordinator): Tool {
  return {
    definition: {
      name: 'galaxy',
      description: `启动星河集群——将复杂任务拆解为 2-5 个维度，由不同星域的分子 Agent 并行执行，结果汇总后统一审查。

## 何时使用
- 任务天然跨层（UI+逻辑+数据 / 前后端 / 实现+测试）
- 用户要求并行/多维处理（"星河""集群""并行分析""从多个角度"）
- 复杂度高，单一 worker 预算不够

## 调用协议（两阶段）
1. 首次调用 galaxy({objective, dimensions, confirm: false}) 展示方案，等待用户确认
2. 用户确认后调用 galaxy({objective, dimensions, confirm: true}) 启动执行

## 星域选择（dimensions[].authority 或 .authorities）
- 前端/UI → 文曲 · 后端/逻辑 → 天机 · 架构/规划 → 天权 · 实现/编码 → 天梁
- 审查/验证 → 瑶光 · 探索/攻坚 → 破军 · 重构/优化 → 天府 · 数据/对账 → 开阳 · 文档/调研 → 天璇

## 硬性约束
- 可写维度必须拆成文件范围不重叠的单 authority 维度
- 多 authority 仅用于独立只读视角（不共享实时上下文）；写任务禁止多 authority
- parallelism=data 只读副本；autoReview 默认追加瑶光审查；policy 默认 all_required`,
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '集群总目标——要解决的完整任务描述' },
          dimensions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '维度标识（如 frontend / backend / review / test / docs）' },
                objective: { type: 'string', description: '该维度的具体执行目标' },
                constraints: { type: 'array', items: { type: 'string' }, maxItems: 12, description: '该维度必须遵守的任务级约束：计划里的反目标、待验证假设、不许动的东西。逐字抄写原文，不要转述——worker 看不到计划文档，这是唯一的送达通道。' },
                authority: { type: 'string', description: '该维度使用的星域 id。单星域时使用，与 authorities 二选一。' },
                authorities: { type: 'array', items: { type: 'string' }, description: '该维度使用多个星域作独立只读分析；不共享实时上下文，也不能用于并行写入。与 authority 二选一。' },
                parallelism: { type: 'string', enum: ['expert', 'data'], default: 'expert', description: 'expert 为按专长的单分片派发；data 为同一只读任务的独立副本。' },
                replicas: { type: 'integer', minimum: 2, maximum: 5, description: '仅 data 模式：独立副本数。' },
                profile: { type: 'string', enum: profileRegistry.getProfileNames(), description: 'worker profile。默认按维度名自动推导。' },
                tierFloor: { type: 'string', enum: ['cheap', 'balanced', 'strong'], description: '模型档位硬地板：声明后路由只抬不降。' },
                files: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的文件路径。' },
                symbols: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的符号。' },
                maxTurns: { type: 'integer', description: MAX_TURNS_TOOL_DESCRIPTION },
                timeoutMs: { type: 'integer', description: TIMEOUT_MS_TOOL_DESCRIPTION },
                modelOverride: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } }, description: '可选，为该维度指定专用 provider/model。审查用强模型，实现用快/便宜模型。' },
              },
              required: ['name', 'objective'],
            },
            minItems: 2,
            maxItems: 5,
            description: '至少 2 个维度，最多 5 个。每个维度由指定星域的分子 Agent 独立执行。',
          },
          autoReview: { type: 'boolean', default: true, description: '执行完成后自动追加审查维度（瑶光）。默认开启。' },
          confirm: { type: 'boolean', default: false, description: '用户已确认集群方案。首次调用不带此参数以展示方案并请求确认。' },
          policy: { type: 'string', enum: [...aggregationPolicyKinds], description: '聚合策略。默认：all_required。' },
          planPath: { type: 'string', description: '可选，计划文件路径。维度 worker 会自动继承该计划的反目标与待验证假设。' },
        },
        required: ['objective', 'dimensions'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = galaxyInputSchema.safeParse(params.input)
      if (!parsed.success) {
        return {
          content: `星河参数错误：${parsed.error.message}`,
          isError: true,
          errorKind: 'format_error',
        }
      }

      const { objective, dimensions, autoReview, confirm, policy, planPath } = parsed.data

      // Validate the complete plan before creating obligations or reserving
      // workers. This mirrors Codex's spawn protocol: invalid child
      // configuration is rejected atomically and all corrections are shown
      // together instead of failing after a partial fan-out.
      const contractIssues = validateGalaxyDimensionContract(dimensions)
      if (contractIssues.length > 0) {
        return {
          content: [
            'Galaxy contract validation failed:',
            ...contractIssues.map(issue => `- dimension #${issue.dimensionIndex + 1}: ${issue.message}`),
          ].join('\n'),
          isError: true,
          errorKind: 'format_error',
        }
      }

      // D8 L2：从 planPath 解析计划约束（反目标/待验证假设），合并进各维度的 constraints。
      const planConstraints = planPath
        ? resolvePlanConstraints(params.cwd, { planPath, objective })
        : undefined

      // DP 组合法策略：all_required（默认）或 quorum（组级判定）。其他策略
      // （first_success/majority 等）会把 DP 副本当普通 worker 聚合掉，破坏
      // 「保留每个副本的结果和证据」的语义，仍拦截。
      const hasDataParallel = dimensions.some(dimension => dimension.parallelism === 'data')
      const isQuorumPolicy = typeof policy === 'object' && policy?.kind === 'quorum'
      if (hasDataParallel && policy && policy !== 'all_required' && !isQuorumPolicy) {
        return {
          content: '星河已拦截：DP 需要保留每个副本的结果和证据，聚合策略仅支持 all_required（默认）或 quorum（组级判定，副本通过数 ≥ k 才采信组结论）。语义分歧由后续审查维度处理。',
          isError: true,
        }
      }
      // DP 存在时默认组级 quorum（k=1：无组 worker 独立判定、perspective 组
      // 全通过即保留；DP 组由各请求的 quorumK 覆盖为 floor(replicas/2)+1）。
      const effectivePolicy: AggregationPolicy = hasDataParallel
        ? (isQuorumPolicy ? policy! : { kind: 'quorum', k: 1 })
        : (policy ?? 'all_required')

      // Viability gate: a coordinator that is already shutting down must not
      // admit a new fan-out. This is especially important during handoff or
      // model/session replacement: existing workers are allowed to settle, but
      // a new Galaxy request would otherwise reserve claims after shutdown has
      // begun. Other degraded signals remain observable and are handled by the
      // coordinator's normal liveness/claim gates rather than being blanket
      // rejected here.
      let runtime: RuntimeCoordinatorSnapshot | undefined
      try {
        runtime = coordinator.getRuntimeSnapshot?.()
      } catch {
        // Runtime telemetry is advisory; a broken snapshot must not prevent a
        // normal Galaxy dispatch. The coordinator's own gates remain active.
      }
      if (runtime?.shuttingDown) {
        return {
          content: '星河已拦截：协调器正在关闭或移交中，暂不接受新的集群派发；请等待当前任务收尾后重试。',
          isError: true,
          errorKind: 'runtime_gate',
        }
      }

      // Pre-flight: validate file paths
      for (let i = 0; i < dimensions.length; i++) {
        const dimension = dimensions[i]!
        const files = dimension.files
        if (files && files.length > 0) {
          const bad = files.filter(f => !validatePathSafe(params.cwd, f).ok)
          if (bad.length > 0) {
            return {
              content: `星河已拦截：维度「${dimensions[i]!.name}」引用了项目目录外的文件：${bad.join(', ')}`,
              isError: true,
            }
          }
        }
        const stars = dimension.authorities ?? []
        const profile = (dimension.profile ?? mapGalaxyDimensionToProfile(dimension.name)) as import('../agent/work-order.js').WorkerProfile
        if (dimension.parallelism === 'data') {
          if (!dimension.replicas) {
            return { content: `星河已拦截：DP 维度「${dimension.name}」必须指定 replicas（2–5）。`, isError: true }
          }
          if (dimension.authorities?.length) {
            return { content: `星河已拦截：DP 维度「${dimension.name}」只能使用单个 authority；多专家意见请使用 expert 模式的 authorities。`, isError: true }
          }
          if (profileCanEditFiles(profile)) {
            return { content: `星河已拦截：DP 维度「${dimension.name}」使用了可编辑文件的 profile「${profile}」。DP 只允许独立只读/验证副本（验证副本可 run_tests），写入请拆成 EP 单专家分片。`, isError: true }
          }
        }
        if (stars.length > 1 && classifyProfile(profile) === 'hands') {
          return {
            content: `星河已拦截：维度「${dimension.name}」包含多个 authority，但其 profile 可写。多 authority 只用于独立只读视角；请拆成文件范围不重叠的单 authority 执行维度。`,
            isError: true,
          }
        }
      }

      // ── Phase 1: Proposal (no confirm) ────────────────────────────
      if (!confirm) {
        const routingStats = coordinator.domainKnowledgeStore
          ? buildRoutingStats(coordinator.domainKnowledgeStore, dimensions)
          : undefined
        const proposal = formatGalaxyProposal(objective, dimensions, autoReview, routingStats)
        const precheck = formatPlanPrecheck(analyzeWriteDimensionPlan(dimensions))
        return {
          content: [
            proposal,
            precheck,
            '',
            '请确认此星河方案是否可行。确认后调用 galaxy({..., confirm: true}) 启动执行。',
            '如需调整维度或星域，请说明修改内容。',
          ].join('\n'),
          uiContent: `${GALAXY_GLYPH} 星河方案 · ${dimensions.length} 维度`,
        }
      }

      // ── Phase 2: Execute ──────────────────────────────────────────

      // Build delegate_batch requests. A multi-authority dimension is a
      // read-only, independent-perspectives fan-out, not a shared room.
      const requests: DelegationRequest[] = []
      const dimensionIndexByParentTurnId = new Map<string, number>()
      const replicaIndexByParentTurnId = new Map<string, number>()
      const dataParallelGroups = new Map<number, GalaxyDataParallelGroup>()
      const dpObligationByDim = new Map<number, string>()
      const explicitReviewIndexes = new Set(
        dimensions.flatMap((dimension, index) => isReviewGalaxyDimension(dimension.name) ? [index] : []),
      )

      for (let i = 0; i < dimensions.length; i++) {
        const dim = dimensions[i]!
        const stars = dim.authorities ?? (dim.authority && dim.authority !== '' ? [dim.authority] : [])
        const isDataParallel = dim.parallelism === 'data'
        const perspectiveGroupId = stars.length > 1 ? `galaxy:perspectives:${params.toolUseId}:${i}` : undefined
        const dataParallelGroupId = isDataParallel ? `galaxy:data:${params.toolUseId}:${i}` : undefined
        const replicaCount = isDataParallel ? dim.replicas! : 1
        if (isDataParallel) {
          const quorumK = Math.floor(dim.replicas! / 2) + 1
          dataParallelGroups.set(i, { label: dim.name, workOrderIds: [], quorumK })
          // 收编 #2：DP 维度创建 quorum 冗余义务——k 个独立副本 verified 才关闭，
          // deliver_task 门禁在义务未满足时拦交付。缺 tracker（测试/旧装配）不创建。
          if (coordinator.obligationTracker) {
            const obligationId = coordinator.obligationTracker.upsert({
              family: 'behavior',
              claim: `星河 DP 维度「${dim.name}」的结论经 ${quorumK} 个独立副本验证（quorum=${quorumK}/${dim.replicas}）`,
              targets: dim.files ?? [],
              risk: 'high',
              redundancy: { kind: 'quorum', k: quorumK, groupId: dataParallelGroupId },
            })
            dpObligationByDim.set(i, obligationId)
          }
        }

        for (let j = 0; j < stars.length; j++) {
          const star = stars[j]!
          const profile = (dim.profile ?? mapGalaxyDimensionToProfile(dim.name)) as import('../agent/work-order.js').WorkerProfile
          for (let replicaIndex = 0; replicaIndex < replicaCount; replicaIndex++) {
            const parentTurnId = galaxyWorkerParentTurnId(params.toolUseId, i, j, isDataParallel ? replicaIndex : undefined)
            dimensionIndexByParentTurnId.set(parentTurnId, i)
            if (isDataParallel) replicaIndexByParentTurnId.set(parentTurnId, replicaIndex)
            const workOrderId = workerOrderId(parentTurnId)
            if (isDataParallel) dataParallelGroups.get(i)!.workOrderIds.push(workOrderId)

            // S4：DP 副本模型 A/B——副本 1 走默认路由，副本 2..N 轮换候选
            // 模型（仅当未显式 modelOverride 且协调器提供候选池）。同一任务
            // 不同模型跑出独立副本，结算时按 model 沉淀路由事实，供后续
            // proposal 选择「同任务形状下性价比最高」的模型。
            let modelOverride = dim.modelOverride
            if (isDataParallel && modelOverride === undefined && replicaIndex > 0) {
              const candidates = coordinator.getCandidateModels?.() ?? []
              if (candidates.length > 0) {
                const candidate = candidates[(replicaIndex - 1) % candidates.length]!
                modelOverride = { provider: candidate.provider, model: candidate.model }
              }
            }

            requests.push({
            parentTurnId,
            objective: isDataParallel
              ? `${dim.objective}\n\nData-parallel replica ${replicaIndex + 1}/${replicaCount}: independently inspect the same evidence. Do not modify files, do not assume other replicas' conclusions, and report concrete evidence, uncertainty, and recommended follow-up.`
              : stars.length > 1
              ? `${dim.objective}\n\n多视角分析：你与其他星域专家独立检查同一问题，但不共享实时上下文。只做证据驱动的分析与建议，不修改文件；明确列出依据、风险和建议。其他视角：${stars.filter(s => s !== star).map(s => { const sd = starDomainRegistry.get(s); return sd ? sd.name : s }).join('、')}。`
              : isReviewGalaxyDimension(dim.name)
              ? `${dim.objective}\n\n只读验证：不修改任何文件；可运行测试验证行为（run_tests），输出证据包（命令、exit code、通过/失败计数、失败项原文）。`
              : profileIsWriteCapable(profile)
              ? `${dim.objective}\n\n工业级交付要求：1. 读代码→2. 先写失败测试复现问题（RED）→3. 修改代码使测试通过（GREEN）→4. 运行 typecheck/lint→5. 确认路径通达。不满足任何一条不算完成。注意：不先写测试直接改代码会被 evidence gate 拦截。`
              : `${dim.objective}\n\n只读分析：不修改任何文件；给出证据驱动的结论、不确定项和建议。`,
            kind: mapDimensionToKind(dim.name),
            profile,
            authority: star,
            // D8 L2：维度级约束在前，计划级在后（维度级更贴，优先占满 12 条预算）。
            constraints: planConstraints && planConstraints.length > 0
              ? [...(dim.constraints ?? []), ...planConstraints]
              : dim.constraints,
            scope: { files: dim.files, symbols: dim.symbols },
            modelOverride,
            tierFloor: dim.tierFloor,
            groupId: dataParallelGroupId ?? perspectiveGroupId,
            quorumK: isDataParallel ? Math.floor(dim.replicas! / 2) + 1 : undefined,
            ...(dim.timeoutMs || dim.maxTurns
              ? { budget: toBudgetOverride({ timeoutMs: dim.timeoutMs, maxTurns: dim.maxTurns }) }
              : {}),
            })
          }
        }
      }

      // Fail early if any dimension has no valid star assigned
      if (requests.length === 0) {
        return { content: '星河执行失败：所有维度均未指定有效星域。每个维度必须指定 authority 或 authorities。', isError: true }
      }

      // ── 文件重叠去重：只对可写维度生效（只读维度并行读同一快照是安全的，
      // work-queue 也只序列化写侧）；被剥离的文件显式进报告——重叠本质是
      // 维度划分问题，静默丢弃会让维度丢上下文且无人知晓。
      const fileOwner = new Map<string, number>() // file path → first WRITE dimension index
      for (let i = 0; i < dimensions.length; i++) {
        if (!dimensionIsWriteCapable(dimensions[i]!)) continue
        for (const f of dimensions[i]!.files ?? []) {
          if (!fileOwner.has(f)) fileOwner.set(f, i)
        }
      }
      const strippedByDim = new Map<number, string[]>()
      for (const req of requests) {
        const dimIdx = dimensionIndexByParentTurnId.get(req.parentTurnId)
        if (dimIdx === undefined || !dimensionIsWriteCapable(dimensions[dimIdx]!)) continue
        const owned = dimensions[dimIdx]?.files ?? []
        const deduped: string[] = []
        for (const f of owned) {
          const owner = fileOwner.get(f)
          if (owner === undefined || owner === dimIdx) { deduped.push(f); continue }
          if (!strippedByDim.has(dimIdx)) strippedByDim.set(dimIdx, [])
          strippedByDim.get(dimIdx)!.push(f)
        }
        ;(req as any).scope = { ...req.scope, files: deduped }
      }

      // M3 修复（审查）：文件「被去重夺走」的写维度不再派发到闸口——显式跳过
      // 并入报告。只认 original>0 → deduped=0（被夺走）；原本就无 files 的写维度
      // 不拦（其命运由 coordinator 的 scope 闸独立裁决，galaxy 层不越权）。
      // 「全部文件被夺走」本质是维度划分问题，必须可见。
      // B：审查族维度声明 files 的本意是聚焦审查范围而非独占写权——被夺空时
      // 降级为只读验证继续派发（objective 界定范围），不整个维度跳过。
      const emptiedWriteDims: string[] = []
      const downgradedReviewDims: string[] = []
      for (let i = requests.length - 1; i >= 0; i--) {
        const dimIdx = dimensionIndexByParentTurnId.get(requests[i]!.parentTurnId)
        if (dimIdx === undefined || !dimensionIsWriteCapable(dimensions[dimIdx]!)) continue
        const dim = dimensions[dimIdx]!
        const originalCount = dim.files?.length ?? 0
        const currentCount = requests[i]!.scope?.files?.length ?? 0
        if (originalCount === 0 || currentCount > 0) continue
        if (isReviewGalaxyDimension(dim.name)) {
          ;(requests[i] as any).scope = { ...requests[i]!.scope, files: [] }
          requests[i]!.objective = `${requests[i]!.objective}\n\n⚠ 维度文件范围已被其他写维度独占，降级为只读验证：不得修改任何文件；验证范围以上文 objective 为准。`
          downgradedReviewDims.push(dim.name)
        } else {
          emptiedWriteDims.unshift(dim.name)
          requests.splice(i, 1)
        }
      }
      if (requests.length === 0) {
        return { content: `星河执行失败：全部可写维度的文件均被其他维度夺走（${emptiedWriteDims.join('、')}）。请重新划分不重叠的维度文件范围。`, isError: true }
      }

      // A review is a true join node. Use stable work-order IDs, not request
      // parent IDs, because the queue only tracks the former.
      const executionWorkerIds = requests
        .filter(request => !explicitReviewIndexes.has(dimensionIndexByParentTurnId.get(request.parentTurnId) ?? -1))
        .map(request => workerOrderId(request.parentTurnId))
      const explicitReviewRequests = requests.filter(request =>
        explicitReviewIndexes.has(dimensionIndexByParentTurnId.get(request.parentTurnId) ?? -1),
      )
      for (const request of explicitReviewRequests) {
        request.dependencies = executionWorkerIds
      }

      const hasExplicitReview = explicitReviewIndexes.size > 0
      if (autoReview && !hasExplicitReview) {
        const autoReviewParentTurnId = `batch:${params.toolUseId}-galaxy:auto-review`
        requests.push({
          parentTurnId: autoReviewParentTurnId,
          objective: '全局审查——星河集群所有执行维度已完成。逐项验证：正确性、完整性、安全性、边界条件。特别关注跨维度冲突（如前后端接口不一致）。输出通过的项和需修复的项。',
          kind: 'review',
          profile: 'reviewer',
          authority: 'yaoguang',
          scope: { files: [] },
          dependencies: executionWorkerIds,
        })
      }
      // Freeze the dispatch plan before handing it to the coordinator.  This
      // is the same stable-plan boundary used by Codex's typed spawn events:
      // the result can explain what was planned, what was actually dispatched,
      // and which write shards were intentionally skipped.
      const plannedWorkerCount = requests.length
      const plannedDataWorkers = [...dataParallelGroups.values()]
        .reduce((total, group) => total + group.workOrderIds.length, 0)
      const plannedParallelism = {
        expert: Math.max(0, plannedWorkerCount - plannedDataWorkers),
        data: plannedDataWorkers,
      }

      // Activity streaming
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      // Activity streaming — map all worker IDs to their objectives
      const objectiveById = new Map<string, string>()
      for (const req of requests) {
        const dim = dimensions[dimensionIndexByParentTurnId.get(req.parentTurnId) ?? -1]
        const stars = dim ? (dim.authorities ?? (dim.authority ? [dim.authority] : [])) : []
        const perspectiveNote = stars.length > 1 ? ` ◌ ${dim!.name}` : ''
        const label = req.objective || perspectiveNote || '审查'
        objectiveById.set(req.parentTurnId, label)
        objectiveById.set(workerOrderId(req.parentTurnId), label)
      }
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity, {
            objectiveOf: (id) => objectiveById.get(id),
          })
        : undefined
      const streamActivity = (textStreamer || activityMapper)
        ? (ev: WorkerActivityEvent) => {
            textStreamer?.(ev)
            activityMapper?.(ev)
          }
        : undefined

      // Attach activity handler to requests
      for (const req of requests) {
        req.onActivity = streamActivity
        req.onNestedActivity = params.onWorkerActivity
      }

      // Per-worker terminal status（与 delegate-batch 同构，galaxy 是第二个接入者）：
      // 快速 worker 落定即翻 ✓/✗，不等最慢兄弟；FleetRegistry 去重终态重放。
      const emitTerminal = params.onWorkerActivity
        ? (r: CoordinatorRun['results'][number]) => {
            activityMapper?.finish(terminalActivity(r, params.toolUseId, objectiveById.get(r.workOrderId)))
          }
        : undefined

      let progressReported = 0
      let run: CoordinatorRun
      try {
        run = await coordinator.delegateBatch(
          requests,
          effectivePolicy,
          params.abortSignal,
          (completed, total) => {
            if (completed > progressReported) {
              progressReported = completed
              params.onOutput?.(`⏳ galaxy progress: ${completed}/${total} workers done\n`)
            }
          },
          emitTerminal ?? undefined,
        )
      } catch (err) {
        activityMapper?.dispose()
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: `星河执行失败：${msg}`,
          isError: true,
        }
      }

      // Backstop terminal emission runs through finish so coalesced tails are
      // flushed before terminal state and late timers are sealed.
      if (emitTerminal) {
        for (const result of run.results) emitTerminal(result)
      }
      activityMapper?.dispose()

      // 路由学习沉淀（收编 #5 + S4 + L3）：结算时按维度记录路由事实（含实际
      // 执行模型、成本、失败归因与 EP/DP 对照组）。best-effort——store 故障
      // 绝不影响交付。
      if (coordinator.domainKnowledgeStore) {
        try {
          const resultsById = new Map(run.results.map(r => [r.workOrderId, r]))
          const modelByWorkOrder = new Map((run.workerModels ?? []).map(w => [w.workOrderId, w.model]))
          const routingRecords: Array<{
            dimensionName: string
            authority: string
            taskShape: string
            status: 'passed' | 'failed' | 'blocked'
            model?: string
            costTokens?: number
            failureReason?: string
            parallelism?: 'expert' | 'data'
            comparisonGroupId?: string
          }> = []
          for (const req of requests) {
            const dimIndex = dimensionIndexByParentTurnId.get(req.parentTurnId)
            const dim = dimIndex === undefined ? undefined : dimensions[dimIndex]
            const result = resultsById.get(workerOrderId(req.parentTurnId))
            if (!dim || !result) continue
            routingRecords.push({
              dimensionName: dim.name,
              authority: req.authority ?? 'unknown',
              taskShape: normalizeTaskShape(dim.name),
              // escalated 视同 blocked：结论不可采信，不记作通过
              status: result.status === 'escalated' ? 'blocked' : result.status,
              model: modelByWorkOrder.get(workerOrderId(req.parentTurnId)) ?? req.modelOverride?.model,
              // L3：token 成本入账——胜率之外的「每通过成本」维度
              costTokens: result.usage
                ? (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0)
                : undefined,
              // 失败归因：有 failureReason = 基础设施死法（超时/轮次耗尽/崩溃），
              // 与模型能力无关；语义失败（gate 拦的假验证、越界）不带此字段。
              // 不记它的话，「谁常接难活、谁常撞门禁」会被当成「谁能力差」。
              ...(result.failureReason ? { failureReason: result.failureReason } : {}),
              // EP/DP 标记 + 对照组：DP 组内同任务不同模型可配对比较，
              // EP 分片之间混任务难度不可比。缺此两项则 S4 的 A/B 沉淀无从识别。
              ...(dim.parallelism ? { parallelism: dim.parallelism } : {}),
              ...(req.groupId ? { comparisonGroupId: req.groupId } : {}),
            })
          }
          if (routingRecords.length > 0) {
            const store = coordinator.domainKnowledgeStore
            if (typeof store.recordGalaxyRoutingBatch === 'function') {
              store.recordGalaxyRoutingBatch(routingRecords)
            } else {
              // Keep compatibility with lightweight test/integration doubles.
              for (const record of routingRecords) store.recordGalaxyRouting(record)
            }
          }
        } catch {
          // best-effort
        }
      }

      // DP 证据冗余结算（收编 #2）：verified 副本各计一次独立证据（ref =
      // workOrderId，天然互异——重复提交不计数由 evidence-obligation 保证）。
      // k 个独立证据凑齐义务自动 satisfied；未凑齐保持 attempted 拦交付门禁。
      if (coordinator.obligationTracker && dpObligationByDim.size > 0) {
        try {
          const resultsById = new Map(run.results.map(r => [r.workOrderId, r]))
          for (const [dimIndex, obligationId] of dpObligationByDim) {
            const group = dataParallelGroups.get(dimIndex)
            if (!group) continue
            for (const workOrderId of group.workOrderIds) {
              const result = resultsById.get(workOrderId)
              if (result?.evidenceStatus === 'verified') {
                coordinator.obligationTracker.satisfy(obligationId, workOrderId)
              }
            }
          }
        } catch {
          // best-effort——义务结算失败不吞集群结果
        }
      }

      const targets = requests.map(request => {
        const dimensionIndex = dimensionIndexByParentTurnId.get(request.parentTurnId)
        if (dimensionIndex === undefined) return { workOrderId: workerOrderId(request.parentTurnId), label: '全局审查', requestedModel: request.modelOverride?.model }
        const dimension = dimensions[dimensionIndex]!
        const stars = dimension.authorities ?? (dimension.authority ? [dimension.authority] : [])
        const authorityIndex = stars.indexOf(request.authority ?? '')
        const star = starDomainRegistry.get(request.authority ?? '')
        const perspective = stars.length > 1 ? ' ◌ 多视角' : ''
        const replicaIndex = replicaIndexByParentTurnId.get(request.parentTurnId)
        const replica = replicaIndex === undefined ? '' : ` DP replica ${replicaIndex + 1}/${dimension.replicas}`
        return {
          workOrderId: workerOrderId(request.parentTurnId),
          label: `${dimension.name}${perspective}${replica} ${star?.name ?? request.authority ?? authorityIndex}`,
          requestedModel: request.modelOverride?.model,
        }
      })
      // 结构化结果（galaxyGate 消费侧字段）：与 formatGalaxyResult 的
      // 「聚合结论: N/M 个维度未通过」同一语义——passed/total 取全局 worker
      // 终态计数，failed 取未通过维度的 label（对齐 GALAXY_DIM_LINE_RE 提取的
      // 散文行 `<label>: <✗|⊗|↑>`，status !== 'passed' 即未通过）。
      const resultByWorkOrderId = new Map(run.results.map(r => [r.workOrderId, r]))
      const galaxyPassed = run.results.filter(r => r.status === 'passed').length
      const galaxyTotal = run.results.length
      const failedDimensions = targets
        .filter(t => resultByWorkOrderId.get(t.workOrderId)?.status !== 'passed')
        .map(t => t.label)
      return {
        content: formatGalaxyResult(run, targets, [...dataParallelGroups.values()],
          [...strippedByDim.entries()].map(([idx, files]) => ({ label: dimensions[idx]!.name, files })),
          emptiedWriteDims, downgradedReviewDims),
        // DP quorum 未达成 → isError，让主 agent 的工具管线感知到失败信号，
        // 而非只靠报告文本判断（展示层→判定层的断层修复）。
        isError: dataParallelGroups.size > 0
          && checkDpQuorum(
            [...dataParallelGroups.values()],
            new Map(run.results.map(r => [r.workOrderId, r])),
          ).length > 0 || undefined,
        uiContent: formatGalaxyUi(run, dimensions),
        orchestration: {
          kind: 'galaxy',
          runId: params.toolUseId,
          planned: plannedWorkerCount,
          dispatched: run.results.length,
          skipped: emptiedWriteDims,
          parallelism: plannedParallelism,
          dimensions: { passed: galaxyPassed, total: galaxyTotal, failed: failedDimensions },
        },
      }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    // 外层超时必须覆盖 worker pool 的波次 × profile 预算，否则工具层先杀
    timeoutMs: (params) => {
      const dims = (params?.input?.dimensions as Array<{
        name?: string
        authorities?: string[]
        authority?: string
        profile?: string
        timeoutMs?: number
        parallelism?: 'expert' | 'data'
        replicas?: number
        tierFloor?: string
      }> | undefined) ?? []
      const { profiles, tierFloors, requestedTimeoutMs } = buildGalaxyBudgetInputs(dims)
      // autoReview 依赖全部执行维度，是事实上的 +1 串行波次——它的预算必须
      // 加在执行预算之后，而不是混进 profiles 一起算：混入会让 allHands 判定
      // 失效（reviewer 非写工），写工续跑倍率被拉低，总预算反而变小，外层可能
      // 在审查跑到一半时硬杀，丢掉全部 partial 打捞。
      const autoReview = (params?.input?.autoReview as boolean | undefined) ?? true
      const hasExplicitReview = dims.some(d => d.name !== undefined && isReviewGalaxyDimension(d.name))
      const execMs = delegationToolTimeoutMs(
        params?.sessionTurnCount,
        profiles,
        { taskCount: profiles.length, requestedTimeoutMs, tierFloors },
      )
      if (!autoReview || hasExplicitReview) return execMs
      const reviewMs = delegationToolTimeoutMs(params?.sessionTurnCount, ['reviewer'], { taskCount: 1 })
      return execMs + reviewMs
    },
  }
}
