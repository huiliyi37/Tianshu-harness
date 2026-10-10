import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, win32 } from 'node:path'

const WINDOWS_MOVE = Buffer.from(
  "$ErrorActionPreference='Stop';[IO.Directory]::Move($env:TIANSHU_LOCK_STAGED_DIR,$env:TIANSHU_LOCK_TARGET_DIR)",
  'utf16le',
).toString('base64')

// Includes system PowerShell startup, while remaining below the 5s acquire window.
const WINDOWS_PUBLICATION_TIMEOUT_MS = 3_000

function publicationIsComplete(source: string, target: string, owner: Buffer): boolean {
  try {
    return lstatSync(source, { throwIfNoEntry: false }) === undefined
      && lstatSync(target).isDirectory()
      && lstatSync(join(target, 'owner.json')).isFile()
      && readFileSync(join(target, 'owner.json')).equals(owner)
  } catch { return false }
}

/** Publish a complete lock directory without replacing another owner's lock. */
export function publishLockDirectoryExclusive(source: string, target: string): void {
  if (process.platform !== 'win32') {
    renameSync(source, target)
    return
  }
  // Node's Windows rename can replace a legacy regular file with a directory.
  // Directory.Move refuses every existing destination in the atomic move itself.
  let owner: Buffer | undefined
  try {
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      throw Object.assign(new Error('Lock already exists'), { code: 'EEXIST' })
    }
    const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    if (!win32.isAbsolute(windows)) throw new Error('Windows system directory must be absolute')
    const powershell = win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    owner = readFileSync(join(source, 'owner.json'))
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_MOVE], {
      windowsHide: true,
      timeout: WINDOWS_PUBLICATION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TIANSHU_LOCK_STAGED_DIR: source, TIANSHU_LOCK_TARGET_DIR: target },
    })
    if (!publicationIsComplete(source, target, owner)) {
      throw new Error('Directory lock publication did not preserve its complete owner')
    }
  } catch (error) {
    // The atomic move can finish before the child reaches its exit deadline.
    if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && owner
      && publicationIsComplete(source, target, owner)) return
    if (existsSync(target)) Object.assign(error as object, { code: 'EEXIST' })
    throw error
  }
}
