import { execFileGit } from '../tools/spawn-git.js'
import type { BaselineSnapshot } from './worktree-baseline.js'

/** All commands share one deadline; an incomplete baseline owns no old files. */
export async function captureGitBaselineAsync(cwd: string, signal?: AbortSignal): Promise<BaselineSnapshot> {
  const deadline = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    let outcome: { error: Error | null; stdout: string } | undefined
    let closed = false
    const settle = () => {
      if (closed && outcome) outcome.error ? reject(outcome.error) : resolve(outcome.stdout)
    }
    const child = execFileGit(['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', signal: deadline, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => { outcome = { error, stdout: String(stdout).trim() }; settle() })
    // An abort invokes execFile's callback before the child actually closes.
    child.once('close', () => { closed = true; settle() })
  })
  const probes = [
      run(['rev-parse', '--abbrev-ref', 'HEAD']), run(['rev-parse', 'HEAD']),
      run(['diff', '--name-only']), run(['ls-files', '--others', '--exclude-standard']),
  ] as const
  try {
    const [branch, head, dirty, untracked] = await Promise.all(probes)
    return { branch, head, preExistingDirty: dirty ? dirty.split(/\r?\n/) : [],
      preExistingUntracked: untracked ? untracked.split(/\r?\n/) : [], capturedAt: Date.now(), complete: true }
  } catch {
    await Promise.allSettled(probes)
    signal?.throwIfAborted()
    return { branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now(), complete: false }
  }
}
