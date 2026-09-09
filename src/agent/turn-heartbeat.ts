/**
 * Turn-level heartbeat watchdog.
 *
 * Problem (P7): During long operations — large tool results, slow LLM streams,
 * compaction, multi-tool batches — the UI receives no events for tens of
 * seconds. Users cannot tell whether the agent is working or stuck, and
 * frequently interrupt to ask "what's happening?". The interruption itself
 * disrupts the agent's context.
 *
 * Solution: a heartbeat that fires only during silent periods. Every event
 * the agent emits (text delta, tool result, phase change) calls `tick()` to
 * reset the silence clock. If `silentMs` elapses without a tick, the
 * heartbeat fires `onHeartbeat(elapsedMs, lastActivity)` so the UI can show
 * "still working — waiting on <last-activity> for N seconds" instead of a
 * frozen spinner.
 *
 * The heartbeat is informational for normal silent gaps (tool/SSE idle
 * timeouts handle in-stream hangs). But the turn-boundary orchestration
 * (postTurn hooks → compaction → prewarm → perception, between a tool result
 * and the next model stream) is a watchdog blind spot: it neither ticks the
 * heartbeat nor re-checks the abort signal, so a wedged await there freezes
 * the UI with stale "still working" and ignores Ctrl+C. To cover that, the
 * heartbeat ALSO acts as a watchdog with teeth: if silence exceeds
 * `hardStallMs` (a ceiling well above any legitimate silent gap), it fires
 * `onHardStall` exactly once so the loop can abort and break the wedge.
 */
export interface TurnHeartbeatOptions {
  /** Milliseconds of silence before firing the first heartbeat. Default 15s. */
  silentMs?: number
  /** Subsequent heartbeat interval after the first fires. Default 10s. */
  repeatMs?: number
  /** Called when silence threshold is crossed. */
  onHeartbeat: (elapsedMs: number, lastActivity: string) => void
  /**
   * Hard-stall ceiling: if no tick for this long, the turn is presumed wedged
   * in a non-cooperative await (turn-boundary blind spot). Fires `onHardStall`
   * once. Must be well above any legitimate silent gap (SSE read timeout,
   * 1M-window LLM compact). Default 240s. Set 0 to disable the watchdog.
   */
  hardStallMs?: number
  /** Called once when silence exceeds `hardStallMs`. Should abort the turn. */
  onHardStall?: (elapsedMs: number, lastActivity: string) => void
}

export class TurnHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastTick = Date.now()
  private lastActivity = 'starting'
  private firstFired = false
  private stopped = false
  private paused = false
  private watchdogDisarmed = false
  private readonly silentMs: number
  private readonly repeatMs: number
  private readonly hardStallMs: number
  private hardStallFired = false
  private readonly onHeartbeat: TurnHeartbeatOptions['onHeartbeat']
  private readonly onHardStall: TurnHeartbeatOptions['onHardStall']

  constructor(opts: TurnHeartbeatOptions) {
    this.silentMs = opts.silentMs ?? 15_000
    this.repeatMs = opts.repeatMs ?? 10_000
    this.hardStallMs = opts.hardStallMs ?? 240_000
    this.onHeartbeat = opts.onHeartbeat
    this.onHardStall = opts.onHardStall
  }

  /** Start watching. Call once per turn. */
  start(): void {
    this.stopped = false
    this.paused = false
    this.watchdogDisarmed = false
    this.lastTick = Date.now()
    this.firstFired = false
    this.hardStallFired = false
    this.scheduleNext(this.silentMs)
  }

  /** Reset the silence clock. Call on every UI-visible event. Exits pause. */
  tick(activity: string): void {
    if (this.stopped) return
    this.paused = false
    this.lastTick = Date.now()
    this.lastActivity = activity
    this.firstFired = false
    this.hardStallFired = false
    this.scheduleNext(this.silentMs)
  }

  /**
   * Suspend the watchdog timer. Use during long boundary operations
   * (compaction, perception, cold-cache re-encode) that don't emit UI
   * events but are legitimately busy. Call resume() after.
   */
  pause(): void {
    if (this.stopped || this.paused) return
    this.paused = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Resume the watchdog timer after a pause(). */
  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    this.firstFired = false
    this.hardStallFired = false
    this.scheduleNext(this.silentMs)
  }

  /**
   * Suspend ONLY the hard-stall abort while keeping informational heartbeats
   * alive. Unlike pause() (which freezes the whole timer), this lets the UI
   * keep showing "still working — waiting for first token (Ns)" during a
   * legitimately-long-but-busy gap — the cold prefix re-encode before the
   * first stream token, which can exceed hardStallMs with zero deltas — while
   * preventing that silence from being mistaken for a wedge. Unaffected by
   * tick()/onPhaseChange (which re-arm the full timer), so it survives the
   * onStreamStart phase change. Call rearmWatchdog() once the operation
   * completes (or the first real delta arrives).
   */
  disarmWatchdog(): void {
    this.watchdogDisarmed = true
  }

  /** Re-enable the hard-stall abort after disarmWatchdog(). */
  rearmWatchdog(): void {
    this.watchdogDisarmed = false
    this.hardStallFired = false
  }

  /** Stop firing. Call when the turn ends (success, abort, or error). */
  stop(): void {
    this.stopped = true
    this.paused = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fire(), delayMs)
  }

  private fire(): void {
    if (this.stopped || this.paused) return
    const elapsed = Date.now() - this.lastTick
    // Guard: if a tick happened during scheduling drift, skip and reschedule.
    if (elapsed < this.silentMs - 500) {
      this.scheduleNext(this.silentMs - elapsed)
      return
    }
    // Watchdog with teeth: silence past the hard ceiling means the turn is
    // wedged in a non-cooperative await (turn-boundary blind spot). Fire the
    // abort hook once so the loop can break out. Keep emitting heartbeats too,
    // so the UI still updates while the abort propagates.
    if (this.hardStallMs > 0 && !this.hardStallFired && !this.watchdogDisarmed && elapsed >= this.hardStallMs) {
      this.hardStallFired = true
      try {
        this.onHardStall?.(elapsed, this.lastActivity)
      } catch {
        // Watchdog callback errors must not break the agent.
      }
    }
    try {
      this.onHeartbeat(elapsed, this.lastActivity)
    } catch {
      // Heartbeat callback errors must not break the agent.
    }
    this.firstFired = true
    this.scheduleNext(this.repeatMs)
  }

  /** Test-only: query whether the first heartbeat has fired since last tick. */
  hasFiredSinceTick(): boolean {
    return this.firstFired
  }
}
