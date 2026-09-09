import { TrajectoryRecorder, type TrajectoryEntry } from './trajectory.js'
import type { FailureClass } from './failure-classifier.js'
import { shouldRetryToolFailure } from './retry-policy.js'
import type { FailureJournal } from './failure-journal.js'
import { toolTargetFromInput } from './tool-target.js'

export interface ToolExecution {
  id: string
  name: string
  input: Record<string, unknown>
  turn: number
  execute: () => Promise<{ content: string; isError?: boolean }>
  classify: (content: string) => FailureClass | undefined
  isConcurrencySafe: boolean
}

export interface ToolExecutionResult {
  content: string
  isError: boolean
  retried: boolean
  errorClass?: FailureClass
}

export interface TurnHarnessConfig {
  maxRetries: number
  retryableClasses: string[]
}

export class TurnHarness {
  constructor(
    private config: TurnHarnessConfig,
    private trajectory: TrajectoryRecorder,
    private failureJournal?: FailureJournal,
  ) {}

  async executeTool(exec: ToolExecution): Promise<ToolExecutionResult> {
    const start = Date.now()

    let result = await exec.execute()
    let retried = false
    let errorClass: FailureClass | undefined

    if (result.isError) {
      errorClass = exec.classify(result.content) ?? undefined
      if (errorClass) {
        const decision = shouldRetryToolFailure({
          toolName: exec.name,
          failureClass: errorClass,
          isConcurrencySafe: exec.isConcurrencySafe,
          retryableClasses: this.config.retryableClasses,
          retriesRemaining: this.config.maxRetries,
        })

        if (decision.retry) {
          for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
            retried = true
            result = await exec.execute()
            if (!result.isError) break
            if (attempt === this.config.maxRetries - 1) {
              // 瞬时失败重试耗尽时，不把大段 stderr 再灌一遍——超长只保留头部摘录，
              // 再接失败后缀，避免环境噪声二次膨胀上下文。
              const RETRY_CONTENT_CAP = 1500
              const capped = result.content.length > RETRY_CONTENT_CAP
                ? `${result.content.slice(0, RETRY_CONTENT_CAP)}\n… [+${result.content.length - RETRY_CONTENT_CAP} chars truncated]`
                : result.content
              result = {
                content: `${capped}\n\n[All ${this.config.maxRetries} retries failed. Error class: ${errorClass}. Consider alternative approach.]`,
                isError: true,
              }
            }
          }
        }
      }
    }

    const durationMs = Date.now() - start
    const status: TrajectoryEntry['status'] = retried
      ? (result.isError ? 'retried-failed' : 'retried-success')
      : (result.isError ? 'failed' : 'success')

    const target = toolTargetFromInput(exec.name, exec.input as Record<string, unknown>)

    this.trajectory.record({
      turn: exec.turn,
      tool: exec.name,
      target,
      durationMs,
      status,
      errorClass: result.isError ? errorClass : undefined,
      inputSummary: JSON.stringify(exec.input).slice(0, 100),
      resultSummary: result.content.slice(0, 200),
    })

    if (result.isError && this.failureJournal) {
      try {
        this.failureJournal.record({
          turn: exec.turn,
          tool: exec.name,
          target,
          error: errorClass ?? 'unknown',
          context: result.content.slice(0, 200),
        })
      } catch { /* non-critical — never block tool execution */ }
    }

    return { content: result.content, isError: result.isError ?? false, retried, errorClass }
  }
}
