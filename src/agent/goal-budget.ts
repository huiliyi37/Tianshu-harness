/**
 * Goal 预算定价（2026-10-10）——`rivet --goal` 的轮次预算按任务形状定价。
 *
 * 背景：`--budget` 此前是固定缺省 100（headless.ts:59），与任务规模零相关。
 * issue #414 提议"跑前用模型评估 S/M/L 再拍 10/40/80"，本模块给出的是另一条
 * 路：**用确定性信号定价，且只抬不降**。三条理由（设计文档已用探针/读实现核实）：
 *
 *  1. 轮次上限不是额度配额——没用完的轮次不产生任何 API 调用，"给 40 轮跑 20 轮"
 *     与"给 100 轮跑 20 轮"成本相同。省额度要动每轮读入量与 reasoning effort，
 *     不是动上限。
 *  2. goal 模式欠预算是**死路不是慢路**：goal-tracker 的 `budget_exhausted` 直接
 *     终止，且 `isRolloverDue` 要求 `iteration < maxIterations`——接力也被抑制。
 *  3. maxTurns 同时被当**进度分母**消费（perception 的 isFinalTurn、turnDepth、
 *     convergence phase）——降预算会连带改写"何时认为自己在收尾"。
 *
 * 定价锚点与 `budget-shape.ts` 同源（一文件 ≈ 6 轮）：写工侧已实现同型机制，
 * 本模块只补 goal 侧入口，不重写 worker 派发路径。
 */
import { TURNS_PER_EXTRA_FILE } from './budget-shape.js'

/** = `--budget` 现状缺省（headless.ts:59）——不新引入数字，只做地板。 */
export const GOAL_BUDGET_BASE = 100

/** 形状/历史路径的绝对帽：headless 是无值守进程，轮次上限不能无限抬。
 *  **不约束显式 `--budget`**——用户给的值逐字段全胜（见 sizeGoalBudget 的短路分支），
 *  这条帽只对"系统替用户猜"的部分生效。 */
export const GOAL_BUDGET_CEIL = 200

/** 与 budget-shape.TURNS_PER_EXTRA_FILE 同源——口径统一才谈得上对账。 */
export const TURNS_PER_MENTIONED_FILE = TURNS_PER_EXTRA_FILE

/** 历史样本估值系数——与 budget-shape.historyBudgetFloor 同口径。 */
const TURNS_FROM_ITERATIONS = 1.15
const EXHAUSTION_HEADROOM = 1.3
const NEAR_MISS_RATIO = 0.8

/** goal 文本里"大范围量级"的词根。命中即说明任务跨模块/涉架构/平台相关——
 *  这是启发式断言（设计文档已标注为待数据校准），不是标定值。 */
const LARGE_SCOPE_PATTERNS: readonly string[] = [
  '架构', '并发', '平台', '迁移', '重构', '全链路', '多模块', '跨模块', '性能',
  'architecture', 'concurrency', 'concurrent', 'migration', 'migrate',
  'refactor', 'platform', 'cross-module', 'multi-module', 'end-to-end',
]

const FILE_EXT = 'ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|cc|cxx|h|hpp|md|mdx|json|jsonl|yml|yaml|toml|sh|bash|zsh|sql|vue|svelte|lua|swift|dart'
const PATH_TOKEN = new RegExp(`(?:[\\w.@~$-]+\\/)*[\\w.@$-]+\\.(?:${FILE_EXT})`, 'gi')

/** 闸门：`RIVET_GOAL_BUDGET_SHAPE=0` 关闭（沿 RIVET_WORKER_BUDGET_SHAPE 命名）。 */
export function goalBudgetShapeEnabled(): boolean {
  return process.env.RIVET_GOAL_BUDGET_SHAPE !== '0'
}

/** goal 文本里提到的文件路径（去重、去前导 `./`）——不读文件内容，只数形状。 */
export function countMentionedPaths(goal: string): string[] {
  const found = new Set<string>()
  for (const match of (goal ?? '').matchAll(PATH_TOKEN)) {
    const token = match[0].replace(/^\.\//, '')
    if (token.length > 0) found.add(token)
  }
  return [...found]
}

/** 大范围量级信号（中英文词根包含匹配）。 */
export function hasLargeScopeSignal(goal: string): boolean {
  const text = (goal ?? '').toLowerCase()
  if (text.length === 0) return false
  return LARGE_SCOPE_PATTERNS.some(pattern => text.includes(pattern.toLowerCase()))
}

/** 单条历史样本的可读切面（镜像 budget-shape.WorkerActualSample 的字段名）。 */
export interface GoalActualSample {
  iterationsUsed: number
  exhausted?: boolean
  budget?: { maxIterations: number }
}

export interface GoalBudgetInput {
  /** goal 原文（启动前可取，见 main.ts:640 的 tracker 装配）。 */
  goal: string
  /** `--budget N` 显式值——逐字段全胜，任何形状信号都不覆盖。 */
  explicitBudget?: number
  /** 同 objective 的历史实际用量（token）。 */
  history?: readonly GoalActualSample[]
  /** 定价基数，缺省 GOAL_BUDGET_BASE。 */
  base?: number
}

export interface GoalBudgetDecision {
  maxIterations: number
  source: 'explicit' | 'shaped' | 'base'
  /** 每条抬升一个理由——供 headless stderr 与 run log 对账。 */
  rationale: string[]
}

/**
 * 历史地板：任一样本耗尽预算（`exhausted`）或逼近当次上限（≥0.8）才抬——
 * 没挨过墙的任务不该涨预算（与 budget-shape.historyBudgetFloor 同判据）。
 * 返回的是**地板建议值**，调用方取 max 后仍受双帽约束。
 */
function historyFloor(
  samples: readonly GoalActualSample[] | undefined,
  current: number,
): number | undefined {
  const valid = (samples ?? []).filter(
    (s): s is GoalActualSample => Boolean(s) && Number.isFinite(s?.iterationsUsed) && s.iterationsUsed > 0,
  )
  if (valid.length === 0) return undefined
  const triggered = valid.some(s =>
    s.exhausted === true
    || s.iterationsUsed >= NEAR_MISS_RATIO * (s.budget?.maxIterations ?? current))
  if (!triggered) return undefined
  const maxUsed = Math.max(...valid.map(s => s.iterationsUsed))
  return Math.ceil(maxUsed * TURNS_FROM_ITERATIONS * EXHAUSTION_HEADROOM)
}

/**
 * 纯函数核心：goal 文本 + 历史样本 → 预算地板。
 *
 * 只抬不降——返回值永不低于 base；显式 `--budget` 直接短路（用户意图优先）。
 * 信号全缺席 = 纯默认（行为零变化）。
 */
export function sizeGoalBudget(input: GoalBudgetInput): GoalBudgetDecision {
  // 显式值短路：用户意图优先。**必须校验 > 0**——负值/0 穿透成 maxIterations 后，
  // 下游 turn-orchestrator 的 `maxTurns > 0` 判据会把上限静默 fail-open 成
  // Number.MAX_SAFE_INTEGER（等于无上限）。非法值一律当"没给"，回落形状定价。
  if (input.explicitBudget !== undefined && Number.isFinite(input.explicitBudget) && input.explicitBudget > 0) {
    return {
      maxIterations: input.explicitBudget,
      source: 'explicit',
      rationale: [`explicit --budget ${input.explicitBudget}`],
    }
  }

  const rawBase = input.base
  const base = typeof rawBase === 'number' && Number.isFinite(rawBase) && rawBase > 0
    ? Math.floor(rawBase)
    : GOAL_BUDGET_BASE

  if (!goalBudgetShapeEnabled()) {
    return { maxIterations: base, source: 'base', rationale: [`base=${base}`, 'shape disabled (RIVET_GOAL_BUDGET_SHAPE=0)'] }
  }

  const rationale: string[] = [`base=${base}`]
  let shaped = base

  const files = countMentionedPaths(input.goal)
  if (files.length >= 2) {
    const candidate = base + TURNS_PER_MENTIONED_FILE * (files.length - 1)
    if (candidate > shaped) shaped = candidate
    rationale.push(`+${TURNS_PER_MENTIONED_FILE}x${files.length - 1} files (${files.length} mentioned)`)
  }

  if (hasLargeScopeSignal(input.goal)) {
    const candidate = base * 2
    if (candidate > shaped) shaped = candidate
    rationale.push('large-scope signal (base x2)')
  }

  const floor = historyFloor(input.history, base)
  if (floor !== undefined && floor > shaped) {
    shaped = floor
    rationale.push(`history floor ${floor} (exhausted / near-miss sample)`)
  }

  const clamped = Math.min(GOAL_BUDGET_CEIL, Math.max(base, shaped))
  return {
    maxIterations: clamped,
    source: clamped > base ? 'shaped' : 'base',
    rationale: clamped < shaped ? [...rationale, `capped at ${GOAL_BUDGET_CEIL}`] : rationale,
  }
}

/**
 * 接线层入口（main.ts 唯一消费点）：CLI 解析结果 → 一次定价决策。
 *
 * 非 goal 调用返回 undefined —— `-p` 的 15 轮帽走 RIVET_HEADLESS_MAX_TURNS，
 * 与形状定价无关。`parsed.budget` 缺席即"用户没给"（解析层不预置缺省，
 * 见 headless.ts 的注释），显式值由 sizeGoalBudget 短路。
 *
 * `loadHistory` 惰性：显式 `--budget` 时**不读**历史——不为一次短路去开数据库。
 * 读取本身 best-effort，抛错即视为"没有历史"。
 */
export function resolveGoalBudget(
  parsed: { goal?: string; budget?: number },
  loadHistory?: () => readonly GoalActualSample[],
): GoalBudgetDecision | undefined {
  if (!parsed.goal) return undefined
  const explicit = parsed.budget
  // 非法显式值（≤0 / NaN）等同"没给"——必须走下面的历史分支，否则会既拿到
  // 非正上限、又跳过历史读取。
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return sizeGoalBudget({ goal: parsed.goal, explicitBudget: explicit })
  }
  let history: readonly GoalActualSample[] | undefined
  if (loadHistory) {
    try {
      history = loadHistory()
    } catch {
      history = undefined
    }
  }
  return sizeGoalBudget({ goal: parsed.goal, history })
}
