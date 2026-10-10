import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import type { Interface } from 'node:readline/promises'
import type { BootstrapContext } from '../bootstrap.js'
import { SessionPersist } from '../agent/session-persist.js'
import { checkPlanMode } from '../agent/plan-mode.js'

test('recovery restores the write guard without loading the bootstrap runtime again', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-lightweight-'))
  const relative = '.rivet/plans/draft-review.md'
  await mkdir(join(cwd, '.rivet/plans'), { recursive: true })
  await writeFile(join(cwd, relative), '# Draft\n')
  const persist = new SessionPersist('planning-lightweight', cwd)
  persist.updateMetadata({ planModeState: 'planning', activePlanFilePath: relative })
  await persist.flushSessionBuffer()
  let state: 'off' | 'planning' = 'off'
  let active: string | undefined
  let allowed: boolean | undefined
  const ctx = { cwd, persist, agent: {
    enterPlanMode(options: { planFilePath?: string }) { state = 'planning'; active = options.planFilePath },
    async run() { allowed = checkPlanMode(state, 'write_file', { cwd, targetFilePath: 'src/change.ts', activePlanFilePath: active }).allowed },
  } } as unknown as BootstrapContext
  const lines = ['continue review', '/exit']
  const rl = { question: async () => lines.shift() ?? '/exit', close() {} } as unknown as Interface
  const output = new Writable({ write(_chunk, _encoding, done) { done() } })
  const hooks = registerHooks({ load(url, context, next) {
    if (/\/bootstrap\.(?:ts|js)$/.test(url)) throw new Error('recovery restoration loaded the bootstrap runtime')
    return next(url, context)
  } })
  try {
    const { runRecoveryCli } = await import('../recovery-cli.js')
    await runRecoveryCli(ctx, { rl, output })
    assert.equal(state, 'planning')
    assert.equal(active, relative)
    assert.equal(allowed, false)
  } finally {
    hooks.deregister()
    await persist.flushSessionBuffer()
    await rm(cwd, { recursive: true, force: true })
  }
})
