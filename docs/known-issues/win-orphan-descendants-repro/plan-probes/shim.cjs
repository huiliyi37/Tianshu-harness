#!/usr/bin/env node
'use strict'
// 被 assign 的「中间进程」：先等 GO 文件（此时它一个子进程都还没有），
// 被 assign 进作业之后再 spawn 真正的打点进程。
//
//   node shim.cjs <marker> <goFile>
//
// 它用来回答一个决定架构的问题：
//   「一个**不是出生在作业里**、而是被事后 assign 的进程，它之后创建的子进程会不会进作业？」
//   方案 1（原生 CreateProcess(CREATE_SUSPENDED) → assign → ResumeThread）按文档就是这个形态；
//   如果答案是"否"，那么方案 1 在 MSYS 的 fork 链上也一样收不到后台孙进程。
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const [marker, goFile] = process.argv.slice(2)
if (!marker || !goFile) { console.error('usage: shim.cjs <marker> <goFile>'); process.exit(2) }

process.stdout.write(`SHIM_PID=${process.pid}\n`)

const wait = setInterval(() => {
  if (!fs.existsSync(goFile)) return
  clearInterval(wait)
  const code = `const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),250)`
  // 关键：由「已被 assign 的 shim」来创建这个子进程
  const child = spawn(process.execPath, ['-e', code, marker], { stdio: 'ignore', windowsHide: true })
  fs.writeFileSync(marker + '.child', String(child.pid))
  process.stdout.write(`SHIM_CHILD_PID=${child.pid}\n`)
  child.on('exit', () => process.exit(0))
}, 10)

setTimeout(() => process.exit(3), 60000)
