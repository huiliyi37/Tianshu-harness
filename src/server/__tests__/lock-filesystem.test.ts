import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir, hostname } from 'node:os'
import { join, delimiter } from 'node:path'
import childProcess, { spawn } from 'node:child_process'
import { createLockFileExclusive, readLockFile, removeLockFile, CronLock } from '../cron-lock.js'
import { StoreLock } from '../store-lock.js'
import { isFilesystemMetadata } from '../../utils/file-metadata.js'

const info = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }

function noLinks<T>(code: string, run: () => T): T {
  const original = fs.linkSync
  fs.linkSync = () => { throw Object.assign(new Error('hard links unavailable'), { code }) }
  syncBuiltinESMExports()
  const restore = () => { fs.linkSync = original; syncBuiltinESMExports() }
  try {
    const result = run()
    if (result instanceof Promise) return result.finally(restore) as T
    restore()
    return result
  } catch (error) { restore(); throw error }
}

for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']) {
  test(`complete directory publication and exclusive competition on ${code}`, () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
    const path = join(root, 'sidecar.lock')
    try {
      noLinks(code, () => {
        assert.deepEqual(createLockFileExclusive(path, info), { ok: true })
        assert.ok(fs.statSync(path).isDirectory())
        assert.deepEqual(readLockFile(path), info)
        assert.deepEqual(createLockFileExclusive(path, { ...info, pid: 123 }), { ok: false, reason: 'exists' })
        assert.deepEqual(readLockFile(path), info)
        assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), ['sidecar.lock'], 'no staging debris')
        removeLockFile(path)
        assert.deepEqual(createLockFileExclusive(path, info), { ok: true })
      })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test('fallback cannot overwrite a legacy file lock; unrelated permissions stay errors', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'sidecar.lock')
  try {
    fs.writeFileSync(path, JSON.stringify(info))
    noLinks('EPERM', () => assert.deepEqual(createLockFileExclusive(path, info), { ok: false, reason: 'exists' }))
    assert.deepEqual(readLockFile(path), info)
    removeLockFile(path)
    noLinks('EACCES', () => assert.equal(createLockFileExclusive(path, info).ok, false))
    assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a legacy file published at the final directory move wins the competition', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-race-'))
  const path = join(root, 'sidecar.lock')
  const legacy = JSON.stringify({ ...info, pid: 123, ownerToken: 'legacy-winner' })
  const originalRename = fs.renameSync, originalExec = childProcess.execFileSync
  const publishLegacy = () => fs.writeFileSync(path, legacy, { flag: 'wx' })
  fs.renameSync = (source, target) => {
    if (String(target) === path) publishLegacy()
    return originalRename(source, target)
  }
  childProcess.execFileSync = ((...args: Parameters<typeof originalExec>) => {
    if (args[2]?.env?.TIANSHU_LOCK_TARGET_DIR === path) publishLegacy()
    return originalExec(...args)
  }) as typeof originalExec
  syncBuiltinESMExports()
  try {
    noLinks('EPERM', () => assert.deepEqual(createLockFileExclusive(path, info), { ok: false, reason: 'exists' }))
    assert.equal(fs.readFileSync(path, 'utf8'), legacy, 'the late competing owner must remain byte-identical')
    assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), ['sidecar.lock'], 'failed publication cleans its staging files')
  } finally {
    fs.renameSync = originalRename
    childProcess.execFileSync = originalExec
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('directory fallback publishes lock paths containing shell syntax literally', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-literal-'))
  const path = join(root, "sidecar '$variable' [literal] (space).lock")
  try {
    noLinks('EPERM', () => assert.deepEqual(createLockFileExclusive(path, info), { ok: true }))
    assert.deepEqual(readLockFile(path), info)
    assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), ["sidecar '$variable' [literal] (space).lock"])
    removeLockFile(path)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

function fakeWindowsShell(root: string): string {
  const source = join(root, 'powershell.cs'), executable = join(root, 'powershell.exe')
  fs.writeFileSync(source, `using System; using System.IO; using System.Threading;
    class Program { static int Main() {
      File.WriteAllText(Environment.GetEnvironmentVariable("TIANSHU_FAKE_SHELL_MARKER"), "invoked");
      if (Environment.GetEnvironmentVariable("TIANSHU_FAKE_SHELL_DELAY") == "yes") Thread.Sleep(6000);
      return 0;
    } }`)
  const windows = process.env.SystemRoot ?? 'C:/Windows'
  const compiler = ['Framework64', 'Framework'].map(arch => join(windows, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe')).find(fs.existsSync)
  assert.ok(compiler, 'Windows publication fixture requires the .NET Framework compiler')
  childProcess.execFileSync(compiler, ['/nologo', `/out:${executable}`, source], { windowsHide: true, timeout: 10_000 })
  return executable
}

function delayedWindowsPublisher(root: string, phase: 'startup' | 'exit'): string {
  const source = join(root, 'publisher.cs'), executable = join(root, 'publisher.exe')
  fs.writeFileSync(source, `using System; using System.IO; using System.Threading;
    class Program { static int Main() {
      ${phase === 'startup' ? 'Thread.Sleep(1400);' : ''}
      Directory.Move(Environment.GetEnvironmentVariable("TIANSHU_LOCK_STAGED_DIR"),
        Environment.GetEnvironmentVariable("TIANSHU_LOCK_TARGET_DIR"));
      ${phase === 'exit' ? 'Thread.Sleep(6000);' : ''}
      return 0;
    } }`)
  const windows = process.env.SystemRoot ?? 'C:/Windows'
  const compiler = ['Framework64', 'Framework'].map(arch => join(windows, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe')).find(fs.existsSync)
  assert.ok(compiler, 'Windows publication fixture requires the .NET Framework compiler')
  childProcess.execFileSync(compiler, ['/nologo', `/out:${executable}`, source], { windowsHide: true, timeout: 10_000 })
  return executable
}

for (const phase of ['startup', 'exit'] as const) {
  test(`directory publication retains the complete owner across delayed ${phase}`, { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-delayed-')), path = join(root, 'sidecar.lock')
    const original = childProcess.execFileSync, publisher = delayedWindowsPublisher(root, phase)
    childProcess.execFileSync = ((...args: Parameters<typeof original>) => {
      if (args[2]?.env?.TIANSHU_LOCK_TARGET_DIR !== path) return original(...args)
      return original(publisher, [], args[2])
    }) as typeof original
    syncBuiltinESMExports()
    try {
      const started = Date.now()
      noLinks('EPERM', () => assert.deepEqual(createLockFileExclusive(path, info), { ok: true }))
      assert.ok(Date.now() - started < 5_000, 'publication stays within the acquisition window')
      assert.deepEqual(readLockFile(path), info)
      assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name) && name.includes('.tmp')), [])
      removeLockFile(path)
    } finally {
      childProcess.execFileSync = original; syncBuiltinESMExports()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('directory publication ignores same-name executables in cwd and PATH', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-shell-')), path = join(root, 'sidecar.lock')
  const marker = join(root, 'invoked'), oldCwd = process.cwd(), oldPath = process.env.PATH
  const oldMarker = process.env.TIANSHU_FAKE_SHELL_MARKER
  try {
    fakeWindowsShell(root)
    process.env.PATH = `${root}${delimiter}${oldPath}`
    process.env.TIANSHU_FAKE_SHELL_MARKER = marker
    process.chdir(root)
    noLinks('EPERM', () => assert.deepEqual(createLockFileExclusive(path, info), { ok: true }))
    assert.equal(fs.existsSync(marker), false, 'a same-name executable must never be invoked')
    assert.deepEqual(readLockFile(path), info)
  } finally {
    process.chdir(oldCwd); process.env.PATH = oldPath
    if (oldMarker === undefined) delete process.env.TIANSHU_FAKE_SHELL_MARKER; else process.env.TIANSHU_FAKE_SHELL_MARKER = oldMarker
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const outcome of ['exit zero', 'timeout']) for (const fault of ['no-move', 'source-remains', 'wrong-owner', 'regular-file', 'symlink']) {
  test(`directory publication rejects ${outcome} with ${fault}`, { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-postcondition-')), path = join(root, 'sidecar.lock')
    const original = childProcess.execFileSync
    childProcess.execFileSync = ((...args: Parameters<typeof original>) => {
      const env = args[2]?.env
      if (env?.TIANSHU_LOCK_TARGET_DIR !== path) return original(...args)
      const source = String(env.TIANSHU_LOCK_STAGED_DIR)
      const finish = () => {
        if (outcome === 'timeout') throw Object.assign(new Error('publisher timed out'), { code: 'ETIMEDOUT' })
        return Buffer.alloc(0)
      }
      if (fault === 'no-move') return finish()
      if (fault === 'regular-file') fs.writeFileSync(path, 'competing legacy owner')
      else if (fault === 'symlink') fs.symlinkSync(source, path, 'junction')
      else {
        fs.mkdirSync(path)
        fs.copyFileSync(join(source, 'owner.json'), join(path, 'owner.json'))
        if (fault === 'wrong-owner') fs.writeFileSync(join(path, 'owner.json'), 'competing directory owner')
      }
      if (fault !== 'source-remains' && fault !== 'symlink') fs.rmSync(source, { recursive: true })
      return finish()
    }) as typeof original
    syncBuiltinESMExports()
    try {
      noLinks('EPERM', () => assert.equal(createLockFileExclusive(path, info).ok, false, 'publisher status must not fabricate ownership'))
      if (fault === 'wrong-owner') assert.equal(fs.readFileSync(join(path, 'owner.json'), 'utf8'), 'competing directory owner')
      if (fault === 'regular-file') assert.equal(fs.readFileSync(path, 'utf8'), 'competing legacy owner')
      assert.ok(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)).every(name => !name.includes('.tmp')), 'only our staging files may be cleaned')
    } finally {
      childProcess.execFileSync = original; syncBuiltinESMExports()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('a stalled directory publisher fails within the existing acquisition window', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-stall-')), path = join(root, 'sidecar.lock')
  const original = childProcess.execFileSync, shell = fakeWindowsShell(root)
  childProcess.execFileSync = ((...args: Parameters<typeof original>) => {
    if (args[2]?.env?.TIANSHU_LOCK_TARGET_DIR !== path) return original(...args)
    return original(shell, [], { ...args[2], env: { ...args[2].env, TIANSHU_FAKE_SHELL_MARKER: join(root, 'invoked'), TIANSHU_FAKE_SHELL_DELAY: 'yes' } })
  }) as typeof original
  syncBuiltinESMExports()
  try {
    const started = Date.now()
    noLinks('EPERM', () => assert.equal(createLockFileExclusive(path, info).ok, false))
    assert.ok(Date.now() - started < 5_000, 'one publication cannot consume more than the existing 5s window')
    assert.equal(fs.existsSync(path), false)
    assert.ok(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)).every(name => !name.includes('.tmp')))
  } finally {
    childProcess.execFileSync = original; syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('interrupted directory preparation never publishes a partial owner', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'sidecar.lock')
  const original = fs.writeFileSync
  fs.writeFileSync = (path, data, options) => {
    if (String(path).endsWith('owner.json')) throw Object.assign(new Error('interrupted write'), { code: 'EIO' })
    return original(path, data, options)
  }
  syncBuiltinESMExports()
  try {
    noLinks('EPERM', () => assert.equal(createLockFileExclusive(path, info).ok, false))
    assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), [], 'no canonical lock or staging debris')
  } finally {
    fs.writeFileSync = original
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('directory recovery preserves unknown contents instead of recursively deleting them', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'cron.lock')
  const lock = new CronLock({ lockPath: path })
  try {
    fs.mkdirSync(path)
    fs.writeFileSync(join(path, 'unrelated'), 'keep')
    noLinks('EPERM', () => assert.equal(lock.acquire().status, 'contended'))
    assert.equal(fs.readFileSync(join(path, 'unrelated'), 'utf8'), 'keep')
  } finally { lock.release(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('removing a directory symlink never traverses into the target', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  try {
    const target = join(root, 'target')
    fs.mkdirSync(target)
    fs.writeFileSync(join(target, 'owner.json'), 'keep')
    const path = join(root, 'sidecar.lock')
    fs.symlinkSync(target, path, 'dir')
    removeLockFile(path)
    assert.equal(fs.readFileSync(join(target, 'owner.json'), 'utf8'), 'keep')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('CronLock and StoreLock recover and release directory locks', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const cron = new CronLock({ lockPath: join(root, 'cron.lock') })
  const store = new StoreLock({ lockPath: join(root, 'sidecar.lock'), legacyWriterLockPaths: [] })
  try {
    await noLinks('EPERM', async () => {
      for (const name of ['cron.lock', 'sidecar.lock']) {
        assert.equal(createLockFileExclusive(join(root, name), { ...info, pid: 999999999 }).ok, true)
      }
      assert.equal(cron.acquire().status, 'stale_recovered')
      assert.equal((await store.acquire({ retryWindowMs: 0 })).status, 'stale_recovered')
      cron.release()
      store.release()
      assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), [])
    })
  } finally { cron.release(); store.release(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('eight processes publish directory locks with exactly one winner', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lock-fs-'))
  const path = join(root, 'sidecar.lock')
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    fs.linkSync = () => { throw Object.assign(new Error('unsupported'), {code:'EPERM'}) }; syncBuiltinESMExports();
    const { createLockFileExclusive } = await import(${JSON.stringify(new URL('../cron-lock.ts', import.meta.url).href)});
    console.log(JSON.stringify(createLockFileExclusive(process.argv[1], { pid:process.pid, hostname:'test', acquiredAt:'' })));
  `
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path])
      let out = ''; let err = ''
      child.stdout.on('data', d => out += d)
      child.stderr.on('data', d => err += d)
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err)))
    })))
    assert.equal(results.map(r => JSON.parse(r)).filter(r => r.ok).length, 1, results.join(''))
    assert.ok(readLockFile(path))
    assert.deepEqual(fs.readdirSync(root).filter(name => !isFilesystemMetadata(name)), ['sidecar.lock'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
