import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type ts from 'typescript'
import { spawnGitSync } from '../tools/spawn-git.js'
import { loadTypeScript } from '../utils/typescript-runtime.js'

export interface TypecheckProof {
  /** Identity of the candidate tree being delivered. */
  candidateRef: string
  /** Identity of the tree on which the complete typecheck passed. */
  verifiedRef: string
  passed: boolean
  complete: boolean
  /** Files overlaid on HEAD to form the verified candidate tree. */
  candidateFiles: readonly string[]
}

export function hasMatchingTypecheckProof(proof?: TypecheckProof): boolean {
  return !!proof?.candidateRef && proof.candidateRef === proof.verifiedRef && proof.passed === true && proof.complete === true
    && Array.isArray(proof.candidateFiles) && proof.candidateFiles.length > 0
}

/** Reconstruct the checked file set only from a stable, single-project config. */
export function candidateTypecheckCoverage(cwd: string, proof?: TypecheckProof): ReadonlySet<string> | null {
  if (!hasMatchingTypecheckProof(proof)) return null
  const tracked = spawnGitSync(['ls-files', '--error-unmatch', '--', 'tsconfig.json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  if (tracked.status !== 0) return null
  const clean = spawnGitSync(['diff', '--quiet', 'HEAD', '--', 'tsconfig.json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  if (clean.status !== 0) return null
  const ts = loadTypeScript()
  if (!ts) return null
  const configPath = join(cwd, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error || config.config?.extends || config.config?.references) return null
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd, { noEmit: true }, configPath)
  if (parsed.errors.length || !parsed.fileNames.length) return null
  return new Set(parsed.fileNames.map(file => {
    try { return realpathSync(file) } catch { return resolve(file) }
  }))
}

function importerMatchesCandidate(cwd: string, importer: string, proof: TypecheckProof): boolean {
  const importerPath = resolve(cwd, importer)
  const relativeImporter = relative(cwd, importerPath).replaceAll('\\', '/')
  if (!relativeImporter || isAbsolute(relativeImporter) || relativeImporter === '..' || relativeImporter.startsWith('../')) return false
  if (proof.candidateFiles.some(file => resolve(cwd, file) === importerPath)) return true
  // The candidate omits this importer, so the classifier may inspect its live
  // bytes only when they are exactly HEAD. Otherwise a peer edit could turn a
  // runtime import into an import type and falsely demote a required test.
  const tracked = spawnGitSync(['ls-files', '--error-unmatch', '--', relativeImporter], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  if (tracked.status !== 0) return false
  const clean = spawnGitSync(['diff', '--quiet', 'HEAD', '--', relativeImporter], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  return clean.status === 0
}

/**
 * True only when every syntactic reference from importer to imported is an
 * explicitly erased TypeScript import/export. Missing, unreadable, or
 * unresolvable declarations fail closed as runtime/unknown dependencies.
 */
export function isPureTypeOnlyImportEdge(cwd: string, importer: string, imported: string, proof?: TypecheckProof, checkedFiles?: ReadonlySet<string>): boolean {
  if (!/\.[cm]?tsx?$/.test(importer) || !/\.[cm]?tsx?$/.test(imported)) return false
  if (proof && (!checkedFiles || !checkedFiles.has(realpathOrResolved(resolve(cwd, importer))))) return false
  if (proof && !importerMatchesCandidate(cwd, importer, proof)) return false
  const sourcePath = resolve(cwd, importer)
  const targetPath = resolve(cwd, imported)
  try {
    const root = realpathSync(cwd)
    const real = realpathSync(sourcePath)
    const inside = relative(root, real)
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return false
  } catch { return false }
  let source: string
  try { source = readFileSync(sourcePath, 'utf8') } catch { return false }
  const ts = loadTypeScript()
  if (!ts) return false
  const scriptKind = importer.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, scriptKind)
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
  if (!parseDiagnostics || parseDiagnostics.length > 0) return false

  const resolvesToTarget = (specifier: ts.Expression): boolean => {
    if (!ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return false
    const resolved = ts.resolveModuleName(specifier.text, sourcePath, {
      moduleResolution: ts.ModuleResolutionKind.Node10,
      allowJs: true,
    }, ts.sys).resolvedModule?.resolvedFileName
    return resolved !== undefined && resolve(resolved) === targetPath
  }

  let matched = false
  let runtimeOrUnknown = false
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && resolvesToTarget(node.moduleSpecifier)) {
      matched = true
      const clause = node.importClause
      if (!clause || !(clause.isTypeOnly || (
        !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every(element => element.isTypeOnly)
      ))) runtimeOrUnknown = true
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && resolvesToTarget(node.moduleSpecifier)) {
      matched = true
      const clause = node.exportClause
      if (!(node.isTypeOnly || (clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly)))) runtimeOrUnknown = true
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && resolvesToTarget(node.arguments[0])) {
      matched = true
      runtimeOrUnknown = true
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && resolvesToTarget(node.moduleReference.expression)) {
      matched = true
      runtimeOrUnknown = true
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return matched && !runtimeOrUnknown
}

function realpathOrResolved(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}
