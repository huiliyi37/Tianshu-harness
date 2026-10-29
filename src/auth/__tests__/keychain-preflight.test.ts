import { test } from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { __resetSecretCipherCache, createSecretCipher } from '../secure-store.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'keychain-preflight-'))
  const original = cp.execFileSync, fixedHome = process.env.CFFIXED_USER_HOME
  return { dir, close() {
    cp.execFileSync = original; syncBuiltinESMExports()
    if (fixedHome === undefined) delete process.env.CFFIXED_USER_HOME; else process.env.CFFIXED_USER_HOME = fixedHome
    __resetSecretCipherCache(); rmSync(dir, { recursive: true, force: true })
  } }
}
test('synthetic fixed user home is corrected at every security subprocess without changing the parent', () => {
  const f = fixture(), calls: Array<{ action: string; env: NodeJS.ProcessEnv }> = []
  const path = join(f.dir, 'fixture.keychain-db'); let key: string | undefined
  try {
    process.env.CFFIXED_USER_HOME = f.dir; writeFileSync(path, '')
    cp.execFileSync = ((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ action: args[0]!, env: options.env })
      if (args[0] === 'find-generic-password') { if (!key) throw Error('item absent'); return key }
      if (args[0] === 'default-keychain') return JSON.stringify(path)
      assert.equal(args[0], 'add-generic-password'); key = args[args.indexOf('-w') + 1]; return ''
    }) as typeof cp.execFileSync; syncBuiltinESMExports()
    const cipher = createSecretCipher(f.dir, 'keychain'), plain = Buffer.from('synthetic')
    const encrypted = cipher.encrypt(plain)
    assert.equal(cipher.backend, 'keychain'); assert.deepEqual(cipher.decrypt(encrypted), plain)
    assert.equal(process.env.CFFIXED_USER_HOME, f.dir)
    assert.deepEqual(calls.map(call => call.action), ['find-generic-password', 'default-keychain', 'add-generic-password'])
    for (const call of calls) {
      assert.equal(call.env.HOME, userInfo().homedir)
      assert.equal(call.env.CFFIXED_USER_HOME, userInfo().homedir)
    }
    assert.equal(existsSync(join(f.dir, '.token-key')), false)
  } finally { f.close() }
})
test('missing default keychain blocks creation without creating a fallback key', () => {
  const f = fixture(), calls: string[] = []
  try {
    process.env.CFFIXED_USER_HOME = userInfo().homedir
    cp.execFileSync = ((file: string, args: string[]) => { calls.push(args[0]!); throw Error('fixture keychain unavailable') }) as unknown as typeof cp.execFileSync
    syncBuiltinESMExports()
    assert.throws(() => createSecretCipher(f.dir, 'keychain').encrypt(Buffer.from('synthetic')), /default keychain/i)
    assert.equal(calls.includes('add-generic-password'), false)
    assert.equal(existsSync(join(f.dir, '.token-key')), false)
  } finally { f.close() }
})
test('a stale default keychain path cannot reach the write command', () => {
  const f = fixture(), calls: string[] = []
  try {
    process.env.CFFIXED_USER_HOME = userInfo().homedir
    cp.execFileSync = ((file: string, args: string[]) => {
      calls.push(args[0]!)
      if (args[0] === 'default-keychain') return JSON.stringify(join(f.dir, 'missing.keychain-db'))
      if (args[0] === 'find-generic-password') throw Error('item absent')
      return ''
    }) as typeof cp.execFileSync; syncBuiltinESMExports()
    assert.throws(() => createSecretCipher(f.dir, 'keychain').encrypt(Buffer.from('synthetic')), /default keychain/i)
    assert.equal(calls.includes('add-generic-password'), false)
    assert.equal(existsSync(join(f.dir, '.token-key')), false)
  } finally { f.close() }
})
test('a valid default keychain permits creating an encrypted keychain-backed credential', () => {
  const f = fixture(), path = join(f.dir, 'fixture.keychain-db'); let key: string | undefined
  try {
    process.env.CFFIXED_USER_HOME = userInfo().homedir; writeFileSync(path, '')
    cp.execFileSync = ((file: string, args: string[]) => {
      if (args[0] === 'default-keychain') return JSON.stringify(path)
      if (args[0] === 'find-generic-password') { if (!key) throw Error('item absent'); return key }
      assert.equal(args[0], 'add-generic-password'); key = args[args.indexOf('-w') + 1]; return ''
    }) as typeof cp.execFileSync; syncBuiltinESMExports()
    const cipher = createSecretCipher(f.dir, 'keychain'), plain = Buffer.from('synthetic')
    const encrypted = cipher.encrypt(plain)
    assert.equal(cipher.backend, 'keychain'); assert.deepEqual(cipher.decrypt(encrypted), plain)
    assert.equal(existsSync(join(f.dir, '.token-key')), false)
  } finally { f.close() }
})
