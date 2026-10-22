export type GoalControlCommand = '/goal-status' | '/goal-pause' | '/goal-resume' | '/goal-cancel' | '/goal-criteria'

export type GoalInvocation =
  | { kind: 'control'; command: GoalControlCommand; args: string[] }
  | { kind: 'help' }
  | { kind: 'start'; args: string[]; literal: boolean }

const CONTROL_COMMANDS: Record<string, GoalControlCommand> = {
  status: '/goal-status',
  pause: '/goal-pause',
  resume: '/goal-resume',
  clear: '/goal-cancel',
  cancel: '/goal-cancel',
}

/** Resolve only complete control phrases; additional words remain objective text. */
export function resolveGoalInvocation(args: string[]): GoalInvocation {
  if (args.length === 0) return { kind: 'control', command: '/goal-status', args: [] }
  if (args[0] === '--') return { kind: 'start', args: args.slice(1), literal: true }
  const first = args[0]!.toLowerCase()
  if (args.length === 1 && (first === 'help' || first === '--help')) return { kind: 'help' }
  if (first === 'criteria' && (args.length === 1 || args[1]?.toLowerCase() === 'set')) {
    return { kind: 'control', command: '/goal-criteria', args: args.slice(1) }
  }
  if (args.length === 1 && Object.hasOwn(CONTROL_COMMANDS, first)) {
    return { kind: 'control', command: CONTROL_COMMANDS[first]!, args: [] }
  }
  return { kind: 'start', args, literal: false }
}

export const GOAL_HELP_TEXT = `/goal 目标管理

/goal                              查看当前目标状态
/goal <目标> [--max N] [--budget M] [--criteria '["验收项"]']  开始目标
/goal status                       查看状态
/goal pause                        暂停目标
/goal resume                       恢复暂停或阻塞的目标
/goal clear                        清除目标（/goal cancel 同义）
/goal criteria                     查看验收项
/goal criteria set '["...", "..."]'  设置验收项
/goal -- <目标文字>                将后续内容作为字面目标，不解析 flags
/goal help                         显示本帮助

控制词仅在独立参数时生效；例如 /goal pause the deployment 会创建目标。
旧命令仍可用：/goal-status、/goal-pause、/goal-resume、/goal-criteria、/goal-cancel、/cancel-goal。`

export interface ParsedGoalArgs {
  goalText: string
  maxIterations?: number
  wallClockMs?: number
  criteria?: string[]
  error?: string
}

function unwrapJson(text: string): string {
  const trimmed = text.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Join TUI-split `/goal criteria set` JSON and remove a matching shell-style quote pair. */
export function normalizeGoalCriteriaArgs(args: string[]): string[] {
  if (args[0]?.toLowerCase() !== 'set' || args.length < 2) return args
  return ['set', unwrapJson(args.slice(1).join(' '))]
}

function parseCriteria(parts: string[], start: number): { criteria?: string[]; next: number; error?: string } {
  if (start >= parts.length) return { next: start, error: '--criteria 缺少 JSON 字符串数组' }
  for (let end = start + 1; end <= parts.length; end++) {
    const text = unwrapJson(parts.slice(start, end).join(' '))
    try {
      const value: unknown = JSON.parse(text)
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        return { next: end, error: '--criteria 必须是 JSON 字符串数组' }
      }
      return { criteria: value, next: end }
    } catch {
      // Tokens are split on whitespace by the TUI. Keep collecting until the JSON closes.
    }
  }
  return { next: parts.length, error: '--criteria JSON 无效；请提供 JSON 字符串数组' }
}

/** Parse existing /goal flags. Unknown flags remain goal text for compatibility. */
export function parseGoalArgs(parts: string[], literal = false): ParsedGoalArgs {
  if (literal) {
    const goalText = parts.join(' ').trim()
    return goalText ? { goalText } : { goalText, error: '请提供目标描述' }
  }
  const textParts: string[] = []
  const out: ParsedGoalArgs = { goalText: '' }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === '--max' || part === '--budget') {
      const raw = parts[i + 1]
      if (raw === undefined || raw.startsWith('--')) {
        out.error = `${part} 缺少有效数值`
        return out
      }
      const value = Number(raw)
      if (part === '--max') {
        if (!Number.isSafeInteger(value) || value <= 0) {
          out.error = '--max 必须是正整数'
          return out
        }
        out.maxIterations = value
      } else {
        const milliseconds = Math.round(value * 60_000)
        if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
          out.error = '--budget 必须是正数（分钟）'
          return out
        }
        out.wallClockMs = milliseconds
      }
      i++
      continue
    }
    if (part === '--criteria') {
      const parsed = parseCriteria(parts, i + 1)
      if (parsed.error) {
        out.error = parsed.error
        return out
      }
      out.criteria = parsed.criteria
      i = parsed.next - 1
      continue
    }
    textParts.push(part)
  }
  out.goalText = textParts.join(' ').trim()
  if (!out.goalText) out.error = '请提供目标描述'
  return out
}
