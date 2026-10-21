/**
 * 通用 argv 无 shell 执行器（issue #523 WP2）。
 *
 * 形态参考 run-tests.ts 的 runTestCommandIn（单结算守卫 / 尾部保留缓冲 /
 * SIGTERM→3s 宽限→SIGKILL 梯度），但抽成与 test 概念无关的通用语义。
 * 复用原语：killProcessTree（POSIX 负 PID 进程组 + Windows taskkill /F /T）、
 * track（进程跟踪，退出路径 killAllSync 兜底）、spawnHidden（windowsHide）。
 *
 * POSIX 下 detached: true 自成进程组——killProcessTree 按负 PID 收整棵树；
 * Windows 不 detached（detached 会破坏 stdio 管道），树杀走 taskkill。
 *
 * env 是安全关键面：buildSanitizedEnv 白名单制剥离（PYTHONPATH/PYTHONHOME/
 * VIRTUAL_ENV/CONDA_* 等会污染 Python 环境的变量一律不进子进程），只保留
 * 系统运行必需的变量，再由调用方显式注入覆盖（如镜像两个 PIP_* 变量）。
 */
import { execFileSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { killProcessTree, killProcessTreeAsync } from './process-kill.js'
import { track } from './process-tracker.js'
import { spawnHidden } from './spawn-hidden.js'

export interface ProcessExecOptions {
  argv: string[]
  cwd?: string
  /** 完整环境（经 buildSanitizedEnv 组装的产物）；缺省 = sanitize(process.env)。 */
  env?: NodeJS.ProcessEnv
  /** 硬超时；到点走 SIGTERM → 3s 宽限 → SIGKILL。缺省无超时。 */
  timeoutMs?: number
  /** 协作式取消：abort 后同超时梯度杀树。 */
  abortSignal?: AbortSignal
  /** 流式回调（与聚合缓冲并存）。 */
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  /** 喂给子进程的 stdin（UTF-8 写入后关闭）；缺省 'ignore'。 */
  stdin?: string
  /** 聚合缓冲上限（字节，按字符近似）；超限保留尾部。缺省 1MB。 */
  maxBufferChars?: number
  /** 测试缝：替换 spawn。 */
  spawn?: typeof spawnHidden
  onSpawn?: (pid: number) => void
}

export interface ProcessExecResult {
  exitCode: number
  signal?: NodeJS.Signals
  timedOut: boolean
  cancelled: boolean
  stdout: string
  stderr: string
  durationMs: number
  cleanupConfirmed?: boolean
}

/**
 * Python 环境污染变量黑名单（命中即剥）：PYTHONPATH/PYTHONHOME 会改写模块
 * 搜索路径，VIRTUAL_ENV/CONDA_* 会让 pip/venv 误判目标环境——技能环境必须
 * 与宿主 Python 状态隔离（install 目标目录由 argv 决定，不由 env 暗示）。
 */
const PYTHON_HOSTILE_PREFIXES = ['PYTHON', 'VIRTUAL_ENV', 'CONDA_'] as const

/**
 * 白名单保留的系统变量：进程启动与网络运行必需。其余（含 PIP_* 杂项、
 * 用户 shell 杂项）一律不进子进程——调用方要注入就显式 env 覆盖。
 */
const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMROOT', 'SYSTEMDRIVE', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMDATA', 'USERPROFILE', 'NUMBER_OF_PROCESSORS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
] as const

/**
 * 组装子进程环境：白名单保留系统变量 → 剥 Python 污染变量 → 应用调用方覆盖。
 * overrides 里的键值显式胜出（含把黑名单键加回来的能力——调用方负责）。
 */
export function buildSanitizedEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null)
  for (const key of ENV_WHITELIST) {
    const value = base[key]
    if (typeof value === 'string') env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) env[key] = value
  return env
}

/** 内部判定用的黑名单断言（overrides 之外的直接 base 过滤已完成于白名单）。 */
export function isPythonHostileEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return PYTHON_HOSTILE_PREFIXES.some(prefix => upper === prefix || upper.startsWith(prefix))
}

export async function execProcess(options: ProcessExecOptions): Promise<ProcessExecResult> {
  const { argv } = options
  if (argv.length === 0 || !argv[0]) throw new Error('execProcess requires a non-empty argv')
  const startTime = Date.now()
  const maxBuffer = options.maxBufferChars ?? 1_000_000
  const env = options.env ?? buildSanitizedEnv()

  if (options.abortSignal?.aborted) return { exitCode: -1, cancelled: true, timedOut: false, stdout: '', stderr: '', durationMs: 0, cleanupConfirmed: true }
  return new Promise<ProcessExecResult>((resolve, reject) => {
    let settled = false, closed = false, stopped = false
    let cancelled = false, timedOut = false
    let code = -1, exitSignal: NodeJS.Signals | undefined
    let stdout = '', stderr = '', stdoutOmitted = 0, stderrOmitted = 0
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
    let deadline: ReturnType<typeof setTimeout> | undefined
    let gradient: ReturnType<typeof setTimeout> | undefined
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    let windowsCleaned = false
    const spawnFn = options.spawn ?? spawnHidden
    let child: ReturnType<typeof spawnHidden>
    try {
      child = track(spawnFn(argv[0]!, argv.slice(1), {
        cwd: options.cwd, env,
        stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }))
    } catch (error) { reject(error); return }

    const finish = (cleanupConfirmed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(deadline); clearTimeout(gradient); clearTimeout(cleanupDeadline); clearInterval(poll)
      options.abortSignal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: cancelled || timedOut ? -1 : code,
        ...(exitSignal ? { signal: exitSignal } : {}), timedOut, cancelled, cleanupConfirmed,
        stdout: (stdoutOmitted ? `[早期 stdout 省略 ${stdoutOmitted} 字符]\n` : '') + stdout + stdoutDecoder.end(),
        stderr: (stderrOmitted ? `[早期 stderr 省略 ${stderrOmitted} 字符]\n` : '') + stderr + stderrDecoder.end(),
        durationMs: Date.now() - startTime,
      })
    }
    const treeAlive = () => child.pid ? ownedProcessTreeAlive(child.pid) : false
    const maybeFinish = () => {
      if (!closed) return
      if (process.platform === 'win32' ? (!stopped || windowsCleaned) : !treeAlive()) finish(true)
    }
    const stop = () => {
      if (stopped || settled) return
      stopped = true
      clearTimeout(deadline)
      if (process.platform === 'win32') {
        void killProcessTreeAsync(child).then(result => { windowsCleaned = result === 'exited'; maybeFinish() })
      } else {
        killProcessTree(child, 'SIGTERM')
        gradient = setTimeout(() => { killProcessTree(child, 'SIGKILL'); maybeFinish() }, 3000)
      }
      poll = setInterval(maybeFinish, 50)
      cleanupDeadline = setTimeout(() => {
        maybeFinish()
        if (!settled) { child.stdout?.destroy(); child.stderr?.destroy(); finish(false) }
      }, 8000)
    }
    const onAbort = () => { if (!timedOut) { cancelled = true; stop() } }
    child.stdout?.on('data', (data: Buffer) => {
      if (settled) return
      const text = stdoutDecoder.write(data)
      stdout += text; try { options.onStdout?.(text) } catch (error) { stderr += String(error); stop() }
      if (stdout.length > maxBuffer) { stdoutOmitted += stdout.length - maxBuffer / 2; stdout = stdout.slice(-maxBuffer / 2) }
    })
    child.stderr?.on('data', (data: Buffer) => {
      if (settled) return
      const text = stderrDecoder.write(data)
      stderr += text; try { options.onStderr?.(text) } catch (error) { stderr += String(error); stop() }
      if (stderr.length > maxBuffer) { stderrOmitted += stderr.length - maxBuffer / 2; stderr = stderr.slice(-maxBuffer / 2) }
    })
    child.on('exit', () => {
      // A parent can exit before descendants release inherited pipes.
      if (process.platform !== 'win32' && treeAlive()) stop()
    })
    child.on('close', (exitCode, signal) => {
      closed = true; code = exitCode ?? -1; exitSignal = signal ?? undefined
      maybeFinish()
      if (!settled && !stopped) stop()
    })
    child.on('error', error => {
      stderr += String(error.message)
      if (!child.pid) { closed = true; finish(true) } else stop()
    })
    try { if (child.pid) options.onSpawn?.(child.pid) } catch (error) { stderr += String(error); stop() }
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(options.stdin, 'utf8')
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) deadline = setTimeout(() => { if (!cancelled) { timedOut = true; stop() } }, options.timeoutMs)
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (options.abortSignal?.aborted) onAbort()
  })
}

/** Only probe the group created for this invocation; uncertainty keeps its lease. */
export function ownedProcessTreeAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0)
    if (process.platform !== 'win32') {
      try {
        const states = execFileSync('ps', ['-o', 'stat=', '-g', String(pid)], { encoding: 'utf8', timeout: 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean)
        if (states.length && states.every(state => state.startsWith('Z'))) return false
      } catch { /* The group may still exist; keep its protection on uncertainty. */ }
    }
    return true
  }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
