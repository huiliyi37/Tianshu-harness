import { SkillManagement, type SkillContext } from '../skills/skill-management.js'
import { SkillImports, type ImportSource } from '../skills/skill-import.js'
import { SkillDrafts } from '../skills/skill-drafts.js'
import { completeSkillDraft } from '../skills/skill-draft-model.js'
import type { SkillMode } from '../skills/skill-metadata.js'
import { exportSessionSkillSnapshot, migrateSessionSkillSnapshot } from '../skills/skill-snapshot-maintenance.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSkillMarkdown } from '../skills/skill-loader.js'

export async function runSkillsCLI(args: string[], options: { cwd?: string; management?: SkillManagement } = {}): Promise<{ output: string; exitCode: number }> {
  const service = options.management ?? new SkillManagement(), imports = new SkillImports(service)
  const command = args[0] ?? 'list'
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const cwd = value('--project') ?? options.cwd ?? process.cwd()
  const scope = value('--scope')
  const target = (): SkillContext => {
    if (scope !== 'personal' && scope !== 'project') throw new Error('Specify --scope personal or --scope project [--project /absolute/path]')
    return { scope, cwd }
  }
  const identity = () => {
    const list = service.list(cwd).skills
    const id = args[1]
    const matches = list.filter(s => (s.skillId === id || s.name === id) && (!scope || s.scope === scope))
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous skill; specify skillId or --scope' : 'Skill not found')
    return matches[0]!
  }
  try {
    let result: unknown
    if (command === 'snapshot-migrate') result = migrateSessionSkillSnapshot(cwd, args[1]!, args.includes('--apply'))
    else if (command === 'snapshot-export') {
      const output = value('--output')
      if (!output) throw new Error('Usage: rivet skills snapshot-export <sessionId> --output <new-file> [--project /absolute/path]')
      result = exportSessionSkillSnapshot(cwd, args[1]!, output)
    }
    else if (command === 'list') { const catalog = service.list(cwd); result = { ...catalog, skills: catalog.skills.filter(s => !scope || s.scope === scope) } }
    else if (command === 'doctor') {
      const catalog = service.list(cwd)
      result = { ...catalog, diagnostics: catalog.skills.flatMap(s => [
        ...(s.shadowedBy ? [{ skillId: s.skillId, code: 'shadowed', detail: s.shadowedBy }] : []),
        ...(s.metadata?.unsupported.map(field => ({ skillId: s.skillId, code: 'unsupported-execution-field', detail: field })) ?? []),
        ...(s.metadata?.dependencies.map(dependency => ({ skillId: s.skillId, code: 'dependency-needs-verification', detail: dependency })) ?? []),
      ]), effective: 'new-session' }
    }
    else if (command === 'inspect') { const skill = identity(); result = { ...skill, content: service.content(skill.skillId, cwd) } }
    else if (command === 'mode') result = service.setMode(identity().skillId, args[2] as SkillMode, cwd)
    else if (command === 'remove') {
      const skill = identity()
      if (!args.includes('--yes')) throw new Error('Use --yes to confirm removal after inspect')
      service.remove(skill.skillId, value('--version') ?? skill.version, cwd); result = { removed: skill.skillId }
    } else if (command === 'add') {
      const context = target()
      const input = args[1]
      if (!input || input.startsWith('--')) throw new Error('Usage: rivet skills add <path|repository> --scope project|personal [--ref ref] [--subpath path] [--select name,...]')
      const source: ImportSource = args.includes('--git') || /^(https?:|ssh:|git@|file:)/.test(input)
        ? { kind: 'git', url: input, ref: value('--ref'), subpath: value('--subpath') }
        : input.endsWith('.zip') ? { kind: 'zip', path: input } : { kind: 'local', path: input }
      const preview = await imports.preview(source)
      if (args.includes('--preview')) result = preview
      else {
        const names = value('--select')?.split(',')
        if (!names && preview.candidates.length !== 1 && !args.includes('--all')) throw new Error('Multiple skills found; use --select name,... or --all after --preview')
        const selected = preview.candidates.filter(c => !names || names.includes(c.name))
        if (names && names.some(name => !selected.some(c => c.name === name))) throw new Error('Selected skill was not found')
        result = imports.install(preview.previewId, context, selected.map(c => ({ candidateId: c.candidateId, name: value('--name'),
          conflict: args.includes('--overwrite') ? 'overwrite' : 'skip', expectedVersion: value('--version') })))
      }
    } else if (command === 'draft') {
      const context = target(), name = args[1], file = value('--file')
      if (!name || name.startsWith('--') || !file || file.startsWith('--')) throw new Error('Usage: rivet skills draft <name> --file <markdown-path> --scope personal|project [--project /absolute/path]')
      const content = readFileSync(resolve(cwd, file), 'utf8')
      const skill = parseSkillMarkdown(content, name)
      if (!skill.description.trim() || !skill.body.trim()) throw new Error('Skill draft requires a description and instructions')
      result = new SkillDrafts(service).save(context, name, content)
    } else if (command === 'drafts') result = new SkillDrafts(service).list(target())
    else if (command === 'approve') result = new SkillDrafts(service).approve(target(), args[1]!)
    else if (command === 'reject') result = new SkillDrafts(service).reject(target(), args[1]!)
    else if (command === 'generate') result = await new SkillDrafts(service).generate(target(), { name: args[1]!, goal: value('--goal') ?? '', paths: value('--files')?.split(',') ?? [], excerpt: value('--excerpt') }, completeSkillDraft)
    else if (command === 'update') {
      const skill = identity(), preview = await imports.update(skill.skillId, cwd)
      if (preview.candidates.length !== 1) throw new Error('Update source no longer contains exactly one skill; inspect the repository and use add with explicit selection')
      const candidate = preview.candidates[0]!
      const diff = imports.diff(preview.previewId, candidate.candidateId, skill.skillId, cwd)
      if (!args.includes('--apply')) result = { ...preview, diff, apply: `rivet skills update ${skill.skillId} --apply --version ${skill.version} --source-version ${candidate.version}${preview.locallyModified ? ' --overwrite-local' : ''}` }
      else {
        if (value('--version') !== skill.version || value('--source-version') !== candidate.version) throw new Error('Update requires the local and source versions shown by the preview')
        if (preview.locallyModified && !args.includes('--overwrite-local')) throw new Error('Local modifications detected; review diff and explicitly use --overwrite-local')
        result = imports.install(preview.previewId, { scope: skill.scope, cwd }, [{ candidateId: candidate.candidateId, name: skill.name, conflict: 'overwrite', expectedVersion: skill.version }])
      }
    }
    else throw new Error('Commands: list, inspect, add, mode, update (preview), remove, doctor, draft, drafts, approve, reject, generate, snapshot-migrate (dry-run; --apply), snapshot-export')
    return { output: args.includes('--json') ? JSON.stringify(result, null, 2) : format(result), exitCode: 0 }
  } catch (error) { return { output: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), exitCode: 1 } }
}
function format(result: unknown): string {
  if (result && typeof result === 'object' && 'skills' in result) {
    const catalog = result as ReturnType<SkillManagement['list']>
    return catalog.skills.map(s => `${s.skillId}  ${s.displayName}  ${s.scope}  ${s.mode}${s.shadowedBy ? ' (shadowed)' : ''}\n  ${s.path ?? s.source}`).concat(catalog.errors, 'diagnostics' in result ? JSON.stringify(result.diagnostics, null, 2) : []).join('\n')
  }
  return JSON.stringify(result, null, 2)
}
