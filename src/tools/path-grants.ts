/**
 * Session-scoped out-of-workspace path grants.
 *
 * The two enforcement gates (file-tool `validatePathSafe` and the kernel bash
 * sandbox `defaultWritableRoots`) both default to "workspace only". This store
 * lets the agent — ONLY after an explicit user approval — widen that boundary
 * to a specific directory subtree, so authorized work outside the workspace
 * (writing a package to ~/Desktop, reading /tmp, touching the parent dir) is
 * possible without dropping the whole sandbox.
 *
 * Lifetime: grants live in-process (one session) by default. A grant may be
 * persisted per-workspace under ~/.rivet so a "remembered" path survives across
 * sessions of THAT workspace — never globally (a grant for project A must not
 * leak into project B).
 *
 * Security: a grant is a directory subtree. Containment checks canonicalize
 * symlinks on both sides so a granted path cannot be used to escape via a
 * symlinked child. `write` implies `read`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { rivetHome } from '../config/paths.js'
import { expandHome } from '../platform.js'
import { debugLog } from '../utils/debug.js'
import { rawOutputDir } from './output-store.js'

export type GrantMode = 'read' | 'write'

export interface PathGrant {
  /** Canonicalized (realpath'd where possible) absolute directory root. */
  root: string
  mode: GrantMode
  grantedAt: number
  /** True when this grant was written through to the per-workspace store. */
  persisted?: boolean
  /**
   * Session scope: canonicalized cwd of the session that approved this grant.
   * Interactively approved grants (request_path_access) and per-workspace
   * persisted grants are ALWAYS scoped. Scope-less grants (config
   * permissions.additional*Dirs, dependency-cache read grants, rivet runtime
   * dirs) are user- or tool-level by design and visible to every session in
   * the process.
   *
   * The sidecar (`rivet serve`) hosts many sessions — possibly across
   * different workspaces — in ONE process, so an unscoped interactive grant
   * approved in workspace A would silently authorize writes from workspace B.
   * The header contract below ("a grant for project A must not leak into
   * project B") is enforced through this field.
   */
  scope?: string
}

const RIVET_DIR = rivetHome()

/** In-memory grants for the current process. Interactive/persisted grants are
 *  session-scoped via PathGrant.scope; scope-less entries are user-level. */
let _grants: PathGrant[] = []

/** True when grant `g` is visible to the session running in `cwd`. An omitted
 *  cwd (legacy callers) sees everything. */
function scopeVisible(g: PathGrant, cwd?: string): boolean {
  if (!cwd) return true
  if (g.scope === undefined) return true
  return g.scope === canonicalize(cwd)
}

/**
 * Canonicalize a path: resolve symlinks where the path (or its nearest existing
 * ancestor) exists, so containment checks compare real paths. Falls back to a
 * plain resolve for not-yet-existing targets.
 */
function canonicalize(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    // Walk up to the nearest existing ancestor, canonicalize it, re-append tail.
    let current = abs
    const tail: string[] = []
    while (!existsSync(current)) {
      const parent = resolve(current, '..')
      if (parent === current) return abs // reached fs root
      tail.unshift(current.slice(parent.length + 1))
      current = parent
    }
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      return abs
    }
  }
}

/**
 * Windows filesystems are case-insensitive: drive letters and path segments
 * arrive in mixed case (F:\ vs f:\, cmd vs Explorer casing), and realpath only
 * normalizes casing for path components that exist. Containment/dedup checks
 * must therefore fold case on win32 or grants silently fail to match.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32'

function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p
}

/**
 * True when `child` is the same as `root` or nested under it, using a
 * separator boundary so `/a/b` does NOT match `/a/bc`. Exposed with an
 * explicit case-sensitivity flag for unit testing win32 semantics on any host.
 *
 * win32 accepts `/` and `\` interchangeably, so both fold to the host
 * separator before the boundary check — a mixed-separator path can neither
 * slip past nor falsely fail containment (posix-style test data must work on
 * a win32 host too). On posix `\` is a legal filename character and stays
 * literal.
 */
export function isPathUnder(root: string, child: string, caseInsensitive: boolean = CASE_INSENSITIVE_FS): boolean {
  const fold = (p: string): string => {
    const norm = sep === '\\' ? p.replace(/\//g, '\\') : p
    return caseInsensitive ? norm.toLowerCase() : norm
  }
  const r = fold(root)
  const c = fold(child)
  if (c === r) return true
  const prefix = r.endsWith(sep) ? r : r + sep
  return c.startsWith(prefix)
}

function isUnder(root: string, child: string): boolean {
  return isPathUnder(root, child)
}

/** Per-workspace persisted-grants file, keyed by a cwd slug (mirrors checkpoint.ts). */
function grantsFile(cwd: string): string {
  const slug = canonicalize(cwd).replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `path-grants-${slug}.json`)
}

/**
 * Grant access to a directory subtree. `root` is canonicalized. A write grant
 * supersedes a prior read grant on the same root. When `opts.persist` is set,
 * the grant is also written to the per-workspace store (requires opts.cwd).
 *
 * When `opts.cwd` is provided the grant is SCOPED to that workspace/session:
 * it authorizes only sessions running in the same cwd. Interactively approved
 * grants must always pass cwd — an unscoped grant would leak across every
 * session the sidecar hosts. Callers that intentionally grant process-wide
 * (config permissions, dependency caches, rivet runtime dirs) omit cwd.
 */
export function grantPath(root: string, mode: GrantMode, opts?: { persist?: boolean; cwd?: string }): PathGrant {
  const canonical = canonicalize(root)
  const scope = opts?.cwd ? canonicalize(opts.cwd) : undefined
  const persist = opts?.persist === true
  const existing = _grants.find(g =>
    foldCase(g.root) === foldCase(canonical)
    && g.scope === scope,
  )
  let grant: PathGrant
  if (existing) {
    // Upgrade read → write; never downgrade.
    if (mode === 'write') existing.mode = 'write'
    if (persist) existing.persisted = true
    grant = existing
  } else {
    grant = { root: canonical, mode, grantedAt: Date.now(), ...(persist ? { persisted: true } : {}), ...(scope ? { scope } : {}) }
    _grants.push(grant)
  }
  if (persist && opts?.cwd) persistGrants(opts.cwd)
  return grant
}

/** True if `absPath` is under any granted root visible to `cwd` (read or write satisfies read). */
export function isReadGranted(absPath: string, cwd?: string): boolean {
  const target = canonicalize(absPath)
  return _grants.some(g => scopeVisible(g, cwd) && isUnder(g.root, target))
}

/** True if `absPath` is under any WRITE-granted root visible to `cwd`. */
export function isWriteGranted(absPath: string, cwd?: string): boolean {
  const target = canonicalize(absPath)
  return _grants.some(g => g.mode === 'write' && scopeVisible(g, cwd) && isUnder(g.root, target))
}

/** Write-granted roots visible to `cwd` (consumed by the sandbox's writable-roots builder). */
export function writeGrantedRoots(cwd?: string): string[] {
  return _grants.filter(g => g.mode === 'write' && scopeVisible(g, cwd)).map(g => g.root)
}

/** Snapshot of current grants. */
export function listGrants(): PathGrant[] {
  return _grants.map(g => ({ ...g }))
}

/** Read the per-workspace store, tolerating a missing/corrupt file. */
function readPersistedFile(cwd: string): PathGrant[] {
  const file = grantsFile(cwd)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PathGrant[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((g): g is PathGrant => !!g && typeof g.root === 'string')
  } catch {
    return []
  }
}

/**
 * The grants persisted for this workspace, as stored on disk. Display/revocation
 * surfaces read this rather than `listGrants()`: the in-memory store also holds
 * session-only grants and the dependency/runtime read grants, which the user
 * never authorized explicitly and must not be offered as revocable entries.
 */
export function listPersistedGrants(cwd: string): PathGrant[] {
  return readPersistedFile(cwd).map(g => ({
    root: g.root,
    mode: g.mode === 'write' ? 'write' : 'read',
    grantedAt: typeof g.grantedAt === 'number' ? g.grantedAt : 0,
    persisted: true,
  }))
}

/**
 * Revoke a grant by exact root. Both halves are required: dropping only the file
 * would leave the subtree writable for the rest of the session (a "revoked"
 * grant that still writes), and dropping only memory would resurrect it at the
 * next startup via `loadPersistedGrants`.
 *
 * Matching is exact, not containment — revoking `/a` must not silently remove a
 * separately-granted `/a/b` the user never asked about.
 *
 * The file is rewritten from its own contents rather than from memory: a peer
 * session may have persisted a grant after this process hydrated, and rewriting
 * from our (staler) memory would silently drop it.
 */
export function revokeGrant(root: string, opts: { cwd: string }): boolean {
  const canonical = canonicalize(root)
  const matches = (candidate: string): boolean => foldCase(canonicalize(candidate)) === foldCase(canonical)
  // Only this workspace's scoped grants (plus scope-less user-level grants) are
  // revocable here — another workspace's in-memory grant must not be touched.
  const revocable = (g: PathGrant): boolean => matches(g.root) && (g.scope === undefined || g.scope === canonicalize(opts.cwd))

  const hadInMemory = _grants.some(revocable)
  if (hadInMemory) _grants = _grants.filter(g => !revocable(g))

  const onDisk = readPersistedFile(opts.cwd)
  const kept = onDisk.filter(g => !matches(g.root))
  const removedFromDisk = kept.length < onDisk.length
  if (removedFromDisk) {
    try {
      mkdirSync(RIVET_DIR, { recursive: true })
      writeFileAtomicSync(grantsFile(opts.cwd), JSON.stringify(kept, null, 2))
    } catch {
      /* best-effort: the in-memory revocation already took effect this session */
    }
  }
  return hadInMemory || removedFromDisk
}

/** Write the currently-persisted grants to the per-workspace store. */
function persistGrants(cwd: string): void {
  try {
    mkdirSync(RIVET_DIR, { recursive: true })
    // 只写本工作区作用域的持久授权——sidecar 单进程多会话共享 _grants，
    // 不过滤会把 B 区 hydrated 的授权写进 A 的文件，A 下次启动即以 scope=A
    // 注水（收编 PR #84 时补齐的泄漏面，评审遗漏接线点③）。
    const scope = canonicalize(cwd)
    const toSave = _grants.filter(g => g.persisted && g.scope === scope)
    writeFileAtomicSync(grantsFile(cwd), JSON.stringify(toSave, null, 2))
  } catch {
    /* best-effort: a persistence failure must not break the grant itself */
  }
}

/**
 * Hydrate persisted grants for this workspace into the in-memory store at
 * startup. Re-canonicalizes each root (paths may have moved/symlinks changed)
 * and drops any whose root no longer exists.
 */
export function loadPersistedGrants(cwd: string): void {
  const file = grantsFile(cwd)
  if (!existsSync(file)) return
  let saved: PathGrant[]
  try {
    saved = JSON.parse(readFileSync(file, 'utf-8')) as PathGrant[]
  } catch {
    return
  }
  if (!Array.isArray(saved)) return
  for (const g of saved) {
    if (!g || typeof g.root !== 'string') continue
    if (!existsSync(g.root)) continue
    const mode: GrantMode = g.mode === 'write' ? 'write' : 'read'
    // Scoped to this workspace: another workspace's persisted grants must not
    // become visible to sessions running here (sidecar hosts many cwds).
    grantPath(g.root, mode, { persist: false, cwd })
    const stored = _grants.find(x =>
      foldCase(x.root) === foldCase(canonicalize(g.root))
      && x.scope === canonicalize(cwd),
    )
    if (stored) stored.persisted = true
  }
}

/**
 * 盘根/目录存在性探测的 TTL 记忆（2026-09-05 跨盘审批链顺手项）：
 * applyConfiguredPathGrants 对每条配置目录同步 existsSync——Windows 上死映射
 * 盘符/断连网络盘的单次探测可达秒级，单线程 sidecar 上 26 个盘根逐个探测会
 * 冻结事件循环（审批事件都发不出去）。启动与 PUT /config/permission-dirs 都
 * 会全量重放，同一批路径短时间内反复探测纯属浪费。TTL 内命中记忆零阻塞；
 * 调用方传 force（用户刚保存配置）时绕过记忆当场实测——新挂载的盘不能等 TTL。
 */
const ROOT_EXISTS_TTL_MS = 30_000
const rootExistsMemo = new Map<string, { exists: boolean; at: number }>()

export function resetRootExistsMemoForTest(): void {
  rootExistsMemo.clear()
}

function rootExistsCached(root: string, force = false): boolean {
  const now = Date.now()
  if (!force) {
    const hit = rootExistsMemo.get(root)
    if (hit && now - hit.at < ROOT_EXISTS_TTL_MS) return hit.exists
  }
  const exists = existsSync(root)
  rootExistsMemo.set(root, { exists, at: now })
  return exists
}

/**
 * Apply the user's standing directory grants from config
 * (`permissions.additionalReadDirs` / `additionalWriteDirs`) at session start —
 * the Codex-style "give this folder to the agent" model. Session-scoped
 * in-memory grants (config is the durable source; nothing is written to the
 * per-workspace grant store). Non-existent entries are skipped fail-closed:
 * a typo'd config line must not open a subtree that later comes into being.
 */
export function applyConfiguredPathGrants(
  permissions: { additionalReadDirs?: string[]; additionalWriteDirs?: string[] } | undefined,
  opts?: { force?: boolean },
): void {
  if (!permissions) return
  const apply = (dirs: string[] | undefined, mode: GrantMode): void => {
    for (const raw of dirs ?? []) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      const root = resolve(expandHome(trimmed))
      if (!rootExistsCached(root, opts?.force)) continue
      grantPath(root, mode, { persist: false })
    }
  }
  apply(permissions.additionalReadDirs, 'read')
  apply(permissions.additionalWriteDirs, 'write')
}

/**
 * Common third-party dependency / toolchain read-only cache directories
 * (relative to $HOME). Read-side counterpart of the writable roots enumerated
 * in `sandbox-profile.ts::defaultWritableRoots` and `sandbox-toolchain.ts` —
 * the same directories the bash sandbox already lets commands write to.
 *
 * Reading a project's dependency source (a HarmonyOS fork in `.pub-cache`, a
 * git-sourced package, a version-mismatched transitive dep) is a routine
 * diagnostic step. Without these read grants, `read_file` / `grep` on any path
 * under $HOME trips `validatePathSafe` → an approval `await` that has no
 * timeout, and the batch-time watchdog is disarmed (turn-orchestrator.ts:892),
 * so the session hangs until the user hits Ctrl+C — exactly the failure seen
 * in the kaiyang session reading `~/.pub-cache/git/.../*.dart`.
 *
 * Grants are READ-ONLY, session-scoped, never persisted: write still goes
 * through the normal approval/sandbox path, and nothing leaks across projects
 * or sessions. Non-existent entries are skipped fail-closed.
 */
const DEFAULT_DEPENDENCY_READ_DIRS = [
  '.npm', '.npm-cache', '.cache',
  '.cargo', '.rustup',
  '.gradle', '.m2',
  '.pub-cache',
  '.pnpm-store', '.yarn',
  '.bun', '.deno',
  '.cocoapods',
  '.gem', '.bundle',
  '.composer', '.config/composer',
  '.android',
  '.nuget',       // .NET NuGet packages
  '.nvm',         // Node Version Manager installations
  '.pyenv',       // Python version manager installs
  'go',
  // In-project node_modules / vendor / Pods already live under cwd and need no
  // grant; this list only covers $HOME-level global caches.
]

/**
 * Environment variable overrides for dependency cache directories.
 *
 * Each key matches a DEFAULT_DEPENDENCY_READ_DIRS entry. When the named
 * environment variable is set (non-empty), its value is used as the absolute
 * directory root instead of the default `$HOME/{key}` path. Absent or empty
 * env vars fall through to the default.
 *
 * Only well-known, user-facing env vars with a stable contract are listed
 * (e.g. CARGO_HOME, GRADLE_USER_HOME). Npm/yarn/pnpm use layered config
 * (npmrc, yarnrc) whose env-var surface is unreliable; they stay on defaults.
 *
 * See .rivet/knowledge/debug-t7-collapse-cache-cliff.md §4 — env var is the
 * write side (who sets), not the read side (who reads).
 */
const ENV_OVERRIDES: Record<string, string> = {
  '.cargo': 'CARGO_HOME',
  '.rustup': 'RUSTUP_HOME',
  '.gradle': 'GRADLE_USER_HOME',
  '.pub-cache': 'PUB_CACHE',
  '.gem': 'GEM_HOME',
}

export function applyDefaultDependencyReadGrants(): void {
  const home = homedir()
  const granted: string[] = []
  const skipped: string[] = []
  for (const rel of DEFAULT_DEPENDENCY_READ_DIRS) {
    const envVar = ENV_OVERRIDES[rel]
    const root = envVar && process.env[envVar]
      ? resolve(process.env[envVar])
      : resolve(join(home, rel))
    if (!existsSync(root)) {
      skipped.push(rel)
      continue
    }
    grantPath(root, 'read', { persist: false })
    granted.push(rel)
  }
  debugLog(`dep read grants: ${granted.length} granted` +
    (granted.length ? ` (${granted.join(', ')})` : '') +
    (skipped.length ? `; ${skipped.length} skipped (${skipped.join(', ')})` : ''))
}

/**
 * Read grants for directories Rivet itself writes outside the workspace and
 * then tells the model to read back.
 *
 * `$TMPDIR/rivet-raw` holds the full output of tools whose result was truncated
 * for the model, and the truncation footer says verbatim:
 * `full output: read_file <rawPath> — 不要重跑命令`. Without a grant that
 * `read_file` fails `validatePathSafe` ("Path outside project directory"), so
 * the model can neither recover the output nor re-run the command — a closed
 * dead end (9 occurrences across 4 sessions on 2026-07-27/28).
 *
 * Unlike the dependency caches above these roots are NOT existence-gated: the
 * raw dir is created lazily on the first truncated output, so at session start
 * it usually does not exist yet and an `existsSync` skip would make the grant
 * never take effect. Skipping fail-closed is right for user-configured paths
 * (a typo must not open a subtree) but wrong here — the path is ours, derived
 * from code rather than input, and it only ever contains output this agent
 * itself produced.
 *
 * Read-only, session-scoped, never persisted.
 */
export function applyRivetRuntimeReadGrants(): void {
  const roots = [rawOutputDir()]
  for (const root of roots) {
    grantPath(root, 'read', { persist: false })
  }
  debugLog(`rivet runtime read grants: ${roots.join(', ')}`)
}

/** Test-only: clear the in-memory grant store. */
export function _resetGrantsForTest(): void {
  _grants = []
}
