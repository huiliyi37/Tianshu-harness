import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { rivetHome } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { isSafeFileName } from '../utils/safe-path.js'
import { SkillRegistry, registerBuiltinSkills, parseSkillMarkdown, BUILTIN_SKILLS, type SkillSource, type SkillDefinition } from './skill-loader.js'
import { type SkillMode } from './skill-metadata.js'
import { readPackage, scanPackages, validateResourcePath, type SkillPackage } from './skill-package.js'
import { parseSkillYaml } from './skill-metadata.js'
import { stringify } from 'yaml'
import { parseManifest } from '../plugins/manifest.js'
import { loadConfig } from '../config/manager.js'

export type ManagedScope = 'project' | 'personal'
export interface SkillContext { scope: ManagedScope; cwd?: string }
export interface SkillOrigin { kind: 'local' | 'git' | 'zip' | 'text'; location?: string; ref?: string; commit?: string; subpath?: string; fingerprint: string }
export interface ManagedSkill {
  skillId: string; name: string; description: string; displayName: string; source: SkillSource;
  scope: ManagedScope; path?: string; editable: boolean; mode: SkillMode; version: string;
  shadowedBy?: string; origin?: SkillOrigin; metadata?: SkillPackage['definition']['metadata']; files: string[];
}
interface RecordEntry { mode?: SkillMode; origin?: SkillOrigin }
export class SkillManagement {
  constructor(readonly home = rivetHome(), readonly externalHome = homedir()) {}
  root(context: SkillContext): string {
    if (context.scope === 'personal') return join(this.home, 'skills')
    if (!context.cwd || !isAbsolute(context.cwd)) throw new Error('Project scope requires an absolute directory')
    return join(context.cwd, '.rivet', 'skills')
  }
  private records(context: SkillContext): Record<string, RecordEntry> {
    const path = join(this.root(context), '_management.json')
    if (!existsSync(path)) return {}
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skill management records')
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || 'mode' in entry && !['auto', 'manual', 'off'].includes(String(entry.mode))) throw new Error('Invalid saved skill mode')
    }
    return value
  }
  private save(context: SkillContext, value: Record<string, RecordEntry>) {
    writeFileAtomicSync(join(this.root(context), '_management.json'), JSON.stringify(value, null, 2))
  }
  list(cwd?: string): { skills: ManagedSkill[]; errors: string[] } {
    const skills: ManagedSkill[] = [], errors: string[] = []
    const append = (definitions: SkillDefinition[], scope: ManagedScope, context: SkillContext) => {
      const records = this.records(context)
      for (const def of definitions) {
        const skillId = createHash('sha256').update(`${scope}:${def.bodyPath ?? `${def.source}:${def.name}`}`).digest('hex').slice(0, 24)
        let pkg: SkillPackage | undefined
        try { if (def.bodyPath) pkg = readPackage(def.skillDir ?? def.bodyPath) }
        catch (e) { errors.push(`${def.name}: ${String(e)}`); continue }
        const metadata = pkg?.definition.metadata ?? def.metadata
        const record = records[skillId]
        skills.push({ skillId, name: def.name, description: metadata?.shortDescription ?? def.description,
          displayName: metadata?.displayName ?? def.name, source: def.source ?? 'builtin', scope, path: def.bodyPath,
          editable: def.source === 'rivet' || def.source === 'global-rivet', mode: record?.mode ?? metadata?.defaultMode ?? 'auto',
          version: pkg?.fingerprint ?? createHash('sha256').update(def.body).digest('hex'), origin: record?.origin,
          metadata, files: pkg?.files.map(f => f.path) ?? [] })
      }
    }
    const builtins = new SkillRegistry(); registerBuiltinSkills(builtins)
    const pluginRoot = join(this.home, 'plugins')
    if (existsSync(pluginRoot)) {
      const enabled = loadConfig({ cwd }).plugins.enabled
      for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          const root = join(pluginRoot, entry.name)
          const manifest = parseManifest(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).tianshu)
          if (!manifest.ok || enabled[manifest.manifest.name] === false) continue
          for (const path of manifest.manifest.skills ?? []) {
            const directory = insidePackage(root, path), pkg = readPackage(directory)
            if (!builtins.get(pkg.definition.name)) builtins.register({ ...pkg.definition, source: 'plugin', bodyPath: join(directory, 'SKILL.md'), skillDir: directory })
          }
        } catch (error) { errors.push(`Plugin ${entry.name}: ${String(error)}`) }
      }
    }
    append(builtins.list(), 'personal', { scope: 'personal' })
    const dirs: Array<[string, SkillSource, ManagedScope]> = [
      [join(this.externalHome, '.agents', 'skills'), 'global-agents', 'personal'],
      [this.root({ scope: 'personal' }), 'global-rivet', 'personal'],
    ]
    if (cwd) dirs.push([join(cwd, '.agents', 'skills'), 'project-agents', 'project'], [this.root({ scope: 'project', cwd }), 'rivet', 'project'])
    for (const [dir, source, scope] of dirs) {
      if (!existsSync(dir)) continue
      const definitions: SkillDefinition[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('_') || isFilesystemMetadata(entry.name)) continue
        const path = join(dir, entry.name), directory = entry.isDirectory()
        if (!(entry.isFile() && entry.name.endsWith('.md')) && !(directory && existsSync(join(path, 'SKILL.md')))) continue
        try {
          const pkg = readPackage(path)
          definitions.push({ ...pkg.definition, source, bodyPath: directory ? join(path, 'SKILL.md') : path, skillDir: directory ? path : undefined })
        } catch (error) { errors.push(`${path}: ${String(error)}`) }
      }
      append(definitions, scope, { scope, cwd })
    }
    const winners = new Map<string, ManagedSkill>()
    for (const skill of skills) { const previous = winners.get(skill.name); if (previous) previous.shadowedBy = skill.skillId; winners.set(skill.name, skill) }
    return { skills, errors }
  }
  inspect(skillId: string, cwd?: string): ManagedSkill {
    const skill = this.list(cwd).skills.find(s => s.skillId === skillId)
    if (!skill) throw new Error('Skill not found; refresh the catalog')
    return skill
  }
  setMode(skillId: string, mode: SkillMode, cwd?: string) {
    if (!['auto', 'manual', 'off'].includes(mode)) throw new Error('Invalid mode')
    const skill = this.inspect(skillId, cwd), context = { scope: skill.scope, cwd }
    const records = this.records(context); records[skillId] = { ...records[skillId], mode }; this.save(context, records)
    return { ...skill, mode, effective: 'new-session' as const }
  }
  content(skillId: string, cwd?: string) {
    const skill = this.inspect(skillId, cwd)
    return skill.path ? readFileSync(skill.path, 'utf8') : BUILTIN_SKILLS.find(s => s.name === skill.name)?.body
  }
  edit(skillId: string, content: string, expectedVersion: string, cwd?: string) {
    const skill = this.inspect(skillId, cwd)
    if (!skill.editable || !skill.path) throw new Error('Source is read-only; copy it into a managed scope first')
    if (skill.version !== expectedVersion) throw new Error('Skill changed since preview; refresh before saving')
    const def = parseSkillMarkdown(content, skill.name)
    if (def.name !== skill.name) throw new Error('Rename through import; editing cannot change skill identity')
    writeFileAtomicSync(skill.path, content)
    return this.inspect(skillId, cwd)
  }
  remove(skillId: string, expectedVersion: string, cwd?: string) {
    const skill = this.inspect(skillId, cwd)
    if (!skill.editable || !skill.path) throw new Error('Source is read-only')
    if (skill.version !== expectedVersion) throw new Error('Skill changed since preview')
    // The catalog resolves identity; request paths never decide what is removed.
    rmSync(basename(skill.path) === 'SKILL.md' ? dirname(skill.path) : skill.path, { recursive: true })
    const context = { scope: skill.scope, cwd }, records = this.records(context); delete records[skillId]; this.save(context, records)
  }
  install(pkg: SkillPackage, context: SkillContext, options: { name?: string; conflict?: 'skip' | 'overwrite'; expectedVersion?: string; origin?: SkillOrigin } = {}) {
    const name = options.name ?? pkg.definition.name
    if (!isSafeFileName(name) || name.startsWith('_')) throw new Error('Invalid skill name')
    validateResourcePath(name)
    const root = this.root(context), destination = join(root, name), flat = join(root, name + '.md')
    if (existsSync(destination) && existsSync(flat)) throw new Error('Ambiguous installed packages; remove or rename the duplicate before importing')
    const existing = existsSync(destination) ? destination : existsSync(flat) ? flat : undefined
    if (existing && options.conflict !== 'overwrite') return { name, skipped: true }
    if (existing && (!options.expectedVersion || readPackage(existing).fingerprint !== options.expectedVersion)) throw new Error('Overwrite requires the version shown in the preview')
    const prior = existing ? this.list(context.cwd).skills.find(s => s.path === (existing === flat ? flat : join(existing, 'SKILL.md'))) : undefined
    mkdirSync(root, { recursive: true })
    const staging = join(root, '_' + randomUUID()), backup = join(root, '_' + randomUUID())
    try {
      for (const file of pkg.files) {
        validateResourcePath(file.path)
        const target = insidePackage(staging, file.path); mkdirSync(dirname(target), { recursive: true })
        let data = Buffer.from(file.data, 'base64')
        if (file.path === 'SKILL.md' && name !== pkg.definition.name) {
          const match = data.toString('utf8').replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
          if (!match) throw new Error('Missing skill metadata')
          data = Buffer.from(`---\n${stringify({ ...parseSkillYaml(match[1]!), name })}---\n${match[2]}`)
        }
        writeFileSync(target, data, { mode: file.executable ? 0o755 : 0o644 })
      }
      readPackage(staging)
      if (existing) renameSync(existing, backup)
      try { renameSync(staging, destination) } catch (e) { if (existing) renameSync(backup, existing); throw e }
      const installed = this.list(context.cwd).skills.find(s => s.path === join(destination, 'SKILL.md'))!
      const records = this.records(context)
      records[installed.skillId] = { ...(prior ? records[prior.skillId] : undefined), ...records[installed.skillId], origin: { ...(options.origin ?? { kind: 'local' as const }), fingerprint: installed.version } }
      if (prior && prior.skillId !== installed.skillId) delete records[prior.skillId]
      this.save(context, records)
      return { name, skipped: false, skillId: installed.skillId, effective: 'new-session' }
    } finally { rmSync(staging, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }) }
  }
  scan(path: string) { return scanPackages(resolve(path)) }
}
import { inside as insidePackage } from './skill-package.js'
