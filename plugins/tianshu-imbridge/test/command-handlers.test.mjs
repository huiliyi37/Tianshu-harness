import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandHandlers, dispatchCommand, helpText } from '../lib/command-handlers.mjs'
import { parseCommand } from '../lib/command.mjs'
import { ImBridge } from '../lib/bridge.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 复刻本机真实形状：隐藏数据目录 + 3 个工作区（各自内部还带 .rivet/）。 */
const realShapeFs = () => ({
  readdirSync: () => [
    { name: '.rivet', isDirectory: () => true },
    { name: 'bridge天枢默认', isDirectory: () => true },
    { name: 'coding', isDirectory: () => true },
    { name: '日常', isDirectory: () => true },
  ],
})

const ctxOf = (text, replies) => ({
  parsed: parseCommand(text),
  reply: async (t) => { replies.push(t) },
})

test('dispatchCommand: /workspacelist 回出编号清单', async () => {
  const replies = []
  const handlers = createCommandHandlers({
    workspace: 'D:\\path\\to\\bridge天枢默认',
    fsImpl: realShapeFs(),
  })
  const hit = await dispatchCommand(ctxOf('/workspacelist', replies), handlers)
  assert.equal(hit, true)
  assert.equal(replies.length, 1)
  assert.match(replies[0], /可用工作区（3 个）/)
  assert.match(replies[0], /1\. bridge天枢默认/)
  assert.match(replies[0], /2\. coding/)
  assert.match(replies[0], /3\. 日常/)
  assert.ok(!replies[0].includes('.rivet'), '隐藏数据目录不得出现')
})

test('dispatchCommand: 别名也命中同一处理器', async () => {
  const replies = []
  const handlers = createCommandHandlers({ workspace: 'D:\\x\\ws', fsImpl: realShapeFs() })
  assert.equal(await dispatchCommand(ctxOf('/wsl', replies), handlers), true)
  assert.match(replies[0], /可用工作区/)
})

test('dispatchCommand: 未知命令回帮助，不静默', async () => {
  const replies = []
  const handlers = createCommandHandlers({ workspace: 'D:\\x\\ws', fsImpl: realShapeFs() })
  const hit = await dispatchCommand(ctxOf('/nope', replies), handlers)
  assert.equal(hit, false)
  assert.equal(replies.length, 1, '必须有回执')
  assert.match(replies[0], /不认识的命令/)
  assert.match(replies[0], /\/workspacelist/)
})

test('dispatchCommand: 未配置工作区根时报出可读提示而不是空清单', async () => {
  const replies = []
  const handlers = createCommandHandlers({ workspace: null, fsImpl: realShapeFs() })
  await dispatchCommand(ctxOf('/workspacelist', replies), handlers)
  assert.match(replies[0], /未配置工作区根目录/)
})

test('helpText: 随注册表增长，不另立清单', () => {
  assert.match(helpText({ workspacelist: () => {} }), /\/workspacelist/)
  const grown = helpText({ workspacelist: () => {}, history: () => {} })
  assert.match(grown, /\/history/)
  assert.match(grown, /\/workspacelist/)
})

test('dispatchCommand: 原型链上的名字不能调到处理器（查表走 hasOwn）', async () => {
  const replies = []
  const handlers = createCommandHandlers({ workspace: 'D:\\x\\ws', fsImpl: realShapeFs() })
  const hit = await dispatchCommand(
    { parsed: { kind: 'command', name: 'constructor', args: [] }, reply: async (t) => { replies.push(t) } },
    handlers,
  )
  assert.equal(hit, false, '不得命中')
  assert.match(replies[0], /不认识的命令/)
})

// ── /workspace：切换与重绑（小类 8）──────────────────────────

const WS_CFG = 'D:\\path\\to\\bridge天枢默认'
const ROOT_CFG = 'D:\\path\\to'

/** 同时支持列目录与 stat 的假 fs。 */
const switchFs = ({ missing = [] } = {}) => ({
  readdirSync: () => [
    { name: '.rivet', isDirectory: () => true },
    { name: 'bridge天枢默认', isDirectory: () => true },
    { name: 'coding', isDirectory: () => true },
    { name: '日常', isDirectory: () => true },
  ],
  statSync: (p) => {
    if (missing.some((m) => String(p).includes(m))) throw new Error('ENOENT')
    return { isDirectory: () => true }
  },
})

/** serve 替身：记录建会话与推进的入参。 */
const mkServe = () => {
  const calls = { created: [], prompted: [] }
  return {
    calls,
    client: {
      available: true,
      getSession: async (id) => ({ id, lastSeq: 0 }),
      createSession: async (a) => { calls.created.push(a); return { id: `S-${calls.created.length}` } },
      promptSession: async (id, p) => { calls.prompted.push({ id, p }) },
      waitForReply: async () => ({ text: '模型回复', lastSeq: 1, timedOut: false, error: null }),
    },
  }
}

/** 绑定表替身：记录每一次 set/del，便于断言「零改动」。 */
const mkMap = (initial = []) => {
  const m = new Map(initial)
  const log = []
  return {
    log,
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { log.push(['set', k, v]); m.set(k, v) },
    del: (k) => { log.push(['del', k]); m.delete(k) },
    size: () => m.size,
    raw: m,
  }
}

const runWorkspace = async (arg, { serve = true, fs = switchFs(), map = mkMap([['c2c:u', 'S-OLD']]) } = {}) => {
  const replies = []
  const { calls, client } = mkServe()
  const handlers = createCommandHandlers({
    workspace: WS_CFG,
    fsImpl: fs,
    serveClient: serve ? client : null,
    sessionMap: map,
  })
  await dispatchCommand(
    { parsed: parseCommand(`/workspace ${arg}`.trim()), key: 'c2c:u', reply: async (t) => { replies.push(t) } },
    handlers,
  )
  return { replies, calls, map }
}

test('workspace: 按编号切换 → 新建会话的 cwd 与目标工作区逐字一致', async () => {
  const { replies, calls, map } = await runWorkspace('2')
  assert.equal(calls.created.length, 1, '应只建一个会话')
  assert.equal(calls.created[0].cwd, `${ROOT_CFG}\\coding`, 'cwd 必须落在目标工作区')
  assert.match(calls.created[0].title, /coding/)
  assert.equal(map.get('c2c:u'), 'S-1', '绑定被替换为新会话')
  assert.match(replies.join(''), /已切换到「coding」/)
  assert.match(replies.join(''), /coding/)
})

test('workspace: 按绝对路径切换 → 同样生效', async () => {
  const { calls, map } = await runWorkspace('D:\\path\\to\\日常')
  assert.equal(calls.created[0].cwd, 'D:\\path\\to\\日常')
  assert.equal(map.get('c2c:u'), 'S-1')
})

test('workspace: 换绑后桥的下一条消息用新会话，且不再建会话', async () => {
  const { calls, client, map } = (() => {
    const s = mkServe()
    return { calls: s.calls, client: s.client, map: mkMap([['c2c:u', 'S-OLD']]) }
  })()
  const handlers = createCommandHandlers({ workspace: WS_CFG, fsImpl: switchFs(), serveClient: client, sessionMap: map })
  await dispatchCommand(
    { parsed: parseCommand('/workspace 2'), key: 'c2c:u', reply: async () => {} },
    handlers,
  )
  const createdAfterSwitch = calls.created.length

  const sent = []
  const bridge = new ImBridge({
    workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
    serveClient: client, sessionMap: map,
    call: async () => { throw new Error('不应走 headless') },
    send: async (_t, text) => { sent.push(text) },
  })
  await bridge.handle({ kind: 'c2c', senderId: 'u', content: '切换后说一句', replyTarget: { scope: 'c2c', targetId: 'u', msgId: 'm' } })
  assert.equal(calls.created.length, createdAfterSwitch, '下一条消息不得再建会话')
  assert.equal(calls.prompted.length, 1)
  assert.equal(calls.prompted[0].id, 'S-1', '必须推进换绑后的新会话')
  assert.deepEqual(sent, ['模型回复'])
})

test('workspace: 非法输入只回绝，绑定表零改动、不建会话', async () => {
  const cases = ['9', '0', 'abc', 'relative/path', '']
  for (const arg of cases) {
    const { replies, calls, map } = await runWorkspace(arg)
    assert.equal(calls.created.length, 0, `${arg}：不得建会话`)
    assert.deepEqual(map.log, [], `${arg}：绑定表不得被触碰`)
    assert.equal(map.get('c2c:u'), 'S-OLD', `${arg}：原绑定保持`)
    assert.equal(replies.length, 1, `${arg}：恰好一条回绝`)
    assert.ok(!/已切换/.test(replies[0]), `${arg}：不能出现成功字样`)
  }
})

test('workspace: 目录不存在时拒绝（宿主不校验 cwd，只能自己验）', async () => {
  const { replies, calls, map } = await runWorkspace('D:\\nope\\x', { fs: switchFs({ missing: ['nope'] }) })
  assert.equal(calls.created.length, 0)
  assert.deepEqual(map.log, [])
  assert.match(replies[0], /不存在或读不到/)
})

test('workspace: 降级模式（无 serve 通道）拒绝切换且不动绑定', async () => {
  const { replies, calls, map } = await runWorkspace('2', { serve: false })
  assert.equal(calls.created.length, 0)
  assert.deepEqual(map.log, [])
  assert.match(replies[0], /降级模式/)
})

test('workspace: 建会话失败时不换绑，并把原因说清', async () => {
  const map = mkMap([['c2c:u', 'S-OLD']])
  const replies = []
  const handlers = createCommandHandlers({
    workspace: WS_CFG,
    fsImpl: switchFs(),
    serveClient: {
      available: true,
      createSession: async () => { throw new Error('宿主 500') },
    },
    sessionMap: map,
  })
  await dispatchCommand({ parsed: parseCommand('/workspace 2'), key: 'c2c:u', reply: async (t) => { replies.push(t) } }, handlers)
  assert.deepEqual(map.log, [], '失败路径不得动绑定')
  assert.match(replies[0], /切换失败（绑定未改动）/)
  assert.match(replies[0], /宿主 500/)
})

test('workspace: 宿主返回不带 id 也算失败，不写坏绑定', async () => {
  const map = mkMap([])
  const replies = []
  const handlers = createCommandHandlers({
    workspace: WS_CFG,
    fsImpl: switchFs(),
    serveClient: { available: true, createSession: async () => ({}) },
    sessionMap: map,
  })
  await dispatchCommand({ parsed: parseCommand('/workspace 1'), key: 'c2c:u', reply: async (t) => { replies.push(t) } }, handlers)
  assert.deepEqual(map.log, [])
  assert.match(replies[0], /没有返回会话 id/)
})

// ── /history：回看输出与边界（小类 12）────────────────────────

/** serve 替身：固定事件流 + 可替换的取数实现，记录取数入参。 */
const mkHistoryServe = ({ events = [], snapshot = { id: 'S-1', title: '测试会话' }, getImpl, fetchImpl } = {}) => {
  const calls = { fetched: [] }
  return {
    calls,
    client: {
      available: true,
      getSession: getImpl ?? (async () => snapshot),
      fetchEvents: fetchImpl ?? (async (id, since) => {
        calls.fetched.push({ id, since })
        return { events }
      }),
    },
  }
}

const historyEvents = () => ([
  { seq: 1, type: 'user', data: { text: '第一问' } },
  { seq: 2, type: 'text_delta', data: { text: '第一答' } },
  { seq: 3, type: 'turn_complete', data: { isFinal: true } },
  { seq: 4, type: 'user', data: { text: '第二问' } },
  { seq: 5, type: 'text_delta', data: { text: '第二答' } },
  { seq: 6, type: 'turn_complete', data: { isFinal: true } },
])

const runHistory = async (arg, { client, map = mkMap([['c2c:u', 'S-1']]) } = {}) => {
  const replies = []
  const handlers = createCommandHandlers({
    serveClient: client ?? null,
    sessionMap: map,
    workspace: WS_CFG,
    fsImpl: switchFs(),
  })
  const text = arg ? `/history ${arg}` : '/history'
  await dispatchCommand(
    { parsed: parseCommand(text), key: 'c2c:u', reply: async (t) => { replies.push(t) } },
    handlers,
  )
  return { replies, map }
}

test('history: 默认回最近 3 条，固定 since=0 取尾部窗口', async () => {
  const { client, calls } = mkHistoryServe({ events: historyEvents() })
  const { replies } = await runHistory('', { client })
  assert.equal(replies.length, 1)
  assert.match(replies[0], /最近 3 条/)
  assert.ok(replies[0].indexOf('第一问') < replies[0].indexOf('第二问'))
  assert.deepEqual(calls.fetched, [{ id: 'S-1', since: 0 }], '命令层不得产生别的游标')
})

test('history: 数量参数生效（/history 4）', async () => {
  const { client } = mkHistoryServe({ events: historyEvents() })
  const { replies } = await runHistory('4', { client })
  assert.match(replies[0], /最近 4 条/)
})

test('history: 非法数量回落默认并在正文里说明', async () => {
  const { client } = mkHistoryServe({ events: historyEvents() })
  const { replies } = await runHistory('abc', { client })
  assert.match(replies[0], /最近 3 条/)
  assert.match(replies[0], /不是正整数/)
})

test('history: 无绑定时明确提示，且不写绑定表', async () => {
  const { client } = mkHistoryServe({ events: historyEvents() })
  const { replies, map } = await runHistory('', { client, map: mkMap([]) })
  assert.match(replies[0], /还没有绑定会话/)
  assert.deepEqual(map.log, [])
})

test('history: 会话已不存在（404）时明确提示，且不破坏原绑定', async () => {
  const { client } = mkHistoryServe({ getImpl: async () => null })
  const { replies, map } = await runHistory('', { client })
  assert.match(replies[0], /已经不存在/)
  assert.deepEqual(map.log, [], '命令层不越权清理绑定')
  assert.equal(map.get('c2c:u'), 'S-1')
})

test('history: 事件流读取失败只回一句人话，绑定不动', async () => {
  const { client } = mkHistoryServe({
    fetchImpl: async () => { throw new Error('事件流失败（HTTP 500）') },
  })
  const { replies, map } = await runHistory('', { client })
  assert.match(replies[0], /读取事件流失败/)
  assert.match(replies[0], /HTTP 500/)
  assert.deepEqual(map.log, [])
})

test('history: 快照读失败（5xx）与「会话不存在」分开说', async () => {
  const { client } = mkHistoryServe({ getImpl: async () => { throw new Error('快照失败（HTTP 500）') } })
  const { replies, map } = await runHistory('', { client })
  assert.match(replies[0], /读取会话失败/)
  assert.ok(!replies[0].includes('已经不存在'), '暂时性故障不得当成会话消失')
  assert.deepEqual(map.log, [])
})

test('history: 空会话给明确提示而不是空白', async () => {
  const { client } = mkHistoryServe({ events: [] })
  const { replies } = await runHistory('', { client })
  assert.match(replies[0], /还没有可回看的内容/)
})

test('history: 降级模式（无 serve 通道）明确提示', async () => {
  const { replies, map } = await runHistory('', { client: null })
  assert.match(replies[0], /降级模式/)
  assert.deepEqual(map.log, [])
})

test('history: 上限 20 条生效，且合法值不带上限提示', async () => {
  const events = []
  let seq = 1
  for (let i = 0; i < 30; i += 1) {
    events.push({ seq: seq++, type: 'user', data: { text: `问${i}` } })
    events.push({ seq: seq++, type: 'text_delta', data: { text: `答${i}` } })
    events.push({ seq: seq++, type: 'turn_complete', data: { isFinal: true } })
  }
  const { client } = mkHistoryServe({ events })
  const { replies } = await runHistory('20', { client })
  assert.match(replies[0], /最近 20 条（会话共还原 60 条）/)
  assert.ok(!replies[0].includes('一次最多'), '20 是合法值，不该出现上限提示')
})

test('history: 超上限（30）收敛到 20 并说明', async () => {
  const { client } = mkHistoryServe({ events: historyEvents() })
  const { replies } = await runHistory('30', { client })
  assert.match(replies[0], /一次最多 20 条/)
})
