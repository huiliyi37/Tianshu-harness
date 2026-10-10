import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL, isLongRunner } from '../bash.js'
import type { JobRegistry, JobSnapshot, JobSpawnOptions } from '../job-store.js'

describe('isLongRunner', () => {
  it('classifies known long-running / non-terminating commands', () => {
    for (const cmd of [
      'npm install',
      'npm i',
      'pnpm install',
      'yarn add react',
      'npm run dev',
      'pnpm dev',
      'vite',
      'next dev',
      'nodemon server.js',
      'tsc --watch',
      'docker compose up',
    ]) {
      assert.equal(isLongRunner(cmd), true, `expected long-runner: ${cmd}`)
    }
  })

  it('does NOT auto-background result-dependent commands', () => {
    for (const cmd of [
      'npm run build',
      'npm test',
      'ls -la',
      'git status',
      'cat package.json',
      'echo hi',
    ]) {
      assert.equal(isLongRunner(cmd), false, `should not be long-runner: ${cmd}`)
    }
  })
})

/** Minimal in-memory JobRegistry stub recording spawn calls. */
function stubJobs(): JobRegistry & { spawned: JobSpawnOptions[] } {
  const spawned: JobSpawnOptions[] = []
  return {
    spawned,
    spawn(opts: JobSpawnOptions): JobSnapshot {
      spawned.push(opts)
      return {
        id: 'stub123',
        command: opts.rawCommand,
        status: 'running',
        startedAt: Date.now(),
        lastLine: '',
      }
    },
    await: async () => null,
    list: () => [],
    logs: () => null,
    kill: () => false,
    recordVerificationMeta: () => {},
  }
}

describe('BASH_TOOL background branch', () => {
  it('run_in_background=true spawns via the registry and returns immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-bg-'))
    try {
      const jobs = stubJobs()
      const res = await BASH_TOOL.execute({
        input: { command: 'echo hi', run_in_background: true },
        toolUseId: 'bg-test',
        cwd: dir,
        jobs,
      })
      assert.equal(jobs.spawned.length, 1)
      assert.equal(res.isError, false)
      assert.match(res.content, /\[job:stub123\]/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('auto-detects long-runners and backgrounds them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-bg-'))
    try {
      const jobs = stubJobs()
      const res = await BASH_TOOL.execute({
        input: { command: 'npm run dev' },
        toolUseId: 'bg-auto-test',
        cwd: dir,
        jobs,
      })
      assert.equal(jobs.spawned.length, 1)
      assert.match(res.content, /后台/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('run_in_background=false forces foreground even for a long-runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-bg-'))
    try {
      const jobs = stubJobs()
      // Use a fast command that merely matches a long-runner shape loosely; here
      // an explicit false must keep it foreground → registry never used.
      const res = await BASH_TOOL.execute({
        input: { command: 'echo hi', run_in_background: false },
        toolUseId: 'bg-false-test',
        cwd: dir,
        jobs,
      })
      assert.equal(jobs.spawned.length, 0)
      assert.match(res.content, /hi/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to foreground when no job registry is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-bg-'))
    try {
      const res = await BASH_TOOL.execute({
        input: { command: 'echo hi', run_in_background: true },
        toolUseId: 'bg-degrade-test',
        cwd: dir,
      })
      // No jobs handle → runs in foreground, returns real output.
      assert.match(res.content, /hi/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

it('spawn forwards raw explicit timeout presence to private verification waiting metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-budget-'))
  try {
    for (const extra of [{}, { timeout: 30000 }, { timeout: 120000 }]) {
      const jobs = stubJobs()
      let seen: Record<string, unknown> | undefined
      jobs.recordVerificationMeta = (_id, _meta, input) => { seen = input }
      const input = { command: 'node --test a.test.ts', run_in_background: true, ...extra }
      await BASH_TOOL.execute({ input, toolUseId: 'private-budget', cwd: dir, jobs })
      assert.equal(seen, input)
      assert.equal(Object.hasOwn(seen!, 'timeout'), Object.hasOwn(extra, 'timeout'))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
