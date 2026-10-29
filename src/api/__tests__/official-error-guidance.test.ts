import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorRecoveryGuidance } from '../error-guidance.js'
import { errorRecoveryGuidance as legacyGuidance } from '../error-classifier.js'
import { OfficialError } from '../../models/official-contract.js'

for (const [code, expected] of [
  ['supplier_balance_unavailable', /本次请求未自动重发；账号仍保持登录/],
  ['service_error', /本次请求未自动重发；请刷新状态并核对请求结果/],
  ['pricing_changed', /报价已过期或发生变化/],
] as const) {
  test(`current and legacy guidance entries preserve official ${code} handling`, () => {
    const error = new OfficialError(code)
    assert.equal(legacyGuidance, errorRecoveryGuidance)
    for (const surface of ['desktop', 'tui'] as const) assert.match(errorRecoveryGuidance(error, surface), expected)
  })
}
