import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { CapabilityTask } from '../model/capability.js'
import type { VerificationMetadata } from '../tools/types.js'
import { profileRegistry, tierTimeoutMultiplier } from './profile-registry.js'
import { starDomainRegistry } from './star-domain-registry.js'
import { resolveAuthorityReason } from './star-domain.js'
import { progressiveTimeout } from './timeout-ladder.js'
import { repairInvalidJsonEscapes } from '../api/json-escape-repair.js'
import { repairJsonSyntax } from '../api/json-syntax-repair.js'

export const READ_ONLY_WORKER_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests'] as const

/**
 * Write-capable worker tools. Patcher/verifier profiles are classified as
 * 'hands' role (see coordination-policy.ts:classifyProfile) and dispatched
 * through runHands → runHandsSession, which creates an isolated git worktree
 * before the worker executes. The worktree isolation ensures writes are
 * scoped and mergeable, but write operations may still be blocked by the
 * host agent framework's subagent sandbox — that is a host-layer constraint,
 * not a Rivet permission issue.
 */
export const WRITE_WORKER_TOOLS = ['read_file', 'read_section', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'repo_graph', 'related_tests', 'edit_file', 'write_file', 'bash', 'run_tests'] as const
export const PHASE1_DISALLOWED_WORKER_TOOLS = ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task', 'delegate_batch'] as const

/** 领域轴 — 代码区域，团队协同的天然边界 */
export const domainAreaSchema = z.enum([
  'frontend',   // src/tui/
  'backend',    // src/agent/, src/api/, src/compact/, src/context/
  'prompt',     // src/prompt/
  'tools',      // src/tools/
  'config',     // src/config/
  'docs',       // docs/
  'tests',      // *.test.ts, *.spec.ts
])
export type DomainArea = z.infer<typeof domainAreaSchema>

export const workOrderKindSchema = z.enum([
  'code_search',
  'doc_research',
  'plan',
  'review',
  'verify',
  'patch_proposal',
])

export type WorkOrderKind = z.infer<typeof workOrderKindSchema>

/** Dynamic profile validation — accepts built-in + user-loaded profiles. */
export const workerProfileSchema = z.string().refine(
  (val) => profileRegistry.getProfileNames().includes(val),
  (val) => ({ message: `Unknown worker profile "${val}". Available: ${profileRegistry.getProfileNames().join(', ')}` }),
)

export type WorkerProfile = z.infer<typeof workerProfileSchema>

/** 字符串枚举聚合策略（现有五档）。quorum 是对象形态（带组级阈值 k）。 */
export const aggregationPolicyKinds = [
  'all_required',
  'first_success',
  'majority',
  'primary_decides',
  'weighted_confidence',
] as const

export const aggregationPolicySchema = z.union([
  z.enum(aggregationPolicyKinds),
  z.object({
    kind: z.literal('quorum'),
    /** 组内通过数达 k 即组通过（组阈值可由 aggregateResults 的 quorumGroups 覆盖）。 */
    k: z.number().int().min(1),
  }),
])

export type AggregationPolicy = z.infer<typeof aggregationPolicySchema>

export const workOrderScopeSchema = z.object({
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  externalUrls: z.array(z.string()).optional(),
  maxFiles: z.number().int().positive().optional(),
  maxTokens: z.number().int().min(1000).optional(),
  /**
   * 派发方声明：本 order 的写入对象与主控（primary）已写/已提交的文件重叠。
   * 审查链路（review-coordinator-deps 的 scope()）恒为 true——它的 files 就是
   * 被审文件，即主控刚写完的那批。判定消费见 isolation-policy.ts：
   * overlapsPrimary=true 的写工不得就地跑在主工作树。
   */
  overlapsPrimary: z.boolean().optional(),
})

export type WorkOrderScope = z.infer<typeof workOrderScopeSchema>

const workerBudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
  retryBackoffMs: z.number().int().positive(),
  maxRetryBackoffMs: z.number().int().positive(),
})

export type WorkerBudget = z.infer<typeof workerBudgetSchema>

/**
 * Enforce a work order's per-profile turn budget against a runtime's generic
 * default. The runtime factory hands back a broad default `maxTurns`; the work
 * order's `budget.maxTurns` (e.g. a reviewer's 6) must win whenever it's
 * tighter, otherwise the budget is decorative and workers run to the global cap.
 */
export function clampWorkerMaxTurns(runtimeDefault: number, budgetMaxTurns: number): number {
  return Math.min(runtimeDefault, budgetMaxTurns)
}

/**
 * Single derivation point for a worker's runtime session id (conversation
 * JSONL under ~/.rivet/sessions/<slug>/ AND artifact dir under
 * .rivet/artifacts/). Batch order ids (`batch:0`) are intentionally stable
 * across delegation runs (dependencies/resume/claims key off them), so
 * without a per-dispatch nonce every run of the session appends to the SAME
 * worker-batch-0.jsonl — cumulative context, stale artifacts (session
 * 2c1186f5). The coordinator mints a nonce per dispatch; both the worker's
 * AgentLoop session and the coordinator's artifact fallback registration
 * must derive through here so they stay in sync.
 */
export function deriveWorkerSessionId(orderId: string, dispatchNonce?: string): string {
  const base = `worker-${orderId.replace(/:/g, '-')}`
  return dispatchNonce ? `${base}-${dispatchNonce}` : base
}

/** 条件依赖边（星河收编 #6）：主依赖失败时的分支。
 *  - onFailure=skip：依赖失败 → 本任务不执行（清扫时标 skipped）
 *  - onFailure=alternate：依赖失败 → 改等 alternateOrderId（其完成才可运行，
 *    其失败则本任务同样跳过）。 */
export const dependencyEdgeSchema = z.object({
  dependsOn: z.string().min(1),
  onFailure: z.enum(['skip', 'alternate']).optional(),
  alternateOrderId: z.string().optional(),
})

export type DependencyEdge = z.infer<typeof dependencyEdgeSchema>
export type DependencyRef = string | DependencyEdge

/** 依赖的实际 id：字符串边取自身，条件边取 dependsOn。 */
export function dependencyId(dep: DependencyRef): string {
  return typeof dep === 'string' ? dep : dep.dependsOn
}

const workOrderSchema = z.object({
  id: z.string().min(1),
  parentTurnId: z.string().min(1),
  kind: workOrderKindSchema,
  profile: workerProfileSchema,
  objective: z.string().min(1),
  scope: workOrderScopeSchema,
  constraints: z.array(z.string()),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  dedupeKey: z.string().min(1),
  dependencies: z.array(z.union([z.string().min(1), dependencyEdgeSchema])),
  /** Logical group for coordinated or multi-perspective tasks. */
  groupId: z.string().min(1).optional(),
  /** 写工显式 opt-in 批级共享信息素（星河收编 #3）。读工默认共享；写工只有
   *  显式声明才挂批级 store（守护实现独立性）。 */
  batchStigmergy: z.boolean().optional(),
  aggregationPolicy: aggregationPolicySchema,
  budget: workerBudgetSchema,
  domain: domainAreaSchema.optional(),
  workerCwd: z.string().optional(),
  reviewDepth: z.number().int().min(0).optional(),
  /** B3: delegation nesting depth (0 = spawned by primary). Capped by the
   *  coordinator at MAX_DELEGATION_DEPTH — nesting allowed but gated. */
  delegationDepth: z.number().int().min(0).default(0),
  /** Star domain authority for cognitive injection (V3 Component A). */
  authority: z.string().optional(),
  /** Why this authority was chosen (≤60 chars). Omitted when authority unset. */
  authorityReason: z.string().max(60).optional(),
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier: z.enum(['low', 'medium', 'high']).optional(),
  /** Per-order provider/model override (highest routing precedence). When set,
   *  the worker runs on this exact provider/model with its own client/cache —
   *  used by heterogeneous council seats. Silently ignored if the provider is
   *  unknown or lacks credentials (runtimeFactory falls back to the session model). */
  modelOverride: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
  /** 瑶光门 tier 下限：路由结果不得低于此档（council 席位 tierHint+noDowngrade
   *  等场景）。只抬升不降级；modelOverride 仍然最高优先。 */
  tierFloor: z.enum(['cheap', 'balanced', 'strong']).optional(),
})

export type WorkOrder = z.infer<typeof workOrderSchema>

const verificationMetadataSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'blocked']),
  scope: z.enum(['full', 'targeted']),
  // 数值字段可选（2026-08-01）：worker 自报的 verification 只作交叉校验，
  // 系统补充的元数据（reconcileCapturedWorkerFacts）不含计数——不再硬性要求。
  exitCode: z.number().optional(),
  passed: z.number().optional(),
  failed: z.number().optional(),
  skipped: z.number().optional(),
  durationMs: z.number().optional(),
}) satisfies z.ZodType<VerificationMetadata>

export const workerFindingSchema = z.object({
  claim: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  /** 'firsthand' = worker 亲自 read/grep/跑命令拿到的原始观测。
   *  'inferred' = 基于已有信息的推断，未经 worker 亲自落地取证。
   *  省略时表示未声明（等同于旧版 finding，消费端按转述处理）。 */
  evidenceKind: z.enum(['firsthand', 'inferred']).optional(),
  /** file:line 引用（如 "src/agent/foo.ts:42"）或命令 exit code 引用（如 "cmd: node --test exit=0"）。
   *  一手实测必须至少带一条引用；转述推断可省略。 */
  evidenceRefs: z.array(z.string().min(1)).optional(),
  /** 结论极性：'defect' = 缺陷发现（省略时按 defect 处理，fail-closed）；
   *  'confirmation' = 核实通过（确认无问题/链路闭合）。审查 blocking 判定只认
   *  defect——confirmation 单独汇总为「已核实清单」，不进 blocking 文案。
   *  审查/验证类 worker 用，其他 worker 省略。 */
  polarity: z.enum(['defect', 'confirmation']).optional(),
  /** true = 本条 finding 由 salvageWorkerResult 从畸形报告中字段级打捞恢复
   *  （非 worker 完整报告解析所得）。打捞内容可能含模型幻觉（如不存在的
   *  file:line 引用），消费方必须按「未经核实的线索」处理，不得与正常解析的
   *  findings 同等采信。正常解析路径不带此字段。 */
  salvaged: z.boolean().optional(),
  /** salvage 打捞后机械校验发现的缺失引用（file:line 形式但文件不存在，如
   *  "src/a.py:1"）。存在即表明该 finding 的 evidenceRefs 里有幻觉引用，消费
   *  方应先核实再引用。仅打捞路径填充；正常解析路径不校验（不设此字段）。 */
  evidenceRefsMissing: z.array(z.string().min(1)).optional(),
})

const workerArtifactSchema = z.object({
  kind: z.enum(['note', 'patch', 'test_command', 'risk', 'question', 'diff']),
  title: z.string().min(1),
  content: z.string().min(1),
})

export type WorkerArtifact = z.infer<typeof workerArtifactSchema>

/** Root cause when a worker fails (status = 'blocked' or 'failed').
 *  Enables the primary agent to choose the right recovery strategy:
 *  - json_parse / schema_mismatch → retry with clearer format instructions
 *  - timeout / circuit_open → do NOT retry immediately, wait or skip
 *  - max_turns → deterministic budget exhaustion; same-budget retry is dead,
 *    re-dispatch with a bigger budget or narrower scope
 *  - worker_crash → retry may help (infra flake)
 *  - claim_conflict → resolve the conflict first
 *  - caller_aborted → the primary cancelled this, don't retry same request
 */
export type WorkerFailureReason =
  | 'caller_aborted'
  | 'circuit_open'
  | 'claim_conflict'
  | 'timeout'
  | 'max_turns'
  | 'stalled'
  | 'json_parse'
  | 'schema_mismatch'
  | 'worker_crash'
  | 'worker_blocked'
  | 'policy_short_circuit'
  | 'unknown'

export const workerResultSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1),
  findings: z.array(workerFindingSchema),
  artifacts: z.array(workerArtifactSchema),
  patchSummary: z.string().optional(),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.array(z.string()),
  /** Persisted diff artifact id (set by runHandsSession after落盘). Absent if the
   *  worker produced no diff or persistence failed. Carried through to
   *  DelegationActivity.artifactId so the UI can fetch this worker's diff. */
  diffArtifactId: z.string().optional(),
  examinedFiles: z.array(z.string()).optional(),
  risks: z.array(z.string()),
  nextActions: z.array(z.string()),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified', 'skipped']).default('unverified'),
  /** worker 自报的研究覆盖规模，可审计性计数；两 schema 必须同时加，否则 ingest 入口 zod strip 剥掉 */
  sourcesReviewed: z.number().int().min(0).optional(),
  /**
   * Why the worker failed — enables recovery-strategy differentiation.
   *
   * status × failureReason 消费矩阵（2026-08-25 收口）：
   * - caller_aborted → status 'blocked'：父会话主动取消，消费方不得重试、不得按完成态展示。
   * - timeout / max_turns → 预算耗尽：可续跑信号（hands-session 内部先续跑，
   *   放弃后才对外；消费方见二者不应自动再续）。
   * - worker_blocked → 环境/闸门阻断：环境中性，不计能力惩罚。
   * - circuit_open → 熔断：应退避而非立即重试。
   * - claim_conflict → 文件归属冲突：换文件集或等待，重试同一集合无意义。
   * - json_parse / schema_mismatch → 结果契约失败：已走 salvage 恢复，恢复
   *   内容可信度降级（parseErrorKind 细分）。
   * - stalled → 空转（几乎无工具调用耗尽预算）：诊断信号，非普通失败。
   * - worker_crash → 进程级崩溃：coordinator 兜底归类（classifyWorkerError）。
   * - policy_short_circuit → 策略短路；unknown → 无法归类。
   */
  failureReason: z.enum(['caller_aborted', 'circuit_open', 'claim_conflict', 'timeout', 'max_turns', 'stalled', 'json_parse', 'schema_mismatch', 'worker_crash', 'worker_blocked', 'policy_short_circuit', 'unknown']).optional(),
  /** Runtime metadata: 派发时的 objective，由 coordinator 盖章。
   *
   *  刻意**不进** `workerResultIngestSchema`——那份是 worker 自报的入口，zod 会
   *  把它写的 objective 剥掉。对账的两边必须有一边来自派发侧，否则 worker 可以
   *  把目标和交付写成自洽的一对。主控 packet 靠它把「派它去做什么」与「它交回
   *  什么」并排放在一起。 */
  objective: z.string().optional(),
  /** Runtime metadata: 派发侧 profile，由 coordinator 与 objective 同点盖章。
   *  刻意不进 ingest schema（同 objective 纪律）——digest/展示拿它标识身份时
   *  不能信 worker 自报。 */
  profile: z.string().optional(),
  /** Runtime metadata: 派发侧 authority（星域 id），与 profile 同点盖章。 */
  authority: z.string().optional(),
  /** Runtime metadata: 派发侧 logical group（DP 副本组/多视角组），由 coordinator
   *  与 objective 同点盖章。quorum 聚合按它分组；刻意不进 ingest schema（同
   *  objective 纪律）——分组不能信 worker 自报。 */
  groupId: z.string().optional(),
  /** Runtime metadata: actual model used by the worker. */
  model: z.string().optional(),
  /** Runtime metadata: provider used by the worker. */
  provider: z.string().optional(),
  /** Runtime metadata: coordinator-stamped dispatch scope and execution identity. */
  dispatchId: z.string().optional(),
  attemptId: z.string().optional(),
  parentAttemptId: z.string().optional(),
  /** Runtime metadata: cumulative token usage for this worker run. */
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
  /** D 度量：结果契约失败的细分类型（no_json/json_syntax/schema_field/truncated），
   *  由解析侧在 terminal 路径盖章——worker 自报不可信，但 hands 路径会经
   *  parseWorkerResult 内部往返一次，ingest 侧也要放行此键（同 failureReason 纪律）。 */
  parseErrorKind: z.enum(['no_json', 'json_syntax', 'schema_field', 'truncated']).optional(),
  /** M2 时间账：worker 从进全局并发门到 settle 的墙钟（含等槽排队），由
   *  coordinator 在 settle 后补账——非 worker 自报字段，不进 ingest schema。 */
  durationMs: z.number().optional(),
})

const workerResultIngestSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1).default('(no summary provided by worker)'),
  findings: z.union([
    z.array(z.union([workerFindingSchema, z.string().min(1)])),
    // Accept missing findings key entirely
    z.undefined().transform(() => [] as (z.infer<typeof workerFindingSchema> | string)[]),
  ]).default([]),
  artifacts: z.union([
    z.array(z.union([workerArtifactSchema, z.string().min(1)])),
    z.undefined().transform(() => [] as (z.infer<typeof workerArtifactSchema> | string)[]),
  ]).default([]),
  patchSummary: z.string().optional(),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.union([
    z.array(z.string()),
    z.undefined().transform(() => [] as string[]),
  ]).default([]),
  examinedFiles: z.array(z.string()).optional(),
  risks: z.union([
    // Accept structured risk objects (model infers shape from findings),
    // plain strings, or missing/empty. Coerced to strings in normalizeWorkerResult.
    z.array(z.union([z.record(z.string(), z.unknown()), z.string().min(1)])),
    z.undefined().transform(() => [] as (Record<string, unknown> | string)[]),
  ]).default([]),
  nextActions: z.union([
    z.array(z.union([z.record(z.string(), z.unknown()), z.string().min(1)])),
    z.undefined().transform(() => [] as (Record<string, unknown> | string)[]),
  ]).default([]),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified', 'skipped']).default('unverified'),
  /** worker 自报的研究覆盖规模，可审计性计数；两 schema 必须同时加，否则 ingest 入口 zod strip 剥掉 */
  sourcesReviewed: z.number().int().min(0).optional(),
  /** 运行时字段，不指望模型自己写。但 hands 路径会把上游构造好的结果
   *  `JSON.stringify` 后交给 `parseWorkerResult` 再解一次——不收这个键的话，
   *  写工的失败原因（含续跑判据依赖的 max_turns / timeout）会在这道内部序列化
   *  边界上被静默剥掉，主控只看到一个没有原因的 blocked。 */
  failureReason: z.enum(['caller_aborted', 'circuit_open', 'claim_conflict', 'timeout', 'max_turns', 'stalled', 'json_parse', 'schema_mismatch', 'worker_crash', 'worker_blocked', 'policy_short_circuit', 'unknown']).optional(),
  /** D 度量细分，同 failureReason 的内部往返纪律（见 workerResultSchema 同名注释）。 */
  parseErrorKind: z.enum(['no_json', 'json_syntax', 'schema_field', 'truncated']).optional(),
})

/** Worker 自报结果提交契约（对外导出）。与 workerResultIngestSchema 严格同源——
 *  同一 schema 对象，worker 端提交模板与解析侧校验共用一份定义，任何修改
 *  两侧自然同步，不会漂移。 */
export const WORKER_RESULT_SUBMIT_SCHEMA = workerResultIngestSchema

export type WorkerResult = z.infer<typeof workerResultSchema>

/** D 度量：结果契约失败的细分类型。failureReason 只给路由级枚举
 *  （json_parse / schema_mismatch），度量需要知道具体死法——
 *  是语法错、字段错、截断，还是根本没产出 JSON。 */
export type WorkerParseErrorKind =
  /** 全文找不到任何 JSON 候选（纯散文/思考流） */
  | 'no_json'
  /** JSON.parse 失败：未转义引号/逗号/括号等语法错 */
  | 'json_syntax'
  /** JSON 合法但 zod 校验不过：缺字段/类型错/多字段 */
  | 'schema_field'
  /** 输出被 maxTokens/中断截断（Unterminated string / Unexpected end） */
  | 'truncated'

/** 从 parseWorkerResult 抛出的错误分类。只认 WorkerResultParseError 与
 *  extractJsonCandidates 的「无 JSON」错误；其余返回 undefined（调用方不附带）。
 *
 *  zod issue 列表是 JSON 数组文本（'[' 开头），JSON.parse 报错是散文——
 *  借此区分候选的失败层级：全 zod → schema_field（JSON 合法但字段不合规）；
 *  任一语法错 → json_syntax（报告本身坏了，字段错只是碎片候选的副产品）。 */
export function classifyWorkerParseError(error: unknown): WorkerParseErrorKind | undefined {
  if (error instanceof WorkerResultParseError) {
    const joined = error.parseErrors.join(' | ')
    if (joined.includes(TRUNCATED_REPORT_MESSAGE)) return 'truncated'
    if (/Unterminated|string.*end|Unexpected end/i.test(joined)) return 'truncated'
    const hasSyntaxError = error.parseErrors.some(e => !e.trimStart().startsWith('['))
    return hasSyntaxError ? 'json_syntax' : 'schema_field'
  }
  const msg = error instanceof Error ? error.message : String(error)
  if (/did not contain a JSON object|no JSON/i.test(msg)) return 'no_json'
  return undefined
}

export interface CreateReadOnlyWorkOrderInput {
  id?: string
  parentTurnId: string
  kind: WorkOrderKind
  profile: WorkerProfile
  objective: string
  scope: WorkOrderScope
  constraints?: string[]
  dependencies?: Array<string | DependencyEdge>
  /** Logical group for related tasks. It participates in deduplication so
   * independent perspectives over the same file scope are all preserved. */
  groupId?: string
  aggregationPolicy?: AggregationPolicy
  budget?: Partial<WorkerBudget>
  domain?: DomainArea
  /** Review-router re-entrancy depth propagated across delegation boundaries. */
  reviewDepth?: number
  /** B3: delegation nesting depth (0 = spawned by primary). */
  delegationDepth?: number
  /** Star domain authority for cognitive injection (V3 Component A). */
  authority?: string
  /** Team planner risk tier for shadow-only model tier recommendation. */
  riskTier?: 'low' | 'medium' | 'high'
  /** B2: current session turn for progressive timeout calculation. */
  sessionTurn?: number
  /** Per-order provider/model override (highest routing precedence). */
  modelOverride?: { provider: string; model: string }
  /** 瑶光门 tier 下限：路由结果不得低于此档。只抬升不降级。 */
  tierFloor?: 'cheap' | 'balanced' | 'strong'
  /** 写工显式 opt-in 批级共享信息素（星河收编 #3）。 */
  batchStigmergy?: boolean
}

function toolsForAuthority(tools: string[], authority?: string): string[] {
  if (!authority) return tools

  const domainDef = starDomainRegistry.get(authority)
  if (!domainDef) {
    // Fail closed: an authority layer is an extra restriction. If the domain
    // id is misspelled or not loaded, do not silently fall back to the profile
    // tool set — that makes the restriction disappear without a signal.
    console.warn(
      `[work-order] Unknown authority "${authority}" — worker gets zero tools (fail-closed). ` +
      `Known domains: ${starDomainRegistry.getDomainIds().join(', ')}.`,
    )
    return []
  }

  const whitelist = new Set(domainDef.toolWhitelist)
  return tools.filter(t => whitelist.has(t))
}

/** Per-task constraint budget. Constraints render verbatim into the worker
 *  prompt, so an unbounded list would push out the objective it qualifies. */
const MAX_TASK_CONSTRAINTS = 12
/** 单条约束字符上限（含样板/任务级）。导出供 plan-constraints.ts 渲染器对齐——
 *  渲染器必须自己保证产出 ≤ 此值并带截断指针，避免此处无声再切一刀。 */
export const MAX_TASK_CONSTRAINT_CHARS = 400

/**
 * Profile discipline plus the dispatcher's task-level constraints.
 *
 * Appends rather than replaces: the profile lines carry the read-only and
 * report-shape discipline, and a caller supplying task constraints is adding a
 * requirement, not waiving those. Blank and duplicate entries are dropped so a
 * caller echoing a boilerplate line cannot double it.
 */
function withTaskConstraints(base: string[], task?: string[]): string[] {
  if (!task?.length) return base
  const seen = new Set(base)
  const extra: string[] = []
  for (const raw of task) {
    const item = raw.trim().slice(0, MAX_TASK_CONSTRAINT_CHARS)
    if (!item || seen.has(item)) continue
    seen.add(item)
    extra.push(item)
    if (extra.length >= MAX_TASK_CONSTRAINTS) break
  }
  return [...base, ...extra]
}

export function createReadOnlyWorkOrder(input: CreateReadOnlyWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile,
    objective: input.objective,
    scope: input.scope,
    constraints: withTaskConstraints(
      input.profile === 'adversarial_verifier'
        ? [
            'Return only evidence-backed claims.',
            'Do not suggest edits as completed changes.',
            'Do not request write, edit, or bash tools.',
            'Run tests whenever possible — your verdict requires command+evidence output.',
          ]
        : [
            'Return only evidence-backed claims.',
            'Do not suggest edits as completed changes.',
            'Do not request write, edit, bash, or test execution tools.',
          ],
      input.constraints,
    ),
    allowedTools: (() => {
      const profileDef = profileRegistry.get(input.profile)
      const tools = profileDef?.allowedTools ? [...profileDef.allowedTools] : [...READ_ONLY_WORKER_TOOLS]
      return toolsForAuthority(tools, input.authority)
    })(),
    disallowedTools: input.profile === 'adversarial_verifier'
      ? ['bash', 'write_file', 'edit_file', 'delegate_task', 'delegate_batch'] // run_tests NOT disallowed — it's the verifier's primary weapon
      : [...PHASE1_DISALLOWED_WORKER_TOOLS],
    dedupeKey: input.groupId
      ? `${input.kind}:group:${input.groupId}:${input.authority ?? 'default'}:${input.parentTurnId}:${input.scope.files?.join(',') || input.objective}`
      : `${input.kind}:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    groupId: input.groupId,
    batchStigmergy: input.batchStigmergy,
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      maxTurns: input.budget?.maxTurns ?? 24,
      maxTokens: input.budget?.maxTokens ?? profileRegistry.get(input.profile)?.defaultMaxTokens ?? 4096,
      timeoutMs: Math.round((input.budget?.timeoutMs
        ?? profileRegistry.get(input.profile)?.defaultTimeoutMs
        ?? progressiveTimeout(input.sessionTurn))
        * tierTimeoutMultiplier(input.tierFloor)),
      maxRetries: input.budget?.maxRetries ?? 2,
      retryBackoffMs: input.budget?.retryBackoffMs ?? 10000,
      maxRetryBackoffMs: input.budget?.maxRetryBackoffMs ?? 300000,
    },
    domain: input.domain,
    reviewDepth: input.reviewDepth,
    delegationDepth: input.delegationDepth ?? 0,
    authority: input.authority,
    authorityReason: resolveAuthorityReason(input.objective, input.authority),
    riskTier: input.riskTier,
    modelOverride: input.modelOverride,
    tierFloor: input.tierFloor,
  })
}

export interface CreateWriteWorkOrderInput extends Omit<CreateReadOnlyWorkOrderInput, 'profile'> {
  profile?: WorkerProfile
}

export function createWriteWorkOrder(input: CreateWriteWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile ?? 'patcher',
    objective: input.objective,
    scope: input.scope,
    constraints: withTaskConstraints([
      'Return a patchSummary describing all changes made.',
      'List every changed file in changedFiles.',
      'Include verification results if tests were run.',
    ], input.constraints),
    allowedTools: (() => {
      const writeProfile = input.profile ?? 'patcher'
      const profileDef = profileRegistry.get(writeProfile)
      const tools = profileDef?.allowedTools ? [...profileDef.allowedTools] : [...WRITE_WORKER_TOOLS]
      return toolsForAuthority(tools, input.authority)
    })(),
    disallowedTools: ['delegate_task', 'delegate_batch'],
    dedupeKey: input.groupId
      ? `write:group:${input.groupId}:${input.authority ?? 'default'}:${input.parentTurnId}:${input.scope.files?.join(',') || input.objective}`
      : `write:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    groupId: input.groupId,
    batchStigmergy: input.batchStigmergy,
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      // Self-contained shards run a full loop (implement + tsc/lint/tests) in one
      // context, so write workers need a generous turn budget to finish a
      // long-program shard without being cut off mid-task. Flash has a 1M window;
      // 8–14 turns was far too tight for real implement+verify work.
      // 32→48 (2026-08-10): 写工预算 300→600s 后单轮能跑更长，但轮数 32 仍会在
      // 多文件 shard（每文件 read+write+test 各 1-2 轮）里先撞顶；与 600s 墙钟
      // 对齐——墙钟先于轮数开枪，续跑才有意义。
      maxTurns: input.budget?.maxTurns ?? 48,
      maxTokens: input.budget?.maxTokens ?? profileRegistry.get(input.profile ?? 'patcher')?.defaultMaxTokens ?? 16384,
      timeoutMs: Math.round((input.budget?.timeoutMs
        ?? profileRegistry.get(input.profile ?? 'patcher')?.defaultTimeoutMs
        ?? progressiveTimeout(input.sessionTurn))
        * tierTimeoutMultiplier(input.tierFloor)),
      maxRetries: input.budget?.maxRetries ?? 1,
      retryBackoffMs: input.budget?.retryBackoffMs ?? 10000,
      maxRetryBackoffMs: input.budget?.maxRetryBackoffMs ?? 300000,
    },
    domain: input.domain,
    reviewDepth: input.reviewDepth,
    delegationDepth: input.delegationDepth ?? 0,
    authority: input.authority,
    authorityReason: resolveAuthorityReason(input.objective, input.authority),
    riskTier: input.riskTier,
    modelOverride: input.modelOverride,
    tierFloor: input.tierFloor,
  })
}

export function mapWorkOrderKindToCapabilityTask(kind: WorkOrderKind): CapabilityTask {
  switch (kind) {
    case 'code_search':
    case 'doc_research':
      return 'repo_summarization'
    case 'plan':
      return 'planning'
    case 'verify':
      return 'test_failure_diagnosis'
    case 'review':
    case 'patch_proposal':
      return 'risky_refactor'
  }
}
function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  return candidates
}

/** Marker for "the only parseable candidate was our own truncation repair".
 *  Not a JSON.parse message — the repair succeeds, which is exactly why the
 *  failure has to be announced explicitly. */
const TRUNCATED_REPORT_MESSAGE = 'Worker report was cut off mid-value; only the auto-closed repair parsed'

interface JsonCandidates {
  candidates: string[]
  /** The strategy-6 truncation repair, present only when the text was unbalanced.
   *  Callers use identity against this to tell "parsed the report" from "parsed a
   *  report we finished writing ourselves". */
  repaired?: string
}

function collectJsonCandidates(text: string): JsonCandidates {
  let repaired: string | undefined
  // Strategy 1: fenced JSON (```json ... ``` or ``` ... ```) — Codex-style multi-tag.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map(m => m[1]?.trim())
    .filter((c): c is string => Boolean(c?.includes('{') && c.includes('}')))

  // Strategy 2: balanced { ... } pairs anywhere in the response.
  const balanced = extractBalancedJsonCandidates(text)

  // Strategy 3: YAML/TOML fences — some models wrap JSON in ```yaml or ```toml.
  const altFenced = [...text.matchAll(/```(?:yaml|toml)?\s*([\s\S]*?)```/g)]
    .map(m => m[1]?.trim())
    .filter((c): c is string => Boolean(c?.startsWith('{') && c.endsWith('}')))

  const all = [...fenced, ...altFenced, ...balanced]

  // Strategy 4: tail extraction — models most often place JSON at the END of
  // the response after prose. Try the last N characters as a candidate.
  const TAIL_SIZE = 8000
  const tail = text.length > TAIL_SIZE ? text.slice(-TAIL_SIZE) : text
  const tailFirst = tail.indexOf('{')
  const tailLast = tail.lastIndexOf('}')
  if (tailFirst !== -1 && tailLast > tailFirst) {
    const tailCandidate = tail.slice(tailFirst, tailLast + 1)
    // Avoid duplicate of an already-captured balanced candidate
    if (!all.includes(tailCandidate)) {
      all.push(tailCandidate)
    }
  }

  if (all.length > 0) return { candidates: all }

  // Strategy 5: raw text — treat the entire trimmed message as a candidate.
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return { candidates: [trimmed] }
  }

  // Strategy 6: truncated JSON repair — find the first {, balance braces
  // AND close unclosed strings (maxTokens truncation mid-string is the
  // most common "Unterminated string in JSON" cause — brace-only repair
  // leaves the string open and JSON.parse still fails).
  const firstBrace = text.indexOf('{')
  if (firstBrace !== -1) {
    const truncated = text.slice(firstBrace)
    // Stack tracks opener order so closers are emitted in correct nesting
    // order (e.g. {"a":[{"b":"val → needs "}]} not "]} }).
    const stack: string[] = []
    let inStr = false
    let esc = false
    for (const ch of truncated) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') stack.push('{')
      else if (ch === '}') { if (stack.at(-1) === '{') stack.pop() }
      else if (ch === '[') stack.push('[')
      else if (ch === ']') { if (stack.at(-1) === '[') stack.pop() }
    }
    // Build repair suffix: close unclosed string first, then closers in
    // reverse stack order. If `esc` is still true, the last character was
    // a dangling `\` — strip it so the appended `"` closes the string
    // rather than being escaped.
    const closers = stack.reverse().map(opener => opener === '{' ? '}' : ']').join('')
    let suffix = ''
    if (inStr) suffix = '"'
    suffix += closers
    if (suffix) {
      // A suffix is only built when the text is genuinely unbalanced, so this
      // candidate existing at all means the report was cut off.
      repaired = (esc ? truncated.slice(0, -1) : truncated) + suffix
      all.push(repaired)
    }
  }

  if (all.length > 0) return { candidates: all, repaired }

  throw new Error('Worker result did not contain a JSON object')
}

/** Candidate JSON substrings of a worker report, newest strategy last. */
export function extractJsonCandidates(text: string): string[] {
  return collectJsonCandidates(text).candidates
}

function extractJsonParseError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseJsonCandidate(candidate: string): unknown {
  // 先尝试直接解析；失败后 repair 非法 JSON 转义序列（如 Windows 路径
  // "F:\x" 中的 \x）与语法故障（裸引号/尾逗号）再试。worker 输出含裸
  // 反斜杠/裸引号是高频故障模式（2026-09-06 审查 infra 归因：content 字段
  // 含「他说"好的"」裸引号致 7/11 findings 仅存 4；repair re-ask 实证无效——
  // 同模型同预算同提示词 = 同失败——语法故障应本地机械修，不重问模型）。
  try {
    return JSON.parse(candidate) as unknown
  } catch {
    const escapeRepaired = repairInvalidJsonEscapes(candidate)
    const syntaxRepaired = repairJsonSyntax(candidate)
    const attempts = [
      escapeRepaired,
      syntaxRepaired,
      escapeRepaired !== null ? repairJsonSyntax(escapeRepaired) : null,
    ]
    for (const repaired of attempts) {
      if (repaired === null || repaired === candidate) continue
      try {
        return JSON.parse(repaired) as unknown
      } catch {
        /* try next repair */
      }
    }
    throw new Error('JSON parse failed even after escape/syntax repair')
  }
}

function normalizeWorkerResult(raw: z.infer<typeof workerResultIngestSchema>): WorkerResult {
  return workerResultSchema.parse({
    ...raw,
    findings: raw.findings.map((finding, index) => typeof finding === 'string'
      ? { claim: finding, evidence: `worker finding ${index + 1}`, confidence: 'medium' as const }
      : finding),
    artifacts: raw.artifacts.map((artifact, index) => typeof artifact === 'string'
      ? { kind: 'note' as const, title: `Artifact ${index + 1}`, content: artifact }
      : artifact),
    risks: raw.risks.map(r => typeof r === 'string' ? r : JSON.stringify(r)),
    nextActions: raw.nextActions.map(a => typeof a === 'string' ? a : JSON.stringify(a)),
  })
}

function parseWorkerResultObject(parsed: unknown, expectedWorkOrderId: string): WorkerResult {
  // Fault tolerance for cheap models — but ONLY for genuine worker packets:
  // - Force workOrderId to expected value (models may omit or hallucinate it).
  // - Default missing status to 'blocked' (flash models frequently omit it).
  // A summary-only object without workOrderId (e.g. {"summary":"done",
  // "status":"passed"}) is NOT a worker packet: patching an id onto it would
  // fabricate a fake green. Leave it untouched so workerResultIngestSchema
  // rejects it and the caller's repair loop fires instead.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const hasWorkOrderId = typeof obj.workOrderId === 'string' && obj.workOrderId.length > 0
    if (hasWorkOrderId) {
      obj.workOrderId = expectedWorkOrderId
      if (obj.status === undefined || obj.status === null || obj.status === '') {
        obj.status = 'blocked'
      }
    }
  }

  const ingested = workerResultIngestSchema.parse(parsed)
  return normalizeWorkerResult(ingested)
}

/** Thrown when JSON candidates exist in the worker output but none parses into
 *  a schema-valid WorkerResult. MUST be thrown (not swallowed into a blocked
 *  result) so the caller's catch-driven repair loop fires — a single malformed
 *  character in an otherwise complete report is recoverable with one cheap
 *  in-session repair re-ask (worker context is prefix-cached). See session
 *  2c1186f5: a 10.9k-char scout report was discarded because the terminal
 *  blocked-return bypassed the repair loop entirely. */
export class WorkerResultParseError extends Error {
  constructor(
    readonly candidateCount: number,
    readonly parseErrors: readonly string[],
  ) {
    super(`JSON candidates found (${candidateCount}) but none parseable. Errors: ${parseErrors.join(' | ')}`.slice(0, 500))
    this.name = 'WorkerResultParseError'
  }
}

export function parseWorkerResult(text: string, expectedWorkOrderId: string): WorkerResult {
  // collectJsonCandidates throws when truly no JSON is found — let it propagate
  // so the caller's repair loop can trigger a retry with the repair prompt.
  const { candidates, repaired } = collectJsonCandidates(text)
  const errors: string[] = []

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = parseJsonCandidate(candidate)
    } catch (error) {
      errors.push(extractJsonParseError(error))
      continue
    }

    let result: WorkerResult
    try {
      result = parseWorkerResultObject(parsed, expectedWorkOrderId)
    } catch (error) {
      errors.push(extractJsonParseError(error))
      continue
    }

    // Reached only when every intact candidate already failed, so the only
    // thing that parsed is the report we auto-closed ourselves. Returning it
    // hands the caller a clean `passed` with a summary cut mid-sentence and
    // whatever findings happened to survive — indistinguishable from a worker
    // that genuinely had nothing to report. Throw instead: the caller's repair
    // loop re-asks, and if retries exhaust, salvageWorkerResult recovers the
    // same findings with status 'blocked' and evidenceStatus 'unverified'.
    if (repaired !== undefined && candidate === repaired) {
      throw new WorkerResultParseError(candidates.length, [TRUNCATED_REPORT_MESSAGE])
    }
    return result
  }

  // All JSON candidates failed to parse or validate. Throw so the caller's
  // repair loop fires (repair prompt / json-mode re-ask). Terminal handling
  // (salvage → blocked) is the caller's responsibility after retries exhaust.
  throw new WorkerResultParseError(candidates.length, errors)
}

/** Field-level salvage — the terminal tier between "repair retries exhausted"
 *  and an empty blocked result. Scans all JSON candidates for independently
 *  parseable finding objects and a summary string, and rebuilds a degraded but
 *  usable WorkerResult (status stays 'blocked', evidenceStatus 'unverified')
 *  so the primary keeps the scout's recoverable findings instead of losing the
 *  entire report to one syntax error. Returns null when nothing is salvageable.
 *
 *  Two-tier recovery:
 *  1. Candidate-level — a balanced/fenced candidate that is itself a finding
 *     object (`{claim,evidence,confidence}`) parses straight through.
 *  2. Finding-element-level — a candidate that parses to a wrapper object with
 *     a `findings` array (common when a fenced/tail candidate captures the full
 *     WorkerResult but its sibling fields contain an unescaped quote that broke
 *     `workerResultIngestSchema`). The wrapper itself fails the finding schema
 *     at the top level, but each element of `findings` may still be valid.
 *     Walk the array and safeParse each element. (Session f98bb237: a scout
 *     report with two bare `"` inside `content` fields lost 2/6 findings under
 *     tier 1 because their enclosing fenced candidate failed the finding
 *     schema; tier 2 recovered them.)
 *  Both tiers share one `seenClaims` set so the same finding isn't counted
 *  twice when a balanced candidate already captured it at tier 1. */
/**
 * 机械校验 evidenceRefs 的文件存在性（幻觉引用检测）。
 *
 * 只校验 `path:line` 形式（如 `src/foo.ts:42`，行号可缺省处理为最后冒号后
 * 为数字）；跳过 `cmd:` 前缀（命令 exit code 引用）与无冒号裸引用。roots 为
 * 候选根目录（worker 的 cwd 优先——evidenceRefs 相对被侦察项目而非本体），
 * 任一 root 下文件存在即通过。返回缺失引用列表，不抛错；roots 为空跳过校验。
 */
export function checkEvidenceRefs(refs: string[] | undefined, roots: string[]): string[] {
  if (!refs || refs.length === 0 || roots.length === 0) return []
  const missing: string[] = []
  for (const ref of refs) {
    if (ref.startsWith('cmd:')) continue
    const m = /^(.*?):(\d+)$/.exec(ref)
    if (!m) continue
    const path = m[1]!
    if (path === '') continue
    const exists = roots.some((root) => existsSync(join(root, path)))
    if (!exists) missing.push(ref)
  }
  return missing
}

/** 打捞标记：salvaged=true + 机械校验 evidenceRefs 缺失引用（幻觉检测）。
 *  缺省不校验（roots 为空）时仅打 salvaged 标，保持向后兼容。 */
function markSalvaged(finding: z.infer<typeof workerFindingSchema>, evidenceRoots?: string[]): z.infer<typeof workerFindingSchema> {
  const missing = evidenceRoots !== undefined && evidenceRoots.length > 0
    ? checkEvidenceRefs(finding.evidenceRefs, evidenceRoots)
    : []
  return {
    ...finding,
    salvaged: true,
    ...(missing.length > 0 ? { evidenceRefsMissing: missing } : {}),
  }
}

export function salvageWorkerResult(text: string, expectedWorkOrderId: string, parseError?: unknown, evidenceRoots?: string[]): WorkerResult | null {
  let candidates: string[]
  try {
    candidates = extractJsonCandidates(text)
  } catch {
    return null
  }

  const findings: z.infer<typeof workerFindingSchema>[] = []
  const seenClaims = new Set<string>()
  let recoveredFromWrapper = 0
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = parseJsonCandidate(candidate)
    } catch {
      continue
    }
    // Tier 1: candidate is itself a finding object.
    const finding = workerFindingSchema.safeParse(parsed)
    if (finding.success) {
      if (!seenClaims.has(finding.data.claim)) {
        seenClaims.add(finding.data.claim)
        findings.push(markSalvaged(finding.data, evidenceRoots))
      }
      continue
    }
    // Tier 2: candidate is a wrapper with a findings array (e.g. a fenced/
    // tail candidate capturing the whole WorkerResult whose sibling fields
    // failed schema validation). Walk the array and recover valid elements.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const wrapped = (parsed as { findings?: unknown }).findings
      if (Array.isArray(wrapped)) {
        for (const element of wrapped) {
          const inner = workerFindingSchema.safeParse(element)
          if (inner.success && !seenClaims.has(inner.data.claim)) {
            seenClaims.add(inner.data.claim)
            findings.push(markSalvaged(inner.data, evidenceRoots))
            recoveredFromWrapper++
          }
        }
      }
    }
  }
  if (findings.length === 0) return null

  const summaryMatch = text.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/)
  let extractedSummary = ''
  if (summaryMatch?.[1]) {
    try {
      extractedSummary = JSON.parse(`"${summaryMatch[1]}"`) as string
    } catch {
      extractedSummary = summaryMatch[1]
    }
  }

  const salvageDetail = recoveredFromWrapper > 0
    ? ` (${recoveredFromWrapper} recovered from a malformed wrapper object)`
    : ''

  return {
    workOrderId: expectedWorkOrderId,
    status: 'blocked',
    summary: `Worker report JSON was malformed; salvaged ${findings.length}/${candidates.length} candidate(s) as findings${salvageDetail}.${extractedSummary ? ` Worker's own summary: ${extractedSummary.slice(0, 300)}` : ''}`,
    findings,
    artifacts: [{
      kind: 'note',
      title: 'Parse-salvaged worker report',
      content: `Result contract failed but individual findings were recovered. Treat findings as unverified leads — the full report did not pass schema validation.`,
    }],
    changedFiles: [],
    risks: [`parse-salvaged: ${findings.length} finding(s) recovered from a malformed report — verify before trusting`],
    nextActions: ['Weigh salvaged findings as unverified leads; re-dispatch with resume if full fidelity is needed'],
    evidenceStatus: 'unverified',
    failureReason: 'json_parse',
    ...(parseError !== undefined ? { parseErrorKind: classifyWorkerParseError(parseError) ?? 'json_syntax' } : {}),
  }
}

/** verdict ≠ status（2026-08-02 审查语义失真事故）：审查/验证工单的「发现缺陷」
 *  不是 worker 运行失败。worker 把审查结论编码成 failed/escalated 时（有 findings
 *  且无 failureReason/parseErrorKind 等基础设施失败标记），归一为 passed：
 *  缺陷走 findings/polarity 通道；连败计数、熔断、升级只记真实运行失败。
 *  blocked（预算/超时死亡）不归一；非审查/验证类工单不归一。
 *  2026-08-02 事故：3 个审查 worker 报告全部解析成功，但因 verdict=fail 被计
 *  3 连败触发升级，且 findings 被 mapSquadronFindings 的 passed 过滤丢弃。 */
export function normalizeReviewVerdictStatus(order: WorkOrder, result: WorkerResult): WorkerResult {
  if (order.kind !== 'review' && order.kind !== 'verify') return result
  if (result.status !== 'failed' && result.status !== 'escalated') return result
  if (result.findings.length === 0) return result
  if (result.failureReason !== undefined || result.parseErrorKind !== undefined) return result
  return {
    ...result,
    status: 'passed',
    risks: [...result.risks, 'verdict-normalized: worker 将审查结论编码为 status，已按 verdict≠status 归一为 passed（缺陷见 findings/polarity）'],
  }
}

export function buildBlockedWorkerResult(order: WorkOrder, reason: string, failureReason?: WorkerFailureReason): WorkerResult {
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker blocked: ${reason}`,
    findings: [],
    artifacts: [{
      kind: 'risk',
      title: 'Worker result contract failed',
      content: reason,
    }],
    changedFiles: [],
    risks: ['Worker did not return schema-valid JSON'],
    nextActions: ['Primary should continue without trusting this worker result'],
    evidenceStatus: 'blocked',
    ...(failureReason ? { failureReason } : {}),
  }
}

/** 聚合策略中途达标（first_success 已有通过者 / quorum 组已达 k）后，
 *  未完成的兄弟 worker 被短路取消时的合成结果。不是故障：状态 blocked
 *  仅表示"没有产出"，evidenceStatus=skipped 表示证据门无需评估。 */
export function buildPolicyCancelledResult(order: WorkOrder, policyLabel: string): WorkerResult {
  return {
    workOrderId: order.id,
    objective: order.objective,
    groupId: order.groupId,
    status: 'blocked',
    summary: `Policy short-circuit: 聚合策略（${policyLabel}）已达标，本 worker 被取消以节省预算。这不是故障，无需重派。`,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [`policy_short_circuit: 兄弟结果已满足 ${policyLabel}，本结果被策略性取消`],
    nextActions: [`如需其部分产出，可 delegate_task({resume: "${order.id}"}) 续跑`],
    evidenceStatus: 'skipped',
    failureReason: 'policy_short_circuit',
  }
}
