import { join, dirname, basename } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { subagentsDir } from '../config/paths.js'
import { orderFileKey } from '../utils/safe-path.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { WorkerCheckpoint } from './worker-session.js'

/** Persisted worker session history — the full OaiMessage transcript from a
 *  completed worker run, so a later `resume` delegate_task can rebuild it.
 *
 *  v2 format (`format: 2`): adds an optional resume checkpoint and, on size
 *  overflow, `historyOmitted` recording the size limit that caused messages
 *  to be dropped. v1 records (no `format` field) still load — normalized to
 *  `format: 1`. */
export interface WorkerSessionRecord {
  /** 1 = legacy pre-v2 record, 2 = current format. */
  readonly format: 1 | 2
  readonly workOrderId: string
  readonly profile: string
  readonly objective: string
  readonly messages: readonly OaiMessage[]
  readonly savedAt: number
  /** Resume checkpoint captured from a previous run. Only present on v2. */
  readonly checkpoint?: WorkerCheckpoint
  /** Set when messages were dropped because the serialized record exceeded
   *  SESSION_HISTORY_SIZE_LIMIT. Value = the limit that was exceeded. */
  readonly historyOmitted?: number
}

/** Serialized-size ceiling for a persisted session record. When the full
 *  transcript exceeds this, messages are dropped wholesale (never sliced to a
 *  tail) and `historyOmitted` records the limit — only the checkpoint and
 *  metadata survive, so a resume still has somewhere to start from. */
export const SESSION_HISTORY_SIZE_LIMIT = 1_000_000

function workerSubagentsDir(homeDir?: string): string {
  // Legacy: tests pass a parent directory and expect `.rivet/subagents` under it.
  // In production, default to the unified subagentsDir() under RIVET_HOME.
  if (homeDir) return join(homeDir, '.rivet', 'subagents')
  return subagentsDir()
}

/**
 * Session 记录路径。workOrderId 含冒号（batch:0）时以 orderFileKey 编码落盘
 * ——Windows 文件名禁用冒号，裸拼会落成 NTFS 备用数据流（ADS）：写/读都
 * "成功"而 readdir 不可见（与 subagents 结果文件同族缺陷，见
 * worker-result-store.ts 头注释）。
 */
export function workerSessionPath(workOrderId: string, homeDir?: string): string {
  return join(workerSubagentsDir(homeDir), `${orderFileKey(workOrderId)}.session.jsonl`)
}

/** 旧格式（未编码原名）候选路径——仅当编码改变名字时存在；读路径回退用。 */
function legacySessionPath(workOrderId: string, homeDir?: string): string | null {
  if (orderFileKey(workOrderId) === workOrderId) return null
  return join(workerSubagentsDir(homeDir), `${workOrderId}.session.jsonl`)
}

/** Write atomically: write to a unique temp file in the same directory, then
 *  rename over the target. A reader never observes a partially-written record
 *  (rename is atomic on the same filesystem). Best-effort: on failure the temp
 *  file is cleaned up and the error is swallowed. */
function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, path)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // temp file already gone — nothing left to clean up
    }
  }
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isOaiMessage(v: unknown): v is OaiMessage {
  return typeof v === 'object' && v !== null && typeof (v as { role?: unknown }).role === 'string'
}

function isCheckpoint(v: unknown): v is WorkerCheckpoint {
  if (typeof v !== 'object' || v === null) return false
  const cp = v as Record<string, unknown>
  return (
    isFiniteNum(cp.turnIndex)
    && typeof cp.partialResult === 'string'
    && Array.isArray(cp.completedTools)
    && cp.completedTools.every((t) => typeof t === 'string')
  )
}

/** Runtime-validate a parsed JSON value into a WorkerSessionRecord.
 *  Fail-open: anything that does not match the expected shape returns null,
 *  and callers degrade to a fresh worker. */
function parseWorkerRecord(value: unknown): WorkerSessionRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (typeof o.workOrderId !== 'string' || typeof o.profile !== 'string' || typeof o.objective !== 'string') return null
  if (!Array.isArray(o.messages) || !o.messages.every(isOaiMessage)) return null
  if (!isFiniteNum(o.savedAt)) return null
  // Absent format = legacy v1 record. Unknown future format → fail open.
  const format = o.format === undefined ? 1 : o.format
  if (format !== 1 && format !== 2) return null
  if (o.checkpoint !== undefined && !isCheckpoint(o.checkpoint)) return null
  if (o.historyOmitted !== undefined && !isFiniteNum(o.historyOmitted)) return null
  const record: WorkerSessionRecord = {
    format,
    workOrderId: o.workOrderId,
    profile: o.profile,
    objective: o.objective,
    messages: o.messages as OaiMessage[],
    savedAt: o.savedAt,
    ...(o.checkpoint !== undefined ? { checkpoint: o.checkpoint as WorkerCheckpoint } : {}),
    ...(o.historyOmitted !== undefined ? { historyOmitted: o.historyOmitted as number } : {}),
  }
  return record
}

/** Persist worker session history to ~/.rivet/subagents/<orderId>.session.jsonl.
 *  v2 format, written atomically (temp file + rename). If the serialized record
 *  exceeds SESSION_HISTORY_SIZE_LIMIT, messages are dropped wholesale and
 *  `historyOmitted` records the limit — the checkpoint (if any) is kept.
 *  Best-effort: never blocks the primary session on persistence failure. */
export function saveWorkerSession(
  workOrderId: string,
  profile: string,
  objective: string,
  messages: readonly OaiMessage[],
  homeDir?: string,
  checkpoint?: WorkerCheckpoint,
): void {
  try {
    const dir = workerSubagentsDir(homeDir)
    mkdirSync(dir, { recursive: true })
    const record: WorkerSessionRecord = {
      format: 2,
      workOrderId,
      profile,
      objective,
      messages,
      savedAt: Date.now(),
      ...(checkpoint ? { checkpoint } : {}),
    }
    let serialized = JSON.stringify(record)
    if (serialized.length > SESSION_HISTORY_SIZE_LIMIT) {
      // Never slice a tail — drop messages wholesale, keep the checkpoint.
      const trimmed: WorkerSessionRecord = {
        ...record,
        messages: [],
        historyOmitted: SESSION_HISTORY_SIZE_LIMIT,
      }
      serialized = JSON.stringify(trimmed)
    }
    writeAtomic(workerSessionPath(workOrderId, homeDir), serialized + '\n')
  } catch {
    // Best-effort: never block primary session on persistence failure
  }
}

/** Load a previously persisted worker session history.
 *  Returns null on cold miss, empty file, corrupt content, or structurally
 *  invalid records (fail-open) — callers must handle it (typically by
 *  degrading to a fresh worker). v1 records load unchanged (`format: 1`). */
export function loadWorkerSession(workOrderId: string, homeDir?: string): WorkerSessionRecord | null {
  const candidates = [workerSessionPath(workOrderId, homeDir)]
  const legacy = legacySessionPath(workOrderId, homeDir)
  if (legacy) candidates.push(legacy)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, 'utf-8').trim()
      if (!content) continue
      const record = parseWorkerRecord(JSON.parse(content))
      if (record) return record
    } catch { /* corrupt — fall through to the legacy name once more */ }
  }
  return null
}

/** Consume a stored resume checkpoint exactly once: returns the checkpoint and
 *  atomically rewrites the record without it. A second call (and plain loads)
 *  find nothing left to consume — a stale checkpoint can't be re-injected into
 *  a later resume. If the rewrite fails, nothing is returned and the file is
 *  left untouched so a later consume can retry. Pure `loadWorkerSession` never
 *  consumes (display/transcript reads must not destroy a resume checkpoint). */
export function consumeCheckpointOnce(workOrderId: string, homeDir?: string): WorkerCheckpoint | null {
  const record = loadWorkerSession(workOrderId, homeDir)
  if (!record || record.checkpoint === undefined) return null
  const { checkpoint, ...rest } = record
  writeAtomic(workerSessionPath(workOrderId, homeDir), JSON.stringify(rest) + '\n')
  // 升级过渡：消费后清掉旧格式（未编码）副本——它是同一记录的陈旧拷贝，
  // 留着会让已消费的 checkpoint 在「新名文件丢失」的极端情形下复活（二次消费）。
  const legacy = legacySessionPath(workOrderId, homeDir)
  if (legacy) {
    try { unlinkSync(legacy) } catch { /* already gone — fine */ }
  }
  return checkpoint
}
