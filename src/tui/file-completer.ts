import { execFile } from 'node:child_process'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

/**
 * Tab 补全的 `@` 触发后从光标前最近 `@` 起的非空白 token。
 * token 内的 emoji/CJK 不会被切碎——正则用 `[^\s]` 锁住空白边界，
 * 让用户粘贴「@🎯 目标.md」或「@中文 路径.md」类带表情符号/中文的
 * 路径请求走完整个 token，再交由 `getCompletions` 走 git ls-files 过滤。
 */
export function extractAtToken(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^\s]*)$/)
  return match ? match[1]! : null
}

/**
 * 走 `git ls-files` 拿补全候选。
 *
 * 在后台查询：外盘上的 git 可能超过原同步 500ms 预算，既不能堵住键盘，
 * 也不能因此丢掉正常候选。3s 限制只约束后台进程；输入变化可提前取消。
 *
 * 非 git 目录 / 命令失败 / 超时 → 静默返回 []，**不抛错**：
 * @-补全是输入便利功能，不应污染主流程；上层也只把候选列表当作
 * 「建议」，空候选就当普通 @-token 提交给 agent。
 */
const GIT_LS_FILES_TIMEOUT_MS = 3_000

export async function getCompletions(partial: string, cwd: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) return []
  try {
    const output = await new Promise<string>(resolve => {
      execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd,
        encoding: 'utf-8',
        timeout: GIT_LS_FILES_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        signal,
      }, (error, stdout) => resolve(error ? '' : stdout))
    })
    const lower = partial.replaceAll('\\', '/').toLowerCase()
    return output
      .split('\0')
      .filter(Boolean)
      .filter(f => !f.split('/').some(isFilesystemMetadata))
      .filter(f => f.toLowerCase().includes(lower))
      .sort((a, b) => {
        const aS = a.toLowerCase().startsWith(lower) ? 0 : 1
        const bS = b.toLowerCase().startsWith(lower) ? 0 : 1
        return aS - bS || a.length - b.length
      })
      .slice(0, limit)
  } catch {
    return []
  }
}

export function applyCompletion(text: string, cursorPos: number, completion: string): { text: string; cursor: number } {
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const atIdx = before.lastIndexOf('@')
  // 规范形 @file:（含空格路径用引用形）——mention-parser 只认该协议；
  // 此前插入裸 @path 提交后不会被解析成引用（静默断链，2026-07-24 修复）。
  const mention = completion.includes(' ') ? `@file:"${completion}" ` : `@file:${completion} `
  const newText = before.slice(0, atIdx) + mention + after
  return { text: newText, cursor: atIdx + mention.length }
}
