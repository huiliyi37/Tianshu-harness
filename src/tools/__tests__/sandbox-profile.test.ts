import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSeatbeltProfile,
  buildSeatbeltCommand,
  buildBwrapCommand,
  buildFirejailCommand,
  buildLandlockCommand,
  defaultWritableRoots,
  detectWsl,
  selectSandboxBackend,
  wrapSandboxCommand,
  shSingleQuote,
  getSandboxStartupNotice,
  maybeWarnNoSandbox,
  isSandboxActive,
  sandboxRequested,
  sandboxCoversCommand,
  applySandboxPolicyForApprovalMode,
  applyUnsandboxedEnvDefault,
  _resetSandboxWarningLatch,
  _resetSandboxBackendCache,
} from '../sandbox-profile.js'
import { grantPath, _resetGrantsForTest } from '../path-grants.js'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

describe('sandbox-profile: shSingleQuote', () => {
  it('wraps in single quotes', () => {
    assert.equal(shSingleQuote('echo hi'), `'echo hi'`)
  })
  it('escapes embedded single quotes', () => {
    assert.equal(shSingleQuote(`it's`), `'it'\\''s'`)
  })
})

describe('sandbox-profile: defaultWritableRoots', () => {
  it('always includes cwd and a temp dir', () => {
    const roots = defaultWritableRoots({ cwd: '/work/proj', env: { HOME: '/home/u', TMPDIR: '/tmp/x' } })
    assert.ok(roots.includes('/work/proj'))
    assert.ok(roots.includes('/tmp/x'))
  })
  it('includes package caches under HOME', () => {
    const roots = defaultWritableRoots({ cwd: '/w', env: { HOME: '/home/u' } })
    // Production joins HOME-relative cache roots with the HOST path module, so
    // the expected spelling follows the host too (backslashes on win32).
    assert.ok(roots.includes(join('/home/u', '.npm')))
    assert.ok(roots.includes(join('/home/u', '.cargo')))
  })
  it('honors RIVET_SANDBOX_WRITABLE extra roots', () => {
    // Posix delimiter contract — pinned via the injected platform knob (the
    // win32 ';' contract has its own test below).
    const roots = defaultWritableRoots({
      cwd: '/w',
      platform: 'linux',
      env: { HOME: '/home/u', RIVET_SANDBOX_WRITABLE: '/data:/scratch' },
    })
    assert.ok(roots.includes('/data'))
    assert.ok(roots.includes('/scratch'))
  })
  it('splits RIVET_SANDBOX_WRITABLE on ; for Windows without shredding drive-letter paths', () => {
    const roots = defaultWritableRoots({
      cwd: 'C:\\work',
      platform: 'win32',
      env: { RIVET_SANDBOX_WRITABLE: 'C:\\data;D:\\scratch' },
    })
    assert.ok(roots.includes('C:\\data'), 'C:\\data kept whole')
    assert.ok(roots.includes('D:\\scratch'), 'D:\\scratch kept whole')
    assert.ok(!roots.includes('C'), 'colon must not split the drive letter off')
  })
  it('includes user-approved WRITE grants, excludes read-only grants', () => {
    _resetGrantsForTest()
    const wdir = mkdtempSync(join(tmpdir(), 'rivet-w-'))
    const rdir = mkdtempSync(join(tmpdir(), 'rivet-r-'))
    try {
      grantPath(wdir, 'write')
      grantPath(rdir, 'read')
      const roots = defaultWritableRoots({ cwd: '/w', env: { HOME: '/home/u' } })
      const canonicalW = realpathSync(wdir)
      const canonicalR = realpathSync(rdir)
      assert.ok(roots.includes(canonicalW), 'write-granted root present')
      assert.ok(!roots.includes(canonicalR), 'read-only grant must NOT be writable')
    } finally {
      _resetGrantsForTest()
      rmSync(wdir, { recursive: true, force: true })
      rmSync(rdir, { recursive: true, force: true })
    }
  })
})

describe('sandbox-profile: Seatbelt', () => {
  it('denies writes globally then re-allows roots', () => {
    const profile = buildSeatbeltProfile(['/work/proj', '/tmp'])
    assert.ok(profile.includes('(deny file-write*)'))
    assert.ok(profile.includes('(subpath "/work/proj")'))
    assert.ok(profile.includes('(subpath "/tmp")'))
    // /dev/null must stay writable or most commands break.
    assert.ok(profile.includes('/dev/null'))
  })
  it('includes disk device access for hdiutil/DMG creation', () => {
    const profile = buildSeatbeltProfile(['/work'])
    assert.ok(profile.includes('(subpath "/dev/disk")'), 'disk device read/write/ioctl for hdiutil')
    assert.ok(profile.includes('(subpath "/dev/rdisk")'), 'raw disk device access for DMG creation')
  })
  // Seatbelt matches rules against the canonical path, so a rule naming a
  // symlinked ancestor never fires. On macOS /var → /private/var, which is where
  // $TMPDIR actually lives: the literal rule silently denied every mkdtemp,
  // i.e. most of the Node/npm/git toolchain (2026-08-02).
  it('emits the canonical twin for roots sitting behind a symlink', () => {
    const resolve = (p: string) => {
      const canon = p.startsWith('/var/') ? p.replace('/var/', '/private/var/') : p
      return canon.endsWith('/') ? canon.slice(0, -1) : canon
    }
    const profile = buildSeatbeltProfile(['/var/folders/ab/T/'], resolve)
    assert.ok(
      profile.includes('(subpath "/private/var/folders/ab/T")'),
      `canonical spelling missing:\n${profile}`,
    )
  })
  it('keeps the literal root when it cannot be resolved yet', () => {
    const profile = buildSeatbeltProfile(['/not/created/yet'], () => { throw new Error('ENOENT') })
    assert.ok(profile.includes('(subpath "/not/created/yet")'), profile)
  })
  it('darwin: the real default profile actually permits mkdtemp under $TMPDIR', { skip: process.platform !== 'darwin' }, (t) => {
    const profile = buildSeatbeltProfile(defaultWritableRoots({ cwd: process.cwd() }))
    assert.ok(
      profile.includes(`(subpath "${realpathSync(tmpdir())}")`),
      'canonical temp dir must be writable or the whole toolchain gets EPERM',
    )
    // Kernel-level proof, not just a string assertion — this is the exact call
    // (mkdtemp under $TMPDIR) that regressed. Nested Seatbelt（本测试自身跑在
    // 沙箱内）直接拒绝 sandbox-exec（exit 71 sandbox_apply: Operation not
    // permitted）：冒烟探针失败即跳过 kernel 级验证，保留字符串断言。
    try {
      execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' })
    } catch {
      t.skip('sandbox-exec unavailable: nested Seatbelt denies sandbox_apply')
      return
    }
    const made = execFileSync('sandbox-exec', ['-p', profile, '/usr/bin/mktemp', '-d'], { encoding: 'utf8' }).trim()
    rmSync(made, { recursive: true, force: true })
  })
  it('builds a sandbox-exec command that preserves the inner command', () => {
    const cmd = buildSeatbeltCommand('npm test', ['/work'])
    assert.ok(cmd.startsWith('sandbox-exec -p '))
    assert.ok(cmd.includes('npm test'))
  })
})

describe('sandbox-profile: bwrap/firejail', () => {
  it('bwrap binds the workspace read-write over a read-only root', () => {
    // Must be a real directory: buildBwrapCommand filters non-existent roots
    // (bwrap --bind aborts the whole sandbox on a missing dir → exit 127).
    const realRoot = process.cwd()
    const cmd = buildBwrapCommand('make', [realRoot])
    assert.ok(cmd.startsWith('bwrap '))
    assert.ok(cmd.includes('--ro-bind / /'))
    assert.ok(cmd.includes(realRoot))
    assert.ok(cmd.includes('make'))
    // network must NOT be unshared
    assert.ok(!cmd.includes('--unshare-net'))
  })
  it('bwrap silently drops non-existent writable roots instead of aborting', () => {
    const cmd = buildBwrapCommand('make', ['/definitely-not-a-real-dir-xyz'])
    assert.ok(!cmd.includes('/definitely-not-a-real-dir-xyz'))
    assert.ok(cmd.startsWith('bwrap '))
  })
  it('firejail keeps root read-only with explicit writable roots', () => {
    const cmd = buildFirejailCommand('go build', ['/work'])
    assert.ok(cmd.includes('--read-only=/'))
    assert.ok(cmd.includes('--read-write='))
    assert.ok(cmd.includes('go build'))
  })
})

describe('sandbox-profile: landlock', () => {
  const launcher = '/opt/landlock-run'
  it('构造：--ro / + 每个 real root 一对 --rw + /dev/null + -- 分隔命令', () => {
    const realRoot = process.cwd()
    const cmd = buildLandlockCommand('make', [realRoot, '/definitely-not-a-real-dir-xyz'], launcher)
    assert.ok(cmd.startsWith(`'${launcher}' `), `应以引号包裹的 launcher 路径开头: ${cmd}`)
    assert.ok(cmd.includes(`--ro '/'`), '根只读授予（路径统一引号包裹）')
    assert.ok(cmd.includes(`--rw '${realRoot}'`), '真实 root 授予可写（引号包裹路径）')
    assert.ok(!cmd.includes('/definitely-not-a-real-dir-xyz'), '不存在的 root 静默丢弃')
    assert.ok(cmd.includes(`--rw '/dev/null'`), '/dev/null 必须可写（CLI 默认重定向目标）')
    assert.ok(cmd.includes(`-- sh -c 'make'`), '命令经 sh -c 在 -- 之后执行')
  })
  it('wrapSandboxCommand landlock 后端返回 sandboxed + note', () => {
    const decision = wrapSandboxCommand('touch x', {
      cwd: '/work/proj',
      env: { HOME: '/home/u', RIVET_SANDBOX: '1' } as NodeJS.ProcessEnv,
      platform: 'linux',
      which: () => false,
      landlockUsable: () => true,
    })
    assert.equal(decision.sandboxed, true)
    assert.equal(decision.backend, 'landlock')
    assert.ok(decision.writableRoots, 'writableRoots 必须带上（拒绝分类要用）')
  })
})

describe('sandbox-profile: detectWsl', () => {
  it('detects via WSL_DISTRO_NAME', () => {
    assert.equal(detectWsl(() => null, { WSL_DISTRO_NAME: 'Ubuntu' }), true)
  })
  it('detects via /proc/version microsoft marker', () => {
    assert.equal(detectWsl(() => 'Linux ... microsoft-standard-WSL2 ...', {}), true)
  })
  it('returns false on a real Linux kernel', () => {
    assert.equal(detectWsl(() => 'Linux version 6.1.0 (gcc ...)', {}), false)
  })
})

describe('sandbox-profile: selectSandboxBackend', () => {
  it('macOS picks seatbelt when sandbox-exec exists', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'darwin', which: () => true }), 'seatbelt')
  })
  it('macOS falls back to none without sandbox-exec', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'darwin', which: () => false }), 'none')
  })
  it('linux prefers bwrap', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'linux', which: (b) => b === 'bwrap' }), 'bwrap')
  })
  it('linux uses firejail when bwrap missing', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'linux', which: (b) => b === 'firejail' }), 'firejail')
  })
  it('linux falls back to landlock when bwrap/firejail missing and launcher enforces', () => {
    assert.equal(
      selectSandboxBackend({ cwd: '/w', platform: 'linux', which: () => false, landlockUsable: () => true }),
      'landlock',
    )
  })
  it('linux landlock probe unusable → none（fail-closed，绝不裸奔声明）', () => {
    assert.equal(
      selectSandboxBackend({ cwd: '/w', platform: 'linux', which: () => false, landlockUsable: () => false }),
      'none',
    )
  })
  it('linux bwrap 仍优先于 landlock（mount profile 语义更全）', () => {
    assert.equal(
      selectSandboxBackend({ cwd: '/w', platform: 'linux', which: (b) => b === 'bwrap', landlockUsable: () => true }),
      'bwrap',
    )
  })
  it('linux without tools is none', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'linux', which: () => false, landlockUsable: () => false }), 'none')
  })
  it('native windows is none', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'win32', which: () => true }), 'none')
  })
})

describe('sandbox-profile: wrapSandboxCommand', () => {
  const base = { cwd: '/work/proj', env: { HOME: '/home/u' } as NodeJS.ProcessEnv }

  it('passes through by default (sandbox OFF)', () => {
    const d = wrapSandboxCommand('echo hi', { ...base })
    assert.equal(d.sandboxed, false)
    assert.equal(d.command, 'echo hi')
  })
  it('wraps with seatbelt on macOS when RIVET_SANDBOX=1', () => {
    const d = wrapSandboxCommand('echo hi', { ...base, platform: 'darwin', which: () => true, env: { ...base.env, RIVET_SANDBOX: '1' } })
    assert.equal(d.sandboxed, true)
    assert.equal(d.backend, 'seatbelt')
    assert.ok(d.command.includes('echo hi'))
  })
  it('fails soft on native windows with RIVET_SANDBOX=1', () => {
    const d = wrapSandboxCommand('echo hi', { ...base, platform: 'win32', which: () => false, env: { ...base.env, RIVET_SANDBOX: '1' } })
    assert.equal(d.sandboxed, false)
    assert.equal(d.backend, 'none')
    assert.match(d.note ?? '', /Windows|rollback/i)
  })
  it('notes WSL when on linux without tools with RIVET_SANDBOX=1', () => {
    const d = wrapSandboxCommand('echo hi', {
      ...base, platform: 'linux', which: () => false,
      env: { ...base.env, WSL_DISTRO_NAME: 'Ubuntu', RIVET_SANDBOX: '1' },
      readProcVersion: () => 'microsoft',
    })
    assert.equal(d.sandboxed, false)
    assert.match(d.note ?? '', /WSL|bubblewrap/i)
  })
})

describe('sandbox-profile: getSandboxStartupNotice', () => {
  const env = { HOME: '/home/u' } as NodeJS.ProcessEnv

  it('returns null when a real boundary is active (no noise)', () => {
    assert.equal(getSandboxStartupNotice({ cwd: '/w', platform: 'darwin', which: () => true, env }), null)
    assert.equal(getSandboxStartupNotice({ cwd: '/w', platform: 'linux', which: (b) => b === 'bwrap', env }), null)
  })

  it('warns sternly on native Windows when RIVET_SANDBOX=1', () => {
    const n = getSandboxStartupNotice({ cwd: '/w', platform: 'win32', which: () => false, env: { ...env, RIVET_SANDBOX: '1' } })
    assert.ok(n)
    assert.equal(n!.level, 'warn')
    assert.match(n!.message, /Windows/)
    assert.match(n!.message, /RIVET_SANDBOX/)
  })

  it('warns when RIVET_SANDBOX=1 but no backend available', () => {
    const generic = getSandboxStartupNotice({ cwd: '/w', platform: 'linux', which: () => false, env: { ...env, RIVET_SANDBOX: '1' } })
    assert.ok(generic)
    assert.match(generic!.message, /RIVET_SANDBOX/)

    const win = getSandboxStartupNotice({ cwd: '/w', platform: 'win32', which: () => false, env: { ...env, RIVET_SANDBOX: '1' } })
    assert.match(win!.message, /Windows/)
  })

  it('warns when RIVET_SANDBOX=1 with no backend on WSL', () => {
    const n = getSandboxStartupNotice({
      cwd: '/w', platform: 'linux', which: () => false,
      env: { ...env, WSL_DISTRO_NAME: 'Ubuntu', RIVET_SANDBOX: '1' }, readProcVersion: () => 'microsoft',
    })
    assert.ok(n)
    assert.match(n!.message, /RIVET_SANDBOX|沙箱后端/)
  })
})

describe('sandbox-profile: maybeWarnNoSandbox (one-shot)', () => {
  const env = { HOME: '/home/u' } as NodeJS.ProcessEnv
  it('emits at most once per process and stays silent when sandboxed', () => {
    _resetSandboxWarningLatch()
    const logs: string[] = []
    const log = (m: string) => logs.push(m)

    // Sandboxed → no emission.
    maybeWarnNoSandbox({ cwd: '/w', platform: 'darwin', which: () => true, env: { ...env, RIVET_SANDBOX: '1' } }, log)
    assert.equal(logs.length, 0)

    // First no-backend call with RIVET_SANDBOX=1 emits once...
    maybeWarnNoSandbox({ cwd: '/w', platform: 'win32', which: () => false, env: { ...env, RIVET_SANDBOX: '1' } }, log)
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /\[sandbox\]/)

    // ...subsequent calls are latched.
    maybeWarnNoSandbox({ cwd: '/w', platform: 'win32', which: () => false, env: { ...env, RIVET_SANDBOX: '1' } }, log)
    assert.equal(logs.length, 1)
    _resetSandboxWarningLatch()
  })
})

describe('gate parity (isSandboxActive ↔ wrapSandboxCommand)', () => {
  it('reports inactive when the sandbox was never requested', () => {
    _resetSandboxBackendCache()
    const env = {} as NodeJS.ProcessEnv
    assert.equal(isSandboxActive(env), false)
    assert.equal(
      wrapSandboxCommand('echo hi', { cwd: process.cwd(), env }).sandboxed,
      false,
    )
  })

  it('retired RIVET_NO_SANDBOX no longer grants activity', () => {
    _resetSandboxBackendCache()
    // The retired opt-out must not be the thing that decides activity —
    // absence of RIVET_SANDBOX already means inactive.
    assert.equal(isSandboxActive({ RIVET_NO_SANDBOX: '0' } as NodeJS.ProcessEnv), false)
  })

  it('learn mode counts as requested (a real boundary is applied)', () => {
    _resetSandboxBackendCache()
    assert.equal(sandboxRequested({ RIVET_SANDBOX: 'learn' } as NodeJS.ProcessEnv), true)
  })
})

describe('SandboxDecision.writableRoots', () => {
  it('carries the roots that were in effect when sandboxed', () => {
    _resetSandboxBackendCache()
    const env = { RIVET_SANDBOX: '1', HOME: '/home/u', TMPDIR: '/tmp' } as NodeJS.ProcessEnv
    const d = wrapSandboxCommand('echo hi', {
      cwd: '/work',
      env,
      platform: 'darwin',
      which: (b: string) => b === 'sandbox-exec',
    })
    assert.equal(d.sandboxed, true)
    assert.ok(d.writableRoots)
    assert.ok(d.writableRoots.includes('/work'))
  })
})

describe('incompatible-command bypass', () => {
  const on = (cmd: string) => wrapSandboxCommand(cmd, {
    cwd: '/work',
    env: { RIVET_SANDBOX: '1', HOME: '/h' } as NodeJS.ProcessEnv,
    platform: 'darwin',
    which: (b: string) => b === 'sandbox-exec',
  })

  it('bypasses the wrap for brew but reports unsandboxed', () => {
    _resetSandboxBackendCache()
    const d = on('brew install jq')
    assert.equal(d.command, 'brew install jq', 'command must not be wrapped')
    assert.equal(d.sandboxed, false, 'must stay fail-closed for approval')
    assert.ok(d.note?.includes('沙箱旁路'))
  })

  it('still wraps an ordinary build command', () => {
    _resetSandboxBackendCache()
    const d = on('npm run build')
    assert.equal(d.sandboxed, true)
    assert.ok(d.command.startsWith('sandbox-exec'))
  })
})

describe('sandboxCoversCommand', () => {
  it('is false for a bypassed command even when the sandbox is on', () => {
    _resetSandboxBackendCache()
    const env = { RIVET_SANDBOX: '1' } as NodeJS.ProcessEnv
    // Only meaningful where a backend exists; on a backend-less host both are
    // false, which is still the fail-closed answer.
    assert.equal(sandboxCoversCommand('brew install jq', env), false)
  })
})

describe('applySandboxPolicyForApprovalMode', () => {
  it('leaves the sandbox OFF for YOLO — yolo = full-permission (unattended full-disk access)', () => {
    // 产品语义（2026-09-07 用户决策）：yolo 即「完全权限」档——免审批 + 无写沙箱，
    // 全自动场景可全盘读写（如 CLI 写 ~/.supabase）。沙箱只在显式 RIVET_SANDBOX=1 时开。
    const env = {} as NodeJS.ProcessEnv
    applySandboxPolicyForApprovalMode('dangerously-skip-permissions', env)
    assert.equal(env.RIVET_SANDBOX, undefined)
    assert.equal(sandboxRequested(env), false)
  })

  it('leaves non-YOLO modes alone', () => {
    for (const mode of ['manual', 'auto-safe', undefined]) {
      const env = {} as NodeJS.ProcessEnv
      applySandboxPolicyForApprovalMode(mode, env)
      assert.equal(env.RIVET_SANDBOX, undefined)
    }
  })

  it('never overrides an explicit setting — RIVET_SANDBOX=0 is the escape hatch', () => {
    const off = { RIVET_SANDBOX: '0' } as NodeJS.ProcessEnv
    applySandboxPolicyForApprovalMode('dangerously-skip-permissions', off)
    assert.equal(off.RIVET_SANDBOX, '0')
    assert.equal(sandboxRequested(off), false)

    const learn = { RIVET_SANDBOX: 'learn' } as NodeJS.ProcessEnv
    applySandboxPolicyForApprovalMode('dangerously-skip-permissions', learn)
    assert.equal(learn.RIVET_SANDBOX, 'learn')
  })

  it('is idempotent across repeated mode switches', () => {
    const env = {} as NodeJS.ProcessEnv
    applySandboxPolicyForApprovalMode('dangerously-skip-permissions', env)
    applySandboxPolicyForApprovalMode('dangerously-skip-permissions', env)
    // yolo 不再驱动沙箱——反复切换也不产生 RIVET_SANDBOX
    assert.equal(env.RIVET_SANDBOX, undefined)
  })
})

describe('applyUnsandboxedEnvDefault', () => {
  it('drops RIVET_SANDBOX=0 default when unsandboxed and env unset', () => {
    const env = {} as NodeJS.ProcessEnv
    applyUnsandboxedEnvDefault(true, env)
    assert.equal(env.RIVET_SANDBOX, '0')
    assert.equal(sandboxRequested(env), false)
  })

  it('does nothing when not unsandboxed', () => {
    const env = {} as NodeJS.ProcessEnv
    applyUnsandboxedEnvDefault(false, env)
    assert.equal(env.RIVET_SANDBOX, undefined)
  })

  it('never overrides an explicit RIVET_SANDBOX — explicit env always wins', () => {
    // P1-1 回归：bootstrap 曾无条件把 config.unsandboxed 落成 RIVET_SANDBOX=0，
    // 踩掉用户显式设置的 RIVET_SANDBOX=1（与 docstring「显式 env 永远赢」矛盾）。
    const on = { RIVET_SANDBOX: '1' } as NodeJS.ProcessEnv
    applyUnsandboxedEnvDefault(true, on)
    assert.equal(on.RIVET_SANDBOX, '1')
    assert.equal(sandboxRequested(on), true)
  })
})
