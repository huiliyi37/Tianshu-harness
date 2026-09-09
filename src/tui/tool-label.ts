import type { ToolCallItem } from './tool-status.js'

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function phaseLabel(tools: ToolCallItem[], isThinking: boolean): string {
  if (isThinking) return 'Thinking…'

  const pending = tools.filter(t => !t.done)
  if (pending.length === 0 && tools.length === 0) return 'Processing…'
  if (pending.length === 0) return 'Wrapping up…'

  const latest = pending[pending.length - 1]!
  switch (latest.name) {
    case 'read_file': case 'grep': case 'glob': case 'diff':
      return 'Searching…'
    case 'write_file': case 'edit_file':
      return 'Writing…'
    case 'bash':
      return 'Running…'
    case 'run_tests':
      return 'Testing…'
    case 'delegate_task': case 'delegate_batch':
      return 'Delegating…'
    default:
      return 'Working…'
  }
}

export function statusPhaseText(activitySummary: string | undefined, tools: ToolCallItem[], isThinking: boolean): string {
  return activitySummary ?? phaseLabel(tools, isThinking)
}

function pathBasename(value: unknown): string {
  return String(value ?? '').replace(/^.*[/]/, '')
}

function formatInputValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function readFileDetail(input: Record<string, unknown>): string {
  const details = Object.entries(input)
    .filter(([key]) => key !== 'file_path')
    .map(([key, value]) => `${key}=${formatInputValue(value)}`)

  return details.length > 0 ? ` · ${truncate(details.join(' '), 60)}` : ''
}

/**
 * 工具的主参数摘要（不含动词前缀）——供 Claude Code 风格的
 * `● Verb(arg)` 工具卡片标题使用。
 */
export function toolArgSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': return `${truncate(pathBasename(input.file_path), 45)}${readFileDetail(input)}`
    case 'write_file':
    case 'edit_file': return truncate(pathBasename(input.file_path), 45)
    case 'bash': return truncate(String(input.command ?? '').split('\n')[0] ?? '', 55)
    case 'grep':
    case 'glob': return truncate(String(input.pattern ?? ''), 35)
    case 'delegate_task': return truncate(String(input.objective ?? ''), 50)
    case 'delegate_batch': return `${Array.isArray(input.tasks) ? input.tasks.length : '?'} tasks`
    case 'web_fetch': return truncate(String(input.url ?? ''), 50)
    case 'browser_debug': {
      const action = String(input.action ?? '')
      const detail = input.url ?? input.selector ?? input.expression ?? input.level ?? ''
      return truncate(detail ? `${action} ${detail}` : action, 50)
    }
    default: return ''
  }
}

export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': return `read ${toolArgSummary(name, input)}`
    case 'write_file': return `write ${toolArgSummary(name, input)}`
    case 'edit_file': return `edit ${toolArgSummary(name, input)}`
    case 'bash': return toolArgSummary(name, input)
    case 'grep': return `grep ${toolArgSummary(name, input)}`
    case 'glob': return `glob ${toolArgSummary(name, input)}`
    case 'diff': return 'diff'
    case 'run_tests': return 'run tests'
    case 'delegate_task': return toolArgSummary(name, input)
    case 'delegate_batch': return `batch ${toolArgSummary(name, input)}`
    default: return name
  }
}
