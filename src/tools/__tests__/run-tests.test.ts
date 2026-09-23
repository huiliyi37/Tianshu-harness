import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL, parseOutput } from '../run-tests.js'
import { makeTestDir, cleanupTestDir } from './_test-tmp.js'

// output-store.ts 的 rawDir() 懒加载且受 TMPDIR 控制。全量 runner 已保证
// os.tmpdir() 可写；这里保持短路径，避免 tsx 的 Unix socket 超过平台上限。
const FAKE_TMP = mkdtempSync(join(tmpdir(), 'rivet-run-tests-'))
process.env.TMPDIR = FAKE_TMP
process.env.TMP = FAKE_TMP
process.env.TEMP = FAKE_TMP

after(() => {
  rmSync(FAKE_TMP, { recursive: true, force: true })
})

function makeParams(input: Record<string, unknown>, cwd: string) {
  return {
    input,
    toolUseId: 'test-run',
    cwd,
  }
}

function setupProject(testScript: string, testFile: string): string {
  const dir = makeTestDir('run-tests-')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: { test: testScript },
  }))
  writeFileSync(join(dir, 'src', 'example.test.ts'), testFile)
  return dir
}

function setupPythonProject(options: { withTests?: boolean; withFakePytest?: boolean } = {}): string {
  const dir = makeTestDir('run-tests-python-')
  writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
  if (options.withTests) {
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'test_example.py'), 'def test_ok():\n    assert 1 + 1 == 2\n')
  }
  if (options.withFakePytest) {
    const binDir = join(dir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    // 假 pytest 用「无扩展名 shim + shebang」，这是 npm 在 POSIX 上的 .bin 形态，
    // 只有 POSIX 内核认（win32 上 npm 生成的是 .cmd，而产品的 resolveTestSpawn
    // 刻意把 pytest 当裸可执行文件直连 spawn、不走 shell）。夹具本身是 POSIX 专属，
    // 消费它的两条用例在 win32 上跳过——真实 Python 项目由 pip 安装 pytest.exe。
    const pytestPath = join(binDir, 'pytest')
    writeFileSync(pytestPath, '#!/usr/bin/env node\nconsole.log("1 passed in 0.01s")\n')
    chmodSync(pytestPath, 0o755)
  }
  return dir
}

/** 见 setupPythonProject 的注释：夹具是 POSIX-only，win32 上显式跳过并说明原因，
 *  而不是留一条永远红的用例。 */
const FAKE_PYTEST_SKIP: string | false = process.platform === 'win32'
  ? 'fake pytest 夹具是 POSIX-only 的无扩展名 .bin shim（win32 上 npm 生成 .cmd，而产品对 pytest 直连 spawn、不走 shell）'
  : false

function setupHangingProject(): string {
  const dir = makeTestDir('run-tests-hanging-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'hanging-project',
    scripts: { test: 'node -e "setInterval(() => {}, 1000)"' },
  }))
  return dir
}

describe('RUN_TESTS_TOOL', () => {
  let passingDir: string
  let failingDir: string

  before(() => {
    const passingTest = `import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('passing', () => {
  it('adds numbers', () => { assert.equal(1 + 1, 2) })
  it('concatenates strings', () => { assert.equal('a' + 'b', 'ab') })
})`

    const failingTest = `import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('mixed', () => {
  it('passes', () => { assert.equal(1, 1) })
  it('fails', () => { assert.equal(1, 2) })
})`

    passingDir = setupProject('tsx --test src/example.test.ts', passingTest)
    failingDir = setupProject('tsx --test src/example.test.ts', failingTest)
  })

  after(() => {
    rmSync(passingDir, { recursive: true, force: true })
    rmSync(failingDir, { recursive: true, force: true })
  })

  it('detects test command from package.json', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    // Success output is either a one-liner summary (when parse succeeds)
    // or a multi-line fallback (when parse can't match the test runner output)
    assert.ok(result.content.includes('通过'), 'should include passed count')
    assert.ok(!result.content.includes('失败项'), 'success should not include FAILURES')
    assert.ok(result.verification)
    assert.equal(result.verification!.status, 'passed')
    assert.equal(result.verification!.scope, 'full')
  })

  it('runs and reports success for passing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    // Phase 1 deterministic trimming: success output is either a one-liner ✓
    // or a multi-line fallback when parse fails (pre-existing limitation)
    assert.ok(result.content.includes('通过'), 'should include passed count')
    assert.ok(!result.content.includes('失败项'))
  })

  it('reports failure output for failing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, failingDir))
    assert.ok(result.content.length > 0)
    assert.ok(result.verification)
    // verification metadata is always present
    assert.ok(typeof result.verification!.passed === 'number')
    assert.ok(typeof result.verification!.failed === 'number')
  })

  it('filter restricts which tests run with targeted scope', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'src/example.test.ts' }, passingDir),
    )
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('通过'), 'should include passed count')
    assert.ok(result.verification)
    assert.equal(result.verification!.scope, 'targeted')
    assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
  })

  // 2026-07-27 实测：filter='edit.test' 被判「无法解析为 Node 测试文件」，
  // 而 src/tools/__tests__/edit.test.ts 确实存在。根因是解析用的 glob 把
  // filter 包进 `*<filter>*.test.<ext>`——filter 自带 .test 时按构造必然 0 命中。
  // 同一缺陷让工具自己文档里的例子 filter="loop.test.ts" 也解析不出来。
  for (const filter of ['example.test', 'example.test.ts', 'example']) {
    it(`resolves filter=${JSON.stringify(filter)} to the real test file`, async () => {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter }, passingDir))

      assert.equal(result.isError, false, `filter 应解析到 src/example.test.ts，实得：${result.content}`)
      assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
      assert.equal(result.verification!.scope, 'targeted')
    })
  }

  it('still blocks a filter that matches no test file', async () => {
    // 保住 fail-loud：filter 指向不存在的测试（实测 'star-genesis' 就是这种）
    // 必须受阻并给出指引，不能悄悄退化成跑全量。
    const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'no-such-suite' }, passingDir))

    assert.equal(result.isError, true)
    assert.ok(result.verification)
    assert.equal(result.verification!.scope, 'targeted')
  })

  it('runs targeted tsx tests without npx npm-command ambiguity', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'src/example.test.ts' }, passingDir),
    )

    assert.equal(result.isError, false)
    assert.equal(result.verification!.command.startsWith('npx '), false)
    assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
  })

  it('treats scripts/run-node-tests.ts projects as node-test for targeted filters', async () => {
    const dir = setupProject('tsx scripts/run-node-tests.ts', `import { it } from 'node:test'
import assert from 'node:assert/strict'
it('works', () => assert.equal(2 + 2, 4))`)
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'src/example.test.ts' }, dir))

      assert.equal(result.isError, false)
      assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
      assert.equal(result.verification!.scope, 'targeted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not default to npm test when package.json is absent', async () => {
    const dir = makeTestDir('run-tests-empty-')
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.failureKind, 'tool_invocation_failure')
      assert.equal(result.verification!.command, '(auto-detect tests)')
      assert.match(result.content, /无法自动推断测试命令|无法为该 Python 项目自动推断/)
      assert.match(result.content, /bash/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects Python projects and recommends pytest without tests directory', async () => {
    const dir = setupPythonProject()
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.recommendedCommand, 'pytest')
      assert.equal(result.verification!.command, '(auto-detect tests)')
      assert.match(result.content, /无法自动推断测试命令|无法为该 Python 项目自动推断/)
      assert.match(result.content, /pytest/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs pytest for Python projects with tests directory', { skip: FAKE_PYTEST_SKIP }, async () => {
    const dir = setupPythonProject({ withTests: true, withFakePytest: true })
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, false)
      assert.equal(result.verification!.command, 'pytest')
      assert.equal(result.verification!.status, 'passed')
      assert.equal(result.verification!.scope, 'full')
      assert.equal(result.verification!.passed, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses pytest filter directly for Python targeted runs', { skip: FAKE_PYTEST_SKIP }, async () => {
    const dir = setupPythonProject({ withTests: true, withFakePytest: true })
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'tests/test_example.py' }, dir))

      assert.equal(result.isError, false)
      assert.equal(result.verification!.command, 'pytest tests/test_example.py')
      assert.equal(result.verification!.scope, 'targeted')
      assert.equal(result.verification!.targetFiles?.[0], 'tests/test_example.py')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips shell metacharacters from the pytest filter', { skip: FAKE_PYTEST_SKIP }, async () => {
    const dir = setupPythonProject({ withTests: true, withFakePytest: true })
    try {
      // filter 是模型/用户可控串，而它既进 spawn 的 argv，也进 display 与 targetFiles。
      // pytest 当前走直连 spawn（不走 shell），但这条剥离仍是安全边界：一旦有人把它
      // 改成 shell，或用户照 display 复制去终端执行，未剥的 ` $ \ ; " ' | 就是注入面。
      // 此前没有任何测试覆盖它——删掉那行 replace 不会红，等于静默失去防护。
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'tests/`a;b|c.py' }, dir))

      const cmd = result.verification!.command
      assert.equal(cmd, 'pytest tests/abc.py')
      assert.ok(!/[`$\\;"'|]/.test(cmd), `命令串不得残留 shell 元字符：${cmd}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unknown npm runner with filter does not synthesize npm test arguments', async () => {
    const dir = makeTestDir('run-tests-unknown-filter-')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'unknown-runner',
        scripts: { test: 'custom-test-runner' },
      }))
      const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'foo' }, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.command, '(auto-detect tests)')
      assert.equal(result.verification!.recommendedCommand, 'npm test')
      assert.doesNotMatch(result.content, /npm test -- foo/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('node-test runner with unresolved filter does not fall back to npm test arguments', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({ filter: 'missing-test-name' }, passingDir))

    assert.equal(result.isError, true)
    assert.equal(result.verification!.status, 'blocked')
    assert.equal(result.verification!.command, '(auto-detect tests)')
    assert.equal(result.verification!.recommendedCommand, 'npm test')
    assert.doesNotMatch(result.content, /npm test -- missing-test-name/)
  })

  it('surfaces raw runner output when the run fails without parseable test counts', async () => {
    // Simulates a test file that dies at import time (e.g. bad import):
    // exit != 0 but the runner reports no test counts. The model must see the
    // actual error text, not just "0 passed, 0 failed" (session 05e1500e).
    const dir = makeTestDir('run-tests-invocation-fail-')
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'invocation-fail',
        scripts: { test: 'node -e "console.error(\'SyntaxError: The requested module does not provide an export named boom\'); process.exit(1)"' },
      }))
      const result = await RUN_TESTS_TOOL.execute(makeParams({}, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.blockedReason, 'invocation_failure')
      assert.match(result.content, /does not provide an export named boom/, 'raw error must be visible to the model')
      assert.match(result.content, /测试运行器启动失败或崩溃/, 'guidance must be included')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies run_tests timeout as failureKind=timeout, not as a runner crash', async () => {
    // 2026-09-22：超时曾被归为 tool_invocation_failure，下游据此告诉模型
    // 「这不是代码失败，换个命令重跑」——但超时意味着进程可能仍在跑并写盘，
    // 正确的下一步是先核实状态。见 docs/analysis/2026-09-22-session-retrospective.md §4。
    const dir = setupHangingProject()
    try {
      const result = await RUN_TESTS_TOOL.execute(makeParams({ timeout: 50 }, dir))

      assert.equal(result.isError, true)
      assert.equal(result.verification!.status, 'blocked')
      assert.equal(result.verification!.failureKind, 'timeout')
      assert.equal(result.verification!.blockedReason, 'timeout')
      assert.equal(result.verification!.command, 'npm test')
      assert.match(result.content, /超时/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requiresApproval returns false', () => {
    assert.equal(RUN_TESTS_TOOL.requiresApproval(makeParams({}, '/tmp')), false)
  })

  it('sets outer tool timeout above requested test timeout', () => {
    assert.equal(RUN_TESTS_TOOL.timeoutMs?.(makeParams({ timeout: 50 }, passingDir)), 5050)
    assert.equal(RUN_TESTS_TOOL.timeoutMs?.(makeParams({}, passingDir)), 125000)
  })

  it('isConcurrencySafe returns false', () => {
    assert.equal(RUN_TESTS_TOOL.isConcurrencySafe(), false)
  })

  it('isEnabled returns true', () => {
    assert.equal(RUN_TESTS_TOOL.isEnabled(), true)
  })

  it('preserves the legacy 20,000-character real-time UI budget and emits one marker', async () => {
    const dir = makeTestDir('run-tests-ui-budget-')
    const chunks: string[] = []
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'ui-budget',
        scripts: {
          test: `node -e "process.stdout.write('x'.repeat(25000))"`,
        },
      }))
      await RUN_TESTS_TOOL.execute({
        ...makeParams({}, dir),
        onOutput: (text: string) => chunks.push(text),
      })

      const visible = chunks.join('')
      const marker = '[stream output truncated]'
      assert.equal(visible.split(marker).length - 1, 1)
      assert.equal(visible.replace(`\n${marker}\n`, '').length, 20_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
