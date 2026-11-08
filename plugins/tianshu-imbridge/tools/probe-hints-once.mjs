/**
 * 「首次提示」的跨进程验证：同一份记忆文件，跑两次独立进程。
 * 第一次应当附完整用法（FIRST），第二次只附一行（LATER）。
 *
 * 用法：
 *   node tools/probe-hints-once.mjs <command-hints.json 路径> [--reset]
 */
import { rmSync } from 'node:fs'
import { ImBridge } from '../lib/bridge.mjs'
import { makeCommandHints } from '../lib/command-hints.mjs'
import { createCommandHandlers, dispatchCommand } from '../lib/command-handlers.mjs'

const file = process.argv[2]
if (!file) {
  console.error('用法: node tools/probe-hints-once.mjs <command-hints.json 路径> [--reset]')
  process.exit(2)
}
if (process.argv.includes('--reset')) rmSync(file, { force: true })

const hints = makeCommandHints(file)
const sent = []
const handlers = createCommandHandlers({ workspace: 'D:/path/to/workspace', serveClient: null, sessionMap: null })
const bridge = new ImBridge({
  workspaceRoot: 'D:/x',
  logger: { info() {}, warn() {}, error() {} },
  ensureDir: () => {},
  sessionMap: null,
  serveClient: null,
  commandHints: hints,
  call: async () => { throw new Error('探针不应走 headless') },
  send: async (_t, text) => { sent.push(String(text)) },
  onCommand: (ctx) => dispatchCommand(ctx, handlers),
})

const pid = process.pid
await bridge.handle({
  kind: 'c2c',
  senderId: 'probe',
  content: '/history',
  replyTarget: { scope: 'c2c', targetId: 'probe', msgId: `m-${pid}` },
})

const body = sent.join('\n')
console.log(`[pid ${pid}] 记忆里的命令数: ${hints.size()}   记忆文件: ${file}`)
console.log('---- 回执 ----')
console.log(body)
console.log('---- 判定 ----')
console.log(/第一次用到/.test(body) ? 'FIRST（本次附了完整用法）' : 'LATER（只附一行提示）')
process.exitCode = 0
