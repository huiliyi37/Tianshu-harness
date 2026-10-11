import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { BootstrapContext } from '../bootstrap.js'
import { configSchema } from '../config/schema.js'
import { TokenLedgerService } from '../token-ledger/service.js'
import { RecoveryCommands } from './commands.js'
import { RecoveryOutput } from './output.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cli-ledger-'))
  const sessionsRoot = join(root, 'sessions')
  const logs = join(sessionsRoot, 'project', 'session')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'cache-log.jsonl'), JSON.stringify({ t: Date.parse('2026-10-10T10:00:00Z'), turn: 1, model: 'unknown-model', input: 1000, output: 100, cacheRead: 800, cacheCreate: 0 }) + '\n')
  const config = configSchema.parse({ provider: { default: 'deepseek', providers: {} } })
  let uploads = 0
  const service = new TokenLedgerService(config, {
    statePath: join(root, 'ledger.json'), sessionsRoot,
    fetchImpl: async () => { uploads++; return { status: 200, text: async () => '{"ok":true,"stale":false}' } },
  })
  let text = ''
  const output = new RecoveryOutput(new Writable({ write(chunk, _encoding, done) { text += chunk; done() } }))
  const ctx = { config, tokenLedger: service } as BootstrapContext
  const commands = new RecoveryCommands(ctx, output, () => true)
  return { ctx, commands, service, text: () => text, uploads: () => uploads,
    close() { output.close(); service.stopAutoSync(); rmSync(root, { recursive: true, force: true }) } }
}

test('recovery usage consumes local ledger with cache counted separately and no upload', async () => {
  const fx = fixture()
  try {
    const result = await fx.commands.handle('/usage')
    assert.equal(result.handled, true)
    assert.equal(result.prompt, undefined)
    assert.match(fx.text(), /Total tokens: 1,100/)
    assert.match(fx.text(), /Cache read: 800/)
    assert.match(fx.text(), /Estimated pricing value/)
    assert.match(fx.text(), /Pending: yes/)
    assert.equal(fx.uploads(), 0)
  } finally { fx.close() }
})

test('recovery connection never accepts inline credentials or prompts for plain text keys', async () => {
  const fx = fixture()
  try {
    for (const line of ['/token-ledger connect', '/token-ledger connect tsu_fixture_not_real']) {
      const result = await fx.commands.handle(line)
      assert.equal(result.prompt, undefined)
    }
    assert.match(fx.text(), /VS Code/)
    assert.match(fx.text(), /native TUI/)
    assert.equal(fx.text().includes('tsu_fixture_not_real'), false)
    assert.equal(fx.ctx.config.tokenLedger.forum?.apiKey, undefined)
    assert.equal(fx.uploads(), 0)
  } finally { fx.close() }
})

test('recovery manual sync without a key stays local and reports a controlled reason', async () => {
  const fx = fixture()
  try {
    await fx.commands.handle('/token-ledger sync')
    assert.match(fx.text(), /sync key/)
    assert.equal(fx.uploads(), 0)
    assert.equal(fx.service.status().pending, true)
  } finally { fx.close() }
})
