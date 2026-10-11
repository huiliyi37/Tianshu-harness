import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BootstrapContext } from '../../bootstrap.js'
import { configSchema, type Config } from '../../config/schema.js'
import { TokenLedgerService } from '../../token-ledger/service.js'
import { updateTokenLedgerSettings } from '../../token-ledger/settings.js'
import { handleTokenLedgerCommand, registerTokenLedgerCommands } from '../token-ledger-command.js'
import { makeApp } from '../engine/__tests__/_harness.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-command-'))
  const sessionsRoot = join(root, 'sessions')
  const logDir = join(sessionsRoot, 'project', 'session')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'cache-log.jsonl'), JSON.stringify({ t: Date.now(), turn: 1, model: 'unknown', input: 1000, output: 100, cacheRead: 800 }) + '\n')
  let persisted = configSchema.parse({ provider: { default: 'deepseek', providers: {} } })
  let uploaded = 0
  const service = new TokenLedgerService(persisted, { statePath: join(root, 'ledger.json'), sessionsRoot,
    fetchImpl: async () => { uploaded++; return { status: 200, text: async () => '{"ok":true,"stale":false}' } },
  })
  const ctx = { config: persisted, tokenLedger: service } as BootstrapContext
  const settings = (patch: unknown) => updateTokenLedgerSettings(patch, { load: () => structuredClone(persisted), save: (next: Config) => { persisted = next } })
  return { ctx, service, settings, persisted: () => persisted, uploaded: () => uploaded,
    close() { service.stopAutoSync(); rmSync(root, { recursive: true, force: true }) } }
}

test('TUI connection keeps uploads off until explicit manual sync or auto on; disconnect stops timer', async () => {
  const fx = fixture()
  const { app, out } = makeApp()
  app.registerOverlays({})
  registerTokenLedgerCommands(app, fx.ctx, { updateSettings: fx.settings })
  const press = (name: string, char = '') => (app as unknown as { handleOverlayKey(key: unknown): boolean }).handleOverlayKey({ name, char })
  try {
    assert.equal(await app.tryDispatchSlash('/token-ledger connect'), true)
    for (const char of 'tsu_fixture_not_real') press(char, char)
    press('return')
    assert.equal(fx.persisted().tokenLedger.forum?.apiKey, 'tsu_fixture_not_real')
    assert.equal(fx.persisted().tokenLedger.forum?.autoSync, false)
    assert.equal(fx.service.status().autoSync, false)
    assert.equal(fx.uploaded(), 0)
    await app.tryDispatchSlash('/usage sync')
    assert.equal(fx.uploaded(), 1)
    assert.equal(fx.service.status().pending, false)
    await app.tryDispatchSlash('/token-ledger auto on')
    assert.equal(fx.persisted().tokenLedger.forum?.intervalMinutes, 30)
    assert.equal(fx.service.status().autoSync, true)
    await app.tryDispatchSlash('/token-ledger disconnect')
    assert.equal(fx.persisted().tokenLedger.forum?.apiKey, undefined)
    assert.equal(fx.service.status().autoSync, false)
    assert.equal(fx.persisted().tokenLedger.forum?.autoSync, false)
    assert.equal(out.chunks.join('').includes('tsu_fixture_not_real'), false)
  } finally { app.dispose(); fx.close() }
})

test('inline ledger credentials never enter composer history or agent submission', async () => {
  const fx = fixture()
  const { app, out } = makeApp()
  registerTokenLedgerCommands(app, fx.ctx, { updateSettings: fx.settings })
  let sent = false
  app.onSubmit(() => { sent = true })
  try {
    await (app as unknown as { handleInputSubmit(text: string): Promise<void> }).handleInputSubmit('/token-ledger connect tsu_fixture_not_real')
    assert.equal(app.getInputController().inputHistory.some(value => value.includes('tsu_fixture_not_real')), false)
    assert.equal(sent, false)
    assert.equal(fx.persisted().tokenLedger.forum?.apiKey, undefined)
    assert.equal(out.chunks.join('').includes('tsu_fixture_not_real'), false)
  } finally { app.dispose(); fx.close() }
})

test('settings errors remain controlled and cancellation prevents queued mutations', async () => {
  const fx = fixture()
  const output: string[] = []
  const opts = { updateSettings: fx.settings, canCommit: () => false }
  try {
    await handleTokenLedgerCommand(fx.ctx, ['/usage', 'disconnect'], text => output.push(text), opts)
    assert.equal(fx.persisted().tokenLedger.forum, undefined)
    assert.equal(Number(output.length), 0)
    await handleTokenLedgerCommand(fx.ctx, ['/usage', 'auto', 'on'], text => output.push(text), { updateSettings: fx.settings })
    assert.equal(fx.service.status().autoSync, false)
    assert.match(output.join('\n'), /sync key/)
    assert.equal(fx.uploaded(), 0)
  } finally { fx.close() }
})

test('ledger cost display does not assign a currency to mixed model pricing', async () => {
  const fx = fixture()
  const output: string[] = []
  try {
    await handleTokenLedgerCommand(fx.ctx, ['/usage'], value => output.push(value))
    assert.doesNotMatch(output.join('\n'), /[$¥]/)
    assert.match(output.join('\n'), /model pricing units may differ/)
  } finally { fx.close() }
})
