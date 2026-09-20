/**
 * P1-4 —— 只读、可分享的会话快照构建器（回流自 `origin/tianshu-alpha-3.14`）。
 *
 * 快照是一份**带版本的 JSON**，只含对话本身（user/assistant 文本，可选 reasoning）
 * 以及（按需）工作区改动元数据/ diff。它**永不包含**工具调用参数、shell 命令、
 * 工具输出、原始工作区文件——与 Codex 的 shared-thread 快照同口径。所有文本在离开
 * 服务端之前过脱敏（见 `snapshot-redact.ts`）。
 *
 * 与桌面已有的"导出会话"（`desktop/src/lib/export-session.ts`）的区别是有意的：
 * 那条是**保真备份**（含工具输出、不脱敏，给自己留档用），这条是**分享用快照**
 * （脱敏 + 无工具面 + 可被对方导入回灌）。两条并存，别把其中一条改造成另一条。
 */

import { SessionPersist } from '../agent/session-persist.js'
import { oaiMessageText, type OaiMessage } from '../api/oai-types.js'
import { getFileDiff, getWorkingTreeFiles, type WorkingTreeFile } from '../tools/git.js'
import type { SessionEvent, SessionRecord } from './protocol.js'
import { truncateUtf16Safe } from './redact.js'
import { redactSnapshotValue } from './snapshot-redact.js'

export const SNAPSHOT_VERSION = 1 as const

/** 上限：分享件要能被读、被贴、被再导入——超出就截断并留痕。 */
const MAX_MESSAGES = 2000
const MAX_REASONING_CHARS = 6000
const MAX_FILES = 50
const MAX_DIFF_CHARS = 20_000

export interface SessionSnapshotMessage {
  role: 'user' | 'assistant'
  text: string
  /** 用户消息的提交时间（按 user 事件序数对齐，best-effort）。 */
  ts?: number
  /** includeReasoning 打开时的推理内容（已截断）。 */
  reasoningSummary?: string
}

export interface SessionSnapshotFileChange {
  path: string
  status: WorkingTreeFile['status']
  additions: number
  deletions: number
  diff?: string
}

export interface SessionSnapshot {
  version: typeof SNAPSHOT_VERSION
  createdAt: number
  meta: {
    title: string
    model?: string
  }
  messages: SessionSnapshotMessage[]
  /** 仅在请求 includeFileChanges 时出现。 */
  fileChanges?: SessionSnapshotFileChange[]
  redaction: {
    findings: number
    appliedAt: number
  }
}

export interface BuildSessionSnapshotOptions {
  includeReasoning?: boolean
  includeFileChanges?: boolean
}

export interface BuildSessionSnapshotResult {
  snapshot: SessionSnapshot
  findings: number
}

/** 截断留痕，且不切出半个代理对（与 redact.ts 同一把尺子）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${truncateUtf16Safe(text, max)}\n…(truncated)`
}

/**
 * 导入件的形状校验——消费端真正会读的字段都要覆盖。
 *
 * 导入源是不受控的第三方文件（对方手写、旧版本、被编辑过的），只验
 * `version`/`meta`/`messages` 三档会让 `redaction.findings` 这类读取在**渲染期**
 * 抛错：抛点躲在对话框之外，最近的 ErrorBoundary 是 surface 级，一崩就是整个工作区
 * 换成错误页。所以能挡在服务端的一律挡在这里（400），前端另有一道规整兜底。
 */
export function isImportableSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const s = value as Record<string, unknown>
  if (s.version !== SNAPSHOT_VERSION) return false
  const meta = s.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false
  if (typeof (meta as Record<string, unknown>).title !== 'string') return false
  if (!Array.isArray(s.messages)) return false
  for (const m of s.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false
    const msg = m as Record<string, unknown>
    if (msg.role !== 'user' && msg.role !== 'assistant') return false
    if (typeof msg.text !== 'string') return false
    if (msg.ts !== undefined && typeof msg.ts !== 'number') return false
    if (msg.reasoningSummary !== undefined && typeof msg.reasoningSummary !== 'string') return false
  }
  if (s.fileChanges !== undefined) {
    if (!Array.isArray(s.fileChanges)) return false
    for (const f of s.fileChanges) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) return false
      const change = f as Record<string, unknown>
      if (typeof change.path !== 'string' || typeof change.status !== 'string') return false
      if (typeof change.additions !== 'number' || typeof change.deletions !== 'number') return false
    }
  }
  const redaction = s.redaction
  if (!redaction || typeof redaction !== 'object' || Array.isArray(redaction)) return false
  const r = redaction as Record<string, unknown>
  return typeof r.findings === 'number' && typeof r.appliedAt === 'number'
}

/**
 * 为单个会话构建脱敏只读快照。`events` 是全量事件日志（路由传
 * `manager.getEvents(id, 0)`）——它只用来给 user 消息配时间戳。
 */
export async function buildSessionSnapshot(
  record: SessionRecord,
  events: SessionEvent[],
  options: BuildSessionSnapshotOptions = {},
): Promise<BuildSessionSnapshotResult> {
  const persist = new SessionPersist(record.id, record.cwd)
  let oaiMessages: OaiMessage[]
  try {
    oaiMessages = persist.loadOai()
  } catch {
    // 转录读不出来就当空对话——快照仍然导出（至少带上标题与文件改动），
    // 而不是让整个导出失败。
    oaiMessages = []
  }

  const userEvents = events.filter((e) => e.type === 'user')
  // 窗口取**尾部**：分享场景要的是最近的进展，从头取等于把最有用的那段丢在门外。
  // 先滤掉工具面再开窗——一次 tool 往返占两行 oai，混杂计数会让配额被工具面吃掉。
  const conversational = oaiMessages.filter((m) => m.role === 'user' || m.role === 'assistant')
  const window = conversational.slice(-MAX_MESSAGES)
  // user 事件的时间戳按**全局**序数对齐：被窗口截掉的前缀 user 消息仍占号，
  // 否则整段 ts 会前移（第 3 条 user 的提交时间贴到第 1 条上）。
  let userOrdinal = conversational
    .slice(0, conversational.length - window.length)
    .filter((m) => m.role === 'user').length
  const messages: SessionSnapshotMessage[] = []
  for (const msg of window) {
    const text = oaiMessageText(msg) ?? ''
    if (msg.role === 'user') {
      const ts = userEvents[userOrdinal]?.ts
      userOrdinal++
      if (!text.trim()) continue
      messages.push({ role: 'user', text, ...(ts !== undefined ? { ts } : {}) })
    } else {
      const reasoning = options.includeReasoning && msg.reasoning_content
        ? truncate(msg.reasoning_content, MAX_REASONING_CHARS)
        : undefined
      if (!text.trim() && !reasoning) continue
      messages.push({ role: 'assistant', text, ...(reasoning ? { reasoningSummary: reasoning } : {}) })
    }
  }

  let fileChanges: SessionSnapshotFileChange[] | undefined
  if (options.includeFileChanges) {
    const tree = await getWorkingTreeFiles(record.cwd, record.baselineHead ?? 'HEAD')
    fileChanges = []
    for (const file of tree.files.slice(0, MAX_FILES)) {
      let diff: string | undefined
      try {
        const raw = await getFileDiff(record.cwd, file.path, record.baselineHead ?? 'HEAD')
        if (raw.trim()) diff = truncate(raw, MAX_DIFF_CHARS)
      } catch { /* 读不了的文件只留元数据 */ }
      fileChanges.push({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(diff ? { diff } : {}),
      })
    }
  }

  const rawSnapshot: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: Date.now(),
    meta: {
      title: record.title ?? record.id.slice(0, 8),
      ...(record.model ? { model: record.model } : {}),
    },
    messages,
    ...(fileChanges ? { fileChanges } : {}),
    redaction: { findings: 0, appliedAt: 0 },
  }

  const { value: snapshot, findings } = redactSnapshotValue(rawSnapshot)
  snapshot.redaction = { findings, appliedAt: Date.now() }
  return { snapshot, findings }
}
