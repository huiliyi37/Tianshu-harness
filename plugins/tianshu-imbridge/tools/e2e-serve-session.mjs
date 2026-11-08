/**
 * e2e：serve 原生会话链路（对本地 serve 实例实测；不涉及 QQ 网络）。
 *
 * 验证内容：
 *   1) QQ 消息 → 创建桌面端原生会话（serve /sessions）
 *   2) 首条消息 prompt、回复经事件流收集（text_delta + turn_complete）
 *   3) 第二条消息复用同一会话（会话绑定），且能引用上文（原生会话本身连续）
 *
 * 用法（先有一个测试 serve 实例；见 docs 或 scratch 启动脚本）：
 *   TEST_SERVE_TOKEN='...' TEST_SERVE_PORT=11277 \
 *   TEST_SERVE_CWD='D:/path/to/sandbox' \
 *   "<天枢 node>" tools/e2e-serve-session.mjs
 */
import { ImBridge } from '../lib/bridge.mjs'
import { ServeSessionClient } from '../lib/serve-client.mjs'

const token = process.env.TEST_SERVE_TOKEN?.trim()
const port = Number.parseInt(process.env.TEST_SERVE_PORT ?? '', 10)
const cwd = process.env.TEST_SERVE_CWD?.trim()

if (!token || !port) {
  console.error('需要 TEST_SERVE_TOKEN 与 TEST_SERVE_PORT 环境变量')
  process.exit(1)
}

const client = new ServeSessionClient({ token, port })
const keepAlive = setInterval(() => {}, 1000) // serve-client 的 sleep 为 unref；此处保住事件循环
const map = new Map()
const sent = []

const bridge = new ImBridge({
  workspaceRoot: cwd ?? 'D:/path/to/scratch/test-ws',
  workspaceOverride: cwd ?? 'D:/path/to/scratch/test-ws',
  logger: console,
  ensureDir: () => {},
  serveClient: client,
  sessionMap: {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, v),
    del: (k) => map.delete(k),
  },
  call: async () => { throw new Error('e2e 不应走 headless') },
  send: async (_target, text) => {
    sent.push(text)
    console.log('SENT >>>', JSON.stringify(String(text).slice(0, 240)))
  },
})

const msg = (content) => ({
  kind: 'c2c',
  senderId: 'e2e-native',
  content,
  replyTarget: { scope: 'c2c', targetId: 'e2e-native', msgId: `m-${content.slice(0, 8)}` },
})

console.log('=== ROUND 1（首条 → 建会话）===')
await bridge.handle(msg('只回复四个字：原生会话'))
console.log('=== ROUND 2（复用同一会话 → 应能引用上文）===')
await bridge.handle(msg('我上一条让你回复什么？请原样引用那句话。'))

console.log('\nSTATS:', JSON.stringify(bridge.stats))
console.log('MODE:', bridge.mode)
console.log('SESSION MAP:', JSON.stringify([...map.entries()]))

const ok = sent.length >= 2 && bridge.stats.serveSessionsCreated === 1
console.log(ok ? 'E2E: OK（两轮回复；会话复用成功）' : 'E2E: CHECK（见上方输出）')
clearInterval(keepAlive)
process.exit(ok ? 0 : 2)
