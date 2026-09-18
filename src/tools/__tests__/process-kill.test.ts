import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { killProcessTree, taskkillArgs, jobLaunchArgv, spawnShell, findJobLauncher, resolveJobLauncher, invalidateJobLauncherCache } from '../process-kill.js'

// 注：这里显式传 platform，让两个分支在任意 CI 主机上都能被测到。
// （此前该文件隐式依赖宿主平台：Windows 上注入的 kill spy 永远走不到，两个用例静默变红。）
describe('killProcessTree (unix)', () => {
  it('kills the process group by negative pid', () => {
    const calls: Array<[number, NodeJS.Signals]> = []
    const child = { pid: 1234, kill: () => assert.fail('single process fallback should not be used') }

    killProcessTree(child, 'SIGTERM', (pid, signal) => { calls.push([pid, signal]) }, 'linux')

    assert.deepEqual(calls, [[-1234, 'SIGTERM']])
  })

  it('falls back to single process kill when process group kill fails', () => {
    const signals: NodeJS.Signals[] = []
    const child = { pid: 1234, kill: (signal: NodeJS.Signals) => { signals.push(signal); return true } }

    killProcessTree(child, 'SIGKILL', () => { throw new Error('missing process group') }, 'linux')

    assert.deepEqual(signals, ['SIGKILL'])
  })
})

describe('killProcessTree (win32)', () => {
  it('always passes /F — the non-/F "graceful" pass is a no-op for console children (issue #144)', () => {
    const seen: string[][] = []
    const child = { pid: 1234, kill: () => assert.fail('POSIX signals do not apply on Windows') }

    killProcessTree(child, 'SIGTERM', () => assert.fail('kill() must not be used on Windows'), 'win32', (args) => { seen.push(args) })

    assert.deepEqual(seen, [['/F', '/T', '/PID', '1234']])
  })

  it('uses the same force args for SIGKILL', () => {
    const seen: string[][] = []
    const child = { pid: 4321, kill: () => assert.fail('POSIX signals do not apply on Windows') }

    killProcessTree(child, 'SIGKILL', () => assert.fail('kill() must not be used on Windows'), 'win32', (args) => { seen.push(args) })

    assert.deepEqual(seen, [['/F', '/T', '/PID', '4321']])
  })

  it('does nothing when the child has no pid', () => {
    const seen: string[][] = []
    const child = { pid: undefined, kill: () => assert.fail('no pid, nothing to kill') }

    killProcessTree(child, 'SIGTERM', () => assert.fail('kill() must not be used on Windows'), 'win32', (args) => { seen.push(args) })

    assert.deepEqual(seen, [])
  })
})

describe('taskkillArgs', () => {
  it('returns force-terminate args (regression guard: do not reintroduce a non-/F graceful pass)', () => {
    assert.deepEqual(taskkillArgs(7), ['/F', '/T', '/PID', '7'])
  })
})

// 作业持有者接线（issue #144 本体）。注入 launcher/spawnFn，让两条分支在任意 CI 主机上都能断言。
describe('spawnShell (job launcher wiring)', () => {
  const shell = { cmd: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] }
  const record = () => {
    const calls: Array<{ file: string; args: string[]; options: unknown }> = []
    const spawnFn = ((file: string, args: string[], options: unknown) => {
      calls.push({ file, args: args ?? [], options })
      return { pid: 1, kill: () => true } as unknown as ReturnType<typeof spawnShell>
    }) as unknown as Parameters<typeof spawnShell>[4]
    return { calls, spawnFn }
  }

  it('falls back to spawning the shell directly when no launcher is available (fail-open)', () => {
    const { calls, spawnFn } = record()
    spawnShell(shell, 'echo hi', { cwd: '/tmp' }, null, spawnFn)

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.file, shell.cmd)
    assert.deepEqual(call.args, ['-c', 'echo hi'])
    assert.deepEqual(call.options, { cwd: '/tmp' })
  })

  it('routes through the launcher, passing cwd and parent pid before the real command', () => {
    const { calls, spawnFn } = record()
    spawnShell(shell, 'echo hi', { cwd: '/tmp/work' }, 'C:\\tools\\job-launch.exe', spawnFn)

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.file, 'C:\\tools\\job-launch.exe')
    assert.deepEqual(call.args, [
      '--cwd', '/tmp/work',
      '--parent-pid', String(process.pid),
      shell.cmd, '-c', 'echo hi',
    ])
    // 选项原样透传：stdio / detached / windowsHide 语义不变（bash 直接继承这些句柄）
    assert.deepEqual(call.options, { cwd: '/tmp/work' })
  })

  it('uses process.cwd() for --cwd when the spawn options carry no cwd', () => {
    const { calls, spawnFn } = record()
    spawnShell(shell, 'echo hi', {}, 'launcher.exe', spawnFn)

    const call = calls[0]
    assert.ok(call)
    assert.equal(call.args[1], process.cwd())
  })
})

describe('jobLaunchArgv', () => {
  it('keeps the command as one argv element (no shell re-quoting on our side)', () => {
    const argv = jobLaunchArgv({ cmd: 'bash', args: ['-c'] }, 'echo "a b" | wc -l', '/tmp', 4242)
    assert.deepEqual(argv, ['--cwd', '/tmp', '--parent-pid', '4242', 'bash', '-c', 'echo "a b" | wc -l'])
  })
})

// issue #144 上游移植补的缺口：`resolveJobLauncher` 原用固定 `../../`，只在源码布局
// （`src/tools/*.ts`）恰好命中仓根；产物态下 `dist/main.js` / `dist/cli/entry.js` 的
// `import.meta.url` 都在 `dist/` 下，固定两级会跳出安装根 → 生产包永远找不到 helper，
// 而 fail-open 让这个缺口在源码态下完全看不见。以下用例把四种布局锁死。
//
// 用注入的假文件系统：真在磁盘上造一棵安装树是不可能的，而 `findJobLauncher` 的 `exists`
// 参数正是为此留的接缝（与 killProcessTree 的 platform、spawnShell 的 launcher 同风格）。
describe('findJobLauncher (job launcher path resolution)', () => {
  const fakeFs = (paths: string[]) => {
    const present = new Set(paths)
    return (candidate: string) => present.has(candidate)
  }
  const ROOT = join('C:', 'app') // 只是个字符串前缀，随宿主平台生成分隔符，不必真的存在
  const EXE = 'job-launch.exe'

  it('源码态：从 src/tools 起跳 2 跳到 <root>/native/', () => {
    const exists = fakeFs([join(ROOT, 'native', EXE)])
    assert.equal(
      findJobLauncher(join(ROOT, 'src', 'tools'), exists),
      join(ROOT, 'native', EXE),
    )
  })

  it('产物态 dist 根：0 跳命中 <root>/dist/native/', () => {
    const exists = fakeFs([join(ROOT, 'dist', 'native', EXE)])
    assert.equal(
      findJobLauncher(join(ROOT, 'dist'), exists),
      join(ROOT, 'dist', 'native', EXE),
    )
  })

  it('产物态 dist/cli 子目录：1 跳命中 <root>/dist/native/（固定 ../../ 会跳出安装根）', () => {
    const exists = fakeFs([join(ROOT, 'dist', 'native', EXE)])
    assert.equal(
      findJobLauncher(join(ROOT, 'dist', 'cli'), exists),
      join(ROOT, 'dist', 'native', EXE),
    )
  })

  it('同级优先：native/ 先于 dist/native/', () => {
    const both = [join(ROOT, 'native', EXE), join(ROOT, 'dist', 'native', EXE)]
    const exists = fakeFs(both)
    // 同一级里两个都在 → 取 native/
    assert.equal(findJobLauncher(ROOT, exists), join(ROOT, 'native', EXE))
    // 从 dist 起跳时，该级只有 dist/native/ → 取它（不越级去够 <root>/native/）
    assert.equal(findJobLauncher(join(ROOT, 'dist'), exists), join(ROOT, 'dist', 'native', EXE))
  })

  it('上溯深度封顶 5 跳，第 6 跳够不到', () => {
    const exists = fakeFs([join(ROOT, 'native', EXE)])
    // 距 ROOT 恰好 5 跳 → 够得到
    assert.equal(
      findJobLauncher(join(ROOT, 'a', 'b', 'c', 'd', 'e'), exists),
      join(ROOT, 'native', EXE),
    )
    // 距 ROOT 恰好 6 跳 → 够不到（封顶生效，避免走到安装根之外撞无关 native/）
    assert.equal(findJobLauncher(join(ROOT, 'a', 'b', 'c', 'd', 'e', 'f'), exists), null)
  })

  it('均不存在 → null（调用方 fail-open 回落到现状 spawn）', () => {
    assert.equal(findJobLauncher(join(ROOT, 'src', 'tools'), fakeFs([])), null)
  })
})

// per-spawn 成本：实测本机 resolveJobLauncher() 单次 ~1.4ms（12 次 existsSync；Windows 上
// existsSync 实测 ~346µs/次），而一次 spawn ~29ms —— 这是每个 bash 命令都要付的常数开销。
// 改为进程级 memo + 显式失效（与 prompt/block-policy 的 invalidatePromptBlocks 同 idiom）。
describe('resolveJobLauncher cache (per-spawn probe cost)', () => {
  const fakeFs = (paths: string[]) => {
    const present = new Set(paths)
    const fn = (candidate: string) => { fn.calls++; return present.has(candidate) }
    fn.calls = 0
    return fn
  }
  const ROOT = join('C:', 'app')
  const EXE_NAME = 'job-launch.exe'
  const EXE = join(ROOT, 'native', EXE_NAME)

  afterEach(() => { invalidateJobLauncherCache() })

  it('memoizes: 同一 here 第二次调用不再探测文件系统', () => {
    const exists = fakeFs([EXE])
    const deps = { here: join(ROOT, 'src', 'tools'), exists, platform: 'win32' as const }

    assert.equal(resolveJobLauncher(deps), EXE)
    const afterFirst = exists.calls
    assert.ok(afterFirst > 0, '首次必须真的探测过')

    assert.equal(resolveJobLauncher(deps), EXE)
    assert.equal(exists.calls, afterFirst, '第二次不该再探测（这正是省下的 per-spawn 成本）')
  })

  it('invalidate 之后重新探测（热装 helper 的逃生口）', () => {
    const exists = fakeFs([])
    const deps = { here: join(ROOT, 'src', 'tools'), exists, platform: 'win32' as const }

    assert.equal(resolveJobLauncher(deps), null)
    // 模拟「运行中把 helper 编译出来了」：磁盘变了，缓存仍是 null
    exists(EXE) // 计数用途，忽略
    const before = exists.calls
    assert.equal(resolveJobLauncher(deps), null, '未 invalidate 前仍取缓存')

    invalidateJobLauncherCache()
    const exists2 = fakeFs([EXE])
    assert.equal(
      resolveJobLauncher({ ...deps, exists: exists2 }),
      EXE,
      'invalidate 后必须重新探测并看到新文件',
    )
    assert.ok(exists2.calls > 0)
    assert.ok(before > 0)
  })

  it('不同 here 各占一条缓存，互不污染', () => {
    // 两个起点各自能命中的位置必须不同，否则分不出「取到了谁的缓存」：
    //   hereA = <root>/a/sub  → 上溯 1 跳到 <root>/a/native/…
    //   hereB = <root>/b      → 0 跳命中  <root>/b/native/…
    const hereA = join(ROOT, 'a', 'sub')
    const hereB = join(ROOT, 'b')
    const exeA = join(ROOT, 'a', 'native', EXE_NAME)
    const exeB = join(ROOT, 'b', 'native', EXE_NAME)

    assert.equal(resolveJobLauncher({ here: hereA, exists: fakeFs([exeA]), platform: 'win32' }), exeA)
    assert.equal(resolveJobLauncher({ here: hereB, exists: fakeFs([exeB]), platform: 'win32' }), exeB)
    // 回到第一条，并故意换一个「什么都不认识」的 exists：命中缓存才可能仍拿到 exeA。
    // 若缓存被第二条覆盖成单槽，这里会变成 exeB（或 null）。
    assert.equal(
      resolveJobLauncher({ here: hereA, exists: fakeFs([]), platform: 'win32' }),
      exeA,
      'A 的缓存不该被 B 冲掉',
    )
  })

  it('环境覆盖永远实时读，不被位置缓存挡住', () => {
    // 覆盖分支走的是**真实** existsSync（那是文档化的逃生口，不该被注入替换），
    // 所以这里必须用一个真实存在的文件，不能用假的路径字符串。
    const dir = mkdtempSync(join(tmpdir(), 'rivet-launcher-'))
    const realExe = join(dir, 'job-launch.exe')
    writeFileSync(realExe, '')
    // 先让位置探测落一条缓存（null），制造「缓存里是 null」的状态
    assert.equal(resolveJobLauncher({ here: join(ROOT, 'src', 'tools'), exists: fakeFs([]), platform: 'win32' }), null)

    const prev = process.env['RIVET_JOB_LAUNCHER']
    try {
      process.env['RIVET_JOB_LAUNCHER'] = realExe
      assert.equal(
        resolveJobLauncher({ here: join(ROOT, 'src', 'tools'), exists: fakeFs([]), platform: 'win32' }),
        realExe,
        '覆盖变量必须实时生效——「刚编译出 helper」的正解就是设它',
      )
    } finally {
      if (prev === undefined) delete process.env['RIVET_JOB_LAUNCHER']
      else process.env['RIVET_JOB_LAUNCHER'] = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 win32 直接返回 null，且不进缓存', () => {
    const exists = fakeFs([EXE])
    assert.equal(resolveJobLauncher({ here: join(ROOT, 'src', 'tools'), exists, platform: 'linux' }), null)
    assert.equal(exists.calls, 0, '非 Windows 不该有任何文件系统探测')
  })
})
