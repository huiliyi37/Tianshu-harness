import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeSourceFingerprint,
  parsePorcelainPaths,
  affectsTypecheck,
  isCacheableOutcome,
  readCachedTypecheck,
  writeCachedTypecheck,
  tryAcquireLock,
  isLockHeld,
  runTypecheckShared,
  isTypecheckCommand,
  resolveTypecheckLockRoot,
  runAdhocTypecheckShared,
  type TscRunOutcome,
  type TypecheckShareEvent,
} from '../typecheck-cache.js'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-tc-cache-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'test')
  run('config', 'commit.gpgsign', 'false')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  run('add', '.')
  run('commit', '-q', '-m', 'init')
  return dir
}

const ok = (stdout = ''): TscRunOutcome => ({ status: 0, stdout, stderr: '' })

describe('源码指纹', () => {
  let repo: string
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('同一份工作树两次计算一致——否则缓存永远不命中', () => {
    assert.equal(computeSourceFingerprint(repo), computeSourceFingerprint(repo))
  })

  it('改动源文件内容后指纹改变——这是「不漏报类型错误」的唯一保障', () => {
    const before = computeSourceFingerprint(repo)
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a: string = 1\n')
    assert.notEqual(computeSourceFingerprint(repo), before)
  })

  it('内容改回原样后指纹回到原值——用内容 hash 而不是 mtime', () => {
    const before = computeSourceFingerprint(repo)
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
    assert.equal(computeSourceFingerprint(repo), before)
  })

  it('新增未跟踪的 .ts 文件改变指纹——untracked 同样参与类型检查', () => {
    const before = computeSourceFingerprint(repo)
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
    assert.notEqual(computeSourceFingerprint(repo), before)
  })

  it('改动 markdown 不改变指纹——否则写文档会让所有会话的缓存失效', () => {
    const before = computeSourceFingerprint(repo)
    writeFileSync(join(repo, 'notes.md'), '# hello\n')
    assert.equal(computeSourceFingerprint(repo), before)
  })

  it('variant 不同则指纹不同——两种 tsc 输出格式不可互相回放', () => {
    assert.notEqual(
      computeSourceFingerprint(repo, '--noEmit --pretty false'),
      computeSourceFingerprint(repo, '--noEmit --pretty true'),
    )
  })

  it('非 git 目录返回 undefined，调用方据此直接跑', () => {
    const plain = mkdtempSync(join(tmpdir(), 'rivet-tc-nogit-'))
    try {
      assert.equal(computeSourceFingerprint(plain), undefined)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('porcelain 解析', () => {
  it('重命名记录额外占一个字段——漏掉会让后续整段错位', () => {
    // `R  new -> old` 在 -z 格式下是两个 NUL 分隔字段。
    const raw = 'R  src/new.ts\0src/old.ts\0 M src/other.ts\0'
    assert.deepEqual(parsePorcelainPaths(raw), ['src/new.ts', 'src/old.ts', 'src/other.ts'])
  })

  it('普通记录逐条解析，尾部空字段被忽略', () => {
    assert.deepEqual(parsePorcelainPaths('?? src/a.ts\0 M src/b.ts\0'), ['src/a.ts', 'src/b.ts'])
  })

  it('只有影响 tsc 的路径进指纹（2026-09-12 起目录无关：desktop 等子项目同样计入）', () => {
    assert.equal(affectsTypecheck('src/a.ts'), true)
    assert.equal(affectsTypecheck('tsconfig.json'), true)
    assert.equal(affectsTypecheck('package-lock.json'), true)
    assert.equal(affectsTypecheck('docs/readme.md'), false)
    // cwd 感知化：子项目源码/清单同样影响类型检查（ad-hoc 回放正确性前提）
    assert.equal(affectsTypecheck('desktop/src/App.tsx'), true)
    assert.equal(affectsTypecheck('desktop/tsconfig.json'), true)
    assert.equal(affectsTypecheck('desktop/src/locales/zh-CN/mobile.json'), true)
    assert.equal(affectsTypecheck('desktop/package.json'), true)
    assert.equal(affectsTypecheck('pnpm-lock.yaml'), true)
    assert.equal(affectsTypecheck('src/locales/en.json.bak'), false)
    // node_modules 永远不计入（依赖安装不改变 tsconfig 语义下的源码指纹）
    assert.equal(affectsTypecheck('node_modules/foo/index.d.ts'), false)
    assert.equal(affectsTypecheck('src/node_modules/foo.ts'), false)
    // 非代码扩展不进指纹（命中率保护）
    assert.equal(affectsTypecheck('docs/analysis/note.md'), false)
    assert.equal(affectsTypecheck('assets/logo.png'), false)
  })
})

describe('结果缓存', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-tc-store-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('写入后能按指纹读回', () => {
    writeCachedTypecheck(dir, { status: 1, stdout: 'err', stderr: '', fingerprint: 'fp1', finishedAt: 1, durationMs: 5 })
    assert.equal(readCachedTypecheck(dir, 'fp1')?.stdout, 'err')
  })

  it('指纹不匹配读不到', () => {
    writeCachedTypecheck(dir, { status: 0, stdout: '', stderr: '', fingerprint: 'fp1', finishedAt: 1, durationMs: 5 })
    assert.equal(readCachedTypecheck(dir, 'fp2'), undefined)
  })

  it('只有跑完的结果可缓存——超时被缓存等于让门禁长期 fail-open', () => {
    assert.equal(isCacheableOutcome({ status: 0, stdout: '', stderr: '' }), true, '0 = 无错')
    assert.equal(isCacheableOutcome({ status: 1, stdout: '', stderr: '' }), true, '1 = 有类型错误，同样是结论')
    assert.equal(isCacheableOutcome({ status: null, stdout: '', stderr: '' }), false, 'null = 超时/被杀')
    assert.equal(isCacheableOutcome({ status: 2, stdout: '', stderr: '' }), false, '2+ = 崩溃')
  })
})

describe('互斥锁', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-tc-lock-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('第二个获取者拿不到，释放后可再获取', () => {
    const first = tryAcquireLock(dir, 'fp')
    assert.ok(first)
    assert.equal(tryAcquireLock(dir, 'fp'), undefined)
    first.release()
    assert.equal(isLockHeld(dir), false)
    assert.ok(tryAcquireLock(dir, 'fp'))
  })

  it('持锁进程已死则清理陈旧锁——被 SIGKILL 的进程跑不到 finally', () => {
    const held = tryAcquireLock(dir, 'fp')
    assert.ok(held)
    const events: TypecheckShareEvent[] = []
    const stolen = tryAcquireLock(dir, 'fp', {
      isProcessAlive: () => false,
      onEvent: e => events.push(e),
    })
    assert.ok(stolen, '进程不存在时必须能夺锁，否则一次崩溃会永久堵死所有会话')
    assert.equal(events.some(e => e.kind === 'stale-lock-cleared'), true)
  })

  it('持锁进程存活但超过墙钟上限也算陈旧', () => {
    const held = tryAcquireLock(dir, 'fp')
    assert.ok(held)
    const later = Date.now() + 11 * 60_000
    assert.ok(tryAcquireLock(dir, 'fp', { isProcessAlive: () => true, now: () => later }))
  })

  it('持锁者存活且未超时则夺不走', () => {
    assert.ok(tryAcquireLock(dir, 'fp'))
    assert.equal(tryAcquireLock(dir, 'fp', { isProcessAlive: () => true }), undefined)
  })
})

describe('runTypecheckShared 编排', () => {
  let repo: string
  let cacheDir: string
  beforeEach(() => {
    repo = makeRepo()
    cacheDir = mkdtempSync(join(tmpdir(), 'rivet-tc-share-'))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('指纹相同的第二次调用回放结果，不再跑 tsc', async () => {
    let runs = 0
    const call = () => runTypecheckShared({
      cwd: repo,
      cacheDir,
      run: async () => { runs++; return ok('first output') },
    })
    await call()
    const second = await call()
    assert.equal(runs, 1, '同一份源码不该跑第二次')
    assert.equal(second.stdout, 'first output')
  })

  it('源码改动后不复用——复用会让新引入的类型错误看不见', async () => {
    let runs = 0
    const call = () => runTypecheckShared({
      cwd: repo,
      cacheDir,
      run: async () => { runs++; return ok(`run-${runs}`) },
    })
    await call()
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a: string = 1\n')
    const second = await call()
    assert.equal(runs, 2)
    assert.equal(second.stdout, 'run-2')
  })

  it('超时结果不写缓存，下次仍然真跑', async () => {
    let runs = 0
    const call = () => runTypecheckShared({
      cwd: repo,
      cacheDir,
      run: async () => { runs++; return { status: null, stdout: '', stderr: 'killed' } },
    })
    await call()
    await call()
    assert.equal(runs, 2, '一次超时不该被后来者当成结论复用')
  })

  it('tsc 运行期间源码被改动则不写缓存——那份结果对应哪个版本已不可知', async () => {
    const events: TypecheckShareEvent[] = []
    await runTypecheckShared({
      cwd: repo,
      cacheDir,
      onEvent: e => events.push(e),
      run: async () => {
        writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 999\n')
        return ok('stale')
      },
    })
    const ran = events.find(e => e.kind === 'ran')
    assert.equal(ran?.kind === 'ran' && ran.cached, false)
  })

  it('variant 不同的调用各自缓存，不互相回放', async () => {
    let runs = 0
    const call = (variant: string) => runTypecheckShared({
      cwd: repo,
      cacheDir,
      variant,
      run: async () => { runs++; return ok(variant) },
    })
    await call('pretty-false')
    const other = await call('pretty-true')
    assert.equal(runs, 2, '输出格式不同的结果互相回放会让解析错乱')
    assert.equal(other.stdout, 'pretty-true')
  })

  it('非 git 目录直接跑，不因为算不出指纹而拒绝检查', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'rivet-tc-plain-'))
    try {
      let runs = 0
      const outcome = await runTypecheckShared({
        cwd: plain,
        cacheDir,
        run: async () => { runs++; return ok('ran anyway') },
      })
      assert.equal(runs, 1)
      assert.equal(outcome.stdout, 'ran anyway')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('等待预算耗尽后自己跑——闸门永远不能让检查不发生', async () => {
    const blocker = tryAcquireLock(cacheDir, 'someone-else')
    assert.ok(blocker)
    const events: TypecheckShareEvent[] = []
    let runs = 0
    const outcome = await runTypecheckShared({
      cwd: repo,
      cacheDir,
      waitBudgetMs: 400,
      onEvent: e => events.push(e),
      run: async () => { runs++; return ok('self') },
    })
    blocker.release()
    assert.equal(runs, 1, '等不到锁也必须检查，否则门禁形同虚设')
    assert.equal(outcome.stdout, 'self')
    assert.equal(events.some(e => e.kind === 'wait-timeout'), true)
  })

  it('持锁者中途失联则立刻接手，不白等满预算', async () => {
    const blocker = tryAcquireLock(cacheDir, 'other-session')
    assert.ok(blocker)
    // 初次抢锁时持锁者还活着（否则会被当成陈旧锁直接夺走，走不到等待路径）。
    let alive = true
    setTimeout(() => { alive = false }, 300)

    let runs = 0
    const startedAt = Date.now()
    await runTypecheckShared({
      cwd: repo,
      cacheDir,
      waitBudgetMs: 60_000,
      isProcessAlive: () => alive,
      run: async () => { runs++; return ok('self') },
    })
    blocker.release()
    assert.equal(runs, 1)
    assert.ok(
      Date.now() - startedAt < 10_000,
      '持锁者没了就等不到结果，此时耗满 60s 预算纯属浪费',
    )
  })

  it('持锁者仍在推进时不提前放弃——等它比自己重跑一遍更快', async () => {
    const fingerprint = computeSourceFingerprint(repo)
    assert.ok(fingerprint)
    const blocker = tryAcquireLock(cacheDir, fingerprint)
    assert.ok(blocker)
    // 持锁者「慢但活着」：600ms 后才出结果，远超一次轮询间隔。
    setTimeout(() => {
      writeCachedTypecheck(cacheDir, {
        status: 0, stdout: 'holder result', stderr: '',
        fingerprint, finishedAt: Date.now(), durationMs: 600,
      })
    }, 600)

    let runs = 0
    const outcome = await runTypecheckShared({
      cwd: repo,
      cacheDir,
      waitBudgetMs: 30_000,
      isProcessAlive: () => true,
      run: async () => { runs++; return ok('self') },
    })
    blocker.release()
    assert.equal(runs, 0, '持锁者还在跑就该继续等，抢着自己跑会让两边都变慢')
    assert.equal(outcome.stdout, 'holder result')
  })

  it('等待期间持锁者写出同指纹结果则直接复用，不必等锁释放', async () => {
    const fingerprint = computeSourceFingerprint(repo)
    assert.ok(fingerprint)
    const blocker = tryAcquireLock(cacheDir, fingerprint)
    assert.ok(blocker)
    // 模拟持锁者跑完写缓存、但尚未释放锁的窗口。
    setTimeout(() => {
      writeCachedTypecheck(cacheDir, {
        status: 0, stdout: 'from holder', stderr: '',
        fingerprint, finishedAt: Date.now(), durationMs: 100,
      })
    }, 250)

    let runs = 0
    const outcome = await runTypecheckShared({
      cwd: repo,
      cacheDir,
      waitBudgetMs: 5_000,
      run: async () => { runs++; return ok('self') },
    })
    blocker.release()
    assert.equal(runs, 0, '持锁者的结果可用时不该重复跑')
    assert.equal(outcome.stdout, 'from holder')
  })

  it('跑完释放锁，不给后来者留下堵塞', async () => {
    await runTypecheckShared({ cwd: repo, cacheDir, run: async () => ok() })
    assert.equal(isLockHeld(cacheDir), false)
  })

  it('run 抛错时同样释放锁', async () => {
    await assert.rejects(runTypecheckShared({
      cwd: repo,
      cacheDir,
      run: async () => { throw new Error('spawn failed') },
    }))
    assert.equal(isLockHeld(cacheDir), false)
    assert.equal(existsSync(join(cacheDir, 'run.lock')), false)
  })
})

describe('isTypecheckCommand（ad-hoc tsc 形态识别）', () => {
  it('命中：npx/直跑/vue-tsc 的 --noEmit 与包管理器 typecheck script', () => {
    const hits = [
      'npx tsc --noEmit',
      'npx tsc --noEmit -p tsconfig.json',
      'tsc --noEmit',
      './node_modules/.bin/tsc --noEmit',
      'pnpm exec tsc --noEmit',
      'npx vue-tsc --noEmit',
      'cd desktop && npm run typecheck',
      'npm run typecheck',
      'pnpm typecheck',
      'yarn typecheck',
      'npm run build && npm run typecheck',
    ]
    for (const cmd of hits) assert.ok(isTypecheckCommand(cmd), `应命中: ${cmd}`)
  })

  it('不命中：非验证形态与无关命令', () => {
    const misses = [
      'tsc',
      'tsc --watch',
      'tsc -p tsconfig.json', // 产物构建（emit），不是验证
      'grep -rn tsc src/',
      'echo "run tsc --noEmit later" | cat', // 管道内不出现在命令位
      'npm run typecheck:watch',
      'git status',
    ]
    for (const cmd of misses) assert.ok(!isTypecheckCommand(cmd), `不应命中: ${cmd}`)
  })
})

describe('resolveTypecheckLockRoot（锁根 git-toplevel 化）', () => {
  let repo: string
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('git 仓库内解析到顶层——子目录会话与根目录调用共享同一把锁', () => {
    // macOS tmpdir 是 /var→/private/var 的 symlink，git 返回 realpath——比较前归一。
    const real = realpathSync(repo)
    assert.equal(resolveTypecheckLockRoot(repo), real)
    const sub = join(repo, 'src')
    assert.equal(resolveTypecheckLockRoot(sub), real, '子目录 cwd 应归一到仓库顶层')
  })

  it('非 git 目录回退 cwd 本身（fail-open，不失锁语义之外的任何行为）', () => {
    const plain = mkdtempSync(join(tmpdir(), 'rivet-tc-nogit-'))
    try {
      assert.equal(resolveTypecheckLockRoot(plain), plain)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('runAdhocTypecheckShared（ad-hoc 收口：串行 + 同命令回放）', () => {
  let repo: string
  beforeEach(() => { repo = makeRepo() })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('真跑返回 live；同指纹同命令第二次直接回放（不再执行）', async () => {
    let runs = 0
    const run = async () => {
      runs++
      return { live: `result-${runs}`, outcome: { status: 0 as number | null, stdout: `out-${runs}`, stderr: '' } }
    }
    const first = await runAdhocTypecheckShared({ cwd: repo, command: 'npx tsc --noEmit', run })
    assert.deepEqual(first, { kind: 'live', live: 'result-1' })
    const second = await runAdhocTypecheckShared({ cwd: repo, command: 'npx tsc --noEmit', run })
    assert.equal(second.kind, 'replay', '同指纹同命令应回放')
    assert.equal(runs, 1, '回放不应再次执行')
    if (second.kind === 'replay') assert.equal(second.outcome.stdout, 'out-1')
  })

  it('命令不同不回放（variant 含命令全文）', async () => {
    let runs = 0
    const run = async () => { runs++; return { live: runs, outcome: { status: 0 as number | null, stdout: `out-${runs}`, stderr: '' } } }
    await runAdhocTypecheckShared({ cwd: repo, command: 'npx tsc --noEmit', run })
    const r = await runAdhocTypecheckShared({ cwd: repo, command: 'npx tsc --noEmit -p tsconfig.json', run })
    assert.equal(r.kind, 'live')
    assert.equal(runs, 2)
  })

  it('源码变动后不回放（指纹失效即重跑）', async () => {
    let runs = 0
    const run = async () => { runs++; return { live: runs, outcome: { status: 0 as number | null, stdout: `out-${runs}`, stderr: '' } } }
    await runAdhocTypecheckShared({ cwd: repo, command: 'npx tsc --noEmit', run })
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a: string = 1\n')
    const r = await runAdhocTypecheckShared({ cwd: repo, command: 'npx tsc --noEmit', run })
    assert.equal(r.kind, 'live', '脏文件内容变化必须使缓存失效')
    assert.equal(runs, 2)
  })

  it('cacheable 否决：含会话级 artifact 引用的内容不写缓存', async () => {
    let runs = 0
    const run = async () => {
      runs++
      return { live: runs, outcome: { status: 0 as number | null, stdout: `[artifact:a${runs}] big`, stderr: '' } }
    }
    const opts = { cwd: repo, command: 'npx tsc --noEmit', cacheable: (o: { stdout: string }) => !o.stdout.includes('[artifact:') }
    await runAdhocTypecheckShared({ ...opts, run })
    const r = await runAdhocTypecheckShared({ ...opts, run })
    assert.equal(r.kind, 'live', '被否决的结果不得回放——跨会话引用会悬空')
    assert.equal(runs, 2)
  })

  it('锁内串行：并发调用不重叠执行', async () => {
    let active = 0
    let maxActive = 0
    const run = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 100))
      active--
      return { live: active, outcome: { status: null as number | null, stdout: '', stderr: '' } }
    }
    await Promise.all([
      runAdhocTypecheckShared({ cwd: repo, command: 'tsc --noEmit', run }),
      runAdhocTypecheckShared({ cwd: repo, command: 'tsc --noEmit', run }),
    ])
    assert.equal(maxActive, 1)
  })
})
