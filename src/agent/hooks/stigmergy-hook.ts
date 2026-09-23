import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PheromoneDeposit, PheromoneQueryResult } from '../../context/stigmergy.js'
import { detectVirtue } from '../virtue-signals.js'
import type { VirtueContext, VirtueSignal, VirtuePendingLedger } from '../virtue-signals.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import type { AdvisoryExpectation } from '../advisory-bus.js'

/** 效用谓词 v1 映射——按美德类型构建 utilityExpect（12.1 表）。
 *  智和信不通过 readback 核销（智走自持逻辑，信走 settlement hook 直接触发），
 *  它们的 utilityExpect 永远不会被 wasSatisfiedBetween 读取——settlement hook
 *  对这两种类型有专门的判定分支。 */
function utilityExpectFor(type: VirtueSignal['type']): AdvisoryExpectation {
  switch (type) {
    case 'independent-judgment': // 仁：ask 后出现探针/写工具
      return { kind: 'tool_appears', tools: ['read_file', 'edit_file', 'grep', 'bash'], withinTurns: 2 }
    case 'proactive-verification': // 义：run_tests 后输出被消费（read/edit）
      return { kind: 'tool_appears', tools: ['read_file', 'edit_file'], withinTurns: 2 }
    case 'boundary-respect': // 礼：审批后的写操作通过后续验证——收紧为 verify_attempted（问题3修复）
      return { kind: 'verify_attempted', withinTurns: 3 }
    // 智/信：utilityExpect 不会被 readback 读取——settlement hook 有专门分支。
    // 返回最小占位（settlement drainSettled 仍需结构合法的 entry）。
    default:
      return { kind: 'tool_appears', tools: ['_unused'], withinTurns: 1 }
  }
}

export interface StigmergyRuntimeHookDeps {
  deposit: (deposit: PheromoneDeposit) => Promise<void>
  query: () => Promise<PheromoneQueryResult[]>
  getEvidenceState: () => { verifications: Array<{ status: string }> }
  setLoadedPheromones: (pheromones: PheromoneQueryResult[]) => void
  /** Accumulate stance evidence so it survives compaction. */
  recordStance?: (signal: VirtueSignal) => void
  /** Publish cross-session event to SQLite events table */
  publishEvent?: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  /** Current session ID for event attribution */
  sessionId?: string
  /** Advisory bus for positive reinforcement when virtue signals detected */
  advisoryBus?: AdvisoryBus
  /** T2c: pending 台账——检测到美德后 submit pending，由 settlement hook 核销 */
  pendingLedger?: VirtuePendingLedger
}

export function createStigmergyRuntimeHook(deps: StigmergyRuntimeHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'stigmergy-runtime',
    async run(ctx, tool) {
      const deposits: PheromoneDeposit[] = []

      if (tool.name === 'read_file' && tool.target) {
        const readCount = ctx.snapshot.recentToolHistory.filter(
          h => h.tool === 'read_file' && h.target === tool.target,
        ).length
        const hasWrite = ctx.snapshot.recentToolHistory.some(
          h => (h.tool === 'write_file' || h.tool === 'edit_file') && h.target === tool.target,
        )
        if (readCount >= 3 && !hasWrite) {
          deposits.push({ path: tool.target, signal: 'entry-point', strength: 0.4 })
        }
      }

      if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target) {
        const evidence = deps.getEvidenceState()
        const hasPassed = evidence.verifications.some(v => v.status === 'passed')
        const hasFailed = evidence.verifications.some(v => v.status === 'failed')
        if (hasPassed) {
          deposits.push({ path: tool.target, signal: 'well-tested', strength: 0.6 })
        }
        if (hasFailed) {
          deposits.push({ path: tool.target, signal: 'fragile', strength: 0.8 })
        }
      }

      if (tool.name === 'bash' && !tool.success && tool.target) {
        // Dead-end 三重收紧（会话 5158719d 噪音链修复）：
        // 1. 当前 bash 必须失败——旧逻辑在当前成功时也沉积（噪音）。
        // 2. 同 target 重复 ≥2——任务 1 后 target 有区分度，跨 target 不累计。
        // 3. 排除非语义失败（timeout=慢≠死路，environment=缺命令≠死路）。
        //    双保险：history 的 errorClass + 当前 tool 的 failureClass 两路都查。
        const isNonSemantic = (h: { errorClass?: string }) =>
          h.errorClass === 'timeout' || h.errorClass === 'environment'
        const currentNonSemantic = tool.failureClass === 'timeout' || tool.failureClass === 'env_missing'
        if (!currentNonSemantic) {
          const semanticFailures = ctx.snapshot.recentToolHistory.filter(
            h => h.tool === 'bash'
              && h.status === 'failed'
              && h.target === tool.target
              && !isNonSemantic(h),
          ).length
          if (semanticFailures >= 2) {
            deposits.push({ path: tool.target, signal: 'dead-end', strength: 0.9 })
          }
        }
      }

      // ── 美德信号（阳面）：五常映射 → positive pheromone ──
      // 万物负阴而抱阳。CVM 的 trap（阴）需要 virtue（阳）来平衡。
      // 检测到美德时 deposit positive pheromone，让信任随积累而增长。

      // 仁判定：ask 是否为确认性提问（单题 options≤1 或多题所有子题 options≤1）
      const askInput = tool.input as Record<string, unknown> | undefined
      const singleOpts = askInput?.options
      const multiQ = askInput?.questions
      const isConfirmativeAsk = Array.isArray(singleOpts)
        ? singleOpts.length <= 1
        : Array.isArray(multiQ)
          ? (multiQ as Array<{ options?: unknown[] }>).every(q => !Array.isArray(q.options) || q.options.length <= 1)
          : true

      const virtueCtx: VirtueContext = {
        toolName: tool.name,
        toolTarget: tool.target,
        toolSuccess: tool.success,
        agreedWithUser: tool.name === 'ask_user_question' ? isConfirmativeAsk : undefined,
        // 义：run_tests 在 agent 主动调用时默认视为 proactive
        userRequested: tool.name === 'run_tests' ? false : undefined,
        confidence: ctx.snapshot.vigor?.tonic ?? 0.6,
        recentToolCalls: ctx.snapshot.recentToolHistory.map(h => ({
          tool: h.tool,
          target: h.target,
          status: h.status,
        })),
        // 礼：只有真正经过审批门的写操作才触发——从 tool.approvalRequired
        // 读取真实值，不再硬编码 true（发现二修复）。
        approvalRequired: tool.approvalRequired === true ? true : undefined,
      }

      const virtueSignal = detectVirtue(virtueCtx)
      if (virtueSignal) {
        // T2c: 不再当场 record+鼓励——submit pending 到 VirtuePendingLedger，
        // 由 virtue-settlement hook 在 postTurn 核销效用后才转正。
        deps.pendingLedger?.submit({
          signal: virtueSignal,
          detectedTurn: ctx.snapshot.turn,
          utilityExpect: utilityExpectFor(virtueSignal.type),
          windowTurns: 2,
          // 智专用：记录触发觉察的原始 tool+target，settlement hook 自持逻辑用
          probeTool: virtueSignal.type === 'strategic-awareness' ? tool.name : undefined,
          probeTarget: virtueSignal.type === 'strategic-awareness' ? tool.target : undefined,
        })
      }

      for (const deposit of deposits) {
        await deps.deposit(deposit)
      }

      // Publish cross-session event for file modifications
      //
      // 覆盖缺口如实记录（2026-09-23 复审确认）：只有 write_file/edit_file 发
      // file_changed——hash_edit / apply_patch / bash 写入与 worker（子进程隔离）
      // 的编辑不产生事件，peer 侧只能靠 read-file 的被动 mtime+size 兜底（唯一
      // 漏格：同 mtime 粒度内的等长编辑）。扩展发布条件前先想清楚噪声面：bash
      // 无法可靠归因到单个文件路径，宁缺勿滥。
      if (deps.publishEvent && deps.sessionId) {
        if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target && tool.success) {
          try {
            deps.publishEvent({
              eventType: 'file_changed',
              filePath: tool.target,
              detail: `Modified by session ${deps.sessionId.slice(0, 8)}`,
              priority: 0,
            })
          } catch { /* cross-session events are best-effort */ }
        }
      }

      const pheromones = await deps.query()
      deps.setLoadedPheromones(pheromones)
    },
  }
}
