import { stringify as stringifyYaml } from 'yaml'
/**
 * Skill distillation — session-end "successful workflow → reusable skill draft".
 *
 * Mirrors the dream pipeline (dream.ts): a postSession hook gathers the session's
 * trajectory + verifications + decisions and, when a session looks like a
 * verified, repeatable procedure, distills a SKILL.md DRAFT into
 * `.rivet/skills/_drafts/`. Drafts are NEVER auto-loaded into the discovery
 * block (that is a frozen prefix region) — the user reviews them via
 * `/skill review` and promotes with `/skill approve <name>`.
 *
 * The distillation is deterministic and unit-testable: no LLM call is required.
 * (An optional `enrich` step can be layered on later without changing this core.)
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { VerificationMetadata } from '../tools/types.js'
import { parseSkillMarkdown, type SkillDefinition } from '../skills/skill-loader.js'

// ─── Tool phase classification ──────────────────────────────────

const READ_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'semantic_search', 'inspect_project',
  'repo_map', 'repo_graph', 'file_info', 'lsp_goto_definition',
  'lsp_find_references', 'related_tests',
])
const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'hash_edit', 'apply_patch'])
const VERIFY_TOOLS = new Set(['run_tests', 'deliver_task'])
const VERIFY_BASH_RE = /\b(test|tsc|type-?check|lint|eslint|build|vitest|jest|pytest|cargo\s+(test|check)|go\s+test|npm\s+(run\s+)?(test|build|typecheck))\b/i

type Phase = 'read' | 'write' | 'verify' | 'other'

function classifyPhase(tool: string, target: string): Phase {
  if (READ_TOOLS.has(tool)) return 'read'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (VERIFY_TOOLS.has(tool)) return 'verify'
  if (tool === 'bash') return VERIFY_BASH_RE.test(target) ? 'verify' : 'read'
  return 'other'
}

const PHASE_VERB: Record<Phase, string> = {
  read: '阅读 / 搜索',
  write: '修改',
  verify: '验证',
  other: '操作',
}

// ─── Types ──────────────────────────────────────────────────────

export interface SkillDistillInput {
  sessionId: string
  objective?: string | null
  decisions: string[]
  trajectory: TrajectoryEntry[]
  verifications: VerificationMetadata[]
  filesModified: string[]
  /** Existing skills (live registry) — used to avoid re-drafting covered ground. */
  existingSkills: Array<{ name: string; triggers: RegExp[] }>
}

export interface SkillDraftStep {
  phase: Phase
  /** Representative targets touched in this step (deduped, bounded). */
  targets: string[]
}

export interface SkillDraft {
  /** Filename-safe slug; also the frontmatter `name`. */
  slug: string
  description: string
  triggers: string[]
  steps: SkillDraftStep[]
  verifiedBy: string[]
  draftKey: string
  sessionId: string
}

const MIN_STEPS = 3
const MIN_KEYWORD_LEN = 3
const MAX_TRIGGERS = 4
const MAX_STEP_TARGETS = 3

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'add', 'fix',
  'use', 'make', 'run', 'src', 'test', 'tests', 'file', 'files', 'code',
  '修复', '实现', '添加', '一个', '这个', '使用', '问题', '功能', '代码', '文件',
])

// ─── Distillation ───────────────────────────────────────────────

/** Fold consecutive same-phase successful entries into numbered procedure steps. */
function foldSteps(trajectory: TrajectoryEntry[]): SkillDraftStep[] {
  const steps: SkillDraftStep[] = []
  for (const e of trajectory) {
    if (e.status === 'failed' || e.status === 'retried-failed') continue
    const phase = classifyPhase(e.tool, e.target)
    const target = (e.target || '').trim()
    const last = steps[steps.length - 1]
    if (last && last.phase === phase) {
      if (target && !last.targets.includes(target) && last.targets.length < MAX_STEP_TARGETS) {
        last.targets.push(target)
      }
    } else {
      steps.push({ phase, targets: target ? [target] : [] })
    }
  }
  return steps
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session-skill'
}

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.[^.]+$/, '')
}

function extractKeywords(objective: string | null | undefined, filesModified: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const k = raw.trim()
    if (k.length < MIN_KEYWORD_LEN) return
    const lower = k.toLowerCase()
    if (STOPWORDS.has(lower) || seen.has(lower)) return
    seen.add(lower)
    out.push(k)
  }
  for (const stem of filesModified.map(fileStem)) push(stem)
  if (objective) {
    for (const tok of objective.split(/[\s,，。、:：/\\()（）"'`]+/)) {
      if (/^[a-z0-9_\u4e00-\u9fa5-]+$/i.test(tok)) push(tok)
    }
  }
  return out.slice(0, MAX_TRIGGERS)
}

function buildDraftKey(steps: SkillDraftStep[], filesModified: string[]): string {
  const sig = steps.map(s => s.phase).join('>')
    + '|' + filesModified.map(fileStem).sort().join(',')
  return createHash('sha256').update(sig).digest('hex').slice(0, 12)
}

/**
 * Distill a session into a reusable skill draft, or null if the session does
 * not look like a verified, repeatable procedure worth proposing as a skill.
 */
export function distillSkillDraft(input: SkillDistillInput): SkillDraft | null {
  const passed = input.verifications.filter(v => v.status === 'passed')
  if (passed.length === 0) return null // 绿非证明：没有通过的验证就不配成 skill

  const steps = foldSteps(input.trajectory)
  if (steps.length < MIN_STEPS) return null

  const keywords = extractKeywords(input.objective, input.filesModified)

  // Dedup: if an existing skill's trigger already matches this objective or any
  // keyword, the ground is covered — don't draft a near-duplicate.
  const probe = [input.objective ?? '', ...keywords].filter(Boolean)
  for (const skill of input.existingSkills) {
    for (const re of skill.triggers) {
      if (probe.some(p => re.test(p))) return null
    }
  }

  const objective = (input.objective ?? '').trim()
  const slugSource = objective || input.filesModified.map(fileStem)[0] || input.sessionId.slice(0, 8)
  const slug = slugify(slugSource)

  const passLabel = `verified by ${passed.length} check${passed.length > 1 ? 's' : ''}`
  const description = (objective ? `${objective} — ` : '') + passLabel
  const verifiedBy = passed
    .slice(0, 5)
    .map(v => `${v.command} (passed ${v.passed})`)

  return {
    slug,
    description: description.slice(0, 200),
    triggers: keywords,
    steps,
    verifiedBy,
    draftKey: buildDraftKey(steps, input.filesModified),
    sessionId: input.sessionId,
  }
}

// ─── Rendering ──────────────────────────────────────────────────

/** Render a draft as a valid SKILL.md (parseable by parseSkillMarkdown). */
export function renderSkillDraftMarkdown(draft: SkillDraft): string {
  const id8 = draft.sessionId.slice(0, 8)
  const lines: string[] = []
  lines.push('---')
  lines.push(stringifyYaml({ name: draft.slug, description: draft.description, triggers: draft.triggers }).trimEnd())
  lines.push('---')
  lines.push('')
  lines.push(`# ${draft.slug}`)
  lines.push('')
  lines.push(`> 自动从会话 ${id8} 蒸馏的草稿。审核后用 \`/skill approve ${draft.slug}\` 入库，或 \`/skill reject ${draft.slug}\` 丢弃。`)
  lines.push('')
  lines.push('## Steps')
  draft.steps.forEach((s, i) => {
    const targets = s.targets.length > 0 ? `：${s.targets.join('、')}` : ''
    lines.push(`${i + 1}. ${PHASE_VERB[s.phase]}${targets}`)
  })
  lines.push('')
  lines.push('## Verified by')
  for (const v of draft.verifiedBy) lines.push(`- ${v}`)
  lines.push('')
  lines.push(`<!-- skill-draft-key: ${draft.draftKey} -->`)
  lines.push(`<!-- source-session: ${id8} -->`)
  lines.push('')
  return lines.join('\n')
}

// ─── Draft filesystem (persist / list / approve / reject) ───────

function draftsDir(cwd: string): string {
  return join(cwd, '.rivet', 'skills', '_drafts')
}

function extractDraftKey(content: string): string | null {
  return content.match(/<!--\s*skill-draft-key:\s*([^\s]+)\s*-->/)?.[1] ?? null
}

/** Persist a draft; skips if a draft with the same draft-key already exists. */
export function persistSkillDraft(cwd: string, draft: SkillDraft): { written: boolean; path: string } {
  const dir = draftsDir(cwd)
  // Dedup by draft-key across all existing drafts (same procedure → no re-draft).
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || isFilesystemMetadata(name)) continue
      try {
        if (extractDraftKey(readFileSync(join(dir, name), 'utf-8')) === draft.draftKey) {
          return { written: false, path: join(dir, name) }
        }
      } catch { /* ignore unreadable */ }
    }
  }

  // Avoid clobbering an unrelated draft that happens to share the slug.
  let fileName = `${draft.slug}.md`
  if (existsSync(join(dir, fileName))) {
    fileName = `${draft.slug}-${draft.draftKey.slice(0, 6)}.md`
  }
  const path = join(dir, fileName)
  writeFileAtomicSync(path, renderSkillDraftMarkdown(draft))
  return { written: true, path }
}

export interface SkillDraftSummary {
  name: string
  description: string
  path: string
}

/** List skill drafts (best-effort frontmatter parse for descriptions). */
export function listSkillDrafts(cwd: string): SkillDraftSummary[] {
  const dir = draftsDir(cwd)
  if (!existsSync(dir)) return []
  const out: SkillDraftSummary[] = []
  for (const file of readdirSync(dir).sort()) {
    if (file.startsWith('._') || !file.endsWith('.md')) continue
    const path = join(dir, file)
    const name = file.replace(/\.md$/, '')
    let description = ''
    try {
      description = parseSkillMarkdown(readFileSync(path, 'utf-8'), file).description
    } catch { /* keep name-only */ }
    out.push({ name, description, path })
  }
  return out
}

function resolveDraftPath(cwd: string, name: string): string | null {
  const dir = draftsDir(cwd)
  const direct = join(dir, name.endsWith('.md') ? name : `${name}.md`)
  if (existsSync(direct)) return direct
  return null
}

export function readSkillDraft(cwd: string, name: string): string | null {
  const path = resolveDraftPath(cwd, name)
  if (!path) return null
  try { return readFileSync(path, 'utf-8') } catch { return null }
}

export interface ApproveResult {
  ok: boolean
  skill?: SkillDefinition
  error?: string
}

/**
 * Promote a draft into `.rivet/skills/<name>.md`. Validates the frontmatter via
 * parseSkillMarkdown — an invalid draft is refused (not moved). Returns the
 * parsed SkillDefinition so the caller can hot-register it into the live
 * registry for the current session.
 */
export function approveSkillDraft(cwd: string, name: string): ApproveResult {
  const draftPath = resolveDraftPath(cwd, name)
  if (!draftPath) return { ok: false, error: `草稿 "${name}" 不存在` }

  let content: string
  try { content = readFileSync(draftPath, 'utf-8') } catch (e) {
    return { ok: false, error: `读取草稿失败: ${e instanceof Error ? e.message : String(e)}` }
  }

  let def: SkillDefinition
  try {
    def = parseSkillMarkdown(content, name.endsWith('.md') ? name : `${name}.md`)
  } catch (e) {
    return { ok: false, error: `草稿 frontmatter 非法,拒绝入库: ${e instanceof Error ? e.message : String(e)}` }
  }

  const destName = `${def.name}.md`
  const dest = join(cwd, '.rivet', 'skills', destName)
  if (existsSync(dest) || existsSync(join(cwd, '.rivet', 'skills', def.name))) {
    return { ok: false, error: `已存在同名 skill "${def.name}",请先重命名草稿或删除旧 skill` }
  }

  writeFileAtomicSync(dest, content)
  try { unlinkSync(draftPath) } catch { /* draft removal best-effort */ }
  def.source = 'rivet'
  def.bodyPath = dest
  return { ok: true, skill: def }
}

export function rejectSkillDraft(cwd: string, name: string): boolean {
  const path = resolveDraftPath(cwd, name)
  if (!path) return false
  try { unlinkSync(path); return true } catch { return false }
}
