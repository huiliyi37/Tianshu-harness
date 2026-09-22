import { readFile, stat, glob } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, delimiter, win32 as winPath } from 'node:path'
import type { Tool, ToolCallParams, ToolResult, VerificationMetadata, VerificationBlockedReason, VerificationSnapshotPlan } from './types.js'
import { track } from './process-tracker.js'
import { WinStreamDecoder } from '../platform.js'
import { spawnHidden } from './spawn-hidden.js'
import { killProcessTree } from './process-kill.js'
import { persistRawOutput, buildUiOutput } from './output-store.js'
import { getResolvedEnv } from './resolved-env.js'
import { loadDeclaredVerify } from '../config/verify-config.js'
import { detectProjectFingerprint } from '../repo/project-fingerprint.js'
import { OutputStreamBudget } from './output-stream-budget.js'

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
  recommendedCommand?: string
  /** True for declared/fingerprint commands that are full shell strings
   *  (e.g. "cargo test", "go test ./...") rather than argv arrays. */
  shell?: boolean
}

interface BlockedTestCommand {
  type: 'blocked'
  display: string
  runner: string
  scope: 'full' | 'targeted'
  message: string
  recommendedCommand?: string
  blockedReason: VerificationBlockedReason
  userGuidance: string
}

type TestCommand = RunnableTestCommand | BlockedTestCommand

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
}

/**
 * Normalize a test-runner spawn for the host OS.
 *
 * On Windows the runners `npm` / `npx` / `tsx` (and vitest/jest, which we invoke
 * via `npx`) are `.cmd` shims, not `.exe`. Modern Node refuses to spawn a
 * `.cmd`/`.bat` without `shell: true` (throws EINVAL), so spawning them directly
 * silently breaks the whole verification gate on Windows. This mirrors the
 * established pattern in `theta-check.ts::resolveTscCommand` and
 * `lsp/client.ts::runTscSubprocess`: on win32, route `.cmd` runners through a
 * shell and quote any path/arg containing spaces (e.g. `C:\Users\My Name`).
 *
 * `node` / `pytest` are real executables → spawned directly (no shell). On
 * non-Windows hosts everything is spawned directly.
 */
export function resolveTestSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  deps: TestSpawnDeps = { isWindows: process.platform === 'win32', exists: existsSync },
): ResolvedTestSpawn {
  if (!deps.isWindows) return { command, args: [...args], shell: false }

  // shell:true 让 Node 把 argv 拼成单条 cmd.exe 命令行——引号必须覆盖一切
  // 非安全字符（空白、& | < > ^ ( ) 等元字符），否则仓库可控的文件名
  // （如 a&calc.cmd）可注入 cmd。% 与内部 " 在双引号内仍危险（变量展开/
  // 断引），消毒替换为 _——fail-closed 方向；已整体带引号且内部干净的
  // token 原样通过（不双重加引）。
  const CMD_SAFE = /^[A-Za-z0-9@_+=:,./\\-]+$/
  const quote = (raw: string): string => {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') && !/[%"]/.test(raw.slice(1, -1))) {
      return raw
    }
    const s = raw.replace(/[%"]/g, '_')
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
    // Fallback: npx tsx — npx.cmd resolves tsx from node_modules under a shell.
    return { command: 'npx', args: ['tsx', ...args].map(quote), shell: true }
  }

  if (command === 'npm' || command === 'npx') {
    // Bare command name; cmd.exe resolves npm.cmd/npx.cmd from PATH under shell.
    return { command, args: args.map(quote), shell: true }
  }

  // node / pytest / other real executables: spawn directly.
  return { command, args: [...args], shell: false }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function hasPythonProjectMarker(cwd: string): Promise<boolean> {
  const markers = ['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg']
  const markerChecks = await Promise.all(markers.map(marker => pathExists(join(cwd, marker))))
  if (markerChecks.some(Boolean)) return true

  const testsPath = join(cwd, 'tests')
  try {
    const s = await stat(testsPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function pythonHasTests(cwd: string): Promise<boolean> {
  try {
    const s = await stat(join(cwd, 'tests'))
    if (!s.isDirectory()) return false
  } catch {
    return false
  }
  try {
    for await (const _ of glob('tests/test_*.py', { cwd })) return true
    for await (const _ of glob('tests/**/*_test.py', { cwd })) return true
    for await (const _ of glob('tests/**/test_*.py', { cwd })) return true
  } catch {
    return true
  }
  return false
}

async function detectTestCommand(cwd: string): Promise<{ base: string; runner: string; recommendedCommand?: string; hasTests?: boolean }> {
  // A2: project-declared verify.test (from .rivet-config.json) wins over all
  // auto-detection — this is what unblocks Rust/Go/Java projects that the
  // marker-based probes below don't recognize.
  const declared = loadDeclaredVerify(cwd).test?.trim()
  if (declared) {
    return { base: declared, runner: 'declared', recommendedCommand: declared, hasTests: true }
  }

  const pkgPath = join(cwd, 'package.json')
  if (!(await pathExists(pkgPath))) {
    if (await hasPythonProjectMarker(cwd)) {
      return {
        base: 'pytest',
        runner: 'pytest',
        recommendedCommand: 'pytest',
        hasTests: await pythonHasTests(cwd),
      }
    }
    // A0 fingerprint fallback: Rust/Go/Java have canonical test commands even
    // without a declaration (cargo test / go test always exist).
    const fp = detectProjectFingerprint(cwd)
    if (fp.testCommand && fp.language !== 'typescript' && fp.language !== 'python') {
      return { base: fp.testCommand, runner: 'declared', recommendedCommand: fp.testCommand, hasTests: fp.hasTestInfra }
    }
    return { base: '', runner: 'unknown' }
  }

  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { scripts?: { test?: string } }
  const testScript = pkg.scripts?.test ?? ''

  if (testScript.includes('vitest')) return { base: 'npx vitest run', runner: 'vitest' }
  if (testScript.includes('jest')) return { base: 'npx jest', runner: 'jest' }
  if (testScript.includes('tsx --test') || testScript.includes('node:test') || testScript.includes('run-node-tests')) {
    return { base: testScript, runner: 'node-test' }
  }

  return { base: 'npm test', runner: 'npm' }
}

function isTestFileFilter(filter: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filter)
}


/**
 * Reduce a filter to the stem used for globbing.
 *
 * The glob below wraps the filter in `*<stem>*.test.<ext>`, so a filter that
 * already carries `.test` / `.spec` can never match — `edit.test` expands to
 * `*edit.test*.test.ts`. That silently broke the most natural spellings,
 * including this tool's own documented `filter="loop.test.ts"` example
 * (2026-07-27 sessions: three blocked runs, one of which then reported
 * "exit 1, 0 passed" because the unresolved filter was handed to the runner
 * verbatim as a path).
 *
 * Directory components are dropped too: resolution only runs after the literal
 * path failed to stat, so a filter like `src/wrong-dir/edit.test.ts` should
 * still find the file by name rather than dead-end.
 */
function filterStem(filter: string): string {
  const basename = filter.split(/[/\\]/).pop() ?? filter
  return basename.replace(/\.(test|spec)(\.(ts|tsx|js|jsx|mjs|cjs))?$/, '')
}

function buildUnresolvedFilter(runner: string, safeFilter: string): BlockedTestCommand {
  return {
    type: 'blocked',
    display: '(auto-detect tests)',
    runner,
    scope: 'targeted',
    message: [
      `无法把 filter "${safeFilter}" 解析为测试文件。`,
      'filter 用于定位测试文件，不是测试名——它按 src/**/*<filter>*.test.* 匹配。',
      `已尝试的词干："${filterStem(safeFilter)}"。`,
      '改用文件名（如 loop.test.ts）、相对路径（src/agent/__tests__/loop.test.ts）',
      '或去掉 filter 跑全量；要按测试名筛选请用 bash 执行项目自身的测试命令。',
    ].join('\n'),
    recommendedCommand: 'npm test',
    blockedReason: 'filter_unresolved',
    userGuidance: `无法将 "${safeFilter}" 解析为测试文件。请使用文件名或相对路径（如 src/__tests__/xxx.test.ts），或运行无过滤的 run_tests() 跑全量测试。`,
  }
}

/**
 * Resolve a non-file-path filter string to an actual test file path.
 * Uses Node.js glob (available in Node 22+) for cross-platform file matching.
 * Returns null if no match is found.
 */
async function resolveFilterToTestFile(cwd: string, filter: string): Promise<string | null> {
  const stem = filterStem(filter)
  if (stem.length === 0) return null
  try {
    const files: string[] = []
    for await (const f of glob(`src/**/*${stem}*.test.{ts,tsx,js,jsx,mjs,cjs}`, { cwd })) {
      files.push(f)
    }
    if (files.length === 0) return null
    const exact = files.find(f => f.includes('/' + stem + '.test.') || f.includes('/' + stem))
    return exact ?? files[0] ?? null
  } catch {
    return null
  }
}

async function buildTestCommand(cwd: string, filter?: string): Promise<TestCommand> {
  const { base, runner, recommendedCommand, hasTests } = await detectTestCommand(cwd)
  const scope = filter ? 'targeted' as const : 'full' as const

  // Declared / fingerprint commands run as full shell strings. Targeted runs
  // append the sanitized filter as a trailing token — the convention most
  // runners accept (cargo test <name>, pytest <path>, npm test -- <path>).
  if (runner === 'declared') {
    const safeFilter = filter?.replace(/[`$\\;"'|&<>]/g, '').trim()
    const full = safeFilter ? `${base} ${safeFilter}` : base
    return {
      type: 'run',
      command: full,
      args: [],
      display: full,
      runner,
      scope,
      shell: true,
      recommendedCommand: recommendedCommand ?? base,
    }
  }

  if (runner === 'unknown') {
    return {
      type: 'blocked',
      display: '(auto-detect tests)',
      runner,
      scope,
      message: [
        '无法自动推断测试命令。',
        '未找到 package.json 或受支持的测试运行器标记。',
        '请用 bash 运行项目专用的验证命令（例如 Python 脚本、pytest 调用或输出检查）。',
      ].join('\n'),
      recommendedCommand: undefined,
      blockedReason: 'no_test_framework',
      userGuidance: '项目缺少可自动检测的测试命令。运行 /init 从项目指纹生成 verify 声明，或在 .rivet-config.json 手动声明 {"verify": {"test": "<命令>"}}——声明后 run_tests 直接使用它。也可以绕过自动检测，直接用 bash 运行验证命令。',
    }
  }

  if (runner === 'pytest') {
    if (!filter && hasTests === false) {
      return {
        type: 'blocked',
        display: '(auto-detect tests)',
        runner,
        scope: 'full',
        message: [
          '无法为该 Python 项目自动推断测试命令，因为 tests/ 下未找到测试。',
          '存在 Python 测试时，推荐使用 pytest。',
          '若这是非测试的输出/绘图任务，请用 bash 运行具体的 Python 脚本或检查生成输出。',
        ].join('\n'),
        recommendedCommand: recommendedCommand ?? 'pytest',
        blockedReason: 'no_tests_found',
        userGuidance: 'Python 项目检测到，但 tests/ 目录下没有 test_*.py 或 *_test.py 文件。如果项目不需要自动化测试，用 bash 直接运行脚本验证；如果需要测试，在 tests/ 下创建 pytest 用例。',
      }
    }
    const safeFilter = filter?.replace(/[`$\\;"'|]/g, '')
    const args = safeFilter ? [safeFilter] : []
    const display = safeFilter ? `pytest ${safeFilter}` : 'pytest'
    return { type: 'run', command: 'pytest', args, display, runner, scope, recommendedCommand: recommendedCommand ?? 'pytest' }
  }

  if (!filter) {
    return { type: 'run', command: 'npm', args: ['test'], display: 'npm test', runner, scope: 'full' }
  }

  const safeFilter = filter.replace(/[`$\\;"'|]/g, '')
  if (runner === 'node-test' && isTestFileFilter(safeFilter)) {
    // Resolve relative test file names to actual paths.
    // run_tests(filter="compaction-controller.test.ts") sends the bare filename
    // to tsx, which fails because the file is in src/agent/__tests__/.
    // glob for the file first; if the filter IS a valid path, use it directly.
    let resolvedFilter: string | null = null
    try {
      const s = await stat(join(cwd, safeFilter))
      resolvedFilter = s.isFile() ? safeFilter : await resolveFilterToTestFile(cwd, safeFilter)
    } catch {
      // File doesn't exist at the direct path — try glob resolution
      resolvedFilter = await resolveFilterToTestFile(cwd, safeFilter)
    }
    // Fail loud rather than handing an unlocated path to the runner: that
    // yields "exit 1 / 0 passed, 0 failed", which reads as a test failure
    // instead of a bad filter and sends the model debugging the wrong thing.
    if (resolvedFilter === null) {
      return buildUnresolvedFilter(runner, safeFilter)
    }
    if (base.includes('tsx') || base.includes('run-node-tests')) {
      return { type: 'run', command: 'tsx', args: ['--test', resolvedFilter], display: `tsx --test ${resolvedFilter}`, runner, scope: 'targeted' }
    }
    return { type: 'run', command: 'node', args: ['--test', resolvedFilter], display: `node --test ${resolvedFilter}`, runner, scope: 'targeted' }
  }

  // Resolve non-file-path filter to actual test file via find
  if (runner === 'node-test' && safeFilter.length > 0) {
    const resolved = await resolveFilterToTestFile(cwd, safeFilter)
    if (resolved && (base.includes('tsx') || base.includes('run-node-tests'))) {
      return { type: 'run', command: 'tsx', args: ['--test', resolved], display: `tsx --test ${resolved}`, runner, scope: 'targeted' }
    }
    if (resolved) {
      return { type: 'run', command: 'node', args: ['--test', resolved], display: `node --test ${resolved}`, runner, scope: 'targeted' }
    }
    return buildUnresolvedFilter(runner, safeFilter)
  }

  if (runner === 'vitest') {
    return { type: 'run', command: 'npx', args: ['vitest', 'run', safeFilter], display: `npx vitest run ${safeFilter}`, runner, scope: 'targeted' }
  }

  if (runner === 'jest') {
    return { type: 'run', command: 'npx', args: ['jest', '--testPathPattern', safeFilter], display: `npx jest --testPathPattern ${safeFilter}`, runner, scope: 'targeted' }
  }

  return {
    type: 'blocked',
    display: '(auto-detect tests)',
    runner,
    scope: 'targeted',
    message: [
      '无法为该项目推断安全的定向测试命令。',
      '已配置的 npm test 运行器未被识别为 node:test、vitest 或 jest，因此 run_tests(filter=...) 不会合成 npm test 参数。',
      '请用 bash 运行精确的定向验证命令，或不带 filter 运行 run_tests() 以执行完整 npm test 脚本。',
    ].join('\n'),
    recommendedCommand: 'npm test',
    blockedReason: 'unknown_runner',
    userGuidance: `npm test 脚本使用了不被自动识别的测试运行器。请用 bash 直接运行精确的测试命令，或不带 filter 运行 run_tests() 执行完整 npm test。`,
  }
}

interface ParsedResult {
  exitCode: number
  passed: number
  failed: number
  skipped: number
  duration: string
  failures: Array<{ name: string; error: string }>
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
    const totalMatch = clean.match(/[ℹ#]\s+tests\s+(\d+)/)
    const failMatch = clean.match(/[ℹ#]\s+fail\s+(\d+)/)
    const skipMatch = clean.match(/[ℹ#]\s+skip\s+(\d+)/)
    const passMatch = clean.match(/[ℹ#]\s+pass\s+(\d+)/)
    const durMatch = clean.match(/[ℹ#]\s+duration_ms\s+([\d.]+)/)
    const total = asNum(totalMatch?.[1])
    const fails = asNum(failMatch?.[1])
    const skips = asNum(skipMatch?.[1])
    const passes = asNum(passMatch?.[1])
    if (total > 0) {
      result.passed = passes > 0 ? passes : total - fails - skips
      result.failed = fails
      result.skipped = skips
    }
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

  return result
}

function formatOutput(result: ParsedResult): string {
  const lines: string[] = []
  lines.push(`退出码：${result.exitCode}`)
  lines.push(`${result.passed} 通过，${result.failed} 失败，${result.skipped} 跳过`)

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
  const testFilePattern = /([^\s"']+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)|[^\s"']+\.py)/g
  const allMatches = [
    ...testCommand.args.join(' ').matchAll(testFilePattern),
    ...testCommand.display.matchAll(testFilePattern),
    ...(filter?.matchAll(testFilePattern) ?? []),
  ]
  return [...new Set(allMatches.map(m => m[1]!))]
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT) return output
  const head = output.slice(0, HEAD_CHARS)
  const tail = output.slice(-TAIL_CHARS)
  const omitted = output.length - HEAD_CHARS - TAIL_CHARS
  return `${head}\n...（已省略 ${omitted} 字符）...\n${tail}`
}

function buildExecutionEnv(cwd: string): NodeJS.ProcessEnv {
  const localBin = join(cwd, 'node_modules', '.bin')
  const repoBin = join(process.cwd(), 'node_modules', '.bin')
  // Base off the resolved env so test runners that shell out to toolchain
  // commands (mvn/gradle/java) find them under a GUI-launched minimal PATH.
  const base = getResolvedEnv(cwd)
  // PATH may be spelled `Path` on Windows — look it up case-insensitively.
  const pathKey = Object.keys(base).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const currentPath = base[pathKey] ?? ''
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
- filter 用于**定位测试文件**，不是筛选测试名——按 src/**/*<filter>*.test.* 匹配
- 自动检测 Node.js 测试脚本和 Python pytest 项目
- 无法推断出安全的 runner 时，返回受阻的验证结果，并指引改用 bash
- 报告：exit code、失败的测试、错误详情、耗时

### filter 怎么写
文件名和相对路径都可以，带不带 .test/.spec 后缀都能解析：
好：run_tests() —— 运行全部测试
好：run_tests(filter="loop.test.ts") —— 按文件名定位
好：run_tests(filter="loop") —— 词干也可以，命中多个时取最贴近的
好：run_tests(filter="src/agent/__tests__/loop.test.ts") —— 相对路径最精确
好：run_tests(filter="tests/test_example.py") —— 一个 Python pytest 文件
坏：run_tests(filter="handles empty input") —— 这是测试名，定位不到文件会受阻
坏：run_tests(filter="star-genesis") —— 源文件名而无同名测试文件时同样受阻

要按测试名筛选，用 bash 执行项目自身的测试命令（如 --test-name-pattern）。
不确定测试文件叫什么，先用 glob 找 **/*<关键词>*.test.ts。`,
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '测试文件名、词干或相对路径（不是测试名）。留空跑全量。' },
        timeout: { type: 'integer', description: '超时时间（毫秒，默认：120000）' },
      },
    },
  },

  async execute(params: ToolCallParams) {
    const filter = params.input.filter as string | undefined
    const timeout = (params.input.timeout as number) ?? 120_000
    const startTime = Date.now()
    const testCommand = await buildTestCommand(params.cwd, filter)

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

    const plan = params.verificationSnapshot
    if (!plan) {
      // Default in-place verification — unchanged single-phase path.
      const inPlace = await runTestCommandIn(params.cwd, testCommand, params, filter, timeout)

      // C3: failure-attribution retry. Only wired by the pipeline when live
      // pollution signals exist (peer sessions / workspace mutations). A
      // snapshot-pass after a live-fail means the failure came from the
      // polluted working tree, not the owned changes.
      if (inPlace.isError && params.prepareRetrySnapshot) {
        let retryPlan: VerificationSnapshotPlan | null = null
        try { retryPlan = await params.prepareRetrySnapshot() } catch { /* degrade: keep in-place result */ }
        if (retryPlan) {
          const isolated = await runTestCommandIn(retryPlan.path, testCommand, params, filter, timeout)
          tagVerification(isolated, 'isolated', retryPlan.snapshotRef)
          if (!isolated.isError) {
            const note = `\n\n[C3 归因重试] 测试在实时工作区 FAILED，但在归属变更的隔离快照中 PASSED。失败来自工作区污染（并行会话的 stash/reset 或外部编辑），不是你的代码。不要为这次失败去“修”代码——与并行会话协调，或等待工作区稳定后再重新验证。`
            const result: ToolResult = {
              ...isolated,
              content: `[实时工作区] FAILED\n${typeof inPlace.content === 'string' ? inPlace.content.slice(0, 1500) : ''}\n\n[隔离快照] PASSED\n${isolated.content}${note}`,
              isError: false,
            }
            if (inPlace.verification) result.extraVerifications = [inPlace.verification]
            return result
          }
          // Failed in isolation too → genuinely broken code; report the
          // in-place result with the attribution confirmed.
          inPlace.content += `\n\n[C3 归因重试] 在隔离快照中也 FAILED——失败在你的归属变更中，不是工作区污染。`
          if (isolated.verification) inPlace.extraVerifications = [isolated.verification]
        }
      }
      return inPlace
    }

    // VSW two-phase: Phase A in the isolated snapshot (blocking gate), Phase B in
    // the live tree against current HEAD (advisory integration check). Phase A's
    // result is primary; Phase B rides along as an extra verification so the gate
    // can flag integration_conflict without blocking delivery.
    const phaseA = await runTestCommandIn(plan.path, testCommand, params, filter, timeout)
    tagVerification(phaseA, 'isolated', plan.snapshotRef)

    const phaseB = await runTestCommandIn(params.cwd, testCommand, params, filter, timeout)
    tagVerification(phaseB, 'integration', plan.snapshotRef)

    const phaseBNote = phaseB.isError
      ? `\n\n[阶段 B · 当前 HEAD 集成] FAILED — 归属变更在隔离环境已通过；这是并发变更冲突。合并前请 rebase/协调。交付不会因此被阻断。`
      : `\n\n[阶段 B · 当前 HEAD 集成] 已通过。`
    const result: ToolResult = {
      ...phaseA,
      content: `[阶段 A · 隔离快照] ${phaseA.content}${phaseBNote}`,
      // Phase A governs isError (the blocking gate); Phase B is advisory only.
      isError: phaseA.isError,
    }
    if (phaseB.verification) result.extraVerifications = [phaseB.verification]
    return result
  },

  timeoutMs(params?: ToolCallParams): number {
    const requested = params?.input.timeout
    const testTimeout = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : 120_000
    // Keep the outer tool-pipeline timeout slightly above run_tests' own
    // timer so timeout results can return structured VerificationMetadata
    // instead of being converted into an untracked pipeline exception.
    return testTimeout + 5_000
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function tagVerification(result: ToolResult, phase: 'isolated' | 'integration', snapshotRef: string): void {
  if (!result.verification) return
  result.verification = { ...result.verification, verificationPhase: phase, snapshotRef }
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
}

const defaultRunTestDeps: RunTestCommandDeps = {
  spawn: (command, args, options) => track(spawnHidden(command, [...args], options)),
  kill: (child, signal) => killProcessTree(child as ReturnType<typeof spawnHidden>, signal),
  persist: persistRawOutput,
  setTimeout: (callback, ms) => setTimeout(() => { void callback() }, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  createDecoder: () => new WinStreamDecoder(),
}

export function runTestCommandIn(
  cwd: string,
  testCommand: RunnableTestCommand,
  params: ToolCallParams,
  filter: string | undefined,
  timeout: number,
  deps: RunTestCommandDeps = defaultRunTestDeps,
): Promise<ToolResult> {
  const startTime = Date.now()
  // Normalize for the host OS: on Windows npm/npx/tsx are `.cmd` shims that need
  // a shell (else modern Node throws EINVAL); node/pytest spawn directly.
  // Declared commands (verify.test / fingerprint) are full shell strings.
  const spawnSpec: ResolvedTestSpawn = testCommand.shell
    ? { command: testCommand.command, args: testCommand.args, shell: true }
    : resolveTestSpawn(testCommand.command, testCommand.args, cwd)
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
        env: buildExecutionEnv(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: spawnSpec.shell,
        // Own process group on POSIX so killProcessTree can reap the whole test
        // tree (node → tsx → workers); Windows uses taskkill /T and must not be
        // detached (breaks stdio pipes). Mirrors bash.ts/git.ts.
        detached: process.platform !== 'win32',
      })

      let stdout = ''
      let stderr = ''

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
        stdout += text
        uiOutput.push(text)
        if (stdout.length > 100_000) {
          stdout = stdout.slice(-80_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        if (settled) return
        const text = stderrDecoder.write(data)
        stderr += text
        uiOutput.push(text)
        if (stderr.length > 100_000) {
          stderr = stderr.slice(-80_000)
        }
      })

      const timer = deps.setTimeout(async () => {
        if (!claimSettlement()) return
        deps.kill(child, 'SIGTERM')
        deps.setTimeout(() => deps.kill(child, 'SIGKILL'), 3000)
        const stdoutTail = stdoutDecoder.end()
        const stderrTail = stderrDecoder.end()
        const finalStdout = stdout + stdoutTail
        const finalStderr = stderr + stderrTail
        uiOutput.push(stdoutTail)
        uiOutput.push(stderrTail)
        uiOutput.flush()
        uiOutput.dispose()
        const raw = finalStdout + (finalStderr ? '\n' + finalStderr : '')
        const meta = { command: testCommand.display, exitCode: -1, durationMs: Date.now() - startTime }
        const rawPath = await deps.persist(params.toolUseId, raw)
        resolve({
          content: `测试在 ${timeout}ms 后超时`,
          uiContent: buildUiOutput(raw, meta),
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
        deps.kill(child, 'SIGTERM')
        deps.setTimeout(() => deps.kill(child, 'SIGKILL'), 3000)
        uiOutput.flush()
        uiOutput.dispose()
        resolve({ content: '测试已被用户中止。', uiContent: '⏹ 已中止', isError: false })
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
        const stderrTail = stderrDecoder.end()
        const finalStdout = stdout + stdoutTail
        const finalStderr = stderr + stderrTail
        uiOutput.push(stdoutTail)
        uiOutput.push(stderrTail)
        uiOutput.flush()
        uiOutput.dispose()
        const raw = finalStdout + (finalStderr ? '\n' + finalStderr : '')

        // EPERM auto-degradation: tsx IPC pipe fails in sandboxed environments.
        // When stderr contains EPERM and the runner is tsx, retry once with
        // node --import tsx (equivalent semantics, no IPC pipe).
        if (testCommand.command === 'tsx' && raw.includes('EPERM') && testCommand.args[0] === '--test') {
          const args = ['--import', 'tsx', '--test', ...testCommand.args.slice(1)]
          const retryCmd: RunnableTestCommand = { ...testCommand, command: 'node', args, display: `node --import tsx --test ${testCommand.args.slice(1).join(' ')}` }
          resolve(await runTestCommandIn(cwd, retryCmd, params, filter, timeout, deps))
          return
        }

        const durationMs = Date.now() - startTime
        const exitCode = code ?? 1

        const parsed = parseOutput(raw, testCommand.runner)
        parsed.exitCode = exitCode
        const formatted = formatOutput(parsed)
        const truncated = truncateOutput(formatted)
        const rawPath = await deps.persist(params.toolUseId, raw)
        const meta = { command: testCommand.display, exitCode, durationMs }

        // Declared commands (verify.test) are explicit user intent — exit != 0
        // means the verification FAILED, not that the framework is missing, even
        // when output parsing yields zero counts (arbitrary scripts). Spawn
        // errors (command not found) still go through the 'error' → blocked path.
        const zeroCounts = parsed.passed === 0 && parsed.failed === 0 && parsed.skipped === 0
        const invocationFailed = exitCode !== 0 && zeroCounts && testCommand.runner !== 'declared'
        const invocationGuidance = '测试运行器启动失败或崩溃。请检查测试命令是否正确，必要时用 bash 手动运行以诊断环境问题。'
        const verification: VerificationMetadata = {
          command: testCommand.display,
          status: exitCode === 0 ? 'passed' : invocationFailed ? 'blocked' : 'failed',
          scope: testCommand.scope,
          exitCode,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          durationMs,
          timestamp: startTime,
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
        if (testCommand.scope === 'targeted' && filter) {
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

        resolve({
          content: exitCode === 0
            ? (parsed.passed === 0 && !parsed.duration
              ? truncated  // parse likely failed — fall back to full formatted output
              : `✓ ${parsed.passed} 通过${parsed.skipped ? `，${parsed.skipped} 跳过` : ''}${parsed.duration ? `（${parsed.duration}）` : ''}`)
            : failureContent,
          uiContent: buildUiOutput(raw, meta),
          rawPath,
          verification,
          isError: exitCode !== 0,
        })
      })

      child.on('error', async (err) => {
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
