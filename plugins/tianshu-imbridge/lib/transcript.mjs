/**
 * 事件流 → 消息序列的还原（命令 /history 的纯逻辑层，无 IO、无依赖）。
 *
 * 规则来自 docs/command-mapping.md §一.5，每一条都有实测依据：
 * - **只消费三类 + 一类**：`user`（data.text）、`text_delta`（data.text）、`turn_complete`，
 *   外加 **`queue_pending.text`** —— 被 steer 的用户消息文本只落在那里，不会产生 `user` 事件
 *   （实测：某窗口 2 条 user 事件里没有那条 steer 原话）。
 * - **去重**：宿主会把部分排队输入以 `[排队跟进 …]` 前缀重发成 `user` 事件；
 *   若某个 `queue_pending.text` 被某条 `user` 事件的文本包含，只算一次。
 * - **回显前剥掉宿主注入前缀**：`[排队跟进 …]`、`[续跑] …`。
 * - **基线**：以收到的首条 seq 为基线，不假设从 1 开始；**不依赖序号连续**（新会话 1..43 也有缺口）。
 * - **段的完整性**：段内出现过 final `turn_complete`（`data.isFinal !== false`）且其后再无 `text_delta`
 *   → 视为已收尾（其后可跟 `done` 等收尾事件）；否则是「被中断、不完整」。
 * - **窗口首段**（首个 `user` 之前）：已收尾 → 保留并标注「提问不在窗口内」；
 *   未收尾 → 真残段，丢弃并置 droppedHead。
 * - **以 `user` 开头的段一律保留提问**，绝不因为「没有 final 收尾」整段丢掉。
 * - 不要因为「没看到某条 text_delta」就断定文本丢了：相邻同类 delta 会被读取期合并成单条。
 */

/** 宿主注入的伪消息前缀（回显前剥掉）。 */
const INJECTED_PREFIXES = [
  /^\[排队跟进[^\]]*\]\s*/u,
  /^\[续跑\][^\n]*\n?/u,
]

export function stripInjectedPrefix(text) {
  let out = typeof text === 'string' ? text : ''
  for (const re of INJECTED_PREFIXES) out = out.replace(re, '')
  return out.trim()
}

const isFinalTurn = (ev) => ev?.type === 'turn_complete' && ev?.data?.isFinal !== false

/** 段：以一条用户消息（或窗口开头）起，到下一条用户消息前止。 */
function segmentsOf(events) {
  const segs = []
  let cur = { user: null, texts: [], finalTurnSeq: null, lastTextSeq: null, done: false }
  const push = () => { segs.push(cur); cur = { user: null, texts: [], finalTurnSeq: null, lastTextSeq: null, done: false } }
  for (const ev of events) {
    if (ev.type === 'user') {
      push()
      cur.user = { text: ev.data?.text, seq: ev.seq }
    } else if (ev.type === 'queue_pending') {
      push()
      cur.user = { text: ev.data?.text, seq: ev.seq, queued: true }
    } else if (ev.type === 'text_delta') {
      const t = ev.data?.text
      if (typeof t === 'string' && t) {
        cur.texts.push({ text: t, seq: ev.seq })
        cur.lastTextSeq = ev.seq
      }
    } else if (isFinalTurn(ev)) {
      cur.finalTurnSeq = ev.seq
    } else if (ev.type === 'done') {
      cur.done = true
    }
  }
  push()
  return segs.filter((s) => s.user || s.texts.length || s.finalTurnSeq !== null)
}

/** 段是否已收尾：有 final turn_complete，且其后没有新的文本。 */
const isClosed = (seg) => seg.finalTurnSeq !== null
  && (seg.lastTextSeq === null || seg.lastTextSeq < seg.finalTurnSeq)

/**
 * 还原消息序列。
 * @param {Array} events 事件数组（顺序不限，内部按 seq 升序）
 * @returns {{messages:Array, total:number, droppedHead:boolean, windowStart:number|null}}
 */
export function reconstructMessages(events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && Number.isFinite(e.seq))
    .slice()
    .sort((a, b) => a.seq - b.seq)

  if (list.length === 0) {
    return { messages: [], total: 0, droppedHead: false, windowStart: null }
  }

  // queue_pending 去重：文本被任何一条 user 事件包含 → 那是同一条，别算两次
  const userTexts = list.filter((e) => e.type === 'user').map((e) => String(e.data?.text ?? ''))
  const deduped = list.filter((e) => {
    if (e.type !== 'queue_pending') return true
    const t = String(e.data?.text ?? '').trim()
    return !(t && userTexts.some((u) => u.includes(t)))
  })

  const segs = segmentsOf(deduped)
  const messages = []
  let droppedHead = false

  segs.forEach((seg, i) => {
    const closed = isClosed(seg)
    const assistant = seg.texts.map((t) => t.text).join('')
    const isHead = i === 0 && !seg.user

    if (isHead && !closed) { droppedHead = true; return }   // 真残段：只丢这一段
    if (isHead) {
      if (assistant) messages.push({ role: 'assistant', text: assistant, fromSeq: seg.texts[0].seq, toSeq: seg.lastTextSeq, note: 'no-question' })
      return
    }
    const userText = stripInjectedPrefix(seg.user?.text ?? '')
    if (userText) messages.push({ role: 'user', text: userText, fromSeq: seg.user.seq, toSeq: seg.user.seq, note: seg.user.queued ? 'steered' : null })
    if (assistant) {
      messages.push({ role: 'assistant', text: assistant, fromSeq: seg.texts[0].seq, toSeq: seg.lastTextSeq, note: closed ? null : 'incomplete' })
    }
  })

  return { messages, total: messages.length, droppedHead, windowStart: list[0].seq }
}

/** 取最近 N 条消息。limit 非法时按默认值处理（调用方还会再做本地校验）。 */
export function takeLast(messages, limit = 3) {
  const all = Array.isArray(messages) ? messages : []
  const n = Number.isInteger(limit) && limit > 0 ? limit : 3
  return { messages: all.slice(Math.max(0, all.length - n)), truncated: all.length > n, total: all.length }
}

// ── 命令层：/history [N]（数量校验与回显格式）────────────────────

/** 默认条数（借 dsh-im 的形：默认 3）。 */
export const HISTORY_DEFAULT = 3

/**
 * 条数上限。dsh-im 给的是 5，但它那时读的是消息级存储；天枢要从事件流自己还原，
 * 一次多看几轮更有用。上限按**回执分片的硬约束**反推：4500 字/片 × c2c 被动 4 片 = 18000 字，
 * 取总预算 12000 字（留足余量），单条最少 300 字 → 上限 20 条。
 */
export const HISTORY_MAX = 20

/** 单条消息回显的默认上限：超出即截断并说明原字数。 */
export const HISTORY_MSG_CHARS = 800

/** 一次回看的总字数预算（低于被动上限 18000，余量留给头部提示与分片边界）。 */
export const HISTORY_TOTAL_CHARS = 12_000

const NOTE_TEXT = Object.freeze({
  'no-question': '（这一轮的提问不在返回的窗口内）',
  steered: '（运行中排队送入）',
  incomplete: '（这一轮没有正常收尾，可能被中断）',
})

/**
 * 解析 /history 的数量参数。**永不把用户输入透传成 since 游标**（§一.5 的硬要求）：
 * 只在这里换算成 1..HISTORY_MAX 的整数，缺省 3；非法值回落到默认值并给一句说明。
 * @returns {{limit:number, note:string|null}}
 */
export function parseHistoryLimit(args) {
  const list = Array.isArray(args) ? args.filter((a) => a !== undefined && a !== null && a !== '') : []
  if (list.length === 0) return { limit: HISTORY_DEFAULT, note: null }
  const raw = String(list[0]).trim()
  const extra = list.length > 1 ? '只认第一个数量' : null

  if (!/^\d+$/.test(raw)) {
    return { limit: HISTORY_DEFAULT, note: `${noteJoin(`「${raw}」不是正整数`, extra)}，按默认 ${HISTORY_DEFAULT} 条` }
  }
  const n = Number.parseInt(raw, 10)
  if (n < 1) {
    return { limit: HISTORY_DEFAULT, note: `${noteJoin('数量至少是 1', extra)}，按默认 ${HISTORY_DEFAULT} 条` }
  }
  if (n > HISTORY_MAX) {
    return { limit: HISTORY_MAX, note: `${noteJoin(`一次最多 ${HISTORY_MAX} 条`, extra)}，按上限显示` }
  }
  return { limit: n, note: extra }
}

const noteJoin = (head, extra) => (extra ? `${head}；${extra}` : head)

const clipHistoryText = (text, maxChars = HISTORY_MSG_CHARS) => {
  const t = String(text ?? '').replace(/\r/g, '').trim()
  if (t.length <= maxChars) return t
  return `${t.slice(0, maxChars)}…（原 ${t.length} 字，已截断）`
}

/**
 * 按条数分配单条字数：条数多就压缩每条，把总量压在预算内（下限 300 字，再短就读不动了）。
 * @returns {number}
 */
export function perMessageChars(limit) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : HISTORY_DEFAULT
  return Math.max(300, Math.min(HISTORY_MSG_CHARS, Math.floor(HISTORY_TOTAL_CHARS / n)))
}

/**
 * 把 takeLast 的结果排版成 QQ 可读的回看文本。
 * @param {{messages:Array, truncated?:boolean, total?:number, droppedHead?:boolean, limitNote?:string|null}} view
 * @returns {string}
 */
export function formatHistory({
  messages, truncated = false, total = 0, droppedHead = false, limitNote = null,
  maxChars = HISTORY_MSG_CHARS,
} = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) return '这个会话还没有可回看的内容。'

  const per = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : HISTORY_MSG_CHARS
  const lines = [total > list.length ? `最近 ${list.length} 条（会话共还原 ${total} 条）` : `最近 ${list.length} 条`]
  if (truncated) lines.push(`（只显示尾部这些；要看更多带上数量，最多 ${HISTORY_MAX} 条）`)
  if (per < HISTORY_MSG_CHARS) lines.push(`（条数较多，每条最多 ${per} 字）`)
  if (droppedHead) lines.push('（开头那一轮不完整，已略过）')
  if (limitNote) lines.push(`（${limitNote}）`)

  for (const m of list) {
    const who = m?.role === 'user' ? '您' : '天枢'
    const note = m?.note && NOTE_TEXT[m.note] ? ` ${NOTE_TEXT[m.note]}` : ''
    lines.push('', `${who}：${clipHistoryText(m?.text, per)}${note}`)
  }
  return lines.join('\n')
}
