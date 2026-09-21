/**
 * issue #235 Wave 2 —— shell 侧「用户接管即让出」护栏。
 *
 * bash 执行的 GUI 输入注入（P/Invoke user32 合成键鼠 / 前台抢占）一旦开跑就持续
 * 抢夺输入，中途没有检查点——用户唯一的恢复路径是杀进程（issue 现象 1）。这里在
 * **执行前**做一次判定，语义与 computer_use 侧一致：用户刚在操作就**跳过并告知**，
 * 不排队等待（等待会让 turn 无声挂起，比跳过更难诊断）。
 *
 * 覆盖范围刻意只对 `AVAILABILITY_HAZARD_PATTERNS` 命中的命令生效（issue 权衡原话：
 * 「按精确签名匹配…避免把审批成本平摊到所有 shell 使用场景」）——未命中的命令
 * **连探测都不做**，普通 shell 零额外开销。
 */
import { AVAILABILITY_HAZARD_PATTERNS, normalizeBashCommand } from '../agent/approval-risk.js'
import {
  DEFAULT_YIELD_MS,
  isUserActive,
  probeUserIdleMs,
  resolveYieldMs,
  type UserIdleMs,
} from '../system/user-idle.js'
import type { ToolResult } from './types.js'

/** 批准豁免窗（ms）：窗口内的键鼠输入视为「批准动作本身」，不作为用户接管。 */
export const APPROVAL_GRACE_MS = 2_000

/**
 * 命令是否属于「危害用户可用性」类（输入注入 / 前台抢占）。
 *
 * **必须与审批门同视图**：审批门对同一份 pattern 表用 `testBoth`（原始 +
 * `normalizeBashCommand`）判定，此处若只看原始文本，语义相同的命令会在两道门上
 * 得到相反结论。实测（2026-09-21）：`echo 'osascript to key'stroke v` 归一化后
 * 含 `keystroke` —— 审批门判 high「GUI 输入注入」，单视图的让出护栏判 false，
 * 阈值置顶也照样执行。引号拼接、`r\m` 字符转义、`${IFS}`、反斜杠续行同属一族。
 */
export function matchesAvailabilityHazard(command: string): boolean {
  const normalized = normalizeBashCommand(command)
  return AVAILABILITY_HAZARD_PATTERNS.some(
    (re) => re.test(command) || (normalized !== command && re.test(normalized)),
  )
}

export interface YieldCheckInput {
  command: string
  /** 注入探测器（测试）。默认 probeUserIdleMs（起子进程）。 */
  probe?: () => Promise<UserIdleMs>
  /** 让出阈值；默认 resolveYieldMs()（与 computer_use 同旋钮）。 */
  thresholdMs?: number
  /** 交互式批准时刻（unix ms，由 tool-pipeline 注入）——见 APPROVAL_GRACE_MS。 */
  approvalGrantedAt?: number
}

/** 让出文案：说清发生了什么、为什么跳过、以及三条继续路径。 */
export function yieldMessage(idleMs: UserIdleMs, thresholdMs: number): string {
  const idle = idleMs === null ? '未知' : `${idleMs}ms`
  return [
    `[让出] 这条命令会合成系统级键鼠输入（或抢占前台窗口），而你在 ${idle} 前刚操作过本机`,
    `（阈值 ${thresholdMs}ms）——已跳过执行，避免抢走你的输入控制权。`,
    '',
    '要继续的话：',
    '1. 停手一两秒后重试本命令（护栏按「距上次键鼠事件」的时长判定）；',
    '2. GUI 自动化优先用 computer_use 工具——它按应用逐项授权，且在每次注入前做同样的让出检查；',
    `3. 若这是你自建的合法自动化脚本，可设 RIVET_CU_YIELD_MS=0 关闭让出护栏（与 computer_use 同一旋钮，默认 ${DEFAULT_YIELD_MS}ms）。`,
  ].join('\n')
}

/**
 * 执行前的让出判定。返回 null = 放行；返回 ToolResult = 不执行并告知。
 *
 * 四条短路（顺序即性能契约）：
 * ① 未命中签名 → 直接返回，**不探测**；
 * ② 刚被交互批准（豁免窗内）→ 放行，**不探测**——批准是显式授权，那次点击
 *    不是「用户正在用本机」。不豁免的后果是「批准 → 命令被跳过 → 让重试」
 *    的循环（探测实测自身 ~234ms，远小于 1200ms 阈值，必被判活跃）；
 * ③ 阈值为 0（护栏关闭）→ 不探测；
 * ④ 探测结果 null（无法检测）→ 放行（护栏失效不该成为新的失败点）。
 */
export async function maybeYieldForUserActivity(input: YieldCheckInput): Promise<ToolResult | null> {
  if (!matchesAvailabilityHazard(input.command)) return null
  if (input.approvalGrantedAt !== undefined && Date.now() - input.approvalGrantedAt < APPROVAL_GRACE_MS) {
    return null
  }
  const thresholdMs = input.thresholdMs ?? resolveYieldMs()
  if (thresholdMs <= 0) return null
  const probe = input.probe ?? (() => probeUserIdleMs())
  const idleMs = await probe()
  if (!isUserActive(idleMs, thresholdMs)) return null
  return { isError: true, content: yieldMessage(idleMs, thresholdMs) }
}
