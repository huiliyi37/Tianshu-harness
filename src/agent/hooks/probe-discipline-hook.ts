import type { AdvisoryBus } from '../advisory-bus.js'
import type { PostToolRuntimeHook, RuntimeToolEvent } from '../runtime-hooks.js'

/** 太一域洞察机制化（2026-08-07 会话复盘落地）：
 *  诊断轮连续 ≥3 个只读工具而零探针 → 提示「30 秒探针能否杀死当前假设」。
 *  探针是推理的校验器：推理生成假设，探针验证或杀死它——红灯比继续推演
 *  更快逼近根因（symlink 越界 / C→R 折叠均靠探针红灯定位）。
 *  冷却：同源 advisory 注入后 COOLDOWN_CALLS 次工具调用内不重复（防狂轰滥炸）。
 *
 *  取证补充（2026-08-10 session-interrupt 诊断复盘）：
 *  探针杀假设，但杀不了编出来的假设。连续只读若全是「层层源码推断」——
 *  引用无行号、read 无区间、grep 无上下文——推断链再长也没有骨头。此时
 *  先催「找直接观察」（相邻行 / 时间戳对齐 / 磁盘证据），而非直接催探针。 */

export interface ProbeDisciplineDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** 只读取证工具——探针分级的「只读」判定集。写/跑测试/执行类不算。 */
const READONLY_TOOLS = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'ast_grep', 'repo_map', 'repo_graph',
  'semantic_search', 'recall', 'memory', 'lsp_goto_definition', 'lsp_find_references',
  'web_fetch', 'web_search', 'git',
])

/** 连续只读触发阈值：5 轮——正常定位 1-2 轮读就够，3 轮以内的深潜仍在取证
 *  自然节奏；只有持续 5 轮只读仍无进展才值得提醒（2026-09-07 实机调参：
 *  原 3 轮在诊断长链中过于频繁，噪音大于信号）。 */
const PROBE_THRESHOLD = 5
/** 注入冷却：同类型 advisory 至少间隔 12 次工具调用。 */
const COOLDOWN_CALLS = 12

/** 带观察锚点的只读——取证优先级高于裸推断。
 *  行号区间、上下文行、精确符号定位，都让结论落回可复核的观察；
 *  无锚点的 read/grep 读再多也只是在叠推断层。 */
const ANCHORED_READONLY_TOOLS = new Set(['read_section', 'lsp_goto_definition', 'lsp_find_references'])
const ANCHOR_HINT = /(?:offset|limit|focus|context_lines|start|end|line)\s*[=:]/

export function createProbeDisciplineHook(deps: ProbeDisciplineDeps): PostToolRuntimeHook {
  let readStreak = 0
  let callsSinceLastInject = COOLDOWN_CALLS + 1
  // 取证锚点计数：连续只读里带行号/区间/上下文的次数。全裸读（零锚点）→
  // 先催取证；有锚点仍推不动 → 才轮到探针。
  let anchoredReads = 0

  return {
    phase: 'postTool',
    name: 'probe-discipline',
    async run(_ctx: unknown, tool: RuntimeToolEvent): Promise<void> {
      callsSinceLastInject++
      if (READONLY_TOOLS.has(tool.name)) {
        readStreak++
        const input = (tool.input ?? {}) as Record<string, unknown>
        const argString = typeof input === 'string' ? input : safeArgs(input)
        const anchored = ANCHORED_READONLY_TOOLS.has(tool.name) || ANCHOR_HINT.test(argString)
        if (anchored) anchoredReads++
      } else {
        // 写/验证/执行类动作打破只读串——不是取证停滞。
        readStreak = 0
        anchoredReads = 0
      }
      if (readStreak >= PROBE_THRESHOLD && callsSinceLastInject >= COOLDOWN_CALLS) {
        callsSinceLastInject = 0
        if (anchoredReads === 0) {
          // 连续只读但零观察锚点——推断叠推断，没有骨头。先补取证，探针还排不上。
          deps.advisoryBus.submit({
            key: `probe-discipline-${Date.now()}`,
            priority: 0.5,
            category: 'discipline',
            tier: 'operational',
            content: `【太一·取证】已连续 ${readStreak} 轮只读，但零个带观察锚点（行号区间 / context_lines / 时间戳对齐 / 磁盘证据）。推断链再长也没有骨头——先找一行可复核的观察：相邻行、L→L 的 gap、落盘文件，再让因果从里面长出来。探针杀假设，但杀不了编出来的假设。`,
            ttl: 2,
            channel: 'system-reminder',
          })
        } else {
          deps.advisoryBus.submit({
            key: `probe-discipline-${Date.now()}`,
            priority: 0.5,
            category: 'discipline',
            tier: 'operational',
            content: `【太一·探针】已连续 ${readStreak} 轮只读取证。30 秒探针（最小复现 / 一行 tsx -e）能杀死当前最可能的假设吗？红灯比继续推演更快逼近根因；假设不可测（缺 key/缺环境）才降级纯推理并标注未验证。`,
            ttl: 2,
            channel: 'system-reminder',
          })
        }
      }
    },
  }
}

/** 工具 input 可能是对象/undefined——转成可 grep 的字符串，不抛。 */
function safeArgs(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}
