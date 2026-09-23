import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTestSpawn, type TestSpawnDeps } from '../run-tests.js'

const CWD = 'C:\\proj'
const win = (exists: (p: string) => boolean = () => false): TestSpawnDeps => ({ isWindows: true, exists })
const nix: TestSpawnDeps = { isWindows: false, exists: () => true }

describe('resolveTestSpawn — Windows .cmd runner handling', () => {
  it('non-Windows spawns everything directly (no shell)', () => {
    for (const cmd of ['npm', 'npx', 'tsx', 'node', 'pytest']) {
      const r = resolveTestSpawn(cmd, ['--test', 'a.test.ts'], '/proj', nix)
      assert.equal(r.shell, false)
      assert.equal(r.command, cmd)
      assert.deepEqual(r.args, ['--test', 'a.test.ts'])
    }
  })

  it('Windows npm/npx run under a shell (PATH .cmd shims)', () => {
    const npm = resolveTestSpawn('npm', ['test'], CWD, win())
    assert.equal(npm.shell, true)
    assert.equal(npm.command, 'npm')
    assert.deepEqual(npm.args, ['test'])

    const npx = resolveTestSpawn('npx', ['vitest', 'run'], CWD, win())
    assert.equal(npx.shell, true)
    assert.equal(npx.command, 'npx')
    assert.deepEqual(npx.args, ['vitest', 'run'])
  })

  it('Windows tsx prefers the project-local .cmd shim under a shell', () => {
    const shim = 'C:\\proj\\node_modules\\.bin\\tsx.cmd'
    const r = resolveTestSpawn('tsx', ['--test', 'a.test.ts'], CWD, win((p) => p === shim))
    assert.equal(r.shell, true)
    assert.equal(r.command, `"${shim}"`) // quoted (path segments may contain spaces)
    assert.deepEqual(r.args, ['--test', 'a.test.ts'])
  })

  it('Windows tsx falls back to `npx tsx` when the local shim is absent', () => {
    const r = resolveTestSpawn('tsx', ['--test', 'a.test.ts'], CWD, win(() => false))
    assert.equal(r.shell, true)
    assert.equal(r.command, 'npx')
    assert.deepEqual(r.args, ['tsx', '--test', 'a.test.ts'])
  })

  it('Windows node/pytest are real executables — spawned directly', () => {
    const node = resolveTestSpawn('node', ['--test', 'a.test.ts'], CWD, win())
    assert.equal(node.shell, false)
    assert.equal(node.command, 'node')

    // pytest 直连是刻意的，不是漏改：pip/conda 装的是 Scripts\pytest.exe（distlib
    // launcher），libuv 搜 PATH 时补 .exe 命中。反过来若为了支持 npm 风格
    // node_modules/.bin/pytest.cmd 而开 shell，filter 就会进 cmd.exe 命令行——而
    // run-tests.ts 的 safeFilter 只剥 ` $ \ ; " ' |，& < > ^ ( ) 仍在，等于用罕见
    // 形态换一个注入面。真要支持那种形态，应做成「探测到 .cmd 才 shell」的窄分支。
    const pytest = resolveTestSpawn('pytest', ['-q'], CWD, win())
    assert.equal(pytest.shell, false)
    assert.equal(pytest.command, 'pytest')
    assert.deepEqual(pytest.args, ['-q']) // 直连路径不改写 args（无引号包装、无消毒）
  })

  it('Windows shell mode quotes args that contain spaces', () => {
    const r = resolveTestSpawn('npx', ['vitest', 'run', 'tests/My Feature.test.ts'], CWD, win())
    assert.equal(r.shell, true)
    assert.deepEqual(r.args, ['vitest', 'run', '"tests/My Feature.test.ts"'])
  })

  it('does not double-quote an already-quoted token', () => {
    const r = resolveTestSpawn('npx', ['"already quoted"'], CWD, win())
    assert.deepEqual(r.args, ['"already quoted"'])
  })
})
