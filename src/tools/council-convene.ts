import { z } from 'zod'
import type { AggregationPolicy } from '../agent/work-order.js'
import type { CoordinatorRun, DelegationRequest, WorkerActivityEvent } from '../agent/coordinator.js'
import { runCouncil, runCouncilDebate, buildSeatObjective, type CouncilDeps } from '../agent/council/council-orchestrator.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { summarizeCouncilPlan } from '../agent/council/council-render.js'
import { encodeCouncilPanel, type CouncilPanelModel } from '../tui/council-panel-model.js'
import { DEFAULT_COUNCIL_SEATS, THREE_PILLAR_COUNCIL_SEATS, mergeSeatOverrides, type CouncilSeat, type CouncilRoutingShadowEvent } from '../agent/council/council-routing.js'
import { isCouncilEnabled } from '../agent/council/council-gate.js'
import { buildCouncilSessionEvent, type CouncilSessionEvent } from '../agent/council/council-telemetry.js'
import type { PlanItem } from '../agent/council/council-plan.js'
import { compileCouncilPlan } from '../agent/council/council-to-plan.js'
import { sealPlan } from '../agent/council/council-seal.js'
import { extractObligations, attachObligations } from '../agent/council/council-obligations.js'
import { runWaveReconvene, type ReconveneTaskRef } from '../agent/council/council-reconvene.js'
import { serializeUnifiedPlan, unifiedPlanToTeamTasks } from '../agent/unified-plan.js'
import { storePlan } from '../agent/plan-store.js'
import { executePlan, type PlanExecutorDeps } from '../agent/plan-executor.js'
import { createDelegationActivityMapper, terminalActivity } from './worker-activity-stream.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

/** Coordinator surface the council tool needs — only `delegateBatch` drives the
 *  single-round seat fanout. Telemetry/shadow recorders are optional旁路.
 *  `executor` (A4) carries the full plan-execution deps so autoExecute runs the
 *  same closed loop (waves + review gate + wave gate + checkpoint) as
 *  team_orchestrate instead of a bare delegateBatch. */
export interface CouncilConveneCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
    onWorkerSettled?: (result: CoordinatorRun['results'][number]) => void,
  ): Promise<CoordinatorRun>
  getSessionId?: () => string | undefined
  recordRoutingShadow?: (event: CouncilRoutingShadowEvent) => void
  recordCouncilSession?: (event: CouncilSessionEvent) => void
  executor?: PlanExecutorDeps
}

// DEFAULT_COUNCIL_SEATS 下沉至 council-routing.ts（CouncilSeat 定义所在），此处
// re-export 保持既有 `import { DEFAULT_COUNCIL_SEATS } from '../council-convene.js'` 调用面。
export { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'

const planItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  files: z.array(z.string()).optional(),
})

const seatSchema = z.object({
  authority: z.string().min(1),
  charter: z.string().optional(),
  tierHint: z.enum(['cheap', 'balanced', 'strong']).optional(),
  noDowngrade: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

const inputSchema = z.object({
  objective: z.string().min(1),
  draftItems: z.array(planItemSchema).optional(),
  seats: z.array(seatSchema).optional(),
  rounds: z.number().int().min(1).max(2).optional(),
  /** Phase 2 三柱模式（council max）：席位强制三柱对抗结构——扩张柱（破军/天机）×
   *  约束柱（天权/华盖）× 平衡柱（瑶光）。配置席位（agent.council.seats）按
   *  authority 沿用专属模型绑定；显式 seats 参数仍然优先。 */
  pillars: z.boolean().optional(),
  /** When true, automatically dispatch the council-approved plan to team_orchestrate.
   *  Saves a model round-trip — the council result directly triggers execution
   *  instead of waiting for the model to extract planJson and call team_orchestrate. */
  autoExecute: z.boolean().optional(),
  /** 两阶段确认（星河收编 #7）：显式 confirm:false → 只返回席位分配方案不执行；
   *  confirm:true → 点火。缺省 undefined → 直接执行（现状行为，向后兼容）。 */
  confirm: z.boolean().optional(),
})
export function createCouncilConveneTool(
  coordinator: CouncilConveneCoordinator,
  /** Configured default seats (agent.council.seats). When non-empty, used as the
   *  default council instead of DEFAULT_COUNCIL_SEATS; per-call `seats` still wins. */
  defaultSeats?: CouncilSeat[],
  options?: {
    /** Pro gate: rounds≥2（反驳/辩论轮）仅 Pro 可用，未启用时降级单轮。缺省 true
     *  以保持直接构造方（测试等）行为不变；bootstrap 按 pro-license 传真值。 */
    multiRoundEnabled?: boolean
  },
): Tool {
  return {
    definition: {
      name: 'council_convene',
      description:
        '召集星域多席审查（council）评审计划草稿。默认单轮咨询；传 rounds:2+ 启用反驳/辩论轮（第 2 轮仅在第 1 轮暴露冲突时触发）。向各席位专家 fanout（仅咨询，不执行），确定性裁决，返回可审计的 Markdown 计划。传 autoExecute:true 自动把批准的计划派发给 team_orchestrate——审查后立即执行，省去一次模型往返。成本警示：多席模型并行调用，token 开销显著高于普通子代理——确实需要多视角评审的方案才召集，日常改动的审查走 review 门即可。COUNCIL=0 时禁用。',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: '要评审的计划目标。' },
          draftItems: {
            type: 'array',
            description: '可选的草稿计划条目，提交给 council 评审。',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                detail: { type: 'string' },
                files: { type: 'array', items: { type: 'string' }, description: '该条目涉及的文件（用于 team 波次分组）。' },
              },
              required: ['id', 'title', 'detail'],
            },
          },
          seats: {
            type: 'array',
            description: '可选的席位覆盖。默认 tianquan/tianfu/tianxuan（或配置中的 agent.council.seats）。为席位设 provider+model 可用专属模型运行该席（异构 council）。',
            items: {
              type: 'object',
              properties: {
                authority: { type: 'string' },
                charter: { type: 'string' },
                tierHint: { type: 'string', enum: ['cheap', 'balanced', 'strong'] },
                noDowngrade: { type: 'boolean' },
                provider: { type: 'string', description: '单席位 provider（必须存在于 config.provider.providers）。与 model 配对使用。' },
                model: { type: 'string', description: '单席位模型（必须存在于该 provider）。与 provider 配对使用。' },
              },
              required: ['authority'],
            },
          },
          rounds: { type: 'number', description: '最大辩论轮数（1-2，默认 1 = 单轮）。传 2 启用反驳轮；第 2 轮仅在第 1 轮暴露冲突时触发。' },
          pillars: { type: 'boolean', description: '为 true 时启用三柱旗舰议事会（council max）：扩张柱（破军激进+天机质疑）× 约束柱（天权称量+华盖否决）× 平衡柱（瑶光合成裁决），共 5 席制度化对抗。最复杂的工程任务用它。显式 seats 参数优先于此模式。' },
          autoExecute: { type: 'boolean', description: '为 true 时，自动把 council 批准的计划派发给 team_orchestrate。省去一次模型往返——计划在审查后立即执行，无需手工提取。' },
          confirm: { type: 'boolean', description: '两阶段确认（收编 #7）：显式 false → 只展示席位分配方案不执行；true → 点火。缺省 → 直接执行（兼容）。' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      if (!isCouncilEnabled()) {
        return {
          content: 'council_convene 已禁用（COUNCIL=0）——未派发任何席位',
          isError: false,
          orchestration: { kind: 'council', disabled: true },
        }
      }
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `无效输入：${parsed.error.message}`, isError: true, errorKind: 'format_error' }
      const { objective, draftItems, seats, rounds: requestedRounds, pillars, autoExecute } = parsed.data

      // ── Pro gate: 多轮议事会 ──
      // rounds≥2（反驳轮）是 Pro 功能，未启用时降级单轮继续（不拒绝——单轮
      // 议事会是 Basic 能力，降级比报错对任务更有用），并在结果中注明。
      let rounds = requestedRounds
      let proGateNote = ''
      if (requestedRounds && requestedRounds >= 2 && !(options?.multiRoundEnabled ?? true)) {
        rounds = 1
        proGateNote = '\n\n[Pro] 议事会第 2 轮（反驳轮）是 Pro 功能——本次已按单轮执行。升级 Pro 解锁多轮辩论。'
      }

      const items: PlanItem[] = draftItems ?? []
      // Precedence: per-call seats > pillars 三柱模式 > configured agent.council.seats > built-in default.
      // pillars 模式下配置席位不替换结构，只按 authority 沿用 provider/model/tierHint 绑定。
      const pillarsActive = Boolean(pillars) && !(seats && seats.length > 0)
      const baseSeats: CouncilSeat[] = seats && seats.length > 0
        ? seats
        : pillarsActive
          ? mergeSeatOverrides(THREE_PILLAR_COUNCIL_SEATS, defaultSeats ?? [])
          : (defaultSeats && defaultSeats.length > 0 ? defaultSeats : [...DEFAULT_COUNCIL_SEATS])
      const councilSeats: CouncilSeat[] = baseSeats.map(s => ({
        authority: s.authority,
        ...(s.charter ? { charter: s.charter } : {}),
        ...(s.tierHint ? { tierHint: s.tierHint } : {}),
        ...(s.noDowngrade !== undefined ? { noDowngrade: s.noDowngrade } : {}),
        // Per-seat provider/model → threaded as modelOverride by the orchestrator.
        ...(s.provider && s.model ? { provider: s.provider, model: s.model } : {}),
      }))

      // Seats bind to results by authority (workOrderId = `council:seat-<authority>`),
      // and the work queue dedupes by an authority-derived key. Two seats sharing an
      // authority would silently collapse to one worker AND double-count its
      // contribution — fail loud instead of dropping a seat the user asked for.
      const authorities = councilSeats.map(s => s.authority)
      const dupe = authorities.find((a, i) => authorities.indexOf(a) !== i)
      if (dupe) {
        return { content: `council_convene: 席位 authority 重复「${dupe}」—— 每席必须是不同的星域 id（议事会按 authority 绑定结果，重复会丢席并重复计票）。`, isError: true }
      }

      // ── Phase 1: Proposal (explicit confirm:false) ─────────────────
      // 星河收编 #7：只展示席位分配方案，不派发任何 worker。缺省/true 直接
      // 执行（向后兼容——此前 council_convene 没有 proposal 阶段）。
      if (parsed.data.confirm === false) {
        const lines = [
          '🌌 议事会席位分配方案',
          '',
          `目标：${objective}`,
          '',
          `席位（${councilSeats.length}）：`,
        ]
        for (const seat of councilSeats) {
          const star = starDomainRegistry.get(seat.authority)
          const label = star ? `${star.name}（${seat.authority}）` : seat.authority
          const tier = seat.tierHint ? ` [${seat.tierHint}]` : ''
          const charter = seat.charter ? ` — ${seat.charter}` : ''
          lines.push(`  ${label}${tier}${charter}`)
          lines.push(`     objective: ${buildSeatObjective(seat, { objective, items }).split('\n')[0]}`)
        }
        lines.push('', `轮数：${rounds ?? 1}${proGateNote ? '（已按单轮执行——Pro 门）' : ''}`)
        lines.push('', '调用 council_convene({..., confirm: true}) 点火执行。')
        return { content: lines.join('\n'), uiContent: `♟ 议事会方案 · ${councilSeats.length} 席位` }
      }

      // Build authority lookup: workOrderId prefix → authority, for activity mapper.
      const seatObjectiveByAuthority = new Map(councilSeats.map(s => [s.authority, buildSeatObjective(s, { objective, items })]))
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity, {
            objectiveOf: (id) => {
              // council workOrderIds are `council:seat-<authority>`
              // (round 2: `-r2`; parse-failure retry: `-retry`; 波间复议: `-reconvene`；
              // 复议内的重试可叠加为 `-retry-reconvene`)
              const authority = id.startsWith('council:seat-')
                ? id.slice('council:seat-'.length).replace(/(-(r2|retry|reconvene))+$/, '')
                : undefined
              return authority ? seatObjectiveByAuthority.get(authority) : undefined
            },
          })
        : undefined

      try {

      // Collect delegateBatch results for terminal event emission (P1 fix).
      // Each delegateBatch call stores its results; after plan is available,
      // we emit terminal events per contribution → workOrderId match.
      const batchResults: Array<{ results: CoordinatorRun['results']; workerModels?: Array<{ workOrderId: string; model: string }> }> = []

      const emitSeatTerminal = (
        result: CoordinatorRun['results'][number],
        summaryOf?: (authority: string) => string | undefined,
      ): void => {
        if (!params.onWorkerActivity) return
        const seatId = result.workOrderId.startsWith('council:seat-')
          ? result.workOrderId.slice('council:seat-'.length)
          : undefined
        const isR2 = seatId?.endsWith('-r2') ?? false
        const authority = seatId?.replace(/(-(r2|retry|reconvene))+$/, '')
        const contributionSummary = authority ? summaryOf?.(authority) : undefined
        const summary = (isR2 ? (result.summary || contributionSummary) : (contributionSummary || result.summary))?.trim() ?? ''
        activityMapper?.finish(terminalActivity(
          { ...result, summary },
          params.toolUseId,
          authority ? seatObjectiveByAuthority.get(authority) : undefined,
          { authority, profileFallback: 'council_expert', omitArtifacts: true },
        ))
      }

      const deps: CouncilDeps = {
        delegateBatch: async (requests, policy, signal, onProgress, onWorkerSettled) => {
          // W1: inject onActivity into each council fanout request so seat
          // workers appear in the desktop subagent panel (WorkerListPane /
          // WorkerThreadView) alongside delegate_batch / team_orchestrate workers.
          const augmentedRequests = activityMapper
            ? requests.map(r => ({
                ...r,
                onActivity: (ev: WorkerActivityEvent) => activityMapper(ev),
              }))
            : requests
          const run = await coordinator.delegateBatch(
            augmentedRequests as unknown as DelegationRequest[],
            policy,
            signal,
            onProgress,
            onWorkerSettled ?? (result => emitSeatTerminal(result)),
          )
          batchResults.push({ results: run.results, workerModels: run.workerModels })
          return { results: run.results, workerModels: run.workerModels }
        },
        now: () => Date.now(),
        ...(coordinator.getSessionId ? { sessionId: coordinator.getSessionId() } : {}),
        ...(coordinator.recordRoutingShadow ? { recordRoutingShadow: coordinator.recordRoutingShadow } : {}),
        // 实时进度：每席完成时通过工具流式输出推送到 UI。
        // seat 参数在并行场景下为 "N/total" 计数而非具体席位名（见 council-orchestrator 注释）。
        onSeatProgress: params.onOutput
          ? (seat, _status) => {
              // 保留纯文本兜底给非 TUI 消费方。
              params.onOutput?.(`♟ ${seat} 席完成\n`)
              // 推更新帧（TUI 消费，与 skeleton 同构，decodeFrameLastWins 取末帧）。
              // onSeatProgress 只回调计数不含席位名，帧中所有席位保持 running；
              // TUI 侧经 ActivityStore 合并 fleet 拿到各席真实状态与真实 round。
              params.onOutput?.(encodeCouncilPanel({
                schemaVersion: 1,
                objective,
                seats: councilSeats.map(s => ({ authority: s.authority, status: 'running', round: 1 })),
                verdict: { accepted: 0, rejected: 0, deferred: 0, conflicts: 0 },
                pillarsMode: pillarsActive,
              }))
            }
          : undefined,
        onWorkerSettled: result => emitSeatTerminal(result),
      }

      // Terminal event emission for every seat worker that actually ran —
      // shared by the success path AND the fail-loud path (quorum 流会 throws
      // AFTER seats already dispatched; without this, failed councils leave
      // seats stuck 'running' in the desktop panel — the exact P1 regression).
      const emitSeatTerminals = (summaryOf?: (authority: string) => string | undefined, fromBatch = 0): void => {
        if (!params.onWorkerActivity) return
        for (const batch of batchResults.slice(fromBatch)) {
          for (const result of batch.results) emitSeatTerminal(result, summaryOf)
        }
      }

      // 派发前推 skeleton 帧：TUI 据此显示议事会分组与席位骨架。
      // 与 team_orchestrate 的 onPlanReady skeleton 同构。
      //
      // round 恒 1：第二轮只在 round 1 跑完且 aggregate.conflicts 非空时才扇出
      // （runCouncilDebate），配了 rounds≥2 不等于会有 r2。派发前就标 r2 会让
      // 界面显示一批根本没跑过的第二轮席位；真实 round 由 fleet 的 workOrderId
      // 后缀（-r2）在 TUI 侧解析。
      if (params.onOutput) {
        params.onOutput(encodeCouncilPanel({
          schemaVersion: 1,
          objective,
          seats: councilSeats.map(s => ({ authority: s.authority, status: 'running', round: 1 })),
          verdict: { accepted: 0, rejected: 0, deferred: 0, conflicts: 0 },
          pillarsMode: pillarsActive,
        }))
      }

      let plan
      try {
        // 分两层入口：默认走单轮 runCouncil；显式 rounds≥2 才走多轮层 runCouncilDebate。
        const runner = (rounds && rounds >= 2) ? runCouncilDebate : runCouncil
        plan = await runner({ draft: { objective, items }, seats: councilSeats, ...(rounds ? { maxRounds: rounds } : {}), ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}) }, deps)
      } catch (err) {
        // 流会/编排失败：席位 worker 已真实跑过 —— 终态事件照发，面板不留悬挂席位。
        emitSeatTerminals()
        const msg = err instanceof Error ? err.message : String(err)
        // 降级帧：席位终态 + verdict 全零（流会/编排失败态）
        const degradedSeats: CouncilPanelModel['seats'] = []
        for (const batch of batchResults) {
          const modelMap = new Map<string, string>()
          for (const wm of batch.workerModels ?? []) modelMap.set(wm.workOrderId, wm.model)
          for (const r of batch.results) {
            const seatId = r.workOrderId.startsWith('council:seat-')
              ? r.workOrderId.slice('council:seat-'.length)
              : undefined
            if (!seatId) continue
            const round = seatId.endsWith('-r2') ? 2 : 1
            const authority = seatId.replace(/(-(r2|retry|reconvene))+$/, '')
            degradedSeats.push({ authority, status: r.status, round, modelUsed: modelMap.get(r.workOrderId) })
          }
        }
        const degradedPanel: CouncilPanelModel = {
          schemaVersion: 1,
          objective,
          seats: degradedSeats,
          verdict: { accepted: 0, rejected: 0, deferred: 0, conflicts: 0 },
          pillarsMode: pillarsActive,
        }
        return { content: `council_convene 失败：${msg}`, uiContent: encodeCouncilPanel(degradedPanel), isError: true }
      }

      // append-only 遥测旁路 —— 绝不影响返回。
      if (coordinator.recordCouncilSession) {
        try {
          coordinator.recordCouncilSession(buildCouncilSessionEvent({
            sessionId: coordinator.getSessionId?.() ?? 'unknown',
            plan,
            timestamp: Date.now(),
            ...(pillarsActive ? { pillars: true } : {}),
          }))
        } catch {
          // 遥测失败不影响交付。
        }
      }

      // P1 fix: emit terminal events for every council seat so the desktop
      // subagent panel transitions seats from 'running' → 终态. Mirrors
      // delegate_batch's emitTerminal: driven by the real delegateBatch
      // results (covers r1/r2/retry workOrderIds — each settles under its own
      // id), status passed through verbatim (a failed seat must never render
      // as passed). Seat contribution summary is preferred when parsed cleanly.
      {
        // First-wins: plan.contributions is [...round1, ...r2] with duplicate
        // authorities — round-1 seats must read their own round's summary.
        const contribSummaryByAuthority = new Map<string, string>()
        for (const c of plan.contributions) {
          if (!contribSummaryByAuthority.has(c.authority)) contribSummaryByAuthority.set(c.authority, c.summary)
        }
        emitSeatTerminals(authority => contribSummaryByAuthority.get(authority))
      }

      // content: 全文议事记录 markdown(进 model 上下文,供其原样 echo 给用户)。
      // 末尾内嵌机器可读 planJson 作为可读审计(W-C7 评审→执行闭环)。
      // A3: 有任务时同时把计划存入会话桥(plan-store) —— 模型无需手工提取 JSON,
      // 用户确认后直接调 team_orchestrate({ objective }) 即自动消费。
      // council 自身默认绝不触发执行(autoExecute 例外,走完整 executePlan 闭环)。
      // uiContent: 紧凑裁决摘要 —— 工具卡默认仅展示前 4 行,避免裸 markdown 被截成无意义片段。
      const parts = [plan.finalPlanMarkdown]
      const hasTasks = plan.aggregate.mergedItems.length > 0
      // Da'at 编译门：未化解的 blocking challenge = 否决态，没有可执行契约——
      // 不产 planJson、不 storePlan、不 autoExecute。
      const compiled = hasTasks ? compileCouncilPlan(plan) : undefined
      if (compiled && !compiled.ok) {
        parts.push('', '## ⛔ 议事会否决（blocking challenge 未化解）',
          ...compiled.vetoes.map(v => `- ${v.description}: ${v.left}`),
          '', '计划未编译执行。化解方式：传 rounds:2 让席位复议收敛（concede/revise 化解否决），或修订草案后重新召集。')
      }
      // Atropos 密封（Phase 3）：编译通过的契约即密封——摘要钉住执行语义
      // （objective/files/dependsOn/verification），此后静默改写在
      // team_orchestrate 消费入口被硬拦；修订走 revisePlanSeal 豁免协议留痕。
      // Norns 义务账随契约挂载：暂缓项/高危缓解承诺/advisory gate 流到
      // deliver_task 交付前逐项核验（义务不入 digest，账目更新不破封）。
      const unifiedPlan = compiled?.ok && compiled.plan
        ? sealPlan(attachObligations(compiled.plan, extractObligations(plan)))
        : undefined
      const planJson = unifiedPlan ? serializeUnifiedPlan(unifiedPlan) : undefined
      if (planJson) {
        parts.push('', '```council-plan-json', planJson, '```')
      }
      if (planJson && !autoExecute) {
        storePlan(planJson, params.sessionId)
        parts.push('', '✅ 计划已存入会话 — 用户确认后直接调用 `team_orchestrate({ objective })` 即可执行（不要传 planJson/planMarkdown，存储的计划会被自动消费）。上方 JSON 块仅作可读审计。')
      }

      // A4 autoExecute: run the council-approved plan through the SAME closed
      // loop as team_orchestrate — executePlan gives wave grouping (file
      // conflicts / dependsOn), scope health, the review gate, the wave hard
      // gate, and A1 checkpoints. Multi-wave plans are driven to completion here.
      if (autoExecute && unifiedPlan && planJson) {
        const executorDeps: PlanExecutorDeps = coordinator.executor ?? coordinator
        try {
          const teamTasks = unifiedPlanToTeamTasks(unifiedPlan)
          if (teamTasks.length > 0) {
            const waveLines: string[] = []
            let fromWave = 0
            let totalWaves = 1
            let workers = 0
            do {
              const run = await executePlan(
                {
                  mode: 'standard',
                  objective,
                  tasks: teamTasks,
                  fromWave,
                  sessionId: params.sessionId,
                  parentTurnId: `${params.toolUseId ?? 'council-autoexec'}:w${fromWave}`,
                  reviewDepth: params.reviewDepth ?? 0,
                  cwd: params.cwd,
                  abortSignal: params.abortSignal,
                  // The review gate needs a single-delegate channel; skip it when
                  // the caller wired only the bare fanout surface.
                  reviewGate: Boolean(executorDeps.delegate),
                },
                executorDeps,
              )
              totalWaves = Math.max(1, run.summary.waves.length)
              const results = run.summary.run?.results ?? []
              workers += results.length
              for (const r of results) {
                waveLines.push(`- [wave ${fromWave + 1}/${totalWaves}] ${r.workOrderId}: ${r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠'} ${r.summary}`)
              }
              const noteBlock = [run.notes.reviewNote, run.notes.scopeHealthNote, run.notes.waveGateNote, run.notes.deliverySynthesis]
                .map(n => n.trim()).filter(Boolean)
              if (noteBlock.length > 0) waveLines.push(...noteBlock.map(n => `  ${n.replace(/\n/g, '\n  ')}`))
              // W2d: surface structured gate failures so the user can see which
              // checks blocked the next wave — these were previously silently
              // discarded when autoExecute consumed only the text noteBlock.
              if (run.gate && !run.gate.passed) {
                waveLines.push(`  ⛔ 门禁未通过 (wave ${run.gate.wave + 1})`)
                for (const f of run.gate.failures.slice(0, 5)) {
                  waveLines.push(`    ❌ ${f}`)
                }
                if (run.gate.failures.length > 5) waveLines.push(`    … (+${run.gate.failures.length - 5} more)`)
                // Phase 3 波间自动复议：按 provenance 只召回提案席 + 平衡柱做
                // 轻量诊断（advisory——契约修订仍是主控决策点，走豁免协议）。
                // 复议后停止推波：下一波入口门禁必拦，与其抛错不如把复议建议
                // 和续跑指引一起交回主控。
                const failedWaveTaskIds = new Set(run.summary.waves[fromWave]?.taskIds ?? [])
                const taskRefs: ReconveneTaskRef[] = unifiedPlan.tasks
                  .filter(t => failedWaveTaskIds.size === 0 || failedWaveTaskIds.has(t.id))
                  .map(t => ({
                    id: t.id,
                    title: t.title,
                    detail: t.objective,
                    ...(typeof t.metadata?.proposedBy === 'string' ? { proposedBy: t.metadata.proposedBy } : {}),
                  }))
                const preReconveneBatches = batchResults.length
                const reconveneLines = await runWaveReconvene({
                  objective,
                  wave: run.gate.wave,
                  failures: run.gate.failures,
                  tasks: taskRefs,
                  originalSeats: councilSeats,
                  ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
                }, deps)
                // 复议席位 worker 的终态事件：复用同一回路，只发新增批次
                // （首轮席位的终态早已发过，重发会污染面板）。
                emitSeatTerminals(undefined, preReconveneBatches)
                waveLines.push('', ...reconveneLines)
                storePlan(planJson, params.sessionId)
                waveLines.push('', '⚠ 后续波已暂停（门禁硬拦）。计划已存入会话 — 按复议建议修订后调用 `team_orchestrate({ objective, fromWave })` 续跑。')
                fromWave++
                break
              }
              fromWave++
            } while (fromWave < totalWaves)
            parts.push('', `## 已自动执行（${workers} 个 worker，${totalWaves} 波）`)
            parts.push(...waveLines)
          }
        } catch (err) {
          parts.push('', `## 自动执行失败\n${err instanceof Error ? err.message : String(err)}`)
          storePlan(planJson, params.sessionId)
          parts.push('', '⚠ 议事会计划已审完，但自动执行失败。计划已存入会话 — 修复失败项后直接调用 `team_orchestrate({ objective })` 续跑（存储的计划会被自动消费）。')
        }
      }

      // ── council-panel 帧（P2 Wave 2）─────────────────────
      // 从 plan + batchResults 构建 CouncilPanelModel，经 uiContent 通道
      // 发射到桌面端。零前缀缓存影响（uiContent 不进 prompt）。
      const councilPanelSeats: CouncilPanelModel['seats'] = []
      for (const batch of batchResults) {
        // 从 workerModels 建 workOrderId → model 映射（WorkerResult 自身不携带 model）
        const modelMap = new Map<string, string>()
        for (const wm of batch.workerModels ?? []) {
          modelMap.set(wm.workOrderId, wm.model)
        }
        for (const r of batch.results) {
          const seatId = r.workOrderId.startsWith('council:seat-')
            ? r.workOrderId.slice('council:seat-'.length)
            : undefined
          if (!seatId) continue
          const round = seatId.endsWith('-r2') ? 2 : 1
          const authority = seatId.replace(/(-(r2|retry|reconvene))+$/, '')
          // merge: later batch results for same authority overwrite earlier
          const existing = councilPanelSeats.findIndex(s => s.authority === authority)
          const seat = { authority, status: r.status, round, modelUsed: modelMap.get(r.workOrderId) }
          if (existing >= 0) councilPanelSeats[existing] = seat
          else councilPanelSeats.push(seat)
        }
      }
      const verdictCounts = { accepted: 0, rejected: 0, deferred: 0 }
      for (const d of plan.aggregate.decisions) {
        if (d.verdict === 'accepted') verdictCounts.accepted++
        else if (d.verdict === 'rejected') verdictCounts.rejected++
        else if (d.verdict === 'deferred') verdictCounts.deferred++
      }
      const councilPanel: CouncilPanelModel = {
        schemaVersion: 1,
        objective: plan.objective,
        seats: councilPanelSeats,
        verdict: {
          accepted: verdictCounts.accepted,
          rejected: verdictCounts.rejected,
          deferred: verdictCounts.deferred,
          conflicts: plan.aggregate.conflicts.length,
        },
        sealVersion: unifiedPlan?.seal?.version,
        pillarsMode: pillarsActive,
        failedSeats: plan.meta.failedSeats,
        qliphothCount: plan.meta.qliphoth?.length,
      }

      return {
        content: parts.join('\n') + proGateNote,
        uiContent: summarizeCouncilPlan(plan) + '\n' + encodeCouncilPanel(councilPanel),
        isError: false,
        orchestration: {
          kind: 'council',
          disabled: false,
          seats: {
            total: councilSeats.length,
            passed: councilSeats.length - (plan.meta.failedSeats?.length ?? 0),
            failed: plan.meta.failedSeats?.length ?? 0,
          },
        },
      }
      } finally {
        activityMapper?.dispose()
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => isCouncilEnabled(),
    timeoutMs: () => 600_000,
  }
}
