import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { parseSkillMarkdown, type SkillDefinition } from './skill-loader.js'
import { parseSkillYaml, skillMetadata } from './skill-metadata.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

export interface PackageFile { path: string; data: string; executable: boolean }
export interface SkillPackage { definition: SkillDefinition; files: PackageFile[]; fingerprint: string; subpath: string }
const MAX_BYTES = 32 * 1024 * 1024
/** SKILL.md is the entry point of its directory package, on either platform. */
export function skillPackagePath(path: string): string {
  const paths = path.includes('\\') ? win32 : { basename, dirname }
  return paths.basename(path) === 'SKILL.md' ? paths.dirname(path) : path
}
export function inside(root: string, path: string): string {
  const target = resolve(root, path)
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) throw new Error('Path escapes skill package')
  return target
}
export function validateResourcePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe resource path')
}
export function fingerprint(files: PackageFile[]): string {
  return createHash('sha256').update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)))).digest('hex')
}
export function readPackage(path: string): SkillPackage {
  path = skillPackagePath(path)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported in skill packages')
  const root = stat.isDirectory() ? path : resolve(path, '..')
  const files: PackageFile[] = []
  let bytes = 0
  const read = (file: string, name: string, depth = 0) => {
    if (depth > 16) throw new Error('Skill resources exceed depth limit')
    if (name) validateResourcePath(name)
    if (/(^|\/)\.env(?:\.|$)|credentials|private.*key|token|secret/i.test(name)) throw new Error('Sensitive files cannot be included in skill packages')
    const st = lstatSync(file)
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error(`Unsupported resource: ${name}`)
    inside(realpathSync(root), realpathSync(file))
    if (st.isDirectory()) {
      for (const entry of readdirSync(file).sort()) {
        if (entry === '.git' || isFilesystemMetadata(entry)) continue
        read(join(file, entry), `${name ? name + '/' : ''}${entry}`, depth + 1)
      }
    } else {
      bytes += st.size
      if (bytes > MAX_BYTES || files.length >= 2048) throw new Error('Skill package exceeds resource limits')
      files.push({ path: name, data: readFileSync(file).toString('base64'), executable: (st.mode & 0o111) !== 0 })
    }
  }
  if (stat.isDirectory()) read(path, '')
  else read(path, 'SKILL.md')
  const text = (name: string) => { const file = files.find(f => f.path === name); return file ? Buffer.from(file.data, 'base64').toString('utf8') : undefined }
  const content = text('SKILL.md')
  if (!content) throw new Error('Missing SKILL.md')
  const definition = parseSkillMarkdown(content, basename(path).replace(/\.md$/, ''))
  for (const link of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const resource = link[1]!.split('#')[0]!
    if (!/^(?:\.\/)?(?:scripts|references|assets)\//.test(resource)) continue
    const resourcePath = resource.replace(/^\.\//, '')
    validateResourcePath(resourcePath.replace(/\/$/, ''))
    if (!files.some(f => f.path === resourcePath || f.path.startsWith(resourcePath.replace(/\/$/, '') + '/'))) throw new Error(`Missing linked skill resource: ${resource}`)
  }
  const metadata = text('agents/openai.yaml')
  if (metadata) {
    const external = skillMetadata({}, parseSkillYaml(metadata))
    definition.metadata = { ...external, unsupported: definition.metadata?.unsupported ?? [], defaultMode: definition.metadata?.defaultMode === 'manual' ? 'manual' : external.defaultMode }
  }
  return { definition, files, fingerprint: fingerprint(files), subpath: '' }
}
/** Scan packages only; never load hooks, execute scripts or install dependencies. */
export function scanPackages(root: string): { packages: SkillPackage[]; errors: string[] } {
  const packages: SkillPackage[] = [], errors: string[] = []
  let count = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || ++count > 10000) throw new Error('Source scan exceeds limits')
    if (lstatSync(dir).isSymbolicLink()) { errors.push(`Symbolic link skipped: ${relative(root, dir)}`); return }
    if (!lstatSync(dir).isDirectory() || requireSkill(dir)) {
      try { const pkg = readPackage(dir); pkg.subpath = relative(root, dir).replaceAll('\\', '/'); packages.push(pkg) }
      catch (e) { errors.push(`${relative(root, dir)}: ${String(e)}`) }
      return
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') && !['.claude', '.agents', '.rivet'].includes(entry.name)) continue
      if (entry.name.startsWith('_') || ['node_modules', 'vendor', 'target', 'dist'].includes(entry.name)) continue
      if (entry.isFile() && entry.name.endsWith('.md') && !readFileSync(join(dir, entry.name), 'utf8').trimStart().startsWith('---')) continue
      if (entry.isDirectory() || entry.isSymbolicLink() || entry.name.endsWith('.md')) walk(join(dir, entry.name), depth + 1)
    }
  }
  const requireSkill = (dir: string) => readdirSync(dir).includes('SKILL.md')
  if (!isAbsolute(root)) root = resolve(root)
  walk(root, 0)
  return { packages, errors }
}
