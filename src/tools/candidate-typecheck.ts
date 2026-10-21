import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadTypeScript } from '../utils/typescript-runtime.js'

/** Only a local full-project tsc run can certify type-only impact pruning. */
export function candidateTypecheckCommand(snapshotRoot: string, candidateFiles: readonly string[]): { command: string; args: string[] } | null {
  if (!candidateFiles.length) return null
  const configPath = join(snapshotRoot, 'tsconfig.json')
  const tscPath = join(snapshotRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(configPath) || !existsSync(tscPath)) return null
  // The compiler is needed only for candidate typecheck planning. Loading it at
  // module import time puts TypeScript on the sidecar startup path.
  const ts = loadTypeScript()
  if (!ts) return null
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error || config.config?.extends || config.config?.references) return null
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, snapshotRoot, { noEmit: true }, configPath)
  if (parsed.errors.length > 0 || !parsed.fileNames.length) return null
  const checked = new Set(parsed.fileNames.map(file => {
    try { return realpathSync(file) } catch { return resolve(file) }
  }))
  let root: string
  try { root = realpathSync(snapshotRoot) } catch { return null }
  for (const file of candidateFiles) {
    if (!/\.[cm]?tsx?$/.test(file)) return null
    const target = resolve(root, file)
    const rel = relative(root, target)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !checked.has(target)) return null
  }
  return { command: process.execPath, args: [tscPath, '--noEmit', '--project', configPath] }
}
