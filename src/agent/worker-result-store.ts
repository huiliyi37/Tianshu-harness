import { isFilesystemMetadata } from '../utils/file-metadata.js'
/**
 * Worker 结果的磁盘存储（~/.rivet/subagents/）——最新副本 / 逐轮归档 / 指纹
 * 副本的落盘、读取、列举与 LRU 淘汰。
 *
 * 从 coordinator.ts 迁出（行数棘轮：coordinator 顶格；搬迁与下列修复同一
 * 接缝）。搬迁同时收口一类 Windows 命名缺陷：
 *
 * orderId 的稳定形状含冒号（batch:0 / team:T1），而 Windows 文件名禁用
 * 冒号——裸拼 `<orderId>.json` 会被 NTFS 解释为**备用数据流（ADS）**：
 * 同一路径串写/读都"成功"（落在宿主文件的流上），但 readdir 只见宿主文件
 * （`batch`），归档列表（listPersistedResultRounds）与 LRU 清理对整族文件
 * 永远不可见；不同 orderId（batch:0 / batch:1）还会共用同一个宿主文件。
 *
 * 命名不变量：orderId 拼进文件名前必须经 orderFileKey() 单射编码
 * （`:`→`%3A`；与 deriveWorkerSessionId 的 `:`→`-` 同族动机、不同映射面——
 * 那个映射的是会话 id 语料，这里映射的是磁盘文件名本身）。写路径只用安全
 * 键；读/列路径对旧格式（未编码原名）做回退——POSIX 平台的存量归档升级后
 * 仍可读；Windows 上旧格式从不曾以正常文件存在，回退在那里是空操作。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { subagentsDir } from '../config/paths.js'
import { isSafeFileName, orderFileKey } from '../utils/safe-path.js'
import { parseWorkerResult, type WorkerResult } from './work-order.js'
import { writeWorkerFileAtomic } from './worker-history-store.js'

/** LRU cap for result files under the subagents dir. */
export const MAX_SUBAGENT_RESULTS = 500

/** ~/.rivet/subagents/ 解析；homeDir 仅供测试注入（与 loadPersistedResult 同例）。 */
export function coordinatorSubagentsDir(homeDir?: string): string {
  // `homeDir` is the legacy "user home" parameter used by tests.
  // In production, default to the unified subagentsDir() under RIVET_HOME.
  if (homeDir) return join(homeDir, '.rivet', 'subagents')
  return subagentsDir()
}

/** 旧格式（未编码原名）与新格式是否不同——相同则无回退必要（绝大多数 id）。 */
function legacyKeyDiffers(orderId: string): boolean {
  return orderFileKey(orderId) !== orderId
}

/** LRU-evict the subagents dir down to `limit` files (oldest mtime first).
 *  Best-effort and exported for testing. Returns the basenames evicted. */
export function evictOldSubagentResults(dir: string, limit = MAX_SUBAGENT_RESULTS): string[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => !isFilesystemMetadata(f) && f.endsWith('.json'))
  } catch {
    return []
  }
  if (files.length <= limit) return []
  const withMtime = files.map(f => {
    let mtime = 0
    try { mtime = statSync(join(dir, f)).mtimeMs } catch { /* ignore */ }
    return { f, mtime }
  })
  withMtime.sort((a, b) => a.mtime - b.mtime)
  const toEvict = withMtime.slice(0, files.length - limit).map(({ f }) => f)
  for (const f of toEvict) {
    try { unlinkSync(join(dir, f)) } catch { /* ignore */ }
  }
  return toEvict
}

/**
 * Persist worker result to ~/.rivet/subagents/ for future resume/inspection.
 *
 * 落三类文件（全部经 orderFileKey 安全化）：
 * - `<key>.json` —— 最新一轮副本（loadPersistedResult 读它，行为不变）。
 * - `<key>.<nonce>.json` —— 按派发 nonce 的逐轮归档（有 nonce 时）。稳定
 *   order id（batch:0 / team:T1）跨委派复用，没有 nonce 时第二次派发会把第一轮
 *   的 findings/usage 物理覆盖（L1）。nonce 与 worker 会话 JSONL 同源
 *   （deriveWorkerSessionId 那颗）。
 * - `<fingerprint>.json` —— T5 resume 指纹副本。
 *
 * LRU 说明：归档让每次派发多占一个文件，MAX_SUBAGENT_RESULTS 会比「复用免费」
 * 时代更早触顶；淘汰仍按最旧 mtime 优先，语义不变——最旧的轮次先死。
 * homeDir 仅供测试注入（与 loadPersistedResult 同例）。
 */
export function persistWorkerResult(result: WorkerResult, fingerprint?: string, dispatchNonce?: string, homeDir?: string): boolean {
  try {
    const dir = coordinatorSubagentsDir(homeDir)
    mkdirSync(dir, { recursive: true })
    const json = JSON.stringify(result, null, 2)
    const key = orderFileKey(result.workOrderId)
    if (!writeWorkerFileAtomic(join(dir, `${key}.json`), json)) return false
    if (dispatchNonce) {
      if (!writeWorkerFileAtomic(join(dir, `${key}.${dispatchNonce}.json`), json)) return false
    }
    // T5: also write a fingerprint-indexed copy for resume lookup
    if (fingerprint) {
      if (!writeWorkerFileAtomic(join(dir, `${fingerprint}.json`), json)) return false
    }
    // Keep the sink bounded — LRU-evict once it exceeds the cap.
    evictOldSubagentResults(dir)
    return true
  } catch {
    return false
  }
}

/** Model report ingestion strips coordinator identities; trusted disk reads restore validated metadata. */
function parseStoredWorkerResult(text: string, orderId: string): WorkerResult {
  const result = parseWorkerResult(text, orderId)
  const metadata = JSON.parse(text) as Record<string, unknown>
  for (const key of ['dispatchId', 'attemptId', 'parentAttemptId'] as const) {
    if (typeof metadata[key] === 'string' && metadata[key].length > 0) result[key] = metadata[key]
  }
  return result
}

/** B1: read back a previously persisted worker result for resume/inspection.
 *  The persistWorkerResult sink used to have no reader (write-only grave).
 *  Returns null on cold miss or unparseable content — callers must handle it. */
export function loadPersistedResult(orderId: string, homeDir?: string): WorkerResult | null {
  const dir = coordinatorSubagentsDir(homeDir)
  // orderId 拼进文件名前经 orderFileKey 单射编码（编码键已无路径语义，新格式
  // 主路径恒安全）。旧格式回退分支拿**原名**拼路径——守卫只作用于该分支：
  // 入口守卫会误杀含冒号的合法 orderId（batch:0 / team:T1——写经编码成功、
  // 读被 isSafeFileName 拦死，恢复通道对 batch/team 派发全断；
  // coordinator-persist-rounds 回归即此）。冒号裸名回退保持不读
  // （与 Windows ADS 行为统一，fail-closed 一侧）。
  const key = orderFileKey(orderId)
  const names = legacyKeyDiffers(orderId) && isSafeFileName(orderId) ? [`${key}.json`, `${orderId}.json`] : [`${key}.json`]
  for (const name of names) {
    try {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      return parseStoredWorkerResult(readFileSync(path, 'utf-8'), orderId)
    } catch { /* unparseable format — try the legacy name once more */ }
  }
  return null
}

/** nonce 必须是不含路径语义的裸标识符——它会拼进文件名，拒绝分隔符与父目录逃逸。 */
function isSafeRoundNonce(nonce: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(nonce)
}

/** 一轮派发的归档元数据（L1）。 */
export interface PersistedResultRound {
  /** 派发 nonce，与 worker 会话 JSONL（worker-<id>-<nonce>.jsonl）后缀同源。 */
  nonce: string
  /** 文件 mtime——派发完成时间，兼作轮次排序键。 */
  savedAt: number
}

/**
 * 列出某个 order id 的全部归档轮次，按时间升序；同 mtime 按 nonce 字节序。
 * 只数 `<key>.<nonce>.json`：`<key>.json` 最新副本（nonce 为空被排除）
 * 与指纹文件（不带 order id 前缀）都不算轮次。
 * 旧格式前缀（未编码原名）一并扫描做兼容；同一 nonce 新旧两份并存时
 * 取 mtime 较新的一份（后写的胜出）。
 */
export function listPersistedResultRounds(orderId: string, homeDir?: string): PersistedResultRound[] {
  try {
    const dir = coordinatorSubagentsDir(homeDir)
    const prefixes = [`${orderFileKey(orderId)}.`]
    // 旧格式前缀仅供原名安全的 id 回退（裸冒号名不读——见 loadPersistedResult）。
    if (legacyKeyDiffers(orderId) && isSafeFileName(orderId)) prefixes.push(`${orderId}.`)
    const byNonce = new Map<string, PersistedResultRound>()
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const matched = prefixes.find(p => f.startsWith(p))
      if (!matched) continue
      const nonce = f.slice(matched.length, -'.json'.length)
      if (!isSafeRoundNonce(nonce)) continue
      let savedAt = 0
      try { savedAt = statSync(join(dir, f)).mtimeMs } catch { /* ignore */ }
      const existing = byNonce.get(nonce)
      if (!existing || savedAt >= existing.savedAt) byNonce.set(nonce, { nonce, savedAt })
    }
    const rounds = [...byNonce.values()]
    rounds.sort((a, b) => a.savedAt - b.savedAt || (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0))
    return rounds
  } catch {
    return []
  }
}

/** 读取指定轮次的归档结果；未知轮次、非法 nonce 或无法解析一律返回 null。 */
export function loadPersistedResultRound(orderId: string, nonce: string, homeDir?: string): WorkerResult | null {
  if (!isSafeRoundNonce(nonce)) return null
  const dir = coordinatorSubagentsDir(homeDir)
  const key = orderFileKey(orderId)
  // 旧格式回退分支守卫同 loadPersistedResult（裸冒号名不回退）。
  const names = legacyKeyDiffers(orderId) && isSafeFileName(orderId) ? [`${key}.${nonce}.json`, `${orderId}.${nonce}.json`] : [`${key}.${nonce}.json`]
  for (const name of names) {
    try {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      return parseStoredWorkerResult(readFileSync(path, 'utf-8'), orderId)
    } catch { /* unparseable — try the legacy name once more */ }
  }
  return null
}
