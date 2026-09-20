/**
 * completed-aborted — abort 收尾产物校验（2026-09-05 team-76dc14a1 事故修复 B）。
 *
 * 事故：plan_task 600s 硬超时级联 abort 斩杀 worker-team-T4，其日文产物
 * （README.ja.md）已完整落盘，work order 却被误标 failed。
 *
 * 语义：abort（caller_aborted = 父信号取消 / timeout = 预算墙钟）收尾时，若该
 * order 的 scope 声明产物已按预期写盘，标 passed + deliveredOnAbort——产物是
 * 盘上事实，不是没交付。「真正失败」（无产物落盘）维持 blocked/failed 不变。
 * 与修复 A（plan_task 超时脱离等待、不再斩杀）联动后，本路径的触发面只剩真
 * abort（用户 Esc / 会话终止 / worker 自身预算超时）。
 *
 * 独立成模块而非塞进 work-order.ts：本函数带 fs 副作用，work-order 是契约/
 * schema 层（source-budget 纪律——沿接缝拆分而不是继续膨胀）。
 */

import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkOrder, WorkerResult } from './work-order.js'

/** mtime 新鲜度容差：文件系统时间粒度 / 时钟偏差补偿。 */
export const ABORT_DELIVERY_MTIME_TOLERANCE_MS = 30_000

/**
 * abort 收尾产物校验：result 是 abort 语义（caller_aborted/timeout）的
 * blocked/failed 且 order.scope.files 全部「存在且非空」、其中至少一个在
 * 本次运行期间（sinceMs 起，含容差）被写入 → 升级为 passed（completed-aborted）。
 * 其余情形原样返回。幂等：不满足条件绝不改写。
 *
 * 判据说明：
 * - 「全部存在且非空」——scope 声明的产物一件不缺（建了一半不算交付）；
 * - 「至少一个新写入」——防止 scope 里本就存在旧文件的 order（如改既有
 *   README 的导航链接）在 worker 一行没写就被 abort 时误标 passed；
 * - failureReason 保留 caller_aborted/timeout——下游据此区分「被 abort
 *   杀掉的已交付」与「真正干净的通过」，消费方不得按完成态盲目采信证据
 *   （evidenceStatus 钉死 unverified）。
 *
 * 适用前提：生产装配恒为共享工作树（bootstrap `sharedWorktree: true`），写工
 * 直接落主仓 cwd。隔离 worktree 模式下产物随 worktree 清理销毁，本校验查不到
 * 就不升级——保守回退原判定，绝不误标。
 */
export function upgradeAbortedDelivery(
  order: WorkOrder,
  cwd: string,
  sinceMs: number,
  result: WorkerResult,
): WorkerResult {
  if (result.status !== 'blocked' && result.status !== 'failed') return result
  if (result.failureReason !== 'caller_aborted' && result.failureReason !== 'timeout') return result
  if (result.deliveredOnAbort === true) return result
  const scopeFiles = order.scope.files ?? []
  if (scopeFiles.length === 0) return result

  const delivered: string[] = []
  let freshWrites = 0
  for (const file of scopeFiles) {
    try {
      const stat = statSync(resolve(cwd, file))
      if (!stat.isFile() || stat.size === 0) return result
      delivered.push(file)
      if (stat.mtimeMs >= sinceMs - ABORT_DELIVERY_MTIME_TOLERANCE_MS) freshWrites++
    } catch {
      return result // 缺失/不可读 = 产物未齐，维持原判定
    }
  }
  if (freshWrites === 0) return result

  const sourceLabel = result.failureReason === 'caller_aborted' ? '父信号取消' : '预算墙钟超时'
  return {
    ...result,
    status: 'passed',
    evidenceStatus: 'unverified',
    deliveredOnAbort: true,
    changedFiles: [...new Set([...result.changedFiles, ...delivered])],
    summary:
      `completed-aborted: worker 被 abort（${sourceLabel}）时其 scope 声明产物已全部写盘` +
      `（${delivered.length} 个文件存在且非空，${freshWrites} 个在本次运行期间写入），按已交付计入；` +
      `验证未执行，证据降级 unverified。原状态 ${result.status}。原摘要：${result.summary.slice(0, 200)}`,
    risks: [
      ...result.risks,
      `completed-aborted: abort (${result.failureReason}) 发生在产物落盘之后——交付按 fs 事实计入，未经测试/验证，主控验收前应以 git diff 实查`,
    ],
  }
}
