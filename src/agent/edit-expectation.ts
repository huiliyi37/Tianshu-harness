/**
 * EditExpectation — 「当前任务/步骤是否应当产生文件编辑」的纯投影（P1）。
 *
 * 与 DisciplineEligibility 的关系：**不是 requiresCodeVerification 的同义词**
 * ——文档/产物任务可以需要写文件（如设计文档），验证任务也可以不需要修改
 * 代码。本投影只回答"编辑期待"这一个问题，供收敛评分（editRatio 权重与
 * 乘半惩罚）与处方文案消费。
 *
 * 判定优先级（首个命中者胜）：
 * 1. explicitNoMutation —— 已接收的人类明确约束优先于任何语义类别。
 * 2. 只读/审查类 taskKinds —— 解释/问答/概览任务与审查/验证任务不期待编辑。
 * 3. verifying-step —— 最近一次有限验证晚于最后一次真实写入 且 校验仍新鲜：
 *    验证步骤本身不期待编辑（修"正常验证被误标执行相位后因无编辑受压"）。
 *    任何新写入（序列超过验证启动）立即离开该步骤；时效窗口防永久挂起
 *    （P2 的 work-stage 接管后与此对齐）。
 * 4. 实现类 taskKinds（bug_fix/refactor/new_feature/architecture_design/
 *    performance_diagnosis）→ required（正例：需要实施却长期不实施仍要提示）。
 * 5. 无分类/冲突 → unknown（少催编辑，但不升级为"确认只读"）。
 *
 * 未知/不确定不冒充：unknown 既不施加编辑惩罚，也不发放等待/静默豁免。
 */
import type { IntentTaskKind } from './intent-retrieval-route.js'
import type { VerificationExecutionStart } from './work-progress-facts.js'

export type EditExpectationKind = 'required' | 'not-required' | 'unknown'

export type EditExpectationSource =
  | 'explicit-no-mutation'
  | 'explicit-mutation-allowed'
  | 'task-kind'
  | 'verifying-step'
  | 'no-classification'

export interface EditExpectation {
  kind: EditExpectationKind
  source: EditExpectationSource
  /** 人类可读判据（不进 prompt，供观测/断言）。 */
  reason: string
}

/** 验证步骤的时效窗口（modelTurn）：覆盖等结果 + 读日志 + 分析；到期回到
 *  语义默认，避免"验证后无限期不期待编辑"。P2 work-stage 已落地：verify 相位
 *  保持到新真实写入、无此窗口——两者有意不同（相位保持防抖；编辑期待防陈旧），
 *  进入判据"验证晚于最后写入"与 work-stage 的 verificationNewerThanWrite 同源
 *  （seq 比较蕴含 rev 序），仅并发批的乱序启动边界有差异（保守侧：少计编辑）。 */
export const VERIFY_STEP_FRESH_TURNS = 20

/** 实现类：需要写文件的交付物（含设计文档——文档/产物任务是写文件任务）。 */
const IMPLEMENTATION_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'bug_fix',
  'refactor',
  'new_feature',
  'performance_diagnosis',
  'architecture_design',
])

/** 只读理解类：不期待编辑。 */
const READ_ONLY_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'code_explanation',
  'usage_question',
  'codebase_overview',
])

/** 审查/验证类：处方是收束断言与证据，不是编辑。 */
const REVIEW_KINDS: ReadonlySet<IntentTaskKind> = new Set([
  'review_audit',
  'verification',
])

export interface EditExpectationInput {
  taskKinds: readonly IntentTaskKind[]
  /** 用户原始输入含显式否定变异词（"不要修改/只解释/只分析"）。 */
  explicitNoMutation: boolean
  explicitMutationAllowed?: boolean
  /** 当前任务的验证执行启动事实（P0；含 taskEpochAtStart/modelTurnAtStart）。 */
  executions: ReadonlyArray<VerificationExecutionStart>
  taskEpoch: number
  /** 最近一次真实写入的执行序号（facts.lastMutationSequence；无写入 = -1）。 */
  lastMutationSequence: number
  /** 当前 modelTurn（时效窗口对齐用）。 */
  modelObservationTurn: number
}

/** 从原始事实计算"当前是否处于验证步骤"（时效内、同任务、有限性）。 */
function verifyingStepActive(input: EditExpectationInput): boolean {
  const latest = [...input.executions]
    .reverse()
    .find(e => e.taskEpochAtStart === input.taskEpoch && e.finite)
  if (!latest) return false
  // 验证晚于最后一次写入 = 验证启动后尚无新编辑（新编辑立即离开验证步骤）。
  if (latest.sequence <= input.lastMutationSequence) return false
  // 时效：validation 步骤可以持续多轮（等 job/读日志），但不会无限期。
  if (latest.modelTurnAtStart !== null && input.modelObservationTurn - latest.modelTurnAtStart > VERIFY_STEP_FRESH_TURNS) {
    return false
  }
  return true
}

/** 编辑期待投影（纯函数）。 */
export function deriveEditExpectation(input: EditExpectationInput): EditExpectation {
  const nonSocial = input.taskKinds.filter(k => k !== 'social_idle')

  // ① 人类明确约束优先（"已接收的人类明确约束优先于旧语义类别"）。
  if (input.explicitNoMutation) {
    return {
      kind: 'not-required',
      source: 'explicit-no-mutation',
      reason: '用户明确只读（不要修改/只解释/只分析）',
    }
  }

  if (input.explicitMutationAllowed) return { kind: 'required', source: 'explicit-mutation-allowed', reason: '用户明确允许实施修改' }

  // ② 只读 / 审查类任务：处方是核实与收束断言，不是编辑。
  if (nonSocial.length > 0 && nonSocial.every(k => READ_ONLY_KINDS.has(k) || REVIEW_KINDS.has(k))) {
    return {
      kind: 'not-required',
      source: 'task-kind',
      reason: `只读/审查类任务（${nonSocial.join(',')}）——不期待编辑`,
    }
  }

  // ③ 当前处于验证步骤：验证不期待编辑（新写入即离开该步骤）。
  if (verifyingStepActive(input)) {
    return {
      kind: 'not-required',
      source: 'verifying-step',
      reason: '最近一次有限验证晚于最后一次写入——当前为验证步骤，不期待编辑',
    }
  }

  // ④ 实现类任务：需要实施（长期不实施的正例仍须提示）。
  const impl = nonSocial.filter(k => IMPLEMENTATION_KINDS.has(k))
  if (impl.length > 0) {
    return {
      kind: 'required',
      source: 'task-kind',
      reason: `实现类任务（${impl.join(',')}）——期待编辑`,
    }
  }

  // ⑤ 无分类（intent router 未判）/其余冲突（如 security_safety 单列）
  //    → unknown：少催编辑，但不确认只读。
  return {
    kind: 'unknown',
    source: 'no-classification',
    reason: nonSocial.length === 0
      ? '任务语义未分类——编辑期待未知'
      : `未覆盖的语义组合（${nonSocial.join(',')}）——编辑期待未知`,
  }
}
