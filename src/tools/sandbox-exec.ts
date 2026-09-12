/**
 * Sandbox executor: run JS code in isolated Node.js child process.
 * Only stdout is returned to context; stderr is for diagnostics.
 *
 * Design: docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md
 */

import { execFile } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { track } from './process-tracker.js'

export interface SandboxOptions {
  timeoutMs?: number
  maxOutputChars?: number
  cwd?: string
}

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Execute JS code in an isolated sandbox (child process).
 * Environment is stripped; output is truncated to protect context budget.
 */
export async function sandboxExec(
  code: string,
  opts: SandboxOptions = {},
): Promise<SandboxResult> {
  const { timeoutMs = 10_000, maxOutputChars = 8000, cwd = process.cwd() } = opts

  const scriptId = randomUUID().slice(0, 8)
  const scriptPath = join(tmpdir(), `rivet-sandbox-${scriptId}.cjs`)

  // Wrap code in try-catch, strip env, suppress stderr noise
  const wrapper = [
    '"use strict";',
    'const __origEnv = process.env;',
    'process.env = Object.create(null);',
    'process.env.PWD = __origEnv.PWD;',
    'process.env.HOME = __origEnv.HOME;',
    'process.env.PATH = __origEnv.PATH;',
    'process.env.NODE_ENV = __origEnv.NODE_ENV;',
    'try {',
    code,
    '} catch(e) {',
    '  process.stderr.write(String(e.stack || e.message || e));',
    '  process.exit(1);',
    '}',
  ].join('\n')

  await writeFile(scriptPath, wrapper, 'utf-8')

  return new Promise<SandboxResult>((resolve) => {
    const child = track(execFile('node', [scriptPath], {
      timeout: timeoutMs,
      maxBuffer: maxOutputChars * 2,
      cwd,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        PWD: cwd,
        NODE_ENV: 'sandbox',
      },
    }, (error, stdout, stderr) => {
      // Cleanup temp file
      unlink(scriptPath).catch(() => {})

      let exitCode = 0
      if (error) {
        exitCode = error.killed ? 124 : 1
        if (error.killed) {
          stderr = (stderr || '') + `\n[timeout: execution exceeded ${timeoutMs}ms]`
        }
      }

      let finalStdout = stdout || ''
      if (finalStdout.length > maxOutputChars) {
        finalStdout = finalStdout.slice(0, maxOutputChars) + `\n[output truncated at ${maxOutputChars} chars]`
      }

      resolve({ stdout: finalStdout, stderr: stderr || '', exitCode })
    }))
  })
}
