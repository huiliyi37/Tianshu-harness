import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface InjectedWorktreeContext {
  cwd?: string
  branch?: string
  head?: string
  isGitRepo?: boolean
}

export interface WorktreeReality {
  cwd: string
  isGitRepo: boolean
  repoRoot?: string
  branch?: string
  head?: string
  statusAvailable: boolean
  injectedContextMatchesReality: boolean
  mismatchReasons: string[]
  severity: 'green' | 'yellow' | 'red'
}

async function gitExec(args: string[], cwd: string, timeoutMs = 5000): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function detectWorktreeReality(
  cwd: string,
  injected?: InjectedWorktreeContext,
): Promise<WorktreeReality> {
  // ── 1. CWD 存在性检查 ──
  if (!existsSync(cwd)) {
    return {
      cwd,
      isGitRepo: false,
      statusAvailable: false,
      injectedContextMatchesReality: false,
      mismatchReasons: [`cwd does not exist: ${cwd}`],
      severity: 'red',
    }
  }

  // ── 2. Git 仓库检测 ──
  const repoRoot = await gitExec(['rev-parse', '--show-toplevel'], cwd)
  if (!repoRoot) {
    const isGitRepoMismatch = injected?.isGitRepo === true
    return {
      cwd,
      isGitRepo: false,
      statusAvailable: false,
      injectedContextMatchesReality: !isGitRepoMismatch,
      mismatchReasons: isGitRepoMismatch
        ? ['injected context says isGitRepo=true but directory is not a git repo']
        : [],
      severity: isGitRepoMismatch ? 'red' : 'green',
    }
  }

  // ── 3. 采集实际状态 ──
  const branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  const head = await gitExec(['rev-parse', 'HEAD'], cwd)

  // ── 4. 无注入上下文 → 直接返回 green ──
  if (!injected) {
    return {
      cwd,
      isGitRepo: true,
      repoRoot,
      branch: branch || undefined,
      head: head || undefined,
      statusAvailable: true,
      injectedContextMatchesReality: true,
      mismatchReasons: [],
      severity: 'green',
    }
  }

  // ── 5. 注入上下文 vs 实际逐字段比较 ──
  const mismatchReasons: string[] = []

  // HEAD 不匹配
  if (injected.head && head && injected.head !== head) {
    mismatchReasons.push(`HEAD mismatch: injected=${injected.head}, actual=${head}`)
  }

  // Branch 不匹配
  if (injected.branch && branch && injected.branch !== branch) {
    mismatchReasons.push(`branch mismatch: injected=${injected.branch}, actual=${branch}`)
  }

  // CWD 不匹配（resolve 到绝对路径再比较）
  if (injected.cwd) {
    const resolvedInjected = resolve(injected.cwd)
    const resolvedActual = resolve(cwd)
    if (resolvedInjected !== resolvedActual) {
      mismatchReasons.push(`cwd mismatch: injected=${resolvedInjected}, actual=${resolvedActual}`)
    }
  }

  // isGitRepo 反向不匹配（注入=false，实际=true）
  if (injected.isGitRepo === false) {
    mismatchReasons.push('injected context says isGitRepo=false but directory is a git repo')
  }

  // ── 6. Severity 判定 ──
  // HEAD 不匹配 → red；其他不匹配 → yellow；无不匹配 → green
  const hasHeadMismatch = mismatchReasons.some(r => r.startsWith('HEAD mismatch'))
  let severity: 'green' | 'yellow' | 'red' = 'green'
  if (hasHeadMismatch) {
    severity = 'red'
  } else if (mismatchReasons.length > 0) {
    severity = 'yellow'
  }

  return {
    cwd,
    isGitRepo: true,
    repoRoot,
    branch: branch || undefined,
    head: head || undefined,
    statusAvailable: true,
    injectedContextMatchesReality: mismatchReasons.length === 0,
    mismatchReasons,
    severity,
  }
}
