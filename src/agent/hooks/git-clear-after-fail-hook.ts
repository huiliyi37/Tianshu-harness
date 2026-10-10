/**
 * Git-Clear-After-Fail Hook — postTool 检测"验证失败后用 git 清场"模式。
 *
 * prompt 约束（AGENTS.md 高危命令纪律 + `<security>` 段，硬闸门）：
 *   验证失败别用 git 清场：测试因外部改动/并发失败时，先定位根因，
 *   不要用 stash/reset/checkout 清空工作区来骗过验证。
 *
 * 失效路径：模型跑测试红灯 → 怀疑"别人的改动"污染 → git stash/reset/checkout
 * 清空工作区 → 测试绿了 → 交付。实际根因（测试非隔离、共享临时路径）未定位，
 * 且多会话共享工作区下可能误伤其他会话的改动。
 *
 * 检测信号（完全客观）：
 *   1. postTool 检测到失败的 run_tests / bash（测试类命令，exit ≠ 0）
 *   2. 随后 N 个工具调用内（N=3）出现 bash 含 git stash（非 pop/list）、
 *      git reset、git checkout --、git restore、git clean
 *   3. 中间无 read/grep 类根因定位动作 → 加重可疑度
 *
 * 与 self-verify 的区别：self-verify 管"你没验证就下结论"；这个管
 * "验证失败了你用 git 清场绕过根因"——压力状态下不可逆操作的守护。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { GIT_CLEAR_RE } from '../../tools/destructive-patterns.js'

export interface GitClearAfterFailHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Session-scoped: 最近一次失败测试的 turn + 后续工具调用窗口 */
interface FailWindow {
  /** 失败测试发生时的 turn */
  turn: number
  /** 失败后经过的工具调用计数 */
  toolCallsSinceFail: number
}

/** 失败后窗口大小（工具调用数） */
const WINDOW_SIZE = 3

/**
 * 测试类 bash 命令正则——用于判断 bash 是否在跑测试。
 * 来源：AGENTS.md Commands 段。口径与 verification-activity.isVerificationIntent 同族，
 * 但这里刻意更窄：只有测试类命令才开门，lint/build 失败不构成"测试失败"。
 * 匹配：npm test / npm run test / tsx --test / pytest / vitest / jest 等
 */
const TEST_CMD_RE = /\b(test|vitest|jest|pytest|mocha|tsx\s+--test|npm\s+(run\s+)?(test|typecheck))\b/i

// GIT_CLEAR_RE 迁至 src/tools/destructive-patterns.ts(单一事实来源)——
// pre-execution gate(destructive-gate.ts)与本 hook 判据同源、状态独立。

/** 核验类工具——read/grep/find 等根因定位动作 */
const VERIFY_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'semantic_search',
  'lsp_goto_definition', 'lsp_find_references',
])

export function createGitClearAfterFailHook(
  deps: GitClearAfterFailHookDeps,
): PostToolRuntimeHook & { getFailWindow: () => FailWindow | null; resetFailWindow: () => void } {
  let failWindow: FailWindow | null = null

  const hook: PostToolRuntimeHook & { getFailWindow: () => FailWindow | null; resetFailWindow: () => void } = {
    phase: 'postTool',
    name: 'git-clear-after-fail',
    getFailWindow() { return failWindow },
    resetFailWindow() { failWindow = null },
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const { turn } = ctx.snapshot

      // ── Step 1: 检测失败测试 → 开启窗口 ──────────────────────
      const isTestFail =
        (tool.name === 'run_tests' && tool.isError) ||
        (tool.name === 'bash' && tool.isError && TEST_CMD_RE.test(tool.input?.command as string ?? tool.target ?? ''))

      if (isTestFail) {
        failWindow = { turn, toolCallsSinceFail: 0 }
        return
      }

      // ── Step 2: 窗口活跃时计数 ────────────────────────────────
      if (!failWindow) return

      failWindow.toolCallsSinceFail++

      // 窗口过期
      if (failWindow.toolCallsSinceFail > WINDOW_SIZE) {
        failWindow = null
        return
      }

      // ── Step 3: 检测 git 清场命令 ─────────────────────────────
      if (tool.name !== 'bash') return

      const cmd = (tool.input?.command as string) ?? tool.target ?? ''
      if (!GIT_CLEAR_RE.test(cmd)) return

      // 检查窗口内是否有根因定位动作（read/grep/find）。
      // 与缺口②不同：测试失败的诊断目标不固定（可能在任何文件），
      // 不做文件级精确匹配，但排除非诊断性的操作（target 不含路径特征）。
      const history = ctx.snapshot.recentToolHistory
      const hasDiagnosis = history.some(h => {
        if (VERIFY_TOOLS.has(h.tool)) {
          // verify 工具的 target 必须看起来像文件路径（含 / 或 .ext）
          const target = h.target ?? ''
          return /[/.]/.test(target)
        }
        if (h.tool === 'bash') {
          const target = h.target ?? ''
          return /\b(grep|cat|find|rg|head|tail)\b/.test(target) && /[/.]/.test(target)
        }
        return false
      })

      // 无根因定位 + git 清场 → constitutional advisory（不可逆 + 多会话误伤）
      if (!hasDiagnosis) {
        deps.advisoryBus.submit({
          key: 'git-clear-after-fail',
          priority: 0.9,
          category: 'constitutional',
          tier: 'constitutional',
          content: `⚠ 测试刚失败，你正在用 git 清场命令（stash/reset/checkout/restore/clean）清空工作区。这会丢改动且可能误伤其他会话。先定位根因：用 read_file/grep 检查测试是否非隔离、是否共享临时路径、是否受外部改动影响。多会话共享工作区下任何丢改动的操作都可能误伤别的会话。`,
          ttl: 1,
          // 核销：清场已发生（postTool 检测），采纳 = 事后补根因定位动作。
          // 谓词映射表（P1a）：git-clear → tool_appears(诊断类, 2 轮)
          expect: { kind: 'tool_appears', tools: [...VERIFY_TOOLS], withinTurns: 2 },
          // Phase 2：immediate + 消息流细断点。边界认知：本 hook 是事后检测,
          // advisory 发出时清场命令已执行完——immediate 只保证下一次不被调度器
          // 恶化（挂起/抑制）。真正的当轮拦截需要工具层 pre-execution gate。
          immediate: true,
          channel: 'system-reminder',
          // W2 通道分级：git 清场是用户保护类守护，不限流（SessionContext 不设额度）——
          // 事后告警只有一次触发机会，被 cap 拦截意味着永久丢失。
          srClass: 'functional',
        })
      }

      // 命中后关闭窗口（一次性触发，不重复告警）
      failWindow = null
    },
  }

  return hook
}
