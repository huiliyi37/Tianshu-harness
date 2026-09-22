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

// ── 执行期让出（issue #235 期望行为 1 的另一半）──────────────────────
//
// 上面的判定发生在**执行前**。而 issue 现象 1 说的是「自动化**运行期间**操作者的
// 鼠标/键盘被反复夺取」——命令一旦开跑就没有检查点，长时注入脚本跑到一半用户接管
// 也不会停。这里补执行期的周期性探测：用户接管即回调，由调用方终止进程树。
//
// 覆盖范围与执行前判定**完全一致**（同一份 pattern 表、同一归一化视图）：普通
// shell 命令连定时器都不建，零开销。

/** 执行期探测间隔默认值（ms）。 */
export const DEFAULT_YIELD_WATCH_MS = 3_000

/**
 * 解析执行期探测间隔：`RIVET_CU_YIELD_WATCH_MS`；**0 = 关闭执行期监控**
 * （执行前判定不受影响，仍由 `RIVET_CU_YIELD_MS` 控制）。非法值回退默认。
 *
 * 为什么默认 3s 而非复用 1200ms 的让出阈值：每次探测要起一个 PowerShell 子进程
 * （实测墙钟 ~234ms），间隔太短会在长时命令上持续占资源。注入类命令多数命短，
 * 3s 间隔意味着它们通常一次探测都不发生。
 */
export function resolveYieldWatchMs(): number {
  const raw = process.env['RIVET_CU_YIELD_WATCH_MS']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return DEFAULT_YIELD_WATCH_MS
}

/** 该命令是否需要执行期监控——与执行前判定同视图（见 matchesAvailabilityHazard）。 */
export function shouldWatchExecution(command: string): boolean {
  return matchesAvailabilityHazard(command)
}

/**
 * 执行期让出的结果文案——与执行前文案刻意不同：这次命令**已经跑过一部分**，
 * 必须说清「被终止了」以及「已产生的副作用不会回滚」，否则用户会以为命令压根没执行。
 */
export function executionYieldMessage(idleMs: UserIdleMs, watchMs: number, partialOutput: string): string {
  const idle = idleMs === null ? '未知' : `${idleMs}ms`
  const head = [
    `[让出·执行中] 这条命令正在合成系统级键鼠输入（或抢占前台窗口），而你在 ${idle} 前开始操作本机`,
    `——已在执行途中终止它，把输入控制权还给你（探测间隔 ${watchMs}ms）。`,
    '',
    '注意：命令**已经跑过一部分**，已产生的副作用（窗口状态、写入、网络请求）不会自动回滚。',
    '要继续的话：停手一两秒后重跑本命令；或改用 computer_use 工具（按应用逐项授权，每次注入前有同样的让出检查）。',
  ].join('\n')
  return partialOutput ? `${head}\n\n终止前的部分输出:\n${partialOutput.slice(-2000)}` : head
}

export interface YieldWatchDeps {
  probe: () => Promise<UserIdleMs>
  thresholdMs: number
  intervalMs: number
  /** 用户接管时回调（调用方负责终止进程树并 settle）。最多调用一次。 */
  onYield: (idleMs: UserIdleMs) => void
}

/**
 * 启动执行期让出监控，返回 `stop()`。
 *
 * 用递归 setTimeout 而非 setInterval：**不会重叠探测**——单次探测最坏要等 5s
 * 超时（`probeUserIdleMs` 的默认 timeout），固定间隔会让慢探测堆叠。
 *
 * 语义与执行前判定一致：
 * - 探测返回 null（无法检测）或抛错 → 不触发，护栏失效不该成为新的失败点；
 * - 触发即停：回调后不再调度（调用方正在终止进程，继续探测没有意义）；
 * - `intervalMs <= 0` → 不建任何调度（旋钮关闭路径）。
 */
export function startYieldWatch(deps: YieldWatchDeps): () => void {
  if (deps.intervalMs <= 0) return () => {}
  let stopped = false
  let handle: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    let idleMs: UserIdleMs = null
    try {
      idleMs = await deps.probe()
    } catch {
      idleMs = null
    }
    if (stopped) return
    if (isUserActive(idleMs, deps.thresholdMs)) {
      stopped = true
      deps.onYield(idleMs)
      return
    }
    handle = setTimeout(() => { void tick() }, deps.intervalMs)
    // 监控不该把进程钉在事件循环上——命令结束后 stop() 会清；这条是兜底。
    handle.unref?.()
  }

  handle = setTimeout(() => { void tick() }, deps.intervalMs)
  handle.unref?.()
  return () => {
    stopped = true
    if (handle !== undefined) clearTimeout(handle)
  }
}
