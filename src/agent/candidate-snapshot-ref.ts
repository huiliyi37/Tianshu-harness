import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnGitSync } from '../tools/spawn-git.js'
import { detectSensitiveFileOnDisk } from '../tools/sensitive-file-detector.js'

/** Identity of exactly the tree that deliver_task(files=...) would commit. */
export function candidateSnapshotRef(cwd: string, files: readonly string[]): string | null {
  if (files.length === 0) return null
  let root: string
  try { root = realpathSync(cwd) } catch { return null }
  const head = spawnGitSync(['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  if (head.status !== 0 || typeof head.stdout !== 'string') return null
  const revision = head.stdout.trim()
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) return null
  const hash = createHash('sha256').update(revision)
  for (const input of [...new Set(files)].sort()) {
    const path = resolve(root, input)
    const rel = relative(root, path).replaceAll('\\', '/')
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || detectSensitiveFileOnDisk(path).sensitive) return null
    hash.update(rel)
    try {
      const stat = lstatSync(path)
      const actual = realpathSync(path)
      const inside = relative(root, actual)
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return null
      if (!stat.isFile()) return null
      hash.update(String(stat.mode & 0o111))
      hash.update(readFileSync(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      hash.update('deleted')
    }
  }
  return `${revision.slice(0, 12)}+${hash.digest('hex').slice(0, 12)}`
}
