import { spawn, execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'
import { detectSensitiveGitAdd } from './sensitive-file-detector.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { getShellCommand, getShellDiagnostics, WinStreamDecoder, rewriteWindowsNullRedirect, rewritePowershellNullRedirect } from '../platform.js'
import { wrapSandboxCommand as sandboxWrap } from './sandbox-profile.js'
import type { SandboxBackendKind } from './sandbox-profile.js'
import { extractSmartSummary, renderSmartSummary } from './output-summary.js'
import { classifySandboxDenial, buildSandboxDenialHint, recordSandboxLearn } from './sandbox-diagnose.js'
import type { SandboxDenial } from './sandbox-diagnose.js'
import { grantPath } from './path-grants.js'
import { rivetHome } from '../config/paths.js'

/**
 * ToolResult plus the sandbox attribution that the learn-mode retry inspects.
 * Declared rather than inferred: executeBashOnce's early-return branches
 * (client-terminal delegate, background job) never carry the field, so an
 * inferred union would make `first.sandboxDenial` a type error. Optional here,
 * and extending ToolResult keeps the value assignable to the Tool contract.
 */
interface BashExecResult extends ToolResult {
  sandboxDenial?: SandboxDenial | null
}
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { applyCommandFilter } from './command-filters.js'
import { denoiseWindowsError } from './powershell-filter.js'
import { summarizeBashOutput } from '../artifact/summarize.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { loadConfig } from '../config/manager.js'
import { buildMirrorEnv, rewriteGitHubUrls } from './mirror-env.js'
import type { MirrorsConfig } from '../config/schema.js'

/**
 * When autoFallback is enabled, inject git early-fail env vars so that
 * `git clone https://github.com/...` commands abort quickly on slow
 * connections (instead of hanging for 2 minutes). This lets the user see
 * the error and manually try a mirror.
 */
function gitCloneEarlyFailEnv(command: string, config: MirrorsConfig): Record<string, string> {
  if (config.autoFallback === false) return {}
  if (!/\bgit\b.*\bclone\b.*github\.com/.test(command)) return {}
  return {
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '15',
  }
}
import { buildNotFoundHint, extractMissingCommand } from './env-check.js'
import { getResolvedEnv } from './resolved-env.js'
import { OutputStreamBudget } from './output-stream-budget.js'
import { tryClientTerminalExec, delegatedToToolResult } from './client-delegate.js'

/** Success output inline threshold: commands that succeed with ≤ this many lines
 *  return full output to the model. Beyond this, only a header summary is returned
 *  (recoverable via the artifact reference in the same message). */
const SUCCESS_INLINE_LINES = 20

/** Bounded raw-spool cap: recovery content is complete up to this many bytes
 *  per stream. Beyond the cap the spool stops appending and the persisted raw
 *  carries an explicit `[raw capture capped …]` note — never a false
 *  "full output" claim. */
const RAW_SPOOL_CAP_BYTES = 8 * 1024 * 1024

/**
 * W1-A1: bounded raw spool. The in-memory model preview truncates stdout to a
 * 24KB tail once it crosses 32KB — that policy is unchanged. But persistence
 * (rawPath / ArtifactStore) used to consume the SAME truncated buffer, so the
 * head of large outputs was silently lost while the truncation note claimed
 * "full output at rawPath below". The spool captures the stream from the first
 * chunk, bounded at RAW_SPOOL_CAP_BYTES (head-retaining: appending stops at
 * the cap), so recovery is complete within the cap and honest beyond it.
 * Memory stays bounded — it never grows past the cap plus one chunk.
 */
class BoundedRawSpool {
  private chunks: string[] = []
  private bytes = 0
  capped = false

  append(text: string): void {
    if (this.capped || text.length === 0) return
    this.chunks.push(text)
    this.bytes += Buffer.byteLength(text)
    if (this.bytes >= RAW_SPOOL_CAP_BYTES) this.capped = true
  }

  content(): string {
    return this.chunks.join('')
  }
}

/** 一次性 flag：shell 降级警告只在 session 首次 bash 执行时注入一次。 */
let _shellFallbackWarned = false

/** Environment variable prefixes that should be preserved for child processes. */
const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'PWD', 'NODE_ENV', 'TERM', 'LANG', 'LC_', 'XDG_', 'EDITOR', 'VISUAL', 'PAGER', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'COLOR', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  // Windows-critical: without SystemRoot the child process cannot load system
  // DLLs, causing cmd.exe / powershell.exe to exit(0) with zero output.
  'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'PUBLIC', 'HOMEDRIVE', 'ALLUSERSPROFILE', 'PROCESSOR_',
  // Toolchain vars: builds (maven/gradle/java/go/rust/android) and version
  // managers rely on these; stripping them broke `mvn`/`java` when launched from
  // a GUI with a minimal env. None contain sensitive keywords, so the KEY/TOKEN/
  // SECRET filter below still removes anything genuinely secret.
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME', 'CLASSPATH', 'JAVA_TOOL_OPTIONS',
  'MAVEN_', 'M2_', 'M2', 'GRADLE_', 'ANT_HOME',
  'GOPATH', 'GOROOT', 'GOBIN', 'GO111MODULE', 'GOFLAGS', 'GOPROXY',
  'CARGO_HOME', 'RUSTUP_HOME',
  'ANDROID_', 'NVM_DIR', 'PYENV', 'SDKMAN_DIR',
  'DOTNET_', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_',
  'PNPM_HOME', 'VOLTA_HOME', 'FNM_DIR', 'MISE_', 'ASDF_', 'RBENV_ROOT', 'GEM_',
  'NODE_PATH', 'NODE_OPTIONS', 'KUBECONFIG', 'DOCKER_HOST',
] as const

/** Keywords that indicate a sensitive env var — vars containing these substrings are stripped. */
const SENSITIVE_ENV_KEYWORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH', 'PRIVATE'] as const

/** Strip sensitive environment variables before passing to child processes. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    const isSensitive = SENSITIVE_ENV_KEYWORDS.some(kw => upper.includes(kw))
    if (isSensitive) continue
    const isSafe = SAFE_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (isSafe) {
      clean[key] = value
    }
  }
  return clean
}

/**
 * 退出码 → 是否真执行失败。
 *
 * 非零退出码不等于失败：grep(1=无匹配)、diff(1=有差异)、test runner(非零=有失败用例)、
 * lint/build 工具(非零=有告警)都用非零码表达正常语义结果。把这些一律打成 isError
 * 会让环境性非零码被下游(immune/dead-end/doom-loop)放大成 error 风暴，进而把模型推入退化态。
 *
 * 只把"命令无法执行"判为真 error：127(命令未找到)、126(不可执行)、>128(被信号杀死，如段错误)、
 * 以及 timeout(-1)。其余非零码视为"有结果但非执行失败"，由模型自行从输出判断语义。
 */
export function isExecFailure(exitCode: number): boolean {
  return exitCode === -1 || exitCode === 126 || exitCode === 127 || exitCode > 128
}

/** Windows command-not-found stderr fingerprints (PowerShell + cmd.exe). */
const WIN_NOT_FOUND_PATTERNS = [
  /is not recognized as the name of a cmdlet/i,      // PowerShell cmdlet/binary not found
  /is not recognized as an internal or external command/i, // cmd.exe
  /CommandNotFoundException/i,                        // PowerShell .NET exception id
  /ObjectNotFound:/i,                                 // PowerShell CategoryInfo for missing command
  /The term '[^']*' is not recognized/i,              // PowerShell long-form message
]

/** cmd.exe returns 9009 for an unrecognized command. */
const WIN_NOT_FOUND_EXIT = 9009

/**
 * Outcome of a finished shell command.
 *
 * `errorClass: 'environment'` marks "the host could not run this" (command not
 * found), which is NOT a competence failure — on Windows benign command-name
 * differences (`python` vs `py`, missing POSIX tools) constantly produce these,
 * and feeding them into momentum/doom/approval as failures makes the agent
 * timid (低信念 → 频繁意图审批). Such outcomes still set `isError` so the model
 * knows the command did not run, but downstream consumers can branch on the class.
 */
export function classifyBashOutcome(
  exitCode: number,
  stderr: string,
  isWindows: boolean,
): { isError: boolean; errorClass?: 'environment' | 'exec-failure' | 'timeout' } {
  // exitCode -1 is the sole product of the timeout path (isTimeout ? -1 : code).
  // Classify it distinctly from exec-failure: a slow command is not a dead-end.
  if (exitCode === -1) return { isError: true, errorClass: 'timeout' }
  if (isWindows) {
    // Windows-native not-found: cmd.exe 9009 / PowerShell "is not recognized".
    const winNotFound =
      exitCode === WIN_NOT_FOUND_EXIT ||
      ((exitCode === 1 || exitCode > 128) && WIN_NOT_FOUND_PATTERNS.some(p => p.test(stderr)))
    // Git Bash is our PREFERRED Windows shell, so on Windows the common case is a
    // POSIX-style not-found: exit 127 (`bash: py: command not found`) / 126 (not
    // executable). Without this, Git Bash command-not-found was misclassified as
    // 'exec-failure' → fed momentum/doom/approval as a competence failure → 低信念
    // → 模型畏手畏脚、把命令甩给用户手动跑。Treat it as 'environment' like POSIX.
    const posixNotFound = exitCode === 127 || exitCode === 126 || /command not found/i.test(stderr)
    if (winNotFound || posixNotFound) return { isError: true, errorClass: 'environment' }
    // Remaining exec-failure codes (signals / >128 without a not-found fingerprint);
    // otherwise fall through to POSIX semantics so non-zero domain results
    // (e.g. findstr no-match) stay benign.
    if (isExecFailure(exitCode)) return { isError: true, errorClass: 'exec-failure' }
    return { isError: false }
  }

  // POSIX: 127 (not found) / 126 (not executable) are environment-class; signals are exec-failure.
  if (exitCode === 127 || exitCode === 126) return { isError: true, errorClass: 'environment' }
  if (isExecFailure(exitCode)) return { isError: true, errorClass: 'exec-failure' }
  return { isError: false }
}

/** 内部 errorClass → 对外 errorKind 映射。exec-failure 不映射（undefined），
 *  留给 failure-classifier 的文本正则细分（段错误/信号杀死消息为 shell 原生英文，正则仍可匹配）。 */
function toErrorKind(cls: 'environment' | 'exec-failure' | 'timeout' | undefined): 'missing_dep' | 'timeout' | undefined {
  if (cls === 'environment') return 'missing_dep'
  if (cls === 'timeout') return 'timeout'
  return undefined
}

/**
 * 结果装配失败时的降级结果（finish 的 try/catch 兜底用）。导出以锁定契约：
 * 必须含根因、真实退出码、输出尾部，且绝不伪装成命令本身的失败。
 */
export function buildAssemblyFailureResult(
  message: string,
  exitCode: number,
  outputTail: string,
): { content: string; uiContent: string; isError: boolean } {
  return {
    content: `错误：bash 结果装配失败 —— ${message}\n` +
      `[exit=${exitCode}] 命令本身已执行结束，这不是命令失败，是 rivet 组装输出时出错。原始输出尾部：\n` +
      `${outputTail || '(无输出)'}`,
    uiContent: `✗ 结果装配失败: ${message.slice(0, 80)}`,
    isError: true,
  }
}

/**
 * Wrap a command in a workspace-scoped sandbox. Default-OFF.
 * Enable with RIVET_SANDBOX=1.
 */
export function wrapSandboxCommand(command: string, cwd?: string): {
  command: string
  sandboxed: boolean
  backend: SandboxBackendKind
  note?: string
  writableRoots?: readonly string[]
} {
  const decision = sandboxWrap(command, { cwd: cwd ?? process.cwd() })
  return {
    command: decision.command,
    sandboxed: decision.sandboxed,
    backend: decision.backend,
    note: decision.note,
    writableRoots: decision.writableRoots,
  }
}

/**
 * Per-call cache to avoid calling rtkRewrite twice for the same command
 * within a single tool invocation (requiresApproval → execute).
 *
 * Keyed by (command, toolUseId) to isolate concurrent workers — a global
 * single-entry cache would let one worker's rewrite bleed into another's
 * gate/execute cycle, violating the TOCTOU safety guarantee.
 */
let _cachedCommand: string | undefined
let _cachedResult: string | undefined
let _cachedToolUseId: string | undefined

/**
 * rtk 健康判定（进程级缓存）。
 *
 * 背景（session 4df36bcd / f1bde946 两次事故）：rtk 未装 hook（`rtk init -g`）时
 * `rtk ls` 对非空目录也返回 `(empty)`。盲信 `rtk rewrite` 的重写会把这种损坏
 * 变成系统性假工具结果——模型看到 `(empty)` 就断定"目录不存在/文件丢失"，
 * 进而重写用户文件。header 显示实际执行命令（:478-483）只是缓解：模型仍信 body。
 *
 * 对策：首次 rewrite 前做端到端探针——`rtk ls` 一个含标记文件的临时目录，
 * 输出必须包含标记文件名。探针失败则整个进程停用 rtk 重写并一次性告警
 * （命令照常原生执行，输出从此真实）。
 *
 * - `RIVET_RTK=0`：kill switch，直接停用（不探针、不告警）。
 * - rtk 二进制缺失：静默透传（未安装 rtk 的机器不受任何影响）。
 */
type RtkVerdict = 'unknown' | 'ok' | 'broken' | 'missing'
let _rtkVerdict: RtkVerdict = 'unknown'
/** 测试注入点：替换 execFileSync（见 __setRtkExecForTests）。 */
let _rtkExecOverride: typeof execFileSync | undefined

function rtkExec(): typeof execFileSync {
  return _rtkExecOverride ?? execFileSync
}

function probeRtkHealth(): RtkVerdict {
  try {
    rtkExec()('rtk', ['--version'], { timeout: 1000, encoding: 'utf-8', windowsHide: true })
  } catch {
    return 'missing'
  }
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'rivet-rtk-probe-'))
    writeFileSync(join(dir, 'rivet-rtk-marker'), 'x')
    const out = rtkExec()('rtk', ['ls', dir], { timeout: 2000, encoding: 'utf-8', windowsHide: true })
    return out.includes('rivet-rtk-marker') ? 'ok' : 'broken'
  } catch {
    return 'broken'
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

function rtkVerdict(): RtkVerdict {
  if (process.env.RIVET_RTK === '0') return 'broken' // kill switch：等同 broken 静默透传
  if (_rtkVerdict === 'unknown') {
    _rtkVerdict = probeRtkHealth()
    if (_rtkVerdict === 'broken') {
      const msg =
        '[rivet] rtk health probe failed (`rtk ls` returned no marker output) — rtk command rewriting DISABLED for this process; commands run natively. Repair with `rtk init -g`, or silence with RIVET_RTK=0.'
      debugLog(`[rtk-disabled] ${msg}`)
      // 经 output-guard（TUI）成为 ⚠ 静态行；headless 直接可见。
      process.stderr.write(`${msg}\n`)
    }
  }
  return _rtkVerdict
}

/** 测试专用：注入 rtk 执行器 + 重置判定/调用缓存。 */
export function __setRtkExecForTests(exec: typeof execFileSync | undefined): void {
  _rtkExecOverride = exec
  _rtkVerdict = 'unknown'
  _cachedCommand = undefined
  _cachedResult = undefined
  _cachedToolUseId = undefined
}

/** 测试专用：暴露 rtkRewrite 的判定行为（不进入生产路径）。 */
export const __rtkRewriteForTests = rtkRewrite

function rtkRewrite(command: string, toolUseId?: string): string {
  if (command === _cachedCommand && _cachedResult !== undefined && toolUseId === _cachedToolUseId) {
    return _cachedResult
  }
  let result: string
  try {
    result = rtkVerdict() === 'ok'
      ? rtkExec()('rtk', ['rewrite', command], { timeout: 500, encoding: 'utf-8', windowsHide: true }).trim()
      : command
  } catch {
    result = command
  }
  _cachedCommand = command
  _cachedResult = result
  _cachedToolUseId = toolUseId
  return result
}

// ── bash-level file read tracking ──
// Detects when the model repeats the same command on the same file, which burns
// context tokens without adding information. Keyed by verb+path+pattern to
// avoid false warnings when different commands access the same path (e.g.
// head vs tail, grep with different patterns).
const bashFileReads = new Map<string, { command: string; toolUseId: string; at: number }>()
const BASH_READ_PATTERNS = [
  /(?:^|[;&|]\s*)cat\s+['"]?([^'"\s;|&]+)['"]?/g,
  /(?:^|[;&|]\s*)grep\s+.*\s+['"]?([^'"\s;|&]+)['"]?\s*$/gm,
  /(?:^|[;&|]\s*)head\s+.*\s+['"]?([^'"\s;|&]+)['"]?/g,
  /(?:^|[;&|]\s*)tail\s+.*\s+['"]?([^'"\s;|&]+)['"]?/g,
]

/** Derive a command-verb + file-path signature for bash reread dedup. */
function bashReadKey(command: string, filePath: string): string {
  const verbMatch = command.match(/^\s*(cat|grep|head|tail)\b/)
  const verb = verbMatch ? verbMatch[1]! : 'other'
  if (verb === 'grep') {
    // Extract the search pattern: prefer quoted ("..." or '...'), then
    // fall back to the first non-flag token before the file path.
    const quoted = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*(["'])([^"']+)\1/)
    if (quoted) {
      return `grep:${filePath}:${quoted[2]!}`
    }
    // Unquoted: take everything between flags and the file path
    const unquoted = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*(\S+)\s+\S/)
    return `grep:${filePath}:${unquoted ? unquoted[1]! : ''}`
  }
  if (verb === 'head' || verb === 'tail') {
    // Include line count if specified
    const lineCount = command.match(/-\d+/)?.[0] ?? ''
    return `${verb}:${filePath}:${lineCount}`
  }
  return `${verb}:${filePath}`
}

export function checkBashReread(command: string, toolUseId: string): string | null {
  for (const pattern of BASH_READ_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      const filePath = match[1]!
      if (filePath.startsWith('/tmp/') || filePath.startsWith('/dev/') || filePath === '-') continue
      const key = bashReadKey(command, filePath)
      const prior = bashFileReads.get(key)
      if (prior && prior.toolUseId !== toolUseId) {
        bashFileReads.set(key, { command: command.slice(0, 80), toolUseId, at: Date.now() })
        return `── bash-reread ──\n⚠ 已用相同的 bash 命令读取过该文件: ${prior.command}。重复读取浪费上下文。如需多次查询，先 cat > /tmp 一次，后续操作在 /tmp 上进行。\n── bash-reread ──`
      }
      bashFileReads.set(key, { command: command.slice(0, 80), toolUseId, at: Date.now() })
    }
  }
  return null
}
setInterval(() => { for (const [k, v] of bashFileReads) { if (Date.now() - v.at > 600_000) bashFileReads.delete(k) } }, 300_000).unref()

/**
 * Conservative allowlist of commands that should auto-background when the model
 * does not specify run_in_background. Two safe classes only:
 *   1. Non-terminating processes (dev servers / watchers) — blocking them stalls
 *      the whole loop until timeout for no benefit.
 *   2. Long installs — terminate eventually but tie up a turn; the model can
 *      `job(await)` when it actually needs them done.
 * Deliberately EXCLUDES build/test: the model usually depends on their result
 * synchronously, so silently backgrounding them would surprise it. It can still
 * opt in explicitly with run_in_background=true.
 */
const LONG_RUNNER_PATTERNS: RegExp[] = [
  // Package installs.
  /\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b/i,
  /\bnpm\s+i\b/i,
  // Dev servers / start / watch / serve scripts.
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|watch|serve|storybook)\b/i,
  // Common dev-server / watcher binaries.
  /\b(vite|nodemon|ng\s+serve|webpack(-dev-server|\s+serve)|rollup\s+.*-w\b|esbuild\s+.*--watch)\b/i,
  /\bnext\s+(dev|start)\b/i,
  // TypeScript watch mode.
  /\btsc\b[^&|;]*(--watch|\s-w\b)/i,
  // Docker / compose up (non -d foreground brings up services and blocks).
  /\bdocker(\s+compose|-compose)?\s+up\b/i,
]

/** True when the command matches a known long-running / non-terminating pattern. */
export function isLongRunner(command: string): boolean {
  return LONG_RUNNER_PATTERNS.some((p) => p.test(command))
}

/** One full attempt. Extracted verbatim so execute() can retry it in learn mode. */
async function executeBashOnce(params: ToolCallParams): Promise<BashExecResult> {
  const rawCommand = params.input.command as string
  const rewritten = rtkRewrite(rawCommand, params.toolUseId)
  const mirrorConfig = loadConfig({ cwd: params.cwd }).mirrors
  const rewrittenWithMirrors = rewriteGitHubUrls(rewritten, mirrorConfig)
  const sandbox = wrapSandboxCommand(rewrittenWithMirrors, params.cwd)
  const command = sandbox.command
  const timeout = (params.input.timeout as number) ?? 120_000
  const startTime = Date.now()

  // Background path: explicit run_in_background=true, or auto-detected long-runner
  // (unless explicitly disabled). Requires a session job registry (server / TUI
  // with sessionId); otherwise falls through to normal foreground execution.
  const explicitBg = params.input.run_in_background
  const wantBackground = explicitBg === true || (explicitBg !== false && isLongRunner(rawCommand))
  // E4 — foreground only: visible-terminal landing. Background jobs stay local.
  if (!wantBackground && params.onClientDelegate) {
    const delegated = await tryClientTerminalExec(params, command, params.cwd)
    if (delegated) {
      return {
        ...delegatedToToolResult(delegated),
        command: rawCommand,
      }
    }
  }
  if (wantBackground && params.jobs) {
    const mirrorEnv = buildMirrorEnv(mirrorConfig)
    const earlyFailEnv = gitCloneEarlyFailEnv(rawCommand, mirrorConfig)
    const env = { ...sanitizeEnv(getResolvedEnv(params.cwd)), ...mirrorEnv, ...earlyFailEnv }
    const snap = params.jobs.spawn({ command, rawCommand, cwd: params.cwd, env })
    const auto = explicitBg !== true
    const sandboxNote = sandbox.sandboxed && sandbox.note ? `\n${sandbox.note}` : ''
    const content =
      `[job:${snap.id}] ${auto ? '已自动转入后台' : '已在后台启动'}: ${rawCommand}\n` +
      `不阻塞当前轮次。用 job(action="await", id="${snap.id}", pattern="Ready|listening|compiled") 等待就绪/退出，` +
      `job(action="logs", id="${snap.id}") 看输出，job(action="kill", id="${snap.id}") 终止。${sandboxNote}`
    const shortCmd = rawCommand.length > 80 ? rawCommand.slice(0, 80) + '…' : rawCommand
    return Promise.resolve({
      content,
      uiContent: `▶ 后台任务 ${snap.id}: ${shortCmd}`,
      isError: false,
      command: rawCommand,
    })
  }

  return new Promise((resolve) => {
    const shell = getShellCommand()
    // Wrap by shell FAMILY (not fragile cmd-string matching): Git Bash needs
    // no encoding prefix (UTF-8 native) but must not emit literal `nul` files;
    // PowerShell needs UTF-8 console encoding; cmd needs no prefix (WinStreamDecoder
    // auto-detects GBK vs UTF-8 on the first chunk).
    let commandToRun = command
    if (shell.kind === 'bash') {
      commandToRun = rewriteWindowsNullRedirect(command)
    } else if (shell.kind === 'powershell') {
      // Normalize stray `2>nul`/`2>/dev/null` (bash/cmd habit) → `2>$null`
      // before prefixing the UTF-8 encoding setup.
      commandToRun = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${rewritePowershellNullRedirect(command)}`
    } else if (shell.kind === 'cmd') {
      // NOTE: removed `chcp 65001 > nul &&` prefix — the `nul` device redirect
      // fails in sandboxed/WSL Windows environments (exit=1, empty stdout).
      // WinStreamDecoder already auto-detects GBK vs UTF-8 on the first chunk,
      // so the explicit chcp is unnecessary.
      commandToRun = command
    }

    const mirrorEnv = buildMirrorEnv(mirrorConfig)
    const earlyFailEnv = gitCloneEarlyFailEnv(rawCommand, mirrorConfig)
    debugLog(`[bash-spawn] kind=${shell.kind} shell=${shell.cmd} args=${JSON.stringify(shell.args)} cwd=${params.cwd ?? process.cwd()}`)
    const child = track(spawn(shell.cmd, [...shell.args, commandToRun], {
      cwd: params.cwd,
      env: { ...sanitizeEnv(getResolvedEnv(params.cwd)), ...mirrorEnv, ...earlyFailEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: true breaks stdio pipes on Windows cmd.exe — the new
      // console created in detached mode doesn't connect back to the parent's
      // pipes, causing all commands to return exit=0 with empty output.
      detached: process.platform !== 'win32',
      // Hide the transient console window on Windows (no-op elsewhere) — also
      // avoids stdio handoff quirks in some Windows environments.
      windowsHide: true,
    }))

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stdoutTruncated = false
    let stderrTruncated = false
    let stdoutRawBytes = 0
    let stderrRawBytes = 0

    const stdoutDecoder = new WinStreamDecoder()
    const stderrDecoder = new WinStreamDecoder()
    const uiOutput = new OutputStreamBudget({
      emit: (text) => params.onOutput?.(text),
      maxVisible: 64 * 1024,
    })
    // W1-A1: capture the raw stream (arrival order, both streams) BEFORE the
    // in-memory preview truncation below — persistence must not consume the
    // tail-truncated preview buffer.
    const rawSpool = new BoundedRawSpool()

    child.stdout!.on('data', (data: Buffer) => {
      const text = stdoutDecoder.write(data)
      stdoutRawBytes += data.length
      rawSpool.append(text)
      stdout += text
      uiOutput.push(text)
      if (stdout.length > 32_000) {
        if (!stdoutTruncated) {
          stdoutTruncated = true
        }
        stdout = stdout.slice(-24_000)
      }
    })

    child.stderr!.on('data', (data: Buffer) => {
      const text = stderrDecoder.write(data)
      stderrRawBytes += data.length
      rawSpool.append(text)
      stderr += text
      uiOutput.push(text)
      if (stderr.length > 32_000) {
        stderrTruncated = true
        stderr = stderr.slice(-24_000)
      }
    })

    const buildResult = async (code: number, isTimeout = false) => {
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      stdout += stdoutTail
      stderr += stderrTail
      rawSpool.append(stdoutTail)
      rawSpool.append(stderrTail)
      uiOutput.push(stdoutTail)
      uiOutput.push(stderrTail)
      uiOutput.flush()
      uiOutput.dispose()
      // Shell 降级一次性警告（session 首次）：Windows 上 Git Bash 缺失时 fallback 到
      // PowerShell/cmd，告诉模型/用户根因，避免"命令大面积失败但不知为什么"。
      let shellFallbackNote = ''
      if (!_shellFallbackWarned) {
        const diag = getShellDiagnostics()
        if (diag.fallbackReason) {
          _shellFallbackWarned = true
          shellFallbackNote = `⚠ ${diag.fallbackReason}\n` +
            `建议：安装 Git for Windows（https://git-scm.com）或设置 RIVET_GIT_BASH_PATH 指向 bash.exe。\n`
        }
      }
      // 2026-09-07: 截断时用智能摘要（head + error anchors + tail）替换纯尾部——
      // 纯尾 24K 会丢失头部/中部错误（RED 复现：40KB 输出错误在 10KB 处被丢弃）。
      // P1-3（3a）：扫描源改为与 rawPath 同源的 rawSpool（混流保头 capped 副本）——
      // 旧实现扫纯 stdout 保尾窗口 stdoutFull，锚行号与 rawPath（混流保头）不对应，
      // stderr 交错即漂移，@raw 行 N / read_file 直达定位误导。同源后行号自洽；
      // stderr 行成为锚候选属增益（错误常在 stderr）。capped 时窗口=保头 8MB，
      // 与落盘一致（下方 capNote 声明超 cap 未捕获），可见层附注说明锚窗口。
      let visibleStdout = stdout
      if (stdoutTruncated) {
        const summary = extractSmartSummary(rawSpool.content())
        visibleStdout = renderSmartSummary(summary, stdoutRawBytes)
        if (rawSpool.capped) {
          visibleStdout += `\n[raw capture capped at ${RAW_SPOOL_CAP_BYTES} bytes — 锚扫描与 rawPath 同保头窗口，超 cap 内容未捕获]\n`
        }
      }
      const truncNote = stdoutTruncated
        ? `[stdout truncated: output exceeded 32KB (${stdoutRawBytes} bytes total) — 智能摘要见下，full output at rawPath below]\n`
        : ''
      const stderrNote = stderrTruncated
        ? `[stderr truncated: output exceeded 32KB, showing last 24KB]\n`
        : ''
      const raw = truncNote + stderrNote + visibleStdout + (stderr ? '\n' + stderr : '')
      const totalRawBytes = stdoutRawBytes + stderrRawBytes
      // W1-A1: persistence consumes the spool (complete within the cap), not
      // the tail-truncated preview buffer. Beyond the cap we declare honestly.
      // P1-3（3a）：capNote 放 content 之后——前缀会令锚行号整体 +1 偏移
      // （read_file rawPath 直达错位一行）；后缀声明语义无损（仍在文件末尾可见）。
      const capNote = rawSpool.capped
        ? `\n[raw capture capped at ${RAW_SPOOL_CAP_BYTES} bytes (stream total ${totalRawBytes} bytes) — content beyond the cap was NOT captured]\n`
        : ''
      const persistedRaw = rawSpool.content() + capNote
      // Persistence failure must degrade honestly (no rawPath, no silent loss
      // claim) instead of rejecting the whole tool call.
      const persistRawSafe = async (): Promise<string | undefined> => {
        try {
          return await persistRawOutput(params.toolUseId, persistedRaw)
        } catch (e) {
          debugLog(`[bash-raw-persist-failed] ${e instanceof Error ? e.message : String(e)}`)
          return undefined
        }
      }
      const totalRawLines = raw.split('\n').length - (truncNote ? truncNote.split('\n').length - 1 : 0) - (stderrNote ? stderrNote.split('\n').length - 1 : 0)
      const durationMs = Date.now() - startTime
      const exitCode = isTimeout ? -1 : code
      debugLog(`[bash-done] exit=${exitCode} stdoutBytes=${stdoutRawBytes} stderrBytes=${stderrRawBytes} durationMs=${durationMs}`)
      // When rtk rewrote the command (e.g. `ls` → `rtk ls`), surface the
      // EXECUTED command in the result header. Hiding the rewrite let a
      // filtered `rtk ls` "(empty)" result masquerade as native ls output —
      // the model concluded existing files were lost and rewrote them
      // (session 4df36bcd). The header must never claim a command ran when
      // a different one did.
      const headerCommand = rewritten !== rawCommand ? rewritten : rawCommand
      const meta = { command: headerCommand, exitCode, durationMs }
      const { isError, errorClass } = classifyBashOutcome(exitCode, stderr, process.platform === 'win32')
      // Sandbox attribution: a bare "Operation not permitted" sends the model
      // into a sudo/chmod retry loop. Name the path and route it to
      // request_path_access instead. Computed before the modelBody branches
      // because a denial can land in either (exit 1 for a refused redirect,
      // exit 127 for a bwrap construction failure).
      //
      // Gate on exitCode, NOT isError: a refused shell redirect exits 1, and
      // isExecFailure only recognizes -1/126/127/>128 — so classifyBashOutcome
      // calls that case benign. Gating on isError would silently drop the most
      // common denial shape.
      const sandboxDenial = sandbox.sandboxed && exitCode !== 0
        ? classifySandboxDenial({
            stderr,
            backend: sandbox.backend,
            writableRoots: sandbox.writableRoots ?? [],
          })
        : null
      // P1: Command-Aware filtering — apply before content construction so the
      // model sees a condensed, semantically-relevant version. Raw output is
      // still persisted for artifact recovery.
      const commandFiltered = applyCommandFilter(rawCommand, raw, code) ?? raw
      // Windows: strip PowerShell/cmd error noise (CategoryInfo/FullyQualifiedErrorId/
      // carets) and prepend a recovery hint for command-not-found so the wall of red
      // text neither pollutes context nor misleads the model into self-assessed failure.
      let filtered = process.platform === 'win32'
        ? denoiseWindowsError(commandFiltered, { exitCode, errorClass, command: rawCommand })
        : commandFiltered
      // POSIX / macOS / Linux: append install guidance for missing python/git/uv.
      if (errorClass === 'environment' && process.platform !== 'win32') {
        filtered += buildNotFoundHint(extractMissingCommand(filtered, rawCommand), process.platform)
      }
      const rereadWarn = checkBashReread(rawCommand, params.toolUseId)

      // Empty stdout on success must NOT be back-filled with a synthetic
      // "Exit code: 0" body. Doing so rendered as "lines=1 — output complete\n
      // Exit code: 0", which the model (especially on Windows, where it already
      // distrusts bash) misreads as "output was swallowed / bash is a no-op" —
      // the documented doom-loop trigger (writes & `… > file` redirects produce
      // no stdout, so this hit constantly). Pass empty through so buildModelOutput
      // emits the explicit "confirmed empty" marker instead. Failures/timeouts
      // keep a synthetic body so the reason is never blank.
      // environment 类失败（127/126/9009 = 命令缺失/不可执行）：给模型标准化简洁体，
      // 不把整墙红字灌进上下文（会污染前缀缓存、误导模型自判"代码出错"）。完整原文仍走
      // uiContent（buildUiOutput(filtered)），用户在 TUI 能看到全部。
      let modelBody: string
      if (errorClass === 'environment') {
        const missing = extractMissingCommand(filtered, rawCommand)
        const notFound = exitCode === 127 || exitCode === 9009
        const reason = notFound
          ? `command not found${missing ? `: ${missing}` : ''}`
          : exitCode === 126
            ? 'command found but not executable (permission denied)'
            : `environment error (exit ${exitCode})`
        const hint = buildNotFoundHint(missing, process.platform)
        modelBody = `环境/配置问题：${reason}。属环境/依赖缺失，非代码缺陷——请修复环境后重试，勿反复重跑相同命令。${hint}`
      } else {
        modelBody = filtered || (isTimeout ? '命令超时。' : code === 0 ? '' : `退出码：${code}`)
      }
      if (sandboxDenial) modelBody = buildSandboxDenialHint(sandboxDenial) + '\n\n' + modelBody

      // Use ArtifactStore if available (preferred); otherwise fall back to output-store.
      // Skip persistRawOutput in artifact mode — ArtifactStore owns raw persistence,
      // so we don't double-write to output-store/.
      if (params.artifactStore) {
        // Skip artifact wrapping for output small enough that prune won't touch it.
        // Critical for bash: a `cat file.ts` or `sed -n '1,200p'` returns a few KB,
        // and wrapping that in [artifact:X] makes the model think the output was
        // truncated even though it has the whole thing in modelOutput. Tianshu's
        // post-mortem: every bash result became "[artifact:X] ... use read_section"
        // → the model started writing /tmp files just to escape the artifact loop.
        const artifactThreshold = getToolArtifactThreshold('bash', params.contextWindow)
        const wrapInArtifact = filtered.length >= artifactThreshold

        if (!wrapInArtifact) {
          debugLog(`[artifact-skip] tool=bash cmd=${rawCommand.slice(0, 60)} raw=${raw.length} threshold=${artifactThreshold}`)
          const rawPath = await persistRawSafe()
          const baseContent = buildModelOutput(modelBody, { ...meta, rawPath })
          const prefix = shellFallbackNote + (rereadWarn ? rereadWarn + '\n' : '')
          return {
            content: prefix ? prefix + baseContent : baseContent,
            uiContent: buildUiOutput(filtered, meta),
            rawPath,
            isError,
            errorClass,
            errorKind: toErrorKind(errorClass),
            lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
            rawBytes: totalRawBytes,
            rawLines: totalRawLines,
            exitCode,
            command: rawCommand,
            sandboxDenial,
          }
        }

        debugLog(`[artifact-wrap] tool=bash cmd=${rawCommand.slice(0, 60)} raw=${raw.length} threshold=${artifactThreshold}`)
        const { summary, sections } = summarizeBashOutput(filtered, rawCommand, exitCode)
        const artifactId = await params.artifactStore.save({
          tool: 'bash',
          target: rawCommand,
          rawContent: persistedRaw,
          summary,
          sections,
        })
        const artifact = params.artifactStore.get(artifactId)
        // Even when wrapping, prepend the model-formatted output so the model
        // sees the head/tail directly — the [artifact:X] marker is a back-up
        // recovery path, not the only way to access content.
        const lineCount = filtered.split('\n').length
        const successFold = exitCode === 0 && lineCount > SUCCESS_INLINE_LINES
        const modelOutput = successFold
          ? `[${rawCommand}] exit=0 (${lineCount} lines) — success output folded, full output recoverable below`
          : buildModelOutput(modelBody, meta)
        const baseContent = `${modelOutput}\n\nUse read_section(artifactId="${artifactId}", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:${artifactId}]`
        const prefix = shellFallbackNote + (rereadWarn ? rereadWarn + '\n' : '')
        return {
          content: prefix ? prefix + baseContent : baseContent,
          uiContent: buildUiOutput(filtered, meta),
          rawPath: artifact?.rawPath,
          isError,
          errorClass,
          errorKind: toErrorKind(errorClass),
          lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
          rawBytes: totalRawBytes,
          rawLines: totalRawLines,
          exitCode,
          command: rawCommand,
          sandboxDenial,
        }
      }

      const rawPath = await persistRawSafe()
      const baseContent = buildModelOutput(modelBody, { ...meta, rawPath })
      return {
        content: rereadWarn ? rereadWarn + '\n' + baseContent : baseContent,
        uiContent: buildUiOutput(filtered, meta),
        rawPath,
        isError,
        errorClass,
        errorKind: toErrorKind(errorClass),
        lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
        rawBytes: totalRawBytes,
        rawLines: totalRawLines,
        exitCode,
        command: rawCommand,
        sandboxDenial,
      }
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const signal = params.abortSignal
    const cleanupAbort = () => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const finish = async (code: number, isTimeout = false, clearForceKill = true) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (clearForceKill && forceKillTimer) clearTimeout(forceKillTimer)
      cleanupAbort()
      // 结果装配兜底：buildResult 内任何异常（如 dist 混构导致的
      // ReferenceError，session 22d00a37）从 child 事件处理器逃逸时不会变成
      // promise rejection——execute() 永不 settle，只能等管线 120s 看门狗，
      // 模型干等两分钟后拿到一句误导性的 "spawn 卡住"。异常必须降级为带
      // 根因的工具结果：命令真实执行过、输出尾部在、错误可见。
      try {
        resolve(await buildResult(code, isTimeout))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        debugLog(`[bash-buildResult-failed] exit=${code} ${msg}`)
        const tail = (stdout + (stderr ? `\n${stderr}` : '')).slice(-2000)
        resolve(buildAssemblyFailureResult(msg, code, tail))
      }
    }

    // 用户中止（Esc/Ctrl+C → AgentLoop.abort → pipeline abortSignal）：
    // 协作式取消——杀掉 detached 进程树（SIGTERM，3s 后 SIGKILL 兜底），立即 settle。
    // 没有这一步，bash 子进程会在 abort 后继续在后台运行（detached），是会话"假死"
    // 期间资源泄漏与副作用的来源。结果值本身可能被 withToolTimeout 的竞速丢弃，
    // 真正的目的是确保进程被杀。
    const onAbort = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      cleanupAbort()
      killProcessTree(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000)
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      const finalStdout = stdout + stdoutTail
      const finalStderr = stderr + stderrTail
      uiOutput.push(stdoutTail)
      uiOutput.push(stderrTail)
      uiOutput.flush()
      uiOutput.dispose()
      const raw = finalStdout + (finalStderr ? '\n' + finalStderr : '')
      resolve({
        content: raw ? `[aborted] 命令被用户中止，部分输出:\n${raw.slice(-2000)}` : '命令被用户中止。',
        uiContent: '⏹ aborted',
        isError: false,
      })
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000)
      void finish(0, true, false)
    }, timeout)

    child.on('close', (code) => {
      void finish(code ?? 1, timedOut)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      cleanupAbort()
      uiOutput.flush()
      uiOutput.dispose()
      // spawn ENOENT（shell 二进制找不到）走环境分级——给根因而非裸 err.message。
      const msg = err.message
      if ('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        const diag = getShellDiagnostics()
        const hint = diag.fallbackReason
          ? `\n${diag.fallbackReason}\n建议：设置 RIVET_GIT_BASH_PATH 环境变量指向 bash.exe，或安装 Git for Windows。`
          : `\nShell 路径无效：${diag.cmd}。建议检查 shell 是否已安装。`
        resolve({
          content: `Shell 执行失败：找不到 shell 二进制 (${diag.cmd})。${hint}`,
          isError: true,
          errorClass: 'environment',
          errorKind: 'missing_dep',
        })
        return
      }
      resolve({ content: msg, isError: true })
    })
  })
}

/** 沙箱拒绝后的「首触即授 + 重跑一次」判定（导出供单测）：
 *  - RIVET_SANDBOX=learn：教学采集模式（toolchain profile 从实证填充）；
 *  - 全自动档（dangerously-skip-permissions）：零打扰承诺——出界写当场授予
 *    会话级授权并重跑，不再「拒绝 → 模型恢复轮」（2026-09-05 用户反馈）。
 * 无拒绝路径时恒 false。重跑的非幂等副作用风险由调用方在结果里声明。 */
export function shouldAutoGrantSandboxDenial(
  sandboxEnv: string | undefined,
  approvalMode: string | undefined,
  hasDenialPaths: boolean,
): boolean {
  if (!hasDenialPaths) return false
  return sandboxEnv === 'learn' || approvalMode === 'dangerously-skip-permissions'
}

export const BASH_TOOL: Tool = {
  definition: {
    name: 'bash',
    description: `执行 shell 命令，用于构建、测试、git 和系统操作。

用 && 串联独立命令。长时间运行的命令（dev server、watcher、install）传 run_in_background=true 转入后台，用 job 工具查看/等待/终止。自动检测已知长跑命令也会后台化。`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'integer', description: '超时毫秒数（默认 120000）' },
        run_in_background: { type: 'boolean', description: '设为 true 转入后台并返回 job id。自动检测已知长跑命令。' },
      },
      required: ['command'],
    },
  },

  async execute(params: ToolCallParams) {
    const first = await executeBashOnce(params)

    // learn mode / 全自动档：a boundary denial should teach, not block. Grant the
    // refused path for this session, retry ONCE, and log the observation so the
    // toolchain profile (sandbox-toolchain.ts) is filled from evidence rather
    // than guesswork.
    //
    // 两条触发线：RIVET_SANDBOX=learn（教学采集模式）或 skip 档（全自动的
    // 零打扰承诺——出界写首触即授，2026-09-05 用户反馈「全自动动不动被拦」）。
    // ⚠ 2026-09-07 语义（6ff919118）：yolo 默认已无沙箱（完全权限全盘读写），
    // skip 档触发线只在显式 RIVET_SANDBOX=1 时实际到达——保留以服务显式沙箱
    // 用户；默认 yolo 路径不经此处（无 sandboxDenial 产生）。
    // 注意非幂等副作用：被拒前已执行的前缀会跑第二遍（网络 POST/追加/迁移
    // 会重复）——最多重跑一次，且重复在结果里声明。敏感文件硬墙与 deny 规则
    // 在上游（validatePath / approval-risk）不受影响。
    const skipTier = params.approvalMode === 'dangerously-skip-permissions'
    const denial = first.sandboxDenial
    if (!denial || denial.paths.length === 0) return first
    if (!shouldAutoGrantSandboxDenial(process.env.RIVET_SANDBOX, params.approvalMode, true)) {
      return first
    }

    for (const p of denial.paths) grantPath(p, 'write', { cwd: params.cwd })
    recordSandboxLearn({
      cwd: params.cwd,
      command: String(params.input.command ?? ''),
      backend: denial.backend,
      deniedPaths: denial.paths,
      retried: true,
    }, rivetHome())

    // The retry re-enters executeBashOnce, which re-wraps the command —
    // defaultWritableRoots is recomputed per wrap, so the grants just recorded
    // are already in the new profile.
    const second = await executeBashOnce(params)
    const tag = skipTier ? 'sandbox 首触即授' : 'sandbox learn'
    const banner =
      `[${tag}] 首次执行被写边界拒绝，已临时授权 ${denial.paths.join(', ')} 并重跑一次。` +
      `注意：首次执行在被拒之前产生的副作用可能已重复发生。\n\n`
    return { ...second, content: banner + second.content }
  },

  requiresApproval(params: ToolCallParams): boolean {
    const rawCommand = params.input.command as string
    const rewrittenCommand = rtkRewrite(rawCommand, params.toolUseId)
    // Check BOTH raw and rewritten commands.
    // rtkRewrite may expand aliases/macros into dangerous commands
    // that the raw form does not match.
    if (DANGEROUS_BASH_PATTERNS.some(
      pattern => pattern.test(rawCommand) || pattern.test(rewrittenCommand),
    )) {
      return true
    }
    // git add 敏感文件硬门（prompt 安全纪律的运行时落地）：命令文本暂存凭据/密钥
    // 文件 → 需审批。检测器 fail-closed 且不抛——不可解析的命令最多漏报，不会崩。
    return detectSensitiveGitAdd(rawCommand).length > 0
      || detectSensitiveGitAdd(rewrittenCommand).length > 0
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
