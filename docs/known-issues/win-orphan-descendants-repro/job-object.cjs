#!/usr/bin/env node
'use strict'
// 作业对象正反例的驱动。判定用打点（marker 长度），不靠看进程表。
//
//   node job-object.cjs
//
//   inside  自建作业 → 自己入作业 → 由它 spawn bash → TerminateJobObject   → 期望 STOPPED
//   assign  对已经跑起来的 bash 事后 assign → TerminateJobObject            → 期望 STILL_WRITING
//
// 两者的差别只有一句：**谁拥有 spawn**。作业成员资格随父进程继承，
// 所以「spawn 之后再 assign」在 bash 已经 fork 出后台 node 之后必然追不上。
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const { BASH, sleep, ticks, workdir, cleanup, guardedRecover, canary } = require('./lib.cjs')

const PS1 = path.join(__dirname, 'job-object.ps1')
const PS = process.env.POWERSHELL || 'powershell'

function runPs(args) {
  const p = spawn(PS, ['-NoProfile', '-File', PS1, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  p.stdout.on('data', (d) => { out += d.toString() })
  p.stderr.on('data', (d) => { out += '[err] ' + d.toString() })
  return { p, get out() { return out } }
}

function verdictOf(out) {
  if (/STOPPED \(/.test(out)) return 'STOPPED（作业对象收住了）'
  if (/STILL_WRITING/.test(out)) return 'STILL_WRITING（没收住）'
  return '未判定'
}

async function trialInside() {
  const { dir, marker } = workdir('r144-job-inside-')
  const c0 = canary()
  console.log('\n########## 正例：inside（自己入作业，再 spawn bash） ##########')
  const r = runPs(['-Mode', 'inside', '-Marker', marker])
  const exited = new Promise((res) => r.p.on('exit', res))
  // keeper 自入作业，所以 TerminateJobObject 会连它自己一起杀 → 判定必须由 Node 侧做
  for (let i = 0; i < 60 && !/before_kill_ticks=/.test(r.out) && r.p.exitCode === null; i++) await sleep(250)
  const peaked = ticks(marker)
  console.log('  keeper :', r.out.trim().split('\n').join(' | '))
  console.log(`  杀之前 : 打点 = ${peaked}`)
  await exited

  await sleep(1200)
  const a1 = ticks(marker); await sleep(1000); const a2 = ticks(marker)
  const stopped = a2 <= a1
  console.log(`  终止后 : 打点 ${a1} → ${a2}  ${stopped ? 'STOPPED（打点已停 ✓）' : 'STILL_WRITING（仍在写 ✗）'}`)

  const c1 = canary()
  console.log(`  金丝雀 : ${c0} → ${c1} ${c1 <= c0 ? '✓未误伤' : '⚠ 变了'}`)
  const swept = guardedRecover('--match', marker, { verbose: false })
  console.log(`  清理   : 事后清扫杀掉 ${swept.killed.length} 个残留（正例里应为 0）| ${swept.verdict}`)
  cleanup(dir)
  return { name: '正例 inside', verdict: stopped ? 'STOPPED（作业对象收住了）' : 'STILL_WRITING（没收住）', canaryOk: c1 <= c0, swept: swept.killed.length }
}

async function trialAssign() {
  const { dir, marker } = workdir('r144-job-assign-')
  const c0 = canary()
  console.log('\n########## 反例：assign（先 spawn，事后 assign） ##########')
  const inner = `nohup node -e "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),250)" "${marker}" >/dev/null 2>&1 & wait`
  const bash = spawn(BASH, ['-c', inner], { stdio: 'ignore', windowsHide: true })
  await sleep(1200)                                  // 等 bash 把后台 node fork 出来（实测 100–300ms 足够）
  const t0 = ticks(marker)
  console.log(`  起后   : 打点 = ${t0} | bash Win32 pid = ${bash.pid}`)

  const r = runPs(['-Mode', 'assign', '-ShellPid', String(bash.pid), '-Marker', marker])
  const exited = new Promise((res) => r.p.on('exit', res))
  // 等它打出 READY 再下达终止指令
  for (let i = 0; i < 40 && !/READY/.test(r.out) && r.p.exitCode === null; i++) await sleep(250)
  console.log('  keeper :', r.out.trim().split('\n').join(' | '))
  await sleep(500)
  const before = ticks(marker)
  try { if (r.p.exitCode === null) r.p.stdin.write('TERM\n') } catch (e) { console.log('  ⚠ 写 stdin 失败：', e.message) }
  await sleep(1500)
  const a1 = ticks(marker); await sleep(1000); const a2 = ticks(marker)
  const stopped = a2 <= a1
  console.log(`  终止后 : 打点 ${before} → ${a1} → ${a2}  ${stopped ? 'STOPPED' : 'STILL_WRITING（如预期：那个 node 没进作业）'}`)
  await exited

  const c1 = canary()
  console.log(`  金丝雀 : ${c0} → ${c1} ${c1 <= c0 ? '✓未误伤' : '⚠ 变了'}`)
  const swept = guardedRecover('--match', marker, { verbose: false })
  console.log(`  清理   : 用方案 3 收尾，杀掉 ${swept.killed.length} 个残留 | ${swept.verdict}`)
  cleanup(dir)
  return { name: '反例 assign', verdict: stopped ? 'STOPPED（意外）' : 'STILL_WRITING（符合预期）', canaryOk: c1 <= c0, swept: swept.killed.length }
}

;(async () => {
  console.log('bash     :', BASH)
  const a = await trialInside()
  const b = await trialAssign()
  console.log('\n===== 汇总 =====')
  for (const r of [a, b]) console.log(`${r.name}: ${r.verdict} | 误伤=${r.canaryOk ? '无' : '有'} | 事后清扫=${r.swept} 个`)
  process.exit(0)
})()
