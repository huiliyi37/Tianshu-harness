/**
 * starflow tool — 星流代码级编排入口。
 *
 * 把「council 评审 → team 波次 → galaxy 攻坚」三段交给 starflow-orchestrator
 * 状态机执行（硬门禁 + 状态持久化），替代原先 /starflow 的纯 prompt 注入方案。
 * 设计原则与 galaxy 同构：
 *  - 工具 definition 字节稳定：动态内容仅在 tool result 中返回
 *  - 两阶段确认：confirm 缺省/false 只展示执行方案（零派发），true 点火
 *  - 三个子工具只消费不修改；阶段 4 交付门禁归 deliver_task，本工具只输出清单
 */

import { z } from 'zod'
import { delegationToolTimeoutMs } from '../agent/profile-registry.js'
import {
  deriveGalaxyDims,
  runStarflow,
  starflowStatePath,
  type StarflowDraftItem,
  type StarflowGalaxyDimension,
} from '../agent/starflow-orchestrator.js'
import { validateGalaxyDimensionContract } from '../agent/galaxy-contract.js'
import { buildGalaxyBudgetInputs, isReviewGalaxyDimension } from '../agent/galaxy-budget.js'
import { probeEnvFacts, formatEnvPrecheckBlock } from '../agent/env-precheck.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

const GLYPH = '🌠'

const draftItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  files: z.array(z.string()).optional(),
  revision: z.number().int().optional(),
  previousVerdict: z.literal('passed').optional(),
})

/** 与 council_convene 的 seatSchema 同构——席位覆盖透传，由 council 复验。 */
const seatSchema = z.object({
  authority: z.string().min(1),
  charter: z.string().optional(),
  tierHint: z.enum(['cheap', 'balanced', 'strong']).optional(),
  noDowngrade: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

/** 与 galaxy dimensionSchema 对齐的宽松 schema——星流不重复校验细节，
 *  维度值原样透传给 galaxy 工具，由它做完整校验（星域/profile/DP 约束）。 */
const dimensionSchema = z.object({
  name: z.string().min(1),
  objective: z.string().min(1),
  authority: z.string().optional(),
  authorities: z.array(z.string()).min(2).max(5).optional(),
  parallelism: z.enum(['expert', 'data']).optional(),
  replicas: z.number().int().min(2).max(5).optional(),
  profile: z.string().optional(),
  tierFloor: z.enum(['cheap', 'balanced', 'strong']).optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  maxTurns: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  modelOverride: z.object({ provider: z.string(), model: z.string() }).optional(),
})

const inputSchema = z.object({
  objective: z.string().min(1),
  draftItems: z.array(draftItemSchema).optional(),
  galaxyDims: z.array(dimensionSchema).min(2).max(5).optional(),
  rounds: z.union([z.literal(1), z.literal(2)]).optional(),
  autoReview: z.boolean().optional(),
  seats: z.array(seatSchema).optional(),
  confirm: z.boolean().optional(),
  resume: z.boolean().optional(),
})

/** timeoutMs is evaluated before inputSchema, so keep its plan projection defensive. */
function timeoutDraftItems(value: unknown): StarflowDraftItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is StarflowDraftItem => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Record<string, unknown>
    return typeof candidate.id === 'string'
      && typeof candidate.title === 'string'
      && typeof candidate.detail === 'string'
  })
}

function timeoutGalaxyDims(value: unknown): StarflowGalaxyDimension[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((dimension): dimension is StarflowGalaxyDimension => {
    if (!dimension || typeof dimension !== 'object') return false
    const candidate = dimension as Record<string, unknown>
    return typeof candidate.name === 'string' && typeof candidate.objective === 'string'
  })
}

export interface StarflowToolDeps {
  councilTool: Tool
  teamTool: Tool
  galaxyTool: Tool
  cwd: string
}

function formatProposal(
  objective: string,
  rounds: number,
  dims: StarflowGalaxyDimension[],
  derivedFromDrafts: boolean,
  statePath: string,
  envBlock = '',
): string {
  const lines: string[] = [
    `${GLYPH} 星流执行方案`,
    '',
    `目标：${objective}`,
    '',
    '将执行的阶段（状态机硬门禁串联，任一不过即 blocked 并停止）：',
    `  1. council 评审 — 多席审查计划草稿，产出密封执行契约（rounds: ${rounds}）`,
    '  2. team 波次 — 按契约分波派发 worker；失败自动回 council 复议一次，再败即 blocked',
  ]
  if (dims.length >= 2) {
    lines.push(`  3. galaxy 攻坚 — ${dims.length} 个维度并行${derivedFromDrafts ? '（从 draftItems 派生）' : ''}：${dims.map(d => d.name).join('、')}`)
  } else {
    lines.push('  3. galaxy 攻坚 — 跳过（无显式 galaxyDims，也无法从 draftItems 派生出 ≥2 个维度）')
  }
  lines.push(
    '  4. 交付门禁 — 输出交付检查清单，提示调用 deliver_task（硬门禁归 deliver_task）',
    '',
  )
  // 环境预检（2026-08-18）：确认前必见——playtest 教训：10GB 构建块确认后才
  // 发现磁盘只剩 1.3GiB，被迫降级重提。探测失败块缺席，绝不阻断提案。
  if (envBlock) lines.push(envBlock, '')
  lines.push(
    `点火后将持久化到：${statePath}（blocked/中断后可用 resume: true 续跑，已过阶段不重跑）`,
    '',
    '调用 starflow({..., confirm: true}) 点火执行。',
  )
  return lines.join('\n')
}

export function createStarflowTool(deps: StarflowToolDeps): Tool {
  return {
    definition: {
      name: 'starflow',
      description: `星流编排——把复杂任务交给状态机串起 council 评审 → team 波次 → galaxy 攻坚三段，阶段间硬门禁兜底（评审未执行/被否决、波次失败、攻坚未通过都会 blocked 停止并给出人话解释），状态落盘支持 resume 续跑。

## 何时使用
- 用户走 /starflow 或明确要求「星流」全流程（评审+执行+攻坚一体）
- 复杂工程任务需要评审-执行-攻坚的确定性串联，而不是模型自觉走流程

## 调用协议（两阶段）
1. 首次调用 starflow({objective, draftItems?, galaxyDims?, confirm: false}) 展示执行方案，等待用户确认
2. 用户确认后调用 starflow({..., confirm: true}) 点火执行

## 参数要点
- draftItems：需求澄清后的计划草稿（id/title/detail/files），喂给 council 评审；galaxyDims 缺省时也从它派生维度。修订重提时：未变条目保持 revision 不变并标 previousVerdict:'passed'（starflow 会在评审渲染中标注「沿用前轮通过结论」，不重审）；修订条目 bump revision 时**必须同时移除 previousVerdict**——两字段同现的条目被视为已修订，重新评审不沿用
- seats：council 席位覆盖（同 council_convene 的 seats，authority/charter/tierHint/provider/model）。**修订轮推荐只召回「上轮否决的席位 + 与修订点相关的域席」，而非默认全量**——成本立降且否决拦截力不减
- galaxyDims：显式攻坚维度（2-5 个，结构同 galaxy 工具的 dimensions）；缺省按 draftItems 派生，派生不出 ≥2 个则跳过攻坚阶段
- rounds：council 辩论轮数（1-2，默认 1；高风险任务传 2）。⚠ rounds≥2 受 councilMultiRound Pro 门钳制——Basic 未启用时降级单轮继续（不拒绝），输出标注「已按单轮执行——Pro 门」
- resume：blocked/中断后传 true 从状态文件续跑，已过门禁的阶段不重复执行

## 出口
全过后输出交付检查清单——调用 deliver_task 完成交付门禁（未运行 = 未验证）。`,
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '星流总目标——需求澄清后的完整任务描述。' },
          draftItems: {
            type: 'array',
            description: '计划草稿条目（供 council 评审；galaxyDims 缺省时按它派生攻坚维度）。修订重提时未变条目标 previousVerdict:"passed"（渲染为沿用前轮通过结论，不重审）。',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                detail: { type: 'string' },
                files: { type: 'array', items: { type: 'string' }, description: '该条目涉及的文件（team 波次分组 / galaxy 维度 scope）。' },
                revision: { type: 'integer', description: '修订记账：修订重提时 bump；未变条目保持原值。' },
                previousVerdict: { type: 'string', enum: ['passed'], description: '上一轮评审已通过且本轮未变——评审渲染中标注「沿用前轮通过结论」，除非与其他条目冲突否则不重审。' },
              },
              required: ['id', 'title', 'detail'],
            },
          },
          galaxyDims: {
            type: 'array',
            description: '显式 galaxy 攻坚维度（2-5 个，结构同 galaxy 工具的 dimensions）。缺省时从 draftItems 派生。',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '维度标识（如 frontend / review / docs）' },
                objective: { type: 'string', description: '该维度的具体执行目标' },
                authority: { type: 'string', description: '该维度使用的星域 id（单星域，与 authorities 二选一）。' },
                authorities: { type: 'array', items: { type: 'string' }, description: '多星域独立只读视角（与 authority 二选一）。' },
                parallelism: { type: 'string', enum: ['expert', 'data'], description: 'expert 单分片派发；data 独立只读副本。' },
                replicas: { type: 'integer', minimum: 2, maximum: 5, description: '仅 data 模式：独立副本数。' },
                profile: { type: 'string', description: 'worker profile。省略时按维度名推导。' },
                tierFloor: { type: 'string', enum: ['cheap', 'balanced', 'strong'], description: '模型档位硬地板。' },
                files: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的文件路径。' },
                symbols: { type: 'array', items: { type: 'string' }, description: '可选，聚焦的符号。' },
                maxTurns: { type: 'integer', description: '该维度 worker 的最大轮次。' },
                timeoutMs: { type: 'integer', description: '该维度 worker 的超时预算。' },
                modelOverride: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } }, description: '可选，为该维度指定专用 provider/model。' },
              },
              required: ['name', 'objective'],
            },
            minItems: 2,
            maxItems: 5,
          },
          rounds: { type: 'number', enum: [1, 2], description: 'council 辩论轮数（默认 1；高风险任务传 2 启用反驳轮）。⚠ rounds≥2 受 councilMultiRound Pro 门钳制——Basic 未启用时降级单轮继续（不拒绝），输出标注「已按单轮执行——Pro 门」。' },
          autoReview: { type: 'boolean', default: true, description: 'Whether Galaxy adds the automatic review wave; defaults to true.' },
          seats: {
            type: 'array',
            description: 'council 席位覆盖（同 council_convene 的 seats，透传到首轮与复议轮）。修订轮推荐只召回「上轮否决的席位 + 与修订点相关的域席」，而非默认全量。',
            items: {
              type: 'object',
              properties: {
                authority: { type: 'string', description: '星域 id（每席必须不同）。' },
                charter: { type: 'string', description: '席位章程——该席本次评审的专属职责。' },
                tierHint: { type: 'string', enum: ['cheap', 'balanced', 'strong'], description: '模型档位提示。' },
                noDowngrade: { type: 'boolean', description: '禁止降档。' },
                provider: { type: 'string', description: '单席位 provider（与 model 配对使用）。' },
                model: { type: 'string', description: '单席位模型（必须存在于该 provider）。' },
              },
              required: ['authority'],
            },
          },
          confirm: { type: 'boolean', description: '用户已确认星流方案。首次调用不带此参数以展示方案并请求确认。' },
          resume: { type: 'boolean', description: '从 .rivet/starflow/ 状态文件续跑——已过门禁的阶段不重复执行。' },
        },
        required: ['objective'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) {
        return { content: `星流参数错误：${parsed.error.message}`, isError: true, errorKind: 'format_error' }
      }
      const { objective, draftItems, galaxyDims, rounds, seats, autoReview, confirm, resume } = parsed.data

      // galaxy 维度的最终来源：显式 galaxyDims 优先，缺省从 draftItems 派生。
      const dims: StarflowGalaxyDimension[] = galaxyDims ?? deriveGalaxyDims(draftItems)

      // Fail before council/team when the downstream Galaxy plan is ambiguous.
      // Codex validates spawn arguments before creating children; Starflow
      // should not spend two earlier phases on a plan that Galaxy rejects.
      const contractIssues = validateGalaxyDimensionContract(dims)
      if (contractIssues.length > 0) {
        return {
          content: [
            'Starflow Galaxy contract validation failed:',
            ...contractIssues.map(issue => '- dimension #' + (issue.dimensionIndex + 1) + ': ' + issue.message),
          ].join('\n'),
          isError: true,
          errorKind: 'format_error',
        }
      }

      // ── Phase 1: Proposal（confirm 缺省/false）────────────────────
      // 纯静态方案展示——不调任何子工具（零派发），与 galaxy proposal 同构。
      if (!confirm) {
        return {
          content: formatProposal(objective, rounds ?? 1, dims, !galaxyDims, starflowStatePath(deps.cwd, objective, params.sessionId), formatEnvPrecheckBlock(probeEnvFacts(deps.cwd))),
          uiContent: `${GLYPH} 星流方案 · ${dims.length >= 2 ? `${dims.length} 维度` : '无攻坚维度'}`,
        }
      }

      // ── Phase 2: Execute ──────────────────────────────────────────
      const run = await runStarflow(
        { councilTool: deps.councilTool, teamTool: deps.teamTool, galaxyTool: deps.galaxyTool, cwd: deps.cwd, params },
        { objective, ...(draftItems ? { draftItems } : {}), ...(galaxyDims ? { galaxyDims } : {}), ...(rounds ? { rounds } : {}), ...(seats && seats.length > 0 ? { seats } : {}), ...(autoReview === undefined ? {} : { autoReview }), ...(resume ? { resume } : {}) },
      )
      const blocked = run.state.phase !== 'done'
      return {
        content: run.report,
        orchestration: {
          kind: 'starflow',
          runId: run.state.runId,
          phase: run.state.phase,
          done: !blocked,
          resumed: run.resumed ?? Boolean(resume),
          revision: run.state.revision,
          phases: Object.fromEntries(
            Object.entries(run.state.phases).map(([phase, record]) => [phase, {
              status: record?.status,
              at: record?.at,
              ...(record?.elapsedMs === undefined ? {} : { elapsedMs: record.elapsedMs }),
            }]),
          ) as import('../agent/orchestration-outcome.js').StarflowOrchestrationOutcome['phases'],
        },
        // blocked 是工具管线的失败信号（同 galaxy DP quorum 未达成的 isError 先例）。
        isError: blocked || undefined,
        uiContent: `${GLYPH} 星流 · ${blocked ? `受阻于 ${run.state.phase} 阶段` : '全阶段通过，待交付'}`,
      }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    // 外层超时必须覆盖三阶段串行预算（同 galaxy.ts 思路：delegationToolTimeoutMs
    // 按 profile/波次/续跑倍率算单段，三段相加）。galaxy 维度未知时按 2 维估。
    timeoutMs: (params) => {
      const turnCount = params?.sessionTurnCount
      const councilMs = delegationToolTimeoutMs(turnCount, [undefined, undefined, undefined], { taskCount: 3 })
      // team worker 多为写工（patcher），按 3 个写工估波次预算。
      const teamMs = delegationToolTimeoutMs(turnCount, ['patcher', 'patcher', 'patcher'], { taskCount: 3 })
      // runStarflow derives the same dimensions when galaxyDims is omitted;
      // use that normalized plan so the outer timeout covers the actual
      // EP/DP fan-out instead of an arbitrary two-worker fallback.
      const rawDims = timeoutGalaxyDims(params?.input?.galaxyDims)
      const draftItems = timeoutDraftItems(params?.input?.draftItems)
      const dims = rawDims ?? deriveGalaxyDims(draftItems)
      const executableDims = dims.length >= 2 ? dims : []
      const budgetInputs = buildGalaxyBudgetInputs(executableDims)
      const galaxyMs = budgetInputs.profiles.length > 0
        ? delegationToolTimeoutMs(turnCount, budgetInputs.profiles, {
            taskCount: budgetInputs.profiles.length,
            requestedTimeoutMs: budgetInputs.requestedTimeoutMs,
            tierFloors: budgetInputs.tierFloors,
          })
        : 0
      // autoReview is an additional serial wave only when Galaxy does not
      // already contain an explicit review/verify dimension.
      const autoReview = (params?.input?.autoReview as boolean | undefined) ?? true
      const hasExplicitReview = executableDims.some(d => isReviewGalaxyDimension(d.name))
      const reviewMs = autoReview && executableDims.length > 0 && !hasExplicitReview
        ? delegationToolTimeoutMs(turnCount, ['reviewer'], { taskCount: 1 })
        : 0
      return councilMs + teamMs + galaxyMs + reviewMs
    },
  }
}
