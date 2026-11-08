/**
 * QQ 连接冒烟测试（独立脚本，不依赖天枢插件被加载）。
 *
 * 用途：配好凭据后一键验证「连接 → 收消息 → 回消息」双向链路。
 *
 * 用法（在项目目录）：
 *   RIVET_HOME="<天枢数据目录>" "<天枢 node.exe>" tools/qq-connect-test.mjs
 * 凭据来源（环境变量优先）：
 *   - TIANSHU_IM_QQ_APPID / TIANSHU_IM_QQ_SECRET，或
 *   - <RIVET_HOME>/im-qq/config.json（{ "appId": "...", "appSecret": "..." }）
 *
 * ⚠️ 若同一 bot 的 DSH 侧连接（dsh-qq）正在运行，本测试与其存在事件分发不确定性
 *    （平台行为未定义）。正式使用建议二选一（详见 README）。
 */
import { QqConnection } from '../lib/qq/connection.mjs'
import { loadQqConfig, maskAppId } from '../lib/qq/config.mjs'

const WAIT_CONNECT_MS = 25_000
const WAIT_MESSAGE_MS = 90_000

const config = loadQqConfig()
if (!config.configured) {
  console.error('❌ 未找到凭据。请任选其一：')
  console.error('   1) 设置环境变量 TIANSHU_IM_QQ_APPID / TIANSHU_IM_QQ_SECRET')
  console.error(`   2) 创建 ${config.configFile}（{"appId":"...","appSecret":"..."}）`)
  process.exit(1)
}

console.log(`🔌 连接中（appId=${maskAppId(config.appId)}，来源=${config.source}）…`)

let finished = false
const connection = new QqConnection({
  config,
  logger: console,
  dataDir: config.dataDir,
  onMessage: async (message) => {
    if (finished) return
    const kind = message?.kind ?? 'unknown'
    const preview = typeof message?.content === 'string'
      ? message.content.replace(/\s+/g, ' ').slice(0, 120)
      : ''
    console.log(`📨 收到消息 [${kind}]："${preview}"`)
    try {
      await connection.sendText(message.replyTarget, `✅ 天枢插件连接测试：已收到「${preview.slice(0, 40)}」`)
      console.log('📤 已回复确认消息（发送通道验证通过）')
    } catch (error) {
      console.error('📤 回复失败:', error?.message ?? error)
    }
    finished = true
    await sleep(1500)
    await connection.stop()
    process.exit(0)
  },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
connection.start()

const connectDeadline = Date.now() + WAIT_CONNECT_MS
while (Date.now() < connectDeadline) {
  await sleep(1000)
  const status = connection.status
  if (status.state === 'connected' && status.ready) {
    console.log('✅ QQ 连接成功！')
    console.log(`⏳ 请用手机 QQ 给机器人发一条消息（${Math.round(WAIT_MESSAGE_MS / 1000)} 秒内）以验证收发双向…`)
    break
  }
  if (status.state === 'error') {
    console.error(`❌ 连接失败：${status.lastError ?? '未知错误'}`)
    console.error('   提示：检查 AppID/AppSecret 是否正确、机器人是否已上架/可用。')
    await connection.stop()
    process.exit(2)
  }
}

if (!connection.status.ready) {
  console.error(`❌ ${Math.round(WAIT_CONNECT_MS / 1000)} 秒内未能就绪：${connection.status.lastError ?? '超时'}`)
  await connection.stop()
  process.exit(2)
}

const msgDeadline = Date.now() + WAIT_MESSAGE_MS
while (!finished && Date.now() < msgDeadline) {
  await sleep(500)
}
if (!finished) {
  console.log('ℹ️ 连接保持正常，但未收到消息（收发链路中的"收"未验证；连接本身已验证）。')
  await connection.stop()
  process.exit(0)
}
