import type { Tool, ToolCallParams } from './types.js'
import { decomposeObjective, renderTaskGraphSummary } from '../agent/task-planner.js'
import { taskGraphToUnifiedPlan, unifiedPlanToTeamTasks, serializeUnifiedPlan, renderUnifiedPlanSummary, validateUnifiedPlan } from '../agent/unified-plan.js'
import type { DelegationCoordinator } from '../agent/coordinator.js'
import { executePlanWaves, type PlanExecutorDeps, type PlanExecutorWavesResult } from '../agent/plan-executor.js'
import { extractRequiredSkills } from '../agent/skill-gate.js'
import { storePlan } from '../agent/plan-store.js'
import { classifyTaskDepth, type TaskContract } from '../context/task-contract.js'
import { setTodos } from './todo.js'
import type { TodoItem } from './todo-store.js'
import { readFile } from 'node:fs/promises'
import type { TaskGraph, TaskGraphNode } from '../agent/task-graph.js'

const BASE_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-28-plan-methodology-base.md'
const LIGHTWEIGHT_TEMPLATE_PATH = 'docs/superpowers/plans/2026-06-14-plan-methodology-lightweight.md'

// ── Plan file detection & checklist parsing (plan_task → team_orchestrate fast path) ──

// .rivet/plans/ 是 plan_submit 批准计划的落盘位置（kickoff 明确指示走
// plan_task(execute=true)）——此前漏在识别之外，批准计划会绕过 checklist
// 快速路径与技能门禁（2026-07-25 技能门禁波补齐）。
const PLAN_PATH_RE = /(?:\.rivet\/(?:knowledge|plans)\/|docs\/superpowers\/plans\/)[^\s]+\.md/

/** Extract a plan file path from objective text or files array.
 *  Returns null if no recognized plan file path is found. */
export function extractPlanPath(objective: string, files?: string[]): string | null {
  const match = objective.match(PLAN_PATH_RE)
  if (match) return match[0]
  if (files) {
    for (const f of files) {
      if (PLAN_PATH_RE.test(f)) return f
    }
  }
  return null
}

/** Parse unchecked checklist items from Markdown.
 *  Each `- [ ]` line becomes one item with text + extracted file paths.
 *  Checked items (`- [x]`) are skipped. */
export function parseChecklistItems(markdown: string): Array<{ text: string; files: string[] }> {
  const items: Array<{ text: string; files: string[] }> = []
  for (const line of markdown.split('\n')) {
    const m = line.match(/^- \[ \] (.+)$/)
    if (!m) continue
    const text = m[1]!.trim()
    const fileRefs = text.match(/`([^`]+\.\w+)`/g) ?? []
    const files = fileRefs.map(f => f.replace(/`/g, ''))
    items.push({ text, files })
  }
  return items
}

/**
 * 章节感知解析（用户指令：不再按 checklist 逐项切分，按章节 wave 切是最低限度）。
 *
 * 按 H2/H3 标题分组，每个含 ≥1 个 `- [ ]` 项的章节产出一个任务分组。
 * 章节文件集合 = 章节内所有行（标题+正文+checklist 项）的反引号路径，去重。
 * 无 H2/H3 章节结构 → 返回空数组，由调用方路由到通用规划（decomposeObjective）
 * ——不回退逐项 checklist 切分（2026-07-26 用户指令）。
 */
export function parseChecklistSections(markdown: string): Array<{
  heading: string
  items: Array<{ text: string; files: string[] }>
  files: string[]
}> {
  const sections: Array<{ heading: string; body: string[] }> = []
  let current: { heading: string; body: string[] } | null = null
  for (const line of markdown.split('\n')) {
    const h = line.match(/^(#{2,3})\s+(.+)$/)
    if (h) {
      current = { heading: h[2]!.trim(), body: [] }
      sections.push(current)
    } else if (current) {
      current.body.push(line)
    }
  }

  const out: Array<{
    heading: string
    items: Array<{ text: string; files: string[] }>
    files: string[]
  }> = []
  for (const sec of sections) {
    // 章节内 checklist 项：复用 parseChecklistItems 的逐行提取逻辑（作用域限定章节 body）
    const items = parseChecklistItems(sec.body.join('\n'))
    if (items.length === 0) continue // 无 checklist 的章节（验证命令/反证/后续）不生成任务
    // 章节文件集合 = 章节内所有行（含标题）的反引号路径。严格口径：
    // ① 多路径反引号（如验证命令 `npm exec -- tsx --test a.test.ts b.test.ts`）
    //    按空白/逗号拆开，逐段校验；② 只收 src|docs|specs|test|tests|.rivet|desktop
    //    前缀的路径——命令文本、非路径反引号不进 scope（scope 直接进 worker 写范围）。
    const allLines = [sec.heading, ...sec.body]
    const files = [
      ...new Set(
        allLines.flatMap(line =>
          (line.match(/`([^`]+\.\w+)`/g) ?? [])
            .map(f => f.replace(/`/g, ''))
            .flatMap(raw => raw.split(/[,，、;；\s]+/))
            .map(c => c.replace(/[(),.;:]+$/g, '').trim())
            .filter(c => /^(src|docs|specs|test|tests|\.rivet|desktop)\//.test(c)),
        ),
      ),
    ]
    out.push({ heading: sec.heading, items, files })
  }
  return out
}

/** 章节感知建图：每个含 checklist 的章节 → 一个 patcher 任务（正交分片）。
 *  任务 objective 携带章节标题 + 全部 checklist 项，worker 逐条执行。 */
function buildTasksFromSections(
  sections: Array<{
    heading: string
    items: Array<{ text: string; files: string[] }>
    files: string[]
  }>,
  objective: string,
): TaskGraph {
  const nodes: TaskGraphNode[] = sections.map((sec, i) => {
    const checklistText = sec.items.map(it => `- [ ] ${it.text}`).join('\n')
    return {
      id: `P${i + 1}`,
      title: sec.heading.slice(0, 80),
      objective: `${sec.heading}\n\n${checklistText}\n\n只执行本 task，不扩展范围，不重写计划。`,
      profile: 'patcher' as const,
      kind: 'patch_proposal' as const,
      files: sec.files,
      dependsOn: [],
      riskTier: 'medium' as const,
    }
  })
  return { mission: objective, nodes, createdAt: Date.now() }
}

// ── Methodology guidance ──

/**
 * Build a methodology guidance block for injection into plan_task output.
 * Pure function — never writes to static tool definitions (prefix-cache safe).
 */
function buildMethodologyGuidance(objective: string, files: string[]): string {
  const contract: TaskContract = {
    id: 'plan-task',
    objective,
    scope: { mentionedFiles: files },
    constraints: [],
    successCriteria: [],
    status: 'planning',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
  }
  const depth = classifyTaskDepth(contract)
  // 默认使用 Superpowers-based 基础模板；只有明确极小（unit 深度 + 不超过一个文件）才降级为轻量版。
  const useLightweight = depth === 'unit' && files.length <= 1
  const templatePath = useLightweight ? LIGHTWEIGHT_TEMPLATE_PATH : BASE_TEMPLATE_PATH
  const templateType = useLightweight ? '轻量版（5阶段）' : '基础模板（原生计划流程）'
  const note = useLightweight
    ? '本任务 scope 内聚，单模块边界内变更，聚焦核心改动与验证即可。'
    : '默认使用基础模板，强制四条纪律：① 至少一张 Mermaid 图；② TDD RED→GREEN；③ 探针先行；④ 瑶光反证（真实输入复现、取 exit code、方案 GREEN≠落地 GREEN）。安全/权限/沙箱/多 enforcement gate 任务追加安全附录。'

  return [
    '## 计划方法论路由',
    '',
    `任务深度: ${depth} | 推荐模板: ${templateType}`,
    `模板路径: ${templatePath}`,
    '',
    note,
    '',
    '如用户已显式指定模板，以用户指定为准。',
  ].join('\n')
}

export function createPlanTaskTool(deps: {
  getCoordinator: () => DelegationCoordinator | null
  /** Shared closed-loop execution kernel (same one team_orchestrate uses). */
  getExecutorDeps: () => PlanExecutorDeps
  getSessionTurn?: () => number | undefined
  getSessionId?: () => string | undefined
  /** 多会话隔离：写入本会话的 TodoStore。缺省回退全局 setTodos（defaultStore）。 */
  writeTodos?: (todos: TodoItem[]) => void
}): Tool {
  return {
    definition: {
      name: 'plan_task',
      description: `把高层目标分解成 TaskGraph DAG——水平正交分片（horizontal orthogonal shards），可选按波次逐波执行。

适用于需要结构化规划的多步骤工作（重构、功能开发）。每个分片是完整自包含的单元（实现 + 跑 tsc/lint/相关测试到绿），由一个有能力的 flash 端到端负责——不是垂直角色流水线（不拆独立的 lint/type/import/test/verify 步骤）。列出范围文件让规划器按模块切出正交分片以并行执行；同模块文件留在同一分片。
设 execute: true 自动完成所有可推进波次——共享多波驱动 executePlanWaves 从 wave 0 逐波推进至计划末波或停止判据（与 team_orchestrate 同一执行路径）。worker 直接写入共享工作区——用 git diff 审查聚合结果。

输出为 UnifiedPlan JSON——传给 team_orchestrate 的 planJson 参数做多波次续跑。`,
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '要分解的高层目标' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '范围文件。列出涉及的文件/模块，让规划器按模块切正交分片，而不是揉成一个整块。',
          },
          execute: { type: 'boolean', description: '生成后立即执行计划（默认 false）' },
        },
        required: ['objective'],
      },
    },

    async execute(params: ToolCallParams) {
      const objective = String(params.input.objective ?? '').trim()
      if (!objective) {
        return { content: '错误：objective 必填', isError: true }
      }

      const files = Array.isArray(params.input.files)
        ? (params.input.files as string[]).filter(f => typeof f === 'string')
        : undefined

      // Step 1: plan file detection fast-path — when objective/files reference a
      // Markdown plan, parse its checklist directly into patcher tasks instead of
      // running the generic decomposeObjective pipeline (scout→architect→…).
      let graph: TaskGraph
      // 技能门禁：读到计划文件时提取点名 skill，透传给 executePlan 入口硬拦
      // （tasks 路径没有 planMarkdown，executePlan 无从自行提取）。
      let requiredSkills: string[] | undefined
      const planPath = extractPlanPath(objective, files)
      if (planPath) {
        try {
          const markdown = await readFile(planPath, 'utf-8')
          requiredSkills = extractRequiredSkills(markdown)
          // 章节感知切分（2026-07-26 用户指令：不再按 checklist 逐项切）：
          // 有 H2/H3 章节 → 每章节一个正交任务；无章节 → 通用规划路径。
          // 逐项 checklist 切分已移除——碎片化会导致同文件任务串行与
          // scope.files 缺失（coordinator 派发闸拦截）。
          const sections = parseChecklistSections(markdown)
          if (sections.length > 0) {
            graph = buildTasksFromSections(sections, objective)
          } else {
            graph = decomposeObjective({ objective, files })
          }
        } catch {
          // File missing or unreadable → fallback
          graph = decomposeObjective({ objective, files })
        }
      } else {
        graph = decomposeObjective({ objective, files })
      }

      // Populate todo store and seed the PlanExecutionTrace baseline immediately.
      // Skip the "verify" node (task-graph.ts always appends one) — it's a post-hoc
      // gate, not a user-facing step.
      const leafNodes = graph.nodes.filter(n => n.kind !== 'verify')
      if (leafNodes.length > 0) {
        const todoItems: TodoItem[] = leafNodes.map(n => ({
          id: n.id,
          content: n.title,
          status: 'pending' as const,
        }))
        ;(deps.writeTodos ?? setTodos)(todoItems)
        params.onPlanSteps?.(todoItems.map(t => ({ id: t.id, content: t.content, status: t.status })))
      }

      // Step 2: convert to UnifiedPlan
      const plan = taskGraphToUnifiedPlan(graph)

      // Step 3: validate
      const validation = validateUnifiedPlan(plan)
      if (!validation.valid) {
        const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
        return {
          content: `计划校验失败：\n${errors.map(e => `  - ${e}`).join('\n')}\n\n${renderTaskGraphSummary(graph)}`,
          isError: true,
        }
      }

      // Bridge: store the serialized plan so team_orchestrate can auto-consume
      // it without the model copy-pasting JSON between tool calls.
      storePlan(serializeUnifiedPlan(plan), params.sessionId)

      if (params.input.execute !== true) {
        // Return JSON + human-readable summary with methodology guidance
        const json = serializeUnifiedPlan(plan)
        const guidance = buildMethodologyGuidance(objective, files ?? [])
        const todoNote = leafNodes.length > 0
          ? `\n\n✅ Todo list 已同步 (${leafNodes.length} 项)。用 \`todo read\` 查看,完成后用 \`todo write\` 标记进度。`
          : ''
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\n${guidance}${todoNote}\n\n---\n## UnifiedPlan JSON（作为 planJson 传给 team_orchestrate）\n\`\`\`json\n${json}\n\`\`\``,
        }
      }

      // Step 4: execute via the shared multi-wave driver — the SAME closed loop
      // as team_orchestrate (auto-advancing every advanceable wave), minus the
      // review gate. plan_task's post-execution path is the commit flow, whose
      // post-commit auto review gate already covers the diff; running a
      // review-squadron here too would double-review. So reviewGate:false —
      // plan_task still gets dispatch + scope-health + telemetry +
      // reward/episode closure, just no review-squadron dispatch.
      const coordinator = deps.getCoordinator()
      if (!coordinator) {
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\n错误：当前上下文无可用 coordinator，无法执行`,
          isError: true,
        }
      }

      const tasks = unifiedPlanToTeamTasks(plan)
      try {
        if (params.onOutput) {
          params.onOutput(`\n📋 计划已分解为 ${tasks.length} 个任务，正在派发 worker 执行…\n`)
        }
        // executePlanWaves 按 startWave 逐波推进、自动判定停止、聚合每波结果；
        // 中间波不提前触发末波 review（isLastWave 由真实 wave 序号判定）。
        const { run }: PlanExecutorWavesResult = await executePlanWaves(
          {
            mode: 'standard',
            objective,
            tasks,
            requiredSkills,
            startWave: 0,
            autoAdvance: true,
            maxParallel: 3,
            sessionId: params.sessionId,
            parentTurnId: `plan:${params.toolUseId ?? Date.now()}`,
            reviewDepth: params.reviewDepth ?? 0,
            cwd: params.cwd,
            abortSignal: params.abortSignal,
            // Review handled by the post-commit auto gate — see comment above.
            reviewGate: false,
            onProgress: params.onOutput
              ? (completed, total) => {
                  const done = Math.max(0, Math.min(completed, total))
                  params.onOutput!(`✦ plan progress: ${done}/${total} workers done\n`)
                }
              : undefined,
            onWorkerSettled: params.onWorkerActivity
              ? (result) => {
                  // status×failureReason 矩阵：blocked（含 caller_aborted 取消 /
                  // 环境阻断）不得伪装成 completed，如实透传给活动带。
                  const status = result.status === 'failed' ? 'failed'
                    : result.status === 'blocked' ? 'blocked'
                    : result.status === 'escalated' ? 'escalated'
                    : 'completed'
                  params.onWorkerActivity!({
                    workOrderId: result.workOrderId,
                    parentToolId: params.toolUseId,
                    status,
                  })
                }
              : undefined,
          },
          deps.getExecutorDeps(),
        )
        const guidance = buildMethodologyGuidance(objective, files ?? [])
        const todoNote = leafNodes.length > 0
          ? `\n\n✅ Todo list 已同步 (${leafNodes.length} 项)。`
          : ''
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\n${guidance}${todoNote}\n\n${run.summary.packet}${run.notes.scopeHealthNote}${run.notes.waveGateNote}${run.notes.deliverySynthesis}`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `${renderUnifiedPlanSummary(plan)}\n\n执行失败：${msg}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    // Align with team_orchestrate (600s): execute:true runs the full plan
    // executor loop (multi-worker dispatch + gates + review), and 120s
    // (the tool default) physically cannot complete it. T2 fix, 2026-07-29.
    timeoutMs: (params?: ToolCallParams) => params?.input?.execute === true ? 600_000 : 120_000,
  }
}
