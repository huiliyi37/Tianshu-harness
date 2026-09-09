export interface StreamCacheObservability {
  ttftMs?: number
}

export interface ToolBatchCacheObservability {
  outputRawBytes?: number
  outputTrimmedBytes?: number
  outputFilterIds?: string[]
  toolUiEvents: number
}

export interface TurnCacheLogObservability extends StreamCacheObservability {
  outputRawBytes?: number
  outputTrimmedBytes?: number
  outputFilterIds?: string[]
  toolUiEvents?: number
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/**
 * Holds tool-output measurements until the next model request consumes those
 * tool results. Cache-log records are emitted with provider usage, before the
 * following tool batch, so this request-aligned attribution avoids rewriting
 * append-only log lines.
 */
export class TurnCacheObservability {
  private pending: ToolBatchCacheObservability | undefined
  private active: {
    outputMeasured: boolean
    outputRawBytes: number
    outputTrimmedBytes: number
    outputFilterIds: string[]
    toolUiEvents: number
  } | undefined

  beginToolBatch(outputMeasured = true): void {
    this.active = {
      outputMeasured,
      outputRawBytes: 0,
      outputTrimmedBytes: 0,
      outputFilterIds: [],
      toolUiEvents: 0,
    }
  }

  recordSanitizedOutput(rawContent: string, sanitizedContent: string, filterId?: string): void {
    if (!this.active) return
    const rawBytes = Buffer.byteLength(rawContent)
    const sanitizedBytes = Buffer.byteLength(sanitizedContent)
    const removedBytes = Math.max(0, rawBytes - sanitizedBytes)
    this.active.outputRawBytes += rawBytes
    this.active.outputTrimmedBytes += removedBytes
    if (removedBytes > 0 && filterId) this.active.outputFilterIds.push(filterId)
  }

  recordToolUiEvent(): void {
    if (this.active) this.active.toolUiEvents++
  }

  endToolBatch(): void {
    if (!this.active) return
    this.recordToolBatch({
      ...(this.active.outputMeasured
        ? {
            outputRawBytes: this.active.outputRawBytes,
            outputTrimmedBytes: this.active.outputTrimmedBytes,
            outputFilterIds: this.active.outputFilterIds,
          }
        : {}),
      toolUiEvents: this.active.toolUiEvents,
    })
    this.active = undefined
  }

  recordToolBatch(batch: ToolBatchCacheObservability): void {
    if (!this.pending) {
      this.pending = {
        ...batch,
        ...(batch.outputFilterIds ? { outputFilterIds: uniqueIds(batch.outputFilterIds) } : {}),
      }
      return
    }
    const rawMeasured = this.pending.outputRawBytes !== undefined || batch.outputRawBytes !== undefined
    const trimmedMeasured = this.pending.outputTrimmedBytes !== undefined || batch.outputTrimmedBytes !== undefined
    const filtersMeasured = this.pending.outputFilterIds !== undefined || batch.outputFilterIds !== undefined
    this.pending = {
      ...(rawMeasured
        ? { outputRawBytes: (this.pending.outputRawBytes ?? 0) + (batch.outputRawBytes ?? 0) }
        : {}),
      ...(trimmedMeasured
        ? { outputTrimmedBytes: (this.pending.outputTrimmedBytes ?? 0) + (batch.outputTrimmedBytes ?? 0) }
        : {}),
      ...(filtersMeasured
        ? { outputFilterIds: uniqueIds([...(this.pending.outputFilterIds ?? []), ...(batch.outputFilterIds ?? [])]) }
        : {}),
      toolUiEvents: this.pending.toolUiEvents + batch.toolUiEvents,
    }
  }

  consumeForRequest(stream: StreamCacheObservability = {}): TurnCacheLogObservability {
    const pending = this.pending
    this.pending = undefined
    return {
      ...(stream.ttftMs !== undefined ? { ttftMs: stream.ttftMs } : {}),
      ...pending,
    }
  }
}
