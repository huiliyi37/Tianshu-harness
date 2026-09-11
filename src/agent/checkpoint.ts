import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join, isAbsolute, relative } from 'path'
import { promisify } from 'util'
import { rivetHome } from '../config/paths.js'
import { classifyIrreversibleEffects } from './side-effect-classifier.js'

const execFileP = promisify(execFile)

export interface Checkpoint {
  hash: string
  timestamp: number
  message: string
}

export interface RollbackPreview {
  text: string
  confirmationToken: string
}

/**
 * Cross-session ownership guard for parallel sessions on the same branch.
 *
 * Multiple sessions may run concurrently on one branch. A blanket worktree
 * restore would clobber files another session just changed. So rollback and
 * bash side-effect capture consult this guard: any path exclusively claimed by
 * ANOTHER live session is never attributed to, nor restored by, this session.
 *
 * Injected (rather than importing SessionRegistry) so checkpoint.ts stays
 * decoupled from the DB and unit-testable with a plain stub.
 */
export interface OwnershipGuard {
  /** True if relPath is exclusively claimed by a different, live session. */
  isOwnedByOther(relPath: string): boolean
}

/** Minimal structural view of SessionRegistry needed for ownership checks. */
export interface ClaimLookup {
  reapStaleClaims(): string[]
  checkClaim(filePath: string): { sessionId: string; claimType: string } | null
}

/**
 * Build an OwnershipGuard backed by the session registry. Reaps dead sessions'
 * claims first so a crashed peer can't permanently block rollback, then treats
 * a path as another-session-owned only when a *different* session holds an
 * exclusive claim. Checks both the relative and absolute path forms because
 * claims may be stored either way.
 */
export function makeOwnershipGuard(registry: ClaimLookup, mySessionId: string, cwd: string): OwnershipGuard {
  try { registry.reapStaleClaims() } catch { /* best-effort */ }
  return {
    isOwnedByOther(relPath: string): boolean {
      const candidates = [relPath, join(cwd, relPath)]
      for (const key of candidates) {
        const claim = registry.checkClaim(key)
        if (claim && claim.sessionId !== mySessionId && claim.claimType === 'exclusive') {
          return true
        }
      }
      return false
    },
  }
}

interface CheckpointData {
  version: 2
  hash: string
  timestamp: number
  label: string
  cwd: string
  sessionId?: string  // absent in legacy checkpoints
  preExistingDirtyFiles: string[]
  preExistingUntrackedFiles: string[]
  agentTouchedFiles: string[]
  /**
   * Human-readable caveats for irreversible side effects of bash commands that
   * ran during this checkpoint window (API calls, DB writes, publishes, pushes,
   * infra/service changes). File rollback (git checkout) CANNOT undo these — we
   * record them so the rollback preview/result tells the truth instead of
   * implying a clean undo. Deduplicated by label.
   */
  unrevertableEffects?: string[]
  confirmationToken?: string
}

function checkpointFile(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(rivetHome(), `checkpoint-${slug}.json`)
}

/** Returns the checkpoint file path scoped to a session ID. */
export function checkpointFileForSession(sessionId: string): string {
  return join(rivetHome(), `checkpoint-${sessionId}.json`)
}

function loadCheckpointData(cwd: string): CheckpointData | null {
  const file = checkpointFile(cwd)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}

/** Load checkpoint data scoped by session ID. */
function loadCheckpointDataForSession(sessionId: string): CheckpointData | null {
  const file = checkpointFileForSession(sessionId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}

// ─── Checkpoint Index (cross-session discovery per cwd) ───

export interface CheckpointIndexEntry {
  sessionId: string
  files: string[]
  timestamp: number
}

function checkpointIndexFile(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(rivetHome(), `checkpoint-index-${slug}.json`)
}

export function loadCheckpointIndex(cwd: string): CheckpointIndexEntry[] {
  const file = checkpointIndexFile(cwd)
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointIndexEntry[]
  } catch {
    return []
  }
}

export function addToCheckpointIndex(cwd: string, sessionId: string, files: string[]): void {
  const index = loadCheckpointIndex(cwd)
  const existing = index.findIndex(e => e.sessionId === sessionId)
  const entry: CheckpointIndexEntry = { sessionId, files, timestamp: Date.now() }
  if (existing >= 0) {
    index[existing] = entry
  } else {
    index.push(entry)
  }
  writeFileAtomicSync(checkpointIndexFile(cwd), JSON.stringify(index, null, 2))
}

export function removeFromCheckpointIndex(cwd: string, sessionId: string): void {
  const index = loadCheckpointIndex(cwd).filter(e => e.sessionId !== sessionId)
  writeFileAtomicSync(checkpointIndexFile(cwd), JSON.stringify(index, null, 2))
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', ...args], { cwd, timeout: 5000, encoding: 'utf-8' })
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}

async function getDirtySnapshot(cwd: string): Promise<{ dirty: string[]; untracked: string[] }> {
  const dirty = await gitLines(cwd, ['diff', '--name-only'])
  const staged = await gitLines(cwd, ['diff', '--cached', '--name-only'])
  const untracked = await gitLines(cwd, ['ls-files', '--others', '--exclude-standard'])
  return {
    dirty: [...new Set([...dirty, ...staged])].sort(),
    untracked: [...new Set(untracked)].sort(),
  }
}

/** Hard cap on retained checkpoint files. Session-scoped checkpoints are
 *  named per sessionId and were never reclaimed — ephemeral/test runs (cwd in
 *  a temp dir that's later deleted) left ~14k orphans accumulating forever. */
const MAX_CHECKPOINTS = 500

/**
 * Reclaim stale checkpoint files: drop any whose `cwd` no longer exists
 * (orphaned by ephemeral/test workspaces), then trim the survivors to
 * MAX_CHECKPOINTS most-recent by mtime. Best-effort and self-contained — any
 * fs error on a single file is swallowed so a prune never blocks a checkpoint.
 * Returns the number of files removed.
 */
export function pruneOrphanCheckpoints(max = MAX_CHECKPOINTS): number {
  let removed = 0
  let entries: { file: string; mtime: number }[]
  try {
    entries = readdirSync(rivetHome())
      .filter(n => n.startsWith('checkpoint-') && n.endsWith('.json') && !n.startsWith('checkpoint-index-'))
      .map(n => join(rivetHome(), n))
      .map(file => ({ file, mtime: safeMtime(file) }))
  } catch {
    return 0
  }

  // 1. Drop orphans whose recorded cwd is gone.
  const live: { file: string; mtime: number }[] = []
  for (const e of entries) {
    let cwd: string | null = null
    try {
      cwd = (JSON.parse(readFileSync(e.file, 'utf-8')) as CheckpointData).cwd ?? ''
    } catch {
      // 读取/解析失败 ≠ 孤儿：Windows 杀软扫描 EBUSY、权限抖动等瞬态错误
      // 在这里删除会不可逆地毁掉用户的回滚点（checkpoint 是删除类操作唯一
      // 的后悔药）。跳过保留，下次 prune 再试；确认损坏才由使用方处置。
      continue
    }
    if (cwd && existsSync(cwd)) {
      live.push(e)
    } else {
      try { rmSync(e.file, { force: true }); removed++ } catch { /* ignore */ }
    }
  }

  // 2. Trim survivors to the cap, oldest first.
  if (live.length > max) {
    live.sort((a, b) => a.mtime - b.mtime)
    for (const e of live.slice(0, live.length - max)) {
      try { rmSync(e.file, { force: true }); removed++ } catch { /* ignore */ }
    }
  }
  return removed
}

function safeMtime(file: string): number {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

// Prune at most once per process, lazily on first checkpoint write, so the
// scan cost (one readdir + stat/parse per file) is paid once — not per tool.
let prunedThisProcess = false

/** Create a checkpoint by recording the current HEAD hash and dirty worktree state. */
export async function createCheckpoint(cwd: string, label?: string, sessionId?: string): Promise<Checkpoint | null> {
  try {
    if (!prunedThisProcess) {
      prunedThisProcess = true
      pruneOrphanCheckpoints()
    }
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    const hash = stdout.trim()
    const snapshot = await getDirtySnapshot(cwd)

    mkdirSync(rivetHome(), { recursive: true })
    const msg = label ?? 'checkpoint'
    const data: CheckpointData = {
      version: 2,
      hash,
      timestamp: Date.now(),
      label: msg,
      cwd,
      ...(sessionId ? { sessionId } : {}),
      preExistingDirtyFiles: snapshot.dirty,
      preExistingUntrackedFiles: snapshot.untracked,
      agentTouchedFiles: [],
    }

    const file = sessionId ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
    writeFileAtomicSync(file, JSON.stringify(data, null, 2))

    if (sessionId) {
      addToCheckpointIndex(cwd, sessionId, [])
    }

    return { hash, timestamp: data.timestamp, message: msg }
  } catch {
    return null
  }
}

/** Record that the agent touched a file — used for safe rollback scoping.
 *
 *  Race note: this is a read-modify-write on the checkpoint JSON file.
 *  In Node's single-threaded event loop with synchronous fs calls, two
 *  calls cannot interleave — each runs to completion before the next
 *  starts. The writeFileAtomicSync (tmp+rename) ensures individual writes
 *  are atomic. The only theoretical risk is two rapid calls in the same
 *  async tick both reading before either writes, but tool-pipeline.ts
 *  calls this synchronously per-tool in a sequential batch, so the
 *  read→modify→write window is effectively serialized. */
export function recordAgentTouchedFile(cwd: string, file: string, sessionId?: string): void {
  const data = sessionId ? loadCheckpointDataForSession(sessionId) : loadCheckpointData(cwd)
  if (!data) return
  let normalized = file.replace(/^\.\//, '')
  // Tools commonly pass an absolute file_path. Re-base it relative to the repo
  // root so it matches the checkpoint's relative bookkeeping; reject anything
  // that resolves outside cwd. (Mirrors the claim-path normalization the R2
  // conflict guard already does.)
  if (isAbsolute(normalized)) {
    const rel = relative(cwd, normalized)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
    normalized = rel
  }
  if (normalized.includes('..')) return
  data.agentTouchedFiles = [...new Set([...data.agentTouchedFiles, normalized])].sort()
  const outFile = sessionId ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
  writeFileAtomicSync(outFile, JSON.stringify(data, null, 2))
}

/**
 * All paths currently changed in the worktree (modified / added / deleted /
 * untracked / renamed), relative to repo root. Captures bash/tool side effects
 * that the per-edit recorder cannot see (file creation, deletion, in-place
 * mutation by arbitrary shell commands).
 */
async function getChangedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileP(
    'git',
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-uall'],
    { cwd, timeout: 5000, encoding: 'utf-8' },
  )
  const paths = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const body = line.slice(3) // strip "XY " status prefix
    const arrow = body.indexOf(' -> ')
    if (arrow >= 0) {
      paths.add(body.slice(0, arrow).trim())
      paths.add(body.slice(arrow + 4).trim())
    } else {
      paths.add(body.trim())
    }
  }
  return [...paths]
}

/**
 * Capture bash / shell side effects into the checkpoint so a rollback can both
 * undo file changes AND honestly report what it cannot undo.
 *
 * - File effects: diffed against the turn baseline and attributed to THIS
 *   session (parallel-safe — never claims a path another live session owns).
 * - Non-file effects: when `command` is supplied it is classified for
 *   irreversible side effects (API/DB/publish/push/infra/service); any matches
 *   are recorded into `unrevertableEffects`. These persist even when the
 *   command changed zero files (a `curl -X POST` touches nothing on disk yet
 *   mutated remote state).
 *
 * Returns the list of newly-recorded file paths.
 */
export async function recordBashSideEffects(
  cwd: string,
  sessionId?: string,
  guard?: OwnershipGuard,
  command?: string,
): Promise<string[]> {
  const data = sessionId ? loadCheckpointDataForSession(sessionId) : loadCheckpointData(cwd)
  if (!data) return []

  const baseline = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  let changed: string[]
  try {
    changed = await getChangedPaths(cwd)
  } catch {
    changed = []
  }

  const owned = new Set(data.agentTouchedFiles)
  const recorded: string[] = []
  for (const raw of changed) {
    const f = raw.replace(/^\.\//, '')
    // isAbsolute 而非 startsWith('/')：Windows 绝对路径是 D:\... / D:/...，
    // 只查 '/' 会漏放行，绝对路径混进 agentTouchedFiles。
    if (!f || isAbsolute(f) || f.includes('..')) continue
    if (baseline.has(f) || owned.has(f)) continue
    // Parallel-session safety: a path another live session owns is theirs.
    if (guard?.isOwnedByOther(f)) continue
    owned.add(f)
    recorded.push(f)
  }

  // Classify irreversible non-file effects from the command itself.
  const effects = new Set(data.unrevertableEffects ?? [])
  const effectsBefore = effects.size
  if (command) {
    for (const label of classifyIrreversibleEffects(command)) effects.add(label)
  }
  const effectsChanged = effects.size !== effectsBefore

  // Persist if either dimension changed. (A POST that touched no files still
  // needs its unrevertable caveat written.)
  if (recorded.length === 0 && !effectsChanged) return []

  data.agentTouchedFiles = [...owned].sort()
  if (effects.size > 0) data.unrevertableEffects = [...effects].sort()
  const outFile = sessionId ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
  writeFileAtomicSync(outFile, JSON.stringify(data, null, 2))
  if (sessionId && recorded.length > 0) addToCheckpointIndex(cwd, sessionId, data.agentTouchedFiles)
  return recorded
}

/** Preview what a rollback would affect. Returns null if nothing to rollback. */
export async function getRollbackPreview(cwd: string, sessionId?: string, guard?: OwnershipGuard): Promise<RollbackPreview | null> {
  const data = sessionId
    ? (loadCheckpointDataForSession(sessionId) ?? loadCheckpointData(cwd))
    : loadCheckpointData(cwd)
  if (!data) return null

  const token = Math.random().toString(36).slice(2, 10)
  data.confirmationToken = token
  // Write back to the same file we loaded from (session-scoped or legacy cwd-scoped)
  const file = (sessionId && data.sessionId === sessionId) ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
  writeFileAtomicSync(file, JSON.stringify(data, null, 2))

  const protectedFiles = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  const candidate = data.agentTouchedFiles.filter(f => !protectedFiles.has(f))
  const rollbackFiles = candidate.filter(f => !guard?.isOwnedByOther(f))
  const blockedByOther = candidate.filter(f => guard?.isOwnedByOther(f))

  const unrevertable = data.unrevertableEffects ?? []
  // Nothing to restore AND no caveat to surface → truly nothing to do.
  if (rollbackFiles.length === 0 && unrevertable.length === 0) return null

  const text = [
    `Checkpoint: ${data.hash.slice(0, 8)} (${new Date(data.timestamp).toLocaleString()})`,
    'Agent-owned files to restore/remove:',
    ...(rollbackFiles.length > 0 ? rollbackFiles.map(f => `- ${f}`) : ['- (none)']),
    ...(blockedByOther.length > 0
      ? ['', 'Skipped (owned by another live session):', ...blockedByOther.map(f => `- ${f}`)]
      : []),
    ...(unrevertable.length > 0
      ? ['', '⚠️  CANNOT be reverted by file rollback (bash side effects):', ...unrevertable.map(e => `- ${e}`)]
      : []),
  ].join('\n')

  return { text, confirmationToken: token }
}

/** Roll back only agent-owned files. Requires a valid confirmation token from preview. */
export async function rollbackToCheckpoint(
  cwd: string,
  confirmationToken?: string,
  sessionId?: string,
  guard?: OwnershipGuard,
): Promise<{ success: boolean; hash?: string; skipped?: string[]; unrevertable?: string[] }> {
  const data = sessionId
    ? (loadCheckpointDataForSession(sessionId) ?? loadCheckpointData(cwd))
    : loadCheckpointData(cwd)
  if (!data || !confirmationToken || confirmationToken !== data.confirmationToken) {
    return { success: false }
  }

  // Caveats about bash effects git cannot undo — surfaced on every outcome so
  // the caller never mistakes "files restored" for "world restored".
  const unrevertable = data.unrevertableEffects?.length ? data.unrevertableEffects : undefined

  const protectedFiles = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  const candidate = data.agentTouchedFiles.filter(f => !protectedFiles.has(f))

  // Parallel-session safety: never restore a path a different live session owns.
  // We scope the restore strictly to this session's own touched set; anything
  // contested is skipped and surfaced rather than blanket-reverted.
  const skipped: string[] = []
  const files = candidate.filter(f => {
    if (guard?.isOwnedByOther(f)) { skipped.push(f); return false }
    return true
  })
  if (files.length === 0) {
    // No revertable files. Still surface any irreversible-effect caveat so the
    // caller doesn't mistake "nothing restored" for "nothing happened".
    return { success: false, skipped: skipped.length ? skipped : undefined, unrevertable }
  }

  try {
    for (const file of files) {
      const trackedAtHead = await execFileP('git', ['cat-file', '-e', `${data.hash}:${file}`], { cwd })
        .then(() => true)
        .catch(() => false)
      if (trackedAtHead) {
        await execFileP('git', ['checkout', data.hash, '--', file], { cwd, timeout: 10000 })
      } else {
        const fullPath = join(cwd, file)
        if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true })
      }
    }
    return { success: true, hash: data.hash.slice(0, 7), skipped: skipped.length ? skipped : undefined, unrevertable }
  } catch {
    return { success: false, skipped: skipped.length ? skipped : undefined, unrevertable }
  }
}

/** List all rivet checkpoint commits. */
export function listCheckpoints(cwd: string): Checkpoint[] {
  const data = loadCheckpointData(cwd)
  if (!data) return []
  return [{ hash: data.hash.slice(0, 7), timestamp: data.timestamp, message: data.label }]
}
