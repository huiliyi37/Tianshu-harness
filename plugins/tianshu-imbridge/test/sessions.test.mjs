import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSessionMap } from '../lib/session-map.mjs'
import { ImBridge } from '../lib/bridge.mjs'
import { createCommandHandlers, dispatchCommand } from '../lib/command-handlers.mjs'
import { parseCommand } from '../lib/command.mjs'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  formatSessionList,
  listSessions,
  normalizePath,
  normalizeSessions,
  parseSessionArgs,
  resolveSessionTarget,
  workspaceNameOf,
} from '../lib/sessions.mjs'

const raw = (over = {}) => ({
  id: 'S1', title: '标题一', cwd: 'D:\\path\\to\\coding',
  updatedAt: 1000, status: 'idle', ...over,
})

// ── 规整与排序 ───────────────────────────────────────────────

test('normalizeSessions: 可选字段缺失不炸，无标题有兜底', () => {
  const items = normalizeSessions([
    { id: 'A' },                                  // 只有 id：title/cwd/updatedAt 全缺
    raw({ id: 'B', title: '   ' }),               // 空白标题
    raw({ id: 'C', missionId: undefined, error: 'No usable API key' }),
    { title: '没有 id 的' },                       // 无 id → 丢弃
    null,
  ])
  assert.equal(items.length, 3)
  assert.equal(items.find((x) => x.id === 'A').title, '（无标题）')
  assert.equal(items.find((x) => x.id === 'A').workspace, '（未知工作区）')
  assert.equal(items.find((x) => x.id === 'B').title, '（无标题）')
  assert.equal(items.find((x) => x.id === 'C').failed, true)
})

test('normalizeSessions: 按 updatedAt 降序，并列按 id 兜底（确定可复现）', () => {
  const items = normalizeSessions([
    raw({ id: 'old', updatedAt: 1 }),
    raw({ id: 'new', updatedAt: 99 }),
    raw({ id: 'b', updatedAt: 50 }),
    raw({ id: 'a', updatedAt: 50 }),
  ])
  assert.deepEqual(items.map((x) => x.id), ['new', 'a', 'b', 'old'])
})

test('normalizeSessions: 缺 updatedAt 视为 0，排最后', () => {
  const items = normalizeSessions([{ id: 'x' }, raw({ id: 'y', updatedAt: 5 })])
  assert.deepEqual(items.map((x) => x.id), ['y', 'x'])
})

test('normalizePath / workspaceNameOf: 正反斜杠与大小写归一', () => {
  assert.equal(normalizePath('D:\\path\\to\\Coding\\'), normalizePath('D:/path/to/coding'))
  assert.equal(workspaceNameOf('D:\\path\\to\\日常'), '日常')
  assert.equal(workspaceNameOf(''), '（未知工作区）')
})

// ── 参数解析 ─────────────────────────────────────────────────

test('parseSessionArgs: 空参数 / 序号 / --limit / 二者', () => {
  assert.deepEqual(parseSessionArgs([]), { workspaceIndex: null, limit: null, error: null })
  assert.deepEqual(parseSessionArgs(['2']), { workspaceIndex: 2, limit: null, error: null })
  assert.deepEqual(parseSessionArgs(['--limit', '5']), { workspaceIndex: null, limit: 5, error: null })
  assert.deepEqual(parseSessionArgs(['2', '--limit', '5']), { workspaceIndex: 2, limit: 5, error: null })
  assert.deepEqual(parseSessionArgs(['--limit', '5', '2']), { workspaceIndex: 2, limit: 5, error: null })
})

test('parseSessionArgs: 非法输入给可读错误', () => {
  assert.match(parseSessionArgs(['--limit']).error, /正整数/)
  assert.match(parseSessionArgs(['--limit', '0']).error, /正整数/)
  assert.match(parseSessionArgs(['--limit', 'abc']).error, /正整数/)
  assert.match(parseSessionArgs(['x']).error, /不认识的参数/)
  assert.match(parseSessionArgs(['1', '2']).error, /只能给一个工作区序号/)
})

test('parseSessionArgs: limit 超过硬上限时收到 MAX_LIMIT', () => {
  assert.equal(parseSessionArgs(['--limit', '999']).limit, MAX_LIMIT)
})

// ── 格式化 ───────────────────────────────────────────────────

test('formatSessionList: 编号从 1、标注工作区、标出当前绑定', () => {
  const items = normalizeSessions([
    raw({ id: 'S1', title: '甲', updatedAt: 2 }),
    raw({ id: 'S2', title: '乙', updatedAt: 1, cwd: 'D:\\path\\to\\日常' }),
  ])
  const r = formatSessionList(items, { boundId: 'S2' })
  assert.match(r.lines[0], /会话（2 个）/)
  assert.match(r.lines[1], /^1\. 甲（coding）$/)
  assert.match(r.lines[2], /^2\. 乙（日常，← 本条对话线当前绑定）$/)
})

test('formatSessionList: 失败会话有标记，长标题被截断', () => {
  const items = normalizeSessions([raw({ id: 'S1', title: 'T'.repeat(80), error: 'boom' })])
  const line = formatSessionList(items).lines[1]
  assert.match(line, /上次失败/)
  assert.ok(line.length < 70, `行长应受控，实得 ${line.length}`)
  assert.match(line, /…/)
})

test('formatSessionList: 空清单给明确提示而非空白', () => {
  const r = formatSessionList([], { scopeNote: '，限于工作区「coding」' })
  assert.equal(r.total, 0)
  assert.match(r.text, /会话（0 个，限于工作区「coding」）/)
  assert.match(r.text, /还没有会话/)
})

test('formatSessionList: 超出上限截断并说明', () => {
  const items = normalizeSessions(Array.from({ length: 25 }, (_, i) => raw({ id: `S${i}`, updatedAt: i })))
  const r = formatSessionList(items, { limit: DEFAULT_LIMIT })
  assert.equal(r.shown, DEFAULT_LIMIT)
  assert.equal(r.truncated, true)
  assert.match(r.text, /还有 15 个未列出/)
})

// ── 取数 ─────────────────────────────────────────────────────

const serveStub = (sessions) => ({ available: true, listSessions: async () => sessions })

test('listSessions: 降级模式给可读提示而不是空清单', async () => {
  const r = await listSessions({ serveClient: null })
  assert.match(r.error, /降级模式/)
})

test('listSessions: 宿主报错时把原因带出来', async () => {
  const r = await listSessions({ serveClient: { available: true, listSessions: async () => { throw new Error('500') } } })
  assert.match(r.error, /取会话清单失败/)
  assert.match(r.error, /500/)
})

test('listSessions: 工作区过滤按归一化后的路径比较（正反斜杠/大小写都算同一处）', async () => {
  const sessions = [
    raw({ id: 'S1', cwd: 'D:/path/to/coding' }),
    raw({ id: 'S2', cwd: 'D:\\path\\to\\日常' }),
    raw({ id: 'S3', cwd: 'D:\\path\\to\\CODING' }),
  ]
  const wsFs = {
    readdirSync: () => [
      { name: '.rivet', isDirectory: () => true },
      { name: 'bridge天枢默认', isDirectory: () => true },
      { name: 'coding', isDirectory: () => true },
      { name: '日常', isDirectory: () => true },
    ],
  }
  const r = await listSessions({
    serveClient: serveStub(sessions),
    workspace: 'D:\\path\\to\\bridge天枢默认',
    workspaceIndex: 2,
    fsImpl: wsFs,
  })
  assert.equal(r.error, null)
  assert.deepEqual(r.items.map((x) => x.id).sort(), ['S1', 'S3'], 'coding 的两个都该进来')
  assert.match(r.scopeNote, /coding/)
})

test('listSessions: 工作区序号越界 → 明确拒绝', async () => {
  const r = await listSessions({
    serveClient: serveStub([raw()]),
    workspace: 'D:\\path\\to\\bridge天枢默认',
    workspaceIndex: 9,
    fsImpl: { readdirSync: () => [{ name: 'coding', isDirectory: () => true }] },
  })
  assert.match(r.error, /没有第 9 个工作区/)
})

const silentLogger = { info() {}, warn() {}, error() {} }

// ── /session：绑定与失效处理（小类 10）────────────────────────

const bindServe = (sessions = [], { getImpl } = {}) => ({
  available: true,
  listSessions: async () => sessions,
  getSession: getImpl ?? (async (id) => sessions.find((s) => s.id === id) ?? null),
})

test('resolveSessionTarget: 空参数 / 编号在范围内 / 编号越界', async () => {
  const sessions = [
    raw({ id: 'S1', title: '甲', updatedAt: 3 }),
    raw({ id: 'S2', title: '乙', updatedAt: 2 }),
    raw({ id: 'S3', title: '丙', updatedAt: 1 }),
  ]
  assert.match((await resolveSessionTarget('', { serveClient: bindServe(sessions) })).error, /用法/)
  const ok = await resolveSessionTarget('2', { serveClient: bindServe(sessions) })
  assert.equal(ok.ok, true)
  assert.equal(ok.session.id, 'S2', '编号与 /sessions 的降序同源')
  const bad = await resolveSessionTarget('9', { serveClient: bindServe(sessions) })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /没有第 9 个会话/)
  assert.match(bad.error, /3 个/)
})

test('resolveSessionTarget: 按会话 ID 绑定，404 与 5xx 分开说', async () => {
  const sessions = [raw({ id: 'S1', title: '甲' })]
  const ok = await resolveSessionTarget('S1', { serveClient: bindServe(sessions) })
  assert.equal(ok.ok, true)
  assert.equal(ok.session.title, '甲')

  const missing = await resolveSessionTarget('S-none', { serveClient: bindServe(sessions) })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /找不到这个会话/)

  const broken = await resolveSessionTarget('S-x', {
    serveClient: bindServe(sessions, { getImpl: async () => { throw new Error('HTTP 500') } }),
  })
  assert.match(broken.error, /无法确认会话/)
})

test('resolveSessionTarget: 降级模式下按 ID 绑定被明确拒绝', async () => {
  const r = await resolveSessionTarget('S1', { serveClient: null })
  assert.match(r.error, /降级模式/)
})

/** 跑一次 /session，返回回执与绑定表日志。 */
const runBind = async (arg, { sessions = [raw({ id: 'S1', title: '甲' })], initial = [['c2c:u', 'S-OLD']] } = {}) => {
  const replies = []
  const log = []
  const m = new Map(initial)
  const sessionMap = {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { log.push(['set', k, v]); m.set(k, v) },
    del: (k) => { log.push(['del', k]); m.delete(k) },
    size: () => m.size,
  }
  const handlers = createCommandHandlers({ serveClient: bindServe(sessions), sessionMap })
  const hit = await dispatchCommand(
    { parsed: parseCommand(`/session ${arg}`.trim()), key: 'c2c:u', reply: async (t) => { replies.push(t) } },
    handlers,
  )
  return { replies, log, sessionMap, hit }
}

test('session: 绑定成功 → 写绑定表、回执说明替换了原绑定', async () => {
  const { replies, log, sessionMap } = await runBind('1')
  assert.deepEqual(log, [['set', 'c2c:u', 'S1']])
  assert.equal(sessionMap.get('c2c:u'), 'S1')
  assert.match(replies[0], /已绑定到会话「甲」/)
  assert.match(replies[0], /下一条消息将进入该会话/)
  assert.match(replies[0], /原绑定 S-OLD… 已被替换/, '回执要说清换掉了哪一条')
})

test('session: 无效目标只回绝，绑定表零改动', async () => {
  for (const arg of ['9', 'S-none', '']) {
    const { replies, log, sessionMap } = await runBind(arg, { sessions: [raw({ id: 'S1', title: '甲' })] })
    assert.deepEqual(log, [], `${arg}：不得写绑定`)
    assert.equal(sessionMap.get('c2c:u'), 'S-OLD', `${arg}：原绑定保持`)
    assert.equal(replies.length, 1, `${arg}：恰好一条回绝`)
    assert.ok(!/已绑定/.test(replies[0]))
  }
})

// ── 落盘与重启后生效（拿真实现、真文件验）────────────────────

test('落盘: 绑定写进真实文件，全新模块实例（模拟重启）仍读得到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmap-'))
  const file = join(dir, 'session-map.json')
  try {
    const map = makeSessionMap(file)
    map.set('c2c:u1', 'S-abc')
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))['c2c:u1'], 'S-abc', '必须落盘')

    // 换一个模块实例读同一个文件 = 重启语义
    const fresh = await import('../lib/session-map.mjs?v=restart')
    assert.equal(fresh.makeSessionMap(file).get('c2c:u1'), 'S-abc', '新实例必须从盘上读到')

    // 删除也要落盘
    map.del('c2c:u1')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('落盘: 文件内容是坏形状时退回空表，不永久崩', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmap-'))
  const file = join(dir, 'session-map.json')
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'null')
    const map = makeSessionMap(file)
    assert.equal(map.get('c2c:u1'), null)
    assert.equal(map.size(), 0)
    map.set('c2c:u1', 'S-1')
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))['c2c:u1'], 'S-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('绑定后下一条消息进入被绑会话（真实绑定表 + 桥 + 落盘）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmap-'))
  const file = join(dir, 'session-map.json')
  try {
    // 走完整命令：/session 1 → 落盘
    const sessions = [raw({ id: 'S-TARGET', title: '目标会话' })]
    const replies = []
    const handlers = createCommandHandlers({
      serveClient: bindServe(sessions),
      sessionMap: makeSessionMap(file),
    })
    await dispatchCommand(
      { parsed: parseCommand('/session 1'), key: 'c2c:u', reply: async (t) => { replies.push(t) } },
      handlers,
    )
    assert.match(replies[0], /已绑定到会话「目标会话」/)

    // 用盘上那份绑定表（新实例）喂给桥
    const fresh = await import('../lib/session-map.mjs?v=bind-e2e')
    const map = fresh.makeSessionMap(file)
    const prompted = []
    const bridge = new ImBridge({
      workspaceRoot: 'W:/ws', logger: silentLogger, ensureDir: () => {},
      serveClient: {
        available: true,
        getSession: async (id) => ({ id, lastSeq: 0 }),
        createSession: async () => ({ id: 'S-新建' }),
        promptSession: async (id, p) => { prompted.push({ id, p }) },
        waitForReply: async () => ({ text: '回复', lastSeq: 1, timedOut: false, error: null }),
      },
      sessionMap: map,
      call: async () => { throw new Error('不应走 headless') },
      send: async () => {},
    })
    await bridge.handle({
      kind: 'c2c', senderId: 'u', content: '绑定后第一句',
      replyTarget: { scope: 'c2c', targetId: 'u', msgId: 'm' },
    })
    assert.deepEqual(prompted, [{ id: 'S-TARGET', p: '绑定后第一句' }], '下一条消息必须进入被绑会话')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 编号一致性回归（2026-09-25，大局观审视）──────────────────
// 隐患：/sessions <工作区序号> 的过滤视图曾按「过滤后序号」重排显示（1、2、3…），
// 而 /session 的编号解析按「全量清单」——两者不一致时，用户按看到的编号绑定
// 会绑到别的会话。修复方向：过滤视图沿用全量编号（条目自带 index），使
// 「显示的编号 = /session 接受的编号」恒成立。

test('listSessions: 过滤视图的条目携带全量编号（index）', async () => {
  const sessions = [
    raw({ id: 'A', title: '甲', cwd: 'D:/path/to/coding', updatedAt: 3 }),
    raw({ id: 'B', title: '乙', cwd: 'D:/path/to/日常', updatedAt: 2 }),
    raw({ id: 'C', title: '丙', cwd: 'D:/path/to/coding', updatedAt: 1 }),
  ]
  const wsFs = {
    readdirSync: () => [
      { name: 'bridge天枢默认', isDirectory: () => true },
      { name: 'coding', isDirectory: () => true },
      { name: '日常', isDirectory: () => true },
    ],
  }
  const full = await listSessions({
    serveClient: serveStub(sessions),
    workspace: 'D:\\path\\to\\bridge天枢默认',
    fsImpl: wsFs,
  })
  assert.deepEqual(full.items.map((x) => x.index), [1, 2, 3], '全量视图编号连续')

  const filtered = await listSessions({
    serveClient: serveStub(sessions),
    workspace: 'D:\\path\\to\\bridge天枢默认',
    workspaceIndex: 2, // coding
    fsImpl: wsFs,
  })
  assert.deepEqual(filtered.items.map((x) => x.id), ['A', 'C'])
  assert.deepEqual(
    filtered.items.map((x) => x.index),
    [1, 3],
    '过滤后必须保留全量编号：丙 在完整清单里是第 3 个，不是第 2 个',
  )
})

test('formatSessionList: 用条目自带编号显示；编号不连续时附一行说明', () => {
  const items = normalizeSessions([
    raw({ id: 'A', title: '甲', cwd: 'D:/path/to/coding', updatedAt: 3 }),
    raw({ id: 'C', title: '丙', cwd: 'D:/path/to/coding', updatedAt: 1 }),
  ])
  items[0].index = 1
  items[1].index = 3
  const r = formatSessionList(items, { scopeNote: '，限于工作区「coding」' })
  assert.match(r.text, /^1\. 甲/m)
  assert.match(r.text, /^3\. 丙/m, '显示的编号应是全量编号（3），不是行序（2）')
  assert.ok(!/^2\. /m.test(r.text), '没有第 2 条就不该出现 2 号')
  assert.match(r.text, /编号为完整清单中的位置/, '应解释编号为何跳跃')
})

test('formatSessionList: 全量（编号连续）时不附加说明，行为与旧版一致', () => {
  const items = normalizeSessions([
    raw({ id: 'S1', title: '甲', updatedAt: 2 }),
    raw({ id: 'S2', title: '乙', updatedAt: 1, cwd: 'D:\\path\\to\\日常' }),
  ])
  const r = formatSessionList(items, {})
  assert.match(r.lines[1], /^1\. 甲（coding）$/)
  assert.match(r.lines[2], /^2\. 乙（日常）$/)
  assert.ok(!/完整清单中的位置/.test(r.text))
})

test('编号一致性（端到端）: /sessions <工作区> 显示的编号可直接用于 /session', async () => {
  const sessions = [
    raw({ id: 'A', title: '甲', cwd: 'D:/path/to/coding', updatedAt: 3 }),
    raw({ id: 'B', title: '乙', cwd: 'D:/path/to/日常', updatedAt: 2 }),
    raw({ id: 'C', title: '丙', cwd: 'D:/path/to/coding', updatedAt: 1 }),
  ]
  const wsFs = {
    readdirSync: () => [
      { name: 'bridge天枢默认', isDirectory: () => true },
      { name: 'coding', isDirectory: () => true },
      { name: '日常', isDirectory: () => true },
    ],
  }
  // 第一步：/sessions 2 → 过滤视图（只有 coding 的甲、丙）
  const listReplies = []
  const listHandlers = createCommandHandlers({
    serveClient: bindServe(sessions),
    workspace: 'D:\\path\\to\\bridge天枢默认',
    fsImpl: wsFs,
    sessionMap: { get: () => null, set: () => {}, del: () => {}, size: () => 0 },
  })
  await dispatchCommand(
    { parsed: parseCommand('/sessions 2'), key: 'c2c:u', reply: async (t) => { listReplies.push(t) } },
    listHandlers,
  )
  const listText = listReplies[0]
  const m = listText.match(/^(\d+)\. 丙/m)
  assert.ok(m, `过滤视图应列出丙，实得：\n${listText}`)
  const shownIndex = Number(m[1])

  // 第二步：用「看到的编号」发 /session
  const binds = []
  const bindHandlers = createCommandHandlers({
    serveClient: bindServe(sessions),
    workspace: 'D:\\path\\to\\bridge天枢默认',
    fsImpl: wsFs,
    sessionMap: { get: () => null, set: (_k, v) => { binds.push(v) }, del: () => {}, size: () => 0 },
  })
  await dispatchCommand(
    { parsed: parseCommand(`/session ${shownIndex}`), key: 'c2c:u', reply: async () => {} },
    bindHandlers,
  )
  assert.deepEqual(binds, ['C'], `按显示编号 ${shownIndex} 绑定，应命中丙（C），不得错位到乙`)
})
