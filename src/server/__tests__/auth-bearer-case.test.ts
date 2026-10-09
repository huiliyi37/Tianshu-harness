import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractBearerToken } from '../auth.js'

test('Bearer 方案名不区分大小写', () => {
  assert.equal(extractBearerToken({ authorization: 'Bearer abc' }), 'abc')
  assert.equal(extractBearerToken({ authorization: 'bearer abc' }), 'abc')
  assert.equal(extractBearerToken({ authorization: 'Basic abc' }), null)
  assert.equal(extractBearerToken({}), null)
})
