/**
 * e2e：/history 对真实 serve 实例的取数与边界（不涉及 QQ 网络）。
 *
 * 覆盖：
 *   1) 无绑定 → 明确提示
 *   2) 绑定到一个真实但还没有内容的会话 → 空会话提示
 *   3) 绑定到一个不存在的 session id → 真实 HTTP 404 → 明确提示「已不存在」，且绑定原样
 *   4) 错误令牌 → 报「读取失败」，不谎报「已不存在」
 *   5) 真实事件流回看：发一条消息（无密钥实例会留下 user + error + done），
 *      验证「真实事件流 → 还原 → 回看文本」这条链路
 *   6) E2E_WITH_TURN=1（需要模型可用）时真跑一轮，回看真实问答
 *
 * 退出码：pass/fail 通过 process.exitCode 表达（不用 process.exit —— Windows 上
 * 会在 libuv 收尾时触发 async.c 断言，退成 9，让自动化误判）。
 *
 * 用法：
 *   TEST_SERVE_TOKEN=... TEST_SERVE_PORT=... "<天枢 node>" tools/e2e-command-history.mjs
 */
import { ServeSessionClient } from '../lib/serve-client.mjs'
import { createCommandHandlers, dispatchCommand } from '../lib/command-handlers.mjs'
import { parseCommand } from '../lib/command.mjs'

const token = process.env.TEST_SERVE_TOKEN?.trim()
const port = Number.parseInt(process.env.TEST_SERVE_PORT ?? '', 10)
const cwd = process.env.TEST_SERVE_CWD?.trim() ?? 'D:/path/to/scratch/e2e-history-ws'
if (!token || !port) {
  console.error('需要 TEST_SERVE_TOKEN 与 TEST_SERVE_PORT 环境变量')
  process.exit(1)
}

const keepAlive = setInterval(() => {}, 1000) // serve-client 的 sleep 是 unref 的，脚本要自备保活
const client = new ServeSessionClient({ token, port })
const map = new Map()
const sessionMap = {
  get: (k) => map.get(k) ?? null,
  set: (k, v) => map.set(k, v),
  del: (k) => map.delete(k),
}
const handlers = createCommandHandlers({ workspace: cwd, serveClient: client, sessionMap })
const replies = []
const run = async (text) => {
  replies.length = 0
  await dispatchCommand(
    { parsed: parseCommand(text), key: 'c2c:e2e', reply: async (t) => { replies.push(t) } },
    handlers,
  )
  return replies.join('\n')
}

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? `  ← ${String(detail).split('\n')[0]}` : ''}`)
  if (ok) pass += 1
  else fail += 1
}

console.log(`实例: http://127.0.0.1:${port}   工作区: ${cwd}`)

// [1] 无绑定
let out = await run('/history')
check('无绑定时明确提示', /还没有绑定会话/.test(out))

// [2] 真实空会话
const created = await client.createSession({ cwd, title: 'e2e-history 空会话' })
console.log(`建会话: ${created?.id} lastSeq=${created?.lastSeq}`)
map.set('c2c:e2e', created.id)
out = await run('/history')
check('空会话给明确提示', /还没有可回看的内容/.test(out))
out = await run('/history 5')
check('空会话 + 数量参数同样提示', /还没有可回看的内容/.test(out))

// [3] 真实 404
map.set('c2c:e2e', 'does-not-exist-e2e')
out = await run('/history')
check('会话已不存在时明确提示', /已经不存在/.test(out))
check('404 路径不动绑定', map.get('c2c:e2e') === 'does-not-exist-e2e')

// [4] 错误令牌 → 读取失败，与「不存在」分开说
const badClient = new ServeSessionClient({ token: 'wrong-token-e2e', port })
const badHandlers = createCommandHandlers({ workspace: cwd, serveClient: badClient, sessionMap })
replies.length = 0
await dispatchCommand(
  { parsed: parseCommand('/history'), key: 'c2c:e2e', reply: async (t) => { replies.push(t) } },
  badHandlers,
)
out = replies.join('\n')
check('错误令牌 → 报读取失败，不谎报「已不存在」',
  /读取会话失败|读取事件流失败/.test(out) && !/已经不存在/.test(out))

// [5] 真实事件流回看（不依赖模型是否可用）
map.set('c2c:e2e', created.id)
const probeText = '这是一条 e2e 探针消息（用于回看验证）'
let accepted = false
try {
  await client.promptSession(created.id, probeText)
  accepted = true
} catch (error) {
  console.log(`（prompt 未被受理：${error?.message ?? error}）`)
}
await new Promise((r) => setTimeout(r, 5000))
const raw = await client.fetchEvents(created.id, 0)
const types = [...new Set((raw.events ?? []).map((e) => e.type))]
console.log(`会话事件类型: ${types.join(', ')}`)
out = await run('/history 3')
check('prompt 被受理（HTTP 200）', accepted)
check('回看含真实用户消息', out.includes(probeText))
check('回看标题给出条数', /最近 \d+ 条/.test(out))
check('回看不吐出原始事件类型名（只给人话）', !/\btext_delta\b|\buser\b:/.test(out))
console.log('---- 回看文本 ----')
console.log(out)
console.log('---- 回看文本结束 ----')

// [6] 真跑一轮（需要模型可用）
if (process.env.E2E_WITH_TURN === '1') {
  map.set('c2c:e2e', created.id)
  const snapshot = await client.getSession(created.id)
  const base = Number(snapshot?.lastSeq ?? 0)
  await client.promptSession(created.id, '只回复四个字：回看成功')
  const r = await client.waitForReply(created.id, { since: base, timeoutMs: 180000, graceMs: 3000 })
  console.log(`模型回复: ${JSON.stringify(r.text).slice(0, 60)} timedOut=${r.timedOut}`)
  out = await run('/history 5')
  check('回看含助手回复', out.includes('回看成功'))
}

clearInterval(keepAlive)
console.log(`\n结果: pass ${pass} / fail ${fail}`)
process.exitCode = fail === 0 ? 0 : 2
