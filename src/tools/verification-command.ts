import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

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
}

/** Classification only. Unsupported shell syntax fails towards less evidence. */
export function verificationArgv(command: string): string[] | null {
  const argv: string[] = [], literalWords: boolean[] = []
  let word = '', quote = '', active = false, literal = true
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (/[\n\r`$]/.test(c)) return null
    if (quote) {
      if (c === quote) quote = ''
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; active = true; if (c !== "'") literal = false; continue }
    if (/[;&|<>()]/.test(c)) return null
    if (/\s/.test(c)) {
      if (active) { argv.push(word); literalWords.push(literal); word = ''; active = false; literal = true }
    } else { word += c; active = true; literal = false }
  }
  if (quote) return null
  if (active) { argv.push(word); literalWords.push(literal) }
  // Percent syntax is literal only in a quoted, validated file URL import.
  for (const [index, value] of argv.entries()) if (value.includes('%')) {
    if (argv[index - 1] !== '--import' || !literalWords[index] || !value.startsWith('file:') || /%(?![0-9a-f]{2})/i.test(value)) return null
    try { fileURLToPath(value) } catch { return null }
  }
  return argv
}

const exe = (value: string) => basename(value.replaceAll('\\', '/')).replace(/\.(exe|cmd)$/i, '')
const FILTER = /^(?:--test-name-pattern|--test-skip-pattern|--testNamePattern|--test-tag|--grep|-t|-k|-m)(?:=|$)/
const VALUE_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--test-timeout', '--test-concurrency', '--test-reporter', '--test-reporter-destination'])

export function classifyVerificationCommand(command: string, cwd?: string, depth = 0): VerificationInvocation {
  const parsed = verificationArgv(command)
  const unknown = (reason: string): VerificationInvocation => ({ argv: parsed ?? [], runnerIndex: 0, nodeTest: false, batchRunner: false, filtered: false, targets: [], reason })
  if (!parsed?.length) return unknown('复合 shell 或引号无法归因；请使用工具 cwd 和独立命令。')
  const argv = [...parsed]
  let index = 0
  if (exe(argv[index]!) === 'rtk') { index++; if (argv[index] === 'proxy') index++ }
  if (['npx', 'bunx'].includes(exe(argv[index] ?? ''))) { index++; if (argv[index] === '--') index++ }
  const runner = exe(argv[index] ?? '')
  if (['npm', 'pnpm', 'yarn'].includes(runner) && cwd && depth < 2) {
    const offset = argv[index + 1] === 'run' ? 2 : 1
    const name = argv[index + offset]
    try {
      const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      const script = name && pkg.scripts?.[name]
      if (script) {
        const rest = argv.slice(index + offset + 1).filter(a => a !== '--')
        const inner = classifyVerificationCommand(script, cwd, depth + 1)
        if (inner.nodeTest || inner.batchRunner) {
          const resolved = classifyVerificationCommand([...inner.argv, ...rest].map(shellWord).join(' '), cwd, depth + 1)
          return { ...resolved, argv, resolvedArgv: resolved.argv, runnerIndex: index, fixedPackageTargets: inner.nodeTest && inner.targets.length > 0 }
        }
      }
    } catch { /* Unknown package scripts never acquire completion evidence. */ }
    return unknown('包脚本未解析到支持的测试运行器。')
  }
  if (!['node', 'tsx'].includes(runner)) return unknown('未适配的运行器：缺少逐文件完成证明。')
  const targets: string[] = []
  let nodeTest = false, filtered = false, batchRunner = false
  for (let i = index + 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (batchRunner) { targets.push(arg); continue }
    if (FILTER.test(arg)) { filtered = true; if (!arg.includes('=')) i++; continue }
    if (arg === '--test') { nodeTest = true; continue }
    if (VALUE_FLAGS.has(arg)) { i++; continue }
    if (arg.startsWith('-')) {
      if (!/^(?:--(?:import|require|loader|experimental-loader|test-timeout|test-concurrency)=|--test-(?:reporter|reporter-destination)=)/.test(arg)) return unknown('未知运行器选项：无法证明完整文件执行。')
      continue
    }
    const normalized = arg.replaceAll('\\', '/')
    if (!nodeTest && /(?:^|\/)(?:scripts\/run-node-tests\.ts|desktop\/scripts\/run-tests\.ts)$/.test(normalized)) batchRunner = true
    else targets.push(arg)
  }
  if (!nodeTest && !batchRunner) return unknown('没有受支持的测试入口。')
  return { argv, runnerIndex: index, nodeTest, batchRunner, filtered, targets }
}

/** All words were parsed without expansion. Single quoting preserves literal argv. */
export function shellWord(word: string): string {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}
