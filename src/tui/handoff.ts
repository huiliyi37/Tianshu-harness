/**
 * /handoff 交接能力 — 请求隔离、归档验证与提示文案。
 *
 * 设计（详见 slash-commands.ts 的 /handoff 注册）：
 * - agent 带全上下文把交接文档写到项目内唯一请求文件（工作区内免审批）；
 * - 每次请求写入完整 sessionId + requestId 隔离的项目源文件，TUI 归档到会话目录 `<id>.handoff.md`——
 *   现有 loadPrevHandoff 注入管线（prev-session-handoff appendix）无缝受益；
 * - 上下文占用 ≥ HANDOFF_NUDGE_RATIO 时提醒用户先交接再开新会话。
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'

export interface HandoffRequest {
  requestId: string
  sourcePath: string
  destinationPath: string
}

export type HandoffArchiveStatus = 'archived' | 'updated' | 'not-generated' | 'invalid-source' | 'archive-exists' | 'copy-failed'

export interface HandoffArchiveResult {
  status: HandoffArchiveStatus
  message: string
}

/** 为会话交接分配唯一项目源文件；拒绝复用任何已存在的文件。 */
export function createHandoffRequest(
  projectRoot: string,
  sessionId: string,
  destinationPath: string,
  requestId: string = randomUUID(),
): HandoffRequest {
  const sourcePath = join(projectRoot, '.rivet', `HANDOFF-${encodeURIComponent(sessionId)}-${requestId}.md`)
  if (existsSync(sourcePath)) throw new Error(`交接源文件已存在，拒绝覆盖：${sourcePath}`)
  return { requestId, sourcePath, destinationPath }
}

/** 校验本次专属源文件并原子归档；失败时保留项目源文件与既有归档。 */
export function completeHandoffRequest(request: HandoffRequest): HandoffArchiveResult {
  if (!existsSync(request.sourcePath)) {
    return { status: 'not-generated', message: `⚠ 交接文档未生成，本次未归档。预期文件：${request.sourcePath}` }
  }
  try {
    const sourceStat = lstatSync(request.sourcePath)
    if (!sourceStat.isFile() || sourceStat.size === 0) {
      return { status: 'invalid-source', message: `⚠ 交接源不是非空普通文件，未归档：${request.sourcePath}` }
    }
  } catch {
    return { status: 'not-generated', message: `⚠ 交接文档不可读取，本次未归档。预期文件：${request.sourcePath}` }
  }

  const destination = request.destinationPath
  const backup = `${destination}.previous-${request.requestId}`
  try {
    const destinationExists = existsSync(destination)
    if (destinationExists && !lstatSync(destination).isFile()) {
      return { status: 'archive-exists', message: `⚠ 交接归档目标不是普通文件，未更改：${destination}。项目源文件保留于 ${request.sourcePath}` }
    }
    if (existsSync(backup)) {
      return { status: 'copy-failed', message: `⚠ 交接归档版本已存在，未更改任何归档：${destination}。项目源文件保留于 ${request.sourcePath}` }
    }

    if (destinationExists) {
      // 保存上一份程序管理的 canonical；它在新版本提交前始终保持可用。
      writeFileAtomicSync(backup, readFileSync(destination))
    }

    writeFileAtomicSync(destination, readFileSync(request.sourcePath))
    return {
      status: destinationExists ? 'updated' : 'archived',
      message: destinationExists
        ? `✦ 交接文档已更新 ${destination}；旧版本保留于 ${backup}（项目源文件保留于 ${request.sourcePath}）。`
        : `✦ 交接文档已归档至 ${destination}（项目源文件保留于 ${request.sourcePath}；默认不注入新会话）。`,
    }
  } catch (error) {
    return { status: 'copy-failed', message: `⚠ 交接文档已生成，但归档失败，未替换任何已有归档。项目源文件保留于 ${request.sourcePath}；请检查后手动复制至 ${destination}。${error instanceof Error ? `原因：${error.message}` : ''}` }
  }
}

/** 上下文占用达到该比例时提醒 /handoff（首屏 resume + 会话中各一次）。 */
export const HANDOFF_NUDGE_RATIO = 0.6

/**
 * 交接指令全文——经 submitToAgent 发给 agent 执行。
 * 固定五章节：任务目标 / 已完成 / 当前卡点 / 下一步 / 坑。
 * 写给一个完全没有上下文的新会话（agent + 人类）看。
 */
export function buildHandoffPrompt(absPath: string, note?: string): string {
  const lines = [
    '本会话即将结束。请用 write_file 创建下面这个本次请求专属的交接文件；如果目标已存在，停止并报告，绝不能覆盖：',
    '',
    `  ${absPath}`,
    '',
    '交接文档写给一个完全没有上下文的新会话（agent 和人类）看——读者看不到本会话的任何消息，',
    '所以文档必须自包含：不许引用「上文」「之前说过」「刚才的讨论」，关键事实全部落字。',
    '',
    '固定章节（标题照用）：',
    '## 任务目标 — 我们在做什么：用户原话级的一句话目标 + 明确的非目标',
    '## 已完成 — 每条带证据：改动文件（file:line）、跑过的验证命令与结果、提交哈希（如有）',
    '## 当前卡点 — 卡在哪、已排除哪些方向、怀疑对象',
    '## 下一步 — 按优先级排列、每条是可立即执行的动作（不是「继续优化」这种泛话）',
    '## 坑 — 绝对不要再踩的坑：每条一句话说清后果（别人踩过的别再交一遍学费）',
    '',
    '要求：具体、可执行、有 file:line 级锚点；不知道的就写「未知」，不要编造。写完回复一行确认。',
  ]
  if (note && note.trim()) {
    lines.push('', `用户补充指示：${note.trim()}`)
  }
  return lines.join('\n')
}

/**
 * 60% 交接提醒文案。ratio 为 estimatedTokens/contextWindow（调用方保证 ≥0）。
 */
export function formatHandoffNudge(ratio: number): string {
  const pct = Math.round(ratio * 100)
  return `⏜ 上下文已占用约 ${pct}%——建议 /handoff 写交接文档后开新会话（交接文档落在会话目录，新会话可直接读；比整段回连省前缀重建成本）。`
}
