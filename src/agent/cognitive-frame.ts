/**
 * P3 认知帧（Cognitive Frame）—— turn 边界的只读事实底座。
 *
 * 把 EFE / Sensorium / P1 flow beacon / PAL / 证据 / 用户干预 / plan 状态 /
 * 任务推进统一为一个带质量语义（measured / partial / missing / vacuous）、
 * 带稳定 fingerprint 的不可变事实帧。控制器（structure-flow 等）从 frame
 * 投影取数，不再各自直读子系统——「多个控制器各看半个世界」是 P3 要解决
 * 的根因。
 *
 * 纪律（与设计文档钉死）：
 * - frame 只保存**事实与质量**，不保存控制结果（relaxation / mode /
 *   planRecommendation…），防止 replay 把输出当输入。
 * - 装配器只接受调用方已计算的快照值，不从模型文本推导健康度。
 * - `inputFingerprint` 由稳定序列化构成：无时间戳、无随机 ID、无自由文本。
 * - 深拷贝边界：装配后修改输入对象不影响 frame。
 * - fail-closed：非有限值标 vacuous、缺失标 missing，绝不静默变 measured；
 *   投影在关键 source 质量不足时返回 null，让消费方走旧行为。
 *
 * 设计出处：docs/superpowers/plans/2026-07-18-cognitive-frame-p3.md Wave 1。
 */

import type { EFEComponents } from './prediction-error.js'
import type { StructureFlowInputs } from './structure-flow-controller.js'

import type { CognitiveFactQuality, CognitiveFactSource } from './cognitive-quality.js'
export type { CognitiveFactQuality, CognitiveFactSource } from './cognitive-quality.js'

/** P3：工作相位/评分口径观测（frame facts 的可选扩展——旧帧缺此字段，
 *  replay 报 legacy；不记录文件正文、敏感路径或原始命令）。 */
export interface CognitiveFrameWorkFacts {
  committedPhase: string | null
  candidatePhase: string | null
  candidateTurns: number
  candidateSource: string | null
  transition: string | null
  reason: string | null
  taskEpoch: number
  stageEpoch: number
  mutationRevision: number
  progressRevision: number
  editExpectationKind: string | null
  editExpectationSource: string | null
  /** 自最后实质进展（无记录时为任务起点）起的 modelTurn 数（P3 进展年龄）。 */
  progressAgeTurns: number
  /** 验证等待是否到期（waitingVerification 投影；none = 无等待）。 */
  verificationWait: 'none' | 'active' | 'expired'
}

export interface CognitiveFrameFacts {
  palStatus?: import('./pal-observation.js').PalStatus
  efe: EFEComponents | null
  /** Sensorium 原始快照三字段（与 P1 flowInputs 同口径）。 */
  sensorium: { momentum: number; momentumHasData: boolean; stability: number } | null
  /** P1 computeFlowBeacon 结果 + 资格门样本数（调用方已算好的派生事实）。 */
  flow: { score: number | null; sampleCount: number; requiredSamples: number }
  /** PAL 只读事实；v2 空闲为零案件，v1 null 的历史原因未知。 */
  pal: { activeCases: number; anyNeedsUser: boolean; anyStalled: boolean; hasPlannedProbes: boolean } | null
  evidence: { hasVerificationDebt: boolean; deliveryStatus: string; consecutiveFailures: number }
  user: { intervened: boolean }
  plan: { activePlanFile: boolean; planModeState: string }
  progress: { todoCompletedDelta: number }
  /** P3 可选：工作相位/口径观测（装配器不自动补默认值——旧帧重算不变）。 */
  work?: CognitiveFrameWorkFacts
}

/** 装配输入与 facts 同构——装配器负责深拷贝与质量标记。 */
export interface CognitiveFrameInput extends CognitiveFrameFacts {
  turn: number
  phaseClass: string
}

export interface CognitiveFrame {
  /** 记录 schema 版本——遥测落盘后是跨版本资产。 */
  v: 1 | 2
  turn: number
  phaseClass: string
  facts: CognitiveFrameFacts
  quality: Readonly<Record<CognitiveFactSource, CognitiveFactQuality>>
  /** 稳定序列化哈希，仅由 turn/phaseClass/facts 构成。 */
  inputFingerprint: string
}

// ─── 内部：稳定序列化 + FNV-1a 哈希 ─────────────────────────────────

/** 键序稳定的 JSON 序列化（对象键排序；NaN/Infinity 显式字符串化，
 *  避免 JSON.stringify 把它们折叠成 null 与真实 null 混淆）。 */
function stableSerialize(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return `"#num:${String(value)}"`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map(k => `${JSON.stringify(k)}:${stableSerialize((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

/** FNV-1a 64-bit（BigInt）→ 16 位 hex。无时钟、无随机，纯输入函数。 */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

// ─── 质量判定（fail-closed）──────────────────────────────────────────

function efeQuality(efe: EFEComponents | null): CognitiveFactQuality {
  if (efe === null) return 'missing'
  const finite = Number.isFinite(efe.epistemicValue)
    && Number.isFinite(efe.pragmaticValue)
    && Number.isFinite(efe.noveltyBonus)
    && Number.isFinite(efe.precision)
  return finite ? 'measured' : 'vacuous'
}

function sensoriumQuality(s: CognitiveFrameFacts['sensorium']): CognitiveFactQuality {
  if (s === null) return 'missing'
  return s.momentumHasData ? 'measured' : 'partial'
}

function flowQuality(f: CognitiveFrameFacts['flow']): CognitiveFactQuality {
  if (f.score === null || !Number.isFinite(f.score)) return 'missing'
  return f.sampleCount >= f.requiredSamples ? 'measured' : 'partial'
}

// ─── 装配器 ─────────────────────────────────────────────────────────

export function assembleCognitiveFrame(input: CognitiveFrameInput, schemaVersion: 1 | 2 = 2): CognitiveFrame {
  // 深拷贝边界：调用方装配后修改输入不得影响 frame。
  const facts: CognitiveFrameFacts = {
    efe: input.efe ? { ...input.efe } : null,
    sensorium: input.sensorium ? { ...input.sensorium } : null,
    flow: { ...input.flow },
    pal: input.pal ? { ...input.pal } : null,
    ...(schemaVersion === 2 && input.palStatus ? { palStatus: { ...input.palStatus } } : {}),
    evidence: { ...input.evidence },
    user: { ...input.user },
    plan: { ...input.plan },
    progress: { ...input.progress },
    // P3：可选工作观测——只在输入提供时设置（缺省不加键——旧帧 fingerprint 重算不变）。
    ...(input.work ? { work: { ...input.work } } : {}),
  }

  const quality: Record<CognitiveFactSource, CognitiveFactQuality> = {
    efe: efeQuality(facts.efe),
    sensorium: sensoriumQuality(facts.sensorium),
    flow: flowQuality(facts.flow),
    pal: facts.palStatus && ['disabled', 'unavailable'].includes(facts.palStatus.state) ? 'not_applicable'
      : facts.pal === null ? 'missing' : 'measured',
    // 布尔/计数事实来自始终存在的 tracker，恒为已知。
    evidence: 'measured',
    user: 'measured',
    plan: 'measured',
    progress: 'measured',
  }

  const inputFingerprint = fnv1a64(stableSerialize({
    turn: input.turn,
    phaseClass: input.phaseClass,
    facts,
  }))

  return {
    v: schemaVersion,
    turn: input.turn,
    phaseClass: input.phaseClass,
    facts,
    quality,
    inputFingerprint,
  }
}

/** 从记录还原的 frame 重算 fingerprint（replay 对账用）。 */
export function fingerprintCognitiveFrame(frame: Pick<CognitiveFrame, 'turn' | 'phaseClass' | 'facts'>): string {
  return fnv1a64(stableSerialize({
    turn: frame.turn,
    phaseClass: frame.phaseClass,
    facts: frame.facts,
  }))
}

// ─── 投影：facts → StructureFlowInputs ───────────────────────────────

/**
 * 完整映射表（代码即文档）：frame facts → P2 控制器输入。
 * EFE 质量非 measured（missing/vacuous）→ null，对应 P2「EFE 缺失 → 全消费方
 * 旧行为」路径；不把坏数据递给控制器（控制器内的非有限检查是第二道防线，
 * 不是第一道）。
 */
export function projectStructureFlowInputs(frame: CognitiveFrame): StructureFlowInputs | null {
  if (frame.quality.efe !== 'measured' || frame.facts.efe === null) return null
  return {
    efe: frame.facts.efe,
    flowScore: frame.facts.flow.score,
    flowSampleCount: frame.facts.flow.sampleCount,
    requiredFlowSamples: frame.facts.flow.requiredSamples,
    todoCompletedDelta: frame.facts.progress.todoCompletedDelta,
    // P2 控制器语义：活跃计划上下文 = 批准计划文件 或 planning 态。
    activePlan: frame.facts.plan.activePlanFile || frame.facts.plan.planModeState === 'planning',
    palNeedsUser: frame.facts.pal?.anyNeedsUser ?? false,
    palStalled: frame.facts.pal?.anyStalled ?? false,
    hasVerificationDebt: frame.facts.evidence.hasVerificationDebt,
    consecutiveFailures: frame.facts.evidence.consecutiveFailures,
    userIntervened: frame.facts.user.intervened,
  }
}
