import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { RecoveryCommands } from './commands.js'
import { writePlan, readPlan } from '../plan/plan-store.js'
import { runRecoveryCli } from '../recovery-cli.js'
import type { BootstrapContext } from '../bootstrap.js'
import type { Interface } from 'node:readline/promises'

async function fixture(lines: string[], content: string, option?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-plan-'))
  await writePlan(cwd, 'review', content, option ? [{ label: 'Safe option', description: 'Make a reversible change' }, { label: 'Other option', description: 'Alternative' }] : undefined)
  const calls: { prompt: string; origin?: string }[] = []
  const pointers: unknown[] = []
  const ctx = { cwd, agent: {
    run: async (prompt: string, _callbacks: unknown, _images: unknown, options?: { origin: string }) => { calls.push({ prompt, origin: options?.origin }) },
    setActivePlan: (plan: unknown) => { pointers.push(plan) },
    enterPlanMode() {},
  } } as unknown as BootstrapContext
  let text = ''
  const output = { write(chunk: string) { text += chunk; return true } } as NodeJS.WritableStream
  const rl = { question: async () => lines.shift() ?? '/exit', close() {} } as unknown as Interface
  try { await runRecoveryCli(ctx, { rl, output }); return { calls, pointers, text, plan: await readPlan(cwd, 'review') } }
  finally { await rm(cwd, { recursive: true, force: true }) }
}

it('marks a real submitted plan approved and starts execution as a runtime command', async () => {
  const result = await fixture(['/plan-view review', '/plan-approve review Safe option', '/exit'], '# Review\n\nImplement a reversible parser change and validate the existing parser regressions.\n', 'options')
  assert.equal(result.plan?.status, 'approved')
  assert.deepEqual(result.pointers, [{ slug: 'review', title: 'Review', selectedApproach: 'Safe option' }])
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0]?.origin, 'runtime_command')
  assert.ok(result.calls[0]?.prompt.includes('Selected approach: Safe option'))
})

it('keeps invalid or unknown-option plans submitted and never executes them', async () => {
  const invalid = await fixture(['/plan-approve review', '/exit'], '')
  assert.equal(invalid.plan?.status, 'submitted')
  assert.equal(invalid.calls.length, 0)
  const unknown = await fixture(['/plan-approve review nonexistent', '/exit'], '# Review\n\nImplement and validate the parser change.\n', 'options')
  assert.equal(unknown.plan?.status, 'submitted')
  assert.equal(unknown.calls.length, 0)
})

it('rejects a real plan while preserving its document and avoiding kickoff', async () => {
  const result = await fixture(['/plan-list', '/plan-reject review', '/exit'], '# Review\n\nImplement and validate the parser change.\n')
  assert.equal(result.plan?.status, 'rejected')
  assert.ok(result.plan?.content.includes('Implement and validate'))
  assert.equal(result.calls.length, 0)
})

for (const cancellation of ['eof', '/exit', '/abort']) {
  it(`cancels an awaiting real plan approval on ${cancellation} before marking or kickoff`, async t => {
    const { PassThrough } = await import('node:stream')
    const cwd = await mkdtemp(join(tmpdir(), 'recovery-cancel-'))
    await writePlan(cwd, 'review', '# Review\n\nImplement and validate a reversible parser change.\n')
    const input = new PassThrough()
    Object.assign(input, { isTTY: true })
    const calls: string[] = []
    const pointers: unknown[] = []
    const ctx = { cwd, agent: {
      run: async (prompt: string) => { calls.push(prompt) },
      setActivePlan: (plan: unknown) => { pointers.push(plan) },
    } } as unknown as BootstrapContext
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const original = RecoveryCommands.prototype.handle
    t.mock.method(RecoveryCommands.prototype, 'handle', async function (this: RecoveryCommands, line: string) {
      if (line.startsWith('/plan-approve')) { entered(); await gate }
      return original.call(this, line)
    })
    const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const running = runRecoveryCli(ctx, { input, output })
    try {
      input.write('/plan-approve review\n')
      await started
      if (cancellation === 'eof') input.end()
      else input.write(`${cancellation}\n`)
      await new Promise(resolve => setImmediate(resolve))
      release()
      if (cancellation === '/abort') {
        await new Promise(resolve => setImmediate(resolve))
        input.end('/exit\n')
      }
      await running
      assert.equal((await readPlan(cwd, 'review'))?.status, 'submitted')
      assert.deepEqual(calls, [])
      assert.deepEqual(pointers, [])
    } finally {
      release()
      input.end()
      await running
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

it('does not activate or return kickoff if cancellation arrives after the approval was written', async () => {
  const { RecoveryOutput } = await import('./output.js')
  const { readPlanSync } = await import('../plan/plan-store.js')
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-late-cancel-'))
  await writePlan(cwd, 'review', '# Review\n\nImplement and validate a reversible parser change.\n')
  const pointers: unknown[] = []
  const ctx = { cwd, agent: { setActivePlan: (plan: unknown) => { pointers.push(plan) } } } as unknown as BootstrapContext
  const output = new RecoveryOutput(new Writable({ write(_chunk, _encoding, callback) { callback() } }))
  const commands = new RecoveryCommands(ctx, output, () => readPlanSync(cwd, 'review')?.status !== 'approved')
  try {
    const result = await commands.handle('/plan-approve review')
    assert.equal((await readPlan(cwd, 'review'))?.status, 'approved')
    assert.deepEqual(pointers, [])
    assert.equal(result.prompt, undefined)
  } finally { output.close(); await rm(cwd, { recursive: true, force: true }) }
})

it('does not approve a queued command after its PTY disconnects before the command starts', async () => {
  const { PassThrough } = await import('node:stream')
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-early-eof-'))
  await writePlan(cwd, 'review', '# Review\n\nImplement and validate a reversible parser change.\n')
  const input = new PassThrough()
  Object.assign(input, { isTTY: true })
  const calls: string[] = []
  const ctx = { cwd, agent: { run: async (prompt: string) => { calls.push(prompt) }, setActivePlan() {} } } as unknown as BootstrapContext
  const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  try {
    const running = runRecoveryCli(ctx, { input, output })
    input.end('/plan-approve review\n')
    await running
    assert.equal((await readPlan(cwd, 'review'))?.status, 'submitted')
    assert.deepEqual(calls, [])
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
