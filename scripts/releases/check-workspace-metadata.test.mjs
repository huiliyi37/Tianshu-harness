import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { digest } from './update-control.mjs'
import { validateWorkspaceMetadata, writeCatalog } from './check-workspace-metadata.mjs'

const fixture = () => {
  const version = '3.30.0', name = `Tianshu_${version}_x64-setup.exe`, bytes = Buffer.from('signed fixture')
  const url = `https://github.com/huiliyi37/Tianshu-harness/releases/download/v${version}/${name}`
  const source = { url, verified: true, size: bytes.length, sha256: digest(bytes), verifiedAt: '2026-10-11T00:00:00Z' }
  const catalog = { schemaVersion: 1, revision: 14, version, publishedAt: source.verifiedAt, artifacts: ['update', 'install'].map(purpose => ({ platform: 'windows-x86_64', purpose, fileName: name, size: bytes.length, sha256: source.sha256, ...(purpose === 'update' ? { signature: 'signed' } : {}), sources: { github: source } })) }
  const catalogBytes = Buffer.from(JSON.stringify(catalog) + '\n')
  return { packageVersion: '3.31.0', catalogBytes, control: { schemaVersion: 1, revision: 2, stable: { version, catalogSha256: digest(catalogBytes) }, revokedVersions: [] }, manifest: { version, pub_date: source.verifiedAt, platforms: { 'windows-x86_64': { url, signature: 'signed' } } }, catalog, bytes }
}

test('development version may lead stable; stable metadata keeps its exact pin', () => {
  assert.deepEqual(validateWorkspaceMetadata(fixture()), { stableVersion: '3.30.0', packageVersion: '3.31.0', platforms: 1 })
  assert.throws(() => validateWorkspaceMetadata({ ...fixture(), packageVersion: '3.29.0' }), /behind/)
})

test('reject revised or reformatted controlled bytes and candidate manifests in root', () => {
  const f = fixture()
  assert.throws(() => validateWorkspaceMetadata({ ...f, catalogBytes: Buffer.from(JSON.stringify(f.catalog, null, 2)) }), /immutable/)
  f.catalog.revision++
  assert.throws(() => validateWorkspaceMetadata({ ...f, catalogBytes: Buffer.from(JSON.stringify(f.catalog)) }), /immutable/)
  assert.throws(() => validateWorkspaceMetadata({ ...fixture(), manifest: { ...fixture().manifest, version: '3.31.0' } }), /versions differ/)
})

test('stable manifest cannot omit a platform, switch signatures or use an unverified source', () => {
  const f = fixture()
  assert.throws(() => validateWorkspaceMetadata({ ...f, manifest: { ...f.manifest, platforms: {} } }), /all catalog/)
  f.manifest.platforms['windows-x86_64'].signature = 'different'
  assert.throws(() => validateWorkspaceMetadata(f), /signature differs/)
  f.manifest.platforms['windows-x86_64'].signature = 'signed'
  f.manifest.platforms['windows-x86_64'].url = f.manifest.platforms['windows-x86_64'].url.replace('github.com', 'unverified.example')
  assert.throws(() => validateWorkspaceMetadata(f), /not verified/)
})

test('catalog writes preserve pinned formatting; modified proofs can only be saved as drafts', t => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), 'release-pin-write-')), file = join(root, 'release-catalog.json')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'update-control.json'), JSON.stringify(f.control))
  writeFileSync(file, f.catalogBytes)
  writeCatalog(file, f.catalog, root)
  assert.deepEqual(readFileSync(file), f.catalogBytes)
  f.catalog.revision++
  assert.throws(() => writeCatalog(file, f.catalog, root), /immutable/)
  assert.deepEqual(readFileSync(file), f.catalogBytes)
  writeCatalog(join(root, 'draft-catalog.json'), f.catalog, root)
  assert.equal(JSON.parse(readFileSync(join(root, 'draft-catalog.json'))).revision, 15)
})

test('generator CLI refuses a revision change before overwriting the pinned root file', t => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), 'release-pin-generator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'update-control.json'), JSON.stringify(f.control))
  writeFileSync(join(root, 'latest.json'), JSON.stringify(f.manifest))
  writeFileSync(join(root, 'release-catalog.json'), f.catalogBytes)
  writeFileSync(join(root, f.catalog.artifacts[0].fileName), f.bytes)
  writeFileSync(join(root, f.catalog.artifacts[0].fileName + '.sig'), 'signed')
  const module = new URL('./generate-catalog.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { main } from ${JSON.stringify(module)}
    globalThis.fetch = async () => new Response(JSON.stringify({ assets: ${JSON.stringify([{ name: f.catalog.artifacts[0].fileName, size: f.bytes.length, digest: 'sha256:' + digest(f.bytes) }])} }))
    process.argv = ['node', 'fixture', '--assets', '.', '--revision', '15']
    await main()
  `], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /immutable/)
  assert.deepEqual(readFileSync(join(root, 'release-catalog.json')), f.catalogBytes)
})
