import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import { formatObjectiveReviewStance, formatPathBoundaryReviewStance, formatWeighingReviewStance, formatWiringEffectivenessReviewStance, formatCaseSensitivityReviewStance, formatMethodologyVerificationStance, LARGE_FILE_WARN_THRESHOLD, type ChangeSet } from './review-discipline.js'
import type { PatcherResult, ReviewFinding, ReviewInfraFailure, ReviewRouterDeps, SquadronResult, VerifierResult } from './review-router.js'
import type { AggregationPolicy, WorkerProfile, WorkerResult, WorkOrderKind } from './work-order.js'

type WorkerFinding = WorkerResult['findings'][number]

export interface ReviewCoordinator {
  delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
  delegateBatch?(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
}

export interface CoordinatorReviewDepsOptions {
  /** Stable parent id for generated work orders; defaults to deliver_task. */
  parentTurnId?: string
  /** Parent review depth. Child review workers receive parent+1 as request metadata and in their objective. */
  reviewDepth?: number
  /** Optional parent abort signal propagated to coordinator calls. */
  abortSignal?: AbortSignal
}

const REVIEW_PARENT_TURN_ID = 'deliver_task:review-router'

function files(change: ChangeSet): string[] {
  return [...change.files]
}

function objectiveReviewStanceBlock(): string {
  return [
    '客观审查姿态（来自外部 Claude Code Opus 审计经验的内化；不依赖外部辅助在场）：',
    formatObjectiveReviewStance(),
  ].join('\n')
}

function dataflowVerifierBlock(): string {
  return [
    '数据流验证姿态（复杂 spec 的 P4-c 教训）：',
    '1. 不要把 spec 条款当成扁平清单核对；从 spec 字段/约束出发，重构事实流图：生产者 → 中间结构 → 消费者/写入目标 → 断言。',
    '2. 检查组合门控的条件矩阵，如 source × severity × apply；嵌套约束不能拍平成独立的 if。',
    '3. 要求反例覆盖：如果实现只处理了 happy path、忘了调用合约、声明了类型却不消费、或用 truthy/falsy 哨兵（如 !waveId），哪个已存在或新增的测试会失败？',
    '4. 测试全绿不够——它必须能让错误/初版实现在相关 spec 路径上变红。',
    '5. 虚假绿灯/fixture 契约审计：对测试 mock/fixture 在依赖输出上赋值的每个字段，验证真实生产代码是否确实产出该形状（grep 写入点，不是只看类型声明）。对生产代码渲染/消费的每个字段，追踪其生产写入点及该写入的运行时条件是否真的能触发（`raw.x ?` 守卫的写入行，如果数据源从不携带 x，仍然是死的）。fixture 虚构了一个真实系统从不产出的形状——或双方各自 mock 边界却无一份合约测试断言真实生产者的输出——就是虚假绿灯，上报 HIGH。',
  ].join('\n')
}

function pathBoundaryReviewBlock(): string {
  return [
    '路径边界/注意力门控审查姿态（T7/MeridianIndexer 教训；始终适用于 path、classifier、discovery、indexer、watcher、git-status、ownership 相关改动）：',
    formatPathBoundaryReviewStance(),
  ].join('\n')
}

function weighingReviewBlock(): string {
  return [
    '称量审查姿态（天权称量者教训；适用于重构、提取、封装/作用域变更——既验真伪，也称量代价）：',
    formatWeighingReviewStance(),
  ].join('\n')
}

function wiringEffectivenessBlock(): string {
  return [
    '接线有效性审查姿态（2026-06-12 噪音治理复审教训；"built ≠ wired ≠ effective"——适用于每次 feature/config/param/bus/gate 新增）：',
    formatWiringEffectivenessReviewStance(),
  ].join('\n')
}

function methodologyVerificationBlock(): string {
  return [
    '方法论验证姿态（2026-06-14 PlanDesignIntentRouter 对抗审查反推；"方法论文档即代码——可执行指令需实证验证"——适用于审查知识文件、计划模板、规则、自检清单）：',
    formatMethodologyVerificationStance(),
  ].join('\n')
}

function caseSensitivityReviewBlock(): string {
  return [
    '大小写审查姿态（macOS APFS 大小写不敏感→开发机不报错，Linux/CI 崩溃——专抓 import 路径、API 标识符、全局变量大小写不一致）：',
    formatCaseSensitivityReviewStance(),
  ].join('\n')
}

function childReviewDepth(options: CoordinatorReviewDepsOptions): number {
  return (options.reviewDepth ?? 0) + 1
}

function scope(change: ChangeSet): DelegationRequest['scope'] {
  return { files: files(change) }
}

function request(input: {
  change: ChangeSet
  options: CoordinatorReviewDepsOptions
  objective: string
  kind: WorkOrderKind
  profile: WorkerProfile
  /** Live worker activity upstream — feeds the subagent panel (review-gate UI
   *  visibility). Absent → review workers run silent in the UI. */
  onActivity?: DelegationRequest['onActivity']
}): DelegationRequest {
  const reviewDepth = childReviewDepth(input.options)
  return {
    parentTurnId: input.options.parentTurnId ?? REVIEW_PARENT_TURN_ID,
    objective: [
      input.objective,
      '',
      `审查深度: ${reviewDepth}。审查 worker 不得调用 deliver_task；仅报告 verdict/evidence 即可。`,
    ].join('\n'),
    kind: input.kind,
    profile: input.profile,
    scope: scope(input.change),
    reviewDepth,
    ...(input.onActivity ? { onActivity: input.onActivity } : {}),
  }
}

function verificationEvidence(result: WorkerResult): string | undefined {
  if (!result.verification) return undefined
  const v = result.verification
  return `ran: ${v.command} → ${v.status} (${v.passed ?? 0} passed, ${v.failed ?? 0} failed, ${v.skipped ?? 0} skipped)`
}

export function formatFinding(finding: WorkerFinding): string {
  const prefix = finding.evidenceKind === 'firsthand' ? '[一手] '
    : finding.evidenceKind === 'inferred' ? '[转述] '
    : ''
  const refs = finding.evidenceRefs && finding.evidenceRefs.length > 0
    ? ` (${finding.evidenceRefs.join(', ')})`
    : ''
  return `${prefix}${finding.claim} — ${finding.evidence}${refs}`
}

function summarizeResult(result: WorkerResult): string {
  const parts = [
    verificationEvidence(result),
    result.summary,
    ...result.findings.slice(0, 3).map(formatFinding),
    ...result.risks.slice(0, 3).map(risk => `risk: ${risk}`),
  ].filter((part): part is string => Boolean(part && part.trim().length > 0))
  return parts.join('\n')
}

function summarizeRun(run: CoordinatorRun): string {
  if (run.status === 'skipped') return 'review worker skipped: objective did not pass delegation budget gate'
  const summaries = run.results.map(summarizeResult).filter(Boolean)
  return summaries.length > 0 ? summaries.join('\n---\n') : 'review worker returned no evidence'
}

function extractSeverity(text: string): ReviewFinding['severity'] {
  if (/\bCRITICAL\b|\bC\d+\b/i.test(text)) return 'CRITICAL'
  if (/\bHIGH\b|\bH\d+\b/i.test(text)) return 'HIGH'
  if (/\bMEDIUM\b|\bM\d+\b/i.test(text)) return 'MEDIUM'
  if (/\bLOW\b|\bL\d+\b/i.test(text)) return 'LOW'
  return undefined
}

function mapWorkerFinding(result: WorkerResult, finding: WorkerFinding): ReviewFinding {
  const text = `${finding.claim}\n${finding.evidence}\n${result.summary}`
  return {
    severity: extractSeverity(text),
    claim: finding.claim,
    evidence: finding.evidence,
    // 极性透传：worker 未上报时缺席，blocking 判定按 defect 处理（fail-closed）。
    ...(finding.polarity ? { polarity: finding.polarity } : {}),
  }
}

function mapSquadronFindings(run: CoordinatorRun): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  for (const result of run.results) {
    if (result.status !== 'passed') continue
    for (const finding of result.findings) {
      findings.push(mapWorkerFinding(result, finding))
    }
  }
  return findings
}

function classifyInfraFailure(result: WorkerResult): ReviewInfraFailure['kind'] {
  const text = `${result.summary}\n${result.risks.join('\n')}\n${result.artifacts.map(a => a.content).join('\n')}`
  if (/did not contain a JSON object|schema-valid JSON|parse/i.test(text)) return 'json'
  // 预算耗尽(max-turns/无终轮)——确定性失败,同预算重试必死,单列 kind 供重试分流
  if (/max.?turns|exhausted without a final turn/i.test(text)) return 'budget'
  if (/timeout|timed out/i.test(text)) return 'timeout'
  if (/skipped/i.test(text)) return 'skip'
  return 'worker'
}

function mapSquadronInfraFailures(run: CoordinatorRun): ReviewInfraFailure[] {
  if (run.status === 'skipped') {
    return [{ kind: 'skip', claim: 'Review Squadron skipped before producing findings' }]
  }

  const failures: ReviewInfraFailure[] = []
  for (const result of run.results) {
    if (result.status === 'passed') continue
    // parse-salvaged（status='blocked' 但 findings 非空）：报告坏了但发现活着——
    // 摘要透传给主控（F1，2026-09-06）；findings 不进 SquadronResult.findings，
    // 避免 unverified 内容参与 blocking 判定。
    const salvaged = result.status === 'blocked' && result.findings.length > 0
      ? result.findings.slice(0, 8).map(f => ({ claim: f.claim, confidence: f.confidence }))
      : undefined
    failures.push({
      kind: classifyInfraFailure(result),
      claim: result.summary,
      ...(salvaged !== undefined ? { salvagedFindings: salvaged } : {}),
    })
  }
  return failures
}

function verifierResult(run: CoordinatorRun): VerifierResult {
  const verified = run.status === 'completed'
    && run.results.some(result => result.status === 'passed' && result.evidenceStatus === 'verified')
  return {
    verdict: verified ? 'verified' : 'rejected',
    evidence: summarizeRun(run),
  }
}

function patcherResult(run: CoordinatorRun): PatcherResult {
  const patched = run.status === 'completed'
    && run.results.some(result => result.status === 'passed' && (result.changedFiles.length > 0 || Boolean(result.patchSummary)))
  return { patched }
}

function verifierObjective(change: ChangeSet): string {
  const largeWarn = formatLargeFileWarnings(change)
  return [
    '在交付前独立对抗性验证此改动。',
    objectiveReviewStanceBlock(),
    dataflowVerifierBlock(),
    pathBoundaryReviewBlock(),
    weighingReviewBlock(),
    wiringEffectivenessBlock(),
    caseSensitivityReviewBlock(),
    methodologyVerificationBlock(),
    `范围文件: ${files(change).join(', ') || '(无)'}`,
    ...(change.focusHint ? [`**审查重点**: ${change.focusHint}`] : []),
    ...(largeWarn ? [largeWarn] : []),
    '尽可能运行相关的既有测试，返回命令 + 观测到的输出作为证据。',
    '不要止步于测试绿：对变更文件至少尝试一个反例或边界/错误路径探针。',
    '对 spec/集成类变更，显式报告事实流闭环、条件矩阵覆盖、以及一个能让纯清单式实现失败的测试用例。',
    '仅当验证确实运行、通过、且未发现反例时，返回 evidenceStatus="verified" 的 WorkerResult JSON。',
  ].join('\n')
}

function patcherObjective(change: ChangeSet, verifier: VerifierResult): string {
  return [
    '在隔离的 worker worktree 中修复被对抗验证拒绝的改动。',
    '修复验证器指出的根因；不要弱化测试或仅压制症状。',
    `范围文件: ${files(change).join(', ') || '(无)'}`,
    `验证器判决: ${verifier.verdict}`,
    `验证器证据: ${verifier.evidence}`,
    '返回带 changedFiles 和 patchSummary 的 WorkerResult JSON。',
  ].join('\n')
}

// ─── Inspector definitions ──────────────────────────────────────────
// Prompt economy: every inspector carries the core objective stance
// (anti-rubber-stamp), plus ONLY the stances relevant to its own axis.
// Stacking all stances on all five inspectors quintupled prompt size and
// diluted each inspector's focus — the axis IS the specialization.

type InspectorStance = 'dataflow' | 'pathBoundary' | 'wiring' | 'methodology'

const WIRING_INSPECTOR_METHOD = [
  '方法（逐项，附 file:line）：',
  '1. 从生产入口正向追闭环：入口→组合根→改动点。测试/脚本中的挂点不算。断线=HIGH。',
  '2. 新增参数/字段/setter→grep 所有调用方。零调用方传值/读取=死接线。',
  '3. 门控条件→枚举真实输入形状(空集合/可选字段缺失/自由文本)→估算通过率。~0%或~100%均无效。',
  '4. 改动声称目标→构造改前/改后场景验证指标确实朝声称方向移动。',
  '5. 被移除调用点→检查遗留生产者/setter/字段是否也有活消费者。',
].join('\n')

const SILENCE_INSPECTOR_METHOD = [
  '方法（逐项执行，每项附 file:line 证据）：',
  '1. 空 catch/被吞错误：用 ast_grep 查找空体或无操作体的 catch 块——模式 `try { $$A } catch ($E) { }`（空体）和 `try { $$A } catch ($E) { $$B }`，然后读取每个 $B 检查是否只打了日志/吞掉错误而没有重新抛出或上浮。grep 无法区分 catch 体和周围代码；ast_grep 能精确定位结构形状。',
  '2. 无 rejection 处理器的 Promise：ast_grep 模式 `$$P.then($F)` 和 `async $F($$) { $$ }`——交叉引证确认每条异步路径都有 .catch 或 try-catch。rejected promise 上裸 `.then` 无 `.catch` = 被吞掉的 rejection。',
  '3. 对"测试已通过/已修复"类声明：要求提供确切命令 + 观测到的通过数。只覆盖 happy path（无错误路径断言）的绿色是虚假绿灯——标记它。',
].join('\n')

const INSPECTORS: Array<{ name: string; objective: string; stances: InspectorStance[]; method?: string }> = [
  {
    name: '安全审查',
    objective: '审查认证、授权、路径校验、密钥泄露、以及 fail-open/fail-closed 行为。',
    stances: ['pathBoundary'],
  },
  {
    name: '生命周期',
    objective: '审查状态转换、异步竞态、取消传播、超时传递、以及 load-check-save 原子性。验证外层超时严格支配内层预算（内层必须先触发以保留部分结果）。',
    stances: ['dataflow'],
  },
  {
    name: '数据流',
    objective: '审查参数传播、白名单/工具作用域传播、持久化路径、以及数据丢失风险。',
    stances: ['dataflow', 'pathBoundary'],
  },
  {
    name: '静默审查',
    objective: '审查被吞掉的错误、空 catch 块、缺失的诊断信息、以及虚假绿灯验证声明。将"测试已通过/已修复"类断言作为最高优先级审查目标：要求提供确切命令 + 观测到的输出。同时标记 fixture 虚构的虚假绿灯：测试断言了一个生产代码从未写入过真实值的字段/形状——只有 fixture 在写——导致该功能绿灯但实际已死。',
    stances: [],
    method: SILENCE_INSPECTOR_METHOD,
  },
  {
    name: '接线审查',
    objective: '审查端到端接线与有效性——"构建 ≠ 接线 ≠ 有效"。排查：计划项半成品（字段加了但从未强制生效）、新增可选参数却无调用方、setter/总线/配置标志从未被读取或冲刷、门禁被真实数据形状过滤掉几乎所有输入（静默特性杀戮）、以及改动与其声称目标背道而驰（例如旧通道与新通道并存——降噪改动里出现重复渲染）。',
    stances: ['wiring'],
    method: WIRING_INSPECTOR_METHOD,
  },
]

function stanceBlocks(stances: InspectorStance[]): string[] {
  const blocks: string[] = []
  if (stances.includes('dataflow')) blocks.push(dataflowVerifierBlock())
  if (stances.includes('pathBoundary')) blocks.push(pathBoundaryReviewBlock())
  if (stances.includes('wiring')) blocks.push(wiringEffectivenessBlock())
  if (stances.includes('methodology')) blocks.push(methodologyVerificationBlock())
  return blocks
}

const FINDING_CONTRACT = [
  '每项发现须报告严重级别 CRITICAL/HIGH/MEDIUM/LOW、结论、证据（file:line）、以及最小修复建议。若该审查维度无问题，须明确报告"未发现异常"——沉默不等于通过。',
  'severity 语义：CRITICAL/HIGH 只用于必须修复的缺陷。确认性结论（已核实无问题、链路闭合、口径对齐）不是缺陷——在该 finding 上标 "polarity": "confirmation"，它会进入「已核实清单」而非 blocking findings；缺陷可显式标 "defect"（缺省按 defect 处理）。',
  'status 语义：status 表示你的审查任务是否完成，不是被审代码的判定。发现 CRITICAL 缺陷时 status 仍为 passed——缺陷经 findings 表达；failed/blocked 只用于你自己没完成审查（预算耗尽、读不到代码等）。',
].join('\n')

/**
 * 大文件警告：审查 worker 先做焦点定位，再读取高信号片段。
 */
function formatLargeFileWarnings(change: ChangeSet): string | null {
  if (!change.largeFiles || change.largeFiles.length === 0) return null
  const lines: string[] = [
    `⚠️  ${change.largeFiles.length} 个文件超出 ${Math.round(LARGE_FILE_WARN_THRESHOLD / 1000)}KB 审查阈值：`,
  ]
  for (const lf of change.largeFiles) {
    const kb = Math.round(lf.sizeBytes / 1000)
    lines.push(`  - ${lf.path} (${kb}KB)`)
  }
  lines.push(
    '',
    '不要整文件读取上述文件——先用 grep/repo_graph 或 read_file(focus="审查重点") 定位关键片段。',
    '若需精确核验，再用 read_file + offset/limit 只读改动行附近的相关段落。',
  )
  return lines.join('\n')
}

function inspectorObjective(inspector: typeof INSPECTORS[number], change: ChangeSet): string {
  const largeWarn = formatLargeFileWarnings(change)
  const fileList = files(change).join(', ') || '(无)'
  // 有 commit message 时，用它作为目标的第一行——用户能看到审查和本次改动的关联，
  // 而不是每次都看到同一个【接线审查】模板头。
  const header = change.commitMessage
    ? `【${inspector.name}】${change.commitMessage}`
    : `【${inspector.name}】${inspector.objective}`
  const intro = change.commitMessage
    ? inspector.objective
    : ''
  return [
    header,
    `范围: ${fileList}`,
    ...(intro ? [intro] : []),
    objectiveReviewStanceBlock(),
    ...stanceBlocks(inspector.stances),
    ...(inspector.method ? [inspector.method] : []),
    ...(change.focusHint ? [`审查重点: ${change.focusHint}`] : []),
    ...(largeWarn ? [largeWarn] : []),
    ...(inspector.stances.includes('dataflow')
      ? ['For spec/integration changes, review the fact-flow graph, condition matrix, and counterexample tests before accepting checklist-style coverage.']
      : []),
    FINDING_CONTRACT,
    '',
    '回复语言: 中文。所有发现、摘要、risks 均用中文撰写。',
  ].join('\n')
}

function squadronRequests(change: ChangeSet, options: CoordinatorReviewDepsOptions, onActivity?: DelegationRequest['onActivity']): DelegationRequest[] {
  return INSPECTORS.map(inspector => request({
    change,
    options,
    kind: 'review',
    profile: 'reviewer',
    objective: inspectorObjective(inspector, change),
    onActivity,
  }))
}

// ─── Auto in-task review: single wiring inspector, bounded budget ─────
// 预算标定(2026-07-19 审查空耗事故):6 轮/150s 对多文件 diff 系统性不足——
// worker 分析到一半被 max-turns 杀掉,重试同预算必死。放大到 12 轮/240s 并
// 配早收敛 prompt(见下)。
// 2026-07-24 再标定:12 轮对首次大 read 场景仍系统性不足(近 4 天 5 个审查
// worker 全部 max-turns 耗尽,prompt 累加 30-50 万 token)。放大到 20 轮/360s
// ——1M 窗口下单轮才 ~5 万 token,空间不是瓶颈;根治靠 worker read cap
// (readCapOverride)+ 机械化 focused-read/精确分页约束(见 earlyConvergenceHint)。
// 外层 AUTO_REVIEW_BUDGET_MS 相应放宽到 420s;detached 后审查不阻塞交付,
// 成本仅为后台时长。
// 2026-08-01 再标定(廉价模型能力强但首字节延迟高,给足轮次和时间):
// 审查 worker 频繁耗尽预算(近 4 天多个会话审查全部 infra failure)。
// 廉价模型审查质量不差,差的是时间——三档全升:小改动 20 轮/300s,
// 中改动 28 轮/360s,大改动 36 轮/480s。外层 AUTO_REVIEW_BUDGET_MS
// 相应放宽到 600s。
function computeAutoReviewBudget(change: ChangeSet): { maxTurns: number; timeoutMs: number } {
  const n = change.files.length
  if (n <= 3) return { maxTurns: 20, timeoutMs: 300_000 }
  if (n <= 10) return { maxTurns: 28, timeoutMs: 360_000 }
  return { maxTurns: 36, timeoutMs: 480_000 }
}

const FALLBACK_MAX_TURNS = 28
const FALLBACK_TIMEOUT_MS = 360_000

/** 早收敛预算计划 — 按规模分级:
 *  小改动(≤15轮)强收敛——禁止扩散探索,强制半数轮次前产出草案;
 *  大改动宽松——保留分页约束和收尾期限。
 *  read 规则必须机械可执行(先聚焦、再精读)——此前的"禁止整文件 read"是
 *  意图性表述,模型首读时不遵守(2026-07-24 诊断:失败 worker 首读全量、
 *  后续 read 全带 offset/limit,说明它会用,缺的是首读时的硬规则)。 */
function earlyConvergenceHint(maxTurns: number, timeoutMs: number): string {
  const timeoutS = Math.round(timeoutMs / 1000)
  const draftDeadline = Math.max(3, Math.floor(maxTurns * 0.5))
  const finalDeadline = maxTurns - 1
  if (maxTurns <= 15) {
    return [
      `预算约束(${maxTurns} 轮/${timeoutS}s)——这是小改动审查,严禁扩散探索:`,
      `1) 首轮 git diff / git show 锁定改动,只读变更文件;`,
      `2) 第 ${draftDeadline} 轮前必须产出结论草案;`,
      `3) 第 ${finalDeadline} 轮停止一切工具调用,输出 verdict JSON——未覆盖项显式标注,best-effort > 无结论。`,
    ].join('\n')
  }
  return [
    `预算约束(${maxTurns} 轮/${timeoutS}s),按此节奏收敛:`,
    `1) 首轮先 git diff/git show 锁定改动区间,再决定读什么;`,
    `2) 首次阅读先用 grep/repo_graph 或 read_file(focus="审查重点")，只把高相关片段放入上下文；已知行号后再用 offset+limit(limit≤200) 精读。禁止无焦点整文件 read；看区段可用 read_section;`,
    `3) 第 ${draftDeadline} 轮前产出结论草案;`,
    `4) 第 ${finalDeadline} 轮停止一切探索,输出 verdict JSON——未覆盖项显式标注,best-effort 结论优于无结论。`,
  ].join('\n')
}

function wiringReviewerRequest(change: ChangeSet, options: CoordinatorReviewDepsOptions): DelegationRequest {
  const wiring = INSPECTORS.find(i => i.name === '接线审查')!
  const budget = computeAutoReviewBudget(change)
  return {
    ...request({
      change,
      options,
      kind: 'review',
      profile: 'reviewer',
      objective: [
        inspectorObjective(wiring, change),
        earlyConvergenceHint(budget.maxTurns, budget.timeoutMs),
      ].join('\n'),
    }),
    budget,
  }
}

export function createCoordinatorReviewDeps(
  coordinator: ReviewCoordinator,
  options: CoordinatorReviewDepsOptions = {},
): ReviewRouterDeps {
  return {
    spawnVerifier: async (change, _signal, onActivity) => {
      const run = await coordinator.delegate(request({
        change,
        options,
        kind: 'verify',
        profile: 'adversarial_verifier',
        objective: verifierObjective(change),
        onActivity,
      }), options.abortSignal)
      return verifierResult(run)
    },

    spawnPatcher: async (change, verifier, _signal, onActivity) => {
      const run = await coordinator.delegate(request({
        change,
        options,
        kind: 'patch_proposal',
        profile: 'patcher',
        objective: patcherObjective(change, verifier),
        onActivity,
      }), options.abortSignal)
      return patcherResult(run)
    },

    spawnSquadron: async (change, _signal, onActivity): Promise<SquadronResult> => {
      const requests = squadronRequests(change, options, onActivity)
      const run = coordinator.delegateBatch
        ? await coordinator.delegateBatch(requests, 'all_required', options.abortSignal)
        : await runSquadronSerially(coordinator, requests, options.abortSignal)
      return { findings: mapSquadronFindings(run), infraFailures: mapSquadronInfraFailures(run) }
    },

    spawnWiringReviewer: async (change, _signal, onActivity): Promise<SquadronResult> => {
      // Auto review: 2 inspectors in parallel (Wiring + Silence).
      // Wiring catches "built ≠ wired ≠ effective", Silence catches
      // swallowed errors, false green claims, and counterexample gaps.
      // Flash models are reliable enough at these focused axes.
      const budget = computeAutoReviewBudget(change)
      const wiring = INSPECTORS.find(i => i.name === '接线审查')!
      const silence = INSPECTORS.find(i => i.name === '静默审查')!
      const requests = [wiring, silence].map(inspector => ({
        ...request({
          change,
          options,
          kind: 'review' as const,
          profile: 'reviewer' as const,
          objective: [
            inspectorObjective(inspector, change),
            earlyConvergenceHint(budget.maxTurns, budget.timeoutMs),
          ].join('\n'),
          onActivity,
        }),
        budget,
      }))
      const run = coordinator.delegateBatch
        ? await coordinator.delegateBatch(requests, 'all_required', options.abortSignal)
        : await runSquadronSerially(coordinator, requests, options.abortSignal)
      return { findings: mapSquadronFindings(run), infraFailures: mapSquadronInfraFailures(run) }
    },
  }
}

async function runSquadronSerially(
  coordinator: ReviewCoordinator,
  requests: DelegationRequest[],
  abortSignal?: AbortSignal,
): Promise<CoordinatorRun> {
  const results: CoordinatorRun['results'] = []
  for (const req of requests) {
    const run = await coordinator.delegate(req, abortSignal)
    results.push(...run.results)
  }
  return {
    status: 'completed',
    results,
    packet: results.map(result => result.summary).join('\n'),
    aggregationPolicy: 'all_required',
  }
}
