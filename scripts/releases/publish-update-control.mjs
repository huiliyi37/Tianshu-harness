import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { validateCatalog, CATALOG_URLS } from './catalog.mjs'
import { CONTROL_URLS, CONTROL_LIMIT, digest, canonical, validateControl, chooseControl, transition } from './update-control.mjs'

const REPO = 'huiliyi37/Tianshu-harness'
const catalogURL = version => `https://github.com/${REPO}/releases/download/v${version}/release-catalog.json`
export async function readRemote(url, fetcher = fetch) {
  const r = await fetcher(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' })
  if (r.status === 404) return undefined
  if (!r.ok) throw new Error(`Cannot read ${url}: HTTP ${r.status}`)
  const chunks = []; let size = 0
  for await (const chunk of r.body) { size += chunk.length; if (size > CONTROL_LIMIT) throw new Error('Metadata exceeds 256 KiB'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
export async function publishTransaction(transaction, io) {
  // A saved transaction is retried verbatim; no new revision is allocated on retry.
  const bytes = Buffer.from(canonical(transaction.next) + '\n')
  for (const source of ['github', 'oss']) {
    const found = await io.read(source)
    if (found) chooseControl([transaction.next], validateControl(JSON.parse(found)))
    if (!found || digest(found) !== digest(bytes)) await io.upload(source, bytes)
    const confirmed = await io.read(source)
    if (!confirmed || digest(confirmed) !== digest(bytes)) throw new Error(`Control readback mismatch: ${source}`)
    transaction.completed[source] = true
    await io.save(transaction)
  }
  // Recheck both after writes: publication may overlap another publisher.
  for (const source of ['github', 'oss']) if (digest(await io.read(source) ?? Buffer.alloc(0)) !== digest(bytes)) throw new Error('Control sources are not consistent')
}
function jsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')) }
async function verifyPinned(release, fetcher = fetch) {
  const bytes = await readRemote(catalogURL(release.version), fetcher)
  if (!bytes || digest(bytes) !== release.catalogSha256) throw new Error('Pinned catalog hash mismatch')
  const c = validateCatalog(JSON.parse(bytes)); if (c.version !== release.version) throw new Error('Pinned catalog version mismatch')
  if (c.artifacts.some(a => !a.sources.github?.verified)) throw new Error('GitHub artifacts must be verified')
  return { catalog: c, bytes }
}
async function releaseInfo(version) {
  // api.github.com 匿名额度按出口 IP 计，共享 IP 极易 403——有 token 就带上
  // （CI 的 GITHUB_TOKEN / 本地 gh auth token 均可）；release 资产读取仍匿名。
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'tianshu-update-control', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  if (!r.ok) throw new Error(`GitHub release metadata unavailable (HTTP ${r.status}${token ? '' : '，无 token——匿名额度按出口 IP 计，可用 GH_TOKEN 环境变量提供'}${r.status === 403 ? '；403 多为匿名限额' : ''})`)
  return r.json()
}
function saveFile(path, value) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, canonical(value) + '\n') }
export async function main(argv = process.argv.slice(2)) {
  const arg = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1] }
  const operation = argv[0], publish = argv.includes('--publish')
  if (!['init', 'stage', 'set-percentage', 'pause', 'resume', 'revoke', 'promote'].includes(operation)) throw new Error('Usage: publish-update-control.mjs <init|stage|set-percentage|pause|resume|revoke|promote> [--publish] [--catalog FILE] [--acceptance FILE] [--platforms LIST] [--percentage N]')
  const controlPath = arg('--control') ?? 'update-control.json', txPath = arg('--transaction') ?? 'release/update-control-transaction.json'
  const remote = await Promise.all(CONTROL_URLS.map(url => readRemote(url)))
  if (remote.every(b => !b) && operation !== 'init') throw new Error('Update control is unavailable on both sources')
  const controls = remote.filter(Boolean).map(b => validateControl(JSON.parse(b)))
  const local = existsSync(controlPath) ? validateControl(jsonFile(controlPath)) : undefined
  let current = controls.length ? chooseControl(controls, local) : local
  const catalogPath = arg('--catalog') ?? 'release-catalog.json', catalogBytes = readFileSync(catalogPath), catalog = validateCatalog(JSON.parse(catalogBytes))
  const evidence = arg('--acceptance') ? jsonFile(arg('--acceptance')) : undefined
  const platforms = arg('--platforms')?.split(',').filter(Boolean)
  const request = { operation, catalogSha256: digest(catalogBytes), evidence, platforms, percentage: arg('--percentage') === undefined ? 0 : Number(arg('--percentage')) }
  const oldTx = existsSync(txPath) ? jsonFile(txPath) : undefined
  const resume = oldTx && canonical(oldTx.request) === canonical(request) && (current?.revision === oldTx.previousRevision || canonical(current) === canonical(oldTx.next))
  let next
  if (resume) next = validateControl(oldTx.next)
  else if (operation === 'init') {
    if (current) throw new Error('Control is already initialized')
    next = validateControl({ schemaVersion: 1, revision: 1, stable: { version: catalog.version, catalogSha256: digest(catalogBytes) }, revokedVersions: [] })
  } else {
    if (!current) throw new Error('Initialize the stable control first')
    if (operation !== 'stage' && current.candidate && (catalog.version !== current.candidate.version || digest(catalogBytes) !== current.candidate.catalogSha256)) throw new Error('Candidate catalog bytes changed')
    next = transition(current, operation, { catalog, catalogSha256: digest(catalogBytes), evidence, platforms, percentage: request.percentage })
  }
  await verifyPinned(next.stable)
  if (next.candidate) await verifyPinned(next.candidate)
  const info = await releaseInfo(catalog.version)
  if (info.draft || (operation !== 'init' && !resume && !info.prerelease)) throw new Error('Candidate must be a published prerelease')
  if (operation === 'init' && info.prerelease) throw new Error('Initial stable release cannot be a prerelease')
  if (operation === 'promote') {
    if (!argv.includes('--release-notes-reviewed')) throw new Error('Promotion requires reviewed release notes')
    if (digest(readFileSync('release-catalog.json')) !== digest(catalogBytes) || jsonFile('latest.json').version !== catalog.version) throw new Error('Promotion requires matching root catalog and latest manifest')
  }
  const before = await Promise.all([...CATALOG_URLS, `https://github.com/${REPO}/releases/latest/download/latest.json`, 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'].map(url => readRemote(url)))
  if (operation !== 'init' && operation !== 'promote' && before.some(b => !b)) throw new Error('Legacy stable entries must be reachable before rollout changes')
  if (operation !== 'init' && operation !== 'promote' && before.filter(Boolean).some(b => JSON.parse(b).version !== current.stable.version)) throw new Error('Legacy or website entry does not match the stable release')
  const transaction = resume ? oldTx : { request, previousRevision: current?.revision ?? 0, next, completed: {}, stableEntryHashes: before.map(b => b ? digest(b) : null) }
  console.log(JSON.stringify({ mode: publish ? 'publish' : 'dry-run', operation, previous: current, next, affectedPlatforms: platforms ?? Object.keys(next.candidate?.platforms ?? {}) }, null, 2))
  if (!publish) return
  const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  saveFile(txPath, transaction)
  // A fixed prerelease tag keeps control metadata outside releases/latest.
  try { run('gh', ['release', 'view', 'update-control', '--repo', REPO]) }
  catch { run('gh', ['release', 'create', 'update-control', '--prerelease', '--title', 'Update control', '--repo', REPO]) }
  const controlRelease = JSON.parse(run('gh', ['release', 'view', 'update-control', '--repo', REPO, '--json', 'isPrerelease,isDraft']).toString())
  if (!controlRelease.isPrerelease || controlRelease.isDraft) throw new Error('Control release must remain a published prerelease')
  // Fixed filename is required by both endpoints.
  const uploadPath = resolve(dirname(txPath), 'update-control.json')
  writeFileSync(uploadPath, canonical(next) + '\n')
  const pinnedPath=resolve(dirname(txPath),'release-catalog.json')
  writeFileSync(pinnedPath,catalogBytes)
  const pinnedOSS=`https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/v${catalog.version}/release-catalog.json`
  const pinnedExisting=await readRemote(pinnedOSS)
  if (pinnedExisting && digest(pinnedExisting)!==digest(catalogBytes)) throw new Error('Pinned OSS catalog cannot be replaced')
  if (!pinnedExisting) run(process.env.OSSUTIL_BIN ?? 'ossutil',['cp',pinnedPath,`oss://tianshu-update/tianshu/v${catalog.version}/release-catalog.json`,'--meta','Cache-Control:no-cache','-f'])
  if (digest(await readRemote(pinnedOSS) ?? Buffer.alloc(0))!==digest(catalogBytes)) throw new Error('Pinned OSS catalog readback mismatch')
  await publishTransaction(transaction, {
    read: source => readRemote(CONTROL_URLS[source === 'github' ? 1 : 0]),
    upload: async source => {
      if (source === 'github') run('gh', ['release', 'upload', 'update-control', uploadPath, '--clobber', '--repo', REPO])
      else run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', uploadPath, 'oss://tianshu-update/tianshu/update-control.json', '--meta', 'Cache-Control:no-cache', '-f'])
    }, save: async tx => saveFile(txPath, tx),
  })
  if (operation === 'promote' && !transaction.completed.promotion) {
    run('gh', ['release', 'edit', `v${catalog.version}`, '--prerelease=false', '--latest=true', '--repo', REPO])
    const website = arg('--website')
    run(process.execPath, ['scripts/releases/publish-routing.mjs', '--publish', '--release-notes-reviewed', ...(website ? ['--website', website] : [])])
    run(process.env.OSSUTIL_BIN ?? 'ossutil', ['cp', 'latest.json', 'oss://tianshu-update/tianshu/latest.json', '--meta', 'Cache-Control:no-cache', '-f'])
    const entries = await Promise.all([...CATALOG_URLS, `https://github.com/${REPO}/releases/latest/download/latest.json`, 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'].map(url => readRemote(url)))
    if (entries.some(b => !b || JSON.parse(b).version !== catalog.version)) throw new Error('Promotion entries have not converged')
    transaction.completed.promotion = true; saveFile(txPath, transaction)
  } else if (operation !== 'promote') {
    const after = await Promise.all([...CATALOG_URLS, `https://github.com/${REPO}/releases/latest/download/latest.json`, 'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/latest.json'].map(url => readRemote(url)))
    if (after.some((b, i) => (b ? digest(b) : null) !== transaction.stableEntryHashes[i])) throw new Error('Stable entry changed during candidate publication')
  }
  saveFile(controlPath, next)
  console.log(`Confirmed control revision ${next.revision} on both sources`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
