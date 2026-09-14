import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join, win32 as winPath } from 'node:path'

const execFileAsync = promisify(execFile)

export interface ToolVersion {
  available: boolean
  version?: string
  command: string
  /** Absolute path when found on PATH, otherwise the bare command name. */
  path?: string
}

export interface PythonEnvInfo {
  python: ToolVersion
  uv: ToolVersion
  git: ToolVersion
  node: ToolVersion
  /** JVM toolchain — surfaced so /doctor can show whether GUI-launched PATH
   * resolution actually recovered them (the maven/java pain point). */
  java: ToolVersion
  maven: ToolVersion
  gradle: ToolVersion
  platform: NodeJS.Platform
  /** Effective `git config core.autocrlf` ('true' | 'input' | 'false'), probed on
   *  Windows only. Undefined when unset, git missing, or not Windows. `true` is a
   *  mixed-EOL hazard: checkouts get CRLF while the agent writes LF. */
  gitAutocrlf?: string
  /** Shell info — Windows 上 Git Bash 是否可用、当前降级到什么 shell。
   *  桌面端据此决定是否弹 Git 安装引导面板。 */
  shell?: {
    kind: 'bash' | 'powershell' | 'cmd' | 'sh'
    gitBashAvailable: boolean
    /** 降级原因（gitBashAvailable=false 时有值）。 */
    fallbackReason?: string
  }
}

const PYTHON_INSTALL_GUIDE: Record<string, string> = {
  darwin: 'macOS 推荐：brew install python\n或从 https://www.python.org/downloads/ 下载安装包。',
  win32: 'Windows 推荐：\n1. Microsoft Store 搜索并安装 "Python 3.12"\n2. 或从 https://www.python.org/downloads/windows/ 下载安装程序，安装时勾选 "Add Python to PATH"。',
  linux: 'Linux 推荐：\nsudo apt update && sudo apt install python3 python3-pip python3-venv\n（Fedora 用 dnf install python3 python3-pip）',
}

const UV_INSTALL_GUIDE: Record<string, string> = {
  darwin: 'macOS: curl -LsSf https://astral.sh/uv/install.sh | sh\n或: brew install uv',
  win32: 'Windows PowerShell: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
  linux: 'Linux: curl -LsSf https://astral.sh/uv/install.sh | sh',
}

const GIT_INSTALL_GUIDE: Record<string, string> = {
  darwin: 'macOS: xcode-select --install\n或: brew install git',
  win32: 'Windows: https://git-scm.com/download/win 下载安装程序，安装时勾选 "Git from the command line".',
  linux: 'Linux: sudo apt install git\n（Fedora 用 dnf install git）',
}

function platformName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return 'Linux'
}

/** Try to locate a command on PATH and return its absolute path if found. */
export async function which(command: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const shell = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(shell, [command], { windowsHide: true, timeout: 5000, env: env ?? process.env })
    const first = stdout.split('\n')[0]?.trim()
    return first && first.length > 0 ? first : undefined
  } catch {
    return undefined
  }
}

async function getVersion(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    // `java -version` / some tools print the version to stderr — fall back to it.
    const { stdout, stderr } = await execFileAsync(command, args, { windowsHide: true, timeout: 5000, env: env ?? process.env })
    const source = (stdout && stdout.trim().length > 0) ? stdout : stderr
    const line = source.split('\n')[0]?.trim()
    return line && line.length > 0 ? line : undefined
  } catch {
    return undefined
  }
}

async function detectTool(
  commands: string[],
  versionArgs: string[],
  env?: NodeJS.ProcessEnv,
): Promise<ToolVersion> {
  for (const command of commands) {
    const path = await which(command, env)
    if (path) {
      const version = await getVersion(path, versionArgs, env)
      return { available: true, command, path, version }
    }
  }
  return { available: false, command: commands[0] ?? '' }
}

export interface GitExeProbeDeps {
  env: NodeJS.ProcessEnv
  whichGit: () => Promise<string | undefined>
  exists: (p: string) => boolean
}

/**
 * Resolve git.exe on Windows with fallback to common install locations.
 *
 * GUI-launched desktop apps on Windows often inherit a truncated PATH that does
 * not include the user's `C:\Program Files\Git\cmd` entry, so `where git` fails
 * even though Git is installed. Probe order:
 *   1. `RIVET_GIT_PATH` override (seeded from `env.gitPath` on desktop startup)
 *   2. `where git` (PATH)
 *   3. common install locations (Program Files / LOCALAPPDATA)
 * Mirrors the Git Bash probe order from platform.ts, but looks for
 * `cmd\git.exe` instead of `bin\bash.exe`.
 */
export async function resolveGitExePath(deps: GitExeProbeDeps): Promise<string | undefined> {
  // 1. Explicit override: RIVET_GIT_PATH / env.gitPath wins everything.
  const override = deps.env['RIVET_GIT_PATH']
  if (override && deps.exists(override)) return override

  // 2. where git (Electron's PATH — may be truncated)
  const path = await deps.whichGit()
  if (path) return path

  // 3. cmd /c where git — cmd.exe inherits the full system PATH, unlike Electron
  //    which may miss entries only in Machine-level PATH (e.g. D:\App\Git\cmd).
  try {
    const { stdout } = await execFileAsync('cmd', ['/c', 'where', 'git'], { windowsHide: true, timeout: 5000 })
    const first = stdout.split('\n')[0]?.trim()
    if (first && deps.exists(first)) return first
  } catch { /* fall through */ }

  // 4. Common install locations (Program Files / LOCALAPPDATA)
  const candidates = [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  ]
  const localApp = deps.env['LOCALAPPDATA']
  if (localApp) candidates.push(winPath.join(localApp, 'Programs', 'Git', 'cmd', 'git.exe'))

  for (const c of candidates) {
    if (deps.exists(c)) return c
  }

  // 5. Scan system (Machine) PATH for git.exe — covers non-standard install
  //    drives like D:\App\Git that aren't in the per-process PATH Electron sees.
  try {
    const { stdout } = await execFileAsync('cmd', ['/c', 'reg', 'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      '/v', 'Path'], { windowsHide: true, timeout: 5000 })
    const match = stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i)
    if (match?.[1]) {
      const sysPath = match[1].trim()
      for (const dir of sysPath.split(';')) {
        const trimmed = dir.trim()
        if (!trimmed) continue
        const candidate = winPath.join(trimmed, 'git.exe')
        if (deps.exists(candidate)) return candidate
      }
    }
  } catch { /* fall through */ }

  return undefined
}

async function detectGit(env?: NodeJS.ProcessEnv): Promise<ToolVersion> {
  if (process.platform !== 'win32') {
    return detectTool(['git'], ['--version'], env)
  }
  const path = await resolveGitExePath({
    env: env ?? process.env,
    whichGit: () => which('git', env),
    exists: existsSync,
  })
  if (path) {
    const version = await getVersion(path, ['--version'], env)
    return { available: true, command: 'git', path, version }
  }
  return { available: false, command: 'git' }
}

/**
 * Detect Python, uv, git, node + JVM toolchain availability. Pass `env` to probe
 * against the *resolved* PATH (see resolved-env.ts) instead of the raw process
 * PATH — that's what `/doctor` does so it reflects what the agent can actually run.
 */
export async function detectEnv(cwd?: string, env?: NodeJS.ProcessEnv): Promise<PythonEnvInfo> {
  const pythonCommands = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python']
  const [python, uv, git, node, java, maven, gradle] = await Promise.all([
    detectTool(pythonCommands, ['--version'], env),
    detectTool(['uv'], ['--version'], env),
    detectGit(env),
    detectTool(['node'], ['--version'], env),
    detectTool(['java'], ['-version'], env),
    detectTool(['mvn'], ['--version'], env),
    detectTool(['gradle'], ['--version'], env),
  ])
  const gitAutocrlf = process.platform === 'win32' && git.available
    ? await detectGitAutocrlf(git.path ?? git.command, cwd, env)
    : undefined
  return {
    python,
    uv,
    git,
    node,
    java,
    maven,
    gradle,
    platform: process.platform,
    ...(gitAutocrlf !== undefined ? { gitAutocrlf } : {}),
  }
}

/** Probe the effective `git config core.autocrlf`. Returns undefined when unset
 *  (git exits 1) or on any failure. Runs in `cwd` so repo-local config wins. */
async function detectGitAutocrlf(
  gitCmd: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(gitCmd, ['config', '--get', 'core.autocrlf'], { windowsHide: true,
      timeout: 5000,
      env: env ?? process.env,
      ...(cwd ? { cwd } : {}),
    })
    const v = stdout.trim().toLowerCase()
    return v.length > 0 ? v : undefined
  } catch {
    return undefined // unset (exit 1) or git error — either way, nothing to warn about
  }
}

/** True when the checkout is at mixed-EOL risk: Windows + `core.autocrlf=true`
 *  (CRLF working tree while the agent writes LF → noisy diffs). `input`/`false`
 *  are fine. */
export function needsAutocrlfWarning(
  gitAutocrlf: string | undefined,
  platform: NodeJS.Platform | string,
): boolean {
  return platform === 'win32' && gitAutocrlf === 'true'
}

/** Build a human-readable guidance block for missing tools. */
export function formatEnvGuidance(info: PythonEnvInfo): string {
  const lines: string[] = []
  if (!info.python.available) {
    lines.push(`未检测到 Python（${platformName(info.platform)}）。`)
    lines.push(PYTHON_INSTALL_GUIDE[info.platform] ?? PYTHON_INSTALL_GUIDE.linux!)
    lines.push('')
  }
  if (!info.git.available) {
    lines.push(`未检测到 Git（${platformName(info.platform)}）。`)
    lines.push(GIT_INSTALL_GUIDE[info.platform] ?? GIT_INSTALL_GUIDE.linux!)
    lines.push('')
  }
  if (info.python.available && !info.uv.available) {
    lines.push('已检测到 Python。推荐安装 uv 以自动管理 Python 版本和依赖：')
    lines.push(UV_INSTALL_GUIDE[info.platform] ?? UV_INSTALL_GUIDE.linux!)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** Per-platform install commands for a missing tool. */
export function getInstallCommand(tool: 'python' | 'git' | 'uv', platform: NodeJS.Platform): string {
  const map = tool === 'python' ? PYTHON_INSTALL_GUIDE : tool === 'git' ? GIT_INSTALL_GUIDE : UV_INSTALL_GUIDE
  return map[platform] ?? map.linux!
}

/** True if cwd looks like a Python project. */
export function isPythonProject(cwd: string): boolean {
  const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']
  return markers.some(m => existsSync(join(cwd, m)))
}

export interface UvSetupResult {
  ok: boolean
  message: string
  command?: string
}

/**
 * Recommend the right uv command to bootstrap a Python project.
 * Does not execute anything — callers (e.g. slash command) run the returned command.
 */
export function recommendUvSetup(cwd: string): UvSetupResult {
  if (!isPythonProject(cwd)) {
    return { ok: false, message: '当前目录不像 Python 项目（缺少 pyproject.toml / requirements.txt / setup.py）。' }
  }
  if (existsSync(join(cwd, 'pyproject.toml'))) {
    return { ok: true, message: '检测到 pyproject.toml，将使用 uv sync 安装依赖。', command: 'uv sync' }
  }
  if (existsSync(join(cwd, 'requirements.txt'))) {
    return { ok: true, message: '检测到 requirements.txt，将使用 uv venv + uv pip install 安装依赖。', command: 'uv venv && uv pip install -r requirements.txt' }
  }
  return { ok: false, message: '检测到 Python 项目标记，但未找到 pyproject.toml 或 requirements.txt。' }
}

/**
 * Prominent startup banner shown when git is missing. On Windows this is now
 * near-required: the bash tool prefers Git Bash for reliable command execution,
 * so without git, shell commands fall back to PowerShell/cmd (degraded). Returns
 * '' when git is present so the caller can skip emitting anything.
 */
export function formatGitMissingBanner(gitAvailable: boolean, platform: NodeJS.Platform): string {
  if (gitAvailable) return ''
  const guide = getInstallCommand('git', platform)
  if (platform === 'win32') {
    return [
      '⚠ 未检测到 Git。',
      'Windows 上 Git 自带的 Git Bash 是 bash 工具执行命令的首选 shell——缺少它会退回',
      'PowerShell/cmd,部分命令可能行为异常或无输出。强烈建议安装:',
      `  ${guide}`,
      '装好后重启天枢即可自动启用 Git Bash(也可用 RIVET_GIT_BASH_PATH 手动指路)。',
    ].join('\n')
  }
  return [
    '⚠ 未检测到 Git。代码仓库操作(commit / diff / 检查点回滚)需要 Git:',
    `  ${guide}`,
  ].join('\n')
}

/** Build a one-line hint appended to bash not-found errors. */
export function buildNotFoundHint(missingCommand: string, platform: NodeJS.Platform): string {
  if (missingCommand === 'python' || missingCommand === 'python3' || missingCommand === 'py') {
    return `\n[环境缺失] ${getInstallCommand('python', platform)}`
  }
  if (missingCommand === 'git') {
    return `\n[环境缺失] ${getInstallCommand('git', platform)}`
  }
  if (missingCommand === 'uv') {
    return `\n[环境缺失] ${getInstallCommand('uv', platform)}`
  }
  return ''
}

/** Best-effort extract the missing command name from a not-found error body. */
export function extractMissingCommand(body: string, command: string): string {
  const m1 = body.match(/The term '([^']+)' is not recognized/i)
  if (m1) return m1[1]!
  const m2 = body.match(/'([^']+)' is not recognized as an internal/i)
  if (m2) return m2[1]!
  const m3 = body.match(/command not found:\s*(\S+)/i)
  if (m3) return m3[1]!
  const m4 = body.match(/(\S+):\s*command not found/i)
  if (m4) return m4[1]!
  return command.trim().split(/\s+/)[0] ?? ''
}
