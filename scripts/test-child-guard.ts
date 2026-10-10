/**
 * 测试子进程护栏 —— 替代 `--test-force-exit` 的三层方案。
 *
 * ## 为什么不再用 `--test-force-exit`
 *
 * 2026-09-12 实测（node 24.1，desktop 197 个文件）：带该 flag 同一命令四次跑分别报
 * 1523 / 1640 / 1661 / **无汇总**，四次 exit 0 且 fail 0；同批不带该 flag 的 plain
 * 跑两次都稳定报 1789（进程正常退出）。`--test-concurrency=1` 也救不了（1752）。
 * 也就是说 flag 在当代 node 上会让 node 提前判定"全部完成"并退出，**丢掉的用例既
 * 不进计数也不进退出码**——正是"假绿"最贵的形状：观察者区分不了跑完与没跑完。
 *
 * ## 为什么不能只是删掉它
 *
 * 该 flag 原本承担实活：测试跑完但句柄（socket/watcher/定时器）未释放时，让进程
 * 照样收场。2026-07-29 就是缺这类护栏才攒下跑满 2 天 13 小时、占 75% CPU 的僵留
 * 进程（`--test-timeout` 只把超时用例判失败，进程仍撑着事件循环）。
 *
 * ## 所以：plain + 看门狗 + 完整性闸
 *
 *  1. **plain 跑法**：不做强制提前退出，让 node 自己打完汇总段；
 *  2. **idle / hard 看门狗**：真挂起时有界收场，不留僵留进程（替代 flag 的兜底职责）；
 *  3. **汇总完整性 fail-closed**：进程退出却没见到 `ℹ tests` 行 = 什么都没验证，判非零。
 *     这一条把"核对报告条数"从人的归因习惯（见
 *     docs/analysis/2026-08-02-测试静默少跑仍报通过.md 的行动项）变成机器的闸。
 *  4. **进程树收场**（2026-09-24 补）：POSIX 批次自成进程组，Windows 保持隐藏控制台
 *     并用 taskkill /T 收场。只 kill 直接子进程会漏掉**孙进程**——测试自己 spawn 的
 *     长驻子进程（如 `test-runner-flags` 的 hang fixture runner）在祖父被杀后
 *     reparent 到 init 永久存活：实测机器上攒下 21 个 PPID=1、存活 11h~3天7h 的孤儿。
 *     第 4 条与 fixture 自带的寿命上限互为兜底：前者管「有人来得及杀」，后者管
 *     「整棵树被 SIGKILL 端掉、没人来得及」（见 test-runner-flags.test.ts 的 8s 自毁）。
 *
 * 汇总已出现但进程不退时（句柄未释放）**不判失败**：测试确实跑完了，看门狗只负责
 * 收尾，以完整汇总的 fail / cancelled 计数判定；自然退出的非零码仍须保留。
 */

import { spawn } from 'node:child_process'
import { completionBatch } from '../src/tools/test-completion.js'
import { forceKillTree } from '../src/platform.js'

/** 无任何输出多久视为挂起。最慢单用例 ~40s（见 test-runner-flags.ts 依据），留足余量。 */
export const DEFAULT_IDLE_MS = 180_000
/** 整批墙钟上限：远高于正常耗时（desktop 全量 ~33s），只拦失控。 */
export const DEFAULT_HARD_MS = 30 * 60_000

export interface GuardedResult {
  /** 判定后的退出码（0 = 汇总完整且无失败）。 */
  code: number
  tests: number | null
  pass: number | null
  fail: number | null
  cancelled: number | null
  /** 是否收齐 tests / pass / fail / cancelled 汇总；缺项即验证不完整。 */
  summarySeen: boolean
  /** 收尾方式：null = 子进程自己退出；'idle' / 'hard' = 看门狗动手。 */
  killed: 'idle' | 'hard' | null
  /** 已见的用例行计数（✔/✖ 行）。无汇总时它是「至少跑了多少」的下界——
   *  跨批合计据此报告进度，而不是把整批已跑的测试记成 0。 */
  seenChecks: { pass: number; fail: number }
  /** 流末尾若干行（无汇总时用于定位卡在哪个测试上）。 */
  tailExcerpt: string
  /** 非零退出时的更长末帧（包括取消或提前退出）——runner 汇总后重放用。 */
  failureExcerpt: string
}

export interface GuardOptions {
  /** node 的参数（不含 node 本身），如 ['--import','tsx','--test','a.test.ts']。 */
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  idleMs?: number
  hardMs?: number
  /** 是否把子进程输出转发到当前进程（默认 true；测试里关掉保持输出干净）。 */
  forwardOutput?: boolean
}

/** `ℹ tests 1789` —— node spec reporter 的汇总行，逐字匹配。 */
const SUMMARY_LINE_RE = /^ℹ (tests|pass|fail|cancelled) (\d+)\s*$/gm
/** 汇总在流末尾；只留尾部即可覆盖，同时防止长跑批次把 buffer 撑爆。 */
const TAIL_KEEP = 64 * 1024
/** 用例结果行（spec reporter 形如 `✔ name (1ms)` / `  ✔ nested` / `✖ name`）。 */
const CHECK_LINE_RE = /^[ \t]*(✔|✖) /gm
/** 无汇总时回传的末帧行数——够看出卡在哪个测试上。 */
const TAIL_EXCERPT_LINES = 6
/** fail > 0 时回传的失败末帧行数——node 的 `failing tests:` 明细段比 6 行长，
 *  专供 runner 在合计行后重放（台账 F5：失败定位不必重跑）。 */
const FAILURE_EXCERPT_LINES = 40

export function runGuardedChild(opts: GuardOptions): Promise<GuardedResult> {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const hardMs = opts.hardMs ?? DEFAULT_HARD_MS

  return new Promise<GuardedResult>((resolve) => {
    const result: GuardedResult = {
      code: 1,
      tests: null,
      pass: null,
      fail: null,
      cancelled: null,
      summarySeen: false,
      killed: null,
      seenChecks: { pass: 0, fail: 0 },
      tailExcerpt: '',
      failureExcerpt: '',
    }

    const capture = completionBatch(opts.args, opts.cwd ?? process.cwd(), opts.env ?? process.env)
    const child = spawn(process.execPath, capture.args, {
      // Windows 的隐藏控制台需可继承，覆盖 Node 内部未提供 windowsHide 的测试 worker。
      stdio: [process.platform === 'win32' ? 'inherit' : 'ignore', 'pipe', 'pipe'],
      env: capture.env,
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      // POSIX 按进程组收场；Windows 保留隐藏控制台继承，按 PID 回收进程树。
      detached: process.platform !== 'win32',
    })

    /**
     * 回收整个批次：Windows 用 taskkill /T，POSIX 用批次进程组。
     */
    const killTree = (sig: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      if (process.platform === 'win32') {
        forceKillTree(child)
        return
      }
      try {
        process.kill(-pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          /* 已经退出了 */
        }
      }
    }

    let tail = ''
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      if (hardTimer !== null) clearTimeout(hardTimer)
      idleTimer = null
      hardTimer = null
    }

    const finalize = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimers()
      for (const sig of SIGNALS) process.off(sig, onSignal)
      if (result.killed === 'hard') {
        // 总时长失控：即使已见汇总也判失败（尚未正常收场）。
        result.code = 1
      } else if (result.summarySeen) {
        if ((result.fail ?? 0) > 0 || (result.cancelled ?? 0) > 0) result.code = 1
        else if (result.killed === 'idle') result.code = 0
        else result.code = exitCode === 0 ? 0 : exitCode ?? 1
      } else {
        // 没有汇总 = 没有验证。子进程若非零退出则沿用，否则兜到 1（fail-closed）。
        result.code = exitCode !== null && exitCode !== 0 ? exitCode : 1
      }
      // 无汇总时把「已跑到哪」一并回传：调用方据此报告进度并定位挂死点，
      // 不必把整批已跑的测试记成 0。
      const tailLines = tail.split('\n').filter(l => l.trim() !== '')
      result.tailExcerpt = tailLines.slice(-TAIL_EXCERPT_LINES).join('\n')
      // 有失败时再留一段更长的末帧（含 `failing tests:` 明细）——runner 汇总后重放，
      // 让「只 tail 看输出尾部」的用法也能直接定位失败（台账 F5）。
      result.failureExcerpt = result.code !== 0 ? tailLines.slice(-FAILURE_EXCERPT_LINES).join('\n') : ''
      capture.finish(result.code === 0 && result.killed === null && exitCode === 0)
      resolve(result)
    }

    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        result.killed = 'idle'
        killTree('SIGKILL')
      }, idleMs)
    }

    const consume = (chunk: Buffer): void => {
      const text = chunk.toString()
      // 只统计**新到达的 chunk**——tail 是累积缓冲，用它计数会把同一行重复计入
      for (const m of text.matchAll(CHECK_LINE_RE)) {
        if (m[1] === '✔') result.seenChecks.pass++
        else result.seenChecks.fail++
      }
      tail = (tail + text).slice(-TAIL_KEEP)
      for (const m of tail.matchAll(SUMMARY_LINE_RE)) {
        const key = m[1]
        const value = Number(m[2])
        if (key === 'tests') {
          result.tests = value
        } else if (key === 'pass') {
          result.pass = value
        } else if (key === 'fail') {
          result.fail = value
        } else {
          result.cancelled = value
        }
      }
      result.summarySeen = result.tests !== null && result.pass !== null && result.fail !== null && result.cancelled !== null
      if (opts.forwardOutput !== false) process.stdout.write(chunk)
      armIdle()
    }

    function onSignal(): void {
      killTree('SIGKILL')
    }

    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    for (const sig of SIGNALS) process.on(sig, onSignal)

    hardTimer = setTimeout(() => {
      result.killed = 'hard'
      killTree('SIGKILL')
    }, hardMs)
    armIdle()

    child.on('error', () => finalize(null))
    child.on('close', (code) => {
      // 看门狗已 kill 时 killed 已置位，finalize 会走对应分支。
      finalize(code)
    })
  })
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
