/**
 * e2e：命令命中时「零模型调用、零会话创建」——对真实 serve 实例，不消耗模型。
 *
 * 做法：真实 ServeSessionClient + 真实消息桥（ImBridge）；在客户端五个真实方法外面加一层
 * **观测计数**（只计数、转发原实现，不替换行为）。跑完再用 HTTP 直接查实例会话清单，
 * 确认一个会话都没多出来。
 *
 * 用法：
 *   TEST_SERVE_TOKEN=... TEST_SERVE_PORT=... TEST_SERVE_CWD=... "<天枢 node>" tools/e2e-command-isolation.mjs
 */
import { ServeSessionClient } from '../lib/serve-client.mjs'
import { ImBridge } from '../lib/bridge.mjs'
import { createCommandHandlers, dispatchCommand } from '../lib/command-handlers.mjs'

const token = process.env.TEST_SERVE_TOKEN?.trim()
const port = Number.parseInt(process.env.TEST_SERVE_PORT ?? '', 10)
const cwd = process.env.TEST_SERVE_CWD?.trim() ?? 'D:/path/to/scratch/e2e-isolation-ws'
if (!token || !port) {
  console.error('需要 TEST_SERVE_TOKEN 与 TEST_SERVE_PORT 环境变量')
  process.exit(1)
}

const keepAlive = setInterval(() => {}, 1000) // serve-client 的 sleep 是 unref 的
const client = new ServeSessionClient({ token, port })

// 观测式包装：只记账，转发给真实实现
const calls = { create: 0, prompt: 0, events: 0, snapshot: 0, list: 0 }
for (const [name, key] of [
  ['createSession', 'create'], ['promptSession', 'prompt'], ['fetchEvents', 'events'],
  ['getSession', 'snapshot'], ['listSessions', 'list'],
]) {
  const orig = client[name].bind(client)
  client[name] = async (...args) => { calls[key] += 1; return orig(...args) }
}

const sessionMap = new Map()
const map = {
  get: (k) => sessionMap.get(k) ?? null,
  set: (k, v) => sessionMap.set(k, v),
  del: (k) => sessionMap.delete(k),
}
const sent = []
const bridge = new ImBridge({
  workspaceRoot: cwd,
  logger: { info() {}, warn() {}, error() {} },
  ensureDir: () => {},
  serveClient: client,
  sessionMap: map,
  onCommand: (ctx) => dispatchCommand(
    ctx,
    createCommandHandlers({ workspace: cwd, serveClient: client, sessionMap: map }),
  ),
  call: async () => { throw new Error('e2e 不应走 headless') },
  send: async (_target, text) => { sent.push(String(text)) },
})

const msg = (content) => ({
  kind: 'c2c',
  senderId: 'e2e-iso',
  content,
  replyTarget: { scope: 'c2c', targetId: 'e2e-iso', msgId: `m-${content.slice(0, 6)}` },
})

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? `  ← ${String(detail).split('\n')[0]}` : ''}`)
  if (ok) pass += 1
  else fail += 1
}

console.log(`实例: http://127.0.0.1:${port}   工作区配置: ${cwd}`)

const before = (await client.listSessions()).length
calls.list = 0 // 基线查询不算进命令路径

const commands = ['/workspacelist', '/sessions', '/session 999', '/history', '/nope']
for (const c of commands) await bridge.handle(msg(c))

console.log(`桥统计: ${JSON.stringify(bridge.stats)}`)
console.log(`客户端真实调用: ${JSON.stringify(calls)}`)
console.log(`回执 ${sent.length} 条：`)
sent.forEach((t, i) => console.log(`  [${i + 1}] ${String(t).split('\n')[0].slice(0, 72)}`))

check('五条命令全部被处理', bridge.stats.handled === 5)
check('全部走命令层（含未知命令）', bridge.stats.commands === 5, `commands=${bridge.stats.commands}`)
check('零模型调用：promptSession 调用 0 次', calls.prompt === 0, `prompt=${calls.prompt}`)
check('零会话创建：createSession 调用 0 次', calls.create === 0, `create=${calls.create}`)
check('零失败（异常没有冒泡到桥）', bridge.stats.failed === 0 && bridge.stats.commandsFailed === 0)
check('每条命令都有回执', bridge.stats.commandReplies === 5, `commandReplies=${bridge.stats.commandReplies}`)
check('模型回复口径未被命令污染（互不串账）', bridge.stats.replies === 0, `replies=${bridge.stats.replies}`)
check('绑定表零改动', sessionMap.size === 0)

const after = (await client.listSessions()).length
check('实例里的会话数没变（命令没有偷偷建会话）', after === before, `${before} → ${after}`)

clearInterval(keepAlive)
console.log(`\n结果: pass ${pass} / fail ${fail}`)
process.exitCode = fail === 0 ? 0 : 2
