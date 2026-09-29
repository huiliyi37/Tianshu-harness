import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImBridge, MessageQueue, conversationDirName, conversationKey } from '../lib/bridge.mjs'
import { HistoryStore } from '../lib/history.mjs'
import { makeCommandHints } from '../lib/command-hints.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const silentLogger = { info() {}, warn() {}, error() {} }

test('conversationKey: c2c 用 senderId', () => {
  assert.equal(conversationKey({ kind: 'c2c', senderId: 'u1' }), 'c2c:u1')
})

test('conversationKey: group 用 groupOpenid', () => {
  assert.equal(conversationKey({ kind: 'group', groupOpenid: 'g1', senderId: 'u1' }), 'group:g1')
})

test('conversationDirName: 稳定且文件系统安全', () => {
  const a = conversationDirName('c2c:u1')
  assert.equal(a, conversationDirName('c2c:u1'))
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, conversationDirName('c2c:u2'))
})

test('MessageQueue: 同 key 严格串行', async () => {
  const q = new MessageQueue()
  const order = []
  const p1 = q.run('a', async () => { order.push('a1-start'); await sleep(15); order.push('a1-end') })
  const p2 = q.run('a', async () => { order.push('a2') })
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['a1-start', 'a1-end', 'a2'])
})

test('MessageQueue: 前序任务失败不阻塞后续', async () => {
  const q = new MessageQueue()
  const order = []
  const p1 = q.run('a', async () => { order.push('x'); throw new Error('boom') })
  const p2 = q.run('a', async () => { order.push('y') })
  await assert.rejects(p1)
  await p2
  assert.deepEqual(order, ['x', 'y'])
})

test('MessageQueue: 跨 key 并行', async () => {
  const q = new MessageQueue()
  const order = []
  await Promise.all([
    q.run('a', async () => { await sleep(15); order.push('a') }),
    q.run('b', async () => { order.push('b') }),
  ])
  assert.deepEqual(order, ['b', 'a'])
})

test('ImBridge: 全流程成功（首轮无历史，调用→回复）', async () => {
  const sent = []
  const calls = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    historyStore: new HistoryStore({ file: null }),
    call: async (opts) => { calls.push(opts); return { ok: true, text: `echo:${opts.prompt}` } },
    send: async (target, text) => { sent.push({ target, text }) },
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: 'hi',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, 'hi')
  assert.ok(calls[0].cwd.startsWith('W'))
  assert.deepEqual(sent.map((s) => s.text), ['echo:hi'])
  assert.equal(sent[0].target.msgId, 'm1')
})

test('ImBridge: 历史注入——首轮无历史，次轮含历史与上轮回复', async () => {
  const calls = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    historyStore: new HistoryStore({ file: null }),
    call: async (opts) => { calls.push(opts); return { ok: true, text: `echo:${opts.prompt.slice(-10)}` } },
    send: async () => {},
  })
  const msg = (content) => ({
    kind: 'c2c', senderId: 'u1', content,
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: `m-${content}` },
  })
  await bridge.handle(msg('one'))
  await bridge.handle(msg('two'))
  assert.equal(calls[0].prompt, 'one', '首轮应无历史包装')
  assert.ok(calls[1].prompt.startsWith('【以下是'), '次轮应带历史段')
  assert.ok(calls[1].prompt.includes('用户：one'))
  assert.ok(calls[1].prompt.includes('助手：'), '次轮应含上轮回复')
  assert.ok(calls[1].prompt.endsWith('two'), '新消息在末尾')
})

test('ImBridge: 失败回合不写入历史', async () => {
  const historyStore = new HistoryStore({ file: null })
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    historyStore,
    call: async () => ({ ok: false, error: 'boom' }),
    send: async () => {},
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: 'q',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm' },
  })
  assert.deepEqual(historyStore.get('c2c:u1'), [])
})

test('ImBridge: 不同会话历史相互独立', async () => {
  const calls = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    historyStore: new HistoryStore({ file: null }),
    call: async (opts) => { calls.push(opts.prompt); return { ok: true, text: 'ok' } },
    send: async () => {},
  })
  await bridge.handle({ kind: 'c2c', senderId: 'u1', content: 'A1', replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } })
  await bridge.handle({ kind: 'c2c', senderId: 'u2', content: 'B1', replyTarget: { scope: 'c2c', targetId: 'u2', msgId: 'm2' } })
  assert.equal(calls[0], 'A1')
  assert.equal(calls[1], 'B1', 'u2 首轮不应包含 u1 的历史')
})

test('ImBridge: 天枢失败 → 兜底回复含错误摘要', async () => {
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    call: async () => ({ ok: false, error: '超时（120s）' }),
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: 'hi',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
  })
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('失败'))
  assert.ok(sent[0].includes('超时'))
})

test('ImBridge: 空白内容不调用天枢也不回复', async () => {
  let called = 0
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    call: async () => { called += 1; return { ok: true, text: 'x' } },
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: '   \n  ',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
  })
  assert.equal(called, 0)
  assert.equal(sent.length, 0)
})

test('ImBridge: 长回复自动分片发送', async () => {
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    call: async () => ({ ok: true, text: 'z'.repeat(9100) }),
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: 'q',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
  })
  assert.ok(sent.length >= 2, `应分片发送（实际 ${sent.length} 条）`)
  assert.ok(sent.every((s) => s.length <= 4500))
})

test('ImBridge: 同会话消息串行进入天枢', async () => {
  const order = []
  let seq = 0
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    historyStore: new HistoryStore({ file: null }),
    call: async () => {
      const n = seq
      seq += 1
      order.push(`start:${n}`)
      await sleep(n === 0 ? 20 : 1)
      order.push(`end:${n}`)
      return { ok: true, text: 'ok' }
    },
    send: async () => {},
  })
  const mk = (content) => ({
    kind: 'c2c', senderId: 'u1', content,
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: `m-${content}` },
  })
  await Promise.all([bridge.handle(mk('one')), bridge.handle(mk('two'))])
  assert.deepEqual(order, ['start:0', 'end:0', 'start:1', 'end:1'])
})

test('ImBridge: workspaceOverride 时所有会话统一使用指定 cwd', async () => {
  const calls = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    workspaceOverride: 'D:/fixed/place',
    logger: silentLogger,
    ensureDir: () => {},
    call: async (opts) => { calls.push(opts); return { ok: true, text: 'ok' } },
    send: async () => {},
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: 'A',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u2', content: 'B',
    replyTarget: { scope: 'c2c', targetId: 'u2', msgId: 'm2' },
  })
  assert.equal(calls[0].cwd, 'D:/fixed/place', '不同会话也应落在指定工作区')
  assert.equal(calls[1].cwd, 'D:/fixed/place')
})

test('ImBridge: 未设 workspaceOverride 时保持按会话隔离', async () => {
  const calls = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    call: async (opts) => { calls.push(opts); return { ok: true, text: 'ok' } },
    send: async () => {},
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u1', content: 'A',
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
  })
  await bridge.handle({
    kind: 'c2c', senderId: 'u2', content: 'B',
    replyTarget: { scope: 'c2c', targetId: 'u2', msgId: 'm2' },
  })
  assert.notEqual(calls[0].cwd, calls[1].cwd, '默认应保持每会话独立目录')
})

// ── serve 原生会话模式（W5 改造）────────────────────────────────

function makeFakeServe(overrides = {}) {
  const state = { created: [], prompts: [], reply: 'SERVE:REPLY', failNextPrompt: null }
  return {
    state,
    available: true,
    async createSession(opts) { state.created.push(opts); return { id: `sess-${state.created.length}` } },
    async getSession() { return { lastSeq: 0 } },
    async promptSession(id, text) {
      if (state.failNextPrompt) {
        const mode = state.failNextPrompt
        state.failNextPrompt = null
        const error = mode === 'not-found'
          ? Object.assign(new Error('Session not found'), { code: 'session-not-found' })
          : new Error('network boom')
        throw error
      }
      state.prompts.push({ id, text })
      return { ok: true }
    },
    async waitForReply() { return { text: state.reply, lastSeq: 9 } },
    ...overrides,
  }
}

function makeSessionMap() {
  const m = new Map()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), del: (k) => m.delete(k), raw: m }
}

const mkMsg = (content, sender = 'u1') => ({
  kind: 'c2c',
  senderId: sender,
  content,
  replyTarget: { scope: 'c2c', targetId: sender, msgId: `m-${content}` },
})

test('ImBridge: serve 模式——首条消息创建会话并记录映射', async () => {
  const serve = makeFakeServe()
  const sessionMap = makeSessionMap()
  const sent = []
  let headlessCalls = 0
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient: serve,
    sessionMap,
    call: async () => { headlessCalls += 1; return { ok: true, text: 'headless' } },
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle(mkMsg('你好'))
  assert.equal(serve.state.created.length, 1, '应创建一个会话')
  assert.equal(serve.state.created[0].cwd, 'W:/ws', '会话 cwd 使用工作区')
  assert.equal(serve.state.prompts.length, 1)
  assert.equal(serve.state.prompts[0].id, 'sess-1')
  assert.equal(serve.state.prompts[0].text, '你好')
  assert.equal(sessionMap.get('c2c:u1'), 'sess-1')
  assert.equal(headlessCalls, 0, '不应走 headless')
  assert.deepEqual(sent, ['SERVE:REPLY'])
})

test('ImBridge: serve 模式——次条复用同一会话', async () => {
  const serve = makeFakeServe()
  const sessionMap = makeSessionMap()
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
    serveClient: serve, sessionMap,
    call: async () => ({ ok: true, text: '' }), send: async () => {},
  })
  await bridge.handle(mkMsg('一'))
  await bridge.handle(mkMsg('二'))
  assert.equal(serve.state.created.length, 1, '只建一次会话')
  assert.equal(serve.state.prompts.length, 2)
  assert.equal(serve.state.prompts[1].id, 'sess-1')
  assert.equal(serve.state.prompts[1].text, '二')
})

test('ImBridge: serve 模式——会话失效 → 清映射、重建并重试', async () => {
  const serve = makeFakeServe()
  serve.state.failNextPrompt = 'not-found'
  const sessionMap = makeSessionMap()
  sessionMap.set('c2c:u1', 'sess-stale')
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
    serveClient: serve, sessionMap,
    call: async () => ({ ok: true, text: '' }), send: async () => {},
  })
  await bridge.handle(mkMsg('重试'))
  assert.equal(serve.state.created.length, 1, '失效后重建 1 个')
  assert.equal(serve.state.prompts.length, 1, '重建后成功发出 1 条')
  assert.equal(sessionMap.get('c2c:u1'), 'sess-1')
})

test('ImBridge: serve 模式——其它错误 → 兜底回复', async () => {
  const serve = makeFakeServe()
  serve.state.failNextPrompt = 'network'
  const sessionMap = makeSessionMap()
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
    serveClient: serve, sessionMap,
    call: async () => ({ ok: true, text: '' }),
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle(mkMsg('x'))
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('失败'))
})

test('ImBridge: serve 不可用 → 回退 headless', async () => {
  const sessionMap = makeSessionMap()
  const calls = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
    serveClient: { available: false },
    sessionMap,
    call: async (opts) => { calls.push(opts); return { ok: true, text: 'headless-ok' } },
    send: async () => {},
  })
  await bridge.handle(mkMsg('降级'))
  assert.equal(calls.length, 1, '应走 headless')
})

test('ImBridge: serve 模式——长回复分片', async () => {
  const serve = makeFakeServe()
  serve.state.reply = 'z'.repeat(9100)
  const sessionMap = makeSessionMap()
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
    serveClient: serve, sessionMap,
    call: async () => ({ ok: true, text: '' }),
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle(mkMsg('q'))
  assert.ok(sent.length >= 2)
  assert.ok(sent.every((s) => s.length <= 4500))
})

// ── 红队回归：serve 路径的四处修复（2026-09-24）────────────────
// 自足的替身与消息构造，不依赖上面的测试助手。

const regMsg = (content) => ({
  kind: 'c2c',
  senderId: 'reg-user',
  content,
  replyTarget: { scope: 'c2c', targetId: 'reg-user', msgId: `m-${content}` },
})

const regMap = (initial) => {
  const m = new Map(initial)
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v) },
    del: (k) => { m.delete(k) },
    size: () => m.size,
  }
}

const regBridge = (serveClient, sessionMap, sent) => new ImBridge({
  workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
  serveClient, sessionMap,
  call: async () => { throw new Error('回归测试：不应走 headless') },
  send: async (_t, text) => { sent.push(text) },
})

test('回归: 会话 404 重建后游标必须归零（否则事件被全过滤成假超时）', async () => {
  const seen = []
  const serve = {
    available: true,
    getSession: async (id) => ({ id, lastSeq: 42 }),
    createSession: async () => ({ id: 'S-NEW' }),
    promptSession: async (id) => {
      if (id === 'S-OLD') {
        const error = new Error('Session not found')
        error.code = 'session-not-found'
        throw error
      }
    },
    waitForReply: async (id, opts) => {
      seen.push({ id, since: opts?.since })
      return { text: '答案', lastSeq: 1, timedOut: false, error: null }
    },
  }
  const sessionMap = regMap([['c2c:reg-user', 'S-OLD']])
  const sent = []
  await regBridge(serve, sessionMap, sent).handle(regMsg('你好'))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].id, 'S-NEW')
  assert.equal(seen[0].since, 0, '重建后的新会话必须从 0 起算')
  assert.equal(sent.join(''), '答案')
  assert.equal(sessionMap.get('c2c:reg-user'), 'S-NEW')
})

test('回归: 快照 5xx 必须保住持久绑定，不许另建会话', async () => {
  let created = 0
  const serve = {
    available: true,
    getSession: async () => {
      const error = new Error('会话快照失败（HTTP 500）')
      error.code = 'snapshot-failed'
      throw error
    },
    createSession: async () => { created += 1; return { id: 'S-NEW' } },
    promptSession: async () => {},
    waitForReply: async () => ({ text: '不应到达', lastSeq: 0, timedOut: false, error: null }),
  }
  const sessionMap = regMap([['c2c:reg-user', 'S-BOUND']])
  const sent = []
  await regBridge(serve, sessionMap, sent).handle(regMsg('你好'))
  assert.equal(created, 0, '暂时性故障不该重建会话')
  assert.equal(sessionMap.get('c2c:reg-user'), 'S-BOUND', '绑定必须保持')
  assert.match(sent.join(''), /内部错误/)
})

test('回归: 沿用旧会话且快照缺 lastSeq → 拒绝从 0 起算（否则重放历史）', async () => {
  let waited = 0
  const serve = {
    available: true,
    getSession: async (id) => ({ id, status: 'idle' }), // 故意不给 lastSeq
    createSession: async () => ({ id: 'S-NEW' }),
    promptSession: async () => {},
    waitForReply: async () => {
      waited += 1
      return { text: '【历史】本轮', lastSeq: 9, timedOut: false, error: null }
    },
  }
  const sessionMap = regMap([['c2c:reg-user', 'S-BOUND']])
  const sent = []
  await regBridge(serve, sessionMap, sent).handle(regMsg('你好'))
  assert.equal(waited, 0, '不该进入轮询')
  assert.match(sent.join(''), /lastSeq/)
  assert.ok(!sent.join('').includes('【历史】'), '历史内容绝不能进聊天窗口')
})

test('回归: 超时但有半截文本 → 必须标注不完整', async () => {
  const serve = {
    available: true,
    getSession: async (id) => ({ id, lastSeq: 0 }),
    createSession: async () => ({ id: 'S1' }),
    promptSession: async () => {},
    waitForReply: async () => ({ text: '只写了一半', lastSeq: 3, timedOut: true, error: null }),
  }
  const sent = []
  await regBridge(serve, regMap([]), sent).handle(regMsg('你好'))
  assert.match(sent.join(''), /只写了一半/)
  assert.match(sent.join(''), /不完整/)
})

// ── 回归：命令层接缝（2026-09-24）────────────────────────────
// 自足替身：分别统计「headless 的模型调用」与「serve 的推进调用」，并盯住绑定表。

const seamMsg = (content) => ({
  kind: 'c2c',
  senderId: 'seam-user',
  content,
  replyTarget: { scope: 'c2c', targetId: 'seam-user', msgId: 'm' },
})

const seamBridge = ({ wire = true, serve = true } = {}) => {
  const calls = { model: 0, prompt: 0, commands: [], prompts: [] }
  const sent = []
  const sessionMap = regMap([['c2c:seam-user', 'S-SEAM']])
  const serveClient = serve
    ? {
      available: true,
      getSession: async (id) => ({ id, lastSeq: 0 }),
      createSession: async () => ({ id: 'S-NEW' }),
      promptSession: async (id, prompt) => { calls.prompt += 1; calls.prompts.push(prompt) },
      waitForReply: async () => ({ text: '模型回复', lastSeq: 1, timedOut: false, error: null }),
    }
    : null
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient,
    sessionMap,
    call: async () => { calls.model += 1; return { ok: true, text: 'headless 回复' } },
    send: async (_t, text) => { sent.push(text) },
    onCommand: wire ? async (ctx) => { calls.commands.push(ctx.parsed) } : undefined,
  })
  return { bridge, calls, sent, sessionMap }
}

test('接缝: 已接线的命令不触发模型、不动绑定、接缝自身不回复 QQ', async () => {
  const { bridge, calls, sent, sessionMap } = seamBridge()
  await bridge.handle(seamMsg('/workspacelist'))
  assert.equal(calls.prompt, 0, 'serve 路径的模型推进必须为 0')
  assert.equal(calls.model, 0, 'headless 路径的模型调用必须为 0')
  assert.equal(calls.commands.length, 1)
  assert.equal(calls.commands[0].kind, 'command')
  assert.equal(calls.commands[0].name, 'workspacelist')
  assert.deepEqual(sent, [], '接缝本身不负责回执')
  assert.equal(sessionMap.get('c2c:seam-user'), 'S-SEAM', '绑定不得改变')
  assert.equal(sessionMap.size(), 1, '不得新增绑定')
})

test('接缝: 别名命令同样命中命令层', async () => {
  const { bridge, calls } = seamBridge()
  await bridge.handle(seamMsg('/wsl'))
  assert.equal(calls.commands.length, 1)
  assert.equal(calls.commands[0].name, 'workspacelist')
})

test('接缝: 未知命令也走命令层，不当普通消息送给模型', async () => {
  const { bridge, calls, sent } = seamBridge()
  await bridge.handle(seamMsg('/nope 1 2'))
  assert.equal(calls.prompt, 0)
  assert.equal(calls.model, 0)
  assert.equal(calls.commands.length, 1)
  assert.equal(calls.commands[0].kind, 'unknown')
  assert.deepEqual(calls.commands[0].args, ['1', '2'])
  assert.deepEqual(sent, [])
})

test('接缝: headless 模式下命令同样不调用模型', async () => {
  const { bridge, calls, sessionMap } = seamBridge({ serve: false })
  await bridge.handle(seamMsg('/history'))
  assert.equal(calls.model, 0, 'headless 的 call 必须为 0')
  assert.equal(calls.commands.length, 1)
  assert.equal(sessionMap.get('c2c:seam-user'), 'S-SEAM')
})

test('接缝: 非命令消息零改动走原路径（serve）', async () => {
  const { bridge, calls, sent } = seamBridge()
  await bridge.handle(seamMsg('你好，帮我看下这个'))
  assert.equal(calls.commands.length, 0, '命令层不得被触发')
  assert.equal(calls.prompt, 1, '应走 serve 原路径')
  assert.equal(calls.prompts[0], '你好，帮我看下这个', '内容原样传给模型')
  assert.deepEqual(sent, ['模型回复'])
})

test('接缝: 非命令消息零改动走原路径（headless）', async () => {
  const { bridge, calls, sent } = seamBridge({ serve: false })
  await bridge.handle(seamMsg('你好'))
  assert.equal(calls.commands.length, 0)
  assert.equal(calls.model, 1, '应走 headless 原路径')
  assert.deepEqual(sent, ['headless 回复'])
})

test('接缝: 以斜杠开头的路径仍走原路径（不被当成命令）', async () => {
  const { bridge, calls } = seamBridge()
  await bridge.handle(seamMsg('/home/user/x 看看这个'))
  assert.equal(calls.commands.length, 0, '路径不是命令')
  assert.equal(calls.prompt, 1, '应走原路径')
})

test('接缝: 未接线时命令按普通消息处理（保持现状、不崩）', async () => {
  const { bridge, calls, sent } = seamBridge({ wire: false })
  await bridge.handle(seamMsg('/workspacelist'))
  assert.equal(calls.commands.length, 0)
  assert.equal(calls.prompt, 1, '未接线时不得凭空吞掉消息')
  assert.deepEqual(sent, ['模型回复'])
})

test('接缝: 命令与普通消息在同键上保持先后顺序', async () => {
  const order = []
  const sessionMap = regMap([['c2c:seam-user', 'S-SEAM']])
  const ordered = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient: {
      available: true,
      getSession: async (id) => ({ id, lastSeq: 0 }),
      createSession: async () => ({ id: 'S-NEW' }),
      promptSession: async () => { order.push('model') },
      waitForReply: async () => ({ text: 'r', lastSeq: 1, timedOut: false, error: null }),
    },
    sessionMap,
    call: async () => ({ ok: true, text: '' }),
    send: async () => {},
    onCommand: async () => { order.push('command') },
  })
  const first = ordered.handle(seamMsg('一条普通消息'))
  const second = ordered.handle(seamMsg('/history'))
  await Promise.all([first, second])
  assert.deepEqual(order, ['model', 'command'], '同键必须串行且保序')
})

test('接缝: 空绑定表时命令不得凭空建会话或建绑定', async () => {
  const created = []
  const sessionMap = regMap([])
  let prompt = 0
  let model = 0
  const commands = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient: {
      available: true,
      getSession: async (id) => ({ id, lastSeq: 0 }),
      createSession: async (a) => { created.push(a); return { id: 'S-NEW' } },
      promptSession: async () => { prompt += 1 },
      waitForReply: async () => ({ text: 'r', lastSeq: 1, timedOut: false, error: null }),
    },
    sessionMap,
    call: async () => { model += 1; return { ok: true, text: '' } },
    send: async () => {},
    onCommand: async (ctx) => { commands.push(ctx.parsed) },
  })
  await bridge.handle(seamMsg('/sessions'))
  assert.equal(commands.length, 1)
  assert.equal(created.length, 0, '命令不得凭空建会话')
  assert.equal(prompt, 0)
  assert.equal(model, 0)
  assert.equal(sessionMap.size(), 0, '命令不得新增绑定')
})

// ── 回归：命令回执与兜底（2026-09-24）────────────────────────

/** 造一个「接了命令层、且用 ctx.reply 回执」的桥，返回可观测的 sent 与 stats。 */
const replyBridge = (handlerBody) => {
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient: null,
    sessionMap: regMap([]),
    call: async () => ({ ok: true, text: '模型回复' }),
    send: async (_t, text) => { sent.push(text) },
    onCommand: async (ctx) => handlerBody(ctx),
  })
  return { bridge, sent }
}

test('回执: 长回执按既有上限分片，每片不超 4500', async () => {
  const { bridge, sent } = replyBridge((ctx) => ctx.reply('z'.repeat(9100)))
  await bridge.handle(seamMsg('/sessions'))
  assert.ok(sent.length >= 2, `应分片，实得 ${sent.length} 片`)
  assert.ok(sent.every((x) => x.length <= 4500), '每片都不得超过 4500')
  const joined = sent.join('')
  assert.ok(joined.includes('z'.repeat(9100)), '原文无损')
  assert.ok(joined.endsWith('（/help 看全部命令）'), '末尾挂着命令提示（分片不吞提示）')
})

test('回执: 超长回执按被动条数上限截断并附提示', async () => {
  const { bridge, sent } = replyBridge((ctx) => ctx.reply('y'.repeat(25000)))
  await bridge.handle(seamMsg('/sessions'))
  assert.equal(sent.length, 4, 'c2c 被动上限 4 条')
  assert.match(sent[sent.length - 1], /截断/, '末片应是截断提示')
  assert.ok(sent.every((x) => x.length <= 4500))
})

test('回执: 空回执不发任何内容', async () => {
  const { bridge, sent } = replyBridge((ctx) => ctx.reply(''))
  await bridge.handle(seamMsg('/history'))
  assert.deepEqual(sent, [])
})

test('兜底: 处理器抛错只回一句人话，且不污染 failed 口径', async () => {
  const { bridge, sent } = replyBridge(() => { throw new Error('炸了') })
  await bridge.handle(seamMsg('/sessions'))
  assert.equal(sent.length, 1, '只回一条')
  assert.match(sent[0], /命令执行出错/)
  assert.match(sent[0], /炸了/, '要带上原因，便于自查')
  const st = bridge.stats
  assert.equal(st.commands, 1)
  assert.equal(st.commandsFailed, 1)
  assert.equal(st.failed, 0, '不得串进模型路径的 failed')
  assert.equal(st.replies, 0)
})

test('兜底: 处理器异步抛错同样被兜住（不冒泡到调用方）', async () => {
  const { bridge, sent } = replyBridge(async () => { throw new Error('异步炸') })
  await bridge.handle(seamMsg('/history'))   // 不 reject 即算没冒泡
  assert.match(sent.join(''), /命令执行出错/)
  assert.equal(bridge.stats.commandsFailed, 1)
})

test('统计口径: 命令回执与模型回复互不串账', async () => {
  const { bridge, sent } = replyBridge((ctx) => ctx.reply('命令回执'))
  await bridge.handle(seamMsg('/sessions'))
  assert.equal(bridge.stats.commandReplies, 1)
  assert.equal(bridge.stats.replies, 0, '此时模型口径必须还是 0')

  await bridge.handle(seamMsg('一条普通消息'))
  assert.equal(bridge.stats.replies, 1, '模型回复计入 replies')
  assert.equal(bridge.stats.commandReplies, 1, '命令口径不得被模型回复改动')
  assert.equal(bridge.stats.commands, 1)
  assert.ok(sent[0].startsWith('命令回执'), '命令回执原样保留')
  assert.match(sent[0], /（\/help 看全部命令）$/, '命令回执末尾带提示')
  assert.equal(sent[1], '模型回复', '模型回复不受命令提示影响')
})

test('统计口径: 未接线的命令不计入命令数（它走的是原路径）', async () => {
  const { bridge } = seamBridge({ wire: false })
  await bridge.handle(seamMsg('/sessions'))
  assert.equal(bridge.stats.commands, 0, '未命中命令层就不该计账')
  assert.equal(bridge.stats.replies, 1, '它按模型回复计账')
})

test('兜底: 超长错误信息同样受 4500 上限约束（不绕过分片）', async () => {
  const { bridge, sent } = replyBridge(() => { throw new Error('E'.repeat(12000)) })
  await bridge.handle(seamMsg('/sessions'))
  assert.ok(sent.length >= 2, `应分片，实得 ${sent.length} 片`)
  assert.ok(sent.every((x) => x.length <= 4500), '兜底这条也不得超过 4500')
  assert.match(sent.join(''), /命令执行出错/)
  assert.equal(bridge.stats.commandReplies, sent.length)
})

test('端到端: /workspacelist 经接缝 → 处理器 → 分片回执（全链路）', async () => {
  const { dispatchCommand, createCommandHandlers } = await import('../lib/command-handlers.mjs')
  const sent = []
  const handlers = createCommandHandlers({
    workspace: 'D:\\path\\to\\bridge天枢默认',
    fsImpl: {
      readdirSync: () => [
        { name: '.rivet', isDirectory: () => true },
        { name: 'bridge天枢默认', isDirectory: () => true },
        { name: 'coding', isDirectory: () => true },
        { name: '日常', isDirectory: () => true },
      ],
    },
  })
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient: null,
    sessionMap: regMap([]),
    call: async () => { throw new Error('命令不得走模型') },
    send: async (_t, text) => { sent.push(text) },
    onCommand: (ctx) => dispatchCommand(ctx, handlers),
  })
  await bridge.handle(seamMsg('/wsl'))
  assert.equal(sent.length, 1, '一条回执')
  assert.match(sent[0], /1\. bridge天枢默认/)
  assert.equal(bridge.stats.commands, 1)
  assert.equal(bridge.stats.commandReplies, 1)
  assert.equal(bridge.stats.failed, 0)
  assert.equal(bridge.stats.replies, 0, '不得计入模型口径')
})

// ── 命令提示：首次教一次，之后只留一行（小类：指令可发现性）──────

test('提示: 首次用到某命令附完整用法，之后只附一行', async () => {
  const hints = makeCommandHints(null) // 纯内存版
  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws',
    logger: silentLogger,
    ensureDir: () => {},
    serveClient: null,
    sessionMap: regMap([]),
    commandHints: hints,
    call: async () => ({ ok: true, text: '模型回复' }),
    send: async (_t, text) => { sent.push(text) },
    onCommand: async (ctx) => ctx.reply('回执正文'),
  })

  await bridge.handle(seamMsg('/history'))
  assert.match(sent[0], /第一次用到 \/history/)
  assert.match(sent[0], /\/history \[N\]/, '首次要给出用法')
  assert.match(sent[0], /\/help 看全部命令/)

  await bridge.handle(seamMsg('/history'))
  assert.equal(sent[1], '回执正文\n\n（/help 看全部命令）', '第二次不再复述用法')

  await bridge.handle(seamMsg('/sessions'))
  assert.match(sent[2], /第一次用到 \/sessions/, '每条命令各教一次')
  assert.equal(hints.size(), 2)

  await bridge.handle(seamMsg('/nope'))
  assert.ok(!sent[3].includes('第一次用到'), '未知命令回的就是帮助，不再叠加提示')
})

test('提示: 未注入记忆时不复述用法（只留一行）', async () => {
  const { bridge, sent } = replyBridge((ctx) => ctx.reply('回执'))
  await bridge.handle(seamMsg('/history'))
  assert.equal(sent[0], '回执\n\n（/help 看全部命令）')
})

// ── 交互闭环：提问与审批（2026-09-25）────────────────────────
// 背景：QQ 桥对「等待用户选择」场景原本无处理路径——提问卡片（user_question）
// 不转发；审批（approval_required）干等超时。现场依据：会话档
// 20260922a9002241c88c（提问 seq 9700-9709）与 2026092273ffc9e91f0a（审批 seq 191-195）。

const ixMsg = (content) => ({
  kind: 'c2c',
  senderId: 'ix-user',
  content,
  replyTarget: { scope: 'c2c', targetId: 'ix-user', msgId: `m-${content}` },
})

/** 自足的交互场景替身：waitForReply 按脚本逐次返回；记录 answerIntervention 调用。 */
function makeIxServe(script) {
  let n = 0
  const state = { prompts: [], answers: [], failAnswer: null }
  return {
    state,
    available: true,
    async getSession(id) { return { id, lastSeq: 0 } },
    async createSession() { return { id: 'S-IX' } },
    async promptSession(id, text) { state.prompts.push({ id, text }) },
    async waitForReply() {
      const r = script[Math.min(n, script.length - 1)]
      n += 1
      return typeof r === 'function' ? r() : r
    },
    async answerIntervention(sessionId, requestId, opts) {
      if (state.failAnswer) {
        const mode = state.failAnswer
        state.failAnswer = null
        const error = mode === 'not-found'
          ? Object.assign(new Error('Pending intervention not found'), { code: 'intervention-not-found' })
          : Object.assign(new Error('HTTP 500'), { code: 'answer-failed' })
        throw error
      }
      state.answers.push({ sessionId, requestId, ...opts })
      return { ok: true }
    },
  }
}

const ixBridge = (serve, sent) => new ImBridge({
  workspaceRoot: 'W:/ws',
  logger: silentLogger,
  ensureDir: () => {},
  serveClient: serve,
  sessionMap: regMap([['c2c:ix-user', 'S-IX']]),
  call: async () => { throw new Error('交互测试：不应走 headless') },
  send: async (_t, text) => { sent.push(text) },
})

const Q_CARD = {
  toolUseId: 'c1',
  questions: [{ id: 'q1', prompt: '选哪条？', options: ['甲', '乙', '丙'], allowMultiple: false }],
}

test('提问: 回合完成带问题卡片 → 选项被转发到 QQ', async () => {
  const serve = makeIxServe([
    { text: '请您示下', lastSeq: 5, timedOut: false, error: null, questions: [Q_CARD], needInput: null },
  ])
  const sent = []
  await ixBridge(serve, sent).handle(ixMsg('干活'))
  const body = sent.join('\n')
  assert.match(body, /请您示下/)
  assert.match(body, /选哪条？/)
  assert.match(body, /1\. 甲/)
  assert.match(body, /2\. 乙/)
  assert.match(body, /3\. 丙/)
  assert.match(body, /回复编号/)
})

test('提问: 之后回复编号 → 翻译为选项原文送入会话', async () => {
  const serve = makeIxServe([
    { text: '请您示下', lastSeq: 5, timedOut: false, error: null, questions: [Q_CARD], needInput: null },
    { text: '好的', lastSeq: 9, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const sent = []
  const bridge = ixBridge(serve, sent)
  await bridge.handle(ixMsg('干活'))
  await bridge.handle(ixMsg('2'))
  assert.equal(serve.state.prompts.length, 2)
  assert.equal(serve.state.prompts[1].text, '乙', '编号被翻译成选项原文')
})

test('提问: 越界编号原样送入（交给模型自己理解）', async () => {
  const serve = makeIxServe([
    { text: '', lastSeq: 5, timedOut: false, error: null, questions: [Q_CARD], needInput: null },
    { text: 'r', lastSeq: 9, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const bridge = ixBridge(serve, [])
  await bridge.handle(ixMsg('干活'))
  await bridge.handle(ixMsg('9'))
  assert.equal(serve.state.prompts[1].text, '9', '越界编号不得被误翻')
})

test('提问: 多选「1,3」翻译为两行选项原文', async () => {
  const serve = makeIxServe([
    { text: '', lastSeq: 5, timedOut: false, error: null, questions: [Q_CARD], needInput: null },
    { text: 'r', lastSeq: 9, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const bridge = ixBridge(serve, [])
  await bridge.handle(ixMsg('干活'))
  await bridge.handle(ixMsg('1,3'))
  assert.equal(serve.state.prompts[1].text, '甲\n丙')
})

test('提问: 编号只翻译一次（消费后普通数字按原样）', async () => {
  const serve = makeIxServe([
    { text: '', lastSeq: 5, timedOut: false, error: null, questions: [Q_CARD], needInput: null },
    { text: 'r', lastSeq: 9, timedOut: false, error: null, questions: [], needInput: null },
    { text: 'r', lastSeq: 12, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const bridge = ixBridge(serve, [])
  await bridge.handle(ixMsg('干活'))
  await bridge.handle(ixMsg('2'))
  await bridge.handle(ixMsg('2'))
  assert.equal(serve.state.prompts[1].text, '乙')
  assert.equal(serve.state.prompts[2].text, '2', '第二条 2 不再被翻译（问题已消费）')
})

test('审批: needInput → 转发审批卡片并进入等待态', async () => {
  const serve = makeIxServe([
    {
      text: '', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: { approvals: [{ requestId: 'r1', toolName: 'bash', input: { command: 'git reset --hard' } }] },
    },
  ])
  const sent = []
  await ixBridge(serve, sent).handle(ixMsg('执行'))
  const body = sent.join('\n')
  assert.match(body, /请求您的批准/)
  assert.match(body, /bash/)
  assert.match(body, /git reset --hard/)
  assert.match(body, /批准.*拒绝/)
})

test('审批: 卡片带出已有正文（部分文本不丢）', async () => {
  const serve = makeIxServe([
    {
      text: '我先跑个命令', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: { approvals: [{ requestId: 'r1', toolName: 'bash', input: {} }] },
    },
  ])
  const sent = []
  await ixBridge(serve, sent).handle(ixMsg('执行'))
  assert.match(sent.join('\n'), /我先跑个命令/)
  assert.match(sent.join('\n'), /请求您的批准/)
})

test('审批: 回复「批准」→ 提交 approve + 继续等待并送出后续文本', async () => {
  const serve = makeIxServe([
    {
      text: '', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: { approvals: [{ requestId: 'r1', toolName: 'bash', input: { command: 'x' } }] },
    },
    { text: '执行完了', lastSeq: 12, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const sent = []
  const bridge = ixBridge(serve, sent)
  await bridge.handle(ixMsg('执行'))
  await bridge.handle(ixMsg('批准'))
  assert.equal(serve.state.answers.length, 1)
  assert.deepEqual(serve.state.answers[0], { sessionId: 'S-IX', requestId: 'r1', decision: 'approve' })
  assert.ok(sent.join('\n').includes('执行完了'), '批准后续收的回合文本要送出')
})

test('审批: 回复「拒绝」→ 提交 deny', async () => {
  const serve = makeIxServe([
    {
      text: '', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: { approvals: [{ requestId: 'r1', toolName: 'bash', input: {} }] },
    },
    { text: '好，换个方式', lastSeq: 12, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const sent = []
  const bridge = ixBridge(serve, sent)
  await bridge.handle(ixMsg('执行'))
  await bridge.handle(ixMsg('拒绝'))
  assert.deepEqual(serve.state.answers[0], { sessionId: 'S-IX', requestId: 'r1', decision: 'deny' })
  assert.ok(sent.join('\n').includes('好，换个方式'))
})

test('审批: 等待态下回复普通内容 → 只提示，不送模型、不提交', async () => {
  const serve = makeIxServe([
    {
      text: '', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: { approvals: [{ requestId: 'r1', toolName: 'bash', input: {} }] },
    },
  ])
  const sent = []
  const bridge = ixBridge(serve, sent)
  await bridge.handle(ixMsg('执行'))
  await bridge.handle(ixMsg('你好呀'))
  assert.equal(serve.state.answers.length, 0, '不得误提交')
  assert.equal(serve.state.prompts.length, 1, '不得把「你好呀」送进会话')
  assert.match(sent.join('\n'), /批准.*拒绝/, '要提示怎么作答')
})

test('审批: 多个排队 → 批准第一个后转发第二个，全部批完继续收尾', async () => {
  const serve = makeIxServe([
    {
      text: '', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: {
        approvals: [
          { requestId: 'r1', toolName: 'bash', input: { command: 'one' } },
          { requestId: 'r2', toolName: 'write_file', input: { path: 'x' } },
        ],
      },
    },
    { text: '都做完了', lastSeq: 20, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const sent = []
  const bridge = ixBridge(serve, sent)
  await bridge.handle(ixMsg('执行'))     // 卡片1
  await bridge.handle(ixMsg('批准'))     // 批 r1 → 转发卡片2
  await bridge.handle(ixMsg('批准'))     // 批 r2 → 继续等 → 收尾文本
  assert.deepEqual(serve.state.answers.map((a) => a.requestId), ['r1', 'r2'])
  assert.match(sent.join('\n'), /one/)
  assert.match(sent.join('\n'), /write_file/)
  assert.ok(sent.join('\n').includes('都做完了'))
})

test('审批: 提交 404（已失效）→ 清等待态并提示，后续消息走正常路径', async () => {
  const serve = makeIxServe([
    {
      text: '', lastSeq: 7, timedOut: false, error: null, questions: [],
      needInput: { approvals: [{ requestId: 'r1', toolName: 'bash', input: {} }] },
    },
    { text: '正常回合', lastSeq: 12, timedOut: false, error: null, questions: [], needInput: null },
  ])
  const sent = []
  const bridge = ixBridge(serve, sent)
  await bridge.handle(ixMsg('执行'))
  serve.state.failAnswer = 'not-found'
  await bridge.handle(ixMsg('批准'))
  assert.match(sent.join('\n'), /失效/)
  assert.equal(serve.state.answers.length, 0)
  // 等待态已清：下一条普通消息正常进会话
  await bridge.handle(ixMsg('再来一条'))
  assert.equal(serve.state.prompts.length, 2)
  assert.equal(serve.state.prompts[1].text, '再来一条')
})

test('parseApprovalReply: 批准/拒绝词表与边界', async () => {
  const { parseApprovalReply } = await import('../lib/bridge.mjs')
  assert.equal(parseApprovalReply('批准'), 'approve')
  assert.equal(parseApprovalReply(' 同意。'), 'approve')
  assert.equal(parseApprovalReply('OK'), 'approve')
  assert.equal(parseApprovalReply('可以'), 'approve')
  assert.equal(parseApprovalReply('拒绝'), 'deny')
  assert.equal(parseApprovalReply('deny'), 'deny')
  assert.equal(parseApprovalReply('不同意'), 'deny')
  assert.equal(parseApprovalReply('你好'), null)
  assert.equal(parseApprovalReply('批准了但是等一下'), null, '只认整句，不认包含')
  assert.equal(parseApprovalReply(''), null)
})

test('formatApprovalCard: 超长命令截断并标注', async () => {
  const { formatApprovalCard } = await import('../lib/bridge.mjs')
  const card = formatApprovalCard({ toolName: 'bash', input: { command: 'z'.repeat(5000) } })
  assert.match(card, /bash/)
  assert.match(card, /截断/)
  assert.ok(card.length < 3000, '卡片不得无界膨胀')
})
