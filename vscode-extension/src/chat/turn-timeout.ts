/**
 * 聊天轮超时的审批豁免守卫。
 *
 * `TURN_TIMEOUT_MS` 的语义是「静默的 sidecar 不应永远占住聊天视图」——但审批
 * 弹窗后的等待是用户在处理，不是 sidecar 静默：若照常计时，超过窗口才点的
 * 「允许一次」会落在已被超时弃置的轮上（participant.dispatch 因
 * activeTurn===undefined 静默丢弃恢复输出——实测断点）。因此计时与审批状态
 * 联动：审批挂起期间暂停；全部完结后开新的静默窗口。
 * @module
 */
export class TurnTimeout {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pendingApprovals = 0
  private disposed = false
  private readonly timeoutMs: number
  private readonly onTimeout: () => void

  /**
   * @param timeoutMs - 单个静默窗口的长度。
   * @param onTimeout - 窗口耗尽（且未被审批豁免）时的回调。
   */
  constructor(timeoutMs: number, onTimeout: () => void) {
    this.timeoutMs = timeoutMs
    this.onTimeout = onTimeout
  }

  /** 开始（或重开）一个静默窗口；已有窗口即被替换。 */
  arm(): void {
    if (this.disposed) return
    this.pause()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.disposed) this.onTimeout()
    }, this.timeoutMs)
  }

  /** 暂停计时（审批挂起期间轮不应被静默超时收走）。 */
  pause(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 一条审批挂起：计数并暂停计时（多个审批可并存）。 */
  approvalRequired(): void {
    if (this.disposed) return
    this.pendingApprovals += 1
    this.pause()
  }

  /** 一条审批完结：全部完结且计时已停时，开新的静默窗口。 */
  approvalResolved(): void {
    if (this.disposed) return
    this.pendingApprovals = Math.max(0, this.pendingApprovals - 1)
    if (this.pendingApprovals === 0 && this.timer === undefined) this.arm()
  }

  /** Authoritative reconnect state also removes approvals resolved while offline. */
  setPendingApprovals(count: number): void {
    if (this.disposed) return
    const previous = this.pendingApprovals
    this.pendingApprovals = count
    if (count > 0) this.pause()
    else if (previous > 0 && this.timer === undefined) this.arm()
  }

  /** 轮收束：停止计时，此后不再触发。 */
  dispose(): void {
    this.disposed = true
    this.pause()
  }
}
