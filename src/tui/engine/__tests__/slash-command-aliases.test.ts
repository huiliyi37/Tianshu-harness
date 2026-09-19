/**
 * Slash command 别名机制测试（P0-1）。
 *
 * 别名存在的理由：文档/肌肉记忆里的写法与注册名不一致时，用户输入**不能**
 * 静默穿透成普通消息发给模型（/goal-cancel 幽灵命令就是这么来的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { SlashCommandRegistry } from '../../slash-command-registry.js'
import { MockOut, MockIn } from './_harness.js'

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

test('别名精确匹配解析到 canonical', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/exit', aliases: ['/quit'], handler: () => true })

  assert.equal(reg.match('/quit')?.name, '/exit')
  assert.equal(reg.match('/exit')?.name, '/exit')
  assert.equal(reg.match('/nope'), undefined)
})

test('别名带参数匹配（/别名 + 空格）', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/goal-cancel', aliases: ['/cancel-goal'], handler: () => true })

  assert.equal(reg.match('/cancel-goal')?.name, '/goal-cancel')
  assert.equal(reg.match('/cancel-goal now')?.name, '/goal-cancel')
  assert.equal(reg.match('/cancel-goalx'), undefined, '前缀不得误命中')
})

test('list() 只出 canonical，listNames() 含别名', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/exit', aliases: ['/quit'], handler: () => true })
  reg.register({ name: '/help', handler: () => true })

  assert.deepEqual(reg.list().map(c => c.name), ['/exit', '/help'])
  assert.deepEqual([...reg.listNames()].sort(), ['/exit', '/help', '/quit'])
})

test('has() 认别名，get() 只认 canonical', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/exit', aliases: ['/quit'], handler: () => true })

  assert.equal(reg.has('/quit'), true)
  assert.equal(reg.has('/exit'), true)
  assert.equal(reg.get('/quit'), undefined)
  assert.equal(reg.get('/exit')?.name, '/exit')
})

test('别名透明：handler 看到 canonical 名，ctx.input 保持原始行', async () => {
  const reg = new SlashCommandRegistry()
  let seenTrimmed = ''
  let seenInput = ''
  let seenParts0 = ''
  reg.register({
    name: '/exit',
    aliases: ['/quit'],
    handler: (ctx) => {
      seenTrimmed = ctx.trimmed
      seenInput = ctx.input
      seenParts0 = ctx.trimmed.split(/\s+/)[0]!
      return true
    },
  })

  const { app } = makeApp()
  const res = await reg.execute({ app, input: '/quit now', trimmed: '/quit now' })

  assert.equal(res.handled, true)
  assert.equal(seenTrimmed, '/exit now', 'handler 必须看到 canonical')
  assert.equal(seenParts0, '/exit', 'parts[0] 必须是 canonical')
  assert.equal(seenInput, '/quit now', 'ctx.input 保真，供显示')
})

test('别名撞已有命令名 → 忽略该别名，canonical 恒赢', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/help', handler: () => true })
  reg.register({ name: '/exit', aliases: ['/help'], handler: () => true })

  assert.equal(reg.match('/help')?.name, '/help')
  assert.equal(reg.getAliasConflicts().length, 1)
  assert.match(reg.getAliasConflicts()[0]!, /\/help/)
})

test('同一别名被两条命令争用 → 先注册者赢并留痕', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/a', aliases: ['/x'], handler: () => true })
  reg.register({ name: '/b', aliases: ['/x'], handler: () => true })

  assert.equal(reg.match('/x')?.name, '/a')
  assert.equal(reg.getAliasConflicts().length, 1)
})

test('unregister 回收别名，不留悬空索引', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/a', aliases: ['/x'], handler: () => true })

  assert.equal(reg.has('/x'), true)
  reg.unregister('/a')
  assert.equal(reg.has('/x'), false)
  assert.equal(reg.match('/x'), undefined)
})

test('重复 register 同一 canonical：旧别名被替换而非残留', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/a', aliases: ['/old'], handler: () => true })
  reg.register({ name: '/a', aliases: ['/new'], handler: () => true })

  assert.equal(reg.has('/old'), false)
  assert.equal(reg.has('/new'), true)
  assert.equal(reg.match('/new')?.name, '/a')
  assert.equal(reg.getAliasConflicts().length, 0)
})

test('别名等于自身 canonical 名时静默忽略（不产生自指冲突）', () => {
  const reg = new SlashCommandRegistry()
  reg.register({ name: '/a', aliases: ['/a'], handler: () => true })

  assert.equal(reg.match('/a')?.name, '/a')
  assert.equal(reg.getAliasConflicts().length, 0)
})
