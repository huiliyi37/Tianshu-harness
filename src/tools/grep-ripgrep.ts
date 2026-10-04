import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { getResolvedEnv } from './resolved-env.js'
import { validatePathSafe } from './path-validate.js'
import { spawnHidden } from './spawn-hidden.js'
import { track } from './process-tracker.js'
import { gracefulKill } from '../platform.js'

const execFileAsync = promisify(execFile)

export interface RipgrepSearchOptions {
  binary: string
  cwd: string
  path: string
  pattern: string
  glob?: string
  literal: boolean
  contextLines: number
  maxResults: number
  timeoutMs: number
  signal?: AbortSignal
}

/** Enumerate names first. Denied files never become content-search arguments. */
export async function searchReadableFilesWithRipgrep(opts: RipgrepSearchOptions): Promise<{ lines: string[]; truncated: boolean }> {
  const deadline = Date.now() + opts.timeoutMs
  opts.signal?.throwIfAborted()
  const isFile = (await stat(opts.path)).isFile()
  let candidates: string[]
  if (isFile) candidates = [opts.path]
  else {
    const args = ['--files', '--null', ...(opts.glob ? ['--glob', opts.glob] : []), '--', opts.path]
    const listing = execFileAsync(opts.binary, args, {
      cwd: opts.cwd, env: getResolvedEnv(opts.cwd), windowsHide: true,
      timeout: Math.max(1, deadline - Date.now()), maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', signal: opts.signal,
    })
    track(listing.child)
    try { candidates = (await listing).stdout.split('\0').filter(Boolean) }
    catch (error) {
      if ((error as { code?: unknown }).code === 1) candidates = []
      else throw error
    }
  }

  // Keep argv below Windows' command-line limit without launching one search
  // process per file. Chunking also preserves a single global result ceiling.
  const chunks: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (let i = 0; i < candidates.length; i++) {
    if (i % 256 === 0) {
      await setImmediate()
      opts.signal?.throwIfAborted()
      if (Date.now() >= deadline) throw new Error('ripgrep file validation timed out')
    }
    const file = candidates[i]!
    if (!validatePathSafe(opts.cwd, file).ok) continue
    const cost = Buffer.byteLength(file, 'utf8') * 2 + 4
    if (current.length > 0 && bytes + cost > 12_000) {
      chunks.push(current); current = []; bytes = 0
    }
    current.push(file); bytes += cost
  }
  if (current.length > 0) chunks.push(current)

  const lines: string[] = []
  let truncated = false
  for (const files of chunks) {
    opts.signal?.throwIfAborted()
    const remaining = opts.maxResults - lines.length
    if (remaining <= 0) { truncated = true; break }
    const budget = deadline - Date.now()
    if (budget <= 0) throw new Error('ripgrep search timed out')
    const result = await searchChunk(opts, files, remaining, budget, !isFile)
    lines.push(...result.lines)
    if (result.truncated || lines.length >= opts.maxResults) { truncated = true; break }
  }
  return { lines: lines.slice(0, opts.maxResults), truncated }
}

function searchChunk(opts: RipgrepSearchOptions, files: string[], remaining: number, budget: number, withFileName: boolean): Promise<{ lines: string[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const args = ['--no-heading', '--line-number', '--max-count', String(remaining), '--color', 'never',
      withFileName ? '--with-filename' : '--no-filename',
      ...(opts.literal ? ['--fixed-strings'] : []),
      ...(opts.contextLines > 0 ? ['--context', String(opts.contextLines)] : []), '--', opts.pattern, ...files]
    const child = track(spawnHidden(opts.binary, args, { cwd: opts.cwd, env: getResolvedEnv(opts.cwd), stdio: ['ignore', 'pipe', 'pipe'] }))
    let output = ''
    let truncated = false
    const timer = setTimeout(() => { gracefulKill(child); reject(new Error('ripgrep search timed out')) }, budget)
    const onAbort = () => { gracefulKill(child); reject(opts.signal?.reason ?? new Error('ripgrep aborted')) }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (data: string) => {
      output += data
      const completeLines = output.split('\n').length - 1
      if (completeLines >= remaining || output.length > 200_000) {
        truncated = true; gracefulKill(child)
      }
    })
    child.stderr!.resume()
    const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort) }
    child.on('error', error => { cleanup(); reject(error) })
    child.on('close', code => {
      cleanup()
      if (!truncated && code !== 0 && code !== 1) { reject(new Error(`ripgrep exited with ${code}`)); return }
      resolve({ lines: output.split('\n').filter(Boolean).slice(0, remaining), truncated })
    })
  })
}
