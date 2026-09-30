import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { resolveGitCommand, gitEnv, spawnGitSync, spawnGit } from '../spawn-git.js'

const isWin = process.platform === 'win32'

function tmpDir() {
  const d = join(tmpdir(), `spawn-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(d, { recursive: true })
  return d
}

function fakeGitExe(dir: string, name = isWin ? 'git.exe' : 'git') {
  const p = join(dir, name)
  writeFileSync(p, '')
  if (!isWin) chmodSync(p, 0o755)
  return p
}

describe('resolveGitCommand', () => {
  it('returns RIVET_GIT_PATH override when it exists', () => {
    const dir = tmpDir()
    try {
      const git = fakeGitExe(dir)
      const got = resolveGitCommand({ RIVET_GIT_PATH: git })
      assert.equal(got, git)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores RIVET_GIT_PATH when file does not exist', () => {
    const got = resolveGitCommand({ RIVET_GIT_PATH: '/nope/does/not/exist/git' })
    assert.notEqual(got, '/nope/does/not/exist/git')
  })

  it('Win: probes LOCALAPPDATA candidate when set', (t) => {
    if (!isWin) return
    // Program Files / x86 候选在真机存在时会先行命中（候选顺序保证，见 spawn-git.ts
    // 候选表）——本用例只在「前两位候选都不可见」的机器上有判别力。
    // LOCALAPPDATA 分支本身的接线已由 'via injected existsSync' 用例确定性覆盖。
    if (
      existsSync('C:\\Program Files\\Git\\cmd\\git.exe')
      || existsSync('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
    ) {
      t.skip('real-fs variant: Program Files git present on this host — LOCALAPPDATA branch unreachable by design')
      return
    }
    const dir = tmpDir()
    const prev = process.env['LOCALAPPDATA']
    try {
      // Create a fake git.exe under LOCALAPPDATA\Programs\Git\cmd
      const gitDir = join(dir, 'Programs', 'Git', 'cmd')
      mkdirSync(gitDir, { recursive: true })
      const git = fakeGitExe(gitDir)
      process.env['LOCALAPPDATA'] = dir
      const got = resolveGitCommand({})
      assert.equal(got, git, 'should find git via LOCALAPPDATA candidate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (prev !== undefined) process.env['LOCALAPPDATA'] = prev
      else delete process.env['LOCALAPPDATA']
    }
  })

  it('Win: probes Program Files (x86) when that is the only hit', () => {
    const x86 = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    const got = resolveGitCommand(
      { RIVET_GIT_PATH: '' },
      {
        platform: 'win32',
        existsSync: (p) => p === x86,
      },
    )
    assert.equal(got, x86, 'x86 candidate must be probed after Program Files')
  })

  it('Win: Program Files wins over x86 when both exist', () => {
    const pf = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const x86 = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    const got = resolveGitCommand(
      { RIVET_GIT_PATH: '' },
      {
        platform: 'win32',
        existsSync: (p) => p === pf || p === x86,
      },
    )
    assert.equal(got, pf)
  })

  it('Win: LOCALAPPDATA candidate via injected existsSync (cross-platform)', () => {
    const local = 'D:\\Users\\me\\AppData\\Local'
    const git = join(local, 'Programs', 'Git', 'cmd', 'git.exe')
    const got = resolveGitCommand(
      { RIVET_GIT_PATH: '', LOCALAPPDATA: local },
      {
        platform: 'win32',
        existsSync: (p) => p === git,
      },
    )
    assert.equal(got, git)
  })

  it('non-Win: returns "git" as fallback', () => {
    if (isWin) return
    const got = resolveGitCommand({})
    assert.equal(got, 'git')
  })

  it('falls back to process.env RIVET_GIT_PATH when opts.env is omitted', () => {
    const dir = tmpDir()
    const prev = process.env['RIVET_GIT_PATH']
    try {
      const git = fakeGitExe(dir)
      process.env['RIVET_GIT_PATH'] = git
      // No opts.env passed — verify process.env is consulted via merge
      const got = resolveGitCommand()
      assert.equal(got, git)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (prev !== undefined) process.env['RIVET_GIT_PATH'] = prev
      else delete process.env['RIVET_GIT_PATH']
    }
  })

  it('partial opts.env does not hide process.env RIVET_GIT_PATH', () => {
    const dir = tmpDir()
    const prev = process.env['RIVET_GIT_PATH']
    try {
      const git = fakeGitExe(dir)
      process.env['RIVET_GIT_PATH'] = git
      // Pass an empty env — should still see process.env via { ...process.env, ...opts.env }
      const got = resolveGitCommand({})
      assert.equal(got, git)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (prev !== undefined) process.env['RIVET_GIT_PATH'] = prev
      else delete process.env['RIVET_GIT_PATH']
    }
  })
})

describe('gitEnv', () => {
  it('returns an object with PATH', () => {
    const env = gitEnv()
    assert.ok(typeof env === 'object' && env !== null)
    const pathKey = isWin ? 'Path' : 'PATH'
    assert.ok(env[pathKey] || env['PATH'] || env['Path'],
      'expected resolved env to contain a PATH-like key')
  })

  it('accepts optional cwd', () => {
    const env = gitEnv(process.cwd())
    assert.ok(typeof env === 'object' && env !== null)
  })

  it('strips unsafe GIT_* variables that can redirect git behavior', () => {
    const prev: Record<string, string | undefined> = {}
    const unsafeKeys = [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_REPLACE_REF_BASE',
    ]
    // GIT_SSH is a benign variable that must survive sanitization; note
    // GIT_EDITOR is intentionally overwritten by ANTI_INTERACTIVE_ENV (not
    // part of this test's contract).
    const benign = ['GIT_SSH']
    for (const k of [...unsafeKeys, ...benign]) {
      prev[k] = process.env[k]
      process.env[k] = k === 'GIT_SSH' ? '/usr/bin/ssh' : `/attacker/${k.toLowerCase()}`
    }
    try {
      const env = gitEnv()
      for (const k of unsafeKeys) {
        assert.equal(env[k], undefined, `${k} must be stripped from git env`)
      }
      assert.equal(env['GIT_SSH'], '/usr/bin/ssh', 'benign GIT_SSH must be preserved')
    } finally {
      for (const k of [...unsafeKeys, ...benign]) {
        if (prev[k] !== undefined) process.env[k] = prev[k]
        else delete process.env[k]
      }
    }
  })

  it('strips unsafe GIT_* even when merged back via spawnGitSync opts.env', () => {
    const prev = process.env['GIT_DIR']
    try {
      process.env['GIT_DIR'] = undefined
      const r = spawnGitSync(['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, GIT_DIR: '/attacker/git', GIT_WORK_TREE: '/attacker/wt' },
      })
      assert.equal(r.status, 0, `git --version should succeed despite env GIT_DIR, got: ${r.stderr}`)
    } finally {
      if (prev !== undefined) process.env['GIT_DIR'] = prev
      else delete process.env['GIT_DIR']
    }
  })
})

describe('spawnGitSync', () => {
  it('runs git --version and returns success', () => {
    const r = spawnGitSync(['--version'], { encoding: 'utf-8', timeout: 5000 })
    assert.equal(r.status, 0, `git --version should succeed, got: ${r.stderr}`)
    assert.ok(r.stdout.includes('git version'), `expected git version output, got: ${r.stdout}`)
  })

  it('passes cwd through to the child process', () => {
    const r = spawnGitSync(['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 5000,
    })
    assert.equal(r.status, 0)
  })
})

describe('spawnGit (async)', () => {
  it('runs git --version and resolves with stdout', async () => {
    const child = spawnGit(['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`git --version exited ${code}`))
      })
      child.on('error', reject)
    })
    assert.ok(stdout.includes('git version'), `expected git version output, got: ${stdout}`)
  })
})
