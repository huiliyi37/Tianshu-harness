/**
 * 凭据落盘加密测试（向量⑥：明文 refresh token）。
 *
 * 全部用例强制 `RIVET_TOKEN_STORE=local-key`：不 spawn `security`/`powershell`，
 * 保证 CI 与沙箱里确定、快速、无副作用。真机密钥库路径由
 * `resolveSecretBackend` 的纯函数用例 + 手工验收覆盖（见 docs/security）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SECRET_SIDECAR_FILES,
  __resetSecretCipherCache,
  createSecretCipher,
  decodeSecret,
  encodeSecret,
  resolveSecretBackend,
} from '../secure-store.js'
import { TokenStore, type TokenData } from '../token-store.js'

const TOKEN: TokenData = {
  accessToken: 'at-super-secret-value',
  refreshToken: 'rt-super-secret-value',
  expiresAt: 1_900_000_000_000,
}

let dir: string
let prevBackend: string | undefined

beforeEach(() => {
  prevBackend = process.env.RIVET_TOKEN_STORE
  process.env.RIVET_TOKEN_STORE = 'local-key'
  __resetSecretCipherCache()
  dir = mkdtempSync(join(tmpdir(), 'rivet-secure-store-'))
})

afterEach(() => {
  if (prevBackend === undefined) delete process.env.RIVET_TOKEN_STORE
  else process.env.RIVET_TOKEN_STORE = prevBackend
  __resetSecretCipherCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveSecretBackend', () => {
  it('显式 RIVET_TOKEN_STORE 优先于平台默认', () => {
    for (const b of ['keychain', 'dpapi', 'local-key', 'plaintext'] as const) {
      process.env.RIVET_TOKEN_STORE = b
      assert.equal(resolveSecretBackend('linux'), b)
    }
    process.env.RIVET_TOKEN_STORE = 'bogus'
    assert.equal(resolveSecretBackend('darwin'), 'keychain', '非法值应回落到平台默认')
  })

  it('平台默认：macOS 钥匙串 / Windows DPAPI / 其它本机密钥文件', () => {
    delete process.env.RIVET_TOKEN_STORE
    assert.equal(resolveSecretBackend('darwin'), 'keychain')
    assert.equal(resolveSecretBackend('win32'), 'dpapi')
    assert.equal(resolveSecretBackend('linux'), 'local-key')
  })
})

describe('信封编解码', () => {
  it('加解密往返一致', () => {
    const cipher = createSecretCipher(dir, 'local-key')
    const plain = JSON.stringify(TOKEN)
    const encoded = encodeSecret(cipher, plain)
    assert.equal(decodeSecret(cipher, encoded), plain)
  })

  it('密文里不含任何明文 token（这是本模块存在的唯一理由）', () => {
    const cipher = createSecretCipher(dir, 'local-key')
    const encoded = encodeSecret(cipher, JSON.stringify(TOKEN))
    assert.ok(!encoded.includes('at-super-secret-value'), '密文里出现明文 accessToken')
    assert.ok(!encoded.includes('rt-super-secret-value'), '密文里出现明文 refreshToken')
    assert.ok(encoded.includes('aes-256-gcm'), '信封应声明算法（可诊断）')
  })

  it('同一明文两次加密结果不同（随机 IV，避免密文可比对）', () => {
    const cipher = createSecretCipher(dir, 'local-key')
    const a = encodeSecret(cipher, JSON.stringify(TOKEN))
    const b = encodeSecret(cipher, JSON.stringify(TOKEN))
    assert.notEqual(a, b)
  })

  it('密文被篡改 → 解密返回 null（AEAD 完整性，不返回垃圾数据）', () => {
    const cipher = createSecretCipher(dir, 'local-key')
    const encoded = encodeSecret(cipher, JSON.stringify(TOKEN))
    const parsed = JSON.parse(encoded) as { d: string }
    const blob = Buffer.from(parsed.d, 'base64')
    const last = blob.length - 1
    blob[last] = (blob[last] ?? 0) ^ 0xff // 翻转最后一字节
    parsed.d = blob.toString('base64')
    assert.equal(decodeSecret(cipher, JSON.stringify(parsed)), null)
  })

  it('换了密钥（换目录/换机器）→ 解密返回 null，不抛异常', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'rivet-secure-store-other-'))
    try {
      const cipherA = createSecretCipher(dir, 'local-key')
      const cipherB = createSecretCipher(otherDir, 'local-key')
      const encoded = encodeSecret(cipherA, JSON.stringify(TOKEN))
      assert.equal(decodeSecret(cipherB, encoded), null)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('非 JSON 内容 → null（不把垃圾当凭据）', () => {
    const cipher = createSecretCipher(dir, 'local-key')
    assert.equal(decodeSecret(cipher, 'not json at all'), null)
  })

  it('plaintext 后端保持旧行为（显式排障档）', () => {
    const cipher = createSecretCipher(dir, 'plaintext')
    const plain = JSON.stringify(TOKEN)
    assert.equal(encodeSecret(cipher, plain), plain, 'plaintext 档不加信封')
    assert.equal(decodeSecret(cipher, plain), plain)
  })
})

describe('TokenStore 集成', () => {
  it('save → load 往返，文件里没有明文 token', () => {
    const store = new TokenStore(dir, 'account')
    store.save(TOKEN)

    const raw = readFileSync(join(dir, 'account.json'), 'utf8')
    assert.ok(!raw.includes('at-super-secret-value'), 'accessToken 明文落盘')
    assert.ok(!raw.includes('rt-super-secret-value'), 'refreshToken 明文落盘')

    assert.deepEqual(store.load(), TOKEN)
  })

  it('凭据文件权限仍是 0600（POSIX 纵深防御）', { skip: process.platform === 'win32' ? 'Windows 无 POSIX mode 语义（NTFS 由 ACL 决定访问控制，statSync().mode 恒 0666 档）；实测本机 chmod 0600 不生效，故跳过' : false }, () => {
    const store = new TokenStore(dir, 'account')
    store.save(TOKEN)
    const mode = statSync(join(dir, 'account.json')).mode & 0o777
    assert.equal(mode, 0o600, `实际 ${mode.toString(8)}`)
  })

  it('旧明文凭据可读，且下次保存自动升级为密文（无需迁移脚本）', () => {
    const path = join(dir, 'account.json')
    writeFileSync(path, JSON.stringify(TOKEN, null, 2), { mode: 0o600 })

    const store = new TokenStore(dir, 'account')
    assert.deepEqual(store.load(), TOKEN, '旧明文必须还能读到——否则所有存量用户被强制登出')

    store.save(store.load()!)
    const raw = readFileSync(path, 'utf8')
    assert.ok(!raw.includes('rt-super-secret-value'), '保存后应已升级为密文')
    assert.deepEqual(store.load(), TOKEN)
  })

  it('密钥文件丢失 + 密文仍在 → load 返回 null（按未登录处理，不崩）', () => {
    const store = new TokenStore(dir, 'account')
    store.save(TOKEN)
    unlinkSync(join(dir, SECRET_SIDECAR_FILES.localKey))
    __resetSecretCipherCache()

    const fresh = new TokenStore(dir, 'account')
    assert.equal(fresh.load(), null)
  })

  it('clear 删除凭据文件（登出语义不变）', () => {
    const store = new TokenStore(dir, 'account')
    store.save(TOKEN)
    store.clear()
    assert.equal(store.load(), null)
  })

  it('多个 provider 共用同一数据密钥（都能解，互不干扰）', () => {
    const a = new TokenStore(dir, 'account')
    const b = new TokenStore(dir, 'codex')
    a.save({ ...TOKEN, accessToken: 'at-a' })
    b.save({ ...TOKEN, accessToken: 'at-b' })
    assert.equal(a.load()?.accessToken, 'at-a')
    assert.equal(b.load()?.accessToken, 'at-b')
  })

  it('密钥文件权限 0600', { skip: process.platform === 'win32' ? 'Windows 无 POSIX mode 语义（NTFS 由 ACL 决定访问控制）；该档仅 POSIX 平台使用' : false }, () => {
    new TokenStore(dir, 'account').save(TOKEN)
    const keyPath = join(dir, SECRET_SIDECAR_FILES.localKey)
    const mode = statSync(keyPath).mode & 0o777
    assert.equal(mode, 0o600, `密钥文件权限 ${mode.toString(8)}`)
  })

  it('baseDir 不存在时自动创建（首次登录路径）', () => {
    const nested = join(dir, 'a', 'b')
    mkdirSync(dir, { recursive: true })
    const store = new TokenStore(nested, 'account')
    store.save(TOKEN)
    assert.deepEqual(store.load(), TOKEN)
  })
})
