import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { translateWindowsShellPath } from '../path-format.js'

const protectedRoots = [
  '/System',
  '/etc',
  '/tmp',
  '/var',
  '/usr',
  '/bin',
  '/sbin',
  '/dev',
  '/proc',
  '/sys',
  '/boot',
  '/cores',
  '/private',
  '/Library',
  '/Applications',
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
  'C:/ProgramData',
  'C:/System Volume Information',
  'C:/$Recycle.Bin',
  'C:/Recovery',
]
function protectedDirectory(path: string): boolean {
  const value = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return (
    !value ||
    /^[a-z]:$/i.test(value) ||
    protectedRoots.some(
      (root) =>
        value === root.toLowerCase() ||
        value.startsWith(root.toLowerCase() + '/'),
    )
  )
}
export function validateWorkspaceRoots(input: unknown, cwd?: string): string[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > 32 ||
    input.some((p) => typeof p !== 'string' || !p.trim())
  )
    throw new Error('Select between 1 and 32 folders')
  const roots: string[] = [],
    seen = new Set<string>()
  for (const value of input as string[]) {
    try {
      const path = translateWindowsShellPath(value.trim())
      if (!isAbsolute(path)) throw new Error('Folder path must be absolute')
      if (protectedDirectory(path))
        throw new Error('System-protected folder cannot be a project folder')
      const real = realpathSync(path)
      if (protectedDirectory(real))
        throw new Error('System-protected folder cannot be a project folder')
      if (!statSync(real).isDirectory()) throw new Error('Not a folder')
      accessSync(real, constants.R_OK | constants.X_OK)
      const key = process.platform === 'win32' ? real.toLowerCase() : real
      if (!seen.has(key)) {
        seen.add(key)
        roots.push(real)
      }
    } catch (error) {
      throw new Error(`${value}: ${(error as Error).message}`)
    }
  }
  if (cwd && realpathSync(resolve(translateWindowsShellPath(cwd))) !== roots[0])
    throw new Error('cwd must match the first project folder')
  return roots
}
