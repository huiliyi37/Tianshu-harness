import { resolve } from 'node:path'
import { skillRegistry, loadProjectSkills, listInstallableSkills, countInstalledSkills } from '../skills/skill-loader.js'
import { resolveAppPromptInput } from '../tui/prompt-input-resolver.js'
import { getPaletteCommands } from '../tui/command-palette.js'
import type { RuntimeSessionManager, SkillStatus } from './session-manager.js'

export function isDraftSessionId(id: string | undefined): boolean {
  if (!id) return true
  const norm = id.trim().toLowerCase()
  return norm === 'default' || norm === 'draft' || norm === 'new'
}

export function listSkillsForSessionOrDraft(
  manager: RuntimeSessionManager,
  sessionId?: string,
  targetCwd?: string,
): { skills?: SkillStatus[]; loadErrors: string[] } {
  if (sessionId && !isDraftSessionId(sessionId)) {
    const skills = manager.listSkills(sessionId)
    if (skills) {
      const loadErrors = manager.getSkillLoadErrors(sessionId) ?? []
      return { skills, loadErrors }
    }
  }

  if (isDraftSessionId(sessionId)) {
    const cwd = targetCwd ? resolve(targetCwd) : manager.getDefaultCwd()
    let loadErrors: string[] = []
    try {
      const res = loadProjectSkills(cwd)
      loadErrors = res.errors
    } catch {
      /* best-effort */
    }
    const skills: SkillStatus[] = skillRegistry.list().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source ?? (s.builtIn ? 'builtin' : 'rivet'),
      enabled: true,
      editable: !!s.bodyPath && s.source !== 'builtin' && s.source !== 'plugin',
    }))
    return { skills, loadErrors }
  }

  return { skills: undefined, loadErrors: [] }
}

export function listInstallableSkillsForSessionOrDraft(
  manager: RuntimeSessionManager,
  sessionId?: string,
  targetCwd?: string,
) {
  if (sessionId && !isDraftSessionId(sessionId)) {
    const skills = manager.listInstallableSkills(sessionId)
    if (skills) {
      const installedCount = manager.installedSkillCount(sessionId) ?? 0
      return { skills, installedCount }
    }
  }

  if (isDraftSessionId(sessionId)) {
    const cwd = targetCwd ? resolve(targetCwd) : manager.getDefaultCwd()
    const skills = listInstallableSkills(cwd)
    const installedCount = countInstalledSkills(cwd)
    return { skills, installedCount }
  }

  return { skills: undefined, installedCount: 0 }
}

export interface ResolvedSlashPromptResult {
  prompt: string
  requiredTools?: readonly string[]
  error?: string
}

export function resolveSlashCommandPrompt(
  prompt: string,
  targetCwd: string,
): ResolvedSlashPromptResult {
  const trimmed = prompt.trim()
  if (!trimmed.startsWith('/')) {
    return { prompt }
  }

  try {
    loadProjectSkills(targetCwd)
  } catch {
    /* best-effort */
  }

  const knownCmds = new Set(
    getPaletteCommands()
      .filter((c) => c.name.startsWith('/'))
      .map((c) => c.name.slice(1).split(/\s/)[0]!),
  )

  const resolved = resolveAppPromptInput(trimmed, targetCwd, (name) => knownCmds.has(name))
  if (resolved === null) {
    const first = trimmed.split(/\s+/)[0]
    return {
      prompt,
      error: `Unknown slash command: "${first}". Type a normal message or use the command menu (+).`,
    }
  }

  return {
    prompt: resolved.prompt,
    requiredTools: resolved.requiredTools,
  }
}
