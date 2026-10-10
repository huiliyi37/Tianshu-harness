import { loadWorkerSession } from '../agent/worker-session-persist.js'
/**
 * Worker Detail 内容构建器 — 为 `/tasks` Enter 提供可分页、可搜索的详情。
 *
 * 数据来源：
 * - liveView（FleetRegistry）→ profile、authority、status、elapsed、activityLog
 * - ~/.rivet/subagents/<workerId>.json（loadPersistedResult）→ result summary / changed files / artifacts / usage
 * - ~/.rivet/subagents/<workerId>.<nonce>.json（listPersistedResultRounds）→ 稳定 id 复用时的逐轮归档
 * - ~/.rivet/sessions/<slug>/worker-<id>.jsonl（SessionPersist.loadOai）→ 完整对话转录
 */

import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { listPersistedResultRounds, loadPersistedResult, loadPersistedResultRound } from '../agent/coordinator.js'
import type { FleetWorkerView } from './fleet-registry.js'
import type { TranscriptMessage } from './scrollback-transcript.js'
import { parseScrollbackTranscript } from './scrollback-transcript.js'
import type { OaiMessage } from '../api/oai-types.js'
import { shortOrderLabel } from '../tools/worker-activity-stream.js'
import { formatAuthorityLabel, formatWorkerIdentity, statusWord } from './format/profile-labels.js'
import { formatElapsed } from './worker-panel-model.js'
import { formatWorkerResultDigest } from '../agent/worker-result-digest.js'

const MAX_CONTENT_CHARS = 500

function truncate(text: string, max = MAX_CONTENT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function formatTokens(usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_tokens?: number }): string {
  if (!usage) return '-'
  const parts: string[] = []
  if (usage.input_tokens !== undefined) parts.push(`in ${usage.input_tokens}`)
  if (usage.output_tokens !== undefined) parts.push(`out ${usage.output_tokens}`)
  if (usage.cache_read_input_tokens) parts.push(`cache ${usage.cache_read_input_tokens}`)
  if (usage.reasoning_tokens) parts.push(`reason ${usage.reasoning_tokens}`)
  return parts.join(' · ') || '-'
}

/** 轮次归档时间：MM-DD HH:MM（mtime 缺失时占位）。 */
function formatRoundTime(ms: number): string {
  if (!ms) return '-- --:--'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatOaiMessages(messages: readonly OaiMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'system': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(`┌─ system`)
        lines.push(truncate(text))
        break
      }
      case 'user': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(`▌ you`)
        lines.push(truncate(text))
        break
      }
      case 'assistant': {
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          lines.push(truncate(text))
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? '?'
            const args = tc.function?.arguments ?? '{}'
            lines.push(`● ${name} ${truncate(args, 160)}`)
          }
        }
        break
      }
      case 'tool': {
        lines.push(`● tool result  ${msg.tool_call_id ?? ''}`)
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        lines.push(truncate(text))
        break
      }
    }
  }
  return lines.join('\n')
}

export interface WorkerDetailContent {
  content: string
  title: string
  messages: TranscriptMessage[]
}

/**
 * 构建指定 worker 的详情内容。
 * @param workerId work order id（如 wo_team:T1）
 * @param cwd 当前项目目录，用于定位会话文件
 * @param liveView FleetRegistry 中的实时视图（可选，提供 profile/authority/activityLog）
 */
export function buildWorkerDetailContent(
  workerId: string,
  cwd: string,
  liveView?: FleetWorkerView,
): WorkerDetailContent {
  const shortLabel = liveView?.shortLabel ?? shortOrderLabel(workerId)
  const lines: string[] = []

  lines.push(`══ 子代理 ${shortLabel} ══`)
  const identity = liveView ? formatWorkerIdentity({ profile: liveView.profile, authority: liveView.authority }) : shortLabel
  // 状态词/耗时与 fleet 行同口径（statusWord/formatElapsed），不再自造英文态 + 150s。
  const statusText = liveView ? statusWord(liveView.status) : 'unknown'
  const elapsedText = liveView?.elapsedMs !== undefined ? ` · ${formatElapsed(liveView.elapsedMs)}` : ''
  lines.push(`${identity} · ${statusText}${elapsedText}`)
  if (liveView?.contract?.objective) {
    lines.push(`目标：${truncate(liveView.contract.objective)}`)
  }

  // ── 参数（机械信息下沉）──
  const paramLines: string[] = []
  if (liveView?.contract) {
    const c = liveView.contract
    paramLines.push(`工具：${c.allowedToolsDigest}`)
    paramLines.push(`预算：${c.budget.maxTurns} 轮 · ${Math.floor(c.budget.timeoutMs / 1000)}s`)
    if (c.scope.files?.length) {
      paramLines.push(`范围：${c.scope.files.slice(0, 5).join(', ')}${c.scope.files.length > 5 ? ` +${c.scope.files.length - 5}` : ''}`)
    }
  }
  paramLines.push(`id: ${workerId}`)
  if (liveView?.authority) paramLines.push(`星域：${formatAuthorityLabel(liveView.authority, liveView.authorityReason)}`)

  // ── 活动日志 ──
  if (liveView?.activityLog && liveView.activityLog.length > 0) {
    lines.push('')
    lines.push('── 活动 ──')
    for (const entry of liveView.activityLog) {
      lines.push(`  ${entry}`)
    }
  }

  // ── 持久化结果 ──
  const logicalId = liveView?.workOrderId ?? workerId
  const roundsForWorker = listPersistedResultRounds(logicalId)
  const matches = (r: ReturnType<typeof loadPersistedResult>) => !liveView?.dispatchId || (r?.dispatchId === liveView.dispatchId && (!liveView.attemptId || r.attemptId === liveView.attemptId))
  const selectedRound = roundsForWorker.filter(round => matches(loadPersistedResultRound(logicalId, round.nonce))).at(-1)
  const result = liveView?.dispatchId
    ? selectedRound ? loadPersistedResultRound(logicalId, selectedRound.nonce) : null
    : loadPersistedResult(logicalId)
  if (result) {
    lines.push('')
    lines.push('── 结果 ──')
    lines.push(formatWorkerResultDigest({
      status: result.status,
      summary: result.summary,
      findingsCount: result.findings?.length ?? 0,
      changedFilesCount: result.changedFiles?.length ?? 0,
      sourcesReviewedCount: result.sourcesReviewed,
      failureReason: result.failureReason,
      evidenceStatus: result.evidenceStatus,
      salvagedFindingsCount: result.findings?.filter(f => f.salvaged === true).length ?? 0,
    }))
    if (result.findings && result.findings.length > 0) {
      lines.push('发现：')
      for (const f of result.findings.slice(0, 5)) {
        const conf = f.confidence ? ` [${f.confidence}]` : ''
        lines.push(`  ·${conf} ${truncate(f.claim, 120)}`)
      }
      if (result.findings.length > 5) lines.push(`  … 还有 ${result.findings.length - 5} 条`)
    }
    if (result.verification) {
      const v = result.verification
      const g = v.status === 'passed' ? '✅' : v.status === 'failed' ? '❌' : '⚠'
      lines.push(`验证：${g} ${v.passed ?? 0}/${(v.passed ?? 0) + (v.failed ?? 0)} 通过 · ${v.command}`)
    }
    if (result.changedFiles && result.changedFiles.length > 0) {
      lines.push('改动文件：')
      for (const f of result.changedFiles.slice(0, 20)) lines.push(`  · ${f}`)
      if (result.changedFiles.length > 20) lines.push(`  … 还有 ${result.changedFiles.length - 20} 个`)
    }
    if (result.nextActions && result.nextActions.length > 0) {
      lines.push('后续动作：')
      for (const a of result.nextActions.slice(0, 5)) lines.push(`  · ${truncate(a, 120)}`)
    }
    if (result.risks && result.risks.length > 0) {
      lines.push('风险：')
      for (const r of result.risks.slice(0, 10)) lines.push(`  · ${r}`)
    }
    if (result.artifacts && result.artifacts.length > 0) {
      lines.push('产物：')
      for (const a of result.artifacts) {
        lines.push(`  · [${a.kind}] ${a.title}`)
        lines.push(`    ${truncate(a.content, 200)}`)
      }
    }

    lines.push('')
    lines.push('── 参数 ──')
    if (result.model) lines.push(`模型：${result.model}`)
    if (result.provider) lines.push(`提供商：${result.provider}`)
    if (result.usage) lines.push(`用量：${formatTokens(result.usage)}`)
    lines.push(...paramLines)
  } else if (paramLines.length > 0) {
    lines.push('')
    lines.push('── 参数 ──')
    lines.push(...paramLines)
  }

  // ── 派发轮次（L1：稳定 id 复用时每轮各一份归档，上面 Result 展示最新一轮） ──
  const rounds = roundsForWorker.filter(round => matches(loadPersistedResultRound(logicalId, round.nonce)))
  if (rounds.length > 1) {
    lines.push('')
    lines.push(`── Rounds ── 该 id 派发了 ${rounds.length} 次，Result 为最新一轮`)
    rounds.forEach((round, i) => {
      const r = loadPersistedResultRound(logicalId, round.nonce)
      const status = r?.status ?? '?'
      const summary = r ? ` · ${truncate(r.summary, 60)}` : ''
      lines.push(`  #${i + 1} ${formatRoundTime(round.savedAt)} · ${status}${summary}`)
    })
  }

  // ── 完整会话转录 ──
  const sessionId = `worker-${workerId.replace(/:/g, '-')}`
  const persist = new SessionPersist(sessionId, cwd)
  let transcriptText = ''
  try {
    const messages = liveView?.dispatchId
      ? selectedRound ? loadWorkerSession(logicalId, undefined, selectedRound.nonce)?.messages ?? [] : []
      : persist.loadOai()
    transcriptText = formatOaiMessages(messages)
  } catch {
    transcriptText = '(worker transcript not available)'
  }

  if (transcriptText) {
    lines.push('')
    lines.push('── 转录 ──')
    lines.push(transcriptText)
  }

  const content = lines.join('\n')
  return {
    content,
    title: `子代理 ${shortLabel}`,
    messages: parseScrollbackTranscript(content),
  }
}

/** 返回 worker 会话文件是否已落盘（用于 UI 判断是否可进入 detail）。 */
export function workerSessionExists(workerId: string, cwd: string): boolean {
  try {
    const sessionId = `worker-${workerId.replace(/:/g, '-')}`
    const persist = new SessionPersist(sessionId, cwd)
    return !!persist.getFilePath()
  } catch {
    return false
  }
}
