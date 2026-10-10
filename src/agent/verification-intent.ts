/** Shared execution facts. Purpose, bounded waiting and completion evidence are distinct. */
import { basename } from 'node:path'
import { classifyVerificationCommand, verificationArgv, verificationPackageScript, shellWord } from '../tools/verification-command.js'
import { unwrapVerification } from '../tools/verification-invocation.js'
import { classifyBashVerificationPurpose } from './bash-verification-purpose.js'
import type { VerificationMetadata } from '../tools/types.js'

export type VerificationPurpose = 'test' | 'typecheck' | 'lint' | 'build' | 'check' | 'unknown' | 'none'
export type VerificationLifetime = 'finite' | 'persistent' | 'unknown'
export type VerificationIntentSource = 'pipeline-filter' | 'persistent-shape' | 'node-test' | 'batch-runner' | 'runner-kind' | 'unattributable' | 'non-verification'
export interface VerificationExecutionIntent {
  purpose: VerificationPurpose
  lifetime: VerificationLifetime
  waitingEligible: boolean
  allowsCompletionEvidence: boolean
  entry: string | null
  cwd: string
  argv: string[] | null
  scope: Pick<VerificationMetadata, 'scope' | 'targetFiles' | 'kind'> | null
  source: VerificationIntentSource
  reason?: string
}
const BASE = { purpose: 'none', lifetime: 'unknown', waitingEligible: false, allowsCompletionEvidence: false,
  entry: null, argv: null, scope: null, source: 'non-verification' } as const
const exeOf = (value: string) => basename(value.replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/i, '')
const VALUE_OPTIONS = new Set(['--import', '--require', '-r', '--loader', '--test-name-pattern', '--test-skip-pattern', '--testNamePattern', '--grep', '-t', '-k', '-m'])
function isQuery(argv: readonly string[]): boolean {
  for (let i = 1; i < argv.length; i++) {
    if (VALUE_OPTIONS.has(argv[i]!)) { i++; continue }
    if (/^(?:--help|-h|--version|-V)$/.test(argv[i]!)) return true
  }
  return false
}

function splitPipeline(command: string): [string, string] | null {
  const masked = command.replace(/'[^']*'|"[^"]*"/g, m => '\u0000'.repeat(m.length))
  const first = masked.indexOf('|')
  if (first < 0 || masked.indexOf('|', first + 1) >= 0) return null
  return [command.slice(0, first), command.slice(first + 1)]
}
const FILTER = /^(?:rtk\s+(?:proxy\s+)?)?(?:tail|head)\s+(?:-\d+|-n\s+\d+)$/

function persistentReason(argv: readonly string[]): string | null {
  const exe = exeOf(argv[0] ?? '')
  if (argv.some(a => /^--(?:watch|watchAll|watch-all)(?:=|$)/.test(a) && !a.endsWith('=false'))) return 'watch 模式常驻'
  if (argv.includes('-w') && ['tsc', 'vitest', 'jest', 'webpack', 'vite', 'esbuild', 'rollup'].includes(exe)) return 'watch 短选项常驻'
  if (exe === 'vitest' && !argv.some(a => ['run', '--run', '-r'].includes(a))) return 'vitest 未明确采用非 watch 模式'
  if (exe === 'tail' && argv.some(a => /^-(?:f|F)$|^--follow(?:=|$)/.test(a))) return 'follow 常驻输出'
  if (['vite', 'next', 'nuxt', 'webpack'].includes(exe) && ['dev', 'serve'].includes(argv[1] ?? '')) return 'dev server 常驻'
  if (exe === 'nodemon') return 'nodemon 常驻'
  return null
}

export function classifyVerificationIntent(command: string, cwd: string, depth = 0): VerificationExecutionIntent {
  const trimmed = command.trim()
  if (!trimmed || depth > 3) return { ...BASE, cwd, reason: '空命令或脚本解析深度超限' }
  const pipeline = splitPipeline(trimmed)
  if (pipeline) {
    const [head, filter] = pipeline
    const left = classifyVerificationIntent(head, cwd, depth + 1)
    if (FILTER.test(filter.trim()) && left.waitingEligible) return { ...left, source: 'pipeline-filter',
      scope: { scope: 'unknown', kind: left.scope?.kind }, allowsCompletionEvidence: false, reason: '过滤器退出码不能证明验证通过' }
    return { ...BASE, cwd: left.cwd, purpose: left.purpose === 'none' ? 'none' : 'unknown', source: left.purpose === 'none' ? 'non-verification' : 'unattributable',
      scope: left.purpose === 'none' ? null : { scope: 'unknown' }, reason: '管道无法归因' }
  }
  const leaf = unwrapVerification(trimmed, cwd)
  let effective = leaf?.command ?? trimmed
  const effectiveCwd = leaf?.cwd ?? cwd
  const environmentArgs = verificationArgv(effective)
  if (environmentArgs) {
    while (/^[A-Za-z_]\w*=/.test(environmentArgs[0] ?? '')) environmentArgs.shift()
    effective = environmentArgs.map(shellWord).join(' ')
  }
  const argv = verificationArgv(effective)
  const entry = argv ? exeOf(argv[0] ?? '') : null
  const scope = classifyBashVerificationPurpose(effective, effectiveCwd)
  const common = { cwd: effectiveCwd, argv, entry, scope }
  if (argv && isQuery(argv)) return { ...BASE, ...common, scope: null, reason: '帮助/版本查询' }
  const purpose = scope?.kind ?? (scope ? 'unknown' : 'none')
  if (!argv) return { ...BASE, ...common, purpose, source: scope ? 'unattributable' : 'non-verification', reason: '不透明 shell' }
  let index = exeOf(argv[0] ?? '') === 'rtk' ? (argv[1] === 'proxy' ? 2 : 1) : 0
  if (['npx', 'bunx'].includes(exeOf(argv[index] ?? ''))) { index++; if (argv[index] === '--') index++ }
  const runnerArgv = argv.slice(index)
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(exeOf(runnerArgv[0] ?? ''))) {
    if (exeOf(runnerArgv[0] ?? '') === 'bun' && runnerArgv[1] === 'test') {
      const persistent = persistentReason(runnerArgv)
      return { ...BASE, ...common, purpose: 'test', lifetime: persistent ? 'persistent' : 'finite', waitingEligible: !persistent,
        source: persistent ? 'persistent-shape' : 'runner-kind', ...(persistent ? { reason: persistent } : {}) }
    }
    const script = verificationPackageScript(argv, effectiveCwd)
    if (script) {
      const inner = classifyVerificationIntent(script, effectiveCwd, depth + 1)
      return inner.purpose !== 'none' || inner.lifetime === 'persistent' ? { ...inner, argv } :
        { ...BASE, ...common, purpose, scope: scope ? { ...scope, scope: 'unknown' } : null, source: scope ? 'unattributable' : 'non-verification', reason: '包脚本无法确认验证入口' }
    }
    const name = runnerArgv[['run', 'run-script'].includes(runnerArgv[1] ?? '') ? 2 : 1]
    return { ...BASE, ...common, purpose, lifetime: ['dev', 'serve', 'start'].includes(name ?? '') ? 'persistent' : 'unknown', source: scope ? 'unattributable' : 'non-verification', reason: '包脚本未解析' }
  }
  const persistent = persistentReason(runnerArgv)
  if (persistent) return { ...BASE, ...common, purpose, lifetime: 'persistent', source: 'persistent-shape', reason: persistent }
  const info = classifyVerificationCommand(effective, effectiveCwd)
  if (info.nodeTest || info.batchRunner) return { ...BASE, ...common, purpose: 'test', lifetime: 'finite', waitingEligible: true,
    allowsCompletionEvidence: !info.filtered, scope: { kind: 'test', scope: info.filtered ? 'unknown' : info.targets.length ? 'targeted' : 'full', ...(info.targets.length ? { targetFiles: info.targets } : {}) },
    entry: info.batchRunner ? basename(info.argv.find(a => /scripts\/run-(?:node-)?tests\.ts$/.test(a)) ?? '') : entry,
    source: info.batchRunner ? 'batch-runner' : 'node-test' }
  if (['node', 'tsx'].includes(exeOf(runnerArgv[0] ?? ''))) return { ...BASE, ...common, purpose: scope ? 'unknown' : 'none', source: scope ? 'unattributable' : 'non-verification' }
  if (exeOf(runnerArgv[0] ?? '') === 'make') return { ...BASE, ...common, purpose: scope ? 'unknown' : 'none', source: scope ? 'unattributable' : 'non-verification' }
  if (scope?.kind) return { ...BASE, ...common, purpose, lifetime: 'finite', waitingEligible: true,
    allowsCompletionEvidence: scope.scope !== 'unknown', source: 'runner-kind' }
  return { ...BASE, ...common, purpose, source: scope ? 'unattributable' : 'non-verification', reason: scope ? '验证入口无法归因' : '非验证命令' }
}

/** 原生验证工具的启动意图（P2）：工具名即入口（run_tests/typecheck/lsp_diagnostics），
 *  无需命令解析；前台执行（非后台 job）不产生等待保护（waitingEligible=false）；
 *  目标不可确认（scope=null）——重复验证软判据因 identity 不可确认而不启动（未知不冒充）。 */
const NATIVE_VERIFICATION_PURPOSES: Record<string, { purpose: VerificationPurpose; kind: 'test' | 'typecheck' }> = {
  run_tests: { purpose: 'test', kind: 'test' },
  typecheck: { purpose: 'typecheck', kind: 'typecheck' },
  lsp_diagnostics: { purpose: 'typecheck', kind: 'typecheck' },
}

export function nativeVerificationStartIntent(name: string, cwd: string): VerificationExecutionIntent | null {
  const hit = NATIVE_VERIFICATION_PURPOSES[name]
  if (!hit) return null
  return {
    purpose: hit.purpose,
    lifetime: 'finite',
    waitingEligible: false,
    allowsCompletionEvidence: false,
    entry: null,
    cwd,
    argv: null,
    scope: null,
    source: 'runner-kind',
  }
}
