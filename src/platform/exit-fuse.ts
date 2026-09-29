/**
 * exit-fuse — 退出信号保险丝：「二次信号强退 + 超时强退」的共用状态机。
 *
 * 动机：优雅关停链（worker 收尾、遥测 flush、多次 SQLite 写）任一步慢于预期时，
 * 幂等守卫会把用户的第二次 Ctrl+C 静默吞掉——用户只能干等或 kill -9。二次信号
 * = 用户明确等不了，跳过优雅链立即强退；首信号后 timeoutMs 仍未退完同样强退
 * （悬挂不该让退出无限推迟，预算推导见 serve.ts shutdownServer 的注释）。强退
 * 走非 0 退出码，与干净退出可区分；forceExit 注入以便测试。
 *
 * 消费方：main.ts（CLI 入口）。serve.ts 的 shutdownServer 是同款逻辑的先行
 * 实现——本模块是它的可测试提取，serve 侧后续可换用。
 */

export interface ExitFuse {
  /** 信号到达：首信号走优雅关停；关停进行中的后续信号强退。 */
  signal(name: string): void
  /** 优雅关停链启动时装超时保险丝。信号路径与程序化退出路径都须调用；重复调用幂等。 */
  arm(): void
  /** 摘除超时保险丝（测试清理用；正常路径靠 unref + 进程退出自然消失）。 */
  dispose(): void
}

export function createExitFuse(options: {
  onGraceful: () => void
  forceExit: (code: number) => void
  log?: (message: string) => void
  timeoutMs?: number
}): ExitFuse {
  const { onGraceful, forceExit, log = () => {}, timeoutMs = 15_000 } = options
  let shuttingDown = false
  let fuse: NodeJS.Timeout | null = null
  return {
    signal(name) {
      if (shuttingDown) {
        log(`second ${name} — forcing immediate exit`)
        forceExit(1)
        return
      }
      shuttingDown = true
      onGraceful()
    },
    arm() {
      shuttingDown = true
      if (fuse) return
      fuse = setTimeout(() => {
        log(`graceful shutdown did not finish in ${timeoutMs}ms — forcing exit`)
        forceExit(1)
      }, timeoutMs)
      fuse.unref?.()
    },
    dispose() {
      if (fuse) clearTimeout(fuse)
      fuse = null
    },
  }
}
