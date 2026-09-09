import { z } from 'zod'
import { deriveWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../agent/coordinator.js'
import { aggregationPolicyKinds, aggregationPolicySchema, workOrderKindSchema, type AggregationPolicy } from '../agent/work-order.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import { DEFAULT_DELEGATE_PROFILE, profileRegistry, delegationToolTimeoutMs } from '../agent/profile-registry.js'
import { mergeBudgetOverride, shapeWriteBudgetForProfile } from '../agent/budget-shape.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { validatePathSafe } from './path-validate.js'
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

export interface DelegateBatchCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
    onWorkerSettled?: (result: CoordinatorRun['results'][number]) => void,
  ): Promise<CoordinatorRun>
}

/** 适配器目标的最低结构要求（生产端是 DelegationCoordinator）。 */
export interface CoordinatorBatchDelegateLike {
  delegateBatch: DelegateBatchCoordinator['delegateBatch']
}

/**
 * 生产接线适配器（bootstrap）：同 createCoordinatorDelegateAdapter 的动机——
 * 内联适配器丢参编译期零报警。delegate_batch 曾丢第五参 onWorkerSettled：
 * 工具侧 settledIds 恒空，「已 settle 不补发」的防翻转守卫在生产整体失效。
 */
export function createCoordinatorBatchDelegateAdapter(
  getCoordinator: () => CoordinatorBatchDelegateLike | null | undefined,
): DelegateBatchCoordinator {
  return {
    delegateBatch: (requests, policy, abortSignal, onProgress, onWorkerSettled) => {
      const coordinator = getCoordinator()
      if (!coordinator) return Promise.reject(new Error('DelegationCoordinator not initialized'))
      return coordinator.delegateBatch(requests, policy, abortSignal, onProgress, onWorkerSettled)
    },
  }
}

/** Dynamic profile validation — accepts built-in + user-loaded profiles */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `未知 profile "${val}"。可用：${profileRegistry.getProfileNames().join(', ')}` }),
)

/** Dynamic star-domain (authority) validation — see delegate-task.ts. */
const authorityStringSchema = z.string().refine(
  (val) => starDomainRegistry.getDomainIds().includes(val),
  (val) => ({ message: `未知星域 "${val}"。可用：${starDomainRegistry.getDomainIds().join(', ')}` }),
)

/** 条件依赖边（星河收编 #6 入口）：index 引用批内任务，失败时按 onFailure
 *  分支——skip 跳过本任务、alternate 改等 alternateOrderId（同为批内索引）。 */
const dependsOnEdgeSchema = z.object({
  index: z.number().int().nonnegative(),
  onFailure: z.enum(['skip', 'alternate']).optional(),
  alternateOrderId: z.number().int().nonnegative().optional(),
})

const taskSchema = z.object({
  objective: z.string().min(1),
  kind: workOrderKindSchema.optional(),
  profile: profileStringSchema.optional(),
  authority: authorityStringSchema.optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  /** Indices (into this batch's tasks array) this task depends on — the
   *  referenced tasks run first. Enforced by WorkOrderQueue via stable
   *  `batch:N` ids. 支持条件边对象（收编 #6）：{ index, onFailure,
   *  alternateOrderId }。 */
  dependsOn: z.array(z.union([z.number().int().nonnegative(), dependsOnEdgeSchema])).optional(),
  /** Worker ID to resume. The worker continues from its previous session
   *  context instead of starting fresh. Use the workOrderId from a previous
   *  delegate_task/delegate_batch result. */
  resume: z.string().optional(),
  maxTurns: delegateMaxTurnsSchema,
  timeoutMs: delegateTimeoutMsSchema,
}).superRefine((data, ctx) => {
  // P1-8 写工 scope 强制：写工（patch_proposal）必须显式声明 files——worker
  // 只能在声明范围内改动（coordinator 的 in-flight 冲突登记 + objective-gate
  // 越界闸门都以 scope.files 为界），空 scope 直接放行会绕过这两道防线。
  if (data.kind === 'patch_proposal' && (!data.files || data.files.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: 'patch_proposal（写工）任务必须声明 files——worker 只能在声明范围内改动，空 scope 无法通过越界闸门。',
    })
  }
})

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(5),
  policy: aggregationPolicySchema.optional(),
})

function extractClaimsFromRun(run: CoordinatorRun, toolUseId: string, claimStore: ContextClaimStore, sessionId: string): void {
  const createdAt = Date.now()
  for (const result of run.results) {
    if (result.status !== 'passed') continue
    const evidencePaths = result.changedFiles.slice(0, 3)
    result.findings.forEach((finding, findingIndex) => {
      const claimText = typeof finding === 'string' ? finding : finding.claim
      const evidenceText = typeof finding === 'string' ? finding : finding.evidence
      const confidence = typeof finding === 'string' ? 0.7
        : finding.confidence === 'high' ? 0.85
        : finding.confidence === 'medium' ? 0.7
        : 0.55
      // 一手实测带 file:line 的发现天然比转述推断可信度高一个台阶
      const isFirsthand = typeof finding !== 'string' && finding.evidenceKind === 'firsthand'
      const fitness = isFirsthand ? 5
        : confidence >= 0.85 ? 5 : confidence >= 0.7 ? 3 : 2
      const eventId = `${toolUseId}:worker:${result.workOrderId}:${findingIndex}`
      const evidenceKind = typeof finding !== 'string' ? finding.evidenceKind : undefined
      const prefix = evidenceKind === 'firsthand' ? '[一手] ' : evidenceKind === 'inferred' ? '[转述] ' : ''
      const refs = typeof finding !== 'string' && finding.evidenceRefs?.length
        ? ` (${finding.evidenceRefs.join(', ')})`
        : ''
      const proposal: ClaimProposal = {
        kind: 'worker_finding',
        scope: 'session',
        text: `${prefix}${claimText}${refs}`,
        confidence,
        fitness,
        source: { actor: 'worker', sessionId, turn: 0, eventId },
        evidence: [{
          id: `${eventId}:finding`,
          kind: 'worker',
          summary: typeof finding === 'string' ? finding : finding.evidence,
          path: evidencePaths[0],
          createdAt,
        }],
        createdAt,
        tags: ['worker', result.workOrderId],
      }
      claimStore.propose(proposal)
    })
  }
}

/** Progressive timeout: batches start fast and grow with session maturity.
 *  Now unified with delegate-task via timeout-ladder.ts (60→120→180, Δ60s).
 *    turn 0-1 (cold open)  → 60 s
 *    turn 2-4 (warming)    → 120 s
 *    turn 5+  (mature)     → 180 s
 */

/** Progressive task cap: don't fan out 5 workers on a cold session.
 *    turn 0-1 (cold open)  → 1 task  — single focused scout
 *    turn 2-4 (warming)    → 3 tasks — moderate parallelism
 *    turn 5+  (mature)     → 5 tasks — full batch
 */
export function progressiveTaskCap(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10
  if (turn <= 1) return 1
  if (turn <= 4) return 3
  return 5
}

export function createDelegateBatchTool(
  coordinator: DelegateBatchCoordinator,
  getClaimStore?: () => ContextClaimStore | undefined,
  getSessionId?: () => string | undefined,
  getProblemAttackStore?: () => import('../agent/problem-attack-loop.js').ProblemAttackStore | null,
): Tool {
  return {
    definition: {
      name: 'delegate_batch',
      description: '并行运行多个 worker 任务。每批最多 5 个任务。',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                kind: { type: 'string', enum: [...workOrderKindSchema.options] },
                profile: { type: 'string', enum: profileRegistry.getProfileNames() },
                authority: { type: 'string', description: '可选星域人格（如 tianquan、tianji、yuheng）。' },
                files: { type: 'array', items: { type: 'string' } },
                symbols: { type: 'array', items: { type: 'string' } },
                dependsOn: {
                  type: 'array',
                  description: '本批次中必须先完成的任务下标（被引用的任务会先运行）。例如测试任务依赖它所覆盖的源码任务。支持条件边对象：{ index, onFailure: skip|alternate, alternateOrderId }（收编 #6）。',
                  items: {
                    anyOf: [
                      { type: 'integer', minimum: 0 },
                      {
                        type: 'object',
                        properties: {
                          index: { type: 'integer', minimum: 0 },
                          onFailure: { type: 'string', enum: ['skip', 'alternate'] },
                          alternateOrderId: { type: 'integer', minimum: 0 },
                        },
                        required: ['index'],
                      },
                    ],
                  },
                },
                resume: { type: 'string', description: '要恢复的 worker ID。worker 从之前的会话上下文继续，而不是从零开始。' },
                maxTurns: { type: 'integer', description: MAX_TURNS_TOOL_DESCRIPTION },
                timeoutMs: { type: 'integer', description: TIMEOUT_MS_TOOL_DESCRIPTION },
              },
              required: ['objective'],
            },
            description: '要并行运行的任务数组（最多 5 个）。',
          },
          policy: { type: 'string', enum: [...aggregationPolicyKinds], description: '聚合策略。默认：primary_decides。' },
        },
        required: ['tasks'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `无效输入：${parsed.error.message}`, isError: true, errorKind: 'format_error' }

      // Pre-flight: validate file paths are within project root for all tasks
      const outOfProject: { taskIdx: number; paths: string[] }[] = []
      for (let i = 0; i < parsed.data.tasks.length; i++) {
        const t = parsed.data.tasks[i]!
        if (t.files && t.files.length > 0) {
          const bad = t.files.filter(f => !validatePathSafe(params.cwd, f).ok)
          if (bad.length > 0) outOfProject.push({ taskIdx: i, paths: bad })
        }
      }
      if (outOfProject.length > 0) {
        const details = outOfProject
          .map(o => `  task[${o.taskIdx}]: ${o.paths.join(', ')}`)
          .join('\n')
        return {
          content: [
            `delegate_batch 已拦截：${outOfProject.length} 个任务引用了项目目录外的文件。`,
            details,
            `Worker 无法访问项目根目录（${params.cwd}）之外的文件。`,
            `若需分析外部代码，请先复制进项目，或用 bash 把文件内容 cat 进来内联分析。`,
          ].join('\n'),
          isError: true,
        }
      }

      // Validate dependsOn indices: must point at another task in this batch.
      // Out-of-range / self-reference is a malformed plan — fail loud rather than
      // silently dropping the dependency (which would let a dependent run early).
      // 条件边对象（收编 #6）同校验：index 与 alternateOrderId 都必须是批内
      // 其他任务的索引。
      const taskCount = parsed.data.tasks.length
      const badDeps: string[] = []
      for (let i = 0; i < taskCount; i++) {
        const deps = parsed.data.tasks[i]!.dependsOn
        if (!deps?.length) continue
        for (const d of deps) {
          const depIndex = typeof d === 'number' ? d : d.index
          const edgeLabel = typeof d === 'number'
            ? `${depIndex}`
            : `edge{index:${d.index}, onFailure:${d.onFailure ?? 'undefined'}${d.alternateOrderId !== undefined ? `, alternate:${d.alternateOrderId}` : ''}}`
          if (depIndex === i) badDeps.push(`task[${i}] 依赖了自身（${edgeLabel}）`)
          else if (depIndex >= taskCount) badDeps.push(`task[${i}] 依赖了越界索引 ${depIndex}（${edgeLabel}；本批共 ${taskCount} 个任务）`)
          if (typeof d !== 'number' && d.onFailure === 'alternate' && d.alternateOrderId !== undefined) {
            if (d.alternateOrderId === i) badDeps.push(`task[${i}] 的 alternate 指向自身（${edgeLabel}）`)
            else if (d.alternateOrderId >= taskCount) badDeps.push(`task[${i}] 的 alternateOrderId 越界 ${d.alternateOrderId}（本批共 ${taskCount} 个任务）`)
          }
        }
      }
      if (badDeps.length > 0) {
        return {
          content: [
            `delegate_batch 已拦截：dependsOn 引用无效。`,
            ...badDeps.map(b => `  ${b}`),
            `dependsOn 条目必须是同一批中其他任务的 0-based 索引。`,
          ].join('\n'),
          isError: true,
        }
      }

      // T9 P3: one shared streamer — events from all workers interleave with labels.
      // T4: also fan out structured per-worker updates for the subagent panel.
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      // Build authority lookup: workOrderId prefix → authority, for terminal callbacks.
      const taskAuthorityMap = new Map<number, string | undefined>()
      // 与 coordinator 建单同口径的最终 order id（嵌套批带工具调用前缀命名空间，
      // 顶层批仍是稳定 'batch:N'）——objectiveById/dependencies 必须按最终 id 索引。
      const finalIdOf = (i: number): string =>
        deriveWorkOrderId(`${params.toolUseId}:batch:${i}`, params.delegationDepth) ?? `batch:${i}`
      // Stable work-order id → objective for activity mapper + terminal callbacks.
      const objectiveById = new Map<string, string>()
      for (let i = 0; i < parsed.data.tasks.length; i++) {
        objectiveById.set(finalIdOf(i), parsed.data.tasks[i]!.objective)
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
      const requests: DelegationRequest[] = parsed.data.tasks.map((t, i) => {
        taskAuthorityMap.set(i, t.authority)
        // `batch:${i}` 经 deriveWorkOrderId 派生最终 id（嵌套批带命名空间）；
        // dependsOn 索引解析为同一批内的最终 id，队列据此排序。
        // 条件边对象（收编 #6）映射为 DependencyEdge（index → 最终 id）。
        const dependencies = t.dependsOn?.length
          ? t.dependsOn.map(d => typeof d === 'number'
              ? finalIdOf(d)
              : {
                  dependsOn: finalIdOf(d.index),
                  ...(d.onFailure ? { onFailure: d.onFailure } : {}),
                  ...(d.alternateOrderId !== undefined ? { alternateOrderId: finalIdOf(d.alternateOrderId) } : {}),
                })
          : undefined
        return {
        parentTurnId: `${params.toolUseId}:batch:${i}`,
        objective: t.objective,
        kind: t.kind ?? 'code_search',
        profile: (t.profile ?? DEFAULT_DELEGATE_PROFILE) as import('../agent/work-order.js').WorkerProfile,
        authority: t.authority,
        scope: { files: t.files, symbols: t.symbols },
        dependencies,
        reviewDepth: params.reviewDepth,
        delegationDepth: params.delegationDepth ?? 0,
        sessionTurn: params.sessionTurnCount,
        onActivity: streamActivity,
        // 嵌套委派透传：sub-worker 活动（coordinator 已盖 parentWorkerId）直通 UI 通道。
        onNestedActivity: params.onWorkerActivity,
        resumeWorkOrderId: t.resume,
        // 预算发准（2026-08-18）：写工按 files 形状定价；显式 budget 逐字段全胜。
        budget: mergeBudgetOverride(
          toBudgetOverride(t),
          shapeWriteBudgetForProfile(t.files, t.profile),
        ),
        }
      })

      // Progressive task cap: trim to the allowed slice on early turns.
      // BUT when the batch declares dependencies, trimming could drop an upstream
      // task and leave its dependents permanently blocked — so a dependency-aware
      // batch bypasses the cap (the queue already serializes it into waves).
      const hasDeps = requests.some(r => r.dependencies?.length)
      const cap = hasDeps ? requests.length : progressiveTaskCap(params.sessionTurnCount)
      let trimmedNote = ''
      let dispatched = requests
      if (requests.length > cap) {
        const dropped = requests.slice(cap).map(r => r.objective)
        dispatched = requests.slice(0, cap)
        trimmedNote = `\n\n[批次已裁剪] 会话尚早（第 ${params.sessionTurnCount ?? '?'} 轮）。已派发 ${cap}/${requests.length} 个任务。延期：${dropped.map(o => `"${o.slice(0, 60)}"`).join(', ')}。如需可在后续轮次再派发延期任务。`
      }

      // T4: per-worker terminal status for the subagent panel. Emitted TWICE by
      // design: once per worker the moment it settles (onWorkerSettled — a fast
      // worker must flip to ✓/✗ immediately instead of waiting for the slowest
      // sibling), and once more below after the batch resolves as a backstop.
      // The mapper's finish() makes the duplicate terminal emission idempotent.
      const emitTerminal = params.onWorkerActivity
        ? (r: CoordinatorRun['results'][number]) => {
            // 已 settle 的 order 记账：异常补发（catch）必须跳过它们，
            // 否则 passed→blocked 翻转（审查门 35f459b8f LOW-1）。
            settledIds.add(r.workOrderId)
            activityMapper?.finish(terminalActivity(r, params.toolUseId, objectiveById.get(r.workOrderId)))
          }
        : undefined

      let progressReported = 0
      const settledIds = new Set<string>()
      let run: CoordinatorRun
      try {
        run = await coordinator.delegateBatch(
          dispatched,
          parsed.data.policy ?? 'primary_decides',
          params.abortSignal,
          (completed, total) => {
            if (completed > progressReported) {
              progressReported = completed
              params.onOutput?.(`⏳ batch progress: ${completed}/${total} workers done\n`)
            }
          },
          emitTerminal ?? undefined,
        )
      } catch (err) {
        activityMapper?.dispose()
        const msg = err instanceof Error ? err.message : String(err)
        // 异常路径也必须为每个已派发 worker 补发终态（blocked）——否则
        // FleetRegistry 里这些 worker 永远停在 running、时间一直走（CLI TUI
        // 无 session-manager 的 sweepStaleDelegationNodes 兜底，2026-08 调研）。
        // workOrderId 用与建单同口径的 finalIdOf 派生，终态可被 fleet 正确归并冻结。
        if (params.onWorkerActivity) {
          for (let i = 0; i < dispatched.length; i++) {
            const orderId = finalIdOf(i)
            // 已 settle（passed 等终态已发）的 worker 不再补发——防翻转。
            if (settledIds.has(orderId)) continue
            params.onWorkerActivity({
              workOrderId: orderId,
              parentToolId: params.toolUseId,
              objective: objectiveById.get(orderId),
              profile: dispatched[i]?.profile,
              authority: dispatched[i]?.authority,
              status: 'blocked',
              progressLine: `派发失败：${msg}`,
              failureReason: 'delegate_batch_error',
              summary: `Worker dispatch failed: ${msg}`,
            })
          }
        }
        // 用户取消不是批次失败：补完终态后 rethrow（统一捏成 AbortError 形态，
        // 管道的 [interrupted] 特判只认 name）——吞掉会把 Esc 记成持续性失败，
        // 还附「不要重试」的误导文案。与 delegate-task 同款修复。
        const isAbort = params.abortSignal?.aborted === true
          || (err instanceof Error && err.name === 'AbortError')
          || msg.includes('Delegation aborted')
        if (isAbort) {
          if (err instanceof Error && err.name === 'AbortError') throw err
          const abortErr = new Error(msg)
          abortErr.name = 'AbortError'
          throw abortErr
        }
        return {
          content: [
            `delegate_batch 失败：${msg}`,
            '',
            '⚠️ 不要用相同参数重试本批次——该失败是持续性的。',
            '',
            '恢复选项（任选其一）：',
            '1. 改用内联工具探索：read_file、grep、glob、repo_graph',
            '2. 用 delegate_task（单个）做单一聚焦任务，超时约 30s',
            '3. 把批次缩到 1–2 个任务，目标更简单、更具体',
            '4. 若为超时：子代理超出时间预算——请简化 objective 文本',
          ].join('\n'),
          isError: true,
        }
      }

      try {
        // H4-D4 producer：worker 完成即打点精确 orderId（passed 才算完成，
        // failed/blocked 不得作为 attack_case supported 证据来源）。
        const attackStore = getProblemAttackStore?.()
        if (attackStore) {
          for (const r of run.results) {
            if (r.status === 'passed') attackStore.markWorkerCompleted(r.workOrderId)
          }
        }

        // Extract worker findings into claim store
        if (run.status === 'completed') {
          const claimStore = getClaimStore?.()
          const sid = getSessionId?.()
          if (claimStore && sid) {
            extractClaimsFromRun(run, params.toolUseId, claimStore, sid)
          }
        }

        // T4: terminal per-worker status for the subagent panel (backstop loop —
        // per-worker settle events were already emitted via onWorkerSettled).
        if (emitTerminal) {
          for (const r of run.results) emitTerminal(r)
        }

        const passed = run.results.filter(r => r.status === 'passed').length
        return {
          content: run.packet + trimmedNote,
          uiContent: `delegate_batch：${passed}/${run.results.length} 通过`,
          isError: false,
        }
      } finally {
        activityMapper?.dispose()
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    // P0: outer tool timeout dominates max(profile budgets) of all batch tasks
    // AND scales by the number of sequential waves the worker pool must run, so a
    // full 5-task batch is not killed by a single-wave budget before its later
    // wave can finish (and salvage partial output) — see delegationToolTimeoutMs.
    timeoutMs: (params) => {
      const tasks = (params?.input?.tasks as Array<{ profile?: string; timeoutMs?: number; files?: string[] }> | undefined) ?? []
      return delegationToolTimeoutMs(
        params?.sessionTurnCount,
        tasks.map(t => t.profile),
        // 预算发准：形状定价后的 timeout 也进 max——外层不得先于内层开枪。
        { taskCount: tasks.length, requestedTimeoutMs: tasks.map(t => t.timeoutMs ?? shapeWriteBudgetForProfile(t.files, t.profile)?.timeoutMs) },
      )
    },
  }
}
