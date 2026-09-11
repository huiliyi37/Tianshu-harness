/**
 * isolation-policy — 写工的工作区隔离判定（纯函数）
 *
 * 判据：该 worker 的**写入对象是否与主控（或别的执行体）可能重叠**，
 * 而不是"谁派发的"，也不是 profile/kind。
 *
 * 为什么不能按 profile/kind 判定：team 正交分片的默认写工与审查链路的补丁工
 * 用的是同一组 profile + kind（`patcher` + `patch_proposal`——见
 * team-plan.ts:132-146 classifyTask 的默认分支，与 profile-registry.ts:263-264）。
 * 按 profile 判定会把每个正交分片都推进独立 worktree，代价是整树 checkout——
 * 那恰恰是这套共享模式当初要省掉的开销（参见 bootstrap.ts:1113-1123 的注释）。
 *
 * 所以判据落在派发方携带的**事实**上：
 *   - 审查链路（review-coordinator-deps.ts:90-92 的 scope()）声明
 *     `overlapsPrimary: true`——它的 scope.files 就是被审文件，即主控刚写完并
 *     提交的那批文件，必然与主控争用（并且此刻磁盘上可能已被并发修改，见设计稿 §4）；
 *   - 正交分片不声明——分片本就按文件切分，彼此不相交。
 *
 * 缺省保守：无 scope.files 声明的写工无法证明自己与主控不相交 → isolated。
 *
 * @module isolation-policy
 */

export type WorkspaceIsolation = 'shared' | 'isolated'

export interface IsolationDecisionInput {
  /**
   * 全局开关（DelegationCoordinatorConfig.sharedWorktree）。
   * `true` = 允许正交分片就地共享主工作树；`false` / 缺省 = 一律隔离。
   * 缺省按隔离处理——只有显式打开才享受共享模式的性能收益。
   */
  sharedWorktreeEnabled?: boolean
  /** order.scope.files —— worker 声明的写入范围。 */
  scopeFiles?: readonly string[]
  /** order.scope.overlapsPrimary —— 派发方声明"我的写入对象与主控重叠"。 */
  overlapsPrimary?: boolean
}

export interface IsolationDecision {
  isolation: WorkspaceIsolation
  /** 传给 runHandsSession 的 sharedWorkspace 值（shared ↔ true）。 */
  sharedWorkspace: boolean
  reason: string
}

/**
 * 判定一个写工是否应独占自己的 git worktree。
 * 纯函数——判定表可被单测穷举（审查/补丁 → isolated；正交分片 → shared；
 * 未知 / 缺省 → isolated）。
 */
export function decideWorkspaceIsolation(input: IsolationDecisionInput): IsolationDecision {
  if (input.sharedWorktreeEnabled !== true) {
    return {
      isolation: 'isolated',
      sharedWorkspace: false,
      reason: 'shared-worktree mode is off — every write worker gets its own worktree',
    }
  }
  if (input.overlapsPrimary === true) {
    return {
      isolation: 'isolated',
      sharedWorkspace: false,
      reason:
        'declared write overlap with the primary worktree (review/patch path — scope.files are the reviewed files)',
    }
  }
  if (!input.scopeFiles || input.scopeFiles.length === 0) {
    return {
      isolation: 'isolated',
      sharedWorkspace: false,
      reason: 'no declared write scope — cannot prove the worker is disjoint from the primary worktree',
    }
  }
  return {
    isolation: 'shared',
    sharedWorkspace: true,
    reason: 'orthogonal shard with a declared, non-overlapping scope — keep the shared worktree',
  }
}

/**
 * coordinator 侧的便利封装：由 config + order 判定该写工是否就地跑。
 * `order` 只取结构最小面（scope 的 files/overlapsPrimary），不与 work-order 形成环。
 */
export function resolveSharedWorkspace(
  config: { sharedWorktree?: boolean },
  order: { scope: { files?: string[]; overlapsPrimary?: boolean } },
): boolean {
  return decideWorkspaceIsolation({
    sharedWorktreeEnabled: config.sharedWorktree === true,
    scopeFiles: order.scope.files,
    overlapsPrimary: order.scope.overlapsPrimary,
  }).sharedWorkspace
}
