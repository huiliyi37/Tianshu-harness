import { isAbsolute, relative, join } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { runTypeCheck, type LspCheckResult } from '../lsp/client.js'
import type { Diagnostic } from '../lsp/diagnostics.js'
import { loadDeclaredVerify, matchVerifyRoutes } from '../config/verify-config.js'
import { parseVerifyCommand, spawnVerifyArgv } from './verify-command.js'

/**
 * Deterministic, session-independent typecheck backstop for the review gate.
 *
 * The post-edit `syntaxCheck` (esbuild) and the tsx test runner share an
 * esbuild engine that only transpiles — it never type-checks, so duplicate
 * object keys, duplicate interface members, impossible comparisons and
 * dangling references from accidental deletions all slip through. LSP
 * diagnostics would catch them but are gated on a live tsserver, which
 * worker/headless sessions (`lspManager: null`) lack.
 *
 * This module runs a single real `tsc --noEmit`, scoped to the files the task
 * actually changed, so it works the same in every session type. It is purely
 * advisory: it only ever escalates on the PRESENCE of errors in changed files,
 * and fails open (returns null) whenever tsc could not run to completion.
 */

/** A bash command that runs a real TypeScript type check (vs. a plain test run,
 *  which under tsx/esbuild never type-checks). Used to clear the
 *  typecheck-reminder flag. Narrower than isVerificationIntent on
 *  purpose — `test`/`lint`/`build` do not establish type safety. */
export const TYPECHECK_CMD_RE = /\b(tsc|type-?check)\b/i

/** Injectable so tests can mock without spawning a real tsc / needing mkdtemp.
 *  Async so the real tsc subprocess (runTypeCheck) does not block the event loop
 *  — see client.ts. Mock runners must return a Promise. */
export type TypecheckRunner = (cwd: string) => Promise<LspCheckResult>

const defaultRunner: TypecheckRunner = (cwd) => runTypeCheck(cwd, '*')

/** tsc 超时预算（波间硬门禁场景）。默认 2 分钟在满载机器上不够（本仓库冷跑
 *  ~70s，天枢长任务时多会话抢 CPU 实测超时）——波间验证不在乎这点延迟，
 *  给足 5 分钟换取"跑得完"。 */
export const GATE_TSC_TIMEOUT_MS = 300_000

/** Wave-gate 专用 runner：更长的超时预算。advisory 调用点（deliver_task 等）
 *  维持 defaultRunner 的 2 分钟不变。 */
export const gateTypecheckRunner: TypecheckRunner = (cwd) => runTypeCheck(cwd, '*', GATE_TSC_TIMEOUT_MS)

/** Master switch. The review-gate typecheck backstop is on by default; set
 *  RIVET_TYPECHECK_GATE=0/false/off/no to disable it entirely. */
export function typecheckGateEnabled(): boolean {
  const v = process.env.RIVET_TYPECHECK_GATE
  if (v == null) return true
  return !/^(0|false|off|no)$/i.test(v.trim())
}

/** Sub-switch for the repo-wide (cross-file drift) detection layer. On by
 *  default; set RIVET_TYPECHECK_REPO_WIDE=0/false/off/no to disable only the
 *  drift layer (scoped detection remains active). */
export function repoWideEnabled(): boolean {
  const v = process.env.RIVET_TYPECHECK_REPO_WIDE
  if (v == null) return true
  return !/^(0|false|off|no)$/i.test(v.trim())
}

export interface RepoWideErrors {
  /** file -> capped list of error summaries, same format as byFile. */
  byFile: Record<string, string[]>
  /** Total count of drift errors (before capping). */
  count: number
  /** Summary text for the drift segment. */
  summary: string
}

export interface ChangedFilesTypecheck {
  /** Changed files that have at least one type error. */
  brokenFiles: string[]
  /** file -> capped list of error summaries (e.g. "L264 TS1117: ..."). */
  byFile: Record<string, string[]>
  /** Single-line text for focusHint / advisory / content note. */
  summary: string
  /** Cross-file drift errors (new errors in non-changed files). */
  repoWide?: RepoWideErrors
}

const MAX_FILES = 8
const MAX_ERRORS_PER_FILE = 5

/**
 * Normalize a tsc-reported diagnostic path to a repo-relative POSIX path.
 * tsc may print relative (`src/agent/foo.ts`) or absolute paths depending on
 * tsconfig / environment, so we relativize against cwd before matching.
 */
function normalizeDiagFile(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file
  return rel.split('\\').join('/')
}

/** Stable signature for a diagnostic, used to match against the baseline set.
 *  Format: `file|line|message` — file is normalized to repo-relative POSIX.
 *  Exported so the baseline script uses the exact same signing logic. */
export function errorSignature(cwd: string, d: Diagnostic): string {
  return `${normalizeDiagFile(cwd, d.file)}|${d.line}|${d.message}`
}

/** Load the accepted-debt baseline from `.rivet/typecheck-baseline.json`.
 *  Returns a Set of error signatures. Missing or corrupt file → empty Set
 *  (strict: any error escalates). */
function loadTypecheckBaseline(cwd: string): ReadonlySet<string> {
  try {
    const raw = readFileSync(join(cwd, '.rivet', 'typecheck-baseline.json'), 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * Tri-state typecheck outcome — distinguishes "verified clean" from "did not
 * run to completion". Advisory callers collapse both to null (fail-open); the
 * wave HARD gate must treat `inconclusive` as not-verified and block
 * (2026-07-07 事故：tsc 超时被 wave-gate 记成 ✅ passed 放行下一波)。
 */
export interface TypecheckOutcome {
  status: 'clean' | 'errors' | 'inconclusive'
  /** Non-null iff status === 'errors'. */
  result: ChangedFilesTypecheck | null
  /** Human-readable cause for 'inconclusive' / 'clean' shortcuts. */
  reason?: string
}

/**
 * Run a scoped typecheck and report type errors that land in `changedFiles`.
 *
 * Also detects cross-file drift: new errors (not in baseline) that land in
 * non-changed files — the "changed schema.ts but the error surfaces in
 * default.ts" pattern. These are collected into `repoWide`.
 *
 * Outcome semantics:
 *   - no changed file is a .ts/.tsx → 'clean' (nothing to check)
 *   - tsc did not run to completion (crash / timeout) → 'inconclusive'
 *   - no new (non-baseline) error anywhere → 'clean'
 *   - otherwise → 'errors' with the scoped report
 */
export async function runChangedFilesTypecheckOutcome(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
  baseline: ReadonlySet<string> = loadTypecheckBaseline(cwd),
): Promise<TypecheckOutcome> {
  const rel = changedFiles.filter(f => !isAbsolute(f) && /\.(ts|tsx)$/.test(f))
  if (rel.length === 0) return { status: 'clean', result: null, reason: 'no changed .ts/.tsx files' }

  const res = await run(cwd)
  // tsc crashed or timed out → partial output is untrustworthy; never report errors.
  if (!res.ranOk) return { status: 'inconclusive', result: null, reason: 'tsc did not run to completion (crash/timeout)' }

  const byFile: Record<string, string[]> = {}
  const driftByFile: Record<string, string[]> = {}
  let driftCount = 0
  const useRepoWide = repoWideEnabled()

  for (const d of res.diagnostics) {
    if (d.severity !== 'error') continue
    // Baseline-suppressed errors are accepted debt — skip entirely.
    if (baseline.has(errorSignature(cwd, d))) continue

    const nf = normalizeDiagFile(cwd, d.file)
    const hit = rel.find(f => nf === f || nf.endsWith('/' + f))
    if (hit) {
      const entry = (byFile[hit] ??= [])
      if (entry.length < MAX_ERRORS_PER_FILE) {
        entry.push(`L${d.line} ${d.message}`)
      }
    } else if (useRepoWide) {
      driftCount++
      const entry = (driftByFile[nf] ??= [])
      if (entry.length < MAX_ERRORS_PER_FILE) {
        entry.push(`L${d.line} ${d.message}`)
      }
    }
  }

  const brokenFiles = Object.keys(byFile)
  const driftFiles = Object.keys(driftByFile)

  if (brokenFiles.length === 0 && driftFiles.length === 0) return { status: 'clean', result: null }

  // Scoped summary
  const parts: string[] = []
  if (brokenFiles.length > 0) {
    const shown = brokenFiles.slice(0, MAX_FILES)
    const segs = shown.map(f => {
      const errs = byFile[f]!
      const more = errs.length >= MAX_ERRORS_PER_FILE ? ' (+more)' : ''
      return `${f}: ${errs.join('; ')}${more}`
    })
    const overflow = brokenFiles.length > MAX_FILES ? ` (+${brokenFiles.length - MAX_FILES} more files)` : ''
    parts.push(`Typecheck broken in changed files — ${segs.join(' | ')}${overflow}`)
  }

  // Drift summary
  let repoWide: RepoWideErrors | undefined
  if (driftFiles.length > 0) {
    const shown = driftFiles.slice(0, MAX_FILES)
    const segs = shown.map(f => {
      const errs = driftByFile[f]!
      const more = errs.length >= MAX_ERRORS_PER_FILE ? ' (+more)' : ''
      return `${f}: ${errs.join('; ')}${more}`
    })
    const overflow = driftFiles.length > MAX_FILES ? ` (+${driftFiles.length - MAX_FILES} more files)` : ''
    const driftSummary = `cross-file 类型漂移（疑似你改的定义引发下游）— ${segs.join(' | ')}${overflow}`
    parts.push(driftSummary)
    repoWide = { byFile: driftByFile, count: driftCount, summary: driftSummary }
  }

  return { status: 'errors', result: { brokenFiles, byFile, summary: parts.join(' || '), repoWide } }
}

/**
 * Legacy advisory view: collapses 'clean' and 'inconclusive' to null
 * (fail-open). Hard-gate callers must use {@link runChangedFilesTypecheckOutcome}
 * (or its memo) instead — null here does NOT mean "verified".
 */
export async function runChangedFilesTypecheck(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
  baseline: ReadonlySet<string> = loadTypecheckBaseline(cwd),
): Promise<ChangedFilesTypecheck | null> {
  const outcome = await runChangedFilesTypecheckOutcome(cwd, changedFiles, run, baseline)
  return outcome.result
}

// ── Memoization ────────────────────────────────────────────────────────────
// A single deliver_task RED → fix-nothing → deliver_task retry must not pay for
// a second full tsc. We cache the last result per cwd, keyed by a signature of
// the changed files' mtime+size so any real edit between calls invalidates it.
// When a file can't be stat'd (mock paths in tests, deleted file) we return
// null signature → no memo, run fresh — never a stale escalation.

interface MemoEntry { sig: string; outcome: TypecheckOutcome }
const memoByCwd = new Map<string, MemoEntry>()

function changedFilesSignature(cwd: string, tsFiles: string[]): string | null {
  if (tsFiles.length === 0) return null
  try {
    return tsFiles
      .slice()
      .sort()
      .map(f => {
        const st = statSync(isAbsolute(f) ? f : join(cwd, f))
        return `${f}:${st.mtimeMs}:${st.size}`
      })
      .join('|')
  } catch {
    return null // missing/unstattable file → cannot memo safely
  }
}

/** Memoized outcome for the gate call sites. `inconclusive` is deliberately
 *  NOT cached: the wave gate's self-heal re-evaluation must re-run tsc so a
 *  transient timeout (loaded machine) clears itself instead of sticking. */
export async function runChangedFilesTypecheckOutcomeMemo(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
  baseline: ReadonlySet<string> = loadTypecheckBaseline(cwd),
): Promise<TypecheckOutcome> {
  const tsFiles = changedFiles.filter(f => !isAbsolute(f) && /\.(ts|tsx)$/.test(f))
  const sig = changedFilesSignature(cwd, tsFiles)
  if (sig) {
    const hit = memoByCwd.get(cwd)
    if (hit && hit.sig === sig) return hit.outcome
  }
  const outcome = await runChangedFilesTypecheckOutcome(cwd, changedFiles, run, baseline)
  if (sig && outcome.status !== 'inconclusive') memoByCwd.set(cwd, { sig, outcome })
  return outcome
}

/** Memoized wrapper for the advisory call sites (deliver_task review gate).
 *  Collapses 'clean'/'inconclusive' to null — see runChangedFilesTypecheck. */
export async function runChangedFilesTypecheckMemo(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
  baseline: ReadonlySet<string> = loadTypecheckBaseline(cwd),
): Promise<ChangedFilesTypecheck | null> {
  const outcome = await runChangedFilesTypecheckOutcomeMemo(cwd, changedFiles, run, baseline)
  return outcome.result
}

/** Test-only: clear the memo cache. */
export function __clearTypecheckMemo(): void {
  memoByCwd.clear()
  declaredMemoByCwd.clear()
  routesMemoByCwd.clear()
}

// ── Declared-command backstop for non-TS projects (A2) ─────────────────────
// The tsc path above is TypeScript-only: its per-file error attribution needs
// tsc's output format. For Rust/Go/Python projects that declared
// `verify.typecheck` (or `verify.build`) in .rivet-config.json we run the
// declared command at pass/fail granularity — no per-file attribution, just
// "the project's own typecheck failed" with an output tail. Explicit scope
// decision: we do not write output parsers per toolchain.

export interface DeclaredCheckResult {
  /** The declared command that was run. */
  command: string
  /** 'typecheck' when verify.typecheck was used, 'build' as fallback. */
  kind: 'typecheck' | 'build'
  /** Single-line summary for focusHint / advisory. */
  summary: string
}

/** Injectable runner: returns exit code + combined output. */
export type DeclaredCommandRunner = (cwd: string, command: string) => Promise<{ exitCode: number; output: string }>

const DECLARED_TIMEOUT_MS = 120_000
const OUTPUT_TAIL_CHARS = 600

// 执行前强制过 parseVerifyCommand（H4 收口）：声明命令虽来自 .rivet-config.json，
// 但模型可经编辑配置文件间接注入恶意 shell——解析失败按「无法执行」收口
// （exit -1，同超时/崩溃语义，gate 视为验证未通过），绝不退回字符串拼 shell。
const defaultDeclaredRunner: DeclaredCommandRunner = (cwd, command) =>
  new Promise((resolve) => {
    let out = ''
    let settled = false
    const settle = (exitCode: number): void => {
      if (settled) return
      settled = true
      resolve({ exitCode, output: out })
    }
    try {
      const argv = parseVerifyCommand(command)
      if (!argv) {
        settle(-1)
        return
      }
      const child = spawnVerifyArgv(cwd, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        settle(-1)
      }, DECLARED_TIMEOUT_MS)
      child.on('close', (code) => { clearTimeout(timer); settle(code ?? -1) })
      child.on('error', () => { clearTimeout(timer); settle(-1) })
    } catch {
      settle(-1)
    }
  })

const declaredMemoByCwd = new Map<string, { sig: string; result: DeclaredCheckResult | null }>()

function allFilesSignature(cwd: string, files: readonly string[]): string | null {
  if (files.length === 0) return null
  try {
    return files
      .slice()
      .sort()
      .map(f => {
        const st = statSync(isAbsolute(f) ? f : join(cwd, f))
        return `${f}:${st.mtimeMs}:${st.size}`
      })
      .join('|')
  } catch {
    return null
  }
}

/**
 * Run the project-declared typecheck/build command when the TS gate does not
 * apply (no changed .ts/.tsx files). Returns null (no escalation) when:
 *   - any changed file is .ts/.tsx (the tsc path owns those)
 *   - no verify.typecheck / verify.build declaration exists
 *   - the command passes (exit 0)
 *   - the command could not run (timeout/crash) — fail-open, same as tsc path
 */
export async function runDeclaredCheck(
  cwd: string,
  changedFiles: readonly string[],
  run: DeclaredCommandRunner = defaultDeclaredRunner,
): Promise<DeclaredCheckResult | null> {
  if (changedFiles.length === 0) return null
  if (changedFiles.some(f => /\.(ts|tsx)$/.test(f))) return null

  const verify = loadDeclaredVerify(cwd)
  const command = verify.typecheck ?? verify.build
  if (!command) return null
  const kind: 'typecheck' | 'build' = verify.typecheck ? 'typecheck' : 'build'

  const sig = allFilesSignature(cwd, changedFiles)
  if (sig) {
    const hit = declaredMemoByCwd.get(cwd)
    if (hit && hit.sig === sig) return hit.result
  }

  const { exitCode, output } = await run(cwd, command)
  // -1 = could not run to completion → fail-open like the tsc path.
  const result: DeclaredCheckResult | null = exitCode > 0
    ? {
        command,
        kind,
        summary: `Declared ${kind} failed (\`${command}\`, exit ${exitCode}) — ${output.slice(-OUTPUT_TAIL_CHARS).trim().split('\n').slice(-6).join(' | ')}`,
      }
    : null

  if (sig) declaredMemoByCwd.set(cwd, { sig, result })
  return result
}

// ── Path-routed verify commands (A3) ───────────────────────────────────────
// verify.routes declare per-glob check commands for sub-projects the root
// typecheck cannot see (desktop/ has its own tsconfig; a Go module under
// server/; etc.). The deliver review gate runs every route whose glob hits a
// changed file. Same semantics as the declared check: exit>0 escalates with
// an output tail, could-not-run (-1) fails open, no per-toolchain parsers.

export interface VerifyRouteFailure {
  match: string
  command: string
  kind: 'test' | 'build' | 'typecheck' | 'lint'
  exitCode: number
  /** Output tail for the focus note. */
  tail: string
}

export interface VerifyRoutesResult {
  failures: VerifyRouteFailure[]
  /** Single-line summary for focusHint / advisory. */
  summary: string
}

const routesMemoByCwd = new Map<string, { sig: string; result: VerifyRoutesResult | null }>()

/**
 * Run every verify.routes entry whose glob matches a changed file.
 * Returns null when no route matches or all matched commands pass / could
 * not run (fail-open). Only failures (exit > 0) are reported.
 */
export async function runVerifyRoutes(
  cwd: string,
  changedFiles: readonly string[],
  run: DeclaredCommandRunner = defaultDeclaredRunner,
): Promise<VerifyRoutesResult | null> {
  if (changedFiles.length === 0) return null
  const routes = matchVerifyRoutes(changedFiles, loadDeclaredVerify(cwd).routes)
  if (routes.length === 0) return null

  const sig = allFilesSignature(cwd, changedFiles)
  if (sig) {
    const hit = routesMemoByCwd.get(cwd)
    if (hit && hit.sig === sig) return hit.result
  }

  const failures: VerifyRouteFailure[] = []
  for (const route of routes) {
    const { exitCode, output } = await run(cwd, route.run)
    // -1 = could not run to completion → fail-open like the tsc path.
    if (exitCode > 0) {
      failures.push({
        match: route.match,
        command: route.run,
        kind: route.kind,
        exitCode,
        tail: output.slice(-OUTPUT_TAIL_CHARS).trim().split('\n').slice(-6).join(' | '),
      })
    }
  }

  const result: VerifyRoutesResult | null = failures.length > 0
    ? {
        failures,
        summary: failures
          .map(f => `${f.kind} failed for ${f.match} (\`${f.command}\`, exit ${f.exitCode}) — ${f.tail}`)
          .join(' || '),
      }
    : null

  if (sig) routesMemoByCwd.set(cwd, { sig, result })
  return result
}
