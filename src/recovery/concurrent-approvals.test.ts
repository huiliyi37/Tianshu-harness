import { it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { runRecoveryCli } from '../recovery-cli.js'
import type { BootstrapContext } from '../bootstrap.js'
import type { AgentCallbacks } from '../agent/loop-types.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Concurrent approvals did not settle within 1000ms')), 1000)
    })])
  } finally { clearTimeout(timer) }
}

function fixture() {
  const input = new PassThrough()
  Object.assign(input, { isTTY: true })
  const firstShown = deferred()
  const secondShown = deferred()
  const approvalsComplete = deferred()
  const teardown = deferred()
  let transcript = ''
  const decisions: { id: string; approved: unknown }[] = []
  const output = { write(chunk: string) {
    transcript += chunk
    const prompts = (transcript.match(/Type \/approve/g) ?? []).length
    if (prompts >= 1) firstShown.resolve()
    if (prompts >= 2) secondShown.resolve()
    return true
  } } as NodeJS.WritableStream
  const ctx = { agent: {
    abort() {},
    async run(_prompt: string, callbacks: AgentCallbacks) {
      const all = Promise.all(['first', 'second'].map(async id => {
        const approved = await callbacks.onApprovalRequired(id, 'read_file', { path: `/external/${id}.txt` })
        decisions.push({ id, approved })
      })).then(() => { approvalsComplete.resolve() })
      // Cleanup can end the fake run independently even if a broken frontend
      // loses an approval resolver. Assertions always run before this release.
      await Promise.race([all, teardown.promise])
    },
  } } as unknown as BootstrapContext
  const running = runRecoveryCli(ctx, { input, output })
  input.write('Read two external files\n')
  return {
    input, firstShown, secondShown, approvalsComplete, decisions, running,
    transcript: () => transcript,
    async close() {
      teardown.resolve()
      input.end()
      await bounded(running)
    },
  }
}

it('serializes concurrent approvals and associates each answer with its displayed request', async () => {
  const f = fixture()
  try {
    await bounded(f.firstShown.promise)
    assert.equal((f.transcript().match(/Type \/approve/g) ?? []).length, 1, 'Only the first request may be displayed before its answer')
    assert.ok(f.transcript().includes('[approval first]'))
    assert.ok(!f.transcript().includes('[approval second]'))
    f.input.write('/approve\n')
    await bounded(f.secondShown.promise)
    assert.deepEqual(f.decisions, [{ id: 'first', approved: true }])
    f.input.write('/reject\n')
    await bounded(f.approvalsComplete.promise)
    assert.deepEqual(f.decisions, [{ id: 'first', approved: true }, { id: 'second', approved: false }])
    f.input.end('/exit\n')
    await bounded(f.running)
  } finally { await f.close() }
})

for (const cancellation of ['/abort', '/exit', 'TTY EOF']) {
  it(`settles both current and queued concurrent approvals on ${cancellation}`, async () => {
    const f = fixture()
    try {
      await bounded(f.firstShown.promise)
      if (cancellation === 'TTY EOF') f.input.end()
      else f.input.write(`${cancellation}\n`)
      await bounded(f.approvalsComplete.promise)
      assert.deepEqual(f.decisions.sort((a, b) => a.id.localeCompare(b.id)), [
        { id: 'first', approved: false },
        { id: 'second', approved: false },
      ])
      assert.ok(!f.transcript().includes('[approval second]'), 'Cancelled queued requests must not be shown as fresh approval prompts')
      if (cancellation === '/abort') f.input.end('/exit\n')
      await bounded(f.running)
    } finally { await f.close() }
  })
}
