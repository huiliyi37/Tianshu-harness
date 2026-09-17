'use strict'
// 公共部分：bash 定位、打点判据、严格枚举 + 归属校验的回收封装。
// 判据只有一个：打点文件（marker）在「杀之后」是否还在增长——比看进程表可靠。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BASH = process.env.BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe'
const TICK_MS = 250
const DRY = process.env.DRY === '1'
const HERE = __dirname.replace(/\\/g, '/') // bash 更喜欢正斜杠

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ticks = (f) => { try { return fs.statSync(f).size } catch { return 0 } }

const sh = (args) => {
  const r = spawnSync(BASH, args, { encoding: 'utf8', windowsHide: true })
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), rc: r.status }
}

function workdir(prefix = 'r144-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, marker: path.join(dir, 'm.txt').replace(/\\/g, '/') }
}
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }

// harness 的进程形态：nohup 起来之后由 bash 自己 wait 住
const backgroundTicker = (marker) =>
  `nohup node -e "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),${TICK_MS})" "${marker}" >/dev/null 2>&1 & wait`

// 严格枚举 → 归属校验 → 逐 PID 回收（方案 3 的完整形态）
// DRY=1 时只列出「准备杀谁」并打印校验结论，不真的动手 —— 试刀之前先看一眼。
function guardedRecover(mode, arg, { verbose = true } = {}) {
  const t = sh([`${HERE}/tree.sh`, mode, arg])
  if (verbose && t.err) t.err.split('\n').filter((l) => l.startsWith('PID')).forEach((l) => console.log('      ' + l))
  const pids = t.out.split(/\s+/).filter(Boolean)
  if (!pids.length) return { pids, verdict: 'NOROOT（没找到根，走兜底）', killed: [] }

  const g = sh([`${HERE}/guard.sh`, pids.join(' ')])
  if (g.rc !== 0) return { pids, verdict: g.out, killed: [] } // 校验不过 → 宁可泄漏也不误杀
  if (DRY) return { pids, verdict: g.out + ' [DRY：未执行 kill]', killed: [] }

  const killed = []
  for (const p of pids) if (sh(['-c', `kill -9 ${p} 2>/dev/null && echo ok`]).out === 'ok') killed.push(p)
  return { pids, verdict: g.out, killed }
}

// 金丝雀：回收前后对比，用来发现「误伤」（默认数 bash.exe；可用 CANARY_PATTERN 覆盖）
const CANARY = process.env.CANARY_PATTERN || 'bash.exe'
const canary = () => Number(sh(['-c', `ps -W | grep -cE "${CANARY}"`]).out || 0)

module.exports = { BASH, TICK_MS, sleep, ticks, sh, workdir, cleanup, backgroundTicker, guardedRecover, canary }
