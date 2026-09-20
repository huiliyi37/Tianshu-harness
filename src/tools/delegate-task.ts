import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ClaimProposal } from '../context/claims.js'
import { DEFAULT_DELEGATE_PROFILE, profileRegistry, delegationToolTimeoutMs } from '../agent/profile-registry.js'
import { mergeBudgetOverride, shapeWriteBudgetForProfile } from '../agent/budget-shape.js'
import { formatWorkerResultDigest } from '../agent/worker-result-digest.js'
import { formatWorkerIdentity } from '../tui/format/profile-labels.js'
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

export interface DelegateTaskCoordinator {
  delegate(
    request: DelegationRequest,
    abortSignal?: AbortSignal,
    onOrderCreated?: (orderId: string) => void,
  ): Promise<CoordinatorRun>
}

/** 适配器目标的最低结构要求（生产端是 DelegationCoordinator）。 */
export interface CoordinatorDelegateLike {
  delegate: DelegateTaskCoordinator['delegate']
}

/**
 * 生产接线适配器（bootstrap）：把「按需取 coordinator」的 getter 包装成工具
 * 要的 DelegateTaskCoordinator。独立导出是因为适配器丢参不会触发任何编译
 * 错误（少参函数可赋多参签名）——第二参 signal 丢过（审查 H3），第三参
 * onOrderCreated 也丢过：工具侧拿不到 dispatchedOrderId，异常路径补发终态
 * 在生产整体失效（35f459b8f 复评）。
 */
export function createCoordinatorDelegateAdapter(
  getCoordinator: () => CoordinatorDelegateLike | null | undefined,
): DelegateTaskCoordinator {
  return {
    delegate: (request, signal, onOrderCreated) => {
      const coordinator = getCoordinator()
      if (!coordinator) return Promise.reject(new Error('DelegationCoordinator not initialized'))
      return coordinator.delegate(request, signal, onOrderCreated)
    },
  }
}

/** Dynamic profile validation — accepts built-in + user-loaded profiles */
const profileStringSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `未知 profile "${val}"。可用：${profileRegistry.getProfileNames().join(', ')}` }),
)

/** Dynamic star-domain (authority) validation — accepts built-in + user-loaded domains.
 *  Injects the domain's persona (volatileBlock，经冻结 <star-domain> 前缀) into the
 *  worker, and intersects the worker's tools with the domain whitelist.
 *  （systemPromptSuffix 是展示面字段，不参与注入——见 assembly-audit 白名单注记。） */
const authorityStringSchema = z.string().refine(
  (val) => val === '' || starDomainRegistry.get(val) !== undefined,
  (val) => ({ message: `未知星域 "${val}"。可用：${starDomainRegistry.getDomainIds().join(', ')}` }),
)

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: profileStringSchema.optional(),
  authority: authorityStringSchema.optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  resume: z.string().optional().describe(
    'Optional worker ID to resume instead of creating a new worker. When provided, the worker continues from its previous session history. The objective should describe the continuation task.',
  ),
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

export function formatUiContent(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'delegate_task 已跳过：objective 未通过预算门禁'
  const passed = run.results.filter(r => r.status === 'passed').length
  const total = run.results.length
  const head = `delegate_task · ${passed}/${total} 通过 · ${run.selectedModel ?? 'unknown'}`
  const rows = run.results.map(r => {
    // 多 worker 时每行带派发侧身份——否则 N 行匿名摘要映射不回具体任务。
    // profile 由 coordinator 盖章（worker-objective-gate），缺失的旧结果保持无身份。
    const identity = r.profile ? `${formatWorkerIdentity({ profile: r.profile, authority: r.authority })} · ` : ''
    return '  ' + identity + formatWorkerResultDigest({
      status: r.status,
      summary: r.summary,
      findingsCount: r.findings?.length ?? 0,
      changedFilesCount: r.changedFiles?.length ?? 0,
      sourcesReviewedCount: r.sourcesReviewed,
      failureReason: r.failureReason,
      evidenceStatus: r.evidenceStatus,
      salvagedFindingsCount: r.findings?.filter(f => f.salvaged === true).length ?? 0,
    })
  })
  const body = rows.length > 0 ? '\n' + rows.join('\n') : ''
  if (run.escalated) return `⚠️ ${head}${body}\n[escalated] 子代理连续失败，建议改为内联执行`
  return `${head}${body}`
}

export function createDelegateTaskTool(
  coordinator: DelegateTaskCoordinator,
  getClaimStore?: () => ContextClaimStore | undefined,
  getSessionId?: () => string | undefined,
  getProblemAttackStore?: () => import('../agent/problem-attack-loop.js').ProblemAttackStore | null,
  /** B1 worker 归属回流：passed worker 的 changedFiles 写回主控 ledger +
   *  ownership（bootstrap 注入）——修复 worker 写入不在主控 owned 集、
   *  交付需 adopt 补交的机制根因（ledger 记 file_write，deliver 时
   *  autoOwnFromLedger 自动认领）。未注入 = 旧行为（不写回）。 */
  backfillOwnedFiles?: (changedFiles: string[]) => void,
): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: '把有边界的任务委派给 worker 代理执行。支持代码搜索、审查、规划、验证和打补丁。',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'worker 的具体目标。' },
          kind: { type: 'string', enum: ['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal'], description: 'worker 任务类型。默认：code_search。' },
          profile: { type: 'string', enum: profileRegistry.getProfileNames(), description: 'worker profile。默认：code_scout。' },
          authority: { type: 'string', description: '可选星域人格（如 tianquan、tianji、yuheng）。注入该专家的视角与方法论，并把工具限制在其白名单内。' },
          files: { type: 'array', items: { type: 'string' }, description: '可选，要聚焦的文件路径。' },
          symbols: { type: 'array', items: { type: 'string' }, description: '可选，要聚焦的符号。' },
          resume: { type: 'string', description: '要恢复的 worker ID。worker 从之前的会话上下文继续，而不是从零开始。使用之前 delegate_task 结果中的 workOrderId。' },
          maxTurns: { type: 'integer', description: MAX_TURNS_TOOL_DESCRIPTION },
          timeoutMs: { type: 'integer', description: TIMEOUT_MS_TOOL_DESCRIPTION },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = delegateTaskInputSchema.safeParse(params.input)
      if (!parsed.success) {
        return {
          content: `无效的 delegate_task 输入：${parsed.error.message}`,
          isError: true,
          errorKind: 'format_error',
        }
      }

      // Pre-flight: validate file paths are within project root
      if (parsed.data.files && parsed.data.files.length > 0) {
        const outOfProject: string[] = []
        for (const f of parsed.data.files) {
          const v = validatePathSafe(params.cwd, f)
          if (!v.ok) outOfProject.push(f)
        }
        if (outOfProject.length > 0) {
          return {
            content: [
              `delegate_task 已拦截：${outOfProject.length} 个文件在项目目录之外。`,
              `违规路径：${outOfProject.join(', ')}`,
              `Worker 无法访问项目根目录（${params.cwd}）之外的文件。`,
              `若需分析外部代码，请先复制进项目，或用 bash 把文件内容 cat 进来内联分析。`,
            ].join('\n'),
            isError: true,
          }
        }
      }

      // T9 P3 text stream + T4 structured per-worker updates (subagent panel).
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const taskObjective = parsed.data.objective
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity, {
            objectiveOf: () => taskObjective,
          })
        : undefined
      const onActivity = (textStreamer || activityMapper)
        ? (ev: WorkerActivityEvent) => {
            textStreamer?.(ev)
            activityMapper?.(ev)
          }
        : undefined

      let dispatchedOrderId: string | undefined
      let run: CoordinatorRun
      try {
        run = await coordinator.delegate({
          parentTurnId: params.toolUseId,
          objective: taskObjective,
          kind: parsed.data.kind ?? 'code_search',
          profile: (parsed.data.profile ?? DEFAULT_DELEGATE_PROFILE) as import('../agent/work-order.js').WorkerProfile,
          authority: parsed.data.authority,
          scope: {
            files: parsed.data.files,
            symbols: parsed.data.symbols,
          },
          reviewDepth: params.reviewDepth,
          delegationDepth: params.delegationDepth ?? 0,
          sessionTurn: params.sessionTurnCount,
          onActivity,
          // 嵌套委派透传：本 worker 再派 sub-worker 时，sub-worker 的活动
          // （coordinator 已盖 parentWorkerId）直通同一条 UI 通道。
          onNestedActivity: params.onWorkerActivity,
          resumeWorkOrderId: parsed.data.resume,
          // 预算发准（2026-08-18）：写工按 files 形状定价；模型显式 budget 逐字段全胜。
          budget: mergeBudgetOverride(
            toBudgetOverride(parsed.data),
            shapeWriteBudgetForProfile(parsed.data.files, parsed.data.profile ?? DEFAULT_DELEGATE_PROFILE),
          ),
        }, params.abortSignal, (orderId) => { dispatchedOrderId = orderId })

        // T4: finish flushes any coalesced tail before the terminal event and
        // seals the worker so a queued timer cannot resurrect it.
        for (const result of run.results) {
          activityMapper?.finish(terminalActivity(result, params.toolUseId, taskObjective, { omitProfile: true, authority: parsed.data.authority }))
        }

        // H4-D4 producer：worker 完成即打点精确 orderId——attack_case 的
        // worker: 证据验真依赖此记录（passed 才算完成；failed/blocked 的
        // worker 结果不得作为 supported 证据来源）。
        const attackStore = getProblemAttackStore?.()
        if (attackStore) {
          for (const r of run.results) {
            if (r.status === 'passed') attackStore.markWorkerCompleted(r.workOrderId)
          }
        }

        // Extract worker findings into claim store
        if (run.status === 'completed') {
          // B1 worker 归属回流：passed 的 changedFiles 写回主控 ledger +
          // ownership（autoOwnFromLedger 在交付时自动认领）。只认 passed——
          // failed/blocked 的写入不构成归属证据。
          if (backfillOwnedFiles) {
            for (const result of run.results) {
              if (result.status === 'passed' && result.changedFiles.length > 0) {
                backfillOwnedFiles(result.changedFiles)
              }
            }
          }
          const claimStore = getClaimStore?.()
          const sid = getSessionId?.()
          if (claimStore && sid) {
            const createdAt = Date.now()
            for (const result of run.results) {
              if (result.status !== 'passed') continue
              const evidencePaths = result.changedFiles.slice(0, 3)
              for (const finding of result.findings) {
                const claimText = typeof finding === 'string' ? finding : finding.claim
                const confidence = typeof finding === 'string' ? 0.7
                  : finding.confidence === 'high' ? 0.85
                  : finding.confidence === 'medium' ? 0.7
                  : 0.55
                const proposal: ClaimProposal = {
                  kind: 'worker_finding',
                  scope: 'session',
                  text: claimText,
                  confidence,
                  fitness: confidence >= 0.85 ? 5 : confidence >= 0.7 ? 3 : 2,
                  source: { actor: 'worker', sessionId: sid, turn: params.sessionTurnCount ?? 0, eventId: `${params.toolUseId}:worker` },
                  evidence: [{
                    id: `${params.toolUseId}:finding`,
                    kind: 'worker',
                    summary: typeof finding === 'string' ? finding : finding.evidence,
                    path: evidencePaths[0],
                    createdAt,
                  }],
                  createdAt,
                  tags: ['worker', result.workOrderId],
                }
                claimStore.propose(proposal)
              }
            }
          }
        }

        return {
          content: run.packet,
          uiContent: formatUiContent(run),
          isError: false,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 异常路径（abort/内部错误）补发终态——否则 FleetRegistry 里该 worker
        // 永远停在 running、时间一直走（CLI TUI 无 session-manager 兜底）。
        // dispatchedOrderId 在建单后即得：有值 = worker 已派发（running 事件
        // 可能已发），必须补终态；无值 = 建单前失败，fleet 无记录，无需补。
        // 走 mapper.finish：终态排在合并尾沿之后且幂等（35f459b8f 移植进
        // PR 的 mapper 框架）。
        if (activityMapper && dispatchedOrderId) {
          activityMapper.finish({
            workOrderId: dispatchedOrderId,
            parentToolId: params.toolUseId,
            objective: taskObjective,
            status: 'blocked',
            progressLine: `派发失败：${msg}`,
            failureReason: 'delegate_error',
            summary: `Worker dispatch failed: ${msg}`,
          })
        }
        // 用户取消不是工具失败：补完终态后 rethrow，交给管道走 [interrupted]
        // 语义（is_error=false、不计失败记账，tool-pipeline AbortError 特判）——
        // 吞掉会把 abort 记成 runtime_gate 失败，喂给 vigor/doom-loop 指纹。
        // 注意 coordinator 的 abort 抛的是 Error('Delegation aborted: …')，
        // name 不是 AbortError，而管道只认 name——rethrow 前统一捏成 AbortError。
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
          content: `delegate_task 失败：${msg}`,
          isError: true,
          errorKind: 'runtime_gate',
        }
      } finally {
        activityMapper?.dispose()
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
    // P0: outer tool timeout must dominate the worker's internal budget
    // (profile defaultTimeoutMs or ladder) so the worker's graceful
    // blocked+partial-output path always wins the race.
    timeoutMs: (params) => delegationToolTimeoutMs(
      params?.sessionTurnCount,
      [params?.input?.profile as string | undefined],
      // 预算发准：形状定价后的 timeout 也进 max——外层不得先于内层开枪。
      { requestedTimeoutMs: [
        params?.input?.timeoutMs as number | undefined,
        shapeWriteBudgetForProfile(params?.input?.files as string[] | undefined, params?.input?.profile as string | undefined)?.timeoutMs,
      ] },
    ),
  }
}
