import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROCESS_SESSION_ID,
  callerIdentityHeaders,
  providerIdentityHeaders,
} from '../caller-identity.js'

// 出站身份头是「所有直发上游路径」的共用实现：漏了它，OpenCode Go 会
// 400 MissingSessionID。这里钉住三个不变式——wire 声明了就必须发、
// 没有会话上下文也要发、普通 provider 不被污染。

test('wire 声明会话头时必定发出；缺 sessionId 用进程级兜底而不是不发', () => {
  const wire = { userAgent: 'tianshu-tui/test', sessionHeader: 'x-opencode-session' }

  const withId = callerIdentityHeaders(wire, 'sess-1')
  assert.equal(withId['x-opencode-session'], 'sess-1')
  assert.equal(withId['User-Agent'], 'tianshu-tui/test')

  const withoutId = callerIdentityHeaders(wire)
  assert.equal(
    withoutId['x-opencode-session'],
    PROCESS_SESSION_ID,
    '上游强制会话头时，没有会话上下文也必须发（缺头 = 400），且不能每请求随机',
  )
})

test('wire 未声明会话头时保持原行为：有 sessionId 才发默认头名', () => {
  assert.deepEqual(callerIdentityHeaders(undefined, 'sess-1'), { 'X-Request-Session': 'sess-1' })
  assert.deepEqual(callerIdentityHeaders(undefined), {}, '无 wire 无 sessionId → 不加任何头')
  assert.deepEqual(callerIdentityHeaders({ userAgent: 'x/1' }), { 'User-Agent': 'x/1' })
})

test('providerIdentityHeaders 按 baseUrl host 命中，覆盖 anthropic 形态与 FQDN 尾点', () => {
  const anthropicForm = providerIdentityHeaders('anthropic', 'https://opencode.ai/zen/go', 'sess-2')
  assert.equal(anthropicForm['x-opencode-session'], 'sess-2', 'name 是 anthropic 的形态也要命中')
  assert.match(anthropicForm['User-Agent'] ?? '', /^tianshu-tui\//)

  const trailingDot = providerIdentityHeaders(undefined, 'https://opencode.ai./zen/go/v1', 'sess-3')
  assert.equal(
    trailingDot['x-opencode-session'],
    'sess-3',
    'FQDN 尾点不该让同一上游静默丢头',
  )

  const byName = providerIdentityHeaders('opencode-go', 'https://my-relay.example/v1', 'sess-4')
  assert.equal(byName['x-opencode-session'], 'sess-4', '经本机中转时 name 层兜底仍发头')

  assert.deepEqual(
    providerIdentityHeaders('deepseek', 'https://api.deepseek.com/v1', 'sess-5'),
    { 'X-Request-Session': 'sess-5' },
  )
})
