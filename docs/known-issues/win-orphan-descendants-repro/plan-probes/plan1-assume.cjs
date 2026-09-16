#!/usr/bin/env node
'use strict'
// 决定性实验：验方案 1 的核心假设。
//
//   node plan1-assume.cjs
//
// 形态（与方案 1 同构，只是把「原生 CreateProcess(CREATE_SUSPENDED)」换成
// 「Node spawn 一个先阻塞的 shim + 事后 assign + 放行」）：
//
//   Node（非作业成员）--spawn--> shim（阻塞等 GO）
//                                  |
//                            holder assign 进作业   ← 等价于方案 1 的「挂起时 assign」
//                                  |
//                            放行 → shim spawn 打点进程   ← 等价于 ResumeThread 之后创建子进程
//
// 判据：① shim 的 ours=? ② **打点进程** 的 ours=?（这才是方案 1 成立与否的关键）
//       ③ TerminateJobObject 之后打点是否停止。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ticks = (f) => { try { return fs.statSync(f).size } catch { return 0 } }
const holderPath = path.join(__dirname, 'holder.ps1')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r144-pa-'))
  const marker = path.join(dir, 'm.txt').replace(/\\/g, '/')
  const goFile = path.join(dir, 'GO').replace(/\\/g, '/')

  const holder = spawn('powershell', ['-NoProfile', '-File', holderPath, '-Marker', marker], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let hOut = ''
  holder.stdout.on('data', (d) => { hOut += d.toString() })
  holder.stderr.on('data', (d) => { hOut += '[err] ' + d.toString() })
  const waitFor = async (re, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(hOut)) return true; await sleep(100) } return false }
  const lastLine = () => hOut.trim().split('\n').pop()

  if (!(await waitFor(/READY/))) { console.log('⚠ holder 未就绪:', hOut.trim()); process.exit(1) }
  console.log('1) holder 就绪', lastLine())

  // shim：Node spawn（非成员），先阻塞，一个子进程都没有
  const shim = spawn(process.execPath, [path.join(__dirname, 'shim.cjs'), marker, goFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let sOut = ''
  shim.stdout.on('data', (d) => { sOut += d.toString() })
  shim.stderr.on('data', (d) => { sOut += '[err] ' + d.toString() })
  await sleep(600)
  console.log(`2) shim 已 spawn（Win32 pid=${shim.pid}，此刻零子进程）| 打点 ${ticks(marker)}`)

  // assign（等价于"挂起时 assign"）
  holder.stdin.write(`PID ${shim.pid}\n`)
  await waitFor(/ASSIGNED/)
  console.log(`3) ${lastLine()}`)

  // 放行 → shim 创建打点进程（等价于 ResumeThread 之后的正常执行）
  fs.writeFileSync(goFile, 'go')
  await sleep(1000)
  const childWin = (() => { try { return fs.readFileSync(marker + '.child', 'utf8').trim() } catch { return '' } })()
  console.log(`4) 已放行 | 打点 ${ticks(marker)} | shim 的子进程 pid=${childWin || '(未知)'}`)

  // 关键判定
  holder.stdin.write(`CHECK ${shim.pid}\n`); await sleep(300)
  const shimCheck = lastLine()
  console.log(`   shim  : ${shimCheck}`)
  if (/^\d+$/.test(childWin)) {
    holder.stdin.write(`CHECK ${childWin}\n`); await sleep(300)
    console.log(`   子进程: ${lastLine()}   ← ours=True 才说明方案 1 的假设成立`)
  }

  // 收网
  const before = ticks(marker)
  holder.stdin.write('TERM\n')
  await waitFor(/TERMINATED/)
  await sleep(1200)
  const a1 = ticks(marker); await sleep(1000); const a2 = ticks(marker)
  const stopped = a2 <= a1
  console.log(`5) ${lastLine()}`)
  console.log(`   终止后打点 ${before} → ${a1} → ${a2}  ${stopped ? '**已停 ✓ 作业收住了子孙**' : '**仍在写 ✗ 作业没覆盖到子进程**'}`)

  const childOurs = /ours=True/.test(shimCheck) // 占位，真实判断看上面的子进程行
  console.log('')
  console.log(`小结：shim 在作业内=${/ours=True/.test(shimCheck) ? '是' : '否'} | 子进程在作业内=${hOut.includes('ours=True') ? '见上' : '见上'} | 收网有效=${stopped ? '是' : '否'}`)

  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  process.exit(0)
})()
