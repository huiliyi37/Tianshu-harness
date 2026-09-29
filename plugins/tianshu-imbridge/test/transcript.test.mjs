/**
 * lib/transcript.mjs —— 事件流 → 消息序列还原（命令 /history 的纯逻辑层）。
 *
 * 覆盖要求（计划·小类 11）：正常 / 空 / 超长 / 含压缩事件，四类必须有。
 * 另按 docs/command-mapping.md §一.5 的实测结论逐条设防：
 *   - 只消费 user / text_delta / turn_complete / queue_pending
 *   - queue_pending 被 user 包含时只算一次；回显剥宿主注入前缀
 *   - 基线以首条 seq 为准；序号不连续、不假设从 1 开始
 *   - 窗口首段：已收尾 → 保留并标 no-question；未收尾 → 丢弃并置 droppedHead
 *   - 以 user 开头的段一律保留提问，助手文本不足时标 incomplete
 *   - final 之后再现 text_delta → 撤销收尾
 *
 * 真实事件档的复算不放在单测里（会让用例依赖本机绝对路径）。
 * 那一步是 tools/probe-transcript.mjs，产物落 docs/research-notes/。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_MAX, HISTORY_MSG_CHARS, HISTORY_TOTAL_CHARS, formatHistory, parseHistoryLimit,
  perMessageChars, reconstructMessages, stripInjectedPrefix, takeLast,
} from '../lib/transcript.mjs'

/** 造一条事件；ts 只为形状完整，不参与判断。 */
const ev = (seq, type, data) => ({ seq, ts: 1_790_000_000_000 + seq, type, data })

const roles = (r) => r.messages.map((m) => m.role)

// ── 正常一轮 ──────────────────────────────────────────────────

test('正常一轮：user + 多条 text_delta + final turn_complete → 两条消息', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '你好' }),
    ev(2, 'status', { status: 'running' }),
    ev(3, 'text_delta', { text: '嗨' }),
    ev(4, 'text_delta', { text: '，主人' }),
    ev(5, 'turn_complete', { isFinal: true }),
    ev(6, 'done', { status: 'completed' }),
  ])
  assert.deepEqual(roles(r), ['user', 'assistant'])
  assert.equal(r.messages[0].text, '你好')
  assert.equal(r.messages[1].text, '嗨，主人')
  assert.equal(r.messages[0].note, null)
  assert.equal(r.messages[1].note, null, '段尾有 final → 不是 incomplete')
  assert.equal(r.droppedHead, false)
  assert.equal(r.windowStart, 1)
  assert.equal(r.total, 2)
})

test('正常多轮：四段按 seq 顺序输出，助手文本各自归属', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '第一问' }),
    ev(2, 'text_delta', { text: '第一答' }),
    ev(3, 'turn_complete', { isFinal: true }),
    ev(4, 'done', { status: 'completed' }),
    ev(5, 'user', { text: '第二问' }),
    ev(6, 'text_delta', { text: '第二答' }),
    ev(7, 'turn_complete', { isFinal: true }),
    ev(8, 'done', { status: 'completed' }),
  ])
  assert.deepEqual(r.messages.map((m) => m.text), ['第一问', '第一答', '第二问', '第二答'])
  assert.deepEqual(r.messages.map((m) => m.toSeq), [1, 2, 5, 6])
})

test('只消费四类事件：thinking/tool/phase 一律不进消息', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'thinking_delta', { text: '内心戏' }),
    ev(3, 'tool_use', { name: 'read' }),
    ev(4, 'tool_result', { output: 'x' }),
    ev(5, 'phase', { phase: 'work' }),
    ev(6, 'text_delta', { text: '答' }),
    ev(7, 'turn_complete', { isFinal: true }),
  ])
  assert.deepEqual(roles(r), ['user', 'assistant'])
  assert.equal(r.messages[1].text, '答')
  assert.ok(!JSON.stringify(r).includes('内心戏'))
})

// ── 空 ────────────────────────────────────────────────────────

test('空：空数组 / null / 非数组 → 空结果，且 windowStart 为 null', () => {
  const empty = { messages: [], total: 0, droppedHead: false, windowStart: null }
  assert.deepEqual(reconstructMessages([]), empty)
  assert.deepEqual(reconstructMessages(null), empty)
  assert.deepEqual(reconstructMessages(undefined), empty)
  assert.deepEqual(reconstructMessages('nope'), empty)
})

test('空：只有非消息类事件 → 无消息、无残段', () => {
  const r = reconstructMessages([
    ev(1, 'status', { status: 'idle' }),
    ev(2, 'phase', { phase: 'think' }),
  ])
  assert.deepEqual(r.messages, [])
  assert.equal(r.droppedHead, false)
  assert.equal(r.total, 0)
})

test('空：user 事件文本为空或纯空白 → 不产生消息', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '   ' }),
    ev(2, 'text_delta', { text: '' }),
  ])
  assert.deepEqual(r.messages, [])
})

// ── 超长 ──────────────────────────────────────────────────────

test('超长：助手文本不截断，逐条 delta 完整拼接（6 万字符）', () => {
  const chunk = 'x'.repeat(20_000)
  const r = reconstructMessages([
    ev(1, 'user', { text: '长问' }),
    ev(2, 'text_delta', { text: chunk }),
    ev(3, 'text_delta', { text: chunk }),
    ev(4, 'text_delta', { text: chunk }),
    ev(5, 'turn_complete', { isFinal: true }),
  ])
  assert.equal(r.messages[1].text.length, 60_000)
  assert.equal(r.messages[1].text, chunk + chunk + chunk)
  assert.equal(r.messages[1].fromSeq, 2)
  assert.equal(r.messages[1].toSeq, 4)
})

test('超长：会话 500 轮不炸，条数精确', () => {
  const events = []
  let seq = 1
  for (let i = 0; i < 500; i += 1) {
    events.push(ev(seq++, 'user', { text: `问${i}` }))
    events.push(ev(seq++, 'text_delta', { text: `答${i}` }))
    events.push(ev(seq++, 'turn_complete', { isFinal: true }))
    events.push(ev(seq++, 'done', { status: 'completed' }))
  }
  const r = reconstructMessages(events)
  assert.equal(r.total, 1000)
  assert.equal(r.messages[0].text, '问0')
  assert.equal(r.messages.at(-1).text, '答499')
})

test('超长：takeLast 只取尾部 N 条，并如实报告总数与截断', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }))
  const r = takeLast(messages, 3)
  assert.deepEqual(r.messages.map((m) => m.text), ['m9', 'm10', 'm11'])
  assert.equal(r.total, 12)
  assert.equal(r.truncated, true)
})

test('超长：takeLast 在条数不足时不假装补全', () => {
  const r = takeLast([{ text: 'a' }], 5)
  assert.equal(r.messages.length, 1)
  assert.equal(r.total, 1)
  assert.equal(r.truncated, false)
})

test('超长：takeLast 参数非法按默认 3 处理（负数/0/小数/非数）', () => {
  const messages = Array.from({ length: 5 }, (_, i) => ({ text: `m${i}` }))
  for (const bad of [-1, 0, 2.5, 'abc', null, undefined, NaN]) {
    const r = takeLast(messages, bad)
    assert.equal(r.messages.length, 3, `limit=${String(bad)} 应按默认 3`)
    assert.deepEqual(r.messages.map((m) => m.text), ['m2', 'm3', 'm4'])
  }
  assert.deepEqual(takeLast(null, 2).messages, [])
  assert.equal(takeLast(messages).messages.length, 3, '不传 limit 时默认 3')
})

// ── 含压缩事件 ────────────────────────────────────────────────

test('压缩：seq 起点非 1、序号有缺口 → 照常还原，不依赖算术', () => {
  const r = reconstructMessages([
    ev(30444, 'text_delta', { text: '窗口内的答案开头' }),
    ev(31146, 'user', { text: '提问' }),
    ev(31150, 'text_delta', { text: '回答' }),
    ev(31151, 'turn_complete', { isFinal: true }),
    ev(31152, 'done', { status: 'completed' }),
  ])
  assert.equal(r.windowStart, 30444, '基线取首条 seq，不假设从 1 开始')
  assert.equal(r.droppedHead, true, '首段无 final 收尾 → 真残段，按规则丢弃')
  assert.deepEqual(roles(r), ['user', 'assistant'], '序号缺口不影响后续段的还原')
  assert.equal(r.messages[0].text, '提问')
  assert.equal(r.messages[1].text, '回答')
})

test('压缩：序号有缺口 + 首段已收尾 → 保留首段，其余段照常还原', () => {
  const r = reconstructMessages([
    ev(30444, 'text_delta', { text: '上一轮的回答' }),
    ev(30448, 'turn_complete', { isFinal: true }),
    ev(31146, 'user', { text: '新一轮提问' }),
    ev(31150, 'text_delta', { text: '新一轮回答' }),
    ev(31151, 'turn_complete', { isFinal: true }),
  ])
  assert.deepEqual(r.messages.map((m) => m.text), ['上一轮的回答', '新一轮提问', '新一轮回答'])
  assert.equal(r.messages[0].note, 'no-question')
  assert.equal(r.droppedHead, false)
})

test('压缩：窗口首段未收尾（真残段）→ 丢弃并置 droppedHead', () => {
  const r = reconstructMessages([
    ev(30444, 'text_delta', { text: '半截话' }),
    ev(31146, 'user', { text: '新问题' }),
    ev(31147, 'text_delta', { text: '新回答' }),
    ev(31148, 'turn_complete', { isFinal: true }),
  ])
  assert.equal(r.droppedHead, true)
  assert.ok(!JSON.stringify(r.messages).includes('半截话'))
  assert.deepEqual(roles(r), ['user', 'assistant'])
})

test('压缩：窗口首段已收尾但提问在窗口外 → 保留，不标 incomplete', () => {
  const r = reconstructMessages([
    ev(30444, 'text_delta', { text: '上一轮的回答' }),
    ev(31140, 'turn_complete', { isFinal: true }),
    ev(31145, 'done', { status: 'completed' }),
    ev(31146, 'user', { text: '这一轮的问题' }),
    ev(31147, 'text_delta', { text: '这一轮的回答' }),
    ev(31148, 'turn_complete', { isFinal: true }),
  ])
  assert.equal(r.droppedHead, false)
  assert.equal(r.messages[0].note, 'no-question')
  assert.equal(r.messages[0].text, '上一轮的回答')
})

test('压缩：段尾 final 后可跟 done —— done 不影响收尾判定', () => {
  const withDone = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '答' }),
    ev(3, 'turn_complete', { isFinal: true }),
    ev(4, 'done', { status: 'completed' }),
  ])
  const withoutDone = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '答' }),
    ev(3, 'turn_complete', { isFinal: true }),
  ])
  assert.equal(withDone.messages[1].note, null)
  assert.deepEqual(
    withDone.messages.map((m) => m.note),
    withoutDone.messages.map((m) => m.note),
  )
})

test('压缩：相邻同类 delta 被读取期合并成单条 → 文本仍连续、不少字', () => {
  // 实测：合并保序（command-mapping.md §一.5）。这里用「一条事件含多句」模拟合并结果。
  const r = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '第一句。第二句。第三句。' }),
    ev(3, 'turn_complete', { isFinal: true }),
  ])
  assert.equal(r.messages[1].text, '第一句。第二句。第三句。')
})

test('压缩：final 之后再现 text_delta（补救轮）→ 撤销收尾，标 incomplete', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '第一段' }),
    ev(3, 'turn_complete', { isFinal: true }),
    ev(4, 'text_delta', { text: '补救段' }),
  ])
  assert.equal(r.messages[1].text, '第一段补救段')
  assert.equal(r.messages[1].note, 'incomplete')
})

test('压缩：非 final 的 turn_complete 只算子回合边界，不算收尾', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '答' }),
    ev(3, 'turn_complete', { isFinal: false }),
  ])
  assert.equal(r.messages[1].note, 'incomplete')
})

test('压缩：turn_complete 缺 isFinal 字段 → 宽容视为收尾', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '答' }),
    ev(3, 'turn_complete', {}),
  ])
  assert.equal(r.messages[1].note, null)
})

test('压缩：输入乱序 → 内部按 seq 升序还原', () => {
  const r = reconstructMessages([
    ev(5, 'turn_complete', { isFinal: true }),
    ev(3, 'text_delta', { text: '答' }),
    ev(1, 'user', { text: '问' }),
  ])
  assert.deepEqual(r.messages.map((m) => m.text), ['问', '答'])
  assert.equal(r.windowStart, 1)
})

test('压缩：缺 seq 或非数字 seq 的事件被剔除，不污染还原', () => {
  const r = reconstructMessages([
    null,
    undefined,
    { type: 'user', data: { text: '没有 seq' } },
    { seq: 'x', type: 'user', data: { text: '坏 seq' } },
    ev(1, 'user', { text: '好问题' }),
    ev(2, 'text_delta', { text: '好回答' }),
    ev(3, 'turn_complete', { isFinal: true }),
  ])
  assert.deepEqual(r.messages.map((m) => m.text), ['好问题', '好回答'])
})

test('压缩：同一输入两次调用结果一致（无共享可变状态）', () => {
  const events = [
    ev(1, 'user', { text: '问' }),
    ev(2, 'text_delta', { text: '答' }),
    ev(3, 'turn_complete', { isFinal: true }),
  ]
  const a = reconstructMessages(events)
  const b = reconstructMessages(events)
  assert.deepEqual(a, b)
  assert.notEqual(a.messages[0], b.messages[0], '两次调用不共享同一批对象')
  a.messages[0].text = '被改过'
  assert.equal(reconstructMessages(events).messages[0].text, '问')
})

// ── queue_pending（steered 输入）与注入前缀 ────────────────────

test('queue_pending：运行期间排队送入的用户原话必须被保留（标 steered）', () => {
  const text = '改造完之后呢，在QQ上给我发消息。因为我后面要离开电脑出门了。'
  const r = reconstructMessages([
    ev(31559, 'queue_pending', { text }),
    ev(31560, 'queue_status', { status: 'steered' }),
    ev(31561, 'text_delta', { text: '好的' }),
    ev(31562, 'turn_complete', { isFinal: true }),
  ])
  assert.equal(r.messages[0].role, 'user')
  assert.equal(r.messages[0].text, text)
  assert.equal(r.messages[0].note, 'steered')
  assert.equal(r.messages[0].fromSeq, 31559)
})

test('queue_pending：文本已被某条 user 事件包含时只算一次', () => {
  const r = reconstructMessages([
    ev(1, 'queue_pending', { text: '顺便把文档也更新' }),
    ev(2, 'queue_status', { status: 'steered' }),
    ev(3, 'user', { text: '[排队跟进 — 上轮运行期间排队，请一并处理] 顺便把文档也更新' }),
    ev(4, 'text_delta', { text: '收到' }),
    ev(5, 'turn_complete', { isFinal: true }),
  ])
  const users = r.messages.filter((m) => m.role === 'user')
  assert.equal(users.length, 1, '同一条输入不能出现两次')
  assert.equal(users[0].text, '顺便把文档也更新')
  assert.equal(users[0].note, null, '这条来自 user 事件本身，不是 queue_pending')
})

test('queue_pending：与 user 事件文本不重合时两条都保留', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '第一句' }),
    ev(2, 'text_delta', { text: '答' }),
    ev(3, 'turn_complete', { isFinal: true }),
    ev(4, 'queue_pending', { text: '第二句' }),
    ev(5, 'text_delta', { text: '再答' }),
    ev(6, 'turn_complete', { isFinal: true }),
  ])
  assert.deepEqual(
    r.messages.filter((m) => m.role === 'user').map((m) => m.text),
    ['第一句', '第二句'],
  )
})

test('注入前缀：[排队跟进 …] 与 [续跑] 回显前剥掉', () => {
  assert.equal(
    stripInjectedPrefix('[排队跟进 — 上轮运行期间排队，请一并处理] 原话'),
    '原话',
  )
  assert.equal(stripInjectedPrefix('[续跑] 上一轮执行被进程重启打断，从断点继续\n接着做'), '接着做')
  assert.equal(stripInjectedPrefix('原样保留 [排队跟进] 在中间'), '原样保留 [排队跟进] 在中间')
  assert.equal(stripInjectedPrefix(null), '')
  assert.equal(stripInjectedPrefix('  留白  '), '留白')
})

test('注入前缀：剥完为空的消息不产生空壳 user 消息', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '[续跑] 被打断的那一轮' }),
    ev(2, 'text_delta', { text: '接着答' }),
    ev(3, 'turn_complete', { isFinal: true }),
  ])
  assert.deepEqual(r.messages.map((m) => m.text), ['接着答'])
})

test('以 user 开头的段即使没有收尾，提问也必须留下（助手标 incomplete）', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '这条提问是真的' }),
    ev(2, 'text_delta', { text: '答到一半' }),
  ])
  assert.equal(r.messages[0].role, 'user')
  assert.equal(r.messages[0].text, '这条提问是真的')
  assert.equal(r.messages[1].note, 'incomplete')
  assert.equal(r.droppedHead, false)
})

test('无助手文本的用户独占段：只出一条 user 消息', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '问了没答' }),
    ev(2, 'done', { status: 'interrupted' }),
  ])
  assert.deepEqual(roles(r), ['user'])
  assert.equal(r.messages[0].note, null)
})

// ── 与命令层的接缝 ────────────────────────────────────────────

test('接缝：还原结果可直接喂 takeLast，得到「最近 N 条」', () => {
  const r = reconstructMessages([
    ev(1, 'user', { text: '旧问' }),
    ev(2, 'text_delta', { text: '旧答' }),
    ev(3, 'turn_complete', { isFinal: true }),
    ev(4, 'user', { text: '新问' }),
    ev(5, 'text_delta', { text: '新答' }),
    ev(6, 'turn_complete', { isFinal: true }),
  ])
  const tail = takeLast(r.messages, 2)
  assert.deepEqual(tail.messages.map((m) => m.text), ['新问', '新答'])
  assert.equal(tail.truncated, true)
  assert.equal(tail.total, 4)
})

// ── /history 的数量参数与回显格式（小类 12 的纯逻辑层）────────

test('parseHistoryLimit: 缺省 3 条', () => {
  assert.deepEqual(parseHistoryLimit([]), { limit: 3, note: null })
  assert.deepEqual(parseHistoryLimit(undefined), { limit: 3, note: null })
  assert.deepEqual(parseHistoryLimit([null, '']), { limit: 3, note: null })
})

test('parseHistoryLimit: 1..20 原样接受', () => {
  for (const n of [1, 5, 20]) {
    assert.deepEqual(parseHistoryLimit([String(n)]), { limit: n, note: null }, `n=${n}`)
  }
})

test('parseHistoryLimit: 超上限收敛到 20 并说明', () => {
  const r = parseHistoryLimit(['99'])
  assert.equal(r.limit, 20)
  assert.match(r.note, /最多 20 条/)
})

test('parseHistoryLimit: 非法值回落默认 3 且不静默', () => {
  for (const bad of ['abc', '-1', '0', '2.5', '３', '1e2']) {
    const r = parseHistoryLimit([bad])
    assert.equal(r.limit, 3, `bad=${bad}`)
    assert.ok(r.note, `bad=${bad} 必须有说明，不能静默回落`)
  }
})

test('parseHistoryLimit: 多余参数只认第一个并提示', () => {
  const r = parseHistoryLimit(['2', 'extra'])
  assert.equal(r.limit, 2)
  assert.match(r.note, /只认第一个数量/)
})

test('parseHistoryLimit: 返回值永远落在 1..20（用户输入永不透传成游标）', () => {
  for (const bad of ['abc', '-999', '99999', '0', '', '7']) {
    const { limit } = parseHistoryLimit([bad])
    assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 20, `bad=${bad} → ${limit}`)
  }
})

test('formatHistory: 空会话给明确提示而不是空白', () => {
  assert.equal(formatHistory({ messages: [] }), '这个会话还没有可回看的内容。')
  assert.equal(formatHistory(), '这个会话还没有可回看的内容。')
})

test('formatHistory: 用户与助手分标签，逐条排版', () => {
  const text = formatHistory({
    messages: [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '嗨' },
    ],
    total: 2,
  })
  assert.match(text, /最近 2 条/)
  assert.match(text, /您：你好/)
  assert.match(text, /天枢：嗨/)
})

test('formatHistory: 截断 / 残段 / 参数说明三行提示齐全', () => {
  const text = formatHistory({
    messages: [{ role: 'user', text: 'x' }],
    truncated: true,
    total: 9,
    droppedHead: true,
    limitNote: '一次最多 20 条，按上限显示',
  })
  assert.match(text, /会话共还原 9 条/)
  assert.match(text, /只显示尾部这些/)
  assert.match(text, /开头那一轮不完整，已略过/)
  assert.match(text, /一次最多 20 条/)
})

test('formatHistory: 单条超长截断并注明原字数', () => {
  const long = 'a'.repeat(1200)
  const text = formatHistory({ messages: [{ role: 'assistant', text: long }] })
  assert.ok(text.includes('（原 1200 字，已截断）'))
  assert.ok(text.includes(`${'a'.repeat(HISTORY_MSG_CHARS)}…`), `应截到 ${HISTORY_MSG_CHARS} 字`)
  assert.ok(!text.includes('a'.repeat(HISTORY_MSG_CHARS + 1)), '不得原样吐出超长正文')
})

test('formatHistory: 短文本不截断、不带标注', () => {
  const text = formatHistory({ messages: [{ role: 'user', text: '短' }] })
  assert.ok(!text.includes('已截断'))
  assert.match(text, /您：短/)
})

test('formatHistory: 三类标注都翻成人话', () => {
  const text = formatHistory({
    messages: [
      { role: 'user', text: 'a', note: 'steered' },
      { role: 'assistant', text: 'b', note: 'incomplete' },
      { role: 'assistant', text: 'c', note: 'no-question' },
    ],
  })
  assert.match(text, /运行中排队送入/)
  assert.match(text, /没有正常收尾/)
  assert.match(text, /提问不在返回的窗口内/)
})

test('formatHistory: 未知标注不原样吐英文枚举', () => {
  const text = formatHistory({ messages: [{ role: 'assistant', text: 'x', note: 'weird-note' }] })
  assert.ok(!text.includes('weird-note'))
})

// ── 条数与字数的动态分配（上限提到 20 之后）────────────────────

test('perMessageChars: 条数少给足 800，条数多自动压缩，保底 300', () => {
  assert.equal(perMessageChars(1), 800)
  assert.equal(perMessageChars(3), 800)
  assert.equal(perMessageChars(15), 800, '15 × 800 = 12000，正好压在预算上')
  assert.equal(perMessageChars(20), 600, '20 条时每条 600，总量仍守 12000')
  assert.equal(perMessageChars(50), 300, '更极端也保底 300 字')
  for (const bad of [0, -5, 'abc', null, undefined]) {
    assert.equal(perMessageChars(bad), 800, `非法条数 ${bad} 按默认 3 条处理`)
  }
})

test('formatHistory: 条数多时压缩每条并说明原因', () => {
  const long = 'x'.repeat(2000)
  const text = formatHistory({
    messages: [{ role: 'user', text: long }, { role: 'assistant', text: long }],
    maxChars: perMessageChars(20),
  })
  assert.match(text, /（条数较多，每条最多 600 字）/)
  assert.ok(text.includes('…（原 2000 字，已截断）'))
  assert.ok(!text.includes('x'.repeat(601)), '压缩后的每条不得超过 600 字')
})

test('formatHistory: 默认档位不出现压缩说明', () => {
  const text = formatHistory({ messages: [{ role: 'user', text: '短' }] })
  assert.ok(!text.includes('条数较多'))
  assert.ok(!text.includes('已截断'))
})

test('上限与预算自洽：最坏情况（20 条 × 单条上限）不超总预算', () => {
  const worst = HISTORY_MAX * Math.min(perMessageChars(HISTORY_MAX), HISTORY_MSG_CHARS)
  assert.ok(worst <= HISTORY_TOTAL_CHARS, `最坏 ${worst} 应 ≤ 预算 ${HISTORY_TOTAL_CHARS}`)
  assert.ok(HISTORY_TOTAL_CHARS < 18000, '总预算要留在 4500×4 的被动上限之内')
})
