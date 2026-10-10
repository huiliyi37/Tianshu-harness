import { verificationToolFacts } from '../verification-activity.js'
/**
 * Advisory-Readback Hook — advisory 采纳核销的运行时接线（P1a）。
 *
 * 三半边设计：
 *   postTool 半边 — 把每个工具事件（完整 target/command + 错误状态）喂进
 *     AdvisoryReadback 的观察日志。不走 recentToolHistory：那是截断的滚动窗口
 *     （重轮次 20+ 调用会把窗口内证据挤掉），也不带 turn 标记。
 *   postTurn 半边 — 对到期的 expect 谓词核销，判定 adopted/ignored，
 *     并把判定事件落遥测（kind: 'advisory-outcome'）。
 *   postSession 半边 — 会话结束时最后核销一次，并把仍未走完观察窗口的送达
 *     作为 unresolved 报出。此前没有这一半边：末轮送达的 advisory 会随会话
 *     结束被静默丢弃，既不产生 outcome 也不留任何痕迹。worker 首当其冲——
 *     中位只跑 2 轮而窗口 2-4 轮，实测 88 个 worker 仅产出 3 条 outcome，
 *     效力账本上 worker 场景近乎空白。
 *
 * 送达跟踪（track）不在 hook 里：render 发生在 buildTurnRequest（turn-step-producer），
 * hook 管线拿不到那个时点——由 turn-step-producer 在 render 后直接调用。
 */

import type { PostSessionRuntimeHook, PostToolRuntimeHook, PostTurnRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryReadback } from '../advisory-readback.js'
import { ADVISORY_OUTCOME_KIND, ADVISORY_HOLDOUT_KIND, ADVISORY_UNRESOLVED_KIND } from '../telemetry-writer.js'

export interface AdvisoryReadbackHookDeps {
  readback: AdvisoryReadback
  /** 遥测落盘 — 缺省不写（测试环境） */
  writeTelemetry?: (record: { kind: string } & Record<string, unknown>) => void
  /** 会话累计采纳/忽略变化时回调（guardian meta 摘要接线） */
  onOutcomes?: (totals: { adopted: number; ignored: number }) => void
}

/** 从工具事件中提取核销评估用的 target 字符串（bash → command,写读类 → file_path） */
export function extractObservedTarget(tool: RuntimeToolEvent): string {
  const input = tool.input
  if (input) {
    const cmd = input.command
    if (typeof cmd === 'string') return cmd
    const fp = input.file_path ?? input.path ?? input.file
    if (typeof fp === 'string') return fp
    const pattern = input.pattern
    if (typeof pattern === 'string') return pattern
    // CVM-vector v3.1：recall_capsule 的结构化 input 只有 star 字段——
    // 不提取则 observed target 恒为空串，tool_appears+targetIncludes 谓词
    // 永远无法核销（伪 expect）。结构化提取，不做自由文本猜测。
    const star = input.star
    if (typeof star === 'string') return star
  }
  return tool.target ?? ''
}

export function createAdvisoryReadbackHooks(
  deps: AdvisoryReadbackHookDeps,
): [PostToolRuntimeHook, PostTurnRuntimeHook, PostSessionRuntimeHook] {
  const observer: PostToolRuntimeHook = {
    phase: 'postTool',
    name: 'advisory-readback-observe',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      deps.readback.observeTool({
        turn: (ctx.snapshot.modelTurn ?? ctx.snapshot.turn),
        name: tool.name,
        ...verificationToolFacts(tool.name, tool.input ?? { command: extractObservedTarget(tool) }, ctx.snapshot.cwd),
        target: extractObservedTarget(tool),
        isError: tool.isError ?? !tool.success,
      })
    },
  }

  const evaluator: PostTurnRuntimeHook = {
    phase: 'postTurn',
    name: 'advisory-readback-evaluate',
    run(ctx: RuntimeHookContext): void {
      const decided = deps.readback.evaluate((ctx.snapshot.modelTurn ?? ctx.snapshot.turn))
      for (const pending of deps.readback.drainUnresolved()) deps.writeTelemetry?.({ kind: ADVISORY_UNRESOLVED_KIND, ...pending })
      if (decided === 0) return
      const outcomes = deps.readback.drainOutcomes()
      for (const o of outcomes) {
        // shadow 判定单独 kind:'advisory-holdout'——反事实基线与投递组账本分开回放。
        // 两 kind 均在 telemetry lite 白名单（P4 晋级证据源 2，默认落盘）。
        deps.writeTelemetry?.({ kind: o.shadow ? ADVISORY_HOLDOUT_KIND : ADVISORY_OUTCOME_KIND, ...o })
      }
      deps.onOutcomes?.(deps.readback.getTotals())
    },
  }

  const finalizer: PostSessionRuntimeHook = {
    phase: 'postSession',
    name: 'advisory-readback-finalize',
    run(ctx: RuntimeHookContext): void {
      const { decided, unresolved } = deps.readback.flushAtSessionEnd((ctx.snapshot.modelTurn ?? ctx.snapshot.turn))
      if (decided > 0) {
        for (const o of deps.readback.drainOutcomes()) {
          deps.writeTelemetry?.({ kind: o.shadow ? ADVISORY_HOLDOUT_KIND : ADVISORY_OUTCOME_KIND, ...o })
        }
        deps.onOutcomes?.(deps.readback.getTotals())
      }
      if (unresolved.length === 0) return
      // 一条汇总而非逐条：每会话一行，体量可控且足以回答"盲区有多大、卡在哪些 key"。
      const byKey: Record<string, number> = {}
      let maxTurnsShort = 0
      for (const u of unresolved) {
        byKey[u.key] = (byKey[u.key] ?? 0) + 1
        if (u.turnsShort > maxTurnsShort) maxTurnsShort = u.turnsShort
      }
      deps.writeTelemetry?.({
        kind: ADVISORY_UNRESOLVED_KIND,
        turn: (ctx.snapshot.modelTurn ?? ctx.snapshot.turn),
        count: unresolved.length,
        maxTurnsShort,
        byKey,
        deliveries: unresolved,
      })
    },
  }

  return [observer, evaluator, finalizer]
}
