/**
 * 入站授权判定（安全默认）回归测试。
 *
 * 这些用例锁住的是一条安全边界：插件与天枢同进程、手里有文件与命令工具，
 * 谁能触达它，等于谁能操控这台机器。旧实现的默认值是「未配置 = 全放行」，
 * 且群聊完全豁免——两条都在这里被钉死为「不许再回去」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorizedMessage } from '../lib/qq/authorization.mjs'

const OWNER = 'D939C6B50B6D8146E83731E6B26314B0'
const STRANGER = 'AAAAC3N7B1D2E4F60718293A4B5C6D7E'

test('安全默认: 未配置 owner 时一律拒收（空值形态全覆盖）', () => {
  for (const owner of [null, undefined, '', '   ', 0, {}]) {
    assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: OWNER }, owner), false,
      `owner=${JSON.stringify(owner)} 时不应放行`)
  }
})

test('安全默认: 未配置 owner 时群聊同样拒收', () => {
  assert.equal(
    isAuthorizedMessage({ kind: 'group', senderId: OWNER, groupOpenid: 'G-1' }, null),
    false,
  )
})

test('配置 owner 后: owner 本人的私聊放行', () => {
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: OWNER }, OWNER), true)
})

test('配置 owner 后: 陌生人的私聊拒收', () => {
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: STRANGER }, OWNER), false)
})

test('回归: 配置 owner 后群聊不再豁免——只有 owner 在群里 @ 才放行', () => {
  assert.equal(
    isAuthorizedMessage({ kind: 'group', senderId: OWNER, groupOpenid: 'G-1' }, OWNER),
    true,
  )
  assert.equal(
    isAuthorizedMessage({ kind: 'group', senderId: STRANGER, groupOpenid: 'G-1' }, OWNER),
    false,
  )
})

test('边界: 缺失/畸形 senderId 不炸且拒收', () => {
  for (const message of [null, undefined, {}, { senderId: null }, { senderId: 42 }, { senderId: '' }]) {
    assert.equal(isAuthorizedMessage(message, OWNER), false)
  }
})

test('边界: 两侧空白都会被裁掉后再比对', () => {
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: `  ${OWNER}  ` }, OWNER), true)
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: OWNER }, `  ${OWNER}  `), true)
})

test('边界: 前缀相同但不是同一个 openid 不放行', () => {
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: OWNER.slice(0, 10) }, OWNER), false)
})
