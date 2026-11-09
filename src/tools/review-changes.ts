/**
 * review_changes — 独立审查工具（契约分离 Wave 2）
 *
 * 承接审查启动、发现查询和处理记录；与 deliver_task（提交）、run_tests（验证）
 * 互不耦合：本工具只读——不执行测试、不修改代码、不提交。审查发现落本会话
 * 持久化收件箱（review-inbox.json），审查完成后只通知原会话，不自动唤醒主控、
 * 不派 patcher、不驱动后续 run。
 *
 * 审查对象是固定快照：启动时锁定 commit/diff 基准；期间代码变化只把报告标注
 * 为「旧快照结果」，不自动重审。其他会话推进 HEAD 不会串入本会话的报告。
 *
 * @module review-changes
 */

import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import { createReviewInbox, renderReviewFindings, type ReviewFindingTask, type ReviewInbox } from '../agent/review-inbox.js'
import { routeReviewWorkflow, reviewWorkflowBudgetMs, type ReviewRouterDeps, type ReviewOutcome } from '../agent/review-router.js'
import { handleReviewFindingAction } from '../agent/review-followup-tool.js'
import { createTaskLedger, type TaskLedger } from '../agent/task-ledger.js'
import { isCrossModule } from '../agent/review-discipline.js'
import { freezeReviewSnapshot, type FrozenReviewSnapshot, type ReviewSnapshotTarget } from '../agent/review-snapshot.js'

export interface ReviewChangesContext {
  cwd: string
  sessionId: string
  taskLedger?: TaskLedger
  /** Review router deps — coordinator-backed worker spawn. Absent → advisory failure, not a hard block. */
  reviewDeps?: ReviewRouterDeps
  /** 已归属 dirty 文件（启动时快照的缺省对象）。 */
  ownedDirtyFiles?: () => string[] | Promise<string[]>
  /** 本会话最近提交 SHA（缺省对象的第二优先级）。 */
  lastCommitRef?: () => string | undefined
  /** Injectable inbox factory (tests). */
  createInbox?: typeof createReviewInbox
  /** Injectable review router (tests). */
  route?: typeof routeReviewWorkflow
}

/** 审查快照：启动时固定；报告始终携带此基准，HEAD 后移不串报告。 */
export type ReviewSnapshot = ReviewSnapshotTarget

/** 构造固定快照。优先级：显式 files/commit/range > 已归属 dirty > 本会话最近提交。
 *  无法确定对象时返回 null——调用方展示选择，不偷换成其他会话的 HEAD。 */
export async function resolveReviewSnapshot(params: ToolCallParams, ctx: ReviewChangesContext): Promise<ReviewSnapshot | { choose: true }> {
  const files = params.input.files as string[] | undefined
  const commit = params.input.commit_ref as string | undefined
  const range = params.input.range as string | undefined
  const now = Date.now()
  if (Array.isArray(files) && files.length > 0) {
    return { kind: 'dirty-diff', files, capturedAt: now }
  }
  if (typeof commit === 'string' && commit) {
    return { kind: 'commit', files: [], baseRef: `${commit}^`, headRef: commit, capturedAt: now }
  }
  if (typeof range === 'string' && range.includes('..')) {
    const [base, head] = range.split('..')
    return { kind: 'range', files: [], baseRef: base, headRef: head, capturedAt: now }
  }
  const owned = await ctx.ownedDirtyFiles?.() ?? []
  if (owned.length > 0) return { kind: 'dirty-diff', files: owned, capturedAt: now }
  const last = ctx.lastCommitRef?.()
  if (last) return { kind: 'commit', files: [], baseRef: `${last}^`, headRef: last, capturedAt: now }
  return { choose: true }
}

function describeSnapshot(s: ReviewSnapshot): string {
  if (s.kind === 'dirty-diff') return `dirty diff（${s.files.length} 个文件：${s.files.slice(0, 5).join(', ')}${s.files.length > 5 ? ' …' : ''}）`
  if (s.kind === 'commit') return `提交 ${s.headRef}`
  return `区间 ${s.baseRef}..${s.headRef}`
}

async function runReadonlyReview(snapshot: FrozenReviewSnapshot, ctx: ReviewChangesContext, params: ToolCallParams, depth: 'default' | 'max'): Promise<ReviewOutcome> {
  if (!snapshot.files.length) return { tier: 'L2', verdict: 'inconclusive', evidence: '没有可审文件；本次未执行独立审查。' }
  return (ctx.route ?? routeReviewWorkflow)({ files: snapshot.files, crossModule: isCrossModule(snapshot.files), isFix: false,
    forceLevel: depth === 'max' ? 'L3' : 'L2', reviewSnapshot: snapshot,
  }, ctx.reviewDeps!, { abortSignal: params.abortSignal, mode: 'manual', readonly: true,
    focusHint: typeof params.input.focus === 'string' ? params.input.focus : undefined })
}

export function createReviewChangesTool(getContext: (params?: ToolCallParams) => ReviewChangesContext | undefined): Tool {
  return {
    definition: {
      name: 'review_changes',
      description: `独立审查指定改动——只读：不执行测试、不修改代码、不提交。与 deliver_task（提交）、run_tests（验证）彻底分离。

### 用法
- review_changes(action="start") 审查当前已归属 dirty diff；无 dirty 则审本会话最近提交
- review_changes(action="start", files=[...]) 审查指定文件集的 dirty diff
- review_changes(action="start", commit_ref="abc1234") 审查单个提交；range="A..B" 审查区间
- depth="max"（默认 default）：default=单个只读 reviewer；max=只读审查编队
- review_changes(action="list") / (action="update", id, state, reason, evidence) 查询/处理持久化审查发现；fixed 需真实 fix_commit；验证独立记录，缺省 not_run，applied=未提交补丁不得冒充已提交修复
- 审查对象是固定快照：期间代码变化只把报告标为旧快照结果，不自动重审；其他会话推进 HEAD 不串报告
- 未发现问题时表述为「代码审查未发现问题」，不得表述成「测试已通过」

### 边界
- 审查完成后保存发现并通知原会话，不唤醒主控、不自动派修复
- 用户选择「处理发现」后作为新的正常开发任务核实、修复（可用定向验证）`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'list', 'update'], description: 'start=启动一次只读审查；list=查询持久化发现；update=登记处理记录' },
          files: { type: 'array', items: { type: 'string' }, description: '可选：审查指定文件集的 dirty diff（与 commit_ref/range 互斥，前者优先）' },
          commit_ref: { type: 'string', description: '可选：审查单个提交（SHA）' },
          range: { type: 'string', description: '可选：审查提交区间 "A..B"' },
          focus: { type: 'string', description: '可选审查重点' },
          depth: { type: 'string', enum: ['default', 'max'], description: 'default=单只读 reviewer（默认）；max=只读编队' },
          include_closed: { type: 'boolean', description: 'list 时返回完整处理历史（含 fixed/rejected）' },
          id: { type: 'string', description: 'update：发现 id' },
          state: { type: 'string', enum: ['confirmed', 'rejected', 'blocked', 'fixed', 'applied'], description: 'update：新状态。fixed 需真实后续提交；验证缺省 not_run；applied=补丁已应用未提交' },
          reason: { type: 'string', description: 'update：处理原因' },
          evidence: { type: 'string', description: 'update：独立核实证据（file:line / 命令输出）' },
          fix_commit: { type: 'string', description: 'update state=fixed：真实修复提交 SHA' },
          verification_status: { type: 'string', enum: ['not_run', 'passed', 'failed', 'stale'], description: '独立验证状态；缺省 not_run，其他状态须匹配本会话真实记录。' },
          verification_command: { type: 'string', description: '可选：真实执行的验证命令；不能用命令文本冒充已执行' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const ctx = getContext(params)
      if (!ctx) {
        return { content: '❌ review_changes：当前环境未接入审查依赖（无 coordinator）。TUI 下用 /review；桌面端用审查按钮。', isError: true, errorKind: 'runtime_gate' }
      }
      const action = params.input.action
      const inbox: ReviewInbox = (ctx.createInbox ?? createReviewInbox)(ctx.cwd, ctx.sessionId)

      // ── list / update：持久化发现处理 ──
      if (action === 'list' || action === 'update') return handleReviewFindingAction(params, inbox, ctx.taskLedger ?? createTaskLedger({ taskId: ctx.sessionId }))

      // ── start：固定快照 + 只读审查 ──
      if (action !== 'start') {
        return { content: `❌ 未知 action "${String(action)}"——用 start / list / update。`, isError: true, errorKind: 'format_error' }
      }
      if (!ctx.reviewDeps) {
        return { content: '❌ review_changes：审查 worker 依赖不可用（无 DelegationCoordinator）。TUI 下用 /review。', isError: true, errorKind: 'runtime_gate' }
      }
      const snapshotOrChoice = await resolveReviewSnapshot(params, ctx)
      if ('choose' in snapshotOrChoice) {
        return { content: '没有可审查的确定对象：当前无已归属 dirty 文件，也无本会话提交记录。\n请用 /review files=[...]、/review commit_ref=<sha> 或 /review range=A..B 指定对象，或句首说“请审查 X”；审查无需先提交。\n（不会偷换成其他会话的 HEAD。）' }
      }
      const snapshot = snapshotOrChoice
      const depth = params.input.depth === 'max' ? 'max' : 'default'
      const lines: string[] = [
        `🔍 独立审查启动（${depth === 'max' ? '只读编队' : '单个只读 reviewer'}）`,
        `审查对象（固定快照）：${describeSnapshot(snapshot)}`,
        '本次审查只读：不执行测试、不修改代码、不提交；完成后保存发现并通知，不唤醒主控。',
      ]
      const budgetMs = reviewWorkflowBudgetMs('manual', depth === 'max' ? 'L3' : 'L2')
      let outcome: ReviewOutcome
      let timer: NodeJS.Timeout | undefined
      let frozen: FrozenReviewSnapshot | undefined
      let stale = false
      const controller = new AbortController()
      const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, controller.signal]) : controller.signal
      const workspaceFingerprint = params.currentVerificationFingerprint?.() ?? undefined
      try {
        frozen = await freezeReviewSnapshot(ctx.cwd, snapshot, signal)
        outcome = await Promise.race([
          runReadonlyReview(frozen, ctx, { ...params, abortSignal: signal }, depth),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('review timed out')) }, budgetMs) }),
        ])
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        outcome = { tier: depth === 'max' ? 'L3' : 'L2', verdict: 'inconclusive', rounds: 0,
          evidence: `审查未完成（${reason}）；未核销任何结论。`, infraFailures: [{ kind: params.abortSignal?.aborted ? 'skip' : controller.signal.aborted ? 'timeout' : 'worker', claim: reason }] }
      } finally {
        if (timer) clearTimeout(timer)
        if (frozen) { stale = !frozen.isCurrent(); frozen.destroy() }
      }

      // 发现落持久化收件箱（不驱动任何后续执行）
      let tasks: ReviewFindingTask[] = []
      let inboxFailure: string | undefined
      const commitRef = frozen?.headRef ?? snapshot.headRef ?? 'uncaptured-diff'
      try {
        tasks = inbox.record(`review-changes-${snapshot.capturedAt}`, commitRef, frozen?.files ?? snapshot.files, outcome, { workspaceFingerprint, stale })
      } catch (error) {
        inboxFailure = `发现持久化失败（${String(error)}）——报告如下，但未进入收件箱。`
      }

      if (stale) lines.push('⚠️ 审查期间工作区已变化：这是旧快照结果，未自动重审。')
      const verdictLine = outcome.verdict === 'verified' ? '代码审查未发现问题。' : outcome.verdict === 'nudge' ? '审查结论：变更琐碎，免深审（nudge）。' : outcome.verdict === 'rejected' ? '审查发现问题（详见下方发现清单）。' : '审查未得出结论（inconclusive）。'
      lines.push('', `审查结论：${verdictLine}`)
      if (outcome.verdict === 'verified') lines.push('（「未发现问题」≠「测试已通过」——验证是 run_tests 的职责，本工具不执行测试。）')
      if (outcome.evidence) lines.push(...String(outcome.evidence).split('\n').slice(0, 10).map(l => `  ${l}`))
      if (inboxFailure) lines.push('', `⚠️ ${inboxFailure}`)
      if (tasks.length > 0) {
        lines.push('', renderReviewFindings(tasks))
        lines.push('', '发现已保存到本会话持久化收件箱；处理它们是用户发起的新任务（review_changes action=update 登记）。')
      }
      lines.push('', `审查回执：review:review-changes-${snapshot.capturedAt}`, `快照基准：${describeSnapshot(snapshot)}（captured ${new Date(snapshot.capturedAt).toISOString()}）。审查期间代码变化不自动重审——重审需再次 start。`)
      return { content: lines.join('\n') }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: () => reviewWorkflowBudgetMs('manual', 'L3') + 30_000,
  }
}
