import type { Sensorium } from './sensorium.js'

// ─── Star Phase ─────────────────────────────────────────────────────

/**
 * StarFlow v2 phases — dynamically driven by Sensorium rather than
 * hardcoded sequence. Each phase maps to a star (from the StarFlow
 * personality system) and has a distinct TUI glyph.
 */
export type StarPhase =
  | 'tianshu-planning'   // ◐ 观局 — 天枢规划
  | 'tianxuan-locating'  // ⚙ 寻迹 — 天璇定位
  | 'tianji-decomposing' // ⚙ 拆解 — 天玑拆解
  | 'tianquan-contracting' // ◐ 立约 — 天权立约
  | 'yuheng-implementing'  // ✦ 铸形 — 玉衡实现
  | 'kaiyang-testing'      // ❧ 试锋 — 开阳测试
  | 'yaoguang-delivering'  // ❧ 归航 — 摇光交付
  | 'tianshu-encore'       // ◐ 再临 — 天枢再临

/** Human-readable labels for each phase. */
export const PHASE_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '天枢 · 观局授策',
  'tianxuan-locating': '天璇 · 寻迹定位',
  'tianji-decomposing': '天玑 · 排阵拆解',
  'tianquan-contracting': '天权 · 立约定标',
  'yuheng-implementing': '玉衡 · 铸形实现',
  'kaiyang-testing': '开阳 · 试锋验证',
  'yaoguang-delivering': '摇光 · 归航交付',
  'tianshu-encore': '天枢 · 再临歧路',
}

/** Glyphs for TUI rendering. */
export const PHASE_GLYPHS: Record<StarPhase, string> = {
  'tianshu-planning': '◐',   // 天枢观局
  'tianxuan-locating': '⚙',  // 天璇寻迹
  'tianji-decomposing': '⚙', // 天玑拆解
  'tianquan-contracting': '◐', // 天权立约
  'yuheng-implementing': '✦',  // 玉衡铸形
  'kaiyang-testing': '❧',      // 开阳试锋
  'yaoguang-delivering': '❧',  // 摇光交付
  'tianshu-encore': '◐',       // 天枢再临
}

/** Short Chinese labels for strip display (≤5 chars). */
export const PHASE_SHORT_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '观局',
  'tianxuan-locating': '寻迹',
  'tianji-decomposing': '拆解',
  'tianquan-contracting': '立约',
  'yuheng-implementing': '铸形',
  'kaiyang-testing': '试锋',
  'yaoguang-delivering': '归航',
  'tianshu-encore': '再临',
}

// ─── Star Event ─────────────────────────────────────────────────────

/**
 * Runtime context needed to map a Sensorium snapshot to a StarPhase.
 * Fields not derivable from Sensorium alone.
 */
export interface StarPhaseContext {
  turn: number
  isWriting: boolean
  isRunningTests: boolean
  isFinalTurn: boolean
  /** YOLO（无上限轮次）下的归航证据门：交付验证通过时为真（2026-07-25）。
   *  有界会话恒为 false/缺省——归航仍只认最终轮。 */
  readyByEvidence?: boolean
  /** True if complexity > 0.5 was ever reached this session.
   *  Enables contracting phase (plan was decomposed, now settled). */
  hasEnteredHighComplexity: boolean
  /** 窗口内有后台 job 在推进（2026-10-09）：后台跑测试/构建时主线程「空闲」
   *  是假空闲——不得因此退回规划兜底相位。 */
  backgroundWorkActive?: boolean
  /** 上一相位（同一 run 内的相位记忆）。plan 类相位的进入门禁：
   *  执行/验证/交付中的会话不得无进入信号退回规划——「还没交付就又进 plan」
   *  的误报会引导出错误的收敛话术（2026-10-09 用户报告）。 */
  previousPhase?: StarPhase
}

/** plan 类相位（进入需要信号）。探索（locating）不在其列——explore→plan 是早期自然流。 */
const PLAN_CLASS_PHASES: ReadonlySet<StarPhase> = new Set(['tianshu-planning', 'tianji-decomposing', 'tianquan-contracting'])
/** 已在干活/验证/交付的相位——退回 plan 类必须被门禁挡住。 */
const WORKING_PHASES: ReadonlySet<StarPhase> = new Set(['yuheng-implementing', 'kaiyang-testing', 'yaoguang-delivering'])

/**
 * Emitted whenever the star phase changes.
 * Carries the phase, the full Sensorium snapshot, and metadata
 * for TUI rendering and debugging.
 */
export interface StarEvent {
  phase: StarPhase
  sensorium: Sensorium
  turn: number
  timestamp: number
  label: string
  glyph: string
}

// ─── Phase Mapping ──────────────────────────────────────────────────

/**
 * Map a Sensorium snapshot + runtime context to a StarPhase.
 *
 * Priority order (first match wins):
 * 1. Testing: isRunningTests → 试锋
 * 2. Delivering: momentum>0.8 + (isFinalTurn | readyByEvidence) → 归航
 * 3. Implementing: confidence>0.6 + isWriting → 铸形
 * 4. Decomposing: complexity>0.5 → 排阵
 * 5. Contracting: wasHighComplexity + confidence>0.7 + complexity<0.4 + !writing + !testing → 立约
 * 6. Locating: freshness>0.7 → 寻迹
 * 7. Default: freshness>0.4 ? 寻迹 : 请星
 *
 * 请星（tianshu-encore）不由本映射产出——它的活体入口是 kick-hook 的
 * `shouldEscalateFromKick`（confidence<0.2 && complexity>0.5）。此前这里还有两条
 * 以 `ctx.shouldEscalate` 为前置的分支（Encore / 首轮 Planning），而 5ae389d1 把
 * `deriveStrategy().shouldEscalate` 关成恒 false 后它们再无可达路径，已随本次清理
 * 移除；`StarPhaseContext` 也不再携带该字段。
 */
export function mapSensoriumToPhase(
  s: Sensorium,
  ctx: StarPhaseContext,
): StarPhase {
  const phase = computePhaseFromSensorium(s, ctx)
  // 后台活动守卫：后台有活在跑（job 在跑测试/构建）时主线程「空闲」是假空闲——
  // 不落「规划」兜底相位（2026-10-09：写码任务在后台 job 里跑时被误报 plan 阶段停滞）。
  if (ctx.backgroundWorkActive && phase === 'tianshu-planning') return 'tianxuan-locating'
  // plan 相位进入门禁：执行/验证/交付中的会话退回 plan 类需要明确的进入信号
  // （新 run 首评没有 previousPhase，不受影响；perception.reset() 在每个新用户
  // run 起点清空相位记忆）。「还没交付就又进 plan」的退回会把收敛话术引向错误相位。
  if (ctx.previousPhase && WORKING_PHASES.has(ctx.previousPhase) && PLAN_CLASS_PHASES.has(phase)) {
    return ctx.previousPhase
  }
  return phase
}

function computePhaseFromSensorium(
  s: Sensorium,
  ctx: StarPhaseContext,
): StarPhase {
  // 1. Testing
  if (ctx.isRunningTests) {
    return 'kaiyang-testing'
  }

  // 2. Delivering: high momentum on final turn (or YOLO evidence gate)
  // W4（2026-07-25）：momentum 需实测才可信——no-data 回退 0 本就不会命中
  // >0.8，显式守卫钉死意图（防未来阈值调整误引入 no-data 误判）。
  // 复盘修复（2026-07-25）：YOLO 无最终轮，readyByEvidence（交付验证通过）
  // 作为归航的替代证据门，否则 delivering / ready_to_deliver 结构性不可达。
  if ((s.quality?.momentum ?? 'measured') !== 'no-data' && s.momentum > 0.8
      && (ctx.isFinalTurn || ctx.readyByEvidence === true)) {
    return 'yaoguang-delivering'
  }

  // 3. Implementing: confident + writing code
  if (s.confidence > 0.6 && ctx.isWriting) {
    return 'yuheng-implementing'
  }

  // 4. Decomposing: high complexity
  if (s.complexity > 0.5) {
    return 'tianji-decomposing'
  }

  // 5. Contracting: plan was complex, now settled → 立约
  if (ctx.hasEnteredHighComplexity && s.confidence > 0.7 && s.complexity < 0.4 && !ctx.isWriting && !ctx.isRunningTests) {
    return 'tianquan-contracting'
  }

  // 6. Locating: high freshness (familiar codebase)
  if (s.freshness > 0.7) {
    return 'tianxuan-locating'
  }

  // 7. Default: locating/planning based on freshness。本仓语料里 freshness 最低
  // 0.57（901 帧），这一分叉的 planning 侧从未命中——但那是语料特性不是结构：
  // computeFreshness 在信息素弱且 git/fs 变更率高时可以低到 0，别当恒真删掉。
  return s.freshness > 0.4 ? 'tianxuan-locating' : 'tianshu-planning'
}

// ─── StarEvent Factory ──────────────────────────────────────────────

/**
 * Create a StarEvent from a Sensorium snapshot and context.
 * Pure function — deterministic, no side effects.
 */
export function createStarEvent(
  s: Sensorium,
  ctx: StarPhaseContext,
): StarEvent {
  const phase = mapSensoriumToPhase(s, ctx)
  return {
    phase,
    sensorium: s,
    turn: ctx.turn,
    timestamp: Date.now(),
    label: PHASE_LABELS[phase],
    glyph: PHASE_GLYPHS[phase],
  }
}

// ─── Theta-Gamma Rhythm ─────────────────────────────────────────────

/**
 * State tracker for theta-gamma cross-file consistency checks.
 *
 * Theta Phase Machine (upgraded from simple counter):
 * - Phase ∈ [0, 1): [0, 0.5) = ENCODING (receiving), [0.5, 1) = RETRIEVAL (reflection)
 * - Phase advances on each tool call, modulated by vigor and complexity
 * - Theta checks only fire in RETRIEVAL phase (momentum-gated)
 * - High vigor → slower phase advance (longer encoding, preserve flow)
 * - High complexity → faster phase advance (more frequent consistency checks)
 *
 * Enabled only when Sensorium.complexity > 0.5.
 */
export interface ThetaState {
  toolCallCount: number
  lastThetaAt: number
  interval: number
  /** Normalized phase [0, 1). 0 = start of encoding, 0.5 = retrieval boundary. */
  phase: number
  /** Number of times the phase has wrapped (cycled through a full rotation). */
  cycleCount: number
}

export function createThetaState(interval = 7): ThetaState {
  return { toolCallCount: 0, lastThetaAt: 0, interval, phase: 0, cycleCount: 0 }
}

/** Theta phase mode: encoding (receiving) or retrieval (reflection). */
export type ThetaPhase = 'encoding' | 'retrieval'

/** Get the current phase mode. [0, 0.5) → encoding, [0.5, 1) → retrieval. */
export function getThetaPhase(state: ThetaState): ThetaPhase {
  return state.phase < 0.5 ? 'encoding' : 'retrieval'
}

/**
 * Advance the theta counter and phase.
 * Returns true if it's time for a cross-file consistency check AND
 * the phase is in retrieval mode (momentum-safe).
 */
export function tickTheta(state: ThetaState, _currentTurn: number): boolean {
  const next = state.toolCallCount + 1
  const due = next - state.lastThetaAt >= state.interval
  if (!due) return false
  // Phase gate: only fire theta checks during retrieval phase
  return state.phase >= 0.5
}

/**
 * Mark a theta check as completed, resetting the counter
 * and wrapping the phase back to encoding.
 */
export function completeTheta(state: ThetaState): ThetaState {
  return {
    ...state,
    toolCallCount: state.toolCallCount,
    lastThetaAt: state.toolCallCount,
    // Wrap phase back to start of encoding
    phase: 0,
    cycleCount: state.cycleCount + 1,
  }
}

export interface ThetaPhaseInput {
  /** Integrated behavioral energy [0, 1]. Higher = more encoding time. */
  vigor: number
  /** Task complexity [0, 1]. Higher = more frequent checks. */
  complexity: number
}

/**
 * Advance tool call counter AND phase.
 *
 * Phase step size is modulated by:
 * - vigor: high vigor → slower advance (preserve encoding flow)
 * - complexity: high complexity → faster advance (need more checks)
 *
 * A full phase cycle = interval tool calls at baseline.
 * Modulation scales the step by (1 - vigor * 0.4) * (0.5 + complexity * 0.5).
 */
export function advanceThetaCounter(state: ThetaState, phaseInput?: ThetaPhaseInput): ThetaState {
  const next = { ...state, toolCallCount: state.toolCallCount + 1 }

  if (!phaseInput) {
    // No modulation input → simple linear advance
    const step = 1 / (state.interval || 7)
    const newPhase = (state.phase + step) % 1
    const cycles = Math.floor((state.phase + step))
    return {
      ...next,
      phase: newPhase,
      cycleCount: state.cycleCount + cycles,
    }
  }

  const { vigor, complexity } = phaseInput
  const baseStep = 1 / (state.interval || 7)

  // Modulation: vigor slows phase (preserve flow), complexity accelerates (need checks)
  // Range: [0.3, 1.3] × baseStep
  const vigorMod = 1 - vigor * 0.4   // [0.6, 1.0] — high vigor = slower
  const complexityMod = 0.5 + complexity * 0.5  // [0.5, 1.0] — high complexity = faster
  const step = baseStep * vigorMod * complexityMod

  const rawPhase = state.phase + step
  const newPhase = rawPhase % 1
  const cycles = Math.floor(rawPhase)

  return {
    ...next,
    phase: newPhase,
    cycleCount: state.cycleCount + cycles,
  }
}
