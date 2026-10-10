// ─── 产出流判定 — 单一事实源 ──────────────────────────────────────
//
// 语义：主控正处在「编辑 + 验证交替且无失败」的推进节奏里。
//
// 三个消费点，两种用法：
//   1. advisory-bus 阶段抑制（navigator 沉默规则）—— 别打扰
//   2. EFE pragmatic 季节因子 —— wuwei 的抑执行让位
//   3. affordance instrumental 季节惩罚 —— 同上
//
// 「别打扰」和「抑制执行」是两回事：产出流里两者都不该发生，但 wuwei 季只
// 表达了前者的意图，实现却顺带压低了执行价值（见 2026-07-25 证据文档 C6）。
//
// 原判据自 2026 年 Phase 2 起以内联闭包形式存在于 loop.ts，此处提取为纯函数
// 以消除「同一概念多处各写一遍」的漂移风险（同 PRODUCTIVE_TOOLS 单一事实源）。
// 提取时唯一的语义变动：编辑工具集改用 WRITE_TOOL_NAMES，比原内联列表多
// ast_edit —— 原列表遗漏它属于同类漂移，不是有意排除。

/** 产出流内的验证类 bash 命令：只认 test / typecheck（verificationAttempted 的口径），
 *  比 isVerificationIntent 窄——这里判的是「编辑-验证节律」，lint/build 不构成该节律的验证半边。 */
import { verificationAttempted } from './verification-activity.js'
import { WRITE_TOOL_NAMES } from '../tools/write-tool-helpers.js'

/** 判定所需的最小工具历史字段（recentToolHistory 条目的结构子集）。 */
export interface ProductionFlowEntry {
  tool: string
  status?: 'success' | 'failed' | 'running'
  target?: string
  verificationAttempted?: boolean
}

/** 判定窗口：最近 N 次工具调用。 */
const FLOW_WINDOW = 6
/** 窗口内样本下限——不足则证据不够，判定为非产出流。 */
const FLOW_MIN_SAMPLES = 3

/**
 * 主控是否处于产出流。
 *
 * @param history 工具历史（取末尾 FLOW_WINDOW 条；调用方无需自行截断）
 */
export function isInProductionFlow(history: ReadonlyArray<ProductionFlowEntry>): boolean {
  const recent = history.slice(-FLOW_WINDOW)
  if (recent.length < FLOW_MIN_SAMPLES) return false

  const hasEdit = recent.some(h => WRITE_TOOL_NAMES.has(h.tool))
  const hasVerify = recent.some(h =>
    h.tool === 'run_tests' || (h.tool === 'bash' && (h.verificationAttempted ?? verificationAttempted('bash', { command: h.target ?? '' }))))
  const hasFailure = recent.some(h => h.status === 'failed')

  return hasEdit && hasVerify && !hasFailure
}
