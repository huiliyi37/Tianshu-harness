/**
 * 微信通道入站授权判定回归测试。
 *
 * 这里锁的是一条安全边界，比 QQ 侧更严：
 * 插件与天枢同进程、手里有文件与命令工具；微信绑的是主人**自己的社交账号**，
 * 放行陌生消息等于把机器和社交关系一起交出去。
 *
 * 三条不许回退的行为：
 * 1. 未配置 owner → 一律拒收（不是「全放行」）。
 * 2. 只有 owner 本人放行。
 * 3. 群聊一律拒收 —— 官方协议只支持私聊；将来若放开，必须改这里并补用例，
 *    而不是在某处加一行 `|| kind === 'group'`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorizedMessage, resolveOwner } from '../lib/weixin/authorization.mjs'

const OWNER = 'wxid_owner_0001@im.wechat'
const STRANGER = 'wxid_stranger_0001@im.wechat'

test('安全默认: 未配置 owner 时一律拒收（空值形态全覆盖）', () => {
  for (const owner of [null, undefined, '', '   ', 0, {}, []]) {
    assert.equal(
      isAuthorizedMessage({ kind: 'c2c', senderId: OWNER }, owner),
      false,
      `owner=${JSON.stringify(owner)} 时不应放行`,
    )
  }
})

test('配置 owner 后: owner 本人放行', () => {
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: OWNER }, OWNER), true)
})

test('配置 owner 后: 陌生人拒收', () => {
  assert.equal(isAuthorizedMessage({ kind: 'c2c', senderId: STRANGER }, OWNER), false)
})

test('群聊一律拒收（官方协议只支持私聊），哪怕发信人是 owner', () => {
  assert.equal(
    isAuthorizedMessage({ kind: 'group', senderId: OWNER, groupOpenid: 'G-1' }, OWNER),
    false,
  )
  assert.equal(
    isAuthorizedMessage({ kind: 'group', senderId: STRANGER, groupOpenid: 'G-1' }, OWNER),
    false,
  )
})

test('未标注 kind 的私聊形态放行（连接层若省略 kind，按私聊处理）', () => {
  assert.equal(isAuthorizedMessage({ senderId: OWNER }, OWNER), true)
})

test('边界: 缺失/畸形 senderId 不炸且拒收', () => {
  for (const message of [null, undefined, {}, { senderId: null }, { senderId: 42 }, { senderId: '' }, 'owner']) {
    assert.equal(isAuthorizedMessage(message, OWNER), false)
  }
})

test('边界: 两侧空白裁掉后再比对', () => {
  assert.equal(isAuthorizedMessage({ senderId: `  ${OWNER}  ` }, OWNER), true)
  assert.equal(isAuthorizedMessage({ senderId: OWNER }, `  ${OWNER}  `), true)
})

test('边界: 前缀相同但不是同一个 ID 不放行', () => {
  assert.equal(isAuthorizedMessage({ senderId: OWNER.slice(0, 12) }, OWNER), false)
  assert.equal(isAuthorizedMessage({ senderId: `${OWNER}x` }, OWNER), false)
})

test('resolveOwner: 从配置对象取 owner；未配置时给出 null（供启动日志判断）', () => {
  assert.equal(resolveOwner({ ownerUserId: OWNER }), OWNER)
  assert.equal(resolveOwner({ ownerUserId: '  ' }), null)
  assert.equal(resolveOwner({}), null)
  assert.equal(resolveOwner(null), null)
})
