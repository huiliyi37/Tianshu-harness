/**
 * Bearer 令牌提取——收编公开仓 PR #410。
 *
 * RFC 7235 §2.1：认证方案名不区分大小写，旧实现 `startsWith('Bearer ')` 只认
 * 这一种拼写，`bearer abc` / `BEARER abc` 被拒。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractBearerToken, isAuthorizedRequest } from '../auth.js'

describe('extractBearerToken', () => {
  test('方案名不区分大小写（RFC 7235）', () => {
    assert.equal(extractBearerToken({ authorization: 'Bearer abc' }), 'abc')
    assert.equal(extractBearerToken({ authorization: 'bearer abc' }), 'abc')
    assert.equal(extractBearerToken({ authorization: 'BEARER abc' }), 'abc')
  })

  test('非 Bearer 方案与缺头返回 null', () => {
    assert.equal(extractBearerToken({ authorization: 'Basic abc' }), null)
    assert.equal(extractBearerToken({}), null)
    assert.equal(extractBearerToken(undefined), null)
  })

  test('空令牌与裸方案名不产生令牌', () => {
    assert.equal(extractBearerToken({ authorization: 'Bearer ' }), null)
    assert.equal(extractBearerToken({ authorization: 'Bearer' }), null)
  })

  test('令牌内容原样返回', () => {
    assert.equal(extractBearerToken({ authorization: 'Bearer a.b-c_d~e' }), 'a.b-c_d~e')
    assert.equal(extractBearerToken({ authorization: 'bearer a.b-c_d~e' }), 'a.b-c_d~e')
  })

  test('isAuthorizedRequest 消费侧对大小写形态一致', () => {
    assert.equal(isAuthorizedRequest({ headers: { authorization: 'bearer tok' } }, 'tok'), true)
    assert.equal(isAuthorizedRequest({ headers: { authorization: 'bearer nope' } }, 'tok'), false)
  })
})
