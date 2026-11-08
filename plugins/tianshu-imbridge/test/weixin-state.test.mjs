/**
 * 微信通道状态存储（游标 / 去重集 / 凭据失效暂停 / 会话令牌）回归测试。
 *
 * 三条不许回退的行为：
 * 1. 游标非空才前进 —— 否则重启后会重放整段历史。
 * 2. 损坏的落盘文件退回空状态，不永久崩（与 session-map / command-hints 同一取舍）。
 * 3. 已见 id 有上限且淘汰最旧 —— 不能无限膨胀。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWeixinStateStore, MAX_SEEN_IDS } from '../lib/weixin/state.mjs'

function tempFile(name = 'weixin-state.json') {
  const dir = mkdtempSync(join(tmpdir(), 'wx-state-'))
  return { dir, file: join(dir, name) }
}

test('游标: 非空才前进；空串/缺字段保住旧游标', () => {
  const { dir, file } = tempFile()
  try {
    const store = makeWeixinStateStore({ file })
    assert.equal(store.getCursor(), '')
    store.setCursor('C1')
    assert.equal(store.getCursor(), 'C1')
    store.setCursor('')
    assert.equal(store.getCursor(), 'C1')
    store.setCursor('C2')
    assert.equal(store.getCursor(), 'C2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('持久化: 新实例（模拟重启）读得到游标与已见 id', () => {
  const { dir, file } = tempFile()
  try {
    const a = makeWeixinStateStore({ file })
    a.setCursor('C9')
    a.markSeen('m1')
    a.markSeen('m2')
    const b = makeWeixinStateStore({ file })
    assert.equal(b.getCursor(), 'C9')
    assert.equal(b.hasSeen('m1'), true)
    assert.equal(b.hasSeen('m2'), true)
    assert.equal(b.hasSeen('m3'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已见 id: 有上限，超出后淘汰最旧的（保留最近的）', () => {
  const { dir, file } = tempFile()
  try {
    const store = makeWeixinStateStore({ file, maxSeenIds: 3 })
    for (const id of ['a', 'b', 'c', 'd']) store.markSeen(id)
    assert.equal(store.hasSeen('a'), false, '最旧的应被淘汰')
    assert.deepEqual(['b', 'c', 'd'].map((id) => store.hasSeen(id)), [true, true, true])
    // 淘汰后再落盘、再读回，仍然一致
    const reloaded = makeWeixinStateStore({ file, maxSeenIds: 3 })
    assert.deepEqual(['b', 'c', 'd'].map((id) => reloaded.hasSeen(id)), [true, true, true])
    assert.equal(reloaded.hasSeen('a'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已见 id: 默认上限为正整数且够大', () => {
  assert.equal(Number.isInteger(MAX_SEEN_IDS), true)
  assert.ok(MAX_SEEN_IDS >= 100)
})

test('损坏文件: 退回空状态且不抛错（不永久崩）', () => {
  const { dir, file } = tempFile()
  try {
    writeFileSync(file, '{ 这不是 JSON')
    const store = makeWeixinStateStore({ file })
    assert.equal(store.getCursor(), '')
    assert.equal(store.hasSeen('m1'), false)
    // 仍可写入并落盘
    store.setCursor('C1')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).cursor, 'C1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏形状: 字段类型不对时逐字段回退，不整份丢弃', () => {
  const { dir, file } = tempFile()
  try {
    writeFileSync(file, JSON.stringify({ cursor: 42, seenMessageIds: 'nope', extra: 'x' }))
    const store = makeWeixinStateStore({ file })
    assert.equal(store.getCursor(), '')
    assert.equal(store.hasSeen('m1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭据失效暂停: 设置后有剩余时间，到期自动解除，重启后仍有效', () => {
  const { dir, file } = tempFile()
  try {
    const store = makeWeixinStateStore({ file })
    assert.equal(store.remainingPauseMs(), 0)
    store.pauseFor(60_000)
    assert.ok(store.remainingPauseMs() > 59_000)
    assert.ok(store.remainingPauseMs() <= 60_000)
    // 重启（读回）仍在暂停窗口内
    const reloaded = makeWeixinStateStore({ file })
    assert.ok(reloaded.remainingPauseMs() > 0)
    // 已过期的时间戳不算暂停
    writeFileSync(file, JSON.stringify({ pausedUntil: Date.now() - 1 }))
    assert.equal(makeWeixinStateStore({ file }).remainingPauseMs(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话令牌: 按发信人记账，取最近一次；空值不覆盖已有令牌', () => {
  const { dir, file } = tempFile('weixin-tokens.json')
  try {
    const store = makeWeixinStateStore({ file, tokenFile: file })
    store.setContextToken('u1', 'CT-1')
    store.setContextToken('u2', 'CT-2')
    assert.equal(store.getContextToken('u1'), 'CT-1')
    assert.equal(store.getContextToken('u2'), 'CT-2')
    store.setContextToken('u1', '   ')
    assert.equal(store.getContextToken('u1'), 'CT-1', '空白不该抹掉已有令牌')
    store.setContextToken('u1', 'CT-3')
    assert.equal(store.getContextToken('u1'), 'CT-3')
    // 重启后仍在（令牌存的是另一个文件，重启检查两个都要给）
    assert.equal(makeWeixinStateStore({ file, tokenFile: file }).getContextToken('u1'), 'CT-3')
    // 只给运行态文件名时令牌不落盘（两个文件是分开的，这条防止将来被悄悄合并）
    assert.equal(makeWeixinStateStore({ file }).getContextToken('u1'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话令牌: 数量有上限，淘汰最久未更新的', () => {
  const { dir, file } = tempFile('weixin-tokens.json')
  try {
    const store = makeWeixinStateStore({ file, maxContextTokens: 2 })
    store.setContextToken('u1', 'CT-1')
    store.setContextToken('u2', 'CT-2')
    store.setContextToken('u3', 'CT-3')
    assert.equal(store.getContextToken('u1'), null, '最久未更新的应被淘汰')
    assert.equal(store.getContextToken('u3'), 'CT-3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话令牌: 无文件时不炸，只活在内存里（serve 之外也能跑）', () => {
  const store = makeWeixinStateStore({ file: null })
  store.setCursor('C')
  store.setContextToken('u1', 'CT')
  store.markSeen('m1')
  assert.equal(store.getCursor(), 'C')
  assert.equal(store.getContextToken('u1'), 'CT')
  assert.equal(store.hasSeen('m1'), true)
})

test('统计: seenCount 如实反映当前去重集大小', () => {
  const { dir, file } = tempFile()
  try {
    const store = makeWeixinStateStore({ file })
    assert.equal(store.stats().seenCount, 0)
    store.markSeen('a')
    store.markSeen('b')
    assert.equal(store.stats().seenCount, 2)
    assert.equal(store.stats().cursorLength, 0)
    store.setCursor('CUR')
    assert.equal(store.stats().cursorLength, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
