/**
 * Essence Gate — 知识准入闸（Wave 2，知识重构核心）。
 *
 * postSession 收口三路素材（正则观察缓冲 / agent 手动 remember / 失败素材），
 * 一次廉价 LLM 调用统一裁决，只有蒸馏成"可迁移本质原则"的知识才入库：
 *
 * - **事件性描述**（"改了 X 文件"、"上次这么错的"）→ 拒绝或改写为机制原则
 * - **失败素材** → 强制 salvage 形态（可迁移特质 + transferableTo + 淘汰原因），
 *   提炼不出即丢弃（cognition-mcp salvage 四元组）
 * - **与现存条目矛盾** → supersede：新条目入库 + 旧条目 validTo 封口
 * - **与现存条目重复** → 丢弃
 * - **LLM 不可用 / 超时 / 输出不可解析 → fail-closed**：不写入，宁缺毋滥，
 *   绝不回退到正则直写
 *
 * 结构性硬闸（LLM 说了不算的部分）：admit 必须带非空 transferableTo——
 * 回答不了"这条知识可迁移到哪"的内容不配占据知识库。
 */

import {
  appendMemoryEntry,
  supersedeMemoryEntry,
  readMemoryEntries,
  isCurrentEntry,
  type MemoryEntry,
  type MemoryKind,
} from './unified-memory.js'
import { createHash } from 'node:crypto'

// ── Types ──────────────────────────────────────────────────────────────────

export interface KnowledgeCandidate {
  text: string
  kind: string
  confidence: number
  /** 素材来路：observation=正则提取缓冲 / manual=agent 显式 remember / failure=失败蒸馏素材 / dream=会话蒸馏候选 */
  origin: 'observation' | 'manual' | 'failure' | 'dream'
  tags?: string[]
  sessionId?: string
  evidence?: string
}

export interface GateVerdict {
  /** 候选下标（与提交给 LLM 的编号一致）。 */
  index: number
  action: 'admit' | 'reject' | 'supersede'
  /** 机制原则改写（admit/supersede 时生效；缺省用原文）。 */
  refinedText?: string
  /** 适用范围——admit 的结构性必填项。 */
  transferableTo?: string[]
  /** 作用域元数据（模块/主题）。 */
  topic?: string
  /** supersede 时被取代的现存条目 id。 */
  supersedesId?: string
  /** 淘汰原因 / 裁决理由（失败素材 salvage 必填）。 */
  reason?: string
}

export interface EssenceGateResult {
  admitted: MemoryEntry[]
  rejected: number
  superseded: number
  /** Admitted entries 的 id+hash（gate-ledger join 用）。 */
  admittedRefs: Array<{ id: string; textHash: string }>
  /** Rejected 候选的 hash+片段（gate-ledger 复现检测用）。 */
  rejectedRefs: Array<{ textHash: string; snippet: string }>
  /** Superseded 的旧→新 id 映射。 */
  supersededRefs: Array<{ oldId: string; newId: string }>
  /** true = LLM 不可用或输出不可解析，本轮什么都没写（fail-closed）。 */
  failedClosed: boolean
  /** 失败归因（failedClosed=true 时）：timeout=内层预算超时 / invalid_output=
   *  输出不可解析 / llm_error=其他侧路错误。gate-ledger 据此区分假超时与真实失败。 */
  failureReason?: 'timeout' | 'invalid_output' | 'llm_error'
  /** 本次 gate 运行耗时（ms，含 LLM 调用）。 */
  durationMs?: number
}

/** 内层预算超时的哨兵错误——runEssenceGate 据此把超时与一般 LLM 错误分开归因。
 *  由侧路调用方（loop-factory 的 runGateCompletion）在预算点 reject。 */
export class EssenceGateTimeoutError extends Error {
  constructor(message = 'essence-gate LLM timeout') {
    super(message)
    this.name = 'EssenceGateTimeoutError'
  }
}

export interface EssenceGateDeps {
  cwd: string
  sessionId?: string
  /** 侧路 LLM 调用（廉价路由）。实现方负责 usage 落账。 */
  complete: (prompt: string, timeoutMs: number) => Promise<string>
  /** LLM 超时，超时 = fail-closed。默认 15s。 */
  timeoutMs?: number
  /** 单轮最多送审候选数。默认 20。 */
  maxCandidates?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_CANDIDATES = 20
/** 提交给 LLM 的现存条目上限（控制侧路 token 成本）。 */
const MAX_EXISTING_IN_PROMPT = 40

const VALID_KINDS = new Set<string>([
  'fact', 'decision', 'constraint', 'preference', 'finding',
  'user_constraint', 'user_preference', 'file_observation',
  'verification_fact', 'failure_pattern', 'security_finding',
  'worker_finding', 'project_rule',
  'convergence_insight', 'architectural_invariant', 'selection_rule',
  'conceptual_reframe', 'reusable_design_pattern',
])

// ── Prompt ─────────────────────────────────────────────────────────────────

export function buildGatePrompt(candidates: KnowledgeCandidate[], existing: MemoryEntry[]): string {
  const lines: string[] = []
  lines.push('You are a knowledge-base admission gate for a coding agent. Judge each CANDIDATE against strict quality criteria and the EXISTING knowledge entries.')
  lines.push('')
  lines.push('Admission rules:')
  lines.push('1. Only transferable essence principles are admitted: mechanism invariants, selection rules, architectural constraints. Rewrite vague material into a crisp principle (refinedText).')
  lines.push('2. Event-like records ("edited file X", "the error last time was Y", session telemetry) → reject.')
  lines.push('3. Failure material (origin=failure) must be salvaged into: the transferable trait + where it transfers (transferableTo) + why the original approach was discarded (reason). If no transferable trait can be extracted → reject.')
  lines.push('4. A candidate that contradicts an EXISTING entry on the same topic → action "supersede" with supersedesId set to that entry id. Never let contradictory rules coexist.')
  lines.push('5. A candidate duplicating an EXISTING entry → reject.')
  lines.push('6. Every admit/supersede MUST include non-empty transferableTo (scopes/modules/situations where this knowledge applies) and a short topic slug.')
  lines.push('')
  lines.push('EXISTING entries (current, id | kind | topic | text):')
  if (existing.length === 0) {
    lines.push('(none)')
  } else {
    for (const e of existing) {
      lines.push(`${e.id} | ${e.kind} | ${e.topic ?? '-'} | ${e.text.slice(0, 160)}`)
    }
  }
  lines.push('')
  lines.push('CANDIDATES (index | origin | kind | text):')
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    lines.push(`${i} | ${c.origin} | ${c.kind} | ${c.text.slice(0, 300)}`)
  }
  lines.push('')
  lines.push('Respond with ONLY a JSON array (no markdown fence), one verdict per candidate:')
  lines.push('[{"index":0,"action":"admit|reject|supersede","refinedText":"...","transferableTo":["..."],"topic":"...","supersedesId":"...","reason":"..."}]')
  return lines.join('\n')
}

// ── Verdict parsing（fail-closed on any structural surprise）────────────────

export function parseGateVerdicts(raw: string, candidateCount: number): GateVerdict[] | null {
  const jsonText = extractJsonArray(raw)
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const verdicts: GateVerdict[] = []
  const seen = new Set<number>()
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as Record<string, unknown>
    const index = typeof v.index === 'number' ? v.index : Number.NaN
    const action = v.action
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount) continue
    if (seen.has(index)) continue
    if (action !== 'admit' && action !== 'reject' && action !== 'supersede') continue
    seen.add(index)
    verdicts.push({
      index,
      action,
      refinedText: typeof v.refinedText === 'string' && v.refinedText.trim() ? v.refinedText.trim() : undefined,
      transferableTo: Array.isArray(v.transferableTo)
        ? v.transferableTo.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : undefined,
      topic: typeof v.topic === 'string' && v.topic.trim() ? v.topic.trim().toLowerCase() : undefined,
      supersedesId: typeof v.supersedesId === 'string' && v.supersedesId.trim() ? v.supersedesId.trim() : undefined,
      reason: typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim() : undefined,
    })
  }
  return verdicts
}

function extractJsonArray(raw: string): string | null {
  const trimmed = raw.trim()
  // 容忍 markdown fence 包裹
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

// ── Structural hard gates（不信任 LLM 输出的部分）───────────────────────────

/** admit/supersede 的结构性准入校验。返回 null = 该裁决降级为 reject。 */
function validateAdmission(
  verdict: GateVerdict,
  candidate: KnowledgeCandidate,
  existingIds: Set<string>,
): { text: string; transferableTo: string[]; topic?: string; supersedesId?: string } | null {
  const text = (verdict.refinedText ?? candidate.text).trim()
  if (text.length < 20) return null
  // 硬闸：无 transferableTo 不入库
  if (!verdict.transferableTo || verdict.transferableTo.length === 0) return null
  // 失败素材 salvage 必须带淘汰原因
  if (candidate.origin === 'failure' && !verdict.reason) return null
  if (verdict.action === 'supersede') {
    if (!verdict.supersedesId || !existingIds.has(verdict.supersedesId)) return null
  }
  return {
    text,
    transferableTo: verdict.transferableTo,
    topic: verdict.topic,
    supersedesId: verdict.action === 'supersede' ? verdict.supersedesId : undefined,
  }
}

function normalizeKind(kind: string): MemoryKind {
  return (VALID_KINDS.has(kind) ? kind : 'finding') as MemoryKind
}

/** 候选文本去标识化 hash（gate-ledger join 用）。 */
function hashCandidateText(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase().slice(0, 200)).digest('hex').slice(0, 16)
}

/** 送审前去重（session 内同文候选只审一次）。 */
function dedupeCandidates(candidates: KnowledgeCandidate[]): KnowledgeCandidate[] {
  const seen = new Set<string>()
  const result: KnowledgeCandidate[] = []
  for (const c of candidates) {
    const key = c.text.trim().toLowerCase().slice(0, 200)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(c)
  }
  return result
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function runEssenceGate(
  deps: EssenceGateDeps,
  rawCandidates: KnowledgeCandidate[],
): Promise<EssenceGateResult> {
  const startedAt = Date.now()
  const candidates = dedupeCandidates(rawCandidates).slice(0, deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
  if (candidates.length === 0) {
    return { admitted: [], rejected: 0, superseded: 0, admittedRefs: [], rejectedRefs: [], supersededRefs: [], failedClosed: false }
  }

  const existing = readMemoryEntries(deps.cwd)
    .filter(isCurrentEntry)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_EXISTING_IN_PROMPT)
  const existingIds = new Set(existing.map(e => e.id))

  const prompt = buildGatePrompt(candidates, existing)

  let raw: string
  try {
    raw = await deps.complete(prompt, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (error) {
    // fail-closed：LLM 不可用不写入，绝不回退正则直写。
    // 归因：超时哨兵（内层预算点 reject）→ timeout；其余 → llm_error。
    return {
      admitted: [], rejected: 0, superseded: 0, admittedRefs: [], rejectedRefs: [], supersededRefs: [],
      failedClosed: true,
      failureReason: error instanceof EssenceGateTimeoutError ? 'timeout' : 'llm_error',
      durationMs: Date.now() - startedAt,
    }
  }

  const verdicts = parseGateVerdicts(raw, candidates.length)
  if (verdicts === null) {
    return { admitted: [], rejected: 0, superseded: 0, admittedRefs: [], rejectedRefs: [], supersededRefs: [], failedClosed: true, failureReason: 'invalid_output', durationMs: Date.now() - startedAt }
  }

  const admitted: MemoryEntry[] = []
  const admittedRefs: EssenceGateResult['admittedRefs'] = []
  const rejectedRefs: EssenceGateResult['rejectedRefs'] = []
  const supersededRefs: EssenceGateResult['supersededRefs'] = []
  let rejected = 0
  let superseded = 0

  for (const verdict of verdicts) {
    const candidate = candidates[verdict.index]!
    if (verdict.action === 'reject') {
      rejected++
      rejectedRefs.push({ textHash: hashCandidateText(candidate.text), snippet: candidate.text.slice(0, 80) })
      continue
    }

    const admission = validateAdmission(verdict, candidate, existingIds)
    if (!admission) {
      rejected++
      rejectedRefs.push({ textHash: hashCandidateText(candidate.text), snippet: candidate.text.slice(0, 80) })
      continue
    }

    const entry = appendMemoryEntry(deps.cwd, {
      text: admission.text,
      kind: normalizeKind(candidate.kind),
      confidence: Math.min(candidate.confidence, 0.9),
      source: 'essence-gate',
      status: 'verified',
      tags: [...(candidate.tags ?? []), `gate:${candidate.origin}`],
      sessionId: candidate.sessionId ?? deps.sessionId,
      evidence: verdict.reason ?? candidate.evidence,
      transferableTo: admission.transferableTo,
      topic: admission.topic,
      validFrom: Date.now(),
    })
    // 写入前 scrub 判定整条为纯敏感 → 未落盘，按 reject 计（不进 admitted 台账）。
    if (!entry) {
      rejected++
      rejectedRefs.push({ textHash: hashCandidateText(candidate.text), snippet: candidate.text.slice(0, 80) })
      continue
    }
    admitted.push(entry)
    admittedRefs.push({ id: entry.id, textHash: hashCandidateText(entry.text) })

    if (admission.supersedesId) {
      if (supersedeMemoryEntry(deps.cwd, admission.supersedesId, entry.id)) {
        superseded++
        supersededRefs.push({ oldId: admission.supersedesId, newId: entry.id })
      }
    }
  }

  // LLM 漏判的候选（无裁决）按 reject 处理——宁缺毋滥
  for (let i = 0; i < candidates.length; i++) {
    if (!verdicts.some(v => v.index === i)) {
      rejected++
      rejectedRefs.push({ textHash: hashCandidateText(candidates[i]!.text), snippet: candidates[i]!.text.slice(0, 80) })
    }
  }

  return { admitted, rejected, superseded, admittedRefs, rejectedRefs, supersededRefs, failedClosed: false, durationMs: Date.now() - startedAt }
}
