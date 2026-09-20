import type { WorkOrderKind, WorkerProfile } from './work-order.js'
import type { DependencyEdge } from './work-order.js'

// ── Phase 1 lightweight model ──────────────────────────────────────────────

export interface TeamTaskDraft {
  id: string
  title: string
  objective: string
  files: string[]
  profile: WorkerProfile
  kind: WorkOrderKind
  verification: string[]
  /** 依赖（收编 #6）：纯任务 id 或条件边（{ dependsOn, onFailure, alternateOrderId }）。
   *  draft 阶段可选——markdown 解析后由 draftToTeamTask 填充。 */
  dependsOn?: Array<string | DependencyEdge>
}

// ── Phase 3.5 enriched model ───────────────────────────────────────────────

export interface TeamTask extends TeamTaskDraft {
  dependsOn: Array<string | DependencyEdge>
  riskTier: 'low' | 'medium' | 'high'
  touchSet: string[]
  groupId?: string
  routeHint?: 'planner_strong' | 'review_strong' | 'executor_cheap' | 'executor_strong'
}

export interface TeamGroup {
  id: string
  tasks: string[]
  reason: string
  parallel: boolean
  risk: 'low' | 'medium' | 'high'
}

export interface VerificationGate {
  command: string
  expected: string
  scope: 'full' | 'targeted'
  taskId?: string
}

export interface RiskItem {
  taskId?: string
  severity: 'low' | 'medium' | 'high'
  claim: string
  mitigation: string
}

export interface PlanDecision {
  id: string
  title: string
  rationale: string
  source: 'tianquan' | 'tianfu' | 'tianxuan' | 'primary'
  outcome: 'accepted' | 'rejected' | 'deferred'
}

export interface UnifiedTeamPlan {
  mission: string
  mode: 'standard' | 'max'
  tasks: TeamTask[]
  groups: TeamGroup[]
  verification: VerificationGate[]
  risks: RiskItem[]
  decisions: PlanDecision[]
  nonGoals: string[]
  /** 待验证假设（计划「待验证假设」章节）——planJson 路径的 assumption 载体。 */
  assumptions?: string[]
}

// ── Markdown section model (internal) ──────────────────────────────────────

interface Section {
  id: string
  title: string
  content: string[]
}

// ── Parsing constants ──────────────────────────────────────────────────────

const TASK_HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:\*\*)?(?:(Task\s+\d+[A-Za-z]?|T\d+[A-Za-z]?|Step\s+\d+[A-Za-z]?)(?:\s*[:：.\-–—]\s*|\s+)(.*)|((?:Task|Step)\s+\d+[A-Za-z]?|T\d+[A-Za-z]?))\*?\*?\s*$/i
const FILE_PATH_RE = /(?:`([^`]+)`|\b((?:src|docs|specs|test|tests|\.rivet)\/[\w./@+-]+(?:\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|css|scss))?))/g

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeTaskId(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

function unique<T>(values: T[]): T[] {
  // 对象元素按序列化键去重（同键只保留一条——依赖对象按 dependsOn+onFailure+alternate）。
  return [...new Map(values.map(v => [JSON.stringify(v), v])).values()]
}

function stripLineNoise(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}|[-*]|\d+\.)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractFiles(text: string): string[] {
  const files: string[] = []
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const captured = (match[1] ?? match[2] ?? '').trim()
    if (!captured) continue
    // Backtick captures (match[1]) can wrap several comma/space-separated
    // paths, e.g. `src/a.ts, src/b.ts`. Split and validate each segment so a
    // multi-path backtick never becomes one malformed entry (which would
    // silently defeat file-overlap serialization downstream).
    for (const raw of captured.split(/[,，、;；\s]+/)) {
      const candidate = raw.replace(/[(),.;:]+$/g, '').trim()
      if (!candidate) continue
      if (!/^(src|docs|specs|test|tests|\.rivet)\//.test(candidate)) continue
      files.push(candidate)
    }
  }
  return unique(files)
}

/**
 * Classify task by TITLE ONLY — never by body/verification lines.
 *
 * Priority order (first match wins):
 * 1. Title contains review/审查/验收  → reviewer
 * 2. Title contains verify/验证-only → adversarial_verifier
 * 3. Title contains scout/调研/搜索   → code_scout
 * 4. Everything else                  → patcher (default executor)
 *
 * Implementation tasks that mention "test" or "验证" in their body
 * must NOT be reclassified — those lines go into verification[] instead.
 */
function classifyTask(title: string): Pick<TeamTaskDraft, 'profile' | 'kind'> {
  const lower = title.toLowerCase()
  if (/审查|验收|review|squadron|inspector/.test(lower)) {
    return { profile: 'reviewer', kind: 'review' }
  }
  if (/^验证$|^verify$|^verification$|验证任务|verify task/i.test(lower)) {
    return { profile: 'adversarial_verifier', kind: 'verify' }
  }
  if (/调研|搜索|查找|scout|research|定位/.test(lower)) {
    return { profile: 'code_scout', kind: 'code_search' }
  }
  return { profile: 'patcher', kind: 'patch_proposal' }
}

function classifyRiskTier(text: string): TeamTask['riskTier'] {
  const lower = text.toLowerCase()
  if (/auth|security|concurrency|persist|public.?api|config.*schema|schema.*config|migration/i.test(lower)) {
    return 'high'
  }
  if (/refactor|renam|mov|restructure/i.test(lower)) {
    return 'medium'
  }
  return 'low'
}

function extractVerification(lines: string[]): string[] {
  // Only treat a line as a verification command when it actually looks like
  // one: a recognized command token (npm/npx/node/tsx/tsc/run_tests/typecheck)
  // OR a backtick-wrapped code span. Bare prose mentions of 验证/测试 must NOT
  // be collected — otherwise sentences like "需要测试整个流程" become fake
  // VerificationGates whose `command` is not a runnable shell command.
  const COMMAND_RE = /\b(?:npm|npx|node|tsx|tsc|run_tests|typecheck|pnpm|yarn|jest|vitest|make)\b/i
  return unique(lines
    .map(stripLineNoise)
    .filter(line => COMMAND_RE.test(line) || /`[^`]+`/.test(line)))
}

/**
 * 解析单个依赖引用（收编 #6 语法）：
 * - 纯 `T1` → 字符串（向后兼容）
 * - `T1(onFailure:skip)` → { dependsOn: 'T1', onFailure: 'skip' }
 * - `T2(onFailure:alternate:T3)` → { dependsOn: 'T2', onFailure: 'alternate', alternateOrderId: 'T3' }
 * 无法解析的形态原样返回字符串（保持旧行为，不误吞）。
 */
function parseDependencyRef(raw: string): string | DependencyEdge {
  const m = raw.match(/^([A-Za-z0-9_-]+)\(onFailure:(skip|alternate)(?::([A-Za-z0-9_-]+))?\)$/)
  if (!m) return raw
  const id = m[1]!
  const onFailure = m[2] as 'skip' | 'alternate'
  const alternateId = m[3]
  if (onFailure === 'alternate' && !alternateId) return raw
  return {
    dependsOn: id,
    onFailure,
    ...(alternateId ? { alternateOrderId: alternateId } : {}),
  }
}

function extractDependencies(lines: string[]): Array<string | DependencyEdge> {
  const deps: Array<string | DependencyEdge> = []
  for (const line of lines) {
    const m = line.match(/(?:depends?\s*(?:on)?|依赖|前置)\s*[:：]?\s*(.+)/i)
    if (m) {
      const refs = m[1]!.split(/[,，、;；\s]+/).filter(r => r && r.toLowerCase() !== 'none')
      deps.push(...refs.map(parseDependencyRef))
    }
  }
  return unique(deps)
}

// ── Section → Draft conversion ─────────────────────────────────────────────

function sectionToDraft(section: Section): TeamTaskDraft {
  const content = section.content.join('\n').trim()
  const objective = [section.title, content].filter(Boolean).join('\n').trim() || section.id
  const classification = classifyTask(section.title || section.id)
  return {
    id: section.id,
    title: section.title || section.id,
    objective,
    files: extractFiles(objective),
    profile: classification.profile,
    kind: classification.kind,
    verification: extractVerification(section.content),
  }
}

function draftToTeamTask(draft: TeamTaskDraft, sectionContent: string[]): TeamTask {
  const fullText = [draft.title, ...sectionContent].join('\n').toLowerCase()
  return {
    ...draft,
    dependsOn: extractDependencies(sectionContent),
    riskTier: classifyRiskTier(fullText),
    touchSet: [...draft.files],
    groupId: undefined,
    routeHint: undefined,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function parseTeamTaskDrafts(markdown: string): TeamTaskDraft[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(TASK_HEADING_RE)
    if (match) {
      if (current) sections.push(current)
      const rawId = match[1] ?? match[3] ?? 'Task'
      const tail = (match[2] ?? '').trim()
      const id = normalizeTaskId(rawId)
      current = { id, title: tail || id, content: [] }
      continue
    }
    if (current) current.content.push(line)
  }

  if (current) sections.push(current)
  return sections.map(sectionToDraft)
}

/** Parse markdown into enriched TeamTask[] with dependencies and risk classification. */
export function parseTeamTasks(markdown: string): TeamTask[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(TASK_HEADING_RE)
    if (match) {
      if (current) sections.push(current)
      const rawId = match[1] ?? match[3] ?? 'Task'
      const tail = (match[2] ?? '').trim()
      const id = normalizeTaskId(rawId)
      current = { id, title: tail || id, content: [] }
      continue
    }
    if (current) current.content.push(line)
  }

  if (current) sections.push(current)
  return sections.map(section => {
    const draft = sectionToDraft(section)
    return draftToTeamTask(draft, section.content)
  })
}

/** Build a UnifiedTeamPlan from parsed tasks and a mission statement. */
export function buildUnifiedTeamPlan(
  mission: string,
  mode: 'standard' | 'max',
  tasks: TeamTask[],
  options?: { nonGoals?: string[]; assumptions?: string[] },
): UnifiedTeamPlan {
  return {
    mission,
    mode,
    tasks,
    groups: [],
    verification: tasks.flatMap(task =>
      task.verification.map(cmd => ({
        command: cmd,
        expected: 'exit 0',
        scope: 'targeted' as const,
        taskId: task.id,
      })),
    ),
    risks: tasks
      .filter(t => t.riskTier === 'high')
      .map(t => ({
        taskId: t.id,
        severity: 'high' as const,
        claim: `Task ${t.id} touches high-risk area`,
        mitigation: 'Serial execution + mandatory review',
      })),
    decisions: [],
    nonGoals: options?.nonGoals ?? [],
    assumptions: options?.assumptions ?? [],
  }
}

export function hasOverlappingFiles(a: TeamTaskDraft, b: TeamTaskDraft): boolean {
  if (a.files.length === 0 || b.files.length === 0) return false
  const bFiles = new Set(b.files)
  return a.files.some(file => bFiles.has(file))
}
