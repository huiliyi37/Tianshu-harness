/**
 * 本地端到端演练：模拟 QQ 消息 → 真实天枢 headless → 收集回复文本。
 *
 * 默认跑两轮，验证「历史注入式多轮」：
 *   轮 1：无历史（原始 prompt）→ 正常回复；
 *   轮 2：prompt 携带轮 1 的往来历史 → 应能引用轮 1 的内容（输出 MULTI-TURN: OK）。
 *
 * 不涉及 QQ 网络（无需 QQ 凭据）；会发起真实 headless 调用（消耗 token）。
 *
 * 用法（在项目目录，使用天枢自带 node）：
 *   RIVET_HOME="<天枢数据目录>" TIANSHU_RUNTIME_DIR="<rivet-runtime>" \
 *     "<天枢 node.exe>" tools/e2e-local-bridge.mjs [--prompt "单轮消息"]
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImBridge } from '../lib/bridge.mjs'
import { buildInvocation, callTianshu } from '../lib/tianshu.mjs'
import { HistoryStore } from '../lib/history.mjs'

const args = process.argv.slice(2)
const promptIdx = args.indexOf('--prompt')
const singlePrompt = promptIdx >= 0 && args[promptIdx + 1] ? args[promptIdx + 1] : null

const homeDir = process.env.RIVET_HOME?.trim()
const runtimeDir = process.env.TIANSHU_RUNTIME_DIR?.trim()
if (!homeDir || !runtimeDir) {
  console.error('需要 RIVET_HOME 与 TIANSHU_RUNTIME_DIR 环境变量')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '.e2e-workspace')

const sent = []
const bridge = new ImBridge({
  workspaceRoot,
  logger: console,
  ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
  historyStore: new HistoryStore({ file: null }),
  call: async ({ cwd, prompt }) => callTianshu(
    buildInvocation({
      runtimeDir, nodePath: process.execPath, homeDir, cwd, prompt,
    }),
    { timeoutMs: 120_000 },
  ),
  send: async (_target, text) => {
    sent.push(text)
    console.log('SENT >>>', JSON.stringify(text.slice(0, 300)))
  },
})

const rounds = singlePrompt
  ? [singlePrompt]
  : ['只回复四个字：桥接成功', '我上一条消息让你回复什么？请原样引用那句话。']

for (const [index, prompt] of rounds.entries()) {
  console.log(`\n=== ROUND ${index + 1} ===`)
  await bridge.handle({
    kind: 'c2c',
    senderId: 'e2e-user',
    content: prompt,
    replyTarget: { scope: 'c2c', targetId: 'e2e-target', msgId: `e2e-msg-${index + 1}` },
  })
}

console.log('\nSTATS:', JSON.stringify(bridge.stats))
if (sent.length === 0) {
  console.log('E2E: FAIL（无回复文本产出）')
  process.exit(2)
}
if (rounds.length >= 2) {
  const round2 = sent[1] ?? ''
  console.log(round2.includes('桥接成功')
    ? 'MULTI-TURN: OK（第二轮引用了第一轮内容）'
    : 'MULTI-TURN: CHECK（第二轮未引用上轮内容，需人工查看上方 SENT）')
}
console.log('E2E: OK')
