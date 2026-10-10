import { it } from 'node:test'
import assert from 'node:assert/strict'
import { verificationWaitBudget } from '../verification-wait.js'

it('raw timeout preserves explicit short budgets, rejects coercion and inherited values', () => {
  assert.deepEqual(verificationWaitBudget({}, 1000), { ms: 600000, source: 'default' })
  for (const timeout of [30000, 120000, 1800000]) assert.deepEqual(verificationWaitBudget({ timeout }, 1000), { ms: timeout, source: 'explicit' })
  for (const timeout of [undefined, null, '30000', 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(verificationWaitBudget({ timeout }, 1000), { ms: 600000, source: 'invalid' })
  }
  assert.deepEqual(verificationWaitBudget(Object.create({ timeout: 30000 }), 1000), { ms: 600000, source: 'default' })
})
