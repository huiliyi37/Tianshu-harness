#!/usr/bin/env node
'use strict'
// 最小复现 + 事后清扫。
//
//   node repro.cjs
//
// 三步叙事：
//   1. 起一棵「bash → nohup node 打点」的树，模拟 harness 的命令；
//   2. 用现状兜底 taskkill /F /T 杀壳 → 打点仍在增长（= 泄漏复现）；
//   3. 事后清扫：按 **argv 指纹**（marker 路径，它就在那个 node 的命令行里）
//      严格枚举 → 归属校验 → kill → 打点停止、残留归零。
//
// 注意第 3 步为什么不能用壳自报的 $$：壳已经死了，它的 PID 已不在进程表里，
// 「按根枚举」必然 NOROOT。事后只能按 argv 指纹找活着的那一方。
const { spawn, spawnSync } = require('node:child_process')
const { BASH, sleep, ticks, sh, workdir, cleanup, backgroundTicker, guardedRecover, canary } = require('./lib.cjs')

;(async () => {
  const { dir, marker } = workdir('r144-repro-')
  const residual = () => Number(sh(['-c', `ps -ef | grep -F "${marker}" | grep -v grep | wc -l`]).out || 0)

  console.log('platform :', process.platform, '| node', process.version)
  console.log('bash     :', BASH)
  console.log('marker   :', marker)
  console.log('')

  const child = spawn(BASH, ['-c', backgroundTicker(marker)], { stdio: 'ignore', windowsHide: true })
  console.log('1) spawn : bash Win32 pid =', child.pid, '（Win32 视图；MSYS 侧另有 PID）')

  await sleep(900)
  const t0 = ticks(marker)
  console.log(`   t≈0.9s: 打点 = ${t0}  ${t0 > 0 ? '（后台 node 已在写）' : '⚠ 打点没起来，环境不对'}`)

  const tk = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
  console.log('2) 现状杀: taskkill /F /T（rc=' + (tk.status === null ? 'n/a' : tk.status) + '）')
  await sleep(400)
  const a = ticks(marker); await sleep(1000); const b = ticks(marker)
  const leaked = b > a
  console.log(`   杀之后: 打点 ${a} → ${b}  ${leaked ? '→ 仍在增长 = **泄漏已复现**' : '→ 已停止 = 本环境未复现'} | 残留 ${residual()}`)

  console.log('')
  console.log('3) 事后清扫: 按 marker 指纹枚举（tree.sh --match）')
  const c0 = canary()
  const rec = guardedRecover('--match', marker)
  console.log('   校验  :', rec.verdict)

  await sleep(600)
  const c = ticks(marker); await sleep(1200); const d = ticks(marker)
  const stopped = d <= c
  const c1 = canary()
  console.log(`   结果  : 打点 ${c} → ${d} ${stopped ? '→ 已停 ✓' : '→ 仍在写 ✗'} | 残留 ${residual()} | 金丝雀 ${c0} → ${c1} ${c1 <= c0 ? '✓ 未误伤' : '⚠ 变了'}`)

  console.log('')
  console.log(`小结     : 泄漏=${leaked ? '是' : '否'} | 事后清扫后停止=${stopped ? '是' : '否'} | 杀掉=${rec.killed.length} 个`)

  cleanup(dir)
  process.exit(0)
})()
