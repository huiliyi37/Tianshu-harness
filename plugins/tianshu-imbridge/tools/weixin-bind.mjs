#!/usr/bin/env node
/**
 * 微信通道 · 扫码绑定（命令行入口；与天枢里的「一句话绑定」共用同一份核心）
 *
 * 用法（在开发位置或部署副本均可）：
 *   set RIVET_HOME=D:\Tianshu\TianshuData\.rivet
 *   "<天枢的 node.exe>" tools\weixin-bind.mjs
 *
 * 参数：
 *   --timeout-ms=<毫秒>  等待扫码的总时限（默认 300 秒）
 *
 * 真正的绑定逻辑在 lib/weixin/binder.mjs —— 天枢里的 weixin_bind_start 工具调的是同一份。
 * 这里只负责「人机交互」那一层：把进展说成人话、交互式要验证码。
 *
 * 红线遵守：token 只写盘、只回掩码；不引入新依赖；不硬编码个人路径。
 * 退出码：0 成功；1 未成功。
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { loadWeixinConfig, maskToken, weixinConfigFile } from '../lib/weixin/config.mjs'
import { runBind } from '../lib/weixin/binder.mjs'

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

/** 问主人要一行输入（验证码用）。没有交互终端时返回空串，不挂死。 */
function askLine(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

async function main() {
  const env = process.env
  const config = loadWeixinConfig(env)
  const configFile = weixinConfigFile(env)
  const timeoutMs = Number(argValue('timeout-ms')) > 0 ? Number(argValue('timeout-ms')) : 300_000

  console.log('=== 天枢 · 微信通道绑定 ===')
  console.log(`数据目录      ：${config.dataDir}`)
  console.log(`配置写入位置  ：${configFile}`)
  if (config.configured) {
    console.log(`已有凭据      ：${maskToken(config.botToken)}（本次绑定会覆盖它）`)
  }
  console.log('请在手机上打开微信 → 我 → 设置 → 插件，然后扫码：\n')
  console.log('提醒：iLink 的长轮询游标是单条链。若这个微信号已经在别处接入（例如 DSH 侧），')
  console.log('      两边会互相抢消息、可能安静丢消息。协议里没有互踢机制，但也没有并发保证——')
  console.log('      能用空闲的号就用空闲的号。\n')

  let reported = false
  const final = await runBind({
    configFile,
    dataDir: config.dataDir,
    baseUrl: config.baseUrl,
    timeoutMs,
    env,
    askVerifyCode: async ({ attempt, message }) => {
      console.log(`\n⚠️ 服务端要求验证码（第 ${attempt} 次）：${message}`)
      console.log('   请看手机微信里的提示，把那一串验证码打在这里，然后回车。')
      return await askLine('验证码> ')
    },
  })

  // 从状态里把「二维码放哪儿了」讲清楚（核心层已经把图落好了）
  if (final.qrPath) {
    reported = true
    console.log(`二维码图片：${final.qrPath}`)
    console.log(final.qrOnDesktop
      ? '  （去桌面找这张图，用手机微信「扫一扫」）'
      : `  （${final.qrNote ?? '桌面不可用，已放到数据目录'}；用手机微信扫它）`)
  } else if (final.qrNote) {
    console.log(`二维码图片未能生成：${final.qrNote}`)
  }
  if (final.qrUrl) console.log(`二维码链接（备用，请勿外传）：${final.qrUrl}\n`)

  if (final.state !== 'success') {
    console.error(`绑定未完成（${final.state}）：${final.message ?? final.reason ?? '未知原因'}`)
    if (!reported) console.error('（连二维码都没取到，多半是网络或凭据问题）')
    if (final.state === 'already-bound') {
      console.error('说明：这个微信号已经绑过当前实例。若想换一处，请先在原处解绑，或换个微信号。')
    }
    if (final.state === 'need-verifycode') {
      console.error('说明：需要手机微信里显示的那串验证码。重跑本命令，看到提示时输入即可。')
    }
    process.exitCode = 1
    return
  }

  console.log('✅ 绑定成功')
  console.log(`   bot_id     ：${final.botId ?? '(服务端未给出)'}`)
  console.log(`   您的 user_id：${final.userId ?? '(服务端未给出)'}`)
  try {
    // 从落盘的配置里读回掩码：让主人确认「凭据确实写进去了」，又不整段泄露
    const written = JSON.parse(readFileSync(configFile, 'utf8'))
    if (typeof written?.botToken === 'string') {
      console.log(`   凭据       ：${maskToken(written.botToken)}（已写入 ${configFile}）`)
    }
  } catch { /* 读不回配置只影响这一行的展示，不改变绑定结果 */ }
  if (final.ownerFilled) {
    console.log('   ownerUserId：已自动写入（只有它会被响应）')
  } else {
    console.log('\n⚠️ 还差一步：没能自动填 ownerUserId，请把它手工补进配置，否则通道不会响应任何消息。')
  }
  console.log('\n最后一步：重启天枢（插件在 serve 启动时加载），然后给这个微信发条消息试试。')
  console.log('   重启后想确认：看天枢日志里有没有 [tianshu-imbridge] 📨 收到消息 [weixin/c2c] ……')
}

main().catch((error) => {
  console.error(`绑定流程异常：${error?.message ?? error}`)
  process.exitCode = 1
})
