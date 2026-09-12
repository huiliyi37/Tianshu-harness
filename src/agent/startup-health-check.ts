import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRegistry, EventInput } from './session-registry.js'
import { track } from '../tools/process-tracker.js'

export interface StartupHealthCheckOptions {
  cwd: string
  sessionId: string
  registry: SessionRegistry
  /** Timeout in ms for tsc execution. Default: 15000 */
  timeoutMs?: number
}

export interface TscError {
  file: string
  line: number
  message: string
}

/**
 * Parse tsc --noEmit output into structured errors.
 * Format: "src/foo.ts(42,5): error TS2345: Argument of type..."
 */
export function parseTscOutput(output: string): TscError[] {
  const errors: TscError[] = []
  const lines = output.split('\n')
  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)$/)
    if (match) {
      errors.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        message: match[3]!,
      })
    }
  }
  return errors
}

/**
 * Run tsc --noEmit asynchronously and publish type errors as priority=1 events.
 * Does not block session startup. Silently fails on timeout or missing tsconfig.
 */
export function runStartupHealthCheck(options: StartupHealthCheckOptions): void {
  const { cwd, sessionId, registry, timeoutMs = 15_000 } = options

  // Prefer project-local tsc binary; fall back to npx
  const localTsc = join(cwd, 'node_modules', '.bin', 'tsc')
  const [cmd, args] = existsSync(localTsc)
    ? [localTsc, ['--noEmit', '--pretty', 'false']]
    : ['npx', ['tsc', '--noEmit', '--pretty', 'false']]

  track(execFile(cmd, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024, // 1MB
    windowsHide: true,
  }, (error, stdout, stderr) => {
    // tsc exits with code 2 when there are type errors (stdout contains them)
    const output = stdout || stderr || ''
    if (!output.trim()) return

    const errors = parseTscOutput(output)
    if (errors.length === 0) return

    // Publish up to 10 most relevant type errors as priority=1 events
    const toPublish = errors.slice(0, 10)
    for (const err of toPublish) {
      const event: EventInput = {
        eventType: 'type_error',
        filePath: err.file,
        detail: `Line ${err.line}: ${err.message}`,
        priority: 1,
      }
      try {
        registry.publishEvent(sessionId, event)
      } catch {
        // SQLite might be busy; skip silently
      }
    }
  }))
}
