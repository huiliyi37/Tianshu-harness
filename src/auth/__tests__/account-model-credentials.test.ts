import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __resetSecretCipherCache, createSecretCipher, SECRET_SIDECAR_FILES } from '../secure-store.js'
import { TokenStore } from '../token-store.js'
import { readSecret, writeSecret, secretsPath } from '../../config/secrets-store.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'account-model-credentials-'))
  const backend = process.env.RIVET_TOKEN_STORE
  const original = childProcess.execFileSync
  return { dir, close() {
    childProcess.execFileSync = original
    syncBuiltinESMExports()
    if (backend === undefined) delete process.env.RIVET_TOKEN_STORE
    else process.env.RIVET_TOKEN_STORE = backend
    __resetSecretCipherCache()
    rmSync(dir, { recursive: true, force: true })
  } }
}

test('account re-login during a locked Keychain never replaces the key for saved models', () => {
  const f = fixture()
  try {
    let locked = false
    const originalKey = Buffer.alloc(32, 7).toString('hex')
    let storedKey = originalKey
    const keychainPath = join(f.dir, 'fixture.keychain-db')
    writeFileSync(keychainPath, '')
    childProcess.execFileSync = ((file: string, args: string[]) => {
      assert.equal(file, 'security', 'never call the real OS key store')
      if (args[0] === 'default-keychain') return JSON.stringify(keychainPath)
      if (args[0] === 'find-generic-password') {
        if (locked) throw new Error('Keychain locked')
        return storedKey
      }
      assert.equal(args[0], 'add-generic-password')
      if (!args.includes('-U')) throw new Error('item already exists')
      storedKey = args[args.indexOf('-w') + 1]!
      return ''
    }) as typeof childProcess.execFileSync
    syncBuiltinESMExports()
    process.env.RIVET_TOKEN_STORE = 'keychain'
    __resetSecretCipherCache()
    writeSecret('model', 'fixture-model-key', f.dir)
    const before = readFileSync(secretsPath(f.dir))
    locked = true
    __resetSecretCipherCache()
    new TokenStore(f.dir, 'account').save({ accessToken: 'fixture-login', expiresAt: 42 })
    assert.equal(storedKey === originalKey, true, 'account login must not replace a shared model encryption key')
    assert.deepEqual(readFileSync(secretsPath(f.dir)), before)
    locked = false
    // Recover in the same process too; the temporary fallback must not stick.
    assert.equal(readSecret('model', f.dir), 'fixture-model-key')
    assert.equal(new TokenStore(f.dir, 'account').load()?.accessToken, 'fixture-login')
    __resetSecretCipherCache()
    assert.equal(readSecret('model', f.dir), 'fixture-model-key')
  } finally { f.close() }
})

test('fallback model credentials survive restart and account login after Keychain becomes available', () => {
  const f = fixture()
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    writeSecret('model', 'fixture-fallback-key', f.dir)
    __resetSecretCipherCache()
    process.env.RIVET_TOKEN_STORE = 'keychain'
    childProcess.execFileSync = ((file: string) => {
      assert.equal(file, 'security')
      return Buffer.alloc(32, 9).toString('hex')
    }) as typeof childProcess.execFileSync
    syncBuiltinESMExports()
    new TokenStore(f.dir, 'account').save({ accessToken: 'fixture-relogin', expiresAt: 42 })
    assert.equal(readSecret('model', f.dir), 'fixture-fallback-key')
    writeSecret('second-model', 'fixture-second-key', f.dir)
    assert.equal(readSecret('model', f.dir), 'fixture-fallback-key')
  } finally { f.close() }
})

test('reading credentials does not generate a replacement local key; writing preserves an unreadable key', () => {
  const f = fixture()
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    writeSecret('model', 'fixture-model', f.dir)
    const keyPath = join(f.dir, SECRET_SIDECAR_FILES.localKey)
    writeFileSync(keyPath, 'damaged-key')
    __resetSecretCipherCache()
    assert.equal(readSecret('model', f.dir), undefined)
    assert.equal(readFileSync(keyPath, 'utf8'), 'damaged-key')
    assert.throws(() => new TokenStore(f.dir, 'account').save({ accessToken: 'fixture', expiresAt: 42 }))
    assert.equal(readFileSync(keyPath, 'utf8'), 'damaged-key')
  } finally { f.close() }
})

test('DPAPI initialization never replaces an existing undecodable key', () => {
  const f = fixture()
  try {
    const path = join(f.dir, SECRET_SIDECAR_FILES.dpapiKey)
    writeFileSync(path, 'existing-invalid-key')
    childProcess.execFileSync = ((file: string) => {
      assert.equal(file, 'powershell.exe')
      return Buffer.alloc(1).toString('base64')
    }) as typeof childProcess.execFileSync
    syncBuiltinESMExports()
    createSecretCipher(f.dir, 'dpapi').encrypt(Buffer.from('fixture'))
    assert.equal(readFileSync(path, 'utf8'), 'existing-invalid-key')
  } finally { f.close() }
})

test('adding a model refuses to replace an existing unreadable credentials store', () => {
  const f = fixture()
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    const path = secretsPath(f.dir)
    writeFileSync(path, 'damaged-credential-store')
    assert.throws(() => writeSecret('new-model', 'fixture-new-key', f.dir), /refusing to overwrite/)
    assert.equal(readFileSync(path, 'utf8'), 'damaged-credential-store')
  } finally { f.close() }
})

test('adding a model preserves existing ciphertext when its encryption key is missing', () => {
  const f = fixture()
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    writeSecret('saved-model', 'fixture-saved-key', f.dir)
    const before = readFileSync(secretsPath(f.dir))
    rmSync(join(f.dir, SECRET_SIDECAR_FILES.localKey))
    __resetSecretCipherCache()
    assert.throws(() => writeSecret('new-model', 'fixture-new-key', f.dir), /refusing to overwrite/)
    assert.deepEqual(readFileSync(secretsPath(f.dir)), before)
  } finally { f.close() }
})

test('Windows fallback credentials remain readable after DPAPI recovers and across restart', () => {
  const f = fixture()
  try {
    process.env.RIVET_TOKEN_STORE = 'local-key'
    writeSecret('model', 'fixture-windows-key', f.dir)
    __resetSecretCipherCache()
    process.env.RIVET_TOKEN_STORE = 'dpapi'
    childProcess.execFileSync = ((file: string, args: string[]) => {
      assert.equal(file, 'powershell.exe')
      const script = args[args.indexOf('-Command') + 1]!
      return script.match(/FromBase64String\('([^']+)'\)/)![1]!
    }) as typeof childProcess.execFileSync
    syncBuiltinESMExports()
    new TokenStore(f.dir, 'account').save({ accessToken: 'fixture-windows-login', expiresAt: 42 })
    __resetSecretCipherCache()
    assert.equal(new TokenStore(f.dir, 'account').load()?.accessToken, 'fixture-windows-login')
    assert.equal(readSecret('model', f.dir), 'fixture-windows-key')
  } finally { f.close() }
})

test('locked vault reads are bounded and recover in the same process after unlocking', () => {
  const f = fixture()
  const originalNow = Date.now
  try {
    let now = originalNow(), locked = false, reads = 0
    Date.now = () => now
    childProcess.execFileSync = ((file: string, args: string[]) => {
      assert.equal(file, 'security')
      assert.equal(args[0], 'find-generic-password', 'reading must never create a key')
      reads++
      if (locked) throw new Error('locked')
      return Buffer.alloc(32, 3).toString('hex')
    }) as typeof childProcess.execFileSync
    syncBuiltinESMExports()
    process.env.RIVET_TOKEN_STORE = 'keychain'
    writeSecret('model', 'fixture-unlock-key', f.dir)
    __resetSecretCipherCache()
    locked = true
    reads = 0
    assert.equal(readSecret('model', f.dir), undefined)
    assert.equal(readSecret('model', f.dir), undefined)
    assert.equal(reads, 1)
    locked = false
    now += 5001
    assert.equal(readSecret('model', f.dir), 'fixture-unlock-key')
  } finally { Date.now = originalNow; f.close() }
})
