#!/usr/bin/env tsx
/**
 * `npm run typecheck` 的跨进程闸门入口。
 *
 * 行为与 `tsc --noEmit` 等价（同样的输出、同样的退出码），区别只在于：并发会话
 * 检查同一份代码时只有一个真的跑，其余回放它的结果；指纹不同则排队而不是抢核。
 *
 * 本仓库常有多个 agent 会话共用一个工作树，全量检查要 43s（2319 个文件），
 * 并发跑是超线性退化。闸门与 `lsp/client.ts` 的交付门禁共用同一把锁与同一份缓存目录。
 *
 * 逃生口：`npm run typecheck:direct` 直接跑 tsc，或 `RIVET_TYPECHECK_SHARE=0`。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runTypecheckShared, type TscRunOutcome } from '../src/lsp/typecheck-cache.js'

const cwd = process.cwd()

// 走管道后 tsc 看不到 TTY 会自动去掉颜色，显式指定才能保住人读体验。两种格式
// 的原始输出不可互换，但 variant 跟着参数走，缓存自然分桶。
const TSC_ARGS = ['--noEmit', '--pretty', process.stdout.isTTY ? 'true' : 'false']

function resolveTsc(): string | undefined {
  const bin = join(cwd, 'node_modules', '.bin')
  const candidates = process.platform === 'win32'
    ? [join(bin, 'tsc.cmd'), join(bin, 'tsc')]
    : [join(bin, 'tsc')]
  return candidates.find(existsSync)
}

const tscPath = resolveTsc()
if (!tscPath) {
  process.stderr.write('[typecheck] node_modules/.bin/tsc 不存在——先 npm install\n')
  process.exit(2)
}

function runTsc(): Promise<TscRunOutcome> {
  return new Promise(resolve => {
    const useShell = process.platform === 'win32' && tscPath!.toLowerCase().endsWith('.cmd')
    const child = spawn(useShell ? `"${tscPath}"` : tscPath!, TSC_ARGS, {
      cwd,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', err => resolve({ status: null, stdout, stderr: stderr + String(err) }))
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

// 提示一律走 stderr：stdout 要保持与直接跑 tsc 逐字节一致，下游可能有解析。
const note = (msg: string) => process.stderr.write(`[typecheck] ${msg}\n`)

// 等待可能长达数分钟（持锁者在跑全量），期间一声不吭会被当成卡死。
let ticker: NodeJS.Timeout | undefined
const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = undefined } }

const outcome = await runTypecheckShared({
  cwd,
  run: runTsc,
  variant: TSC_ARGS.join(' '),
  onEvent: event => {
    if (event.kind !== 'waiting') stopTicker()
    switch (event.kind) {
      case 'cache-hit':
        return note(`复用 ${secs(event.ageMs)} 前的结果——源码指纹未变`)
      case 'waiting': {
        const since = Date.now()
        ticker = setInterval(() => note(`仍在等待…（已等 ${secs(Date.now() - since)}）`), 15_000)
        ticker.unref()
        return note(`另一进程正在检查${event.holderPid ? `（pid ${event.holderPid}）` : ''}，等它跑完直接复用`)
      }
      case 'reuse-after-wait':
        return note(`等待 ${secs(event.waitedMs)} 后复用了并发进程的结果`)
      case 'wait-timeout':
        return note(`等待 ${secs(event.waitedMs)} 未果，改为自己跑`)
      case 'stale-lock-cleared':
        return note(`清理了陈旧的锁${event.holderPid ? `（pid ${event.holderPid} 已不存在）` : ''}`)
      case 'ran':
        return note(`实跑 ${secs(event.durationMs)}${event.cached ? '' : '（结果未缓存）'}`)
    }
  },
})
stopTicker()

process.stdout.write(outcome.stdout)
process.stderr.write(outcome.stderr)
// status 为 null = 超时/被信号杀，按失败退出：调用方不该把「没跑完」当成通过。
process.exit(outcome.status ?? 1)
