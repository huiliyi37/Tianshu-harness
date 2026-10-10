/**
 * semver 解析与比较（纯函数）——收编公开仓 PR #410。
 *
 * 原缺陷两处：
 *   ① `parseSemver` 用 `split('-', 2)` 切分，prerelease 自身含 `-` 时（`rc-1`）
 *      剩余部分被直接丢弃；`coreSegments`（第 4+ 段比较）同源。
 *   ② `comparePrerelease` 用 `parseInt` 判数字：`parseInt('1a')` 得 1，半数字标识
 *      被误当数字比较（`1a` 与 `1b` 判等）。semver §11：只含数字的标识按数值比，
 *      其余按 ASCII 字典序，且数字标识优先级恒低于字母数字标识。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver } from '../semver.js'

describe('semver prerelease 解析与比较', () => {
  test('prerelease 内含 - 不被截断', () => {
    assert.equal(parseSemver('1.0.0-rc-1')[3], 'rc-1')
    assert.ok(compareSemver('1.0.0-rc-1', '1.0.0-rc-2') < 0)
  })

  test('半数字标识按字符串比较（parseInt("1a") 不再冒充数字）', () => {
    assert.ok(compareSemver('1.0.0-1a', '1.0.0-1b') < 0)
    // ASCII 序：'2a' > '10a'（若被 parseInt 当数字则相反）
    assert.ok(compareSemver('1.0.0-2a', '1.0.0-10a') > 0)
  })

  test('纯数字标识按数值比较', () => {
    assert.ok(compareSemver('1.0.0-beta.2', '1.0.0-beta.10') < 0)
  })

  test('数字标识优先级低于字母数字标识（§11）', () => {
    assert.ok(compareSemver('1.0.0-1', '1.0.0-alpha') < 0)
    assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0)
  })

  test('正式版高于 prerelease，段数少者优先级低', () => {
    assert.ok(compareSemver('1.0.0', '1.0.0-rc-1') > 0)
    assert.ok(compareSemver('1.0.0-alpha', '1.0.0-alpha.1') < 0)
  })

  test('第 4+ 段（canary/构建号）比较不受 prerelease 切分影响', () => {
    assert.ok(compareSemver('1.2.3.4', '1.2.3') > 0)
    assert.equal(compareSemver('1.2.3+meta', '1.2.3+other'), 0)
  })
})
