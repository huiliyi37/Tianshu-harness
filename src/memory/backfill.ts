/**
 * 记忆回填管道（对齐 dsh memory-pipeline）：扫描**历史**会话转录，用与
 * session-consolidation 相同的提取器（摘要 + procedure）补采知识写入 LTM，
 * source='backfill'。
 *
 * 天枢的记忆原本只在「会话结束时巩固一次」——记忆系统上线之前的存量会话、
 * 以及崩溃/强杀没能走到 postSession 的会话，知识永远进不了 LTM。本管道
 * 把它们按预算分批补采。
 *
 * 纪律（同 dsh pipeline）：
 * - 默认关闭（RIVET_MEMORY_BACKFILL=1 显式开启）——批量侧路 LLM 调用有成本
 * - ledger 幂等：处理过的会话绝不重跑（崩溃/重试安全）
 * - 跳过活跃会话（<1h 未动）与 worker 派生会话（隔离边界，同巩固 hook）
 * - 超龄（>14 天）标记 skipped 永久跳过，避免每次启动反复扫描
 * - 单会话失败重试上限 3 次，超限记 error 不再尝试
 * - 启动闲时触发（调用方 debounce），批间让出事件循环
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { debugLog } from '../utils/debug.js'
import { readHistoricalTranscript } from '../agent/session-persist.js'
import {
  buildConsolidationPrompt, parseConsolidationOutput, applyConsolidation,
} from './session-consolidation.js'

export interface BackfillLedgerRecord {
  status: 'done' | 'skipped' | 'error'
  at: number
  written?: number
  attempts?: number
}

export interface BackfillLedger {
  version: 1
  sessions: Record<string, BackfillLedgerRecord>
}

export interface BackfillCandidate {
  sessionId: string
  path: string
  mtimeMs: number
}

/** 回填默认关闭（opt-in，对齐 dsh pipeline enabled:false）。 */
export function memoryBackfillEnabled(value = process.env.RIVET_MEMORY_BACKFILL): boolean {
  const v = value?.trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true'
}

const IDLE_MIN_MS = 3_600_000
const MAX_AGE_MS = 14 * 86_400_000
const MAX_ATTEMPTS = 3

function ledgerPath(cwd: string): string {
  return join(cwd, '.rivet', 'knowledge', 'backfill-ledger.json')
}

export function loadBackfillLedger(cwd: string): BackfillLedger {
  const path = ledgerPath(cwd)
  if (!existsSync(path)) return { version: 1, sessions: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as BackfillLedger
    if (raw && typeof raw === 'object' && raw.version === 1 && typeof raw.sessions === 'object') return raw
  } catch { /* 坏文件 → 空账本重跑（幂等写入保护知识库不重复） */ }
  return { version: 1, sessions: {} }
}

export function saveBackfillLedger(cwd: string, ledger: BackfillLedger): void {
  writeFileAtomicSync(ledgerPath(cwd), JSON.stringify(ledger, null, 2))
}

export interface CollectBackfillResult {
  candidates: BackfillCandidate[]
  /** 超龄永久跳过的会话 id（调用方登记进 ledger，避免重复扫描）。 */
  staleIds: string[]
}

/** 选出待回填会话：未处理过、非 worker、非当前、闲置≥1h、14 天内，mtime 降序取前 N。 */
export function collectBackfillCandidates(
  sessionDir: string,
  currentSessionId: string | undefined,
  ledger: BackfillLedger,
  now = Date.now(),
  maxSessions = 5,
): CollectBackfillResult {
  if (!existsSync(sessionDir)) return { candidates: [], staleIds: [] }
  const candidates: BackfillCandidate[] = []
  const staleIds: string[] = []
  for (const name of readdirSync(sessionDir)) {
    if (isFilesystemMetadata(name) || !name.endsWith('.jsonl') || name === 'cache-log.jsonl') continue
    const sessionId = name.slice(0, -'.jsonl'.length)
    // worker 派生会话不回填（隔离边界，同巩固 hook 的 isWorker 判定）。
    if (sessionId.startsWith('worker-')) continue
    if (sessionId === currentSessionId) continue
    const rec = ledger.sessions[sessionId]
    if (rec?.status === 'done' || rec?.status === 'skipped') continue
    if ((rec?.attempts ?? 0) >= MAX_ATTEMPTS) continue
    const path = join(sessionDir, name)
    let mtimeMs: number
    try { mtimeMs = statSync(path).mtimeMs } catch { continue }
    const idleMs = now - mtimeMs
    if (idleMs > MAX_AGE_MS) { staleIds.push(sessionId); continue }
    if (idleMs < IDLE_MIN_MS) continue // 活跃/最近会话——可能自己会走 postSession 巩固
    candidates.push({ sessionId, path, mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { candidates: candidates.slice(0, maxSessions), staleIds }
}

export interface RunBackfillOptions {
  cwd: string
  sessionDir: string
  currentSessionId?: string
  /** 侧路 LLM 调用（与巩固 hook 同通道）。 */
  complete: (prompt: string, timeoutMs: number) => Promise<string>
  timeoutMs?: number
  maxSessions?: number
  /** 转录读取（zstd 解码 + 校验和过滤）；注入便于测试。 */
  readTranscript?: (path: string) => Array<{ role: string; content: string }>
}

export interface BackfillRunResult {
  processed: number
  written: number
}

/** 执行一轮回填：≤maxSessions 个会话，逐个提取写 LTM，ledger 全程记账。 */
export async function runMemoryBackfill(opts: RunBackfillOptions): Promise<BackfillRunResult> {
  const ledger = loadBackfillLedger(opts.cwd)
  const { candidates, staleIds } = collectBackfillCandidates(
    opts.sessionDir, opts.currentSessionId, ledger, Date.now(), opts.maxSessions,
  )
  for (const id of staleIds) ledger.sessions[id] = { status: 'skipped', at: Date.now() }

  let processed = 0
  let written = 0
  const read = opts.readTranscript ?? readHistoricalTranscript
  for (const candidate of candidates) {
    const transcript = read(candidate.path)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => m.content)
      .join('\n')
    if (transcript.trim().length < 200) {
      ledger.sessions[candidate.sessionId] = { status: 'skipped', at: Date.now() }
      continue
    }
    const prompt = buildConsolidationPrompt({ sessionId: candidate.sessionId, transcript })
    let output: ReturnType<typeof parseConsolidationOutput> = null
    try {
      const raw = await opts.complete(prompt, opts.timeoutMs ?? 20_000)
      output = parseConsolidationOutput(raw)
    } catch {
      output = null // fail-closed：LLM 不可用不写
    }
    const prev = ledger.sessions[candidate.sessionId]
    if (!output) {
      const attempts = (prev?.attempts ?? 0) + 1
      ledger.sessions[candidate.sessionId] = { status: 'error', at: Date.now(), attempts }
      continue
    }
    const count = applyConsolidation(opts.cwd, candidate.sessionId, output, 'backfill')
    ledger.sessions[candidate.sessionId] = { status: 'done', at: Date.now(), written: count }
    processed++
    written += count
    debugLog(`[memory-backfill] ${candidate.sessionId} written=${count}`)
  }
  saveBackfillLedger(opts.cwd, ledger)
  return { processed, written }
}
