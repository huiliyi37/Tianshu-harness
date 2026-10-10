import { buildInjectedMessage, type MessageVariant } from './convergence-message.js'
/**
 * Multi-Signal Convergence Detector
 *
 * Detects agent stagnation by computing a composite convergence score from
 * orthogonal progress signals over a sliding window. Thresholds adapt to
 * context window size (200K vs 1M) and current phase class.
 *
 * Design: docs/superpowers/plans/2026-06-01-convergence-detector.md
 */

import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { EvidenceState } from './evidence.js'
import { WRITE_TOOL_NAMES } from '../tools/write-tool-helpers.js'
import type { EditExpectation } from './edit-expectation.js'
import { analyzeScoreDecline, effectiveScoreRegimeKey, type ConvergenceScoreHistoryEntry } from './score-history.js'

// ─── Types ──────────────────────────────────────────────────────────

import type { PhaseClass } from './phase-class.js'
export type { PhaseClass } from './phase-class.js'

export interface ConvergenceInput {
  /** Current turn number (0-based from AgentLoop) */
  turn: number
  /** Current phase class */
  phaseClass: PhaseClass
  /** Context window size (200_000 or 1_000_000) */
  contextWindow: number
  /** Recent tool history (last N entries) */
  recentToolHistory: ReadonlyArray<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'argsHash' | 'bashActivity' | 'writeOutcome'>>
  /** Evidence state with edit/verification tracking */
  evidenceState: Pick<EvidenceState, 'filesModified' | 'filesRead' | 'deliveryStatus'>
  /** Optional tool call fingerprints for oscillation detection (A→B→A→B patterns). */
  toolFingerprints?: ReadonlyArray<string>
  /** Number of consecutive turns with no tool calls. Used to detect text-only
   *  stagnation (model hesitates, repeats itself, or produces thinking without
   *  action). Tool-based signals can't see these turns since recentToolHistory
   *  only grows on tool execution. */
  noToolTurnCount?: number
  /** Recent turn text fingerprints (whitespace-normalized trimmed text).
   *  Used to detect cross-turn text repetition — the model produces similar
   *  analysis text over multiple turns without making progress. */
  textFingerprints?: ReadonlyArray<string>
  /** Content-free observations from the same text signal extractor (replay). */
  textObservation?: { count: number; repetitionPenalty: number; hasData: boolean; hasReportLength: boolean }
  /** Provider name for provider-specific thresholds (e.g. 'glm' gets tighter cutoffs).
   *  When absent, uses default DeepSeek-tuned values. */
  providerName?: string
  /** **近期工具观测窗口内的主轮输出增量**（不是会话累计）。
   *
   *  S1 效率时间尺度（2026-10-02 修复）：分子是窗口增量、分母是窗口工具数，
   *  两者必须同时间尺度。旧实现传 `session.getTotalUsage().output_tokens`
   *  （会话累计），长会话里 tokensPerTool = 累计/5 迅速爆炸 → exp(-huge) ≈ 0
   *  → tokenEfficiency 恒 0 的伪停滞信号。累计成本对"这五个工具花了多少输出"
   *  是不可见的（历史已发生），必须由调用方按窗口做差。
   *  口径：只含主轮输出（不含 spec 预测/压缩总结等侧路成本），见
   *  `SessionContext.getMainPathOutputTokens`。
   *  When absent (无窗口样本), falls back to the old tool-classification heuristic. */
  outputTokens?: number
  /** Number of times the SAME message variant has been previously emitted
   *  (before the current evaluation). Used by buildInjectedMessage to add a
   *  progressive "第 N 次提醒" prefix — 0 = first time, no prefix. */
  repeatCount?: number
  /** Hard progress beacons that override the soft stagnation heuristics
   *  (novelty/entropy/token-efficiency). A session whose todo list is
   *  advancing, or that is executing an approved plan, is NOT stuck no
   *  matter what the trajectory-shape signals say — incident 20b9714e:
   *  32 convergence advisories (0 adopted) fired on a healthy plan run. */
  progressBeacons?: {
    /** Completed-todo count increase over the recent signal window.
     *  > 0 = the task list is demonstrably advancing → cap score-based
     *  escalation at L1 (no-tool stagnation levels are unaffected). */
    todoCompletedDelta: number
    /** 等待验证（2026-10-10 狂轰事故方向 2，会话 20261009c40f5c2262ea）：后台有
     *  running 的验证型 job——agent 正在等门禁钦定的证据。判据不再由 detector
     *  侧猜命令：由 spawn 侧（tools/bash.ts）写入 SessionJobs 的私有验证元数据
     *  （SessionJobs.waitingVerificationJob()，源自共同命令事实
     *  VerificationExecutionIntent 的 waitingEligible）。执行相位的
     *  「无编辑」是等待的合理形态 → 与 todoCompletedDelta 同级的硬 veto：
     *  cap score-based escalation at L1。job 结束信标即消失，仍停滞则正常
     *  升级；no-tool stagnation levels 不受影响（不变式同 todo 注释）。 */
    awaitingVerification?: boolean
    /** An approved plan file is active (plan execution session). Long
     *  multi-wave turns are the legitimate shape of this work — widen the
     *  nLow/nMid/nHigh turn thresholds by 1.5×. */
    activePlan: boolean
    /** P1 心流保护：Sensorium 原始快照字段。工具成功率与推进因子由
     *  detector 内部按 tier.signalWindow 计算（窗口与其它信号一致，
     *  避免调用方自带第二个窗口常量）。缺席 = Sensorium 不存在 →
     *  不进入保护态，旧行为不变。 */
    flowInputs?: FlowInputs
    /** P2 阴阳调度：structure-flow 控制器输出的软阈值偏移量 [0, 0.25]。
     *  与 flowInputs **互斥**（同一 flow 信号绝不计两次）：本字段存在时
     *  优先生效并忽略 flowInputs（单声源仲裁——两者同传视为装配错误）。
     *  0 也是有效值：P2 hardTighten（PAL 未决/验证债务/用户干预）时传 0，
     *  正确压过 P1 的放宽。只触 nLow/nMid/nHigh，不碰 no-tool 熔断、
     *  score-abort grace 与 signalWindow/maxTurns。 */
    structureRelaxation?: number
  }
  /** W3：会话活动模式（classifyActivityMode 的结果，由调用方传入）。
   *  diagnostic 时收敛文案分流为"先核实断言再收束"。 */
  activityMode?: ActivityMode
  runtimeAdvice?: string
  /** Turns since current phaseClass was set. 1 = first turn in this phase.
   *  Used to suppress productive-stagnation during the cooling period after
   *  a phase transition. When absent, defaults to Infinity (no cooldown —
   *  backward compatible: callers that don't track phase transitions get
   *  the original unstifled stagnation detection). */
  phaseRelativeTurn?: number
  /** Score history from recent turns (most recent last). Used to detect
   *  sustained decline vs isolated dip for L3 score-based abort decisions.
   *  Length should be ≥ signalWindow for meaningful trend detection.
   *  P3：条目可带口径键（regimeKey）与质量——趋势只取末尾连续、同口径、
   *  有效的样本；纯 number 为 legacy 样本（旧行为逐位不变）。 */
  scoreHistory?: ReadonlyArray<ConvergenceScoreHistoryEntry>
  /** 当前评分所属口径；旧调用缺省时保留 legacy 行为。 */
  scoreRegimeKey?: string | null
  /** True if an L2+ convergence advisory was already emitted in a strictly
   *  earlier turn. This is the grace-turn precondition for score-based L3
   *  aborts: the model must have been warned before we conclude it ignored
   *  the guidance. */
  priorWarningAtL2Plus?: boolean
  /**
   * W4 噪音洪流修复：最近工具调用中 status='failed' 的占比 [0, 1]。
   * ≥ 0.4 时判定 agent 遭遇工具错误受阻（如 gitignore 拒绝读取），
   * 此时收敛 score 降级——agent 在绕工具 bug 不是 doom-loop。
   * 缺席时走旧行为（向后兼容）。由 loop.ts runConvergenceCheck 计算。 */
  recentToolErrorRatio?: number
  /**
   * P1 编辑期待投影（任务语义 × 当前步骤）。缺席 → 按 'required' 处理
   * （旧行为逐位不变）。not-required/unknown 时 editRatio 不参与评分
   * （权重按原比例归一 + 关闭乘半惩罚）——错误的相位标签不能仅因无编辑
   * 把已确认验证/只读步骤压到 L2；required 时保留原惩罚（正例仍提示）。
   */
  editExpectation?: EditExpectation
  /**
   * P1 重复验证软判据摘要（loop 从 WorkProgressFacts 预计算）。命中时在
   * level 仲裁（todo/等待 veto 之前）把 level 上探到 2——只提出收束/换策略，
   * 不独立触发 L3 abort/split；不越过真实等待保护。
   */
  repeatedVerification?: {
    count: number
    currentRerun: boolean
    turnsSinceProgress: number
  }
}

/** W3（incident 20b9714e）：会话活动模式。diagnostic = 近窗口以只读工具为主
 *  且零改动（日志排查/根因分析类）。此类会话被催收敛时的正确处方是
 *  "先核实断言再收束"，而不是"输出结论"——后者直接诱发脑补。 */
export type ActivityMode = 'diagnostic' | 'build'

// ─── P1 心流保护：正向推进证据（flow beacon）────────────────────────
//
// 健康执行流（工具连续成功、动量/稳定性高、任务推进）不该被轨迹形状
// 启发式当成停滞（incident 20b9714e：健康 plan run 收到 32 条 0 采纳的
// 收敛 advisory）。flow beacon 以连续、有界的方式延后 score-based 软阈值；
// no-tool 硬熔断、productive stagnation、score-abort 双护栏均不受影响。

/** 调用方透传的 Sensorium 原始快照字段（loop 侧三行透传，无计算）。 */
export interface FlowInputs {
  /** Sensorium.momentum 直接值（预测准确率滑动窗口成功率）。 */
  momentum: number
  /** quality.momentum !== 'no-data'——窗口为空的 0 回退不算"低心流"证据。 */
  momentumHasData: boolean
  /** Sensorium.stability 直接值。 */
  stability: number
}

export interface FlowBeacon {
  /** 0..1 心流分数；权重固定可审计（见 computeFlowBeacon）。 */
  score: number
  /** 窗口内已结算（success|failed）工具样本数——running 在途样本从
   *  分子分母同时剔除，否则并行 background 工具在途的健康轮会被压分。 */
  sampleCount: number
}

export interface FlowBeaconInput extends FlowInputs {
  recentToolHistory: ReadonlyArray<Pick<ToolHistoryEntry, 'status'>>
  todoCompletedDelta: number
  signalWindow: number
}

/** 保护态最小已结算样本数——低于此不放宽任何阈值（缺数据 ≠ 好数据）。 */
export const FLOW_MIN_SAMPLES = 4
/** flow=1 时的最大阈值放宽倍率增量（1.0×–1.3× 连续映射）。 */
export const FLOW_MAX_BONUS = 0.3

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 纯函数：从当前窗口快照计算 flow beacon。无 IO、无时钟、无随机——
 * 同输入同输出。
 *
 * 固定权重（经验起点，Wave 3 回放后校准；校准前不得被其它子系统引用）：
 *   0.4 工具成功率（唯一逐调用实测的行为信号）
 * + 0.3 momentum（Sensorium 聚合，自带平滑）
 * + 0.2 stability（同上）
 * + 0.1 todo 推进（已有独立 L1 veto 兜底，此处仅轻微加成避免双重计权）
 *
 * momentumHasData=false 时 momentum 因子记 0，且消费方的资格门会整体
 * 拦截——这里的 0 只是防御性下限，不承担"缺数据 = 低心流"语义。
 */
export function computeFlowBeacon(input: FlowBeaconInput): FlowBeacon {
  const window = input.recentToolHistory.slice(-Math.max(1, input.signalWindow))
  const settled = window.filter(h => h.status === 'success' || h.status === 'failed')
  const sampleCount = settled.length
  const toolSuccessRatio = sampleCount > 0
    ? settled.filter(h => h.status === 'success').length / sampleCount
    : 0
  const momentumFactor = input.momentumHasData ? clamp01(input.momentum) : 0
  const stabilityFactor = clamp01(input.stability)
  const todoFactor = clamp01(input.todoCompletedDelta / 2)
  const score = clamp01(
    0.4 * toolSuccessRatio
    + 0.3 * momentumFactor
    + 0.2 * stabilityFactor
    + 0.1 * todoFactor,
  )
  return { score, sampleCount }
}

/** 诊断态判定窗口（近 N 条工具调用） */
const ACTIVITY_MODE_WINDOW = 8
/** 诊断态只读占比门槛 */
const DIAGNOSTIC_READONLY_RATIO = 0.8

/**
 * W3：从工具轨迹 + 改动数分类会话活动模式。
 *
 * diagnostic 判据（窗口语义）：窗口内样本 ≥4、无编辑工具、只读占比 ≥0.8。
 * bash 是否只读由执行记录器基于完整 command 预先标注；这里不再从已截断 target
 * 反推。缺少标签的历史条目 fail-closed 为 productive。`filesModifiedCount` 不参与
 * 判定（保留下划线标记弃用）——曾改过代码但最近 N 轮纯只读的会话（verify 阶段、
 * 排查回归）也能回到 diagnostic，收到"核实断言后收束"的正确处方。
 */
export function classifyActivityMode(
  recentToolHistory: ReadonlyArray<Pick<ToolHistoryEntry, 'tool' | 'target' | 'bashActivity'>>,
  _filesModifiedCount: number,
  window = ACTIVITY_MODE_WINDOW,
): ActivityMode {
  // 滑动窗口内检测编辑工具——而非全局累计 filesModifiedCount。
  // 曾改过代码但最近 N 轮纯只读的会话（如 verify 阶段、排查回归）
  // 应能回到 diagnostic 分类，收到"核实断言后收束"的正确处方。
  const editTools = new Set(['edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit'])
  const windowSlice = recentToolHistory.slice(-window)
  if (windowSlice.length > 0 && windowSlice.some(h => editTools.has(h.tool))) return 'build'
  if (windowSlice.length < 4) return 'build'
  const readOnly = windowSlice.filter(h => isReadOnlyToolCall(h.tool, h.bashActivity)).length
  return readOnly / windowSlice.length >= DIAGNOSTIC_READONLY_RATIO ? 'diagnostic' : 'build'
}

export interface ConvergenceResult {
  /** Composite score 0-1 (1 = fully converging, 0 = stuck) */
  score: number
  /** Escalation level */
  level: 0 | 1 | 2 | 3
  /** Should the loop abort? */
  shouldAbort: boolean
  /** Level 2+: message to inject as user guidance */
  injectedMessage: string | null
  /** Level 2+：注入消息的结构化变体标识（Layer 2，与 injectedMessage 同生同灭）。 */
  messageVariant: MessageVariant | null
  /** Level 2+: should a dissipative kick be applied? */
  shouldKick: boolean
  /** Level 3: should we force a session split? */
  shouldForceSplit: boolean
  /** Individual signal values for diagnostics */
  signals: ConvergenceSignals
  /**
   * When shouldAbort is true, why. 'no-tool' = consecutive no-tool hard cap;
   * 'score' = score-based level-3 abort. undefined when not aborting. Lets the
   * loop tag the stop-reason accurately without re-deriving the cause.
   */
  abortCause?: 'no-tool' | 'score'
  /**
   * Whether the model was still emitting fresh, substantial, non-repetitive
   * analysis (producingReport) when this was evaluated. When true, a no-tool
   * hard cap is downgraded from a hard abort to a kick — a deep-reasoning model
   * narrating multi-turn analysis is thinking, not spinning. Score-based
   * convergence aborts are unaffected (they measure orthogonal stagnation
   * signals). Surfaced so a near-miss (reasoning that almost got熔断) is
   * diagnosable.
   */
  reasoningActive: boolean
  /**
   * P1：评分口径质量。'insufficient' = 所有信号都缺数据/不可适用，
   * 分数没有有效证据支撑——此时不按分数分级（不补满分、也不误伤）。
   */
  scoreQuality: 'ok' | 'insufficient'
  /**
   * P3：本轮实际参与加权的有效权重（editRatio 期待归一与缺数据重分配后；
   * 不含 penalty 乘数）。观测/回放消费——不同权重口径的分数不可直接比较
   * （见 score-history.regimeKey）。
   */
  effectiveWeights: PhaseWeights
  scoreRegimeKey?: string | null
}

export interface ConvergenceSignals {
  editRatio: number
  targetNovelty: number
  toolEntropy: number
  errorPenalty: number
  tokenEfficiency: number
  /** 0-1 penalty for alternating tool patterns (A→B→A→B). 0 = severe oscillation, 1 = no oscillation. */
  oscillationPenalty: number
  /** 0-1 penalty for cross-turn text repetition. 0 = severe repetition (same text), 1 = no repetition. */
  textRepetitionPenalty: number
}

// ─── Window-aware Thresholds ────────────────────────────────────────

export interface WindowTier {
  maxTurns: number
  nLow: number
  nMid: number
  nHigh: number
  signalWindow: number
  label: string
}

const WINDOW_TIER_200K: WindowTier = {
  maxTurns: 30,
  nLow: 8,
  nMid: 14,
  nHigh: 20,
  signalWindow: 6,
  label: '200K',
}

const WINDOW_TIER_1M: WindowTier = {
  maxTurns: 50,
  nLow: 25,
  nMid: 34,
  nHigh: 42,
  signalWindow: 10,
  label: '1M',
}

/**
 * Select the appropriate tier based on context window size.
 * Linear interpolation between 200K and 1M for intermediate sizes.
 */
function selectTier(contextWindow: number): WindowTier {
  if (contextWindow <= 200_000) return WINDOW_TIER_200K
  if (contextWindow >= 1_000_000) return WINDOW_TIER_1M

  // Linear interpolation for intermediate window sizes
  const ratio = (contextWindow - 200_000) / (1_000_000 - 200_000)
  return {
    maxTurns: Math.round(lerp(WINDOW_TIER_200K.maxTurns, WINDOW_TIER_1M.maxTurns, ratio)),
    nLow: Math.round(lerp(WINDOW_TIER_200K.nLow, WINDOW_TIER_1M.nLow, ratio)),
    nMid: Math.round(lerp(WINDOW_TIER_200K.nMid, WINDOW_TIER_1M.nMid, ratio)),
    nHigh: Math.round(lerp(WINDOW_TIER_200K.nHigh, WINDOW_TIER_1M.nHigh, ratio)),
    signalWindow: Math.round(lerp(WINDOW_TIER_200K.signalWindow, WINDOW_TIER_1M.signalWindow, ratio)),
    label: `${Math.round(contextWindow / 1000)}K`,
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ─── Phase-Aware Weights ────────────────────────────────────────────

export interface PhaseWeights {
  editRatio: number
  targetNovelty: number
  toolEntropy: number
  errorPenalty: number
  tokenEfficiency: number
  oscillationPenalty: number
  textRepetitionPenalty: number
}

const PHASE_WEIGHTS: Record<PhaseClass, PhaseWeights> = {
  explore: { editRatio: 0.05, targetNovelty: 0.25, toolEntropy: 0.20, errorPenalty: 0.12, tokenEfficiency: 0.13, oscillationPenalty: 0.10, textRepetitionPenalty: 0.15 },
  plan:    { editRatio: 0.15, targetNovelty: 0.18, toolEntropy: 0.15, errorPenalty: 0.13, tokenEfficiency: 0.18, oscillationPenalty: 0.10, textRepetitionPenalty: 0.11 },
  execute: { editRatio: 0.40, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.18, tokenEfficiency: 0.08, oscillationPenalty: 0.06, textRepetitionPenalty: 0.12 },
  verify:  { editRatio: 0.05, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.35, tokenEfficiency: 0.18, oscillationPenalty: 0.12, textRepetitionPenalty: 0.14 },
  deliver: { editRatio: 0.15, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.25, tokenEfficiency: 0.24, oscillationPenalty: 0.08, textRepetitionPenalty: 0.12 },
}

// ─── Signal Computation ─────────────────────────────────────────────

/**
 * Compute Shannon entropy normalized to [0, 1].
 * A uniform distribution of N tools has entropy = ln(N), max entropy = ln(N).
 */
function normalizedShannonEntropy(distribution: Map<string, number>, total: number): number {
  if (total === 0 || distribution.size <= 1) return 0.0
  const n = distribution.size
  const maxEntropy = Math.log(n)
  let entropy = 0
  for (const count of distribution.values()) {
    const p = count / total
    entropy -= p * Math.log(p)
  }
  return maxEntropy > 0 ? entropy / maxEntropy : 0.0
}

/**
 * editRatio: fraction of the window that produced real edits.
 *
 * P1 口径（共享写工具族 + 执行效果）：
 * - 写工具族 = WRITE_TOOL_NAMES（edit_file/write_file/hash_edit/ast_edit/apply_patch）——
 *   旧实现只认前两个，其余写工具的编辑不计入比率。
 * - writeOutcome='changed' 才计编辑；'unchanged'（no-op/预览）确认无变化，不计；
 *   'unknown'（失败/回滚/无目标）从分子分母都剔除——不伪造 0 或 1。
 * - writeOutcome 缺席（旧条目/未接线）按旧口径处理（success 即编辑），
 *   保证未接线路径逐位不变。
 * - 窗口里写工具效果全部不可判（denom=0）→ 信号不可用（insufficient），
 *   走统一的权重处理而非额外惩罚。
 */
function computeEditRatio(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): { value: number; insufficient: boolean } {
  const window = history.slice(-windowSize)
  if (window.length === 0) return { value: 0, insufficient: false }
  let edits = 0
  let writes = 0
  let unknownWrites = 0
  for (const h of window) {
    if (!WRITE_TOOL_NAMES.has(h.tool)) continue
    writes++
    if (h.writeOutcome === 'unknown') { unknownWrites++; continue }
    const countsAsEdit = h.writeOutcome === 'changed'
      || (h.writeOutcome === undefined && h.status === 'success')
    if (countsAsEdit) edits++
  }
  // 窗口里有写工具但效果全部不可判（失败/回滚/无目标）→ 信号不可用：
  // 走统一的权重处理，不拿 0 当证据（"unknown 不伪造 0 或 1"）。
  if (writes > 0 && unknownWrites === writes) return { value: 0, insufficient: true }
  // 无写工具（writes=0）是事实（窗口里确实没有编辑尝试），保持 0；
  // unknown 条目不占分母（中性化，不被 read 条目稀释成"确定未编辑"）。
  const denom = window.length - unknownWrites
  return { value: denom > 0 ? edits / denom : 0, insufficient: false }
}

/**
 * targetNovelty: fraction of tool targets that are new (not seen before in the window).
 * High novelty in explore phase is good. Declining novelty over time signals convergence.
 *
 * Formula: (unique − 1) / (total − 1), so that N identical targets yield 0.0
 * (zero novelty) — not 1/N as a naive distinct/total would. A single target is
 * fully novel (1.0); an empty window is treated as fully novel (1.0) to match
 * the explore-phase early-game expectation that no history = open frontier.
 */
function computeTargetNovelty(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const seen = new Set<string>()
  for (const entry of window) seen.add(entry.argsHash ?? entry.target)
  if (seen.size === 1) return window.length === 1 ? 1.0 : 0.0
  return (seen.size - 1) / (window.length - 1)
}

/**
 * toolEntropy: normalized Shannon entropy of tool distribution in the window.
 * High entropy = diverse tool use (good in explore, bad in execute if no edits).
 */
function computeToolEntropy(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 0.5 // neutral when no data
  const dist = new Map<string, number>()
  for (const entry of window) {
    dist.set(entry.tool, (dist.get(entry.tool) ?? 0) + 1)
  }
  return normalizedShannonEntropy(dist, window.length)
}

/**
 * errorPenalty: 1.0 - failure_rate in the window.
 * A high failure rate drags down convergence.
 */
function computeErrorPenalty(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const failures = window.filter(h => h.status === 'failed').length
  return 1.0 - (failures / window.length)
}

/**
 * tokenEfficiency: real output-token efficiency via exponential decay.
 * When the caller supplies a **window-relative** output delta (S1), uses
 * exp(-tokensPerTool / 500) — direct measurement of LLM output cost vs the
 * tool calls it bought. Falls back to the old tool-classification heuristic
 * when the delta is absent (no window samples).
 *
 * Returns 1.0 when efficient, approaches 0.0 when token-heavy without progress.
 */
function computeTokenEfficiency(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
  _evidence: ConvergenceInput['evidenceState'],
  outputTokens?: number,
): number {
  // Denominator = the same window the delta was measured over (signalWindow
  // bounded by the caller's history capacity), so numerator and denominator
  // share one time scale.
  const toolCount = Math.min(history.length, windowSize)
  // New path: window-relative output delta → exponential decay
  if (outputTokens !== undefined && toolCount > 0) {
    const tokensPerTool = outputTokens / toolCount
    if (tokensPerTool <= 0) return 1.0
    return Math.exp(-tokensPerTool / 500)
  }
  // Fallback: old tool-classification heuristic
  const window = history.slice(-windowSize)
  if (window.length === 0) return 0.5

  const readTools = new Set(['read_file', 'grep', 'glob', 'repo_map', 'repo_graph', 'inspect_project', 'lsp_goto_definition', 'lsp_find_references'])
  // P2 名单收编：写工具全族同一真源（WRITE_TOOL_NAMES）——旧内联只认 edit_file/
  // write_file，hash_edit/ast_edit/apply_patch 的产出被漏计。
  const writeTools = WRITE_TOOL_NAMES
  const testTools = new Set(['run_tests', 'bash'])

  let reads = 0
  let writes = 0
  let tests = 0

  for (const entry of window) {
    if (readTools.has(entry.tool)) reads++
    else if (writeTools.has(entry.tool)) writes++
    else if (testTools.has(entry.tool)) tests++
  }

  const total = reads + writes + tests
  if (total === 0) return 0.5

  const productive = writes + tests
  if (productive === 0) return 0.0
  if (reads === 0) return 0.9

  const rawEfficiency = productive / total
  const ratio = reads / productive
  const balanceBonus = ratio >= 0.5 && ratio <= 2.0 ? 0.2 : 0.0

  return Math.min(1.0, rawEfficiency + balanceBonus)
}

/**
 * oscillationPenalty: detects A→B→A→B alternating patterns in tool fingerprints
 * via positional reversal counting — hash[i] === hash[i-2] && hash[i] !== hash[i-1].
 *
 * Returns continuous 0–1 (0 = heavy oscillation, 1 = no oscillation). Unlike the
 * old strict-2-unique-value gate, this catches gradual oscillation across 3+ values
 * (e.g. A→B→A→C→A→B) that the old detector silently ignored.
 */
function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  if (fingerprints.length < 4) return 1.0 // need at least 4 to detect reversals
  let reversals = 0
  for (let i = 2; i < fingerprints.length; i++) {
    if (fingerprints[i] === fingerprints[i - 2] && fingerprints[i] !== fingerprints[i - 1]) {
      reversals++
    }
  }
  const possibleReversals = fingerprints.length - 2
  const oscillationRate = reversals / possibleReversals
  return Math.max(0, Math.min(1, 1 - oscillationRate))
}

/**
 * Whether computeOscillationPenalty has enough data to produce a meaningful
 * (non-sentinel) value. Updated to match new threshold: ≥ 4 fingerprints.
 */
function oscillationHasData(fingerprints: ReadonlyArray<string>): boolean {
  return fingerprints.length >= 4
}

/** CJK 表意文字/假名区间（含扩展 A 区与兼容区）——判定文本是否无空格分词可用。 */
const CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/**
 * Jaccard 相似度用的 token 集合。
 *
 * 空格分词文本（英文等）沿用词级集合（词长 ≥3，行为不变）；CJK 为主的文本
 * 没有空格，split(/\s+/) 会把整段切成单个 token——「同一段话换序号再发
 * 一遍」（中文复读的典型形态）两个整段 token 不同 → Jaccard 恒 0 → 重复度
 * 恒满分，isProducingReport 跟着恒真，no-tool 熔断与 scoreAbort 双双失明
 * （issue #287）。CJK 文本改用字符级 2-gram 集合：近重复段的 2-gram 集合
 * 几乎全同，Jaccard 恢复区分度。
 */
function buildTextTokenSet(text: string): Set<string> {
  const chars = text.replace(/\s+/g, '')
  let cjkCount = 0
  for (const ch of chars) {
    if (CJK_CHAR_RE.test(ch)) cjkCount++
  }
  if (chars.length > 0 && cjkCount * 2 >= chars.length) {
    const grams = new Set<string>()
    for (let i = 0; i + 1 < chars.length; i++) {
      grams.add(chars.slice(i, i + 2))
    }
    return grams
  }
  return new Set(text.split(/\s+/).filter(w => w.length >= 3))
}

/**
 * textRepetitionPenalty: detects cross-turn text output repetition.
 * When the model produces nearly identical text across turns (despite calling
 * different tools), it's stuck in a "reformat the same analysis" loop.
 *
 * Uses Jaccard similarity between recent text fingerprints — word sets for
 * space-delimited text, character 2-grams for CJK-dominant text (no spaces
 * to split on; issue #287).
 * Returns 0.0 (heavy penalty) when 3+ of the last 4 turns have >70% word overlap,
 * 1.0 when text is diverse across turns.
 */
function computeTextRepetitionPenalty(fingerprints: ReadonlyArray<string>): number {
  const window = fingerprints.slice(-5)
  if (window.length < 3) return 1.0 // not enough data

  // Compute token sets for each fingerprint (skip very short ones)
  const tokenSets = window
    .filter(fp => fp.length >= 50)
    .map(fp => buildTextTokenSet(fp))

  if (tokenSets.length < 3) return 1.0

  // Count pairs with high Jaccard similarity
  let highSimilarityPairs = 0
  let totalPairs = 0
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      totalPairs++
      const a = tokenSets[i]!
      const b = tokenSets[j]!
      if (a.size === 0 || b.size === 0) continue
      let intersection = 0
      for (const word of a) {
        if (b.has(word)) intersection++
      }
      const union = a.size + b.size - intersection
      const jaccard = union > 0 ? intersection / union : 0
      if (jaccard > 0.7) highSimilarityPairs++
    }
  }

  if (totalPairs === 0) return 1.0

  // If more than half of pairs are highly similar, apply penalty
  const similarRatio = highSimilarityPairs / totalPairs
  if (similarRatio >= 0.6) return 0.0   // severe: majority of turns repeat same text
  if (similarRatio >= 0.4) return 0.3   // moderate
  return 1.0
}

/**
 * Whether computeTextRepetitionPenalty has enough data to produce a meaningful
 * (non-sentinel) value. The signal returns 1.0 both when data is insufficient
 * (too few fingerprints / too few long ones / no pairs) AND when text is
 * genuinely diverse. Only the former should trigger weight re-allocation.
 * Mirrors the guard conditions in computeTextRepetitionPenalty.
 */
function textRepetitionHasData(fingerprints: ReadonlyArray<string>): boolean {
  const window = fingerprints.slice(-5)
  if (window.length < 3) return false
  // 数据前提=「足够长的指纹个数」（与 compute 的 guard 一致）；集合内容不参与判定。
  return window.filter(fp => fp.length >= 50).length >= 3
}

/** Minimum recent text length that counts as a substantial analysis/report. */
const REPORT_TEXT_MIN_LEN = 200

/**
 * The set of tools that count as "productive" (write/test/commit class).
 * Used by distance-since-productive and read-only penalty logic.
 *
 * 单一事实源（2026-07-23 信号互扰治理 A2/M1）：CCR 的 computeReadOnlyStreak
 * 与 classifyActivityMode 同吃这一个集合——此前 CCR 自持副本已漂移分叉
 * （缺 apply_patch，多 delegate）。apply_patch(check_only)/ast_edit(dryRun)
 * 的预检调用按纪律执行也计入产出——预检是有意义动作，不是空转（M5）。
 */
export const PRODUCTIVE_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit',
  'run_tests', 'bash', 'deliver_task', 'delegate_task', 'delegate_batch',
  'plan_submit', 'plan_close',
])

/**
 * 单次工具调用是否只读（与 classifyActivityMode 的只读判据同源）。
 *
 * S2 CCR 可达性：连续只读计数此前由 CCR 从**容量 5 条**的共享历史反算，
 * 而 P6 阈值是 6（build）/ 10（diagnostic）——streak 上限 5，规则在生产容量下
 * 永不可达。判据必须抽成单一实现，供「独立累计计数器」复用，否则两处各写一遍
 * 迟早漂移（本仓库已有一次 A2 漂移事故）。
 *
 * bash 的只读性只能由 bashActivity（基于**完整 command** 的分类）判定；缺失
 * 标签的旧条目 fail-closed 为产出（与 classifyActivityMode 一致）。
 */
export function isReadOnlyToolCall(
  tool: string,
  bashActivity?: 'readonly' | 'productive',
): boolean {
  if (tool === 'bash') return bashActivity === 'readonly'
  return !PRODUCTIVE_TOOLS.has(tool)
}

/**
 * Distance since the last productive tool call, measured backwards from the
 * end of recentToolHistory. Returns the number of trailing entries that are
 * all non-productive. When the entire history is non-productive (or empty),
 * returns the history length.
 *
 * This is the key metric that distinguishes healthy read-write alternation
 * from genuine read-only stagnation. A developer who reads 3 files then edits
 * 2 then reads 3 more has distance=3 — not stuck. The same developer reading
 * 15 files with no edits has distance=15 — genuinely stuck.
 *
 * Returns Infinity when there has NEVER been a productive tool in the history
 * — this lets callers apply the full stagnation penalty (no alternation
 * evidence to exempt) while still allowing finite distances to gate the
 * penalty for mixed histories.
 *
 * Incident 9266c3a7: the old productiveStagnation check only looked at a
 * 6-entry window, so every read segment between edit bursts was flagged as
 * "all reads, zero productive" — 120 false advisories across 154 turns.
 */
function distanceSinceLastProductive(
  history: ConvergenceInput['recentToolHistory'],
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (PRODUCTIVE_TOOLS.has(history[i]!.tool)) {
      return history.length - 1 - i
    }
  }
  return Infinity
}

/**
 * 识别 recentToolHistory 中是否存在诊断探针（调试性质的 bash/grep 调用）。
 * 诊断探针的存在说明 agent 在"主动诊断"而非"被动读取"——
 * 有 hypothesis 并用探针验证，不应与纯只读停滞同等惩罚。
 */
export function hasDiagnosticProbes(
  history: ConvergenceInput['recentToolHistory'],
): boolean {
  // 诊断探针的特征模式
  const PROBE_BASH_RE = /node\s+-e\b|node\s+--import|tsx\s+-e\b|TMPDIR=\S+\s+node/
  const PROBE_GREP_RE = /\b(error|fail|assert|✖|AssertionError)\b/
  
  for (const entry of history) {
    if (entry.tool === 'bash' && PROBE_BASH_RE.test(entry.target)) return true
    if (entry.tool === 'grep' && PROBE_GREP_RE.test(entry.target)) return true
  }
  return false
}

/**
 * isProducingReport: whether the agent is producing a substantial, fresh
 * (non-repetitive) text deliverable — an analysis, code review, or conclusion.
 *
 * This is the legitimate face of read-heavy work: for a "检查代码" / audit /
 * investigation task, the correct behavior IS to read+grep extensively and emit
 * a text report — never edits. Without this discriminator, such tasks get
 * flagged as read-only "stagnation" every turn and spammed with "去编辑/测试"
 * nudges. We only treat it as report production when the text is NOT repetitive
 * (textRepetitionPenalty high) — a repetitive read→reformat→read loop is the
 * genuine stuck case and must still be caught.
 */
function isProducingReport(
  textFingerprints: ReadonlyArray<string>,
  textRepetitionPenalty: number,
): boolean {
  if (textRepetitionPenalty < 0.7) return false // repetitive text = stuck loop, not a report
  const recent = textFingerprints.slice(-3)
  return recent.some(fp => fp.length >= REPORT_TEXT_MIN_LEN)
}

export function convergenceTextObservation(fingerprints: ReadonlyArray<string>): NonNullable<ConvergenceInput['textObservation']> {
  return { count: fingerprints.length, repetitionPenalty: computeTextRepetitionPenalty(fingerprints),
    hasData: textRepetitionHasData(fingerprints), hasReportLength: fingerprints.slice(-3).some(fp => fp.length >= REPORT_TEXT_MIN_LEN) }
}

// ─── Score Computation ──────────────────────────────────────────────

function computeConvergenceScore(
  signals: ConvergenceSignals,
  weights: PhaseWeights,
  phaseClass: PhaseClass,
  noToolTurnCount: number,
  turn: number,
  recentToolHistory: ConvergenceInput['recentToolHistory'],
  providerName?: string,
  signalsMissingData: ReadonlySet<keyof ConvergenceSignals> = new Set(),
  producingReport = false,
  windowSize = 6,
  activityMode?: ActivityMode,
  editExpectationKind: 'required' | 'not-required' | 'unknown' = 'required',
): { score: number; effectiveWeights: PhaseWeights } {
  // Weight re-allocation for no-data signals: when a penalty signal lacks
  // sufficient data, its default 1.0 ("no penalty") would otherwise enter the
  // weighted sum at full weight and inflate the score — making the agent look
  // healthier than the evidence supports. Instead, redistribute that weight
  // equally across the signals that DO carry data. This closes the execute-phase
  // ~0.18 inflation (textRep 0.12 + oscillation 0.06 at default 1.0) during the
  // early-window period before these signals have enough fingerprints.
  //
  // Scoped to textRepetitionPenalty + oscillationPenalty only — these are
  // window-period no-data sentinels. errorPenalty's empty-window 1.0 is
  // semantically correct (no errors = full marks) and is NOT re-allocated.
  const w: PhaseWeights = { ...weights }
  // P1：编辑期待投影——not-required/unknown 时 editRatio 不参与评分：其份额
  // 按其余信号的原权重比例归一（有效权重之和保持 1）。先于缺数据重分配执行：
  // 两者各处理各自份额，不重分配两遍；已被置 0 的 editRatio 在下方缺数据
  // 循环里因 !excess 被跳过（不会二次分发）。
  if (editExpectationKind !== 'required' && w.editRatio > 0) {
    const excess = w.editRatio
    w.editRatio = 0
    const shareTargets = ['targetNovelty', 'toolEntropy', 'errorPenalty', 'tokenEfficiency', 'oscillationPenalty', 'textRepetitionPenalty'] as const
    const total = shareTargets.reduce((sum, key) => sum + w[key], 0)
    if (total > 0) {
      for (const key of shareTargets) w[key] += excess * (w[key] / total)
    }
  }
  if (signalsMissingData.size > 0) {
    // Re-allocate only to signals that are independent of editRatio: editRatio
    // is already a composite (gated by novelty below), so adding weight to it
    // would double-count novelty and mis-reward low-edit-ratio windows. The
    // four targets below are pure standalone signals.
    const others = ['targetNovelty', 'toolEntropy', 'errorPenalty', 'tokenEfficiency'] as const
    for (const missing of signalsMissingData) {
      const excess = w[missing]
      if (!excess) continue
      w[missing] = 0
      const perSignal = excess / others.length
      for (const key of others) w[key] += perSignal
    }
  }

  // editRatio is gated by targetNovelty: editing the same file repeatedly
  // (novelty collapses to 0) is原地打转, not progress — regardless of how many
  // successful edits happened. The 0.1 floor preserves a small baseline so a
  // legitimately iterative edit on one file (e.g. building up a large module)
  // is not zeroed out entirely.
  const effectiveEditRatio = signals.editRatio * Math.max(signals.targetNovelty, 0.1)
  const raw =
    w.editRatio * effectiveEditRatio +
    w.targetNovelty * signals.targetNovelty +
    w.toolEntropy * signals.toolEntropy +
    w.errorPenalty * signals.errorPenalty +
    w.tokenEfficiency * signals.tokenEfficiency +
    w.oscillationPenalty * signals.oscillationPenalty +
    w.textRepetitionPenalty * signals.textRepetitionPenalty

  // Phase expectation penalty: phases that require edits (execute) are
  // fundamentally off-track if no edits are happening. Plan phase is
  // deliberately excluded — its deliverable can be a text report or design
  // document, not necessarily file edits. Verify phase is also excluded —
  // its job is running tests/typechecks and reading diagnostics.
  //
  // P1：仅在 editExpectation=required 时施加——not-required（显式只读/审查/
  // 验证步骤）与 unknown（未分类）都不得因缺编辑被额外惩罚；editRatio 信号
  // 本身不可用（insufficient）同样跳过（统一走权重处理）。
  const editExpectedPhases: PhaseClass[] = ['execute']
  let penalty = 1.0
  if (editExpectedPhases.includes(phaseClass) && signals.editRatio < 0.1
      && editExpectationKind === 'required'
      && !signalsMissingData.has('editRatio')) {
    // Severity scales with how far below expectation we are
    penalty = 0.5
  }

  // Read-only stagnation penalty: when ALL recent tools are read-class with
  // zero productive output (no edits/tests/commits), the model is in a
  // "keep exploring without converging" loop. This is the most common
  // infinite-loop pattern — the model reads file after file, each target
  // novel, entropy high, but never takes action.
  //
  // Uses productiveRatio (productive tools / total tools in window) instead of
  // a boolean hasProductive check. This catches alternating patterns like
  // read→think→read→think where each turn has a tool call but productive
  // ratio remains 0.
  //
  // Distance guard (incident 9266c3a7): the window-only view falsely flags
  // the read segment of a healthy read→edit→read→edit rhythm. If a productive
  // tool exists within 2×windowSize records back in FULL history, the agent
  // is alternating, not stuck — skip this penalty entirely.
  //
  // GLM: Preserved Thinking accumulates server-side reasoning state across
  // turns. Once GLM enters a read-only loop the server retains that trajectory,
  // making it harder to break out — hence the tighter ramp (4→0.65 vs 8→0.7).
  // Default ramp is tuned for DeepSeek's stateless reasoning model.
  const productiveTools = PRODUCTIVE_TOOLS
  const window = recentToolHistory.slice(-Math.min(turn, 15))
  const productiveCount = window.filter(h => productiveTools.has(h.tool)).length
  const productiveRatio = window.length > 0 ? productiveCount / window.length : 1.0
  const isGlm = providerName === 'glm'
  // Distance guard: if the last productive tool is close enough that this read
  // burst is just the read phase of a read-write cycle, don't penalize.
  const distanceToProductive = distanceSinceLastProductive(recentToolHistory)
  const distanceThreshold = windowSize * 2
  const withinProductiveRange = distanceToProductive < distanceThreshold
  // Skip the read-only penalty when the agent is producing a substantial text
  // deliverable (review/analysis report): read-heavy work with a textual output
  // is legitimate progress, not stagnation.
  //
  // W3 诊断态分流：诊断会话（排查/根因分析）的正确行为就是大量读取——
  // 把"只读无产出"当停滞来罚在语义上是矛盾的。所以诊断态用一条**整体右移
  // 一档**的阶梯：起罚点从 turn≥8 推到 turn≥12，各档惩罚底线同步放宽一档。
  //
  // 为什么是"放缓"而不是"归零"：归零会让 score 永不下降，于是 07-23 B1b/M4
  // 刻意做的 diagnostic advisory 变体（tool_appears + 认知工具清单）永不触发，
  // 变成死代码；L3 保底熔断也随之失效（同一条 score 通路）。诊断会话该得到的是
  // 更长的耐心，不是关掉探测器。实测：归零会让 loop.test.ts 的 6 条回归转红
  // （改道节流、用户介入重置、diagnostic 变体、L3 grace-turn 与两条台账对照）。
  if (!producingReport && !withinProductiveRange && window.length >= (isGlm ? 2 : 4) && productiveRatio === 0) {
    const diagProbes = hasDiagnosticProbes(window)
    const isDiagnostic = activityMode === 'diagnostic'
    if (isDiagnostic) {
      if (turn >= 24) penalty = Math.min(penalty, diagProbes ? 0.4 : 0.1)
      else if (turn >= 20) penalty = Math.min(penalty, diagProbes ? 0.5 : 0.25)
      else if (turn >= 16) penalty = Math.min(penalty, diagProbes ? 0.65 : 0.45)
      else if (turn >= 12) penalty = Math.min(penalty, diagProbes ? 0.85 : 0.7)
      // turn < 12：完全不惩罚——比 build 态（turn≥8 起罚）多给 4 轮读取余量
    } else if (isGlm) {
      if (turn >= 15) penalty = Math.min(penalty, diagProbes ? 0.25 : 0.05)
      else if (turn >= 11) penalty = Math.min(penalty, diagProbes ? 0.5 : 0.15)
      else if (turn >= 7) penalty = Math.min(penalty, diagProbes ? 0.7 : 0.35)
      else if (turn >= 4) penalty = Math.min(penalty, diagProbes ? 0.85 : 0.65)
    } else {
      if (turn >= 20) penalty = Math.min(penalty, diagProbes ? 0.4 : 0.1)
      else if (turn >= 16) penalty = Math.min(penalty, diagProbes ? 0.5 : 0.25)
      else if (turn >= 12) penalty = Math.min(penalty, diagProbes ? 0.65 : 0.45)
      else if (turn >= 8) penalty = Math.min(penalty, diagProbes ? 0.85 : 0.7)
    }
  }

  // No-tool-turn penalty: consecutive turns without tool calls signal
  // hesitation or text-only looping — model is "thinking" but not acting.
  // Tool-based signals can't detect this because recentToolHistory doesn't
  // grow on no-tool turns.
  //
  // GLM: text-only loops escalate faster because Preserved Thinking
  // locks in the "I need more information" trajectory server-side.
  if (isGlm) {
    if (noToolTurnCount >= 2) {
      penalty = Math.min(penalty, 0.1)  // severe: 2+ turns with no tools
    } else if (noToolTurnCount >= 1) {
      penalty = Math.min(penalty, 0.4)  // moderate: 1 turn may be recovering
    }
  } else {
    if (noToolTurnCount >= 3) {
      penalty = Math.min(penalty, 0.15) // severe: 3+ turns of doing nothing
    } else if (noToolTurnCount >= 2) {
      penalty = Math.min(penalty, 0.35) // moderate: 2 turns of hesitation
    } else if (noToolTurnCount >= 1) {
      penalty = Math.min(penalty, 0.7)  // mild: 1 turn — may be recovering
    }
  }

  return {
    score: Math.min(1.0, Math.max(0.0, raw * penalty)),
    // P3：归一后的有效权重（含 editRatio 期待归一与缺数据重分配）——
    // 遥测/回放消费；不同口径的分数不可直接比较（regimeKey 切片）。
    effectiveWeights: { ...w },
  }
}

// 注入消息的构造与结构化变体标识沿接缝拆到 ./convergence-message.ts
// （detector 只管"该不该提醒"；该模块只管"提醒什么、属于哪个方向"）。

// ─── Main Entry Point ───────────────────────────────────────────────

export function evaluateConvergence(input: ConvergenceInput): ConvergenceResult {
  let tier = selectTier(input.contextWindow)
  // Plan-execution sessions legitimately run long turns (multi-wave edits) —
  // widen the score-based turn thresholds so the detector doesn't treat an
  // approved plan run like an unstructured exploration spiral.
  if (input.progressBeacons?.activePlan) {
    tier = {
      ...tier,
      nLow: Math.round(tier.nLow * 1.5),
      nMid: Math.round(tier.nMid * 1.5),
      nHigh: Math.round(tier.nHigh * 1.5),
    }
  } else if (typeof input.progressBeacons?.structureRelaxation === 'number') {
    // P2 阴阳调度单声源：snapshot 的 relaxation 存在时接管软阈值调节，
    // flowInputs 即使同传也被忽略（同一 flow 信号绝不计两次）。
    // relaxation=0（hardTighten）→ 倍率 1.0，即收紧语义正确压过 P1 放宽。
    const relax = Math.min(0.25, Math.max(0, input.progressBeacons.structureRelaxation))
    if (Number.isFinite(relax) && relax > 0) {
      const multiplier = 1 + relax
      tier = {
        ...tier,
        nLow: Math.round(tier.nLow * multiplier),
        nMid: Math.round(tier.nMid * multiplier),
        nHigh: Math.round(tier.nHigh * multiplier),
      }
    }
  } else if (input.progressBeacons?.flowInputs) {
    // P1 心流保护：与 activePlan 互斥（activePlan 已有 1.5× 上下文级保护，
    // 叠加会产生接近 2× 的不可审计延迟）。资格门：momentum 有实测数据 +
    // 窗口内已结算样本 ≥ FLOW_MIN_SAMPLES——证据不足完全保持旧行为。
    // 倍率只触 nLow/nMid/nHigh 三个字段（显式展开，不遍历 tier 键）：
    // signalWindow/maxTurns 是 score-abort 护栏与全部信号的公共窗口，
    // 乘它们等于借倍率之手改写硬护栏。
    const flow = computeFlowBeacon({
      ...input.progressBeacons.flowInputs,
      recentToolHistory: input.recentToolHistory,
      todoCompletedDelta: input.progressBeacons.todoCompletedDelta,
      signalWindow: tier.signalWindow,
    })
    const eligible = input.progressBeacons.flowInputs.momentumHasData
      && flow.sampleCount >= FLOW_MIN_SAMPLES
    if (eligible && flow.score > 0) {
      const multiplier = 1 + FLOW_MAX_BONUS * flow.score
      tier = {
        ...tier,
        nLow: Math.round(tier.nLow * multiplier),
        nMid: Math.round(tier.nMid * multiplier),
        nHigh: Math.round(tier.nHigh * multiplier),
      }
    }
  }
  const weights = PHASE_WEIGHTS[input.phaseClass]
  const windowSize = tier.signalWindow

  const editRatioComputed = computeEditRatio(windowSize, input.recentToolHistory)
  const signals: ConvergenceSignals = {
    editRatio: editRatioComputed.value,
    targetNovelty: computeTargetNovelty(windowSize, input.recentToolHistory),
    toolEntropy: computeToolEntropy(windowSize, input.recentToolHistory),
    errorPenalty: computeErrorPenalty(windowSize, input.recentToolHistory),
    tokenEfficiency: computeTokenEfficiency(windowSize, input.recentToolHistory, input.evidenceState, input.outputTokens),
    oscillationPenalty: computeOscillationPenalty(input.toolFingerprints ?? []),
    textRepetitionPenalty: input.textObservation?.repetitionPenalty ?? computeTextRepetitionPenalty(input.textFingerprints ?? []),
  }

  // Track which penalty signals lack sufficient data so their default-1.0
  // weight can be re-allocated instead of inflating the score. Only the two
  // window-period signals (oscillation, textRepetition) — errorPenalty's
  // empty-window 1.0 is a legitimate "no errors = full marks".
  const signalsMissingData = new Set<keyof ConvergenceSignals>()
  if (!oscillationHasData(input.toolFingerprints ?? [])) signalsMissingData.add('oscillationPenalty')
  if (!(input.textObservation?.hasData ?? textRepetitionHasData(input.textFingerprints ?? []))) signalsMissingData.add('textRepetitionPenalty')
  // P1：窗口内写工具效果全部不可判（无目标/回滚/未接线）→ editRatio 信号
  // 不可用——统一走权重处理，而不是拿 0 当证据额外惩罚。
  if (editRatioComputed.insufficient) signalsMissingData.add('editRatio')

  // Fix 2 — a read-heavy task that is emitting a substantial, non-repetitive
  // text report (code review / audit / investigation) is producing its
  // deliverable, not stalling. Relax the read-only penalty and suppress the
  // productive-stagnation flag so it is not spammed with "去编辑/测试" nudges.
  //
  // 收窄（2026-07-04 触发面修复）：豁免仅对"纯审查"生效——存在未验证编辑时，
  // 边写长分析文本边搁置验证正是该被提醒的场景，不是审查报告。原豁免让
  // 排查/验证类会话（每轮都输出大段分析）把改道机制永久静音，验证轮次膨胀。
  //
  // 进一步收窄（2026-07-08 verify 误报修复）：verify 阶段的职责就是验证已有编辑
  // ——filesModified 非空 + deliveryStatus≠verified 是 verify 的常态而非异常。
  // 在此阶段封锁 producingReport 会让 verify 全程的测试/诊断输出被误判为
  // "无产出停滞"（"verify 阶段 47 轮未收敛"误报的次要来源）。
  const hasUnverifiedEdits = input.phaseClass !== 'verify'
    && input.evidenceState.filesModified.size > 0
    && input.evidenceState.deliveryStatus !== 'verified'
  const producingReport = !hasUnverifiedEdits
    && (input.textObservation ? input.textObservation.hasReportLength && signals.textRepetitionPenalty >= 0.7
      : isProducingReport(input.textFingerprints ?? [], signals.textRepetitionPenalty))

  const scoreComputed = computeConvergenceScore(signals, weights, input.phaseClass, input.noToolTurnCount ?? 0, input.turn, input.recentToolHistory, input.providerName, signalsMissingData, producingReport, windowSize, input.activityMode, input.editExpectation?.kind ?? 'required')
  const score = scoreComputed.score
  const scoreRegimeKey = input.scoreRegimeKey === undefined ? undefined
    : effectiveScoreRegimeKey(input.scoreRegimeKey, scoreComputed.effectiveWeights as unknown as Record<string, number>, signalsMissingData, input.phaseClass)

  // W4 噪音洪流修复：工具错误受阻时降级收敛 score。最近窗口中 ≥40% 的
  // 工具返回 failed → agent 很可能在与坏掉的工具搏斗而非 doom-loop。
  // 降一档（cap 在 L1-Mid）——不完全抑制（仍有真实卡住的可能性），但
  // 从 L2+ 降下来足以切断 advisory → system-reminder 的正反馈洪流。
  const effectiveScore = (input.recentToolErrorRatio ?? 0) >= 0.4
    ? Math.min(score, 0.41) // cap 仅允许 L1，阻断 L2+ 的正反馈洪流
    : score

  // Determine escalation level
  let level: 0 | 1 | 2 | 3 = 0
  const turn = input.turn
  const noToolCount = input.noToolTurnCount ?? 0

  // P1：无有效评分信号（窗口与指纹全空）→ scoreQuality=insufficient：
  // 分数没有证据支撑，不按分数分级（不补满分、也不误伤）；no-tool /
  // productiveStagnation 等硬路径不受影响。
  const scoreQuality: 'ok' | 'insufficient' =
    input.recentToolHistory.length === 0
    && (input.toolFingerprints ?? []).length === 0
    && (input.textObservation?.count ?? (input.textFingerprints ?? []).length) === 0
      ? 'insufficient'
      : 'ok'

  // No-tool stagnation: fire earlier than normal thresholds. When the model
  // produces multiple turns with no tool calls, it's clearly stuck — don't
  // wait for nLow/nMid/nHigh turn counts to accumulate.
  // Hard cap: 5+ (default) / 3+ (GLM) consecutive no-tool turns → forced abort.
  const isGlm = input.providerName === 'glm'
  const NO_TOOL_ABORT_THRESHOLD = isGlm ? 3 : 5
  const noToolStagnation = noToolCount >= (isGlm ? 1 : 2) // GLM: fire on first no-tool turn

  // Productive-ratio stagnation: when recent tool calls are all non-productive
  // (read/grep/glob only, zero edits/tests/commits), the agent is in an
  // alternating read-analyze loop. This bypasses the turn gate because the
  // pattern is meaningful from early turns — each turn burns full input cost
  // (especially on GLM with no prefix cache).
  //
  // Distance guard (incident 9266c3a7): the window-only productiveRatio sees
  // the read tail of a healthy read→edit→read→edit cycle as "all reads" and
  // fires 120+ false advisories. Require the last productive tool to be far
  // enough back (≥ 2×windowSize) that this isn't just a normal read phase
  // between edit bursts.
  const productiveToolsSet = PRODUCTIVE_TOOLS
  const stagnationWindow = input.recentToolHistory.slice(-windowSize)
  const productiveInWindow = stagnationWindow.filter(h => productiveToolsSet.has(h.tool)).length
  const productiveRatio = stagnationWindow.length > 0
    ? productiveInWindow / stagnationWindow.length
    : 1.0
  const distanceToLastProductive = distanceSinceLastProductive(input.recentToolHistory)
  // 诊断态右移一档而非豁免（3feac8be × c74fa263 的冲突）：诊断会话大量读取是正确
  // 行为，但把它整条排除在停滞判据外，会让 3feac8be 专为诊断写的收敛文案
  // （buildInjectedMessage 里 activityMode==='diagnostic' 那支）永不可达——
  // c74fa263 加排除项时正是在扩展同一条 W3 工作，未察觉这一自我抵消。多给一倍
  // window 的耐心，仍保留"读到彻底脱离产出"时的收敛出口。
  const productiveDistanceThreshold = windowSize * (input.activityMode === 'diagnostic' ? 3 : 2)
  // Fix (infinity guard): when there has NEVER been a productive tool call in the
  // entire session, the session simply hasn't had a chance to be productive yet.
  // Treating Infinity >= threshold as "far from last productive" would flag every
  // early-session read burst as stagnation — the wrong heuristic for cold starts.
  // Skip the productiveStagnation check entirely until at least one productive
  // call has been made (distance is finite).
  //
  // Phase cooldown (宁可漏报不可误熔断): the first N turns of a new phase are
  // suppress productive-stagnation — the window likely contains only the previous
  // phase's read-heavy tools. Let the model establish a phase-appropriate tool
  // pattern before flagging stagnation.
  const phaseCooldown = Math.min(4, windowSize)
  const inPhaseCooldown = (input.phaseRelativeTurn ?? Infinity) <= phaseCooldown
  const productiveStagnation = !inPhaseCooldown
    && distanceToLastProductive !== Infinity
    && stagnationWindow.length >= Math.min(windowSize, 4)
    && productiveRatio === 0
    && !producingReport
    && distanceToLastProductive >= productiveDistanceThreshold  // 诊断态门槛已右移，见上

  // Reasoning-aware no-tool handling. A model that keeps emitting fresh,
  // substantial, non-repetitive analysis on each no-tool turn is reasoning
  // through the problem (deep-thinking models legitimately narrate multi-turn
  // analysis before acting), NOT spinning in a text-only loop. `producingReport`
  // is the established "legitimate text deliverable" discriminator (non-repetitive
  // + substantial ≥200 chars); reuse it so such turns are nudged (kick) rather
  // than hard-killed. Genuine spin (repetitive / thin text) keeps producingReport
  // false → the hard abort still fires. This is the core fix for the "他在推理，
  // 但我们以为他终端" false circuit-break.
  const reasoningActive = producingReport

  if (noToolCount >= NO_TOOL_ABORT_THRESHOLD) {
    level = reasoningActive ? 2 : 3 // fresh reasoning → kick, not kill
  } else if (noToolCount >= 2 && isGlm) {
    level = reasoningActive ? 2 : 3 // GLM: 2 no-tool turns → abort unless reasoning
  } else if (noToolCount >= 3) {
    level = 2 // kick on 3+ consecutive no-tool turns
  } else if (noToolCount >= 2 && turn >= 4) {
    level = 2 // kick after 2 no-tool turns if we're past the very early turns
  } else if (scoreQuality === 'ok' && turn >= tier.nHigh && effectiveScore <= 0.2) {
    level = 3
  } else if (scoreQuality === 'ok' && turn >= tier.nMid && effectiveScore <= 0.4) {
    level = 2
  } else if (scoreQuality === 'ok' && turn >= tier.nLow && effectiveScore <= 0.6) {
    level = 1
  }

  // Level 0 early-exit ONLY for score-based detection (needs statistical
  // significance from enough turns).  No-tool stagnation and productive-ratio
  // stagnation are meaningful from the very first turn — never override them
  // with the early-exit gate.
  if (turn < tier.nLow && !noToolStagnation && !productiveStagnation) {
    level = 0
  }

  // P1 重复验证软判据（level 计算后、Todo/有限等待 veto 前仲裁）：同一工作
  // 版本上以同一身份重复跑有限验证、长期无新进展、且当前仍在重跑同一验证
  // ——只上探到 L2（收束/换策略），不独立触发 L3 abort/split；后续
  // todo/等待 veto 与既有护栏仍可压低，不越过真实等待保护。
  if (input.repeatedVerification
      && input.repeatedVerification.count >= 2
      && input.repeatedVerification.currentRerun
      && input.repeatedVerification.turnsSinceProgress >= tier.nMid
      && level < 2) {
    level = 2
  }

  // Progress-beacon veto: the todo list advanced within the recent window —
  // the hardest possible "not stuck" evidence, strictly stronger than the
  // trajectory-shape heuristics (novelty/entropy/efficiency). Cap score-based
  // escalation at L1. No-tool stagnation keeps its levels: completing a todo
  // requires a tool call, so a genuine no-tool spiral cannot carry this beacon
  // (noToolCount < 2 guard is belt-and-braces for stale deltas).
  if ((input.progressBeacons?.todoCompletedDelta ?? 0) > 0 && noToolCount < 2 && level > 1) {
    level = 1
  }

  // Awaiting-verification veto（2026-10-10 狂轰事故方向 2）：后台有 running 的
  // 验证型 job（等门禁钦定证据，如全量套件）→ 与 todo 同级 cap score-based
  // escalation at L1。no-tool 层级不受影响（noToolCount < 2 guard 同 todo：
  // 等待中的真无工具螺旋仍需提醒——job await 本身就是工具动作）。
  if ((input.progressBeacons?.awaitingVerification ?? false) && noToolCount < 2 && level > 1) {
    level = 1
  }

  // Productive-ratio stagnation: if early-exit was bypassed but no other
  // condition set a level, ensure at least level 1 nudge fires.
  if (productiveStagnation && level === 0 && turn >= (isGlm ? 3 : 4)) {
    level = 1
  }

  const noToolForceAbort = noToolCount >= NO_TOOL_ABORT_THRESHOLD && !reasoningActive
  // Reasoning-aware guard applies only to the no-tool hard cap. A model that
  // keeps emitting fresh substantial analysis on no-tool turns is thinking, not
  // spinning, so the hard cap is downgraded to a kick. Score-based convergence
  // aborts are kept independent — they measure orthogonal stagnation signals
  // (repetition, oscillation, token efficiency) and should still fire when the
  // composite score says the session is stuck.
  //
  // L3 scoreAbort 双层护栏（宁可漏报不可误熔断）:
  // 1. Score must be in sustained decline across the signal window — an isolated
  //    dip from a phase transition or phase-mismatch is NOT a real stall.
  //    Allows at most 1 micro-bounce (reversal) in the window: real score curves
  //    have natural jitter from tool diversity changes; strict monotonic descent
  //    would miss genuine slow slides.
  // 2. At least one L2 warning must have been emitted in a prior turn — the model
  //    was told to change course and didn't. First-escalation aborts skip the
  //    chance for the model to self-correct.
  // These guard bands prevent the penalty multiplication chain (no-tool × read-only
  // × phase-expectation) from false-triggering on a single low-score evaluation.
  // P3：趋势只取末尾连续、同口径（regimeKey）、有效的样本——混合口径的
  // 旧分数不得触发 score-abort（同口径样本不足 = 不燃）；口径与质量语义
  // 见 score-history.ts。legacy number 样本按原语义参与，逐位兼容。
  const scoreDeclining = input.scoreHistory != null
    && analyzeScoreDecline(input.scoreHistory, windowSize, scoreRegimeKey).declining
  const warnedButNotAdopted = input.priorWarningAtL2Plus === true
  const scoreAbort = level >= 3 && score < 0.05 && scoreDeclining && warnedButNotAdopted
  const shouldAbort = scoreAbort || noToolForceAbort
  // Session split is pointless for no-tool stagnation — the problem is model
  // behavior, not context size.  Only split on score-based level 3.
  const shouldForceSplit = level >= 3 && !noToolForceAbort
  const shouldKick = level >= 2
  const built = (level >= 2)
    ? buildInjectedMessage(level as 2 | 3, score, signals, input.phaseClass, tier, input.evidenceState.deliveryStatus, noToolCount, productiveStagnation, input.repeatCount, input.activityMode, input.runtimeAdvice, input.editExpectation)
    : null
  const injectedMessage = built?.text ?? null
  const messageVariant = built?.variant ?? null

  return {
    score,
    level,
    shouldAbort,
    injectedMessage,
    messageVariant,
    shouldKick,
    shouldForceSplit,
    signals,
    abortCause: shouldAbort ? (noToolForceAbort ? 'no-tool' : 'score') : undefined,
    reasoningActive,
    scoreQuality,
    effectiveWeights: scoreComputed.effectiveWeights,
    ...(scoreRegimeKey !== undefined ? { scoreRegimeKey } : {}),
  }
}
