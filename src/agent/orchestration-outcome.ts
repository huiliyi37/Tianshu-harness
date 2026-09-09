// ⚠ 本文件禁止 import 重型模块：它是 tools/types.ts 的引用闭包成员
//（ToolResult.orchestration 字段类型），而 tools/types.ts 经 server 类型链被
// desktop tsc 引用——import team-orchestrator/plan-executor 会把整个 agent 域
// 拖进桌面端编译图（2026-08-02 实证：桌面 build 因此暴露 75 处跨域报错）。
// 构造器参数用下方结构切面：调用方传真实 TeamRunSummary / PlanExecutorRun，
// TS 结构子类型直接兼容，运行时与类型语义均零变化。

/** WorkerResult.status 的字面量副本（work-order.ts:241 的 zod enum）。
 *  这里不 import 而是抄一份：import 会把 agent 域拖进桌面 tsc 编译图（见文件头）。
 *  但也**不能**退化成 `string`——`=== 'passed'` 是本模块唯一的判定，宽成 string 就
 *  等于把编译期保护换掉，而 ToolResult.orchestration 选窄类型而非 unknown 的全部
 *  理由就是「字段漂移要在编译期暴露」。枚举改名时这里会红，那正是想要的。 */
type WorkerStatus = 'passed' | 'failed' | 'blocked' | 'escalated'

/** TeamRunSummary 的结构切面（buildTeamOutcome 实际读取的字段）。 */
export interface TeamOutcomeSummarySlice {
  dispatched: number
  waves: readonly unknown[]
  run?: { results?: ReadonlyArray<TeamOutcomeResultSlice> }
}

/** buildTeamOutcome 战报行实际读取的 WorkerResult 字段切面（真实 WorkerResult
 *  是结构超集，TS 结构子类型直接兼容——同本文件的既定模式，不 import work-order）。 */
export interface TeamOutcomeResultSlice {
  status: WorkerStatus
  workOrderId?: string
  objective?: string
  failureReason?: string
  summary?: string
  changedFiles?: readonly string[]
  diffArtifactId?: string
  evidenceStatus?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  durationMs?: number
}

/** 星流战报的单 worker 行（接口层加法，2026-08-18）：把「波次回来了每块怎么样」
 *  从 packet JSON / artifact 取证提升为一等结构化事实。行粒度刻意紧凑——完整
 *  findings/risks 仍在 worker_results packet 与 artifact 里，战报只回答「先看哪块」。 */
export interface TeamWorkerRow {
  /** workOrderId 原值（`<parentTurnId>:<task>`，parentTurnId 含波次标签）。 */
  id: string
  /** workOrderId 尾段任务号（T1/T2/…）——战报行主键，跨波重派去重用。 */
  task: string
  status: WorkerStatus
  failureReason?: string
  /** summary 首行，≤100 字符。 */
  summary: string
  /** objective 首行，≤60 字符（认领「这行是哪块任务」）。 */
  objective?: string
  changedCount: number
  /** 最多 3 个文件名，超出截断（计数见 changedCount）。 */
  changedFiles?: readonly string[]
  /** worker diff 在 artifact store 的指针——读改动详情的入口。 */
  diffArtifactId?: string
  evidenceStatus?: string
  /** 派发累计 token（usage-ledger 对齐后的口径：跨续跑/重试单调）。 */
  usage?: { input: number; output: number }
  durationMs?: number
}

/** PlanExecutorRun 的门禁/裁决切面（gate 实际对象多带 wave 字段，结构超集兼容）。 */
export interface TeamOutcomeRunSlice {
  gate?: { passed: boolean; failures: string[] }
  reviewVerdict?: string
}

/** team 整体执行状态（替代散文判断：formatTeamSummary 的续波/停止警告 +
 *  starflow teamGate/nextWaveOf 的正则推导）。run 缺席（预览/未派发）时不写。
 *  'completed'：末波完成，整体执行结束；'more-waves'：本波全过且非末波；
 *  'partial'：本波部分 worker 未过且非末波；'all-failed'：本波整波失败；
 *  'wave-gate'：波间硬门禁拦截；'review-rejected'：review gate 驳回。 */
export type TeamStoppedReason =
  | 'completed'
  | 'more-waves'
  | 'partial'
  | 'all-failed'
  | 'wave-gate'
  | 'review-rejected'

/** 编排工具回给上游编排器（starflow）的结构化事实。
 *  与 ToolResult.errorKind 同一解法：门禁读字段，不读 formatter 散文。
 *  字段只加有消费者的——无 reader 的字段是死写，见
 *  docs/design/2026-08-01-orchestration-readside-wiring.md。 */
export interface TeamOrchestrationOutcome {
  kind: 'team'
  /** 本次调用派发的 worker 数；0 = 计划无可执行波次。 */
  dispatched: number
  /** 本次派发的波次序号（= 入参 fromWave）。 */
  wave: number
  /** 计划总波次；wave + 1 < totalWaves 表示还有下一波。 */
  totalWaves: number
  /** 本波 worker 终态计数；total=0 表示未产出结果（未派发/预览）。 */
  workers: { total: number; passed: number }
  /** 整体执行推进到的已执行波次数（1 基，= fromWave + 1）；run 缺席时
   *  无意义（预览/未派发），不写。消费方用它判断是否还有后续波
   *  （completedWaves < totalWaves 即未执行完）。 */
  completedWaves?: number
  /** 整体执行状态（见 TeamStoppedReason）；run 缺席时（预览/未派发）不写。 */
  stoppedReason?: TeamStoppedReason
  /** 波间硬门禁结果——非末波且已评估才有值（plan-executor.ts:466）。
   *  只挑 passed/failures：`run.gate` 还带一个 `wave`，与顶层 `wave` 同义，
   *  整包透传就是又一个 StarflowPhaseRecord.at（写了没人读）。 */
  waveGate?: { passed: boolean; failures: string[] }
  /** review gate 裁决枚举词（'verified' / 'rejected' / …）。 */
  reviewVerdict?: string
  /** 本波逐 worker 终态行（星流战报的消费者：starflow-orchestrator 的
   *  buildReport 战报段——编排器不再翻 state/artifact 取证每块状态）。
   *  失败在前、每行紧凑截断；run 缺席（预览/未派发）不写。上限
   *  WORKER_ROW_CAP 行，超出截断（超出量本身即异常信号，值得保留失败行优先）。 */
  workerRows?: TeamWorkerRow[]
}

/** workerRows 行数上限——超出的保留失败优先的前 N 行（正常波次 ≤12 任务，40 已是
 *  3 倍余量；再大说明计划本身病态，全量留在 packet/artifact）。 */
const WORKER_ROW_CAP = 40

function firstLineCap(text: string | undefined, cap: number): string {
  if (!text) return ''
  const line = text.split('\n', 1)[0]!.trim()
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line
}

/** workOrderId 尾段任务号（`<parentTurnId>:T1` → `T1`）；无冒号回退原值。 */
function taskOf(workOrderId: string): string {
  const idx = workOrderId.lastIndexOf(':')
  return idx >= 0 && idx < workOrderId.length - 1 ? workOrderId.slice(idx + 1) : workOrderId
}

function buildWorkerRows(results: ReadonlyArray<TeamOutcomeResultSlice>): TeamWorkerRow[] {
  const rows = results.map(r => ({
    id: r.workOrderId ?? '',
    task: taskOf(r.workOrderId ?? ''),
    status: r.status,
    ...(r.failureReason ? { failureReason: r.failureReason } : {}),
    summary: firstLineCap(r.summary, 100),
    ...(r.objective ? { objective: firstLineCap(r.objective, 60) } : {}),
    changedCount: r.changedFiles?.length ?? 0,
    ...(r.changedFiles && r.changedFiles.length > 0
      ? { changedFiles: r.changedFiles.slice(0, 3).map(f => f.split('/').pop() ?? f) }
      : {}),
    ...(r.diffArtifactId ? { diffArtifactId: r.diffArtifactId } : {}),
    ...(r.evidenceStatus ? { evidenceStatus: r.evidenceStatus } : {}),
    ...(r.usage && (typeof r.usage.input_tokens === 'number' || typeof r.usage.output_tokens === 'number')
      ? { usage: { input: r.usage.input_tokens ?? 0, output: r.usage.output_tokens ?? 0 } }
      : {}),
    ...(typeof r.durationMs === 'number' ? { durationMs: r.durationMs } : {}),
  }))
  // 失败在前（buildPrimaryWorkerPacket 同序）：战报的第一职责是把「先看哪块」置顶。
  rows.sort((a, b) => (a.status === 'passed' ? 1 : 0) - (b.status === 'passed' ? 1 : 0))
  return rows.length > WORKER_ROW_CAP ? rows.slice(0, WORKER_ROW_CAP) : rows
}

/** council 工具（council_convene）回给上游编排器的结构化事实。
 *  承载 gate 需要的最小事实：评审是否实际执行。isError:false 的禁用/未派发
 *  路径（council-convene.ts:137）散文是唯一失败信号——disabled 布尔是它的
 *  结构化镜像，councilGate 优先读它、content.includes 降级兜底。 */
export interface CouncilOrchestrationOutcome {
  kind: 'council'
  /** 议事会是否执行：true = 禁用（COUNCIL=0）或未派发任何席位；
   *  false = 评审已实际执行（产出密封契约或否决）。 */
  disabled: boolean
  /** 席位终态计数（评审已执行且 run 有结果时写）。total=0 表示未产出结果。
   *  councilGate 用 passed===0 判「席位全部失败」——与 teamGate 的
   *  workers.passed===0 同构，防未来法定人数逻辑变化后全部失败不再 throw 时
   *  门禁静默放行。过会但部分失败（passed>0）不拦截——那是有效评审。 */
  seats?: { total: number; passed: number; failed: number }
}

/** galaxy 工具回给上游编排器的结构化事实。
 *  GALAXY_FAILED_RE / GALAXY_DIM_LINE_RE 逐维度解析自家渲染行的结构化镜像：
 *  写侧在 coordinator run.results 上已有终态计数，出站挂 total/passed/failed，
 *  galaxyGate 优先读它、正则降级兜底。 */
export interface GalaxyOrchestrationOutcome {
  kind: 'galaxy'
  /** Stable tool-call identity for correlating worker activity and results. */
  runId?: string
  /** Planned vs dispatched worker counts, including explicit/automatic review. */
  planned?: number
  dispatched?: number
  /** Human-readable task labels intentionally skipped before dispatch. */
  skipped?: string[]
  /** Number of EP tasks and DP groups in the execution plan. */
  parallelism?: { expert: number; data: number }
  /** 派发维度终态（含 autoReview 追加的审查维度）；failed 是未通过维度的
   *  报告行标签（dimension 名，与 formatter 渲染行同源）。 */
  dimensions: { total: number; passed: number; failed: string[] }
}

/**
 * Structured Starflow lifecycle outcome.  The text report remains the
 * human-facing fallback, but callers can now render a phase-aware status
 * without scraping prose (the same separation Codex uses for activity and
 * thread state).
 */
export interface StarflowOrchestrationOutcome {
  kind: 'starflow'
  runId: string
  phase: 'council' | 'team' | 'galaxy' | 'deliver' | 'done'
  done: boolean
  resumed: boolean
  revision: number
  phases: Partial<Record<'council' | 'team' | 'galaxy' | 'deliver', {
    status: 'passed' | 'blocked' | 'skipped'
    at: number
    elapsedMs?: number
  }>>
}

export type OrchestrationOutcome =
  | TeamOrchestrationOutcome
  | CouncilOrchestrationOutcome
  | GalaxyOrchestrationOutcome
  | StarflowOrchestrationOutcome

export function buildTeamOutcome(
  summary: TeamOutcomeSummarySlice,
  fromWave: number,
  run: TeamOutcomeRunSlice,
): TeamOrchestrationOutcome {
  const results = summary.run?.results ?? []
  const total = results.length
  const passed = results.filter(r => r.status === 'passed').length
  const totalWaves = summary.waves.length
  const allFailed = total > 0 && passed === 0
  const isLastWave = fromWave + 1 >= totalWaves
  // 整体状态只在有 run（已派发执行）时才有意义；预览/未派发不写。
  const hasRun = summary.run !== undefined
  let stoppedReason: TeamStoppedReason | undefined
  if (hasRun) {
    // 优先级与 starflow teamGate（starflow-orchestrator.ts:329）对齐：
    // 整波失败 > 波间硬门禁 > review 驳回 > 末波完成 > 部分通过 > 更多波次。
    if (allFailed) stoppedReason = 'all-failed'
    else if (run.gate && !run.gate.passed) stoppedReason = 'wave-gate'
    else if (run.reviewVerdict === 'rejected') stoppedReason = 'review-rejected'
    else if (isLastWave) stoppedReason = 'completed'
    else if (passed < total) stoppedReason = 'partial'
    else stoppedReason = 'more-waves'
  }
  return {
    kind: 'team',
    dispatched: summary.dispatched,
    wave: fromWave,
    totalWaves,
    workers: { total, passed },
    // 已成功执行完的波次数：整波失败时本波未成功完成（= fromWave），
    // 其余情况本波已完成（= fromWave + 1）。末波完成时 === totalWaves。
    ...(hasRun ? { completedWaves: allFailed ? fromWave : fromWave + 1, stoppedReason: stoppedReason! } : {}),
    ...(run.gate ? { waveGate: { passed: run.gate.passed, failures: run.gate.failures } } : {}),
    ...(run.reviewVerdict ? { reviewVerdict: run.reviewVerdict } : {}),
    ...(total > 0 ? { workerRows: buildWorkerRows(results) } : {}),
  }
}
