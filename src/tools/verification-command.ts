import { parseTestSelection } from './test-selection.js'
import { basename, resolve } from 'node:path'
import { resolvePackageTestCommand } from './test-package-command.js'
import { modernRunnerSelection, type TestRunner } from './test-runner-options.js'

export interface VerificationInvocation {
  argv: string[]
  runnerIndex: number
  resolvedArgv?: string[]
  nodeTest: boolean
  batchRunner: boolean
  filtered: boolean
  targets: string[]
  reason?: string
  fixedPackageTargets?: boolean
  runner?: TestRunner
  resolvedCwd?: string
  persistent?: boolean
  packageScript?: boolean
}

export { verificationArgv, shellWord } from './test-command-words.js'
import { verificationArgv, shellWord } from './test-command-words.js'

import { testExecutable as exe, testCommandIndex } from './test-package-command.js'
const FILTER = /^(?:--test-name-pattern|--test-skip-pattern|--testNamePattern|--test-tag|--grep|-t|-k|-m)(?:=|$)/
const VALUE_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--test-timeout', '--test-concurrency', '--test-reporter', '--test-reporter-destination', '--test-shard'])

/** Resolve a literal package script; opaque bodies retain their shell syntax. */
export function verificationPackageScript(argv: readonly string[], cwd: string): string | undefined {
  if (!cwd) return undefined
  const entry = resolvePackageTestCommand(argv, cwd)
  return entry ? entry.script + entry.rest.map(a => ` ${shellWord(a)}`).join('') : undefined
}

export function classifyVerificationCommand(command: string, cwd?: string, depth = 0, seen = new Set<string>()): VerificationInvocation {
  const parsed = verificationArgv(command)
  const unknown = (reason: string): VerificationInvocation => ({ argv: parsed ?? [], runnerIndex: 0, nodeTest: false, batchRunner: false, filtered: false, targets: [], reason })
  if (!parsed?.length) return unknown('复合 shell 或引号无法归因；请使用工具 cwd 和独立命令。')
  const argv = [...parsed]
  let index = testCommandIndex(argv)
  if (['npx', 'bunx'].includes(exe(argv[index] ?? ''))) { index++; if (argv[index] === '--') index++ }
  const runner = exe(argv[index] ?? '')
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(runner) && cwd) {
    if (depth >= 8 || seen.has(`${cwd}::${command}`)) return unknown('包脚本存在循环或解析深度超限。')
    const entry = resolvePackageTestCommand(argv, cwd)
    if (!entry) return unknown('包脚本或工作区选择未解析到唯一支持的入口；请按文件分组。')
    const chain = new Set(seen).add(`${cwd}::${command}`)
    const body = entry.script + entry.rest.map(a => ` ${shellWord(a)}`).join('')
    const inner = classifyVerificationCommand(body, entry.cwd, depth + 1, chain)
    if (!inner.runner && !inner.nodeTest && !inner.batchRunner) return { ...unknown(inner.reason ?? '包脚本未解析到支持的测试运行器。'), persistent: inner.persistent }
    return { ...inner, argv, resolvedArgv: inner.resolvedArgv ?? inner.argv,
      resolvedCwd: inner.resolvedCwd ?? entry.cwd, runnerIndex: index,
      packageScript: !!entry.scriptName,
      fixedPackageTargets: inner.fixedPackageTargets || inner.nodeTest && classifyVerificationCommand(entry.script, entry.cwd, depth + 1, chain).targets.length > 0 }
  }
  const modern = modernRunnerSelection(argv, index)
  if (modern) return { argv, runnerIndex: index, nodeTest: false, batchRunner: false,
    ...modern, resolvedCwd: cwd }
  if (!['node', 'tsx'].includes(runner)) return unknown('未适配的运行器：缺少逐文件完成证明。')
  const selected = parseTestSelection(argv.slice(index + 1))
  if (selected.reason) return unknown(selected.reason)
  const targets: string[] = []
  let nodeTest = false, filtered = false, batchRunner = false
  for (let i = index + 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (batchRunner) { targets.push(arg); continue }
    if (FILTER.test(arg)) { filtered = true; if (!arg.includes('=')) i++; continue }
    if (arg === '--test-force-exit') continue
    if (arg === '--test') { nodeTest = true; continue }
    if (arg === '--test-only') { filtered = true; continue }
    if (VALUE_FLAGS.has(arg)) { i++; continue }
    if (arg.startsWith('-')) {
      if (!/^(?:--(?:import|require|loader|experimental-loader|test-timeout|test-concurrency|test-shard)=|--test-(?:reporter|reporter-destination)=)/.test(arg)) return unknown('未知运行器选项：无法证明完整文件执行。')
      continue
    }
    const normalized = arg.replaceAll('\\', '/')
    const desktopPackageEntry = cwd && basename(resolve(cwd)) === 'desktop' && normalized === 'scripts/run-tests.ts'
    if (!nodeTest && (/(?:^|\/)(?:scripts\/run-node-tests\.ts|desktop\/scripts\/run-tests\.ts)$/.test(normalized) || desktopPackageEntry)) batchRunner = true
    else {
      if (!nodeTest) return unknown('脚本参数不是 Node 测试入口。')
      targets.push(arg)
    }
  }
  if (!nodeTest && !batchRunner) return unknown('没有受支持的测试入口。')
  return { argv, runnerIndex: index, nodeTest, batchRunner, filtered, targets, runner: 'node-test', resolvedCwd: cwd }
}
