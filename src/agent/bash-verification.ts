import { classifyVerificationCommand, verificationArgv } from '../tools/verification-command.js'
import { applyBatchCounts, type TestCounts } from '../tools/test-output-counts.js'
import { completionFacts } from '../tools/verification-facts.js'
import { classifyVerificationIntent } from './verification-intent.js'
import type { ToolResult, VerificationMetadata } from '../tools/types.js'

/** 该命令是否是验证调用——**记账入口必须用它过滤**，纯查询不进 verification 台账。 */
export function isVerificationCommand(command: string, cwd = ''): boolean {
  return classifyVerificationIntent(command, cwd).purpose !== 'none'
}

/** 复合命令里那条可归因的验证段——用于 blocked 时给出**可复制**的单条命令。
 *
 *  动机：`cd repo && npm test | tail -5` 是最自然的写法，但归因器无法给它逐文件
 *  完成证明，旧反馈只说「请使用工具 cwd 和独立命令」——用户不知道该写成什么样。
 *  这里把内层验证段切出来（引号内容先掩码以免切坏带空格的路径），去掉重定向与
 *  `cd` 前缀后返回，让反馈变成可粘贴的命令。已经是单条可归因形态 → null（不回显自己）。 */
export function suggestSingleCommand(command: string): string | null {
  const trimmed = command.trim()
  // 单条且能被 argv 解析 = 已经是好形态，无需建议。
  if (verificationArgv(trimmed) !== null && isVerificationCommand(trimmed)) return null
  const holes: string[] = []
  const masked = trimmed.replace(/'[^']*'|"[^"]*"/g, m => {
    holes.push(m)
    return `\u0000${holes.length - 1}\u0000`
  })
  for (const raw of masked.split(/&&|\|\||[;|]/)) {
    const seg = raw
      .replace(/\d*>>?\s*[^\s&|;]+/g, ' ')   // > out / 2> err
      .replace(/\d*>&\d+/g, ' ')             // 2>&1
      .replace(/^\s*cd\s+[^\s&|;]+\s*/, '')  // cd 前缀（单条命令请用工具的 cwd 参数）
      .trim()
    if (!seg) continue
    const restored = seg.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => holes[Number(i)] ?? '')
    if (isVerificationCommand(restored)) return restored
  }
  return null
}

/** 兼容入口：始终给出一个 scope；不是验证命令时退化为 unknown（供只关心
 *  scope/targetFiles 的消费方使用）。判断「要不要记账」请用 isVerificationCommand。 */
export function inferBashVerificationScope(command: string, cwd = ''): Pick<VerificationMetadata, 'scope' | 'targetFiles' | 'kind'> {
  return classifyVerificationIntent(command, cwd).scope ?? { scope: 'unknown' }
}

/** blocked 时的可操作反馈：说清为什么无法归因 + 给出可复制的单条命令。 */
function blockedGuidance(command: string): string {
  const reason = classifyVerificationCommand(command).reason
  const suggestion = suggestSingleCommand(command)
  if (!suggestion) return reason ?? '缺少完整逐文件完成证明；请用支持的运行器重新验证。'
  return `${reason ?? '这条命令无法归因为验证。'}\n可复制的单条命令：${suggestion}`
}

function count(output: string, pattern: RegExp): number {
  const match = output.match(pattern)
  return match ? Number.parseInt(match.slice(1).find(value => value !== undefined) ?? '0', 10) : 0
}

export function buildBashVerification(
  command: string,
  result: ToolResult | undefined,
  outcome: { content: string; isError: boolean; errorClass?: string },
  cwd = '',
): VerificationMetadata {
  const output = outcome.content
  let passed = count(output, /(?:ℹ|#)\s+pass\s+(\d+)|✅\s+(\d+)\s+passed|Tests?\s+(\d+)\s+passed/i)
  let failed = count(output, /(?:ℹ|#)\s+fail\s+(\d+)|❌\s+(\d+)\s+failed|Tests?\s+(\d+)\s+failed/i)
  let skipped = count(output, /(?:ℹ|#)\s+(?:skip|skipped)\s+(\d+)/i)
  const exitCode = typeof result?.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : undefined
  const errorClass = result?.errorClass ?? (outcome.isError ? outcome.errorClass : undefined)
  const timedOut = errorClass === 'timeout' || /timed out after \d+s/i.test(output)
  const counts: TestCounts = { passed, failed, skipped, exitCode: exitCode ?? -1, failures: [] }
  applyBatchCounts(output, counts)
  Object.assign(counts, completionFacts(result?.verification?.coverage))
  ;({ passed, failed, skipped } = counts)
  const scope = result?.verification?.coverage
    ? { kind: 'test' as const, scope: result.verification.scope, targetFiles: result.verification.targetFiles ?? inferBashVerificationScope(command, cwd).targetFiles }
    : inferBashVerificationScope(command, cwd)
  const status = outcome.isError || result?.isError || timedOut || failed > 0 || (exitCode !== undefined && exitCode !== 0)
    ? 'failed' : exitCode === 0 && scope.scope !== 'unknown' ? 'passed' : 'blocked'
  const failureKind = timedOut ? 'timeout'
    : status === 'failed' && (errorClass === 'environment' || errorClass === 'exec-failure') ? 'tool_invocation_failure'
    : status === 'failed' && exitCode !== undefined && result?.isError === false ? 'test_failure'
    : undefined
  return {
    command, status, ...scope, passed, failed, skipped, countsReliable: counts.countsReliable,
    ...(result?.verification?.coverage ? { coverage: result.verification.coverage } : {}),
    ...(status === 'blocked' || scope.kind === 'test' && !result?.verification?.coverage?.complete ? { userGuidance: blockedGuidance(command) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...completionFacts(result?.verification?.coverage),
    ...(result?.verification?.timestamp ? { timestamp: result.verification.timestamp, durationMs: result.verification.durationMs } : {}),
  }
}
