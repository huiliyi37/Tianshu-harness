import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { validatePathSafe } from '../tools/path-validate.js'
import type { OaiMessage } from '../api/oai-types.js'

/** Tools whose orphan recovery can be grounded in on-disk file evidence. */
export const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'hash_edit', 'ast_edit', 'apply_patch',
])

export interface WriteEvidence {
  exists: boolean
  bytes: number
}

/** Sync probe: given a write-tool call, return disk evidence or undefined on skip/failure. */
export type WriteProbe = (toolName: string, args: unknown) => WriteEvidence | undefined

/** Default on; set RIVET_WRITE_PROBE=0 or false to disable disk evidence in recovery hints. */
export function isWriteProbeEnabled(): boolean {
  const v = process.env.RIVET_WRITE_PROBE
  return v !== '0' && v !== 'false'
}

/**
 * Parse the target path from tool arguments. Robust to arg-processor pointer
 * collapse — processors keep `file_path`/`path` at the top level.
 */
export function extractTargetPath(args: unknown): string | undefined {
  let obj: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) as Record<string, unknown> } catch { return undefined }
  } else if (args && typeof args === 'object') {
    obj = args as Record<string, unknown>
  }
  if (!obj) return undefined
  const p = obj.file_path ?? obj.path
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Shared marker prefix of every synthetic recovery result — used both for
 *  rendering and for counting prior occurrences in history (repeat escalation). */
export const WRITE_RECOVERY_MARKER = '会话中断导致工具结果丢失'

/** Attribution line appended to every synthetic result. Without it the model
 *  sees only "result lost" and — after a few repeats — rationally concludes
 *  the write tools themselves are broken ("工具层无法操作/系统架构有问题"),
 *  then abandons them for bash workarounds (user report 2026-07-10). */
const ATTRIBUTION =
  '\n【归因】这是宿主进程中断（用户中断/强杀/断电/卡顿）造成的结果回传丢失，是恢复机制的合成占位——'
  + '不是写工具故障，也不是系统架构问题。写工具功能正常，请继续正常使用，不要改用 bash 绕过。'

/** Extra paragraph when the same session has already accumulated multiple
 *  synthetic recoveries — the model must report the environment problem to the
 *  user instead of inventing an architecture diagnosis. */
const REPEAT_ESCALATION =
  '\n【重复发生】本会话已多次出现该恢复消息，说明宿主环境在反复中断'
  + '（常见诱因：超大文件全量重写导致卡顿后被强杀、手动反复中断、旧版本缺陷）。'
  + '请把这一情况如实报告给用户，建议升级到最新版本；写入尽量小步进行（edit_file 局部替换优于整文件重写）。'
  + '不要自行得出"工具层不可用"的结论。'

/** Build the synthetic tool-result body for a write-tool orphan (with optional disk evidence).
 *  `priorOccurrences` = how many synthetic recovery results already exist in
 *  this session's history; ≥2 triggers the repeat-escalation paragraph. */
export function formatWriteRecoveryContent(
  toolName: string | undefined,
  filePath: string | undefined,
  evidence?: WriteEvidence,
  priorOccurrences = 0,
): string {
  const suffix = ATTRIBUTION + (priorOccurrences >= 2 ? REPEAT_ESCALATION : '')

  if (!toolName || !WRITE_TOOLS.has(toolName)) {
    return `${WRITE_RECOVERY_MARKER}——该工具可能已经成功执行。检查文件/缓冲区状态后再决定是否重试。` + suffix
  }

  const target = filePath ? `\`${filePath}\`` : '目标文件'

  // 磁盘证据已确认成功 → 平静确认优先（去惊吓化，采纳自公开仓库 PR #4）：
  // 开头给结论而非事故。marker 以括注保留在正文——countPriorRecoveries 靠
  // includes() 计数，证据确认的恢复同样是一次宿主中断，不能漏计。
  if (evidence?.exists && evidence.bytes > 0) {
    return `[auto-recovered] 写入已确认——磁盘证据：${target} 已存在（${formatBytes(evidence.bytes)}），写入已生效。`
      + '直接继续下一步，切勿重写。'
      + `\n（合成占位：${WRITE_RECOVERY_MARKER}，已由磁盘证据确认写入生效。）` + suffix
  }

  if (evidence && !evidence.exists) {
    return `${WRITE_RECOVERY_MARKER}——磁盘证据：${target} 当前不存在，写入未生效。可安全重试该写入。` + suffix
  }

  return `${WRITE_RECOVERY_MARKER}——对 ${target} 的写入很可能已经成功执行，文件已保存到磁盘。`
    + `不要盲目重写：先 read_file ${target} 确认当前内容，若已包含目标改动直接继续下一步；仅当确实缺失时才补写。` + suffix
}

/** Factory: cwd-scoped probe using validatePathSafe + stat (never throws). */
export function createWriteEvidenceProbe(cwd: string): WriteProbe {
  if (!isWriteProbeEnabled()) return () => undefined

  return (toolName, args) => {
    if (!WRITE_TOOLS.has(toolName)) return undefined
    const rel = extractTargetPath(args)
    if (!rel) return undefined
    try {
      const validated = validatePathSafe(cwd, rel, 'read')
      if (!validated.ok) return undefined
      const abs = validated.path
      if (!existsSync(abs)) return { exists: false, bytes: 0 }
      const stat = statSync(abs)
      if (!stat.isFile()) return { exists: false, bytes: 0 }
      return { exists: true, bytes: stat.size }
    } catch {
      return undefined
    }
  }
}

export interface RecentUnrecordedWrite {
  /** cwd-relative, forward-slash path. */
  path: string
  bytes: number
  mtimeMs: number
}

const RECENT_SCAN_EXCLUDED_DIRS = new Set([
  '.git', '.rivet', '.svn', '.hg', 'node_modules', 'dist', 'build', 'coverage',
  'release', 'target', '.cache', '.next', '.nuxt', 'out',
])

/** Paths this session already referenced through write-tool calls. */
export function collectMentionedWritePaths(messages: OaiMessage[], cwd: string): Set<string> {
  const mentioned = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !('tool_calls' in msg) || !msg.tool_calls) continue
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name
      if (!name || !WRITE_TOOLS.has(name)) continue
      const target = extractTargetPath(tc.function?.arguments)
      if (!target) continue
      try {
        const validated = validatePathSafe(cwd, target, 'read')
        if (validated.ok) mentioned.add(validated.path)
      } catch { /* malformed arg — ignore for reconciliation */ }
    }
  }
  return mentioned
}

/**
 * Find recently modified files that the session transcript never mentions.
 * This is the "disk is ahead of the conversation" signal from 2026-09-08:
 * after a hard kill, writes land on disk instantly while the message tail can
 * be lost; on resume the model must verify these files before rewriting them.
 */
export function findRecentUnrecordedWrites(
  cwd: string,
  messages: OaiMessage[],
  options: { sinceMs?: number; now?: number; maxFiles?: number; maxVisited?: number } = {},
): RecentUnrecordedWrite[] {
  const now = options.now ?? Date.now()
  const sinceMs = options.sinceMs ?? now - 2 * 60 * 60 * 1000
  const maxFiles = options.maxFiles ?? 8
  const maxVisited = options.maxVisited ?? 5_000
  const mentioned = collectMentionedWritePaths(messages, cwd)
  const found: RecentUnrecordedWrite[] = []
  let visited = 0

  const walk = (dir: string, depth: number): void => {
    if (visited >= maxVisited || found.length >= maxFiles) return
    type WalkEntry = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }
    let entries: WalkEntry[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as WalkEntry[]
    } catch {
      return // unreadable dir — fail-soft
    }
    for (const entry of entries) {
      if (visited >= maxVisited || found.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || RECENT_SCAN_EXCLUDED_DIRS.has(entry.name) || depth >= 10) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      visited++
      if (mentioned.has(full)) continue
      try {
        const stat = statSync(full)
        if (stat.mtimeMs < sinceMs) continue
        found.push({
          path: relative(cwd, full).split('\\').join('/'),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch { /* vanish / unreadable — ignore */ }
    }
  }

  walk(cwd, 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles)
}

/**
 * 是否需要做磁盘对账：只有**上次非正常退出**才需要。
 *
 * 该判据原先只写在 serve 侧 restoreHistoryMessages 里，bootstrap 的
 * switchAgentSession 则无条件调用 findRecentUnrecordedWrites——而后者是
 * readdirSync + 逐文件 statSync 的同步全树遍历（实测本仓 5000 文件
 * 270~447ms 阻塞事件循环，Windows），于是每次**正常**切换会话都白付一次。
 * 抽成单一事实源供两处调用点共用，避免判据再次漂移。
 */
export function shouldReconcileDisk(
  meta: { cleanExit?: boolean } | undefined,
): meta is { cleanExit: false } {
  return meta?.cleanExit === false
}

/** Render the reconciliation note, or null when there is nothing to disclose. */
export function formatDiskReconciliationNote(writes: RecentUnrecordedWrite[], now = Date.now()): string | null {
  if (writes.length === 0) return null
  const lines = writes.map(w => {
    const ageMin = Math.max(0, Math.round((now - w.mtimeMs) / 60_000))
    return `- ${w.path}（${formatBytes(w.bytes)}，约 ${ageMin} 分钟前修改）`
  }).join('\n')
  return `<system-reminder>\n【磁盘对账】以下文件在会话记录之外被近期修改，可能属于中断前已经完成的工作：\n${lines}\n请先 read_file 核实是否已包含目标改动；若已是目标状态请直接继续，不要重写。</system-reminder>`
}
