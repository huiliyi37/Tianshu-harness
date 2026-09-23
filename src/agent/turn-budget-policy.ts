/**
 * 轮次上限策略——唯一事实源（2026-09-22 收口）。
 *
 * 规则很简单，但此前它被抄在 6 个地方（bootstrap / serve-agent 两处 / main.ts /
 * yolo-toggle / slash-commands 两处），每处各写一遍 `mode === 'skip' ? 0 : 200`
 * 或 `? 0 : config.agent.maxTurns`，于是长出两类静默偏差：
 *
 *  1. **写死 200**：用户 config 里配的 `agent.maxTurns: 500` 只要动过一次档位
 *     就被静默改回 200（TUI 与桌面端口径还不一致）。
 *  2. **只升不降**：构建期按"全局档"算出 0（全局=免审批），随后会话 override
 *     把它降回监督/自动时，只覆盖了 mode、没收回上限——一个"监督"会话静默持有
 *     无限轮次。
 *
 * 语义：免审批档（dangerously-skip-permissions）＝ 无限轮次（0，orchestrator 用
 * `Number.MAX_SAFE_INTEGER` 代替，见 turn-orchestrator.ts），其它档 = 用户配置值。
 * auto-accept 不是 skip：它仍有 unconditional / path-grant 硬门禁，预算照常生效。
 */

import type { ApprovalMode } from './loop-types.js'

/** 免审批档的 maxTurns 哨兵：0 = 无硬上限（真·全自动）。 */
export const UNLIMITED_TURNS = 0

export function resolveMaxTurns(
  approvalMode: ApprovalMode | string | undefined,
  configuredMaxTurns: number,
): number {
  return approvalMode === 'dangerously-skip-permissions' ? UNLIMITED_TURNS : configuredMaxTurns
}
