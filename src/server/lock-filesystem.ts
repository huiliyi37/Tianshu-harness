import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, win32 } from 'node:path'

const WINDOWS_MOVE = Buffer.from(
  "$ErrorActionPreference='Stop';[IO.Directory]::Move($env:TIANSHU_LOCK_STAGED_DIR,$env:TIANSHU_LOCK_TARGET_DIR)",
  'utf16le',
).toString('base64')

/** Publish a complete lock directory without replacing another owner's lock. */
export function publishLockDirectoryExclusive(source: string, target: string): void {
  if (process.platform !== 'win32') {
    renameSync(source, target)
    return
  }
  // Node's Windows rename can replace a legacy regular file with a directory.
  // Directory.Move refuses every existing destination in the atomic move itself.
  try {
    const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    if (!win32.isAbsolute(windows)) throw new Error('Windows system directory must be absolute')
    const powershell = win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const owner = readFileSync(join(source, 'owner.json'))
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_MOVE], {
      windowsHide: true,
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TIANSHU_LOCK_STAGED_DIR: source, TIANSHU_LOCK_TARGET_DIR: target },
    })
    if (lstatSync(source, { throwIfNoEntry: false }) !== undefined
      || !lstatSync(target).isDirectory()
      || !lstatSync(join(target, 'owner.json')).isFile()
      || !readFileSync(join(target, 'owner.json')).equals(owner)) {
      throw new Error('Directory lock publication did not preserve its complete owner')
    }
  } catch (error) {
    if (existsSync(target)) Object.assign(error as object, { code: 'EEXIST' })
    throw error
  }
}
