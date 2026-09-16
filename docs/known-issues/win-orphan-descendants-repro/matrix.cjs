#!/usr/bin/env node
'use strict'
// 场景矩阵：把「现状泄漏 → 方案 3 回收」在四种情况下各跑一遍。
//
//   node matrix.cjs          真跑（会 kill）
//   DRY=1 node matrix.cjs    只看准备杀谁，不动手
//
//   S1  壳**还活着**时回收：自报 $$ 拿根 → 向上验证 → 归属校验 → 整棵树一并回收（推荐形态）
//   S2  壳**已死**后清扫：先 taskkill（泄漏）→ 按 token 找不到根 → 退回 argv 指纹找到那个 leaf
//   S3  两棵树并发，只回收 A：B 必须不受影响（隔离性）
//   S4  壳秒退（命令不存在）→ 必须走兜底、不报错、不误杀
//
// 每个场景都带金丝雀（默认数 bash.exe，CANARY_PATTERN 可改）；回收前后不一致即判定误伤。
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { BASH, sleep, ticks, sh, workdir, cleanup, canary } = require('./lib.cjs')

const rnd = (p) => p + Math.random().toString(36).slice(2, 8)
const here = (f) => path.join(__dirname, f).replace(/\\/g, '/')
const DRY = process.env.DRY === '1'

// token 只挂在壳的命令行里（现实中就是这样：包了一层 wrapper 才有 token）
function ticker(marker) {
  return `nohup node -e "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),250)" "${marker}" >/dev/null 2>&1 & wait`
}

async function leakAfterTaskkill(winPid, marker) {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(winPid)], { windowsHide: true })
  await sleep(400)
  const a = ticks(marker); await sleep(800); const b = ticks(marker)
  return b > a
}

// 严格枚举 + 归属校验 + 逐 PID kill
function recover(mode, arg) {
  const t = sh([here('tree.sh'), mode, arg])
  const pids = t.out.split(/\s+/).filter(Boolean)
  const detail = t.err.split('\n').filter((l) => l.startsWith('PID'))
  const g = pids.length ? sh([here('guard.sh'), pids.join(' ')]) : { out: 'NOROOT（没匹配到根）', rc: 1 }
  const killed = []
  if (g.rc === 0 && !DRY) {
    for (const p of pids) if (sh(['-c', `kill -9 ${p} 2>/dev/null && echo ok`]).out === 'ok') killed.push(p)
  }
  return { pids, detail, verdict: g.out + (DRY && g.rc === 0 ? ' [DRY]' : ''), passed: g.rc === 0, killed: killed.length }
}

async function scenario(name, { wrap, mode, fallbacks = [] }, opts = {}) {
  const { dir, marker } = workdir('r144-s-')
  const token = rnd('RVTT')
  const rootPidFile = path.join(dir, 'root.pid').replace(/\\/g, '/')
  const userCmd = opts.userCmd || ticker(marker)
  const c0 = canary()
  const killFirst = opts.killFirst !== false

  console.log(`\n########## ${name} ##########`)
  const child = spawn(BASH, ['-c', wrap(userCmd, token, rootPidFile)], { stdio: 'ignore', windowsHide: true })
  await sleep(900)
  console.log(`  起后   : 打点 = ${ticks(marker)} | 金丝雀 = ${c0} | Win32 pid = ${child.pid}`)

  let leaked = null
  if (killFirst) {
    leaked = await leakAfterTaskkill(child.pid, marker)
    console.log(`  现状后 : ${leaked ? '仍在写（泄漏）' : '已停'}`)
  } else {
    console.log('  现状后 : 未先杀 —— 本轮演示「趁壳还活着就回收」')
  }

  // 逐个候选指纹试，直到有一个能定位到可杀集合
  // --match 的两个候选体现了实测结论：壳死后 token 找不到根，argv 指纹（marker）才找得到
  const candidates = mode === '--pid'
    ? [['--pid', (() => { try { return fs.readFileSync(rootPidFile, 'utf8').trim() } catch { return '' } })()]]
    : [[mode, token], [mode, marker], ...fallbacks.map((f) => [mode, f])]

  let rec = null
  for (const [m, a] of candidates) {
    if (!a) { console.log(`  枚举   : 模式 ${m}，指纹为空 → 跳过`); continue }
    console.log(`  枚举   : 模式 ${m}，指纹 = ${a}`)
    const r = recover(m, a)
    r.detail.forEach((l) => console.log('           ' + l))
    console.log(`  校验   : ${r.verdict}`)
    if (r.passed) { rec = r; break }
    console.log('           → 这条指纹拿不到可杀集合，换下一条')
  }

  if (!rec) {
    const residual = Number(sh(['-c', `ps -ef | grep -F "${marker}" | grep -v grep | wc -l`]).out || 0)
    console.log(`  放弃   : 所有指纹都没通过校验 → 退回 taskkill 兜底（宁漏不误杀）| 残留 ${residual}`)
    cleanup(dir)
    return { name, leaked, stopped: false, residual, canaryOk: true, killed: 0, notes: '校验全不过，按安全条款放弃' }
  }

  await sleep(600)
  const a = ticks(marker); await sleep(1000); const b = ticks(marker)
  const stopped = b <= a
  const residual = Number(sh(['-c', `ps -ef | grep -F "${marker}" | grep -v grep | wc -l`]).out || 0)
  const c1 = canary()
  console.log(`  回收后 : 打点 ${a} → ${b} ${stopped ? '已停 ✓' : '仍在写 ✗'} | 残留 ${residual} | 金丝雀 ${c1} ${c1 <= c0 ? '✓未误伤' : '⚠ 变了'} | 杀掉 ${rec.killed} 个`)

  cleanup(dir)
  return { name, leaked, stopped, residual, canaryOk: c1 <= c0, killed: rec.killed, notes: DRY ? 'DRY（未真杀）' : '' }
}

async function isolationScenario() {
  console.log('\n########## S3 两棵树并发（隔离性） ##########')
  const A = workdir('r144-A-'), B = workdir('r144-B-')
  const tokA = rnd('RVTA'), tokB = rnd('RVTB')
  const c0 = canary()
  const ca = spawn(BASH, ['-c', `: RIVET_TREE=${tokA}; ${ticker(A.marker)}`], { stdio: 'ignore', windowsHide: true })
  const cb = spawn(BASH, ['-c', `: RIVET_TREE=${tokB}; ${ticker(B.marker)}`], { stdio: 'ignore', windowsHide: true })
  await sleep(900)
  spawnSync('taskkill', ['/F', '/T', '/PID', String(ca.pid)], { windowsHide: true })
  spawnSync('taskkill', ['/F', '/T', '/PID', String(cb.pid)], { windowsHide: true })
  await sleep(400)

  // 壳已死 → token 找不到，退回 marker 指纹（各自的 marker 不同，天然隔离）
  const recA = recover('--match', A.marker)
  console.log(`  回收 A : 收集 ${recA.pids.length} 个 | ${recA.verdict} | 杀掉 ${recA.killed} 个`)
  await sleep(1200)
  const a0 = ticks(A.marker), b0 = ticks(B.marker)
  await sleep(900)
  const a1 = ticks(A.marker), b1 = ticks(B.marker)
  console.log(`  A      : ${a0} → ${a1} ${a1 <= a0 ? '已停 ✓' : '仍在写 ✗'}`)
  console.log(`  B      : ${b0} → ${b1} ${b1 > b0 ? '仍在写 ✓（未受影响）' : '也停了 ⚠ 被误伤'}`)

  const recB = recover('--match', B.marker)
  console.log(`  清理 B : ${recB.verdict} | 杀掉 ${recB.killed} 个`)
  const c1 = canary()
  console.log(`  金丝雀 : ${c0} → ${c1} ${c1 <= c0 ? '✓未误伤' : '⚠ 变了'}`)
  cleanup(A.dir); cleanup(B.dir)
  return { name: 'S3 并发隔离', leaked: true, stopped: a1 <= a0, residual: 0, canaryOk: c1 <= c0, killed: recA.killed + recB.killed, notes: b1 > b0 ? 'B 未受影响' : 'B 被误伤' }
}

;(async () => {
  const results = []
  results.push(await scenario('S1 趁壳还活着回收（--pid，自报 $$）', {
    wrap: (u, _t, rootPidFile) => `echo $$ > "${rootPidFile}"; ${u}`,
    mode: '--pid',
  }, { killFirst: false }))

  results.push(await scenario('S2 壳已死之后清扫（token 找不到 → 退回 marker）', {
    wrap: (u, t) => `: RIVET_TREE=${t}; ${u}`,
    mode: '--match',
  }, { fallbacks: [] })) // 需要 marker：从闭包外拿不到，下面单独处理

  results.push(await isolationScenario())

  results.push(await scenario('S4 壳秒退（命令不存在）', {
    wrap: (u, t) => `: RIVET_TREE=${t}; ${u}`,
    mode: '--match',
  }, { userCmd: 'exit 3' }))

  console.log('\n===== 汇总 =====')
  for (const r of results) {
    console.log(`${r.name}: 泄漏=${r.leaked === null ? '未测' : r.leaked ? '是' : '否'} 回收后停止=${r.stopped ? '是' : '否'} 残留=${r.residual} 误伤=${r.canaryOk ? '无' : '有'} 杀掉=${r.killed}${r.notes ? ' (' + r.notes + ')' : ''}`)
  }
  process.exit(0)
})()
