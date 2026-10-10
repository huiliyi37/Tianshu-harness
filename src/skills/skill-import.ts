import JSZip from 'jszip'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cloneGitSource } from '../plugins/git-source.js'
import { execFileGit } from '../tools/spawn-git.js'
import { inside, readPackage, scanPackages, skillPackagePath, validateResourcePath, type SkillPackage } from './skill-package.js'
import { SkillManagement, type SkillContext, type SkillOrigin } from './skill-management.js'

export type ImportSource = { kind: 'local'; path: string } | { kind: 'git'; url: string; ref?: string; subpath?: string }
  | { kind: 'zip'; path?: string; base64?: string } | { kind: 'text'; text: string }
export interface ImportCandidate { candidateId: string; name: string; description: string; files: string[]; metadata: SkillPackage['definition']['metadata']; version: string; subpath: string }
interface Preview { packages: SkillPackage[]; origin: Omit<SkillOrigin, 'fingerprint'>; expires: number }
export class SkillImports {
  private previews = new Map<string, Preview>()
  constructor(readonly management = new SkillManagement()) {}
  cancel(previewId: string) { this.previews.delete(previewId) }
  async preview(source: ImportSource) {
    for (const [id, p] of this.previews) if (p.expires < Date.now()) this.previews.delete(id)
    if (this.previews.size >= 16) throw new Error('Too many pending imports; cancel a preview first')
    let path = '', cleanup = () => {}, origin: Omit<SkillOrigin, 'fingerprint'> = { kind: source.kind }
    try {
      if (source.kind === 'local') { path = source.path; origin.location = path }
      else if (source.kind === 'git') {
        const sha = source.ref && /^[a-f0-9]{7,40}$/i.test(source.ref) ? source.ref : undefined
        const clone = await cloneGitSource(source.url, sha ? undefined : source.ref)
        cleanup = clone.cleanup
        if (sha) {
          await git(['fetch', '--depth', '1', 'origin', sha], clone.sourcePath)
          await git(['checkout', '--detach', 'FETCH_HEAD'], clone.sourcePath)
        }
        origin = { kind: 'git', location: source.url, ref: source.ref, commit: (await git(['rev-parse', 'HEAD'], clone.sourcePath)).trim() }
        path = inside(clone.sourcePath, source.subpath ?? '')
        origin.subpath = source.subpath ?? ''
      } else {
        path = mkdtempSync(join(tmpdir(), 'rivet-skill-import-')); cleanup = () => rmSync(path, { recursive: true, force: true })
        if (source.kind === 'text') writeFileSync(join(path, 'SKILL.md'), source.text)
        else {
          const buffer = source.path ? readFileSync(source.path) : Buffer.from(source.base64 ?? '', 'base64')
          if (buffer.length > 32 * 1024 * 1024) throw new Error('ZIP exceeds size limit')
          const zip = await JSZip.loadAsync(buffer)
          const entries = Object.values(zip.files)
          if (entries.length > 2048) throw new Error('ZIP has too many entries')
          let bytes = 0
          for (const entry of entries) {
            const unsafeName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name
            if (unsafeName !== entry.name || unsafeName.includes('\\') || /(^|\/)\.\.?(\/|$)/.test(unsafeName) || unsafeName.startsWith('/') || /^[a-z]:/i.test(unsafeName)) throw new Error('Unsafe ZIP path')
            if ((Number(entry.unixPermissions) & 0o170000) === 0o120000) throw new Error('ZIP symbolic links are unsupported')
            validateResourcePath(entry.name.replace(/\/$/, ''))
            const declared = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
            if (declared !== undefined && declared > 32 * 1024 * 1024 - bytes) throw new Error('ZIP resources exceed limit')
            const dest = inside(path, entry.name)
            if (entry.dir) mkdirSync(dest, { recursive: true })
            else {
              const data = await entry.async('nodebuffer'); bytes += data.length
              if (bytes > 32 * 1024 * 1024) throw new Error('ZIP resources exceed limit')
              mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, data, { mode: (Number(entry.unixPermissions) & 0o111) ? 0o755 : 0o644 })
            }
          }
          origin.location = source.path
        }
      }
      const scanned = scanPackages(path)
      const bytes = scanned.packages.reduce((total, pkg) => total + pkg.files.reduce((sum, file) => sum + file.data.length, 0), 0)
      if (bytes > 64 * 1024 * 1024 || scanned.packages.length > 256) throw new Error('Import preview exceeds limits; select a smaller subdirectory')
      const previewId = randomUUID()
      this.previews.set(previewId, { packages: scanned.packages, origin, expires: Date.now() + 15 * 60000 })
      return { previewId, origin, errors: scanned.errors, candidates: scanned.packages.map((pkg, index): ImportCandidate => ({
        candidateId: String(index), name: pkg.definition.name, description: pkg.definition.description,
        files: pkg.files.map(f => f.path), metadata: pkg.definition.metadata, version: pkg.fingerprint, subpath: pkg.subpath,
      })) }
    } finally { cleanup() }
  }
  install(previewId: string, context: SkillContext, selections: Array<{ candidateId: string; name?: string; conflict?: 'skip' | 'overwrite'; expectedVersion?: string }>) {
    const preview = this.previews.get(previewId)
    if (!preview || preview.expires < Date.now()) throw new Error('Preview expired; scan the source again')
    if (!selections.length) throw new Error('Select at least one skill')
    const results = selections.map(selection => {
      const pkg = preview.packages[Number(selection.candidateId)]
      if (!pkg || String(Number(selection.candidateId)) !== selection.candidateId) throw new Error('Invalid candidate')
      return this.management.install(pkg, context, { ...selection, origin: { ...preview.origin,
        subpath: [preview.origin.subpath, pkg.subpath].filter(Boolean).join('/'), fingerprint: pkg.fingerprint } })
    })
    this.cancel(previewId)
    return { results }
  }
  diff(previewId: string, candidateId: string, skillId: string, cwd?: string) {
    const preview = this.previews.get(previewId)
    if (!preview || preview.expires < Date.now()) throw new Error('Preview expired')
    const pkg = preview.packages[Number(candidateId)]
    if (!pkg) throw new Error('Candidate not found')
    const current = this.management.inspect(skillId, cwd)
    if (!current.path) throw new Error('This source cannot be overwritten')
    const previous = readPackage(skillPackagePath(current.path))
    const old = new Map(previous.files.map(f => [f.path, f])), next = new Map(pkg.files.map(f => [f.path, f]))
    const changes = [...new Set([...old.keys(), ...next.keys()])].sort().flatMap(path => {
      const before = old.get(path), after = next.get(path)
      if (before?.data === after?.data && before?.executable === after?.executable) return []
      const text = (data?: string) => { const buffer = Buffer.from(data ?? '', 'base64'); return buffer.includes(0) || buffer.length > 64000 ? undefined : buffer.toString('utf8') }
      return [{ path, status: !before ? 'added' : !after ? 'removed' : 'modified', before: text(before?.data), after: text(after?.data),
        binary: (before && text(before.data) === undefined) || (after && text(after.data) === undefined) }]
    })
    return { skillId, expectedVersion: current.version, changes }
  }
  async update(skillId: string, cwd?: string) {
    const skill = this.management.inspect(skillId, cwd), origin = skill.origin
    if (!origin || origin.kind !== 'git' || !origin.location) throw new Error('This source does not support repository updates')
    const preview = await this.preview({ kind: 'git', url: origin.location, ref: origin.ref, subpath: origin.subpath })
    return { ...preview, currentName: skill.name, expectedVersion: skill.version, locallyModified: skill.version !== origin.fingerprint,
      currentContent: this.management.content(skillId, cwd), currentVersion: origin.commit }
  }
  copy(skillId: string, context: SkillContext, cwd?: string) {
    const skill = this.management.inspect(skillId, cwd)
    if (!skill.path) throw new Error('This skill has no installable package')
    return this.management.install(readPackage(skill.files.includes('SKILL.md') ? skillPackagePath(skill.path) : skill.path), context)
  }
}
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFileGit(args, { cwd, timeout: 120000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}
