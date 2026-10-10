/**
 * Plan Templates — load/save reusable plan skeletons from `.rivet/plan-templates/`.
 *
 * Each `.md` file in that directory is a plan template. The filename (without
 * extension) becomes the template name. Frontmatter provides metadata:
 *
 * ---
 * description: 先探索→分波→最后验证的标准流程
 * waves: 3
 * profiles: patcher, code_scout, adversarial_verifier
 * ---
 *
 * # 计划标题
 *
 * - [ ] 步骤 1
 * - [ ] 步骤 2
 *
 * Templates are loaded lazily and cached. Used by `/plan template <name>`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { planTemplatesDir } from '../config/paths.js'
import { normalizeFrontmatterSource } from '../utils/frontmatter.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

const TEMPLATES_DIR = '.rivet/plan-templates'

export interface PlanTemplate {
  name: string
  description: string
  /** The template body (markdown without frontmatter). */
  content: string
  estimatedWaves?: number
  recommendedProfiles?: string[]
  source: 'project' | 'user'
}

/** Parse simple frontmatter (key: value) + body from markdown. */
export function parseFrontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  markdown = normalizeFrontmatterSource(markdown)
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fmMatch) return { meta, body: markdown }
  const rawMeta = fmMatch[1]!
  const body = fmMatch[2] ?? ''
  for (const line of rawMeta.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) meta[m[1]!] = m[2]!.trim()
  }
  return { meta, body }
}

/** Get the templates directory for a given cwd. */
function getTemplatesDir(cwd: string): string {
  return join(cwd, TEMPLATES_DIR)
}

/** Get the user-global templates directory (~/.rivet/plan-templates). */
function getUserTemplatesDir(): string {
  return planTemplatesDir()
}

/**
 * Load all plan templates from project + user directories.
 * Project templates override user templates with the same name.
 * Pure I/O — returns [] if directories don't exist.
 */
export function loadPlanTemplates(cwd: string): PlanTemplate[] {
  const templates = new Map<string, PlanTemplate>()

  // User-global templates (~/.rivet/plan-templates)
  const userDir = getUserTemplatesDir()
  if (existsSync(userDir)) {
    for (const file of readdirSync(userDir)) {
      if (!file.endsWith('.md') || isFilesystemMetadata(file)) continue
      const name = file.replace(/\.md$/, '')
      const raw = readFileSync(join(userDir, file), 'utf-8')
      const { meta, body } = parseFrontmatter(raw)
      templates.set(name, {
        name,
        description: meta.description ?? '',
        estimatedWaves: meta.waves ? parseInt(meta.waves, 10) : undefined,
        recommendedProfiles: meta.profiles?.split(',').map(s => s.trim()).filter(Boolean),
        content: body,
        source: 'user',
      })
    }
  }

  // Project templates (.rivet/plan-templates) — override user
  const projDir = getTemplatesDir(cwd)
  if (existsSync(projDir)) {
    for (const file of readdirSync(projDir)) {
      if (!file.endsWith('.md') || isFilesystemMetadata(file)) continue
      const name = file.replace(/\.md$/, '')
      const raw = readFileSync(join(projDir, file), 'utf-8')
      const { meta, body } = parseFrontmatter(raw)
      templates.set(name, {
        name,
        description: meta.description ?? '',
        estimatedWaves: meta.waves ? parseInt(meta.waves, 10) : undefined,
        recommendedProfiles: meta.profiles?.split(',').map(s => s.trim()).filter(Boolean),
        content: body,
        source: 'project',
      })
    }
  }

  return Array.from(templates.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Get a single template by name. Returns null if not found. */
export function getPlanTemplate(cwd: string, name: string): PlanTemplate | null {
  return loadPlanTemplates(cwd).find(t => t.name === name) ?? null
}

/**
 * Save a plan as a template. Creates the directory if it doesn't exist.
 * Overwrites existing template with the same name.
 */
export function savePlanTemplate(cwd: string, name: string, content: string, description?: string): void {
  const dir = getTemplatesDir(cwd)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const fm = description ? `---\ndescription: ${description}\n---\n\n` : ''
  writeFileSync(join(dir, `${name}.md`), fm + content, 'utf-8')
}

/** Format the template list for display. */
export function formatTemplateList(templates: PlanTemplate[]): string {
  if (templates.length === 0) {
    return 'No plan templates. Create one in .rivet/plan-templates/*.md or save with /plan save <name>.'
  }
  const lines = ['Available plan templates:', '']
  for (const t of templates) {
    const badge = t.source === 'project' ? '[project]' : '[user]'
    const waves = t.estimatedWaves ? ` (${t.estimatedWaves} waves)` : ''
    lines.push(`  ${badge} ${t.name}${waves} — ${t.description || '(no description)'}`)
  }
  lines.push('', 'Use: /plan template <name> to load a template into plan mode.')
  return lines.join('\n')
}
