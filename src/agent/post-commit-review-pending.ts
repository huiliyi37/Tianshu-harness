/**
 * post-commit-review-pending — 会话级"待审查变更范围"累积存储
 *
 * 两种来源把 commit 范围攒进这里，而不是立刻起一轮审查 worker：
 * 1. 在飞审查单例化（P1）：上一轮自动审查还在跑时到达的新 commit ——
 *    与其并行起第二个 worker 审查高度重叠的 diff，不如并入 pending，
 *    由在飞审查完成后的补审 / 下一次审查统一覆盖。
 * 2. review_policy='defer'（P2）：长任务声明"过程不审、收尾终审"，
 *    每个 commit 累积进来，'final'（或 goal-achieved L3）一次消费。
 *
 * 冷却窗口（30s）内被跳过的 commit 也记录进来——下一轮换审自动带上，
 * 不再出现"冷却跳过 = 该变更永远没被审"的静默缺口。
 *
 * 按 sessionId key：sidecar 单进程多会话共存，不能沿用冷却那种全局单例。
 * 进程内状态（与 POST_COMMIT_REVIEW_COOLDOWN_MS 同作用域），不做跨进程去重。
 *
 * @module post-commit-review-pending
 */

export interface PendingReviewScope {
  /** 累积待审文件（并集去重） */
  files: Set<string>
  /** 累积的 commit 数（用于文案与诊断） */
  commits: number
  /** 任一累积 commit 触发了 typecheck/declared-check 失败 → final 升 L3 */
  escalate: boolean
}

const pendingBySession = new Map<string, PendingReviewScope>()

/** deliver_task ctx.sessionId 可能缺省（测试/直连路径）——共用兜底 key。 */
const FALLBACK_SESSION_KEY = '(no-session)'

function keyOf(sessionId: string | undefined): string {
  return sessionId && sessionId.length > 0 ? sessionId : FALLBACK_SESSION_KEY
}

/** 把一批文件并入会话的待审范围，返回累积后的快照（调用方用于文案）。 */
export function addPendingReviewFiles(
  sessionId: string | undefined,
  files: readonly string[],
  opts?: { escalate?: boolean },
): PendingReviewScope {
  const key = keyOf(sessionId)
  let scope = pendingBySession.get(key)
  if (!scope) {
    scope = { files: new Set(), commits: 0, escalate: false }
    pendingBySession.set(key, scope)
  }
  for (const file of files) scope.files.add(file)
  scope.commits++
  if (opts?.escalate) scope.escalate = true
  return { files: new Set(scope.files), commits: scope.commits, escalate: scope.escalate }
}

/** 查看但不消费（无累积时返回 null）。 */
export function peekPendingReview(sessionId: string | undefined): PendingReviewScope | null {
  const scope = pendingBySession.get(keyOf(sessionId))
  if (!scope || scope.commits === 0) return null
  return { files: new Set(scope.files), commits: scope.commits, escalate: scope.escalate }
}

/** 消费（返回并清空）会话的待审范围；无累积时返回 null。 */
export function consumePendingReview(sessionId: string | undefined): PendingReviewScope | null {
  const scope = peekPendingReview(sessionId)
  pendingBySession.delete(keyOf(sessionId))
  return scope
}

/** Test-only: clear all sessions so state does not leak across cases. */
export function __resetPostCommitReviewPending(): void {
  pendingBySession.clear()
}

/**
 * defer 模式下给**终端用户**的提示（不是给 agent 的日志）：说清为什么延迟、
 * 想立刻看怎么办、不操作会怎样。此前这行文案暴露 review_policy:'final' 这类
 * agent 内部参数名，用户敲不出来；且止于「已延迟」三字，无从判断该做什么。
 *
 * 放在本模块而非渲染方 deliver-task：语义同域（它描述的就是 pending 累积），
 * 且 deliver-task 是点名行数棘轮的巨石，不宜再涨。
 */
export function formatDeferredReviewNotice(commits: number, files: number): string[] {
  return [
    `⏭ 本次提交的审查已并入批量终审：已累积 ${commits} 个提交、${files} 个文件（长任务省 token 的策略）。`,
    '   现在就想看审查意见 → 敲 /review（单验证员）或 /review max（五人编队）',
    '   不操作也可以 → 收尾时会自动合并成一次终审，无需额外动作',
  ]
}
