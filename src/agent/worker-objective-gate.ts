/**
 * 目标对账 —— 把「派它去做什么」与「它交回了什么」放在一起核一次。
 *
 * 为什么需要：worker 的 `status` 与 `evidenceStatus` 都是它**自己填报**的，而
 * 回收链上原先没有任何一处拿结果去对照 `WorkOrder.objective`。既有的
 * `verifyWorkerEvidence` 管的是另一维——改了文件却没验证（mutation safety），
 * 它不关心交回物是否回答了派发时提的问题。
 *
 * 本模块做两件事：
 *
 * 1. **给结果盖上派发侧的 objective**。主控收到的 packet 此前只有
 *    `workOrderId` 和 summary，没有目标——批量派五个、再隔几轮，模型得靠
 *    `batch:3` 这个 id 自己回忆当初派它去做什么。目标缺席时「对不上」根本无从
 *    判断。objective 取自 WorkOrder 而非 worker 自报：对账的两边必须一边来自
 *    派发侧，否则 worker 可以两边都写成自洽的。
 *
 * 2. **机械对账**。只判**契约违背**（要的东西一件没交），不判语义好坏——
 *    「这份审查做得够不够深」不是机械能答的题，交给主控。判据分两档：
 *    - 不含糊的（交回空壳、verify 工没验证）→ 改判 blocked，主控看到的就不是
 *      一个 passed。
 *    - 有方向性的（patch_proposal 没产物、去的地方与派它去的地方不沾边）→ 只
 *      加 risk 注记。这类都有合法情形（「查完认为无需改动」「顺着 import 走到
 *      了别处」），硬拦会把对的也拦掉。
 */

import type { WorkerResult, WorkOrderKind } from './work-order.js'
import type { WorkerTranscript } from './worker-session.js'
import { isVerificationIntent } from './verification-activity.js'
import { classifyProfile } from './coordination-policy.js'

/** 对账只需要派发侧这几样，不必拖进整个 WorkOrder。 */
export interface ObjectiveContext {
  objective: string
  kind: WorkOrderKind
  scope: { files?: string[] }
  profile?: string
  authority?: string
  groupId?: string
}

/** `workerResultIngestSchema` 在 summary 缺省时填的占位串。 */
const PLACEHOLDER_SUMMARY = '(no summary provided by worker)'

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

/** 交回物里是否有任何一件实质产出。summary 不算——空壳判定要靠它之外的东西。 */
function hasDeliverable(result: WorkerResult): boolean {
  return result.findings.length > 0
    || result.changedFiles.length > 0
    || result.artifacts.length > 0
    || !!result.patchSummary?.trim()
    || !!result.verification
}

/**
 * summary 是否等于没写。
 *
 * 只认「占位串」和「空白」两种，**不设长度阈值**：一句 20 字的中文结论
 * （「该函数无任何调用点，可安全删除」）是完全合格的交付，按长度卡会把它误杀。
 * 简短但有效的结论直接交付，不为长度再次调用模型。
 */
function summaryIsEmpty(summary: string): boolean {
  const trimmed = summary.trim()
  return trimmed.length === 0 || trimmed === PLACEHOLDER_SUMMARY
}

/** transcript 里是否出现过任何可算作验证的执行痕迹。 */
function ranAnyVerification(transcript: WorkerTranscript): boolean {
  if (transcript.toolUses.includes('run_tests')) return true
  return (transcript.bashCommands ?? []).some(cmd => isVerificationIntent(cmd))
}

/** 测试文件模式：__tests__/ 目录或 *.test.* / *.spec.* —— 写工/verifier 的
 *  合法伴随产物（判据 3 越界豁免，见下方注释）。 */
const TEST_FILE_RE = /(^|\/)(__tests__\/|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/

/** 末段路径比较：容忍绝对/相对路径与分隔符差异，只看是否指同一个文件。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

function scopeWasVisited(scopeFiles: string[], result: WorkerResult): boolean {
  const visited = [...(result.examinedFiles ?? []), ...result.changedFiles]
  return scopeFiles.some(f => visited.some(v => samePath(f, v)))
}

/**
 * 盖章 + 对账。返回新对象，不改原值。
 *
 * @param order 派发侧上下文（objective / kind / scope）——权威来源
 * @param result worker 交回的结果
 * @param transcript 可选执行留痕；缺席时凡需要它作判据的检查一律 fail-open
 *        降为 risk，不硬拦（同 `verifyWorkerEvidence` 的纪律：没有证据说明它
 *        做错了，就不能当它做错了）
 */
export function reconcileWithObjective(
  order: ObjectiveContext,
  result: WorkerResult,
  transcript?: WorkerTranscript,
): WorkerResult {
  // 无条件覆盖：worker 若在自己的 JSON 里写了 objective，那是自报，不作数。
  // （ingest schema 里没有该字段，zod 会剥掉；这里再覆盖一次是纵深。）
  // profile/authority 同理盖章——展示层（digest/舰队面板）的身份标识必须来自
  // 派发侧，但已盖章值不覆盖（resume 命中路径已带派发侧身份，覆盖会把不一致
  // 藏起来，同 objective 的 resume 纪律）。
  const stamped: WorkerResult = {
    ...result,
    objective: order.objective,
    profile: result.profile ?? order.profile,
    authority: result.authority ?? order.authority,
    groupId: result.groupId ?? order.groupId,
  }

  // 已经如实报告没干成的，不必再去质疑它的交付物。
  if (stamped.status !== 'passed') return stamped

  let risks = stamped.risks

  // ── 硬判据 1：交回空壳 ─────────────────────────────────────────
  if (!hasDeliverable(stamped) && summaryIsEmpty(stamped.summary)) {
    return {
      ...stamped,
      status: 'blocked',
      evidenceStatus: 'unverified',
      risks: addRisk(risks, '目标对账：worker 报 passed，但既无 summary 也无 findings/改动/产物 — 交回物为空壳，不予采信'),
    }
  }

  // ── 硬判据 2：verify 工没验证 ──────────────────────────────────
  // 派它去验证，它既没有 verification 元数据，transcript 里也没跑过任何验证形状
  // 的东西。这与 verifyWorkerEvidence 不重叠：那道门只在 evidenceStatus 已经是
  // 'verified' 或有文件改动时才发力，而这里的 worker 报的是 passed + unverified。
  if (order.kind === 'verify' && !stamped.verification) {
    if (transcript && !ranAnyVerification(transcript)) {
      return {
        ...stamped,
        status: 'blocked',
        evidenceStatus: 'unverified',
        risks: addRisk(risks, '目标对账：kind=verify 的 worker 报 passed，但未产出 verification 元数据，transcript 里也无 run_tests / 验证形状 bash 的执行痕迹 — 未执行受派的验证'),
      }
    }
    if (!transcript) {
      risks = addRisk(risks, '目标对账：kind=verify 的 worker 未产出 verification 元数据（无 transcript 可佐证，未硬拦）')
    }
  }

  // ── 硬判据 3：写工越界改文件（P1-8）──────────────────────────────
  // 派它去改 scope.files，它却改了 scope 之外的文件——批内 hasFileConflict
  // 与全局 inflight 登记都以 scope.files 为边界，越界改动会逃过两道防线。
  // 只有写工（hands）硬拦：读工的 examinedFiles 越界是「查得广」，合法。
  // 测试文件豁免（审查 M2）：__tests__/ 与 *.test.* / *.spec.* 是写工/verifier
  // 的合法伴随产物（「实现 X 带测试」是常态派发），不计入越界。
  if (classifyProfile(order.profile ?? '') === 'hands' && (order.scope.files?.length ?? 0) > 0) {
    const outOfScope = (stamped.changedFiles ?? []).filter(f => !TEST_FILE_RE.test(f) && !(order.scope.files ?? []).some(s => samePath(s, f)))
    if (outOfScope.length > 0) {
      return {
        ...stamped,
        status: 'blocked',
        evidenceStatus: 'unverified',
        risks: addRisk(risks, `目标对账：写工改动了 scope 之外的文件 — ${outOfScope.join(' · ')} 不在派发范围 ${(order.scope.files ?? []).join(' · ')} 内，拒绝采信越界改动`),
      }
    }
  }

  // ── 软判据 1：patch_proposal 没交出补丁 ────────────────────────
  // 不硬拦：「查完认为无需改动」是合法结论，机械上与「什么都没做」无从区分。
  if (order.kind === 'patch_proposal' && stamped.changedFiles.length === 0 && !stamped.patchSummary?.trim()) {
    risks = addRisk(risks, '目标对账：kind=patch_proposal 但未交回任何补丁产物（无 changedFiles、无 patchSummary）— 若结论是「无需改动」，应在 summary 里说明理由')
  }

  // ── 软判据 2：去的地方与派它去的地方不沾边 ─────────────────────
  // 只在「派发时指定了文件」且「worker 确实报告了它看过哪些文件」时才比对：
  // examinedFiles 为空只说明它没报告，不说明它没看。
  const scopeFiles = order.scope.files ?? []
  const reported = [...(stamped.examinedFiles ?? []), ...stamped.changedFiles]
  if (scopeFiles.length > 0 && reported.length > 0 && !scopeWasVisited(scopeFiles, stamped)) {
    risks = addRisk(risks, `目标对账：派发范围指定了 ${scopeFiles.join(' · ')}，但交回的 examinedFiles/changedFiles 与之无交集 — 可能没查派它去查的地方`)
  }

  return risks === stamped.risks ? stamped : { ...stamped, risks }
}
