import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretSessionEvent } from '../src/chat/turn-events.ts'

// chat participant 的事件映射：sidecar SSE SessionEvent → ChatTurnEvent。
// 判据对齐 webview model.ts 与 server session-manager 的消费/生产形状：
//  - text_delta.data.text 为增量文本；空/非字符串不产事件。
//  - done.data.status 是 run 的终态（completed/failed/aborted）——chat 一轮的 settle 点。
//  - error.data.message（或 error）给失败文案。
//  - approval_required → 结构化审批（requestId/toolName/input），由原生对话框接管。
//  - approval_resolved → 审批闭环信号（轮超时豁免的恢复点，见 turn-timeout.ts）。
//  - user_question → 结构化提问（toolUseId + questions[]），由原生对话框接管；
//    答案按「组装普通用户消息」约定回传（server 侧 ask_user_question 只回占位符 + endTurn）。
//  - tool_use → {id, name, detail(≤160 行摘要), inputText(≤2000 折叠卡参数全文)}；
//    id 缺失为空串（消费端据此降级为文本行）。
//  - tool_result → {id, name, isError, partial, output(uiContent 优先)}；
//    partial 帧为流式进度 chunk（消费端决定忽略或预览，v1 忽略）；id/name 缺失不产事件。
//  - thinking_delta → 思考增量（连续非空增量由宿主合并为思考块）；空/非字符串不产。

const ev = (type: string, data: Record<string, unknown> = {}) => ({ seq: 1, ts: 0, type, data })

test('text_delta 产出文本增量；空/非字符串不产事件', () => {
  assert.deepEqual(interpretSessionEvent(ev('text_delta', { text: '你好' })), { kind: 'delta', text: '你好' })
  assert.equal(interpretSessionEvent(ev('text_delta', { text: '' })), undefined)
  assert.equal(interpretSessionEvent(ev('text_delta', { text: 42 })), undefined)
  assert.equal(interpretSessionEvent(ev('text_delta', {})), undefined)
})

test('done 落终态：status 透传，缺失按 completed', () => {
  assert.deepEqual(interpretSessionEvent(ev('done', { status: 'completed' })), { kind: 'end', reason: 'completed' })
  assert.deepEqual(interpretSessionEvent(ev('done', { status: 'aborted' })), { kind: 'end', reason: 'aborted' })
  assert.deepEqual(interpretSessionEvent(ev('done', {})), { kind: 'end', reason: 'completed' })
})

test('error 取 message 或 error，都缺时给兜底文案', () => {
  assert.deepEqual(interpretSessionEvent(ev('error', { message: '模型 503' })), { kind: 'error', message: '模型 503' })
  assert.deepEqual(interpretSessionEvent(ev('error', { error: '连接断开' })), { kind: 'error', message: '连接断开' })
  assert.deepEqual(interpretSessionEvent(ev('error', {})), { kind: 'error', message: '未知错误' })
})

test('approval_required → 结构化审批事件（requestId/toolName/input）', () => {
  const got = interpretSessionEvent(ev('approval_required', { requestId: 'r1', toolName: 'bash', input: { command: 'ls' } }))
  assert.deepEqual(got, { kind: 'approval', requestId: 'r1', toolName: 'bash', input: { command: 'ls' } })
})

test('approval_required 缺 toolName 给兜底名；缺 requestId 不产事件', () => {
  const got = interpretSessionEvent(ev('approval_required', { requestId: 'r2' }))
  assert.deepEqual(got, { kind: 'approval', requestId: 'r2', toolName: '工具调用', input: undefined })
  assert.equal(interpretSessionEvent(ev('approval_required', {})), undefined)
})

test('approval_resolved identifies the resolved request for reconnect state reconciliation', () => {
  assert.deepEqual(interpretSessionEvent(ev('approval_resolved', { requestId: 'r1' })), { kind: 'approval-resolved', requestId: 'r1' })
  assert.deepEqual(interpretSessionEvent(ev('approval_resolved', {})), { kind: 'approval-resolved', requestId: '' })
})

test('user_question → 结构化提问事件（questions 归一化：过滤非字符串 option、布尔化 allowMultiple）', () => {
  const got = interpretSessionEvent(ev('user_question', {
    toolUseId: 't1',
    questions: [
      { id: 'q1', prompt: '选一个', options: ['A', 'B'], allowMultiple: false },
      { id: 'q2', prompt: '自由回答', options: [], allowMultiple: true },
      { id: 'q3', prompt: '脏数据', options: ['X', 42, null] },
    ],
  }))
  assert.deepEqual(got, {
    kind: 'question',
    toolUseId: 't1',
    questions: [
      { id: 'q1', prompt: '选一个', options: ['A', 'B'], allowMultiple: false },
      { id: 'q2', prompt: '自由回答', options: [], allowMultiple: true },
      { id: 'q3', prompt: '脏数据', options: ['X'], allowMultiple: false },
    ],
  })
})

test('user_question 无有效问题时忽略（questions 非数组或元素缺 id）', () => {
  assert.equal(interpretSessionEvent(ev('user_question', { toolUseId: 't1', questions: 'nope' })), undefined)
  assert.equal(interpretSessionEvent(ev('user_question', { toolUseId: 't1', questions: [{ prompt: '没有 id' }] })), undefined)
  assert.equal(interpretSessionEvent(ev('user_question', { toolUseId: 't1' })), undefined)
})

test('无关事件（status/未知类型）一律忽略', () => {
  assert.equal(interpretSessionEvent(ev('status', { status: 'running' })), undefined)
  assert.equal(interpretSessionEvent(ev('whatever', {})), undefined)
})

test('tool_use → 工具事件（id/detail/inputText：bash 取 command、文件类取路径、其余 JSON 全文）', () => {
  assert.deepEqual(
    interpretSessionEvent(ev('tool_use', { id: 't1', name: 'bash', input: { command: 'mkdir -p /tmp/x' } })),
    { kind: 'tool', id: 't1', name: 'bash', detail: 'mkdir -p /tmp/x', inputText: '{\n  "command": "mkdir -p /tmp/x"\n}' },
  )
  assert.deepEqual(
    interpretSessionEvent(ev('tool_use', { id: 't2', name: 'read_file', input: { file_path: '/a/b.ts' } })),
    { kind: 'tool', id: 't2', name: 'read_file', detail: '/a/b.ts', inputText: '{\n  "file_path": "/a/b.ts"\n}' },
  )
  assert.deepEqual(
    interpretSessionEvent(ev('tool_use', { id: 't3', name: 'custom', input: { foo: 1 } })),
    { kind: 'tool', id: 't3', name: 'custom', detail: '{"foo":1}', inputText: '{\n  "foo": 1\n}' },
  )
  assert.equal(interpretSessionEvent(ev('tool_use', { id: 't4', input: {} })), undefined)
})

test('tool_use：字符串 input 直接作为摘要与全文；id 缺失归空串（消费端降级）', () => {
  assert.deepEqual(
    interpretSessionEvent(ev('tool_use', { id: 't5', name: 'legacy', input: 'plain text' })),
    { kind: 'tool', id: 't5', name: 'legacy', detail: 'plain text', inputText: 'plain text' },
  )
  assert.deepEqual(
    interpretSessionEvent(ev('tool_use', { name: 'bash', input: { command: 'ls' } })),
    { kind: 'tool', id: '', name: 'bash', detail: 'ls', inputText: '{\n  "command": "ls"\n}' },
  )
})

test('tool 摘要：超长截断至 160 字符加省略号（含边界不截断）', () => {
  const long = 'x'.repeat(300)
  const got = interpretSessionEvent(ev('tool_use', { id: 't6', name: 'bash', input: { command: long } }))
  assert.equal(got?.kind, 'tool')
  if (got?.kind === 'tool') {
    assert.equal(got.detail.length, 161)
    assert.ok(got.detail.endsWith('…'))
  }
  const edge = interpretSessionEvent(ev('tool_use', { id: 't7', name: 'bash', input: { command: 'y'.repeat(160) } }))
  if (edge?.kind === 'tool') assert.equal(edge.detail.length, 160)
})

test('tool inputText：JSON 全文超 2000 字符截断加省略号', () => {
  const got = interpretSessionEvent(ev('tool_use', { id: 't8', name: 'bash', input: { command: 'x'.repeat(2500) } }))
  assert.equal(got?.kind, 'tool')
  if (got?.kind === 'tool') {
    assert.equal(got.inputText.length, 2001)
    assert.ok(got.inputText.endsWith('…'))
    assert.ok(got.inputText.startsWith('{\n  "command": "xxx'))
  }
})

test('tool_result 终态成功：isError false、partial false、output=result', () => {
  assert.deepEqual(
    interpretSessionEvent(ev('tool_result', { id: 't1', name: 'bash', isError: false, result: 'done' })),
    { kind: 'tool-result', id: 't1', name: 'bash', isError: false, partial: false, output: 'done' },
  )
})

test('tool_result 终态失败透传 isError；uiContent 优先于 result', () => {
  assert.deepEqual(
    interpretSessionEvent(ev('tool_result', { id: 't2', name: 'bash', isError: true, result: 'boom' })),
    { kind: 'tool-result', id: 't2', name: 'bash', isError: true, partial: false, output: 'boom' },
  )
  assert.deepEqual(
    interpretSessionEvent(ev('tool_result', { id: 't3', name: 'ask_user_question', isError: false, result: '占位符', uiContent: '问题：选什么？' })),
    { kind: 'tool-result', id: 't3', name: 'ask_user_question', isError: false, partial: false, output: '问题：选什么？' },
  )
})

test('tool_result partial 帧：partial 透传；脏数据（非布尔）归一为 false', () => {
  assert.deepEqual(
    interpretSessionEvent(ev('tool_result', { id: 't4', name: 'bash', isError: false, partial: true, result: 'chunk' })),
    { kind: 'tool-result', id: 't4', name: 'bash', isError: false, partial: true, output: 'chunk' },
  )
  assert.deepEqual(
    interpretSessionEvent(ev('tool_result', { id: 't5', name: 'bash', isError: 'yes', partial: 1, result: 'x' })),
    { kind: 'tool-result', id: 't5', name: 'bash', isError: false, partial: false, output: 'x' },
  )
})

test('tool_result：id 或 name 缺失不产事件', () => {
  assert.equal(interpretSessionEvent(ev('tool_result', { name: 'bash', result: 'x' })), undefined)
  assert.equal(interpretSessionEvent(ev('tool_result', { id: 't6', result: 'x' })), undefined)
})

test('thinking_delta → 思考增量；空/非字符串不产事件', () => {
  assert.deepEqual(interpretSessionEvent(ev('thinking_delta', { text: '让我想想…' })), { kind: 'thinking', text: '让我想想…' })
  assert.equal(interpretSessionEvent(ev('thinking_delta', { text: '' })), undefined)
  assert.equal(interpretSessionEvent(ev('thinking_delta', { text: 42 })), undefined)
  assert.equal(interpretSessionEvent(ev('thinking_delta', {})), undefined)
})

test('turn_complete → 用量脚注（当前上下文优先：contextTokens 盖过累计 input_tokens）', () => {
  // 内核 usage 是「会话累计快照」——拿它当 Context Window 会把累计流量当占用显示
  // （实测：面板 276.0K = 累计 input 267,722 + output 8,312）。当前上下文取
  // contextTokens（内核 getEstimatedTokens 的当轮估算）。
  const both = interpretSessionEvent(ev('turn_complete', {
    usage: { input_tokens: 1234, output_tokens: 56, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    turnNumber: 1,
    isFinal: false,
    contextTokens: 1200,
  }))
  assert.deepEqual(both, { kind: 'usage', promptTokens: 1200, completionTokens: 56 })

  // 旧内核无 contextTokens：退回累计 input_tokens（保持可用，语义次优）
  const legacy = interpretSessionEvent(ev('turn_complete', {
    turnNumber: 2, isFinal: true, usage: { input_tokens: 900, output_tokens: 10 },
  }))
  assert.deepEqual(legacy, { kind: 'usage', promptTokens: 900, completionTokens: 10 })

  // 只有 contextTokens、无 usage（如刚启动的轮）：completion 为 0
  const ctxOnly = interpretSessionEvent(ev('turn_complete', { turnNumber: 3, isFinal: true, contextTokens: 1500 }))
  assert.deepEqual(ctxOnly, { kind: 'usage', promptTokens: 1500, completionTokens: 0 })
})

test('turn_complete 无有效用量不产事件；脏数据容错；仅 output 也上报', () => {
  assert.equal(interpretSessionEvent(ev('turn_complete', {})), undefined)
  assert.equal(interpretSessionEvent(ev('turn_complete', { usage: {} })), undefined)
  assert.equal(interpretSessionEvent(ev('turn_complete', { usage: { input_tokens: 'x', output_tokens: -5 } })), undefined)
  // 中断补发的快照可能只有累计 output（无 input）——仍上报，供圆环分母刷新
  assert.deepEqual(
    interpretSessionEvent(ev('turn_complete', { usage: { output_tokens: 80 } })),
    { kind: 'usage', promptTokens: 0, completionTokens: 80 },
  )
})
