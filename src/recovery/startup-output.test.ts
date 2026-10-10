import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderAndAuth } from '../bootstrap.js'
import { configSchema } from '../config/schema.js'

it('does not emit terminal controls from invalid provider names or configured provider labels', t => {
  const config = configSchema.parse({ provider: { default: 'qa', providers: { qa: {
    name: 'qa', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'QA_UNUSED', models: [{ id: 'qa-model' }],
  } } } })
  const provider = Object.values(config.provider.providers)[0]!
  config.provider.providers = { ['available-\x1b]52;c;fixture\x07-provider']: provider }
  const lines: string[] = []
  t.mock.method(console, 'error', (text: string) => { lines.push(text) })
  const exit = new Error('expected exit')
  t.mock.method(process, 'exit', () => { throw exit })
  assert.throws(() => resolveProviderAndAuth(config, 'unknown-\x1b[?1049h\x9b?25l-provider'), error => error === exit)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('unknown-'))
  assert.ok(lines[0]!.includes('available-'))
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(lines[0]!), 'Startup diagnostics must remain plain text')
})
