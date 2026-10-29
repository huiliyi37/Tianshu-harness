const MAX_TRAILING_BYTES = 32768
const MAX_TRAILING_CHUNKS = 64
const COMPLETION_DRAIN_MS = 1000

export async function releaseCompletedReader(reader: ReadableStreamDefaultReader<Uint8Array>, lifecycle?: AbortController, signal?: AbortSignal): Promise<void> {
  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    lifecycle?.abort()
    void reader.cancel().catch(() => {})
  }
  const timer = setTimeout(cancel, COMPLETION_DRAIN_MS)
  timer.unref?.()
  lifecycle?.signal.addEventListener('abort', cancel, { once: true })
  signal?.addEventListener('abort', cancel, { once: true })
  if (lifecycle?.signal.aborted || signal?.aborted) cancel()
  let remaining = MAX_TRAILING_BYTES
  let chunks = 0
  try {
    while (!cancelled && chunks < MAX_TRAILING_CHUNKS) {
      const chunk = await reader.read()
      if (chunk.done) return
      chunks++
      if (chunk.value.byteLength > remaining) {
        cancel()
        return
      }
      remaining -= chunk.value.byteLength
    }
    cancel()
  } catch {
    cancel()
  } finally {
    clearTimeout(timer)
    lifecycle?.signal.removeEventListener('abort', cancel)
    signal?.removeEventListener('abort', cancel)
    try { reader.releaseLock() } catch {}
  }
}
