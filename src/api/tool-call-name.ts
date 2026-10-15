export type ToolNameFailure = 'unknown' | 'ambiguous' | 'incomplete' | 'identity'

export class ToolNameProtocolError extends Error {
  constructor(readonly reason: ToolNameFailure) {
    super(`上游工具调用协议异常（${reason}）：无法唯一确定工具名称或调用归属，已停止本次响应。请重试或检查模型端点。`)
    this.name = 'ToolNameProtocolError'
  }
}

/** Shared by all calls in one attempt; only actual wire declarations qualify. */
export class ToolNameVocabulary {
  readonly names: ReadonlySet<string>
  readonly prefixes: ReadonlySet<string>
  readonly expandable: ReadonlySet<string>

  constructor(names: readonly string[]) {
    this.names = new Set(names)
    const prefixes = new Set<string>()
    const expandable = new Set<string>()
    for (const name of this.names) {
      for (let length = 0; length <= name.length; length++) {
        prefixes.add(name.slice(0, length))
        if (length < name.length) expandable.add(name.slice(0, length))
      }
    }
    this.prefixes = prefixes
    this.expandable = expandable
  }
}

/** Keep plausible delta/echo/snapshot interpretations instead of guessing. */
export class ToolCallName {
  private candidates = new Set([''])
  fragments = 0

  constructor(private readonly vocabulary: ToolNameVocabulary) {}

  append(part: string): { repeat: boolean; snapshot: boolean } {
    if (!part) return { repeat: false, snapshot: false }
    this.fragments++
    const next = new Set<string>()
    let repeat = false
    let snapshot = false
    for (const current of this.candidates) {
      const appended = current + part
      if (this.vocabulary.prefixes.has(appended)) next.add(appended)
      if (part === current) { next.add(current); repeat = true }
      if (current && part.length > current.length && part.startsWith(current) && this.vocabulary.prefixes.has(part)) {
        next.add(part)
        snapshot = true
      }
    }
    this.candidates = next
    if (!next.size) throw new ToolNameProtocolError('unknown')
    return { repeat, snapshot }
  }

  get candidateCount(): number { return this.candidates.size }

  get completeNames(): string[] {
    return [...this.candidates].filter(name => this.vocabulary.names.has(name))
  }

  /** Early hints must also exclude incomplete branches and longer tool names. */
  get hintName(): string | undefined {
    const [name] = this.candidates
    return name && this.candidates.size === 1 && this.vocabulary.names.has(name)
      && !this.vocabulary.expandable.has(name) ? name : undefined
  }

  resolve(final: boolean): string | undefined {
    const names = this.completeNames
    if (names.length > 1) {
      if (final) throw new ToolNameProtocolError('ambiguous')
      return undefined
    }
    // Some providers send finish_reason before trailing name/argument chunks.
    // A registered short name is not complete while it can still grow.
    if (names.length === 1) return final || this.hintName === names[0] ? names[0] : undefined
    if (final) throw new ToolNameProtocolError('incomplete')
    return undefined
  }
}
