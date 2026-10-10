/**
 * 收敛注入消息 — 构造与结构化变体标识（Layer 2，2026-10-05）。
 *
 * 沿接缝从 convergence-detector.ts 拆出：**检测**（该不该提醒）与**表达**
 * （提醒什么、属于哪个方向）是两件事。detector 只负责判级；本模块负责文案
 * 与 MessageVariant——发射门消费后者判"方向是否变化"，取代从文案首行取 key
 * 的做法（文案改词曾被误读为改道并重置冷却：会话 74f350c9 的 5 次告警，
 * 前 4 次落在 50 秒内）。
 */

import type { ConvergenceSignals, ActivityMode, WindowTier } from './convergence-detector.js'
import type { PhaseClass } from './phase-class.js'
import type { EditExpectation } from './edit-expectation.js'
import { sessionStateAdvice } from './runtime-advice-facts.js'

/** 注入消息的结构化变体标识——发射门据它判"方向是否变化"（文案改词不构成改道）。 */
export type MessageVariant =
  | 'stagnation-diagnostic' | 'stagnation-build' | 'no-tool'
  | 'delivery-complete' | 'gate-blocked' | 'gate-failed'
  | 'route-confirm' | 'diagnostic' | 'generic'

interface BuiltMessage { text: string; variant: MessageVariant }

export function buildInjectedMessage(
  level: 2 | 3,
  _score: number,
  signals: ConvergenceSignals,
  phaseClass: PhaseClass,
  tier: WindowTier,
  deliveryStatus?: string,
  noToolTurnCount?: number,
  productiveStagnation?: boolean,
  repeatCount?: number,
  activityMode?: ActivityMode,
  runtimeAdvice?: string,
  editExpectation?: EditExpectation,
): BuiltMessage {
  // P1：编辑期待——not-required/unknown 时不把"去编辑"当处方（验证/审查/
  // 只读步骤落入编辑处方会把正确行为误判成偏航）。缺失时按 required 处理
  // （旧行为不变）。required 的判定与收敛评分同源（同一投影对象）。
  const expectsEdit = (editExpectation?.kind ?? 'required') === 'required'
  const lines: string[] = []

  // Progressive prefix: when the same message variant has been emitted before,
  // add a "第 N 次提醒" header so the agent knows this isn't new information.
  // The prefix escalates: first repeat acknowledges prior nudge was ignored;
  // subsequent repeats tell the agent to ignore if direction is fine.
  if (repeatCount && repeatCount > 0) {
    const nth = repeatCount + 1 // this emission is the (repeatCount+1)-th
    if (repeatCount === 1) {
      lines.push(`（第 ${nth} 次同类提醒 — 上次提醒后你可能已调整，如果方向没问题请忽略）`)
    } else {
      lines.push(`（第 ${nth} 次同类提醒 — 已多次发出，如果方向没问题请忽略此信息）`)
    }
    lines.push('')
  }

  // Productive-ratio stagnation variant: model keeps calling read/grep tools
  // (so noToolTurnCount stays 0), but never edits/tests/commits. This catches
  // the alternating read→analyze→read→analyze loop.
  if (productiveStagnation) {
    // W3 诊断态分流（incident 20b9714e）：排查/根因分析会话被催"输出结论"
    // 直接诱发脑补——正确处方是先核实将写进结论的断言，再收束。
    if (activityMode === 'diagnostic') {
      lines.push('**天枢-感知：最近多轮全部是读取/搜索操作。如果信息已足够，请核实后收束。**')
      lines.push('')
      lines.push('收束前先做断言核实：')
      lines.push('- 把你准备写进结论的每条关键断言，用工具核实一遍（ls/grep/read 实际文件、跑实际命令）——不要凭已读片段推断未读内容')
      lines.push('- 核实不了的断言，在结论里显式标注"未核实"，不要写成事实')
      lines.push('- 核实完成后输出结论，交给用户判断——不要为了"做点什么"而去改代码')
      return { text: lines.join('\n'), variant: 'stagnation-diagnostic' }
    }
    lines.push('**天枢-感知：最近多轮全部是读取/搜索操作，没有任何编辑、测试或提交。**')
    lines.push('')
    lines.push('信息可能已足够，请收敛：')
    lines.push('- 如果这是审查/排查类任务，输出你的结论或发现，交给用户判断——不要为了"做点什么"而去改代码')
    lines.push(expectsEdit
      ? '- 如果这是实现类任务且已有方案，直接编辑或测试'
      : '- 当前步骤不期待编辑（验证/只读/审查）——请核实关键断言与证据后输出结论')
    lines.push('- 如果不确定方向，向用户说出你的判断')
    lines.push('- 如果任务已完成，输出摘要并结束')
    return { text: lines.join('\n'), variant: 'stagnation-build' }
  }

  // No-tool stagnation variant: consecutive turns without tool calls signal
  // hesitation or stuck state — the model is producing text/thinking but not
  // taking any action. This is a different failure mode from tool oscillation.
  if (noToolTurnCount && noToolTurnCount >= 2) {
    lines.push(`**天璇-感知：连续 ${noToolTurnCount} 轮未执行任何工具调用。你可能陷入了隧道视野。**`)
    lines.push('')
    lines.push('停下来，换个角度看当前状态：')
    lines.push('- 如果你发现了问题但不确定，请直接向用户指出')
    lines.push('- 如果需要更多信息，请调用 read_file / grep 等工具')
    lines.push('- 如果任务已完成，请输出摘要并结束回合')
    lines.push('- 天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall')
    return { text: lines.join('\n'), variant: 'no-tool' }
  }

  // Delivery-completion variant: when task is verified and convergence fires,
  // signal completion instead of asking the model to try harder.
  if (deliveryStatus === 'verified' && level === 2) {
    lines.push('**天枢-感知：所有代码变更已验证通过，任务可能已完成。**')
    lines.push('')
    lines.push('如果所有子任务已完成且验证通过，请结束当前回合。')
    lines.push('- 检查是否有遗漏的 deliver_task 调用')
    lines.push('- 如果没有，输出最终状态摘要并停止工具调用')
    return { text: lines.join('\n'), variant: 'delivery-complete' }
  }

  // Gate-aware variant: when delivery status is blocked or failed, integrate
  // the gate state into the convergence message instead of giving a generic
  // "换个角度看问题". The agent may be stuck in a retry loop that the gate
  // already classifies as non-blocking (YELLOW) — don't contradict the gate.
  if (deliveryStatus === 'blocked' || deliveryStatus === 'failed') {
    const gateLabel = deliveryStatus === 'blocked' ? '受阻' : '失败'
    lines.push(`**天枢-感知：交付门禁为 ${deliveryStatus.toUpperCase()}（验证${gateLabel}），任务进入收敛状态。**`)
    lines.push('')
    if (deliveryStatus === 'blocked') {
      lines.push('验证被外部因素阻断（超时、命令不存在、测试框架缺失）。不要反复重试同一方法。')
      lines.push('- 若为测试基础设施缺失：向用户说明并询问是否需要协助搭建')
      lines.push('- 若为超时：增加 timeout 或分批运行')
      lines.push('- 若已有可交付成果：确认 deliver_task 门禁状态，若 YELLOW 可带条件交付')
    } else {
      lines.push('验证失败。先诊断根因：是代码改动的 bug 还是预存量失败？')
      lines.push('- 查看 failure diagnostics 定位失败文件和错误类型')
      lines.push('- 预存量或外部归因需基线、失败位置或隔离对照；已取代失败不豁免当前阻断项，force 也不豁免')
      lines.push('- 若是你的改动引入：用最小复现定位根因')
    }
    lines.push('- 不要让收敛信号和门禁信号矛盾——收敛说"换策略"，门禁说"可交付"')
    return { text: lines.join('\n'), variant: deliveryStatus === 'blocked' ? 'gate-blocked' : 'gate-failed' }
  }

  // Route-confirmation variant（2026-07-07，会话 519216c0 复盘）：编辑在持续
  // 落地且失败率低——轨迹本身没问题，收敛信号来自新颖度/熵类指标（同批文件
  // 反复改动、工具模式单一）。此时"换个角度看问题"是错误处方：路线正确的
  // 模型（尤其自带质疑的天权域）会整条驳回，advisory 沦为噪音。确认式收敛
  // 反其道：先肯定路线，把收敛动作定义为"钉一个验证锚点"而非改道。
  if (level === 2 && signals.editRatio >= 0.2 && signals.errorPenalty >= 0.8) {
    lines.push('**天枢-感知：编辑在持续落地且失败率低——路线本身没有被质疑，不需要换方向。**')
    lines.push('')
    lines.push('需要的是一个验证锚点，把已有进度钉住：')
    lines.push('- 对已完成的改动跑一次 typecheck / related_tests，通过后再铺开下一批')
    lines.push('- 验证失败则当场修复——不带伤推进')
    lines.push('- 若剩余工作已明确，列出剩余清单，按清单收敛而非按惯性续写')
    return { text: lines.join('\n'), variant: 'route-confirm' }
  }

  // W3 诊断态分流：通用变体的"换个角度/中断探索"对排查会话同样是错误处方
  // ——把收束动作定义为断言核实，而非改道或强行下结论。
  if (activityMode === 'diagnostic') {
    lines.push(level === 2
      ? '**天璇-感知：排查进度信号偏弱。请核实已有断言后收束，而不是继续铺开新的读取。**'
      : '**天枢-感知：排查未能在预期轮次内收敛。请立即核实关键断言并输出带证据的结论。**')
    lines.push('')
    lines.push('- 把准备写进结论的关键断言用工具核实（ls/grep/read 实际文件），核实完再收束')
    lines.push('- 没有工具证据支撑的推断必须标注"未核实"，不要写成事实')
    lines.push(runtimeAdvice ?? sessionStateAdvice())
    return { text: lines.join('\n'), variant: 'diagnostic' }
  }

  if (level === 2) {
    lines.push('**天璇-感知：当前任务可能进入低效循环。换个角度看问题。**')
  } else {
    lines.push('**天枢-感知：任务未能在预期轮次内收敛，建议中断当前探索。**')
  }

  // P1：仅在编辑期待为 required 时给出"编辑产出偏低"诊断——验证/只读步骤
  // 无编辑是正确行为，不是偏航证据。
  if (expectsEdit && signals.editRatio < 0.1 && phaseClass === 'execute') {
    lines.push(`- 执行阶段进行了 ${Math.round(signals.editRatio * 100)}% 轮次有编辑产出的操作 — 远低于预期 (≥30%)`)
  }
  if (signals.toolEntropy < 0.3) {
    lines.push('- 工具使用模式高度重复，当前探索路径可能已穷尽')
  }
  if (signals.oscillationPenalty < 0.3) {
    lines.push('- 工具调用模式高度震荡 (A→B→A→B)，当前验证路径可能已穷尽')
  }
  if (signals.targetNovelty < 0.2 && phaseClass !== 'execute') {
    lines.push('- 目标文件重复率过高，建议扩大搜索范围或切换策略')
  }
  if (signals.errorPenalty < 0.5) {
    lines.push(`- 失败率 ${Math.round((1 - signals.errorPenalty) * 100)}% 偏高，当前方向可能不可行`)
  }
  if (signals.tokenEfficiency < 0.2 && phaseClass !== 'explore') {
    lines.push(expectsEdit
      ? '- 纯读取无产出，建议立即采取编辑或测试行动验证当前假设'
      : '- 纯读取无产出，建议核实关键断言/失败证据后输出带证据的结论')
  }
  if (signals.tokenEfficiency === 0.0 && phaseClass === 'explore') {
    lines.push('- 已连续读取多个文件但未做任何编辑/测试/提交 — 信息已足够，请输出结论或采取行动')
  }
  if (signals.textRepetitionPenalty < 0.3) {
    lines.push('- 连续多轮输出高度相似的文本内容，模型可能陷入"重复输出"循环')
  }

  if (level === 3) {
    lines.push('')
    lines.push('**建议（按场景选择）：**')
    lines.push('- 若在排查回归（功能改动后丢失/失效）：不要开新对话重来——答案在提交历史里。优先 `git log --oneline` 定位区间 → `git bisect` 或回滚到最近可用 checkpoint 再前滚，对照基线 diff 直读引入回归的改动。')
    lines.push('- 其余场景：提交已完成部分，重新描述需求并开始新一轮对话。')
    lines.push(`- 上下文窗口: ${tier.label}，当前已使用较多轮次`)
  } else {
    lines.push('')
    lines.push('请选择以下行动之一：')
    if (expectsEdit) {
      lines.push('- 对当前最可能的方案进行编辑或测试')
    } else {
      lines.push('- 核实关键断言与证据，输出带证据的结论（当前步骤不期待编辑）')
    }
    lines.push('- 重新阅读用户原始请求，确认方向')
    lines.push('- 缩小范围：只解决一个子问题')
    lines.push('- 天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall')
  }

  return { text: lines.join('\n'), variant: 'generic' }
}
