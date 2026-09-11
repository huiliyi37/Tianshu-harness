import { isAbsolute, relative, resolve, dirname, join, basename } from 'path'
import { realpathSync, existsSync } from 'fs'
import { isReadGranted, isWriteGranted } from './path-grants.js'
import { translateWindowsShellPath } from '../path-format.js'
import { detectSensitiveFile } from './sensitive-file-detector.js'

export interface ValidatedPath {
  ok: true
  path: string
}

export interface InvalidPath {
  ok: false
  error: string
}

export type PathValidationResult = ValidatedPath | InvalidPath

/**
 * Validate that `inputPath` is inside the workspace, OR covered by an explicit,
 * user-approved out-of-workspace grant for the requested access `mode`
 * ('read' satisfied by read|write grant; 'write' requires a write grant).
 */
export function validatePathSafe(cwd: string, inputPath: string, mode: 'read' | 'write' = 'read'): PathValidationResult {
  // Git Bash/Cygwin/WSL 盘符前缀翻译（仅 win32 生效）：用户从 Git Bash 复制的
  // /d/sky/... 若不翻译会被当 POSIX 绝对路径 resolve 成 <cwd盘>:\d\sky\...。
  inputPath = translateWindowsShellPath(inputPath)

  // Returned path stays original-cwd-based to preserve the existing contract
  // (callers compute relative labels / read via this path). Validation, however,
  // canonicalizes both sides: without resolving cwd, a cwd reached through a
  // symlink (macOS /var→/private/var temp dirs, symlinked home/mount/repo) makes
  // the realpath check compare a resolved file against an unresolved cwd and
  // reject every legitimate file as a "symlink escape".
  const resolved = resolve(cwd, inputPath)

  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    realCwd = resolve(cwd)
  }
  const realResolved = resolve(realCwd, inputPath)

  // Canonicalize the target (resolving symlinks in its existing ancestry) BEFORE
  // the containment check. An absolute inputPath reached through a symlinked root
  // (macOS /var→/private/var temp dirs, symlinked home/mount/repo) would otherwise
  // keep the unresolved prefix and compare against the realpath'd cwd, false-flagging
  // every legitimate in-project absolute path as an escape. For a not-yet-existing
  // file realpathSync throws, so we resolve the nearest existing ancestor instead —
  // this still catches a symlinked parent that escapes the project (e.g. ./evil ->
  // /etc, write evil/new).
  let real: string
  try {
    real = realpathSync(realResolved)
  } catch {
    real = resolveNearestExisting(realResolved, realCwd)
  }

  // Sensitive file check — fail-closed BEFORE path escape check, and across every
  // addressable FORM of the path: raw input, lexical resolve, realpath canonical
  // form. 此前只查裸输入串——`scripts/../.env` 因裸前缀白名单逃逸、`.env/`/`.env.`/
  // `.ENV` 靠 detector 内归一化收敛、8.3 短名（CREDEN~1.JSON）靠 realpath 展开收敛。
  // 白名单按规范形评估：裸前缀（scripts/…）不再单独放行。Hard-gate: refuse to
  // read/commit .env, credentials, private keys etc. even when the path is inside
  // the workspace or covered by a grant. 返回路径契约不变（仍返回 resolved）。
  for (const form of [inputPath, resolved, realResolved, real]) {
    const sensitiveResult = detectSensitiveFile(form)
    if (sensitiveResult.sensitive) {
      return {
        ok: false,
        error: `Sensitive file blocked: ${inputPath} matches sensitive pattern "${sensitiveResult.patternName}". Reading or committing credential/key files is not permitted. If this is a false positive (e.g. a template or fixture), rename the file or move it to a whitelisted path.`,
      }
    }
  }

  const rel = relative(realCwd, real)

  if (rel === '') {
    return { ok: true, path: resolved }
  }

  if (rel.startsWith('..') || isAbsolute(rel)) {
    // Out of workspace — allow only if the user has granted access to this
    // subtree at the requested mode (the grant store is widened solely through
    // the approval flow; nothing here grants on its own).
    // Scoped to this workspace's cwd: the sidecar hosts sessions from many
    // workspaces in one process, so only grants approved by (or persisted for)
    // THIS workspace — plus user-level config/cache grants — may widen it.
    const granted = mode === 'write' ? isWriteGranted(real, cwd) : isReadGranted(real, cwd)
    if (granted) return { ok: true, path: resolved }
    return {
      ok: false,
      error: `Path outside project directory: ${inputPath} (workspace root: ${realCwd}). `
        + `If this path is wrong, re-check the workspace root above and use a path under it. `
        + `If the user authorized working there, call request_path_access (or approve the prompt) to grant ${mode} access; `
        + `standing grants can also be configured via permissions.additionalReadDirs / additionalWriteDirs.`,
    }
  }

  return { ok: true, path: resolved }
}

/**
 * Resolve the real path of `target` when it does not yet exist, by walking up to
 * the nearest existing ancestor, canonicalizing that, then re-appending the
 * non-existent tail. Lets new-file writes be validated while still resolving any
 * symlink in the existing portion of the path.
 */
function resolveNearestExisting(target: string, floor: string): string {
  const segments: string[] = []
  let current = target
  while (!existsSync(current)) {
    // Stop the walk at the project root (floor). Climbing above it would resolve
    // ancestors outside the project — e.g. on macOS /home is a synthetic symlink
    // to /System/Volumes/Data/home — and false-flag legitimate in-project paths
    // as escapes. floor (realCwd) is already canonicalized and validated above.
    if (current === floor) return join(floor, ...segments)
    segments.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) return target // reached fs root without finding existing
    current = parent
  }
  try {
    return join(realpathSync(current), ...segments)
  } catch {
    return target
  }
}

export function validatePath(cwd: string, filePath: string, mode: 'read' | 'write' = 'read'): string {
  const result = validatePathSafe(cwd, filePath, mode)
  if (!result.ok) throw new Error(result.error)
  return result.path
}
