import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { parseSkillMarkdown, type SkillDefinition } from './skill-loader.js'
import { parseSkillYaml, skillMetadata } from './skill-metadata.js'
import { checkRuntimeDeclarationPaths, parseRuntimeDeclaration } from './runtime/declaration.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { isRebuildableSkillResource } from './skill-resource-policy.js'

export interface PackageFile { path: string; data: string; executable: boolean }
export interface SkillPackage { definition: SkillDefinition; files: PackageFile[]; fingerprint: string; subpath: string }
/** 单个技能包总字节上限。32MB 对捆绑大参考资源（数据文件、模型、离线文档）的技能过严，放宽到 100MB。 */
const MAX_BYTES = 100 * 1024 * 1024
/**
 * 技能包敏感资源判定（按路径段、词元级匹配）——issue #458：旧判据是裸子串正则
 * `/(^|\/)\.env(?:\.|$)|credentials|private.*key|token|secret/i`，`token`/`secret`/
 * `credentials` 任意位置命中，设计领域通用术语（design-tokens.md、Cat-Secret-Life.pptx、
 * validate-tokens.cjs 等）被误判为凭据，技能在桌面端被拒装。
 *
 * 收窄后的判据：凭据材料按「精确文件名 / 扩展名 / 私钥命名」判定，不再做子串匹配。
 * 失效方向：漏判只是让一个文件名可疑的文件随包发布（技能包只在用户本地/显式导入时
 * 落盘，不自动外发），误判则直接导致技能不可用——故宁漏勿误。
 */
function isSensitiveSkillResource(name: string): boolean {
  for (const seg of name.split('/')) {
    if (!seg) continue
    // .env 家族：.env / .env.production / .env.local ……
    if (/^\.env(?:\.|$)/i.test(seg)) return true
    // 审查 M2：非点前缀的 .env 扩展名（prod.env / config.env）——上面只认点前缀。
    if (/\.env$/i.test(seg)) return true
    // 审查 M2：dotfile 凭据库——.npmrc(_auth token) / .netrc / .pgpass / .git-credentials。
    if (/^\.(?:npmrc|netrc|pgpass|git-credentials)$/i.test(seg)) return true
    // credentials：无扩展名精确形态（~/.cargo/credentials 类）或凭据数据容器
    // 扩展名（credentials.json）；credentials.test.ts 是源码，不中。
    if (/^credentials$/i.test(seg) || /^credentials\.(?:json|ya?ml|xml|ini|conf)$/i.test(seg)) return true
    // 私钥材料：SSH 命名（id_rsa 含 id_rsa.pub）、*_rsa 结尾、TLS/密钥扩展名
    if (/^id_(?:rsa|ed25519|ecdsa|dsa)/i.test(seg)) return true
    if (/[^a-z0-9]rsa$/i.test(seg)) return true
    if (/\.(?:pem|key|p12|pfx|jks)$/i.test(seg)) return true
    // 无扩展名的 private_key / private-key 词元组合（private-keyboard.ts 的 key 非完整词元，不中）
    const tokens = seg.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    if (!seg.includes('.') && tokens.includes('private') && tokens.includes('key')) return true
    // token/secret 仅精确文件名形态（token.json / secrets.yaml / secrets），
    // design-tokens.md / design-tokens-starter.json 这类设计术语不中。
    if (/^(?:tokens?|secrets?)(?:\.(?:json|ya?ml|ini|conf|env|txt|xml|properties|toml|csv))?$/i.test(seg)) return true
  }
  return false
}
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
    if (isSensitiveSkillResource(name)) throw new Error('Sensitive files cannot be included in skill packages')
    const st = lstatSync(file)
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new Error(`Unsupported resource: ${name}`)
    inside(realpathSync(root), realpathSync(file))
    if (st.isDirectory()) {
      for (const entry of readdirSync(file).sort()) {
        if (entry === '.git' || isFilesystemMetadata(entry) || isRebuildableSkillResource(entry)) continue
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
  // runtime.yaml（issue #523）已在 files 里——fingerprint 天然覆盖声明变更；
  // 这里把声明解析进 metadata。包读取路径无符号链接（上方已拒），但仍走
  // realpath 校验防 in-place 目录逃逸；失败不阻断读包，记入 metadata。
  const runtimeSource = text('runtime.yaml')
  if (runtimeSource !== undefined) {
    const parsed = parseRuntimeDeclaration(runtimeSource)
    const checked = parsed.ok ? checkRuntimeDeclarationPaths(root, parsed.declaration) : parsed
    definition.metadata = { ...definition.metadata!, runtime: checked.ok ? { declaration: checked.declaration } : { error: checked.message } }
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
