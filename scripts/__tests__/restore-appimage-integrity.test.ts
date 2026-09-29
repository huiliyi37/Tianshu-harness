import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LICENSE_PRODUCT } from '../../src/config/license-keys.js'
import {
  INTEGRITY_MANIFEST_FILENAME,
  INTEGRITY_MANIFEST_VERSION,
  computeBundle,
  integritySigningMessage,
  verifyIntegrityManifest,
  type IntegrityManifest,
  type IntegrityMode,
} from '../../src/config/runtime-integrity.js'
import { applyRestore, planRestore, restoreBundleIfNeeded } from '../restore-appimage-integrity.js'

const MODE: IntegrityMode = 'code'

function makeKeyPair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return { privateKey, publicKeyB64: spki.subarray(spki.length - 32).toString('base64') }
}

function signManifest(dir: string, privateKey: KeyObject): IntegrityManifest {
  const { files, bundleHash, fileCount } = computeBundle(dir, MODE)
  const base = {
    v: INTEGRITY_MANIFEST_VERSION,
    product: LICENSE_PRODUCT,
    mode: MODE,
    createdAt: 1,
    bundleHash,
    fileCount,
    files,
  }
  const sig = cryptoSign(null, Buffer.from(integritySigningMessage(base), 'utf8'), privateKey).toString('base64url')
  return { ...base, sig }
}

interface Fixture {
  root: string
  source: string
  bundle: string
  privateKey: KeyObject
  publicKeyB64: string
  native: string
}

/** 造一份最小「构建源 dist/ + 包内 rivet-runtime/」fixture，并写入签名清单。 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rivet-restore-'))
  const source = join(root, 'dist')
  const bundle = join(root, 'bundle')
  for (const dir of [join(source, 'native'), join(bundle, 'native')]) mkdirSync(dir, { recursive: true })

  writeFileSync(join(source, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(bundle, 'app.js'), 'console.log(1)\n')
  // 原生模块造在两侧同字节，权限 0755（模拟发行包里的可执行位）
  writeFileSync(join(source, 'native', 'x.node'), 'ELF-ORIGINAL-BYTES')
  writeFileSync(join(bundle, 'native', 'x.node'), 'ELF-ORIGINAL-BYTES')
  chmodSync(join(source, 'native', 'x.node'), 0o755)
  chmodSync(join(bundle, 'native', 'x.node'), 0o755)

  const { privateKey, publicKeyB64 } = makeKeyPair()
  const manifest = signManifest(bundle, privateKey)
  writeFileSync(join(bundle, INTEGRITY_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2))
  return { root, source, bundle, privateKey, publicKeyB64, native: join(bundle, 'native', 'x.node') }
}

/** 模拟 linuxdeploy 的 patchelf：改写字节（追加 $ORIGIN rpath 痕迹）。 */
function simulateTauriRewrite(nativePath: string): void {
  appendFileSync(nativePath, '\0$ORIGIN')
}

function cleanup(f: { root: string }): void {
  rmSync(f.root, { recursive: true, force: true })
}

test('planRestore：字节一致时报空计划', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  const result = verifyIntegrityManifest(f.bundle, { mode: MODE, publicKeyB64: f.publicKeyB64 })
  assert.equal(result.ok, true, `fixture 应一开始就通过校验，实得 ${result.reason}`)

  const plan = planRestore({ bundle: f.bundle, source: f.source, manifest: result.manifest!, mode: MODE })
  assert.deepEqual(plan.restorable, [])
  assert.deepEqual(plan.blocked, [])
})

test('restoreBundleIfNeeded：被改写过的文件按构建源字节复原，权限位保持，复验通过', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  const broken = verifyIntegrityManifest(f.bundle, { mode: MODE, publicKeyB64: f.publicKeyB64 })
  assert.equal(broken.ok, false)
  assert.equal(broken.reason, 'digest_mismatch')
  assert.deepEqual(broken.changed, ['~native/x.node'])

  const outcome = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(outcome.status, 'restored', JSON.stringify(outcome))
  assert.deepEqual(outcome.restored, ['native/x.node'])

  assert.equal(readFileSync(f.native, 'utf8'), 'ELF-ORIGINAL-BYTES')
  if (process.platform !== 'win32') {
    // NTFS 不表示 Unix 可执行位（chmod 无效果、stat.mode 由扩展名推断）——
    // 权限保持断言只在 POSIX 文件系统上有意义；恢复逻辑本身全平台共用。
    assert.equal(statSync(f.native).mode & 0o777, 0o755, '恢复后必须保住可执行位')
  }
  assert.equal(verifyIntegrityManifest(f.bundle, { mode: MODE, publicKeyB64: f.publicKeyB64 }).ok, true)
})

test('restoreBundleIfNeeded：已一致时是空操作（幂等）', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  const first = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(first.status, 'ok')
  const before = statSync(f.native).mtimeMs
  const second = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(second.status, 'ok')
  assert.equal(statSync(f.native).mtimeMs, before, '一致的 bundle 不该被重写')
})

test('restoreBundleIfNeeded：构建源缺该文件时 fail-closed，绝不动包内文件', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  rmSync(join(f.source, 'native', 'x.node'))

  const outcome = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(outcome.status, 'blocked')
  assert.match(outcome.blocked[0]!.why, /source-missing/)
  assert.equal(readFileSync(f.native, 'utf8'), 'ELF-ORIGINAL-BYTES\0$ORIGIN', '被阻断时不应改写任何东西')
})

test('restoreBundleIfNeeded：构建源字节与清单不符时拒绝用它覆盖', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  writeFileSync(join(f.source, 'native', 'x.node'), 'TAMPERED-SOURCE')

  const outcome = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(outcome.status, 'blocked')
  assert.match(outcome.blocked[0]!.why, /source-digest-mismatch/)
  assert.equal(readFileSync(f.native, 'utf8'), 'ELF-ORIGINAL-BYTES\0$ORIGIN')
})

test('restoreBundleIfNeeded：包内多出清单之外的文件时不自动删（fail-closed）', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  writeFileSync(join(f.bundle, 'extra.txt'), 'not in manifest')

  const outcome = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(outcome.status, 'blocked')
  assert.match(outcome.blocked[0]!.why, /extra-file/)
  assert.equal(readFileSync(join(f.bundle, 'extra.txt'), 'utf8'), 'not in manifest')
})

test('restoreBundleIfNeeded：清单签名不对时直接拒绝，不做任何恢复', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  const manifestPath = join(f.bundle, INTEGRITY_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IntegrityManifest
  manifest.sig = Buffer.alloc(64, 7).toString('base64url')
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const outcome = restoreBundleIfNeeded({ bundle: f.bundle, source: f.source, publicKeyB64: f.publicKeyB64, mode: MODE })
  assert.equal(outcome.status, 'blocked')
  assert.equal(outcome.reason, 'bad_signature')
  assert.equal(readFileSync(f.native, 'utf8'), 'ELF-ORIGINAL-BYTES\0$ORIGIN')
})

test('restoreBundleIfNeeded：dry-run 只出计划不写盘', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  const outcome = restoreBundleIfNeeded({
    bundle: f.bundle,
    source: f.source,
    publicKeyB64: f.publicKeyB64,
    mode: MODE,
    dryRun: true,
  })
  assert.equal(outcome.status, 'restored')
  assert.deepEqual(outcome.restored, ['native/x.node'])
  assert.equal(readFileSync(f.native, 'utf8'), 'ELF-ORIGINAL-BYTES\0$ORIGIN', 'dry-run 必须不写盘')
})

test('planRestore：拒绝清单里逃出 bundle 的相对路径（纵深防御）', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  const manifestPath = join(f.bundle, INTEGRITY_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IntegrityManifest
  // 伪造一条越界条目 + 重新签名（等价于「被篡改过但签名自洽」的清单）
  manifest.files['../../etc/passwd'] = 'deadbeef'
  manifest.fileCount += 1
  const resigned = cryptoSign(
    null,
    Buffer.from(integritySigningMessage(manifest), 'utf8'),
    f.privateKey
  ).toString('base64url')
  manifest.sig = resigned
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const plan = planRestore({ bundle: f.bundle, source: f.source, manifest, mode: MODE })
  const escape = plan.blocked.find((b) => b.rel.includes('passwd'))
  assert.ok(escape, `越界条目应被阻断，实得 ${JSON.stringify(plan)}`)
  assert.match(escape.why, /unsafe-path/)
})

test('applyRestore 只动计划内的文件', (t) => {
  const f = makeFixture()
  t.after(() => cleanup(f))

  simulateTauriRewrite(f.native)
  const appJs = join(f.bundle, 'app.js')
  const appJsMtime = statSync(appJs).mtimeMs
  const manifest = JSON.parse(readFileSync(join(f.bundle, INTEGRITY_MANIFEST_FILENAME), 'utf8')) as IntegrityManifest

  const plan = planRestore({ bundle: f.bundle, source: f.source, manifest, mode: MODE })
  assert.deepEqual(
    plan.restorable.map((a) => a.rel),
    ['native/x.node']
  )
  const count = applyRestore(f.bundle, plan.restorable)
  assert.equal(count, 1)
  assert.equal(readFileSync(f.native, 'utf8'), 'ELF-ORIGINAL-BYTES')
  assert.equal(readFileSync(appJs, 'utf8'), 'console.log(1)\n')
  assert.equal(statSync(appJs).mtimeMs, appJsMtime, 'app.js 不在计划里就不该被重写')
})
