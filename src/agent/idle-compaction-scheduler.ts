export function scheduleIdleCompactionTimer(enabled: boolean | undefined, run: () => void): ReturnType<typeof setTimeout> | null {
  if (!enabled || process.env['RIVET_IDLE_COMPACTION'] === '0') return null
  const timer = setTimeout(run, Number(process.env['RIVET_IDLE_COMPACTION_MS']) || 60_000)
  timer.unref?.()
  return timer
}
