#!/usr/bin/env node
'use strict'
// 端口释放窗口：命令被超时中止后，它占的端口多久能被重新 bind。
//
//   node port-release.cjs          （默认端口 34567，可用 PORT=xxxxx 覆盖）
//
//   A 现状（两阶段）: t≈0.5s `taskkill /T`（不带 /F）→ t≈3.5s `taskkill /F /T`
//   B 本改动        : t≈0.5s `taskkill /F /T`
//
// 不带 /F 的 taskkill 对 console 子进程是 no-op（收不到 WM_CLOSE），
// 所以 A 里的前 3 秒是纯空转 —— 端口在这段时间一直被占着。
// 这个脚本产出的是 PR #159 里那个「4.0s → 0.7s」的原始观测。
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const { BASH, sleep } = require('./lib.cjs')

const PORT = Number(process.env.PORT || 34567)
const GRACE_MS = 3000   // harness 里「优雅阶段 → 强制阶段」的间隔

const canBind = () => new Promise((resolve) => {
  const s = net.createServer()
  s.once('error', () => resolve(false))
  s.once('listening', () => s.close(() => resolve(true)))
  s.listen(PORT, '127.0.0.1')
})

async function trial(label, forceAtOnce) {
  console.log(`\n########## ${label} ##########`)
  const inner = `node -e "require('http').createServer((q,r)=>r.end('x')).listen(${PORT},'127.0.0.1',()=>console.log('listening'))"`
  const child = spawn(BASH, ['-c', inner], { stdio: 'ignore', windowsHide: true })
  const t0 = Date.now()
  const tk = (args) => spawnSync('taskkill', args, { windowsHide: true })

  // 等端口真的被占上
  let up = false
  for (let i = 0; i < 40; i++) { await sleep(100); if (!(await canBind())) { up = true; break } }
  console.log(`  端口占用于 t=${Date.now() - t0}ms（up=${up}）| bash pid = ${child.pid}`)
  if (!up) { console.log('  ⚠ 端口没被占上，本轮测不了'); return null }

  await sleep(Math.max(0, 500 - (Date.now() - t0)))
  if (forceAtOnce) {
    tk(['/F', '/T', '/PID', String(child.pid)])
  } else {
    tk(['/T', '/PID', String(child.pid)])                                    // 优雅阶段（实测 no-op）
    setTimeout(() => tk(['/F', '/T', '/PID', String(child.pid)]), GRACE_MS)  // 兜底阶段
  }

  let freedAt = null
  for (let i = 0; i < 120; i++) {
    await sleep(100)
    if (await canBind()) { freedAt = Date.now() - t0; break }
  }
  console.log(`  端口释放于 t=${freedAt === null ? '>12s（仍未释放）' : freedAt + 'ms'} → 锁窗口 ${freedAt === null ? '>12s' : (freedAt / 1000).toFixed(1) + 's'}`)
  try { tk(['/F', '/T', '/PID', String(child.pid)]) } catch {}
  await sleep(300)
  return freedAt
}

;(async () => {
  console.log('bash :', BASH, '| port', PORT)
  const a = await trial('A 现状：taskkill /T → 等 ' + GRACE_MS + 'ms → taskkill /F /T', false)
  const b = await trial('B 本改动：直接 taskkill /F /T', true)
  console.log('\n===== 小结 =====')
  console.log(`A（两阶段）: ${a === null ? 'n/a' : (a / 1000).toFixed(1) + 's'} | B（直接 /F）: ${b === null ? 'n/a' : (b / 1000).toFixed(1) + 's'}`)
  if (a && b) console.log(`差值: ${((a - b) / 1000).toFixed(1)}s —— 这就是不带 /F 那段纯空转的代价`)
  process.exit(0)
})()
