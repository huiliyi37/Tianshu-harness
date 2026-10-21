import { prepareCompletionCaptureAsync, type AsyncCompletionCapture } from './test-completion-async.js'
import { classifyVerificationCommand, verificationArgv, shellWord } from './verification-command.js'
import { applyBatchCounts, formatTestCounts } from './test-output-counts.js'
import { DisplayOutputBuffer } from './display-output-buffer.js'
import { existsSync } from 'node:fs'
import { join, delimiter, win32 as winPath, posix as posixPath } from 'node:path'
import type { Tool, ToolCallParams, ToolResult, VerificationMetadata, VerificationBlockedReason } from './types.js'
import { track } from './process-tracker.js'
import { WinStreamDecoder } from '../platform.js'
import { spawnHidden } from './spawn-hidden.js'
import { killProcessTree } from './process-kill.js'
import { persistRawOutput, buildUiOutput } from './output-store.js'
import { getResolvedEnv } from './resolved-env.js'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { completionFacts } from './verification-facts.js'
import { loadDeclaredVerify } from '../config/verify-config.js'
import { buildLegacyTestCommand, type TestCommand } from './legacy-test-command.js'
import { OutputStreamBudget } from './output-stream-budget.js'
import { runTestPhases } from './run-test-phases.js'
import { runPlannedTests } from './run-planned-tests.js'
import { verificationTimeout, runTestsTimeoutMs, verificationBudgetStop } from './verification-budget.js'
import { resolveNpmCliCommand } from '../platform/resolve-node-cli.js'
import { candidateTypecheckCommand } from './candidate-typecheck.js'
import { candidateSnapshotRef } from '../agent/candidate-snapshot-ref.js'

/** context-collapse 靠此正则解析 formatOutput 摘要行；改文案必须与消费方同步（常量共享，禁止两边各自手抄）。 */
export const RUN_TESTS_PASSED_RE = /(\d+)\s+通过/
export const RUN_TESTS_FAILED_RE = /(\d+)\s+失败(?!项)/
export const RUN_TESTS_EXIT_CODE_RE = /退出码[：:]\s*(\d+)/i

export interface RunnableTestCommand {
  type: 'run'
  command: string
  args: string[]
  display: string
  runner: string
  scope: 'full' | 'targeted'
  relativeCwd?: string
  targetFiles?: string[]
  recommendedCommand?: string
  /** True for declared/fingerprint commands that are full shell strings
   *  (e.g. "cargo test", "go test ./...") rather than argv arrays. */
  shell?: boolean
}

/** Node's loader runs the same targeted tests without the tsx CLI's IPC server. */
function withNodeTsxLoader(cwd: string, command: RunnableTestCommand): RunnableTestCommand {
  let loader = 'tsx'
  try { loader = pathToFileURL(createRequire(join(cwd, 'package.json')).resolve('tsx')).href } catch { /* Missing project dependency remains a Node invocation error. */ }
  const args = ['--import', loader, ...command.args]
  const displayArgs = command.args.map(arg => /^[A-Za-z0-9_./=:-]+$/.test(arg) ? arg : shellWord(arg))
  return { ...command, command: process.execPath, args, display: `node --import tsx ${displayArgs.join(' ')}` }
}

/** A spawn descriptor normalized for the host OS (see {@link resolveTestSpawn}). */
export interface ResolvedTestSpawn {
  command: string
  args: string[]
  /** True when the command must run through a shell (Windows `.cmd` shims). */
  shell: boolean
}

/** Injectable IO for {@link resolveTestSpawn} so it's unit-testable on any host. */
export interface TestSpawnDeps {
  isWindows: boolean
  exists: (p: string) => boolean
  execPath?: string
  path?: string
}

/** Resolve project-local tsx on POSIX; Windows .cmd runners retain shell quoting. */
export function resolveTestSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  deps: TestSpawnDeps = { isWindows: process.platform === 'win32', exists: existsSync },
): ResolvedTestSpawn {
  if (!deps.isWindows) {
    if (command !== 'tsx') return { command, args: [...args], shell: false }
    let cli = posixPath.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    try { cli = createRequire(join(cwd, 'package.json')).resolve('tsx/cli') } catch { /* Missing local dependency is an invocation error, never an install. */ }
    return { command: process.execPath, args: [cli, ...args], shell: false }
  }

  const host = deps.execPath ?? process.execPath
  const npm = resolveNpmCliCommand(command, [...args], { platform: 'win32', execPath: host, existsSync: deps.exists })
  if (npm.command !== command) return { ...npm, shell: false }
  const manager = command.replace(/\.cmd$/i, '')
  const bins = manager === 'pnpm' ? ['pnpm/bin/pnpm.cjs'] : manager === 'yarn' ? ['yarn/bin/yarn.js', '@yarnpkg/cli-dist/bin/yarn.js'] : manager === 'tsx' ? ['tsx/dist/cli.mjs'] : []
  const directories = [cwd, ...((deps.path ?? process.env.PATH ?? '').split(';'))]
  for (const directory of directories) for (const bin of bins) {
    const cli = winPath.join(directory, 'node_modules', bin)
    if (deps.exists(cli)) return { command: host, args: [cli, ...args], shell: false }
  }

  // shell:true 让 Node 把 argv 拼成单条 cmd.exe 命令行——引号必须覆盖一切
  // 非安全字符（空白、& | < > ^ ( ) 等元字符），否则仓库可控的文件名
  // （如 a&calc.cmd）可注入 cmd。% 与内部 " 在双引号内仍危险（变量展开/
  // 断引），必须明确拒绝，不能替换文件名；已整体带引号且内部干净的
  // token 原样通过（不双重加引）。
  const CMD_SAFE = /^[A-Za-z0-9@_+=:,./\\-]+$/
  const quote = (raw: string): string => {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') && !/[%"!]/.test(raw.slice(1, -1))) {
      return raw
    }
    if (/[%"!\n\r]/.test(raw)) throw new Error('该参数无法安全通过 cmd.exe；请使用真实 CLI 入口，不能改写文件名。')
    const s = raw
    return CMD_SAFE.test(s) ? s : `"${s}"`
  }

  if (command === 'tsx') {
    // Prefer the project-local shim so targeted tsx runs work without a global tsx.
    // win32 path math keeps this deterministic when unit-tested on POSIX hosts.
    const localShim = winPath.join(cwd, 'node_modules', '.bin', 'tsx.cmd')
    if (deps.exists(localShim)) {
      // Always quote the resolved path — cwd may contain spaces (C:\Users\My Name).
      // Mirrors lsp/client.ts::runTscSubprocess + theta-check.ts::resolveTscCommand.
      return { command: `"${localShim}"`, args: args.map(quote), shell: true }
    }
    // No download fallback: a missing installed CLI is a normal invocation error.
    return { command: host, args: [winPath.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ...args], shell: false }
  }

  if (['npm', 'npx', 'pnpm', 'yarn'].includes(manager)) {
    // Bare command name; cmd.exe resolves npm.cmd/npx.cmd from PATH under shell.
    return { command, args: args.map(quote), shell: true }
  }

  // node / pytest / other real executables: spawn directly.
  return { command, args: [...args], shell: false }
}


interface ParsedResult {
  exitCode: number
  passed: number
  failed: number
  skipped: number
  duration: string
  failures: Array<{ name: string; error: string }>
  countsReliable?: boolean
}

function asNum(s: string | undefined, fallback = 0): number {
  return s ? parseInt(s, 10) : fallback
}

/** Strip ANSI escape sequences (colors, cursor moves, etc.) from raw output. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '')
}

export function parseOutput(raw: string, runner: string): ParsedResult {
  const clean = stripAnsi(raw)
  const result: ParsedResult = {
    exitCode: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: '',
    failures: [],
  }

  if (runner === 'vitest' || runner === 'npm') {
    const summaryMatch = clean.match(/Tests\s+(.*?)$/m)
    if (summaryMatch) {
      const s = summaryMatch[1] ?? ''
      result.failed = asNum(s.match(/(\d+)\s+failed/)?.[1])
      result.passed = asNum(s.match(/(\d+)\s+passed/)?.[1])
      result.skipped = asNum(s.match(/(\d+)\s+skipped/)?.[1])
    }
    const durMatch = clean.match(/Duration\s+([\d.]+s)/)
    if (durMatch) result.duration = durMatch[1] ?? ''
  }

  if (runner === 'node-test') {
    const durMatch = clean.match(/[ℹ#]\s+duration_ms\s+([\d.]+)/)
    if (durMatch) result.duration = durMatch[1] ?? ''
  }

  if (runner === 'jest') {
    const summaryMatch = clean.match(/Tests:\s+(.*?)$/m)
    if (summaryMatch) {
      const s = summaryMatch[1] ?? ''
      result.failed = asNum(s.match(/(\d+)\s+failed/)?.[1])
      result.passed = asNum(s.match(/(\d+)\s+passed/)?.[1])
      result.skipped = asNum(s.match(/(\d+)\s+skipped/)?.[1])
    }
    const durMatch = clean.match(/Time:\s+([\d.]+s)/)
    if (durMatch) result.duration = durMatch[1] ?? ''
  }

  if (runner === 'pytest') {
    const summaryMatch = clean.match(/={2,}\s*(.*?)\s+in\s+([\d.]+s)\s*={2,}/) ?? clean.match(/([^\n]*\b(?:passed|failed|skipped)\b[^\n]*)\s+in\s+([\d.]+s)/)
    if (summaryMatch) {
      const s = summaryMatch[1] ?? ''
      result.failed = asNum(s.match(/(\d+)\s+failed/)?.[1])
      result.passed = asNum(s.match(/(\d+)\s+passed/)?.[1])
      result.skipped = asNum(s.match(/(\d+)\s+skipped/)?.[1])
      result.duration = summaryMatch[2] ?? ''
    }
  }

  if (runner === 'declared') {
    // Declared commands can be any toolchain — parse the common formats,
    // fall back to exit-code-only semantics when nothing matches.
    // cargo test: "test result: ok. 12 passed; 0 failed; 1 ignored; ..."
    for (const m of clean.matchAll(/test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed(?:;\s+(\d+)\s+ignored)?/g)) {
      result.passed += asNum(m[1])
      result.failed += asNum(m[2])
      result.skipped += asNum(m[3])
    }
    // go test -v: "--- FAIL: TestX" per failure; "ok  <pkg>  0.5s" per package
    if (result.passed === 0 && result.failed === 0) {
      const goFails = [...clean.matchAll(/^--- FAIL: (\S+)/gm)]
      const goOk = [...clean.matchAll(/^ok\s+\S+/gm)]
      if (goFails.length > 0 || goOk.length > 0) {
        result.failed = goFails.length
        result.passed = goOk.length // package-level granularity without -v
      }
    }
    // pytest-style summary (declared "pytest -x" etc.)
    if (result.passed === 0 && result.failed === 0) {
      const py = clean.match(/(\d+)\s+passed/) ?? undefined
      const pyf = clean.match(/(\d+)\s+failed/) ?? undefined
      result.passed = asNum(py?.[1])
      result.failed = asNum(pyf?.[1])
    }
  }

  const failLines: Array<{ name: string; error: string }> = []
  const nodeTestFails = clean.matchAll(/✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\n((?:  .*\n)*)/g)
  for (const m of nodeTestFails) {
    failLines.push({ name: (m[1] ?? '').trim(), error: (m[2] ?? '').trim() })
  }
  const vitestFails = clean.matchAll(/FAIL\s+(.+)\n((?:  .*\n|\t.*\n)*)/g)
  for (const m of vitestFails) {
    failLines.push({ name: (m[1] ?? '').trim(), error: (m[2] ?? '').trim() })
  }
  result.failures = failLines
  applyBatchCounts(clean, result)

  return result
}

function formatOutput(result: ParsedResult): string {
  const lines: string[] = []
  lines.push(`退出码：${result.exitCode}`)
  lines.push(formatTestCounts(result))

  if (result.failures.length > 0) {
    lines.push('失败项：')
    for (const f of result.failures) {
      lines.push(`  ✖ ${f.name}`)
      if (f.error) {
        const errorLines = f.error.split('\n').slice(0, 5)
        for (const el of errorLines) {
          lines.push(`    ${el}`)
        }
      }
    }
  }

  if (result.duration) {
    lines.push(`耗时：${result.duration}`)
  }

  return lines.join('\n')
}

const MAX_OUTPUT = 8000
const HEAD_CHARS = 4000
const TAIL_CHARS = 3000

function buildBlockedVerification(
  command: TestCommand,
  startTime: number,
  blockedReason: VerificationBlockedReason,
  userGuidance: string,
): VerificationMetadata {
  return {
    command: command.display,
    kind: 'test',
    status: 'blocked',
    scope: command.scope,
    exitCode: -1,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: Date.now() - startTime,
    timestamp: startTime,
    // 超时与「启动失败」不是一回事（2026-09-22）：超时意味着进程可能仍在跑、
    // 工作区可能还在被写，正确的下一步是「先核实状态」而非「换个命令重跑」。
    // 此前这里对所有 blockedReason 一律标记 tool_invocation_failure，把 timeout
    // 也吞了进去——调用方明明已经传了 blockedReason: 'timeout'。
    failureKind: blockedReason === 'timeout' ? 'timeout' : 'tool_invocation_failure',
    blockedReason,
    userGuidance,
    ...(command.recommendedCommand ? { recommendedCommand: command.recommendedCommand } : {}),
  }
}

function extractTargetFilesFromCommand(testCommand: RunnableTestCommand, filter?: string): string[] {
  if (testCommand.targetFiles) return testCommand.targetFiles
  const testFilePattern = /([^\s"']+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)|[^\s"']+\.py)/g
  const allMatches = [
    ...testCommand.args.join(' ').matchAll(testFilePattern),
    ...testCommand.display.matchAll(testFilePattern),
    ...(filter?.matchAll(testFilePattern) ?? []),
  ]
  return [...new Set(allMatches.map(m => m[1]!))]
}

function truncateOutput(output: string, rawPath?: string, tailOnly = false): string {
  if (output.length <= MAX_OUTPUT) return output
  const head = output.slice(0, HEAD_CHARS)
  const tail = output.slice(-TAIL_CHARS)
  const omitted = output.length - HEAD_CHARS - TAIL_CHARS
  const suffix = rawPath ? `——${tailOnly ? '已保存输出尾部见' : '完整日志见'} ${rawPath}` : ''
  return `${head}\n...（中间省略 ${omitted} 字符${suffix}）...\n${tail}`
}

function buildExecutionEnv(cwd: string): NodeJS.ProcessEnv {
  const localBin = join(cwd, 'node_modules', '.bin')
  const repoBin = join(process.cwd(), 'node_modules', '.bin')
  // Base off the resolved env so test runners that shell out to toolchain
  // commands (mvn/gradle/java) find them under a GUI-launched minimal PATH.
  const base = { ...getResolvedEnv(cwd) }
  delete base.NODE_TEST_CONTEXT
  // PATH may be spelled `Path` on Windows — look it up case-insensitively.
  const pathKey = Object.keys(base).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const currentPath = base[pathKey] ?? ''
  // Snapshot worktrees have no node_modules — inherit tool-path env vars from
  // the parent process so tests that depend on external tools (rg, etc.) work
  // identically in-place and in isolation.
  const toolEnvVars = ['RIVET_RIPGREP_PATH', 'RIVET_BUNDLED_RIPGREP_DIR'] as const
  for (const key of toolEnvVars) {
    if (base[key] === undefined && process.env[key] !== undefined) base[key] = process.env[key]
  }
  return {
    ...base,
    [pathKey]: [localBin, repoBin, currentPath].filter(Boolean).join(delimiter),
  }
}

export const RUN_TESTS_TOOL: Tool = {
  definition: {
    name: 'run_tests',
    description: `运行项目测试并返回解析后的结果。

### 用法
- 修改代码后用 run_tests 验证改动
- files 接受精确仓库相对路径，可跨包；与 filter 互斥
- deliveryFiles 指定本次拟提交的文件，验证在当前 HEAD + 这些文件改动的隔离候选树上运行；与 files（测试文件）含义不同
- check="typecheck" 与 deliveryFiles 合用，仅在本地 tsc 的项目配置覆盖全部候选 TypeScript 文件时提供同树类型检查证明
- filter 按文件名／词干定位 .test/.spec；重名返回候选，不选择第一项
- JS/TS 保留项目入口、hooks、配置和 loader；支持 Node、Vitest、Jest 的逐文件采证
- 无法推断出安全的 runner 时返回具体受阻原因，不自动安装依赖
- 报告：exit code、失败的测试、错误详情、耗时

### filter 怎么写
文件名和相对路径都可以，带不带 .test/.spec 后缀都能解析：
好：run_tests() —— 运行全部测试
好：run_tests(filter="loop.test.ts") —— 按文件名定位
好：run_tests(filter="loop") —— 词干也可以，重名时改用精确路径
好：run_tests(files=["packages/web/src/a.spec.ts"]) —— workspace 文件
好：run_tests(filter="src/agent/__tests__/loop.test.ts") —— 相对路径最精确
好：run_tests(filter="tests/test_example.py") —— 一个 Python pytest 文件
坏：run_tests(filter="handles empty input") —— 这是测试名，定位不到文件会受阻
坏：run_tests(filter="star-genesis") —— 源文件名而无同名测试文件时同样受阻

要按测试名筛选，用 bash 执行项目自身的测试命令（如 --test-name-pattern）。
不确定测试文件叫什么，先用 glob 找 **/*<关键词>*.test.ts。`,
    input_schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, minItems: 1, description: '精确的仓库相对测试路径；可以跨包，与 filter 互斥。' },
        deliveryFiles: { type: 'array', items: { type: 'string' }, minItems: 1, description: '拟提交的仓库相对文件路径；仅验证这些改动与当前 HEAD 形成的候选树。' },
        check: { type: 'string', enum: ['typecheck'], description: '对 deliveryFiles 候选树做完整本地 TypeScript 类型检查；不运行测试。' },
        projects: { type: 'array', items: { type: 'string' }, description: '明确选择配置项目，空数组表示恢复标准配置的全部项目；不会缩小交付所需的项目范围。' },
        shard: { type: 'boolean', enum: [false], description: '显式取消原 Jest/Vitest 分片，用于剩余文件定向补测。' },
        filter: { type: 'string', description: '测试文件名、词干或相对路径（不是测试名）。留空跑全量。' },
        timeout: { type: 'integer', description: '整次验证的总预算（毫秒，默认：120000），隔离、集成与归因重试共用。' },
      },
    },
  },

  async execute(params: ToolCallParams) {
    if (params.input.deliveryFiles !== undefined) {
      const files = params.input.deliveryFiles
      if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== 'string' || !file.trim()) || params.candidateSnapshotError || !params.verificationSnapshot?.candidateOnly) {
        return { content: params.candidateSnapshotError ?? '候选快照不可用；未运行实时工作区测试，交付验证仍待完成。', isError: true,
          verification: { command: 'run_tests', kind: 'test', status: 'blocked', scope: 'targeted', blockedReason: 'unknown_runner', candidateFiles: Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [] } }
      }
    }
    const filter = params.input.filter as string | undefined
    const timeout = verificationTimeout(params.input.timeout)
    const startTime = Date.now()
    const remaining = () => Math.max(0, timeout - (Date.now() - startTime))
    if (params.input.check !== undefined) {
      const selected = params.input.deliveryFiles as string[] | undefined
      const snapshot = params.verificationSnapshot
      const command = params.input.check === 'typecheck' && selected && snapshot?.candidateOnly
        && params.input.files === undefined && params.input.filter === undefined
        ? candidateTypecheckCommand(snapshot.path, selected) : null
      if (!command || !snapshot) return { content: '候选类型检查不可采证：需要 deliveryFiles，且本地 tsconfig.json 必须覆盖所有候选 TypeScript 文件。', isError: true,
        verification: { command: 'run_tests check=typecheck', kind: 'typecheck', status: 'blocked', scope: 'full', blockedReason: 'unknown_runner', candidateFiles: selected } }
      const candidateParams = params.onOutput
        ? { ...params, onOutput: (chunk: string) => params.onOutput?.(chunk.replaceAll(snapshot.path, params.cwd)) }
        : params
      const result = await runTestCommandIn(snapshot.path, { type: 'run', command: command.command, args: command.args,
        display: 'tsc --noEmit --project tsconfig.json', runner: 'declared', scope: 'full' }, candidateParams, undefined, remaining(), undefined, params.cwd)
      result.content = result.content.replaceAll(snapshot.path, params.cwd)
      if (result.verification) result.verification = { ...result.verification, coverage: undefined, userGuidance: undefined,
        kind: 'typecheck', scope: 'full', snapshotRef: snapshot.snapshotRef, verificationPhase: 'isolated', candidateFiles: selected,
        candidateTypecheckComplete: result.verification.status === 'passed' }
      if (candidateSnapshotRef(snapshot.path, selected ?? []) !== snapshot.snapshotRef) {
        result.isError = true
        result.content += '\n候选快照在类型检查期间变化；类型证明已作废。'
        if (result.verification) result.verification = { ...result.verification, status: 'blocked', stale: true, candidateTypecheckComplete: false, blockedReason: 'unknown_runner' }
      }
      result.content = `[候选类型检查] ${result.content}`
      return result
    }
    if (params.input.deliveryFiles !== undefined || params.input.projects !== undefined || params.input.shard !== undefined || params.input.files !== undefined || existsSync(join(params.cwd, 'package.json')) && !loadDeclaredVerify(params.cwd).test
      && (filter || classifyVerificationCommand('npm test', params.cwd).runner)) {
      return runPlannedTests(params, remaining)
    }
    const testCommand = await buildLegacyTestCommand(params.cwd, filter)

    if (testCommand.type === 'blocked') {
      const rawPath = await persistRawOutput(params.toolUseId, testCommand.message)
      const meta = { command: testCommand.display, exitCode: -1, durationMs: Date.now() - startTime }
      return {
        content: testCommand.message,
        uiContent: buildUiOutput(testCommand.message, meta),
        rawPath,
        isError: true,
        verification: buildBlockedVerification(testCommand, startTime, testCommand.blockedReason, testCommand.userGuidance),
      }
    }

    return runTestPhases(params, testCommand, filter, remaining)
  },

  timeoutMs: runTestsTimeoutMs,

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

interface TestStreamDecoder {
  write(data: Buffer): string
  end(): string
}

export interface RunTestChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

export interface RunTestCommandDeps {
  spawn(
    command: string,
    args: readonly string[],
    options: Parameters<typeof spawnHidden>[2],
  ): RunTestChild
  kill(child: RunTestChild, signal: NodeJS.Signals): void
  persist(toolUseId: string, raw: string): Promise<string>
  setTimeout(callback: () => void | Promise<void>, ms: number): unknown
  clearTimeout(handle: unknown): void
  createDecoder(): TestStreamDecoder
  /**
   * Completion capture runs in a separate evidence process (moved off the
   * service thread). Injectable so unit tests can exercise the spawn and
   * settlement contract without paying for a worker fork on every case.
   */
  prepareCompletion?: PrepareTestCompletion
}

export type PrepareTestCompletion = (
  command: string,
  cwd: string,
  repositoryRoot: string | undefined,
  deadline: number,
  signal: AbortSignal | undefined,
) => Promise<AsyncCompletionCapture | undefined>

/** Default seam: hand the command to the evidence process worker. */
export const defaultPrepareTestCompletion: PrepareTestCompletion = (command, cwd, repositoryRoot, deadline, signal) =>
  prepareCompletionCaptureAsync(command, cwd, 'bash', repositoryRoot, deadline, signal)

const defaultRunTestDeps: RunTestCommandDeps = {
  spawn: (command, args, options) => track(spawnHidden(command, [...args], options)),
  kill: (child, signal) => killProcessTree(child as ReturnType<typeof spawnHidden>, signal),
  persist: persistRawOutput,
  setTimeout: (callback, ms) => setTimeout(() => { void callback() }, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  createDecoder: () => new WinStreamDecoder(),
  prepareCompletion: defaultPrepareTestCompletion,
}

export async function runTestCommandIn(
  cwd: string,
  testCommand: RunnableTestCommand,
  params: ToolCallParams,
  filter: string | undefined,
  timeout: number,
  deps: RunTestCommandDeps = defaultRunTestDeps,
  repositoryRoot?: string,
): Promise<ToolResult> {
  cwd = join(cwd, testCommand.relativeCwd ?? '.')
  const startTime = Date.now()
  if (params.abortSignal?.aborted || timeout <= 0) return Promise.resolve(verificationBudgetStop(testCommand, startTime, params.abortSignal?.aborted ? 'cancelled' : 'timeout'))
  // Normalize for the host OS: on Windows npm/npx/tsx are `.cmd` shims that need
  // a shell (else modern Node throws EINVAL); node/pytest spawn directly.
  // Declared commands (verify.test / fingerprint) are full shell strings.
  const prepareCompletion = deps.prepareCompletion ?? defaultPrepareTestCompletion
  const completion = await prepareCompletion(testCommand.shell ? testCommand.command : [testCommand.command, ...testCommand.args].map(shellWord).join(' '), cwd, repositoryRoot, startTime + timeout, params.abortSignal)
  timeout = Math.max(0, timeout - (Date.now() - startTime))
  if (timeout <= 0 || params.abortSignal?.aborted) { completion?.dispose(); return Promise.resolve(verificationBudgetStop(testCommand, startTime, params.abortSignal?.aborted ? 'cancelled' : 'timeout')) }
  if (completion?.preparationError) { completion.dispose(); return Promise.resolve({ content: completion.preparationError, isError: true, verification: { ...buildBlockedVerification(testCommand, startTime, 'unknown_runner', completion.preparationError), coverage: await completion.read(-1), targetFiles: testCommand.targetFiles } }) }
  const capturedArgv = completion ? verificationArgv(completion.command) : undefined
  const executionCommand = capturedArgv?.[0] ?? testCommand.command
  const executionArgs = capturedArgv?.slice(1) ?? testCommand.args
  let spawnSpec: ResolvedTestSpawn
  try {
    spawnSpec = testCommand.shell
      ? { command: completion?.command ?? testCommand.command, args: testCommand.args, shell: true }
      : resolveTestSpawn(executionCommand, executionArgs, cwd)
  } catch (error) {
    completion?.dispose()
    const content = error instanceof Error ? error.message : String(error)
    return Promise.resolve({ content, isError: true, verification: { command: testCommand.display, kind: 'test', scope: testCommand.scope,
      status: 'blocked', blockedReason: 'invocation_failure', userGuidance: content, timestamp: startTime, countsReliable: false } })
  }
  return new Promise<ToolResult>((resolve) => {
      // Single-settlement guard: timeout, abort, close and error can all race
      // (e.g. the killed child's `close` fires after the timeout already
      // resolved). Without this the losing path still runs its async work
      // (persistRawOutput after the caller cleaned up) → unhandledRejection.
      let settled = false
      const claimSettlement = (): boolean => {
        if (settled) return false
        settled = true
        return true
      }
      const child = deps.spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        env: { ...buildExecutionEnv(cwd), ...completion?.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: spawnSpec.shell,
        // Own process group on POSIX so killProcessTree can reap the whole test
        // tree (node → tsx → workers); Windows uses taskkill /T and must not be
        // detached (breaks stdio pipes). Mirrors bash.ts/git.ts.
        detached: process.platform !== 'win32',
      })

      let stdout = ''
      let hasNonWhitespaceOutput = false
      let stderr = ''
      let omittedStdout = 0
      let omittedStderr = 0
      const logScopeNote = () => omittedStdout || omittedStderr
        ? `[run_tests 输出尾部：stdout 早期省略 ${omittedStdout} 字符；stderr 早期省略 ${omittedStderr} 字符。此前输出未保留。]`
        : ''
      const displayOutput = new DisplayOutputBuffer()

      const stdoutDecoder = deps.createDecoder()
      const stderrDecoder = deps.createDecoder()
      const uiOutput = new OutputStreamBudget({
        emit: (text) => params.onOutput?.(text),
        maxVisible: 20_000,
        budgetUnit: 'characters',
      })

      child.stdout!.on('data', (data: Buffer) => {
        if (settled) return
        const text = stdoutDecoder.write(data)
        hasNonWhitespaceOutput ||= text.trim().length > 0
        stdout += text
        displayOutput.append(text)
        uiOutput.push(text)
        if (stdout.length > 100_000) {
          omittedStdout += stdout.length - 80_000
          stdout = stdout.slice(-80_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        if (settled) return
        const text = stderrDecoder.write(data)
        stderr += text
        displayOutput.append(text)
        uiOutput.push(text)
        if (stderr.length > 100_000) {
          omittedStderr += stderr.length - 80_000
          stderr = stderr.slice(-80_000)
        }
      })

      const timer = deps.setTimeout(async () => {
        if (!claimSettlement()) return
        completion?.dispose()
        deps.kill(child, 'SIGTERM')
        deps.setTimeout(() => deps.kill(child, 'SIGKILL'), 3000)
        const stdoutTail = stdoutDecoder.end()
        const stderrTail = stderrDecoder.end()
        const finalStdout = stdout + stdoutTail
        const finalStderr = stderr + stderrTail
        displayOutput.append(stdoutTail)
        displayOutput.append(stderrTail)
        uiOutput.push(stdoutTail)
        uiOutput.push(stderrTail)
        uiOutput.flush()
        uiOutput.dispose()
        const raw = finalStdout + (finalStderr ? '\n' + finalStderr : '')
        const meta = { command: testCommand.display, exitCode: -1, durationMs: Date.now() - startTime }
        const logNote = logScopeNote()
        const rawPath = await deps.persist(params.toolUseId, logNote ? `${logNote}\n${raw}` : raw)
        resolve({
          content: `测试在 ${timeout}ms 后超时` + (logNote ? `\n${logNote}\n已保存输出尾部见 ${rawPath}` : ''),
          uiContent: buildUiOutput(raw, meta),
          displayOutput: displayOutput.text(),
          displayOutputTruncated: displayOutput.truncated,
          command: testCommand.display,
          exitCode: meta.exitCode,
          rawPath,
          isError: true,
          errorKind: 'timeout',
          verification: buildBlockedVerification(
            testCommand, startTime,
            'timeout',
            '测试超时。先分诊再重试：若超时套件覆盖你本轮新建/修改的代码（尤其是纯函数/单文件小套件），优先怀疑代码死循环/挂起而非机器慢——这是产物缺陷（RED），定位修复后重跑。仅当套件与本轮改动无关时才按环境处理：增大 timeout 参数（如 timeout=300000）、分批运行（按目录拆分）或只运行相关测试文件。',
          ),
        })
      }, timeout)

      // 用户中止（per-instance abortSignal）：协作式取消，杀掉本实例的测试进程树。
      // 因 abortSignal 源自各自 AgentLoop 的 abortController，这天然是"范围化 kill 本实例"——
      // 中止一个实例不会波及另一个实例的进程，无需全局 killAll 硬锤。
      const signal = params.abortSignal
      const onAbort = () => {
        if (!claimSettlement()) return
        deps.clearTimeout(timer)
        completion?.dispose()
        deps.kill(child, 'SIGTERM')
        deps.setTimeout(() => deps.kill(child, 'SIGKILL'), 3000)
        uiOutput.flush()
        uiOutput.dispose()
        resolve({ ...verificationBudgetStop(testCommand, startTime, 'cancelled'), uiContent: '⏹ 已中止', displayOutput: displayOutput.text(), displayOutputTruncated: true, command: testCommand.display })
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      child.on('close', async (code, _exitSignal) => {
        deps.clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        // Timeout/abort already settled — a killed child still emits `close`;
        // skip the late async work (persistRawOutput on cleaned-up temp dirs).
        if (!claimSettlement()) return
        const stdoutTail = stdoutDecoder.end()
        hasNonWhitespaceOutput ||= stdoutTail.trim().length > 0
        const stderrTail = stderrDecoder.end()
        const finalStdout = stdout + stdoutTail
        const finalStderr = stderr + stderrTail
        displayOutput.append(stdoutTail)
        displayOutput.append(stderrTail)
        uiOutput.push(stdoutTail)
        uiOutput.push(stderrTail)
        uiOutput.flush()
        uiOutput.dispose()
        const raw = finalStdout + (finalStderr ? '\n' + finalStderr : '')

        // Preserve the existing EPERM fallback. ENOTSUP is retryable only when
        // the tsx IPC server failed before running tests, not for test failures.
        const unsupportedTsxIpc = code !== 0 && !hasNonWhitespaceOutput && /\blisten ENOTSUP\b/.test(finalStderr)
          && /\bcreateIpcServer\b/.test(finalStderr) && /\.pipe\b/.test(finalStderr) && /tsx[/\\]dist[/\\]cli\.mjs\b/.test(finalStderr)
        if (testCommand.command === 'tsx' && testCommand.args[0] === '--test' && (raw.includes('EPERM') || unsupportedTsxIpc)) {
          const retryCmd = withNodeTsxLoader(cwd, testCommand)
          completion?.dispose()
          resolve(await runTestCommandIn(cwd, retryCmd, params, filter, Math.max(0, timeout - (Date.now() - startTime)), deps, repositoryRoot))
          return
        }

        const durationMs = Date.now() - startTime
        const exitCode = code ?? 1

        const parsed = parseOutput(raw, testCommand.runner)
        parsed.exitCode = exitCode
        const coverage = await completion?.read(exitCode)
        completion?.dispose()
        Object.assign(parsed, completionFacts(coverage))
        const formatted = formatOutput(parsed)
        const logNote = logScopeNote()
        const rawPath = await deps.persist(params.toolUseId, logNote ? `${logNote}\n${raw}` : raw)
        const truncated = truncateOutput(formatted, rawPath, !!logNote)
        const meta = { command: testCommand.display, exitCode, durationMs }

        // Declared commands (verify.test) are explicit user intent — exit != 0
        // means the verification FAILED, not that the framework is missing, even
        // when output parsing yields zero counts (arbitrary scripts). Spawn
        // errors (command not found) still go through the 'error' → blocked path.
        const zeroCounts = parsed.passed === 0 && parsed.failed === 0 && parsed.skipped === 0
        const invocationFailed = exitCode !== 0 && zeroCounts && testCommand.runner !== 'declared'
        const invocationGuidance = '测试运行器启动失败或崩溃。请检查测试命令是否正确，必要时用 bash 手动运行以诊断环境问题。'
        const verification: VerificationMetadata = {
          ...(coverage ? { coverage } : {}),
          ...(!coverage?.complete ? { userGuidance: (coverage?.scopeError ? coverage.scopeError + '：' : '') + '缺少完整逐文件完成证明；未知运行器或未完成执行不能补齐交付覆盖。' } : {}),
          command: testCommand.display,
          kind: 'test',
          status: exitCode === 0 ? 'passed' : invocationFailed ? 'blocked' : 'failed',
          scope: testCommand.scope,
          exitCode,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          countsReliable: parsed.countsReliable,
          durationMs,
          timestamp: startTime,
          ...completionFacts(coverage),
          ...(invocationFailed
            ? {
                failureKind: 'tool_invocation_failure' as const,
                blockedReason: 'invocation_failure' as const,
                userGuidance: invocationGuidance,
              }
            : {}),
          ...(testCommand.recommendedCommand ? { recommendedCommand: testCommand.recommendedCommand } : {}),
        }

        // Populate targetFiles for verification supersession key matching.
        // When filter is a test file pattern, extract the file path so that
        // later runs with different filter strings targeting the same file
        // can be matched via meta.targetFiles instead of command string.
        if (testCommand.scope === 'targeted' && (filter || testCommand.targetFiles?.length)) {
          const files = extractTargetFilesFromCommand(testCommand, filter)
          if (files.length > 0) {
            verification.targetFiles = files
          }
        }

        // Invocation failure (exit != 0 with zero parseable test counts) means
        // the real diagnostic — import SyntaxError, missing module, runner crash —
        // lives only in the raw output. Show its tail so the model can act on it
        // instead of staring at "0 passed, 0 failed" (session 05e1500e).
        let failureContent = truncated
        if (invocationFailed) {
          const rawTail = stripAnsi(raw).trim().slice(-1200)
          failureContent = rawTail.length > 0
            ? `${truncated}\n\n[运行器输出尾部]\n${rawTail}\n\n${invocationGuidance}`
            : `${truncated}\n\n${invocationGuidance}`
        } else if (exitCode !== 0 && zeroCounts && testCommand.runner === 'declared') {
          // Declared-command failure with unparseable counts — the diagnostic
          // lives only in the raw output, so surface its tail.
          const rawTail = stripAnsi(raw).trim().slice(-1200)
          if (rawTail.length > 0) failureContent = `${truncated}\n\n[运行器输出尾部]\n${rawTail}`
        }

        const content = exitCode === 0
            ? (parsed.passed === 0 && !parsed.duration
              ? truncated  // parse likely failed — fall back to full formatted output
              : `✓ ${parsed.passed} 通过${parsed.skipped ? `，${parsed.skipped} 跳过` : ''}${parsed.duration ? `（${parsed.duration}）` : ''}`)
            : failureContent
        resolve({
          content: content + (logNote ? `\n\n${logNote}\n已保存输出尾部见 ${rawPath}` : ''),
          uiContent: buildUiOutput(raw, meta),
          displayOutput: displayOutput.text(),
          displayOutputTruncated: displayOutput.truncated,
          command: testCommand.display,
          exitCode: typeof code === 'number' ? code : undefined,
          rawPath,
          verification,
          isError: exitCode !== 0,
        })
      })

      child.on('error', async (err) => {
        completion?.dispose()
        deps.clearTimeout(timer)
        if (!claimSettlement()) return
        uiOutput.flush()
        uiOutput.dispose()
        const rawPath = await deps.persist(params.toolUseId, err.message)
        resolve({
          content: err.message,
          uiContent: err.message,
          rawPath,
          isError: true,
          verification: buildBlockedVerification(
            testCommand, startTime,
            'invocation_failure',
            '测试进程启动失败。检查命令是否在系统 PATH 中可用，或依赖是否已安装。',
          ),
        })
      })
    })
}
