/**
 * iLink 协议纯函数回归测试。
 *
 * 这些函数不碰网络，是连接层的「翻译层」：把协议报文翻成桥认识的形状。
 * 每一条用例都对应一个真实会踩的坑（游标丢失、游标被清空、message_id 精度、
 * 文本缺失、服务端业务错误码被当成成功），不是凑数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  ILINK_BOT_AGENT,
  ILINK_CHANNEL_VERSION,
  MESSAGE_ITEM_TYPE,
  buildBaseInfo,
  buildSendTextEnvelope,
  dedupeByMessageId,
  extractText,
  mapErrorCode,
  normalizeMessage,
  orderMessages,
  pickNextBuf,
  rejectedCode,
  safeProviderCode,
  toBridgeMessage,
} from '../lib/weixin/protocol.mjs'

const OWNER = 'wxid_owner_0001@im.wechat'

function textMsg(over = {}) {
  return {
    seq: 1,
    message_id: '7300000000000000001',
    from_user_id: OWNER,
    to_user_id: 'bot@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: 'CT-1',
    item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: '你好' } }],
    ...over,
  }
}

test('常量: base_info 用本插件自己的身份（不冒充 OpenClaw）', () => {
  const info = buildBaseInfo()
  assert.equal(info.channel_version, ILINK_CHANNEL_VERSION)
  assert.equal(info.bot_agent, ILINK_BOT_AGENT)
  assert.match(info.bot_agent, /^[A-Za-z]+\/[0-9.]+$/)   // 协议要求 Name/Version 形态
})

test('rejectedCode: ret / errcode 任一非 0 即为业务失败（0 与 "0" 都算成功）', () => {
  assert.equal(rejectedCode({ ret: 0, errcode: 0 }), null)
  assert.equal(rejectedCode({ ret: '0' }), null)
  assert.equal(rejectedCode({}), null)
  assert.equal(rejectedCode(null), null)
  assert.equal(rejectedCode({ ret: -14 }), '-14')
  assert.equal(rejectedCode({ errcode: -14 }), '-14')
  assert.equal(rejectedCode({ errcode: '50001' }), '50001')
  assert.equal(rejectedCode({ ret: 1, errcode: 0 }), '1')
})

test('safeProviderCode: 畸形值不炸，原样转字符串', () => {
  assert.equal(safeProviderCode(-14), '-14')
  assert.equal(safeProviderCode('abc'), 'abc')
  assert.equal(safeProviderCode(null), null)
  assert.equal(safeProviderCode(undefined), null)
  assert.equal(safeProviderCode({}), null)
  assert.equal(safeProviderCode(1.5), '1.5')
})

test('extractText: 取第一段文本并裁剪空白', () => {
  assert.equal(extractText(textMsg()), '你好')
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: '  空格  ' } }] }), '空格')
})

test('extractText: 无文本 / 非文本 / 畸形输入一律 null（不抛错）', () => {
  for (const value of [
    null, undefined, {}, { item_list: [] }, { item_list: null },
    { item_list: [{ type: MESSAGE_ITEM_TYPE.IMAGE, image_item: {} }] },
    { item_list: [{ type: 1, text_item: { text: '   ' } }] },
    { item_list: [{ type: 1 }] }, '文案', 42,
  ]) {
    assert.equal(extractText(value), null)
  }
})

test('extractText: 跳过非文本项，取后面那段文本', () => {
  assert.equal(
    extractText({ item_list: [{ type: 2, image_item: {} }, { type: 1, text_item: { text: '后面的文本' } }] }),
    '后面的文本',
  )
})

test('normalizeMessage: 抽出连接层需要的字段，message_id 可为字符串（uint64 不丢精度）', () => {
  const m = normalizeMessage(textMsg())
  assert.equal(m.kind, 'c2c')
  assert.equal(m.senderId, OWNER)
  assert.equal(m.messageId, '7300000000000000001')
  assert.equal(m.seq, 1)
  assert.equal(m.contextToken, 'CT-1')
  assert.equal(m.sentAtMs, null)
  assert.equal(m.text, '你好')
  assert.equal(m.mediaLabel, null)   // 有文本时不该报「省略了媒体」
})

test('normalizeMessage: 群消息显式标 kind=group（授权层据此拒收）', () => {
  assert.equal(normalizeMessage(textMsg({ group_id: 'G-1' })).kind, 'group')
})

test('normalizeMessage: 无 id 的畸形消息给 null，不造出空字符串 id', () => {
  assert.equal(normalizeMessage({ item_list: [] }).messageId, null)
  assert.equal(normalizeMessage({ message_id: 12345 }).messageId, null)  // 数字形态不可信
  assert.equal(normalizeMessage(null).senderId, null)
})

test('orderMessages: 按 seq 升序，缺 seq 视为 0，不依赖输入顺序', () => {
  const list = orderMessages([
    { seq: 3, message_id: 'c' },
    { message_id: 'x' },
    { seq: 1, message_id: 'a' },
    { seq: 2, message_id: 'b' },
  ])
  assert.deepEqual(list.map((m) => m.message_id), ['x', 'a', 'b', 'c'])
  assert.deepEqual(orderMessages(null), [])
  assert.deepEqual(orderMessages('nope'), [])
})

test('dedupeByMessageId: 过滤已见 id，第一次见到的保留', () => {
  const seen = new Set(['old'])
  const fresh = dedupeByMessageId([{ message_id: 'old' }, { message_id: 'new' }, { message_id: 'new2' }], seen)
  assert.deepEqual(fresh.map((m) => m.message_id), ['new', 'new2'])
})

test('dedupeByMessageId: 无 id 的消息不参与去重（不能因缺 id 就整条丢）', () => {
  const fresh = dedupeByMessageId([{ message_id: null }, {}], new Set())
  assert.equal(fresh.length, 2)
})

test('pickNextBuf: 服务端给空串时保住旧游标（否则下轮会重放历史）', () => {
  assert.equal(pickNextBuf('CURSOR-A', { get_updates_buf: 'CURSOR-B' }), 'CURSOR-B')
  assert.equal(pickNextBuf('CURSOR-A', { get_updates_buf: '' }), 'CURSOR-A')
  assert.equal(pickNextBuf('CURSOR-A', {}), 'CURSOR-A')
  assert.equal(pickNextBuf('CURSOR-A', null), 'CURSOR-A')
  assert.equal(pickNextBuf('', { get_updates_buf: 'B' }), 'B')
  assert.equal(pickNextBuf(null, { get_updates_buf: 42 }), '')
})

test('toBridgeMessage: 组出桥认识的形状（content + replyTarget 不透明句柄）', () => {
  const freshAt = new Date('2026-09-30T00:00:00Z')
  const bridged = toBridgeMessage(textMsg(), { freshAt })
  assert.equal(bridged.content, '你好')
  assert.equal(bridged.senderId, OWNER)
  assert.equal(bridged.kind, 'c2c')
  assert.equal(bridged.replyTarget.scope, 'c2c')
  assert.equal(bridged.replyTarget.targetId, OWNER)
  assert.equal(bridged.replyTarget.contextToken, 'CT-1')
  assert.equal(bridged.replyTarget.messageId, '7300000000000000001')
  assert.equal(bridged.mediaOmitted, null)
})

test('toBridgeMessage: 非文本消息 → content 为空并说明省略了什么（连接层据此回一句人话）', () => {
  const img = textMsg({ item_list: [{ type: MESSAGE_ITEM_TYPE.IMAGE, image_item: {} }] })
  const bridged = toBridgeMessage(img)
  assert.equal(bridged.content, '')
  assert.match(bridged.mediaOmitted, /图片/)
  assert.equal(toBridgeMessage(textMsg({ item_list: [{ type: MESSAGE_ITEM_TYPE.VOICE }] })).mediaOmitted, '语音')
  assert.equal(toBridgeMessage(textMsg({ item_list: [{ type: MESSAGE_ITEM_TYPE.FILE }] })).mediaOmitted, '文件')
  assert.equal(toBridgeMessage(textMsg({ item_list: [{ type: MESSAGE_ITEM_TYPE.VIDEO }] })).mediaOmitted, '视频')
  assert.equal(toBridgeMessage(textMsg({ item_list: [{ type: 99 }] })).mediaOmitted, '未知内容')
  // 连 item_list 都没有 = 畸形报文：按「无内容」丢弃，不惊动主人
  assert.equal(toBridgeMessage(textMsg({ item_list: [] })).mediaOmitted, null)
})

test('toBridgeMessage: 缺 context_token 时如实留空（连接层须回退到最近令牌）', () => {
  const bridged = toBridgeMessage(textMsg({ context_token: undefined }))
  assert.equal(bridged.replyTarget.contextToken, null)
})

test('buildSendTextEnvelope: 出站信封字段与协议一致', () => {
  const envelope = buildSendTextEnvelope({
    toUserId: OWNER,
    text: '回你一句',
    clientId: 'client-1',
    contextToken: 'CT-1',
  })
  assert.deepEqual(envelope.msg, {
    from_user_id: '',
    to_user_id: OWNER,
    client_id: 'client-1',
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: '回你一句' } }],
    context_token: 'CT-1',
  })
  assert.equal(envelope.base_info.channel_version, ILINK_CHANNEL_VERSION)
})

test('buildSendTextEnvelope: 无 context_token 时不带该字段（不是空串）', () => {
  const envelope = buildSendTextEnvelope({ toUserId: OWNER, text: 'x', clientId: 'c' })
  assert.equal('context_token' in envelope.msg, false)
})

test('buildSendTextEnvelope: 目标或文本非法 → 抛 TypeError（早失败，别发出去才发现）', () => {
  assert.throws(() => buildSendTextEnvelope({ toUserId: '', text: 'x', clientId: 'c' }), TypeError)
  assert.throws(() => buildSendTextEnvelope({ toUserId: OWNER, text: '   ', clientId: 'c' }), TypeError)
  assert.throws(() => buildSendTextEnvelope({ toUserId: OWNER, text: 'x', clientId: '' }), TypeError)
})

test('mapErrorCode: -14 是凭据失效（需重新扫码），其余归为请求被拒', () => {
  assert.equal(mapErrorCode(-14), 'stale-token')
  assert.equal(mapErrorCode('-14'), 'stale-token')
  assert.equal(mapErrorCode(0), null)
  assert.equal(mapErrorCode('0'), null)
  assert.equal(mapErrorCode(null), null)
  assert.equal(mapErrorCode(50001), 'request-rejected')
  assert.equal(mapErrorCode('weird'), 'request-rejected')
})

test('DEFAULT_LONG_POLL_TIMEOUT_MS: 采用官方/DSH 侧同一个 35 秒基线', () => {
  assert.equal(DEFAULT_LONG_POLL_TIMEOUT_MS, 35_000)
})
