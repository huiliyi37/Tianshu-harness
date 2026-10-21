/**
 * Python 解释器探测（issue #523 WP1）。
 *
 * 候选顺序与 env-check.ts 的 detectEnv 一致（win32: python → py → python3；
 * 其余平台: python3 → python）。显式路径优先：RIVET_PYTHON_PATH 环境变量
 * （OS 级显式覆盖恒赢，同 RIVET_GIT_PATH 惯例）> options.explicitPath
 * （调用方从 config env.pythonPath 读入）。Windows 商店占位 python.exe
 * （执行失败且输出指向 Microsoft Store）跳过继续探测。
 *
 * 子进程一律 execFile（无 shell）带超时；执行函数可注入以便测试。
 * WP2 会抽通用执行器，此处保持直接。
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { getInstallCommand, which as whichOnPath } from '../../tools/env-check.js'

export interface PythonExecOutput { ok: boolean; stdout: string; stderr: string }
export type PythonExec = (command: string, args: string[]) => Promise<PythonExecOutput>

export interface DetectPythonOptions {
  /** 显式解释器路径（config env.pythonPath）。RIVET_PYTHON_PATH env 优先于它。 */
  explicitPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  which?: (command: string) => Promise<string | undefined>
  exec?: PythonExec
  realpath?: (path: string) => string
}

export interface PythonInterpreter {
  found: true
  path: string
  realPath: string
  /** 规范化版本号，如 "3.12.4"。 */
  version: string
  /** ABI 标识，如 "cpython-312"。 */
  abi?: string
  venvOk: boolean
  pipOk: boolean
}

export type PythonProbeResult =
  | PythonInterpreter
  | { found: false; code: 'interpreter_missing'; guidance: string }

const PROBE_TIMEOUT_MS = 5000
/** 取版本与 ABI 标识的内联探针（单行 JSON 输出）。 */
const ABI_PROBE = `import sys,json;print(json.dumps({'version':list(sys.version_info[:3]),'implementation':sys.implementation.name,'abi':getattr(sys,'abiflags','')}))`

function defaultExec(env?: NodeJS.ProcessEnv): PythonExec {
  return (command, args) => new Promise(resolve => {
    try {
      execFile(command, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, env: env ?? process.env }, (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        resolve({ ok: !error, stdout: out, stderr: err || (error ? String(error.message ?? error) : '') })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: String(error) })
    }
  })
}

/** Windows 商店占位 python.exe：执行失败并把用户引向 Microsoft Store。 */
function isStoreStub(output: PythonExecOutput): boolean {
  return !output.ok && /microsoft store/i.test(output.stdout + output.stderr)
}

function parseVersion(text: string): [number, number, number] | undefined {
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!
  return 0
}

/**
 * requires 版本区间匹配：逗号分隔的 >=,>,<=,<,==,!= 约束组合（首版不支持
 * 通配符与 ~= 兼容 release）。约束本身无法解析时判不满足并给出原因——
 * 声明里的坏约束不应静默放行。
 */
export function matchesPythonRequirement(version: string, requires: string): { ok: boolean; reason?: string } {
  const parsed = parseVersion(version)
  if (!parsed) return { ok: false, reason: `无法解析解释器版本: ${version}` }
  for (const raw of requires.split(',')) {
    const constraint = raw.trim()
    if (!constraint) continue
    const match = constraint.match(/^(>=|<=|==|!=|>|<)\s*(\S+)$/)
    const target = match ? parseVersion(match[2]!) : undefined
    if (!match || !target) return { ok: false, reason: `不支持的版本约束: ${constraint}（仅支持 >=,>,<=,<,==,!= 逗号组合）` }
    const cmp = compareVersion(parsed, target)
    const op = match![1]!
    const ok = op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : op === '==' ? cmp === 0 : cmp !== 0
    if (!ok) return { ok: false, reason: `Python ${version} 不满足约束 ${constraint}` }
  }
  return { ok: true }
}

async function probeInterpreter(path: string, runPython: PythonExec, realpath: (p: string) => string): Promise<PythonInterpreter | undefined> {
  const versionOut = await runPython(path, ['--version'])
  if (!versionOut.ok || isStoreStub(versionOut)) return undefined
  // Python ≥3.4 打 stdout，更老的打 stderr——两边都试。
  let version = parseVersion(versionOut.stdout)?.join('.') ?? parseVersion(versionOut.stderr)?.join('.')
  if (!version) return undefined
  let abi: string | undefined
  const abiOut = await runPython(path, ['-c', ABI_PROBE])
  if (abiOut.ok) {
    try {
      const info = JSON.parse(abiOut.stdout.trim()) as { version?: number[]; implementation?: string; abi?: string }
      if (Array.isArray(info.version) && info.version.length === 3) version = info.version.join('.')
      if (info.implementation && info.version) abi = `${info.implementation}-${info.version[0]}${info.version[1]}${info.abi ?? ''}`
    } catch { /* ABI 标识是诊断信息，解析失败不否决解释器 */ }
  }
  let realPath = path
  try { realPath = realpath(path) } catch { /* 保留 which 给出的路径 */ }
  const venv = await runPython(path, ['-m', 'venv', '--help'])
  const pip = await runPython(path, ['-m', 'pip', '--version'])
  return { found: true, path, realPath, version, ...(abi ? { abi } : {}), venvOk: venv.ok, pipOk: pip.ok }
}

export async function detectPythonInterpreter(options: DetectPythonOptions = {}): Promise<PythonProbeResult> {
  const platform = options.platform ?? process.platform
  const runPython = options.exec ?? defaultExec(options.env)
  const which = options.which ?? (command => whichOnPath(command, options.env))
  const realpath = options.realpath ?? (path => realpathSync(path))
  const guidance = getInstallCommand('python', platform)
  // OS 环境变量恒赢（同 RIVET_GIT_PATH 惯例），其次是 config 显式路径。
  // 读 options.env 而非 process.env：本函数其余探测（which / exec）都走
  // options.env，显式路径却读全局会让传了 env 的调用方无法隔离该变量。
  const env = options.env ?? process.env
  const explicit = env['RIVET_PYTHON_PATH'] || options.explicitPath
  if (explicit) {
    const probed = await probeInterpreter(explicit, runPython, realpath)
    if (probed) return probed
    return { found: false, code: 'interpreter_missing', guidance: `配置的 Python 解释器不可用: ${explicit}\n${guidance}` }
  }
  const candidates = platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  for (const command of candidates) {
    const path = await which(command)
    if (!path) continue
    const probed = await probeInterpreter(path, runPython, realpath)
    if (probed) return probed
  }
  return { found: false, code: 'interpreter_missing', guidance }
}
