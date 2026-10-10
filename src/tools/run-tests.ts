import { prepareCompletionCapture } from './test-completion.js'
import { verificationArgv, shellWord } from './verification-command.js'
import { applyBatchCounts, formatTestCounts } from './test-output-counts.js'
import { DisplayOutputBuffer } from './display-output-buffer.js'
import { readFile, stat, glob } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, delimiter, win32 as winPath, posix as posixPath } from 'node:path'
import type { Tool, ToolCallParams, ToolResult, VerificationMetadata, VerificationBlockedReason, VerificationSnapshotPlan } from './types.js'
import { track } from './process-tracker.js'
import { WinStreamDecoder } from '../platform.js'
import { spawnHidden } from './spawn-hidden.js'
import { killProcessTree } from './process-kill.js'
import { persistRawOutput, buildUiOutput } from './output-store.js'
import { getResolvedEnv } from './resolved-env.js'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { completionFacts } from './verification-facts.js'
import { toPosixPath } from '../path-format.js'
import { loadDeclaredVerify } from '../config/verify-config.js'
import { detectProjectFingerprint } from '../repo/project-fingerprint.js'
import { OutputStreamBudget } from './output-stream-budget.js'
import { snapshotOmissionNote, snapshotTestResult } from './run-tests-snapshot-result.js'
import { verificationTimeout, runTestsTimeoutMs, verificationBudgetStop } from './verification-budget.js'

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

/** Node's loader runs the same targeted tests without the tsx CLI's IPC server. */
function withNodeTsxLoader(cwd: string, command: RunnableTestCommand): RunnableTestCommand {
  let loader = 'tsx'
  try { loader = pathToFileURL(createRequire(join(cwd, 'package.json')).resolve('tsx')).href } catch { /* Missing project dependency remains a Node invocation error. */ }
  const args = ['--import', loader, ...command.args]
  const displayArgs = command.args.map(arg => /^[A-Za-z0-9_./=:-]+$/.test(arg) ? arg : shellWord(arg))
  return { ...command, command: process.execPath, args, display: `node --import tsx ${displayArgs.join(' ')}` }
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

  // tests/ 目录本身不是 Python 证据——dotnet 的 tests/ 里只有 *.csproj，旧判据凭
  // isDirectory() 就判 Python → pytest 直 spawn → ENOENT（verifier 无 bash 可旁路）。
  // 收紧为「tests/ 须真含 .py」；glob 出错保守 false：漏判落点是 blocked 引导，误判落点是静默 ENOENT。
  try {
    if (!(await stat(join(cwd, 'tests'))).isDirectory()) return false
    for await (const _ of glob('tests/**/*.py', { cwd })) return true
  } catch {
    return false
  }
  return false
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
  if (testScript.includes('node --test') || testScript.includes('tsx --test') || testScript.includes('node:test') || testScript.includes('run-node-tests')) {
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
      // 归一到 POSIX：glob 在 win32 上产出反斜杠，而本函数的返回值流进
      // `display` / `args` / `targetFiles` 三条对外通道——仓库约定是 POSIX
      // （见 path-format.ts 的 toPosixPath）。顺带修掉 `exact` 匹配：原先拿
      // `f.includes('/' + stem + …)` 去比反斜杠路径，win32 上恒不命中，
      // 只因 `files[0]` 兜底才看不出错。
      files.push(toPosixPath(f))
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
      return withNodeTsxLoader(cwd, { type: 'run', command: 'tsx', args: ['--test', resolvedFilter], display: `tsx --test ${resolvedFilter}`, runner, scope: 'targeted' })
    }
    return { type: 'run', command: 'node', args: ['--test', resolvedFilter], display: `node --test ${resolvedFilter}`, runner, scope: 'targeted' }
  }

  // Resolve non-file-path filter to actual test file via find
  if (runner === 'node-test' && safeFilter.length > 0) {
    const resolved = await resolveFilterToTestFile(cwd, safeFilter)
    if (resolved && (base.includes('tsx') || base.includes('run-node-tests'))) {
      return withNodeTsxLoader(cwd, { type: 'run', command: 'tsx', args: ['--test', resolved], display: `tsx --test ${resolved}`, runner, scope: 'targeted' })
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
  const base = { ...getResolvedEnv(cwd) }
  delete base.NODE_TEST_CONTEXT
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
        timeout: { type: 'integer', description: '整次验证的总预算（毫秒，默认：120000），隔离、集成与归因重试共用。' },
      },
    },
  },

  async execute(params: ToolCallParams) {
    const filter = params.input.filter as string | undefined
    const timeout = verificationTimeout(params.input.timeout)
    const startTime = Date.now()
    const remaining = () => Math.max(0, timeout - (Date.now() - startTime))
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
      const inPlace = await runTestCommandIn(params.cwd, testCommand, params, filter, remaining())

      // C3 compares live failure with the owned snapshot; the gate checks proof.
      if (inPlace.isError && !params.abortSignal?.aborted && remaining() > 0 && inPlace.verification?.failureKind !== 'timeout' && params.prepareRetrySnapshot) {
        let retryPlan: VerificationSnapshotPlan | null = null
        try { retryPlan = await params.prepareRetrySnapshot() } catch { /* degrade: keep in-place result */ }
        if (retryPlan) {
          const isolated = await runTestCommandIn(retryPlan.path, testCommand, params, filter, remaining(), defaultRunTestDeps, retryPlan.repositoryRoot)
          tagVerification(isolated, 'isolated', retryPlan.snapshotRef)
          if (!isolated.isError) {
            const comparisonId = randomUUID()
            tagVerification(inPlace, 'integration', retryPlan.snapshotRef)
            for (const phase of [isolated, inPlace]) if (phase.verification) phase.verification.comparisonId = comparisonId
            const note = `\n\n[C3 归因重试] 测试在实时工作区 FAILED，但在归属变更的隔离快照中 PASSED。两个环境结果不一致；保留失败记录并检查失败位置或隔离对照，不能仅据此认定由其他会话引入。`
            const result: ToolResult = {
              ...isolated,
              content: `[实时工作区] FAILED\n${typeof inPlace.content === 'string' ? inPlace.content.slice(0, 1500) : ''}\n\n[隔离快照] PASSED\n${isolated.content}${snapshotOmissionNote(retryPlan)}${note}`,
              isError: false,
            }
            if (inPlace.verification) result.extraVerifications = [inPlace.verification]
            return result
          }
          // Keep live failure; an incomplete retry cannot establish isolation failure.
          inPlace.content += `${snapshotOmissionNote(retryPlan)}\n\n[C3 归因重试] ${isolated.verification?.status === 'blocked' ? `未完成 — ${isolated.content}` : '在隔离快照中也 FAILED——两个环境均失败；尚不能区分归属缺陷与共同基线问题。'}`
          if (isolated.verification) inPlace.extraVerifications = [isolated.verification]
        }
      }
      return inPlace
    }

    // Record both executions; only matched complete proofs can waive integration failure.
    const comparisonId = randomUUID()
    const phaseA = await runTestCommandIn(plan.path, testCommand, params, filter, remaining(), defaultRunTestDeps, plan.repositoryRoot)
    tagVerification(phaseA, 'isolated', plan.snapshotRef)

    // 阶段 A（隔离）失败即已定论：门禁只在「隔离通过」时才认集成差异
    // （isolatedPassed）。此时再跑一遍实时工作区只会多付一整轮测试时间
    // （2026-10-06 全量实测每次多约 64s）并把失败信息翻倍。
    if (phaseA.isError) {
      return snapshotTestResult(phaseA, plan)
    }

    const phaseB = await runTestCommandIn(params.cwd, testCommand, params, filter, remaining())
    tagVerification(phaseB, 'integration', plan.snapshotRef)
    for (const phase of [phaseA, phaseB]) if (phase.verification) phase.verification.comparisonId = comparisonId
    if (phaseB.verification) phaseB.verification.isolatedPassed = !phaseA.isError && phaseA.verification?.status === 'passed'

    return snapshotTestResult(phaseA, plan, phaseB)
  },

  timeoutMs: runTestsTimeoutMs,

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
  repositoryRoot?: string,
): Promise<ToolResult> {
  const startTime = Date.now()
  if (params.abortSignal?.aborted || timeout <= 0) return Promise.resolve(verificationBudgetStop(testCommand, startTime, params.abortSignal?.aborted ? 'cancelled' : 'timeout'))
  // Normalize for the host OS: on Windows npm/npx/tsx are `.cmd` shims that need
  // a shell (else modern Node throws EINVAL); node/pytest spawn directly.
  // Declared commands (verify.test / fingerprint) are full shell strings.
  const completion = prepareCompletionCapture(testCommand.shell ? testCommand.command : [testCommand.command, ...testCommand.args].map(shellWord).join(' '), cwd, 'bash', repositoryRoot)
  const capturedArgv = completion ? verificationArgv(completion.command) : undefined
  const executionCommand = capturedArgv?.[0] ?? testCommand.command
  const executionArgs = capturedArgv?.slice(1) ?? testCommand.args
  const spawnSpec: ResolvedTestSpawn = testCommand.shell
    ? { command: completion?.command ?? testCommand.command, args: testCommand.args, shell: true }
    : resolveTestSpawn(executionCommand, executionArgs, cwd)
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
        const rawPath = await deps.persist(params.toolUseId, raw)
        resolve({
          content: `测试在 ${timeout}ms 后超时`,
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
        const coverage = completion?.read(exitCode)
        completion?.dispose()
        Object.assign(parsed, completionFacts(coverage))
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
          ...(coverage ? { coverage } : {}),
          ...(!coverage?.complete ? { userGuidance: '缺少完整逐文件完成证明；未知运行器或未完成执行不能补齐交付覆盖。' } : {}),
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
