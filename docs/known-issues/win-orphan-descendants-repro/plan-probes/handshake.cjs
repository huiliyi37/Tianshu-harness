#!/usr/bin/env node
'use strict'
// 候选修复原型（无原生依赖）：把「抢竞态」换成「先 assign 再放行」的握手。
//
//   node handshake.cjs
//
// 形态：
//   1. 先起一个预热好的 job holder（PowerShell，Add-Type 已编译）+ 一个 GO 文件（尚不存在）；
//   2. Node 自己 spawn 壳（保 stdio、保 spawn 归属），壳的第一件事是**等 GO 文件**
//      —— 在放行之前它不会 fork 任何东西；
//   3. 壳还在阻塞时，把它的 PID 交给 holder assign 进作业（此时不存在竞态：
//      "spawn 之后再 assign"之所以追不上，是因为壳 100–300ms 内就 fork 了后台 node；
//      现在壳被 GO 文件挡着，不存在这个窗口）；
//   4. 放行（创建 GO 文件）→ 后台 node 出生即在作业里；
//   5. 超时/中止时 holder TerminateJobObject → 整棵树一起收。
//
// 判据仍是打点文件增长（不看进程表），另加金丝雀与残留计数。
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BASH = process.env.BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ticks = (f) => { try { return fs.statSync(f).size } catch { return 0 } }
const sh = (args) => spawnSync(BASH, args, { encoding: 'utf8', windowsHide: true })
const residual = (m) => Number((sh(['-c', `ps -ef | grep -F "${m}" | grep -v grep | wc -l`]).stdout || '0').trim())
const canary = () => Number((sh(['-c', 'ps -W | grep -cE "bash.exe"']).stdout || '0').trim())

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r144-hs-'))
  const marker = path.join(dir, 'm.txt').replace(/\\/g, '/')
  const goFile = path.join(dir, 'GO').replace(/\\/g, '/')
  const c0 = canary()
  console.log('bash    :', BASH)
  console.log('marker  :', marker)

  // 1) 预热 holder
  const holder = spawn('powershell', ['-NoProfile', '-File', path.join(__dirname, 'holder.ps1'), '-Marker', marker], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let hOut = ''
  holder.stdout.on('data', (d) => { hOut += d.toString() })
  holder.stderr.on('data', (d) => { hOut += '[err] ' + d.toString() })
  const waitFor = async (re, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(hOut)) return true; await sleep(100) } return false }

  const t0 = Date.now()
  if (!(await waitFor(/READY/))) { console.log('⚠ holder 没就绪：', hOut.trim()); process.exit(1) }
  console.log(`1) holder 就绪（含 Add-Type 编译）: ${Date.now() - t0}ms`)

  // 2) 自己 spawn 壳；壳先等 GO 文件，放行前绝不 fork
  const inner = `i=0; while [ ! -f "${goFile}" ] && [ $i -lt 500 ]; do sleep 0.01; i=$((i+1)); done; ` +
    `nohup node -e "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),250)" "${marker}" >/dev/null 2>&1 & wait`
  const child = spawn(BASH, ['-c', inner], { stdio: 'ignore', windowsHide: true })
  console.log(`2) 壳已 spawn（Win32 pid=${child.pid}），此刻它在等 GO —— 还没有任何 fork`)
  await sleep(300)
  console.log(`   此刻打点 = ${ticks(marker)}（应为 0，证明"放行前没 fork"）| 残留 ${residual(marker)}`)

  // 3) 交出 PID，让它 assign 进作业（壳仍被挡着，无竞态）
  holder.stdin.write(`PID ${child.pid}\n`)
  if (!(await waitFor(/ASSIGNED/))) { console.log('⚠ assign 没回：', hOut.trim()); process.exit(1) }
  console.log(`3) ${hOut.trim().split('\n').pop()}`)

  // 4) 放行
  fs.writeFileSync(goFile, 'go')
  await sleep(900)
  const growing = ticks(marker)
  console.log(`4) 已放行，t≈0.9s 打点 = ${growing} ${growing > 0 ? '（后台 node 在写 ✓）' : '⚠ 没起来'}`)

  // 4b) 直接问系统：壳 和 它 fork 出来的 node 分别在不在我们的作业里？
  //     Win32 PID 要经 MSYS 的 /proc/<msys_pid>/winpid 换算（ps -W 的列在这里拿不到）
  const msysPids = ((sh(['-c', `ps -ef | grep -F "${marker}" | grep -v grep | awk '{print $2}'`]).stdout || '').trim().split(/\s+/)).filter(Boolean)
  console.log(`   匹配 marker 的 MSYS pid = ${msysPids.join(',') || '(无)'}`)
  const winpidOf = (p) => ((sh(['-c', `cat /proc/${p}/winpid 2>/dev/null`]).stdout || '').trim())
  console.log(`   壳 : MSYS/WIN = ${child.pid} -> (Node 侧只有 Win32 pid，见 step 3)`)
  const nodeWin = msysPids.map((p) => winpidOf(p)).filter((v) => /^\d+$/.test(v))
  console.log(`   node: WIN pid = ${nodeWin.join(',') || '(取不到)'}`)
  holder.stdin.write(`CHECK ${child.pid}\n`)
  await sleep(300)
  console.log(`  ${hOut.trim().split('\n').pop()}`)
  for (const wp of nodeWin) {
    holder.stdin.write(`CHECK ${wp}\n`)
    await sleep(300)
    console.log(`  ${hOut.trim().split('\n').pop()}`)
  }

  // 5) 收网：TerminateJobObject
  const before = ticks(marker)
  holder.stdin.write('TERM\n')
  if (!(await waitFor(/TERMINATED/))) { console.log('⚠ terminate 没回：', hOut.trim()) }
  await sleep(1200)
  const a1 = ticks(marker); await sleep(1000); const a2 = ticks(marker)
  const stopped = a2 <= a1
  const c1 = canary()
  console.log(`5) ${hOut.trim().split('\n').pop()}`)
  console.log(`   终止后打点 ${before} → ${a1} → ${a2}  ${stopped ? '**已停 ✓ 整棵树被作业收走**' : '**仍在写 ✗ 作业没覆盖到**'}`)
  console.log(`   残留 ${residual(marker)} | 金丝雀 ${c0} → ${c1} ${c1 <= c0 ? '✓未误伤' : '⚠ 变了'}`)
  console.log('')
  console.log(`小结：握手 assign 可用=${growing > 0 ? '是' : '否'} 收网有效=${stopped ? '是' : '否'}`)

  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  process.exit(0)
})()
