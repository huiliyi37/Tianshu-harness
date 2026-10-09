import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver } from '../semver.js'

describe('semver prerelease', () => {
  test('prerelease 内的 - 不被截断', () => {
    assert.equal(parseSemver('1.0.0-rc-1')[3], 'rc-1')
    assert.ok(compareSemver('1.0.0-rc-1', '1.0.0-rc-2') < 0)
  })
  test('半数字标识按字符串比较', () => {
    assert.ok(compareSemver('1.0.0-1a', '1.0.0-1b') < 0)
  })
  test('数字标识按数值比较', () => {
    assert.ok(compareSemver('1.0.0-beta.2', '1.0.0-beta.10') < 0)
  })
  test('数字标识低于字母数字标识', () => {
    assert.ok(compareSemver('1.0.0-1', '1.0.0-alpha') < 0)
  })
  test('正式版高于 prerelease', () => {
    assert.ok(compareSemver('1.0.0', '1.0.0-rc-1') > 0)
  })
})
