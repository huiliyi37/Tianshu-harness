import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { PRIVATE_PATH_ACL_SCRIPT, PRIVATE_PATH_ACL_TIMEOUT_MS, ensurePrivateDirectory, ensurePrivateDirectoryForStartup, protectPrivatePath } from '../private-path.js'
import { privateAclAssertions, unsafeAclFixture, withoutAuditPrivilege } from './windows-acl-fixture.js'

test('private paths only persist modified DACLs, keeping owner/group/audit untouched', () => {
  assert.doesNotMatch(PRIVATE_PATH_ACL_SCRIPT, /Set-Acl|SetOwner|SetGroup|SetAuditRule|SetAuditRuleProtection/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /-notcontains \$current\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /\[IO\.Directory\]::SetAccessControl\(\$item\.FullName, \$acl\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /\[IO\.File\]::SetAccessControl\(\$item\.FullName, \$acl\)/)
})

test('private path DACL comparison converges on already-hardened directories (#450)', () => {
  // #450: the raw SDDL string compare never converges — an already-hardened
  // directory reads back as "D:PAI(A;OICI;FA;;;...)" while the fresh target
  // descriptor stringifies as "D:P(A;OICI;FA;;;...)". The AI flag ("auto
  // inherited") differs, so every boot rewrote the DACL (24s+ on 48k files)
  // until the execFileSync timeout killed the sidecar.
  assert.doesNotMatch(PRIVATE_PATH_ACL_SCRIPT, /GetSecurityDescriptorSddlForm\('Access'\) -ne/)
  // Convergence contract: compare the explicit ACE fingerprints (sorted set)
  // plus the protection flag — control-section flags (AI) must not trigger a
  // rewrite; a real ACE difference must.
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /GetAccessRules\(\$true, \$false, \$sidType\)/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /Compare-Object -ReferenceObject \$currentRules -DifferenceObject \$targetRules/)
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /AreAccessRulesProtected/)
})

test('Windows ACL rules stay inheritable so future children remain private', () => {
  // Security review constraint (#450): dropping OI/CI would leave new children
  // under a protected parent with an empty/default DACL — a regression. Keep
  // propagation; convergence is handled by the ACE fingerprint compare above.
  assert.match(PRIVATE_PATH_ACL_SCRIPT, /'ContainerInherit, ObjectInherit'/)
})

test('Windows ACL hardening timeout absorbs one-shot propagation over large directories', () => {
  // #450: measured 24s+ for a single SetAccessControl propagation over a
  // 48k-file tree. The old 10s budget killed the sidecar pre-listen. 30s
  // covers the one-time cost; repeat boots skip the write entirely (see the
  // convergence test above), and the startup call site degrades to warn.
  assert.equal(PRIVATE_PATH_ACL_TIMEOUT_MS, 30_000)
})

test('startup hardening degrades to warn on win32 but stays fatal elsewhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-path-startup-'))
  const original = childProcess.execFileSync
  childProcess.execFileSync = (() => { throw new Error('spawnSync ... ETIMEDOUT') }) as unknown as typeof childProcess.execFileSync
  syncBuiltinESMExports()
  const warnings: string[] = []
  try {
    // win32: protection failure must not kill serve — warn and continue.
    ensurePrivateDirectoryForStartup(root, 'win32', (msg) => { warnings.push(msg) })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /private storage hardening failed.*ETIMEDOUT/s)
    // The directory itself must still have been created before hardening.
    assert.equal(statSync(root).isDirectory(), true)
    // POSIX: chmod is O(1) and cannot time out — failures stay fatal.
    // A regular file where mkdir needs a directory fails hard (EPERM/EEXIST/ENOTDIR).
    const filePath = join(root, 'occupied')
    writeFileSync(filePath, 'x')
    assert.throws(() => ensurePrivateDirectoryForStartup(filePath, 'darwin', () => {}))
  } finally {
    childProcess.execFileSync = original
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup hardening never degrades symlink rejection on any platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-path-symlink-'))
  const link = join(root, 'data-link')
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  const warnings: string[] = []
  try {
    assert.throws(() => ensurePrivateDirectoryForStartup(link, 'win32', (msg) => { warnings.push(msg) }), /symbolic link/)
    assert.throws(() => ensurePrivateDirectoryForStartup(link, 'darwin', (msg) => { warnings.push(msg) }), /symbolic link/)
    assert.deepEqual(warnings, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Windows private-path caller sends the DACL-only script and retains failure diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-path-caller-'))
  const original = childProcess.execFileSync
  let calls = 0
  childProcess.execFileSync = ((_bin: string, args: string[], opts: any) => {
    calls++
    assert.equal(args.at(-1), PRIVATE_PATH_ACL_SCRIPT)
    assert.equal(opts.env.RIVET_PRIVATE_PATH, root)
    assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe'])
    throw new Error('native DACL write denied')
  }) as unknown as typeof childProcess.execFileSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => protectPrivatePath(root, 'win32'), /native DACL write denied/)
    assert.equal(calls, 1)
  } finally {
    childProcess.execFileSync = original
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('POSIX private directory and file modes remain restrictive', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'private-path-posix-'))
  try {
    const dir = join(root, 'data')
    ensurePrivateDirectory(dir)
    const file = join(dir, 'fixture.txt')
    writeFileSync(file, 'fixture')
    protectPrivatePath(file)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const kind of ['directory', 'file']) for (const inheritedOnly of [false, true]) {
  test(`Windows private ${kind} replaces ${inheritedOnly ? 'inherited-only' : 'unsafe'} grants without SeSecurityPrivilege`, { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'private-path-native-'))
    const path = kind === 'file' ? join(root, 'fixture.txt') : root
    if (kind === 'file') writeFileSync(path, 'fixture')
    try {
      const initialAcl = inheritedOnly ? `
        $ErrorActionPreference = 'Stop'
        $item = Get-Item -LiteralPath $env:ACL_TEST_ROOT
        $fixtureAcl = $item.GetAccessControl()
        $fixtureAcl.SetAccessRuleProtection($false, $false)
        foreach ($rule in $fixtureAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) { $fixtureAcl.RemoveAccessRuleSpecific($rule) }
        if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($item.FullName, $fixtureAcl) }
        else { [IO.File]::SetAccessControl($item.FullName, $fixtureAcl) }
        $before = $item.GetAccessControl()
        if (@($before.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])).Count -ne 0) { throw 'Fixture must have no explicit ACEs' }
      ` : unsafeAclFixture
      const fixture = initialAcl + withoutAuditPrivilege(`
        ${PRIVATE_PATH_ACL_SCRIPT}
        ${privateAclAssertions}
        ${PRIVATE_PATH_ACL_SCRIPT}
        if ($first.GetSecurityDescriptorSddlForm('Access') -ne ((Get-Item -LiteralPath $env:ACL_TEST_ROOT).GetAccessControl()).GetSecurityDescriptorSddlForm('Access')) { throw 'Repeated protection changed the DACL' }
      `)
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      const result = childProcess.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64')], {
        env: { ...process.env, RIVET_PRIVATE_PATH: path, ACL_TEST_ROOT: path },
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
      })
      assert.equal(result.status, 0, result.stderr)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('POSIX protection does not follow a symlink swapped in after the check', { skip: process.platform === 'win32' }, () => {
  // Simulates the check-then-use race: the pre-check sees a regular file, but a
  // symlink is swapped in before the permission change. O_NOFOLLOW must refuse
  // instead of following the link onto the target.
  const root = mkdtempSync(join(tmpdir(), 'private-race-'))
  const target = join(root, 'target.txt')
  writeFileSync(target, 'target')
  chmodSync(target, 0o644)
  const link = join(root, 'link.txt')
  symlinkSync(target, link)
  const originalLstat = fs.lstatSync
  Object.defineProperty(fs, 'lstatSync', { value: (p: string) => originalLstat(target) })
  syncBuiltinESMExports()
  try {
    assert.throws(() => protectPrivatePath(link, 'darwin'), /ELOOP/)
    assert.equal(statSync(target).mode & 0o777, 0o644)
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: originalLstat })
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('POSIX protection throws when the permission change cannot take effect', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'private-nochmod-'))
  const path = join(root, 'fixture.txt')
  writeFileSync(path, 'ordinary fixture')
  chmodSync(path, 0o644)
  const originalFchmod = fs.fchmodSync
  fs.fchmodSync = (() => {}) as typeof fs.fchmodSync
  syncBuiltinESMExports()
  try {
    assert.throws(() => protectPrivatePath(path, 'darwin'), /Private storage permissions could not be enforced/)
  } finally {
    fs.fchmodSync = originalFchmod
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
