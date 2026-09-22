import { formatDiagnostics, parseDiagnosticOutput, type Diagnostic } from './diagnostics.js'
import { isAbsolute, relative, join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { LspDiagnostic } from './manager.js'
import { hasServerForFile } from './server-registry.js'
import { runTypecheckShared } from './typecheck-cache.js'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
  /** Whether tsc actually completed. false when killed by signal / timed out /
   *  failed to spawn — in that case `diagnostics` is partial and untrustworthy,
   *  so callers should treat the run as inconclusive (fail-open). */
  ranOk: boolean
}

/**
 * Run a real TypeScript type check using the project-local tsc binary
 * (node_modules/.bin/tsc) via an **async** spawn.
 *
 * Previously this used spawnSync, which blocks the Node event loop for the
 * full duration of tsc (tens of seconds on mid-sized repos). Because
 * deliver_task runs typecheck synchronously inside a tool execution, this
 * froze the TUI render loop — the spinner ticker (120ms setInterval) could
 * not fire, so `⠴ analyzing… Nm Ns` appeared frozen during every commit.
 *
 * Async spawn lets tsc run in a subprocess while the event loop keeps turning:
 * the spinner animates, streaming continues, the UI stays responsive. The
 * local node_modules/.bin/tsc absolute path avoids the PATH hijacking risk
 * that spawnSync('npx', ...) had.
 *
 * Falls back to in-process require('typescript') when node_modules/.bin/tsc is
 * missing (e.g. production bundle without devDependencies).
 */
let _tscPath: string | null | undefined = undefined
let _tscMissingWarned = false

function resolveTscPath(cwd: string): string | null {
  if (_tscPath !== undefined) return _tscPath
  const bin = join(cwd, 'node_modules', '.bin')
  // Windows: the runnable executable is tsc.cmd; the extension-less `tsc` is a
  // POSIX shell script that spawn() cannot execute. Prefer the .cmd so the
  // typecheck gate actually runs on Windows.
  const candidates = process.platform === 'win32'
    ? [join(bin, 'tsc.cmd'), join(bin, 'tsc')]
    : [join(bin, 'tsc')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      _tscPath = candidate
      return candidate
    }
  }
  _tscPath = null
  return null
}

export async function runTypeCheck(cwd: string, filePath: string, timeoutMs = 120_000): Promise<LspCheckResult> {
  const tscPath = resolveTscPath(cwd)

  if (!tscPath) {
    // node_modules/.bin/tsc missing — fall back to in-process compiler API.
    // Warn once so silent degradation is discoverable.
    if (!_tscMissingWarned) {
      _tscMissingWarned = true
      process.stderr.write(
        `[rivet] typecheck gate: node_modules/.bin/tsc not found, falling back to in-process ts.createProgram.\n` +
        `  Install typescript as a devDependency (npm i -D typescript) for subprocess isolation.\n`,
      )
    }
    return runTypeCheckInProcess(cwd, filePath)
  }

  // Run tsc as an async subprocess — its heap is OS-reclaimed on exit, and the
  // event loop stays free so the TUI render loop keeps animating during commit.
  // --noEmit: type-check only, no output files.
  // --pretty false: machine-parseable format (file(line,col): error TSxxxx: msg).
  const result = await runTscShared(tscPath, cwd, timeoutMs)

  // tsc writes diagnostics to stdout when --pretty false (not stderr).
  // Exit code 0 = no errors; exit code 1 = type errors found; exit code 2+ = crash/panic.
  // We treat exit 0 and exit 1 as "ran ok" (the compiler completed).
  // Signal / timeout / spawn failure → ranOk = false.
  const ranOk = result.status === 0 || result.status === 1
  const output = result.stdout + result.stderr

  const allDiagnostics = ranOk ? parseDiagnosticOutput(output, 'ts') : []

  // Filter by filePath if not '*'
  const filtered = filePath === '*'
    ? allDiagnostics
    : allDiagnostics.filter(d => d.file.includes(filePath))

  return {
    diagnostics: filtered,
    formatted: formatDiagnostics(filtered),
    ranOk,
  }
}

/** tsc 参数。同时用作缓存分桶的 variant，两者共用一个常量才不会漂移——
 *  参数改了而 variant 没改，会让新旧格式的输出互相回放。
 *
 *  Exported (2026-09-22) so read-only consumers of the shared verdict — 例如
 *  theta 自检——能按**同一个 variant** 读缓存。指纹与 variant 共同定位缓存
 *  条目，自建一套参数就等于永远命不中，且会与门禁看到不同的错误集。 */
export const TSC_GATE_ARGS = ['--noEmit', '--pretty', 'false'] as const
/** `TSC_GATE_ARGS` 的 variant 串（缓存分桶键的一部分）。 */
export const TSC_GATE_VARIANT = TSC_GATE_ARGS.join(' ')

/**
 * 经跨进程闸门执行 tsc：源码指纹相同则回放别的会话刚跑完的结果，否则排队串行。
 *
 * 本仓库常有多个 agent 会话共用一个工作树，而交付门禁与 wave-gate 每次都跑全量。
 * 并发跑是超线性退化（抢同一批核心），串行加去重的总吞吐显著更高。
 * `RIVET_TYPECHECK_SHARE=0` 退回逐进程各跑各的。
 */
function runTscShared(
  tscPath: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const direct = () => runTscSubprocess(tscPath, cwd, timeoutMs)
  if (process.env.RIVET_TYPECHECK_SHARE === '0') return direct()
  return runTypecheckShared({
    cwd,
    run: direct,
    // 与 npm script 的人读格式分桶：回放另一种格式的原始输出会让 parseDiagnosticOutput 解析错乱。
    variant: TSC_GATE_VARIANT,
    // 等待预算给满 tsc 自己的超时，不打折：持锁者跑的是同一份检查，等它出结果
    // 几乎总快于自己重跑一遍（后者要付全额时间，还抢走它的核心让两边都更慢）。
    // 打折的后果实测过——等待者集体超时后并发开跑，负载反而更高。
    waitBudgetMs: timeoutMs,
  })
}

/**
 * Spawn tsc as an async subprocess, collecting stdout/stderr and enforcing a
 * timeout (default 2 minutes; wave-gate passes a longer budget — see
 * typecheck-gate.ts gateTypecheckRunner). Resolves to { status, stdout, stderr }
 * mirroring spawnSync's shape so the parsing logic above is unchanged.
 * status is null on signal/timeout.
 */
function runTscSubprocess(tscPath: string, cwd: string, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Spawning a .cmd on modern Node requires a shell; quote the path so spaces
    // in the project directory (e.g. C:\Users\My Name) survive cmd.exe parsing.
    const useShell = process.platform === 'win32' && tscPath.toLowerCase().endsWith('.cmd')
    const command = useShell ? `"${tscPath}"` : tscPath
    const child = spawn(command, [...TSC_GATE_ARGS], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    })

    let stdout = ''
    let stderr = ''
    // Cap accumulation at 10 MB (parity with the old spawnSync maxBuffer).
    const MAX = 10 * 1024 * 1024
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX) stdout += chunk.toString('utf8').slice(0, MAX - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX) stderr += chunk.toString('utf8').slice(0, MAX - stderr.length)
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // killed by timeout → treat as inconclusive (null status, same as spawnSync timeout)
      resolve({ status: killed ? null : code, stdout, stderr })
    })
  })
}

// ── In-process fallback (only when node_modules/.bin/tsc is missing) ──────

import { createRequire } from 'node:module'

let _tsModule: typeof import('typescript') | undefined
let _tsLoadAttempted = false

function loadTsModule(): typeof import('typescript') | undefined {
  if (_tsLoadAttempted) return _tsModule
  _tsLoadAttempted = true
  try {
    const require = createRequire(import.meta.url)
    _tsModule = require('typescript') as typeof import('typescript')
  } catch {
    // typescript module not available — fail-open.
  }
  return _tsModule
}

async function runTypeCheckInProcess(cwd: string, filePath: string): Promise<LspCheckResult> {
  const ts = loadTsModule()
  if (!ts) {
    return { diagnostics: [], formatted: '', ranOk: false }
  }

  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) {
    return { diagnostics: [], formatted: '', ranOk: false }
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    return { diagnostics: [], formatted: '', ranOk: false }
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    cwd,
  )

  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
    pretty: false,
  })

  const allDiagnostics = ts.getPreEmitDiagnostics(program)

  const diagnostics: Diagnostic[] = []
  for (const d of allDiagnostics) {
    const category = ts.DiagnosticCategory
    const severity: Diagnostic['severity'] =
      d.category === category.Error ? 'error'
      : d.category === category.Warning ? 'warning'
      : 'info'
    const file = d.file
    if (!file) continue
    const absFile = file.fileName
    const relFile = isAbsolute(absFile) ? relative(cwd, absFile) : absFile
    const lineChar = ts.getLineAndCharacterOfPosition(file, d.start ?? 0)
    diagnostics.push({
      file: relFile,
      line: lineChar.line + 1,
      col: lineChar.character + 1,
      severity,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    })
  }

  const filtered = filePath === '*'
    ? diagnostics
    : diagnostics.filter(d => d.file.includes(filePath))

  return {
    diagnostics: filtered,
    formatted: formatDiagnostics(filtered),
    ranOk: true,
  }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  // 触发面 = registry 已注册的语言。原先硬编码 /\.(ts|tsx|js|jsx)$/，多语言
  // registry 装了 pyright/gopls/jdtls 也收不到编辑后诊断——非 JS/TS 语言的
  // LSP 只对显式工具调用生效。未注册扩展名（.md/.json/.txt…）仍不触发，
  // 免得为无 server 的语言白跑一次探测。
  return hasServerForFile(filePath)
}

/** ±context lines added around each changed range when deciding "in-region". */
const DIAGNOSTIC_CONTEXT_LINES = 3
/** Cap on full in-region diagnostics surfaced to the model. */
const MODEL_INREGION_CAP = 10
/** Cap on line numbers listed in the collapsed out-of-region error nudge. */
const MODEL_OUTREGION_LINE_CAP = 5
/** Cap on the full diagnostics list surfaced to the UI (tool card). */
const UI_DIAGNOSTIC_CAP = 20

export interface EditDiagnosticsResult {
  /** Narrowed text for the model-facing tool_result (may be empty). */
  modelText: string
  /** Full (errors + warnings) list for the UI tool card (may be empty). */
  uiText: string
}

function formatDiagnosticLine(d: LspDiagnostic): string {
  const kind = d.severity === 1 ? 'ERROR' : 'WARNING'
  return `${kind} L${d.range.start.line + 1}: ${d.message}`
}

/**
 * 作用域收敛: split whole-file LSP diagnostics into what the model should see
 * versus what the human should see, using the edit's changed line ranges.
 *
 * Model-facing (returned as `modelText`):
 *   - in-region errors + warnings (line within any range ±context): full messages
 *   - out-of-region errors: collapsed to one nudge line with line numbers
 *   - out-of-region warnings: dropped
 * When `changedRanges` is absent/empty we cannot localize, so the model gets the
 * whole-file list (today's behavior) — a safe fallback.
 *
 * UI-facing (`uiText`): the full errors+warnings list regardless of region, so
 * the TUI/desktop tool card still shows everything the human might want.
 *
 * Rationale: whole-file and cross-file type errors are comprehensively caught by
 * the post-commit typecheck-gate (real tsc on all changed files) at delivery, so
 * the per-edit LSP only needs to give the model fast, local, actionable signal.
 */
export function filterDiagnosticsForEdit(
  diagnostics: LspDiagnostic[],
  changedRanges: Array<{ start: number; end: number }> | undefined,
  context = DIAGNOSTIC_CONTEXT_LINES,
): EditDiagnosticsResult {
  const relevant = diagnostics.filter(d => d.severity <= 2) // errors + warnings only
  if (relevant.length === 0) return { modelText: '', uiText: '' }

  const uiText = relevant.slice(0, UI_DIAGNOSTIC_CAP).map(formatDiagnosticLine).join('\n')

  // No localization available → whole-file model output (safe fallback).
  if (!changedRanges || changedRanges.length === 0) {
    const modelText = relevant.slice(0, MODEL_INREGION_CAP).map(formatDiagnosticLine).join('\n')
    return { modelText, uiText }
  }

  const inRegion = (line1: number): boolean =>
    changedRanges.some(r => line1 >= r.start - context && line1 <= r.end + context)

  const inside: LspDiagnostic[] = []
  const outsideErrors: LspDiagnostic[] = []
  for (const d of relevant) {
    const line1 = d.range.start.line + 1
    if (inRegion(line1)) inside.push(d)
    else if (d.severity === 1) outsideErrors.push(d)
    // out-of-region warnings are dropped
  }

  const parts: string[] = []
  if (inside.length > 0) {
    parts.push(inside.slice(0, MODEL_INREGION_CAP).map(formatDiagnosticLine).join('\n'))
  }
  if (outsideErrors.length > 0) {
    const lines = outsideErrors
      .slice(0, MODEL_OUTREGION_LINE_CAP)
      .map(d => `L${d.range.start.line + 1}`)
      .join(', ')
    const more = outsideErrors.length > MODEL_OUTREGION_LINE_CAP ? ', …' : ''
    parts.push(
      `+${outsideErrors.length} error(s) elsewhere in file (${lines}${more}) — run typecheck before delivery`,
    )
  }

  return { modelText: parts.join('\n'), uiText }
}
