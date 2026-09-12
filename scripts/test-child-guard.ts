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
 *
 * 汇总已出现但进程不退时（句柄未释放）**不判失败**：测试确实跑完了，看门狗只负责
 * 收尾，退出码以汇总里的 fail 计数为准——否则等于把 flag 的过度自信换成过度悲观。
 */

import { spawn } from 'node:child_process'

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
  /** 是否见到 node 的汇总段（`ℹ tests` 行）。false 即"跑了但什么都没验证"。 */
  summarySeen: boolean
  /** 收尾方式：null = 子进程自己退出；'idle' / 'hard' = 看门狗动手。 */
  killed: 'idle' | 'hard' | null
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
const SUMMARY_LINE_RE = /^ℹ (tests|pass|fail) (\d+)\s*$/gm
/** 汇总在流末尾；只留尾部即可覆盖，同时防止长跑批次把 buffer 撑爆。 */
const TAIL_KEEP = 64 * 1024

export function runGuardedChild(opts: GuardOptions): Promise<GuardedResult> {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const hardMs = opts.hardMs ?? DEFAULT_HARD_MS

  return new Promise<GuardedResult>((resolve) => {
    const result: GuardedResult = {
      code: 1,
      tests: null,
      pass: null,
      fail: null,
      summarySeen: false,
      killed: null,
    }

    const child = spawn(process.execPath, opts.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      shell: false,
    })

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
        result.code = (result.fail ?? 0) > 0 ? 1 : 0
      } else {
        // 没有汇总 = 没有验证。子进程若非零退出则沿用，否则兜到 1（fail-closed）。
        result.code = exitCode !== null && exitCode !== 0 ? exitCode : 1
      }
      resolve(result)
    }

    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        result.killed = 'idle'
        child.kill('SIGKILL')
      }, idleMs)
    }

    const consume = (chunk: Buffer): void => {
      const text = chunk.toString()
      tail = (tail + text).slice(-TAIL_KEEP)
      for (const m of tail.matchAll(SUMMARY_LINE_RE)) {
        const key = m[1]
        const value = Number(m[2])
        if (key === 'tests') {
          result.summarySeen = true
          result.tests = value
        } else if (key === 'pass') {
          result.pass = value
        } else {
          result.fail = value
        }
      }
      if (opts.forwardOutput !== false) process.stdout.write(chunk)
      armIdle()
    }

    function onSignal(sig: NodeJS.Signals): void {
      child.kill(sig)
    }

    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    for (const sig of SIGNALS) process.on(sig, onSignal)

    hardTimer = setTimeout(() => {
      result.killed = 'hard'
      child.kill('SIGKILL')
    }, hardMs)
    armIdle()

    child.on('error', () => finalize(null))
    child.on('exit', (code) => {
      // 看门狗已 kill 时 killed 已置位，finalize 会走对应分支。
      finalize(code)
    })
  })
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
