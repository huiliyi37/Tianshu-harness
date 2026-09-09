/** A terminal stream failure: replaying this partial reasoning can reinforce the loop. */
export class ReasoningRepetitionError extends Error {
  constructor() {
    super('DeepSeek reasoning stream stopped: sustained short-phrase repetition detected. Start a fresh conversation or switch models before retrying.')
    this.name = 'ReasoningRepetitionError'
  }
}

const WINDOW_LINES = 128
const MAX_LINE_CHARS = 32
const MIN_REPEATED_LINES = Math.ceil(WINDOW_LINES * 0.9)

/**
 * Bounded, chunk-boundary-independent detector for thinking-only short-line loops.
 * Require four or fewer short phrases to occupy >=90% of 128 non-empty lines.
 * Length alone is never a reason to stop healthy reasoning. Long/novel lines
 * count against repetition; whitespace-only lines do not inflate the window.
 */
export class ReasoningRepetitionGuard {
  private line = ''
  private longLine = false
  private window: Array<string | null> = []

  push(delta: string): void {
    for (const char of delta) {
      if (char !== '\n') {
        if (!this.longLine) {
          this.line += char
          if (this.line.length > MAX_LINE_CHARS) this.longLine = true
        }
        continue
      }
      const line = this.line.trim()
      if (this.longLine || line) {
        this.window.push(this.longLine ? null : line)
        if (this.window.length > WINDOW_LINES) this.window.shift()
        if (this.window.length === WINDOW_LINES) {
          const counts = new Map<string, number>()
          for (const entry of this.window) {
            if (entry !== null) counts.set(entry, (counts.get(entry) ?? 0) + 1)
          }
          const repeated = [...counts.values()].sort((a, b) => b - a).slice(0, 4)
            .reduce((sum, count) => sum + count, 0)
          if (repeated >= MIN_REPEATED_LINES) throw new ReasoningRepetitionError()
        }
      }
      this.line = ''
      this.longLine = false
    }
  }
}
