import {stat,glob} from 'node:fs/promises'
import {join} from 'node:path'
import {loadDeclaredVerify} from '../config/verify-config.js'
import {detectProjectFingerprint} from '../repo/project-fingerprint.js'
import type {RunnableTestCommand} from './run-tests.js'
import type {VerificationBlockedReason} from './types.js'

export interface BlockedTestCommand {
  type: 'blocked'
  display: string
  runner: string
  scope: 'full' | 'targeted'
  message: string
  recommendedCommand?: string
  blockedReason: VerificationBlockedReason
  userGuidance: string
}

export type TestCommand = RunnableTestCommand | BlockedTestCommand

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

  return { base: 'npm test', runner: 'npm' }
}

export async function buildLegacyTestCommand(cwd: string, filter?: string): Promise<TestCommand> {
  const { base, runner, recommendedCommand, hasTests } = await detectTestCommand(cwd)
  const scope = filter ? 'targeted' as const : 'full' as const

  // Declared / fingerprint commands run as full shell strings. Targeted runs
  // append the sanitized filter as a trailing token — the convention most
  // runners accept (cargo test <name>, pytest <path>, npm test -- <path>).
  if (runner === 'declared') {
    if (filter) return { type: 'blocked', display: base, runner, scope: 'targeted', message: '声明命令没有可证明的文件筛选协议；未执行测试。请提供明确的定向命令或用户选择全量。', blockedReason: 'unknown_runner', userGuidance: '不能通过拼接参数假定任意 verify.test 会限制执行范围。' }
    const full = base
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
    // #564：files=[多个 .py] 用空格拼成多个 span 传进来。按 token 分别清洗，
    // 每段用双引号包住——去元字符的旧写法遇到含空格的路径会被 pytest 当成
    // 两个参数。pytest 支持多 span 混跑（tests/a.py tests/b.py）。
    const spans = (filter ?? '').split(/\s+/).filter(Boolean)
      .map(span => span.replace(/[`$\\;"'|]/g, ''))
      .filter(Boolean)
      .map(span => (/^[\w./:@=+-]+$/.test(span) ? span : `"${span}"`))
    const args = spans.length ? spans : []
    const display = spans.length ? `pytest ${spans.join(' ')}` : 'pytest'
    return { type: 'run', command: 'pytest', args, display, runner, scope, recommendedCommand: recommendedCommand ?? 'pytest' }
  }

  if (!filter) {
    return { type: 'run', command: 'npm', args: ['test'], display: 'npm test', runner, scope: 'full' }
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

