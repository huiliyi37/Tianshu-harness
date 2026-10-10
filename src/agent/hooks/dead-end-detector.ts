/**
 * Dead-End Detector — postTool 检测"同一文件反复 edit→verify-fail"死路循环
 * (主控工作流缺口 A,2026-07-04)。
 *
 * 核查修正(相对天枢原提案):编辑工具本身几乎不会失败——写盘成功但语义
 * 错误的失败挂在**验证**路径(classifyFailure)。所以信号不是"edit 连续
 * 失败",而是:同一文件 edit → verify fail → edit → verify fail,循环 ≥2
 * 次且中间无 verify pass。这是"盲改"的客观签名:模型在没有新诊断信息的
 * 情况下反复改同一处。
 *
 * 与 stigmergy-hook 的 dead-end 沉积互补:那边管 bash 同命令反复失败
 * (命令级),这边管 edit→verify 循环(文件级)。排除判据同源
 * (2026-07-02 收紧):timeout / environment 类失败不算语义失败。
 *
 * 出生即可测(因果账本):expect = tool_appears(诊断类工具, 2 轮)——
 * 采纳 = 停止盲改转向诊断(read/grep/git diff),自动进 holdout lift
 * 与跨会话效能信息素。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'
import { createHash } from 'node:crypto'
import { isVerificationIntent } from '../verification-activity.js'
import { WRITE_TOOL_NAMES, extractWriteFilePaths } from '../../tools/write-tool-helpers.js'
import { renderRouteAnnotation, STALL_ROUTE_TABLE } from '../failure-taxonomy.js'

export interface DeadEndDetectorDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** stigmergy 沉积(file target dead-end 信息素,跨会话经 signal-consumer 复用) */
  deposit?: (deposit: PheromoneDeposit) => Promise<void>
  /** 证据义务状态机：死路触发时把「为什么反复失败」登记为 behavior 义务
   *  （直接进 micro_probe 阶段——read 已被证明不够），与 advisory 同一事实。 */
  obligations?: Pick<import('../obligation-tracker.js').ObligationTracker, 'upsert'>
}

/** 触发阈值:同文件 edit→verify-fail 循环次数。
 *  2026-07-28 从 2 调到 3：TDD 的 RED→edit→RED 正常节奏被 2
 *  次阈值误判为死路——写实现还不绿是完全正常的。3 次给足调试余地。 */
const CYCLE_THRESHOLD = 3

/** 测试文件匹配:这些文件的 RED 是 TDD 预期行为,不计入死路。 */
const TEST_FILE_RE = /\.test\.|\.spec\.|__tests__|_test\.|test_/

/** 诊断类工具 — expect 谓词与触发内容共用(采纳 = 转向这些工具) */
const DIAGNOSIS_TOOLS = ['read_file', 'grep', 'glob', 'semantic_search', 'lsp_goto_definition', 'lsp_find_references']

interface FileCycleState {
  /** 完成的 edit→verify-fail 循环数 */
  cycles: number
  /** 最近一次 edit 之后是否还没等到验证结果(防止一次失败计多次) */
  editPending: boolean
  /** 本会话已对该文件触发过(一次性,不重复告警) */
  fired: boolean
  /** 最近一次验证失败的 SHA-256 指纹（前 8 位 hex）。
   *  用于区分"同一个 bug 反复修" vs "不同 bug 依次修"——
   *  指纹不变 = 盲改，指纹变化 = 递进调试，重置循环计数。 */
  lastFailureFingerprint: string | null
}

function isVerifyEvent(tool: RuntimeToolEvent): boolean {
  if (tool.name === 'run_tests') return true
  if (tool.name === 'bash') {
    const cmd = (tool.input?.command as string) ?? tool.target ?? ''
    return isVerificationIntent(cmd)
  }
  return false
}

/** timeout / 环境类失败不算语义失败(与 stigmergy dead-end 收紧同判据) */
function isNonSemanticFailure(tool: RuntimeToolEvent): boolean {
  return tool.failureClass === 'timeout' || tool.failureClass === 'env_missing'
}

/**
 * 从 verify 工具的输出（resultContent）中提取失败指纹。
 * 取前 3 个失败块的 test_name + assertion 首行做 SHA-256——
 * 这些是最稳定的失败标识。跳过 traceback 行（含临时路径/行号偏移）。
 * 返回 null 表示无法提取（非 node:test 格式或无失败输出）。
 */
function extractFailureFingerprint(resultContent: string | undefined): string | null {
  if (!resultContent) return null
  // 匹配 node:test 失败格式: "✖ test_name\n  AssertionError [...]"
  const failures = resultContent.match(/✖\s+(.+?)\n\s+(?:AssertionError|Error)[^\n]*/g)
  if (!failures || failures.length === 0) return null
  const top3 = failures.slice(0, 3).join('|')
  return createHash('sha256').update(top3).digest('hex').slice(0, 8)
}

export function createDeadEndDetectorHook(
  deps: DeadEndDetectorDeps,
): PostToolRuntimeHook & { getCycleCount: (file: string) => number } {
  const files = new Map<string, FileCycleState>()

  function stateFor(file: string): FileCycleState {
    let s = files.get(file)
    if (!s) {
      s = { cycles: 0, editPending: false, fired: false, lastFailureFingerprint: null }
      files.set(file, s)
    }
    return s
  }

  const hook: PostToolRuntimeHook & { getCycleCount: (file: string) => number } = {
    phase: 'postTool',
    name: 'dead-end-detector',
    getCycleCount(file: string) { return files.get(file)?.cycles ?? 0 },
    async run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> {
      // ── 编辑:标记所有被修改文件进入"等待验证"───────────────
      if (WRITE_TOOL_NAMES.has(tool.name) && tool.success) {
        for (const file of extractWriteFilePaths(tool.name, tool.input as Record<string, unknown> | undefined)) {
          stateFor(file).editPending = true
        }
        return
      }

      if (!isVerifyEvent(tool)) return

      // ── 验证通过:全部清零(死路解除)────────────────────────
      if (tool.success) {
        // 清除磁盘上的 dead-end 信息素（strength=0 覆盖旧条目），
        // 防止后续 turn 的 intent-preview 读到残留 pheromone 误报「方向提示」。
        for (const [file] of files) {
          try {
            await deps.deposit?.({ path: file, signal: 'dead-end', strength: 0 })
          } catch { /* best-effort: 残留不影响正确性，仅失去一次性清除机会 */ }
        }
        files.clear()
        return
      }

      // 非语义失败(timeout/缺命令)不构成死路证据
      if (isNonSemanticFailure(tool)) return

      // ── 验证失败:所有 pending 文件各记一次循环 ────────────────
      // TDD 豁免:run_tests 下测试文件 RED 是预期行为,不计入死路。
      // 写测试→爆红→写实现→绿,这个循环不是盲改,不需要死路信号介入。
      const isRunTests = tool.name === 'run_tests'
      const fingerprint = extractFailureFingerprint(tool.resultContent)
      for (const [file, s] of files) {
        if (!s.editPending) continue
        s.editPending = false

        // 测试文件 + run_tests → 跳过死路计数（TDD 正常 RED）
        if (isRunTests && TEST_FILE_RE.test(file)) continue

        // 失败指纹对比：如果指纹变了 → 新问题，不是盲改，重置计数
        if (fingerprint && s.lastFailureFingerprint && fingerprint !== s.lastFailureFingerprint) {
          s.cycles = 1
        } else {
          s.cycles++
        }
        s.lastFailureFingerprint = fingerprint

        if (s.cycles >= CYCLE_THRESHOLD && !s.fired) {
          s.fired = true
          // 义务归账：盲改死路 = 「该文件的失败根因」是未证行为断言。
          // requiredAction 直接进 micro_probe（read 阶段已被死路证伪）；
          // 该文件后续验证转绿时由 applyVerificationEvent 自动关闭。
          deps.obligations?.upsert({
            family: 'behavior',
            claim: `${file} 反复「编辑→验证失败」的根因未确认`,
            targets: [file],
            risk: 'high',
            requiredAction: 'micro_probe',
          })
          deps.advisoryBus.submit({
            key: 'dead-end-file',
            priority: 0.7,
            category: 'dead_end',
            tier: 'operational',
            content: `同一文件 ${file} 已 ${s.cycles} 次「编辑→验证失败」且中间无一次通过——这是盲改信号。停止在原处继续改:先用 read_file/grep/git diff 重新诊断失败根因,或回退本轮改动换一条实现路径,或把改动拆成更小的可验证步骤。 ${renderRouteAnnotation(STALL_ROUTE_TABLE['verify-loop'])}`,
            ttl: 2,
            // 采纳 = 停止盲改转向诊断类动作(2 轮内出现 read/grep 等)
            expect: { kind: 'tool_appears', tools: DIAGNOSIS_TOOLS, withinTurns: 2 },
            channel: 'system-reminder',
          })
          // 文件级 dead-end 信息素:跨会话经 signal-consumer 复用
          try {
            await deps.deposit?.({ path: file, signal: 'dead-end', strength: 0.8 })
          } catch { /* stigmergy 沉积 best-effort */ }
        }
      }
    },
  }

  return hook
}
