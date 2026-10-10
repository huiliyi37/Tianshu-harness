/** Unknown process state cannot be used as evidence that a worker died. */
export function hasLiveDelegation(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>, background: { has(id: string): boolean } | undefined, isRunning: (id: string) => boolean): boolean {
  for (const event of events) {
    if (event.type !== 'delegation' || event.data.status !== 'running') continue
    const id = String(event.data.workerId ?? '')
    if (!id || background?.has(id)) continue
    try { if (isRunning(String(event.data.dispatchId ?? id))) return true } catch { return true }
  }
  return false
}
