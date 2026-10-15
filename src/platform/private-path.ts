import { lstatSync, mkdirSync, openSync, fchmodSync, fstatSync, closeSync, constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Replace the DACL: /grant:r alone retains unrelated explicit ACEs.
export const PRIVATE_PATH_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:RIVET_PRIVATE_PATH
$item = Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not private storage' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
$acl.SetAccessRuleProtection($true, $false)
$inherit = if ($item.PSIsContainer) { 'ContainerInherit, ObjectInherit' } else { 'None' }
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $id = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$current = $item.GetAccessControl()
if (@($user.Value, 'S-1-5-18', 'S-1-5-32-544') -notcontains $current.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted storage owner is unsafe' }
# #450: compare the explicit ACE fingerprints (sorted set) plus the protection
# flag instead of the raw SDDL string. An already-hardened directory reads back
# as D:PAI(A;OICI;FA;;;...) — the AI control flag ("auto inherited" bookkeeping)
# differs from the fresh D:P target forever, so the string compare rewrote the
# DACL on every boot (24s+ propagation over a 48k-file tree, then the
# execFileSync timeout killed the sidecar pre-listen). The fingerprint compare
# converges: same ACE set + protected => no write, no subtree propagation.
$sidType = [Security.Principal.SecurityIdentifier]
function Get-RuleFingerprint($rules) {
  @($rules | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value, $_.AccessControlType, $_.FileSystemRights, $_.InheritanceFlags, $_.PropagationFlags } | Sort-Object)
}
$currentRules = @(Get-RuleFingerprint $current.GetAccessRules($true, $false, $sidType))
$targetRules = @(Get-RuleFingerprint $acl.GetAccessRules($true, $false, $sidType))
$diff = @(Compare-Object -ReferenceObject $currentRules -DifferenceObject $targetRules)
if (-not $current.AreAccessRulesProtected -or $diff.Count -gt 0) {
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($item.FullName, $acl) }
  else { [IO.File]::SetAccessControl($item.FullName, $acl) }
}
`

// #450: the one-shot SetAccessControl propagation over an unhardened 48k-file
// tree measured 24s+ in the wild. 10s killed the sidecar pre-listen; 30s
// absorbs the one-time cost while repeat boots skip the write entirely (see
// the fingerprint compare above) and the serve startup call site degrades to
// warn instead of failing hard.
export const PRIVATE_PATH_ACL_TIMEOUT_MS = 30_000

/** Symlinked "private storage" is a configuration attack, not a degraded state — always fatal. */
export class PrivatePathSymlinkError extends Error {
  constructor(path: string) {
    super(`Private storage cannot be a symbolic link: ${path}`)
    this.name = 'PrivatePathSymlinkError'
  }
}

export function protectPrivatePath(path: string, platform: NodeJS.Platform = process.platform): void {
  if (lstatSync(path).isSymbolicLink()) throw new PrivatePathSymlinkError(path)
  if (platform !== 'win32') {
    // Open with O_NOFOLLOW so the chmod below acts on the exact inode inspected
    // above: a symlink swapped in between the lstat check and the chmod can no
    // longer redirect the permission change onto an arbitrary target (classic
    // check-then-use race). The fd pins the inode for the fstat calls as well.
    const fd = openSync(path, constants.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      fchmodSync(fd, st.isDirectory() ? 0o700 : 0o600)
      if ((fstatSync(fd).mode & 0o077) !== 0) {
        throw new Error('Private storage permissions could not be enforced')
      }
    } finally {
      closeSync(fd)
    }
    return
  }
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', PRIVATE_PATH_ACL_SCRIPT], {
    env: { ...process.env, RIVET_PRIVATE_PATH: path }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: PRIVATE_PATH_ACL_TIMEOUT_MS,
  })
}

export function ensurePrivateDirectory(path: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  protectPrivatePath(path, platform)
}

/**
 * Serve-startup variant of {@link ensurePrivateDirectory} (#450).
 *
 * Security stance:
 * - POSIX stays fail-closed — the hardening there is an O(1) chmod whose
 *   failure means a genuinely broken filesystem/config, not scale.
 * - Symlink rejection stays fatal on every platform (configuration attack).
 * - win32 only: a PowerShell DACL failure/timeout degrades to warn and serve
 *   continues to listen. The directory itself is still created (mkdirSync
 *   runs first); only the extra hardening pass failed. Credential-bearing
 *   surfaces (server-info discovery, protectPrivatePath callers) keep using
 *   the fail-closed {@link ensurePrivateDirectory}.
 */
export function ensurePrivateDirectoryForStartup(
  path: string,
  platform: NodeJS.Platform = process.platform,
  warn: (message: string) => void = () => {},
): void {
  // mkdir stays fatal on every platform — if the directory itself cannot be
  // created, serve has nothing to run on. Only the hardening pass degrades.
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    protectPrivatePath(path, platform)
  } catch (err) {
    if (platform !== 'win32' || err instanceof PrivatePathSymlinkError) throw err
    warn(`private storage hardening failed on ${path}; continuing without ACL hardening: ${err instanceof Error ? err.message : String(err)}`)
  }
}
