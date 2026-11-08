#!/usr/bin/env node
/**
 * 绑定后台进程（被插件工具派生出来跑，也可以人来敲）。
 *
 * 为什么要有这个独立进程：扫码要等主人拿手机，可能是几十秒到几分钟。
 * 如果让天枢的工具调用**在里面干等**，agent 那一轮就会被这一个工具占住，
 * 主人还得盯着、agent 也没法回话。所以：工具立刻返回（把二维码与步骤交回对话），
 * 真正的等待交给这个后台进程；进展写在状态文件里，随时可查。
 *
 * 用法：
 *   1) 由插件派生（推荐）：`node binder-cli.mjs <请求文件.json>`，请求文件里带
 *      configFile / dataDir / baseUrl / statusFile / timeoutMs / qrFileName。
 *      用文件传参而不是命令行参数：二维码链接、user_id 这类东西不进命令行，
 *      避免出现在进程列表里。
 *   2) 人自己敲：`node binder-cli.mjs`（按环境变量与 weixin.json 的路径跑一轮）。
 *
 * 退出码：0 = 绑定成功；1 = 未成功（原因见状态文件与 stderr）。
 */
import { readFileSync } from 'node:fs'
import { runBind, runBindFromEnv, writeBindStatus } from './binder.mjs'

function readRequest(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object') throw new Error('请求文件内容不是对象')
  return parsed
}

async function main() {
  const requestFile = process.argv[2]
  const env = process.env

  if (!requestFile) {
    const final = await runBindFromEnv(env)
    if (final.state === 'success') {
      console.log(`绑定成功：bot_id=${final.botId ?? '(未给出)'} user_id=${final.userId ?? '(未给出)'}`)
      return
    }
    console.error(`绑定未完成（${final.state}）：${final.message ?? final.reason ?? '未知原因'}`)
    process.exitCode = 1
    return
  }

  const request = readRequest(requestFile)
  const statusFile = request.statusFile ?? null
  try {
    const final = await runBind({
      configFile: request.configFile,
      dataDir: request.dataDir,
      baseUrl: request.baseUrl,
      statusFile,
      timeoutMs: request.timeoutMs,
      qrFileName: request.qrFileName,
      env,
    })
    if (final.state === 'success') {
      console.log(`绑定成功（bot_id=${final.botId ?? '?'}，ownerFilled=${final.ownerFilled}）`)
      return
    }
    console.error(`绑定未完成（${final.state}）：${final.message ?? final.reason ?? '未知原因'}`)
    process.exitCode = 1
  } catch (error) {
    // 任何异常都要落进状态文件，否则对话侧只会看到「一直没动静」
    writeBindStatus(statusFile, {
      state: 'failed',
      reason: 'crashed',
      message: error?.message ?? String(error),
      step: '绑定进程异常退出',
      finishedAt: new Date().toISOString(),
    })
    console.error(`绑定进程异常：${error?.message ?? error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`绑定进程顶层异常：${error?.message ?? error}`)
  process.exitCode = 1
})
