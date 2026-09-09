/**
 * Rewind 锚点：用户消息被追加 hook 注入后的匹配回归（issue #63 残留）。
 *
 * 现场：桌面端「保存并重发」在含注入的历史会话上失效。两条同源缺陷：
 *   ① listRewindPoints 用「agent 消息 content === 事件文本」全等匹配，而真实
 *      会话里用户消息进 agent 列表时被追加了 `\n<system-reminder>…` 注入段，
 *      全等必然落空 → 条目缺 seq → 前端退到序数降级；同时 hook 产生的独立
 *      user 消息（磁盘对账 / 取证提醒 / 图片桥接）也进了 points，把序数顶偏
 *      → 编辑重发切到错误的消息索引。
 *   ② rewind() 的 anchorSeq 同样按全等匹配、prompt 直接取 agent content（含
 *      注入）→ rewind 事件既无 anchorSeq、prompt 也对不上前端 blocks 里的原文
 *      → event-reducer 定位不到截断点，界面不截断（旧消息残留），用户看到的
 *      就是「保存并重发没反应」。
 *
 * 反证表（每条对应一个会被打红的偷懒实现）：
 *   #A 只做全等匹配 → seq / content 断言红
 *   #A2 prompt 取 agent content → prompt 断言红
 *   #B 注入消息照单返回 → 条目数 / 序数断言红
 *   #B2 anchorSeq 仍按 userOrdinal 取事件 → anchorSeq 断言红
 *   #C 剥离注入时误伤用户正文 → 正文保留断言红
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/** 真实注入段形状（取自 2026-09-08 会话现场）。 */
const INJECTION = '\n<system-reminder>\n【太一·取证】已连续 5 轮只读，但零个带观察锚点。'

/** 镜像真实路径：run(prompt) 把「用户原文 + 注入段」写进 agent 消息列表。 */
class InjectingAgent implements ManagedAgent {
  messages: OaiMessage[] = []
  /** hook 直接把独立注入消息塞进列表（没有对应 user 事件）。 */
  injectStandalone(text: string): void {
    this.messages.push({ role: 'user', content: text })
    this.messages.push({ role: 'assistant', content: 'noted' })
  }
  run(prompt: string, _cb: AgentCallbacks): Promise<void> {
    this.messages.push({ role: 'user', content: `${prompt}${INJECTION}` })
    this.messages.push({ role: 'assistant', content: 'ok' })
    return Promise.resolve()
  }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(m: OaiMessage[]): void { this.messages = m }
  rewindToMessages(m: OaiMessage[]): void { this.messages = m }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

function setup(): { manager: RuntimeSessionManager; agent: () => InjectingAgent } {
  const built: InjectingAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new InjectingAgent()
      built.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  return { manager, agent: () => built[built.length - 1]! }
}

function userEventSeqs(manager: RuntimeSessionManager, id: string): number[] {
  return manager.getEvents(id, 0)!.events.filter((e) => e.type === 'user').map((e) => e.seq)
}

function rewindEvent(manager: RuntimeSessionManager, id: string): { data: Record<string, unknown> } {
  const ev = manager.getEvents(id, 0)!.events.find((e) => e.type === 'rewind')
  assert.ok(ev, 'event log must contain a rewind event')
  return ev as unknown as { data: Record<string, unknown> }
}

test('#A 追加注入的用户消息仍带 seq 锚点，content 为事件原文', async () => {
  const { manager } = setup()
  const s = manager.createSession({ prompt: 'turn-1' })
  await settle()
  manager.run(s.id, 'turn-2')
  await settle()
  manager.run(s.id, 'turn-3')
  await settle()

  const points = (await manager.listRewindPoints(s.id))!
  assert.deepEqual(
    points.map((p) => p.content),
    ['turn-1', 'turn-2', 'turn-3'],
    '注入段不得留在 rewind 点正文里',
  )
  assert.deepEqual(points.map((p) => p.index), [0, 2, 4], '索引仍指向 agent 消息位置')
  assert.deepEqual(
    points.map((p) => p.seq),
    userEventSeqs(manager, s.id),
    '每条真实用户消息都必须带 user 事件 seq（前端锚点）',
  )
})

test('#A2 rewind 事件的 prompt 为事件原文、anchorSeq 指向该事件', async () => {
  const { manager } = setup()
  const s = manager.createSession({ prompt: 'turn-1' })
  await settle()
  manager.run(s.id, 'turn-2')
  await settle()

  const seqs = userEventSeqs(manager, s.id)
  assert.ok(manager.rewind(s.id, 2), 'rewind 到 turn-2 应成功')

  const ev = rewindEvent(manager, s.id)
  assert.equal(ev.data.prompt, 'turn-2', 'prompt 必须是事件原文（前端按它回退匹配 blocks 文本）')
  assert.equal(ev.data.anchorSeq, seqs[1], 'anchorSeq 指向被回退的 user 事件')
})

test('#B 独立注入消息不进 rewind 点，也不顶偏序数', async () => {
  const { manager, agent } = setup()
  const s = manager.createSession({ prompt: 'turn-1' })
  await settle()
  agent().injectStandalone('<system-reminder>\n【磁盘对账】以下文件在会话记录之外被近期修改…')
  manager.run(s.id, 'turn-2')
  await settle()
  agent().injectStandalone('<system-reminder>\n上一轮结论依赖尚未证实的高风险断言…')
  manager.run(s.id, 'turn-3')
  await settle()

  const points = (await manager.listRewindPoints(s.id))!
  assert.deepEqual(
    points.map((p) => p.content),
    ['turn-1', 'turn-2', 'turn-3'],
    'hook 注入的 user 消息不得出现在 rewind 点里（前端序数降级靠 points 与 blocks 同序）',
  )
  assert.deepEqual(
    points.map((p) => p.seq),
    userEventSeqs(manager, s.id),
    '注入消息占位时，真实消息的 seq 仍须一一对上',
  )
})

test('#B2 注入消息占位时 anchorSeq 仍指向正确的 user 事件', async () => {
  const { manager, agent } = setup()
  const s = manager.createSession({ prompt: 'turn-1' })
  await settle()
  agent().injectStandalone('<system-reminder>\n【磁盘对账】…')
  manager.run(s.id, 'turn-2')
  await settle()
  agent().injectStandalone('<system-reminder>\n上一轮结论依赖尚未证实…')
  manager.run(s.id, 'turn-3')
  await settle()

  const points = (await manager.listRewindPoints(s.id))!
  const target = points.find((p) => p.content === 'turn-3')!
  const seqs = userEventSeqs(manager, s.id)
  assert.ok(manager.rewind(s.id, target.index), 'rewind 到 turn-3 应成功')

  const ev = rewindEvent(manager, s.id)
  assert.equal(ev.data.prompt, 'turn-3')
  assert.equal(ev.data.anchorSeq, seqs[2], '序数取法会被注入消息顶偏，必须按配对结果取')
})

test('#C 用户正文里的换行 + 尖括号不被误剥离', async () => {
  const { manager } = setup()
  const s = manager.createSession({ prompt: '看这段：\n<div>你好</div>' })
  await settle()

  const points = (await manager.listRewindPoints(s.id))!
  assert.equal(points.length, 1)
  assert.equal(points[0]!.content, '看这段：\n<div>你好</div>', '正文原样保留')
  assert.ok(points[0]!.seq !== undefined, '正文含 XML 片段不影响事件配对')
})
