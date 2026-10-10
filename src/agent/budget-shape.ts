/**
 * 写工预算的任务形状定价（budget sizing，2026-08-18）。
 *
 * 背景：写工预算是 flat profile 默认（48 轮 / 600s），与任务规模零相关——
 * playtest 战役 146 会话 110 个多段续跑（92 个恰好 2 段）、段间隔精确 10 分钟
 * （600s 墙钟先开枪）、P5 五段 input 931K→4.0M→7.0M 逐段膨胀；每段续跑付
 * 「盘点轮 + 上下文重读」两笔税。MAX_BUDGET_CONTINUATIONS 2→4→6 的调参史
 * 就是一直在加续跑次数兜预算不足，而不是把首枪发准。
 *
 * 定价模型：一个文件 = 读 + 改 + 验证 ≈ 6 轮 / 45s。只涨不降——files 缺席
 * 或单文件 = 纯 profile 默认（行为零变化）。上限对齐既有约束：100 轮是
 * runtimeFactory 三分支的 maxTurns（clampWorkerMaxTurns 取 min，超了无效），
 * 30min 留出外层 delegationToolTimeoutMs 的 runs 倍乘空间。
 *
 * 读工不定价：探索型任务 files 无预测力，续跑税痛点全在写工侧。
 * 闸门：RIVET_WORKER_BUDGET_SHAPE=0 关闭（沿 RIVET_WORKER_FINALIZE 模式）。
 */
import { profileRegistry } from './profile-registry.js'

/** 与 work-order.ts createWriteWorkOrder 的 ?? 48 同源——两处必须一起动。 */
export const WRITE_DEFAULT_MAX_TURNS = 48

/** 绝对帽：runtimeFactory maxTurns=100（bootstrap.ts:1000/1062/1153），
 *  clampWorkerMaxTurns = min(runtime, budget)——budget 超过 100 会被静默钳回。 */
export const SHAPE_MAX_TURNS_CEIL = 100

/** 绝对帽：30min/worker。外层超时 = budget × runs(≤8) + grace，30min 单发
 *  在最坏 hands 形态下 outer ≈ 4h，仍在工具层可接受范围。 */
export const SHAPE_TIMEOUT_CEIL_MS = 1_800_000

/** 一文件 ≈ 6 轮——goal 预算定价（goal-budget.ts）复用同一锚点，口径必须一致。 */
export const TURNS_PER_EXTRA_FILE = 6
const MS_PER_EXTRA_FILE = 45_000

/** 形状定价开关（RIVET_WORKER_BUDGET_SHAPE=0 关闭）。 */
export function shapeBudgetEnabled(): boolean {
  return process.env.RIVET_WORKER_BUDGET_SHAPE !== '0'
}

export interface ShapeBudgetInput {
  /** 任务目标文件清单（scope.files）；缺席/空 = 纯默认。 */
  files?: readonly string[]
  /** profile 默认预算基数（timeout 取 profileRegistry；turns 用写工默认 48）。 */
  baseMaxTurns?: number
  baseTimeoutMs: number
}

/** 纯函数核心：按文件数放大写工预算。只涨不降，双帽钳制。 */
export function shapeWriteBudget(input: ShapeBudgetInput): { maxTurns: number; timeoutMs: number } {
  const baseTurns = input.baseMaxTurns ?? WRITE_DEFAULT_MAX_TURNS
  const extra = Math.max(0, (input.files?.length ?? 0) - 1)
  return {
    maxTurns: Math.min(SHAPE_MAX_TURNS_CEIL, baseTurns + TURNS_PER_EXTRA_FILE * extra),
    timeoutMs: Math.min(SHAPE_TIMEOUT_CEIL_MS, input.baseTimeoutMs + MS_PER_EXTRA_FILE * extra),
  }
}

/** 便捷入口：按 profile 名解析基数（profile 缺席/无默认时回退 progressive 阶梯
 *  顶格 480s——与 work-order 的 timeout 解析同语义）。只对写工 profile 且
 *  files ≥ 2 生效——单文件/无文件时 shape 与基数重合，没有信号就不发声
 *  （否则 480s 兜底基数会顶掉无 defaultTimeoutMs profile 的渐进阶梯）。
 *  读工一律返回 undefined（调用方不设 budget，行为零变化）。 */
export function shapeWriteBudgetForProfile(
  files: readonly string[] | undefined,
  profile: string | undefined,
): { maxTurns: number; timeoutMs: number } | undefined {
  if (!shapeBudgetEnabled() || !profile) return undefined
  if ((files?.length ?? 0) <= 1) return undefined
  if (!profileRegistry.listWriteProfiles().includes(profile)) return undefined
  const baseTimeoutMs = profileRegistry.get(profile)?.defaultTimeoutMs ?? 480_000
  return shapeWriteBudget({ files, baseTimeoutMs })
}

/** 显式 budget 与 shape 合并——模型显式值逐字段全胜（显式即用户意图），
 *  缺席字段落 shape，两者皆无 = undefined（纯 profile 默认）。 */
export function mergeBudgetOverride(
  explicit: Partial<{ maxTurns: number; timeoutMs: number }> | undefined,
  shape: { maxTurns: number; timeoutMs: number } | undefined,
): Partial<{ maxTurns: number; timeoutMs: number }> | undefined {
  if (!shape) return explicit
  if (!explicit) return shape
  return {
    ...explicit,
    ...(explicit.maxTurns === undefined ? { maxTurns: shape.maxTurns } : {}),
    ...(explicit.timeoutMs === undefined ? { timeoutMs: shape.timeoutMs } : {}),
  }
}

// ── 历史实际用量回馈（预算发准第三刀，2026-08-18）─────────────────────────

/** 历史回馈开关（RIVET_WORKER_BUDGET_HISTORY=0 关闭）。 */
export function historyBudgetEnabled(): boolean {
  return process.env.RIVET_WORKER_BUDGET_HISTORY !== '0'
}

/** worker_actual 索引行的可读切面（persistWorkerActualIndex 的镜像）。 */
export interface WorkerActualSample {
  toolUses: number
  durationMs: number
  exhausted?: boolean
  budget?: { maxTurns: number; timeoutMs: number }
}

const HISTORY_SAMPLE_LIMIT = 5
const NEAR_MISS_RATIO = 0.8
const TURNS_FROM_TOOL_USES = 1.15
const EXHAUSTION_HEADROOM = 1.3
const HISTORY_LIFT_CAP = 3

/** 纯函数估计器：同 objective 的历史实际用量 → 预算地板。
 *
 *  触发条件（满足其一）：某次样本耗尽预算（exhausted），或 toolUses 逼近
 *  当次预算轮数（near-miss ≥ 0.8）——没挨过墙的任务不该涨预算。
 *  估值：maxTurns = ceil(max(toolUses) × 1.15 × 1.3)、timeoutMs =
 *  ceil(max(durationMs) × 1.3)；只做地板（≥ current），双重帽（3× current
 *  与绝对帽）。无触发 / 无有效样本返回 undefined（纯 shape/默认）。 */
export function historyBudgetFloor(
  samples: ReadonlyArray<WorkerActualSample | undefined | null>,
  current: { maxTurns: number; timeoutMs: number },
): { maxTurns: number; timeoutMs: number } | undefined {
  const valid = samples.filter((s): s is WorkerActualSample =>
    Boolean(s) && ((s!.toolUses ?? 0) > 0 || (s!.durationMs ?? 0) > 0))
  if (valid.length === 0) return undefined
  const triggered = valid.some(s =>
    s.exhausted === true
    || (s.toolUses > 0 && s.toolUses >= NEAR_MISS_RATIO * (s.budget?.maxTurns ?? current.maxTurns)))
  if (!triggered) return undefined
  const maxToolUses = Math.max(...valid.map(s => s.toolUses))
  const maxDuration = Math.max(...valid.map(s => s.durationMs))
  const priorTurns = Math.ceil(maxToolUses * TURNS_FROM_TOOL_USES * EXHAUSTION_HEADROOM)
  const priorTimeout = Math.ceil(maxDuration * EXHAUSTION_HEADROOM)
  const lift = {
    maxTurns: Math.min(SHAPE_MAX_TURNS_CEIL, Math.max(current.maxTurns, priorTurns),
      current.maxTurns * HISTORY_LIFT_CAP),
    timeoutMs: Math.min(SHAPE_TIMEOUT_CEIL_MS, Math.max(current.timeoutMs, priorTimeout),
      current.timeoutMs * HISTORY_LIFT_CAP),
  }
  if (lift.maxTurns <= current.maxTurns && lift.timeoutMs <= current.timeoutMs) return undefined
  return lift
}

/** 从 store 前缀查询结果解析样本行（坏行跳过——回馈绝不因脏数据炸派发）。 */
export function parseWorkerActualRows(
  rows: ReadonlyArray<{ kind: string; json: string }> | undefined,
  objectiveHash: string,
): WorkerActualSample[] {
  const prefix = `worker_actual:${objectiveHash}:`
  const samples: WorkerActualSample[] = []
  for (const row of rows ?? []) {
    if (!row?.kind?.startsWith(prefix)) continue
    try {
      const parsed = JSON.parse(row.json) as Record<string, unknown>
      if (typeof parsed.toolUses !== 'number' && typeof parsed.durationMs !== 'number') continue
      samples.push({
        toolUses: typeof parsed.toolUses === 'number' ? parsed.toolUses : 0,
        durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
        ...(parsed.exhausted === true ? { exhausted: true } : {}),
        ...(parsed.budget && typeof parsed.budget === 'object'
          ? { budget: parsed.budget as WorkerActualSample['budget'] }
          : {}),
      })
    } catch { /* 坏行跳过 */ }
  }
  return samples.slice(0, HISTORY_SAMPLE_LIMIT)
}
