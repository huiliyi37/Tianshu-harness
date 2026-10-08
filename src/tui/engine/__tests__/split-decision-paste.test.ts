import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream } from 'node:tty'
import { InputHandler, type KeyPress } from '../input-handler.js'
import { DecisionController } from '../decision-controller.js'

const sequence = '\x1b[200~1\x1b[201~'
for (let cut = 1; cut < sequence.length; cut++) {
  test(`focused plan never approves pasted numeric text split at ${cut}`, async () => {
    const stdin = Object.assign(new EventEmitter(), { pause() {}, resume() {}, setEncoding() {} }) as unknown as ReadStream
    const input = new InputHandler({ stdin })
    const decisions: unknown[] = [], pasted: string[] = []
    const controller = new DecisionController({ changed: () => input.setEscapeImmediate(controller.focused), reveal() {}, preview() {}, participate() {}, plan: async d => { decisions.push(d); return { ok: true } }, answer: async () => {}, record() {} })
    input.onAnyKey(k => controller.handleKey(k, true, false)); input.onPaste(t => { pasted.push(t); controller.paste(t) })
    try {
      controller.openPlan({ slug: 'fixture', title: 'Fixture', requestId: 'fixture-request' })
      stdin.emit('data', sequence.slice(0, cut)); stdin.emit('data', sequence.slice(cut)); await Promise.resolve()
      assert.deepEqual(decisions, [])
      if (cut !== 1) assert.deepEqual(pasted, ['1'])
    } finally { input.dispose() }
  })
}

test('a focused partial paste timing out cancels focus before late numeric content', async () => {
  const stdin = Object.assign(new EventEmitter(), { pause() {}, resume() {}, setEncoding() {} }) as unknown as ReadStream
  const input = new InputHandler({ stdin, partialSequenceTimeoutMs: 10 }), decisions: unknown[] = []
  const controller = new DecisionController({ changed: () => input.setEscapeImmediate(controller.focused), reveal() {}, preview() {}, participate() {}, plan: async d => { decisions.push(d); return { ok: true } }, answer: async () => {}, record() {} })
  input.onAnyKey(k => controller.handleKey(k, true, false)); input.onPaste(t => controller.paste(t))
  try {
    controller.openPlan({ slug: 'fixture', title: 'Fixture', requestId: 'fixture-request' })
    stdin.emit('data', '\x1b[20'); await delay(25)
    stdin.emit('data', '0~1\x1b[201~'); await Promise.resolve()
    assert.deepEqual(decisions, [])
  } finally { input.dispose() }
})
for (const [first, second, want] of [['\x1b[', 'A', 'up'], ['\x1bO', 'P', 'f1']] as const) {
  test(`focused decisions retain incomplete ${JSON.stringify(first)} navigation`, () => {
    const stdin = Object.assign(new EventEmitter(), { pause() {}, resume() {}, setEncoding() {} }) as unknown as ReadStream
    const input = new InputHandler({ stdin }), keys: KeyPress[] = []
    try { input.setEscapeImmediate(true); input.onAnyKey(k => keys.push(k)); stdin.emit('data', first); stdin.emit('data', second); assert.equal(keys.length, 1); assert.equal(keys[0]?.name, want) }
    finally { input.dispose() }
  })
}
