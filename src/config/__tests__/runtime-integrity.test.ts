import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertAsciiPaths,
  computeBundle,
  computeBundleHashFromMap,
  shouldIncludePath,
  sha256Hex,
  verifyIntegrityManifest,
  verifyManifestSignature,
  type IntegrityManifest,
} from '../runtime-integrity.js'
import { makeTestSigner } from './grant-fixtures.js'

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../desktop/integrity-conformance/fixtures/conformance.json', import.meta.url)
)

/**
 * 跨语言夹具由桌面端仓（desktop/integrity-conformance/）提供，与 Rust 侧消费同一份；
 * 公共 harness 镜像不含该目录。缺夹具时依赖它的两组用例整组跳过（同 bash-windows-smoke
 * 的 winOnly 口径），而不是 ENOENT 假红。枚举规则与摘要格式两组用例不依赖夹具，仍全量运行。
 */
const fixturePresent = existsSync(FIXTURE_PATH)
const skipNoFixture = fixturePresent
  ? false
  : '本仓无 desktop/integrity-conformance/fixtures/conformance.json（跨仓夹具缺失）'

interface ConformanceFixture {
  mode: 'code' | 'full'
  testPublicKeyB64: string
  files: Record<string, string>
  expectedFileCount: number
  expectedBundleHash: string
  expectedIncludedPaths: string[]
  expectedTamperedPath: string
  manifest: IntegrityManifest
}

function loadFixture(): ConformanceFixture {
  // 与 Rust 侧 desktop/integrity-conformance/tests/conformance.rs 消费**同一个**
  // fixture —— 两边各自铺树、各自算摘要，任一侧改了规则都会红。
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ConformanceFixture
}

describe('shouldIncludePath — 枚举规则（与 integrity.rs 同表）', () => {
  const cases: Array<[string, boolean, boolean]> = [
    ['cli/entry.js', true, true],
    ['main.js', true, true],
    ['node_modules/pkg/index.js', false, true],
    ['node_modules', false, true],
    ['integrity.json', false, false],
    ['package.json', false, false],
    ['tmp/scratch.js', false, false],
    ['.tmp/x.js', false, false],
    ['logs/run.log', false, false],
    ['a/compile-cache/x', false, false],
    ['.cache/x', false, false],
    ['debug.log', false, false],
    ['x.tmp', false, false],
    ['.DS_Store', false, false],
    ['a/.DS_Store', false, false],
    ['agent/loop.js', true, true],
    ['./main.js', true, true],
    ['', false, false],
  ]
  for (const [path, code, full] of cases) {
    it(`${JSON.stringify(path)} → code=${code} full=${full}`, () => {
      assert.equal(shouldIncludePath(path, 'code'), code)
      assert.equal(shouldIncludePath(path, 'full'), full)
    })
  }
})

describe('摘要计算 — 格式锁定', () => {
  it('与路径顺序无关（内部先排序）', () => {
    const a = { 'b.js': '22', 'a.js': '11' }
    const b = { 'a.js': '11', 'b.js': '22' }
    assert.equal(computeBundleHashFromMap(a), computeBundleHashFromMap(b))
  })

  it('格式 = sha256("a.js\\0" + "11" + "\\n" + "b.js\\0" + "22" + "\\n")（与 Rust 测试同一字面量）', () => {
    const expect = sha256Hex('a.js\x0011\nb.js\x0022\n')
    assert.equal(computeBundleHashFromMap({ 'a.js': '11', 'b.js': '22' }), expect)
  })

  it('拒绝非 ASCII 路径（跨语言排序/编码会分叉）', () => {
    assert.throws(() => assertAsciiPaths({ '中文.js': 'aa' }), /非 ASCII/)
    assert.doesNotThrow(() => assertAsciiPaths({ 'cli/entry.js': 'aa' }))
  })
})

describe('跨语言一致性 fixture（JS 侧消费 Rust 侧同一份）', { skip: skipNoFixture }, () => {
  let fixture: ConformanceFixture
  let stage: string

  before(() => {
    fixture = loadFixture()
    stage = mkdtempSync(join(tmpdir(), 'rivet-integrity-js-'))
    for (const [rel, content] of Object.entries(fixture.files)) {
      const abs = join(stage, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
  })

  after(() => {
    rmSync(stage, { recursive: true, force: true })
  })

  it('枚举出的文件集合与 Rust 侧一致', () => {
    const { files } = computeBundle(stage, fixture.mode)
    assert.deepEqual(Object.keys(files).sort(), [...fixture.expectedIncludedPaths].sort())
  })

  it('bundleHash / fileCount 与 Rust 侧逐字节一致', () => {
    const { bundleHash, fileCount } = computeBundle(stage, fixture.mode)
    assert.equal(fileCount, fixture.expectedFileCount)
    assert.equal(bundleHash, fixture.expectedBundleHash)
  })

  it('验签通过（清单由发布管线同一消息格式签出）', () => {
    const res = verifyIntegrityManifest(stage, {
      mode: fixture.mode,
      publicKeyB64: fixture.testPublicKeyB64,
      manifest: fixture.manifest,
    })
    assert.equal(res.ok, true, `reason=${res.reason}`)
    assert.equal(res.expectedHash, fixture.expectedBundleHash)
    assert.equal(res.actualHash, fixture.expectedBundleHash)
  })

  it('改动一个字节 → digest_mismatch 且定位到具体文件', () => {
    const tampered = mkdtempSync(join(tmpdir(), 'rivet-integrity-js-tamper-'))
    try {
      for (const [rel, content] of Object.entries(fixture.files)) {
        const abs = join(tampered, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
      writeFileSync(join(tampered, 'main.js'), 'console.log("patched by attacker")\n')
      const res = verifyIntegrityManifest(tampered, {
        mode: fixture.mode,
        publicKeyB64: fixture.testPublicKeyB64,
        manifest: fixture.manifest,
      })
      assert.equal(res.ok, false)
      assert.equal(res.reason, 'digest_mismatch')
      assert.ok(res.changed?.includes(fixture.expectedTamperedPath), `changed=${JSON.stringify(res.changed)}`)
    } finally {
      rmSync(tampered, { recursive: true, force: true })
    }
  })

  it('删文件 / 加文件同样被抓到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-integrity-js-addrm-'))
    try {
      for (const [rel, content] of Object.entries(fixture.files)) {
        const abs = join(dir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
      rmSync(join(dir, 'agent/loop.js'))
      writeFileSync(join(dir, 'backdoor.js'), 'export const pwn = true\n')
      const res = verifyIntegrityManifest(dir, {
        mode: fixture.mode,
        publicKeyB64: fixture.testPublicKeyB64,
        manifest: fixture.manifest,
      })
      assert.equal(res.ok, false)
      assert.ok(res.changed?.includes('-agent/loop.js'), `changed=${JSON.stringify(res.changed)}`)
      assert.ok(res.changed?.includes('+backdoor.js'), `changed=${JSON.stringify(res.changed)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('符号链接不参与摘要（不能靠链到 bundle 外绕过）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-integrity-js-link-'))
    try {
      for (const rel of fixture.expectedIncludedPaths) {
        const abs = join(dir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, fixture.files[rel] ?? '')
      }
      symlinkSync('/etc/hosts', join(dir, 'linked.js'))
      const { bundleHash, fileCount } = computeBundle(dir, fixture.mode)
      assert.equal(fileCount, fixture.expectedFileCount, '符号链接被算进去了')
      assert.equal(bundleHash, fixture.expectedBundleHash)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('清单校验 — 攻击面', { skip: skipNoFixture }, () => {
  let fixture: ConformanceFixture
  let stage: string

  before(() => {
    fixture = loadFixture()
    stage = mkdtempSync(join(tmpdir(), 'rivet-integrity-js-manifest-'))
    for (const [rel, content] of Object.entries(fixture.files)) {
      const abs = join(stage, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
  })

  after(() => {
    rmSync(stage, { recursive: true, force: true })
  })

  const verify = (manifest: IntegrityManifest, mode: 'code' | 'full' = 'code') =>
    verifyIntegrityManifest(stage, { mode, publicKeyB64: fixture.testPublicKeyB64, manifest })

  it('手改被签名保护的 bundleHash → bad_signature（绝不走到摘要比对）', () => {
    const forged: IntegrityManifest = { ...fixture.manifest, bundleHash: '0'.repeat(64) }
    assert.equal(verify(forged).reason, 'bad_signature')
  })

  it('手改 fileCount → bad_signature', () => {
    const forged: IntegrityManifest = { ...fixture.manifest, fileCount: fixture.manifest.fileCount + 1 }
    assert.equal(verify(forged).reason, 'bad_signature')
  })

  it('自签自验（攻击者换一把公钥）→ 验签失败：公钥编译在原生二进制/常量里', () => {
    const attackerKey = makeTestSigner().publicKeyB64
    const res = verifyIntegrityManifest(stage, {
      mode: 'code',
      publicKeyB64: attackerKey,
      manifest: fixture.manifest,
    })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'bad_signature')
  })

  it('product / mode 不匹配 → 在算摘要前就拒绝', () => {
    assert.equal(verify({ ...fixture.manifest, product: 'tianshu-cli' }).reason, 'product_mismatch')
    assert.equal(verify(fixture.manifest, 'full').reason, 'mode_mismatch')
  })

  it('清单缺失 / 非法 JSON → manifest_missing / manifest_malformed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'rivet-integrity-js-empty-'))
    try {
      assert.equal(
        verifyIntegrityManifest(empty, { publicKeyB64: fixture.testPublicKeyB64 }).reason,
        'manifest_missing'
      )
      writeFileSync(join(empty, 'integrity.json'), '{ not json')
      assert.equal(
        verifyIntegrityManifest(empty, { publicKeyB64: fixture.testPublicKeyB64 }).reason,
        'manifest_malformed'
      )
      writeFileSync(join(empty, 'integrity.json'), JSON.stringify({ v: 1 }))
      assert.equal(
        verifyIntegrityManifest(empty, { publicKeyB64: fixture.testPublicKeyB64 }).reason,
        'manifest_malformed'
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('verifyManifestSignature 对篡改 sig 返回 false 而不抛异常', () => {
    assert.equal(verifyManifestSignature(fixture.manifest, fixture.testPublicKeyB64), true)
    assert.equal(
      verifyManifestSignature({ ...fixture.manifest, sig: 'AAAA' }, fixture.testPublicKeyB64),
      false
    )
  })
})
