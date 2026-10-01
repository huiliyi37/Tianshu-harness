/**
 * CVM 拦截的用户可见提示（issue #247 第 1–3 条）——分级判定与文案的唯一来源。
 *
 * 三个必须在此处（而不是在渲染层）固定的契约：
 *
 * ① **按决策形态分级，不按 kind。** 同一个 kind 会有多种返回形态：
 *    `perspective-locked` 既有 candidate 分支（router:947），也有 yielded 分支
 *    （:914）与冷却静默分支（:943）。按 kind 分级会把「真发了干预」与
 *    「只是命中、没发声」混成一类。
 *
 * ② **拦截级不要求 `mode === 'active'`。** 默认模式就是 shadow
 *    （`cvmVectorMode({}) === 'shadow'`，见 cvm-vector-evaluator.test.ts:75）。
 *    若要求 active，默认路径下用户一条提示都看不到——issue 的立论
 *    「默认关闭会让 CVM 在默认路径下依然不可见，本 issue 的立论就没有解决」
 *    就没有解决。因此判据取「CVM 判定需要干预」，而不是「干预已送达」。
 *
 * ③ **shadow 下文案不得宣称「已注入 / 已阻止」。** issue 的硬约束：
 *    「提示文案应避免让用户读出『因为拦截了所以失败了』」。纯函数层面就
 *    禁掉这两个词，比指望每个渲染层自觉可靠。
 */
import type { CvmDifficultyKind, CvmVectorDecision, CvmVectorMode } from './hooks/cognitive-capsule-router.js'

/** 三级严重度。中文名逐字取自 issue #247 第 1 条的三级表。 */
export type CvmNoticeLevel = 'intercept' | 'warn' | 'info'

/** issue #247 第 2 条的开关档：off（全关）/ intercept / warn / all。单键表达分级，
 *  照 `ui.glanceDensity` 的范式（而不是三个 boolean——三键会产生 8 种组合，其中
 *  几种语义矛盾，例如「只开提示不开拦截」）。 */
export type CvmNoticeGate = 'off' | 'intercept' | 'warn' | 'all'

/**
 * issue #247 第 2 条「可配置开关」的**默认值**。
 *
 * 为什么默认不是 `off`：issue 原话——「默认关闭会让 CVM 在默认路径下依然不可见，
 * 本 issue 的立论就没有解决。噪音由分级解决，不由默认关闭解决。」
 * 默认只放行**拦截级**（candidate 非空 = CVM 判定需要干预），警告与提示级留待
 * 用户显式打开——这是「分级降噪」而非「默认隐藏」。
 */
export const CVM_NOTICE_GATE_DEFAULT: CvmNoticeGate = 'intercept'

/** 严重度序：数值越大越该被看见。 */
const CVM_SEVERITY: Record<CvmNoticeLevel, number> = { info: 1, warn: 2, intercept: 3 }

/** 每档放行的**最低**严重度。`all` 放到 info(1)；`intercept` 只放到 intercept(3)。 */
const CVM_GATE_FLOOR: Record<Exclude<CvmNoticeGate, 'off'>, number> = {
  intercept: 3,
  warn: 2,
  all: 1,
}

/** 该级别在当前开关下是否应渲染。`off` 一票否决。 */
export function cvmNoticeLevelEnabled(gate: CvmNoticeGate, level: CvmNoticeLevel): boolean {
  if (gate === 'off') return false
  return CVM_SEVERITY[level] >= CVM_GATE_FLOOR[gate]
}

export const CVM_LEVEL_LABELS: Record<CvmNoticeLevel, string> = {
  intercept: '拦截',
  warn: '警告',
  info: '提示',
}

/**
 * kind → 用户可见中文名。
 *
 * ⚠️ 只有 `verification-debt → 「验证债务」` 是逐字沿用 issue #247 的
 * （其第 3 条示例「CVM 拦截 ×3：验证债务」）。其余四个是本 PR 新拟的
 * 用户可见文案——`docs/reference/observability-harness.md` 里这些分类
 * 只有英文标识符，没有任何既有译名可沿用。需维护者认口径。
 */
export const CVM_KIND_LABELS: Record<CvmDifficultyKind, string> = {
  'verification-debt': '验证债务',
  'gate-blocked': '门禁让位',
  'context-pressure': '上下文压力',
  'perspective-locked': '视角锁定',
  'attack-stalled': '攻坚停滞',
}

/** 一次拦截的结构化通知。`text` 是给用户看的单行（不含 ANSI）。 */
export interface CvmInterceptionNotice {
  level: CvmNoticeLevel
  kind: CvmDifficultyKind
  /** 规则 id（CV1/CV2/CV3）。`gate-blocked` / `context-pressure` 无规则，为 null。 */
  ruleId: string | null
  /** 决策当时的模式。shadow 下渲染层仍不得宣称「已注入」。 */
  mode: CvmVectorMode
  turn: number
  text: string
}

/** 计数宿主：`SessionContext` 满足此形状（结构类型，避免循环依赖）。 */
export interface CvmInterceptionSink {
  recordCvmInterception(kind: string): void
}

/** 通知宿主：`AgentCallbacks` 满足此形状。未接线的宿主传 `{}` 或 undefined。 */
export interface CvmNoticeCallbacks {
  onCvmInterception?: (notice: CvmInterceptionNotice) => void
}

/**
 * 决策 → 级别。三者皆空（`EMPTY_DECISION`）返回 null = 不提示也不计数。
 *
 * 顺序即优先级：`candidate` 与 `yielded` 在 evaluator 里互斥，所以两者
 * 不会同时命中。
 */
export function classifyCvmDecision(decision: CvmVectorDecision): CvmNoticeLevel | null {
  if (decision.candidate) return 'intercept'
  if (decision.yielded) return 'warn'
  if (decision.classification) return 'info'
  return null
}

/** 组装单行文案。`count > 1` 时按 issue 的示例插 `×N`（`×1` 不插）。 */
export function formatCvmNoticeLine(input: {
  level: CvmNoticeLevel
  kind: CvmDifficultyKind
  ruleId: string | null
  mode: CvmVectorMode
  count?: number
}): string {
  const countPart = input.count !== undefined && input.count > 1 ? ` ×${input.count}` : ''
  const rulePart = input.ruleId ? `（${input.ruleId}）` : ''
  return `⛨ CVM ${CVM_LEVEL_LABELS[input.level]}${countPart}：${CVM_KIND_LABELS[input.kind]}${rulePart}${cvmNoticeSuffix(input.level, input.mode)}`
}

function cvmNoticeSuffix(level: CvmNoticeLevel, mode: CvmVectorMode): string {
  if (level === 'intercept') {
    // shadow 是「不发声」，不是「已阻止」——措辞必须区分，见文件头契约 ③。
    return mode === 'active' ? ' — 已注入纠偏' : ' — 影子模式仅记录，未注入'
  }
  if (level === 'warn') return ' — 命中但已让位给其他机制'
  return ' — 已记台账，未发声'
}

/** 决策 → 通知对象。返回 null 表示这次决策对用户没有任何可说的。 */
export function buildCvmNotice(
  decision: CvmVectorDecision,
  mode: CvmVectorMode,
  turn: number,
): CvmInterceptionNotice | null {
  const level = classifyCvmDecision(decision)
  const classification = decision.classification
  // classification 为 null 时即使 candidate/yielded 非空也无 kind 可报——
  // 这与 A 的计数口径（只算 classification 非空）保持一致，不产生口径分叉。
  if (level === null || !classification) return null
  const kind = classification.kind
  const ruleId = classification.ruleId ?? decision.candidate?.ruleId ?? null
  return {
    level,
    kind,
    ruleId,
    mode,
    turn,
    text: formatCvmNoticeLine({ level, kind, ruleId, mode }),
  }
}

/**
 * CVM-vector 干预路由的唯一出口：记一次台账 + 推一条通知。
 *
 * 调用点唯一（`turn-step-producer.ts` 的 CVM-vector 路由块），与
 * `SessionContext.recordCvmInterception` 的注释互指。
 *
 * 计数口径与 issue #247 第 4 条（GlanceBar 常驻计数，PR #328）严格一致：
 * 凡产出 `classification` 即计一次，含 gate-blocked 这类永不发声的分类。
 *
 * 通知通路失败一律吞掉——与 evaluator 本身「抛错不阻断主 turn」同纪律。
 */
export function emitCvmInterception(
  session: CvmInterceptionSink,
  callbacks: CvmNoticeCallbacks | undefined,
  decision: CvmVectorDecision,
  mode: CvmVectorMode,
  turn: number,
): void {
  const notice = buildCvmNotice(decision, mode, turn)
  if (!notice) return
  session.recordCvmInterception(notice.kind)
  try {
    callbacks?.onCvmInterception?.(notice)
  } catch { /* 提示通路失败不影响 turn 主路径 */ }
}
