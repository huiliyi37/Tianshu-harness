import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

export type TerminalMode = 'auto' | 'native' | 'captured-pty'
export interface TerminalProfile {
  kind: 'native' | 'captured-pty'
  /** Stable explanation code; never contains process arguments or environment values. */
  reason: string
}

/** Only the current process's ordered ancestor chain, never a machine-wide process list. */
export interface TerminalAncestor {
  name: string
  commandLine?: string
  visibleAttach?: boolean
  windowsTerminalCandidate?: boolean
  muxServer?: boolean
  muxAttach?: boolean
}

export interface TerminalProfileOptions {
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  ancestors?: readonly TerminalAncestor[]
}

export interface DetectTerminalProfileOptions extends TerminalProfileOptions {
  pid?: number
  timeoutMs?: number
  probeAncestors?: (pid: number, timeoutMs: number) => Promise<readonly TerminalAncestor[]>
}

const MAX_DEPTH = 16
const MAX_COMMAND_CHARS = 4096
const MAX_PROBE_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 1500
let activeProfile: TerminalProfile | undefined

function parseMode(value: string | undefined): TerminalMode {
  if (value === 'auto' || value === 'native' || value === 'captured-pty') return value
  throw new Error('Invalid terminal mode; use auto, native, or captured-pty.')
}

function requestedMode(args: readonly string[], env: NodeJS.ProcessEnv): { mode: TerminalMode; source: string } {
  let cliMode: TerminalMode | undefined
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i]!
    if (arg === '--terminal-mode') cliMode = parseMode(args[++i])
    else if (arg.startsWith('--terminal-mode=')) cliMode = parseMode(arg.slice('--terminal-mode='.length))
  }
  if (cliMode !== undefined) return { mode: cliMode, source: 'cli' }
  if (env.RIVET_TERMINAL_MODE !== undefined) return { mode: parseMode(env.RIVET_TERMINAL_MODE), source: 'env' }
  return { mode: 'auto', source: 'default' }
}

function explicitProfile(options: TerminalProfileOptions): TerminalProfile | undefined {
  const env = options.env ?? process.env
  const { mode, source } = requestedMode(options.args ?? [], env)
  if (mode !== 'auto') return { kind: mode, reason: `${source}-${mode}` }
  if (env.RIVET_CAPTURED_PTY === '1') return { kind: 'captured-pty', reason: 'host-marker' }
  if (env.RIVET_CAPTURED_PTY === '0') return { kind: 'native', reason: 'host-marker-opt-out' }
  return undefined
}

function ancestorEvidence(ancestor: TerminalAncestor): { bridge: boolean; mux: boolean } {
  if (ancestor.commandLine === undefined) return {
    bridge: ancestor.visibleAttach === true && ancestor.windowsTerminalCandidate === true,
    mux: ancestor.muxServer === true || ancestor.muxAttach === true,
  }
  const command = ancestor.commandLine
  if (command.length > MAX_COMMAND_CHARS) return { bridge: false, mux: false }
  const argv = Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), m => m[1] ?? m[2] ?? m[3]!)
  if (!argv.length || win32.basename(argv[0]!).toLowerCase() !== ancestor.name.toLowerCase()) return { bridge: false, mux: false }
  const valueAfter = (flag: string) => {
    const index = argv.indexOf(flag, 1)
    return index < 0 ? undefined : argv[index + 1]
  }
  const session = valueAfter(argv[1] === 'server' ? '-s' : '-t')
  return {
    bridge: argv.slice(1).includes('--visible-attach') && valueAfter('--candidate-type') === 'windows-terminal',
    mux: (argv[1] === 'server' || argv[1] === 'attach') && !!session && !session.startsWith('-'),
  }
}

/** ConPTY, WT_SESSION, SSH, tmux, dimensions and --headless alone are never capture evidence. */
export function resolveTerminalProfile(options: TerminalProfileOptions = {}): TerminalProfile {
  const explicit = explicitProfile(options)
  if (explicit) return explicit
  if ((options.platform ?? process.platform) === 'win32') {
    const bridges = new Set<string>()
    const muxes = new Set<string>()
    for (const ancestor of (options.ancestors ?? []).slice(0, MAX_DEPTH)) {
      const evidence = ancestorEvidence(ancestor)
      const name = ancestor.name.toLowerCase()
      if (evidence.bridge) bridges.add(name)
      if (evidence.mux) muxes.add(name)
    }
    if ([...bridges].some(bridge => [...muxes].some(mux => bridge !== mux))) return { kind: 'captured-pty', reason: 'windows-captured-host-chain' }
  }
  return { kind: 'native', reason: 'default-native' }
}

/** One startup snapshot. Independent env objects remain pure and bypass this snapshot. */
export function setActiveTerminalProfile(profile?: TerminalProfile): void {
  activeProfile = profile ? { ...profile } : undefined
}

export function isCapturedPty(env?: NodeJS.ProcessEnv): boolean {
  return ((env === undefined || env === process.env) && activeProfile ? activeProfile : resolveTerminalProfile({ env: env ?? process.env })).kind === 'captured-pty'
}

function boundedTimeout(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

/** Best effort: unavailable CIM / access denied / exited parents preserve native behavior. */
export async function detectTerminalProfile(options: DetectTerminalProfileOptions = {}): Promise<TerminalProfile> {
  const resolved = resolveTerminalProfile(options)
  if (explicitProfile(options) || options.ancestors !== undefined || (options.platform ?? process.platform) !== 'win32') return resolved
  const pid = options.pid ?? process.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) return resolved
  const timeoutMs = boundedTimeout(options.timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ancestors = await Promise.race([
      (options.probeAncestors ?? probeWindowsTerminalAncestors)(pid, timeoutMs),
      new Promise<readonly TerminalAncestor[]>(resolve => { timer = setTimeout(() => resolve([]), timeoutMs) }),
    ])
    return resolveTerminalProfile({ ...options, ancestors })
  } catch {
    return resolved
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Read only, filtered by PID. CommandLine is reduced to booleans inside PowerShell. */
export async function probeWindowsTerminalAncestors(pid: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<readonly TerminalAncestor[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return []
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @()
$seen = @{}
$currentId = ${pid}
$born = $null
for ($depth = 0; $depth -lt ${MAX_DEPTH + 1} -and $currentId -gt 0; $depth++) {
  if ($seen.ContainsKey($currentId)) { break }
  $seen[$currentId] = $true
  try { $row = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction Stop } catch { break }
  if ($null -eq $row) { break }
  if ($null -ne $born -and $row.CreationDate -gt $born) { break }
  if ($depth -gt 0) {
    $argv = @()
    if ($row.CommandLine.Length -le ${MAX_COMMAND_CHARS}) {
      $argv = @([regex]::Matches([string]$row.CommandLine, '"([^"]*)"|''([^'']*)''|(\S+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } elseif ($_.Groups[2].Success) { $_.Groups[2].Value } else { $_.Groups[3].Value }
      })
    }
    $bridge = $false
    $muxServer = $false
    $muxAttach = $false
    if ($argv.Count -gt 1 -and [System.IO.Path]::GetFileName($argv[0]) -ieq $row.Name) {
      $candidate = [Array]::IndexOf($argv, '--candidate-type')
      $bridge = ($argv -ccontains '--visible-attach') -and $candidate -gt 0 -and $candidate + 1 -lt $argv.Count -and $argv[$candidate + 1] -ceq 'windows-terminal'
      $sessionFlag = if ($argv[1] -ceq 'server') { '-s' } else { '-t' }
      $session = [Array]::IndexOf($argv, $sessionFlag)
      $hasSession = $session -gt 1 -and $session + 1 -lt $argv.Count -and $argv[$session + 1].Length -gt 0 -and !$argv[$session + 1].StartsWith('-')
      $muxServer = $argv[1] -ceq 'server' -and $hasSession
      $muxAttach = $argv[1] -ceq 'attach' -and $hasSession
    }
    $rows += @{ name = [string]$row.Name; visibleAttach = $bridge; windowsTerminalCandidate = $bridge; muxServer = $muxServer; muxAttach = $muxAttach }
  }
  $born = $row.CreationDate
  $currentId = [int]$row.ParentProcessId
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, timeout: boundedTimeout(timeoutMs), maxBuffer: MAX_PROBE_BYTES, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { resolve([]); return }
      try {
        const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
        if (!Array.isArray(rows)) { resolve([]); return }
        resolve(rows.slice(0, MAX_DEPTH).filter((row): row is TerminalAncestor =>
          !!row && typeof row === 'object' && typeof row.name === 'string' && row.name.length <= 260)
          .map(row => ({ name: row.name, visibleAttach: row.visibleAttach === true, windowsTerminalCandidate: row.windowsTerminalCandidate === true, muxServer: row.muxServer === true, muxAttach: row.muxAttach === true })))
      } catch { resolve([]) }
    })
  })
}
