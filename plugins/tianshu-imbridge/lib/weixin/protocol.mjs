/**
 * iLink 协议纯函数层（无网络、无状态、可单测）。
 *
 * 依据：腾讯官方 `Tencent/openclaw-weixin` → `docs/protocol_zh_CN.md` 与 `src/api/types.ts`；
 * 对照实现：本机 DSH 侧 `@xmanrui/dsh-im` 的 `weixin-api.mjs`。
 * 详尽的取舍与举证见 docs/research-notes/微信通道-研究笔记.md。
 *
 * 为什么把这层单独抽出来：连接层要处理定时器、退避、状态机，噪音大；
 * 而「报文怎么翻译」是可以单独钉死的确定性逻辑。这层全部是纯函数，
 * 不读文件、不发请求、不碰全局状态。
 */

// ── 常量（协议契约的一部分，改动即破坏兼容）────────────────────

/** bot_agent / channel_version 的取值：声明本客户端的身份。 */
export const ILINK_CHANNEL_VERSION = '2.4.6'
export const ILINK_BOT_AGENT = 'TianshuHarness/0.6.0'
export const ILINK_APP_ID = 'bot'
/** 0x00MMNNPP 编码：2.4.6 → (2<<16)|(4<<8)|6 */
export const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000

/** 消息条目类型（协议 MessageItemType）。 */
export const MESSAGE_ITEM_TYPE = Object.freeze({
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
})

/** 媒体条目 → 给人看的名字（第一版不做媒体，只回一句人话告诉主人收到了什么）。 */
const MEDIA_LABELS = Object.freeze({
  [MESSAGE_ITEM_TYPE.IMAGE]: '图片',
  [MESSAGE_ITEM_TYPE.VOICE]: '语音',
  [MESSAGE_ITEM_TYPE.FILE]: '文件',
  [MESSAGE_ITEM_TYPE.VIDEO]: '视频',
})

/** 凭据失效：官方语义是「会话超时」，收到即停并提示重新扫码。 */
export const STALE_TOKEN_ERRCODE = -14

// ── 报文构造 ─────────────────────────────────────────────────

/** 每个请求都要带的公共块。 */
export function buildBaseInfo() {
  return { channel_version: ILINK_CHANNEL_VERSION, bot_agent: ILINK_BOT_AGENT }
}

/** 请求头（鉴权头由连接层按凭据补上，此处不管凭据）。 */
export function buildHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  const trimmed = typeof token === 'string' ? token.trim() : ''
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`
  return headers
}

/** 出站文本信封（sendmessage 的请求体）。 */
export function buildSendTextEnvelope({ toUserId, text, clientId, contextToken }) {
  const to = typeof toUserId === 'string' ? toUserId.trim() : ''
  const body = typeof text === 'string' ? text : ''
  const cid = typeof clientId === 'string' ? clientId.trim() : ''
  if (!to) throw new TypeError('buildSendTextEnvelope 需要 toUserId')
  if (!body.trim()) throw new TypeError('buildSendTextEnvelope 需要非空 text')
  if (!cid) throw new TypeError('buildSendTextEnvelope 需要 clientId')
  const token = typeof contextToken === 'string' ? contextToken.trim() : ''
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: cid,
      message_type: 2,   // 2 = Bot
      message_state: 2,  // 2 = 完成（本插件一次性发完整段，不做流式编辑）
      item_list: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text: body } }],
      ...(token ? { context_token: token } : {}),
    },
    base_info: buildBaseInfo(),
  }
}

// ── 报文解析 ─────────────────────────────────────────────────

/** 业务错误码归一为字符串；无错返回 null。 */
export function safeProviderCode(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') return value.trim() ? value.trim() : null
  return null
}

/**
 * 服务端业务层是否拒绝了这次请求。
 * 判定口径与两份参考实现一致：`ret` 与 `errcode` 任一存在且不为 0（含字符串 '0'）。
 */
export function rejectedCode(response) {
  if (!response || typeof response !== 'object') return null
  for (const field of ['ret', 'errcode']) {
    const value = response[field]
    if (value === undefined || value === null) continue
    if (value === 0 || value === '0') continue
    return safeProviderCode(value) ?? 'rejected'
  }
  return null
}

/**
 * 业务错误码 → 本插件的语义标签。
 * 只认一条要紧的：-14 = 凭据失效（重连也救不回来，必须重新扫码）。
 */
export function mapErrorCode(code) {
  const value = safeProviderCode(code)
  if (!value) return null
  if (value === '0') return null
  return value === String(STALE_TOKEN_ERRCODE) ? 'stale-token' : 'request-rejected'
}

/** 取第一段文本（裁剪空白）；没有文本给 null。 */
export function extractText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type !== MESSAGE_ITEM_TYPE.TEXT) continue
    const text = typeof item?.text_item?.text === 'string' ? item.text_item.text.trim() : ''
    if (text) return text
  }
  return null
}

/** 第一条**连文本都不是**的条目类型；用于告诉主人「这条是图片/语音」。 */
function firstMediaLabel(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  // 只看非文本条目：文本条目由 extractText 负责，混进来会把正常文字消息误标成「省略了内容」
  const nonText = items.filter((item) => item?.type !== MESSAGE_ITEM_TYPE.TEXT)
  for (const item of nonText) {
    const label = MEDIA_LABELS[item?.type]
    if (label) return label
  }
  // 全是文本条目 → 没有媒体可报；有条目但都不认识 → 如实说「未知内容」
  if (nonText.length === 0) return null
  return '未知内容'
}

/**
 * 把协议报文抽成本通道内部的消息形状（不直接给桥用，先过授权与去重）。
 *
 * `message_id` 在线上是 uint64，官方实现按**字符串**解析以避免精度丢失；
 * 本函数同样只接受字符串形态，数字形态一律视为不可信（宁可不去重，不可去重错）。
 */
export function normalizeMessage(message) {
  const item = message ?? {}
  const messageId = typeof item.message_id === 'string' && item.message_id.trim()
    ? item.message_id.trim()
    : null
  const senderId = typeof item.from_user_id === 'string' && item.from_user_id.trim()
    ? item.from_user_id.trim()
    : null
  const contextToken = typeof item.context_token === 'string' && item.context_token.trim()
    ? item.context_token.trim()
    : null
  return {
    messageId,
    seq: Number.isFinite(item.seq) ? item.seq : 0,
    senderId,
    kind: item.group_id ? 'group' : 'c2c',
    contextToken,
    sentAtMs: Number.isFinite(item.create_time_ms) ? item.create_time_ms : null,
    text: extractText(item),
    mediaLabel: firstMediaLabel(item),
  }
}

/** 按 seq 升序（缺 seq 视为 0，保持稳定）。 */
export function orderMessages(messages) {
  const list = Array.isArray(messages) ? [...messages] : []
  return list
    .map((m, index) => ({ m, index, seq: Number.isFinite(m?.seq) ? m.seq : 0 }))
    .sort((a, b) => (a.seq - b.seq) || (a.index - b.index))
    .map((x) => x.m)
}

/** 过滤已见 message_id（无 id 的不参与去重：不能因缺 id 把整条丢掉）。 */
export function dedupeByMessageId(messages, seen) {
  const list = Array.isArray(messages) ? messages : []
  const known = seen instanceof Set ? seen : new Set()
  const fresh = []
  for (const message of list) {
    const id = typeof message?.message_id === 'string' ? message.message_id.trim() : ''
    if (id && known.has(id)) continue
    if (id) known.add(id)
    fresh.push(message)
  }
  return fresh
}

/**
 * 游标取舍：**只在服务端给回非空串时前进**。
 * 官方与 DSH 侧都是这个口径；反过来（把空串当新游标存下来）会让下一轮从头发起，
 * 历史消息被重放一遍。
 */
export function pickNextBuf(previous, response) {
  const next = typeof response?.get_updates_buf === 'string' ? response.get_updates_buf : ''
  if (next) return next
  return typeof previous === 'string' ? previous : ''
}

/**
 * 组装桥认识的消息：`content` + 不透明的 `replyTarget`。
 * replyTarget 里带上 context_token / messageId —— 桥不解读这两个字段，
 * 只把它们原样交回连接层，所以桥不需要知道 iLink 的存在。
 */
export function toBridgeMessage(message, { freshAt } = {}) {
  const normalized = normalizeMessage(message)
  const now = freshAt instanceof Date ? freshAt.getTime() : Date.now()
  return {
    kind: normalized.kind,
    senderId: normalized.senderId,
    senderName: null,
    content: normalized.text ?? '',
    mediaOmitted: normalized.text ? null : normalized.mediaLabel,
    receivedAt: new Date(now).toISOString(),
    replyTarget: {
      scope: normalized.kind === 'group' ? 'group' : 'c2c',
      targetId: normalized.senderId,
      contextToken: normalized.contextToken,
      messageId: normalized.messageId,
      channel: 'weixin',
    },
  }
}
