import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sourceURL, stableVersion, validateCatalog } from './catalog.mjs'
import { sha256 } from './generate-catalog.mjs'
import { guardStablePublication } from './guard-stable-publication.mjs'
import { readRemote } from './publish-update-control.mjs'
import { assertPinnedCatalog, canonical, chooseControl, CONTROL_LIMIT, CONTROL_URLS, digest, validateControl } from './update-control.mjs'

const REPO = 'huiliyi37/Tianshu-harness'
const OSS_ROOT = 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/'
const fail = message => { throw Object.assign(new Error(message), {publicationStage: true}) }
const cli = (command, args, stage) => {
  try { return execFileSync(command, args, {stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 30 * 60 * 1000, windowsHide: true}) }
  catch { fail(`${stage} failed; command output withheld. Fix the publishing tool/network and retry the same release.`) }
}

function options(argv) {
  const result = {assetsOnly: false, assets: process.env.OSS_ASSET_DIR, control: 'update-control.json'}
  const fields = {'--version': 'version', '--catalog': 'catalog', '--manifest': 'manifest', '--assets': 'assets', '--control': 'control'}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--assets-only') result.assetsOnly = true
    else if (fields[argument]) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) fail('Missing publisher option value')
      result[fields[argument]] = value
    } else fail('Unknown publisher option')
  }
  return result
}

function metadataFile(path) {
  if (!/\.json$/i.test(basename(path)) || /(?:^|[._-])(env|credentials|token|secret)(?:[._-]|$)|private.*key/i.test(basename(path))) fail('Only public JSON metadata files may be read')
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size > CONTROL_LIMIT) fail('Public metadata must be a regular file of at most 256 KiB')
  return readFileSync(path)
}

function validateManifest(manifest, catalog, allowBackup = false) {
  const updates = catalog.artifacts.filter(artifact => artifact.purpose === 'update')
  if (manifest.version !== catalog.version || !updates.length || !manifest.platforms || Object.keys(manifest.platforms).length !== updates.length) fail('Manifest must cover exactly all catalog update platforms and version')
  for (const artifact of updates) {
    const entry = manifest.platforms[artifact.platform]
    if (!entry || entry.signature !== artifact.signature) fail('Manifest updater signature differs from catalog')
    const source = Object.entries(artifact.sources).find(([name, proof]) => proof.url === entry.url && (proof.verified || (allowBackup && name === 'oss')))
    const backupURL = OSS_ROOT + `tianshu/v${catalog.version}/${artifact.fileName}`
    if (!source && !(allowBackup && entry.url === backupURL)) fail('Manifest download source lacks catalog qualification')
    if (source?.[0] === 'atomgit' && (!source[1].qualificationVerified || !source[1].rangeSupported || !source[1].anonymous)) fail('AtomGit download source lacks manual qualification')
  }
  return manifest
}

async function publicRequest(url, request) {
  try { return await fetch(url, request) }
  catch { fail('Public metadata validation or I/O failed; external diagnostics withheld') }
}

async function publicMetadata(url) {
  try { return await readRemote(url, publicRequest) }
  catch (error) {
    if (error.publicationStage) throw error
    if (error.message === 'Metadata exceeds 256 KiB') fail(error.message)
    fail('Public metadata read failed; external diagnostics withheld')
  }
}

async function policy(version, bytes, previous) {
  try { await guardStablePublication(version, bytes, publicRequest) }
  catch (error) {
    if (error.publicationStage) throw error
    if (['This version is not the controlled stable release; use assets-only upload or controlled promotion', 'Controlled catalog bytes are immutable; finish or revoke rollout before replacing metadata', 'Metadata exceeds 256 KiB'].includes(error.message)) fail(error.message)
    fail('Update control read/validation failed; external diagnostics withheld')
  }
  const controls = []
  for (const url of CONTROL_URLS) {
    const body = await publicMetadata(url)
    if (body) controls.push(validateControl(JSON.parse(body)))
  }
  if (!controls.length) fail('Controlled stable publication requires initialized live update control')
  let selected
  try { selected = chooseControl(controls, previous) }
  catch (error) {
    if (/^UPDATE_POLICY_[A-Z_]+$/.test(error.message)) fail(error.message)
    fail('Update control selection failed; external diagnostics withheld')
  }
  if (selected.stable.version !== version) fail('This version is not the controlled stable release')
  assertPinnedCatalog(selected, bytes)
  return selected
}

async function descriptor(file, key, kind, immutable = true) {
  return {file, key, kind, immutable, size: statSync(file).size, sha256: await sha256(file)}
}

async function probe(entry, required = false) {
  let response
  try { response = await fetch(OSS_ROOT + entry.key, {signal: AbortSignal.timeout(30 * 60 * 1000), cache: 'no-store', credentials: 'omit', redirect: 'error'}) }
  catch { fail('Anonymous OSS read failed; no alternate or credential-bearing probe is allowed') }
  if (response.status === 404 && !required) return false
  if (!response.ok || !response.body) fail(`Anonymous OSS readback failed (HTTP ${response.status})`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > entry.size) fail('Existing OSS object exceeds expected size; immutable bytes cannot be replaced')
    hash.update(chunk)
  }
  if (size !== entry.size || hash.digest('hex') !== entry.sha256) fail('OSS object SHA-256 or size mismatch; immutable bytes cannot be replaced')
  return true
}

function assertUnversionedBucket(ossutil) {
  const raw = cli(ossutil, ['api', 'get-bucket-versioning', '--bucket', 'tianshu-update', '--output-format', 'raw'], 'OSS bucket versioning check').toString().trim()
  const body = raw.replace(/^<\?xml[^>]*\?>\s*/, '')
  if (!/^<VersioningConfiguration(?:\s+xmlns="[^"]*")?\s*(?:\/>|>\s*(?:<Status\s*\/>|<Status>\s*<\/Status>)?\s*<\/VersioningConfiguration>)$/.test(body)) fail('OSS bucket must have versioning never enabled; forbid-overwrite is ineffective on enabled or suspended buckets')
}

async function download(work, release, name, directory) {
  const remote = release.assets.find(asset => asset.name === name)
  if (!remote) fail('GitHub release is missing a required package, signature or metadata asset')
  mkdirSync(directory, {recursive: true})
  cli('gh', ['release', 'download', release.tag_name, '--repo', REPO, '--pattern', name, '--dir', directory], 'GitHub asset acquisition')
  return join(directory, name)
}

async function authoritative(file, remote, expected) {
  if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail('Release assets must be regular files')
  const size = statSync(file).size, hash = await sha256(file)
  if (!remote || remote.size !== size || remote.digest !== `sha256:${hash}` || (expected && (expected.size !== size || expected.sha256 !== hash))) fail('Package, signature or metadata bytes differ from authoritative GitHub SHA-256/size')
}

export async function prepare(work, argv) {
  const config = options(argv)
  const explicitVersion = config.version !== undefined
  const localManifest = config.manifest ?? (explicitVersion ? undefined : 'latest.json')
  const localCatalog = config.catalog ?? (explicitVersion ? undefined : 'release-catalog.json')
  const manifestBytes = localManifest ? metadataFile(localManifest) : undefined
  const catalogBytes = localCatalog ? metadataFile(localCatalog) : undefined
  const version = config.version?.replace(/^v/, '') ?? JSON.parse(manifestBytes).version
  if (!stableVersion(version)) fail('Only numeric stable semantic release tags may be mirrored')
  const release = JSON.parse(cli('gh', ['api', `repos/${REPO}/releases/tags/v${version}`], 'GitHub release inspection'))
  if (release.tag_name !== `v${version}` || release.draft !== false || typeof release.prerelease !== 'boolean' || !Array.isArray(release.assets)) fail('GitHub release must exist, match the version tag and be published, not draft')
  if (!config.assetsOnly && release.prerelease) fail('Prerelease metadata cannot be exposed by the stable publisher; use assets-only or controlled promotion')
  const names = release.assets.map(asset => asset.name)
  if (new Set(names).size !== names.length) fail('GitHub release has ambiguous duplicate asset names')
  const remoteDirectory = join(work, 'github')
  const remoteCatalog = await download(work, release, 'release-catalog.json', remoteDirectory)
  const remoteManifest = await download(work, release, 'latest.json', remoteDirectory)
  for (const file of [remoteCatalog, remoteManifest]) {
    metadataFile(file)
    await authoritative(file, release.assets.find(asset => asset.name === basename(file)))
  }
  const pinned = catalogBytes ?? readFileSync(remoteCatalog)
  if (!pinned.equals(readFileSync(remoteCatalog))) fail('Local catalog must match GitHub catalog bytes exactly')
  const catalog = validateCatalog(JSON.parse(pinned))
  if (catalog.version !== version || catalog.artifacts.some(artifact => artifact.sources.github?.verified !== true)) fail('All catalog packages require authoritative GitHub qualification for this version')
  const manifest = validateManifest(JSON.parse(manifestBytes ?? readFileSync(remoteManifest)), catalog)
  const githubManifest = validateManifest(JSON.parse(readFileSync(remoteManifest)), catalog)
  if (canonical(manifest) !== canonical(githubManifest)) fail('Local manifest differs from the authoritative GitHub manifest')
  writeFileSync(join(work, 'release-catalog.json'), pinned)
  const mirrored = structuredClone(githubManifest)
  for (const artifact of catalog.artifacts.filter(asset => asset.purpose === 'update')) {
    const expected = OSS_ROOT + `tianshu/v${version}/${artifact.fileName}`
    if (artifact.sources.oss && sourceURL('oss', artifact.sources.oss.url) !== expected) fail('OSS backup URL differs from the immutable release key')
    mirrored.platforms[artifact.platform].url = expected
  }
  writeFileSync(join(work, 'latest-oss.json'), JSON.stringify(mirrored, null, 2) + '\n')
  metadataFile(join(work, 'latest-oss.json'))
  const previous = existsSync(config.control) ? validateControl(JSON.parse(metadataFile(config.control))) : undefined
  const confirmed = config.assetsOnly ? undefined : await policy(version, pinned, previous)
  const packages = new Map()
  for (const artifact of catalog.artifacts) {
    const known = packages.get(artifact.fileName)
    if (known && (known.size !== artifact.size || known.sha256 !== artifact.sha256 || (known.signature && artifact.signature && known.signature !== artifact.signature))) fail('Catalog purposes disagree on immutable package identity')
    packages.set(artifact.fileName, {...known, ...artifact, signature: artifact.signature ?? known?.signature})
  }
  const entries = []
  const acquire = async name => {
    const directory = join(work, 'assets'), file = join(directory, name)
    const remote = release.assets.find(asset => asset.name === name)
    if (!remote) fail('GitHub release is missing a required package or signature')
    mkdirSync(directory, {recursive: true})
    const local = config.assets ? join(resolve(config.assets), name) : undefined
    if (local && existsSync(local)) {
      if (lstatSync(local).isSymbolicLink() || !statSync(local).isFile()) fail('Local assets must be regular files, not symlinks')
      copyFileSync(local, file)
    } else await download(work, release, name, directory)
    return file
  }
  for (const [name, artifact] of packages) {
    const file = await acquire(name)
    await authoritative(file, release.assets.find(asset => asset.name === name), artifact)
    entries.push(await descriptor(file, `tianshu/v${version}/${name}`, 'asset'))
    if (artifact.signature) {
      const signature = await acquire(name + '.sig')
      if (statSync(signature).size > CONTROL_LIMIT || readFileSync(signature, 'utf8').trim() !== artifact.signature.trim()) fail('Original updater signature differs from catalog and manifest')
      await authoritative(signature, release.assets.find(asset => asset.name === name + '.sig'))
      entries.push(await descriptor(signature, `tianshu/v${version}/${name}.sig`, 'asset'))
    }
  }
  if (!config.assetsOnly) {
    entries.push(await descriptor(join(work, 'release-catalog.json'), `tianshu/v${version}/release-catalog.json`, 'metadata'))
    entries.push(await descriptor(join(work, 'latest-oss.json'), `tianshu/v${version}/latest.json`, 'metadata'))
    entries.push(await descriptor(join(work, 'release-catalog.json'), 'tianshu/release-catalog.json', 'metadata', false))
    entries.push(await descriptor(join(work, 'latest-oss.json'), 'tianshu/latest.json', 'metadata', false))
  }
  const plan = {version, assetsOnly: config.assetsOnly, policy: confirmed, catalogSha256: digest(pinned), entries}
  for (const entry of entries) {
    if (!entry.immutable && entry.key.endsWith('/latest.json')) {
      const existing = await publicMetadata(OSS_ROOT + entry.key)
      if (existing) validateManifest(JSON.parse(existing), catalog, true)
      entry.exists = Boolean(existing && digest(existing) === entry.sha256)
    } else entry.exists = await probe(entry)
  }
  if (entries.some(entry => entry.immutable && !entry.exists)) assertUnversionedBucket(process.env.OSSUTIL_BIN ?? 'ossutil')
  writeFileSync(join(work, 'plan.json'), JSON.stringify(plan))
  writeFileSync(join(work, 'assets.tsv'), entries.filter(entry => entry.kind === 'asset').map(entry => `${entry.key}\n`).join(''))
  writeFileSync(join(work, 'metadata.tsv'), entries.filter(entry => entry.kind === 'metadata' && entry.immutable).map(entry => `${entry.key}\n`).join(''))
  console.log(`Validated v${version}: ${packages.size} packages, original signatures and exact catalog bytes${config.assetsOnly ? '; immutable assets only' : '; controlled stable policy'}`)
  return plan
}

function loadPlan(work) {
  return JSON.parse(metadataFile(join(work, 'plan.json')))
}

export async function guard(work) {
  const plan = loadPlan(work)
  if (plan.assetsOnly) fail('Assets-only publication cannot write metadata')
  const bytes = metadataFile(join(work, 'release-catalog.json'))
  if (digest(bytes) !== plan.catalogSha256) fail('Prepared catalog bytes changed')
  const current = await policy(plan.version, bytes, plan.policy)
  if (canonical(current) !== canonical(plan.policy)) fail('Update control changed during publication; restart validation before metadata writes')
  const fixedCatalog = plan.entries.find(entry => entry.key === 'tianshu/release-catalog.json')
  await probe(fixedCatalog)
  return plan
}

export async function check(work, key) {
  const plan = loadPlan(work), entry = plan.entries.find(candidate => candidate.key === key)
  if (!entry) fail('Object is not in the validated publication plan')
  if (entry.kind === 'metadata') await guard(work)
  if (entry.immutable) return await probe(entry) ? 'reuse' : 'upload'
  if (key.endsWith('/release-catalog.json')) return await probe(entry) ? 'reuse' : 'upload'
  const existing = await publicMetadata(OSS_ROOT + key)
  if (existing) validateManifest(JSON.parse(existing), validateCatalog(JSON.parse(metadataFile(join(work, 'release-catalog.json')))), true)
  return existing && digest(existing) === entry.sha256 ? 'reuse' : 'upload'
}

export async function upload(work, key) {
  const plan = loadPlan(work), entry = plan.entries.find(candidate => candidate.key === key)
  if (!entry?.immutable || (plan.assetsOnly && entry.kind !== 'asset')) fail('Only immutable planned objects can be uploaded by this helper')
  if (await check(work, key) === 'reuse') return
  assertUnversionedBucket(process.env.OSSUTIL_BIN ?? 'ossutil')
  if (entry.size !== statSync(entry.file).size || entry.sha256 !== await sha256(entry.file)) fail('Prepared upload bytes changed')
  const args = ['api', 'put-object', '--bucket', 'tianshu-update', '--key', entry.key, '--body', 'file://' + entry.file, '--forbid-overwrite', 'true', '--cache-control', entry.kind === 'asset' ? 'public,max-age=31536000,immutable' : 'no-cache']
  try { cli(process.env.OSSUTIL_BIN ?? 'ossutil', args, 'Immutable OSS upload') }
  catch { await probe(entry, true); return }
  await probe(entry, true)
}

export async function verify(work, key) {
  const plan = loadPlan(work)
  const entries = key ? plan.entries.filter(entry => entry.key === key) : plan.entries
  if (!entries.length) fail('Object is not in the validated publication plan')
  for (const entry of entries) await probe(entry, true)
}

export async function main(argv = process.argv.slice(2)) {
  const [operation, work, ...rest] = argv
  if (operation === 'prepare') return prepare(resolve(work), rest)
  if (operation === 'guard') return guard(work)
  if (operation === 'check') return console.log(await check(work, rest[0]))
  if (operation === 'upload') return upload(work, rest[0])
  if (operation === 'verify') return verify(work, rest[0])
  fail('Unknown OSS publisher operation')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.publicationStage ? error.message : 'OSS publication validation or I/O failed; no external diagnostics or credentials are displayed')
    process.exitCode = 1
  })
}
