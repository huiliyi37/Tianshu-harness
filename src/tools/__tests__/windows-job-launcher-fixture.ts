import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveJobLauncher } from '../process-kill.js'

/** Public source builds omit the shipped native launcher. Exercise the JS job
 * contract against real Win32 Job Objects, without faking process completion.
 * Private/release trees that already provide a launcher keep using the real one. */
export function installWindowsJobLauncherFixture(): () => void {
  if (process.platform !== 'win32' || resolveJobLauncher()) return () => {}
  const previous = process.env.RIVET_JOB_LAUNCHER
  const dir = mkdtempSync(join(tmpdir(), 'rivet-job-launcher-fixture-'))
  const executable = join(dir, 'job-test-launcher.exe')
  const source = fileURLToPath(new URL('./fixtures/windows-job-test-launcher.cs', import.meta.url))
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  try {
    const built = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${executable}`, source], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    })
    if (built.status !== 0) {
      throw new Error(`Cannot build the real Windows Job Object test fixture: ${built.error?.message ?? ''}\n${built.stdout ?? ''}${built.stderr ?? ''}`)
    }
    process.env.RIVET_JOB_LAUNCHER = executable
  } catch (error) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error // A missing compiler or broken fixture is a failure, not a skip.
  }
  return () => {
    if (previous === undefined) delete process.env.RIVET_JOB_LAUNCHER
    else process.env.RIVET_JOB_LAUNCHER = previous
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
