import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './_harness.js'
import type { TuiApp } from '../app.js'

function key(app: TuiApp, name: string, char = '') {
  return (app as unknown as { handleOverlayKey(key: unknown): boolean }).handleOverlayKey({ name, char })
}

test('ledger connection masks typed credentials, saves once and clears the buffer before callback', () => {
  const { app, out } = makeApp()
  app.registerOverlays({})
  const calls: string[] = []
  const method = (app as unknown as { startTokenLedgerConnect?: (save: (key: string) => void) => void }).startTokenLedgerConnect
  try {
    assert.equal(typeof method, 'function', 'native TUI must offer a dedicated masked ledger input')
    method!.call(app, candidate => {
      assert.equal(app.getTokenLedgerConnectData().input, '')
      calls.push(candidate)
    })
    for (const char of 'tsu_fixture_not_real') key(app, char, char)
    assert.equal(app.getInputValue(), '')
    assert.equal(app.getTokenLedgerConnectData().view.masked, true)
    assert.equal(out.chunks.join('').includes('tsu_fixture_not_real'), false)
    key(app, 'return')
    assert.deepEqual(calls, ['tsu_fixture_not_real'])
    assert.equal(app.getTokenLedgerConnectData().input, '')
    assert.notEqual(app.activeOverlayId(), 'token-ledger-connect')
  } finally { app.dispose() }
})

test('closing the ledger key overlay destroys partial input without saving', () => {
  const { app } = makeApp()
  app.registerOverlays({})
  let saved = false
  try {
    assert.equal(typeof app.startTokenLedgerConnect, 'function')
    app.startTokenLedgerConnect(() => { saved = true })
    for (const char of 'tsu_fixture') key(app, char, char)
    app.deactivateOverlay()
    assert.equal(app.getTokenLedgerConnectData().input, '')
    assert.equal(saved, false)
  } finally { app.dispose() }
})

test('switching to another overlay discards the ledger credential buffer', () => {
  const { app } = makeApp()
  app.registerOverlays({})
  try {
    app.startTokenLedgerConnect(() => assert.fail('switching overlays must not save a key'))
    for (const char of 'tsu_fixture_not_real') key(app, char, char)
    app.activateOverlay('help')
    assert.equal(app.getTokenLedgerConnectData().input, '')
  } finally { app.dispose() }
})
