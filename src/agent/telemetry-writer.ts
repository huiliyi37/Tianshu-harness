import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { PerceptionTelemetrySnapshot } from './perception.js'

/**
 * A telemetry line is either the per-turn perception snapshot or a lightweight
 * tagged event (e.g. `{ kind: 'recall-summary', ... }`) sharing the same
 * sensorium.jsonl channel. Both are just JSON-stringified on write.
 */
export type TelemetryRecord = PerceptionTelemetrySnapshot | ({ kind: string } & Record<string, unknown>)

export interface TelemetryWriter {
  write(snapshot: TelemetryRecord): void
  flush(): Promise<void>
}

// The top-level (session-less) sensorium.jsonl accumulates across every session
// and was never bounded — it had grown to ~6MB / 10k+ lines over weeks. Keep a
// rolling tail instead. Checked on a throttled cadence so the trim cost (read +
// rewrite) is amortised, not paid per append.
const MAX_SENSORIUM_LINES = 2_000
const TRIM_CHECK_EVERY = 200

const NOOP_WRITER: TelemetryWriter = {
  write() {},
  async flush() {},
}

/** W5：轻量生命体征行的 kind 标记。 */
export const VITALS_LITE_KIND = 'vitals-lite'
/** CLI perf summary is emitted only by an explicitly enabled TUI monitor. */
export const PERF_SUMMARY_KIND = 'perf-summary'
/** P3：认知帧 lite 摘要（单行 <200B），默认落盘——事后回答"该 turn 松弛了
 *  多少、哪些 source 缺数据"。full 全量 facts 记录仍由 RIVET_DEBUG_TELEMETRY
 *  opt-in。 */
export const COGNITIVE_FRAME_LITE_KIND = 'cognitive-frame-lite'
/** P4 前置（2026-07-20 数据回读）：advisory 采纳核销账本。单行小记录
 *  （key/outcome/expectKind/turn 号），不默认落盘则 P4 晋级证据源 2
 *  （advisory readback）永远干涸——实测 9 个 session 零数据。 */
export const ADVISORY_OUTCOME_KIND = 'advisory-outcome'
/** holdout 反事实组（shadow 扣留判定），与投递组分 kind 便于回放对照。 */
export const ADVISORY_HOLDOUT_KIND = 'advisory-holdout'
/** 会话结束时观察窗口还没走完的送达（每会话一条汇总）。区分「测不到」与
 *  「没效果」：worker 中位 2 轮而 expect 窗口 2-4 轮，绝大多数 pending 在结束
 *  时未到期，实测 88 个 worker 只产出 3 条 outcome。这条汇总让盲区本身可见。 */
export const ADVISORY_UNRESOLVED_KIND = 'advisory-unresolved'
/** meridian 索引队列单项软超时（2026-09-08 follow-up）：索引挂起被跳过时
 *  记一条 lite 遥测，含 target/kind/累计次数。 */
export const MERIDIAN_INDEX_ITEM_TIMEOUT_KIND = 'meridian-index-item-timeout'

/** RIVET_DEBUG_TELEMETRY 未开时仍放行的轻量 kind 白名单（每条单行 <200B）。 */
const LITE_KINDS: ReadonlySet<string> = new Set([
  VITALS_LITE_KIND,
  PERF_SUMMARY_KIND,
  COGNITIVE_FRAME_LITE_KIND,
  ADVISORY_OUTCOME_KIND,
  ADVISORY_HOLDOUT_KIND,
  ADVISORY_UNRESOLVED_KIND,
  MERIDIAN_INDEX_ITEM_TIMEOUT_KIND,
])

export function createTelemetryWriter(cwd: string, sessionId?: string): TelemetryWriter {
  // W5（incident 20b9714e）：完整遥测仍由 RIVET_DEBUG_TELEMETRY opt-in，但
  // 轻量生命体征行（vitals-lite，单行 <200B）默认落盘——没有它，事后复盘
  // "节流何时触发/镜面是否存活/advisory 台账"全都无数据。RIVET_TELEMETRY_LITE=0 可关。
  const full = !!process.env['RIVET_DEBUG_TELEMETRY']
  const lite = process.env['RIVET_TELEMETRY_LITE'] !== '0'
  if (!full && !lite) return NOOP_WRITER

  const dir = sessionId ? join(getSessionDir(cwd), sessionId) : join(cwd, '.rivet')
  const path = join(dir, 'sensorium.jsonl')
  // 串行化写入：并发 appendFile 竞争会乱序（两条 write 同 tick 完成顺序不定），
  // telemetry 的首要性质就是按写入时间有序——用 promise 链保证落盘顺序。
  let writeChain: Promise<void> = Promise.resolve()
  const pendingWrites: Promise<void>[] = []
  let writesSinceTrim = 0
  return {
    write(snapshot: TelemetryRecord) {
      const kind = (snapshot as { kind?: string }).kind
      if (!full && (kind === undefined || !LITE_KINDS.has(kind))) return
      const line = JSON.stringify(snapshot)
      const shouldTrim = ++writesSinceTrim >= TRIM_CHECK_EVERY
      if (shouldTrim) writesSinceTrim = 0
      const writePromise = (writeChain = writeChain.then(async () => {
        const fs = await import('node:fs/promises')
        await fs.mkdir(dir, { recursive: true })
        await fs.appendFile(path, line + '\n', 'utf-8')
        if (shouldTrim) {
          // Best-effort rolling trim: keep only the most recent lines.
          try {
            const raw = await fs.readFile(path, 'utf-8')
            const lines = raw.split('\n').filter(l => l.length > 0)
            if (lines.length > MAX_SENSORIUM_LINES) {
              const tail = lines.slice(lines.length - MAX_SENSORIUM_LINES)
              await fs.writeFile(path, tail.join('\n') + '\n', 'utf-8')
            }
          } catch { /* trim is best-effort — never break telemetry */ }
        }
      }).catch(() => {}))
      pendingWrites.push(writePromise)
      writePromise.finally(() => {
        const index = pendingWrites.indexOf(writePromise)
        if (index >= 0) pendingWrites.splice(index, 1)
      }).catch(() => {})
    },
    async flush() {
      await Promise.allSettled(pendingWrites)
    },
  }
}
